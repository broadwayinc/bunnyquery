/**
 * Background file-indexing turns, collapsed into ONE row per file.
 *
 * A single upload can produce many chat turns: the first "Indexing: <file>" pass
 * plus up to MAX_INDEXING_RESUME_PASSES CONTINUE passes, each with its own
 * request AND response bubble. Rendered flat, that reads as the same task
 * repeating forever, and any real question the user asks in between gets buried.
 *
 * buildChatDisplayList turns the flat message array into a DISPLAY list in which
 * every message belonging to one file (however far apart they sit, and whatever
 * else is interleaved between them) is represented by a single group entry,
 * rendered at the position of that file's NEWEST turn. Newest, not oldest, so:
 *   - a running index sits at the bottom, where the activity is, and
 *   - paging older history in never moves a row that is already on screen
 *     (older passes simply join the group they already belong to).
 *
 * The group deliberately reports no authoritative pass TOTAL. History is paged
 * newest-first, so any total computed from loaded messages is a lower bound that
 * a later scroll-up would contradict. It reports STATE (indexing / indexed /
 * failed), how many passes are currently loaded, and `mayHaveOlder` when the
 * file's first pass is not among them.
 *
 * Pure and view-agnostic: agent.vue and the BunnyQuery widget both render from
 * this, so the two stay identical.
 */
import type { ChatMessage, IndexingFileRef } from './host';

export type IndexingGroupStatus = 'active' | 'done' | 'error' | 'cancelled';

export type IndexingGroup = {
	/** The FILE this row is about: storage path when known (a file can be
	 *  re-uploaded under a name that already exists elsewhere), else name. Shared
	 *  by every run of that file, and what ChatSession.cancelIndexingGroup and
	 *  _indexKeyOf match on — never use it as a render key. */
	key: string;
	/** Identity of this ROW: one indexing RUN of that file. A file indexed on
	 *  Monday and re-indexed on Wednesday is two runs, and collapsing them into
	 *  one row erased Monday's from Monday's place in the conversation, claimed
	 *  its passes for Wednesday, and let Monday's failure be overwritten by
	 *  Wednesday's success. Numbered from the NEWEST run backwards (`#0` is the
	 *  newest) so paging in older history never renames a row already on screen.
	 *  This is the render key and the expansion key. */
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
	/** A cancel request is in flight for one of the passes. */
	cancelling: boolean;
	/** Why the last cancel attempt failed (e.g. the pass had already finished). */
	cancelError?: string;
	/** The file's first pass is not among the loaded messages, so earlier passes
	 *  exist in history that has not been paged in yet. */
	mayHaveOlder: boolean;
	/** Position in the source array this collapsed row renders at. */
	anchorIndex: number;
};

export type DisplayEntry =
	| { kind: 'message'; msg: ChatMessage; index: number }
	| { kind: 'indexing'; group: IndexingGroup; index: number };

export type BuildDisplayListOptions = {
	/** True while older history remains unpaged, which is what makes a group
	 *  with no first pass genuinely incomplete rather than merely odd. */
	hasMoreHistory?: boolean;
};

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
	var hasMoreHistory = !!(opts && opts.hasMoreHistory);

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
	var runSeq = 0;

	for (var i = 0; i < list.length; i++) {
		var msg = list[i];
		if (!msg || !msg.isBackgroundTask) continue;

		var runId: string | undefined;
		var ref = msg.role === 'user' ? readFileRef(msg) : null;
		if (ref) {
			// Path first — a file can be re-uploaded under a name that already
			// exists elsewhere. But a pass that supplied no path (a compact
			// continuation label recovered from an old history cache) is still the
			// same file as the path-bearing passes above it, so let it join them
			// rather than splitting one file across two collapsed rows.
			var key = ref.path || keyByName[ref.name] || ref.name;
			// A FIRST pass ("A new file has just been uploaded") when this file
			// already has a run open starts a new one: it is a re-index, or a
			// re-upload over the same storage path. Continuations join the run.
			if (!ref.continued && openRunOfKey[key]) delete openRunOfKey[key];
			runId = openRunOfKey[key];
			if (!runId) {
				runId = 'run' + (runSeq++);
				openRunOfKey[key] = runId;
				keyOfRun[runId] = key;
				(runsOfKey[key] || (runsOfKey[key] = [])).push(runId);
			}
		} else if (msg._serverItemId && runByItemId[msg._serverItemId]) {
			runId = runByItemId[msg._serverItemId];
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
				mayHaveOlder: false,
				anchorIndex: i,
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
		g.anchorIndex = i;
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
			if (cm._cancelError && (active || grp.cancelling)) grp.cancelError = cm._cancelError;
			if (cm.role !== 'user' || !cm._serverItemId || cm._cancelling || cm.isSendingToServer) continue;
			if (!(cm.isPendingQueued || cm.isPendingInProcess)) continue;
			// Same staleness rule: never offer to stop a pass a later one outlived.
			if (ci < lastSettled) continue;
			if (seenIds[cm._serverItemId]) continue;
			seenIds[cm._serverItemId] = true;
			grp.cancellableIds.push(cm._serverItemId);
		}
		if (active) {
			grp.status = 'active';
		} else {
			// The newest loaded outcome is the file's state: an early pass may have
			// errored and a later one succeeded.
			var last = grp.members[grp.members.length - 1].msg;
			grp.status = last.isError ? 'error' : last.isCancelled ? 'cancelled' : 'done';
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
	}

	var out: DisplayEntry[] = [];
	for (var j = 0; j < list.length; j++) {
		var r = runOfIndex[j];
		if (r === undefined) {
			out.push({ kind: 'message', msg: list[j], index: j });
			continue;
		}
		// Every other member of the run is represented by the row at the anchor.
		if (groups[r].anchorIndex === j) out.push({ kind: 'indexing', group: groups[r], index: j });
	}
	return out;
}
