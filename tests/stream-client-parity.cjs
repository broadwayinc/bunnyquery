/**
 * The CLIENT half of live streaming: the seam the engine defines, and the promise
 * that both clients sit on the same side of it.
 *
 * Two things are checked here, and they are different in kind.
 *
 * 1. THE CAPABILITY GATE. A streamed turn carries two `stream` flags - skapi's
 *    (relay the destination's bytes) and the DESTINATION's own field inside `data`,
 *    which BunnyQuery sets because skapi relays bytes and knows no vendor. skapi's
 *    validator KEEPS ONLY THE KEYS IN ITS SCHEMA, so an skapi-js predating the
 *    feature does not reject `stream`, it silently DROPS it: the destination
 *    streams SSE, skapi buffers the whole transcript onto the row, and the
 *    extractors read a wall of `data: {...}` lines as a document and find nothing.
 *    Every turn reads back empty and nothing anywhere logs a word. The widget takes
 *    the EMBEDDER's skapi instance, so this is exactly the shape an embed page
 *    pinned to an older SDK produces, and `liveStreaming: true` therefore has to be
 *    a REQUEST that something grants.
 *
 * 2. THE TWO CLIENTS AGREE. agent.vue and the widget have forked before, and every
 *    fork became a bug found twice. The engine's job is to make forking impossible
 *    for logic; where a client genuinely must own something (a Vue template vs a
 *    hand-built DOM node) the only defence left is to hold the two sources to the
 *    same expression, which is what the parity block at the end does. It SKIPS
 *    rather than fails when agent.vue is not on disk, because the bunnyquery
 *    package is also published and tested on its own.
 *
 * Run: node ./tests/stream-client-parity.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../dist/engine.cjs');
const {
    ChatSession, configureChatEngine,
    skapiSupportsStreaming, streamRecoveryEnabled, mayKeepStreamedAnswer,
    streamRecoveryPhase, streamRecoveryLabels,
} = engine;

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}
function skip(name, why) { results.push([true, name + ' (SKIPPED: ' + why + ')']); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- harness (same shape as stream-recovery.cjs) -------------------------- */

function configure(cfg) {
    const calls = { finalize: [], reads: [], notify: 0 };
    configureChatEngine(Object.assign({
        clientSecretRequest: async () => ({}),
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
    }, cfg));
    return calls;
}

function makeSession(calls, messages) {
    const s = Object.create(ChatSession.prototype);
    s.state = { messages: messages || [], historyEndOfList: false, historyStartKeyHistory: [] };
    s.liveStreams = {};
    s.aiChatHistoryCache = {};
    s._identity = { platform: 'claude', projectId: 'p1', owner: 'o1', userId: 'u1' };
    s.host = {
        getIdentity: () => s._identity,
        notify: () => { calls.notify++; },
        refreshMessageBubble: () => { },
        scrollToBottomIfSticky: () => { },
    };
    return s;
}

/** An SSE transcript that ends properly, so a read back of it is finalizable. */
function frame(obj) { return 'event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n'; }
const WHOLE =
    frame({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null } }) +
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered answer.' } }) +
    frame({ type: 'content_block_stop', index: 0 }) +
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
    frame({ type: 'message_stop' });
const RESOLVED_ENVELOPE = { id: 'r1', status: 'resolved', queue_name: 'u1', in_queue: 0, stream: true };

/* ---- reading the two clients --------------------------------------------- */

const WIDGET_PATH = path.resolve(__dirname, '../src/index.js');
const AGENT_PATH = path.resolve(__dirname, '../../www.bunnyquery.com/src/views/service/agent.vue');
const AI_AGENT_PATH = path.resolve(__dirname, '../../www.bunnyquery.com/src/code/ai_agent.ts');
const read = (p) => fs.readFileSync(p, 'utf8');
const hasAgent = fs.existsSync(AGENT_PATH) && fs.existsSync(AI_AGENT_PATH);

/** Comments are prose and may legitimately differ; code is what must not. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
        .replace(/^[ \t]*\/\/-.*$/gm, '');
}

(async () => {

/* ══ 1. the capability gate ══════════════════════════════════════════════ */

await test('an skapi-js with both stream methods can carry the flag', () => {
    assert.strictEqual(skapiSupportsStreaming({
        clientSecretRequestStream: () => { },
        clientSecretRequestFinalize: () => { },
    }), true);
});

await test('THE REPORTED BUG: an SDK without the read-back is refused', () => {
    // The exact shape of an embed page pinned to an older skapi-js. Honouring
    // liveStreaming here would ask the DESTINATION to stream while skapi's own half
    // of the flag is dropped at the validator, which is the split the design forbids.
    assert.strictEqual(skapiSupportsStreaming({ clientSecretRequestFinalize: () => { } }), false);
});

await test('and one without finalize is refused too: the answer would never reach its row', () => {
    assert.strictEqual(skapiSupportsStreaming({ clientSecretRequestStream: () => { } }), false);
});

await test('an SDK with neither is refused', () => {
    assert.strictEqual(skapiSupportsStreaming({ clientSecretRequest: () => { } }), false);
});

await test('the methods must be FUNCTIONS, not merely present', () => {
    // A stub object or a truthy placeholder is not an implementation, and calling it
    // mid-turn would throw where the whole point is to degrade quietly to buffered.
    assert.strictEqual(skapiSupportsStreaming({
        clientSecretRequestStream: true,
        clientSecretRequestFinalize: true,
    }), false);
});

await test('nothing at all is refused without throwing', () => {
    assert.strictEqual(skapiSupportsStreaming(null), false);
    assert.strictEqual(skapiSupportsStreaming(undefined), false);
    assert.strictEqual(skapiSupportsStreaming('skapi'), false);
    assert.strictEqual(skapiSupportsStreaming(0), false);
});

/* ══ 2. what the engine will actually act on ═════════════════════════════ */

await test('recovery is armed by the chunk READER', () => {
    configure({ liveStreaming: true, clientSecretRequestStream: async () => ({}) });
    assert.strictEqual(streamRecoveryEnabled(), true);
});

await test('streaming without a reader mints no marker: an empty bubble is worse than none', () => {
    configure({ liveStreaming: true });
    assert.strictEqual(streamRecoveryEnabled(), false);
});

await test('TURNING STREAMING OFF DOES NOT STRAND THE ROWS THAT ALREADY STREAMED', () => {
    // The two decisions are separate: "should NEW turns stream?" and "can an
    // ALREADY streamed row be read back?" are about two different sets of rows.
    // Answered by one flag, a rollback (an embedder drops the option, a dev flips
    // the constant back, skapiSupportsStreaming degrades an old instance) made
    // every row streamed before it unmarked and unrecoverable in the same moment,
    // with every byte of those answers still sitting in the chunk table. Rolling a
    // rendering flag back must not delete anybody's history.
    configure({ liveStreaming: false, clientSecretRequestStream: async () => ({}) });
    assert.strictEqual(streamRecoveryEnabled(), true);
    // And there is a documented way back out for a host that wants the old
    // rendering exactly: no bubble, no marker, no chunk read.
    configure({ liveStreaming: false, streamRecovery: false, clientSecretRequestStream: async () => ({}) });
    assert.strictEqual(streamRecoveryEnabled(), false);
});

await test('THE KEEP POLICY IS ONE PREDICATE, on the barrel, so nothing can answer it twice', () => {
    // finalize both STORES the answer and RELEASES the chunks, so "may this be
    // kept?" is the single decision separating a recoverable turn from a
    // permanently truncated one. It was answered in two places - the live settle
    // and the read-back - and they disagreed: the settle refused a failed turn
    // while the recovery finalized one, releasing exactly the chunks the policy
    // exists to keep.
    assert.strictEqual(typeof mayKeepStreamedAnswer, 'function');
    const whole = { answerComplete: true, complete: true, errored: false, unframed: false };
    assert.strictEqual(mayKeepStreamedAnswer(whole, 'resolved'), true);
    // A row status that is not 'resolved' outranks anything the bytes say.
    assert.strictEqual(mayKeepStreamedAnswer(whole, 'failed'), false);
    assert.strictEqual(mayKeepStreamedAnswer(whole, 'cancelled'), false);
    assert.strictEqual(mayKeepStreamedAnswer(whole, 'stopped'), false);
    // Not knowing the status is not the same as knowing it is bad.
    assert.strictEqual(mayKeepStreamedAnswer(whole), true);
    assert.strictEqual(mayKeepStreamedAnswer(whole, null), true);
    // A terminal event is not a finished answer, and an errored one never is.
    assert.strictEqual(mayKeepStreamedAnswer({ complete: true, answerComplete: false, errored: true }, 'resolved'), false);
    assert.strictEqual(mayKeepStreamedAnswer({ complete: true, answerComplete: false, errored: false }, 'resolved'), false);
    assert.strictEqual(mayKeepStreamedAnswer({ complete: false, answerComplete: false, errored: false }, 'resolved'), false);
    // Bytes that were never SSE carry no events and none is coming, so there the
    // ROW's status is what says the response finished.
    assert.strictEqual(mayKeepStreamedAnswer({ unframed: true, answerComplete: false, errored: false }, 'resolved'), true);
    assert.strictEqual(mayKeepStreamedAnswer({ unframed: true, answerComplete: false, errored: true }, 'resolved'), false);
    // And nothing at all is refused rather than thrown on.
    assert.strictEqual(mayKeepStreamedAnswer(null, 'resolved'), false);
    assert.strictEqual(mayKeepStreamedAnswer(undefined), false);
});

await test('THE RENDER POLICY IS ONE PREDICATE TOO: when may a bubble spin?', () => {
    // The bug this closes: `_streamPending && !content` was read as "being
    // fetched", and it is not - it is "the answer is elsewhere", which is true for
    // hours on a turn nobody has been sent for. Recovery is capped at 2 per history
    // load, so on a page with five marked turns three of them are marked and
    // unattended from the first paint; a failed read leaves the marker on
    // deliberately, and that is unattended too. Both drew a live turn's loader.
    assert.strictEqual(typeof streamRecoveryPhase, 'function');
    const marked = { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'r1' };
    assert.strictEqual(streamRecoveryPhase(marked), 'idle');
    assert.strictEqual(streamRecoveryPhase(Object.assign({}, marked, { _streamRecovery: 'active' })), 'active');
    assert.strictEqual(streamRecoveryPhase(Object.assign({}, marked, { _streamRecovery: 'failed' })), 'failed');
    // Not this state at all: an unmarked bubble, and a marked one that HAS text (the
    // merge adopted a local answer onto it, or a recovery wrote a truncated one in).
    // There is something to read there, so it renders as an ordinary answer and any
    // correction still coming is a background one the reader is not told about.
    assert.strictEqual(streamRecoveryPhase({ role: 'assistant', content: '', _serverItemId: 'r1' }), '');
    assert.strictEqual(streamRecoveryPhase(Object.assign({}, marked, { content: 'half an answer' })), '');
    // No id means recoverStreamedAnswer has nothing to be called with, so an
    // affordance there would be a control that cannot work. Unreachable today; this
    // is what keeps it unreachable rather than dead.
    assert.strictEqual(streamRecoveryPhase({ role: 'assistant', content: '', _streamPending: true }), '');
    // And nothing at all is answered rather than thrown on.
    assert.strictEqual(streamRecoveryPhase(null), '');
    assert.strictEqual(streamRecoveryPhase(undefined), '');
});

await test('and the words for it come from one place, so the two clients cannot disagree', () => {
    assert.strictEqual(typeof streamRecoveryLabels, 'function');
    const failed = streamRecoveryLabels('failed');
    const idle = streamRecoveryLabels('idle');
    assert.notStrictEqual(failed.note, idle.note);
    assert.notStrictEqual(failed.action, idle.action);
    // Neither may claim the answer is gone: the row is unfinalized, which is
    // precisely why its chunks are still there and asking again can work.
    for (const l of [failed, idle]) {
        assert.ok(l.note && l.action, 'both halves are needed: a bare button says nothing');
        assert.ok(!/lost|deleted|gone/i.test(l.note), 'the answer is not lost and must not be described as lost');
    }
    // An unknown phase words itself as the askable one rather than throwing: this is
    // called straight from a render path.
    assert.deepStrictEqual(streamRecoveryLabels(''), idle);
});

/* ══ 3. the entry points a forked history path needs ═════════════════════ */

await test('the two merge-contract steps are on the PUBLIC surface', () => {
    // agent.vue's mount path maps and merges its own page and never calls
    // loadHistory, so if these are unreachable that path marks unfinalized turns and
    // then never reads them back - CRITICAL 1 left open on the path the user
    // arrives through, with the marker making it look handled.
    assert.strictEqual(typeof ChatSession.prototype.adoptLocalAnswers, 'function');
    assert.strictEqual(typeof ChatSession.prototype.scheduleStreamRecovery, 'function');
    assert.strictEqual(typeof ChatSession.prototype.recoverStreamedAnswer, 'function');
});

await test('adoptLocalAnswers keeps the on-screen answer when the page copy is empty', () => {
    const calls = configure({ liveStreaming: true, clientSecretRequestStream: async () => ({}) });
    const s = makeSession(calls, [
        { role: 'user', content: 'q', _serverItemId: 'r1' },
        { role: 'assistant', content: 'the answer the reader is looking at', _serverItemId: 'r1', _ownerKey: 'p1#claude#u1' },
    ]);
    const page = [
        { role: 'user', content: 'q', _serverItemId: 'r1' },
        { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'r1' },
    ];
    s.adoptLocalAnswers(page, 'p1#claude#u1');
    assert.strictEqual(page[1].content, 'the answer the reader is looking at');
    assert.strictEqual(!!page[1]._streamPending, false);
});

await test('scheduleStreamRecovery reads the chunks back through the public name', async () => {
    const reads = [];
    const calls = configure({
        liveStreaming: true,
        clientSecretRequestFinalize: async () => ({ finalized: true }),
        clientSecretRequestStream: async (requestId, options) => {
            reads.push(requestId);
            if (options.onStream) options.onStream(WHOLE, 1);
            return RESOLVED_ENVELOPE;
        },
    });
    const s = makeSession(calls, [
        { role: 'user', content: 'q', _serverItemId: 'r1' },
        { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'r1' },
    ]);
    s.scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(20);
    assert.deepStrictEqual(reads, ['r1']);
    assert.strictEqual(s.state.messages[1].content, 'Recovered answer.');
});

await test('and it is a delegate, not a stub: with recovery off it does nothing and does not throw', async () => {
    const calls = configure({ liveStreaming: false });
    const s = makeSession(calls, [
        { role: 'assistant', content: '', _streamPending: true, _serverItemId: 'r1' },
    ]);
    s.scheduleStreamRecovery('p1#claude#u1', 'claude', 'p1', 'o1');
    await sleep(10);
    assert.strictEqual(s.state.messages[0].content, '');
});

/* ══ 4. the two clients say the same thing ═══════════════════════════════ */

const widget = stripComments(read(WIDGET_PATH));
const agent = hasAgent ? stripComments(read(AGENT_PATH)) : '';
const aiAgent = hasAgent ? stripComments(read(AI_AGENT_PATH)) : '';

/**
 * One rendering expression, normalised down to what it MEANS so that the two
 * clients' legitimate differences are not diffs:
 *   `row.`   a Vue template iterates rows and the widget is handed the message
 *   `?.`     the template's reads are optional-chained, the widget's are not
 *   quotes   a pug attribute is double-quoted, so its own strings are single
 *   space    formatting
 * Everything left after that is the claim itself, and the two must agree on it.
 */
function renderExpr(src, re, what) {
    const m = src.match(re);
    assert.ok(m, 'no ' + what + ' found');
    return m[1].replace(/row\./g, '').replace(/\?\./g, '.').replace(/'/g, '"').replace(/\s+/g, '');
}

/* The three streaming-related expressions each client owns a copy of. Held here
 * rather than described in prose so that adding a fourth is one line. */
const WIDGET_LOADER = /if\s*\((\(msg\.isPending[^{]*?)\)\s*\{/;
const AGENT_LOADER = /\.bq-bubble\(v-if="([^"]+)"\)/;
const WIDGET_RECOVER = /\}\s*else if \((streamRecoveryPhase\(msg\))\)\s*\{/;
const AGENT_RECOVER = /v-else-if="(streamRecoveryPhase\(row\.msg\))"/;
const WIDGET_TIME = /var ts = (msg\.isPending \? "" : formatChatTimestamp\(msg\._ts\));/;
const AGENT_TIME = /const bubbleTime = \(msg: ChatMessage\): string =>\s*\n?\s*(msg\?\.isPending \? "" : formatChatTimestamp\(msg\?\._ts\));/;

await test('the widget draws the loader ONLY where something is actually fetching the answer', () => {
    // A loader is a promise that something is coming. `_streamPending` alone is not
    // that promise: recovery is capped per history load and gives up on a failed
    // read, so a marked bubble is very often one nobody is fetching - and drawing
    // this branch for it spun a bubble for the rest of the session with no way for
    // the reader to resolve it. 'active' is the only phase that may spin.
    const cond = renderExpr(widget, WIDGET_LOADER, 'loader condition');
    assert.strictEqual(cond, '(msg.isPending&&!msg._streaming)||streamRecoveryPhase(msg)==="active"');
});

await test('and the widget offers the OTHER two phases a way to ask for the answer', () => {
    // 'idle' and 'failed' both mean nothing is coming; both are fixed by asking
    // again. Truthiness rather than a two-way test on purpose: the loader branch
    // above has already taken 'active', and '' is "not this state at all".
    const cond = renderExpr(widget, WIDGET_RECOVER, 'recovery affordance condition');
    assert.strictEqual(cond, 'streamRecoveryPhase(msg)');
});

if (!hasAgent) {
    skip('and agent.vue draws exactly the same one', 'www.bunnyquery.com is not checked out beside this package');
    skip('and agent.vue offers the affordance on exactly the same phases', 'www.bunnyquery.com is not checked out beside this package');
    skip('both clients suppress the timestamp on exactly the same bubbles', 'www.bunnyquery.com is not checked out beside this package');
    skip('neither client decides the recovery phase or its wording for itself', 'www.bunnyquery.com is not checked out beside this package');
} else {
    await test('and agent.vue draws exactly the same one', () => {
        // A hand-built DOM node and a Vue template cannot be the same code, so the
        // condition is the one thing held identical. This is the render half of the
        // fix: empty content on a _streamPending bubble means UNKNOWN, not "answered
        // nothing", so it must not render as an empty bubble - and it must not render
        // as a spinner either unless somebody is actually on their way to fill it.
        assert.strictEqual(renderExpr(agent, AGENT_LOADER, 'loader condition'), renderExpr(widget, WIDGET_LOADER, 'loader condition'));
    });

    await test('and agent.vue offers the affordance on exactly the same phases', () => {
        // The half that is easy to get subtly wrong: a client that tested
        // `=== "idle"` here would leave every FAILED read as a blank bubble, which is
        // the exact defect this branch exists to close, and it would look correct.
        assert.strictEqual(renderExpr(agent, AGENT_RECOVER, 'recovery affordance condition'), renderExpr(widget, WIDGET_RECOVER, 'recovery affordance condition'));
    });

    await test('both clients suppress the timestamp on exactly the same bubbles', () => {
        // Two lines from the loader condition, hand-duplicated, and NOT covered until
        // now. It is a streaming rule: a live turn takes the markdown branch WHILE it
        // runs, and a placeholder mapped from history carries the REQUEST time in
        // _ts, so a client that dropped the isPending test would date every streaming
        // answer before it exists. Before streaming, the spinner branch made this
        // implicit in both clients, which is exactly how a rule like this drifts.
        assert.strictEqual(renderExpr(agent, AGENT_TIME, 'bubbleTime expression'), renderExpr(widget, WIDGET_TIME, 'timestamp expression'));
    });

    await test('neither client decides the recovery phase or its wording for itself', () => {
        // Both must come from the engine. A second implementation of "is a spinner
        // honest here?" forks silently - the symptom is a bubble that spins in one
        // client and not the other - and a second set of words means the two clients
        // describe the same state differently to the same user.
        for (const src of [[widget, 'widget'], [agent, 'agent.vue']]) {
            assert.ok(/streamRecoveryPhase\s*\(/.test(src[0]), src[1] + ' does not call streamRecoveryPhase');
            assert.ok(/streamRecoveryLabels\s*\(/.test(src[0]), src[1] + ' does not call streamRecoveryLabels');
            assert.ok(!/function\s+streamRecoveryPhase/.test(src[0]), src[1] + ' redefines streamRecoveryPhase');
            assert.ok(!/const\s+streamRecoveryPhase\s*=/.test(src[0]), src[1] + ' redefines streamRecoveryPhase');
            assert.ok(!/function\s+streamRecoveryLabels/.test(src[0]), src[1] + ' redefines streamRecoveryLabels');
            assert.ok(!/const\s+streamRecoveryLabels\s*=/.test(src[0]), src[1] + ' redefines streamRecoveryLabels');
        }
        // And the affordance has to be wired to the engine's own read-back, not to a
        // client-side reimplementation of it: that path pins the finalize to the chat
        // the turn belongs to and refuses a second read while one is in flight.
        assert.ok(/recoverStreamedAnswer\s*\(/.test(widget), 'the widget button calls nothing');
        assert.ok(/chatSession\.recoverStreamedAnswer\s*\(/.test(agent), 'agent.vue does not delegate the retry to the engine');
    });
}

if (!hasAgent) {
    skip('both clients hand the engine the chunk reader', 'www.bunnyquery.com is not checked out beside this package');
    skip('both clients gate liveStreaming on the SHARED capability predicate', 'www.bunnyquery.com is not checked out beside this package');
    skip('agent.vue\'s forked error readers all see through the csr-poll envelope', 'www.bunnyquery.com is not checked out beside this package');
    skip('agent.vue\'s forked history path runs both merge-contract steps', 'www.bunnyquery.com is not checked out beside this package');
    skip('agent.vue pins the turn\'s own identity onto every foreground poll', 'www.bunnyquery.com is not checked out beside this package');
} else {
    await test('both clients hand the engine the chunk reader', () => {
        // Without it a streamed turn is only as durable as the tab that started it:
        // the engine marks the row and has no way back to the bytes.
        assert.ok(/clientSecretRequestStream/.test(widget), 'widget does not wire clientSecretRequestStream');
        assert.ok(/clientSecretRequestStream/.test(aiAgent), 'ai_agent.ts does not wire clientSecretRequestStream');
        assert.ok(/clientSecretRequestFinalize/.test(widget), 'widget does not wire clientSecretRequestFinalize');
        assert.ok(/clientSecretRequestFinalize/.test(aiAgent), 'ai_agent.ts does not wire clientSecretRequestFinalize');
    });

    await test('both clients gate liveStreaming on the SHARED capability predicate', () => {
        assert.ok(/skapiSupportsStreaming\s*\(/.test(widget), 'widget does not call skapiSupportsStreaming');
        assert.ok(/skapiSupportsStreaming\s*\(/.test(aiAgent), 'ai_agent.ts does not call skapiSupportsStreaming');
        // And neither carries its own copy of it. A second implementation is the fork
        // this whole file exists to prevent, and this one would fork silently: the
        // symptom of getting it wrong is an empty reply, not an error.
        assert.ok(!/function\s+skapiSupportsStreaming/.test(widget), 'widget redefines skapiSupportsStreaming');
        assert.ok(!/function\s+skapiSupportsStreaming/.test(aiAgent), 'ai_agent.ts redefines skapiSupportsStreaming');
    });

    await test('agent.vue\'s forked error readers all see through the csr-poll envelope', () => {
        // A STREAMED failure nests the provider payload one level down, because the
        // poller has to ship the chunks that arrived in the same response. Each of
        // these four is reachable for the same row as its engine twin, so a reader
        // that skipped the unwrap would report "No text response received from AI
        // provider" for a wrong API key.
        for (const fn of ['getErrorMessage', 'isErrorResponseBody', 'isAuthExpiredError', 'isNonRetryableRequestError']) {
            const re = new RegExp('const\\s+' + fn + '\\s*=\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]{0,600}?)csrEnvelopeError');
            assert.ok(re.test(agent), fn + ' does not unwrap the csr-poll envelope');
        }
    });

    await test('agent.vue\'s forked history path runs both merge-contract steps', () => {
        // Adoption keeps a streamed answer on screen across a refetch that lands
        // mid-finalize; the recovery goes back for one nobody finalized at all.
        assert.ok(/chatSession\.adoptLocalAnswers\s*\(/.test(agent), 'the fork never adopts local answers');
        assert.ok(/chatSession\.scheduleStreamRecovery\s*\(/.test(agent), 'the fork never schedules a recovery');
        // Both must be handed the ENGINE's spelling of the chat key: agent.vue's own
        // loadKey omits the identity segment, and passing it would make the engine's
        // "is this chat on screen?" test fail on every call, writing a recovered
        // answer into a cache key nothing reads.
        assert.ok(/adoptLocalAnswers\([^)]*engineLoadKey/.test(agent), 'adoptLocalAnswers is not given the engine-shaped key');
        assert.ok(/scheduleStreamRecovery\(\s*engineLoadKey/.test(agent), 'scheduleStreamRecovery is not given the engine-shaped key');
    });

    await test('agent.vue pins the turn\'s own identity onto every foreground poll', () => {
        // A live getIdentity() read at ack time describes where the user is NOW, not
        // where the turn came from: platform picks the finalize url and the extractor,
        // projectId/owner scope the finalize, ownerKey decides which chat is painted.
        assert.ok(
            /attachForegroundPoll\([^;]*ownerKey:\s*engineLoadKey/.test(agent),
            'attachForegroundPoll is not given the turn\'s pinned dispatch context',
        );
    });
}

/* ---- report --------------------------------------------------------------- */

let pass = 0;
for (const [ok, name, err] of results) {
    console.log((ok ? 'ok    ' : 'FAIL  ') + name + (err ? '\n        ' + err : ''));
    if (ok) pass++;
}
console.log('\n' + pass + '/' + results.length + ' passed');
process.exit(pass === results.length ? 0 : 1);

})();
