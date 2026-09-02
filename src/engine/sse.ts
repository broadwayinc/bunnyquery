/**
 * Streamed-turn parser: raw provider SSE bytes in, live answer text + the body a
 * buffered call would have returned out.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS HERE AND NOT IN SKAPI.
 * skapi's clientSecretRequest is a byte relay. On a streamed turn the worker reads
 * the destination's response incrementally and appends the raw bytes to a chunk
 * table; it settles the polling row with STATUS ONLY, no body, because the content
 * lives in the chunks. skapi therefore does not know that Anthropic or OpenAI
 * exist, has no dialect list, and parses nothing. BunnyQuery is the party that
 * knows which destination it dialled, so BunnyQuery is the party that parses, and
 * this module is the whole of that knowledge.
 *
 * WHAT ARRIVES. csr-poll hands back `chunks: [{seq, txt}]` (ascending, seq starts
 * at 1) plus `last_seq` to send back as the next `since`. A chunk is whatever the
 * worker's flush happened to contain: it flushes on a byte cap or a time interval,
 * so a chunk boundary lands wherever the socket broke, which is routinely in the
 * MIDDLE of an SSE frame. Half a frame is not data, so every partial is held in a
 * buffer until the rest arrives, and nothing is ever emitted from an incomplete
 * frame. That is what makes this a stateful object fed chunks rather than a
 * function over a whole transcript.
 *
 * REPLAY SAFETY. The parser is a pure function of the chunk SEQUENCE, so a reload
 * or a second tab that starts at seq 1 of a stream it did not initiate rebuilds
 * the identical state. Nothing here depends on having dispatched the request.
 *
 * THE TWO OUTPUTS, AND WHY BOTH ARE NEEDED.
 *   text        the assistant's answer ONLY, for rendering as it arrives. Not tool
 *               arguments, not thinking. Concatenating every delta into one string
 *               is how a half serialised tool call ends up in the middle of a
 *               user's sentence.
 *   finalBody() the assembled provider body, byte equivalent to the buffered
 *               response, so extractClaudeText / extractOpenAIText (requests.ts)
 *               produce the identical string whether the turn was read live or
 *               re-read from history later.
 *
 * THE BUG THIS IS SHAPED AROUND. extractClaudeText joins TEXT BLOCKS with '\n':
 *
 *     content.filter(b => b.type === 'text').map(b => b.text).join('\n')
 *
 * A server-tool turn has text at content index 0, the tool call at 1, its result
 * at 2, and text again at 3. Accumulate every text_delta into one string and those
 * two paragraphs fuse with no separator, so the answer the user watched arrive and
 * the same turn re-read from history are different strings. Blocks are therefore
 * keyed BY INDEX and never merged, and `text` is the join of the text blocks in
 * index order, which is exactly the extractor's rule and not an approximation of
 * it. See tests/sse-stream.cjs, "four separate blocks".
 *
 * NEVER THROWS FROM feed(). Chunks arrive on a poll tick, inside a timer the
 * consumer cannot reasonably wrap; a parse error there would take the whole poll
 * down over one malformed frame. Frames that cannot be understood are counted
 * (`malformedFrames`) and skipped.
 *
 * HONEST TERMINATION, AND WHY IT TAKES TWO FLAGS. `complete` means a terminal event
 * actually arrived. A stream that was cut (deadline, cancelled row, a worker crash
 * after some chunks landed) reports complete:false, and the caller must not present
 * it as a finished answer. A partial answer the reader can see beats an empty turn,
 * but only if it is labelled as partial.
 *
 * That flag alone used to be read as "the answer is whole", and it is not the same
 * claim. An `error` frame IS a terminal event: the provider said the stream is over
 * and nothing more is coming. But the text in hand is only whatever arrived before
 * the error, so the answer is TRUNCATED and the stream is FINISHED at the same
 * time. A caller whose finalize gate read `complete` therefore stored the
 * truncation as the turn's permanent history and, because finalize is also the only
 * way to release chunks, deleted the only copy of the bytes in the same call - for
 * a turn the provider had explicitly told it went wrong. So the two claims are two
 * fields:
 *
 *   complete        a terminal event arrived. Nothing more is coming; stop waiting.
 *   answerComplete  ...and it was a terminal event that means the answer FINISHED
 *                   (message_stop, response.completed, response.incomplete), not
 *                   one that means it DIED (an `error` frame, response.failed, a
 *                   terminal Response carrying an error payload).
 *
 * `response.incomplete` is deliberately on the finished side: the model stopped
 * short at max_output_tokens, but the terminal event carries the complete Response
 * document, so the chunks hold nothing the body does not. A caller deciding what to
 * keep reads `answerComplete`; a caller deciding whether to keep waiting reads
 * `complete`.
 *
 * WHEN THE BYTES ARE NOT SSE AT ALL. skapi's `stream: true` tells the RELAY to read
 * the response incrementally. It does not tell the destination to produce an event
 * stream: that is the caller's own request body. If the body never asked for one
 * (or something in front of the destination buffers the stream back into a single
 * document and drops the framing), the answer arrives as a plain JSON body with not
 * one `data:` line in it. Every frame test below then matches nothing, and the turn
 * used to end as an empty answer with malformedFrames 0, complete false and
 * finalBody() null: the entire reply lost, with nothing in the output saying so, so
 * a client draws an empty bubble and no error. That state is now reported as
 * `unframed`, and the bytes are handed back BOTH ways, because the parser cannot
 * tell an answer from a gateway's error page without knowing the vendor, and it
 * must not:
 *   unframedText  the bytes verbatim, for a body that is not JSON at all (an HTML
 *                 502 page), which finalBody() cannot represent.
 *   finalBody()   the parsed document when the bytes ARE JSON, because a buffered
 *                 body is exactly what finalBody() promises, so the caller's
 *                 existing buffered path (isErrorResponseBody, extractClaudeText,
 *                 extractOpenAIText) reads it with no new branch at all.
 * Noticing that a byte stream carries no SSE framing is framing, not parsing, and
 * JSON.parse is the same transport-level codec this file already runs on every
 * frame payload. Nothing about the document is interpreted: it is handed over
 * whole, and `provider` stays null because no event ever identified one.
 *
 * DOM-free and framework-free like the rest of the engine.
 */

/** One row of csr-poll's `chunks`. */
export interface SseChunk {
	seq: number;
	txt: string;
}

/**
 * Which grammar the bytes turned out to be in. Detected, never declared: see
 * detectProvider() below for why the caller is not asked.
 */
export type SseProvider = 'claude' | 'openai';

/**
 * A tool the model reached for, in the order it appeared, so a "querying sales
 * table..." row can be drawn before a single character of answer text exists.
 * Duplicates are kept: two calls to the same tool are two rows, not one.
 */
export interface SseToolCall {
	/** Anthropic content index, or OpenAI output index. Identifies the block. */
	index: number;
	/** The name as the provider wrote it, falling back to the block/item type for
	 *  a built-in that carries no name of its own (OpenAI's web_search_call). */
	name: string;
	/** The provider's own block/item type: tool_use, server_tool_use,
	 *  mcp_tool_use, function_call, mcp_call, web_search_call, ... */
	type: string;
	/** Present on Anthropic mcp_tool_use only. */
	serverName?: string;
}

export interface SseSnapshot {
	/** null until the first identifying event has been seen. */
	provider: SseProvider | null;
	/** The assistant's answer text so far, joined exactly as the extractor joins
	 *  it. Never contains tool arguments or thinking. */
	text: string;
	/** Extended-thinking text so far, for a "thinking..." affordance. Deliberately
	 *  a SEPARATE field: it must never be concatenated into `text`. Populated on
	 *  BOTH providers (Anthropic thinking blocks, OpenAI reasoning summary and
	 *  reasoning text deltas). It used to be Anthropic-only, which meant the field
	 *  read as "the model's thinking" on one provider and as "this model did not
	 *  think" on the other, and every consumer that did not branch on `provider`
	 *  drew the wrong thing. Absorbing exactly that branch is what this module is
	 *  for, so the field is filled rather than renamed. */
	thinkingText: string;
	/** Tools reached for, in order of appearance. */
	toolCalls: SseToolCall[];
	/** Convenience projection of toolCalls, same order, duplicates kept. */
	toolNames: string[];
	/** Anthropic stop_reason ('end_turn' | 'tool_use' | 'max_tokens' | ...), or for
	 *  OpenAI the terminal Response's status, or its incomplete_details.reason when
	 *  it stopped short ('max_output_tokens'). null until the stream says. */
	stopReason: string | null;
	/** A terminal event ARRIVED. False means the stream was cut and whatever is
	 *  here is partial: do not present it as a finished answer.
	 *
	 *  THIS IS NOT THE FLAG TO STORE BY. It answers "is anything more coming?", not
	 *  "is this the whole answer?" - see `answerComplete`. */
	complete: boolean;
	/** The terminal event that arrived means the answer FINISHED, not that it DIED.
	 *
	 *  True on message_stop, response.completed and response.incomplete; false while
	 *  the stream is still running, false when it was cut, and false when it ended
	 *  on an `error` frame, on response.failed, or on a terminal Response carrying
	 *  an error payload.
	 *
	 *  THE FAILURE THIS FIELD EXISTS FOR. An `error` frame sets `terminalEvent`, so
	 *  `complete` goes true while the text is only what arrived before the error. A
	 *  caller that finalizes on `complete` therefore writes that truncation into the
	 *  turn's permanent history AND releases the chunks it was assembled from, which
	 *  is the one loss in this feature that cannot be undone. Every keep/store gate
	 *  reads THIS field; `complete` is for deciding whether to keep waiting. Bytes
	 *  that were never SSE at all reach neither: see `unframed`, where it is the
	 *  polling row's status and not the parse that says the response finished. */
	answerComplete: boolean;
	/** The exact terminal event: 'message_stop', 'response.completed',
	 *  'response.incomplete', 'response.failed', 'error'. null while running. */
	terminalEvent: string | null;
	/** The stream ended in a provider error. */
	errored: boolean;
	/** The provider's error payload, in the shape isErrorResponseBody() detects. */
	error: any;
	/** Frames that could not be parsed, and tool-argument JSON that would not
	 *  parse at content_block_stop. Diagnostics: both are zero on a healthy turn. */
	malformedFrames: number;
	malformedToolJson: number;
	/** Bytes were relayed, end() was called, and NOT ONE of them was SSE framing:
	 *  no `data:`, no `event:`, not even a comment. The destination answered with a
	 *  plain body instead of an event stream. This is NOT malformedFrames: there
	 *  were no frames to mangle. Nothing is lost, `unframedText` is the bytes and
	 *  finalBody() is the parsed document when they are JSON, so the caller can
	 *  either render them through its buffered path or surface a real error.
	 *  `complete` stays false here because no terminal EVENT arrived and none ever
	 *  will: on an unframed body it is the polling row's own status, not the bytes,
	 *  that says whether the response finished. */
	unframed: boolean;
	/** The relayed bytes verbatim when `unframed`, else null. */
	unframedText: string | null;
	/** Highest chunk seq accepted, for the caller's `since` cursor. 0 = none. */
	lastSeq: number;
}

export interface SseParser {
	/** Feed raw bytes. Any prefix of a frame is held until the rest arrives. */
	feed(text: string): void;
	/** Feed csr-poll's `chunks` array. Chunks at or below the highest seq already
	 *  accepted are DROPPED, so a re-poll from a stale `since` cannot double-append
	 *  the same bytes into the answer. */
	feedChunks(chunks: SseChunk[] | null | undefined): void;
	/** No more bytes are coming. Flushes a final frame that arrived without its
	 *  terminating blank line. Does NOT mark the stream complete: only a terminal
	 *  event does that. It IS what decides `unframed`, because up to this call
	 *  "no framing seen yet" and "the first frame has not finished arriving" are
	 *  the same state, so a caller that never calls end() never learns the bytes
	 *  were not SSE. */
	end(): void;
	snapshot(): SseSnapshot;
	/** The assembled provider body, byte equivalent to a buffered response, or
	 *  null when nothing has been assembled. See buildBody() for the two rules:
	 *  one about errors, one about bytes that were never SSE. */
	finalBody(): any;
}

/* ── the grammars ────────────────────────────────────────────────────────── */

// Anthropic Messages streaming. 'error' is deliberately NOT here: OpenAI has an
// 'error' event too, so it identifies nothing and must not decide the provider.
var CLAUDE_EVENTS: Record<string, true> = {
	message_start: true,
	message_delta: true,
	message_stop: true,
	content_block_start: true,
	content_block_delta: true,
	content_block_stop: true,
	ping: true,
};

// Anthropic content blocks that represent a tool being reached for. Listed rather
// than pattern-matched so a future block type cannot be mistaken for a tool call
// and drawn as a "querying..." row.
var CLAUDE_TOOL_BLOCKS: Record<string, true> = {
	tool_use: true,
	server_tool_use: true,
	mcp_tool_use: true,
	web_search_tool_use: true,
};

// OpenAI Responses output items that represent a tool being reached for.
var OPENAI_TOOL_ITEMS: Record<string, true> = {
	function_call: true,
	mcp_call: true,
	web_search_call: true,
	file_search_call: true,
	code_interpreter_call: true,
	computer_call: true,
	image_generation_call: true,
};

/**
 * The provider is DETECTED from the first identifying event rather than declared
 * by the caller, for three reasons:
 *
 *   1. The chunks are the only evidence of what actually answered. A caller's
 *      belief about which provider it dispatched to is a second source of truth,
 *      and the failure when the two disagree is silent: the wrong grammar matches
 *      nothing, so the turn renders as an empty answer rather than as an error.
 *   2. A reload or a second tab parses a stream it did not initiate. All it has is
 *      the polling row; requiring a declaration would mean plumbing the platform
 *      through every replay path just to restate what byte 1 already says.
 *   3. It costs nothing. Both grammars carry `type` inside the data payload (and
 *      repeat it as the SSE `event:` name), and the two namespaces are disjoint:
 *      every OpenAI Responses event is dotted under 'response.', every Anthropic
 *      one is a bare underscore name.
 */
function detectProvider(type: string): SseProvider | null {
	if (!type) return null;
	if (type.indexOf('response.') === 0) return 'openai';
	if (CLAUDE_EVENTS[type]) return 'claude';
	return null;
}

/* ── SSE framing ─────────────────────────────────────────────────────────── */

/**
 * Where the line starting at `from` ends, or null when the buffer does not yet
 * hold a complete line.
 *
 * A trailing lone '\r' returns null ON PURPOSE. It is ambiguous: it may be a
 * classic-Mac line terminator, or it may be the first half of a '\r\n' whose '\n'
 * is in the next chunk. Emitting the line now and meeting the '\n' next time would
 * produce a spurious EMPTY line, and an empty line is the SSE frame separator, so
 * one unlucky chunk boundary would split a frame in two and lose it. Holding it
 * costs one chunk of latency and cannot be wrong.
 */
function lineEnd(s: string, from: number): { at: number; len: number } | null {
	for (var i = from; i < s.length; i++) {
		var c = s.charCodeAt(i);
		if (c === 10) return { at: i, len: 1 };
		if (c === 13) {
			if (i + 1 >= s.length) return null;
			return { at: i, len: s.charCodeAt(i + 1) === 10 ? 2 : 1 };
		}
	}
	return null;
}

/**
 * One SSE frame's fields. Per the spec: a line starting with ':' is a comment
 * (keepalive), a line with no ':' is a field with an empty value, and exactly ONE
 * leading space is stripped from the value. Multiple `data:` lines in one frame
 * join with '\n', which matters because a provider is free to pretty-print.
 *
 * `framed` says whether ANY line here was SSE at all: a comment, or one of the
 * four field names the spec defines. It is the evidence that these bytes really
 * are an event stream, and it is deliberately wider than the two fields this
 * module reads, because `id:`/`retry:`/a bare keepalive comment are framing even
 * though nothing downstream wants their value. Quoting is what keeps a JSON body
 * from tripping it: a pretty-printed document's lines read `"data": {...}` with
 * the quote inside the field name, never a bare `data`.
 */
function readFrame(lines: string[]): { event: string; data: string; framed: boolean } {
	var event = '';
	var data: string[] = [];
	var framed = false;
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if (!line.length) continue;
		if (line.charCodeAt(0) === 58 /* ':' */) {
			framed = true;
			continue;
		}
		var colon = line.indexOf(':');
		var field = colon === -1 ? line : line.slice(0, colon);
		var value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.charCodeAt(0) === 32) value = value.slice(1);
		if (field === 'data') {
			framed = true;
			data.push(value);
		} else if (field === 'event') {
			framed = true;
			event = value;
		} else if (field === 'id' || field === 'retry') {
			framed = true;
		}
	}
	return { event: event, data: data.join('\n'), framed: framed };
}

/* ── the parser ──────────────────────────────────────────────────────────── */

interface ClaudeBlock {
	/** The block as it will appear in the final body's content array. */
	block: any;
	/** input_json_delta accumulator. Parsed once, at content_block_stop. */
	json: string;
	sawJson: boolean;
}

export function createSseParser(): SseParser {
	/* framing state */
	var buf = '';
	var lines: string[] = [];
	var lastSeq = 0;

	/* "were these bytes ever SSE?" state. `raw` accumulates everything fed UNTIL
	 * the first line that proves the stream is framed, and is dropped at that
	 * moment, so a healthy stream retains at most its first frame and a body that
	 * is not SSE retains the body, which is the size the buffered path would have
	 * held anyway. */
	var sawFraming = false;
	var raw = '';
	var rawHasContent = false;
	var ended = false;
	/* finalBody() may be called on every render; the document is parsed once. */
	var rawParsed = false;
	var rawBody: any = null;

	/* shared state */
	var provider: SseProvider | null = null;
	var terminalEvent: string | null = null;
	var errored = false;
	var error: any = null;
	var stopReason: string | null = null;
	var toolCalls: SseToolCall[] = [];
	var malformedFrames = 0;
	var malformedToolJson = 0;

	/* claude state: blocks keyed BY INDEX, never merged. See the header. */
	var message: any = null;
	var blocks = new Map<number, ClaudeBlock>();

	/* openai state: one entry per output_text PART, keyed by (output, content),
	 * because extractOpenAIText joins the parts with '\n' the same way
	 * extractClaudeText joins text blocks. */
	var parts = new Map<string, { oi: number; ci: number; text: string }>();
	/** OpenAI reasoning text, render-only. See putReasoning(). */
	var reasoning = new Map<string, { oi: number; idx: number; kind: number; text: string }>();
	/** The terminal Response object, verbatim. See handleOpenAI(). */
	var response: any = null;

	/* `text` is a join over state that changes on nearly every frame, so it is
	 * computed on demand and cached until something that feeds it moves. Recomputing
	 * per frame would be quadratic in a long answer for a value the consumer reads
	 * once per poll tick. */
	var textCache: string | null = null;
	var thinkingCache: string | null = null;

	function feed(text: string): void {
		if (typeof text !== 'string' || !text.length) return;
		if (!sawFraming) {
			// Held for the unframed fallback until framing proves it unnecessary. The
			// content test short-circuits on the first non-space, so it costs nothing on
			// a real chunk, and it is done here rather than at end() so that a caller
			// that feeds again after settling (a poll that answered late) cannot be read
			// against a stale scan or against a document parsed from a shorter prefix.
			raw += text;
			if (!rawHasContent) rawHasContent = /\S/.test(text);
			rawParsed = false;
			rawBody = null;
		}
		buf += text;
		var i = 0;
		for (;;) {
			var end = lineEnd(buf, i);
			if (!end) break;
			var line = buf.slice(i, end.at);
			i = end.at + end.len;
			if (line.length === 0) dispatch();
			else lines.push(line);
		}
		// Whatever is left is a partial line (or the ambiguous trailing '\r'), and it
		// stays in the buffer until the chunk that completes it arrives.
		if (i > 0) buf = buf.slice(i);
	}

	function feedChunks(chunks: SseChunk[] | null | undefined): void {
		if (!chunks || !chunks.length) return;
		for (var i = 0; i < chunks.length; i++) {
			var c = chunks[i];
			if (!c || typeof c !== 'object') continue;
			var seq = typeof c.seq === 'number' ? c.seq : 0;
			// A client that re-polls from a `since` it already consumed (a retry, a
			// second poll racing the first, a cursor restored from a stale render)
			// gets the same chunks again. Appending them a second time would duplicate
			// a slab of the answer, which is invisible until the user reads it.
			if (seq && seq <= lastSeq) continue;
			if (seq > lastSeq) lastSeq = seq;
			feed(typeof c.txt === 'string' ? c.txt : '');
		}
	}

	function end(): void {
		// Tolerate a final frame whose terminating blank line never arrived (a body
		// that ended exactly on its last event, or a relay cut one byte early). The
		// ambiguous trailing '\r' can be resolved now: nothing more is coming.
		if (buf.length) {
			var tail = buf.charCodeAt(buf.length - 1) === 13 ? buf.slice(0, -1) : buf;
			if (tail.length) lines.push(tail);
			buf = '';
		}
		// AFTER that flush, never before: a body that ends exactly on its last frame
		// proves itself framed only in this final dispatch, and a stream is not
		// settled until everything it sent has been read.
		if (lines.length) dispatch();
		ended = true;
	}

	/**
	 * Bytes arrived, the relay is done, and none of it was an event stream. Only
	 * decidable at end(): while bytes are still coming, "no framing yet" and "the
	 * first frame is still arriving" are the same state, and calling it early would
	 * hand the caller half a document as if it were a body.
	 *
	 * Whitespace alone is not a body. A stream that relayed nothing but newlines is
	 * an empty stream, not an unframed one, and reporting it as unframed would
	 * invite the caller to render blank bytes as an answer.
	 */
	function isUnframed(): boolean {
		return ended && !sawFraming && rawHasContent;
	}

	function dispatch(): void {
		var pending = lines;
		lines = [];
		if (!pending.length) return;
		// The whole point of never throwing: this runs on a poll tick. One frame the
		// provider mangled (or a proxy truncated) must cost that frame and nothing else.
		try {
			var frame = readFrame(pending);
			if (frame.framed && !sawFraming) {
				// Settled the moment one SSE line is seen, and BEFORE the early returns
				// below, so an `event:`-only frame or a lone keepalive comment still
				// counts as proof. Everything held for the unframed fallback is dropped
				// here: on a real stream it would only grow without ever being read.
				sawFraming = true;
				raw = '';
				rawHasContent = false;
			}
			if (!frame.data.length) return;
			// Some relays end a stream with a literal sentinel rather than an event.
			// It is not JSON and it carries nothing, so it is not a malformed frame.
			if (frame.data === '[DONE]') return;
			var ev: any = JSON.parse(frame.data);
			if (!ev || typeof ev !== 'object') {
				malformedFrames++;
				return;
			}
			// The `type` inside the payload is authoritative; the SSE `event:` name is
			// the fallback for a provider that only names the frame in the header.
			var type: string = typeof ev.type === 'string' && ev.type ? ev.type : frame.event;
			if (!type) {
				malformedFrames++;
				return;
			}
			if (!provider) provider = detectProvider(type);
			if (provider === 'openai') handleOpenAI(type, ev);
			else if (provider === 'claude') handleClaude(type, ev);
			else handleUnattributed(type, ev);
		} catch (e) {
			malformedFrames++;
		}
	}

	/**
	 * A frame that arrived before anything identified the provider. In practice
	 * this is only ever the 'error' event, which both grammars spell the same way
	 * and which therefore must not decide the provider (see CLAUDE_EVENTS).
	 */
	function handleUnattributed(type: string, ev: any): void {
		if (type === 'error') {
			takeError(ev && ev.error ? ev : { type: 'error', error: ev });
			return;
		}
		malformedFrames++;
	}

	function takeError(payload: any): void {
		errored = true;
		terminalEvent = 'error';
		error = payload;
	}

	/* ── Anthropic ───────────────────────────────────────────────────────── */

	function handleClaude(type: string, ev: any): void {
		if (type === 'ping') return;

		if (type === 'error') {
			// Shape preserved verbatim: isErrorResponseBody() in errors.ts matches on
			// `type === 'error'` and on `error.message` / `error.type`, so the caller's
			// existing error path recognises this without a special case.
			takeError({ type: 'error', error: ev && ev.error ? ev.error : ev });
			return;
		}

		if (type === 'message_start') {
			// The full Message minus its content, which the blocks below rebuild. Cloned
			// shallowly so a later message_delta writing stop_reason cannot mutate the
			// caller's copy of a frame it may have kept.
			message = ev && ev.message ? shallowClone(ev.message) : { type: 'message', role: 'assistant' };
			if (typeof message.stop_reason === 'string') stopReason = message.stop_reason;
			return;
		}

		if (type === 'content_block_start') {
			var idx = numberOr(ev.index, -1);
			if (idx < 0) {
				malformedFrames++;
				return;
			}
			// The start frame carries the block's real skeleton, including fields this
			// module never touches (`citations: null` on a text block, `id`/`name` on a
			// tool block, a server tool's result payload). Copying it verbatim rather
			// than synthesising one is what keeps the assembled body byte equivalent to
			// the buffered response.
			var block = ev.content_block ? shallowClone(ev.content_block) : {};
			blocks.set(idx, { block: block, json: '', sawJson: false });
			invalidate();
			if (block && typeof block.type === 'string' && CLAUDE_TOOL_BLOCKS[block.type]) {
				var call: SseToolCall = {
					index: idx,
					name: typeof block.name === 'string' && block.name ? block.name : block.type,
					type: block.type,
				};
				if (typeof block.server_name === 'string') call.serverName = block.server_name;
				toolCalls.push(call);
			}
			return;
		}

		if (type === 'content_block_delta') {
			var i = numberOr(ev.index, -1);
			var d = ev.delta;
			if (i < 0 || !d || typeof d !== 'object') {
				malformedFrames++;
				return;
			}
			var st = blocks.get(i);
			if (!st) {
				// A delta for a block whose start we never saw. Only reachable if a frame
				// was lost; the block is created empty so the delta still lands somewhere
				// and the INDEX is still occupied, which is what keeps the text join from
				// collapsing two paragraphs into one.
				st = { block: { type: deltaBlockType(d.type) }, json: '', sawJson: false };
				blocks.set(i, st);
			}
			applyClaudeDelta(st, d);
			invalidate();
			return;
		}

		if (type === 'content_block_stop') {
			var j = numberOr(ev.index, -1);
			var s = j >= 0 ? blocks.get(j) : undefined;
			if (s && s.sawJson) finishToolJson(s);
			return;
		}

		if (type === 'message_delta') {
			if (!message) message = { type: 'message', role: 'assistant' };
			var delta = ev.delta;
			if (delta && typeof delta === 'object') {
				for (var k in delta) {
					if (Object.prototype.hasOwnProperty.call(delta, k)) message[k] = delta[k];
				}
				if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
			}
			// Anthropic reports the final output_tokens here while the input side was
			// reported on message_start, so the two MERGE. Replacing would drop the
			// input counts the budget code reads back.
			if (ev.usage && typeof ev.usage === 'object') {
				message.usage = mergeInto(shallowClone(message.usage) || {}, ev.usage);
			}
			return;
		}

		if (type === 'message_stop') {
			terminalEvent = 'message_stop';
			return;
		}

		malformedFrames++;
	}

	function applyClaudeDelta(st: ClaudeBlock, d: any): void {
		var t = d.type;
		if (t === 'text_delta') {
			st.block.text = (st.block.text || '') + str(d.text);
			return;
		}
		if (t === 'thinking_delta') {
			st.block.thinking = (st.block.thinking || '') + str(d.thinking);
			return;
		}
		if (t === 'signature_delta') {
			st.block.signature = (st.block.signature || '') + str(d.signature);
			return;
		}
		if (t === 'input_json_delta') {
			// Accumulated as TEXT and parsed once, at content_block_stop. Each fragment
			// is a slice of one JSON document chosen by the provider's tokeniser, so a
			// fragment on its own is routinely not valid JSON ('{"tab', 'le":"sal',
			// 'es"}'), and no fragment may reach the live answer text.
			st.json += str(d.partial_json);
			st.sawJson = true;
			return;
		}
		if (t === 'citations_delta') {
			if (d.citation) {
				if (!Array.isArray(st.block.citations)) st.block.citations = [];
				st.block.citations.push(d.citation);
			}
			return;
		}
		// An unknown delta type is counted rather than guessed at: guessing is how a
		// future block's payload ends up appended to the user's answer.
		malformedFrames++;
	}

	function finishToolJson(st: ClaudeBlock): void {
		if (!st.json.length) {
			// A tool called with no arguments streams no fragments at all. The start
			// frame's `input: {}` is already correct; overwriting it would be a change
			// for its own sake.
			return;
		}
		try {
			st.block.input = JSON.parse(st.json);
		} catch (e) {
			// Truncated or mangled arguments. The block keeps the start frame's `input`
			// and the count says so, because inventing an input would hand the caller a
			// tool call that looks complete and is not.
			malformedToolJson++;
		}
	}

	function deltaBlockType(deltaType: any): string {
		if (deltaType === 'thinking_delta' || deltaType === 'signature_delta') return 'thinking';
		if (deltaType === 'input_json_delta') return 'tool_use';
		return 'text';
	}

	/* ── OpenAI Responses ────────────────────────────────────────────────── */

	function handleOpenAI(type: string, ev: any): void {
		if (type === 'response.output_text.delta') {
			putPart(ev, str(ev.delta), false);
			invalidate();
			return;
		}

		if (type === 'response.output_text.done') {
			// The done frame carries the part's COMPLETE text. Taking it as authoritative
			// repairs a part that lost a delta (a chunk the worker could not write, a
			// capped read the client resumed from the wrong cursor) instead of rendering
			// a hole nobody can see.
			if (typeof ev.text === 'string') {
				putPart(ev, ev.text, true);
				invalidate();
			}
			return;
		}

		if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
			putReasoning(type, ev, str(ev.delta), false);
			invalidate();
			return;
		}

		if (type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_text.done') {
			// Same repair as output_text.done: the done frame carries the part's
			// COMPLETE text, so a part that lost a delta is healed instead of leaving a
			// hole in the middle of the thinking.
			if (typeof ev.text === 'string') {
				putReasoning(type, ev, ev.text, true);
				invalidate();
			}
			return;
		}

		if (type === 'response.output_item.added') {
			var item = ev.item;
			if (item && typeof item.type === 'string' && OPENAI_TOOL_ITEMS[item.type]) {
				toolCalls.push({
					index: numberOr(ev.output_index, toolCalls.length),
					// A built-in tool (web_search_call) has no name of its own, so the item
					// type is the only label there is and a row can still be drawn.
					name: typeof item.name === 'string' && item.name ? item.name : item.type,
					type: item.type,
				});
			}
			return;
		}

		if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
			terminalEvent = type;
			// THE TERMINAL EVENT CARRIES THE COMPLETE RESPONSE OBJECT, so for OpenAI
			// there is nothing to rebuild: this IS the body a buffered call would have
			// returned, kept verbatim. Everything accumulated above exists only to have
			// something to render before this frame arrives.
			if (ev.response && typeof ev.response === 'object') {
				response = ev.response;
				var st = response.status;
				if (st === 'incomplete') {
					var reason = response.incomplete_details && response.incomplete_details.reason;
					stopReason = typeof reason === 'string' && reason ? reason : 'incomplete';
				} else if (typeof st === 'string' && st) {
					stopReason = st;
				}
				if (response.error && (response.error.message || response.error.code)) {
					errored = true;
					error = response;
				}
			}
			if (type === 'response.failed') errored = true;
			return;
		}

		if (type === 'response.error' || type === 'error') {
			takeError(ev && ev.error ? ev : { type: 'error', error: ev });
			return;
		}

		// Every other Responses event (response.created, .in_progress,
		// .output_item.done, .content_part.*, .function_call_arguments.*,
		// .mcp_call.*, .reasoning_summary_part.*, ...) is real and expected. It is
		// simply not needed here, and counting it as malformed would make a healthy
		// turn look broken.
	}

	/**
	 * OpenAI reasoning text. RENDER ONLY: it feeds `thinkingText` and nothing else.
	 * It cannot reach `text` (a different accumulator) and it cannot reach the final
	 * body (which is the terminal Response verbatim), so populating it can only add
	 * a "thinking..." affordance, never alter the answer or the stored turn.
	 *
	 * Two event families are read because the Responses API has two: the summary
	 * (`response.reasoning_summary_text.*`, indexed by summary_index) that
	 * summarising models emit, and raw reasoning (`response.reasoning_text.*`,
	 * indexed by content_index) that models exposing their reasoning emit. A given
	 * response emits one family, not both. The key carries the family anyway, so
	 * that if one ever did emit both, a summary part and a reasoning part sharing an
	 * index could not overwrite each other and silently drop half the thinking.
	 */
	function putReasoning(type: string, ev: any, text: string, replace: boolean): void {
		var summary = type.indexOf('response.reasoning_summary_text.') === 0;
		var oi = numberOr(ev.output_index, 0);
		var idx = numberOr(summary ? ev.summary_index : ev.content_index, 0);
		var key = oi + ':' + (summary ? 's' : 'r') + ':' + idx;
		var r = reasoning.get(key);
		if (!r) {
			r = { oi: oi, idx: idx, kind: summary ? 0 : 1, text: '' };
			reasoning.set(key, r);
		}
		r.text = replace ? text : r.text + text;
	}

	function putPart(ev: any, text: string, replace: boolean): void {
		var oi = numberOr(ev.output_index, 0);
		var ci = numberOr(ev.content_index, 0);
		var key = oi + ':' + ci;
		var p = parts.get(key);
		if (!p) {
			p = { oi: oi, ci: ci, text: '' };
			parts.set(key, p);
		}
		p.text = replace ? text : p.text + text;
	}

	/* ── outputs ─────────────────────────────────────────────────────────── */

	function invalidate(): void {
		textCache = null;
		thinkingCache = null;
	}

	function claudeTextBlocks(): any[] {
		return orderedBlocks().filter(function (b) {
			return b && b.type === 'text';
		});
	}

	function orderedBlocks(): any[] {
		var idx: number[] = [];
		blocks.forEach(function (_v, k) {
			idx.push(k);
		});
		idx.sort(function (a, b) {
			return a - b;
		});
		var out: any[] = [];
		for (var i = 0; i < idx.length; i++) out.push(blocks.get(idx[i])!.block);
		return out;
	}

	function orderedParts(): { oi: number; ci: number; text: string }[] {
		var out: { oi: number; ci: number; text: string }[] = [];
		parts.forEach(function (p) {
			out.push(p);
		});
		out.sort(function (a, b) {
			return a.oi !== b.oi ? a.oi - b.oi : a.ci - b.ci;
		});
		return out;
	}

	function currentText(): string {
		if (textCache !== null) return textCache;
		var out: string;
		if (provider === 'openai') {
			// Mirrors extractOpenAIText: one join unit per output_text PART, '\n'
			// between them. Untrimmed, because a render feed must not have its leading
			// newline removed and then handed back when the next delta lands; the
			// settled answer is trimmed by session.ts exactly as a buffered one is.
			out = orderedParts()
				.map(function (p) {
					return p.text;
				})
				.join('\n');
		} else {
			// Mirrors extractClaudeText EXACTLY, which is the whole point: text blocks in
			// index order, joined with '\n'. A tool block between two text blocks is not
			// a separator to be invented later, it is why the separator exists.
			out = claudeTextBlocks()
				.map(function (b) {
					return b.text || '';
				})
				.join('\n');
		}
		textCache = out;
		return out;
	}

	function currentThinking(): string {
		if (thinkingCache !== null) return thinkingCache;
		var out: string;
		if (provider === 'openai') {
			// Ordered by (output item, index within it), with the family only ever
			// breaking a tie, so the join is a pure function of the events and does not
			// depend on which delta happened to arrive first.
			var rs: { oi: number; idx: number; kind: number; text: string }[] = [];
			reasoning.forEach(function (r) {
				rs.push(r);
			});
			rs.sort(function (a, b) {
				if (a.oi !== b.oi) return a.oi - b.oi;
				if (a.idx !== b.idx) return a.idx - b.idx;
				return a.kind - b.kind;
			});
			out = rs
				.map(function (r) {
					return r.text;
				})
				.join('\n');
		} else {
			out = orderedBlocks()
				.filter(function (b) {
					return b && b.type === 'thinking';
				})
				.map(function (b) {
					return b.thinking || '';
				})
				.join('\n');
		}
		thinkingCache = out;
		return out;
	}

	function buildBody(): any {
		if (provider === 'openai') {
			// Verbatim, terminal-event-only. Nothing is assembled from the deltas: the
			// Response object is complete by construction, and rebuilding one from
			// fragments could only ever produce a near-miss of it.
			//
			// FALLS THROUGH when there is no terminal Response. An OpenAI stream that
			// dies on an `error` frame never sends one, so this used to `return response`
			// (null) before the error fallback below could run, and the destination's own
			// explanation of what went wrong, already parsed and sitting in `error`, was
			// unreachable from the result. The caller then had an empty turn and no
			// reason for it. Returning here only when a Response actually arrived is the
			// whole fix.
			if (response) return response;
		} else if (blocks.size || message) {
			var base = message ? shallowClone(message) : { type: 'message', role: 'assistant' };
			base.content = orderedBlocks();
			return base;
		}
		// Nothing was assembled. If the stream died on an error frame, the error IS
		// what a buffered call would have returned, and takeError() already stored it
		// in the shape isErrorResponseBody() recognises (`type: 'error'` with the
		// payload under `error`), so one code path in the caller reads a streamed
		// error and a buffered one.
		if (errored && error) return error;
		// No frames at all: the bytes were never SSE, so they ARE the body. Handed
		// over uninterpreted; see the header.
		return unframedBody();
	}

	/**
	 * The unframed bytes as a body, or null when they cannot be one.
	 *
	 * A non-object result (a bare `12`, `"ok"`, `null`) is refused for the same
	 * reason dispatch() refuses one inside a frame: it is not a response body, and
	 * handing it back as one would put a caller's `body.error` lookup on a number.
	 * Whatever was refused is still readable in full through `unframedText`.
	 */
	function unframedBody(): any {
		if (!isUnframed()) return null;
		if (rawParsed) return rawBody;
		rawParsed = true;
		try {
			var v = JSON.parse(raw);
			rawBody = v && typeof v === 'object' ? v : null;
		} catch (e) {
			// Not JSON at all: a gateway's HTML error page, a plain-text 502. There is
			// no body to give, and inventing an envelope for it would be exactly the
			// vendor guessing this module refuses. `unframedText` carries the bytes.
			rawBody = null;
		}
		return rawBody;
	}

	function snapshot(): SseSnapshot {
		return {
			provider: provider,
			text: currentText(),
			thinkingText: currentThinking(),
			toolCalls: toolCalls.slice(),
			toolNames: toolCalls.map(function (t) {
				return t.name;
			}),
			stopReason: stopReason,
			complete: terminalEvent !== null,
			// A terminal event that ENDED the answer rather than KILLED it. The
			// `errored` term covers all three ways a stream dies with a terminal event
			// on it: an Anthropic or OpenAI `error` frame (takeError sets both), a
			// response.failed, and a response.completed/incomplete whose Response
			// object carries an error payload. See the field's own doc for the loss
			// this separation prevents.
			answerComplete: terminalEvent !== null && terminalEvent !== 'error' && !errored,
			terminalEvent: terminalEvent,
			errored: errored,
			error: error,
			malformedFrames: malformedFrames,
			malformedToolJson: malformedToolJson,
			unframed: isUnframed(),
			unframedText: isUnframed() ? raw : null,
			lastSeq: lastSeq,
		};
	}

	return {
		feed: feed,
		feedChunks: feedChunks,
		end: end,
		snapshot: snapshot,
		finalBody: buildBody,
	};
}

/* ── small helpers ───────────────────────────────────────────────────────── */

function str(v: any): string {
	return typeof v === 'string' ? v : '';
}

function numberOr(v: any, fallback: number): number {
	return typeof v === 'number' && isFinite(v) ? v : fallback;
}

function shallowClone(o: any): any {
	if (!o || typeof o !== 'object') return o;
	var out: any = Array.isArray(o) ? o.slice() : {};
	if (!Array.isArray(o)) {
		for (var k in o) {
			if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
		}
	}
	return out;
}

function mergeInto(target: any, src: any): any {
	for (var k in src) {
		if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
	}
	return target;
}
