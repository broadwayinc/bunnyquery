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
import { buildIndexingSystemPrompt, buildIndexingUserMessage, buildIndexingContinueMessage, buildIndexingRenderMessage, buildIndexingRenderContinueTemplate } from './prompts';
import { isServerExtractable, isPagedReadFile, isImageVisionFile, makeExtractPlaceholder, makeRenderPlaceholder, RENDER_PAGES_PER_WINDOW, type ExtractDirective, type FileUrlDirective } from './office';
import { chatEngineConfig, pollOpt } from './config';

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
export const DEFAULT_OPENAI_MODEL = 'gpt-5.4';

const mcpUrl = () => chatEngineConfig().mcpBaseUrl;
const clientSecretRequest = (opts: any) => chatEngineConfig().clientSecretRequest(opts);

// Resolve the per-image `detail` for OpenAI. The version match tolerates a
// trailing variant/date suffix (`gpt-5.4-nano`, `-mini`, `-2026-01-01`, …):
// previously the pattern was anchored with no suffix allowed, so EVERY suffixed
// model silently fell through to 'auto' — i.e. the cheap tiers that most need
// resolution were the ones getting downsampled images.
//
// Base models keep their exact previous behavior ('original'). A suffixed
// variant resolves to 'high' rather than 'original': 'high' is the universally
// supported value, and we have no way to confirm a given variant accepts
// 'original' — sending an unsupported value would fail the whole request, which
// is far worse than a slightly less detailed image.
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

	return isVariant ? 'high' : 'original';
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
export const POLL_INTERVAL = 1500;
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

	// Spreadsheets are read by PAGING through readFileContent (grid rows), NOT inlined - so
	// they skip the inline server-extract and the agent is told to page the whole file.
	const pagedRead = !visionFile && (continuing || (!parsedContent && isPagedReadFile(attachment.name, attachment.mime)));

	// Client-parsed content wins over server-side extraction.
	const serverExtract = !visionFile && !continuing && !parsedContent && !pagedRead && isServerExtractable(attachment.name, attachment.mime);
	const placeholder = serverExtract ? makeExtractPlaceholder(attachment.storagePath) : undefined;
	const extractContent: ExtractDirective[] | undefined =
		serverExtract && placeholder
			? [{ path: attachment.storagePath, placeholder, name: attachment.name, mime: attachment.mime }]
			: undefined;
	const skapiExtract =
		extractContent && extractContent.length ? { _skapi_extract: extractContent } : {};

	const userMessage = (visionFile && renderPlaceholder)
		? buildIndexingRenderMessage(attachment, renderPlaceholder, renderFrom)
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
			queue: (info.userId || service) + BG_INDEXING_QUEUE_SUFFIX,
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
				...skapiExtract,
				...skapiRender,
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
		queue: (info.userId || service) + BG_INDEXING_QUEUE_SUFFIX,
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
};

// Token the indexing agent appends to its final message ONLY when it has fully read and
// saved the whole file. Its ABSENCE is what tells the client to run another CONTINUE pass.
//
// Applies to the TEXT/GRID paging path only. The vision path (rendered PDF pages) no longer
// asks the model whether it is finished — the worker advances that loop off the renderer's
// page count — so this marker has no say in whether a PDF keeps going.
export const INDEXING_COMPLETE_MARKER = 'INDEXING_COMPLETE';
// Cap on CONTINUE passes per file, so a file the agent can never mark complete (or a
// pathological loop) stops instead of re-dispatching forever. The text/grid paging path
// reads MANY windows within a single pass (the agent loops readFileContent in one turn), so
// a small cap suffices.
export const MAX_INDEXING_RESUME_PASSES = 6;

export async function getChatHistory(
	params: { service?: string; owner?: string; platform: 'claude' | 'openai'; queue?: string },
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
	);

	return chatEngineConfig().clientSecretRequestHistory(
		p as { url: string; method: 'POST'; queue?: string },
		Object.assign({ ascending: false }, fetchOptions),
	);
}
