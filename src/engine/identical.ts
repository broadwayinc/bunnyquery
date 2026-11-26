/**
 * ONE SHARED INDEX FOR IDENTICAL FILES: the clients' half (owner, 2026-11-26).
 *
 * Files whose stored bytes are the same (same md5 and size, same kind of file) are indexed
 * ONCE. The first one is the ORIGINAL; every later one is a LINKED COPY: the worker links it
 * to the original's index on the server with no AI call (the MCP's content-dedup.js). This
 * module is what both clients (the dashboard and the widget) share about that:
 *
 *   - reading a file's copy status off the markers they already sweep (done::, run::) and
 *     the live claim ids (one prefix listing of "cas::"),
 *   - the words a copy is shown with (Files page chips, the chat's indexing row),
 *   - which copies to send again when an original goes away (promotion),
 *   - the owner's "Find identical files" calls.
 *
 * THE RECORDS (written by the MCP, read here; see content-dedup.js for the full contract):
 *   done::<copy>  __INDEXING__ "authorized", tag "bq_linked", data { source, linked: true,
 *                 alias_of: <original>, alias_claim: "cas::<scope>::<key>", content_key,
 *                 completed_at, records_written: 0, copy_group, copy_owner }
 *   run::<copy>   data { status: 'done', linked: true, alias_of, alias_claim, finished }
 *   cas::<scope>::<key>  the claim, in the original's access group, referencing
 *                 src::<original>. Deleting or resetting the original removes it, so a
 *                 linked copy whose alias_claim is not among the live claim ids has lost its
 *                 original (removed outside the clients, or not promoted yet).
 *
 * Pure apart from the three reads and two route calls at the bottom, which take the skapi
 * instance (or go through the host's forwardRequest) like the rest of the engine.
 */
import { chatEngineConfig, resolveForwardRequest } from './config';
import { formatIndexDuration } from './time';

/** Tag on every linked copy's done:: marker. */
export const LINKED_COPY_TAG = 'bq_linked';
/** unique_id prefix of the content claims. */
export const CONTENT_CLAIM_PREFIX = 'cas::';

/** What a linked copy's done:: (or run::) record says about its link. */
export type LinkedMarker = {
	/** Storage path of the original whose index this copy shares. */
	original: string;
	/** The claim id the link was made under ("cas::<scope>::<key>"), when recorded. */
	claim?: string;
	/** When the link was written (ms), when recorded. */
	linkedAt?: number;
	/** The copy's own access group, when recorded. */
	group?: string | number | null;
	/** The copy's uploader, when recorded. */
	owner?: string | null;
	/** The content key the copy was linked under, when recorded. */
	contentKey?: string;
};

/** The link a done:: or run:: record's `data` describes, or null when it is not a linked copy's. */
export function linkedMarkerOf(data: any): LinkedMarker | null {
	if (!data || typeof data !== 'object' || data.linked !== true) return null;
	var original = typeof data.alias_of === 'string' ? data.alias_of : '';
	if (!original) return null;
	var at = Number(data.completed_at || data.finished || data.linked_at);
	return {
		original: original,
		claim: typeof data.alias_claim === 'string' && data.alias_claim ? data.alias_claim : undefined,
		linkedAt: isFinite(at) && at > 0 ? at : undefined,
		group: data.copy_group !== undefined ? data.copy_group : undefined,
		owner: typeof data.copy_owner === 'string' ? data.copy_owner : undefined,
		contentKey: typeof data.content_key === 'string' && data.content_key ? data.content_key : undefined,
	};
}

/** The last segment of a storage path. */
export function fileNameOf(path: string): string {
	var s = String(path || '');
	var at = s.lastIndexOf('/');
	return at === -1 ? s : s.slice(at + 1);
}

export type CopyStatusKind = 'linked' | 'waiting' | 'original_failed' | 'original_removed';

export type CopyStatus = {
	kind: CopyStatusKind;
	/** Storage path of the original. */
	original: string;
	/** The chip's text. */
	label: string;
	/** The chip's tooltip. */
	title: string;
	/** True for the two states in which the copy has no index anyone can search (red). */
	broken: boolean;
};

/** What the original's own markers say, for copyStatusOf. */
export type OriginalState = {
	/** The original has a done:: marker of its own (not a linked one). */
	done?: boolean;
	/** Its newest run:: record's status, when there is one. */
	run?: string;
	/** The content key its own done:: marker records (the MCP writes it when the original
	 *  finishes), when known. Different from the copy's: the original now holds other content. */
	contentKey?: string;
};

/**
 * A linked copy's status for the Files page and the widget:
 *   'original_removed'  its claim id is not among the live claims (the original was deleted,
 *                       or reset and not indexed again), or the original has no markers left;
 *   'original_failed'   the original's newest run ended in an error or was cancelled;
 *   'waiting'           the original is still being indexed;
 *   'linked'            the original is indexed: search and totals count the content once.
 * `liveClaims` is the set of live "cas::" ids (listContentClaims), or null when it could not
 * be read: then the claim is not used as evidence either way.
 */
export function copyStatusOf(marker: LinkedMarker, original?: OriginalState | null, liveClaims?: Set<string> | null): CopyStatus {
	var name = fileNameOf(marker.original);
	var mk = function (kind: CopyStatusKind, label: string, title: string, broken: boolean): CopyStatus {
		return { kind: kind, original: marker.original, label: label, title: title, broken: broken };
	};
	var o = original || {};
	var claimGone = !!(liveClaims && marker.claim && !liveClaims.has(marker.claim));
	// The original finished with OTHER content (overwritten, and this copy was not sent again:
	// another user's copy, or an overwrite outside the BunnyQuery clients). Its claim id may be
	// live again under a new original of the old content, so the claim alone cannot tell.
	if (o.done && o.contentKey && marker.contentKey && o.contentKey !== marker.contentKey && o.run !== 'working') {
		return mk('original_removed', 'Original removed or failed',
			'Linked to "' + name + '", which now holds other content. Reindex this file to index it on its own.', true);
	}
	if (claimGone && !(o.run === 'working')) {
		return mk('original_removed', 'Original removed or failed',
			'Linked to "' + name + '", which is no longer indexed. Reindex this file to index it on its own.', true);
	}
	if (o.run === 'error' || o.run === 'cancelled') {
		return mk('original_failed', 'Original removed or failed',
			'Linked to "' + name + '", whose indexing did not finish. Reindex this file to index it on its own.', true);
	}
	if (o.run === 'working' && !o.done) {
		return mk('waiting', 'Waiting for ' + name,
			'Same content as "' + name + '", which is still being indexed. This file shares its index when it finishes.', false);
	}
	if (!o.done && o.run !== 'done' && liveClaims && !marker.claim) {
		// an old marker without a claim id and an original with no markers at all
		return mk('original_removed', 'Original removed or failed',
			'Linked to "' + name + '", which is no longer indexed. Reindex this file to index it on its own.', true);
	}
	return mk('linked', 'Indexed via ' + name,
		'Same content as "' + name + '"; search and totals count it once.', false);
}

/** "1 copy" / "3 copies": the chip on an original. */
export function copyCountLabel(n: number): string {
	return n === 1 ? '1 copy' : n + ' copies';
}

/** The tooltip of an original's copy chip, naming the copies. */
export function copyCountTitle(copies: string[]): string {
	var list = copies.slice(0, 10).map(function (p) { return '/' + p; }).join('\n');
	var more = copies.length > 10 ? '\n...and ' + (copies.length - 10) + ' more' : '';
	return 'The same content is also stored as:\n' + list + more + '\nThey share this file\'s index; search and totals count it once.';
}

/** Copies per original, oldest link first: Map(original path -> copy paths). */
export function copiesByOriginal(linked: Map<string, LinkedMarker> | { [path: string]: LinkedMarker }): Map<string, string[]> {
	var entries: [string, LinkedMarker][] = linked instanceof Map
		? Array.from(linked.entries())
		: Object.keys(linked).map(function (k) { return [k, (linked as any)[k]] as [string, LinkedMarker]; });
	entries.sort(function (a, b) {
		return (a[1].linkedAt || 0) - (b[1].linkedAt || 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
	});
	var out = new Map<string, string[]>();
	for (var i = 0; i < entries.length; i++) {
		var o = entries[i][1].original;
		if (!out.has(o)) out.set(o, []);
		(out.get(o) as string[]).push(entries[i][0]);
	}
	return out;
}

/**
 * A short duration for a link ("0.4 s", "1.9 s", "12 s", then formatIndexDuration's words).
 * A link takes about a second, so the whole-second helper would print nothing for it.
 */
export function formatLinkDuration(ms?: number): string {
	if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
	if (ms < 10000) return (Math.max(ms, 100) / 1000).toFixed(1) + ' s';
	return formatIndexDuration(ms);
}

/** The chat indexing row's line for a linked copy: "Same content as A: linked in 0.4 s, no AI used". */
export function linkedRowLabel(original: string, ms?: number): string {
	var took = formatLinkDuration(ms);
	return 'Same content as ' + fileNameOf(original) + ': linked' + (took ? ' in ' + took : '') + ', no AI used';
}

/**
 * A linked pass's answer, as the worker writes it ("[skapi] Same content as "A.tif": linked
 * to its index in 1.9 s, no AI used. ..."), read back: { original (the file NAME it gives),
 * ms }, or null for any other text.
 */
export function parseLinkedReply(text: any): { original: string; ms?: number } | null {
	if (typeof text !== 'string' || text.indexOf('[skapi] Same content as "') === -1) return null;
	var m = /\[skapi\] Same content as "([^"]+)": linked to its index(?: in ([0-9]+(?:\.[0-9]+)?) s)?/.exec(text);
	if (!m) return null;
	var secs = m[2] !== undefined ? Number(m[2]) : NaN;
	return { original: m[1], ms: isFinite(secs) ? Math.round(secs * 1000) : undefined };
}

// ------------------------------------------------------------------- promotion

/** Who sends the copies again: the signed-in user, and whether they own the project. */
export type PromotionActor = { userId?: string | null; isProjectOwner?: boolean };

/**
 * The linked copies `actor` may send to indexing again (review 2026-11-26): every copy for the
 * project owner, otherwise only the copies the actor uploaded (the marker's copy_owner). Another
 * user's copy is never re-indexed from this user's session: it would read that user's file
 * (perhaps a private one) and write its index under this user's records and upload group. A copy
 * left out keeps its link; once the original holds other content the server answers it as having
 * no index, the Files page shows it red ("Original removed or failed") and its Reindex fixes it.
 */
export function promotableCopies(
	linked: Map<string, LinkedMarker> | { [path: string]: LinkedMarker },
	actor: PromotionActor,
): Map<string, LinkedMarker> {
	var entries: [string, LinkedMarker][] = linked instanceof Map
		? Array.from(linked.entries())
		: Object.keys(linked).map(function (k) { return [k, (linked as any)[k]] as [string, LinkedMarker]; });
	var out = new Map<string, LinkedMarker>();
	for (var i = 0; i < entries.length; i++) {
		var m = entries[i][1];
		if (actor.isProjectOwner || (!!actor.userId && !!m && m.owner === actor.userId)) out.set(entries[i][0], m);
	}
	return out;
}

/**
 * The copies to send again when originals go away (a delete, a folder delete, an Overwrite
 * of an original), per original, oldest first. The first copy of each list becomes the new
 * original (one real AI run, sent with the share flag so it claims the content); the others
 * are sent after it and link to it. Copies that are themselves being removed are left out, and
 * with `actor`, the copies that user may not re-index (promotableCopies).
 * `removed`: the storage paths going away; `removedFolders`: folder paths whose whole
 * content goes away.
 */
export function copiesToPromote(
	linked: Map<string, LinkedMarker> | { [path: string]: LinkedMarker },
	removed: string[],
	removedFolders?: string[],
	actor?: PromotionActor | null,
): { original: string; copies: string[] }[] {
	if (actor) linked = promotableCopies(linked, actor);
	var gone = new Set<string>(removed || []);
	var folders = (removedFolders || []).filter(Boolean).map(function (f) { return f.replace(/\/+$/, '') + '/'; });
	var isGone = function (p: string): boolean {
		if (gone.has(p)) return true;
		for (var i = 0; i < folders.length; i++) if (p.indexOf(folders[i]) === 0) return true;
		return false;
	};
	var out: { original: string; copies: string[] }[] = [];
	copiesByOriginal(linked).forEach(function (copies, original) {
		if (!isGone(original)) return;
		var keep = copies.filter(function (c) { return !isGone(c); });
		if (keep.length) out.push({ original: original, copies: keep });
	});
	return out;
}

// ------------------------------------------------------------------------ reads

function listOf(res: any): any[] {
	return (res && Array.isArray(res.list)) ? res.list : [];
}

/**
 * The live content claim ids of a project ("cas::..."), from one prefix listing of unique
 * ids (open to every signed-in caller, whatever group the claim is in), or null when it
 * could not be read or was cut off (then absence proves nothing).
 */
export async function listContentClaims(skapi: any, service: string, maxPages = 5): Promise<Set<string> | null> {
	if (!skapi || typeof skapi.getUniqueId !== 'function' || !service) return null;
	try {
		var out = new Set<string>();
		var fetchMore = false;
		for (var page = 0; page < maxPages; page++) {
			var res: any = await skapi.getUniqueId(
				{ service: service, unique_id: CONTENT_CLAIM_PREFIX, condition: 'gte' },
				{ limit: 1000, fetchMore: fetchMore },
			);
			var list = listOf(res);
			for (var i = 0; i < list.length; i++) {
				var id = typeof list[i] === 'string' ? list[i] : (list[i] && list[i].unique_id);
				if (typeof id === 'string' && id.indexOf(CONTENT_CLAIM_PREFIX) === 0) out.add(id);
			}
			if (!res || res.endOfList !== false) return out;
			fetchMore = true;
		}
		return null;
	} catch (err: any) {
		var msg = String((err && (err.code || err.message)) || err || '');
		if (/NOT_EXISTS|not exist/i.test(msg)) return new Set<string>();
		return null;
	}
}

/**
 * Every linked copy of a project, fresh: Map(copy path -> LinkedMarker), from the done::
 * markers tagged "bq_linked". Null when it could not be read. Used before a delete or an
 * Overwrite, where a 30-second-old sweep could miss a copy linked a moment ago.
 */
export async function listLinkedCopies(skapi: any, service: string, maxPages = 10): Promise<Map<string, LinkedMarker> | null> {
	if (!skapi || typeof skapi.getRecords !== 'function' || !service) return null;
	var out = new Map<string, LinkedMarker>();
	try {
		var fetchMore = false;
		for (var page = 0; page < maxPages; page++) {
			var res: any = await skapi.getRecords(
				{ service: service, table: { name: '__INDEXING__', access_group: 'authorized' }, tag: LINKED_COPY_TAG },
				{ limit: 1000, fetchMore: fetchMore },
			);
			var list = listOf(res);
			for (var i = 0; i < list.length; i++) {
				var r = list[i] || {};
				var uid = String(r.unique_id || '');
				if (uid.indexOf('done::') !== 0) continue;
				var mk = linkedMarkerOf(r.data);
				if (mk) out.set(uid.slice(6), mk);
			}
			if (!res || res.endOfList !== false) return out;
			fetchMore = true;
		}
		return out;
	} catch (err: any) {
		var msg = String((err && (err.code || err.message)) || err || '');
		if (/NOT_EXISTS|not exist/i.test(msg)) return out;
		return null;
	}
}

// ------------------------------------------------- "Find identical files" (owner)

export type IdenticalFileEntry = { path: string; group?: any; uploader?: string | null; indexed?: boolean; indexed_at?: number | null };
export type IdenticalGroup = { content_key: string; original: IdenticalFileEntry; copies: IdenticalFileEntry[] };
export type IdenticalScan = { complete: boolean; scanned: number; total: number; groups: IdenticalGroup[]; skipped?: { path: string; reason: string }[] };

function bodyOf(res: any): any {
	if (typeof res === 'string') {
		try { return JSON.parse(res); } catch (_) { return res; }
	}
	return res;
}

function errorText(err: any): string {
	var b = err && (err.body || err.data || err.response);
	var bb = bodyOf(b);
	if (bb && typeof bb === 'object') {
		if (typeof bb.reason === 'string') return bb.reason;
		if (typeof bb.message === 'string') return bb.message;
	}
	if (typeof bb === 'string' && bb) return bb;
	return String((err && err.message) || err || 'The request failed.');
}

async function callMcpRoute(route: string, args: { service: string; owner?: string }, data: any): Promise<any> {
	var base = String(chatEngineConfig().mcpBaseUrl || '').replace(/\/+$/, '');
	if (!base) throw new Error('No BunnyQuery server is configured.');
	var res = await resolveForwardRequest()({
		service: args.service,
		...(args.owner ? { owner: args.owner } : {}),
		url: base + route,
		method: 'POST',
		headers: { 'content-type': 'application/json', Authorization: 'Bearer $ACCESS_TOKEN' },
		data: Object.assign({ project_id: args.service }, data),
	});
	return bodyOf(res);
}

/**
 * The owner's scan for identical files that are indexed separately (MCP
 * /internal/identical-files). Calls again while the server says it is not complete (each
 * call keeps what the last one read), up to `maxCalls`. `onProgress` hears each answer.
 * Rejects with the server's words when it refuses (not the owner, no session).
 */
export async function findIdenticalFiles(
	args: { service: string; owner?: string; maxCalls?: number; budgetS?: number; onProgress?: (scan: IdenticalScan) => void },
): Promise<IdenticalScan> {
	var calls = Math.max(1, args.maxCalls || 12);
	var last: IdenticalScan | null = null;
	for (var i = 0; i < calls; i++) {
		var body: any;
		try {
			// a short budget per call: the relay ends a request after about 29 s, and what one
			// call read is kept on the server for the next
			body = await callMcpRoute('/internal/identical-files', args, { budget_s: args.budgetS || 8 });
		} catch (err) {
			var msg = errorText(err);
			// timed out at the relay: the server kept what it read, so ask again
			if (/timed? ?out|timeout|504/i.test(msg) && i < calls - 1) continue;
			throw new Error(msg);
		}
		if (!body || typeof body !== 'object' || !Array.isArray(body.groups)) {
			throw new Error(typeof body === 'string' && body ? body : 'The server did not answer the scan.');
		}
		last = { complete: !!body.complete, scanned: Number(body.scanned) || 0, total: Number(body.total) || 0, groups: body.groups, skipped: body.skipped };
		if (args.onProgress) args.onProgress(last);
		if (last.complete) return last;
	}
	return last as IdenticalScan;
}

/**
 * Link one copy to an original the owner confirmed (MCP /internal/identical-link, no AI):
 * the copy's own index is removed and it shares the original's. Resolves to the server's
 * answer ({ linked: true, ... }) or { linked: false, reason } when it was refused. Never
 * rejects.
 */
export async function linkIdenticalFile(
	args: { service: string; owner?: string; copy: string; original: string },
): Promise<{ linked: boolean; reason?: string; [k: string]: any }> {
	// A merge can outlast the request relay (about 29 s: the copy's own index is removed
	// first). The server finishes it anyway, and the route is idempotent (an already linked
	// copy answers linked: true at once), so a timed-out call is asked again.
	var last = '';
	for (var attempt = 0; attempt < 4; attempt++) {
		try {
			var body = await callMcpRoute('/internal/identical-link', args, { copy: args.copy, original: args.original });
			if (body && typeof body === 'object' && typeof body.linked === 'boolean') return body;
			return { linked: false, reason: typeof body === 'string' && body ? body : 'unexpected answer' };
		} catch (err) {
			last = errorText(err);
			if (!/timed? ?out|timeout|504/i.test(last)) return { linked: false, reason: last };
			await new Promise(function (r) { setTimeout(r, 8000); });
		}
	}
	return { linked: false, reason: last || 'timed out' };
}

/** Plain words for identical-link's refusal reasons. */
export function identicalLinkReasonText(reason?: string): string {
	switch (reason) {
		case 'not_identical': return 'the two files no longer have the same content';
		case 'original_not_indexed': return 'the original is not indexed';
		case 'original_is_a_copy': return 'the original is itself a linked copy';
		case 'less_open_original': return 'the original can be read by fewer people than the copy';
		case 'private_original': return 'the original is private';
		case 'private_copy': return 'the copy is another user\'s private file: it shares the index once that user indexes it again';
		case 'content_claimed_by_another_file': return 'another file already holds this content\'s index';
		case 'not_readable': return 'one of the files could not be read from storage';
		case 'different_kind': return 'the files are of different kinds';
		case 'no_file_record': return 'one of the files has no index record';
		case 'unshared_access_group': return 'the file\'s access group cannot share an index';
		default: return reason || 'refused';
	}
}
