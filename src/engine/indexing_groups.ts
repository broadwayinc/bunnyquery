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
	/** Stable identity across re-renders and across history pages: storage path
	 *  when known (a file can be re-uploaded under the same name), else name. */
	key: string;
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

	var groups: { [key: string]: IndexingGroup } = {};
	var order: string[] = [];
	var keyOfIndex: (string | undefined)[] = new Array(list.length);
	// A response bubble carries no file metadata of its own; it is tied to its
	// request by the server item id, with the most recent indexing request as the
	// fallback for locally-pushed bubbles that have no id yet.
	var keyByItemId: { [itemId: string]: string } = {};
	var lastKey: string | undefined;

	for (var i = 0; i < list.length; i++) {
		var msg = list[i];
		if (!msg || !msg.isBackgroundTask) continue;

		var key: string | undefined;
		var ref = msg.role === 'user' ? readFileRef(msg) : null;
		if (ref) {
			key = ref.path || ref.name;
		} else if (msg._serverItemId && keyByItemId[msg._serverItemId]) {
			key = keyByItemId[msg._serverItemId];
		} else if (msg.role !== 'user') {
			key = lastKey;
		}
		// A background bubble we cannot attribute to a file (an unrecognised label,
		// or a response whose request is not loaded) stays an ordinary message
		// rather than being folded into whichever group happens to be nearest.
		if (!key) continue;

		var g = groups[key];
		if (!g) {
			g = groups[key] = {
				key: key,
				name: ref ? ref.name : key,
				path: ref ? ref.path : undefined,
				mime: ref ? ref.mime : undefined,
				size: ref ? ref.size : undefined,
				isReindex: !!(ref && ref.isReindex),
				members: [],
				passCount: 0,
				status: 'done',
				mayHaveOlder: false,
				anchorIndex: i,
			};
			order.push(key);
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
		keyOfIndex[i] = key;
		if (msg._serverItemId) keyByItemId[msg._serverItemId] = key;
		lastKey = key;
	}

	// Status + completeness, once every member is known.
	for (var oi = 0; oi < order.length; oi++) {
		var grp = groups[order[oi]];
		var active = false;
		for (var mi = 0; mi < grp.members.length; mi++) {
			if (isPendingMsg(grp.members[mi].msg)) { active = true; break; }
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
		var k = keyOfIndex[j];
		if (k === undefined) {
			out.push({ kind: 'message', msg: list[j], index: j });
			continue;
		}
		// Every other member of the group is represented by the row at the anchor.
		if (groups[k].anchorIndex === j) out.push({ kind: 'indexing', group: groups[k], index: j });
	}
	return out;
}
