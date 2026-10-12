/**
 * Retrieval memory (reliability plan 3.6).
 *
 * History keeps no tool results, so on a follow-up the model started discovery
 * from nothing and routinely landed on a different file, table or group than the
 * turn before, which is how an answer flips. Each assistant turn now carries a
 * compact note of what it RETRIEVED, read off the provider body's tool blocks
 * (Anthropic mcp_tool_use / mcp_tool_result, OpenAI mcp_call) or, failing that,
 * off the file links in its answer, and buildBoundedChatMessages carries the
 * newest few notes into the request.
 *
 * What this pins:
 *   - the note's SHAPE, from both providers' bodies: files, tables, access
 *     groups, searchText hits as path + page, tool names, web use;
 *   - what it must NOT carry: filter values, record data, a result's text;
 *   - the fallback to the answer's own file links, and null when there is
 *     nothing (never an invented note);
 *   - the BOUND: at most RETRIEVAL_NOTES_MAX notes and RETRIEVAL_NOTES_TOKEN_BUDGET
 *     tokens per request, newest first, never on the turn being sent;
 *   - a history without notes builds the same request it always did;
 *   - the history mapper re-derives the note from the stored body on load.
 *
 * Run: node ./tests/retrieval-memory.cjs
 */

const assert = require('assert');
const {
    extractRetrievalNote,
    retrievalNoteFromText,
    formatRetrievalNote,
    isRetrievalNote,
    applyRetrievalNotes,
    buildBoundedChatMessages,
    estimateTextTokens,
    mapHistoryListToMessages,
    RETRIEVAL_NOTES_MAX,
    RETRIEVAL_NOTES_TOKEN_BUDGET,
    RETRIEVAL_NOTE_MAX_ITEMS,
    RETRIEVAL_NOTE_MAX_CHARS,
    RETRIEVAL_NOTE_PREFIX,
} = require('../dist/engine.cjs');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

/* ---- bodies as the providers return them ------------------------------------------- */

const claudeBody = {
    type: 'message', role: 'assistant',
    content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'mcp_tool_use', id: 't1', name: 'getUniqueId', server_name: 'BunnyQuery', input: { unique_id: 'src::', condition: 'gte' } },
        { type: 'mcp_tool_result', tool_use_id: 't1', is_error: false, content: [{ type: 'text', text: '{"list":[{"unique_id":"src::uid/report.pdf"}]}' }] },
        { type: 'mcp_tool_use', id: 't2', name: 'getRecords', server_name: 'BunnyQuery', input: { table_name: 'contracts', access_group: 'authorized', reference: 'src::uid/report.pdf', index: { name: 'party', value: 'SECRETCO' } } },
        // A getRecords result that happens to carry path+page shaped data is NOT a hit.
        { type: 'mcp_tool_result', tool_use_id: 't2', is_error: false, content: [{ type: 'text', text: '{"list":[{"data":{"path":"uid/other.pdf","page":99,"text":"CONFIDENTIAL BODY"}}]}' }] },
        { type: 'mcp_tool_use', id: 't3', name: 'searchText', server_name: 'BunnyQuery', input: { path: 'uid/report.pdf', query: 'termination' } },
        { type: 'mcp_tool_result', tool_use_id: 't3', is_error: false, content: [{ type: 'text', text: JSON.stringify({ results: [{ path: 'uid/report.pdf', page: 3, excerpt: 'EXCERPT TEXT', hits: 2 }, { path: 'uid/report.pdf', page: 7, excerpt: 'MORE', hits: 1 }] }) }] },
        { type: 'text', text: 'Section 12 says ... ([report.pdf](db:uid/report.pdf), page 3).' },
    ],
    stop_reason: 'end_turn',
};

const openaiBody = {
    object: 'response', status: 'completed',
    output: [
        { type: 'mcp_call', name: 'getTables', arguments: '{}', output: '{"list":[{"table":"sheets"}]}' },
        { type: 'mcp_call', name: 'queryGrid', arguments: JSON.stringify({ path: 'uid/sheet.xlsx', op: 'describe' }), output: '{}' },
        { type: 'mcp_call', name: 'getRecords', arguments: JSON.stringify({ table: { name: 'rows', access_group: 1 }, filter: { value: 'SECRETVALUE' } }), output: '{"list":[]}' },
        { type: 'mcp_call', name: 'searchText', arguments: JSON.stringify({ path: 'uid/a.pdf', query: 'x' }), output: JSON.stringify([{ path: 'uid/a.pdf', page: 12, hits: 2 }]) },
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', content: [{ type: 'output_text', text: 'Found it.' }] },
    ],
};

/* ---- the note's shape ------------------------------------------------------------ */

test('Claude body: files, table, group, searchText hits and tool names, in order', () => {
    const n = extractRetrievalNote(claudeBody, 'Section 12 says ... ([report.pdf](db:uid/report.pdf), page 3).');
    assert.ok(isRetrievalNote(n));
    assert.strictEqual(n.source, 'tools');
    assert.deepStrictEqual(n.files, ['uid/report.pdf'], 'the bare "src::" prefix query names no file; the reference and the link are the same file once');
    assert.deepStrictEqual(n.tables, ['contracts']);
    assert.deepStrictEqual(n.accessGroups, ['authorized']);
    assert.deepStrictEqual(n.hits, [{ path: 'uid/report.pdf', page: 3 }, { path: 'uid/report.pdf', page: 7 }]);
    assert.deepStrictEqual(n.tools, ['getUniqueId', 'getRecords', 'searchText']);
    assert.strictEqual(n.web, false);
});

test('OpenAI body: arguments are a JSON string, table may be an object, web_search_call marks web use', () => {
    const n = extractRetrievalNote(openaiBody, 'Found it.');
    assert.strictEqual(n.source, 'tools');
    assert.deepStrictEqual(n.files, ['uid/sheet.xlsx', 'uid/a.pdf']);
    assert.deepStrictEqual(n.tables, ['rows']);
    assert.deepStrictEqual(n.accessGroups, ['1']);
    assert.deepStrictEqual(n.hits, [{ path: 'uid/a.pdf', page: 12 }]);
    assert.deepStrictEqual(n.tools, ['getTables', 'queryGrid', 'getRecords', 'searchText', 'web_search_call']);
    assert.strictEqual(n.web, true);
});

test('Claude web use: server_tool_use web_fetch and its result block both mark it', () => {
    const a = extractRetrievalNote({ content: [{ type: 'server_tool_use', id: 's1', name: 'web_fetch', input: { url: 'https://x' } }, { type: 'text', text: 'ok' }] }, 'ok');
    assert.strictEqual(a.web, true);
    const b = extractRetrievalNote({ content: [{ type: 'web_fetch_tool_result', tool_use_id: 's1', content: {} }, { type: 'text', text: 'ok' }] }, 'ok');
    assert.strictEqual(b.web, true);
});

test('what the note must NOT carry: filter values, record data, a result\'s text', () => {
    const line = formatRetrievalNote(extractRetrievalNote(claudeBody, ''));
    assert.ok(!/SECRETCO/.test(line), 'an index filter value leaked');
    assert.ok(!/CONFIDENTIAL BODY/.test(line), 'record data leaked');
    assert.ok(!/EXCERPT TEXT/.test(line), 'a searchText excerpt leaked');
    assert.ok(!/uid\/other\.pdf/.test(line), 'a path inside a getRecords result was taken as a hit');
    const line2 = formatRetrievalNote(extractRetrievalNote(openaiBody, ''));
    assert.ok(!/SECRETVALUE/.test(line2));
});

test('a failed searchText result is not read for hits', () => {
    const n = extractRetrievalNote({ content: [
        { type: 'mcp_tool_use', id: 't', name: 'searchText', input: { path: 'uid/a.pdf', query: 'x' } },
        { type: 'mcp_tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: '[{"path":"uid/a.pdf","page":4}]' }] },
    ] }, '');
    assert.deepStrictEqual(n.hits, []);
    assert.deepStrictEqual(n.files, ['uid/a.pdf']);
});

/* ---- the fallback, and null ---------------------------------------------------------- */

test('no tool blocks: the note comes from the answer\'s db: links and src:: ids, source "answer"', () => {
    const text = 'See [report](db:uid/report.pdf "title") and the record src::uid/notes.docx. Also [img](db:uid/__MEDIA__/x.png).';
    const n = extractRetrievalNote({ content: [{ type: 'text', text }] }, text);
    assert.strictEqual(n.source, 'answer');
    // db: links first, then src:: ids; the trailing full stop after the id is prose.
    assert.deepStrictEqual(n.files, ['uid/report.pdf', 'uid/__MEDIA__/x.png', 'uid/notes.docx']);
    assert.deepStrictEqual(n.tools, []);
    assert.deepStrictEqual(retrievalNoteFromText(text).files, n.files);
});

test('a read provider body with no tool use is an EMPTY note (the no-data mark needs it), not null', () => {
    const empty = extractRetrievalNote({ content: [{ type: 'text', text: 'Hello!' }] }, 'Hello!');
    assert.ok(empty && empty.source === 'body', 'a note exists for a body that was read');
    assert.deepStrictEqual([empty.files, empty.tables, empty.hits, empty.tools, empty.web], [[], [], [], [], false]);
    assert.strictEqual(formatRetrievalNote(empty), '', 'an empty note costs the history nothing');
    const openai = extractRetrievalNote({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }] }, 'Hi');
    assert.ok(openai && openai.tools.length === 0 && openai.source === 'body');
});

test('nothing to note is null, never an invented note', () => {
    assert.strictEqual(extractRetrievalNote(null, ''), null);
    assert.strictEqual(extractRetrievalNote(undefined, undefined), null);
    assert.strictEqual(extractRetrievalNote({ status: 'resolved' }, ''), null);
    assert.strictEqual(retrievalNoteFromText(''), null);
    assert.strictEqual(formatRetrievalNote(null), '');
});

test('a tool body with links in the answer merges the linked files in', () => {
    const n = extractRetrievalNote({ content: [
        { type: 'mcp_tool_use', id: 't', name: 'getTables', input: {} },
        { type: 'text', text: 'Open [a](db:uid/a.pdf).' },
    ] }, 'Open [a](db:uid/a.pdf).');
    assert.strictEqual(n.source, 'tools');
    assert.deepStrictEqual(n.files, ['uid/a.pdf']);
    assert.deepStrictEqual(n.tools, ['getTables']);
});

/* ---- caps and the formatted line ------------------------------------------------------- */

test('each list is capped at RETRIEVAL_NOTE_MAX_ITEMS and the line at RETRIEVAL_NOTE_MAX_CHARS', () => {
    const content = [];
    for (let i = 0; i < 30; i++) {
        content.push({ type: 'mcp_tool_use', id: 't' + i, name: 'tool' + i, input: { path: 'uid/a-very-long-folder-name/file-' + i + '.pdf', table_name: 'table_' + i, access_group: 'g' + i } });
        content.push({ type: 'mcp_tool_result', tool_use_id: 't' + i, content: [{ type: 'text', text: '{}' }] });
    }
    content.push({ type: 'mcp_tool_use', id: 's', name: 'searchText', input: { path: 'uid/x.pdf', query: 'q' } });
    const hits = [];
    for (let p = 1; p <= 30; p++) hits.push({ path: 'uid/x.pdf', page: p });
    content.push({ type: 'mcp_tool_result', tool_use_id: 's', content: [{ type: 'text', text: JSON.stringify(hits) }] });
    const n = extractRetrievalNote({ content }, '');
    assert.strictEqual(n.files.length, RETRIEVAL_NOTE_MAX_ITEMS);
    assert.strictEqual(n.tables.length, RETRIEVAL_NOTE_MAX_ITEMS);
    assert.strictEqual(n.accessGroups.length, RETRIEVAL_NOTE_MAX_ITEMS);
    assert.strictEqual(n.hits.length, RETRIEVAL_NOTE_MAX_ITEMS);
    assert.strictEqual(n.tools.length, RETRIEVAL_NOTE_MAX_ITEMS);
    const line = formatRetrievalNote(n);
    assert.ok(line.length <= RETRIEVAL_NOTE_MAX_CHARS, 'line is ' + line.length);
    assert.ok(line.endsWith(']'));
});

test('the formatted line: opens with the prefix, groups hits per file, names the sections, no em dash', () => {
    const line = formatRetrievalNote(extractRetrievalNote(claudeBody, ''));
    assert.ok(line.startsWith(RETRIEVAL_NOTE_PREFIX), line);
    assert.ok(/files uid\/report\.pdf/.test(line));
    assert.ok(/tables contracts/.test(line));
    assert.ok(/access_group authorized/.test(line));
    assert.ok(/searchText hits uid\/report\.pdf p3, p7/.test(line));
    assert.ok(/tools getUniqueId, getRecords, searchText/.test(line));
    assert.ok(!/web tool used/.test(line));
    assert.ok(/web tool used/.test(formatRetrievalNote(extractRetrievalNote(openaiBody, ''))));
    assert.ok(line.indexOf(String.fromCharCode(0x2014)) === -1);
    assert.ok(line.endsWith(']'));
});

/* ---- the bound in the bounded history --------------------------------------------------- */

const note = (i) => ({ files: ['uid/file-' + i + '.pdf'], tables: ['t' + i], accessGroups: ['authorized'], hits: [{ path: 'uid/file-' + i + '.pdf', page: i + 1 }], tools: ['searchText'], web: false, source: 'tools' });

function history(pairs, withNotes) {
    const h = [];
    for (let i = 0; i < pairs; i++) {
        h.push({ role: 'user', content: 'question ' + i });
        const a = { role: 'assistant', content: 'answer ' + i };
        if (withNotes) a._retrieval = note(i);
        h.push(a);
    }
    h.push({ role: 'user', content: 'follow-up' });
    return h;
}

const SYSTEM = 'system prompt';
const build = (h, extra) => buildBoundedChatMessages(Object.assign({ platform: 'claude', model: 'claude-sonnet-5', systemPrompt: SYSTEM, projectId: 'p', history: h }, extra || {}));

test('the newest RETRIEVAL_NOTES_MAX assistant turns carry their note; older ones do not; the turn being sent never does', () => {
    const out = build(history(10, true)).messages;
    const withNote = out.filter((m) => m.content.indexOf(RETRIEVAL_NOTE_PREFIX) !== -1);
    assert.strictEqual(withNote.length, RETRIEVAL_NOTES_MAX);
    assert.ok(withNote.every((m) => m.role === 'assistant'));
    // the newest six: answers 4..9
    for (let i = 4; i < 10; i++) {
        const m = out.find((x) => x.content.indexOf('answer ' + i + '\n\n') === 0);
        assert.ok(m, 'answer ' + i + ' lost its note');
        assert.ok(m.content.indexOf('uid/file-' + i + '.pdf p' + (i + 1)) !== -1, 'the note is the turn\'s own');
    }
    for (let i = 0; i < 4; i++) {
        const m = out.find((x) => x.content === 'answer ' + i);
        assert.ok(m, 'answer ' + i + ' should be untouched');
    }
    assert.strictEqual(out[out.length - 1].content, 'follow-up');
    assert.ok(out.every((m) => m.role !== 'user' || m.content.indexOf(RETRIEVAL_NOTE_PREFIX) === -1), 'a user turn carried a note');
});

test('the displayed bubble is never changed: the note is appended to a COPY', () => {
    const h = history(3, true);
    build(h);
    assert.strictEqual(h[1].content, 'answer 0');
    assert.strictEqual(h[5].content, 'answer 2');
});

test('a history without notes builds exactly the request it always did', () => {
    const plain = build(history(10, false));
    const flagged = build(history(10, false), { retrievalNotes: true });
    assert.deepStrictEqual(flagged, plain);
    assert.ok(plain.messages.every((m) => m.content.indexOf(RETRIEVAL_NOTE_PREFIX) === -1));
    assert.deepStrictEqual(Object.keys(plain.messages[0]).sort(), ['content', 'role'], 'only role and content go to the provider');
});

test('retrievalNotes: false leaves every note out', () => {
    const out = build(history(10, true), { retrievalNotes: false }).messages;
    assert.ok(out.every((m) => m.content.indexOf(RETRIEVAL_NOTE_PREFIX) === -1));
    assert.deepStrictEqual(out, build(history(10, false)).messages);
});

test('the token bound: applyRetrievalNotes never exceeds RETRIEVAL_NOTES_TOKEN_BUDGET, and counts newest first', () => {
    // Notes at the character cap: about 200 tokens each, so six of them overrun
    // a 1,200 budget and the oldest of the six must be left out.
    const big = () => {
        const files = [];
        for (let i = 0; i < RETRIEVAL_NOTE_MAX_ITEMS; i++) files.push('uid/a-long-folder-name-to-fill-the-note/another-long-file-name-' + i + '.pdf');
        return { files, tables: files.map((f, i) => 'long_table_name_' + i), accessGroups: ['authorized'], hits: [], tools: ['getRecords'], web: false, source: 'tools' };
    };
    const line = formatRetrievalNote(big());
    assert.ok(line.length >= RETRIEVAL_NOTE_MAX_CHARS - 10, 'the fixture must be near the cap: ' + line.length);
    const h = [];
    for (let i = 0; i < 8; i++) {
        h.push({ role: 'user', content: 'q' + i });
        h.push({ role: 'assistant', content: 'a' + i, _retrieval: big() });
    }
    h.push({ role: 'user', content: 'follow-up' });
    const r = applyRetrievalNotes(h, h.length - 1);
    assert.ok(r.noteTokens <= RETRIEVAL_NOTES_TOKEN_BUDGET, 'tokens ' + r.noteTokens);
    assert.ok(r.notesUsed <= RETRIEVAL_NOTES_MAX);
    assert.ok(r.notesUsed < RETRIEVAL_NOTES_MAX, 'six notes at the cap must not fit in the budget');
    assert.ok(r.notesUsed >= 4);
    // newest first: the last assistant turn always has its note, the first never
    assert.ok(r.messages[h.length - 2].content.indexOf(RETRIEVAL_NOTE_PREFIX) !== -1);
    assert.strictEqual(r.messages[1].content, 'a0');
    // the tokens the function reports are the estimate of what it appended
    let est = 0;
    r.messages.forEach((m) => { const at = m.content.indexOf('\n\n' + RETRIEVAL_NOTE_PREFIX); if (at !== -1) est += estimateTextTokens(m.content.slice(at + 2)) + 2; });
    assert.strictEqual(est, r.noteTokens);
});

test('the note is paid for inside the history budget, not on top of it', () => {
    // Long answers so the history budget is the binding constraint: the number of
    // turns kept with notes can only be <= the number kept without.
    const long = (i) => 'answer ' + i + ' ' + 'x'.repeat(2400);
    const mk = (withNotes) => {
        const h = [];
        for (let i = 0; i < 30; i++) {
            h.push({ role: 'user', content: 'q' + i });
            const a = { role: 'assistant', content: long(i) };
            if (withNotes) a._retrieval = note(i);
            h.push(a);
        }
        h.push({ role: 'user', content: 'follow-up' });
        return h;
    };
    const without = build(mk(false));
    const withN = build(mk(true));
    assert.ok(withN.messages.length <= without.messages.length);
    assert.ok(withN.estimatedInputTokens <= withN.estimatedBudget);
});

test('a malformed _retrieval is ignored rather than thrown on', () => {
    const h = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', _retrieval: 'not a note' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'b', _retrieval: { files: 'nope' } },
        { role: 'user', content: 'follow-up' },
    ];
    const out = build(h).messages;
    assert.strictEqual(out[1].content, 'a');
    assert.strictEqual(out[3].content, 'b');
});

/* ---- the history mapper re-derives it on load ----------------------------------------- */

test('mapHistoryListToMessages attaches the note to a resolved chat turn, from the stored body', () => {
    const list = [{
        id: 'it1', status: 'resolved', created: 1000, updated: 2000,
        request_body: { messages: [{ role: 'user', content: 'what does the contract say?' }] },
        response_body: claudeBody,
    }];
    const r = mapHistoryListToMessages(list, 'claude', { clearedAt: 0, projectId: 'p', formatIndexingLabel: () => 'x' });
    const reply = r.messages.find((m) => m.role === 'assistant');
    assert.ok(reply, 'no assistant bubble mapped');
    assert.ok(isRetrievalNote(reply._retrieval));
    assert.deepStrictEqual(reply._retrieval.files, ['uid/report.pdf']);
    assert.deepStrictEqual(reply._retrieval.hits, [{ path: 'uid/report.pdf', page: 3 }, { path: 'uid/report.pdf', page: 7 }]);
});

test('mapHistoryListToMessages attaches no note to a background-indexing pass', () => {
    const list = [{
        id: 'it2', status: 'resolved', created: 1000, updated: 2000, _isBgTask: true,
        request_body: { messages: [{ role: 'user', content: 'A new file was uploaded.' }] },
        response_body: claudeBody,
    }];
    const r = mapHistoryListToMessages(list, 'claude', { clearedAt: 0, projectId: 'p', formatIndexingLabel: () => 'x' });
    const reply = r.messages.find((m) => m.role === 'assistant');
    assert.ok(reply);
    assert.strictEqual(reply._retrieval, undefined);
});

const failed = results.filter(r => !r[0]);
for (const [ok, name, why] of results) console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '\n      ' + why));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
