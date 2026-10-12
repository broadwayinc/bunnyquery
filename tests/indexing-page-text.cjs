/**
 * Verbatim page text for SCANNED pages (reliability plan 3.1, owner's yes 2026-10-12).
 *
 * The worker writes a `__PAGES__` record per page. A page WITH a text layer is written
 * server-side before the model call. A page WITHOUT one can only come from the model:
 * the worker's `_fill_vision_pages` reads the records the model posted and fills a page
 * from an item whose data names it (`page`) and carries `page_text`. Until now the
 * render prompt asked for neither, so every scanned page stayed without page text.
 *
 * The model's signal is the label the worker puts before each image: the block
 * "Embedded text layer for this page" appears exactly when the page has one. So the
 * rule is "no such block, one page_text record", and the pages that HAVE a text layer
 * must get none (their text is already stored).
 *
 * What this pins:
 *   - the first render pass and the CONTINUE template both carry the rule;
 *   - the rule names the fields the worker reads (`page`, `page_text`), the fixed
 *     table, the "Embedded text layer" signal, verbatim/complete/reading order, and
 *     that text-layer pages are excluded;
 *   - the rule is short (the owner pays output tokens for the transcription, not for
 *     the instruction) and appears once per message;
 *   - the other indexing messages (inline, extracted, paged, windowed, continue) do
 *     NOT carry it: it is a rendered-page rule.
 *
 * Run: node ./tests/indexing-page-text.cjs
 */

const assert = require('assert');
const {
    buildIndexingRenderMessage,
    buildIndexingRenderContinueTemplate,
    buildIndexingUserMessage,
    buildIndexingWindowMessage,
    buildIndexingContinueMessage,
    PAGE_TEXT_TABLE,
    RENDER_FROM_TOKEN,
} = require('../dist/engine.cjs');

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fail++; }
};

const att = { name: 'scan.pdf', storagePath: 'u1/scan.pdf', mime: 'application/pdf', url: 'https://x.test/s', accessGroup: 'authorized' };
const PH = '{{SKAPI_RENDER::scan_pdf-1}}';
const first = buildIndexingRenderMessage(att, PH, 0);
const cont = buildIndexingRenderContinueTemplate(att, PH);
const rule = (msg) => {
    const i = msg.indexOf('PAGE TEXT for pages WITHOUT a text layer:');
    return i === -1 ? null : msg.slice(i, msg.indexOf('\n\n', i));
};

ok('the first render pass carries the page-text rule, once', () => {
    assert.ok(rule(first), 'rule missing');
    assert.strictEqual(first.split('PAGE TEXT for pages WITHOUT a text layer:').length - 1, 1);
});

ok('the CONTINUE template (what the worker builds later windows from) carries the same rule', () => {
    assert.ok(rule(cont));
    assert.strictEqual(rule(cont), rule(first));
    assert.ok(cont.indexOf(RENDER_FROM_TOKEN) !== -1, 'still a template');
});

ok('the rule names the fields the worker reads: a 1-based `page` and `page_text`', () => {
    const r = rule(first);
    assert.ok(/"page": <its document page number from the label, 1-based>/.test(r));
    assert.ok(/"page_text": "<the page's complete text/.test(r));
});

ok('the rule keys off the worker\'s label: no "Embedded text layer" block means no text layer', () => {
    const r = rule(first);
    assert.ok(/carries NO "Embedded text layer" block/.test(r));
    // The label block the worker emits is quoted by that exact name.
    assert.ok(/Embedded text layer/.test(r));
    // Strips of one page show the text layer on the first strip only, so the rule says which label.
    assert.ok(/its first label, when the page is split into strips/.test(r));
});

ok('the rule asks for the complete text, verbatim, in reading order, nothing summarised', () => {
    const r = rule(first);
    assert.ok(/complete text exactly as printed, verbatim, in reading order, nothing summarised or left out/.test(r));
    assert.ok(/exactly ONE record/.test(r));
});

ok('text-layer pages are excluded: their text is already stored', () => {
    const r = rule(first);
    assert.ok(/A page WITH an embedded text layer gets NO such record: its text is already stored\./.test(r));
});

ok('the record is a real record of the file: fixed table, reference to the src:: record, in ADDITION to the rows', () => {
    const r = rule(first);
    assert.strictEqual(PAGE_TEXT_TABLE, 'page_texts');
    assert.ok(r.indexOf('in table "' + PAGE_TEXT_TABLE + '"') !== -1);
    assert.ok(/reference "src::" \+ the storage path above/.test(r));
    assert.ok(/in addition to the records above/.test(r));
});

ok('the rule is short: under 700 characters, so the owner pays for the transcription and not the instruction', () => {
    assert.ok(rule(first).length < 700, String(rule(first).length));
});

ok('the rule sits with the text-layer guidance and before the stop-after-this-window paragraph', () => {
    const i = first.indexOf('Where a page carries an embedded text layer it is quoted above');
    const j = first.indexOf('PAGE TEXT for pages WITHOUT a text layer:');
    const k = first.indexOf('Save records for THIS window of pages only');
    assert.ok(i !== -1 && j !== -1 && k !== -1);
    assert.ok(i < j && j < k);
});

ok('the first pass still leads with the line the clients parse into the "Indexing:" bubble', () => {
    assert.ok(first.indexOf('A new file has just been uploaded. Index it now.') === 0);
    assert.ok(/^- name: scan\.pdf$/m.test(first));
});

ok('the other indexing messages do NOT carry the rule: it is a rendered-page rule', () => {
    const base = { name: 'a.docx', storagePath: 'u1/a.docx', url: 'https://x.test/a' };
    assert.strictEqual(rule(buildIndexingUserMessage(base)), null, 'url message');
    assert.strictEqual(rule(buildIndexingUserMessage(base, { inlineContent: 'hello' })), null, 'inline');
    assert.strictEqual(rule(buildIndexingUserMessage(base, { inlineContentPlaceholder: '{{X}}' })), null, 'extracted');
    assert.strictEqual(rule(buildIndexingUserMessage(base, { pagedRead: true })), null, 'paged');
    assert.strictEqual(rule(buildIndexingWindowMessage(base, '{{W}}', false)), null, 'window');
    assert.strictEqual(rule(buildIndexingWindowMessage(base, '{{W}}', true)), null, 'window continue');
    assert.strictEqual(rule(buildIndexingContinueMessage(base)), null, 'resume');
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
