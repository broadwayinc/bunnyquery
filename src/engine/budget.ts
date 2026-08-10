/**
 * Token-budgeting (pure). Moved verbatim from the chatbox. Constants are shared
 * module-level values (identical in both consumers); a config knob is premature.
 * buildBoundedChatMessages now takes `projectId` in its options so it can pass it
 * to sanitizeAttachmentLinksForHistory (which used to read a global).
 */
import { sanitizeAttachmentLinksForHistory } from './links';

export var CONTEXT_WINDOW_DEFAULT: Record<string, number> = { claude: 200000, openai: 128000 };
// Exact model ids first, then family keys (see getModelContextWindow: a suffixed
// id falls back to its family rather than to the platform default). Claude
// figures come from Anthropic's published model table; `max_input_tokens` from
// /v1/models overrides all of this at runtime when a listing has been seen.
// OpenAI's /v1/models carries NO context field at all, so every gpt entry here
// is hand-maintained and is the only source for those models.
// These are TOTAL windows (input + output), which is what the published tables
// report and what getInputTokenBudget assumes when it subtracts the output
// reserve. The two readings reconcile: gpt-5.6-luna is 1,050,000 total with a
// 128,000 output cap, i.e. the ~922,000 of usable input quoted for it elsewhere.
export var CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
	// claude, exact ids
	'claude-fable-5': 1000000, 'claude-opus-5': 1000000,
	'claude-opus-4-8': 1000000, 'claude-opus-4-7': 1000000,
	'claude-opus-4-6': 1000000, 'claude-opus-4-5': 200000,
	'claude-sonnet-5': 1000000, 'claude-sonnet-4-6': 1000000,
	'claude-sonnet-4-5': 1000000, 'claude-sonnet-4': 200000,
	'claude-haiku-4-5': 200000, 'claude-3-5-sonnet': 200000,
	// openai, exact ids
	'gpt-5.6-sol': 1050000, 'gpt-5.6-terra': 1050000, 'gpt-5.6-luna': 1050000,
	'gpt-5.5': 1000000, 'gpt-5.4': 1050000,
	'gpt-5.4-mini': 400000, 'gpt-5.4-nano': 400000,
	'gpt-4.1': 1040000, 'gpt-4o': 128000, 'o1': 200000, 'o1-pro': 200000,
	// family keys
	'claude-fable': 1000000, 'claude-opus': 1000000, 'claude-sonnet': 1000000,
	'claude-haiku': 200000, 'gpt-5.6': 1050000, 'gpt-5': 128000,
};
// Two rows above are load-bearing rather than redundant, both because the family
// walk drops trailing segments:
//   'claude-opus-4-5' — a dated id like 'claude-opus-4-5-20251101' would
//     otherwise walk past it to the 'claude-opus' family and resolve 1000000 for
//     a model whose real window is 200000.
//   'gpt-5.4-mini' and 'gpt-5.4-nano' — would otherwise walk to 'gpt-5.4' and
//     resolve 1050000 instead of their actual 400000. nano is the one that
//     matters most in practice: the indexing path selects it by name.
// The bare 'gpt-5' family stays deliberately low: it is the catch-all for gpt-5
// variants not listed here, and a mini-class variant is the likelier unknown.
//
// One asymmetry these rows expose: a total minus our output reserve can exceed a
// model's separately-published INPUT ceiling (gpt-5.4-nano is 400000 total but
// caps input at 272000, where 400000 - 25000 - 4000 reads as 371000). Harmless
// today because INPUT_CAP_RATIO binds far below either figure (59360 for nano),
// but it is why the ratio is not something to remove.

// Provider hard ceilings on output tokens per request. Only used to clamp what
// we ask for (see getMaxOutputTokens) — we never request more than
// MAX_OUTPUT_TOKENS anyway, so this matters exactly where a model's cap is
// BELOW that: gpt-4o at 4000 and legacy 3.5 Sonnet at 8000 would reject the
// flat 25000 the request builder used to send unconditionally.
export var MAX_OUTPUT_BY_MODEL: Record<string, number> = {
	// claude
	'claude-fable-5': 128000, 'claude-opus-5': 128000,
	'claude-opus-4-8': 128000, 'claude-sonnet-5': 128000,
	'claude-sonnet-4-6': 64000, 'claude-haiku-4-5': 64000,
	'claude-3-5-sonnet': 8000,
	// openai
	'gpt-5.6-sol': 128000, 'gpt-5.6-terra': 128000, 'gpt-5.6-luna': 128000,
	'gpt-5.5': 128000, 'gpt-5.4': 128000,
	'gpt-5.4-mini': 128000, 'gpt-5.4-nano': 128000,
	'gpt-4.1': 16000, 'gpt-4o': 4000, 'o1': 100000, 'o1-pro': 100000,
	// family keys
	'claude-fable': 128000, 'claude-opus': 128000, 'claude-sonnet': 64000,
	'claude-haiku': 64000, 'gpt-5.6': 128000, 'gpt-5': 128000,
};

// The window a project runs at when nobody has touched the setting, clamped per
// model by getContextWindow. Deliberately BELOW every frontier ceiling it can
// resolve against (1,000,000 on the Claude 5 line, 1,050,000 on gpt-5.6) because
// the client-side budget covers only the FIRST request: after that the model
// runs a server-side tool loop whose web_fetch and MCP results accumulate in the
// same conversation and are not counted here. The gap (120k and 170k
// respectively) is that loop's room. It matters because no compaction beta is
// enabled, so overrunning the real window is a hard error, not a graceful
// degrade.
export var DEFAULT_CONTEXT_WINDOW = 880000;

// Context windows reported by a provider's own models listing, keyed by model id.
// Anthropic's GET /v1/models returns `max_input_tokens` per model, which is the
// authoritative context window; OpenAI's listing carries no equivalent field, so
// OpenAI models resolve from the table above. Populated by
// registerModelContextWindows() when a client fetches its model list.
var apiReportedContextWindows: Record<string, number> = {};
var apiReportedMaxOutput: Record<string, number> = {};

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
export function registerModelContextWindows(
	models: Array<{ id?: string; max_input_tokens?: number; max_tokens?: number }> | null | undefined,
): void {
	if (!Array.isArray(models)) return;
	for (var i = 0; i < models.length; i++) {
		var m = models[i];
		var id = (m && m.id ? String(m.id) : '').trim().toLowerCase();
		if (!id) continue;
		var reported = m ? Number(m.max_input_tokens) : NaN;
		if (Number.isFinite(reported) && reported > 0) {
			apiReportedContextWindows[id] = Math.floor(reported);
		}
		var out = m ? Number(m.max_tokens) : NaN;
		if (Number.isFinite(out) && out > 0) {
			apiReportedMaxOutput[id] = Math.floor(out);
		}
	}
}

/** Per-project override, keyed by service id. Set from the project settings. */
var projectContextWindows: Record<string, number> = {};

export function setProjectContextWindow(projectId: string, tokens: number | null | undefined): void {
	var key = (projectId || '').trim();
	if (!key) return;
	var n = Number(tokens);
	if (Number.isFinite(n) && n > 0) projectContextWindows[key] = Math.floor(n);
	else delete projectContextWindows[key];
}

export function getProjectContextWindow(projectId: string): number | null {
	var key = (projectId || '').trim();
	return key && projectContextWindows[key] ? projectContextWindows[key] : null;
}
// `max_tokens` sent on every chat request. Exported so the reserve below and the
// actual request cannot drift: they were 22000 and 25000 respectively, which
// under-reserved by 3k on a window spent to the last token.
export var MAX_OUTPUT_TOKENS = 25000;
export var OUTPUT_TOKEN_RESERVE = MAX_OUTPUT_TOKENS;
export var TOOL_AND_RESPONSE_BUFFER = 4000;
export var MIN_INPUT_TOKEN_BUDGET = 8000;
// Floor under INPUT_CAP_RATIO. Anthropic's default tier enforces 30,000 input
// tokens per MINUTE on Opus, which is where the number comes from; it is applied
// on OpenAI too so a small-window model keeps a usable attachment budget instead
// of collapsing to the ratio.
export var MIN_PER_REQUEST_INPUT_CAP = 28000;
/** @deprecated renamed to {@link MIN_PER_REQUEST_INPUT_CAP} (no longer Claude-only). */
export var CLAUDE_PER_REQUEST_INPUT_CAP = MIN_PER_REQUEST_INPUT_CAP;
export var MAX_HISTORY_MESSAGES = 20;
export var HISTORY_TOKEN_BUDGET = 8000;
// Ratios that scale the two ceilings above off the resolved context window.
// Originally calibrated to reproduce the previous fixed values at the old
// default windows (claude 200000 -> cap 27840, openai 128000 -> history 8160).
// Both are floored at the old constants, so they can only ever raise a budget,
// never lower one, which is what keeps a small-window model (claude-opus-4-5 at
// 200000) behaving as it always did.
//
// INPUT_CAP_RATIO now applies to BOTH platforms. It was Claude-only because it
// encoded a Claude rate limit, but at a 880000 default it does a second job that
// matters just as much on OpenAI: it is the headroom. Uncapped, gpt-5.6-luna
// resolved an input budget of 851000 against a 922000 ceiling, leaving 71000 for
// the whole server-side tool loop, and ONE web_fetch result can be 200000.
export var INPUT_CAP_RATIO = 0.16;
/** @deprecated renamed to {@link INPUT_CAP_RATIO} (no longer Claude-only). */
export var CLAUDE_INPUT_CAP_RATIO = INPUT_CAP_RATIO;
export var HISTORY_BUDGET_RATIO = 0.08;

export function estimateTextTokens(text: string): number {
	return Math.ceil((text || '').length / 3);
}

export function estimateMessageTokens(msg: { role: string; content: string }): number {
	return estimateTextTokens(msg.content) + estimateTextTokens(msg.role) + 6;
}

/**
 * The model's own HARD ceiling: the largest window it can be asked for at all.
 * Resolved most specific source first:
 *   1. the provider's own models listing (Anthropic `max_input_tokens`)
 *   2. an exact entry in CONTEXT_WINDOW_BY_MODEL
 *   3. a family entry, by dropping trailing '-' segments off the id
 *   4. the platform default
 *
 * Step 3 is why a new or suffixed id no longer drops straight to the platform
 * default: 'gpt-5.6-luna' resolves via 'gpt-5.6', and a dated Claude snapshot
 * such as 'claude-opus-4-7-20260101' resolves via 'claude-opus-4-7'. The walk
 * stops at the first hit, so a more specific entry always wins over its family.
 *
 * This is what the settings UI offers presets against; it is NOT what a request
 * is budgeted at. For that see getContextWindow.
 */
/**
 * Shared id resolution for both per-model tables: provider listing, then exact
 * table entry, then family entries by dropping trailing '-' segments. Returns 0
 * when nothing matches so callers can apply their own default.
 */
function resolveByModelId(
	apiTable: Record<string, number>,
	staticTable: Record<string, number>,
	model?: string,
): number {
	var normalized = (model || '').trim().toLowerCase();
	if (!normalized) return 0;
	if (apiTable[normalized]) return apiTable[normalized];
	if (staticTable[normalized]) return staticTable[normalized];
	var parts = normalized.split('-');
	for (var end = parts.length - 1; end > 0; end--) {
		var family = parts.slice(0, end).join('-');
		if (staticTable[family]) return staticTable[family];
	}
	return 0;
}

export function getModelContextWindow(platform: string, model?: string): number {
	return resolveByModelId(apiReportedContextWindows, CONTEXT_WINDOW_BY_MODEL, model)
		|| CONTEXT_WINDOW_DEFAULT[platform];
}

/**
 * How many output tokens to ask for. We never want more than MAX_OUTPUT_TOKENS,
 * but a model whose own cap is lower rejects the request outright, so clamp to
 * whichever is smaller. Models with no known cap keep MAX_OUTPUT_TOKENS.
 */
export function getMaxOutputTokens(platform: string, model?: string): number {
	var cap = resolveByModelId(apiReportedMaxOutput, MAX_OUTPUT_BY_MODEL, model);
	return cap ? Math.min(MAX_OUTPUT_TOKENS, cap) : MAX_OUTPUT_TOKENS;
}

/**
 * The window a request is actually budgeted at: the per-project override when
 * one is set, otherwise DEFAULT_CONTEXT_WINDOW. Both are clamped to the model's
 * hard ceiling, because a budget above the ceiling builds a request the provider
 * rejects, and a stored override outlives the model it was chosen under.
 */
export function getContextWindow(platform: string, model?: string, projectId?: string): number {
	var ceiling = getModelContextWindow(platform, model);
	var override = projectId ? getProjectContextWindow(projectId) : null;
	return Math.min(override || DEFAULT_CONTEXT_WINDOW, ceiling);
}

/**
 * Per-request input-token budget, i.e. how much of the resolved window this turn
 * may spend on system prompt + history + the latest message. The single
 * implementation behind both buildBoundedChatMessages and the composer's
 * pre-send guard, which used to be separate copies that disagreed.
 */
/**
 * The share of the resolved window left after reserving what this request may
 * emit. The reserve is per-model rather than the flat OUTPUT_TOKEN_RESERVE
 * because getMaxOutputTokens clamps small-cap models below it.
 */
function contextBasedBudgetFor(platform: string, model?: string, projectId?: string): number {
	var contextWindow = getContextWindow(platform, model, projectId);
	return Math.max(MIN_INPUT_TOKEN_BUDGET,
		contextWindow - getMaxOutputTokens(platform, model) - TOOL_AND_RESPONSE_BUFFER);
}

export function getInputTokenBudget(platform: string, model?: string, projectId?: string): number {
	var contextBasedBudget = contextBasedBudgetFor(platform, model, projectId);
	return Math.min(contextBasedBudget,
		Math.max(MIN_PER_REQUEST_INPUT_CAP, Math.round(contextBasedBudget * INPUT_CAP_RATIO)));
}

export function stripFileBlocksFromHistory(content: string): string {
	if (!content) return content;
	return content.replace(/```([^\n`]+?\.[^\s.`]+)\n[\s\S]*?```/g, '[file previously attached: $1]');
}

export type BoundedChatOptions = {
	platform: string;
	model?: string;
	systemPrompt: string;
	history: Array<{ role: string; content: string }>;
	/** Used to strip/rewrite expired attachment links in older user turns. */
	projectId: string;
};

export function buildBoundedChatMessages(options: BoundedChatOptions) {
	var contextBasedBudget = contextBasedBudgetFor(options.platform, options.model, options.projectId);
	// Scaling used to be gated on an EXPLICIT per-project override so that a
	// project nobody had configured kept the old fixed ceilings. That gate is
	// gone now that DEFAULT_CONTEXT_WINDOW is itself the default: leaving it in
	// would mean an unconfigured project resolved 880000 and then spent 28000 of
	// it, making the new default purely cosmetic, and would keep the trap where
	// "Default (880K)" and an explicit 880K behaved differently.
	// Both ceilings derive from contextBasedBudget (pre-Claude-cap) so the two
	// platforms scale symmetrically rather than the Claude cap compounding down.
	var availableInputBudget = getInputTokenBudget(options.platform, options.model, options.projectId);
	var systemCost = estimateTextTokens(options.systemPrompt) + 12;
	var historyAllowance = Math.max(HISTORY_TOKEN_BUDGET,
		Math.round(contextBasedBudget * HISTORY_BUDGET_RATIO));
	var budgetForHistory = Math.max(1000, Math.min(historyAllowance, availableInputBudget - systemCost));
	// The message count scales alongside the token budget; otherwise 20 messages
	// is a second ceiling that swallows the extra budget on a raised window.
	var maxHistoryMessages = Math.max(MAX_HISTORY_MESSAGES,
		Math.round(MAX_HISTORY_MESSAGES * (budgetForHistory / HISTORY_TOKEN_BUDGET)));
	var windowed = options.history.slice(-maxHistoryMessages);
	var latestIndex = windowed.length - 1;
	var trimmed = windowed.map(function (m, i) {
		if (i === latestIndex) return m;
		var stripped = stripFileBlocksFromHistory(m.content);
		// Sanitize BOTH roles: user turns via the "Attached files:" block, assistant
		// turns via the safe db-only path (forAssistant=true) so a volatile db url the
		// model emitted doesn't get replayed into the LLM context as a dead link.
		var sanitized = sanitizeAttachmentLinksForHistory(stripped, options.projectId, m.role !== 'user');
		return Object.assign({}, m, { content: sanitized });
	});
	var bounded: Array<{ role: string; content: string }> = [], used = 0;
	for (var i = trimmed.length - 1; i >= 0; i--) {
		var cost = estimateMessageTokens(trimmed[i]);
		if (used + cost > budgetForHistory && bounded.length > 0) break;
		bounded.unshift(trimmed[i]); used += cost;
	}
	return {
		messages: bounded.map(function (m) { return { role: m.role, content: m.content }; }),
		droppedCount: Math.max(0, options.history.length - bounded.length),
		estimatedInputTokens: used + systemCost,
		estimatedBudget: availableInputBudget,
	};
}
