/**
 * Stopping one file's indexing can stop the others in the same confirm.
 *
 * The Stop dialog is opened from ONE file's row. With a batch being indexed that
 * meant opening and confirming it once per file. It now carries a checkbox,
 * "Also stop the N other files being indexed", shown only while other files are
 * being indexed and unticked every time the dialog opens, so the default confirm
 * does exactly what it always did.
 *
 * NOTHING NEW IN THE ENGINE. Ticked, both clients call the engine's existing
 * cancelIndexingGroup once per file. So three things are pinned here:
 *
 *   1. the engine's stop is safe to call for several files from ONE display-list
 *      snapshot: every live pass is cancelled exactly once, whatever the order;
 *   2. the widget's dialog: when the checkbox shows, what it says, that the
 *      count follows the chat while the dialog is open, and what a confirm stops;
 *   3. agent.vue's dialog, which must behave identically.
 *
 * Neither dialog is importable (the widget is a browser IIFE, agent.vue an SFC), so
 * each one's source is lifted out of the file and run for real: the widget's
 * against a small stand-in for `h` and `openModal`, agent.vue's against Vue's own
 * `ref` and `computed`. Both run on the real ChatSession and the real
 * buildChatDisplayList, and the lifts assert their own markers, so a rename fails
 * this test loudly rather than passing on nothing.
 *
 * Run: node ./tests/stop-indexing-others.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ChatSession, configureChatEngine, buildChatDisplayList } = require('../dist/engine.cjs');

const DASHBOARD_DIR = ['bunnyquery.com', 'www.bunnyquery.com']
    .map((d) => path.resolve(__dirname, '..', '..', d))
    .find((d) => fs.existsSync(d)) || path.resolve(__dirname, '..', '..', 'bunnyquery.com');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}
const settle = () => new Promise((r) => setTimeout(r, 5));

/* ---- a chat with files being indexed --------------------------------------- */

const IDENT = { projectId: 'svc-1', owner: 'own-1', platform: 'claude', userId: 'user-abc' };

/** One pass of one file, as its bubbles: a running pass has its "Thinking"
 *  placeholder, a queued one is the request bubble alone. */
function pass(id, name, state) {
    const ask = { role: 'user', content: 'Indexing: ' + name, isBackgroundTask: true, _serverItemId: id, _indexFile: { name: name, path: 'uploads/' + name } };
    if (state === 'done') {
        return [ask, { role: 'assistant', content: 'Indexed ' + name + '. INDEXING_COMPLETE', isBackgroundTask: true, _serverItemId: id, _indexComplete: true }];
    }
    if (state === 'queued') return [Object.assign(ask, { isPendingQueued: true })];
    return [Object.assign(ask, { isPendingInProcess: true }), { role: 'assistant', content: '', isPending: true, isBackgroundTask: true, _serverItemId: id }];
}

function makeSession(messages) {
    const cancels = [];
    configureChatEngine({
        clientSecretRequest: async () => ({}),
        clientSecretRequestHistory: async () => ({ list: [] }),
        mcpBaseUrl: 'https://mcp.example.com',
    });
    const s = new ChatSession({
        getIdentity: () => IDENT,
        buildSystemPrompt: () => '',
        notify: () => {},
        refreshMessageBubble: () => {},
        scrollToBottom: () => {},
        scrollToBottomIfSticky: () => {},
        isViewMounted: () => false,
        getClearedAt: () => 0,
        formatIndexingLabel: (name) => 'Indexing: ' + name,
        cancelRequest: (req) => { cancels.push(req.id); return Promise.resolve({ removed: true, message: 'ok' }); },
    });
    s.state.messages = messages;
    return { s, cancels };
}

const displayOptions = (s) => ({ stoppedIndexIds: s.state.stoppedIndexIds, liveIndexKeys: s.state.liveIndexKeys });
const groupsOf = (s) => buildChatDisplayList(s.state.messages, displayOptions(s)).filter((r) => r.kind === 'indexing').map((r) => r.group);
const stoppable = (g) => !!g && !g.stub && !g.finished && !g.resolving && !g.stopped && !g.cancelling;
const THREE = () => [...pass('a1', 'a.pdf', 'running'), ...pass('b1', 'b.pdf', 'queued'), ...pass('c1', 'c.pdf', 'queued')];

/* ---- lift the widget's dialog ---------------------------------------------- */

const WIDGET_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const W_OPEN = '\n    var stopIndexState = { runKey: "", fileKey: "", handle: null };\n';
const W_CLOSE = '\n    // Keyed by FILE (group.key), NOT by run (group.runKey)';
const wStart = WIDGET_SRC.indexOf(W_OPEN);
assert.notStrictEqual(wStart, -1, 'stopIndexState not found in src/index.js');
const wEnd = WIDGET_SRC.indexOf(W_CLOSE, wStart);
assert.notStrictEqual(wEnd, -1, 'could not find the end of the stop-indexing dialog block');
const WIDGET_BLOCK = WIDGET_SRC.slice(wStart, wEnd);
for (const name of ['function indexGroupStoppable(', 'function findCancellableIndexGroup(', 'function otherStoppableIndexGroups(',
    'function refreshStopIndexOthers(', 'function syncStopIndexModal(', 'function openStopIndexModal(']) {
    assert.ok(WIDGET_BLOCK.includes(name), 'lifted the wrong block of source: no ' + name);
}

/** As much of an element as the dialog touches. */
function h(tag, attrs) {
    const el = {
        tag: tag, className: '', textContent: '', checked: false, style: {}, children: [], listeners: {},
        addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
        fire(type) { (el.listeners[type] || []).slice().forEach((fn) => fn({ target: el })); },
    };
    attrs = attrs || {};
    if (attrs.class) el.className = attrs.class;
    if (attrs.text) el.textContent = attrs.text;
    if (attrs.type) el.type = attrs.type;
    if (typeof attrs.onclick === 'function') el.addEventListener('click', attrs.onclick);
    for (let i = 2; i < arguments.length; i++) {
        const child = arguments[i];
        if (child == null || child === false) continue;
        if (typeof child === 'string') { el.textContent += child; continue; }
        el.children.push(child);
    }
    return el;
}
const findAll = (el, pred, out) => { out = out || []; if (pred(el)) out.push(el); (el.children || []).forEach((c) => findAll(c, pred, out)); return out; };

function makeWidget(messages) {
    const { s, cancels } = makeSession(messages);
    const CS = { get messages() { return s.state.messages; } };
    let dialog = null;
    function openModal(build) {
        const handle = { root: { parentNode: {} }, close() { handle.root.parentNode = null; } };
        handle.tree = build(handle.close);
        dialog = handle;
        return handle;
    }
    const api = new Function('buildChatDisplayList', 'CS', 'displayListOptions', 'h', 'openModal', 'session',
        WIDGET_BLOCK + '\nreturn { openStopIndexModal: openStopIndexModal, syncStopIndexModal: syncStopIndexModal, stopIndexModalIsOpen: stopIndexModalIsOpen };'
    )(buildChatDisplayList, CS, () => displayOptions(s), h, openModal, s);
    const view = {
        s, cancels,
        /** Click a file's Stop. */
        open(key) { api.openStopIndexModal(groupsOf(s).find((g) => g.key === key)); },
        /** What every renderMessages does. */
        render() { api.syncStopIndexModal(); },
        isOpen: () => api.stopIndexModalIsOpen(),
        row: () => findAll(dialog.tree, (e) => e.className === 'bq-overwrite-applyall')[0],
        box: () => findAll(dialog.tree, (e) => e.tag === 'input' && e.type === 'checkbox')[0],
        shown() { const r = view.row(); return !!r && r.style.display !== 'none'; },
        label: () => view.row().children[1].textContent,
        tick(on) { const b = view.box(); b.checked = on !== false; b.fire('change'); },
        confirm() { findAll(dialog.tree, (e) => e.tag === 'button' && e.textContent === 'Stop indexing')[0].fire('click'); },
        keep() { findAll(dialog.tree, (e) => e.tag === 'button' && e.textContent === 'Keep indexing')[0].fire('click'); },
    };
    return view;
}

/* ---- lift agent.vue's dialog ----------------------------------------------- */

const AGENT = path.join(DASHBOARD_DIR, 'src/views/service/agent.vue');
let makeAgent = null;
let agentSkip = '';
if (!fs.existsSync(AGENT)) {
    agentSkip = 'bunnyquery.com is not checked out beside this package';
} else {
    let reactivity = null, ts = null;
    try {
        reactivity = require(path.join(DASHBOARD_DIR, 'node_modules/@vue/reactivity'));
        ts = require('typescript');
    } catch (e) { agentSkip = 'the dashboard has no node_modules to take Vue from'; }
    if (reactivity && ts) {
        const AGENT_SRC = fs.readFileSync(AGENT, 'utf8');
        const lift = (open, close) => {
            const start = AGENT_SRC.indexOf(open);
            assert.notStrictEqual(start, -1, 'not found in agent.vue: ' + open.trim().slice(0, 50));
            const end = AGENT_SRC.indexOf(close, start);
            assert.notStrictEqual(end, -1, 'could not find the end of: ' + open.trim().slice(0, 50));
            return AGENT_SRC.slice(start, end + close.length);
        };
        // The row's Stop (which opens the dialog), then the dialog's own state.
        const opener = lift('\nconst indexGroupStoppable = (group: IndexingGroup): boolean =>', '\n    stopIndexFileKey.value = group.key;\n};\n');
        const dialogSrc = lift('\nconst stopIndexTarget = computed<IndexingGroup | null>(() => {', '\n    for (const other of others) chatSession.cancelIndexingGroup(other);\n};\n');
        assert.ok(dialogSrc.includes('const stopIndexOthers = computed<IndexingGroup[]>('), 'lifted the wrong block of agent.vue');
        const js = ts.transpileModule(opener + dialogSrc, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
        makeAgent = (messages) => {
            const { s, cancels } = makeSession(messages);
            const tick = reactivity.ref(0);
            // agent.vue's rows: the engine's display list, with an indexing entry named "group".
            const chatDisplayRows = reactivity.computed(() => {
                tick.value;
                return buildChatDisplayList(s.state.messages, displayOptions(s)).map((e) => e.kind === 'indexing' ? { kind: 'group', group: e.group } : { kind: 'message' });
            });
            const api = new Function('ref', 'computed', 'chatDisplayRows', 'chatSession',
                js + '\nreturn { cancelIndexGroup, stopIndexTarget, stopIndexOtherCount, stopIndexOthersLabel, stopIndexAlsoOthers, confirmStopIndexGroup, closeStopIndexModal };'
            )(reactivity.ref, reactivity.computed, chatDisplayRows, s);
            const view = {
                s, cancels,
                open(key) { api.cancelIndexGroup(chatDisplayRows.value.filter((r) => r.kind === 'group').map((r) => r.group).find((g) => g.key === key)); },
                render() { tick.value++; },
                isOpen: () => !!api.stopIndexTarget.value,             // Modal(:open="!!stopIndexTarget")
                shown: () => !!api.stopIndexTarget.value && !!api.stopIndexOtherCount.value,   // label(v-if="stopIndexOtherCount")
                label: () => api.stopIndexOthersLabel.value,
                tick(on) { api.stopIndexAlsoOthers.value = on !== false; },                    // input(v-model="stopIndexAlsoOthers")
                confirm() { api.confirmStopIndexGroup(); tick.value++; },
                keep() { api.closeStopIndexModal(); },
            };
            return view;
        };
    }
}

/* ---- the scenarios, run against each client -------------------------------- */

async function dialogScenarios(client, make) {
    const scenarios = [];
    const t = (name, fn) => scenarios.push([client + ': ' + name, fn]);

    t('one file being indexed: no checkbox, and Stop stops that file', async () => {
        const v = make([...pass('a1', 'a.pdf', 'running')]);
        v.open('uploads/a.pdf');
        assert.strictEqual(v.isOpen(), true);
        assert.strictEqual(v.shown(), false);
        v.confirm();
        assert.deepStrictEqual(v.cancels, ['a1']);
    });

    t('three files: the checkbox counts the OTHER two', async () => {
        const v = make(THREE());
        v.open('uploads/b.pdf');
        assert.strictEqual(v.shown(), true);
        assert.strictEqual(v.label(), 'Also stop the 2 other files being indexed');
    });

    t('two files: the wording is singular', async () => {
        const v = make([...pass('a1', 'a.pdf', 'running'), ...pass('b1', 'b.pdf', 'queued')]);
        v.open('uploads/a.pdf');
        assert.strictEqual(v.label(), 'Also stop the other file being indexed');
    });

    t('UNTICKED is the default, and it stops only the file the dialog is about', async () => {
        const v = make(THREE());
        v.open('uploads/b.pdf');
        v.confirm();
        assert.deepStrictEqual(v.cancels, ['b1']);
        await settle();
        assert.deepStrictEqual(groupsOf(v.s).filter(stoppable).map((g) => g.key), ['uploads/a.pdf', 'uploads/c.pdf'], 'the other files must still be running');
    });

    t('TICKED stops every file, the one asked about first, each pass once', async () => {
        const v = make(THREE());
        v.open('uploads/b.pdf');
        v.tick();
        v.confirm();
        assert.deepStrictEqual(v.cancels, ['b1', 'a1', 'c1']);
        await settle();
        assert.deepStrictEqual(groupsOf(v.s).filter(stoppable), [], 'nothing may be left offering Stop');
        assert.strictEqual(v.isOpen(), false);
    });

    t('Keep indexing stops nothing, ticked or not', async () => {
        const v = make(THREE());
        v.open('uploads/b.pdf');
        v.tick();
        v.keep();
        assert.deepStrictEqual(v.cancels, []);
        assert.strictEqual(v.isOpen(), false);
    });

    t('the tick does not survive into the next dialog', async () => {
        const v = make(THREE());
        v.open('uploads/b.pdf');
        v.tick();
        v.keep();
        v.open('uploads/a.pdf');
        v.confirm();
        assert.deepStrictEqual(v.cancels, ['a1'], 'a tick left over from a dismissed dialog stopped other files');
    });

    t('files that are finished, already stopping, or not loaded are not "other files"', async () => {
        const v = make([...pass('a1', 'a.pdf', 'running'), ...pass('d1', 'd.pdf', 'done'),
            ...pass('e1', 'e.pdf', 'queued').map((m) => Object.assign(m, { _cancelling: true })), ...pass('b1', 'b.pdf', 'queued')]);
        v.open('uploads/a.pdf');
        assert.strictEqual(v.label(), 'Also stop the other file being indexed');
        v.tick();
        v.confirm();
        assert.deepStrictEqual(v.cancels, ['a1', 'b1']);
    });

    t('the count follows the chat while the dialog is open', async () => {
        const v = make(THREE());
        v.open('uploads/a.pdf');
        assert.strictEqual(v.label(), 'Also stop the 2 other files being indexed');
        // c.pdf finishes
        v.s.state.messages = [...pass('a1', 'a.pdf', 'running'), ...pass('b1', 'b.pdf', 'queued'), ...pass('c1', 'c.pdf', 'done')];
        v.render();
        assert.strictEqual(v.label(), 'Also stop the other file being indexed');
        // and a new upload starts
        v.s.state.messages = v.s.state.messages.concat(pass('f1', 'f.pdf', 'queued'), pass('g1', 'g.pdf', 'queued'));
        v.render();
        assert.strictEqual(v.label(), 'Also stop the 3 other files being indexed');
    });

    t('a file that started AFTER the dialog opened is stopped too', async () => {
        const v = make(THREE());
        v.open('uploads/a.pdf');
        v.tick();
        v.s.state.messages = v.s.state.messages.concat(pass('f1', 'f.pdf', 'queued'));
        v.render();
        v.confirm();
        assert.deepStrictEqual(v.cancels, ['a1', 'b1', 'c1', 'f1']);
    });

    t('when the other files finish, the checkbox goes and a tick stops nothing extra', async () => {
        const v = make(THREE());
        v.open('uploads/a.pdf');
        v.tick();
        v.s.state.messages = [...pass('a1', 'a.pdf', 'running'), ...pass('b1', 'b.pdf', 'done'), ...pass('c1', 'c.pdf', 'done')];
        v.render();
        assert.strictEqual(v.isOpen(), true);
        assert.strictEqual(v.shown(), false);
        v.confirm();
        assert.deepStrictEqual(v.cancels, ['a1']);
    });

    t('when the file the dialog is about finishes, the dialog closes and nothing is stopped', async () => {
        const v = make(THREE());
        v.open('uploads/a.pdf');
        v.tick();
        v.s.state.messages = [...pass('a1', 'a.pdf', 'done'), ...pass('b1', 'b.pdf', 'queued'), ...pass('c1', 'c.pdf', 'queued')];
        v.render();
        assert.strictEqual(v.isOpen(), false);
        assert.deepStrictEqual(v.cancels, []);
    });

    t('a second live run of the SAME file is not another file', async () => {
        // a.pdf was reindexed while its first run still had a pass queued.
        const v = make([...pass('a1', 'a.pdf', 'done'), ...pass('a2', 'a.pdf', 'queued'), ...pass('b1', 'b.pdf', 'queued')]);
        const runs = groupsOf(v.s).filter((g) => g.key === 'uploads/a.pdf');
        v.open('uploads/a.pdf');
        assert.strictEqual(v.label(), 'Also stop the other file being indexed', runs.length + ' run(s) of a.pdf');
    });

    for (const [name, fn] of scenarios) await test(name, fn);
}

(async () => {

/* ---- 1. the engine: one stop per file, from one snapshot -------------------- */

await test('engine: stopping one file cancels its passes and leaves the others running', async () => {
    const { s, cancels } = makeSession(THREE());
    s.cancelIndexingGroup(groupsOf(s).find((g) => g.key === 'uploads/b.pdf'));
    await settle();
    assert.deepStrictEqual(cancels, ['b1']);
    assert.deepStrictEqual(groupsOf(s).filter(stoppable).map((g) => g.key), ['uploads/a.pdf', 'uploads/c.pdf']);
});

await test('engine: stopping every file from ONE snapshot cancels each pass exactly once', async () => {
    const { s, cancels } = makeSession([...THREE(), ...pass('a2', 'a.pdf', 'queued')]);
    // a.pdf has two live runs here (a second upload of it is queued behind the first),
    // so it is two rows of one file: three files, four passes.
    const snapshot = groupsOf(s).filter(stoppable);
    assert.strictEqual(new Set(snapshot.map((g) => g.key)).size, 3);
    snapshot.forEach((g) => s.cancelIndexingGroup(g));
    await settle();
    assert.deepStrictEqual(cancels.slice().sort(), ['a1', 'a2', 'b1', 'c1']);
    assert.deepStrictEqual(groupsOf(s).filter(stoppable), []);
});

await test('engine: the order the files are stopped in does not matter', async () => {
    const { s, cancels } = makeSession([...THREE(), ...pass('a2', 'a.pdf', 'queued')]);
    groupsOf(s).filter(stoppable).reverse().forEach((g) => s.cancelIndexingGroup(g));
    await settle();
    assert.deepStrictEqual(cancels.slice().sort(), ['a1', 'a2', 'b1', 'c1']);
});

await test('engine: stopping the same file twice in a row cancels nothing twice', async () => {
    const { s, cancels } = makeSession(THREE());
    const g = groupsOf(s).find((x) => x.key === 'uploads/a.pdf');
    s.cancelIndexingGroup(g);
    s.cancelIndexingGroup(g);
    await settle();
    assert.deepStrictEqual(cancels, ['a1']);
});

/* ---- 2 and 3. the two dialogs ---------------------------------------------- */

await dialogScenarios('widget', makeWidget);
if (makeAgent) await dialogScenarios('agent.vue', makeAgent);
else results.push([true, "agent.vue's dialog behaves identically (SKIPPED: " + agentSkip + ')']);

/* ---- the two clients say the same thing ------------------------------------ */

if (fs.existsSync(AGENT)) {
    await test('both clients use the same wording and the same checkbox markup', () => {
        const agent = fs.readFileSync(AGENT, 'utf8');
        for (const text of ['Also stop the other file being indexed', ' other files being indexed']) {
            assert.ok(WIDGET_SRC.includes(text), 'widget lacks: ' + text);
            assert.ok(agent.includes(text), 'agent.vue lacks: ' + text);
        }
        assert.ok(/label\.bq-overwrite-applyall\(v-if="stopIndexOtherCount"\)\n\s+input\(type="checkbox" v-model="stopIndexAlsoOthers"\)\n\s+span \{\{ stopIndexOthersLabel \}\}/.test(agent),
            "agent.vue's Stop dialog must carry the checkbox");
        assert.ok(WIDGET_BLOCK.includes('h("label", { class: "bq-overwrite-applyall" }, othersBox, othersText)'), "the widget's Stop dialog must carry the checkbox");
    });
}

let failed = 0;
for (const r of results) {
    if (r[0]) console.log('ok    ' + r[1]);
    else { failed++; console.log('FAIL  ' + r[1] + '\n      ' + r[2]); }
}
console.log((results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);

})();
