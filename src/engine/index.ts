/**
 * @skapi/chat-engine — framework-agnostic chat engine.
 *
 * Tier-1 (this barrel): pure transport/logic shared by agent.vue and the
 * BunnyQuery widget. DOM-free and Vue-free. Consumers inject the skapi
 * transport + MCP base URL via configureChatEngine() and (for markdown / DOM
 * rendering) keep their own view layer.
 */

export {
	configureChatEngine,
	chatEngineConfig,
	type ChatEngineConfig,
	// The live-stream observation hook's payload. Exported so a consumer can type
	// its handler against the engine rather than restate the shape.
	type LiveStreamUpdate,
	// "Can a streamed turn whose answer never reached its row be read back?" - which
	// asks for the chunk READER and deliberately not for liveStreaming, because a
	// row that already streamed stays recoverable long after streaming is switched
	// off. Exported because a client with its OWN history mapper (agent.vue's fork)
	// has to gate the `_streamPending` mark on exactly this predicate: gate it on
	// liveStreaming and every already-streamed row is stranded the day the flag goes
	// back off; gate it on nothing and a host with no reader gets a permanently
	// empty bubble where it used to get none, which is strictly worse than the bug.
	streamRecoveryEnabled,
	// Whether a given skapi INSTANCE can carry skapi's half of the stream flag. Both
	// clients gate their liveStreaming opt-in on it and degrade to buffered when it
	// says no: an SDK too old to know the key drops it silently, leaving the
	// destination streaming SSE into a buffered row that reads back empty.
	skapiSupportsStreaming,
} from './config';

export {
	isServerExtractable,
	isOfficeFile,
	makeExtractPlaceholder,
	composeUserMessage,
	type ExtractDirective,
	type ComposedUserMessage,
} from './office';

export {
	groupAttachmentFailures,
	type AttachmentFailureGroup,
} from './attachments';

// Client-side attachment-parser plugins (e.g. .hwp). Register your own parser to
// turn an uploaded File into indexable text/HTML, sent inline for indexing.
export {
	registerAttachmentParser,
	clearAttachmentParsers,
	getAttachmentParsers,
	findAttachmentParser,
	parseAttachmentContent,
	MAX_PARSED_CONTENT_CHARS,
	type AttachmentParser,
} from './attachment_parsers';

export * from './prompts';

// The opening bubble's sentence, shared so the two clients cannot fork it and
// so the assistant can be told what it opened with (see greeting.ts).
export { buildChatGreeting, type ChatGreetingParams, type ChatGreetingParts } from './greeting';

// Pure helpers (Tier-1.5): error detection, token budgeting, link/path
// normalization, and history mapping — shared so both consumers stay identical.
export {
	getErrorMessage, isErrorResponseBody, isAuthExpiredError, isNonRetryableRequestError, isProviderApiKeyError,
	// The csr-poll STATUS ENVELOPE, and the provider error nested one level inside a
	// failed one. Exported because "is this an envelope or a body" is asked in two
	// places that must agree (the streamed settle, and every error reader), and it
	// was answered twice before, one of the two one level too shallow, which is how
	// a wrong API key on a streamed turn reported "No text response received".
	isCsrStatusEnvelope, csrEnvelopeError,
} from './errors';
export * from './budget';
// Per-format UTF-8 declaration for files offered as a download. Shared so a fenced
// block and a server-published file open identically in Excel, Word and a browser.
export * from './download_encoding';
export * from './links';
export * from './link_markup';
export * from './image_preview';
export * from './time';
export * from './ai_agent';
// The SSE parser. skapi relays the provider's bytes without reading them, so this is
// where BunnyQuery's knowledge of the Anthropic and OpenAI wire formats lives. It has
// to be on the barrel or the built engine bundle does not contain it and
// www.skapi.com's `bunnyquery/engine` import resolves to undefined at runtime.
export * from './sse';
export {
	filterListByClearHorizon,
	normalizeTextContent,
	extractLastUserTextFromRequest,
	mapHistoryListToMessages,
	// The indexing-prompt reader. Exported because the prompt is the only record
	// of what a pass is about, so anything that meets a pass without a bubble
	// (a history rebuild, an adopted worker pass, agent.vue's own mapper) has to
	// read it the same way or the two will not group together.
	isIndexingRequestText,
	parseIndexingRequestText,
	// One rule for which locally-pushed bubbles survive a first-page refetch.
	// Shared because the failure mode when the two clients drift is a turn
	// rendered twice and then persisted into the history cache.
	shouldRescueInFlightMessage,
	type RescueDecisionContext,
	// What the merge does when the server's copy of a turn is authoritative but
	// EMPTY (a streamed row nobody finalized): the local answer wins, because an
	// unknown answer is not an empty one. Shared for the same reason the rescue
	// rule is: a client mapper that forks it erases answers off the screen.
	adoptLocalAnswerIntoPage,
	// One bounded look at the bg-indexing queue: which files still have a live
	// pass. The dbfile browser's "indexed" badge uses this so a file only goes
	// green once the run is confirmed over, not when its src:: record appears.
	fetchLiveIndexingKeys,
	getSplitChatHistory,
	__resetSplitHistoryState,
	type IndexingRequestRef,
	type MapHistoryOptions,
	// THE two key builders. Exported so a consumer (and a test) can assert the
	// shape rather than rebuild it: a hand-built twin drifting out of step with
	// getHistoryCacheKey is what stopped the chat rendering sent messages.
	chatCacheKey,
	indexScopeKey,
} from './history';

// Older history is reachable only by scrolling to the top of the message box, so
// a box too short to scroll strands the user on page 1 — the normal state once a
// page of history collapses into one indexing row. Shared so both chatboxes page
// their way out of it identically.
// Holding the reader's place while the list mutates underneath them. Shared so
// an older page, an indexing row, a re-parsed chip and a decoded image preview
// are all absorbed the same way in both chatboxes.
export {
	createScrollAnchor,
	type ScrollAnchor,
	type ScrollAnchorOptions,
	type RowAnchor,
	type AnchorBoxEl,
	type AnchorRowEl,
} from './scroll_anchor';

export {
	fillHistoryViewport,
	createHistoryFiller,
	HISTORY_FILL_SLACK_PX,
	MAX_HISTORY_FILL_PAGES,
	type FillHistoryViewportOptions,
} from './viewport_fill';

// Tier-2: the stateful chat orchestration (queue/poll/cancel, typewriter,
// bg-task drain, resolution). DOM-free; the consumer implements ChatHost.
//
// liveSafePrefix / typewriterResumeIndex are the two pure halves of live
// rendering: what is safe to show while the answer is still arriving, and where
// the typewriter picks up once the authoritative answer replaces it. Exported so
// they can be tested (and read) without a DOM.
//
// mayKeepStreamedAnswer is the ONE keep policy for a streamed turn: may this parse
// be stored as the row's permanent answer, given the row's own status. It is on the
// barrel because finalize is also the only way to release chunks, so every path
// that can reach it has to answer this identically - the live settle and the
// read-back once answered it separately and disagreed, and the disagreement
// released the chunks of a failed turn.
//
// streamRecoveryPhase / streamRecoveryLabels are the RENDER half of the same
// policy: given a bubble whose answer is still in the chunk store, is anything
// actually fetching it, and if not, what does the reader get offered instead of a
// spinner that will never resolve. Both clients read the phase from here rather
// than from `_streamRecovery` directly - the alternative is each of them deciding
// on its own when a loader is honest, which is precisely the fork this barrel
// exists to prevent.
export {
	ChatSession, liveSafePrefix, typewriterResumeIndex, mayKeepStreamedAnswer,
	streamRecoveryPhase, streamRecoveryLabels,
	type StreamDispatchContext,
} from './session';
export type { ChatHost, ChatIdentity, ChatState, ChatMessage, IndexingFileRef, PinnedDispatchContext } from './host';

// Display transform: collapse a file's many background-indexing turns into one
// row, wherever they sit in the conversation. Shared so both chatboxes match.
export {
	buildChatDisplayList,
	parseIndexingLabel,
	type DisplayEntry,
	type IndexingGroup,
	type IndexingGroupStatus,
	type BuildDisplayListOptions,
	type RunStubInfo,
	RUN_RECORD_WORKING_STALE_MS,
} from './indexing_groups';

export {
	// constants
	POLL_INTERVAL,
	STREAM_POLL_INTERVAL,
	MAX_CONCURRENT_BG_POLLS,
	getVisionProfile,
	type VisionProfile,
	BG_INDEXING_QUEUE_SUFFIX,
	bgIndexingQueueName,
	isBgIndexingQueue,
	indexDoneUniqueId,
	runIndexUniqueId,
	upsertIndexRunRecordSafe,
	type IndexRunStatus,
	type IndexRunPatch,
	MCP_NAME,
	DEFAULT_CLAUDE_MODEL,
	DEFAULT_OPENAI_MODEL,
	// The ONE producer of the two `stream` flags a streamed chat turn needs. Exported
	// so a test can assert the pair moves together, which is the whole point of it
	// being a single function.
	chatStreamWiring,
	type ChatStreamWiring,
	// request builders + dispatch
	callClaudeWithMcp,
	callClaudeWithPublicMcp,
	callOpenAIWithPublicMcp,
	notifyAgentSaveAttachment,
	listClaudeModels,
	listOpenAIModels,
	getChatHistory,
	buildHistoryItemFullId,
	// response extraction
	extractClaudeText,
	extractOpenAIText,
	// content transforms
	transformContentWithImages,
	transformContentWithOpenAIImages,
	// The token an indexing pass ends on when it has read the whole file. Exported
	// because agent.vue's FORKED history mapper has to record-then-strip it exactly
	// as the engine's own mapper does, or a run reads differently in the two clients.
	INDEXING_COMPLETE_MARKER,
	// Stand-in text for a pass whose whole answer was that token; both mappers need
	// it so a run reads the same live and after a reload.
	EMPTY_INDEXING_REPLY,
	// types
	type ClaudeRole,
	type ClaudeMessage,
	type OpenAIMessage,
	type ClaudeMcpToolConfig,
	type ClaudeMcpServerRequest,
	type CallClaudeWithMcpParams,
	type AttachmentSaveInfo,
	type BgTaskEntry,
} from './requests';

// The project's BunnyQuery settings, stored as a public record in the customer's
// own project ("bq::settings" in "__SETTINGS__") rather than on the skapi service
// record. Both clients prime it when a chat page opens and await it before the
// first upload writes an access group onto a record. See project_settings.ts.
export {
	// where the record lives
	PROJECT_SETTINGS_TABLE,
	PROJECT_SETTINGS_UNIQUE_ID,
	PROJECT_SETTINGS_ACCESS_GROUP,
	// the choice, its labels and its default
	UPLOAD_ACCESS_GROUPS,
	UPLOAD_ACCESS_LABELS,
	UPLOAD_ACCESS_HINTS,
	UPLOAD_ACCESS_OPTIONS,
	DEFAULT_UPLOAD_ACCESS_GROUP,
	// pure readers over a settings `data` object
	normalizeUploadAccessGroup,
	normalizeProjectAccessSetting,
	accessSettingFrom,
	uploadAccessGroupFrom,
	asksUploadAccessFrom,
	// the per-project store
	configureProjectSettings,
	loadProjectSettings,
	primeProjectSettings,
	readyProjectSettings,
	cachedProjectSettings,
	projectSettingsSettled,
	projectAccessSetting,
	projectUploadAccessGroup,
	projectAsksUploadAccess,
	setProjectSettings,
	patchProjectSettings,
	clearProjectSettings,
	// types
	type UploadAccessGroup,
	type ProjectAccessSetting,
	type ProjectSettingsData,
	type ProjectSettingsReader,
} from './project_settings';
