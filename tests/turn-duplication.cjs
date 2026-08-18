/**
 * A chat turn rendered TWICE after navigating away while waiting and coming back.
 *
 * Observed failure: send a message, "Thinking...", leave the chat view, come back —
 * and both the question and the answer are on screen twice, permanently (the merge
 * result is written straight into the history cache).
 *
 * The mechanism. An immediate send pushes its user bubble and its "Thinking..."
 * placeholder locally, and until this fix NEITHER ever carried a _serverItemId —
 * only the QUEUED path stamped one, off its ack. So the first-page merge had no way
 * to tell the local copy of a turn from the server's copy of the same turn, and fell
 * back to a heuristic: keep the local pair unless the fetched page happens to contain
 * a pending assistant.
 *
 * That heuristic has a hole exactly one poll interval wide:
 *
 *   t+0.0s  server settles the request
 *   t+0.1s  the user returns; refreshGate fetches page 1 -> the turn comes back
 *           SETTLED, so the page has no pending assistant
 *           -> the local pair is "rescued" and appended BELOW the server's copy
 *              (the question, twice)
 *   t+2.4s  the 3s dispatch poll finally resolves -> typewriteLatestReply writes the
 *           answer into the rescued placeholder, the only pending assistant left
 *              (the answer, twice)
 *
 * Navigating away and back is what lands a fetch inside that window, at an arbitrary
 * offset from the poll's own cadence.
 *
 * Run: node ./tests/turn-duplication.cjs
 */

const assert = require('assert');
const { shouldRescueInFlightMessage, ChatSession } = require('../dist/engine.cjs');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

const KEY = 'svc-1#claude';

// The decision the first-page merge makes for one local bubble.
function rescue(m, opts) {
    opts = opts || {};
    const page = opts.page || [];
    return shouldRescueInFlightMessage(m, {
        hasServerId: (id) => page.some((p) => p._serverItemId === id),
        pageHasPendingAssistant: page.some((p) => p.isPending && p.role === 'assistant' && !p.isBackgroundTask),
        sending: !!opts.sending,
        next: opts.next,
        loadKey: opts.loadKey === undefined ? KEY : opts.loadKey,
    });
}

/* ---- the bug, at the decision that caused it -----------------------------*/

test('THE BUG: a settled page + an unstamped local pair rescues both (the old shape)', () => {
    // No _serverItemId anywhere on the local pair: this is what the immediate send
    // used to push, and what the cache used to restore.
    const user = { role: 'user', content: 'hi', _ownerKey: KEY, _localId: 'l1' };
    const ph = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _ownerKey: KEY, _localId: 'l2' };
    const page = [
        { role: 'user', content: 'hi', _serverItemId: 'X' },
        { role: 'assistant', content: 'the answer', _serverItemId: 'X' },
    ];
    // Both are still kept, which is the duplication. Pinned here so the fix below is
    // demonstrably about the ID and not about some incidental change.
    assert.strictEqual(rescue(user, { page, sending: true, next: ph }), true);
    assert.strictEqual(rescue(ph, { page, sending: true }), true);
});

test('THE FIX: with the server id stamped on them, the same pair is dropped', () => {
    const user = { role: 'user', content: 'hi', _ownerKey: KEY, _localId: 'l1', _serverItemId: 'X' };
    const ph = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _ownerKey: KEY, _localId: 'l2', _serverItemId: 'X' };
    const page = [
        { role: 'user', content: 'hi', _serverItemId: 'X' },
        { role: 'assistant', content: 'the answer', _serverItemId: 'X' },
    ];
    assert.strictEqual(rescue(user, { page, sending: true, next: ph }), false);
    assert.strictEqual(rescue(ph, { page, sending: true }), false);
});

test('the stamped pair is also dropped while the page still shows it PENDING', () => {
    // The ordinary case: the server has not answered yet, so the page carries the
    // placeholder with a real id and the local copies are redundant.
    const user = { role: 'user', content: 'hi', _ownerKey: KEY, _serverItemId: 'X' };
    const ph = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _ownerKey: KEY, _serverItemId: 'X' };
    const page = [
        { role: 'user', content: 'hi', _serverItemId: 'X' },
        { role: 'assistant', content: '', isPending: true, _serverItemId: 'X' },
    ];
    assert.strictEqual(rescue(user, { page, sending: true, next: ph }), false);
    assert.strictEqual(rescue(ph, { page, sending: true }), false);
});

/* ---- what the rescue still has to keep -----------------------------------*/

test('a stamped in-flight pair whose turn is NOT in the fetched page is kept', () => {
    // The regression the id would otherwise cause: a page that went out before the
    // item existed comes back without it, and dropping the pair would delete the
    // user's question while its request is still running.
    const user = { role: 'user', content: 'hi', _ownerKey: KEY, _serverItemId: 'X' };
    const ph = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _ownerKey: KEY, _serverItemId: 'X' };
    const page = [{ role: 'user', content: 'older', _serverItemId: 'W' }];
    assert.strictEqual(rescue(user, { page, sending: true, next: ph }), true);
    assert.strictEqual(rescue(ph, { page, sending: true }), true);
});

test('an unstamped pair is still kept while the page has no pending assistant AND no copy', () => {
    // The pre-id window: the dispatch has not come back with an item id yet, so the
    // server cannot have the turn either.
    const user = { role: 'user', content: 'hi', _ownerKey: KEY };
    const ph = { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _ownerKey: KEY };
    const page = [{ role: 'user', content: 'older', _serverItemId: 'W' }];
    assert.strictEqual(rescue(user, { page, sending: true, next: ph }), true);
    assert.strictEqual(rescue(ph, { page, sending: true }), true);
});

test('a staged attachment turn is kept unconditionally, even mid-flight of another turn', () => {
    const staged = {
        role: 'user', content: 'here are my files', _ownerKey: KEY, _stageId: 'stg_1',
        isPendingQueued: true, isUploadingAttachments: true, isSendingToServer: true, _useBgQueue: true,
    };
    const page = [{ role: 'assistant', content: '', isPending: true, _serverItemId: 'Y' }];
    assert.strictEqual(rescue(staged, { page, sending: true }), true);
});

test('a queued send awaiting its ack is kept', () => {
    const queued = { role: 'user', content: 'q', _ownerKey: KEY, isPendingQueued: true, isSendingToServer: true };
    assert.strictEqual(rescue(queued, { page: [], sending: false }), true);
});

test('a cancel in flight is kept (it carries an id the page does not have yet)', () => {
    const cancelling = { role: 'user', content: 'q', _ownerKey: KEY, isPendingInProcess: true, _serverItemId: 'Z', _cancelling: true };
    assert.strictEqual(rescue(cancelling, { page: [], sending: false }), true);
});

test("another project's in-flight bubble never crosses over", () => {
    const other = { role: 'user', content: 'hi', _ownerKey: 'svc-2#claude', isPendingQueued: true };
    assert.strictEqual(rescue(other, { page: [], sending: true }), false);
});

test('a background indexing bubble is never rescued (it has its own merge)', () => {
    const bg = { role: 'user', content: 'INDEX x', _ownerKey: KEY, isBackgroundTask: true, isPendingInProcess: true };
    assert.strictEqual(rescue(bg, { page: [], sending: true }), false);
});

test('a settled ordinary bubble is not rescued', () => {
    const settled = { role: 'user', content: 'old', _ownerKey: KEY, _serverItemId: 'W' };
    assert.strictEqual(rescue(settled, { page: [], sending: false }), false);
});

test('an unstamped user bubble is not rescued when nothing pending follows it', () => {
    // sending is session-global; without its own placeholder below it this bubble is
    // not the turn in flight.
    const user = { role: 'user', content: 'hi', _ownerKey: KEY };
    const after = { role: 'assistant', content: 'answered already', _ownerKey: KEY, _serverItemId: 'W' };
    assert.strictEqual(rescue(user, { page: [], sending: true, next: after }), false);
});

test('a placeholder belonging to a DIFFERENT request does not rescue the user above it', () => {
    const user = { role: 'user', content: 'hi', _ownerKey: KEY, _serverItemId: 'X' };
    const foreign = { role: 'assistant', content: '', isPending: true, _ownerKey: KEY, _serverItemId: 'OTHER' };
    assert.strictEqual(rescue(user, { page: [], sending: true, next: foreign }), false);
});

/* ---- the stamping itself -------------------------------------------------*/

function stampingSession() {
    const s = Object.create(ChatSession.prototype);
    s.state = { messages: [] };
    s.aiChatHistoryCache = {};
    s.host = { notify: function () { s._notified = (s._notified || 0) + 1; } };
    return s;
}

test('_stampTurnWithItemId writes the id onto both bubbles, by local id', () => {
    const s = stampingSession();
    s.state.messages = [
        { role: 'user', content: 'older', _serverItemId: 'W' },
        { role: 'user', content: 'INDEX a.pdf', isBackgroundTask: true, _localId: 'lbg' },
        { role: 'user', content: 'hi', _localId: 'lu', _ownerKey: KEY },
        { role: 'assistant', content: '', isPending: true, _localId: 'lp', _ownerKey: KEY },
    ];
    s._stampTurnWithItemId(KEY, 'lu', 'lp', 'X');
    assert.strictEqual(s.state.messages[2]._serverItemId, 'X');
    assert.strictEqual(s.state.messages[3]._serverItemId, 'X');
    // Untouched neighbours, including the indexing row spliced in between.
    assert.strictEqual(s.state.messages[0]._serverItemId, 'W');
    assert.strictEqual(s.state.messages[1]._serverItemId, undefined);
});

test('_stampTurnWithItemId writes the id into the CACHE too', () => {
    // The cache is what a remount renders BEFORE the fetch lands; a cached copy
    // still missing the id would be rescued by the very merge this exists to satisfy.
    const s = stampingSession();
    s.state.messages = [
        { role: 'user', content: 'hi', _localId: 'lu' },
        { role: 'assistant', content: '', isPending: true, _localId: 'lp' },
    ];
    s.aiChatHistoryCache[KEY] = {
        messages: [
            { role: 'user', content: 'hi', _localId: 'lu' },
            { role: 'assistant', content: '', isPending: true, _localId: 'lp' },
        ],
        endOfList: false, startKeyHistory: ['a'],
    };
    s._stampTurnWithItemId(KEY, 'lu', 'lp', 'X');
    const cached = s.aiChatHistoryCache[KEY];
    assert.strictEqual(cached.messages[0]._serverItemId, 'X');
    assert.strictEqual(cached.messages[1]._serverItemId, 'X');
    assert.strictEqual(cached.endOfList, false);
    assert.deepStrictEqual(cached.startKeyHistory, ['a']);
});

test('_stampTurnWithItemId is idempotent and re-stamps on an auth-refresh retry', () => {
    const s = stampingSession();
    s.state.messages = [
        { role: 'user', content: 'hi', _localId: 'lu' },
        { role: 'assistant', content: '', isPending: true, _localId: 'lp' },
    ];
    s._stampTurnWithItemId(KEY, 'lu', 'lp', 'X');
    const n1 = s._notified;
    s._stampTurnWithItemId(KEY, 'lu', 'lp', 'X');
    assert.strictEqual(s._notified, n1, 'a no-op stamp must not notify');
    // A retry after an auth refresh dispatches a NEW server item.
    s._stampTurnWithItemId(KEY, 'lu', 'lp', 'X2');
    assert.strictEqual(s.state.messages[0]._serverItemId, 'X2');
    assert.strictEqual(s.state.messages[1]._serverItemId, 'X2');
});

test('_stampTurnWithItemId does nothing without an id, and survives a missing cache', () => {
    const s = stampingSession();
    s.state.messages = [{ role: 'user', content: 'hi', _localId: 'lu' }];
    s._stampTurnWithItemId(KEY, 'lu', 'lp', '');
    assert.strictEqual(s.state.messages[0]._serverItemId, undefined);
    s._stampTurnWithItemId('no-such-key', 'lu', 'lp', 'X');
    assert.strictEqual(s.state.messages[0]._serverItemId, 'X');
});

/* ---- the second duplication route: the cache -----------------------------*/

test('_applyReplyToCache REPLACES the pending placeholder, matched by server id', () => {
    const s = stampingSession();
    s.aiChatHistoryCache[KEY] = {
        messages: [
            { role: 'user', content: 'hi', _serverItemId: 'X' },
            { role: 'assistant', content: '', isPending: true, _serverItemId: 'X' },
        ],
        endOfList: false, startKeyHistory: [],
    };
    s._applyReplyToCache(KEY, { role: 'assistant', content: 'the answer', _serverItemId: 'X' }, 'X');
    const msgs = s.aiChatHistoryCache[KEY].messages;
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[1].content, 'the answer');
    assert.strictEqual(msgs[1].isPending, undefined);
});

test('THE SECOND BUG: no placeholder left, but the answer is already cached -> replace, never append', () => {
    // Once the local pair carries its id, a fetch that lands after the server settles
    // the item correctly drops both local copies and re-snapshots a cache that has NO
    // pending placeholder. A blind push here writes the answer in a second time, and
    // the cache is rendered verbatim on the next mount — so the fix that stopped the
    // turn duplicating on SCREEN would have moved the duplicate into the cache.
    const s = stampingSession();
    s.aiChatHistoryCache[KEY] = {
        messages: [
            { role: 'user', content: 'hi', _serverItemId: 'X' },
            { role: 'assistant', content: 'the answer', _serverItemId: 'X' },
        ],
        endOfList: false, startKeyHistory: [],
    };
    s._applyReplyToCache(KEY, { role: 'assistant', content: 'the answer', _serverItemId: 'X' }, 'X');
    const msgs = s.aiChatHistoryCache[KEY].messages;
    assert.strictEqual(msgs.length, 2, 'the answer must not be cached twice');
    assert.strictEqual(msgs.filter((m) => m.role === 'assistant').length, 1);
});

test('a genuinely new turn still appends to the cache', () => {
    const s = stampingSession();
    s.aiChatHistoryCache[KEY] = {
        messages: [{ role: 'user', content: 'hi', _serverItemId: 'X' }],
        endOfList: false, startKeyHistory: [],
    };
    s._applyReplyToCache(KEY, { role: 'assistant', content: 'the answer', _serverItemId: 'X' }, 'X');
    assert.strictEqual(s.aiChatHistoryCache[KEY].messages.length, 2);
});

/* ---- the third route: resolving a turn the fetch already rendered --------*/

test('_turnAlreadyRendered sees the settled server copy', () => {
    const s = stampingSession();
    s.state.messages = [
        { role: 'user', content: 'hi', _serverItemId: 'X' },
        { role: 'assistant', content: 'the answer', _serverItemId: 'X' },
    ];
    assert.strictEqual(s._turnAlreadyRendered('X'), true);
});

test('_turnAlreadyRendered says no while the turn is genuinely live', () => {
    const s = stampingSession();
    // Queued: the user bubble is pending until it is promoted, then in-process.
    s.state.messages = [{ role: 'user', content: 'hi', _serverItemId: 'X', isPendingQueued: true }];
    assert.strictEqual(s._turnAlreadyRendered('X'), false);
    s.state.messages = [
        { role: 'user', content: 'hi', _serverItemId: 'X', isPendingInProcess: true },
        { role: 'assistant', content: '', isPending: true, _serverItemId: 'X' },
    ];
    assert.strictEqual(s._turnAlreadyRendered('X'), false);
});

test('_turnAlreadyRendered fires on a settled turn whose answer was EMPTY (no assistant bubble)', () => {
    // The mapper emits no assistant bubble for an empty answer, so testing only for a
    // settled assistant would still bottom-push "No text response received...".
    const s = stampingSession();
    s.state.messages = [{ role: 'user', content: 'hi', _serverItemId: 'X' }];
    assert.strictEqual(s._turnAlreadyRendered('X'), true);
});

test('_turnAlreadyRendered is false without an id, and for another turn', () => {
    const s = stampingSession();
    s.state.messages = [{ role: 'user', content: 'hi', _serverItemId: 'X' }];
    assert.strictEqual(s._turnAlreadyRendered(undefined), false);
    assert.strictEqual(s._turnAlreadyRendered('OTHER'), false);
});

/* ---- report --------------------------------------------------------------*/

let failed = 0;
for (const [ok, name, msg] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (ok ? '' : '\n      ' + msg));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
