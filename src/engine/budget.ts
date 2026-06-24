/**
 * Token-budgeting (pure). Moved verbatim from the chatbox. Constants are shared
 * module-level values (identical in both consumers); a config knob is premature.
 * buildBoundedChatMessages now takes `serviceId` in its options so it can pass it
 * to sanitizeAttachmentLinksForHistory (which used to read a global).
 */
import { sanitizeAttachmentLinksForHistory } from './links';

export var CONTEXT_WINDOW_DEFAULT: Record<string, number> = { claude: 200000, openai: 128000 };
export var CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
	'claude-opus-4-7': 200000, 'claude-sonnet-4': 200000, 'gpt-5.4': 128000,
};
export var OUTPUT_TOKEN_RESERVE = 22000;
export var TOOL_AND_RESPONSE_BUFFER = 4000;
export var MIN_INPUT_TOKEN_BUDGET = 8000;
export var CLAUDE_PER_REQUEST_INPUT_CAP = 28000;
export var MAX_HISTORY_MESSAGES = 20;
export var HISTORY_TOKEN_BUDGET = 8000;

export function estimateTextTokens(text: string): number {
	return Math.ceil((text || '').length / 3);
}

export function estimateMessageTokens(msg: { role: string; content: string }): number {
	return estimateTextTokens(msg.content) + estimateTextTokens(msg.role) + 6;
}

export function getContextWindow(platform: string, model?: string): number {
	var normalized = (model || '').trim().toLowerCase();
	if (normalized && CONTEXT_WINDOW_BY_MODEL[normalized]) return CONTEXT_WINDOW_BY_MODEL[normalized];
	return CONTEXT_WINDOW_DEFAULT[platform];
}

export function stripFileBlocksFromHistory(content: string): string {
	if (!content) return content;
	return content.replace(/```([\w.-]+\.[a-zA-Z0-9]+)\n[\s\S]*?```/g, '[file previously attached: $1]');
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
	var contextWindow = getContextWindow(options.platform, options.model);
	var contextBasedBudget = Math.max(MIN_INPUT_TOKEN_BUDGET,
		contextWindow - OUTPUT_TOKEN_RESERVE - TOOL_AND_RESPONSE_BUFFER);
	var availableInputBudget = options.platform === 'claude'
		? Math.min(contextBasedBudget, CLAUDE_PER_REQUEST_INPUT_CAP) : contextBasedBudget;
	var systemCost = estimateTextTokens(options.systemPrompt) + 12;
	var budgetForHistory = Math.max(1000, Math.min(HISTORY_TOKEN_BUDGET, availableInputBudget - systemCost));
	var windowed = options.history.slice(-MAX_HISTORY_MESSAGES);
	var latestIndex = windowed.length - 1;
	var trimmed = windowed.map(function (m, i) {
		if (i === latestIndex) return m;
		var stripped = stripFileBlocksFromHistory(m.content);
		var sanitized = m.role === 'user' ? sanitizeAttachmentLinksForHistory(stripped, options.serviceId) : stripped;
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
