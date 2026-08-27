/**
 * One file must draw ONE indexing row.
 *
 * Reported as "duplicate stubs, same file, one yellow in-progress and one green complete,
 * on chat visit". Four separate defects could produce a pair; the one that matches the
 * report needs no duplicate data at all, only passes walked OUT OF ORDER, which paging and
 * the background-history merge can do:
 *
 *     [chat, continuation(a2), continuation(a3, pending), FIRST(a1)]
 *
 * The continuations opened a run; the late first pass re-opened it (that line exists for
 * genuine re-indexes); the abandoned run was force-finished GREEN beside the fragment,
 * which kept the pending pass and stayed YELLOW.
 *
 * The other three: a run:: key differing from its group's key by leading/trailing
 * whitespace (the record keeps the raw storagePath, the group's is trimmed out of the
 * prompt), a stub liveness test matching a BARE FILENAME so a same-named file in another
 * folder painted a finished stub yellow, and a locally minted record carrying no platform
 * (shown in both chats).
 *
 * The last two cases below are the regression guards: a REAL re-index must still produce
 * two rows, and a legacy pathless prompt must still match by name.
 *
 * Run: node ./tests/indexing-row-duplication.cjs
 */

const { buildChatDisplayList } = require('../dist/engine.cjs');
const T = 1700000000000;
let fails = 0;
const ok = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + (d||''))); if (!c) fails++; };

function up(id, path, ts, pending) { // FIRST pass
  return { role:'user', isBackgroundTask:true, _serverItemId:id, _ts:ts,
    content:'A new file has just been uploaded\n- storage path: '+path,
    _indexFile:{ name:path.split('/').pop(), path:path, continued:false },
    ...(pending?{isPendingInProcess:true}:{}) };
}
function uc(id, path, ts, pending) { // CONTINUATION
  return { role:'user', isBackgroundTask:true, _serverItemId:id, _ts:ts,
    content:'Continue indexing\n- storage path: '+path,
    _indexFile:{ name:path.split('/').pop(), path:path, continued:true },
    ...(pending?{isPendingInProcess:true}:{}) };
}
const ar = (id, ts) => ({ role:'assistant', isBackgroundTask:true, _serverItemId:id, _ts:ts, content:'done' });
const chat = (ts) => ({ role:'user', content:'hello', _ts:ts });
const rows = (msgs, opts) => buildChatDisplayList(msgs, opts||{}).filter(r => r.kind === 'indexing');

const P = 'uid/docs/report.pdf';

console.log('--- misorder: continuations walked before the first pass (the reported shape)');
let r = rows([chat(T), uc('a2',P,T+200), ar('a2',T+210), uc('a3',P,T+300,true), up('a1',P,T+100), ar('a1',T+110)],
             { liveIndexChecked:true, liveIndexKeys:{} });
ok('one row, not a green+yellow pair', r.length===1, 'got '+r.length+' -> '+r.map(x=>x.group.status).join(','));

console.log('--- duplicated first-pass bubble');
r = rows([chat(T), up('a1',P,T+100), ar('a1',T+110), up('a1',P,T+100), ar('a1',T+110), uc('a2',P,T+200,true)],
         { liveIndexChecked:true, liveIndexKeys:{} });
ok('duplicate copy does not split the run', r.length===1, 'got '+r.length);

console.log('--- genuine re-index still opens a second run');
r = rows([chat(T), up('a1',P,T+100), ar('a1',T+110), up('b1',P,T+900,true), ar('b1',T+910)],
         { liveIndexChecked:true, liveIndexKeys:{} });
ok('re-index gives two rows', r.length===2, 'got '+r.length);

console.log('--- whitespace path: stub suppressed by its real group');
const WS = 'uid/docs/report.pdf ';
r = rows([chat(T), up('a1',WS,T+100), ar('a1',T+110)],
         { liveIndexChecked:true, liveIndexKeys:{}, stubPlatform:'claude',
           runStubs:{ [WS]: { status:'working', started:T+100, platform:'claude' } } });
ok('one row for a trailing-space path', r.length===1, 'got '+r.length+' -> '+r.map(x=>x.group.status).join(','));

console.log('--- bare-name liveness must not claim another folder\'s file');
r = rows([chat(T), up('b1','uid/2026/report.pdf',T+100), ar('b1',T+110)],
         { liveIndexChecked:true, stubPlatform:'claude',
           liveIndexKeys:{ 'uid/archive/report.pdf':true, 'report.pdf':true },
           runStubs:{ 'uid/2025/report.pdf': { status:'done', started:T, finished:T+900, platform:'claude' } } });
const stub = r.find(x => x.group.key === 'uid/2025/report.pdf');
ok('a DONE stub stays green when another folder\'s file is live', !!stub && stub.group.status==='done',
   stub ? stub.group.status : 'stub missing');

console.log('--- pathless legacy prompt still matches by name');
r = rows([chat(T)], { liveIndexChecked:true, stubPlatform:'claude',
           liveIndexKeys:{ 'report.pdf':true },
           runStubs:{ 'uid/2025/report.pdf': { status:'working', started:T, platform:'claude' } } });
ok('bare-name live hit still works when unambiguous', r.length===1 && r[0].group.status==='active',
   r.length ? r[0].group.status : 'no row');

console.log(fails ? '\n'+fails+' FAILED' : '\nALL PASS');
process.exit(fails?1:0);
