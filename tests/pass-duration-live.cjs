/**
 * A pass that settles IN FRONT OF THE USER shows its duration immediately.
 *
 * Why this needs its own path at all: the duration's two halves live in different
 * places. The END is the settle itself. The START is `att`, recorded server-side
 * when the worker begins the upstream call, and it reaches a client on the poll's
 * STATUS envelope -- which only a non-terminal tick returns, because a terminal
 * read hands back the destination's own response body and that body is the
 * caller's, not somewhere skapi attaches its fields.
 *
 * So the SDK remembers `executed` off the running ticks and hands it to
 * onResponse as a second `meta` argument at settle, and the engine stamps it onto
 * the bubble. No extra request: the poll was already running.
 *
 * Without this, `_tsStart` was written only by the history mapper, and nothing
 * refetches a row once its answer has been delivered -- so the duration appeared
 * only when the user left the chat and came back.
 *
 * Run: node ./tests/pass-duration-live.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ChatSession, formatDuration } = require('../dist/engine.cjs');

const IDENT = { projectId: 'svc-1', owner: 'own-1', platform: 'claude', userId: 'user-abc' };
const ITEM = 'req-1';

function session() {
    return new ChatSession({
        getIdentity: () => IDENT,
        buildSystemPrompt: () => '',
        notify: () => {},
        refreshMessageBubble: () => {},
        scrollToBottom: () => {},
        scrollToBottomIfSticky: () => {},
        isViewMounted: () => false,
    });
}

/** A settled indexing turn: the request bubble carries the file ref, the reply is
 *  the bubble the duration goes on. */
function seedIndexingTurn(s, replyExtra) {
    s.state.messages = [
        {
            role: 'user',
            content: 'Indexing: q3.xlsx',
            isBackgroundTask: true,
            _serverItemId: ITEM,
            _indexFile: { name: 'q3.xlsx', path: 'uploads/q3.xlsx' },
        },
        Object.assign({ role: 'assistant', content: 'Indexed q3.xlsx.', _serverItemId: ITEM }, replyExtra || {}),
    ];
    return s.state.messages[1];
}
const reply = (s) => s.state.messages[1];

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

test('THE FIX: a settled pass is stamped with the execution start from the poll', () => {
    const s = session();
    seedIndexingTurn(s);
    const started = Date.now() - 64 * 1000;
    s._stampPassDuration(ITEM, started);
    assert.strictEqual(reply(s)._tsStart, started);
    // and the end is now, so the bubble can render a duration on the spot
    assert.strictEqual(typeof reply(s)._ts, 'number');
    assert.strictEqual(formatDuration(reply(s)._ts - reply(s)._tsStart), '1m 4s');
});

test('an _ts the settle already set is NOT overwritten', () => {
    const s = session();
    const fixedEnd = Date.now() - 5000;
    seedIndexingTurn(s, { _ts: fixedEnd });
    s._stampPassDuration(ITEM, fixedEnd - 30000);
    assert.strictEqual(reply(s)._ts, fixedEnd);
});

// No execution start is a NORMAL outcome, not an error: the value rides only on a
// running poll tick, and a pass can begin and end between two of them. What must
// NOT happen is losing the timestamp along with the duration -- both clients gate
// the entire time element on `_ts`, so a bubble with no `_ts` renders no time at
// all, which reads as a bug rather than as a missing duration.
test('no executed value still gives the reply its timestamp, just no duration', () => {
    const s = session();
    seedIndexingTurn(s);
    s._stampPassDuration(ITEM, undefined);
    assert.strictEqual(reply(s)._tsStart, undefined);
    assert.strictEqual(typeof reply(s)._ts, 'number');
});

test('a zero or negative executed is refused as a START but still times the reply', () => {
    const s = session();
    seedIndexingTurn(s);
    s._stampPassDuration(ITEM, 0);
    s._stampPassDuration(ITEM, -1);
    assert.strictEqual(reply(s)._tsStart, undefined);
    assert.strictEqual(typeof reply(s)._ts, 'number');
});

test('an _ts already present is never overwritten by the no-start path', () => {
    const s = session();
    const fixed = Date.now() - 90000;
    seedIndexingTurn(s, { _ts: fixed });
    s._stampPassDuration(ITEM, undefined);
    assert.strictEqual(reply(s)._ts, fixed);
});

test('an ORDINARY turn is left alone: only indexing passes carry a duration', () => {
    const s = session();
    s.state.messages = [
        { role: 'user', content: 'what is in q3?', _serverItemId: ITEM },   // no _indexFile
        { role: 'assistant', content: 'Three sheets.', _serverItemId: ITEM },
    ];
    s._stampPassDuration(ITEM, Date.now() - 10000);
    assert.strictEqual(s.state.messages[1]._tsStart, undefined);
});

test('a still-pending bubble is skipped, so a placeholder never claims a duration', () => {
    const s = session();
    seedIndexingTurn(s, { isPending: true, content: '' });
    s._stampPassDuration(ITEM, Date.now() - 10000);
    assert.strictEqual(reply(s)._tsStart, undefined);
});

test('another item id does not stamp this turn', () => {
    const s = session();
    seedIndexingTurn(s);
    s._stampPassDuration('some-other-item', Date.now() - 10000);
    assert.strictEqual(reply(s)._tsStart, undefined);
});

// ---------------------------------------------------------------------------
// THE FUNNEL. The stamp lives in handleHistoryItemResolution, not at the call
// sites, because the call sites are the thing that kept getting missed: the
// first cut wired it into the engine's bg drain only, and a pass uploaded from
// the FILES page is settled by agent.vue's own forked history poll instead --
// so the duration still did not appear until something refetched history much
// later, which is the exact symptom the feature was meant to remove.
// ---------------------------------------------------------------------------

/** The funnel also chases the worker chain, which wants a network round trip
 *  nothing here can serve. Only the stamp is under test. */
function funnelSession() {
    const s = session();
    s._followWorkerIndexingChain = () => {};
    return s;
}

test('THE REAL FIX: the settle funnel stamps, so every caller gets it', () => {
    const s = funnelSession();
    seedIndexingTurn(s);
    const started = Date.now() - 64 * 1000;
    s.handleHistoryItemResolution(ITEM, { content: [{ type: 'text', text: 'Indexed q3.xlsx.' }] }, 'claude', started);
    assert.strictEqual(reply(s)._tsStart, started);
    assert.strictEqual(formatDuration(reply(s)._ts - reply(s)._tsStart), '1m 4s');
});

test('the funnel without an execution start stamps nothing (an ordinary settle)', () => {
    const s = funnelSession();
    seedIndexingTurn(s);
    s.handleHistoryItemResolution(ITEM, { content: [{ type: 'text', text: 'Indexed q3.xlsx.' }] }, 'claude');
    assert.strictEqual(reply(s)._tsStart, undefined);
});

test('the stamp is NOTIFIED, or the widget never repaints it', () => {
    let notified = 0;
    const s = new ChatSession({
        getIdentity: () => IDENT,
        buildSystemPrompt: () => '',
        notify: () => { notified++; },
        refreshMessageBubble: () => {},
        scrollToBottom: () => {},
        scrollToBottomIfSticky: () => {},
    });
    seedIndexingTurn(s);
    const before = notified;
    s._stampPassDuration(ITEM, Date.now() - 10000);
    assert.ok(notified > before, 'stamping must notify: the widget notify() IS its render');
});

test('a stamp on an unrelated item does NOT notify', () => {
    let notified = 0;
    const s = new ChatSession({
        getIdentity: () => IDENT,
        buildSystemPrompt: () => '',
        notify: () => { notified++; },
        refreshMessageBubble: () => {},
        scrollToBottom: () => {},
        scrollToBottomIfSticky: () => {},
    });
    seedIndexingTurn(s);
    const before = notified;
    s._stampPassDuration('some-other-item', Date.now() - 10000);
    assert.strictEqual(notified, before);
});

test('the stamp RE-CACHES, or a remount rebuilds the bubble without its duration', () => {
    const s = session();
    seedIndexingTurn(s);
    let cached = 0;
    s.updateHistoryCache = () => { cached++; };
    s._stampPassDuration(ITEM, Date.now() - 10000);
    assert.ok(cached > 0, 'applyHistoryItemResolution cached a moment earlier, without _tsStart');
});

// ---------------------------------------------------------------------------
// SOURCE GUARDS. The runtime tests above pass whether or not a client actually
// hands the execution start over, which is precisely how the first cut shipped
// looking correct. These read the sources instead.
// ---------------------------------------------------------------------------

test('the engine stamps in ONE place: the funnel, never at a call site', () => {
    const engineSrc = fs.readFileSync(path.resolve(__dirname, '../src/engine/session.ts'), 'utf8');
    const calls = engineSrc.split('this._stampPassDuration(').length - 1
        + engineSrc.split('self._stampPassDuration(').length - 1;
    assert.strictEqual(calls, 1, 'a per-call-site stamp is a call site waiting to be forgotten');
});

test('every engine poll that settles a turn hands the execution start over', () => {
    const engineSrc = fs.readFileSync(path.resolve(__dirname, '../src/engine/session.ts'), 'utf8');
    const settles = engineSrc.match(/(?:self|this)\.handleHistoryItemResolution\([^)]*\)/g) || [];
    assert.ok(settles.length >= 2, 'expected the drain and the re-attach paths');
    for (const call of settles) {
        assert.strictEqual(call.split(',').length, 4, 'settle call drops the execution start: ' + call);
    }
});

const AGENT = path.resolve(__dirname, '../../www.bunnyquery.com/src/views/service/agent.vue');
if (!fs.existsSync(AGENT)) {
    results.push([true, "and agent.vue's forked poll forwards it too (SKIPPED: www.bunnyquery.com is not checked out beside this package)"]);
} else {
    test("and agent.vue's forked poll forwards it too", () => {
        const agent = fs.readFileSync(AGENT, 'utf8');
        // THE BUG: this fork declared `onResponse: (response: any) => {`, a
        // one-parameter callback, so the SDK's second argument was dropped on the
        // floor -- and this fork is what settles a pass started from the files page.
        assert.ok(
            /onResponse:\s*\(response: any,\s*meta\?: \{ executed\?: number \}\) =>/.test(agent),
            "agent.vue's history poll must take the meta argument"
        );
        assert.ok(
            /handleHistoryItemResolution\(capturedId, response, platform, cacheKey, meta\?\.executed\)/.test(agent),
            'agent.vue must forward meta.executed into the engine funnel'
        );
        assert.ok(
            /chatSession\.handleHistoryItemResolution\(itemId, response, platform, executedAt\)/.test(agent),
            "agent.vue's local wrapper must pass the execution start through, not swallow it"
        );
    });

    // THE THIRD FORK. main.vue polls the bg queue while the chat view is CLOSED --
    // which is exactly what a files-page upload does -- and it CLAIMS the id in
    // chatSession.historyItemPolls, so both engine pollers skip it from then on.
    // Once it attaches it is the only poll that pass will ever get, so dropping the
    // meta argument here costs the duration outright.
    const MAIN = path.resolve(__dirname, '../../www.bunnyquery.com/src/views/service/main.vue');
    if (!fs.existsSync(MAIN)) {
        results.push([true, "and main.vue's fallback bg poller forwards it too (SKIPPED: www.bunnyquery.com is not checked out beside this package)"]);
    } else {
        test("and main.vue's fallback bg poller forwards it too", () => {
            const main = fs.readFileSync(MAIN, 'utf8');
            assert.ok(/onResponse: \(_res: any, meta\?: \{ executed\?: number \}\) =>/.test(main),
                "main.vue's poll must take the meta argument");
            assert.ok(/handOffToChat\(id, response, plat, executedAt\)/.test(main),
                'main.vue must forward the execution start to its hand-off');
            assert.ok(/chatSession\.handleHistoryItemResolution\(id, response, platform as any, executedAt\)/.test(main),
                'main.vue must pass the execution start into the engine funnel');
        });
    }

    // THE SECOND BUG, and the one the user actually saw. agent.vue does not use
    // the engine's history mapper -- it has its OWN fork of
    // mapHistoryListToMessages, and THAT is the one that runs when you enter a
    // chat. The engine's runs on a tab return (resumePolling). So a settled pass
    // showed no duration on entry, then gained one the moment the user looked
    // away and came back, which reads exactly like "it needs a round trip".
    test("agent.vue's FORKED history mapper stamps _tsStart like the engine's", () => {
        const agent = fs.readFileSync(AGENT, 'utf8');
        assert.ok(
            /const executedTs = Number\(\(item as any\)\?\.executed\);/.test(agent),
            "agent.vue's mapper must read `executed` off the history item"
        );
        const stamps = agent.match(/if \(indexFile && isFinite\(executedTs\) && executedTs > 0\) \w+\._tsStart = executedTs;/g) || [];
        assert.strictEqual(stamps.length, 2,
            'both reply branches must stamp: the ok branch AND the error branch (a pass that failed still ran for a while). Found ' + stamps.length);
        // The engine gates on indexFile so an ordinary chat reply never gets a
        // bracketed duration. Same gate here, or the two clients disagree.
        const engineSrc = fs.readFileSync(path.resolve(__dirname, '../src/engine/history.ts'), 'utf8');
        const engineStamps = engineSrc.match(/if \(indexFile && isFinite\(executedTs\) && executedTs > 0\) \w+\._tsStart = executedTs;/g) || [];
        assert.strictEqual(engineStamps.length, stamps.length,
            'the engine mapper and agent.vue’s fork must stamp the same number of branches');
    });
}

let pass = 0;
for (const [ok, name, msg] of results) {
    console.log(ok ? `ok    ${name}` : `FAIL  ${name}\n        ${msg}`);
    if (ok) pass++;
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
