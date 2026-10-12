/**
 * Citations and the no-source mark (reliability plan 3.5).
 *
 * The retrieval note already says what a turn read; this pins how that note
 * becomes the chips and the mark both clients draw under an answer:
 *   - citationsFor: deduplicated, hits first (by file, pages ascending), then
 *     page-less files; the label is the file name plus " p.N"; urls skipped;
 *   - answerUsedNoDataTool: true only for a note with no data tool and no web
 *     tool; a null note is unknown, never "no source";
 *   - retrievalNoteOfAnswer: the one gate on which bubbles qualify;
 *   - citationLinkPart: the same placeholder href and remotePath an inline
 *     stored-file chip gets, the view's cached url when it has one, no image,
 *     and a truncated label that keeps its page suffix;
 *   - the chip renders through renderInlineLinkHtml exactly like an inline
 *     stored-file link (data-bq-expired, data-bq-remote-path), so the clients'
 *     existing delegated click handlers mint the url;
 *   - both clients draw the mark from the engine's constant.
 *
 * Run: node ./tests/citations.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    citationsFor,
    citationFileName,
    answerUsedNoDataTool,
    isDataToolName,
    retrievalNoteOfAnswer,
    citationLinkPart,
    renderInlineLinkHtml,
    extractRetrievalNote,
    DATA_TOOL_NAMES,
    NO_DATA_TOOL_MARK,
    EXPIRED_ATTACHMENT_URL_ORIGIN,
    LINK_LABEL_MAX_DISPLAY_CHARS,
} = require('../dist/engine.cjs');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

const note = (over) => Object.assign({
    files: [], tables: [], accessGroups: [], hits: [], tools: [], web: false, source: 'tools',
}, over || {});

test('citationFileName takes the last non-empty segment', () => {
    assert.strictEqual(citationFileName('reports/2026/q1.pdf'), 'q1.pdf');
    assert.strictEqual(citationFileName('q1.pdf'), 'q1.pdf');
    assert.strictEqual(citationFileName('folder/'), 'folder');
    assert.strictEqual(citationFileName(''), '');
});

test('citationsFor: null and empty notes give no citations', () => {
    assert.deepStrictEqual(citationsFor(null), []);
    assert.deepStrictEqual(citationsFor(undefined), []);
    assert.deepStrictEqual(citationsFor(note()), []);
    assert.deepStrictEqual(citationsFor({ not: 'a note' }), []);
});

test('citationsFor: hits first by file then page, then page-less files, deduplicated', () => {
    const c = citationsFor(note({
        files: ['b.pdf', 'docs/a.pdf', 'c.xlsx', 'b.pdf'],
        hits: [
            { path: 'docs/a.pdf', page: 3 },
            { path: 'b.pdf', page: 1 },
            { path: 'docs/a.pdf', page: 1 },
            { path: 'docs/a.pdf', page: 3 },
        ],
    }));
    assert.deepStrictEqual(c, [
        { path: 'docs/a.pdf', page: 1, label: 'a.pdf p.1' },
        { path: 'docs/a.pdf', page: 3, label: 'a.pdf p.3' },
        { path: 'b.pdf', page: 1, label: 'b.pdf p.1' },
        { path: 'c.xlsx', label: 'c.xlsx' },
    ]);
});

test('citationsFor: a url in files or hits is not a chip (nothing of ours to mint)', () => {
    const c = citationsFor(note({
        files: ['https://example.com/x.pdf', 'http://example.com/y', 'ours/z.pdf'],
        hits: [{ path: 'https://example.com/x.pdf', page: 2 }],
    }));
    assert.deepStrictEqual(c, [{ path: 'ours/z.pdf', label: 'z.pdf' }]);
});

test('citationsFor: a hit with a bad page is dropped, a string page is read', () => {
    const c = citationsFor(note({ hits: [{ path: 'a.pdf', page: 0 }, { path: 'a.pdf', page: '2' }, { path: 'a.pdf', page: NaN }] }));
    assert.deepStrictEqual(c, [{ path: 'a.pdf', page: 2, label: 'a.pdf p.2' }]);
});

test('citationsFor: the note from a real Claude body cites the searched file by page', () => {
    const body = {
        content: [
            { type: 'mcp_tool_use', id: 't1', name: 'searchText', input: { path: 'contracts/msa.pdf', query: 'termination' } },
            { type: 'mcp_tool_result', tool_use_id: 't1', content: [{ type: 'text', text: JSON.stringify({ list: [{ path: 'contracts/msa.pdf', page: 7, excerpt: '...' }] }) }] },
            { type: 'text', text: 'Clause 12 on page 7.' },
        ],
    };
    const n = extractRetrievalNote(body, 'Clause 12 on page 7.');
    assert.deepStrictEqual(citationsFor(n), [{ path: 'contracts/msa.pdf', page: 7, label: 'msa.pdf p.7' }]);
    assert.strictEqual(answerUsedNoDataTool(n), false);
});

test('DATA_TOOL_NAMES is the agreed list', () => {
    assert.deepStrictEqual(DATA_TOOL_NAMES.slice().sort(), [
        'getFileOutline', 'getIndexes', 'getRecords', 'getTables', 'getTags', 'getUniqueId', 'queryGrid', 'readFileContent', 'searchText',
    ]);
    assert.ok(isDataToolName('getRecords'));
    assert.ok(!isDataToolName('postRecords'));
});

test('answerUsedNoDataTool: null is unknown (false); data tool or web is false; other tools only is true', () => {
    assert.strictEqual(answerUsedNoDataTool(null), false);
    assert.strictEqual(answerUsedNoDataTool(undefined), false);
    assert.strictEqual(answerUsedNoDataTool(note({ tools: ['getRecords'] })), false);
    assert.strictEqual(answerUsedNoDataTool(note({ tools: ['postRecords', 'queryGrid'] })), false);
    assert.strictEqual(answerUsedNoDataTool(note({ tools: ['web_search'], web: true })), false);
    assert.strictEqual(answerUsedNoDataTool(note({ tools: ['postRecords'] })), true);
    assert.strictEqual(answerUsedNoDataTool(note({ tools: ['updateRecords', 'getProfile'] })), true);
    // The fallback note read off the answer's own links: the body had no tool
    // blocks, so nothing was read.
    assert.strictEqual(answerUsedNoDataTool(note({ files: ['a.pdf'], source: 'answer' })), true);
});

test('retrievalNoteOfAnswer gates on a settled assistant chat answer', () => {
    const n = note({ tools: ['getRecords'] });
    assert.strictEqual(retrievalNoteOfAnswer({ role: 'assistant', content: 'x', _retrieval: n }), n);
    assert.strictEqual(retrievalNoteOfAnswer({ role: 'user', content: 'x', _retrieval: n }), null);
    assert.strictEqual(retrievalNoteOfAnswer({ role: 'assistant', content: 'x' }), null);
    assert.strictEqual(retrievalNoteOfAnswer({ role: 'assistant', content: 'x', _retrieval: n, isError: true }), null);
    assert.strictEqual(retrievalNoteOfAnswer({ role: 'assistant', content: '', _retrieval: n, isPending: true }), null);
    assert.strictEqual(retrievalNoteOfAnswer({ role: 'assistant', content: 'x', _retrieval: n, isBackgroundTask: true }), null);
    assert.strictEqual(retrievalNoteOfAnswer({ role: 'assistant', content: '', _retrieval: n, _streamPending: true }), null);
    assert.strictEqual(retrievalNoteOfAnswer(null), null);
});

test('citationLinkPart: the stored-file placeholder, remotePath, no image; cached url when the view has one', () => {
    const c = { path: 'docs/a b.pdf', page: 3, label: 'a b.pdf p.3' };
    const part = citationLinkPart(c);
    assert.strictEqual(part.type, 'link');
    assert.strictEqual(part.expiredHref, EXPIRED_ATTACHMENT_URL_ORIGIN + '/docs/a%20b.pdf');
    assert.strictEqual(part.href, part.expiredHref);
    assert.strictEqual(part.expired, true);
    assert.strictEqual(part.remotePath, 'docs/a b.pdf');
    assert.strictEqual(part.label, 'a b.pdf p.3');
    assert.strictEqual(part.fullLabel, 'a b.pdf p.3');
    assert.strictEqual('image' in part, false);

    const fresh = citationLinkPart(c, (h) => h === part.expiredHref ? 'https://cdn.example/fresh' : undefined);
    assert.strictEqual(fresh.href, 'https://cdn.example/fresh');
    assert.strictEqual(fresh.expired, false);
});

test('citationLinkPart: a long file name is truncated from the front and keeps its page suffix', () => {
    const name = 'a-very-long-file-name-that-does-not-fit-in-a-chip-at-all.pdf';
    const part = citationLinkPart({ path: 'x/' + name, page: 12, label: name + ' p.12' });
    assert.ok(part.label.length <= LINK_LABEL_MAX_DISPLAY_CHARS);
    assert.ok(/ p\.12$/.test(part.label), part.label);
    assert.strictEqual(part.label[0], '…');
});

test('a citation chip renders as an inline stored-file chip: data-bq-link, data-bq-expired, data-bq-remote-path, no preview', () => {
    const html = renderInlineLinkHtml(citationLinkPart({ path: 'docs/a.png', page: 2, label: 'a.png p.2' }), { allowImagePreview: true });
    assert.ok(/class="bq-link-button is-expired"/.test(html), html);
    assert.ok(/data-bq-link="1"/.test(html));
    assert.ok(/data-bq-expired="1"/.test(html));
    assert.ok(/data-bq-remote-path="docs\/a\.png"/.test(html));
    assert.ok(/href="https:\/\/_expired_\.url\/docs\/a\.png"/.test(html));
    assert.ok(html.indexOf('<img') === -1, 'no preview under the answer');
    assert.ok(html.indexOf('a.png p.2') !== -1);
});

test('the mark text is the engine constant and has no em dash', () => {
    assert.strictEqual(NO_DATA_TOOL_MARK, 'No project data was read for this answer');
    assert.ok(NO_DATA_TOOL_MARK.indexOf('—') === -1);
});

// The two clients: both must take the chips and the mark from the engine, never
// word or gate them locally. agent.vue lives in a sibling checkout; skipped, not
// failed, when it is not on disk (the engine package is tested on its own too).
const WIDGET = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'index.js'), 'utf8');
const CSS = fs.readFileSync(path.resolve(__dirname, '..', 'styles', 'chat.css'), 'utf8');
const SITE_DIRS = ['bunnyquery.com', 'www.bunnyquery.com'].map((d) => path.resolve(__dirname, '..', '..', d));
const AGENT_VUE = SITE_DIRS.map((d) => path.join(d, 'src', 'views', 'service', 'agent.vue')).find((f) => fs.existsSync(f));

test('widget draws the chips and the mark from the engine helpers', () => {
    for (const sym of ['citationsFor', 'answerUsedNoDataTool', 'retrievalNoteOfAnswer', 'citationLinkPart', 'NO_DATA_TOOL_MARK']) {
        assert.ok(WIDGET.indexOf(sym) !== -1, 'widget uses ' + sym);
    }
    assert.ok(WIDGET.indexOf('class: "bq-citations"') !== -1, 'widget emits .bq-citations');
    assert.ok(WIDGET.indexOf('class: "bq-no-source-note"') !== -1, 'widget emits .bq-no-source-note');
    assert.ok(WIDGET.indexOf('No project data was read') === -1, 'widget never words the mark itself');
});

test('shared chat.css styles the citation row and the mark', () => {
    assert.ok(/\.bq-citations\s*\{/.test(CSS));
    assert.ok(/\.bq-no-source-note\s*\{/.test(CSS));
});

if (AGENT_VUE) {
    const VUE = fs.readFileSync(AGENT_VUE, 'utf8');
    test('agent.vue draws the chips and the mark from the engine helpers and re-derives the note on load', () => {
        assert.ok(VUE.indexOf('.bq-citations(') !== -1, 'agent.vue emits .bq-citations');
        assert.ok(VUE.indexOf('span.bq-no-source-note(') !== -1, 'agent.vue emits .bq-no-source-note');
        assert.ok(VUE.indexOf('NO_DATA_TOOL_MARK') !== -1, 'agent.vue uses the engine constant');
        assert.ok(VUE.indexOf('No project data was read') === -1, 'agent.vue never words the mark itself');
        assert.ok(VUE.indexOf('extractRetrievalNote(response, assistantText)') !== -1, 'agent.vue history mapper re-derives _retrieval');
    });
} else {
    results.push([true, 'agent.vue parity (SKIPPED: site checkout not on disk)']);
}

const failed = results.filter(r => !r[0]);
for (const [ok, name, why] of results) console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '\n      ' + why));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
