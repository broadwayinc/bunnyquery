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
}>): ComposedUserMessage;

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
 * Error detection + message extraction (pure). Moved verbatim from the
 * agent.vue / bunnyquery chatbox so both consumers share one implementation.
 */
declare function getErrorMessage(input: any): string;
declare function isErrorResponseBody(response: any): boolean;
declare function isNonRetryableRequestError(input: any): boolean;
declare function isAuthExpiredError(input: any): boolean;

declare var CONTEXT_WINDOW_DEFAULT: Record<string, number>;
declare var CONTEXT_WINDOW_BY_MODEL: Record<string, number>;
/**
 * Record context windows from a provider models listing. Accepts the raw list
 * items and reads `max_input_tokens` (Anthropic); items without it are skipped,
 * so passing an OpenAI listing is a no-op rather than an error.
 */
declare function registerModelContextWindows(models: Array<{
    id?: string;
    max_input_tokens?: number;
}> | null | undefined): void;
declare function setProjectContextWindow(projectId: string, tokens: number | null | undefined): void;
declare function getProjectContextWindow(projectId: string): number | null;
declare var OUTPUT_TOKEN_RESERVE: number;
declare var TOOL_AND_RESPONSE_BUFFER: number;
declare var MIN_INPUT_TOKEN_BUDGET: number;
declare var CLAUDE_PER_REQUEST_INPUT_CAP: number;
declare var MAX_HISTORY_MESSAGES: number;
declare var HISTORY_TOKEN_BUDGET: number;
declare var CLAUDE_INPUT_CAP_RATIO: number;
declare var HISTORY_BUDGET_RATIO: number;
declare function estimateTextTokens(text: string): number;
declare function estimateMessageTokens(msg: {
    role: string;
    content: string;
}): number;
/**
 * Resolve a model's context window, most specific source first:
 *   1. per-project override (project settings)
 *   2. the provider's own models listing (Anthropic `max_input_tokens`)
 *   3. an exact entry in CONTEXT_WINDOW_BY_MODEL
 *   4. a family entry, by dropping trailing '-' segments off the id
 *   5. the platform default
 *
 * Step 4 is why a new or suffixed id no longer drops straight to the platform
 * default: 'gpt-5.6-luna' resolves via 'gpt-5.6', and a dated Claude snapshot
 * such as 'claude-opus-4-7-20260101' resolves via 'claude-opus-4-7'. The walk
 * stops at the first hit, so a more specific entry always wins over its family.
 */
declare function getContextWindow(platform: string, model?: string, projectId?: string): number;
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
 * Seconds the browser may reuse a minted preview url (`browser_cache`).
 *
 * A presigned url is a fresh SigV4 query string on every mint, so it can never
 * be a browser cache key on its own and every reload re-downloads every image.
 * Asking for the MINT with a cacheable GET fixes it from the other end: the same
 * url comes back out of the browser cache, so the body already on disk stays
 * addressable.
 *
 * Deliberately far longer than EXPIRED_LINK_REFRESH_EXPIRES_SECONDS above, and
 * that is the whole trick: the url is short-lived while the file stays available
 * locally for a WEEK. What keeps an image painting is the cached BODY, not a live
 * url. Once the browser evicts that body it refetches with a url that has since
 * expired, gets a 403, and the error path re-mints with `refresh`. That path is
 * therefore load-bearing, not a rare fallback.
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
declare function linkUnavailableKeyForPath(remotePath: string): string;
declare function linkUnavailableKeyForHref(href: string): string;
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

declare const MCP_NAME = "BunnyQuery";
declare const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
declare const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
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
declare const MAX_CONCURRENT_BG_POLLS = 6;
declare function callClaudeWithMcp({ prompt, messages, service, owner, userId, model, maxTokens, system, mcpServer, extractContent, fileUrls, }: CallClaudeWithMcpParams): Promise<any>;
declare function callClaudeWithPublicMcp(prompt: string, service: string, owner: string, messages?: ClaudeMessage[], system?: string, model?: string, userId?: string, extractContent?: ExtractDirective[], fileUrls?: FileUrlDirective[], onResponse?: (res: any) => void, onError?: (err: any) => void): Promise<any>;
declare function callOpenAIWithPublicMcp(prompt: string, service: string, owner: string, messages?: OpenAIMessage[], system?: string, model?: string, userId?: string, extractContent?: ExtractDirective[], fileUrls?: FileUrlDirective[], onResponse?: (res: any) => void, onError?: (err: any) => void): Promise<any>;
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
}, fetchOptions: Record<string, any>, 
/** Test seam: replaces getChatHistory. Not for production callers. */
_fetchImpl?: typeof getChatHistory): Promise<SplitHistoryResult>;
type MapHistoryOptions = {
    clearedAt: number;
    projectId: string;
    /** View-side display formatter for "Indexing:/Reindexing: …" bubbles. */
    formatIndexingLabel: (name: string, mime?: string, size?: number | null, storagePath?: string, reindex?: boolean, continued?: boolean) => string;
};
declare function mapHistoryListToMessages(list: any[], platform: 'claude' | 'openai', opts: MapHistoryOptions): {
    messages: any[];
    runningItemIds: string[];
};

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
     */
    private _trackPoll;
    /** Background polls currently attached, for the MAX_CONCURRENT_BG_POLLS budget.
     *  Counts the registry rather than a separate tally so it cannot drift: every
     *  attach goes through _trackPoll and every detach deletes the entry. Note an
     *  entry left behind by pausePolling on an older skapi-js (no stop handle)
     *  still counts, which is correct — that poll really is still running. */
    private _countBgPolls;
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
    typewriteIntoIndex(idx: number, fullText: string, localId?: string): Promise<void>;
    private typewriterQueue;
    enqueueTypewrite(idx: number, fullText: string, localId?: string): Promise<any>;
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

export { type AiAgentPlatform, type AttachmentFailureGroup, type AttachmentParser, type AttachmentSaveInfo, BG_INDEXING_QUEUE_SUFFIX, BOM, BOM_EXTS, type BgTaskEntry, type BoundedChatOptions, type BuildDisplayListOptions, type BuildIndexingUserMessageOptions, CLAUDE_INPUT_CAP_RATIO, CLAUDE_PER_REQUEST_INPUT_CAP, CONTEXT_WINDOW_BY_MODEL, CONTEXT_WINDOW_DEFAULT, type CallClaudeWithMcpParams, type ChatEngineConfig, type ChatHost, type ChatIdentity, type ChatMessage, ChatSession, type ChatState, type ChatSystemPromptParams, type ClaudeMcpServerRequest, type ClaudeMcpToolConfig, type ClaudeMessage, type ClaudeRole, type ComposedUserMessage, DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL, type DisplayEntry, EMPTY_INDEXING_REPLY, EXPIRED_ATTACHMENT_URL_HOST, EXPIRED_ATTACHMENT_URL_ORIGIN, EXPIRED_LINK_REFRESH_EXPIRES_SECONDS, EXT_CONTENT_TYPES, type EncodingClass, type ExtractDirective, type FillHistoryViewportOptions, HISTORY_BUDGET_RATIO, HISTORY_FILL_SLACK_PX, HISTORY_TOKEN_BUDGET, HTML_EXTS, HTML_HEAD_WINDOW, IMAGE_PREVIEWS_PER_MESSAGE, INDEXING_COMPLETE_MARKER, INLINE_LINK_GLYPH, INLINE_LINK_UNAVAILABLE_GLYPH, INLINE_LINK_UNAVAILABLE_SUFFIX, type ImagePreviewContext, type IndexRunPatch, type IndexRunStatus, type IndexingAttachmentInfo, type IndexingFileRef, type IndexingGroup, type IndexingGroupStatus, type IndexingRequestRef, type IndexingSystemPromptParams, type InlineLinkContext, type InlineLinkMarkupOptions, type InlineLinkPart, LINK_LABEL_MAX_DISPLAY_CHARS, LINK_REFRESH_WINDOW_MS, MAX_CONCURRENT_BG_POLLS, MAX_HISTORY_FILL_PAGES, MAX_HISTORY_MESSAGES, MAX_PARSED_CONTENT_CHARS, MCP_NAME, MIN_INPUT_TOKEN_BUDGET, type MapHistoryOptions, OUTPUT_TOKEN_RESERVE, type OpenAIMessage, POLL_INTERVAL, PREVIEWABLE_IMAGE_CONTENT_TYPES, PREVIEW_BROWSER_CACHE_SECONDS, type ParsedAiAgent, type PinnedDispatchContext, type PreviewImageEl, RENDER_FROM_TOKEN, RTF_EXTS, RUN_RECORD_WORKING_STALE_MS, type RenderableInlineLink, type RunStubInfo, TOOL_AND_RESPONSE_BUFFER, type VisionProfile, XML_EXTS, __resetSplitHistoryState, applyEncodingDeclaration, bgIndexingQueueName, buildAiAgentValue, buildBoundedChatMessages, buildChatDisplayList, buildChatSystemPrompt, buildDisplayExpiredAttachmentHref, buildHistoryItemFullId, buildIndexingContinueMessage, buildIndexingRenderContinueTemplate, buildIndexingRenderMessage, buildIndexingSystemPrompt, buildIndexingUserMessage, buildIndexingWindowMessage, callClaudeWithMcp, callClaudeWithPublicMcp, callOpenAIWithPublicMcp, chatEngineConfig, classifyInlineLink, clearAttachmentParsers, clearImagePreviewCache, composeUserMessage, configureChatEngine, contentTypeForExt, createHistoryFiller, createInlineLinkRegex, encodePathSegments, encodingClassForExt, ensureHtmlCharset, ensureXmlEncoding, escapeInlineHtml, escapeRtfNonAscii, estimateMessageTokens, estimateTextTokens, extOf, extractClaudeText, extractLastUserTextFromRequest, extractOpenAIText, extractRemotePathFromAttachmentHref, fetchLiveIndexingKeys, fillHistoryViewport, filterListByClearHorizon, findAttachmentParser, formatChatTimestamp, getAttachmentParsers, getChatHistory, getContextWindow, getErrorMessage, getExpiredAttachmentVisiblePath, getProjectContextWindow, getSplitChatHistory, getVisionProfile, groupAttachmentFailures, hasBom, hydrateImagePreviews, indexDoneUniqueId, isAuthExpiredError, isBgIndexingQueue, isErrorResponseBody, isHttpUrlLike, isIndexingRequestText, isLinkUnavailable, isNonRetryableRequestError, isOfficeFile, isPreviewableImagePath, isServerExtractable, isServiceDbAttachmentHref, linkUnavailableKeyForHref, linkUnavailableKeyForPath, listClaudeModels, listOpenAIModels, looksLikeRtf, makeExtractPlaceholder, mapHistoryListToMessages, markImagePreviewStale, needsBomForExt, normalizeAttachmentPathCandidate, normalizeExt, normalizeTextContent, normalizeTrailingInlineToken, notifyAgentSaveAttachment, parseAiAgentValue, parseAttachmentContent, parseIndexingLabel, parseIndexingRequestText, peekImagePreviewUrl, prepareDownloadText, previewImageContentType, previewableExtOf, readExpiredAttachmentHref, registerAttachmentParser, registerModelContextWindows, renderInlineLinkHtml, repairUrlEntities, repairUrlWhitespace, resolveImagePreviewUrl, runIndexUniqueId, safeDecodeURIComponent, sanitizeAttachmentLinksForHistory, setProjectContextWindow, stripFileBlocksFromHistory, transformContentWithImages, transformContentWithOpenAIImages, truncateLabelForDisplay, upsertIndexRunRecordSafe, wallClockNow };
