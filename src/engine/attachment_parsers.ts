/**
 * Client-side attachment-parser plugins.
 *
 * Some attachment formats can't be read by the model's web_fetch (binary) and
 * have no server-side extractor either — e.g. legacy Hancom .hwp. A parser
 * plugin runs IN THE BROWSER, turns the uploaded File into indexable text (or an
 * HTML string), and the engine sends that content INLINE in the background
 * indexing request — so the model indexes the parsed content directly, with no
 * upload-side server extraction and no web_fetch for that file.
 *
 * Register a parser with `registerAttachmentParser()`, or via
 * `configureChatEngine({ attachmentParsers: [...] })`. The BunnyQuery widget also
 * exposes `BunnyQuery.registerAttachmentParser()` and an `attachmentParsers`
 * init option. First matching parser wins.
 */

export interface AttachmentParser {
	/** Human-readable label — used only in logs. */
	name?: string;
	/**
	 * Return true if this parser handles the file. Receives the file name and
	 * (when known) its MIME type. Keep it cheap — it runs for every upload.
	 */
	match: (file: { name: string; mime?: string }) => boolean;
	/**
	 * Parse the File into indexable plain text OR an HTML string (the model reads
	 * either). Runs in the browser; may be async. Return a falsy/empty value to
	 * skip (the file then falls back to web_fetch / server extraction).
	 */
	parse: (
		file: File,
	) => string | null | undefined | Promise<string | null | undefined>;
}

// Hard ceiling on inlined parsed content (characters), mirroring the worker's
// server-side MAX_EXTRACTED_CHARS, so a huge document can't blow the model's
// context window or the request size.
export const MAX_PARSED_CONTENT_CHARS = 200_000;

const _parsers: AttachmentParser[] = [];

/** Register an attachment parser. Ignores duplicates (by reference) and invalid plugins. */
export function registerAttachmentParser(parser: AttachmentParser): void {
	if (
		parser &&
		typeof parser.match === 'function' &&
		typeof parser.parse === 'function' &&
		_parsers.indexOf(parser) === -1
	) {
		_parsers.push(parser);
	}
}

/** Remove all registered parsers (mainly for tests / re-init). */
export function clearAttachmentParsers(): void {
	_parsers.length = 0;
}

/** Snapshot of the registered parsers. */
export function getAttachmentParsers(): AttachmentParser[] {
	return _parsers.slice();
}

/** First parser whose `match` returns true for the given file, if any. */
export function findAttachmentParser(
	name: string,
	mime?: string,
): AttachmentParser | undefined {
	for (let i = 0; i < _parsers.length; i++) {
		try {
			if (_parsers[i].match({ name: name, mime: mime })) return _parsers[i];
		} catch {
			/* a throwing matcher must not break uploads */
		}
	}
	return undefined;
}

/**
 * Run the matching parser (if any) and return capped, trimmed content — or null
 * when there is no parser, the parser throws, or it yields nothing. Never throws:
 * a parser failure degrades to null so the upload still completes (the file then
 * resolves via its normal path).
 */
export async function parseAttachmentContent(
	file: File,
	name: string,
	mime?: string,
): Promise<string | null> {
	const parser = findAttachmentParser(name, mime);
	if (!parser) return null;

	let raw: string | null | undefined;
	try {
		raw = await parser.parse(file);
	} catch (err) {
		console.error(
			`[chat-engine] attachment parser ${parser.name || '(unnamed)'} failed for ${name}:`,
			err,
		);
		return null;
	}

	let text = (raw == null ? '' : String(raw)).trim();
	if (!text) return null;
	if (text.length > MAX_PARSED_CONTENT_CHARS) {
		text =
			text.slice(0, MAX_PARSED_CONTENT_CHARS) +
			`\n...[truncated for length; original ${text.length} characters]`;
	}
	return text;
}
