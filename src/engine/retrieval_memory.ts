/**
 * Retrieval memory: a compact note of what a chat turn RETRIEVED, kept with the
 * turn so a follow-up question skips discovery.
 *
 * THE PROBLEM. The provider runs the tool loop on its side and history keeps
 * only the answer text (budget.ts), so on "and what does page 3 say?" the model
 * starts from nothing: it looks the file up again, guesses a table and an access
 * group again, and routinely lands somewhere else, which is how an answer flips
 * between two turns about the same document.
 *
 * WHAT THE ENGINE CAN SEE. The provider's final body carries the tool loop:
 *   - Anthropic Messages: content[] blocks `mcp_tool_use` (name, input) and
 *     `mcp_tool_result` (content), plus `server_tool_use` / `web_*_tool_result`
 *     for the built-in web tools;
 *   - OpenAI Responses: output[] items `mcp_call` (name, arguments as a JSON
 *     string, output as a string) and `web_search_call`.
 * The polling worker stores that body on the row (spilling to S3 past 300 KB,
 * never truncating), and a streamed turn's assembled body keeps the same blocks
 * (sse.ts copies each block's skeleton and its JSON input verbatim), so the
 * same reader works live, after a stream and after a reload. When a body has no
 * tool blocks at all (a host that strips them, a provider shape this does not
 * know), the note falls back to what the ANSWER names: db: file links and src::
 * paths. Nothing is ever invented: an empty note is null, not a guess.
 *
 * WHAT IS KEPT, per turn: files (storage paths), tables, access groups,
 * searchText hits as path + page, the tool names, and whether a web tool ran.
 * Arguments are read by KEY, never by position, and only the keys the
 * BunnyQuery tools use for those four things; a query's filter values, a
 * record's data and a tool result's text are never copied, so the note cannot
 * leak a page of a document into every later turn.
 *
 * HOW IT REACHES THE MODEL. buildBoundedChatMessages appends the formatted note
 * to the LLM copy of the assistant turn it belongs to (never the displayed
 * bubble), for the newest RETRIEVAL_NOTES_MAX turns and within
 * RETRIEVAL_NOTES_TOKEN_BUDGET tokens, so the memory is bounded however long
 * the chat gets. A host that never attaches `_retrieval` sees byte-identical
 * requests to today.
 */

export type RetrievalHit = { path: string; page: number };

export type RetrievalNote = {
	/** Storage paths (the part after "src::") the turn read, queried or linked. */
	files: string[];
	/** Table names the turn queried. */
	tables: string[];
	/** Access groups the turn queried at, as written in the call. */
	accessGroups: string[];
	/** searchText hits: the page a term was found on, per file. */
	hits: RetrievalHit[];
	/** Tool names, in order of first use. */
	tools: string[];
	/** A web tool ran in this turn (web_search / web_fetch). */
	web: boolean;
	/** 'tools' when read off the body's tool blocks; 'answer' when only the
	 *  answer text was available to read. */
	source: 'tools' | 'answer' | 'body';
};

/** How many of the newest turns carry their note into the request. */
export const RETRIEVAL_NOTES_MAX = 6;
/** Ceiling on the estimated tokens all carried notes may add to one request. */
export const RETRIEVAL_NOTES_TOKEN_BUDGET = 1200;
/** Per-list cap inside one note (files, tables, groups, hits, tools). */
export const RETRIEVAL_NOTE_MAX_ITEMS = 8;
/** Hard cap on one formatted note. */
export const RETRIEVAL_NOTE_MAX_CHARS = 600;
/** The marker a carried note opens with; also what keeps it out of the model's own voice. */
export const RETRIEVAL_NOTE_PREFIX = '[Retrieval note, not shown to the user';

// Argument keys the BunnyQuery tools spell a file, a table and a group with.
// Read by key only: a value under any other key is not looked at.
const FILE_KEYS = ['path', 'storage_path', 'storagePath', 'file', 'file_path', 'filePath'];
const TABLE_KEYS = ['table_name', 'tableName'];
const GROUP_KEYS = ['access_group', 'accessGroup'];
const SRC_PREFIX = 'src::';
// Bounded walk over a tool RESULT looking for { path, page } hits. The caps keep a
// 60,000-character page listing from being walked node by node.
const RESULT_WALK_MAX_NODES = 400;
const RESULT_WALK_MAX_DEPTH = 5;

function isWebToolName(name: string | undefined): boolean {
	return typeof name === 'string' && /^web_(search|fetch)/.test(name);
}

function pushUnique(list: string[], value: unknown): void {
	if (typeof value !== 'string') return;
	var v = value.trim();
	if (!v || list.indexOf(v) !== -1 || list.length >= RETRIEVAL_NOTE_MAX_ITEMS) return;
	list.push(v);
}

function pushGroup(list: string[], value: unknown): void {
	if (typeof value === 'number' && isFinite(value)) pushUnique(list, String(value));
	else pushUnique(list, value);
}

function pushHit(list: RetrievalHit[], path: unknown, page: unknown): void {
	if (typeof path !== 'string' || !path.trim()) return;
	var n = typeof page === 'number' ? page : Number(page);
	if (!isFinite(n) || n <= 0) return;
	n = Math.floor(n);
	for (var i = 0; i < list.length; i++) {
		if (list[i].path === path && list[i].page === n) return;
	}
	if (list.length >= RETRIEVAL_NOTE_MAX_ITEMS) return;
	list.push({ path: path.trim(), page: n });
}

/** A storage path out of a src:: id, or null when the value is not one. */
function pathFromSrcId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (value.indexOf(SRC_PREFIX) !== 0) return null;
	var rest = value.slice(SRC_PREFIX.length).trim();
	return rest ? rest : null;
}

function parseJsonLoose(value: unknown): any {
	if (typeof value !== 'string') return value;
	var t = value.trim();
	if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
	try { return JSON.parse(t); } catch (e) { return null; }
}

/** Read what a tool CALL names: its file, table and access group arguments. */
function readArguments(note: RetrievalNote, args: any): void {
	if (!args || typeof args !== 'object') return;
	var i: number;
	for (i = 0; i < FILE_KEYS.length; i++) pushUnique(note.files, args[FILE_KEYS[i]]);
	for (i = 0; i < TABLE_KEYS.length; i++) pushUnique(note.tables, args[TABLE_KEYS[i]]);
	for (i = 0; i < GROUP_KEYS.length; i++) pushGroup(note.accessGroups, args[GROUP_KEYS[i]]);
	// `table` is either a name or { name, access_group }.
	if (typeof args.table === 'string') pushUnique(note.tables, args.table);
	else if (args.table && typeof args.table === 'object') {
		pushUnique(note.tables, args.table.name);
		pushGroup(note.accessGroups, args.table.access_group);
	}
	// A reference or unique_id of the form src::<path> names a file. A bare
	// "src::" (the file-listing prefix query) names none.
	var ref = pathFromSrcId(args.reference);
	if (ref) pushUnique(note.files, ref);
	var uid = pathFromSrcId(args.unique_id);
	if (uid) pushUnique(note.files, uid);
}

/** Collect { path, page } pairs out of a tool RESULT, bounded. */
function readHits(note: RetrievalNote, result: any): void {
	var parsed = parseJsonLoose(result);
	if (!parsed || typeof parsed !== 'object') return;
	var visited = 0;
	var walk = function (node: any, depth: number): void {
		if (!node || typeof node !== 'object' || depth > RESULT_WALK_MAX_DEPTH) return;
		if (++visited > RESULT_WALK_MAX_NODES) return;
		if (Array.isArray(node)) {
			for (var i = 0; i < node.length && visited <= RESULT_WALK_MAX_NODES; i++) walk(node[i], depth + 1);
			return;
		}
		if (typeof node.path === 'string' && node.page !== undefined) {
			pushHit(note.hits, node.path, node.page);
		}
		for (var k in node) {
			if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
			var v = node[k];
			if (v && typeof v === 'object') walk(v, depth + 1);
		}
	};
	walk(parsed, 0);
}

/** The text of an Anthropic tool result block's content. */
function claudeResultText(block: any): string {
	var c = block && block.content;
	if (typeof c === 'string') return c;
	if (Array.isArray(c)) {
		return c.map(function (part: any) { return part && typeof part.text === 'string' ? part.text : ''; }).join('\n');
	}
	return '';
}

function emptyNote(source: 'tools' | 'answer' | 'body'): RetrievalNote {
	return { files: [], tables: [], accessGroups: [], hits: [], tools: [], web: false, source: source };
}

function noteHasContent(note: RetrievalNote): boolean {
	return note.files.length > 0 || note.tables.length > 0 || note.accessGroups.length > 0
		|| note.hits.length > 0 || note.tools.length > 0 || note.web;
}

/**
 * Read the tool loop off a provider body. Returns a note with `source: 'tools'`
 * when the body carried tool blocks (even failed ones), or null when it carried
 * none, so the caller can fall back to the answer text.
 */
function noteFromToolBlocks(body: any): RetrievalNote | null {
	if (!body || typeof body !== 'object') return null;
	var note = emptyNote('tools');
	var sawTool = false;
	var i: number;

	// Anthropic Messages: content[] blocks.
	var content = body.content;
	if (Array.isArray(content)) {
		// Pair each result with its call by tool_use_id so a searchText RESULT is
		// read for hits only when it answered a searchText CALL.
		var callNames: Record<string, string> = {};
		for (i = 0; i < content.length; i++) {
			var block = content[i];
			if (!block || typeof block !== 'object') continue;
			var type = block.type;
			if (type === 'mcp_tool_use' || type === 'tool_use') {
				sawTool = true;
				pushUnique(note.tools, block.name);
				if (typeof block.id === 'string' && typeof block.name === 'string') callNames[block.id] = block.name;
				readArguments(note, block.input);
			} else if (type === 'server_tool_use' || type === 'web_search_tool_use') {
				sawTool = true;
				if (isWebToolName(block.name) || type === 'web_search_tool_use') note.web = true;
				pushUnique(note.tools, block.name || type);
			} else if (type === 'mcp_tool_result' || type === 'tool_result') {
				sawTool = true;
				var name = typeof block.tool_use_id === 'string' ? callNames[block.tool_use_id] : undefined;
				if (!block.is_error && (name === undefined || name === 'searchText')) readHits(note, claudeResultText(block));
			} else if (type === 'web_search_tool_result' || type === 'web_fetch_tool_result') {
				sawTool = true;
				note.web = true;
			}
		}
	}

	// OpenAI Responses: output[] items.
	var output = body.output;
	if (Array.isArray(output)) {
		for (i = 0; i < output.length; i++) {
			var item = output[i];
			if (!item || typeof item !== 'object') continue;
			var kind = typeof item.type === 'string' ? item.type : '';
			if (kind === 'mcp_call' || kind === 'function_call') {
				sawTool = true;
				pushUnique(note.tools, item.name);
				readArguments(note, parseJsonLoose(item.arguments) || item.arguments);
				if (!item.error && item.name === 'searchText') readHits(note, item.output);
			} else if (kind.indexOf('web_search') === 0 || kind.indexOf('web_fetch') === 0) {
				sawTool = true;
				note.web = true;
				pushUnique(note.tools, kind);
			}
		}
	}

	return sawTool ? note : null;
}

/**
 * What an ANSWER names: db: file links ("[name](db:path)") and src:: ids. The
 * fallback for a body with no tool blocks, and merged into a tool note too so a
 * file the model linked but never queried (it knew the path from history) is
 * still remembered.
 */
export function retrievalNoteFromText(text: string | null | undefined): RetrievalNote | null {
	if (typeof text !== 'string' || !text) return null;
	var note = emptyNote('answer');
	// [label](db:path) and [label](db:path "title"); the path ends at the closing
	// paren or at the title's opening quote. Bounded character class, no nested
	// quantifiers, so a long answer cannot make this slow.
	var link = /\]\(db:([^)\s"]+)/g;
	var m: RegExpExecArray | null;
	while ((m = link.exec(text)) !== null) pushUnique(note.files, m[1]);
	var src = /src::([^\s"'`<>)\]]+)/g;
	while ((m = src.exec(text)) !== null) {
		// Trailing sentence punctuation is prose, not path.
		pushUnique(note.files, m[1].replace(/[.,;:!?]+$/, ''));
	}
	return noteHasContent(note) ? note : null;
}

/**
 * The note for one assistant turn: the body's tool loop when it has one, else
 * what the answer names, else null. `answerText` is the extracted answer, read
 * for file links in both cases.
 */
export function extractRetrievalNote(body: any, answerText?: string | null): RetrievalNote | null {
	var fromTools = noteFromToolBlocks(body);
	var fromText = retrievalNoteFromText(answerText);
	if (!fromTools) {
		if (fromText) return fromText;
		// A provider body that was read and holds NO tool use at all is a fact worth
		// keeping, not an absence: it is exactly the turn the "no project data was
		// read" mark exists for (citations.ts answerUsedNoDataTool). An empty note
		// formats to '' (formatRetrievalNote), so it costs the history nothing. A body
		// that is not a provider body (null, a bare status row) still yields null:
		// nothing was read, so nothing is claimed.
		return providerBodyWasRead(body) ? emptyNote('body') : null;
	}
	if (fromText) {
		for (var i = 0; i < fromText.files.length; i++) pushUnique(fromTools.files, fromText.files[i]);
	}
	return noteHasContent(fromTools) ? fromTools : emptyNote('body');
}

/**
 * True when `body` is a provider response this module can read: an Anthropic
 * Messages body (`content` array) or an OpenAI Responses body (`output` array).
 */
export function providerBodyWasRead(body: any): boolean {
	if (!body || typeof body !== 'object') return false;
	return Array.isArray(body.content) || Array.isArray(body.output);
}

/** True when the value is a note this module produced (or an equivalent shape). */
export function isRetrievalNote(value: any): value is RetrievalNote {
	return !!value && typeof value === 'object'
		&& Array.isArray(value.files) && Array.isArray(value.tables)
		&& Array.isArray(value.accessGroups) && Array.isArray(value.hits)
		&& Array.isArray(value.tools);
}

/**
 * One line the model reads. Sections are omitted when empty, the whole thing is
 * capped at RETRIEVAL_NOTE_MAX_CHARS, and it opens with RETRIEVAL_NOTE_PREFIX so
 * the model can tell it from its own earlier words. Returns '' for an empty note.
 */
export function formatRetrievalNote(note: RetrievalNote | null | undefined): string {
	if (!note || !noteHasContent(note)) return '';
	var parts: string[] = [];
	if (note.files.length) parts.push('files ' + note.files.join(', '));
	if (note.tables.length) parts.push('tables ' + note.tables.join(', '));
	if (note.accessGroups.length) parts.push('access_group ' + note.accessGroups.join(', '));
	if (note.hits.length) {
		// Grouped per file: "report.pdf p3, p7".
		var byFile: Record<string, number[]> = {};
		var order: string[] = [];
		for (var i = 0; i < note.hits.length; i++) {
			var h = note.hits[i];
			if (!byFile[h.path]) { byFile[h.path] = []; order.push(h.path); }
			byFile[h.path].push(h.page);
		}
		parts.push('searchText hits ' + order.map(function (p) {
			return p + ' p' + byFile[p].join(', p');
		}).join('; '));
	}
	if (note.tools.length) parts.push('tools ' + note.tools.join(', '));
	if (note.web) parts.push('web tool used');
	var line = RETRIEVAL_NOTE_PREFIX + ': this turn used ' + parts.join(' | ') + ']';
	if (line.length > RETRIEVAL_NOTE_MAX_CHARS) {
		line = line.slice(0, RETRIEVAL_NOTE_MAX_CHARS - 4) + '...]';
	}
	return line;
}
