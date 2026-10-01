/**
 * Stop waiting for a reply and move on.
 *
 * The user sends a question, the "Thinking" dots come up, and the answer is slow.
 * Until now the only ways out were to wait, or to send the next message and have
 * it QUEUE behind the slow one on the server. cancelPendingReply is the third:
 * cancel the running request, settle the question as cancelled, promote whatever
 * was queued behind it, and free the composer for an ordinary send.
 *
 * Two engine defects sat underneath, and both are pinned here because either one
 * would have made the button a trap:
 *
 *   1. Stopping a foreground poll never settled it. The early-probe wrapper marked
 *      itself settled inside stop() and then ignored the base poll's stopped result,
 *      so the promise hung. An immediate send awaits that promise to clear
 *      state.sending, so a cancel would have wedged every later send onto the
 *      queued path, permanently.
 *   2. A stopped or cancelled poll result was read as an ANSWER. It extracts to
 *      nothing, so the turn was stamped "No text response received from AI
 *      provider." and the cache kept that as the reply; and typewriteLatestReply
 *      then typed the PREVIOUS turn's answer into whichever placeholder was on
 *      screen, which after a cancel is the next turn's.
 *
 * Run: node ./tests/cancel-pending-reply.cjs
 */

const assert = require('assert');
const { ChatSession, configureChatEngine } = require('../dist/engine.cjs');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && (err.stack || err.message)]); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n) { for (let i = 0; i < (n || 8); i++) await tick(); }
function withTimeout(p, ms, label) {
    return Promise.race([p, new Promise((r) => setTimeout(() => r(label || 'TIMEOUT'), ms))]);
}

const NO_TEXT = 'No text response received from AI provider.';
const CANCELLED_ENVELOPE = (id) => ({ id, status: 'cancelled', queue_name: 'u1', in_queue: 0 });

/** A poll like skapi-js's: a promise carrying .stop, which resolves it with the
 *  stopped shape. `unstoppable` models an older SDK with no handle at all. */
function makePoll(id, opts) {
    opts = opts || {};
    let resolveP, rejectP;
    const p = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
    const src = {
        stopped: false,
        poll: () => p,
        resolve: (v) => resolveP(v),
        reject: (e) => rejectP(e),
    };
    if (!opts.unstoppable) p.stop = () => { src.stopped = true; resolveP({ id, status: 'stopped' }); };
    return src;
}

function makeHost(overrides) {
    const calls = { cancel: [], notify: 0 };
    const host = Object.assign({
        getIdentity: () => ({ platform: 'claude', projectId: 'p1', owner: 'o1', userId: 'u1', model: 'claude-sonnet-4-5' }),
        notify: () => { calls.notify++; },
        refreshMessageBubble: () => { },
        scrollToBottom: () => { },
        scrollToBottomIfSticky: () => { },
        buildSystemPrompt: () => 'system',
        isViewMounted: () => true,
        refreshSession: async () => true,
        cancelRequest: async (o) => { calls.cancel.push(o); return { removed: true }; },
        getClearedAt: () => 0,
        formatIndexingLabel: (n) => n,
    }, overrides || {});
    return { host, calls };
}

/** A session whose transport acks each send with a fresh running item and a poll
 *  we hold the reins of. Probes are configured so the early-probe wrapper (the
 *  code under test in defect 1) is on the path. */
function makeSession(hostOverrides, pollOpts) {
    const polls = [];
    let seq = 0;
    configureChatEngine({
        clientSecretRequest: async () => {
            seq++;
            const src = makePoll('srv-' + seq, pollOpts);
            polls.push(src);
            return { id: 'srv-' + seq, status: 'running', queue_name: 'u1', in_queue: 1, poll: src.poll };
        },
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
        csrHistoryItemLookup: async () => ({ status: 'running' }),
        liveStreaming: false,
    });
    const { host, calls } = makeHost(hostOverrides);
    const s = new ChatSession(host);
    return { s, host, calls, polls };
}

const pendingOf = (list, id) => list.filter((m) => m.role === 'assistant' && m.isPending && (!id || m._serverItemId === id));
const noTextReplies = (list) => list.filter((m) => m.role === 'assistant' && m.content === NO_TEXT);

(async () => {

/* ---- defect 1: a stopped foreground poll settles ------------------------ */

await test('stopping the early-probe wrapper SETTLES it with the stopped shape', async () => {
    configureChatEngine({ csrHistoryItemLookup: async () => ({ status: 'running' }) });
    const s = new ChatSession(makeHost().host);
    const src = makePoll('i1');
    const handle = s.attachForegroundPoll({ poll: src.poll }, 'i1');
    assert.strictEqual(typeof handle.stop, 'function');
    handle.stop();
    const res = await withTimeout(handle, 500, 'HUNG');
    assert.notStrictEqual(res, 'HUNG', 'the wrapper never resolved after stop()');
    assert.strictEqual(res.status, 'stopped');
    assert.strictEqual(src.stopped, true, 'the base poll was not stopped');
});

await test('and settles even when the SDK poll has no stop handle at all', async () => {
    configureChatEngine({ csrHistoryItemLookup: async () => ({ status: 'running' }) });
    const s = new ChatSession(makeHost().host);
    const src = makePoll('i1', { unstoppable: true });
    const handle = s.attachForegroundPoll({ poll: src.poll }, 'i1');
    handle.stop();
    const res = await withTimeout(handle, 500, 'HUNG');
    assert.strictEqual(res && res.status, 'stopped');
});

/* ---- the feature, end to end on the immediate-send path ----------------- */

await test('cancelPendingReply: cancels on the server, settles the turn, frees the composer', async () => {
    const { s, calls, polls } = makeSession();
    const key = s.getHistoryCacheKey();
    // An older answered turn on screen and in the cache: the exact bait for
    // typewriteLatestReply after a cancel (defect 2).
    const older = [{ role: 'user', content: 'old q', _serverItemId: 'srv-0' }, { role: 'assistant', content: 'OLD ANSWER', _serverItemId: 'srv-0' }];
    s.state.messages = older.slice();
    s.aiChatHistoryCache[key] = { messages: older.slice(), endOfList: true, startKeyHistory: [] };

    s.dispatchComposedMessage('slow question', false);
    await settle();
    assert.strictEqual(s.state.sending, true);
    assert.strictEqual(polls.length, 1);
    const ph = s.state.messages.find((m) => m.role === 'assistant' && m.isPending);
    assert.ok(ph, 'no Thinking placeholder');
    assert.strictEqual(ph._serverItemId, 'srv-1', 'the ack did not stamp the placeholder');
    assert.ok(s.historyItemPolls.has('srv-1'), 'the dispatch poll is not tracked');
    assert.ok(s.pendingAgentRequests[key], 'no in-flight record');

    // Something queued behind it, so there is a "next one" to move on to.
    s.dispatchComposedMessage('next question', false);
    await settle();
    assert.strictEqual(polls.length, 2);
    const queued = s.state.messages.find((m) => m.role === 'user' && m.isPendingQueued);
    assert.ok(queued, 'second send did not queue');
    assert.strictEqual(queued._serverItemId, 'srv-2');

    s.cancelPendingReply(ph, s.state.messages.indexOf(ph));
    await settle(12);

    // 1. the server was asked, on the chat queue, for exactly this item
    assert.strictEqual(calls.cancel.length, 1);
    assert.strictEqual(calls.cancel[0].id, 'srv-1');
    assert.strictEqual(calls.cancel[0].queue, 'u1');
    assert.strictEqual(calls.cancel[0].method, 'POST');
    // 2. its poll was stopped and forgotten; the queued turn's is untouched
    assert.strictEqual(polls[0].stopped, true);
    assert.strictEqual(polls[1].stopped, false);
    assert.strictEqual(s.historyItemPolls.has('srv-1'), false);
    assert.strictEqual(s.historyItemPolls.has('srv-2'), true);
    // 3. the question reads as cancelled, its Thinking is gone
    const u = s.state.messages.find((m) => m._serverItemId === 'srv-1' && m.role === 'user');
    assert.strictEqual(u.isCancelled, true);
    assert.strictEqual(u.content, 'slow question');
    assert.strictEqual(pendingOf(s.state.messages, 'srv-1').length, 0);
    // 4. the next turn moved on: promoted, with a Thinking of its own
    const nextU = s.state.messages.find((m) => m._serverItemId === 'srv-2' && m.role === 'user');
    assert.strictEqual(nextU.isPendingInProcess, true);
    assert.strictEqual(nextU.isPendingQueued, undefined);
    const nextPh = pendingOf(s.state.messages, 'srv-2');
    assert.strictEqual(nextPh.length, 1);
    assert.strictEqual(s.state.messages.indexOf(nextPh[0]), s.state.messages.indexOf(nextU) + 1);
    // 5. the composer is free: the immediate chain settled and released its holds
    assert.strictEqual(s.state.sending, false, 'sending stayed set: the next send would queue');
    assert.strictEqual(s.pendingAgentRequests[key], undefined);
    // 6. no fake answer anywhere, and the OLD answer was not typed into the new turn
    assert.strictEqual(noTextReplies(s.state.messages).length, 0);
    assert.strictEqual(noTextReplies(s.aiChatHistoryCache[key].messages).length, 0);
    assert.strictEqual(nextPh[0].content, '', 'the previous answer was painted into the next turn');
    assert.strictEqual(s.state.messages.filter((m) => m.content === 'OLD ANSWER').length, 1);
    const cachedU = s.aiChatHistoryCache[key].messages.find((m) => m._serverItemId === 'srv-1' && m.role === 'user');
    assert.strictEqual(cachedU && cachedU.isCancelled, true, 'the cache still shows the turn live');
    assert.strictEqual(pendingOf(s.aiChatHistoryCache[key].messages, 'srv-1').length, 0);
    // 7. a further send now goes out at once, not behind anything
    s.dispatchComposedMessage('third', false);
    await settle();
    const third = s.state.messages.find((m) => m.content === 'third');
    assert.ok(third);
    // it queued behind srv-2 (correct: that one IS running), and not as a hung immediate
    assert.strictEqual(third.isPendingQueued, true);
    // tidy: stop what is still polling so the process can exit
    s.historyItemPolls.forEach((h) => h.stop && h.stop());
    await settle();
});

await test('the control is disabled semantics: no id, wrong bubble, indexing pass -> no request', async () => {
    const { s, calls } = makeSession();
    s.state.messages = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', isPending: true, isPendingInProcess: true },
    ];
    s.cancelPendingReply(s.state.messages[1], 1);           // no _serverItemId yet
    s.cancelPendingReply({ role: 'user', content: 'q', _serverItemId: 'x', isPendingInProcess: true }, 0); // the user bubble
    s.cancelPendingReply({ role: 'assistant', content: '', isPending: true, isBackgroundTask: true, _serverItemId: 'y' }, 1); // an indexing pass
    await settle();
    assert.strictEqual(calls.cancel.length, 0);
    assert.strictEqual(s.state.messages[1].isPending, true);
});

await test('"already processed": nothing is unwound, the reply is still on its way', async () => {
    const { s, polls } = makeSession({
        cancelRequest: async () => ({ removed: false, message: 'The request has already been processed.' }),
    });
    s.dispatchComposedMessage('q', false);
    await settle();
    const ph = s.state.messages.find((m) => m.role === 'assistant' && m.isPending);
    s.cancelPendingReply(ph, 1);
    assert.strictEqual(s.state.messages[1]._cancelling, true, 'no immediate feedback');
    await settle();
    const after = s.state.messages[1];
    assert.strictEqual(after.isPending, true);
    assert.strictEqual(after._cancelling, false);
    assert.strictEqual(after._cancelError, undefined, 'a late answer is not an error');
    assert.strictEqual(polls[0].stopped, false, 'the poll must keep running: the answer is coming');
    assert.strictEqual(s.state.sending, true);
    assert.strictEqual(s.state.messages[0].isCancelled, undefined);
    s.historyItemPolls.forEach((h) => h.stop && h.stop());
    await settle();
});

await test('a failed cancel request is reported on the bubble and changes nothing else', async () => {
    const { s, polls } = makeSession({ cancelRequest: async () => { throw new Error('network down'); } });
    s.dispatchComposedMessage('q', false);
    await settle();
    const ph = s.state.messages.find((m) => m.role === 'assistant' && m.isPending);
    s.cancelPendingReply(ph, 1);
    await settle();
    const after = s.state.messages[1];
    assert.strictEqual(after.isPending, true);
    assert.strictEqual(after._cancelling, false);
    assert.strictEqual(after._cancelError, 'network down');
    assert.strictEqual(polls[0].stopped, false);
    assert.strictEqual(s.state.messages[0].isCancelled, undefined);
    s.historyItemPolls.forEach((h) => h.stop && h.stop());
    await settle();
});

/* ---- defect 2 on every resolution path ---------------------------------- */

await test('immediate send: a row cancelled elsewhere (unstoppable poll) settles as cancelled, never as an empty answer', async () => {
    const { s, polls } = makeSession(undefined, { unstoppable: true });
    const key = s.getHistoryCacheKey();
    s.dispatchComposedMessage('q', false);
    await settle();
    assert.strictEqual(s.state.sending, true);
    polls[0].resolve(CANCELLED_ENVELOPE('srv-1'));
    await settle(12);
    assert.strictEqual(s.state.sending, false);
    assert.strictEqual(s.pendingAgentRequests[key], undefined);
    assert.strictEqual(s.state.messages[0].isCancelled, true);
    assert.strictEqual(pendingOf(s.state.messages).length, 0);
    assert.strictEqual(noTextReplies(s.state.messages).length, 0);
    assert.strictEqual(noTextReplies(s.aiChatHistoryCache[key].messages).length, 0);
    assert.strictEqual(pendingOf(s.aiChatHistoryCache[key].messages).length, 0);
});

await test('queued send: a cancelled envelope settles the turn and promotes the next one', async () => {
    const { s } = makeSession();
    const key = s.getHistoryCacheKey();
    s.state.messages = [
        { role: 'user', content: 'a', isPendingInProcess: true, _serverItemId: 'A', _ownerKey: key },
        { role: 'assistant', content: '', isPending: true, _serverItemId: 'A', _ownerKey: key },
        { role: 'user', content: 'b', isPendingQueued: true, _serverItemId: 'B', _ownerKey: key },
    ];
    s.onQueuedSendResponse('a', CANCELLED_ENVELOPE('A'), 'claude', 'A', key);
    assert.strictEqual(s.state.messages[0].isCancelled, true);
    assert.strictEqual(pendingOf(s.state.messages, 'A').length, 0);
    assert.strictEqual(noTextReplies(s.state.messages).length, 0);
    const b = s.state.messages.find((m) => m._serverItemId === 'B' && m.role === 'user');
    assert.strictEqual(b.isPendingInProcess, true);
    assert.strictEqual(pendingOf(s.state.messages, 'B').length, 1);
});

await test('off-chat: a cancelled envelope edits THAT chat\'s cache and leaves the screen alone', async () => {
    const { s } = makeSession();
    const other = 'p2#claude#u1';
    // The shape an off-chat send caches before its ack: no ids on either bubble.
    s.aiChatHistoryCache[other] = {
        messages: [
            { role: 'user', content: 'q', isPendingInProcess: true, isSendingToServer: true, _ownerKey: other },
            { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _ownerKey: other },
        ],
        endOfList: true, startKeyHistory: [],
    };
    const onScreen = [{ role: 'user', content: 'mine' }, { role: 'assistant', content: 'here' }];
    s.state.messages = onScreen.slice();
    s.onQueuedSendResponse('q', CANCELLED_ENVELOPE('X'), 'claude', 'X', other);
    const cached = s.aiChatHistoryCache[other].messages;
    assert.strictEqual(cached.length, 1);
    assert.strictEqual(cached[0].isCancelled, true);
    assert.strictEqual(cached[0]._serverItemId, 'X');
    assert.strictEqual(cached[0]._ownerKey, other);
    assert.deepStrictEqual(s.state.messages, onScreen);
});

await test('settling twice is harmless: the second pass does not take the promoted turn\'s Thinking', async () => {
    const { s } = makeSession();
    const key = s.getHistoryCacheKey();
    s.state.messages = [
        { role: 'user', content: 'a', _serverItemId: 'A', _ownerKey: key },
        { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _serverItemId: 'A', _ownerKey: key },
        { role: 'user', content: 'b', isPendingQueued: true, _serverItemId: 'B', _ownerKey: key },
    ];
    s._settleCancelledTurn('A', key);
    const snapshot = JSON.stringify(s.state.messages);
    assert.strictEqual(pendingOf(s.state.messages, 'B').length, 1);
    s._settleCancelledTurn('A', key);
    assert.strictEqual(JSON.stringify(s.state.messages), snapshot);
    assert.strictEqual(pendingOf(s.state.messages, 'B').length, 1);
});

/* ---- the two clients carry the same control ----------------------------- */

await test('both chatboxes draw the control on the pending bubble and hand it to the engine', () => {
    const fs = require('fs');
    const path = require('path');
    const widget = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
    assert.ok(/bq-cancel-wait-btn/.test(widget), 'widget has no stop-waiting control');
    assert.ok(/session\.cancelPendingReply\(/.test(widget), 'widget does not delegate to the engine');
    assert.ok(/Stop waiting for this reply/.test(widget));
    const agentPath = ['bunnyquery.com', 'www.bunnyquery.com']
        .map((d) => path.resolve(__dirname, '..', '..', d, 'src/views/service/agent.vue'))
        .find((f) => fs.existsSync(f));
    if (!agentPath) { results.push([true, '  (agent.vue not checked out beside this package: dashboard half skipped)']); return; }
    const agent = fs.readFileSync(agentPath, 'utf8');
    assert.ok(/bq-cancel-wait-btn/.test(agent), 'agent.vue has no stop-waiting control');
    assert.ok(/chatSession\.cancelPendingReply\(/.test(agent), 'agent.vue does not delegate to the engine');
    assert.ok(/Stop waiting for this reply/.test(agent));
    // Same gate on both: a chat turn's own placeholder, never an indexing pass or a
    // recovery read, disabled until the ack has stamped the id.
    for (const [src, name] of [[widget, 'widget'], [agent, 'agent.vue']]) {
        const flat = src.replace(/row\./g, '').replace(/\s+/g, '');
        assert.ok(flat.includes('msg.role==="assistant"&&!msg.isBackgroundTask&&!streamRecoveryPhase(msg)') ||
                  flat.includes("msg.role==='assistant'&&!msg.isBackgroundTask&&!streamRecoveryPhase(msg)"), name + ': gate differs');
        assert.ok(flat.includes('!msg._serverItemId||msg._cancelling'), name + ': disabled rule differs');
    }
});

/* ---- report ------------------------------------------------------------ */
let failed = 0;
for (const [ok, name, detail] of results) {
    if (ok) console.log('  ok  ' + name);
    else { failed++; console.log('FAIL  ' + name + '\n      ' + String(detail).split('\n').slice(0, 6).join('\n      ')); }
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
})();
