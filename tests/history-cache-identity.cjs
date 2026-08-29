/**
 * One browser, one project, TWO conversations: and the wrong one on screen.
 *
 * Observed failure shape: the chat's per-conversation caches all hung off
 * `projectId + '#' + platform`, with no identity in the key. That is fine as long
 * as a page only ever holds one identity, which stopped being true in two ways:
 *
 *   - the embeddable widget now opens the chat for ANONYMOUS visitors on projects
 *     that allow them, and a visitor can sign in from the chat header without a
 *     reload, so the anonymous transcript and the account's transcript are two
 *     conversations under one (project, platform);
 *   - the dashboard has always been able to log out and back in as someone else.
 *
 * In both cases the previous conversation stayed in `aiChatHistoryCache` under the
 * key the new one computes, so it was re-rendered as the new identity's chat: and,
 * because the same key is what writes go back under, written back as theirs too.
 * The hydrated-body memo, the live-index key and the per-file storage-path key all
 * hang off the same helper, so every one of them had the same hole.
 *
 * The fix puts `userId` in the key. userId is the value the request QUEUE is named
 * after, so two identities that genuinely share a queue still share a cache, which
 * is the correct behaviour, and two that do not can no longer collide.
 *
 * Run: node ./tests/history-cache-identity.cjs
 */

const assert = require('assert');
const { ChatSession } = require('../dist/engine.cjs');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

// A ChatSession needs only its host's getIdentity() for these; the rest of the
// host surface is never reached by getHistoryCacheKey.
function sessionFor(identity) {
    let id = identity;
    const session = new ChatSession({
        getIdentity: () => id,
        buildSystemPrompt: () => '',
        notify: () => {},
        refreshMessageBubble: () => {},
        scrollToBottom: () => {},
        scrollToBottomIfSticky: () => {},
    });
    session._setIdentity = (next) => { id = next; };
    return session;
}

const ANON = {
    projectId: 'svc-1', owner: 'own-1', platform: 'claude',
    userId: 'anon_9f2c4d',
};
const SIGNED_IN = {
    projectId: 'svc-1', owner: 'own-1', platform: 'claude',
    userId: 'user-abc',
};

/* ---- the bug ------------------------------------------------------------ */

test('THE BUG: an anonymous visitor and a signed-in user do not share a cache key', () => {
    const anon = sessionFor(ANON).getHistoryCacheKey();
    const user = sessionFor(SIGNED_IN).getHistoryCacheKey();
    assert.notStrictEqual(anon, user,
        'same key for two identities on one project: the anon transcript renders as the account\'s');
});

test('signing in mid-session changes the key, so the anon cache is not adopted', () => {
    const session = sessionFor(ANON);
    const before = session.getHistoryCacheKey();
    session._setIdentity(SIGNED_IN);
    const after = session.getHistoryCacheKey();
    assert.notStrictEqual(before, after);
});

test('two different accounts on one project do not share a cache key', () => {
    const a = sessionFor({ ...SIGNED_IN, userId: 'user-a' }).getHistoryCacheKey();
    const b = sessionFor({ ...SIGNED_IN, userId: 'user-b' }).getHistoryCacheKey();
    assert.notStrictEqual(a, b);
});

/* ---- what must NOT change ----------------------------------------------- */

test('the same identity is stable across calls', () => {
    const s = sessionFor(SIGNED_IN);
    assert.strictEqual(s.getHistoryCacheKey(), s.getHistoryCacheKey());
    assert.strictEqual(s.getHistoryCacheKey(), sessionFor(SIGNED_IN).getHistoryCacheKey());
});

test('the key still separates projects', () => {
    const a = sessionFor({ ...SIGNED_IN, projectId: 'svc-1' }).getHistoryCacheKey();
    const b = sessionFor({ ...SIGNED_IN, projectId: 'svc-2' }).getHistoryCacheKey();
    assert.notStrictEqual(a, b);
});

test('the key still separates platforms', () => {
    const a = sessionFor({ ...SIGNED_IN, platform: 'claude' }).getHistoryCacheKey();
    const b = sessionFor({ ...SIGNED_IN, platform: 'openai' }).getHistoryCacheKey();
    assert.notStrictEqual(a, b);
});

test('it still carries the project and platform, so existing prefixes read the same', () => {
    const key = sessionFor(SIGNED_IN).getHistoryCacheKey();
    assert.ok(key.indexOf('svc-1') === 0, 'project id must lead the key: ' + key);
    assert.ok(key.indexOf('#claude') !== -1, 'platform must still be in the key: ' + key);
});

test('an unusable identity still yields the empty key (no cache, no writes)', () => {
    assert.strictEqual(sessionFor({ ...SIGNED_IN, projectId: '' }).getHistoryCacheKey(), '');
    assert.strictEqual(sessionFor({ ...SIGNED_IN, platform: 'none' }).getHistoryCacheKey(), '');
});

test('a missing userId does not throw or produce "undefined" in the key', () => {
    const key = sessionFor({ projectId: 'svc-1', owner: 'o', platform: 'claude' }).getHistoryCacheKey();
    assert.ok(typeof key === 'string' && key.length > 0);
    assert.ok(key.indexOf('undefined') === -1, 'stringified undefined leaked into the key: ' + key);
});

/* ---- report ------------------------------------------------------------- */

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
