/**
 * How long one indexing pass took, shown beside its own end time.
 *
 * The two numbers already exist on ONE server history item: `created` is the
 * pass's start and `updated` its end. The mapper split them across two bubbles
 * (start onto the request, end onto the reply), and a continuation's request
 * bubble is deliberately hidden from the expanded row -- so the reply now also
 * carries the start, as `_tsStart`, and can subtract for itself.
 *
 * `_tsStart` is stamped ONLY on an indexing pass's reply. Its presence is what
 * scopes the duration to indexing responses, so neither view needs a second test.
 *
 * AND IT IS THE EXECUTION START, not the enqueue time. `created` is stamped when the
 * row is queued and a row can wait there for a long time before it runs, so
 * `updated - created` would report the queue wait as though it were the read. The
 * worker records the real thing as `att` (written immediately before the upstream call
 * fires, doubling as the at-most-once gate) and the SDK now projects it as `executed`,
 * normalised from the worker's seconds to ms.
 *
 * Run: node ./tests/pass-duration.cjs
 */

const assert = require('assert');
const { formatDuration, mapHistoryListToMessages } = require('../dist/engine.cjs');

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}
const S = 1000, M = 60 * S, H = 60 * M;

test('seconds only', () => {
    assert.strictEqual(formatDuration(4 * S), '4s');
    assert.strictEqual(formatDuration(59 * S), '59s');
});

test('minutes and seconds', () => {
    assert.strictEqual(formatDuration(M + 4 * S), '1m 4s');
    assert.strictEqual(formatDuration(2 * M + 4 * S), '2m 4s');
    assert.strictEqual(formatDuration(59 * M + 59 * S), '59m 59s');
});

test('the shape asked for: 1h 2m 4s', () => {
    assert.strictEqual(formatDuration(H + 2 * M + 4 * S), '1h 2m 4s');
});

test('a zero unit is dropped, not padded', () => {
    assert.strictEqual(formatDuration(H + 4 * S), '1h 4s');       // not "1h 0m 4s"
    assert.strictEqual(formatDuration(H), '1h 0s');               // seconds always shown
    assert.strictEqual(formatDuration(M), '1m 0s');
});

test('HOURS ARE THE LARGEST UNIT: days roll up rather than reading as plausible', () => {
    // 2d 1h 2m 3s of bad data must read as the anomaly it is
    assert.strictEqual(formatDuration(49 * H + 2 * M + 3 * S), '49h 2m 3s');
    assert.strictEqual(formatDuration(24 * H), '24h 0s');   // zero minutes dropped, as above
    assert.ok(!/d/.test(formatDuration(100 * H)), 'no days unit is ever emitted');
});

test('sub-second, zero and negative produce NOTHING, so the caller shows only the time', () => {
    // a one-sided server timestamp collapses start and end to the same value
    assert.strictEqual(formatDuration(0), '');
    assert.strictEqual(formatDuration(999), '');
    assert.strictEqual(formatDuration(-5000), '');   // clock skew, updated < created
});

test('missing or non-finite input produces nothing rather than throwing', () => {
    assert.strictEqual(formatDuration(undefined), '');
    assert.strictEqual(formatDuration(null), '');
    assert.strictEqual(formatDuration(NaN), '');
    assert.strictEqual(formatDuration(Infinity), '');
    assert.strictEqual(formatDuration('60000'), '');
});

test('truncates rather than rounds, so a pass never reads longer than it ran', () => {
    assert.strictEqual(formatDuration(4 * S + 999), '4s');
});

/* ---- the pairing the views actually do ---------------------------------- */

test('an indexing reply subtracts its own stamps; an ordinary reply has none', () => {
    const pass = { _ts: 1000000 + 64 * S, _tsStart: 1000000 };
    assert.strictEqual(formatDuration(pass._ts - pass._tsStart), '1m 4s');
    const ordinary = { _ts: 1000000 };
    assert.strictEqual(typeof ordinary._tsStart, 'undefined'); // scope is the field's presence
});

/* ---- the mapper: which stamp _tsStart actually comes from ---------------- */

const INDEX_ITEM = (extra) => Object.assign({
    id: 'req-1',
    status: 'resolved',
    _isBgTask: true,
    // the real wire shape parseIndexingRequestText reads, not the display label
    request_body: { messages: [{ role: 'user', content: [
        'Index this file.',
        '- name: q3.xlsx',
        '- mime type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '- storage path: uploads/q3.xlsx',
    ].join('\n') }] },
    response_body: { content: [{ type: 'text', text: 'Indexed q3.xlsx (spreadsheet): five sheets.' }] },
}, extra);

const HISTORY_OPTS = {
    clearedAt: 0, projectId: 'svc-1', userId: 'u1',
    formatIndexingLabel: (name) => 'Indexing: ' + name,
};
const replyOf = (item) => {
    const out = mapHistoryListToMessages([item], 'claude', HISTORY_OPTS);
    return out.messages.filter((m) => m.role === 'assistant').pop();
};

const QUEUED = 1_000_000_000_000;          // enqueued
const RAN = QUEUED + 3600 * S;             // picked up an hour later
const DONE = RAN + 64 * S;                 // and took 1m 4s to run

test('THE POINT: _tsStart is the EXECUTION start, not the enqueue time', () => {
    const reply = replyOf(INDEX_ITEM({ created: QUEUED, executed: RAN, updated: DONE }));
    assert.ok(reply, 'no assistant bubble was mapped');
    assert.strictEqual(reply._tsStart, RAN);
    assert.notStrictEqual(reply._tsStart, QUEUED);
    // and therefore the bubble reports the RUN, not the hour it waited
    assert.strictEqual(formatDuration(reply._ts - reply._tsStart), '1m 4s');
});

test('no `executed` means NO duration, rather than falling back to the queue wait', () => {
    const reply = replyOf(INDEX_ITEM({ created: QUEUED, updated: DONE }));
    assert.strictEqual(reply._tsStart, undefined);
});

test('a zero/!finite `executed` is treated as absent', () => {
    assert.strictEqual(replyOf(INDEX_ITEM({ created: QUEUED, executed: 0, updated: DONE }))._tsStart, undefined);
    assert.strictEqual(replyOf(INDEX_ITEM({ created: QUEUED, executed: null, updated: DONE }))._tsStart, undefined);
});

test('a FAILED pass still reports how long it ran before it failed', () => {
    // It ran: `att` is stamped before the upstream call fires, so a failed row
    // carries it exactly as a resolved one does. This is where a timeout is most
    // worth seeing, and the error branch used to drop it.
    const failed = Object.assign(INDEX_ITEM({ created: QUEUED, executed: RAN, updated: DONE }), {
        status: 'failed',
        response_body: undefined,
        error: { message: 'upstream timed out' },
    });
    const reply = replyOf(failed);
    assert.ok(reply.isError, 'expected the error branch');
    assert.strictEqual(reply._tsStart, RAN);
    assert.strictEqual(formatDuration(reply._ts - reply._tsStart), '1m 4s');
});

test('an ORDINARY reply carries no _tsStart, which is what scopes the duration', () => {
    const ordinary = Object.assign(INDEX_ITEM({ created: QUEUED, executed: RAN, updated: DONE }), {
        _isBgTask: false,
        request_body: { messages: [{ role: 'user', content: 'what is in q3?' }] },
    });
    assert.strictEqual(replyOf(ordinary)._tsStart, undefined);
});

test('the reply still ends at `updated`', () => {
    const reply = replyOf(INDEX_ITEM({ created: QUEUED, executed: RAN, updated: DONE }));
    assert.strictEqual(reply._ts, DONE);
});

let pass = 0;
for (const [ok, name, msg] of results) {
    console.log(ok ? `ok    ${name}` : `FAIL  ${name}\n        ${msg}`);
    if (ok) pass++;
}
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
