/**
 * ChatSession — framework-agnostic stateful chat orchestration.
 *
 * Ported verbatim from the bunnyquery widget's in-place state machine (which was
 * itself ported from agent.vue), with three mechanical substitutions:
 *   CS.<field>        -> this.state.<field>
 *   renderMessages()  -> this.host.notify()
 *   S.<x> / skapi     -> this.host.getIdentity().<x> / this.host.cancelRequest / refreshSession
 *   scroll/refresh    -> this.host.scrollToBottom(IfSticky) / refreshMessageBubble
 * Module-level singletons (bgTaskQueue, aiChatHistoryCache, pendingAgentRequests,
 * cancelledServerIds, historyItemPolls) become instance fields. The provider
 * request builders are reached through the engine (which already has the skapi
 * transport + poll injected via configureChatEngine), so cancel/poll behavior is
 * preserved.
 *
 * The view (per consumer) keeps: rendering, markdown PARSE, DOM refs + scroll
 * measurement, attachment chips, and the auth/account shell. It drives the
 * session via the public methods and re-renders in host.notify().
 */
import {
	callClaudeWithPublicMcp,
	callOpenAIWithPublicMcp,
	notifyAgentSaveAttachment,
	notifyAgentContinueIndexing,
	INDEXING_COMPLETE_MARKER,
	EMPTY_INDEXING_REPLY,
	MAX_INDEXING_RESUME_PASSES,
	extractClaudeText,
	extractOpenAIText,
	getChatHistory,
	POLL_INTERVAL,
	MAX_CONCURRENT_BG_POLLS,
	bgIndexingQueueName,
	isBgIndexingQueue,
	buildHistoryItemFullId,
	ANTHROPIC_MESSAGES_API_URL,
	OPENAI_RESPONSES_API_URL,
	upsertIndexRunRecordSafe,
	type IndexRunStatus,
	type IndexRunPatch,
	type BgTaskEntry,
} from './requests';
import { isPagedReadFile, isImageVisionFile, isWindowedReadFile } from './office';
import { windowedIndexingEnabled, chatEngineConfig } from './config';
import { isErrorResponseBody, isAuthExpiredError, isNonRetryableRequestError, getErrorMessage } from './errors';
import { buildBoundedChatMessages } from './budget';
import { createInlineLinkRegex, sanitizeAttachmentLinksForHistory } from './links';
import { markImagePreviewStale } from './image_preview';
import { mapHistoryListToMessages, extractLastUserTextFromRequest, isIndexingRequestText, parseIndexingRequestText, probeBgQueue, BG_PROBE_TTL_MS, getSplitChatHistory, shouldRescueInFlightMessage } from './history';
import { wallClockNow } from './time';
import { parseAttachmentContent } from './attachment_parsers';
import type { ChatHost, ChatState, ChatMessage, ChatIdentity, PinnedDispatchContext } from './host';
import type { IndexingGroup } from './indexing_groups';

function sleep(ms: number): Promise<void> {
	return new Promise(function (r) { setTimeout(r, ms); });
}

// How many live items one look at the background-indexing queue asks for. The
// queue is FIFO per user, so a healthy chain has one running plus at most a
// couple queued; the cap only bounds a pathological backlog.
const WORKER_PASS_ADOPT_LIMIT = 20;
// How stale the "which files are indexing" snapshot may be when it is used to
// refuse a DUPLICATE index dispatch. Short, because the answer decides whether a
// file gets indexed at all; long enough that one upload batch asks once, not once
// per file.
const LIVE_INDEX_SNAPSHOT_MAX_AGE_MS = 5000;
// How long a client holds a file's indexing slot from the moment it decides to
// dispatch. It only has to outlive the gap between that decision and the queue
// admitting the pass (a request, plus the status index catching up); after that
// the bgTaskQueue entry and the pass's own bubble carry the fact. Bounded so a
// dispatch that died without releasing cannot lock a file out for the session.
const INDEX_DISPATCH_CLAIM_MS = 2 * 60 * 1000;
// Delays before each look (the first is immediate). More than one because the
// worker writes the next pass's row a few milliseconds AFTER it resolves the
// current one, so a look that wins that race sees an empty queue for a chain
// that is still alive. Fixed and finite: this must never become a poll.
const WORKER_PASS_ADOPT_ATTEMPTS = [0, 2000, 6000];

// awaitIndexingDrained: how often it re-asks the background-indexing queue, and
// how many consecutive empty answers it needs before believing the chains are
// over. More than one for the same reason the adopt ladder above looks twice —
// pass N+1 is written just after pass N resolves, so a single look lands in that
// gap and reports an idle queue for a file that is still being read.
//
// Two cadences: while work is visibly running there is nothing to be gained by
// asking often (an indexing pass takes tens of seconds, and a big file can hold
// the queue for many minutes), but once the queue looks empty the confirming
// look is all that stands between the user and their answer.
// Early point-lookups for a foreground reply, before the flat POLL_INTERVAL tick lands.
// Widening on purpose: the first two catch a short reply (a greeting, a one-line answer) that
// would otherwise idle until 3s, and after ~1.7s a reply is long enough that the 3s interval is
// no longer the dominant cost, so probing further would just add requests. Three probes is at
// most three extra point lookups per turn, and none of them fire once the reply has landed.
const EARLY_PROBE_SCHEDULE_MS = [400, 900, 1700];

const INDEXING_DRAIN_BUSY_POLL_MS = 8000;
const INDEXING_DRAIN_CONFIRM_POLL_MS = 3000;
const INDEXING_DRAIN_IDLE_LOOKS = 2;
// Floor on the whole wait. The status index is eventually consistent, so the
// pass this turn's own upload just enqueued can be missing from the first looks —
// releasing on those would send the chat ahead of the very files it is asking
// about. Costs nothing in the normal case, where the queue reports work
// immediately and the wait is far longer than this anyway.
const INDEXING_DRAIN_MIN_MS = 8000;

// Ownership sequence for state.bgHistoryLoading (see the deferred-batch handler
// in loadHistory): the latest minted batch owns the flag; older handlers
// settling late must neither clear nor keep it.
let _bgHistoryBatchSeq = 0;
// Ceiling on that wait. Past it the turn is sent regardless: an answer computed
// against a partly-indexed file is a poor outcome, but a question that is never
// asked at all because one chain wedged server-side is a worse one.
const INDEXING_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;
// A look that never comes back would hang the whole wait forever — there is no
// pending timer to fall back on, so the turn is never sent and its bubble never
// stops saying "(Indexing files...)". A look that outlives this is abandoned and
// counted as UNKNOWN, i.e. as busy, which costs one more cycle and nothing else.
//
// Set well above any plausible slow answer rather than just above a fast one. An
// abandoned look counts as busy and there is no way back: an index that reliably
// answers slower than this can never produce two agreeing idle looks, so the turn
// would sit at "(Indexing files...)" until the 15-minute ceiling. The cost of
// being generous is one extra cycle in the case this is meant to catch, which by
// definition never returns at all.
const INDEXING_DRAIN_LOOK_TIMEOUT_MS = 45000;
// Closest a nudged look may follow the previous one. Bounds the extra request
// rate when a bulk upload finishes many chains at once; the unnudged cadence is
// one pair of requests per INDEXING_DRAIN_BUSY_POLL_MS.
const INDEXING_DRAIN_NUDGE_MIN_GAP_MS = 1500;

// requestAnimationFrame / high-res clock, reached through globalThis so the
// engine stays DOM-free at the type level (and degrades gracefully in non-DOM
// / test environments where these globals are absent).
var _g: any = typeof globalThis !== 'undefined' ? globalThis : {};
function nowMs(): number {
	return (_g.performance && typeof _g.performance.now === 'function') ? _g.performance.now() : Date.now();
}
function nextFrame(cb: (t: number) => void): void {
	if (typeof _g.requestAnimationFrame === 'function') { _g.requestAnimationFrame(cb); return; }
	setTimeout(function () { cb(nowMs()); }, 16);
}

/** A live poll registered in ChatSession.historyItemPolls. */
export type PollHandle = {
	/** 'bg' = background indexing, pausable. 'fg' = a reply the user is waiting on. */
	kind: 'fg' | 'bg';
	/** Absent on an older skapi-js that cannot stop an attached poll. */
	stop?: () => void;
};

/**
 * True when a poll result came from stopPolling rather than the server. Duck-typed on
 * purpose — see the note above about not importing skapi-js here.
 */
function isPollStopped(res: any): boolean {
	return !!res && typeof res === 'object' && res.status === 'stopped';
}

export class ChatSession {
	host: ChatHost;
	state: ChatState;
	bgTaskQueue: BgTaskEntry[];
	cancelledServerIds: Set<string>;
	/** Files whose indexing the user stopped, keyed exactly as buildChatDisplayList
	 *  keys a group (storage path, else filename). Cancelling one pass is not
	 *  enough on its own: the client dispatches CONTINUE passes for paged files, so
	 *  without this the next pass is enqueued the moment the cancelled one settles.
	 *  Cleared when a FIRST pass for the same file is queued again (a re-upload or a
	 *  Reindex from the file manager), so stopping a file never poisons it. */
	cancelledIndexKeys: Set<string>;
	pendingAgentRequests: Record<string, Promise<any>>;
	aiChatHistoryCache: Record<string, { messages: ChatMessage[]; endOfList: boolean; startKeyHistory: string[] }>;
	historyItemPolls: Map<string, PollHandle>;
	/** Non-empty while polling is paused; keyed by reason so overlapping causes
	 * (view detached AND tab hidden) do not resume each other prematurely. */
	private _pauseReasons: Set<string>;
	private _resuming: boolean;
	private _lidSeq: number;
	private _stageSeq: number;
	/** How many attachment-upload batches are running. uploadingAttachments is a
	 *  single flag but batches overlap (the composer stays live, so the user can
	 *  send a second one while the first uploads), and a nested finish must not
	 *  clear the flag out from under the batch still running. */
	private _uploadBatches: number;
	/** Indexing requests whose ack has not come back yet. Until it does the item
	 *  is not on the server's queue, so awaitIndexingDrained cannot see it — and
	 *  would read the gap between "pass N settled" and "pass N+1 accepted" as the
	 *  file being finished. */
	private _indexDispatchesInFlight: number;
	/** Live awaitIndexingDrained waiters, one callback each. A nudge only pulls that
	 *  waiter's NEXT look forward; it can never make one conclude anything, so a
	 *  wrong nudge costs one pair of requests and the look reports busy. Overlapping
	 *  waiters are normal — the composer stays live, so a second send can be
	 *  uploading while the first waits. */
	private _drainNudges: Array<() => void>;
	/** Stages whose upload/dispatch chain is still running in THIS page. Lives and
	 *  dies with those chains, so it is what tells a staged bubble restored from the
	 *  history cache whether anything is still working on it (see
	 *  settleDeadStagedMessages). Today the cache dies with the page too and every
	 *  restored stage is live; this stays correct if that ever changes. */
	private _liveStages: { [stageId: string]: boolean };
	/** Files the SERVER currently has unresolved indexing work for, by the same key
	 *  a collapsed row uses (storage path, else filename), and whether we have asked
	 *  even once for this chat.
	 *
	 *  This is the only thing that can tell a WORKER-driven run (a PDF's page loop, a
	 *  windowed read) that it is over. Those chains are advanced inside the worker off
	 *  the renderer's page count; the client sees passes appear and settle and can
	 *  never tell "between passes" from "finished" by looking at them. Asking the
	 *  queue is how it finds out. Until it has asked, `checked` is false and the view
	 *  says "still working", which is the honest reading of not knowing — and the one
	 *  that does not repeat the bug where a row claimed "Indexed" mid-run. */
	/** The chat the live-index snapshot (state.liveIndexKeys) was taken for, so a
	 *  project switch drops it. */
	private _liveIndexKey: string;
	/** When the snapshot was last published (wall clock ms), so a caller that needs
	 *  a CURRENT answer can tell whether to re-ask. 0 = never. */
	private _liveIndexAt: number;
	/** Files this client has an index dispatch in flight for, by scoped path ->
	 *  wall clock. See claimIndexRun. */
	private _indexClaims: { [scopedPath: string]: number };

	constructor(host: ChatHost) {
		this.host = host;
		this.state = {
			messages: [],
			attachments: [],
			uploadingAttachments: false,
			sending: false,
			typing: false,
			typingAbort: false,
			loadingHistory: false,
			loadingOlderHistory: false,
			// A deferred bg stub batch (first-paint split) is still in flight; the
			// views show a small 'loading indexing history' hint while true.
			bgHistoryLoading: false,
			historyEndOfList: false,
			historyStartKeyHistory: [],
			historyRequestToken: 0,
			gateRefreshToken: 0,
			liveIndexKeys: {},
			liveIndexChecked: false,
			stoppedIndexIds: {},
		};
		this.bgTaskQueue = [];
		this.cancelledServerIds = new Set();
		this.cancelledIndexKeys = new Set();
		this.pendingAgentRequests = {};
		this.aiChatHistoryCache = {};
		this.historyItemPolls = new Map();
		this._pauseReasons = new Set();
		this._resuming = false;
		this._lidSeq = 0;
		this._stageSeq = 0;
		this._uploadBatches = 0;
		this._indexDispatchesInFlight = 0;
		this._drainNudges = [];
		this._liveStages = {};
		this._liveIndexKey = '';
		this._liveIndexAt = 0;
		this._indexClaims = {};
	}

	/** What the display layer needs to decide whether a run is finished. `keys` holds
	 *  every file the server still has indexing work for; `checked` is false until the
	 *  first answer for this chat, and false means "we do not know yet". */
	getLiveIndexState(): { keys: { [fileKey: string]: boolean }; checked: boolean } {
		return { keys: this.state.liveIndexKeys, checked: this.state.liveIndexChecked };
	}

	/** Passes that were on a row when the user stopped it, so the display layer can
	 *  still tell that this run was stopped once the stop has left no other trace.
	 *  See cancelIndexingGroup, which fills it, and buildChatDisplayList, which is
	 *  the only reader. */
	getStoppedIndexIds(): { [serverItemId: string]: boolean } {
		return this.state.stoppedIndexIds;
	}

	/**
	 * Is this file ALREADY being indexed by this client?
	 *
	 * One live run per file, and the reason is what a second one looks like: the
	 * conversation grows a SECOND collapsed row for the same file (a run is opened
	 * by every FIRST pass, so two of them are two rows), the same document is read
	 * twice at full provider cost, and the two chains fight over the same records —
	 * the delete-then-repost that starts run 2 wipes what run 1 has saved so far.
	 *
	 * Asked of this client's own live work, so it cannot be wrong in the dangerous
	 * direction: a queued/running pass keeps its bgTaskQueue entry until its bubble
	 * settles, and a settled run answers false, which is what a genuine later
	 * re-index needs.
	 *
	 * The retry that made this necessary: a chip whose INDEX request failed is
	 * handed back to the composer to be retried on the next send, and an index
	 * request can fail from the client's side (a lost ack, an expired token on the
	 * response) while the server has already queued the pass. The retry then indexes
	 * a file that was never not being indexed.
	 */
	hasLiveIndexRun(storagePath?: string): boolean {
		if (!storagePath) return false;
		// A dispatch this client has STARTED but not yet heard back about. Nothing
		// else can see one: a bgTaskQueue entry exists only once the ack lands, the
		// bubble only once the drain runs after that, and the server's own status
		// index is eventually consistent — the adopt ladder retries at 0/2s/6s
		// precisely because a row created seconds ago can be missing from it. So
		// between deciding to index a file and the queue admitting it, EVERY source
		// of truth says "not indexing", and a second dispatch in that window is
		// exactly the duplicate this guard exists to stop. Observed live: two first
		// passes four seconds apart, two collapsed rows.
		var claimed = this._indexClaims[this._indexClaimKey(storagePath)];
		if (claimed && nowMs() - claimed < INDEX_DISPATCH_CLAIM_MS) return true;
		var id = this.host.getIdentity();
		for (var i = 0; i < this.bgTaskQueue.length; i++) {
			var e = this.bgTaskQueue[i];
			if (e && e.storagePath === storagePath && e.projectId === id.projectId && e.platform === id.platform) return true;
		}
		return this.state.messages.some(function (m) {
			if (!m.isBackgroundTask || m.role !== 'user' || m.isCancelled) return false;
			if (!(m.isPendingQueued || m.isPendingInProcess || m.isSendingToServer)) return false;
			return !!m._indexFile && m._indexFile.path === storagePath;
		});
	}

	/** Storage paths are project-relative, and one ChatSession serves every
	 *  project, so a claim has to be scoped the way a stop is (_indexKeyOf). */
	private _indexClaimKey(storagePath: string): string {
		return this.getHistoryCacheKey() + '|' + storagePath;
	}

	/**
	 * Take this file's indexing slot, or report that someone already has it.
	 *
	 * The check-and-CLAIM is what makes it safe against a second caller arriving
	 * mid-flight: the claim is written SYNCHRONOUSLY, before the first await, so a
	 * concurrent caller sees it even though no request has completed and no queue
	 * has admitted anything. Ask-then-dispatch could not do that — every source it
	 * consults only learns about a dispatch after the ack.
	 *
	 * Returns true when the caller owns the slot and should dispatch. A caller that
	 * then fails to dispatch MUST releaseIndexRun, or the file waits out the claim
	 * (a few minutes) before it can be retried.
	 */
	claimIndexRun(storagePath?: string): Promise<boolean> {
		var self = this;
		if (!storagePath) return Promise.resolve(true);
		if (this.hasLiveIndexRun(storagePath)) return Promise.resolve(false);
		this._indexClaims[this._indexClaimKey(storagePath)] = nowMs();
		return this._refreshLiveIndexKeys(LIVE_INDEX_SNAPSHOT_MAX_AGE_MS)
			.then(function () {
				if (!self.state.liveIndexKeys[storagePath]) return true;
				self.releaseIndexRun(storagePath);
				return false;
			})
			.catch(function () { return true; });
	}

	/** Give the slot back — the dispatch failed, or was abandoned. */
	releaseIndexRun(storagePath?: string): void {
		if (storagePath) delete this._indexClaims[this._indexClaimKey(storagePath)];
	}

	/**
	 * The same question, asked of the SERVER when this page cannot answer it.
	 *
	 * hasLiveIndexRun only knows what this page did. That is not enough for the
	 * case duplicates actually come from: the first run was started before a
	 * reload, or in another tab, or its bubble has since been paged out of the
	 * loaded window — and then the retry finds nothing locally and starts a second
	 * run of a file that is still being indexed. The queue is the one place that
	 * knows, and it is already asked for exactly this list.
	 *
	 * Only a POSITIVE answer is used. Absence proves nothing here (the query is
	 * capped, and `liveIndexChecked` records that), so an unanswerable question
	 * falls back to dispatching — the cost of a wrong "no" is the duplicate this
	 * exists to prevent, and the cost of a wrong "yes" is a file that never gets
	 * indexed at all. Only one of those is recoverable by the user.
	 */
	isIndexRunLive(storagePath?: string): Promise<boolean> {
		var self = this;
		if (!storagePath) return Promise.resolve(false);
		if (this.hasLiveIndexRun(storagePath)) return Promise.resolve(true);
		return this._refreshLiveIndexKeys(LIVE_INDEX_SNAPSHOT_MAX_AGE_MS)
			.then(function () { return !!self.state.liveIndexKeys[storagePath]; })
			.catch(function () { return false; });
	}

	/** Re-ask the queue which files are still being indexed, unless the answer we
	 *  have is younger than `maxAgeMs`. Shared by every caller that needs a current
	 *  one; the display layer's own refresh path is the adopt ladder. */
	private _refreshLiveIndexKeys(maxAgeMs: number): Promise<void> {
		var self = this;
		var id = this.host.getIdentity();
		var platform = id.platform;
		if (!id.projectId || (platform !== 'claude' && platform !== 'openai')) return Promise.resolve();
		// The chat this query is FOR, snapshotted before the round trip. The record
		// below is gated on it still being the chat on screen: the adopt ladder makes
		// the same resolve-time identity check, and without it a project switch inside
		// this query's RTT published chat A's queue answer as chat B's snapshot —
		// where absence reads as a green "Indexed" for files B is indexing right now.
		var askedKey = this.getHistoryCacheKey();
		if (this._liveIndexKey === askedKey && nowMs() - this._liveIndexAt < maxAgeMs) {
			return Promise.resolve();
		}
		var queue = bgIndexingQueueName(id.userId, id.projectId);
		// Snapshot reader: a young shared answer (this session's own adopt
		// ladder, or the db-files page's probe) is as good as a fresh one.
		var ask = function (status: 'pending' | 'running') {
			return Promise.resolve(probeBgQueue(
				{ service: id.projectId, owner: id.owner, platform: platform as 'claude' | 'openai', queue: queue, status: status, limit: WORKER_PASS_ADOPT_LIMIT },
				{ maxAgeMs: BG_PROBE_TTL_MS },
			)).then(function (entry) { return entry.result; }).catch(function () { return null; });
		};
		return Promise.all([ask('pending'), ask('running')]).then(function (results) {
			if (results[0] === null || results[1] === null) return;
			if (self.getHistoryCacheKey() !== askedKey) return;
			self._liveIndexKey = askedKey;
			self._recordLiveIndexKeys(results);
		});
	}

	/**
	 * Replace the live-index snapshot from a queue query's raw items.
	 *
	 * Whole-snapshot, never incremental: the query returns everything unresolved on
	 * the queue, so a file MISSING from it is precisely the fact we are after. Merging
	 * would make a finished file impossible to observe.
	 */
	private _recordLiveIndexKeys(lists: any[]): void {
		var next: { [k: string]: boolean } = {};
		// A page that came back FULL is not a whole-queue answer: the query is capped
		// and ordered newest-first, so a bulk upload of 40 files returns the 20 newest
		// and omits the 20 about to run. Absence would then read as "finished" for
		// exactly the files that have not been touched yet. Report not-knowing instead.
		var truncated = false;
		// Locally settled already. The adopt path refuses these items for the same
		// reason and says why: the status index is eventually consistent, so the pass
		// that just finished can still come back as running. Counting it as live work
		// leaves a finished file spinning with nothing left to ever settle and correct
		// it — the two readings of one payload must not disagree.
		var settledIds: { [id: string]: boolean } = {};
		this.state.messages.forEach(function (m) {
			if (!m._serverItemId) return;
			if (m.isPending || m.isPendingInProcess || m.isPendingQueued) return;
			settledIds[m._serverItemId] = true;
		});
		for (var li = 0; li < lists.length; li++) {
			var list = lists[li] && Array.isArray(lists[li].list) ? lists[li].list : [];
			if (list.length >= WORKER_PASS_ADOPT_LIMIT) truncated = true;
			for (var i = 0; i < list.length; i++) {
				var item = list[i];
				if (!item || (item.status !== 'pending' && item.status !== 'running')) continue;
				if (item.id && settledIds[item.id]) continue;
				var text = extractLastUserTextFromRequest(item.request_body);
				if (!isIndexingRequestText(text)) continue; // an ordinary chat on this queue
				var ref = parseIndexingRequestText(text);
				if (!ref) continue;
				// BOTH, not `path || name`. A row's key is normally the storage path,
				// but buildChatDisplayList falls back to the filename when the pass it
				// opened the run with carried no path (an old cached bubble, a label
				// with no link). A key recorded one way and looked up the other misses,
				// and a miss reads as FINISHED — the one direction that must never
				// happen by accident. Recording both can only over-match, which shows a
				// loader on a file that is done: visibly cautious instead of silently
				// wrong.
				if (ref.path) next[ref.path] = true;
				if (ref.name) next[ref.name] = true;
			}
		}
		var nowChecked = !truncated;
		var was = this.state.liveIndexKeys, changed = this.state.liveIndexChecked !== nowChecked;
		if (!changed) {
			for (var k in next) if (!was[k]) { changed = true; break; }
			if (!changed) for (var k2 in was) if (!next[k2]) { changed = true; break; }
		}
		this.state.liveIndexKeys = next;
		this.state.liveIndexChecked = nowChecked;
		this._liveIndexAt = nowMs();
		// Claim the snapshot for the CURRENT chat. Both callers verify identity before
		// recording, so this is always true - but only _refreshLiveIndexKeys used to say
		// so, and the adopt ladder (the path every plain page load actually seeds
		// through) never did. _liveIndexKey then stayed '', and the first-page reset in
		// loadHistory ('loadKey !== _liveIndexKey') fired on EVERY load - including every
		// tab refocus - wiping checked/keys and flipping every settled indexing row back
		// to the grey "checking status" until the queue answered again. With the claim,
		// that reset fires only on a genuine project/platform switch; a refocus keeps
		// showing the last known state (green/yellow) and the re-poll that follows
		// replaces the snapshot atomically when its answer lands.
		this._liveIndexKey = this.getHistoryCacheKey();
		if (changed) this.host.notify();
	}

	/** Forget the snapshot: it describes ONE chat's queue, and the answer for the
	 *  project the user just switched to is unknown until it is asked for again. */
	private _resetLiveIndexKeys(): void {
		this.state.liveIndexKeys = {};
		this.state.liveIndexChecked = false;
		this._liveIndexAt = 0;
	}

	/**
	 * Ask the queue what is still indexing, once, for the chat that is on screen.
	 *
	 * Seeds the snapshot on a history load. Without it a reloaded chat has no way to
	 * learn that a run it can see is over: the adopt ladder that normally answers this
	 * only fires when a pass SETTLES, and after a reload there is no pass left to
	 * settle — so every finished worker-driven row would spin forever.
	 *
	 * Best-effort: a failure leaves `checked` false, which reads as "still working"
	 * rather than as a false all-clear.
	 *
	 * Delegates to the adopt ladder rather than asking once. A single empty look is
	 * exactly what that ladder exists to distrust — the worker writes pass N+1 a few
	 * milliseconds AFTER flipping pass N to resolved, so a query landing in that gap
	 * sees an empty queue for a chain that is very much alive. One look would turn
	 * that into a confident "Indexed" with a green check, on the one scenario this
	 * whole feature is for, and nothing would ever re-ask: the ladder is normally
	 * triggered by a pass SETTLING, and after a reload there is no pass left to
	 * settle. The ladder re-asks at 0/2s/6s, records each answer, and as a bonus
	 * adopts and polls any live pass it finds, which makes the row genuinely active
	 * instead of merely unconfirmed.
	 */
	refreshLiveIndexState(): void {
		// PASSIVE: this is the first-page/resume refresh, not a settle. One
		// fresh look (two status queries) always happens; the 2s/6s ladder
		// climb is reserved for when there is EVIDENCE of live work — the
		// pass-boundary gap the ladder exists for presumes a chain was alive,
		// and on an idle tab return the climb was three round trips of asking
		// a question whose answer had not changed.
		this._adoptWorkerIndexingPasses(0, true);
	}

	/** Forget what we know about which files are indexing — but ONLY when the
	 *  snapshot was taken for a different chat than the one on screen now. For a
	 *  consumer whose history loading is its own fork and so never reaches
	 *  loadHistory's reset — a snapshot describes ONE chat's queue, and carrying it
	 *  into another project would let a row there claim to be finished on someone
	 *  else's evidence.
	 *
	 *  Conditional for the same reason loadHistory's own reset is (the
	 *  `loadKey !== _liveIndexKey` gate): the view calls this on every mount, and
	 *  an unconditional wipe turned every re-entry to the chat into a grey
	 *  "Checking status:" sweep across rows whose state was already known. A
	 *  RE-entry keeps showing the last answer (green/yellow) while the first-page
	 *  refresh re-asks quietly; only a genuine project/platform switch starts from
	 *  "not known yet". Claiming `_liveIndexKey` here (before any answer) is the
	 *  same fudge loadHistory makes: it marks WHOSE chat the empty snapshot is
	 *  for, so repeated calls do not re-wipe, and _recordLiveIndexKeys re-claims
	 *  it when the real answer lands. */
	resetLiveIndexState(): void {
		var key = this.getHistoryCacheKey();
		if (key === this._liveIndexKey) return;
		this._liveIndexKey = key;
		this._resetLiveIndexKeys();
	}

	/** Wrap an indexing-request dispatch so awaitIndexingDrained counts it as
	 *  live work from the moment it is sent, not from the moment it is acked. */
	trackIndexDispatch<T>(p: Promise<T>): Promise<T> {
		var self = this;
		this._indexDispatchesInFlight += 1;
		// Deliberately does NOT nudge the drain when the count reaches zero. That
		// moment is a pass being ACCEPTED — new work ENTERING the queue — not work
		// ending. Nudging there pulled a waiting turn's two confirming looks into a
		// fixed ~4.5s window after the ack, which is inside the several seconds a
		// worker-minted pass can take to show up in the status index (the same
		// staleness WORKER_PASS_ADOPT_ATTEMPTS exists for). It turned a rare unlucky
		// alignment into a reliable one: the turn dispatched ahead of its own file's
		// remaining passes and the model answered from a partly-read file. There was
		// nothing to gain either — the pass it signals is work, so the pulled-forward
		// look can only report busy, or lie.
		var release = function () { self._indexDispatchesInFlight = Math.max(0, self._indexDispatchesInFlight - 1); };
		return p.then(function (v) { release(); return v; }, function (e) { release(); throw e; });
	}

	/**
	 * Something just happened that plausibly ENDED indexing work, so let any waiting
	 * turn look now instead of sitting out the rest of its busy interval.
	 *
	 * A nudge changes only WHEN a look happens, never what it concludes: the two
	 * agreeing idle looks, the confirm gap between them, "a failed look counts as
	 * busy" and the minimum wait are all untouched. That is why it is safe to fire
	 * from places that are merely good guesses.
	 *
	 * Fired from end-of-chain points ONLY: the adopt ladder giving up, a resume
	 * declining to continue, a pass failing. Not from every settling pass (one nudge
	 * per pass per file for the whole run), and not from an indexing request being
	 * accepted — see the note in trackIndexDispatch for why that one is actively
	 * harmful rather than merely wasteful.
	 */
	private _nudgeIndexingDrain(): void {
		if (!this._drainNudges.length) return;
		var list = this._drainNudges.slice(); // a nudge may de-register itself
		for (var i = 0; i < list.length; i++) {
			try { list[i](); } catch (e) { /* best-effort: never break the caller */ }
		}
	}

	/**
	 * Register a live poll so (a) a remount dedupes against it instead of stacking a
	 * SECOND poll on the same item, and (b) pausePolling can stop it.
	 *
	 * `stop` comes from the SDK and may be absent on an older skapi-js, in which case the
	 * poll simply cannot be stopped and is left running — see pausePolling.
	 *
	 * (This block documents _trackPoll, further down. The two methods below sit between it
	 * and its subject.)
	 */
	/**
	 * Foreground poll with an early-probe race.
	 *
	 * skapi's poll() is a bare setInterval(fn, latency) with NO check at t=0, so the earliest a
	 * reply can be observed is one full POLL_INTERVAL (3s) after dispatch. For a long generation
	 * that granularity is free. For a SHORT one it is nearly pure dead time: a greeting that the
	 * provider finishes in 1s still waits until the 3s tick, which measured as a large share of a
	 * 5s "yo" round trip.
	 *
	 * So keep the 3s interval as the steady state, and additionally point-look-up the item a few
	 * times early, on a widening schedule. Whichever answers first wins and the other is stopped.
	 * The probe uses the csrHistoryItemLookup hook both clients already implement; without it this
	 * degrades to exactly the old behaviour.
	 *
	 * FOREGROUND ONLY. Background indexing polls keep the flat cadence: nobody is watching them,
	 * and they are the ones bounded by MAX_CONCURRENT_BG_POLLS, so adding probes there would spend
	 * the request budget the cap exists to protect.
	 */
	attachForegroundPoll(source: any, itemId: string, opts?: any): any {
		return this._fgPollWithEarlyProbe(source, itemId, opts);
	}

	private _fgPollWithEarlyProbe(source: any, itemId: string, opts?: any): any {
		var self = this;
		// Callbacks ride along on the interval path exactly as before; the probe path below
		// fires onResponse itself, because a caller that only reacts through the callback
		// (the history drain does) would otherwise never learn the probe won.
		var base = source.poll(Object.assign({ latency: POLL_INTERVAL }, opts || {}));

		var lookup = chatEngineConfig().csrHistoryItemLookup;
		var ident = this.host.getIdentity();
		var platform = ident && ident.platform;
		if (!lookup || !itemId || !ident || !ident.projectId
			|| (platform !== 'claude' && platform !== 'openai')) {
			return base;
		}

		var settled = false;
		var timers: any[] = [];
		var clearProbes = function () {
			for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
			timers = [];
		};
		var stopBase = base && typeof base.stop === 'function' ? base.stop.bind(base) : null;

		var raced: any = new Promise(function (resolve, reject) {
			base.then(function (res: any) {
				if (settled) return;
				settled = true; clearProbes(); resolve(res);
			}, function (err: any) {
				if (settled) return;
				settled = true; clearProbes(); reject(err);
			});

			var fullId = buildHistoryItemFullId(platform as 'claude' | 'openai', ident.projectId, itemId);
			EARLY_PROBE_SCHEDULE_MS.forEach(function (delay) {
				timers.push(setTimeout(function () {
					if (settled) return;
					Promise.resolve(lookup!(fullId, ident.projectId, ident.owner)).then(function (body: any) {
						if (settled || !body || typeof body !== 'object') return;
						// Still working: leave it to the next probe or the interval.
						if (body.status === 'pending' || body.status === 'running') return;
						// A stop is not a result; the normal stop path handles that.
						if (isPollStopped(body)) return;
						settled = true;
						clearProbes();
						// The interval would otherwise keep firing against a finished item.
						if (stopBase) { try { stopBase(); } catch (e) { /* already gone */ } }
						if (opts && typeof opts.onResponse === 'function') {
							try { opts.onResponse(body); } catch (e) { /* caller's problem, not the poll's */ }
						}
						resolve(body);
					}, function () { /* probe failures are not errors: the interval is the source of truth */ });
				}, delay));
			});
		});

		// _trackPoll and the cancel path both reach for .stop, so the wrapper has to carry it.
		raced.stop = function () {
			settled = true;
			clearProbes();
			if (stopBase) stopBase();
		};
		return raced;
	}

	private _trackPoll(id: string, kind: 'fg' | 'bg', p: any): any {
		var stop = p && typeof p.stop === 'function' ? p.stop.bind(p) : undefined;
		if (!stop) {
			// The SDK could not give us a handle. Almost always means an older skapi-js
			// is loaded (or a stale bundler dep cache) — the poll will be unstoppable.
			console.debug('[chat-engine] poll has no stop handle', { id: id, kind: kind });
		}
		this.historyItemPolls.set(id, { kind: kind, stop: stop });
		return p;
	}

	/** Background polls currently attached, for the MAX_CONCURRENT_BG_POLLS budget.
	 *  Counts the registry rather than a separate tally so it cannot drift: every
	 *  attach goes through _trackPoll and every detach deletes the entry. Note an
	 *  entry left behind by pausePolling on an older skapi-js (no stop handle)
	 *  still counts, which is correct — that poll really is still running. */
	private _countBgPolls(): number {
		var n = 0;
		this.historyItemPolls.forEach(function (handle) {
			if (handle && handle.kind === 'bg') n++;
		});
		return n;
	}

	/**
	 * Stop and forget one item's poll. Used after a cancel: the row is either gone
	 * (cancelled while queued) or flagged cancelled (cancelled while running), so
	 * asking about it again only burns requests. Safe when no poll is attached, and
	 * safe on an older skapi-js with no stop handle (the entry is then LEFT in the
	 * map so a later drain cannot stack a second, unstoppable poll on the id).
	 */
	private _stopPoll(id: string): void {
		var handle = this.historyItemPolls.get(id);
		if (!handle) return;
		if (typeof handle.stop !== 'function') return;
		try { handle.stop(); } catch (e) { /* best effort */ }
		this.historyItemPolls.delete(id);
	}

	/** True while any pause reason is active. */
	isPollingPaused(): boolean {
		return this._pauseReasons.size > 0;
	}

	/**
	 * Stop BACKGROUND polling until resumePolling. Foreground polls (a reply the user is
	 * waiting on) keep running deliberately: their results must still land in the history
	 * cache so resumePendingRequest can render them on return, otherwise a user who sends
	 * a message then navigates away comes back to a permanently stuck "Thinking...".
	 *
	 * Server-side work is untouched; this only stops asking about it. That is safe for
	 * document indexing because the worker drives that loop itself.
	 */
	pausePolling(reason: string): void {
		this._pauseReasons.add(reason || 'paused');
		var self = this;
		var stopped: string[] = [];
		this.historyItemPolls.forEach(function (handle, id) {
			if (!handle || handle.kind !== 'bg') return;
			// No stop available (older SDK): LEAVE the entry in place. Deleting it would
			// let a later drain attach a second, uncancellable poll on the same item.
			if (typeof handle.stop !== 'function') return;
			try { handle.stop(); } catch (e) { /* best effort */ }
			stopped.push(id);
		});
		// Delete only what we actually stopped, one at a time. NEVER clear() the map:
		// wholesale clearing is what previously let loadHistory attach a duplicate poll
		// on a live item, producing duplicate replies and stranded "Thinking" bubbles.
		stopped.forEach(function (id) { self.historyItemPolls.delete(id); });

	}

	/**
	 * Lift a pause reason WITHOUT running the reconcile. For a caller that is about to
	 * reload history anyway (a view remounting), letting resumePolling also reconcile
	 * would race that load and can double-attach.
	 */
	clearPauseReason(reason: string): void {
		this._pauseReasons.delete(reason || 'paused');
	}

	/**
	 * Clear a pause reason and, once none remain, re-attach polling and reconcile.
	 * Deliberately does NOT touch gateRefreshToken: bumping it would silently discard
	 * the results of anything still in flight across the pause.
	 */
	resumePolling(reason: string): Promise<void> {
		this._pauseReasons.delete(reason || 'paused');
		if (this._pauseReasons.size > 0 || this._resuming) return Promise.resolve();
		if (!this.host.isViewMounted || !this.host.isViewMounted()) return Promise.resolve();
		var self = this;
		this._resuming = true;
		return Promise.resolve()
			.then(function () {
				self.drainBgTaskQueue();
				return self.loadHistory(false, self.state.gateRefreshToken);
			})
			.catch(function (e: any) { console.error('[chat-engine] resume polling failed', e); })
			.then(function () { self._resuming = false; });
	}

	private _newLocalId(): string {
		this._lidSeq += 1;
		return 'lid_' + this._lidSeq;
	}

	getHistoryCacheKey(): string {
		var id = this.host.getIdentity();
		if (!id.projectId || id.platform === 'none') return '';
		return id.projectId + '#' + id.platform;
	}

	// ─── compact-stub hydration ─────────────────────────────────────────────
	// Split-fetch bg pages arrive as label stubs (no bodies). When the user
	// expands a row, the real reply text is fetched per item (csr-poll point
	// lookup) and MEMOIZED per chat: every later remap (first-page refresh,
	// queue-detect tick, cache restore) re-applies the memo, so a hydrated
	// bubble can never silently revert to its 200-char head.
	private _hydratedBodies: { [chatKey: string]: { [itemId: string]: string } } = {};
	private _hydratingItems: { [key: string]: boolean } = {};

	/** Re-apply memoized hydrated texts onto freshly-mapped messages. Both
	 *  clients call this right after their mapper runs (loadHistory does it
	 *  internally); it mutates the given array's items in place. */
	applyHydratedBodies(messages: ChatMessage[]): void {
		var key = this.getHistoryCacheKey();
		var memo = key ? this._hydratedBodies[key] : null;
		if (!memo) return;
		var id = this.host.getIdentity();
		for (var i = 0; i < messages.length; i++) {
			var m: any = messages[i];
			if (!m || !m._compact || m.role !== 'assistant' || !m._serverItemId) continue;
			var text = memo[m._serverItemId];
			if (typeof text !== 'string') continue;
			m.content = sanitizeAttachmentLinksForHistory(text, id.projectId, true) || EMPTY_INDEXING_REPLY;
			delete m._compact;
		}
	}

	/** Fetch the real response bodies for compact history stubs (one csr-poll
	 *  point lookup per item id), memoize, and swap them into the live list.
	 *  Best-effort: a failed lookup leaves the stub (its head + fallback line
	 *  still render) and a later expand retries. */
	hydrateCompactItems(itemIds: string[]): Promise<void> {
		var self = this;
		var lookup = chatEngineConfig().csrHistoryItemLookup;
		if (!lookup || !itemIds || !itemIds.length) return Promise.resolve();
		var id = this.host.getIdentity();
		var platform = id.platform;
		if (!id.projectId || (platform !== 'claude' && platform !== 'openai')) return Promise.resolve();
		var chatKey = this.getHistoryCacheKey();
		if (!chatKey) return Promise.resolve();
		var jobs = itemIds.map(function (itemId) {
			if (!itemId) return Promise.resolve();
			var already = self._hydratedBodies[chatKey] && self._hydratedBodies[chatKey][itemId] !== undefined;
			var inflightKey = chatKey + '|' + itemId;
			if (already || self._hydratingItems[inflightKey]) return Promise.resolve();
			self._hydratingItems[inflightKey] = true;
			return Promise.resolve(lookup(buildHistoryItemFullId(platform as 'claude' | 'openai', id.projectId, itemId), id.projectId, id.owner)).then(function (body: any) {
				// Chat may have switched while the lookup flew; the memo is
				// per-chat so record under the key we started with, and only
				// touch the live list if it is still that chat's.
				var text = ((platform === 'openai' ? extractOpenAIText(body) : extractClaudeText(body)) || '').trim();
				if (text.indexOf(INDEXING_COMPLETE_MARKER) !== -1) text = text.split(INDEXING_COMPLETE_MARKER).join('').trim();
				if (!self._hydratedBodies[chatKey]) self._hydratedBodies[chatKey] = {};
				self._hydratedBodies[chatKey][itemId] = text;
				if (self.getHistoryCacheKey() !== chatKey) return;
				for (var i = 0; i < self.state.messages.length; i++) {
					var m: any = self.state.messages[i];
					if (m && m._compact && m.role === 'assistant' && m._serverItemId === itemId) {
						m.content = sanitizeAttachmentLinksForHistory(text, id.projectId, true) || EMPTY_INDEXING_REPLY;
						delete m._compact;
					}
				}
			}).catch(function () { /* stub stays; expand retries */ }).then(function () {
				delete self._hydratingItems[inflightKey];
			});
		});
		return Promise.all(jobs).then(function () {
			if (self.getHistoryCacheKey() !== chatKey) return;
			self.host.notify();
			self.updateHistoryCache();
		});
	}

	updateHistoryCache(): void {
		var key = this.getHistoryCacheKey();
		if (!key) return;
		// Never persist another chat's in-flight bubbles under THIS key. The
		// dashboard shares one ChatSession across projects, so a turn dispatched
		// in project A can still be sitting in state.messages while the identity
		// (and therefore `key`) already points at project B — without this filter
		// A's user + "Thinking..." bubbles get written into B's cache entry and
		// replay on every later visit to B. Bubbles with no _ownerKey (server
		// history, bg tasks) are always kept. Single pass: this runs on the
		// typewriter hot path.
		//
		// Staged bubbles (_stageId) ARE cached, deliberately. They used to be dropped
		// on the theory that a reload kills the upload but not the cache, leaving a
		// message that uploads forever — but this cache is an in-memory field on a
		// singleton created at module load, so a reload takes it and the upload chain
		// together and that state is unreachable. What dropping them DID cost was
		// real: state.messages is shared across projects, so both clients filter it by
		// _ownerKey on every chat switch, and with no cached copy the bubble was
		// destroyed outright. A user who sent a question with a file and then looked at
		// another project lost the question for the whole indexing wait and got it back
		// at the bottom minutes later.
		//
		// isLiveStage + settleDeadStagedMessages keep the original concern honest if
		// this cache is ever persisted: a restored stage whose upload no longer exists
		// settles into a plain message instead of uploading forever.
		this.aiChatHistoryCache[key] = {
			messages: this.state.messages.filter(function (m) {
				return m._ownerKey === undefined || m._ownerKey === key;
			}),
			endOfList: this.state.historyEndOfList,
			startKeyHistory: this.state.historyStartKeyHistory.slice(),
		};
	}

	/**
	 * Give the immediate-send pair the server's id for their turn, the moment the
	 * dispatch learns it.
	 *
	 * WHY THIS EXISTS. An immediate send pushes its user bubble and its
	 * "Thinking..." placeholder locally, and until now neither ever carried a
	 * _serverItemId — only the QUEUED path stamped one, off its ack. So for the
	 * whole life of the turn there was no way to tell the local copy and the
	 * server's copy of the SAME turn apart, and the history merge fell back to a
	 * heuristic: rescue the local pair unless the freshly-fetched page happens to
	 * contain a pending assistant.
	 *
	 * That heuristic has a hole exactly one poll interval wide. The server settles
	 * the request; for up to POLL_INTERVAL the client has not noticed, so
	 * `state.sending` is still true and the local pair is still on screen — while a
	 * history fetch issued in that window returns the turn ALREADY SETTLED, with no
	 * pending assistant in it. The rescue then re-appends the local pair below the
	 * server's copy (the question, twice), and when the poll finally resolves,
	 * typewriteLatestReply writes the answer into the rescued placeholder because it
	 * is the only pending assistant left (the answer, twice). updateHistoryCache
	 * persists the result, so it survives every later visit.
	 *
	 * Navigating away while waiting and coming back is what lands a fetch in that
	 * window: a remount runs refreshGate -> a fresh first page, at an arbitrary
	 * moment relative to the 3s poll.
	 *
	 * With the id on the bubbles, both clients' rescue loops skip them through the
	 * dedup they already have (`_serverItemId is in this page`), the reply the
	 * dispatch caches inherits the id too, and nothing needs a new special case.
	 *
	 * Matched by _localId, never by index: a file's indexing rows are spliced in
	 * above these bubbles while the request is in flight.
	 */
	private _stampTurnWithItemId(key: string, userLid: string | undefined, placeholderLid: string | undefined, itemId: string): void {
		// placeholderLid is undefined for a QUEUED send: that path has no
		// "Thinking..." bubble of its own until promoteNextQueuedToRunning makes one,
		// and that copies the user bubble's id itself.
		if (!itemId) return;
		var changed = false;
		var stamp = function (list: ChatMessage[]) {
			var hit = false;
			for (var i = 0; i < list.length; i++) {
				var m = list[i];
				if (!m || !m._localId) continue;
				if (m._localId !== userLid && m._localId !== placeholderLid) continue;
				if (m._serverItemId === itemId) continue;
				list[i] = Object.assign({}, m, { _serverItemId: itemId });
				hit = true;
			}
			return hit;
		};
		changed = stamp(this.state.messages);
		// And in the cache, which is what a remount renders BEFORE the fetch lands.
		// A cached copy still missing the id would be rescued by the very merge this
		// is here to satisfy.
		var cached = key ? this.aiChatHistoryCache[key] : undefined;
		if (cached) {
			var msgs = cached.messages.slice();
			if (stamp(msgs)) {
				this.aiChatHistoryCache[key] = {
					messages: msgs, endOfList: cached.endOfList, startKeyHistory: cached.startKeyHistory,
				};
			}
		}
		if (changed) this.host.notify();
	}

	/**
	 * Land a resolved reply in the history cache of a chat that is NOT currently
	 * visible, without touching state.messages. Mirrors the cache-only path in
	 * dispatchAgentRequest: REPLACE the trailing pending "Thinking..." bubble
	 * (append only when there is none), and settle the matching pending user
	 * bubble, so the cached copy never keeps a stuck "Thinking..." that a later
	 * cache-first load would re-render forever.
	 */
	private _applyReplyToCache(key: string, reply: ChatMessage, serverId?: string): void {
		if (!key) return;
		var existing = this.aiChatHistoryCache[key] || { messages: [], endOfList: false, startKeyHistory: [] };
		var msgs = existing.messages.slice();

		var thIdx = -1;
		for (var i = msgs.length - 1; i >= 0; i--) {
			var m = msgs[i];
			if (!m || !m.isPending || m.role !== 'assistant' || m.isBackgroundTask) continue;
			if (serverId && m._serverItemId && m._serverItemId !== serverId) continue;
			thIdx = i; break;
		}
		if (thIdx !== -1) {
			if (reply._serverItemId === undefined && msgs[thIdx]._serverItemId !== undefined) reply._serverItemId = msgs[thIdx]._serverItemId;
			msgs[thIdx] = reply;
		} else {
			// No pending placeholder left to replace. Before appending, check whether
			// this turn is ALREADY in the cache — a history fetch may have mapped the
			// resolved turn in while the reply was in flight. Appending blindly is how
			// one turn ended up rendered twice (the duplicated question+answer): the
			// cache is restored verbatim on the next mount, so a duplicate written
			// here survives every later visit.
			var dupIdx = -1;
			if (serverId) {
				for (var d = msgs.length - 1; d >= 0; d--) {
					var dm = msgs[d];
					if (dm && dm.role === 'assistant' && dm._serverItemId === serverId) { dupIdx = d; break; }
				}
			}
			if (dupIdx !== -1) msgs[dupIdx] = reply;
			else msgs.push(reply);
		}

		// Settle the user bubble this turn belongs to (first pending one, or the
		// one carrying serverId) so it stops rendering as still in flight.
		for (var j = 0; j < msgs.length; j++) {
			var u = msgs[j];
			if (!u || u.role !== 'user' || u.isBackgroundTask) continue;
			// A STAGED bubble matches this shape exactly — pending, no server id, so the
			// id test below cannot rule it out — and sits EARLIER in the list than the
			// turn actually resolving. Settling it would strip its _stageId and its
			// upload state, silently killing a turn whose files are still going up.
			if (u._stageId) continue;
			if (!(u.isPendingQueued || u.isPendingInProcess || u.isSendingToServer)) continue;
			if (serverId && u._serverItemId && u._serverItemId !== serverId) continue;
			var settled: ChatMessage = { role: 'user', content: u.content };
			if (u._serverItemId !== undefined) settled._serverItemId = u._serverItemId;
			if (u._ownerKey !== undefined) settled._ownerKey = u._ownerKey;
			msgs[j] = settled;
			break;
		}

		this.aiChatHistoryCache[key] = {
			messages: msgs,
			endOfList: existing.endOfList,
			startKeyHistory: existing.startKeyHistory,
		};
	}

	/**
	 * projectId/owner are passed explicitly by every caller: a request can be
	 * dispatched after the user moved to another project, and re-reading the live
	 * identity here would silently send the turn to THAT project instead of the
	 * one it was composed for. Falls back to the live read only when a caller
	 * omits them.
	 */
	private _callProviderFor(platform: string, prompt: string, messages: any, system: string, model: string | undefined, userId: string, extractContent: any, fileUrls?: any, projectId?: string, owner?: string) {
		if (projectId === undefined || owner === undefined) {
			var id = this.host.getIdentity();
			if (projectId === undefined) projectId = id.projectId;
			if (owner === undefined) owner = id.owner;
		}
		return platform === 'openai'
			? callOpenAIWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls)
			: callClaudeWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls);
	}

	dispatchAgentRequest(params: any) {
		var self = this;
		// Id of the in-flight item this dispatch polls. Recorded in
		// historyItemPolls (set below, deleted when the dispatch settles) so a
		// remount / history refetch dedups against THIS poll instead of stacking
		// a duplicate history poll on the same item. (The cacheKey guard alone
		// stops covering an item once pendingAgentRequests clears — e.g. a queued
		// message still in flight after the immediate one resolved.)
		var dispatchItemId: string | undefined;
		var sendAndPoll = function () {
			return Promise.resolve(
				self._callProviderFor(params.aiPlatform, params.text, params.boundedMessages, params.systemPrompt, params.aiModel, params.userId, params.extractContent, params.fileUrls, params.projectId, params.owner)
			).then(function (initial: any) {
				if (initial && initial.poll && (initial.status === 'pending' || initial.status === 'running')) {
					if (initial.id) {
						if (dispatchItemId && dispatchItemId !== initial.id) self.historyItemPolls.delete(dispatchItemId);
						dispatchItemId = initial.id;
						// Hand the id to the caller so the bubbles already on screen can
						// carry it. An auth-refresh retry re-enters here with a NEW id,
						// so this reports every time, not once.
						if (typeof params.onItemId === 'function') params.onItemId(initial.id);
					}
					var dp = self._fgPollWithEarlyProbe(initial, initial.id);
					if (initial.id) self._trackPoll(initial.id, 'fg', dp);
					return dp;
				}
				return initial;
			});
		};
		var run = sendAndPoll()
			.catch(function (err: any) {
				// Only auth-expiry is worth a refresh+resend; a malformed-request 400
				// (e.g. the `_skapi_extract`/unknown-parameter class) re-fails identically,
				// so never loop on it — guard against isAuthExpiredError's heuristic
				// misfiring on a param name that merely contains "token".
				if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(sendAndPoll);
				throw err;
			})
			.then(function (response: any) {
				if (isErrorResponseBody(response) && isAuthExpiredError(response) && !isNonRetryableRequestError(response)) {
					return self.host.refreshSession().then(sendAndPoll);
				}
				return response;
			})
			.then(function (response: any) {
				if (isErrorResponseBody(response)) return { content: getErrorMessage(response), isError: true };
				var answer = (params.aiPlatform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response));
				answer = (answer || '').trim();
				return { content: answer || 'No text response received from AI provider.', isError: false };
			})
			.catch(function (err: any) { return { content: getErrorMessage(err), isError: true }; })
			.then(function (result: any) {
				// Land the resolved reply in the shared history cache. This runs
				// independently of the view lifecycle, so a reply is captured even
				// if the chatbox unmounted mid-request.
				delete self.pendingAgentRequests[params.key];
				if (dispatchItemId) self.historyItemPolls.delete(dispatchItemId);
				var reply: ChatMessage = { role: 'assistant', content: result.content, isError: result.isError };
				if (dispatchItemId) reply._serverItemId = dispatchItemId;

				// REPLACE the trailing pending "Thinking..." bubble in the cache with
				// the answer, regardless of whether this chat is the currently-visible
				// view. The cache must NEVER retain a pending "Thinking..." bubble: even
				// when the chatbox is showing this chat, typewriteLatestReply swaps the
				// bubble only in state.messages and NEVER re-snapshots the cache — so
				// leaving a pending copy here would have a later cache-first remount
				// re-render that "Thinking..." forever. typewriteLatestReply still finds
				// this reply (it reads the latest non-pending assistant from the cache),
				// so replacing is correct for the visible case too.
				//
				// _applyReplyToCache rather than an inline copy of it. This used to be
				// its own loop with the same replace-or-append shape MINUS the
				// dedup-before-append its twin already had, and the append is reachable:
				// once the local pair carries its server id (_stampTurnWithItemId), a
				// first-page fetch that lands after the server settles the item
				// correctly drops both local copies and re-snapshots a cache with no
				// pending placeholder left to replace. The blind push then wrote the
				// answer in a SECOND time, with no id on it, and the cache is rendered
				// verbatim on the next mount — so the fix that stopped the turn
				// duplicating on screen would have moved the duplicate into the cache.
				self._applyReplyToCache(params.key, reply, dispatchItemId);
				return result;
			});
		this.pendingAgentRequests[params.key] = run;
		return run;
	}

	/**
	 * Put a turn on screen the INSTANT the user hits Send, before its attachments
	 * have finished uploading. Uploads run in the background now (the composer is
	 * cleared and stays usable), so without a staged bubble the message would
	 * appear only once its files were up — below anything the user sent in the
	 * meantime, in an order that never matches what they typed.
	 *
	 * Staged bubbles carry _useBgQueue because that is where a turn with
	 * attachments ultimately dispatches (behind its own indexing tasks). That flag
	 * is also what keeps promoteNextQueuedToRunning / resolveQueuedUserBubble off
	 * them: those advance the SERVER queue, and a staged turn has no server
	 * request behind it yet.
	 *
	 * Returns the id to hand back as PinnedDispatchContext.stageId at dispatch.
	 */
	stageOutgoingMessage(displayText: string): string {
		this._stageSeq += 1;
		var stageId = 'stg_' + this._stageSeq;
		var key = this.getHistoryCacheKey();
		var staged: ChatMessage = {
			role: 'user', content: displayText,
			isPendingQueued: true, isUploadingAttachments: true, isSendingToServer: true,
			_dimSending: true,
			// A staged bubble has no server id for minutes, and its indexing rows are
			// now inserted ABOVE it — so its array index moves. Both views fall back to
			// the index when a bubble has no id, which would re-key (and in Vue, remount)
			// this bubble on every file, restarting its transition and losing it as a
			// scroll anchor. A local id it keeps for its whole life fixes both.
			_localId: this._newLocalId(),
			_useBgQueue: true, _stageId: stageId, _ts: wallClockNow(),
		};
		if (key) staged._ownerKey = key;
		this._liveStages[stageId] = true;
		this.state.messages.push(staged);
		this.host.notify(); this.host.scrollToBottom(true);
		return stageId;
	}

	/** Is anything in this page still uploading/dispatching for this stage? */
	isLiveStage(stageId?: string): boolean {
		return !!stageId && !!this._liveStages[stageId];
	}

	/**
	 * Settle any staged bubble in `list` whose chain no longer exists, and return the
	 * list (a new array only if something changed).
	 *
	 * The caller is a cache restore. A staged bubble is the one kind of message whose
	 * resolution lives entirely in page memory — no server request stands behind it
	 * yet — so a copy that outlives its upload would render "(Uploading files...)"
	 * forever with nothing left to finish it. Today nothing can: this cache dies with
	 * the page, so every restored stage is still live and this is a no-op. It exists
	 * so that stops being a silent assumption.
	 */
	settleDeadStagedMessages(list: ChatMessage[]): ChatMessage[] {
		if (!Array.isArray(list)) return list;
		var self = this;
		var dead = false;
		for (var i = 0; i < list.length; i++) {
			var m = list[i];
			if (m && m._stageId && !self._liveStages[m._stageId]) { dead = true; break; }
		}
		if (!dead) return list;
		return list.map(function (m) {
			if (!m || !m._stageId || self._liveStages[m._stageId]) return m;
			var settled: ChatMessage = { role: 'user', content: m.content };
			if (m._ownerKey !== undefined) settled._ownerKey = m._ownerKey;
			if (m._ts !== undefined) settled._ts = m._ts;
			if (m._localId !== undefined) settled._localId = m._localId;
			return settled;
		});
	}

	private _stageIndex(list: ChatMessage[], stageId?: string): number {
		if (!stageId) return -1;
		for (var i = 0; i < list.length; i++) {
			if (list[i] && list[i]._stageId === stageId) return i;
		}
		return -1;
	}

	/**
	 * Staged turn, phase 2: its files are up and it is now waiting for the whole
	 * indexing chain behind them. Swaps "(Uploading files...)" for
	 * "(Indexing files...)"; the bubble stays dimmed, because from the user's side
	 * nothing has been handed over yet.
	 *
	 * It deliberately does NOT say "(In queue)" here. The turn is not queued behind
	 * anything the server knows about yet — it is waiting on work that can run for
	 * minutes — and claiming otherwise is what made the wait look like a stall.
	 */
	markStagedMessageIndexing(stageId: string): void {
		var idx = this._stageIndex(this.state.messages, stageId);
		if (idx === -1) return;
		var ex = this.state.messages[idx];
		if (!ex.isUploadingAttachments) return;
		this.state.messages[idx] = Object.assign({}, ex, {
			isUploadingAttachments: false, isAwaitingIndexing: true,
		});
		this.host.notify();
	}

	/**
	 * Staged turn, phase 3: the last of its files has finished indexing, so the turn
	 * is genuinely just queued now. Full opacity + "(In queue)".
	 *
	 * Clears the PRESENTATIONAL _dimSending only; isSendingToServer stays set until
	 * the server actually acks (it is the token that ack matches on). Called by the
	 * clients the instant awaitIndexingDrained resolves, i.e. immediately before the
	 * dispatch that replaces this bubble — dispatchComposedMessage carries the
	 * cleared flag onto the replacement so the turn does not blink back to dimmed.
	 */
	markStagedMessageReady(stageId: string): void {
		var idx = this._stageIndex(this.state.messages, stageId);
		if (idx === -1) return;
		var ex = this.state.messages[idx];
		if (!ex.isAwaitingIndexing && !ex._dimSending && !ex.isUploadingAttachments) return;
		this.state.messages[idx] = Object.assign({}, ex, {
			isUploadingAttachments: false, isAwaitingIndexing: false, _dimSending: false,
		});
		this.host.notify();
	}

	/**
	 * Resolves once this project's background-indexing queue has nothing left to
	 * run, so a chat enqueued right after it is genuinely last.
	 *
	 * Sending the chat as soon as the uploads finish is not enough, which is the
	 * whole reason this exists: indexing a file is a CHAIN, and each pass is only
	 * enqueued once the previous one lands (the client mints CONTINUE passes for
	 * text/grid files, the worker mints them for PDFs and windowed reads). Every
	 * one of those passes therefore queues up BEHIND a chat sent at upload time,
	 * and the model answers from a file it has only partly read.
	 *
	 * The queue is read from the server's status index rather than from
	 * bgTaskQueue: that mirror holds only what this client dispatched or adopted,
	 * and it stops being maintained once the view unmounts. An empty answer has to
	 * repeat before it is believed — see INDEXING_DRAIN_IDLE_LOOKS — and a look
	 * that fails counts as busy, so a dropped request delays the turn instead of
	 * releasing it early.
	 *
	 * Reads the identity PINNED at Send time, never a live one: the user may be in
	 * another project by now, and this must keep asking about the one they sent
	 * from.
	 */
	awaitIndexingDrained(identity: ChatIdentity): Promise<'drained' | 'timedout' | 'skipped'> {
		var self = this;
		var svcId = identity && identity.projectId;
		var platform = identity && identity.platform;
		if (!svcId || (platform !== 'claude' && platform !== 'openai')) return Promise.resolve('skipped' as const);
		var owner = identity.owner;
		var queue = bgIndexingQueueName(identity.userId, svcId);
		var startedAt = nowMs();
		var deadline = startedAt + INDEXING_DRAIN_TIMEOUT_MS;
		var idleLooks = 0;
		// null = "could not find out", which the loop below counts as busy. The race
		// is what makes the timeout necessary rather than tidy: a getChatHistory that
		// never settles leaves no pending timer behind, so the whole wait — and the
		// turn, and its bubble — would hang on it indefinitely.
		var ask = function (status: 'pending' | 'running') {
			var answered = false;
			return new Promise<any>(function (res) {
				var bail: any = null;
				var settle = function (v: any) {
					if (answered) return;
					answered = true;
					if (bail) { clearTimeout(bail); bail = null; }
					res(v);
				};
				bail = setTimeout(function () { settle(null); }, INDEXING_DRAIN_LOOK_TIMEOUT_MS);
				// maxAgeMs 0: this loop is WAITING for the queue to change, so a
				// cached answer is useless to it — but its fresh answers write
				// through into the shared probe memo for the snapshot readers.
				Promise.resolve(probeBgQueue(
					{ service: svcId, owner: owner, platform: platform as 'claude' | 'openai', queue: queue, status: status, limit: WORKER_PASS_ADOPT_LIMIT },
					{ maxAgeMs: 0 },
				)).then(function (entry: any) { settle(entry.result); }, function () { settle(null); });
			});
		};
		// Ordinary chats are routed onto this queue too (_isOnBgQueue), and those
		// are not work this turn has to wait behind — the server runs the queue in
		// order, so being enqueued after them is enough.
		var hasLiveIndexing = function (res: any): boolean {
			var list = res && Array.isArray(res.list) ? res.list : [];
			for (var i = 0; i < list.length; i++) {
				var item = list[i];
				if (!item || (item.status !== 'pending' && item.status !== 'running')) continue;
				if (isIndexingRequestText(extractLastUserTextFromRequest(item.request_body))) return true;
			}
			return false;
		};
		return new Promise(function (resolve) {
			var timer: any = null;
			var lastLookAt = -Infinity;
			var nudgedThisInterval = false;
			// A look's queries are OUT. Nothing may start a second one alongside it:
			// two overlapping looks share idleLooks, so both coming back idle would
			// count as the two agreeing looks WITHOUT the confirm gap between them —
			// the one guard that stands between the user and an answer computed from a
			// half-indexed file.
			var inFlight = false;
			var finish = function (v: 'drained' | 'timedout') {
				if (timer) { clearTimeout(timer); timer = null; }
				// De-register on BOTH exits or the waiter leaks a closure per send, and
				// a later settle re-arms a timer for a turn that has already gone out.
				var ni = self._drainNudges.indexOf(nudge);
				if (ni !== -1) self._drainNudges.splice(ni, 1);
				resolve(v);
			};
			var again = function (ms?: number) {
				if (timer) { clearTimeout(timer); timer = null; }
				var wait = ms == null ? (idleLooks > 0 ? INDEXING_DRAIN_CONFIRM_POLL_MS : INDEXING_DRAIN_BUSY_POLL_MS) : ms;
				timer = setTimeout(look, wait);
			};
			// Indexing just ended somewhere (see _nudgeIndexingDrain): ask now rather
			// than waiting out the rest of the busy interval, which is what made the
			// turn sit dimmed for another ten seconds after its files were visibly done.
			var nudge = function () {
				// Already on the confirm cadence — the two agreeing looks and the gap
				// between them are the guard, and pulling the second one forward is
				// exactly what must not happen.
				if (idleLooks > 0) return;
				if (inFlight) return; // a look is already asking; nothing to pull forward
				if (nudgedThisInterval) return; // one pull-forward per interval
				// A look now would short-circuit on this anyway. Nothing re-fires when
				// the count reaches zero, deliberately (see trackIndexDispatch): the
				// cost is up to one busy interval of extra dim, and the alternative is
				// a nudge fired by work STARTING, which can release a turn early.
				if (self._indexDispatchesInFlight > 0) return;
				nudgedThisInterval = true;
				again(Math.max(0, INDEXING_DRAIN_NUDGE_MIN_GAP_MS - (nowMs() - lastLookAt)));
			};
			var look = function () {
				timer = null;
				// Belt to the nudge's brace: never two sets of queries out at once.
				if (inFlight) return;
				lastLookAt = nowMs(); nudgedThisInterval = false;
				if (nowMs() >= deadline) { finish('timedout'); return; }
				// A pass whose ack is still in flight is not on the queue yet, so no
				// look can see it.
				if (self._indexDispatchesInFlight > 0) { idleLooks = 0; again(); return; }
				inFlight = true;
				Promise.all([ask('running'), ask('pending')]).then(function (res: any[]) {
					inFlight = false;
					var unknown = res[0] === null || res[1] === null;
					if (unknown || hasLiveIndexing(res[0]) || hasLiveIndexing(res[1])) idleLooks = 0;
					else idleLooks += 1;
					if (idleLooks >= INDEXING_DRAIN_IDLE_LOOKS && nowMs() - startedAt >= INDEXING_DRAIN_MIN_MS) {
						finish('drained'); return;
					}
					again();
				}, function () { inFlight = false; idleLooks = 0; again(); });
			};
			self._drainNudges.push(nudge);
			look();
		});
	}

	/**
	 * Abandon a staged turn — its uploads failed outright, so nothing will be
	 * dispatched. The bubble stays (the user's text is not silently thrown away)
	 * but settles into a plain, non-pending message; the caller reports the
	 * failure separately.
	 */
	settleStagedMessage(stageId: string): void {
		// Retired even when the bubble is not on screen (another project is): the
		// chain is over either way, and a cached copy must not read as still working.
		delete this._liveStages[stageId];
		var idx = this._stageIndex(this.state.messages, stageId);
		if (idx === -1) return;
		var ex = this.state.messages[idx];
		var settled: ChatMessage = { role: 'user', content: ex.content };
		if (ex._ownerKey !== undefined) settled._ownerKey = ex._ownerKey;
		if (ex._ts !== undefined) settled._ts = ex._ts;
		// Same key across the settle: it has no server id and never will.
		if (ex._localId !== undefined) settled._localId = ex._localId;
		this.state.messages[idx] = settled;
		this.host.notify(); this.updateHistoryCache();
	}

	// composed = clean display text; composedForLlm carries office-extraction
	// placeholders for the provider only. useBgQueue routes a post-attachment turn
	// onto the "-bg" queue so it runs after indexing.
	dispatchComposedMessage(composed: string, useBgQueue?: boolean, composedForLlm?: string, extractContent?: any, fileUrls?: any, pinned?: PinnedDispatchContext): void {
		var self = this;
		// This turn may already have a bubble on screen, staged at Send time while
		// its attachments uploaded. Every exit from here has to account for it:
		// dispatching replaces it in place (so it keeps the position the user sent
		// it in), and bailing settles it (so it never sits uploading forever).
		var stageId = pinned ? pinned.stageId : undefined;
		if (!composed) { if (stageId) this.settleStagedMessage(stageId); return; }
		// A send can be dispatched LONG after the user hit Send (attachment
		// uploads are awaited first), by which time the live identity may have
		// moved to another project. The caller pins the identity + system prompt
		// it captured at Send time so the request still goes to the project the
		// question was actually asked of. Falls back to the live read when the
		// caller doesn't pin (the widget, which has only one project anyway).
		var id = pinned ? pinned.identity : this.host.getIdentity();
		if (id.platform === 'none') { if (stageId) this.settleStagedMessage(stageId); return; }
		// Past every bail: this turn is going out, so its stage is over whichever
		// branch below takes it, and whether or not the bubble is still on screen.
		if (stageId) delete this._liveStages[stageId];

		var llmComposed = composedForLlm || composed;

		// Cache key of the chat this turn belongs to. Every locally-created
		// bubble is stamped with it so a project switch (which flips
		// getIdentity()/getHistoryCacheKey() to the new project) can't
		// misattribute this turn's bubbles to that project.
		// (platform === 'none' already returned above, so projectId is the only gate)
		var key = !id.projectId ? '' : id.projectId + '#' + id.platform;
		// True when the pinned chat is NOT the one currently on screen. Then
		// state.messages belongs to a different project and MUST NOT be touched:
		// the turn is staged in the pinned chat's cache instead and shows up when
		// the user navigates back to it.
		var offChat = !!key && key !== this.getHistoryCacheKey();

		var isQueuedSend = !offChat && (useBgQueue || this.state.sending || this.state.messages.some(function (m) {
			return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue;
		}));

		var aiPlatform = id.platform;
		var aiModel = id.model || undefined;
		var systemPrompt = pinned ? pinned.systemPrompt : this.host.buildSystemPrompt();
		var userId = id.userId || id.projectId;
		// Same string the indexing passes are enqueued under (bgIndexingQueueName),
		// which is the whole reason this turn ends up behind them: the backend runs
		// different queue names in parallel and only serialises a shared one.
		var chatQueue = useBgQueue ? bgIndexingQueueName(userId) : userId;
		// _stageIndex is -1 when nothing was staged, or when the staged bubble is
		// gone (a remount rebuilds the list from the cache, which never holds staged
		// bubbles); either way the branches below fall back to appending.

		if (offChat) {
			// Stage the turn in the pinned chat's cache and dispatch. The
			// client-side queue can't be consulted (its state is the other
			// project's), but the SERVER serializes per queue name, so ordering
			// within the pinned chat still holds. dispatchAgentRequest replaces
			// the pending bubble in this same cache entry when the reply lands.
			var offHistory = (this.aiChatHistoryCache[key] ? this.aiChatHistoryCache[key].messages : []).filter(function (m) {
				return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder &&
					!m.isCancelled && !m.isBackgroundTask && !m.isError;
			});
			var offBounded = buildBoundedChatMessages({
				platform: aiPlatform, model: aiModel, systemPrompt: systemPrompt, projectId: id.projectId,
				history: offHistory.concat([{ role: 'user', content: llmComposed }]),
			});
			var offExisting = this.aiChatHistoryCache[key] || { messages: [], endOfList: false, startKeyHistory: [] };
			var offUser: ChatMessage = { role: 'user', content: composed, _ownerKey: key, _ts: wallClockNow() };
			// The user hit Send here, then navigated away before the uploads
			// finished. The staged bubble belongs to THAT chat, not the one now on
			// screen, and the turn it stood in for is being cached below — so drop
			// it from the live list instead of leaving a bubble that uploads
			// forever in a project it does not belong to.
			var offStage = this._stageIndex(this.state.messages, stageId);
			if (offStage !== -1) {
				if (this.state.messages[offStage]._ts !== undefined) offUser._ts = this.state.messages[offStage]._ts;
				this.state.messages.splice(offStage, 1);
				this.host.notify();
			}
			// The cached copy of that same staged bubble has to go with it. offUser is
			// the turn it stood in for, appended just below; leaving both would show the
			// question twice on the next visit, permanently — the cache is restored
			// verbatim. (Its _ts is recovered above only when the live bubble is still
			// there; take it from the cached copy otherwise, so the turn keeps the time
			// the user sent it at rather than the upload's finish time.)
			var offCached = offExisting.messages;
			if (stageId) {
				offCached = offCached.filter(function (m) {
					if (m._stageId !== stageId) return true;
					if (offStage === -1 && m._ts !== undefined) offUser._ts = m._ts;
					return false;
				});
			}
			this.aiChatHistoryCache[key] = {
				messages: offCached.concat([
					offUser,
					{ role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _ownerKey: key },
				]),
				endOfList: offExisting.endOfList,
				startKeyHistory: offExisting.startKeyHistory,
			};
			this.dispatchAgentRequest({
				key: key, projectId: id.projectId, owner: id.owner, aiPlatform: aiPlatform, aiModel: aiModel,
				systemPrompt: systemPrompt, text: composed, boundedMessages: offBounded.messages, userId: chatQueue,
				extractContent: extractContent, fileUrls: fileUrls,
			});
			return;
		}

		if (isQueuedSend) {
			var resolvedHistory = this.state.messages.filter(function (m) {
				return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder &&
					!m.isCancelled && !m.isBackgroundTask && !m.isError;
			});
			var boundedQ = buildBoundedChatMessages({
				platform: aiPlatform, model: aiModel, systemPrompt: systemPrompt, projectId: id.projectId,
				history: resolvedHistory.concat([{ role: 'user', content: llmComposed }]),
			});
			// _localId for the same reason as immediateUser below: a queued turn can be
			// renumbered by indexing rows spliced in above it, and an id-less bubble is
			// keyed by index. Overwritten by the staged bubble's own id when replacing one.
			var queuedBubble: ChatMessage = { role: 'user', content: composed, isPendingQueued: true, isSendingToServer: true, _dimSending: true, _localId: this._newLocalId(), _ts: wallClockNow() };
			if (key) queuedBubble._ownerKey = key;
			if (useBgQueue) queuedBubble._useBgQueue = true;
			var qStage = this._stageIndex(this.state.messages, stageId);
			if (qStage !== -1) {
				// Replace IN PLACE. The turn already sits below its own indexing rows —
				// drainBgTaskQueue inserted each of them directly above this bubble as
				// the file's pass started — so there is nothing left to reorder, and the
				// row order the reader has been looking at all along is the same one the
				// server will report on the next load.
				var qEx = this.state.messages[qStage];
				// Keep the send time the user saw, not the upload's finish time.
				if (qEx._ts !== undefined) queuedBubble._ts = qEx._ts;
				// This turn waited out its uploads AND its whole indexing chain in full
				// view; markStagedMessageReady un-dimmed it when that finished. Re-dimming
				// it now for the one remaining request would read as the wait restarting.
				if (qEx._dimSending === false) queuedBubble._dimSending = false;
				if (qEx._localId) queuedBubble._localId = qEx._localId;
				this.state.messages.splice(qStage, 1, queuedBubble);
			} else {
				this.state.messages.push(queuedBubble);
			}
			this.host.notify(); this.updateHistoryCache(); this.scrollForDispatch(stageId);

			var capturedComposed = composed, capturedPlatform = aiPlatform, capturedKey = key;
			var capturedQueuedLid = queuedBubble._localId;
			Promise.resolve(this._callProviderFor(aiPlatform, composed, boundedQ.messages, systemPrompt, aiModel, chatQueue, extractContent, fileUrls, id.projectId, id.owner))
				.then(function (result: any) {
					// Only ack a bubble that belongs to THIS chat — the search is
					// positional, so on another project it would stamp this turn's
					// _serverItemId onto that project's unrelated in-flight bubble.
					// Staged bubbles (_stageId) are skipped for the same reason: they
					// sit EARLIER in the list and match this shape exactly, so a turn
					// whose files are still uploading would take the ack — and the
					// server id — belonging to the turn that actually just sent.
					var sendingIdx = self.getHistoryCacheKey() !== capturedKey ? -1 : self.state.messages.findIndex(function (m) {
						return m.isSendingToServer && (m.isPendingQueued || m.isPendingInProcess) && m.role === 'user' &&
							!m._stageId && (m._ownerKey === undefined || m._ownerKey === capturedKey);
					});
					var serverId = result && typeof result.id === 'string' ? result.id : undefined;
					if (sendingIdx >= 0) {
						var upd = Object.assign({}, self.state.messages[sendingIdx], { isSendingToServer: false, _dimSending: false });
						if (serverId) upd._serverItemId = serverId;
						self.state.messages[sendingIdx] = upd; self.host.notify();
					}
					// And into the CACHE, which the block above never touched: a remount
					// renders the cache first, so an unstamped copy there is a bubble the
					// first-page merge cannot recognise as the turn the server just sent
					// back — which is how a queued turn came back doubled. Keyed to
					// capturedKey and matched by _localId, so it lands correctly even
					// when the user has already moved to another project (plain
					// updateHistoryCache writes under the LIVE key, which by then is a
					// different chat).
					if (serverId) self._stampTurnWithItemId(capturedKey, capturedQueuedLid, undefined, serverId);
					if (result && result.poll && (result.status === 'pending' || result.status === 'running')) {
						// Track this queued item's poll so a remount/refetch dedups
						// against it instead of attaching a duplicate history poll.
						var qp = self._fgPollWithEarlyProbe(result, serverId);
						if (serverId) self._trackPoll(serverId, 'fg', qp);
						return qp
							.then(function (res: any) { if (isPollStopped(res)) return; return self.onQueuedSendResponse(capturedComposed, res, capturedPlatform, serverId, capturedKey); })
							.catch(function (err: any) { return self.onQueuedSendError(capturedComposed, err, serverId, capturedKey); });
					}
					return self.onQueuedSendResponse(capturedComposed, result, capturedPlatform, serverId, capturedKey);
				})
				.catch(function (err: any) { return self.onQueuedSendError(capturedComposed, err, undefined, capturedKey); });
			return;
		}

		// immediate send — cache+resume model (mirrors agent.vue). The reply is
		// appended to aiChatHistoryCache by dispatchAgentRequest (so it survives a
		// view unmount), then rendered from the cache via typewriteLatestReply. A
		// later resumePendingRequest() re-renders it if the view remounted while the
		// request was still in flight.
		// _localId on the user bubble too, not just the staged one it may replace: an
		// ordinary turn sent while another is staged sits BELOW that turn, so every
		// indexing row spliced in above renumbers it — and a view that keys an id-less
		// bubble by index would tear it down and rebuild it on every uploaded file.
		var immediateUser: ChatMessage = { role: 'user', content: composed, _localId: this._newLocalId(), _ts: wallClockNow(), ...(key ? { _ownerKey: key } : {}) };
		// _localId on the placeholder too. It is how the server item id finds these
		// two bubbles again once the dispatch reports it (see onItemId below), and
		// indexing rows spliced in above move both of them, so an index will not do.
		var immediatePlaceholder: ChatMessage = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _localId: this._newLocalId(), ...(key ? { _ownerKey: key } : {}) };
		var iStage = this._stageIndex(this.state.messages, stageId);
		if (iStage !== -1) {
			// Replace IN PLACE — see the queued branch above for why nothing moves.
			var iEx = this.state.messages[iStage];
			// Keep the send time the user saw, not the upload's finish time.
			if (iEx._ts !== undefined) immediateUser._ts = iEx._ts;
			// Same id across the swap, so the row is not re-keyed (and in Vue, remounted)
			// at the very moment the turn goes out.
			if (iEx._localId) immediateUser._localId = iEx._localId;
			this.state.messages.splice(iStage, 1, immediateUser, immediatePlaceholder);
		} else {
			this.state.messages.push(immediateUser);
			this.state.messages.push(immediatePlaceholder);
		}
		this.host.notify(); this.updateHistoryCache(); this.state.sending = true; this.scrollForDispatch(stageId);

		// Same filter as the offChat and isQueuedSend paths above. It must drop the
		// pending flags too: the `isPending` placeholder pushed two lines up is the
		// in-flight "Thinking..." bubble, and leaving it in sent a trailing
		// `{role:'assistant', content:''}` upstream on EVERY immediate send. That is
		// a last-assistant-turn prefill, which the Claude platform rejects outright,
		// and on both platforms it made the history end on an assistant turn, so
		// prepareOpenAIMessages / prepareClaudeMessages bailed at their
		// `last.role !== 'user'` guard and silently stopped converting attached
		// images into image blocks.
		//
		// `isError` is dropped in all three paths for a different reason: those
		// bubbles are written by THIS client, never by the model. Every site that
		// sets `isError: true` fills content from getErrorMessage() or the literal
		// 'Request was cancelled.', so filtering them discards no model-authored
		// text. Keeping them handed the model a turn it never produced ("The AI
		// provider is temporarily unreachable..."), attributed to itself, because the
		// flag is stripped when buildBoundedChatMessages maps down to {role,content}.
		// The cost is that a retry now follows an unanswered question with no stated
		// reason, which is a true account of what happened rather than a false one.
		//
		// The turn being sent is appended LAST rather than left wherever its bubble
		// sits. A staged turn keeps the position it was sent in, which is NOT the
		// end of the list once a message sent after it (while its files uploaded)
		// has already been answered — and a history that ends on an assistant turn
		// hits exactly the `last.role !== 'user'` bail described above.
		var historyForLlm = this.state.messages.filter(function (m) {
			if (m === immediateUser) return false;
			return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder &&
				!m.isCancelled && !m.isBackgroundTask && !m.isError;
		});
		historyForLlm.push({ role: 'user', content: llmComposed });
		var bounded = buildBoundedChatMessages({
			platform: aiPlatform, model: aiModel, systemPrompt: systemPrompt, projectId: id.projectId,
			history: historyForLlm,
		});
		var immediateUserLid = immediateUser._localId, immediatePlaceholderLid = immediatePlaceholder._localId;
		var run = this.dispatchAgentRequest({
			key: key, projectId: id.projectId, owner: id.owner, aiPlatform: aiPlatform, aiModel: aiModel,
			systemPrompt: systemPrompt, text: composed, boundedMessages: bounded.messages, userId: chatQueue,
			extractContent: extractContent, fileUrls: fileUrls,
			// THE fix for a turn rendering twice after navigate-away-and-back. Until
			// this existed the immediate-send pair carried no server id for its whole
			// life (only the QUEUED path stamped one, off its ack), so nothing could
			// tell the local copy and the server's copy of the same turn apart. See
			// _stampTurnWithItemId.
			onItemId: function (itemId: string) { self._stampTurnWithItemId(key, immediateUserLid, immediatePlaceholderLid, itemId); },
		});
		// Render the reply into the "Thinking..." bubble whenever the chatbox is
		// CURRENTLY showing this chat — even after an unmount/remount. The old
		// guard bailed on `requestToken !== gateRefreshToken`, but EVERY remount
		// bumps gateRefreshToken (refreshGate), so a request that finished after
		// the user navigated away and back left a stuck "Thinking..." (no view
		// typewriter ever ran, and resumePendingRequest bails when a pending
		// bubble is already present). Gate on "is this the visible chat" instead.
		// When it ISN'T (unmounted / another project), dispatchAgentRequest has
		// already replaced the pending bubble with the answer IN THE CACHE, so a
		// later loadChatHistory renders it.
		Promise.resolve(run).catch(function () { }).then(function () {
			// Clear `sending` UNCONDITIONALLY. It is session-global (it gates
			// isQueuedSend above, plus the platform/model pickers in the view), so
			// leaving it set when the user navigated to another project wedged
			// every subsequent send in EVERY project onto the queued path and kept
			// the view's user-bubble rescue arm armed forever. Only the RENDER of
			// the reply stays gated on still showing this chat — when it isn't,
			// dispatchAgentRequest has already written the answer into the cache
			// under `key`, so a later loadChatHistory renders it.
			self.state.sending = false;
			if (!(self.host.isViewMounted() && self.getHistoryCacheKey() === key)) return;
			return Promise.resolve(self.typewriteLatestReply(key)).then(function () { self.host.scrollToBottomIfSticky(true); });
		});
	}

	/**
	 * Scroll for a dispatch that is going out NOW, but never for one arriving late.
	 *
	 * A turn with attachments does not dispatch when the user hits Send: it waits out
	 * its uploads and then its whole indexing chain, which is minutes
	 * (awaitIndexingDrained). By then the reader has very often scrolled up into
	 * history to pass the time, and the forcing scrollToBottom yanked them out of it
	 * — and worse, force-pinned stickToBottom, which no-ops every method on the
	 * scroll anchor and re-arms the queue-detect poll whose only bail is
	 * !stickToBottom.
	 *
	 * `stageId` is the exact marker for that case: only the attachment path ever
	 * produces one. The gesture itself was already paid for at stage time, where
	 * stageOutgoingMessage forces the scroll while the user is still looking at the
	 * composer. Deliberately NOT gated on "did we find the staged bubble" — a remount
	 * rebuilds from the cache and the turn is appended rather than replaced, which is
	 * just as late and just as unrequested.
	 */
	private scrollForDispatch(stageId?: string): void {
		if (stageId) this.host.scrollToBottomIfSticky(true);
		else this.host.scrollToBottom(true);
	}

	promoteNextBgQueuedToRunning(): void {
		if (this.state.messages.some(function (m) { return m.isPending && m.role === 'assistant' && m.isBackgroundTask; })) return;
		var nextIdx = this.state.messages.findIndex(function (m) {
			return m.isPendingQueued && m.role === 'user' && m.isBackgroundTask;
		});
		if (nextIdx === -1) return;
		var existing = this.state.messages[nextIdx];
		var promoted: ChatMessage = { role: 'user', content: existing.content, isPendingInProcess: true, isBackgroundTask: true };
		if (existing._indexFile) promoted._indexFile = existing._indexFile;
		if (existing._ts !== undefined) promoted._ts = existing._ts;
		if (existing._serverItemId !== undefined) promoted._serverItemId = existing._serverItemId;
		if (existing._ownerKey !== undefined) promoted._ownerKey = existing._ownerKey;
		this.state.messages[nextIdx] = promoted;
		var placeholder: ChatMessage = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, isBackgroundTask: true };
		if (existing._serverItemId !== undefined) placeholder._serverItemId = existing._serverItemId;
		if (existing._ownerKey !== undefined) placeholder._ownerKey = existing._ownerKey;
		this.state.messages.splice(nextIdx + 1, 0, placeholder);
		this.host.notify();
	}

	promoteNextQueuedToRunning(): void {
		if (this.state.messages.some(function (m) { return m.isPending && m.role === 'assistant' && !m.isBackgroundTask; })) return;
		var nextIdx = this.state.messages.findIndex(function (m) {
			return m.isPendingQueued && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue;
		});
		if (nextIdx === -1) return;
		var existing = this.state.messages[nextIdx];
		var promoted: ChatMessage = { role: 'user', content: existing.content, isPendingInProcess: true };
		if (existing.isBackgroundTask) promoted.isBackgroundTask = true;
		if (existing._indexFile) promoted._indexFile = existing._indexFile;
		if (existing._ts !== undefined) promoted._ts = existing._ts;
		if (existing._serverItemId !== undefined) promoted._serverItemId = existing._serverItemId;
		if (existing._ownerKey !== undefined) promoted._ownerKey = existing._ownerKey;
		if (existing.isSendingToServer) promoted.isSendingToServer = true;
		// Carried alongside isSendingToServer, never derived from it: an attachment
		// turn promoted to running while its ack is still out was already un-dimmed
		// by markStagedMessageReady and must stay that way.
		if (existing._dimSending) promoted._dimSending = true;
		// A turn promoted BEFORE its ack has no server id, so this is the only stable
		// render key it has; dropping it here re-keyed the bubble by index and undid
		// the reason it was minted (rows spliced in above renumber it).
		if (existing._localId !== undefined) promoted._localId = existing._localId;
		this.state.messages[nextIdx] = promoted;
		// Carry the promoted turn's _serverItemId onto the "Thinking..." placeholder
		// (mirrors promoteNextBgQueuedToRunning). Without it, when this promoted turn
		// is resolved via the history-poll path — applyHistoryItemResolution, which
		// matches the pending assistant by _serverItemId — the placeholder is not
		// found, so the reply is spliced in BESIDE it and the "Thinking..." is
		// stranded forever (e.g. after a reload, or when a cancel advances the queue).
		// onQueuedSendResponse still finds it by position, so the queued-send path is
		// unaffected.
		var placeholder: ChatMessage = { role: 'assistant', content: '', isPending: true };
		if (existing._serverItemId !== undefined) placeholder._serverItemId = existing._serverItemId;
		if (existing._ownerKey !== undefined) placeholder._ownerKey = existing._ownerKey;
		this.state.messages.splice(nextIdx + 1, 0, placeholder);
		this.host.notify();
	}

	/**
	 * The "Thinking..." placeholder belonging to the user bubble at `userIdx`, or -1.
	 *
	 * Every path that creates one puts it IMMEDIATELY after its user bubble
	 * (promoteNextQueuedToRunning, the immediate-send pair, applyHistoryItemResolution),
	 * so ownership is adjacency — modulo background bubbles, which get spliced in
	 * around them. Taking the first pending assistant ANYWHERE below instead was a
	 * hijack: a turn sent with attachments never gets a placeholder of its own
	 * (promoteNextQueuedToRunning skips _useBgQueue turns) and now keeps the position
	 * it was sent in, so an ordinary turn sent while its files indexed sits BELOW it
	 * with a placeholder of its own — and the attachment turn's answer was rendered
	 * as the answer to that unrelated question.
	 */
	private _ownThinkingIndex(userIdx: number, serverId?: string): number {
		if (userIdx < 0) return -1;
		for (var i = userIdx + 1; i < this.state.messages.length; i++) {
			var m = this.state.messages[i];
			if (!m) return -1;
			if (m.isBackgroundTask) continue; // an indexing row spliced between the pair
			if (m.isPending && m.role === 'assistant') {
				// A placeholder stamped for a DIFFERENT request is not this turn's, even
				// adjacent: ids are authoritative wherever both sides have one.
				if (serverId && m._serverItemId && m._serverItemId !== serverId) return -1;
				return i;
			}
			return -1; // the next real turn starts here; this one has no placeholder
		}
		return -1;
	}

	resolveQueuedUserBubble(serverId?: string): number | undefined {
		// The two fallbacks below match by POSITION, not identity, so they must
		// never consider a bubble stamped for a different chat.
		var liveKey = this.getHistoryCacheKey();
		var isLocal = function (m: ChatMessage) { return m._ownerKey === undefined || m._ownerKey === liveKey; };
		var userIdx = -1;
		if (serverId) {
			userIdx = this.state.messages.findIndex(function (m) {
				return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) &&
					m.role === 'user' && !m.isBackgroundTask;
			});
		}
		if (userIdx === -1) {
			userIdx = this.state.messages.findIndex(function (m) {
				return m.isPendingInProcess && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue && isLocal(m);
			});
		}
		if (userIdx === -1) {
			userIdx = this.state.messages.findIndex(function (m) {
				return m.isPendingQueued && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue && isLocal(m);
			});
		}
		if (serverId && this.cancelledServerIds.has(serverId)) {
			this.cancelledServerIds.delete(serverId);
			if (userIdx >= 0) {
				var ex = this.state.messages[userIdx];
				this.state.messages[userIdx] = { role: 'user', content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId, ...(ex._ownerKey !== undefined ? { _ownerKey: ex._ownerKey } : {}) };
				var thIdx = this._ownThinkingIndex(userIdx, serverId);
				if (thIdx !== -1) this.state.messages.splice(thIdx, 1);
			}
			this.promoteNextQueuedToRunning();
			return undefined;
		}
		if (userIdx >= 0) {
			var exist = this.state.messages[userIdx];
			var repl: ChatMessage = { role: 'user', content: exist.content };
			if (exist._serverItemId !== undefined) repl._serverItemId = exist._serverItemId;
			if (exist._ownerKey !== undefined) repl._ownerKey = exist._ownerKey;
			if (exist._ts !== undefined) repl._ts = exist._ts;
			// Kept so the bubble is not re-keyed (and in Vue, remounted) at the moment
			// its answer arrives; the views prefer _serverItemId, this is the fallback.
			if (exist._localId !== undefined) repl._localId = exist._localId;
			this.state.messages[userIdx] = repl;
		}
		var thinkingIdx = this._ownThinkingIndex(userIdx, serverId);
		return thinkingIdx !== -1 ? thinkingIdx : (userIdx >= 0 ? userIdx + 1 : -1);
	}

	insertAtTarget(msg: ChatMessage, targetIdx: number): void {
		// Error/direct replies land here rather than through the typewriter, so this
		// is where they pick up their display time.
		if (msg && msg.role === 'assistant' && msg._ts === undefined) msg._ts = wallClockNow();
		// Overwrite only a placeholder that genuinely belongs to the turn above it.
		// Two things now sit at this index that must never be replaced by a chat
		// answer: a background "Indexing:" placeholder (a file's rows are inserted
		// directly above the turn they belong to, so one can land here) — replacing it
		// deletes a live pass from its collapsed row — and another request's
		// placeholder, which resolveQueuedUserBubble deliberately declined to claim.
		// Anything else is spliced in beside it.
		var tgt = targetIdx >= 0 ? this.state.messages[targetIdx] : undefined;
		var replaceable = !!tgt && !!tgt.isPending && !tgt.isBackgroundTask &&
			this._isOwnPlaceholderOf(targetIdx, this._owningUserIndex(targetIdx));
		if (replaceable) this.state.messages[targetIdx] = msg;
		else if (targetIdx >= 0) this.state.messages.splice(targetIdx, 0, msg);
		else this.state.messages.push(msg);
	}

	/**
	 * The server's OWN copy of this turn is already on screen.
	 *
	 * A first-page fetch can land between the server settling the item and this
	 * poll's tick, and now that the local bubbles carry the item id
	 * (_stampTurnWithItemId) the rescue correctly drops them and renders the
	 * server's settled pair instead. There is then nothing left to resolve: the
	 * -1 fallback would push the answer in a SECOND time at the bottom of the list,
	 * and the positional fallbacks would hijack some other turn's bubble.
	 *
	 * The USER bubble counts, not just a settled assistant: an item whose answer is
	 * empty produces no assistant bubble at all in the mapper, and that variant
	 * would otherwise still bottom-push "No text response received...". While a turn
	 * is genuinely live its user bubble is always pending (the queued branch sets
	 * isPendingQueued, promoteNextQueuedToRunning sets isPendingInProcess), so this
	 * cannot fire early.
	 */
	private _turnAlreadyRendered(serverId?: string): boolean {
		if (!serverId) return false;
		return this.state.messages.some(function (m) {
			return m._serverItemId === serverId &&
				!m.isPending && !m.isPendingQueued && !m.isPendingInProcess;
		});
	}

	onQueuedSendResponse(_composed: string, response: any, platform: string, serverId?: string, ownerKey?: string): void {
		if (serverId) this.historyItemPolls.delete(serverId);
		// This turn resolved while a DIFFERENT chat is on screen (the user moved to
		// another project mid-flight). state.messages now belongs to that chat, and
		// resolveQueuedUserBubble's positional fallbacks would happily hijack ITS
		// pending bubble — or, finding nothing, push this answer onto its list.
		// Settle in the owning chat's cache instead and leave the view untouched.
		if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
			var offReply: ChatMessage = isErrorResponseBody(response)
				? { role: 'assistant', content: getErrorMessage(response), isError: true }
				: { role: 'assistant', content: ((platform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response)) || '').trim() || 'No text response received from AI provider.' };
			this._applyReplyToCache(ownerKey, offReply, serverId);
			if (serverId) this.cancelledServerIds.delete(serverId);
			return;
		}
		if (this._turnAlreadyRendered(serverId)) {
			if (serverId) this.cancelledServerIds.delete(serverId);
			this.host.notify(); this.updateHistoryCache(); return;
		}
		var targetIdx = this.resolveQueuedUserBubble(serverId);
		if (targetIdx === undefined) { this.host.notify(); this.updateHistoryCache(); return; }
		if (isErrorResponseBody(response)) {
			this.insertAtTarget({ role: 'assistant', content: getErrorMessage(response), isError: true }, targetIdx);
		} else {
			var answer = (platform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response));
			answer = (answer || '').trim() || 'No text response received from AI provider.';
			var lid = this._newLocalId();
			if (targetIdx >= 0 && this.state.messages[targetIdx] && this.state.messages[targetIdx].isPending) {
				this.state.messages[targetIdx] = { role: 'assistant', content: '', _localId: lid };
				this.host.notify(); this.enqueueTypewrite(targetIdx, answer, lid);
			} else if (targetIdx >= 0) {
				this.state.messages.splice(targetIdx, 0, { role: 'assistant', content: '', _localId: lid });
				this.host.notify(); this.enqueueTypewrite(targetIdx, answer, lid);
			} else {
				var aiIdx = this.state.messages.length;
				this.state.messages.push({ role: 'assistant', content: '', _localId: lid });
				this.host.notify(); this.enqueueTypewrite(aiIdx, answer, lid);
			}
		}
		this._removeStrayPendingAssistants();
		this.promoteNextQueuedToRunning();
		this.updateHistoryCache();
		this.host.notify();
		// ARRIVAL, not a user action: only follow if the user is still pinned to
		// the bottom. Scrolled-up readers keep their position.
		this.host.scrollToBottomIfSticky(true);
	}

	onQueuedSendError(_composed: string, err: any, serverId?: string, ownerKey?: string): void {
		var self = this;
		if (serverId) this.historyItemPolls.delete(serverId);
		// Off-chat resolution — see onQueuedSendResponse. Settle in the owning
		// chat's cache rather than mutating whatever chat is on screen now.
		if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
			var isGone = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
			this._applyReplyToCache(ownerKey, isGone
				? { role: 'assistant', content: 'Request was cancelled.', isError: true }
				: { role: 'assistant', content: getErrorMessage(err), isError: true }, serverId);
			if (serverId) this.cancelledServerIds.delete(serverId);
			return;
		}
		// Same reason as onQueuedSendResponse: with the server's settled copy already
		// on screen there is no pending bubble left that belongs to this turn, and
		// every fallback below would write onto some other turn's — or push a second
		// bubble at the bottom.
		if (this._turnAlreadyRendered(serverId)) {
			if (serverId) this.cancelledServerIds.delete(serverId);
			this.host.notify(); this.updateHistoryCache(); return;
		}
		var isNotExists = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
		if (isNotExists) {
			var userIdx = serverId
				? this.state.messages.findIndex(function (m) { return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) && m.role === 'user' && !m.isBackgroundTask; })
				: this.state.messages.findIndex(function (m) { return m.isPendingInProcess && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue; });
			if (!serverId && userIdx === -1) {
				userIdx = this.state.messages.findIndex(function (m) { return m.isPendingQueued && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue; });
			}
			if (userIdx >= 0) {
				var ex = this.state.messages[userIdx];
				var repl: ChatMessage = { role: 'user', content: ex.content, isCancelled: true };
				if (ex._serverItemId !== undefined) repl._serverItemId = ex._serverItemId;
				this.state.messages[userIdx] = repl;
			}
			if (serverId) {
				var thById = this.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.isPending && m.role === 'assistant' && !m.isBackgroundTask; });
				if (thById !== -1) this.state.messages.splice(thById, 1);
				else if (userIdx >= 0) {
					var thPos = this.state.messages.findIndex(function (m, i) { return i > userIdx && m.isPending && m.role === 'assistant' && !m.isBackgroundTask; });
					if (thPos !== -1) this.state.messages.splice(thPos, 1);
				}
			} else if (userIdx >= 0) {
				var thPos2 = this.state.messages.findIndex(function (m, i) { return i > userIdx && m.isPending && m.role === 'assistant' && !m.isBackgroundTask; });
				if (thPos2 !== -1) this.state.messages.splice(thPos2, 1);
			}
			if (serverId) this.cancelledServerIds.delete(serverId);
			this._removeStrayPendingAssistants();
			this.promoteNextQueuedToRunning(); this.updateHistoryCache(); this.host.notify(); this.host.scrollToBottomIfSticky(true);
			return;
		}
		var targetIdx = this.resolveQueuedUserBubble(serverId);
		if (targetIdx === undefined) { this.host.notify(); this.updateHistoryCache(); return; }
		this.insertAtTarget({ role: 'assistant', content: getErrorMessage(err), isError: true }, targetIdx);
		this._removeStrayPendingAssistants();
		this.promoteNextQueuedToRunning(); this.updateHistoryCache(); this.host.notify(); this.host.scrollToBottomIfSticky(true);
	}

	cancelQueuedMessage(msg: ChatMessage, idx: number): void {
		var self = this;
		var id = this.host.getIdentity();
		var serverId = msg._serverItemId;
		if (!serverId || msg._cancelling) return;
		var platform = id.platform;
		if (platform !== 'claude' && platform !== 'openai') return;
		var url = platform === 'claude' ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
		var queueBase = id.userId || id.projectId;
		var queue = (msg.isBackgroundTask || msg._useBgQueue) ? bgIndexingQueueName(queueBase) : queueBase;
		// `idx` is the index the VIEW rendered this bubble at, and the list can have
		// moved under it since: indexing rows are inserted above the turn they belong
		// to (drainBgTaskQueue), so a pass that starts between the last render and the
		// click shifts every bubble below it down. Writing blind at a stale index
		// overwrites an unrelated message with a copy of this one. The server id is the
		// identity — cancelQueuedMessage already refuses to run without one.
		// The role test belongs on BOTH arms: a request bubble and its reply share one
		// _serverItemId, so an id-only fast path would paint "Stopping..." on the
		// reply whenever the list shifted UP by one instead (a stray placeholder
		// swept, a sibling pass cancelled, a NOT_EXISTS splice).
		var at = (this.state.messages[idx] && this.state.messages[idx]._serverItemId === serverId && this.state.messages[idx].role === msg.role)
			? idx
			: this.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.role === msg.role; });
		// Gone from the list entirely (a history refetch rebuilt it): skip the paint —
		// writing at the rendered index would clobber a stranger — but still SEND the
		// cancel. The user asked for it, and the server request is the part that matters.
		if (at !== -1) {
			this.state.messages[at] = Object.assign({}, this.state.messages[at], { _cancelling: true, _cancelError: undefined });
		}
		this.host.notify();
		Promise.resolve(this.host.cancelRequest({
			url: url, method: 'POST', id: serverId, queue: queue, service: id.projectId, owner: id.owner,
		})).then(function (result: any) {
			if (result && result.removed) {
				self.cancelledServerIds.add(serverId as string);
				self._stopPoll(serverId as string);
				var qi = self.bgTaskQueue.findIndex(function (e) { return e.id === serverId; });
				if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
				var removeIdx = self.state.messages.findIndex(function (m) {
					return m._serverItemId === serverId && (m.isPendingQueued || m.isPendingInProcess) && m.role === 'user';
				});
				if (removeIdx !== -1) {
					// Carry the background/file markers onto the rebuild. Dropping them
					// took a cancelled INDEXING pass out of its file's collapsed row
					// (buildChatDisplayList only groups isBackgroundTask bubbles), so the
					// row stayed "Indexing…" forever while a bare "Indexing: file" bubble
					// appeared beside it.
					var wasMsg = self.state.messages[removeIdx];
					var cancelledMsg: ChatMessage = { role: 'user', content: wasMsg.content, isCancelled: true, _serverItemId: serverId };
					if (wasMsg.isBackgroundTask) cancelledMsg.isBackgroundTask = true;
					if (wasMsg._indexFile) cancelledMsg._indexFile = wasMsg._indexFile;
					if (wasMsg._useBgQueue) cancelledMsg._useBgQueue = true;
					if (wasMsg._ownerKey !== undefined) cancelledMsg._ownerKey = wasMsg._ownerKey;
					self.state.messages[removeIdx] = cancelledMsg;
					var thById = self.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.isPending && m.role === 'assistant'; });
					if (thById !== -1) self.state.messages.splice(thById, 1);
					else {
						var thPos = self.state.messages.findIndex(function (m, i) {
							return i > removeIdx && m.isPending && m.role === 'assistant' &&
								(msg.isBackgroundTask ? !!m.isBackgroundTask : !m.isBackgroundTask);
						});
						if (thPos !== -1) self.state.messages.splice(thPos, 1);
					}
					if (msg.isBackgroundTask) self.promoteNextBgQueuedToRunning(); else self.promoteNextQueuedToRunning();
					self.updateHistoryCache();
				}
				self.host.notify();
			} else {
				var errMsg = result && typeof result.message === 'string' && result.message ? result.message : 'Could not remove from queue.';
				var ci = self.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.role === 'user'; });
				if (ci !== -1) { self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg }); self.host.notify(); }
			}
		}).catch(function (err: any) {
			var errMsg = err && typeof err.message === 'string' && err.message ? err.message : 'Could not remove from queue.';
			var ci = self.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.role === 'user'; });
			if (ci !== -1) { self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg }); self.host.notify(); }
		});
	}

	/**
	 * Stop indexing a file, from its collapsed row — every pass at once, not just
	 * the bubble the user happens to see.
	 *
	 * A big file is indexed as a CHAIN of passes, so cancelling only the live one
	 * accomplishes nothing: the next pass is dispatched as soon as it settles.
	 * Three things end the chain:
	 *   1. every queued/running pass of this file is cancelled server-side
	 *      (csr-cancel deletes a queued row and flags a running one "cancelled",
	 *      which is also the worker's gate for NOT enqueueing the next window);
	 *   2. the file is remembered in cancelledIndexKeys, so the client-driven
	 *      resume (maybeResumeIndexing) stops dispatching CONTINUE passes; and
	 *   3. any of its passes still sitting in bgTaskQueue is dropped by the next
	 *      drain rather than surfacing a fresh "Indexing…" bubble; and
	 *   4. the RUN is remembered (state.stoppedIndexIds), because none of the above
	 *      necessarily leaves a mark on the conversation — see below — and without
	 *      it the collapsed row reported the stopped file as finished.
	 *
	 * Records already written by the passes that DID run are kept — this stops the
	 * work, it does not undo it.
	 */
	cancelIndexingGroup(group: IndexingGroup): void {
		var self = this;
		if (!group || !group.key) return;
		// The group belongs to the chat on screen, so scope its key the same way
		// _indexKeyOf scopes a queued task's.
		var scoped = this.getHistoryCacheKey() + '|' + group.key;
		this.cancelledIndexKeys.add(scoped);
		// Remember WHICH RUN was stopped, by the ids of the passes it is made of.
		// Everything else here stops the work without leaving any mark on the
		// conversation: a running pass cannot be un-run (it finishes and writes an
		// ordinary answer), and a queued continuation is dropped before it is ever
		// surfaced — so a stopped run's newest bubble is routinely a successful pass,
		// and the row read "Indexed" over a file the user had just stopped. Ids, not
		// the file key, so a re-upload or Reindex of the same path is a new run with
		// new ids and starts clean; and on the reactive state so the row updates the
		// moment this is recorded, since a stop with nothing left to cancel changes
		// no message at all.
		//
		// Not for a run that is already OVER, though — you cannot stop what has
		// finished, and marking it stopped would relabel a fully-indexed file as
		// cancelled on the strength of a click that arrived too late. (`finished` is
		// only ever positively established: "still running" and "we have not found
		// out" both read as false here, so the doubt goes to recording the stop.)
		if (!group.finished) {
			var stoppedIds: { [id: string]: boolean } = {};
			for (var sk in this.state.stoppedIndexIds) stoppedIds[sk] = true;
			(group.members || []).forEach(function (m) {
				var sid = m && m.msg && m.msg._serverItemId;
				if (sid) stoppedIds[sid] = true;
			});
			// The queue's own view of this file, which is not always the row's: an
			// entry can be waiting for its bubble, and the FIRST pass's entry outlives
			// the moment its bubble settles. _applyIndexCancellations reads this to
			// tell a pass that existed when the user hit Stop from a genuinely new
			// indexing request, and only the latter is allowed to lift the stop.
			this.bgTaskQueue.forEach(function (e) {
				if (e && e.id && self._indexKeyOf(e) === scoped) stoppedIds[e.id] = true;
			});
			this.state.stoppedIndexIds = stoppedIds;
			// Close the durable run:: record too — inside this !finished guard on
			// purpose, for the same reason as stoppedIndexIds: a stop that landed
			// after the run was over must not relabel an indexed file as cancelled.
			// Path over key: `key` degrades to a bare filename for path-less compact
			// stubs, and run:: is keyed by storage path only — no derivable path
			// means no record to close (restored stubs of old runs), which is fine.
			var runPath = group.path || '';
			if (!runPath) {
				(group.members || []).some(function (m) {
					var p = m && m.msg && m.msg._indexFile && m.msg._indexFile.path;
					if (p) { runPath = p; return true; }
					return false;
				});
			}
			if (!runPath) {
				this.bgTaskQueue.some(function (e) {
					if (e && e.storagePath && self._indexKeyOf(e) === scoped) { runPath = e.storagePath; return true; }
					return false;
				});
			}
			if (runPath) {
				var ident = this.host.getIdentity();
				if (ident && ident.projectId) {
					upsertIndexRunRecordSafe(ident.projectId, runPath, { status: 'cancelled', finished: Date.now() });
				}
			}
		}
		// Ask the QUEUE what else is live for this file, and cancel that too.
		//
		// The ids above are the passes THIS client knows about, and for a
		// worker-driven file that is routinely none of them: the worker mints the
		// next window itself and the client only learns its id on a later look. A
		// stop that reaches no server row at all is a stop that dies with the tab —
		// the chain keeps running, and the only record of the stop is this page's
		// memory. The adopt ladder is the existing machinery for exactly this
		// question; anything it turns up for a stopped file is dropped and
		// server-cancelled by _applyIndexCancellations on the next drain, which is
		// also what makes the worker stop enqueueing windows.
		this._adoptWorkerIndexingPasses(0);
		var ids = group.cancellableIds || [];
		if (!ids.length) { this.host.notify(); return; }
		ids.forEach(function (serverId) {
			// Address the message by IDENTITY, not by the index captured when the
			// display list was built: an earlier cancel in this same loop may already
			// have spliced the array (a group can have more than one live pass), and a
			// stale index would mark the WRONG bubble as cancelling.
			var idx = self.state.messages.findIndex(function (m) {
				return m._serverItemId === serverId && m.role === 'user' &&
					(m.isPendingQueued || m.isPendingInProcess);
			});
			if (idx === -1) return;
			self.cancelQueuedMessage(self.state.messages[idx], idx);
		});
	}

	// --- typewriter -------------------------------------------------------
	// Reveal `fullText` into a message bubble at a constant wall-clock RATE
	// (chars/second) driven by requestAnimationFrame, rather than a fixed number
	// of characters per fixed-delay tick. This is what keeps typing smooth and
	// cheap on slow machines:
	//
	//   * Each frame reveals `elapsed_ms * CHARS_PER_SEC` characters, so the
	//     visual speed is the same regardless of how long a frame actually took.
	//   * As the bubble's markdown grows, each re-render gets more expensive, so
	//     frames get longer — which makes each frame reveal MORE characters and
	//     therefore do FEWER, larger renders. That converts the old O(n^2)
	//     "re-render the whole growing string once per 3 characters" (which got
	//     slower and slower and pegged the CPU) into roughly O(n): the number of
	//     renders self-throttles to what the machine can actually paint.
	//   * rAF paces us to the browser's paint cycle and pauses in background
	//     tabs, so we never queue work faster than it can be drawn.
	typewriteIntoIndex(idx: number, fullText: string, localId?: string): Promise<void> {
		var self = this;
		if (!fullText) return Promise.resolve();

		var CHARS_PER_SEC = 300;   // reveal rate (was ~188 = 3 chars / 16ms) — a bit faster
		var MIN_STEP = 1;          // always make progress, even on a sub-ms frame
		var MAX_FRAME_MS = 1000;   // cap catch-up after a long stall / backgrounded tab

		// Atomic regions that must never be left half-revealed: file fences
		// (shown as a download chip / hidden as "[generating …]" while unclosed —
		// and potentially huge, so revealed in one jump) and inline links
		// (a partial link is broken markdown). If a frame's reveal boundary lands
		// inside one, snap it to the region end so the chip/link appears whole.
		var regions: Array<{ start: number; end: number }> = [], m;
		var fenceRegex = /```[^\n`]+?\.[^\s.`]+\n[\s\S]*?```/g;
		while ((m = fenceRegex.exec(fullText)) !== null) regions.push({ start: m.index, end: m.index + m[0].length });
		var linkRegex = createInlineLinkRegex();
		while ((m = linkRegex.exec(fullText)) !== null) regions.push({ start: m.index, end: m.index + m[0].length });
		regions.sort(function (a, b) { return a.start - b.start; });

		this.state.typing = true; this.state.typingAbort = false;
		var i = 0;
		var last = nowMs();

		return new Promise<void>(function (resolve) {
			var done = false;
			var doc: any = _g.document;
			function isHidden(): boolean { return !!(doc && doc.hidden); }
			function cleanup(): void {
				if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
			}
			function finish(): void {
				if (done) return;
				done = true;
				cleanup();
				if (!self.state.typingAbort) {
					// Re-find the bubble by localId and, if it's gone, bail WITHOUT
					// writing — never fall back to the numeric idx, which a concurrent
					// array mutation may have repurposed for an unrelated message
					// (mirrors frame()'s currentIdx===-1 bail below).
					var fi = localId ? self.state.messages.findIndex(function (mm) { return mm._localId === localId; }) : idx;
					if (fi !== -1) {
						var t = self.state.messages[fi];
						if (t) { t.content = fullText; self.host.refreshMessageBubble(fi); }
					}
				}
				self.state.typing = false;
				resolve();
			}
			// requestAnimationFrame is PAUSED in a backgrounded tab (setTimeout only
			// throttles), so an rAF-driven reveal would freeze there — leaving a blank
			// bubble and stalling the sequential enqueueTypewrite queue until refocus.
			// When the page is (or becomes) hidden, skip the animation and show the
			// full text immediately so the queue keeps draining.
			function onVisibility(): void { if (isHidden()) finish(); }
			if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
			function frame(t: number): void {
				if (done) return;
				if (self.state.typingAbort || i >= fullText.length || isHidden()) { finish(); return; }

				var dt = t - last; last = t;
				if (!(dt > 0)) dt = 16;                       // first frame / clock glitch
				if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;
				var step = Math.round(dt * CHARS_PER_SEC / 1000);
				if (step < MIN_STEP) step = MIN_STEP;
				var next = Math.min(fullText.length, i + step);

				// Extend past any atomic region the newly-revealed span (i, next]
				// cuts into. Iterate to convergence so back-to-back regions (e.g. a
				// link right after a fence) are all revealed whole in one frame.
				for (var changed = true; changed;) {
					changed = false;
					for (var k = 0; k < regions.length; k++) {
						var r = regions[k];
						if (next > r.start && i < r.end && r.end > next) { next = r.end; changed = true; }
					}
				}
				if (next > fullText.length) next = fullText.length;
				i = next;

				var currentIdx = localId ? self.state.messages.findIndex(function (mm) { return mm._localId === localId; }) : idx;
				if (currentIdx === -1) { finish(); return; }
				var target = self.state.messages[currentIdx];
				if (!target) { finish(); return; }
				target.content = fullText.slice(0, i);
				self.host.refreshMessageBubble(currentIdx);
				self.host.scrollToBottomIfSticky();
				nextFrame(frame);
			}
			if (isHidden()) { finish(); return; }
			nextFrame(frame);
		});
	}

	private typewriterQueue: Promise<any> = Promise.resolve();
	enqueueTypewrite(idx: number, fullText: string, localId?: string): Promise<any> {
		var self = this;
		// Stamp the reply bubble's display time as it starts revealing. This is the
		// single chokepoint every typed reply (immediate, queued, and bg-resolution)
		// passes through, so it is where a live reply gets its "when it arrived"
		// timestamp; a history reload later replaces it with the server `updated`.
		var target = this.state.messages[idx];
		if (target && target._ts === undefined) target._ts = wallClockNow();
		this.typewriterQueue = this.typewriterQueue.then(function () { return self.typewriteIntoIndex(idx, fullText, localId); });
		return this.typewriterQueue;
	}

	// --- cache+resume immediate-send rendering -----------------------------
	// Render the just-resolved reply (read from aiChatHistoryCache) into the
	// pending assistant bubble, character-by-character. Runs AFTER the reply is
	// already in the cache (dispatchAgentRequest appended it); errors are shown
	// instantly (no typing). Promotes the next queued message immediately so its
	// "Thinking…" bubble appears without waiting for this typewriter to finish.
	typewriteLatestReply(key: string): Promise<any> {
		var cached = this.aiChatHistoryCache[key];
		if (!cached || !cached.messages.length) return Promise.resolve();
		var latest: ChatMessage | undefined;
		for (var i = cached.messages.length - 1; i >= 0; i--) {
			var m = cached.messages[i];
			if (m.role === 'assistant' && !m.isPending) { latest = m; break; }
		}
		if (!latest) return Promise.resolve();
		var pendingIdx = this.state.messages.findIndex(function (mm) {
			return mm.isPending && mm.role === 'assistant' && !mm.isBackgroundTask;
		});
		if (pendingIdx === -1) return Promise.resolve();
		if (latest.isError || !latest.content) {
			this.state.messages[pendingIdx] = { role: 'assistant', content: latest.content || '', isError: !!latest.isError };
			this._removeStrayPendingAssistants();
			this.host.notify();
			this.promoteNextQueuedToRunning();
			return Promise.resolve();
		}
		var lid = this._newLocalId();
		this.state.messages[pendingIdx] = { role: 'assistant', content: '', isPending: false, _localId: lid };
		this._removeStrayPendingAssistants();
		this.host.notify();
		this.promoteNextQueuedToRunning();
		return this.enqueueTypewrite(pendingIdx, latest.content, lid);
	}

	// Remove leftover non-background pending ("Thinking…") assistant bubbles: the
	// duplicate that appears when a concurrent history refetch re-maps the still-
	// "running" turn into a pending placeholder (with a real _serverItemId) while the
	// local pending bubble (no _serverItemId) is rescued and re-appended (see the
	// loadHistory rescue below), and the orphan a resolve leaves when it splices its
	// reply beside a placeholder instead of into it. Each resolve path only replaces
	// ONE pending bubble, so without this a stray "Thinking…" survives forever next to
	// the reply. MUST run AFTER the resolved bubble has been made non-pending and
	// BEFORE promoteNext*() (which only adds a Thinking once none remains).
	//
	// It used to take EVERY one, on the premise that there is at most one at a time
	// because promoteNext* refuses to add a second. That premise never covered the
	// immediate-send path, which creates its pair directly — and a turn sent with
	// attachments does not block the composer and resolves on its own queue, so an
	// ordinary question asked while files index is in flight, with a placeholder of
	// its own, exactly when the attachment turn resolves. Sweeping it left that
	// question with no spinner and, worse, nowhere for its answer to land:
	// typewriteLatestReply bails when there is no pending assistant, so the reply
	// reached the cache and never the screen.
	//
	// The discriminator is the owning USER bubble. A live immediate send's user bubble
	// carries NO pending flags (its in-flight-ness lives in state.sending), while every
	// duplicate this sweep is for belongs to a user bubble that is still pending — and
	// an orphan has no user bubble above it at all.
	_removeStrayPendingAssistants(): void {
		for (var k = this.state.messages.length - 1; k >= 0; k--) {
			var m = this.state.messages[k];
			if (!m || !m.isPending || m.role !== 'assistant' || m.isBackgroundTask) continue;
			if (this._isLiveImmediatePlaceholder(k)) continue;
			this.state.messages.splice(k, 1);
		}
	}

	/** Index of the USER bubble the message at `idx` belongs to — the nearest one
	 *  above it, stepping over background bubbles (a file's indexing rows are
	 *  inserted between turns). -1 when the nearest thing above is not a user turn,
	 *  which for a placeholder means it is an orphan. */
	private _owningUserIndex(idx: number): number {
		for (var j = idx - 1; j >= 0; j--) {
			var p = this.state.messages[j];
			if (!p) return -1;
			if (p.isBackgroundTask) continue;
			return p.role === 'user' ? j : -1;
		}
		return -1;
	}

	/** The bubble at `idx` is the "Thinking…" of a DIFFERENT turn that is still
	 *  waiting for its answer, so the sweep above must leave it alone. */
	private _isLiveImmediatePlaceholder(idx: number): boolean {
		var ui = this._owningUserIndex(idx);
		if (ui === -1) return false; // orphan
		var p = this.state.messages[ui];
		// Its own turn, still unanswered and not one of the pending duplicates: a live
		// immediate send's user bubble carries no pending flags at all.
		return !p.isPending && !p.isPendingQueued && !p.isPendingInProcess &&
			!p.isPendingOlder && !p.isSendingToServer && !p.isCancelled;
	}

	/** A pending assistant at `idx` is the placeholder OF the turn above it, so a
	 *  reply may take its slot. Every path that makes one copies the parent's
	 *  _serverItemId (or neither has one yet), so a mismatch means the slot belongs to
	 *  some other request and the reply must be spliced in beside it, not on top. */
	private _isOwnPlaceholderOf(idx: number, userIdx: number): boolean {
		if (userIdx === -1) return false;
		var ph = this.state.messages[idx], u = this.state.messages[userIdx];
		if (!ph || !u) return false;
		if (ph._serverItemId === undefined || u._serverItemId === undefined) return true;
		return ph._serverItemId === u._serverItemId;
	}

	// Drop the pending flags on the resolved turn's USER bubble (preserving its
	// content + background-task marker). Needed because a bg "Indexing:" turn's user
	// bubble carries isPendingInProcess; leaving it set keeps the bubble visually
	// stuck and keeps its bgTaskQueue entry alive forever.
	_clearPendingUserBubble(itemId: string): void {
		var uIdx = this.state.messages.findIndex(function (m) {
			return m.role === 'user' && m._serverItemId === itemId &&
				(m.isPendingInProcess || m.isPendingQueued || m.isSendingToServer);
		});
		if (uIdx === -1) return;
		var u = this.state.messages[uIdx];
		var cleaned: ChatMessage = { role: 'user', content: u.content, _serverItemId: itemId };
		if (u.isBackgroundTask) cleaned.isBackgroundTask = true;
		if (u._ts !== undefined) cleaned._ts = u._ts;
		// Carry the file ref: it is what keeps this pass in its file's collapsed
		// row (the label parser is only a fallback for older cached bubbles).
		if (u._indexFile) cleaned._indexFile = u._indexFile;
		this.state.messages[uIdx] = cleaned;
	}

	// If an immediate-send request for the current cache key is still in flight
	// (e.g. the view unmounted then remounted mid-request), show the sending
	// state, await it, then render the reply from the cache. Skipped when the
	// list already has its own pending/queued bubbles (those resolve via their
	// own polls). The displayed reply also lands via dispatchComposedMessage's
	// own finally if the view never unmounted — this is the remount recovery.
	resumePendingRequest(token: number): Promise<void> {
		var self = this;
		var key = this.getHistoryCacheKey();
		var pending = key ? this.pendingAgentRequests[key] : undefined;
		if (!pending) return Promise.resolve();
		if (this.state.messages.some(function (m) { return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue; })) return Promise.resolve();
		this.state.sending = true;
		this.host.scrollToBottomIfSticky(true);
		return Promise.resolve(pending).catch(function () { }).then(function () {
			if (token !== self.state.gateRefreshToken) return;
			self.state.sending = false;
			return Promise.resolve(self.typewriteLatestReply(key)).then(function () { self.host.scrollToBottomIfSticky(true); });
		});
	}

	// --- background-task resolution + drain -------------------------------
	handleHistoryItemResolution(itemId: string, response: any, platform: string): void {
		// Which file this turn was indexing, read BEFORE the resolution rewrites the
		// bubbles. Every settling turn funnels through here — the bg drain's own
		// poll, the history poll, and agent.vue's forked history poll, which calls
		// straight into this method — so hooking the chain follow-up here is what
		// makes it work in both clients without either of them forking a call site.
		var indexRef = this._indexRefOfItem(itemId);
		this.applyHistoryItemResolution(itemId, response, platform);
		this.promoteNextBgQueuedToRunning();
		// applyHistoryItemResolution just released this item's poll slot. Under
		// MAX_CONCURRENT_BG_POLLS that slot is what the next-oldest unpolled entry
		// is waiting for, and every settling turn funnels through here — including
		// the history poll, whose resolution has no other path back to the drain.
		this.drainBgTaskQueue();
		// A worker-driven chain has no client-side record of its next pass, so a
		// settling pass is the only moment there is to go looking for one.
		if (indexRef) this._followWorkerIndexingChain(indexRef.name, indexRef.mime);
	}

	/** The file an already-rendered background pass is about, off its request
	 *  bubble. Null for an ordinary turn, which is most of them. */
	private _indexRefOfItem(itemId: string): { name?: string; mime?: string } | null {
		if (!itemId) return null;
		for (var i = 0; i < this.state.messages.length; i++) {
			var m = this.state.messages[i];
			if (m._serverItemId !== itemId || m.role !== 'user' || !m.isBackgroundTask) continue;
			return m._indexFile || null;
		}
		return null;
	}

	/**
	 * Settle a turn the server reports as cancelled: the request bubble goes to its
	 * cancelled form and the "Thinking..." placeholder goes away. The same shape
	 * cancelQueuedMessage produces locally, so a cancel this client made and one it
	 * merely found out about render identically — and an indexing pass keeps the
	 * markers that hold it in its file's collapsed row.
	 */
	private _settleCancelledItem(itemId: string): void {
		var uIdx = this.state.messages.findIndex(function (m) {
			return m.role === 'user' && m._serverItemId === itemId && !m.isCancelled;
		});
		if (uIdx !== -1) {
			var u = this.state.messages[uIdx];
			var cancelled: ChatMessage = { role: 'user', content: u.content, isCancelled: true, _serverItemId: itemId };
			if (u.isBackgroundTask) cancelled.isBackgroundTask = true;
			if (u._indexFile) cancelled._indexFile = u._indexFile;
			if (u._useBgQueue) cancelled._useBgQueue = true;
			if (u._ownerKey !== undefined) cancelled._ownerKey = u._ownerKey;
			if (u._ts !== undefined) cancelled._ts = u._ts;
			this.state.messages[uIdx] = cancelled;
		}
		var pIdx = this.state.messages.findIndex(function (m) {
			return m.isPending && m.role === 'assistant' && m._serverItemId === itemId;
		});
		if (pIdx !== -1) this.state.messages.splice(pIdx, 1);
		this.cancelledServerIds.delete(itemId);
		this._removeStrayPendingAssistants();
		this.host.notify();
		this.updateHistoryCache();
	}

	/**
	 * A poll that came back saying the request was CANCELLED, rather than with an
	 * answer.
	 *
	 * The server keeps a cancelled request as a terminal row instead of deleting it
	 * (that row is the durable record of the stop, and the chat history it belongs
	 * to), so a poll still running when the cancel lands now RESOLVES on it. It used
	 * to reject with NOT_EXISTS, and the resolution path below reads a status object
	 * as an answer with no text — which would stamp "No text response received from
	 * AI provider" over a turn the user had just stopped.
	 *
	 * Reachable whenever the poll was not stopped by whoever cancelled: another tab,
	 * another device, or the row being cancelled server-side by the file's own stop.
	 */
	private _isCancelledPollResult(response: any): boolean {
		if (!response || typeof response !== 'object' || response.status !== 'cancelled') return false;
		// The POLL's own shape (id + queue fields, no provider payload), not a
		// provider body that happens to carry a `status` — OpenAI's Responses API
		// has a "cancelled" status of its own, and that one is an answer to render,
		// not a row that was removed from the queue.
		if (response.content !== undefined || response.output !== undefined) return false;
		return response.queue_name !== undefined || response.in_queue !== undefined;
	}

	applyHistoryItemResolution(itemId: string, response: any, platform: string): void {
		this.historyItemPolls.delete(itemId);
		if (this._isCancelledPollResult(response)) {
			this._settleCancelledItem(itemId);
			return;
		}
		var isErr = isErrorResponseBody(response);
		var answer = isErr ? getErrorMessage(response)
			: ((platform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response)) || '').trim();
		// Record the marker BEFORE hiding it from the displayed summary: the display
		// layer needs it as a structured fact, and searching the shown text for it
		// afterwards would find nothing. Mirrors history.ts, so a run reads the same
		// live and after a reload.
		//
		// The STRIP happens in the background branches only, not here. It used to run
		// on every answer, so an ordinary chat reply that merely mentioned the token
		// had it silently cut out of the user's text (leaving a double space) — and
		// the history mappers never did that, so the same reply read differently
		// before and after a reload. Only an INDEXING pass has a protocol token to
		// hide.
		var reportedComplete = !isErr && !!answer && answer.indexOf(INDEXING_COMPLETE_MARKER) !== -1;
		var stripMarker = function (t: string): string {
			return reportedComplete ? t.split(INDEXING_COMPLETE_MARKER).join('').trim() : t;
		};
		var idx = this.state.messages.findIndex(function (m) { return m.isPending && m._serverItemId === itemId; });
		if (idx !== -1) {
			// A bg "Indexing:" turn pushes a user bubble (isPendingInProcess) ALONGSIDE
			// the assistant Thinking; replacing only the assistant leaves that user
			// bubble stuck pending — and drainBgTaskQueue then never clears its queue
			// entry (its stillPending check stays true). Un-pend it here too.
			this._clearPendingUserBubble(itemId);
			// Carry isBackgroundTask onto the REPLACEMENT. These rebuilds are fresh
			// object literals, so anything not copied is lost — and dropping this flag
			// made a pass that resolved LIVE fall out of its file's collapsed row
			// (buildChatDisplayList only considers isBackgroundTask messages), while
			// the same pass rebuilt from history stayed grouped. That mismatch is the
			// "new indexing response renders outside the group" bug.
			var wasBgTask = !!this.state.messages[idx].isBackgroundTask;
			if (isErr) {
				this.state.messages[idx] = { role: 'assistant', content: answer, isError: true, _serverItemId: itemId };
				if (wasBgTask) this.state.messages[idx].isBackgroundTask = true;
				this.host.notify(); this.updateHistoryCache(); return;
			}
			var text = answer || 'No text response received from AI provider.';
			// A background-indexing reply is INSIDE a collapsed row: nothing of it is
			// on screen. Typewriting it anyway put it on the one shared, serial
			// typewriter queue, so the user's own next reply — which IS on screen —
			// lost its "Thinking..." spinner and sat as an EMPTY bubble for however
			// long the invisible indexing summary took to reveal (seconds per pass,
			// additive across files). It also held state.typing true for the whole
			// time, which disables the platform/model pickers and no-ops Clear
			// history, and ran a per-frame scroll for content nobody can see.
			// Write it straight in; expanding the row then shows it complete.
			if (wasBgTask) {
				this.state.messages[idx] = { role: 'assistant', content: stripMarker(text) || EMPTY_INDEXING_REPLY, isBackgroundTask: true, _serverItemId: itemId, ...(reportedComplete ? { _indexComplete: true } : {}) };
				this.host.notify(); this.updateHistoryCache(); return;
			}
			var lid = this._newLocalId();
			this.state.messages[idx] = { role: 'assistant', content: '', _localId: lid, _serverItemId: itemId };
			this.host.notify(); this.enqueueTypewrite(idx, text, lid);
			this.updateHistoryCache(); return;
		}
		var userIdx = this.state.messages.findIndex(function (m) {
			return m.role === 'user' && m._serverItemId === itemId && (m.isPendingQueued || m.isPendingInProcess);
		});
		if (userIdx === -1) return;
		var ex = this.state.messages[userIdx];
		// Same carry-over as above, plus _indexFile / _useBgQueue: this rebuild is
		// what keeps an indexing REQUEST bubble in its file's collapsed row (and a
		// bg-queued chat cancelling against the right queue) once the pass settles.
		var settledUser: ChatMessage = { role: 'user', content: ex.content, _serverItemId: itemId };
		if (ex.isBackgroundTask) settledUser.isBackgroundTask = true;
		if (ex._ts !== undefined) settledUser._ts = ex._ts;
		if (ex._indexFile) settledUser._indexFile = ex._indexFile;
		if (ex._useBgQueue) settledUser._useBgQueue = true;
		this.state.messages[userIdx] = settledUser;
		if (isErr) {
			var errReply: ChatMessage = { role: 'assistant', content: answer, isError: true, _serverItemId: itemId };
			if (ex.isBackgroundTask) errReply.isBackgroundTask = true;
			this.state.messages.splice(userIdx + 1, 0, errReply);
			this.host.notify(); this.updateHistoryCache(); return;
		}
		var text2 = answer || 'No text response received from AI provider.';
		// Same as above: a collapsed row's reply is not on screen, so revealing it
		// character by character only blocks the queue the visible reply needs.
		if (ex.isBackgroundTask) {
			this.state.messages.splice(userIdx + 1, 0, { role: 'assistant', content: stripMarker(text2) || EMPTY_INDEXING_REPLY, isBackgroundTask: true, _serverItemId: itemId, ...(reportedComplete ? { _indexComplete: true } : {}) });
			this.host.notify(); this.updateHistoryCache(); return;
		}
		var lid2 = this._newLocalId();
		var reply: ChatMessage = { role: 'assistant', content: '', _localId: lid2, _serverItemId: itemId };
		this.state.messages.splice(userIdx + 1, 0, reply);
		this.host.notify(); this.enqueueTypewrite(userIdx + 1, text2, lid2);
		this.updateHistoryCache();
	}

	/** How a bg task maps onto a collapsed row: the row's own key (storage path
	 *  when known, else the filename), scoped to the chat it belongs to. A storage
	 *  path is project-relative ("report.xlsx"), and ONE ChatSession serves every
	 *  project — unscoped, stopping a file in one project would silently suppress
	 *  the same filename's continuations in another. */
	private _indexKeyOf(entry: BgTaskEntry): string {
		if (!entry) return '';
		var file = entry.storagePath || entry.filename;
		if (!file) return '';
		return entry.projectId + '#' + entry.platform + '|' + file;
	}

	/**
	 * Reconcile the bg queue with the files the user has stopped.
	 *
	 * A FIRST pass (no resumePass) is a fresh indexing request — a re-upload, or a
	 * Reindex from the file manager — so it LIFTS the stop: the key is a storage
	 * path, and without this an earlier cancel would silently kill every future
	 * index of the same path. A continuation of a stopped file is dropped instead,
	 * covering the pass that was dispatched in the moment before the cancel landed.
	 *
	 * "Fresh" is the load-bearing word, and it used to be missing. A run's OWN first
	 * pass sits in this queue for as long as it runs (entries are only dropped once
	 * their bubble settles), so stopping a file during its first pass — which is
	 * exactly when a user who has just uploaded it does — met that first-pass entry
	 * on the very next drain and lifted the stop the user had just asked for. The
	 * chain then carried on, one worker-minted window after another, with nothing
	 * client-side left to suppress it. The ids recorded at stop time are what tells
	 * the two apart: a pass that was already there when the user hit Stop cannot be
	 * the new request that lifts it.
	 */
	private _applyIndexCancellations(): void {
		if (!this.cancelledIndexKeys.size) return;
		// Passes already on screen. Dropping the queue entry for one of those kills
		// its poll and leaves the bubble pending forever — a row stuck on "Indexing"
		// with no way to ever settle. _sweepCancelledIndexing (which runs straight
		// after this, on the same drain) cancels those properly, rebuilding the bubble
		// as cancelled; the splice below is only right for an entry with no bubble yet.
		var surfaced: { [id: string]: boolean } = {};
		this.state.messages.forEach(function (m) {
			if (!m._serverItemId) return;
			if (m.isPending || m.isPendingQueued || m.isPendingInProcess) surfaced[m._serverItemId] = true;
		});
		for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
			var entry = this.bgTaskQueue[i];
			var key = this._indexKeyOf(entry);
			if (!key || !this.cancelledIndexKeys.has(key)) continue;
			if (!entry.resumePass && !this.state.stoppedIndexIds[entry.id]) {
				this.cancelledIndexKeys.delete(key);
				continue;
			}
			if (surfaced[entry.id]) continue;
			this.bgTaskQueue.splice(i, 1);
			this._stopPoll(entry.id);
			this._cancelServerItem(entry.id);
		}
	}

	/**
	 * Cancel any live pass of a stopped file that turned up on its own.
	 *
	 * The client is not the only thing that continues a file: for PDFs and (when
	 * windowed indexing is on) text/grid files the WORKER enqueues the next window
	 * itself, and that pass reaches the chat through the history poll, never
	 * through bgTaskQueue. The worker's own gate stops the chain when the running
	 * row is cancelled — but if the row had already finished when the user hit
	 * stop, the next window was queued a moment earlier and still arrives. Stop it
	 * here rather than making the user hit stop again.
	 *
	 * Runs from drainBgTaskQueue, which both clients call after a history load.
	 */
	private _sweepCancelledIndexing(): void {
		if (!this.cancelledIndexKeys.size) return;
		var self = this;
		var chatKey = this.getHistoryCacheKey();
		var targets: { msg: ChatMessage; idx: number }[] = [];
		this.state.messages.forEach(function (m, i) {
			if (!m.isBackgroundTask || m.role !== 'user' || !m._serverItemId) return;
			if (m._cancelling || m.isSendingToServer) return;
			if (!(m.isPendingQueued || m.isPendingInProcess)) return;
			var ref = m._indexFile;
			var file = ref && (ref.path || ref.name);
			if (!file || !self.cancelledIndexKeys.has(chatKey + '|' + file)) return;
			targets.push({ msg: m, idx: i });
		});
		targets.forEach(function (t) {
			var idx = self.state.messages.indexOf(t.msg);
			self.cancelQueuedMessage(t.msg, idx === -1 ? t.idx : idx);
		});
	}

	/**
	 * True when the WORKER, not this client, drives the rest of this file's chain.
	 * The mirror image of the early returns in maybeResumeIndexing: whatever that
	 * refuses to continue is exactly what nothing client-side is tracking.
	 */
	private _isWorkerDrivenIndexing(filename?: string, mime?: string): boolean {
		if (!isPagedReadFile(filename, mime)) return false;
		if (isImageVisionFile(filename, mime)) return true;
		return windowedIndexingEnabled() && isWindowedReadFile(filename, mime);
	}

	/**
	 * Pick up indexing passes the WORKER minted, which no client ever dispatched.
	 *
	 * For a PDF (and for text/grid when windowed indexing is on) the worker writes
	 * pass N+1's row itself, inside pass N's invocation, right after saving pass
	 * N's result. That row reaches this client through nothing at all: it is not in
	 * bgTaskQueue (the client never asked for it) and it is not in state.messages
	 * (only a first-page history load maps it in, which happens on mount, project
	 * switch or tab return). So between two worker passes every pass the client
	 * knows about is settled, and the collapsed row renders "Indexed  N passes"
	 * with no spinner and no Stop, for a file that is still being read. A user who
	 * believes that then asks questions against a half-indexed file — which is what
	 * this exists to prevent.
	 *
	 * So when a background indexing pass settles, ask the bg queue what is still
	 * unresolved on it and adopt anything unknown as an ordinary BgTaskEntry.
	 * drainBgTaskQueue then treats it exactly like a pass this client dispatched:
	 * same bubble, same `_indexFile` (so it joins the file's collapsed row), same
	 * poll — and that poll settling runs this again, so the chain is followed to
	 * its end. `status`-scoped so the reply carries the live items only, never a
	 * page of finished ones with their bodies.
	 *
	 * Termination: the only trigger is a pass SETTLING, which happens once per
	 * pass. An adopted item that is still running is not re-adopted (its id is
	 * already polled), and when the queue holds nothing unknown the chain stops on
	 * its own. Nothing here is periodic — a timer that re-reads history is the
	 * shape that previously looped fetchHistoryPage after an already-DONE index.
	 */
	private _adoptingWorkerPasses = false;
	private _adoptWorkerIndexingPasses(attempt: number, passive?: boolean): void {
		var self = this;
		// One in flight at a time. The query is queue-WIDE, so a second file's pass
		// settling in the same moment is covered by the query already running.
		if (this._adoptingWorkerPasses) return;
		var id = this.host.getIdentity();
		var platform = id.platform;
		if (!id.projectId || (platform !== 'claude' && platform !== 'openai')) return;
		if (this.isPollingPaused() || !this.host.isViewMounted()) return;
		var svcId = id.projectId, owner = id.owner;
		var queue = bgIndexingQueueName(id.userId, id.projectId);
		// maxAgeMs 0: adoption exists to notice passes the worker JUST minted,
		// so it must always look fresh — but its answers write through into the
		// shared probe memo, which is what keeps the snapshot readers (and the
		// db-files page's badge probe) from re-asking seconds later.
		var ask = function (status: 'pending' | 'running') {
			return Promise.resolve(probeBgQueue(
				{ service: svcId, owner: owner, platform: platform as 'claude' | 'openai', queue: queue, status: status, limit: WORKER_PASS_ADOPT_LIMIT },
				{ maxAgeMs: 0 },
			)).then(function (entry) { return entry.result; }).catch(function () { return null; });
		};
		this._adoptingWorkerPasses = true;
		Promise.all([ask('running'), ask('pending')]).then(function (results: any[]) {
			self._adoptingWorkerPasses = false;
			// The chat may have changed under the query; adopting into another
			// project's session is the cross-project bubble leak all over again.
			var now = self.host.getIdentity();
			if (now.projectId !== svcId || now.platform !== platform) return;
			if (!self.host.isViewMounted()) return;
			// Free: this is already the whole-queue snapshot the display layer needs to
			// tell a worker-driven run's "between passes" from its "finished".
			//
			// A null is a FAILED query, and the adoption loop below reads it as an empty
			// list — harmless there (nothing to adopt) but not here: recording it would
			// publish "the queue holds nothing" on the strength of a request that never
			// answered, which reads as finished. Not knowing is the honest state.
			if (results[0] !== null && results[1] !== null) self._recordLiveIndexKeys(results);
			var adoptedIds: string[] = [];
			for (var ri = 0; ri < results.length; ri++) {
				var list = results[ri] && Array.isArray(results[ri].list) ? results[ri].list : [];
				for (var i = 0; i < list.length; i++) {
					if (self._adoptWorkerIndexingItem(list[i], svcId, platform as 'claude' | 'openai')) adoptedIds.push(list[i].id);
				}
			}
			if (adoptedIds.length) {
				self.drainBgTaskQueue();
				// Only an item the drain KEPT means the chain is still going. One it
				// threw straight back out is not progress and must not end the ladder:
				// the status index is eventually consistent, so a look taken the
				// instant a pass settles can still report that pass as running, and a
				// pass belonging to a file the user stopped is dropped on sight. Both
				// used to read as "found the next pass", which ended the search for a
				// pass that had not been written yet.
				if (self._isTrackingAny(adoptedIds)) return;
			}
			// Nothing yet. The worker writes pass N+1 a few milliseconds AFTER it
			// flips pass N to resolved, so a poll that lands in that gap sees an
			// empty queue for a chain that is very much alive — and with no pass
			// left to settle, nothing would ever ask again. Look once or twice more
			// before believing the file is finished.
			//
			// PASSIVE calls (first-page/resume refresh) climb only on EVIDENCE of
			// live work — a queued local entry for this project, a live key the
			// look above just recorded, or an attached poll. The gap rationale
			// presumes a chain was alive; with nothing suggesting one, the climb
			// re-asked an unchanged question three more times on every tab return.
			// (No nudge here either: a send waiting on indexing implies local
			// entries, which IS evidence, so the passive stop never starves it.)
			if (passive && !self._hasLiveIndexEvidence(svcId)) return;
			if (attempt + 1 >= WORKER_PASS_ADOPT_ATTEMPTS.length) {
				// The ladder is the only thing that can tell a worker-driven chain has
				// really ended, and it just did. This is the earliest honest moment to
				// let a turn waiting on these files stop waiting.
				self._nudgeIndexingDrain();
				return;
			}
			setTimeout(function () {
				var later = self.host.getIdentity();
				if (later.projectId !== svcId || later.platform !== platform) return;
				if (self.isPollingPaused() || !self.host.isViewMounted()) return;
				self._adoptWorkerIndexingPasses(attempt + 1, passive);
			}, WORKER_PASS_ADOPT_ATTEMPTS[attempt + 1]);
		}, function () { self._adoptingWorkerPasses = false; });
	}

	/** Anything at all suggesting THIS project's indexing may be live: a queued
	 *  local entry, a recorded live key (the adopt look just wrote them), or an
	 *  attached poll. Gates the passive adopt ladder's climb. */
	private _hasLiveIndexEvidence(svcId: string): boolean {
		for (var i = 0; i < this.bgTaskQueue.length; i++) {
			var e = this.bgTaskQueue[i];
			if (e && e.projectId === svcId) return true;
		}
		var keys = this.state.liveIndexKeys || {};
		for (var k in keys) { if (keys[k]) return true; }
		// BG polls only: a pending ORDINARY chat turn also holds a poll, and
		// counting it made every tab return during a conversation climb the
		// full passive ladder for indexing that does not exist.
		var found = false;
		this.historyItemPolls.forEach(function (h: any) { if (h && h.kind === 'bg') found = true; });
		return found;
	}

	/** Any of these ids still queued or still polled, i.e. surviving work. */
	private _isTrackingAny(ids: string[]): boolean {
		for (var i = 0; i < ids.length; i++) {
			if (this.historyItemPolls.has(ids[i])) return true;
			for (var q = 0; q < this.bgTaskQueue.length; q++) {
				if (this.bgTaskQueue[q].id === ids[i]) return true;
			}
		}
		return false;
	}

	/** One live bg-queue item -> a BgTaskEntry, if it is an indexing pass this
	 *  client is not already tracking. Returns whether it was adopted. */
	private _adoptWorkerIndexingItem(item: any, svcId: string, platform: 'claude' | 'openai'): boolean {
		if (!item || typeof item.id !== 'string' || !item.id) return false;
		if (item.status !== 'pending' && item.status !== 'running') return false;
		if (typeof item.poll !== 'function') return false;
		// Already known: a pass this client dispatched, or one adopted earlier that
		// has not settled yet. Adopting twice would stack a second poll on one item.
		if (this.historyItemPolls.has(item.id)) return false;
		for (var q = 0; q < this.bgTaskQueue.length; q++) {
			if (this.bgTaskQueue[q].id === item.id) return false;
		}
		// Already SETTLED here. The status index is eventually consistent, so the
		// pass that just finished can still come back as running; re-adopting it
		// would re-poll a dead item and, worse, read as the chain continuing.
		for (var m = 0; m < this.state.messages.length; m++) {
			var msg = this.state.messages[m];
			if (msg._serverItemId !== item.id) continue;
			if (!(msg.isPending || msg.isPendingInProcess || msg.isPendingQueued)) return false;
		}
		// The bg queue also carries ordinary chats routed onto it (_isOnBgQueue), and
		// both platforms share one queue name, so check the shape as well: a claude
		// request body has `messages`, an openai one has `input`. Adopting the other
		// platform's item would poll it against this platform's url.
		var body = item.request_body;
		if (!body || typeof body !== 'object') return false;
		if (platform === 'claude' ? !Array.isArray((body as any).messages) : !Array.isArray((body as any).input)) return false;
		var userText = extractLastUserTextFromRequest(body);
		if (!isIndexingRequestText(userText)) return false;
		var ref = parseIndexingRequestText(userText);
		if (!ref || !ref.name) return false;
		// Only chains the worker drives. A client-driven file is already tracked by
		// the entry that dispatched it, and adopting a copy of it would hand
		// maybeResumeIndexing an entry whose resumePass no longer counts that
		// chain's passes — which is the cap that stops it running forever.
		if (!this._isWorkerDrivenIndexing(ref.name, ref.mime)) return false;
		this.bgTaskQueue.push({
			projectId: svcId,
			platform: platform,
			id: item.id,
			filename: ref.name,
			storagePath: ref.path,
			mime: ref.mime,
			size: ref.size,
			status: item.status === 'running' ? 'running' : 'pending',
			poll: item.poll,
			// Drives the "(continuing)" label and marks this as a continuation for
			// _applyIndexCancellations, which must not read a CONTINUE pass as the
			// fresh first pass that lifts a stop.
			resumePass: ref.continued ? 1 : 0,
		});
		return true;
	}

	/** Follow the chain on from a background indexing pass that just settled. */
	private _followWorkerIndexingChain(filename?: string, mime?: string): void {
		if (!this._isWorkerDrivenIndexing(filename, mime)) return;
		this._adoptWorkerIndexingPasses(0);
	}

	/** Best-effort server-side cancel of a bg-queue item that has no bubble (so
	 *  cancelQueuedMessage, which drives one, has nothing to act on). */
	private _cancelServerItem(serverId: string): void {
		var id = this.host.getIdentity();
		if (!serverId || (id.platform !== 'claude' && id.platform !== 'openai')) return;
		var url = id.platform === 'claude' ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
		Promise.resolve(this.host.cancelRequest({
			url: url, method: 'POST', id: serverId,
			queue: bgIndexingQueueName(id.userId, id.projectId),
			service: id.projectId, owner: id.owner,
		})).catch(function () { /* the pass may already have finished; nothing to do */ });
	}

	// Inject "Indexing: <file>" bubbles for queued bg tasks + attach their polls.
	drainBgTaskQueue(): void {
		var self = this;
		var id = this.host.getIdentity();
		var svcId = id.projectId, plat = id.platform;
		if (!svcId || plat === 'none' || !this.host.isViewMounted()) return;
		// Before anything is surfaced: drop continuations of files the user stopped
		// (and let a fresh first pass lift the stop), then cancel any worker-queued
		// pass of a stopped file that reached the chat through history.
		this._applyIndexCancellations();
		this._sweepCancelledIndexing();
		// Index messages by _serverItemId ONCE, so the per-entry presence/pending
		// checks below are O(1) instead of a full messages.some() scan each. With a
		// large bg queue (bulk uploads) the old nested scan was O(queue x messages)
		// per drain, and the drain runs once per uploaded file (O(n^3) overall).
		var presentIds: { [id: string]: boolean } = {};
		var pendingIds: { [id: string]: boolean } = {};
		this.state.messages.forEach(function (m) {
			var sid = m._serverItemId;
			if (sid == null) return;
			presentIds[sid] = true;
			if (m.isPending || m.isPendingInProcess || m.isPendingQueued) pendingIds[sid] = true;
		});
		for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
			var e = this.bgTaskQueue[i];
			if (e.projectId !== svcId || e.platform !== plat) continue;
			if (presentIds[e.id] && !pendingIds[e.id]) {
				// Settled while nobody was polling (hidden tab, dead poll): the
				// answer reached the chat as HISTORY, so no settle handler ever
				// ran for this entry — maybeResumeIndexing's flips included. For
				// a single-pass file that settle IS the whole run; close its
				// records off the settled bubbles' own flags before the entry
				// goes. (8 of 10 files in a real batch hit exactly this.)
				this._flipRunFromSettledEntry(e);
				this.bgTaskQueue.splice(i, 1);
			}
		}
		// Poll budget for this drain (see MAX_CONCURRENT_BG_POLLS). bgTaskQueue is
		// in push order, i.e. oldest first, which is also the order the server
		// settles them in — so spending the budget from the front spends it on the
		// only entries that can resolve next. Bubbles are still injected for EVERY
		// entry; only the polling is rationed, and an unpolled entry picks up a
		// poll on the drain that follows the next resolution.
		var bgPollBudget = MAX_CONCURRENT_BG_POLLS - this._countBgPolls();
		// Set by the injection branch; drives the single render/cache/scroll below.
		var injectedAny = false;
		this.bgTaskQueue.forEach(function (entry) {
			if (entry.projectId !== svcId || entry.platform !== plat) return;
			// Bubble injection and poll attachment are INDEPENDENT. An entry whose bubble
			// already exists may still need a poll — that is exactly the state a paused
			// drain leaves behind, and returning early here stranded it as a permanent
			// "Thinking..." once polling resumed.
			if (!presentIds[entry.id]) {
			var isRunning = entry.status === 'running';
			var userBubble: ChatMessage = {
				role: 'user',
				content: self.host.formatIndexingLabel(entry.filename, entry.mime, entry.size, entry.storagePath, entry.isReindex, !!entry.resumePass),
				isBackgroundTask: true,
				_serverItemId: entry.id,
				// Structured ref so this live pass groups with the same file's passes
				// rebuilt from history (see indexing_groups.buildChatDisplayList).
				_indexFile: {
					name: entry.filename,
					path: entry.storagePath,
					mime: entry.mime,
					size: entry.size,
					isReindex: !!entry.isReindex,
					continued: !!entry.resumePass,
				},
			};
			if (isRunning) userBubble.isPendingInProcess = true; else userBubble.isPendingQueued = true;
			// Directly ABOVE the chat turn these files were attached to, when that turn
			// is still on screen as a staged bubble. The row then appears where it
			// belongs from the start — right before the message the files came with,
			// which is also the order the server reports once the turn is sent (its
			// request id is newer than every pass it waits for). Appending instead put
			// the row BELOW the message and left the turn to be moved down past it at
			// dispatch, minutes later: a swap under the reader, at the one moment they
			// were watching for the turn to go out.
			//
			// -1 (no stage id, or a staged bubble already replaced/rebuilt away) appends,
			// which is the old behaviour and the right one for work with no chat turn
			// behind it: the dbfile page, an attachment-only send, a worker-adopted pass.
			// Resolved PER ENTRY: one drain can inject several passes, and a hoisted
			// index would insert each one before the last and reverse them.
			var stageAt = self._stageIndex(self.state.messages, entry.stageId);
			var runningBubble: ChatMessage | null = isRunning
				? { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: entry.id }
				: null;
			if (stageAt === -1) {
				self.state.messages.push(userBubble);
				if (runningBubble) self.state.messages.push(runningBubble);
			} else if (runningBubble) {
				// One splice, so the request and its placeholder stay ADJACENT: an
				// id-less response bubble is attributed to the message immediately
				// above it (indexing_groups) and replies are spliced at userIdx + 1.
				self.state.messages.splice(stageAt, 0, userBubble, runningBubble);
			} else {
				// AT the staged bubble, so this pass lands after any pass already
				// inserted for the same turn — files keep their upload order.
				self.state.messages.splice(stageAt, 0, userBubble);
			}
			presentIds[entry.id] = true; // keep the index consistent with the pushed bubbles
			// Render/cache/scroll are hoisted OUT of this loop (see injectedAny below).
			// They used to run per injected entry, and updateHistoryCache filters the
			// whole of state.messages into a fresh array each call — so a bulk upload
			// injecting one bubble per file did O(files x messages) element visits and
			// left one throwaway array per file for the GC. In the widget it was worse
			// still: its notify() is a full DOM re-render of the message list. The end
			// state is identical either way; only the discarded intermediate renders
			// are gone.
			injectedAny = true;
			}
			if (bgPollBudget > 0 && !self.isPollingPaused() && !self.historyItemPolls.has(entry.id) && typeof entry.poll === 'function') {
				bgPollBudget--;
				var capturedId = entry.id, capturedPlat = plat;
				var capturedEntry = entry;
				var wasStopped = false;
				var bp = entry.poll({ latency: POLL_INTERVAL });
				self._trackPoll(entry.id, 'bg', bp);
				bp.then(function (response: any) {
					// A stopped poll is not a result: leave the bubble and the queue entry
					// exactly as they were so resumePolling can re-attach.
					if (isPollStopped(response)) { wasStopped = true; return; }
					self.handleHistoryItemResolution(capturedId, response, capturedPlat);
					self.maybeResumeIndexing(capturedEntry, response, capturedPlat);
				}).catch(function (err: any) {
					self.historyItemPolls.delete(capturedId);
					var isNotExists = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
					// Settle the REQUEST bubble first, unconditionally. Only a RUNNING
					// pass gets an assistant placeholder, so for a queued one the lookup
					// below finds nothing and every branch was skipped — leaving the
					// request bubble isPendingQueued with its queue entry about to be
					// spliced away, i.e. no poll left to ever clear it. One such bubble
					// pins the whole collapsed row to "active": a spinner and a Stop
					// button against a dead id, until the page is reloaded.
					self._clearPendingUserBubble(capturedId);
					var bi = self.state.messages.findIndex(function (m) { return m.isPending && m._serverItemId === capturedId; });
					if (bi !== -1) {
						if (isNotExists) self.state.messages.splice(bi, 1);
						else self.state.messages[bi] = { role: 'assistant', content: getErrorMessage(err), isError: true, isBackgroundTask: true, _serverItemId: capturedId };
					} else if (!isNotExists) {
						// No placeholder to turn into the error (a queued pass). Put one
						// after the request bubble so the row reports the failure instead
						// of quietly settling to "Indexed".
						var ui = self.state.messages.findIndex(function (m) { return m.role === 'user' && m._serverItemId === capturedId; });
						if (ui !== -1) {
							self.state.messages.splice(ui + 1, 0, { role: 'assistant', content: getErrorMessage(err), isError: true, isBackgroundTask: true, _serverItemId: capturedId });
						}
					}
					self.host.notify(); self.updateHistoryCache();
					// A pass that FAILED dispatches no continuation on any path, so a
					// CLIENT-driven file is finished either way — let a turn waiting on it
					// look now. Not for a worker-driven one: this catch also fires on a
					// dropped poll, and the worker may have resolved that pass and written
					// the next one regardless. Nudging there would pull the two confirming
					// looks into the window where the new pass is not yet in the status
					// index, which is the same way a nudge on work STARTING went wrong.
					if (!self._isWorkerDrivenIndexing(capturedEntry.filename, capturedEntry.mime)) {
						// Also close the run record: for a CLIENT-driven file a failed
						// pass ends the chain on every path, and a removed row reads as
						// a cancel. Worker-driven files are excluded for the same reason
						// as the nudge — this catch fires on dropped polls too, and the
						// worker may be writing the next pass regardless.
						if (isNotExists) self._flipRunRecord(capturedEntry, 'cancelled');
						else self._flipRunRecord(capturedEntry, 'error', self._runErrorText(err));
						self._nudgeIndexingDrain();
					}
				}).then(function () {
					// Keep the queue entry when the poll was merely stopped, or resuming
					// would have nothing left to re-attach to.
					if (wasStopped) return;
					var qi = self.bgTaskQueue.findIndex(function (q) { return q.id === capturedId; });
					if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
					// This resolution freed a slot in the MAX_CONCURRENT_BG_POLLS budget,
					// so hand it to the next-oldest unpolled entry. Load-bearing under the
					// cap: with thousands of entries queued, only the handful holding
					// polls can ever settle, and without this re-drain the remaining
					// entries would sit unpolled forever. Not left to a host-side watcher
					// on bgTaskQueue — agent.vue has one, the widget does not.
					self.drainBgTaskQueue();
				});
			}
		});
		// One render, one cache write, one scroll for the whole drain — however many
		// bubbles it injected. See the injectedAny comment above.
		if (injectedAny) {
			this.host.notify();
			this.updateHistoryCache();
			this.host.scrollToBottomIfSticky(false);
		}
		this.promoteNextBgQueuedToRunning();
	}

	// Resume-across-passes: if a background INDEXING task for a paged file (spreadsheet or
	// text) finished WITHOUT the completion marker, the agent ran out of room before reading
	// the whole file - dispatch a CONTINUE pass (up to a cap) that resumes from where the
	// already-saved records leave off. Additive + guarded so it never loops forever and
	// never breaks the resolution path.
	//
	// VISION files (PDFs rendered to page images) are NOT resumed here: the proxy worker
	// advances their page window itself, off the renderer's true page count. Driving them
	// from the browser is what used to lose pages on long documents - the chain lived in tab
	// memory (a reload or a closed tab ended it), and it stopped whenever the model claimed
	// completion, which on an 88-page file happened at page 15. Continuing to dispatch here
	// as well would now double-index every window.
	/** Fire the consumer's done::-marker hook for a run whose completion this
	 *  client knows DETERMINISTICALLY (see the two call sites in
	 *  maybeResumeIndexing). Best-effort by contract; identity-checked so a
	 *  project switch mid-settle cannot stamp the wrong service. */
	_mintDoneMarker(entry: BgTaskEntry): void {
		try {
			var mint = chatEngineConfig().mintIndexDoneMarker;
			if (!mint || !entry || !entry.storagePath || !entry.projectId) return;
			var id = this.host.getIdentity();
			if (!id || id.projectId !== entry.projectId) return;
			mint({ service: entry.projectId, storagePath: entry.storagePath });
		} catch (_e) { /* best-effort */ }
	}

	/** Short, storable form of an error body for the run:: record. */
	_runErrorText(response: any): string {
		var msg = '';
		try { msg = String(getErrorMessage(response) || ''); } catch (_e) { }
		msg = msg.replace(/\s+/g, ' ').trim();
		return msg ? msg.slice(0, 300) : 'Indexing failed.';
	}

	/** Close the records of a run whose pass settled OFF-POLL — the answer came
	 *  back as history (hidden tab, dead poll, resume refetch), so none of the
	 *  poll-side settle handlers ran. Only for SINGLE-PASS files, where one
	 *  settled pass is deterministically the whole run (the same contract as
	 *  maybeResumeIndexing's single-pass branch); paged files stay with their
	 *  drivers. Outcome is read from the settled bubbles' own flags, which is
	 *  all the history mapping left us. Best-effort and idempotent throughout. */
	_flipRunFromSettledEntry(entry: BgTaskEntry): void {
		try {
			if (!entry || !entry.storagePath || !entry.id || !entry.projectId) return;
			if (isPagedReadFile(entry.filename, entry.mime)) return;
			// A stopped run's verdict belongs to the stop funnel — never let a
			// late clean settle of its pass relabel 'cancelled' as 'done'.
			if (this.cancelledIndexKeys.has(this._indexKeyOf(entry))) return;
			if (this.state.stoppedIndexIds[entry.id]) return;
			var userMsg: any = null, replyMsg: any = null;
			this.state.messages.forEach(function (m: any) {
				if (m._serverItemId !== entry.id) return;
				if (m.role === 'user') { if (!userMsg) userMsg = m; }
				else if (!replyMsg) replyMsg = m;
			});
			if ((userMsg && userMsg.isCancelled) || (replyMsg && replyMsg.isCancelled)) {
				this._flipRunRecord(entry, 'cancelled');
			} else if (replyMsg && replyMsg.isError) {
				var errText = typeof replyMsg.content === 'string'
					? replyMsg.content.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
				this._flipRunRecord(entry, 'error', errText || 'Indexing failed.');
			} else if (replyMsg) {
				this._mintDoneMarker(entry);
				this._flipRunRecord(entry, 'done');
			}
			// No reply bubble at all: nothing to judge from — leave the record.
		} catch (_e) { /* best-effort */ }
	}

	/** Close the durable run:: record for an ending THIS client observed.
	 *  service comes from the ENTRY, not the current identity: unlike the done::
	 *  mint above, a status flip must land even if the user switched projects
	 *  mid-settle — otherwise the record lies 'working' forever. Best-effort
	 *  through upsertIndexRunRecordSafe; the consumer's precedence guard keeps
	 *  repeats and races harmless. */
	_flipRunRecord(entry: BgTaskEntry, status: IndexRunStatus, error?: string): void {
		if (!entry || !entry.storagePath || !entry.projectId) return;
		var patch: IndexRunPatch = { status: status, finished: Date.now() };
		if (error) patch.error = error;
		upsertIndexRunRecordSafe(entry.projectId, entry.storagePath, patch);
	}

	maybeResumeIndexing(entry: BgTaskEntry, response: any, platform: string): void {
		var self = this;
		// This client is the ONLY driver of the chains that reach the returns below,
		// so its decision not to continue one is authoritative and immediate — the
		// earliest honest "these files are done" a waiting turn can get. Used only to
		// make awaitIndexingDrained look sooner; it still has to agree twice.
		// NOT called for the worker-driven returns further down (the worker may be
		// about to write the next pass) or for a stopped file (its queued passes are
		// still being cancelled).
		var endOfClientChain = function () { self._nudgeIndexingDrain(); };
		try {
			if (!entry || !entry.storagePath) return;
			// The user stopped this file from its collapsed row. Dispatching the next
			// pass here is exactly what "stop" has to prevent — the cancelled pass
			// settles, and without this the chain simply carries on.
			if (this.cancelledIndexKeys.has(this._indexKeyOf(entry))) return;
			if (!isPagedReadFile(entry.filename, entry.mime)) {
				// Single-pass file: one settled pass IS the whole job. This is
				// deterministic knowledge (this client is the only dispatcher),
				// so record the durable done:: marker — single-pass runs never
				// get one from the worker. Errors don't count as completion
				// (this branch sits above the error check on purpose: the chain
				// is over either way, but only success gets a marker), and
				// neither does a CANCELLED poll shape — a row stopped from
				// another tab/device settles through here as {status:
				// 'cancelled', queue fields} with no provider payload, and
				// cancelledIndexKeys only records stops issued from THIS tab.
				if (!isErrorResponseBody(response) && !this._isCancelledPollResult(response)) {
					this._mintDoneMarker(entry);
					this._flipRunRecord(entry, 'done');
				} else if (this._isCancelledPollResult(response)) {
					// Stopped elsewhere (another tab/device): the stopping side
					// usually wrote 'cancelled' already; writing it again is a
					// same-value terminal update, and it closes the record when
					// the stopping tab died before its write landed.
					this._flipRunRecord(entry, 'cancelled');
				} else {
					this._flipRunRecord(entry, 'error', this._runErrorText(response));
				}
				endOfClientChain(); return;
			}
			if (isImageVisionFile(entry.filename, entry.mime)) return; // worker owns this loop (PDF vision)
			// When windowed indexing is on, the WORKER drives the text/grid loop too. The
			// client MUST NOT also resume, or two drivers each enqueue a continuation per
			// pass and the chain FORKS - duplicate records, runaway passes. Same reason
			// PDFs early-return above. Gated on the flag so the old client-driven path is
			// untouched when windowing is off.
			if (windowedIndexingEnabled() && isWindowedReadFile(entry.filename, entry.mime)) return;
			if (isErrorResponseBody(response)) {
				// A failed pass is not "incomplete" — the client-driven chain is over.
				this._flipRunRecord(entry, 'error', this._runErrorText(response));
				endOfClientChain(); return;
			}
			var answer = (platform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response)) || '';
			if (answer.indexOf(INDEXING_COMPLETE_MARKER) !== -1) {
				// Client-driven chain, and the model's reply carried the
				// completion token — the same signal the worker requires before
				// minting for its own chains. Deterministic here: this client
				// is the only dispatcher and it is deciding, right now, that no
				// further pass will run.
				this._mintDoneMarker(entry);
				this._flipRunRecord(entry, 'done');
				endOfClientChain(); return; // fully indexed
			}
			var pass = (entry.resumePass || 0) + 1;
			if (pass > MAX_INDEXING_RESUME_PASSES) {
				// Gave up after the cap: the file is only partially indexed, and no
				// further pass will ever run. 'error' rather than 'done' — the badge
				// must not claim a file the chain abandoned.
				this._flipRunRecord(entry, 'error', 'Stopped after ' + MAX_INDEXING_RESUME_PASSES + ' passes without finishing.');
				endOfClientChain(); return;
			}
			var id = this.host.getIdentity();
			if (!id || id.platform === 'none' || id.projectId !== entry.projectId) {
				// This client is the only driver of this chain and it just declined
				// to dispatch the next pass — the chain is over, as an ending, not a
				// pause: the queue entry is spliced on settle and nothing revisits
				// it. Close the record (it writes with entry.projectId, so it lands
				// after a project switch) or it lies 'working' for the stale window.
				this._flipRunRecord(entry, 'error', 'Indexing stopped: the session or project changed before the file finished.');
				endOfClientChain();
				return;
			}
			// Counted as live work from here, not from the ack: awaitIndexingDrained
			// asks the SERVER what is queued, and this pass is not queued until the
			// call below returns. Without it a chat can slip in between two passes.
			this.trackIndexDispatch(notifyAgentContinueIndexing({
				platform: id.platform as 'claude' | 'openai',
				model: id.model,
				service: id.projectId,
				// Without this the resume pass rebuilds its system prompt from the RAW
				// regional id (requests.ts falls back to `service`), and the model copies
				// that id verbatim into project_id tool calls, which the MCP schema
				// pattern rejects - the whole continue pass saves nothing.
				publicProjectId: id.publicProjectId,
				owner: id.owner,
				userId: id.userId || id.projectId,
				serviceName: id.serviceName,
				serviceDescription: id.serviceDescription,
				attachment: {
					name: entry.filename,
					storagePath: entry.storagePath,
					mime: entry.mime,
					size: entry.size,
					url: '',
				},
			}).then(function (ack: any) {
				if (ack && typeof ack.id === 'string') {
					self.bgTaskQueue.push({
						projectId: id.projectId, platform: id.platform as 'claude' | 'openai', id: ack.id,
						filename: entry.filename, storagePath: entry.storagePath,
						isReindex: entry.isReindex, mime: entry.mime, size: entry.size,
						status: ack.status === 'running' ? 'running' : 'pending',
						poll: ack.poll, resumePass: pass,
						// Deliberately NOT stamped with entry.stageId. Only a batch's FIRST
						// pass anchors to the turn; a continuation appends, which is the
						// order the server queued it in and therefore the order
						// promoteNextBgQueuedToRunning should spin it in. It costs nothing
						// on screen: a continuation is folded into the run whose row
						// already sits above the turn, and renders nothing at its own
						// index (indexing_groups anchors a run at its FIRST loaded pass).
					});
					self.drainBgTaskQueue();
				}
			}, function (e: any) { console.error('[chat-engine] resume-indexing dispatch failed', e); }));
		} catch (e) { /* best-effort: resume must never break bg-task resolution */ }
	}

	// --- history fetch + pagination --------------------------------------
	// Initial load (fetchMore=false) replaces the list (with in-flight rescue +
	// cancelled-merge) and attaches polls to running/pending items; pagination
	// (fetchMore=true) prepends older messages. The DOM scroll-restore for the
	// older-prepend is the VIEW's job (it captures the pre-prepend scroll position
	// and restores after this resolves) — the engine never measures the DOM.
	loadHistory(fetchMore?: boolean, token?: number): Promise<void> {
		var self = this;
		var id = this.host.getIdentity();
		// Key this fetch is FOR, snapshotted from the same identity read the
		// request is built from. The rescue below compares against this rather
		// than a live getHistoryCacheKey(), so a project switch mid-fetch can't
		// make another chat's in-flight bubbles look local.
		var loadKey = (!id.projectId || id.platform === 'none') ? '' : id.projectId + '#' + id.platform;
		if (token === undefined) token = this.state.gateRefreshToken;
		if ((this.state.loadingHistory && this.state.historyRequestToken === token) || id.platform === 'none' || !id.projectId) {
			return Promise.resolve();
		}
		this.state.historyRequestToken = token;
		this.state.loadingHistory = true;
		// A first-page load is the one moment the chat may have changed under us. The
		// old snapshot describes the previous project's queue; keeping it would let a
		// row here claim it was finished on evidence from somewhere else. Re-seeded
		// when this load lands.
		if (!fetchMore && loadKey !== this._liveIndexKey) {
			this._liveIndexKey = loadKey;
			this._resetLiveIndexKeys();
		}
		if (fetchMore) this.state.loadingOlderHistory = true;
		this.host.notify(); // surface "Fetching history..." while it loads
		var platform = id.platform as 'claude' | 'openai';
		var projectId = id.projectId, owner = id.owner;
		var options: any = { fetchMore: fetchMore };
		if (fetchMore && this.state.historyStartKeyHistory.length) options.startKeyHistory = this.state.historyStartKeyHistory.slice();
		// First page: paint the CONVERSATION immediately and let the indexing
		// stubs arrive as a deferred batch (merged below when it lands).
		if (!fetchMore) options.deferBg = true;

		// Split fetch v2: surface (full bodies, bg queue excluded) + bg compact
		// stubs, tiled to the surface page's time window with module-level
		// state (buffering + retry safety) — see getSplitChatHistory. Returns
		// the exact single-fetch shape; startKeyHistory is bookkeeping only.
		var fetchHistory = function () { return getSplitChatHistory({ service: projectId, owner: owner, platform: platform, userId: id.userId }, options); };

		return Promise.resolve().then(fetchHistory).catch(function (err: any) {
			if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(fetchHistory);
			throw err;
		}).then(function (history: any) {
			if (token !== self.state.gateRefreshToken) return;
			var chatList = history && Array.isArray(history.list) ? history.list : [];
			chatList.forEach(function (item: any) {
				if (isBgIndexingQueue(item.queue_name)) {
					// Compact stubs carry the label as request_text — the body
					// never left the server — so classify from whichever form
					// this item arrived in.
					var clsText = item.compact ? item.request_text : extractLastUserTextFromRequest(item.request_body);
					if (isIndexingRequestText(clsText)) item._isBgTask = true;
					else item._isOnBgQueue = true;
				}
			});
			var list = chatList.sort(function (a: any, b: any) {
				var ai = typeof a.id === 'string' ? a.id : '', bi = typeof b.id === 'string' ? b.id : '';
				return ai > bi ? -1 : (ai < bi ? 1 : 0);
			});
			var mapped = mapHistoryListToMessages(list, platform, {
				clearedAt: self.host.getClearedAt(),
				projectId: id.projectId,
				formatIndexingLabel: self.host.formatIndexingLabel,
			}).messages;
			// Re-apply any previously-hydrated compact bodies: a refresh maps
			// fresh stubs, and without this a bubble the user already expanded
			// would silently revert to its 200-char head.
			self.applyHydratedBodies(mapped);

			// Set when a first-page refresh re-prepended already-loaded older pages,
			// so the cursor reset below knows not to rewind to page 1's boundary.
			var keptOlderPages = false;
			// The empty-page-1 keep below was taken ONLY on the strength of a
			// deferred batch still flying — if that batch then proves the chat
			// empty server-side, the kept screen must be let go (see the batch
			// handler), or an emptied transcript is indelible.
			var keptScreenAwaitingBg = false;

			if (fetchMore) {
				// STRIP-THEN-MERGE keyed on SERVER ITEM ID. Incoming bubbles are
				// the fresher server state (queued→running→settled transitions),
				// so existing copies of incoming id|role bubbles are REMOVED first
				// (in-flight cancel flags carried over), then the page merges by
				// item id — ids are creation-ordered and BOTH lists are already
				// id-sorted, unlike _ts (assistant _ts is `updated`, which any
				// long-running turn makes non-monotonic and would misorder the
				// walk). Id-less bubbles on screen (staged/local, always the tail)
				// end the merge region; id-less incoming sorts first (oldest).
				var incomingKeys: any = {};
				mapped.forEach(function (m: any) { if (m._serverItemId) incomingKeys[m._serverItemId + '|' + m.role] = m; });
				var existing = self.state.messages.filter(function (m: any) {
					if (!m._serverItemId) return true;
					var inc = incomingKeys[m._serverItemId + '|' + m.role];
					if (!inc) return true;
					if (m._cancelling) inc._cancelling = m._cancelling;
					if (m._cancelError) inc._cancelError = m._cancelError;
					return false;
				});
				var mergedList: ChatMessage[] = [];
				var pi = 0, ei = 0;
				while (pi < mapped.length && ei < existing.length) {
					var pm: any = mapped[pi], em: any = existing[ei];
					var eid = em._serverItemId;
					if (typeof eid !== 'string') break; // staged/local tail
					var pid = pm._serverItemId;
					if (typeof pid !== 'string' || pid <= eid) { mergedList.push(pm); pi++; }
					else { mergedList.push(em); ei++; }
				}
				while (pi < mapped.length) mergedList.push(mapped[pi++]);
				while (ei < existing.length) mergedList.push(existing[ei++]);
				self.state.messages = mergedList;
			} else if (!mapped.length && history && (history.endOfList === false || (history as any).bgPending)
				&& self.state.messages.some(function (m: any) { return m._ownerKey === undefined || m._ownerKey === loadKey; })) {
				// Empty first page that cannot judge the chat empty: either
				// empty-but-not-end (a pure-bg band past every hop cap), or an
				// empty DEFERRED page whose bg batch is still flying — a chat
				// whose whole conversation rides the bg queue has a genuinely
				// empty surface (endOfList true on a head refresh), and the
				// batch carries everything. REPLACING with it would blank the
				// chat for the batch's flight time — the greeting flashed over
				// real messages on every tab return. Keep what is on screen.
				// Kept ONLY on the batch's word: the batch handler revisits.
				if (history.endOfList !== false) keptScreenAwaitingBg = true;
			} else {
				if (self.state.typing) self.state.typingAbort = true;
				var serverIds: any = {};
				mapped.forEach(function (m: any) { if (m._serverItemId) serverIds[m._serverItemId] = 1; });
				// The retention boundary must be the SURFACE frontier: page 1 also
				// emits bg stubs reaching arbitrarily deep, and keying retention on
				// a weeks-old stub id would wipe (or gap) the scrolled-in pages.
				var surfaceOldestId: string | undefined = undefined;
				mapped.forEach(function (m: any) {
					if (typeof m._serverItemId !== 'string' || m._fromBgChain) return;
					if (surfaceOldestId === undefined || m._serverItemId < surfaceOldestId) surfaceOldestId = m._serverItemId;
				});
				var locallyCancelled: any = {};
				self.state.messages.forEach(function (m) { if (m.isCancelled && m._serverItemId) locallyCancelled[m._serverItemId] = m; });
				// A cancel the server has not acknowledged yet. Without carrying these
				// across the replace, a collapsed row mid-cancel drops its "Stopping..."
				// state and re-offers Stop; the second click cancels an id that is
				// already gone and writes a bogus "Could not remove from queue." onto a
				// run that WAS stopped successfully.
				var inFlightCancel: any = {};
				self.state.messages.forEach(function (m) {
					if (!m._serverItemId) return;
					if (m._cancelling || m._cancelError) inFlightCancel[m._serverItemId] = m;
				});
				// If the freshly-mapped server list ALREADY shows this in-flight turn
				// as a pending placeholder (a non-bg pending assistant, which carries
				// a real _serverItemId), re-pushing the local no-_serverItemId
				// user+Thinking would DUPLICATE it. Each resolve path only clears the
				// first pending bubble, so the duplicate strands a "Thinking…" beside
				// the reply/error. There is at most one in-flight regular turn, so a
				// mapped pending assistant IS this turn — skip the redundant local copy.
				var mappedHasPendingAssistant = mapped.some(function (m: any) {
					return m.isPending && m.role === 'assistant' && !m.isBackgroundTask;
				});
				// One rule, shared with agent.vue's own fetchHistoryPage — see
				// shouldRescueInFlightMessage for what it decides and why.
				var rescued: ChatMessage[] = [];
				for (var ri = 0; ri < self.state.messages.length; ri++) {
					var mm = self.state.messages[ri];
					if (shouldRescueInFlightMessage(mm, {
						hasServerId: function (sid) { return !!serverIds[sid]; },
						pageHasPendingAssistant: mappedHasPendingAssistant,
						sending: !!self.state.sending,
						next: self.state.messages[ri + 1],
						loadKey: loadKey,
					})) rescued.push(mm);
				}
				// PRESERVE already-loaded older pages. `mapped` is only page 1, so a
				// blind replace threw away every page the user had scrolled in. This
				// path runs from resumePolling (visibilitychange), so merely leaving
				// the tab and coming back wiped the whole scrolled-in history.
				//
				// The list is oldest-first (fetchMore PREPENDS), and ids sort with
				// newest largest, so anything already in the list whose _serverItemId
				// sorts BELOW page 1's oldest id is an older page. Those are disjoint
				// from `mapped` (strict <), so re-prepending cannot duplicate.
				var oldestInPage1: string | undefined = undefined;
				mapped.forEach(function (m: any) {
					var sid = m._serverItemId;
					if (typeof sid !== 'string') return;
					if (oldestInPage1 === undefined || sid < (oldestInPage1 as string)) oldestInPage1 = sid;
				});
				// Only merge when the current list is genuinely a continuation of THIS
				// page 1 (shares at least one id with it). A project switch, a cleared
				// horizon, or a wholly-new page means the head is unrelated history and
				// must be replaced, not spliced.
				var sharesPage1 = self.state.messages.some(function (m) {
					return typeof m._serverItemId === 'string' && !!serverIds[m._serverItemId as string];
				});
				var deferredBg = !!(history && (history as any).bgPending);
				// Boundary for retention: the SURFACE frontier when page 1 has any
				// surface item (bg stubs can reach weeks deeper and would otherwise
				// wipe or gap the scrolled-in pages); whole-page oldest only as the
				// fallback for a surface-empty page.
				var retainBoundary: string | undefined = surfaceOldestId !== undefined ? surfaceOldestId : oldestInPage1;
				var retainedOlder: ChatMessage[] = (!sharesPage1 || retainBoundary === undefined) ? [] : self.state.messages.filter(function (m) {
					// Settled server history only; in-flight bubbles are the rescue
					// loop's job below and would otherwise be kept twice.
					if (typeof m._serverItemId !== 'string') return false;
					// Same ownership predicate as the rescue loop: never carry another
					// project's bubbles onto this chat (the cross-project leak fix).
					// Compare against the snapshotted loadKey, never a live read.
					if (m._ownerKey !== undefined && m._ownerKey !== loadKey) return false;
					// While a deferred stub batch is in flight, KEEP already-loaded
					// indexing bubbles wherever they sit — the surface-only page has
					// none, and dropping them here would flicker every row until the
					// batch lands (its apply strips+re-merges them by id anyway).
					if (deferredBg && m.isBackgroundTask) return true;
					// Bg-chain bubbles already on screen stay put regardless of the
					// boundary — their ids interleave with deep history and the strip
					// in later merges replaces them when fresher copies arrive.
					if (m._fromBgChain) return true;
					return (m._serverItemId as string) < (retainBoundary as string);
				});
				// Prepend only the STRICTLY-older bubbles. Retained bg bubbles whose
				// ids sit inside page 1's own range are ID-MERGED into it instead —
				// blanket prepending hoisted every indexing row above the whole
				// conversation, and after a head refresh the single-page batch
				// never re-placed the deep ones, so they sat hoisted for good.
				var prependOlder: ChatMessage[] = [];
				var interleave: ChatMessage[] = [];
				retainedOlder.forEach(function (m) {
					var sid = m._serverItemId as string;
					if (serverIds[sid]) return; // page 1 carries a fresher copy
					if (retainBoundary !== undefined && sid < (retainBoundary as string)) prependOlder.push(m);
					else interleave.push(m);
				});
				var page1: ChatMessage[] = mapped;
				if (interleave.length) {
					// Both sides are id-sorted oldest-first (retention preserves the
					// on-screen order; the mapper emits oldest-first).
					var mergedP: ChatMessage[] = [];
					var ii2 = 0, mi2 = 0;
					while (ii2 < interleave.length && mi2 < mapped.length) {
						var iv: any = interleave[ii2], mv: any = mapped[mi2];
						var mid2 = typeof mv._serverItemId === 'string' ? mv._serverItemId : undefined;
						if (mid2 === undefined) break; // defensive: id-less tail
						if ((iv._serverItemId as string) <= mid2) { mergedP.push(iv); ii2++; }
						else { mergedP.push(mv); mi2++; }
					}
					while (ii2 < interleave.length) mergedP.push(interleave[ii2++]);
					while (mi2 < mapped.length) mergedP.push(mapped[mi2++]);
					page1 = mergedP;
				}
				keptOlderPages = prependOlder.length > 0 || interleave.length > 0;
				self.state.messages = prependOlder.length ? prependOlder.concat(page1) : page1;
				rescued.forEach(function (m) {
					// Rescue can now carry a bubble that has a server id, and the
					// retained-older merge above carries ids too. One turn must not
					// arrive down both routes.
					if (m._serverItemId && self.state.messages.some(function (x) {
						return x._serverItemId === m._serverItemId && x.role === m.role;
					})) return;
					self.state.messages.push(m);
				});
				if (Object.keys(locallyCancelled).length) {
					for (var ci = 0; ci < self.state.messages.length; ci++) {
						var c = self.state.messages[ci];
						if (!c._serverItemId || !locallyCancelled[c._serverItemId] || c.isCancelled) continue;
						// Rebuild FROM the mapped bubble rather than as a bare literal:
						// dropping isBackgroundTask / _indexFile here ejected a stopped
						// indexing pass from its file's collapsed row, where it then rendered
						// as a standalone "Indexing: <file>" chat bubble and left the row
						// recomputing its passes as if that one had never happened.
						self.state.messages[ci] = {
							role: 'user', content: c.content, isCancelled: true, _serverItemId: c._serverItemId,
							isBackgroundTask: c.isBackgroundTask, _indexFile: c._indexFile,
							_useBgQueue: c._useBgQueue, _ownerKey: c._ownerKey,
						};
						if (ci + 1 < self.state.messages.length && self.state.messages[ci + 1].isPending && self.state.messages[ci + 1]._serverItemId === c._serverItemId) {
							self.state.messages.splice(ci + 1, 1);
						}
					}
				}
				// Re-stamp a cancel that is still in flight (see inFlightCancel above).
				// Only onto a bubble the server still reports as pending — once it has
				// settled the flags describe nothing the user can act on.
				for (var fi = 0; fi < self.state.messages.length; fi++) {
					var fm = self.state.messages[fi];
					var was = fm._serverItemId && inFlightCancel[fm._serverItemId];
					if (!was || fm.isCancelled) continue;
					if (!(fm.isPendingQueued || fm.isPendingInProcess || fm.isPending)) continue;
					if (was._cancelling) fm._cancelling = true;
					if (was._cancelError) fm._cancelError = was._cancelError;
				}
			}
			// Only adopt page 1's cursor when page 1 IS the whole list. If older pages
			// survived the merge, rewinding here would make the next scroll-up
			// re-fetch page 2 (already on screen) and duplicate it.
			if (!keptOlderPages) {
				self.state.historyEndOfList = !!(history && history.endOfList);
				self.state.historyStartKeyHistory = history && Array.isArray(history.startKeyHistory) ? history.startKeyHistory : [];
				var clearedAt = self.host.getClearedAt();
				if (clearedAt) {
					// SURFACE items only: page 1 also carries bg stubs reaching far
					// past the horizon, and reading their age as "the frontier is
					// pre-horizon" falsely ended the pager with post-horizon surface
					// pages still unfetched.
					var surfaceItems = chatList.filter(function (it: any) { return !(it && it._fromBgChain); });
					if (surfaceItems.length > 0) {
						var oldestUpdated = Number(surfaceItems[surfaceItems.length - 1] && surfaceItems[surfaceItems.length - 1].updated);
						if (isFinite(oldestUpdated) && oldestUpdated <= clearedAt) self.state.historyEndOfList = true;
					}
				}
			}
			// Clear loading flags BEFORE this render so the final paint is
			// indicator-free (and the view's scroll-restore math sees matching heights).
			if (self.state.historyRequestToken === token) { self.state.loadingHistory = false; self.state.loadingOlderHistory = false; }
			self.updateHistoryCache();
			self.host.notify();

			// ── deferred indexing-stub batch (first-paint split) ──────────────
			// The conversation is already on screen; when the stub batch lands it
			// is classified/mapped like any page and STRIP-THEN-MERGED: existing
			// copies of incoming ids are removed first (retained rows may sit at
			// provisional positions), then the batch merges by timestamp.
			var bgPending = !fetchMore && history && (history as any).bgPending;
			if (bgPending) {
				// Ownership id for the shared loading flag: a same-token refetch can
				// mint a SECOND bgPending, and the older handler settling later must
				// not clear (or keep) the flag the newer batch owns.
				var batchId = ++_bgHistoryBatchSeq;
				// SILENT unless this is the chat's genuine FIRST PAINT. Two quiet
				// cases: an ended chain's head refresh (endOfList already true),
				// and a MID-WALK tab return — the walk restarts for cursor
				// safety, but the conversation is already on screen and flashing
				// "Loading indexing history" over it on every return was the
				// reported bug. Only a never-walked chat announces the batch.
				if (history.endOfList !== true && (history as any).firstLoad === true) {
					self.state.bgHistoryLoading = true;
					self.host.notify();
				}
				var releaseBgFlag = function () {
					if (_bgHistoryBatchSeq === batchId) self.state.bgHistoryLoading = false;
				};
				(bgPending as Promise<any>).then(function (batch: any) {
					if (token !== self.state.gateRefreshToken) { releaseBgFlag(); return; }
					var bList: any[] = (batch && Array.isArray(batch.list)) ? batch.list : [];
					bList.forEach(function (item: any) {
						if (isBgIndexingQueue(item.queue_name)) {
							var t = item.compact ? item.request_text : extractLastUserTextFromRequest(item.request_body);
							if (isIndexingRequestText(t)) item._isBgTask = true;
							else item._isOnBgQueue = true;
						}
					});
					var sorted = bList.sort(function (a: any, b: any) {
						var ai = typeof a.id === 'string' ? a.id : '', bi = typeof b.id === 'string' ? b.id : '';
						return ai > bi ? -1 : (ai < bi ? 1 : 0);
					});
					var m2 = mapHistoryListToMessages(sorted, platform, {
						clearedAt: self.host.getClearedAt(),
						projectId: id.projectId,
						formatIndexingLabel: self.host.formatIndexingLabel,
					}).messages;
					self.applyHydratedBodies(m2);
					if (keptScreenAwaitingBg && !m2.length && batch && batch.endOfList === true) {
						// The empty page 1 was kept ONLY on this batch's word — and it
						// just proved the chat empty server-side (an emptied/cleared
						// transcript). Let the kept screen go: drop this chat's settled
						// server bubbles, keep staged and in-flight local work and any
						// other chat's strays for their own reconcilers, and remember
						// the end. Without this the stale transcript was indelible and
						// even re-persisted itself into the history cache.
						self.state.messages = self.state.messages.filter(function (m: any) {
							if (typeof m._serverItemId !== 'string') return true;
							if (m._ownerKey !== undefined && m._ownerKey !== loadKey) return true;
							return false;
						});
						self.state.historyEndOfList = true;
						releaseBgFlag();
						self.updateHistoryCache();
						self.host.notify();
						return;
					}
					var incoming: any = {};
					m2.forEach(function (m: any) { if (m._serverItemId) incoming[m._serverItemId + '|' + m.role] = true; });
					var baseList = self.state.messages.filter(function (m: any) { return !(m._serverItemId && incoming[m._serverItemId + '|' + m.role]); });
					var mergedList: ChatMessage[] = [];
					var pi2 = 0, ei2 = 0;
					while (pi2 < m2.length && ei2 < baseList.length) {
						var pm2: any = m2[pi2], em2: any = baseList[ei2];
						var eid2 = em2._serverItemId;
						if (typeof eid2 !== 'string') break; // staged/local tail
						var pid2 = pm2._serverItemId;
						if (typeof pid2 !== 'string' || pid2 <= eid2) { mergedList.push(pm2); pi2++; }
						else { mergedList.push(em2); ei2++; }
					}
					while (pi2 < m2.length) mergedList.push(m2[pi2++]);
					while (ei2 < baseList.length) mergedList.push(baseList[ei2++]);
					self.state.messages = mergedList;
					if (batch && batch.endOfList === true) self.state.historyEndOfList = true;
					releaseBgFlag();
					self.updateHistoryCache();
					self.host.notify();
					// The other half of the refresh. Everything this batch brought in
					// sits ABOVE or AMONG the newest turn, so a reader pinned to the
					// bottom was left stranded above it by exactly the batch's height,
					// with nothing to put them back (every scroll-anchor method no-ops
					// while pinned, and this handler ended here).
					if (self.host.settleScroll) self.host.settleScroll();
				}, function () {
					// Stubs missing until the next refresh re-asks; never fatal.
					releaseBgFlag();
					self.host.notify();
				});
			}

			if (!fetchMore) {
				// Ration BACKGROUND polls here exactly as the drain does (see
				// MAX_CONCURRENT_BG_POLLS); foreground items — a reply the user is
				// waiting on — are never rationed. The allow-set is taken from the
				// OLDEST bg items: ids sort with newest largest (the same ordering the
				// older-page merge above relies on) and the server settles a queue
				// FIFO, so the oldest are the only ones that can resolve next. Taking
				// the newest instead would wedge the batch — they cannot settle until
				// everything ahead of them has, and nothing ahead would hold a poll.
				var bgAllow: { [id: string]: boolean } = {};
				var bgHistBudget = MAX_CONCURRENT_BG_POLLS - self._countBgPolls();
				if (bgHistBudget > 0) {
					var bgIds = chatList.filter(function (it: any) {
						if (it.status !== 'running' && it.status !== 'pending') return false;
						if (!it.poll || !it.id) return false;
						if (!(it._isBgTask || it._isOnBgQueue)) return false;
						return !self.historyItemPolls.has(it.id);
					}).map(function (it: any) { return it.id as string; }).sort();
					for (var ba = 0; ba < bgIds.length && ba < bgHistBudget; ba++) bgAllow[bgIds[ba]] = true;
				}
				chatList.forEach(function (item: any) {
					if (item.status !== 'running' && item.status !== 'pending') return;
					if (!item.poll || !item.id) return;
					// Every live poll registers its item id in historyItemPolls — an
					// immediate dispatch (dispatchAgentRequest ~123), a queued send
					// (~253), a bg task (drain), or an earlier history poll — so the
					// has() check below already skips exactly the items a live poll
					// covers (including the one the current dispatch is polling). Do NOT
					// additionally skip every OTHER running/pending item just because
					// some immediate dispatch is in flight: that dispatch polls only ITS
					// item, so blanket-skipping stranded a concurrent "-bg" indexing item
					// (a separate server queue runs in parallel) — or any item whose own
					// poll had since died — with no live poller, leaving a "Thinking..."
					// that never clears even after the server settled everything.
					if (self.historyItemPolls.has(item.id)) return;
					// An in-flight immediate dispatch polls its own MAIN-QUEUE item but
					// registers that id in historyItemPolls only AFTER its provider POST
					// returns; in the sliver before that, a remount can surface the item
					// here still unregistered. Skip re-polling MAIN-QUEUE items while a
					// dispatch is in flight so we don't stack a 2nd poll on the item the
					// dispatch is about to poll. Bg-queue items (_isBgTask indexing tasks
					// and _isOnBgQueue chats) run on a SEPARATE queue the immediate
					// dispatch never polls, so they MUST still get their poll — skipping
					// them was the stranded-"Thinking" bug this guard must not revive.
					if (self.pendingAgentRequests[self.getHistoryCacheKey()] && !item._isBgTask && !item._isOnBgQueue) return;
					// Background indexing polls are suppressed while paused; foreground
					// replies the user is waiting on are not.
					if ((item._isBgTask || item._isOnBgQueue) && self.isPollingPaused()) return;
					// Over the bg poll budget: leave this one unpolled. The drain picks
					// it up once an attached poll settles and frees a slot.
					if ((item._isBgTask || item._isOnBgQueue) && !bgAllow[item.id]) return;
					var capturedId = item.id;
					var isBg = !!(item._isBgTask || item._isOnBgQueue);
					// A foreground item here is a reply the user is still waiting on (a reload or a tab
					// return re-attaches it), so it gets the same early probe as a fresh send. Background
					// items keep the flat cadence: nobody is watching, and they are what the
					// MAX_CONCURRENT_BG_POLLS budget exists to protect.
					var pollOpts = {
						onResponse: function (response: any) { if (isPollStopped(response)) return; self.handleHistoryItemResolution(capturedId, response, platform); },
						onError: function (err: any) {
							self.historyItemPolls.delete(capturedId);
							var isNotExists = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
							var aIdx = self.state.messages.findIndex(function (m) { return m.isPending && m._serverItemId === capturedId; });
							if (isNotExists) {
								var uIdx = self.state.messages.findIndex(function (m) { return m.role === 'user' && m._serverItemId === capturedId && !m.isCancelled; });
								// Decide bg-ness from whichever bubble actually exists. A
								// QUEUED pass has no assistant placeholder (history.ts emits
								// none), so reading it off the placeholder alone classified
								// every queued indexing pass as foreground: the rebuild below
								// then dropped isBackgroundTask/_indexFile, ejecting the pass
								// from its collapsed row as a raw "Indexing: <file>" chat
								// bubble, and promoteNextQueuedToRunning span up a "Thinking..."
								// on an unrelated queued FOREGROUND message.
								var isBg = (aIdx !== -1 && !!self.state.messages[aIdx].isBackgroundTask)
									|| (uIdx !== -1 && !!self.state.messages[uIdx].isBackgroundTask);
								if (aIdx !== -1) self.state.messages.splice(aIdx, 1);
								if (!isBg) {
									if (uIdx !== -1) { var ex = self.state.messages[uIdx]; self.state.messages[uIdx] = { role: 'user', content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId }; }
									self.cancelledServerIds.delete(capturedId); self.promoteNextQueuedToRunning();
								} else if (uIdx !== -1) {
									// Same carry-over every other rebuild does, so the pass stays
									// a member of its file's row while reading as cancelled.
									var bex = self.state.messages[uIdx];
									var bcancelled: ChatMessage = { role: 'user', content: bex.content, isCancelled: true, isBackgroundTask: true, _serverItemId: bex._serverItemId };
									if (bex._indexFile) bcancelled._indexFile = bex._indexFile;
									if (bex._useBgQueue) bcancelled._useBgQueue = true;
									self.state.messages[uIdx] = bcancelled;
									self.promoteNextBgQueuedToRunning();
								}
								self.host.notify(); self.updateHistoryCache(); return;
							}
							if (aIdx !== -1) {
								var wasBg = self.state.messages[aIdx].isBackgroundTask;
								self.state.messages[aIdx] = { role: 'assistant', content: getErrorMessage(err), isError: true };
								if (wasBg) self.state.messages[aIdx].isBackgroundTask = true;
								self.host.notify(); self.updateHistoryCache();
							}
						},
					};
					var pp = isBg
						? item.poll(Object.assign({ latency: POLL_INTERVAL }, pollOpts))
						: self._fgPollWithEarlyProbe(item, capturedId, pollOpts);
					// Anything on the BACKGROUND queue is pausable, not just items whose
					// prompt text we recognise as an indexing task. _isBgTask vs
					// _isOnBgQueue is a DISPLAY distinction ("Indexing: file" vs a normal
					// chat bubble); keying the pause off _isBgTask alone left every
					// bg-queue item we could not text-match polling forever.
					self._trackPoll(capturedId, (item._isBgTask || item._isOnBgQueue) ? 'bg' : 'fg', pp);
					if (pp && pp.catch) pp.catch(function () { });
				});
				self.drainBgTaskQueue();
			}

			// Learn which files the queue is still working on. Only on a FIRST page:
			// this describes the whole queue, not the page, so paging older history
			// would re-ask for an answer that has not changed.
			if (!fetchMore) self.refreshLiveIndexState();

			// Sticky, NOT forcing: this runs after every first-page load, including
			// the one resumePolling fires on visibilitychange. Forcing yanked a
			// reader who had scrolled up back to the bottom. On a genuine mount the
			// user is still pinned, so this behaves identically there.
			//
			// settleScroll when the host has one: it makes the same decision, and it
			// is also called again once the deferred bg batch merges, so a pinned
			// reader lands on the REAL bottom instead of the surface page's.
			if (!fetchMore) return self.host.settleScroll ? self.host.settleScroll() : self.host.scrollToBottomIfSticky();
		}).catch(function (err: any) {
			console.warn('[chat-engine] getChatHistory failed', err);
		}).then(function () {
			if (self.state.historyRequestToken === token) {
				var wasLoading = self.state.loadingHistory || self.state.loadingOlderHistory;
				self.state.loadingHistory = false; self.state.loadingOlderHistory = false;
				if (wasLoading) self.host.notify();
			}
			// Every first-page load ends here — mount, resumePolling, a cache-restore
			// refresh — and every one of them can leave a box too short to scroll,
			// which is the only trigger there is for reaching page 2. The view (which
			// alone can measure) pages its way out of it. Fired after the flags are
			// cleared so the fill loop does not see a request still in flight.
			if (self.host.onHistoryLoaded) self.host.onHistoryLoaded(!!fetchMore, token as number);
		});
	}

	// --- attachment upload orchestration ---------------------------------
	// Upload one attachment (a file = 1 member, a folder = N) to db storage and
	// queue indexing per member. The bytes I/O + chip rendering go through host
	// hooks; the overwrite/reindex flow, status lifecycle, and indexing live here.
	uploadSingleAttachment(att: any, stageId?: string): Promise<Array<{ name: string; url: string; storagePath: string }>> {
		var self = this;
		var id = this.host.getIdentity();
		// progress stays null until the first byte-progress event. Every upload
		// opens with a get-signed-url round trip that reports nothing, so a chip
		// initialised to 0 rendered an empty, motionless bar for the whole
		// preparing phase and read as hung. null is the signal for "preparing"
		// (barber pole); a number means bytes are actually moving (real bar).
		att.status = 'uploading'; att.progress = null; att.errorMessage = '';
		att.errorCode = ''; att.errorDetail = ''; // clear any prior failure (retry)
		this.host.renderAttachmentChips();
		var members = (att.kind === 'folder')
			? (att.files || []).map(function (f: any) { return { file: f.file, relPath: f.path, storagePath: self.host.storagePathFor(f.path) }; })
			: [{ file: att.file, relPath: att.name, storagePath: this.host.storagePathFor(att.name) }];
		var total = members.length;
		if (!total) return Promise.reject(new Error('Empty attachment'));
		var urls: Array<{ name: string; url: string; storagePath: string }> = [];
		var anyIndexFailed = false;
		var chain: Promise<any> = Promise.resolve();
		members.forEach(function (member: any, idx: number) {
			chain = chain.then(function () {
				var hadExists = false;
				var skipped = false;
				// True when the file already existed and we are re-indexing over it
				// (user chose Reindex, OR Overwrite replaced the bytes). Drives the
				// delete-then-repost of the stale "src::" record below. Kept separate
				// from hadExists, which must keep driving ONLY the Reindexing/Indexing
				// label (isReindex) — overwrite still labels as "Indexing:".
				var existedBefore = false;
				var onProg = function (p: any) {
					if (p && p.total) {
						att.progress = Math.floor(((idx + p.loaded / p.total) / total) * 100);
						self.host.renderAttachmentChips();
					}
				};
				var doMemberUpload = function (checkExistence: boolean) {
					return self.host.uploadFile({
						file: member.file, storagePath: member.storagePath, checkExistence: checkExistence,
						onProgress: onProg, setAbort: function (abort) { att._abort = abort; },
					});
				};
				return doMemberUpload(true).catch(function (err: any) {
					var code = err && (err.code || (err.body && err.body.code));
					var msg = err && (err.message || (err.body && err.body.message) || (typeof err === 'string' ? err : ''));
					var isExists = code === 'EXISTS' || (msg && /exist/i.test(msg));
					if (!isExists) throw err; // a member upload failed → whole attachment fails (red)
					return self.host.promptOverwrite(member.file.name).then(function (choice) {
						if (choice === 'overwrite') {
							existedBefore = true;
							// The bytes at this path are about to change while the
							// path itself does not, so the browser-cached mint for
							// it would keep handing back the old signed url and the
							// old cached body. This is the one place that knows,
							// so it marks the path for a refreshed mint.
							markImagePreviewStale(self.host.getIdentity().projectId || 'default', member.storagePath);
							return doMemberUpload(false); // replace the existing file
						}
						if (choice === 'skip') { skipped = true; return; } // leave it untouched; no upload/index
						hadExists = true; existedBefore = true; // keep it; Reindex
					});
				}).then(function () {
					if (skipped) return; // user skipped this member — no url, no index request
					return self.host.getTemporaryUrl(member.storagePath);
				}).then(function (url: string) {
					if (skipped) return; // guard the indexing branch for a skipped member
					urls.push({ name: member.relPath, url: url, storagePath: member.storagePath });
					if (att.kind !== 'folder') { att.uploadedUrl = url; att.storagePath = member.storagePath; }
					var mime = member.file.type || self.host.getMimeType(member.file.name);
					// Delete-then-repost: when the file already existed (Reindex or
					// Overwrite), delete the stale "src::<storagePath>" index record
					// first — the skapi backend cascades the delete to its
					// reference-linked children — so re-indexing REPLACES rather than
					// colliding/duplicating. Awaited before the index request is
					// enqueued. Best-effort + optional-hook guarded: a missing record,
					// a permission error, or a host without the hook must not block
					// indexing.
					// Then CREATE the file record before any pass is enqueued. Ordering matters: the
					// delete above wipes it (and cascades to its rows), so creating first would just
					// delete what we made. Every pass references "src::<path>", and a pass is a
					// separate model turn that cannot know whether an earlier one created it, so
					// guaranteeing it here is what stops the backend rejecting whole windows with
					// NOT_EXISTS on reference.unique_id.
					// Already being indexed: a second run would open a second collapsed row
					// for the same file and re-read the whole document. Decided BEFORE the
					// delete-then-repost, which would otherwise wipe the records the LIVE
					// run has already written and then not re-index them. Asked of the
					// QUEUE, not just this page — see isIndexRunLive.
					var alreadyIndexing = false;
					var preIndex = self.claimIndexRun(member.storagePath).then(function (claimed) {
						alreadyIndexing = !claimed;
						if (alreadyIndexing) {
							console.log('[chat-engine] skipping a duplicate index request for', member.storagePath);
							return;
						}
						if (existedBefore && typeof self.host.deleteExistingFileRecord === 'function') {
							return Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function () { });
						}
					});
					preIndex = preIndex.then(function () {
						if (alreadyIndexing) return;
						if (typeof self.host.ensureFileIndexRecord !== 'function') return;
						return Promise.resolve(self.host.ensureFileIndexRecord(member.storagePath, {
							name: member.file.name,
							mime: mime || undefined,
							size: member.file.size,
						})).catch(function () { });
					});
					// Run a client-side attachment parser (e.g. .hwp) if one matches; its
					// output is inlined into the indexing request (falls back to office
					// extraction / web_fetch when no parser matches or it yields nothing).
					return preIndex.then(function () {
						return parseAttachmentContent(member.file, member.file.name, mime || undefined);
					}).then(function (parsedContent: string | null) {
					if (alreadyIndexing) return;
					// Tracked so a chat waiting on awaitIndexingDrained cannot be sent
					// in the window between this call and the queue accepting it.
					return self.trackIndexDispatch(notifyAgentSaveAttachment({
						platform: id.platform as 'claude' | 'openai',
						model: id.model,
						service: id.projectId,
						publicProjectId: id.publicProjectId,
						owner: id.owner,
						userId: id.userId || id.projectId,
						serviceName: id.serviceName,
						serviceDescription: id.serviceDescription,
						attachment: {
							name: member.file.name, storagePath: member.storagePath,
							mime: mime || undefined, size: member.file.size, url: url,
						},
						parsedContent: parsedContent || undefined,
					}).then(function (ack: any) {
						if (ack && typeof ack.id === 'string') {
							self.bgTaskQueue.push({
								projectId: id.projectId, platform: id.platform as 'claude' | 'openai', id: ack.id,
								filename: member.file.name,
								storagePath: member.storagePath,
								isReindex: hadExists,
								mime: mime || undefined,
								size: member.file.size,
								status: ack.status === 'running' ? 'running' : 'pending',
								poll: ack.poll,
								// Puts this file's row directly above the chat turn it was
								// attached to (drainBgTaskQueue). Undefined for an
								// attachment-only send, which appends.
								stageId: stageId,
							});
							self.drainBgTaskQueue(); // surface "Indexing: <file>" as soon as THIS file uploads
						}
					}, function (e: any) {
						console.error('[chat-engine] indexing request failed', e);
						// Nothing was queued, so hand the slot back: the retry (a later
						// send of the same chip) must not be refused by this client's own
						// claim. See claimIndexRun.
						self.releaseIndexRun(member.storagePath);
						anyIndexFailed = true; // uploaded but not indexed → yellow
						// Record the first index error's code/message for the report dialog.
						if (!att.errorCode && !att.errorDetail) {
							att.errorCode = (e && (e.code || (e.body && e.body.code))) || '';
							att.errorDetail = (e && (e.message || (e.body && e.body.message))) || (typeof e === 'string' ? e : '');
						}
					}));
					});
				});
			});
		});
		return chain.then(function () {
			att._abort = null; att.progress = 100;
			if (att.kind === 'folder') att.uploadedUrls = urls.map(function (u) { return { path: u.name, url: u.url, storagePath: u.storagePath }; });
			att.status = anyIndexFailed ? 'indexError' : 'done';
			if (att.status === 'indexError') att.errorMessage = 'File indexing failed';
			self.host.renderAttachmentChips();
			return urls;
		});
	}

	// Upload all not-yet-done attachments sequentially. Resolves to the full
	// list of { name, url, storagePath } for composing the chat message.
	//
	// `batchId` scopes the run to the chips stamped with it at Send time. The
	// composer stays live during an upload, so by the time this runs the
	// attachment list can already hold chips the user picked for the NEXT
	// message — uploading those here would attach them to the wrong turn, and
	// collecting the previous batch's finished urls would attach files the user
	// already sent. Omitted (no batch) means every chip, the old behavior.
	//
	// `stageId` is the turn these chips were attached to, carried onto every indexing
	// task so its collapsed row renders directly ABOVE that turn's bubble (see
	// BgTaskEntry.stageId). Omitted for an attachment-only send, which has no turn.
	uploadPendingAttachments(batchId?: string, stageId?: string): Promise<Array<{ name: string; url: string; storagePath?: string }>> {
		var self = this;
		this.host.resetOverwriteBatch();
		this._uploadBatches += 1;
		this.state.uploadingAttachments = true;
		this.host.updateComposerControls();
		this.host.renderAttachmentChips();
		var collected: Array<{ name: string; url: string; storagePath?: string }> = [];
		var snapshot = this.state.attachments.filter(function (a: any) {
			return batchId ? a._batchId === batchId : true;
		});
		var chain: Promise<any> = Promise.resolve();
		snapshot.forEach(function (att: any) {
			chain = chain.then(function () {
				if (!self.state.attachments.some(function (a: any) { return a.id === att.id; })) return; // removed
				if (att.status === 'done' || att.status === 'indexError') {
					if (att.kind === 'folder' && att.uploadedUrls) {
						att.uploadedUrls.forEach(function (u: any) { collected.push({ name: u.path, url: u.url, storagePath: u.storagePath }); });
						return;
					}
					if (att.uploadedUrl) { collected.push({ name: att.name, url: att.uploadedUrl, storagePath: att.storagePath }); return; }
				}
				return self.uploadSingleAttachment(att, stageId).then(function (us) {
					collected.push.apply(collected, us);
				}).catch(function (err: any) {
					var removed = !self.state.attachments.some(function (a: any) { return a.id === att.id; });
					var aborted = err && (err.message === 'Aborted' || err === 'Aborted');
					if (removed || aborted) return;
					att.status = 'error';
					att.errorMessage = 'File upload has failed';
					// Preserve the original error code/message for the report dialog.
					att.errorCode = (err && (err.code || (err.body && err.body.code))) || '';
					att.errorDetail = (err && (err.message || (err.body && err.body.message))) || (typeof err === 'string' ? err : '');
					self.host.renderAttachmentChips();
				});
			});
		});
		var done = function () {
			self._uploadBatches = Math.max(0, self._uploadBatches - 1);
			// Only the LAST batch standing clears the flag — a second send made
			// while this one was uploading is still running.
			self.state.uploadingAttachments = self._uploadBatches > 0;
			self.host.updateComposerControls(); self.host.renderAttachmentChips();
			return collected;
		};
		return chain.then(done, done);
	}

	// Stop timers / abort the typewriter (view teardown).
	stop(): void {
		this.state.typingAbort = true;
	}

	// Bump the gate token so any in-flight immediate-send result is dropped
	// (called by the view on a service/platform switch or history clear).
	bumpGate(): void {
		this.state.gateRefreshToken += 1;
	}
}
