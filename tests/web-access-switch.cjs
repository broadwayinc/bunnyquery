/**
 * The chat's web switch (reliability plan 4.1, owner's decision D1).
 *
 * A chat answer used to be able to reach the open web on every turn: Claude's
 * web_fetch and OpenAI's web_search were on the tool list unconditionally, which
 * is one of the ways an answer that is not in the customer's data gets out. Now
 * they ride on a CHAT request only when the project's web switch is on.
 *
 * What this pins:
 *   - the switch is OFF by default: no option, no record, no web tool;
 *   - resolution: the project's `web_access` setting (bq::settings) is the
 *     CEILING and the host's `webAccess` option may only restrict below it,
 *     effective = projectSetting && hostOption !== false; only the literal true
 *     in the record turns it on, and a host's true on a project that is off has
 *     no effect (changed 2026-10-12 from "host option wins both ways");
 *   - the request builders await the settings record on the first turn and treat
 *     a failed read as off;
 *   - an INDEXING pass is untouched: it keeps web_fetch / web_search as it always
 *     did (the worker hands it rendered pages and extracted text, and the switch
 *     governs answers, not indexing);
 *   - the settings record round-trips the key beside the two it already held;
 *   - the chat prompt follows the tool list, so the model is never told to fetch
 *     with a tool it does not have.
 *
 * Run: node ./tests/web-access-switch.cjs
 */

const assert = require('assert');
const {
    configureChatEngine,
    callClaudeWithMcp,
    callClaudeWithPublicMcp,
    callOpenAIWithPublicMcp,
    notifyAgentSaveAttachment,
    configureProjectSettings,
    clearProjectSettings,
    setProjectSettings,
    patchProjectSettings,
    cachedProjectSettings,
    readyProjectSettings,
    webAccessEnabled,
    resolveWebAccess,
    webAccessFrom,
    normalizeWebAccess,
    projectWebAccess,
    DEFAULT_WEB_ACCESS,
    buildChatSystemPrompt,
    MCP_NAME,
} = require('../dist/engine.cjs');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

// Every request the engine makes, captured instead of sent.
let sent = [];
// The settings record per service, as the injected reader would find it.
let records = {};
let reads = 0;
function configure(webAccess) {
    sent = [];
    reads = 0;
    configureChatEngine(Object.assign({
        clientSecretRequest: (opts) => { sent.push(opts); return Promise.resolve({ id: 'req_1', status: 'resolved' }); },
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
    }, webAccess === undefined ? {} : { webAccess }));
    clearProjectSettings();
    configureProjectSettings(async (service) => {
        reads++;
        if (service === 'svc_locked') throw new Error('REQUIRE_LOGIN');
        return records[service] || null;
    });
}

const tools = () => sent[sent.length - 1].data.tools;
const hasMcp = (t) => t.some((x) => x && (x.type === 'mcp_toolset' || x.type === 'mcp'));
const hasWebFetch = (t) => t.some((x) => x && x.type === 'web_fetch_20250910');
const hasWebSearch = (t) => t.some((x) => x && x.type === 'web_search');

const claude = (service) => callClaudeWithPublicMcp('hi', service || 'svc_1', 'own_1', undefined, 'sys', 'claude-sonnet-5', 'usr_1');
const openai = (service) => callOpenAIWithPublicMcp('hi', service || 'svc_1', 'own_1', undefined, 'sys', 'gpt-5.6-luna', 'usr_1');

const ATTACHMENT = (platform) => ({
    platform, service: 'svc_1', owner: 'own_1', userId: 'usr_1',
    attachment: { name: 'notes.txt', storagePath: 'usr_1/notes.txt', mime: 'text/plain', size: 12, url: 'https://cdn.example.com/notes.txt' },
});

(async () => {

/* ---- off by default ------------------------------------------------------- */

await test('OFF by default: a Claude chat turn carries the MCP toolset and no web_fetch', async () => {
    records = {};
    configure(undefined);
    await claude();
    assert.ok(hasMcp(tools()), 'the MCP toolset must still be there');
    assert.strictEqual(hasWebFetch(tools()), false);
});

await test('OFF by default: an OpenAI chat turn carries the MCP tool and no web_search', async () => {
    records = {};
    configure(undefined);
    await openai();
    assert.ok(hasMcp(tools()));
    assert.strictEqual(hasWebSearch(tools()), false);
});

await test('DEFAULT_WEB_ACCESS is false, and the anthropic-beta header is left as it was', async () => {
    assert.strictEqual(DEFAULT_WEB_ACCESS, false);
    records = {};
    configure(undefined);
    await claude();
    // The header only makes the tool TYPE available; a request that does not list
    // the tool cannot use it, so there was no reason to touch it.
    assert.ok(/web-fetch-2025-09-10/.test(sent[0].headers['anthropic-beta']));
    assert.ok(/mcp-client/.test(sent[0].headers['anthropic-beta']));
});

/* ---- the project setting ---------------------------------------------------- */

await test('the project setting `web_access: true` attaches web_fetch (Claude) and web_search (OpenAI)', async () => {
    records = { svc_1: { upload_access_group: 'public', web_access: true } };
    configure(undefined);
    await claude();
    assert.ok(hasWebFetch(tools()));
    const wf = tools().find((t) => t.type === 'web_fetch_20250910');
    assert.strictEqual(wf.name, 'web_fetch');
    assert.strictEqual(wf.max_uses, 40);
    await openai();
    assert.ok(hasWebSearch(tools()));
    assert.strictEqual(tools().find((t) => t.type === 'web_search').external_web_access, true);
});

await test('only the literal true turns it on: "true", 1, "on" and false all read as off', async () => {
    for (const v of ['true', 1, 'on', false, null, undefined]) {
        records = { svc_1: { web_access: v } };
        configure(undefined);
        await claude();
        assert.strictEqual(hasWebFetch(tools()), false, `web_access ${JSON.stringify(v)} attached web_fetch`);
        await openai();
        assert.strictEqual(hasWebSearch(tools()), false, `web_access ${JSON.stringify(v)} attached web_search`);
    }
});

await test('the setting is read per project: one project on does not switch another on', async () => {
    records = { svc_on: { web_access: true }, svc_off: {} };
    configure(undefined);
    await claude('svc_on');
    assert.ok(hasWebFetch(tools()));
    await claude('svc_off');
    assert.strictEqual(hasWebFetch(tools()), false);
});

/* ---- the project setting is the ceiling; the host may only restrict ---------------- */

await test('the host option true does NOT raise a project that is unset or off', async () => {
    records = { svc_1: { web_access: false } };
    configure(true);
    await claude();
    assert.strictEqual(hasWebFetch(tools()), false, 'host true over setting false');
    await openai();
    assert.strictEqual(hasWebSearch(tools()), false);
    records = {};
    configure(true);
    await claude();
    assert.strictEqual(hasWebFetch(tools()), false, 'host true over no record');
});

await test('the host option true follows a project that is on', async () => {
    records = { svc_1: { web_access: true } };
    configure(true);
    await claude();
    assert.ok(hasWebFetch(tools()));
    await openai();
    assert.ok(hasWebSearch(tools()));
});

await test('the host option false restricts a setting that is on', async () => {
    records = { svc_1: { web_access: true } };
    configure(false);
    await claude();
    assert.strictEqual(hasWebFetch(tools()), false);
    await openai();
    assert.strictEqual(hasWebSearch(tools()), false);
});

await test('a host option that is not a boolean (null) is "follow the project"', async () => {
    records = { svc_1: { web_access: true } };
    configure(null);
    await claude();
    assert.ok(hasWebFetch(tools()), 'null must fall through to the project setting');
});

/* ---- first turn: the record is awaited; a failed read is off ----------------------- */

await test('the first turn AWAITS the settings record rather than reading a cold cache', async () => {
    records = { svc_1: { web_access: true } };
    configure(undefined);
    // Nothing primed: the cache is cold when the request is built.
    assert.strictEqual(webAccessEnabled('svc_1'), false, 'sync read of a cold cache is the default');
    await claude();
    assert.strictEqual(reads, 1, 'the builder fetched the record once');
    assert.ok(hasWebFetch(tools()), 'and used what it fetched');
    await openai();
    assert.strictEqual(reads, 1, 'the second turn used the cache');
    assert.strictEqual(webAccessEnabled('svc_1'), true, 'the sync read now sees it too');
});

await test('a read that fails (REQUIRE_LOGIN for a signed-out visitor) settles as off', async () => {
    configure(undefined);
    await claude('svc_locked');
    assert.strictEqual(hasWebFetch(tools()), false);
    assert.strictEqual(await resolveWebAccess('svc_locked'), false);
});

await test('resolveWebAccess: setting && option !== false; never rejects', async () => {
    records = { svc_1: { web_access: true } };
    configure(undefined);
    assert.strictEqual(await resolveWebAccess('svc_1'), true);
    assert.strictEqual(await resolveWebAccess('svc_none'), false);
    assert.strictEqual(await resolveWebAccess(''), false);
    configure(false);
    assert.strictEqual(await resolveWebAccess('svc_1'), false, 'host false restricts');
    configure(true);
    assert.strictEqual(await resolveWebAccess('svc_none'), false, 'host true cannot raise an unset project');
    assert.strictEqual(await resolveWebAccess('svc_1'), true, 'host true follows a project that is on');
    assert.strictEqual(await resolveWebAccess(''), false, 'no service is the default, whatever the host says');
    // The per-call override (a direct caller's `webAccess`) restricts the same way.
    configure(undefined);
    assert.strictEqual(await resolveWebAccess('svc_1', false), false);
    assert.strictEqual(await resolveWebAccess('svc_1', true), true);
    assert.strictEqual(await resolveWebAccess('svc_none', true), false);
});

await test('webAccessEnabled (sync): the CACHED setting && option !== false', async () => {
    records = {};
    configure(undefined);
    assert.strictEqual(webAccessEnabled('svc_1'), false);
    assert.strictEqual(webAccessEnabled(), false);
    setProjectSettings('svc_1', { web_access: true });
    assert.strictEqual(webAccessEnabled('svc_1'), true);
    assert.strictEqual(webAccessEnabled('svc_2'), false);
    configure(false);
    setProjectSettings('svc_1', { web_access: true });
    assert.strictEqual(webAccessEnabled('svc_1'), false);
    configure(true);
    assert.strictEqual(webAccessEnabled('svc_none'), false, 'host true cannot raise an unset project');
    setProjectSettings('svc_1', { web_access: true });
    assert.strictEqual(webAccessEnabled('svc_1'), true);
});

/* ---- a direct caller of callClaudeWithMcp ------------------------------------------ */

await test('callClaudeWithMcp: an explicit `webAccess` restricts under the same ceiling; omitted asks the engine', async () => {
    records = { svc_1: { web_access: true } };
    configure(undefined);
    const base = { prompt: 'hi', service: 'svc_1', owner: 'own_1', userId: 'usr_1', mcpServer: { name: MCP_NAME, url: 'https://mcp.example.com' } };
    await callClaudeWithMcp(Object.assign({}, base, { webAccess: false }));
    assert.strictEqual(hasWebFetch(tools()), false, 'explicit false with the setting on');
    await callClaudeWithMcp(base);
    assert.ok(hasWebFetch(tools()), 'omitted follows the setting');
    await callClaudeWithMcp(Object.assign({}, base, { webAccess: true }));
    assert.ok(hasWebFetch(tools()), 'explicit true with the setting on');
    records = {};
    configure(undefined);
    await callClaudeWithMcp(Object.assign({}, base, { webAccess: true }));
    assert.strictEqual(hasWebFetch(tools()), false, 'explicit true cannot raise a project with no record');
});

/* ---- indexing is untouched -------------------------------------------------------- */

await test('an INDEXING pass keeps web_fetch (Claude) with the switch off', async () => {
    records = {};
    configure(undefined);
    await notifyAgentSaveAttachment(ATTACHMENT('claude'));
    assert.strictEqual(sent.length, 1);
    assert.ok(hasWebFetch(tools()), 'indexing must keep the tool it had');
    assert.ok(hasMcp(tools()));
});

await test('an INDEXING pass keeps web_search (OpenAI) with the switch off', async () => {
    records = {};
    configure(undefined);
    await notifyAgentSaveAttachment(ATTACHMENT('openai'));
    assert.strictEqual(sent.length, 1);
    assert.ok(hasWebSearch(tools()));
    assert.ok(hasMcp(tools()));
});

await test('an INDEXING pass is the same with the host option false', async () => {
    records = {};
    configure(false);
    await notifyAgentSaveAttachment(ATTACHMENT('claude'));
    assert.ok(hasWebFetch(tools()));
    await notifyAgentSaveAttachment(ATTACHMENT('openai'));
    assert.ok(hasWebSearch(tools()));
});

/* ---- the settings record ------------------------------------------------------------ */

await test('the key round-trips in the record beside the two settings already there', async () => {
    records = {};
    configure(undefined);
    setProjectSettings('svc_x', { upload_access_group: 'public', chat_greeting: 'Hello' });
    assert.strictEqual(projectWebAccess('svc_x'), false, 'unset reads as off');
    patchProjectSettings('svc_x', { web_access: true });
    const data = cachedProjectSettings('svc_x');
    assert.deepStrictEqual(data, { upload_access_group: 'public', chat_greeting: 'Hello', web_access: true });
    assert.strictEqual(projectWebAccess('svc_x'), true);
    patchProjectSettings('svc_x', { web_access: false });
    assert.strictEqual(projectWebAccess('svc_x'), false);
    assert.strictEqual(cachedProjectSettings('svc_x').chat_greeting, 'Hello', 'the patch kept the other keys');
});

await test('the pure readers: webAccessFrom / normalizeWebAccess', async () => {
    assert.strictEqual(webAccessFrom(null), false);
    assert.strictEqual(webAccessFrom(undefined), false);
    assert.strictEqual(webAccessFrom({}), false);
    assert.strictEqual(webAccessFrom({ web_access: true }), true);
    assert.strictEqual(webAccessFrom({ web_access: 'true' }), false);
    assert.strictEqual(normalizeWebAccess(true), true);
    assert.strictEqual(normalizeWebAccess(1), false);
});

await test('a record fetched from the reader carries the key through readyProjectSettings', async () => {
    records = { svc_r: { web_access: true } };
    configure(undefined);
    const data = await readyProjectSettings('svc_r');
    assert.strictEqual(webAccessFrom(data), true);
    assert.strictEqual(projectWebAccess('svc_r'), true);
});

/* ---- the prompt follows the tool list --------------------------------------------------- */

await test('the prompt with the web OFF never tells the model to web_fetch a URL, and says there is no web tool', async () => {
    const off = buildChatSystemPrompt({ projectId: 'p', canUpload: true, client: 'widget' });
    assert.ok(!/use your web_fetch tool to download/.test(off));
    assert.ok(/this chat has NO web tool/.test(off));
    assert.ok(/this chat has no web tool\./.test(off));
    const offExplicit = buildChatSystemPrompt({ projectId: 'p', canUpload: true, client: 'widget', webAccess: false });
    assert.strictEqual(offExplicit, off, 'omitted and false are the same prompt');
});

await test('the prompt with the web ON keeps the web_fetch instruction for URL attachments', async () => {
    const on = buildChatSystemPrompt({ projectId: 'p', canUpload: true, client: 'widget', webAccess: true });
    assert.ok(/use your web_fetch tool to download and read each URL/.test(on));
    assert.ok(/WEB ACCESS IS ON for this project/.test(on));
    assert.ok(!/this chat has NO web tool/.test(on));
});

const failed = results.filter(r => !r[0]);
for (const [ok, name, why] of results) console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '\n      ' + why));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

})();
