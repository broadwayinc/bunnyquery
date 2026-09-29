/**
 * A model in the picker must resolve its OWN context window, not the platform default.
 *
 * The model list the dashboard offers (www.bunnyquery.com/public/models/*.json) and the
 * window table in src/engine/budget.ts are maintained separately. On 2026-09-29 the list
 * gained gpt-6-astra, gpt-6-sol and gpt-6-luna and the table did not, so all three fell
 * through to the openai platform default: 128,000 where the models take 1,050,000.
 * Nothing failed. The project ran at "Default (128K)" instead of "Default (880K)", and
 * the MCP server, which sizes its result pages from the same number, served the 10,000
 * character floor instead of 60,000, which is 74 round trips instead of 13 to read 1,000
 * spreadsheet records.
 *
 * Every assertion here runs WITHOUT a provider listing registered. That is the widget's
 * situation (it never calls registerModelContextWindows), and it is the only situation
 * an OpenAI model is ever in, because OpenAI's listing carries no window.
 *
 * Run: node ./tests/model-context-window.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    getModelContextWindow,
    getContextWindow,
    getMaxOutputTokens,
    CONTEXT_WINDOW_DEFAULT,
    DEFAULT_CONTEXT_WINDOW,
} = require('../dist/engine.cjs');

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); fail++; }
};

const LATEST = [
    ['openai', 'gpt-6-astra', 1050000],
    ['openai', 'gpt-6-sol', 1050000],
    ['openai', 'gpt-6-luna', 1050000],
    ['claude', 'claude-fable-5-1', 1000000],
    ['claude', 'claude-opus-5-5', 1000000],
    ['claude', 'claude-sonnet-5-5', 1000000],
];

/**
 * True when the id resolves from the table (an exact row or a family row) rather than
 * from the platform default. The value alone cannot tell the two apart for a model whose
 * real window EQUALS the default (gpt-4o is 128,000 both ways), so the default is swapped
 * for a marker while the real resolver runs.
 */
const resolvesFromTable = (platform, model) => {
    const kept = CONTEXT_WINDOW_DEFAULT[platform];
    CONTEXT_WINDOW_DEFAULT[platform] = -1;
    try { return getModelContextWindow(platform, model) !== -1; }
    finally { CONTEXT_WINDOW_DEFAULT[platform] = kept; }
};

ok('the latest models resolve their own ceiling', () => {
    for (const [platform, model, ceiling] of LATEST) {
        assert.strictEqual(getModelContextWindow(platform, model), ceiling, model);
    }
});

ok('so a project nobody configured runs them at the default window', () => {
    assert.strictEqual(DEFAULT_CONTEXT_WINDOW, 880000);
    for (const [platform, model] of LATEST) {
        assert.strictEqual(getContextWindow(platform, model), DEFAULT_CONTEXT_WINDOW, model);
    }
});

ok('their output cap does not bind below what a request asks for', () => {
    for (const [platform, model] of LATEST) {
        assert.strictEqual(getMaxOutputTokens(platform, model), 25000, model + ' chat');
        assert.strictEqual(getMaxOutputTokens(platform, model, 'indexing'), 64000, model + ' indexing');
    }
});

ok('a gpt-6 id the table has not met resolves through the family', () => {
    // A dated snapshot and a tier that does not exist yet. Both walk to 'gpt-6'.
    assert.strictEqual(getModelContextWindow('openai', 'gpt-6-sol-2026-09-14'), 1050000);
    assert.strictEqual(getModelContextWindow('openai', 'gpt-6-terra'), 1050000);
    assert.ok(resolvesFromTable('openai', 'gpt-6-terra'));
});

ok('the rows that were deliberately low stay low', () => {
    // The gpt-6 family key must not leak into the gpt-5 catch-all or the small tiers.
    assert.strictEqual(getModelContextWindow('openai', 'gpt-5-mini'), 128000);
    assert.strictEqual(getModelContextWindow('openai', 'gpt-5.4-nano'), 400000);
    assert.strictEqual(getModelContextWindow('openai', 'gpt-4o'), 128000);
    assert.strictEqual(getModelContextWindow('claude', 'claude-opus-4-5-20251101'), 200000);
    assert.strictEqual(getModelContextWindow('claude', 'claude-haiku-4-5'), 200000);
});

ok('a name the table cannot place still gets the platform default', () => {
    assert.strictEqual(resolvesFromTable('openai', 'some-custom-model'), false);
    assert.strictEqual(getModelContextWindow('openai', 'some-custom-model'), 128000);
    assert.strictEqual(getModelContextWindow('claude', 'some-custom-model'), 200000);
});

// The guard against the next time. It reads the dashboard's model lists from the sibling
// checkout, so it is skipped where that checkout is not present.
const MODELS_DIR = path.join(__dirname, '..', '..', 'www.bunnyquery.com', 'public', 'models');
const LISTS = [['claude', 'claude.json'], ['openai', 'openai.json']];

if (!fs.existsSync(MODELS_DIR)) {
    console.log('skip  every model in the picker has a row (no ' + MODELS_DIR + ')');
} else {
    ok('every model in the picker has a row in the window table', () => {
        const missing = [];
        let seen = 0;
        for (const [platform, file] of LISTS) {
            const list = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, file), 'utf8')).data;
            assert.ok(Array.isArray(list) && list.length, file + ' has no models');
            for (const m of list) {
                seen++;
                if (!resolvesFromTable(platform, m.id)) missing.push(platform + ' ' + m.id);
            }
        }
        assert.ok(seen > 0);
        assert.deepStrictEqual(missing, [],
            'in the model list but not in CONTEXT_WINDOW_BY_MODEL (src/engine/budget.ts), '
            + 'so they run at the platform default');
    });

    ok('and the table agrees with the window the list itself reports', () => {
        // Only Anthropic's listing carries one (max_input_tokens). Where it does, the
        // hand-maintained row must not promise more than the provider reports.
        const wrong = [];
        for (const [platform, file] of LISTS) {
            const list = JSON.parse(fs.readFileSync(path.join(MODELS_DIR, file), 'utf8')).data;
            for (const m of list) {
                const reported = Number(m.max_input_tokens);
                if (!Number.isFinite(reported) || reported <= 0) continue;
                const row = getModelContextWindow(platform, m.id);
                if (row > reported) wrong.push(m.id + ' table ' + row + ' > listed ' + reported);
            }
        }
        assert.deepStrictEqual(wrong, []);
    });
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
