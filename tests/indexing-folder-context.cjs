/**
 * The folders a file was uploaded into are evidence about what its data MEANS, and often
 * the only evidence there is: a grid of bare figures under "2026/Q2/royalties" is a
 * quarterly settlement, the same grid under "inspections/KCG-B507" is one aircraft. The
 * storage path was always in the metadata block, but as a single string it reads as an
 * address to hand to a tool, which is how it was used.
 *
 * The risk in adding a line to that block is not the line. It is that
 * parseIndexingRequestText reads the SAME block back to recover which file a pass is
 * about, and that recovery is what makes a history rebuild and a worker-minted pass group
 * into one indexing row. A parse that shifts leaves a file's passes scattered across rows.
 *
 * Run: node ./tests/indexing-folder-context.cjs
 */

const assert = require('assert');
const {
    buildIndexingUserMessage,
    buildIndexingContinueMessage,
    parseIndexingRequestText,
    buildIndexingSystemPrompt,
} = require('../dist/engine.cjs');

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fail++; }
};

const folderLine = (msg) => {
    const l = msg.split('\n').find((x) => x.indexOf('- folders it was filed under: ') === 0);
    return l ? l.replace('- folders it was filed under: ', '') : null;
};
const build = (storagePath, extra) => buildIndexingUserMessage(Object.assign({
    name: storagePath.split('/').filter(Boolean).pop(),
    storagePath: storagePath,
    url: 'https://example.test/signed',
}, extra || {}));

ok('the folder trail is shown, most general first', () => {
    assert.strictEqual(folderLine(build('2026/Q2/royalties/settlement.xlsx')), '2026 / Q2 / royalties');
    assert.strictEqual(folderLine(build('inspections/KCG-B507/E&I report.xls')), 'inspections / KCG-B507');
});

ok('a file at the root shows no line at all, rather than an empty one', () => {
    assert.strictEqual(folderLine(build('A_broadway (30).xlsx')), null);
});

ok('leading, trailing and doubled separators do not produce empty segments', () => {
    assert.strictEqual(folderLine(build('/leading/slash/file.csv')), 'leading / slash');
    assert.strictEqual(folderLine(build('trailing//double//sep/f.txt')), 'trailing / double / sep');
});

ok('a folder named only by an id or a date is kept, not filtered', () => {
    // Deciding which folder names carry meaning is the model's job. "KCG-B507" and "2026"
    // look like noise to a filter and are exactly the tags worth having.
    assert.strictEqual(folderLine(build('2026/KCG-B507/log.xlsx')), '2026 / KCG-B507');
});

ok('unicode and spaces in folder names survive intact', () => {
    assert.strictEqual(folderLine(build('브로드웨이/2026 Q2/정산.xlsx')), '브로드웨이 / 2026 Q2');
});

ok('THE PARSE STILL RECOVERS THE FILE from the new block', () => {
    const msg = build('2026/Q2/royalties/settlement.xlsx', {
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 49108,
        accessGroup: 'authorized',
    });
    const ref = parseIndexingRequestText(msg);
    assert.ok(ref, 'the indexing prompt no longer parses as an indexing prompt');
    assert.strictEqual(ref.name, 'settlement.xlsx');
    assert.strictEqual(ref.path, '2026/Q2/royalties/settlement.xlsx');
    assert.strictEqual(ref.size, 49108);
    assert.strictEqual(ref.continued, false);
});

ok('the new line cannot be mistaken for the storage path', () => {
    // Both start "- " and both contain slashes. A parse that matched loosely would take
    // "2026 / Q2 / royalties" as the path and every record would reference a file that
    // does not exist.
    const ref = parseIndexingRequestText(build('2026/Q2/royalties/settlement.xlsx'));
    assert.strictEqual(ref.path, '2026/Q2/royalties/settlement.xlsx');
    assert.ok(ref.path.indexOf(' / ') === -1, 'the folder line was parsed as the path');
});

ok('a CONTINUE pass carries the same context and still parses', () => {
    const msg = buildIndexingContinueMessage(
        { name: 'settlement.xlsx', storagePath: '2026/Q2/royalties/settlement.xlsx', url: 'https://x' },
        {}
    );
    const ref = parseIndexingRequestText(msg);
    assert.ok(ref, 'a continue pass no longer parses');
    assert.strictEqual(ref.path, '2026/Q2/royalties/settlement.xlsx');
    assert.strictEqual(ref.continued, true, 'a continue pass must still be recognised as one');
    assert.strictEqual(folderLine(msg), '2026 / Q2 / royalties');
});

ok('the system prompt tells the model the path is context and NOT a substitute for reading', () => {
    const sys = buildIndexingSystemPrompt({ projectId: 'p', accessGroup: 'authorized' });
    assert.ok(/EVIDENCE ABOUT WHAT THE DATA MEANS/i.test(sys), 'the folder-context rule is missing');
    assert.ok(/NEVER INSTEAD OF READING/i.test(sys), 'the guard against inferring from names is missing');
    // The pre-existing rule this sits beside must survive: a table named after a folder
    // scatters one record kind across as many tables as the user has folders.
    assert.ok(/FIXED TABLE NAMES/.test(sys), 'the fixed-table-names rule was displaced');
    assert.ok(/never derive a TABLE name from a folder or a file name/i.test(sys),
        'the new rule must explicitly exclude table names');
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
