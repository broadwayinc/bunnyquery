/**
 * History mapping (pure). Moved verbatim from the chatbox. The clear-horizon
 * timestamp and the "Indexing: …" display label are INJECTED (clearedAt param,
 * formatIndexingLabel callback) so the engine touches neither localStorage nor
 * view-specific display formatting. serviceId is passed for link sanitization.
 */
import { extractClaudeText, extractOpenAIText, INDEXING_COMPLETE_MARKER, EMPTY_INDEXING_REPLY } from './requests';
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

/** The two openings an indexing prompt can have. A bg-queue item that starts with
 *  neither is an ordinary chat that happened to be routed onto that queue. */
export function isIndexingRequestText(userText: any): boolean {
	if (typeof userText !== 'string') return false;
	return userText.indexOf('A new file has just been uploaded') === 0 || userText.indexOf('CONTINUE indexing') === 0;
}

export type IndexingRequestRef = {
	name: string;
	path?: string;
	mime?: string;
	size?: number;
	/** A CONTINUE pass rather than the run's first. */
	continued: boolean;
};

/**
 * The file an indexing prompt is about, read back out of the prompt itself.
 *
 * The prompt is the only description of the pass that survives on the server, so
 * this is how BOTH a history rebuild and a worker-minted pass the client never
 * dispatched (ChatSession._adoptWorkerIndexingPasses) recover the file. Shared so
 * the two produce the same `_indexFile`, which is what makes them group together.
 */
export function parseIndexingRequestText(userText: any): IndexingRequestRef | null {
	if (typeof userText !== 'string' || !userText) return null;
	var nameMatch = userText.match(/^- name: (.+)$/m);
	if (!nameMatch) return null;
	var mimeMatch = userText.match(/^- mime type: (.+)$/m);
	var sizeMatch = userText.match(/^- size \(bytes\): (\d+)$/m);
	var pathMatch = userText.match(/^- storage path: (.+)$/m);
	return {
		name: nameMatch[1].trim(),
		path: pathMatch ? pathMatch[1].trim() : undefined,
		mime: mimeMatch ? mimeMatch[1].trim() : undefined,
		size: sizeMatch ? Number(sizeMatch[1]) : undefined,
		continued: userText.indexOf('CONTINUE indexing') === 0,
	};
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
		// Record the completion marker, then STRIP it — both, and in that order.
		// Recording gives the display layer a structured signal instead of a substring
		// search over model prose. Stripping matches the live resolution path: without
		// it the literal token rendered inside the bubble on every history load, which
		// is not a post-reload curiosity — a first-page load REPLACES the live bubbles,
		// and those responses are now on screen far more often than they used to be.
		//
		// Gated on _isBgTask: only an INDEXING pass has a protocol token to hide. An
		// ordinary reply that merely mentions it keeps its own words.
		var reportedComplete = !!(item && item._isBgTask) && !isErrorResponse && !!assistantText &&
			assistantText.indexOf(INDEXING_COMPLETE_MARKER) !== -1;
		if (reportedComplete) assistantText = assistantText.split(INDEXING_COMPLETE_MARKER).join('').trim();
		var serverItemId = item && typeof item.id === 'string' && item.id ? item.id : undefined;
		// A USER bubble shows when the request was made (`created`); an ASSISTANT
		// bubble shows when its response landed (`updated`). Fall back to the other
		// if one is missing (older records only carried `updated`).
		var createdTs = Number(item && item.created);
		var updatedTs = Number(item && item.updated);
		var userTs = isFinite(createdTs) && createdTs > 0 ? createdTs : (isFinite(updatedTs) && updatedTs > 0 ? updatedTs : undefined);
		var replyTs = isFinite(updatedTs) && updatedTs > 0 ? updatedTs : (isFinite(createdTs) && createdTs > 0 ? createdTs : undefined);

		if (userText) {
			var displayContent;
			// Structured file ref for the display layer's per-file collapsing, kept
			// alongside the formatted label so grouping never has to parse it back.
			var indexFile: any = undefined;
			if (item._isBgTask) {
				var ref = parseIndexingRequestText(userText);
				if (ref) {
					// A CONTINUE pass ("CONTINUE indexing …") gets the compact
					// continuation label; a first pass ("A new file …") gets the full
					// one. Mirrors agent.vue's mapHistoryListToMessages so a big file's
					// windows read as progress, not the same task repeating.
					displayContent = opts.formatIndexingLabel(
						ref.name,
						ref.mime || '',
						typeof ref.size === 'number' ? ref.size : null,
						ref.path,
						false,
						ref.continued
					);
					indexFile = ref;
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
			if (userTs !== undefined) userMsg._ts = userTs;
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
			if (replyTs !== undefined) em._ts = replyTs;
			mapped.push(em);
		// `|| reportedComplete`: a pass whose ENTIRE answer was the completion token
		// strips down to an empty string, and the plain `assistantText` guard then
		// emitted no bubble at all — while the live path emitted one. The run read as
		// finished live and unfinished after a reload, so the row's loader came back.
		} else if (assistantText || reportedComplete) {
			// Safe db-only sanitize (forAssistant) so a volatile db url the model
			// emitted renders as a re-mintable `_expired_.url` link, not a dead one.
			var okm: any = { role: 'assistant', content: sanitizeAttachmentLinksForHistory(assistantText, opts.serviceId, true) || EMPTY_INDEXING_REPLY };
			if (item._isBgTask) okm.isBackgroundTask = true;
			if (serverItemId !== undefined) okm._serverItemId = serverItemId;
			if (replyTs !== undefined) okm._ts = replyTs;
			if (reportedComplete) okm._indexComplete = true;
			mapped.push(okm);
		}
	});
	return { messages: mapped, runningItemIds: runningItemIds };
}
