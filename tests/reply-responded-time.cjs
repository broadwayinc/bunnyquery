/**
 * The time under an answer is when skapi RECEIVED the response, not when this
 * browser found out about it.
 *
 * Why the two differ: a streamed turn's text arrives over the socket, but the
 * socket carries text and never status, so only a poll can settle the turn. While
 * the socket is delivering, the poll backs off to a heartbeat. The bubble used to
 * be stamped with this browser's clock at that settle, a few seconds after the
 * answer had finished arriving.
 *
 * And `updated` could not put it right afterwards: finalizing a streamed turn
 * stores its answer and moves `updated` to the moment of the finalize.
 *
 * So the worker now records the moment once, in a field nothing rewrites, and it
 * reaches a client two ways:
 *   - on the terminal STATUS ENVELOPE of a streamed turn, as `responded`, which
 *     the live settle stamps the bubble from;
 *   - on every history item, as `responded`, which both mappers prefer over
 *     `updated`.
 *
 * Everything here degrades to exactly what it did before when the value is not
 * there: an older backend, an older SDK, a buffered turn (whose settle hands back
 * the destination's own body and nothing of skapi's), a turn that failed with no
 * response.
 *
 * Run: node ./tests/reply-responded-time.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ChatSession, configureChatEngine, mapHistoryListToMessages, extractClaudeText } = require('../dist/engine.cjs');

const DASHBOARD_DIR = ['bunnyquery.com', 'www.bunnyquery.com']
    .map((d) => path.resolve(__dirname, '..', '..', d))
    .find((d) => fs.existsSync(d)) || path.resolve(__dirname, '..', '..', 'bunnyquery.com');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IDENT = { projectId: 'svc-1', owner: 'own-1', platform: 'claude', userId: 'user-abc' };
const ITEM = 'stamp:entropy';
const ANSWER = 'The sales table has 412 rows.';

// A time that cannot be mistaken for "now": the response came back a minute ago.
const RESPONDED = Date.now() - 60000;

/* ---- the history mapper --------------------------------------------------- */

const HISTORY_OPTS = {
    clearedAt: 0, projectId: 'svc-1', userId: 'user-abc',
    formatIndexingLabel: (name) => 'Indexing: ' + name,
};
const CHAT_ITEM = (extra) => Object.assign({
    id: 'req-1',
    status: 'resolved',
    request_body: { messages: [{ role: 'user', content: 'how many rows?' }] },
    response_body: { content: [{ type: 'text', text: ANSWER }] },
}, extra);
const mapped = (item) => mapHistoryListToMessages([item], 'claude', HISTORY_OPTS).messages;
const replyOf = (item) => mapped(item).filter((m) => m.role === 'assistant').pop();
const askOf = (item) => mapped(item).filter((m) => m.role === 'user').pop();

const SENT = 1_000_000_000_000;      // the request was made
const CAME_BACK = SENT + 9000;       // the response finished arriving 9s later
const FINALIZED = CAME_BACK + 4000;  // and the caller stored it 4s after that

function frame(obj) { return 'event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n'; }
const TRANSCRIPT =
    frame({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }) +
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } }) +
    frame({ type: 'content_block_stop', index: 0 }) +
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }) +
    frame({ type: 'message_stop' });

/** The shape csr-poll hands back for a streamed row that settled having stored nothing. */
const envelope = (extra) => Object.assign({ id: ITEM, status: 'resolved', queue_name: 'user-abc', in_queue: 0, stream: true }, extra);
const STORED_BODY = { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: ANSWER }] };

let seq = 0;
/** A poll that delivers the chunks on one tick and settles on a later one, which is
 *  what the transport does. */
function makeSource(chunks, finalResult) {
    return {
        poll(arg) {
            const p = new Promise((resolve) => {
                (async () => {
                    await sleep(5);
                    for (const c of chunks) arg.onStream && arg.onStream(c, ++seq);
                    await sleep(40);
                    if (arg.onResponse) arg.onResponse(finalResult);
                    resolve(finalResult);
                })();
            });
            p.stop = () => {};
            return p;
        },
    };
}

function session() {
    configureChatEngine({
        clientSecretRequest: async () => ({}),
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
        liveStreaming: true,
        clientSecretRequestFinalize: async () => ({ finalized: true }),
    });
    const s = new ChatSession({
        getIdentity: () => IDENT,
        buildSystemPrompt: () => '',
        notify: () => {},
        refreshMessageBubble: () => {},
        scrollToBottom: () => {},
        scrollToBottomIfSticky: () => {},
        isViewMounted: () => false,
        getClearedAt: () => 0,
        formatIndexingLabel: (name) => 'Indexing: ' + name,
    });
    s.state.messages = [
        { role: 'user', content: 'how many rows?', _serverItemId: ITEM },
        { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _serverItemId: ITEM },
    ];
    return s;
}
const answerBubble = (s) => s.state.messages.filter((m) => m.role === 'assistant' && !m.isPending).pop();
const isNow = (ts, before) => typeof ts === 'number' && ts >= before && ts <= Date.now();

(async () => {

await test('THE POINT: an answer shows when the response came back, not when it was stored', () => {
    // A streamed turn after its finalize: `updated` has moved, `responded` has not.
    const reply = replyOf(CHAT_ITEM({ created: SENT, updated: FINALIZED, responded: CAME_BACK }));
    assert.ok(reply, 'no assistant bubble was mapped');
    assert.strictEqual(reply._ts, CAME_BACK);
    assert.notStrictEqual(reply._ts, FINALIZED);
});

await test('the QUESTION still shows when it was asked', () => {
    assert.strictEqual(askOf(CHAT_ITEM({ created: SENT, updated: FINALIZED, responded: CAME_BACK }))._ts, SENT);
});

await test('no `responded` is exactly the old behaviour: `updated`', () => {
    assert.strictEqual(replyOf(CHAT_ITEM({ created: SENT, updated: FINALIZED }))._ts, FINALIZED);
});

await test('a zero, null or non-numeric `responded` is treated as absent', () => {
    for (const junk of [0, null, undefined, 'soon', NaN, -5]) {
        assert.strictEqual(replyOf(CHAT_ITEM({ created: SENT, updated: FINALIZED, responded: junk }))._ts, FINALIZED, 'responded=' + String(junk));
    }
});

await test('a FAILED turn that did get a response shows when it came back', () => {
    const reply = replyOf(CHAT_ITEM({
        status: 'failed', response_body: null, created: SENT, updated: FINALIZED, responded: CAME_BACK,
        error: { status_code: 400, body: { error: { message: 'bad request' } } },
    }));
    assert.ok(reply && reply.isError, 'no error bubble was mapped');
    assert.strictEqual(reply._ts, CAME_BACK);
});

await test("an indexing pass's duration is measured to the response, not to a later write", () => {
    const pass = mapHistoryListToMessages([{
        id: 'req-2', status: 'resolved', _isBgTask: true,
        request_body: { messages: [{ role: 'user', content: ['Index this file.', '- name: q3.xlsx', '- mime type: text/csv', '- storage path: uploads/q3.xlsx'].join('\n') }] },
        response_body: { content: [{ type: 'text', text: 'Indexed q3.xlsx.' }] },
        created: SENT, executed: SENT + 1000, updated: FINALIZED, responded: CAME_BACK,
    }], 'claude', HISTORY_OPTS).messages.filter((m) => m.role === 'assistant').pop();
    assert.strictEqual(pass._ts - pass._tsStart, 8000);
});

/* ---- the live settle of a streamed turn ----------------------------------- */

await test('a re-attached streamed turn is stamped from the envelope', async () => {
    const s = session();
    const res = await s.attachForegroundPoll(makeSource([TRANSCRIPT], envelope({ responded: RESPONDED })), ITEM);
    assert.strictEqual(extractClaudeText(res), ANSWER, 'the settle did not hand back the assembled answer');
    s.applyHistoryItemResolution(ITEM, res, 'claude');
    await s.typewriterQueue;
    const b = answerBubble(s);
    assert.ok(b, 'no settled answer bubble');
    assert.strictEqual(b._ts, RESPONDED);
    assert.strictEqual(b.content, ANSWER);
});

await test('a queued streamed turn is stamped from the envelope', async () => {
    const s = session();
    s.state.messages[0].isPendingInProcess = true;
    const res = await s.attachForegroundPoll(makeSource([TRANSCRIPT], envelope({ responded: RESPONDED })), ITEM);
    s.onQueuedSendResponse('how many rows?', res, 'claude', ITEM, s.getHistoryCacheKey());
    await s.typewriterQueue;
    const b = answerBubble(s);
    assert.ok(b, 'no settled answer bubble');
    assert.strictEqual(b._ts, RESPONDED);
});

await test('an immediately sent streamed turn is stamped from the envelope', async () => {
    const s = session();
    const key = s.getHistoryCacheKey();
    const res = await s.attachForegroundPoll(makeSource([TRANSCRIPT], envelope({ responded: RESPONDED })), ITEM);
    // What the dispatch does with a settled answer: append it to the chat's cache,
    // then let the view type it into the pending bubble.
    s.aiChatHistoryCache[key] = {
        messages: [{ role: 'user', content: 'how many rows?' }, { role: 'assistant', content: extractClaudeText(res) }],
        endOfList: false, startKeyHistory: [],
    };
    await s.typewriteLatestReply(key);
    const b = answerBubble(s);
    assert.ok(b, 'no settled answer bubble');
    assert.strictEqual(b._ts, RESPONDED);
    assert.strictEqual(b._serverItemId, ITEM);
});

await test('the time is NOT shown early: while the turn streams the bubble is still pending', async () => {
    const s = session();
    const p = s.attachForegroundPoll(makeSource([TRANSCRIPT], envelope({ responded: RESPONDED })), ITEM);
    await sleep(20); // the chunks have painted, the settle has not arrived
    assert.strictEqual(s.state.messages[1].isPending, true);
    assert.notStrictEqual(s.state.messages[1]._ts, RESPONDED, 'the response time cannot be known before the settle');
    await p;
});

/* ---- everything that does not carry the value keeps the old stamp ---------- */

await test('an envelope WITHOUT `responded` (an older backend) stamps the clock, as before', async () => {
    const s = session();
    const before = Date.now();
    const res = await s.attachForegroundPoll(makeSource([TRANSCRIPT], envelope()), ITEM);
    s.applyHistoryItemResolution(ITEM, res, 'claude');
    await s.typewriterQueue;
    assert.ok(isNow(answerBubble(s)._ts, before), 'expected a browser-clock stamp, got ' + answerBubble(s)._ts);
});

await test('a BUFFERED turn (the settle is the body itself) stamps the clock, as before', async () => {
    const s = session();
    const before = Date.now();
    const res = await s.attachForegroundPoll(makeSource([], STORED_BODY), ITEM);
    assert.strictEqual(res, STORED_BODY);
    s.applyHistoryItemResolution(ITEM, res, 'claude');
    await s.typewriterQueue;
    assert.ok(isNow(answerBubble(s)._ts, before));
});

await test('a body that merely CONTAINS a `responded` key is not mistaken for the envelope', async () => {
    // A stored body is the destination's own content and may carry any key at all.
    const s = session();
    const before = Date.now();
    const body = Object.assign({}, STORED_BODY, { responded: RESPONDED });
    const res = await s.attachForegroundPoll(makeSource([], body), ITEM);
    s.applyHistoryItemResolution(ITEM, res, 'claude');
    await s.typewriterQueue;
    assert.ok(isNow(answerBubble(s)._ts, before));
});

await test('a junk `responded` on the envelope is ignored', async () => {
    for (const junk of [0, null, 'soon', -1]) {
        const s = session();
        const before = Date.now();
        const res = await s.attachForegroundPoll(makeSource([TRANSCRIPT], envelope({ responded: junk })), ITEM);
        s.applyHistoryItemResolution(ITEM, res, 'claude');
        await s.typewriterQueue;
        assert.ok(isNow(answerBubble(s)._ts, before), 'responded=' + String(junk));
    }
});

await test("one turn's time never lands on another turn's bubble", async () => {
    const s = session();
    const before = Date.now();
    await s.attachForegroundPoll(makeSource([TRANSCRIPT], envelope({ responded: RESPONDED })), ITEM);
    // A different turn settles with nothing known about it.
    s.state.messages = [
        { role: 'user', content: 'and columns?', _serverItemId: 'other:item' },
        { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _serverItemId: 'other:item' },
    ];
    s.applyHistoryItemResolution('other:item', STORED_BODY, 'claude');
    await s.typewriterQueue;
    assert.ok(isNow(answerBubble(s)._ts, before));
});

await test('a session built without its constructor still stamps (no table, no throw)', () => {
    const s = Object.create(ChatSession.prototype);
    s.state = { messages: [{ role: 'assistant', content: '', _serverItemId: ITEM }] };
    s.host = { notify: () => {}, refreshMessageBubble: () => {}, scrollToBottomIfSticky: () => {}, isViewMounted: () => false };
    const before = Date.now();
    s.insertAtTarget({ role: 'assistant', content: 'x', _serverItemId: ITEM }, -1);
    assert.ok(isNow(s.state.messages[1]._ts, before));
});

/* ---- the dashboard's forked mapper stays in step --------------------------- */

const AGENT = path.join(DASHBOARD_DIR, 'src/views/service/agent.vue');
if (!fs.existsSync(AGENT)) {
    results.push([true, "agent.vue's forked mapper prefers `responded` too (SKIPPED: bunnyquery.com is not checked out beside this package)"]);
} else {
    await test("agent.vue's forked mapper prefers `responded` too", () => {
        const src = fs.readFileSync(AGENT, 'utf8');
        assert.ok(/const respondedTs = Number\(\(item as any\)\?\.responded\)/.test(src), "agent.vue's mapper must read `responded` off the history item");
        assert.ok(/const replyTs = isFinite\(respondedTs\) && respondedTs > 0 \? respondedTs/.test(src), "agent.vue's reply time must prefer `responded`");
    });
}

let failed = 0;
for (const r of results) {
    if (r[0]) console.log('ok    ' + r[1]);
    else { failed++; console.log('FAIL  ' + r[1] + '\n      ' + r[2]); }
}
console.log((results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

})();
