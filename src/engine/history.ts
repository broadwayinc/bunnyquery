/**
 * History mapping (pure). Moved verbatim from the chatbox. The clear-horizon
 * timestamp and the "Indexing: …" display label are INJECTED (clearedAt param,
 * formatIndexingLabel callback) so the engine touches neither localStorage nor
 * view-specific display formatting. serviceId is passed for link sanitization.
 */
import { extractClaudeText, extractOpenAIText } from './requests';
import { isErrorResponseBody, getErrorMessage } from './errors';
import { sanitizeAttachmentLinksForHistory } from './links';

export function filterListByClearHorizon(list: any[], clearedAt: number): any[] {
	if (!clearedAt) return list;
	return list.filter(function (item) {
		var updated = Number(item && item.updated);
		return isFinite(updated) && updated > clearedAt;
	});
}

export function normalizeTextContent(content: any): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map(function (part: any) {
			if (typeof part === 'string') return part;
			if (part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text')) return part.text || '';
			return '';
		}).join('\n').trim();
	}
	return '';
}

export function extractLastUserTextFromRequest(requestBody: any): string {
	var arr = requestBody && Array.isArray(requestBody.messages) ? requestBody.messages
		: (requestBody && Array.isArray(requestBody.input) ? requestBody.input : []);
	for (var i = arr.length - 1; i >= 0; i--) {
		if (arr[i] && arr[i].role === 'user') {
			var t = normalizeTextContent(arr[i].content);
			if (t) return t;
		}
	}
	return '';
}

export type MapHistoryOptions = {
	clearedAt: number;
	serviceId: string;
	/** View-side display formatter for "Indexing:/Reindexing: …" bubbles. */
	formatIndexingLabel: (name: string, mime?: string, size?: number | null, storagePath?: string, reindex?: boolean, continued?: boolean) => string;
};

export function mapHistoryListToMessages(list: any[], platform: 'claude' | 'openai', opts: MapHistoryOptions) {
	var mapped: any[] = [], runningItemIds: string[] = [];
	var extractAssistantText = platform === 'openai' ? extractOpenAIText : extractClaudeText;
	var filtered = filterListByClearHorizon(list, opts.clearedAt);
	filtered.slice().reverse().forEach(function (item) {
		var requestBody = item && item.request_body;
		var isInProcess = item && item.status === 'running';
		var isQueued = item && item.status === 'pending';
		var isCancelledItem = item && item.status === 'cancelled';
		var isPending = isInProcess || isQueued;
		var isFailed = item && item.status === 'failed';
		var response = isFailed ? (item.error != null ? item.error : item.response_body)
			: (item && item.response_body != null ? item.response_body : item && item.error);
		var userText = extractLastUserTextFromRequest(requestBody);
		var assistantText = isPending ? '' : ((extractAssistantText(response) || '').trim() || '');
		var isErrorResponse = !isPending && (isFailed || isErrorResponseBody(response));
		var serverItemId = item && typeof item.id === 'string' && item.id ? item.id : undefined;

		if (userText) {
			var displayContent;
			// Structured file ref for the display layer's per-file collapsing, kept
			// alongside the formatted label so grouping never has to parse it back.
			var indexFile: any = undefined;
			if (item._isBgTask) {
				var nameMatch = userText.match(/^- name: (.+)$/m);
				if (nameMatch) {
					var mimeMatch = userText.match(/^- mime type: (.+)$/m);
					var sizeMatch = userText.match(/^- size \(bytes\): (\d+)$/m);
					var pathMatch = userText.match(/^- storage path: (.+)$/m);
					// A CONTINUE pass ("CONTINUE indexing …") gets the compact
					// continuation label; a first pass ("A new file …") gets the full
					// one. Mirrors agent.vue's mapHistoryListToMessages so a big file's
					// windows read as progress, not the same task repeating.
					var isContinuePass = userText.indexOf('CONTINUE indexing') === 0;
					displayContent = opts.formatIndexingLabel(
						nameMatch[1].trim(),
						mimeMatch ? mimeMatch[1].trim() : '',
						sizeMatch ? Number(sizeMatch[1]) : null,
						pathMatch ? pathMatch[1].trim() : undefined,
						false,
						isContinuePass
					);
					indexFile = {
						name: nameMatch[1].trim(),
						path: pathMatch ? pathMatch[1].trim() : undefined,
						mime: mimeMatch ? mimeMatch[1].trim() : undefined,
						size: sizeMatch ? Number(sizeMatch[1]) : undefined,
						continued: isContinuePass,
					};
				} else {
					displayContent = userText;
				}
			} else {
				displayContent = sanitizeAttachmentLinksForHistory(userText, opts.serviceId);
			}
			var userMsg: any = { role: 'user', content: displayContent };
			if (isInProcess) userMsg.isPendingInProcess = true;
			if (isQueued) userMsg.isPendingQueued = true;
			if (isCancelledItem) userMsg.isCancelled = true;
			if (item._isBgTask) userMsg.isBackgroundTask = true;
			if (indexFile) userMsg._indexFile = indexFile;
			if (item._isOnBgQueue) userMsg._useBgQueue = true;
			if (serverItemId !== undefined) userMsg._serverItemId = serverItemId;
			mapped.push(userMsg);
		}
		if (isCancelledItem) { /* no assistant bubble */ }
		else if (isInProcess) {
			var ph: any = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true };
			if (item._isBgTask) ph.isBackgroundTask = true;
			if (serverItemId !== undefined) { ph._serverItemId = serverItemId; runningItemIds.push(serverItemId); }
			mapped.push(ph);
		} else if (isQueued) { /* no assistant placeholder */ }
		else if (isErrorResponse) {
			var em: any = { role: 'assistant', content: getErrorMessage(response), isError: true };
			if (item._isBgTask) em.isBackgroundTask = true;
			if (serverItemId !== undefined) em._serverItemId = serverItemId;
			mapped.push(em);
		} else if (assistantText) {
			// Safe db-only sanitize (forAssistant) so a volatile db url the model
			// emitted renders as a re-mintable `_expired_.url` link, not a dead one.
			var okm: any = { role: 'assistant', content: sanitizeAttachmentLinksForHistory(assistantText, opts.serviceId, true) };
			if (item._isBgTask) okm.isBackgroundTask = true;
			if (serverItemId !== undefined) okm._serverItemId = serverItemId;
			mapped.push(okm);
		}
	});
	return { messages: mapped, runningItemIds: runningItemIds };
}
