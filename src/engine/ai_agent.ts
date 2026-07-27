/**
 * The `ai_agent` service option, parsed and serialized in ONE place.
 *
 * Stored on the skapi service record as up to three '#'-delimited segments:
 *
 *   none                                  AI chat disabled
 *   claude                                platform chosen, no model saved yet
 *   claude#claude-sonnet-4-6              platform + model
 *   claude#claude-sonnet-4-6#400000       platform + model + context-window override
 *
 * The third segment is new and optional, so every value written before it
 * existed parses unchanged with `contextWindow: null`. Nothing writes a third
 * segment without a model, because the window is meaningless without one.
 *
 * This lived as four separate copies (agent.vue, dbfile.vue, service.vue, and
 * the widget's index.js), which is how the format drifts. New callers should
 * import from here rather than re-deriving the split.
 */

export type AiAgentPlatform = 'claude' | 'openai' | null;

export type ParsedAiAgent = {
	/** null when unset or explicitly 'none'. */
	platform: AiAgentPlatform;
	/** '' when no model has been saved. */
	model: string;
	/** Per-project context-window override in tokens, or null to use the model's. */
	contextWindow: number | null;
	/** True when a real platform is configured (i.e. not unset and not 'none'). */
	hasPlatform: boolean;
};

function normalizePlatform(raw: string): AiAgentPlatform {
	var p = (raw || '').trim().toLowerCase();
	return p === 'claude' || p === 'openai' ? p : null;
}

export function parseAiAgentValue(value: string | null | undefined): ParsedAiAgent {
	var raw = (value || '').trim();
	if (!raw || raw.toLowerCase() === 'none') {
		return { platform: null, model: '', contextWindow: null, hasPlatform: false };
	}

	// Split into at most three parts so a '#' inside a model id (none today, but
	// the delimiter should not be load-bearing on the tail) cannot shift fields.
	var firstHash = raw.indexOf('#');
	if (firstHash === -1) {
		var only = normalizePlatform(raw);
		return { platform: only, model: '', contextWindow: null, hasPlatform: !!only };
	}

	var platform = normalizePlatform(raw.slice(0, firstHash));
	var rest = raw.slice(firstHash + 1);
	var secondHash = rest.indexOf('#');
	var model = (secondHash === -1 ? rest : rest.slice(0, secondHash)).trim();
	var windowRaw = secondHash === -1 ? '' : rest.slice(secondHash + 1).trim();

	var parsedWindow = windowRaw ? Number(windowRaw) : NaN;
	var contextWindow = Number.isFinite(parsedWindow) && parsedWindow > 0
		? Math.floor(parsedWindow)
		: null;

	return { platform: platform, model: model, contextWindow: contextWindow, hasPlatform: !!platform };
}

export function buildAiAgentValue(
	platform: string | null | undefined,
	model?: string | null,
	contextWindow?: number | null,
): string {
	var p = (platform || '').trim().toLowerCase();
	if (!p || p === 'none') return 'none';

	var m = (model || '').trim();
	if (!m) return p;

	var n = Number(contextWindow);
	if (!Number.isFinite(n) || n <= 0) return p + '#' + m;
	return p + '#' + m + '#' + Math.floor(n);
}
