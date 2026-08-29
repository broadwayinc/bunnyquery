/**
 * History mapping (pure). Moved verbatim from the chatbox. The clear-horizon
 * timestamp and the "Indexing: …" display label are INJECTED (clearedAt param,
 * formatIndexingLabel callback) so the engine touches neither localStorage nor
 * view-specific display formatting. projectId is passed for link sanitization.
 */
import { extractClaudeText, extractOpenAIText, INDEXING_COMPLETE_MARKER, EMPTY_INDEXING_REPLY, getChatHistory, bgIndexingQueueName } from './requests';
import { isErrorResponseBody, getErrorMessage } from './errors';
import { sanitizeAttachmentLinksForHistory } from './links';
import type { ChatMessage } from './host';

export function filterListByClearHorizon(list: any[], clearedAt: number): any[] {
	if (!clearedAt) return list;
	return list.filter(function (item) {
		var updated = Number(item && item.updated);
		return isFinite(updated) && updated > clearedAt;
	});
}

export function normalizeTextContent(content: any): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map(function (part: any) {
			if (typeof part === 'string') return part;
			if (part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text')) return part.text || '';
			return '';
		}).join('\n').trim();
	}
	return '';
}

export function extractLastUserTextFromRequest(requestBody: any): string {
	var arr = requestBody && Array.isArray(requestBody.messages) ? requestBody.messages
		: (requestBody && Array.isArray(requestBody.input) ? requestBody.input : []);
	for (var i = arr.length - 1; i >= 0; i--) {
		if (arr[i] && arr[i].role === 'user') {
			var t = normalizeTextContent(arr[i].content);
			if (t) return t;
		}
	}
	return '';
}

/** The two openings an indexing prompt can have. A bg-queue item that starts with
 *  neither is an ordinary chat that happened to be routed onto that queue. */
export function isIndexingRequestText(userText: any): boolean {
	if (typeof userText !== 'string') return false;
	return userText.indexOf('A new file has just been uploaded') === 0 || userText.indexOf('CONTINUE indexing') === 0;
}

export type IndexingRequestRef = {
	name: string;
	path?: string;
	mime?: string;
	size?: number;
	/** A CONTINUE pass rather than the run's first. */
	continued: boolean;
};

/**
 * The file an indexing prompt is about, read back out of the prompt itself.
 *
 * The prompt is the only description of the pass that survives on the server, so
 * this is how BOTH a history rebuild and a worker-minted pass the client never
 * dispatched (ChatSession._adoptWorkerIndexingPasses) recover the file. Shared so
 * the two produce the same `_indexFile`, which is what makes them group together.
 */
export function parseIndexingRequestText(userText: any): IndexingRequestRef | null {
	if (typeof userText !== 'string' || !userText) return null;
	var nameMatch = userText.match(/^- name: (.+)$/m);
	if (!nameMatch) return null;
	var mimeMatch = userText.match(/^- mime type: (.+)$/m);
	var sizeMatch = userText.match(/^- size \(bytes\): (\d+)$/m);
	var pathMatch = userText.match(/^- storage path: (.+)$/m);
	return {
		name: nameMatch[1].trim(),
		path: pathMatch ? pathMatch[1].trim() : undefined,
		mime: mimeMatch ? mimeMatch[1].trim() : undefined,
		size: sizeMatch ? Number(sizeMatch[1]) : undefined,
		continued: userText.indexOf('CONTINUE indexing') === 0,
	};
}

// One page of the status probe below. Matches ChatSession's own
// WORKER_PASS_ADOPT_LIMIT: the queue holds one live pass per file (plus a
// handful pending), so a FULL page means the answer may be incomplete and the
// probe reports checked=false rather than letting a miss read as "finished".
const LIVE_INDEX_PROBE_LIMIT = 20;

// ─── Shared bg-queue probe (write-through memo) ──────────────────────────────
// The SAME two queries — getChatHistory({queue, status: 'pending'|'running'})
// — are fired by four independent callers: the session's live-index snapshot,
// its worker-pass adoption ladder, its drain wait, and fetchLiveIndexingKeys
// (the db-files page's badge probe). Navigating chat → files re-asked the queue
// the chat had answered seconds earlier.
//
// This memo dedupes them WITHOUT weakening anyone's evidence:
//   • progress loops (adopt ladder, drain wait) call with maxAgeMs 0 — they
//     always fetch fresh, because their whole point is to observe a CHANGE —
//     but their answers write through into the memo;
//   • snapshot readers pass a maxAge and reuse a young answer.
// Every entry carries `at`, the time the underlying fetch actually ran. A
// caller that needs two INDEPENDENT looks (dbfile's green-confirm ladder) must
// compare `at`, never its own receipt time: a memo re-serve has the same `at`
// and therefore counts as the single look it really is.
export const BG_PROBE_TTL_MS = 4000;
type BgProbeEntry = { result: any; at: number };
const bgProbeCache: { [key: string]: BgProbeEntry } = {};
const bgProbeInflight: { [key: string]: Promise<BgProbeEntry> } = {};

export function probeBgQueue(
	params: {
		service: string;
		owner: string;
		platform: 'claude' | 'openai';
		queue: string;
		status: 'pending' | 'running';
		limit: number;
	},
	opts?: { maxAgeMs?: number },
): Promise<BgProbeEntry> {
	const key = [params.service, params.owner, params.platform, params.queue, params.status, params.limit].join('|');
	const maxAge = opts && typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : 0;
	const cached = bgProbeCache[key];
	if (maxAge > 0 && cached && Date.now() - cached.at < maxAge) {
		return Promise.resolve(cached);
	}
	const inflight = bgProbeInflight[key];
	if (inflight) return inflight;
	const p = Promise.resolve(getChatHistory(
		{ service: params.service, owner: params.owner, platform: params.platform, queue: params.queue, status: params.status },
		{ limit: params.limit, fetchMore: false },
	)).then(function (result: any) {
		const entry: BgProbeEntry = { result: result, at: Date.now() };
		bgProbeCache[key] = entry;
		return entry;
	});
	bgProbeInflight[key] = p;
	// Clear the in-flight slot on either outcome; failures are NOT cached.
	p.then(function () { delete bgProbeInflight[key]; }, function () { delete bgProbeInflight[key]; });
	return p;
}

/**
 * One bounded look at the background-indexing queue: which files still have a
 * pass pending or running? This is the same negative signal ChatSession's
 * display layer relies on - for a worker-driven (auto_continue) run, only the
 * queue can say the run is over, because the worker enqueues continuation
 * passes the client never dispatched.
 *
 * Returns every storage path AND file name found on live passes (both, because
 * older prompts may lack the storage-path line), plus `checked`: false when a
 * page came back full, in which case absence from `keys` proves nothing and
 * the caller must keep whatever state it already had.
 *
 * SCOPE: the probed queue is "<userId>-bg" - THIS user's dispatches only. A
 * chain launched by another collaborator or a widget end-user lives on their
 * queue and is invisible here, so "idle" must never be read as "nobody is
 * indexing this file", only as "this user's runs are over". The durable done::
 * marker (indexDoneUniqueId) is the cross-user signal.
 */
export async function fetchLiveIndexingKeys(params: {
	service: string;
	owner: string;
	platform: 'claude' | 'openai';
	/** Same value the dispatch used - see bgIndexingQueueName. */
	userId?: string;
}): Promise<{ keys: Set<string>; checked: boolean; at: number }> {
	const queue = bgIndexingQueueName(params.userId, params.service);
	const base = { service: params.service, owner: params.owner, platform: params.platform, queue };
	const [pending, running] = await Promise.all([
		probeBgQueue({ ...base, status: 'pending', limit: LIVE_INDEX_PROBE_LIMIT }, { maxAgeMs: BG_PROBE_TTL_MS }),
		probeBgQueue({ ...base, status: 'running', limit: LIVE_INDEX_PROBE_LIMIT }, { maxAgeMs: BG_PROBE_TTL_MS }),
	]);
	const keys = new Set<string>();
	let truncated = false;
	for (const entry of [pending, running]) {
		const res = entry.result;
		const list: any[] = (res && Array.isArray((res as any).list)) ? (res as any).list : [];
		if (list.length >= LIVE_INDEX_PROBE_LIMIT) truncated = true;
		for (const item of list) {
			const text = extractLastUserTextFromRequest(item && item.request_body);
			if (!text || !isIndexingRequestText(text)) continue;
			const ref = parseIndexingRequestText(text);
			if (!ref) continue;
			if (ref.path) keys.add(ref.path);
			if (ref.name) keys.add(ref.name);
		}
	}
	// `at` = when the OLDER of the two underlying fetches ran. Consumers that
	// need two independent looks (dbfile's green ladder) key on this, so a
	// memo re-serve is correctly seen as the same single look.
	return { keys, checked: !truncated, at: Math.min(pending.at, running.at) };
}

// ─── Split history fetch ─────────────────────────────────────────────────────
// One conversation, two queues: ordinary chat lives on the user's queue (or a
// legacy/random one), indexing passes on "<userId>-bg" — whose stored request
// bodies carry whole file windows and dominated every history page. The split
// fetches the SURFACE (id-prefix listing minus the bg queue, full bodies) and
// the BG queue (exact, compact stubs — the lambda stubs ONLY indexing-shaped
// items, ordinary chats deferred onto the bg queue keep full bodies) and
// returns a getChatHistory-shaped page.
//
// This is v2, redesigned around the 2026-08-11 review findings:
//   • The SDK ignores explicit fetchOptions.startKeyHistory — paging rides its
//     internal per-params-hash cursors. So ALL split state lives HERE, module-
//     level, keyed by (service|owner|platform|userId): the bg overflow buffer,
//     the undelivered surface page, end flags. Callers keep echoing
//     startKeyHistory opaquely; it is bookkeeping only, on both sides.
//   • Pages TILE exactly: each page emits only items at-or-newer-than the
//     surface page's oldest item (the boundary); bg items older than that are
//     BUFFERED for the next page. Consumers' raw prepend, retainedOlder
//     pruning and clear-horizon early-end all rely on this invariant.
//   • Retry-safe: the fetched surface page is held as pendingSurface until the
//     merged page is actually returned, and every bg page lands in the buffer
//     the moment it arrives — a mid-call failure + caller retry resumes with
//     nothing skipped (the SDK's internal cursors have already advanced; the
//     state carries what they advanced past).
//   • Empty-but-not-end pages are eliminated SERVER-side (the lambda re-queries
//     past fully-filtered windows). A defensive client cap remains.
//
// Backwards-safe: an old backend ignores queue_exclude/compact — the surface
// then includes bg items with bodies (exactly today's single fetch), the bg
// call returns duplicates, and dedup-by-id (surface wins) degrades to current
// behavior plus one redundant query, never to data loss.
// Per-call bg fetches. Depth is LAZY: the consumers merge prepended pages by
// timestamp, so older stubs can arrive on any later page and still land at
// their true position — there is no need to drain the bg queue eagerly, and
// doing so is exactly what made first paint slow (bg windows are ~1MB of RAW
// rows, i.e. a handful of stubs per round trip). Two fetches keep the nearby
// stubs in the same paint; scroll-up/viewport-fill pages pull the rest.
const BG_COVERAGE_MAX_PAGES = 2;

type SplitHistoryState = {
	/** Fetched bg items not yet emitted (older than the last page's boundary). */
	bgBuffer: any[];
	bgEnd: boolean;
	/** Whether the bg chain has fetched at least once (first call resets the
	 *  SDK's internal bg cursor with fetchMore:false; later calls continue). */
	bgStarted: boolean;
	surfaceEnd: boolean;
	/** Surface page fetched but not yet delivered in a returned merged page —
	 *  reused on retry so the SDK's advanced cursor cannot skip it. Stamped
	 *  with the fetchMore mode it was fetched under: a page-1 fetch abandoned
	 *  mid-coverage must never be replayed as an OLDER page (or vice versa). */
	pendingSurface: { list: any[]; endOfList: boolean; startKeyHistory: any[]; forFetchMore: boolean } | null;
	/** Surface items fetched but HELD BACK because the bg coverage loop's hop
	 *  cap fired before the bg side reached this page's boundary: emitting
	 *  them would let the uncovered bg stubs land on a LATER page above
	 *  strictly-newer surface turns. Prepended to the next page's surface. */
	surfaceCarry: any[];
	lastSurfaceKeys: any[];
	/** Newest bg item id this chain has ever seen. The head refresh compares it
	 *  against the fresh head page: a FULL head page that no longer contains it
	 *  means more than one page of bg rows landed while nobody was polling, and
	 *  the walk must reopen or the gap is unfetchable forever. */
	newestBgId: string;
};
const splitHistoryStates: { [key: string]: SplitHistoryState } = {};
// Per-key serialization: a token-bumped reload can start a NEW split call
// while an old one is mid-flight, and both would interleave on the SDK's
// shared internal cursor chains (silently skipping pages). The newcomer waits
// for the incumbent to settle; its stale result is discarded by the callers'
// own token guards, and the newcomer's fetchMore:false reset then starts from
// a clean chain.
const splitHistoryLocks: { [key: string]: Promise<void> } = {};

function freshSplitState(): SplitHistoryState {
	return { bgBuffer: [], bgEnd: false, bgStarted: false, surfaceEnd: false, pendingSurface: null, surfaceCarry: [], lastSurfaceKeys: [], newestBgId: '' };
}

/** Track the newest bg id the chain has seen (ids are creation-ordered). */
function noteBgIds(state: SplitHistoryState, list: any[]): void {
	for (const it of list) {
		const id = it && typeof it.id === 'string' ? it.id : '';
		if (id && id > state.newestBgId) state.newestBgId = id;
	}
}

/** Test hook: drop split-fetch state (all keys, or one). */
export function __resetSplitHistoryState(key?: string): void {
	if (key !== undefined) { delete splitHistoryStates[key]; delete splitHistoryLocks[key]; return; }
	for (const k in splitHistoryStates) delete splitHistoryStates[k];
	for (const k in splitHistoryLocks) delete splitHistoryLocks[k];
}

const createdOf = (it: any): number => {
	const c = Number(it && it.created);
	return isFinite(c) && c > 0 ? c : NaN;
};
const oldestCreated = (lst: any[]): number => {
	let m = Infinity;
	for (const it of lst) {
		const c = createdOf(it);
		if (!isNaN(c) && c < m) m = c;
	}
	return m; // Infinity when no item carries a usable timestamp
};

// A pure-bg band can outlast the LAMBDA's own re-query cap (its raw windows
// are 1MB and inline indexing bodies run to ~300KB, so one lambda call may
// cross only a few dozen rows) — so the client must ALSO loop past
// empty-but-not-end surface pages, or the fill loops upstream read them as
// exhausted and strand older history (and an empty page 1 would blank the
// chat). Each hop here is one more lambda call.
const SURFACE_EMPTY_MAX_PAGES = 10;

export type SplitHistoryResult = {
	list: any[];
	endOfList: boolean;
	startKeyHistory: any[];
	/** True when this chat had never been walked in this session — the first
	 *  paint. Consumers gate the "Loading indexing history" hint on it: a
	 *  mid-walk tab return restarts the walk for cursor safety but must stay
	 *  silent (flashing the hint on every return was the reported bug). */
	firstLoad?: boolean;
	/** Present only when `deferBg` was requested AND bg work remains: resolves
	 *  with the stub batch fetched in the background (the per-key lock is held
	 *  until it settles, so no other history call can interleave). The caller
	 *  merges the batch by timestamp — the same path older pages use. */
	bgPending?: Promise<{ list: any[]; endOfList: boolean }>;
};

export async function getSplitChatHistory(
	params: {
		service: string;
		owner: string;
		platform: 'claude' | 'openai';
		userId?: string;
		/**
		 * Scope the SURFACE fetch to this chat's own queue instead of "everything
		 * that is not the bg queue".
		 *
		 * Set for an ANONYMOUS visitor, and only for one. The backend identifies an
		 * unauthenticated caller as `ip + "(" + user_agent + ")"`, and the default
		 * surface fetch (queue_exclude, no queue) is scoped by exactly that string
		 * server side - so two anonymous visitors behind one NAT on the same browser
		 * build read each other's transcript, which is the thing per-device history
		 * exists to prevent. Reading the device's own queue instead scopes it by a
		 * value the client controls and the other device does not share.
		 *
		 * NOT used for a signed-in caller. Their turns are already scoped by their
		 * `sub`, and queue_exact would additionally hide any history sent under a
		 * different queue name than the current userId (an older fallback, a
		 * pre-rename row), which queue_exclude still returns.
		 *
		 * The queue name is unguessable but NOT secret: it travels on every request
		 * and queue listings are not user-scoped server side. Anonymous transcripts
		 * are non-confidential by construction.
		 */
		scopeSurfaceToQueue?: boolean;
	},
	fetchOptions: Record<string, any>,
	/** Test seam: replaces getChatHistory. Not for production callers. */
	_fetchImpl?: typeof getChatHistory,
): Promise<SplitHistoryResult> {
	const key = [params.service, params.owner, params.platform, params.userId || ''].join('|');
	const prev = splitHistoryLocks[key] || Promise.resolve();
	// The lock resolves when the WHOLE call — including a deferred bg batch —
	// has settled, so queued calls never interleave with background work. A
	// call that returns WITHOUT a bgPending (or throws) releases immediately;
	// a deferred call releases in the bg batch's own finally.
	let releaseLock: () => void;
	const lockTail = new Promise<void>((r) => { releaseLock = r; });
	const run = () => _getSplitChatHistoryLocked(key, params, fetchOptions, releaseLock!, _fetchImpl);
	const p = prev.then(run, run);
	p.then((res: any) => { if (!res || !res.bgPending) releaseLock(); }, () => releaseLock());
	splitHistoryLocks[key] = p.then(() => lockTail, () => lockTail);
	return p;
}

async function _getSplitChatHistoryLocked(
	key: string,
	params: {
		service: string;
		owner: string;
		platform: 'claude' | 'openai';
		userId?: string;
		/**
		 * Scope the SURFACE fetch to this chat's own queue instead of "everything
		 * that is not the bg queue".
		 *
		 * Set for an ANONYMOUS visitor, and only for one. The backend identifies an
		 * unauthenticated caller as `ip + "(" + user_agent + ")"`, and the default
		 * surface fetch (queue_exclude, no queue) is scoped by exactly that string
		 * server side - so two anonymous visitors behind one NAT on the same browser
		 * build read each other's transcript, which is the thing per-device history
		 * exists to prevent. Reading the device's own queue instead scopes it by a
		 * value the client controls and the other device does not share.
		 *
		 * NOT used for a signed-in caller. Their turns are already scoped by their
		 * `sub`, and queue_exact would additionally hide any history sent under a
		 * different queue name than the current userId (an older fallback, a
		 * pre-rename row), which queue_exclude still returns.
		 *
		 * The queue name is unguessable but NOT secret: it travels on every request
		 * and queue listings are not user-scoped server side. Anonymous transcripts
		 * are non-confidential by construction.
		 */
		scopeSurfaceToQueue?: boolean;
	},
	fetchOptions: Record<string, any>,
	releaseLock: () => void,
	_fetchImpl?: typeof getChatHistory,
): Promise<SplitHistoryResult> {
	const fetch = _fetchImpl || getChatHistory;
	const bgQueue = bgIndexingQueueName(params.userId, params.service);
	const base = { service: params.service, owner: params.owner, platform: params.platform };
	// What the SURFACE (non-background) fetch filters on. `queue_exclude` is the
	// default and returns every row that is not on the bg chain; the anonymous
	// path narrows to this chat's OWN queue instead. Same queue name the chat
	// turns are dispatched under (requests.ts `queue: userId || service`), so the
	// two cannot drift.
	const surfaceScope: Record<string, any> = params.scopeSurfaceToQueue && params.userId
		? { queue: params.userId, queue_exact: true }
		: { queue_exclude: bgQueue };
	const fetchMore = !!(fetchOptions && fetchOptions.fetchMore);
	const limit = fetchOptions && fetchOptions.limit;

	// HEAD refresh: a repeat first-page call on a chain that already walked BOTH
	// queues to their end (tab return, poll-side page-1 refresh). Page 1 must be
	// re-fetched for new settles, but what the chain LEARNED about the older
	// tail — "all history fetched" — survives. Wiping it here was the tab-return
	// bug: every return re-pulled the bg stub pages from scratch, reported
	// endOfList false, and that un-gated the viewport fill into re-walking every
	// older page the user had already exhausted. Only a FULLY-ended chain is
	// safe to preserve: its fetchMore path short-circuits without touching the
	// SDK cursors this page-1 refresh rewinds. A mid-walk chain still restarts.
	// True when this chat has never been walked in this session at all — the
	// consumers gate the "Loading indexing history" hint on it, so a mid-walk
	// tab return (which restarts the walk for cursor safety) stays SILENT.
	const firstLoad = !splitHistoryStates[key];
	let headRefresh = false;
	if (!splitHistoryStates[key]) {
		splitHistoryStates[key] = freshSplitState();
	} else if (!fetchMore) {
		const prev = splitHistoryStates[key];
		if (prev.surfaceEnd && prev.bgEnd) {
			headRefresh = true;
			prev.pendingSurface = null;
			prev.surfaceCarry = [];
			prev.bgBuffer = []; // fully drained by construction; defensive
		} else {
			// Mid-walk chain: the page-1 refresh genuinely restarts the walk
			// (the underlying fetchMore:false calls below reset the SDK's own
			// cursors to match), exactly as before.
			splitHistoryStates[key] = freshSplitState();
		}
	}
	const state = splitHistoryStates[key];

	// A held page fetched under the OTHER mode is not this call's page —
	// discard it rather than replay page 1 as an "older" page (or vice versa).
	if (state.pendingSurface && state.pendingSurface.forFetchMore !== fetchMore) {
		state.pendingSurface = null;
	}

	// ── surface page ────────────────────────────────────────────────────────
	if (!state.pendingSurface) {
		// The ended-chain short-circuit serves FETCHMORE only: a head refresh
		// re-fetches page 1 for real (new settles live there), and the
		// preserved surfaceEnd keeps every later fetchMore off the wire.
		if (state.surfaceEnd && !headRefresh) {
			state.pendingSurface = { list: [], endOfList: true, startKeyHistory: state.lastSurfaceKeys, forFetchMore: fetchMore };
		} else {
			const sOpts: any = { fetchMore };
			if (limit) sOpts.limit = limit;
			let s = await fetch({ ...base, ...surfaceScope }, sOpts);
			// Loop past empty-but-not-end pages (see SURFACE_EMPTY_MAX_PAGES).
			let hops = 0;
			while (s && !s.endOfList && !((s.list || []).length) && hops < SURFACE_EMPTY_MAX_PAGES) {
				hops++;
				const nOpts: any = { fetchMore: true };
				if (limit) nOpts.limit = limit;
				s = await fetch({ ...base, ...surfaceScope }, nOpts);
			}
			state.pendingSurface = {
				list: (s && Array.isArray(s.list)) ? s.list : [],
				endOfList: !!(s && s.endOfList),
				startKeyHistory: (s && Array.isArray(s.startKeyHistory)) ? s.startKeyHistory : [],
				forFetchMore: fetchMore,
			};
		}
	}
	const surface = state.pendingSurface;

	// ── deferred bg (first-paint mode) ──────────────────────────────────────
	// The caller paints the CONVERSATION from this return immediately; the
	// stub fetch happens behind the resolved promise, under the same lock.
	// Anything already buffered ships now (it costs nothing).
	if (fetchOptions && fetchOptions.deferBg && (!state.bgEnd || headRefresh)) {
		const surfaceList0 = state.surfaceCarry.length ? state.surfaceCarry.concat(surface.list) : surface.list.slice();
		state.surfaceCarry = [];
		const emitNow: any[] = surfaceList0.concat(state.bgBuffer);
		state.bgBuffer = [];
		// A head refresh must not let page 1's "more pages exist" clobber the
		// preserved end-knowledge: those pages are the tail already walked.
		if (!headRefresh) state.surfaceEnd = surface.endOfList;
		state.lastSurfaceKeys = surface.startKeyHistory;
		state.pendingSurface = null;
		const bgPending = (async () => {
			try {
				const batch: any[] = [];
				if (headRefresh) {
					// One HEAD page only: the walked tail is complete; this
					// catches bg rows that settled/minted while nobody was
					// polling. bgEnd/bgStarted are normally left alone — the
					// end-knowledge survives, and the coverage loop (gated on
					// !bgEnd) never touches the cursor this rewinds. ONE
					// exception: a FULL head page that no longer contains the
					// newest bg id this chain had seen means more than a page
					// of bg rows landed while hidden — the gap is unreachable
					// unless the walk reopens (id-dedup makes re-walking the
					// tail harmless).
					const bOpts: any = { fetchMore: false };
					if (limit) bOpts.limit = limit;
					const b = await fetch({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
					const bList: any[] = (b && Array.isArray(b.list)) ? b.list : [];
					for (const it of bList) { if (it && typeof it === 'object') (it as any)._fromBgChain = true; batch.push(it); }
					const prevNewest = state.newestBgId;
					noteBgIds(state, bList);
					if (prevNewest && !(b && b.endOfList) &&
						!bList.some((it: any) => it && it.id === prevNewest)) {
						state.bgEnd = false;
						state.bgStarted = true;
					}
				} else {
					let hops = 0;
					while (!state.bgEnd && hops < BG_COVERAGE_MAX_PAGES) {
						hops++;
						const bOpts: any = { fetchMore: state.bgStarted };
						if (limit) bOpts.limit = limit;
						const b = await fetch({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
						state.bgStarted = true;
						const bList: any[] = (b && Array.isArray(b.list)) ? b.list : [];
						for (const it of bList) { if (it && typeof it === 'object') (it as any)._fromBgChain = true; batch.push(it); }
						noteBgIds(state, bList);
						state.bgEnd = !!(b && b.endOfList);
						if (!bList.length && !state.bgEnd) break;
						if (state.bgEnd) break;
					}
				}
				return { list: batch, endOfList: state.surfaceEnd && state.bgEnd };
			} finally {
				releaseLock();
			}
		})();
		return {
			list: emitNow,
			// A head-refreshed ended chain KNOWS it is still ended — reporting
			// the hardcoded false here was what un-gated the fill loop on every
			// tab return. Mid-walk it computes to false exactly as before (this
			// branch is only entered with bgEnd false then); the bg batch still
			// carries the final word for that case.
			endOfList: state.surfaceEnd && state.bgEnd,
			startKeyHistory: surface.startKeyHistory,
			firstLoad,
			bgPending,
		};
	}

	// Carried-over surface items (held back by an uncovered boundary on the
	// previous page) lead this page's surface list.
	const surfaceList = state.surfaceCarry.length ? state.surfaceCarry.concat(surface.list) : surface.list.slice();

	// The tiling line: everything at-or-newer than this is emitted now, older
	// bg items wait in the buffer. A finished surface (endOfList) opens the
	// line all the way (-Infinity) so the bg side drains over the next pages.
	// An empty surface page past the loop above (a pathological pure-bg band
	// beyond both the lambda's and our own hop caps) yields Infinity — no bg
	// drain, an empty page, and the consumers' empty-page guards take over.
	const boundary = surface.endOfList ? -Infinity : oldestCreated(surfaceList);

	// ── bg coverage ─────────────────────────────────────────────────────────
	if (headRefresh) {
		// Non-deferred head refresh: the same single HEAD page the deferred
		// branch fetches, under the same rules — new settles are caught, the
		// end-knowledge (bgEnd/bgStarted) is left untouched, EXCEPT when a full
		// head page no longer contains the newest bg id this chain had seen:
		// more than a page landed while hidden, and the walk must reopen or the
		// gap is unfetchable (id-dedup makes re-walking the tail harmless).
		const hOpts: any = { fetchMore: false };
		if (limit) hOpts.limit = limit;
		const hb = await fetch({ ...base, queue: bgQueue, queue_exact: true, compact: true }, hOpts);
		const hbList: any[] = (hb && Array.isArray(hb.list)) ? hb.list : [];
		for (const it of hbList) { if (it && typeof it === 'object') (it as any)._fromBgChain = true; state.bgBuffer.push(it); }
		const prevNewestH = state.newestBgId;
		noteBgIds(state, hbList);
		if (prevNewestH && !(hb && hb.endOfList) &&
			!hbList.some((it: any) => it && it.id === prevNewestH)) {
			state.bgEnd = false;
			state.bgStarted = true;
		}
	} else if (boundary !== Infinity || surface.endOfList) {
		let hops = 0;
		while (!state.bgEnd && hops < BG_COVERAGE_MAX_PAGES) {
			const bufOldest = state.bgBuffer.length ? oldestCreated(state.bgBuffer) : Infinity;
			if (state.bgBuffer.length && bufOldest <= boundary) break;
			hops++;
			const bOpts: any = { fetchMore: state.bgStarted };
			if (limit) bOpts.limit = limit;
			const b = await fetch({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
			state.bgStarted = true;
			const bList: any[] = (b && Array.isArray(b.list)) ? b.list : [];
			// Buffer IMMEDIATELY: the SDK cursor has advanced; this is what a
			// retry resumes from. Tagged as bg-chain items so the consumers'
			// surface-frontier logic (retention boundary, clear-horizon) can
			// tell deep stubs from the conversation's own paging frontier.
			for (const it of bList) { if (it && typeof it === 'object') (it as any)._fromBgChain = true; state.bgBuffer.push(it); }
			noteBgIds(state, bList);
			state.bgEnd = !!(b && b.endOfList);
			if (!bList.length && !state.bgEnd) break; // defensive: server loops past empties
			if (state.bgEnd) break;
		}
	}

	// ── emit ────────────────────────────────────────────────────────────────
	// Everything fetched ships NOW — surface items are never withheld and the
	// bg buffer drains into every page. Ordering across pages is the
	// consumers' job (stable timestamp merge on prepend), which is what
	// removed the old tiling/withholding machinery: it delayed the
	// CONVERSATION behind a full bg drain on every first visit.
	const emitSurface: any[] = surfaceList;
	state.surfaceCarry = [];
	const emitBg: any[] = state.bgBuffer;
	state.bgBuffer = [];

	// Dedup by item id, surface copy (full bodies) winning — the old-backend
	// degradation path, and a guard against any range overlap.
	const seen: { [id: string]: boolean } = {};
	for (const it of emitSurface) { if (it && typeof it.id === 'string') seen[it.id] = true; }
	const merged = emitSurface.concat(emitBg.filter((it: any) => !(it && typeof it.id === 'string' && seen[it.id])));

	// ── deliver ─────────────────────────────────────────────────────────────
	// Same head-refresh rule as the deferred branch: page 1's own "more pages
	// exist" must not clobber a preserved end-knowledge.
	if (!headRefresh) state.surfaceEnd = surface.endOfList;
	state.lastSurfaceKeys = surface.startKeyHistory;
	state.pendingSurface = null;

	return {
		list: merged,
		endOfList: state.surfaceEnd && state.bgEnd && state.bgBuffer.length === 0 && state.surfaceCarry.length === 0,
		// Bookkeeping only (both the consumers and the SDK treat it opaquely);
		// the real cursors are the SDK's internal ones plus this module's state.
		startKeyHistory: surface.startKeyHistory,
		firstLoad,
	};
}


/**
 * THE chat key. Every cache, every ownership stamp and every "is this turn for
 * the chat on screen?" comparison is built here and nowhere else.
 *
 * It used to be written out by hand in four places. When a third segment was
 * added for the chat identity - a browser can hold an anonymous conversation and
 * a signed-in one on the SAME project, and the two must not share a cache - only
 * one of those four was updated. The rest kept producing the two-segment form,
 * so `key !== getHistoryCacheKey()` became permanently true: every send was
 * treated as belonging to another project, the optimistic bubble and the
 * "Thinking..." placeholder were never pushed, and nothing appeared until the
 * server history caught up. One function, so a twin cannot drift again.
 */
export function chatCacheKey(
	projectId: string | undefined,
	platform: string | undefined,
	userId?: string,
): string {
	if (!projectId || platform === 'none') return '';
	return projectId + '#' + platform + '#' + (userId || '');
}

/**
 * The INDEXING scope key: project + platform, deliberately WITHOUT the identity.
 *
 * Claiming, stopping and cancelling a file's indexing are scoped per project and
 * platform because a storage path is project-relative and one ChatSession serves
 * every project. They are NOT per user: an anonymous visitor cannot upload or
 * index at all, so there is no second identity to separate, and folding the
 * identity in here would only have to be threaded through BgTaskEntry to no end.
 *
 * Kept separate from chatCacheKey ON PURPOSE. These two were the same string
 * once, which is exactly how adding a segment to one silently broke the other.
 */
export function indexScopeKey(
	projectId: string | undefined,
	platform: string | undefined,
): string {
	if (!projectId || platform === 'none') return '';
	return projectId + '#' + platform;
}

export type MapHistoryOptions = {
	clearedAt: number;
	projectId: string;
	/** Chat identity, so the `_ownerKey` stamp matches chatCacheKey(). */
	userId?: string;
	/** View-side display formatter for "Indexing:/Reindexing: …" bubbles. */
	formatIndexingLabel: (name: string, mime?: string, size?: number | null, storagePath?: string, reindex?: boolean, continued?: boolean) => string;
};

export function mapHistoryListToMessages(list: any[], platform: 'claude' | 'openai', opts: MapHistoryOptions) {
	var mapped: any[] = [], runningItemIds: string[] = [];
	var extractAssistantText = platform === 'openai' ? extractOpenAIText : extractClaudeText;
	var filtered = filterListByClearHorizon(list, opts.clearedAt);
	filtered.slice().reverse().forEach(function (item) {
		var requestBody = item && item.request_body;
		var isInProcess = item && item.status === 'running';
		var isQueued = item && item.status === 'pending';
		var isCancelledItem = item && item.status === 'cancelled';
		var isPending = isInProcess || isQueued;
		var isFailed = item && item.status === 'failed';
		var response = isFailed ? (item.error != null ? item.error : item.response_body)
			: (item && item.response_body != null ? item.response_body : item && item.error);
		// COMPACT listing stubs (bg-queue pages fetched with `compact: true`):
		// bodies never left the server; the label line, the response head, and
		// the completion-marker bit arrive as dedicated fields. Everything the
		// COLLAPSED row needs is here; expanding a row fetches the real bodies
		// per item (buildHistoryItemFullId point lookups) and remaps.
		var isCompact = !!(item && item.compact);
		var userText = isCompact
			? (typeof item.request_text === 'string' ? item.request_text : '')
			: extractLastUserTextFromRequest(requestBody);
		var assistantText = isPending ? '' : (isCompact
			? ((typeof item.response_text === 'string' ? item.response_text : '').trim())
			: ((extractAssistantText(response) || '').trim() || ''));
		var isErrorResponse = !isPending && (isFailed || (!isCompact && isErrorResponseBody(response)));
		// Record the completion marker, then STRIP it — both, and in that order.
		// Recording gives the display layer a structured signal instead of a substring
		// search over model prose. Stripping matches the live resolution path: without
		// it the literal token rendered inside the bubble on every history load, which
		// is not a post-reload curiosity — a first-page load REPLACES the live bubbles,
		// and those responses are now on screen far more often than they used to be.
		//
		// Gated on _isBgTask: only an INDEXING pass has a protocol token to hide. An
		// ordinary reply that merely mentions it keeps its own words.
		var reportedComplete = !!(item && item._isBgTask) && !isErrorResponse && (isCompact
			? item.response_complete_marker === true
			: (!!assistantText && assistantText.indexOf(INDEXING_COMPLETE_MARKER) !== -1));
		// Still gated on the recorded marker (i.e. an INDEXING pass): an ordinary
		// reply that merely mentions the token keeps its own words. A compact
		// head can carry the literal token too, so the strip covers both forms.
		if (reportedComplete) assistantText = assistantText.split(INDEXING_COMPLETE_MARKER).join('').trim();
		var serverItemId = item && typeof item.id === 'string' && item.id ? item.id : undefined;
		// A USER bubble shows when the request was made (`created`); an ASSISTANT
		// bubble shows when its response landed (`updated`). Fall back to the other
		// if one is missing (older records only carried `updated`).
		var createdTs = Number(item && item.created);
		var updatedTs = Number(item && item.updated);
		var userTs = isFinite(createdTs) && createdTs > 0 ? createdTs : (isFinite(updatedTs) && updatedTs > 0 ? updatedTs : undefined);
		var replyTs = isFinite(updatedTs) && updatedTs > 0 ? updatedTs : (isFinite(createdTs) && createdTs > 0 ? createdTs : undefined);

		if (userText) {
			var displayContent;
			// Structured file ref for the display layer's per-file collapsing, kept
			// alongside the formatted label so grouping never has to parse it back.
			var indexFile: any = undefined;
			if (item._isBgTask) {
				var ref = parseIndexingRequestText(userText);
				if (ref) {
					// A CONTINUE pass ("CONTINUE indexing …") gets the compact
					// continuation label; a first pass ("A new file …") gets the full
					// one. Mirrors agent.vue's mapHistoryListToMessages so a big file's
					// windows read as progress, not the same task repeating.
					displayContent = opts.formatIndexingLabel(
						ref.name,
						ref.mime || '',
						typeof ref.size === 'number' ? ref.size : null,
						ref.path,
						false,
						ref.continued
					);
					indexFile = ref;
				} else {
					displayContent = userText;
				}
			} else {
				displayContent = sanitizeAttachmentLinksForHistory(userText, opts.projectId);
			}
			var userMsg: any = { role: 'user', content: displayContent };
			if (item._fromBgChain) userMsg._fromBgChain = true;
			if (isInProcess) userMsg.isPendingInProcess = true;
			if (isQueued) userMsg.isPendingQueued = true;
			if (isCancelledItem) userMsg.isCancelled = true;
			if (isCompact) userMsg._compact = true;
			if (item._isBgTask) userMsg.isBackgroundTask = true;
			if (indexFile) userMsg._indexFile = indexFile;
			if (item._isOnBgQueue) userMsg._useBgQueue = true;
			if (serverItemId !== undefined) userMsg._serverItemId = serverItemId;
			if (userTs !== undefined) userMsg._ts = userTs;
			mapped.push(userMsg);
		}
		if (isCancelledItem) { /* no assistant bubble */ }
		else if (isInProcess) {
			var ph: any = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true };
			// _ts matters even on a placeholder: the consumers' merge and any
			// display fallback must be able to place it without its user bubble.
			if (userTs !== undefined) ph._ts = userTs;
			if (item._fromBgChain) ph._fromBgChain = true;
			if (item._isBgTask) ph.isBackgroundTask = true;
			if (serverItemId !== undefined) { ph._serverItemId = serverItemId; runningItemIds.push(serverItemId); }
			mapped.push(ph);
		} else if (isQueued) { /* no assistant placeholder */ }
		else if (isErrorResponse) {
			var em: any = { role: 'assistant', content: getErrorMessage(response), isError: true };
			if (item._fromBgChain) em._fromBgChain = true;
			if (item._isBgTask) em.isBackgroundTask = true;
			if (serverItemId !== undefined) em._serverItemId = serverItemId;
			if (replyTs !== undefined) em._ts = replyTs;
			mapped.push(em);
		// `|| reportedComplete`: a pass whose ENTIRE answer was the completion token
		// strips down to an empty string, and the plain `assistantText` guard then
		// emitted no bubble at all — while the live path emitted one. The run read as
		// finished live and unfinished after a reload, so the row's loader came back.
		} else if (assistantText || reportedComplete) {
			// Safe db-only sanitize (forAssistant) so a volatile db url the model
			// emitted renders as a re-mintable `_expired_.url` link, not a dead one.
			var okm: any = { role: 'assistant', content: sanitizeAttachmentLinksForHistory(assistantText, opts.projectId, true) || EMPTY_INDEXING_REPLY };
			if (item._fromBgChain) okm._fromBgChain = true;
			if (item._isBgTask) okm.isBackgroundTask = true;
			if (isCompact) okm._compact = true;
			if (serverItemId !== undefined) okm._serverItemId = serverItemId;
			if (replyTs !== undefined) okm._ts = replyTs;
			if (reportedComplete) okm._indexComplete = true;
			mapped.push(okm);
		}
	});
	// Stamp the CHAT every bubble belongs to. Every cross-project guard in the
	// consumers reads `_ownerKey` and is written "undefined means unknown, keep
	// it" — and the mapper never set it, so SERVER-history bubbles (which is all
	// of them, including every indexing row) passed every one of those filters
	// unchallenged. That is what let one project's transcript survive on screen
	// into another project and be persisted under its key.
	if (opts.projectId) {
		var ownerKey = chatCacheKey(opts.projectId, platform, opts.userId);
		for (var oi = 0; oi < mapped.length; oi++) mapped[oi]._ownerKey = ownerKey;
	}
	return { messages: mapped, runningItemIds: runningItemIds };
}

/* ---- rescuing in-flight bubbles across a first-page refetch ---------------
 *
 * A first-page fetch REPLACES the message list, and the list may hold bubbles the
 * server does not know about yet: a turn whose request is still in flight, a
 * staged turn whose files are still uploading, a queued turn waiting for its ack.
 * Those have to survive the replace, and nothing else may.
 *
 * The rule lived twice — agent.vue's own fetchHistoryPage and the engine's
 * loadHistory — and the two had to be edited in lockstep to stay honest. It is one
 * function now, because the failure mode when they drift is a turn rendered twice
 * and then PERSISTED into the history cache, where it survives every later visit.
 */

export interface RescueDecisionContext {
	/** Is this `_serverItemId` in the page that was just fetched? */
	hasServerId: (id: string) => boolean;
	/**
	 * The fetched page already shows a non-background pending assistant.
	 *
	 * Only meaningful for a bubble with NO server id, where it is the sole
	 * available answer to "is this turn already represented?". For a bubble that
	 * HAS one, hasServerId answers exactly the same question exactly, and applying
	 * this on top of it would drop an in-flight turn whose server copy simply is
	 * not in the page that was fetched.
	 */
	pageHasPendingAssistant: boolean;
	/** state.sending: an immediate send is in flight for this chat. */
	sending: boolean;
	/** The bubble directly after this one in the local list. */
	next?: ChatMessage | null;
	/** The chat this fetch is FOR. A bubble stamped for another must not cross. */
	loadKey?: string;
}

export function shouldRescueInFlightMessage(m: ChatMessage, ctx: RescueDecisionContext): boolean {
	if (!m) return false;
	// Background indexing bubbles come back through their own merge.
	if (m.isBackgroundTask) return false;
	// Never carry another project's (or another platform's) bubbles onto this chat.
	if (m._ownerKey !== undefined && ctx.loadKey !== undefined && m._ownerKey !== ctx.loadKey) return false;
	// The page carries a fresher copy of this exact turn.
	if (m._serverItemId && ctx.hasServerId(m._serverItemId)) return false;
	// A staged turn has no server request yet, so nothing in the page can stand for
	// it. Unconditional: applying the pending-assistant test here would delete the
	// user's message mid-upload whenever some other turn happened to be in flight.
	if (m._stageId) return true;
	if (!m._serverItemId && ctx.pageHasPendingAssistant) return false;
	// In flight by its own flags, id or no id. The immediate-send pair is stamped
	// with its server id as soon as the dispatch reports one, and that id is there
	// to let the check above recognise the server's copy — not to disqualify the
	// bubble from being kept when there is no such copy.
	if (m.isSendingToServer || m.isPendingQueued || m.isPendingInProcess || m.isPending) return true;
	// An immediate-send user bubble carries no flags of its own (its in-flight-ness
	// lives in state.sending); what identifies it is its own unanswered placeholder
	// directly below it.
	if (ctx.sending && m.role === 'user') {
		var next = ctx.next;
		if (!next || next.isBackgroundTask || !next.isPending) return false;
		return next._serverItemId === undefined || next._serverItemId === m._serverItemId;
	}
	return false;
}
