/**
 * The access group the uploader chose has to reach the INDEXING AGENT.
 *
 * Uploading a file writes one record here in the browser (`src::<path>` in
 * file_summaries) and then hands the file to a background agent that writes many
 * more: one per spreadsheet row, per chapter, per extracted photo. Only the first
 * of those is written by code that knows what the uploader picked. The rest are
 * written by the model, through the MCP postRecords tool, which defaults an
 * omitted access group to "authorized".
 *
 * So if the choice does not reach the prompt, a file published as "public" ends
 * up as a public file record whose every row is "authorized": an anonymous
 * visitor can see that the file exists and read nothing out of it. Worse, the
 * strays are invisible to a re-index, because skapi's access group is part of a
 * record's table key and a query for one group does not see the others.
 *
 * These tests pin that the group appears in every indexing message shape (first
 * pass, continuation, rendered-page window) and in the system prompt, and that
 * omitting it still says "authorized", which is what every record used before the
 * setting existed.
 *
 * Run: node ./tests/indexing-access-group.cjs
 */

const assert = require('assert');
const {
    buildIndexingUserMessage,
    buildIndexingContinueMessage,
    buildIndexingWindowMessage,
    buildIndexingSystemPrompt,
    indexingAccessGroup,
} = require('../dist/engine.cjs');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

const base = {
    name: 'sheet.xlsx',
    storagePath: 'uid/folder/sheet.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 4096,
    url: 'https://example.invalid/signed',
};

const att = (accessGroup) => Object.assign({}, base, accessGroup ? { accessGroup } : {});

/* ---- the resolver ------------------------------------------------------- */

test('a recognised group is used as given', () => {
    assert.strictEqual(indexingAccessGroup({ accessGroup: 'public' }), 'public');
    assert.strictEqual(indexingAccessGroup({ accessGroup: 'private' }), 'private');
    assert.strictEqual(indexingAccessGroup({ accessGroup: 'authorized' }), 'authorized');
});

test('an absent or unrecognised group falls back to authorized', () => {
    // "authorized" is what every BunnyQuery record was hardcoded to before this
    // existed, so a caller that has not been updated keeps writing what it did.
    assert.strictEqual(indexingAccessGroup({}), 'authorized');
    assert.strictEqual(indexingAccessGroup({ accessGroup: undefined }), 'authorized');
    assert.strictEqual(indexingAccessGroup({ accessGroup: 'admin' }), 'authorized');
    assert.strictEqual(indexingAccessGroup({ accessGroup: 'nonsense' }), 'authorized');
    assert.strictEqual(indexingAccessGroup({ accessGroup: 7 }), 'authorized');
});

/* ---- every message shape carries it ------------------------------------- */

const shapes = {
    'first pass (url)': (a) => buildIndexingUserMessage(a),
    'first pass (inline content)': (a) => buildIndexingUserMessage(a, { inlineContent: 'x,y\n1,2' }),
    'first pass (server extract)': (a) => buildIndexingUserMessage(a, { inlineContentPlaceholder: '{{X}}' }),
    'first pass (paged read)': (a) => buildIndexingUserMessage(a, { pagedRead: true }),
    'continuation': (a) => buildIndexingContinueMessage(a),
    'rendered window': (a) => buildIndexingWindowMessage(a, '{{PAGES}}', false),
    'rendered window (continuation)': (a) => buildIndexingWindowMessage(a, '{{PAGES}}', true, 'page 5'),
};

for (const [label, build] of Object.entries(shapes)) {
    test(`${label}: states the chosen group`, () => {
        const msg = build(att('public'));
        assert.ok(/access group[^\n]*: public/i.test(msg),
            'no access-group line in the ' + label + ' message:\n' + msg.slice(0, 400));
    });

    test(`${label}: states authorized when none was chosen`, () => {
        const msg = build(att(null));
        assert.ok(/access group[^\n]*: authorized/i.test(msg),
            'no fallback access-group line in the ' + label + ' message');
    });

    test(`${label}: never states a group the uploader did not pick`, () => {
        const msg = build(att('private'));
        assert.ok(!/access group[^\n]*: public/i.test(msg));
        assert.ok(!/access group[^\n]*: authorized/i.test(msg));
    });
}

/* ---- the system prompt -------------------------------------------------- */

test('the system prompt carries the chosen group as a hard rule', () => {
    const sys = buildIndexingSystemPrompt({ projectId: 'abc-xyz', accessGroup: 'public' });
    assert.ok(/ACCESS GROUP \(hard rule\)/.test(sys), 'the hard rule is missing');
    assert.ok(sys.includes('access group "public"'),
        'the system prompt does not name the chosen group');
});

test('the system prompt defaults to authorized', () => {
    const sys = buildIndexingSystemPrompt({ projectId: 'abc-xyz' });
    assert.ok(sys.includes('access group "authorized"'));
    assert.ok(!sys.includes('access group "public"'));
});

test('an unrecognised group does not leak into the system prompt', () => {
    const sys = buildIndexingSystemPrompt({ projectId: 'abc-xyz', accessGroup: 'admin' });
    assert.ok(!sys.includes('access group "admin"'));
    assert.ok(sys.includes('access group "authorized"'));
});

test('the file-record instruction names the same group as the hard rule', () => {
    // Both mention it. If they disagreed, the model would create the src:: record
    // in one group and its rows in another, which is the exact split this feature
    // exists to prevent.
    const sys = buildIndexingSystemPrompt({ projectId: 'abc-xyz', accessGroup: 'private' });
    const mentions = sys.match(/access group "([a-z]+)"/g) || [];
    assert.ok(mentions.length >= 2, 'expected the group to be stated more than once');
    assert.ok(mentions.every((m) => m === 'access group "private"'),
        'the system prompt names more than one group: ' + JSON.stringify(mentions));
});

test('the extracted-media records are exempted, so their group is left alone', () => {
    // __MEDIA__ records are minted by the pipeline, not the model; telling it to
    // re-post them at another group would duplicate them.
    const sys = buildIndexingSystemPrompt({ projectId: 'abc-xyz', accessGroup: 'public' });
    assert.ok(/__MEDIA__/.test(sys));
    assert.ok(/leave their group alone/i.test(sys));
});

/* ---- report ------------------------------------------------------------- */

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
