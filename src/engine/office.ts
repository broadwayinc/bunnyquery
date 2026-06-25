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

// Monotonic counter so placeholders are unique even for same-named files in one
// request. Token shape must match the worker's _EXTRACT_PLACEHOLDER_RE:
// {{SKAPI_FILE_CONTENT::<id>}}.
let _extractPlaceholderSeq = 0;
export function makeExtractPlaceholder(seed: string): string {
	_extractPlaceholderSeq += 1;
	const slug = (seed || 'file').replace(/[^a-zA-Z0-9]+/g, '_').slice(-48);
	return `{{SKAPI_FILE_CONTENT::${slug}-${_extractPlaceholderSeq}}}`;
}

export interface ComposedUserMessage {
	/** Clean display/history copy (attachment links, NO extraction placeholders). */
	composed: string;
	/** LLM-bound copy — `composed` plus inline office-extraction placeholders. */
	composedForLlm: string;
	/** Office-extraction directives for the proxy worker (undefined if no office files). */
	extractContent?: ExtractDirective[];
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
	}
	return { composed, composedForLlm, extractContent };
}
