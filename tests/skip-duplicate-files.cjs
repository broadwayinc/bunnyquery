/**
 * Skip duplicate uploads (owner's yes, 2026-10-12).
 *
 * A chat attachment the signed-in user already uploaded to the project (same
 * stored name, same size, same uploader) is neither uploaded nor indexed again:
 * the turn takes the stored copy's url and the chip says "already uploaded".
 *
 * What this pins:
 *   - findDuplicateUpload's contract: ends-with lookup by name, narrowed to
 *     `src::<name>` or `src::.../<name>` (never `run::`/`done::` markers, never
 *     "port.pdf" finding "report.pdf"), then the first record whose
 *     data.size_bytes equals the size AND whose user_id is the signed-in user;
 *     null for a size mismatch, another uploader, no candidates, or any failure
 *     (it never throws, so a lookup can never block an upload);
 *   - the project setting `skip_duplicate_files` (bq::settings), ON by default,
 *     only the literal false turning it off;
 *   - the resolution rule shared with web access: the project setting is the
 *     ceiling and the host's `skipDuplicateFiles` option may only restrict,
 *     effective = projectSetting && hostOption !== false;
 *   - the setting round-trips in the record beside the other keys.
 *
 * Run: node ./tests/skip-duplicate-files.cjs
 */

const assert = require('assert');
const {
    findDuplicateUpload,
    isDuplicateCandidateId,
    DUPLICATE_LOOKUP_MAX_CANDIDATES,
    configureChatEngine,
    configureProjectSettings,
    clearProjectSettings,
    setProjectSettings,
    patchProjectSettings,
    cachedProjectSettings,
    skipDuplicateFilesEnabled,
    resolveSkipDuplicateFiles,
    skipDuplicateFilesFrom,
    normalizeSkipDuplicateFiles,
    projectSkipDuplicateFiles,
    DEFAULT_SKIP_DUPLICATE_FILES,
    webAccessEnabled,
    resolveWebAccess,
} = require('../dist/engine.cjs');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

/* ---- a fake skapi ----------------------------------------------------------------- */

// `ids`: what getUniqueId('<=') lists for ANY name (the test narrows by shape).
// `records`: unique_id -> record as getRecords would return it.
function fakeSkapi(ids, records, opts) {
    const calls = { getUniqueId: [], getRecords: [] };
    return {
        calls,
        getUniqueId: async (q) => {
            calls.getUniqueId.push(q);
            if (opts && opts.failLookup) throw new Error('REQUIRE_LOGIN');
            return { list: ids.map((id) => ({ unique_id: id, record_id: 'rec_' + id })), endOfList: true };
        },
        getRecords: async (q) => {
            calls.getRecords.push(q);
            if (opts && opts.failRead === q.unique_id) throw new Error('NOT_EXISTS');
            const r = records[q.unique_id];
            return { list: r ? [r] : [], endOfList: true };
        },
    };
}
const rec = (uid, size, user) => ({ unique_id: uid, user_id: user, data: { size_bytes: size, storage_path: uid.slice(5) } });

(async () => {

/* ---- the helper's contract ------------------------------------------------------- */

await test('the call shape: getUniqueId by name with condition "<=", then getRecords by unique_id', async () => {
    const sk = fakeSkapi(['src::u1/a.pdf'], { 'src::u1/a.pdf': rec('src::u1/a.pdf', 10, 'u1') });
    const hit = await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, 'u1');
    assert.deepStrictEqual(sk.calls.getUniqueId, [{ unique_id: 'a.pdf', condition: '<=' }]);
    assert.deepStrictEqual(sk.calls.getRecords, [{ unique_id: 'src::u1/a.pdf' }]);
    assert.ok(hit);
    assert.strictEqual(hit.storagePath, 'u1/a.pdf');
    assert.strictEqual(hit.uniqueId, 'src::u1/a.pdf');
    assert.strictEqual(hit.record.user_id, 'u1');
});

await test('opts.service rides on both calls when given (the widget names the project)', async () => {
    const sk = fakeSkapi(['src::u1/a.pdf'], { 'src::u1/a.pdf': rec('src::u1/a.pdf', 10, 'u1') });
    await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, 'u1', { service: 'svc_1' });
    assert.strictEqual(sk.calls.getUniqueId[0].service, 'svc_1');
    assert.strictEqual(sk.calls.getRecords[0].service, 'svc_1');
});

await test('name matches but the size differs: null', async () => {
    const sk = fakeSkapi(['src::u1/a.pdf'], { 'src::u1/a.pdf': rec('src::u1/a.pdf', 11, 'u1') });
    assert.strictEqual(await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, 'u1'), null);
});

await test('same name and size but another uploader: null', async () => {
    const sk = fakeSkapi(['src::u2/a.pdf'], { 'src::u2/a.pdf': rec('src::u2/a.pdf', 10, 'u2') });
    assert.strictEqual(await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, 'u1'), null);
});

await test('the first record that matches BOTH size and uploader wins, later ones are not read', async () => {
    const sk = fakeSkapi(
        ['src::u2/a.pdf', 'src::u1/old/a.pdf', 'src::u1/a.pdf', 'src::u1/x/a.pdf'],
        {
            'src::u2/a.pdf': rec('src::u2/a.pdf', 10, 'u2'),
            'src::u1/old/a.pdf': rec('src::u1/old/a.pdf', 99, 'u1'),
            'src::u1/a.pdf': rec('src::u1/a.pdf', 10, 'u1'),
            'src::u1/x/a.pdf': rec('src::u1/x/a.pdf', 10, 'u1'),
        });
    const hit = await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, 'u1');
    assert.strictEqual(hit.storagePath, 'u1/a.pdf');
    assert.strictEqual(sk.calls.getRecords.length, 3, 'stopped at the first match');
});

await test('root vs folder path: src::<name> and src::<folders>/<name> both count, a longer tail does not', async () => {
    assert.strictEqual(isDuplicateCandidateId('src::a.pdf', 'a.pdf'), true);
    assert.strictEqual(isDuplicateCandidateId('src::u1/a.pdf', 'a.pdf'), true);
    assert.strictEqual(isDuplicateCandidateId('src::u1/deep/er/a.pdf', 'a.pdf'), true);
    assert.strictEqual(isDuplicateCandidateId('src::u1/report-a.pdf', 'a.pdf'), false, 'suffix inside a longer name');
    assert.strictEqual(isDuplicateCandidateId('src::u1/data.pdf', 'a.pdf'), false);
    assert.strictEqual(isDuplicateCandidateId('src::port.pdf', 'report.pdf'), false);
    // The index markers end with the same path and are NOT files.
    assert.strictEqual(isDuplicateCandidateId('run::u1/a.pdf', 'a.pdf'), false);
    assert.strictEqual(isDuplicateCandidateId('done::u1/a.pdf', 'a.pdf'), false);
    assert.strictEqual(isDuplicateCandidateId('page::u1/a.pdf::p1', 'a.pdf'), false);
    assert.strictEqual(isDuplicateCandidateId(null, 'a.pdf'), false);
    assert.strictEqual(isDuplicateCandidateId('src::a.pdf', ''), false);
    // A root-level record reached through the ends-with listing with a folder name.
    const sk = fakeSkapi(['src::u1/report-a.pdf', 'src::a.pdf'], { 'src::a.pdf': rec('src::a.pdf', 10, 'u1') });
    const hit = await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, 'u1');
    assert.strictEqual(hit.storagePath, 'a.pdf');
    assert.deepStrictEqual(sk.calls.getRecords.map((q) => q.unique_id), ['src::a.pdf'], 'the longer-tail id was never read');
});

await test('lookup failure (REQUIRE_LOGIN, network) is null, never a throw', async () => {
    const sk = fakeSkapi(['src::u1/a.pdf'], {}, { failLookup: true });
    assert.strictEqual(await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, 'u1'), null);
    assert.strictEqual(await findDuplicateUpload({ getUniqueId: () => { throw new Error('sync boom'); }, getRecords: async () => ({}) }, { name: 'a.pdf', size: 10 }, 'u1'), null);
});

await test('one unreadable candidate is skipped, the next is still read', async () => {
    const sk = fakeSkapi(['src::u1/gone/a.pdf', 'src::u1/a.pdf'],
        { 'src::u1/a.pdf': rec('src::u1/a.pdf', 10, 'u1') }, { failRead: 'src::u1/gone/a.pdf' });
    const hit = await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, 'u1');
    assert.strictEqual(hit.storagePath, 'u1/a.pdf');
});

await test('no candidates, a missing record, or a record without size_bytes: null', async () => {
    assert.strictEqual(await findDuplicateUpload(fakeSkapi([], {}), { name: 'a.pdf', size: 10 }, 'u1'), null);
    assert.strictEqual(await findDuplicateUpload(fakeSkapi(['src::u1/a.pdf'], {}), { name: 'a.pdf', size: 10 }, 'u1'), null);
    const noSize = { unique_id: 'src::u1/a.pdf', user_id: 'u1', data: { bytes: 10 } };
    assert.strictEqual(await findDuplicateUpload(fakeSkapi(['src::u1/a.pdf'], { 'src::u1/a.pdf': noSize }), { name: 'a.pdf', size: 10 }, 'u1'), null);
});

await test('bad inputs are null without a call: no skapi, no name, no size, no user', async () => {
    const sk = fakeSkapi(['src::u1/a.pdf'], { 'src::u1/a.pdf': rec('src::u1/a.pdf', 10, 'u1') });
    assert.strictEqual(await findDuplicateUpload(null, { name: 'a.pdf', size: 10 }, 'u1'), null);
    assert.strictEqual(await findDuplicateUpload({}, { name: 'a.pdf', size: 10 }, 'u1'), null);
    assert.strictEqual(await findDuplicateUpload(sk, { name: '', size: 10 }, 'u1'), null);
    assert.strictEqual(await findDuplicateUpload(sk, { name: 'a.pdf' }, 'u1'), null);
    assert.strictEqual(await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, ''), null);
    assert.strictEqual(sk.calls.getUniqueId.length, 0);
    // A zero-byte file is still a file.
    const z = fakeSkapi(['src::u1/e.txt'], { 'src::u1/e.txt': rec('src::u1/e.txt', 0, 'u1') });
    assert.ok(await findDuplicateUpload(z, { name: 'e.txt', size: 0 }, 'u1'));
});

await test('the candidate list is capped', async () => {
    const ids = [];
    const records = {};
    for (let i = 0; i < DUPLICATE_LOOKUP_MAX_CANDIDATES + 10; i++) {
        ids.push('src::u1/f' + i + '/a.pdf');
        records['src::u1/f' + i + '/a.pdf'] = rec('src::u1/f' + i + '/a.pdf', 1, 'u1');
    }
    const sk = fakeSkapi(ids, records);
    assert.strictEqual(await findDuplicateUpload(sk, { name: 'a.pdf', size: 10 }, 'u1'), null);
    assert.strictEqual(sk.calls.getRecords.length, DUPLICATE_LOOKUP_MAX_CANDIDATES);
});

/* ---- the setting and the resolution rule ------------------------------------------ */

let records = {};
function configure(opt) {
    configureChatEngine(Object.assign({
        clientSecretRequest: async () => ({ id: 'req_1', status: 'resolved' }),
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
    }, opt === undefined ? {} : { skipDuplicateFiles: opt }));
    clearProjectSettings();
    configureProjectSettings(async (service) => {
        if (service === 'svc_locked') throw new Error('REQUIRE_LOGIN');
        return records[service] || null;
    });
}

await test('the pure readers: ON by default, only the literal false is off', async () => {
    assert.strictEqual(DEFAULT_SKIP_DUPLICATE_FILES, true);
    assert.strictEqual(skipDuplicateFilesFrom(null), true);
    assert.strictEqual(skipDuplicateFilesFrom(undefined), true);
    assert.strictEqual(skipDuplicateFilesFrom({}), true);
    assert.strictEqual(skipDuplicateFilesFrom({ skip_duplicate_files: true }), true);
    assert.strictEqual(skipDuplicateFilesFrom({ skip_duplicate_files: false }), false);
    for (const v of ['false', 0, null, 'off', undefined]) {
        assert.strictEqual(skipDuplicateFilesFrom({ skip_duplicate_files: v }), true, JSON.stringify(v) + ' must read as unset');
    }
    assert.strictEqual(normalizeSkipDuplicateFiles(false), false);
    assert.strictEqual(normalizeSkipDuplicateFiles('false'), true);
});

await test('resolveSkipDuplicateFiles: projectSetting && hostOption !== false; never rejects', async () => {
    records = { svc_on: {}, svc_off: { skip_duplicate_files: false } };
    configure(undefined);
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_on'), true, 'unset project is on');
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_none'), true, 'no record is on');
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_off'), false, 'project off');
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_locked'), true, 'a failed read is the default, on');
    assert.strictEqual(await resolveSkipDuplicateFiles(''), true, 'no service is the default');
    configure(false);
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_on'), false, 'host false restricts a project that is on');
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_off'), false);
    assert.strictEqual(await resolveSkipDuplicateFiles(''), false);
    configure(true);
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_on'), true);
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_off'), false, 'host true cannot raise a project that is off');
    configure(null);
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_off'), false, 'null follows the project');
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_on'), true);
});

await test('skipDuplicateFilesEnabled (sync): the CACHED setting && option !== false', async () => {
    records = {};
    configure(undefined);
    assert.strictEqual(skipDuplicateFilesEnabled('svc_1'), true, 'cold cache answers the default');
    assert.strictEqual(skipDuplicateFilesEnabled(), true);
    setProjectSettings('svc_1', { skip_duplicate_files: false });
    assert.strictEqual(skipDuplicateFilesEnabled('svc_1'), false);
    assert.strictEqual(skipDuplicateFilesEnabled('svc_2'), true);
    configure(false);
    assert.strictEqual(skipDuplicateFilesEnabled('svc_2'), false);
    configure(true);
    setProjectSettings('svc_1', { skip_duplicate_files: false });
    assert.strictEqual(skipDuplicateFilesEnabled('svc_1'), false, 'host true cannot raise a project that is off');
});

await test('the same ceiling rule governs web access (its default is off, so the ceiling is usually the floor)', async () => {
    records = { svc_web: { web_access: true } };
    configureChatEngine({
        clientSecretRequest: async () => ({ id: 'req_1', status: 'resolved' }),
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
        webAccess: true, skipDuplicateFiles: true,
    });
    clearProjectSettings();
    configureProjectSettings(async (service) => records[service] || null);
    assert.strictEqual(await resolveWebAccess('svc_web'), true);
    assert.strictEqual(await resolveWebAccess('svc_none'), false, 'web: host true cannot raise an unset project');
    assert.strictEqual(await resolveSkipDuplicateFiles('svc_none'), true, 'duplicates: an unset project is on');
    assert.strictEqual(webAccessEnabled('svc_none'), false);
    assert.strictEqual(skipDuplicateFilesEnabled('svc_none'), true);
});

await test('the key round-trips in the record beside the others', async () => {
    records = {};
    configure(undefined);
    setProjectSettings('svc_x', { upload_access_group: 'public', chat_greeting: 'Hello', web_access: true });
    assert.strictEqual(projectSkipDuplicateFiles('svc_x'), true, 'unset reads as on');
    patchProjectSettings('svc_x', { skip_duplicate_files: false });
    assert.deepStrictEqual(cachedProjectSettings('svc_x'),
        { upload_access_group: 'public', chat_greeting: 'Hello', web_access: true, skip_duplicate_files: false });
    assert.strictEqual(projectSkipDuplicateFiles('svc_x'), false);
    patchProjectSettings('svc_x', { skip_duplicate_files: true });
    assert.strictEqual(projectSkipDuplicateFiles('svc_x'), true);
    assert.strictEqual(cachedProjectSettings('svc_x').web_access, true, 'the patch kept the other keys');
});

const failed = results.filter(r => !r[0]);
for (const [ok, name, why] of results) console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '\n      ' + why));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

})();
