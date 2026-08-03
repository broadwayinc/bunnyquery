/**
 * ChatSession host adapter + state types.
 *
 * ChatSession is DOM-free and Vue-free; the consumer (bunnyquery widget or the
 * agent.vue chatbox) implements `ChatHost` to bridge identity, rendering, scroll,
 * and the skapi cancel/refresh surface. Everything the session needs that would
 * otherwise touch the DOM or a framework goes through a host hook.
 */

export interface ChatIdentity {
	serviceId: string;
	owner: string;
	/** Per-user queue name (falls back to serviceId). */
	userId: string;
	platform: 'claude' | 'openai' | 'none';
	model?: string;
	serviceName?: string;
	serviceDescription?: string;
}

/**
 * Project context captured at the moment the user hit Send, so a turn whose
 * dispatch is delayed (attachment uploads are awaited first) still reaches the
 * project the question was asked of rather than whichever project the user has
 * navigated to by then. Both fields are identity-derived and must be snapshotted
 * together — the system prompt embeds the service name/description/id.
 */
export interface PinnedDispatchContext {
	identity: ChatIdentity;
	systemPrompt: string;
	/** Id returned by stageOutgoingMessage. The turn's bubble is already on
	 *  screen (staged while its attachments upload), so dispatchComposedMessage
	 *  REPLACES that bubble in place instead of pushing a second one at the
	 *  bottom — the message keeps the position it was sent in. */
	stageId?: string;
}

/**
 * The file a background-indexing bubble belongs to. Stamped on the REQUEST
 * bubble (both the live one and the one rebuilt from history) so the display
 * layer can group a file's many passes without reverse-parsing the view's
 * formatted label. See indexing_groups.buildChatDisplayList.
 */
export interface IndexingFileRef {
	name: string;
	/** Storage path, when known. Preferred group identity: a file can be
	 *  re-uploaded under a name that already exists elsewhere. */
	path?: string;
	mime?: string;
	size?: number;
	isReindex?: boolean;
	/** A CONTINUE pass. Its absence across every loaded pass is what tells the
	 *  display layer that earlier passes are still unpaged. */
	continued?: boolean;
}

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string; // raw markdown — never HTML (the view parses for display)
	isPending?: boolean;
	isPendingInProcess?: boolean;
	isPendingQueued?: boolean;
	isPendingOlder?: boolean;
	/** PROTOCOL flag: true from the moment a queued turn is dispatched until the
	 *  server acknowledges it. It is the token the ack's findIndex matches on, so
	 *  nothing may clear it early. It is NOT a style input — see _dimSending. */
	isSendingToServer?: boolean;
	/** PRESENTATIONAL flag: render this bubble dimmed because the turn has not been
	 *  handed over yet. Split from isSendingToServer because an ATTACHMENT turn is
	 *  un-dimmed the instant its files finish indexing, while the request itself is
	 *  still un-acked for another moment; dropping isSendingToServer to achieve that
	 *  would cost the turn its _serverItemId (the ack matches on that flag alone, and
	 *  a _useBgQueue turn is excluded from every fallback that would recover it). */
	_dimSending?: boolean;
	isCancelled?: boolean;
	isError?: boolean;
	isBackgroundTask?: boolean;
	/** Set on background-indexing REQUEST bubbles only (see IndexingFileRef). */
	_indexFile?: IndexingFileRef;
	/** Set on a background-indexing RESPONSE bubble whose raw answer carried the
	 *  INDEXING_COMPLETE marker. Stamped before the marker is stripped for display,
	 *  in every path that builds one (live resolution and both history mappers), so
	 *  a run reads the same before and after a reload.
	 *
	 *  Meaningful ONLY for a client-driven chain, where it is the very signal
	 *  maybeResumeIndexing stops on. The worker-driven paths (PDF vision, windowed
	 *  reads) advance off the renderer's page count and their prompt deliberately
	 *  never asks for the marker, so a model that emits one there is guessing —
	 *  which is how an 88-page file once "finished" at page 15. */
	_indexComplete?: boolean;
	_useBgQueue?: boolean;
	/** Local id of a turn STAGED at Send time while its attachments upload. The
	 *  bubble exists before any server request does, so it is never matched by
	 *  _serverItemId and is never promoted/cancelled by the queue machinery —
	 *  dispatchComposedMessage consumes it (pinned.stageId) when the turn is
	 *  finally sent. Staged bubbles are deliberately kept OUT of the history
	 *  cache: an unmount kills the upload that would resolve them, so a cached
	 *  copy would replay as a bubble that uploads forever. */
	_stageId?: string;
	/** Staged-turn phase 1: its files are still uploading. Renders
	 *  "(Uploading files...)", dimmed. */
	isUploadingAttachments?: boolean;
	/** Staged-turn phase 2: the files are up and the turn is waiting for the whole
	 *  background-indexing chain behind them to finish. Renders "(Indexing files...)",
	 *  still dimmed. Cleared (with _dimSending) by markStagedMessageReady the moment
	 *  the queue drains, which is when the turn genuinely becomes "(In queue)". */
	isAwaitingIndexing?: boolean;
	_serverItemId?: string;
	_localId?: string;
	_cancelling?: boolean;
	_cancelError?: string;
	/** Epoch ms shown as small text under the bubble. From the request history a
	 *  USER bubble carries the request's `created` time and an ASSISTANT bubble the
	 *  `updated` (response) time; a live bubble is stamped with the wall clock when
	 *  it is created, then reconciled to the server value on the next history load.
	 *  Absent while a turn is still pending, so no time shows on a "Thinking" bubble. */
	_ts?: number;
	// History cache key (`serviceId#platform`) this bubble was created under.
	// Stamped on LOCALLY-created bubbles only (the optimistic user message and
	// its "Thinking..." placeholder); server-mapped bubbles are identified by
	// _serverItemId instead. The dashboard renders every project through ONE
	// ChatSession singleton, so without this a bubble is unattributable and an
	// in-flight turn from project A gets rescued/cached into project B.
	_ownerKey?: string;
}

export interface ChatState {
	messages: ChatMessage[];
	/** Pending/uploaded attachment objects (view-shaped); the engine mutates
	 *  status/progress during upload, the view renders them. */
	attachments: any[];
	uploadingAttachments: boolean;
	sending: boolean;
	typing: boolean;
	typingAbort: boolean;
	loadingHistory: boolean;
	loadingOlderHistory: boolean;
	historyEndOfList: boolean;
	historyStartKeyHistory: string[];
	historyRequestToken: number;
	gateRefreshToken: number;
	/** Files the SERVER still has unresolved indexing work for, by the key a
	 *  collapsed row uses (storage path, else filename). Lives on the state rather
	 *  than privately so a reactive consumer re-renders when it changes. */
	liveIndexKeys: { [fileKey: string]: boolean };
	/** Whether `liveIndexKeys` has been answered at least once for this chat. False
	 *  means "we have not found out", which the display layer reads as still
	 *  working — never as an all-clear. */
	liveIndexChecked: boolean;
	/** Server item ids of the indexing passes that existed — on the row, or on the
	 *  bg queue — when the user STOPPED that file. Two readers, one fact:
	 *  buildChatDisplayList reports the run as stopped when it holds any of them
	 *  (a stop routinely leaves no other trace), and _applyIndexCancellations
	 *  refuses to let one of them lift the stop the way a genuinely new indexing
	 *  request does. Ids, not file keys: they name the RUN that was stopped, so a
	 *  later re-index of the same file cannot inherit it. On the state, like
	 *  liveIndexKeys, so a reactive consumer re-renders the moment a stop is
	 *  recorded — a stop with nothing left to cancel changes no message at all. */
	stoppedIndexIds: { [serverItemId: string]: boolean };
}

export interface ChatHost {
	/** Read live (platform/model/name can change between sends). */
	getIdentity(): ChatIdentity;
	/** The chat system prompt (consumer-built; agent.vue uses a formatted id). */
	buildSystemPrompt(): string;

	// --- render / scroll (the ONLY view surface) ---
	/** Re-render the whole message list (coalesced). */
	notify(): void;
	/** Re-render a single message bubble in place (typewriter ticks). */
	refreshMessageBubble(idx: number): void;
	scrollToBottom(smooth?: boolean): Promise<void> | void;
	/** Scroll only if the user is pinned to the bottom (does not force-pin). */
	scrollToBottomIfSticky(smooth?: boolean): Promise<void> | void;
	/** A history page finished loading and rendering. OPTIONAL. The view uses it
	 *  to page further when the message box came out too short to scroll — the
	 *  only trigger for loading older history is a scroll to the top, so a box
	 *  that cannot scroll has no way to reach page 2 (see viewport_fill). Only
	 *  the view can measure that, which is why the engine merely announces it. */
	onHistoryLoaded?(fetchMore: boolean, token: number): void;

	// --- skapi surface beyond configureChatEngine() ---
	cancelRequest(opts: {
		url: string; method: string; id: string; queue: string; service: string; owner: string;
	}): Promise<{ removed?: boolean; message?: string } | any>;
	refreshSession(): Promise<boolean>;

	// --- bg-indexing display ---
	/** Build the "Indexing:/Reindexing: …" label (view-side display formatting). */
	formatIndexingLabel(name: string, mime?: string, size?: number | null, storagePath?: string, reindex?: boolean, continued?: boolean): string;
	/** drainBgTaskQueue is a no-op until the chat view is mounted. */
	isViewMounted(): boolean;

	/** Clear-horizon timestamp (localStorage, per service#platform) — view-owned. */
	getClearedAt(): number;

	// --- attachment upload I/O (consumer-specific bytes path: agent.vue uses the
	//     Service class, bunnyquery uses get-signed-url). The session owns the
	//     upload ORCHESTRATION (per-member loop, overwrite/reindex flow, indexing,
	//     status lifecycle); these hooks do the actual I/O + chip rendering. ---
	uploadFile(args: {
		file: File;
		storagePath: string;
		checkExistence: boolean;
		onProgress?: (p: any) => void;
		setAbort?: (abort: () => void) => void;
	}): Promise<any>;
	/** Mint a temporary CDN URL for a stored file. */
	getTemporaryUrl(storagePath: string): Promise<string>;
	/** Delete a file's AI-index record ("src::<storagePath>") ahead of a
	 *  reindex/overwrite so the agent re-creates it fresh instead of colliding/
	 *  duplicating. The skapi backend cascades a src:: delete to the record's
	 *  reference-linked children. OPTIONAL — hosts that don't implement it fall
	 *  through to a plain re-index. Implementations must be best-effort (swallow
	 *  "not found" / permission errors so indexing still proceeds). */
	deleteExistingFileRecord?(storagePath: string): Promise<any>;
	/**
	 * Create the file's "src::<storagePath>" record before indexing starts, so every pass has a
	 * reference target that exists. Optional: a host without it keeps the old behaviour, where
	 * whichever pass got there first created the record and the others hoped it had.
	 */
	ensureFileIndexRecord?(storagePath: string, meta?: { name?: string; mime?: string; size?: number }): Promise<any>;
	/** Map a relative path to the consumer's db storage key (e.g. uid-prefixed). */
	storagePathFor(relPath: string): string;
	getMimeType(name: string): string | null;
	/** Non-dismissible "file exists" prompt → skip, keep+reindex, or overwrite. */
	promptOverwrite(filename: string): Promise<'overwrite' | 'reindex' | 'skip'>;
	/** Clear the "apply to all" overwrite choice at the start of a batch. */
	resetOverwriteBatch(): void;
	/** Re-render the attachment chip row (progress / status). */
	renderAttachmentChips(): void;
	/** Enable/disable composer controls during an upload batch. */
	updateComposerControls(): void;
}
