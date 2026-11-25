/**
 * Engine configuration / dependency injection.
 *
 * The engine is framework- and transport-agnostic: it never imports a skapi
 * instance or `import.meta.env`. Each consumer calls `configureChatEngine()`
 * once at startup to inject the skapi transport functions, the MCP base URL,
 * and (optionally) the `poll` value to attach to every forwarded request.
 *
 * Why `poll` is configurable: agent.vue uses the npm-bundled skapi-js and OMITS
 * `poll` (its request auto-resolves with the final body), whereas
 * the BunnyQuery widget uses the deployed skapi-js@latest and must pass
 * `poll: 0` to get the early ack + a manual `.poll()` handle (needed for queued-
 * send cancel). So the request builders include `poll` only when it is set.
 *
 * THE TRANSPORT IS THE forwardRequest FAMILY ONLY (owner, 2026-11-20: clientSecretRequest
 * is being deprecated). The old `clientSecretRequest*` keys are no longer read: a host
 * injects `forwardRequest`, `forwardRequestHistory` and, to stream,
 * `forwardRequestFinalize` and `forwardRequestStream`, all from skapi-js 2.1.0 or newer.
 * Every call goes through the resolveForwardRequest* functions below.
 */

import { type AttachmentParser, registerAttachmentParser } from './attachment_parsers';
import { cachedProjectSettings, loadProjectSettings, webAccessFrom, skipDuplicateFilesFrom, answerModeFrom, type AnswerMode } from './project_settings';

/**
 * One report about a turn that is streaming, as handed to `onLiveStreamUpdate`.
 *
 * Deliberately a flat snapshot rather than the SseParser itself: the hook is a
 * VIEW seam, and handing a client the parser would invite it to drive the stream
 * (feed it, end it, read the assembled body) behind the session's back.
 */
export interface LiveStreamUpdate {
    /** Server item id of the turn, the same id its bubbles carry as _serverItemId. */
    serverItemId: string;
    /** History cache key (`projectId#platform`) the turn belongs to. A host that
     *  renders several projects must ignore an update for a chat it is not showing. */
    ownerKey: string;
    /** 'start' on the first paint, 'update' on every later one, 'end' once the
     *  stream is over and nothing more will be painted - whether because the turn
     *  settled (its authoritative answer is about to replace the live text) or
     *  because it was stopped. 'end' is only sent to a host that was told 'start'. */
    phase: 'start' | 'update' | 'end';
    /** Answer text so far, already trimmed to a safe reveal boundary: it never
     *  ends inside a half-arrived link, fence or url. Empty on 'end'. */
    text: string;
    /** Extended-thinking text so far. Separate from `text` and never part of it. */
    thinkingText: string;
    /** Tools reached for, in order of appearance, duplicates kept. */
    toolNames: string[];
    /** A terminal event arrived. False on 'end' means the stream was cut. */
    complete: boolean;
    /** The terminal event that arrived meant the answer FINISHED rather than DIED:
     *  false while running, false on a cut stream, and false when the stream ended
     *  on a provider error. `complete` answers "is anything more coming?"; this one
     *  answers "is this the whole answer?", and they differ on exactly the case
     *  that costs text - an `error` frame is terminal and truncating at once. A host
     *  drawing a "partial answer" affordance wants THIS one. Added after `complete`
     *  and always present: a host that ignores it reads as it did before. */
    answerComplete: boolean;
    /** The stream ended in a provider error. */
    errored: boolean;
    /** How many chunks of this turn each of skapi's two transports carried FIRST:
     *  `socket` for the websocket relay, `poll` for the chunk-table read. Both feed
     *  the same sink by design, so a turn that streamed perfectly over the socket
     *  and one that was polled the whole way are otherwise indistinguishable. A
     *  host that does not care can ignore it; a host showing a live/degraded
     *  indicator, or just logging which path it got, reads this. */
    transport: { socket: number; poll: number };
}

/** The finalize call, identical under its new and its deprecated key. */
type ForwardRequestFinalizeFn = (
    requestId: string,
    data: any,
    options: { url: string; method: string; service?: string; owner?: string; ifAbsent?: boolean },
) => Promise<any>;

/** The chunk read-back call, identical under its new and its deprecated key. */
type ForwardRequestStreamFn = (
    requestId: string,
    options: {
        url: string;
        method: string;
        onStream?: (chunk: string, seq: number) => void;
        since?: number;
        poll?: number;
        service?: string;
        owner?: string;
    },
) => Promise<any>;

export interface ChatEngineConfig {
    /**
     * skapi.forwardRequest, bound to the consumer's skapi instance.
     *
     * The engine always calls it as `forwardRequest(null, opts)`. Null because it
     * never has a form: every request it builds carries its whole body in
     * `opts.data`, the `_skapi_*` directives included, and the stored secret is
     * named with `secretName`.
     *
     * INJECT IT ONLY FROM AN SKAPI-JS THAT HAS THE WHOLE FORWARDREQUEST FAMILY. An
     * older skapi-js also has a method called forwardRequest, taking the same two
     * arguments, and it is a different thing entirely: the retired streaming
     * forwarder, which posts to another endpoint and never queues, so a chat turn
     * handed to it goes somewhere else and comes back as nothing the engine can
     * read. A host that cannot be sure which skapi-js it holds (the widget, which
     * is given the embedder's) decides by a companion only the new SDK has,
     * `forwardRequestHistory`, and never by this method's presence.
     *
     * Required. See resolveForwardRequest.
     */
    forwardRequest?: (form: any, opts: any) => Promise<any>;
    /**
     * skapi.forwardRequestHistory, bound to the consumer's skapi instance. Required.
     */
    forwardRequestHistory?: (params: any, fetchOptions: any) => Promise<any>;
    /** MCP server base URL (prod vs dev resolved by the consumer). */
    mcpBaseUrl: string;
    /**
     * Value to attach as `poll` on every forwarded request. When `undefined`
     * the `poll` key is omitted entirely (agent.vue). BunnyQuery sets `0`.
     */
    poll?: number;
    /**
     * Optional client-side attachment parsers (e.g. an .hwp parser). Each is
     * registered at configure time; more can be added later via
     * `registerAttachmentParser()`. See attachment_parsers.ts.
     */
    attachmentParsers?: AttachmentParser[];
    /**
     * Opt in to SERVER-DRIVEN windowed indexing for text/grid files.
     *
     * Off by default, and deliberately so. When on, the client emits a
     * `_skapi_window` directive and the WORKER reads the file one window at a time,
     * continuing until the reader says it is exhausted. When off, the agent pages the
     * file itself with readFileContent, exactly as before.
     *
     * The flag exists because the backend must ship FIRST: a client emitting the
     * directive against a worker that does not strip it leaves an unknown field in the
     * request body, and the provider rejects the whole call with no retry. Keep it off
     * until the worker is deployed, then flip it per environment.
     */
    windowedIndexing?: boolean;
    /**
     * The worker writes the ending (done:: and run::) of a file read in ONE pass (an image,
     * or any file not rendered, windowed or paged), as it does for paged chains: the engine
     * then no longer marks such a run "Indexing stopped ... (the page was closed)" when no
     * page here kept its chain. The engine always sends the request flag (index_end); this
     * switch only stops the client-side "lost" verdict. Turn it on only once every region's
     * worker and polling-recovery Lambda carry the 2026-11-25 change: with an older worker
     * a page closed mid-pass would leave the run 'working'. Off unless true.
     */
    workerIndexEndings?: boolean;
    /**
     * Mint the durable "indexing finished" marker record ("done::<path>",
     * reference "src::<path>", table __INDEXING__ — same shape the backend
     * worker writes via /internal/index-complete) for runs whose completion
     * THIS CLIENT knows deterministically: a single-pass file's settled pass,
     * or a client-driven chain whose reply carried the completion token.
     * Worker-driven chains are NOT minted from the client (their completion is
     * only ever inferred here); the worker writes their marker itself.
     * Must be best-effort: tolerate the marker already existing and never
     * throw. Optional so older consumers keep the pre-marker inference.
     * May return a promise that rejects when the write failed (not for "already
     * there"): the engine then writes it again, a few times, with backoff.
     */
    mintIndexDoneMarker?: (info: { service: string; storagePath: string }) => void | Promise<unknown>;
    /**
     * Create-or-update the per-file indexing RUN record ("run::<path>",
     * reference "src::<path>", table __INDEXING__). The record is the durable
     * "a run exists and this is its status" signal that lets chat rows and
     * files-page badges paint without scanning bg history.
     *
     * The consumer implements upsert semantics (the records API has none):
     * create, and on "is already taken" look the record up by unique_id and
     * re-post with its record_id, merging `patch` over the stored data.
     * Status precedence is the consumer's job too: 'working' must NEVER
     * overwrite a terminal status (done/error/cancelled) — a late create from
     * a slow enqueue must not resurrect a run another writer already closed.
     * Must be best-effort and never throw. Optional: without it the engine
     * behaves exactly as before (legacy scan/probe path). May return a promise
     * that rejects when the write failed: the engine then writes it again, a few
     * times, with backoff.
     */
    upsertIndexRunRecord?: (info: {
        service: string;
        storagePath: string;
        patch: {
            status: 'working' | 'done' | 'error' | 'cancelled';
            filename?: string;
            started?: number;
            finished?: number;
            error?: string;
            queue?: string;
        };
    }) => void | Promise<unknown>;
    /**
     * Deliver each relayed chunk over skapi's WEBSOCKET as well, so text lands as it
     * is relayed instead of on the next poll tick. Off unless a host asks.
     *
     * Streaming itself is not a choice any more: the engine streams every chat turn
     * whenever the host handed over the two streaming hooks below
     * (`forwardRequestFinalize` and `forwardRequestStream`, or their deprecated
     * names), and a host that wants buffered replies simply hands over neither. See
     * liveStreamingEnabled(). This key only decides the TRANSPORT of a stream that is
     * on anyway, so a host with no streaming hooks gets nothing from setting it.
     *
     * Off by default on purpose, and the reason is not risk to the chat (the socket
     * is a pure accelerator with a safe fallback: the poll carries the read), it is
     * what it does to the HOST'S OWN realtime. skapi's joinRealtime REPLACES the
     * connection's group rather than adding to it, so for the length of a turn this
     * takes the room. The dashboard owns its skapi instance and uses realtime for
     * nothing else, so it opts in. The embeddable widget is handed the EMBEDDER'S
     * instance and cannot know what their app does with it, so it stays off there
     * unless the embedder turns it on.
     *
     * Until 1.16.0 this key meant "stream at all" and the socket was
     * `liveStreamingRealtime`; that name is now ignored.
     */
    liveStreaming?: boolean;
    /**
     * Request STATUS PUSH over skapi's websocket (skapi-js 2.5.0 or newer, plus the
     * backend that knows `notify`). Indexing passes are dispatched with `notify: true`,
     * their polls then read the row once a minute instead of every few seconds while
     * status frames are arriving, and read it at once when a frame names them. The
     * engine also listens with `onRequestStatus` while a chat view is open: a frame for
     * a pass it holds nothing for picks that pass up, and a (re)connected socket runs
     * the return catch-up (ChatSession.catchUpHistory), since frames sent while it was
     * down are lost.
     *
     * Off by default for the same reason as `liveStreaming`: it keeps a websocket open
     * on the host's skapi instance. The dashboard owns its instance and opts in; the
     * widget leaves it to the embedder. Needs `onRequestStatus` below too: without it,
     * or on an older skapi-js, nothing changes. Every frame is a hint: polls and
     * listings still decide every status on screen.
     */
    statusPush?: boolean;
    /** skapi.onRequestStatus, bound to the consumer's skapi instance (skapi-js 2.5.0+). */
    onRequestStatus?: (callback: (event: any) => void) => () => void;
    /** skapi.isRequestStatusLive, bound to the consumer's skapi instance (skapi-js 2.5.0+). */
    isRequestStatusLive?: () => boolean;
    /**
     * Whether a CHAT answer may reach the open web: Claude's `web_fetch` and
     * OpenAI's `web_search` are attached to a chat request only when this
     * resolves to true.
     *
     * OPTIONAL. The project's own setting (`web_access` in the `bq::settings`
     * record, see project_settings.ts; off unless the owner turned it on) is the
     * CEILING, and this option may only restrict below it:
     *     effective = projectSetting && webAccess !== false
     * So `false` here turns the web off for this page whatever the project says,
     * and `true` or unset follows the project. A value above the project setting
     * has no effect: the owner's switch is what lets an answer out onto the web.
     *
     * Chat turns only. An indexing pass keeps the tools it has today, since the
     * worker hands it rendered pages and extracted text and not a URL to fetch.
     */
    webAccess?: boolean;
    /**
     * Whether a chat attachment that the signed-in user already uploaded to this
     * project (same file name, same size, same uploader) is SKIPPED: not uploaded
     * again, not indexed again, the turn using the stored copy's url. Same
     * ceiling rule as `webAccess`, against the project's `skip_duplicate_files`
     * setting, which is ON unless the owner turned it off:
     *     effective = projectSetting && skipDuplicateFiles !== false
     * `false` here lets this page re-upload duplicates on a project that skips
     * them; `true` or unset follows the project. See duplicates.ts for the check.
     */
    skipDuplicateFiles?: boolean;
    /**
     * Reuse the MCP tool listing OpenAI returned on an earlier CHAT turn of this page
     * (OpenAI only). With it, the next chat request carries OpenAI's own
     * `mcp_list_tools` item and OpenAI skips asking the MCP server for its tools again
     * (four sequential requests, about 0.6 s before the model starts).
     *
     * OFF unless set to `true` (the widget and bunnyquery.com set it; verified on a live
     * OpenAI chat 2026-11-25). An account that refuses the item fails one turn, after
     * which reuse stays off for that project in this browser. Costs when on: each
     * reused turn's request body, and so its stored history row, is about 31 to 34 KB
     * larger (the tool list), which also comes back with every history page.
     * Claude turns and indexing passes never use it. See requests.ts ChatTurnContext.
     */
    reuseMcpToolList?: boolean;
    /**
     * skapi.forwardRequestFinalize, bound to the consumer's skapi instance.
     * Stores the version of a streamed turn that history should keep (the engine
     * sends the ASSEMBLED provider body, so history reads it exactly as it reads
     * a buffered turn) and releases that request's chunks. Optional: a host
     * without it can still stream, it just leaves the chunks and an empty row.
     */
    forwardRequestFinalize?: ForwardRequestFinalizeFn;
    /**
     * skapi.forwardRequestStream, bound to the consumer's skapi instance.
     *
     * THE SECOND HALF OF THE DURABILITY GUARANTEE, and without it a streamed turn
     * is only as durable as the tab that started it. A streamed row settles with a
     * status and NO body; the answer is stored as chunks until
     * forwardRequestFinalize says what to keep. A row that settles while no
     * poll is attached (the user closed the tab, a mobile browser discarded it,
     * the device slept and the interval stopped) is therefore never finalized, and
     * a later history load sees a terminal row with no body and used to emit no
     * assistant bubble at all: the answer simply gone from the conversation, with
     * every byte of it still sitting in the chunk table.
     *
     * This is the documented way back to it. Given the request id it fetches every
     * chunk of an already-finished turn in one pass (paging internally on `more`)
     * and delivers them in order through `onStream`, then resolves. The engine
     * feeds those into a fresh SSE parser and treats the assembled body exactly as
     * it treats a live one, including finalizing it, which stores the answer as
     * ordinary history and releases the chunks, so each row is recovered at most
     * once ever.
     *
     * Optional. Without it the engine still marks such turns (`_streamPending` on
     * the bubble) but has no way to read them back, so a host that ignores this
     * behaves as it does today.
     *
     * NOTE THAT THIS HOOK, NOT `liveStreaming`, IS WHAT ARMS RECOVERY. See
     * streamRecoveryEnabled() below for why the two decisions are separate.
     */
    forwardRequestStream?: ForwardRequestStreamFn;
    /**
     * Observation hook for a live-streaming turn, called at most once per paint
     * (about once a second) plus once when the turn settles.
     *
     * The engine already paints the answer text into the pending bubble itself,
     * so a host needs this ONLY for the affordances the engine deliberately does
     * not decide the presentation of: a "thinking..." line, or a "querying sales
     * table..." row drawn from the tools the model reached for before any answer
     * text exists. Optional, and a host without it behaves exactly as today.
     *
     * Never throw from it: it is called on the paint path and a throw would cost
     * the user the rest of their answer. The engine guards it anyway.
     */
    onLiveStreamUpdate?: (update: LiveStreamUpdate) => void;
    /**
     * Force the read-back of already-streamed turns OFF, even though the chunk
     * reader is injected.
     *
     * There is no need to set it to turn recovery ON: injecting
     * `forwardRequestStream` is what arms it (see streamRecoveryEnabled).
     * This exists only as the way back out for a host that wants byte-for-byte the
     * pre-recovery rendering of a terminal-but-empty row - no bubble, no marker, no
     * chunk read - while keeping the reader available for its own use. Omit it and
     * nothing changes.
     */
    streamRecovery?: boolean;
    /**
     * Single-item csr-poll point lookup (skapi.util.request('csr-poll', {id,
     * service, owner}, {auth:true})). For a RESOLVED item the backend returns
     * the provider response body itself; for a failed one, the resolved error.
     * Used by ChatSession.hydrateCompactItems to fetch the real bodies of
     * compact history stubs when the user expands an indexing row. Optional:
     * without it, stubs keep their server-extracted heads.
     */
    csrHistoryItemLookup?: (fullId: string, service: string, owner: string) => Promise<any>;
    /**
     * Read a document's page progress: the `data` of its "prog::<storagePath>" record
     * ({ pages_saved, pages_total }), which the MCP keeps while the document's pages are
     * saved, or null when there is none. Optional: without it a row shows passes only.
     * Asked by the 10-second queue check for files still being indexed.
     */
    readIndexProgress?: (service: string, storagePath: string) => Promise<{ pages_saved?: number; pages_total?: number | null } | null>;
    /**
     * The request ids of one file's indexing passes: the unique ids "pass::<storagePath>#<id>"
     * the worker writes as each pass starts (getUniqueId, prefix "pass::<storagePath>#", every
     * page), answered as the ids after "#" in any order. With it (and csrHistoryItemLookup) the
     * chat history fetches the CONVERSATION only and a file's row loads its passes when opened
     * (ChatSession.loadRunPasses). Without it the history pages the indexing queue as before.
     */
    listIndexPasses?: (service: string, storagePath: string) => Promise<string[]>;
    /**
     * THE RECONCILER'S READS (reconciler plan, section 3; skapi-js 2.7.0 or newer). All
     * three are optional, and a host hands over only what its skapi-js has: with
     * `forwardRequestStatus` AND `forwardRequestRead` the engine follows every waiting
     * item with one batch read per look (ChatSession's reconciler) instead of one poll
     * per request; without them it keeps today's polls, and its looks re-attach a
     * failed poll through the old by-id read (csrHistoryItemLookup).
     *
     * skapi.forwardRequestStatus(requests, { service, owner, deadline, fresh, signal }):
     * the status of up to 100 requests per call, no bodies.
     */
    forwardRequestStatus?: (requests: any[], opts?: any) => Promise<{ list: any[]; [key: string]: any }>;
    /** skapi.forwardRequestRead({ id, url, method, since, service, owner, deadline, fresh,
     *  signal }): one request as an envelope that always carries its status, with a
     *  streamed turn's chunks after `since`. Read once per item that just turned terminal. */
    forwardRequestRead?: (params: any) => Promise<any>;
    /** skapi.forwardRequestQueueCounters(queues, { service, owner, deadline, fresh,
     *  signal }): the tiny counter rows of up to 20 queues. Read on every look; the
     *  requests themselves are read only when a counter moved, on a trigger, or once a
     *  minute. Optional even with the two above: without it every look reads statuses. */
    forwardRequestQueueCounters?: (queues: string[], opts?: any) => Promise<{ queues: { [name: string]: any } }>;
    /**
     * Ask the host to refresh what it shows of a project's records, because indexing
     * work of that project just settled and none is left in this page's queue. A data
     * hook: called with no chat view mounted too (the files page, the records page), and
     * only in the tab that holds the project's settle lock. Optional; never throws.
     */
    refreshRecords?: (projectId: string) => void;
}

let _config: ChatEngineConfig | null = null;

export function configureChatEngine(config: ChatEngineConfig): void {
    _config = config;
    if (config.attachmentParsers) {
        for (const parser of config.attachmentParsers) registerAttachmentParser(parser);
    }
}

export function chatEngineConfig(): ChatEngineConfig {
    if (!_config) {
        throw new Error(
            '[chat-engine] configureChatEngine() must be called before using the engine.',
        );
    }
    return _config;
}

/* ---- the transport ------------------------------------------------------------------
 *
 * One resolver per operation, and nothing else in the engine reads the transport keys.
 * Each reads the config at CALL time rather than caching: a host may inject through a
 * getter (agent.vue's finalize and stream hooks are getters, so its capability probe runs
 * on first use) or re-configure, and the request has to go through whatever is there when
 * it leaves. A key counts only when it holds a FUNCTION.
 *
 * Only the forwardRequest family is read (owner, 2026-11-20). A host that still injects
 * the removed `clientSecretRequest*` keys gets the "No request transport" error below,
 * which names the keys to inject instead.
 */

/**
 * Sends one request the engine built: `forwardRequest(null, opts)`, null because the
 * engine never has a form, the whole body is already in `opts.data`. The options pass
 * through exactly as the builder in requests.ts made them (`secretName`, `service`,
 * `owner`, `queue`, `poll`, the stream flags, `headers`, `data`).
 *
 * Called as a method of the config, as the engine always called the transport, so a
 * host that relied on `this` sees what it saw before.
 *
 * Throws when the host injected no forwardRequest. The builders that call this are
 * async, so it reaches the caller as a rejected request.
 */
export function resolveForwardRequest(): (opts: any) => Promise<any> {
    const cfg = chatEngineConfig();
    const fwd = cfg.forwardRequest;
    if (typeof fwd === 'function') {
        return (opts: any) => fwd.call(cfg, null, opts);
    }
    throw new Error(
        '[chat-engine] No request transport: configureChatEngine() needs forwardRequest, '
        + 'bound to a skapi instance (skapi-js 2.1.0 or newer). The clientSecretRequest key is no longer read.',
    );
}

/** Lists chat history. Throws, like resolveForwardRequest, when the host injected none. */
export function resolveForwardRequestHistory(): (params: any, fetchOptions: any) => Promise<any> {
    const cfg = chatEngineConfig();
    const hist = cfg.forwardRequestHistory;
    if (typeof hist === 'function') {
        return (params: any, fetchOptions: any) => hist.call(cfg, params, fetchOptions);
    }
    throw new Error(
        '[chat-engine] No history transport: configureChatEngine() needs forwardRequestHistory, '
        + 'bound to a skapi instance (skapi-js 2.1.0 or newer). The clientSecretRequestHistory key is no longer read.',
    );
}

/**
 * The finalize hook, or undefined when the host injected none. Optional by design (a host
 * without it still streams, it just leaves the chunks), so absence is an answer here and
 * not an error. Returned unbound, because the engine has always called it as a plain
 * function.
 */
export function resolveForwardRequestFinalize(): ForwardRequestFinalizeFn | undefined {
    const cfg = chatEngineConfig();
    return typeof cfg.forwardRequestFinalize === 'function' ? cfg.forwardRequestFinalize : undefined;
}

/**
 * The chunk reader, or undefined when the host injected none. Optional, and its presence
 * is what arms recovery (see streamRecoveryEnabled). Returned unbound, as above.
 */
export function resolveForwardRequestStream(): ForwardRequestStreamFn | undefined {
    const cfg = chatEngineConfig();
    return typeof cfg.forwardRequestStream === 'function' ? cfg.forwardRequestStream : undefined;
}

/** skapi.forwardRequestStatus, or undefined (an skapi-js older than 2.7.0). Never throws. */
export function resolveForwardRequestStatus(): ((requests: any[], opts?: any) => Promise<any>) | undefined {
    if (!_config || typeof _config.forwardRequestStatus !== 'function') return undefined;
    const cfg = _config;
    return (requests: any[], opts?: any) => cfg.forwardRequestStatus!.call(cfg, requests, opts);
}

/** skapi.forwardRequestRead, or undefined. Never throws. */
export function resolveForwardRequestRead(): ((params: any) => Promise<any>) | undefined {
    if (!_config || typeof _config.forwardRequestRead !== 'function') return undefined;
    const cfg = _config;
    return (params: any) => cfg.forwardRequestRead!.call(cfg, params);
}

/** skapi.forwardRequestQueueCounters, or undefined. Never throws. */
export function resolveForwardRequestQueueCounters(): ((queues: string[], opts?: any) => Promise<any>) | undefined {
    if (!_config || typeof _config.forwardRequestQueueCounters !== 'function') return undefined;
    const cfg = _config;
    return (queues: string[], opts?: any) => cfg.forwardRequestQueueCounters!.call(cfg, queues, opts);
}

/**
 * The host handed over the reconciler's two reads (batch status and envelope read), so
 * the engine follows waiting items with batch reads instead of one poll each. False on
 * an older skapi-js: the engine then keeps today's polls (see forwardRequestStatus).
 */
export function reconcilerReadsEnabled(): boolean {
    return !!resolveForwardRequestStatus() && !!resolveForwardRequestRead();
}

/**
 * A send may carry a client reference (`cref`). Only with the reconciler's reads: the
 * same skapi-js (2.7.0) brought both, and an older one drops the key anyway, so a send
 * whose ack was lost could never be matched by it.
 */
export function crefSupported(): boolean {
    return reconcilerReadsEnabled();
}

/** True when the consumer has opted in to server-driven windowed indexing. */
export function windowedIndexingEnabled(): boolean {
    return _config?.windowedIndexing === true;
}

export function workerIndexEndingsEnabled(): boolean {
    return _config?.workerIndexEndings === true;
}

/** True when the consumer has opted in to live streaming of chat turns. */
/** Socket delivery of the stream: the host asked (`liveStreaming`) AND the turn streams. */
/** Request status push is on: the host asked for it and handed over onRequestStatus. */
export function statusPushEnabled(): boolean {
    return _config?.statusPush === true && typeof _config?.onRequestStatus === 'function';
}

/** Status frames are arriving right now (false when status push is off). */
export function statusPushLive(): boolean {
    if (!statusPushEnabled() || typeof _config?.isRequestStatusLive !== 'function') return false;
    try {
        return !!_config.isRequestStatusLive();
    } catch (e) {
        return false;
    }
}

export function liveStreamingSocketEnabled(): boolean {
    return liveStreamingEnabled() && _config?.liveStreaming === true;
}

/**
 * Does this host stream chat turns? Yes whenever it handed over BOTH streaming hooks
 * (the finalize that stores a streamed answer onto its row, and the chunk reader),
 * under either spelling. There is no separate switch: streaming is how the engine
 * reads a reply, and the two hooks are the capability it needs (skapiSupportsStreaming
 * explains why those two methods ARE the capability). A host that wants buffered
 * replies hands over neither, which is also what both clients do when the page's
 * skapi-js is too old to carry skapi's half of the stream flag.
 */
export function liveStreamingEnabled(): boolean {
    return typeof resolveForwardRequestFinalize() === 'function'
        && typeof resolveForwardRequestStream() === 'function';
}

/**
 * THE CEILING RULE, shared by every project switch a host may also set:
 *     effective = projectSetting && hostOption !== false
 * The project owner's setting is the most a page can have; a host option can
 * only take it lower. `override` is a per-call host value (a direct caller of
 * callClaudeWithMcp passing `webAccess`), which restricts exactly like the config
 * option: either one being `false` is off.
 */
function underCeiling(projectSetting: boolean, option: boolean | undefined, override?: boolean): boolean {
    if (!projectSetting) return false;
    if (option === false) return false;
    if (override === false) return false;
    return true;
}

/**
 * The web switch for a chat turn, SYNCHRONOUSLY: the project's cached
 * `web_access` setting (off unless the owner turned it on), restricted by the
 * host's `webAccess` option when that is `false`. For a template or a prompt
 * builder, which have nowhere to await. Reads the cache as it stands, so before
 * the settings fetch settles it answers the default; request builders use
 * resolveWebAccess below instead.
 */
export function webAccessEnabled(service?: string): boolean {
    const opt = _config ? _config.webAccess : undefined;
    return underCeiling(webAccessFrom(service ? cachedProjectSettings(service) : null), opt);
}

/**
 * The same switch, awaiting the project's settings record. Never rejects: a
 * failed or impossible read (no reader injected, a signed-out visitor on a
 * require_login project) settles as "unset", which is off. Cheap after the first
 * call per project: the store dedupes and caches. `override` is a per-call host
 * value that may only restrict (see underCeiling).
 */
export function resolveWebAccess(service?: string, override?: boolean): Promise<boolean> {
    const opt = _config ? _config.webAccess : undefined;
    if (!service) return Promise.resolve(underCeiling(webAccessFrom(null), opt, override));
    return loadProjectSettings(service)
        .then(webAccessFrom, () => false)
        .then((setting) => underCeiling(setting, opt, override));
}

/**
 * The project's answer mode for a chat turn, awaiting its settings record so the
 * first turn after a page load reads the stored value (same reason as
 * resolveWebAccess). Never rejects: a failed or impossible read settles as
 * 'standard', which adds nothing to the request. There is no host option: the
 * mode is the project owner's choice. See project_settings.ts AnswerMode.
 */
export function resolveAnswerMode(service?: string): Promise<AnswerMode> {
    if (!service) return Promise.resolve(answerModeFrom(null));
    return loadProjectSettings(service).then(answerModeFrom, () => answerModeFrom(null));
}

/**
 * The skip-duplicates switch for an upload, SYNCHRONOUSLY: the project's cached
 * `skip_duplicate_files` setting (on unless the owner turned it off), restricted
 * by the host's `skipDuplicateFiles` option when that is `false`. Answers the
 * default before the settings fetch settles; the upload path uses
 * resolveSkipDuplicateFiles below.
 */
export function skipDuplicateFilesEnabled(service?: string): boolean {
    const opt = _config ? _config.skipDuplicateFiles : undefined;
    return underCeiling(skipDuplicateFilesFrom(service ? cachedProjectSettings(service) : null), opt);
}

/**
 * The same switch, awaiting the project's settings record. Never rejects: a
 * failed read settles as "unset", which for this switch is ON (the default), so
 * a project that cannot be read still skips duplicates unless the host said no.
 */
export function resolveSkipDuplicateFiles(service?: string): Promise<boolean> {
    const opt = _config ? _config.skipDuplicateFiles : undefined;
    if (!service) return Promise.resolve(underCeiling(skipDuplicateFilesFrom(null), opt));
    return loadProjectSettings(service)
        .then(skipDuplicateFilesFrom, () => skipDuplicateFilesFrom(null))
        .then((setting) => underCeiling(setting, opt));
}

/**
 * True when a streamed turn whose answer never reached its row can be READ BACK.
 *
 * IT ASKS FOR THE READER ALONE, NOT FOR WHETHER NEW TURNS STREAM, AND THAT SPLIT IS
 * THE WHOLE POINT. "Should NEW turns stream?" and "can an ALREADY streamed row be recovered?"
 * are two different questions about two different sets of rows, and answering both
 * with one flag strands the second set the moment the first answer changes.
 *
 * The failure, and it is not hypothetical - it is what turning the feature off
 * does. A row streamed yesterday holds its answer in the chunk table and a status
 * and no body on the row; only csr-finalize ever copies one onto it. Take
 * streaming away today (a host stops handing over the finalize hook, a client's
 * skapiSupportsStreaming probe degrades the instance to buffered) and every one of
 * those rows instantly becomes unmarked,
 * unrecoverable and unreadable: the mapper emits no bubble for it, the recovery
 * never looks at it, and its answer is unreachable with every byte of it still
 * stored. Rolling a rendering flag back must not delete anybody's history.
 *
 * The reader is the honest test because it is the CAPABILITY the recovery needs.
 * Without it the engine could mark such a turn and never fill it in, trading a
 * missing bubble for a permanently empty one, which is strictly worse than the
 * bug - so the marker is still only ever minted when something can act on it.
 *
 * The cost of asking the wider question is one wasted read, once, on a row that
 * was terminal and empty for some reason other than streaming (a buffered turn
 * whose body the worker never managed to spill). That read finds no chunks, the
 * bubble is dropped, and the list looks exactly as it did before. Set
 * `streamRecovery: false` to opt out of even that.
 *
 * The reader is asked for through resolveForwardRequestStream: `forwardRequestStream`.
 */
export function streamRecoveryEnabled(): boolean {
    // Unconfigured is "no reader", never a throw: this is asked on render paths.
    if (!_config) return false;
    if (_config.streamRecovery === false) return false;
    return typeof resolveForwardRequestStream() === 'function';
}

/**
 * Does a given skapi INSTANCE support the streaming half of the protocol? Ask this
 * before handing the engine the two streaming hooks, and hand over neither (buffered
 * replies) when the answer is no.
 *
 * THE FAILURE THIS PREVENTS, and it is the one the SDK's own docs call quiet. A
 * streamed turn carries TWO `stream` flags: skapi's (relay the destination's bytes
 * into the chunk table) and the DESTINATION's own field inside `data`, which
 * BunnyQuery is the party that sets, because skapi relays bytes and knows no
 * vendor. skapi validates the request's params against a schema and KEEPS ONLY
 * THE KEYS IN THAT SCHEMA, so an skapi-js predating the feature does not reject
 * `stream` - it silently DROPS it. What
 * ships is then the exact split
 * chatStreamWiring exists to make impossible: the destination is asked to answer in
 * SSE frames, skapi waits and stores the whole transcript on the row, and
 * extractClaudeText / extractOpenAIText read a wall of `data: {...}` lines where a
 * document should be and find no answer at all. Nothing throws and nothing logs;
 * the user gets an empty reply on every single turn.
 *
 * It lives in the ENGINE rather than in each client because the two clients are
 * diffed against each other and this is precisely the kind of predicate that forks:
 * the widget must ask it (init() takes the EMBEDDER's instance, and an embed page
 * pins its own skapi-js version, so streaming is granted by this probe and never
 * assumed) and agent.vue must ask it too (its instance is the repo's own, so
 * only a stale node_modules or an unbuilt skapi-js can fail it - which is exactly
 * the state a dev flipping the constant is most likely to be in, and a silently
 * empty chat is the worst possible way to find out).
 *
 * Probed by the two public METHODS rather than by a version string, for two
 * reasons. They ship in the same change as the `stream` key (one feature: the
 * relay, the finalize that stores what to keep, and the read-back), so an SDK
 * missing them is exactly the SDK that would drop the flag. And they are not merely
 * a proxy for the capability, they ARE half of it - the engine needs finalize to
 * store a streamed answer onto its row and stream to read an unfinalized one back,
 * and streaming without either leaves every answer in the chunk table with nothing
 * able to fetch it. There is no cheap DIRECT probe of the schema: the only way to
 * learn that `stream` was dropped is to send a real request and read an empty
 * answer, which is the bug itself.
 *
 * ONLY THE NEW PAIR ANSWERS YES (owner, 2026-11-20). forwardRequestStream and
 * forwardRequestFinalize shipped with the forwardRequest rename (skapi-js 2.1.0), after
 * the `stream` key, so each IS the capability. The old clientSecretRequestStream /
 * clientSecretRequestFinalize pair is no longer accepted: the engine no longer reads the
 * old transport keys at all, so an SDK with only that pair could not be wired anyway.
 *
 * A presence probe is safe for these two names in a way it is NOT for forwardRequest
 * itself: no skapi-js ever shipped a forwardRequestStream or forwardRequestFinalize
 * that meant something else, while an older forwardRequest exists and is the retired
 * streaming forwarder. That is why the widget's family probe asks for
 * forwardRequestHistory instead.
 */
export function skapiSupportsStreaming(sk: any): boolean {
    if (!sk) return false;
    return typeof sk.forwardRequestStream === 'function'
        && typeof sk.forwardRequestFinalize === 'function';
}

/** Spread helper: `{ ...pollOpt() }` adds `poll` only when configured. */
export function pollOpt(): { poll?: number } {
    const p = _config?.poll;
    return p === undefined ? {} : { poll: p };
}
