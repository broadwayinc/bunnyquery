/**
 * An indexing pass and a chat turn want different output ceilings.
 *
 * Chat has a person waiting, so a long reply is a worse outcome than a truncated one.
 * An indexing pass has nobody waiting and one job, and when it runs out of budget
 * mid-window the worker halves the window and re-sends it, so the file pays roughly twice
 * the passes for the rest of its length.
 *
 * The number is derived from a measurement, not chosen, and the derivation is the thing
 * worth pinning: raising it further is bounded by the WORKER'S LAMBDA, not by the model,
 * and nothing in this repo can see that Lambda's timeout. So the time model is asserted
 * here, where a future raise trips it, rather than left in a comment for someone to
 * rediscover after a chain starts dying at 900s.
 *
 * Run: node ./tests/indexing-output-budget.cjs
 */

const assert = require('assert');
const {
    getMaxOutputTokens,
    MAX_OUTPUT_TOKENS,
    INDEXING_MAX_OUTPUT_TOKENS,
    OUTPUT_TOKEN_RESERVE,
    getInputTokenBudget,
} = require('../dist/engine.cjs');

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fail++; }
};

// Fitted on 9 live passes of a 465-row spreadsheet: duration = 55.4s + output / 131 tok/s
// (R^2 0.906). Both numbers are measurements; change them only by re-measuring.
const FIXED_OVERHEAD_S = 55.4;
const TOKENS_PER_S = 131;
// infra/admin/connect/client_secret_key_request_worker: REQUEST_TIMEOUT = (10, 870) and the
// Lambda is 900s with _STREAM_SETTLE_RESERVE_S = 30.
const WORKER_UPSTREAM_BUDGET_S = 870;
const passSeconds = (tokens) => FIXED_OVERHEAD_S + tokens / TOKENS_PER_S;

ok('a chat turn is unchanged at 25,000', () => {
    assert.strictEqual(MAX_OUTPUT_TOKENS, 25000);
    assert.strictEqual(getMaxOutputTokens('openai', 'gpt-5.6-luna'), 25000);
    assert.strictEqual(getMaxOutputTokens('claude', 'claude-opus-5'), 25000);
    // Omitting the argument must mean chat, so every pre-existing caller keeps its number.
    assert.strictEqual(getMaxOutputTokens('openai', 'gpt-5.6-luna', undefined), 25000);
    assert.strictEqual(getMaxOutputTokens('openai', 'gpt-5.6-luna', 'chat'), 25000);
});

ok('an indexing pass asks for 64,000', () => {
    assert.strictEqual(INDEXING_MAX_OUTPUT_TOKENS, 64000);
    assert.strictEqual(getMaxOutputTokens('openai', 'gpt-5.6-luna', 'indexing'), 64000);
    assert.strictEqual(getMaxOutputTokens('claude', 'claude-opus-5', 'indexing'), 64000);
});

ok("A MODEL'S OWN CEILING STILL WINS", () => {
    // Asking a model for more than it permits is a rejected request, not a long answer.
    assert.strictEqual(getMaxOutputTokens('openai', 'gpt-4o', 'indexing'), 4000);
    assert.strictEqual(getMaxOutputTokens('claude', 'claude-3-5-sonnet', 'indexing'), 8000);
    assert.strictEqual(getMaxOutputTokens('openai', 'gpt-4.1', 'indexing'), 16000);
    // And a model we have no entry for falls back to the asked-for value rather than to zero.
    assert.strictEqual(getMaxOutputTokens('openai', 'some-unlisted-model', 'indexing'), 64000);
});

ok('the indexing cap FITS THE WORKER LAMBDA with real margin', () => {
    const s = passSeconds(INDEXING_MAX_OUTPUT_TOKENS);
    assert.ok(s < WORKER_UPSTREAM_BUDGET_S,
        `a full-budget indexing pass would take ${Math.round(s)}s against the worker's ${WORKER_UPSTREAM_BUDGET_S}s upstream timeout`);
    // Not merely inside it: a slow provider hour or a pass with more tool round trips has to
    // fit too. Anything above ~106,000 tokens has no margin at all.
    const margin = WORKER_UPSTREAM_BUDGET_S - s;
    assert.ok(margin >= 250,
        `only ${Math.round(margin)}s of margin left; the fit is an average, not a worst case`);
    console.log(`      full-budget pass ~${Math.round(s)}s, margin ~${Math.round(margin)}s of ${WORKER_UPSTREAM_BUDGET_S}s`);
});

ok('the cap is high enough to be worth changing', () => {
    // The point is that a full window finishes in ONE pass. The measured pass that truncated
    // needed more than 25,000; anything under about 45,000 leaves the halving in place.
    assert.ok(INDEXING_MAX_OUTPUT_TOKENS >= 45000,
        'below ~45,000 a full 250-row window still truncates and the window still halves');
});

ok('the chat INPUT budget is not collateral damage', () => {
    // OUTPUT_TOKEN_RESERVE sizes the input budget for bounded chat history. The indexing
    // number must not feed it: an indexing message is built from a file window, not from
    // bounded history, so wiring it in would shrink a budget it has nothing to do with.
    assert.strictEqual(OUTPUT_TOKEN_RESERVE, MAX_OUTPUT_TOKENS,
        'the reserve now tracks the indexing cap, which silently shrinks the chat input budget');
    assert.ok(getInputTokenBudget('openai', 'gpt-5.6-luna') >= 136000,
        'the chat input budget moved');
});

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
