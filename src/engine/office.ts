/**
 * Office-file server-side extraction helpers.
 *
 * Office documents (Microsoft .docx/.xlsx/.pptx, Hancom .hwpx, etc.) can't be
 * read by web_fetch (binary/zip). The proxy worker downloads them from db
 * storage, extracts their text server-side, and substitutes that text for a
 * placeholder token in the request body (carried under the reserved
 * `_skapi_extract` key, which the producer strips before the upstream call).
 */

// A directive telling the proxy worker which office file to download + extract
// and which placeholder token in the request body to substitute.
export type ExtractDirective = {
	/** db storage path of the file, e.g. "folder/report.docx" (also the src:: value). */
	path: string;
	/** The exact token in the request body to replace with the extracted text. */
	placeholder: string;
	/** Original filename — informational (server logs only). */
	name?: string;
	/** MIME type — informational (server logs only). */
	mime?: string;
};

// A directive telling the proxy worker to re-mint a fresh, short-lived URL for a
// file the model fetches by url (PDFs, images — anything NOT server-extractable)
// right before the upstream call, so a queued request never hands the model a
// stale link. The worker mints from `path` and swaps `url` (the exact baked url
// string) everywhere it appears in the request body.
export type FileUrlDirective = {
	/** db storage path of the file, e.g. "folder/report.pdf" (also the src:: value). */
	path: string;
	/** The exact baked url string in the request body to replace with a fresh one. */
	url: string;
};

// Files whose text the worker extracts SERVER-SIDE and inlines for indexing,
// instead of handing the agent a URL to fetch. Two groups:
//   (1) BINARY document formats the model can't read at all (OOXML, Hancom
//       HWP/HWPX, OpenDocument, EPUB) — the worker parses them.
//   (2) TEXT/data/markup/code formats. These ARE readable via web_fetch, BUT
//       some providers (OpenAI's Responses API) have no working file-fetch tool,
//       so the agent can't retrieve the URL at all. Extracting them server-side
//       (the worker just decodes the bytes) makes indexing provider-independent.
const OFFICE_FILE_EXTENSIONS = new Set([
	'doc', 'docx', 'docm',
	'xls', 'xlsx', 'xlsm',
	'ppt', 'pptx', 'pptm',
	'hwp', 'hwpx',
	'ods', 'odt', 'odp',
	'epub',
]);

const TEXT_FILE_EXTENSIONS = new Set([
	'csv', 'tsv', 'tab', 'txt', 'text', 'log', 'md', 'markdown', 'rst',
	'json', 'ndjson', 'jsonl', 'geojson', 'xml', 'yaml', 'yml', 'toml',
	'ini', 'conf', 'cfg', 'properties', 'env', 'rtf', 'html', 'htm',
	'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java',
	'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash',
	'zsh', 'sql', 'css', 'scss', 'less', 'vue', 'svelte', 'tex', 'srt', 'vtt',
]);

// MIME types that indicate decodable text even when the extension is unknown
// (the worker has the same fallback, so any text/* file is extracted server-side).
function isTextMime(m: string): boolean {
	return (
		m.startsWith('text/') ||
		m.endsWith('+json') || m.endsWith('+xml') || m.endsWith('+yaml') ||
		m === 'application/json' || m === 'application/ld+json' ||
		m === 'application/xml' || m === 'application/yaml' || m === 'application/x-yaml' ||
		m === 'application/javascript' || m === 'application/x-javascript' ||
		m === 'application/x-sh' || m === 'application/x-ndjson' ||
		m === 'application/csv' || m === 'application/rtf' ||
		m === 'application/sql' || m === 'application/toml'
	);
}

/**
 * True when a file should be EXTRACTED SERVER-SIDE (text inlined for indexing)
 * rather than handed to the agent as a URL to fetch — i.e. binary office
 * documents AND all text/data/code files. Detection is extension-first (so a
 * .csv reported as an Office MIME is still treated as text), with a text-MIME
 * fallback for unlisted extensions.
 */
export function isServerExtractable(name?: string, mime?: string): boolean {
	const ext = (name || '').split('.').pop()?.toLowerCase() || '';
	if (OFFICE_FILE_EXTENSIONS.has(ext)) return true;
	if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
	const m = (mime || '').toLowerCase();
	if (isTextMime(m)) return true;
	return (
		m.includes('officedocument') ||
		m.includes('opendocument') ||
		m.includes('hwp') ||
		m.includes('epub') ||
		m === 'application/msword' ||
		m === 'application/vnd.ms-excel' ||
		m === 'application/vnd.ms-powerpoint'
	);
}

/** @deprecated renamed to {@link isServerExtractable} (now also covers text files). */
export const isOfficeFile = isServerExtractable;

// Extensions read WINDOW-BY-WINDOW via the readFileContent tool instead of inlined once.
//
// Anything NOT in this set falls back to one-shot server extraction, which is capped at
// MAX_EXTRACTED_CHARS (200k). Measured against real files, that cap was discarding the
// overwhelming majority of every large non-spreadsheet upload:
//   5MB .txt   -> 4.0% indexed (4.8M characters silently dropped)
//   4.8MB .json-> 4.2%
//   1.9M-char Korean .txt -> 10.5%
//   .docx      -> 70.6%
// The truncation was invisible: the agent received a plausible-looking document and had
// no way to know most of it was missing. Windowing these types is what makes "index the
// whole file" true rather than aspirational.
//
// CSV/TSV specifically must be here rather than in the inline path: the layer now gives
// them ROW-bounded windows with absolute row numbers, where the character windower used
// to split rows across boundaries and emit no row numbers at all.
const PAGED_READ_EXTENSIONS = new Set([
	// grids
	'xls', 'xlsx', 'xlsm', 'ods',
	// delimited text (row-windowed by the layer)
	'csv', 'tsv', 'tab',
	// documents
	'pdf', 'docx', 'pptx',
	// plain text / data / markup
	'txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'ndjson', 'xml', 'yaml', 'yml',
]);

/**
 * True when a file should be indexed by PAGING through readFileContent (spreadsheets and
 * PDFs), rather than inline extraction or a web_fetch URL. This is what lets a huge sheet
 * be read row-window by row-window and a scanned PDF be read page-image by page-image,
 * with embedded photos delivered to the vision model.
 */
export function isPagedReadFile(name?: string, mime?: string): boolean {
	const ext = (name || '').split('.').pop()?.toLowerCase() || '';
	if (PAGED_READ_EXTENSIONS.has(ext)) return true;
	const m = (mime || '').toLowerCase();
	return (
		m === 'application/pdf' ||
		m === 'application/vnd.ms-excel' ||
		m.includes('spreadsheetml') ||
		m.includes('opendocument.spreadsheet')
	);
}

/**
 * True for files whose content is VISUAL and must be delivered to the model as IMAGE
 * BLOCKS in the message (rendered pages), because tool-result images render on neither
 * provider. The worker renders a page window to image URLs and injects them (`_skapi_render`
 * directive). Currently PDFs (scanned or not); indexed page-window by page-window with
 * resume advancing the window.
 */
export function isImageVisionFile(name?: string, mime?: string): boolean {
	const ext = (name || '').split('.').pop()?.toLowerCase() || '';
	return ext === 'pdf' || (mime || '').toLowerCase() === 'application/pdf';
}

// Monotonic counter so placeholders are unique even for same-named files in one
// request. Token shape must match the worker's _EXTRACT_PLACEHOLDER_RE:
// {{SKAPI_FILE_CONTENT::<id>}}.
let _extractPlaceholderSeq = 0;
export function makeExtractPlaceholder(seed: string): string {
	_extractPlaceholderSeq += 1;
	const slug = (seed || 'file').replace(/[^a-zA-Z0-9]+/g, '_').slice(-48);
	return `{{SKAPI_FILE_CONTENT::${slug}-${_extractPlaceholderSeq}}}`;
}

// Placeholder marking WHERE the worker injects a window of rendered page/photo IMAGE blocks
// (the `_skapi_render` directive). Distinct token from the text-extraction placeholder.
let _renderPlaceholderSeq = 0;
export function makeRenderPlaceholder(seed: string): string {
	_renderPlaceholderSeq += 1;
	const slug = (seed || 'file').replace(/[^a-zA-Z0-9]+/g, '_').slice(-48);
	return `{{SKAPI_RENDER::${slug}-${_renderPlaceholderSeq}}}`;
}

// Page/photo images per render window. Must match the server default so the client's
// resume window (from = pass * PAGES) lines up with what the worker renders.
export const RENDER_PAGES_PER_WINDOW = 5;

// Token the WORKER substitutes with a human description of the next window's position.
// Shared with the render loop so one substitution path serves both.
export const WINDOW_CURSOR_TOKEN = '{{RENDER_FROM}}';

let _windowPlaceholderSeq = 0;

/**
 * Placeholder the worker replaces with ONE window of a file's text/grid content.
 * Distinct token from the render (page-image) and extract (whole-file) placeholders so
 * a stale token from either can never be mistaken for this one.
 */
export function makeWindowPlaceholder(seed: string): string {
	_windowPlaceholderSeq += 1;
	const slug = (seed || 'file').replace(/[^a-zA-Z0-9]+/g, '_').slice(-48);
	return `{{SKAPI_WINDOW::${slug}-${_windowPlaceholderSeq}}}`;
}

/**
 * True when a file should be read server-side, one window at a time, by the worker.
 * PDFs are excluded: they go through the VISION path, where pages are rendered to
 * images because their text layer is often absent or unreliable.
 */
export function isWindowedReadFile(name?: string, mime?: string): boolean {
	if (isImageVisionFile(name, mime)) return false;
	return isPagedReadFile(name, mime);
}

export interface ComposedUserMessage {
	/** Clean display/history copy (attachment links, NO extraction placeholders). */
	composed: string;
	/** LLM-bound copy — `composed` plus inline office-extraction placeholders. */
	composedForLlm: string;
	/** Office-extraction directives for the proxy worker (undefined if no office files). */
	extractContent?: ExtractDirective[];
	/** JIT url re-mint directives for the worker (non-extractable files: PDFs, images). */
	fileUrls?: FileUrlDirective[];
}

// Compose the user's chat message from the typed text + uploaded attachment URLs.
// Identical for every consumer (agent.vue + the BunnyQuery widget): appends a
// markdown "Attached files" link block, and for office files
// (.docx/.xlsx/.pptx/.hwpx) adds inline extraction placeholders to the LLM copy
// ONLY (the proxy worker substitutes their text server-side; the display/history
// copy stays clean so stale tokens never accumulate across replayed turns).
// The directive `path` is the db storage path (uid-prefixed where applicable),
// NOT the link label — it falls back to the label when no storagePath is given
// (agent.vue uploads FLAT, so storagePath === name there).
export function composeUserMessage(
	text: string,
	attachmentUrls: Array<{ name: string; url: string; storagePath?: string }>,
): ComposedUserMessage {
	let composed = text;
	if (attachmentUrls.length > 0) {
		const lines = attachmentUrls.map((u) => `- [${u.name}](${u.url})`);
		composed = `${text}\n\nAttached files:\n${lines.join('\n')}`;
	}
	let composedForLlm = composed;
	let extractContent: ExtractDirective[] | undefined;
	let fileUrls: FileUrlDirective[] | undefined;
	if (attachmentUrls.length > 0) {
		const extractFiles = attachmentUrls.filter((u) => isServerExtractable(u.name));
		if (extractFiles.length > 0) {
			const directives: ExtractDirective[] = [];
			const sections = extractFiles.map((u) => {
				const storagePath = u.storagePath || u.name;
				const placeholder = makeExtractPlaceholder(storagePath);
				directives.push({ path: storagePath, placeholder, name: u.name });
				return `===== ${u.name} =====\n----- BEGIN FILE CONTENT -----\n${placeholder}\n----- END FILE CONTENT -----`;
			});
			extractContent = directives;
			composedForLlm =
				`${composed}\n\nExtracted content of attached office files ` +
				`(read inline below; do NOT fetch their URLs):\n\n` +
				sections.join('\n\n');
		}
		// Files the model fetches by url (NOT server-extractable: PDFs, images) get
		// a re-mint directive so the worker swaps the baked long-lived CDN url for a
		// fresh short-lived one at send time. Extractable files are inlined as text,
		// so their url is never fetched — no directive needed. A blank url (nothing
		// to match/replace) is skipped.
		const urlFiles = attachmentUrls.filter((u) => u.url && !isServerExtractable(u.name));
		if (urlFiles.length > 0) {
			fileUrls = urlFiles.map((u) => ({ path: u.storagePath || u.name, url: u.url }));
		}
	}
	return { composed, composedForLlm, extractContent, fileUrls };
}
