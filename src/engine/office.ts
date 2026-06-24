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

// Office formats whose text the model cannot read via web_fetch. OOXML
// (.docx/.xlsx/.pptx) and Hancom .hwpx are extracted server-side; the other
// (legacy/macro/binary) extensions are still flagged so the worker returns a
// graceful note instead of the model fetching binary garbage.
const OFFICE_FILE_EXTENSIONS = new Set([
	'doc', 'docx', 'docm',
	'xls', 'xlsx', 'xlsm',
	'ppt', 'pptx', 'pptm',
	'hwp', 'hwpx',
]);

export function isOfficeFile(name?: string, mime?: string): boolean {
	const ext = (name || '').split('.').pop()?.toLowerCase() || '';
	if (OFFICE_FILE_EXTENSIONS.has(ext)) return true;
	const m = (mime || '').toLowerCase();
	return (
		m.includes('officedocument') ||
		m.includes('hwp') ||
		m === 'application/msword' ||
		m === 'application/vnd.ms-excel' ||
		m === 'application/vnd.ms-powerpoint'
	);
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
		const officeFiles = attachmentUrls.filter((u) => isOfficeFile(u.name));
		if (officeFiles.length > 0) {
			const directives: ExtractDirective[] = [];
			const sections = officeFiles.map((u) => {
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
