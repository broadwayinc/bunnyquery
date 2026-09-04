/**
 * Client-side attachment-parser plugins.
 *
 * Some attachment formats can't be read by the model's web_fetch (binary) and
 * have no server-side extractor either — e.g. legacy Hancom .hwp. A parser
 * plugin runs IN THE BROWSER, turns the uploaded File into indexable text (or an
 * HTML string), and the engine sends that content INLINE in the background
 * indexing request — so the model indexes the parsed content directly, with no
 * upload-side server extraction and no web_fetch for that file.
 *
 * Register a parser with `registerAttachmentParser()`, or via
 * `configureChatEngine({ attachmentParsers: [...] })`. The BunnyQuery widget also
 * exposes `BunnyQuery.registerAttachmentParser()` and an `attachmentParsers`
 * init option. First matching parser wins.
 */
interface AttachmentParser {
    /** Human-readable label — used only in logs. */
    name?: string;
    /**
     * Return true if this parser handles the file. Receives the file name and
     * (when known) its MIME type. Keep it cheap — it runs for every upload.
     */
    match: (file: {
        name: string;
        mime?: string;
    }) => boolean;
    /**
     * Parse the File into indexable plain text OR an HTML string (the model reads
     * either). Runs in the browser; may be async. Return a falsy/empty value to
     * skip (the file then falls back to web_fetch / server extraction).
     */
    parse: (file: File) => string | null | undefined | Promise<string | null | undefined>;
}
declare const MAX_PARSED_CONTENT_CHARS = 200000;
/** Register an attachment parser. Ignores duplicates (by reference) and invalid plugins. */
declare function registerAttachmentParser(parser: AttachmentParser): void;
/** Remove all registered parsers (mainly for tests / re-init). */
declare function clearAttachmentParsers(): void;
/** Snapshot of the registered parsers. */
declare function getAttachmentParsers(): AttachmentParser[];
/** First parser whose `match` returns true for the given file, if any. */
declare function findAttachmentParser(name: string, mime?: string): AttachmentParser | undefined;
/**
 * Run the matching parser (if any) and return capped, trimmed content — or null
 * when there is no parser, the parser throws, or it yields nothing. Never throws:
 * a parser failure degrades to null so the upload still completes (the file then
 * resolves via its normal path).
 */
declare function parseAttachmentContent(file: File, name: string, mime?: string): Promise<string | null>;

/**
 * Engine configuration / dependency injection.
 *
 * The engine is framework- and transport-agnostic: it never imports a skapi
 * instance or `import.meta.env`. Each consumer calls `configureChatEngine()`
 * once at startup to inject the skapi transport functions, the MCP base URL,
 * and (optionally) the `poll` value to attach to clientSecretRequest.
 *
 * Why `poll` is configurable: agent.vue uses the npm-bundled skapi-js and OMITS
 * `poll` (its clientSecretRequest auto-resolves with the final body), whereas
 * the BunnyQuery widget uses the deployed skapi-js@latest and must pass
 * `poll: 0` to get the early ack + a manual `.poll()` handle (needed for queued-
 * send cancel). So the request builders include `poll` only when it is set.
 */

/**
 * One report about a turn that is streaming, as handed to `onLiveStreamUpdate`.
 *
 * Deliberately a flat snapshot rather than the SseParser itself: the hook is a
 * VIEW seam, and handing a client the parser would invite it to drive the stream
 * (feed it, end it, read the assembled body) behind the session's back.
 */
interface LiveStreamUpdate {
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
    transport: {
        socket: number;
        poll: number;
    };
}
interface ChatEngineConfig {
    /** skapi.clientSecretRequest, bound to the consumer's skapi instance. */
    clientSecretRequest: (opts: any) => Promise<any>;
    /** skapi.clientSecretRequestHistory, bound to the consumer's skapi instance. */
    clientSecretRequestHistory: (params: any, fetchOptions: any) => Promise<any>;
    /** MCP server base URL (prod vs dev resolved by the consumer). */
    mcpBaseUrl: string;
    /**
     * Value to attach as `poll` on every clientSecretRequest. When `undefined`
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
    mintIndexDoneMarker?: (info: {
        service: string;
        storagePath: string;
    }) => void;
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
     * It also needs `clientSecretRequestFinalize` below: without it a streamed
     * turn is never finalized, so its row keeps a status and no body forever and
     * a later history load shows the question with an empty answer.
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
     * skapi.clientSecretRequestFinalize, bound to the consumer's skapi instance.
     * Stores the version of a streamed turn that history should keep (the engine
     * sends the ASSEMBLED provider body, so history reads it exactly as it reads
     * a buffered turn) and releases that request's chunks. Optional: a host
     * without it can still stream, it just leaves the chunks and an empty row.
     */
    clientSecretRequestFinalize?: (requestId: string, data: any, options: {
        url: string;
        method: string;
        service?: string;
        owner?: string;
    }) => Promise<any>;
    /**
     * skapi.clientSecretRequestStream, bound to the consumer's skapi instance.
     *
     * THE SECOND HALF OF THE DURABILITY GUARANTEE, and without it a streamed turn
     * is only as durable as the tab that started it. A streamed row settles with a
     * status and NO body; the answer is stored as chunks until
     * clientSecretRequestFinalize says what to keep. A row that settles while no
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
    clientSecretRequestStream?: (requestId: string, options: {
        url: string;
        method: string;
        onStream?: (chunk: string, seq: number) => void;
        since?: number;
        poll?: number;
        service?: string;
        owner?: string;
    }) => Promise<any>;
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
     * `clientSecretRequestStream` is what arms it (see streamRecoveryEnabled).
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
declare function configureChatEngine(config: ChatEngineConfig): void;
declare function chatEngineConfig(): ChatEngineConfig;
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
 */
declare function streamRecoveryEnabled(): boolean;
/**
 * Does a given skapi INSTANCE support the streaming half of the protocol? Ask this
 * before honouring a `liveStreaming: true` opt-in, and degrade to buffered when the
 * answer is no.
 *
 * THE FAILURE THIS PREVENTS, and it is the one the SDK's own docs call quiet. A
 * streamed turn carries TWO `stream` flags: skapi's (relay the destination's bytes
 * into the chunk table) and the DESTINATION's own field inside `data`, which
 * BunnyQuery is the party that sets, because skapi relays bytes and knows no
 * vendor. clientSecretRequest validates its params against a schema and KEEPS ONLY
 * THE KEYS IN THAT SCHEMA, so an skapi-js predating the feature does not reject
 * `stream` - it silently DROPS it. What ships is then the exact split
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
 */
declare function skapiSupportsStreaming(sk: any): boolean;

/**
 * Office-file server-side extraction helpers.
 *
 * Office documents (Microsoft .docx/.xlsx/.pptx, Hancom .hwpx, etc.) can't be
 * read by web_fetch (binary/zip). The proxy worker downloads them from db
 * storage, extracts their text server-side, and substitutes that text for a
 * placeholder token in the request body (carried under the reserved
 * `_skapi_extract` key, which the producer strips before the upstream call).
 */
type ExtractDirective = {
    /** db storage path of the file, e.g. "folder/report.docx" (also the src:: value). */
    path: string;
    /** The exact token in the request body to replace with the extracted text. */
    placeholder: string;
    /** Original filename — informational (server logs only). */
    name?: string;
    /** MIME type — informational (server logs only). */
    mime?: string;
};
type FileUrlDirective = {
    /** db storage path of the file, e.g. "folder/report.pdf" (also the src:: value). */
    path: string;
    /** The exact baked url string in the request body to replace with a fresh one. */
    url: string;
};
/**
 * True when a file should be EXTRACTED SERVER-SIDE (text inlined for indexing)
 * rather than handed to the agent as a URL to fetch — i.e. binary office
 * documents AND all text/data/code files. Detection is extension-first (so a
 * .csv reported as an Office MIME is still treated as text), with a text-MIME
 * fallback for unlisted extensions.
 */
declare function isServerExtractable(name?: string, mime?: string): boolean;
/** @deprecated renamed to {@link isServerExtractable} (now also covers text files). */
declare const isOfficeFile: typeof isServerExtractable;
declare function makeExtractPlaceholder(seed: string): string;
interface ComposedUserMessage {
    /** Clean display/history copy (attachment links, NO extraction placeholders). */
    composed: string;
    /** LLM-bound copy — `composed` plus inline office-extraction placeholders. */
    composedForLlm: string;
    /** Office-extraction directives for the proxy worker (undefined if no office files). */
    extractContent?: ExtractDirective[];
    /** JIT url re-mint directives for the worker (non-extractable files: PDFs, images). */
    fileUrls?: FileUrlDirective[];
}
declare function composeUserMessage(text: string, attachmentUrls: Array<{
    name: string;
    url: string;
    storagePath?: string;
}>, opts?: {
    /**
     * Inline each server-extractable attachment's whole text into the
     * prompt (the `_skapi_extract` directives + BEGIN/END FILE CONTENT
     * block). Default true, which is right when the file's content is
     * nowhere else yet.
     *
     * Pass FALSE when the turn is dispatched AFTER the file's indexing run
     * has drained. Extraction is the same server-side download+parse the
     * indexing pass already performed, so inlining repeats it: the worker
     * fetches and re-parses every attachment a second time (which reads,
     * from the outside, exactly like the file being indexed again), and the
     * whole file text is re-sent as prompt tokens. It is also the WORSE
     * copy for anything large, because inline extraction truncates at
     * MAX_EXTRACTED_CHARS while the indexed records cover the file end to
     * end. The model reaches the content through the records
     * (getRecords with reference "src::<path>") or readFileContent.
     */
    inlineExtractedContent?: boolean;
}): ComposedUserMessage;

/**
 * Attachment helpers shared by every consumer's view layer.
 *
 * The upload ORCHESTRATION is per-consumer (agent.vue does admin storage
 * accounting; the widget uses get-signed-url), but the failure-reporting shape
 * is identical, so it lives here. When an upload or its indexing request fails,
 * the orchestrator records the original `error.code` / `error.message` on the
 * attachment (`att.errorCode` / `att.errorDetail`); this groups those failed
 * attachments by (code, description) so a single report dialog can list each
 * distinct error once with all the files it affected.
 */
interface AttachmentFailureGroup {
    /** The failing `error.code` (empty string when the error carried none). */
    code: string;
    /** The failing `error.message` / human description. */
    message: string;
    /** Display names of the attachments that hit this exact (code, message). */
    files: string[];
}
declare function groupAttachmentFailures(attachments: any[]): AttachmentFailureGroup[];

/**
 * BASE PROMPT - Chat assistant
 * ============================================================================
 * System prompt sent on every chat turn. Rebuilt fresh on every send because
 * the project name/description can change at any time.
 *
 * The `${...}` placeholders are filled from the live project (service):
 *   projectId  -> the project ID the assistant is scoped to
 *   serviceName -> project display name   (only added if a description exists)
 *   serviceDescription -> project description     (only added if present)
 */
type ChatSystemPromptParams = {
    /** The project/service ID this assistant is scoped to (formatted form). */
    projectId: string;
    /** Project display name. Only appended when a description is also present. */
    serviceName?: string;
    /** Project description. When present, name + description are appended. */
    serviceDescription?: string;
    /**
     * The opening bubble's text (buildChatGreeting().text). That bubble is
     * client-side chrome and never enters the message history, so the model is
     * told about it here. Without it, "what do you mean?" about its own first
     * line is unanswerable.
     */
    greeting?: string;
    /**
     * Whether this user can attach files. False for an anonymous widget visitor
     * and for a frozen database seen by a non-admin, where the upload
     * instructions below would send them at an affordance they do not have.
     */
    canUpload?: boolean;
    /**
     * Which UI the user is in. The console has pages (Files, Settings) the
     * embedded widget does not, so the "where do I do that" directions are only
     * given when the caller says which one this is.
     */
    client?: 'console' | 'widget';
    /**
     * The access group THIS project's indexer writes its records at, read from
     * the project's BunnyQuery settings record (`bq::settings`, key
     * `upload_access_group`). It used to come from the service record's
     * `default_access_group`, which no longer exists.
     *
     * The MCP auto-fills an index/tag query that names a table but no group with
     * "authorized", which used to be right because every BunnyQuery record was
     * hardcoded to it. Now a project can index at "public" (so an anonymous
     * visitor can read it) or "private", and on those projects the auto-fill
     * silently searches a group the data is not in and answers "nothing found".
     * Defaults to 'authorized', which is what an unset project still uses.
     *
     * A PLAIN table query needs the group just as much, and this is newer: the
     * SDK no longer fills a group in for a table that arrives without one, so the
     * SERVER resolves it, and it resolves it differently per caller. A master
     * (the project's owner) is answered across every access group; a normal
     * signed-in user is answered from access_group 0 alone. So an end user asking
     * about a table indexed at "authorized" would silently search public only,
     * and get "nothing found" over data that is right there. The prompt therefore
     * asks for the group on EVERY query that names a table, not just index/tag
     * ones.
     */
    indexAccessGroup?: string;
};
declare function buildChatSystemPrompt(params: ChatSystemPromptParams): string;

/**
 * BASE PROMPT - Background file-indexing agent (system prompt)
 * ============================================================================
 * System prompt for the BACKGROUND indexing agent (notifyAgentSaveAttachment).
 * Its only job is to read the freshly uploaded file and persist what it learns
 * into the project's knowledge base via the MCP tools. Pairs with the
 * user-message template in ./indexing_user_message.ts.
 */
type IndexingSystemPromptParams = {
    /** The PUBLIC project ID being indexed into (formatted token; the form the MCP tools accept). */
    projectId: string;
    /** Project display name. Only appended when a description is also present. */
    serviceName?: string;
    /** Project description. When present, name + description are appended. */
    serviceDescription?: string;
    /**
     * Access group every record written during this run must carry. Chosen by the
     * uploader (project default, or a per-upload prompt) and already applied to
     * the "src::" file record before indexing starts. Defaults to "authorized",
     * which is what every record written before this setting existed used.
     */
    accessGroup?: 'public' | 'authorized' | 'private';
};
declare function buildIndexingSystemPrompt(params: IndexingSystemPromptParams): string;

/**
 * BASE PROMPT - Background file-indexing agent (user message)
 * ============================================================================
 * USER-role message paired with the indexing system prompt. Sent by
 * notifyAgentSaveAttachment() each time a file is uploaded or re-indexed.
 *
 * NOTE: the leading line "A new file has just been uploaded. Index it now." and
 * the "- name: ..." line are also what the chat client parses to build the
 * "Indexing: <name>" history bubble - keep those fields on their own lines.
 */
type IndexingAttachmentInfo = {
    /** Original file name. */
    name: string;
    /** Storage path within the project's db storage. */
    storagePath: string;
    /** MIME type, if detected. Omitted from the message when unknown. */
    mime?: string;
    /** File size in bytes, if known. Omitted from the message when unknown. */
    size?: number;
    /** Temporary signed URL the agent/MCP fetches to read the file contents. */
    url: string;
    /**
     * Access group every record extracted from this file must be written at.
     *
     * The uploader chooses it (project default, or a per-upload prompt), and the
     * `src::` file record is already created at this group before indexing starts.
     * The rows, chapters and summaries the agent writes have to MATCH it: skapi's
     * access group is part of a record's table key, so a public file whose rows
     * were saved as "authorized" is a file an anonymous visitor can see the name
     * of and none of the contents of. Omitted means "authorized", which is what
     * every record written before this setting existed used.
     */
    accessGroup?: 'public' | 'authorized' | 'private';
};
type BuildIndexingUserMessageOptions = {
    /**
     * For files with no paged reader (.epub/.hwp/.doc/.rtf, source code) the model can't read the binary via
     * web_fetch, so the proxy worker extracts the text server-side and replaces
     * this exact token with it. When provided, the message embeds the token (and
     * drops the temporary-URL line - there is nothing for the model to fetch).
     */
    inlineContentPlaceholder?: string;
    /**
     * Actual file content parsed CLIENT-SIDE by an attachment-parser plugin (e.g.
     * an .hwp parser). Embedded inline verbatim - no server extraction and no
     * web_fetch for this file. Takes precedence over `inlineContentPlaceholder`.
     */
    inlineContent?: string;
    /**
     * Spreadsheet or PDF: read by PAGING through the readFileContent tool (grid rows +
     * embedded photos / rendered scanned pages), not inline and not by web_fetch. The
     * message instructs the agent to page through EVERY window and datafy each.
     */
    pagedRead?: boolean;
};
/**
 * The access group to write this file's records at. One place, so the user
 * message, the continue message and the system prompt cannot disagree.
 */
declare function indexingAccessGroup(attachment: {
    accessGroup?: string;
}): 'public' | 'authorized' | 'private';
declare function buildIndexingUserMessage(attachment: IndexingAttachmentInfo, options?: BuildIndexingUserMessageOptions): string;
/**
 * Token the WORKER substitutes with the 1-based first page of the window it is about to
 * render, when it builds the next pass of a document from `RENDER_CONTINUE_TEMPLATE`.
 * Must match the worker's RENDER_FROM_TOKEN.
 */
declare const RENDER_FROM_TOKEN = "{{RENDER_FROM}}";
/**
 * User message for a VISION file (PDF): its pages are delivered as RENDERED PAGE IMAGES that
 * the proxy worker injects into THIS message at the `placeholder` token (tool-result images
 * render on neither provider, so the pages must be image blocks in the message itself). Each
 * pass shows one WINDOW of pages starting at `renderFrom` (0-based).
 *
 * The WORKER advances the window: when its renderer reports pages remaining it enqueues the
 * next pass itself, off the true page count, so a document indexes end-to-end with no browser
 * involved. This message therefore only ever describes ONE window, and the model is never
 * asked to decide whether the document is finished.
 *
 * renderFrom === 0 is the FIRST pass (leads with "A new file has just been uploaded." so the
 * client builds the "Indexing: <name>" bubble); a continue pass (built by the worker from
 * buildIndexingRenderContinueTemplate) leads with "CONTINUE indexing" so it is not a duplicate
 * primary bubble.
 */
declare function buildIndexingRenderMessage(attachment: IndexingAttachmentInfo, placeholder: string, renderFrom: number): string;
/**
 * The CONTINUE pass, as a template the worker fills in. `pageLabel` defaults to the
 * RENDER_FROM_TOKEN placeholder, which the worker replaces with the real 1-based start page
 * of the window it is rendering; passing an explicit label produces a ready-to-send message.
 */
declare function buildIndexingRenderContinueTemplate(attachment: IndexingAttachmentInfo, placeholder: string, pageLabel?: string): string;
/**
 * User message for a WINDOWED file: the worker splices ONE window of the file's rows or
 * text into this message at `placeholder`, then continues from the reader's own cursor
 * until the file is exhausted.
 *
 * The agent is deliberately NOT asked to page the file itself, and is NOT asked to judge
 * whether it is finished. Both used to be its job, and both failed the same way: the
 * traversal lived inside a single turn's budget, so a large file simply stopped partway
 * with a confident summary of the part it had seen.
 */
declare function buildIndexingWindowMessage(attachment: IndexingAttachmentInfo, placeholder: string, isContinuation: boolean, positionLabel?: string): string;
/**
 * User message for a RESUME pass: a previous indexing pass could not finish this large
 * file, so continue it from where the already-saved records leave off (never restart).
 */
declare function buildIndexingContinueMessage(attachment: IndexingAttachmentInfo): string;

/**
 * The chat's opening line, in ONE place.
 *
 * Both clients paint this bubble themselves (the widget builds DOM nodes,
 * agent.vue renders template markup) because the project name sits inside its
 * own translate="no" element. Forking the sentence between them is how the two
 * copies drifted before, so the sentence lives here and each client only
 * decides how to draw the three pieces.
 *
 * It is ALSO what the assistant is told it opened with (buildChatSystemPrompt's
 * `greeting`): the bubble is pure client-side chrome and never enters the
 * message history, so without this the model cannot answer "what do you mean,
 * indexed?" or "which files should I upload?" about its own first line.
 */
type ChatGreetingParams = {
    /** Project display name. Rendered by the client inside translate="no". */
    projectName?: string;
    /**
     * Whether this session can attach files at all. False for an anonymous
     * widget visitor and for a frozen database seen by a non-admin: telling
     * those users to upload is a dead end, so they get the ask-first line.
     */
    canUpload?: boolean;
};
type ChatGreetingParts = {
    /** Text before the project name. */
    lead: string;
    /** The quoted project name, or "" when the project has no name. */
    name: string;
    /** Text after the project name. */
    tail: string;
    /** The whole line as plain text: what the assistant is told it said. */
    text: string;
};
declare function buildChatGreeting(params: ChatGreetingParams): ChatGreetingParts;

/**
 * Error detection + message extraction (pure). Moved verbatim from the
 * agent.vue / bunnyquery chatbox so both consumers share one implementation.
 */
/**
 * True when a csr-poll answer is the STATUS ENVELOPE rather than a stored body.
 *
 * Duck-typed, because the engine does not import skapi-js and the SDK does not
 * export its own copy. The rule is the SDK's (isPollEnvelope): a request that has
 * a stored result hands that result back verbatim, every other state hands back
 * `{ id, status, in_queue, ... }`. A finalized body is the caller's own content
 * and can itself carry a `status` key (OpenAI's Responses object does), so the
 * id/in_queue pair is demanded too: a provider body would have to reproduce all
 * three to be mistaken for an envelope.
 *
 * It lives HERE, next to the error readers, rather than in session.ts, because
 * both of the things that have to recognise an envelope (the settle that
 * substitutes an assembled body for one, and the error readers below) must agree
 * on what one is. It was written twice once; that is how the error readers came to
 * look one level too shallow.
 */
declare function isCsrStatusEnvelope(res: any): boolean;
/**
 * The real error payload inside a FAILED csr-poll status envelope, or undefined
 * when `input` is not one.
 *
 * THE FAILURE THIS PREVENTS, verbatim from the wire. A buffered turn that fails
 * polls back as the worker's failed payload itself:
 *
 *     { status_code: 401, body: { error: { type, message } }, truncated: false }
 *
 * ...which every predicate below reads correctly. A STREAMED turn that fails does
 * not: the poller (client_secret_key_request_polling) cannot return the error
 * early for a streamed row, because the chunks that arrived before the stream died
 * have to come back in the same response, so it falls through and ships
 *
 *     { id, status: 'failed', queue_name, in_queue, stream, chunks, last_seq,
 *       more, error: <the payload above> }
 *
 * The payload is one level deeper, and every predicate here looked at the top
 * level: `response.error.message` is undefined on it, `response.status_code` is
 * absent, and `response.status` is the string 'failed' rather than a number. So a
 * wrong API key on a streamed turn read as "not an error, and no answer either",
 * which the caller renders as "No text response received from AI provider": the
 * one message that tells the user nothing.
 *
 * Unwrapping HERE, once, is what makes a streamed error and a buffered error take
 * the same path through every reader below. Deliberately not recursive: the value
 * inside an envelope is a provider payload, never another envelope, and a single
 * unwrap cannot loop on a malformed one.
 *
 * A failed envelope with a NULL payload (the worker recorded no detail, or its
 * spill could not be fetched) still yields an object, because the row's status is
 * itself the fact: 'failed' with nothing attached must not read as a clean turn.
 */
declare function csrEnvelopeError(input: any): any;
declare function getErrorMessage(input: any): string;
declare function isErrorResponseBody(response: any): boolean;
declare function isNonRetryableRequestError(input: any): boolean;
declare function isAuthExpiredError(input: any): boolean;
/**
 * True when the AI PROVIDER rejected the project's own API key.
 *
 * Deliberately narrow, and deliberately NOT the same question as
 * isAuthExpiredError: that one is about OUR session/MCP bearer going stale,
 * which the client fixes by refreshing and resending. This one means the key
 * the project owner pasted is wrong or revoked, which only a human can fix.
 *
 * A bare 401 is NOT enough to conclude it (the MCP bearer expiring is also a
 * 401), so this matches only the provider's key-specific markers:
 *   Anthropic -> `authentication_error`, "invalid x-api-key"
 *   OpenAI    -> `invalid_api_key`, "Incorrect API key provided"
 * Accepts a response object, a thrown error, or the message string those get
 * reduced to by getErrorMessage, because the view usually only keeps the text.
 */
declare function isProviderApiKeyError(input: any): boolean;

declare var CONTEXT_WINDOW_DEFAULT: Record<string, number>;
declare var CONTEXT_WINDOW_BY_MODEL: Record<string, number>;
declare var MAX_OUTPUT_BY_MODEL: Record<string, number>;
declare var DEFAULT_CONTEXT_WINDOW: number;
/**
 * Record context windows and output caps from a provider models listing. Reads
 * `max_input_tokens` and `max_tokens` (Anthropic); items without them are
 * skipped, so passing an OpenAI listing is a no-op rather than an error.
 *
 * Note the asymmetry against the static table: Anthropic reports
 * `max_input_tokens` (input only) where CONTEXT_WINDOW_BY_MODEL holds totals, so
 * a registered Claude window is treated as a total and loses its output cap
 * worth of budget. That is deliberate — under-spending the window is safe, and
 * with no compaction beta enabled overrunning it is a hard error.
 */
declare function registerModelContextWindows(models: Array<{
    id?: string;
    max_input_tokens?: number;
    max_tokens?: number;
}> | null | undefined): void;
declare function setProjectContextWindow(projectId: string, tokens: number | null | undefined): void;
declare function getProjectContextWindow(projectId: string): number | null;
declare var MAX_OUTPUT_TOKENS: number;
/**
 * The same ceiling for an INDEXING pass, which is a different job with a different shape.
 *
 * A chat turn has a person waiting, so a long reply is a worse outcome than a truncated
 * one and 25,000 is generous for it. An indexing pass has nobody waiting and one job:
 * emit records for the window it was shown. When it runs out of budget mid-window the
 * worker halves the window and re-sends it (`window_scale 1.0 -> 0.5`), so the file pays
 * roughly twice the passes for the rest of its length.
 *
 * WHY 64,000, measured on a live 465-row spreadsheet (9 passes, project ap21U8y5byIbkGSv):
 *   - gpt-5.6-luna allows 128,000 output tokens, so 25,000 was 19.5% of what it permits.
 *   - Only 1 of those 9 passes hit the cap; the median used 6,370. A cap is a CEILING, not
 *     a target: the model stops when it is done, so raising it costs nothing on the eight
 *     passes that never approach it. It only changes the one that would have truncated.
 *   - Fitting duration against output tokens across the nine: `55.4s + output / 131 tok/s`
 *     (R^2 0.906). The binding constraint is TIME, not the model.
 *   - The worker's upstream timeout is 870s and its Lambda is 900s with a 30s settle
 *     reserve, which puts the theoretical ceiling near 103,000 tokens. 64,000 lands at
 *     about 544s and leaves roughly 300s of margin for a slow provider hour or a pass with
 *     more tool round trips. Spending that margin buys nothing: 64,000 is already enough
 *     for a full 250-row window to finish in one pass, which is the whole point.
 *
 * It does NOT feed OUTPUT_TOKEN_RESERVE below. That reserve exists to size the INPUT
 * budget for buildBoundedChatMessages, which only the chat path calls; an indexing message
 * is built from a file window, not from bounded history. Wiring this into the reserve would
 * shrink a budget this number has nothing to do with.
 *
 * Re-derive rather than nudge: re-run the fit if the model, the Lambda timeout or
 * REQUEST_TIMEOUT changes, and note that a model whose own ceiling is lower still wins
 * (getMaxOutputTokens clamps, so gpt-4o stays at its 4,000).
 */
declare var INDEXING_MAX_OUTPUT_TOKENS: number;
declare var OUTPUT_TOKEN_RESERVE: number;
declare var TOOL_AND_RESPONSE_BUFFER: number;
declare var MIN_INPUT_TOKEN_BUDGET: number;
declare var MIN_PER_REQUEST_INPUT_CAP: number;
/** @deprecated renamed to {@link MIN_PER_REQUEST_INPUT_CAP} (no longer Claude-only). */
declare var CLAUDE_PER_REQUEST_INPUT_CAP: number;
declare var MAX_HISTORY_MESSAGES: number;
declare var HISTORY_TOKEN_BUDGET: number;
declare var INPUT_CAP_RATIO: number;
/** @deprecated renamed to {@link INPUT_CAP_RATIO} (no longer Claude-only). */
declare var CLAUDE_INPUT_CAP_RATIO: number;
declare var HISTORY_BUDGET_RATIO: number;
declare function estimateTextTokens(text: string): number;
declare function estimateMessageTokens(msg: {
    role: string;
    content: string;
}): number;
declare function getModelContextWindow(platform: string, model?: string): number;
/**
 * How many output tokens to ask for. We never want more than MAX_OUTPUT_TOKENS,
 * but a model whose own cap is lower rejects the request outright, so clamp to
 * whichever is smaller. Models with no known cap keep MAX_OUTPUT_TOKENS.
 */
declare function getMaxOutputTokens(platform: string, model?: string, 
/** 'indexing' asks for INDEXING_MAX_OUTPUT_TOKENS instead. Omitted means chat, so every
 *  existing caller keeps the number it had. */
purpose?: 'chat' | 'indexing'): number;
/**
 * The window a request is actually budgeted at: the per-project override when
 * one is set, otherwise DEFAULT_CONTEXT_WINDOW. Both are clamped to the model's
 * hard ceiling, because a budget above the ceiling builds a request the provider
 * rejects, and a stored override outlives the model it was chosen under.
 */
declare function getContextWindow(platform: string, model?: string, projectId?: string): number;
declare function getInputTokenBudget(platform: string, model?: string, projectId?: string): number;
declare function stripFileBlocksFromHistory(content: string): string;
type BoundedChatOptions = {
    platform: string;
    model?: string;
    systemPrompt: string;
    history: Array<{
        role: string;
        content: string;
    }>;
    /** Used to strip/rewrite expired attachment links in older user turns. */
    projectId: string;
};
declare function buildBoundedChatMessages(options: BoundedChatOptions): {
    messages: {
        role: string;
        content: string;
    }[];
    droppedCount: number;
    estimatedInputTokens: number;
    estimatedBudget: number;
};

/**
 * How a text file the chat offers as a download is encoded and labelled, so that
 * whatever opens it reads the characters correctly, in any language.
 *
 * When the model answers with a fenced ```name.ext block, the client turns that
 * block into a Blob and an <a download>. We always write UTF-8, but several very
 * common consumers do not assume UTF-8 when nothing in the file says so, and fall
 * back to the reader's local ANSI codepage: CP949 in Korea, CP932 in Japan,
 * CP936/CP950 in China and Taiwan, CP1251 for Cyrillic. The file is valid and
 * every non-ASCII character still opens as mojibake.
 *
 * There is no single fix, because the way a file declares "this is UTF-8" is a
 * property of the FORMAT:
 *
 *   - a spreadsheet (csv/tsv) and a Windows text editor read a BOM;
 *   - HTML is opened from disk with no HTTP headers, so only an in-document
 *     <meta charset> survives;
 *   - XML carries its encoding in its declaration, and a WRONG declaration makes
 *     a conforming parser fail outright;
 *   - RTF is 7-bit, so non-ASCII has to be escaped into \uNNNN?;
 *   - JSON, JSONL and YAML are UTF-8 by specification, and a BOM BREAKS them.
 *
 * Anything unrecognised is left byte-for-byte alone: an unknown extension is far
 * more likely to be machine-parsed, where an uninvited BOM is a new bug, than to
 * be opened by a legacy editor.
 *
 * MIRROR of skapi-mcp/download-encoding.js, which does the same job for files the
 * server publishes (writeReport / exportRecordsToFile). A file the user gets from
 * a fenced block and the same file published as a download must behave
 * identically, so the two have to change together.
 */
declare const BOM = "\uFEFF";
/** Files a spreadsheet or a Windows text editor opens directly. */
declare const BOM_EXTS: Set<string>;
/** Read from disk with no HTTP headers, so the declaration must be in the file. */
declare const HTML_EXTS: Set<string>;
declare const XML_EXTS: Set<string>;
declare const RTF_EXTS: Set<string>;
/** Content types by extension. Every text family carries an explicit charset. */
declare const EXT_CONTENT_TYPES: Record<string, string>;
type EncodingClass = 'bom' | 'html' | 'xml' | 'rtf' | 'none';
declare function normalizeExt(ext: string | null | undefined): string;
/** Extension of a filename, '' when it has none. */
declare function extOf(filename: string | null | undefined): string;
/** Which encoding declaration this format understands. */
declare function encodingClassForExt(ext: string | null | undefined): EncodingClass;
/** True when a file with this extension must be written BOM-first. */
declare function needsBomForExt(ext: string | null | undefined): boolean;
/**
 * Content type to declare. Everything textual carries an explicit charset:
 * without one the receiving end guesses, and it guesses the local codepage.
 */
declare function contentTypeForExt(ext: string | null | undefined, fallback?: string): string;
declare function hasBom(text: string): boolean;
declare const HTML_HEAD_WINDOW = 4096;
/**
 * Make an HTML document state its own encoding. Downloaded HTML is opened from
 * disk, where the Content-Type we set no longer exists, so a document with no
 * <meta charset> is decoded with the browser's locale default.
 */
declare function ensureHtmlCharset(text: string): string;
/**
 * Correct an XML declaration that names the wrong encoding.
 *
 * A MISSING declaration is left alone on purpose: XML with none is UTF-8 by
 * specification, so every conforming parser already gets it right. A declaration
 * naming EUC-KR over UTF-8 bytes, on the other hand, makes a parser fail outright.
 */
declare function ensureXmlEncoding(text: string): string;
/** True when the body really is RTF rather than text merely named .rtf. */
declare function looksLikeRtf(text: string): boolean;
/**
 * Escape every non-ASCII character into RTF's \uNNNN? form.
 *
 * RTF is 7-bit: a literal UTF-8 byte in the body is read through the codepage the
 * header declares, which is how Korean, Japanese and Cyrillic RTF turns to
 * mojibake in Word. \uNNNN? is codepage-independent.
 *
 * ASCII is never touched, which matters: backslashes and braces in an RTF body
 * are control syntax, and "escaping" them would destroy the document. \u takes a
 * SIGNED 16-bit value, so anything above 0x7FFF is emitted negative, and astral
 * characters are emitted as their two surrogates.
 */
declare function escapeRtfNonAscii(text: string): string;
/** Apply the format's encoding declaration to a whole document. */
declare function applyEncodingDeclaration(text: string, ext: string | null | undefined): string;
/**
 * Everything a client needs to turn a fenced ```name.ext block into a download:
 * the exact text to put in the Blob and the type to give it.
 */
declare function prepareDownloadText(filename: string, body: string): {
    ext: string;
    text: string;
    contentType: string;
};

/**
 * Pure link/path helpers (no DOM, no marked). Moved verbatim from the chatbox.
 * `projectId` is passed as a PARAMETER (the original read it from a global) so
 * the engine stays consumer-agnostic. The HTML-emitting helpers
 * (buildLinkPartFromGroups, linkToAnchorHtml, fileToAnchorHtml, parseMsgParts*)
 * stay in each VIEW — only these pure pieces move here.
 */
declare var EXPIRED_ATTACHMENT_URL_HOST: string;
declare var EXPIRED_ATTACHMENT_URL_ORIGIN: string;
declare var LINK_LABEL_MAX_DISPLAY_CHARS: number;
/**
 * Lifetime of the url minted when a user clicks an expired attachment chip.
 *
 * Mint it as a PLAIN get-db presign, never with generate_temporary_cdn_url: the
 * cdn branch ignores `expires` entirely and hands back a url good for the rest of
 * the current UTC day plus the next one, so a "20 minute" link would in fact live
 * 24 to 48 hours. The dashboard has always done this correctly and the widget did
 * not, which is precisely the kind of divergence a shared constant exists to stop.
 */
declare var EXPIRED_LINK_REFRESH_EXPIRES_SECONDS: number;
/**
 * Lifetime of the url minted for an inline image PREVIEW.
 *
 * Longer than the click url above, and for a different reason. A click hands the
 * user a url they may keep, so it stays short. A preview url is consumed by the
 * page itself and never leaves it, and it is the ONE lever on how long the
 * downloaded picture stays reusable: get_signed_url will not cache a mint for
 * longer than the credential inside it survives, so `browser_cache` cannot buy
 * local availability that `expires` has not paid for. Twenty minutes meant every
 * image re-downloaded three times an hour of ordinary reading.
 *
 * An hour, giving 55 minutes of cache once the server's five minute headroom is
 * taken off. Short enough that a leaked preview url is not a standing grant, long
 * enough that a conversation does not re-fetch its own pictures while the user is
 * still reading it.
 */
declare var PREVIEW_URL_EXPIRES_SECONDS: number;
/**
 * Seconds the browser may reuse a minted preview url (`browser_cache`).
 *
 * A presigned url is a fresh SigV4 query string on every mint, so it can never
 * be a browser cache key on its own and every reload re-downloads every image.
 * Asking for the MINT with a cacheable GET fixes it from the other end: the same
 * url comes back out of the browser cache, so the body already on disk stays
 * addressable.
 *
 * A CEILING, not a promise. get_signed_url caps what it grants at the lifetime of
 * the url inside the response (expires minus headroom, so 15 minutes for the
 * platform's 20 minute url), because a mint cached for longer than its own
 * credential is a guaranteed 403 that the browser keeps serving from its own
 * store. Asking for the week is still right: it says what this client would
 * reuse if the url were stable by construction, and the server decides.
 *
 * What keeps an image painting is the cached BODY, not a live url. Once the
 * browser evicts that body it refetches with a url that has since expired, gets a
 * 403, and the error path re-mints with `refresh` and mintCacheBustStamp. That
 * path is load-bearing, not a rare fallback.
 *
 * A week is the platform default for reading a private file, not a number chosen
 * here: skapi-js reads every private record file with
 * PRIVATE_FILE_BROWSER_CACHE_SECONDS = 7 days against the same 20-minute url, and
 * get_signed_url caps the header at BROWSER_CACHE_MAX_SECONDS = 7 days. A chat
 * that asked for a day was re-downloading images the rest of the product would
 * have served from disk.
 *
 * Applies to previews only. A CLICK must open a live url, so the chip refresh
 * stays on an uncached POST mint.
 */
declare var PREVIEW_BROWSER_CACHE_SECONDS: number;
/**
 * How long a client may keep serving an href it already minted before dropping
 * back to the placeholder and re-minting.
 *
 * DERIVED from the TTL above, with five minutes of headroom, because the
 * invariant "the cache must expire before the url does" used to be a comment
 * next to two independent literals. If it is ever violated a client serves a
 * dead url with no way to notice; deriving it makes that unrepresentable.
 */
declare var LINK_REFRESH_WINDOW_MS: number;
/**
 * Cache generation for the mint request url. BUMP THIS to abandon every mint
 * response browsers are currently holding.
 *
 * Generation 2 retires the entries written before 2026-08-11. Those were stored
 * with `max-age=604800` around a presign that dies in twenty minutes, so from
 * minute 21 each one is a guaranteed 403 that the browser keeps serving from its
 * own store for the rest of the week. The server no longer grants a lifetime a
 * url cannot back (get_signed_url resolve_browser_cache), but that fixes what is
 * written from now on and cannot reach what is already stored on a user's
 * device. Changing the url is the only thing that can: an entry nobody requests
 * again is an entry that cannot answer again.
 */
declare var MINT_CACHE_GENERATION: number;
/**
 * Window stamp for a REFRESH mint.
 *
 * WINDOWED, not Date.now(): a per-call stamp is a new cache key per image per
 * retry, which is what made the original `nocache` parameter worse than the
 * disease. One stamp per refresh window means every repair inside those minutes
 * shares a single entry, and it rotates before the url it carries can die.
 */
declare function mintCacheBustStamp(now?: number): number;
/**
 * The `nocache` value for a preview mint: the generation, plus a window stamp
 * when this mint is a repair.
 *
 * A repair MUST reach the origin, and the request header the clients used to
 * rely on cannot do it. `Cache-Control: no-cache` is not a CORS-safelisted
 * request header, and the record gateway's preflight answers
 * `Access-Control-Allow-Headers` WITHOUT it (verified against the live api on
 * 2026-08-11), so a mint carrying that header is rejected by the browser before
 * it is ever sent. Every repair therefore failed, in every browser, and the chip
 * went straight to "(unavailable)". Only a phone noticed, because only a phone
 * drops image bodies often enough to need the repair at all.
 *
 * A query parameter has no such problem: it is part of the url, so it needs no
 * preflight and no cooperation from the cache.
 */
declare function previewMintCacheToken(refresh?: boolean): string;
/**
 * How long before a presign dies we stop handing it out.
 *
 * A url served with one second left is a 403 with extra steps: the request still
 * has to reach S3, and an image body still has to start arriving.
 */
declare var PRESIGN_SAFETY_MARGIN_MS: number;
/**
 * When the url in hand actually dies, read out of the url itself, or null if it
 * carries no expiry we recognise.
 *
 * Every client-side cache here ages a url from the moment it ARRIVED, which is
 * only the same thing as its lifetime when the mint went to the network. Once
 * mint responses are cacheable that assumption breaks: a mint answered from the
 * browser's store can be nearly as old as its own max-age, and the client then
 * adds its own reuse window on top, so a 20 minute credential can be handed to an
 * <img> half an hour after it was signed. Asking the url when it dies removes the
 * stacking instead of trying to budget for it.
 *
 * Both signature versions, because the platform mints SigV2 through the host
 * bucket and SigV4 elsewhere.
 */
declare function presignExpiryEpochMs(url: string): number | null;
declare function createInlineLinkRegex(): RegExp;
declare function safeDecodeURIComponent(v: string): string;
declare function encodePathSegments(path: string): string;
declare function normalizeAttachmentPathCandidate(value: string): string;
declare function extractRemotePathFromAttachmentHref(href: string, projectId: string): string | null;
declare function getExpiredAttachmentVisiblePath(remotePath: string, fallback?: string): string;
declare function buildDisplayExpiredAttachmentHref(remotePath: string, fallback?: string): string;
declare function isServiceDbAttachmentHref(href: string, projectId: string): boolean;
/**
 * Read the storage path back out of an `_expired_.url` placeholder.
 *
 * The placeholder is not a display detail: sanitizeAttachmentLinksForHistory
 * writes it into PERSISTED history, and buildBoundedChatMessages replays it into
 * the model's context. So it round-trips constantly and MUST be recognised on the
 * way back in. Returns null for anything that is not the carrier.
 */
declare function readExpiredAttachmentHref(href: string): string | null;
declare function sanitizeAttachmentLinksForHistory(content: string, projectId: string, forAssistant?: boolean): string;
/**
 * Is this markdown link target a URL rather than a db storage path?
 *
 * The inline-link regex decides that by whether the target contains whitespace:
 * its url branch forbids it, its bare-path branch allows it (a db path really can
 * contain spaces). So a url that picked up a stray space anywhere in transit
 * falls out of the url branch and is claimed by the path branch, and the view
 * renders it as an `_expired_.url/https%3A/…` attachment chip that resolves to
 * nothing. The view asks this FIRST, so what a link IS never depends on damage.
 */
declare function isHttpUrlLike(target: string): boolean;
/**
 * Repair whitespace inside a url. RFC 3986 has no legal whitespace anywhere in a
 * URI, so a space in an href is always damage, never content.
 *
 * Two repairs, because the right one differs:
 *   - Our own `/download/<id>` capability links (skapi-mcp file-download.js) are
 *     base64url, optionally with a single `.` separating the payload and hmac of
 *     the older self-describing token. That alphabet cannot contain whitespace,
 *     so the spaces are purely damage and REMOVING them restores the exact link,
 *     which is what makes an already-sent message clickable again. A model
 *     reproducing one of these into its reply is exactly where the spaces come
 *     from, which is also why the id is now short.
 *   - Anything else keeps every character and only has the whitespace encoded,
 *     the same thing a browser does with a space in an href. Stripping would be
 *     wrong there: `…/exports/my report.csv` is a real file whose name has a
 *     space in it, and deleting it points at a file that does not exist.
 */
declare function repairUrlWhitespace(href: string): string;
/**
 * A model reproducing a URL sometimes HTML-escapes its `&` query separators as
 * `&amp;` (or the numeric `&#38;` / `&#x26;`). Left in the href that escaping
 * survives the client's own escapeAttr -> v-html/innerHTML decode round-trip and
 * reaches the browser LITERALLY, so a presigned S3 URL is navigated with its
 * parameters named `amp;Signature`, `amp;Expires`, `amp;response-content-type`,
 * ... — the real params vanish, the signature can't be located, and S3 rejects
 * it (the "링크가 안되" dead export link). Undo just that entity escaping.
 *
 * This is a no-op on a clean URL: a valid link carries a raw `&` between params
 * and percent-encodes (`%26`) any literal ampersand that is data, so a real URL
 * never contains `&amp;` to begin with. Mirrors repairUrlWhitespace: it repairs
 * model damage, not the URL. The loop collapses a doubly-escaped `&amp;amp;` too.
 */
declare function repairUrlEntities(href: string): string;
/**
 * Trim punctuation and unmatched wrappers that cling to a token in prose.
 * `src::a/b.pdf).` -> `src::a/b.pdf`, while a balanced `file (v2).pdf` is kept.
 */
declare function normalizeTrailingInlineToken(value: string): string;
/**
 * Extensions a BROWSER can paint in an <img>, mapped to the content type the
 * presign must declare.
 *
 * The content type is not optional here. get_signed_url only sets
 * ResponseContentType when the caller passes `contentType`, and otherwise falls
 * back to application/octet-stream, which a new tab DOWNLOADS instead of
 * displaying. Since the whole point of the preview is that clicking it shows the
 * picture, the mint has to name the real type.
 *
 * Deliberately narrower than the extraction/vision lists elsewhere in the repo:
 *   heic/heif out: Safari paints them, Chrome and Firefox show a broken image,
 *                  and it is the format every iPhone photo arrives in, so the
 *                  failure would be common and would read as a bug.
 *   tif/wmf/emf out: no mainstream browser paints them.
 *   svg        out: inside an <img> an SVG is script-disabled and safe, but this
 *                  feature's click target is a TOP-LEVEL navigation, where an
 *                  SVG executes its own <script> in the serving origin with that
 *                  origin's cookies, from user-uploaded content. A preview is an
 *                  invitation to click exactly that.
 */
declare var PREVIEWABLE_IMAGE_CONTENT_TYPES: Record<string, string>;
/** Extension of a path or url, query and fragment stripped, '' when none. */
declare function previewableExtOf(nameOrPath: string | null | undefined): string;
declare function isPreviewableImagePath(nameOrPath: string | null | undefined): boolean;
/** Content type to hand the presign so a new tab displays rather than downloads. */
declare function previewImageContentType(nameOrPath: string | null | undefined): string | null;
/** A link the view renders. `expired` means the href is the `_expired_.url`
 *  placeholder and a click must mint a fresh one from `remotePath`. */
interface InlineLinkPart {
    type: 'link';
    label: string;
    fullLabel: string;
    href: string;
    expired: boolean;
    expiredHref?: string;
    remotePath?: string;
    /**
     * Set only for a file WE host whose PATH says a browser can paint it. Its
     * presence IS the "render a preview" decision, so a view never re-tests the
     * label and never tests `href` (which is the _expired_.url placeholder).
     */
    image?: {
        ext: string;
        contentType: string;
    };
}
interface InlineLinkContext {
    /** Current project id: the leading segment to strip off a db url. */
    projectId: string;
    /** `https://db.<hostDomain>` for this deployment. */
    dbHostPrefix: string;
    /** A fresh url already minted for this placeholder, if the view cached one. */
    resolveFreshHref?: (expiredHref: string) => string | undefined;
}
/**
 * Decide what ONE inline-link regex match actually is, and how to render it.
 *
 * This is the single place that answers "is this an external url, this project's
 * db file, or a bare storage path", for every consumer. It used to live twice,
 * once in agent.vue and once in the widget, and both copies had to be found and
 * corrected for each of the link bugs this file's history records. A view now
 * supplies its own context (project id, db host, cached-href lookup) and does
 * nothing but turn the returned part into markup.
 *
 * `groups` is [g1..g6] from createInlineLinkRegex, in that order:
 *   g1 src::<token>   g2/g3 [label](url)   g4/g5 [label](path)   g6 bare url
 */
declare function classifyInlineLink(full: string, groups: Array<string | undefined>, ctx: InlineLinkContext): {
    part: InlineLinkPart;
    tail?: string;
} | null;
/**
 * "We asked for a url for this file and did not get one."
 *
 * A chip the client cannot mint a url for is not a link: the ↗ is a promise it
 * already knows it cannot keep, and clicking it opens a dead tab or nothing at
 * all. Both views therefore keep a map of failures and render those chips
 * unavailable (renderInlineLinkHtml's `unavailable` option): greyed, ✕ instead
 * of ↗, no href.
 *
 * The MAP lives in the view (agent.vue has to re-render when it changes, and
 * that means a ref), so only the keys are here. A failure is reported with
 * exactly one identifier (an image preview knows the storage path, a click knows
 * the placeholder href), so marking writes one key and the lookup tries all of
 * them.
 */
/**
 * Unicode form is not stable across the places a storage path travels through.
 *
 * macOS hands the browser a DECOMPOSED (NFD) filename, so a Korean name like
 * 운전면허-김대현.jpg arrives as 24 codepoints where the composed (NFC) form is 12.
 * Nothing in this engine normalized either way, so the SAME file could be keyed under
 * two different strings depending on which path it travelled: a mark left by a failed
 * mint under one form would never be cleared by a successful load under the other, and
 * the chip stayed greyed out as "(unavailable)" forever.
 *
 * NFC is the canonical choice: it is what the Unicode standard recommends for
 * interchange, and it is the shorter, more common form on the wire.
 */
declare function canonicalizePathForm(value: string): string;
declare function linkUnavailableKeyForPath(remotePath: string): string;
declare function linkUnavailableKeyForHref(href: string): string;
/**
 * Every key a stored file can be marked under, given only its path.
 *
 * Marking writes ONE key (whichever identifier the failing call had) and the
 * lookup ORs all of them, which is fine in one direction and wrong in the other:
 * a view that later learns the file is reachable knows only the path, and
 * clearing `path:` alone leaves a chip greyed by a failed CLICK (which marks
 * `href:` too) exactly as dead as before. The placeholder href is derived from
 * the path, so both keys can be rebuilt from it.
 */
declare function linkUnavailableKeysForPath(remotePath: string): string[];
declare function isLinkUnavailable(link: {
    href?: string;
    expiredHref?: string;
    remotePath?: string;
} | null | undefined, map: Record<string, boolean | undefined> | null | undefined): boolean;
declare function truncateLabelForDisplay(label: string): string;

/**
 * The chip / preview markup for one classified inline link.
 *
 * `classifyInlineLink` was consolidated into the engine because deciding what a
 * link IS had drifted between the two clients and every link bug had to be found
 * and fixed twice. The EMITTER stayed forked, byte for byte identical in
 * agent.vue and the widget. The image preview is the first behaviour that would
 * have had to be written twice, so the emitter moves here too.
 *
 * Pure string in, pure string out: no DOM, no globals, nothing reactive. That is
 * what lets agent.vue keep memoizing parseMsgParts on the message text alone.
 */
/** Neither client sanitizes bubble HTML (no DOMPurify, no marked sanitize), so
 *  everything interpolated here is escaped at the point of interpolation. */
declare function escapeInlineHtml(v: string | null | undefined): string;
/**
 * Previews per MESSAGE. Each one costs a presign call and an image download the
 * moment it is hydrated, and a reply listing a folder can name dozens. Past this
 * many the link renders as the ordinary text chip.
 */
declare var IMAGE_PREVIEWS_PER_MESSAGE: number;
/**
 * The glyph IS the promise: ↗ says "click this and the file opens". When the
 * client could not get a url for the file, keeping that glyph on a chip it knows
 * is dead is the bug: the click either opens a tab on a 403/404 or, once the
 * href is gone, does nothing at all with no explanation. ✕ says what happened.
 */
declare var INLINE_LINK_GLYPH: string;
declare var INLINE_LINK_UNAVAILABLE_GLYPH: string;
declare var INLINE_LINK_UNAVAILABLE_SUFFIX: string;
/** Widened so each client's local link-part type is assignable. */
interface RenderableInlineLink {
    label: string;
    fullLabel?: string;
    href: string;
    expired: boolean;
    expiredHref?: string;
    remotePath?: string;
    image?: {
        ext: string;
        contentType: string;
    };
}
interface InlineLinkMarkupOptions {
    /** The view's own "a mint is in flight for this href" flag. */
    refreshing?: boolean;
    /** False once the caller has spent its per-message preview budget. */
    allowImagePreview?: boolean;
    /**
     * The view already tried to get a url for this file and failed (see
     * isLinkUnavailable). Renders a dead chip: ✕, greyed, no href.
     */
    unavailable?: boolean;
}
declare function renderInlineLinkHtml(link: RenderableInlineLink, opts?: InlineLinkMarkupOptions): string;

/**
 * Give a rendered preview <img> a real src.
 *
 * Why this is not part of the parse: every stored file classifies as
 * `expired: true` with the _expired_.url placeholder as its href, so the url an
 * <img> needs does not exist until something mints it. agent.vue memoizes its
 * parse on the raw message text and drops that cache whenever its link maps
 * change, so minting THROUGH those maps would clear the whole cache once per
 * image and re-run marked over the entire conversation each time. The mint
 * therefore lives here, in a cache that is not reactive and is never read by the
 * parse, and the src is written straight onto the element after render.
 *
 * DOM-free like the rest of the engine: the element type is structural, so a
 * real HTMLImageElement satisfies it while this file imports nothing from
 * lib.dom and touches no global.
 */
interface PreviewImageEl {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    addEventListener(type: string, cb: () => void): void;
}
interface ImagePreviewContext {
    /** Project id. Namespaces the cache, see clearImagePreviewCache. */
    scope: string;
    /**
     * Mint a directly loadable url for a storage path.
     *
     * `contentType` is not advisory. get_signed_url only sets
     * ResponseContentType when the caller passes one and otherwise falls back to
     * application/octet-stream, which a new tab DOWNLOADS instead of displaying.
     * An implementation that drops this argument still paints the preview (an
     * <img> sniffs the bytes) but silently breaks the click.
     *
     * `refresh` asks for a url the browser cache cannot answer. The mint request
     * itself is cacheable (that is what stops a reload re-downloading every
     * image), so a plain re-mint can hand back the very url that just failed;
     * refresh is how the caller escapes its own cache.
     */
    mint: (remotePath: string, contentType: string, refresh?: boolean) => Promise<string>;
    /** An image finished painting. Views use it to re-pin the scroll. */
    onLoad?: (remotePath: string) => void;
    /** A preview gave up. The caption chip is now the whole answer. */
    onError?: (remotePath: string, err: unknown) => void;
    /**
     * This element's box just changed size, and nothing asked it to.
     *
     * Fires at the points where a preview resizes with NO DOM event of its own to
     * announce it: the src lands (a src-less <img> is hidden, so this is where it
     * starts taking space), and the src is dropped for a retry, or a mint fails
     * outright, where an already-painted picture collapses back to nothing.
     * `load` and `error` are deliberately NOT routed through here — both views
     * listen for those on the message box itself, which is also how they cover the
     * images this module never sees, a markdown `![alt](url)` among them.
     *
     * Each of these slides everything below the element, and for a reader scrolled
     * up into history that is a jump in the middle of a sentence. onLoad cannot
     * stand in for it: both views answer that with a scroll-to-bottom-if-pinned,
     * which by definition does nothing for the reader this hurts.
     *
     * Views wire this to their scroll anchor's absorb(). Called SYNCHRONOUSLY, so
     * the measurement it takes is the one the reader is looking at.
     */
    onLayoutChange?: (img: PreviewImageEl, remotePath: string) => void;
}
/**
 * Drop cached preview urls, for one project or all of them.
 *
 * The key carries the project because an identity-blind cache is how one
 * project's content has reached another project's chat before. Call on project
 * switch and on sign-out.
 */
declare function clearImagePreviewCache(scope?: string): void;
/**
 * A url we already hold that is still comfortably alive, or null.
 *
 * Synchronous on purpose. Both views rebuild bubble DOM constantly (the widget
 * tears down and re-creates every node in renderMessages; Vue re-patches v-html
 * whenever the string changes), so an async-only assignment would blank every
 * visible image for a frame on each re-render. Called before paint, this makes a
 * re-render invisible.
 */
declare function peekImagePreviewUrl(ctx: ImagePreviewContext, remotePath: string): string | null;
/**
 * Deduped, TTL-bounded mint for one path.
 *
 * `refresh` skips every cache in the way: this module's in-memory one, and the
 * browser's cache of the mint request itself. It is what the error path uses to
 * replace a url that has expired, and what a view would call to pick up a file
 * that changed.
 */
declare function resolveImagePreviewUrl(ctx: ImagePreviewContext, remotePath: string, contentType: string, refresh?: boolean): Promise<string>;
/**
 * Declare a stored file changed, so the next mint for it goes to the network.
 *
 * The mint request is browser-cached, which is what stops a reload re-downloading
 * every image, but it also means an OVERWRITE is invisible: the file is re-posted
 * to the same storage path, so the mint url is byte-identical, so the browser
 * replays the cached mint and hands back the same signed url and the same cached
 * body. The preview would keep painting the previous picture for a day.
 *
 * Upload paths call this because they are the one place that KNOWS the bytes
 * changed. It is a marker, not a fetch: the refresh happens on the next mint,
 * which is when the new bubble actually renders. In memory only, deliberately.
 */
declare function markImagePreviewStale(scope: string, remotePath: string): void;
/**
 * Hydrate every un-claimed preview <img> in the given list.
 *
 * Idempotent: an element is claimed by its own data-bq-img-state, so a full
 * re-render, a Vue patch, or two calls in one frame cannot mint twice. The
 * caller decides WHICH elements to pass, so a view can move from
 * querySelectorAll to an IntersectionObserver without an engine change.
 */
declare function hydrateImagePreviews(imgs: ArrayLike<PreviewImageEl>, ctx: ImagePreviewContext): void;
declare var PREVIEW_LAYOUT_BOX_SELECTOR: string;
/** The element whose height a preview's own transitions actually change. */
declare function previewLayoutBox<T extends PreviewImageEl>(img: T): T;

/**
 * Chat timestamp formatting, shared so agent.vue and the widget render an
 * identical "small text under the bubble". Pure and locale-aware: it formats a
 * given epoch-ms value, it never reads the current time, so it stays testable and
 * DOM-free.
 */
/** Wall-clock epoch ms. Separate from the engine's monotonic nowMs() (which is
 *  performance.now() when available and therefore NOT epoch): a displayed
 *  timestamp must be wall time. */
declare function wallClockNow(): number;
/**
 * "Jul 24, 2026, 3:42:07 PM" (locale-formatted). Empty string for a missing or
 * non-finite value, so a caller can gate rendering on the result being truthy and
 * a pending bubble (no timestamp yet) simply shows nothing.
 */
declare function formatChatTimestamp(ms?: number): string;

/**
 * The `ai_agent` service option, parsed and serialized in ONE place.
 *
 * Stored on the skapi service record as up to three '#'-delimited segments:
 *
 *   none                                  AI chat disabled
 *   claude                                platform chosen, no model saved yet
 *   claude#claude-sonnet-4-6              platform + model
 *   claude#claude-sonnet-4-6#400000       platform + model + context-window override
 *
 * The third segment is new and optional, so every value written before it
 * existed parses unchanged with `contextWindow: null`. Nothing writes a third
 * segment without a model, because the window is meaningless without one.
 *
 * This lived as four separate copies (agent.vue, dbfile.vue, service.vue, and
 * the widget's index.js), which is how the format drifts. New callers should
 * import from here rather than re-deriving the split.
 */
type AiAgentPlatform = 'claude' | 'openai' | null;
type ParsedAiAgent = {
    /** null when unset or explicitly 'none'. */
    platform: AiAgentPlatform;
    /** '' when no model has been saved. */
    model: string;
    /** Per-project context-window override in tokens, or null to use the model's. */
    contextWindow: number | null;
    /** True when a real platform is configured (i.e. not unset and not 'none'). */
    hasPlatform: boolean;
};
declare function parseAiAgentValue(value: string | null | undefined): ParsedAiAgent;
declare function buildAiAgentValue(platform: string | null | undefined, model?: string | null, contextWindow?: number | null): string;

/**
 * Streamed-turn parser: raw provider SSE bytes in, live answer text + the body a
 * buffered call would have returned out.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS HERE AND NOT IN SKAPI.
 * skapi's clientSecretRequest is a byte relay. On a streamed turn the worker reads
 * the destination's response incrementally and appends the raw bytes to a chunk
 * table; it settles the polling row with STATUS ONLY, no body, because the content
 * lives in the chunks. skapi therefore does not know that Anthropic or OpenAI
 * exist, has no dialect list, and parses nothing. BunnyQuery is the party that
 * knows which destination it dialled, so BunnyQuery is the party that parses, and
 * this module is the whole of that knowledge.
 *
 * WHAT ARRIVES. csr-poll hands back `chunks: [{seq, txt}]` (ascending, seq starts
 * at 1) plus `last_seq` to send back as the next `since`. A chunk is whatever the
 * worker's flush happened to contain: it flushes on a byte cap or a time interval,
 * so a chunk boundary lands wherever the socket broke, which is routinely in the
 * MIDDLE of an SSE frame. Half a frame is not data, so every partial is held in a
 * buffer until the rest arrives, and nothing is ever emitted from an incomplete
 * frame. That is what makes this a stateful object fed chunks rather than a
 * function over a whole transcript.
 *
 * REPLAY SAFETY. The parser is a pure function of the chunk SEQUENCE, so a reload
 * or a second tab that starts at seq 1 of a stream it did not initiate rebuilds
 * the identical state. Nothing here depends on having dispatched the request.
 *
 * THE TWO OUTPUTS, AND WHY BOTH ARE NEEDED.
 *   text        the assistant's answer ONLY, for rendering as it arrives. Not tool
 *               arguments, not thinking. Concatenating every delta into one string
 *               is how a half serialised tool call ends up in the middle of a
 *               user's sentence.
 *   finalBody() the assembled provider body, byte equivalent to the buffered
 *               response, so extractClaudeText / extractOpenAIText (requests.ts)
 *               produce the identical string whether the turn was read live or
 *               re-read from history later.
 *
 * THE BUG THIS IS SHAPED AROUND. extractClaudeText joins TEXT BLOCKS with '\n':
 *
 *     content.filter(b => b.type === 'text').map(b => b.text).join('\n')
 *
 * A server-tool turn has text at content index 0, the tool call at 1, its result
 * at 2, and text again at 3. Accumulate every text_delta into one string and those
 * two paragraphs fuse with no separator, so the answer the user watched arrive and
 * the same turn re-read from history are different strings. Blocks are therefore
 * keyed BY INDEX and never merged, and `text` is the join of the text blocks in
 * index order, which is exactly the extractor's rule and not an approximation of
 * it. See tests/sse-stream.cjs, "four separate blocks".
 *
 * NEVER THROWS FROM feed(). Chunks arrive on a poll tick, inside a timer the
 * consumer cannot reasonably wrap; a parse error there would take the whole poll
 * down over one malformed frame. Frames that cannot be understood are counted
 * (`malformedFrames`) and skipped.
 *
 * HONEST TERMINATION, AND WHY IT TAKES TWO FLAGS. `complete` means a terminal event
 * actually arrived. A stream that was cut (deadline, cancelled row, a worker crash
 * after some chunks landed) reports complete:false, and the caller must not present
 * it as a finished answer. A partial answer the reader can see beats an empty turn,
 * but only if it is labelled as partial.
 *
 * That flag alone used to be read as "the answer is whole", and it is not the same
 * claim. An `error` frame IS a terminal event: the provider said the stream is over
 * and nothing more is coming. But the text in hand is only whatever arrived before
 * the error, so the answer is TRUNCATED and the stream is FINISHED at the same
 * time. A caller whose finalize gate read `complete` therefore stored the
 * truncation as the turn's permanent history and, because finalize is also the only
 * way to release chunks, deleted the only copy of the bytes in the same call - for
 * a turn the provider had explicitly told it went wrong. So the two claims are two
 * fields:
 *
 *   complete        a terminal event arrived. Nothing more is coming; stop waiting.
 *   answerComplete  ...and it was a terminal event that means the answer FINISHED
 *                   (message_stop, response.completed, response.incomplete), not
 *                   one that means it DIED (an `error` frame, response.failed, a
 *                   terminal Response carrying an error payload).
 *
 * `response.incomplete` is deliberately on the finished side: the model stopped
 * short at max_output_tokens, but the terminal event carries the complete Response
 * document, so the chunks hold nothing the body does not. A caller deciding what to
 * keep reads `answerComplete`; a caller deciding whether to keep waiting reads
 * `complete`.
 *
 * WHEN THE BYTES ARE NOT SSE AT ALL. skapi's `stream: true` tells the RELAY to read
 * the response incrementally. It does not tell the destination to produce an event
 * stream: that is the caller's own request body. If the body never asked for one
 * (or something in front of the destination buffers the stream back into a single
 * document and drops the framing), the answer arrives as a plain JSON body with not
 * one `data:` line in it. Every frame test below then matches nothing, and the turn
 * used to end as an empty answer with malformedFrames 0, complete false and
 * finalBody() null: the entire reply lost, with nothing in the output saying so, so
 * a client draws an empty bubble and no error. That state is now reported as
 * `unframed`, and the bytes are handed back BOTH ways, because the parser cannot
 * tell an answer from a gateway's error page without knowing the vendor, and it
 * must not:
 *   unframedText  the bytes verbatim, for a body that is not JSON at all (an HTML
 *                 502 page), which finalBody() cannot represent.
 *   finalBody()   the parsed document when the bytes ARE JSON, because a buffered
 *                 body is exactly what finalBody() promises, so the caller's
 *                 existing buffered path (isErrorResponseBody, extractClaudeText,
 *                 extractOpenAIText) reads it with no new branch at all.
 * Noticing that a byte stream carries no SSE framing is framing, not parsing, and
 * JSON.parse is the same transport-level codec this file already runs on every
 * frame payload. Nothing about the document is interpreted: it is handed over
 * whole, and `provider` stays null because no event ever identified one.
 *
 * DOM-free and framework-free like the rest of the engine.
 */
/** One row of csr-poll's `chunks`. */
interface SseChunk {
    seq: number;
    txt: string;
}
/**
 * Which grammar the bytes turned out to be in. Detected, never declared: see
 * detectProvider() below for why the caller is not asked.
 */
type SseProvider = 'claude' | 'openai';
/**
 * A tool the model reached for, in the order it appeared, so a "querying sales
 * table..." row can be drawn before a single character of answer text exists.
 * Duplicates are kept: two calls to the same tool are two rows, not one.
 */
interface SseToolCall {
    /** Anthropic content index, or OpenAI output index. Identifies the block. */
    index: number;
    /** The name as the provider wrote it, falling back to the block/item type for
     *  a built-in that carries no name of its own (OpenAI's web_search_call). */
    name: string;
    /** The provider's own block/item type: tool_use, server_tool_use,
     *  mcp_tool_use, function_call, mcp_call, web_search_call, ... */
    type: string;
    /** Present on Anthropic mcp_tool_use only. */
    serverName?: string;
}
interface SseSnapshot {
    /** null until the first identifying event has been seen. */
    provider: SseProvider | null;
    /** The assistant's answer text so far, joined exactly as the extractor joins
     *  it. Never contains tool arguments or thinking. */
    text: string;
    /** Extended-thinking text so far, for a "thinking..." affordance. Deliberately
     *  a SEPARATE field: it must never be concatenated into `text`. Populated on
     *  BOTH providers (Anthropic thinking blocks, OpenAI reasoning summary and
     *  reasoning text deltas). It used to be Anthropic-only, which meant the field
     *  read as "the model's thinking" on one provider and as "this model did not
     *  think" on the other, and every consumer that did not branch on `provider`
     *  drew the wrong thing. Absorbing exactly that branch is what this module is
     *  for, so the field is filled rather than renamed. */
    thinkingText: string;
    /** Tools reached for, in order of appearance. */
    toolCalls: SseToolCall[];
    /** Convenience projection of toolCalls, same order, duplicates kept. */
    toolNames: string[];
    /** Anthropic stop_reason ('end_turn' | 'tool_use' | 'max_tokens' | ...), or for
     *  OpenAI the terminal Response's status, or its incomplete_details.reason when
     *  it stopped short ('max_output_tokens'). null until the stream says. */
    stopReason: string | null;
    /** A terminal event ARRIVED. False means the stream was cut and whatever is
     *  here is partial: do not present it as a finished answer.
     *
     *  THIS IS NOT THE FLAG TO STORE BY. It answers "is anything more coming?", not
     *  "is this the whole answer?" - see `answerComplete`. */
    complete: boolean;
    /** The terminal event that arrived means the answer FINISHED, not that it DIED.
     *
     *  True on message_stop, response.completed and response.incomplete; false while
     *  the stream is still running, false when it was cut, and false when it ended
     *  on an `error` frame, on response.failed, or on a terminal Response carrying
     *  an error payload.
     *
     *  THE FAILURE THIS FIELD EXISTS FOR. An `error` frame sets `terminalEvent`, so
     *  `complete` goes true while the text is only what arrived before the error. A
     *  caller that finalizes on `complete` therefore writes that truncation into the
     *  turn's permanent history AND releases the chunks it was assembled from, which
     *  is the one loss in this feature that cannot be undone. Every keep/store gate
     *  reads THIS field; `complete` is for deciding whether to keep waiting. Bytes
     *  that were never SSE at all reach neither: see `unframed`, where it is the
     *  polling row's status and not the parse that says the response finished. */
    answerComplete: boolean;
    /** The exact terminal event: 'message_stop', 'response.completed',
     *  'response.incomplete', 'response.failed', 'error'. null while running. */
    terminalEvent: string | null;
    /** The stream ended in a provider error. */
    errored: boolean;
    /** The provider's error payload, in the shape isErrorResponseBody() detects. */
    error: any;
    /** Frames that could not be parsed, and tool-argument JSON that would not
     *  parse at content_block_stop. Diagnostics: both are zero on a healthy turn. */
    malformedFrames: number;
    malformedToolJson: number;
    /** Bytes were relayed, end() was called, and NOT ONE of them was SSE framing:
     *  no `data:`, no `event:`, not even a comment. The destination answered with a
     *  plain body instead of an event stream. This is NOT malformedFrames: there
     *  were no frames to mangle. Nothing is lost, `unframedText` is the bytes and
     *  finalBody() is the parsed document when they are JSON, so the caller can
     *  either render them through its buffered path or surface a real error.
     *  `complete` stays false here because no terminal EVENT arrived and none ever
     *  will: on an unframed body it is the polling row's own status, not the bytes,
     *  that says whether the response finished. */
    unframed: boolean;
    /** The relayed bytes verbatim when `unframed`, else null. */
    unframedText: string | null;
    /** Highest chunk seq accepted, for the caller's `since` cursor. 0 = none. */
    lastSeq: number;
}
interface SseParser {
    /** Feed raw bytes. Any prefix of a frame is held until the rest arrives. */
    feed(text: string): void;
    /** Feed csr-poll's `chunks` array. Chunks at or below the highest seq already
     *  accepted are DROPPED, so a re-poll from a stale `since` cannot double-append
     *  the same bytes into the answer. */
    feedChunks(chunks: SseChunk[] | null | undefined): void;
    /** No more bytes are coming. Flushes a final frame that arrived without its
     *  terminating blank line. Does NOT mark the stream complete: only a terminal
     *  event does that. It IS what decides `unframed`, because up to this call
     *  "no framing seen yet" and "the first frame has not finished arriving" are
     *  the same state, so a caller that never calls end() never learns the bytes
     *  were not SSE. */
    end(): void;
    snapshot(): SseSnapshot;
    /** The assembled provider body, byte equivalent to a buffered response, or
     *  null when nothing has been assembled. See buildBody() for the two rules:
     *  one about errors, one about bytes that were never SSE. */
    finalBody(): any;
}
declare function createSseParser(): SseParser;

declare const MCP_NAME = "BunnyQuery";
declare const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
declare const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
/**
 * THE two `stream` flags of a streamed chat turn, produced together or not at all.
 *
 * There are two of them and they are NOT the same flag:
 *
 *   * `transport.stream` is SKAPI's. It tells the polling worker to read the
 *     destination's response incrementally and append the raw bytes to the chunk
 *     table, and it is never sent on to the destination.
 *   * `body.stream` is the DESTINATION's own field, and BunnyQuery is the party
 *     that may set it: skapi relays bytes and knows no vendor, so it cannot know
 *     that Anthropic Messages and OpenAI Responses both happen to spell it
 *     `stream` at the top level of the body.
 *
 * Setting one without the other fails QUIETLY, which is why they are produced by
 * one function from one boolean and returned as one object:
 *
 *   * body streams, skapi buffers -> the row stores an SSE TRANSCRIPT where
 *     extractClaudeText / extractOpenAIText expect a parsed document, so the turn
 *     reads back as an empty answer with nothing in the logs to say why.
 *   * skapi streams, the body never asked -> the destination sends one plain
 *     document, the relay chops it into chunks, the frame parser finds no framing
 *     at all, and the row settles with a status and no body.
 *
 * Two frozen constants rather than a fresh object per call: the pair is a
 * CONSTANT, and an object literal built at each call site is exactly the shape
 * that drifts when someone edits one arm.
 */
type ChatStreamWiring = {
    /** Spread into the clientSecretRequest OPTIONS (skapi's relay switch). `realtime`
     *  belongs here and never in `body`: it is skapi's, not the destination's. */
    transport: {
        stream?: true;
        realtime?: true;
    };
    /** Spread into `data` (the destination's own switch). */
    body: {
        stream?: true;
    };
};
declare function chatStreamWiring(queue?: string): ChatStreamWiring;
/** How a given model should be shown a rendered document. */
type VisionProfile = {
    /** Per-image `detail` (OpenAI only). */
    detail: string;
    /** Pages the worker renders into one window. */
    pagesPerWindow: number;
    /** Horizontal bands per page; 1 renders the whole page as one image. */
    tile: number;
};
/**
 * Resolve the render profile for a model.
 *
 * Three tiers, and they fail for different reasons, which is why one set of knobs cannot
 * serve all of them:
 *   - full: everything ABOVE gpt-5.4-nano - the base models, mini, and every gpt-5.6
 *     including 5.6-nano. These already transcribe dense scans correctly, so they get
 *     'original' detail and are otherwise untouched.
 *   - gpt-5.4-nano: also gets 'original', so it sees exactly the SAME pixels as the full
 *     tier. Its gap therefore is not resolution, and tiling would do nothing for it. What
 *     it lacks is room: a smaller window leaves the same output budget divided between
 *     fewer pages.
 *   - downsampled (below the 'original' floor: gpt-5.3-nano, gpt-5-nano, gpt-4.1-nano):
 *     capped at 'high', which resamples the page onto a 512px grid no matter what DPI it
 *     was rendered at. Render resolution is wasted on these entirely; the only way to give
 *     them readable text is to make each image cover less of the page, which is `tile`.
 */
declare function getVisionProfile(model?: string): VisionProfile;
type ClaudeRole = 'user' | 'assistant';
type ClaudeMessage = {
    role: ClaudeRole;
    content: string;
};
type OpenAIMessage = {
    role: ClaudeRole;
    content: string;
};
type ClaudeMcpToolConfig = {
    enabled?: boolean;
    defer_loading?: boolean;
};
type ClaudeMcpServerRequest = {
    name: string;
    url: string;
    authorizationToken?: string;
    defaultConfig?: ClaudeMcpToolConfig;
    configs?: Record<string, ClaudeMcpToolConfig>;
};
declare function transformContentWithImages(content: string): string | Array<Record<string, any>>;
declare function transformContentWithOpenAIImages(content: string, detail?: string): string | Array<Record<string, any>>;
type CallClaudeWithMcpParams = {
    prompt: string;
    messages?: ClaudeMessage[];
    service: string;
    owner: string;
    userId?: string;
    model?: string;
    maxTokens?: number;
    system?: string;
    mcpServer: ClaudeMcpServerRequest;
    extractContent?: ExtractDirective[];
    fileUrls?: FileUrlDirective[];
    onResponse?: (res: any) => void;
    onError?: (err: any) => void;
};
declare const POLL_INTERVAL = 3000;
declare const STREAM_POLL_INTERVAL = 1000;
declare const MAX_CONCURRENT_BG_POLLS = 6;
declare function callClaudeWithMcp({ prompt, messages, service, owner, userId, model, maxTokens, system, mcpServer, extractContent, fileUrls, }: CallClaudeWithMcpParams): Promise<any>;
declare function callClaudeWithPublicMcp(prompt: string, service: string, owner: string, messages?: ClaudeMessage[], system?: string, model?: string, userId?: string, extractContent?: ExtractDirective[], fileUrls?: FileUrlDirective[], onResponse?: (res: any) => void, onError?: (err: any) => void, mcpScope?: {
    anonymous?: boolean;
    publicProjectId?: string;
}): Promise<any>;
declare function callOpenAIWithPublicMcp(prompt: string, service: string, owner: string, messages?: OpenAIMessage[], system?: string, model?: string, userId?: string, extractContent?: ExtractDirective[], fileUrls?: FileUrlDirective[], onResponse?: (res: any) => void, onError?: (err: any) => void, mcpScope?: {
    anonymous?: boolean;
    publicProjectId?: string;
}): Promise<any>;
type AttachmentSaveInfo = {
    platform: 'claude' | 'openai';
    model?: string;
    service: string;
    /** The PUBLIC project ID (formatted token, skapi.project_id). Shown to the model; falls back to `service`. */
    publicProjectId?: string;
    owner: string;
    /**
     * Queue base for this indexing pass: "<userId>-bg". REQUIRED, and it must be
     * the SAME value the chat turn uses (ChatSession.dispatchComposedMessage's
     * `id.userId || id.projectId`) — the backend serialises requests that share a
     * queue name and runs different ones IN PARALLEL, so a pass enqueued under a
     * different base does not hold the chat back at all. It was optional once,
     * defaulting to `service`; the chatbox omitted it, and its files were indexed
     * on "<projectId>-bg" while its question ran on "<userId>-bg" — the question
     * was answered from a file nothing had read yet. Pass `userId || projectId`.
     */
    userId: string;
    serviceName?: string;
    serviceDescription?: string;
    attachment: {
        name: string;
        storagePath: string;
        mime?: string;
        size?: number;
        url: string;
        /**
         * Access group this file's records are written at (the uploader's choice,
         * already applied to the "src::" record). Threaded into the indexing
         * prompts so the agent's own records land in the same group; omitted
         * means "authorized", the group everything used before the setting existed.
         */
        accessGroup?: 'public' | 'authorized' | 'private';
    };
    /**
     * Content parsed CLIENT-SIDE by an attachment-parser plugin (e.g. an .hwp
     * parser). When set, it is inlined into the indexing message verbatim and
     * takes precedence over server-side office extraction / web_fetch.
     */
    parsedContent?: string;
    /**
     * True for a RESUME pass: a previous indexing pass could not finish this (large)
     * file, so continue it - always via readFileContent paging, with a "continue"
     * message telling the agent to resume from where the saved records leave off.
     */
    continueIndexing?: boolean;
    /**
     * For an image-vision file (PDF), the 0-based PAGE the render window should start at.
     * The worker renders [renderFrom, renderFrom+RENDER_PAGES_PER_WINDOW) and injects them
     * as image blocks; the resume loop advances this by a window each pass.
     */
    renderFrom?: number;
};
declare function notifyAgentSaveAttachment(info: AttachmentSaveInfo): Promise<any>;
declare function extractClaudeText(response: any): any;
declare function extractOpenAIText(response: any): any;
declare function listClaudeModels(service: string, owner: string): Promise<any>;
declare function listOpenAIModels(service: string, owner: string): Promise<any>;
declare const BG_INDEXING_QUEUE_SUFFIX = "-bg";
/**
 * unique_id of the durable "indexing finished" marker record for a stored file.
 *
 * Written by the BACKEND (the polling worker calls the MCP server's
 * /internal/index-complete at the end of an auto_continue chain whose final
 * window reported no more content) and, for completions a client knows
 * deterministically (single-pass settle, client-chain completion token), by the
 * consumer's mintIndexDoneMarker hook — never by the model.
 * The marker record carries `reference: "src::<path>"`, so the reindex flow's
 * delete of the src:: record cascades to it and a re-run starts unmarked.
 *
 * Existence semantics: present = the whole file was read to the end. Absent =
 * unknown (still running, failed partway, indexed before this marker existed,
 * or a single-pass run minted before the client hook existed) - callers must
 * fall back to the live-queue probe (fetchLiveIndexingKeys) before reading
 * absence as anything.
 */
declare function indexDoneUniqueId(storagePath: string): string;
/**
 * unique_id of the per-file indexing RUN record.
 *
 * One record per storage path, newest run wins (a reindex's delete-then-repost
 * of src:: cascade-deletes the old record first, exactly like done::). Minted
 * status='working' by the client the moment it enqueues a run's FIRST pass, and
 * closed (done/error/cancelled) by whichever side observes the ending: the
 * worker via the MCP internal routes for worker-driven chains, the client for
 * deterministic settles, cancels, and dispatch failures. It exists so chat rows
 * and files-page badges can answer "which runs exist and how did they end"
 * from ONE records query instead of scanning bg history.
 *
 * A 'working' record is a claim, not proof: a chain that dies without reaching
 * any error path leaves it dangling, so readers must treat a stale 'working'
 * (old `started`, no live-queue confirmation) as unknown, never as live.
 */
declare function runIndexUniqueId(storagePath: string): string;
type IndexRunStatus = 'working' | 'done' | 'error' | 'cancelled';
type IndexRunPatch = {
    status: IndexRunStatus;
    filename?: string;
    started?: number;
    finished?: number;
    error?: string;
    queue?: string;
    /** Chat that owns this run. A run:: record is keyed by storage path alone,
     *  but a chat is per (project, platform) — without this the Claude chat's
     *  runs surfaced as rows in the same project's ChatGPT chat, where their
     *  passes can never load and the queue probe can never see them. */
    platform?: 'claude' | 'openai';
};
/**
 * Fire-and-forget wrapper over the consumer's upsertIndexRunRecord hook.
 * Safe everywhere: missing hook, unconfigured engine, and consumer throws all
 * reduce to a no-op — a run record must never be able to break the run itself.
 */
declare function upsertIndexRunRecordSafe(service: string, storagePath: string, patch: IndexRunPatch): void;
/**
 * The one place the background-indexing queue name is spelled out. The backend
 * serialises requests sharing a queue name and runs different names in PARALLEL,
 * so every indexing pass AND the chat turn that must wait behind them have to
 * resolve to the identical string — see AttachmentSaveInfo.userId for what
 * happens when they do not.
 */
declare function bgIndexingQueueName(userId?: string, service?: string): string;
/**
 * True when a request belongs to the background-indexing queue.
 *
 * Accepts BOTH shapes this value arrives in: the bare queue name the client sends
 * ("<userId>-bg"), and the server qid that comes back on history/poll responses
 * ("<service>:<queue>|<seq>"). Testing the tail of the raw value only works for the
 * first: a qid ends in "|<seq>", so `endsWith('-bg')` is always false for it — which
 * silently meant history items were NEVER recognised as background tasks.
 */
declare function isBgIndexingQueue(queueName?: string): boolean;
type BgTaskEntry = {
    projectId: string;
    platform: 'claude' | 'openai';
    id: string;
    filename: string;
    storagePath?: string;
    isReindex?: boolean;
    mime?: string;
    size?: number;
    status: 'running' | 'pending';
    poll: ((opts: {
        latency: number;
    }) => Promise<any>) | undefined;
    /** How many CONTINUE passes have already run for this file (resume-across-passes). */
    resumePass?: number;
    /** The STAGED chat turn these files were attached to (ChatSession.stageOutgoingMessage).
     *  drainBgTaskQueue inserts this pass's bubble directly ABOVE that turn's bubble, so the
     *  collapsed row sits where the reader expects it — right before the message the files
     *  came with — from the moment it appears, instead of the turn being moved down past it
     *  once everything finishes. Absent for work with no chat turn behind it (the dbfile
     *  page, an attachment-only send, a worker-adopted pass), which appends as before. */
    stageId?: string;
};
declare const INDEXING_COMPLETE_MARKER = "INDEXING_COMPLETE";
declare const EMPTY_INDEXING_REPLY = "Finished reading this file.";
/**
 * `queue` narrows the fetch to one processing chain; `status` narrows it to items
 * in one state. Passing both is how the client asks "is there still unresolved
 * work on the background-indexing queue?" without pulling a page of chat history
 * (see ChatSession._adoptWorkerIndexingPasses) — the server answers that from a
 * status-keyed index, so the reply carries only the live items, not the bodies of
 * everything already finished.
 */
declare function getChatHistory(params: {
    service?: string;
    owner?: string;
    platform: 'claude' | 'openai';
    queue?: string;
    status?: 'pending' | 'running' | 'resolved' | 'failed';
    /** Exact-queue listing: without it the qid range is a PREFIX match, so
     *  queue "u1" also returns "u1-bg" rows. Requires the updated polling
     *  lambda; older backends ignore it (harmless, wider results). */
    queue_exact?: boolean;
    /** Label/marker STUBS instead of full bodies (see the polling lambda).
     *  Older backends ignore it and return full items. */
    compact?: boolean;
    /** Drop one queue's rows from an id-prefix listing — how the surface
     *  chat is fetched WITHOUT the bg-indexing queue while legacy items on
     *  odd queue names survive. Older backends ignore it. */
    queue_exclude?: string;
}, fetchOptions: Record<string, any>): Promise<any>;
/** Full server-side id of one history item, for a csr-poll POINT LOOKUP (the
 *  single-item path returns the item WITH bodies — how an expanded row fetches
 *  the passes a compact listing stubbed out). Mirrors the id the SDK builds:
 *  `[METHOD]url#service:` + the item's own `stamp:entropy` id. */
declare function buildHistoryItemFullId(platform: 'claude' | 'openai', service: string, itemId: string): string;

/**
 * ChatSession host adapter + state types.
 *
 * ChatSession is DOM-free and Vue-free; the consumer (bunnyquery widget or the
 * agent.vue chatbox) implements `ChatHost` to bridge identity, rendering, scroll,
 * and the skapi cancel/refresh surface. Everything the session needs that would
 * otherwise touch the DOM or a framework goes through a host hook.
 */
interface ChatIdentity {
    projectId: string;
    /**
     * The PUBLIC project ID: the formatted two-segment token (skapi.project_id).
     * projectId above is the RAW regional code the wire endpoints take; the public
     * token is what MCP tools accept and what prompts must show the model, since the
     * model copies it verbatim into tool calls. Optional for older hosts; prompts
     * fall back to the raw code when absent.
     */
    publicProjectId?: string;
    owner: string;
    /** Per-user queue name (falls back to projectId). */
    userId: string;
    /**
     * This chat is being used by a visitor with NO account, on a project whose
     * owner allows that.
     *
     * It changes where the MCP tools point. A signed-in turn goes to the MCP
     * server's root endpoint and authenticates with the caller's own token; an
     * anonymous turn has no token to send, and an EMPTY one is worse than none
     * (the server cannot identify a project from it, and an empty credential may
     * be rejected by the provider before the request is even made). So an
     * anonymous turn goes to the project-scoped endpoint instead, which is
     * read-only, restricted to public records, and needs no credential at all.
     */
    anonymous?: boolean;
    platform: 'claude' | 'openai' | 'none';
    model?: string;
    serviceName?: string;
    serviceDescription?: string;
}
/**
 * Project context captured at the moment the user hit Send, so a turn whose
 * dispatch is delayed (attachment uploads are awaited first) still reaches the
 * project the question was asked of rather than whichever project the user has
 * navigated to by then. Both fields are identity-derived and must be snapshotted
 * together — the system prompt embeds the service name/description/id.
 */
interface PinnedDispatchContext {
    identity: ChatIdentity;
    systemPrompt: string;
    /** Id returned by stageOutgoingMessage. The turn's bubble is already on
     *  screen (staged while its attachments upload), so dispatchComposedMessage
     *  REPLACES that bubble in place instead of pushing a second one at the
     *  bottom — the message keeps the position it was sent in. */
    stageId?: string;
}
/**
 * The file a background-indexing bubble belongs to. Stamped on the REQUEST
 * bubble (both the live one and the one rebuilt from history) so the display
 * layer can group a file's many passes without reverse-parsing the view's
 * formatted label. See indexing_groups.buildChatDisplayList.
 */
interface IndexingFileRef {
    name: string;
    /** Storage path, when known. Preferred group identity: a file can be
     *  re-uploaded under a name that already exists elsewhere. */
    path?: string;
    mime?: string;
    size?: number;
    isReindex?: boolean;
    /** A CONTINUE pass. Its absence across every loaded pass is what tells the
     *  display layer that earlier passes are still unpaged. */
    continued?: boolean;
}
interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    isPending?: boolean;
    isPendingInProcess?: boolean;
    isPendingQueued?: boolean;
    isPendingOlder?: boolean;
    /** PROTOCOL flag: true from the moment a queued turn is dispatched until the
     *  server acknowledges it. It is the token the ack's findIndex matches on, so
     *  nothing may clear it early. It is NOT a style input — see _dimSending. */
    isSendingToServer?: boolean;
    /** PRESENTATIONAL flag: render this bubble dimmed because the turn has not been
     *  handed over yet. Split from isSendingToServer because an ATTACHMENT turn is
     *  un-dimmed the instant its files finish indexing, while the request itself is
     *  still un-acked for another moment; dropping isSendingToServer to achieve that
     *  would cost the turn its _serverItemId (the ack matches on that flag alone, and
     *  a _useBgQueue turn is excluded from every fallback that would recover it). */
    _dimSending?: boolean;
    isCancelled?: boolean;
    isError?: boolean;
    isBackgroundTask?: boolean;
    /** Set on background-indexing REQUEST bubbles only (see IndexingFileRef). */
    _indexFile?: IndexingFileRef;
    /** Set on a background-indexing RESPONSE bubble whose raw answer carried the
     *  INDEXING_COMPLETE marker. Stamped before the marker is stripped for display,
     *  in every path that builds one (live resolution and both history mappers), so
     *  a run reads the same before and after a reload.
     *
     *  Meaningful ONLY for a client-driven chain, where it is the very signal
     *  maybeResumeIndexing stops on. The worker-driven paths (PDF vision, windowed
     *  reads) advance off the renderer's page count and their prompt deliberately
     *  never asks for the marker, so a model that emits one there is guessing —
     *  which is how an 88-page file once "finished" at page 15. */
    _indexComplete?: boolean;
    _useBgQueue?: boolean;
    /** Mapped from an item delivered by the bg chain of the split history fetch
     *  (stubs or deferred chats). Surface-frontier logic (retention boundary,
     *  clear-horizon) skips these — their ids reach arbitrarily deep. */
    _fromBgChain?: boolean;
    /** Local id of a turn STAGED at Send time while its attachments upload. The
     *  bubble exists before any server request does, so it is never matched by
     *  _serverItemId and is never promoted/cancelled by the queue machinery —
     *  dispatchComposedMessage consumes it (pinned.stageId) when the turn is
     *  finally sent. Staged bubbles are deliberately kept OUT of the history
     *  cache: an unmount kills the upload that would resolve them, so a cached
     *  copy would replay as a bubble that uploads forever. */
    _stageId?: string;
    /** Staged-turn phase 1: its files are still uploading. Renders
     *  "(Uploading files...)", dimmed. */
    isUploadingAttachments?: boolean;
    /** Staged-turn phase 2: the files are up and the turn is waiting for the whole
     *  background-indexing chain behind them to finish. Renders "(Indexing files...)",
     *  still dimmed. Cleared (with _dimSending) by markStagedMessageReady the moment
     *  the queue drains, which is when the turn genuinely becomes "(In queue)". */
    isAwaitingIndexing?: boolean;
    /** PROTOCOL + PRESENTATIONAL: this bubble is being painted from a LIVE stream.
     *
     *  It sits alongside `isPending`, never instead of it. The bubble is still the
     *  turn's "Thinking..." placeholder as far as every queue mechanism is concerned
     *  (_ownThinkingIndex, resolveQueuedUserBubble, typewriteLatestReply and the
     *  stray-pending sweep all find their target by isPending), and clearing that flag
     *  to mean "it has text now" would strand the turn's real answer beside an orphan.
     *  What this adds is the one thing those mechanisms do not care about and the VIEW
     *  does: `content` is already worth rendering, so draw the text instead of the
     *  spinner.
     *
     *  Cleared the moment the turn settles, BEFORE the authoritative answer replaces
     *  the live text: from that instant the bubble is an ordinary reply being typed.
     *  The partially painted `content` is deliberately left in place across that clear,
     *  because it is what the typewriter resumes from instead of replaying from zero.
     *
     *  Also read by shouldRescueInFlightMessage: a streaming bubble that has no server
     *  id yet is unrepresentable in a freshly fetched page, so it must survive the
     *  merge or its stream is orphaned with nothing left to paint into. */
    _streaming?: boolean;
    /**
     * This turn's row is TERMINAL but carries no stored answer, because the answer
     * was streamed and nobody ever finalized it: the bytes are in the chunk store,
     * not on the row. The bubble's `content` is therefore UNKNOWN, not empty.
     *
     * That distinction is the whole of the fix for two bugs that looked unrelated.
     * A refetch landing in the window between the row going 'resolved' and finalize
     * storing the body used to ERASE the answer off the screen (the server copy has
     * no content, so the merge dropped the local bubble that did); and a turn that
     * settled while no poll was attached (closed tab, slept device) used to be
     * unrecoverable, because the mapper emitted no assistant bubble at all for a
     * terminal-but-empty row. Both are the same question, "what should the merge
     * believe when the server copy is authoritative but empty", and the answer is
     * this flag: an unknown answer NEVER overwrites a known one, and an unknown one
     * left over after the merge is resolved by reading the chunks back
     * (ChatSession.recoverStreamedAnswer).
     *
     * For a view it is a rendering hint and nothing more: a bubble carrying it with
     * empty content is being fetched, so draw whatever this client draws for a
     * loading answer. A host that ignores it renders an empty bubble for the second
     * or two the recovery takes, which is what it would have rendered anyway.
     *
     * WHEN IT COMES OFF, because that is the half that loses answers. It comes off
     * for a FACT about the turn and never for an event in the client: an answer was
     * recovered and written in, or the chunks were read and were genuinely empty (in
     * which case the empty bubble is removed as well, restoring the list the mapper
     * used to produce). It stays ON when the read FAILED, when the read was STOPPED,
     * and when a live turn settled having painted nothing - three states that say
     * nothing whatever about the turn, and in which the chunks are all still there.
     * A marker cleared on one of those is an answer nothing will ever go back for,
     * so a host may see the same bubble marked across several loads while the reads
     * keep failing; that is the recoverable state, not a stuck one.
     */
    _streamPending?: boolean;
    /**
     * IS ANYTHING ACTUALLY DRIVING THIS BUBBLE RIGHT NOW? The second half of
     * `_streamPending`, and the half a view cannot do without.
     *
     * `_streamPending` says the answer is elsewhere; it does NOT say somebody is on
     * their way to fetch it, and the two are different states that used to render
     * identically. Recovery is capped per history load (STREAM_RECOVERY_PER_LOAD),
     * so the third and later marked turns on a page are marked and nobody is reading
     * them; a read that FAILED leaves the marker on with the attempt forgotten, which
     * is also nobody. Both drew the same loader as a live turn, so a bubble could
     * spin for the rest of the session with nothing behind it - the one thing a
     * spinner must never do, because it is a promise that something is coming.
     *
     * Three states, and only the first of them may draw a spinner:
     *   'active'   a chunk read is in flight or queued for this turn. Something IS
     *              coming; the loader is honest.
     *   'failed'   the last read failed. Nothing is coming until somebody asks
     *              again, so the view owes the reader a way to ask.
     *   undefined  nothing has been tried, or the attempt is over. Same obligation.
     *
     * Written by the engine only, and never persisted anywhere: it describes THIS
     * session's fetching, not the turn. A fresh history page therefore arrives
     * without it, and _adoptLocalAnswers re-stamps the page's still-marked bubbles
     * from the session's own bookkeeping, so a reload during a read does not turn a
     * live loader into a button (and back a second later).
     *
     * Read it through streamRecoveryPhase(msg), never directly: the phase folds in
     * "does this bubble need the affordance at all", and both clients must not
     * answer that twice.
     */
    _streamRecovery?: 'active' | 'failed';
    _serverItemId?: string;
    _localId?: string;
    _cancelling?: boolean;
    _cancelError?: string;
    /** Epoch ms shown as small text under the bubble. From the request history a
     *  USER bubble carries the request's `created` time and an ASSISTANT bubble the
     *  `updated` (response) time; a live bubble is stamped with the wall clock when
     *  it is created, then reconciled to the server value on the next history load.
     *  Absent while a turn is still pending, so no time shows on a "Thinking" bubble. */
    _ts?: number;
    _ownerKey?: string;
}
interface ChatState {
    messages: ChatMessage[];
    /** Pending/uploaded attachment objects (view-shaped); the engine mutates
     *  status/progress during upload, the view renders them. */
    attachments: any[];
    uploadingAttachments: boolean;
    sending: boolean;
    typing: boolean;
    typingAbort: boolean;
    loadingHistory: boolean;
    loadingOlderHistory: boolean;
    /** A deferred bg stub batch (first-paint split fetch) is still in flight;
     *  views show a small 'loading indexing history' hint while true. */
    bgHistoryLoading: boolean;
    historyEndOfList: boolean;
    historyStartKeyHistory: string[];
    historyRequestToken: number;
    gateRefreshToken: number;
    /** Files the SERVER still has unresolved indexing work for, by the key a
     *  collapsed row uses (storage path, else filename). Lives on the state rather
     *  than privately so a reactive consumer re-renders when it changes. */
    liveIndexKeys: {
        [fileKey: string]: boolean;
    };
    /** Whether `liveIndexKeys` has been answered at least once for this chat. False
     *  means "we have not found out", which the display layer reads as still
     *  working — never as an all-clear. */
    liveIndexChecked: boolean;
    /** Server item ids of the indexing passes that existed — on the row, or on the
     *  bg queue — when the user STOPPED that file. Two readers, one fact:
     *  buildChatDisplayList reports the run as stopped when it holds any of them
     *  (a stop routinely leaves no other trace), and _applyIndexCancellations
     *  refuses to let one of them lift the stop the way a genuinely new indexing
     *  request does. Ids, not file keys: they name the RUN that was stopped, so a
     *  later re-index of the same file cannot inherit it. On the state, like
     *  liveIndexKeys, so a reactive consumer re-renders the moment a stop is
     *  recorded — a stop with nothing left to cancel changes no message at all. */
    stoppedIndexIds: {
        [serverItemId: string]: boolean;
    };
}
interface ChatHost {
    /** Read live (platform/model/name can change between sends). */
    getIdentity(): ChatIdentity;
    /** The chat system prompt (consumer-built; agent.vue uses a formatted id). */
    buildSystemPrompt(): string;
    /** Re-render the whole message list (coalesced). */
    notify(): void;
    /** Re-render a single message bubble in place (typewriter ticks). */
    refreshMessageBubble(idx: number): void;
    scrollToBottom(smooth?: boolean): Promise<void> | void;
    /** Scroll only if the user is pinned to the bottom (does not force-pin). */
    scrollToBottomIfSticky(smooth?: boolean): Promise<void> | void;
    /** A history page finished loading and rendering. OPTIONAL. The view uses it
     *  to page further when the message box came out too short to scroll — the
     *  only trigger for loading older history is a scroll to the top, so a box
     *  that cannot scroll has no way to reach page 2 (see viewport_fill). Only
     *  the view can measure that, which is why the engine merely announces it. */
    onHistoryLoaded?(fetchMore: boolean, token: number): void;
    /**
     * A list refresh just changed heights: put the reader back where they were.
     *
     * Called at BOTH moments a first-page refresh moves things — the surface page
     * landing, and the deferred background-indexing batch merging on top of it a
     * round trip later — because leaving a wrong position on screen between the two
     * is what reads as "the scroll jumped, then travelled somewhere else".
     *
     * The view owns the decision (it is the only side that can measure): pinned to
     * the bottom means the bottom AFTER the batch merged, anywhere else means the
     * exact line the reader was on. Falls back to scrollToBottomIfSticky when a host
     * does not implement it, which is the old behaviour.
     */
    settleScroll?(): void;
    cancelRequest(opts: {
        url: string;
        method: string;
        id: string;
        queue: string;
        service: string;
        owner: string;
    }): Promise<{
        removed?: boolean;
        message?: string;
    } | any>;
    refreshSession(): Promise<boolean>;
    /** Build the "Indexing:/Reindexing: …" label (view-side display formatting). */
    formatIndexingLabel(name: string, mime?: string, size?: number | null, storagePath?: string, reindex?: boolean, continued?: boolean): string;
    /** drainBgTaskQueue is a no-op until the chat view is mounted. */
    isViewMounted(): boolean;
    /** Clear-horizon timestamp (localStorage, per service#platform) — view-owned. */
    getClearedAt(): number;
    uploadFile(args: {
        file: File;
        storagePath: string;
        checkExistence: boolean;
        onProgress?: (p: any) => void;
        setAbort?: (abort: () => void) => void;
    }): Promise<any>;
    /** Mint a temporary CDN URL for a stored file. */
    getTemporaryUrl(storagePath: string): Promise<string>;
    /** Delete a file's AI-index record ("src::<storagePath>") ahead of a
     *  reindex/overwrite so the agent re-creates it fresh instead of colliding/
     *  duplicating. The skapi backend cascades a src:: delete to the record's
     *  reference-linked children. OPTIONAL — hosts that don't implement it fall
     *  through to a plain re-index. Implementations must be best-effort (swallow
     *  "not found" / permission errors so indexing still proceeds). */
    deleteExistingFileRecord?(storagePath: string): Promise<any>;
    /**
     * Create the file's "src::<storagePath>" record before indexing starts, so every pass has a
     * reference target that exists. Optional: a host without it keeps the old behaviour, where
     * whichever pass got there first created the record and the others hoped it had.
     */
    ensureFileIndexRecord?(storagePath: string, meta?: {
        name?: string;
        mime?: string;
        size?: number;
    }): Promise<any>;
    /**
     * The access group this file's records must be written at: the uploader's
     * choice, which is the project default or a per-upload answer.
     *
     * Asked PER FILE, and asked AFTER ensureFileIndexRecord has run, because the
     * host is what actually creates the "src::" record and it must report the
     * group it really used. The engine threads the answer into the indexing
     * prompts so the agent's own records land in the same group; a record saved
     * under a different group is in a different table and never comes back with
     * the rest of the file.
     *
     * Optional and may return a promise. A host without it (or one that returns
     * nothing) gets "authorized", which is what every record used before the
     * setting existed.
     */
    uploadAccessGroup?(storagePath: string): 'public' | 'authorized' | 'private' | undefined | Promise<'public' | 'authorized' | 'private' | undefined>;
    /** Map a relative path to the consumer's db storage key (e.g. uid-prefixed). */
    storagePathFor(relPath: string): string;
    getMimeType(name: string): string | null;
    /** Non-dismissible "file exists" prompt → skip, keep+reindex, or overwrite. */
    promptOverwrite(filename: string): Promise<'overwrite' | 'reindex' | 'skip'>;
    /** Clear the "apply to all" overwrite choice at the start of a batch. */
    resetOverwriteBatch(): void;
    /** Re-render the attachment chip row (progress / status). */
    renderAttachmentChips(): void;
    /** Enable/disable composer controls during an upload batch. */
    updateComposerControls(): void;
}

/**
 * History mapping (pure). Moved verbatim from the chatbox. The clear-horizon
 * timestamp and the "Indexing: …" display label are INJECTED (clearedAt param,
 * formatIndexingLabel callback) so the engine touches neither localStorage nor
 * view-specific display formatting. projectId is passed for link sanitization.
 */

declare function filterListByClearHorizon(list: any[], clearedAt: number): any[];
declare function normalizeTextContent(content: any): string;
declare function extractLastUserTextFromRequest(requestBody: any): string;
/** The two openings an indexing prompt can have. A bg-queue item that starts with
 *  neither is an ordinary chat that happened to be routed onto that queue. */
declare function isIndexingRequestText(userText: any): boolean;
type IndexingRequestRef = {
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
declare function parseIndexingRequestText(userText: any): IndexingRequestRef | null;
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
declare function fetchLiveIndexingKeys(params: {
    service: string;
    owner: string;
    platform: 'claude' | 'openai';
    /** Same value the dispatch used - see bgIndexingQueueName. */
    userId?: string;
}): Promise<{
    keys: Set<string>;
    checked: boolean;
    at: number;
}>;
/** Test hook: drop split-fetch state (all keys, or one). */
declare function __resetSplitHistoryState(key?: string): void;
type SplitHistoryResult = {
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
    bgPending?: Promise<{
        list: any[];
        endOfList: boolean;
    }>;
};
declare function getSplitChatHistory(params: {
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
}, fetchOptions: Record<string, any>, 
/** Test seam: replaces getChatHistory. Not for production callers. */
_fetchImpl?: typeof getChatHistory): Promise<SplitHistoryResult>;
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
declare function chatCacheKey(projectId: string | undefined, platform: string | undefined, userId?: string): string;
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
declare function indexScopeKey(projectId: string | undefined, platform: string | undefined): string;
type MapHistoryOptions = {
    clearedAt: number;
    projectId: string;
    /** Chat identity, so the `_ownerKey` stamp matches chatCacheKey(). */
    userId?: string;
    /** View-side display formatter for "Indexing:/Reindexing: …" bubbles. */
    formatIndexingLabel: (name: string, mime?: string, size?: number | null, storagePath?: string, reindex?: boolean, continued?: boolean) => string;
};
declare function mapHistoryListToMessages(list: any[], platform: 'claude' | 'openai', opts: MapHistoryOptions): {
    messages: any[];
    runningItemIds: string[];
    streamPendingItemIds: string[];
};
/**
 * Let a LOCAL copy of a turn survive a page whose copy of it is
 * AUTHORITATIVE-BUT-EMPTY. Mutates `incoming`; returns true when it took anything.
 *
 * THE FAILURE THIS PREVENTS. A streamed turn's row goes 'resolved' the moment the
 * relay finishes, and its answer reaches the row only when csr-finalize stores it,
 * one poll interval plus a round trip later. A first-page history refetch landing
 * inside that window maps the row to a `_streamPending` bubble with no content, and
 * the merge, which believes the server, throws away the local bubble holding the
 * answer the reader is looking at. The window opens on EVERY streamed turn, and a
 * refetch fires from visibilitychange, so it is not a corner case.
 *
 * The rule is the same one the recovery reads: an UNKNOWN answer never overwrites a
 * KNOWN one. Where the local copy is still live (pending, or being painted into),
 * its live-ness is adopted too: without it the merge would hand back a settled
 * bubble the painter can no longer find (_liveTargetIndex wants isPending or
 * _streaming) and that _turnAlreadyRendered would then read as already answered, so
 * the settle would drop the real answer on the floor.
 */
declare function adoptLocalAnswerIntoPage(incoming: ChatMessage, local: ChatMessage): boolean;
interface RescueDecisionContext {
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
declare function shouldRescueInFlightMessage(m: ChatMessage, ctx: RescueDecisionContext): boolean;

/**
 * Hold the reader's place in the message list.
 *
 * A chat box mutates constantly WITHOUT the reader asking for it: an older page
 * prepends, a poll resolves, an indexing row splices in or changes label, a link
 * chip goes grey, an image preview finishes decoding, the "Fetching history..."
 * bar appears and disappears. Every one of those changes the height of something
 * that may sit ABOVE the viewport, and the browser answers by keeping scrollTop,
 * which slides the sentence the reader was on out from under them.
 *
 * THE ONE RULE: nothing here stores a position to be applied later. Every method
 * acts at the moment it is called, against the box as it is at that moment, and
 * is finished when it returns.
 *
 * That rule is the whole design, and it was learned the hard way. An earlier
 * version of this module also had a "park the place they left, put them back when
 * they return" half — parked/parkedStuck/returning/returnBudget/sawFrozen, a
 * frozen mode, a retry budget. Every one of those was a stored instruction that
 * some later event would carry out, and the reader's experience of a stored
 * instruction is that the chat throws them somewhere for no reason they can see:
 * they came back from another app, tapped the composer, the on-screen keyboard
 * fired a resize, the resize triggered a fetch, the fetch settled, and the settle
 * dutifully executed an instruction recorded before they ever left. Compensating
 * at the moment of the change needs no such instruction, and a return then needs
 * no handling at all, because nothing moved the reader in the first place.
 *
 * Two shapes, both immediate:
 *
 *   preserve(fn) / capture() + restore(a)
 *       A mutation you can bracket. Measures immediately before and immediately
 *       after, so it is exact even when the mutation tears the list down.
 *
 *   remember() + hold()
 *       A layout change you CANNOT bracket: an image decoding, a font arriving, a
 *       re-parse from a promise. remember() runs from the view's scroll handler,
 *       so the anchor is always the reader's own last position.
 *
 * hold() is not an exception to the rule, and the staleness check is why. A height
 * change above the viewport does NOT change scrollTop; the browser preserves it,
 * which is precisely why the content appears to jump. So the remembered anchor is
 * valid exactly while `box.scrollTop` still equals the value it was captured at,
 * i.e. while nothing at all has moved the box. The instant that stops being true
 * it is re-measured, never replayed. hold() can therefore only ever undo a height
 * change that just happened, and can never carry out an old intention.
 *
 * Two more consequences worth stating, because both were once done the other way:
 *
 *   NO FREEZE. Compensation runs whether or not the tab is visible. Layout and
 *   getBoundingClientRect are live in a hidden tab; only painting and rAF stop.
 *   Suspending compensation while hidden is what created the need to restore
 *   something afterwards.
 *
 *   A CLAMP IS ACCEPTED. If the content below the reader shrank, their line is
 *   genuinely unreachable and the browser truncates the correction. Retrying that
 *   later is how a correction turns into an ambush.
 *
 * DOM-free like the rest of the engine: the element shapes below are structural,
 * so real DOM nodes satisfy them while this file imports nothing from lib.dom.
 */
interface AnchorRect {
    top: number;
}
interface AnchorRowEl {
    getAttribute(name: string): string | null;
    getBoundingClientRect(): AnchorRect;
    offsetHeight: number;
    parentNode: unknown;
}
/** Anything inside the list that resizes on its own schedule. See absorb(). */
interface AnchorGrowableEl {
    getBoundingClientRect(): AnchorRect;
    offsetHeight: number;
}
interface AnchorBoxEl {
    children: ArrayLike<AnchorRowEl>;
    getBoundingClientRect(): AnchorRect;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}
interface RowAnchor {
    /** data-row-key of the anchored row, or null when nothing was anchorable. */
    key: string | null;
    /** Offset of that row from the top of the viewport. Negative above the fold. */
    top: number;
    /** data-row-pos, present only on rows that can RELOCATE (see below). */
    pos: string | null;
    /** scrollTop at capture time. The staleness check, and the raw fallback. */
    scrollTop: number;
    /**
     * scrollHeight at capture time. How much the list GREW is the best available
     * answer when the anchored row itself cannot be found again, and the bound on
     * how far a correction can legitimately be.
     */
    scrollHeight: number;
    /**
     * The anchored element itself. A view that patches in place (Vue) keeps the
     * same node across an update, so restore is one rect read instead of a scan;
     * a view that rebuilds the list (the widget) drops it and falls back to the
     * key. Never trusted without re-checking that it is still in the box.
     */
    el: AnchorRowEl | null;
    /**
     * The next few anchorable rows below the primary, each with its own offset.
     *
     * The primary row does not always survive: a refresh can drop it, a collapsed
     * indexing row can be re-identified, an expanded group can fold. Without a
     * fallback the only thing left is lost(), which guesses from the list's total
     * growth — and total growth includes everything added BELOW the reader, so a
     * merge that lands rows on both sides of them over-pays. A second row that is
     * still there beats any guess, and collecting them costs nothing: capture is
     * already walking these rows.
     */
    alts?: Array<{
        key: string;
        top: number;
        pos: string | null;
        el: AnchorRowEl;
    }>;
}
interface ScrollAnchorOptions {
    /** The scrolling message box, or null when it is not mounted. */
    getBox: () => AnchorBoxEl | null;
    /**
     * The reader is pinned to the bottom. There the bottom IS the anchor and the
     * scrollToBottom* paths own the position, so every method here no-ops.
     */
    isStuck: () => boolean;
    /**
     * Fall back to the raw scrollTop when the anchored row cannot be found again.
     *
     * For a view that REBUILDS the list (the widget's renderMessages), detaching
     * every child collapses scrollHeight and the browser clamps scrollTop to 0,
     * so the raw offset is strictly better than the clamp it would otherwise be
     * left with. For a view that patches in place (Vue) the browser has already
     * kept a sane position and re-imposing a stale offset is worse than nothing.
     */
    rawFallback?: boolean;
}
interface ScrollAnchor {
    /** Measure the reader's current place. Null while pinned to the bottom. */
    capture: () => RowAnchor | null;
    /** Put a captured place back. Safe to call with null. */
    restore: (anchor: RowAnchor | null) => void;
    /** capture -> mutate -> restore, for a mutation you can bracket. */
    preserve: <T>(mutate: () => T) => T;
    /** Record the reader's place. Call from the box's scroll handler. */
    remember: () => void;
    /** Put the remembered place back, if it is still the reader's own. */
    hold: () => void;
    /** Pin to the bottom, instantly, recording the write. The ONLY way to pin. */
    pinBottom: () => void;
    /** Absorb one element's own resize. See below. */
    absorb: (el: AnchorGrowableEl | null | undefined) => void;
    /** Drop the remembered place (chat switch, unmount). */
    forget: () => void;
}
declare function createScrollAnchor(options: ScrollAnchorOptions): ScrollAnchor;

/**
 * Keep older history REACHABLE by paging until the message box actually gains
 * something to scroll to.
 *
 * Older history is paged in by one trigger only: the user scrolling to the top
 * of the message box. That trigger has two ways to die, and collapsed indexing
 * rows cause both:
 *
 *   1. The box never scrolls. A file's every indexing pass (the first plus every
 *      CONTINUE pass, request AND response bubble each) folds into ONE row, so a
 *      full history page — twenty-plus messages — can render as a single line.
 *      Content shorter than the viewport fires no scroll event, so page 2 is
 *      never requested and any conversation the user had before that upload is
 *      permanently out of reach.
 *   2. The fetched page adds no height. A page that is entirely the same file's
 *      earlier passes joins the collapsed row already on screen and renders
 *      nothing new. The user, sitting at scrollTop 0, scrolls up again — and
 *      because the position never changed, no further scroll event fires.
 *
 * Both are the same shape: fetch, re-measure, and keep going until the user
 * genuinely gained reachable content, history ran out, or the pager stopped
 * advancing. `isSatisfied` is what differs between the two (can the box scroll
 * at all / did it grow), so the loop below takes it as a predicate.
 *
 * DOM-free like the rest of the engine — the caller supplies the measurement and
 * awaits its own render before measuring, so agent.vue and the widget run the
 * identical loop over their own pagers.
 */
/** Overflow (px) that counts as "the user can scroll here". Comfortably more
 *  than the 60px top threshold that triggers the next page, so a filled box has
 *  real room to scroll rather than sitting one pixel from the trigger. */
declare const HISTORY_FILL_SLACK_PX = 64;
/** Pages one fill pass will request before giving up. Reached only by a chat
 *  whose history really is dozens of pages of one file's indexing passes; the
 *  cap exists so a pager that stops advancing can never spin forever. */
declare const MAX_HISTORY_FILL_PAGES = 24;
type FillHistoryViewportOptions = {
    /** The user has reachable content and paging can stop. Called AFTER the
     *  caller's own render has settled (nextTick / rAF), since only the caller
     *  knows when its view has painted — hence the allowance for a promise. */
    isSatisfied: () => boolean | Promise<boolean>;
    /** All history is loaded — nothing left to page in. */
    isEndOfList: () => boolean;
    /** A history request is already in flight. Waited out, not treated as a stop
     *  condition: a background first-page refresh (the queue-detect tick fires one
     *  every couple of seconds while a file is indexing) would otherwise swallow
     *  the user's scroll-up entirely, and scrolling up again from scrollTop 0
     *  produces no second event to retry with. */
    isLoading: () => boolean;
    /** Messages currently loaded. Used to detect a page that added nothing, which
     *  means the pager is not advancing and looping would never terminate. */
    messageCount: () => number;
    /** Fetch ONE older page (the caller's own fetchMore path, scroll-restore and
     *  all). Return `false` when the request was NOT issued (the caller's own
     *  single-flight guard swallowed it) so the loop retries instead of reading
     *  the unchanged message count as an exhausted pager. Anything else, including
     *  undefined, means it was attempted. */
    fetchOlder: () => Promise<boolean | void | any>;
    /** The chat this fill was started for is gone (project switched, view
     *  unmounted, gate token bumped). Checked between pages so a stale fill can
     *  never keep paging another chat's history. */
    isStale?: () => boolean;
    maxPages?: number;
};
/**
 * Page older history until `isSatisfied`, until history runs out, or until the
 * pager stops advancing. Never throws: a failed page ends the fill, and the
 * user's own scrolling remains the fallback trigger.
 */
declare function fillHistoryViewport(opts: FillHistoryViewportOptions): Promise<void>;
/**
 * One fill loop per view, with predicates COMBINED rather than dropped.
 *
 * Fills come from several places at once — a first page finishing, a window
 * resize, a row being collapsed, and the user's own scroll to the top — and a
 * plain "one at a time, drop the rest" guard picks the wrong winner: a resize
 * fill (satisfied the moment the box can scroll at all) would swallow the user's
 * scroll-up (which needs content specifically ABOVE them), and the scroll-up
 * cannot be retried, because a reader parked at scrollTop 0 produces no further
 * scroll event. Dropping the guard entirely is no better: every frame of a
 * window drag would start its own 24-page loop.
 *
 * So a request that arrives mid-loop ANDs its predicate into the running one:
 * the loop then keeps paging until EVERY caller is satisfied. Predicates that
 * come true are dropped as it goes, so the cost stays flat.
 */
declare function createHistoryFiller(base: Omit<FillHistoryViewportOptions, 'isSatisfied'> & {
    /** Fired when the loop starts FETCHING and when it stops, and only on a real
     *  change.
     *
     *  This — not the caller's own per-request `isLoading` — is what "older
     *  history is still coming in" means to a view. A fill is many pages, and
     *  `isLoading` drops to false between every one of them, so anything
     *  rendered off it flickers once per page for the whole loop. A collapsed
     *  indexing row whose run begins above the loaded window renders exactly
     *  that ("still loading this run" vs a status it cannot know yet), which is
     *  why the loop has to publish its own span.
     *
     *  Fetching, NOT requested. Most fills fetch nothing: they are fired on every
     *  window resize, every row a user collapses, and every first-page load, and
     *  the overwhelmingly common outcome is `isSatisfied` returning true on the
     *  first look. Announcing at request time published a true/false pair for
     *  each of those, and the widget's own satisfied-check spans two animation
     *  frames — long enough for the browser to PAINT the intermediate state. Every
     *  collapsed row strobed through "loading" on every resize tick. So the span
     *  opens at the first actual page request, which is also the first moment the
     *  claim is true. */
    onRunningChange?: (running: boolean) => void;
}): {
    fill: (isSatisfied: () => boolean | Promise<boolean>) => Promise<void>;
    isRunning: () => boolean;
};

/**
 * Background file-indexing turns, collapsed into ONE row per file.
 *
 * A single upload can produce many chat turns: the first "Indexing: <file>" pass
 * plus up to MAX_INDEXING_RESUME_PASSES CONTINUE passes, each with its own
 * request AND response bubble. Rendered flat, that reads as the same task
 * repeating forever, and any real question the user asks in between gets buried.
 *
 * buildChatDisplayList turns the flat message array into a DISPLAY list in which
 * every message belonging to one run of one file (however far apart the passes
 * sit, and whatever else is interleaved between them) is represented by a single
 * group entry, rendered at the position of that run's FIRST loaded pass.
 *
 * First, not newest. The message array is ordered by request CREATION time, and
 * a run's later passes are created one at a time as the previous one resolves —
 * by the client for the paged text path, and by the WORKER itself for the
 * rendered-page (PDF) path, which the client only learns about on its next
 * first-page history fetch. So a pass is routinely created minutes after the
 * upload, on a queue that runs in parallel with the foreground chat. Anchoring
 * at the newest pass meant one such late pass dragged the whole run — every
 * earlier pass with it — below any question the user had asked in the meantime,
 * and made a run that had visibly finished before the question render after it.
 * Anchoring at the first pass puts the row where the run actually began, which
 * is a position no later pass can change:
 *   - a new pass never relocates the row, so nothing under the reader shifts;
 *   - a question asked after the upload always renders below the row, which is
 *     the order it happened in.
 * The cost is that a long-running index does not follow the conversation to the
 * bottom: once the user has chatted past the upload, the spinner and the Stop
 * button sit above their newest turns. That is a scroll away, and the row no
 * longer lies about when the work started.
 *
 * Paging older history is the one thing that CAN move the row: an older page
 * carrying earlier passes of a run already on screen moves it up into that page.
 * That happens at most once per run, only for a run whose start was never
 * loaded (`mayHaveOlder`), and it is the same event that already re-derives
 * `runKey` — so the view treats it as a new row either way.
 *
 * The group deliberately reports no authoritative pass TOTAL. History is paged
 * newest-first, so any total computed from loaded messages is a lower bound that
 * a later scroll-up would contradict. It reports STATE (indexing / indexed /
 * failed), how many passes are currently loaded, and `mayHaveOlder` when the
 * file's first pass is not among them.
 *
 * For the same reason it also reports NOT KNOWING. A run whose start is still
 * being paged in, and a worker-driven run whose queue state has not been asked
 * for yet, are both rows whose state is a moving target — and on a chatbox that
 * was just opened, that is most of them. `resolving` marks those, so the view can
 * say which wait it is waiting on rather than committing to "indexing" or
 * "indexed" on a fraction of the evidence.
 *
 * Pure and view-agnostic: agent.vue and the BunnyQuery widget both render from
 * this, so the two stay identical.
 */

type IndexingGroupStatus = 'active' | 'done' | 'error' | 'cancelled';
type IndexingGroup = {
    /** The FILE this row is about: storage path when known (a file can be
     *  re-uploaded under a name that already exists elsewhere), else name. Shared
     *  by every run of that file, and what ChatSession.cancelIndexingGroup and
     *  _indexKeyOf match on — never use it as a render key.
     *
     *  It IS the key for persistent view state, above all the expansion state. That
     *  used to be keyed by runKey, which is renamed the moment a run's true first
     *  pass loads (see below) — so a row the user had opened silently closed itself
     *  mid-indexing, every time a pass arrived ahead of the earlier ones. This never
     *  changes for the life of a file. The cost is that two runs OF THE SAME FILE
     *  (an index and a later re-index) open and close together, which is a fair
     *  reading of "show me this file's steps" and is not a state the user can be
     *  surprised out of. */
    key: string;
    /** Identity of this ROW: one indexing RUN of that file. A file indexed on
     *  Monday and re-indexed on Wednesday is two runs, and collapsing them into
     *  one row erased Monday's from Monday's place in the conversation, claimed
     *  its passes for Wednesday, and let Monday's failure be overwritten by
     *  Wednesday's success. Named after the run's FIRST loaded pass (see where it
     *  is assigned below), so passes appended to the run and other runs appearing
     *  on either side of it never rename a row already on screen.
     *
     *  This is the RENDER key, and only that. It is renamed when the run's true
     *  first pass finally loads — routine while a worker-driven chain is running,
     *  since a pass adopted from the queue can reach the client before the earlier
     *  ones are paged in — and a rename is exactly right for a DOM key (the row did
     *  change identity) but wrong for anything the USER set. Key that on `key`. */
    runKey: string;
    name: string;
    path?: string;
    mime?: string;
    size?: number;
    /** True when any loaded pass was a re-index of an already-stored file. */
    isReindex: boolean;
    /** Every message of this file, in chat order, with its index in the source
     *  array (so cancel/typewriter paths keep addressing the real message). */
    members: {
        msg: ChatMessage;
        index: number;
    }[];
    /** Indexing passes LOADED (request bubbles), never a server-side total. */
    passCount: number;
    status: IndexingGroupStatus;
    /** Server item ids of the passes that are still queued/running, so the row can
     *  offer a stop button (ChatSession.cancelIndexingGroup cancels each). Empty
     *  when nothing is cancellable — a finished file, or a live pass whose server
     *  id has not come back yet. */
    cancellableIds: string[];
    /** This row is in the middle of stopping: a cancel request is in flight for one
     *  of its passes, or the user stopped the run and a pass is still running. Both
     *  mean the same thing to a view — the Stop has been spent, so the button reads
     *  "Stopping..." and is not offered again. */
    cancelling: boolean;
    /** The user stopped this run.
     *
     *  NOT the same as `status === 'cancelled'`, and the difference is the whole
     *  reason it exists: a stop landing on a pass that is already RUNNING cannot
     *  un-run it, so the row stays `active` until that pass settles. `status` then
     *  describes the work (something is still running) and this describes the user's
     *  decision (no more of it will be started). */
    stopped: boolean;
    /** Why the last cancel attempt failed (e.g. the pass had already finished). */
    cancelError?: string;
    /** The file's first pass is not among the loaded messages, so earlier passes
     *  exist in history that has not been paged in yet. */
    mayHaveOlder: boolean;
    /** Position in the source array this collapsed row renders at: the index of
     *  the run's FIRST loaded pass (see the file docstring for why not the last). */
    anchorIndex: number;
    /** Identity of the turn at `anchorIndex` — its server item id, or its local id
     *  while it has none, or `''` when it has neither. The views stamp this on the
     *  row (`data-row-pos`) so the scroll anchor can tell a row that RELOCATED (an
     *  older page moved the run's start) from one that merely gained a pass. They
     *  must not re-derive it from `members`: which member the row renders at is
     *  this module's decision, and the two silently disagreed once already. */
    anchorId: string;
    /** `members` minus the turns an EXPANDED row should not show: every CONTINUE
     *  request, and the running pass's empty placeholder.
     *
     *  A continuation's request bubble says "Indexing (continuing) <file>" and
     *  nothing else — it repeats the row's own header once per pass, so a long file
     *  read as the same line over and over with the actual findings buried between
     *  them. The pass is still represented, by its RESPONSE. The placeholder goes
     *  for a different reason: the row now carries one loader of its own for as long
     *  as work remains, and two spinners in one open row is noise.
     *
     *  Additive. `members` is untouched and is still what every count, status,
     *  cancel and anchor decision reads — several of them are only correct on the
     *  full list (a `mayHaveOlder` run's members[0] IS a continuation). */
    visibleMembers: {
        msg: ChatMessage;
        index: number;
    }[];
    /** Who advances this file's chain, which decides what can confirm it is over:
     *  'single' one pass and done; 'client' this client dispatches each CONTINUE
     *  pass and stops on the model's completion marker; 'worker' the server advances
     *  the loop off the renderer's page count and the client is only a spectator. */
    driver: 'single' | 'client' | 'worker';
    /** Positively established that no further indexing work will happen for this
     *  run. NOT "the file was fully read" — a cap-out, a failure and a stop are all
     *  finished, and the row's own status says which.
     *
     *  False means "not established", which includes "still running" AND "we have
     *  not been able to find out". The view shows a loader for both, deliberately:
     *  the alternative default is the failure this exists to prevent, a row that
     *  reads "Indexed" between two passes of a file still being read. */
    finished: boolean;
    /** This row cannot honestly claim a state yet, because something it is derived
     *  FROM is still being fetched. Both `status` and `finished` are read off the
     *  passes that happen to be LOADED, and on a freshly opened chatbox that is a
     *  moving target: history pages newest-first, so a long run arrives as a tail
     *  of CONTINUE passes while its beginning is still being paged in. The row was
     *  picking a side through that window — a spinner reading "Indexing" for a file
     *  that finished last week, or a green "Indexed" for one still being read — and
     *  both are verdicts drawn from a fraction of the run.
     *
     *  Only ever set from status 'done'. A loaded pending pass PROVES the run is
     *  live, and an error or a stop is the newest pass's own outcome, which
     *  newest-first paging always has in hand — none of those is a guess, and
     *  hiding any of them behind a loader would lose something the user needs.
     *
     *  For the 'history' reason this means "a fetch is IN FLIGHT", not "the picture
     *  is incomplete". Older history is paged in by explicit triggers only (the
     *  viewport fill, the user scrolling to the top) and nothing auto-fetches on a
     *  row's behalf, so a run whose start is still unloaded once the paging stops
     *  has to go back to reporting what it does know — `mayHaveOlder` and the `+` on
     *  the pass count carry the rest. A "loading..." that never ends is the same lie
     *  pointing the other way.
     *
     *  The 'status' reason is weaker on purpose: "the queue has not answered", which
     *  a permanently failing query never resolves. That is deliberate, because it is
     *  the SAME question as what the row should say when it cannot find out, and
     *  every alternative is worse: a grey clock reading "checking" claims less than
     *  the yellow spinner reading "Indexing" that it replaced. It also self-heals in
     *  practice — the answer is re-sought on every first-page history load and every
     *  settling pass — and gating it on an in-flight query instead would mean
     *  threading a second liveness flag through a retry ladder with nine exit
     *  points, i.e. trading this for a flag that can stick in the other direction. */
    resolving: boolean;
    /** Which wait, so the row can name it instead of just spinning. 'history':
     *  older pages are being fetched and this run's first pass is not among the
     *  loaded ones. 'status': the queue has not yet said whether this file is still
     *  being worked on, which is the only thing that can end a worker-driven run. */
    resolvingReason?: 'history' | 'status';
    /** Synthesized from a durable run:: record: none of the run's passes are
     *  among the loaded messages (bg history still deferred, or the run is older
     *  than the paging cap). Header-and-status only — members/visibleMembers are
     *  empty and there is nothing to cancel; the row is replaced by the real
     *  group the moment actual passes load (same `key`, so expansion state
     *  carries over). */
    stub?: boolean;
    /** The run:: record's stored error text, for a stub row's meta line. */
    stubError?: string;
};
type DisplayEntry = {
    kind: 'message';
    msg: ChatMessage;
    index: number;
} | {
    kind: 'indexing';
    group: IndexingGroup;
    index: number;
};
type BuildDisplayListOptions = {
    /** True while older history remains unpaged, which is what makes a group
     *  with no first pass genuinely incomplete rather than merely odd. */
    hasMoreHistory?: boolean;
    /** An OLDER-history fetch is in flight right now — a single page, or the whole
     *  viewport-fill loop (createHistoryFiller's onRunningChange, which spans the
     *  pages between which a per-request flag keeps dropping to false).
     *
     *  Older specifically. A first-page refresh cannot bring in a run's earlier
     *  passes, so counting it here would flip every incomplete row to "still
     *  loading" for the length of a poll that could never have answered it. */
    loadingOlderHistory?: boolean;
    /** Files the SERVER still has unresolved indexing work for, keyed exactly like
     *  IndexingGroup.key (ChatSession.getLiveIndexState). */
    liveIndexKeys?: {
        [fileKey: string]: boolean;
    };
    /** Whether `liveIndexKeys` has been answered at least once for this chat. False
     *  is "we do not know", and a worker-driven run stays unfinished on it. */
    liveIndexChecked?: boolean;
    /** Files carrying the durable done:: completion marker (one prefix sweep),
     *  keyed like IndexingGroup.key (storage path; the bare-name fallback keys
     *  of very old prompts simply never match — they keep the queue inference).
     *  A marker is PROOF the file was read to the end: it settles a worker-run
     *  green without waiting for the queue answer, and it is never withheld by
     *  the resolving logic. A live queue hit still outranks it (a re-index in
     *  flight whose marker-cascade delete lagged). */
    doneKeys?: {
        [fileKey: string]: boolean;
    };
    /** Server item ids of passes that were on a row when the user STOPPED it
     *  (ChatSession.state.stoppedIndexIds). A run holding any of them is a run the
     *  user stopped — see the status derivation for why a stop usually leaves no
     *  other trace in the messages. Ids rather than a file key on purpose: they name
     *  one RUN, so a later re-index of the same file cannot inherit the stop. */
    stoppedIndexIds?: {
        [serverItemId: string]: boolean;
    };
    /** Whether the WORKER drives the windowed text/grid loop (chatEngineConfig's
     *  windowedIndexing). Passed in rather than read from config so this stays a
     *  pure function of its inputs and can be exercised for both settings. */
    windowedIndexing?: boolean;
    /** Durable run:: records, keyed by STORAGE PATH (the consumer's marker
     *  sweep). Each key with no real group in the loaded messages gets a
     *  synthesized header-only row (see IndexingGroup.stub), placed by its
     *  `started` timestamp. A real group for the same file — matched by key,
     *  path, or name — always suppresses the stub: loaded passes are evidence,
     *  the record is only a summary. */
    runStubs?: {
        [storagePath: string]: RunStubInfo;
    };
    /** The platform whose chat this list is for. run:: records are per-FILE,
     *  but a chat is per (project, platform): a run started under Claude has
     *  its passes in the Claude conversation and is invisible to the
     *  OpenAI-scoped queue probe, so its stub could never be covered and never
     *  be confirmed — it just sat there, in a chat it did not belong to.
     *  Records minted before this was stamped carry no platform and are shown
     *  in both, which keeps the leak to the historical set. */
    stubPlatform?: 'claude' | 'openai';
    /** The chat's clear-history horizon (ms epoch). Run records are service-
     *  wide and know nothing about a cleared chat, so without this every
     *  "Clear chat history" resurrects one row per indexed file. A stub whose
     *  run ended (or, unfinished, began) at or before this moment is dropped —
     *  unless the queue says the file is live RIGHT NOW, which no horizon can
     *  make untrue. */
    stubClearedAt?: number;
    /** Clock injection for tests; defaults to Date.now(). Only run-stub
     *  staleness reads it. */
    now?: number;
};
/** The display-relevant fields of a run:: record (see requests.ts
 *  runIndexUniqueId for the record's contract). */
type RunStubInfo = {
    status: 'working' | 'done' | 'error' | 'cancelled';
    filename?: string;
    started?: number;
    finished?: number;
    error?: string;
    /** Chat that owns this run. Absent on records minted before it was
     *  stamped; see BuildDisplayListOptions.stubPlatform. */
    platform?: 'claude' | 'openai';
};
/** A 'working' run record older than this with no live-queue confirmation is
 *  treated as unknown rather than live: a chain that died without reaching any
 *  error path leaves 'working' dangling, and a row must not spin forever on a
 *  claim nothing can end. */
declare const RUN_RECORD_WORKING_STALE_MS: number;
declare function parseIndexingLabel(content: string): {
    name: string;
    path?: string;
    continued: boolean;
    isReindex: boolean;
} | null;
/**
 * Collapse background-indexing turns into per-file groups.
 *
 * Messages that are not background-indexing pass through untouched, at their
 * original positions and with their original indices.
 */
declare function buildChatDisplayList(messages: ChatMessage[], opts?: BuildDisplayListOptions): DisplayEntry[];

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

/** A live poll registered in ChatSession.historyItemPolls. */
type PollHandle = {
    /** 'bg' = background indexing, pausable. 'fg' = a reply the user is waiting on. */
    kind: 'fg' | 'bg';
    /** Absent on an older skapi-js that cannot stop an attached poll. */
    stop?: () => void;
};
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
declare function liveSafePrefix(text: string): string;
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
declare function typewriterResumeIndex(painted: string, fullText: string, regions: Array<{
    start: number;
    end: number;
}>): number;
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
 *   clientSecretRequestStream and a later load recovers it in full.
 *
 *   `unframed` is the one exception to needing a terminal event, and it is not a
 *   loophole: bytes that were never SSE carry no events at all and none is ever
 *   coming, so there it IS the row's status that says the response finished - which
 *   is why this is only ever reached with a 'resolved' row or with no status to
 *   contradict it.
 *
 * Exported so the two clients cannot answer it a third way.
 */
declare function mayKeepStreamedAnswer(snap: any, rowStatus?: string | null): boolean;
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
declare function streamRecoveryPhase(msg: any): '' | 'active' | 'failed' | 'idle';
/**
 * The words for the two phases a reader has to act on. Here rather than in each
 * client for the same reason as the phase itself: two clients wording the same
 * state differently is how one of them ends up saying something untrue.
 *
 * Neither string claims the answer is lost. It is not: the row is unfinalized, so
 * the chunks are retained until somebody finalizes them, and that is exactly why
 * asking again is worth offering.
 */
declare function streamRecoveryLabels(phase: string): {
    note: string;
    action: string;
};
/**
 * The identity a streamed turn was DISPATCHED under, pinned by the caller.
 *
 * Same reason _callProviderFor takes projectId/owner explicitly: a turn can be
 * acked after the user has moved to another project or platform, and a live
 * getIdentity() read at that moment describes where the user is now, not where the
 * turn came from. Every field optional so a caller can pin what it knows and let
 * the rest fall back to the live read.
 */
type StreamDispatchContext = {
    platform?: string;
    projectId?: string;
    owner?: string;
    /** History cache key (chatCacheKey) of the chat the turn belongs to. */
    ownerKey?: string;
};
declare class ChatSession {
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
    aiChatHistoryCache: Record<string, {
        messages: ChatMessage[];
        endOfList: boolean;
        startKeyHistory: string[];
    }>;
    historyItemPolls: Map<string, PollHandle>;
    /** Non-empty while polling is paused; keyed by reason so overlapping causes
     * (view detached AND tab hidden) do not resume each other prematurely. */
    private _pauseReasons;
    private _resuming;
    private _lidSeq;
    private _stageSeq;
    /** How many attachment-upload batches are running. uploadingAttachments is a
     *  single flag but batches overlap (the composer stays live, so the user can
     *  send a second one while the first uploads), and a nested finish must not
     *  clear the flag out from under the batch still running. */
    private _uploadBatches;
    /** Indexing requests whose ack has not come back yet. Until it does the item
     *  is not on the server's queue, so awaitIndexingDrained cannot see it — and
     *  would read the gap between "pass N settled" and "pass N+1 accepted" as the
     *  file being finished. */
    private _indexDispatchesInFlight;
    /** Live awaitIndexingDrained waiters, one callback each. A nudge only pulls that
     *  waiter's NEXT look forward; it can never make one conclude anything, so a
     *  wrong nudge costs one pair of requests and the look reports busy. Overlapping
     *  waiters are normal — the composer stays live, so a second send can be
     *  uploading while the first waits. */
    private _drainNudges;
    /** Stages whose upload/dispatch chain is still running in THIS page. Lives and
     *  dies with those chains, so it is what tells a staged bubble restored from the
     *  history cache whether anything is still working on it (see
     *  settleDeadStagedMessages). Today the cache dies with the page too and every
     *  restored stage is live; this stays correct if that ever changes. */
    private _liveStages;
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
    private _liveIndexKey;
    /** When the snapshot was last published (wall clock ms), so a caller that needs
     *  a CURRENT answer can tell whether to re-ask. 0 = never. */
    private _liveIndexAt;
    /** Files this client has an index dispatch in flight for, by scoped path ->
     *  wall clock. See claimIndexRun. */
    private _indexClaims;
    constructor(host: ChatHost);
    /** What the display layer needs to decide whether a run is finished. `keys` holds
     *  every file the server still has indexing work for; `checked` is false until the
     *  first answer for this chat, and false means "we do not know yet". */
    getLiveIndexState(): {
        keys: {
            [fileKey: string]: boolean;
        };
        checked: boolean;
    };
    /** Passes that were on a row when the user stopped it, so the display layer can
     *  still tell that this run was stopped once the stop has left no other trace.
     *  See cancelIndexingGroup, which fills it, and buildChatDisplayList, which is
     *  the only reader. */
    getStoppedIndexIds(): {
        [serverItemId: string]: boolean;
    };
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
    hasLiveIndexRun(storagePath?: string): boolean;
    /** Storage paths are project-relative, and one ChatSession serves every
     *  project, so a claim has to be scoped the way a stop is (_indexKeyOf). */
    private _indexClaimKey;
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
    claimIndexRun(storagePath?: string): Promise<boolean>;
    /** Give the slot back — the dispatch failed, or was abandoned. */
    releaseIndexRun(storagePath?: string): void;
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
    isIndexRunLive(storagePath?: string): Promise<boolean>;
    /** Re-ask the queue which files are still being indexed, unless the answer we
     *  have is younger than `maxAgeMs`. Shared by every caller that needs a current
     *  one; the display layer's own refresh path is the adopt ladder. */
    private _refreshLiveIndexKeys;
    /**
     * Replace the live-index snapshot from a queue query's raw items.
     *
     * Whole-snapshot, never incremental: the query returns everything unresolved on
     * the queue, so a file MISSING from it is precisely the fact we are after. Merging
     * would make a finished file impossible to observe.
     */
    private _recordLiveIndexKeys;
    /** Forget the snapshot: it describes ONE chat's queue, and the answer for the
     *  project the user just switched to is unknown until it is asked for again. */
    private _resetLiveIndexKeys;
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
    refreshLiveIndexState(): void;
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
    resetLiveIndexState(): void;
    /** Wrap an indexing-request dispatch so awaitIndexingDrained counts it as
     *  live work from the moment it is sent, not from the moment it is acked. */
    trackIndexDispatch<T>(p: Promise<T>): Promise<T>;
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
    private _nudgeIndexingDrain;
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
    attachForegroundPoll(source: any, itemId: string, opts?: any, ctx?: StreamDispatchContext): any;
    private _fgPollWithEarlyProbe;
    private _trackPoll;
    /** Background polls currently attached, for the MAX_CONCURRENT_BG_POLLS budget.
     *  Counts the registry rather than a separate tally so it cannot drift: every
     *  attach goes through _trackPoll and every detach deletes the entry. Note an
     *  entry left behind by pausePolling on an older skapi-js (no stop handle)
     *  still counts, which is correct — that poll really is still running. */
    private _countBgPolls;
    /** Live streams by server item id. One per in-flight streamed turn. */
    private liveStreams;
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
    private _beginLiveStream;
    /** The chunk sink handed to skapi's poll. Raw relayed text, in order, never parsed
     *  here: the parser owns the grammar and this owns the pacing. */
    private _feedLiveStream;
    /**
     * Write the safe prefix of the answer so far into the turn's bubble.
     *
     * notify() is spent EXACTLY ONCE per turn, on the first paint, because that is a
     * state change the per-bubble refresh cannot express: the bubble stops being a
     * "Thinking..." spinner and becomes text. Every paint after it goes through
     * refreshMessageBubble, which is what keeps a growing answer from rebuilding the
     * whole display list once a second.
     */
    private _paintLiveStream;
    /** The bubble a live stream paints into: the turn's pending assistant placeholder,
     *  found by server item id. Not by _localId, deliberately - a history refetch
     *  replaces the local copy with the server's, and only the id survives that. */
    private _liveTargetIndex;
    /** Hand the host its optional observation update. Guarded: this runs on the paint
     *  path, and a throwing hook must not cost the user the rest of their answer. */
    private _reportLiveStream;
    /** Stop painting and (when the turn really ended) assemble the body. `finished`
     *  is false for a stream being discarded rather than settled: a retry replacing
     *  it, or a stop, neither of which has an answer to assemble. */
    private _closeLiveStream;
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
    private _settleLiveStream;
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
    private _mayFinalize;
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
    private _finalizeStreamedTurn;
    /** Painted-but-unsettled live text on a bubble, for the typewriter to resume from.
     *  A pending assistant placeholder is created with content '' by every path that
     *  makes one, so non-empty content on one can only have been painted here. */
    private _paintedTextAt;
    private _streamRecovery?;
    /** The recovery bookkeeping, created on first touch.
     *
     *  LAZY, not constructor-initialised, and for a concrete reason: ChatSession is
     *  also built with Object.create(ChatSession.prototype) by the engine's own test
     *  harnesses, which drive one method against a hand-built state rather than a
     *  whole session. A field only the constructor creates is undefined there, and
     *  the method that reaches for it throws, turning a test of the settle into a
     *  crash about bookkeeping. */
    private _rec;
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
    private _markRecoveryPhase;
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
    private _adoptLocalAnswers;
    /**
     * This session's fetching state for one turn, from the bookkeeping rather than
     * from any bubble. A queued entry counts as 'active': it is committed to be read,
     * serially, and the reader has no way to tell "being read" from "next in line"
     * apart from the wait.
     */
    private _recoveryPhaseFor;
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
    adoptLocalAnswers(mapped: ChatMessage[], loadKey?: string): void;
    /**
     * Queue the on-screen turns whose answer is only in the chunk store, newest
     * first, and start draining. Never blocks and never throws.
     *
     * `ownerKey` is the chat the queue entries belong to, snapshotted by the caller:
     * a recovery that lands after the user has moved on writes into that chat's
     * cache, never into whatever list is on screen by then.
     */
    private _scheduleStreamRecovery;
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
    scheduleStreamRecovery(ownerKey: string, platform: 'claude' | 'openai', projectId: string, owner: string): void;
    /** Serial drain of the recovery queue. Each entry is one full chunk read. */
    private _drainStreamRecovery;
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
    recoverStreamedAnswer(itemId: string): Promise<void>;
    private _readBackStreamedTurn;
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
    private _applyRecoveredAnswer;
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
    private _clearStreamPendingMark;
    /**
     * Stop and forget one item's poll. Used after a cancel: the row is either gone
     * (cancelled while queued) or flagged cancelled (cancelled while running), so
     * asking about it again only burns requests. Safe when no poll is attached, and
     * safe on an older skapi-js with no stop handle (the entry is then LEFT in the
     * map so a later drain cannot stack a second, unstoppable poll on the id).
     */
    private _stopPoll;
    /** True while any pause reason is active. */
    isPollingPaused(): boolean;
    /**
     * Stop BACKGROUND polling until resumePolling. Foreground polls (a reply the user is
     * waiting on) keep running deliberately: their results must still land in the history
     * cache so resumePendingRequest can render them on return, otherwise a user who sends
     * a message then navigates away comes back to a permanently stuck "Thinking...".
     *
     * Server-side work is untouched; this only stops asking about it. That is safe for
     * document indexing because the worker drives that loop itself.
     */
    pausePolling(reason: string): void;
    /**
     * Lift a pause reason WITHOUT running the reconcile. For a caller that is about to
     * reload history anyway (a view remounting), letting resumePolling also reconcile
     * would race that load and can double-attach.
     */
    clearPauseReason(reason: string): void;
    /**
     * Clear a pause reason and, once none remain, re-attach polling and reconcile.
     * Deliberately does NOT touch gateRefreshToken: bumping it would silently discard
     * the results of anything still in flight across the pause.
     */
    resumePolling(reason: string): Promise<void>;
    private _newLocalId;
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
    getHistoryCacheKey(): string;
    private _hydratedBodies;
    private _hydratingItems;
    /** Re-apply memoized hydrated texts onto freshly-mapped messages. Both
     *  clients call this right after their mapper runs (loadHistory does it
     *  internally); it mutates the given array's items in place. */
    applyHydratedBodies(messages: ChatMessage[]): void;
    /** Fetch the real response bodies for compact history stubs (one csr-poll
     *  point lookup per item id), memoize, and swap them into the live list.
     *  Best-effort: a failed lookup leaves the stub (its head + fallback line
     *  still render) and a later expand retries. */
    hydrateCompactItems(itemIds: string[]): Promise<void>;
    updateHistoryCache(): void;
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
    private _stampTurnWithItemId;
    /**
     * Land a resolved reply in the history cache of a chat that is NOT currently
     * visible, without touching state.messages. Mirrors the cache-only path in
     * dispatchAgentRequest: REPLACE the trailing pending "Thinking..." bubble
     * (append only when there is none), and settle the matching pending user
     * bubble, so the cached copy never keeps a stuck "Thinking..." that a later
     * cache-first load would re-render forever.
     */
    private _applyReplyToCache;
    /**
     * projectId/owner are passed explicitly by every caller: a request can be
     * dispatched after the user moved to another project, and re-reading the live
     * identity here would silently send the turn to THAT project instead of the
     * one it was composed for. Falls back to the live read only when a caller
     * omits them.
     */
    private _callProviderFor;
    dispatchAgentRequest(params: any): Promise<any>;
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
    stageOutgoingMessage(displayText: string): string;
    /** Is anything in this page still uploading/dispatching for this stage? */
    isLiveStage(stageId?: string): boolean;
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
    settleDeadStagedMessages(list: ChatMessage[]): ChatMessage[];
    private _stageIndex;
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
    markStagedMessageIndexing(stageId: string): void;
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
    markStagedMessageReady(stageId: string): void;
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
    awaitIndexingDrained(identity: ChatIdentity): Promise<'drained' | 'timedout' | 'skipped'>;
    /**
     * Abandon a staged turn — its uploads failed outright, so nothing will be
     * dispatched. The bubble stays (the user's text is not silently thrown away)
     * but settles into a plain, non-pending message; the caller reports the
     * failure separately.
     */
    settleStagedMessage(stageId: string): void;
    dispatchComposedMessage(composed: string, useBgQueue?: boolean, composedForLlm?: string, extractContent?: any, fileUrls?: any, pinned?: PinnedDispatchContext): void;
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
    private scrollForDispatch;
    promoteNextBgQueuedToRunning(): void;
    promoteNextQueuedToRunning(): void;
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
    private _ownThinkingIndex;
    resolveQueuedUserBubble(serverId?: string): number | undefined;
    insertAtTarget(msg: ChatMessage, targetIdx: number): void;
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
    private _turnAlreadyRendered;
    onQueuedSendResponse(_composed: string, response: any, platform: string, serverId?: string, ownerKey?: string): void;
    onQueuedSendError(_composed: string, err: any, serverId?: string, ownerKey?: string): void;
    cancelQueuedMessage(msg: ChatMessage, idx: number): void;
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
    cancelIndexingGroup(group: IndexingGroup): void;
    typewriteIntoIndex(idx: number, fullText: string, localId?: string, paintedText?: string): Promise<void>;
    private typewriterQueue;
    enqueueTypewrite(idx: number, fullText: string, localId?: string, paintedText?: string): Promise<any>;
    typewriteLatestReply(key: string): Promise<any>;
    _removeStrayPendingAssistants(): void;
    /** Index of the USER bubble the message at `idx` belongs to — the nearest one
     *  above it, stepping over background bubbles (a file's indexing rows are
     *  inserted between turns). -1 when the nearest thing above is not a user turn,
     *  which for a placeholder means it is an orphan. */
    private _owningUserIndex;
    /** The bubble at `idx` is the "Thinking…" of a DIFFERENT turn that is still
     *  waiting for its answer, so the sweep above must leave it alone. */
    private _isLiveImmediatePlaceholder;
    /** A pending assistant at `idx` is the placeholder OF the turn above it, so a
     *  reply may take its slot. Every path that makes one copies the parent's
     *  _serverItemId (or neither has one yet), so a mismatch means the slot belongs to
     *  some other request and the reply must be spliced in beside it, not on top. */
    private _isOwnPlaceholderOf;
    _clearPendingUserBubble(itemId: string): void;
    resumePendingRequest(token: number): Promise<void>;
    handleHistoryItemResolution(itemId: string, response: any, platform: string): void;
    /** The file an already-rendered background pass is about, off its request
     *  bubble. Null for an ordinary turn, which is most of them. */
    private _indexRefOfItem;
    /**
     * Settle a turn the server reports as cancelled: the request bubble goes to its
     * cancelled form and the "Thinking..." placeholder goes away. The same shape
     * cancelQueuedMessage produces locally, so a cancel this client made and one it
     * merely found out about render identically — and an indexing pass keeps the
     * markers that hold it in its file's collapsed row.
     */
    private _settleCancelledItem;
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
    private _isCancelledPollResult;
    applyHistoryItemResolution(itemId: string, response: any, platform: string): void;
    /** How a bg task maps onto a collapsed row: the row's own key (storage path
     *  when known, else the filename), scoped to the chat it belongs to. A storage
     *  path is project-relative ("report.xlsx"), and ONE ChatSession serves every
     *  project — unscoped, stopping a file in one project would silently suppress
     *  the same filename's continuations in another. */
    private _indexKeyOf;
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
    private _applyIndexCancellations;
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
    private _sweepCancelledIndexing;
    /**
     * True when the WORKER, not this client, drives the rest of this file's chain.
     * The mirror image of the early returns in maybeResumeIndexing: whatever that
     * refuses to continue is exactly what nothing client-side is tracking.
     */
    private _isWorkerDrivenIndexing;
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
    private _adoptingWorkerPasses;
    private _adoptWorkerIndexingPasses;
    /** Anything at all suggesting THIS project's indexing may be live: a queued
     *  local entry, a recorded live key (the adopt look just wrote them), or an
     *  attached poll. Gates the passive adopt ladder's climb. */
    private _hasLiveIndexEvidence;
    /** Any of these ids still queued or still polled, i.e. surviving work. */
    private _isTrackingAny;
    /** One live bg-queue item -> a BgTaskEntry, if it is an indexing pass this
     *  client is not already tracking. Returns whether it was adopted. */
    private _adoptWorkerIndexingItem;
    /** Follow the chain on from a background indexing pass that just settled. */
    private _followWorkerIndexingChain;
    /** Best-effort server-side cancel of a bg-queue item that has no bubble (so
     *  cancelQueuedMessage, which drives one, has nothing to act on). */
    private _cancelServerItem;
    drainBgTaskQueue(): void;
    /** Fire the consumer's done::-marker hook for a run whose completion this
     *  client knows DETERMINISTICALLY (see the two call sites in
     *  maybeResumeIndexing). Best-effort by contract; identity-checked so a
     *  project switch mid-settle cannot stamp the wrong service. */
    _mintDoneMarker(entry: BgTaskEntry): void;
    /** Short, storable form of an error body for the run:: record. */
    _runErrorText(response: any): string;
    /** Close the records of a run whose pass settled OFF-POLL — the answer came
     *  back as history (hidden tab, dead poll, resume refetch), so none of the
     *  poll-side settle handlers ran. Only for SINGLE-PASS files, where one
     *  settled pass is deterministically the whole run (the same contract as
     *  maybeResumeIndexing's single-pass branch); paged files stay with their
     *  drivers. Outcome is read from the settled bubbles' own flags, which is
     *  all the history mapping left us. Best-effort and idempotent throughout. */
    _flipRunFromSettledEntry(entry: BgTaskEntry): void;
    /** Close the durable run:: record for an ending THIS client observed.
     *  service comes from the ENTRY, not the current identity: unlike the done::
     *  mint above, a status flip must land even if the user switched projects
     *  mid-settle — otherwise the record lies 'working' forever. Best-effort
     *  through upsertIndexRunRecordSafe; the consumer's precedence guard keeps
     *  repeats and races harmless. */
    _flipRunRecord(entry: BgTaskEntry, status: IndexRunStatus, error?: string): void;
    maybeResumeIndexing(entry: BgTaskEntry, response: any, platform: string): void;
    loadHistory(fetchMore?: boolean, token?: number): Promise<void>;
    uploadSingleAttachment(att: any, stageId?: string): Promise<Array<{
        name: string;
        url: string;
        storagePath: string;
    }>>;
    uploadPendingAttachments(batchId?: string, stageId?: string): Promise<Array<{
        name: string;
        url: string;
        storagePath?: string;
    }>>;
    stop(): void;
    bumpGate(): void;
}

/**
 * The project's BunnyQuery settings, held as a record in the project's own
 * database rather than on the skapi service record.
 *
 * WHY A RECORD. The upload access group used to live on the service record as
 * `default_access_group`, which was ALSO the skapi SDK's project-wide default
 * for `table.access_group`. One field meant two things: "what BunnyQuery indexes
 * new files at" and "what every SDK record call on this project defaults to".
 * That coupling is gone. The SDK no longer has a project default at all, so this
 * setting needs a home of its own, and a plain public record in the customer's
 * own project is one every client can already reach with the calls it has.
 *
 * SHAPE. One record per project, holding an OBJECT rather than a single value:
 *
 *     unique_id: 'bq::settings'
 *     table:     { name: '__SETTINGS__', access_group: 'public' }
 *     data:      { upload_access_group: 'authorized' }
 *
 * One record and one fetch covers every present and future project setting. A
 * second setting is a new key, not a new record, so the "wait for settings
 * before the first upload" hand-off below never has to become several waits.
 *
 * WHY PUBLIC. The widget reads this, and the widget frequently runs before there
 * is any session. Group 0 is the only group an unauthenticated caller is served
 * (`check_rec_access` returns immediately for "00" and refuses the rest). Note
 * this is NOT sufficient on its own: skapi's `require_login` gate refuses ALL
 * database reads from a signed-out visitor, and it defaults to true, so on most
 * projects a signed-out widget still cannot read this and falls back to the
 * default. That is survivable because the only thing a signed-out visitor could
 * do with the value is upload, which they cannot do either.
 *
 * WHY THE VALUE MATTERS. The file BYTES are not what the access group controls.
 * BunnyQuery uploads to db storage, whose object key carries no access group and
 * whose read path performs no access check. What carries the group is the
 * RECORDS: the `src::` file record in `file_summaries`, the `run::`/`done::`
 * markers in `__INDEXING__`, and every content record the indexing agent
 * extracts. Those are what a chat answers from, so those are what decide who the
 * file is visible to. The same value is also handed to the chat system prompt as
 * `indexAccessGroup`, because a record written under a different group is in a
 * different table and never comes back with the rest of the file.
 *
 * TRANSPORT-FREE, like the rest of the engine. The store never imports a skapi
 * instance; the consumer injects a reader. See configureProjectSettings.
 */
/** The access groups a BunnyQuery upload may be recorded at. */
type UploadAccessGroup = 'public' | 'authorized' | 'private';
declare const UPLOAD_ACCESS_GROUPS: UploadAccessGroup[];
/**
 * What the project's upload-access setting may be: one of the three groups the
 * dashboard offers, or 'ask' to be prompted per upload.
 *
 * `'admin'` (99) is deliberately not offered: a file only a master can read is
 * indistinguishable from one that failed to upload, and no dashboard control
 * would produce it.
 */
type ProjectAccessSetting = UploadAccessGroup | 'ask';
/**
 * `authorized` is the default because it is what every record written before
 * this setting existed was hardcoded to. A project that never opens the setting
 * keeps exactly the visibility it already had. It is also what the abandoned
 * `default_access_group` service field was seeded to at project creation, so a
 * project carrying that old value reads the same before and after the move.
 */
declare const DEFAULT_UPLOAD_ACCESS_GROUP: UploadAccessGroup;
/** Where the settings record lives. Shared so no client re-derives it. */
declare const PROJECT_SETTINGS_TABLE = "__SETTINGS__";
declare const PROJECT_SETTINGS_UNIQUE_ID = "bq::settings";
declare const PROJECT_SETTINGS_ACCESS_GROUP = "public";
declare const UPLOAD_ACCESS_LABELS: Record<UploadAccessGroup, string>;
declare const UPLOAD_ACCESS_HINTS: Record<UploadAccessGroup, string>;
/** Menu/modal option list, in the order they should be shown. */
declare const UPLOAD_ACCESS_OPTIONS: {
    value: UploadAccessGroup;
    label: string;
    hint: string;
}[];
/** The settings record's `data`. Open-ended: future settings are new keys. */
type ProjectSettingsData = {
    upload_access_group?: unknown;
    [key: string]: unknown;
};
/** Narrow an unknown stored value to a usable group, falling back to the default. */
declare function normalizeUploadAccessGroup(value: any): UploadAccessGroup;
/**
 * The stored setting as written, or null when the project has never set one.
 *
 * Returns null rather than a default so callers can tell "unset" from "set to
 * authorized". The settings page needs that distinction to decide what the
 * control shows; upload paths do not and use uploadAccessGroupFrom instead.
 */
declare function normalizeProjectAccessSetting(value: any): ProjectAccessSetting | null;
/** The setting held in a settings-record `data`, or null when unset. */
declare function accessSettingFrom(data: ProjectSettingsData | null | undefined): ProjectAccessSetting | null;
/** The group an upload lands in when the project is NOT set to 'ask'. */
declare function uploadAccessGroupFrom(data: ProjectSettingsData | null | undefined): UploadAccessGroup;
/** True when the project wants to be asked per upload rather than told once. */
declare function asksUploadAccessFrom(data: ProjectSettingsData | null | undefined): boolean;
/**
 * Fetch one project's settings record. Resolves the record's `data`, or null
 * when there is no record.
 *
 * MAY REJECT, and the store treats a rejection as "no record": a signed-out
 * visitor on a `require_login` project gets REQUIRE_LOGIN here, which is a
 * normal outcome and not an error the user should ever see.
 */
type ProjectSettingsReader = (service: string) => Promise<ProjectSettingsData | null>;
declare function configureProjectSettings(fn: ProjectSettingsReader | null): void;
/**
 * Start the fetch and hand back the promise, deduping concurrent callers.
 *
 * Never rejects: a failed read settles as null, which every accessor reads as
 * "unset" and answers with the default. A settings fetch must not be able to
 * fail an upload.
 */
declare function loadProjectSettings(service: string): Promise<ProjectSettingsData | null>;
/**
 * Kick the fetch off without waiting for it. Call on chat/page open.
 *
 * Fire-and-forget by design: the page paints on the default and the first upload
 * awaits the real value via readyProjectSettings. Nothing blocks on this.
 */
declare function primeProjectSettings(service: string): void;
/**
 * Await the settings for this project. What the FIRST upload calls.
 *
 * Cheap after the first call: a settled entry resolves immediately, and a
 * primed-but-unsettled one joins the in-flight request rather than starting a
 * second.
 */
declare function readyProjectSettings(service: string): Promise<ProjectSettingsData | null>;
/**
 * The cached data WITHOUT waiting, or null when nothing has settled yet.
 *
 * For synchronous readers (a template, a menu's current value). A caller that is
 * about to WRITE an access group onto a record must use readyProjectSettings
 * instead: answering from an unsettled cache is how a file lands in the wrong
 * group on the first upload after a page load.
 */
declare function cachedProjectSettings(service: string): ProjectSettingsData | null;
/** True once this project's settings have been fetched (whether or not one existed). */
declare function projectSettingsSettled(service: string): boolean;
/** Sync convenience: the project's setting as stored, or null when unset/unsettled. */
declare function projectAccessSetting(service: string): ProjectAccessSetting | null;
/** Sync convenience: the upload group, falling back to the default. */
declare function projectUploadAccessGroup(service: string): UploadAccessGroup;
/** Sync convenience: does this project want a per-upload prompt? */
declare function projectAsksUploadAccess(service: string): boolean;
/**
 * Adopt a value the caller just WROTE, so the settings page reflects its own
 * save without a re-fetch.
 *
 * Marks the entry settled: the writer knows the stored value better than a
 * refetch would, and leaving it unsettled would send the next upload back to the
 * network for a value already in hand.
 */
declare function setProjectSettings(service: string, data: ProjectSettingsData | null): void;
/** Merge one key into the cached settings, preserving the rest. */
declare function patchProjectSettings(service: string, patch: ProjectSettingsData): void;
/**
 * Drop cached settings. Pass a service to drop one, omit to drop all.
 *
 * An in-flight fetch is abandoned rather than cancelled: its `.then` checks that
 * the entry it is writing into is still its own, so a late response cannot
 * repopulate a cleared project.
 */
declare function clearProjectSettings(service?: string): void;

export { type AiAgentPlatform, type AnchorBoxEl, type AnchorRowEl, type AttachmentFailureGroup, type AttachmentParser, type AttachmentSaveInfo, BG_INDEXING_QUEUE_SUFFIX, BOM, BOM_EXTS, type BgTaskEntry, type BoundedChatOptions, type BuildDisplayListOptions, type BuildIndexingUserMessageOptions, CLAUDE_INPUT_CAP_RATIO, CLAUDE_PER_REQUEST_INPUT_CAP, CONTEXT_WINDOW_BY_MODEL, CONTEXT_WINDOW_DEFAULT, type CallClaudeWithMcpParams, type ChatEngineConfig, type ChatGreetingParams, type ChatGreetingParts, type ChatHost, type ChatIdentity, type ChatMessage, ChatSession, type ChatState, type ChatStreamWiring, type ChatSystemPromptParams, type ClaudeMcpServerRequest, type ClaudeMcpToolConfig, type ClaudeMessage, type ClaudeRole, type ComposedUserMessage, DEFAULT_CLAUDE_MODEL, DEFAULT_CONTEXT_WINDOW, DEFAULT_OPENAI_MODEL, DEFAULT_UPLOAD_ACCESS_GROUP, type DisplayEntry, EMPTY_INDEXING_REPLY, EXPIRED_ATTACHMENT_URL_HOST, EXPIRED_ATTACHMENT_URL_ORIGIN, EXPIRED_LINK_REFRESH_EXPIRES_SECONDS, EXT_CONTENT_TYPES, type EncodingClass, type ExtractDirective, type FillHistoryViewportOptions, HISTORY_BUDGET_RATIO, HISTORY_FILL_SLACK_PX, HISTORY_TOKEN_BUDGET, HTML_EXTS, HTML_HEAD_WINDOW, IMAGE_PREVIEWS_PER_MESSAGE, INDEXING_COMPLETE_MARKER, INDEXING_MAX_OUTPUT_TOKENS, INLINE_LINK_GLYPH, INLINE_LINK_UNAVAILABLE_GLYPH, INLINE_LINK_UNAVAILABLE_SUFFIX, INPUT_CAP_RATIO, type ImagePreviewContext, type IndexRunPatch, type IndexRunStatus, type IndexingAttachmentInfo, type IndexingFileRef, type IndexingGroup, type IndexingGroupStatus, type IndexingRequestRef, type IndexingSystemPromptParams, type InlineLinkContext, type InlineLinkMarkupOptions, type InlineLinkPart, LINK_LABEL_MAX_DISPLAY_CHARS, LINK_REFRESH_WINDOW_MS, type LiveStreamUpdate, MAX_CONCURRENT_BG_POLLS, MAX_HISTORY_FILL_PAGES, MAX_HISTORY_MESSAGES, MAX_OUTPUT_BY_MODEL, MAX_OUTPUT_TOKENS, MAX_PARSED_CONTENT_CHARS, MCP_NAME, MINT_CACHE_GENERATION, MIN_INPUT_TOKEN_BUDGET, MIN_PER_REQUEST_INPUT_CAP, type MapHistoryOptions, OUTPUT_TOKEN_RESERVE, type OpenAIMessage, POLL_INTERVAL, PRESIGN_SAFETY_MARGIN_MS, PREVIEWABLE_IMAGE_CONTENT_TYPES, PREVIEW_BROWSER_CACHE_SECONDS, PREVIEW_LAYOUT_BOX_SELECTOR, PREVIEW_URL_EXPIRES_SECONDS, PROJECT_SETTINGS_ACCESS_GROUP, PROJECT_SETTINGS_TABLE, PROJECT_SETTINGS_UNIQUE_ID, type ParsedAiAgent, type PinnedDispatchContext, type PreviewImageEl, type ProjectAccessSetting, type ProjectSettingsData, type ProjectSettingsReader, RENDER_FROM_TOKEN, RTF_EXTS, RUN_RECORD_WORKING_STALE_MS, type RenderableInlineLink, type RescueDecisionContext, type RowAnchor, type RunStubInfo, STREAM_POLL_INTERVAL, type ScrollAnchor, type ScrollAnchorOptions, type SseChunk, type SseParser, type SseProvider, type SseSnapshot, type SseToolCall, type StreamDispatchContext, TOOL_AND_RESPONSE_BUFFER, UPLOAD_ACCESS_GROUPS, UPLOAD_ACCESS_HINTS, UPLOAD_ACCESS_LABELS, UPLOAD_ACCESS_OPTIONS, type UploadAccessGroup, type VisionProfile, XML_EXTS, __resetSplitHistoryState, accessSettingFrom, adoptLocalAnswerIntoPage, applyEncodingDeclaration, asksUploadAccessFrom, bgIndexingQueueName, buildAiAgentValue, buildBoundedChatMessages, buildChatDisplayList, buildChatGreeting, buildChatSystemPrompt, buildDisplayExpiredAttachmentHref, buildHistoryItemFullId, buildIndexingContinueMessage, buildIndexingRenderContinueTemplate, buildIndexingRenderMessage, buildIndexingSystemPrompt, buildIndexingUserMessage, buildIndexingWindowMessage, cachedProjectSettings, callClaudeWithMcp, callClaudeWithPublicMcp, callOpenAIWithPublicMcp, canonicalizePathForm, chatCacheKey, chatEngineConfig, chatStreamWiring, classifyInlineLink, clearAttachmentParsers, clearImagePreviewCache, clearProjectSettings, composeUserMessage, configureChatEngine, configureProjectSettings, contentTypeForExt, createHistoryFiller, createInlineLinkRegex, createScrollAnchor, createSseParser, csrEnvelopeError, encodePathSegments, encodingClassForExt, ensureHtmlCharset, ensureXmlEncoding, escapeInlineHtml, escapeRtfNonAscii, estimateMessageTokens, estimateTextTokens, extOf, extractClaudeText, extractLastUserTextFromRequest, extractOpenAIText, extractRemotePathFromAttachmentHref, fetchLiveIndexingKeys, fillHistoryViewport, filterListByClearHorizon, findAttachmentParser, formatChatTimestamp, getAttachmentParsers, getChatHistory, getContextWindow, getErrorMessage, getExpiredAttachmentVisiblePath, getInputTokenBudget, getMaxOutputTokens, getModelContextWindow, getProjectContextWindow, getSplitChatHistory, getVisionProfile, groupAttachmentFailures, hasBom, hydrateImagePreviews, indexDoneUniqueId, indexScopeKey, indexingAccessGroup, isAuthExpiredError, isBgIndexingQueue, isCsrStatusEnvelope, isErrorResponseBody, isHttpUrlLike, isIndexingRequestText, isLinkUnavailable, isNonRetryableRequestError, isOfficeFile, isPreviewableImagePath, isProviderApiKeyError, isServerExtractable, isServiceDbAttachmentHref, linkUnavailableKeyForHref, linkUnavailableKeyForPath, linkUnavailableKeysForPath, listClaudeModels, listOpenAIModels, liveSafePrefix, loadProjectSettings, looksLikeRtf, makeExtractPlaceholder, mapHistoryListToMessages, markImagePreviewStale, mayKeepStreamedAnswer, mintCacheBustStamp, needsBomForExt, normalizeAttachmentPathCandidate, normalizeExt, normalizeProjectAccessSetting, normalizeTextContent, normalizeTrailingInlineToken, normalizeUploadAccessGroup, notifyAgentSaveAttachment, parseAiAgentValue, parseAttachmentContent, parseIndexingLabel, parseIndexingRequestText, patchProjectSettings, peekImagePreviewUrl, prepareDownloadText, presignExpiryEpochMs, previewImageContentType, previewLayoutBox, previewMintCacheToken, previewableExtOf, primeProjectSettings, projectAccessSetting, projectAsksUploadAccess, projectSettingsSettled, projectUploadAccessGroup, readExpiredAttachmentHref, readyProjectSettings, registerAttachmentParser, registerModelContextWindows, renderInlineLinkHtml, repairUrlEntities, repairUrlWhitespace, resolveImagePreviewUrl, runIndexUniqueId, safeDecodeURIComponent, sanitizeAttachmentLinksForHistory, setProjectContextWindow, setProjectSettings, shouldRescueInFlightMessage, skapiSupportsStreaming, streamRecoveryEnabled, streamRecoveryLabels, streamRecoveryPhase, stripFileBlocksFromHistory, transformContentWithImages, transformContentWithOpenAIImages, truncateLabelForDisplay, typewriterResumeIndex, uploadAccessGroupFrom, upsertIndexRunRecordSafe, wallClockNow };
