/**
 * How a text file the chat offers as a download is encoded and labelled, so that
 * whatever opens it reads the characters correctly, in any language.
 *
 * When the model answers with a fenced ```name.ext block, the client turns that
 * block into a Blob and an <a download>. We always write UTF-8, but several very
 * common consumers do not assume UTF-8 when nothing in the file says so, and fall
 * back to the reader's local ANSI codepage: CP949 in Korea, CP932 in Japan,
 * CP936/CP950 in China and Taiwan, CP1251 for Cyrillic. The file is valid and
 * every non-ASCII character still opens as mojibake.
 *
 * There is no single fix, because the way a file declares "this is UTF-8" is a
 * property of the FORMAT:
 *
 *   - a spreadsheet (csv/tsv) and a Windows text editor read a BOM;
 *   - HTML is opened from disk with no HTTP headers, so only an in-document
 *     <meta charset> survives;
 *   - XML carries its encoding in its declaration, and a WRONG declaration makes
 *     a conforming parser fail outright;
 *   - RTF is 7-bit, so non-ASCII has to be escaped into \uNNNN?;
 *   - JSON, JSONL and YAML are UTF-8 by specification, and a BOM BREAKS them.
 *
 * Anything unrecognised is left byte-for-byte alone: an unknown extension is far
 * more likely to be machine-parsed, where an uninvited BOM is a new bug, than to
 * be opened by a legacy editor.
 *
 * MIRROR of skapi-mcp/download-encoding.js, which does the same job for files the
 * server publishes (writeReport / exportRecordsToFile). A file the user gets from
 * a fenced block and the same file published as a download must behave
 * identically, so the two have to change together.
 */

export const BOM = '﻿';

/** Files a spreadsheet or a Windows text editor opens directly. */
export const BOM_EXTS = new Set(['csv', 'tsv', 'tab', 'txt', 'text', 'log']);

/** Read from disk with no HTTP headers, so the declaration must be in the file. */
export const HTML_EXTS = new Set(['html', 'htm', 'xhtml']);
export const XML_EXTS = new Set(['xml', 'svg', 'rss', 'atom', 'xsl', 'xslt', 'plist', 'kml']);
export const RTF_EXTS = new Set(['rtf']);

/** Content types by extension. Every text family carries an explicit charset. */
export const EXT_CONTENT_TYPES: Record<string, string> = {
	csv: 'text/csv; charset=utf-8',
	tsv: 'text/tab-separated-values; charset=utf-8',
	tab: 'text/tab-separated-values; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	text: 'text/plain; charset=utf-8',
	log: 'text/plain; charset=utf-8',
	md: 'text/markdown; charset=utf-8',
	markdown: 'text/markdown; charset=utf-8',
	json: 'application/json; charset=utf-8',
	jsonl: 'application/x-ndjson; charset=utf-8',
	ndjson: 'application/x-ndjson; charset=utf-8',
	geojson: 'application/geo+json; charset=utf-8',
	yaml: 'text/yaml; charset=utf-8',
	yml: 'text/yaml; charset=utf-8',
	toml: 'text/plain; charset=utf-8',
	ini: 'text/plain; charset=utf-8',
	sql: 'text/plain; charset=utf-8',
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	xhtml: 'application/xhtml+xml; charset=utf-8',
	xml: 'application/xml; charset=utf-8',
	svg: 'image/svg+xml; charset=utf-8',
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	ts: 'text/plain; charset=utf-8',
	py: 'text/x-python; charset=utf-8',
	sh: 'text/x-shellscript; charset=utf-8',
	srt: 'application/x-subrip; charset=utf-8',
	vtt: 'text/vtt; charset=utf-8',
	ics: 'text/calendar; charset=utf-8',
	vcf: 'text/vcard; charset=utf-8',
	// RTF is 7-bit ASCII by specification, so it takes no charset parameter.
	rtf: 'application/rtf',
	// Binary types the model can only ever REFERENCE, never author in a fence, but
	// which keep the type sensible if one ever shows up.
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
};

export type EncodingClass = 'bom' | 'html' | 'xml' | 'rtf' | 'none';

export function normalizeExt(ext: string | null | undefined): string {
	return String(ext || '').trim().replace(/^\./, '').toLowerCase();
}

/** Extension of a filename, '' when it has none. */
export function extOf(filename: string | null | undefined): string {
	const name = String(filename || '');
	const dot = name.lastIndexOf('.');
	return dot > 0 ? normalizeExt(name.slice(dot + 1)) : '';
}

/** Which encoding declaration this format understands. */
export function encodingClassForExt(ext: string | null | undefined): EncodingClass {
	const e = normalizeExt(ext);
	if (BOM_EXTS.has(e)) return 'bom';
	if (HTML_EXTS.has(e)) return 'html';
	if (XML_EXTS.has(e)) return 'xml';
	if (RTF_EXTS.has(e)) return 'rtf';
	return 'none';
}

/** True when a file with this extension must be written BOM-first. */
export function needsBomForExt(ext: string | null | undefined): boolean {
	return encodingClassForExt(ext) === 'bom';
}

/**
 * Content type to declare. Everything textual carries an explicit charset:
 * without one the receiving end guesses, and it guesses the local codepage.
 */
export function contentTypeForExt(
	ext: string | null | undefined,
	fallback = 'text/plain; charset=utf-8',
): string {
	return EXT_CONTENT_TYPES[normalizeExt(ext)] || fallback;
}

export function hasBom(text: string): boolean {
	return typeof text === 'string' && text.charCodeAt(0) === 0xfeff;
}

// --- HTML -------------------------------------------------------------------
// Only the document head is inspected. A charset written further down is not one
// a browser would act on anyway (the spec only honours a declaration in the first
// 1024 bytes), and scanning the whole body would start matching <meta> tags that
// a document about HTML is merely quoting.
export const HTML_HEAD_WINDOW = 4096;
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i;
const META_HTTP_EQUIV_RE = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/i;

/**
 * Make an HTML document state its own encoding. Downloaded HTML is opened from
 * disk, where the Content-Type we set no longer exists, so a document with no
 * <meta charset> is decoded with the browser's locale default.
 */
export function ensureHtmlCharset(text: string): string {
	const src = String(text == null ? '' : text);
	const head = src.slice(0, HTML_HEAD_WINDOW);

	const declared = META_CHARSET_RE.exec(head);
	if (declared) {
		// A declaration naming anything other than UTF-8 is actively wrong: the
		// bytes underneath it are always UTF-8. Correct it in place rather than
		// adding a second, contradictory one.
		if (declared[1].toLowerCase().replace(/[^a-z0-9]/g, '') === 'utf8') return src;
		const start = declared.index + declared[0].length - declared[1].length;
		return src.slice(0, start) + 'utf-8' + src.slice(start + declared[1].length);
	}
	// An http-equiv Content-Type with no charset= is still a declaration the
	// browser will use; replace the whole tag with the modern short form.
	const httpEquiv = META_HTTP_EQUIV_RE.exec(head);
	if (httpEquiv) {
		return src.slice(0, httpEquiv.index)
			+ '<meta charset="utf-8">'
			+ src.slice(httpEquiv.index + httpEquiv[0].length);
	}

	const tag = '<meta charset="utf-8">';
	// As early as the document allows: inside <head> if there is one, else right
	// after <html>, else at the very top (a fragment is still parsed head-first).
	const headOpen = /<head[^>]*>/i.exec(head);
	if (headOpen) {
		const at = headOpen.index + headOpen[0].length;
		return src.slice(0, at) + '\n' + tag + src.slice(at);
	}
	const htmlOpen = /<html[^>]*>/i.exec(head);
	if (htmlOpen) {
		const at = htmlOpen.index + htmlOpen[0].length;
		return src.slice(0, at) + '\n<head>' + tag + '</head>' + src.slice(at);
	}
	const doctype = /<!doctype[^>]*>/i.exec(head);
	if (doctype) {
		const at = doctype.index + doctype[0].length;
		return src.slice(0, at) + '\n' + tag + src.slice(at);
	}
	return tag + '\n' + src;
}

// --- XML ---------------------------------------------------------------------
const XML_DECL_RE = /^\s*<\?xml\s[^?]*\?>/i;

/**
 * Correct an XML declaration that names the wrong encoding.
 *
 * A MISSING declaration is left alone on purpose: XML with none is UTF-8 by
 * specification, so every conforming parser already gets it right. A declaration
 * naming EUC-KR over UTF-8 bytes, on the other hand, makes a parser fail outright.
 */
export function ensureXmlEncoding(text: string): string {
	const src = String(text == null ? '' : text);
	const decl = XML_DECL_RE.exec(src);
	if (!decl) return src;

	const found = /encoding\s*=\s*["']([^"']*)["']/i.exec(decl[0]);
	if (!found) return src; // declaration without an encoding is UTF-8 by spec
	if (found[1].toLowerCase().replace(/[^a-z0-9]/g, '') === 'utf8') return src;

	const fixedDecl = decl[0].slice(0, found.index)
		+ found[0].replace(found[1], 'UTF-8')
		+ decl[0].slice(found.index + found[0].length);
	return fixedDecl + src.slice(decl[0].length);
}

// --- RTF ----------------------------------------------------------------------
const RTF_SIGNATURE_RE = /^[\s﻿]*\{\\rtf/i;

/** True when the body really is RTF rather than text merely named .rtf. */
export function looksLikeRtf(text: string): boolean {
	return RTF_SIGNATURE_RE.test(String(text == null ? '' : text));
}

/**
 * Escape every non-ASCII character into RTF's \uNNNN? form.
 *
 * RTF is 7-bit: a literal UTF-8 byte in the body is read through the codepage the
 * header declares, which is how Korean, Japanese and Cyrillic RTF turns to
 * mojibake in Word. \uNNNN? is codepage-independent.
 *
 * ASCII is never touched, which matters: backslashes and braces in an RTF body
 * are control syntax, and "escaping" them would destroy the document. \u takes a
 * SIGNED 16-bit value, so anything above 0x7FFF is emitted negative, and astral
 * characters are emitted as their two surrogates.
 */
export function escapeRtfNonAscii(text: string): string {
	const src = String(text == null ? '' : text);
	let out = '';
	let plainFrom = 0;
	for (let i = 0; i < src.length; i++) {
		const code = src.charCodeAt(i); // UTF-16 unit: surrogates arrive separately
		if (code < 0x80) continue;
		out += src.slice(plainFrom, i);
		out += `\\u${code > 32767 ? code - 65536 : code}?`;
		plainFrom = i + 1;
	}
	return plainFrom === 0 ? src : out + src.slice(plainFrom);
}

/** Apply the format's encoding declaration to a whole document. */
export function applyEncodingDeclaration(text: string, ext: string | null | undefined): string {
	const src = String(text == null ? '' : text);
	switch (encodingClassForExt(ext)) {
		case 'bom':
			// Never a second BOM: two U+FEFF show as a visible  in the first cell.
			return hasBom(src) ? src : BOM + src;
		case 'html':
			return ensureHtmlCharset(src);
		case 'xml':
			return ensureXmlEncoding(src);
		case 'rtf':
			// Text merely NAMED .rtf is opened by Word as plain text, where a BOM is
			// what makes it read UTF-8. Escaping it would show literal \u escapes.
			return looksLikeRtf(src) ? escapeRtfNonAscii(src) : (hasBom(src) ? src : BOM + src);
		default:
			return src;
	}
}

/**
 * Everything a client needs to turn a fenced ```name.ext block into a download:
 * the exact text to put in the Blob and the type to give it.
 */
export function prepareDownloadText(
	filename: string,
	body: string,
): { ext: string; text: string; contentType: string } {
	const ext = extOf(filename);
	return {
		ext,
		text: applyEncodingDeclaration(body, ext),
		contentType: contentTypeForExt(ext),
	};
}
