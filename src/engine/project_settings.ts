/**
 * The project's BunnyQuery settings, held as a record in the project's own
 * database rather than on the skapi service record.
 *
 * WHY A RECORD. The upload access group used to live on the service record as
 * `default_access_group`, which was ALSO the skapi SDK's project-wide default
 * for `table.access_group`. One field meant two things: "what BunnyQuery indexes
 * new files at" and "what every SDK record call on this project defaults to".
 * That coupling is gone. The SDK no longer has a project default at all, so this
 * setting needs a home of its own, and a plain public record in the customer's
 * own project is one every client can already reach with the calls it has.
 *
 * SHAPE. One record per project, holding an OBJECT rather than a single value:
 *
 *     unique_id: 'bq::settings'
 *     table:     { name: '__SETTINGS__', access_group: 'public' }
 *     data:      { upload_access_group: 'authorized' }
 *
 * One record and one fetch covers every present and future project setting. A
 * second setting is a new key, not a new record, so the "wait for settings
 * before the first upload" hand-off below never has to become several waits.
 *
 * WHY PUBLIC. The widget reads this, and the widget frequently runs before there
 * is any session. Group 0 is the only group an unauthenticated caller is served
 * (`check_rec_access` returns immediately for "00" and refuses the rest). Note
 * this is NOT sufficient on its own: skapi's `require_login` gate refuses ALL
 * database reads from a signed-out visitor, and it defaults to true, so on most
 * projects a signed-out widget still cannot read this and falls back to the
 * default. That is survivable because the only thing a signed-out visitor could
 * do with the value is upload, which they cannot do either.
 *
 * WHY THE VALUE MATTERS. The file BYTES are not what the access group controls.
 * BunnyQuery uploads to db storage, whose object key carries no access group and
 * whose read path performs no access check. What carries the group is the
 * RECORDS: the `src::` file record in `file_summaries`, the `run::`/`done::`
 * markers in `__INDEXING__`, and every content record the indexing agent
 * extracts. Those are what a chat answers from, so those are what decide who the
 * file is visible to. The same value is also handed to the chat system prompt as
 * `indexAccessGroup`, because a record written under a different group is in a
 * different table and never comes back with the rest of the file.
 *
 * TRANSPORT-FREE, like the rest of the engine. The store never imports a skapi
 * instance; the consumer injects a reader. See configureProjectSettings.
 */

/** The access groups a BunnyQuery upload may be recorded at. */
export type UploadAccessGroup = 'public' | 'authorized' | 'private';

export const UPLOAD_ACCESS_GROUPS: UploadAccessGroup[] = ['public', 'authorized', 'private'];

/**
 * What the project's upload-access setting may be: one of the three groups the
 * dashboard offers, or 'ask' to be prompted per upload.
 *
 * `'admin'` (99) is deliberately not offered: a file only a master can read is
 * indistinguishable from one that failed to upload, and no dashboard control
 * would produce it.
 */
export type ProjectAccessSetting = UploadAccessGroup | 'ask';

/**
 * `authorized` is the default because it is what every record written before
 * this setting existed was hardcoded to. A project that never opens the setting
 * keeps exactly the visibility it already had. It is also what the abandoned
 * `default_access_group` service field was seeded to at project creation, so a
 * project carrying that old value reads the same before and after the move.
 */
export const DEFAULT_UPLOAD_ACCESS_GROUP: UploadAccessGroup = 'authorized';

/** Where the settings record lives. Shared so no client re-derives it. */
export const PROJECT_SETTINGS_TABLE = '__SETTINGS__';
export const PROJECT_SETTINGS_UNIQUE_ID = 'bq::settings';
export const PROJECT_SETTINGS_ACCESS_GROUP = 'public';

export const UPLOAD_ACCESS_LABELS: Record<UploadAccessGroup, string> = {
	public: 'Public',
	authorized: 'Signed in users',
	private: 'Only me',
};

export const UPLOAD_ACCESS_HINTS: Record<UploadAccessGroup, string> = {
	public: 'Anyone can ask about this file, including visitors who are not logged in.',
	authorized: 'Only users signed in to this project can ask about this file.',
	private: 'Only you can ask about this file.',
};

/** Menu/modal option list, in the order they should be shown. */
export const UPLOAD_ACCESS_OPTIONS = UPLOAD_ACCESS_GROUPS.map((value) => ({
	value,
	label: UPLOAD_ACCESS_LABELS[value],
	hint: UPLOAD_ACCESS_HINTS[value],
}));

/** The settings record's `data`. Open-ended: future settings are new keys. */
export type ProjectSettingsData = {
	upload_access_group?: unknown;
	[key: string]: unknown;
};

/** Narrow an unknown stored value to a usable group, falling back to the default. */
export function normalizeUploadAccessGroup(value: any): UploadAccessGroup {
	return UPLOAD_ACCESS_GROUPS.indexOf(value) === -1
		? DEFAULT_UPLOAD_ACCESS_GROUP
		: (value as UploadAccessGroup);
}

/**
 * The stored setting as written, or null when the project has never set one.
 *
 * Returns null rather than a default so callers can tell "unset" from "set to
 * authorized". The settings page needs that distinction to decide what the
 * control shows; upload paths do not and use uploadAccessGroupFrom instead.
 */
export function normalizeProjectAccessSetting(value: any): ProjectAccessSetting | null {
	if (value === 'ask') return 'ask';
	return UPLOAD_ACCESS_GROUPS.indexOf(value) === -1 ? null : (value as ProjectAccessSetting);
}

/** The setting held in a settings-record `data`, or null when unset. */
export function accessSettingFrom(
	data: ProjectSettingsData | null | undefined,
): ProjectAccessSetting | null {
	return normalizeProjectAccessSetting(data?.upload_access_group);
}

/** The group an upload lands in when the project is NOT set to 'ask'. */
export function uploadAccessGroupFrom(
	data: ProjectSettingsData | null | undefined,
): UploadAccessGroup {
	const v = accessSettingFrom(data);
	return v && v !== 'ask' ? v : DEFAULT_UPLOAD_ACCESS_GROUP;
}

/** True when the project wants to be asked per upload rather than told once. */
export function asksUploadAccessFrom(data: ProjectSettingsData | null | undefined): boolean {
	return accessSettingFrom(data) === 'ask';
}

/**
 * Fetch one project's settings record. Resolves the record's `data`, or null
 * when there is no record.
 *
 * MAY REJECT, and the store treats a rejection as "no record": a signed-out
 * visitor on a `require_login` project gets REQUIRE_LOGIN here, which is a
 * normal outcome and not an error the user should ever see.
 */
export type ProjectSettingsReader = (service: string) => Promise<ProjectSettingsData | null>;

type Entry = {
	/** Resolved data, or null for "fetched, and there is none". */
	data: ProjectSettingsData | null;
	/** True once a fetch has SETTLED, so `data` is authoritative rather than absent. */
	settled: boolean;
	/** The in-flight fetch, deduped so N callers share ONE request. */
	inflight: Promise<ProjectSettingsData | null> | null;
};

let reader: ProjectSettingsReader | null = null;

/**
 * Keyed by service id, NEVER global.
 *
 * One client routinely serves MANY projects: the console switches projects
 * without reloading, and an upload outlives the page that started it. A flat
 * single-value cache lets one project's setting decide another project's upload
 * group, which is a silent cross-project data-visibility bug, not a stale-read
 * annoyance. Every accessor takes the service id for this reason.
 */
const cache = new Map<string, Entry>();

export function configureProjectSettings(fn: ProjectSettingsReader | null): void {
	reader = fn;
}

function entry(service: string): Entry {
	let e = cache.get(service);
	if (!e) {
		e = { data: null, settled: false, inflight: null };
		cache.set(service, e);
	}
	return e;
}

/**
 * Start the fetch and hand back the promise, deduping concurrent callers.
 *
 * Never rejects: a failed read settles as null, which every accessor reads as
 * "unset" and answers with the default. A settings fetch must not be able to
 * fail an upload.
 */
export function loadProjectSettings(service: string): Promise<ProjectSettingsData | null> {
	if (!service) return Promise.resolve(null);
	const e = entry(service);
	if (e.settled) return Promise.resolve(e.data);
	if (e.inflight) return e.inflight;
	if (!reader) return Promise.resolve(null);

	const run: Promise<ProjectSettingsData | null> = reader(service)
		.then((data) => (data && typeof data === 'object' ? data : null))
		.catch(() => null)
		.then((data) => {
			// Guard against a clear() that landed while this was in flight: the
			// entry may have been replaced, so write through the map rather than
			// through the captured object.
			const cur = entry(service);
			if (cur.inflight === run) {
				cur.data = data;
				cur.settled = true;
				cur.inflight = null;
			}
			return data;
		});

	e.inflight = run;
	return run;
}

/**
 * Kick the fetch off without waiting for it. Call on chat/page open.
 *
 * Fire-and-forget by design: the page paints on the default and the first upload
 * awaits the real value via readyProjectSettings. Nothing blocks on this.
 */
export function primeProjectSettings(service: string): void {
	void loadProjectSettings(service);
}

/**
 * Await the settings for this project. What the FIRST upload calls.
 *
 * Cheap after the first call: a settled entry resolves immediately, and a
 * primed-but-unsettled one joins the in-flight request rather than starting a
 * second.
 */
export function readyProjectSettings(service: string): Promise<ProjectSettingsData | null> {
	return loadProjectSettings(service);
}

/**
 * The cached data WITHOUT waiting, or null when nothing has settled yet.
 *
 * For synchronous readers (a template, a menu's current value). A caller that is
 * about to WRITE an access group onto a record must use readyProjectSettings
 * instead: answering from an unsettled cache is how a file lands in the wrong
 * group on the first upload after a page load.
 */
export function cachedProjectSettings(service: string): ProjectSettingsData | null {
	const e = cache.get(service);
	return e && e.settled ? e.data : null;
}

/** True once this project's settings have been fetched (whether or not one existed). */
export function projectSettingsSettled(service: string): boolean {
	const e = cache.get(service);
	return !!e && e.settled;
}

/** Sync convenience: the project's setting as stored, or null when unset/unsettled. */
export function projectAccessSetting(service: string): ProjectAccessSetting | null {
	return accessSettingFrom(cachedProjectSettings(service));
}

/** Sync convenience: the upload group, falling back to the default. */
export function projectUploadAccessGroup(service: string): UploadAccessGroup {
	return uploadAccessGroupFrom(cachedProjectSettings(service));
}

/** Sync convenience: does this project want a per-upload prompt? */
export function projectAsksUploadAccess(service: string): boolean {
	return asksUploadAccessFrom(cachedProjectSettings(service));
}

/**
 * Adopt a value the caller just WROTE, so the settings page reflects its own
 * save without a re-fetch.
 *
 * Marks the entry settled: the writer knows the stored value better than a
 * refetch would, and leaving it unsettled would send the next upload back to the
 * network for a value already in hand.
 */
export function setProjectSettings(service: string, data: ProjectSettingsData | null): void {
	if (!service) return;
	cache.set(service, { data: data || null, settled: true, inflight: null });
}

/** Merge one key into the cached settings, preserving the rest. */
export function patchProjectSettings(service: string, patch: ProjectSettingsData): void {
	if (!service) return;
	const cur = cachedProjectSettings(service) || {};
	setProjectSettings(service, Object.assign({}, cur, patch));
}

/**
 * Drop cached settings. Pass a service to drop one, omit to drop all.
 *
 * An in-flight fetch is abandoned rather than cancelled: its `.then` checks that
 * the entry it is writing into is still its own, so a late response cannot
 * repopulate a cleared project.
 */
export function clearProjectSettings(service?: string): void {
	if (service) cache.delete(service);
	else cache.clear();
}
