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
 * THE TRANSPORT HAS TWO SPELLINGS, and a host may inject either. skapi-js renamed
 * clientSecretRequest and its companions to the forwardRequest family, and kept
 * every old name working. So this config accepts both families of keys, prefers
 * the new one, and every call goes through the resolveForwardRequest* functions
 * below, which are the only code in the engine that knows there are two. The old
 * keys are not a courtesy: this package is pinned with a caret range, so a host
 * written against an earlier release takes this one on its next install with
 * nothing but the old keys injected, and it has to keep working unchanged.
 */

import { type AttachmentParser, registerAttachmentParser } from './attachment_parsers';

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
    options: { url: string; method: string; service?: string; owner?: string },
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
     * This or the deprecated `clientSecretRequest` is required; with both, this
     * one is used. See resolveForwardRequest.
     */
    forwardRequest?: (form: any, opts: any) => Promise<any>;
    /**
     * skapi.forwardRequestHistory, bound to the consumer's skapi instance. This or
     * the deprecated `clientSecretRequestHistory` is required; with both, this one
     * is used. Same arguments either way.
     */
    forwardRequestHistory?: (params: any, fetchOptions: any) => Promise<any>;
    /**
     * @deprecated Inject `forwardRequest` instead.
     *
     * skapi.clientSecretRequest, bound to the consumer's skapi instance. Still
     * accepted as a COMPATIBILITY CONTRACT, not a leftover: a host that injects
     * only the old keys must keep working on this release. Used only when
     * `forwardRequest` is absent, and handed the engine's request with `secretName`
     * moved back to `clientSecretName`, which is exactly the request it was handed
     * before the rename (see resolveForwardRequest).
     */
    clientSecretRequest?: (opts: any) => Promise<any>;
    /**
     * @deprecated Inject `forwardRequestHistory` instead.
     *
     * skapi.clientSecretRequestHistory, bound to the consumer's skapi instance.
     * Kept for the same compatibility contract as `clientSecretRequest`, and used
     * only when `forwardRequestHistory` is absent.
     */
    clientSecretRequestHistory?: (params: any, fetchOptions: any) => Promise<any>;
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
     * Mint the durable "indexing finished" marker record ("done::<path>",
     * reference "src::<path>", table __INDEXING__ — same shape the backend
     * worker writes via /internal/index-complete) for runs whose completion
     * THIS CLIENT knows deterministically: a single-pass file's settled pass,
     * or a client-driven chain whose reply carried the completion token.
     * Worker-driven chains are NOT minted from the client (their completion is
     * only ever inferred here); the worker writes their marker itself.
     * Must be best-effort: tolerate the marker already existing and never
     * throw. Optional so older consumers keep the pre-marker inference.
     */
    mintIndexDoneMarker?: (info: { service: string; storagePath: string }) => void;
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
     * behaves exactly as before (legacy scan/probe path).
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
    }) => void;
    /**
     * Opt in to LIVE STREAMING of chat turns.
     *
     * Off by default, and for the same shipping-order reason `windowedIndexing`
     * is: THE BACKEND MUST SHIP FIRST. When on, every chat turn carries two
     * `stream` flags (see requests.ts chatStreamWiring) and the polling row
     * settles with a STATUS AND NO BODY, because the answer was the stream. On a
     * region whose polling worker does not relay, that same request either has
     * its unknown `since` cursor rejected or stores an SSE transcript where the
     * readers expect a parsed document, and the turn reads back as an empty
     * answer. So it stays off until the worker is deployed, then flips per
     * environment.
     *
     * It also needs `forwardRequestFinalize` below (or its deprecated name,
     * `clientSecretRequestFinalize`): without it a streamed turn is never
     * finalized, so its row keeps a status and no body forever and a later
     * history load shows the question with an empty answer.
     */
    liveStreaming?: boolean;
    /**
     * Also push each relayed chunk over skapi's websocket, so text lands as it is
     * relayed instead of on the next poll tick. Requires `liveStreaming`.
     *
     * SEPARATE FROM `liveStreaming` ON PURPOSE, and off unless a host asks. It is a
     * pure accelerator with a safe fallback, so the reason is not risk to the chat, it
     * is what it does to the HOST'S OWN realtime: skapi's joinRealtime REPLACES the
     * connection's group rather than adding to it, so for the length of a turn this
     * takes the room. The dashboard owns its skapi instance and uses realtime for
     * nothing else, so it opts in. The embeddable widget is handed the EMBEDDER'S
     * instance and cannot know what their app does with it, so it stays off there
     * unless the embedder turns it on.
     */
    liveStreamingRealtime?: boolean;
    /**
     * skapi.forwardRequestFinalize, bound to the consumer's skapi instance.
     * Stores the version of a streamed turn that history should keep (the engine
     * sends the ASSEMBLED provider body, so history reads it exactly as it reads
     * a buffered turn) and releases that request's chunks. Optional: a host
     * without it can still stream, it just leaves the chunks and an empty row.
     * Takes precedence over the deprecated `clientSecretRequestFinalize`.
     */
    forwardRequestFinalize?: ForwardRequestFinalizeFn;
    /**
     * @deprecated Inject `forwardRequestFinalize` instead.
     *
     * skapi.clientSecretRequestFinalize, the same call under its old name. Kept
     * for the compatibility contract `clientSecretRequest` describes, and used
     * only when `forwardRequestFinalize` is absent.
     */
    clientSecretRequestFinalize?: ForwardRequestFinalizeFn;
    /**
     * skapi.forwardRequestStream, bound to the consumer's skapi instance. Takes
     * precedence over the deprecated `clientSecretRequestStream`.
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
     * @deprecated Inject `forwardRequestStream` instead.
     *
     * skapi.clientSecretRequestStream, the same call under its old name. Kept for
     * the compatibility contract `clientSecretRequest` describes, and used only
     * when `forwardRequestStream` is absent. It arms recovery exactly as the new
     * key does.
     */
    clientSecretRequestStream?: ForwardRequestStreamFn;
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
     * `forwardRequestStream` (or its deprecated name, `clientSecretRequestStream`)
     * is what arms it (see streamRecoveryEnabled).
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

/* ---- the transport, resolved from whichever family the host injected ------------
 *
 * One resolver per operation, and nothing else in the engine reads the transport
 * keys. Each prefers the forwardRequest key and falls back to the deprecated
 * clientSecretRequest one, and each reads the config at CALL time rather than
 * caching: a host may inject through a getter (agent.vue's finalize and stream hooks
 * are getters, so its capability probe runs on first use) or re-configure, and the
 * request has to go through whatever is there when it leaves.
 *
 * A key counts only when it holds a FUNCTION. `forwardRequestFinalize: undefined`
 * beside a working old key is a host saying "not this one", and the old key answers.
 */

/**
 * Sends one request the engine built, through whichever family the host injected.
 *
 * Every builder in requests.ts produces the NEW spelling, `secretName`, and hands the
 * options here. A host that injected `forwardRequest` gets `forwardRequest(null,
 * opts)`: null because the engine never has a form, the whole body is already in
 * `opts.data`. A host that injected only the deprecated `clientSecretRequest` gets it
 * with `secretName` moved back to `clientSecretName` and placed first, which is key
 * for key, in the same order, the request it was handed before the rename. Nothing
 * else about the options is touched on either path: `service`, `owner`, `queue`,
 * `poll`, the stream flags, `headers` and `data` pass through as the builder made them.
 *
 * THE RENAME LIVES HERE AND NOWHERE ELSE. Done at each call site it is six copies of
 * one translation, and the copy that drifts sends a request naming no secret at all.
 * The old SDK refuses that; the new one, where the secret is optional, forwards it
 * WITHOUT resolving anything, so the provider receives a literal "$CLIENT_SECRET" as
 * its api key and the turn fails at the far end with nothing here to say why.
 *
 * Called as a method of the config, as the engine always called the transport, so a
 * host that relied on `this` sees what it saw before.
 *
 * Throws when the host injected neither, with a message that names the fix. The
 * builders that call this are async, so it reaches the caller as a rejected request,
 * which is the shape the old "is not a function" TypeError had.
 */
export function resolveForwardRequest(): (opts: any) => Promise<any> {
    const cfg = chatEngineConfig();
    const fwd = cfg.forwardRequest;
    if (typeof fwd === 'function') {
        return (opts: any) => fwd.call(cfg, null, opts);
    }
    const legacy = cfg.clientSecretRequest;
    if (typeof legacy === 'function') {
        return (opts: any) => {
            if (!opts || typeof opts !== 'object' || !('secretName' in opts)) return legacy.call(cfg, opts);
            const { secretName, ...rest } = opts;
            return legacy.call(cfg, Object.assign({ clientSecretName: secretName }, rest));
        };
    }
    throw new Error(
        '[chat-engine] No request transport: configureChatEngine() needs forwardRequest '
        + '(or the deprecated clientSecretRequest), bound to a skapi instance.',
    );
}

/**
 * Lists chat history through whichever family the host injected. The two names take
 * the same arguments and return the same thing, so this is a pure preference with no
 * translation. Throws, like resolveForwardRequest, when the host injected neither.
 */
export function resolveForwardRequestHistory(): (params: any, fetchOptions: any) => Promise<any> {
    const cfg = chatEngineConfig();
    const hist = typeof cfg.forwardRequestHistory === 'function'
        ? cfg.forwardRequestHistory
        : cfg.clientSecretRequestHistory;
    if (typeof hist === 'function') {
        return (params: any, fetchOptions: any) => hist.call(cfg, params, fetchOptions);
    }
    throw new Error(
        '[chat-engine] No history transport: configureChatEngine() needs forwardRequestHistory '
        + '(or the deprecated clientSecretRequestHistory), bound to a skapi instance.',
    );
}

/**
 * The finalize hook, from whichever family the host injected, or undefined when it
 * injected neither. Optional by design (a host without it still streams, it just
 * leaves the chunks), so absence is an answer here and not an error. Returned
 * unbound, because the engine has always called it as a plain function.
 */
export function resolveForwardRequestFinalize(): ForwardRequestFinalizeFn | undefined {
    const cfg = chatEngineConfig();
    if (typeof cfg.forwardRequestFinalize === 'function') return cfg.forwardRequestFinalize;
    if (typeof cfg.clientSecretRequestFinalize === 'function') return cfg.clientSecretRequestFinalize;
    return undefined;
}

/**
 * The chunk reader, from whichever family the host injected, or undefined when it
 * injected neither. Optional, and its presence is what arms recovery (see
 * streamRecoveryEnabled), so both spellings arm it alike. Returned unbound, as above.
 */
export function resolveForwardRequestStream(): ForwardRequestStreamFn | undefined {
    const cfg = chatEngineConfig();
    if (typeof cfg.forwardRequestStream === 'function') return cfg.forwardRequestStream;
    if (typeof cfg.clientSecretRequestStream === 'function') return cfg.clientSecretRequestStream;
    return undefined;
}

/** True when the consumer has opted in to server-driven windowed indexing. */
export function windowedIndexingEnabled(): boolean {
    return _config?.windowedIndexing === true;
}

/** True when the consumer has opted in to live streaming of chat turns. */
export function liveStreamingRealtimeEnabled(): boolean {
    return liveStreamingEnabled() && _config?.liveStreamingRealtime === true;
}

export function liveStreamingEnabled(): boolean {
    return _config?.liveStreaming === true;
}

/**
 * True when a streamed turn whose answer never reached its row can be READ BACK.
 *
 * IT ASKS FOR THE READER AND NOT FOR `liveStreaming`, AND THAT SPLIT IS THE WHOLE
 * POINT. "Should NEW turns stream?" and "can an ALREADY streamed row be recovered?"
 * are two different questions about two different sets of rows, and answering both
 * with one flag strands the second set the moment the first answer changes.
 *
 * The failure, and it is not hypothetical - it is what turning the feature off
 * does. A row streamed yesterday holds its answer in the chunk table and a status
 * and no body on the row; only csr-finalize ever copies one onto it. Flip
 * `liveStreaming` off today (an embedder drops the option, a dev rolls the flag
 * back after a bad deploy, a client's skapiSupportsStreaming probe degrades the
 * instance to buffered) and every one of those rows instantly becomes unmarked,
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
 * The reader is asked for through resolveForwardRequestStream, so either spelling of
 * it arms recovery: `forwardRequestStream`, or the deprecated
 * `clientSecretRequestStream` a host written before the rename still injects. Asked
 * for the new key alone, this would quietly disarm recovery for every such host on
 * its next install, which is the stranding described above arriving by a rename.
 */
export function streamRecoveryEnabled(): boolean {
    // Unconfigured is "no reader", never a throw: this is asked on render paths.
    if (!_config) return false;
    if (_config.streamRecovery === false) return false;
    return typeof resolveForwardRequestStream() === 'function';
}

/**
 * Does a given skapi INSTANCE support the streaming half of the protocol? Ask this
 * before honouring a `liveStreaming: true` opt-in, and degrade to buffered when the
 * answer is no.
 *
 * THE FAILURE THIS PREVENTS, and it is the one the SDK's own docs call quiet. A
 * streamed turn carries TWO `stream` flags: skapi's (relay the destination's bytes
 * into the chunk table) and the DESTINATION's own field inside `data`, which
 * BunnyQuery is the party that sets, because skapi relays bytes and knows no
 * vendor. skapi validates the request's params against a schema and KEEPS ONLY
 * THE KEYS IN THAT SCHEMA, so an skapi-js predating the feature (whose only door
 * was clientSecretRequest) does not reject `stream` - it silently DROPS it. What
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
 * pins its own skapi-js version, so `liveStreaming: true` is a REQUEST and this is
 * what grants it) and agent.vue must ask it too (its instance is the repo's own, so
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
 * EITHER SPELLING OF THE PAIR ANSWERS YES, and it has to be a whole pair. skapi-js
 * renamed the two to forwardRequestStream and forwardRequestFinalize and kept the old
 * names as aliases, so three SDKs are out there: the renamed one carries both pairs,
 * one from the streaming release up to the rename carries only the old pair, and one
 * that predates streaming carries neither. Accepting the old pair is what keeps an
 * embed page pinned between the two releases streaming; accepting the new pair is
 * what keeps this answering yes once the old aliases are finally removed. The
 * reasoning above holds for both: each pair shipped in the same change as, or after,
 * the `stream` key, and each IS the capability rather than a proxy for it. A mixed
 * half of each is not a pair and is refused, because no real SDK has that shape and
 * the engine would still be missing one half of the protocol under the name it asks
 * for.
 *
 * A presence probe is safe for these two names in a way it is NOT for forwardRequest
 * itself: no skapi-js ever shipped a forwardRequestStream or forwardRequestFinalize
 * that meant something else, while an older forwardRequest exists and is the retired
 * streaming forwarder. That is why the widget's family probe asks for
 * forwardRequestHistory instead.
 */
export function skapiSupportsStreaming(sk: any): boolean {
    if (!sk) return false;
    return (typeof sk.forwardRequestStream === 'function'
            && typeof sk.forwardRequestFinalize === 'function')
        || (typeof sk.clientSecretRequestStream === 'function'
            && typeof sk.clientSecretRequestFinalize === 'function');
}

/** Spread helper: `{ ...pollOpt() }` adds `poll` only when configured. */
export function pollOpt(): { poll?: number } {
    const p = _config?.poll;
    return p === undefined ? {} : { poll: p };
}
