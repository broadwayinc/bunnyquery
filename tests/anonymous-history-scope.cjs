/**
 * An anonymous visitor must not read another device's transcript.
 *
 * The backend identifies an unauthenticated caller as `ip + "(" + user_agent + ")"`
 * (client_secret_key_request/index.py). The default SURFACE history fetch sends
 * `queue_exclude` with no `queue`, which the SDK turns into the id path - scoped
 * by exactly that string. So two anonymous visitors behind one NAT, on the same
 * browser build, resolve to the same owner and see each other's chat.
 *
 * A localStorage device id cannot fix that on its own: it never enters the id
 * path. What does fix it is reading the device's OWN queue, since the chat turns
 * are dispatched under `queue: userId || service` and the device id IS that
 * userId for an anonymous visitor.
 *
 * A signed-in caller is deliberately left on the old shape: their rows are
 * already scoped by `sub`, and queue_exact would additionally hide history sent
 * under a different queue name than the current userId.
 *
 * Run: node ./tests/anonymous-history-scope.cjs
 */

const assert = require('assert');
const { getSplitChatHistory, __resetSplitHistoryState } = require('../dist/engine.cjs');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

// Captures every query the split fetch issues, and answers "empty, end of list"
// so the walk terminates immediately.
function recorder() {
    const seen = [];
    const impl = async (query) => { seen.push(query); return { list: [], endOfList: true }; };
    return { seen, impl };
}

const base = { service: 'svc-1', owner: 'own-1', platform: 'claude' };

// The surface query is the one that is NOT the bg chain.
function surfaceQueries(seen) {
    return seen.filter((q) => !(q.queue && String(q.queue).endsWith('-bg')));
}

(async () => {

await test('anonymous: the surface fetch is pinned to the device queue', async () => {
    __resetSplitHistoryState();
    const r = recorder();
    await getSplitChatHistory(
        { ...base, userId: 'anon_9f2c4d', scopeSurfaceToQueue: true }, { fetchMore: false }, r.impl,
    );
    const s = surfaceQueries(r.seen);
    assert.ok(s.length, 'no surface query was issued');
    assert.strictEqual(s[0].queue, 'anon_9f2c4d', 'surface fetch is not scoped to the device queue');
    assert.strictEqual(s[0].queue_exact, true, 'without queue_exact the name is a prefix match');
    assert.strictEqual(s[0].queue_exclude, undefined, 'the ip(UA)-scoped id path is still in use');
});

await test('signed in: the surface fetch keeps the original shape', async () => {
    __resetSplitHistoryState();
    const r = recorder();
    await getSplitChatHistory({ ...base, userId: 'user-abc' }, { fetchMore: false }, r.impl);
    const s = surfaceQueries(r.seen);
    assert.ok(s.length);
    assert.strictEqual(s[0].queue_exclude, 'user-abc-bg', 'signed-in scope changed');
    assert.strictEqual(s[0].queue, undefined, 'signed-in fetch must not narrow to one queue');
});

await test('the flag alone does nothing without a device id', async () => {
    // Falling back to queue:undefined would fetch the WHOLE project's rows.
    __resetSplitHistoryState();
    const r = recorder();
    await getSplitChatHistory({ ...base, scopeSurfaceToQueue: true }, { fetchMore: false }, r.impl);
    const s = surfaceQueries(r.seen);
    assert.ok(s.length);
    assert.strictEqual(s[0].queue, undefined);
    assert.ok('queue_exclude' in s[0], 'must fall back to the safe default');
});

await test('two devices ask for different queues', async () => {
    const q = [];
    for (const dev of ['anon_aaa', 'anon_bbb']) {
        __resetSplitHistoryState();
        const r = recorder();
        await getSplitChatHistory(
            { ...base, userId: dev, scopeSurfaceToQueue: true }, { fetchMore: false }, r.impl,
        );
        q.push(surfaceQueries(r.seen)[0].queue);
    }
    assert.notStrictEqual(q[0], q[1]);
    assert.deepStrictEqual(q, ['anon_aaa', 'anon_bbb']);
});

await test('the background chain is untouched by the scoping', async () => {
    __resetSplitHistoryState();
    const r = recorder();
    await getSplitChatHistory(
        { ...base, userId: 'anon_9f2c4d', scopeSurfaceToQueue: true }, { fetchMore: false }, r.impl,
    );
    const bg = r.seen.filter((x) => x.queue && String(x.queue).endsWith('-bg'));
    assert.ok(bg.length, 'the bg chain was not fetched');
    assert.strictEqual(bg[0].queue, 'anon_9f2c4d-bg');
    assert.strictEqual(bg[0].queue_exact, true);
});

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

})();
