/**
 * A worker-driven chain the CHAT did not start must still be able to correct itself.
 *
 * The false green: upload from the db-files page, open the chat. buildChatDisplayList
 * marks a worker-driven group `finished = liveIndexChecked && !liveIndexKeys[key]`, so
 * ONE idle answer from the background-queue probe paints it green. The worker resolves
 * pass N before enqueueing pass N+1, so every pass boundary is a gap where a live chain
 * is invisible to that probe. The 0/2s/6s re-ask ladder exists for exactly that gap, but
 * on the passive chat-open path it is gated behind _hasLiveIndexEvidence, whose three
 * original signals are all signals of LOCAL DISPATCH:
 *   - a bgTaskQueue entry: covers only the pass THIS page sent, and is spliced out the
 *     moment it settles (a reload clears the array outright);
 *   - a recorded live key: empty in precisely the moment the probe just missed;
 *   - an attached bg poll: this chat never dispatched these passes.
 * A run begun elsewhere has none of them, the ladder returned at attempt 0, and with no
 * local pass left to settle nothing ever asked again. The row stayed green forever.
 *
 * The fourth signal is the passes themselves, bounded by recency so an idle tab whose
 * indexing finished long ago still does not climb.
 *
 * Run: node ./tests/live-index-evidence.cjs
 */

const assert = require('assert');
const { ChatSession } = require('../dist/engine.cjs');

const IDENT = { projectId: 'svc-1', owner: 'own-1', platform: 'claude', userId: 'user-abc' };

function session() {
    return new ChatSession({
        getIdentity: () => IDENT,
        buildSystemPrompt: () => '',
        notify: () => {},
        refreshMessageBubble: () => {},
        scrollToBottom: () => {},
        scrollToBottomIfSticky: () => {},
    });
}
const has = (s) => s._hasLiveIndexEvidence(IDENT.projectId);
const indexingPass = (agoMs) => ({
    role: 'user',
    content: 'Indexing: [q3.xlsx](uploads/q3.xlsx)',
    _indexFile: { name: 'q3.xlsx', path: 'uploads/q3.xlsx' },
    _ts: Date.now() - agoMs,
});

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

/* ---- the bug ------------------------------------------------------------- */

test('THE BUG: a chat with no local dispatch signals and a RECENT pass now has evidence', () => {
    const s = session();
    s.state.messages = [indexingPass(30 * 1000)];   // uploaded from the files page 30s ago
    assert.strictEqual(s.bgTaskQueue.length, 0);     // nothing this page dispatched
    assert.deepStrictEqual(s.state.liveIndexKeys, {}); // the probe just missed it
    assert.strictEqual(has(s), true);
});

test('a pass minutes old still counts (a chain outlives one pass boundary)', () => {
    const s = session();
    s.state.messages = [indexingPass(5 * 60 * 1000)];
    assert.strictEqual(has(s), true);
});

/* ---- and the gate still does its job ------------------------------------- */

test('THE REGRESSION GUARD: an OLD pass is not evidence, so an idle tab does not climb', () => {
    const s = session();
    s.state.messages = [indexingPass(2 * 60 * 60 * 1000)]; // finished two hours ago
    assert.strictEqual(has(s), false);
});

test('a chat that has never indexed anything has no evidence', () => {
    const s = session();
    s.state.messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
    assert.strictEqual(has(s), false);
});

test('an ordinary recent message is not an indexing pass', () => {
    const s = session();
    s.state.messages = [{ role: 'user', content: 'what is in q3?', _ts: Date.now() }];
    assert.strictEqual(has(s), false);
});

test('a pass with no _ts is ignored rather than counted or thrown on', () => {
    const s = session();
    s.state.messages = [{ role: 'user', _indexFile: { name: 'a.xlsx' } }]; // no _ts
    assert.strictEqual(has(s), false);
});

/* ---- THE CLOCK. _ts is a wall-clock epoch; nowMs() is performance.now(),
        milliseconds since process start. Using nowMs() for the cutoff makes it
        NEGATIVE, every epoch _ts clears it, and the gate is true for any chat
        that ever indexed anything -- the always-climb it exists to prevent.
        The old-pass test above is what fails when that regresses; this states
        the premise outright so the reason is not lost. ------------------------ */

test('the premise: performance.now() and Date.now() are different clocks', () => {
    assert.ok(performance.now() < 1e9, 'performance.now() is not an epoch');
    assert.ok(Date.now() > 1e12, 'Date.now() is an epoch');
    assert.ok(Date.now() - 10 * 60 * 1000 > 1e12, 'a wall-clock cutoff stays an epoch');
    assert.ok(performance.now() - 10 * 60 * 1000 < 0, 'a monotonic cutoff goes negative');
});

/* ---- the three original signals still short-circuit ---------------------- */

test('a bgTaskQueue entry is still evidence on its own', () => {
    const s = session();
    s.bgTaskQueue.push({ id: 'i1', projectId: IDENT.projectId, platform: 'claude' });
    assert.strictEqual(has(s), true);
});

test('a queue entry for ANOTHER project is not', () => {
    const s = session();
    s.bgTaskQueue.push({ id: 'i1', projectId: 'svc-OTHER', platform: 'claude' });
    assert.strictEqual(has(s), false);
});

test('a recorded live key is still evidence on its own', () => {
    const s = session();
    s.state.liveIndexKeys = { 'uploads/q3.xlsx': true };
    assert.strictEqual(has(s), true);
});

test('a live-keys map whose entries are all false is not evidence', () => {
    const s = session();
    s.state.liveIndexKeys = { 'uploads/q3.xlsx': false };
    assert.strictEqual(has(s), false);
});

let pass = 0;
for (const [ok, name, msg] of results) {
    console.log(ok ? `ok    ${name}` : `FAIL  ${name}\n        ${msg}`);
    if (ok) pass++;
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
