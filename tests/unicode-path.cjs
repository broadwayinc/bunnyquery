/**
 * A storage key is matched byte-for-byte, but one filename reaches this engine in two
 * different Unicode forms. macOS hands the browser a DECOMPOSED (NFD) name; most other
 * producers compose it (NFC). The Korean name 운전면허-김대현.jpg is 24 codepoints in NFD
 * and 12 in NFC, so the two spellings are different strings for every purpose that
 * matters here: the storage lookup, and the map that marks a chip "(unavailable)".
 *
 * Observed failure: a src:: record stored NFD, an image preview chip that went grey with
 * "✕ (unavailable)" even though the file was present and getRecords returned it fine.
 *
 * Run: node ./tests/unicode-path.cjs
 */

const assert = require('assert');
const {
    canonicalizePathForm,
    linkUnavailableKeyForPath,
    linkUnavailableKeysForPath,
} = require('../dist/engine.cjs');

// The real filename from the incident, written both ways.
const NFD = '운전면허-김대현.jpg'.normalize('NFD');
const NFC = '운전면허-김대현.jpg'.normalize('NFC');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

test('the two spellings really are different strings (premise of the bug)', () => {
    assert.notStrictEqual(NFD, NFC);
    assert.strictEqual(NFD.length, 24);
    assert.strictEqual(NFC.length, 12);
});

test('canonicalizePathForm folds both spellings to one', () => {
    assert.strictEqual(canonicalizePathForm(NFD), canonicalizePathForm(NFC));
    assert.strictEqual(canonicalizePathForm(NFD), NFC);
});

test('the unavailable-map key is the SAME for both spellings', () => {
    assert.strictEqual(linkUnavailableKeyForPath(NFD), linkUnavailableKeyForPath(NFC));
});

test('a successful load under one form clears a mark left under the other', () => {
    // markLinkUnavailable stores by key; clearLinkUnavailable deletes by key.
    const marked = {};
    marked[linkUnavailableKeyForPath(NFD)] = true;          // mint failed, NFD spelling
    const clearKey = linkUnavailableKeyForPath(NFC);        // image loaded, NFC spelling
    assert.ok(marked[clearKey], 'the clear would have missed the mark');
});

test('paths with directories and spaces still fold correctly', () => {
    const p = '02 수신문서/2007/10월/사본 - AV07-591.jpg';
    assert.strictEqual(canonicalizePathForm(p.normalize('NFD')), canonicalizePathForm(p.normalize('NFC')));
    assert.strictEqual(linkUnavailableKeyForPath(p.normalize('NFD')), linkUnavailableKeyForPath(p.normalize('NFC')));
});

test('both keys a file can be marked under fold together', () => {
    const a = linkUnavailableKeysForPath(NFD);
    const b = linkUnavailableKeysForPath(NFC);
    assert.deepStrictEqual(a, b, 'path key and href key must both be form-independent');
});

test('empty and nullish input is handled without throwing', () => {
    assert.strictEqual(canonicalizePathForm(''), '');
    assert.strictEqual(linkUnavailableKeyForPath(''), 'path:');
});

let pass = 0;
for (const [ok, name, msg] of results) {
    console.log(ok ? `ok    ${name}` : `FAIL  ${name}\n        ${msg}`);
    if (ok) pass++;
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
