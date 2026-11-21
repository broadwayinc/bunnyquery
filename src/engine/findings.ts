/**
 * Saved search findings (owner, 2026-11-20): where a hard search found its answer, kept in
 * the project's database so the same question, from anyone, later goes straight to the page.
 *
 * WHAT IS SAVED: the LOCATION, never the answer. One record per file page in table
 * "search_findings", unique_id "find::<path>#p<page>", reference "src::<path>" (so a
 * re-index or a delete of the file removes its findings through the cascade), the file's own
 * access group (a finding is never visible to someone who cannot read the file), and tags:
 * the key words of the question and the search terms that found the page, normalized the way
 * every BunnyQuery tag is (tagForms). The chat reads the page again before answering, so a
 * finding can never replay an outdated answer; it only skips the hunt.
 *
 * WHEN: after a chat turn that needed a real search (FINDING_MIN_TOOL_CALLS or more tool
 * calls) and whose answer links a file that a searchText hit found on a page, or, when the
 * turn read the file with readFileContent instead, the pages its answer cites of that file. Read from the
 * provider body the turn already has, by the engine, so it costs no model step. Nothing is
 * invented: no hit on a linked file, no finding. No page text and no result text is copied.
 *
 * The engine never writes records itself: the host's saveSearchFinding hook does (config.ts).
 */
import type { RetrievalNote } from './retrieval_memory';

export const FINDINGS_TABLE = 'search_findings';
export const FINDING_ID_PREFIX = 'find::';
/** Fewer tool calls than this was not a hard search: nothing is saved. */
export const FINDING_MIN_TOOL_CALLS = 3;
/** Findings saved from one turn at most. */
export const FINDING_MAX_PER_TURN = 3;
/** Key words taken from the question / from the search terms, each. */
export const FINDING_MAX_WORDS = 8;
/** Tags one finding record keeps when later finds add theirs. */
export const FINDING_MAX_TAGS = 40;

// Filler a question is phrased with, which says nothing about where the answer is.
const STOP_WORDS = new Set([
	'the', 'a', 'an', 'is', 'are', 'was', 'what', 'whats', 'which', 'who', 'where', 'when', 'how', 'why',
	'please', 'tell', 'me', 'show', 'give', 'find', 'can', 'you', 'could', 'would', 'of', 'for', 'to', 'in',
	'on', 'at', 'and', 'or', 'about', 'i', 'my', 'our', 'do', 'does', 'did',
	'좀', '알려줘', '알려주세요', '알려', '줘', '주세요', '뭐야', '뭐예요', '뭔가요', '무엇', '무엇인가요', '어떻게',
	'해줘', '해주세요', '있어', '있나요', '있어요', '어디', '어디야', '말해줘', '찾아줘', '보여줘',
]);

// Same rules as the MCP's bq-indexing-shape.js, so a finding's tags match what the chat
// searches: NFKC, lowercase, no spaces or punctuation, plus each word of 2+ characters.
const WORD_SPLIT = /[\s\-_/,;|+&]+/u;
const NOT_KEPT = /[\s\p{P}\p{S}]+/gu;

function nfkcLower(text: string): string {
	var s = String(text == null ? '' : text);
	try { s = s.normalize('NFKC'); } catch (e) { /* as is */ }
	return s.toLowerCase();
}

export function normalizeTagText(text: string): string {
	return nfkcLower(text).replace(NOT_KEPT, '');
}

/** One phrase -> its stored tags: the joined form plus each word when there are several. */
export function tagForms(text: string): string[] {
	if (typeof text !== 'string') return [];
	if (text.indexOf('::') !== -1) return [text];
	var joined = normalizeTagText(text);
	if (!joined) return [];
	var words = nfkcLower(text).split(WORD_SPLIT)
		.map(function (w) { return w.replace(NOT_KEPT, ''); })
		.filter(function (w) { return Array.from(w).length >= 2; });
	var out = [joined];
	if (words.length > 1) for (var i = 0; i < words.length; i++) if (words[i] !== joined) out.push(words[i]);
	return out;
}

// Korean endings and particles glued to a word ("누유시" = 누유 + 시, "방법을", "조치방법좀"),
// longest first. A tag only matches whole, so a question saying "누유" missed a finding saved
// as "누유시" (owner, 2026-11-21): the bare word is kept as well.
const KO_ENDINGS = ['에서는', '으로는', '에서', '으로', '에게', '까지', '부터', '이나', '이랑', '하고', '처럼',
	'시', '좀', '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만', '랑', '나', '요'];

/** The word without one trailing Korean ending, or '' when nothing (or too little) would be left. */
export function koreanStem(word: string): string {
	if (!/[\uac00-\ud7a3]$/.test(word)) return '';
	for (var i = 0; i < KO_ENDINGS.length; i++) {
		var e = KO_ENDINGS[i];
		if (word.length > e.length && word.slice(-e.length) === e) {
			var stem = word.slice(0, -e.length);
			return Array.from(stem).length >= 2 ? stem : '';
		}
	}
	return '';
}

/** The words of a question or a search term that say WHAT is looked for. */
export function keyWords(text: string | null | undefined): string[] {
	if (typeof text !== 'string' || !text.trim()) return [];
	var out: string[] = [];
	var parts = nfkcLower(text).split(WORD_SPLIT);
	for (var i = 0; i < parts.length && out.length < FINDING_MAX_WORDS; i++) {
		var w = parts[i].replace(NOT_KEPT, '');
		if (Array.from(w).length < 2 || STOP_WORDS.has(w)) continue;
		var stem = koreanStem(w);
		// "조치방법좀": the filler on the end says nothing, so only the stem is kept.
		if (stem && STOP_WORDS.has(w.slice(stem.length))) w = stem, stem = '';
		if (out.indexOf(w) === -1) out.push(w);
		if (stem && out.indexOf(stem) === -1 && out.length < FINDING_MAX_WORDS) out.push(stem);
	}
	return out;
}

/** Page numbers an answer cites: "37쪽", "37 페이지", "page 37", "pages 37 and 53", "p. 53", "p53". */
export function citedPages(answer: string): number[] {
	var out: number[] = [];
	if (typeof answer !== 'string' || !answer) return out;
	var add = function (n: string) { var v = Number(n); if (Number.isInteger(v) && v > 0 && v < 100000 && out.indexOf(v) === -1) out.push(v); };
	var m: RegExpExecArray | null;
	// A LIST before the unit counts whole: "37·53쪽", "37, 53쪽", "37 및 53쪽", "37~40쪽".
	var after = /((?:\d{1,5}\s*(?:[·,/~\-–]|및|와|과)\s*)*\d{1,5})\s*(?:쪽|페이지|면)/g;
	while ((m = after.exec(answer))) {
		var nums = m[1].match(/\d{1,5}/g) || [];
		for (var a = 0; a < nums.length; a++) add(nums[a]);
	}
	// And after the word: "page 37", "pages 37 and 53", "pp. 37, 53, 60", "p. 53".
	var before = /\b(?:pages?|pp?\.?)\s*(\d{1,5}(?:\s*(?:,|and|&|-|–)\s*\d{1,5})*)/gi;
	while ((m = before.exec(answer))) {
		var list = m[1].match(/\d{1,5}/g) || [];
		for (var b = 0; b < list.length; b++) add(list[b]);
	}
	return out;
}

function parseJsonLoose(value: unknown): any {
	if (typeof value !== 'string') return value;
	try { return JSON.parse(value); } catch (e) { return null; }
}

/** How many MCP tool calls the turn made, the searchText queries it sent and the files it read with readFileContent. */
export function toolCallsOf(body: any): { calls: number; queries: string[]; readPaths: string[] } {
	var calls = 0;
	var queries: string[] = [];
	var readPaths: string[] = [];
	var add = function (name: any, args: any) {
		calls += 1;
		if (name === 'searchText' && args && typeof args.query === 'string' && args.query.trim()) queries.push(args.query.trim());
		if (name === 'readFileContent' && args && typeof args.path === 'string' && args.path.trim() && readPaths.indexOf(args.path.trim()) === -1) readPaths.push(args.path.trim());
	};
	if (body && Array.isArray(body.content)) {
		for (var i = 0; i < body.content.length; i++) {
			var b = body.content[i];
			if (b && (b.type === 'mcp_tool_use' || b.type === 'tool_use')) add(b.name, b.input);
		}
	}
	if (body && Array.isArray(body.output)) {
		for (var j = 0; j < body.output.length; j++) {
			var o = body.output[j];
			if (o && (o.type === 'mcp_call' || o.type === 'function_call')) add(o.name, parseJsonLoose(o.arguments) || o.arguments);
		}
	}
	return { calls: calls, queries: queries, readPaths: readPaths };
}

/** Did a getRecords on the findings table return at least one record in this turn? */
export function usedAFinding(body: any): boolean {
	var returned = function (out: any): boolean {
		var text = typeof out === 'string' ? out : (out == null ? '' : JSON.stringify(out));
		// The result (or the MCP's envelope around it, whose content is the result as a string)
		// names a record_id only when a record came back.
		return text.indexOf('record_id') !== -1;
	};
	var isFindingsQuery = function (name: any, a: any): boolean {
		return name === 'getRecords' && !!a && (a.table_name === FINDINGS_TABLE || a.table === FINDINGS_TABLE);
	};
	if (body && Array.isArray(body.output)) {
		for (var i = 0; i < body.output.length; i++) {
			var o = body.output[i];
			if (o && (o.type === 'mcp_call' || o.type === 'function_call')
				&& isFindingsQuery(o.name, parseJsonLoose(o.arguments) || o.arguments) && returned(o.output)) return true;
		}
	}
	if (body && Array.isArray(body.content)) {
		var ids: Record<string, true> = {};
		for (var j = 0; j < body.content.length; j++) {
			var b = body.content[j];
			if (b && (b.type === 'mcp_tool_use' || b.type === 'tool_use') && isFindingsQuery(b.name, b.input) && typeof b.id === 'string') ids[b.id] = true;
			else if (b && (b.type === 'mcp_tool_result' || b.type === 'tool_result') && ids[b.tool_use_id] && !b.is_error && returned(b.content)) return true;
		}
	}
	return false;
}

export type SearchFinding = {
	storagePath: string;
	page: number;
	uniqueId: string;
	tags: string[];
	data: {
		path: string;
		page: number;
		question_words: string[];
		search_terms: string[];
		found_at: number;
	};
};

/**
 * The findings one finished chat turn earns, or [] (see the file comment for the rules).
 * `note` is the turn's retrieval note (its searchText hits and the files its answer links).
 */
export function findingsForTurn(args: {
	question: string | null | undefined;
	body: any;
	note: RetrievalNote | null | undefined;
	answer: string | null | undefined;
	now?: number;
}): SearchFinding[] {
	var note = args.note;
	if (!note) return [];
	var tc = toolCallsOf(args.body);
	if (tc.calls < FINDING_MIN_TOOL_CALLS) return [];
	// A turn that answered from a saved finding is not a new one. Every turn LOOKS (the
	// prompt checks findings first), so only a lookup that RETURNED a finding counts.
	if (usedAFinding(args.body)) return [];
	var answer = typeof args.answer === 'string' ? args.answer : '';
	var linked = function (path: string): boolean {
		if (!answer) return false;
		if (answer.indexOf('db:' + path) !== -1) return true;
		var name = path.split('/').pop() || path;
		return answer.indexOf(name) !== -1;
	};
	var questionWords = keyWords(args.question);
	var searchWords: string[] = [];
	for (var q = 0; q < tc.queries.length; q++) {
		var ws = keyWords(tc.queries[q]);
		for (var k = 0; k < ws.length && searchWords.length < FINDING_MAX_WORDS; k++) {
			if (searchWords.indexOf(ws[k]) === -1) searchWords.push(ws[k]);
		}
	}
	if (!questionWords.length && !searchWords.length) return [];
	var tags: string[] = [];
	var addTags = function (list: string[]) {
		for (var i = 0; i < list.length; i++) {
			var forms = tagForms(list[i]);
			for (var f = 0; f < forms.length; f++) if (tags.indexOf(forms[f]) === -1 && tags.length < FINDING_MAX_TAGS) tags.push(forms[f]);
		}
	};
	addTags(questionWords);
	addTags(searchWords);
	// The pages the ANSWER cites ("37쪽", "page 37", "p. 53"): only those become findings.
	// An answer that names no page keeps only the best hit of a linked file.
	var cited = citedPages(answer);
	var out: SearchFinding[] = [];
	var seen: Record<string, true> = {};
	var make = function (path: string, page: number): SearchFinding {
		return {
			storagePath: path,
			page: page,
			uniqueId: FINDING_ID_PREFIX + path + '#p' + page,
			tags: tags.slice(),
			data: {
				path: path,
				page: page,
				question_words: questionWords,
				search_terms: searchWords,
				found_at: typeof args.now === 'number' ? args.now : Date.now(),
			},
		};
	};
	var hitsList = Array.isArray(note.hits) ? note.hits : [];
	for (var h = 0; h < hitsList.length && out.length < FINDING_MAX_PER_TURN; h++) {
		var hit = hitsList[h];
		if (!hit || typeof hit.path !== 'string' || !hit.path || typeof hit.page !== 'number') continue;
		if (!linked(hit.path)) continue;
		if (cited.length ? cited.indexOf(hit.page) === -1 : out.length > 0) continue;
		var id = FINDING_ID_PREFIX + hit.path + '#p' + hit.page;
		if (seen[id]) continue;
		seen[id] = true;
		out.push({
			storagePath: hit.path,
			page: hit.page,
			uniqueId: id,
			tags: tags.slice(),
			data: {
				path: hit.path,
				page: hit.page,
				question_words: questionWords,
				search_terms: searchWords,
				found_at: typeof args.now === 'number' ? args.now : Date.now(),
			},
		});
	}
	// A turn that READ the file (readFileContent) instead of searching it, e.g. a file whose
	// page text was not searchable (owner, 2026-11-21): the pages its answer cites of a file it
	// read and links are where the answer is. Only cited pages: a read covers a window of pages,
	// and without a page number there is no location to save.
	if (!out.length && cited.length) {
		for (var r = 0; r < tc.readPaths.length && out.length < FINDING_MAX_PER_TURN; r++) {
			var rp = tc.readPaths[r];
			if (!linked(rp)) continue;
			for (var c = 0; c < cited.length && out.length < FINDING_MAX_PER_TURN; c++) {
				var rid = FINDING_ID_PREFIX + rp + '#p' + cited[c];
				if (seen[rid]) continue;
				seen[rid] = true;
				out.push(make(rp, cited[c]));
			}
		}
	}
	return out;
}
