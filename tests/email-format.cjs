/**
 * An .eml has to take the SERVER-PARSED, WINDOWED route, never the text route.
 *
 * An RFC822 email is nominally text, which is exactly the trap: routed as text,
 * the worker decodes the bytes and inlines them, so the model reads a
 * quoted-printable body and every attachment as a base64 blob "as prose". Routed
 * as a paged, server-extractable file, the layer parses the MIME container and
 * hands back the header block, the body and the attachment text one window at a
 * time. The pinning here is on the engine's routing predicates and on the two
 * prompts that tell the model what an email is and where to save it: if either
 * drifts, an email is indexed as noise or not at all, and nothing else would
 * report it.
 *
 * Run: node ./tests/email-format.cjs
 */

const assert = require('assert');
const {
    isServerExtractable,
    isPagedReadFile,
    isImageVisionFile,
    isWindowedReadFile,
    composeUserMessage,
    buildChatSystemPrompt,
    buildIndexingSystemPrompt,
} = require('../dist/engine.cjs');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

/* ---- routing predicates ------------------------------------------------- */

test('.eml is server-extractable', () => {
    assert.strictEqual(isServerExtractable('mail.eml'), true);
});

test('the extension match is case-insensitive', () => {
    // Outlook and macOS exports capitalise freely; a case-sensitive match would
    // send MAIL.EML to the plain-link route and hand the model a URL to fetch.
    assert.strictEqual(isServerExtractable('MAIL.EML'), true);
});

test('.eml is paged (read window by window)', () => {
    assert.strictEqual(isPagedReadFile('mail.eml'), true);
});

test('.eml is windowed, not a vision file', () => {
    // Windowed = paged minus vision. An email must never take the page-render
    // path: there are no pages to render, and the worker would inject nothing.
    assert.strictEqual(isWindowedReadFile('mail.eml'), true);
    assert.strictEqual(isImageVisionFile('mail.eml'), false);
});

test('a name with a double dot still routes on its last extension', () => {
    // "subject line as filename" exports end in "..eml"; split('.').pop() must
    // still see "eml", not an empty segment.
    assert.strictEqual(isServerExtractable('my answer, please read carefully..eml'), true);
});

/* ---- chat composition --------------------------------------------------- */

test('composeUserMessage inlines an .eml through an extract directive', () => {
    const out = composeUserMessage('hi', [
        { name: 'mail.eml', url: 'https://x/y', storagePath: 'in/mail.eml' },
    ]);
    assert.ok(Array.isArray(out.extractContent), 'no extractContent directives');
    assert.strictEqual(out.extractContent.length, 1);
    const d = out.extractContent[0];
    assert.strictEqual(d.path, 'in/mail.eml', 'directive path must be the storage path, not the label');
    assert.ok(d.placeholder.startsWith('{{SKAPI_FILE_CONTENT::'),
        'placeholder does not carry the extract token: ' + d.placeholder);
    assert.ok(out.composedForLlm.includes(d.placeholder), 'the LLM copy must embed the placeholder');
    assert.ok(!out.composed.includes(d.placeholder), 'the display copy must stay clean');
    assert.strictEqual(out.fileUrls, undefined, 'an extractable file must not also get a url re-mint');
});

/* ---- the prompts know what an email is ---------------------------------- */

test('the chat system prompt names .eml among the indexed formats', () => {
    const sys = buildChatSystemPrompt({ projectId: 'p' });
    assert.ok(sys.includes('.eml'), 'chat system prompt does not mention .eml');
});

test('the indexing system prompt carries the email rule', () => {
    const sys = buildIndexingSystemPrompt({ projectId: 'p' });
    assert.ok(sys.includes('.eml'), 'indexing system prompt does not mention .eml');
    assert.ok(sys.includes('email_messages'), 'indexing system prompt does not name the email_messages table');
    // The headings the layer emits are the model's only way to tell one message
    // from a forwarded one, and an attachment's text from the body.
    assert.ok(sys.includes('=== EMAIL ==='), 'the EMAIL heading is not described');
    assert.ok(sys.includes('=== FORWARDED MESSAGE'), 'the FORWARDED MESSAGE heading is not described');
    assert.ok(sys.includes('=== ATTACHMENT'), 'the ATTACHMENT heading is not described');
});

/* ---- the two chat clients agree on what an .eml costs ------------------- */

const fs = require('fs');
const path = require('path');

function textlikeRegexOf(file) {
    // The estimator regexes are hand-mirrored between the widget and the console;
    // nothing else enforces the mirror, so the test reads both sources.
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(/TEXTLIKE_EXTENSION_RE\s*=\s*\n?\s*(\/[^\n]*\/i);/);
    assert.ok(m, 'no TEXTLIKE_EXTENSION_RE literal in ' + file);
    return m[1];
}

test('the token estimators do not count an .eml as text', () => {
    // An .eml is mostly base64 attachment bytes that never reach the model, so
    // charging size/3 tokens estimated a 380 KB mail with one photo at 127k
    // tokens and disabled Send under the OpenAI default budget.
    const widget = textlikeRegexOf(path.join(__dirname, '..', 'src', 'index.js'));
    const console_ = textlikeRegexOf(path.join(__dirname, '..', '..', 'www.bunnyquery.com', 'src', 'views', 'service', 'agent.vue'));
    assert.strictEqual(widget, console_, 'widget and console TEXTLIKE_EXTENSION_RE differ');
    const re = new Function('return ' + widget)();
    assert.strictEqual(re.test('mail.eml'), false, '.eml is still counted as text');
    assert.strictEqual(re.test('MAIL.EML'), false);
    assert.strictEqual(re.test('notes.txt'), true, 'the regex lost its text extensions');
});

/* ---- the prompts and the layer say the same thing ----------------------- */

test('the indexing prompt describes the headings the layer emits', () => {
    const sys = buildIndexingSystemPrompt({ projectId: 'p' });
    // The layer writes "(depth d)" on every forwarded heading and never emits an
    // ISO date for a Date header it could not parse.
    assert.ok(sys.includes('=== FORWARDED MESSAGE k (depth d) ==='), 'forwarded heading lacks (depth d)');
    assert.ok(sys.includes('otherwise the raw header text'), 'date rule claims an ISO string unconditionally');
    assert.ok(sys.includes('always start at column 0'), 'the column-0 heading rule is missing');
});

test('email_messages is a FIXED table name, not one the model may choose', () => {
    const sys = buildIndexingSystemPrompt({ projectId: 'p' });
    const fixed = sys.split('\n').find((l) => l.startsWith('- FIXED TABLE NAMES'));
    assert.ok(fixed, 'no FIXED TABLE NAMES rule');
    assert.ok(fixed.includes('"email_messages"'), 'FIXED TABLE NAMES does not name email_messages');
});

test('no prompt tells the model an email attachment was not extracted', () => {
    // The email window shows the attachment's extracted text; a sentence saying
    // "non-picture attachments are NOT extracted" beside it contradicted the
    // EMAIL rule that orders records for that text.
    for (const sys of [buildIndexingSystemPrompt({ projectId: 'p' }), buildChatSystemPrompt({ projectId: 'p' })]) {
        assert.ok(!sys.includes('non-picture attachments are NOT extracted'), 'stale "NOT extracted" wording');
        assert.ok(sys.includes('never saved as separate files'), 'the files-not-extraction wording is missing');
    }
});

/* ---- report ------------------------------------------------------------- */

let failed = 0;
for (const [ok, name, detail] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (detail ? '  -> ' + detail : ''));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
