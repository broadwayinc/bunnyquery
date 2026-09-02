/**
 * Parsing a streamed turn out of raw relayed bytes.
 *
 * The failure this file exists to prevent: extractClaudeText joins TEXT BLOCKS
 * with '\n'. A server-tool turn has text at content index 0 and text again at
 * index 3, so a parser that accumulates every text_delta into one string fuses
 * those two paragraphs with no separator. The answer the user watched arrive and
 * the same turn re-read from history then differ by a newline, every time, and
 * nothing in the app notices. "four separate blocks" below is that test.
 *
 * The second failure: chunks are flushed by the relay worker on a byte cap or a
 * time interval, so a chunk boundary lands wherever the socket broke. It WILL cut
 * a frame in half, in the middle of a JSON escape, and between the two halves of a
 * surrogate pair. The sweeps below re-feed the same transcript split at EVERY
 * offset and demand the identical result.
 *
 * Note on the require: sse.ts is deliberately NOT exported from src/engine/index.ts
 * yet (wiring it into the chat flow is separate work), so it is not in
 * dist/engine.cjs like the other modules the sibling tests import. It is required
 * straight from source instead, which node does natively from 22.18. The buffered
 * extractors it must agree with DO come from dist: the assertion is worthless
 * against a reimplementation of them.
 *
 * Run: node ./tests/sse-stream.cjs
 */

const assert = require('assert');
const { createSseParser } = require('../src/engine/sse.ts');
// isErrorResponseBody / getErrorMessage come from dist for the same reason the
// extractors do: the point of the error assertions below is that the ONE reader
// the app already ships accepts a streamed error, so re-stating its rules here
// would test nothing.
const { extractClaudeText, extractOpenAIText, isErrorResponseBody, getErrorMessage } = require('../dist/engine.cjs');

/* ---- transcript builders -------------------------------------------------*/

// A real frame, exactly as the wire carries it: named event line, one data line,
// terminating blank line.
function frame(obj) {
    return 'event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n';
}

function cbStart(index, block) {
    return frame({ type: 'content_block_start', index: index, content_block: block });
}
function cbDelta(index, delta) {
    return frame({ type: 'content_block_delta', index: index, delta: delta });
}
function cbStop(index) {
    return frame({ type: 'content_block_stop', index: index });
}
function textDeltas(index, pieces) {
    return pieces.map((t) => cbDelta(index, { type: 'text_delta', text: t })).join('');
}

const MSG_START = frame({
    type: 'message_start',
    message: {
        id: 'msg_01ABC',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 4211, output_tokens: 1 },
    },
});

const MSG_DELTA_TOOL_END = frame({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 187 },
});

const MSG_STOP = frame({ type: 'message_stop' });

// THE SHAPE THAT BREAKS A NAIVE PARSER. Text, a server tool call, its result, then
// text again: four content blocks, two of them text, at indexes 0 and 3.
// The text carries a JSON escape (an inner quote), an escaped newline, an accented
// character and an astral emoji, so the byte-boundary sweeps have something real
// to cut in half.
const TEXT_A = 'I checked the "Q3" sheet.\nRésumé of what it says:';
const TEXT_B = 'Revenue was 1.2M 🎉, up 18%.';

const TOOL_TURN =
    MSG_START +
    frame({ type: 'ping' }) +
    ': keepalive comment the relay is free to send\n\n' +
    cbStart(0, { type: 'text', text: '', citations: null }) +
    textDeltas(0, ['I checked the "Q3', '" sheet.\nRésum', 'é of what it says:']) +
    cbStop(0) +
    cbStart(1, { type: 'server_tool_use', id: 'srvtoolu_01', name: 'web_fetch', input: {} }) +
    // The arguments arrive as a stream of fragments chosen by the model's
    // tokeniser. Not one of them is valid JSON on its own.
    cbDelta(1, { type: 'input_json_delta', partial_json: '{"ur' }) +
    cbDelta(1, { type: 'input_json_delta', partial_json: 'l":"https://ex' }) +
    cbDelta(1, { type: 'input_json_delta', partial_json: 'ample.com/q3?a=1&b=' }) +
    cbDelta(1, { type: 'input_json_delta', partial_json: '2","note":"say \\"hi' }) +
    cbDelta(1, { type: 'input_json_delta', partial_json: '\\" politely"}' }) +
    cbStop(1) +
    cbStart(2, {
        type: 'web_fetch_tool_result',
        tool_use_id: 'srvtoolu_01',
        content: { type: 'web_fetch_result', url: 'https://example.com/q3', retrieved_at: '2026-08-30' },
    }) +
    cbStop(2) +
    cbStart(3, { type: 'text', text: '', citations: null }) +
    textDeltas(3, ['Revenue was 1.2M ', '🎉, up ', '18%.']) +
    cbStop(3) +
    MSG_DELTA_TOOL_END +
    MSG_STOP;

/* ---- harness -------------------------------------------------------------*/

const results = [];
function test(name, fn) {
    try {
        fn();
        results.push([true, name]);
    } catch (err) {
        results.push([false, name, (err && err.message) || String(err)]);
    }
}

/** Feed a transcript in fixed-size slices, as the relay's flushes would. */
function parseInChunks(transcript, size) {
    const p = createSseParser();
    for (let i = 0; i < transcript.length; i += size) {
        p.feed(transcript.slice(i, i + size));
    }
    return p;
}

/** Feed a transcript as exactly two chunks, split at `at`. */
function parseSplitAt(transcript, at) {
    const p = createSseParser();
    p.feed(transcript.slice(0, at));
    p.feed(transcript.slice(at));
    return p;
}

/* ---- 1. the newline-join bug --------------------------------------------*/

test('four separate blocks: a tool turn keeps text at index 0 and index 3 apart', () => {
    const p = parseInChunks(TOOL_TURN, 64);
    const body = p.finalBody();

    // FOUR blocks, in index order, never merged. A parser that folded all the
    // text_deltas into one accumulator would land here with two or three.
    assert.strictEqual(body.content.length, 4, 'expected four content blocks');
    assert.deepStrictEqual(
        body.content.map((b) => b.type),
        ['text', 'server_tool_use', 'web_fetch_tool_result', 'text'],
    );

    // The join the extractor performs, which is the whole reason the blocks are
    // kept apart.
    const expected = TEXT_A + '\n' + TEXT_B;
    assert.strictEqual(extractClaudeText(body), expected);

    // AND the live text is the SAME STRING. This is the assertion that fails on
    // the bug: live would read "...what it says:Revenue was..." with the newline
    // silently gone, while the history re-read has it.
    assert.strictEqual(p.snapshot().text, expected);
    assert.ok(p.snapshot().text.indexOf('says:Revenue') === -1, 'the two paragraphs fused');
});

test('the live text tracks the extractor at EVERY point in the stream', () => {
    // Not just at the end: the two must agree on every intermediate state, which
    // is what a reader actually sees. Feeding frame by frame, live text must
    // always equal extractClaudeText of the body as assembled so far.
    const p = createSseParser();
    const frames = TOOL_TURN.split('\n\n').filter((f) => f.length);
    for (const f of frames) {
        p.feed(f + '\n\n');
        const body = p.finalBody();
        if (body) assert.strictEqual(p.snapshot().text, extractClaudeText(body));
    }
    assert.strictEqual(p.snapshot().text, TEXT_A + '\n' + TEXT_B);
});

test('a text block whose start frame was lost still occupies its index', () => {
    // A dropped content_block_start must not let index 3's text merge into index
    // 0's. The block is created empty so the INDEX stays occupied and the join
    // survives; that is the point of keying by index rather than by arrival.
    const lossy =
        MSG_START +
        cbStart(0, { type: 'text', text: '' }) +
        textDeltas(0, ['first']) +
        cbStop(0) +
        cbStart(1, { type: 'tool_use', id: 't1', name: 'getRecords', input: {} }) +
        cbStop(1) +
        // no content_block_start for index 2
        textDeltas(2, ['second']) +
        cbStop(2) +
        MSG_STOP;
    const p = parseInChunks(lossy, 40);
    assert.strictEqual(extractClaudeText(p.finalBody()), 'first\nsecond');
    assert.strictEqual(p.snapshot().text, 'first\nsecond');
});

/* ---- 2. tool arguments ---------------------------------------------------*/

test('tool JSON reassembles from many fragments, and never reaches the answer', () => {
    const p = parseInChunks(TOOL_TURN, 17);
    const body = p.finalBody();
    const tool = body.content[1];

    assert.deepStrictEqual(tool.input, {
        url: 'https://example.com/q3?a=1&b=2',
        note: 'say "hi" politely',
    });

    // Not one fragment of that JSON may appear in what the user reads. This is
    // the "half serialised tool call in the middle of the answer" failure.
    const text = p.snapshot().text;
    for (const needle of ['{"ur', 'https://ex', 'partial_json', 'politely', '"url"']) {
        assert.ok(text.indexOf(needle) === -1, 'live text leaked tool arguments: ' + needle);
    }
});

test('a tool called with no arguments keeps the start frame\'s empty input', () => {
    const t =
        MSG_START +
        cbStart(0, { type: 'tool_use', id: 't1', name: 'getTables', input: {} }) +
        cbStop(0) +
        MSG_STOP;
    const p = parseInChunks(t, 8);
    assert.deepStrictEqual(p.finalBody().content[0].input, {});
    assert.strictEqual(p.snapshot().malformedToolJson, 0);
});

test('truncated tool JSON is reported, not invented', () => {
    const t =
        MSG_START +
        cbStart(0, { type: 'tool_use', id: 't1', name: 'getRecords', input: {} }) +
        cbDelta(0, { type: 'input_json_delta', partial_json: '{"table":"sal' }) +
        cbStop(0) +
        MSG_STOP;
    const p = parseInChunks(t, 11);
    assert.strictEqual(p.snapshot().malformedToolJson, 1);
    assert.deepStrictEqual(p.finalBody().content[0].input, {});
});

/* ---- 3. chunk boundaries -------------------------------------------------*/

test('splitting the transcript at EVERY offset gives the identical result', () => {
    const whole = parseInChunks(TOOL_TURN, TOOL_TURN.length);
    const expectedText = whole.snapshot().text;
    const expectedBody = whole.finalBody();

    for (let at = 1; at < TOOL_TURN.length; at++) {
        const p = parseSplitAt(TOOL_TURN, at);
        const s = p.snapshot();
        assert.strictEqual(s.text, expectedText, 'text differs when split at ' + at);
        assert.deepStrictEqual(p.finalBody(), expectedBody, 'body differs when split at ' + at);
        assert.strictEqual(s.complete, true, 'lost the terminal event when split at ' + at);
        assert.strictEqual(s.malformedFrames, 0, 'a frame was mangled by a split at ' + at);
    }
});

test('one code unit at a time, which splits every surrogate pair there is', () => {
    // A JS string index is a UTF-16 CODE UNIT, so feeding the transcript one index
    // at a time hands the parser a lone high surrogate followed by a lone low
    // surrogate for every astral character in it (the 🎉 in TEXT_B). The buffer
    // must carry those halves across the boundary untouched.
    const p = parseInChunks(TOOL_TURN, 1);
    const s = p.snapshot();
    assert.strictEqual(s.text, TEXT_A + '\n' + TEXT_B);
    assert.ok(s.text.indexOf('🎉') !== -1, 'the emoji did not survive the split');
    assert.ok(s.text.indexOf('�') === -1, 'a replacement character appeared');
    assert.strictEqual(s.malformedFrames, 0);
});

test('a split exactly between the halves of a surrogate pair', () => {
    // Named explicitly rather than left to the sweep, because it is the one
    // boundary a length-based chunker hits by accident and a reviewer never
    // reproduces on purpose.
    const hi = TOOL_TURN.indexOf('\uD83C'); // the high half of 🎉
    assert.ok(hi > 0, 'the fixture lost its astral character');
    assert.strictEqual(TOOL_TURN.charCodeAt(hi + 1), 0xdf89, 'not a surrogate pair');

    const p = parseSplitAt(TOOL_TURN, hi + 1); // between the two halves
    assert.strictEqual(p.snapshot().text, TEXT_A + '\n' + TEXT_B);
    assert.strictEqual(p.snapshot().malformedFrames, 0);
});

test('a split inside a JSON escape sequence', () => {
    // The tool's `note` argument is the string   say "hi" politely
    // which reaches the wire DOUBLE escaped: once for the JSON the tool arguments
    // are written in, once for the JSON of the frame carrying them. So the bytes
    // read   say \\\"hi   and there are three backslashes to cut between. The
    // needle is built rather than typed, because typing six levels of backslash by
    // hand is how this assertion quietly starts searching for nothing and passing
    // on offset 0.
    // Only up to the "hi": the closing \" of that argument is in the NEXT
    // input_json_delta fragment, so the full phrase is never contiguous on the wire.
    const needle = JSON.stringify('say \\"hi').slice(1, -1);
    assert.strictEqual(needle.slice(0, 9), 'say \\\\\\"h', 'the needle is not the wire form');
    const at = TOOL_TURN.indexOf(needle);
    assert.ok(at > 0, 'the fixture lost its escaped quote');
    for (const off of [at + 4, at + 5, at + 6, at + 7]) {
        const p = parseSplitAt(TOOL_TURN, off);
        assert.deepStrictEqual(p.finalBody().content[1].input, {
            url: 'https://example.com/q3?a=1&b=2',
            note: 'say "hi" politely',
        });
    }
});

test('CRLF framing, and a CR held back across a chunk boundary', () => {
    // A '\r' at the end of a chunk is ambiguous: classic-Mac terminator, or the
    // first half of a '\r\n'. Emitting it early produces a spurious EMPTY line,
    // and an empty line is the frame separator, so the frame would be cut in two
    // and lost. The parser holds it.
    const crlf = TOOL_TURN.replace(/\n/g, '\r\n');
    const whole = parseInChunks(TOOL_TURN, TOOL_TURN.length);

    const p = parseInChunks(crlf, 1); // every '\r' lands at a chunk boundary
    assert.strictEqual(p.snapshot().text, whole.snapshot().text);
    assert.deepStrictEqual(p.finalBody(), whole.finalBody());
    assert.strictEqual(p.snapshot().complete, true);
    assert.strictEqual(p.snapshot().malformedFrames, 0);
});

test('a final frame that arrived without its terminating blank line', () => {
    const cut = TOOL_TURN.slice(0, TOOL_TURN.length - 2); // drop the last '\n\n'
    const p = createSseParser();
    p.feed(cut);
    assert.strictEqual(p.snapshot().complete, false, 'message_stop was not framed yet');
    p.end();
    assert.strictEqual(p.snapshot().complete, true, 'end() did not flush the last frame');
});

/* ---- 4. replay and cursors ----------------------------------------------*/

test('a fresh parser replaying from chunk 1 rebuilds the identical state', () => {
    // A reload, or a second tab, meets a stream it did not initiate and reads it
    // from seq 1. Same bytes in, same everything out.
    const chunks = [];
    let seq = 0;
    for (let i = 0; i < TOOL_TURN.length; i += 53) {
        chunks.push({ seq: ++seq, txt: TOOL_TURN.slice(i, i + 53) });
    }
    const live = createSseParser();
    live.feedChunks(chunks);

    const replay = createSseParser();
    replay.feedChunks(chunks);

    assert.strictEqual(replay.snapshot().text, live.snapshot().text);
    assert.deepStrictEqual(replay.finalBody(), live.finalBody());
    assert.strictEqual(replay.snapshot().lastSeq, seq);
});

test('re-delivered chunks from a stale cursor are dropped, not appended twice', () => {
    const chunks = [];
    let seq = 0;
    for (let i = 0; i < TOOL_TURN.length; i += 53) {
        chunks.push({ seq: ++seq, txt: TOOL_TURN.slice(i, i + 53) });
    }
    const p = createSseParser();
    p.feedChunks(chunks);
    const once = p.snapshot().text;
    p.feedChunks(chunks); // the same poll answered twice
    assert.strictEqual(p.snapshot().text, once, 'the answer was duplicated');
});

/* ---- 5. honest termination ----------------------------------------------*/

test('a stream cut before its terminal event reports incomplete', () => {
    const cut = TOOL_TURN.slice(0, TOOL_TURN.indexOf(MSG_DELTA_TOOL_END));
    const p = parseInChunks(cut, 64);
    const s = p.snapshot();
    assert.strictEqual(s.complete, false);
    assert.strictEqual(s.terminalEvent, null);
    assert.strictEqual(s.stopReason, null);
    // The partial answer is still there to render, it is simply labelled partial.
    assert.strictEqual(s.text, TEXT_A + '\n' + TEXT_B);
});

test('a stream cut in the MIDDLE of a frame yields no partial frame', () => {
    const at = TOOL_TURN.indexOf('Revenue was') + 4; // inside a data line
    const p = parseInChunks(TOOL_TURN.slice(0, at), 32);
    const s = p.snapshot();
    assert.strictEqual(s.complete, false);
    assert.ok(s.text.indexOf('Reven') === -1, 'half a frame reached the answer');
    assert.strictEqual(s.malformedFrames, 0, 'a held partial was counted as malformed');
    p.end();
    // end() flushes framing, it does NOT invent a terminal event.
    assert.strictEqual(p.snapshot().complete, false);
});

test('a completed stream reports complete and its stop reason', () => {
    const p = parseInChunks(TOOL_TURN, 64);
    const s = p.snapshot();
    assert.strictEqual(s.complete, true);
    assert.strictEqual(s.terminalEvent, 'message_stop');
    assert.strictEqual(s.stopReason, 'end_turn');
    assert.strictEqual(s.errored, false);
    // message_delta's usage MERGES onto message_start's, it does not replace it.
    assert.deepStrictEqual(p.finalBody().usage, { input_tokens: 4211, output_tokens: 187 });
});

test('an Anthropic error frame terminates the stream in the shape errors.ts reads', () => {
    const t =
        MSG_START +
        cbStart(0, { type: 'text', text: '' }) +
        textDeltas(0, ['partial']) +
        frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    const p = parseInChunks(t, 23);
    const s = p.snapshot();
    assert.strictEqual(s.errored, true);
    assert.strictEqual(s.terminalEvent, 'error');
    assert.strictEqual(s.error.type, 'error');
    assert.strictEqual(s.error.error.message, 'Overloaded');
    // Content did arrive, so the body is the partial message; `errored` is what
    // says not to trust it. With no content at all the body IS the error envelope.
    assert.strictEqual(extractClaudeText(p.finalBody()), 'partial');

    const empty = createSseParser();
    empty.feed(frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    assert.strictEqual(empty.finalBody().type, 'error');
});

/* ---- 5b. "terminal" and "finished" are two different claims --------------*/

test('A TERMINAL EVENT IS NOT A FINISHED ANSWER: an error frame ends AND truncates', () => {
    // THE LOSS THIS SEPARATION PREVENTS. An `error` frame sets terminalEvent, so
    // `complete` goes true, while the text in hand is only what arrived before the
    // error. A caller whose store gate reads `complete` therefore writes that
    // truncation into the turn's permanent history and, because finalize is also
    // the only way to release chunks, deletes the only copy of the bytes in the
    // same call - for a turn the provider explicitly said went wrong.
    const t =
        MSG_START +
        cbStart(0, { type: 'text', text: '' }) +
        textDeltas(0, ['The sales table has ']) +
        frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    const s = parseInChunks(t, 29).snapshot();
    assert.strictEqual(s.complete, true, 'nothing more is coming: that part is true');
    assert.strictEqual(s.answerComplete, false, 'a killed stream must never read as a finished answer');
    assert.strictEqual(s.errored, true);
});

test('a clean Anthropic turn reports BOTH', () => {
    const s = parseInChunks(TOOL_TURN, 64).snapshot();
    assert.strictEqual(s.complete, true);
    assert.strictEqual(s.answerComplete, true);
});

test('response.failed is terminal and not finished; response.completed with an error payload too', () => {
    const failed = createSseParser();
    failed.feed(frame({
        type: 'response.failed',
        response: { id: 'resp_y', status: 'failed', error: { code: 'server_error', message: 'boom' }, output: [] },
    }));
    const fs = failed.snapshot();
    assert.strictEqual(fs.complete, true);
    assert.strictEqual(fs.answerComplete, false);

    // The subtler one: status 'completed' with an error attached. `errored` is what
    // catches it, and answerComplete is defined in terms of `errored` precisely so
    // that this shape cannot slip through a terminalEvent name check.
    const poisoned = createSseParser();
    poisoned.feed(frame({
        type: 'response.completed',
        response: { id: 'resp_z', status: 'completed', error: { code: 'server_error', message: 'boom' }, output: [] },
    }));
    const ps = poisoned.snapshot();
    assert.strictEqual(ps.complete, true);
    assert.strictEqual(ps.errored, true);
    assert.strictEqual(ps.answerComplete, false);
});

test('response.incomplete IS a finished answer: the terminal event carries the whole document', () => {
    // The model stopped short at max_output_tokens, but for OpenAI the terminal
    // event IS the body, so the chunks hold nothing the Response does not. Refusing
    // to keep it would retain chunks forever for a turn that is complete on the
    // wire, which is the opposite mistake.
    const truncated = {
        id: 'resp_t', status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'half', annotations: [] }] }],
    };
    const p = createSseParser();
    p.feed(frame({ type: 'response.incomplete', response: truncated }));
    const s = p.snapshot();
    assert.strictEqual(s.complete, true);
    assert.strictEqual(s.answerComplete, true);
    assert.strictEqual(s.errored, false);
});

test('a stream that was CUT reports neither, and unframed bytes report neither', () => {
    const cut = parseInChunks(TOOL_TURN.slice(0, TOOL_TURN.indexOf(MSG_DELTA_TOOL_END)), 64).snapshot();
    assert.strictEqual(cut.complete, false);
    assert.strictEqual(cut.answerComplete, false);

    // Bytes that were never SSE carry no events at all, so neither flag can be true
    // and none is ever coming: there it is the polling ROW's status that says the
    // response finished, which is why `unframed` is a term of its own in the keep
    // policy rather than a way of setting answerComplete.
    const plain = createSseParser();
    plain.feed(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }));
    plain.end();
    const ps = plain.snapshot();
    assert.strictEqual(ps.unframed, true);
    assert.strictEqual(ps.complete, false);
    assert.strictEqual(ps.answerComplete, false);
});

/* ---- 6. thinking and tools stay out of the answer ------------------------*/

test('interleaved thinking and tool deltas never reach the live text', () => {
    const t =
        MSG_START +
        cbStart(0, { type: 'thinking', thinking: '', signature: '' }) +
        cbDelta(0, { type: 'thinking_delta', thinking: 'The user wants Q3. ' }) +
        cbDelta(0, { type: 'thinking_delta', thinking: 'I should query the sales table.' }) +
        cbDelta(0, { type: 'signature_delta', signature: 'EqQBCgIYAhIM' }) +
        cbStop(0) +
        cbStart(1, { type: 'mcp_tool_use', id: 'mcptu_1', name: 'getRecords', server_name: 'BunnyQuery', input: {} }) +
        cbDelta(1, { type: 'input_json_delta', partial_json: '{"table_name":' }) +
        cbDelta(1, { type: 'input_json_delta', partial_json: '"sales"}' }) +
        cbStop(1) +
        cbStart(2, { type: 'mcp_tool_result', tool_use_id: 'mcptu_1', is_error: false, content: [] }) +
        cbStop(2) +
        cbStart(3, { type: 'text', text: '' }) +
        textDeltas(3, ['Q3 sales ', 'were 1.2M.']) +
        cbStop(3) +
        MSG_DELTA_TOOL_END +
        MSG_STOP;

    const p = parseInChunks(t, 29);
    const s = p.snapshot();

    // THE ANSWER, and nothing else.
    assert.strictEqual(s.text, 'Q3 sales were 1.2M.');
    for (const needle of ['The user wants', 'I should query', 'EqQBCgIYAhIM', 'table_name', 'sales"}']) {
        assert.ok(s.text.indexOf(needle) === -1, 'live text leaked: ' + needle);
    }

    // Thinking is available, just never mixed in.
    assert.strictEqual(s.thinkingText, 'The user wants Q3. I should query the sales table.');
    assert.strictEqual(p.finalBody().content[0].signature, 'EqQBCgIYAhIM');
    assert.deepStrictEqual(p.finalBody().content[1].input, { table_name: 'sales' });

    // And the live text still equals the buffered extraction of the same turn.
    assert.strictEqual(extractClaudeText(p.finalBody()), s.text);
});

test('tool names surface in order, before any answer text exists', () => {
    const prefix =
        MSG_START +
        cbStart(0, { type: 'mcp_tool_use', id: 'a', name: 'getTables', server_name: 'BunnyQuery', input: {} }) +
        cbStop(0) +
        cbStart(1, { type: 'mcp_tool_use', id: 'b', name: 'getRecords', server_name: 'BunnyQuery', input: {} }) +
        cbStop(1) +
        cbStart(2, { type: 'server_tool_use', id: 'c', name: 'web_fetch', input: {} }) +
        cbStop(2);
    const p = parseInChunks(prefix, 37);
    const s = p.snapshot();
    assert.strictEqual(s.text, '', 'a tool-only prefix has no answer yet');
    assert.deepStrictEqual(s.toolNames, ['getTables', 'getRecords', 'web_fetch']);
    assert.strictEqual(s.toolCalls[0].serverName, 'BunnyQuery');
    assert.strictEqual(s.toolCalls[2].type, 'server_tool_use');
    // Two calls to the same tool are two rows, not one.
    const dup = parseInChunks(
        prefix +
            cbStart(3, { type: 'mcp_tool_use', id: 'd', name: 'getRecords', server_name: 'BunnyQuery', input: {} }) +
            cbStop(3),
        37,
    );
    assert.deepStrictEqual(dup.snapshot().toolNames, ['getTables', 'getRecords', 'web_fetch', 'getRecords']);
});

/* ---- 7. OpenAI ----------------------------------------------------------*/

const OPENAI_RESPONSE = {
    id: 'resp_68f',
    object: 'response',
    created_at: 1756500000,
    status: 'completed',
    model: 'gpt-5.6-luna',
    output: [
        { id: 'mcp_1', type: 'mcp_call', name: 'getRecords', server_label: 'BunnyQuery', arguments: '{"table_name":"sales"}' },
        {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Q3 sales were 1.2M 🎉.', annotations: [] }],
        },
    ],
    usage: { input_tokens: 3120, output_tokens: 44, total_tokens: 3164 },
};

const OPENAI_TURN =
    frame({ type: 'response.created', response: { id: 'resp_68f', status: 'in_progress' } }) +
    frame({ type: 'response.in_progress', response: { id: 'resp_68f', status: 'in_progress' } }) +
    frame({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'mcp_1', type: 'mcp_call', name: 'getRecords', server_label: 'BunnyQuery' },
    }) +
    frame({ type: 'response.mcp_call_arguments.delta', output_index: 0, delta: '{"table_name":' }) +
    frame({ type: 'response.mcp_call_arguments.delta', output_index: 0, delta: '"sales"}' }) +
    frame({ type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant' } }) +
    frame({ type: 'response.content_part.added', output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } }) +
    frame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Q3 sales ' }) +
    frame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'were 1.2M ' }) +
    frame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: '🎉.' }) +
    frame({ type: 'response.output_text.done', item_id: 'msg_1', output_index: 1, content_index: 0, text: 'Q3 sales were 1.2M 🎉.' }) +
    frame({ type: 'response.completed', response: OPENAI_RESPONSE });

test('the provider is detected from the bytes, not declared by the caller', () => {
    assert.strictEqual(parseInChunks(TOOL_TURN, 64).snapshot().provider, 'claude');
    assert.strictEqual(parseInChunks(OPENAI_TURN, 64).snapshot().provider, 'openai');
    // Nothing recognisable yet: no guess.
    const p = createSseParser();
    p.feed(': keepalive\n\n');
    assert.strictEqual(p.snapshot().provider, null);
});

test('the OpenAI terminal event is handed back VERBATIM', () => {
    const p = parseInChunks(OPENAI_TURN, 64);
    // Not rebuilt from the deltas, not normalised, not re-keyed: the exact object
    // the provider sent, which is what a buffered call would have returned.
    assert.deepStrictEqual(p.finalBody(), OPENAI_RESPONSE);
    assert.strictEqual(JSON.stringify(p.finalBody()), JSON.stringify(OPENAI_RESPONSE));
    assert.strictEqual(extractOpenAIText(p.finalBody()), 'Q3 sales were 1.2M 🎉.');
    // The live text agreed with it before the terminal event ever arrived.
    assert.strictEqual(p.snapshot().text, 'Q3 sales were 1.2M 🎉.');
    assert.strictEqual(p.snapshot().complete, true);
    assert.strictEqual(p.snapshot().stopReason, 'completed');
    assert.deepStrictEqual(p.snapshot().toolNames, ['getRecords']);
    assert.strictEqual(p.snapshot().malformedFrames, 0);
});

test('OpenAI, split at every offset, is byte-identical', () => {
    for (let at = 1; at < OPENAI_TURN.length; at++) {
        const p = parseSplitAt(OPENAI_TURN, at);
        assert.deepStrictEqual(p.finalBody(), OPENAI_RESPONSE, 'body differs when split at ' + at);
        assert.strictEqual(p.snapshot().text, 'Q3 sales were 1.2M 🎉.', 'text differs when split at ' + at);
    }
});

test('two OpenAI output_text parts join with a newline, as the extractor does', () => {
    // The same newline-join trap as Anthropic's text blocks: extractOpenAIText
    // joins every output_text PART with '\n', so the parts are kept apart by
    // (output_index, content_index) rather than concatenated.
    const two =
        frame({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'first part' }) +
        frame({ type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: 'second part' });
    const p = createSseParser();
    p.feed(two);
    const equivalent = {
        output: [
            { type: 'message', content: [{ type: 'output_text', text: 'first part' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'second part' }] },
        ],
    };
    assert.strictEqual(p.snapshot().text, 'first part\nsecond part');
    assert.strictEqual(p.snapshot().text, extractOpenAIText(equivalent));
});

test('response.incomplete carries its reason and is still a terminal event', () => {
    const truncated = {
        id: 'resp_x',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'cut off here' }] }],
    };
    const p = createSseParser();
    p.feed(
        frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'cut off here' }) +
            frame({ type: 'response.incomplete', response: truncated }),
    );
    const s = p.snapshot();
    assert.strictEqual(s.complete, true, 'the provider did reach a terminal event');
    assert.strictEqual(s.terminalEvent, 'response.incomplete');
    assert.strictEqual(s.stopReason, 'max_output_tokens');
    assert.deepStrictEqual(p.finalBody(), truncated);
});

test('response.failed reports errored and stays readable by isErrorResponseBody', () => {
    const failed = {
        id: 'resp_y',
        status: 'failed',
        error: { code: 'server_error', message: 'The model failed to generate a response.' },
        output: [],
    };
    const p = createSseParser();
    p.feed(frame({ type: 'response.failed', response: failed }));
    const s = p.snapshot();
    assert.strictEqual(s.errored, true);
    assert.strictEqual(s.complete, true);
    assert.deepStrictEqual(p.finalBody(), failed);
    assert.strictEqual(p.finalBody().error.message, 'The model failed to generate a response.');
});

test('an OpenAI stream cut before its terminal event has no body at all', () => {
    const cut = OPENAI_TURN.slice(0, OPENAI_TURN.indexOf('response.completed'));
    const p = parseInChunks(cut, 40);
    const s = p.snapshot();
    assert.strictEqual(s.complete, false);
    // Deliberate: for OpenAI the terminal event IS the body, so there is nothing
    // to hand back. The live text is what the caller renders, marked partial.
    assert.strictEqual(p.finalBody(), null);
    assert.strictEqual(s.text, 'Q3 sales were 1.2M 🎉.');
});

/* ---- 8. robustness -------------------------------------------------------*/

test('feed never throws, whatever arrives', () => {
    const junk = [
        'data: {not json at all}\n\n',
        'data: \n\n',
        'data: [DONE]\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
        '\n\n\n\n',
        'data: 12\n\n',
        'garbage with no colon\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"future_delta","x":1}}\n\n',
    ];
    const p = createSseParser();
    for (const j of junk) p.feed(j); // must not throw
    p.end();
    assert.strictEqual(p.snapshot().text, '');
    assert.ok(p.snapshot().malformedFrames > 0, 'malformed frames were not counted');
});

test('a multi-line data payload joins with a newline, per the SSE spec', () => {
    const pretty =
        'event: content_block_start\n' +
        'data: {"type":"content_block_start","index":0,\n' +
        'data:  "content_block":{"type":"text","text":""}}\n\n' +
        cbDelta(0, { type: 'text_delta', text: 'ok' });
    const p = createSseParser();
    p.feed(pretty);
    assert.strictEqual(p.snapshot().text, 'ok');
    assert.strictEqual(p.snapshot().malformedFrames, 0);
});

/* ---- 9. an OpenAI stream that dies on an error ---------------------------*/

// The wire shape of the Responses API `error` event: the fields are INLINE, not
// nested under an `error` key, which is why takeError() has to wrap it.
const OPENAI_ERROR_EVENT = {
    type: 'error',
    code: 'server_error',
    message: 'The server had an error while processing your request.',
    param: null,
    sequence_number: 7,
};

test('an OpenAI stream that dies on an error event still has that error as its body', () => {
    // THE BUG: buildBody() returned `response` for OpenAI before the error fallback
    // could run, and a stream killed by an `error` frame never sends a terminal
    // Response, so `response` was null and finalBody() was null. The destination's
    // own explanation was parsed, stored in `error`, and then unreachable: the
    // caller got an empty turn with no reason for it.
    const t =
        frame({ type: 'response.created', response: { id: 'resp_e', status: 'in_progress' } }) +
        frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Half an ans' }) +
        frame(OPENAI_ERROR_EVENT);
    const p = parseInChunks(t, 19);
    const s = p.snapshot();

    assert.strictEqual(s.provider, 'openai');
    assert.strictEqual(s.errored, true);
    assert.strictEqual(s.terminalEvent, 'error');

    const body = p.finalBody();
    assert.ok(body, 'the error was thrown away: finalBody() is null');
    // The whole point of the shape: the reader the app already ships accepts it,
    // so a streamed error and a buffered one take one code path.
    assert.strictEqual(isErrorResponseBody(body), true);
    assert.strictEqual(getErrorMessage(body), OPENAI_ERROR_EVENT.message);

    // The partial answer is still renderable, and still separate from the error.
    assert.strictEqual(s.text, 'Half an ans');
});

test('response.error is read exactly like a bare error event', () => {
    // Some relays name the frame response.error and nest the payload. Both spellings
    // have to land in the shape isErrorResponseBody() reads, or the caller's error
    // branch depends on which relay it went through.
    const p = createSseParser();
    p.feed(
        frame({ type: 'response.created', response: { id: 'resp_e2', status: 'in_progress' } }) +
            frame({ type: 'response.error', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached.' } }),
    );
    const body = p.finalBody();
    assert.strictEqual(p.snapshot().errored, true);
    assert.strictEqual(isErrorResponseBody(body), true);
    assert.strictEqual(getErrorMessage(body), 'Rate limit reached.');
});

test('an Anthropic error reaches the same reader, from the same field', () => {
    // The parity assertion. Claude and OpenAI die differently on the wire; the
    // caller must not have to know that.
    const p = createSseParser();
    p.feed(frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    const body = p.finalBody();
    assert.strictEqual(isErrorResponseBody(body), true);
    assert.strictEqual(getErrorMessage(body), 'Overloaded');
});

test('a terminal Response still wins over an error frame that follows it', () => {
    // Ordering, pinned deliberately: once response.completed has arrived, THAT is
    // what a buffered call would have returned, and a trailing error frame must not
    // replace a finished answer with an error envelope. `errored` is how the caller
    // learns about it.
    const p = createSseParser();
    p.feed(OPENAI_TURN + frame(OPENAI_ERROR_EVENT));
    assert.deepStrictEqual(p.finalBody(), OPENAI_RESPONSE);
    assert.strictEqual(p.snapshot().errored, true);
});

/* ---- 10. thinking on both providers -------------------------------------*/

test('OpenAI reasoning fills thinkingText, and never the answer or the body', () => {
    const t =
        frame({ type: 'response.created', response: { id: 'resp_r', status: 'in_progress' } }) +
        frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'The user wants Q3. ' }) +
        frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'I should query the sales table.' }) +
        frame({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Q3 sales ' }) +
        frame({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'were 1.2M.' }) +
        frame({ type: 'response.completed', response: OPENAI_RESPONSE });
    const p = parseInChunks(t, 23);
    const s = p.snapshot();

    assert.strictEqual(s.thinkingText, 'The user wants Q3. I should query the sales table.');
    // Not one character of it in the answer, which is the failure the separate
    // field exists to prevent.
    assert.strictEqual(s.text, 'Q3 sales were 1.2M.');
    for (const needle of ['The user wants', 'I should query']) {
        assert.ok(s.text.indexOf(needle) === -1, 'reasoning leaked into the answer: ' + needle);
    }
    // And the body is still the terminal Response verbatim: reasoning is render-only
    // and cannot alter the turn that gets stored.
    assert.deepStrictEqual(p.finalBody(), OPENAI_RESPONSE);
    assert.strictEqual(s.malformedFrames, 0);
});

test('thinkingText means the same thing on both providers', () => {
    // WHY THE FIELD WAS FILLED RATHER THAN RENAMED. Same thinking, same answer, two
    // wire formats: a consumer that draws a "thinking..." affordance must not have
    // to branch on `provider`, and absorbing that branch is what this module is for.
    // Before this, the OpenAI side read '' and the affordance silently never drew.
    const THINKING = 'Checking the Q3 sheet first.';
    const ANSWER = 'Revenue was 1.2M.';

    const claude = createSseParser();
    claude.feed(
        MSG_START +
            cbStart(0, { type: 'thinking', thinking: '', signature: '' }) +
            cbDelta(0, { type: 'thinking_delta', thinking: THINKING }) +
            cbStop(0) +
            cbStart(1, { type: 'text', text: '' }) +
            textDeltas(1, [ANSWER]) +
            cbStop(1) +
            MSG_STOP,
    );

    const openai = createSseParser();
    openai.feed(
        frame({ type: 'response.created', response: { id: 'resp_p', status: 'in_progress' } }) +
            frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: THINKING }) +
            frame({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: ANSWER }),
    );

    assert.strictEqual(claude.snapshot().thinkingText, THINKING);
    assert.strictEqual(openai.snapshot().thinkingText, THINKING);
    assert.strictEqual(claude.snapshot().text, openai.snapshot().text);
});

test('a reasoning done frame repairs a summary that lost a delta', () => {
    // Same repair as output_text.done, for the same reason: a chunk the worker could
    // not write leaves a hole nobody can see. The done frame carries the whole part.
    const p = createSseParser();
    p.feed(
        frame({ type: 'response.created', response: { id: 'resp_d', status: 'in_progress' } }) +
            frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'first half ' }) +
            // the second delta never made it
            frame({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'first half and second half' }),
    );
    assert.strictEqual(p.snapshot().thinkingText, 'first half and second half');
});

test('two reasoning parts join with a newline, and raw reasoning is read too', () => {
    // reasoning_summary_text is indexed by summary_index, reasoning_text by
    // content_index. Both families are read because a model emits one or the other,
    // and a consumer must not get an empty affordance because it met the other one.
    const summaries = createSseParser();
    summaries.feed(
        frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 1, delta: 'second thought' }) +
            frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'first thought' }),
    );
    // Ordered by index, not by arrival: the join is a pure function of the events.
    assert.strictEqual(summaries.snapshot().thinkingText, 'first thought\nsecond thought');

    const rawReasoning = createSseParser();
    rawReasoning.feed(
        frame({ type: 'response.created', response: { id: 'resp_rr', status: 'in_progress' } }) +
            frame({ type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: 'let me think' }),
    );
    assert.strictEqual(rawReasoning.snapshot().thinkingText, 'let me think');
});

/* ---- 11. bytes that were never SSE at all -------------------------------*/

// What the destination sends when the request body never asked it to stream: a
// plain Messages response, one JSON document, no framing anywhere in it.
const BUFFERED_CLAUDE = {
    id: 'msg_01BUF',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [
        { type: 'text', text: 'Q3 revenue was 1.2M.', citations: null },
        { type: 'text', text: 'Margins held at 41%.', citations: null },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 4211, output_tokens: 187 },
};

/** Feed a body with no SSE framing at all, in relay-sized slices, then settle. */
function parseUnframed(text, size) {
    const p = createSseParser();
    for (let i = 0; i < text.length; i += size) p.feed(text.slice(i, i + size));
    p.end();
    return p;
}

test('a plain JSON body relayed under stream:true is reported, not silently lost', () => {
    // THE BUG: no frames matched, so the parser returned an empty answer with
    // malformedFrames 0, complete false and finalBody null. The whole reply was
    // gone and nothing in the output said so, so the client drew an empty bubble.
    const bytes = JSON.stringify(BUFFERED_CLAUDE);
    const p = parseUnframed(bytes, 37);
    const s = p.snapshot();

    assert.strictEqual(s.unframed, true, 'a non-SSE body was not reported');
    assert.strictEqual(s.unframedText, bytes, 'the bytes are not handed back verbatim');
    // Distinctly, not as damage: there were no frames to mangle.
    assert.strictEqual(s.malformedFrames, 0);
    // Nothing identified a provider, and nothing here guesses one.
    assert.strictEqual(s.provider, null);
    assert.strictEqual(s.text, '');
    // No terminal EVENT arrived and none ever will: the row's status decides.
    assert.strictEqual(s.complete, false);

    // And the bytes come back as what they are: the body a buffered call returns,
    // which the app's existing extractor reads with no new branch.
    assert.deepStrictEqual(p.finalBody(), BUFFERED_CLAUDE);
    assert.strictEqual(extractClaudeText(p.finalBody()), 'Q3 revenue was 1.2M.\nMargins held at 41%.');
});

test('an unframed OpenAI body is read by its own extractor, unchanged', () => {
    const p = parseUnframed(JSON.stringify(OPENAI_RESPONSE), 64);
    assert.strictEqual(p.snapshot().unframed, true);
    assert.deepStrictEqual(p.finalBody(), OPENAI_RESPONSE);
    assert.strictEqual(extractOpenAIText(p.finalBody()), 'Q3 sales were 1.2M 🎉.');
});

test('an unframed ERROR body reaches the same reader as a streamed one', () => {
    // The payoff of returning the document rather than a flag: a destination that
    // answered 400 with a plain error body takes the caller's ordinary error path.
    const p = parseUnframed(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is too large.' } }),
        11,
    );
    assert.strictEqual(p.snapshot().unframed, true);
    assert.strictEqual(isErrorResponseBody(p.finalBody()), true);
    assert.strictEqual(getErrorMessage(p.finalBody()), 'max_tokens is too large.');
});

test('the unframed verdict is reached at end(), never mid-stream', () => {
    // Until the relay is done, "no framing seen yet" and "the first frame has not
    // finished arriving" are the same state. Deciding early would hand the caller
    // half a document as if it were a body.
    const bytes = JSON.stringify(BUFFERED_CLAUDE);
    const p = createSseParser();
    p.feed(bytes.slice(0, 40));
    assert.strictEqual(p.snapshot().unframed, false, 'called it before the bytes were in');
    assert.strictEqual(p.finalBody(), null);
    p.feed(bytes.slice(40));
    assert.strictEqual(p.snapshot().unframed, false, 'called it before end()');
    p.end();
    assert.strictEqual(p.snapshot().unframed, true);
    assert.deepStrictEqual(p.finalBody(), BUFFERED_CLAUDE);
});

test('a pretty-printed body with `data` and `event` keys is still not SSE', () => {
    // The only thing separating a JSON document from an event stream is the quote:
    // pretty printed, these lines read   "data": {   with the quote INSIDE the field
    // name. If the field test ever loosened, this document would read as framing and
    // the whole body would be dropped on the floor again.
    const doc = {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'see the table' }],
        data: { rows: 3 },
        event: 'quarterly_close',
        id: 'msg_x',
        retry: 0,
    };
    const p = parseUnframed(JSON.stringify(doc, null, 2), 13);
    assert.strictEqual(p.snapshot().unframed, true, 'a quoted key was mistaken for an SSE field');
    assert.deepStrictEqual(p.finalBody(), doc);
});

test('a blank line inside an unframed body does not truncate it', () => {
    // A blank line is the SSE frame separator, so one appearing in a hand-formatted
    // document makes the parser dispatch a group of lines early. The retained bytes
    // must be the WHOLE relay, not the frame group that happened to be pending, or
    // the body comes back as invalid JSON.
    const bytes = JSON.stringify(BUFFERED_CLAUDE, null, 2).replace('\n  "content"', '\n\n  "content"');
    assert.ok(bytes.indexOf('\n\n') !== -1, 'the fixture lost its blank line');
    const p = parseUnframed(bytes, 29);
    assert.strictEqual(p.snapshot().unframed, true);
    assert.deepStrictEqual(p.finalBody(), BUFFERED_CLAUDE);
});

test('a gateway HTML page is not a body, and is not lost either', () => {
    // Nothing here can be a response body, and inventing an envelope for it would be
    // the vendor guessing this module refuses. The caller surfaces a real error and
    // still has the page to show or log.
    const page =
        '<html>\n<head><title>502 Bad Gateway</title></head>\n<body>\n' +
        '<center><h1>502 Bad Gateway</h1></center>\n\n<hr><center>nginx</center>\n</body>\n</html>\n';
    const p = parseUnframed(page, 17);
    const s = p.snapshot();
    assert.strictEqual(s.unframed, true);
    assert.strictEqual(s.unframedText, page, 'the page is the only record of what happened');
    assert.strictEqual(p.finalBody(), null, 'an HTML page was handed back as a body');
    assert.strictEqual(s.malformedFrames, 0);
});

test('a bare JSON scalar is refused as a body but still readable', () => {
    // Same rule dispatch() applies inside a frame: a number is not a response body,
    // and returning one would put the caller's `body.error` lookup on a number.
    const p = parseUnframed('12', 1);
    assert.strictEqual(p.snapshot().unframed, true);
    assert.strictEqual(p.finalBody(), null);
    assert.strictEqual(p.snapshot().unframedText, '12');
});

test('the unframed document is parsed once, however often it is read', () => {
    // finalBody() is called on every render; a multi-megabyte document must not be
    // re-parsed each time.
    const p = parseUnframed(JSON.stringify(BUFFERED_CLAUDE), 64);
    assert.strictEqual(p.finalBody(), p.finalBody(), 'the parsed body was not cached');
});

test('an unframed body reassembles from relay chunks and a stale cursor', () => {
    // The relay flushes on a byte cap or a timer whatever the body is, so a buffered
    // document arrives cut into pieces exactly like a stream, and a re-poll from a
    // stale `since` redelivers some of them.
    const bytes = JSON.stringify(BUFFERED_CLAUDE);
    const chunks = [];
    let seq = 0;
    for (let i = 0; i < bytes.length; i += 31) chunks.push({ seq: ++seq, txt: bytes.slice(i, i + 31) });

    const p = createSseParser();
    p.feedChunks(chunks.slice(0, 3));
    p.feedChunks(chunks); // the same poll answered twice, from seq 1
    p.end();
    assert.strictEqual(p.snapshot().unframed, true);
    assert.deepStrictEqual(p.finalBody(), BUFFERED_CLAUDE, 'chunks were duplicated or dropped');
    assert.strictEqual(p.snapshot().lastSeq, seq);
});

test('a chunk that lands after end() is not read against the earlier prefix', () => {
    // end() means the relay is done, but a poll can answer after the row settled and
    // a caller may feed what it brought. The cached parse of the shorter prefix must
    // not survive that, or the turn keeps a body assembled from half the bytes.
    const bytes = JSON.stringify(BUFFERED_CLAUDE);
    const p = createSseParser();
    p.feed(bytes.slice(0, 50));
    p.end();
    assert.strictEqual(p.snapshot().unframed, true);
    assert.strictEqual(p.finalBody(), null, 'half a document parsed as a body');
    p.feed(bytes.slice(50));
    assert.deepStrictEqual(p.finalBody(), BUFFERED_CLAUDE, 'the stale parse was cached');
});

test('a relay that produced nothing is empty, not an unframed body', () => {
    // Whitespace is not a document. Reporting it as unframed would invite the caller
    // to render blank bytes as an answer, which is the empty bubble again by another
    // route.
    const nothing = createSseParser();
    nothing.end();
    assert.strictEqual(nothing.snapshot().unframed, false);
    assert.strictEqual(nothing.finalBody(), null);

    const blank = parseUnframed('\n\n\r\n  \n', 2);
    assert.strictEqual(blank.snapshot().unframed, false);
    assert.strictEqual(blank.snapshot().unframedText, null);
    assert.strictEqual(blank.finalBody(), null);
});

test('a keepalive comment is framing, so a stream that only pinged is not unframed', () => {
    // A relay that opened the stream and died has sent SSE, just no events. Calling
    // ': keepalive' a body would hand the caller a comment to render.
    const p = createSseParser();
    p.feed(': keepalive\n\n');
    p.end();
    assert.strictEqual(p.snapshot().unframed, false);
    assert.strictEqual(p.finalBody(), null);
});

test('a real stream is never called unframed, split at any offset', () => {
    // The guard against the fix firing on healthy traffic: every split of both
    // transcripts, with end() called, must still report framed.
    for (const transcript of [TOOL_TURN, OPENAI_TURN]) {
        for (let at = 1; at < transcript.length; at++) {
            const p = parseSplitAt(transcript, at);
            p.end();
            const s = p.snapshot();
            assert.strictEqual(s.unframed, false, 'a real stream read as unframed, split at ' + at);
            assert.strictEqual(s.unframedText, null, 'a real stream retained raw bytes, split at ' + at);
        }
    }
    // Including a stream cut mid-frame before any complete frame landed: the event
    // line already proved it was SSE.
    const early = createSseParser();
    early.feed('event: message_start\ndata: {"type":"message_st');
    early.end();
    assert.strictEqual(early.snapshot().unframed, false);
});

/* ---- report --------------------------------------------------------------*/

let failed = 0;
for (const [ok, name, msg] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (ok ? '' : '\n      ' + msg));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
