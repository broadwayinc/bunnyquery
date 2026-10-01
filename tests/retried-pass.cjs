/**
 * A failed pass the worker has already SENT AGAIN is not the file's outcome.
 *
 * Reported 2026-10-01 on a 3,684 page manual: Cloudflare in front of api.openai.com
 * answered 520 with its HTML page five times in one run. Each window was queued again
 * and the file was read whole, yet the chat showed the file dying there, with 300
 * characters of raw HTML under it. The worker now rewrites such a row's error with
 * `retried: true` and one readable line; this checks what the engine makes of it.
 *
 * Run: node ./tests/retried-pass.cjs
 */
const { buildChatDisplayList, getErrorMessage, isRetriedFailure, mapHistoryListToMessages } = require('../dist/engine.cjs');
const T = 1700000000000;
let fails = 0;
const ok = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + (d || ''))); if (!c) fails++; };

const RETRIED = { status_code: 520, retried: true, next_pass: 305,
  message: "The AI provider's gateway answered HTTP 520: api.openai.com | 520: Web server is returning an unknown error. The window was sent again automatically (pass 305)." };
const FINAL = { status_code: 520, body: '<html><title>520</title></html>', truncated: false };

console.log('--- the predicate and the line');
ok('a sent-again payload is recognised', isRetriedFailure(RETRIED) === true);
ok('a plain failure is not', isRetriedFailure(FINAL) === false);
ok('a streamed envelope unwraps', isRetriedFailure({ id: 'x', status: 'failed', in_queue: 0, error: RETRIED }) === true);
ok('nothing is not', isRetriedFailure(null) === false && isRetriedFailure('x') === false);
ok('the message is the worker line', getErrorMessage(RETRIED) === RETRIED.message, getErrorMessage(RETRIED));
ok('a gateway page without the line still names the status', /error 520/.test(getErrorMessage(FINAL)), getErrorMessage(FINAL));

console.log('--- the history mapper marks the bubble');
if (typeof mapHistoryListToMessages === 'function') {
  const P = 'Ka-32A.pdf';
  const row = (id, ts, error) => ({ id, status: 'failed', updated: ts, error,
    request_body: { input: [{ role: 'user', content: 'Continue indexing\n- storage path: ' + P }] } });
  const HISTORY_OPTS = { clearedAt: 0, projectId: 'p', formatIndexingLabel: (n) => 'Indexing: ' + n };
  const msgs = mapHistoryListToMessages([row('r1', T + 100, RETRIED), row('r2', T + 200, FINAL)], 'openai', HISTORY_OPTS).messages;
  const errs = msgs.filter(m => m.role === 'assistant' && m.isError);
  ok('two error bubbles', errs.length === 2, errs.length);
  const retried = errs.find(m => m.content === RETRIED.message);
  const final = errs.find(m => m.content !== RETRIED.message);
  ok('the sent-again one carries isRetried', !!retried && retried.isRetried === true, JSON.stringify(retried));
  ok('the final one does not', !!final && !final.isRetried, JSON.stringify(final));
} else {
  console.log('  (mapper not exported; skipped)');
}

console.log('--- the file row');
function up(id, path, ts) {
  return { role: 'user', isBackgroundTask: true, _serverItemId: id, _ts: ts,
    content: 'A new file has just been uploaded\n- storage path: ' + path,
    _indexFile: { name: path, path, continued: false, mime: 'application/pdf' } };
}
function uc(id, path, ts, pending) {
  return { role: 'user', isBackgroundTask: true, _serverItemId: id, _ts: ts,
    content: 'Continue indexing\n- storage path: ' + path,
    _indexFile: { name: path, path, continued: true, mime: 'application/pdf' },
    ...(pending ? { isPendingInProcess: true } : {}) };
}
const okMsg = (id, ts) => ({ role: 'assistant', isBackgroundTask: true, _serverItemId: id, _ts: ts, content: 'Saved pages 1 to 5.' });
const errMsg = (id, ts, retried) => ({ role: 'assistant', isBackgroundTask: true, _serverItemId: id, _ts: ts, isError: true,
  content: retried ? RETRIED.message : 'The AI provider returned a server error. (error 520)', ...(retried ? { isRetried: true } : {}) });
const P = 'Ka-32A.pdf';
const rows = (msgs, opts) => buildChatDisplayList(msgs, Object.assign({ windowedIndexing: true }, opts || {})).filter(r => r.kind === 'indexing');

let r = rows([up('a1', P, T + 100), okMsg('a1', T + 110), uc('a2', P, T + 200), errMsg('a2', T + 210, true)], { liveIndexChecked: true, liveIndexKeys: { [P]: true } });
ok('a sent-again failure as the newest pass does not make the file red', r.length === 1 && r[0].group.status !== 'error', r[0] && r[0].group.status);
ok('and the row is still live', r.length === 1 && r[0].group.finished === false);

r = rows([up('a1', P, T + 100), errMsg('a1', T + 110, true)], { liveIndexChecked: true, liveIndexKeys: { [P]: true } });
ok('a run whose only loaded pass was sent again is active', r.length === 1 && r[0].group.status === 'active', r[0] && r[0].group.status);

r = rows([up('a1', P, T + 100), okMsg('a1', T + 110), uc('a2', P, T + 200), errMsg('a2', T + 210, true), uc('a3', P, T + 300), okMsg('a3', T + 310)],
  { liveIndexChecked: true, liveIndexKeys: {}, doneKeys: { [P]: true } });
ok('with the replacement landed the file is done', r.length === 1 && r[0].group.status === 'done' && r[0].group.finished === true, r[0] && JSON.stringify([r[0].group.status, r[0].group.finished]));

r = rows([up('a1', P, T + 100), okMsg('a1', T + 110), uc('a2', P, T + 200), errMsg('a2', T + 210, false)], { liveIndexChecked: true, liveIndexKeys: {} });
ok('a failure that was NOT sent again still makes the file red', r.length === 1 && r[0].group.status === 'error', r[0] && r[0].group.status);

r = rows([up('a1', P, T + 100), okMsg('a1', T + 110), uc('a2', P, T + 200), errMsg('a2', T + 210, false), uc('a3', P, T + 300), errMsg('a3', T + 310, true)], { liveIndexChecked: true, liveIndexKeys: {} });
ok('a sent-again failure is passed over to the outcome before it', r.length === 1 && r[0].group.status === 'error', r[0] && r[0].group.status);

if (fails) { console.log('FAILED ' + fails); process.exit(1); } else console.log('all ok');
