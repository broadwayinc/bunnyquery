/**
 * Live rendering of a streamed turn: what is safe to show while the answer is
 * still arriving, where the typewriter picks up when the real answer lands, and
 * what the session does with a row that settled with a status and no body.
 *
 * The one fact everything here follows from: a STREAMED request stores nothing on
 * its polling row. Its answer exists only as relayed chunks until csr-finalize
 * says what to keep. So the parser is not a nicety that makes the wait prettier,
 * it is the only copy of the answer there is — which is why the settle
 * substitutes its assembled body for the status envelope, why a poll re-attached
 * after a reload must carry a sink (skapi replays from seq 0), and why the early
 * probe must NOT run: a point lookup on a streamed row returns that same empty
 * envelope, and winning the race with it would stop the poll and throw the answer
 * away.
 *
 * Run: node ./tests/live-stream-session.cjs
 */

const assert = require('assert');
const engine = require('../dist/engine.cjs');
const {
    ChatSession, configureChatEngine, liveSafePrefix, typewriterResumeIndex,
    extractClaudeText, STREAM_POLL_INTERVAL,
} = engine;

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- an Anthropic transcript, exactly as the wire carries it -------------- */

function frame(obj) { return 'event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n'; }
const MSG_START = frame({
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } },
});
const TEXT_OPEN = frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const textDelta = (t) => frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } });
const TEXT_CLOSE = frame({ type: 'content_block_stop', index: 0 });
const MSG_DELTA = frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });
const MSG_STOP = frame({ type: 'message_stop' });

const ANSWER = 'The sales table has 412 rows.';

/** The shape csr-poll hands back for a row that settled having stored nothing. */
const ENVELOPE = { id: 'stamp:entropy', status: 'resolved', queue_name: 'u1', in_queue: 0, stream: true };

/* ---- harness -------------------------------------------------------------- */

let seq = 0;
// A poll that delivers `script` (one entry per tick) and then settles.
//
// The settle is a TICK OF ITS OWN, always, because that is what the transport
// does: the chunks arrive on one csr-poll round trip and the terminal status on a
// later one. Settling in the same breath as the last chunk would hide the whole
// live path from these tests, since the settle stops painting immediately (there
// is no point painting a prefix of an answer that is about to be replaced by the
// authoritative one).
function makeSource(script, finalResult, settleDelay) {
    let stopped = false, stopFn = null;
    const src = {
        lastArg: null,
        poll(arg) {
            src.lastArg = arg;
            const p = new Promise((resolve) => {
                stopFn = () => { stopped = true; resolve({ status: 'stopped', id: 'stamp:entropy' }); };
                (async () => {
                    for (const step of script) {
                        await sleep(step.delay);
                        if (stopped) return;
                        for (const c of step.chunks) arg.onStream && arg.onStream(c, ++seq);
                    }
                    await sleep(settleDelay === undefined ? 60 : settleDelay);
                    if (stopped) return;
                    if (arg.onResponse) arg.onResponse(finalResult);
                    resolve(finalResult);
                })();
            });
            p.stop = () => { if (stopFn) stopFn(); };
            return p;
        },
    };
    return src;
}

function makeSession(cfg, messages) {
    const calls = { notify: 0, refresh: [], finalize: [], lookup: 0, updates: [] };
    configureChatEngine(Object.assign({
        clientSecretRequest: async () => ({}),
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
        liveStreaming: true,
        clientSecretRequestFinalize: async (id, data, options) => { calls.finalize.push({ id, data, options }); return { finalized: true }; },
        csrHistoryItemLookup: async () => { calls.lookup++; return { status: 'resolved', id: 'x' }; },
        onLiveStreamUpdate: (u) => calls.updates.push(u),
    }, cfg));
    const s = Object.create(ChatSession.prototype);
    s.state = { messages: messages || [] };
    s.liveStreams = {};
    s.host = {
        getIdentity: () => ({ platform: 'claude', projectId: 'p1', owner: 'o1', userId: 'u1' }),
        notify: () => { calls.notify++; },
        refreshMessageBubble: (i) => { calls.refresh.push(i); },
        scrollToBottomIfSticky: () => { },
    };
    return { s, calls };
}

/** The turn on screen: a user bubble and its "Thinking..." placeholder. */
function pendingTurn(itemId) {
    return [
        { role: 'user', content: 'how many rows?', _serverItemId: itemId },
        { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _serverItemId: itemId },
    ];
}

(async () => {

/* ---- liveSafePrefix: what is safe to show while it is still growing ------- */

await test('finished prose is shown whole', () => {
    assert.strictEqual(liveSafePrefix('The sales table has 412 rows.'), 'The sales table has 412 rows.');
});

await test('an UNCLOSED file fence is hidden from its opener', () => {
    // A file fence is the download-chip syntax. Half-arrived it is three backticks
    // and a filename shown as prose, which is exactly what the chip replaces.
    const t = 'Here is the export:\n\n```report.csv\nname,total\n';
    assert.strictEqual(liveSafePrefix(t), 'Here is the export:\n\n');
});

await test('a CLOSED fence is shown whole, closing marker and all', () => {
    const t = 'Here:\n\n```report.csv\nname,total\na,1\n```\n\nThat is everything.';
    assert.strictEqual(liveSafePrefix(t), t);
});

await test("a closing fence line is not eaten by the inline-code rule", () => {
    // "```" on its own line is an ODD number of backticks. Cutting there would hide
    // the very marker that closes the block and leave an open fence on screen.
    const t = 'x\n\n```a.txt\nhi\n```';
    assert.strictEqual(liveSafePrefix(t), t);
});

await test('a link whose url has not arrived is hidden from its bracket', () => {
    assert.strictEqual(liveSafePrefix('See [the report](https://exa'), 'See ');
    assert.strictEqual(liveSafePrefix('See [the repo'), 'See ');
});

await test('a completed link is shown whole', () => {
    const t = 'See [the report](https://example.com/r) for details.';
    assert.strictEqual(liveSafePrefix(t), t);
});

await test('a bracket far behind the write head does not freeze the reveal', () => {
    // Without the window, "see [the appendix" (which never closes) would stop the
    // bubble growing for the rest of the answer.
    const t = 'note [1 ' + 'x'.repeat(600) + ' and more text';
    assert.strictEqual(liveSafePrefix(t), t);
});

await test('a growing bare url is hidden until it is whole', () => {
    assert.strictEqual(liveSafePrefix('Source: https://example.com/rep'), 'Source: ');
    assert.strictEqual(liveSafePrefix('Source: https://example.com/rep and'), 'Source: https://example.com/rep and');
});

await test('a growing src:: token is hidden the same way', () => {
    assert.strictEqual(liveSafePrefix('File src::usr/notes.t'), 'File ');
});

await test('an unclosed inline-code span is hidden', () => {
    assert.strictEqual(liveSafePrefix('Run `npm te'), 'Run ');
    assert.strictEqual(liveSafePrefix('Run `npm test` now'), 'Run `npm test` now');
});

await test('every prefix of a growing answer is a real prefix, and none ends inside a link', () => {
    const full = 'Look at [the report](https://example.com/r) and run `npm test`, then read:\n\n```out.csv\na,1\n```\n';
    for (let i = 0; i <= full.length; i++) {
        const safe = liveSafePrefix(full.slice(0, i));
        assert.ok(full.indexOf(safe) === 0, `not a prefix at ${i}: ${JSON.stringify(safe)}`);
        // No half link, no half fence, no dangling bracket at the reveal boundary.
        assert.ok(!/\[[^\]]*$/.test(safe), `dangling '[' at ${i}: ${JSON.stringify(safe)}`);
        assert.ok(!/\]\([^)]*$/.test(safe), `dangling '](' at ${i}: ${JSON.stringify(safe)}`);
        assert.strictEqual((safe.match(/```/g) || []).length % 2, 0, `odd fence count at ${i}`);
    }
});

/* ---- typewriterResumeIndex: where the typewriter picks up ---------------- */

await test('a fully agreeing painted prefix resumes at its end (nothing is retyped)', () => {
    assert.strictEqual(typewriterResumeIndex('The sales ', 'The sales table has 412 rows.', []), 10);
});

await test('a diverging painted prefix resumes where the two stop agreeing', () => {
    assert.strictEqual(typewriterResumeIndex('The sales tabel', 'The sales table has 412 rows.', []), 13);
});

await test('nothing painted, or nothing in common, replays from zero', () => {
    assert.strictEqual(typewriterResumeIndex('', 'anything', []), 0);
    assert.strictEqual(typewriterResumeIndex('zzz', 'anything', []), 0);
});

await test('a resume landing inside an atomic region jumps to that region END', () => {
    // Forward, never back: forward reveals the link whole (the policy those regions
    // exist for), back would make the bubble shrink at the moment the answer settles.
    const full = 'See [the report](https://example.com/r) now';
    const regions = [{ start: 4, end: 39 }];
    assert.strictEqual(typewriterResumeIndex('See [the rep', full, regions), 39);
});

await test('a resume never splits a surrogate pair', () => {
    const emoji = '📊';
    const full = 'chart ' + emoji + ' here';
    // The painted text stops between the two halves of the astral character.
    const painted = 'chart ' + '\uD83D';
    const i = typewriterResumeIndex(painted, full, []);
    assert.strictEqual(i, 6, 'must step back off the lone high surrogate');
    assert.ok(!/[\uD800-\uDBFF]$/.test(full.slice(0, i)));
});

/* ---- the session: paint, settle, finalize -------------------------------- */

await test('relayed chunks are painted into the turn\'s pending bubble', async () => {
    const { s } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([
        { delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta('The sales ')] },
        { delay: 300, chunks: [textDelta('table has 412 rows.') + TEXT_CLOSE + MSG_DELTA + MSG_STOP] },
    ], ENVELOPE);
    const p = s.attachForegroundPoll(src, 'stamp:entropy');
    await sleep(120);
    assert.strictEqual(s.state.messages[1].content, 'The sales ');
    assert.strictEqual(s.state.messages[1]._streaming, true);
    // Still the turn's placeholder as far as every queue mechanism is concerned.
    assert.strictEqual(s.state.messages[1].isPending, true);
    await p;
});

await test('notify() is spent ONCE; every later paint goes through the per-bubble refresh', async () => {
    const { s, calls } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([
        { delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta('one ')] },
        { delay: 300, chunks: [textDelta('two ')] },
        { delay: 300, chunks: [textDelta('three') + TEXT_CLOSE + MSG_DELTA + MSG_STOP] },
    ], ENVELOPE);
    await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(calls.notify, 1, `notify called ${calls.notify} times (a full list rebuild each time)`);
    assert.ok(calls.refresh.length >= 2, `expected per-bubble refreshes, got ${calls.refresh.length}`);
    assert.strictEqual(s.state.messages[1].content, 'one two three');
});

await test('a burst of chunks in one tick is ONE paint, not one per chunk', async () => {
    const { s, calls } = makeSession({}, pendingTurn('stamp:entropy'));
    const burst = [MSG_START, TEXT_OPEN, textDelta('a'), textDelta('b'), textDelta('c'), textDelta('d')];
    const src = makeSource([{ delay: 5, chunks: burst }], ENVELOPE);
    const p = s.attachForegroundPoll(src, 'stamp:entropy');
    await sleep(120);
    // ONE PAINT, not one per chunk. The paint now TYPES the text in rather than
    // stamping it, so the redraws after the first are the typewriter's own frames,
    // which are frame-paced by construction. What this guards is that a six-chunk
    // burst does not produce six separate paints: notify() establishes the bubble
    // exactly once, and the reveal that follows is one animation, not six.
    assert.strictEqual(calls.notify, 1, 'a six-chunk burst painted more than once');
    await s.typewriterQueue;
    assert.strictEqual(s.state.messages[1].content, 'abcd');
    await p;
});

await test('the ASSEMBLED body replaces the status envelope at settle', async () => {
    const { s } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta(ANSWER) + TEXT_CLOSE + MSG_DELTA + MSG_STOP] }], ENVELOPE);
    const res = await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.notStrictEqual(res, ENVELOPE, 'the settle handed back the empty envelope');
    // And it is read by the SHIPPED buffered-path extractor, with no new branch.
    assert.strictEqual(extractClaudeText(res), ANSWER);
});

await test('a row that DOES hold a stored body is handed back untouched', async () => {
    // The destination's own answer is not the stream's to overwrite.
    const stored = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'buffered answer' }] };
    const { s } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta('streamed') + TEXT_CLOSE + MSG_STOP] }], stored);
    const res = await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(res, stored);
    assert.strictEqual(extractClaudeText(res), 'buffered answer');
});

await test('the turn is FINALIZED with the assembled body, so history holds it', async () => {
    const { s, calls } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta(ANSWER) + TEXT_CLOSE + MSG_DELTA + MSG_STOP] }], ENVELOPE);
    await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(calls.finalize.length, 1, 'finalize fired ' + calls.finalize.length + ' times');
    const f = calls.finalize[0];
    assert.strictEqual(f.id, 'stamp:entropy');
    assert.strictEqual(extractClaudeText(f.data), ANSWER, 'the stored version must read back like a buffered turn');
    assert.strictEqual(f.options.method, 'POST');
    assert.ok(/api\.anthropic\.com/.test(f.options.url), 'finalize must name the url the request was sent to');
    assert.strictEqual(f.options.service, 'p1');
    assert.strictEqual(f.options.owner, 'o1');
});

await test('a failing finalize never costs the user their answer', async () => {
    const { s } = makeSession({
        clientSecretRequestFinalize: async () => { throw new Error('csr-finalize is down'); },
    }, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta(ANSWER) + TEXT_CLOSE + MSG_DELTA + MSG_STOP] }], ENVELOPE);
    const res = await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(extractClaudeText(res), ANSWER);
    await sleep(10); // let the rejected finalize settle without an unhandled rejection
});

await test('_streaming is cleared at settle and the painted text is LEFT for the typewriter', async () => {
    const { s } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta(ANSWER) + TEXT_CLOSE + MSG_DELTA + MSG_STOP] }], ENVELOPE);
    await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(s.state.messages[1]._streaming, false);
    // The bubble is never BLANKED, which is the reset this test exists to catch, and
    // it converges on the authoritative answer once the reveal finishes. Awaited
    // rather than read synchronously because the live paint types the text in now.
    assert.notStrictEqual(s.state.messages[1].content, '', 'the bubble was blanked at settle');
    await s.typewriterQueue;
    assert.strictEqual(s.state.messages[1].content, ANSWER, 'blanking it here is the reset the resume exists to avoid');
});

await test('the EARLY PROBE does not run while streaming', async () => {
    // A point lookup on a streamed row returns the same empty envelope, and winning
    // the race with it stops the poll — i.e. throws away the answer it was fetching.
    const { s, calls } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta(ANSWER) + TEXT_CLOSE + MSG_STOP] }], ENVELOPE);
    await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(calls.lookup, 0, 'the probe ladder fired on a streaming poll');
});

await test('a streaming poll runs at the streaming cadence, not the flat one', async () => {
    const { s } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + MSG_STOP] }], ENVELOPE);
    await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(src.lastArg.latency, STREAM_POLL_INTERVAL);
    assert.strictEqual(typeof src.lastArg.onStream, 'function');
});

await test('a STOPPED poll assembles nothing and finalizes nothing', async () => {
    const { s, calls } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([
        { delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta('half an ')] },
        { delay: 5000, chunks: [MSG_STOP] },
    ], ENVELOPE);
    const p = s.attachForegroundPoll(src, 'stamp:entropy');
    await sleep(60);
    p.stop();
    const res = await p;
    assert.strictEqual(res.status, 'stopped');
    assert.strictEqual(calls.finalize.length, 0, 'a stop is not a result: the turn may still be running server side');
    assert.strictEqual(s.state.messages[1]._streaming, false);
});

await test('with liveStreaming OFF nothing changes: no sink, and the probe ladder is back', async () => {
    const { s, calls } = makeSession({ liveStreaming: false }, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5000, chunks: [] }], ENVELOPE);
    const res = await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(src.lastArg.onStream, undefined, 'a host that did not opt in must send no cursor');
    assert.ok(calls.lookup > 0, 'the early probe must still run when streaming is off');
    assert.strictEqual(res.status, 'resolved');
});

await test('another chat on screen: nothing is painted, the answer is still assembled and kept', async () => {
    const { s, calls } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta(ANSWER) + TEXT_CLOSE + MSG_DELTA + MSG_STOP] }], ENVELOPE);
    const p = s.attachForegroundPoll(src, 'stamp:entropy');
    // The user moves to another project while the turn is in flight.
    s.host.getIdentity = () => ({ platform: 'claude', projectId: 'p2', owner: 'o1', userId: 'u1' });
    const res = await p;
    assert.strictEqual(s.state.messages[1].content, '', 'painted into a list that belongs to another chat');
    assert.strictEqual(extractClaudeText(res), ANSWER);
    assert.strictEqual(calls.finalize.length, 1);
});

await test('a re-attached poll replays the whole stream into a FRESH parser', async () => {
    // skapi sends `since: 0` on a new reader's first tick, so a poll attached after a
    // reload gets every chunk again. Feeding those into the old parser would
    // concatenate the answer with itself, so the entry is replaced, not reused.
    const { s } = makeSession({}, pendingTurn('stamp:entropy'));
    const whole = MSG_START + TEXT_OPEN + textDelta(ANSWER) + TEXT_CLOSE + MSG_DELTA + MSG_STOP;
    const first = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta('The sales ')] }, { delay: 5000, chunks: [] }], ENVELOPE);
    const p1 = s.attachForegroundPoll(first, 'stamp:entropy');
    await sleep(60);
    p1.stop();
    await p1;
    const second = makeSource([{ delay: 5, chunks: [whole] }], ENVELOPE);
    const res = await s.attachForegroundPoll(second, 'stamp:entropy');
    assert.strictEqual(extractClaudeText(res), ANSWER, 'the replay was fused with the first attempt');
    await s.typewriterQueue;
    assert.strictEqual(s.state.messages[1].content, ANSWER);
});

await test('the typewriter RESUMES from the painted text instead of replaying it', async () => {
    // typewriterResumeIndex on its own only proves the arithmetic. This is the wiring:
    // the reader must never watch a paragraph they already read be retyped from zero.
    const { s } = makeSession({}, [{ role: 'assistant', content: 'The sales ', _localId: 'l1' }]);
    s.state.typing = false; s.state.typingAbort = false;
    const seen = [];
    s.host.refreshMessageBubble = () => seen.push(s.state.messages[0].content);
    await s.typewriteIntoIndex(0, ANSWER, 'l1', 'The sales ');
    assert.ok(seen.length, 'the typewriter never drew');
    assert.ok(seen[0].indexOf('The sales ') === 0 && seen[0].length >= 'The sales '.length,
        `first frame went backwards: ${JSON.stringify(seen[0])}`);
    assert.strictEqual(s.state.messages[0].content, ANSWER, 'the authoritative answer must be what is left on screen');
});

await test('with nothing painted it still types from the beginning', async () => {
    const { s } = makeSession({}, [{ role: 'assistant', content: '', _localId: 'l1' }]);
    s.state.typing = false; s.state.typingAbort = false;
    const seen = [];
    s.host.refreshMessageBubble = () => seen.push(s.state.messages[0].content);
    await s.typewriteIntoIndex(0, ANSWER, 'l1');
    assert.ok(seen[0].length < ANSWER.length, 'an unstreamed reply must still reveal gradually');
    assert.strictEqual(s.state.messages[0].content, ANSWER);
});

await test('AN ABORTED SETTLE STILL LEAVES THE AUTHORITATIVE ANSWER IN THE BUBBLE', async () => {
    // The abort arm used to skip the final assignment entirely, on a premise that
    // live streaming broke. When the bubble held a PREFIX of the authoritative text,
    // stopping early merely left the reader with less of the right answer. It now
    // starts out holding what the STREAM painted - a different string: the parser's
    // untrimmed render feed, cut at a safe reveal boundary, and possibly a
    // truncation from a degraded read. Skip the write and THAT is what the turn is
    // left showing, permanently, in place of the answer that actually settled. An
    // abort is a reason to stop animating, never a reason to keep the provisional
    // text over the settled one.
    const { s } = makeSession({}, [{ role: 'assistant', content: 'The sales tabel is wr', _localId: 'l1' }]);
    s.state.typing = false; s.state.typingAbort = false;
    const p = s.typewriteIntoIndex(0, ANSWER, 'l1', 'The sales tabel is wr');
    // A first-page history load lands mid-reveal and aborts the typewriter.
    s.state.typingAbort = true;
    await p;
    assert.strictEqual(s.state.messages[0].content, ANSWER, 'the live text outlived the answer that settled');
    assert.strictEqual(s.state.typing, false);
});

await test('...but a bubble that is GONE is still never written to', async () => {
    // The localId re-find is what keeps the unconditional write safe: a numeric
    // index a concurrent mutation has repurposed would stamp this answer onto an
    // unrelated message.
    const { s } = makeSession({}, [{ role: 'assistant', content: '', _localId: 'l1' }]);
    s.state.typing = false; s.state.typingAbort = false;
    const p = s.typewriteIntoIndex(0, ANSWER, 'l1');
    s.state.messages = [{ role: 'user', content: 'a different conversation' }];
    s.state.typingAbort = true;
    await p;
    assert.strictEqual(s.state.messages.length, 1);
    assert.strictEqual(s.state.messages[0].role, 'user');
    assert.strictEqual(s.state.messages[0].content, 'a different conversation');
});

await test('a CANCELLED row keeps its envelope: the stop is not overwritten by half an answer', async () => {
    // _isCancelledPollResult downstream is what settles a stopped turn. Substituting
    // the assembled body here would hand it a provider body instead, and the turn the
    // user stopped would render the partial answer the stop was meant to discard.
    const cancelled = { id: 'stamp:entropy', status: 'cancelled', queue_name: 'u1', in_queue: 0 };
    const { s, calls } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta('half an ')] }], cancelled);
    const res = await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(res, cancelled);
    assert.strictEqual(calls.finalize.length, 0, 'a cancelled turn has nothing to keep');
});

await test('a FAILED row keeps its envelope too: the error is the authoritative account', async () => {
    const failedRow = { id: 'stamp:entropy', status: 'failed', queue_name: 'u1', in_queue: 0 };
    const { s } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta('partial')] }], failedRow);
    const res = await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(res, failedRow);
});

await test('the observation hook reports start, then updates, then end', async () => {
    const { s, calls } = makeSession({}, pendingTurn('stamp:entropy'));
    const src = makeSource([
        { delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta('one ')] },
        { delay: 300, chunks: [textDelta('two') + TEXT_CLOSE + MSG_DELTA + MSG_STOP] },
    ], ENVELOPE);
    await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.ok(calls.updates.length >= 2);
    assert.strictEqual(calls.updates[0].phase, 'start');
    assert.strictEqual(calls.updates[0].serverItemId, 'stamp:entropy');
    assert.strictEqual(calls.updates[1].phase, 'update');
    // The last word is always 'end', so a host can clear a "thinking..." row it drew,
    // and it is said exactly once even though a settle arrives twice (the poll's
    // onResponse, then the promise it resolves).
    assert.strictEqual(calls.updates[calls.updates.length - 1].phase, 'end');
    assert.strictEqual(calls.updates.filter((u) => u.phase === 'end').length, 1);
});

await test('a throwing observation hook does not cost the user the rest of the answer', async () => {
    const { s } = makeSession({ onLiveStreamUpdate: () => { throw new Error('view blew up'); } }, pendingTurn('stamp:entropy'));
    const src = makeSource([{ delay: 5, chunks: [MSG_START + TEXT_OPEN + textDelta(ANSWER) + TEXT_CLOSE + MSG_DELTA + MSG_STOP] }], ENVELOPE);
    const res = await s.attachForegroundPoll(src, 'stamp:entropy');
    assert.strictEqual(extractClaudeText(res), ANSWER);
});

const failed = results.filter(r => !r[0]);
results.forEach(r => console.log(r[0] ? 'ok    ' + r[1] : 'FAIL  ' + r[1] + '\n      ' + r[2]));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

})();
