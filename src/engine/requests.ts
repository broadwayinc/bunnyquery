/**
 * AI request builders + dispatch transport (framework-agnostic).
 *
 * Ported from www.skapi.com/src/code/ai_agent.ts. The only changes vs the
 * original are dependency-injection seams:
 *   - `skapi.clientSecretRequest*`  -> chatEngineConfig().clientSecretRequest*
 *   - MCP endpoint URL              -> chatEngineConfig().mcpBaseUrl
 *   - `poll` on each request        -> pollOpt() (set per consumer; see config.ts)
 *   - Vue `reactive`/`ref` removed  (bgTaskQueue/agentViewMounted are app-level
 *                                    state that stays in the consumer, not here;
 *                                    only the BgTaskEntry TYPE lives here)
 */
import { buildIndexingSystemPrompt, buildIndexingUserMessage, buildIndexingContinueMessage, buildIndexingRenderMessage, buildIndexingRenderContinueTemplate, buildIndexingWindowMessage } from './prompts';
import { isServerExtractable, isPagedReadFile, isImageVisionFile, isWindowedReadFile, makeExtractPlaceholder, makeRenderPlaceholder, makeWindowPlaceholder, RENDER_PAGES_PER_WINDOW, type ExtractDirective, type FileUrlDirective } from './office';
import { chatEngineConfig, pollOpt, windowedIndexingEnabled } from './config';

export const ANTHROPIC_MESSAGES_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODELS_API_URL = 'https://api.anthropic.com/v1/models';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MCP_BETA = 'mcp-client-2025-11-20';
const ANTHROPIC_WEB_FETCH_BETA = 'web-fetch-2025-09-10';
const ANTHROPIC_PROMPT_CACHING_BETA = 'prompt-caching-2024-07-31';
const ANTHROPIC_BETA_HEADER = `${ANTHROPIC_MCP_BETA},${ANTHROPIC_WEB_FETCH_BETA},${ANTHROPIC_PROMPT_CACHING_BETA}`;
const WEB_FETCH_MAX_USES = 40;
const WEB_FETCH_MAX_CONTENT_TOKENS = 200000;

export const OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODELS_API_URL = 'https://api.openai.com/v1/models';
const MAX_TOKENS = 25000;
const DEFAULT_OPENAI_IMAGE_DETAIL = 'auto';
const OPENAI_WEB_SEARCH_ENABLED = true;
const OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS = true;
export const MCP_NAME = 'BunnyQuery';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';

const mcpUrl = () => chatEngineConfig().mcpBaseUrl;
const clientSecretRequest = (opts: any) => chatEngineConfig().clientSecretRequest(opts);

// Resolve the per-image `detail` for OpenAI. The version match tolerates a
// trailing variant/date suffix (`gpt-5.4-nano`, `-mini`, `-2026-01-01`, …):
// previously the pattern was anchored with no suffix allowed, so EVERY suffixed
// model silently fell through to 'auto' — i.e. the cheap tiers that most need
// resolution were the ones getting downsampled images.
//
// Variants used to resolve to 'high' rather than 'original' on the reasoning that
// 'high' is universally supported and an unsupported value would fail the whole
// request. The cost of that caution turned out to be real: 'high' downsamples to
// a 512px grid, so the small tiers that most need resolution were reading dense
// scans at the lower of the two settings, and gpt-5.4-nano reports it cannot make
// out the text where gpt-5.4 (on 'original') can. Variants now get 'original' too.
//
// If a variant rejects 'original' the failure is loud and immediate (a terminal
// 400 on the whole request, no retry), so flip VARIANT_IMAGE_DETAIL back to
// 'high' and it is undone. That is the one word to change.
const VARIANT_IMAGE_DETAIL = 'original';

// Extra Responses-API knobs for NANO models on INDEXING passes only.
//
// `detail` (above) governs what the model SEES; these govern how it thinks and how completely it
// writes. Nano strips vision detail to hit its latency target and compresses layout when
// transcribing, which is the documented reason to raise verbosity FOR IT SPECIFICALLY. mini and the
// base/named models do not need it, so they are excluded rather than paying its output cost.
//
// Deliberately NOT applied to chat: high verbosity makes ordinary replies longer and worse, and the
// chat path has no transcription job to justify it.
//
// Two things to keep in mind, both of which is why these are separate switches:
//   1. An UNKNOWN body field is fatal here, not ignored. The engine already documents it for
//      `_skapi_window`: it "reaches the provider as an unknown body field and the call fails
//      terminally with no retry". If a field name is wrong, EVERY indexing pass dies. Set either
//      constant to null to remove the field entirely.
//   2. Reasoning tokens are billed against max_output_tokens on this API. An indexing pass spends
//      its output budget emitting postRecords calls, so buying reasoning takes budget away from the
//      records themselves and can truncate them.
//
// Effort was OFF, and the measurement that turned it on: across one nano run's photo records, only
// 5 of 28 image text fields carried a concrete identifier read off the tag (a part number, a tag id).
// The other 23 held a generic scene description. Reading small handwriting off a photographed label
// is exactly the kind of work a moment of deliberation buys, so it is now on at the LOWEST setting:
// enough to help the transcription, small enough that it does not eat the record budget that point 2
// warns about. Raise it to 'medium' only alongside MAX_TOKENS, and re-measure that 5-of-28 ratio
// rather than assuming; set it back to null to remove the field entirely.
const VARIANT_TEXT_VERBOSITY: string | null = 'high';
const VARIANT_REASONING_EFFORT: string | null = 'low';

/**
 * True only for a NANO model, including a dated nano snapshot. NOT mini, not a base model, and not
 * a named variant like gpt-5.6-luna: those transcribe faithfully on their own and do not need the
 * knob, so paying its output cost on them would be waste.
 */
const isOpenAINano = (model?: string) => {
	const normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
	if (!/(^|-)nano(-|$)/.test(normalized)) return false;

	// Family floor, same shape as getOpenAIImageDetail's. "Contains nano" alone also matches
	// gpt-4.1-nano and anything else a project might name, and these are body fields an older
	// model REJECTS rather than ignores: one 400 with no retry kills every indexing pass. Only
	// gpt-5.4 and newer are known to take `text.verbosity` and `reasoning.effort`.
	const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = match[2] === undefined ? null : Number(match[2]);
	return major > 5 || (major === 5 && minor !== null && minor >= 4);
};

/** The nano-only indexing knobs, as body fields. Empty for every other model, or when switched off. */
const variantIndexingOptions = (model?: string) => {
	if (!isOpenAINano(model)) return {};
	return {
		...(VARIANT_TEXT_VERBOSITY ? { text: { verbosity: VARIANT_TEXT_VERBOSITY } } : {}),
		...(VARIANT_REASONING_EFFORT ? { reasoning: { effort: VARIANT_REASONING_EFFORT } } : {}),
	};
};
const getOpenAIImageDetail = (model?: string) => {
	const normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
	const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/);
	if (!match) {
		return DEFAULT_OPENAI_IMAGE_DETAIL;
	}

	const major = Number(match[1]);
	const minor = match[2] === undefined ? null : Number(match[2]);
	const isVariant = !!match[3];

	const supportsOriginal = major > 5 || (major === 5 && minor !== null && minor >= 4);
	if (!supportsOriginal) {
		return DEFAULT_OPENAI_IMAGE_DETAIL;
	}

	return isVariant ? VARIANT_IMAGE_DETAIL : 'original';
};

// Per-image `detail` for WORKER-RENDERED document pages (the `_skapi_render`
// path). Same resolution as above with one difference: these are dense scans
// whose entire purpose is to be read, so 'auto' is never acceptable — it lets
// the API downsample exactly the pixels the model needs to OCR. Floor it at
// 'high'; models that support full-resolution 'original' still get it.
//
// Without this the worker falls back to its own model-blind default ('high'),
// which silently denies the strongest models the 'original' detail they support.
const getRenderImageDetail = (model?: string) => {
	const detail = getOpenAIImageDetail(model);
	return detail === DEFAULT_OPENAI_IMAGE_DETAIL ? 'high' : detail;
};

export type ClaudeRole = 'user' | 'assistant';

export type ClaudeMessage = {
	role: ClaudeRole;
	content: string;
};

export type OpenAIMessage = {
	role: ClaudeRole;
	content: string;
};

export type ClaudeMcpToolConfig = {
	enabled?: boolean;
	defer_loading?: boolean;
};

export type ClaudeMcpServerRequest = {
	name: string;
	url: string;
	authorizationToken?: string;
	defaultConfig?: ClaudeMcpToolConfig;
	configs?: Record<string, ClaudeMcpToolConfig>;
};

const IMAGE_URL_REGEX =
	/\bhttps?:\/\/[^\s<>"'()\[\]]+?\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s<>"'()\[\]]*)?/gi;

export function transformContentWithImages(
	content: string,
): string | Array<Record<string, any>> {
	if (typeof content !== 'string' || !content) {
		return content;
	}

	const matches = content.match(IMAGE_URL_REGEX);

	if (!matches || !matches.length) {
		return content;
	}

	const seen = new Set<string>();
	const imageBlocks: Array<Record<string, any>> = [];

	for (const url of matches) {
		if (seen.has(url)) continue;
		seen.add(url);
		imageBlocks.push({
			type: 'image',
			source: { type: 'url', url },
		});
	}

	return [...imageBlocks, { type: 'text', text: content }];
}

function prepareClaudeMessages(messages: ClaudeMessage[]) {
	if (!messages.length) return messages;
	// Only transform the most recent user message. Historical user messages
	// may reference image URLs that are now stale (deleted, moved, expired).
	const lastIndex = messages.length - 1;
	const last = messages[lastIndex];
	if (last.role !== 'user') return messages;
	const content = transformContentWithImages(last.content);
	if (content === last.content) return messages;
	const next = messages.slice();
	next[lastIndex] = { role: last.role, content } as unknown as ClaudeMessage;
	return next;
}

export function transformContentWithOpenAIImages(
	content: string,
	detail = DEFAULT_OPENAI_IMAGE_DETAIL,
): string | Array<Record<string, any>> {
	if (typeof content !== 'string' || !content) {
		return content;
	}

	const matches = content.match(IMAGE_URL_REGEX);

	if (!matches || !matches.length) {
		return content;
	}

	const seen = new Set<string>();
	const imageBlocks: Array<Record<string, any>> = [];

	for (const url of matches) {
		if (seen.has(url)) continue;
		seen.add(url);
		imageBlocks.push({
			type: 'input_image',
			image_url: url,
			detail,
		});
	}

	return [{ type: 'input_text', text: content }, ...imageBlocks];
}

function prepareOpenAIMessages(
	messages: OpenAIMessage[],
	detail = DEFAULT_OPENAI_IMAGE_DETAIL,
) {
	if (!messages.length) return messages;
	const lastIndex = messages.length - 1;
	const last = messages[lastIndex];
	if (last.role !== 'user') return messages;
	const content = transformContentWithOpenAIImages(last.content, detail);
	if (content === last.content) return messages;
	const next = messages.slice();
	next[lastIndex] = { role: last.role, content } as unknown as OpenAIMessage;
	return next;
}

// Attach a cache_control breakpoint to the last message of the stable history
// prefix (everything except the final user turn) so Anthropic re-uses it at
// ~10% input-token billing.
function applyHistoryCacheBreakpoint(messages: any[]): any[] {
	if (messages.length < 2) return messages;
	const breakpointIndex = messages.length - 2;
	return messages.map((m, i) => {
		if (i !== breakpointIndex) return m;
		const blocks = Array.isArray(m.content)
			? m.content.slice()
			: [{ type: 'text', text: m.content }];
		if (!blocks.length) return m;
		const lastBlockIndex = blocks.length - 1;
		blocks[lastBlockIndex] = {
			...blocks[lastBlockIndex],
			cache_control: { type: 'ephemeral' },
		};
		return { ...m, content: blocks };
	});
}

export type CallClaudeWithMcpParams = {
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
// Poll cadence for every client-secret request the chat waits on. Shared by the
// engine's own poll sites and imported by agent.vue; the widget carries its own
// copy in src/index.js that must be kept in step.
export const POLL_INTERVAL = 3000;
// Ceiling on how many BACKGROUND indexing polls may be attached at once, across
// every poll site (the engine's drain, the engine's history load, and each
// client's own fallback poller).
//
// Every unresolved bg item used to get its own poll, and a poll is a
// POLL_INTERVAL setInterval firing one request per tick. A bulk upload from the
// db-files page enqueues one indexing pass per FILE, so uploading 10,000 files
// attached 10,000 concurrent intervals: ~3,300 requests/second against a browser
// that opens six connections per host. The resulting request backlog starved the
// uploads themselves, which is the "frozen tab that eventually finishes" users
// reported.
//
// Capping costs nothing, because the server settles one queue's passes in FIFO
// order (a single SQS MessageGroupId per `<user>-bg` queue). A pass cannot
// finish before the ones ahead of it, so asking about the newest 9,994 is pure
// waste. Each resolution frees a slot, which the next-OLDEST unpolled entry
// takes on the drain that follows. Spending the budget oldest-first is
// load-bearing: spend it on the newest and the batch wedges, since those cannot
// settle until the ones ahead of them do and nothing ahead would hold a poll.
//
// FOREGROUND polls (a reply the user is actively waiting on) are never capped.
export const MAX_CONCURRENT_BG_POLLS = 6;
export async function callClaudeWithMcp({
	prompt,
	messages,
	service,
	owner,
	userId,
	model = DEFAULT_CLAUDE_MODEL,
	maxTokens = 1000,
	system,
	mcpServer,
	extractContent,
	fileUrls,
}: CallClaudeWithMcpParams) {
	const mcpServerDefinition: Record<string, any> = {
		type: 'url',
		name: mcpServer.name,
		url: mcpServer.url,
	};

	if (mcpServer.authorizationToken) {
		mcpServerDefinition.authorization_token = mcpServer.authorizationToken;
	}

	return clientSecretRequest({
		clientSecretName: 'claude',
		queue: userId || service,
		service,
		owner,
		...pollOpt(),
		url: ANTHROPIC_MESSAGES_API_URL,
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': '$CLIENT_SECRET',
			'anthropic-version': ANTHROPIC_VERSION,
			'anthropic-beta': ANTHROPIC_BETA_HEADER,
		},
		data: {
			model,
			max_tokens: maxTokens,
			...(extractContent && extractContent.length
				? { _skapi_extract: extractContent }
				: {}),
			...(fileUrls && fileUrls.length
				? { _skapi_file_urls: fileUrls }
				: {}),
			...(system
				? {
						system: [
							{
								type: 'text',
								text: system,
								cache_control: { type: 'ephemeral' },
							},
						],
					}
				: {}),
			messages: (() => {
				const prepared =
					messages && messages.length
						? prepareClaudeMessages(messages)
						: [
								{
									role: 'user',
									content: transformContentWithImages(prompt),
								},
							];
				return applyHistoryCacheBreakpoint(prepared as any[]);
			})(),
			mcp_servers: [mcpServerDefinition],
			tools: [
				{
					type: 'mcp_toolset',
					mcp_server_name: mcpServer.name,
					...(mcpServer.defaultConfig
						? { default_config: mcpServer.defaultConfig }
						: {}),
					...(mcpServer.configs ? { configs: mcpServer.configs } : {}),
				},
				{
					type: 'web_fetch_20250910',
					name: 'web_fetch',
					max_uses: WEB_FETCH_MAX_USES,
					citations: { enabled: true },
					max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS,
				},
			],
		},
	});
}

export async function callClaudeWithPublicMcp(
	prompt: string,
	service: string,
	owner: string,
	messages?: ClaudeMessage[],
	system?: string,
	model?: string,
	userId?: string,
	extractContent?: ExtractDirective[],
	fileUrls?: FileUrlDirective[],
	onResponse?: (res: any) => void,
	onError?: (err: any) => void,
) {
	return callClaudeWithMcp({
		prompt,
		messages,
		service,
		owner,
		userId,
		model: model || DEFAULT_CLAUDE_MODEL,
		maxTokens: MAX_TOKENS,
		system,
		extractContent,
		fileUrls,
		mcpServer: {
			name: MCP_NAME,
			url: mcpUrl(),
			authorizationToken: '$ACCESS_TOKEN',
		},
		onResponse,
		onError,
	});
}

export async function callOpenAIWithPublicMcp(
	prompt: string,
	service: string,
	owner: string,
	messages?: OpenAIMessage[],
	system?: string,
	model?: string,
	userId?: string,
	extractContent?: ExtractDirective[],
	fileUrls?: FileUrlDirective[],
	onResponse?: (res: any) => void,
	onError?: (err: any) => void,
) {
	const resolvedModel = model || DEFAULT_OPENAI_MODEL;
	const imageDetail = getOpenAIImageDetail(resolvedModel);
	const messageList =
		messages && messages.length
			? prepareOpenAIMessages(messages, imageDetail)
			: [
				{
					role: 'user' as const,
					content: transformContentWithOpenAIImages(prompt, imageDetail),
				},
			];

	const responseInput = [
		...(system
			? [
				{
					role: 'system',
					content: system,
				},
			]
			: []),
		...messageList.map((m) => ({
			role: m.role,
			content: m.content,
		})),
	];

	return clientSecretRequest({
		clientSecretName: 'openai',
		queue: userId || service,
		service,
		owner,
		...pollOpt(),
		url: OPENAI_RESPONSES_API_URL,
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			Authorization: 'Bearer $CLIENT_SECRET',
		},
		data: {
			model: resolvedModel,
			max_output_tokens: MAX_TOKENS,
			...(extractContent && extractContent.length
				? { _skapi_extract: extractContent }
				: {}),
			...(fileUrls && fileUrls.length
				? { _skapi_file_urls: fileUrls }
				: {}),
			input: responseInput,
			tools: [
				{
					type: 'mcp',
					server_label: MCP_NAME,
					server_url: mcpUrl(),
					require_approval: 'never',
					headers: {
						Authorization: 'Bearer $ACCESS_TOKEN',
					},
				},
				...(OPENAI_WEB_SEARCH_ENABLED
					? [
						{
							type: 'web_search',
							external_web_access: OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS,
						},
					]
					: []),
			],
		},
	});
}

export type AttachmentSaveInfo = {
	platform: 'claude' | 'openai';
	model?: string;
	service: string;
	owner: string;
	/**
	 * Queue base for this indexing pass: "<userId>-bg". REQUIRED, and it must be
	 * the SAME value the chat turn uses (ChatSession.dispatchComposedMessage's
	 * `id.userId || id.serviceId`) — the backend serialises requests that share a
	 * queue name and runs different ones IN PARALLEL, so a pass enqueued under a
	 * different base does not hold the chat back at all. It was optional once,
	 * defaulting to `service`; the chatbox omitted it, and its files were indexed
	 * on "<serviceId>-bg" while its question ran on "<userId>-bg" — the question
	 * was answered from a file nothing had read yet. Pass `userId || serviceId`.
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

// RESUME pass: continue indexing a large file a previous pass could not finish. Same
// dispatch as notifyAgentSaveAttachment, but forced onto the paging path with a
// "continue from where the saved records leave off" message.
export async function notifyAgentContinueIndexing(info: AttachmentSaveInfo) {
	return notifyAgentSaveAttachment({ ...info, continueIndexing: true });
}

// Background "save into knowledge" call (not a chat turn). A client-parsed file
// (parser plugin) is inlined directly; otherwise office files get the
// _skapi_extract directive + a placeholder, and everything else gets a URL.
export async function notifyAgentSaveAttachment(info: AttachmentSaveInfo) {
	const { platform, service, owner, attachment, parsedContent } = info;

	// A CONTINUE pass resumes a large file that a previous pass could not finish.
	const continuing = !!info.continueIndexing;

	// VISION files (PDFs) are delivered as rendered page IMAGES injected into the message by
	// the worker (`_skapi_render`), because tool-result images render on neither provider.
	// Both the first pass and every resume pass use this; renderFrom advances the page window.
	const visionFile = !parsedContent && isImageVisionFile(attachment.name, attachment.mime);
	const renderFrom = Math.max(0, info.renderFrom || 0);
	const renderPlaceholder = visionFile ? makeRenderPlaceholder(attachment.storagePath) : undefined;
	// Tell the worker what image `detail` to stamp on the injected page blocks.
	// The worker is model-blind, so without this it applies a one-size default and
	// the strongest models never get the 'original' detail they support. Only
	// meaningful for OpenAI — Claude has no per-image detail knob and the worker
	// ignores the field for it.
	const renderDetail = platform === 'openai'
		? getRenderImageDetail(info.model || DEFAULT_OPENAI_MODEL)
		: undefined;
	// `auto_continue` + `continue_text` hand the page loop to the WORKER: when its renderer
	// reports pages left after this window, it builds the next pass from this template
	// (substituting the window's 1-based start page for RENDER_FROM_TOKEN) and enqueues it
	// itself. That is what makes a 500-page document index end-to-end — the loop no longer
	// depends on the tab staying open, nor on the model correctly declaring itself unfinished.
	const skapiRender = visionFile && renderPlaceholder
		? {
			_skapi_render: [
				{
					path: attachment.storagePath, from: renderFrom, count: RENDER_PAGES_PER_WINDOW,
					placeholder: renderPlaceholder, name: attachment.name, mime: attachment.mime, detail: renderDetail,
					auto_continue: true,
					continue_text: buildIndexingRenderContinueTemplate(attachment, renderPlaceholder),
				},
			],
		}
		: {};

	// SERVER-DRIVEN windowed read. When enabled, the worker reads one window of the file
	// per request and continues from the reader's own cursor until the file is exhausted,
	// so the traversal no longer lives inside the model's turn budget.
	//
	// Flag-gated because the BACKEND MUST SHIP FIRST: against a worker that does not strip
	// `_skapi_window`, the directive reaches the provider as an unknown body field and the
	// call fails terminally with no retry.
	const windowedRead =
		!visionFile && !parsedContent && windowedIndexingEnabled() &&
		isWindowedReadFile(attachment.name, attachment.mime);
	const windowPlaceholder = windowedRead ? makeWindowPlaceholder(attachment.storagePath) : undefined;
	const skapiWindow = windowedRead && windowPlaceholder
		? {
			_skapi_window: [
				{
					path: attachment.storagePath,
					cursor: null,
					placeholder: windowPlaceholder,
					name: attachment.name,
					mime: attachment.mime,
					kind: 'window',
					// Same per-image `detail` the render path sends. Without it the worker falls
					// back to its model-blind default of 'high', so a spreadsheet's embedded
					// photos were tiled at lower resolution than the SAME model gets for a PDF
					// page or a chat attachment. That is why a model could describe an attached
					// photo but reported the pictures inside a sheet as only partly legible.
					detail: renderDetail,
					auto_continue: true,
					continue_text: buildIndexingWindowMessage(attachment, windowPlaceholder, true),
				},
			],
		}
		: {};

	// Spreadsheets are read by PAGING through readFileContent (grid rows), NOT inlined - so
	// they skip the inline server-extract and the agent is told to page the whole file.
	const pagedRead = !visionFile && !windowedRead && (continuing || (!parsedContent && isPagedReadFile(attachment.name, attachment.mime)));

	// Client-parsed content wins over server-side extraction.
	const serverExtract = !visionFile && !windowedRead && !continuing && !parsedContent && !pagedRead && isServerExtractable(attachment.name, attachment.mime);
	const placeholder = serverExtract ? makeExtractPlaceholder(attachment.storagePath) : undefined;
	const extractContent: ExtractDirective[] | undefined =
		serverExtract && placeholder
			? [{ path: attachment.storagePath, placeholder, name: attachment.name, mime: attachment.mime }]
			: undefined;
	const skapiExtract =
		extractContent && extractContent.length ? { _skapi_extract: extractContent } : {};

	const userMessage = (visionFile && renderPlaceholder)
		? buildIndexingRenderMessage(attachment, renderPlaceholder, renderFrom)
		: (windowedRead && windowPlaceholder)
		? buildIndexingWindowMessage(attachment, windowPlaceholder, false)
		: continuing
			? buildIndexingContinueMessage(attachment)
			: buildIndexingUserMessage(
				attachment,
				parsedContent
					? { inlineContent: parsedContent }
					: placeholder
						? { inlineContentPlaceholder: placeholder }
						: pagedRead
							? { pagedRead: true }
							: undefined,
			);

	const systemPrompt = buildIndexingSystemPrompt({
		service,
		serviceName: info.serviceName,
		serviceDescription: info.serviceDescription,
	});

	if (platform === 'openai') {
		const resolvedModel = info.model || DEFAULT_OPENAI_MODEL;
		const imageDetail = getOpenAIImageDetail(resolvedModel);
		return clientSecretRequest({
			clientSecretName: 'openai',
			queue: bgIndexingQueueName(info.userId, service),
			service,
			owner,
			...pollOpt(),
			url: OPENAI_RESPONSES_API_URL,
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Authorization: 'Bearer $CLIENT_SECRET',
			},
			data: {
				model: resolvedModel,
				max_output_tokens: MAX_TOKENS,
				// Nano-only transcription knobs. Indexing only; see variantIndexingOptions.
				...variantIndexingOptions(resolvedModel),
				...skapiExtract,
				...skapiRender,
				...skapiWindow,
				input: [
					{ role: 'system', content: systemPrompt },
					{
						role: 'user',
						content: transformContentWithOpenAIImages(userMessage, imageDetail),
					},
				],
				tools: [
					{
						type: 'mcp',
						server_label: MCP_NAME,
						server_url: mcpUrl(),
						require_approval: 'never',
						headers: { Authorization: 'Bearer $ACCESS_TOKEN' },
					},
					...(OPENAI_WEB_SEARCH_ENABLED
						? [
								{
									type: 'web_search',
									external_web_access: OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS,
								},
							]
						: []),
				],
			},
		});
	}

	const resolvedModel = info.model || DEFAULT_CLAUDE_MODEL;
	return clientSecretRequest({
		clientSecretName: 'claude',
		queue: bgIndexingQueueName(info.userId, service),
		service,
		owner,
		...pollOpt(),
		url: ANTHROPIC_MESSAGES_API_URL,
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': '$CLIENT_SECRET',
			'anthropic-version': ANTHROPIC_VERSION,
			'anthropic-beta': ANTHROPIC_BETA_HEADER,
		},
		data: {
			model: resolvedModel,
			max_tokens: MAX_TOKENS,
			...skapiExtract,
			...skapiRender,
			...skapiWindow,
			system: [
				{
					type: 'text',
					text: systemPrompt,
					cache_control: { type: 'ephemeral' },
				},
			],
			messages: [
				{
					role: 'user',
					content: transformContentWithImages(userMessage),
				},
			],
			mcp_servers: [
				{
					type: 'url',
					name: MCP_NAME,
					url: mcpUrl(),
					authorization_token: '$ACCESS_TOKEN',
				},
			],
			tools: [
				{
					type: 'mcp_toolset',
					mcp_server_name: MCP_NAME,
				},
				{
					type: 'web_fetch_20250910',
					name: 'web_fetch',
					max_uses: WEB_FETCH_MAX_USES,
					citations: { enabled: true },
					max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS,
				},
			],
		},
	});
}

export function extractClaudeText(response: any) {
	if (!Array.isArray(response?.content)) {
		return '';
	}

	return response.content
		.filter((block: any) => block?.type === 'text')
		.map((block: any) => block.text)
		.join('\n');
}

export function extractOpenAIText(response: any) {
	if (
		typeof response?.output_text === 'string' &&
		response.output_text.length
	) {
		return response.output_text;
	}

	if (Array.isArray(response?.output)) {
		const text = response.output
			.flatMap((item: any) => item?.content || [])
			.filter((part: any) => part?.type === 'output_text')
			.map((part: any) => part.text || '')
			.join('\n')
			.trim();

		if (text) {
			return text;
		}
	}

	const content = response?.choices?.[0]?.message?.content;

	if (typeof content === 'string') {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.map((part: any) => {
				if (typeof part === 'string') {
					return part;
				}
				if (part?.type === 'text') {
					return part.text || '';
				}
				return '';
			})
			.join('\n');
	}

	return '';
}

export async function listClaudeModels(service: string, owner: string) {
	return clientSecretRequest({
		clientSecretName: 'claude',
		service,
		owner,
		url: ANTHROPIC_MODELS_API_URL,
		method: 'GET',
		headers: {
			'x-api-key': '$CLIENT_SECRET',
			'anthropic-version': ANTHROPIC_VERSION,
		},
	});
}

export async function listOpenAIModels(service: string, owner: string) {
	return clientSecretRequest({
		clientSecretName: 'openai',
		service,
		owner,
		url: OPENAI_MODELS_API_URL,
		method: 'GET',
		headers: {
			Authorization: 'Bearer $CLIENT_SECRET',
		},
	});
}

// Suffix for the background-indexing queue. Must sort *before* ':' (ASCII 58)
// so the chat-history BETWEEN query never includes bg-queue items. '-' (45) works.
export const BG_INDEXING_QUEUE_SUFFIX = '-bg';

/**
 * The one place the background-indexing queue name is spelled out. The backend
 * serialises requests sharing a queue name and runs different names in PARALLEL,
 * so every indexing pass AND the chat turn that must wait behind them have to
 * resolve to the identical string — see AttachmentSaveInfo.userId for what
 * happens when they do not.
 */
export function bgIndexingQueueName(userId?: string, service?: string): string {
	return (userId || service || '') + BG_INDEXING_QUEUE_SUFFIX;
}

/**
 * True when a request belongs to the background-indexing queue.
 *
 * Accepts BOTH shapes this value arrives in: the bare queue name the client sends
 * ("<userId>-bg"), and the server qid that comes back on history/poll responses
 * ("<service>:<queue>|<seq>"). Testing the tail of the raw value only works for the
 * first: a qid ends in "|<seq>", so `endsWith('-bg')` is always false for it — which
 * silently meant history items were NEVER recognised as background tasks.
 */
export function isBgIndexingQueue(queueName?: string): boolean {
	if (typeof queueName !== 'string' || !queueName) return false;
	const prefix = queueName.split('|')[0];
	const idx = prefix.lastIndexOf(':');
	const name = idx === -1 ? prefix : prefix.slice(idx + 1);
	return name.slice(-BG_INDEXING_QUEUE_SUFFIX.length) === BG_INDEXING_QUEUE_SUFFIX;
}

// Pending background-indexing task descriptor. NOTE: the live mutable queue
// (a Vue `reactive([])` in agent.vue, a plain array in bunnyquery) is app-level
// state owned by the consumer — only the TYPE lives in the engine.
export type BgTaskEntry = {
	serviceId: string;
	platform: 'claude' | 'openai';
	id: string;
	filename: string;
	storagePath?: string;
	isReindex?: boolean;
	mime?: string;
	size?: number;
	status: 'running' | 'pending';
	poll: ((opts: { latency: number }) => Promise<any>) | undefined;
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

// Token the indexing agent appends to its final message ONLY when it has fully read and
// saved the whole file. Its ABSENCE is what tells the client to run another CONTINUE pass.
//
// Applies to the TEXT/GRID paging path only. The vision path (rendered PDF pages) no longer
// asks the model whether it is finished — the worker advances that loop off the renderer's
// page count — so this marker has no say in whether a PDF keeps going.
export const INDEXING_COMPLETE_MARKER = 'INDEXING_COMPLETE';
// What an indexing pass's bubble says when its ENTIRE answer was the completion
// token and stripping it left nothing. Without a stand-in the history mappers emit
// no bubble at all for that pass (their `else if (assistantText)` guard fails on the
// empty string) while the live path emits one — so the same run read as finished
// live and unfinished after a reload, and the row's loader came back.
export const EMPTY_INDEXING_REPLY = 'Finished reading this file.';
// Cap on CONTINUE passes per file, so a file the agent can never mark complete (or a
// pathological loop) stops instead of re-dispatching forever. The text/grid paging path
// reads MANY windows within a single pass (the agent loops readFileContent in one turn), so
// a small cap suffices.
export const MAX_INDEXING_RESUME_PASSES = 6;

// Records per chat-history page. Bigger than skapi's own default so the first load
// (and each scroll-up page) covers more of the conversation in one round-trip — a
// short page leaves the box unfilled and forces the viewport-fill loop to page
// again immediately. Callers that want a narrower page (the queue/status probes in
// ChatSession) pass their own `limit`, which wins over this default.
export const CHAT_HISTORY_PAGE_LIMIT = 100;

/**
 * `queue` narrows the fetch to one processing chain; `status` narrows it to items
 * in one state. Passing both is how the client asks "is there still unresolved
 * work on the background-indexing queue?" without pulling a page of chat history
 * (see ChatSession._adoptWorkerIndexingPasses) — the server answers that from a
 * status-keyed index, so the reply carries only the live items, not the bodies of
 * everything already finished.
 */
export async function getChatHistory(
	params: { service?: string; owner?: string; platform: 'claude' | 'openai'; queue?: string; status?: 'pending' | 'running' | 'resolved' | 'failed' },
	fetchOptions: Record<string, any>,
) {
	const url =
		params.platform === 'claude'
			? ANTHROPIC_MESSAGES_API_URL
			: OPENAI_RESPONSES_API_URL;
	const p = Object.assign(
		{
			url,
			method: 'POST',
		},
		{ service: params.service, owner: params.owner },
		params.queue ? { queue: params.queue } : {},
		params.status ? { status: params.status } : {},
	);

	return chatEngineConfig().clientSecretRequestHistory(
		p as { url: string; method: 'POST'; queue?: string; status?: string },
		Object.assign({ ascending: false, limit: CHAT_HISTORY_PAGE_LIMIT }, fetchOptions),
	);
}
