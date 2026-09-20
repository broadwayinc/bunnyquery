/**
 * The engine's transport under both of its names.
 *
 * skapi-js renamed clientSecretRequest and its companions to the forwardRequest
 * family and kept every old name working. The engine now takes either family of
 * keys through configureChatEngine, prefers the new one, and resolves every call in
 * config.ts (resolveForwardRequest and its three siblings), which is the only code
 * that knows there are two.
 *
 * What is held here, and why each one matters:
 *
 *   1. THE NEW KEY WINS. A host that injects `forwardRequest` gets
 *      `forwardRequest(null, opts)` with `secretName`, and the old key is never
 *      touched even when it is injected too.
 *   2. THE OLD KEYS STILL WORK, UNCHANGED. This package is pinned with a caret range,
 *      so a host written against an earlier release takes this one on its next
 *      install with nothing but `clientSecretRequest*` injected. It must be handed
 *      exactly what it was handed before: `clientSecretName`, first, and every other
 *      key as the builder made it. A request that names NO secret is the quiet
 *      failure: the new SDK forwards it unresolved and the provider gets a literal
 *      "$CLIENT_SECRET" as its api key.
 *   3. NEITHER FAILS CLEARLY, with a message that names the fix.
 *   4. The two streaming capability questions (skapiSupportsStreaming about an
 *      INSTANCE, streamRecoveryEnabled about a CONFIG) answer yes for either
 *      spelling, so the rename cannot quietly turn streaming or recovery off.
 *
 * Run: node ./tests/forward-request-transport.cjs
 */

const assert = require('assert');
const engine = require('../dist/engine.cjs');
const {
    ChatSession, configureChatEngine,
    callClaudeWithPublicMcp, callOpenAIWithPublicMcp, notifyAgentSaveAttachment,
    listClaudeModels, listOpenAIModels, getChatHistory,
    skapiSupportsStreaming, streamRecoveryEnabled, extractClaudeText,
} = engine;

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- the five request builders, each with the secret it must name -------- */

const ATTACHMENT = {
    platform: 'claude', service: 'svc_1', owner: 'own_1', userId: 'usr_1',
    attachment: { name: 'notes.txt', storagePath: 'usr_1/notes.txt', mime: 'text/plain', size: 12, url: 'https://cdn.example.com/notes.txt' },
};
const BUILDERS = [
    ['callClaudeWithPublicMcp', 'claude', () => callClaudeWithPublicMcp('hi', 'svc_1', 'own_1')],
    ['callOpenAIWithPublicMcp', 'openai', () => callOpenAIWithPublicMcp('hi', 'svc_1', 'own_1')],
    ['notifyAgentSaveAttachment (claude)', 'claude', () => notifyAgentSaveAttachment(ATTACHMENT)],
    ['notifyAgentSaveAttachment (openai)', 'openai', () => notifyAgentSaveAttachment(Object.assign({}, ATTACHMENT, { platform: 'openai' }))],
    ['listClaudeModels', 'claude', () => listClaudeModels('svc_1', 'own_1')],
    ['listOpenAIModels', 'openai', () => listOpenAIModels('svc_1', 'own_1')],
];

const ACK = { id: 'stamp:entropy', status: 'pending', queue_name: 'usr_1', in_queue: 0 };

/** A config recording every transport call it is given, under the names asked for. */
function transportConfig(families, extra) {
    const calls = { forwardRequest: [], clientSecretRequest: [], forwardRequestHistory: [], clientSecretRequestHistory: [] };
    const cfg = { mcpBaseUrl: 'https://mcp.example.com', poll: 0 };
    if (families.includes('new')) {
        cfg.forwardRequest = function (form, opts) { calls.forwardRequest.push({ self: this, form, opts, argc: arguments.length }); return Promise.resolve(ACK); };
        cfg.forwardRequestHistory = function (params, fetchOptions) { calls.forwardRequestHistory.push({ self: this, params, fetchOptions }); return Promise.resolve({ list: [] }); };
    }
    if (families.includes('old')) {
        cfg.clientSecretRequest = function (opts) { calls.clientSecretRequest.push({ self: this, opts, argc: arguments.length }); return Promise.resolve(ACK); };
        cfg.clientSecretRequestHistory = function (params, fetchOptions) { calls.clientSecretRequestHistory.push({ self: this, params, fetchOptions }); return Promise.resolve({ list: [] }); };
    }
    Object.assign(cfg, extra || {});
    configureChatEngine(cfg);
    return { cfg, calls };
}

(async () => {

/* ══ 1. the dispatch resolver prefers the new key ═════════════════════════ */

for (const [name, secret, run] of BUILDERS) {
    await test(`${name}: with BOTH families injected, only forwardRequest is called`, async () => {
        const { calls } = transportConfig(['new', 'old']);
        await run();
        assert.strictEqual(calls.forwardRequest.length, 1, 'forwardRequest was not called');
        assert.strictEqual(calls.clientSecretRequest.length, 0, 'the deprecated key was called although the new one was injected');
        const c = calls.forwardRequest[0];
        assert.strictEqual(c.argc, 2, 'forwardRequest takes (form, options)');
        assert.strictEqual(c.form, null, 'the engine never has a form, so the first argument is null');
        assert.strictEqual(c.opts.secretName, secret);
        assert.ok(!('clientSecretName' in c.opts), 'the new door was handed the old name');
        // The fields the backend scopes the request by, unchanged.
        assert.strictEqual(c.opts.service, 'svc_1');
        assert.strictEqual(c.opts.owner, 'own_1');
        // The body stays in options.data. The model listings are bodiless GETs.
        if (c.opts.method === 'POST') {
            assert.ok(c.opts.data && typeof c.opts.data === 'object', 'the body stays in options.data');
        } else {
            assert.strictEqual(c.opts.method, 'GET');
            assert.ok(!('data' in c.opts), 'a listing grew a body');
        }
    });
}

await test('a host that injects ONLY the new family works end to end', async () => {
    const { calls } = transportConfig(['new']);
    for (const [, , run] of BUILDERS) await run();
    assert.strictEqual(calls.forwardRequest.length, BUILDERS.length);
    await getChatHistory({ platform: 'claude', service: 'svc_1', owner: 'own_1' }, {});
    assert.strictEqual(calls.forwardRequestHistory.length, 1);
});

await test('the resolved promise is the transport\'s own, untouched', async () => {
    // The .stop handles the session reads come from the RESULT's poll(), so the
    // dispatch must hand back exactly what the host's forwardRequest resolved with.
    const handle = { id: 'r1', status: 'pending', poll: () => { } };
    transportConfig(['new'], { forwardRequest: () => Promise.resolve(handle) });
    assert.strictEqual(await listClaudeModels('svc_1', 'own_1'), handle);
});

await test('a new key holding undefined is "not this one", and the old key answers', async () => {
    const { calls } = transportConfig(['old'], { forwardRequest: undefined, forwardRequestHistory: undefined });
    await listClaudeModels('svc_1', 'own_1');
    await getChatHistory({ platform: 'claude', service: 'svc_1', owner: 'own_1' }, {});
    assert.strictEqual(calls.clientSecretRequest.length, 1);
    assert.strictEqual(calls.clientSecretRequestHistory.length, 1);
});

/* ══ 2. the fallback to the old keys is the request it always was ═════════ */

for (const [name, secret, run] of BUILDERS) {
    await test(`${name}: an old-keys-only host gets clientSecretName, first, and nothing else changed`, async () => {
        const fresh = transportConfig(['new']);
        await run();
        const viaNew = fresh.calls.forwardRequest[0].opts;

        const legacy = transportConfig(['old']);
        await run();
        assert.strictEqual(legacy.calls.clientSecretRequest.length, 1, 'the deprecated key was not called');
        const c = legacy.calls.clientSecretRequest[0];
        assert.strictEqual(c.argc, 1, 'the deprecated method takes one argument, and got a form');
        const viaOld = c.opts;

        assert.strictEqual(viaOld.clientSecretName, secret);
        assert.ok(!('secretName' in viaOld), 'the old door was handed the new name as well');
        // Key for key, in the same order, what the builders produced before the rename:
        // they always put the secret's name first.
        assert.deepStrictEqual(
            Object.keys(viaOld),
            ['clientSecretName'].concat(Object.keys(viaNew).filter((k) => k !== 'secretName')),
        );
        // And every value other than the name's spelling is the same on both doors.
        const { secretName: _n, ...restNew } = viaNew;
        const { clientSecretName: _o, ...restOld } = viaOld;
        assert.deepStrictEqual(restOld, restNew);
    });
}

await test('the fallback keeps service, owner, queue, poll and the stream flags', async () => {
    const { calls } = transportConfig(['old'], { liveStreaming: true });
    await callClaudeWithPublicMcp('hi', 'svc_1', 'own_1', undefined, undefined, undefined, 'usr_1');
    const o = calls.clientSecretRequest[0].opts;
    assert.strictEqual(o.clientSecretName, 'claude');
    assert.strictEqual(o.service, 'svc_1');
    assert.strictEqual(o.owner, 'own_1');
    assert.strictEqual(o.poll, 0);
    assert.ok(typeof o.queue === 'string' && o.queue, 'the queue was dropped');
    // Both halves of the stream pair, or neither: the fallback must not split them.
    assert.strictEqual('stream' in o, 'stream' in o.data);
});

await test('the fallback calls the transport as a method of the config, as it always did', async () => {
    const { cfg, calls } = transportConfig(['old']);
    await listOpenAIModels('svc_1', 'own_1');
    await getChatHistory({ platform: 'openai', service: 'svc_1', owner: 'own_1' }, {});
    assert.strictEqual(calls.clientSecretRequest[0].self, cfg);
    assert.strictEqual(calls.clientSecretRequestHistory[0].self, cfg);
});

/* ══ 3. history: a pure preference, same arguments ═══════════════════════ */

await test('history prefers forwardRequestHistory and hands it the same arguments', async () => {
    const both = transportConfig(['new', 'old']);
    await getChatHistory({ platform: 'claude', service: 'svc_1', owner: 'own_1', queue: 'usr_1' }, { limit: 5 });
    assert.strictEqual(both.calls.forwardRequestHistory.length, 1);
    assert.strictEqual(both.calls.clientSecretRequestHistory.length, 0);

    const old = transportConfig(['old']);
    await getChatHistory({ platform: 'claude', service: 'svc_1', owner: 'own_1', queue: 'usr_1' }, { limit: 5 });
    assert.strictEqual(old.calls.clientSecretRequestHistory.length, 1);
    assert.deepStrictEqual(old.calls.clientSecretRequestHistory[0].params, both.calls.forwardRequestHistory[0].params);
    assert.deepStrictEqual(old.calls.clientSecretRequestHistory[0].fetchOptions, both.calls.forwardRequestHistory[0].fetchOptions);
    assert.strictEqual(old.calls.clientSecretRequestHistory[0].params.service, 'svc_1');
});

/* ══ 4. a host with neither fails clearly ═════════════════════════════════ */

for (const [name, , run] of BUILDERS) {
    await test(`${name}: no transport at all rejects with a message naming the fix`, async () => {
        transportConfig([]);
        await assert.rejects(run(), (err) => {
            assert.ok(!(err instanceof TypeError), 'still the old "is not a function" TypeError');
            assert.match(err.message, /forwardRequest/);
            assert.match(err.message, /clientSecretRequest/);
            return true;
        });
    });
}

await test('and so does history', async () => {
    transportConfig([]);
    await assert.rejects(
        getChatHistory({ platform: 'claude', service: 'svc_1', owner: 'own_1' }, {}),
        /forwardRequestHistory[\s\S]*clientSecretRequestHistory/,
    );
});

/* ══ 5. skapiSupportsStreaming: either whole pair ═════════════════════════ */

const fn = () => { };

await test('skapiSupportsStreaming: the NEW pair is enough', () => {
    assert.strictEqual(skapiSupportsStreaming({ forwardRequestStream: fn, forwardRequestFinalize: fn }), true);
});

await test('skapiSupportsStreaming: the OLD pair still is (an embed pinned between the releases)', () => {
    assert.strictEqual(skapiSupportsStreaming({ clientSecretRequestStream: fn, clientSecretRequestFinalize: fn }), true);
});

await test('skapiSupportsStreaming: the renamed SDK, carrying both pairs', () => {
    assert.strictEqual(skapiSupportsStreaming({
        forwardRequestStream: fn, forwardRequestFinalize: fn,
        clientSecretRequestStream: fn, clientSecretRequestFinalize: fn,
    }), true);
});

await test('skapiSupportsStreaming: neither pair is refused', () => {
    assert.strictEqual(skapiSupportsStreaming({}), false);
    // An SDK that predates streaming, whatever else it has, including the retired
    // forwardRequest an older skapi-js carries under the new family's main name.
    assert.strictEqual(skapiSupportsStreaming({ clientSecretRequest: fn, forwardRequest: fn }), false);
});

await test('skapiSupportsStreaming: half of each is not a pair', () => {
    assert.strictEqual(skapiSupportsStreaming({ forwardRequestStream: fn, clientSecretRequestFinalize: fn }), false);
    assert.strictEqual(skapiSupportsStreaming({ clientSecretRequestStream: fn, forwardRequestFinalize: fn }), false);
    assert.strictEqual(skapiSupportsStreaming({ forwardRequestStream: fn }), false);
    assert.strictEqual(skapiSupportsStreaming({ forwardRequestFinalize: fn }), false);
});

await test('skapiSupportsStreaming: the new names must be FUNCTIONS too', () => {
    assert.strictEqual(skapiSupportsStreaming({ forwardRequestStream: true, forwardRequestFinalize: true }), false);
    assert.strictEqual(skapiSupportsStreaming(null), false);
    assert.strictEqual(skapiSupportsStreaming('skapi'), false);
});

/* ══ 6. streamRecoveryEnabled: either reader arms it ══════════════════════ */

await test('streamRecoveryEnabled: the NEW reader arms recovery', () => {
    transportConfig(['new'], { forwardRequestStream: async () => ({}) });
    assert.strictEqual(streamRecoveryEnabled(), true);
});

await test('streamRecoveryEnabled: the OLD reader still does', () => {
    transportConfig(['old'], { clientSecretRequestStream: async () => ({}) });
    assert.strictEqual(streamRecoveryEnabled(), true);
});

await test('streamRecoveryEnabled: no reader under either name is no recovery', () => {
    transportConfig(['new', 'old'], { liveStreaming: true });
    assert.strictEqual(streamRecoveryEnabled(), false);
    transportConfig(['new'], { forwardRequestStream: undefined, clientSecretRequestStream: undefined });
    assert.strictEqual(streamRecoveryEnabled(), false);
});

await test('streamRecoveryEnabled: streamRecovery:false opts out whichever reader is there', () => {
    transportConfig(['new'], { streamRecovery: false, forwardRequestStream: async () => ({}) });
    assert.strictEqual(streamRecoveryEnabled(), false);
    transportConfig(['old'], { streamRecovery: false, clientSecretRequestStream: async () => ({}) });
    assert.strictEqual(streamRecoveryEnabled(), false);
});

await test('streamRecoveryEnabled: a GETTER is read at call time (agent.vue injects this way)', () => {
    let ready = false;
    transportConfig(['old'], {});
    const cfg = { mcpBaseUrl: 'x', clientSecretRequest: fn, clientSecretRequestHistory: fn };
    Object.defineProperty(cfg, 'forwardRequestStream', { get() { return ready ? async () => ({}) : undefined; }, enumerable: true });
    configureChatEngine(cfg);
    assert.strictEqual(streamRecoveryEnabled(), false);
    ready = true;
    assert.strictEqual(streamRecoveryEnabled(), true);
});

/* ══ 7. the session reads back and finalizes through the preferred keys ═══ */

function frame(obj) { return 'event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n'; }
const ANSWER = 'The sales table has 412 rows.';
const WHOLE =
    frame({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null } }) +
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } }) +
    frame({ type: 'content_block_stop', index: 0 }) +
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
    frame({ type: 'message_stop' });
const RESOLVED_ENVELOPE = { id: 'stamp:entropy', status: 'resolved', queue_name: 'u1', in_queue: 0, stream: true };

/** Both families' finalize and reader, each recording under its own name. */
function streamingConfig(families) {
    const calls = { newRead: [], oldRead: [], newFin: [], oldFin: [] };
    const reader = (bucket) => async (requestId, options) => {
        calls[bucket].push({ requestId, options });
        if (options.onStream) options.onStream(WHOLE, 1);
        return RESOLVED_ENVELOPE;
    };
    const finalizer = (bucket) => async (id, data, options) => { calls[bucket].push({ id, data, options }); return { finalized: true }; };
    const extra = { liveStreaming: true };
    if (families.includes('new')) { extra.forwardRequestStream = reader('newRead'); extra.forwardRequestFinalize = finalizer('newFin'); }
    if (families.includes('old')) { extra.clientSecretRequestStream = reader('oldRead'); extra.clientSecretRequestFinalize = finalizer('oldFin'); }
    transportConfig(families, extra);
    return calls;
}

function makeSession(messages) {
    const s = Object.create(ChatSession.prototype);
    s.state = { messages: messages, historyEndOfList: false, historyStartKeyHistory: [] };
    s.liveStreams = {};
    s.aiChatHistoryCache = {};
    s._identity = { platform: 'claude', projectId: 'p1', owner: 'o1', userId: 'u1' };
    s.host = {
        getIdentity: () => s._identity,
        notify: () => { },
        refreshMessageBubble: () => { },
        scrollToBottomIfSticky: () => { },
    };
    return s;
}
const recoverable = () => [
    { role: 'user', content: 'how many rows?', _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
    { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'stamp:entropy', _ownerKey: 'p1#claude#u1' },
];

await test('a recovered turn is READ through forwardRequestStream and FINALIZED through forwardRequestFinalize', async () => {
    const calls = streamingConfig(['new', 'old']);
    const s = makeSession(recoverable());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(30);
    assert.strictEqual(calls.newRead.length, 1, 'the new reader was not used');
    assert.strictEqual(calls.oldRead.length, 0, 'the deprecated reader was used although the new one was injected');
    assert.strictEqual(calls.newFin.length, 1, 'the new finalize was not used');
    assert.strictEqual(calls.oldFin.length, 0);
    assert.strictEqual(s.state.messages[1].content, ANSWER);
    assert.strictEqual(extractClaudeText(calls.newFin[0].data), ANSWER);
    assert.strictEqual(calls.newFin[0].options.service, 'p1');
});

await test('an old-keys-only host recovers and finalizes exactly as before', async () => {
    const calls = streamingConfig(['old']);
    const s = makeSession(recoverable());
    s._scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(30);
    assert.strictEqual(calls.oldRead.length, 1);
    assert.strictEqual(calls.oldFin.length, 1);
    assert.strictEqual(s.state.messages[1].content, ANSWER);
});

await test('a LIVE turn is finalized through forwardRequestFinalize', async () => {
    const calls = streamingConfig(['new', 'old']);
    const s = makeSession([
        { role: 'user', content: 'how many rows?', _serverItemId: 'stamp:entropy' },
        { role: 'assistant', content: '', isPending: true, isPendingInProcess: true, _serverItemId: 'stamp:entropy' },
    ]);
    const source = {
        poll(arg) {
            const p = new Promise((resolve) => {
                (async () => {
                    await sleep(5);
                    if (arg.onStream) arg.onStream(WHOLE, 1);
                    await sleep(20);
                    if (arg.onResponse) arg.onResponse(RESOLVED_ENVELOPE);
                    resolve(RESOLVED_ENVELOPE);
                })();
            });
            p.stop = () => { };
            return p;
        },
    };
    await s.attachForegroundPoll(source, 'stamp:entropy');
    assert.strictEqual(calls.newFin.length, 1);
    assert.strictEqual(calls.oldFin.length, 0);
    assert.strictEqual(extractClaudeText(calls.newFin[0].data), ANSWER);
});

/* ---- report --------------------------------------------------------------- */

let pass = 0;
for (const [ok, name, err] of results) {
    console.log((ok ? 'ok    ' : 'FAIL  ') + name + (err ? '\n        ' + err : ''));
    if (ok) pass++;
}
console.log('\n' + pass + '/' + results.length + ' passed');
process.exit(pass === results.length ? 0 : 1);

})();
