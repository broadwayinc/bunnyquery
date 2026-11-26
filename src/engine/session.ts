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
	STREAM_POLL_INTERVAL,
	MAX_CONCURRENT_BG_POLLS,
	bgIndexingQueueName,
	isBgIndexingQueue,
	buildHistoryItemFullId,
	ANTHROPIC_MESSAGES_API_URL,
	OPENAI_RESPONSES_API_URL,
	upsertIndexRunRecordSafe,
	rememberMcpListTools,
	forgetMcpListToolsOnFailure,
	type ChatTurnContext,
	type IndexRunStatus,
	type IndexRunPatch,
	type BgTaskEntry,
} from './requests';
import { isPagedReadFile, isImageVisionFile, isWindowedReadFile } from './office';
import { windowedIndexingEnabled, workerIndexEndingsEnabled, liveStreamingEnabled, streamRecoveryEnabled, chatEngineConfig, resolveForwardRequestFinalize, resolveForwardRequestStream, resolveSkipDuplicateFiles, statusPushEnabled, statusPushLive, resolveForwardRequestStatus, resolveForwardRequestRead, resolveForwardRequestQueueCounters, reconcilerReadsEnabled, crefSupported } from './config';
// The reconciler's clock (one timer chain per page) and the cross-tab settle lock. What a
// look reads and applies is this file's (_reconcileLook).
import { LookScheduler, LOOK_STALE_MS, runSettleSideEffect, claimSideEffect, sideEffectDone, newClientRef, queueNameOf, type LookRequest, type LookOutcome, type LookTrigger } from './reconciler';
// The wire-format knowledge. skapi relays the provider's bytes without reading them,
// so the session hands them straight to this parser and never inspects a frame itself.
import { createSseParser, type SseParser } from './sse';
import { isErrorResponseBody, isAuthExpiredError, isNonRetryableRequestError, getErrorMessage, isCsrStatusEnvelope, isTransportFailure, isNotExistsError, isRetriedFailure } from './errors';
import { buildBoundedChatMessages } from './budget';
import { extractRetrievalNote, type RetrievalNote } from './retrieval_memory';
import { retrievalNoteOfAnswer, answerUsedNoDataTool } from './citations';
import { createInlineLinkRegex, sanitizeAttachmentLinksForHistory } from './links';
import { markImagePreviewStale } from './image_preview';
import { chatCacheKey, indexScopeKey, mapHistoryListToMessages, extractLastUserTextFromRequest, listedRequestText, isIndexingRequestText, parseIndexingRequestText, probeBgQueue, BG_PROBE_TTL_MS, fetchLiveIndexingKeys, getSplitChatHistory, shouldRescueInFlightMessage, adoptLocalAnswerIntoPage, adoptLiveTextIntoRunningRow } from './history';
import { wallClockNow, requestIdTimeMs, messageTimeMs } from './time';
import { parseAttachmentContent } from './attachment_parsers';
import { copiesToPromote } from './identical';
import type { ChatHost, ChatState, ChatMessage, ChatIdentity, PinnedDispatchContext, IndexQueueSnapshot } from './host';
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

/** How recent a loaded indexing pass has to be to count as evidence that a worker
 *  chain may still be advancing. Generous on purpose: it only has to outlast the
 *  gap between two passes of one file, and the cost of being wrong is three queue
 *  round trips, while the cost of being too tight is a file that reads "Indexed"
 *  while it is still being read. */
const RECENT_INDEX_PASS_EVIDENCE_MS = 10 * 60 * 1000;
// While this chat is following a worker-driven indexing run and its tab is visible, look
// for newly minted passes this often (2026-11-20). Adoption used to run only when a pass
// this client tracked SETTLED, and with parallel windows the one pass the client sent is
// just one of eight: the other lanes, and everything they finished, stayed invisible until
// it ended (3.5 min on a 110-page PDF, nine passes done meanwhile). One look is the two
// status queries (running, pending); it stops by itself when nothing is tracked.
const ADOPT_TICK_MS = 10 * 1000;
/** The queue check's interval while request status frames are arriving (statusPush). */
const STATUS_PUSH_ADOPT_TICK_MS = 60 * 1000;
/** The first history page is read at most this often by the reconciler's return looks. */
const CATCH_UP_MIN_GAP_MS = 2000;

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

/* ── the one apply funnel: types and small pure helpers ──────────────────────
 * Reconciler plan, section 3 items 1, 5 and 6 (BUNNYQUERY_CHAT_RECONCILER_PLAN.md).
 * ChatSession.applyTerminal is the only writer of a settled result; these are the
 * shapes it and its callers share. */

/** Where an item stands, by the server's account. Only ever moves forward. */
type OpenItemState = 'queued' | 'running' | 'terminal';
var OPEN_STATE_RANK: { [s: string]: number } = { queued: 0, running: 1, terminal: 2 };

/**
 * An item this page follows (a chat turn or an indexing pass), with the identity it
 * belongs to PINNED at the moment it was added: the dispatch ack, a history page that
 * showed it running or waiting, or a background entry the drain adopted. Every settle,
 * read and follow-up of the item uses this identity, never the one live at the time,
 * which a project, platform or account switch has moved on.
 */
export type OpenItem = {
	/** History cache key (chatCacheKey) of the chat the item belongs to. */
	ownerKey: string;
	projectId: string;
	owner: string;
	platform: 'claude' | 'openai';
	/** The server queue it runs on, when known. */
	queue?: string;
	kind: 'chat' | 'indexing';
	state: OpenItemState;
	/** Wall clock when this page started following it: "did the reader watch it live". */
	addedAt: number;
	/** The send's client reference, when known (reconciler plan, section 3 item 9). */
	cref?: string;
	/** An anonymous visitor's item: its row is keyed by the network it was sent from, so
	 *  "missing" reads as "no longer reachable from this network". */
	anonymous?: boolean;
	/** performance.now() of the last look that read this item's status. 0 = never. */
	lastConfirmed: number;
	/** The status the last read gave (pending, running, resolved, ...). */
	lastStatus?: string;
	/** The row streams its answer (batch status `stream`). */
	stream?: boolean;
	/** When the worker began executing it (a running read's `executed`): the start of the
	 *  pass's duration when an older skapi-js's look, not a poll, settles it. */
	executedAt?: number;
	/** A look saw it terminal while a live poll or stream still held it: the next look
	 *  reads it itself if that reader has not settled it by then. */
	terminalSeen?: boolean;
	/** The user id of the identity it was sent under (ChatIdentity.userId), pinned when it
	 *  was added. A row is readable only by the caller who made it, so while another
	 *  identity is signed in (signed out, another account) the item is left alone: not
	 *  read, not settled, never marked "no longer available" (see _recReadable). */
	uid?: string;
	/** Envelope reads that answered body_unavailable (stored, not loadable now), and when
	 *  the last one was. See _recBodyUnavailable. */
	unavail?: number;
	unavailAt?: number;
	/** A worker-driven indexing pass read as failed without the worker's `retried` mark:
	 *  when that was (performance.now()). Read once more before the failure is shown, as
	 *  the worker writes the mark only after it queued the window again (plan 3.8). */
	failedPending?: number;
	/** That second read is due (a complete queue look came, or the wait ran out). */
	failedRecheck?: boolean;
	/** A chat turn sent by this page (dispatchAgentRequest): sends it once more when the
	 *  answer a look reads is an expired sign-in (the dispatch poll's one resend). Used once. */
	resend?: (body: any) => void;
	/** The send's turn context (dispatchAgentRequest), settled when a look applies its answer. */
	turn?: ChatTurnContext;
};

/** What trackOpenItem takes: the identity, plus the state the caller saw. */
export type OpenItemInit = {
	ownerKey?: string;
	projectId?: string;
	owner?: string;
	platform?: string;
	queue?: string;
	kind?: 'chat' | 'indexing';
	state?: 'queued' | 'running';
	cref?: string;
	anonymous?: boolean;
	/** The identity's user id it was sent under; the live identity's when left out. */
	uid?: string;
};

/** What a caller of applyTerminal / onPollFailure knows about the item. Every field
 *  is optional: the pinned identity of an open item fills the gaps, the live identity
 *  only after that. */
export type TerminalContext = {
	ownerKey?: string;
	projectId?: string;
	platform?: string;
	owner?: string;
	queue?: string;
	/** Write the text at once, never typed out. */
	instant?: boolean;
	/** A corrected answer for a turn already settled (a stream read back in full after
	 *  an incomplete live parse): replaces the settled text instead of being refused. */
	correction?: boolean;
};

/** A send whose POST got no answer (reconciler plan, section 3 item 9). The turn's
 *  bubbles stay waiting while the discovery listing looks for its row by `cref`. */
type PendingSend = {
	cref: string;
	/** History cache key of the chat it was sent in. */
	key: string;
	userLid?: string;
	placeholderLid?: string;
	projectId: string;
	owner: string;
	platform: 'claude' | 'openai';
	/** The chat queue it went to. */
	queue: string;
	/** The newest row of this chat known before the POST: the listing reads after it. */
	watermark: string;
	/** dispatchAgentRequest's params, for retryNotSent. */
	params: any;
	/** Wall clock of the POST. */
	sentAt?: number;
	/** Complete discovery looks that did not find it. Two make it "Not sent. Retry?". */
	looks?: number;
	/** The identity's user id it was sent under (see OpenItem.uid). */
	uid?: string;
	/** 'indexing': the next pass of a client-driven file (see _sendNextIndexingPass), whose
	 *  row, once found by its cref, is followed through onFound; not found by two complete
	 *  listings, onMissing decides. No bubbles of its own. Default: a chat turn. */
	kind?: 'chat' | 'indexing';
	onFound?: (row: any) => void;
	onMissing?: () => void;
};

/** A client-driven indexing chain as kept in localStorage (see _persistChains): enough to
 *  follow its current pass after a reload and send the passes after it. */
type KeptChain = {
	projectId: string;
	platform: 'claude' | 'openai';
	owner: string;
	ownerKey?: string;
	identity: ChatIdentity;
	storagePath: string;
	filename: string;
	mime?: string;
	size?: number;
	isReindex?: boolean;
	resumePass: number;
	/** The current pass: the newest one this chain sent. */
	id: string;
	/** Wall clock of the last write. */
	at: number;
};

/** A file whose run:: record says 'working' (reconciler plan, section 3 item 1). `owner`
 *  (the record's writer) and `filename`, when the host passes them (syncFileRuns). */
type FileRun = { projectId: string; storagePath: string; since: number; owner?: string; filename?: string };

/** Who a page watches the background indexing queue of (see ChatSession.watchIndexQueue). */
export type IndexQueueIdentity = {
	projectId: string;
	owner: string;
	platform: 'claude' | 'openai';
	/** The user the queue is named after (the same value the dispatch used). */
	userId?: string;
};

/** A page that shows indexing state from the queue (the dashboard's files page). */
export type IndexQueueWatchOptions = {
	/** Read live on every look: null while the page cannot ask (no platform, no key). */
	identity: () => IndexQueueIdentity | null;
	/** The page needs a second look soon (a green waiting for its confirmation). */
	wantsConfirm?: () => boolean;
	/** The page follows runs of its own that the queue cannot show (run:: 'working'
	 *  records of other users): recheckRuns is called every FILE_RUN_RECHECK_MS while
	 *  this says so and the tab is visible. */
	runsOpen?: () => boolean;
	recheckRuns?: () => void;
};

/** What watchIndexQueue hands back. */
export type IndexQueueWatchHandle = {
	/** Stop watching (the page unmounts). */
	stop(): void;
	/** A fresh read unless the last one is younger than `maxAgeMs` (default 0). Resolves
	 *  once the look that reads it is over (the snapshot is then in state.indexQueues). */
	refresh(maxAgeMs?: number): Promise<void>;
	/** Something the page waits on changed (wantsConfirm, runsOpen): the chain runs. */
	ensure(): void;
};

type IndexQueueWatch = {
	opts: IndexQueueWatchOptions;
	/** Read at the next look, whatever the cadence says. */
	force: boolean;
	/** A status frame named this queue since the last read. */
	frame: boolean;
	runsCheckAt: number;
	/** Date.now() of the last read asked for (a read that fails leaves no snapshot behind,
	 *  and must not be asked again on every look). */
	lastTryAt: number;
	/** awaitIndexingDrained's own watch: read fresh on its own cadence (see there). */
	drain?: {
		due: () => boolean;
		/** A read is going out: returns its token, handed back with the answer. */
		onAsk: () => number;
		onSnapshot: (snap: IndexQueueSnapshot | null, failed: boolean, token: number) => void;
	};
};

/** The watched queue is read this often while it holds work or the last read was cut off. */
var IQ_LIVE_MS = 8 * 1000;
/** ...and this often while status frames arrive (a frame about the queue reads it at once). */
var IQ_PUSH_LIVE_MS = 60 * 1000;
/** A page waiting for a second, independent look (a green confirmation). */
var IQ_CONFIRM_MS = 2500;
/** Closest a frame-triggered read follows the previous one. */
var IQ_FRAME_GAP_MS = 2000;

/** What a send whose row the server never showed says. */
export var NOT_SENT_TEXT = 'Not sent. Retry?';
/** What a chat turn whose row is gone says ("missing" on a strongly consistent read). */
export var REQUEST_GONE_TEXT = 'This request is no longer available.';
/** The same for an anonymous visitor, whose rows are keyed by the network they were sent from. */
export var REQUEST_UNREACHABLE_TEXT = 'This answer is no longer reachable from this network.';

/** What a turn whose stored answer could not be loaded, read after read, says. A later
 *  read that loads it replaces this (see _recRetryUnloadable). */
export var ANSWER_UNLOADABLE_TEXT = 'The answer is stored but could not be loaded right now. Reload to try again.';
/** body_unavailable reads after which an item is read only at the stale watch. */
var BODY_UNAVAILABLE_BACKOFF_AFTER = 3;
/** body_unavailable reads after which the turn shows ANSWER_UNLOADABLE_TEXT. */
var BODY_UNAVAILABLE_GIVE_UP = 5;
/** Further tries, one per stale watch or return, to load an answer shown as unloadable. */
var UNLOADABLE_RETRIES = 10;
/** A failed worker pass (plan 3.8) is read again no sooner than this after its failure... */
var FAILED_PASS_RECHECK_MIN_MS = 3 * 1000;
/** ...and no later than this, when no complete queue look comes (no chat view). */
var FAILED_PASS_RECHECK_MAX_MS = 30 * 1000;
/** Where a client-driven indexing chain is kept across reloads (see _persistChain). */
var CHAIN_STORE_PREFIX = 'bq-chain:';
/** A kept chain older than this is not restored (its run is long over). */
var CHAIN_STORE_TTL_MS = 24 * 60 * 60 * 1000;
/** What a run:: record whose client-driven chain was lost says. */
var CHAIN_LOST_TEXT = 'Indexing stopped before the file finished (the page was closed). Index it again.';
/** What a run:: record whose next pass could not be sent says. */
var NEXT_PASS_NOT_SENT_TEXT = 'Could not send the next indexing pass.';

/** A send that got no answer is "Not sent" only this long after its POST, at the earliest. */
var NOT_SENT_MIN_AGE_MS = 15 * 1000;
/** How many open items one look reads the status of, per project (3 batch calls). */
var LOOK_READ_CAP = 300;
/** A host's resumePolling this soon after a return look started rides on that look. */
var RETURN_COVER_MS = 15 * 1000;
/** How many waiting items at the head of a queue's line a look reads between full reads. */
var LOOK_HEAD_OF_LINE = 5;
/** How many envelope reads one look runs at once. */
var LOOK_READ_CONCURRENCY = 4;
/** Indexing file runs: how often a look asks the host to re-read their run:: records. */
var FILE_RUN_RECHECK_MS = 30 * 1000;

/** The csr-poll envelope of a cancelled row, for a read that was told NOT_EXISTS: the
 *  row was removed, which settles the item exactly as a cancel does. */
function cancelledEnvelope(id: string): any {
	return { id: id, status: 'cancelled', in_queue: false };
}

/** A server refusal of a read (not a transport failure, not NOT_EXISTS) as an error
 *  body the funnel renders like any failed answer. */
function pollErrorBody(err: any): any {
	return { type: 'error', error: { type: 'request_error', message: getErrorMessage(err) } };
}

/** What a turn whose row settled with no text at all reads as. */
var NO_TEXT_RESPONSE = 'No text response received from AI provider.';
/** A provider body with no text in it, in both platforms' shapes. */
var EMPTY_PROVIDER_BODY: any = { content: [], output: [] };


/* ── live streaming: what is safe to show, and where to resume ──────────────
 *
 * A streamed answer is rendered while it is still GROWING, which is a different
 * problem from the typewriter's. The typewriter already holds the whole string and
 * only has to avoid stopping inside a region it knows the bounds of. Here the end
 * of the string is not the end of the answer: a `[` may be the start of a link
 * whose url has not arrived, and three backticks may be the start of a file fence
 * whose whole point is that it renders as a download chip rather than as prose.
 *
 * So the rule is the mirror image of the typewriter's: instead of extending the
 * reveal past an atomic region, hold it BACK to before whatever the next bytes
 * could still turn into one. The tail is only ever a paint or two behind, and the
 * settle re-renders the authoritative text in full anyway, so nothing is lost by
 * being late and quite a lot is lost by being early (a chip minted from half a
 * url, a fence opener shown as three literal backticks, a link whose href changes
 * under the reader's pointer).
 */

/** How far back from the end an unclosed '[' is still read as "a link about to
 *  complete". Beyond this it is ordinary prose that happens to contain a bracket,
 *  and treating it as a pending link would freeze the reveal for the rest of the
 *  answer: "see [the appendix" never closes, and without a window the reader would
 *  watch a bubble that stopped growing at the bracket until the turn settled. */
const LIVE_PENDING_LINK_WINDOW = 512;

/**
 * How many unfinalized streamed turns ONE history load reads back out of the chunk
 * store on its own.
 *
 * Each read drains a whole turn's chunks, so this is a real request budget, not a
 * render one. Two, newest first, because that is the shape the case actually has:
 * a turn is left unfinalized by the tab going away mid-answer, and a user does that
 * to the turn they were watching, not to twenty of them. A page holding more keeps
 * the rest marked and picks them up on the next load (each recovery finalizes what
 * it read, so the backlog strictly shrinks), or the host offers them on demand
 * through recoverStreamedAnswer().
 */
const STREAM_RECOVERY_PER_LOAD = 2;

/**
 * The prefix of a still-arriving answer that is safe to render as markdown.
 *
 * Four cuts, each taking the earliest position that could still change meaning:
 *   1. an UNCLOSED ``` fence (odd number of markers) - everything from its opener;
 *   2. an UNCLOSED inline link on the last line - `[label` with no `]`, or
 *      `[label](url` with no `)`, from its `[`;
 *   3. a trailing bare url or `src::` token, from its first character, because a
 *      link is minted from whatever is there and a growing url means a chip whose
 *      href changes on every paint;
 *   4. an unclosed inline-code span on the last line (odd backtick count).
 *
 * Deliberately NOT covered: emphasis markers, half-written table rows and list
 * bullets. Those degrade to a flicker of STYLING, which self-corrects on the next
 * paint; the four above degrade to a wrong link, a wrong chip, or prose shown where
 * a fence was meant, none of which the reader can tell from the real thing.
 */
export function liveSafePrefix(text: string): string {
	if (!text) return '';
	var cut = text.length;

	// 1. Fence markers come in pairs. An odd count means the last one opened a block
	//    that has not closed, and a file fence in particular is the download-chip
	//    syntax: shown half-arrived it is three backticks and a filename in prose.
	var fenceAt = -1, fences = 0, from = 0, hit;
	for (;;) {
		hit = text.indexOf('```', from);
		if (hit === -1) break;
		fences++; fenceAt = hit; from = hit + 3;
	}
	if (fences % 2 === 1 && fenceAt !== -1) cut = fenceAt;

	// Rules 2 to 4 look at the last line of what SURVIVED rule 1: an inline link and
	// an inline-code span cannot span a newline (createInlineLinkRegex's label class
	// excludes it), so the last line is the whole of what can still be growing.
	var head = text.slice(0, cut);
	var lineStart = head.lastIndexOf('\n') + 1;
	var line = head.slice(lineStart);

	// 2. An inline link whose url has not arrived. Windowed (see the constant): a
	//    bracket far behind the write head belongs to prose, not to a pending link.
	var open = line.lastIndexOf('[');
	if (open !== -1 && (line.length - open) <= LIVE_PENDING_LINK_WINDOW) {
		var rest = line.slice(open);
		var close = rest.indexOf(']');
		if (close === -1) {
			cut = lineStart + open;
		} else if (rest.charAt(close + 1) === '(' && rest.indexOf(')', close + 1) === -1) {
			cut = lineStart + open;
		}
	}

	// 3. A trailing bare url / src:: token. Only once it is RECOGNISABLE as one: the
	//    few characters of a half-written scheme ("https:/") render as plain text and
	//    linkify nothing, and the monotonic guard in the painter means the reveal
	//    simply stops there until the whole url has landed rather than retreating.
	var tokStart = line.length;
	while (tokStart > 0 && !/\s/.test(line.charAt(tokStart - 1))) tokStart--;
	var tok = line.slice(tokStart);
	if (tok && /^(?:https?:\/\/|src::)/i.test(tok)) {
		var tokCut = lineStart + tokStart;
		if (tokCut < cut) cut = tokCut;
	}

	// 4. An unclosed inline-code span. Skipped on a line carrying a fence marker,
	//    where the backticks are rule 1's business: a CLOSING fence line ("```") has
	//    an odd count of its own, and cutting there would hide the very marker that
	//    closes the block and leave an open fence on screen.
	if (line.indexOf('```') === -1) {
		var ticks = 0, lastTick = -1;
		for (var i = 0; i < line.length; i++) {
			if (line.charAt(i) === '`') { ticks++; lastTick = i; }
		}
		if (ticks % 2 === 1 && lastTick !== -1) {
			var tickCut = lineStart + lastTick;
			if (tickCut < cut) cut = tickCut;
		}
	}

	if (cut >= text.length) return text;
	if (cut < 0) cut = 0;
	return text.slice(0, cut);
}

/** Length of the shared leading run of two strings, never splitting a surrogate
 *  pair: a resume index landing between the halves of an astral character would
 *  paint a lone surrogate, which renders as a replacement glyph. */
function commonPrefixLength(a: string, b: string): number {
	var n = Math.min(a.length, b.length), i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	if (i > 0) {
		var prev = a.charCodeAt(i - 1);
		if (prev >= 0xd800 && prev <= 0xdbff) i--;
	}
	return i;
}

/**
 * Where the typewriter should START revealing `fullText`, given what a live stream
 * has already painted into the bubble.
 *
 * The point is that the settle must not replay an answer the reader has already
 * watched arrive: the authoritative text REPLACES the live text (it is the only
 * source of truth), but the characters the two agree on are already on screen and
 * retyping them from zero is the one thing that would make streaming look worse
 * than not streaming.
 *
 * `regions` are the typewriter's own atomic regions. A resume index landing inside
 * one is pushed FORWARD to its end rather than back to its start: forward reveals
 * the link or fence whole, which is the policy those regions exist to enforce, and
 * backward would make the bubble shrink at the exact moment the answer settles.
 *
 * LEADING WHITESPACE IS NORMALISED FIRST, and that is not a nicety. The two strings
 * come from two places that disagree about it by design: the painter writes the
 * parser's `text` UNTRIMMED (currentText says why: trimming a render feed would
 * remove a leading newline and then hand it back when the next delta lands), while
 * every settle path trims, exactly as it trims a buffered answer. And the extractor
 * joins text blocks with '\n', so a model that opens an empty text block before its
 * first tool call, which Claude routinely does, produces a painted answer starting
 * with a newline the authoritative one does not have. Compared raw, the two agree on
 * NOTHING (their first characters differ), the resume index is 0, and the reader
 * watches the entire answer they just read be retyped from zero. Which is the one
 * thing streaming was supposed to stop happening.
 */
export function typewriterResumeIndex(
	painted: string,
	fullText: string,
	regions: Array<{ start: number; end: number }>,
): number {
	if (!painted || !fullText) return 0;
	// Only when the authoritative text has none of its own: that is the case where
	// the difference can only be the trim, so dropping it aligns the two. If
	// fullText DOES start with whitespace (a caller that passes untrimmed text) the
	// two are already in the same frame and cutting painted would misalign them.
	if (/^\s/.test(painted) && !/^\s/.test(fullText)) {
		painted = painted.replace(/^\s+/, '');
		if (!painted) return 0;
	}
	var i = commonPrefixLength(painted, fullText);
	if (i <= 0) return 0;
	if (i >= fullText.length) return fullText.length;
	for (var changed = true; changed;) {
		changed = false;
		for (var k = 0; k < regions.length; k++) {
			var r = regions[k];
			if (i > r.start && i < r.end) { i = r.end; changed = true; }
		}
	}
	return i > fullText.length ? fullText.length : i;
}

/**
 * THE KEEP POLICY, in one place, for every path that can reach csr-finalize.
 *
 * WHY IT IS A FUNCTION AND NOT A LINE IN EACH CALLER. Finalizing does two things in
 * one call: it stores what you hand it as the row's permanent answer, and it
 * DELETES the chunks it was assembled from. Chunks are the only copy of a streamed
 * answer until that call, and there is no way to release them without also storing
 * something, so "may this be kept?" is the single decision that separates a
 * recoverable turn from a permanently truncated one. It was answered in two places
 * that then disagreed: the live settle refused to finalize a failed or cancelled
 * turn (its partial text is the only copy there is, and both ways of releasing it
 * cost something real), while the recovery path computed the same question from
 * parse completeness ALONE - so recovering a failed row finalized it and released
 * exactly the chunks the live policy exists to keep. Two halves of one fix, pulling
 * opposite ways. One predicate, consulted by both, is the fix for that.
 *
 * The three terms, and what each of them is protecting:
 *
 *   THE ROW'S OWN STATUS wins over anything the bytes say. 'failed' means the
 *   destination's account of the turn is the error, not the text that arrived
 *   before it; 'cancelled' means the user's Stop said to discard the half answer,
 *   so writing it into history as the kept version resurrects exactly what the stop
 *   was for; 'stopped' is a poll that was ended, which says nothing about the turn
 *   at all. Pass undefined when the status is genuinely not known (the caller is
 *   looking only at bytes); pass the status whenever there is one, because a caller
 *   that omits a status it HAS is asking the wrong question.
 *
 *   `errored` covers the same refusal expressed by the bytes rather than by the
 *   row: an `error` frame, a response.failed, a terminal Response with an error
 *   payload. See sse.ts's answerComplete for why a terminal event is not the same
 *   claim as a finished answer.
 *
 *   `answerComplete` (NOT `complete`) is the completeness half. A degraded chunk
 *   read - the poller degrades to "no chunks this tick, more=true" on any transient
 *   chunk-table error, and caps one read at 500k characters - hands a settle a
 *   stream that stopped mid-answer while the ROW settles 'resolved' on top of it,
 *   because the row's status describes the destination's request and not our read
 *   of it. Anything short of a finished answer leaves the chunks exactly where they
 *   are, which is what they are for: the turn stays re-readable through
 *   forwardRequestStream and a later load recovers it in full.
 *
 *   `unframed` is the one exception to needing a terminal event, and it is not a
 *   loophole: bytes that were never SSE carry no events at all and none is ever
 *   coming, so there it IS the row's status that says the response finished - which
 *   is why this is only ever reached with a 'resolved' row or with no status to
 *   contradict it.
 *
 * Exported so the two clients cannot answer it a third way.
 */
export function mayKeepStreamedAnswer(snap: any, rowStatus?: string | null): boolean {
	// An absent status is "not known", not "not resolved": a caller reading bytes
	// alone has no row to consult. A status that IS present must be the resolved one.
	if (rowStatus !== undefined && rowStatus !== null && rowStatus !== '' && rowStatus !== 'resolved') return false;
	if (!snap || typeof snap !== 'object') return false;
	if (snap.errored) return false;
	if (snap.answerComplete) return true;
	if (snap.unframed) return true;
	return false;
}

/**
 * WHAT A VIEW SHOULD DRAW FOR A TURN WHOSE ANSWER IS STILL IN THE CHUNK STORE.
 *
 * One predicate, on the barrel, because the alternative is each client deciding
 * for itself when a spinner is honest - and the two clients have forked on
 * smaller things than this. Returns:
 *
 *   ''         not this state at all. Either the bubble is not marked, or it HAS
 *              content (the merge adopted a local answer onto it, or a recovery
 *              wrote a truncated one in), in which case there is text to render
 *              and the recovery, if any, is a background correction the reader
 *              does not need to be told about.
 *   'active'   a chunk read is in flight or queued. Draw the loader: this is the
 *              only phase in which something really is coming.
 *   'failed'   the last read failed. Draw the failure and an ask-again control.
 *   'idle'     marked, and nothing is fetching it. Draw an ask-for-it control.
 *
 * THE FAILURE THIS EXISTS TO STOP. Recovery is capped at STREAM_RECOVERY_PER_LOAD
 * per history load, so on a page holding several unfinalized turns the third and
 * later ones are marked and queued for nobody; a failed read likewise leaves the
 * marker on deliberately (it is the only thing keeping the answer reachable) with
 * no attempt behind it. Both used to take the same branch as a live pending turn,
 * so those bubbles spun forever with nothing driving them and no way for the
 * reader to resolve them - while the answer sat in the chunk table the whole time,
 * one recoverStreamedAnswer() call away.
 *
 * A bubble with no `_serverItemId` returns '' on purpose: there is no id to hand
 * recoverStreamedAnswer, so an affordance would be a button that cannot work.
 * Unreachable today (the mapper only ever marks a row it has an id for), stated so
 * that it stays unreachable rather than becoming a dead control.
 */
export function streamRecoveryPhase(msg: any): '' | 'active' | 'failed' | 'idle' {
	if (!msg || !msg._streamPending || msg.content || !msg._serverItemId) return '';
	if (msg._streamRecovery === 'active') return 'active';
	if (msg._streamRecovery === 'failed') return 'failed';
	return 'idle';
}

/**
 * The words for the two phases a reader has to act on. Here rather than in each
 * client for the same reason as the phase itself: two clients wording the same
 * state differently is how one of them ends up saying something untrue.
 *
 * Neither string claims the answer is lost. It is not: the row is unfinalized, so
 * the chunks are retained until somebody finalizes them, and that is exactly why
 * asking again is worth offering.
 */
export function streamRecoveryLabels(phase: string): { note: string; action: string } {
	if (phase === 'failed') {
		return { note: 'Could not load this answer.', action: 'Try again' };
	}
	return { note: 'This answer was not saved with the conversation.', action: 'Load answer' };
}

/* isCsrStatusEnvelope - the predicate that tells a STREAMED turn apart at settle,
 * because a streamed row stores nothing and hands back { id, status, in_queue, ... }
 * instead - now lives in errors.ts and is imported above.
 *
 * It moved because it was written twice: once here for the settle, and (implicitly,
 * one level too shallow) in the error readers. A streamed FAILURE is that same
 * envelope with the provider's error nested inside it, so the two had to agree on
 * what an envelope is before the error readers could see through one. See
 * csrEnvelopeError. */

/** Floor on the gap between two live paints of the same bubble. The transport
 *  already paces the answer at about one write per second, so this is not the
 *  rhythm - it is what stops a BURST (a poll tick carrying a dozen chunks, or a
 *  re-attach replaying the whole answer at once) from turning into a dozen
 *  re-renders of the same bubble in the same frame. */
const LIVE_PAINT_MIN_MS = 250;
/** Largest growth, in characters, that a single live paint will ANIMATE rather than
 *  land whole. The transport paces at about one chunk a second and a model writes
 *  roughly 160 characters in that time, so an ordinary arrival is far under this and
 *  types. A replay (reopening a chat, recovering an unfinalized turn) delivers the
 *  whole answer in one feed and is far over it, so it lands at once instead of
 *  retyping a finished message at the reader. */
const LIVE_TYPE_MAX_STEP = 1200;

/**
 * The identity a streamed turn was DISPATCHED under, pinned by the caller.
 *
 * Same reason _callProviderFor takes projectId/owner explicitly: a turn can be
 * acked after the user has moved to another project or platform, and a live
 * getIdentity() read at that moment describes where the user is now, not where the
 * turn came from. Every field optional so a caller can pin what it knows and let
 * the rest fall back to the live read.
 */
export type StreamDispatchContext = {
	platform?: string;
	projectId?: string;
	owner?: string;
	/** History cache key (chatCacheKey) of the chat the turn belongs to. */
	ownerKey?: string;
};

/** One in-flight streamed turn. Keyed by server item id in ChatSession.liveStreams. */
type LiveStreamState = {
	/** Server item id: the turn's identity everywhere, including on its bubbles. */
	id: string;
	/** History cache key the turn belongs to. Painting is skipped while another
	 *  chat is on screen; parsing and finalizing are not. */
	ownerKey: string;
	platform: 'claude' | 'openai';
	projectId: string;
	owner: string;
	parser: SseParser;
	/** What is currently on screen, so a paint can be skipped when the safe prefix
	 *  has not grown (see the monotonic guard in _paintLiveStream). */
	painted: string;
	/** A first paint has happened, so the one notify() has been spent. */
	started: boolean;
	/** At least one chunk arrived. False means the row never streamed, so there is
	 *  nothing to assemble and nothing to finalize. */
	fed: boolean;
	ended: boolean;
	timer: any;
	lastPaintAt: number;
	/** The assembled provider body, built once at end(). */
	finalBody: any;
	/** csr-finalize has been fired for this turn. Guards the double settle
	 *  (onResponse and the promise) from storing the same body twice. */
	finalized?: boolean;
	/** How many chunks each of skapi's two transports carried FIRST. Counted, never
	 *  acted on: both deliver into the same sink by design, so this is the only way
	 *  a host can tell a websocket-delivered answer from a polled one. */
	transport: { socket: number; poll: number };
};

// requestIdTimeMs lives in time.ts (2026-11-25: indexing_groups.ts needs it too); re-exported here.
export { requestIdTimeMs };

/** The visible message the "Wrong answer?" button sends. The chat prompt's WRONG ANSWER rule reacts to it. */
export var WRONG_ANSWER_MESSAGE = 'This answer seems wrong. Please check it again against the documents.';
/** The button's label, shared so the two clients word it the same. */
export var WRONG_ANSWER_LABEL = 'Wrong answer?';

/**
 * True when a bubble gets the "Wrong answer?" button: a settled chat answer that
 * read project data (a retrieval note that is not the no-source mark). Both
 * clients gate through ChatSession.canReportWrongAnswer, which also keeps it to
 * the latest answer, and
 * ChatSession.wrongAnswerReported says whether it was used.
 */
export function canReportWrongAnswer(msg: ChatMessage | null | undefined): boolean {
	var note = retrievalNoteOfAnswer(msg);
	return !!note && !answerUsedNoDataTool(note) && !(msg as any).isCancelled;
}

/** The message of the error an attachment upload rejects with when the user cancelled it. */
export var UPLOAD_CANCELLED_MESSAGE = 'Upload cancelled';
/** True for the rejection of an attachment upload the user cancelled (cancelAttachmentUpload). */
export function isUploadCancelledError(err: any): boolean {
	return !!err && (err.code === 'CANCELLED' || err.message === UPLOAD_CANCELLED_MESSAGE);
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
	/** Answers whose "Wrong answer?" was already sent, by server id (else local id),
	 *  so a history refetch that rebuilds the bubble does not offer it again. */
	private _wrongReported: { [msgKey: string]: boolean };
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
	/** bgTaskQueue by the SAME scoped path the claims use -> how many entries
	 *  name that file. Derived from the array, never written to directly: see
	 *  _bgQueueIndex for when it is rebuilt and why that is exact. */
	private _bgQueueByFile: { [scopedPath: string]: number } | null;
	/** What _bgQueueByFile was built from: the array itself, its length and its
	 *  first and last entries. Equal stamp = equal contents (see _bgQueueIndex). */
	private _bgQueueStamp: { arr: BgTaskEntry[] | null; length: number; first: any; last: any };
	/** How many times the index was rebuilt. Diagnostics and tests only: a
	 *  3,000-file batch should build it a few thousand times at most (once per
	 *  push or settle), never once per claim. */
	_bgQueueIndexRebuilds: number;

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
			indexPageProgress: {},
			passPaging: {},
			liveIndexChecked: false,
			liveIndexRunning: {},
			liveIndexRunningChecked: false,
			liveIndexSettled: {},
			stoppedIndexIds: {},
			reconnecting: false,
			signInNeeded: false,
			indexQueues: {},
		};
		this.bgTaskQueue = [];
		this.cancelledServerIds = new Set();
		this.cancelledIndexKeys = new Set();
		this.pendingAgentRequests = {};
		this.aiChatHistoryCache = {};
		this.historyItemPolls = new Map();
		this._pauseReasons = new Set();
		this._resuming = false;
		this._wrongReported = {};
		this._lidSeq = 0;
		this._stageSeq = 0;
		this._uploadBatches = 0;
		this._indexDispatchesInFlight = 0;
		this._drainNudges = [];
		this._liveStages = {};
		this._liveIndexKey = '';
		this._liveIndexAt = 0;
		this._indexClaims = {};
		this._bgQueueByFile = null;
		this._bgQueueStamp = { arr: null, length: 0, first: undefined, last: undefined };
		this._bgQueueIndexRebuilds = 0;
		this._watchVisibility();
	}

	/** What the display layer needs to decide whether a run is finished. `keys` holds
	 *  every file the server still has indexing work for; `checked` is false until the
	 *  first answer for this chat, and false means "we do not know yet". */
	getLiveIndexState(): { keys: { [fileKey: string]: boolean }; checked: boolean; running: { [fileKey: string]: boolean }; runningChecked: boolean; settled: { [fileKey: string]: boolean } } {
		return { keys: this.state.liveIndexKeys, checked: this.state.liveIndexChecked, running: this.state.liveIndexRunning || {}, runningChecked: !!this.state.liveIndexRunningChecked, settled: this.state.liveIndexSettled || {} };
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
		var scoped = this._indexClaimKey(storagePath);
		var claimed = this._indexClaims[scoped];
		if (claimed && nowMs() - claimed < INDEX_DISPATCH_CLAIM_MS) return true;
		// The queue, looked up by the same scoped path instead of scanned. A batch
		// claims once per file, and the queue holds one entry per file already
		// dispatched, so the scan was O(n) per claim and O(n^2) over a 3,000-file
		// batch. The index is rebuilt only when the array changes (_bgQueueIndex).
		if (this._bgQueueIndex()[scoped] > 0) return true;
		return this.state.messages.some(function (m) {
			if (!m.isBackgroundTask || m.role !== 'user' || m.isCancelled) return false;
			if (!(m.isPendingQueued || m.isPendingInProcess || m.isSendingToServer)) return false;
			return !!m._indexFile && m._indexFile.path === storagePath;
		});
	}

	/** Storage paths are project-relative, and one ChatSession serves every
	 *  project, so a claim has to be scoped the way a stop is (_indexKeyOf). */
	private _indexClaimKey(storagePath: string): string {
		var id = this.host.getIdentity();
		return indexScopeKey(id.projectId, id.platform) + '|' + storagePath;
	}

	/**
	 * bgTaskQueue as a map: scoped path (indexScopeKey(projectId, platform) +
	 * '|' + storagePath, the key the claims and the stops use) -> entries.
	 *
	 * The array stays the source of truth because the engine does not own every
	 * write to it: both hosts hand in their own array (the dashboard a Vue
	 * reactive one it pushes to from the Files page and splices from its
	 * fallback poller), and tests push to it directly. So the map is DERIVED, and
	 * rebuilt when a cheap stamp says the array changed: its identity, its length,
	 * its first and its last entry.
	 *
	 * Why that stamp is exact for this array: every write to bgTaskQueue is either
	 * a push of a NEW entry object or a splice that removes one (nothing inserts
	 * in the middle, replaces in place or re-pushes a removed entry). Under those
	 * two operations, same length plus same last entry means the same contents:
	 * a push changes the last entry unless that same push is removed again, and a
	 * removal changes the length unless a push restores it, which changes the
	 * last entry. The first entry is in the stamp as margin. A rebuild is one
	 * pass over the array, paid once per change instead of once per claim.
	 */
	private _bgQueueIndex(): { [scopedPath: string]: number } {
		var q = this.bgTaskQueue;
		var n = q ? q.length : 0;
		var first = n ? q[0] : undefined;
		var last = n ? q[n - 1] : undefined;
		var st = this._bgQueueStamp;
		if (this._bgQueueByFile && st.arr === q && st.length === n && st.first === first && st.last === last) {
			return this._bgQueueByFile;
		}
		var idx: { [scopedPath: string]: number } = {};
		for (var i = 0; i < n; i++) {
			var e = q[i];
			if (!e || !e.storagePath) continue;
			var k = indexScopeKey(e.projectId, e.platform) + '|' + e.storagePath;
			idx[k] = (idx[k] || 0) + 1;
		}
		this._bgQueueByFile = idx;
		this._bgQueueStamp = { arr: q, length: n, first: first, last: last };
		this._bgQueueIndexRebuilds++;
		return idx;
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
	 * Index files that are ALREADY STORED again, without uploading anything: the
	 * Reindex answer of the "already uploaded" report, offered for the members a send
	 * skipped as duplicates (att.duplicates, see uploadSingleAttachment). The same
	 * steps the Files page's Reindex takes: claim the file (one already being indexed
	 * is left alone), keep its access group (host.readFileAccessGroup, read before the
	 * delete), clear the old index, re-create the file record, queue the first pass.
	 * Each file appears in the chat as a "Reindexing" row. Never rejects; resolves to
	 * the number of files queued.
	 */
	reindexStoredFiles(list: Array<{ storagePath: string; name?: string; size?: number; mime?: string }>): Promise<number> {
		var self = this;
		var id = this.host.getIdentity();
		var queued = 0;
		if (!id.projectId || (id.platform !== 'claude' && id.platform !== 'openai')) return Promise.resolve(0);
		var chain: Promise<any> = Promise.resolve();
		(list || []).forEach(function (d) {
			if (!d || !d.storagePath) return;
			var storagePath = d.storagePath;
			var name = d.name || storagePath.split('/').filter(Boolean).pop() || storagePath;
			var mime = d.mime || self.host.getMimeType(name) || undefined;
			chain = chain.then(function () {
				var claimed = false;
				var url = '';
				var group: 'public' | 'authorized' | 'private' | undefined;
				return self.claimIndexRun(storagePath).then(function (ok) {
					claimed = ok;
					if (!ok) return; // already being indexed
					return Promise.resolve(self.host.getTemporaryUrl(storagePath)).then(function (u: any) {
						url = typeof u === 'string' ? u : (u && u.url) || '';
						if (!url) return;
						return typeof self.host.readFileAccessGroup === 'function'
							? Promise.resolve(self.host.readFileAccessGroup(storagePath)).then(function (g) { group = g || undefined; })
							: undefined;
					}).then(function () {
						if (!url) return;
						if (typeof self.host.deleteExistingFileRecord === 'function') {
							return Promise.resolve(self.host.deleteExistingFileRecord(storagePath)).catch(function () { });
						}
					}).then(function () {
						if (!url) return;
						if (typeof self.host.ensureFileIndexRecord === 'function') {
							return Promise.resolve(self.host.ensureFileIndexRecord(storagePath, { name: name, mime: mime, size: d.size }, group)).catch(function () { });
						}
					}).then(function () {
						if (!url || group || typeof self.host.uploadAccessGroup !== 'function') return;
						// No stored group (the file record was gone): the group the
						// re-created record was just written at.
						return Promise.resolve(self.host.uploadAccessGroup(storagePath)).then(function (g) { group = g || undefined; }).catch(function () { });
					}).then(function () {
						if (!url) { self.releaseIndexRun(storagePath); return; }
						return self.trackIndexDispatch(notifyAgentSaveAttachment({
							platform: id.platform as 'claude' | 'openai',
							model: id.model,
							service: id.projectId,
							publicProjectId: id.publicProjectId,
							owner: id.owner,
							userId: id.userId || id.projectId,
							serviceName: id.serviceName,
							serviceDescription: id.serviceDescription,
							attachment: { name: name, storagePath: storagePath, mime: mime, size: d.size, url: url, accessGroup: group },
						})).then(function (ack: any) {
							if (ack && typeof ack.id === 'string') {
								queued += 1;
								self.bgTaskQueue.push({
									projectId: id.projectId, platform: id.platform as 'claude' | 'openai', id: ack.id,
									identity: Object.assign({}, id), owner: id.owner,
									filename: name,
									storagePath: storagePath,
									isReindex: true,
									mime: mime,
									size: d.size,
									status: ack.status === 'running' ? 'running' : 'pending',
									poll: ack.poll,
								});
								// Followed with or without a chat view (the drain needs one).
								self.noteBgQueueChanged();
								self.drainBgTaskQueue();
							} else {
								self.releaseIndexRun(storagePath);
							}
						});
					});
				}).catch(function (err: any) {
					console.error('[chat-engine] reindex of a stored file failed', storagePath, err);
					if (claimed) self.releaseIndexRun(storagePath);
				});
			});
		});
		return chain.then(function () { self.drainBgTaskQueue(); return queued; });
	}

	/**
	 * ONE SHARED INDEX FOR IDENTICAL FILES: the linked copies that lose their original when
	 * `removed` files (or every file under `folders`) go away, per original, oldest first
	 * (identical.ts copiesToPromote). Read through host.findLinkedCopies, fresh, and it has
	 * to be read BEFORE the delete or reset: those remove nothing from the copies' markers,
	 * but a later sweep could no longer tell whose copies they were once a new original
	 * exists. Never rejects; [] without the hook or on any failure.
	 */
	collectLinkedCopies(removed: string[], folders?: string[]): Promise<{ original: string; copies: string[] }[]> {
		if (typeof this.host.findLinkedCopies !== 'function') return Promise.resolve([]);
		// only copies this user may re-index: their own, or every copy for the project owner
		var id = this.host.getIdentity();
		var actor = { userId: id && !id.anonymous ? id.userId : null, isProjectOwner: !!(id && !id.anonymous && id.owner && id.userId === id.owner) };
		return Promise.resolve(this.host.findLinkedCopies())
			.then(function (map) { return map ? copiesToPromote(map, removed || [], folders, actor) : []; })
			.catch(function () { return []; });
	}

	/**
	 * Send the copies of a removed or overwritten original again (owner decision
	 * 2026-11-26): each list's oldest copy first, so its first pass claims the content and
	 * is indexed for real (one AI run), then the others, which link to it with no AI call.
	 * The share flag rides on every first pass while the project's switch is on (requests.ts
	 * notifyAgentSaveAttachment). Through reindexStoredFiles, so each copy keeps its access
	 * group and shows as a "Reindexing" row. Resolves to the number of files queued.
	 */
	promoteLinkedCopies(plan: { original: string; copies: string[] }[]): Promise<number> {
		var list: Array<{ storagePath: string }> = [];
		(plan || []).forEach(function (g) {
			(g && g.copies || []).forEach(function (c) { if (c) list.push({ storagePath: c }); });
		});
		if (!list.length) return Promise.resolve(0);
		console.log('[chat-engine] identical files: sending ' + list.length + ' linked cop' + (list.length === 1 ? 'y' : 'ies') + ' again, their original is gone:', plan);
		return this.reindexStoredFiles(list);
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
		var running: { [k: string]: boolean } = {};
		// Every listed pending/running indexing row, locally settled or not (see _flipIfChainLost:
		// a run the server still lists is never "lost", whatever this page's bubbles say).
		var rawListed: { [k: string]: boolean } = {};
		// A page that came back FULL is not a whole-queue answer: the query is capped
		// and ordered newest-first, so a bulk upload of 40 files returns the 20 newest
		// and omits the 20 about to run. Absence would then read as "finished" for
		// exactly the files that have not been touched yet. Report not-knowing instead.
		var truncated = false;
		// The RUNNING half on its own. A file indexes in at most a few parallel lanes, so the
		// running list practically never fills; the pending one fills on any bulk upload. A
		// complete running half still proves something when the pending half is cut off: a
		// file whose run is open and which is not running is waiting its turn.
		var runningTruncated = false;
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
			// Cut off when it came back full OR the server says more exist: a filtered
			// listing can return fewer rows than asked for and still not be the end, and
			// reading that page as whole turned every file past it into "Indexed".
			if (list.length >= WORKER_PASS_ADOPT_LIMIT || (lists[li] && lists[li].endOfList === false)) {
				truncated = true;
				// Which half this is, from its items (the callers pass them in either order).
				for (var si = 0; si < list.length; si++) {
					if (list[si] && list[si].status === 'running') { runningTruncated = true; break; }
				}
			}
			for (var i = 0; i < list.length; i++) {
				var item = list[i];
				if (!item || (item.status !== 'pending' && item.status !== 'running')) continue;
				var rawRef = parseIndexingRequestText(listedRequestText(item));
				if (rawRef) {
					if (rawRef.path) rawListed[rawRef.path] = true;
					if (rawRef.name) rawListed[rawRef.name] = true;
				}
				if (item.id && settledIds[item.id]) continue;
				// A compact listing (probeBgQueue) carries the label as request_text.
				var text = listedRequestText(item);
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
				if (item.status === 'running') {
					if (ref.path) running[ref.path] = true;
					if (ref.name) running[ref.name] = true;
				}
			}
		}
		var nowChecked = !truncated;
		var was = this.state.liveIndexKeys, changed = this.state.liveIndexChecked !== nowChecked;
		if (!changed) {
			for (var k in next) if (!was[k]) { changed = true; break; }
			if (!changed) for (var k2 in was) if (!next[k2]) { changed = true; break; }
		}
		if (!changed) {
			var wasRun = this.state.liveIndexRunning || {};
			for (var r1 in running) if (!wasRun[r1]) { changed = true; break; }
			if (!changed) for (var r2 in wasRun) if (!running[r2]) { changed = true; break; }
		}
		this.state.liveIndexKeys = next;
		this._rawListedIndexKeys = rawListed;
		if (this.state.liveIndexRunningChecked !== !runningTruncated) changed = true;
		// Files seen to LEAVE the queue: live in the previous look, absent from a complete
		// one. Kept until the file is live again, so a later look that comes back cut off
		// (a bulk upload behind it) cannot turn its "Indexed" back into "Indexing".
		var settledNow = this.state.liveIndexSettled || {};
		var settledNext: { [k: string]: boolean } = {};
		for (var sk in settledNow) if (settledNow[sk] && !next[sk]) settledNext[sk] = true;
		if (nowChecked) {
			for (var wk in was) if (was[wk] && !next[wk]) { if (!settledNext[wk]) changed = true; settledNext[wk] = true; }
		}
		this.state.liveIndexSettled = settledNext;
		this.state.liveIndexRunning = running;
		this.state.liveIndexRunningChecked = !runningTruncated;
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
		this.state.liveIndexRunning = {};
		this.state.liveIndexRunningChecked = false;
		this.state.liveIndexSettled = {};
		this.state.liveIndexChecked = false;
		this._liveIndexAt = 0;
		// Steps loaded into rows belong to that chat too.
		this.state.passPaging = {};
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
		//
		// SKIPPED (2026-11-20) when a look already confirmed the queue idle, no pass on
		// screen is newer than that, and this page tracks nothing live: then the answer is
		// known, and every tab return used to ask it again. "Nothing live" is still RECORDED,
		// as the look would have, so finished rows do not fall back to spinning. A run begun
		// elsewhere since shows up in the history page this follows (newer `_ts`, or a bg
		// poll attached to its running item), which is evidence, and the look runs.
		var sid = this.host.getIdentity().projectId;
		var idleAt = sid ? this._idleVerdictAt[sid] : 0;
		if (sid && idleAt && !this._hasLocalLiveIndexWork(sid) && this._newestIndexPassTs() <= idleAt) {
			this._recordLiveIndexKeys([{ list: [] }, { list: [] }]);
			return;
		}
		this._adoptWorkerIndexingPasses(0, true);
		this._ensureAdoptTick();
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
	attachForegroundPoll(source: any, itemId: string, opts?: any, ctx?: StreamDispatchContext): any {
		return this._fgPollWithEarlyProbe(source, itemId, opts, ctx);
	}

	private _fgPollWithEarlyProbe(source: any, itemId: string, opts?: any, ctx?: StreamDispatchContext): any {
		var self = this;

		// LIVE STREAMING takes over the whole method when it is on, rather than adding
		// a branch to the probe race, and both halves of that are deliberate.
		//
		// It attaches a sink to EVERY foreground poll, not only the one a fresh
		// dispatch makes: skapi's reader sends `since: 0` on its first tick, so a poll
		// re-attached after a reload or a tab return REPLAYS the turn from its first
		// byte. That is the only recovery a streamed turn has, because its row holds a
		// status and no body until csr-finalize stores one - attaching without a sink
		// settles it on that envelope and the answer is gone for good. A row that never
		// streamed simply hands back no chunks, and the substitution below is then a
		// no-op, so the cost of asking is one unused cursor.
		//
		// And it SKIPS the early-probe ladder, because a point lookup cannot answer for
		// a streamed row (there is no stored body to look up) yet would settle the race
		// on that empty envelope and stop the poll - killing the delivery of the very
		// answer it was trying to fetch early. What replaces it is the cadence: a
		// streaming poll's tick IS the delivery, so it runs at STREAM_POLL_INTERVAL.
		// A foreground row that turns out not to have streamed loses the 400ms probe
		// and gets a 1s interval instead of a 3s one, which is the trade.
		var live = this._beginLiveStream(itemId, ctx);
		if (live) {
			var inner = opts || {};
			var callerResponse = typeof inner.onResponse === 'function' ? inner.onResponse : null;
			var callerError = typeof inner.onError === 'function' ? inner.onError : null;
			// Both wrappers are needed and neither is redundant: a poll attached to a
			// HISTORY ITEM honours the onResponse passed here (that is how the re-attach
			// path resolves a turn), while a poll attached to a fresh DISPATCH ack takes
			// its callbacks from the original forwardRequest and reports only
			// through the promise. Substituting in one place would leave the other
			// reading the envelope.
			var streamOpts = Object.assign({}, inner, {
				onStream: function (chunk: string, _seq: number, via?: 'socket' | 'poll') {
					self._feedLiveStream(live, chunk, via);
				},
				onResponse: function (res: any) {
					var effective = res;
					if (isPollStopped(res)) self._closeLiveStream(live, false);
					else effective = self._settleLiveStream(live, res);
					if (callerResponse) callerResponse(effective);
				},
				onError: function (err: any) {
					self._closeLiveStream(live, false);
					if (callerError) callerError(err);
				},
			});
			var lp = source.poll(Object.assign({ latency: STREAM_POLL_INTERVAL }, streamOpts));
			var stopLp = lp && typeof lp.stop === 'function' ? lp.stop.bind(lp) : null;
			var wrapped: any = Promise.resolve(lp).then(function (res: any) {
				// A stop is not a result: the turn may still be running server side, so
				// the stream is discarded rather than assembled and finalized.
				if (isPollStopped(res)) { self._closeLiveStream(live, false); return res; }
				return self._settleLiveStream(live, res);
			}, function (err: any) {
				self._closeLiveStream(live, false);
				throw err;
			});
			// _trackPoll and the cancel path both reach for .stop, so the wrapper carries it.
			wrapped.stop = function () {
				self._closeLiveStream(live, false);
				if (stopLp) stopLp();
			};
			return wrapped;
		}

		// Callbacks ride along on the interval path exactly as before; the probe path below
		// fires onResponse itself, because a caller that only reacts through the callback
		// (the history drain does) would otherwise never learn the probe won.
		var base = source.poll(Object.assign({ latency: POLL_INTERVAL }, opts || {}));

		var lookup = chatEngineConfig().csrHistoryItemLookup;
		// The turn's pinned identity when the caller has one (reconciler plan, section 3
		// item 1): the probe reads the row by id, and the live identity may already be
		// another project's by the time the ack lands.
		var liveIdent = this.host.getIdentity();
		var ident: any = {
			projectId: ctx && ctx.projectId !== undefined ? ctx.projectId : (liveIdent && liveIdent.projectId),
			owner: ctx && ctx.owner !== undefined ? ctx.owner : (liveIdent && liveIdent.owner),
		};
		var platform = ctx && (ctx.platform === 'claude' || ctx.platform === 'openai') ? ctx.platform : (liveIdent && liveIdent.platform);
		if (!lookup || !itemId || !ident.projectId
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
		// The wrapper's own resolve, kept so that stop() below can SETTLE it.
		var resolveRaced: ((v: any) => void) | null = null;

		var raced: any = new Promise(function (resolve, reject) {
			resolveRaced = resolve;
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
		//
		// A stop SETTLES the wrapper, with the {status:'stopped'} shape the SDK's own
		// stop resolves with. It used to mark itself settled and then ignore the base
		// poll's stopped result in the handler above, so the wrapper never resolved at
		// all, and the dispatch chain awaiting it (which then held state.sending and
		// pendingAgentRequests; both clear at the ack now) never let go of the poll's
		// registration. Resolving here, rather than waiting on the base poll, also
		// covers an older skapi-js whose poll cannot be stopped.
		raced.stop = function () {
			if (settled) return;
			settled = true;
			clearProbes();
			if (stopBase) { try { stopBase(); } catch (e) { /* already gone */ } }
			if (resolveRaced) resolveRaced({ id: itemId, status: 'stopped' });
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

	// --- live streaming ----------------------------------------------------
	//
	// A streamed turn's answer NEVER reaches the polling row: the relay appends the
	// destination's raw bytes to a chunk table and the row settles with a status and
	// nothing else. So for a streamed turn this parser is not a nicety that makes the
	// wait prettier, it is the only place the answer exists until csr-finalize stores
	// one. Three things follow, and all three are load-bearing:
	//
	//   1. EVERY foreground poll gets a sink while streaming is on, not just the one
	//      the dispatch attaches. A tab return, a reload, a resumePolling all
	//      re-attach a poll to a still-running item, and skapi's reader sends
	//      `since: 0` on its first tick, so a fresh sink REPLAYS the whole stream from
	//      the beginning. Attaching without one settles that turn on an envelope and
	//      the user's answer is gone.
	//   2. The parser is keyed by SERVER ITEM ID, and so is the bubble it paints into.
	//      A history refetch replaces the local pending bubble with the server's copy
	//      of the same turn; that copy carries the same _serverItemId, so the next
	//      paint finds it and carries on. Nothing has to be rescued and nothing can be
	//      painted twice.
	//   3. The stream is never the source of truth. At settle the parser's ASSEMBLED
	//      body (byte equivalent to what a buffered call returns) goes through the
	//      same extractClaudeText / extractOpenAIText the buffered path uses, and a
	//      row that does hold a stored body wins outright.
	//
	// Background polls never get a sink, and that is safe because nothing on the bg
	// queue ever streams: an indexing pass must not (the worker READS its reply), and
	// a chat turn sent with attachments is deliberately left buffered for exactly the
	// reason point 1 gives, since the re-attach loop would poll it as a background
	// item and hand it no reader. See chatStreamWiring. A sink there would also spend
	// the request budget MAX_CONCURRENT_BG_POLLS exists to protect.

	/** Live streams by server item id. One per in-flight streamed turn. */
	private liveStreams: { [itemId: string]: LiveStreamState } = {};

	/** When skapi recorded a turn's response as having finished arriving, by server
	 *  item id. Read off the terminal envelope of a STREAMED turn (the only settle
	 *  that carries it, see _settleLiveStream) and used as the answer bubble's time
	 *  in place of this browser's clock. Entries are never removed: a settle reaches
	 *  here twice (the poll's onResponse, then the promise), and the value for an id
	 *  cannot change. */
	private _respondedAt: { [itemId: string]: number } = {};

	private _noteRespondedAt(itemId: string, response: any): void {
		if (!itemId || !isCsrStatusEnvelope(response)) return;
		var at = Number(response.responded);
		if (!isFinite(at) || at <= 0) return;
		// Self-healing for a session built without the constructor (the engine tests
		// drive Object.create(ChatSession.prototype)), like typewriterQueue below.
		if (!this._respondedAt) this._respondedAt = {};
		this._respondedAt[itemId] = at;
	}

	/** The time a live answer bubble is stamped with: when skapi received the
	 *  response, if the settle told us, else now. "Now" is what every bubble got
	 *  before, and it is still right for a buffered turn, whose settle hands back the
	 *  destination's body and nothing of skapi's; a history load then replaces it
	 *  with the server's value. */
	private _replyStampFor(msg: ChatMessage | undefined): number {
		var id = msg ? msg._serverItemId : undefined;
		var at = (typeof id === 'string' && id && this._respondedAt) ? this._respondedAt[id] : undefined;
		return typeof at === 'number' ? at : wallClockNow();
	}

	/**
	 * Open (or re-open) the live stream for `itemId`, or null when this poll must
	 * not carry one.
	 *
	 * Re-entrant on purpose: an auth-refresh retry re-dispatches the SAME turn under
	 * a NEW id, and a re-attach after a tab return replays an existing id from seq 0.
	 * Either way the bytes about to arrive are a whole stream, so an existing entry
	 * is discarded and a fresh parser takes its place - feeding a replay into the old
	 * parser would concatenate the answer with itself.
	 *
	 * `ctx` IS THE TURN'S OWN IDENTITY, and every caller that has one passes it.
	 * This used to read the LIVE getIdentity(), which is a bug of exactly the kind
	 * _callProviderFor documents and threads its own parameters to avoid: the user
	 * hits Send, then switches project or platform inside the ack round trip, and the
	 * stream that opens for the OLD turn is stamped with the NEW identity. What that
	 * costs is not cosmetic - `platform` picks which url csr-finalize is addressed
	 * with and which extractor reads the assembled body, `projectId`/`owner` scope
	 * the finalize itself, and `ownerKey` decides which chat the answer is painted
	 * into. Get them from the live read at the wrong moment and the turn is finalized
	 * against the wrong service (so its answer is never stored), parsed with the
	 * wrong provider's extractor, or painted into a conversation it does not belong
	 * to. The live read stays only as the fallback for a caller with nothing pinned.
	 */
	private _beginLiveStream(itemId: string, ctx?: StreamDispatchContext): LiveStreamState | null {
		if (!liveStreamingEnabled()) return null;
		if (!itemId) {
			// A streamed turn with no id is unreadable: the id is what the cursor polls,
			// what the bubble is found by, and what csr-finalize addresses. skapi stamps
			// one on every queued ack, so this should be unreachable - and if it is ever
			// reached the turn's answer is genuinely lost, which is worth a line in the
			// console rather than a silent empty bubble.
			console.warn('[chat-engine] live streaming is on but the dispatch reported no item id');
			return null;
		}
		// Pinned values win over the live read, field by field: a caller may know the
		// platform the turn was sent on without knowing which chat key it belongs to.
		var pinnedPlatform = ctx && (ctx.platform === 'claude' || ctx.platform === 'openai') ? ctx.platform : undefined;
		var ident = (pinnedPlatform && ctx && ctx.projectId !== undefined && ctx.owner !== undefined && ctx.ownerKey !== undefined)
			? null : this.host.getIdentity();
		var platform = pinnedPlatform || (ident ? ident.platform : undefined);
		if (platform !== 'claude' && platform !== 'openai') return null;
		var projectId = ctx && ctx.projectId !== undefined ? ctx.projectId : (ident ? ident.projectId : '');
		var owner = ctx && ctx.owner !== undefined ? ctx.owner : (ident ? ident.owner : '');
		var ownerKey = ctx && ctx.ownerKey !== undefined ? ctx.ownerKey : this.getHistoryCacheKey();
		var prev = this.liveStreams[itemId];
		if (prev) this._closeLiveStream(prev, false);
		var st: LiveStreamState = {
			id: itemId,
			ownerKey: ownerKey,
			platform: platform,
			projectId: projectId,
			owner: owner,
			parser: createSseParser(),
			painted: '',
			started: false,
			fed: false,
			ended: false,
			timer: null,
			lastPaintAt: 0,
			finalBody: null,
			transport: { socket: 0, poll: 0 },
		};
		this.liveStreams[itemId] = st;
		return st;
	}

	/** The chunk sink handed to skapi's poll. Raw relayed text, in order, never parsed
	 *  here: the parser owns the grammar and this owns the pacing. */
	private _feedLiveStream(st: LiveStreamState, chunk: string, via?: 'socket' | 'poll'): void {
		if (st.ended || typeof chunk !== 'string' || !chunk) return;
		st.fed = true;
		// Counted before the early-outs below, so a chunk that only joins an already
		// scheduled paint still tells the host which transport brought it.
		if (via === 'socket') st.transport.socket++;
		else if (via === 'poll') st.transport.poll++;
		st.parser.feed(chunk);
		if (st.timer) return; // a paint is already scheduled; this chunk joins it
		var self = this;
		// One paint per burst, floored at LIVE_PAINT_MIN_MS. A poll tick can deliver a
		// dozen chunks at once (and a replay delivers the whole answer at once), and
		// painting per chunk is exactly the 60-renders-a-second the per-bubble refresh
		// exists to avoid. The transport already paces at about 1/s, so this floor is
		// only there to survive a burst, not to set the rhythm.
		// The FIRST paint is immediate: the floor is there to survive a burst, and
		// spending it on the opening tokens would delay the one moment the whole
		// feature is for. (It also cannot be measured from lastPaintAt = 0, since
		// nowMs() is time since page load and is itself small early on.)
		var wait = st.lastPaintAt ? Math.max(0, LIVE_PAINT_MIN_MS - (nowMs() - st.lastPaintAt)) : 0;
		st.timer = setTimeout(function () { st.timer = null; self._paintLiveStream(st); }, wait);
	}

	/**
	 * Write the safe prefix of the answer so far into the turn's bubble.
	 *
	 * notify() is spent EXACTLY ONCE per turn, on the first paint, because that is a
	 * state change the per-bubble refresh cannot express: the bubble stops being a
	 * "Thinking..." spinner and becomes text. Every paint after it goes through
	 * refreshMessageBubble, which is what keeps a growing answer from rebuilding the
	 * whole display list once a second.
	 */
	private _paintLiveStream(st: LiveStreamState): void {
		if (st.ended) return;
		st.lastPaintAt = nowMs();
		// Another project (or another platform) is on screen. The turn keeps parsing -
		// its answer is still being assembled and will still be finalized - but nothing
		// is painted, because the index would point into a different chat's list.
		if (this.getHistoryCacheKey() !== st.ownerKey) return;
		var idx = this._liveTargetIndex(st.id);
		if (idx === -1) {
			// A QUEUED turn whose answer is already streaming has no "Thinking..." to
			// paint into: it is shown running only when the server says so, by id, and
			// these bytes ARE the server saying so (a turn streams only while it runs).
			// Promoted here, by its own id, and painted.
			this._noteServerState(st.id, 'running', st.ownerKey);
			idx = this._liveTargetIndex(st.id);
		}
		if (idx === -1) return;
		var msg = this.state.messages[idx];
		if (!msg) return;
		var snap = st.parser.snapshot();
		var next = liveSafePrefix(snap.text);
		// MONOTONIC, and this is the guard that makes liveSafePrefix's cuts safe to
		// make: a cut can shorten the safe prefix (a '[' arrives, a url starts), and
		// repainting shorter would have the answer visibly retreat. What was painted
		// was safe when it was painted, so it stays until there is MORE to show.
		if (next.length <= st.painted.length) return;
		var prev = st.painted;
		st.painted = next;

		// TYPE THE NEW TEXT IN, DO NOT JUMP TO IT.
		//
		// This used to assign msg.content directly, which is why a streamed answer
		// arrived as a series of lumps: the transport paces at about one chunk a
		// second, so a whole second of text appeared at once, and the only animation a
		// reader saw was the settle typewriting whatever was left. The point of
		// streaming is that the answer looks like it is being written, so each arrival
		// is revealed at the same rate the settle uses. enqueueTypewrite is sequential,
		// so consecutive chunks queue behind one another and read as one continuous
		// stream rather than racing each other into the same bubble.
		//
		// EXCEPT WHEN THE TEXT ARRIVES ALL AT ONCE, which is the replay path: reopening
		// a chat, or recovering an unfinalized turn, feeds the entire answer in one go.
		// Animating that would slowly retype an old message every time it is opened,
		// which is not a stream, it is a delay. So a jump larger than a live burst
		// could plausibly be lands whole, exactly as it did before.
		// SIZE DECIDES, NOT WHICH PAINT IT IS. The first paint of a live turn is a small
		// step from empty and should type, which is the moment the whole feature exists
		// for. The first paint of a REPLAY is the entire answer from empty and must not:
		// gating on "is this the first paint" gets both of those wrong, because they are
		// the same paint. Only the size tells them apart.
		var grew = next.length - prev.length;
		var animate = grew > 0 && grew <= LIVE_TYPE_MAX_STEP;

		if (animate) {
			// IDENTITY, NOT INDEX. typewriteIntoIndex re-finds its bubble by _localId
			// and falls back to the raw index when there is none, and that fallback is
			// unsafe here: a live reveal is in flight for seconds, and anything that
			// REPLACES the bubble meanwhile (a recovery landing the whole answer, a
			// history page swapping the list) leaves the stale animation to write its
			// older text into whatever now occupies that index. Observed: a recovered
			// answer being overwritten, a character at a time, by the truncation it had
			// just replaced. Minting an id here restores the bail the re-find exists to
			// provide, so a superseded reveal writes nothing.
			if (!msg._localId) msg._localId = this._newLocalId();
			// Left at its previous text and typed forward from there. The bubble is
			// never blanked: on a first paint prev is empty anyway, and on a later one
			// blanking would flash the answer away and retype it.
			if (!msg._streaming) { msg._streaming = true; this.host.notify(); }
			this.enqueueTypewrite(idx, next, msg._localId, prev);
		} else {
			msg.content = next;
			if (!msg._streaming) { msg._streaming = true; this.host.notify(); }
			else this.host.refreshMessageBubble(idx);
		}
		// ARRIVAL, not a user action: follow only a reader who is still pinned.
		this.host.scrollToBottomIfSticky();
		this._reportLiveStream(st, st.started ? 'update' : 'start', snap, next);
		st.started = true;
	}

	/** The bubble a live stream paints into: the turn's pending assistant placeholder,
	 *  found by server item id. Not by _localId, deliberately - a history refetch
	 *  replaces the local copy with the server's, and only the id survives that. */
	private _liveTargetIndex(itemId: string): number {
		return this.state.messages.findIndex(function (m) {
			return !!m && m.role === 'assistant' && !m.isBackgroundTask &&
				m._serverItemId === itemId && (!!m.isPending || !!m._streaming);
		});
	}

	/** Hand the host its optional observation update. Guarded: this runs on the paint
	 *  path, and a throwing hook must not cost the user the rest of their answer. */
	private _reportLiveStream(st: LiveStreamState, phase: 'start' | 'update' | 'end', snap: any, text: string): void {
		var hook = chatEngineConfig().onLiveStreamUpdate;
		if (!hook) return;
		try {
			hook({
				serverItemId: st.id, ownerKey: st.ownerKey, phase: phase, text: text,
				thinkingText: (snap && snap.thinkingText) || '',
				toolNames: (snap && snap.toolNames) ? snap.toolNames.slice() : [],
				complete: !!(snap && snap.complete),
				// Reported alongside `complete`, never instead of it: a host drawing
				// "still arriving" wants complete, a host drawing "this answer is
				// partial" wants this one, and an `error` frame is the case where the
				// two disagree. See sse.ts answerComplete.
				answerComplete: !!(snap && snap.answerComplete),
				errored: !!(snap && snap.errored),
				transport: { socket: st.transport.socket, poll: st.transport.poll },
			});
		} catch (e) { console.warn('[chat-engine] onLiveStreamUpdate threw', e); }
	}

	/** Stop painting and (when the turn really ended) assemble the body. `finished`
	 *  is false for a stream being discarded rather than settled: a retry replacing
	 *  it, or a stop, neither of which has an answer to assemble. */
	private _closeLiveStream(st: LiveStreamState, finished: boolean): void {
		// A settle arrives TWICE (the poll's onResponse, then the promise it resolves),
		// so everything that must happen once hangs off this rather than off `ended`
		// being read after it is set.
		var first = !st.ended;
		if (st.timer) { clearTimeout(st.timer); st.timer = null; }
		if (first) {
			st.ended = true;
			if (finished && st.fed) {
				st.parser.end();
				st.finalBody = st.parser.finalBody();
			}
		}
		if (this.liveStreams[st.id] === st) delete this.liveStreams[st.id];
		// Told BEFORE the ownerKey check below, and only when a 'start' was reported:
		// a host that drew a "thinking..." or "querying..." row off this stream has to
		// learn it is over even when the reader has moved to another chat, and telling
		// it about an end it never saw begin would be noise.
		if (first && st.started) this._reportLiveStream(st, 'end', st.parser.snapshot(), '');
		// The bubble stops being a live one from here. Its painted content is left
		// alone ON PURPOSE: it is what the typewriter resumes from a moment later, and
		// blanking it would put the answer the reader just watched arrive back to zero.
		if (this.getHistoryCacheKey() !== st.ownerKey) return;
		var idx = this._liveTargetIndex(st.id);
		if (idx !== -1 && this.state.messages[idx] && this.state.messages[idx]._streaming) {
			this.state.messages[idx]._streaming = false;
		}
	}

	/**
	 * Settle a streamed turn: end the parse, decide the body the rest of the session
	 * will read, and release the chunks.
	 *
	 * The substitution is one-directional and never a merge. A response that is a
	 * real stored body (a buffered turn, or a streamed one somebody already
	 * finalized) is returned untouched, because that is the destination's own answer
	 * and the stream is not entitled to overwrite it. Only a STATUS ENVELOPE - the
	 * shape a streamed row settles as, having stored nothing - is replaced, and then
	 * by the assembled body, which every caller downstream reads with the same
	 * extractor it uses for a buffered reply. Idempotent, because it is reached both
	 * through the poll's onResponse and through the promise it resolves.
	 */
	private _settleLiveStream(st: LiveStreamState, response: any): any {
		this._closeLiveStream(st, true);
		if (!isCsrStatusEnvelope(response)) return response;
		// Before any return below, and for every terminal status: the bubble that
		// settles this turn is stamped from it whether it ends as an answer, an error
		// or a truncation.
		this._noteRespondedAt(st.id, response);
		// RESOLVED only, and this is not caution, it is correctness. 'cancelled' is the
		// envelope the user's own Stop produces, and _isCancelledPollResult downstream
		// is what settles the turn as stopped: hand it an assembled body instead and a
		// cancelled turn renders the half answer the stop was meant to discard. Any
		// other status ('failed' with the destination's error, or a shape this does not
		// know) is likewise the authoritative account of the turn, and the stream is
		// never entitled to overwrite one.
		if (response.status !== 'resolved') return response;
		// MARKED BEFORE THE finalBody BAIL, and the order is the whole of the fix for
		// a settle that read NOTHING. A poll whose chunk reads degraded for its entire
		// life (the poller returns "no chunks this tick, more=true" on any transient
		// chunk-table error) settles on a resolved row with nothing fed and nothing
		// assembled. The turn then renders "No text response received from AI
		// provider" and, with the note skipped, that sentence is adopted over the
		// row's own empty copy on the next history load and clears the marker that
		// would have gone back for the answer: unreachable, with every byte of it
		// still in the chunk table. A turn that painted nothing is EXACTLY as
		// recoverable as one that was never polled at all - same row, same chunks,
		// same reason - so it leaves the same note and gets the same marker back.
		if (!this._mayFinalize(st)) this._rec().incomplete[st.id] = true;
		if (st.finalBody == null) return response;
		// An INCOMPLETE parse is still the best answer there is right now - it is what
		// the reader has been watching arrive - so it is handed downstream and shown.
		// What it is not is FINISHED, and the difference has to outlive this call:
		// without the note, the next history refetch would meet a bubble with text in
		// it, adopt that text over the row's own empty copy, and clear the very marker
		// that would have gone back for the rest. So the id is remembered, the chunks
		// are left alone (see _finalizeStreamedTurn), and the recovery replaces this
		// text with the whole answer on the next load. The note itself is taken above,
		// before the bail, because a settle that assembled NOTHING needs it just as
		// badly and used to return before reaching it.
		this._finalizeStreamedTurn(st);
		return st.finalBody;
	}

	/**
	 * May this parse be STORED as the turn's permanent answer?
	 *
	 * THE FAILURE THIS PREVENTS. Finalizing does two things at once: it stores what
	 * you give it as the row's result, and it DELETES the chunks it was assembled
	 * from. So finalizing a truncated parse is not a cosmetic loss, it is the
	 * permanent one: the truncation becomes the stored answer and the only copy of
	 * the missing part is deleted in the same call. And a truncated parse is a shape
	 * this repo has already paid for - a degraded chunk read (the poller degrades to
	 * "no chunks this tick, more=true" on any transient chunk-table error, and caps
	 * a long answer at 500k characters per response) can hand the settle a stream
	 * that stopped mid-answer. The row can settle 'resolved' on top of that, because
	 * the ROW's status describes the destination's request, not the client's read of
	 * it.
	 *
	 * THE POLICY ITSELF IS mayKeepStreamedAnswer (top of this file), shared with the
	 * recovery path so the two cannot drift apart again - they did, and the drift was
	 * silent: the live settle refused a failed turn while the recovery finalized one.
	 * What is local to this method is only the two things the free function cannot
	 * know: that there is an assembled body at all, and that this call site is
	 * reached only on a row that settled 'resolved' (the caller returns before it
	 * otherwise), which is the status it therefore states.
	 *
	 * The test the policy applies is deliberately NOT `complete`: a terminal event
	 * arrived and the answer finished are two claims, and an `error` frame satisfies
	 * the first while truncating the second. See sse.ts's answerComplete.
	 */
	private _mayFinalize(st: LiveStreamState): boolean {
		if (st.finalBody == null) return false;
		return mayKeepStreamedAnswer(st.parser.snapshot(), 'resolved');
	}

	/**
	 * Store the assembled body as the version history keeps, which is also what
	 * releases this request's chunks.
	 *
	 * The ASSEMBLED BODY and not the extracted text, because the row is read back by
	 * mapHistoryListToMessages through extractClaudeText / extractOpenAIText: storing
	 * the provider's own document is what makes a streamed turn indistinguishable
	 * from a buffered one on the next load, with no branch anywhere in the mapper.
	 *
	 * BEST EFFORT, and loudly so: the answer is already on screen and already in the
	 * history cache by the time this fires. A failure costs the chunks (they stay,
	 * and the turn stays re-readable) and a row that reads back empty, never the
	 * user's answer in front of them.
	 *
	 * WHAT IS DELIBERATELY NEVER FINALIZED, because finalize is also the only way to
	 * release chunks and it is tempting to reach for it as a cleanup:
	 *
	 *   - an INCOMPLETE parse (see _mayFinalize). Storing a truncation makes it
	 *     permanent AND deletes the part that was missing from it. A stream killed by
	 *     an `error` frame is one of these however terminal it looks: the frame ends
	 *     the stream, so `complete` is true, while the text is only what arrived
	 *     before the error. That is why the gate reads answerComplete.
	 *   - a FAILED turn. Its chunks hold the part of the answer that did arrive,
	 *     which is the only copy of that text there is, and the two ways to release
	 *     them both cost something real: storing the partial makes a truncated answer
	 *     the turn's permanent history AND masks the failure on read (csr-poll hands
	 *     back a finalized body before it ever looks at the row's error, so the turn
	 *     would read back as a clean short answer), while storing the error throws
	 *     the partial away outright. Keeping them costs storage on rows that produced
	 *     bytes and then failed, which is rare - a failure before the first byte (a
	 *     wrong API key, the common case) has no chunks to keep - and the poller
	 *     hands those chunks back alongside the error on every later read, so nothing
	 *     is stranded, only retained. Retention is the honest trade here; deletion is
	 *     not reversible.
	 *   - a CANCELLED turn, for the same reason plus one: the user's Stop means the
	 *     half answer is to be discarded, so writing it into history as the kept
	 *     version would resurrect exactly what the stop was for.
	 */
	private _finalizeStreamedTurn(st: LiveStreamState): void {
		if (st.finalized) return;
		if (!this._mayFinalize(st)) return;
		var fin = resolveForwardRequestFinalize();
		if (!fin || st.finalBody == null) return;
		st.finalized = true;
		// With if_absent, in the tab holding the settle lock: two tabs that both watched
		// the turn cannot replace a complete stored answer with a partial one, and when
		// another tab stored first its answer is read back and shown (_finalizeAnswer).
		var item = this._openMap()[st.id];
		this._finalizeAnswer(st.id, st.finalBody, {
			ownerKey: st.ownerKey, platform: st.platform as 'claude' | 'openai', projectId: st.projectId, owner: st.owner,
			queue: item ? item.queue : undefined,
		});
	}

	/** Painted-but-unsettled live text on a bubble, for the typewriter to resume from.
	 *  A pending assistant placeholder is created with content '' by every path that
	 *  makes one, so non-empty content on one can only have been painted here. */
	private _paintedTextAt(idx: number): string {
		var m = idx >= 0 ? this.state.messages[idx] : undefined;
		if (!m || m.role !== 'assistant' || typeof m.content !== 'string') return '';
		return m.content;
	}

	// --- recovering a streamed turn nobody finalized ------------------------
	//
	// ONE QUESTION, TWO BUGS. A streamed row's answer is not on the row: it is in the
	// chunk store until csr-finalize copies a version onto it. So a history page can
	// carry a row that is TERMINAL AND EMPTY, and everything downstream has to know
	// what that means. Read as "this turn answered nothing" it produces two separate
	// disasters that look unrelated:
	//
	//   1. A row that settled while no poll was attached (closed tab, discarded
	//      background tab, slept device) is never finalized, so it is terminal and
	//      empty FOREVER and the mapper emitted no assistant bubble for it. The
	//      answer is gone from the conversation with every byte of it still stored.
	//   2. A first-page refetch landing between the row going 'resolved' and finalize
	//      storing the body sees the same terminal-and-empty row for a turn that is
	//      on screen right now, and the merge - believing the server - drops the
	//      local bubble holding the answer. Reachable on every single streamed turn,
	//      since the window is a poll interval plus a round trip and a refetch fires
	//      on visibilitychange.
	//
	// Both are the same question: what should the merge believe when the server copy
	// is authoritative but empty? The answer is that such a copy is UNKNOWN, not
	// empty (mapHistoryListToMessages marks it `_streamPending`), and one rule covers
	// both cases: AN UNKNOWN ANSWER NEVER OVERWRITES A KNOWN ONE, AND AN UNKNOWN ONE
	// LEFT OVER IS RESOLVED BY READING THE CHUNKS BACK. Bug 2 falls out of the first
	// half (_adoptLocalAnswers, below), bug 1 out of the second.
	//
	// WHAT THE RECOVERY COSTS, and how that is bounded. A replay is a full read of
	// one turn's chunks - the SDK pages internally until the store is drained, so it
	// is one round trip for a short answer and a handful for a long one. A history
	// page could in principle hold several such rows, so:
	//   * it NEVER blocks the load. It is scheduled after the page has been rendered
	//     and runs on its own, and the bubble it will fill is already on screen.
	//   * it is SERIAL. One replay at a time, so a page holding five of them spends
	//     one connection, not five, and the newest turn (the one the reader is
	//     looking at) is filled first.
	//   * it is CAPPED per load (STREAM_RECOVERY_PER_LOAD), newest first. Older ones
	//     keep their marker and are recovered on a later load, or on demand through
	//     the public recoverStreamedAnswer().
	//   * it is ONCE PER ROW, ever: a successful recovery FINALIZES what it read, so
	//     the row gains a stored body and the next load sees an ordinary turn. Even
	//     when finalizing is impossible (no hook, a failed call), the id is
	//     remembered for the session so a re-render cannot loop on it.

	private _streamRecovery?: {
		/** Streams whose parse ended without a terminal event, so the text handed
		 *  downstream is not known to be the whole answer. See _settleLiveStream. */
		incomplete: { [id: string]: true };
		/** Rows this session has already tried to read back, so a repeated history
		 *  load (every visibilitychange fires one) cannot re-read the same chunks
		 *  forever. Deliberately NOT consulted by a user-driven retry: see the
		 *  `manual` argument to _readBackStreamedTurn. */
		attempted: { [id: string]: true };
		/** Rows whose read is in flight RIGHT NOW. Separate from `attempted`, which
		 *  outlives the request and survives a success: this one is the "something is
		 *  driving that bubble" fact the view renders its loader from, so it has to
		 *  come off however the read ends. */
		inflight: { [id: string]: true };
		/** Rows whose last read FAILED. The marker stays on for these (the answer is
		 *  still reachable), so without this the view cannot tell "not tried yet"
		 *  from "tried and could not read it" and has to word them the same. */
		failed: { [id: string]: true };
		queue: Array<{ id: string; ownerKey: string; platform: 'claude' | 'openai'; projectId: string; owner: string }>;
		running: boolean;
	};

	/** The recovery bookkeeping, created on first touch.
	 *
	 *  LAZY, not constructor-initialised, and for a concrete reason: ChatSession is
	 *  also built with Object.create(ChatSession.prototype) by the engine's own test
	 *  harnesses, which drive one method against a hand-built state rather than a
	 *  whole session. A field only the constructor creates is undefined there, and
	 *  the method that reaches for it throws, turning a test of the settle into a
	 *  crash about bookkeeping. */
	private _rec() {
		if (!this._streamRecovery) this._streamRecovery = { incomplete: {}, attempted: {}, inflight: {}, failed: {}, queue: [], running: false };
		return this._streamRecovery;
	}

	/**
	 * Put this session's fetching state onto the turn's bubble, so a view can tell a
	 * loader that means something from one that means nothing.
	 *
	 * ONLY EVER ONTO A STILL-MARKED BUBBLE. Once `_streamPending` is off the turn has
	 * an answer (or was proven to have none) and this says nothing about it; writing
	 * it there would leave a stale 'active' on a settled bubble forever.
	 *
	 * host.notify() is what redraws the widget, whose renderer is imperative. It is a
	 * no-op in agent.vue, whose state is a Vue reactive() - the property write above
	 * is what redraws there. Both are covered by doing both, and neither is a
	 * substitute for the other.
	 */
	private _markRecoveryPhase(itemId: string, phase: 'active' | 'failed' | null): void {
		var changed = false;
		for (var i = 0; i < this.state.messages.length; i++) {
			var m: any = this.state.messages[i];
			if (!m || m.role !== 'assistant' || m._serverItemId !== itemId || !m._streamPending) continue;
			var next = phase === null ? undefined : phase;
			if (m._streamRecovery === next) continue;
			if (next === undefined) delete m._streamRecovery; else m._streamRecovery = next;
			changed = true;
		}
		if (changed) this.host.notify();
	}

	/**
	 * Let LOCAL answers survive a freshly-mapped page whose copies of them are
	 * authoritative-but-empty. Call with the page BEFORE it replaces or merges into
	 * state.messages; mutates the page's bubbles in place.
	 *
	 * The adoption itself is history.ts's adoptLocalAnswerIntoPage (shared, so the
	 * clients' own mappers cannot fork it). What lives here is the one thing the
	 * pure function cannot know: whether the local text is the WHOLE answer. Text
	 * left by a stream that ended without a terminal event is not, so that bubble
	 * keeps its marker and gets read back even though it has content - otherwise a
	 * truncated answer would adopt itself over the row and never be corrected.
	 */
	private _adoptLocalAnswers(mapped: ChatMessage[], loadKey?: string): void {
		if (!mapped || !mapped.length) return;
		var tomb = this._tomb();
		var needsLocals = false;
		for (var i = 0; i < mapped.length; i++) {
			var mi: any = mapped[i];
			if (!mi) continue;
			if (mi._streamPending || (mi.isPending && mi.role === 'assistant' && !mi.isBackgroundTask) ||
				(mi._serverItemId && tomb[mi._serverItemId] && (mi.isPending || mi.isPendingQueued || mi.isPendingInProcess))) { needsLocals = true; break; }
		}
		if (!needsLocals) return;
		var locals: { [key: string]: ChatMessage } = {};
		var localUsers: { [key: string]: ChatMessage } = {};
		for (var j = 0; j < this.state.messages.length; j++) {
			var lm = this.state.messages[j];
			if (!lm || !lm._serverItemId) continue;
			// The same ownership predicate every other merge step uses, against the
			// load's SNAPSHOTTED key rather than a live read: a project switch mid-fetch
			// leaves another chat's transcript in state.messages, and ids are unique per
			// row, but a bubble stamped for another chat must never cross into this one.
			if (lm._ownerKey !== undefined && loadKey !== undefined && lm._ownerKey !== loadKey) continue;
			// FIRST wins: a page can only hold one assistant bubble per turn, and if the
			// local list somehow holds two the older one is the one the merge would
			// have kept.
			if (lm.role === 'assistant') { if (locals[lm._serverItemId] === undefined) locals[lm._serverItemId] = lm; }
			else if (lm.role === 'user') { if (localUsers[lm._serverItemId] === undefined) localUsers[lm._serverItemId] = lm; }
		}
		var pendingIncoming: ChatMessage[] = [];
		for (var k = 0; k < mapped.length; k++) {
			var inc = mapped[k];
			if (!inc) continue;
			var id = inc._serverItemId;
			if ((inc as any)._streamPending) pendingIncoming.push(inc);
			if (!id) continue;
			var local = locals[id];
			if ((inc as any)._streamPending) {
				if (!local) continue;
				if (!adoptLocalAnswerIntoPage(inc, local)) continue;
				// Adopted text that is not known to be complete keeps the marker: the read
				// back is what turns it into the whole answer.
				if (this._rec().incomplete[id]) inc._streamPending = true;
				continue;
			}
			// A turn the page still shows RUNNING keeps the live text the reader is
			// watching (reconciler plan, section 3 item 7): the page's copy is an empty
			// placeholder, and taking it blanked the answer until the next chunk.
			if (local && inc.role === 'assistant' && inc.isPending && !tomb[id]) adoptLiveTextIntoRunningRow(inc, local);
		}
		// A STALE PAGE NEVER REOPENS A SETTLED ITEM. The status index a page is read from
		// can lag the row, so a page fetched just after a turn settled can still show it
		// running or waiting. This page already applied its result (the id is
		// tombstoned), so the settled local copy stands in for the page's waiting one.
		for (var t = mapped.length - 1; t >= 0; t--) {
			var tm = mapped[t];
			var tid = tm ? tm._serverItemId : undefined;
			if (!tid || !tomb[tid]) continue;
			if (tm.role === 'assistant' && tm.isPending) {
				var la = locals[tid];
				if (la && !la.isPending && !la._streamPending) mapped[t] = Object.assign({}, la);
				continue;
			}
			if (tm.role === 'user' && (tm.isPendingQueued || tm.isPendingInProcess)) {
				var lu = localUsers[tid];
				if (!lu || lu.isPendingQueued || lu.isPendingInProcess || lu.isSendingToServer) continue;
				mapped[t] = lu.isCancelled ? Object.assign({}, lu) : this._settledUserCopy(tm, tid);
				var hasAnswer = false;
				for (var q = 0; q < mapped.length; q++) {
					var qm = mapped[q];
					if (qm && qm.role === 'assistant' && qm._serverItemId === tid) { hasAnswer = true; break; }
				}
				var lans = locals[tid];
				if (!hasAnswer && !lu.isCancelled && lans && !lans.isPending && !lans._streamPending) mapped.splice(t + 1, 0, Object.assign({}, lans));
			}
		}
		// CARRY THIS SESSION'S FETCHING STATE ONTO THE FRESH PAGE. `_streamRecovery`
		// describes the client, not the turn, so the mapper cannot know it and a
		// freshly mapped bubble arrives without it - which would render a read that is
		// in flight right now as "nothing is fetching this, press to load", and then
		// flip back a second later when the read lands. Every load path runs this
		// (the engine's loadHistory and agent.vue's fork both call it, on the page,
		// before it merges), so this is where the page learns what is already running.
		for (var p = 0; p < pendingIncoming.length; p++) {
			var pi: any = pendingIncoming[p];
			if (!pi._streamPending || !pi._serverItemId) continue;
			var phase = this._recoveryPhaseFor(pi._serverItemId);
			if (phase === null) delete pi._streamRecovery; else pi._streamRecovery = phase;
		}
	}

	/**
	 * This session's fetching state for one turn, from the bookkeeping rather than
	 * from any bubble. A queued entry counts as 'active': it is committed to be read,
	 * serially, and the reader has no way to tell "being read" from "next in line"
	 * apart from the wait.
	 */
	private _recoveryPhaseFor(itemId: string): 'active' | 'failed' | null {
		var rec = this._rec();
		if (rec.inflight[itemId]) return 'active';
		for (var i = 0; i < rec.queue.length; i++) if (rec.queue[i].id === itemId) return 'active';
		if (rec.failed[itemId]) return 'failed';
		return null;
	}

	/**
	 * PUBLIC DELEGATE, for a client that maps and merges its own history page.
	 *
	 * agent.vue keeps a forked mapper and a forked first-page merge (its mount path
	 * runs them, while resumePolling routes through loadHistory below), so both
	 * paths are live for the SAME row inside one component. Adoption is part of the
	 * merge contract, not an optional extra: without it that fork erases a streamed
	 * answer off the screen on every turn, which is the whole of MAJOR 3.
	 *
	 * Exposed rather than reimplemented because the rule needs the session's own
	 * `incomplete` set, which the pure helper (history.ts adoptLocalAnswerIntoPage)
	 * cannot see. A client that reached for the helper alone would adopt a TRUNCATED
	 * answer over the row and clear the marker that would have gone back for the
	 * rest - a fork that reads as correct and loses text.
	 *
	 * Call it exactly where loadHistory does: on the freshly mapped page, after
	 * applyHydratedBodies and BEFORE the page replaces or merges into state.messages.
	 */
	adoptLocalAnswers(mapped: ChatMessage[], loadKey?: string): void {
		this._adoptLocalAnswers(mapped, loadKey);
	}

	/**
	 * Queue the on-screen turns whose answer is only in the chunk store, newest
	 * first, and start draining. Never blocks and never throws.
	 *
	 * `ownerKey` is the chat the queue entries belong to, snapshotted by the caller:
	 * a recovery that lands after the user has moved on writes into that chat's
	 * cache, never into whatever list is on screen by then.
	 */
	private _scheduleStreamRecovery(ownerKey: string, platform: 'claude' | 'openai', projectId: string, owner: string): void {
		if (!streamRecoveryEnabled()) return;
		var rec = this._rec();
		var wanted: string[] = [];
		for (var i = this.state.messages.length - 1; i >= 0; i--) {
			var m = this.state.messages[i];
			if (!m || m.role !== 'assistant' || !(m as any)._streamPending || !m._serverItemId) continue;
			var id = m._serverItemId;
			if (rec.attempted[id]) continue;
			// A turn with a live stream attached is being delivered right now; reading
			// its chunks in parallel would spend a second full read to arrive at the
			// same answer the poll is already assembling.
			if (this.liveStreams[id]) continue;
			if (rec.queue.some(function (e) { return e.id === id; })) continue;
			wanted.push(id);
			if (wanted.length >= STREAM_RECOVERY_PER_LOAD) break;
		}
		if (!wanted.length) return;
		for (var w = 0; w < wanted.length; w++) {
			rec.queue.push({ id: wanted[w], ownerKey: ownerKey, platform: platform, projectId: projectId, owner: owner });
			// Marked as the queue is built, NOT as each read starts. Everything above
			// the cap is committed from this moment and its bubble may honestly spin;
			// everything the cap left behind is marked and has nobody, and its bubble
			// must say so rather than spin on a promise this scheduler never made.
			this._markRecoveryPhase(wanted[w], 'active');
		}
		this._drainStreamRecovery();
	}

	/**
	 * PUBLIC DELEGATE, the other half of what a forked history path needs.
	 *
	 * Same reason as adoptLocalAnswers: agent.vue's mount path never calls
	 * loadHistory, so without this its pages would MARK unfinalized streamed turns
	 * and then never read them back - CRITICAL 1 left unfixed on the client's
	 * primary path, with the marker making it look handled.
	 *
	 * Takes the load's SNAPSHOTTED identity rather than reading it live, and that is
	 * the reason this exists instead of the caller looping over recoverStreamedAnswer:
	 * that one reads getIdentity() at call time (right, for an on-demand affordance
	 * the user just clicked), which after a project switch racing the load would
	 * finalize the turn against the project they switched TO. Call it AFTER the page
	 * is rendered and the loading flags are cleared - it must never hold up the
	 * conversation it belongs to.
	 */
	scheduleStreamRecovery(ownerKey: string, platform: 'claude' | 'openai', projectId: string, owner: string): void {
		this._scheduleStreamRecovery(ownerKey, platform, projectId, owner);
	}

	/** Serial drain of the recovery queue. Each entry is one full chunk read. */
	private _drainStreamRecovery(): void {
		var rec = this._rec();
		if (rec.running) return;
		var next = rec.queue.shift();
		if (!next) return;
		rec.running = true;
		var self = this;
		this._readBackStreamedTurn(next.id, next.ownerKey, next.platform, next.projectId, next.owner)
			.catch(function () { /* every failure is already handled inside */ })
			.then(function () {
				self._rec().running = false;
				self._drainStreamRecovery();
			});
	}

	/**
	 * Read one unfinalized streamed turn back out of the chunk store and put its
	 * answer where the turn's answer belongs.
	 *
	 * Public because the cap above is deliberately small: a host that wants to offer
	 * "load the rest" on an older recoverable turn calls this with its
	 * `_serverItemId`, and gets the same path the automatic recovery uses. Safe to
	 * call for an id that turns out not to be recoverable, and safe to call twice -
	 * a second call while the first is still in flight is a no-op.
	 *
	 * THIS IS THE USER ASKING, and that is why it passes `manual`. The automatic
	 * recovery refuses a row it has already tried, so that a re-render, or the
	 * history load that every visibilitychange fires, cannot loop on the same
	 * chunks. A click is neither of those: it is one bounded request that a person
	 * asked for, and applying the loop guard to it made the affordance a button that
	 * silently did nothing for exactly the rows most likely to have it - every row
	 * an earlier read touched and could not settle.
	 */
	recoverStreamedAnswer(itemId: string): Promise<void> {
		if (!itemId) return Promise.resolve();
		var id = this.host.getIdentity();
		var platform = id && id.platform === 'openai' ? 'openai' : 'claude';
		return this._readBackStreamedTurn(itemId, this.getHistoryCacheKey(), platform as 'claude' | 'openai', id ? id.projectId : '', id ? id.owner : '', true);
	}

	private _readBackStreamedTurn(itemId: string, ownerKey: string, platform: 'claude' | 'openai', projectId: string, owner: string, manual?: boolean): Promise<void> {
		var read = resolveForwardRequestStream();
		if (!read || !itemId) return Promise.resolve();
		// IN FLIGHT is the only refusal a user-driven retry accepts, and it is about
		// this request rather than about the history of the row: two reads of the same
		// chunks at once spend a second full read to arrive at the same answer.
		if (this._rec().inflight[itemId]) return Promise.resolve();
		if (!manual && this._rec().attempted[itemId]) {
			// Refused, so nothing is fetching this after all. The scheduler filters
			// attempted ids out before it queues them, so reaching here means the row
			// was attempted AFTER being queued and its bubble is already wearing the
			// 'active' it was promised - which nothing would ever take off again.
			this._markRecoveryPhase(itemId, null);
			return Promise.resolve();
		}
		// Marked BEFORE the request, not after: a second load firing while this one is
		// in flight must not start a second read of the same chunks.
		this._rec().attempted[itemId] = true;
		this._rec().inflight[itemId] = true;
		// A retry is not still-failed. Cleared before the request so the bubble stops
		// offering "try again" the instant it is being tried.
		delete this._rec().failed[itemId];
		this._markRecoveryPhase(itemId, 'active');
		var self = this;
		var url = platform === 'openai' ? OPENAI_RESPONSES_API_URL : ANTHROPIC_MESSAGES_API_URL;
		// A parser of its own, fed from seq 0. Deliberately NOT registered in
		// liveStreams: this turn is over, nothing will paint into it, and a live
		// stream entry would make _beginLiveStream discard a genuinely live one that
		// happened to share the id after an auth-refresh retry.
		var parser = createSseParser();
		var fed = false;
		return Promise.resolve(read(itemId, {
			url: url, method: 'POST', service: projectId, owner: owner, since: 0,
			onStream: function (chunk: string) {
				if (typeof chunk !== 'string' || !chunk) return;
				fed = true;
				parser.feed(chunk);
			},
		})).then(function (res: any) {
			// A STOPPED READ IS NOT AN ANSWER, and it is not an envelope either, which
			// is exactly how it used to be mistaken for one. skapi's stop resolves the
			// read with a frozen { id, status: 'stopped' } - no in_queue, so
			// isCsrStatusEnvelope says no - and "not an envelope" was taken to mean
			// "the stored body". That object extracts to no text, so the turn was read
			// as "there was nothing here", its bubble was DELETED and its marker with
			// it, and the answer became unreachable because a read was cancelled. A
			// stop says nothing whatsoever about the turn: the chunks are untouched and
			// the row is still unfinalized, so the only correct move is to change
			// nothing and stay recoverable. The attempt is forgotten so the next
			// history load can try again.
			if (isPollStopped(res)) {
				delete self._rec().attempted[itemId];
				delete self._rec().inflight[itemId];
				// Back to 'idle', not to 'failed': nothing failed and nothing is coming.
				// The bubble stops spinning and starts offering to be asked again, which
				// is the truthful account of a read somebody stopped.
				self._markRecoveryPhase(itemId, null);
				return;
			}
			// The SDK resolves with a STORED BODY when the row turned out to be
			// finalized after all (somebody else's tab got there first), and with a
			// status envelope when it replayed chunks. Both are usable: the stored body
			// is the answer, the replay's assembled body is the answer.
			var envelope = isCsrStatusEnvelope(res);
			var body: any = null;
			if (res && !envelope) {
				body = res;
			} else if (fed) {
				parser.end();
				body = parser.finalBody();
			}
			var snap = parser.snapshot();
			// A body that came off the ROW is already stored, so re-storing it would be
			// a round trip that changes nothing; only an assembled one is new.
			var fromRow = !!(res && !envelope);
			// THE SAME KEEP POLICY THE LIVE SETTLE USES, not a second computation of
			// it. This used to ask parse completeness alone, so a row the live path
			// would never have finalized - one the destination FAILED, one killed by an
			// error frame - was finalized here instead, releasing precisely the chunks
			// that policy exists to keep. The row's own status is handed over with the
			// bytes: a replay of a failed row comes back as a 'failed' envelope, and
			// that is the authoritative account of the turn.
			var rowStatus = envelope && typeof res.status === 'string' ? res.status : undefined;
			// A DEGRADED READ IS NOT A FACT ABOUT THE TURN. csr-poll answers `more: true`
			// when a cap, or a transient chunk-table error, stopped the read short of the
			// end of the partition, which is the throttle shape this repo has already paid
			// for once. What came back is then a prefix of the answer, or nothing at all,
			// and neither says anything about what the turn actually contains. Treated as
			// an answer it is silent data loss twice over: an empty degraded read spliced
			// the bubble out as "this turn was empty", and a partial one cleared the
			// marker, so the truncation was adopted as the turn's answer and nothing ever
			// went back for the rest. `store` is already safe here (an unterminated parse
			// fails mayKeepStreamedAnswer), so this only has to keep the turn RECOVERABLE.
			var degraded = !!(envelope && res && res.more === true);
			var store = !fromRow && !degraded && body != null && mayKeepStreamedAnswer(snap, rowStatus);
			// The read is over however it settles below. Cleared BEFORE the apply, which
			// usually replaces the bubble outright: leaving it set would strand 'active'
			// on the one case the apply cannot touch (the reader has moved to another
			// chat), and that bubble would spin on its owner's next visit.
			delete self._rec().inflight[itemId];
			delete self._rec().failed[itemId];
			self._markRecoveryPhase(itemId, null);
			if (degraded) {
				// Forget the attempt so the next history load queues this row again,
				// exactly as the read-failed arm below does. Same reason: nothing
				// conclusive is known, so nothing may be made permanent.
				delete self._rec().attempted[itemId];
			}
			self._applyRecoveredAnswer(itemId, ownerKey, platform, projectId, owner, body, store, degraded);
		}, function (err: any) {
			// THE READ ITSELF FAILED, which is a different fact from "I read it and
			// there was nothing there", and the two must not settle the same way. This
			// used to clear the marker, which left the bubble empty on screen with
			// nothing on it for the recovery to find again: the answer was unreachable
			// for the rest of the session because one request 500'd. Nothing is known,
			// so nothing is changed - the CHUNKS are untouched, the row is still
			// unfinalized, the marker stays on and keeps rendering as "being fetched",
			// and the attempt is forgotten so the next history load queues it again.
			// (The "there was nothing there" case is _applyRecoveredAnswer's, and it
			// still drops the bubble, because an empty row really does mean an empty
			// turn.)
			//
			// What DID change is who is fetching it: nobody. Recorded so the view can
			// say "could not load this answer, try again" instead of drawing the same
			// loader a live turn draws - a spinner with nothing behind it is a promise
			// the client cannot keep, and this one used to be kept up for the rest of
			// the session.
			console.warn('[chat-engine] could not read back a streamed turn', itemId, err);
			delete self._rec().attempted[itemId];
			delete self._rec().inflight[itemId];
			self._rec().failed[itemId] = true;
			self._markRecoveryPhase(itemId, 'failed');
		});
	}

	/**
	 * Write a recovered answer into the turn's bubble (or into the owning chat's
	 * cache when the reader has moved on), then store it as the version history
	 * keeps.
	 *
	 * FINALIZING IS WHAT MAKES THIS RUN ONCE. It copies the answer onto the row and
	 * releases the chunks, so the next load reads an ordinary turn and no recovery is
	 * scheduled for it ever again, by anyone, in any tab. `store` is the caller's
	 * decision and carries two gates at once: mayKeepStreamedAnswer, the SAME keep
	 * policy the live settle applies (an incomplete, errored or failed read is shown
	 * but never stored, because storing it would make the truncation permanent and
	 * delete the part that was missing), and whether the body is new at all (one
	 * that came off the row is already stored).
	 */
	private _applyRecoveredAnswer(
		itemId: string, ownerKey: string, platform: 'claude' | 'openai',
		projectId: string, owner: string, body: any, store: boolean, degraded?: boolean,
	): void {
		var text = '';
		var isErr = isErrorResponseBody(body);
		if (body != null && !isErr) {
			text = ((platform === 'openai' ? extractOpenAIText(body) : extractClaudeText(body)) || '').trim();
		}
		if (!text && !isErr) {
			if (degraded) {
				// The read was cut short, so "no text" is a fact about the READ and not
				// about the turn. Dropping the bubble here would delete an answer whose
				// every byte is still sitting in the chunk table. Change nothing and stay
				// recoverable, exactly as a read that threw does.
				return;
			}
			// Nothing there. Either the row never streamed after all, or its chunks are
			// genuinely empty. Drop the marker and let the bubble go, which leaves the
			// list looking exactly as it did before any of this existed.
			this._clearStreamPendingMark(itemId, ownerKey, true);
			// A "Thinking..." bubble the funnel routed here (a streamed settle that read
			// nothing) has no marker to drop: the turn answered nothing, so say so.
			if (this._hasWaitingBubble(itemId, ownerKey)) {
				this.applyTerminal(itemId, EMPTY_PROVIDER_BODY, { ownerKey: ownerKey, platform: platform, projectId: projectId, owner: owner, instant: true });
			}
			return;
		}
		// Through the one funnel, by id, on screen or in the chat's own cache. Written
		// at once (the reader was not watching a stream), and as a CORRECTION: the bubble
		// may already hold an incomplete live parse that this replaces.
		this.applyTerminal(itemId, body, { ownerKey: ownerKey, platform: platform, projectId: projectId, owner: owner, instant: true, correction: true });
		// The marker comes off for an INCOMPLETE read, but NOT for a DEGRADED one, and
		// the difference is which side the incompleteness is on. A stream that genuinely
		// died mid-answer has chunks that will be incomplete forever, so leaving the
		// marker on would re-read the whole thing on every tab return to arrive at the
		// same partial: what the reader has is what there is. A DEGRADED read is the
		// other case entirely, the READER stopped early and the rest of the answer is
		// still in the chunk table, so clearing here would show a truncation, let
		// _adoptLocalAnswers carry it forward as the turn's answer, and leave nothing
		// to go back for the missing part.
		if (!degraded) delete this._rec().incomplete[itemId];
		if (!store || body == null || isErr) return;
		// if_absent and the settle lock, as for a live settle (_finalizeAnswer).
		this._finalizeAnswer(itemId, body, { ownerKey: ownerKey, platform: platform, projectId: projectId, owner: owner });
	}

	/**
	 * Take the "answer is elsewhere" marker off a turn once it is settled one way or
	 * the other. `drop` removes an assistant bubble that turned out to have no answer
	 * at all, which restores exactly the list the mapper used to produce for such a
	 * row (none), rather than leaving a permanently empty bubble behind.
	 *
	 * ONLY EVER CALLED FOR A TURN THAT WAS ACTUALLY READ. The marker is the one thing
	 * that keeps an unrecovered answer reachable, so it comes off only on the strength
	 * of an answer (the recovery wrote one) or of a read that came back empty. A read
	 * that FAILED, or one that was STOPPED, knows neither, and taking the marker off
	 * on either of those is how a bubble ends up empty forever with its answer still
	 * in the chunk table. `drop` is likewise never passed for a bubble that HAS
	 * content: an empty row is an empty turn, a failed read is not.
	 */
	private _clearStreamPendingMark(itemId: string, ownerKey: string, drop: boolean): void {
		if (ownerKey && this.getHistoryCacheKey() !== ownerKey) return;
		var changed = false;
		for (var i = this.state.messages.length - 1; i >= 0; i--) {
			var m = this.state.messages[i];
			if (!m || m.role !== 'assistant' || m._serverItemId !== itemId) continue;
			if (!(m as any)._streamPending) continue;
			if (drop && !m.content) { this.state.messages.splice(i, 1); changed = true; continue; }
			(m as any)._streamPending = false;
			changed = true;
		}
		if (changed) { this.updateHistoryCache(); this.host.notify(); }
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
		var self = this;
		this._resuming = true;
		return Promise.resolve()
			.then(function () {
				// The drain draws rows into the chat, so only with one on screen; the
				// return look below runs either way (looks are not gated on the view).
				if (self._viewMounted()) self.drainBgTaskQueue();
				// The same return already started a look (the reconciler's own visibility
				// listener, or a host that asked at once and resumes only after an async
				// step, like the widget's MCP grant refresh): that look covers it. A second
				// one would read every open item and the first page again.
				if (self._recReturnAt && nowMs() - self._recReturnAt < RETURN_COVER_MS) { self._recEnsure(); return; }
				// EVERY return re-reads the first page (owner, 2026-11-23: "when the user is
				// away and comes back it should always have all the chat, no missing"). This
				// replaces the 2026-11-20 rule that loaded history once and relied on polls
				// alone: a poll that was stopped, throttled or lost while the tab slept had
				// nothing behind it. See catchUpHistory.
				return self.catchUpHistory();
			})
			.catch(function (e: any) { console.error('[chat-engine] resume polling failed', e); })
			.then(function () { self._resuming = false; });
	}

	/**
	 * Does the chat on screen need its first history page fetched again to stay right?
	 * Only when a waiting bubble of THIS chat has nothing that will settle it: no live poll
	 * and no entry in bgTaskQueue (whose passes the drain and the queue check follow). Then
	 * the page is the only place its poll handle or its answer can come from (a turn on the
	 * background queue whose poll paused while the tab was hidden, for instance). A bubble
	 * with no server id yet is a send still in flight, which resolves on its own.
	 */
	needsHistoryRefetch(): boolean {
		var key = this.getHistoryCacheKey();
		var tracked: { [id: string]: true } = {};
		for (var q = 0; q < this.bgTaskQueue.length; q++) if (this.bgTaskQueue[q]) tracked[this.bgTaskQueue[q].id] = true;
		for (var i = 0; i < this.state.messages.length; i++) {
			var m = this.state.messages[i];
			if (!m || !(m.isPending || m.isPendingQueued || m.isPendingInProcess)) continue;
			if (m._ownerKey !== undefined && m._ownerKey !== key) continue;
			var sid = m._serverItemId;
			if (!sid) continue;
			if (this.historyItemPolls.has(sid) || tracked[sid]) continue;
			// The reconciler reads every open item itself (and a terminal one settles it):
			// nothing a refetch would add.
			if (this._recNewMode() && this._openMap()[sid]) continue;
			return true;
		}
		return false;
	}

	private _newLocalId(): string {
		this._lidSeq += 1;
		return 'lid_' + this._lidSeq;
	}

	/**
	 * The key every per-chat cache hangs off: the restored message cache, the
	 * hydrated-body memo, the live-index key and the per-file storage-path key.
	 *
	 * It carries the IDENTITY as well as the project and platform. A single
	 * browser can hold more than one conversation on one project without a
	 * reload — an anonymous visitor who signs in, or a dashboard user who logs
	 * out and back in as someone else — and with an identity-free key the
	 * previous conversation stayed in the cache and was re-rendered, and written
	 * back, as the new one's. `userId` is the same value the request queue is
	 * named after, so two identities that share a queue share a cache, which is
	 * exactly right.
	 */
	getHistoryCacheKey(): string {
		var id = this.host.getIdentity();
		return chatCacheKey(id.projectId, id.platform, id.userId);
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
	 * the old positional settle wrote the answer into the rescued placeholder because
	 * it was the only pending assistant left (the answer, twice). updateHistoryCache
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
		// "Thinking..." bubble of its own until the server says it runs, and the
		// promotion (_promoteChatItemToRunning) copies the user bubble's id itself.
		//
		// THIS IS THE ACK, and the only place a local stage meets its server id. It is
		// matched by _localId and nothing else: the queued ack used to stamp "the
		// first bubble still sending" on screen, which with two sends in flight gave
		// one turn the other's id. The user bubble's sending flags come off here too,
		// in the cache as well as on screen, so a remount never renders a turn the
		// server has as still "Sending".
		if (!itemId) return;
		var changed = false;
		var stamp = function (list: ChatMessage[]) {
			var hit = false;
			for (var i = 0; i < list.length; i++) {
				var m = list[i];
				if (!m || !m._localId) continue;
				if (m._localId !== userLid && m._localId !== placeholderLid) continue;
				var ackFlags = m._localId === userLid && m.role === 'user' && (!!m.isSendingToServer || !!m._dimSending) && !m._stageId;
				if (m._serverItemId === itemId && !ackFlags) continue;
				var patch: any = { _serverItemId: itemId };
				if (ackFlags) { patch.isSendingToServer = false; patch._dimSending = false; }
				list[i] = Object.assign({}, m, patch);
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

	// ─── THE ONE APPLY FUNNEL ────────────────────────────────────────────────
	//
	// Reconciler plan, section 3 items 1, 5 and 6. applyTerminal is the only writer of
	// a settled result. Every path that learns how an item ended goes through it: the
	// immediate dispatch, a queued send, a poll a history page attached, agent.vue's own
	// history poll, the background drain and the queue check, a live stream's settle
	// and a stream read back from the chunk store.
	//
	// WHAT IT REPLACED. Results used to be written by POSITION: "the first pending
	// bubble on screen", "the first user bubble still sending", "the newest settled
	// answer in the cache". With several requests waiting and a refetch landing between
	// a poll's ticks, that put one turn's answer into the next turn's bubble and then
	// dropped the second turn's own answer as "already rendered". Now an item is found
	// by its server id, on screen or in its own chat's cache, and nothing else.
	//
	// THE RULES. (1) An item settles once: its id is tombstoned for the life of the page
	// and a second result is refused, unless a stale page put its bubble back to waiting,
	// which the second result then settles again. (2) State only moves forward: queued,
	// running, terminal. (3) A resolved status envelope of a streamed turn is never an
	// answer: it goes to the live stream's own settle or to a read back of the chunks.
	// (4) The text is typed out only when the reader watched the turn live; an answer
	// that landed while they were away is written at once.

	/** Pinned identity of every item this page follows, by server id. Lazy, like the
	 *  stream-recovery bookkeeping, so a session built with Object.create works. */
	private _openItems?: { [id: string]: OpenItem };
	/** Items whose result was applied (or that were cancelled), for the life of the page. */
	private _terminalIds?: { [id: string]: true };
	/** Wall clock of the last time the tab was hidden; 0 = never in this page life. */
	private _hiddenAt?: number;
	private _visibilityWatched?: boolean;
	/** The by-id "is the next queued turn running yet" look (see _checkQueuedRunning). */
	private _queuedCheckTimer?: any;

	private _openMap(): { [id: string]: OpenItem } {
		if (!this._openItems) this._openItems = {};
		return this._openItems;
	}

	private _tomb(): { [id: string]: true } {
		if (!this._terminalIds) this._terminalIds = {};
		return this._terminalIds;
	}

	/** Remember when the tab was last hidden, for the "watched live" test. */
	private _watchVisibility(): void {
		if (this._visibilityWatched) return;
		this._visibilityWatched = true;
		var doc: any = _g.document;
		if (!doc || typeof doc.addEventListener !== 'function') return;
		var self = this;
		if (doc.visibilityState === 'hidden') this._hiddenAt = Date.now();
		doc.addEventListener('visibilitychange', function () {
			if (doc.visibilityState === 'hidden') self._hiddenAt = Date.now();
		});
	}

	/**
	 * Follow an item, with its identity pinned NOW (the ack, a page showing it running
	 * or waiting, a background entry being adopted). Adding an id already followed
	 * changes nothing but its state, and only forward; a terminal id is never reopened.
	 */
	trackOpenItem(itemId: string, init: OpenItemInit): void {
		if (!itemId || !init) return;
		this._watchVisibility();
		if (this._tomb()[itemId]) return;
		var map = this._openMap();
		var state: OpenItemState = init.state === 'running' ? 'running' : 'queued';
		var cur = map[itemId];
		if (!cur) {
			var plat = init.platform === 'openai' ? 'openai' : 'claude';
			if (init.platform !== 'claude' && init.platform !== 'openai') {
				var live = this.host.getIdentity();
				plat = live && live.platform === 'openai' ? 'openai' : 'claude';
			}
			map[itemId] = {
				ownerKey: init.ownerKey || '',
				projectId: init.projectId || '',
				owner: init.owner || '',
				platform: plat as 'claude' | 'openai',
				queue: init.queue,
				kind: init.kind === 'indexing' ? 'indexing' : 'chat',
				state: state,
				addedAt: Date.now(),
				lastConfirmed: 0,
			};
			if (init.cref) map[itemId].cref = init.cref;
			var who: ChatIdentity | null = null;
			if (init.anonymous === undefined || init.uid === undefined) {
				try { who = this.host.getIdentity(); } catch (e) { who = null; }
			}
			if (init.anonymous) map[itemId].anonymous = true;
			else if (init.anonymous === undefined && who && who.anonymous) map[itemId].anonymous = true;
			var uid = init.uid !== undefined ? init.uid : (who ? who.userId : '');
			if (uid) map[itemId].uid = uid;
			// The reconciler follows it from now on (one timer chain, whatever the count).
			this._recEnsure();
			return;
		}
		if (OPEN_STATE_RANK[state] > OPEN_STATE_RANK[cur.state]) cur.state = state;
		if (!cur.queue && init.queue) cur.queue = init.queue;
		if (!cur.cref && init.cref) cur.cref = init.cref;
	}

	/** The pinned identity of an item this page follows, or null. */
	getOpenItem(itemId: string): OpenItem | null {
		return (itemId && this._openMap()[itemId]) || null;
	}

	/** True once an item's result was applied (or it was cancelled) in this page. */
	isItemSettled(itemId: string): boolean {
		return !!itemId && !!this._tomb()[itemId];
	}

	private _closeItem(itemId: string): void {
		this._tomb()[itemId] = true;
		delete this._openMap()[itemId];
		if (this._recChunks) delete this._recChunks[itemId];
	}

	/** Did the reader watch this turn arrive? Live text was painted into it, or the tab
	 *  has stayed visible (with this chat on screen) since the page started following it. */
	private _watchedLive(itemId: string, painted: string, ownerKey: string): boolean {
		if (painted) return true;
		var doc: any = _g.document;
		if (doc && doc.visibilityState === 'hidden') return false;
		if (!this.host.isViewMounted || !this.host.isViewMounted()) return false;
		if (ownerKey && ownerKey !== this.getHistoryCacheKey()) return false;
		var item = this._openMap()[itemId];
		if (!item) return false;
		return !(this._hiddenAt && this._hiddenAt >= item.addedAt);
	}

	/** The identity a settle uses: the caller's, then the pinned one, then the live one. */
	private _settleIdentity(itemId: string, ctx?: TerminalContext): { ownerKey: string; platform: 'claude' | 'openai'; projectId: string; owner: string } {
		var c = ctx || {};
		var pin = this._openMap()[itemId];
		var live: any = null;
		var liveId = function (this: ChatSession) { if (!live) live = this.host.getIdentity() || {}; return live; };
		var ownerKey = c.ownerKey !== undefined && c.ownerKey !== '' ? c.ownerKey : (pin && pin.ownerKey ? pin.ownerKey : this.getHistoryCacheKey());
		var platform: any = (c.platform === 'claude' || c.platform === 'openai') ? c.platform : (pin ? pin.platform : liveId.call(this).platform);
		var projectId = c.projectId !== undefined ? c.projectId : (pin && pin.projectId ? pin.projectId : liveId.call(this).projectId);
		var owner = c.owner !== undefined ? c.owner : (pin && pin.owner ? pin.owner : liveId.call(this).owner);
		return { ownerKey: ownerKey || '', platform: platform === 'openai' ? 'openai' : 'claude', projectId: projectId || '', owner: owner || '' };
	}

	/**
	 * Apply how an item ended. The ONLY writer of a settled result; see the section note.
	 * `result` is what the server gave back: a provider body, an error body, a cancelled
	 * envelope, or a status envelope (which is not a result and is routed instead).
	 * True when a bubble was written.
	 */
	applyTerminal(itemId: string, result: any, ctx?: TerminalContext): boolean {
		if (!itemId || isPollStopped(result)) return false;
		var c = ctx || {};
		var who = this._settleIdentity(itemId, c);
		if (this._isCancelledPollResult(result)) {
			if (this._tomb()[itemId] && !this._hasWaitingBubble(itemId, who.ownerKey)) return false;
			this._closeItem(itemId);
			this._settleCancelledTurn(itemId, who.ownerKey);
			return true;
		}
		if (isCsrStatusEnvelope(result) && !isErrorResponseBody(result)) {
			// Not a result. Running/pending moves the item forward; a resolved envelope
			// is a streamed turn whose answer is in the chunk store, never "no text".
			if (result.status === 'running' || result.status === 'pending') {
				this._noteServerState(itemId, result.status, who.ownerKey);
			} else if (result.status === 'resolved') {
				this._readBackSettledStream(itemId, who);
			}
			return false;
		}
		if (this._tomb()[itemId] && !c.correction && !this._hasWaitingBubble(itemId, who.ownerKey)) return false;
		var onScreen = !who.ownerKey || who.ownerKey === this.getHistoryCacheKey();
		var outcome = onScreen ? this._applyTerminalOnScreen(itemId, result, who, c) : 'missing';
		if (outcome === 'missing') outcome = this._applyTerminalToCache(itemId, result, who, c);
		if (outcome === 'missing') return false;
		this._closeItem(itemId);
		if (!c.correction) this._noteProviderAnswer(who, result);
		return outcome === 'applied';
	}

	/** Hand a settled provider answer to the host (ChatHost.onProviderAnswer), whichever
	 *  path read it. Optional, and never in the way of the settle. */
	private _noteProviderAnswer(who: { projectId: string; platform: 'claude' | 'openai' }, result: any): void {
		if (!who || !who.projectId || (who.platform !== 'claude' && who.platform !== 'openai')) return;
		var hook: any;
		try { hook = this.host && (this.host as any).onProviderAnswer; } catch (e) { hook = undefined; }
		if (typeof hook !== 'function') return;
		try { hook(who.projectId, who.platform, result); } catch (e) { /* host hook */ }
	}

	/** A bubble of this item that still reads as waiting (a stale page can put one back). */
	private _hasWaitingBubble(itemId: string, ownerKey: string): boolean {
		var test = function (m: ChatMessage) {
			return !!m && m._serverItemId === itemId && (!!m.isPending || !!m.isPendingQueued || !!m.isPendingInProcess || !!m._streamPending);
		};
		if (!ownerKey || ownerKey === this.getHistoryCacheKey()) {
			if (this.state.messages.some(test)) return true;
		}
		var cached = ownerKey ? this.aiChatHistoryCache[ownerKey] : undefined;
		return !!cached && cached.messages.some(test);
	}

	/** The settled copy of a request bubble: its pending and sending flags come off,
	 *  everything that places it (file row, queue, chat, time, render key) stays. */
	private _settledUserCopy(u: ChatMessage, itemId?: string): ChatMessage {
		var out: ChatMessage = { role: 'user', content: u.content };
		var sid = itemId || u._serverItemId;
		if (sid) out._serverItemId = sid;
		if (u.isBackgroundTask) out.isBackgroundTask = true;
		if (u._indexFile) out._indexFile = u._indexFile;
		if (u._useBgQueue) out._useBgQueue = true;
		if (u._ownerKey !== undefined) out._ownerKey = u._ownerKey;
		if (u._ts !== undefined) out._ts = u._ts;
		if (u._localId !== undefined) out._localId = u._localId;
		if ((u as any)._fromBgChain) (out as any)._fromBgChain = true;
		return out;
	}

	/**
	 * The shared core: settle the item with id `itemId` inside `list`, by id only.
	 * Returns what happened and, for a reply to type out, where and from what.
	 */
	private _settleInList(list: ChatMessage[], itemId: string, result: any, who: { ownerKey: string; platform: 'claude' | 'openai'; projectId: string }, c: TerminalContext, mayType: boolean): { outcome: 'applied' | 'settled' | 'missing'; idx: number; isBg: boolean; typed: boolean; text: string; lid?: string; painted: string } {
		var none = { outcome: 'missing' as 'applied' | 'settled' | 'missing', idx: -1, isBg: false, typed: false, text: '', painted: '' };
		var aIdx = -1, settledIdx = -1, uIdx = -1;
		for (var i = 0; i < list.length; i++) {
			var m = list[i];
			if (!m || m._serverItemId !== itemId) continue;
			if (who.ownerKey && m._ownerKey !== undefined && m._ownerKey !== who.ownerKey) continue;
			if (m.role === 'assistant') {
				if (m.isPending || m._streamPending) { if (aIdx === -1) aIdx = i; }
				else if (settledIdx === -1) settledIdx = i;
			} else if (m.role === 'user' && uIdx === -1) uIdx = i;
		}
		if (aIdx === -1 && c.correction && settledIdx !== -1) aIdx = settledIdx;
		if (aIdx === -1 && uIdx === -1 && settledIdx === -1) return none;
		var u = uIdx !== -1 ? list[uIdx] : null;
		// Already answered (a page brought the server's settled copy in first), or the
		// request was cancelled: nothing of this item is waiting any more.
		if (aIdx === -1 && settledIdx !== -1) { none.outcome = 'settled'; return none; }
		if (aIdx === -1 && u && u.isCancelled) { none.outcome = 'settled'; return none; }
		// The request bubble is no longer waiting and nothing of the turn waits below it:
		// the page brought the server's settled copy in first, and that copy has no reply
		// bubble because the answer was empty (the mappers draw none for an empty
		// answer). Settled, whether or not this page applied it: every live turn keeps a
		// waiting bubble until its result lands (a queued one its pending flags, a
		// running one its "Thinking..."), so this never fires early. Writing a reply here
		// added "No text response..." under a turn the page already shows as answered.
		if (aIdx === -1 && u && !(u.isPendingQueued || u.isPendingInProcess || u.isSendingToServer || u.isPendingOlder)) {
			none.outcome = 'settled'; return none;
		}
		var a = aIdx !== -1 ? list[aIdx] : null;
		var isBg = !!((a && a.isBackgroundTask) || (u && u.isBackgroundTask));
		var isErr = isErrorResponseBody(result);
		var platform = who.platform;
		var answer = isErr ? getErrorMessage(result)
			: ((platform === 'openai' ? extractOpenAIText(result) : extractClaudeText(result)) || '').trim();
		// The completion marker is recorded as a fact and hidden from an INDEXING pass's
		// summary only; an ordinary reply that mentions the token keeps its own words.
		var reportedComplete = isBg && !isErr && !!answer && answer.indexOf(INDEXING_COMPLETE_MARKER) !== -1;
		var keyOf = (a && a._ownerKey !== undefined) ? a._ownerKey : (u && u._ownerKey !== undefined ? u._ownerKey : undefined);
		var reply: ChatMessage;
		var typed = false, text = '', painted = '', lid: string | undefined;
		if (isErr) {
			reply = { role: 'assistant', content: answer, isError: true, _serverItemId: itemId };
			// A failure the worker already sent again (errors.ts isRetriedFailure): not the
			// file's outcome, the same mark the history mapper sets.
			if (isBg && isRetriedFailure(result)) reply.isRetried = true;
			if (isBg) reply.isBackgroundTask = true;
			// Never typed, so it takes its display time here (both views draw the time
			// line only when `_ts` is set). An indexing pass's is stamped after the settle
			// by _stampPassDuration, with its duration.
			else reply._ts = this._replyStampFor(reply);
		} else if (isBg) {
			// A background-indexing reply sits INSIDE a collapsed row: nothing of it is
			// on screen, so it is written straight in, never typed (typing it held the one
			// shared typewriter queue the visible reply needs).
			var bgText = answer || NO_TEXT_RESPONSE;
			if (reportedComplete) bgText = bgText.split(INDEXING_COMPLETE_MARKER).join('').trim();
			reply = { role: 'assistant', content: bgText || EMPTY_INDEXING_REPLY, isBackgroundTask: true, _serverItemId: itemId };
			if (reportedComplete) reply._indexComplete = true;
		} else {
			text = answer || NO_TEXT_RESPONSE;
			// What a live stream already painted stays on screen and is where the
			// typewriter resumes; blanking it would retype what the reader just read.
			painted = a && (a.isPending || a._streaming) && typeof a.content === 'string' ? a.content : '';
			typed = mayType && !c.instant && this._watchedLive(itemId, painted, who.ownerKey);
			lid = this._newLocalId();
			reply = { role: 'assistant', content: typed ? painted : text, _serverItemId: itemId, _localId: lid };
			var note = extractRetrievalNote(result, answer);
			if (note) reply._retrieval = note;
			if (!typed) reply._ts = this._replyStampFor(reply);
		}
		if (keyOf !== undefined) reply._ownerKey = keyOf;
		if (u && (u.isPendingQueued || u.isPendingInProcess || u.isSendingToServer || u.isPendingOlder)) list[uIdx] = this._settledUserCopy(u, itemId);
		var idx: number;
		if (aIdx !== -1) { list[aIdx] = reply; idx = aIdx; }
		else { idx = uIdx + 1; list.splice(idx, 0, reply); }
		// Any OTHER waiting copy of this same request (a refetch re-mapped it beside the
		// local one) goes too. By id, never by guessing which "Thinking..." is a stray.
		for (var k = list.length - 1; k >= 0; k--) {
			if (k === idx) continue;
			var d = list[k];
			if (!d || d.role !== 'assistant' || d._serverItemId !== itemId || !(d.isPending || d._streamPending)) continue;
			list.splice(k, 1);
			if (k < idx) idx--;
		}
		return { outcome: 'applied', idx: idx, isBg: isBg, typed: typed, text: text, lid: lid, painted: painted };
	}

	private _applyTerminalOnScreen(itemId: string, result: any, who: { ownerKey: string; platform: 'claude' | 'openai'; projectId: string }, c: TerminalContext): 'applied' | 'settled' | 'missing' {
		var self = this;
		var r = this._settleInList(this.state.messages, itemId, result, who, c, true);
		if (r.outcome !== 'applied') return r.outcome;
		this.host.notify();
		var cacheKey = this.getHistoryCacheKey();
		if (r.typed) {
			var lid = r.lid as string, full = r.text;
			// The CACHE gets the whole answer now and again when the reveal ends: the
			// bubble being typed holds only a prefix until then, and a remount (or a
			// switch to another chat and back) renders the cache.
			Promise.resolve(this.enqueueTypewrite(r.idx, full, lid, r.painted)).then(function () {
				self._patchCachedText(cacheKey, lid, full);
			});
		}
		this.updateHistoryCache();
		if (r.typed) this._patchCachedText(cacheKey, r.lid as string, r.text);
		if (!r.isBg) {
			// ARRIVAL, not a user action: follow only a reader still pinned to the bottom.
			this.host.scrollToBottomIfSticky(true);
			// The turn that ran is over; ask the server whether the next one runs now.
			this._checkQueuedRunning(who.ownerKey);
		}
		return 'applied';
	}

	/** Put the whole text of a reply (found by local id) into a chat's cache copy. */
	private _patchCachedText(key: string, lid: string, text: string): void {
		var entry = key ? this.aiChatHistoryCache[key] : undefined;
		if (!entry || !lid) return;
		var msgs = entry.messages;
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (!m || m._localId !== lid || m.role !== 'assistant') continue;
			if (m.content === text) return;
			var next = msgs.slice();
			next[i] = Object.assign({}, m, { content: text });
			this.aiChatHistoryCache[key] = { messages: next, endOfList: entry.endOfList, startKeyHistory: entry.startKeyHistory };
			return;
		}
	}

	/** The same settle for a chat that is not on screen: made in its history cache,
	 *  which is what the next visit renders. Never typed. */
	private _applyTerminalToCache(itemId: string, result: any, who: { ownerKey: string; platform: 'claude' | 'openai'; projectId: string }, c: TerminalContext): 'applied' | 'settled' | 'missing' {
		var key = who.ownerKey;
		var existing = key ? this.aiChatHistoryCache[key] : undefined;
		if (!existing) return 'missing';
		var msgs = existing.messages.slice();
		var r = this._settleInList(msgs, itemId, result, who, c, false);
		if (r.outcome !== 'applied') return r.outcome;
		this.aiChatHistoryCache[key] = { messages: msgs, endOfList: existing.endOfList, startKeyHistory: existing.startKeyHistory };
		return 'applied';
	}

	/**
	 * A read of an item failed (its poll, or a by-id read). Only the server's own answer
	 * changes the screen: NOT_EXISTS settles the item as cancelled; a failure on the way
	 * (network, timeout, 429, 5xx) or of the sign-in leaves everything as it is, and the
	 * next look settles it; any other refusal is shown on the item, by id.
	 */
	onPollFailure(itemId: string, err: any, ctx?: TerminalContext): 'cancelled' | 'kept' | 'failed' {
		if (!itemId) return 'kept';
		this.historyItemPolls.delete(itemId);
		if (isNotExistsError(err)) {
			this.applyTerminal(itemId, cancelledEnvelope(itemId), ctx);
			return 'cancelled';
		}
		if (isTransportFailure(err) || isAuthExpiredError(err)) {
			console.warn('[chat-engine] a read of ' + itemId + ' failed on the way; the item is left as it is', err);
			return 'kept';
		}
		this.applyTerminal(itemId, pollErrorBody(err), ctx);
		return 'failed';
	}

	/**
	 * A streamed turn's row settled 'resolved' with no body: its answer is in the chunk
	 * store. A live stream that is still being fed settles it itself; otherwise the
	 * chunks are read back by id, and the read's apply goes through the funnel.
	 */
	private _readBackSettledStream(itemId: string, who: { ownerKey: string; platform: 'claude' | 'openai'; projectId: string; owner: string }): void {
		var st = this.liveStreams[itemId];
		if (st && st.fed && !st.ended) return;
		if (st) this._closeLiveStream(st, false);
		if (!streamRecoveryEnabled() || !resolveForwardRequestStream()) {
			// Nothing here can read the chunks: the answer is out of reach of this client.
			this.applyTerminal(itemId, EMPTY_PROVIDER_BODY, { ownerKey: who.ownerKey, platform: who.platform, projectId: who.projectId, owner: who.owner, instant: true });
			return;
		}
		// `manual`: a settled turn with a bubble waiting on it is read once per settle,
		// not refused because an earlier load already tried the row.
		void this._readBackStreamedTurn(itemId, who.ownerKey, who.platform, who.projectId, who.owner, true);
	}

	/** The server says the item is running (or waiting): move it forward, never back. */
	private _noteServerState(itemId: string, status: string, ownerKey?: string): void {
		if (!itemId || this._tomb()[itemId]) return;
		// Cancelled here already (the server removed it): a late 'running' read must not
		// bring back its Thinking... and Stop.
		if (this.cancelledServerIds.has(itemId)) return;
		var item = this._openMap()[itemId];
		if (status === 'running') {
			if (item && OPEN_STATE_RANK[item.state] < OPEN_STATE_RANK.running) item.state = 'running';
			this._promoteChatItemToRunning(itemId, ownerKey !== undefined ? ownerKey : (item ? item.ownerKey : undefined));
		}
	}

	/**
	 * Show a queued chat turn as RUNNING, found by its server id, because the server said
	 * so. This replaces the guess that "the next waiting bubble on screen" was the one
	 * the server took next. False when that turn is not waiting on screen.
	 */
	private _promoteChatItemToRunning(itemId: string, ownerKey?: string): boolean {
		if (ownerKey && ownerKey !== this.getHistoryCacheKey()) return false;
		var msgs = this.state.messages;
		var idx = -1;
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			// A turn whose cancel is still on the way is left as it is: its answer decides
			// (removed: cancelled; refused: _cancelling clears and the next read promotes it).
			if (m && m.role === 'user' && m._serverItemId === itemId && m.isPendingQueued && !m.isBackgroundTask && !m._stageId && !m.isCancelled && !m._cancelling) { idx = i; break; }
		}
		if (idx === -1) return false;
		var ex = msgs[idx];
		var promoted: ChatMessage = Object.assign({}, ex, { isPendingInProcess: true });
		delete promoted.isPendingQueued;
		msgs[idx] = promoted;
		var hasPlaceholder = msgs.some(function (m) { return !!m && m.role === 'assistant' && m._serverItemId === itemId && !!m.isPending; });
		if (!hasPlaceholder) {
			var placeholder: ChatMessage = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _serverItemId: itemId };
			if (ex._ownerKey !== undefined) placeholder._ownerKey = ex._ownerKey;
			if (ex._useBgQueue) placeholder._useBgQueue = true;
			msgs.splice(idx + 1, 0, placeholder);
		}
		this.host.notify();
		this.updateHistoryCache();
		return true;
	}

	/**
	 * After a chat turn ends, ask the SERVER whether the next queued turn of this chat
	 * runs now, by id: the oldest waiting main-queue turn with a server id is read once
	 * (csrHistoryItemLookup) a few times over a few seconds, and promoted when the row
	 * says running. Bounded and single: a new call restarts the ladder. A host without
	 * the by-id read gets no promotion; the turn shows as answered when its poll settles.
	 */
	/** The chat `key` is on screen and none of its main-queue turns shows as running
	 *  (no "Thinking..." of an ordinary turn): the next settle will not come to ask. */
	private _noRunningChatTurnOnScreen(key: string): boolean {
		if (!key || key !== this.getHistoryCacheKey()) return false;
		return !this.state.messages.some(function (m) {
			return !!m && !m.isBackgroundTask && !m._useBgQueue &&
				((m.role === 'assistant' && !!m.isPending) || (m.role === 'user' && !!m.isPendingInProcess));
		});
	}

	private _checkQueuedRunning(ownerKey?: string): void {
		var self = this;
		// With the batch reads, the next look reads every open item's status (a 'promote'
		// trigger forces it, and a counter that moved keeps the next two looks reading),
		// and a turn the server says runs is promoted by its id. No ladder of lookups.
		if (this._recNewMode()) { void this._recSched().trigger('promote'); return; }
		var lookup = chatEngineConfig().csrHistoryItemLookup;
		if (typeof lookup !== 'function') return;
		if (this._queuedCheckTimer) { clearTimeout(this._queuedCheckTimer); this._queuedCheckTimer = null; }
		var delays = [600, 2500, 6000];
		var step = 0;
		var look = function () {
			self._queuedCheckTimer = null;
			if (ownerKey && ownerKey !== self.getHistoryCacheKey()) return;
			var target: string | undefined;
			var msgs = self.state.messages;
			for (var i = 0; i < msgs.length; i++) {
				var m = msgs[i];
				if (!m || m.role !== 'user' || !m.isPendingQueued || m.isBackgroundTask || m._useBgQueue || m._stageId || m._cancelling) continue;
				var sid = m._serverItemId;
				if (!sid || self._tomb()[sid]) continue;
				if (target === undefined || sid < target) target = sid;
			}
			if (!target) return;
			var who = self._settleIdentity(target, ownerKey ? { ownerKey: ownerKey } : undefined);
			if (!who.projectId) return;
			var id = target;
			Promise.resolve(lookup!(buildHistoryItemFullId(who.platform, who.projectId, id), who.projectId, who.owner)).then(function (body: any) {
				if (!body || typeof body !== 'object' || !isCsrStatusEnvelope(body)) return;
				if (body.status === 'running') { self._noteServerState(id, 'running', ownerKey); return; }
				if (body.status === 'pending') next();
			}, function () { next(); });
		};
		var next = function () {
			step++;
			if (step >= delays.length || self._queuedCheckTimer) return;
			self._queuedCheckTimer = setTimeout(look, delays[step]);
		};
		this._queuedCheckTimer = setTimeout(look, delays[0]);
	}

	/**
	 * Settle a send that has NO server id: its POST failed, or the POST answered with a
	 * body directly. Found by the bubbles' own local ids, never by position.
	 */
	private _settleLocalTurn(key: string, userLid: string | undefined, placeholderLid: string | undefined, reply: ChatMessage): void {
		if (!userLid && !placeholderLid) return;
		var self = this;
		var apply = function (list: ChatMessage[]): boolean {
			var uIdx = -1, pIdx = -1;
			for (var i = 0; i < list.length; i++) {
				var m = list[i];
				if (!m || !m._localId) continue;
				if (userLid && m._localId === userLid && m.role === 'user') uIdx = i;
				else if (placeholderLid && m._localId === placeholderLid && m.role === 'assistant') pIdx = i;
			}
			if (uIdx === -1 && pIdx === -1) return false;
			if (pIdx !== -1 && !list[pIdx].isPending) return false; // already settled
			if (uIdx !== -1) {
				var u = list[uIdx];
				if (u.isPendingQueued || u.isPendingInProcess || u.isSendingToServer || u._dimSending) list[uIdx] = self._settledUserCopy(u);
			}
			var out: ChatMessage = Object.assign({}, reply);
			var host = pIdx !== -1 ? list[pIdx] : (uIdx !== -1 ? list[uIdx] : null);
			if (host && host._ownerKey !== undefined) out._ownerKey = host._ownerKey;
			if (out._ts === undefined) out._ts = self._replyStampFor(out);
			if (pIdx !== -1) list[pIdx] = out;
			else list.splice(uIdx + 1, 0, out);
			return true;
		};
		if (!key || key === this.getHistoryCacheKey()) {
			if (apply(this.state.messages)) {
				this.host.notify();
				this.updateHistoryCache();
				this.host.scrollToBottomIfSticky(true);
				return;
			}
		}
		var existing = key ? this.aiChatHistoryCache[key] : undefined;
		if (!existing) return;
		var msgs = existing.messages.slice();
		if (apply(msgs)) this.aiChatHistoryCache[key] = { messages: msgs, endOfList: existing.endOfList, startKeyHistory: existing.startKeyHistory };
	}

	/** A provider body (or error) read as the reply it renders as. */
	private _replyFromBody(body: any, platform: string): ChatMessage {
		if (isErrorResponseBody(body)) return { role: 'assistant', content: getErrorMessage(body), isError: true };
		var text = ((platform === 'openai' ? extractOpenAIText(body) : extractClaudeText(body)) || '').trim();
		var reply: ChatMessage = { role: 'assistant', content: text || NO_TEXT_RESPONSE };
		var note = extractRetrievalNote(body, text);
		if (note) reply._retrieval = note;
		return reply;
	}

	/**
	 * projectId/owner are passed explicitly by every caller: a request can be
	 * dispatched after the user moved to another project, and re-reading the live
	 * identity here would silently send the turn to THAT project instead of the
	 * one it was composed for. Falls back to the live read only when a caller
	 * omits them.
	 */
	private _callProviderFor(platform: string, prompt: string, messages: any, system: string, model: string | undefined, userId: string, extractContent: any, fileUrls?: any, projectId?: string, owner?: string, turn?: ChatTurnContext) {
		if (projectId === undefined || owner === undefined) {
			var id = this.host.getIdentity();
			if (projectId === undefined) projectId = id.projectId;
			if (owner === undefined) owner = id.owner;
		}
		// Read LIVE, unlike projectId/owner above, and deliberately: this decides
		// which MCP endpoint the turn's tools point at, and a retry after the
		// visitor signed in should use the authenticated one rather than the
		// project-scoped anonymous route it was composed under. Getting it wrong
		// costs a failed turn, never a wider read: the anonymous route is
		// read-only and public-records-only whoever calls it.
		var liveId = this.host.getIdentity();
		var mcpScope = { anonymous: liveId.anonymous, publicProjectId: liveId.publicProjectId };
		// The tool-listing key's user half comes from the same live read, because the
		// listing belongs to whoever the MCP endpoint authenticates as on THIS send.
		if (turn) turn.userId = liveId.anonymous ? '' : (liveId.userId || '');
		return platform === 'openai'
			? callOpenAIWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls, undefined, undefined, mcpScope, turn)
			: callClaudeWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls, undefined, undefined, mcpScope, turn);
	}

	/**
	 * A fresh per-send record for the request builder (see requests.ts ChatTurnContext).
	 * Chat turns only, and only OpenAI reuses a tool listing: Claude's MCP connector has no
	 * equivalent item, and indexing passes never come through here. Off unless the host
	 * set `reuseMcpToolList: true` in configureChatEngine.
	 */
	private _newChatTurn(platform: string): ChatTurnContext {
		var on = false;
		try { on = chatEngineConfig().reuseMcpToolList === true; } catch (_) { on = false; }
		return { reuseMcpToolList: platform === 'openai' && on };
	}

	/**
	 * What a settled chat turn means for the stored MCP tool listing: a failure drops it
	 * when the turn carried it (forgetMcpListToolsOnFailure decides whether reuse also
	 * stops); a good OpenAI body refreshes it. A stopped poll or a cancelled row says
	 * nothing either way. Applied once per turn: an exception thrown later by a UI
	 * handler on the same chain is not a provider failure.
	 */
	private _settleChatTurnTools(turn: ChatTurnContext | undefined, response: any, failed?: boolean): void {
		if (!turn || turn.settled) return;
		turn.settled = true;
		if (failed || isErrorResponseBody(response)) { forgetMcpListToolsOnFailure(turn, response); return; }
		if (isPollStopped(response) || this._isCancelledPollResult(response)) return;
		rememberMcpListTools(turn, response);
	}

	/**
	 * Send one chat turn and follow it to its end. Two phases (reconciler plan, section 3
	 * item 6):
	 *
	 * ACK. The POST that puts the turn on the server's queue. Only a 401 on THIS request
	 * may refresh the session and send again, once. When it comes back with the server
	 * id the turn is stamped (params.onItemId, matched by local id), pinned as an open
	 * item, and the sending state clears: pendingAgentRequests[key] (an immediate send's
	 * marker) is the ack and nothing longer.
	 *
	 * FOLLOW. The poll on that id. Whatever it ends with goes through applyTerminal or
	 * onPollFailure. A failed READ never sends the turn again: a 401 on a poll tick used
	 * to resend the whole prompt as a new request while the first one kept running.
	 * The one resend left is the server's own FINAL answer saying the turn's
	 * credentials expired (the MCP bearer the turn carried went stale): that turn is
	 * over and failed, so one fresh turn is sent in its place.
	 *
	 * params: key, projectId, owner, aiPlatform, aiModel, systemPrompt, text,
	 * boundedMessages, userId (the queue), extractContent, fileUrls, plus
	 *   userLid / placeholderLid  the local ids of the turn's bubbles (a send with no
	 *                             server id is settled through these);
	 *   onItemId(itemId)          the ack, every time an id is learned;
	 *   onAck(itemId?)            once, when the POST is over either way;
	 *   immediate                 an immediate send: marks pendingAgentRequests[key].
	 */
	dispatchAgentRequest(params: any) {
		var self = this;
		// The builder record of the LATEST send: a resend gets a new one, and only the
		// send that settles counts.
		var turn: ChatTurnContext | undefined;
		var ident: TerminalContext = {
			ownerKey: params.key, projectId: params.projectId, owner: params.owner,
			platform: params.aiPlatform, queue: params.userId,
		};
		// The turn's OWN identity, not a live read: the ack can land after the user moved.
		var streamCtx: StreamDispatchContext = {
			platform: params.aiPlatform, projectId: params.projectId, owner: params.owner, ownerKey: params.key,
		};
		// A watermark for the discovery listing that may have to find this send by its
		// cref (see _recAddPendingSend): the newest row of this chat known BEFORE the POST.
		var watermark = self._recNewestKnownId(params.key);
		var post = function (): Promise<any> {
			turn = self._newChatTurn(params.aiPlatform);
			// One client reference per POST (reconciler plan, section 3 item 9): a send
			// whose ack is lost is found by it in the discovery listing and never resent.
			if (crefSupported()) {
				turn.cref = newClientRef();
				self._stampCref(params.key, params.userLid, params.placeholderLid, turn.cref);
			}
			return Promise.resolve(
				self._callProviderFor(params.aiPlatform, params.text, params.boundedMessages, params.systemPrompt, params.aiModel, params.userId, params.extractContent, params.fileUrls, params.projectId, params.owner, turn)
			);
		};
		var postOnce = function (): Promise<any> {
			return post().catch(function (err: any) {
				// Only auth-expiry of the POST itself is worth a refresh and a second POST;
				// a malformed-request 400 re-fails identically, so never loop on it.
				if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(post);
				throw err;
			});
		};
		var acked = false;
		var ackResolve: (() => void) | null = null;
		var ackPromise: Promise<void> = new Promise<void>(function (r) { ackResolve = r; });
		var markAck = function (itemId?: string) {
			if (acked) return;
			acked = true;
			if (self.pendingAgentRequests[params.key] === ackPromise) delete self.pendingAgentRequests[params.key];
			if (ackResolve) ackResolve();
			if (typeof params.onAck === 'function') {
				try { params.onAck(itemId); } catch (e) { console.warn('[chat-engine] onAck threw', e); }
			}
		};
		var mayResendFor = function (body: any) {
			return isErrorResponseBody(body) && isAuthExpiredError(body) && !isNonRetryableRequestError(body);
		};
		// The one resend: refresh, POST once more, follow the new turn. When the refresh
		// or that POST fails, the turn being replaced is still on screen waiting (its
		// bubbles keep the old id, or no id at all for a direct body), so its own
		// failure is what settles it. Without this the rejection escaped `run` and the
		// "Thinking..." stayed for good.
		var resend = function (failed: any, oldItemId?: string): Promise<any> {
			return self.host.refreshSession().then(postOnce).then(function (next: any) { return follow(next, false); }, function (err: any) {
				self._settleChatTurnTools(turn, err, true);
				if (oldItemId) self.applyTerminal(oldItemId, failed, ident);
				else self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, self._replyFromBody(failed, params.aiPlatform));
				return { itemId: oldItemId, error: err };
			});
		};
		var follow = function (initial: any, mayResend: boolean): Promise<any> {
			var queued = !!initial && !!initial.poll && (initial.status === 'pending' || initial.status === 'running');
			if (queued && typeof initial.id === 'string' && initial.id) {
				var itemId: string = initial.id;
				self.trackOpenItem(itemId, {
					ownerKey: params.key, projectId: params.projectId, owner: params.owner, platform: params.aiPlatform,
					queue: params.userId, kind: 'chat', state: initial.status === 'running' ? 'running' : 'queued',
					cref: (turn && turn.cref) || (typeof initial.cref === 'string' ? initial.cref : undefined),
				});
				if (typeof params.onItemId === 'function') params.onItemId(itemId);
				markAck(itemId);
				// When a look (not this dispatch's poll) reads the answer, it does what the poll
				// below would: settles the turn's tools, and on an expired sign-in sends the turn
				// once more instead of showing the error (see _recApplyValue).
				// The turn is sent again at most once, whichever reader (this poll or a look)
				// reads the expired sign-in first: both can hold the same answer at once.
				var resent = false;
				var resendOnce = function (body: any): Promise<any> | null {
					if (resent) return null;
					resent = true;
					return resend(body, itemId);
				};
				var oi = self._openMap()[itemId];
				if (oi) {
					oi.turn = turn;
					if (mayResend) oi.resend = function (body: any) { void resendOnce(body); };
				}
				if (initial.status === 'running') self._noteServerState(itemId, 'running', params.key);
				else if (!params.immediate && self._noRunningChatTurnOnScreen(params.key)) {
					// A queued send acked as waiting while nothing of this chat runs on
					// screen: the turn ahead of it settled before this ack, so its settle's
					// "does the next one run now" look found this turn with no id yet and
					// skipped it. Ask about it now, by id.
					self._checkQueuedRunning(params.key);
				}
				var dp = self._fgPollWithEarlyProbe(initial, itemId, undefined, streamCtx);
				self._trackPoll(itemId, 'fg', dp);
				// This poll's own registration: a reader the reconciler started after
				// stopping this one (a return) is not this poll's to release.
				var myHandle = self.historyItemPolls.get(itemId);
				return Promise.resolve(dp).then(function (res: any) {
					if (self.historyItemPolls.get(itemId) === myHandle) self.historyItemPolls.delete(itemId);
					// A stop is this client letting go of the read (a cancel it made, which
					// settled the bubbles already), never a result.
					if (isPollStopped(res)) return { itemId: itemId, stopped: true };
					if (mayResend && mayResendFor(res)) {
						self._closeItem(itemId);
						var again = resendOnce(res);
						// A look already sent it again: that send is followed on its own.
						return again || { itemId: itemId, stopped: true };
					}
					self._settleChatTurnTools(turn, res);
					self.applyTerminal(itemId, res, ident);
					return { itemId: itemId, response: res };
				}, function (err: any) {
					self._settleChatTurnTools(turn, err, true);
					if (self.historyItemPolls.get(itemId) !== myHandle) return { itemId: itemId, error: err };
					self.onPollFailure(itemId, err, ident);
					return { itemId: itemId, error: err };
				});
			}
			markAck(undefined);
			if (queued) {
				// A queued ack with no id (an SDK too old to stamp one): followed by its own
				// poll and settled through the bubbles' local ids.
				return Promise.resolve(initial.poll({ latency: POLL_INTERVAL })).then(function (res: any) {
					if (isPollStopped(res)) return { stopped: true };
					self._settleChatTurnTools(turn, res);
					self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, self._replyFromBody(res, params.aiPlatform));
					return { response: res };
				}, function (err: any) {
					// Even a failure on the way is shown here, unlike everywhere else: a
					// request with no id can never be read again by anything (no history
					// attach, no later look can match it), so leaving it waiting would leave
					// it waiting forever.
					self._settleChatTurnTools(turn, err, true);
					self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, { role: 'assistant', content: getErrorMessage(err), isError: true });
					return { error: err };
				});
			}
			// The POST answered with the body itself: there is no request to follow.
			if (mayResend && mayResendFor(initial)) {
				return resend(initial);
			}
			self._settleChatTurnTools(turn, initial);
			self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, self._replyFromBody(initial, params.aiPlatform));
			return Promise.resolve({ response: initial });
		};
		if (params.immediate) this.pendingAgentRequests[params.key] = ackPromise;
		// A throw before the POST is even on its way (building the request) is a failed
		// POST like any other: it must still reach the ack, or `sending` and
		// pendingAgentRequests stay set and every later send goes down the queued path.
		var posted: Promise<any>;
		try { posted = postOnce(); } catch (syncErr) { posted = Promise.reject(syncErr); }
		var run = posted.then(function (initial: any) { return follow(initial, true); }, function (err: any) {
			markAck(undefined);
			// The POST failed ON THE WAY (no network, a timeout, a 5xx): the server may well
			// have queued it and only the answer was lost. With a cref the reconciler's
			// discovery listing finds the row by it and the turn carries on as if acked;
			// after two complete looks without it the turn says "Not sent. Retry?". The
			// bubbles stay waiting meanwhile, and nothing is ever sent again on its own.
			if (turn && turn.cref && isTransportFailure(err) && !isNotExistsError(err) && reconcilerReadsEnabled()) {
				self._recAddPendingSend({
					cref: turn.cref, key: params.key, userLid: params.userLid, placeholderLid: params.placeholderLid,
					projectId: params.projectId, owner: params.owner, platform: params.aiPlatform === 'openai' ? 'openai' : 'claude',
					queue: params.userId || params.projectId, watermark: watermark, params: params,
				});
				return { error: err, cref: turn.cref, pending: true };
			}
			// The POST itself failed: the server has no request, so there is no id to
			// settle by. The turn's own bubbles, found by their local ids, show the error.
			self._settleChatTurnTools(turn, err, true);
			self._settleLocalTurn(params.key, params.userLid, params.placeholderLid, { role: 'assistant', content: getErrorMessage(err), isError: true });
			return { error: err };
		});
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
	 * is also what keeps the queued-turn promotion (_checkQueuedRunning) off them:
	 * it follows the SERVER queue, and a staged turn has no server request behind
	 * it yet.
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
		var ident: IndexQueueIdentity = { projectId: svcId, owner: identity.owner, platform: platform, userId: identity.userId };
		var startedAt = nowMs();
		var deadline = startedAt + INDEXING_DRAIN_TIMEOUT_MS;
		// Read on the reconciler's one chain (a watch of the queue, see watchIndexQueue),
		// never on a timer of its own. Each read is fresh: this waits for the queue to
		// CHANGE, so a shared answer from before the turn's own upload is no use to it.
		var idleLooks = 0;
		// `at` of the last idle read counted: one read can only ever count once.
		var lastIdleAt = 0;
		var lastLookAt = -Infinity;
		// The read that is out (its token), and when it went. Two reads at once would let
		// both idle answers count as the two agreeing looks WITHOUT the confirm gap between
		// them, the one guard between the user and an answer from a half-indexed file.
		var askToken = 0, asked = 0, askedAt = 0;
		var nudged = false;
		return new Promise(function (resolve) {
			var done = false;
			var w: IndexQueueWatch;
			// The cap on its own timer: the due() check below runs only when a look runs,
			// which is once a minute while hidden and not at all while a sign-in is needed.
			var capTimer: any = null;
			var finish = function (v: 'drained' | 'timedout') {
				if (done) return;
				done = true;
				if (capTimer !== null) { clearTimeout(capTimer); capTimer = null; }
				// De-register on BOTH exits, or the waiter leaks and keeps the chain reading.
				var i = self._iqWatches.indexOf(w);
				if (i !== -1) self._iqWatches.splice(i, 1);
				var ni = self._drainNudges.indexOf(nudge);
				if (ni !== -1) self._drainNudges.splice(ni, 1);
				resolve(v);
			};
			// Indexing just ended somewhere (see _nudgeIndexingDrain): read at the next look
			// rather than at the end of the busy interval.
			var nudge = function () {
				// On the confirm cadence already: the two agreeing looks and the gap between
				// them are the guard, and pulling the second one forward must not happen.
				if (done || idleLooks > 0 || asked) return;
				// A pass whose ack is still in flight is not on the queue yet (see
				// trackIndexDispatch): a read now would only see it missing.
				if (self._indexDispatchesInFlight > 0) return;
				nudged = true;
				var doc: any = _g.document;
				if (doc && doc.visibilityState === 'hidden') { self._recEnsure(); return; }
				void self._recSched().trigger('frame');
			};
			w = {
				opts: { identity: function () { return ident; } },
				force: false, frame: false, runsCheckAt: 0, lastTryAt: 0,
				drain: {
					due: function () {
						if (done) return false;
						if (nowMs() >= deadline) { finish('timedout'); return false; }
						if (asked) {
							// A read that never came back counts as busy, and the next one goes.
							if (nowMs() - askedAt < INDEXING_DRAIN_LOOK_TIMEOUT_MS) return false;
							asked = 0;
							idleLooks = 0;
						}
						var since = nowMs() - lastLookAt;
						if (self._indexDispatchesInFlight > 0) {
							// Nothing on the queue can show that pass yet: this look is busy.
							if (since >= INDEXING_DRAIN_BUSY_POLL_MS) { idleLooks = 0; lastLookAt = nowMs(); }
							return false;
						}
						if (nudged && since >= INDEXING_DRAIN_NUDGE_MIN_GAP_MS) return true;
						return since >= (idleLooks > 0 ? INDEXING_DRAIN_CONFIRM_POLL_MS : INDEXING_DRAIN_BUSY_POLL_MS);
					},
					onAsk: function () {
						askToken += 1;
						asked = askToken;
						askedAt = nowMs();
						lastLookAt = askedAt;
						nudged = false;
						return askToken;
					},
					onSnapshot: function (snap: IndexQueueSnapshot | null, failed: boolean, token: number) {
						if (done || token !== asked) return;
						asked = 0;
						// Not known (a failed or cut-off read) or still working: busy.
						if (failed || !snap || !snap.checked || Object.keys(snap.keys).length > 0) idleLooks = 0;
						else if (snap.at !== lastIdleAt) { idleLooks += 1; lastIdleAt = snap.at; }
						if (idleLooks >= INDEXING_DRAIN_IDLE_LOOKS && nowMs() - startedAt >= INDEXING_DRAIN_MIN_MS) finish('drained');
					},
				},
			};
			self._iqWatches.push(w);
			self._drainNudges.push(nudge);
			capTimer = setTimeout(function () { capTimer = null; finish('timedout'); }, INDEXING_DRAIN_TIMEOUT_MS);
			// Node (SSR, scripts): the cap alone never keeps the process running.
			if (capTimer && typeof capTimer.unref === 'function') capTimer.unref();
			void self._recSched().trigger('add');
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
		var key = chatCacheKey(id.projectId, id.platform, id.userId);
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
			// Local ids on both bubbles: the ack stamps the server id onto THESE (by
			// local id, in the cache, since this chat is not on screen), and a send that
			// fails before any id exists is settled through them. Without them the pair
			// never got an id and every later settle had to guess which bubble it was.
			var offUser: ChatMessage = { role: 'user', content: composed, _ownerKey: key, _ts: wallClockNow(), _localId: this._newLocalId() };
			var offPlaceholder: ChatMessage = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _ownerKey: key, _localId: this._newLocalId() };
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
				messages: offCached.concat([offUser, offPlaceholder]),
				endOfList: offExisting.endOfList,
				startKeyHistory: offExisting.startKeyHistory,
			};
			var offUserLid = offUser._localId, offPlaceholderLid = offPlaceholder._localId;
			this.dispatchAgentRequest({
				key: key, projectId: id.projectId, owner: id.owner, aiPlatform: aiPlatform, aiModel: aiModel,
				systemPrompt: systemPrompt, text: composed, boundedMessages: offBounded.messages, userId: chatQueue,
				extractContent: extractContent, fileUrls: fileUrls,
				userLid: offUserLid, placeholderLid: offPlaceholderLid,
				onItemId: function (itemId: string) { self._stampTurnWithItemId(key, offUserLid, offPlaceholderLid, itemId); },
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

			// The same two phases as an immediate send (see dispatchAgentRequest). The ack
			// stamps the server id onto THIS bubble, found by its local id: the old ack
			// stamped "the first bubble still sending", which with two sends in flight
			// gave one turn the other's id. The answer, an error or a cancel then settle
			// it by that id through applyTerminal, on screen or in its chat's cache.
			var capturedKey = key;
			var capturedQueuedLid = queuedBubble._localId;
			this.dispatchAgentRequest({
				key: key, projectId: id.projectId, owner: id.owner, aiPlatform: aiPlatform, aiModel: aiModel,
				systemPrompt: systemPrompt, text: composed, boundedMessages: boundedQ.messages, userId: chatQueue,
				extractContent: extractContent, fileUrls: fileUrls,
				userLid: capturedQueuedLid,
				onItemId: function (itemId: string) { self._stampTurnWithItemId(capturedKey, capturedQueuedLid, undefined, itemId); },
			});
			return;
		}

		// immediate send. The turn's two bubbles get its server id at the ack (by their
		// local ids), and from then on it is an ordinary open item: applyTerminal settles
		// it by that id, on screen when this chat is showing and in its history cache
		// when it is not, so nothing has to re-render it on a remount.
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
		//
		// The bubble is excluded by its _localId, NOT by `m === immediateUser`. A host may
		// hold the state as a Vue reactive() (agent.vue does), and then every element the
		// filter sees is a reactive PROXY of the object pushed above, never the object
		// itself, so the identity test never matched: the bubble passed the filter (it has
		// none of the pending flags) and the push below added the same message again. Every
		// immediate send from bunnyquery.com went out with the question twice at the end of
		// `input` / `messages`. The widget's plain state was never affected.
		var immediateUserLid = immediateUser._localId;
		var historyForLlm = this.state.messages.filter(function (m) {
			if (m === immediateUser || (immediateUserLid && m && m._localId === immediateUserLid)) return false;
			return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder &&
				!m.isCancelled && !m.isBackgroundTask && !m.isError;
		});
		historyForLlm.push({ role: 'user', content: llmComposed });
		var bounded = buildBoundedChatMessages({
			platform: aiPlatform, model: aiModel, systemPrompt: systemPrompt, projectId: id.projectId,
			history: historyForLlm,
		});
		var immediatePlaceholderLid = immediatePlaceholder._localId;
		this.dispatchAgentRequest({
			key: key, projectId: id.projectId, owner: id.owner, aiPlatform: aiPlatform, aiModel: aiModel,
			systemPrompt: systemPrompt, text: composed, boundedMessages: bounded.messages, userId: chatQueue,
			extractContent: extractContent, fileUrls: fileUrls,
			immediate: true, userLid: immediateUserLid, placeholderLid: immediatePlaceholderLid,
			// THE fix for a turn rendering twice after navigate-away-and-back. Until
			// this existed the immediate-send pair carried no server id for its whole
			// life (only the QUEUED path stamped one, off its ack), so nothing could
			// tell the local copy and the server's copy of the same turn apart. See
			// _stampTurnWithItemId.
			onItemId: function (itemId: string) { self._stampTurnWithItemId(key, immediateUserLid, immediatePlaceholderLid, itemId); },
			// `sending` clears at the ACK, not when the answer lands (reconciler plan,
			// section 3 item 6). It is session-global (it routes the next send onto the
			// queued path and locks the pickers), and holding it for the whole turn meant
			// a poll that hung wedged every later send in every project. Once acked, the
			// turn's own "Thinking..." bubble is what routes the next send to the queue.
			onAck: function () { self.state.sending = false; self.host.notify(); },
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
		// With the batch reads, the reconciler promotes each pass by its id when the server
		// says it runs (_recApplyStatuses): no positional guess at all.
		if (this._recNewMode()) return;
		// Passes the queue check follows (byListing) are never promoted by this guess: the
		// worker runs several at once in any order, so "the next waiting one" is often the
		// wrong one, and the running listing promotes them by id (_promoteListedRunning).
		// The guess stays for anything else on the background queue.
		var listed: { [id: string]: true } = {};
		for (var q = 0; q < this.bgTaskQueue.length; q++) {
			var qe = this.bgTaskQueue[q];
			if (qe && qe.byListing) listed[qe.id] = true;
		}
		var guessed = function (m: ChatMessage) { return !(m._serverItemId && listed[m._serverItemId]); };
		if (this.state.messages.some(function (m) { return m.isPending && m.role === 'assistant' && m.isBackgroundTask && guessed(m); })) return;
		var nextIdx = this.state.messages.findIndex(function (m) {
			return m.isPendingQueued && m.role === 'user' && m.isBackgroundTask && guessed(m);
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

	/**
	 * The next queued chat turn shows "Thinking..." once the SERVER says it runs.
	 *
	 * This used to promote "the first waiting bubble on screen" the moment any turn
	 * ended, which was a guess about the server's queue, and wrong whenever the screen
	 * and the queue disagreed: a turn still running on the server after a failed read,
	 * a cancel in flight, a send whose ack had not come back. Now it asks: the oldest
	 * waiting turn is read by id and promoted when its row says running (see
	 * _checkQueuedRunning). Kept public under its old name for hosts that call it.
	 */
	promoteNextQueuedToRunning(): void {
		this._checkQueuedRunning(this.getHistoryCacheKey());
	}

	/**
	 * A queued send's answer, routed through the funnel by its server id. Kept for hosts
	 * that call it; the engine's own queued path settles through dispatchAgentRequest.
	 * Without a server id there is nothing to settle by, and nothing is written.
	 */
	onQueuedSendResponse(_composed: string, response: any, platform: string, serverId?: string, ownerKey?: string): void {
		if (!serverId) return;
		this.historyItemPolls.delete(serverId);
		this.applyTerminal(serverId, response, { platform: platform, ownerKey: ownerKey });
	}

	/** A queued send's failed read, routed through onPollFailure by its server id. */
	onQueuedSendError(_composed: string, err: any, serverId?: string, ownerKey?: string): void {
		if (!serverId) return;
		this.onPollFailure(serverId, err, { ownerKey: ownerKey });
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
				// Terminal: a late read of the removed row must not settle it again.
				self._closeItem(serverId as string);
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
					// Its own placeholder, by id. (A positional fallback here used to take
					// "the next Thinking below" when the id did not match, which belongs
					// to another turn.)
					var thById = self.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.isPending && m.role === 'assistant'; });
					if (thById !== -1) self.state.messages.splice(thById, 1);
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

	/** The button's label and the message it sends, read off the session so the
	 *  clients need no extra import. */
	readonly wrongAnswerLabel: string = WRONG_ANSWER_LABEL;
	readonly wrongAnswerMessage: string = WRONG_ANSWER_MESSAGE;

	/**
	 * Does this bubble get the "Wrong answer?" button: the free function's gate,
	 * and only on the latest answer, because the message it sends names no answer
	 * and the model reads it right after the last one. An answer already reported
	 * keeps its (disabled) button after the complaint turn lands below it.
	 */
	canReportWrongAnswer(msg: ChatMessage): boolean {
		if (!canReportWrongAnswer(msg)) return false;
		return this.wrongAnswerReported(msg) || this._isLatestAnswer(msg);
	}

	/** True when no chat turn follows `msg` in state.messages. Indexing rows and
	 *  cancelled turns do not count (neither reaches the model's history). Matched
	 *  by identity or by item id, since agent.vue hands in reactive proxies. */
	private _isLatestAnswer(msg: ChatMessage): boolean {
		var list = this.state.messages || [];
		var sid = msg._serverItemId, lid = msg._localId;
		for (var i = list.length - 1; i >= 0; i--) {
			var m = list[i];
			if (!m) continue;
			if (m === msg || (m.role === 'assistant' && ((sid && m._serverItemId === sid) || (lid && m._localId === lid)))) return true;
			if (m.isBackgroundTask || m.isCancelled) continue;
			return false;
		}
		return false;
	}

	/** True once this answer's "Wrong answer?" was sent (one click per answer). */
	wrongAnswerReported(msg: ChatMessage): boolean {
		if (!msg) return false;
		if ((msg as any)._wrongReported) return true;
		var key = msg._serverItemId || msg._localId;
		return !!key && !!this._wrongReported[key];
	}

	/**
	 * The "Wrong answer?" button: sends WRONG_ANSWER_MESSAGE as an ordinary visible
	 * user turn through dispatchComposedMessage, so it reads the same after a reload
	 * and both clients behave alike. The answer is marked first, so the button goes
	 * disabled at once. False when the bubble does not qualify or was already used.
	 * `pinned` is the caller's usual pinned identity and prompt (agent.vue pins them).
	 */
	reportWrongAnswer(msg: ChatMessage, pinned?: PinnedDispatchContext): boolean {
		if (this.wrongAnswerReported(msg) || !this.canReportWrongAnswer(msg)) return false;
		(msg as any)._wrongReported = true;
		var key = msg._serverItemId || msg._localId;
		if (key) this._wrongReported[key] = true;
		this.host.notify();
		this.dispatchComposedMessage(WRONG_ANSWER_MESSAGE, false, undefined, undefined, undefined, pinned);
		return true;
	}

	/**
	 * Stop waiting for the reply to the chat turn that is running now, and move on.
	 *
	 * `msg` is the turn's pending ASSISTANT bubble (the dot-trail "Thinking"
	 * placeholder), which is where both views draw the control. A turn's two bubbles
	 * carry the same _serverItemId, so it is also how the request is found.
	 * cancelQueuedMessage is the sibling for a turn still waiting in the queue and
	 * takes the USER bubble; the two differ in what they are handed and in what has
	 * to be unwound afterwards, not in what the server is asked.
	 *
	 * What ends the wait:
	 *   1. csr-cancel marks the running row cancelled. The worker stops relaying and
	 *      never stores an answer for it, so the reply cannot turn up later on this
	 *      device or another, and history replays the turn as cancelled;
	 *   2. the poll on it is stopped, which settles whichever chain was awaiting it
	 *      with a stopped result: dispatchAgentRequest's for an immediate send, the
	 *      queued chain for a promoted turn, the history poll after a reload. Each
	 *      reads a stopped result as "no reply" and releases its poll registration
	 *      (state.sending and pendingAgentRequests were already released at the ack);
	 *   3. the bubbles settle at once, without waiting for that chain: the user
	 *      bubble takes its cancelled form, the placeholder goes, the id is
	 *      tombstoned, and the server is asked whether the next queued turn runs now,
	 *      so its own "Thinking" appears when it does.
	 *
	 * What it does NOT do: the provider call already in flight on the worker runs
	 * to its end (a streamed one stops within about a second). A message sent
	 * behind it on the same queue starts once the worker acks the cancelled row.
	 *
	 * Refused without a server id (the ack has not come back yet; the views disable
	 * the control until it has) and while a cancel is already out. Indexing passes
	 * are not this method's business: their Stop is cancelIndexingGroup, which ends
	 * the file's whole chain.
	 */
	cancelPendingReply(msg: ChatMessage, idx: number): void {
		var self = this;
		var id = this.host.getIdentity();
		var serverId = msg._serverItemId;
		if (!serverId || msg._cancelling) return;
		if (msg.role !== 'assistant' || !msg.isPending || msg.isBackgroundTask) return;
		var platform = id.platform;
		if (platform !== 'claude' && platform !== 'openai') return;
		var url = platform === 'claude' ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
		var queueBase = id.userId || id.projectId;
		var queue = msg._useBgQueue ? bgIndexingQueueName(queueBase) : queueBase;
		var findPlaceholder = function () {
			return self.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.role === 'assistant' && !!m.isPending; });
		};
		// Same rule as cancelQueuedMessage: the rendered index is a hint, the server
		// id is the identity, and the role test keeps this off the user bubble that
		// shares the id.
		var at = (this.state.messages[idx] && this.state.messages[idx]._serverItemId === serverId && this.state.messages[idx].role === 'assistant')
			? idx
			: findPlaceholder();
		if (at !== -1) {
			this.state.messages[at] = Object.assign({}, this.state.messages[at], { _cancelling: true, _cancelError: undefined });
		}
		this.host.notify();
		var unmark = function (errMsg?: string) {
			var ci = findPlaceholder();
			if (ci === -1) return;
			self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg });
			self.host.notify();
		};
		Promise.resolve(this.host.cancelRequest({
			url: url, method: 'POST', id: serverId, queue: queue, service: id.projectId, owner: id.owner,
		})).then(function (result: any) {
			if (result && result.removed) {
				// Stop asking about a row that will never answer, THEN settle the
				// bubbles. The stop resolves the awaiting chain with a stopped result,
				// and that chain's own settle then finds nothing left to do.
				self._stopPoll(serverId as string);
				self._closeItem(serverId as string);
				self._settleCancelledTurn(serverId as string);
				return;
			}
			// Not removed: the row had already finished (or was already gone), so the
			// answer is on its way through the poll that is still attached. Nothing to
			// unwind and nothing to report: the user gets the reply they were waiting
			// for, a moment late.
			unmark(undefined);
		}).catch(function (err: any) {
			unmark(err && typeof err.message === 'string' && err.message ? err.message : 'Could not stop this request.');
		});
	}

	/** The cancelled form of a request bubble, with everything that keeps it in
	 *  place carried over: the file markers that hold an indexing pass in its
	 *  collapsed row, the chat it belongs to, its send time and its render key. */
	private _cancelledCopyOf(m: ChatMessage, itemId?: string): ChatMessage {
		var cancelled: ChatMessage = { role: 'user', content: m.content, isCancelled: true };
		if (itemId !== undefined) cancelled._serverItemId = itemId;
		else if (m._serverItemId !== undefined) cancelled._serverItemId = m._serverItemId;
		if (m.isBackgroundTask) cancelled.isBackgroundTask = true;
		if (m._indexFile) cancelled._indexFile = m._indexFile;
		if (m._useBgQueue) cancelled._useBgQueue = true;
		if (m._ownerKey !== undefined) cancelled._ownerKey = m._ownerKey;
		if (m._ts !== undefined) cancelled._ts = m._ts;
		if (m._localId !== undefined) cancelled._localId = m._localId;
		return cancelled;
	}

	/**
	 * Settle a turn as cancelled wherever it lives, and let the queue move on.
	 *
	 * On the chat on screen: every pending placeholder carrying the id goes (a
	 * history refetch can have re-mapped the running turn into a second one), the
	 * request bubble takes its cancelled form, and the next queued turn is promoted
	 * so the conversation does not sit on an "(In queue)" bubble with nothing
	 * running. For a chat that is NOT on screen (the user moved on while the turn
	 * ran, and it was cancelled from elsewhere) the same edit is made in that chat's
	 * history cache, which is what the next visit renders.
	 *
	 * Idempotent on purpose: a cancel this client made settles the bubbles at once,
	 * and the chain that was awaiting the poll settles again a moment later when the
	 * stop resolves it. The second pass finds nothing to do.
	 */
	private _settleCancelledTurn(itemId: string, ownerKey?: string): void {
		if (!itemId) return;
		if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
			this._applyCancelToCache(ownerKey, itemId);
			return;
		}
		var changed = false, wasBg = false;
		for (var i = this.state.messages.length - 1; i >= 0; i--) {
			var m = this.state.messages[i];
			if (!m || m._serverItemId !== itemId) continue;
			if (m.role === 'assistant' && m.isPending) { this.state.messages.splice(i, 1); changed = true; continue; }
			if (m.role === 'user' && !m.isCancelled) {
				if (m.isBackgroundTask) wasBg = true;
				this.state.messages[i] = this._cancelledCopyOf(m, itemId);
				changed = true;
			}
		}
		this.cancelledServerIds.delete(itemId);
		if (!changed) return;
		if (wasBg) this.promoteNextBgQueuedToRunning(); else this.promoteNextQueuedToRunning();
		this.updateHistoryCache();
		this.host.notify();
	}

	/**
	 * _settleCancelledTurn for a chat that is not on screen: the same edit, made in
	 * its history cache, by id only. Every bubble of a turn that can be cancelled
	 * carries its id: an off-chat send's pair is stamped at the ack like any other
	 * (dispatchComposedMessage), and a cancel needs the id to be sent at all. (The
	 * positional fallback this had, "the trailing pending placeholder", could take
	 * another turn's.)
	 */
	private _applyCancelToCache(key: string, itemId: string): void {
		var existing = key ? this.aiChatHistoryCache[key] : undefined;
		if (!existing) return;
		var msgs = existing.messages.slice();
		var changed = false;
		var pIdx = -1, uIdx = -1;
		for (var i = msgs.length - 1; i >= 0; i--) {
			var m = msgs[i];
			if (!m || m._serverItemId !== itemId) continue;
			if (m.role === 'assistant' && m.isPending) { msgs.splice(i, 1); changed = true; pIdx = i; }
			else if (m.role === 'user' && !m.isCancelled && uIdx === -1) uIdx = i;
		}
		if (uIdx !== -1) { msgs[uIdx] = this._cancelledCopyOf(msgs[uIdx], itemId); changed = true; }
		if (!changed) return;
		this.aiChatHistoryCache[key] = { messages: msgs, endOfList: existing.endOfList, startKeyHistory: existing.startKeyHistory };
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
		var idn = this.host.getIdentity();
		var scoped = indexScopeKey(idn.projectId, idn.platform) + '|' + group.key;
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
					this._forgetChain(ident.projectId, runPath);
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
		// And every pass of this file the client ALREADY knows to be live, now, not on
		// the next drain. `cancellableIds` below is the row's own list, and it leaves
		// out an in-flight pass that a later pass has already outlived - a rule written
		// for one pass at a time, which a PDF no longer is: the worker runs several
		// windows of one file at once and they settle out of order, so the row's list
		// can be empty while eight passes are running. The sweep reads the key just
		// recorded above and cancels each known pending pass once (it skips one already
		// being cancelled, so the loop below cannot cancel a bubble twice). Server-side,
		// one cancelled window stops the whole document.
		this._sweepCancelledIndexing();
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
	//
	// `paintedText` is what a LIVE STREAM already put in this bubble. The reveal
	// starts from the point the two texts stop agreeing rather than from zero: the
	// authoritative answer still replaces the live one character for character (it is
	// the only source of truth, and this method writes fullText and nothing else), but
	// retyping a paragraph the reader has just watched arrive is the one thing that
	// would make a streamed turn look worse than an unstreamed one.
	typewriteIntoIndex(idx: number, fullText: string, localId?: string, paintedText?: string): Promise<void> {
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
		// Resume point, computed against the SAME regions the reveal below honours, so
		// a resume landing inside a link or a fence starts at that region's end and the
		// region is never on screen half-revealed.
		var i = paintedText ? typewriterResumeIndex(paintedText, fullText, regions) : 0;
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
				// THE AUTHORITATIVE TEXT ALWAYS WINS, ABORT OR NOT. This write used to
				// be skipped on abort, which is a rule that made sense when the bubble
				// held a PREFIX of fullText: stopping early left the reader with less
				// of the right answer, and the list was about to be replaced anyway.
				// Live streaming broke that premise. The bubble now starts out holding
				// the text the STREAM painted, which is a different string from the
				// authoritative one (the parser's untrimmed render feed, cut at a safe
				// reveal boundary, possibly a truncation of a degraded read), and
				// skipping the write leaves THAT as the turn's rendered answer. An
				// abort is a reason to stop animating; it is never a reason to keep the
				// provisional text over the settled one.
				//
				// Re-find the bubble by localId and, if it's gone, bail WITHOUT
				// writing, and never fall back to the numeric idx, which a concurrent
				// array mutation may have repurposed for an unrelated message
				// (mirrors frame()'s currentIdx===-1 bail below). That bail is what
				// keeps this safe on the two paths that abort: a history page that
				// REPLACED the list has already dropped this bubble (and any copy of it
				// the merge adopted carries the same _localId, which is precisely the
				// bubble that should receive the answer), and a view teardown has no
				// bubble on screen to disturb.
				var fi = localId ? self.state.messages.findIndex(function (mm) { return mm._localId === localId; }) : idx;
				if (fi !== -1) {
					var t = self.state.messages[fi];
					if (t) { t.content = fullText; self.host.refreshMessageBubble(fi); }
				}
				self.state.typing = false;
				resolve();
			}
			// requestAnimationFrame is PAUSED in a backgrounded tab (setTimeout only
			// throttles), so an rAF-driven reveal would freeze there, leaving a blank
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
	enqueueTypewrite(idx: number, fullText: string, localId?: string, paintedText?: string): Promise<any> {
		var self = this;
		// Stamp the reply bubble's display time as it starts revealing. This is the
		// single chokepoint every typed reply (immediate, queued, and bg-resolution)
		// passes through, so it is where a live reply gets its "when it arrived"
		// timestamp; a history reload later replaces it with the server's own.
		// _replyStampFor prefers the time skapi received the response when the settle
		// reported one (a streamed turn), over this browser's clock.
		var target = this.state.messages[idx];
		if (target && target._ts === undefined) target._ts = this._replyStampFor(target);
		// SELF-HEALING, because this is now reached from the live paint path too. The
		// queue is a class field, so it is only initialised by the constructor; any
		// caller holding a ChatSession built another way (the engine tests drive
		// Object.create(ChatSession.prototype) deliberately, to exercise one method
		// without a host) previously never touched it, and now does. An uninitialised
		// queue would throw here and take the whole answer down over bookkeeping.
		if (!this.typewriterQueue) this.typewriterQueue = Promise.resolve();
		this.typewriterQueue = this.typewriterQueue.then(function () { return self.typewriteIntoIndex(idx, fullText, localId, paintedText); });
		return this.typewriterQueue;
	}

	// (_removeStrayPendingAssistants, the "Thinking..." sweep that guessed which
	// pending bubble was a stray from the user bubble above it, is gone with the
	// positional writers it cleaned up after. A settle now removes every other waiting
	// copy of ITS OWN request, by id: see _settleInList.)

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

	// An immediate send for the chat on screen whose POST has not been acked yet (the
	// view unmounted and remounted mid-request): show the sending state until the ack.
	// Nothing is rendered from here any more. Once acked, the turn is an ordinary open
	// item, and applyTerminal settles it by its id wherever its bubble lives (on screen
	// or in its chat's cache), so a remount needs no replay of the reply.
	resumePendingRequest(_token: number): Promise<void> {
		var self = this;
		var key = this.getHistoryCacheKey();
		var pending = key ? this.pendingAgentRequests[key] : undefined;
		if (!pending) return Promise.resolve();
		this.state.sending = true;
		this.host.notify();
		return Promise.resolve(pending).catch(function () { }).then(function () {
			if (key && self.pendingAgentRequests[key]) return; // a newer send is still out
			self.state.sending = false;
			self.host.notify();
		});
	}

	// ─── THE RECONCILER (reconciler plan, section 3 items 1 to 4 and 7 to 9; 4b) ──────
	//
	// The screen is a copy of the SERVER, not of the polls. Everything the chat shows as
	// unfinished is in the open set (trackOpenItem: chat turns, indexing passes, by server
	// id, identity pinned), and one timer chain per page (LookScheduler, reconciler.ts)
	// keeps reading the server about that set until each item is finished. Polls, status
	// frames and timers only make it read sooner; if all of them die, the next look still
	// finds the truth, every return forces a look, and a failed look changes nothing.
	//
	// ONE LOOK (new skapi-js, reconcilerReadsEnabled):
	//   1. on a return (tab shown, wake, online, socket back, bfcache, chat reopened, a
	//      frame naming an unknown chat turn): the live stream readers are stopped first
	//      (rule 3: at most one reader per request, a fresh one after the look), then the
	//      discovery listing (ids only, after a watermark, exact queue) matches sends whose
	//      ack was lost by their cref, then the first history page is merged;
	//   2. the queue counters of every queue with open items (a few bytes);
	//   3. only when a counter moved, on a trigger, or once a minute: one batch status read
	//      per project (100 ids a call); running items are shown running BY ID (queued turns
	//      and indexing passes alike), terminal ones are read once each (the envelope read)
	//      and applied through applyTerminal / the background settle;
	//   4. a reader is (re)started for a running streamed turn on screen.
	// With an older skapi-js the look keeps today's polls and only re-attaches what a
	// failed poll let go of, through the old by-id read (_reconcileLookLegacy).

	private _sched?: LookScheduler;
	/** The last counters seen, per "<projectId>|<queue>". */
	private _recCounters?: { [k: string]: { rct: number; seq: number } };
	/** performance.now() of the last look that read every open item's status. */
	private _recFullReadAt = 0;
	/** performance.now() of the last return look's start (see resumePolling). */
	private _recReturnAt = 0;
	/** Open items a status frame named since the last look: read by the next one. */
	private _recFrameIds?: { [id: string]: true };
	/** Looks that still read statuses after a counter moved: a queued turn starts a moment
	 *  after the one ahead of it finishes, and starting moves no counter. */
	private _recFollowUps = 0;
	/** The backend refused the counters read (too old): statuses are read every look. */
	private _recCountersOff = false;
	/** The backend refused the batch status read (too old): today's polls instead. */
	private _recReadsOff = false;
	/** Chunks of a terminal streamed turn read so far, by id (a long answer can take more
	 *  than one read, and more than one look). */
	private _recChunks?: { [id: string]: { parser: SseParser; cursor: number; stalls: number } };
	/** Sends whose POST got no answer, by cref. */
	private _recPending?: { [cref: string]: PendingSend };
	/** "Not sent. Retry?" replies, by their local id. */
	private _notSent?: { [lid: string]: PendingSend };
	/** Chat turns shown as "could not be loaded", tried again later (_recRetryUnloadable). */
	private _recUnloadable?: { [id: string]: { item: OpenItem; tries: number; at: number } };
	/** A first-page read a look could not run yet (a load in flight, polling paused). */
	private _recFirstPageOwed = false;
	/** performance.now() of the last first-page read a look started. */
	private _recFirstPageAt = 0;
	/** gateRefreshToken of the last first-page load started (see loadHistory). */
	private _recFirstPageToken: number | undefined = undefined;
	/** performance.now() when the last first-page load landed (see loadHistory). */
	private _recFirstPageDoneAt = 0;
	/** performance.now() of the last indexing queue check a look ran. */
	private _recAdoptAt = 0;
	/** Indexing runs whose run:: record says 'working', by "<projectId>|<path>". */
	private _fileRuns?: { [k: string]: FileRun };
	/** Runs a complete queue look found no pass for: not re-opened by the same records. */
	private _fileRunsIdle?: { [k: string]: true };
	private _fileRunCheckAt = 0;
	private _recSyncing = false;
	/** Pages watching a project's background indexing queue (watchIndexQueue). */
	private _iqWatches: IndexQueueWatch[] = [];

	private _recNewMode(): boolean {
		return !this._recReadsOff && reconcilerReadsEnabled();
	}

	private _recSched(): LookScheduler {
		if (!this._sched) {
			var self = this;
			this._sched = new LookScheduler({
				runLook: function (req: LookRequest) { return self._reconcileLook(req); },
				work: function () { return self._recWork(); },
				pushLive: function () { return statusPushLive(); },
				onFlags: function (f) {
					if (!!self.state.reconnecting === f.reconnecting && !!self.state.signInNeeded === f.signInNeeded) return;
					self.state.reconnecting = f.reconnecting;
					self.state.signInNeeded = f.signInNeeded;
					self._viewNotify();
				},
			});
		}
		return this._sched;
	}

	/** Keep the chain running at its cadence while there is anything to follow. */
	private _recEnsure(): void {
		if (this._recSyncing) return;
		try { this._recSched().ensure(); } catch (e) { /* never in the way of a caller */ }
	}

	/** A view host may be absent (the dashboard's files page): nothing here may throw then. */
	private _viewMounted(): boolean {
		try { return !!(this.host && this.host.isViewMounted && this.host.isViewMounted()); } catch (e) { return false; }
	}

	private _viewNotify(): void {
		if (!this._viewMounted()) return;
		try { this.host.notify(); } catch (e) { /* view hook */ }
	}

	/**
	 * Look at the server now. `trigger` says why (default 'return': the user is back, so
	 * readers restart and the first page is read). Resolves when that look ends. Any
	 * number of calls at once run one look, plus exactly one more for calls that arrive
	 * while it runs.
	 */
	reconcileNow(trigger?: string): Promise<void> {
		return this._recSched().trigger((trigger || 'return') as LookTrigger);
	}

	/** The sign-in is back: looks resume at once (state.signInNeeded clears on success). */
	noteSignedIn(): void {
		this._recSched().signedIn();
	}

	/** A chat view was (re)opened: a return look (readers, discovery, first page). */
	noteViewOpened(): void {
		void this._recSched().trigger('view');
	}

	/** The host changed bgTaskQueue (the files page pushes passes with no chat view):
	 *  the new entries join the open set and the chain runs. */
	noteBgQueueChanged(): void {
		this._syncOpenFromBgQueue();
		this._recEnsure();
	}

	/**
	 * True when this page's reconciler follows every bgTaskQueue entry itself, with or
	 * without a chat view (the host's skapi-js has the batch reads). A host's own poller of
	 * that queue (web-bunnyquery main.vue's fallback poller) then stands down: two
	 * followers of one pass race to settle it, and the poller's settle skips the next pass
	 * of a file this client drives and its run:: record.
	 */
	followsBackgroundQueue(): boolean {
		return this._recNewMode();
	}

	/** Stop the reconciler's timer (tests, teardown). Any trigger starts it again. */
	stopReconciler(): void {
		if (this._sched) this._sched.stop();
	}

	/** Diagnostics: the open set's size, looks run, timers armed, pending sends. */
	reconcilerStats(): { open: number; looks: number; timers: number; generation: number; pendingSends: number; fileRuns: number; reconnecting: boolean; signInNeeded: boolean; running: boolean } {
		var sc = this._sched;
		return {
			open: Object.keys(this._openMap()).length,
			looks: sc ? sc.looks : 0,
			timers: sc ? sc.timersArmed : 0,
			generation: sc ? sc.gen : 0,
			pendingSends: Object.keys(this._recPending || {}).length,
			fileRuns: Object.keys(this._fileRuns || {}).length,
			reconnecting: !!this.state.reconnecting,
			signInNeeded: !!this.state.signInNeeded,
			running: !!sc && sc.isRunning(),
		};
	}

	/** The bg entry of a pass, by id. */
	private _bgEntry(itemId: string): BgTaskEntry | null {
		var q = this.bgTaskQueue || [];
		for (var i = 0; i < q.length; i++) if (q[i] && q[i].id === itemId) return q[i];
		return null;
	}

	/** The queue an indexing pass runs on. */
	private _bgQueueOf(entry: BgTaskEntry): string {
		var uid = entry.identity ? entry.identity.userId : '';
		return bgIndexingQueueName(uid, entry.projectId);
	}

	/**
	 * Every bgTaskQueue entry is an open item, whoever pushed it (the engine, the files
	 * page with no chat view, a host's own code). Its identity is pinned here when the
	 * host pushed it without one, from the identity live now when that is the entry's
	 * project.
	 */
	private _syncOpenFromBgQueue(): void {
		var q = this.bgTaskQueue;
		if (!q || !q.length) return;
		var map = this._openMap(), tomb = this._tomb();
		var live: ChatIdentity | null = null;
		this._recSyncing = true;
		try {
			for (var i = 0; i < q.length; i++) {
				var e = q[i];
				if (!e || !e.id || !e.projectId || map[e.id] || tomb[e.id]) continue;
				if (!e.identity) {
					if (!live) { try { live = this.host.getIdentity(); } catch (err) { live = null; } }
					if (live && live.projectId === e.projectId) e.identity = Object.assign({}, live, { platform: e.platform });
				}
				if (e.owner === undefined && e.identity) e.owner = e.identity.owner;
				var uid = e.identity ? e.identity.userId : '';
				if (e.ownerKey === undefined && e.identity) e.ownerKey = chatCacheKey(e.projectId, e.platform, uid);
				this.trackOpenItem(e.id, {
					ownerKey: e.ownerKey || chatCacheKey(e.projectId, e.platform, uid),
					projectId: e.projectId, owner: e.owner || '', platform: e.platform,
					queue: bgIndexingQueueName(uid, e.projectId), kind: 'indexing',
					state: e.status === 'running' ? 'running' : 'queued',
					anonymous: !!(e.identity && e.identity.anonymous),
					uid: e.identity ? e.identity.userId : undefined,
				});
			}
		} finally {
			this._recSyncing = false;
		}
		this._persistChains();
	}

	// --- client-driven chains across reloads (FL-12b) ---------------------------------
	// A client-driven file (the browser sends each next pass, see maybeResumeIndexing) used
	// to live in bgTaskQueue only: a reload or a discarded tab lost its chain, the next pass
	// was never sent and run:: stayed 'working'. Each chain is kept in localStorage under
	// "bq-chain:<project>|<storage path>" (its current pass and what sending the next one
	// needs), from the moment its pass is in bgTaskQueue until the chain ends (any run::
	// flip, a stop). A new page puts the kept pass back into bgTaskQueue at its first look;
	// the look reads it by id and, if it is over, its settle sends the next pass under the
	// usual 'next:' claim and settle lock, so two tabs never both send it.

	private _chains?: { [k: string]: KeptChain };
	/** Passes whose chain ended (see _forgetChain): never kept again. */
	private _chainEnded?: { [id: string]: true };
	private _chainsRestored = false;

	private _chainStorage(): any {
		try {
			var ls = _g.localStorage;
			return ls && typeof ls.getItem === 'function' ? ls : null;
		} catch (e) {
			return null;
		}
	}

	private _chainKey(projectId: string, storagePath: string): string {
		return projectId + '|' + storagePath;
	}

	/** Keep every client-driven pass in bgTaskQueue (the newest pass per file wins). */
	private _persistChains(): void {
		var q = this.bgTaskQueue;
		if (!q || !q.length) return;
		if (!this._chains) this._chains = {};
		var ls = this._chainStorage();
		for (var i = 0; i < q.length; i++) {
			var e = q[i];
			if (!e || !e.id || !e.storagePath || !e.projectId || !e.identity) continue;
			if (e.platform !== 'claude' && e.platform !== 'openai') continue;
			// Its chain ended already (the entry leaves bgTaskQueue a moment later).
			if (this._chainEnded && this._chainEnded[e.id]) continue;
			if (this._isWorkerDrivenIndexing(e.filename, e.mime)) continue;
			var k = this._chainKey(e.projectId, e.storagePath);
			var cur = this._chains[k];
			if (cur && cur.id >= e.id) continue;
			var rec: KeptChain = {
				projectId: e.projectId, platform: e.platform, owner: e.owner !== undefined ? e.owner : e.identity.owner,
				ownerKey: e.ownerKey, identity: Object.assign({}, e.identity), storagePath: e.storagePath,
				filename: e.filename, mime: e.mime, size: e.size, isReindex: e.isReindex,
				resumePass: e.resumePass || 0, id: e.id, at: Date.now(),
			};
			this._chains[k] = rec;
			if (!ls) continue;
			try {
				// Another tab may have kept a newer pass of the same file.
				var had = ls.getItem(CHAIN_STORE_PREFIX + k);
				var prev = had ? JSON.parse(had) : null;
				if (prev && typeof prev.id === 'string' && prev.id > e.id) continue;
				ls.setItem(CHAIN_STORE_PREFIX + k, JSON.stringify(rec));
			} catch (err) { /* quota, privacy mode: memory still covers this page */ }
		}
	}

	/** The chain of this file ended: forget it (only when the kept pass is not newer than
	 *  `upToId`, a later run of the same file being newer; without it, whatever is kept). */
	private _forgetChain(projectId: string, storagePath: string, upToId?: string): void {
		if (!projectId || !storagePath) return;
		if (upToId) {
			if (!this._chainEnded) this._chainEnded = {};
			this._chainEnded[upToId] = true;
		}
		var k = this._chainKey(projectId, storagePath);
		if (this._chains && this._chains[k] && (!upToId || this._chains[k].id <= upToId)) delete this._chains[k];
		var ls = this._chainStorage();
		if (!ls) return;
		try {
			var had = ls.getItem(CHAIN_STORE_PREFIX + k);
			if (!had) return;
			var prev = JSON.parse(had);
			if (upToId && prev && typeof prev.id === 'string' && prev.id > upToId) return;
			ls.removeItem(CHAIN_STORE_PREFIX + k);
		} catch (err) { /* expires on its own (CHAIN_STORE_TTL_MS) */ }
	}

	/** Is a chain of this file kept (this page or another tab of this browser)? */
	private _chainKept(projectId: string, storagePath: string): boolean {
		var k = this._chainKey(projectId, storagePath);
		if (this._chains && this._chains[k]) return true;
		var ls = this._chainStorage();
		if (!ls) return false;
		try { return !!ls.getItem(CHAIN_STORE_PREFIX + k); } catch (e) { return false; }
	}

	/** Once per page, at its first look: the kept chains go back into bgTaskQueue. */
	private _restoreChains(): void {
		if (this._chainsRestored) return;
		this._chainsRestored = true;
		var ls = this._chainStorage();
		if (!ls) return;
		// A kept pass is followed by id: the batch reads, or an older skapi-js's by-id read.
		if (!this._recNewMode() && typeof chatEngineConfig().csrHistoryItemLookup !== 'function') return;
		var keys: string[] = [];
		try {
			for (var i = 0; i < ls.length; i++) {
				var lk = ls.key(i);
				if (lk && lk.indexOf(CHAIN_STORE_PREFIX) === 0) keys.push(lk);
			}
		} catch (e) { return; }
		if (!this._chains) this._chains = {};
		var tomb = this._tomb();
		var added = false;
		for (var j = 0; j < keys.length; j++) {
			var rec: KeptChain | null = null;
			try { rec = JSON.parse(ls.getItem(keys[j]) || 'null'); } catch (e) { rec = null; }
			var ok = !!rec && typeof rec.id === 'string' && !!rec.projectId && !!rec.storagePath && !!rec.identity
				&& (rec.platform === 'claude' || rec.platform === 'openai') && typeof rec.at === 'number';
			if (!ok || Date.now() - rec!.at > CHAIN_STORE_TTL_MS) {
				try { ls.removeItem(keys[j]); } catch (e) { /* ignore */ }
				continue;
			}
			var r = rec as KeptChain;
			this._chains[this._chainKey(r.projectId, r.storagePath)] = r;
			if (tomb[r.id] || this.bgTaskQueue.some(function (e) { return !!e && e.id === r.id; })) continue;
			this.bgTaskQueue.push({
				projectId: r.projectId, platform: r.platform, id: r.id,
				identity: Object.assign({}, r.identity), owner: r.owner, ownerKey: r.ownerKey,
				filename: r.filename, storagePath: r.storagePath, isReindex: r.isReindex,
				mime: r.mime, size: r.size, status: 'pending', poll: undefined, resumePass: r.resumePass,
			});
			added = true;
		}
		// The sync that follows (this look) opens them; the drain draws them when their chat
		// is on screen.
		if (added && this._viewMounted()) {
			try { this.drainBgTaskQueue(); } catch (e) { /* drawn at the next drain */ }
		}
	}

	/** An open indexing pass whose file this client drives (it sends the next pass). */
	private _isClientDrivenOpen(itemId: string): boolean {
		var e = this._bgEntry(itemId);
		return !!e && !!e.storagePath && !this._isWorkerDrivenIndexing(e.filename, e.mime);
	}

	/** What the chain has to follow: anything at all (visible cadence), and what is worth
	 *  a look once a minute while the tab is hidden (a client-driven chain: without the
	 *  browser its next pass is never sent). Never reads the network. */
	private _recWork(): { visible: boolean; hidden: boolean } {
		var open = this._openMap();
		var any = false, hidden = false;
		var live = this._recLiveUid();
		for (var id in open) {
			// Another identity's item (signed out, another account) is not work: nothing can
			// read it until its user signs in again, which triggers a look (noteSignedIn).
			if (!this._recReadable(open[id].uid, open[id].projectId, live)) continue;
			any = true;
			if (open[id].kind === 'indexing' && this._isClientDrivenOpen(id)) { hidden = true; break; }
		}
		if (this._recPending) {
			for (var c in this._recPending) {
				if (!this._recReadable(this._recPending[c].uid, this._recPending[c].projectId, live)) continue;
				any = true;
				// A client-driven file's next pass that is being looked for: the chain needs
				// the browser, hidden or not.
				if (this._recPending[c].kind === 'indexing') hidden = true;
			}
		}
		if (!any && this._recFirstPageOwed && this._viewMounted()) any = true;
		if (!any && this._fileRuns && Object.keys(this._fileRuns).length && this._viewMounted()) any = true;
		if (!any && this._viewMounted()) {
			try {
				var ident = this.host.getIdentity();
				if (ident && ident.projectId && this._hasLocalLiveIndexWork(ident.projectId)) any = true;
			} catch (e) { /* no identity, nothing to follow */ }
		}
		var iq = this._iqWork();
		return { visible: any || iq.visible, hidden: hidden || iq.hidden };
	}

	/** How a failed read is taken: 'auth' (the sign-in is gone), 'transient' (on the way),
	 *  'refused' (the server's own no). */
	private _recErrKind(err: any): 'auth' | 'transient' | 'refused' {
		var msg = err && typeof err === 'object' && typeof err.message === 'string' ? err.message.toLowerCase() : (typeof err === 'string' ? err.toLowerCase() : '');
		if (isAuthExpiredError(err) || msg.indexOf('login is required') !== -1 || msg.indexOf('user login') !== -1) return 'auth';
		if (isTransportFailure(err)) return 'transient';
		return 'refused';
	}

	/** The user id signed in now (ChatIdentity.userId), or null when the host cannot say. */
	private _recLiveUid(): { uid: string; projectId: string } | null {
		try {
			var id = this.host.getIdentity();
			return id ? { uid: id.userId || '', projectId: id.projectId || '' } : null;
		} catch (e) {
			return null;
		}
	}

	/**
	 * Can the caller signed in now read an item sent under `uid`? A row answers only the
	 * identity that made it: after a sign-out (or with another account) every read of it
	 * would come back "missing" and settle a turn that is fine as "no longer available".
	 * Such an item is left exactly as it is (not read, not counted as work) until its user
	 * is back. An item pinned before the user was known (uid = the project id, the hosts'
	 * fallback) is always read.
	 */
	private _recReadable(uid: string | undefined, projectId: string, live: { uid: string; projectId: string } | null): boolean {
		if (!uid || uid === projectId) return true;
		// No live identity at all (a full sign-out): nothing can read this item now. An
		// empty live uid stands for the hosts' fallback, the project id.
		if (!live) return false;
		var now = live.uid || live.projectId;
		return !!now && uid === now;
	}

	/** The newest server id of a chat known here (on screen, in its cache, or open). */
	private _recNewestKnownId(key: string): string {
		var best = '';
		var scan = function (list: ChatMessage[] | undefined) {
			if (!list) return;
			for (var i = 0; i < list.length; i++) {
				var sid = list[i] && list[i]._serverItemId;
				if (typeof sid === 'string' && sid > best && (!list[i].isBackgroundTask)) best = sid;
			}
		};
		if (!key || key === this.getHistoryCacheKey()) scan(this.state.messages);
		var cached = key ? this.aiChatHistoryCache[key] : undefined;
		if (cached) scan(cached.messages);
		var open = this._openMap();
		for (var id in open) if (open[id].ownerKey === key && open[id].kind === 'chat' && id > best) best = id;
		return best;
	}

	/** Put a send's cref on its bubbles (on screen and in the chat's cache). */
	private _stampCref(key: string, userLid: string | undefined, placeholderLid: string | undefined, cref: string): void {
		if ((!userLid && !placeholderLid) || !cref) return;
		var stamp = function (list: ChatMessage[] | undefined) {
			if (!list) return;
			for (var i = 0; i < list.length; i++) {
				var m = list[i];
				if (!m || !m._localId) continue;
				if ((m.role === 'user' && m._localId === userLid) || (m.role === 'assistant' && m._localId === placeholderLid)) m._cref = cref;
			}
		};
		stamp(this.state.messages);
		var cached = key ? this.aiChatHistoryCache[key] : undefined;
		if (cached) stamp(cached.messages);
	}

	/** A send whose POST got no answer: its row is looked for by cref (see dispatchAgentRequest). */
	private _recAddPendingSend(p: PendingSend): void {
		if (!this._recPending) this._recPending = {};
		p.sentAt = Date.now();
		p.looks = 0;
		if (p.uid === undefined) {
			var live = this._recLiveUid();
			p.uid = live ? live.uid : '';
		}
		this._recPending[p.cref] = p;
		// Its bubbles have no server id, and a history merge drops an id-less bubble when
		// the page shows another turn waiting: marked, they are kept (shouldRescueInFlightMessage).
		// An indexing pass has none of its own.
		if (p.kind !== 'indexing') this._markLocalTurn(p.key, p.userLid, p.placeholderLid, { _unconfirmed: true });
		void this._recSched().trigger('send');
	}

	/** Patch the bubbles of a local turn (by local id), on screen and in its chat's cache. */
	private _markLocalTurn(key: string, userLid: string | undefined, placeholderLid: string | undefined, patch: any): void {
		var hit = function (m: ChatMessage) {
			return !!m && !!m._localId && ((m.role === 'user' && m._localId === userLid) || (m.role === 'assistant' && m._localId === placeholderLid));
		};
		var apply = function (list: ChatMessage[]): boolean {
			var any = false;
			for (var i = 0; i < list.length; i++) {
				if (!hit(list[i])) continue;
				var next: any = Object.assign({}, list[i], patch);
				for (var k in patch) if (patch[k] === undefined) delete next[k];
				list[i] = next;
				any = true;
			}
			return any;
		};
		if (!key || key === this.getHistoryCacheKey()) { if (apply(this.state.messages)) this._viewNotify(); }
		var cached = key ? this.aiChatHistoryCache[key] : undefined;
		if (cached) {
			var msgs = cached.messages.slice();
			if (apply(msgs)) this.aiChatHistoryCache[key] = { messages: msgs, endOfList: cached.endOfList, startKeyHistory: cached.startKeyHistory };
		}
	}

	/**
	 * Send again a turn that said "Not sent. Retry?". Only ever on the user's click: the
	 * reply bubble goes back to waiting and the same send goes out with a new cref. False
	 * when `msg` is not such a reply (or was retried already).
	 */
	retryNotSent(msg: ChatMessage): boolean {
		if (!msg || !msg._notSent || !msg._localId) return false;
		var map = this._notSent || {};
		var rec = map[msg._localId];
		if (!rec) return false;
		delete map[msg._localId];
		var lid = msg._localId;
		var onScreen = !rec.key || rec.key === this.getHistoryCacheKey();
		// An immediate send goes out as one again only when nothing else of this chat is
		// in flight: another dispatch waiting for its ack (pendingAgentRequests), the
		// composer's sending state, or a turn running on screen. Otherwise it is resent as
		// a queued turn (the server runs it after the one in flight), so it does not take
		// over the running dispatch's ack promise or its sending state.
		var params = rec.params;
		if (params.immediate && this._chatBusy(rec.key, onScreen)) {
			params = Object.assign({}, params, { immediate: false, placeholderLid: undefined });
			rec.params = params;
		}
		var asQueued = !params.immediate;
		var restore = function (list: ChatMessage[]): boolean {
			var hit = false;
			for (var i = list.length - 1; i >= 0; i--) {
				var m = list[i];
				if (!m) continue;
				if (m.role === 'assistant' && m._localId === lid && m._notSent) {
					if (rec.placeholderLid && !asQueued) {
						var ph: ChatMessage = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _localId: rec.placeholderLid };
						if (m._ownerKey !== undefined) ph._ownerKey = m._ownerKey;
						list[i] = ph;
					} else {
						list.splice(i, 1);
					}
					hit = true;
				} else if (m.role === 'user' && rec.userLid && m._localId === rec.userLid) {
					var back: any = Object.assign({}, m, asQueued ? { isPendingQueued: true, isSendingToServer: true, _dimSending: true } : {});
					delete back._notSent;
					list[i] = back;
					hit = true;
				}
			}
			return hit;
		};
		if (onScreen && restore(this.state.messages)) {
			this._viewNotify();
			this.updateHistoryCache();
		} else {
			var cached = rec.key ? this.aiChatHistoryCache[rec.key] : undefined;
			if (cached) {
				var msgs = cached.messages.slice();
				if (restore(msgs)) this.aiChatHistoryCache[rec.key] = { messages: msgs, endOfList: cached.endOfList, startKeyHistory: cached.startKeyHistory };
			}
		}
		if (params.immediate && onScreen) { this.state.sending = true; this._viewNotify(); }
		this.dispatchAgentRequest(params);
		return true;
	}

	/** Is a send of this chat in flight right now (see retryNotSent)? */
	private _chatBusy(key: string, onScreen: boolean): boolean {
		if (key && this.pendingAgentRequests[key]) return true;
		if (!onScreen) return false;
		return !!this.state.sending || !this._noRunningChatTurnOnScreen(this.getHistoryCacheKey());
	}

	/** True for a "Not sent. Retry?" reply that retryNotSent can still send. */
	canRetryNotSent(msg: ChatMessage): boolean {
		return !!msg && !!msg._notSent && !!msg._localId && !!(this._notSent && this._notSent[msg._localId]);
	}

	/**
	 * Follow an indexing run from its run:: 'working' record (reconciler plan, section 3
	 * item 1): the host passes the project's paths whose record says working, after every
	 * read of those records. A run stays open until its record says done/error/cancelled
	 * (it leaves the list), or a complete look at the queue finds no pass of it. While one
	 * is open and not seen live, a look asks the host to read the records again
	 * (host.recheckFileRuns) every FILE_RUN_RECHECK_MS: no fixed number of rounds.
	 */
	syncFileRuns(projectId: string, workingPaths: string[], info?: { [path: string]: { owner?: string; filename?: string } }): void {
		if (!projectId) return;
		if (!this._fileRuns) this._fileRuns = {};
		if (!this._fileRunsIdle) this._fileRunsIdle = {};
		var want: { [k: string]: true } = {};
		for (var i = 0; i < (workingPaths || []).length; i++) {
			var p = workingPaths[i];
			if (typeof p === 'string' && p) want[projectId + '|' + p] = true;
		}
		for (var k in this._fileRuns) {
			if (this._fileRuns[k].projectId === projectId && !want[k]) delete this._fileRuns[k];
		}
		for (var k2 in this._fileRunsIdle) {
			if (k2.indexOf(projectId + '|') === 0 && !want[k2]) delete this._fileRunsIdle[k2];
		}
		var added = false;
		for (var w in want) {
			var path = w.slice(projectId.length + 1);
			var hint = info && info[path];
			if (this._fileRuns[w]) {
				if (hint) { this._fileRuns[w].owner = hint.owner; this._fileRuns[w].filename = hint.filename; }
				continue;
			}
			if (this._fileRunsIdle[w]) continue;
			this._fileRuns[w] = { projectId: projectId, storagePath: path, since: Date.now() };
			if (hint) { this._fileRuns[w].owner = hint.owner; this._fileRuns[w].filename = hint.filename; }
			added = true;
		}
		if (added) this._recEnsure();
	}

	/** The runs of a project this page follows, by storage path. */
	openFileRuns(projectId: string): string[] {
		var out: string[] = [];
		var runs = this._fileRuns || {};
		for (var k in runs) if (runs[k].projectId === projectId) out.push(runs[k].storagePath);
		return out;
	}

	/**
	 * Watch a project's background indexing queue, with or without a chat view (the
	 * dashboard's files page draws its "Indexing" and "Indexed" badges from it). The
	 * reconciler's one timer chain reads it (no timer or poll of the page's own):
	 *  - at once when the watch starts, on every return (tab shown, wake, online,
	 *    reconnect) and when a status frame names the indexing queue;
	 *  - every 8 s while the queue holds work or the last read came back cut off (once a
	 *    minute while status frames arrive);
	 *  - every 2.5 s while the page waits for a second, independent look (wantsConfirm);
	 *  - never while the tab is hidden (a refresh() still reads).
	 * The answer lands in state.indexQueues[projectId] (IndexQueueSnapshot). Runs the page
	 * follows itself (runsOpen) get recheckRuns every FILE_RUN_RECHECK_MS from the same
	 * chain. A failed read keeps the last snapshot.
	 */
	watchIndexQueue(opts: IndexQueueWatchOptions): IndexQueueWatchHandle {
		var self = this;
		var w: IndexQueueWatch = { opts: opts, force: true, frame: false, runsCheckAt: 0, lastTryAt: 0 };
		this._iqWatches.push(w);
		this._startStatusPush();
		void this._recSched().trigger('add');
		return {
			stop: function () {
				var i = self._iqWatches.indexOf(w);
				if (i !== -1) self._iqWatches.splice(i, 1);
				if (!self._iqWatches.length && !Object.keys(self._openMap()).length && !self._viewMounted()) self._stopStatusPush();
			},
			refresh: function (maxAgeMs?: number) {
				if (self._iqWatches.indexOf(w) === -1) return Promise.resolve();
				var ident = self._iqIdentity(w);
				if (!ident) return Promise.resolve();
				var snap = self.indexQueueSnapshot(ident.projectId);
				if (snap && maxAgeMs && Date.now() - snap.at < maxAgeMs) return Promise.resolve();
				w.force = true;
				return self._recSched().trigger('add');
			},
			ensure: function () { self._recEnsure(); },
		};
	}

	/** The last read of a project's indexing queue (see watchIndexQueue), or null. */
	indexQueueSnapshot(projectId: string): IndexQueueSnapshot | null {
		var all = this.state.indexQueues;
		return (projectId && all && all[projectId]) || null;
	}

	private _iqIdentity(w: IndexQueueWatch): IndexQueueIdentity | null {
		var ident: IndexQueueIdentity | null = null;
		try { ident = w.opts.identity(); } catch (e) { ident = null; }
		if (!ident || !ident.projectId || (ident.platform !== 'claude' && ident.platform !== 'openai')) return null;
		return ident;
	}

	/** What the watches give the chain to do (see _recWork). */
	private _iqWork(): { visible: boolean; hidden: boolean } {
		var visible = false, hidden = false;
		for (var i = 0; i < this._iqWatches.length; i++) {
			var w = this._iqWatches[i];
			// A turn waiting for indexing to end waits whether or not anyone looks.
			if (w.drain) { visible = true; hidden = true; continue; }
			var ident = this._iqIdentity(w);
			if (!ident) continue;
			var snap = this.indexQueueSnapshot(ident.projectId);
			if (w.force || w.frame || !snap || !snap.checked || Object.keys(snap.keys).length) { visible = true; continue; }
			try {
				if (w.opts.wantsConfirm && w.opts.wantsConfirm()) { visible = true; continue; }
				if (w.opts.runsOpen && w.opts.runsOpen()) visible = true;
			} catch (e) { /* page hook */ }
		}
		return { visible: visible, hidden: hidden };
	}

	/** The watched queues' part of a look: read the ones that are due (see watchIndexQueue). */
	private _iqLook(req: LookRequest): Promise<void> {
		var self = this;
		if (!this._iqWatches.length) return Promise.resolve();
		var doc: any = _g.document;
		var hidden = !!doc && doc.visibilityState === 'hidden';
		var push = statusPushLive();
		type Group = { ident: IndexQueueIdentity; fresh: boolean; watches: IndexQueueWatch[]; tokens: number[] };
		var groups: { [k: string]: Group } = {};
		var list = this._iqWatches.slice();
		for (var i = 0; i < list.length; i++) {
			var w = list[i];
			var ident = this._iqIdentity(w);
			if (!ident) continue;
			var now = Date.now();
			if (!w.drain) {
				// Runs the page follows itself: their records are read again on this chain.
				var runs = false;
				try { runs = !!(w.opts.runsOpen && w.opts.recheckRuns && w.opts.runsOpen()); } catch (e) { runs = false; }
				if (!runs) w.runsCheckAt = 0;
				else if (!w.runsCheckAt) w.runsCheckAt = now;
				else if (!hidden && now - w.runsCheckAt >= FILE_RUN_RECHECK_MS) {
					w.runsCheckAt = now;
					try { w.opts.recheckRuns!(); } catch (e) { /* page hook */ }
				}
			}
			var due = false;
			var token = 0;
			// The page waits for a second, independent look (its green confirmation): that
			// one is read fresh, or the shared answer (up to BG_PROBE_TTL_MS old, same `at`)
			// counts as the first look again and the confirmation waits a tick longer.
			var confirm = false;
			if (w.drain) {
				due = w.drain.due();
				if (due) token = w.drain.onAsk();
			} else if (w.force) {
				due = true;
			} else if (!hidden) {
				var snap = this.indexQueueSnapshot(ident.projectId);
				var age = now - Math.max(snap ? snap.at : 0, w.lastTryAt);
				var busy = !snap || !snap.checked || Object.keys(snap.keys).length > 0;
				try { confirm = !!(w.opts.wantsConfirm && w.opts.wantsConfirm()); } catch (e) { confirm = false; }
				due = req.isReturn
					|| (!snap && age >= IQ_LIVE_MS)
					|| (w.frame && age >= IQ_FRAME_GAP_MS)
					|| (busy && age >= (push ? IQ_PUSH_LIVE_MS : IQ_LIVE_MS))
					|| (confirm && age >= IQ_CONFIRM_MS);
			}
			if (!due) continue;
			w.force = false;
			w.frame = false;
			w.lastTryAt = now;
			// A drain waiter reads fresh (it waits for the queue to CHANGE), and so does a
			// page waiting to confirm; otherwise a page takes a read up to BG_PROBE_TTL_MS
			// old, which the chat's own looks keep warm.
			var fresh = !!w.drain || confirm;
			var key = [ident.projectId, ident.owner, ident.platform, ident.userId || '', fresh ? 'f' : ''].join('|');
			if (!groups[key]) groups[key] = { ident: ident, fresh: fresh, watches: [], tokens: [] };
			groups[key].watches.push(w);
			groups[key].tokens.push(token);
		}
		return Promise.all(Object.keys(groups).map(function (k) {
			var g = groups[k];
			var tell = function (snap: IndexQueueSnapshot | null, failed: boolean) {
				for (var j = 0; j < g.watches.length; j++) {
					var d = g.watches[j].drain;
					if (d) { try { d.onSnapshot(snap, failed, g.tokens[j]); } catch (e) { /* waiter */ } }
				}
			};
			return fetchLiveIndexingKeys({
				service: g.ident.projectId, owner: g.ident.owner, platform: g.ident.platform, userId: g.ident.userId,
			}, g.fresh ? { maxAgeMs: 0 } : undefined).then(function (res) {
				// A look past its deadline (or a newer one) applies nothing it read.
				if (!req.alive()) { tell(null, true); return; }
				var snap: IndexQueueSnapshot = { keys: {}, checked: !!res.checked, at: res.at };
				res.keys.forEach(function (fk: string) { snap.keys[fk] = true; });
				var cur = self.indexQueueSnapshot(g.ident.projectId);
				if (!cur || cur.at <= snap.at) {
					var next: { [pid: string]: IndexQueueSnapshot } = Object.assign({}, self.state.indexQueues || {});
					next[g.ident.projectId] = snap;
					self.state.indexQueues = next;
				}
				tell(snap, false);
			}, function () {
				// Unreachable: the page keeps its last snapshot (a stale "indexing" is safe,
				// and "checked" only ever comes from an answer); a waiter counts it as busy.
				tell(null, true);
			});
		})).then(function () {
			// Status frames only while a watched queue has work (they are what pulls its
			// next read forward); an idle one is read again on a return. The chat's own
			// use of the frames (an open item, a chat view) keeps them on regardless.
			if (self._iqWork().visible) self._startStatusPush();
			else if (!Object.keys(self._openMap()).length && !self._viewMounted()) self._stopStatusPush();
		});
	}

	/**
	 * A run closed idle (a complete queue look found no pass of it) whose record still says
	 * 'working': when it is THIS user's run of a client-driven file and no browser tab here
	 * keeps its chain (a reload, a discarded tab, or a browser without localStorage lost
	 * it), nothing will ever send its next pass, so run:: says CHAIN_LOST_TEXT. Never for a
	 * worker-driven file (the worker writes its endings), another user's run (their chain is
	 * in their browser), or a run whose next pass is being looked for.
	 */
	/** Files the last queue look listed pending or running, settled bubbles included. */
	private _rawListedIndexKeys: { [k: string]: boolean } = {};
	/** Runs found idle on one complete look, waiting for a second before "lost" (see below). */
	private _lostLooks: { [k: string]: number } = {};
	private _lostKey(run: FileRun): string { return run.projectId + '\u0000' + run.storagePath + '\u0000' + run.since; }

	private _flipIfChainLost(run: FileRun): boolean {
		var self = this;
		if (!run.owner) return false;
		// The server still lists a pass of it (pending or running), under its path or its file
		// name: not lost, whatever this page's bubbles say (2026-11-25: a TIF whose pass the
		// worker was running was flipped by a chat page that had just opened).
		var raw = this._rawListedIndexKeys || {};
		if (raw[run.storagePath] || (run.filename && raw[run.filename])) {
			delete this._lostLooks[this._lostKey(run)];
			return true;
		}
		// Idle on TWO complete looks in a row, not one: the status index is eventually
		// consistent, and one look can miss a row that was just written.
		var lk = this._lostKey(run);
		if (!this._lostLooks[lk]) { this._lostLooks[lk] = 1; return true; }
		delete this._lostLooks[lk];
		var live: ChatIdentity | null = null;
		try { live = this.host.getIdentity(); } catch (e) { live = null; }
		if (!live || !live.userId || live.userId !== run.owner || live.projectId !== run.projectId) return false;
		var name = run.filename || run.storagePath.split('/').pop() || run.storagePath;
		if (this._isWorkerDrivenIndexing(name, undefined)) return false;
		// A single-pass file's ending is the worker's to write (index_end) once the host says
		// every region's worker does so: nothing here may call it lost.
		if (workerIndexEndingsEnabled() && !isPagedReadFile(name, undefined)) return false;
		if (this._chainKept(run.projectId, run.storagePath)) return false;
		for (var q = 0; q < this.bgTaskQueue.length; q++) {
			var e = this.bgTaskQueue[q];
			if (e && e.projectId === run.projectId && e.storagePath === run.storagePath) return false;
		}
		if (this._recPending) for (var c in this._recPending) {
			if (this._recPending[c].kind === 'indexing' && this._recPending[c].projectId === run.projectId) return false;
		}
		var projectId = run.projectId, path = run.storagePath;
		runSettleSideEffect(projectId, bgIndexingQueueName(live.userId, projectId), 'lost:' + projectId + ':' + path + ':' + run.since, function () {
			return upsertIndexRunRecordSafe(projectId, path, { status: 'error', finished: Date.now(), error: CHAIN_LOST_TEXT }, { report: true })
				.then(function () {
					if (typeof self.host.recheckFileRuns === 'function') {
						try { self.host.recheckFileRuns(projectId, [path]); } catch (e) { /* host hook */ }
					}
				});
		});
		return false;
	}

	/** A file run the queue says is live, or that this page has a pass queued for. */
	private _fileRunLive(run: FileRun): boolean {
		var keys = this.state.liveIndexKeys || {};
		if (keys[run.storagePath]) return true;
		var q = this.bgTaskQueue || [];
		for (var i = 0; i < q.length; i++) {
			if (q[i] && q[i].projectId === run.projectId && q[i].storagePath === run.storagePath) return true;
		}
		return false;
	}

	/** Ask the host to read the records of open runs that are not seen live. */
	private _recCheckFileRuns(projectId: string): void {
		var runs = this._fileRuns || {};
		var paths: string[] = [];
		for (var k in runs) if (runs[k].projectId === projectId && !this._fileRunLive(runs[k])) paths.push(runs[k].storagePath);
		if (!paths.length || typeof this.host.recheckFileRuns !== 'function') return;
		if (nowMs() - this._fileRunCheckAt < FILE_RUN_RECHECK_MS) return;
		this._fileRunCheckAt = nowMs();
		try { this.host.recheckFileRuns(projectId, paths); } catch (e) { /* host hook */ }
	}

	/** A COMPLETE look at the queue (both listings shorter than their limit) found no pass
	 *  for these runs: they are over. The host reads their records one last time. */
	private _closeIdleFileRuns(projectId: string): void {
		var runs = this._fileRuns || {};
		var closed: string[] = [];
		for (var k in runs) {
			if (runs[k].projectId !== projectId || this._fileRunLive(runs[k])) continue;
			// still listed by the server, or idle on only one look so far: kept open
			if (this._flipIfChainLost(runs[k])) continue;
			closed.push(runs[k].storagePath);
			delete runs[k];
			if (!this._fileRunsIdle) this._fileRunsIdle = {};
			this._fileRunsIdle[k] = true;
		}
		if (closed.length && typeof this.host.recheckFileRuns === 'function') {
			try { this.host.recheckFileRuns(projectId, closed); } catch (e) { /* host hook */ }
		}
	}

	/**
	 * Rule 3 of 4b: on every return each live stream reader is stopped (and its in-flight
	 * read aborted) before the look decides anything; a fresh one starts after the look if
	 * the turn still streams. A reader whose poll cannot be stopped (an older skapi-js) is
	 * left alone, and none is added beside it.
	 */
	private _recStopLiveReaders(): void {
		var ids = Object.keys(this.liveStreams || {});
		for (var i = 0; i < ids.length; i++) {
			var id = ids[i];
			var h = this.historyItemPolls.get(id);
			if (!h || typeof h.stop !== 'function') continue;
			this._stopPoll(id);
			var st = this.liveStreams[id];
			if (st) this._closeLiveStream(st, false);
		}
	}

	/** Start the one reader of a running streamed turn on screen that has none. */
	private _recStartReaders(): void {
		if (!liveStreamingEnabled() || !this._viewMounted()) return;
		var doc: any = _g.document;
		if (doc && doc.visibilityState === 'hidden') return;
		var key = this.getHistoryCacheKey();
		var open = this._openMap();
		for (var id in open) {
			var it = open[id];
			if (it.kind !== 'chat' || it.lastStatus !== 'running' || !it.stream || it.ownerKey !== key) continue;
			if (this.historyItemPolls.has(id) || this.liveStreams[id]) continue;
			this._recAttachReader(id, it);
		}
	}

	private _recAttachReader(itemId: string, item: OpenItem): void {
		var read = resolveForwardRequestStream();
		if (!read) return;
		var self = this;
		var url = item.platform === 'openai' ? OPENAI_RESPONSES_API_URL : ANTHROPIC_MESSAGES_API_URL;
		var source = {
			poll: function (o: any) {
				return read!(itemId, {
					url: url, method: 'POST', service: item.projectId, owner: item.owner, since: 0,
					poll: Math.max(1000, (o && o.latency) || 1000),
					onStream: o && o.onStream, onResponse: o && o.onResponse, onError: o && o.onError,
				} as any);
			},
		};
		var ctx: TerminalContext = { ownerKey: item.ownerKey, projectId: item.projectId, owner: item.owner, platform: item.platform };
		var dp: any;
		try {
			dp = this._fgPollWithEarlyProbe(source, itemId, undefined, { platform: item.platform, projectId: item.projectId, owner: item.owner, ownerKey: item.ownerKey });
		} catch (e) {
			return;
		}
		if (!dp) return;
		this._trackPoll(itemId, 'fg', dp);
		var handle = this.historyItemPolls.get(itemId);
		Promise.resolve(dp).then(function (res: any) {
			if (self.historyItemPolls.get(itemId) === handle) self.historyItemPolls.delete(itemId);
			if (isPollStopped(res)) return;
			self.applyTerminal(itemId, res, ctx);
		}, function (err: any) {
			if (self.historyItemPolls.get(itemId) === handle) self.historyItemPolls.delete(itemId);
			self.onPollFailure(itemId, err, ctx);
		});
	}

	/** One look. See the section note. Never throws; never changes the screen on a failure. */
	private _reconcileLook(req: LookRequest): Promise<LookOutcome> {
		var self = this;
		// The watched indexing queues (files page, a turn waiting for indexing) are read
		// beside the chat's own reads, in either mode. Their failures change nothing and
		// do not count against the look (the page keeps its last snapshot).
		var iq = this._iqLook(req).catch(function (e: any) { console.warn('[chat-engine] index queue read failed', e); });
		return Promise.all([this._reconcileChatLook(req), iq]).then(function (r) { return r[0]; });
	}

	private _reconcileChatLook(req: LookRequest): Promise<LookOutcome> {
		var self = this;
		this._restoreChains();
		this._syncOpenFromBgQueue();
		if (req.isReturn) this._recReturnAt = nowMs();
		if (!this._recNewMode()) return this._reconcileLookLegacy(req);
		var outcome: LookOutcome = 'ok';
		var fail = function (err: any): 'auth' | 'transient' | 'refused' {
			var k = self._recErrKind(err);
			if (k === 'auth') outcome = 'auth';
			else if (k === 'transient' && outcome !== 'auth') outcome = 'transient';
			return k;
		};
		if (req.isReturn) this._recStopLiveReaders();
		return Promise.resolve()
			.then(function () { return self._recDiscover(req, fail); })
			.then(function () { if (req.alive()) self._recFirstPage(req); })
			.then(function () { return req.alive() ? self._recReadStatuses(req, fail) : undefined; })
			.then(function () { return req.alive() ? self._recRetryUnloadable(req) : undefined; })
			.then(function () {
				if (!req.alive()) return outcome;
				if (self._recFollowUps > 0) self._recFollowUps--;
				self._recStartReaders();
				self._recIndexingCheck(req);
				if (!Object.keys(self._openMap()).length && !self._viewMounted() && !self._iqWatches.length) self._stopStatusPush();
				return outcome;
			});
	}

	/**
	 * The look of a host whose skapi-js has no batch reads: today's polls stay, and the
	 * look re-attaches what a failed poll let go of (onPollFailure 'kept', a bg entry whose
	 * read failed): one by-id read each through csrHistoryItemLookup, a few per look.
	 */
	private _reconcileLookLegacy(req: LookRequest): Promise<LookOutcome> {
		var self = this;
		var outcome: LookOutcome = 'ok';
		var open = this._openMap();
		var live = this._recLiveUid();
		// A background pass with no poll is the drain's to re-attach (a read of it failed on
		// the way, or it waits for a poll slot): the drain rations polls, and re-attaching
		// through it is what keeps a failed read from leaving the pass unfollowed. On a
		// return the drain runs anyway.
		var unpolledBg = false;
		if (this._countBgPolls() < MAX_CONCURRENT_BG_POLLS) for (var oid in open) {
			if (open[oid].kind !== 'indexing' || this.historyItemPolls.has(oid)) continue;
			var oe = this._bgEntry(oid);
			if (oe && !oe.byListing) { unpolledBg = true; break; }
		}
		if ((req.isReturn || unpolledBg) && this._viewMounted() && !this.isPollingPaused()) this.drainBgTaskQueue();
		this._recFirstPage(req);
		this._recIndexingCheck(req);
		var lookup = chatEngineConfig().csrHistoryItemLookup;
		if (typeof lookup !== 'function') return Promise.resolve(outcome);
		// With no chat view nothing drains (the drain draws rows into the chat): the passes
		// a page pushed with no view (the dashboard's files page) are followed here instead,
		// the oldest waiting ones first, as many per look as the drain would poll at once.
		var headless = !this._viewMounted();
		var rank = function (id: string): number {
			var e = self._bgEntry(id);
			return e && e.status !== 'running' ? 1 : 0;
		};
		var ids = Object.keys(open).filter(function (id) {
			if (self.historyItemPolls.has(id) || self.liveStreams[id]) return false;
			if (!self._recReadable(open[id].uid, open[id].projectId, live)) return false;
			var e = self._bgEntry(id);
			// A by-listing pass is the queue check's (_settleByListing) in this mode, while a
			// view runs that check.
			if (e && e.byListing && !headless) return false;
			// A pass waiting in line for a poll slot is the drain's (above), not read here
			// by id on every look: with a bulk upload that would be every waiting pass, a
			// whole row each. Only one the server already runs, whose poll was let go.
			if (e && e.status !== 'running' && !headless) return false;
			return true;
		}).sort(function (a, b) { return (rank(a) - rank(b)) || (a < b ? -1 : a > b ? 1 : 0); }).slice(0, MAX_CONCURRENT_BG_POLLS);
		return Promise.all(ids.map(function (id) {
			var item = open[id];
			if (!item || !item.projectId) return Promise.resolve();
			var who: TerminalContext = { ownerKey: item.ownerKey, projectId: item.projectId, owner: item.owner, platform: item.platform };
			return Promise.resolve(lookup!(buildHistoryItemFullId(item.platform, item.projectId, id), item.projectId, item.owner)).then(function (body: any) {
				if (!req.alive() || !self._openMap()[id]) return;
				item.lastConfirmed = nowMs();
				if (isCsrStatusEnvelope(body) && (body.status === 'running' || body.status === 'pending')) {
					item.lastStatus = body.status;
					if (typeof (body as any).executed === 'number' && (body as any).executed > 0) item.executedAt = (body as any).executed;
					if (body.status === 'running') {
						if (item.kind === 'chat') self._noteServerState(id, 'running', item.ownerKey);
						else self._recPromoteBg(id);
					}
					return;
				}
				var entry = item.kind === 'indexing' ? self._bgEntry(id) : null;
				// The pass's start, from a running read of it (main.vue's poller used to carry
				// it from the poll's running ticks): the indexing row's duration.
				// The pass's start, from a running read of it, or from this terminal read when
				// it is an envelope (a streamed or cancelled row carries `executed`): a pass
				// that went from waiting to done between two looks has no running read.
				var started = item.executedAt;
				if (started === undefined && isCsrStatusEnvelope(body) && typeof (body as any).executed === 'number' && (body as any).executed > 0) started = (body as any).executed;
				if (entry) return self._settleBgOutcome(entry, entry.platform, Promise.resolve(body), function () { return started; }).then(function () { self._recAfterApply(id, item); });
				if (item.kind === 'indexing') self.handleHistoryItemResolution(id, body, item.platform, started, who);
				else self.applyTerminal(id, body, who);
				self._recAfterApply(id, item);
			}, function (err: any) {
				if (!req.alive()) return;
				if (isNotExistsError(err)) {
					var entry2 = item.kind === 'indexing' ? self._bgEntry(id) : null;
					if (entry2) return self._settleBgOutcome(entry2, entry2.platform, Promise.reject(err), function () { return undefined; });
					self.onPollFailure(id, err, who);
					return;
				}
				var k = self._recErrKind(err);
				if (k === 'auth') outcome = 'auth';
				else if (k === 'transient' && outcome !== 'auth') outcome = 'transient';
			});
		})).then(function () { return outcome; });
	}

	/**
	 * The discovery listing: rows of a chat's queue newer than what the page knows, ids and
	 * status only. On a return (the chat on screen), and while a send waits for its row
	 * (its chat). A row carrying a waiting send's cref IS that send: its bubbles get the id
	 * and it is followed like any acked turn. A waiting send no complete listing has shown
	 * twice says "Not sent. Retry?". A live row nothing here knows makes the look read the
	 * first page.
	 */
	private _recDiscover(req: LookRequest, fail: (err: any) => string): Promise<void> {
		var self = this;
		var pend = this._recPending || {};
		var live = this._recLiveUid();
		// A send made under another identity (signed out since, another account) cannot be
		// listed by this one: it waits, untouched, for its user (see _recReadable).
		var pendList: PendingSend[] = Object.keys(pend).map(function (k) { return pend[k]; })
			.filter(function (p) { return self._recReadable(p.uid, p.projectId, live); });
		if (!req.isReturn && !pendList.length) return Promise.resolve();
		// One listing per chat AND queue: a send with attachments goes to the chat's
		// background queue, and listing only the main queue for it would never show its
		// row, so it would say "Not sent. Retry?" while it was queued all along (and a
		// Retry would send it twice).
		type Chat = { key: string; projectId: string; owner: string; platform: 'claude' | 'openai'; queue: string };
		var chats: { [k: string]: Chat } = {};
		var chatId = function (key: string, queue: string) { return key + '\u0000' + queue; };
		if (req.isReturn && this._viewMounted()) {
			var id: ChatIdentity | null = null;
			try { id = this.host.getIdentity(); } catch (e) { id = null; }
			if (id && id.projectId && (id.platform === 'claude' || id.platform === 'openai')) {
				var key = this.getHistoryCacheKey();
				var q0 = id.userId || id.projectId;
				chats[chatId(key, q0)] = { key: key, projectId: id.projectId, owner: id.owner, platform: id.platform, queue: q0 };
			}
		}
		pendList.forEach(function (p) {
			var ck = chatId(p.key, p.queue);
			if (!chats[ck]) chats[ck] = { key: p.key, projectId: p.projectId, owner: p.owner, platform: p.platform, queue: p.queue };
		});
		return Promise.all(Object.keys(chats).map(function (k) {
			var c = chats[k];
			var known = self._recNewestKnownId(c.key);
			var after = known;
			var mine = pendList.filter(function (p) { return p.key === c.key && p.queue === c.queue; });
			for (var i = 0; i < mine.length; i++) {
				if (!mine[i].watermark) after = '';
				else if (after && mine[i].watermark < after) after = mine[i].watermark;
			}
			return Promise.resolve(getChatHistory({
				service: c.projectId, owner: c.owner, platform: c.platform, queue: c.queue, queue_exact: true,
				fields: 'ids', after: after || undefined, deadline: req.remaining(), signal: req.signal, fresh: true,
			}, { limit: 100, fetchMore: false })).then(function (res: any) {
				if (!req.alive()) return;
				self._recApplyDiscovery(c, res, mine, known);
			}, function (err: any) {
				// A backend that refuses the light listing can never show the row: its
				// waiting sends count the look as complete, so they end as "Not sent.
				// Retry?" (the user decides) instead of waiting for good.
				if (fail(err) === 'refused' && req.alive()) self._recApplyDiscovery(c, { list: [], endOfList: true }, mine, known);
			});
		})).then(function () { });
	}

	private _recApplyDiscovery(c: { key: string; projectId: string; owner: string; platform: 'claude' | 'openai'; queue: string }, res: any, mine: PendingSend[], known?: string): void {
		var list: any[] = res && Array.isArray(res.list) ? res.list : [];
		var complete = !res || res.endOfList !== false;
		var pend = this._recPending || {};
		var open = this._openMap(), tomb = this._tomb();
		var unknown = false;
		var oldest = '';
		var onScreen = c.key === this.getHistoryCacheKey();
		var msgs = this.state.messages;
		var shown = function (rid: string) { return msgs.some(function (m) { return !!m && m._serverItemId === rid; }); };
		for (var i = 0; i < list.length; i++) {
			var row = list[i];
			if (!row || typeof row.id !== 'string') continue;
			if (!oldest || row.id < oldest) oldest = row.id;
			var p = typeof row.cref === 'string' ? pend[row.cref] : undefined;
			if (p && p.key === c.key && p.queue === c.queue) {
				if (p.kind === 'indexing') {
					delete pend[p.cref];
					if (p.onFound) { try { p.onFound(row); } catch (e) { console.warn('[chat-engine] a found pass threw', e); } }
				} else {
					this._recMatchPending(p, row);
				}
				continue;
			}
			if (open[row.id] || tomb[row.id] || !onScreen) continue;
			// A live row nothing here shows, or a finished one newer than everything this chat
			// knows (answered from another tab or device while this view was away): the
			// first page is read. Only past a known row: with nothing known (a new or
			// cleared chat) every row would count, on every return.
			// (The background queue also carries indexing passes the page folds away.)
			if (row.status === 'pending' || row.status === 'running' || (!!known && row.id > known && !isBgIndexingQueue(c.queue))) {
				if (!shown(row.id)) unknown = true;
			}
		}
		for (var j = 0; j < mine.length; j++) {
			var ps = mine[j];
			if (!pend[ps.cref]) continue; // matched above
			// A page that reaches back past the send's own time covers it as well as an
			// exhausted listing does.
			var covers = complete || (!!oldest && requestIdTimeMs(oldest) > 0 && requestIdTimeMs(oldest) < (ps.sentAt || 0) - 2 * 60 * 1000);
			if (!covers) continue;
			ps.looks = (ps.looks || 0) + 1;
			// Two complete looks, and long enough after the POST for a slow server to have
			// written the row the POST was still creating when its answer was lost.
			if (ps.looks >= 2 && Date.now() - (ps.sentAt || 0) >= NOT_SENT_MIN_AGE_MS) {
				if (ps.kind === 'indexing') {
					delete pend[ps.cref];
					if (ps.onMissing) { try { ps.onMissing(); } catch (e) { console.warn('[chat-engine] a missing pass threw', e); } }
				} else {
					this._recNotSent(ps);
				}
			}
		}
		if (unknown) this._recFirstPageOwed = true;
	}

	/** A waiting send's row was found by its cref: the send was received after all. */
	private _recMatchPending(p: PendingSend, row: any): void {
		if (this._recPending) delete this._recPending[p.cref];
		var id = row.id as string;
		// Found: the bubbles are an ordinary acked turn from here (merged by their id).
		this._markLocalTurn(p.key, p.userLid, p.placeholderLid, { _unconfirmed: undefined });
		if (p.params && typeof p.params.onItemId === 'function') {
			try { p.params.onItemId(id); } catch (e) { console.warn('[chat-engine] onItemId threw', e); }
		} else {
			this._stampTurnWithItemId(p.key, p.userLid, p.placeholderLid, id);
		}
		this.trackOpenItem(id, {
			ownerKey: p.key, projectId: p.projectId, owner: p.owner, platform: p.platform, queue: p.queue,
			kind: 'chat', state: row.status === 'running' ? 'running' : 'queued', cref: p.cref, uid: p.uid,
		});
		if (row.status === 'running') this._noteServerState(id, 'running', p.key);
	}

	/** Two complete listings never showed the send: it did not reach the server. Shown as
	 *  "Not sent. Retry?" and never sent again unless the user asks (retryNotSent). */
	private _recNotSent(p: PendingSend): void {
		if (this._recPending) delete this._recPending[p.cref];
		var lid = p.placeholderLid || this._newLocalId();
		if (!this._notSent) this._notSent = {};
		this._notSent[lid] = p;
		this._settleLocalTurn(p.key, p.userLid, p.placeholderLid, { role: 'assistant', content: NOT_SENT_TEXT, isError: true, _notSent: true, _localId: lid });
		// The request bubble is marked too, so a history merge keeps the pair together.
		this._markLocalTurn(p.key, p.userLid, undefined, { _notSent: true, _unconfirmed: undefined });
	}

	/** The first history page, merged (loadHistory's own merge), on a return or when a live
	 *  row nothing here knows was seen. Not awaited: the look's own reads decide its outcome,
	 *  and the merge applies itself. Owed (run by a later look) while a load is in flight or
	 *  polling is paused. */
	private _recFirstPage(req: LookRequest): void {
		// Opening the chat view is a return (owner, 2026-11-24): the first page is read
		// and merged by id. Both hosts start that read themselves when the view opens;
		// the gap check below sees it (loadHistory stamps _recFirstPageAt), so a 'view'
		// look reads it only when the host did not.
		var wants = false;
		for (var t in req.triggers) if (t !== 'tick' && t !== 'add' && t !== 'promote' && t !== 'send' && t !== 'frame') wants = true;
		if (!wants && !this._recFirstPageOwed) return;
		if (!this._viewMounted()) { this._recFirstPageOwed = false; return; }
		var id: ChatIdentity | null = null;
		try { id = this.host.getIdentity(); } catch (e) { id = null; }
		if (!id || !id.projectId || id.platform === 'none') { this._recFirstPageOwed = false; return; }
		// Read a moment ago (two triggers of one return): that read covers this one. A
		// read owed for a reason found since (an unknown live row) waits out the gap.
		if (nowMs() - this._recFirstPageAt < CATCH_UP_MIN_GAP_MS) return;
		if (this.isPollingPaused() || this.state.loadingHistory) {
			this._recFirstPageOwed = true;
			return;
		}
		this._recFirstPageOwed = false;
		this._recFirstPageAt = nowMs();
		void this.loadHistory(false, this.state.gateRefreshToken).catch(function (e: any) {
			console.warn('[chat-engine] first-page read failed', e);
		});
	}

	/** The indexing queue check (adoption, page progress, file runs), at its own cadence
	 *  inside the one chain. Needs the chat view: what it adopts are rows of that chat. */
	private _recIndexingCheck(req: LookRequest): void {
		if (!this._viewMounted() || this.isPollingPaused()) return;
		var id: ChatIdentity | null = null;
		try { id = this.host.getIdentity(); } catch (e) { id = null; }
		if (!id || !id.projectId || (id.platform !== 'claude' && id.platform !== 'openai')) return;
		var gap = statusPushLive() ? STATUS_PUSH_ADOPT_TICK_MS : ADOPT_TICK_MS;
		var due = req.isReturn || !!req.triggers.frame || nowMs() - this._recAdoptAt >= gap;
		var runs = this.openFileRuns(id.projectId).length > 0;
		if (due && (this._hasLocalLiveIndexWork(id.projectId) || runs)) {
			this._recAdoptAt = nowMs();
			this._adoptWorkerIndexingPasses(0, false, true);
			// Without the batch reads, by-listing passes still settle off the listing.
			if (!this._recNewMode()) this._settleByListing();
			this._refreshPageProgress();
		}
		if (runs) this._recCheckFileRuns(id.projectId);
	}

	/**
	 * Read the queue counters and, when needed, the status of the open items.
	 *
	 * WHICH ITEMS. A row read costs as much as the conversation it carries, so a look reads
	 * every open item only on a return and at the stale watch (once a minute). Otherwise it
	 * reads only the items whose status can have changed: the ones never confirmed or seen
	 * terminal, the ones a status frame named, and, when a counter moved or something
	 * nudged the look (a settle asking for the next turn, a send), the running items plus
	 * the head of each queue's line (a queue runs its requests in order, so only the first
	 * few waiting ones can have started). A bulk upload's hundreds of waiting passes are
	 * then read once a minute, not on every finish.
	 */
	private _recReadStatuses(req: LookRequest, fail: (err: any) => string): Promise<void> {
		var self = this;
		var open = this._openMap();
		var live = this._recLiveUid();
		var groups: { [g: string]: { projectId: string; owner: string; ids: string[]; queues: { [q: string]: true } } } = {};
		for (var id in open) {
			var it = open[id];
			if (!it.projectId) continue;
			// Another identity's item is left alone (see _recReadable).
			if (!this._recReadable(it.uid, it.projectId, live)) continue;
			var g = it.projectId + '\u0000' + (it.owner || '');
			if (!groups[g]) groups[g] = { projectId: it.projectId, owner: it.owner || '', ids: [], queues: {} };
			groups[g].ids.push(id);
			var qn = queueNameOf(it.queue);
			if (qn) groups[g].queues[qn] = true;
		}
		var frames = this._recFrameIds || {};
		this._recFrameIds = {};
		var keys = Object.keys(groups);
		if (!keys.length) return Promise.resolve();
		var full = req.isReturn || nowMs() - this._recFullReadAt >= LOOK_STALE_MS;
		var nudged = this._recFollowUps > 0;
		for (var t in req.triggers) if (t !== 'tick' && t !== 'add' && t !== 'frame') nudged = true;
		if (full) this._recFullReadAt = nowMs();
		return Promise.all(keys.map(function (k) { return self._recReadGroup(req, groups[k], full, nudged, frames, fail); })).then(function () { });
	}

	private _recReadGroup(req: LookRequest, g: { projectId: string; owner: string; ids: string[]; queues: { [q: string]: true } }, full: boolean, nudged: boolean, frames: { [id: string]: true }, fail: (err: any) => string): Promise<void> {
		var self = this;
		var open = this._openMap();
		// What can have changed (see _recReadStatuses): `must` is read whenever this look
		// reads at all, `moving` (running items, the head of each line) when a counter moved
		// or the look was nudged.
		var must: { [id: string]: true } = {}, moving: { [id: string]: true } = {};
		var mustRead = full;
		// A queue holding waiting items and none running: the next one starts without
		// moving a counter (only a finish moves one), so the head of its line is read every
		// look until it runs, and the bubble turns "Thinking..." within a look of the server.
		var waitingQ: { [q: string]: string[] } = {}, runningQ: { [q: string]: true } = {};
		for (var i = 0; i < g.ids.length; i++) {
			var iid = g.ids[i];
			var it = open[iid];
			if (!it) continue;
			// A failed worker pass waiting for its second read (plan 3.8) that no complete
			// queue look came for in time (no chat view runs one): read now.
			if (it.failedPending && !it.failedRecheck && nowMs() - it.failedPending >= FAILED_PASS_RECHECK_MAX_MS) {
				it.failedRecheck = true;
				it.terminalSeen = true;
			}
			if (it.lastConfirmed === 0 || it.terminalSeen || frames[iid]) { must[iid] = true; mustRead = true; }
			var iq = queueNameOf(it.queue);
			if (it.state === 'running' || it.lastStatus === 'running') { runningQ[iq] = true; moving[iid] = true; }
			else (waitingQ[iq] = waitingQ[iq] || []).push(iid);
		}
		for (var wq in waitingQ) {
			var line = waitingQ[wq].sort().slice(0, LOOK_HEAD_OF_LINE);
			for (var h = 0; h < line.length; h++) moving[line[h]] = true;
			if (!runningQ[wq]) {
				for (var h2 = 0; h2 < line.length; h2++) must[line[h2]] = true;
				mustRead = true;
			}
		}
		var counters = resolveForwardRequestQueueCounters();
		var queues = Object.keys(g.queues).slice(0, 20);
		var step: Promise<boolean>;
		if (counters && !this._recCountersOff && queues.length) {
			step = Promise.resolve(counters(queues, { service: g.projectId, owner: g.owner, deadline: req.remaining(), signal: req.signal, fresh: true })).then(function (res: any) {
				var moved = false;
				var got = res && res.queues && typeof res.queues === 'object' ? res.queues : {};
				if (!self._recCounters) self._recCounters = {};
				for (var q = 0; q < queues.length; q++) {
					var c = got[queues[q]];
					if (!c) continue;
					var key = g.projectId + '|' + queues[q];
					var prev = self._recCounters[key];
					var rct = Number(c.rct) || 0, seq = Number(c.seq) || 0;
					// The first sighting is a baseline, not a move: the look that takes it
					// reads every item it has never confirmed anyway.
					if (prev && (prev.rct !== rct || prev.seq !== seq)) moved = true;
					self._recCounters[key] = { rct: rct, seq: seq };
				}
				if (moved) self._recFollowUps = 2;
				return mustRead || moved || nudged;
			}, function (err: any) {
				var k = fail(err);
				if (k === 'refused') { self._recCountersOff = true; return true; }
				return false; // on the way: the statuses would fail the same way
			});
		} else {
			// No counters: every look reads, but only what can have changed.
			step = Promise.resolve(true);
			nudged = true;
		}
		return step.then(function (read: boolean) {
			if (!read || !req.alive()) {
				if (full) self._recFullReadAt = 0; // nothing was read: the next look reads it all
				return;
			}
			var status = resolveForwardRequestStatus();
			if (!status) return;
			var wide = full || nudged || self._recFollowUps > 0;
			// Bounded per look: a bulk upload can hold thousands of waiting passes, and the
			// queue runs them in order, so the ones that can have changed are the running
			// ones and the head of the line. Running (and seen-terminal) first, then chat
			// turns, then the oldest waiting passes; the rest move up as these settle.
			var rank = function (id: string): number {
				var it = self._openMap()[id];
				if (!it) return 9;
				if (it.state === 'running' || it.terminalSeen) return 0;
				return it.kind === 'chat' ? 1 : 2;
			};
			var ids = g.ids.filter(function (id) {
				if (!self._openMap()[id]) return false;
				return full || must[id] || (wide && moving[id]);
			})
				.sort(function (a, b) { return (rank(a) - rank(b)) || (a < b ? -1 : a > b ? 1 : 0); })
				.slice(0, LOOK_READ_CAP);
			if (!ids.length) return;
			var reqs = ids.map(function (id) { var it = open[id]; return buildHistoryItemFullId(it.platform, it.projectId, id); });
			return Promise.resolve(status(reqs, { service: g.projectId, owner: g.owner, deadline: req.remaining(), signal: req.signal, fresh: true })).then(function (res: any) {
				if (!req.alive()) return;
				var rows: any[] = res && Array.isArray(res.list) ? res.list : [];
				return self._recApplyStatuses(req, rows, fail);
			}, function (err: any) {
				var k = fail(err);
				if (k === 'refused') {
					// A backend without the batch read: today's polls carry on.
					self._recReadsOff = true;
					console.warn('[chat-engine] the batch status read is not available; following requests with polls', err);
				}
				// Not read after all: the next look reads everything again.
				if (full) self._recFullReadAt = 0;
			});
		});
	}

	private _recApplyStatuses(req: LookRequest, rows: any[], fail: (err: any) => string): Promise<void> {
		var self = this;
		var open = this._openMap();
		var terminal: Array<{ id: string; item: OpenItem; row: any }> = [];
		var changedBg = false;
		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			if (!row || typeof row.id !== 'string') continue;
			var item = open[row.id];
			if (!item) continue;
			item.lastConfirmed = nowMs();
			item.lastStatus = row.status;
			if (row.stream !== undefined) item.stream = !!row.stream;
			if (!item.cref && typeof row.cref === 'string') item.cref = row.cref;
			if (row.status === 'pending' || row.status === 'running') {
				item.terminalSeen = false;
				if (row.status === 'running') {
					if (OPEN_STATE_RANK[item.state] < OPEN_STATE_RANK.running) item.state = 'running';
					if (item.kind === 'chat') self._noteServerState(row.id, 'running', item.ownerKey);
					else if (self._recPromoteBg(row.id, true)) changedBg = true;
				}
				continue;
			}
			if (row.status === 'missing') { self._recApplyMissing(row.id, item); continue; }
			terminal.push({ id: row.id, item: item, row: row });
		}
		if (changedBg) { this._viewNotify(); this.updateHistoryCache(); }
		// The envelope reads, a few at a time, oldest first.
		terminal.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
		var next = 0;
		var worker = function (): Promise<void> {
			if (next >= terminal.length || !req.alive()) return Promise.resolve();
			var t = terminal[next++];
			return Promise.resolve(self._recSettleTerminal(req, t.id, t.item, t.row, fail)).catch(function (e: any) {
				console.warn('[chat-engine] settling ' + t.id + ' threw', e);
			}).then(worker);
		};
		var lanes: Promise<void>[] = [];
		for (var l = 0; l < LOOK_READ_CONCURRENCY && l < terminal.length; l++) lanes.push(worker());
		return Promise.all(lanes).then(function () { });
	}

	/** A pass the server says runs now: its waiting bubble becomes the running one, by id
	 *  (replaces promoteNextBgQueuedToRunning's guess). True when a bubble changed. */
	private _recPromoteBg(itemId: string, quiet?: boolean): boolean {
		var e = this._bgEntry(itemId);
		if (e && e.status === 'pending') e.status = 'running';
		var changed = this._promoteBgItemToRunning(itemId);
		if (changed && !quiet) { this._viewNotify(); this.updateHistoryCache(); }
		return changed;
	}

	/** One item the batch read says is over: let a live reader settle it if it is still
	 *  being fed (one look's grace), else read it once and apply it. */
	private _recSettleTerminal(req: LookRequest, id: string, item: OpenItem, row: any, fail: (err: any) => string): Promise<void> | void {
		var hasPoll = this.historyItemPolls.has(id);
		var st = this.liveStreams[id];
		var fed = !!st && st.fed && !st.ended;
		if ((hasPoll || fed) && !req.isReturn && !item.terminalSeen) {
			item.terminalSeen = true;
			return;
		}
		// Its stored answer could not be loaded 3 times: read again only at the stale watch
		// (or a return), not on every look (see _recBodyUnavailable).
		if ((item.unavail || 0) >= BODY_UNAVAILABLE_BACKOFF_AFTER && !req.isReturn && nowMs() - (item.unavailAt || 0) < LOOK_STALE_MS) return;
		// A worker-driven pass read as failed, not yet marked retried: its second read waits
		// for a complete queue look (or the wait to run out), see _recApplyValue.
		if (item.failedPending && !item.failedRecheck) {
			if (nowMs() - item.failedPending < FAILED_PASS_RECHECK_MAX_MS) return;
			item.failedRecheck = true;
		}
		// From here this look settles it, and it is the only reader: the poll or stream that
		// held it lets go first (a poll that cannot be stopped settles into the tombstone).
		if (hasPoll) this._stopPoll(id);
		st = this.liveStreams[id];
		if (st) this._closeLiveStream(st, false);
		if (row.status === 'cancelled') {
			this._recApplyValue(id, item, cancelledEnvelope(id), row);
			return;
		}
		var needChunks = row.status === 'resolved' && !!row.stream && !row.has_body;
		return this._recReadEnvelope(req, id, item, needChunks, row, fail);
	}

	private _recChunkState(id: string): { parser: SseParser; cursor: number; stalls: number } {
		if (!this._recChunks) this._recChunks = {};
		if (!this._recChunks[id]) this._recChunks[id] = { parser: createSseParser(), cursor: 0, stalls: 0 };
		return this._recChunks[id];
	}

	/**
	 * The envelope read of one terminal item. A streamed turn with no stored answer is read
	 * from its cursor (`since`), as many reads as it takes within the look, and is final
	 * only when the cursor reaches `final_seq` (without one, when `more` is false); what is
	 * read so far is kept for the next look when the deadline comes first.
	 */
	private _recReadEnvelope(req: LookRequest, id: string, item: OpenItem, needChunks: boolean, row: any, fail: (err: any) => string): Promise<void> {
		var self = this;
		var read = resolveForwardRequestRead();
		if (!read) return Promise.resolve();
		var fullId = buildHistoryItemFullId(item.platform, item.projectId, id);
		var ch = needChunks ? this._recChunkState(id) : null;
		var finalSeq: number | undefined = typeof row.final_seq === 'number' ? row.final_seq : undefined;
		var loop = function (): Promise<void> {
			var params: any = { id: fullId, service: item.projectId, owner: item.owner, deadline: req.remaining(), signal: req.signal, fresh: true };
			if (ch) params.since = ch.cursor;
			return Promise.resolve(read!(params)).then(function (env: any) {
				if (!req.alive() || !self._openMap()[id]) return;
				if (!env || typeof env !== 'object') { item.terminalSeen = true; return; }
				if (env.status === 'missing') { self._recApplyMissing(id, item); return; }
				if (env.status === 'pending' || env.status === 'running') { item.terminalSeen = false; return; }
				if (env.body_unavailable) { self._recBodyUnavailable(id, item); return; } // stored, not loadable now
				if (env.status === 'cancelled') { self._recApplyValue(id, item, cancelledEnvelope(id), env); return; }
				if (env.body !== undefined && env.body !== null) { self._recApplyValue(id, item, env.body, env); return; }
				if (env.status === 'failed') {
					self._recApplyValue(id, item, { id: id, status: 'failed', in_queue: false, error: env.error != null ? env.error : { message: 'The request failed.' } }, env);
					return;
				}
				// Resolved with nothing stored.
				if (!ch) {
					if (env.stream) { ch = self._recChunkState(id); return loop(); }
					self._recApplyValue(id, item, EMPTY_PROVIDER_BODY, env);
					return;
				}
				if (typeof env.final_seq === 'number') finalSeq = env.final_seq;
				var before = ch.cursor;
				var chunks: any[] = Array.isArray(env.chunks) ? env.chunks.slice() : [];
				chunks.sort(function (a, b) { return (a && b) ? a.seq - b.seq : 0; });
				for (var i = 0; i < chunks.length; i++) {
					var c = chunks[i];
					if (!c || typeof c.seq !== 'number' || c.seq <= ch.cursor) continue;
					if (typeof c.txt === 'string' && c.txt) ch.parser.feed(c.txt);
					ch.cursor = c.seq;
				}
				if (typeof env.last_seq === 'number' && env.last_seq > ch.cursor) ch.cursor = env.last_seq;
				var complete = finalSeq !== undefined ? ch.cursor >= finalSeq : env.more === false;
				if (!complete) {
					if (ch.cursor === before) {
						// No progress: a degraded read (the store says "more" and gave
						// nothing), or chunks that will never come. A few looks of that and
						// what there is, is shown (never stored: it is not known whole).
						ch.stalls++;
						if (env.more === false && ch.stalls >= 3) { self._recApplyStreamed(id, item, ch, env, false); return; }
						item.terminalSeen = true;
						return;
					}
					if (req.remaining() < 1500) { item.terminalSeen = true; return; }
					return loop();
				}
				self._recApplyStreamed(id, item, ch, env, true);
			}, function (err: any) {
				fail(err);
				item.terminalSeen = true; // read it again next look
			});
		};
		return loop();
	}

	/**
	 * An envelope read answered body_unavailable: the answer is stored but could not be
	 * loaded now (an S3 read that failed on the server). Read again at every look for the
	 * first BODY_UNAVAILABLE_BACKOFF_AFTER tries, then only at the stale watch or a return
	 * (_recSettleTerminal). After BODY_UNAVAILABLE_GIVE_UP the turn stops saying
	 * "Thinking..." and shows ANSWER_UNLOADABLE_TEXT; a later read that loads the answer
	 * replaces that text (_recRetryUnloadable). An indexing pass ends with that error.
	 */
	private _recBodyUnavailable(id: string, item: OpenItem): void {
		item.unavail = (item.unavail || 0) + 1;
		item.unavailAt = nowMs();
		if (item.unavail < BODY_UNAVAILABLE_BACKOFF_AFTER) { item.terminalSeen = true; return; }
		item.terminalSeen = false;
		if (item.unavail < BODY_UNAVAILABLE_GIVE_UP) return;
		var err = { type: 'error', error: { type: 'request_error', message: ANSWER_UNLOADABLE_TEXT } };
		if (item.kind === 'chat') {
			if (!this._recUnloadable) this._recUnloadable = {};
			this._recUnloadable[id] = { item: item, tries: 0, at: nowMs() };
		}
		this._recApplyValue(id, item, err, null);
	}

	/**
	 * Chat turns shown as ANSWER_UNLOADABLE_TEXT: one envelope read each at a return or
	 * the stale watch, at most UNLOADABLE_RETRIES times. An answer that loads replaces the
	 * text (a correction); a row that is gone or failed leaves the text as it is.
	 */
	private _recRetryUnloadable(req: LookRequest): Promise<void> {
		var self = this;
		var list = this._recUnloadable;
		var read = resolveForwardRequestRead();
		if (!list || !read) return Promise.resolve();
		var live = this._recLiveUid();
		var due = Object.keys(list).filter(function (id) {
			var u = list![id];
			if (!self._recReadable(u.item.uid, u.item.projectId, live)) return false;
			return req.isReturn || nowMs() - u.at >= LOOK_STALE_MS;
		}).slice(0, LOOK_READ_CONCURRENCY);
		return Promise.all(due.map(function (id) {
			var u = list![id];
			u.at = nowMs();
			u.tries++;
			var it = u.item;
			return Promise.resolve(read!({ id: buildHistoryItemFullId(it.platform, it.projectId, id), service: it.projectId, owner: it.owner, deadline: req.remaining(), signal: req.signal, fresh: true }))
				.then(function (env: any) {
					if (!env || typeof env !== 'object' || env.body_unavailable) {
						if (u.tries >= UNLOADABLE_RETRIES) delete list![id];
						return;
					}
					delete list![id];
					if (env.body === undefined || env.body === null || env.status !== 'resolved') return;
					self.applyTerminal(id, env.body, { ownerKey: it.ownerKey, platform: it.platform, projectId: it.projectId, owner: it.owner, instant: true, correction: true });
				}, function () {
					if (u.tries >= UNLOADABLE_RETRIES) delete list![id];
				});
		})).then(function () { });
	}

	/** A streamed turn read whole (or given up on): shown at once, finalized only when
	 *  whole and keepable, with if_absent so a complete answer another tab stored wins. */
	private _recApplyStreamed(id: string, item: OpenItem, ch: { parser: SseParser; cursor: number }, env: any, whole: boolean): void {
		ch.parser.end();
		var body = ch.parser.finalBody();
		var snap = ch.parser.snapshot();
		if (this._recChunks) delete this._recChunks[id];
		this._noteRespondedAt(id, { id: id, status: 'resolved', in_queue: false, responded: env && env.responded });
		var keep = whole && body != null && mayKeepStreamedAnswer(snap, 'resolved');
		this._applyRecoveredAnswer(id, item.ownerKey, item.platform, item.projectId, item.owner, body, false, false);
		if (keep) this._finalizeAnswer(id, body, { ownerKey: item.ownerKey, platform: item.platform, projectId: item.projectId, owner: item.owner, queue: item.queue });
		this._recAfterApply(id, item);
	}

	/** Apply one terminal value (a provider body, a failed or cancelled envelope). */
	private _recApplyValue(id: string, item: OpenItem, value: any, env: any): void {
		var self = this;
		if (env && typeof env.responded === 'number') this._noteRespondedAt(id, { id: id, status: env.status, in_queue: false, responded: env.responded });
		var who: TerminalContext = { ownerKey: item.ownerKey, projectId: item.projectId, owner: item.owner, platform: item.platform, queue: item.queue };
		var executed = env && typeof env.executed === 'number' ? env.executed : undefined;
		if (item.kind === 'indexing') {
			var entry = this._bgEntry(id);
			// Plan 3.8: a failed pass of a file the WORKER drives may be sent again by the
			// worker, which marks the failure `retried` only after it queued the window again,
			// so the first terminal read can come before the mark. Such a failure is not shown
			// yet: the pass stays open and is read once more after the next complete queue look
			// (or FAILED_PASS_RECHECK_MAX_MS), and only that read's answer is final.
			if (entry && !item.failedRecheck && isErrorResponseBody(value) && !isRetriedFailure(value)
				&& this._isWorkerDrivenIndexing(entry.filename, entry.mime)) {
				if (!item.failedPending) item.failedPending = nowMs();
				item.terminalSeen = false;
				return;
			}
			if (entry) {
				// The background settle: the bubble, the next pass of a client-driven file,
				// the run:: record and the queue entry, exactly as a poll's settle.
				void this._settleBgOutcome(entry, entry.platform, Promise.resolve(value), function () { return executed; })
					.then(function () { self._recAfterApply(id, item); });
				return;
			}
			this.handleHistoryItemResolution(id, value, item.platform, executed, who);
		} else {
			var failed = isErrorResponseBody(value);
			// A turn this page sent, answered with an expired sign-in: sent once more (the
			// dispatch poll's own resend), never shown as the error. The hook is used once.
			if (item.resend && failed && isAuthExpiredError(value) && !isNonRetryableRequestError(value)) {
				var again = item.resend;
				delete item.resend;
				this._stopPoll(id);
				this._closeItem(id);
				again(value);
				return;
			}
			delete item.resend;
			if (item.turn) this._settleChatTurnTools(item.turn, value, failed);
			this.applyTerminal(id, value, who);
		}
		this._recAfterApply(id, item);
	}

	/** An item the server no longer has ("missing" on a strongly consistent read). */
	private _recApplyMissing(id: string, item: OpenItem): void {
		var self = this;
		var who: TerminalContext = { ownerKey: item.ownerKey, projectId: item.projectId, owner: item.owner, platform: item.platform, queue: item.queue };
		if (item.kind === 'indexing') {
			var entry = this._bgEntry(id);
			var gone = { code: 'NOT_EXISTS', message: 'Request not found.' };
			if (entry) {
				void this._settleBgOutcome(entry, entry.platform, Promise.reject(gone), function () { return undefined; })
					.then(function () { self._recAfterApply(id, item); });
				return;
			}
			this.applyTerminal(id, cancelledEnvelope(id), who);
		} else {
			var text = item.anonymous ? REQUEST_UNREACHABLE_TEXT : REQUEST_GONE_TEXT;
			this.applyTerminal(id, { type: 'error', error: { type: 'request_error', message: text } }, who);
		}
		this._recAfterApply(id, item);
	}

	/** After a terminal apply: an item whose bubble is nowhere (no chat view, no cache of
	 *  its chat) is closed all the same; the next history load shows the server's state. */
	private _recAfterApply(id: string, item: OpenItem): void {
		if (!this._openMap()[id]) return;
		if (this._hasWaitingBubble(id, item.ownerKey)) return;
		this._closeItem(id);
	}

	/**
	 * Store a streamed answer as the version history keeps (csr-finalize) with if_absent,
	 * in the tab that holds the settle lock. When another tab stored one first ("exists"),
	 * the stored one is read back and shown instead.
	 */
	private _finalizeAnswer(itemId: string, body: any, who: { ownerKey: string; platform: 'claude' | 'openai'; projectId: string; owner: string; queue?: string }): void {
		var fin = resolveForwardRequestFinalize();
		if (!fin || body == null) return;
		var self = this;
		var url = who.platform === 'openai' ? OPENAI_RESPONSES_API_URL : ANTHROPIC_MESSAGES_API_URL;
		runSettleSideEffect(who.projectId, queueNameOf(who.queue), 'fin:' + who.projectId + ':' + itemId, function () {
			return Promise.resolve(fin(itemId, body, { url: url, method: 'POST', service: who.projectId, owner: who.owner, ifAbsent: true }))
				.then(function (res: any) {
					if (res && res.finalized === false && res.reason === 'exists') self._readStoredAnswer(itemId, who);
				}, function (err: any) {
					// The answer is on screen and in the cache; the chunks stay and the row stays
					// re-readable, which is what they are for. A failure on the way is tried
					// again (the settle lock); the server's refusal is not.
					console.warn('[chat-engine] forwardRequestFinalize failed', err);
					if (isTransportFailure(err)) throw err;
				});
		});
	}

	/** Another tab stored this turn's answer first: show the stored one. */
	private _readStoredAnswer(itemId: string, who: { ownerKey: string; platform: 'claude' | 'openai'; projectId: string; owner: string }): void {
		var read = resolveForwardRequestRead();
		if (!read) return;
		var self = this;
		Promise.resolve(read({ id: buildHistoryItemFullId(who.platform, who.projectId, itemId), service: who.projectId, owner: who.owner, fresh: true }))
			.then(function (env: any) {
				if (!env || env.body === undefined || env.body === null) return;
				self.applyTerminal(itemId, env.body, { ownerKey: who.ownerKey, platform: who.platform, projectId: who.projectId, owner: who.owner, instant: true, correction: true });
			}, function () { /* the answer on screen stays */ });
	}

	// --- background-task resolution + drain -------------------------------
	/** Record how long a background indexing pass took, on the bubble that just
	 *  settled, so the duration shows immediately instead of waiting for whatever
	 *  next refetches history.
	 *
	 *  `_tsStart` is otherwise written only by the history mapper, which reads the
	 *  row's `executed`; a live settle never sees the row at all (the poll resolves
	 *  with the destination's body). This is the same value by the other route.
	 *
	 *  `_ts` is stamped too when the branch that built the bubble left it without
	 *  one: it is the END of the pass, and the pass ended now. A later history load
	 *  replaces both with the server's own numbers.
	 *
	 *  Indexing passes only: an ordinary turn has no duration to show, and
	 *  `_tsStart`'s presence is what both views read to decide. */
	private _stampPassDuration(itemId: string, executedAt?: number): void {
		if (!itemId) return;
		if (!this._indexRefOfItem(itemId)) return;
		var hasStart = typeof executedAt === 'number' && executedAt > 0;
		for (var i = this.state.messages.length - 1; i >= 0; i--) {
			var m: any = this.state.messages[i];
			if (!m || m.role !== 'assistant' || m._serverItemId !== itemId) continue;
			if (m.isPending) continue;
			// `_ts` is stamped whether or not an execution start arrived. A background
			// reply is written straight in by the apply funnel (_settleInList), never
			// typed, so it bypasses the typewriter's stamp -- and this is where an
			// indexing reply gets its timestamp at all. Leaving it inside the duration guard meant a
			// pass with no `executed` (the poll never saw a running tick) rendered with
			// NO TIME LINE whatsoever, because both clients gate the whole element on
			// `_ts`. Losing the duration is the intended degradation; losing the
			// timestamp with it was not.
			if (typeof m._ts !== 'number') m._ts = Date.now();
			if (hasStart) m._tsStart = executedAt;
			// Both of these, because the stamp lands AFTER applyHistoryItemResolution
			// has already notified and cached. Without the notify the widget never
			// repaints (its notify() IS the render, so the duration only appeared on
			// the next unrelated render); without the re-cache the entry written a
			// moment ago is the one missing `_tsStart`, so a rebuild from cache -- a
			// remount, a tab return -- silently dropped the duration again.
			this.host.notify();
			this.updateHistoryCache();
			break;
		}
	}

	handleHistoryItemResolution(itemId: string, response: any, platform: string, executedAt?: number, ctx?: TerminalContext): void {
		// Which file this turn was indexing, read BEFORE the resolution rewrites the
		// bubbles. Every settling turn funnels through here — the bg drain's own
		// poll, the history poll, and agent.vue's forked history poll, which calls
		// straight into this method — so hooking the chain follow-up here is what
		// makes it work in both clients without either of them forking a call site.
		var indexRef = this._indexRefOfItem(itemId);
		this.applyHistoryItemResolution(itemId, response, platform, ctx);
		// After the settle, never inside it: applyHistoryItemResolution builds the
		// assistant bubble in four separate branches (answer, empty reply, error,
		// bg) and stamping in each would be four chances to forget one.
		//
		// It lives HERE rather than at the call sites because this method is the one
		// funnel every settle goes through, and the call sites are the thing that
		// kept getting missed: agent.vue runs its OWN forked history poll, and that
		// fork -- not the engine's drain -- is what settles a pass uploaded from the
		// files page, so a stamp wired only into the drain never ran for the exact
		// case it was written for. A fourth caller added later inherits this for free.
		this._stampPassDuration(itemId, executedAt);
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

	/**
	 * A history-attached poll (the engine's, agent.vue's, the files page's) settled.
	 * Routed through the one funnel, by id: see applyTerminal. `ctx` is the identity the
	 * caller pinned when it attached the poll; the open item's pinned identity fills
	 * whatever it leaves out.
	 */
	applyHistoryItemResolution(itemId: string, response: any, platform: string, ctx?: TerminalContext): void {
		this.historyItemPolls.delete(itemId);
		var c: TerminalContext = Object.assign({}, ctx || {});
		if (c.platform !== 'claude' && c.platform !== 'openai') c.platform = platform;
		this.applyTerminal(itemId, response, c);
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
		return indexScopeKey(entry.projectId, entry.platform) + '|' + file;
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
	/** Per project: when a look last CONFIRMED the bg queue held nothing pending or running
	 *  (2026-11-20). A recent pass older than this is a finished run, not evidence of live
	 *  work, so a tab return no longer re-asks for ten minutes after every run. Memory only:
	 *  a reload starts without it and asks once, as before. */
	private _idleVerdictAt: { [svcId: string]: number } = {};

	/** Newest wall-clock `_ts` of any indexing pass on screen, or 0. */
	private _newestIndexPassTs(): number {
		var newest = 0;
		var msgs = this.state.messages;
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (m && m._indexFile && typeof m._ts === 'number' && m._ts > newest) newest = m._ts;
		}
		return newest;
	}

	/** Live indexing work THIS page is tracking for the project: a queued or adopted pass,
	 *  an attached bg poll, or a live key a look recorded. No recency guess. */
	private _hasLocalLiveIndexWork(svcId: string): boolean {
		for (var i = 0; i < this.bgTaskQueue.length; i++) {
			var e = this.bgTaskQueue[i];
			if (e && e.projectId === svcId) return true;
		}
		var keys = this.state.liveIndexKeys || {};
		for (var k in keys) { if (keys[k]) return true; }
		var found = false;
		this.historyItemPolls.forEach(function (h: any) { if (h && h.kind === 'bg') found = true; });
		return found;
	}

	// ── RETURN CATCH-UP + REQUEST STATUS PUSH (owner, 2026-11-23) ──────────────
	// The rule: when the user comes back to the chat (the tab shown again, the computer
	// awake again, the network or the websocket back), the chat is re-read from the
	// server, so nothing that happened while they were away is missing. Since the
	// reconciler (2026-11-24) that is its return look: the live readers restart, the
	// discovery listing finds sends whose ack was lost, the first page is merged (keeps
	// older pages, a send in flight, never lets an empty answer replace a known one), and
	// every open item is read. Status frames (statusPush) only make looks sooner; they
	// never decide anything on screen. The methods below keep their names as wrappers.

	private _statusUnsub: (() => void) | null = null;
	private _statusSeenConnect = false;

	/**
	 * Re-read the chat from the server now (see the rule above). A thin wrapper over the
	 * reconciler's return look: safe to call from any number of triggers at once, runs
	 * with no chat view too (the first page is read only when one is mounted, and owed
	 * while polling is paused), and resolves when that look ends.
	 */
	catchUpHistory(): Promise<void> {
		// The reconciler's return look does this job now (reconciler plan, section 3 item 3):
		// live readers restarted, the discovery listing, the first page merged, every open
		// item read. Kept under its old name for hosts that call it; any number of calls at
		// once run one look (plus exactly one more for calls made while it runs).
		return this._recSched().trigger('return');
	}

	/**
	 * Watch for the moments the user comes back without the tab being hidden first: the
	 * computer waking from sleep (the reconciler's timer finds a gap far longer than asked),
	 * the network coming back, a page restored from the back-forward cache. Also starts
	 * the status push listener. Runs while a chat view is mounted and stops itself when
	 * none is.
	 */
	private _ensureReturnWatch(): void {
		// The reconciler's chain watches for returns (tab shown, wake, online, bfcache) on its
		// own; this only makes sure it runs, and listens to status frames while a chat is open.
		this._recEnsure();
		this._startStatusPush();
	}

	/** Listen to request status frames while a chat view is mounted (statusPush on). */
	private _startStatusPush(): void {
		if (this._statusUnsub || !statusPushEnabled()) return;
		var self = this;
		// The first 'connected' is the socket this subscription found or opened, right
		// after the view loaded the chat itself: nothing can have been missed yet.
		this._statusSeenConnect = false;
		try {
			var unsub = chatEngineConfig().onRequestStatus!(function (ev: any) { self._onRequestStatus(ev); });
			this._statusUnsub = typeof unsub === 'function' ? unsub : function () { };
		} catch (e) {
			this._statusUnsub = null;
		}
	}

	private _stopStatusPush(): void {
		var unsub = this._statusUnsub;
		this._statusUnsub = null;
		if (unsub) {
			try { unsub(); } catch (e) { /* best effort */ }
		}
	}

	/**
	 * One status frame event. 'connected' (first connection, and every reconnect after a
	 * drop, a sleep or the planned renewal) catches up, because frames sent while the
	 * socket was down are lost. A status change of an indexing pass this page does not
	 * poll runs the queue check now instead of at its next heartbeat; a pass that IS polled
	 * was already woken by skapi-js itself. Chat turns are left to their own polls.
	 */
	private _onRequestStatus(ev: any): void {
		if (!ev) return;
		var hiddenTab = typeof document !== 'undefined' && document.visibilityState === 'hidden';
		if (ev.type === 'connected') {
			if (!this._statusSeenConnect) { this._statusSeenConnect = true; return; }
			// A reconnect: frames sent while the socket was down are lost, so this is a
			// return. While hidden it only keeps the chain alive; showing the tab looks.
			if (hiddenTab) { this._recEnsure(); return; }
			void this._recSched().trigger('reconnect');
			return;
		}
		if (ev.type !== 'status' || typeof ev.id !== 'string') return;
		// A frame about the indexing queue: every page watching it reads it soon (see
		// watchIndexQueue), whether or not this page follows that pass.
		var bgFrame = !!ev.queue && isBgIndexingQueue(ev.queue);
		if (bgFrame) for (var wi = 0; wi < this._iqWatches.length; wi++) this._iqWatches[wi].frame = true;
		// A queued chat turn the server just started: shown running, by its id.
		if (ev.status === 'running' && (!ev.queue || !isBgIndexingQueue(ev.queue))) this._noteServerState(ev.id, 'running');
		if (this._recNewMode()) {
			if (this._tomb()[ev.id]) return;
			if (hiddenTab) { this._recEnsure(); return; }
			var known = !!this._openMap()[ev.id];
			if (known) {
				if (!this._recFrameIds) this._recFrameIds = {};
				this._recFrameIds[ev.id] = true;
			}
			// A frame naming an open item reads it now. One naming a chat turn nothing
			// here knows is a return (discovery and the first page); an unknown indexing
			// pass (a worker lane) runs the queue check.
			var bg = !!ev.queue && isBgIndexingQueue(ev.queue);
			void this._recSched().trigger(known || bg ? 'frame' : 'unknown');
			return;
		}
		if (!this._viewMounted()) {
			if (bgFrame && this._iqWatches.length) {
				if (hiddenTab) this._recEnsure();
				else void this._recSched().trigger('frame');
			}
			return;
		}
		if (!ev.queue || !isBgIndexingQueue(ev.queue)) return;
		if (this.historyItemPolls.has(ev.id)) return;
		var tracked = false;
		for (var i = 0; i < this.bgTaskQueue.length; i++) {
			var e = this.bgTaskQueue[i];
			if (e && e.id === ev.id) { tracked = !e.byListing; break; }
		}
		if (tracked) return;
		this._nudgeQueueCheck();
	}

	/** Run the queue check (adopt, settle by listing, page progress) now, through the
	 *  reconciler's one chain. */
	private _nudgeQueueCheck(): void {
		// A look with the 'frame' trigger runs the queue check at once (see
		// _recIndexingCheck); the reconciler's single flight coalesces a burst of frames.
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { this._recEnsure(); return; }
		void this._recSched().trigger('frame');
	}

	private _ensureAdoptTick(): void {
		// The queue check runs inside the reconciler's one chain now (_recIndexingCheck, at
		// ADOPT_TICK_MS, or STATUS_PUSH_ADOPT_TICK_MS while frames arrive): no timer of its own.
		this._recEnsure();
	}

	/** The last COMPLETE running+pending look at this user's bg queue: which pass ids were
	 *  live. Complete means both lists came back shorter than their limit, so a tracked pass
	 *  missing from it really has left the queue. */
	private _lastLiveLook: { svcId: string; platform: string; at: number; ids: { [id: string]: true } } | null = null;
	/** By-listing passes whose by-id lookup is in flight, so one tick never reads a pass twice. */
	private _listingSettling: { [id: string]: true } = {};
	private _listingLookInflight = false;

	/**
	 * Follow an indexing pass found in a loaded history page through the queue check
	 * instead of polling it (owner, 2026-11-20): polls on one queue run one at a time in
	 * skapi-js, so after a reload mid-run every lane waited behind the first. Only for a
	 * pass the worker drives (a client-driven chain is resumed off its dispatching entry,
	 * whose pass count caps it) and only when the host can read a row by id. True when the
	 * pass is now tracked (the caller then attaches no poll).
	 */
	trackHistoryIndexPass(item: any): boolean {
		if (typeof chatEngineConfig().csrHistoryItemLookup !== 'function') return false;
		if (!item || typeof item.id !== 'string' || !item.id) return false;
		if (item.status !== 'pending' && item.status !== 'running') return false;
		for (var q = 0; q < this.bgTaskQueue.length; q++) {
			if (this.bgTaskQueue[q] && this.bgTaskQueue[q].id === item.id) return !!this.bgTaskQueue[q].byListing;
		}
		var id = this.host.getIdentity();
		var platform = id.platform;
		if (!id.projectId || (platform !== 'claude' && platform !== 'openai')) return false;
		var text = typeof item.request_text === 'string' && item.request_text
			? item.request_text
			: extractLastUserTextFromRequest(item.request_body);
		var ref = parseIndexingRequestText(text);
		if (!ref || !ref.name) return false;
		if (!this._isWorkerDrivenIndexing(ref.name, ref.mime)) return false;
		this.bgTaskQueue.push({
			projectId: id.projectId,
			platform: platform,
			id: item.id,
			identity: Object.assign({}, id), owner: id.owner,
			filename: ref.name,
			storagePath: ref.path,
			mime: ref.mime,
			size: ref.size,
			status: item.status === 'running' ? 'running' : 'pending',
			poll: typeof item.poll === 'function' ? item.poll : undefined,
			resumePass: ref.continued ? 1 : 0,
			byListing: true,
			adoptedAt: Date.now(),
		});
		return true;
	}

	/**
	 * Show a pass as RUNNING once the queue says it is. A pass this client sent starts out
	 * waiting (the server queues it), and its own poll's running tick used to be what
	 * moved it on. Settled from the listing, it has no poll, so the running listing the
	 * 10-second check already takes does it instead (owner, 2026-11-20).
	 */
	private _promoteListedRunning(runningRes: any): void {
		var list = runningRes && Array.isArray(runningRes.list) ? runningRes.list : [];
		if (!list.length) return;
		var running: { [id: string]: true } = {};
		for (var i = 0; i < list.length; i++) if (list[i] && typeof list[i].id === 'string') running[list[i].id] = true;
		var changed = false;
		for (var q = 0; q < this.bgTaskQueue.length; q++) {
			var e = this.bgTaskQueue[q];
			if (!e || e.status !== 'pending' || !running[e.id]) continue;
			e.status = 'running';
			if (this._promoteBgItemToRunning(e.id)) changed = true;
		}
		if (changed) {
			this.host.notify();
			this.updateHistoryCache();
		}
	}

	/** promoteNextBgQueuedToRunning for one named pass: its waiting request bubble becomes
	 *  the running one, with a "Thinking..." placeholder under it. False when that pass has
	 *  no waiting bubble (already running, settled, or not on screen). */
	private _promoteBgItemToRunning(itemId: string): boolean {
		var idx = this.state.messages.findIndex(function (m) {
			return m.role === 'user' && m.isBackgroundTask && m.isPendingQueued && m._serverItemId === itemId;
		});
		if (idx === -1) return false;
		var existing = this.state.messages[idx];
		// Its cancel is still on the way (see _promoteChatItemToRunning).
		if (existing._cancelling) return false;
		var promoted: ChatMessage = { role: 'user', content: existing.content, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: itemId };
		if (existing._indexFile) promoted._indexFile = existing._indexFile;
		if (existing._ts !== undefined) promoted._ts = existing._ts;
		if (existing._ownerKey !== undefined) promoted._ownerKey = existing._ownerKey;
		this.state.messages[idx] = promoted;
		var placeholder: ChatMessage = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: itemId };
		if (existing._ownerKey !== undefined) placeholder._ownerKey = existing._ownerKey;
		this.state.messages.splice(idx + 1, 0, placeholder);
		return true;
	}

	/**
	 * Chats-only history (owner, 2026-11-21): on when the host can list a file's passes
	 * (listIndexPasses) and read one by id (csrHistoryItemLookup). The history fetch then
	 * skips the indexing queue, a file's row comes from its run:: record, and opening the
	 * row loads its passes (loadRunPasses), a page at a time.
	 */
	lazyIndexRowsEnabled(): boolean {
		var cfg = chatEngineConfig();
		return typeof cfg.listIndexPasses === 'function' && typeof cfg.csrHistoryItemLookup === 'function';
	}

	/** How many passes one "Load more" brings into a file's row. */
	static RUN_PASS_PAGE = 10;

	/** The paging state of a file's passes, or null before its row was first opened. */
	runPassPaging(storagePath?: string): { ids: string[]; loaded: number; loading: boolean; done: boolean; error?: string } | null {
		if (!storagePath || !this.state.passPaging) return null;
		return this.state.passPaging[storagePath] || null;
	}

	/**
	 * Load the next page of a file's indexing passes into the chat, newest first (owner,
	 * 2026-11-21). The ids come from the file's pass records (listIndexPasses, once), each
	 * pass is read by id (csrHistoryItemLookup) and lands as the same request + reply bubbles
	 * a live pass produces, so its file's row groups it like any other. A pass still running
	 * or waiting is left to the live queue check, which shows it as it settles; one already
	 * in the chat is not read again. Never throws.
	 */
	loadRunPasses(storagePath: string, fileName?: string): Promise<void> {
		var self = this;
		var cfg = chatEngineConfig();
		var list = cfg.listIndexPasses, lookup = cfg.csrHistoryItemLookup;
		var id = this.host.getIdentity();
		var platform = id.platform;
		if (!storagePath || typeof list !== 'function' || typeof lookup !== 'function') return Promise.resolve();
		if (!id.projectId || (platform !== 'claude' && platform !== 'openai')) return Promise.resolve();
		if (!this.state.passPaging) this.state.passPaging = {};
		var paging = this.state.passPaging[storagePath];
		if (paging && (paging.loading || paging.done)) return Promise.resolve();
		if (!paging) {
			this.state.passPaging[storagePath] = { ids: [], loaded: 0, loading: false, done: false };
		}
		// Read back through the state, never the object just stored: a host may hold the state
		// as a reactive proxy (Vue), and writes to the raw object would never reach the screen.
		var p = this.state.passPaging[storagePath];
		p.loading = true;
		p.error = undefined;
		this.host.notify();
		var svcId = id.projectId, owner = id.owner;
		var name = fileName || storagePath.split('/').pop() || storagePath;
		var idsReady: Promise<string[]> = p.ids.length
			? Promise.resolve(p.ids)
			: Promise.resolve(list(svcId, storagePath)).then(function (ids) {
				var clean = (Array.isArray(ids) ? ids : []).filter(function (x) { return typeof x === 'string' && !!x; });
				// Request ids sort by time ("stamp:entropy", the stamp a time_ns): newest first.
				clean.sort(function (a, b) { return a < b ? 1 : a > b ? -1 : 0; });
				p.ids = clean;
				return clean;
			});
		return idsReady.then(function (ids) {
			var oldest = ids.length ? ids[ids.length - 1] : '';
			var present: { [rid: string]: true } = {};
			for (var i = 0; i < self.state.messages.length; i++) {
				var m = self.state.messages[i];
				if (m && m._serverItemId) present[m._serverItemId] = true;
			}
			// The next RUN_PASS_PAGE steps not already on screen (a step the live check or an
			// earlier page brought in is passed over, not counted).
			var page: string[] = [];
			// Where each asked step sits in `ids`, so a step whose read failed on the way
			// can be asked again by the next "load more" (see below).
			var pagePos: number[] = [];
			var next = p.loaded;
			while (next < ids.length && page.length < ChatSession.RUN_PASS_PAGE) {
				if (!present[ids[next]]) { page.push(ids[next]); pagePos.push(next); }
				next++;
			}
			return Promise.all(page.map(function (rid) {
				return Promise.resolve(lookup!(buildHistoryItemFullId(platform as 'claude' | 'openai', svcId, rid), svcId, owner))
					.then(function (body: any) { return { rid: rid, body: body, err: null as any }; },
						function (err: any) { return { rid: rid, body: null, err: err }; });
			})).then(function (got) {
				if (self.host.getIdentity().projectId !== svcId) return;
				var add: ChatMessage[][] = [];
				// The first step (by its place in `ids`) whose read failed on the way.
				var retryFrom = -1;
				for (var g = 0; g < got.length; g++) {
					var r = got[g];
					if (!r) continue;
					var body = r.body;
					// Live work (running or waiting) is the queue check's to show.
					if (isCsrStatusEnvelope(body) && (body.status === 'running' || body.status === 'pending')) continue;
					var notExists = isNotExistsError(r.err);
					if (notExists) continue;
					// A read that failed ON THE WAY says nothing about the step, which most
					// likely succeeded: it is left out instead of drawn as a failed pass, and
					// the next "load more" asks for it again.
					if (r.err && (isTransportFailure(r.err) || isAuthExpiredError(r.err))) {
						if (retryFrom === -1 || pagePos[g] < retryFrom) retryFrom = pagePos[g];
						continue;
					}
					var continued = r.rid !== oldest;
					var when = requestIdTimeMs(r.rid);
					var user: ChatMessage = {
						role: 'user',
						content: self.host.formatIndexingLabel(name, undefined, null, storagePath, false, continued),
						isBackgroundTask: true,
						_serverItemId: r.rid,
						_indexFile: { name: name, path: storagePath, isReindex: false, continued: continued },
					};
					if (when) user._ts = when;
					var reply: ChatMessage;
					if (r.err) {
						reply = { role: 'assistant', content: getErrorMessage(r.err), isError: true, isBackgroundTask: true, _serverItemId: r.rid };
					} else if (isCsrStatusEnvelope(body) && body.status === 'cancelled') {
						user.isCancelled = true;
						add.push([user]);
						continue;
					} else if (isErrorResponseBody(body)) {
						reply = { role: 'assistant', content: getErrorMessage(body), isError: true, isBackgroundTask: true, _serverItemId: r.rid };
					} else {
						var text = ((platform === 'openai' ? extractOpenAIText(body) : extractClaudeText(body)) || '').trim();
						var complete = text.indexOf(INDEXING_COMPLETE_MARKER) !== -1;
						if (complete) text = text.split(INDEXING_COMPLETE_MARKER).join('').trim();
						reply = { role: 'assistant', content: text || EMPTY_INDEXING_REPLY, isBackgroundTask: true, _serverItemId: r.rid };
						if (complete) reply._indexComplete = true;
					}
					if (when) reply._ts = when;
					add.push([user, reply]);
				}
				// Oldest first, each pair at its place in time among the messages.
				add.sort(function (a, b) { return (a[0]._ts || 0) - (b[0]._ts || 0); });
				for (var k = 0; k < add.length; k++) self._insertByTime(add[k]);
				// Steps loaded past a failed one are on screen now, so the next page passes
				// over them and only the failed ones are asked again: the row keeps offering
				// "Load more" (not done) instead of drawing them as failed passes.
				p.loaded = retryFrom !== -1 ? retryFrom : next;
				p.done = p.loaded >= ids.length;
			});
		}).catch(function (err: any) {
			p.error = getErrorMessage(err) || 'The steps could not be loaded.';
		}).then(function () {
			p.loading = false;
			self.host.notify();
			self.updateHistoryCache();
		});
	}

	/** Insert bubbles before the first message that is newer than them; messages whose time
	 *  is unknown are skipped over, and the end of the list takes them otherwise. A message's
	 *  time is its `_ts`, else (2026-11-25) the time in its request id: a live worker pass
	 *  adopted from the queue carries no `_ts`, and a file's older passes loaded by opening its
	 *  row (loadRunPasses) used to land AFTER it, which split one run into two rows. */
	private _insertByTime(bubbles: ChatMessage[]): void {
		var at = messageTimeMs(bubbles[0]);
		var idx = this.state.messages.length;
		if (at > 0) {
			for (var i = 0; i < this.state.messages.length; i++) {
				var t = messageTimeMs(this.state.messages[i]);
				if (t > 0 && t > at) { idx = i; break; }
			}
		}
		Array.prototype.splice.apply(this.state.messages, ([idx, 0] as any[]).concat(bubbles));
	}

	private _progressInflight = false;

	/**
	 * Refresh the page progress ("175 of 530 pages") of the documents this page is still
	 * tracking passes for, one read per file (config readIndexProgress, the MCP's
	 * prog::<path> record). Runs on the ADOPT_TICK_MS check; a file with nothing tracked is
	 * not asked about. Never throws.
	 */
	private _refreshPageProgress(): void {
		var read = chatEngineConfig().readIndexProgress;
		if (typeof read !== 'function' || this._progressInflight) return;
		var id = this.host.getIdentity();
		if (!id.projectId || this.isPollingPaused() || !this.host.isViewMounted()) return;
		var svcId = id.projectId;
		var paths: string[] = [];
		for (var i = 0; i < this.bgTaskQueue.length; i++) {
			var e = this.bgTaskQueue[i];
			if (e && e.projectId === svcId && e.storagePath && paths.indexOf(e.storagePath) === -1) paths.push(e.storagePath);
		}
		if (!paths.length) return;
		var self = this;
		this._progressInflight = true;
		Promise.all(paths.map(function (path) {
			return Promise.resolve(read!(svcId, path)).then(function (data) { return { path: path, data: data }; }, function () { return { path: path, data: null }; });
		})).then(function (rows) {
			self._progressInflight = false;
			if (self.host.getIdentity().projectId !== svcId) return;
			if (!self.state.indexPageProgress) self.state.indexPageProgress = {};
			var changed = false;
			for (var r = 0; r < rows.length; r++) {
				var d: any = rows[r].data;
				var saved = d && typeof d.pages_saved === 'number' ? d.pages_saved : null;
				if (saved === null) continue;
				var total = d && typeof d.pages_total === 'number' && d.pages_total > 0 ? d.pages_total : null;
				var prev = self.state.indexPageProgress[rows[r].path];
				if (prev && prev.saved === saved && prev.total === total) continue;
				self.state.indexPageProgress[rows[r].path] = { saved: saved, total: total, at: Date.now() };
				changed = true;
			}
			if (changed) self.host.notify();
		}, function () { self._progressInflight = false; });
	}

	/** The page progress to show for a file's row, or null (see _refreshPageProgress). */
	pageProgressFor(storagePath?: string, fileName?: string): { saved: number; total: number | null } | null {
		var map = this.state.indexPageProgress;
		if (!map) return null;
		var p = storagePath ? map[storagePath] : undefined;
		// A row put together from passes the queue check just found can lack its storage
		// path for a moment (the first of them carries it); the file NAME still finds the
		// progress then, when exactly one file of that name is being followed.
		if (!p && fileName) {
			var hit: string | null = null;
			for (var k in map) {
				if (k === fileName || k.slice(-(fileName.length + 1)) === '/' + fileName) {
					if (hit) { hit = null; break; }
					hit = k;
				}
			}
			if (hit) p = map[hit];
		}
		return p ? { saved: p.saved, total: p.total } : null;
	}

	private _noteLiveLook(svcId: string, platform: 'claude' | 'openai', results: any[]): void {
		var ids: { [id: string]: true } = {};
		var complete = true;
		for (var r = 0; r < results.length; r++) {
			var list = results[r] && Array.isArray(results[r].list) ? results[r].list : [];
			if (list.length >= WORKER_PASS_ADOPT_LIMIT || (results[r] && results[r].endOfList === false)) complete = false;
			for (var i = 0; i < list.length; i++) if (list[i] && typeof list[i].id === 'string') ids[list[i].id] = true;
		}
		this._lastLiveLook = complete ? { svcId: svcId, platform: platform, at: Date.now(), ids: ids } : null;
		// A complete look at the queue: a failed worker pass waiting for its second read
		// (plan 3.8, see _recApplyValue) is read at the next look. Its `retried` mark, if the
		// worker sent the window again, is written by now: the look shows the new pass.
		if (complete) {
			var open = this._openMap();
			for (var oid in open) {
				var oi = open[oid];
				if (oi.failedPending && !oi.failedRecheck && oi.projectId === svcId && nowMs() - oi.failedPending >= FAILED_PASS_RECHECK_MIN_MS) {
					oi.failedRecheck = true;
					oi.terminalSeen = true;
				}
			}
		}
		// A complete look with no pass of a followed file run: that run is over (its
		// record is read one last time). Called after _recordLiveIndexKeys published the
		// live files of this same look.
		if (complete) this._closeIdleFileRuns(svcId);
	}

	/**
	 * Settle indexing passes from the queue instead of from their own polls (owner,
	 * 2026-11-20): the worker's lanes AND the first passes this client sent. Runs on the
	 * ADOPT_TICK_MS check, beside the adoption look.
	 *
	 * WHY. skapi-js runs every poll on one queue one at a time, each until its request
	 * finishes. The worker runs a document's windows in parallel lanes on that one queue, so
	 * a lane that finished waited behind every pass ahead of it (measured: passes done at
	 * 17:04 shown at 17:06-17:07, one every ~5 s, after a 3-minute first pass).
	 *
	 * HOW. One compact listing each of the queue's `resolved` and `failed` rows (stubs, no
	 * bodies). A tracked pass found there, or one missing from a COMPLETE running+pending look
	 * taken after it was adopted (cancelled, removed), is read ONCE by id through the host's
	 * csrHistoryItemLookup, the same row a poll's last read returns, and settled through
	 * _settleBgOutcome exactly as its poll would have been. A lookup that still says
	 * running/pending (the status index lags the table) leaves the pass for the next tick.
	 */
	private _settleByListing(): void {
		var self = this;
		if (this._listingLookInflight) return;
		var lookup = chatEngineConfig().csrHistoryItemLookup;
		if (typeof lookup !== 'function') return;
		var id = this.host.getIdentity();
		var platform = id.platform;
		if (!id.projectId || (platform !== 'claude' && platform !== 'openai')) return;
		if (this.isPollingPaused() || !this.host.isViewMounted()) return;
		var svcId = id.projectId, owner = id.owner;
		var waiting: BgTaskEntry[] = [];
		for (var i = 0; i < this.bgTaskQueue.length; i++) {
			var e = this.bgTaskQueue[i];
			if (e && e.byListing && e.projectId === svcId && e.platform === platform && !this._listingSettling[e.id]) waiting.push(e);
		}
		if (!waiting.length) return;
		var queue = bgIndexingQueueName(id.userId, svcId);
		var ask = function (status: 'resolved' | 'failed') {
			return Promise.resolve(getChatHistory(
				{ service: svcId, owner: owner, platform: platform as 'claude' | 'openai', queue: queue, status: status, queue_exact: true, compact: true },
				{ limit: WORKER_PASS_ADOPT_LIMIT, fetchMore: false },
			)).then(function (res: any) { return res && Array.isArray(res.list) ? res.list : []; })
				.catch(function () { return []; });
		};
		this._listingLookInflight = true;
		Promise.all([ask('resolved'), ask('failed')]).then(function (lists: any[][]) {
			self._listingLookInflight = false;
			var now = self.host.getIdentity();
			if (now.projectId !== svcId || now.platform !== platform || !self.host.isViewMounted()) return;
			var finished: { [id: string]: any } = {};
			for (var l = 0; l < lists.length; l++) {
				for (var k = 0; k < lists[l].length; k++) {
					var row = lists[l][k];
					if (row && typeof row.id === 'string') finished[row.id] = row;
				}
			}
			var look = self._lastLiveLook;
			var lookUsable = !!look && look.svcId === svcId && look.platform === platform && Date.now() - look.at <= 2 * ADOPT_TICK_MS;
			for (var w = 0; w < waiting.length; w++) {
				var entry = waiting[w];
				if (self.bgTaskQueue.indexOf(entry) === -1) continue; // settled meanwhile (history, cancel)
				var row2 = finished[entry.id];
				var leftQueue = !row2 && lookUsable && !look!.ids[entry.id]
					&& typeof entry.adoptedAt === 'number' && entry.adoptedAt < look!.at;
				if (!row2 && !leftQueue) continue;
				self._settleListedEntry(entry, platform as 'claude' | 'openai', lookup,
					row2 && typeof row2.executed === 'number' && row2.executed > 0 ? row2.executed : undefined);
			}
		}, function () { self._listingLookInflight = false; });
	}

	/** One by-id read of a by-listing pass, then the shared settle. */
	private _settleListedEntry(entry: BgTaskEntry, platform: 'claude' | 'openai', lookup: (fullId: string, service: string, owner: string) => Promise<any>, executedAt: number | undefined): void {
		var self = this;
		// The owner pinned on the entry; the live one only for an entry pushed without it.
		var owner = entry.owner !== undefined ? entry.owner
			: (entry.identity ? entry.identity.owner : this.host.getIdentity().owner);
		this._listingSettling[entry.id] = true;
		Promise.resolve(lookup(buildHistoryItemFullId(platform, entry.projectId, entry.id), entry.projectId, owner)).then(function (body: any) {
			delete self._listingSettling[entry.id];
			if (self.bgTaskQueue.indexOf(entry) === -1) return;
			// Still going by the table's own reading: leave it for the next tick.
			if (isCsrStatusEnvelope(body) && (body.status === 'running' || body.status === 'pending')) return;
			self._settleBgOutcome(entry, platform, Promise.resolve(body), function () { return executedAt; });
		}, function (err: any) {
			delete self._listingSettling[entry.id];
			if (self.bgTaskQueue.indexOf(entry) === -1) return;
			// A read that failed on the way (or on the sign-in) says nothing about the
			// pass: the next tick reads it again. It used to settle the pass as FAILED,
			// error bubble and run:: record included, on a pass that had succeeded.
			if (!isNotExistsError(err) && (isTransportFailure(err) || isAuthExpiredError(err))) return;
			self._settleBgOutcome(entry, platform, Promise.reject(err), function () { return executedAt; });
		});
	}

	private _adoptWorkerIndexingPasses(attempt: number, passive?: boolean, single?: boolean): void {
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
			if (results[0] !== null && results[1] !== null) {
				self._recordLiveIndexKeys(results);
				self._noteLiveLook(svcId, platform as 'claude' | 'openai', results);
				// A file the queue still works on keeps being looked at until it leaves the
				// queue, even when this page tracks none of its passes (a reload, or a run
				// started elsewhere): its row is drawn from the look, and a look nobody
				// repeats would leave the row "Indexing" after the run had ended.
				self._ensureAdoptTick();
			}
			if (results[0] !== null) self._promoteListedRunning(results[0]);
			// Both queries answered and both empty: the queue holds nothing for this user.
			var emptyLook = results[0] !== null && results[1] !== null
				&& !((results[0].list || []).length) && !((results[1].list || []).length);
			var adoptedIds: string[] = [];
			// OLDEST FIRST, across both lists. A file's row starts at the first pass the
			// grouping meets: adopted in the queue's own order (running, then pending, each
			// newest first), a run's "continuing" passes landed before its opening pass, and
			// the run drew two rows until the opening pass settled. Request ids sort by time.
			var found: any[] = [];
			for (var ri = 0; ri < results.length; ri++) {
				var list = results[ri] && Array.isArray(results[ri].list) ? results[ri].list : [];
				for (var i = 0; i < list.length; i++) if (list[i]) found.push(list[i]);
			}
			found.sort(function (a: any, b: any) {
				var x = String(a.id || ''), y = String(b.id || '');
				return x < y ? -1 : x > y ? 1 : 0;
			});
			for (var fi = 0; fi < found.length; fi++) {
				if (self._adoptWorkerIndexingItem(found[fi], svcId, platform as 'claude' | 'openai')) adoptedIds.push(found[fi].id);
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
				if (self._isTrackingAny(adoptedIds)) { self._ensureAdoptTick(); return; }
			}
			// A periodic look (_ensureAdoptTick) never climbs: the next tick is its retry.
			if (single) return;
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
			if (passive && !self._hasLiveIndexEvidence(svcId)) {
				if (emptyLook) self._idleVerdictAt[svcId] = Date.now();
				return;
			}
			if (attempt + 1 >= WORKER_PASS_ADOPT_ATTEMPTS.length) {
				if (emptyLook) self._idleVerdictAt[svcId] = Date.now();
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
		if (found) return true;

		// A chain this client did not START leaves none of the three signals above,
		// and they are all signals of LOCAL DISPATCH: the bgTaskQueue entry covers
		// only the pass this page sent and is spliced out as soon as it settles, a
		// reload clears that array outright, and liveIndexKeys is empty in exactly
		// the moment the probe just missed. A run begun on the db-files page and
		// then opened in the chat has none of them, so the ladder never climbed for
		// it: one probe landing in the gap between pass N resolving and pass N+1
		// being enqueued marked the file finished, and with no local pass left to
		// settle, nothing asked again. The row stayed green on a file still being
		// read.
		//
		// The passes themselves are the evidence in that case. Bounded by recency,
		// because the thing this gate exists to prevent is the climb running on an
		// idle tab whose indexing finished long ago - and such a chat's newest
		// indexing pass is hours or days old, so it still does not climb.
		// Date.now(), NOT nowMs(): `_ts` is a wall-clock epoch (the same clock the
		// run:: records are stamped with), while nowMs() is performance.now() --
		// milliseconds since process start. Subtracting the window from that gives a
		// NEGATIVE cutoff, every epoch `_ts` clears it, and the gate would then be
		// true for any chat that has ever indexed anything: exactly the always-climb
		// this gate was added to stop.
		var cutoff = Date.now() - RECENT_INDEX_PASS_EVIDENCE_MS;
		// A pass from before the last confirmed-idle look belongs to a run that is over.
		var idleAt = this._idleVerdictAt[svcId] || 0;
		if (idleAt > cutoff) cutoff = idleAt;
		var msgs = this.state.messages;
		for (var mi = msgs.length - 1; mi >= 0; mi--) {
			var m = msgs[mi];
			if (!m || !m._indexFile) continue;
			if (typeof m._ts !== 'number') continue;
			if (m._ts >= cutoff) return true;
		}
		return false;
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
		//
		// The queue look (probeBgQueue) is a compact listing: an indexing pass comes back as
		// a label stub (request_text, no request echo) and is already scoped to this
		// platform by the listing's id prefix (skapi-js sends it with every queue listing).
		// A full echo (a backend without compact stubs) is shape-checked as before.
		var userText: string;
		if (item.compact && typeof item.request_text === 'string') {
			userText = item.request_text;
		} else {
			var body = item.request_body;
			if (!body || typeof body !== 'object') return false;
			if (platform === 'claude' ? !Array.isArray((body as any).messages) : !Array.isArray((body as any).input)) return false;
			userText = extractLastUserTextFromRequest(body);
		}
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
			// Settled by the 10-second queue check when the host can look a row up by id
			// (csrHistoryItemLookup); otherwise polled as before.
			byListing: typeof chatEngineConfig().csrHistoryItemLookup === 'function',
			adoptedAt: Date.now(),
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
		// A chat view is up: watch for the user coming back (see catchUpHistory).
		this._ensureReturnWatch();
		// Before anything is surfaced: drop continuations of files the user stopped
		// (and let a fresh first pass lift the stop), then cancel any worker-queued
		// pass of a stopped file that reached the chat through history.
		this._applyIndexCancellations();
		this._sweepCancelledIndexing();
		// A dispatched or adopted pass is live work: follow the run while the tab shows it.
		this._ensureAdoptTick();
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
		// Every indexing pass is settled by the 10-second queue check rather than by its own
		// poll when the host can read a row by id (owner, 2026-11-20): first passes too, not
		// only the worker's lanes. skapi-js runs a queue's polls one at a time, so a file's
		// first pass that finished waited behind another file's (a PDF's first pass runs for
		// minutes). Decided HERE, the one place polls are attached, so a pass added by any
		// caller (this engine, agent.vue, the files page) is covered alike.
		// With the batch reads, the reconciler settles every pass (one read per look for all
		// of them), so none is polled either.
		var listingSettles = typeof chatEngineConfig().csrHistoryItemLookup === 'function' || this._recNewMode();
		// Set by the injection branch; drives the single render/cache/scroll below.
		var injectedAny = false;
		var drainKey = this.getHistoryCacheKey();
		this.bgTaskQueue.forEach(function (entry) {
			if (entry.projectId !== svcId || entry.platform !== plat) return;
			// PIN the identity the first time the engine sees the entry (a host may push
			// one without it), from the identity this drain runs under, which matches the
			// entry's project and platform. Its settle, its by-id reads and a client-driven
			// file's next pass use this from now on, never a later live read.
			if (!entry.identity) entry.identity = Object.assign({}, id);
			if (entry.owner === undefined) entry.owner = entry.identity.owner;
			if (entry.ownerKey === undefined) entry.ownerKey = drainKey;
			self.trackOpenItem(entry.id, {
				ownerKey: entry.ownerKey, projectId: entry.projectId, owner: entry.owner, platform: entry.platform,
				// Its queue too: the look reads that queue's counters to know when to read it.
				queue: self._bgQueueOf(entry), uid: entry.identity.userId,
				kind: 'indexing', state: entry.status === 'running' ? 'running' : 'queued',
			});
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
			if (listingSettles && !entry.byListing) {
				entry.byListing = true;
				if (typeof entry.adoptedAt !== 'number') entry.adoptedAt = Date.now();
			}
			// A by-listing pass is never polled: the 10-second queue check settles it
			// (_settleByListing), so it neither waits in skapi-js's per-queue poll line nor
			// spends this budget.
			if (!entry.byListing && bgPollBudget > 0 && !self.isPollingPaused() && !self.historyItemPolls.has(entry.id) && typeof entry.poll === 'function') {
				bgPollBudget--;
				var capturedPlat = plat;
				var capturedEntry = entry;
				// When the worker BEGAN running this pass. It rides on the poll's status
				// envelope (a running tick), never on the terminal read, which hands back
				// the destination's own body. Captured here so a settled pass can show how
				// long it took WITHOUT a second request: the alternative is waiting for
				// whatever next refetches history, which for a pass that settles in front
				// of the user is not until they leave the chat and come back.
				var executedAt: number | undefined;
				var bp = entry.poll({
					latency: POLL_INTERVAL,
					// Status push (statusPushEnabled): a pass adopted from a listing is polled
					// slowly while frames arrive, like one this page dispatched. A dispatch
					// reply's poll decides that from the server's acknowledgement and
					// ignores this key.
					notify: statusPushEnabled(),
					onResponse: function (_res: any, meta: any) {
						if (meta && typeof meta.executed === 'number' && meta.executed > 0) executedAt = meta.executed;
					},
				});
				self._trackPoll(entry.id, 'bg', bp);
				self._settleBgOutcome(capturedEntry, capturedPlat, bp, function () { return executedAt; });
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


	/**
	 * Settle one background pass from the outcome of reading it: its poll (drainBgTaskQueue)
	 * or a single by-id lookup made by the 10-second queue check (_settleByListing). Both
	 * read the same row the same way, so they share this one path: the resolution, the
	 * resume/chain follow-up, the failure bubble and run record, and the queue entry's removal.
	 * A stopped poll (isPollStopped) leaves the bubble and the entry as they were.
	 */
	private _settleBgOutcome(entry: BgTaskEntry, plat: 'claude' | 'openai', outcome: Promise<any>, getExecutedAt: () => number | undefined): Promise<void> {
		var self = this;
		var capturedId = entry.id, capturedPlat = plat;
		var capturedEntry = entry;
		// The identity the entry was pinned to (drainBgTaskQueue pins it on first sight).
		var ctx: TerminalContext = {
			projectId: entry.projectId, platform: entry.platform,
			owner: entry.owner !== undefined ? entry.owner : (entry.identity ? entry.identity.owner : undefined),
			ownerKey: entry.ownerKey,
		};
		var wasStopped = false;
		// A read that failed on the way: the pass is left exactly as it was.
		var kept = false;
		var bgQueue = this._bgQueueOf(entry);
		return outcome.then(function (response: any) {
			// A stopped poll is not a result: leave the bubble and the queue entry
			// exactly as they were so resumePolling can re-attach.
			if (isPollStopped(response)) { wasStopped = true; return; }
			self.handleHistoryItemResolution(capturedId, response, capturedPlat, getExecutedAt(), ctx);
			// What follows from the settle SENDS or WRITES (the next pass of a file this
			// client drives, the run:: and done:: records), so it runs in one tab only:
			// the one holding the project's settle lock, once per pass across the tabs
			// (reconciler plan, section 3 item 8).
			var resumeKey = 'resume:' + capturedEntry.projectId + ':' + capturedId;
			// Already done for this pass (another tab, or this browser before a reload): the
			// chain's next step belongs to whoever did it. A kept chain still pointing at this
			// pass is let go of, so a run nobody continues is closed as lost when its queue
			// goes idle (_flipIfChainLost) rather than kept 'working'.
			if (sideEffectDone(resumeKey) && capturedEntry.storagePath) self._forgetChain(capturedEntry.projectId, capturedEntry.storagePath, capturedId);
			runSettleSideEffect(capturedEntry.projectId, bgQueue, resumeKey, function () {
				self.maybeResumeIndexing(capturedEntry, response, capturedPlat);
			});
		}, function (err: any) {
			// The READ's failure only, never a throw from the settle above: a TypeError
			// raised by code would otherwise read as a fetch failure (isTransportFailure)
			// and keep the pass waiting for good.
			self.historyItemPolls.delete(capturedId);
			var workerDriven = self._isWorkerDrivenIndexing(capturedEntry.filename, capturedEntry.mime);
			if (isNotExistsError(err)) {
				// The server removed the row: the pass is over, as a cancel. Its bubbles
				// settle as cancelled through the funnel (the request bubble keeps its file
				// markers, so the row still groups it).
				self.applyTerminal(capturedId, cancelledEnvelope(capturedId), ctx);
				if (!workerDriven) {
					self._flipRunRecord(capturedEntry, 'cancelled');
					self._nudgeIndexingDrain();
				}
				return;
			}
			if (isTransportFailure(err) || isAuthExpiredError(err)) {
				// A READ FAILED ON THE WAY, which says nothing about the pass: it may be
				// running, or finished. This used to write an error bubble and, for a file
				// this client drives, flip its run:: record to 'error' for good, on a pass
				// that had succeeded. Now nothing changes: no bubble, no record, and the
				// queue entry stays for the next look (or the next drain) to settle.
				// Not re-drained from here: an immediate re-attach would only spin while the
				// network is down.
				kept = true;
				console.warn('[chat-engine] a read of indexing pass ' + capturedId + ' failed on the way; left as it is', err);
				return;
			}
			// The server's own refusal of the read: shown on the pass, by id.
			self.applyTerminal(capturedId, pollErrorBody(err), ctx);
			// A pass that FAILED dispatches no continuation on any path, so a
			// CLIENT-driven file is finished either way — let a turn waiting on it
			// look now, and close its run record. Not for a worker-driven one: the
			// worker may have resolved that pass and written the next one regardless.
			if (!workerDriven) {
				self._flipRunRecord(capturedEntry, 'error', self._runErrorText(err));
				self._nudgeIndexingDrain();
			}
		}).catch(function (e: any) {
			// A throw inside the settle itself: logged, and the entry is released below as
			// for any settled pass.
			console.error('[chat-engine] settling indexing pass ' + capturedId + ' threw', e);
		}).then(function () {
			// Keep the queue entry when the poll was merely stopped, or resuming
			// would have nothing left to re-attach to; and when the read failed on the
			// way, since the pass is still unsettled.
			if (wasStopped || kept) return;
			var qi = self.bgTaskQueue.findIndex(function (q) { return q.id === capturedId; });
			if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
			// The project's last pass in this page settled: its records changed. A data hook,
			// so the records page refreshes with no chat view too (one tab: the settle lock).
			var refresh = chatEngineConfig().refreshRecords;
			if (typeof refresh === 'function' && !self.bgTaskQueue.some(function (q) { return !!q && q.projectId === capturedEntry.projectId; })) {
				runSettleSideEffect(capturedEntry.projectId, bgQueue, 'records:' + capturedEntry.projectId + ':' + capturedId, function () {
					try { refresh!(capturedEntry.projectId); } catch (e) { /* host hook */ }
				});
			}
			// This resolution freed a slot in the MAX_CONCURRENT_BG_POLLS budget,
			// so hand it to the next-oldest unpolled entry. Load-bearing under the
			// cap: with thousands of entries queued, only the handful holding
			// polls can ever settle, and without this re-drain the remaining
			// entries would sit unpolled forever. Not left to a host-side watcher
			// on bgTaskQueue — agent.vue has one, the widget does not.
			self.drainBgTaskQueue();
		});
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
			// A pinned entry carries its own project (the mint is addressed by it); the live
			// identity check stays only for an entry pushed without one.
			if (!entry.identity) {
				var id = this.host.getIdentity();
				if (!id || id.projectId !== entry.projectId) return;
			}
			var path = entry.storagePath;
			// One tab writes it (the settle lock), once per pass.
			// The hook's promise is returned: a failed write is written again (the settle
			// lock marks it done only once it worked).
			runSettleSideEffect(entry.projectId, this._bgQueueOf(entry), 'done:' + entry.projectId + ':' + path + ':' + entry.id, function () {
				return mint!({ service: entry.projectId, storagePath: path });
			});
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
		var projectId = entry.projectId, path = entry.storagePath;
		// Every ending of a run goes through here: its chain is not kept any more.
		this._forgetChain(projectId, path, entry.id);
		// One tab writes it (the settle lock), once per pass and status.
		// The write's promise is returned (report): a failed write is written again.
		runSettleSideEffect(projectId, this._bgQueueOf(entry), 'run:' + projectId + ':' + path + ':' + entry.id + ':' + status, function () {
			return upsertIndexRunRecordSafe(projectId, path, patch, { report: true });
		});
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
			// The identity the entry was PINNED to (reconciler plan, section 3 item 1), so a
			// project or platform switch while the pass ran does not end, or misdirect, the
			// chain. The live identity only for an entry nobody pinned, and only when it is
			// still the entry's project.
			var id = entry.identity && entry.identity.projectId === entry.projectId && entry.identity.platform === entry.platform
				? entry.identity : this.host.getIdentity();
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
			// The next pass of this file after THIS pass, sent once across the tabs: a second
			// tab settling the same pass (or this one settling it twice) sends nothing.
			if (!claimSideEffect('next:' + entry.projectId + ':' + entry.storagePath + ':' + entry.id)) return;
			this._sendNextIndexingPass(entry, id, pass, 0);
		} catch (e) { /* best-effort: resume must never break bg-task resolution */ }
	}

	/**
	 * Send the next pass of a client-driven file (maybeResumeIndexing) and follow it. A POST
	 * that failed on the way may still have been queued, so with a cref it becomes a pending
	 * send the discovery listing looks for on the bg queue: found, it is followed like any
	 * pass; not found by two complete listings, it is sent once more with a new cref. A
	 * refusal, a second miss, or no way to look for it (no cref, no batch reads) ends the
	 * chain: run:: says NEXT_PASS_NOT_SENT_TEXT.
	 */
	private _sendNextIndexingPass(entry: BgTaskEntry, id: ChatIdentity, pass: number, attempt: number): void {
		var self = this;
		var platform: 'claude' | 'openai' = id.platform === 'openai' ? 'openai' : 'claude';
		var canLook = this._recNewMode() && crefSupported();
		var cref = canLook ? newClientRef() : undefined;
		var queue = bgIndexingQueueName(id.userId || id.projectId, id.projectId);
		var follow = function (rid: string, status: string, poll: any) {
			for (var q = 0; q < self.bgTaskQueue.length; q++) if (self.bgTaskQueue[q] && self.bgTaskQueue[q].id === rid) return;
			self.bgTaskQueue.push({
				projectId: id.projectId, platform: platform, id: rid,
				identity: Object.assign({}, id), owner: id.owner, ownerKey: entry.ownerKey,
				filename: entry.filename, storagePath: entry.storagePath,
				isReindex: entry.isReindex, mime: entry.mime, size: entry.size,
				status: status === 'running' ? 'running' : 'pending',
				poll: poll, resumePass: pass,
				// Deliberately NOT stamped with entry.stageId. Only a batch's FIRST
				// pass anchors to the turn; a continuation appends, which is the
				// order the server queued it in and therefore the order
				// promoteNextBgQueuedToRunning should spin it in. It costs nothing
				// on screen: a continuation is folded into the run whose row
				// already sits above the turn, and renders nothing at its own
				// index (indexing_groups anchors a run at its FIRST loaded pass).
			});
			// Followed from here with or without a chat view (the drain needs one), and
			// kept for a reload (_persistChains, through the sync).
			self.noteBgQueueChanged();
			self.drainBgTaskQueue();
		};
		var giveUp = function () {
			self._flipRunRecord(entry, 'error', NEXT_PASS_NOT_SENT_TEXT);
			self._nudgeIndexingDrain();
		};
		// Counted as live work from here, not from the ack: awaitIndexingDrained
		// asks the SERVER what is queued, and this pass is not queued until the
		// call below returns. Without it a chat can slip in between two passes.
		this.trackIndexDispatch(notifyAgentContinueIndexing({
			platform: platform,
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
			cref: cref,
		}).then(function (ack: any) {
			if (ack && typeof ack.id === 'string') follow(ack.id, ack.status, ack.poll);
		}, function (e: any) {
			console.error('[chat-engine] resume-indexing dispatch failed', e);
			// The server's own refusal: nothing was queued, and sending it again would be
			// refused the same way.
			if (!cref || !isTransportFailure(e) || isNotExistsError(e)) { giveUp(); return; }
			self._recAddPendingSend({
				cref: cref, key: entry.ownerKey || chatCacheKey(id.projectId, platform, id.userId),
				projectId: id.projectId, owner: id.owner, platform: platform, queue: queue,
				// The pass that just settled is older than the one being looked for.
				watermark: entry.id, params: null, uid: id.userId, kind: 'indexing',
				onFound: function (row: any) { follow(row.id, row.status, undefined); },
				onMissing: function () {
					if (attempt < 1) self._sendNextIndexingPass(entry, id, pass, attempt + 1);
					else giveUp();
				},
			});
		}));
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
		var loadKey = chatCacheKey(id.projectId, id.platform, id.userId);
		if (token === undefined) token = this.state.gateRefreshToken;
		if ((this.state.loadingHistory && this.state.historyRequestToken === token) || id.platform === 'none' || !id.projectId) {
			return Promise.resolve();
		}
		// The same first page (same token) landed a moment ago: a chat view opening and the
		// reconciler's look of that same return both ask for it, and one read covers both
		// (plan 4b rule 2, returns never add work).
		if (!fetchMore && token === this._recFirstPageToken && this._recFirstPageDoneAt && nowMs() - this._recFirstPageDoneAt < CATCH_UP_MIN_GAP_MS) {
			return Promise.resolve();
		}
		this.state.historyRequestToken = token;
		this.state.loadingHistory = true;
		// A first page read now covers any reconciler look of this return (see
		// _recFirstPage), and records which token's first page is on the way.
		if (!fetchMore) { this._recFirstPageAt = nowMs(); this._recFirstPageToken = token; }
		// A first-page load is the one moment the chat may have changed under us. The
		// old snapshot describes the previous project's queue; keeping it would let a
		// row here claim it was finished on evidence from somewhere else. Re-seeded
		// when this load lands.
		if (!fetchMore && loadKey !== this._liveIndexKey) {
			this._liveIndexKey = loadKey;
			this._resetLiveIndexKeys();
		}
		if (fetchMore) this.state.loadingOlderHistory = true;
		// A first page replaces the messages, and with them any steps loaded into rows.
		if (!fetchMore) this.state.passPaging = {};
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
		var fetchHistory = function () {
			return getSplitChatHistory({
				service: projectId, owner: owner, platform: platform, userId: id.userId,
				// An anonymous visitor's history is scoped server side by
				// ip + "(" + user_agent + ")", which two devices behind one NAT
				// share. Read this device's own queue instead. See
				// scopeSurfaceToQueue.
				scopeSurfaceToQueue: !!id.anonymous,
				// Chats only when a file's row can load its own passes (lazyIndexRowsEnabled).
				skipBg: self.lazyIndexRowsEnabled(),
			}, options);
		};

		return Promise.resolve().then(fetchHistory).catch(function (err: any) {
			if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(fetchHistory);
			throw err;
		}).then(function (history: any) {
			if (token !== self.state.gateRefreshToken) {
				// Dropped: the token moved on while this page was on the way (a remount, a
				// project switch). Unless a first page for the current token has started
				// since, the read is owed, so the next look reads it instead of losing it.
				if (!fetchMore && self._recFirstPageToken !== self.state.gateRefreshToken) {
					self._recFirstPageOwed = true;
					self._recFirstPageAt = 0;
					self._recEnsure();
				}
				return;
			}
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
				// So the `_ownerKey` stamped on server history matches loadKey and
				// the cache key. Without it every mapped bubble carries a
				// two-segment stamp that no comparison can ever match.
				userId: id.userId,
				formatIndexingLabel: self.host.formatIndexingLabel,
			}).messages;
			// Re-apply any previously-hydrated compact bodies: a refresh maps
			// fresh stubs, and without this a bubble the user already expanded
			// would silently revert to its 200-char head.
			self.applyHydratedBodies(mapped);
			// AN UNKNOWN ANSWER NEVER OVERWRITES A KNOWN ONE. Before either merge
			// below, any page bubble whose row is terminal-but-empty takes the answer
			// the local list already holds for that turn (and its live state, if the
			// turn is still running). Without this, a refetch landing in the window
			// between a streamed row resolving and its finalize storing the body erases
			// the answer from the screen, on every streamed turn, since a refetch
			// fires on visibilitychange. See _adoptLocalAnswers.
			self._adoptLocalAnswers(mapped, loadKey);

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

			// AND AN UNKNOWN ANSWER LEFT OVER IS RESOLVED BY READING THE CHUNKS BACK.
			// Fired AFTER the page is rendered and the flags are cleared, never before:
			// a streamed turn nobody finalized is a turn whose answer is sitting in the
			// chunk store, and going to fetch it must not hold up the conversation it
			// belongs to. Bounded and serial: see _scheduleStreamRecovery.
			self._scheduleStreamRecovery(loadKey, platform, projectId, owner);

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
						userId: id.userId,
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
				// Set when the reconciler took over an item of this page (no poll).
				var followedByLook = false;
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
				// Attached OLDEST first. chatList is sorted newest first above, and an
				// older skapi-js (before 2.7.0) keeps its re-attached polls in the order
				// they start: newest first put the one row that can settle next (the
				// server runs a queue in order) at the back of the line.
				chatList.slice().sort(function (a: any, b: any) {
					var ai = typeof a.id === 'string' ? a.id : '', bi = typeof b.id === 'string' ? b.id : '';
					return ai < bi ? -1 : (ai > bi ? 1 : 0);
				}).forEach(function (item: any) {
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
					// Settled in this page already, and the merge kept the settled copy over
					// this (stale) page's waiting one: nothing is left to follow.
					if (self.isItemSettled(item.id) && !self._hasWaitingBubble(item.id, loadKey)) return;
					// Pinned NOW, from this load's own snapshot: every later settle of the
					// item uses this identity, never the one live when it ends.
					var itemCtx: TerminalContext = { ownerKey: loadKey, projectId: projectId, owner: owner, platform: platform, queue: item.queue_name };
					self.trackOpenItem(item.id, {
						ownerKey: loadKey, projectId: projectId, owner: owner, platform: platform, queue: item.queue_name,
						kind: item._isBgTask ? 'indexing' : 'chat', state: item.status === 'running' ? 'running' : 'queued',
						cref: typeof item.cref === 'string' ? item.cref : undefined, anonymous: !!id.anonymous, uid: id.userId,
					});
					// An indexing pass the worker drives is followed by the queue check, not
					// polled (see trackHistoryIndexPass).
					if (item._isBgTask && self.trackHistoryIndexPass(item)) return;
					// With the batch reads the reconciler follows it (one read per look for
					// every open item, and the one live reader of a streamed turn on screen):
					// no poll per request (plan 4b rule 1).
					if (self._recNewMode()) { followedByLook = true; return; }
					// (A guard here used to skip EVERY main-queue item while an immediate
					// dispatch was in flight, so as not to stack a second poll on the item
					// that dispatch was about to poll. The dispatch is over at its ack now,
					// and the registry check above skips exactly the ids already followed:
					// skipping the rest stranded any of them whose own poll had died.)
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
						// `meta.executed` rides on the poll's running ticks, so a pass this
						// path re-attached to (a reload or a remount while its chain was
						// still going) shows its duration at settle exactly as one polled
						// from the drain does. Without it, only passes started in this page
						// life would be stamped.
						onResponse: function (response: any, meta: any) {
							if (isPollStopped(response)) return;
							self.handleHistoryItemResolution(capturedId, response, platform, meta && meta.executed, itemCtx);
						},
						// Only the server's own answer changes the screen: NOT_EXISTS settles
						// the item as cancelled, a failure on the way leaves it as it is (the
						// next look settles it), and the read never sends anything again.
						onError: function (err: any) {
							self.onPollFailure(capturedId, err, itemCtx);
						},
					};
					var pp = isBg
						? item.poll(Object.assign({ latency: POLL_INTERVAL, notify: statusPushEnabled() }, pollOpts))
						// Pinned to the chat this LOAD is for, snapshotted at its start
						// (loadKey/platform/projectId/owner), never a live read: a load can
						// still be attaching polls after the user has moved on, and a stream
						// stamped with where they moved to would paint into that chat.
						: self._fgPollWithEarlyProbe(item, capturedId, pollOpts, {
							platform: platform, projectId: projectId, owner: owner, ownerKey: loadKey,
						});
					// Anything on the BACKGROUND queue is pausable, not just items whose
					// prompt text we recognise as an indexing task. _isBgTask vs
					// _isOnBgQueue is a DISPLAY distinction ("Indexing: file" vs a normal
					// chat bubble); keying the pause off _isBgTask alone left every
					// bg-queue item we could not text-match polling forever.
					self._trackPoll(capturedId, (item._isBgTask || item._isOnBgQueue) ? 'bg' : 'fg', pp);
					if (pp && pp.catch) pp.catch(function () { });
				});
				self.drainBgTaskQueue();
				// A look now, so a running streamed turn of this page gets its reader at once
				// rather than at the next tick (a look already running runs one more).
				if (followedByLook) void self._recSched().trigger('add');
			}

			// Learn which files the queue is still working on. Only on a FIRST page:
			// this describes the whole queue, not the page, so paging older history
			// would re-ask for an answer that has not changed.
			if (!fetchMore) self.refreshLiveIndexState();
			if (!fetchMore) self._recFirstPageDoneAt = nowMs();

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
			// A first page that failed on the way (the network still coming up after a
			// wake) is owed: the reconciler's next look reads it again, instead of the
			// return that asked for it being spent on a failure.
			if (!fetchMore && isTransportFailure(err) && token === self.state.gateRefreshToken) {
				self._recFirstPageOwed = true;
				self._recFirstPageAt = 0;
				self._recEnsure();
			}
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
	/**
	 * The user cancelled this chip's upload (the widget's per-chip x or "Cancel all
	 * uploads"). Stops the bytes now when they are moving (the host's abort), and
	 * leaves a flag every later step of uploadSingleAttachment checks, so a cancel
	 * that lands between steps (the get-signed-url round trip before the bytes, or
	 * the src:: record and the indexing request after them) still stops the file
	 * from being indexed and from being attached to the chat turn. A member whose
	 * indexing request has already gone out is past cancelling: it shows as an
	 * indexing row with its own Stop. Returns false for a chip that is not being
	 * uploaded by this session any more.
	 */
	cancelAttachmentUpload(att: any): boolean {
		if (!att || att._cancelled) return false;
		if (att.status !== 'uploading' && !att._batchId) return false;
		att._cancelled = true;
		if (typeof att._abort === 'function') { try { att._abort(); } catch (e) { } }
		return true;
	}

	// Upload one attachment (a file = 1 member, a folder = N) to db storage and
	// queue indexing per member. The bytes I/O + chip rendering go through host
	// hooks; the overwrite/reindex flow, status lifecycle, and indexing live here.
	uploadSingleAttachment(att: any, stageId?: string): Promise<Array<{ name: string; url: string; storagePath: string }>> {
		var self = this;
		var id = this.host.getIdentity();
		// Read BEFORE the status is reset below: a chip in "indexError" is one whose
		// bytes are already stored and only whose indexing failed. Its retry (the next
		// Send) re-indexes the stored copies through the "file is already there,
		// reindex it" path: no second upload, no "already exists" question about the
		// user's own file, no duplicate check (agent.vue isIndexRetry).
		var isIndexRetry = att.status === 'indexError';
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
		// Members answered by a file the user already has here (see findDuplicate
		// below). Counted so a folder chip can say how many it reused.
		var reusedCount = 0;
		att.reused = false;
		// Cancel bookkeeping (see cancelAttachmentUpload): which members' bytes are
		// confirmed stored and which have had their indexing request sent, so the
		// view can say honestly what a cancel did and did not undo. A retry starts
		// clean. `_cancelled` is NOT reset: a cancelled chip leaves the list and is
		// never retried, and a cancel that raced the start must still stop it.
		att._storedCount = 0; att._indexQueuedCount = 0; att._indexQueued = false;
		// The storage paths of NEW files (uploaded with the existence check, so no file was
		// there before) whose bytes reached storage, or may have (the abort came after the
		// whole body was sent), and whose indexing request has not gone out. A cancel hands
		// them to the host (att._onCancelSettled) so it can take the stored bytes back. A
		// replaced file (Overwrite) is never listed: removing it would lose the user's file.
		att._landedNew = [];
		var cancelError = function (): Error {
			var e: any = new Error(UPLOAD_CANCELLED_MESSAGE);
			e.code = 'CANCELLED';
			return e;
		};
		var checkCancel = function (): void { if (att._cancelled) throw cancelError(); };
		// The members skipped as duplicates, with the STORED copy each one matched, so
		// the host can report them after the send and offer to reindex the stored
		// copies (reindexStoredFiles). A retry decides afresh.
		delete att.duplicates;
		var chain: Promise<any> = Promise.resolve();
		// "Already uploaded by this user, same name and size" -> the stored copy's
		// storage path, else null. Asked only while the skip-duplicates switch
		// resolves ON (the project's setting is the ceiling, the host may only
		// restrict), and only of a host that wired the hook. Every failure is null,
		// so this can save an upload and an indexing run but never block one.
		var findDuplicate = function (member: any): Promise<string | null> {
			if (typeof self.host.findDuplicateUpload !== 'function') return Promise.resolve(null);
			var storedName = String(member.storagePath || '').split('/').filter(Boolean).pop() || member.file.name;
			return resolveSkipDuplicateFiles(id.projectId).then(function (on) {
				if (!on) return null;
				return Promise.resolve(self.host.findDuplicateUpload!({ name: storedName, size: member.file.size }))
					.then(function (hit: any) {
						return hit && typeof hit.storagePath === 'string' && hit.storagePath ? hit.storagePath : null;
					});
			}).catch(function () { return null; });
		};
		members.forEach(function (member: any, idx: number) {
			chain = chain.then(function () {
				// Cancelled while an earlier member of this folder was uploading: the
				// rest are never started.
				checkCancel();
				var hadExists = false;
				var skipped = false;
				// Overwrite of an original: its linked copies, read before the reset and
				// sent again once this member is queued (collectLinkedCopies).
				var promotion: Promise<{ original: string; copies: string[] }[]> | null = null;
				// The storage path of the file this member DUPLICATES, when the user
				// already has it here: nothing is uploaded or indexed for it, and the
				// turn takes the stored copy's url instead.
				var duplicateOf: string | null = null;
				// True when the file already existed and we are re-indexing over it
				// (user chose Reindex, OR Overwrite replaced the bytes). Drives the
				// delete-then-repost of the stale "src::" record below. Kept separate
				// from hadExists, which must keep driving ONLY the Reindexing/Indexing
				// label (isReindex) — overwrite still labels as "Indexing:".
				var existedBefore = false;
				// This upload made a NEW file's record (the no-access retry of the url
				// mint, or the step before the indexing request): a cancel that lands
				// after it drops that record again.
				var madeRecord = false;
				// Every byte of this member's body was handed to the network: an abort after
				// this point may come too late to keep the object out of storage.
				var sentAll = false;
				var onProg = function (p: any) {
					if (p && p.total && p.loaded >= p.total) sentAll = true;
					if (p && p.total) {
						att.progress = Math.floor(((idx + p.loaded / p.total) / total) * 100);
						self.host.renderAttachmentChips();
					}
				};
				var doMemberUpload = function (checkExistence: boolean) {
					// Cancelled during the EXISTS prompt or between members: no bytes.
					checkCancel();
					sentAll = false;
					return self.host.uploadFile({
						file: member.file, storagePath: member.storagePath, checkExistence: checkExistence,
						onProgress: onProg,
						// The host hands its abort over just before the bytes start. A
						// cancel made during the get-signed-url round trip had nothing to
						// abort yet, so it is applied here, before anything is sent: a
						// storage POST that never completes leaves no object behind.
						setAbort: function (abort) {
							att._abort = abort;
							if (att._cancelled) { try { abort(); } catch (e) { } }
						},
					}).then(function (r: any) {
						att._abort = null;
						att._storedCount = (att._storedCount || 0) + 1;
						if (checkExistence) att._landedNew.push(member.storagePath);
						return r;
					}, function (err: any) {
						att._abort = null;
						// An abort the user asked for reads as the cancel it is, not as
						// a failed upload.
						if (att._cancelled) {
							if (checkExistence && sentAll) att._landedNew.push(member.storagePath);
							throw cancelError();
						}
						throw err;
					});
				};
				if (isIndexRetry) { hadExists = true; existedBefore = true; }
				return (isIndexRetry ? Promise.resolve(null) : findDuplicate(member)).then(function (dup) {
					if (isIndexRetry) return;
					if (dup) {
						duplicateOf = dup;
						console.log('[chat-engine] skipping an upload the user already has:', member.storagePath, '->', dup);
						return;
					}
					return doMemberUpload(true);
				}).catch(function (err: any) {
					var code = err && (err.code || (err.body && err.body.code));
					var msg = err && (err.message || (err.body && err.body.message) || (typeof err === 'string' ? err : ''));
					var isExists = code === 'EXISTS' || (msg && /exist/i.test(msg));
					if (!isExists) throw err; // a member upload failed → whole attachment fails (red)
					return self.host.promptOverwrite(member.file.name).then(function (choice) {
						if (choice === 'overwrite') {
							existedBefore = true;
							// One shared index for identical files: if this file is an ORIGINAL,
							// its linked copies lose their index with its old bytes. Read now,
							// before the reset; sent again once this file is queued.
							promotion = self.collectLinkedCopies([member.storagePath]);
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
					// Cancelled while the bytes were finishing or during the EXISTS
					// prompt: no url, no file record, no indexing request.
					checkCancel();
					if (skipped) return; // user skipped this member — no url, no index request
					// A duplicate takes the STORED copy's url: the same reuse an EXISTS
					// answer gets when the user keeps the file, minus the prompt and
					// minus the re-index.
					return Promise.resolve(self.host.getTemporaryUrl(duplicateOf || member.storagePath)).catch(function (err: any) {
						// A file nobody has indexed yet is readable by the project OWNER only
						// (the store's access rule), so for any other uploader the link to the
						// file they just uploaded is refused ("No access to this file.") and the
						// file could never be indexed. Its file record makes it a file of the
						// uploader's chosen group, which they can read: create it now (the step
						// below would have created the same record a moment later, and a second
						// create is refused harmlessly) and ask again.
						var ecode = err && (err.code || (err.body && err.body.code));
						var emsg = String((err && (err.message || (err.body && err.body.message))) || err || '');
						var refused = /no access to this file/i.test(emsg) || (ecode === 'INVALID_REQUEST' && /access/i.test(emsg));
						if (duplicateOf || !refused || typeof self.host.ensureFileIndexRecord !== 'function') throw err;
						madeRecord = !existedBefore;
						return Promise.resolve(self.host.ensureFileIndexRecord(member.storagePath, {
							name: member.file.name, mime: member.file.type || self.host.getMimeType(member.file.name), size: member.file.size,
						})).then(function () { return self.host.getTemporaryUrl(member.storagePath); });
					});
				}).then(function (url: string) {
					// Cancelled during the url mint. For an uploader who is not the
					// project owner the mint above made the file record first (the
					// no-access retry); a file this upload created must not keep it.
					if (att._cancelled) {
						var dropEarly = (madeRecord && typeof self.host.deleteExistingFileRecord === 'function')
							? Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function () { })
							: Promise.resolve();
						return dropEarly.then(function () { throw cancelError(); });
					}
					if (skipped) return; // guard the indexing branch for a skipped member
					if (duplicateOf) {
						urls.push({ name: member.relPath, url: url, storagePath: duplicateOf });
						if (!att.duplicates) att.duplicates = [];
						att.duplicates.push({
							label: member.relPath,
							storagePath: duplicateOf,
							name: member.file.name,
							size: member.file.size,
							mime: member.file.type || self.host.getMimeType(member.file.name) || undefined,
						});
						reusedCount += 1;
						if (att.kind !== 'folder') { att.uploadedUrl = url; att.storagePath = duplicateOf; att.reused = true; }
						else att.reusedCount = reusedCount;
						self.host.renderAttachmentChips();
						return; // not indexed: the stored copy already is
					}
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
					// The group the file's EXISTING src:: record is at, read BEFORE the
					// delete below destroys it: a re-index or an overwrite keeps the file's
					// visibility instead of re-deciding it (host.readFileAccessGroup).
					var existingGroup: 'public' | 'authorized' | 'private' | null = null;
					// True once the old index of a file that was already here has been
					// cleared. A cancel that lands BEFORE that leaves the old index as it
					// is (a file the user chose to keep and Reindex must not end up with
					// no index at all because the reindex was cancelled); one that lands
					// after it still re-creates the file record, which describes a file
					// that is stored either way.
					var clearedOld = false;
					var preIndex = self.claimIndexRun(member.storagePath).then(function (claimed) {
						alreadyIndexing = !claimed;
						if (alreadyIndexing) {
							console.log('[chat-engine] skipping a duplicate index request for', member.storagePath);
							return;
						}
						if (!existedBefore || att._cancelled) return;
						var readGroup = typeof self.host.readFileAccessGroup === 'function'
							? Promise.resolve(self.host.readFileAccessGroup(member.storagePath)).then(function (g) { existingGroup = g || null; }, function (err: any) {
								// Unknown is not "no group": deleting now would destroy the only
								// record of it. Fail this member (the chip turns red and can be
								// retried) and hand the claim back so the retry is not refused.
								self.releaseIndexRun(member.storagePath);
								throw err;
							})
							: Promise.resolve();
						return readGroup.then(function () {
							if (att._cancelled) return;
							if (typeof self.host.deleteExistingFileRecord === 'function') {
								clearedOld = true;
								return Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function () { });
							}
						});
					});
					preIndex = preIndex.then(function () {
						if (alreadyIndexing) return;
						// Cancelled before anything was cleared: no record to make (the
						// cancel below drops any made early for a new file).
						if (att._cancelled && !clearedOld) return;
						if (typeof self.host.ensureFileIndexRecord !== 'function') return;
						if (!existedBefore) madeRecord = true;
						return Promise.resolve(self.host.ensureFileIndexRecord(member.storagePath, {
							name: member.file.name,
							mime: mime || undefined,
							size: member.file.size,
						}, existingGroup || undefined)).catch(function () { });
					});
					// The access group the host actually recorded this file at. Read
					// AFTER ensureFileIndexRecord so the value here is the one the
					// "src::" record really carries, never a second guess at it.
					var accessGroup: 'public' | 'authorized' | 'private' | undefined;
					preIndex = preIndex.then(function () {
						if (alreadyIndexing) return;
						if (existingGroup) { accessGroup = existingGroup; return; }
						if (typeof self.host.uploadAccessGroup !== 'function') return;
						return Promise.resolve(self.host.uploadAccessGroup(member.storagePath))
							.then(function (g) { accessGroup = g || undefined; })
							.catch(function () { });
					});
					// Cancelled while the file record was being made: hand the indexing
					// claim back and, for a file this upload created, drop the record
					// that was just made for it, so nothing points at a file the user
					// took back. A file that was already here keeps its record (it
					// still describes a stored file).
					var abandonIfCancelled = function (): Promise<void> | void {
						if (!att._cancelled) return;
						if (!alreadyIndexing) self.releaseIndexRun(member.storagePath);
						var drop = (!existedBefore && !alreadyIndexing && madeRecord && typeof self.host.deleteExistingFileRecord === 'function')
							? Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function () { })
							: Promise.resolve();
						return drop.then(function () { throw cancelError(); });
					};
					return preIndex.then(function () {
						return abandonIfCancelled();
					}).then(function () {
						// Run a client-side attachment parser (e.g. .hwp) if one matches; its
						// output is inlined into the indexing request (falls back to office
						// extraction / web_fetch when no parser matches or it yields nothing).
						return parseAttachmentContent(member.file, member.file.name, mime || undefined);
					}).then(function (parsedContent: string | null) {
						return Promise.resolve(abandonIfCancelled()).then(function () { return parsedContent; });
					}).then(function (parsedContent: string | null) {
					if (alreadyIndexing) return;
					// Past this point the file is on the indexing queue, and a cancel can
					// no longer take it back: the row it gets has its own Stop. Told to
					// the view so it stops offering a cancel it cannot honour.
					att._indexQueuedCount = (att._indexQueuedCount || 0) + 1;
					if (att.kind !== 'folder') att._indexQueued = true;
					// Queued for indexing: no longer a cancelled upload to take back.
					att._landedNew = (att._landedNew || []).filter(function (p: string) { return p !== member.storagePath; });
					self.host.renderAttachmentChips();
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
							accessGroup: accessGroup,
						},
						parsedContent: parsedContent || undefined,
					}).then(function (ack: any) {
						if (ack && typeof ack.id === 'string') {
							self.bgTaskQueue.push({
								projectId: id.projectId, platform: id.platform as 'claude' | 'openai', id: ack.id,
								identity: Object.assign({}, id), owner: id.owner,
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
							// Followed with or without a chat view (the drain needs one).
							self.noteBgQueueChanged();
							self.drainBgTaskQueue(); // surface "Indexing: <file>" as soon as THIS file uploads
							// an overwritten original's copies, after the file itself
							if (promotion) {
								var plan = promotion;
								promotion = null;
								plan.then(function (pl) { return self.promoteLinkedCopies(pl); }).catch(function () { });
							}
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
			// Cancelled after its last member's indexing request went out (a folder
			// whose cancel came too late for every member): the turn still must not
			// carry its urls. The members already queued keep their rows and Stop.
			checkCancel();
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
				// "indexError" is NOT collected as-is: its upload worked but its indexing
				// did not, and uploadSingleAttachment retries just the indexing.
				if (att.status === 'done') {
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
					// Cancelled by the user: none of its urls reach the chat turn, and
					// it is not a failure to report or retry.
					if (att._cancelled || isUploadCancelledError(err)) {
						att.status = 'cancelled';
						att._abort = null;
						self.host.renderAttachmentChips();
						// The chip's upload has fully stopped: tell the host which new
						// files' bytes reached storage (or may have) so it can take them
						// back. Set by the host when it cancelled; optional.
						if (typeof att._onCancelSettled === 'function') {
							try { att._onCancelSettled((att._landedNew || []).slice()); } catch (e) { }
						}
						return;
					}
					if (removed || aborted) return;
					att.status = 'error';
					att.errorMessage = 'File upload has failed';
					// Preserve the original error code/message for the report dialog.
					att.errorCode = (err && (err.code || (err.body && err.body.code))) || '';
					att.errorDetail = (err && (err.message || (err.body && err.body.message))) || (typeof err === 'string' ? err : '');
					self.host.renderAttachmentChips();
				}).then(function () {
					// This batch is done with the chip (whatever came of it), so a view
					// stops offering to cancel its upload while the rest of the batch
					// runs. Keyed by batch: a failed chip handed back and sent again
					// is in flight once more.
					att._settledBatch = att._batchId || true;
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
