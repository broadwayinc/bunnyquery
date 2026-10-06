/**
 * The chat answers from the project's data, and says so when the data does not have it.
 *
 * Customers reported answers that were not in their data at all. The prompt's lookup
 * rules had all been written against the opposite mistake (a model that says "not
 * found" before it has really looked), so they pushed one way only: keep searching,
 * never say it is absent. Nothing said the other half. Three rules now do, each closing
 * one way an invented answer gets out:
 *
 *   1. ANSWER ONLY FROM THE DATA          a fact with no source behind it
 *   2. WHEN THE DATA DOES NOT HAVE IT...  a "not found" replaced by general knowledge
 *   3. KEEP WHAT THE DATA SAYS APART...   an inference worded as if the data said it
 *
 * What this pins:
 *   - the three rules are there, name what counts as a source and what does not;
 *   - they sit WITH the lookup rules they complete, and those are untouched: the model
 *     still has to search before it may say the data does not have it;
 *   - they do not swallow what is not a claim about the data (product help, a
 *     greeting, text the user asks for);
 *   - a visitor who cannot upload is never told to upload, here either.
 *
 * Run: node ./tests/chat-grounding-rules.cjs
 */

const assert = require('assert');
const { buildChatSystemPrompt } = require('../dist/engine.cjs');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

const prompt = (over) => buildChatSystemPrompt(Object.assign({ projectId: 'proj-1', canUpload: true, client: 'console' }, over));
const P = prompt();

/** The text from one rule's heading up to the next line that starts a new rule. */
function rule(text, heading) {
    const start = text.indexOf(heading);
    assert.ok(start !== -1, `the rule "${heading}" is missing`);
    const end = text.indexOf('\n', start);
    return text.slice(start, end === -1 ? undefined : end);
}

/* ---- the three rules ------------------------------------------------------ */

test('a fact about the data needs a source, and the four sources are named', () => {
    const r = rule(P, 'ANSWER ONLY FROM THE DATA.');
    assert.ok(/a tool result returned in THIS conversation/.test(r));
    assert.ok(/a file or image attached to it/.test(r));
    assert.ok(/the project description/.test(r));
    assert.ok(/what the user told you themselves in this chat/.test(r));
});

test('general knowledge, the open internet and a guess are named as NOT sources', () => {
    const r = rule(P, 'ANSWER ONLY FROM THE DATA.');
    assert.ok(/general knowledge, the open internet and a plausible guess are NOT sources/.test(r));
    assert.ok(/to fill a gap in it/.test(r), 'filling a gap is the commonest form of it');
    assert.ok(/to complete a record that came back partial/.test(r));
    assert.ok(/say it is not in the data instead of supplying a likely one/.test(r));
});

test('when the data does not have it the model says so, and says what it searched', () => {
    const r = rule(P, 'WHEN THE DATA DOES NOT HAVE IT, SAY SO.');
    assert.ok(/this project's data does not contain it/.test(r));
    assert.ok(/in their language/.test(r));
    assert.ok(/say what you searched/.test(r), 'so the user can tell missing data from a missed search');
    assert.ok(/Do not answer from memory instead/.test(r));
    assert.ok(/do not turn a missing answer into a general explanation/.test(r));
});

test('what the model worked out is kept apart from what the data says', () => {
    const r = rule(P, 'KEEP WHAT THE DATA SAYS APART FROM WHAT YOU WORKED OUT.');
    assert.ok(/label it as such/.test(r));
    assert.ok(/name the rows or files it was made from/.test(r));
    assert.ok(/Never present an estimate, an assumption or an inference as something the data states/.test(r));
});

/* ---- they complete the lookup rules, they do not replace them --------------- */

test('saying "not in the data" still comes only AFTER a real search', () => {
    assert.ok(/Knowledge lookup: Before saying you don't know[^\n]*ALWAYS query this project's database/.test(P));
    assert.ok(/Never assert absence from a partial read\./.test(P));
    const r = rule(P, 'WHEN THE DATA DOES NOT HAVE IT, SAY SO.');
    assert.ok(/Once you have searched the way these rules require/.test(r), 'the rule must not license an early "not found"');
});

test('the rules sit right after the lookup rule they complete', () => {
    const lookup = P.indexOf('Knowledge lookup:');
    const first = P.indexOf('ANSWER ONLY FROM THE DATA.');
    const numbers = P.indexOf('NUMBERS FROM A SPREADSHEET:');
    assert.ok(lookup !== -1 && lookup < first && first < numbers);
    // nothing but the end of the lookup line lies between the two
    assert.ok(!P.slice(lookup, first).slice(0, -1).includes('\n'));
});

/* ---- what they must not swallow ----------------------------------------------- */

test('product help, a greeting and requested writing are left alone', () => {
    const line = rule(P, 'These three rules govern every claim about the project\'s data.');
    assert.ok(/They do not limit the About BunnyQuery section/.test(line));
    assert.ok(/a greeting/.test(line));
    assert.ok(/text the user explicitly asks you to write/.test(line));
    assert.ok(P.includes('About BunnyQuery (this app - questions about it are in scope):'));
});

/* ---- a visitor who cannot upload ------------------------------------------------ */

test('a user who can upload is offered that', () => {
    const r = rule(prompt({ canUpload: true }), 'WHEN THE DATA DOES NOT HAVE IT, SAY SO.');
    assert.ok(/the document to upload, or another name or file to look under/.test(r));
});

test('a user who cannot upload is never told to, and is pointed at the owner', () => {
    for (const client of ['widget', 'console']) {
        const r = rule(prompt({ canUpload: false, client }), 'WHEN THE DATA DOES NOT HAVE IT, SAY SO.');
        assert.ok(!/upload/i.test(r), 'the grounding rule told a visitor who cannot upload to upload');
        assert.ok(/asking the project's owner to add it/.test(r));
    }
});

test('the rules are the same for both clients and with or without a description', () => {
    const block = (text) => text.slice(text.indexOf('ANSWER ONLY FROM THE DATA.'), text.indexOf('NUMBERS FROM A SPREADSHEET:'));
    const base = block(P);
    assert.strictEqual(block(prompt({ client: 'widget' })), base);
    assert.strictEqual(block(prompt({ serviceName: 'Acme', serviceDescription: 'We sell parts.', greeting: 'Hello' })), base);
    assert.strictEqual(block(prompt({ indexAccessGroup: 'public' })), base);
});

const failed = results.filter(r => !r[0]);
for (const [ok, name, why] of results) console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '\n      ' + why));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
