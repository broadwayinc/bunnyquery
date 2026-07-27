/**
 * Token-budgeting (pure). Moved verbatim from the chatbox. Constants are shared
 * module-level values (identical in both consumers); a config knob is premature.
 * buildBoundedChatMessages now takes `serviceId` in its options so it can pass it
 * to sanitizeAttachmentLinksForHistory (which used to read a global).
 */
import { sanitizeAttachmentLinksForHistory } from './links';

export var CONTEXT_WINDOW_DEFAULT: Record<string, number> = { claude: 200000, openai: 128000 };
// Exact model ids first, then family keys (see getContextWindow: a suffixed id
// falls back to its family rather than to the platform default). Claude figures
// come from Anthropic's published model table; `max_input_tokens` from
// /v1/models overrides all of this at runtime when a listing has been seen.
// 'claude-opus-4-7' read 200000 here, which was wrong by 5x, and the default
// Claude model 'claude-sonnet-4-6' was absent entirely so it fell through to
// CONTEXT_WINDOW_DEFAULT.claude. Neither was observable, because the history
// budget and the Claude per-request cap below bind long before the window does.
export var CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
	// exact ids
	'claude-opus-5': 1000000, 'claude-opus-4-8': 1000000, 'claude-opus-4-7': 1000000,
	'claude-sonnet-5': 1000000, 'claude-sonnet-4-6': 1000000, 'claude-sonnet-4': 200000,
	'claude-haiku-4-5': 200000, 'gpt-5.4': 128000, 'gpt-5.6-luna': 128000,
	// family keys
	'claude-opus': 1000000, 'claude-sonnet': 1000000, 'claude-haiku': 200000,
	'gpt-5.6': 128000, 'gpt-5': 128000,
};

// Context windows reported by a provider's own models listing, keyed by model id.
// Anthropic's GET /v1/models returns `max_input_tokens` per model, which is the
// authoritative context window; OpenAI's listing carries no equivalent field, so
// OpenAI models resolve from the table above. Populated by
// registerModelContextWindows() when a client fetches its model list.
var apiReportedContextWindows: Record<string, number> = {};

/**
 * Record context windows from a provider models listing. Accepts the raw list
 * items and reads `max_input_tokens` (Anthropic); items without it are skipped,
 * so passing an OpenAI listing is a no-op rather than an error.
 */
export function registerModelContextWindows(models: Array<{ id?: string; max_input_tokens?: number }> | null | undefined): void {
	if (!Array.isArray(models)) return;
	for (var i = 0; i < models.length; i++) {
		var m = models[i];
		var id = (m && m.id ? String(m.id) : '').trim().toLowerCase();
		var reported = m ? Number(m.max_input_tokens) : NaN;
		if (id && Number.isFinite(reported) && reported > 0) {
			apiReportedContextWindows[id] = Math.floor(reported);
		}
	}
}

/** Per-project override, keyed by service id. Set from the project settings. */
var projectContextWindows: Record<string, number> = {};

export function setProjectContextWindow(serviceId: string, tokens: number | null | undefined): void {
	var key = (serviceId || '').trim();
	if (!key) return;
	var n = Number(tokens);
	if (Number.isFinite(n) && n > 0) projectContextWindows[key] = Math.floor(n);
	else delete projectContextWindows[key];
}

export function getProjectContextWindow(serviceId: string): number | null {
	var key = (serviceId || '').trim();
	return key && projectContextWindows[key] ? projectContextWindows[key] : null;
}
export var OUTPUT_TOKEN_RESERVE = 22000;
export var TOOL_AND_RESPONSE_BUFFER = 4000;
export var MIN_INPUT_TOKEN_BUDGET = 8000;
export var CLAUDE_PER_REQUEST_INPUT_CAP = 28000;
export var MAX_HISTORY_MESSAGES = 20;
export var HISTORY_TOKEN_BUDGET = 8000;
// Ratios that scale the two ceilings above off the resolved context window.
// Calibrated to reproduce the previous fixed values at the default windows:
// claude 200000 -> cap 27840 (was 28000, so the 28000 floor holds), and
// openai 128000 -> history 8160 (~the previous 8000). Both are floored at the
// old constants, so these can only ever raise a budget, never lower one.
export var CLAUDE_INPUT_CAP_RATIO = 0.16;
export var HISTORY_BUDGET_RATIO = 0.08;

export function estimateTextTokens(text: string): number {
	return Math.ceil((text || '').length / 3);
}

export function estimateMessageTokens(msg: { role: string; content: string }): number {
	return estimateTextTokens(msg.content) + estimateTextTokens(msg.role) + 6;
}

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
export function getContextWindow(platform: string, model?: string, serviceId?: string): number {
	var override = serviceId ? getProjectContextWindow(serviceId) : null;
	if (override) return override;

	var normalized = (model || '').trim().toLowerCase();
	if (normalized) {
		if (apiReportedContextWindows[normalized]) return apiReportedContextWindows[normalized];
		if (CONTEXT_WINDOW_BY_MODEL[normalized]) return CONTEXT_WINDOW_BY_MODEL[normalized];

		var parts = normalized.split('-');
		for (var end = parts.length - 1; end > 0; end--) {
			var family = parts.slice(0, end).join('-');
			if (CONTEXT_WINDOW_BY_MODEL[family]) return CONTEXT_WINDOW_BY_MODEL[family];
		}
	}
	return CONTEXT_WINDOW_DEFAULT[platform];
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
	serviceId: string;
};

export function buildBoundedChatMessages(options: BoundedChatOptions) {
	var contextWindow = getContextWindow(options.platform, options.model, options.serviceId);
	var contextBasedBudget = Math.max(MIN_INPUT_TOKEN_BUDGET,
		contextWindow - OUTPUT_TOKEN_RESERVE - TOOL_AND_RESPONSE_BUFFER);
	// Scaling is gated on an EXPLICIT per-project window set from project
	// settings. Without one, the fixed ceilings apply exactly as before, so every
	// existing project keeps byte-identical behavior and nobody's token spend
	// moves because a table value was corrected. With one, the Claude per-request
	// cap and the history budget scale off the window, so raising it genuinely
	// sends more history instead of being absorbed by a hardcoded ceiling.
	// Both derive from contextBasedBudget (pre-Claude-cap) so the two platforms
	// scale symmetrically rather than the Claude cap compounding the ratio down.
	var scaled = !!(options.serviceId && getProjectContextWindow(options.serviceId));
	var claudeInputCap = scaled
		? Math.max(CLAUDE_PER_REQUEST_INPUT_CAP, Math.round(contextBasedBudget * CLAUDE_INPUT_CAP_RATIO))
		: CLAUDE_PER_REQUEST_INPUT_CAP;
	var availableInputBudget = options.platform === 'claude'
		? Math.min(contextBasedBudget, claudeInputCap) : contextBasedBudget;
	var systemCost = estimateTextTokens(options.systemPrompt) + 12;
	var historyAllowance = scaled
		? Math.max(HISTORY_TOKEN_BUDGET, Math.round(contextBasedBudget * HISTORY_BUDGET_RATIO))
		: HISTORY_TOKEN_BUDGET;
	var budgetForHistory = Math.max(1000, Math.min(historyAllowance, availableInputBudget - systemCost));
	// The message count scales alongside the token budget; otherwise 20 messages
	// is a second ceiling that swallows the extra budget on a raised window.
	var maxHistoryMessages = scaled
		? Math.max(MAX_HISTORY_MESSAGES, Math.round(MAX_HISTORY_MESSAGES * (budgetForHistory / HISTORY_TOKEN_BUDGET)))
		: MAX_HISTORY_MESSAGES;
	var windowed = options.history.slice(-maxHistoryMessages);
	var latestIndex = windowed.length - 1;
	var trimmed = windowed.map(function (m, i) {
		if (i === latestIndex) return m;
		var stripped = stripFileBlocksFromHistory(m.content);
		// Sanitize BOTH roles: user turns via the "Attached files:" block, assistant
		// turns via the safe db-only path (forAssistant=true) so a volatile db url the
		// model emitted doesn't get replayed into the LLM context as a dead link.
		var sanitized = sanitizeAttachmentLinksForHistory(stripped, options.serviceId, m.role !== 'user');
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
