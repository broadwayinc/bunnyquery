/**
 * claimIndexRun looks the queue up instead of scanning it (reliability plan 6.4).
 *
 * hasLiveIndexRun used to walk bgTaskQueue on every call, comparing storage
 * path, project and platform per entry. A Files-page batch claims once per file
 * and the queue holds one entry per file already dispatched, so a 3,000-file
 * batch did about 4.5 million comparisons in claims alone. The queue is now
 * indexed by the same scoped path the claims use (indexScopeKey + '|' + path),
 * and the index is rebuilt only when the array changes.
 *
 * The engine does not own every write to that array: the dashboard hands in a
 * Vue reactive array it pushes to from the Files page and splices from its
 * fallback poller, the widget hands in its own, and tests push directly. So the
 * index is derived from the array and refreshed off a stamp (array identity,
 * length, first entry, last entry). What this pins:
 *
 *   1. the answers equal the old scan's, for hand-written cases and for
 *      thousands of random push/splice sequences with lookups in between;
 *   2. a host-owned array (assigned after construction, or a Proxy like Vue's)
 *      is followed;
 *   3. claimIndexRun's contract is unchanged: a claim refuses a second claim,
 *      releaseIndexRun hands the slot back, a queued entry refuses a claim;
 *   4. the index is rebuilt once per CHANGE of the queue, never once per claim,
 *      so a batch of 3,000 claims over a 3,000-entry queue stays flat.
 *
 * Run: node ./tests/claim-index-run-map.cjs
 */

const assert = require('assert');
const { ChatSession, indexScopeKey } = require('../dist/engine.cjs');

const IDENT = { projectId: 'svc-1', owner: 'own-1', platform: 'claude', userId: 'user-abc' };

function session(ident) {
    const id = ident || Object.assign({}, IDENT);
    const s = new ChatSession({
        getIdentity: () => id,
        buildSystemPrompt: () => '',
        notify: () => {},
        refreshMessageBubble: () => {},
        scrollToBottom: () => {},
        scrollToBottomIfSticky: () => {},
    });
    // The queue probe needs a transport; the claim's own bookkeeping does not.
    s._refreshLiveIndexKeys = () => Promise.resolve();
    return { s, id };
}

let seq = 0;
const entry = (storagePath, projectId, platform) => ({
    projectId: projectId || IDENT.projectId,
    platform: platform || IDENT.platform,
    id: 'item-' + (++seq),
    filename: storagePath ? storagePath.split('/').pop() : 'x',
    storagePath,
    status: 'pending',
    poll: undefined,
});

/** The scan this replaces, verbatim in meaning. */
function scanLive(s, id, storagePath) {
    for (let i = 0; i < s.bgTaskQueue.length; i++) {
        const e = s.bgTaskQueue[i];
        if (e && e.storagePath === storagePath && e.projectId === id.projectId && e.platform === id.platform) return true;
    }
    return false;
}

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.stack || err && err.message]); }
}

/* ---- 1. same answers as the scan ---------------------------------------------- */

test('an empty queue: nothing is live', () => {
    const { s } = session();
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), false);
    assert.strictEqual(s.hasLiveIndexRun(undefined), false);
});

test('a host-style push (the Files page) is seen; another project, another platform or no path is not', () => {
    const { s, id } = session();
    s.bgTaskQueue.push(entry('docs/a.pdf'));
    s.bgTaskQueue.push(entry('docs/b.pdf', 'svc-OTHER'));
    s.bgTaskQueue.push(entry('docs/c.pdf', IDENT.projectId, 'openai'));
    s.bgTaskQueue.push(entry(undefined));
    assert.strictEqual(s.hasLiveIndexRun('docs/a.pdf'), true);
    assert.strictEqual(s.hasLiveIndexRun('docs/b.pdf'), false);
    assert.strictEqual(s.hasLiveIndexRun('docs/c.pdf'), false);
    for (const p of ['docs/a.pdf', 'docs/b.pdf', 'docs/c.pdf', 'x']) {
        assert.strictEqual(s.hasLiveIndexRun(p), scanLive(s, id, p), p);
    }
});

test('a splice is seen at once (the length changed)', () => {
    const { s } = session();
    s.bgTaskQueue.push(entry('a.pdf'));
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), true);
    s.bgTaskQueue.splice(0, 1);
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), false);
});

test('same-length sequences between two lookups are seen (the last entry changed)', () => {
    const { s, id } = session();
    const a = entry('a.pdf'), b = entry('b.pdf');
    s.bgTaskQueue.push(a, b);
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), true);
    // settle a, dispatch c: length 2 before and after
    s.bgTaskQueue.splice(s.bgTaskQueue.indexOf(a), 1);
    s.bgTaskQueue.push(entry('c.pdf'));
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), false);
    assert.strictEqual(s.hasLiveIndexRun('b.pdf'), true);
    assert.strictEqual(s.hasLiveIndexRun('c.pdf'), true);
    // settle the LAST entry and dispatch another: length 2, last changed
    s.bgTaskQueue.splice(1, 1);
    s.bgTaskQueue.push(entry('d.pdf'));
    assert.strictEqual(s.hasLiveIndexRun('c.pdf'), false);
    assert.strictEqual(s.hasLiveIndexRun('d.pdf'), true);
    // two entries for one file (a pass and its continuation): one settles, still live
    s.bgTaskQueue.push(entry('d.pdf'));
    s.bgTaskQueue.splice(s.bgTaskQueue.length - 2, 1);
    assert.strictEqual(s.hasLiveIndexRun('d.pdf'), true);
    for (const p of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']) assert.strictEqual(s.hasLiveIndexRun(p), scanLive(s, id, p), p);
});

test('the identity switching projects (one session serves every project) is honoured', () => {
    const { s, id } = session();
    s.bgTaskQueue.push(entry('a.pdf', 'svc-1'));
    s.bgTaskQueue.push(entry('a.pdf', 'svc-2', 'openai'));
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), true);
    id.projectId = 'svc-2';
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), false, 'svc-2 on claude has no entry');
    id.platform = 'openai';
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), true);
    id.projectId = 'svc-3';
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), false);
});

test('RANDOMISED: thousands of push/splice sequences, lookups in between, never a different answer than the scan', () => {
    let rnd = 12345;
    const rand = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const projects = ['svc-1', 'svc-2'];
    const platforms = ['claude', 'openai'];
    const paths = [];
    for (let i = 0; i < 40; i++) paths.push('dir' + (i % 5) + '/file' + i + '.pdf');
    const { s, id } = session();
    let lookups = 0;
    for (let round = 0; round < 3000; round++) {
        // 1 to 6 writes with NO lookup in between: the stamp has to catch the net change.
        const writes = 1 + Math.floor(rand() * 6);
        for (let w = 0; w < writes; w++) {
            if (s.bgTaskQueue.length && rand() < 0.5) {
                s.bgTaskQueue.splice(Math.floor(rand() * s.bgTaskQueue.length), 1);
            } else {
                s.bgTaskQueue.push(entry(pick(paths), pick(projects), pick(platforms)));
            }
        }
        id.projectId = pick(projects);
        id.platform = pick(platforms);
        for (let k = 0; k < 5; k++) {
            const p = pick(paths);
            lookups++;
            assert.strictEqual(s.hasLiveIndexRun(p), scanLive(s, id, p),
                'round ' + round + ' path ' + p + ' ' + id.projectId + '/' + id.platform + ' queue ' + s.bgTaskQueue.length);
        }
    }
    assert.ok(lookups >= 15000);
});

/* ---- 2. host-owned arrays --------------------------------------------------- */

test('an array assigned after construction (both hosts do this) is the one indexed', () => {
    const { s } = session();
    s.bgTaskQueue.push(entry('old.pdf'));
    assert.strictEqual(s.hasLiveIndexRun('old.pdf'), true);
    const hostArray = [entry('new.pdf')];
    s.bgTaskQueue = hostArray;
    assert.strictEqual(s.hasLiveIndexRun('old.pdf'), false);
    assert.strictEqual(s.hasLiveIndexRun('new.pdf'), true);
    hostArray.push(entry('later.pdf'));
    assert.strictEqual(s.hasLiveIndexRun('later.pdf'), true);
});

test('a Proxy over the array (what a Vue reactive array is) works, element identity preserved', () => {
    const { s } = session();
    const raw = [];
    const proxied = new Proxy(raw, {
        get(target, key, receiver) { return Reflect.get(target, key, receiver); },
    });
    s.bgTaskQueue = proxied;
    proxied.push(entry('a.pdf'));
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), true);
    proxied.splice(0, 1);
    assert.strictEqual(s.hasLiveIndexRun('a.pdf'), false);
    proxied.push(entry('b.pdf'), entry('c.pdf'));
    proxied.splice(0, 1);
    proxied.push(entry('d.pdf'));
    assert.strictEqual(s.hasLiveIndexRun('b.pdf'), false);
    assert.strictEqual(s.hasLiveIndexRun('c.pdf'), true);
    assert.strictEqual(s.hasLiveIndexRun('d.pdf'), true);
});

/* ---- 3. the claim contract --------------------------------------------------- */

test('claimIndexRun: first claim wins, the second is refused, release hands the slot back, a queued entry refuses', async () => {
    const { s } = session();
    assert.strictEqual(await s.claimIndexRun('a.pdf'), true);
    assert.strictEqual(await s.claimIndexRun('a.pdf'), false, 'claimed by this client already');
    s.releaseIndexRun('a.pdf');
    assert.strictEqual(await s.claimIndexRun('a.pdf'), true);
    s.bgTaskQueue.push(entry('b.pdf'));
    assert.strictEqual(await s.claimIndexRun('b.pdf'), false, 'the queue has it');
    assert.strictEqual(await s.claimIndexRun(undefined), true, 'no path: nothing to claim, caller proceeds');
    // the queue entry for another project does not block this project's claim
    s.bgTaskQueue.push(entry('c.pdf', 'svc-OTHER'));
    assert.strictEqual(await s.claimIndexRun('c.pdf'), true);
});

test('a pending indexing bubble in the messages still counts (that scan is unchanged)', () => {
    const { s } = session();
    s.state.messages = [{
        role: 'user', isBackgroundTask: true, isPendingQueued: true,
        _indexFile: { name: 'q.xlsx', path: 'uploads/q.xlsx' },
    }];
    assert.strictEqual(s.hasLiveIndexRun('uploads/q.xlsx'), true);
    assert.strictEqual(s.hasLiveIndexRun('uploads/other.xlsx'), false);
});

/* ---- 4. flat over a batch ----------------------------------------------------- */

test('a 3,000-file batch: the index is built once per queue change, never once per claim', async () => {
    const { s } = session();
    const N = 3000;
    const t0 = Date.now();
    // The batch as the Files page runs it: claim, dispatch, push the ack's entry.
    for (let i = 0; i < N; i++) {
        const p = 'batch/file' + i + '.txt';
        assert.strictEqual(await s.claimIndexRun(p), true);
        s.bgTaskQueue.push(entry(p));
    }
    // One look after the last push, so the index has seen the batch's final
    // state. A path this client never claimed, or the claim map answers first.
    assert.strictEqual(s.hasLiveIndexRun('never/claimed.txt'), false);
    const afterBatch = s._bgQueueIndexRebuilds;
    assert.ok(afterBatch <= N + 1, 'rebuilds over the batch: ' + afterBatch);
    // The queue is quiet: 3,000 more claims cost no rebuild at all.
    for (let i = 0; i < N; i++) await s.claimIndexRun('second/file' + i + '.txt');
    assert.strictEqual(s._bgQueueIndexRebuilds, afterBatch, 'no change to the queue, no rebuild');
    // Every file of the batch is still seen as live, through the index: release
    // the claims first, so the queue entry is the only thing that can answer.
    for (let i = 0; i < N; i += 97) {
        s.releaseIndexRun('batch/file' + i + '.txt');
        assert.strictEqual(s.hasLiveIndexRun('batch/file' + i + '.txt'), true);
    }
    assert.strictEqual(s._bgQueueIndexRebuilds, afterBatch);
    const ms = Date.now() - t0;
    // Informational: the old scan made this quadratic.
    results.push([true, '    (6,000 claims over a 3,000-entry queue took ' + ms + ' ms)']);
});

test('the index key is the claim key: indexScopeKey(project, platform) + "|" + path', () => {
    const { s } = session();
    s.bgTaskQueue.push(entry('a.pdf'));
    s.hasLiveIndexRun('a.pdf');
    const idx = s._bgQueueByFile;
    assert.deepStrictEqual(Object.keys(idx), [indexScopeKey(IDENT.projectId, IDENT.platform) + '|a.pdf']);
    assert.strictEqual(idx[indexScopeKey(IDENT.projectId, IDENT.platform) + '|a.pdf'], 1);
});

(async () => {
    // tests are synchronous or awaited in order above; wait for the async ones
    await new Promise((r) => setTimeout(r, 0));
    let failed = 0;
    for (const [ok, name, err] of results) {
        if (!name.startsWith('    (')) console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name);
        else console.log(name);
        if (!ok) { failed++; console.log(err); }
    }
    const counted = results.filter(([, n]) => !n.startsWith('    ('));
    console.log(`\n${counted.length - failed}/${counted.length} passed`);
    if (failed) process.exit(1);
})();
