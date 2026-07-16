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
 * BASE PROMPT — Chat assistant
 * ============================================================================
 * System prompt sent on every chat turn. Rebuilt fresh on every send because
 * the project name/description can change at any time.
 *
 * The `${...}` placeholders are filled from the live project (service):
 *   formattedServiceId  -> the project ID the assistant is scoped to
 *   serviceName         -> project display name   (only added if a description exists)
 *   serviceDescription  -> project description     (only added if present)
 */
type ChatSystemPromptParams = {
    /** The project/service ID this assistant is scoped to (formatted form). */
    formattedServiceId: string;
    /** Project display name. Only appended when a description is also present. */
    serviceName?: string;
    /** Project description. When present, name + description are appended. */
    serviceDescription?: string;
};
declare function buildChatSystemPrompt(params: ChatSystemPromptParams): string;

/**
 * BASE PROMPT — Background file-indexing agent (system prompt)
 * ============================================================================
 * System prompt for the BACKGROUND indexing agent (notifyAgentSaveAttachment).
 * Its only job is to read the freshly uploaded file and persist what it learns
 * into the project's knowledge base via the MCP tools. Pairs with the
 * user-message template in ./indexing_user_message.ts.
 */
type IndexingSystemPromptParams = {
    /** The project/service ID being indexed into. */
    service: string;
    /** Project display name. Only appended when a description is also present. */
    serviceName?: string;
    /** Project description. When present, name + description are appended. */
    serviceDescription?: string;
};
declare function buildIndexingSystemPrompt(params: IndexingSystemPromptParams): string;

/**
 * BASE PROMPT — Background file-indexing agent (user message)
 * ============================================================================
 * USER-role message paired with the indexing system prompt. Sent by
 * notifyAgentSaveAttachment() each time a file is uploaded or re-indexed.
 *
 * NOTE: the leading line "A new file has just been uploaded. Index it now." and
 * the "- name: ..." line are also what the chat client parses to build the
 * "Indexing: <name>" history bubble — keep those fields on their own lines.
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
     * For office files (.docx/.xlsx/.pptx) the model can't read the binary via
     * web_fetch, so the proxy worker extracts the text server-side and replaces
     * this exact token with it. When provided, the message embeds the token (and
     * drops the temporary-URL line — there is nothing for the model to fetch).
     */
    inlineContentPlaceholder?: string;
    /**
     * Actual file content parsed CLIENT-SIDE by an attachment-parser plugin (e.g.
     * an .hwp parser). Embedded inline verbatim — no server extraction and no
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
 * User message for a VISION file (PDF): its pages are delivered as RENDERED PAGE IMAGES that
 * the proxy worker injects into THIS message at the `placeholder` token (tool-result images
 * render on neither provider, so the pages must be image blocks in the message itself). Each
 * pass shows one WINDOW of pages starting at `renderFrom` (0-based); the resume loop advances
 * the window a pass at a time until the injected note says the last window was reached.
 *
 * renderFrom === 0 is the FIRST pass (leads with "A new file has just been uploaded." so the
 * client builds the "Indexing: <name>" bubble); renderFrom > 0 is a RESUME pass (leads with
 * "CONTINUE indexing" like the paged continue message, so it is not a duplicate primary bubble).
 */
declare function buildIndexingRenderMessage(attachment: IndexingAttachmentInfo, placeholder: string, renderFrom: number): string;
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
declare var OUTPUT_TOKEN_RESERVE: number;
declare var TOOL_AND_RESPONSE_BUFFER: number;
declare var MIN_INPUT_TOKEN_BUDGET: number;
declare var CLAUDE_PER_REQUEST_INPUT_CAP: number;
declare var MAX_HISTORY_MESSAGES: number;
declare var HISTORY_TOKEN_BUDGET: number;
declare function estimateTextTokens(text: string): number;
declare function estimateMessageTokens(msg: {
    role: string;
    content: string;
}): number;
declare function getContextWindow(platform: string, model?: string): number;
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
    serviceId: string;
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
 * Pure link/path helpers (no DOM, no marked). Moved verbatim from the chatbox.
 * `serviceId` is passed as a PARAMETER (the original read it from a global) so
 * the engine stays consumer-agnostic. The HTML-emitting helpers
 * (buildLinkPartFromGroups, linkToAnchorHtml, fileToAnchorHtml, parseMsgParts*)
 * stay in each VIEW — only these pure pieces move here.
 */
declare var EXPIRED_ATTACHMENT_URL_HOST: string;
declare var EXPIRED_ATTACHMENT_URL_ORIGIN: string;
declare var LINK_LABEL_MAX_DISPLAY_CHARS: number;
declare function createInlineLinkRegex(): RegExp;
declare function safeDecodeURIComponent(v: string): string;
declare function encodePathSegments(path: string): string;
declare function normalizeAttachmentPathCandidate(value: string): string;
declare function extractRemotePathFromAttachmentHref(href: string, serviceId: string): string | null;
declare function getExpiredAttachmentVisiblePath(remotePath: string, fallback?: string): string;
declare function buildDisplayExpiredAttachmentHref(remotePath: string, fallback?: string): string;
declare function isServiceDbAttachmentHref(href: string, serviceId: string): boolean;
declare function sanitizeAttachmentLinksForHistory(content: string, serviceId: string, forAssistant?: boolean): string;
declare function truncateLabelForDisplay(label: string): string;

declare function filterListByClearHorizon(list: any[], clearedAt: number): any[];
declare function normalizeTextContent(content: any): string;
declare function extractLastUserTextFromRequest(requestBody: any): string;
type MapHistoryOptions = {
    clearedAt: number;
    serviceId: string;
    /** View-side display formatter for "Indexing:/Reindexing: …" bubbles. */
    formatIndexingLabel: (name: string, mime?: string, size?: number | null, storagePath?: string) => string;
};
declare function mapHistoryListToMessages(list: any[], platform: 'claude' | 'openai', opts: MapHistoryOptions): {
    messages: any[];
    runningItemIds: string[];
};

declare const MCP_NAME = "BunnyQuery";
declare const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
declare const DEFAULT_OPENAI_MODEL = "gpt-5.4";
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
declare const POLL_INTERVAL = 1500;
declare function callClaudeWithMcp({ prompt, messages, service, owner, userId, model, maxTokens, system, mcpServer, extractContent, fileUrls, }: CallClaudeWithMcpParams): Promise<any>;
declare function callClaudeWithPublicMcp(prompt: string, service: string, owner: string, messages?: ClaudeMessage[], system?: string, model?: string, userId?: string, extractContent?: ExtractDirective[], fileUrls?: FileUrlDirective[], onResponse?: (res: any) => void, onError?: (err: any) => void): Promise<any>;
declare function callOpenAIWithPublicMcp(prompt: string, service: string, owner: string, messages?: OpenAIMessage[], system?: string, model?: string, userId?: string, extractContent?: ExtractDirective[], fileUrls?: FileUrlDirective[], onResponse?: (res: any) => void, onError?: (err: any) => void): Promise<any>;
type AttachmentSaveInfo = {
    platform: 'claude' | 'openai';
    model?: string;
    service: string;
    owner: string;
    userId?: string;
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
type BgTaskEntry = {
    serviceId: string;
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
};
declare function getChatHistory(params: {
    service?: string;
    owner?: string;
    platform: 'claude' | 'openai';
    queue?: string;
}, fetchOptions: Record<string, any>): Promise<any>;

/**
 * ChatSession host adapter + state types.
 *
 * ChatSession is DOM-free and Vue-free; the consumer (bunnyquery widget or the
 * agent.vue chatbox) implements `ChatHost` to bridge identity, rendering, scroll,
 * and the skapi cancel/refresh surface. Everything the session needs that would
 * otherwise touch the DOM or a framework goes through a host hook.
 */
interface ChatIdentity {
    serviceId: string;
    owner: string;
    /** Per-user queue name (falls back to serviceId). */
    userId: string;
    platform: 'claude' | 'openai' | 'none';
    model?: string;
    serviceName?: string;
    serviceDescription?: string;
}
interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    isPending?: boolean;
    isPendingInProcess?: boolean;
    isPendingQueued?: boolean;
    isPendingOlder?: boolean;
    isSendingToServer?: boolean;
    isCancelled?: boolean;
    isError?: boolean;
    isBackgroundTask?: boolean;
    _useBgQueue?: boolean;
    _serverItemId?: string;
    _localId?: string;
    _cancelling?: boolean;
    _cancelError?: string;
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
    historyEndOfList: boolean;
    historyStartKeyHistory: string[];
    historyRequestToken: number;
    gateRefreshToken: number;
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
    formatIndexingLabel(name: string, mime?: string, size?: number | null, storagePath?: string, reindex?: boolean): string;
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

declare class ChatSession {
    host: ChatHost;
    state: ChatState;
    bgTaskQueue: BgTaskEntry[];
    cancelledServerIds: Set<string>;
    pendingAgentRequests: Record<string, Promise<any>>;
    aiChatHistoryCache: Record<string, {
        messages: ChatMessage[];
        endOfList: boolean;
        startKeyHistory: string[];
    }>;
    historyItemPolls: Map<string, boolean>;
    private _lidSeq;
    constructor(host: ChatHost);
    private _newLocalId;
    getHistoryCacheKey(): string;
    updateHistoryCache(): void;
    private _callProviderFor;
    dispatchAgentRequest(params: any): Promise<any>;
    dispatchComposedMessage(composed: string, useBgQueue?: boolean, composedForLlm?: string, extractContent?: any, fileUrls?: any): void;
    promoteNextBgQueuedToRunning(): void;
    promoteNextQueuedToRunning(): void;
    resolveQueuedUserBubble(serverId?: string): number | undefined;
    insertAtTarget(msg: ChatMessage, targetIdx: number): void;
    onQueuedSendResponse(_composed: string, response: any, platform: string, serverId?: string): void;
    onQueuedSendError(_composed: string, err: any, serverId?: string): void;
    cancelQueuedMessage(msg: ChatMessage, idx: number): void;
    typewriteIntoIndex(idx: number, fullText: string, localId?: string): Promise<void>;
    private typewriterQueue;
    enqueueTypewrite(idx: number, fullText: string, localId?: string): Promise<any>;
    typewriteLatestReply(key: string): Promise<any>;
    _removeStrayPendingAssistants(): void;
    _clearPendingUserBubble(itemId: string): void;
    resumePendingRequest(token: number): Promise<void>;
    handleHistoryItemResolution(itemId: string, response: any, platform: string): void;
    applyHistoryItemResolution(itemId: string, response: any, platform: string): void;
    drainBgTaskQueue(): void;
    maybeResumeIndexing(entry: BgTaskEntry, response: any, platform: string): void;
    loadHistory(fetchMore?: boolean, token?: number): Promise<void>;
    uploadSingleAttachment(att: any): Promise<Array<{
        name: string;
        url: string;
        storagePath: string;
    }>>;
    uploadPendingAttachments(): Promise<Array<{
        name: string;
        url: string;
        storagePath?: string;
    }>>;
    stop(): void;
    bumpGate(): void;
}

export { type AttachmentFailureGroup, type AttachmentParser, type AttachmentSaveInfo, BG_INDEXING_QUEUE_SUFFIX, type BgTaskEntry, type BoundedChatOptions, type BuildIndexingUserMessageOptions, CLAUDE_PER_REQUEST_INPUT_CAP, CONTEXT_WINDOW_BY_MODEL, CONTEXT_WINDOW_DEFAULT, type CallClaudeWithMcpParams, type ChatEngineConfig, type ChatHost, type ChatIdentity, type ChatMessage, ChatSession, type ChatState, type ChatSystemPromptParams, type ClaudeMcpServerRequest, type ClaudeMcpToolConfig, type ClaudeMessage, type ClaudeRole, type ComposedUserMessage, DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL, EXPIRED_ATTACHMENT_URL_HOST, EXPIRED_ATTACHMENT_URL_ORIGIN, type ExtractDirective, HISTORY_TOKEN_BUDGET, type IndexingAttachmentInfo, type IndexingSystemPromptParams, LINK_LABEL_MAX_DISPLAY_CHARS, MAX_HISTORY_MESSAGES, MAX_PARSED_CONTENT_CHARS, MCP_NAME, MIN_INPUT_TOKEN_BUDGET, type MapHistoryOptions, OUTPUT_TOKEN_RESERVE, type OpenAIMessage, POLL_INTERVAL, TOOL_AND_RESPONSE_BUFFER, buildBoundedChatMessages, buildChatSystemPrompt, buildDisplayExpiredAttachmentHref, buildIndexingContinueMessage, buildIndexingRenderMessage, buildIndexingSystemPrompt, buildIndexingUserMessage, callClaudeWithMcp, callClaudeWithPublicMcp, callOpenAIWithPublicMcp, chatEngineConfig, clearAttachmentParsers, composeUserMessage, configureChatEngine, createInlineLinkRegex, encodePathSegments, estimateMessageTokens, estimateTextTokens, extractClaudeText, extractLastUserTextFromRequest, extractOpenAIText, extractRemotePathFromAttachmentHref, filterListByClearHorizon, findAttachmentParser, getAttachmentParsers, getChatHistory, getContextWindow, getErrorMessage, getExpiredAttachmentVisiblePath, groupAttachmentFailures, isAuthExpiredError, isErrorResponseBody, isNonRetryableRequestError, isOfficeFile, isServerExtractable, isServiceDbAttachmentHref, listClaudeModels, listOpenAIModels, makeExtractPlaceholder, mapHistoryListToMessages, normalizeAttachmentPathCandidate, normalizeTextContent, notifyAgentSaveAttachment, parseAttachmentContent, registerAttachmentParser, safeDecodeURIComponent, sanitizeAttachmentLinksForHistory, stripFileBlocksFromHistory, transformContentWithImages, transformContentWithOpenAIImages, truncateLabelForDisplay };
