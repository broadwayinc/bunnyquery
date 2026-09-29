/**
 * The run:: record's terminal verdict outranks what a loaded run's passes imply.
 *
 * Reported as: a file "shows failed, then after more history is fetched shows green
 * indexed". Its chain died worker-side (three failed retries), the worker closed the
 * run:: record as 'error', but the loaded passes look settled (the model answered
 * normally each time), so the chat row said "Indexed" and the files page painted the
 * badge green from that verdict. The record must win when it describes THIS run and is
 * newer than the newest loaded pass; a live queue hit and visible work still win over it.
 *
 * Run: node ./tests/indexing-run-record-verdict.cjs
 */
const { buildChatDisplayList } = require('../dist/engine.cjs');
const T = 1700000000000;
let fails = 0;
const ok = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + (d || ''))); if (!c) fails++; };
function up(id, path, ts, pending) {
  return { role: 'user', isBackgroundTask: true, _serverItemId: id, _ts: ts,
    content: 'A new file has just been uploaded\n- storage path: ' + path,
    _indexFile: { name: path.split('/').pop(), path, continued: false, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ...(pending ? { isPendingInProcess: true } : {}) };
}
function uc(id, path, ts, pending) {
  return { role: 'user', isBackgroundTask: true, _serverItemId: id, _ts: ts,
    content: 'Continue indexing\n- storage path: ' + path,
    _indexFile: { name: path.split('/').pop(), path, continued: true, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ...(pending ? { isPendingInProcess: true } : {}) };
}
const ar = (id, ts, isError) => ({ role: 'assistant', isBackgroundTask: true, _serverItemId: id, _ts: ts, content: 'Indexed the file.', ...(isError ? { isError: true } : {}) });
const chat = (ts) => ({ role: 'user', content: 'hello', _ts: ts });
const rows = (msgs, opts) => buildChatDisplayList(msgs, opts || {}).filter(r => r.kind === 'indexing');
const P = '2025-11.xlsx';
const loaded = [chat(T), up('a1', P, T + 100), ar('a1', T + 110), uc('a2', P, T + 200), ar('a2', T + 210), uc('a3', P, T + 300), ar('a3', T + 310)];

console.log('--- THE REPORTED SHAPE: passes look settled, the record says the run errored');
let r = rows(loaded, { liveIndexChecked: true, liveIndexKeys: {},
  runStubs: { [P]: { status: 'error', started: T + 90, finished: T + 400, error: 'The chain ended without confirming the whole file was read.', platform: 'openai' } } });
ok('one row', r.length === 1, 'got ' + r.length);
ok('status is error, not done', r[0] && r[0].group.status === 'error', r[0] && r[0].group.status);
ok('finished, not resolving', r[0] && r[0].group.finished === true && r[0].group.resolving === false);

console.log('--- a record that says done after an errored last pass: done wins');
r = rows([chat(T), up('a1', P, T + 100), ar('a1', T + 110, true)], { liveIndexChecked: true, liveIndexKeys: {},
  runStubs: { [P]: { status: 'done', started: T + 90, finished: T + 500 } } });
ok('status is done', r[0] && r[0].group.status === 'done', r[0] && r[0].group.status);

console.log('--- a record OLDER than the newest loaded pass does not override it');
r = rows(loaded, { liveIndexChecked: true, liveIndexKeys: {},
  runStubs: { [P]: { status: 'error', started: T - 5000, finished: T - 4000 } } });
ok('status stays done', r[0] && r[0].group.status === 'done', r[0] && r[0].group.status);

console.log('--- a record of a LATER run is not this run\'s verdict');
r = rows(loaded, { liveIndexChecked: true, liveIndexKeys: {},
  runStubs: { [P]: { status: 'error', started: T + 900, finished: T + 950 } } });
const mine = r.find(x => x.group.members && x.group.members.length);
ok('the loaded run keeps its own state', mine && mine.group.status === 'done', mine && mine.group.status);

console.log('--- a live queue hit outranks the record');
r = rows(loaded, { liveIndexChecked: true, liveIndexKeys: { [P]: true },
  runStubs: { [P]: { status: 'error', started: T + 90, finished: T + 400 } } });
ok('not painted error while the file is live', r[0] && r[0].group.status !== 'error', r[0] && r[0].group.status);

console.log('--- visible work outranks the record');
r = rows([chat(T), up('a1', P, T + 100), ar('a1', T + 110), uc('a2', P, T + 200, true)], { liveIndexChecked: true, liveIndexKeys: {},
  runStubs: { [P]: { status: 'error', started: T + 90, finished: T + 400 } } });
ok('a pending pass keeps the row active', r[0] && r[0].group.status === 'active', r[0] && r[0].group.status);

console.log('--- a working record changes nothing');
r = rows(loaded, { liveIndexChecked: true, liveIndexKeys: {},
  runStubs: { [P]: { status: 'working', started: T + 90 } } });
ok('status untouched', r[0] && r[0].group.status === 'done', r[0] && r[0].group.status);

console.log('\n' + (fails ? fails + ' FAILED' : 'all passed'));
process.exit(fails ? 1 : 0);
