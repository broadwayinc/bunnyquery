/**
 * A streamed turn whose answer never reached its row.
 *
 * ONE FACT, and everything here follows from it: a STREAMED request stores
 * nothing on its polling row. The relay appends the destination's bytes to a
 * chunk table and settles the row with a STATUS AND NO BODY; only
 * csr-finalize ever copies an answer onto the row. So a history page can hand
 * back a row that is TERMINAL AND EMPTY, and what everything downstream believes
 * about that row is the whole subject of this file:
 *
 *   * it is UNKNOWN, not empty. A row settles resolved the moment the relay
 *     finishes and gains its body a round trip later, so a refetch landing in
 *     between meets an empty copy of a turn that is on screen right now, and the
 *     merge must not believe it (MAJOR 3).
 *   * it is RECOVERABLE. A row that settled while no poll was attached (closed
 *     tab, discarded background tab, slept device) is never finalized at all, and
 *     its answer is sitting in the chunk store waiting to be read back
 *     (CRITICAL 1).
 *   * a FAILED one is an error, not an empty answer, and the error is one level
 *     deeper than a buffered turn's because the poller has to ship the chunks
 *     that arrived in the same response (CRITICAL 2).
 *   * an INCOMPLETE read must never be stored, because storing it deletes the
 *     part that was missing from it (MAJOR 4), and a failed turn's chunks are
 *     kept for the same reason (MAJOR 5).
 *
 * Run: node ./tests/stream-recovery.cjs
 */

const assert = require('assert');
const engine = require('../dist/engine.cjs');
const {
    ChatSession, configureChatEngine, mapHistoryListToMessages,
    adoptLocalAnswerIntoPage, typewriterResumeIndex,
    isErrorResponseBody, getErrorMessage, isProviderApiKeyError, isAuthExpiredError,
    isCsrStatusEnvelope, csrEnvelopeError, extractClaudeText, streamRecoveryPhase,
} = engine;

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- the wire ------------------------------------------------------------ */

function frame(obj) { return 'event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n'; }
const MSG_START = frame({
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null },
});
const TEXT_OPEN = frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const textDelta = (t) => frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const TEXT_CLOSE = frame({ type: 'content_block_stop', index: 0 });
const MSG_DELTA = frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
const MSG_STOP = frame({ type: 'message_stop' });

const ANSWER = 'The sales table has 412 rows.';
const WHOLE = MSG_START + TEXT_OPEN + textDelta(ANSWER) + TEXT_CLOSE + MSG_DELTA + MSG_STOP;
/** The same answer with the stream cut before its terminal event. */
const CUT = MSG_START + TEXT_OPEN + textDelta('The sales table has ');
/**
 * And the same answer KILLED by an SSE error frame.
 *
 * The shape the keep policy is really about: the frame IS a terminal event, so the
 * parser's `complete` goes true, while the body is only the text that arrived
 * before the error. Finalizing it makes that truncation the turn's permanent
 * history AND releases the chunks in the same call.
 */
const KILLED = MSG_START + TEXT_OPEN + textDelta('The sales table has ') +
    frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });

/** What csr-poll hands back for a row that settled having stored nothing. */
const RESOLVED_ENVELOPE = { id: 'stamp:entropy', status: 'resolved', queue_name: 'u1', in_queue: 0, stream: true };

/** The worker's failed payload: what a BUFFERED failure polls back as, verbatim. */
const BUFFERED_FAILURE = {
    status_code: 401,
    body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    truncated: false,
};
/**
 * And what a STREAMED failure polls back as. The poller cannot return the error
 * early for a streamed row (the chunks that did arrive have to come back in the
 * same response), so it falls through and nests it under `error`.
 */
const STREAMED_FAILURE = {
    id: 'stamp:entropy', status: 'failed', queue_name: 'u1', in_queue: 0,
    stream: true, chunks: [], last_seq: 0, more: false,
    error: BUFFERED_FAILURE,
};

/* ---- harness -------------------------------------------------------------- */

function configure(cfg) {
    const calls = { finalize: [], reads: [], notify: 0 };
    configureChatEngine(Object.assign({
        clientSecretRequest: async () => ({}),
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
        liveStreaming: true,
        clientSecretRequestFinalize: async (id, data, options) => { calls.finalize.push({ id, data, options }); return { finalized: true }; },
        // The chunk reader. Replays `script` (raw relayed text) through onStream and
        // resolves with the row's terminal envelope, exactly as the SDK's
        // clientSecretRequestStream does for an already-finished, unfinalized turn.
        clientSecretRequestStream: async (requestId, options) => {
            calls.reads.push({ requestId, options });
            const script = (cfg && cfg.__chunks) || {};
            const text = script[requestId] !== undefined ? script[requestId] : WHOLE;
            if (text && options.onStream) options.onStream(text, 1);
            return RESOLVED_ENVELOPE;
        },
    }, cfg));
    return calls;
}

function makeSession(calls, messages, identity) {
    const s = Object.create(ChatSession.prototype);
    s.state = {
        messages: messages || [], historyEndOfList: false, historyStartKeyHistory: [],
    };
    s.liveStreams = {};
    s.aiChatHistoryCache = {};
    const ident = identity || { platform: 'claude', projectId: 'p1', owner: 'o1', userId: 'u1' };
    s.host = {
        getIdentity: () => s._identity,
        notify: () => { calls.notify++; },
        refreshMessageBubble: () => { },
        scrollToBottomIfSticky: () => { },
    };
    s._identity = ident;
    return s;
}

const HISTORY_OPTS = {
    clearedAt: 0, projectId: 'p1', userId: 'u1',
    formatIndexingLabel: (name) => 'Indexing: ' + name,
};

/** A surface history row, as clientSecretRequestHistory hands it over. */
function row(over) {
    return Object.assign({
        id: 'stamp:entropy',
        status: 'resolved',
        request_body: { messages: [{ role: 'user', content: 'how many rows?' }] },
        created: 1000, updated: 2000,
    }, over);
}

(async () => {

/* ══ CRITICAL 2: a row-level failure says what actually went wrong ═══════ */

await test('the failed STREAMED envelope is recognised as an error at all', () => {
    // It was not: the payload sits under `error`, `status` is the string 'failed'
    // rather than a number, and there is no top-level status_code, so every
    // predicate came back false and the turn rendered as "no text response".
    assert.strictEqual(isErrorResponseBody(STREAMED_FAILURE), true);
});

await test('and it reports the PROVIDER\'S message, not a shrug', () => {
    assert.strictEqual(getErrorMessage(STREAMED_FAILURE), 'invalid x-api-key');
    // The same message a buffered failure gives: one path, two transports.
    assert.strictEqual(getErrorMessage(STREAMED_FAILURE), getErrorMessage(BUFFERED_FAILURE));
});

await test('a wrong API KEY is still recognised as one through the envelope', () => {
    // This is the affordance that tells the project owner to go fix their key
    // instead of retrying forever.
    assert.strictEqual(isProviderApiKeyError(STREAMED_FAILURE), true);
    assert.strictEqual(isAuthExpiredError({
        id: 'x:y', status: 'failed', in_queue: 0,
        error: { status_code: 401, body: { error: { message: 'token has expired' } } },
    }), true);
});

await test('a BUFFERED failure is untouched, byte for byte', () => {
    assert.strictEqual(isErrorResponseBody(BUFFERED_FAILURE), true);
    assert.strictEqual(getErrorMessage(BUFFERED_FAILURE), 'invalid x-api-key');
    assert.strictEqual(csrEnvelopeError(BUFFERED_FAILURE), undefined);
});

await test('a RESOLVED envelope is not an error, and a CANCELLED one is left alone', () => {
    // Resolved means the body is the answer (the settle substitutes it); cancelled
    // is settled by _isCancelledPollResult, which must keep seeing its envelope.
    assert.strictEqual(isErrorResponseBody(RESOLVED_ENVELOPE), false);
    const cancelled = { id: 'stamp:entropy', status: 'cancelled', queue_name: 'u1', in_queue: 0 };
    assert.strictEqual(isErrorResponseBody(cancelled), false);
    assert.strictEqual(csrEnvelopeError(cancelled), undefined);
});

await test('a failed envelope with NO payload still reads as a failure', () => {
    // The worker recorded no detail, or its spill could not be fetched. The row's
    // status is itself the fact; reading it as a clean turn would be a lie.
    const bare = { id: 'stamp:entropy', status: 'failed', in_queue: 0, stream: true, error: null };
    assert.strictEqual(isErrorResponseBody(bare), true);
    assert.ok(getErrorMessage(bare).length > 0);
});

await test('a PROVIDER body that happens to carry a status is not mistaken for an envelope', () => {
    // OpenAI's Responses object has a `status`. Without the id/in_queue demand, a
    // real answer would be unwrapped as if it were a poll envelope.
    const openaiBody = { id: 'resp_1', status: 'completed', output: [], output_text: 'hi' };
    assert.strictEqual(isCsrStatusEnvelope(openaiBody), false);
    assert.strictEqual(isErrorResponseBody(openaiBody), false);
});

/* ══ MAJOR 7: the typewriter resumes instead of replaying ════════════════ */

await test('a painted answer with a LEADING NEWLINE still resumes where it left off', () => {
    // The painter writes the parser's text untrimmed; every settle path trims. And
    // the extractor joins text blocks with '\n', so a model that opens an empty
    // text block before its first tool call, which Claude does routinely, paints
    // an answer starting with a newline the authoritative one does not have.
    // Compared raw, the two agree on nothing and the whole answer is retyped.
    const painted = '\n' + 'The sales ';
    assert.strictEqual(typewriterResumeIndex(painted, ANSWER, []), 10);
});

await test('leading whitespace of any shape is normalised, not just one newline', () => {
    assert.strictEqual(typewriterResumeIndex('\n\n  The sales ', ANSWER, []), 10);
});

await test('an answer that is ONLY leading whitespace replays from zero, and does not throw', () => {
    assert.strictEqual(typewriterResumeIndex('\n\n', ANSWER, []), 0);
});

await test('an untrimmed fullText is left in its own frame', () => {
    // Both sides carry the newline here, so there is nothing to normalise and
    // cutting the painted side would misalign the two.
    const full = '\nThe sales table';
    assert.strictEqual(typewriterResumeIndex('\nThe sales ', full, []), 11);
});

/* ══ MAJOR 4 / MAJOR 5: what may be STORED, and what is kept instead ═════ */

/** A poll source that relays `text` and then settles with `result`. */
function makeSource(text, result) {
    return {
        lastArg: null,
        poll(arg) {
            this.lastArg = arg;
            const p = new Promise((resolve) => {
                (async () => {
                    await sleep(5);
                    if (text && arg.onStream) arg.onStream(text, 1);
                    await sleep(30);
                    if (arg.onResponse) arg.onResponse(result);
                    resolve(result);
                })();
            });
            p.stop = () => { };
            return p;
        },
    };
}

function pendingTurn(itemId) {
    return [
        { role: 'user', content: 'how many rows?', _serverItemId: itemId },
        { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _serverItemId: itemId },
    ];
}

await test('a COMPLETE parse is finalized, as before', async () => {
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    await s.attachForegroundPoll(makeSource(WHOLE, RESOLVED_ENVELOPE), 'stamp:entropy');
    assert.strictEqual(calls.finalize.length, 1);
});

await test('an INCOMPLETE parse is NEVER finalized: storing it would delete the missing part', async () => {
    // Finalizing does two things at once: it stores what you give it, and deletes the
    // chunks it was assembled from. A degraded chunk read (the poller degrades to
    // "no chunks this tick" on any transient chunk-table error, and caps one read at
    // 500k characters) can settle the poll on a stream that stopped mid-answer, and
    // the row can be 'resolved' on top of that because the row's status describes
    // the destination's request, not our read of it.
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    const res = await s.attachForegroundPoll(makeSource(CUT, RESOLVED_ENVELOPE), 'stamp:entropy');
    assert.strictEqual(calls.finalize.length, 0, 'a truncation was written into history permanently');
    // The partial IS still shown: it is the best answer there is right now, and the
    // chunks stay put so a later load can replace it with the whole one.
    assert.strictEqual(extractClaudeText(res), 'The sales table has ');
});

await test('bytes that were never SSE at all ARE finalized (there is no terminal event coming)', async () => {
    // The destination answered with a plain body instead of an event stream. The
    // row's own status is what says the response finished, and this settle only
    // ever runs on a resolved row.
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    const plain = JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: ANSWER }] });
    await s.attachForegroundPoll(makeSource(plain, RESOLVED_ENVELOPE), 'stamp:entropy');
    assert.strictEqual(calls.finalize.length, 1);
    assert.strictEqual(extractClaudeText(calls.finalize[0].data), ANSWER);
});

await test('A STREAM KILLED BY AN ERROR FRAME IS NOT A CLEAN PARTIAL, and is never stored', async () => {
    // The error frame terminates the stream, so the old gate (`complete`, i.e. "a
    // terminal event arrived") passed and the truncation was written into history
    // as the kept version - while finalize released the chunks that held the only
    // copy of it. "A terminal event arrived" and "the answer is complete" are not
    // the same claim; the gate now reads the second one.
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    const res = await s.attachForegroundPoll(makeSource(KILLED, RESOLVED_ENVELOPE), 'stamp:entropy');
    assert.strictEqual(calls.finalize.length, 0, 'a truncation became the turn\'s permanent history');
    // The partial is still SHOWN: it is the best answer there is right now.
    assert.strictEqual(extractClaudeText(res), 'The sales table has ');
});

await test('and the settle notes it, so the marker survives the next refetch', async () => {
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    await s.attachForegroundPoll(makeSource(KILLED, RESOLVED_ENVELOPE), 'stamp:entropy');
    const mapped = mapHistoryListToMessages([row({})], 'claude', HISTORY_OPTS).messages;
    s._adoptLocalAnswers(mapped, 'p1#claude#u1');
    assert.strictEqual(mapped.filter((m) => m.role === 'assistant')[0]._streamPending, true);
});

await test('a FAILED streamed turn is not finalized: its chunks are the only copy of what arrived', async () => {
    // The two ways to release them both cost something real. Storing the partial
    // makes a truncated answer the turn's permanent history AND masks the failure
    // (csr-poll hands back a finalized body before it looks at the row's error);
    // storing the error throws the partial away. Retention is the honest trade.
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    const res = await s.attachForegroundPoll(makeSource(CUT, STREAMED_FAILURE), 'stamp:entropy');
    assert.strictEqual(calls.finalize.length, 0);
    // And the turn now says what went wrong instead of "no text response".
    assert.strictEqual(isErrorResponseBody(res), true);
    assert.strictEqual(getErrorMessage(res), 'invalid x-api-key');
});

/* ══ MAJOR 6: the turn's own identity, not whoever is on screen now ══════ */

await test('a stream is finalized against the project the turn was SENT to', async () => {
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    const p = s.attachForegroundPoll(makeSource(WHOLE, RESOLVED_ENVELOPE), 'stamp:entropy', undefined, {
        platform: 'claude', projectId: 'p1', owner: 'o1', ownerKey: 'p1#claude#u1',
    });
    // The user switches project (and platform) inside the ack round trip.
    s._identity = { platform: 'openai', projectId: 'p2', owner: 'o2', userId: 'u1' };
    await p;
    assert.strictEqual(calls.finalize.length, 1);
    assert.strictEqual(calls.finalize[0].options.service, 'p1', 'finalized against the project the user switched TO');
    assert.strictEqual(calls.finalize[0].options.owner, 'o1');
    assert.ok(/api\.anthropic\.com/.test(calls.finalize[0].options.url), 'addressed with the other platform\'s url');
});

await test('and it is painted into the chat it belongs to, not the one now on screen', async () => {
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    const p = s.attachForegroundPoll(makeSource(WHOLE, RESOLVED_ENVELOPE), 'stamp:entropy', undefined, {
        platform: 'claude', projectId: 'p1', owner: 'o1', ownerKey: 'p1#claude#u1',
    });
    s._identity = { platform: 'claude', projectId: 'p2', owner: 'o1', userId: 'u1' };
    await p;
    assert.strictEqual(s.state.messages[1].content, '', 'painted into another project\'s list');
});

await test('with nothing pinned it still falls back to the live identity', async () => {
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    await s.attachForegroundPoll(makeSource(WHOLE, RESOLVED_ENVELOPE), 'stamp:entropy');
    assert.strictEqual(calls.finalize[0].options.service, 'p1');
});

/* ══ CRITICAL 1: the mapper marks an unfinalized row instead of dropping it ═ */

await test('a terminal row with NO body gets a bubble, marked as "the answer is elsewhere"', () => {
    configure({});
    const out = mapHistoryListToMessages([row({})], 'claude', HISTORY_OPTS);
    const asst = out.messages.filter((m) => m.role === 'assistant');
    assert.strictEqual(asst.length, 1, 'the answer used to vanish from the conversation entirely');
    assert.strictEqual(asst[0]._streamPending, true);
    assert.strictEqual(asst[0].content, '');
    assert.deepStrictEqual(out.streamPendingItemIds, ['stamp:entropy']);
});

await test('a row that DOES hold a body is an ordinary turn, unmarked', () => {
    configure({});
    const body = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: ANSWER }] };
    const out = mapHistoryListToMessages([row({ response_body: body })], 'claude', HISTORY_OPTS);
    const asst = out.messages.filter((m) => m.role === 'assistant');
    assert.strictEqual(asst[0].content, ANSWER);
    assert.strictEqual(asst[0]._streamPending, undefined);
});

await test('a FAILED row keeps rendering its error, and is not marked recoverable', () => {
    // Its chunks are kept but not rendered: the live path discards a failed turn's
    // partial too, so live and reloaded read the same.
    configure({});
    const out = mapHistoryListToMessages([row({ status: 'failed', error: BUFFERED_FAILURE })], 'claude', HISTORY_OPTS);
    const asst = out.messages.filter((m) => m.role === 'assistant');
    assert.strictEqual(asst[0].isError, true);
    assert.strictEqual(asst[0].content, 'invalid x-api-key');
    assert.strictEqual(asst[0]._streamPending, undefined);
});

await test('a BACKGROUND row is never marked: nothing on that queue ever streams', () => {
    // chatStreamWiring turns streaming off for the whole bg queue (an indexing pass
    // must not stream, an attachment turn is left buffered), so a bg row with no
    // body really did answer nothing.
    configure({});
    const bg = row({ _isBgTask: true, request_body: { messages: [{ role: 'user', content: 'A new file has just been uploaded: a.csv' }] } });
    const out = mapHistoryListToMessages([bg], 'claude', HISTORY_OPTS);
    assert.ok(!out.messages.some((m) => m._streamPending));
    const chat = row({ id: 'other:1', _isOnBgQueue: true });
    const out2 = mapHistoryListToMessages([chat], 'claude', HISTORY_OPTS);
    assert.ok(!out2.messages.some((m) => m._streamPending));
});

await test('a PENDING row is untouched: it has a placeholder and a poll already', () => {
    configure({});
    const out = mapHistoryListToMessages([row({ status: 'running' })], 'claude', HISTORY_OPTS);
    const asst = out.messages.filter((m) => m.role === 'assistant');
    assert.strictEqual(asst[0].isPending, true);
    assert.strictEqual(asst[0]._streamPending, undefined);
});

await test('with streaming OFF but a reader present, an already-streamed row is STILL marked', () => {
    // The mark follows the chunk READER, not the streaming flag. Gated on
    // liveStreaming, turning streaming off (an embedder drops the option, a dev
    // rolls the constant back) unmarked every row streamed before it in the same
    // moment: no bubble, no marker, no recovery, and the answers unreachable with
    // every byte still in the chunk table.
    configure({ liveStreaming: false });
    const out = mapHistoryListToMessages([row({})], 'claude', HISTORY_OPTS);
    const asst = out.messages.filter((m) => m.role === 'assistant');
    assert.strictEqual(asst.length, 1);
    assert.strictEqual(asst[0]._streamPending, true);
    // And a host that wants the pre-recovery rendering back says so explicitly.
    configure({ liveStreaming: false, streamRecovery: false });
    const off = mapHistoryListToMessages([row({})], 'claude', HISTORY_OPTS);
    assert.strictEqual(off.messages.filter((m) => m.role === 'assistant').length, 0);
});

await test('and with no CHUNK READER either: a marker nothing can act on is not minted', () => {
    // It would trade today's missing bubble for a permanently empty one.
    configure({ clientSecretRequestStream: undefined });
    const out = mapHistoryListToMessages([row({})], 'claude', HISTORY_OPTS);
    assert.strictEqual(out.messages.filter((m) => m.role === 'assistant').length, 0);
});

/* ══ CRITICAL 1: and the read-back fills it in ═══════════════════════════ */

function recoverableList() {
    return [
        { role: 'user', content: 'how many rows?', _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
        { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
    ];
}

await test('THE UNRECOVERABLE TURN: its chunks are read back and become the answer', async () => {
    const calls = configure({});
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(calls.reads.length, 1, 'nobody went to look for the answer');
    assert.strictEqual(calls.reads[0].requestId, 'stamp:entropy');
    assert.strictEqual(calls.reads[0].options.since, 0, 'a replay must start from the first byte');
    assert.strictEqual(s.state.messages[1].content, ANSWER);
    assert.strictEqual(s.state.messages[1]._streamPending, undefined);
});

await test('and it is FINALIZED, so the row is ordinary history from then on', async () => {
    // Which is also what releases the chunks, and what makes the recovery run at
    // most once ever, in any tab, not just this session.
    const calls = configure({});
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(calls.finalize.length, 1);
    assert.strictEqual(extractClaudeText(calls.finalize[0].data), ANSWER, 'history must read it like a buffered turn');
    assert.strictEqual(calls.finalize[0].options.service, 'p1');
});

await test('a row ANOTHER tab already finalized is used as-is, and not stored twice', async () => {
    // clientSecretRequestStream resolves with the stored body itself when the row
    // turned out to be finalized after all (its chunks were released with it, so
    // nothing streams). That body is the answer; re-storing it would be a round
    // trip that changes nothing.
    const stored = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'kept earlier' }] };
    const calls = configure({ clientSecretRequestStream: async (requestId, options) => { return stored; } });
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(s.state.messages[1].content, 'kept earlier');
    assert.strictEqual(calls.finalize.length, 0);
});

await test('a second load does NOT read the same chunks again', async () => {
    const calls = configure({});
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    s.state.messages = recoverableList(); // the page came back with the same row
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(calls.reads.length, 1, 'every visibilitychange would re-read the whole answer');
});

await test('recovery is CAPPED per load and takes the NEWEST turns first', async () => {
    const calls = configure({});
    const many = [];
    for (const id of ['a:1', 'b:2', 'c:3', 'd:4']) {
        many.push({ role: 'user', content: 'q', _serverItemId: id, _ownerKey: 'p1#claude#u1' });
        many.push({ role: 'assistant', content: '', _streamPending: true, _serverItemId: id, _ownerKey: 'p1#claude#u1' });
    }
    const s = makeSession(calls, many);
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(40);
    assert.strictEqual(calls.reads.length, 2, 'a page of them must not become a page of chunk reads');
    assert.deepStrictEqual(calls.reads.map((r) => r.requestId), ['d:4', 'c:3']);
});

await test('a turn with a LIVE stream attached is left to its poll', async () => {
    const calls = configure({});
    const s = makeSession(calls, recoverableList());
    s.liveStreams['stamp:entropy'] = { id: 'stamp:entropy' };
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(calls.reads.length, 0, 'a second full read to arrive at the answer already arriving');
});

await test('chunks that turn out to be EMPTY leave the list exactly as it was before', async () => {
    // The row never streamed after all. Today's behaviour for such a row is no
    // assistant bubble, and that is what it gets, never a permanently empty one.
    const calls = configure({ __chunks: { 'stamp:entropy': '' } });
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(s.state.messages.length, 1);
    assert.strictEqual(s.state.messages[0].role, 'user');
    assert.strictEqual(calls.finalize.length, 0, 'nothing was read, so there is nothing to keep');
});

await test('a read that FAILS leaves the marker on, so the next load can try again', async () => {
    const calls = configure({
        clientSecretRequestStream: async () => { throw new Error('csr-poll is down'); },
    });
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    // The bubble is still there and still empty (the same thing the user saw
    // before), and nothing was invented to put in it.
    assert.strictEqual(s.state.messages.length, 2);
    assert.strictEqual(s.state.messages[1].content, '');
    assert.strictEqual(calls.finalize.length, 0);
    // AND THE MARKER IS STILL ON, which is the whole of "try again". Clearing it
    // left a blank bubble that nothing would ever revisit: one 500 on one request
    // and the answer was unreachable for the rest of the session, with every byte
    // of it still in the chunk table. "I read it and there was nothing there" and
    // "the read itself failed" are different facts and settle differently.
    assert.strictEqual(s.state.messages[1]._streamPending, true, 'a failed read disarmed the recovery');
});

await test('and the next load DOES try again, and gets the answer', async () => {
    let attempt = 0;
    const calls = configure({
        clientSecretRequestStream: async (requestId, options) => {
            calls.reads.push({ requestId, options });
            if (++attempt === 1) throw new Error('csr-poll is down');
            if (options.onStream) options.onStream(WHOLE, 1);
            return RESOLVED_ENVELOPE;
        },
    });
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(calls.reads.length, 2, 'the failed attempt was remembered as done');
    assert.strictEqual(s.state.messages[1].content, ANSWER);
    assert.strictEqual(calls.finalize.length, 1);
});

await test('A STOPPED READ IS NOT AN ANSWER: the bubble survives and stays recoverable', async () => {
    // skapi's stop resolves the read with a FROZEN { id, status: 'stopped' } - no
    // in_queue, so isCsrStatusEnvelope says no, and "not an envelope" used to mean
    // "the stored body". That object extracts to no text, so the turn read as "there
    // was nothing here": the bubble was DELETED, its marker with it, and the answer
    // became unreachable because a read got cancelled. A stop says nothing about the
    // turn at all.
    const calls = configure({
        clientSecretRequestStream: async (requestId, options) => {
            calls.reads.push({ requestId, options });
            return Object.freeze({ id: 'stamp:entropy', status: 'stopped' });
        },
    });
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(s.state.messages.length, 2, 'a cancelled read deleted the turn\'s bubble');
    assert.strictEqual(s.state.messages[1]._streamPending, true, 'a cancelled read disarmed the recovery');
    assert.strictEqual(calls.finalize.length, 0, 'a stop object was stored as the answer');
    // And it is not counted as an attempt, so the next load reads it properly.
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(calls.reads.length, 2);
});

await test('RECOVERING A FAILED ROW NEVER FINALIZES IT: the row\'s own status wins', async () => {
    // The keep policy is that a failed turn's chunks are kept, because they are the
    // only copy of the text that did arrive and the two ways to release them both
    // cost something real. The live settle enforced it; the read-back computed the
    // same question from parse completeness ALONE, so recovering a failed row stored
    // a body and released exactly the chunks the policy exists to keep. Two halves
    // of one fix pulling opposite ways.
    const calls = configure({
        clientSecretRequestStream: async (requestId, options) => {
            calls.reads.push({ requestId, options });
            if (options.onStream) options.onStream(WHOLE, 1);
            return STREAMED_FAILURE;
        },
    });
    const s = makeSession(calls, recoverableList());
    // Through the PUBLIC on-demand entry point: the mapper never marks a failed row,
    // so this is the path that reaches one - a host offering "load the rest".
    await s.recoverStreamedAnswer('stamp:entropy');
    await sleep(20);
    assert.strictEqual(calls.finalize.length, 0, 'a failed row\'s chunks were released');
});

await test('A SETTLE THAT READ NOTHING IS AS RECOVERABLE AS A TURN NOBODY POLLED', async () => {
    // The poller degrades to "no chunks this tick, more=true" on any transient
    // chunk-table error. Degrade for the whole life of a poll and the row still
    // settles 'resolved', so the turn ends with no assembled body - and used to end
    // with no NOTE either, because the settle returned before it took one. The turn
    // then rendered "No text response received from AI provider", that sentence was
    // adopted over the row's own empty copy on the next load, and the marker that
    // would have gone back for the answer was cleared with it. Same row, same
    // chunks, same reason as a turn nobody ever polled: same marker.
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    const res = await s.attachForegroundPoll(makeSource('', RESOLVED_ENVELOPE), 'stamp:entropy');
    assert.strictEqual(res, RESOLVED_ENVELOPE, 'nothing was assembled, so nothing is substituted');
    assert.strictEqual(calls.finalize.length, 0);

    // The turn settles downstream as the empty-answer sentence, and the next history
    // load meets the same terminal-and-empty row.
    s.state.messages = [
        { role: 'user', content: 'how many rows?', _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
        { role: 'assistant', content: 'No text response received from AI provider.', _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
    ];
    const mapped = mapHistoryListToMessages([row({})], 'claude', HISTORY_OPTS).messages;
    s._adoptLocalAnswers(mapped, 'p1#claude#u1');
    const asst = mapped.filter((m) => m.role === 'assistant')[0];
    assert.strictEqual(asst._streamPending, true, 'the answer was unreachable from here on');

    // And the recovery fills it in.
    s.state.messages = mapped;
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(s.state.messages.filter((m) => m.role === 'assistant')[0].content, ANSWER);
    assert.strictEqual(calls.finalize.length, 1, 'the recovered answer is what finally gets stored');
});

await test('RECOVERY OUTLIVES THE STREAMING FLAG: a row streamed yesterday is read back today', async () => {
    // Streaming is off (an embedder dropped the option, a dev rolled the constant
    // back, skapiSupportsStreaming degraded an old instance). Rows that already
    // streamed still hold their answers in the chunk table and nowhere else, and
    // gating recovery on liveStreaming stranded every one of them the moment the
    // flag flipped.
    const calls = configure({ liveStreaming: false });
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(calls.reads.length, 1, 'a rendering flag deleted somebody\'s history');
    assert.strictEqual(s.state.messages[1].content, ANSWER);
    assert.strictEqual(calls.finalize.length, 1);
});

await test('recovering a stream KILLED by an error frame shows it and keeps the chunks', async () => {
    const calls = configure({ __chunks: { 'stamp:entropy': KILLED } });
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(s.state.messages[1].content, 'The sales table has');
    assert.strictEqual(calls.finalize.length, 0, 'a killed stream was stored as a clean answer');
});

await test('an INCOMPLETE read is shown but still not stored', async () => {
    const calls = configure({ __chunks: { 'stamp:entropy': CUT } });
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    // Trimmed exactly as a buffered answer is; the point is that it is SHOWN.
    assert.strictEqual(s.state.messages[1].content, 'The sales table has');
    assert.strictEqual(calls.finalize.length, 0, 'a truncated read must not become the kept version');
    assert.strictEqual(s.state.messages[1]._streamPending, undefined);
});

await test('a recovery landing after the user moved on settles in the OWNING chat\'s cache', async () => {
    const calls = configure({});
    const s = makeSession(calls, recoverableList());
    s.aiChatHistoryCache['p1#claude#u1'] = { messages: recoverableList(), endOfList: false, startKeyHistory: [] };
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    // The reader moves to another project while the chunks are on their way, so
    // state.messages is now a different conversation's list.
    s._identity = { platform: 'claude', projectId: 'p2', owner: 'o1', userId: 'u1' };
    s.state.messages = [];
    await sleep(20);
    const cached = s.aiChatHistoryCache['p1#claude#u1'].messages;
    assert.strictEqual(cached[cached.length - 1].content, ANSWER);
    assert.strictEqual(s.state.messages.length, 0, 'wrote into the chat that is on screen now');
});

await test('with no chunk reader configured, nothing is scheduled and nothing throws', async () => {
    const calls = configure({ clientSecretRequestStream: undefined });
    const s = makeSession(calls, recoverableList());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(s.state.messages.length, 2);
});

/* ══ MAJOR 3: the refetch race ═══════════════════════════════════════════ */

await test('AN UNKNOWN ANSWER NEVER OVERWRITES A KNOWN ONE', () => {
    // The rule both bugs fall out of. The server's copy of this turn is empty
    // because finalize has not landed yet; the local copy is the answer on screen.
    const incoming = { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'x:1' };
    const local = { role: 'assistant', content: ANSWER, _localId: 'l1', _serverItemId: 'x:1' };
    assert.strictEqual(adoptLocalAnswerIntoPage(incoming, local), true);
    assert.strictEqual(incoming.content, ANSWER);
    assert.strictEqual(incoming._streamPending, false, 'the answer is on screen: nothing to read back');
    assert.strictEqual(incoming._localId, 'l1', 'the typewriter finds its target by local id');
});

await test('a STILL-LIVE local bubble keeps its live state across the merge', () => {
    // Without this the merge hands back a settled bubble the painter can no longer
    // find (it wants isPending or _streaming), and _turnAlreadyRendered then reads
    // the turn as answered, so the real answer is dropped on the floor at settle.
    const incoming = { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'x:1' };
    const local = { role: 'assistant', content: 'The sales ', isPending: true, _streaming: true, _serverItemId: 'x:1' };
    adoptLocalAnswerIntoPage(incoming, local);
    assert.strictEqual(incoming.content, 'The sales ');
    assert.strictEqual(incoming.isPending, true);
    assert.strictEqual(incoming._streaming, true);
});

await test('an empty local bubble that is merely LIVE is still adopted (it has a stream to keep)', () => {
    const incoming = { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'x:1' };
    const local = { role: 'assistant', content: '', isPending: true, _serverItemId: 'x:1' };
    assert.strictEqual(adoptLocalAnswerIntoPage(incoming, local), true);
    assert.strictEqual(incoming.isPending, true);
    assert.strictEqual(incoming._streamPending, true, 'nothing known yet: the marker stays');
});

await test('an ORDINARY page bubble is never overwritten by a local one', () => {
    // The adoption is only ever for a copy the server admits it does not have.
    const incoming = { role: 'assistant', content: 'server answer', _serverItemId: 'x:1' };
    const local = { role: 'assistant', content: 'stale local text', _serverItemId: 'x:1' };
    assert.strictEqual(adoptLocalAnswerIntoPage(incoming, local), false);
    assert.strictEqual(incoming.content, 'server answer');
});

await test('an empty, settled local bubble is not worth adopting', () => {
    const incoming = { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'x:1' };
    const local = { role: 'assistant', content: '', _serverItemId: 'x:1' };
    assert.strictEqual(adoptLocalAnswerIntoPage(incoming, local), false);
    assert.strictEqual(incoming._streamPending, true);
});

await test('THE RACE: a page mapped mid-finalize does not erase the answer on screen', () => {
    const calls = configure({});
    const s = makeSession(calls, [
        { role: 'user', content: 'how many rows?', _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
        { role: 'assistant', content: ANSWER, _localId: 'l1', _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
    ]);
    // The row is 'resolved' server side; its body is still in flight.
    const mapped = mapHistoryListToMessages([row({})], 'claude', HISTORY_OPTS).messages;
    s._adoptLocalAnswers(mapped, 'p1#claude#u1');
    const asst = mapped.filter((m) => m.role === 'assistant');
    assert.strictEqual(asst[0].content, ANSWER, 'the merge would have replaced the answer with nothing');
    assert.strictEqual(asst[0]._streamPending, false);
});

await test('another chat\'s bubble never crosses into this page', () => {
    const calls = configure({});
    const s = makeSession(calls, [
        { role: 'assistant', content: 'ANOTHER PROJECT\'S ANSWER', _serverItemId: 'stamp:entropy', _ownerKey: 'p9#claude#u1' },
    ]);
    const mapped = mapHistoryListToMessages([row({})], 'claude', HISTORY_OPTS).messages;
    s._adoptLocalAnswers(mapped, 'p1#claude#u1');
    assert.strictEqual(mapped.filter((m) => m.role === 'assistant')[0].content, '');
});

await test('an INCOMPLETE local answer is adopted but KEEPS its marker, so it is still corrected', async () => {
    // Otherwise a truncated answer adopts itself over the row on the next refetch
    // and the whole one is never fetched: the truncation becomes permanent by
    // never being looked at again.
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    await s.attachForegroundPoll(makeSource(CUT, RESOLVED_ENVELOPE), 'stamp:entropy');
    // The live paint TYPES its text in, so the bubble reaches the full partial only
    // once the reveal finishes. What is adopted is whatever is on screen, so settle
    // the animation before reading it or this asserts against a half-typed prefix.
    await s.typewriterQueue;
    const mapped = mapHistoryListToMessages([row({})], 'claude', HISTORY_OPTS).messages;
    s._adoptLocalAnswers(mapped, 'p1#claude#u1');
    const asst = mapped.filter((m) => m.role === 'assistant')[0];
    assert.strictEqual(asst.content, 'The sales table has ');
    assert.strictEqual(asst._streamPending, true, 'the partial would never be replaced by the whole answer');
});

await test('and the recovery then replaces it with the whole answer', async () => {
    const calls = configure({});
    const s = makeSession(calls, pendingTurn('stamp:entropy'));
    await s.attachForegroundPoll(makeSource(CUT, RESOLVED_ENVELOPE), 'stamp:entropy');
    // The refetch has landed and the bubble carries the partial plus its marker.
    s.state.messages = [
        { role: 'user', content: 'how many rows?', _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
        { role: 'assistant', content: 'The sales table has ', _streamPending: true, _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
    ];
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    // The recovery read is async and its paint is TYPED in, so the bubble converges a
    // little after the read resolves. Waiting on the queue once is not enough: the
    // recovery enqueues its reveal after that first await already settled. Wait for
    // the text itself, bounded, rather than guessing a sleep long enough to cover it.
    for (let i = 0; i < 50 && s.state.messages[1].content !== ANSWER; i++) {
        await sleep(20);
        await s.typewriterQueue;
    }
    assert.strictEqual(s.state.messages[1].content, ANSWER);
    assert.strictEqual(calls.finalize.length, 1, 'the COMPLETE read is what finally gets stored');
});

/* ══ THE SPINNER WITH NOTHING BEHIND IT ══════════════════════════════════
 *
 * `_streamPending` says the answer is elsewhere. It does NOT say anybody is on
 * their way to fetch it, and both clients drew a live turn's loader for it - so a
 * bubble the per-load cap left behind, or one whose read had failed, spun for the
 * rest of the session over an answer sitting in the chunk store the whole time.
 * `_streamRecovery` is the missing half, and streamRecoveryPhase is how a view
 * reads the two together. */

/** N marked-and-empty turns, newest LAST (the list is in conversation order). */
function markedTurns(ids) {
    const out = [];
    for (const id of ids) {
        out.push({ role: 'user', content: 'q ' + id, _serverItemId: id, _ownerKey: 'p1#claude#u1' });
        out.push({ role: 'assistant', content: '', _streamPending: true, _serverItemId: id, _ownerKey: 'p1#claude#u1' });
    }
    return out;
}
const asstFor = (s, id) => s.state.messages.find((m) => m.role === 'assistant' && m._serverItemId === id);

await test('THE REPORTED BUG: over the per-load cap, a bubble is marked and NOBODY is fetching it', async () => {
    // Three recoverable turns on one page, STREAM_RECOVERY_PER_LOAD is 2. The two
    // newest are queued and may honestly spin; the third is queued for nobody, and
    // its bubble used to render the same loader forever with no way to resolve it.
    const calls = configure({});
    const s = makeSession(calls, markedTurns(['r1', 'r2', 'r3']));
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    // Synchronously, before any read has landed: the queue is the promise.
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r3')), 'active');
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r2')), 'active');
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r1')), 'idle', 'the cap left this one to nobody');
    await sleep(40);
    // The two that were promised arrive; the third is still marked, still nobody's,
    // and now the view can say so instead of spinning.
    assert.strictEqual(asstFor(s, 'r3').content, ANSWER);
    assert.strictEqual(asstFor(s, 'r2').content, ANSWER);
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r1')), 'idle');
});

await test('and the reader can ask for it: the public affordance recovers a turn the cap skipped', async () => {
    const calls = configure({});
    const s = makeSession(calls, markedTurns(['r1', 'r2', 'r3']));
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(40);
    await s.recoverStreamedAnswer('r1');
    await sleep(10);
    assert.strictEqual(asstFor(s, 'r1').content, ANSWER);
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r1')), '', 'the marker comes off with the answer');
});

await test('a FAILED read says so, instead of spinning forever', async () => {
    // The engine deliberately leaves the marker ON here (it is the only thing
    // keeping the answer reachable) and forgets the attempt. Without the phase that
    // renders as an eternal loader; with it, the view can offer to try again.
    const calls = configure({ clientSecretRequestStream: async () => { throw new Error('csr-poll 500'); } });
    const s = makeSession(calls, markedTurns(['r1']));
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(asstFor(s, 'r1')._streamPending, true, 'still recoverable');
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r1')), 'failed');
});

await test('and asking again after a failure really does read again', async () => {
    let attempt = 0;
    const calls = configure({
        clientSecretRequestStream: async (requestId, options) => {
            attempt++;
            if (attempt === 1) throw new Error('csr-poll 500');
            if (options.onStream) options.onStream(WHOLE, 1);
            return RESOLVED_ENVELOPE;
        },
    });
    const s = makeSession(calls, markedTurns(['r1']));
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r1')), 'failed');
    await s.recoverStreamedAnswer('r1');
    await sleep(10);
    assert.strictEqual(attempt, 2);
    assert.strictEqual(asstFor(s, 'r1').content, ANSWER);
});

await test('THE USER ASKING IS NOT THE RE-RENDER LOOP THE ONCE-PER-ROW GUARD IS FOR', async () => {
    // The automatic recovery refuses a row it has already tried, so that the history
    // load every visibilitychange fires cannot re-read the same chunks forever. The
    // affordance used to inherit that refusal, which made it a button that silently
    // did nothing for exactly the rows most likely to be wearing one: any row an
    // earlier read touched but could not settle onto the bubble.
    const calls = configure({});
    const s = makeSession(calls, markedTurns(['r1']));
    await s.recoverStreamedAnswer('r1');
    await sleep(10);
    const readsAfterFirst = calls.reads.length;
    assert.strictEqual(readsAfterFirst, 1);
    // The automatic path stays refused for the rest of the session...
    s.state.messages = markedTurns(['r1']);
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(calls.reads.length, readsAfterFirst, 'a re-render must not re-read');
    // ...and a click is still honoured.
    await s.recoverStreamedAnswer('r1');
    await sleep(10);
    assert.strictEqual(calls.reads.length, readsAfterFirst + 1);
});

await test('but two reads of the same chunks never run at once, however they are asked for', async () => {
    // Counted here rather than through calls.reads: this test replaces the harness's
    // reader, and the harness counts inside the one it installs.
    let started = 0, inFlight = 0, overlapped = false;
    const calls = configure({
        clientSecretRequestStream: async (requestId, options) => {
            started++;
            inFlight++;
            if (inFlight > 1) overlapped = true;
            await sleep(15);
            inFlight--;
            if (options.onStream) options.onStream(WHOLE, 1);
            return RESOLVED_ENVELOPE;
        },
    });
    const s = makeSession(calls, markedTurns(['r1']));
    const a = s.recoverStreamedAnswer('r1');
    const b = s.recoverStreamedAnswer('r1');
    await Promise.all([a, b]);
    await sleep(5);
    assert.strictEqual(overlapped, false);
    assert.strictEqual(started, 1, 'the second ask is refused while the first is in flight');
});

await test('a queued read that turns out to be refused does not leave the bubble spinning', async () => {
    // The narrow one: an id is queued (and marked 'active', which is a promise that
    // it will be read), and by the time the serial drain reaches it the row has been
    // attempted by something else. The read is refused, and if the refusal left the
    // mark alone the bubble would spin for the rest of the session on a promise that
    // was withdrawn. Reachable only through a manual retry racing the queue, which is
    // exactly the kind of "cannot happen" that this whole file is a list of.
    const calls = configure({});
    const s = makeSession(calls, markedTurns(['r1']));
    s._rec().queue.push({ id: 'r1', ownerKey: 'p1#claude#u1', platform: 'claude', projectId: 'p1', owner: 'o1' });
    s._markRecoveryPhase('r1', 'active');
    s._rec().attempted['r1'] = true;
    s._drainStreamRecovery();
    await sleep(20);
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r1')), 'idle', 'the withdrawn promise must come off the bubble');
});

await test('a STOPPED read goes back to askable, not to failed', async () => {
    // A stop says nothing about the turn: the chunks are untouched and the row is
    // still unfinalized. Nothing failed and nothing is coming, so the bubble offers
    // to be asked again rather than reporting a failure that did not happen.
    const calls = configure({ clientSecretRequestStream: async () => Object.freeze({ id: 'r1', status: 'stopped' }) });
    const s = makeSession(calls, markedTurns(['r1']));
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.strictEqual(s.state.messages.length, 2, 'the bubble is never deleted by a stop');
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r1')), 'idle');
});

await test('a RELOAD MID-READ does not turn a live loader into a button and back', async () => {
    // `_streamRecovery` describes this session's fetching, not the turn, so a freshly
    // mapped page arrives without it. Re-stamped during adoption, which every load
    // path runs on the page before it merges - otherwise a refetch one second into a
    // read would render "press to load" over a read that is already in flight.
    let release;
    const calls = configure({
        clientSecretRequestStream: (requestId, options) => new Promise((res) => {
            release = () => { if (options.onStream) options.onStream(WHOLE, 1); res(RESOLVED_ENVELOPE); };
        }),
    });
    const s = makeSession(calls, markedTurns(['r1']));
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(5);
    assert.strictEqual(streamRecoveryPhase(asstFor(s, 'r1')), 'active');
    // The refetch's page: the same row, mapped fresh, with no idea a read is running.
    const page = markedTurns(['r1']);
    s.adoptLocalAnswers(page, 'p1#claude#u1');
    assert.strictEqual(streamRecoveryPhase(page[1]), 'active', 'the page learns what is already running');
    release();
    await sleep(10);
});

await test('and the phase change is NOTIFIED, or the widget never redraws it', async () => {
    // agent.vue re-renders on the property write (its state is a Vue reactive); the
    // widget's renderer is imperative and redraws on notify alone. Doing only one of
    // the two leaves one client with a stale bubble, which is the fork this file
    // exists to catch.
    const calls = configure({ clientSecretRequestStream: async () => { throw new Error('csr-poll 500'); } });
    const s = makeSession(calls, markedTurns(['r1']));
    const before = calls.notify;
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    assert.ok(calls.notify > before, 'queued -> active was not notified');
    const afterQueue = calls.notify;
    await sleep(20);
    assert.ok(calls.notify > afterQueue, 'active -> failed was not notified');
});

const failed = results.filter(r => !r[0]);
results.forEach(r => console.log(r[0] ? 'ok    ' + r[1] : 'FAIL  ' + r[1] + '\n      ' + r[2]));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

})();
