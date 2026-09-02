/**
 * The two `stream` flags of a streamed chat turn, and the three call sites that
 * must never carry them.
 *
 * The failure this file exists to prevent is the one the SDK documents as quiet:
 * skapi relays bytes and knows no vendor, so it cannot notice that a request asked
 * the DESTINATION to stream while asking skapi to buffer (the row then stores an
 * SSE transcript where extractClaudeText expects a document, and the turn reads
 * back as an empty answer), nor the opposite (skapi chops one plain document into
 * chunks, the frame parser finds no framing, and the row settles with a status and
 * no body). Neither shows up as an error anywhere. So the pair is produced by one
 * function from one boolean, and these tests hold every builder to it.
 *
 * The three that must stay buffered are here for concrete reasons, not tidiness:
 * an indexing pass's reply is READ BY THE WORKER (auto_continue decides whether to
 * enqueue the next window from it, and the truncation / auth-outage checks parse
 * it), and the model listings are plain GETs with no body to put a flag in.
 *
 * Run: node ./tests/live-stream-wiring.cjs
 */

const assert = require('assert');
const engine = require('../dist/engine.cjs');
const {
    configureChatEngine,
    chatStreamWiring,
    callClaudeWithPublicMcp,
    callOpenAIWithPublicMcp,
    notifyAgentSaveAttachment,
    listClaudeModels,
    listOpenAIModels,
    shouldRescueInFlightMessage,
} = engine;

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

// Every clientSecretRequest the engine makes, captured instead of sent.
let sent = [];
function configure(liveStreaming) {
    sent = [];
    configureChatEngine({
        clientSecretRequest: (opts) => { sent.push(opts); return Promise.resolve({ id: 'req_1', status: 'resolved' }); },
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
        liveStreaming: liveStreaming,
    });
}

const ATTACHMENT = {
    platform: 'claude', service: 'svc_1', owner: 'own_1', userId: 'usr_1',
    attachment: { name: 'notes.txt', storagePath: 'usr_1/notes.txt', mime: 'text/plain', size: 12, url: 'https://cdn.example.com/notes.txt' },
};

/** The invariant, stated once: a request carries BOTH flags or NEITHER. */
function assertPaired(opts, label) {
    const transport = Object.prototype.hasOwnProperty.call(opts, 'stream');
    const body = !!opts.data && Object.prototype.hasOwnProperty.call(opts.data, 'stream');
    assert.strictEqual(transport, body,
        `${label}: transport stream=${transport} but body stream=${body} — the pair split`);
}

(async () => {

await test('OFF by default: neither flag on a Claude chat turn', async () => {
    configure(undefined);
    await callClaudeWithPublicMcp('hi', 'svc_1', 'own_1');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual('stream' in sent[0], false);
    assert.strictEqual('stream' in sent[0].data, false);
});

await test('OFF by default: neither flag on an OpenAI chat turn', async () => {
    configure(undefined);
    await callOpenAIWithPublicMcp('hi', 'svc_1', 'own_1');
    assert.strictEqual('stream' in sent[0], false);
    assert.strictEqual('stream' in sent[0].data, false);
});

await test('ON: a Claude chat turn carries BOTH, and the body one is top level', async () => {
    configure(true);
    await callClaudeWithPublicMcp('hi', 'svc_1', 'own_1');
    assert.strictEqual(sent[0].stream, true, 'skapi relay flag missing');
    assert.strictEqual(sent[0].data.stream, true, 'Anthropic body flag missing');
    // Beside model/messages/mcp_servers, which is where the Messages API takes it.
    assert.ok('model' in sent[0].data && 'messages' in sent[0].data && 'mcp_servers' in sent[0].data);
});

await test('ON: an OpenAI chat turn carries BOTH, and the body one is top level', async () => {
    configure(true);
    await callOpenAIWithPublicMcp('hi', 'svc_1', 'own_1');
    assert.strictEqual(sent[0].stream, true);
    assert.strictEqual(sent[0].data.stream, true);
    // Beside model/input/tools, which is where the Responses API takes it.
    assert.ok('model' in sent[0].data && 'input' in sent[0].data && 'tools' in sent[0].data);
});

await test('the pair never splits, on either platform, in either mode', async () => {
    for (const on of [false, true]) {
        configure(on);
        await callClaudeWithPublicMcp('hi', 'svc_1', 'own_1');
        await callOpenAIWithPublicMcp('hi', 'svc_1', 'own_1');
        sent.forEach((o, i) => assertPaired(o, `liveStreaming=${on} request ${i}`));
    }
});

await test('an ATTACHMENT turn (bg queue) stays buffered even with the flag on', async () => {
    // A streamed row keeps no body, and the re-attach loop polls everything on the bg
    // queue WITHOUT a reader, so after a reload such a turn would settle on an empty
    // envelope with its answer unrecoverable.
    configure(true);
    await callClaudeWithPublicMcp('hi', 'svc_1', 'own_1', undefined, undefined, undefined, 'usr_1-bg');
    assert.strictEqual('stream' in sent[0], false);
    assert.strictEqual('stream' in sent[0].data, false);
    // ...while the very same turn on the ordinary chat queue does stream.
    configure(true);
    await callClaudeWithPublicMcp('hi', 'svc_1', 'own_1', undefined, undefined, undefined, 'usr_1');
    assert.strictEqual(sent[0].stream, true);
    assert.strictEqual(sent[0].data.stream, true);
});

await test('chatStreamWiring is the ONE producer and hands back both halves together', () => {
    configure(true);
    const w = chatStreamWiring('usr_1');
    assert.strictEqual(w.transport.stream, true);
    assert.strictEqual(w.body.stream, true);
    configure(false);
    const off = chatStreamWiring('usr_1');
    assert.strictEqual('stream' in off.transport, false);
    assert.strictEqual('stream' in off.body, false);
});

await test('INDEXING never streams, even with the flag on (Claude)', async () => {
    configure(true);
    await notifyAgentSaveAttachment(ATTACHMENT);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual('stream' in sent[0], false, 'an indexing pass asked skapi to relay');
    assert.strictEqual('stream' in sent[0].data, false, 'an indexing pass asked the destination to stream');
});

await test('INDEXING never streams, even with the flag on (OpenAI)', async () => {
    configure(true);
    await notifyAgentSaveAttachment(Object.assign({}, ATTACHMENT, { platform: 'openai' }));
    assert.strictEqual('stream' in sent[0], false);
    assert.strictEqual('stream' in sent[0].data, false);
});

await test('an indexing pass still carries the directives the worker parses out of the reply', async () => {
    // The reason indexing must not stream, stated as an assertion: this pass goes to
    // the bg queue and its response is the worker's input, not a bubble's.
    configure(true);
    await notifyAgentSaveAttachment(ATTACHMENT);
    assert.ok(String(sent[0].queue).endsWith('-bg'), 'indexing must run on the background queue');
});

await test('MODEL LISTINGS never stream and have no body at all', async () => {
    configure(true);
    await listClaudeModels('svc_1', 'own_1');
    await listOpenAIModels('svc_1', 'own_1');
    assert.strictEqual(sent.length, 2);
    for (const o of sent) {
        assert.strictEqual(o.method, 'GET');
        assert.strictEqual('stream' in o, false);
        assert.strictEqual(o.data, undefined, 'a GET listing has no body to put the second flag in');
    }
});

await test('a streaming bubble with no server id survives a history refetch', () => {
    // Nothing in a freshly fetched page can stand for it: the page identifies turns
    // by id and this one has none yet. Dropping it leaves the stream painting into
    // nothing, so the turn sits on "Thinking..." with every relayed byte spent.
    const m = { role: 'assistant', content: 'half an ans', isPending: true, _streaming: true };
    const kept = shouldRescueInFlightMessage(m, {
        hasServerId: () => false, pageHasPendingAssistant: true, sending: true, next: undefined,
    });
    assert.strictEqual(kept, true);
});

await test('once it HAS an id, the page copy wins and the local one is not rescued', () => {
    // The painter finds the mapped placeholder by _serverItemId on its next paint,
    // so rescuing as well would put the same turn on screen twice.
    const m = { role: 'assistant', content: 'half an ans', isPending: true, _streaming: true, _serverItemId: 'i1' };
    const kept = shouldRescueInFlightMessage(m, {
        hasServerId: (sid) => sid === 'i1', pageHasPendingAssistant: true, sending: true, next: undefined,
    });
    assert.strictEqual(kept, false);
});

const failed = results.filter(r => !r[0]);
results.forEach(r => console.log(r[0] ? 'ok    ' + r[1] : 'FAIL  ' + r[1] + '\n      ' + r[2]));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

})();
