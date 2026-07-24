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
export * from './links';
export {
	filterListByClearHorizon,
	normalizeTextContent,
	extractLastUserTextFromRequest,
	mapHistoryListToMessages,
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
	BG_INDEXING_QUEUE_SUFFIX,
	isBgIndexingQueue,
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
