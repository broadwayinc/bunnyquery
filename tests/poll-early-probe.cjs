/**
 * skapi's poll() is a bare setInterval(fn, latency) with NO check at t=0, so the earliest a reply
 * can be observed is one full POLL_INTERVAL (3s) after dispatch. A long generation does not care.
 * A short one pays almost the whole interval as dead time: a greeting the provider finishes in ~1s
 * still waits for the 3s tick, which was a large share of a measured 5s "yo" round trip.
 *
 * So foreground polls race the interval against a few early point-lookups. Background indexing
 * polls keep the flat cadence, because nobody is watching them and they are what the
 * MAX_CONCURRENT_BG_POLLS budget exists to protect.
 *
 * Run: node ./tests/poll-early-probe.cjs
 */

const assert = require('assert');
const engine = require('../dist/engine.cjs');
const { ChatSession, configureChatEngine, POLL_INTERVAL } = engine;

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

function session(lookup) {
    configureChatEngine({ csrHistoryItemLookup: lookup });
    const s = Object.create(ChatSession.prototype);
    s.host = { getIdentity: () => ({ platform: 'claude', projectId: 'p-1', owner: 'o-1' }) };
    return s;
}
// A poll that settles after `ms`, exposing .stop like skapi's does.
function fakePoll(ms, body) {
    return (opts) => {
        let t;
        const p = new Promise(r => { t = setTimeout(() => r(body), ms); });
        p.stop = () => clearTimeout(t);
        p._opts = opts;
        return p;
    };
}

(async () => {

await test('a fast reply resolves well before the 3s interval', async () => {
    const s = session(async () => ({ status: 'ok', body: 'PROBE' }));
    const t0 = Date.now();
    const res = await s.attachForegroundPoll({ poll: fakePoll(3000, { body: 'INTERVAL' }) }, 'i1');
    const dt = Date.now() - t0;
    assert.strictEqual(res.body, 'PROBE');
    assert.ok(dt < 1000, `took ${dt}ms, should beat the 3000ms interval`);
});

await test('winning the race stops the interval, so it cannot keep firing', async () => {
    const s = session(async () => ({ status: 'ok', body: 'PROBE' }));
    let stopped = false;
    const src = { poll: (o) => { const p = new Promise(() => {}); p.stop = () => { stopped = true; }; return p; } };
    await s.attachForegroundPoll(src, 'i1');
    assert.strictEqual(stopped, true);
});

await test('onResponse fires when the PROBE wins (the drain only reacts via the callback)', async () => {
    const s = session(async () => ({ status: 'ok', body: 'PROBE' }));
    let got = null;
    await s.attachForegroundPoll({ poll: fakePoll(3000, { body: 'INTERVAL' }) }, 'i1',
        { onResponse: (r) => { got = r.body; } });
    assert.strictEqual(got, 'PROBE');
});

await test('a still-running item is NOT taken as an answer', async () => {
    const s = session(async () => ({ status: 'running' }));
    const t0 = Date.now();
    const res = await s.attachForegroundPoll({ poll: fakePoll(600, { body: 'INTERVAL' }) }, 'i1');
    assert.strictEqual(res.body, 'INTERVAL', 'a running probe must not resolve the poll');
    assert.ok(Date.now() - t0 >= 550);
});

await test('a "stopped" probe result is not treated as a reply', async () => {
    const s = session(async () => ({ status: 'stopped' }));
    const res = await s.attachForegroundPoll({ poll: fakePoll(500, { body: 'INTERVAL' }) }, 'i1');
    assert.strictEqual(res.body, 'INTERVAL');
});

await test('a failing probe never breaks the poll: the interval still wins', async () => {
    const s = session(async () => { throw new Error('probe blew up'); });
    const res = await s.attachForegroundPoll({ poll: fakePoll(500, { body: 'INTERVAL' }) }, 'i1');
    assert.strictEqual(res.body, 'INTERVAL');
});

await test('with no lookup hook configured it degrades to the plain poll', async () => {
    const s = session(undefined);
    const src = { poll: fakePoll(300, { body: 'INTERVAL' }) };
    const p = s.attachForegroundPoll(src, 'i1');
    assert.strictEqual((await p).body, 'INTERVAL');
});

await test('the returned handle still carries .stop, which the cancel path needs', async () => {
    const s = session(async () => ({ status: 'running' }));
    let stopped = false;
    const src = { poll: (o) => { const p = new Promise(() => {}); p.stop = () => { stopped = true; }; return p; } };
    const handle = s.attachForegroundPoll(src, 'i1');
    assert.strictEqual(typeof handle.stop, 'function');
    handle.stop();
    assert.strictEqual(stopped, true);
});

await test('stopping cancels the pending probes too', async () => {
    let probes = 0;
    const s = session(async () => { probes++; return { status: 'ok' }; });
    const src = { poll: (o) => { const p = new Promise(() => {}); p.stop = () => {}; return p; } };
    s.attachForegroundPoll(src, 'i1').stop();
    await new Promise(r => setTimeout(r, 700));
    assert.strictEqual(probes, 0, `${probes} probes fired after stop`);
});

await test('a poll error still rejects rather than hanging', async () => {
    const s = session(async () => ({ status: 'running' }));
    const src = { poll: (o) => { const p = Promise.reject(new Error('upstream')); p.stop = () => {}; return p; } };
    await assert.rejects(() => s.attachForegroundPoll(src, 'i1'), /upstream/);
});

await test('the interval cadence itself is unchanged at 3000ms', () => {
    assert.strictEqual(POLL_INTERVAL, 3000);
});

await test('opts are forwarded to the underlying poll, not swallowed', async () => {
    const s = session(async () => ({ status: 'running' }));
    let seen = null;
    const src = { poll: (o) => { seen = o; const p = new Promise(r => setTimeout(() => r({}), 200)); p.stop = () => {}; return p; } };
    await s.attachForegroundPoll(src, 'i1', { onError: () => {} });
    assert.strictEqual(seen.latency, 3000);
    assert.strictEqual(typeof seen.onError, 'function');
});

let pass = 0;
for (const [ok, name, msg] of results) {
    console.log(ok ? `ok    ${name}` : `FAIL  ${name}\n        ${msg}`);
    if (ok) pass++;
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);

})();
