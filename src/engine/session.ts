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
	extractClaudeText,
	extractOpenAIText,
	getChatHistory,
	POLL_INTERVAL,
	BG_INDEXING_QUEUE_SUFFIX,
	ANTHROPIC_MESSAGES_API_URL,
	OPENAI_RESPONSES_API_URL,
	type BgTaskEntry,
} from './requests';
import { isErrorResponseBody, isAuthExpiredError, isNonRetryableRequestError, getErrorMessage } from './errors';
import { buildBoundedChatMessages } from './budget';
import { createInlineLinkRegex } from './links';
import { mapHistoryListToMessages, extractLastUserTextFromRequest } from './history';
import { parseAttachmentContent } from './attachment_parsers';
import type { ChatHost, ChatState, ChatMessage } from './host';

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

export class ChatSession {
	host: ChatHost;
	state: ChatState;
	bgTaskQueue: BgTaskEntry[];
	cancelledServerIds: Set<string>;
	pendingAgentRequests: Record<string, Promise<any>>;
	aiChatHistoryCache: Record<string, { messages: ChatMessage[]; endOfList: boolean; startKeyHistory: string[] }>;
	historyItemPolls: Map<string, boolean>;
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
		this.pendingAgentRequests = {};
		this.aiChatHistoryCache = {};
		this.historyItemPolls = new Map();
		this._lidSeq = 0;
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
		this.aiChatHistoryCache[key] = {
			messages: this.state.messages.slice(),
			endOfList: this.state.historyEndOfList,
			startKeyHistory: this.state.historyStartKeyHistory.slice(),
		};
	}

	private _callProviderFor(platform: string, prompt: string, messages: any, system: string, model: string | undefined, userId: string, extractContent: any, fileUrls?: any) {
		var id = this.host.getIdentity();
		return platform === 'openai'
			? callOpenAIWithPublicMcp(prompt, id.serviceId, id.owner, messages, system, model, userId, extractContent, fileUrls)
			: callClaudeWithPublicMcp(prompt, id.serviceId, id.owner, messages, system, model, userId, extractContent, fileUrls);
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
				self._callProviderFor(params.aiPlatform, params.text, params.boundedMessages, params.systemPrompt, params.aiModel, params.userId, params.extractContent, params.fileUrls)
			).then(function (initial: any) {
				if (initial && initial.poll && (initial.status === 'pending' || initial.status === 'running')) {
					if (initial.id) {
						if (dispatchItemId && dispatchItemId !== initial.id) self.historyItemPolls.delete(dispatchItemId);
						dispatchItemId = initial.id;
						self.historyItemPolls.set(initial.id, true);
					}
					return initial.poll({ latency: POLL_INTERVAL });
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
	dispatchComposedMessage(composed: string, useBgQueue?: boolean, composedForLlm?: string, extractContent?: any, fileUrls?: any): void {
		var self = this;
		if (!composed) return;
		var id = this.host.getIdentity();
		if (id.platform === 'none') return;

		var llmComposed = composedForLlm || composed;

		var isQueuedSend = useBgQueue || this.state.sending || this.state.messages.some(function (m) {
			return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue;
		});

		var aiPlatform = id.platform;
		var aiModel = id.model || undefined;
		var systemPrompt = this.host.buildSystemPrompt();
		var userId = id.userId || id.serviceId;
		var chatQueue = useBgQueue ? userId + BG_INDEXING_QUEUE_SUFFIX : userId;

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
			if (useBgQueue) queuedBubble._useBgQueue = true;
			this.state.messages.push(queuedBubble);
			this.host.notify(); this.updateHistoryCache(); this.host.scrollToBottom(true);

			var capturedComposed = composed, capturedPlatform = aiPlatform;
			Promise.resolve(this._callProviderFor(aiPlatform, composed, boundedQ.messages, systemPrompt, aiModel, chatQueue, extractContent, fileUrls))
				.then(function (result: any) {
					var sendingIdx = self.state.messages.findIndex(function (m) {
						return m.isSendingToServer && (m.isPendingQueued || m.isPendingInProcess) && m.role === 'user';
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
						if (serverId) self.historyItemPolls.set(serverId, true);
						return result.poll({ latency: POLL_INTERVAL })
							.then(function (res: any) { return self.onQueuedSendResponse(capturedComposed, res, capturedPlatform, serverId); })
							.catch(function (err: any) { return self.onQueuedSendError(capturedComposed, err, serverId); });
					}
					return self.onQueuedSendResponse(capturedComposed, result, capturedPlatform, serverId);
				})
				.catch(function (err: any) { return self.onQueuedSendError(capturedComposed, err, undefined); });
			return;
		}

		// immediate send — cache+resume model (mirrors agent.vue). The reply is
		// appended to aiChatHistoryCache by dispatchAgentRequest (so it survives a
		// view unmount), then rendered from the cache via typewriteLatestReply. A
		// later resumePendingRequest() re-renders it if the view remounted while the
		// request was still in flight.
		this.state.messages.push({ role: 'user', content: composed });
		this.state.messages.push({ role: 'assistant', content: '', isPending: true, isPendingInProcess: true });
		this.host.notify(); this.updateHistoryCache(); this.state.sending = true; this.host.scrollToBottom(true);

		var key = this.getHistoryCacheKey();
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
			if (!(self.host.isViewMounted() && self.getHistoryCacheKey() === key)) return;
			self.state.sending = false;
			return Promise.resolve(self.typewriteLatestReply(key)).then(function () { self.host.scrollToBottom(true); });
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
		if (existing._serverItemId !== undefined) promoted._serverItemId = existing._serverItemId;
		this.state.messages[nextIdx] = promoted;
		var placeholder: ChatMessage = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, isBackgroundTask: true };
		if (existing._serverItemId !== undefined) placeholder._serverItemId = existing._serverItemId;
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
		if (existing._serverItemId !== undefined) promoted._serverItemId = existing._serverItemId;
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
		this.state.messages.splice(nextIdx + 1, 0, placeholder);
		this.host.notify();
	}

	resolveQueuedUserBubble(serverId?: string): number | undefined {
		var userIdx = -1;
		if (serverId) {
			userIdx = this.state.messages.findIndex(function (m) {
				return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) &&
					m.role === 'user' && !m.isBackgroundTask;
			});
		}
		if (userIdx === -1) {
			userIdx = this.state.messages.findIndex(function (m) {
				return m.isPendingInProcess && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue;
			});
		}
		if (userIdx === -1) {
			userIdx = this.state.messages.findIndex(function (m) {
				return m.isPendingQueued && m.role === 'user' && !m.isBackgroundTask && !m._useBgQueue;
			});
		}
		if (serverId && this.cancelledServerIds.has(serverId)) {
			this.cancelledServerIds.delete(serverId);
			if (userIdx >= 0) {
				var ex = this.state.messages[userIdx];
				this.state.messages[userIdx] = { role: 'user', content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId };
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

	onQueuedSendResponse(_composed: string, response: any, platform: string, serverId?: string): void {
		if (serverId) this.historyItemPolls.delete(serverId);
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
		this.host.scrollToBottom(true);
	}

	onQueuedSendError(_composed: string, err: any, serverId?: string): void {
		var self = this;
		if (serverId) this.historyItemPolls.delete(serverId);
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
			this.promoteNextQueuedToRunning(); this.updateHistoryCache(); this.host.notify(); this.host.scrollToBottom(true);
			return;
		}
		var targetIdx = this.resolveQueuedUserBubble(serverId);
		if (targetIdx === undefined) { this.host.notify(); this.updateHistoryCache(); return; }
		this.insertAtTarget({ role: 'assistant', content: getErrorMessage(err), isError: true }, targetIdx);
		this._removeStrayPendingAssistants();
		this.promoteNextQueuedToRunning(); this.updateHistoryCache(); this.host.notify(); this.host.scrollToBottom(true);
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
				var qi = self.bgTaskQueue.findIndex(function (e) { return e.id === serverId; });
				if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
				var removeIdx = self.state.messages.findIndex(function (m) {
					return m._serverItemId === serverId && (m.isPendingQueued || m.isPendingInProcess) && m.role === 'user';
				});
				if (removeIdx !== -1) {
					self.state.messages[removeIdx] = { role: 'user', content: self.state.messages[removeIdx].content, isCancelled: true, _serverItemId: serverId };
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
		this.host.scrollToBottom(true);
		return Promise.resolve(pending).catch(function () { }).then(function () {
			if (token !== self.state.gateRefreshToken) return;
			self.state.sending = false;
			return Promise.resolve(self.typewriteLatestReply(key)).then(function () { self.host.scrollToBottom(true); });
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
		var idx = this.state.messages.findIndex(function (m) { return m.isPending && m._serverItemId === itemId; });
		if (idx !== -1) {
			// A bg "Indexing:" turn pushes a user bubble (isPendingInProcess) ALONGSIDE
			// the assistant Thinking; replacing only the assistant leaves that user
			// bubble stuck pending — and drainBgTaskQueue then never clears its queue
			// entry (its stillPending check stays true). Un-pend it here too.
			this._clearPendingUserBubble(itemId);
			if (isErr) {
				this.state.messages[idx] = { role: 'assistant', content: answer, isError: true, _serverItemId: itemId };
				this.host.notify(); this.updateHistoryCache(); return;
			}
			var lid = this._newLocalId();
			this.state.messages[idx] = { role: 'assistant', content: '', _localId: lid, _serverItemId: itemId };
			this.host.notify(); this.enqueueTypewrite(idx, answer || 'No text response received from AI provider.', lid);
			this.updateHistoryCache(); return;
		}
		var userIdx = this.state.messages.findIndex(function (m) {
			return m.role === 'user' && m._serverItemId === itemId && (m.isPendingQueued || m.isPendingInProcess);
		});
		if (userIdx === -1) return;
		var ex = this.state.messages[userIdx];
		this.state.messages[userIdx] = { role: 'user', content: ex.content, _serverItemId: itemId };
		if (isErr) {
			this.state.messages.splice(userIdx + 1, 0, { role: 'assistant', content: answer, isError: true, _serverItemId: itemId });
			this.host.notify(); this.updateHistoryCache(); return;
		}
		var lid2 = this._newLocalId();
		this.state.messages.splice(userIdx + 1, 0, { role: 'assistant', content: '', _localId: lid2, _serverItemId: itemId });
		this.host.notify(); this.enqueueTypewrite(userIdx + 1, answer || 'No text response received from AI provider.', lid2);
		this.updateHistoryCache();
	}

	// Inject "Indexing: <file>" bubbles for queued bg tasks + attach their polls.
	drainBgTaskQueue(): void {
		var self = this;
		var id = this.host.getIdentity();
		var svcId = id.serviceId, plat = id.platform;
		if (!svcId || plat === 'none' || !this.host.isViewMounted()) return;
		for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
			var e = this.bgTaskQueue[i];
			if (e.serviceId !== svcId || e.platform !== plat) continue;
			var present = this.state.messages.some(function (m) { return m._serverItemId === e.id; });
			var stillPending = this.state.messages.some(function (m) {
				return m._serverItemId === e.id && (m.isPending || m.isPendingInProcess || m.isPendingQueued);
			});
			if (present && !stillPending) this.bgTaskQueue.splice(i, 1);
		}
		this.bgTaskQueue.forEach(function (entry) {
			if (entry.serviceId !== svcId || entry.platform !== plat) return;
			if (self.state.messages.some(function (m) { return m._serverItemId === entry.id; })) return;
			var isRunning = entry.status === 'running';
			var userBubble: ChatMessage = { role: 'user', content: self.host.formatIndexingLabel(entry.filename, entry.mime, entry.size, entry.storagePath, entry.isReindex), isBackgroundTask: true, _serverItemId: entry.id };
			if (isRunning) userBubble.isPendingInProcess = true; else userBubble.isPendingQueued = true;
			self.state.messages.push(userBubble);
			if (isRunning) {
				self.state.messages.push({ role: 'assistant', content: '', isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: entry.id });
			}
			self.host.notify(); self.updateHistoryCache(); self.host.scrollToBottom(false);
			if (!self.historyItemPolls.has(entry.id) && typeof entry.poll === 'function') {
				self.historyItemPolls.set(entry.id, true);
				var capturedId = entry.id, capturedPlat = plat;
				entry.poll({ latency: POLL_INTERVAL }).then(function (response: any) {
					self.handleHistoryItemResolution(capturedId, response, capturedPlat);
				}).catch(function (err: any) {
					self.historyItemPolls.delete(capturedId);
					var isNotExists = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
					var bi = self.state.messages.findIndex(function (m) { return m.isPending && m._serverItemId === capturedId; });
					if (bi !== -1) {
						if (isNotExists) self.state.messages.splice(bi, 1);
						else self.state.messages[bi] = { role: 'assistant', content: getErrorMessage(err), isError: true, isBackgroundTask: true, _serverItemId: capturedId };
						self.host.notify(); self.updateHistoryCache();
					}
				}).then(function () {
					var qi = self.bgTaskQueue.findIndex(function (q) { return q.id === capturedId; });
					if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
				});
			}
		});
		this.promoteNextBgQueuedToRunning();
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
				if (typeof item.queue_name === 'string' && item.queue_name.slice(-BG_INDEXING_QUEUE_SUFFIX.length) === BG_INDEXING_QUEUE_SUFFIX) {
					var userText = extractLastUserTextFromRequest(item.request_body);
					if (typeof userText === 'string' && userText.indexOf('A new file has just been uploaded') === 0) item._isBgTask = true;
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

			if (fetchMore) {
				self.state.messages = mapped.concat(self.state.messages);
			} else {
				if (self.state.typing) self.state.typingAbort = true;
				var serverIds: any = {};
				mapped.forEach(function (m: any) { if (m._serverItemId) serverIds[m._serverItemId] = 1; });
				var locallyCancelled: any = {};
				self.state.messages.forEach(function (m) { if (m.isCancelled && m._serverItemId) locallyCancelled[m._serverItemId] = 1; });
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
				self.state.messages = mapped;
				rescued.forEach(function (m) { self.state.messages.push(m); });
				if (Object.keys(locallyCancelled).length) {
					for (var ci = 0; ci < self.state.messages.length; ci++) {
						var c = self.state.messages[ci];
						if (!c._serverItemId || !locallyCancelled[c._serverItemId] || c.isCancelled) continue;
						self.state.messages[ci] = { role: 'user', content: c.content, isCancelled: true, _serverItemId: c._serverItemId };
						if (ci + 1 < self.state.messages.length && self.state.messages[ci + 1].isPending && self.state.messages[ci + 1]._serverItemId === c._serverItemId) {
							self.state.messages.splice(ci + 1, 1);
						}
					}
				}
			}
			self.state.historyEndOfList = !!(history && history.endOfList);
			self.state.historyStartKeyHistory = history && Array.isArray(history.startKeyHistory) ? history.startKeyHistory : [];
			var clearedAt = self.host.getClearedAt();
			if (clearedAt && chatList.length > 0) {
				var oldestUpdated = Number(chatList[chatList.length - 1] && chatList[chatList.length - 1].updated);
				if (isFinite(oldestUpdated) && oldestUpdated <= clearedAt) self.state.historyEndOfList = true;
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
					self.historyItemPolls.set(item.id, true);
					var capturedId = item.id;
					var pp = item.poll({
						latency: POLL_INTERVAL,
						onResponse: function (response: any) { self.handleHistoryItemResolution(capturedId, response, platform); },
						onError: function (err: any) {
							self.historyItemPolls.delete(capturedId);
							var isNotExists = err && (err.code === 'NOT_EXISTS' || (err.body && err.body.code === 'NOT_EXISTS'));
							var aIdx = self.state.messages.findIndex(function (m) { return m.isPending && m._serverItemId === capturedId; });
							if (isNotExists) {
								var isBg = aIdx !== -1 ? !!self.state.messages[aIdx].isBackgroundTask : false;
								if (aIdx !== -1) self.state.messages.splice(aIdx, 1);
								if (!isBg) {
									var uIdx = self.state.messages.findIndex(function (m) { return m.role === 'user' && m._serverItemId === capturedId && !m.isCancelled; });
									if (uIdx !== -1) { var ex = self.state.messages[uIdx]; self.state.messages[uIdx] = { role: 'user', content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId }; }
									self.cancelledServerIds.delete(capturedId); self.promoteNextQueuedToRunning();
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
					if (pp && pp.catch) pp.catch(function () { });
				});
				self.drainBgTaskQueue();
			}

			if (!fetchMore) return self.host.scrollToBottom();
		}).catch(function (err: any) {
			console.warn('[chat-engine] getChatHistory failed', err);
		}).then(function () {
			if (self.state.historyRequestToken === token) {
				var wasLoading = self.state.loadingHistory || self.state.loadingOlderHistory;
				self.state.loadingHistory = false; self.state.loadingOlderHistory = false;
				if (wasLoading) self.host.notify();
			}
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
