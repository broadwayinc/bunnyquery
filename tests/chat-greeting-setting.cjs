/**
 * The chat's opening line can be replaced per project, from the settings page.
 *
 * The value lives in the SAME `bq::settings` record as the upload access group,
 * under its own `chat_greeting` key -- a second setting is a new KEY, not a new
 * record, so one fetch still covers everything a client needs before it paints.
 *
 * Two things this pins, because both clients depend on them:
 *   1. A custom line REPLACES the whole sentence, including the canUpload
 *      variants. The owner wrote the words; the client does not append
 *      instructions they chose not to give.
 *   2. It comes back as `lead` with an empty `name`/`tail`. That is what lets
 *      agent.vue and the widget draw it through the exact three-piece code path
 *      they already use for the built-in sentence, with no branch at either
 *      call site.
 *
 * Run: node ./tests/chat-greeting-setting.cjs
 */

const assert = require('assert');
const {
    buildChatGreeting,
    normalizeChatGreeting,
    chatGreetingFrom,
    CHAT_GREETING_MAX_LENGTH,
} = require('../dist/engine.cjs');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

/* ---- the built-in sentence still behaves exactly as it did ---------------- */

test('no custom line: the default upload-first sentence, with the quoted name', () => {
    const g = buildChatGreeting({ projectName: 'Acme' });
    assert.ok(g.lead.startsWith('Hi! Start by attaching'));
    assert.strictEqual(g.name, '"Acme"');
    assert.ok(g.tail.includes('indexed'));
    assert.strictEqual(g.text, g.lead + ' ' + g.name + g.tail);
});

test('no custom line, canUpload false: the ask-first variant', () => {
    const g = buildChatGreeting({ projectName: 'Acme', canUpload: false });
    assert.ok(g.lead.startsWith('Hi! Ask me anything'));
    assert.strictEqual(g.tail, '.');
});

/* ---- a custom line ------------------------------------------------------- */

test('a custom line replaces the sentence and empties name/tail', () => {
    const g = buildChatGreeting({ projectName: 'Acme', custom: 'Welcome to the help desk.' });
    assert.strictEqual(g.lead, 'Welcome to the help desk.');
    assert.strictEqual(g.name, '');
    assert.strictEqual(g.tail, '');
    assert.strictEqual(g.text, 'Welcome to the help desk.');
});

test('THE POINT OF THE SHAPE: a client rendering lead+name+tail draws it whole', () => {
    const g = buildChatGreeting({ custom: 'Ask me about our menu.' });
    // This concatenation is literally what agent.vue's template and the widget's
    // buildGreetingEl do. It must equal the custom line with nothing appended.
    assert.strictEqual(g.lead + g.name + g.tail, 'Ask me about our menu.');
});

test('a custom line overrides the canUpload variants too', () => {
    const withUpload = buildChatGreeting({ custom: 'Hello.', canUpload: true });
    const without = buildChatGreeting({ custom: 'Hello.', canUpload: false });
    assert.strictEqual(withUpload.text, 'Hello.');
    assert.strictEqual(without.text, 'Hello.');
});

test('the project name is NOT interpolated into a custom line', () => {
    const g = buildChatGreeting({ projectName: 'Acme', custom: 'Hello.' });
    assert.ok(!g.text.includes('Acme'));
});

test('whitespace-only means UNSET, not a blank bubble', () => {
    const g = buildChatGreeting({ projectName: 'Acme', custom: '   \n\t ' });
    assert.ok(g.lead.startsWith('Hi! Start by attaching'));
    assert.strictEqual(g.name, '"Acme"');
});

/* ---- normalising what comes out of the record ---------------------------- */

test('normalizeChatGreeting trims and survives a non-string', () => {
    assert.strictEqual(normalizeChatGreeting('  hi  '), 'hi');
    assert.strictEqual(normalizeChatGreeting(''), '');
    assert.strictEqual(normalizeChatGreeting(undefined), '');
    assert.strictEqual(normalizeChatGreeting(null), '');
    assert.strictEqual(normalizeChatGreeting(42), '');
    assert.strictEqual(normalizeChatGreeting({}), '');
});

test('runs of blank lines collapse, so the bubble cannot open with whitespace', () => {
    assert.strictEqual(normalizeChatGreeting('a\n\n\n\n\nb'), 'a\n\nb');
    assert.strictEqual(normalizeChatGreeting('a\r\n\r\n\r\n\r\nb'), 'a\n\nb');
    // a single blank line between paragraphs is left alone
    assert.strictEqual(normalizeChatGreeting('a\n\nb'), 'a\n\nb');
});

test('capped at CHAT_GREETING_MAX_LENGTH, on read as well as on save', () => {
    const long = 'x'.repeat(CHAT_GREETING_MAX_LENGTH + 50);
    assert.strictEqual(normalizeChatGreeting(long).length, CHAT_GREETING_MAX_LENGTH);
});

test('chatGreetingFrom reads the key out of a settings record data object', () => {
    assert.strictEqual(chatGreetingFrom({ chat_greeting: ' hello ' }), 'hello');
    // unset, no record at all, and a record holding only the OTHER setting
    assert.strictEqual(chatGreetingFrom({}), '');
    assert.strictEqual(chatGreetingFrom(null), '');
    assert.strictEqual(chatGreetingFrom(undefined), '');
    assert.strictEqual(chatGreetingFrom({ upload_access_group: 'public' }), '');
});

test('the two settings coexist in one record, which is why it holds an object', () => {
    const data = { upload_access_group: 'private', chat_greeting: 'Hi there.' };
    assert.strictEqual(chatGreetingFrom(data), 'Hi there.');
    assert.strictEqual(data.upload_access_group, 'private');
});

let pass = 0;
for (const [ok, name, msg] of results) {
    console.log(ok ? `ok    ${name}` : `FAIL  ${name}\n        ${msg}`);
    if (ok) pass++;
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
