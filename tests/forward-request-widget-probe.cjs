/**
 * The widget picks its skapi request family by the EMBEDDER's skapi-js, and never by
 * the name `forwardRequest`.
 *
 * The widget is handed the embedder's own skapi instance, pinned to whatever version
 * their page loads. skapi-js renamed clientSecretRequest and its companions to the
 * forwardRequest family, so a new SDK answers to both names and an old one only to
 * the old. The trap is that an OLD skapi-js also has a method called forwardRequest,
 * taking the same (form, options), and it is a different thing: the retired
 * streaming forwarder, which posts to another endpoint and injects the project's api
 * key. A presence check on forwardRequest says "new" for exactly the SDKs that are
 * old. So the widget asks for forwardRequestHistory, which only the new SDK has, in
 * ONE function (skapiHasForwardRequest), and every family-dependent call goes
 * through it: the engine transport, the queued-send cancel, and the Google code
 * exchange.
 *
 * The helpers live in the widget IIFE (src/index.js), which is a browser bundle with
 * no exports. They touch nothing but `S`, so they are lifted out of the source text
 * and run against fake skapi instances shaped like the real SDKs. The lift asserts
 * its own markers, so a rename fails this test loudly rather than passing on
 * nothing. The fakes are modelled on the builds actually on disk: skapi-js 2.0.5
 * (what www.bunnyquery.com installs) has forwardRequest with apiKeyHeader and no
 * forwardRequestHistory.
 *
 * Run: node ./tests/forward-request-widget-probe.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../dist/engine.cjs');
const { configureChatEngine, listClaudeModels, getChatHistory, skapiSupportsStreaming, streamRecoveryEnabled } = engine;

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

/* ---- lift the family helpers out of the widget source ---------------------- */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const HELPERS = ['skapiHasForwardRequest', 'skapiForwardWithSecret', 'skapiCancelRequest', 'skapiEngineTransport'];

function lift(name) {
    const open = '\n    function ' + name + '(';
    const start = SRC.indexOf(open);
    assert.notStrictEqual(start, -1, name + ' not found in src/index.js');
    assert.strictEqual(SRC.indexOf(open, start + 1), -1, name + ' is defined twice');
    const close = '\n    }\n';                // the function's own 4-space closing brace
    const end = SRC.indexOf(close, start + open.length);
    assert.notStrictEqual(end, -1, 'could not find the end of ' + name);
    return SRC.slice(start + 1, end + close.length - 1);
}
const LIFTED = HELPERS.map(lift);
LIFTED.forEach((block, i) => assert.ok(block.trimStart().startsWith('function ' + HELPERS[i] + '(') && block.endsWith('}'),
    'lifted the wrong block for ' + HELPERS[i]));

/** The four helpers, closed over a fresh `S` holding the given skapi instance. */
function widgetWith(skapi) {
    return new Function('S', LIFTED.join('\n') + '\nreturn { ' + HELPERS.join(', ') + ' };')({ skapi: skapi });
}

/* ---- fake SDKs, each recording which NAME was called ----------------------- */

function recorder(calls, name, result) {
    return function () { calls.push({ name: name, args: Array.prototype.slice.call(arguments) }); return Promise.resolve(result); };
}

/** skapi-js 2.0.5: the old family, plus the RETIRED forwardRequest. */
function oldSdk(opts) {
    const calls = [];
    const sk = {
        calls: calls,
        // The retired streaming forwarder. Reaching it at all is the bug.
        forwardRequest: recorder(calls, 'RETIRED forwardRequest', { wrong: true }),
        clientSecretRequest: recorder(calls, 'clientSecretRequest', { access_token: 'tok' }),
        clientSecretRequestHistory: recorder(calls, 'clientSecretRequestHistory', { list: [] }),
        cancelClientSecretRequest: recorder(calls, 'cancelClientSecretRequest', { removed: true }),
        stopClientSecretPolling: recorder(calls, 'stopClientSecretPolling'),
        clientSecretRequestQueueCount: recorder(calls, 'clientSecretRequestQueueCount'),
    };
    if (!opts || opts.stream !== false) {
        sk.clientSecretRequestStream = recorder(calls, 'clientSecretRequestStream', {});
        sk.clientSecretRequestFinalize = recorder(calls, 'clientSecretRequestFinalize', {});
    }
    return sk;
}

/** The renamed skapi-js: the new family, with every old name kept as an alias. */
function newSdk() {
    const calls = [];
    const sk = oldSdk();
    sk.calls = calls;
    for (const k of Object.keys(sk)) if (typeof sk[k] === 'function') sk[k] = recorder(calls, k, { access_token: 'tok' });
    Object.assign(sk, {
        forwardRequest: recorder(calls, 'forwardRequest', { access_token: 'tok' }),
        forwardRequestHistory: recorder(calls, 'forwardRequestHistory', { list: [] }),
        forwardRequestStream: recorder(calls, 'forwardRequestStream', {}),
        forwardRequestFinalize: recorder(calls, 'forwardRequestFinalize', {}),
        cancelForwardRequest: recorder(calls, 'cancelForwardRequest', { removed: true }),
        stopForwardRequestPolling: recorder(calls, 'stopForwardRequestPolling'),
        forwardRequestQueueCount: recorder(calls, 'forwardRequestQueueCount'),
    });
    return sk;
}

const names = (sk) => sk.calls.map((c) => c.name);
const OLD_KEYS = ['clientSecretRequest', 'clientSecretRequestHistory', 'clientSecretRequestFinalize', 'clientSecretRequestStream'];
const NEW_KEYS = ['forwardRequest', 'forwardRequestHistory', 'forwardRequestFinalize', 'forwardRequestStream'];
const CANCEL = { url: 'u', method: 'POST', id: 'i', queue: 'q', service: 's', owner: 'o' };
const TOKEN_REQUEST = {
    url: 'https://oauth2.googleapis.com/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: { code: 'c', client_secret: '$CLIENT_SECRET', grant_type: 'authorization_code' },
};

(async () => {

/* ══ the probe ════════════════════════════════════════════════════════════ */

await test('THE TRAP: an old SDK with the retired forwardRequest but no forwardRequestHistory is OLD', () => {
    assert.strictEqual(widgetWith(oldSdk()).skapiHasForwardRequest(oldSdk()), false);
});

await test('the renamed SDK is new', () => {
    assert.strictEqual(widgetWith(newSdk()).skapiHasForwardRequest(newSdk()), true);
});

await test('forwardRequestHistory alone is not enough: forwardRequest is what gets called', () => {
    const w = widgetWith(null);
    assert.strictEqual(w.skapiHasForwardRequest({ forwardRequestHistory: () => { } }), false);
    assert.strictEqual(w.skapiHasForwardRequest({ forwardRequestHistory: true, forwardRequest: () => { } }), false);
});

await test('nothing at all is old, without throwing', () => {
    const w = widgetWith(null);
    for (const v of [null, undefined, 0, '', 'skapi', {}]) assert.strictEqual(w.skapiHasForwardRequest(v), false);
});

/* ══ the engine transport: one family, chosen by the probe ═════════════════ */

await test('an OLD SDK is handed to the engine under the OLD keys only, exactly as before', () => {
    const sk = oldSdk();
    const t = widgetWith(sk).skapiEngineTransport(skapiSupportsStreaming(sk));
    assert.deepStrictEqual(Object.keys(t).sort(), OLD_KEYS.slice().sort());
    for (const k of OLD_KEYS) assert.strictEqual(typeof t[k], 'function', k + ' was not wired');
    for (const k of NEW_KEYS) assert.ok(!(k in t), k + ' was injected for an old SDK');
});

await test('and every call through it reaches the old names, never the retired forwardRequest', async () => {
    const sk = oldSdk();
    const t = widgetWith(sk).skapiEngineTransport(true);
    await t.clientSecretRequest({ clientSecretName: 'claude', url: 'u', method: 'POST' });
    await t.clientSecretRequestHistory({ url: 'u', method: 'POST' }, { limit: 1 });
    await t.clientSecretRequestFinalize('id', { a: 1 }, { url: 'u', method: 'POST' });
    await t.clientSecretRequestStream('id', { url: 'u', method: 'POST' });
    assert.deepStrictEqual(names(sk), OLD_KEYS);
});

await test('a NEW SDK is handed to the engine under the NEW keys only', async () => {
    const sk = newSdk();
    const t = widgetWith(sk).skapiEngineTransport(skapiSupportsStreaming(sk));
    assert.deepStrictEqual(Object.keys(t).sort(), NEW_KEYS.slice().sort());
    await t.forwardRequest(null, { secretName: 'claude', url: 'u', method: 'POST' });
    await t.forwardRequestHistory({ url: 'u', method: 'POST' }, {});
    await t.forwardRequestFinalize('id', {}, { url: 'u', method: 'POST' });
    await t.forwardRequestStream('id', { url: 'u', method: 'POST' });
    assert.deepStrictEqual(names(sk), NEW_KEYS);
    assert.strictEqual(sk.calls[0].args[0], null, 'the form argument was not passed through');
});

await test('an SDK too old to stream gets no finalize and no reader, under either family', () => {
    const sk = oldSdk({ stream: false });
    const canStream = skapiSupportsStreaming(sk);
    assert.strictEqual(canStream, false);
    const t = widgetWith(sk).skapiEngineTransport(canStream);
    assert.strictEqual(t.clientSecretRequestFinalize, undefined);
    assert.strictEqual(t.clientSecretRequestStream, undefined);
    assert.strictEqual(typeof t.clientSecretRequest, 'function');
    const tn = widgetWith(newSdk()).skapiEngineTransport(false);
    assert.strictEqual(tn.forwardRequestFinalize, undefined);
    assert.strictEqual(tn.forwardRequestStream, undefined);
});

await test('END TO END, old SDK: a chat request reaches clientSecretRequest with clientSecretName', async () => {
    const sk = oldSdk();
    const t = widgetWith(sk).skapiEngineTransport(skapiSupportsStreaming(sk));
    configureChatEngine(Object.assign({ mcpBaseUrl: 'https://mcp.example.com', poll: 0 }, t));
    await listClaudeModels('svc_1', 'own_1');
    await getChatHistory({ platform: 'claude', service: 'svc_1', owner: 'own_1' }, {});
    assert.deepStrictEqual(names(sk), ['clientSecretRequest', 'clientSecretRequestHistory']);
    const opts = sk.calls[0].args[0];
    assert.strictEqual(sk.calls[0].args.length, 1);
    assert.strictEqual(opts.clientSecretName, 'claude');
    assert.ok(!('secretName' in opts));
    assert.strictEqual(opts.service, 'svc_1');
    assert.strictEqual(opts.owner, 'own_1');
    assert.strictEqual(streamRecoveryEnabled(), true, 'the old reader must still arm recovery');
});

await test('END TO END, new SDK: a chat request reaches forwardRequest(null, {secretName})', async () => {
    const sk = newSdk();
    const t = widgetWith(sk).skapiEngineTransport(skapiSupportsStreaming(sk));
    configureChatEngine(Object.assign({ mcpBaseUrl: 'https://mcp.example.com', poll: 0 }, t));
    await listClaudeModels('svc_1', 'own_1');
    await getChatHistory({ platform: 'claude', service: 'svc_1', owner: 'own_1' }, {});
    assert.deepStrictEqual(names(sk), ['forwardRequest', 'forwardRequestHistory']);
    const [form, opts] = sk.calls[0].args;
    assert.strictEqual(form, null);
    assert.strictEqual(opts.secretName, 'claude');
    assert.ok(!('clientSecretName' in opts));
    assert.strictEqual(opts.service, 'svc_1');
    assert.strictEqual(opts.owner, 'own_1');
    assert.strictEqual(streamRecoveryEnabled(), true);
});

/* ══ the probe against the REAL SDK builds, when they are on disk ════════ */

// The fakes above are modelled on these; this checks the model. Only the class
// prototype is read, so nothing is constructed and nothing touches the network.
// SKIPS rather than fails when a checkout is absent, because this package is also
// published and tested on its own.
const REAL_SDKS = [
    ['skapi-js 2.0.5, as www.bunnyquery.com installs it', '../../www.bunnyquery.com/node_modules/skapi-js/dist/skapi.cjs', false],
    ['skapi-js 2.0.2, as www.skapi.com installs it', '../../www.skapi.com/node_modules/skapi-js/dist/skapi.cjs', false],
    ['the local skapi-js build carrying the rename', '../../skapi-js/dist/skapi.cjs', true],
];
for (const [label, rel, isNew] of REAL_SDKS) {
    const file = path.resolve(__dirname, rel);
    const name = 'real ' + label + ': probe says ' + (isNew ? 'NEW' : 'OLD');
    let proto = null;
    try {
        const m = require(file);
        const Skapi = m.Skapi || (m.default && m.default.Skapi) || m.default;
        proto = Skapi && Skapi.prototype;
    } catch (e) { proto = null; }
    // A local build is only "the rename" once it has been rebuilt with it.
    if (proto && isNew && typeof proto.forwardRequestHistory !== 'function') proto = null;
    if (!proto) { results.push([true, name + ' (SKIPPED: not on disk)']); continue; }
    await test(name, () => {
        const inst = Object.create(proto);
        if (!isNew) {
            // The trap itself, confirmed on the real build: forwardRequest is there.
            assert.strictEqual(typeof inst.forwardRequest, 'function', 'expected the retired forwardRequest on this build');
        }
        assert.strictEqual(widgetWith(inst).skapiHasForwardRequest(inst), isNew);
        // The renamed build carries both pairs, so streaming stays granted after the rename.
        if (isNew) assert.strictEqual(skapiSupportsStreaming(inst), true);
    });
}

/* ══ the cancel and the Google exchange ask the same probe ════════════════ */

await test('cancel: cancelClientSecretRequest on an old SDK', async () => {
    const sk = oldSdk();
    await widgetWith(sk).skapiCancelRequest(CANCEL);
    assert.deepStrictEqual(names(sk), ['cancelClientSecretRequest']);
    assert.deepStrictEqual(sk.calls[0].args, [CANCEL]);
});

await test('cancel: cancelForwardRequest on a new SDK', async () => {
    const sk = newSdk();
    await widgetWith(sk).skapiCancelRequest(CANCEL);
    assert.deepStrictEqual(names(sk), ['cancelForwardRequest']);
    assert.deepStrictEqual(sk.calls[0].args, [CANCEL]);
});

await test('Google exchange, old SDK: the exact call the widget always made', async () => {
    const sk = oldSdk();
    const res = await widgetWith(sk).skapiForwardWithSecret('ggl', TOKEN_REQUEST);
    assert.deepStrictEqual(names(sk), ['clientSecretRequest'], 'the retired forwardRequest was reached');
    const opts = sk.calls[0].args[0];
    assert.strictEqual(sk.calls[0].args.length, 1);
    assert.deepStrictEqual(Object.keys(opts), ['clientSecretName', 'url', 'method', 'headers', 'data']);
    assert.deepStrictEqual(opts, Object.assign({ clientSecretName: 'ggl' }, TOKEN_REQUEST));
    assert.strictEqual(res.access_token, 'tok');
});

await test('Google exchange, new SDK: forwardRequest(null, {secretName, ...})', async () => {
    const sk = newSdk();
    await widgetWith(sk).skapiForwardWithSecret('ggl', TOKEN_REQUEST);
    assert.deepStrictEqual(names(sk), ['forwardRequest']);
    const [form, opts] = sk.calls[0].args;
    assert.strictEqual(form, null);
    assert.deepStrictEqual(opts, Object.assign({ secretName: 'ggl' }, TOKEN_REQUEST));
});

/* ══ and nothing in the widget goes around the probe ══════════════════════ */

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

await test('no call to either family outside the four helpers', () => {
    let rest = SRC;
    for (const block of LIFTED) rest = rest.replace(block, '');
    const direct = stripComments(rest).match(/S\.skapi\.(forwardRequest\w*|clientSecretRequest\w*|cancelForwardRequest|cancelClientSecretRequest|stopForwardRequestPolling|stopClientSecretPolling)\b/g);
    assert.strictEqual(direct, null, 'called around the probe: ' + (direct || []).join(', '));
});

await test('the call sites are wired to the helpers', () => {
    const code = stripComments(SRC);
    assert.ok(/cancelRequest:\s*function\s*\(opts\)\s*\{\s*return skapiCancelRequest\(opts\);\s*\}/.test(code), 'the session host does not cancel through skapiCancelRequest');
    assert.ok(/configureChatEngine\(Object\.assign\(\{[\s\S]*?\},\s*skapiEngineTransport\(canStream\)\)\);/.test(code), 'configureChatEngine is not given skapiEngineTransport(canStream)');
    const google = code.slice(code.indexOf('function completeGoogleOAuthReturn()'));
    assert.ok(/return skapiForwardWithSecret\(secretName,/.test(google.slice(0, google.indexOf('\n    }\n'))), 'the Google exchange does not go through skapiForwardWithSecret');
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
