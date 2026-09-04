/**
 * Where an anonymous chat turn's MCP tools point.
 *
 * A signed-in turn registers the MCP server with the literal '$ACCESS_TOKEN',
 * which the backend substitutes from the caller's `x-access-token` header before
 * the request leaves for the provider. An ANONYMOUS visitor sends no such header,
 * so that substitution produces an EMPTY credential: `authorization_token: ""`
 * for Claude, `"Bearer "` for OpenAI.
 *
 * That is not a harmless no-op. The MCP server cannot identify a project from an
 * empty token, so every tool call comes back 401; and the polling worker treats a
 * pass whose calls ALL failed that way as an MCP auth outage and stops the chain.
 * A provider that validates the field would reject the whole request even earlier.
 * The visible symptom would be a chat that looks like it works and can never
 * answer a question about the project.
 *
 * So an anonymous turn points at the project-scoped route `/p/<project id>` and
 * sends NO credential at all. This file pins both halves of that, and pins that
 * the signed-in shape is untouched.
 *
 * Run: node ./tests/anonymous-mcp-endpoint.cjs
 */

const assert = require('assert');
const { configureChatEngine, callClaudeWithPublicMcp, callOpenAIWithPublicMcp } = require('../dist/engine.cjs');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

const MCP_BASE = 'https://mcp.broadwayinc.computer';
const SERVICE = 'us31rawregionalcode';
const PUBLIC_ID = 'abc123-xyz789';

// Captures the request body the engine would have sent, instead of sending it.
let lastRequest = null;
configureChatEngine({
    clientSecretRequest: (opts) => { lastRequest = opts; return Promise.resolve({ id: 'x' }); },
    clientSecretRequestHistory: () => Promise.resolve({ list: [] }),
    mcpBaseUrl: MCP_BASE,
    poll: 0,
});

const claude = (mcpScope) => callClaudeWithPublicMcp(
    'hello', SERVICE, 'owner-1', undefined, 'sys', 'claude-sonnet-5', 'user-1',
    undefined, undefined, undefined, undefined, mcpScope,
);

const openai = (mcpScope) => callOpenAIWithPublicMcp(
    'hello', SERVICE, 'owner-1', undefined, 'sys', 'gpt-5.6-luna', 'user-1',
    undefined, undefined, undefined, undefined, mcpScope,
);

const claudeMcp = () => lastRequest.data.mcp_servers[0];
const openaiMcp = () => lastRequest.data.tools.find((t) => t.type === 'mcp');

/**
 * The ROUTE an MCP url points at, with the query stripped.
 *
 * These assertions are about which endpoint and which credential, and a query string is
 * neither: the url now carries a `?ctx=<context window>` hint that tells the server how
 * large a page of a paginated result this model can take. Comparing whole strings made
 * every one of these tests fail the day that hint was added, which is a test failing for
 * a reason it was never about. The hint has assertions of its own below.
 *
 * The trailing slash is dropped too. A url with a query needs an explicit path before it
 * ("https://host/?ctx=1") because an authority with a query and no path is normalised
 * inconsistently by intermediaries, so the route is "https://host" either way.
 */
const routeOf = (url) => String(url).split('?')[0].replace(/\/$/, '');
const ctxOf = (url) => new URL(String(url)).searchParams.get('ctx');

(async () => {

/* ---- signed in: unchanged ----------------------------------------------- */

await test('Claude, signed in: root endpoint and the $ACCESS_TOKEN placeholder', async () => {
    await claude(undefined);
    assert.strictEqual(routeOf(claudeMcp().url), MCP_BASE);
    assert.strictEqual(claudeMcp().authorization_token, '$ACCESS_TOKEN');
});

await test('OpenAI, signed in: root endpoint and the Bearer placeholder', async () => {
    await openai(undefined);
    assert.strictEqual(routeOf(openaiMcp().server_url), MCP_BASE);
    assert.strictEqual(openaiMcp().headers.Authorization, 'Bearer $ACCESS_TOKEN');
});

await test('an explicit anonymous:false is the signed-in shape', async () => {
    await claude({ anonymous: false, publicProjectId: PUBLIC_ID });
    assert.strictEqual(routeOf(claudeMcp().url), MCP_BASE);
    assert.strictEqual(claudeMcp().authorization_token, '$ACCESS_TOKEN');
});

/* ---- anonymous: project-scoped, no credential --------------------------- */

await test('Claude, anonymous: the project-scoped route', async () => {
    await claude({ anonymous: true, publicProjectId: PUBLIC_ID });
    assert.strictEqual(routeOf(claudeMcp().url), MCP_BASE + '/p/' + PUBLIC_ID);
});

await test('Claude, anonymous: NO authorization_token key at all', async () => {
    await claude({ anonymous: true, publicProjectId: PUBLIC_ID });
    // Not "empty string": the key must be absent, or the backend substitutes
    // the placeholder into a credential the server then rejects.
    assert.ok(!('authorization_token' in claudeMcp()),
        'authorization_token was sent: ' + JSON.stringify(claudeMcp()));
});

await test('OpenAI, anonymous: the project-scoped route', async () => {
    await openai({ anonymous: true, publicProjectId: PUBLIC_ID });
    assert.strictEqual(routeOf(openaiMcp().server_url), MCP_BASE + '/p/' + PUBLIC_ID);
});

await test('OpenAI, anonymous: NO headers block at all', async () => {
    await openai({ anonymous: true, publicProjectId: PUBLIC_ID });
    assert.strictEqual(openaiMcp().headers, undefined,
        'headers were sent: ' + JSON.stringify(openaiMcp().headers));
});

await test('the literal $ACCESS_TOKEN appears nowhere in an anonymous body', async () => {
    await claude({ anonymous: true, publicProjectId: PUBLIC_ID });
    assert.ok(!JSON.stringify(lastRequest).includes('$ACCESS_TOKEN'));
    await openai({ anonymous: true, publicProjectId: PUBLIC_ID });
    assert.ok(!JSON.stringify(lastRequest).includes('$ACCESS_TOKEN'));
});

/* ---- the page-size hint ------------------------------------------------- */

await test('THE CONTEXT-WINDOW HINT RIDES ON EVERY MCP URL', async () => {
    // What it is for: the server slices paginated results into pages and the model spends
    // one round trip per page. It cannot see which model is on the connection, so it is
    // told, and a million-token model then reads a 1000-record result in 13 round trips
    // instead of 74. Absent, the server falls back to the page size it always used, which
    // is why this is a hint on the url rather than a required field.
    await claude(undefined);
    assert.strictEqual(ctxOf(claudeMcp().url), '1000000', 'claude-sonnet-5 window');
    await openai(undefined);
    assert.strictEqual(ctxOf(openaiMcp().server_url), '1050000', 'gpt-5.6-luna window');
});

await test('the hint is the window of the model on THAT call, not a constant', async () => {
    // Each platform resolves against its own model table. A claude window sent on an
    // openai connection (or vice versa) would size every page against the wrong model.
    await callClaudeWithPublicMcp('hello', SERVICE, 'owner-1', undefined, 'sys',
        'claude-haiku-4-5', 'user-1', undefined, undefined, undefined, undefined, undefined);
    assert.strictEqual(ctxOf(claudeMcp().url), '200000', 'claude-haiku-4-5 window');
    await callOpenAIWithPublicMcp('hello', SERVICE, 'owner-1', undefined, 'sys',
        'gpt-4o', 'user-1', undefined, undefined, undefined, undefined, undefined);
    assert.strictEqual(ctxOf(openaiMcp().server_url), '128000', 'gpt-4o window');
});

await test('an anonymous turn gets the hint too', async () => {
    // It runs on the same model and reads the same paginated results; leaving it off would
    // give the one session with no account the slowest paging in the product.
    await claude({ anonymous: true, publicProjectId: PUBLIC_ID });
    assert.strictEqual(ctxOf(claudeMcp().url), '1000000');
    // ...and the project route still parses as a route, with the query attached.
    assert.strictEqual(new URL(claudeMcp().url).pathname, '/p/' + PUBLIC_ID);
});

/* ---- the route must carry a usable project id --------------------------- */

await test('the PUBLIC compound id is used, not the raw regional code', async () => {
    await claude({ anonymous: true, publicProjectId: PUBLIC_ID });
    assert.ok(routeOf(claudeMcp().url).endsWith('/p/' + PUBLIC_ID));
    // The server route only matches `<alnum>-<alnum>`; the raw code has no dash,
    // so falling back to it would 404 rather than silently widening anything.
    assert.ok(/\/p\/[0-9A-Za-z]+-[0-9A-Za-z]+$/.test(routeOf(claudeMcp().url)), claudeMcp().url);
});

await test('with no public id it falls back to the service id rather than a bare /p/', async () => {
    await claude({ anonymous: true });
    assert.strictEqual(routeOf(claudeMcp().url), MCP_BASE + '/p/' + SERVICE);
});

await test('a trailing slash on the base does not produce a double slash', async () => {
    configureChatEngine({
        clientSecretRequest: (opts) => { lastRequest = opts; return Promise.resolve({ id: 'x' }); },
        clientSecretRequestHistory: () => Promise.resolve({ list: [] }),
        mcpBaseUrl: MCP_BASE + '/',
        poll: 0,
    });
    await claude({ anonymous: true, publicProjectId: PUBLIC_ID });
    assert.strictEqual(routeOf(claudeMcp().url), MCP_BASE + '/p/' + PUBLIC_ID);
    configureChatEngine({
        clientSecretRequest: (opts) => { lastRequest = opts; return Promise.resolve({ id: 'x' }); },
        clientSecretRequestHistory: () => Promise.resolve({ list: [] }),
        mcpBaseUrl: MCP_BASE,
        poll: 0,
    });
});

/* ---- report ------------------------------------------------------------- */

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

})();
