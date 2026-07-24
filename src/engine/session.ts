/**
 * ChatSession — framework-agnostic stateful chat orchestration.
 *
 * Ported verbatim from the bunnyquery widget's in-place state machine (which was
 * itself ported from agent.vue), with three mechanical substitutions:
 *   CS.<field>        -> this.state.<field>
 *   renderMessages()  -> this.host.notify()
 *   S.<x> / skapi     -> this.host.getIdentity().<x> / this.host.cancelRequest / refreshSession
 *   scroll/refresh    -> this.host.scrollToBottom(IfSticky) / refreshMessageBubble
 * Module-level singletons (bgTaskQueue, aiChatHistoryCache, pendingAgentRequests,
 * cancelledServerIds, historyItemPolls) become instance fields. The provider
 * request builders are reached through the engine (which already has the skapi
 * transport + poll injected via configureChatEngine), so cancel/poll behavior is
 * preserved.
 *
 * The view (per consumer) keeps: rendering, markdown PARSE, DOM refs + scroll
 * measurement, attachment chips, and the auth/account shell. It drives the
 * session via the public methods and re-renders in host.notify().
 */
import {
	callClaudeWithPublicMcp,
	callOpenAIWithPublicMcp,
	notifyAgentSaveAttachment,
	notifyAgentContinueIndexing,
	INDEXING_COMPLETE_MARKER,
	MAX_INDEXING_RESUME_PASSES,
	extractClaudeText,
	extractOpenAIText,
	getChatHistory,
	POLL_INTERVAL,
	BG_INDEXING_QUEUE_SUFFIX,
	isBgIndexingQueue,
	ANTHROPIC_MESSAGES_API_URL,
	OPENAI_RESPONSES_API_URL,
	type BgTaskEntry,
} from './requests';
import { isPagedReadFile, isImageVisionFile, isWindowedReadFile } from './office';
import { windowedIndexingEnabled } from './config';
import { isErrorResponseBody, isAuthExpiredError, isNonRetryableRequestError, getErrorMessage } from './errors';
import { buildBoundedChatMessages } from './budget';
import { createInlineLinkRegex } from './links';
import { mapHistoryListToMessages, extractLastUserTextFromRequest } from './history';
import { parseAttachmentContent } from './attachment_parsers';
import type { ChatHost, ChatState, ChatMessage, PinnedDispatchContext } from './host';
import type { IndexingGroup } from './indexing_groups';

function sleep(ms: number): Promise<void> {
	return new Promise(function (r) { setTimeout(r, ms); });
}

// requestAnimationFrame / high-res clock, reached through globalThis so the
// engine stays DOM-free at the type level (and degrades gracefully in non-DOM
// / test environments where these globals are absent).
var _g: any = typeof globalThis !== 'undefined' ? globalThis : {};
function nowMs(): number {
	return (_g.performance && typeof _g.performance.now === 'function') ? _g.performance.now() : Date.now();
}
function nextFrame(cb: (t: number) => void): void {
	if (typeof _g.requestAnimationFrame === 'function') { _g.requestAnimationFrame(cb); return; }
	setTimeout(function () { cb(nowMs()); }, 16);
}

/** A live poll registered in ChatSession.historyItemPolls. */
export type PollHandle = {
	/** 'bg' = background indexing, pausable. 'fg' = a reply the user is waiting on. */
	kind: 'fg' | 'bg';
	/** Absent on an older skapi-js that cannot stop an attached poll. */
	stop?: () => void;
};

/**
 * True when a poll result came from stopPolling rather than the server. Duck-typed on
 * purpose — see the note above about not importing skapi-js here.
 */
function isPollStopped(res: any): boolean {
	return !!res && typeof res === 'object' && res.status === 'stopped';
}

export class ChatSession {
	host: ChatHost;
	state: ChatState;
	bgTaskQueue: BgTaskEntry[];
	cancelledServerIds: Set<string>;
	/** Files whose indexing the user stopped, keyed exactly as buildChatDisplayList
	 *  keys a group (storage path, else filename). Cancelling one pass is not
	 *  enough on its own: the client dispatches CONTINUE passes for paged files, so
	 *  without this the next pass is enqueued the moment the cancelled one settles.
	 *  Cleared when a FIRST pass for the same file is queued again (a re-upload or a
	 *  Reindex from the file manager), so stopping a file never poisons it. */
	cancelledIndexKeys: Set<string>;
	pendingAgentRequests: Record<string, Promise<any>>;
	aiChatHistoryCache: Record<string, { messages: ChatMessage[]; endOfList: boolean; startKeyHistory: string[] }>;
	historyItemPolls: Map<string, PollHandle>;
	/** Non-empty while polling is paused; keyed by reason so overlapping causes
	 * (view detached AND tab hidden) do not resume each other prematurely. */
	private _pauseReasons: Set<string>;
	private _resuming: boolean;
	private _lidSeq: number;

	constructor(host: ChatHost) {
		this.host = host;
		this.state = {
			messages: [],
			attachments: [],
			uploadingAttachments: false,
			sending: false,
			typing: false,
			typingAbort: false,
			loadingHistory: false,
			loadingOlderHistory: false,
			historyEndOfList: false,
			historyStartKeyHistory: [],
			historyRequestToken: 0,
			gateRefreshToken: 0,
		};
		this.bgTaskQueue = [];
		this.cancelledServerIds = new Set();
		this.cancelledIndexKeys = new Set();
		this.pendingAgentRequests = {};
		this.aiChatHistoryCache = {};
		this.historyItemPolls = new Map();
		this._pauseReasons = new Set();
		this._resuming = false;
		this._lidSeq = 0;
	}

	/**
	 * Register a live poll so (a) a remount dedupes against it instead of stacking a
	 * SECOND poll on the same item, and (b) pausePolling can stop it.
	 *
	 * `stop` comes from the SDK and may be absent on an older skapi-js, in which case the
	 * poll simply cannot be stopped and is left running — see pausePolling.
	 */
	private _trackPoll(id: string, kind: 'fg' | 'bg', p: any): any {
		var stop = p && typeof p.stop === 'function' ? p.stop.bind(p) : undefined;
		if (!stop) {
			// The SDK could not give us a handle. Almost always means an older skapi-js
			// is loaded (or a stale bundler dep cache) — the poll will be unstoppable.
			console.debug('[chat-engine] poll has no stop handle', { id: id, kind: kind });
		}
		this.historyItemPolls.set(id, { kind: kind, stop: stop });
		return p;
	}

	/**
	 * Stop and forget one item's poll. Used after a cancel: the row is either gone
	 * (cancelled while queued) or flagged cancelled (cancelled while running), so
	 * asking about it again only burns requests. Safe when no poll is attached, and
	 * safe on an older skapi-js with no stop handle (the entry is then LEFT in the
	 * map so a later drain cannot stack a second, unstoppable poll on the id).
	 */
	private _stopPoll(id: string): void {
		var handle = this.historyItemPolls.get(id);
		if (!handle) return;
		if (typeof handle.stop !== 'function') return;
		try { handle.stop(); } catch (e) { /* best effort */ }
		this.historyItemPolls.delete(id);
	}

	/** True while any pause reason is active. */
	isPollingPaused(): boolean {
		return this._pauseReasons.size > 0;
	}

	/**
	 * Stop BACKGROUND polling until resumePolling. Foreground polls (a reply the user is
	 * waiting on) keep running deliberately: their results must still land in the history
	 * cache so resumePendingRequest can render them on return, otherwise a user who sends
	 * a message then navigates away comes back to a permanently stuck "Thinking...".
	 *
	 * Server-side work is untouched; this only stops asking about it. That is safe for
	 * document indexing because the worker drives that loop itself.
	 */
	pausePolling(reason: string): void {
		this._pauseReasons.add(reason || 'paused');
		var self = this;
		var stopped: string[] = [];
		this.historyItemPolls.forEach(function (handle, id) {
			if (!handle || handle.kind !== 'bg') return;
			// No stop available (older SDK): LEAVE the entry in place. Deleting it would
			// let a later drain attach a second, uncancellable poll on the same item.
			if (typeof handle.stop !== 'function') return;
			try { handle.stop(); } catch (e) { /* best effort */ }
			stopped.push(id);
		});
		// Delete only what we actually stopped, one at a time. NEVER clear() the map:
		// wholesale clearing is what previously let loadHistory attach a duplicate poll
		// on a live item, producing duplicate replies and stranded "Thinking" bubbles.
		stopped.forEach(function (id) { self.historyItemPolls.delete(id); });

	}

	/**
	 * Lift a pause reason WITHOUT running the reconcile. For a caller that is about to
	 * reload history anyway (a view remounting), letting resumePolling also reconcile
	 * would race that load and can double-attach.
	 */
	clearPauseReason(reason: string): void {
		this._pauseReasons.delete(reason || 'paused');
	}

	/**
	 * Clear a pause reason and, once none remain, re-attach polling and reconcile.
	 * Deliberately does NOT touch gateRefreshToken: bumping it would silently discard
	 * the results of anything still in flight across the pause.
	 */
	resumePolling(reason: string): Promise<void> {
		this._pauseReasons.delete(reason || 'paused');
		if (this._pauseReasons.size > 0 || this._resuming) return Promise.resolve();
		if (!this.host.isViewMounted || !this.host.isViewMounted()) return Promise.resolve();
		var self = this;
		this._resuming = true;
		return Promise.resolve()
			.then(function () {
				self.drainBgTaskQueue();
				return self.loadHistory(false, self.state.gateRefreshToken);
			})
			.catch(function (e: any) { console.error('[chat-engine] resume polling failed', e); })
			.then(function () { self._resuming = false; });
	}

	private _newLocalId(): string {
		this._lidSeq += 1;
		return 'lid_' + this._lidSeq;
	}

	getHistoryCacheKey(): string {
		var id = this.host.getIdentity();
		if (!id.serviceId || id.platform === 'none') return '';
		return id.serviceId + '#' + id.platform;
	}

	updateHistoryCache(): void {
		var key = this.getHistoryCacheKey();
		if (!key) return;
		// Never persist another chat's in-flight bubbles under THIS key. The
		// dashboard shares one ChatSession across projects, so a turn dispatched
		// in project A can still be sitting in state.messages while the identity
		// (and therefore `key`) already points at project B — without this filter
		// A's user + "Thinking..." bubbles get written into B's cache entry and
		// replay on every later visit to B. Bubbles with no _ownerKey (server
		// history, bg tasks) are always kept. Single pass: this runs on the
		// typewriter hot path.
		this.aiChatHistoryCache[key] = {
			messages: this.state.messages.filter(function (m) {
				return m._ownerKey === undefined || m._ownerKey === key;
			}),
			endOfList: this.state.historyEndOfList,
			startKeyHistory: this.state.historyStartKeyHistory.slice(),
		};
	}

	/**
	 * Land a resolved reply in the history cache of a chat that is NOT currently
	 * visible, without touching state.messages. Mirrors the cache-only path in
	 * dispatchAgentRequest: REPLACE the trailing pending "Thinking..." bubble
	 * (append only when there is none), and settle the matching pending user
	 * bubble, so the cached copy never keeps a stuck "Thinking..." that a later
	 * cache-first load would re-render forever.
	 */
	private _applyReplyToCache(key: string, reply: ChatMessage, serverId?: string): void {
		if (!key) return;
		var existing = this.aiChatHistoryCache[key] || { messages: [], endOfList: false, startKeyHistory: [] };
		var msgs = existing.messages.slice();

		var thIdx = -1;
		for (var i = msgs.length - 1; i >= 0; i--) {
			var m = msgs[i];
			if (!m || !m.isPending || m.role !== 'assistant' || m.isBackgroundTask) continue;
			if (serverId && m._serverItemId && m._serverItemId !== serverId) continue;
			thIdx = i; break;
		}
		if (thIdx !== -1) {
			if (reply._serverItemId === undefined && msgs[thIdx]._serverItemId !== undefined) reply._serverItemId = msgs[thIdx]._serverItemId;
			msgs[thIdx] = reply;
		} else {
			// No pending placeholder left to replace. Before appending, check whether
			// this turn is ALREADY in the cache — a history fetch may have mapped the
			// resolved turn in while the reply was in flight. Appending blindly is how
			// one turn ended up rendered twice (the duplicated question+answer): the
			// cache is restored verbatim on the next mount, so a duplicate written
			// here survives every later visit.
			var dupIdx = -1;
			if (serverId) {
				for (var d = msgs.length - 1; d >= 0; d--) {
					var dm = msgs[d];
					if (dm && dm.role === 'assistant' && dm._serverItemId === serverId) { dupIdx = d; break; }
				}
			}
			if (dupIdx !== -1) msgs[dupIdx] = reply;
			else msgs.push(reply);
		}

		// Settle the user bubble this turn belongs to (first pending one, or the
		// one carrying serverId) so it stops rendering as still in flight.
		for (var j = 0; j < msgs.length; j++) {
			var u = msgs[j];
			if (!u || u.role !== 'user' || u.isBackgroundTask) continue;
			if (!(u.isPendingQueued || u.isPendingInProcess || u.isSendingToServer)) continue;
			if (serverId && u._serverItemId && u._serverItemId !== serverId) continue;
			var settled: ChatMessage = { role: 'user', content: u.content };
			if (u._serverItemId !== undefined) settled._serverItemId = u._serverItemId;
			if (u._ownerKey !== undefined) settled._ownerKey = u._ownerKey;
			msgs[j] = settled;
			break;
		}

		this.aiChatHistoryCache[key] = {
			messages: msgs,
			endOfList: existing.endOfList,
			startKeyHistory: existing.startKeyHistory,
		};
	}

	/**
	 * serviceId/owner are passed explicitly by every caller: a request can be
	 * dispatched after the user moved to another project, and re-reading the live
	 * identity here would silently send the turn to THAT project instead of the
	 * one it was composed for. Falls back to the live read only when a caller
	 * omits them.
	 */
	private _callProviderFor(platform: string, prompt: string, messages: any, system: string, model: string | undefined, userId: string, extractContent: any, fileUrls?: any, serviceId?: string, owner?: string) {
		if (serviceId === undefined || owner === undefined) {
			var id = this.host.getIdentity();
			if (serviceId === undefined) serviceId = id.serviceId;
			if (owner === undefined) owner = id.owner;
		}
		return platform === 'openai'
			? callOpenAIWithPublicMcp(prompt, serviceId, owner, messages, system, model, userId, extractContent, fileUrls)
			: callClaudeWithPublicMcp(prompt, serviceId, owner, messages, system, model, userId, extractContent, fileUrls);
	}

	dispatchAgentRequest(params: any) {
		var self = this;
		// Id of the in-flight item this dispatch polls. Recorded in
		// historyItemPolls (set below, deleted when the dispatch settles) so a
		// remount / history refetch dedups against THIS poll instead of stacking
		// a duplicate history poll on the same item. (The cacheKey guard alone
		// stops covering an item once pendingAgentRequests clears — e.g. a queued
		// message still in flight after the immediate one resolved.)
		var dispatchItemId: string | undefined;
		var sendAndPoll = function () {
			return Promise.resolve(
				self._callProviderFor(params.aiPlatform, params.text, params.boundedMessages, params.systemPrompt, params.aiModel, params.userId, params.extractContent, params.fileUrls, params.serviceId, params.owner)
			).then(function (initial: any) {
				if (initial && initial.poll && (initial.status === 'pending' || initial.status === 'running')) {
					if (initial.id) {
						if (dispatchItemId && dispatchItemId !== initial.id) self.historyItemPolls.delete(dispatchItemId);
						dispatchItemId = initial.id;
					}
					var dp = initial.poll({ latency: POLL_INTERVAL });
					if (initial.id) self._trackPoll(initial.id, 'fg', dp);
					return dp;
				}
				return initial;
			});
		};
		var run = sendAndPoll()
			.catch(function (err: any) {
				// Only auth-expiry is worth a refresh+resend; a malformed-request 400
				// (e.g. the `_skapi_extract`/unknown-parameter class) re-fails identically,
				// so never loop on it — guard against isAuthExpiredError's heuristic
				// misfiring on a param name that merely contains "token".
				if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(sendAndPoll);
				throw err;
			})
			.then(function (response: any) {
				if (isErrorResponseBody(response) && isAuthExpiredError(response) && !isNonRetryableRequestError(response)) {
					return self.host.refreshSession().then(sendAndPoll);
				}
				return response;
			})
			.then(function (response: any) {
				if (isErrorResponseBody(response)) return { content: getErrorMessage(response), isError: true };
				var answer = (params.aiPlatform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response));
				answer = (answer || '').trim();
				return { content: answer || 'No text response received from AI provider.', isError: false };
			})
			.catch(function (err: any) { return { content: getErrorMessage(err), isError: true }; })
			.then(function (result: any) {
				// Land the resolved reply in the shared history cache. This runs
				// independently of the view lifecycle, so a reply is captured even
				// if the chatbox unmounted mid-request.
				delete self.pendingAgentRequests[params.key];
				if (dispatchItemId) self.historyItemPolls.delete(dispatchItemId);
				var existing = self.aiChatHistoryCache[params.key] || { messages: [], endOfList: false, startKeyHistory: [] };
				var reply: ChatMessage = { role: 'assistant', content: result.content, isError: result.isError };

				// REPLACE the trailing pending "Thinking..." bubble in the cache with
				// the answer (falling back to append when none is present), regardless
				// of whether this chat is the currently-visible view. The cache must
				// NEVER retain a pending "Thinking..." bubble: even when the chatbox is
				// showing this chat, typewriteLatestReply swaps the bubble only in
				// state.messages and NEVER re-snapshots the cache — so appending a
				// duplicate here would leave the cached copy stuck pending, and a later
				// cache-first remount (agent.vue's loadChatHistory) would re-render that
				// "Thinking..." forever. typewriteLatestReply still finds this reply (it
				// reads the latest non-pending assistant from the cache), so replacing is
				// correct for the visible case too. The next fresh history fetch
				// reconciles it either way.
				var msgs = existing.messages.slice();
				var idx = -1;
				for (var i = msgs.length - 1; i >= 0; i--) {
					var m = msgs[i];
					if (m && m.isPending && m.role === 'assistant' && !m.isBackgroundTask) { idx = i; break; }
				}
				if (idx !== -1) {
					reply._serverItemId = msgs[idx]._serverItemId;
					msgs[idx] = reply;
				} else {
					msgs.push(reply);
				}
				self.aiChatHistoryCache[params.key] = {
					messages: msgs,
					endOfList: existing.endOfList,
					startKeyHistory: existing.startKeyHistory,
				};
				return result;
			});
		this.pendingAgentRequests[params.key] = run;
		return run;
	}

	// composed = clean display text; composedForLlm carries office-extraction
	// placeholders for the provider only. useBgQueue routes a post-attachment turn
	// onto the "-bg" queue so it runs after indexing.
	dispatchComposedMessage(composed: string, useBgQueue?: boolean, composedForLlm?: string, extractContent?: any, fileUrls?: any, pinned?: PinnedDispatchContext): void {
		var self = this;
		if (!composed) return;
		// A send can be dispatched LONG after the user hit Send (attachment
		// uploads are awaited first), by which time the live identity may have
		// moved to another project. The caller pins the identity + system prompt
		// it captured at Send time so the request still goes to the project the
		// question was actually asked of. Falls back to the live read when the
		// caller doesn't pin (the widget, which has only one project anyway).
		var id = pinned ? pinned.identity : this.host.getIdentity();
		if (id.platform === 'none') return;

		var llmComposed = composedForLlm || composed;

		// Cache key of the chat this turn belongs to. Every locally-created
		// bubble is stamped with it so a project switch (which flips
		// getIdentity()/getHistoryCacheKey() to the new project) can't
		// misattribute this turn's bubbles to that project.
		// (platform === 'none' already returned above, so serviceId is the only gate)
		var key = !id.serviceId ? '' : id.serviceId + '#' + id.platform;
		// True when the pinned chat is NOT the one currently on screen. Then
		// state.messages belongs to a different project and MUST NOT be touched:
		// the turn is staged in the pinned chat's cache instead and shows up when
		// the user navigates back to it.
		var offChat = !!key && key !== this.getHistoryCacheKey();

		var isQueuedSend = !offChat && (useBgQueue || this.state.sending || this.state.messages.some(function (m) {
			return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue;
		}));

		var aiPlatform = id.platform;
		var aiModel = id.model || undefined;
		var systemPrompt = pinned ? pinned.systemPrompt : this.host.buildSystemPrompt();
		var userId = id.userId || id.serviceId;
		var chatQueue = useBgQueue ? userId + BG_INDEXING_QUEUE_SUFFIX : userId;

		if (offChat) {
			// Stage the turn in the pinned chat's cache and dispatch. The
			// client-side queue can't be consulted (its state is the other
			// project's), but the SERVER serializes per queue name, so ordering
			// within the pinned chat still holds. dispatchAgentRequest replaces
			// the pending bubble in this same cache entry when the reply lands.
			var offHistory = (this.aiChatHistoryCache[key] ? this.aiChatHistoryCache[key].messages : []).filter(function (m) {
				return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder &&
					!m.isCancelled && !m.isBackgroundTask;
			});
			var offBounded = buildBoundedChatMessages({
				platform: aiPlatform, model: aiModel, systemPrompt: systemPrompt, serviceId: id.serviceId,
				history: offHistory.concat([{ role: 'user', content: llmComposed }]),
			});
			var offExisting = this.aiChatHistoryCache[key] || { messages: [], endOfList: false, startKeyHistory: [] };
			this.aiChatHistoryCache[key] = {
				messages: offExisting.messages.concat([
					{ role: 'user', content: composed, _ownerKey: key },
					{ role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _ownerKey: key },
				]),
				endOfList: offExisting.endOfList,
				startKeyHistory: offExisting.startKeyHistory,
			};
			this.dispatchAgentRequest({
				key: key, serviceId: id.serviceId, owner: id.owner, aiPlatform: aiPlatform, aiModel: aiModel,
				systemPrompt: systemPrompt, text: composed, boundedMessages: offBounded.messages, userId: chatQueue,
				extractContent: extractContent, fileUrls: fileUrls,
			});
			return;
		}

		if (isQueuedSend) {
			var resolvedHistory = this.state.messages.filter(function (m) {
				return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder &&
					!m.isCancelled && !m.isBackgroundTask;
			});
			var boundedQ = buildBoundedChatMessages({
				platform: aiPlatform, model: aiModel, systemPrompt: systemPrompt, serviceId: id.serviceId,
				history: resolvedHistory.concat([{ role: 'user', content: llmComposed }]),
			});
			var queuedBubble: ChatMessage = { role: 'user', content: composed, isPendingQueued: true, isSendingToServer: true };
			if (key) queuedBubble._ownerKey = key;
			if (useBgQueue) queuedBubble._useBgQueue = true;
			this.state.messages.push(queuedBubble);
			this.host.notify(); this.updateHistoryCache(); this.host.scrollToBottom(true);

			var capturedComposed = composed, capturedPlatform = aiPlatform, capturedKey = key;
			Promise.resolve(this._callProviderFor(aiPlatform, composed, boundedQ.messages, systemPrompt, aiModel, chatQueue, extractContent, fileUrls, id.serviceId, id.owner))
				.then(function (result: any) {
					// Only ack a bubble that belongs to THIS chat — the search is
					// positional, so on another project it would stamp this turn's
					// _serverItemId onto that project's unrelated in-flight bubble.
					var sendingIdx = self.getHistoryCacheKey() !== capturedKey ? -1 : self.state.messages.findIndex(function (m) {
						return m.isSendingToServer && (m.isPendingQueued || m.isPendingInProcess) && m.role === 'user' &&
							(m._ownerKey === undefined || m._ownerKey === capturedKey);
					});
					var serverId = result && typeof result.id === 'string' ? result.id : undefined;
					if (sendingIdx >= 0) {
						var upd = Object.assign({}, self.state.messages[sendingIdx], { isSendingToServer: false });
						if (serverId) upd._serverItemId = serverId;
						self.state.messages[sendingIdx] = upd; self.host.notify();
					}
					if (result && result.poll && (result.status === 'pending' || result.status === 'running')) {
						// Track this queued item's poll so a remount/refetch dedups
						// against it instead of attaching a duplicate history poll.
						var qp = result.poll({ latency: POLL_INTERVAL });
						if (serverId) self._trackPoll(serverId, 'fg', qp);
						return qp
							.then(function (res: any) { if (isPollStopped(res)) return; return self.onQueuedSendResponse(capturedComposed, res, capturedPlatform, serverId, capturedKey); })
							.catch(function (err: any) { return self.onQueuedSendError(capturedComposed, err, serverId, capturedKey); });
					}
					return self.onQueuedSendResponse(capturedComposed, result, capturedPlatform, serverId, capturedKey);
				})
				.catch(function (err: any) { return self.onQueuedSendError(capturedComposed, err, undefined, capturedKey); });
			return;
		}

		// immediate send — cache+resume model (mirrors agent.vue). The reply is
		// appended to aiChatHistoryCache by dispatchAgentRequest (so it survives a
		// view unmount), then rendered from the cache via typewriteLatestReply. A
		// later resumePendingRequest() re-renders it if the view remounted while the
		// request was still in flight.
		this.state.messages.push({ role: 'user', content: composed, ...(key ? { _ownerKey: key } : {}) });
		this.state.messages.push({ role: 'assistant', content: '', isPending: true, isPendingInProcess: true, ...(key ? { _ownerKey: key } : {}) });
		this.host.notify(); this.updateHistoryCache(); this.state.sending = true; this.host.scrollToBottom(true);

		var historyForLlm = this.state.messages.filter(function (m) { return !m.isCancelled && !m.isBackgroundTask; });
		if (llmComposed !== composed) {
			for (var li = historyForLlm.length - 1; li >= 0; li--) {
				if (historyForLlm[li].role === 'user' && historyForLlm[li].content === composed) {
					historyForLlm[li] = Object.assign({}, historyForLlm[li], { content: llmComposed });
					break;
				}
			}
		}
		var bounded = buildBoundedChatMessages({
			platform: aiPlatform, model: aiModel, systemPrompt: systemPrompt, serviceId: id.serviceId,
			history: historyForLlm,
		});
		var run = this.dispatchAgentRequest({
			key: key, serviceId: id.serviceId, owner: id.owner, aiPlatform: aiPlatform, aiModel: aiModel,
			systemPrompt: systemPrompt, text: composed, boundedMessages: bounded.messages, userId: chatQueue,
			extractContent: extractContent, fileUrls: fileUrls,
		});
		// Render the reply into the "Thinking..." bubble whenever the chatbox is
		// CURRENTLY showing this chat — even after an unmount/remount. The old
		// guard bailed on `requestToken !== gateRefreshToken`, but EVERY remount
		// bumps gateRefreshToken (refreshGate), so a request that finished after
		// the user navigated away and back left a stuck "Thinking..." (no view
		// typewriter ever ran, and resumePendingRequest bails when a pending
		// bubble is already present). Gate on "is this the visible chat" instead.
		// When it ISN'T (unmounted / another project), dispatchAgentRequest has
		// already replaced the pending bubble with the answer IN THE CACHE, so a
		// later loadChatHistory renders it.
		Promise.resolve(run).catch(function () { }).then(function () {
			// Clear `sending` UNCONDITIONALLY. It is session-global (it gates
			// isQueuedSend above, plus the platform/model pickers in the view), so
			// leaving it set when the user navigated to another project wedged
			// every subsequent send in EVERY project onto the queued path and kept
			// the view's user-bubble rescue arm armed forever. Only the RENDER of
			// the reply stays gated on still showing this chat — when it isn't,
			// dispatchAgentRequest has already written the answer into the cache
			// under `key`, so a later loadChatHistory renders it.
			self.state.sending = false;
			if (!(self.host.isViewMounted() && self.getHistoryCacheKey() === key)) return;
			return Promise.resolve(self.typewriteLatestReply(key)).then(function () { self.host.scrollToBottomIfSticky(true); });
		});
	}

	promoteNextBgQueuedToRunning(): void {
		if (this.state.messages.some(function (m) { return m.isPending && m.role === 'assistant' && m.isBackgroundTask; })) return;
		var nextIdx = this.state.messages.findIndex(function (m) {
			return m.isPendingQueued && m.role === 'user' && m.isBackgroundTask;
		});
		if (nextIdx === -1) return;
		var existing = this.state.messages[nextIdx];
		var promoted: ChatMessage = { role: 'user', content: existing.content, isPendingInProcess: true, isBackgroundTask: true };
		if (existing._indexFile) promoted._indexFile = existing._indexFile;
		if (existing._serverItemId !== undefined) promoted._serverItemId = existing._serverItemId;
		if (existing._ownerKey !== undefined) promoted._ownerKey = existing._ownerKey;
		this.state.messages[nextIdx] = promoted;
		var placeholder: ChatMessage = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, isBackgroundTask: true };
		if (existing._serverItemId !== undefined) placeholder._serverItemId = existing._serverItemId;
		if (existing._ownerKey !== undefined) placeholder._ownerKey = existing._ownerKey;
		this.state.messages.splice(nextIdx + 1, 0, placeholder);
		this.host.notify();
	}

	promoteNextQueuedToRunning(): void {
		if (this.state.messages.some(function (m) { return m.isPending && m.role === 'assistant' && !m.isBackgroundTask; })) return;
		var nextIdx = this.state.messages.findIndex(function (m) {
			return m.isPendingQueued && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue;
		});
		if (nextIdx === -1) return;
		var existing = this.state.messages[nextIdx];
		var promoted: ChatMessage = { role: 'user', content: existing.content, isPendingInProcess: true };
		if (existing.isBackgroundTask) promoted.isBackgroundTask = true;
		if (existing._indexFile) promoted._indexFile = existing._indexFile;
		if (existing._serverItemId !== undefined) promoted._serverItemId = existing._serverItemId;
		if (existing._ownerKey !== undefined) promoted._ownerKey = existing._ownerKey;
		if (existing.isSendingToServer) promoted.isSendingToServer = true;
		this.state.messages[nextIdx] = promoted;
		// Carry the promoted turn's _serverItemId onto the "Thinking..." placeholder
		// (mirrors promoteNextBgQueuedToRunning). Without it, when this promoted turn
		// is resolved via the history-poll path — applyHistoryItemResolution, which
		// matches the pending assistant by _serverItemId — the placeholder is not
		// found, so the reply is spliced in BESIDE it and the "Thinking..." is
		// stranded forever (e.g. after a reload, or when a cancel advances the queue).
		// onQueuedSendResponse still finds it by position, so the queued-send path is
		// unaffected.
		var placeholder: ChatMessage = { role: 'assistant', content: '', isPending: true };
		if (existing._serverItemId !== undefined) placeholder._serverItemId = existing._serverItemId;
		if (existing._ownerKey !== undefined) placeholder._ownerKey = existing._ownerKey;
		this.state.messages.splice(nextIdx + 1, 0, placeholder);
		this.host.notify();
	}

	resolveQueuedUserBubble(serverId?: string): number | undefined {
		// The two fallbacks below match by POSITION, not identity, so they must
		// never consider a bubble stamped for a different chat.
		var liveKey = this.getHistoryCacheKey();
		var isLocal = function (m: ChatMessage) { return m._ownerKey === undefined || m._ownerKey === liveKey; };
		var userIdx = -1;
		if (serverId) {
			userIdx = this.state.messages.findIndex(function (m) {
				return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) &&
					m.role === 'user' && !m.isBackgroundTask;
			});
		}
		if (userIdx === -1) {
			userIdx = this.state.messages.findIndex(function (m) {
				return m.isPendingInProcess && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue && isLocal(m);
			});
		}
		if (userIdx === -1) {
			userIdx = this.state.messages.findIndex(function (m) {
				return m.isPendingQueued && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue && isLocal(m);
			});
		}
		if (serverId && this.cancelledServerIds.has(serverId)) {
			this.cancelledServerIds.delete(serverId);
			if (userIdx >= 0) {
				var ex = this.state.messages[userIdx];
				this.state.messages[userIdx] = { role: 'user', content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId, ...(ex._ownerKey !== undefined ? { _ownerKey: ex._ownerKey } : {}) };
				var thIdx = this.state.messages.findIndex(function (m, i) {
					return i > userIdx && m.isPending && m.role === 'assistant' && !m.isBackgroundTask;
				});
				if (thIdx !== -1) this.state.messages.splice(thIdx, 1);
			}
			this.promoteNextQueuedToRunning();
			return undefined;
		}
		if (userIdx >= 0) {
			var exist = this.state.messages[userIdx];
			var repl: ChatMessage = { role: 'user', content: exist.content };
			if (exist._serverItemId !== undefined) repl._serverItemId = exist._serverItemId;
			if (exist._ownerKey !== undefined) repl._ownerKey = exist._ownerKey;
			this.state.messages[userIdx] = repl;
		}
		var thinkingIdx = userIdx >= 0
			? this.state.messages.findIndex(function (m, i) { return i > userIdx && m.isPending && m.role === 'assistant' && !m.isBackgroundTask; })
			: -1;
		return thinkingIdx !== -1 ? thinkingIdx : (userIdx >= 0 ? userIdx + 1 : -1);
	}

	insertAtTarget(msg: ChatMessage, targetIdx: number): void {
		if (targetIdx >= 0 && this.state.messages[targetIdx] && this.state.messages[targetIdx].isPending) this.state.messages[targetIdx] = msg;
		else if (targetIdx >= 0) this.state.messages.splice(targetIdx, 0, msg);
		else this.state.messages.push(msg);
	}

	onQueuedSendResponse(_composed: string, response: any, platform: string, serverId?: string, ownerKey?: string): void {
		if (serverId) this.historyItemPolls.delete(serverId);
		// This turn resolved while a DIFFERENT chat is on screen (the user moved to
		// another project mid-flight). state.messages now belongs to that chat, and
		// resolveQueuedUserBubble's positional fallbacks would happily hijack ITS
		// pending bubble — or, finding nothing, push this answer onto its list.
		// Settle in the owning chat's cache instead and leave the view untouched.
		if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
			var offReply: ChatMessage = isErrorResponseBody(response)
				? { role: 'assistant', content: getErrorMessage(response), isError: true }
				: { role: 'assistant', content: ((platform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response)) || '').trim() || 'No text response received from AI provider.' };
			this._applyReplyToCache(ownerKey, offReply, serverId);
			if (serverId) this.cancelledServerIds.delete(serverId);
			return;
		}
		var targetIdx = this.resolveQueuedUserBubble(serverId);
		if (targetIdx === undefined) { this.host.notify(); this.updateHistoryCache(); return; }
		if (isErrorResponseBody(response)) {
			this.insertAtTarget({ role: 'assistant', content: getErrorMessage(response), isError: true }, targetIdx);
		} else {
			var answer = (platform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response));
			answer = (answer || '').trim() || 'No text response received from AI provider.';
			var lid = this._newLocalId();
			if (targetIdx >= 0 && this.state.messages[targetIdx] && this.state.messages[targetIdx].isPending) {
				this.state.messages[targetIdx] = { role: 'assistant', content: '', _localId: lid };
				this.host.notify(); this.enqueueTypewrite(targetIdx, answer, lid);
			} else if (targetIdx >= 0) {
				this.state.messages.splice(targetIdx, 0, { role: 'assistant', content: '', _localId: lid });
				this.host.notify(); this.enqueueTypewrite(targetIdx, answer, lid);
			} else {
				var aiIdx = this.state.messages.length;
				this.state.messages.push({ role: 'assistant', content: '', _localId: lid });
				this.host.notify(); this.enqueueTypewrite(aiIdx, answer, lid);
			}
		}
		this._removeStrayPendingAssistants();
		this.promoteNextQueuedToRunning();
		this.updateHistoryCache();
		this.host.notify();
		// ARRIVAL, not a user action: only follow if the user is still pinned to
		// the bottom. Scrolled-up readers keep their position.
		this.host.scrollToBottomIfSticky(true);
	}

	onQueuedSendError(_composed: string, err: any, serverId?: string, ownerKey?: string): void {
		var self = this;
		if (serverId) this.historyItemPolls.delete(serverId);
		// Off-chat resolution — see onQueuedSendResponse. Settle in the owning
		// chat's cache rather than mutating whatever chat is on screen now.
		if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
			var isGone = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
			this._applyReplyToCache(ownerKey, isGone
				? { role: 'assistant', content: 'Request was cancelled.', isError: true }
				: { role: 'assistant', content: getErrorMessage(err), isError: true }, serverId);
			if (serverId) this.cancelledServerIds.delete(serverId);
			return;
		}
		var isNotExists = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
		if (isNotExists) {
			var userIdx = serverId
				? this.state.messages.findIndex(function (m) { return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) && m.role === 'user' && !m.isBackgroundTask; })
				: this.state.messages.findIndex(function (m) { return m.isPendingInProcess && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue; });
			if (!serverId && userIdx === -1) {
				userIdx = this.state.messages.findIndex(function (m) { return m.isPendingQueued && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue; });
			}
			if (userIdx >= 0) {
				var ex = this.state.messages[userIdx];
				var repl: ChatMessage = { role: 'user', content: ex.content, isCancelled: true };
				if (ex._serverItemId !== undefined) repl._serverItemId = ex._serverItemId;
				this.state.messages[userIdx] = repl;
			}
			if (serverId) {
				var thById = this.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.isPending && m.role === 'assistant' && !m.isBackgroundTask; });
				if (thById !== -1) this.state.messages.splice(thById, 1);
				else if (userIdx >= 0) {
					var thPos = this.state.messages.findIndex(function (m, i) { return i > userIdx && m.isPending && m.role === 'assistant' && !m.isBackgroundTask; });
					if (thPos !== -1) this.state.messages.splice(thPos, 1);
				}
			} else if (userIdx >= 0) {
				var thPos2 = this.state.messages.findIndex(function (m, i) { return i > userIdx && m.isPending && m.role === 'assistant' && !m.isBackgroundTask; });
				if (thPos2 !== -1) this.state.messages.splice(thPos2, 1);
			}
			if (serverId) this.cancelledServerIds.delete(serverId);
			this._removeStrayPendingAssistants();
			this.promoteNextQueuedToRunning(); this.updateHistoryCache(); this.host.notify(); this.host.scrollToBottomIfSticky(true);
			return;
		}
		var targetIdx = this.resolveQueuedUserBubble(serverId);
		if (targetIdx === undefined) { this.host.notify(); this.updateHistoryCache(); return; }
		this.insertAtTarget({ role: 'assistant', content: getErrorMessage(err), isError: true }, targetIdx);
		this._removeStrayPendingAssistants();
		this.promoteNextQueuedToRunning(); this.updateHistoryCache(); this.host.notify(); this.host.scrollToBottomIfSticky(true);
	}

	cancelQueuedMessage(msg: ChatMessage, idx: number): void {
		var self = this;
		var id = this.host.getIdentity();
		var serverId = msg._serverItemId;
		if (!serverId || msg._cancelling) return;
		var platform = id.platform;
		if (platform !== 'claude' && platform !== 'openai') return;
		var url = platform === 'claude' ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
		var queueBase = id.userId || id.serviceId;
		var queue = (msg.isBackgroundTask || msg._useBgQueue) ? queueBase + BG_INDEXING_QUEUE_SUFFIX : queueBase;
		this.state.messages[idx] = Object.assign({}, msg, { _cancelling: true, _cancelError: undefined });
		this.host.notify();
		Promise.resolve(this.host.cancelRequest({
			url: url, method: 'POST', id: serverId, queue: queue, service: id.serviceId, owner: id.owner,
		})).then(function (result: any) {
			if (result && result.removed) {
				self.cancelledServerIds.add(serverId as string);
				self._stopPoll(serverId as string);
				var qi = self.bgTaskQueue.findIndex(function (e) { return e.id === serverId; });
				if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
				var removeIdx = self.state.messages.findIndex(function (m) {
					return m._serverItemId === serverId && (m.isPendingQueued || m.isPendingInProcess) && m.role === 'user';
				});
				if (removeIdx !== -1) {
					// Carry the background/file markers onto the rebuild. Dropping them
					// took a cancelled INDEXING pass out of its file's collapsed row
					// (buildChatDisplayList only groups isBackgroundTask bubbles), so the
					// row stayed "Indexing…" forever while a bare "Indexing: file" bubble
					// appeared beside it.
					var wasMsg = self.state.messages[removeIdx];
					var cancelledMsg: ChatMessage = { role: 'user', content: wasMsg.content, isCancelled: true, _serverItemId: serverId };
					if (wasMsg.isBackgroundTask) cancelledMsg.isBackgroundTask = true;
					if (wasMsg._indexFile) cancelledMsg._indexFile = wasMsg._indexFile;
					if (wasMsg._useBgQueue) cancelledMsg._useBgQueue = true;
					if (wasMsg._ownerKey !== undefined) cancelledMsg._ownerKey = wasMsg._ownerKey;
					self.state.messages[removeIdx] = cancelledMsg;
					var thById = self.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.isPending && m.role === 'assistant'; });
					if (thById !== -1) self.state.messages.splice(thById, 1);
					else {
						var thPos = self.state.messages.findIndex(function (m, i) {
							return i > removeIdx && m.isPending && m.role === 'assistant' &&
								(msg.isBackgroundTask ? !!m.isBackgroundTask : !m.isBackgroundTask);
						});
						if (thPos !== -1) self.state.messages.splice(thPos, 1);
					}
					if (msg.isBackgroundTask) self.promoteNextBgQueuedToRunning(); else self.promoteNextQueuedToRunning();
					self.updateHistoryCache();
				}
				self.host.notify();
			} else {
				var errMsg = result && typeof result.message === 'string' && result.message ? result.message : 'Could not remove from queue.';
				var ci = self.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.role === 'user'; });
				if (ci !== -1) { self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg }); self.host.notify(); }
			}
		}).catch(function (err: any) {
			var errMsg = err && typeof err.message === 'string' && err.message ? err.message : 'Could not remove from queue.';
			var ci = self.state.messages.findIndex(function (m) { return m._serverItemId === serverId && m.role === 'user'; });
			if (ci !== -1) { self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg }); self.host.notify(); }
		});
	}

	/**
	 * Stop indexing a file, from its collapsed row — every pass at once, not just
	 * the bubble the user happens to see.
	 *
	 * A big file is indexed as a CHAIN of passes, so cancelling only the live one
	 * accomplishes nothing: the next pass is dispatched as soon as it settles.
	 * Three things end the chain:
	 *   1. every queued/running pass of this file is cancelled server-side
	 *      (csr-cancel deletes a queued row and flags a running one "cancelled",
	 *      which is also the worker's gate for NOT enqueueing the next window);
	 *   2. the file is remembered in cancelledIndexKeys, so the client-driven
	 *      resume (maybeResumeIndexing) stops dispatching CONTINUE passes; and
	 *   3. any of its passes still sitting in bgTaskQueue is dropped by the next
	 *      drain rather than surfacing a fresh "Indexing…" bubble.
	 *
	 * Records already written by the passes that DID run are kept — this stops the
	 * work, it does not undo it.
	 */
	cancelIndexingGroup(group: IndexingGroup): void {
		var self = this;
		if (!group || !group.key) return;
		// The group belongs to the chat on screen, so scope its key the same way
		// _indexKeyOf scopes a queued task's.
		var scoped = this.getHistoryCacheKey() + '|' + group.key;
		this.cancelledIndexKeys.add(scoped);
		var ids = group.cancellableIds || [];
		if (!ids.length) { this.host.notify(); return; }
		ids.forEach(function (serverId) {
			// Address the message by IDENTITY, not by the index captured when the
			// display list was built: an earlier cancel in this same loop may already
			// have spliced the array (a group can have more than one live pass), and a
			// stale index would mark the WRONG bubble as cancelling.
			var idx = self.state.messages.findIndex(function (m) {
				return m._serverItemId === serverId && m.role === 'user' &&
					(m.isPendingQueued || m.isPendingInProcess);
			});
			if (idx === -1) return;
			self.cancelQueuedMessage(self.state.messages[idx], idx);
		});
	}

	// --- typewriter -------------------------------------------------------
	// Reveal `fullText` into a message bubble at a constant wall-clock RATE
	// (chars/second) driven by requestAnimationFrame, rather than a fixed number
	// of characters per fixed-delay tick. This is what keeps typing smooth and
	// cheap on slow machines:
	//
	//   * Each frame reveals `elapsed_ms * CHARS_PER_SEC` characters, so the
	//     visual speed is the same regardless of how long a frame actually took.
	//   * As the bubble's markdown grows, each re-render gets more expensive, so
	//     frames get longer — which makes each frame reveal MORE characters and
	//     therefore do FEWER, larger renders. That converts the old O(n^2)
	//     "re-render the whole growing string once per 3 characters" (which got
	//     slower and slower and pegged the CPU) into roughly O(n): the number of
	//     renders self-throttles to what the machine can actually paint.
	//   * rAF paces us to the browser's paint cycle and pauses in background
	//     tabs, so we never queue work faster than it can be drawn.
	typewriteIntoIndex(idx: number, fullText: string, localId?: string): Promise<void> {
		var self = this;
		if (!fullText) return Promise.resolve();

		var CHARS_PER_SEC = 300;   // reveal rate (was ~188 = 3 chars / 16ms) — a bit faster
		var MIN_STEP = 1;          // always make progress, even on a sub-ms frame
		var MAX_FRAME_MS = 1000;   // cap catch-up after a long stall / backgrounded tab

		// Atomic regions that must never be left half-revealed: file fences
		// (shown as a download chip / hidden as "[generating …]" while unclosed —
		// and potentially huge, so revealed in one jump) and inline links
		// (a partial link is broken markdown). If a frame's reveal boundary lands
		// inside one, snap it to the region end so the chip/link appears whole.
		var regions: Array<{ start: number; end: number }> = [], m;
		var fenceRegex = /```[^\n`]+?\.[^\s.`]+\n[\s\S]*?```/g;
		while ((m = fenceRegex.exec(fullText)) !== null) regions.push({ start: m.index, end: m.index + m[0].length });
		var linkRegex = createInlineLinkRegex();
		while ((m = linkRegex.exec(fullText)) !== null) regions.push({ start: m.index, end: m.index + m[0].length });
		regions.sort(function (a, b) { return a.start - b.start; });

		this.state.typing = true; this.state.typingAbort = false;
		var i = 0;
		var last = nowMs();

		return new Promise<void>(function (resolve) {
			var done = false;
			var doc: any = _g.document;
			function isHidden(): boolean { return !!(doc && doc.hidden); }
			function cleanup(): void {
				if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
			}
			function finish(): void {
				if (done) return;
				done = true;
				cleanup();
				if (!self.state.typingAbort) {
					// Re-find the bubble by localId and, if it's gone, bail WITHOUT
					// writing — never fall back to the numeric idx, which a concurrent
					// array mutation may have repurposed for an unrelated message
					// (mirrors frame()'s currentIdx===-1 bail below).
					var fi = localId ? self.state.messages.findIndex(function (mm) { return mm._localId === localId; }) : idx;
					if (fi !== -1) {
						var t = self.state.messages[fi];
						if (t) { t.content = fullText; self.host.refreshMessageBubble(fi); }
					}
				}
				self.state.typing = false;
				resolve();
			}
			// requestAnimationFrame is PAUSED in a backgrounded tab (setTimeout only
			// throttles), so an rAF-driven reveal would freeze there — leaving a blank
			// bubble and stalling the sequential enqueueTypewrite queue until refocus.
			// When the page is (or becomes) hidden, skip the animation and show the
			// full text immediately so the queue keeps draining.
			function onVisibility(): void { if (isHidden()) finish(); }
			if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
			function frame(t: number): void {
				if (done) return;
				if (self.state.typingAbort || i >= fullText.length || isHidden()) { finish(); return; }

				var dt = t - last; last = t;
				if (!(dt > 0)) dt = 16;                       // first frame / clock glitch
				if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;
				var step = Math.round(dt * CHARS_PER_SEC / 1000);
				if (step < MIN_STEP) step = MIN_STEP;
				var next = Math.min(fullText.length, i + step);

				// Extend past any atomic region the newly-revealed span (i, next]
				// cuts into. Iterate to convergence so back-to-back regions (e.g. a
				// link right after a fence) are all revealed whole in one frame.
				for (var changed = true; changed;) {
					changed = false;
					for (var k = 0; k < regions.length; k++) {
						var r = regions[k];
						if (next > r.start && i < r.end && r.end > next) { next = r.end; changed = true; }
					}
				}
				if (next > fullText.length) next = fullText.length;
				i = next;

				var currentIdx = localId ? self.state.messages.findIndex(function (mm) { return mm._localId === localId; }) : idx;
				if (currentIdx === -1) { finish(); return; }
				var target = self.state.messages[currentIdx];
				if (!target) { finish(); return; }
				target.content = fullText.slice(0, i);
				self.host.refreshMessageBubble(currentIdx);
				self.host.scrollToBottomIfSticky();
				nextFrame(frame);
			}
			if (isHidden()) { finish(); return; }
			nextFrame(frame);
		});
	}

	private typewriterQueue: Promise<any> = Promise.resolve();
	enqueueTypewrite(idx: number, fullText: string, localId?: string): Promise<any> {
		var self = this;
		this.typewriterQueue = this.typewriterQueue.then(function () { return self.typewriteIntoIndex(idx, fullText, localId); });
		return this.typewriterQueue;
	}

	// --- cache+resume immediate-send rendering -----------------------------
	// Render the just-resolved reply (read from aiChatHistoryCache) into the
	// pending assistant bubble, character-by-character. Runs AFTER the reply is
	// already in the cache (dispatchAgentRequest appended it); errors are shown
	// instantly (no typing). Promotes the next queued message immediately so its
	// "Thinking…" bubble appears without waiting for this typewriter to finish.
	typewriteLatestReply(key: string): Promise<any> {
		var cached = this.aiChatHistoryCache[key];
		if (!cached || !cached.messages.length) return Promise.resolve();
		var latest: ChatMessage | undefined;
		for (var i = cached.messages.length - 1; i >= 0; i--) {
			var m = cached.messages[i];
			if (m.role === 'assistant' && !m.isPending) { latest = m; break; }
		}
		if (!latest) return Promise.resolve();
		var pendingIdx = this.state.messages.findIndex(function (mm) {
			return mm.isPending && mm.role === 'assistant' && !mm.isBackgroundTask;
		});
		if (pendingIdx === -1) return Promise.resolve();
		if (latest.isError || !latest.content) {
			this.state.messages[pendingIdx] = { role: 'assistant', content: latest.content || '', isError: !!latest.isError };
			this._removeStrayPendingAssistants();
			this.host.notify();
			this.promoteNextQueuedToRunning();
			return Promise.resolve();
		}
		var lid = this._newLocalId();
		this.state.messages[pendingIdx] = { role: 'assistant', content: '', isPending: false, _localId: lid };
		this._removeStrayPendingAssistants();
		this.host.notify();
		this.promoteNextQueuedToRunning();
		return this.enqueueTypewrite(pendingIdx, latest.content, lid);
	}

	// Remove any leftover non-background pending ("Thinking…") assistant bubbles.
	// There is normally at most ONE such bubble at a time (promoteNext* refuses to
	// add a second), so any extra is a duplicate — it appears when a concurrent
	// history refetch re-maps the still-"running" turn into a pending placeholder
	// (with a real _serverItemId) while the local pending bubble (no _serverItemId)
	// is rescued and re-appended (see loadHistory rescue below). Each resolve path
	// only replaces the FIRST pending bubble, so without this a stray "Thinking…"
	// survives next to the reply/error. MUST run AFTER the resolved bubble has been
	// made non-pending and BEFORE promoteNext*() (so a freshly-promoted Thinking,
	// which is added only once no pending assistant remains, is preserved).
	_removeStrayPendingAssistants(): void {
		for (var k = this.state.messages.length - 1; k >= 0; k--) {
			var m = this.state.messages[k];
			if (m.isPending && m.role === 'assistant' && !m.isBackgroundTask) this.state.messages.splice(k, 1);
		}
	}

	// Drop the pending flags on the resolved turn's USER bubble (preserving its
	// content + background-task marker). Needed because a bg "Indexing:" turn's user
	// bubble carries isPendingInProcess; leaving it set keeps the bubble visually
	// stuck and keeps its bgTaskQueue entry alive forever.
	_clearPendingUserBubble(itemId: string): void {
		var uIdx = this.state.messages.findIndex(function (m) {
			return m.role === 'user' && m._serverItemId === itemId &&
				(m.isPendingInProcess || m.isPendingQueued || m.isSendingToServer);
		});
		if (uIdx === -1) return;
		var u = this.state.messages[uIdx];
		var cleaned: ChatMessage = { role: 'user', content: u.content, _serverItemId: itemId };
		if (u.isBackgroundTask) cleaned.isBackgroundTask = true;
		// Carry the file ref: it is what keeps this pass in its file's collapsed
		// row (the label parser is only a fallback for older cached bubbles).
		if (u._indexFile) cleaned._indexFile = u._indexFile;
		this.state.messages[uIdx] = cleaned;
	}

	// If an immediate-send request for the current cache key is still in flight
	// (e.g. the view unmounted then remounted mid-request), show the sending
	// state, await it, then render the reply from the cache. Skipped when the
	// list already has its own pending/queued bubbles (those resolve via their
	// own polls). The displayed reply also lands via dispatchComposedMessage's
	// own finally if the view never unmounted — this is the remount recovery.
	resumePendingRequest(token: number): Promise<void> {
		var self = this;
		var key = this.getHistoryCacheKey();
		var pending = key ? this.pendingAgentRequests[key] : undefined;
		if (!pending) return Promise.resolve();
		if (this.state.messages.some(function (m) { return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue; })) return Promise.resolve();
		this.state.sending = true;
		this.host.scrollToBottomIfSticky(true);
		return Promise.resolve(pending).catch(function () { }).then(function () {
			if (token !== self.state.gateRefreshToken) return;
			self.state.sending = false;
			return Promise.resolve(self.typewriteLatestReply(key)).then(function () { self.host.scrollToBottomIfSticky(true); });
		});
	}

	// --- background-task resolution + drain -------------------------------
	handleHistoryItemResolution(itemId: string, response: any, platform: string): void {
		this.applyHistoryItemResolution(itemId, response, platform);
		this.promoteNextBgQueuedToRunning();
	}

	applyHistoryItemResolution(itemId: string, response: any, platform: string): void {
		this.historyItemPolls.delete(itemId);
		var isErr = isErrorResponseBody(response);
		var answer = isErr ? getErrorMessage(response)
			: ((platform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response)) || '').trim();
		// Hide the internal indexing-completion marker from the displayed summary.
		if (!isErr && answer) answer = answer.split(INDEXING_COMPLETE_MARKER).join('').trim();
		var idx = this.state.messages.findIndex(function (m) { return m.isPending && m._serverItemId === itemId; });
		if (idx !== -1) {
			// A bg "Indexing:" turn pushes a user bubble (isPendingInProcess) ALONGSIDE
			// the assistant Thinking; replacing only the assistant leaves that user
			// bubble stuck pending — and drainBgTaskQueue then never clears its queue
			// entry (its stillPending check stays true). Un-pend it here too.
			this._clearPendingUserBubble(itemId);
			// Carry isBackgroundTask onto the REPLACEMENT. These rebuilds are fresh
			// object literals, so anything not copied is lost — and dropping this flag
			// made a pass that resolved LIVE fall out of its file's collapsed row
			// (buildChatDisplayList only considers isBackgroundTask messages), while
			// the same pass rebuilt from history stayed grouped. That mismatch is the
			// "new indexing response renders outside the group" bug.
			var wasBgTask = !!this.state.messages[idx].isBackgroundTask;
			if (isErr) {
				this.state.messages[idx] = { role: 'assistant', content: answer, isError: true, _serverItemId: itemId };
				if (wasBgTask) this.state.messages[idx].isBackgroundTask = true;
				this.host.notify(); this.updateHistoryCache(); return;
			}
			var text = answer || 'No text response received from AI provider.';
			// A background-indexing reply is INSIDE a collapsed row: nothing of it is
			// on screen. Typewriting it anyway put it on the one shared, serial
			// typewriter queue, so the user's own next reply — which IS on screen —
			// lost its "Thinking..." spinner and sat as an EMPTY bubble for however
			// long the invisible indexing summary took to reveal (seconds per pass,
			// additive across files). It also held state.typing true for the whole
			// time, which disables the platform/model pickers and no-ops Clear
			// history, and ran a per-frame scroll for content nobody can see.
			// Write it straight in; expanding the row then shows it complete.
			if (wasBgTask) {
				this.state.messages[idx] = { role: 'assistant', content: text, isBackgroundTask: true, _serverItemId: itemId };
				this.host.notify(); this.updateHistoryCache(); return;
			}
			var lid = this._newLocalId();
			this.state.messages[idx] = { role: 'assistant', content: '', _localId: lid, _serverItemId: itemId };
			this.host.notify(); this.enqueueTypewrite(idx, text, lid);
			this.updateHistoryCache(); return;
		}
		var userIdx = this.state.messages.findIndex(function (m) {
			return m.role === 'user' && m._serverItemId === itemId && (m.isPendingQueued || m.isPendingInProcess);
		});
		if (userIdx === -1) return;
		var ex = this.state.messages[userIdx];
		// Same carry-over as above, plus _indexFile / _useBgQueue: this rebuild is
		// what keeps an indexing REQUEST bubble in its file's collapsed row (and a
		// bg-queued chat cancelling against the right queue) once the pass settles.
		var settledUser: ChatMessage = { role: 'user', content: ex.content, _serverItemId: itemId };
		if (ex.isBackgroundTask) settledUser.isBackgroundTask = true;
		if (ex._indexFile) settledUser._indexFile = ex._indexFile;
		if (ex._useBgQueue) settledUser._useBgQueue = true;
		this.state.messages[userIdx] = settledUser;
		if (isErr) {
			var errReply: ChatMessage = { role: 'assistant', content: answer, isError: true, _serverItemId: itemId };
			if (ex.isBackgroundTask) errReply.isBackgroundTask = true;
			this.state.messages.splice(userIdx + 1, 0, errReply);
			this.host.notify(); this.updateHistoryCache(); return;
		}
		var text2 = answer || 'No text response received from AI provider.';
		// Same as above: a collapsed row's reply is not on screen, so revealing it
		// character by character only blocks the queue the visible reply needs.
		if (ex.isBackgroundTask) {
			this.state.messages.splice(userIdx + 1, 0, { role: 'assistant', content: text2, isBackgroundTask: true, _serverItemId: itemId });
			this.host.notify(); this.updateHistoryCache(); return;
		}
		var lid2 = this._newLocalId();
		var reply: ChatMessage = { role: 'assistant', content: '', _localId: lid2, _serverItemId: itemId };
		this.state.messages.splice(userIdx + 1, 0, reply);
		this.host.notify(); this.enqueueTypewrite(userIdx + 1, text2, lid2);
		this.updateHistoryCache();
	}

	/** How a bg task maps onto a collapsed row: the row's own key (storage path
	 *  when known, else the filename), scoped to the chat it belongs to. A storage
	 *  path is project-relative ("report.xlsx"), and ONE ChatSession serves every
	 *  project — unscoped, stopping a file in one project would silently suppress
	 *  the same filename's continuations in another. */
	private _indexKeyOf(entry: BgTaskEntry): string {
		if (!entry) return '';
		var file = entry.storagePath || entry.filename;
		if (!file) return '';
		return entry.serviceId + '#' + entry.platform + '|' + file;
	}

	/**
	 * Reconcile the bg queue with the files the user has stopped.
	 *
	 * A FIRST pass (no resumePass) is a fresh indexing request — a re-upload, or a
	 * Reindex from the file manager — so it LIFTS the stop: the key is a storage
	 * path, and without this an earlier cancel would silently kill every future
	 * index of the same path. A continuation of a stopped file is dropped instead,
	 * covering the pass that was dispatched in the moment before the cancel landed.
	 */
	private _applyIndexCancellations(): void {
		if (!this.cancelledIndexKeys.size) return;
		for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
			var entry = this.bgTaskQueue[i];
			var key = this._indexKeyOf(entry);
			if (!key || !this.cancelledIndexKeys.has(key)) continue;
			if (!entry.resumePass) { this.cancelledIndexKeys.delete(key); continue; }
			this.bgTaskQueue.splice(i, 1);
			this._stopPoll(entry.id);
			this._cancelServerItem(entry.id);
		}
	}

	/**
	 * Cancel any live pass of a stopped file that turned up on its own.
	 *
	 * The client is not the only thing that continues a file: for PDFs and (when
	 * windowed indexing is on) text/grid files the WORKER enqueues the next window
	 * itself, and that pass reaches the chat through the history poll, never
	 * through bgTaskQueue. The worker's own gate stops the chain when the running
	 * row is cancelled — but if the row had already finished when the user hit
	 * stop, the next window was queued a moment earlier and still arrives. Stop it
	 * here rather than making the user hit stop again.
	 *
	 * Runs from drainBgTaskQueue, which both clients call after a history load.
	 */
	private _sweepCancelledIndexing(): void {
		if (!this.cancelledIndexKeys.size) return;
		var self = this;
		var chatKey = this.getHistoryCacheKey();
		var targets: { msg: ChatMessage; idx: number }[] = [];
		this.state.messages.forEach(function (m, i) {
			if (!m.isBackgroundTask || m.role !== 'user' || !m._serverItemId) return;
			if (m._cancelling || m.isSendingToServer) return;
			if (!(m.isPendingQueued || m.isPendingInProcess)) return;
			var ref = m._indexFile;
			var file = ref && (ref.path || ref.name);
			if (!file || !self.cancelledIndexKeys.has(chatKey + '|' + file)) return;
			targets.push({ msg: m, idx: i });
		});
		targets.forEach(function (t) {
			var idx = self.state.messages.indexOf(t.msg);
			self.cancelQueuedMessage(t.msg, idx === -1 ? t.idx : idx);
		});
	}

	/** Best-effort server-side cancel of a bg-queue item that has no bubble (so
	 *  cancelQueuedMessage, which drives one, has nothing to act on). */
	private _cancelServerItem(serverId: string): void {
		var id = this.host.getIdentity();
		if (!serverId || (id.platform !== 'claude' && id.platform !== 'openai')) return;
		var url = id.platform === 'claude' ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
		Promise.resolve(this.host.cancelRequest({
			url: url, method: 'POST', id: serverId,
			queue: (id.userId || id.serviceId) + BG_INDEXING_QUEUE_SUFFIX,
			service: id.serviceId, owner: id.owner,
		})).catch(function () { /* the pass may already have finished; nothing to do */ });
	}

	// Inject "Indexing: <file>" bubbles for queued bg tasks + attach their polls.
	drainBgTaskQueue(): void {
		var self = this;
		var id = this.host.getIdentity();
		var svcId = id.serviceId, plat = id.platform;
		if (!svcId || plat === 'none' || !this.host.isViewMounted()) return;
		// Before anything is surfaced: drop continuations of files the user stopped
		// (and let a fresh first pass lift the stop), then cancel any worker-queued
		// pass of a stopped file that reached the chat through history.
		this._applyIndexCancellations();
		this._sweepCancelledIndexing();
		// Index messages by _serverItemId ONCE, so the per-entry presence/pending
		// checks below are O(1) instead of a full messages.some() scan each. With a
		// large bg queue (bulk uploads) the old nested scan was O(queue x messages)
		// per drain, and the drain runs once per uploaded file (O(n^3) overall).
		var presentIds: { [id: string]: boolean } = {};
		var pendingIds: { [id: string]: boolean } = {};
		this.state.messages.forEach(function (m) {
			var sid = m._serverItemId;
			if (sid == null) return;
			presentIds[sid] = true;
			if (m.isPending || m.isPendingInProcess || m.isPendingQueued) pendingIds[sid] = true;
		});
		for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
			var e = this.bgTaskQueue[i];
			if (e.serviceId !== svcId || e.platform !== plat) continue;
			if (presentIds[e.id] && !pendingIds[e.id]) this.bgTaskQueue.splice(i, 1);
		}
		this.bgTaskQueue.forEach(function (entry) {
			if (entry.serviceId !== svcId || entry.platform !== plat) return;
			// Bubble injection and poll attachment are INDEPENDENT. An entry whose bubble
			// already exists may still need a poll — that is exactly the state a paused
			// drain leaves behind, and returning early here stranded it as a permanent
			// "Thinking..." once polling resumed.
			if (!presentIds[entry.id]) {
			var isRunning = entry.status === 'running';
			var userBubble: ChatMessage = {
				role: 'user',
				content: self.host.formatIndexingLabel(entry.filename, entry.mime, entry.size, entry.storagePath, entry.isReindex, !!entry.resumePass),
				isBackgroundTask: true,
				_serverItemId: entry.id,
				// Structured ref so this live pass groups with the same file's passes
				// rebuilt from history (see indexing_groups.buildChatDisplayList).
				_indexFile: {
					name: entry.filename,
					path: entry.storagePath,
					mime: entry.mime,
					size: entry.size,
					isReindex: !!entry.isReindex,
					continued: !!entry.resumePass,
				},
			};
			if (isRunning) userBubble.isPendingInProcess = true; else userBubble.isPendingQueued = true;
			self.state.messages.push(userBubble);
			if (isRunning) {
				self.state.messages.push({ role: 'assistant', content: '', isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: entry.id });
			}
			presentIds[entry.id] = true; // keep the index consistent with the pushed bubbles
			self.host.notify(); self.updateHistoryCache(); self.host.scrollToBottomIfSticky(false);
			}
			if (!self.isPollingPaused() && !self.historyItemPolls.has(entry.id) && typeof entry.poll === 'function') {
				var capturedId = entry.id, capturedPlat = plat;
				var capturedEntry = entry;
				var wasStopped = false;
				var bp = entry.poll({ latency: POLL_INTERVAL });
				self._trackPoll(entry.id, 'bg', bp);
				bp.then(function (response: any) {
					// A stopped poll is not a result: leave the bubble and the queue entry
					// exactly as they were so resumePolling can re-attach.
					if (isPollStopped(response)) { wasStopped = true; return; }
					self.handleHistoryItemResolution(capturedId, response, capturedPlat);
					self.maybeResumeIndexing(capturedEntry, response, capturedPlat);
				}).catch(function (err: any) {
					self.historyItemPolls.delete(capturedId);
					var isNotExists = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
					// Settle the REQUEST bubble first, unconditionally. Only a RUNNING
					// pass gets an assistant placeholder, so for a queued one the lookup
					// below finds nothing and every branch was skipped — leaving the
					// request bubble isPendingQueued with its queue entry about to be
					// spliced away, i.e. no poll left to ever clear it. One such bubble
					// pins the whole collapsed row to "active": a spinner and a Stop
					// button against a dead id, until the page is reloaded.
					self._clearPendingUserBubble(capturedId);
					var bi = self.state.messages.findIndex(function (m) { return m.isPending && m._serverItemId === capturedId; });
					if (bi !== -1) {
						if (isNotExists) self.state.messages.splice(bi, 1);
						else self.state.messages[bi] = { role: 'assistant', content: getErrorMessage(err), isError: true, isBackgroundTask: true, _serverItemId: capturedId };
					} else if (!isNotExists) {
						// No placeholder to turn into the error (a queued pass). Put one
						// after the request bubble so the row reports the failure instead
						// of quietly settling to "Indexed".
						var ui = self.state.messages.findIndex(function (m) { return m.role === 'user' && m._serverItemId === capturedId; });
						if (ui !== -1) {
							self.state.messages.splice(ui + 1, 0, { role: 'assistant', content: getErrorMessage(err), isError: true, isBackgroundTask: true, _serverItemId: capturedId });
						}
					}
					self.host.notify(); self.updateHistoryCache();
				}).then(function () {
					// Keep the queue entry when the poll was merely stopped, or resuming
					// would have nothing left to re-attach to.
					if (wasStopped) return;
					var qi = self.bgTaskQueue.findIndex(function (q) { return q.id === capturedId; });
					if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
				});
			}
		});
		this.promoteNextBgQueuedToRunning();
	}

	// Resume-across-passes: if a background INDEXING task for a paged file (spreadsheet or
	// text) finished WITHOUT the completion marker, the agent ran out of room before reading
	// the whole file - dispatch a CONTINUE pass (up to a cap) that resumes from where the
	// already-saved records leave off. Additive + guarded so it never loops forever and
	// never breaks the resolution path.
	//
	// VISION files (PDFs rendered to page images) are NOT resumed here: the proxy worker
	// advances their page window itself, off the renderer's true page count. Driving them
	// from the browser is what used to lose pages on long documents - the chain lived in tab
	// memory (a reload or a closed tab ended it), and it stopped whenever the model claimed
	// completion, which on an 88-page file happened at page 15. Continuing to dispatch here
	// as well would now double-index every window.
	maybeResumeIndexing(entry: BgTaskEntry, response: any, platform: string): void {
		var self = this;
		try {
			if (!entry || !entry.storagePath) return;
			// The user stopped this file from its collapsed row. Dispatching the next
			// pass here is exactly what "stop" has to prevent — the cancelled pass
			// settles, and without this the chain simply carries on.
			if (this.cancelledIndexKeys.has(this._indexKeyOf(entry))) return;
			if (!isPagedReadFile(entry.filename, entry.mime)) return;
			if (isImageVisionFile(entry.filename, entry.mime)) return; // worker owns this loop (PDF vision)
			// When windowed indexing is on, the WORKER drives the text/grid loop too. The
			// client MUST NOT also resume, or two drivers each enqueue a continuation per
			// pass and the chain FORKS - duplicate records, runaway passes. Same reason
			// PDFs early-return above. Gated on the flag so the old client-driven path is
			// untouched when windowing is off.
			if (windowedIndexingEnabled() && isWindowedReadFile(entry.filename, entry.mime)) return;
			if (isErrorResponseBody(response)) return; // a failed pass is not "incomplete"
			var answer = (platform === 'openai' ? extractOpenAIText(response) : extractClaudeText(response)) || '';
			if (answer.indexOf(INDEXING_COMPLETE_MARKER) !== -1) return; // fully indexed
			var pass = (entry.resumePass || 0) + 1;
			if (pass > MAX_INDEXING_RESUME_PASSES) return; // give up after the cap
			var id = this.host.getIdentity();
			if (!id || id.platform === 'none' || id.serviceId !== entry.serviceId) return;
			notifyAgentContinueIndexing({
				platform: id.platform as 'claude' | 'openai',
				model: id.model,
				service: id.serviceId,
				owner: id.owner,
				userId: id.userId || id.serviceId,
				serviceName: id.serviceName,
				serviceDescription: id.serviceDescription,
				attachment: {
					name: entry.filename,
					storagePath: entry.storagePath,
					mime: entry.mime,
					size: entry.size,
					url: '',
				},
			}).then(function (ack: any) {
				if (ack && typeof ack.id === 'string') {
					self.bgTaskQueue.push({
						serviceId: id.serviceId, platform: id.platform as 'claude' | 'openai', id: ack.id,
						filename: entry.filename, storagePath: entry.storagePath,
						isReindex: entry.isReindex, mime: entry.mime, size: entry.size,
						status: ack.status === 'running' ? 'running' : 'pending',
						poll: ack.poll, resumePass: pass,
					});
					self.drainBgTaskQueue();
				}
			}, function (e: any) { console.error('[chat-engine] resume-indexing dispatch failed', e); });
		} catch (e) { /* best-effort: resume must never break bg-task resolution */ }
	}

	// --- history fetch + pagination --------------------------------------
	// Initial load (fetchMore=false) replaces the list (with in-flight rescue +
	// cancelled-merge) and attaches polls to running/pending items; pagination
	// (fetchMore=true) prepends older messages. The DOM scroll-restore for the
	// older-prepend is the VIEW's job (it captures the pre-prepend scroll position
	// and restores after this resolves) — the engine never measures the DOM.
	loadHistory(fetchMore?: boolean, token?: number): Promise<void> {
		var self = this;
		var id = this.host.getIdentity();
		// Key this fetch is FOR, snapshotted from the same identity read the
		// request is built from. The rescue below compares against this rather
		// than a live getHistoryCacheKey(), so a project switch mid-fetch can't
		// make another chat's in-flight bubbles look local.
		var loadKey = (!id.serviceId || id.platform === 'none') ? '' : id.serviceId + '#' + id.platform;
		if (token === undefined) token = this.state.gateRefreshToken;
		if ((this.state.loadingHistory && this.state.historyRequestToken === token) || id.platform === 'none' || !id.serviceId) {
			return Promise.resolve();
		}
		this.state.historyRequestToken = token;
		this.state.loadingHistory = true;
		if (fetchMore) this.state.loadingOlderHistory = true;
		this.host.notify(); // surface "Fetching history..." while it loads
		var platform = id.platform as 'claude' | 'openai';
		var serviceId = id.serviceId, owner = id.owner;
		var options: any = { fetchMore: fetchMore };
		if (fetchMore && this.state.historyStartKeyHistory.length) options.startKeyHistory = this.state.historyStartKeyHistory.slice();

		var fetchHistory = function () { return getChatHistory({ service: serviceId, owner: owner, platform: platform }, options); };

		return Promise.resolve().then(fetchHistory).catch(function (err: any) {
			if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(fetchHistory);
			throw err;
		}).then(function (history: any) {
			if (token !== self.state.gateRefreshToken) return;
			var chatList = history && Array.isArray(history.list) ? history.list : [];
			chatList.forEach(function (item: any) {
				if (isBgIndexingQueue(item.queue_name)) {
					var userText = extractLastUserTextFromRequest(item.request_body);
					if (typeof userText === 'string' && (userText.indexOf('A new file has just been uploaded') === 0 || userText.indexOf('CONTINUE indexing') === 0)) item._isBgTask = true;
					else item._isOnBgQueue = true;
				}
			});
			var list = chatList.sort(function (a: any, b: any) {
				var ai = typeof a.id === 'string' ? a.id : '', bi = typeof b.id === 'string' ? b.id : '';
				return ai > bi ? -1 : (ai < bi ? 1 : 0);
			});
			var mapped = mapHistoryListToMessages(list, platform, {
				clearedAt: self.host.getClearedAt(),
				serviceId: id.serviceId,
				formatIndexingLabel: self.host.formatIndexingLabel,
			}).messages;

			// Set when a first-page refresh re-prepended already-loaded older pages,
			// so the cursor reset below knows not to rewind to page 1's boundary.
			var keptOlderPages = false;

			if (fetchMore) {
				self.state.messages = mapped.concat(self.state.messages);
			} else {
				if (self.state.typing) self.state.typingAbort = true;
				var serverIds: any = {};
				mapped.forEach(function (m: any) { if (m._serverItemId) serverIds[m._serverItemId] = 1; });
				var locallyCancelled: any = {};
				self.state.messages.forEach(function (m) { if (m.isCancelled && m._serverItemId) locallyCancelled[m._serverItemId] = m; });
				// A cancel the server has not acknowledged yet. Without carrying these
				// across the replace, a collapsed row mid-cancel drops its "Stopping..."
				// state and re-offers Stop; the second click cancels an id that is
				// already gone and writes a bogus "Could not remove from queue." onto a
				// run that WAS stopped successfully.
				var inFlightCancel: any = {};
				self.state.messages.forEach(function (m) {
					if (!m._serverItemId) return;
					if (m._cancelling || m._cancelError) inFlightCancel[m._serverItemId] = m;
				});
				// If the freshly-mapped server list ALREADY shows this in-flight turn
				// as a pending placeholder (a non-bg pending assistant, which carries
				// a real _serverItemId), re-pushing the local no-_serverItemId
				// user+Thinking would DUPLICATE it. Each resolve path only clears the
				// first pending bubble, so the duplicate strands a "Thinking…" beside
				// the reply/error. There is at most one in-flight regular turn, so a
				// mapped pending assistant IS this turn — skip the redundant local copy.
				var mappedHasPendingAssistant = mapped.some(function (m: any) {
					return m.isPending && m.role === 'assistant' && !m.isBackgroundTask;
				});
				var rescued: ChatMessage[] = [];
				for (var ri = 0; ri < self.state.messages.length; ri++) {
					var mm = self.state.messages[ri];
					if (mm.isBackgroundTask) continue;
					// Belongs to a different chat (another project, or another
					// platform on this one) — it must not be carried onto THIS
					// chat's freshly-fetched history.
					if (mm._ownerKey !== undefined && mm._ownerKey !== loadKey) continue;
					if (mm._serverItemId && serverIds[mm._serverItemId]) continue;
					if (!mm._serverItemId) {
						if (mappedHasPendingAssistant) continue;
						if (mm.isSendingToServer || mm.isPendingQueued || mm.isPendingInProcess || mm.isPending) rescued.push(mm);
						else if (self.state.sending && mm.role === 'user') {
							var next = self.state.messages[ri + 1];
							if (next && !next.isBackgroundTask && next.isPending && !next._serverItemId) rescued.push(mm);
						}
					}
				}
				// PRESERVE already-loaded older pages. `mapped` is only page 1, so a
				// blind replace threw away every page the user had scrolled in. This
				// path runs from resumePolling (visibilitychange), so merely leaving
				// the tab and coming back wiped the whole scrolled-in history.
				//
				// The list is oldest-first (fetchMore PREPENDS), and ids sort with
				// newest largest, so anything already in the list whose _serverItemId
				// sorts BELOW page 1's oldest id is an older page. Those are disjoint
				// from `mapped` (strict <), so re-prepending cannot duplicate.
				var oldestInPage1: string | undefined = undefined;
				mapped.forEach(function (m: any) {
					var sid = m._serverItemId;
					if (typeof sid !== 'string') return;
					if (oldestInPage1 === undefined || sid < (oldestInPage1 as string)) oldestInPage1 = sid;
				});
				// Only merge when the current list is genuinely a continuation of THIS
				// page 1 (shares at least one id with it). A project switch, a cleared
				// horizon, or a wholly-new page means the head is unrelated history and
				// must be replaced, not spliced.
				var sharesPage1 = self.state.messages.some(function (m) {
					return typeof m._serverItemId === 'string' && !!serverIds[m._serverItemId as string];
				});
				var retainedOlder: ChatMessage[] = (!sharesPage1 || oldestInPage1 === undefined) ? [] : self.state.messages.filter(function (m) {
					// Settled server history only; in-flight bubbles are the rescue
					// loop's job below and would otherwise be kept twice.
					if (typeof m._serverItemId !== 'string') return false;
					// Same ownership predicate as the rescue loop: never carry another
					// project's bubbles onto this chat (the cross-project leak fix).
					// Compare against the snapshotted loadKey, never a live read.
					if (m._ownerKey !== undefined && m._ownerKey !== loadKey) return false;
					return (m._serverItemId as string) < (oldestInPage1 as string);
				});
				keptOlderPages = retainedOlder.length > 0;
				self.state.messages = keptOlderPages ? retainedOlder.concat(mapped) : mapped;
				rescued.forEach(function (m) { self.state.messages.push(m); });
				if (Object.keys(locallyCancelled).length) {
					for (var ci = 0; ci < self.state.messages.length; ci++) {
						var c = self.state.messages[ci];
						if (!c._serverItemId || !locallyCancelled[c._serverItemId] || c.isCancelled) continue;
						// Rebuild FROM the mapped bubble rather than as a bare literal:
						// dropping isBackgroundTask / _indexFile here ejected a stopped
						// indexing pass from its file's collapsed row, where it then rendered
						// as a standalone "Indexing: <file>" chat bubble and left the row
						// recomputing its passes as if that one had never happened.
						self.state.messages[ci] = {
							role: 'user', content: c.content, isCancelled: true, _serverItemId: c._serverItemId,
							isBackgroundTask: c.isBackgroundTask, _indexFile: c._indexFile,
							_useBgQueue: c._useBgQueue, _ownerKey: c._ownerKey,
						};
						if (ci + 1 < self.state.messages.length && self.state.messages[ci + 1].isPending && self.state.messages[ci + 1]._serverItemId === c._serverItemId) {
							self.state.messages.splice(ci + 1, 1);
						}
					}
				}
				// Re-stamp a cancel that is still in flight (see inFlightCancel above).
				// Only onto a bubble the server still reports as pending — once it has
				// settled the flags describe nothing the user can act on.
				for (var fi = 0; fi < self.state.messages.length; fi++) {
					var fm = self.state.messages[fi];
					var was = fm._serverItemId && inFlightCancel[fm._serverItemId];
					if (!was || fm.isCancelled) continue;
					if (!(fm.isPendingQueued || fm.isPendingInProcess || fm.isPending)) continue;
					if (was._cancelling) fm._cancelling = true;
					if (was._cancelError) fm._cancelError = was._cancelError;
				}
			}
			// Only adopt page 1's cursor when page 1 IS the whole list. If older pages
			// survived the merge, rewinding here would make the next scroll-up
			// re-fetch page 2 (already on screen) and duplicate it.
			if (!keptOlderPages) {
				self.state.historyEndOfList = !!(history && history.endOfList);
				self.state.historyStartKeyHistory = history && Array.isArray(history.startKeyHistory) ? history.startKeyHistory : [];
				var clearedAt = self.host.getClearedAt();
				if (clearedAt && chatList.length > 0) {
					var oldestUpdated = Number(chatList[chatList.length - 1] && chatList[chatList.length - 1].updated);
					if (isFinite(oldestUpdated) && oldestUpdated <= clearedAt) self.state.historyEndOfList = true;
				}
			}
			// Clear loading flags BEFORE this render so the final paint is
			// indicator-free (and the view's scroll-restore math sees matching heights).
			if (self.state.historyRequestToken === token) { self.state.loadingHistory = false; self.state.loadingOlderHistory = false; }
			self.updateHistoryCache();
			self.host.notify();

			if (!fetchMore) {
				chatList.forEach(function (item: any) {
					if (item.status !== 'running' && item.status !== 'pending') return;
					if (!item.poll || !item.id) return;
					// Every live poll registers its item id in historyItemPolls — an
					// immediate dispatch (dispatchAgentRequest ~123), a queued send
					// (~253), a bg task (drain), or an earlier history poll — so the
					// has() check below already skips exactly the items a live poll
					// covers (including the one the current dispatch is polling). Do NOT
					// additionally skip every OTHER running/pending item just because
					// some immediate dispatch is in flight: that dispatch polls only ITS
					// item, so blanket-skipping stranded a concurrent "-bg" indexing item
					// (a separate server queue runs in parallel) — or any item whose own
					// poll had since died — with no live poller, leaving a "Thinking..."
					// that never clears even after the server settled everything.
					if (self.historyItemPolls.has(item.id)) return;
					// An in-flight immediate dispatch polls its own MAIN-QUEUE item but
					// registers that id in historyItemPolls only AFTER its provider POST
					// returns; in the sliver before that, a remount can surface the item
					// here still unregistered. Skip re-polling MAIN-QUEUE items while a
					// dispatch is in flight so we don't stack a 2nd poll on the item the
					// dispatch is about to poll. Bg-queue items (_isBgTask indexing tasks
					// and _isOnBgQueue chats) run on a SEPARATE queue the immediate
					// dispatch never polls, so they MUST still get their poll — skipping
					// them was the stranded-"Thinking" bug this guard must not revive.
					if (self.pendingAgentRequests[self.getHistoryCacheKey()] && !item._isBgTask && !item._isOnBgQueue) return;
					// Background indexing polls are suppressed while paused; foreground
					// replies the user is waiting on are not.
					if ((item._isBgTask || item._isOnBgQueue) && self.isPollingPaused()) return;
					var capturedId = item.id;
					var pp = item.poll({
						latency: POLL_INTERVAL,
						onResponse: function (response: any) { if (isPollStopped(response)) return; self.handleHistoryItemResolution(capturedId, response, platform); },
						onError: function (err: any) {
							self.historyItemPolls.delete(capturedId);
							var isNotExists = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
							var aIdx = self.state.messages.findIndex(function (m) { return m.isPending && m._serverItemId === capturedId; });
							if (isNotExists) {
								var uIdx = self.state.messages.findIndex(function (m) { return m.role === 'user' && m._serverItemId === capturedId && !m.isCancelled; });
								// Decide bg-ness from whichever bubble actually exists. A
								// QUEUED pass has no assistant placeholder (history.ts emits
								// none), so reading it off the placeholder alone classified
								// every queued indexing pass as foreground: the rebuild below
								// then dropped isBackgroundTask/_indexFile, ejecting the pass
								// from its collapsed row as a raw "Indexing: <file>" chat
								// bubble, and promoteNextQueuedToRunning span up a "Thinking..."
								// on an unrelated queued FOREGROUND message.
								var isBg = (aIdx !== -1 && !!self.state.messages[aIdx].isBackgroundTask)
									|| (uIdx !== -1 && !!self.state.messages[uIdx].isBackgroundTask);
								if (aIdx !== -1) self.state.messages.splice(aIdx, 1);
								if (!isBg) {
									if (uIdx !== -1) { var ex = self.state.messages[uIdx]; self.state.messages[uIdx] = { role: 'user', content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId }; }
									self.cancelledServerIds.delete(capturedId); self.promoteNextQueuedToRunning();
								} else if (uIdx !== -1) {
									// Same carry-over every other rebuild does, so the pass stays
									// a member of its file's row while reading as cancelled.
									var bex = self.state.messages[uIdx];
									var bcancelled: ChatMessage = { role: 'user', content: bex.content, isCancelled: true, isBackgroundTask: true, _serverItemId: bex._serverItemId };
									if (bex._indexFile) bcancelled._indexFile = bex._indexFile;
									if (bex._useBgQueue) bcancelled._useBgQueue = true;
									self.state.messages[uIdx] = bcancelled;
									self.promoteNextBgQueuedToRunning();
								}
								self.host.notify(); self.updateHistoryCache(); return;
							}
							if (aIdx !== -1) {
								var wasBg = self.state.messages[aIdx].isBackgroundTask;
								self.state.messages[aIdx] = { role: 'assistant', content: getErrorMessage(err), isError: true };
								if (wasBg) self.state.messages[aIdx].isBackgroundTask = true;
								self.host.notify(); self.updateHistoryCache();
							}
						},
					});
					// Anything on the BACKGROUND queue is pausable, not just items whose
					// prompt text we recognise as an indexing task. _isBgTask vs
					// _isOnBgQueue is a DISPLAY distinction ("Indexing: file" vs a normal
					// chat bubble); keying the pause off _isBgTask alone left every
					// bg-queue item we could not text-match polling forever.
					self._trackPoll(capturedId, (item._isBgTask || item._isOnBgQueue) ? 'bg' : 'fg', pp);
					if (pp && pp.catch) pp.catch(function () { });
				});
				self.drainBgTaskQueue();
			}

			// Sticky, NOT forcing: this runs after every first-page load, including
			// the one resumePolling fires on visibilitychange. Forcing yanked a
			// reader who had scrolled up back to the bottom. On a genuine mount the
			// user is still pinned, so this behaves identically there.
			if (!fetchMore) return self.host.scrollToBottomIfSticky();
		}).catch(function (err: any) {
			console.warn('[chat-engine] getChatHistory failed', err);
		}).then(function () {
			if (self.state.historyRequestToken === token) {
				var wasLoading = self.state.loadingHistory || self.state.loadingOlderHistory;
				self.state.loadingHistory = false; self.state.loadingOlderHistory = false;
				if (wasLoading) self.host.notify();
			}
			// Every first-page load ends here — mount, resumePolling, a cache-restore
			// refresh — and every one of them can leave a box too short to scroll,
			// which is the only trigger there is for reaching page 2. The view (which
			// alone can measure) pages its way out of it. Fired after the flags are
			// cleared so the fill loop does not see a request still in flight.
			if (self.host.onHistoryLoaded) self.host.onHistoryLoaded(!!fetchMore, token as number);
		});
	}

	// --- attachment upload orchestration ---------------------------------
	// Upload one attachment (a file = 1 member, a folder = N) to db storage and
	// queue indexing per member. The bytes I/O + chip rendering go through host
	// hooks; the overwrite/reindex flow, status lifecycle, and indexing live here.
	uploadSingleAttachment(att: any): Promise<Array<{ name: string; url: string; storagePath: string }>> {
		var self = this;
		var id = this.host.getIdentity();
		att.status = 'uploading'; att.progress = 0; att.errorMessage = '';
		att.errorCode = ''; att.errorDetail = ''; // clear any prior failure (retry)
		this.host.renderAttachmentChips();
		var members = (att.kind === 'folder')
			? (att.files || []).map(function (f: any) { return { file: f.file, relPath: f.path, storagePath: self.host.storagePathFor(f.path) }; })
			: [{ file: att.file, relPath: att.name, storagePath: this.host.storagePathFor(att.name) }];
		var total = members.length;
		if (!total) return Promise.reject(new Error('Empty attachment'));
		var urls: Array<{ name: string; url: string; storagePath: string }> = [];
		var anyIndexFailed = false;
		var chain: Promise<any> = Promise.resolve();
		members.forEach(function (member: any, idx: number) {
			chain = chain.then(function () {
				var hadExists = false;
				var skipped = false;
				// True when the file already existed and we are re-indexing over it
				// (user chose Reindex, OR Overwrite replaced the bytes). Drives the
				// delete-then-repost of the stale "src::" record below. Kept separate
				// from hadExists, which must keep driving ONLY the Reindexing/Indexing
				// label (isReindex) — overwrite still labels as "Indexing:".
				var existedBefore = false;
				var onProg = function (p: any) {
					if (p && p.total) {
						att.progress = Math.floor(((idx + p.loaded / p.total) / total) * 100);
						self.host.renderAttachmentChips();
					}
				};
				var doMemberUpload = function (checkExistence: boolean) {
					return self.host.uploadFile({
						file: member.file, storagePath: member.storagePath, checkExistence: checkExistence,
						onProgress: onProg, setAbort: function (abort) { att._abort = abort; },
					});
				};
				return doMemberUpload(true).catch(function (err: any) {
					var code = err && (err.code || (err.body && err.body.code));
					var msg = err && (err.message || (err.body && err.body.message) || (typeof err === 'string' ? err : ''));
					var isExists = code === 'EXISTS' || (msg && /exist/i.test(msg));
					if (!isExists) throw err; // a member upload failed → whole attachment fails (red)
					return self.host.promptOverwrite(member.file.name).then(function (choice) {
						if (choice === 'overwrite') { existedBefore = true; return doMemberUpload(false); } // replace the existing file
						if (choice === 'skip') { skipped = true; return; } // leave it untouched; no upload/index
						hadExists = true; existedBefore = true; // keep it; Reindex
					});
				}).then(function () {
					if (skipped) return; // user skipped this member — no url, no index request
					return self.host.getTemporaryUrl(member.storagePath);
				}).then(function (url: string) {
					if (skipped) return; // guard the indexing branch for a skipped member
					urls.push({ name: member.relPath, url: url, storagePath: member.storagePath });
					if (att.kind !== 'folder') { att.uploadedUrl = url; att.storagePath = member.storagePath; }
					var mime = member.file.type || self.host.getMimeType(member.file.name);
					// Delete-then-repost: when the file already existed (Reindex or
					// Overwrite), delete the stale "src::<storagePath>" index record
					// first — the skapi backend cascades the delete to its
					// reference-linked children — so re-indexing REPLACES rather than
					// colliding/duplicating. Awaited before the index request is
					// enqueued. Best-effort + optional-hook guarded: a missing record,
					// a permission error, or a host without the hook must not block
					// indexing.
					var preIndex = (existedBefore && typeof self.host.deleteExistingFileRecord === 'function')
						? Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function () { })
						: Promise.resolve();
					// Run a client-side attachment parser (e.g. .hwp) if one matches; its
					// output is inlined into the indexing request (falls back to office
					// extraction / web_fetch when no parser matches or it yields nothing).
					return preIndex.then(function () {
						return parseAttachmentContent(member.file, member.file.name, mime || undefined);
					}).then(function (parsedContent: string | null) {
					return notifyAgentSaveAttachment({
						platform: id.platform as 'claude' | 'openai',
						model: id.model,
						service: id.serviceId,
						owner: id.owner,
						userId: id.userId || id.serviceId,
						serviceName: id.serviceName,
						serviceDescription: id.serviceDescription,
						attachment: {
							name: member.file.name, storagePath: member.storagePath,
							mime: mime || undefined, size: member.file.size, url: url,
						},
						parsedContent: parsedContent || undefined,
					}).then(function (ack: any) {
						if (ack && typeof ack.id === 'string') {
							self.bgTaskQueue.push({
								serviceId: id.serviceId, platform: id.platform as 'claude' | 'openai', id: ack.id,
								filename: member.file.name,
								storagePath: member.storagePath,
								isReindex: hadExists,
								mime: mime || undefined,
								size: member.file.size,
								status: ack.status === 'running' ? 'running' : 'pending',
								poll: ack.poll,
							});
							self.drainBgTaskQueue(); // surface "Indexing: <file>" as soon as THIS file uploads
						}
					}, function (e: any) {
						console.error('[chat-engine] indexing request failed', e);
						anyIndexFailed = true; // uploaded but not indexed → yellow
						// Record the first index error's code/message for the report dialog.
						if (!att.errorCode && !att.errorDetail) {
							att.errorCode = (e && (e.code || (e.body && e.body.code))) || '';
							att.errorDetail = (e && (e.message || (e.body && e.body.message))) || (typeof e === 'string' ? e : '');
						}
					});
					});
				});
			});
		});
		return chain.then(function () {
			att._abort = null; att.progress = 100;
			if (att.kind === 'folder') att.uploadedUrls = urls.map(function (u) { return { path: u.name, url: u.url, storagePath: u.storagePath }; });
			att.status = anyIndexFailed ? 'indexError' : 'done';
			if (att.status === 'indexError') att.errorMessage = 'File indexing failed';
			self.host.renderAttachmentChips();
			return urls;
		});
	}

	// Upload all not-yet-done attachments sequentially. Resolves to the full
	// list of { name, url, storagePath } for composing the chat message.
	uploadPendingAttachments(): Promise<Array<{ name: string; url: string; storagePath?: string }>> {
		var self = this;
		this.host.resetOverwriteBatch();
		this.state.uploadingAttachments = true;
		this.host.updateComposerControls();
		this.host.renderAttachmentChips();
		var collected: Array<{ name: string; url: string; storagePath?: string }> = [];
		var snapshot = this.state.attachments.slice();
		var chain: Promise<any> = Promise.resolve();
		snapshot.forEach(function (att: any) {
			chain = chain.then(function () {
				if (!self.state.attachments.some(function (a: any) { return a.id === att.id; })) return; // removed
				if (att.status === 'done' || att.status === 'indexError') {
					if (att.kind === 'folder' && att.uploadedUrls) {
						att.uploadedUrls.forEach(function (u: any) { collected.push({ name: u.path, url: u.url, storagePath: u.storagePath }); });
						return;
					}
					if (att.uploadedUrl) { collected.push({ name: att.name, url: att.uploadedUrl, storagePath: att.storagePath }); return; }
				}
				return self.uploadSingleAttachment(att).then(function (us) {
					collected.push.apply(collected, us);
				}).catch(function (err: any) {
					var removed = !self.state.attachments.some(function (a: any) { return a.id === att.id; });
					var aborted = err && (err.message === 'Aborted' || err === 'Aborted');
					if (removed || aborted) return;
					att.status = 'error';
					att.errorMessage = 'File upload has failed';
					// Preserve the original error code/message for the report dialog.
					att.errorCode = (err && (err.code || (err.body && err.body.code))) || '';
					att.errorDetail = (err && (err.message || (err.body && err.body.message))) || (typeof err === 'string' ? err : '');
					self.host.renderAttachmentChips();
				});
			});
		});
		var done = function () {
			self.state.uploadingAttachments = false; self.host.updateComposerControls(); self.host.renderAttachmentChips();
			return collected;
		};
		return chain.then(done, done);
	}

	// Stop timers / abort the typewriter (view teardown).
	stop(): void {
		this.state.typingAbort = true;
	}

	// Bump the gate token so any in-flight immediate-send result is dropped
	// (called by the view on a service/platform switch or history clear).
	bumpGate(): void {
		this.state.gateRefreshToken += 1;
	}
}
