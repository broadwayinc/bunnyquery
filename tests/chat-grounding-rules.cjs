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
 * The DOCUMENTS block (reliability plan 3.4) is pinned below the three rules: one
 * method for a question about a file's content (find the file, searchText the
 * page, quote the exact text, cite file and page, readFileContent for a file with
 * no page text, say so when nothing matches), and its last sentence follows the
 * web switch: no web tool when the web is off, web facts marked as such when on.
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

/* ---- the DOCUMENTS block (plan 3.4) ------------------------------------------------- */

const DOC = 'DOCUMENTS (a contract, a report, a manual, a letter, any uploaded file the user asks about the content of):';

test('DOCUMENTS: find the file, then the page with searchText, quote the exact text, cite file and page', () => {
    const r = rule(P, DOC);
    assert.ok(/FIRST FIND THE FILE, with getFileOutline/.test(r));
    assert.ok(/getUniqueId using unique_id "src::" and condition "gte"/.test(r));
    assert.ok(/THEN FIND THE PAGE: call searchText with the file's path/.test(r));
    assert.ok(/QUOTE THE EXACT TEXT it returned and CITE THE FILE AND THE PAGE/.test(r));
    assert.ok(/never present a paraphrase as a quote/.test(r));
});

test('DOCUMENTS: a file with no page text is read with readFileContent, to END OF FILE', () => {
    const r = rule(P, DOC);
    assert.ok(/If searchText answers no_page_text/.test(r));
    assert.ok(/read it with readFileContent instead, paging with the cursor until END OF FILE/.test(r));
});

test('DOCUMENTS: nothing found over files WITH page text is said as such, naming files and terms', () => {
    const r = rule(P, DOC);
    assert.ok(/come back empty over files that HAVE page text, say that the data does not have it/.test(r));
    assert.ok(/name the files and the terms you searched/.test(r));
});

test('DOCUMENTS: the gap is never filled from general knowledge or the web; with the web OFF the chat has no web tool', () => {
    const r = rule(P, DOC);
    assert.ok(/Never fill the gap from your general knowledge, and never from the web: this chat has no web tool\./.test(r));
    assert.ok(!/WEB ACCESS IS ON/.test(r));
});

test('DOCUMENTS with the web ON: a web fact is allowed only when marked as from the web, kept apart, never used to fill a document', () => {
    const r = rule(prompt({ webAccess: true }), DOC);
    assert.ok(/never from the web without saying so\. WEB ACCESS IS ON for this project/.test(r));
    assert.ok(/marked as coming from the web \(name the site\)/.test(r));
    assert.ok(/kept apart from what the project's data says/.test(r));
    assert.ok(/never used to fill in or complete a document's content/.test(r));
    assert.ok(/the one exception to the four sources named above/.test(r));
});

test('DOCUMENTS sits with the spreadsheet rules, before the completeness rules', () => {
    const fileTotal = P.indexOf("A FILE TOTAL IS NOT A ROW'S TOTAL.");
    const doc = P.indexOf(DOC);
    const complete = P.indexOf('Complete answers over stored data:');
    assert.ok(fileTotal !== -1 && doc !== -1 && complete !== -1);
    assert.ok(fileTotal < doc && doc < complete);
    // one line each: the spreadsheet rule ends, DOCUMENTS begins
    assert.ok(!P.slice(fileTotal, doc).slice(0, -1).includes('\n'));
});

test('DOCUMENTS is additive: the grounding block is byte-identical with the web on or off', () => {
    const block = (text) => text.slice(text.indexOf('ANSWER ONLY FROM THE DATA.'), text.indexOf('NUMBERS FROM A SPREADSHEET:'));
    assert.strictEqual(block(prompt({ webAccess: true })), block(P));
    assert.strictEqual(block(prompt({ webAccess: false })), block(P));
    // and the DOCUMENTS line is the same for both clients and every access group
    assert.strictEqual(rule(prompt({ client: 'widget' }), DOC), rule(P, DOC));
    assert.strictEqual(rule(prompt({ indexAccessGroup: 'public' }), DOC), rule(P, DOC));
});

test('the attachment bullet follows the switch: OFF never says to fetch a URL, ON keeps web_fetch for URL files', () => {
    assert.ok(!/use your web_fetch tool to download and read each URL/.test(P));
    assert.ok(/this chat has NO web tool: never try to download or fetch an attachment's URL/.test(P));
    assert.ok(/use searchText or readFileContent on that same path \(see DOCUMENTS above\)/.test(P));
    const on = prompt({ webAccess: true });
    assert.ok(/use your web_fetch tool to download and read each URL before answering/.test(on));
    assert.ok(!/this chat has NO web tool/.test(on));
});

test('no em dash anywhere in the prompt, with the web on or off', () => {
    for (const p of [P, prompt({ webAccess: true }), prompt({ canUpload: false, client: 'widget' })]) {
        assert.ok(p.indexOf('\u2014') === -1, 'an em dash crept into the prompt');
    }
});

const failed = results.filter(r => !r[0]);
for (const [ok, name, why] of results) console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '\n      ' + why));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
