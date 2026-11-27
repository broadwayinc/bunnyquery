/**
 * The progress line under a waiting chat turn: "Searching your files for "oil leak"...".
 *
 * A turn takes about 20 s, and until its first word of answer arrives the bubble
 * used to show nothing but a dot trail. The stream already says what the model is
 * doing (which tool, with what input, whether it answered), so this turns that into
 * one sentence. Both clients render the sentence and nothing else, so they cannot
 * describe the same moment differently.
 *
 * HOW THE SENTENCE IS PICKED
 *   - The step comes from the latest stream snapshot (noteChatActivity, called by
 *     the session on every live paint): thinking (no tool yet), a tool running,
 *     between tools (the last one answered, the model is deciding), or writing.
 *   - Each step has a short list of sentences. The list advances every
 *     ROTATE_MS while the step lasts and loops after its end, so a slow search
 *     or a long first think reads as progress instead of a frozen label.
 *   - A turn with no stream yet (before the first chunk, or a client that does not
 *     stream) is "thinking", timed from when the bubble was first asked about.
 *
 * The trailing dots are NOT part of the sentence: each client draws its own
 * animated dot trail after it (.bq-loader), so they keep moving even when nothing
 * new arrives for a while.
 *
 * Render-only, DOM-free and framework-free like the rest of the engine. Nothing
 * here reads or writes chat state; the two maps below are display memory only and
 * forget entries on their own.
 */

import type { SseSnapshot, SseToolCall } from './sse';

/** How long one sentence stays before the next one in its list. */
export const CHAT_ACTIVITY_ROTATE_MS = 4000;

export type ChatActivityStep = 'thinking' | 'tool' | 'between' | 'writing';

export interface ChatActivity {
	step: ChatActivityStep;
	/** The running tool's name ('tool' step only). */
	tool?: string;
	/** The running tool's input, parsed, when it has arrived ('tool' step only). */
	input?: any;
	/** Wall-clock ms when this step began. */
	since: number;
	/** Identifies the step, so a repeat snapshot of the same step keeps `since`. */
	key: string;
}

type Lang = 'en' | 'ko';

/** Latest activity per server item id, written by the session's live paint. */
var byItem = new Map<string, ChatActivity>();
/** When each waiting bubble was first seen, by object and by its ids. */
var startByObj = new WeakMap<object, number>();
var startById = new Map<string, number>();
var MAX_IDS = 200;

function remember(map: Map<string, any>, key: string, value: any): void {
	if (map.has(key)) map.delete(key);
	map.set(key, value);
	if (map.size > MAX_IDS) {
		var oldest = map.keys().next();
		if (!oldest.done) map.delete(oldest.value);
	}
}

function stepOf(snap: SseSnapshot | null | undefined): { step: ChatActivityStep; call?: SseToolCall; count: number } {
	if (!snap) return { step: 'thinking', count: 0 };
	var calls = Array.isArray(snap.toolCalls) ? snap.toolCalls : [];
	if (typeof snap.text === 'string' && /\S/.test(snap.text)) return { step: 'writing', count: calls.length };
	if (!calls.length) return { step: 'thinking', count: 0 };
	var last = calls[calls.length - 1];
	if (last && !last.done) return { step: 'tool', call: last, count: calls.length };
	return { step: 'between', count: calls.length };
}

/**
 * Record what a streaming turn is doing now. Called by the session with every
 * snapshot it paints; cheap, and a repeat of the same step keeps its start time
 * (only a newly arrived input is taken).
 */
export function noteChatActivity(serverItemId: string, snap: SseSnapshot | null | undefined, now?: number): void {
	if (!serverItemId) return;
	var t = typeof now === 'number' ? now : Date.now();
	var s = stepOf(snap);
	var key = s.step + ':' + s.count;
	var prev = byItem.get(serverItemId);
	if (prev && prev.key === key) {
		if (s.call && s.call.input !== undefined && prev.input === undefined) prev.input = s.call.input;
		return;
	}
	var act: ChatActivity = { step: s.step, since: t, key: key };
	if (s.call) {
		act.tool = s.call.name;
		if (s.call.input !== undefined) act.input = s.call.input;
	}
	remember(byItem, serverItemId, act);
}

/** The recorded activity for a bubble, by its server item id. */
export function chatActivityOf(msg: any): ChatActivity | null {
	var id = msg && typeof msg._serverItemId === 'string' ? msg._serverItemId : '';
	return (id && byItem.get(id)) || null;
}

/** When this waiting bubble was first seen. Survives the bubble gaining its server
 *  id (same object) and a history refetch replacing the object (same id). */
function turnStart(msg: any, now: number): number {
	var ids: string[] = [];
	if (msg && typeof msg._serverItemId === 'string' && msg._serverItemId) ids.push(msg._serverItemId);
	if (msg && typeof msg._localId === 'string' && msg._localId) ids.push(msg._localId);
	var t: number | undefined;
	if (msg && typeof msg === 'object') t = startByObj.get(msg);
	for (var i = 0; t === undefined && i < ids.length; i++) t = startById.get(ids[i]);
	if (t === undefined) t = now;
	if (msg && typeof msg === 'object') startByObj.set(msg, t);
	for (var j = 0; j < ids.length; j++) if (startById.get(ids[j]) !== t) remember(startById, ids[j], t);
	return t;
}

/* ── wording ─────────────────────────────────────────────────────────────── */

function langOf(lang?: string): Lang {
	return typeof lang === 'string' && /^ko\b/i.test(lang) ? 'ko' : 'en';
}

function clip(v: any, max: number): string {
	if (typeof v !== 'string') return '';
	var s = v.replace(/\s+/g, ' ').trim();
	if (s.length > max) s = s.slice(0, max - 1).trim() + '…';
	return s;
}

/** A file's own name out of a stored path: "src::manuals/BP-252.pdf" -> "BP-252.pdf". */
function fileName(v: any): string {
	if (typeof v !== 'string' || !v) return '';
	var s = v.replace(/^(src::|db:)/, '');
	var parts = s.split('/').filter(function (p) { return !!p; });
	return clip(parts.length ? parts[parts.length - 1] : s, 40);
}

var T = {
	en: {
		thinking: ['Reading your question', 'Thinking about where to look', 'Planning the search', 'Still thinking, this can take a moment', 'Working out the best way to find it', 'Getting ready to look through your data'],
		between: ['Looking at what it found', 'Deciding what to check next', 'Putting the pieces together', 'Checking that it has what it needs', 'Still working on it'],
		writing: ['Writing the answer'],
		still: 'Still working on it',
		working: 'Working',
	},
	ko: {
		thinking: ['질문을 읽는 중', '어디를 찾아볼지 생각하는 중', '검색 방법을 정하는 중', '아직 생각하는 중, 잠시만 기다려 주세요', '가장 좋은 방법을 찾는 중', '데이터를 살펴볼 준비를 하는 중'],
		between: ['찾은 내용을 살펴보는 중', '다음에 확인할 것을 정하는 중', '내용을 정리하는 중', '필요한 내용이 다 있는지 확인하는 중', '아직 작업 중'],
		writing: ['답변을 작성하는 중'],
		still: '아직 작업 중',
		working: '작업 중',
	},
};

/** The sentence list for one tool. `i` is the call's parsed input (may be empty). */
function toolLines(tool: string, i: any, lang: Lang): string[] {
	var ko = lang === 'ko';
	var inp = i && typeof i === 'object' ? i : {};
	var q = clip(inp.query || inp.question, 40);
	var f = fileName(inp.path);
	var tbl = clip(inp.table_name, 30);
	switch (tool) {
		case 'searchText':
			return ko ? [
				q ? (f ? f + '에서 "' + q + '" 찾는 중' : '파일에서 "' + q + '" 찾는 중') : '파일에서 찾는 중',
				'모든 페이지를 확인하는 중',
				'아직 찾는 중, 큰 프로젝트는 조금 더 걸려요',
				'계속 찾는 중, 기다려 주셔서 감사해요',
			] : [
				q ? (f ? 'Searching ' + f + ' for "' + q + '"' : 'Searching your files for "' + q + '"') : 'Searching your files',
				'Checking every page',
				'Still searching, big projects take a bit longer',
				'Still searching, thanks for waiting',
			];
		case 'readFileContent':
			return ko ? [
				f ? f + ' 읽는 중' : '파일을 읽는 중',
				'페이지를 살펴보는 중',
				'아직 읽는 중, 긴 파일은 조금 더 걸려요',
			] : [
				f ? 'Reading ' + f : 'Reading a file',
				'Going through the pages',
				'Still reading, long files take a bit longer',
			];
		case 'getFileOutline':
			return ko ? [f ? f + ' 구성을 살펴보는 중' : '파일 구성을 살펴보는 중', '목차를 확인하는 중', T.ko.still]
				: [f ? 'Looking at how ' + f + ' is laid out' : 'Looking at how the file is laid out', 'Checking the table of contents', T.en.still];
		case 'getRecords':
			return ko ? [
				tbl ? tbl + ' 테이블에서 기록을 찾는 중' : '기록을 찾는 중',
				'행을 살펴보는 중',
				'아직 찾는 중, 큰 테이블은 조금 더 걸려요',
			] : [
				tbl ? 'Looking up records in ' + tbl : 'Looking up records',
				'Going through the rows',
				'Still looking, big tables take a bit longer',
			];
		case 'exportRecordsToFile':
			return ko ? [tbl ? tbl + ' 기록을 파일로 만드는 중' : '기록을 파일로 만드는 중', '파일을 만드는 중', '아직 만드는 중, 큰 테이블은 조금 더 걸려요']
				: [tbl ? 'Exporting records from ' + tbl : 'Exporting records', 'Building the file', 'Still exporting, big tables take a bit longer'];
		case 'writeReport':
			return ko ? ['보고서를 작성하는 중', '아직 작성하는 중, 긴 보고서는 조금 더 걸려요']
				: ['Writing the report', 'Still writing, long reports take a bit longer'];
		case 'getTables': return ko ? ['어떤 테이블이 있는지 확인하는 중', T.ko.still] : ['Checking which tables there are', T.en.still];
		case 'getTags': return ko ? ['태그를 확인하는 중', T.ko.still] : ['Checking tags', T.en.still];
		case 'getIndexes': return ko ? ['테이블 항목을 확인하는 중', T.ko.still] : ["Checking the table's fields", T.en.still];
		case 'getUniqueId': return ko ? ['레코드 ID를 확인하는 중', T.ko.still] : ['Checking record IDs', T.en.still];
		case 'postRecords': return ko ? ['기록을 저장하는 중', T.ko.still] : ['Saving records', T.en.still];
		case 'updateRecords': return ko ? ['기록을 수정하는 중', T.ko.still] : ['Updating records', T.en.still];
		case 'deleteRecords': return ko ? ['기록을 삭제하는 중', T.ko.still] : ['Deleting records', T.en.still];
		case 'getTemporaryUrl': return ko ? [f ? f + ' 링크를 만드는 중' : '링크를 만드는 중', T.ko.still] : [f ? 'Getting a link to ' + f : 'Getting a link', T.en.still];
		case 'getToolResponsePage': return ko ? ['결과의 다음 부분을 읽는 중', T.ko.still] : ['Reading the next part of the results', T.en.still];
		case 'correctSearchLink': return ko ? ['페이지 링크를 확인하는 중', T.ko.still] : ['Checking the page link', T.en.still];
		case 'getProjectInfos': return ko ? ['프로젝트 정보를 확인하는 중', T.ko.still] : ['Checking the project details', T.en.still];
		case 'getProfile': return ko ? ['계정 정보를 확인하는 중', T.ko.still] : ['Checking your account', T.en.still];
		case 'web_search':
		case 'web_search_call':
			return ko ? ['웹에서 찾는 중', T.ko.still] : ['Searching the web', T.en.still];
		default:
			return ko ? [T.ko.working, T.ko.still] : [T.en.working, T.en.still];
	}
}

/** The sentence for `elapsed` ms into a step. Past the end of the list it loops,
 *  from `loopFrom` on, so a long step keeps changing instead of freezing on its
 *  last sentence (the thinking list skips "Reading your question" on the loop). */
function pick(lines: string[], elapsed: number, loopFrom?: number): string {
	var n = Math.floor(Math.max(0, elapsed) / CHAT_ACTIVITY_ROTATE_MS);
	if (n < lines.length) return lines[n];
	var from = Math.min(Math.max(0, loopFrom || 0), lines.length - 1);
	var span = lines.length - from;
	return lines[from + ((n - lines.length) % span)];
}

/**
 * The sentence for a waiting assistant bubble right now, WITHOUT trailing dots.
 * Call it again about once a second to rotate; `lang` is a BCP 47 tag such as
 * navigator.language ("ko-KR" picks Korean, anything else English).
 */
export function chatActivityLine(msg: any, now?: number, lang?: string): string {
	var t = typeof now === 'number' ? now : Date.now();
	var L = langOf(lang);
	var start = turnStart(msg, t);
	var act = chatActivityOf(msg);
	if (!act || act.step === 'thinking') return pick(T[L].thinking, t - start, 1);
	var elapsed = t - act.since;
	if (act.step === 'writing') return pick(T[L].writing, elapsed);
	if (act.step === 'between') return pick(T[L].between, elapsed);
	return pick(toolLines(act.tool || '', act.input, L), elapsed);
}
