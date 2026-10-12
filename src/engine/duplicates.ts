/**
 * Duplicate-upload detection for chat attachments (reliability plan, owner's
 * yes 2026-10-12): "has the signed-in user already uploaded THIS file to this
 * project?", answered from the file records the upload path already writes.
 *
 * WHAT COUNTS AS THE SAME FILE. Same name, same size in bytes, same uploader.
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

/** The record found, with the storage path the stored file lives at. */
export type DuplicateUploadMatch = {
	/** The stored file's db storage path (the record id without `src::`). */
	storagePath: string;
	/** The matching `src::` record id. */
	uniqueId: string;
	/** The file record as read. */
	record: any;
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

/**
 * The first `src::` record for `file.name` whose `data.size_bytes` equals
 * `file.size` and whose `user_id` is `userId`, or null. `opts.service` is passed
 * through to both skapi calls when given (the widget names the project on every
 * call); otherwise the instance's own project is queried.
 */
export async function findDuplicateUpload(
	skapi: any,
	file: DuplicateUploadFile,
	userId: string,
	opts?: { service?: string },
): Promise<DuplicateUploadMatch | null> {
	try {
		if (!skapi || typeof skapi.getUniqueId !== 'function' || typeof skapi.getRecords !== 'function') return null;
		const name = file && typeof file.name === 'string' ? file.name : '';
		const size = file && typeof file.size === 'number' ? file.size : NaN;
		if (!name || !(size >= 0) || !userId) return null;
		const service = opts && opts.service ? { service: opts.service } : {};

		const found = listOf(await skapi.getUniqueId(Object.assign({ unique_id: name, condition: '<=' }, service)));
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
			return { storagePath: uniqueId.slice(SRC_PREFIX.length), uniqueId, record };
		}
		return null;
	} catch {
		return null;
	}
}
