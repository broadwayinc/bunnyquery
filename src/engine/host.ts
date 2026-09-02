/**
 * ChatSession host adapter + state types.
 *
 * ChatSession is DOM-free and Vue-free; the consumer (bunnyquery widget or the
 * agent.vue chatbox) implements `ChatHost` to bridge identity, rendering, scroll,
 * and the skapi cancel/refresh surface. Everything the session needs that would
 * otherwise touch the DOM or a framework goes through a host hook.
 */

export interface ChatIdentity {
	projectId: string;
	/**
	 * The PUBLIC project ID: the formatted two-segment token (skapi.project_id).
	 * projectId above is the RAW regional code the wire endpoints take; the public
	 * token is what MCP tools accept and what prompts must show the model, since the
	 * model copies it verbatim into tool calls. Optional for older hosts; prompts
	 * fall back to the raw code when absent.
	 */
	publicProjectId?: string;
	owner: string;
	/** Per-user queue name (falls back to projectId). */
	userId: string;
	/**
	 * This chat is being used by a visitor with NO account, on a project whose
	 * owner allows that.
	 *
	 * It changes where the MCP tools point. A signed-in turn goes to the MCP
	 * server's root endpoint and authenticates with the caller's own token; an
	 * anonymous turn has no token to send, and an EMPTY one is worse than none
	 * (the server cannot identify a project from it, and an empty credential may
	 * be rejected by the provider before the request is even made). So an
	 * anonymous turn goes to the project-scoped endpoint instead, which is
	 * read-only, restricted to public records, and needs no credential at all.
	 */
	anonymous?: boolean;
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
	/** Mapped from an item delivered by the bg chain of the split history fetch
	 *  (stubs or deferred chats). Surface-frontier logic (retention boundary,
	 *  clear-horizon) skips these — their ids reach arbitrarily deep. */
	_fromBgChain?: boolean;
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
	/** PROTOCOL + PRESENTATIONAL: this bubble is being painted from a LIVE stream.
	 *
	 *  It sits alongside `isPending`, never instead of it. The bubble is still the
	 *  turn's "Thinking..." placeholder as far as every queue mechanism is concerned
	 *  (_ownThinkingIndex, resolveQueuedUserBubble, typewriteLatestReply and the
	 *  stray-pending sweep all find their target by isPending), and clearing that flag
	 *  to mean "it has text now" would strand the turn's real answer beside an orphan.
	 *  What this adds is the one thing those mechanisms do not care about and the VIEW
	 *  does: `content` is already worth rendering, so draw the text instead of the
	 *  spinner.
	 *
	 *  Cleared the moment the turn settles, BEFORE the authoritative answer replaces
	 *  the live text: from that instant the bubble is an ordinary reply being typed.
	 *  The partially painted `content` is deliberately left in place across that clear,
	 *  because it is what the typewriter resumes from instead of replaying from zero.
	 *
	 *  Also read by shouldRescueInFlightMessage: a streaming bubble that has no server
	 *  id yet is unrepresentable in a freshly fetched page, so it must survive the
	 *  merge or its stream is orphaned with nothing left to paint into. */
	_streaming?: boolean;
	/**
	 * This turn's row is TERMINAL but carries no stored answer, because the answer
	 * was streamed and nobody ever finalized it: the bytes are in the chunk store,
	 * not on the row. The bubble's `content` is therefore UNKNOWN, not empty.
	 *
	 * That distinction is the whole of the fix for two bugs that looked unrelated.
	 * A refetch landing in the window between the row going 'resolved' and finalize
	 * storing the body used to ERASE the answer off the screen (the server copy has
	 * no content, so the merge dropped the local bubble that did); and a turn that
	 * settled while no poll was attached (closed tab, slept device) used to be
	 * unrecoverable, because the mapper emitted no assistant bubble at all for a
	 * terminal-but-empty row. Both are the same question, "what should the merge
	 * believe when the server copy is authoritative but empty", and the answer is
	 * this flag: an unknown answer NEVER overwrites a known one, and an unknown one
	 * left over after the merge is resolved by reading the chunks back
	 * (ChatSession.recoverStreamedAnswer).
	 *
	 * For a view it is a rendering hint and nothing more: a bubble carrying it with
	 * empty content is being fetched, so draw whatever this client draws for a
	 * loading answer. A host that ignores it renders an empty bubble for the second
	 * or two the recovery takes, which is what it would have rendered anyway.
	 *
	 * WHEN IT COMES OFF, because that is the half that loses answers. It comes off
	 * for a FACT about the turn and never for an event in the client: an answer was
	 * recovered and written in, or the chunks were read and were genuinely empty (in
	 * which case the empty bubble is removed as well, restoring the list the mapper
	 * used to produce). It stays ON when the read FAILED, when the read was STOPPED,
	 * and when a live turn settled having painted nothing - three states that say
	 * nothing whatever about the turn, and in which the chunks are all still there.
	 * A marker cleared on one of those is an answer nothing will ever go back for,
	 * so a host may see the same bubble marked across several loads while the reads
	 * keep failing; that is the recoverable state, not a stuck one.
	 */
	_streamPending?: boolean;
	/**
	 * IS ANYTHING ACTUALLY DRIVING THIS BUBBLE RIGHT NOW? The second half of
	 * `_streamPending`, and the half a view cannot do without.
	 *
	 * `_streamPending` says the answer is elsewhere; it does NOT say somebody is on
	 * their way to fetch it, and the two are different states that used to render
	 * identically. Recovery is capped per history load (STREAM_RECOVERY_PER_LOAD),
	 * so the third and later marked turns on a page are marked and nobody is reading
	 * them; a read that FAILED leaves the marker on with the attempt forgotten, which
	 * is also nobody. Both drew the same loader as a live turn, so a bubble could
	 * spin for the rest of the session with nothing behind it - the one thing a
	 * spinner must never do, because it is a promise that something is coming.
	 *
	 * Three states, and only the first of them may draw a spinner:
	 *   'active'   a chunk read is in flight or queued for this turn. Something IS
	 *              coming; the loader is honest.
	 *   'failed'   the last read failed. Nothing is coming until somebody asks
	 *              again, so the view owes the reader a way to ask.
	 *   undefined  nothing has been tried, or the attempt is over. Same obligation.
	 *
	 * Written by the engine only, and never persisted anywhere: it describes THIS
	 * session's fetching, not the turn. A fresh history page therefore arrives
	 * without it, and _adoptLocalAnswers re-stamps the page's still-marked bubbles
	 * from the session's own bookkeeping, so a reload during a read does not turn a
	 * live loader into a button (and back a second later).
	 *
	 * Read it through streamRecoveryPhase(msg), never directly: the phase folds in
	 * "does this bubble need the affordance at all", and both clients must not
	 * answer that twice.
	 */
	_streamRecovery?: 'active' | 'failed';
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
	// History cache key (`projectId#platform`) this bubble was created under.
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
	/** A deferred bg stub batch (first-paint split fetch) is still in flight;
	 *  views show a small 'loading indexing history' hint while true. */
	bgHistoryLoading: boolean;
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
	/**
	 * A list refresh just changed heights: put the reader back where they were.
	 *
	 * Called at BOTH moments a first-page refresh moves things — the surface page
	 * landing, and the deferred background-indexing batch merging on top of it a
	 * round trip later — because leaving a wrong position on screen between the two
	 * is what reads as "the scroll jumped, then travelled somewhere else".
	 *
	 * The view owns the decision (it is the only side that can measure): pinned to
	 * the bottom means the bottom AFTER the batch merged, anywhere else means the
	 * exact line the reader was on. Falls back to scrollToBottomIfSticky when a host
	 * does not implement it, which is the old behaviour.
	 */
	settleScroll?(): void;

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
	/**
	 * The access group this file's records must be written at: the uploader's
	 * choice, which is the project default or a per-upload answer.
	 *
	 * Asked PER FILE, and asked AFTER ensureFileIndexRecord has run, because the
	 * host is what actually creates the "src::" record and it must report the
	 * group it really used. The engine threads the answer into the indexing
	 * prompts so the agent's own records land in the same group; a record saved
	 * under a different group is in a different table and never comes back with
	 * the rest of the file.
	 *
	 * Optional and may return a promise. A host without it (or one that returns
	 * nothing) gets "authorized", which is what every record used before the
	 * setting existed.
	 */
	uploadAccessGroup?(storagePath: string): 'public' | 'authorized' | 'private' | undefined | Promise<'public' | 'authorized' | 'private' | undefined>;
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
