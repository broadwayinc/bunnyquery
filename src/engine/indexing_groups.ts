/**
 * Background file-indexing turns, collapsed into ONE row per file.
 *
 * A single upload can produce many chat turns: the first "Indexing: <file>" pass
 * plus up to MAX_INDEXING_RESUME_PASSES CONTINUE passes, each with its own
 * request AND response bubble. Rendered flat, that reads as the same task
 * repeating forever, and any real question the user asks in between gets buried.
 *
 * buildChatDisplayList turns the flat message array into a DISPLAY list in which
 * every message belonging to one run of one file (however far apart the passes
 * sit, and whatever else is interleaved between them) is represented by a single
 * group entry, rendered at the position of that run's FIRST loaded pass.
 *
 * First, not newest. The message array is ordered by request CREATION time, and
 * a run's later passes are created one at a time as the previous one resolves —
 * by the client for the paged text path, and by the WORKER itself for the
 * rendered-page (PDF) path, which the client only learns about on its next
 * first-page history fetch. So a pass is routinely created minutes after the
 * upload, on a queue that runs in parallel with the foreground chat. Anchoring
 * at the newest pass meant one such late pass dragged the whole run — every
 * earlier pass with it — below any question the user had asked in the meantime,
 * and made a run that had visibly finished before the question render after it.
 * Anchoring at the first pass puts the row where the run actually began, which
 * is a position no later pass can change:
 *   - a new pass never relocates the row, so nothing under the reader shifts;
 *   - a question asked after the upload always renders below the row, which is
 *     the order it happened in.
 * The cost is that a long-running index does not follow the conversation to the
 * bottom: once the user has chatted past the upload, the spinner and the Stop
 * button sit above their newest turns. That is a scroll away, and the row no
 * longer lies about when the work started.
 *
 * Paging older history is the one thing that CAN move the row: an older page
 * carrying earlier passes of a run already on screen moves it up into that page.
 * That happens at most once per run, only for a run whose start was never
 * loaded (`mayHaveOlder`), and it is the same event that already re-derives
 * `runKey` — so the view treats it as a new row either way.
 *
 * The group deliberately reports no authoritative pass TOTAL. History is paged
 * newest-first, so any total computed from loaded messages is a lower bound that
 * a later scroll-up would contradict. It reports STATE (indexing / indexed /
 * failed), how many passes are currently loaded, and `mayHaveOlder` when the
 * file's first pass is not among them.
 *
 * For the same reason it also reports NOT KNOWING. A run whose start is still
 * being paged in, and a worker-driven run whose queue state has not been asked
 * for yet, are both rows whose state is a moving target — and on a chatbox that
 * was just opened, that is most of them. `resolving` marks those, so the view can
 * say which wait it is waiting on rather than committing to "indexing" or
 * "indexed" on a fraction of the evidence.
 *
 * Pure and view-agnostic: agent.vue and the BunnyQuery widget both render from
 * this, so the two stay identical.
 */
import type { ChatMessage, IndexingFileRef } from './host';
import { isPagedReadFile, isImageVisionFile } from './office';
import { windowedIndexingEnabled } from './config';
import { MAX_INDEXING_RESUME_PASSES } from './requests';

export type IndexingGroupStatus = 'active' | 'done' | 'error' | 'cancelled';

export type IndexingGroup = {
	/** The FILE this row is about: storage path when known (a file can be
	 *  re-uploaded under a name that already exists elsewhere), else name. Shared
	 *  by every run of that file, and what ChatSession.cancelIndexingGroup and
	 *  _indexKeyOf match on — never use it as a render key.
	 *
	 *  It IS the key for persistent view state, above all the expansion state. That
	 *  used to be keyed by runKey, which is renamed the moment a run's true first
	 *  pass loads (see below) — so a row the user had opened silently closed itself
	 *  mid-indexing, every time a pass arrived ahead of the earlier ones. This never
	 *  changes for the life of a file. The cost is that two runs OF THE SAME FILE
	 *  (an index and a later re-index) open and close together, which is a fair
	 *  reading of "show me this file's steps" and is not a state the user can be
	 *  surprised out of. */
	key: string;
	/** Identity of this ROW: one indexing RUN of that file. A file indexed on
	 *  Monday and re-indexed on Wednesday is two runs, and collapsing them into
	 *  one row erased Monday's from Monday's place in the conversation, claimed
	 *  its passes for Wednesday, and let Monday's failure be overwritten by
	 *  Wednesday's success. Named after the run's FIRST loaded pass (see where it
	 *  is assigned below), so passes appended to the run and other runs appearing
	 *  on either side of it never rename a row already on screen.
	 *
	 *  This is the RENDER key, and only that. It is renamed when the run's true
	 *  first pass finally loads — routine while a worker-driven chain is running,
	 *  since a pass adopted from the queue can reach the client before the earlier
	 *  ones are paged in — and a rename is exactly right for a DOM key (the row did
	 *  change identity) but wrong for anything the USER set. Key that on `key`. */
	runKey: string;
	name: string;
	path?: string;
	mime?: string;
	size?: number;
	/** True when any loaded pass was a re-index of an already-stored file. */
	isReindex: boolean;
	/** Every message of this file, in chat order, with its index in the source
	 *  array (so cancel/typewriter paths keep addressing the real message). */
	members: { msg: ChatMessage; index: number }[];
	/** Indexing passes LOADED (request bubbles), never a server-side total. */
	passCount: number;
	status: IndexingGroupStatus;
	/** Server item ids of the passes that are still queued/running, so the row can
	 *  offer a stop button (ChatSession.cancelIndexingGroup cancels each). Empty
	 *  when nothing is cancellable — a finished file, or a live pass whose server
	 *  id has not come back yet. */
	cancellableIds: string[];
	/** This row is in the middle of stopping: a cancel request is in flight for one
	 *  of its passes, or the user stopped the run and a pass is still running. Both
	 *  mean the same thing to a view — the Stop has been spent, so the button reads
	 *  "Stopping..." and is not offered again. */
	cancelling: boolean;
	/** The user stopped this run.
	 *
	 *  NOT the same as `status === 'cancelled'`, and the difference is the whole
	 *  reason it exists: a stop landing on a pass that is already RUNNING cannot
	 *  un-run it, so the row stays `active` until that pass settles. `status` then
	 *  describes the work (something is still running) and this describes the user's
	 *  decision (no more of it will be started). */
	stopped: boolean;
	/** Why the last cancel attempt failed (e.g. the pass had already finished). */
	cancelError?: string;
	/** The file's first pass is not among the loaded messages, so earlier passes
	 *  exist in history that has not been paged in yet. */
	mayHaveOlder: boolean;
	/** Position in the source array this collapsed row renders at: the index of
	 *  the run's FIRST loaded pass (see the file docstring for why not the last). */
	anchorIndex: number;
	/** Identity of the turn at `anchorIndex` — its server item id, or its local id
	 *  while it has none, or `''` when it has neither. The views stamp this on the
	 *  row (`data-row-pos`) so the scroll anchor can tell a row that RELOCATED (an
	 *  older page moved the run's start) from one that merely gained a pass. They
	 *  must not re-derive it from `members`: which member the row renders at is
	 *  this module's decision, and the two silently disagreed once already. */
	anchorId: string;
	/** `members` minus the turns an EXPANDED row should not show: every CONTINUE
	 *  request, and the running pass's empty placeholder.
	 *
	 *  A continuation's request bubble says "Indexing (continuing) <file>" and
	 *  nothing else — it repeats the row's own header once per pass, so a long file
	 *  read as the same line over and over with the actual findings buried between
	 *  them. The pass is still represented, by its RESPONSE. The placeholder goes
	 *  for a different reason: the row now carries one loader of its own for as long
	 *  as work remains, and two spinners in one open row is noise.
	 *
	 *  Additive. `members` is untouched and is still what every count, status,
	 *  cancel and anchor decision reads — several of them are only correct on the
	 *  full list (a `mayHaveOlder` run's members[0] IS a continuation). */
	visibleMembers: { msg: ChatMessage; index: number }[];
	/** Who advances this file's chain, which decides what can confirm it is over:
	 *  'single' one pass and done; 'client' this client dispatches each CONTINUE
	 *  pass and stops on the model's completion marker; 'worker' the server advances
	 *  the loop off the renderer's page count and the client is only a spectator. */
	driver: 'single' | 'client' | 'worker';
	/** Positively established that no further indexing work will happen for this
	 *  run. NOT "the file was fully read" — a cap-out, a failure and a stop are all
	 *  finished, and the row's own status says which.
	 *
	 *  False means "not established", which includes "still running" AND "we have
	 *  not been able to find out". The view shows a loader for both, deliberately:
	 *  the alternative default is the failure this exists to prevent, a row that
	 *  reads "Indexed" between two passes of a file still being read. */
	finished: boolean;
	/** This row cannot honestly claim a state yet, because something it is derived
	 *  FROM is still being fetched. Both `status` and `finished` are read off the
	 *  passes that happen to be LOADED, and on a freshly opened chatbox that is a
	 *  moving target: history pages newest-first, so a long run arrives as a tail
	 *  of CONTINUE passes while its beginning is still being paged in. The row was
	 *  picking a side through that window — a spinner reading "Indexing" for a file
	 *  that finished last week, or a green "Indexed" for one still being read — and
	 *  both are verdicts drawn from a fraction of the run.
	 *
	 *  Only ever set from status 'done'. A loaded pending pass PROVES the run is
	 *  live, and an error or a stop is the newest pass's own outcome, which
	 *  newest-first paging always has in hand — none of those is a guess, and
	 *  hiding any of them behind a loader would lose something the user needs.
	 *
	 *  For the 'history' reason this means "a fetch is IN FLIGHT", not "the picture
	 *  is incomplete". Older history is paged in by explicit triggers only (the
	 *  viewport fill, the user scrolling to the top) and nothing auto-fetches on a
	 *  row's behalf, so a run whose start is still unloaded once the paging stops
	 *  has to go back to reporting what it does know — `mayHaveOlder` and the `+` on
	 *  the pass count carry the rest. A "loading..." that never ends is the same lie
	 *  pointing the other way.
	 *
	 *  The 'status' reason is weaker on purpose: "the queue has not answered", which
	 *  a permanently failing query never resolves. That is deliberate, because it is
	 *  the SAME question as what the row should say when it cannot find out, and
	 *  every alternative is worse: a grey clock reading "checking" claims less than
	 *  the yellow spinner reading "Indexing" that it replaced. It also self-heals in
	 *  practice — the answer is re-sought on every first-page history load and every
	 *  settling pass — and gating it on an in-flight query instead would mean
	 *  threading a second liveness flag through a retry ladder with nine exit
	 *  points, i.e. trading this for a flag that can stick in the other direction. */
	resolving: boolean;
	/** Which wait, so the row can name it instead of just spinning. 'history':
	 *  older pages are being fetched and this run's first pass is not among the
	 *  loaded ones. 'status': the queue has not yet said whether this file is still
	 *  being worked on, which is the only thing that can end a worker-driven run. */
	resolvingReason?: 'history' | 'status';
	/** Synthesized from a durable run:: record: none of the run's passes are
	 *  among the loaded messages (bg history still deferred, or the run is older
	 *  than the paging cap). Header-and-status only — members/visibleMembers are
	 *  empty and there is nothing to cancel; the row is replaced by the real
	 *  group the moment actual passes load (same `key`, so expansion state
	 *  carries over). */
	stub?: boolean;
	/** The run:: record's stored error text, for a stub row's meta line. */
	stubError?: string;
};

export type DisplayEntry =
	| { kind: 'message'; msg: ChatMessage; index: number }
	| { kind: 'indexing'; group: IndexingGroup; index: number };

export type BuildDisplayListOptions = {
	/** True while older history remains unpaged, which is what makes a group
	 *  with no first pass genuinely incomplete rather than merely odd. */
	hasMoreHistory?: boolean;
	/** An OLDER-history fetch is in flight right now — a single page, or the whole
	 *  viewport-fill loop (createHistoryFiller's onRunningChange, which spans the
	 *  pages between which a per-request flag keeps dropping to false).
	 *
	 *  Older specifically. A first-page refresh cannot bring in a run's earlier
	 *  passes, so counting it here would flip every incomplete row to "still
	 *  loading" for the length of a poll that could never have answered it. */
	loadingOlderHistory?: boolean;
	/** Files the SERVER still has unresolved indexing work for, keyed exactly like
	 *  IndexingGroup.key (ChatSession.getLiveIndexState). */
	liveIndexKeys?: { [fileKey: string]: boolean };
	/** Whether `liveIndexKeys` has been answered at least once for this chat. False
	 *  is "we do not know", and a worker-driven run stays unfinished on it. */
	liveIndexChecked?: boolean;
	/** Files carrying the durable done:: completion marker (one prefix sweep),
	 *  keyed like IndexingGroup.key (storage path; the bare-name fallback keys
	 *  of very old prompts simply never match — they keep the queue inference).
	 *  A marker is PROOF the file was read to the end: it settles a worker-run
	 *  green without waiting for the queue answer, and it is never withheld by
	 *  the resolving logic. A live queue hit still outranks it (a re-index in
	 *  flight whose marker-cascade delete lagged). */
	doneKeys?: { [fileKey: string]: boolean };
	/** Server item ids of passes that were on a row when the user STOPPED it
	 *  (ChatSession.state.stoppedIndexIds). A run holding any of them is a run the
	 *  user stopped — see the status derivation for why a stop usually leaves no
	 *  other trace in the messages. Ids rather than a file key on purpose: they name
	 *  one RUN, so a later re-index of the same file cannot inherit the stop. */
	stoppedIndexIds?: { [serverItemId: string]: boolean };
	/** Whether the WORKER drives the windowed text/grid loop (chatEngineConfig's
	 *  windowedIndexing). Passed in rather than read from config so this stays a
	 *  pure function of its inputs and can be exercised for both settings. */
	windowedIndexing?: boolean;
	/** Durable run:: records, keyed by STORAGE PATH (the consumer's marker
	 *  sweep). Each key with no real group in the loaded messages gets a
	 *  synthesized header-only row (see IndexingGroup.stub), placed by its
	 *  `started` timestamp. A real group for the same file — matched by key,
	 *  path, or name — always suppresses the stub: loaded passes are evidence,
	 *  the record is only a summary. */
	runStubs?: { [storagePath: string]: RunStubInfo };
	/** The platform whose chat this list is for. run:: records are per-FILE,
	 *  but a chat is per (project, platform): a run started under Claude has
	 *  its passes in the Claude conversation and is invisible to the
	 *  OpenAI-scoped queue probe, so its stub could never be covered and never
	 *  be confirmed — it just sat there, in a chat it did not belong to.
	 *  Records minted before this was stamped carry no platform and are shown
	 *  in both, which keeps the leak to the historical set. */
	stubPlatform?: 'claude' | 'openai';
	/** The chat's clear-history horizon (ms epoch). Run records are service-
	 *  wide and know nothing about a cleared chat, so without this every
	 *  "Clear chat history" resurrects one row per indexed file. A stub whose
	 *  run ended (or, unfinished, began) at or before this moment is dropped —
	 *  unless the queue says the file is live RIGHT NOW, which no horizon can
	 *  make untrue. */
	stubClearedAt?: number;
	/** Clock injection for tests; defaults to Date.now(). Only run-stub
	 *  staleness reads it. */
	now?: number;
};

/** The display-relevant fields of a run:: record (see requests.ts
 *  runIndexUniqueId for the record's contract). */
export type RunStubInfo = {
	status: 'working' | 'done' | 'error' | 'cancelled';
	filename?: string;
	started?: number;
	finished?: number;
	error?: string;
	/** Chat that owns this run. Absent on records minted before it was
	 *  stamped; see BuildDisplayListOptions.stubPlatform. */
	platform?: 'claude' | 'openai';
};

/** Canonical form of an indexing key for COMPARISON only (never for storage).
 *
 *  The two sides of every stub-vs-group comparison come from one string but by two
 *  routes: the run:: record id keeps `attachment.storagePath` verbatim
 *  (requests.ts runIndexUniqueId), while the group's key is recovered from the pass
 *  prompt and trimmed on the way (history.ts parseIndexingRequestText). A path whose
 *  first or last character is whitespace therefore produced two keys for one file, the
 *  stub was never suppressed, and the file drew two rows.
 *
 *  Trim only. NOT NFC: both keys derive from the same string with no normalization on
 *  either side, so no NFC/NFD divergence is reachable here, and normalizing a key that
 *  is also an S3 object key elsewhere is how storage paths get silently renamed.
 */
export function canonIndexKey(s?: string): string {
	return typeof s === 'string' && s ? s.trim() : '';
}

/** A 'working' run record older than this with no live-queue confirmation is
 *  treated as unknown rather than live: a chain that died without reaching any
 *  error path leaves 'working' dangling, and a row must not spin forever on a
 *  claim nothing can end. */
export const RUN_RECORD_WORKING_STALE_MS = 6 * 60 * 60 * 1000;

// The indexing label is view-formatted (formatIndexingLabel), so parsing it is
// the FALLBACK path only: it exists for bubbles restored from a history cache
// written before `_indexFile` was stamped. Live and freshly-mapped bubbles carry
// the structured ref and never reach this.
//
// Shapes produced by formatIndexingLabel:
//   "Indexing: [name](path) · mime · 1.2 MB"
//   "Reindexing: name · mime"
//   "Indexing (continuing) [name](path)"
const INDEXING_LABEL_RE = /^(Re)?[Ii]ndexing(\s*\(continuing\))?\s*:?\s+(.+)$/;
const LEADING_MD_LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)/;

export function parseIndexingLabel(
	content: string,
): { name: string; path?: string; continued: boolean; isReindex: boolean } | null {
	if (typeof content !== 'string' || !content) return null;
	var firstLine = content.split('\n')[0].trim();
	var m = firstLine.match(INDEXING_LABEL_RE);
	if (!m) return null;
	// Only the first " · " segment is the file; the rest is mime/size trivia.
	var head = m[3].split(' · ')[0].trim();
	var link = head.match(LEADING_MD_LINK_RE);
	var name = link ? link[1].trim() : head;
	if (!name) return null;
	return {
		name: name,
		path: link ? link[2].trim() : undefined,
		continued: !!m[2],
		isReindex: !!m[1],
	};
}

/** The file a background-indexing bubble belongs to, structured ref preferred. */
function readFileRef(msg: ChatMessage): (IndexingFileRef & { continued: boolean }) | null {
	var ref = msg && msg._indexFile;
	if (ref && (ref.path || ref.name)) {
		return {
			name: ref.name || ref.path || '',
			path: ref.path,
			mime: ref.mime,
			size: ref.size,
			isReindex: ref.isReindex,
			continued: !!ref.continued,
		};
	}
	var parsed = parseIndexingLabel(msg && msg.content);
	if (!parsed) return null;
	return {
		name: parsed.name,
		path: parsed.path,
		isReindex: parsed.isReindex,
		continued: parsed.continued,
	};
}

function isPendingMsg(m: ChatMessage): boolean {
	return !!(m.isPending || m.isPendingInProcess || m.isPendingQueued || m.isSendingToServer);
}

/**
 * A member an EXPANDED row should not render. See IndexingGroup.visibleMembers.
 *
 * A CANCELLED continuation is an exception and stays: a cancelled item is given no
 * response bubble at all, so hiding its request would erase the only evidence that
 * the pass existed. A user bubble we cannot classify (it joined the run by server
 * id, not by a label we could parse) also stays — showing an unexpected turn is a
 * far smaller error than silently dropping one.
 */
function isHiddenPass(m: ChatMessage): boolean {
	if (m.role === 'user') {
		if (m.isCancelled) return false;
		var ref = readFileRef(m);
		return !!(ref && ref.continued);
	}
	return !!m.isPending;
}

/**
 * Collapse background-indexing turns into per-file groups.
 *
 * Messages that are not background-indexing pass through untouched, at their
 * original positions and with their original indices.
 */
export function buildChatDisplayList(
	messages: ChatMessage[],
	opts?: BuildDisplayListOptions,
): DisplayEntry[] {
	var list = Array.isArray(messages) ? messages : [];
	var liveIndexKeys = (opts && opts.liveIndexKeys) || {};
	var liveIndexChecked = !!(opts && opts.liveIndexChecked);
	var doneKeys = (opts && opts.doneKeys) || {};
	var stoppedIndexIds = (opts && opts.stoppedIndexIds) || {};
	var windowedIndexing = opts && opts.windowedIndexing !== undefined
		? !!opts.windowedIndexing
		: windowedIndexingEnabled();
	var hasMoreHistory = !!(opts && opts.hasMoreHistory);
	var loadingOlderHistory = !!(opts && opts.loadingOlderHistory);
	var stubPlatform = opts && opts.stubPlatform;

	// One entry per RUN (see IndexingGroup.runKey), addressed by an internal id
	// while the list is being walked; runKey is assigned at the end, once the
	// number of runs per file is known.
	var groups: { [runId: string]: IndexingGroup } = {};
	var order: string[] = [];
	var runOfIndex: (string | undefined)[] = new Array(list.length);
	// A response bubble carries no file metadata of its own; it is tied to its
	// request by the server item id, with the immediately preceding request as
	// the fallback for locally-pushed bubbles that have no id yet.
	var runByItemId: { [itemId: string]: string } = {};
	// Row already opened for a file NAME, so a pass that reports no storage path
	// joins it instead of opening a second row for the same file.
	var keyByName: { [name: string]: string } = {};
	// The run currently being accumulated for each file, every run of it, and the
	// file each run belongs to (a run id is opaque — a file key can contain any
	// character, so it must never be parsed back out of one).
	var openRunOfKey: { [key: string]: string } = {};
	var runsOfKey: { [key: string]: string[] } = {};
	var keyOfRun: { [runId: string]: string } = {};
	// Newest pass timestamp seen for each open run, so a FIRST pass can be told from a
	// re-index (it arrives AFTER the run it follows) apart from a misordered older pass
	// (it arrives before). Only the second must not re-open.
	var newestTsOfRun: { [runId: string]: number } = {};
	var runSeq = 0;

	for (var i = 0; i < list.length; i++) {
		var msg = list[i];
		if (!msg || !msg.isBackgroundTask) continue;

		var runId: string | undefined;
		var ref = msg.role === 'user' ? readFileRef(msg) : null;
		// A pass already attributed to a run stays with it, whatever its label says.
		// Reading the label FIRST made attribution depend on walk order: a first pass
		// ("A new file has just been uploaded") re-opened its file's run at the line
		// below, so if history delivered a run's continuations before its first pass -
		// which paging and the bg merge can do - the continuations opened a run, the
		// late first pass deleted it and opened a second, and the abandoned one was
		// force-finished. One run then rendered as TWO rows for the same file: a green
		// "complete" and a yellow "in progress". The same applies to a duplicate copy
		// of a pass. The id is the stable identity here; the label is a description.
		if (msg._serverItemId && runByItemId[msg._serverItemId]) {
			runId = runByItemId[msg._serverItemId];
		} else if (ref) {
			// Path first — a file can be re-uploaded under a name that already
			// exists elsewhere. But a pass that supplied no path (a compact
			// continuation label recovered from an old history cache) is still the
			// same file as the path-bearing passes above it, so let it join them
			// rather than splitting one file across two collapsed rows.
			var key = ref.path || keyByName[ref.name] || ref.name;
			// A FIRST pass ("A new file has just been uploaded") when this file
			// already has a run open starts a new one: it is a re-index, or a
			// re-upload over the same storage path. Continuations join the run.
			//
			// ...but only when this pass is genuinely NEW. A first pass whose id is
			// already attributed is the same pass reached twice (a duplicate bubble, or
			// a walk that reaches it after the continuations it opened), and re-opening
			// on it splits one run in half.
			var alreadySeen = !!(msg._serverItemId && runByItemId[msg._serverItemId]);
			// ...and only when it is actually LATER than the run it would replace. A
			// re-index's first pass follows the previous run; a misordered one precedes
			// the continuations already walked, and re-opening on it abandons a live run
			// (rendered green "complete") beside the fragment (yellow "in progress").
			// Timestamps decide it when both are known; without them the old
			// label-only behaviour stands, so the re-index case is unchanged.
			var openId = openRunOfKey[key];
			var notLater = false;
			if (openId && typeof msg._ts === 'number' && typeof newestTsOfRun[openId] === 'number') {
				notLater = (msg._ts as number) <= newestTsOfRun[openId];
			}
			if (!ref.continued && !alreadySeen && !notLater && openRunOfKey[key]) delete openRunOfKey[key];
			runId = openRunOfKey[key];
			if (!runId) {
				runId = 'run' + (runSeq++);
				openRunOfKey[key] = runId;
				keyOfRun[runId] = key;
				(runsOfKey[key] || (runsOfKey[key] = [])).push(runId);
			}
		} else if (msg.role !== 'user') {
			// ADJACENT only. Both paths that create a pass emit its request and
			// response bubbles together, so an id-less response belongs to the
			// message right before it. Falling back to the last file seen ANYWHERE
			// above swallowed stray background bubbles — an indexing prompt whose
			// shape we could not parse, a response whose request is not loaded —
			// into whichever file happened to be indexed most recently, however
			// much unrelated conversation sat in between.
			runId = runOfIndex[i - 1];
		}
		// A background bubble we cannot attribute to a file (an unrecognised label,
		// or a response whose request is not loaded) stays an ordinary message
		// rather than being folded into whichever group happens to be nearest.
		if (!runId) continue;
		if (typeof msg._ts === 'number') {
			var prevTs = newestTsOfRun[runId];
			if (typeof prevTs !== 'number' || (msg._ts as number) > prevTs) newestTsOfRun[runId] = msg._ts as number;
		}

		var g = groups[runId];
		if (!g) {
			var fileKey = keyOfRun[runId];
			g = groups[runId] = {
				key: fileKey,
				runKey: runId, // provisional; renumbered newest-first below
				name: ref ? ref.name : fileKey,
				path: ref ? ref.path : undefined,
				mime: ref ? ref.mime : undefined,
				size: ref ? ref.size : undefined,
				isReindex: !!(ref && ref.isReindex),
				members: [],
				passCount: 0,
				status: 'done',
				cancellableIds: [],
				cancelling: false,
				stopped: false,
				mayHaveOlder: false,
				// The run's first loaded pass, and never re-stamped: see the file
				// docstring. `anchorId` is filled in once every member is known.
				anchorIndex: i,
				anchorId: '',
				// All five are derived once every member is known, below.
				visibleMembers: [],
				driver: 'single',
				finished: false,
				resolving: false,
			};
			order.push(runId);
		}
		if (ref) {
			// Later passes carry the compact continuation label with no mime/size,
			// so keep the richest values any pass supplied.
			if (ref.name) g.name = ref.name;
			if (ref.path) g.path = ref.path;
			if (ref.mime) g.mime = ref.mime;
			if (typeof ref.size === 'number') g.size = ref.size;
			if (ref.isReindex) g.isReindex = true;
			if (!ref.continued) g.mayHaveOlder = false;
			g.passCount++;
		}
		g.members.push({ msg: msg, index: i });
		runOfIndex[i] = runId;
		if (msg._serverItemId) runByItemId[msg._serverItemId] = runId;
		if (ref && ref.name) keyByName[ref.name] = g.key;
	}

	// Name each run after its FIRST loaded pass. That id survives everything the
	// list does around it: passes appended to this run, other runs of the same
	// file appearing before OR after it, and an older page prepending. (An
	// ordinal would not — numbering from either end renames existing rows as soon
	// as a run appears at that end, which silently moves the user's expansion to
	// a row they never opened.) The one thing that changes it is the run's own
	// true first pass finally paging in, which happens at most once per run.
	// Whether a run is the NEWEST of its file. Only that one can still be running:
	// `liveIndexKeys` is keyed by FILE, shared by every run of it, so without this a
	// re-index left last week's finished row spinning for the whole of this week's
	// run — one file, two rows, both claiming to be working.
	var newestRunOfKey: { [runId: string]: boolean } = {};
	for (var nk in runsOfKey) {
		var nrs = runsOfKey[nk];
		if (nrs.length) newestRunOfKey[nrs[nrs.length - 1]] = true;
	}
	for (var rk in runsOfKey) {
		var runIds = runsOfKey[rk];
		for (var ri = 0; ri < runIds.length; ri++) {
			var grpR = groups[runIds[ri]];
			if (!grpR) continue;
			var first = grpR.members[0];
			var firstId = first && first.msg && (first.msg._serverItemId || first.msg._localId);
			// A run whose passes are all still local (no server id yet) falls back to
			// its position, which is all there is to go on.
			grpR.runKey = rk + '#' + (firstId || 'n' + ri);
		}
	}

	// Status + completeness, once every member is known.
	for (var oi = 0; oi < order.length; oi++) {
		var grp = groups[order[oi]];
		// A file's passes run strictly one after another, so a pass still marked
		// queued/running with a SETTLED pass after it is stale history, not live
		// work — the server's row for it simply never left "running". Ignoring
		// those matters most for pages reached by scrolling up (or by the viewport
		// fill), which get no poll attached to resolve them: one stale row would
		// otherwise flip a long-finished file back to a spinner with a "Stop"
		// button aimed at a dead item id, permanently.
		var lastSettled = -1;
		for (var si = 0; si < grp.members.length; si++) {
			if (!isPendingMsg(grp.members[si].msg)) lastSettled = si;
		}
		var active = false;
		for (var mi = lastSettled + 1; mi < grp.members.length; mi++) {
			if (isPendingMsg(grp.members[mi].msg)) { active = true; break; }
		}
		// Did the user STOP this run? Asked of the WHOLE run, because a stop routinely
		// leaves nothing behind at the end of it:
		//   - only a QUEUED pass can be removed from the queue, and that is the one
		//     case that produces a cancelled bubble. The pass that is actually running
		//     cannot be un-run — it is flagged cancelled server-side, which is what
		//     stops the worker enqueueing the next window, and then finishes its own
		//     provider call and writes an ordinary, successful answer;
		//   - a PDF (or any worker-driven file) usually has exactly ONE pass live, so
		//     that running pass is normally all a stop has to act on;
		//   - continuations still sitting in bgTaskQueue are dropped by
		//     _applyIndexCancellations before they are ever surfaced, so they leave no
		//     bubble either.
		// The messages of a stopped run therefore END in a successful pass, and reading
		// the status off the last member alone reported the stop as a green "Indexed"
		// over a file that was only partly read — with the newest pass's own text still
		// saying "More pages remain" right underneath it.
		//
		// Two witnesses, both scoped to one RUN so a later re-index of the same file
		// can never inherit a stop: a cancelled member (durable — it comes back from
		// history), and the ids ChatSession recorded when the user hit Stop (this
		// page's memory only, which is what covers the run that has no cancelled
		// member at all).
		var stopped = false;
		for (var ki = 0; ki < grp.members.length; ki++) {
			var km = grp.members[ki].msg;
			if (km.isCancelled) { stopped = true; break; }
			if (km._serverItemId && stoppedIndexIds[km._serverItemId]) { stopped = true; break; }
		}
		grp.stopped = stopped;
		// What a stop button would act on: the REQUEST bubble of every pass that is
		// still queued or running server-side. The assistant placeholder shares its
		// pass's server id, so ids are de-duplicated. A pass mid-cancel is left out
		// (its request is already on its way) but keeps the row in a cancelling
		// state so the button does not flicker back to "stop".
		for (var xi = 0; xi < grp.members.length; xi++) {
			if (grp.members[xi].msg._cancelling) { grp.cancelling = true; break; }
		}
		var seenIds: { [id: string]: boolean } = {};
		for (var ci = 0; ci < grp.members.length; ci++) {
			var cm = grp.members[ci].msg;
			// Report a failed Stop only while the stop is still something the user
			// can act on. "Could not remove from queue" (the pass had just started)
			// stays on that bubble, so reporting it from ANY member meant a row that
			// went on to finish normally kept describing a one-off transient failure
			// as a permanent property of the file, until a full history refresh
			// rebuilt the bubbles.
			//
			// And never for a run that IS stopped, which is the case the message gets
			// wrong: the only thing that failed there is removing the pass already in
			// flight (it cannot be un-run — it finishes and answers), while the stop
			// itself holds. The row says "Stopping..." and then "Indexing cancelled",
			// which is the accurate account; "Could not stop this file" beside it is
			// not.
			if (cm._cancelError && !stopped && (active || grp.cancelling)) grp.cancelError = cm._cancelError;
			if (cm.role !== 'user' || !cm._serverItemId || cm._cancelling || cm.isSendingToServer) continue;
			if (!(cm.isPendingQueued || cm.isPendingInProcess)) continue;
			// Same staleness rule: never offer to stop a pass a later one outlived.
			if (ci < lastSettled) continue;
			if (seenIds[cm._serverItemId]) continue;
			seenIds[cm._serverItemId] = true;
			grp.cancellableIds.push(cm._serverItemId);
		}
		if (active) {
			// A pass IS still running, and a row that claimed otherwise would hide work
			// the user can still see the effects of. The stop is reported as `cancelling`
			// instead — "Stopping...", Stop spent — and the row settles to 'cancelled'
			// when that last pass lands.
			grp.status = 'active';
			if (stopped) grp.cancelling = true;
		} else if (stopped) {
			grp.status = 'cancelled';
		} else {
			// The newest loaded outcome is the file's state: an early pass may have
			// errored and a later one succeeded.
			var last = grp.members[grp.members.length - 1].msg;
			grp.status = last.isError ? 'error' : 'done';
		}
		// A group whose passes are ALL continuations began before the loaded
		// window; its earlier passes arrive when older history is paged in.
		var sawFirstPass = false;
		for (var pi = 0; pi < grp.members.length; pi++) {
			var pm = grp.members[pi].msg;
			if (pm.role !== 'user') continue;
			var pref = readFileRef(pm);
			if (pref && !pref.continued) { sawFirstPass = true; break; }
		}
		grp.mayHaveOlder = !sawFirstPass && hasMoreHistory;
		// Where the row renders, and WHICH turn that is. Derived from the same
		// member so the two can never drift apart; a group always has a member
		// (it is created by the first one).
		var anchor = grp.members[0];
		grp.anchorIndex = anchor.index;
		grp.anchorId = anchor.msg._serverItemId || anchor.msg._localId || '';

		// --- what an expanded row renders, and whether the run is over -------------
		var sawComplete = false;
		for (var vi = 0; vi < grp.members.length; vi++) {
			var vm = grp.members[vi];
			if (vm.msg._indexComplete) sawComplete = true;
			if (!isHiddenPass(vm.msg)) grp.visibleMembers.push(vm);
		}
		// Mirrors ChatSession.maybeResumeIndexing's own routing, which is what makes
		// the answer match who will actually dispatch the next pass.
		grp.driver = !isPagedReadFile(grp.name, grp.mime) ? 'single'
			: isImageVisionFile(grp.name, grp.mime) ? 'worker'
				: (windowedIndexing ? 'worker' : 'client');
		if (grp.status === 'active') {
			grp.finished = false;
		} else if (grp.status === 'cancelled') {
			// The user stopped it. Nothing more will run, by construction.
			grp.finished = true;
		} else if (grp.driver === 'single') {
			// One pass is the whole job: nothing continues a file that is not a paged
			// read, so a settled pass IS the end. Exact, and survives a reload.
			grp.finished = true;
		} else if (grp.driver === 'client') {
			// The three branches this client itself stops dispatching on. Using the
			// same rule means the row cannot disagree with the pipeline: if the client
			// will send no more passes, the run is over whether or not the file was
			// fully read.
			grp.finished = sawComplete || grp.status === 'error' ||
				grp.passCount >= MAX_INDEXING_RESUME_PASSES;
		} else {
			// WORKER-driven, and the interesting case. Nothing in the messages can
			// settle it: the loop is advanced inside the worker off the renderer's page
			// count, the client only ever sees passes appear and settle, and the prompt
			// for these paths deliberately never asks for a completion marker — a model
			// that volunteers one is guessing, which is how an 88-page file once
			// "finished" at page 15. So sawComplete is deliberately NOT consulted here.
			// Either the server said this was the last pass, or the queue has been
			// asked and holds nothing for this file.
			//
			// A run that is NOT the newest of its file is over by construction: a newer
			// run exists, so this one's chain ended when that one began, and the
			// file-keyed queue answer describes the newer run, not this one.
			//
			// There used to be a third disjunct here, a server-stamped "this was the
			// run's last pass" (`_indexFinal`, off an `index_final` field). Nothing ever
			// wrote that field — not the SDK's history mapper, not the worker — so it was
			// permanently false and the two tests below were already carrying the whole
			// decision. It is gone rather than left as a hook, so this reads as what it
			// actually is: for a worker-driven run, ONLY the queue can say it is over.
			// The done:: marker is the third — and strongest — disjunct: written
			// only at a chain's true end (backend worker, or a client's own
			// deterministic completion), it answers without any queue round
			// trip. Gated on the queue NOT claiming the file live, so a
			// re-index whose marker-cascade delete lagged still shows yellow.
			grp.finished = !newestRunOfKey[order[oi]] ||
				(!!doneKeys[grp.key] && !liveIndexKeys[grp.key]) ||
				(liveIndexChecked && !liveIndexKeys[grp.key]);
		}

		// --- is any of that knowable YET? ------------------------------------------
		// See IndexingGroup.resolving. Both answers above are read off the passes
		// that happen to be loaded, and while a fetch that would change WHICH passes
		// those are is still running, the row states the wait instead of picking a
		// side. Two waits, checked in that order because the first subsumes the
		// second: a run whose start has not arrived cannot be judged by any queue
		// answer either.
		if (grp.status !== 'done') {
			// 'active' is proof the run is live; 'error' and 'cancelled' are the
			// newest pass's own outcome, and newest-first paging always has that pass.
			grp.resolving = false;
		} else if (grp.mayHaveOlder && loadingOlderHistory &&
			!liveIndexKeys[grp.key] && !doneKeys[grp.key] && newestRunOfKey[order[oi]]) {
			// The line this draws, and it is the same line the 'status' branch draws:
			// withhold what is UNKNOWN, and what is only INFERRED settled. Never
			// withhold what is PROVEN, in either direction. Two proofs, and an older
			// page can revise neither:
			//   liveIndexKeys hit — the server just said this file is on the queue RIGHT
			//     NOW. Yellow and spinning, and no amount of older history makes that
			//     untrue. (Survives an unanswered `checked` for the reason above: only
			//     ABSENCE needs the truncation guard.)
			//   not the newest run of this file — a LATER run exists in the loaded
			//     messages, so this run's chain ended when that one began. Prepending
			//     adds OLDER messages, so it can never add a run after this one.
			// (A third proof used to sit here, a server-stamped last-pass flag, but
			// nothing ever wrote the field it read — see `finished` above.)
			//
			// What is deliberately NOT proof here: `finished` as a whole. Its remaining
			// source is `liveIndexChecked && !liveIndexKeys[key]`, which is an inference
			// from ABSENCE and is exactly what the user asked to stop reading as a green
			// "Indexed" mid-fetch. And a blanket `!grp.finished` would be wrong for a
			// second reason: driver 'single' also yields finished, and THAT verdict an
			// older page really can revise — the first pass is what carries the mime, so
			// a page bringing it in re-classifies the file as paged and hands the
			// question back to the queue.
			grp.resolving = true;
			grp.resolvingReason = 'history';
		} else if (!grp.finished && grp.driver === 'worker' && !liveIndexChecked && !liveIndexKeys[grp.key]) {
			// Worker-driven and the queue has not answered. `finished` is already
			// false here and the row would spin "Indexing" on the strength of nothing
			// — the same false claim, one round trip long, on every chatbox open of a
			// file that finished days ago. A 'client' run in the same shape is NOT
			// resolving: no answer is being waited for, this client is the one that
			// dispatches the next pass, so "Indexing" is a statement about its own
			// intent and is true.
			//
			// A POSITIVE key survives `!liveIndexChecked`, and must. `checked` is set
			// from `!truncated`: a capped page suppresses the whole answer, which is
			// right for ABSENCE (an omitted file would otherwise read as finished) and
			// wrong for PRESENCE, because an item the query did return is proof the
			// file is live. Hiding that behind "checking..." would withhold the one
			// thing here that is actually known.
			grp.resolving = true;
			grp.resolvingReason = 'status';
		} else {
			grp.resolving = false;
		}
	}

	// --- durable run:: stubs ---------------------------------------------------
	// A run record whose passes are not among the loaded messages still deserves
	// a row: on a fresh open the bg history is deferred, and a run older than the
	// paging cap never loads at all. Synthesized as header-only groups and placed
	// by `started` among the messages' own timestamps; a real group for the same
	// file always wins (see BuildDisplayListOptions.runStubs).
	var stubList: { started: number; group: IndexingGroup }[] = [];
	var runStubs = opts && opts.runStubs;
	if (runStubs) {
		// Two namespaces, deliberately NOT one map: storage paths are
		// project-relative and folder trees repeat basenames routinely, so a
		// flat map let a real group for "2025/report.pdf" delete the stub for
		// "2026/report.pdf" with nothing replacing it. A bare NAME only covers
		// a stub when the group itself has no path (the legacy compact-label
		// case) and the record has no filename of its own to disambiguate.
		var coveredPaths: { [k: string]: boolean } = {};
		var coveredPathlessNames: { [k: string]: boolean } = {};
		for (var ci = 0; ci < order.length; ci++) {
			var cg = groups[order[ci]];
			if (cg.path) {
				coveredPaths[canonIndexKey(cg.path)] = true;
				if (cg.key) coveredPaths[canonIndexKey(cg.key)] = true;
			} else if (cg.name) coveredPathlessNames[canonIndexKey(cg.name)] = true;
			else if (cg.key) coveredPaths[canonIndexKey(cg.key)] = true;
		}
		var now = opts && typeof opts.now === 'number' ? opts.now : Date.now();
		var stubClearedAt = (opts && typeof opts.stubClearedAt === 'number' && opts.stubClearedAt > 0)
			? opts.stubClearedAt : 0;
		for (var sp in runStubs) {
			var rec = runStubs[sp];
			if (!sp || !rec || !rec.status || coveredPaths[canonIndexKey(sp)]) continue;
			var fname = rec.filename || sp.split('/').pop() || sp;
			// A PATHLESS group (legacy compact label) can only be matched by
			// name, and that is still the right match: the file already has a
			// row, so suppressing avoids a duplicate rather than creating a
			// void. What is gone is the reverse — a group WITH a path no longer
			// writes into the name namespace, so it can no longer delete a
			// same-basename stub from another folder.
			if (coveredPathlessNames[canonIndexKey(fname)]) continue;
			// A run recorded under the OTHER platform's chat belongs to that
			// conversation: its passes live in that history (so no real group
			// can ever cover this stub) and the queue probe is platform-scoped
			// (so it can never confirm it). Records with no platform are
			// legacy and keep the old behaviour rather than vanishing.
			if (stubPlatform && rec.platform && rec.platform !== stubPlatform) continue;
			// Mirrors the real groups' status precedence: a live queue hit outranks
			// whatever the record says (a lagged update must not paint a verdict over
			// visible work), then the record's own terminal statuses, then the
			// queue's authoritative ABSENCE, and only then the stated wait.
			// The bare-NAME disjunct is load-bearing: a legacy pass prompt may carry no
			// storage path at all, so the name is the only key its run can appear under.
			// But it also matched ANY live file sharing this basename, painting a
			// finished run's stub yellow because a same-named file in another folder was
			// indexing. Take the name hit only when it cannot belong to a different
			// file - i.e. no OTHER live key is a path ending in this basename.
			var live = !!liveIndexKeys[sp] || !!liveIndexKeys[canonIndexKey(sp)];
			if (!live && (liveIndexKeys[fname] || liveIndexKeys[canonIndexKey(fname)])) {
				var claimedByOther = false;
				for (var lk in liveIndexKeys) {
					if (!liveIndexKeys[lk]) continue;
					var lkc = canonIndexKey(lk);
					if (lkc === canonIndexKey(sp)) continue;
					if (lkc.length > fname.length && lkc.slice(-(fname.length + 1)) === '/' + fname) {
						claimedByOther = true;
						break;
					}
				}
				live = !claimedByOther;
			}
			// Cleared-history horizon: a run that ended at or before the clear is
			// part of what the user asked to forget. A live queue hit survives it
			// (see BuildDisplayListOptions.stubClearedAt). A record carrying NO
			// timestamp at all is unplaceable, not old — the horizon cannot judge
			// it, so it is never dropped by one.
			var recWhen = typeof rec.finished === 'number' ? rec.finished
				: typeof rec.started === 'number' ? rec.started : undefined;
			if (stubClearedAt && !live && recWhen !== undefined && recWhen <= stubClearedAt) continue;
			var st: IndexingGroupStatus = 'active';
			var fin = false;
			var res = false;
			var reason: 'history' | 'status' | undefined;
			if (!live) {
				// A done:: marker from the same sweep is as terminal as the record's
				// own 'done' — it settles a dangling 'working' the chain never
				// flipped (mirrors the real-group doneKeys disjunct).
				if (rec.status === 'done' || doneKeys[sp] || doneKeys[canonIndexKey(sp)]
					|| doneKeys[fname] || doneKeys[canonIndexKey(fname)]) { st = 'done'; fin = true; }
				else if (rec.status === 'error') { st = 'error'; fin = true; }
				else if (rec.status === 'cancelled') { st = 'cancelled'; fin = true; }
				else if (liveIndexChecked) {
					// 'working' is a CLAIM. The queue has now answered, untruncated,
					// and holds nothing for this file — the same proof the real-group
					// ladder settles on. Without this disjunct a stub had no
					// terminator at all: worker-driven runs are never flipped by this
					// client, so the row sat grey forever (the reported "checking
					// status that never resolves").
					st = 'done'; fin = true;
				} else if (typeof rec.started === 'number' && now - rec.started > RUN_RECORD_WORKING_STALE_MS) {
					// Older than any real run and still unconfirmed: a dead claim, not
					// an open question. Same horizon the files page applies.
					st = 'error'; fin = true;
				} else {
					// Genuinely unanswered — the queue reply is one round trip away
					// and this self-heals the moment it lands.
					res = true; reason = 'status';
				}
			}
			var sg: IndexingGroup = {
				key: sp,
				// ONE identity for the run whether it renders from the record or
				// from its loaded passes: the views key the DOM off runKey, so a
				// 'stub:'-prefixed key meant every handoff was an unmount plus a
				// remount somewhere else. Named after the record's start, which
				// the real group below reuses when it has one.
				runKey: 'run:' + sp + '#' + (typeof rec.started === 'number' ? rec.started : 'n'),
				name: fname,
				path: sp,
				mime: undefined,
				size: undefined,
				isReindex: false,
				members: [],
				passCount: 0,
				status: st,
				cancellableIds: [],
				cancelling: false,
				stopped: st === 'cancelled',
				mayHaveOlder: hasMoreHistory,
				anchorIndex: -1,
				anchorId: '',
				visibleMembers: [],
				driver: !isPagedReadFile(fname, undefined) ? 'single'
					: isImageVisionFile(fname, undefined) ? 'worker'
						: (windowedIndexing ? 'worker' : 'client'),
				finished: fin,
				resolving: res,
				resolvingReason: reason,
				stub: true,
				stubError: rec.error || (st === 'error' && !rec.error
					? 'Indexing did not finish.' : undefined),
			};
			// A record with no `started` cannot be placed in the conversation.
			// Infinity sorts it to the END (nearest the newest turns) instead of
			// above every message the user has ever sent — the row is about
			// something recent, not about the beginning of time.
			stubList.push({ started: typeof rec.started === 'number' ? rec.started : Infinity, group: sg });
		}
	}

	// --- timestamp-anchor INCOMPLETE real runs ---------------------------------
	// A real run's row renders at its first LOADED pass, and while older history
	// pages in (newest-first) that is a moving target: the run first appears at
	// its newest pass — down by the recent bubbles — then relocates upward as
	// earlier passes arrive, so the row visibly jumps. The run:: record's
	// `started` is a stable anchor for exactly that window: emit the row at its
	// timestamp position instead, and once the true first pass loads
	// (mayHaveOlder false) emission returns to the anchor, which by then IS the
	// same spot. Newest run of the file only — the record describes it, and an
	// older run's passes are already fully placed around it.
	//
	// NOT gated on mayHaveOlder: that made the position depend on WHICH passes
	// happened to be loaded, so a row moved when the sweep resolved, again when
	// the first pass paged in, and again when paging ended. A record with a
	// `started` places the run at ONE spot for as long as the record exists.
	var suppressAnchor: { [runId: string]: boolean } = {};
	var stubByCanon: { [k: string]: RunStubInfo } = {};
	if (runStubs) for (var ck in runStubs) stubByCanon[canonIndexKey(ck)] = runStubs[ck];
	if (runStubs) {
		for (var ti2 = 0; ti2 < order.length; ti2++) {
			var tg = groups[order[ti2]];
			if (!newestRunOfKey[order[ti2]]) continue;
			var trec = (tg.path && (runStubs[tg.path] || stubByCanon[canonIndexKey(tg.path)]))
				|| runStubs[tg.key] || stubByCanon[canonIndexKey(tg.key)];
			if (!trec || typeof trec.started !== 'number') continue;
			if (stubPlatform && trec.platform && trec.platform !== stubPlatform) continue;
			suppressAnchor[order[ti2]] = true;
			// Same identity the stub form uses, so a row that upgrades from
			// record-only to loaded-passes keeps its DOM node and its position.
			tg.runKey = 'run:' + (tg.path || tg.key) + '#' + trec.started;
			stubList.push({ started: trec.started, group: tg });
		}
	}
	stubList.sort(function (a, b) { return a.started - b.started; });

	var out: DisplayEntry[] = [];
	var si = 0;
	for (var j = 0; j < list.length; j++) {
		// Splice stubs in by time: everything that started before this message
		// goes above it. Messages without a timestamp decide nothing.
		var mts = list[j] && typeof list[j]._ts === 'number' ? (list[j]._ts as number) : undefined;
		if (mts !== undefined) {
			while (si < stubList.length && stubList[si].started <= mts) {
				out.push({ kind: 'indexing', group: stubList[si].group, index: -1 - si });
				si++;
			}
		}
		var r = runOfIndex[j];
		if (r === undefined) {
			out.push({ kind: 'message', msg: list[j], index: j });
			continue;
		}
		// Every other member of the run is represented by the row at the anchor —
		// unless the row is timestamp-anchored (incomplete run with a run::
		// record), in which case the flush above already emitted it.
		if (groups[r].anchorIndex === j && !suppressAnchor[r]) {
			out.push({ kind: 'indexing', group: groups[r], index: j });
		}
	}
	while (si < stubList.length) {
		out.push({ kind: 'indexing', group: stubList[si].group, index: -1 - si });
		si++;
	}
	return out;
}
