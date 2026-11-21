/**
 * Duplicate-upload detection for chat attachments (reliability plan, owner's
 * yes 2026-10-12): "has the signed-in user already uploaded THIS file to this
 * project?", answered from the file records the upload path already writes.
 *
 * WHAT COUNTS AS THE SAME FILE. Same name, same size in bytes, same uploader, and a
 * stored copy that finished indexing or is still being indexed (see findDuplicateUpload).
 * Every upload creates a `src::<storagePath>` record (table `file_summaries`)
 * whose `data.size_bytes` is the byte count and whose `user_id` is the
 * uploader, so a lookup by name narrowed by those two fields finds a file
 * without reading its bytes. A different user's identical file is NOT a
 * duplicate: that user's copy sits at a different access group and path and
 * may be invisible to this one.
 *
 * HOW THE NAME IS FOUND. `getUniqueId` with `condition: '<='` is an ENDS-WITH
 * match on the record id (served from the reversed proxy rows), and a file
 * record's id ends with the file's name: `src::<name>` for a file at the
 * root, `src::<folders>/<name>` otherwise. The match is then narrowed to
 * exactly those two shapes, so `src::report.pdf` is not found by "port.pdf",
 * and to the `src::` prefix, because the `run::` and `done::` index markers
 * end with the same path and are not files.
 *
 * NEVER THROWS. A failed or refused lookup (a signed-out visitor on a
 * require_login project, a region without the proxy rows yet, a network
 * error) answers null, and null means "upload as usual": the check exists to
 * save an indexing run, and must never be able to cost one.
 *
 * TRANSPORT-FREE like the rest of the engine: the caller hands in the skapi
 * instance it owns. The widget passes its own; a host with no instance simply
 * does not wire the hook and uploads as before.
 */

import { RUN_RECORD_WORKING_STALE_MS } from './indexing_groups';

/** The record found, with the storage path the stored file lives at. */
export type DuplicateUploadMatch = {
	/** The stored file's db storage path (the record id without `src::`). */
	storagePath: string;
	/** The matching `src::` record id. */
	uniqueId: string;
	/** The file record as read. */
	record: any;
	/** Why it is skipped: the stored copy finished indexing, or is being indexed. */
	indexing?: StoredCopyIndexing;
};

export type DuplicateUploadFile = {
	/** The file name as it is STORED: the last segment of the storage path. */
	name: string;
	/** Size in bytes. */
	size: number;
};

/** The `src::` records to read before giving up; a name is rarely shared this widely. */
export const DUPLICATE_LOOKUP_MAX_CANDIDATES = 25;

const SRC_PREFIX = 'src::';

/** Narrow an ends-with listing to real file records for exactly this name. */
export function isDuplicateCandidateId(uniqueId: unknown, name: string): boolean {
	if (typeof uniqueId !== 'string' || !name) return false;
	if (uniqueId.indexOf(SRC_PREFIX) !== 0) return false;
	if (uniqueId === SRC_PREFIX + name) return true;
	const tail = '/' + name;
	return uniqueId.length > SRC_PREFIX.length + tail.length && uniqueId.slice(-tail.length) === tail;
}

function listOf(res: any): any[] {
	if (!res) return [];
	if (Array.isArray(res)) return res;
	return Array.isArray(res.list) ? res.list : [];
}

/** How long one check may take. A slower lookup answers "not a duplicate": upload as usual. */
export const DUPLICATE_LOOKUP_TIMEOUT_MS = 15_000;
/** Most ids the ends-with listing fetches. */
export const DUPLICATE_LOOKUP_LIMIT = 500;

/** The stored copy's indexing state, read from its `done::` and `run::` markers. */
export type StoredCopyIndexing = 'done' | 'running' | 'other';

/** NFC, the form storage paths are written in, so a composed name matches its record. */
function nfc(text: string): string {
	try {
		return String(text || '').normalize('NFC');
	} catch {
		return String(text || '');
	}
}

/**
 * Is the stored copy indexed, being indexed, or neither? `done::<path>` exists: done. Its
 * `run::<path>` record says 'working' and started less than RUN_RECORD_WORKING_STALE_MS ago
 * (the window the file browser uses for "still indexing"): running. Anything else, a failed
 * or cancelled run, a run that died without closing its record, no record, or a lookup that
 * failed: other.
 */
async function storedCopyIndexing(skapi: any, storagePath: string, service: { service?: string }): Promise<StoredCopyIndexing> {
	const doneId = 'done::' + storagePath;
	try {
		const done = listOf(await skapi.getUniqueId(Object.assign({ unique_id: doneId }, service), { fetchMore: false, limit: 1 }));
		if (done.some(function (it: any) { return (it && typeof it === 'object' ? it.unique_id : it) === doneId; })) return 'done';
	} catch {
		/* no marker, or the lookup failed: read the run record */
	}
	try {
		const run = listOf(await skapi.getRecords(Object.assign({ unique_id: 'run::' + storagePath }, service)))[0];
		const data = run && run.data && typeof run.data === 'object' ? run.data : null;
		if (data && data.status === 'working' && typeof data.started === 'number'
			&& Date.now() - data.started < RUN_RECORD_WORKING_STALE_MS) return 'running';
	} catch {
		/* no run record (NOT_EXISTS) or unreadable: not running */
	}
	return 'other';
}

/**
 * This user's stored copy of `file`, when the upload should be SKIPPED, or null to upload as
 * usual. One implementation for the widget and the site (www's duplicates.ts wraps it).
 *
 * THE RULE (owner, 2026-11-20). A `src::` record for `file.name` (root or any folder) whose
 * `data.size_bytes` equals `file.size` and whose `user_id` is `userId`, AND whose stored copy
 * finished indexing or is still being indexed (storedCopyIndexing). A copy whose indexing
 * failed or was cancelled is NOT a duplicate: the upload goes on and reaches the host's usual
 * "already exists: Skip / Reindex / Overwrite" question, instead of being skipped silently
 * with no way to index it again.
 *
 * NEVER THROWS and never takes longer than `opts.timeoutMs` (DUPLICATE_LOOKUP_TIMEOUT_MS): a
 * failed, refused or slow lookup answers null. `opts.service` is passed through to every skapi
 * call when given (the widget and the site name the project on every call).
 */
export async function findDuplicateUpload(
	skapi: any,
	file: DuplicateUploadFile,
	userId: string,
	opts?: { service?: string; timeoutMs?: number },
): Promise<DuplicateUploadMatch | null> {
	const timeoutMs = opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs >= 0 ? opts.timeoutMs : DUPLICATE_LOOKUP_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<null>(function (resolve) {
		timer = setTimeout(function () { resolve(null); }, timeoutMs);
	});
	try {
		return await Promise.race([lookupDuplicate(skapi, file, userId, opts), deadline]);
	} catch {
		return null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function lookupDuplicate(
	skapi: any,
	file: DuplicateUploadFile,
	userId: string,
	opts?: { service?: string },
): Promise<DuplicateUploadMatch | null> {
	if (!skapi || typeof skapi.getUniqueId !== 'function' || typeof skapi.getRecords !== 'function') return null;
	const name = nfc(file && typeof file.name === 'string' ? file.name.split('/').pop() || '' : '');
	const size = file && typeof file.size === 'number' ? file.size : NaN;
	if (!name || !(size >= 0) || !userId) return null;
	const service = opts && opts.service ? { service: opts.service } : {};

	const found = listOf(await skapi.getUniqueId(
		Object.assign({ unique_id: name, condition: '<=' }, service),
		{ fetchMore: false, limit: DUPLICATE_LOOKUP_LIMIT },
	));
	const ids: string[] = [];
	for (const item of found) {
		const id = item && typeof item === 'object' ? item.unique_id : item;
		if (isDuplicateCandidateId(id, name) && ids.indexOf(id) === -1) ids.push(id);
		if (ids.length >= DUPLICATE_LOOKUP_MAX_CANDIDATES) break;
	}

	for (const uniqueId of ids) {
		let record: any = null;
		try {
			record = listOf(await skapi.getRecords(Object.assign({ unique_id: uniqueId }, service)))[0] || null;
		} catch {
			// One unreadable candidate (another group, a deleted record) is not
			// the answer; the next one may be.
			continue;
		}
		if (!record || typeof record !== 'object') continue;
		const data = record.data && typeof record.data === 'object' ? record.data : null;
		if (!data || data.size_bytes !== size) continue;
		if (record.user_id !== userId) continue;
		const storagePath = uniqueId.slice(SRC_PREFIX.length);
		const indexing = await storedCopyIndexing(skapi, storagePath, service);
		if (indexing === 'other') continue;
		return { storagePath, uniqueId, record, indexing };
	}
	return null;
}
