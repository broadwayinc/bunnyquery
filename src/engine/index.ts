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

// Pure helpers (Tier-1.5): error detection, token budgeting, link/path
// normalization, and history mapping — shared so both consumers stay identical.
export { getErrorMessage, isErrorResponseBody, isAuthExpiredError, isNonRetryableRequestError } from './errors';
export * from './budget';
// Per-format UTF-8 declaration for files offered as a download. Shared so a fenced
// block and a server-published file open identically in Excel, Word and a browser.
export * from './download_encoding';
export * from './links';
export * from './link_markup';
export * from './image_preview';
export * from './time';
export * from './ai_agent';
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
	// One bounded look at the bg-indexing queue: which files still have a live
	// pass. The dbfile browser's "indexed" badge uses this so a file only goes
	// green once the run is confirmed over, not when its src:: record appears.
	fetchLiveIndexingKeys,
	type IndexingRequestRef,
	type MapHistoryOptions,
} from './history';

// Older history is reachable only by scrolling to the top of the message box, so
// a box too short to scroll strands the user on page 1 — the normal state once a
// page of history collapses into one indexing row. Shared so both chatboxes page
// their way out of it identically.
export {
	fillHistoryViewport,
	createHistoryFiller,
	HISTORY_FILL_SLACK_PX,
	MAX_HISTORY_FILL_PAGES,
	type FillHistoryViewportOptions,
} from './viewport_fill';

// Tier-2: the stateful chat orchestration (queue/poll/cancel, typewriter,
// bg-task drain, resolution). DOM-free; the consumer implements ChatHost.
export { ChatSession } from './session';
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
} from './indexing_groups';

export {
	// constants
	POLL_INTERVAL,
	MAX_CONCURRENT_BG_POLLS,
	getVisionProfile,
	type VisionProfile,
	BG_INDEXING_QUEUE_SUFFIX,
	bgIndexingQueueName,
	isBgIndexingQueue,
	indexDoneUniqueId,
	MCP_NAME,
	DEFAULT_CLAUDE_MODEL,
	DEFAULT_OPENAI_MODEL,
	// request builders + dispatch
	callClaudeWithMcp,
	callClaudeWithPublicMcp,
	callOpenAIWithPublicMcp,
	notifyAgentSaveAttachment,
	listClaudeModels,
	listOpenAIModels,
	getChatHistory,
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
