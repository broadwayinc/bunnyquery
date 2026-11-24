/**
 * The reconciler's clock and the cross-tab settle lock (reconciler plan, sections 3 and 4b,
 * BUNNYQUERY_CHAT_RECONCILER_PLAN.md).
 *
 * WHAT LIVES HERE. Only the parts that know nothing about chats: one timer chain per page
 * (LookScheduler), the triggers that pull its next look forward, the deadline and the
 * generation that make a hung look harmless, the backoff after a failed look, and the lock
 * that keeps side effects (a next indexing pass, run::/done:: writes, a finalize, a records
 * refresh) to one tab. What a look actually reads and applies is ChatSession's
 * (_reconcileLook in session.ts), handed in as a hook, so this file is testable on its own
 * and the session keeps its own state private.
 *
 * THE RULES IT ENFORCES (owner, 2026-11-24, plan 4b):
 *   1. One loop. One setTimeout handle for the whole page, whatever the number of waiting
 *      requests. Scheduling always clears the previous handle first.
 *   2. Returns never add work. A trigger while a look runs sets ONE follow-up look (the
 *      triggers are merged), never a second loop or a second timer. A trigger while no look
 *      runs starts the look now.
 *   3. A look that does not finish within LOOK_DEADLINE_MS is over: it counts as failed
 *      (nothing on screen changes), its in-flight reads are aborted, and anything its
 *      generation returns later is ignored by the session (alive() is false).
 */

/** How long one look may take in all. */
export const LOOK_DEADLINE_MS = 15 * 1000;
/** The visible cadence while anything is waiting. */
export const LOOK_FAST_MS = 3 * 1000;
/** The visible cadence while request status frames arrive (statusPush), and the hidden
 *  cadence while a client-driven indexing chain is open. */
export const LOOK_SLOW_MS = 60 * 1000;
/** Re-read every open item at least this often, whatever the queue counters say. */
export const LOOK_STALE_MS = 60 * 1000;
/** A timer that fires this much later than asked, in a visible tab, means the computer slept. */
const WAKE_GAP_MS = 30 * 1000;
/** Backoff after a failed look: 1, 2, 4 ... capped here. */
const BACKOFF_MAX_MS = 30 * 1000;

/** Why a look runs. Several merge into one look. */
export type LookTrigger =
	| 'tick' | 'return' | 'visible' | 'wake' | 'online' | 'pageshow' | 'reconnect' | 'view'
	| 'frame' | 'unknown' | 'promote' | 'send' | 'signin' | 'add';

/** The triggers that mean "the user may have been away": live readers are stopped and
 *  restarted, the discovery listing and the first page are read. */
var RETURN_TRIGGERS: { [k: string]: true } = {
	return: true, visible: true, wake: true, online: true, pageshow: true, reconnect: true, view: true, unknown: true, signin: true,
};

export function isReturnTrigger(t: string): boolean {
	return !!RETURN_TRIGGERS[t];
}

/** One look as the session sees it. */
export type LookRequest = {
	/** Generation: grows by one per look. */
	gen: number;
	triggers: { [k: string]: true };
	/** Any trigger was a return (see RETURN_TRIGGERS). */
	isReturn: boolean;
	/** Aborts every read of this look at its deadline (undefined without AbortController). */
	signal: any;
	/** False once the deadline passed or a newer look started: drop every result. */
	alive: () => boolean;
	/** Milliseconds left before the deadline (at least 1). */
	remaining: () => number;
};

/** How a look ended: 'ok' (it read what it needed), 'transient' (a read failed on the way:
 *  backoff, nothing changed), 'auth' (the sign-in is gone), 'idle' (nothing to do). */
export type LookOutcome = 'ok' | 'transient' | 'auth' | 'idle';

export interface LookHooks {
	/** Run one look. Never called twice at once. */
	runLook(req: LookRequest): Promise<LookOutcome>;
	/** Is there anything to follow: `visible` = anything at all (the 3 s cadence), `hidden`
	 *  = something worth a look once a minute while the tab is hidden. */
	work(): { visible: boolean; hidden: boolean };
	/** Status frames are arriving (statusPush): the visible cadence slows to a minute. */
	pushLive(): boolean;
	/** The reconnecting / sign-in flags changed (for the views). */
	onFlags(flags: { reconnecting: boolean; signInNeeded: boolean }): void;
}

var _g: any = typeof globalThis !== 'undefined' ? globalThis : {};

function perfNow(): number {
	return (_g.performance && typeof _g.performance.now === 'function') ? _g.performance.now() : Date.now();
}

function tabHidden(): boolean {
	var doc: any = _g.document;
	return !!doc && doc.visibilityState === 'hidden';
}

/**
 * The one timer chain. See the file note for the rules.
 */
export class LookScheduler {
	private hooks: LookHooks;
	private timer: any = null;
	/** When the pending timer should fire, on both clocks (wake detection). */
	private expectPerf = 0;
	private expectWall = 0;
	private running = false;
	/** Triggers that arrived while a look ran: exactly one more look runs with them. */
	private pending: { [k: string]: true } | null = null;
	/** Resolvers of trigger() promises, by the look that will serve them. */
	private waitCurrent: Array<() => void> = [];
	private waitNext: Array<() => void> = [];
	private backoff = 0;
	private listening = false;
	private stopped = false;
	gen = 0;
	reconnecting = false;
	signInNeeded = false;
	/** Diagnostics (and the throwaway checks): looks started, timers armed. */
	looks = 0;
	timersArmed = 0;

	constructor(hooks: LookHooks) {
		this.hooks = hooks;
	}

	/** Pull the next look forward to now. Resolves when the look that serves it ends. */
	trigger(kind: LookTrigger): Promise<void> {
		var self = this;
		this.stopped = false;
		this._listen();
		return new Promise<void>(function (resolve) {
			if (self.running) {
				if (!self.pending) self.pending = {};
				self.pending[kind] = true;
				self.waitNext.push(resolve);
				return;
			}
			// Started on the next turn of the event loop, so the triggers one event fires
			// at once (the tab shown: this listener, the host's own handler, a socket that
			// reconnects with it) are one look, not a look and a follow-up.
			if (!self.starting) {
				self.starting = {};
				setTimeout(function () {
					var t = self.starting || {};
					self.starting = null;
					if (self.running) {
						// Something started a look meanwhile: these ride on its follow-up.
						if (!self.pending) self.pending = {};
						for (var k in t) self.pending[k] = true;
						self.waitNext = self.waitNext.concat(self.waitStarting);
						self.waitStarting = [];
						return;
					}
					self.waitCurrent = self.waitCurrent.concat(self.waitStarting);
					self.waitStarting = [];
					self._start(t);
				}, 0);
			}
			self.starting[kind] = true;
			self.waitStarting.push(resolve);
		});
	}

	/** Triggers gathered for a look about to start (see trigger). */
	private starting: { [k: string]: true } | null = null;
	private waitStarting: Array<() => void> = [];

	/** Make sure the chain runs at its cadence when there is work. Never adds a timer when
	 *  one is armed or a look is running, so calling it from every add is free. */
	ensure(): void {
		this.stopped = false;
		this._listen();
		if (this.running || this.timer || this.starting) return;
		this._scheduleNext('ok');
	}

	/** The sign-in came back (or the host says so): looks resume at once. */
	signedIn(): void {
		if (!this.signInNeeded) { this.ensure(); return; }
		this.signInNeeded = false;
		this.backoff = 0;
		this._flags();
		void this.trigger('signin');
	}

	/** Stop the chain (tests, teardown). A later trigger or ensure starts it again. */
	stop(): void {
		this.stopped = true;
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
	}

	isRunning(): boolean {
		return this.running;
	}

	private _flags(): void {
		try { this.hooks.onFlags({ reconnecting: this.reconnecting, signInNeeded: this.signInNeeded }); } catch (e) { /* view hook */ }
	}

	private _listen(): void {
		if (this.listening) return;
		this.listening = true;
		var self = this;
		var doc: any = _g.document;
		if (doc && typeof doc.addEventListener === 'function') {
			doc.addEventListener('visibilitychange', function () {
				if (doc.visibilityState === 'hidden') {
					// Re-arm at the hidden cadence (or not at all): a 3 s timer in a hidden
					// tab only gets throttled and then reads as a wake.
					if (!self.running && self.timer) { clearTimeout(self.timer); self.timer = null; self._scheduleNext('ok'); }
					return;
				}
				void self.trigger('visible');
			});
		}
		var win: any = _g.window;
		if (win && typeof win.addEventListener === 'function') {
			win.addEventListener('online', function () { if (!tabHidden()) void self.trigger('online'); });
			win.addEventListener('pageshow', function (ev: any) { if (ev && ev.persisted) void self.trigger('pageshow'); });
		}
	}

	private _start(triggers: { [k: string]: true }): void {
		var self = this;
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
		this.running = true;
		var gen = ++this.gen;
		this.looks++;
		var isReturn = false;
		for (var k in triggers) if (RETURN_TRIGGERS[k]) isReturn = true;
		var ac: any = typeof _g.AbortController === 'function' ? new _g.AbortController() : null;
		var startedAt = perfNow();
		var done = false;
		var deadline = setTimeout(function () {
			if (done) return;
			done = true;
			try { if (ac) ac.abort(); } catch (e) { /* best effort */ }
			console.warn('[chat-engine] a reconciler look ran past its deadline; nothing it read is applied');
			self._finish('transient');
		}, LOOK_DEADLINE_MS);
		var req: LookRequest = {
			gen: gen,
			triggers: triggers,
			isReturn: isReturn,
			signal: ac ? ac.signal : undefined,
			alive: function () { return !done && self.gen === gen; },
			remaining: function () { return Math.max(1, Math.round(LOOK_DEADLINE_MS - (perfNow() - startedAt))); },
		};
		var run: Promise<LookOutcome>;
		try { run = Promise.resolve(this.hooks.runLook(req)); } catch (e) { run = Promise.reject(e); }
		run.then(function (outcome) {
			if (done) return;
			done = true;
			clearTimeout(deadline);
			self._finish(outcome || 'ok');
		}, function (err) {
			if (done) return;
			done = true;
			clearTimeout(deadline);
			console.warn('[chat-engine] a reconciler look threw', err);
			self._finish('transient');
		});
	}

	private _finish(outcome: LookOutcome): void {
		this.running = false;
		var served = this.waitCurrent;
		this.waitCurrent = [];
		if (outcome === 'transient') {
			this.backoff = this.backoff ? Math.min(BACKOFF_MAX_MS, this.backoff * 2) : 1000;
			if (!this.reconnecting) { this.reconnecting = true; this._flags(); }
		} else if (outcome === 'auth') {
			this.backoff = 0;
			var changed = !this.signInNeeded || this.reconnecting;
			this.signInNeeded = true;
			this.reconnecting = false;
			if (changed) this._flags();
		} else {
			this.backoff = 0;
			if (this.reconnecting || this.signInNeeded) {
				this.reconnecting = false;
				this.signInNeeded = false;
				this._flags();
			}
		}
		for (var i = 0; i < served.length; i++) { try { served[i](); } catch (e) { /* caller */ } }
		if (this.pending) {
			// Exactly one more look, carrying every trigger that came in meanwhile.
			var next = this.pending;
			this.pending = null;
			this.waitCurrent = this.waitNext;
			this.waitNext = [];
			this._start(next);
			return;
		}
		this._scheduleNext(outcome);
	}

	private scheduling = false;

	private _scheduleNext(outcome: LookOutcome): void {
		// work() may add items, and adding an item calls ensure(): never re-enter.
		if (this.stopped || this.scheduling) return;
		this.scheduling = true;
		try { this._arm(outcome); } finally { this.scheduling = false; }
	}

	private _arm(outcome: LookOutcome): void {
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
		var hidden = tabHidden();
		// A hook that throws must not end the chain (nothing would arm a timer again):
		// taken as "something to follow", at the visible cadence.
		var work: { visible: boolean; hidden: boolean };
		try { work = this.hooks.work(); } catch (e) { work = { visible: true, hidden: false }; }
		var delay = -1;
		if (this.signInNeeded) {
			// Nothing can be read until the sign-in is back. One cheap try a minute while
			// someone is looking, and at once on any trigger or signedIn().
			if (!hidden && work.visible) delay = LOOK_SLOW_MS;
		} else if (outcome === 'transient' && this.backoff) {
			if ((!hidden && work.visible) || work.hidden) delay = hidden ? Math.max(this.backoff, LOOK_SLOW_MS) : this.backoff;
		} else if (!hidden && work.visible) {
			var live = false;
			try { live = this.hooks.pushLive(); } catch (e) { live = false; }
			delay = live ? LOOK_SLOW_MS : LOOK_FAST_MS;
		} else if (hidden && work.hidden) {
			delay = LOOK_SLOW_MS;
		}
		if (delay < 0) return;
		var self = this;
		this.expectPerf = perfNow() + delay;
		this.expectWall = Date.now() + delay;
		this.timersArmed++;
		this.timer = setTimeout(function () {
			self.timer = null;
			var t: { [k: string]: true } = { tick: true };
			// A visible tab whose timer fired far too late (or whose wall clock went back)
			// slept: that is a return, not a tick.
			var lateWall = Date.now() - self.expectWall;
			var latePerf = perfNow() - self.expectPerf;
			if (!tabHidden() && (lateWall > WAKE_GAP_MS || latePerf > WAKE_GAP_MS || Date.now() < self.expectWall - delay)) t.wake = true;
			self._start(t);
		}, delay);
	}
}

/* ---- the settle lock ------------------------------------------------------------------
 *
 * A side effect that sends or writes (the next pass of a client-driven file, a run:: or
 * done:: record, a csr-finalize, a records refresh) runs in ONE tab. Every tab of the app
 * may see the same item settle (the chat in one, the files page in another), and each used
 * to do the side effect itself: two next passes for one file, two finalizes racing.
 *
 * How: navigator.locks.request('bq-settle:<project>:<queue>', { ifAvailable: true }) is
 * held for the length of the side effect, and inside it a registry shared by the tabs
 * (localStorage) says whether this side effect (by its key) already ran anywhere. A tab
 * that does not get the lock tries again shortly, so nothing is dropped; the registry makes
 * the retry a no-op once another tab did it. Without navigator.locks the side effect just
 * runs (the registry still dedupes it). Without localStorage the in-memory set dedupes
 * within the tab.
 */

var FX_PREFIX = 'bq-fx:';
/** In-flight marks: a side effect some tab is running right now (see runSettleSideEffect). */
var FXI_PREFIX = 'bq-fxi:';
/** The longest one side effect holds the settle lock. */
var LOCK_HOLD_MAX_MS = 20 * 1000;
var FX_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an in-flight mark holds other tabs off. A tab that ran a side effect and died
 *  (closed, frozen) leaves its mark behind; after this the others may run it. */
var FX_INFLIGHT_MS = 60 * 1000;
/** Tries per side effect in this tab: the first run and up to four retries after a
 *  failure, with backoff (FX_RETRY_BASE_MS, doubling). */
var FX_MAX_TRIES = 5;
var FX_RETRY_BASE_MS = 2000;
var _fxDone: { [key: string]: number } = {};
var _fxBusy: { [key: string]: number } = {};
var _fxPrunedAt = 0;

function storage(): any {
	try {
		var ls = _g.localStorage;
		return ls && typeof ls.getItem === 'function' ? ls : null;
	} catch (e) {
		return null;
	}
}

function fxIsDone(key: string): boolean {
	if (_fxDone[key]) return true;
	var ls = storage();
	if (!ls) return false;
	try {
		var v = Number(ls.getItem(FX_PREFIX + key));
		return isFinite(v) && v > 0 && Date.now() - v < FX_TTL_MS;
	} catch (e) {
		return false;
	}
}

/** When this side effect was marked in flight (this tab or another), if that mark is
 *  still young; else 0. */
function fxBusyAt(key: string): number {
	var now = Date.now();
	var t = _fxBusy[key] || 0;
	if (t && now - t < FX_INFLIGHT_MS) return t;
	var ls = storage();
	if (!ls) return 0;
	try {
		var v = Number(ls.getItem(FXI_PREFIX + key));
		return isFinite(v) && v > 0 && now - v < FX_INFLIGHT_MS ? v : 0;
	} catch (e) {
		return 0;
	}
}

function fxMarkBusy(key: string): void {
	var now = Date.now();
	_fxBusy[key] = now;
	var ls = storage();
	if (!ls) return;
	try { ls.setItem(FXI_PREFIX + key, String(now)); } catch (e) { /* the in-memory mark still holds this tab */ }
}

function fxClearBusy(key: string): void {
	delete _fxBusy[key];
	var ls = storage();
	if (!ls) return;
	try { ls.removeItem(FXI_PREFIX + key); } catch (e) { /* expires on its own */ }
}

/** Once an hour: drop registry entries past their life, in memory and in localStorage. */
function fxPrune(now: number): void {
	if (now - _fxPrunedAt <= 60 * 60 * 1000) return;
	_fxPrunedAt = now;
	var k: string;
	for (k in _fxDone) if (now - _fxDone[k] > FX_TTL_MS) delete _fxDone[k];
	for (k in _fxBusy) if (now - _fxBusy[k] > FX_INFLIGHT_MS) delete _fxBusy[k];
	var ls = storage();
	if (!ls) return;
	try {
		var drop: string[] = [];
		for (var i = 0; i < ls.length; i++) {
			var lk = ls.key(i);
			if (!lk) continue;
			var life = lk.indexOf(FX_PREFIX) === 0 ? FX_TTL_MS : (lk.indexOf(FXI_PREFIX) === 0 ? FX_INFLIGHT_MS : 0);
			if (!life) continue;
			var t = Number(ls.getItem(lk));
			if (!isFinite(t) || now - t > life) drop.push(lk);
		}
		for (var d = 0; d < drop.length; d++) ls.removeItem(drop[d]);
	} catch (e) { /* privacy mode */ }
}

function fxMarkDone(key: string): void {
	var now = Date.now();
	_fxDone[key] = now;
	delete _fxBusy[key];
	var ls = storage();
	if (ls) {
		try {
			ls.setItem(FX_PREFIX + key, String(now));
			ls.removeItem(FXI_PREFIX + key);
		} catch (e) { /* quota, privacy mode: the in-memory set still dedupes this tab */ }
	}
	fxPrune(now);
}

/** Has this side effect run in any tab (within a day)? */
export function sideEffectDone(key: string): boolean {
	return fxIsDone(key);
}

/** Take a side effect for this call: false when it already ran (or is running) in some
 *  tab, else it is marked done and the caller does it, and handles its own failure. For a
 *  step inside one that already holds the lock (the next pass of a file, inside the settle
 *  of the pass before it). */
export function claimSideEffect(key: string): boolean {
	if (!key || fxIsDone(key) || fxBusyAt(key)) return false;
	fxMarkDone(key);
	return true;
}

/** Side effects running right now in this tab: one started inside another already holds
 *  the lock (navigator.locks is not re-entrant), so it runs at once. */
var _fxDepth = 0;

/**
 * Run `fn` once across the tabs, under the settle lock of (project, queue). `key` names
 * the side effect (e.g. "resume:<request id>"). Never throws; `fn` may be async.
 *
 * Done only when it worked: the side effect is marked in flight (FX_INFLIGHT_MS, so the
 * other tabs leave it alone) while `fn` runs, and done when `fn` returns, or when the
 * promise it returns resolves. A throw or a rejected promise clears the mark and `fn` runs
 * again after a backoff, up to FX_MAX_TRIES times in this tab; a later call with the same
 * key (the next look, another tab) can still run it after that. A tab that finds it in
 * flight elsewhere looks again once that mark would have expired, so a tab that died
 * mid-write does not leave it undone.
 */
export function runSettleSideEffect(projectId: string, queue: string, key: string, fn: () => any, attempt?: number, tries?: number): void {
	if (!key || fxIsDone(key)) return;
	var tryNo = tries || 0;
	var again = function (delay: number, nextTry: number) {
		setTimeout(function () { runSettleSideEffect(projectId, queue, key, fn, 0, nextTry); }, delay);
	};
	var run = function (): any {
		if (fxIsDone(key)) return;
		var busy = fxBusyAt(key);
		if (busy) {
			// In flight: in this tab (that run settles it) or in another one. Another tab's
			// mark is looked at again once it would have expired, bounded like the retries.
			if (!_fxBusy[key] && tryNo < FX_MAX_TRIES) again(Math.max(1000, FX_INFLIGHT_MS - (Date.now() - busy) + 1000), tryNo + 1);
			return;
		}
		fxMarkBusy(key);
		var failed = function (e: any) {
			fxClearBusy(key);
			if (tryNo + 1 < FX_MAX_TRIES) {
				console.warn('[chat-engine] a settle side effect failed; trying again', key, e);
				again(FX_RETRY_BASE_MS * Math.pow(2, tryNo), tryNo + 1);
			} else {
				console.warn('[chat-engine] a settle side effect failed ' + FX_MAX_TRIES + ' times; left for a later settle', key, e);
			}
		};
		var out: any;
		_fxDepth++;
		try {
			out = fn();
		} catch (e) {
			_fxDepth--;
			failed(e);
			return;
		}
		_fxDepth--;
		return Promise.resolve(out).then(function () { fxMarkDone(key); }, failed);
	};
	if (_fxDepth > 0 || !locks()) { run(); return; }
	var lk: any = locks();
	var name = 'bq-settle:' + (projectId || '') + ':' + (queue || '');
	var n = attempt || 0;
	var p: any;
	try {
		p = lk.request(name, { ifAvailable: true }, function (lock: any) {
			if (!lock) return false;
			// Held for the side effect, but never for long: a write that hangs (a network
			// that died mid-request) must not keep every other tab's side effects of this
			// project and queue waiting behind it. The in-flight mark keeps them off this
			// one meanwhile.
			return new Promise(function (resolve) {
				var t = setTimeout(function () { resolve(true); }, LOCK_HOLD_MAX_MS);
				Promise.resolve(run()).then(function () { clearTimeout(t); resolve(true); }, function () { clearTimeout(t); resolve(true); });
			});
		});
	} catch (e) {
		run();
		return;
	}
	Promise.resolve(p).then(function (got: any) {
		if (got !== false) return;
		// Another tab holds the lock right now (it is doing a side effect of its own, maybe
		// this very one). Ask again shortly; the registry makes that a no-op if it was.
		// Busy for this long means a tab that holds it and does not let go (frozen, its
		// page suspended): run it here after all. The registry still makes it a no-op when
		// the holder did this very side effect; dropping it would leave a run:: record
		// 'working' or a file's next pass unsent for good.
		if (n >= 30) { run(); return; }
		setTimeout(function () { runSettleSideEffect(projectId, queue, key, fn, n + 1, tryNo); }, Math.min(5000, 250 * Math.pow(2, n)));
	}, function () { run(); });
}

function locks(): any {
	var l: any = _g.navigator && _g.navigator.locks;
	return l && typeof l.request === 'function' ? l : null;
}

/** A client reference for one send: 1 to 64 letters, digits, "_" or "-". */
export function newClientRef(): string {
	var rnd = '';
	var c: any = _g.crypto;
	if (c && typeof c.getRandomValues === 'function') {
		var a = new Uint32Array(2);
		c.getRandomValues(a);
		rnd = a[0].toString(36) + a[1].toString(36);
	} else {
		rnd = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
	}
	return ('c' + Date.now().toString(36) + '_' + rnd).slice(0, 64);
}

/** A queue name from either shape it arrives in: "<queue>" or "<service>:<queue>|<seq>". */
export function queueNameOf(q?: string): string {
	if (typeof q !== 'string' || !q) return '';
	var head = q.split('|')[0];
	var i = head.lastIndexOf(':');
	return i === -1 ? head : head.slice(i + 1);
}
