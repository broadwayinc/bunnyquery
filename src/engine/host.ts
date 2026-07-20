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
}

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string; // raw markdown — never HTML (the view parses for display)
	isPending?: boolean;
	isPendingInProcess?: boolean;
	isPendingQueued?: boolean;
	isPendingOlder?: boolean;
	isSendingToServer?: boolean;
	isCancelled?: boolean;
	isError?: boolean;
	isBackgroundTask?: boolean;
	_useBgQueue?: boolean;
	_serverItemId?: string;
	_localId?: string;
	_cancelling?: boolean;
	_cancelError?: string;
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

	// --- skapi surface beyond configureChatEngine() ---
	cancelRequest(opts: {
		url: string; method: string; id: string; queue: string; service: string; owner: string;
	}): Promise<{ removed?: boolean; message?: string } | any>;
	refreshSession(): Promise<boolean>;

	// --- bg-indexing display ---
	/** Build the "Indexing:/Reindexing: …" label (view-side display formatting). */
	formatIndexingLabel(name: string, mime?: string, size?: number | null, storagePath?: string, reindex?: boolean): string;
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
