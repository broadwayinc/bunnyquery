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
// Output sizing lives in budget.ts so the request cap and the reserve the input
// budget subtracts cannot drift; getMaxOutputTokens also clamps per model.
import { getMaxOutputTokens } from './budget';

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
const DEFAULT_OPENAI_IMAGE_DETAIL = 'auto';
const OPENAI_WEB_SEARCH_ENABLED = true;
const OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS = true;
export const MCP_NAME = 'BunnyQuery';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
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
// is exactly the kind of work a moment of deliberation buys, so it went on at the LOWEST setting.
//
// It stays 'low' for a nano that already transcribes correctly (5.6-nano), because effort is
// billed against the same budget as the records and buying it where it is not needed can only
// truncate them.
//
// OLDEST_NANO_REASONING_EFFORT raises it for gpt-5.4-nano and below ONLY, which is the tier that
// actually reads dense scans badly. It is 'high', and what makes that affordable is not one change
// but two:
//   - that tier's render window is SMALL_TIER_PAGES_PER_WINDOW pages, not five, so the same cap is
//     divided between far fewer pages to begin with; and
//   - the worker now DETECTS a pass that ran out of output budget (_output_truncation_reason) and
//     re-runs that window at half the page count instead of advancing past it.
// Before the detector, over-buying reasoning was unsafe in a way that did not show up: a truncated
// pass still returned 200, so the page loop moved on and the rest of that window's records were
// lost silently. With it, spending too much on reasoning costs an extra pass instead of data.
//
// Still the first knob to lower if the logs start showing repeated truncation retries, and
// re-measure that 5-of-28 ratio rather than assuming. null removes the field entirely.
const VARIANT_TEXT_VERBOSITY: string | null = 'high';
const VARIANT_REASONING_EFFORT: string | null = 'low';
const OLDEST_NANO_REASONING_EFFORT: string | null = 'high';

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

/**
 * The indexing-only body knobs, for the ONE tier that needs them: gpt-5.4-nano.
 *
 * Both conditions are load-bearing and mean different things. isOpenAINano is the gpt-5.4
 * FLOOR - below it these fields are rejected rather than ignored, and one 400 kills every
 * indexing pass. isOldestNano is the CEILING - 5.5-nano and 5.6-nano transcribe correctly
 * on their own, so they are left on the provider's defaults exactly like mini and the base
 * models. Every other model gets an empty object, i.e. no `text` and no `reasoning` at all.
 */
const variantIndexingOptions = (model?: string) => {
	if (!isOpenAINano(model) || !isOldestNano(model)) return {};
	return {
		...(VARIANT_TEXT_VERBOSITY ? { text: { verbosity: VARIANT_TEXT_VERBOSITY } } : {}),
		...(OLDEST_NANO_REASONING_EFFORT ? { reasoning: { effort: OLDEST_NANO_REASONING_EFFORT } } : {}),
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

/**
 * A nano at gpt-5.4 or OLDER.
 *
 * This is the observed quality boundary, not a guessed one: gpt-5.4-nano and below
 * transcribe dense scans poorly, while mini, the base models and every gpt-5.6 model
 * (5.6-nano included) read the same documents correctly. So only this tier gets
 * compensated, and everything above it is left exactly as it was — on 'original' detail
 * and a full window, because nothing about it needs fixing and every compensation costs
 * either passes or output budget.
 */
/** The id parses as a gpt version we can reason about. An id that does NOT (o3,
 *  chatgpt-4o-latest, any custom name) is left entirely alone: we cannot tell what it is,
 *  and every compensation here is either a body field that can 400 or a change to how many
 *  images it receives. Unknown means untouched. */
const OPENAI_VERSIONED_ID = /^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/;
const isRecognisedOpenAIVersion = (model?: string) =>
	OPENAI_VERSIONED_ID.test((model || DEFAULT_OPENAI_MODEL).trim().toLowerCase());

const isOldestNano = (model?: string) => {
	const normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
	if (!/(^|-)nano(-|$)/.test(normalized)) return false;
	const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/);
	// Called "nano" but not a naming we recognise: treat it as the weak tier. It also
	// fails the 'original' gate, so it is caught by the downsampled branch first anyway.
	if (!match) return true;
	const major = Number(match[1]);
	const minor = match[2] === undefined ? null : Number(match[2]);
	if (major < 5) return true;
	if (major > 5) return false;
	return minor === null || minor <= 4;
};

// Pages in one render window for a SMALL tier, against RENDER_PAGES_PER_WINDOW (5) for a
// full one.
//
// This is the lever that does not risk a 400. The output budget is one number for the whole
// pass (getMaxOutputTokens, and reasoning is billed against it), so a window of 5 dense pages leaves
// a small model a couple of thousand tokens per page and it starts sampling rows instead of
// transcribing them - which is exactly the "saved 5 line items" on a page holding twenty.
// Halving the window does not raise the cap, it just stops dividing it so many ways, and the
// worker's page loop already runs as many windows as a file needs.
const SMALL_TIER_PAGES_PER_WINDOW = 2;

// Horizontal bands per page for a tier whose images the API DOWNSAMPLES before the model
// sees them ('high' resamples onto a 512px tile grid). For those models the render DPI is
// irrelevant - the pixels are thrown away upstream - so the only way to hand them more
// readable text is to make each image cover less of the page. Two bands doubles the
// resolution the model effectively gets, at the cost of one extra image per page.
//
// Bands are horizontal so a table row is never cut down its middle, and they overlap
// slightly so a line landing on the seam appears whole in one of them.
const DOWNSAMPLED_TIER_TILE = 2;

/** How a given model should be shown a rendered document. */
export type VisionProfile = {
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
export function getVisionProfile(model?: string): VisionProfile {
	const detail = getRenderImageDetail(model);
	// An id we cannot parse is left exactly as it was: full window, no tiling. Treating
	// "unknown" as "weak" would quietly change how much work every custom or aliased model
	// does, on no evidence at all.
	if (!isRecognisedOpenAIVersion(model)) {
		return { detail, pagesPerWindow: RENDER_PAGES_PER_WINDOW, tile: 1 };
	}
	if (detail !== 'original') {
		return { detail, pagesPerWindow: SMALL_TIER_PAGES_PER_WINDOW, tile: DOWNSAMPLED_TIER_TILE };
	}
	if (isOldestNano(model)) {
		return { detail, pagesPerWindow: SMALL_TIER_PAGES_PER_WINDOW, tile: 1 };
	}
	return { detail, pagesPerWindow: RENDER_PAGES_PER_WINDOW, tile: 1 };
}

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
		maxTokens: getMaxOutputTokens('claude', model || DEFAULT_CLAUDE_MODEL),
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
			max_output_tokens: getMaxOutputTokens('openai', resolvedModel),
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

	// Durable run record, minted the moment a run's FIRST pass is enqueued (every
	// first-pass site funnels through this function, so one mint covers them all;
	// resume passes belong to the existing run and must not touch it). Ordering is
	// safe by construction: every caller runs its delete-then-repost + src:: mint
	// BEFORE calling here, so the record's `reference: src::<path>` resolves. The
	// dispatch promise is tapped below so an enqueue that never reached the queue
	// closes the record as an error instead of leaving 'working' dangling.
	if (!continuing) {
		upsertIndexRunRecordSafe(service, attachment.storagePath, {
			status: 'working',
			filename: attachment.name,
			started: Date.now(),
			queue: bgIndexingQueueName(info.userId, service),
			platform: platform,
		});
	}
	const tapDispatchFailure = (p: Promise<any>): Promise<any> => {
		if (continuing) return p;
		return p.then(
			(ack: any) => ack,
			(err: any) => {
				upsertIndexRunRecordSafe(service, attachment.storagePath, {
					status: 'error',
					finished: Date.now(),
					error: (err && (err.message || String(err))) || 'The indexing request could not be enqueued.',
				});
				throw err;
			},
		);
	};

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
	// Window size and per-page tiling are resolved from the MODEL, not fixed: see
	// getVisionProfile. Claude keeps the full window (renderDetail is OpenAI-only, and its
	// own resizing behaviour is a separate question this does not try to answer).
	const visionProfile: VisionProfile = platform === 'openai'
		? getVisionProfile(info.model || DEFAULT_OPENAI_MODEL)
		: { detail: '', pagesPerWindow: RENDER_PAGES_PER_WINDOW, tile: 1 };
	const skapiRender = visionFile && renderPlaceholder
		? {
			_skapi_render: [
				{
					path: attachment.storagePath, from: renderFrom, count: visionProfile.pagesPerWindow,
					placeholder: renderPlaceholder, name: attachment.name, mime: attachment.mime, detail: renderDetail,
					tile: visionProfile.tile,
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
		extractContent && extractContent.length
			? {
				_skapi_extract: extractContent.map((d) => ({
					...d,
					// FIRST pass of an INDEXING run only: tells the worker to also pull the
					// file's embedded pictures into __MEDIA__ and register their records.
					// Chat-turn extraction (callClaudeWithMcp / callOpenAIWithPublicMcp)
					// never sets this, so merely ATTACHING a file to a chat message cannot
					// write media records; a CONTINUE pass skips it because the first pass
					// already saved (the save is whole-file, not windowed).
					save_media: !continuing,
				})),
			}
			: {};

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
		// The model copies this id verbatim into project_id tool calls, so it must be
		// the PUBLIC token whenever the host supplied one; the raw code is rejected
		// by the tools' schema pattern.
		projectId: info.publicProjectId || service,
		serviceName: info.serviceName,
		serviceDescription: info.serviceDescription,
	});

	if (platform === 'openai') {
		const resolvedModel = info.model || DEFAULT_OPENAI_MODEL;
		const imageDetail = getOpenAIImageDetail(resolvedModel);
		return tapDispatchFailure(clientSecretRequest({
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
				max_output_tokens: getMaxOutputTokens('openai', resolvedModel),
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
		}));
	}

	const resolvedModel = info.model || DEFAULT_CLAUDE_MODEL;
	return tapDispatchFailure(clientSecretRequest({
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
			max_tokens: getMaxOutputTokens('claude', resolvedModel),
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
	}));
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
export function indexDoneUniqueId(storagePath: string): string {
	return 'done::' + storagePath;
}

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
export function runIndexUniqueId(storagePath: string): string {
	return 'run::' + storagePath;
}

export type IndexRunStatus = 'working' | 'done' | 'error' | 'cancelled';

export type IndexRunPatch = {
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
export function upsertIndexRunRecordSafe(service: string, storagePath: string, patch: IndexRunPatch): void {
	if (!service || !storagePath) return;
	try {
		const hook = chatEngineConfig().upsertIndexRunRecord;
		if (typeof hook !== 'function') return;
		hook({ service, storagePath, patch });
	} catch (e) {
		// best-effort by contract
	}
}

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
	projectId: string;
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
// 500, up from 100: an indexing run is dozens of rows that collapse into ONE visible
// row, so a screenful of history behind a few indexed files took 5+ sequential
// round trips to assemble (cursor paging cannot be parallelised - each page's
// startKey comes from the previous response). The number is a CAP, not a payload
// size: DynamoDB stops a page at 1MB regardless and hands back a cursor, and the
// backend passes the limit through without looping, so heavy indexing rows page at
// the same bytes per trip as before while light chat rows now arrive 500 at a time.
export const CHAT_HISTORY_PAGE_LIMIT = 500;

/**
 * `queue` narrows the fetch to one processing chain; `status` narrows it to items
 * in one state. Passing both is how the client asks "is there still unresolved
 * work on the background-indexing queue?" without pulling a page of chat history
 * (see ChatSession._adoptWorkerIndexingPasses) — the server answers that from a
 * status-keyed index, so the reply carries only the live items, not the bodies of
 * everything already finished.
 */
export async function getChatHistory(
	params: {
		service?: string; owner?: string; platform: 'claude' | 'openai'; queue?: string;
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
	},
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
		params.queue_exact ? { queue_exact: true } : {},
		params.compact ? { compact: true } : {},
		params.queue_exclude ? { queue_exclude: params.queue_exclude } : {},
	);

	return chatEngineConfig().clientSecretRequestHistory(
		p as { url: string; method: 'POST'; queue?: string; status?: string },
		Object.assign({ ascending: false, limit: CHAT_HISTORY_PAGE_LIMIT }, fetchOptions),
	);
}

/** Full server-side id of one history item, for a csr-poll POINT LOOKUP (the
 *  single-item path returns the item WITH bodies — how an expanded row fetches
 *  the passes a compact listing stubbed out). Mirrors the id the SDK builds:
 *  `[METHOD]url#service:` + the item's own `stamp:entropy` id. */
export function buildHistoryItemFullId(platform: 'claude' | 'openai', service: string, itemId: string): string {
	const url = platform === 'claude' ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
	return `[POST]${url.toLowerCase()}#${service}:${itemId}`;
}
