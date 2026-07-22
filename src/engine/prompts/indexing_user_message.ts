/**
 * BASE PROMPT — Background file-indexing agent (user message)
 * ============================================================================
 * USER-role message paired with the indexing system prompt. Sent by
 * notifyAgentSaveAttachment() each time a file is uploaded or re-indexed.
 *
 * NOTE: the leading line "A new file has just been uploaded. Index it now." and
 * the "- name: ..." line are also what the chat client parses to build the
 * "Indexing: <name>" history bubble — keep those fields on their own lines.
 */

export type IndexingAttachmentInfo = {
	/** Original file name. */
	name: string;
	/** Storage path within the project's db storage. */
	storagePath: string;
	/** MIME type, if detected. Omitted from the message when unknown. */
	mime?: string;
	/** File size in bytes, if known. Omitted from the message when unknown. */
	size?: number;
	/** Temporary signed URL the agent/MCP fetches to read the file contents. */
	url: string;
};

export type BuildIndexingUserMessageOptions = {
	/**
	 * For office files (.docx/.xlsx/.pptx) the model can't read the binary via
	 * web_fetch, so the proxy worker extracts the text server-side and replaces
	 * this exact token with it. When provided, the message embeds the token (and
	 * drops the temporary-URL line — there is nothing for the model to fetch).
	 */
	inlineContentPlaceholder?: string;
	/**
	 * Actual file content parsed CLIENT-SIDE by an attachment-parser plugin (e.g.
	 * an .hwp parser). Embedded inline verbatim — no server extraction and no
	 * web_fetch for this file. Takes precedence over `inlineContentPlaceholder`.
	 */
	inlineContent?: string;
	/**
	 * Spreadsheet or PDF: read by PAGING through the readFileContent tool (grid rows +
	 * embedded photos / rendered scanned pages), not inline and not by web_fetch. The
	 * message instructs the agent to page through EVERY window and datafy each.
	 */
	pagedRead?: boolean;
};

export function buildIndexingUserMessage(
	attachment: IndexingAttachmentInfo,
	options?: BuildIndexingUserMessageOptions,
): string {
	const head =
		`A new file has just been uploaded. Index it now.\n\n` +
		`File metadata:\n` +
		`- name: ${attachment.name}\n` +
		`- storage path: ${attachment.storagePath}\n` +
		(attachment.mime ? `- mime type: ${attachment.mime}\n` : '') +
		(typeof attachment.size === 'number' ? `- size (bytes): ${attachment.size}\n` : '');

	if (options?.inlineContent) {
		// Parsed client-side (an attachment-parser plugin). The content is already
		// inlined below — no server extraction, no URL to fetch.
		return (
			head +
			`\nThe file's content was parsed by the client and is provided inline below. ` +
			`Read it directly — do NOT fetch any URL for this file. ` +
			`Use the storage path above (not this content) for the "src::" unique_id.\n\n` +
			`----- BEGIN FILE CONTENT -----\n` +
			`${options.inlineContent}\n` +
			`----- END FILE CONTENT -----`
		);
	}

	if (options?.inlineContentPlaceholder) {
		// Office file: text was extracted on the server and is inlined below
		// between the markers. Do NOT fetch any URL for this file.
		return (
			head +
			`\nThe file's text content was extracted on the server and is provided inline below. ` +
			`Read it directly — do NOT fetch any URL for this file. ` +
			`Use the storage path above (not this content) for the "src::" unique_id.\n\n` +
			`----- BEGIN FILE CONTENT -----\n` +
			`${options.inlineContentPlaceholder}\n` +
			`----- END FILE CONTENT -----`
		);
	}

	if (options?.pagedRead) {
		// Spreadsheet / PDF: force the paging path. The agent MUST read this with the
		// readFileContent tool (which returns the file window by window, with grid rows,
		// embedded photos, and rendered scanned pages), NOT by fetching the URL.
		return (
			head +
			`\nRead this file with the readFileContent tool, using the storage path above - do NOT fetch a URL and do NOT rely on a single sample. ` +
			`readFileContent returns the file ONE WINDOW at a time: spreadsheets as coordinate-tagged grid rows (e.g. 'R4 A:E&I NUMBER | B:E1007'), scanned/large PDFs as rendered PAGE IMAGES, and windows may include embedded photos - LOOK at any images and datafy what they show. ` +
			`Page through EVERY window: for each window SAVE records for its rows/items/pages (postRecords, one record per row/item), THEN if the window says MORE REMAINS call readFileContent again with the cursor it gives you. Repeat until it says END OF FILE, so the WHOLE file is indexed. ` +
			`Do NOT stop after the first window and do NOT just write a summary. Use the storage path above for the "src::" unique_id.` +
			(attachment.url ? `\n(A temporary URL is provided ONLY as a fallback if readFileContent fails: ${attachment.url})` : '')
		);
	}

	return head + `- temporary URL (fetch this to read the file contents): ${attachment.url}`;
}

/**
 * Token the WORKER substitutes with the 1-based first page of the window it is about to
 * render, when it builds the next pass of a document from `RENDER_CONTINUE_TEMPLATE`.
 * Must match the worker's RENDER_FROM_TOKEN.
 */
export const RENDER_FROM_TOKEN = '{{RENDER_FROM}}';
const WINDOW_CURSOR_TOKEN = RENDER_FROM_TOKEN;

/**
 * User message for a VISION file (PDF): its pages are delivered as RENDERED PAGE IMAGES that
 * the proxy worker injects into THIS message at the `placeholder` token (tool-result images
 * render on neither provider, so the pages must be image blocks in the message itself). Each
 * pass shows one WINDOW of pages starting at `renderFrom` (0-based).
 *
 * The WORKER advances the window: when its renderer reports pages remaining it enqueues the
 * next pass itself, off the true page count, so a document indexes end-to-end with no browser
 * involved. This message therefore only ever describes ONE window, and the model is never
 * asked to decide whether the document is finished.
 *
 * renderFrom === 0 is the FIRST pass (leads with "A new file has just been uploaded." so the
 * client builds the "Indexing: <name>" bubble); a continue pass (built by the worker from
 * buildIndexingRenderContinueTemplate) leads with "CONTINUE indexing" so it is not a duplicate
 * primary bubble.
 */
export function buildIndexingRenderMessage(
	attachment: IndexingAttachmentInfo,
	placeholder: string,
	renderFrom: number,
): string {
	const from = Math.max(0, renderFrom || 0);
	if (from > 0) return buildIndexingRenderContinueTemplate(attachment, placeholder, String(from + 1));

	return (
		`A new file has just been uploaded. Index it now.\n\n` +
		buildRenderMeta(attachment) +
		`\nThis is a PDF. Its pages are delivered to you as RENDERED PAGE IMAGES embedded directly in this ` +
		`message (you do NOT need any tool, URL, or web_fetch to see them). You are shown a WINDOW of pages ` +
		`at a time, starting at page ${from + 1}.\n` +
		buildRenderDatafy(placeholder)
	);
}

/**
 * The CONTINUE pass, as a template the worker fills in. `pageLabel` defaults to the
 * RENDER_FROM_TOKEN placeholder, which the worker replaces with the real 1-based start page
 * of the window it is rendering; passing an explicit label produces a ready-to-send message.
 */
export function buildIndexingRenderContinueTemplate(
	attachment: IndexingAttachmentInfo,
	placeholder: string,
	pageLabel: string = RENDER_FROM_TOKEN,
): string {
	const src = `src::${attachment.storagePath}`;
	return (
		`CONTINUE indexing a PDF whose previous pass did not finish.\n\n` +
		buildRenderMeta(attachment) +
		`\nRecords for the earlier pages are ALREADY saved (they reference "${src}"). The NEXT window of ` +
		`rendered page images (starting at page ${pageLabel}) is embedded in this message. Datafy each page as ` +
		`before and do NOT re-save pages that are already saved.\n` +
		buildRenderDatafy(placeholder)
	);
}

function buildRenderMeta(attachment: IndexingAttachmentInfo): string {
	return (
		`File metadata:\n` +
		`- name: ${attachment.name}\n` +
		`- storage path: ${attachment.storagePath}\n` +
		(attachment.mime ? `- mime type: ${attachment.mime}\n` : '')
	);
}

// Shared datafy guidance. The placeholder is where the worker splices the note + rendered
// page images; instructions reference "the page images in this message" so they read
// correctly whether the images land before or after this text.
//
// Deliberately says nothing about INDEXING_COMPLETE or about whether the document is
// finished: the worker decides that from the renderer's page count. Asking the model was
// what used to end an 88-page file at page 15.
function buildRenderDatafy(placeholder: string): string {
	return (
		`\n${placeholder}\n\n` +
		`LOOK at each rendered page image in this message and DATAFY what it shows: for EVERY page ` +
		`call postRecords and save records - one record per row / table entry / line item visible on the page ` +
		`(or one record for the page if it is prose), capturing every value you can read (OCR the text, read tables ` +
		`cell by cell, describe any photos/diagrams). Use the storage path above for the "src::" unique_id.\n\n` +
		`Save records for THIS window of pages only, then stop and report what you saved. Do NOT try to read ` +
		`the rest of the file and do NOT worry about the pages after this window: if any remain, the next window ` +
		`is rendered and sent to you automatically. Report only the pages you were actually shown - never imply ` +
		`you have seen the whole document.`
	);
}

/**
 * User message for a WINDOWED file: the worker splices ONE window of the file's rows or
 * text into this message at `placeholder`, then continues from the reader's own cursor
 * until the file is exhausted.
 *
 * The agent is deliberately NOT asked to page the file itself, and is NOT asked to judge
 * whether it is finished. Both used to be its job, and both failed the same way: the
 * traversal lived inside a single turn's budget, so a large file simply stopped partway
 * with a confident summary of the part it had seen.
 */
export function buildIndexingWindowMessage(
	attachment: IndexingAttachmentInfo,
	placeholder: string,
	isContinuation: boolean,
	positionLabel?: string,
): string {
	const src = `src::${attachment.storagePath}`;
	const head = isContinuation
		? `CONTINUE indexing a file whose previous pass did not finish.\n\n`
		: `A new file has just been uploaded. Index it now.\n\n`;
	const where = isContinuation
		? `\nRecords for the earlier windows are ALREADY saved (they reference "${src}"). The NEXT window ` +
		  `(starting at ${positionLabel || WINDOW_CURSOR_TOKEN}) is embedded below. Do NOT re-save windows that are already saved.\n`
		: `\nThis file is delivered to you ONE WINDOW at a time, embedded directly in this message. ` +
		  `You do NOT need any tool, URL, or web_fetch to read it.\n`;

	return (
		head +
		buildRenderMeta(attachment) +
		where +
		`\n${placeholder}\n\n` +
		`DATAFY this window: call postRecords and save records for everything in it - ONE RECORD PER ROW ` +
		`for tabular data (keyed by the column headers), or one record per section for prose. Capture every ` +
		`value you can read. Use the storage path above for the "src::" unique_id on the file-level record, ` +
		`and link every row/section record to it by reference.\n\n` +
		`Save records for THIS window only, then stop and report what you saved. Do NOT try to read the rest ` +
		`of the file, and do NOT call readFileContent - if more remains, the next window is read and sent to ` +
		`you automatically. Report only what you were actually shown, and never imply you have seen the whole ` +
		`file when the note beside the window says more remains.`
	);
}

/**
 * User message for a RESUME pass: a previous indexing pass could not finish this large
 * file, so continue it from where the already-saved records leave off (never restart).
 */
export function buildIndexingContinueMessage(attachment: IndexingAttachmentInfo): string {
	const src = `src::${attachment.storagePath}`;
	return (
		`CONTINUE indexing a file whose previous pass did not finish.\n\n` +
		`File metadata:\n` +
		`- name: ${attachment.name}\n` +
		`- storage path: ${attachment.storagePath}\n` +
		(attachment.mime ? `- mime type: ${attachment.mime}\n` : '') +
		`\nRecords for the earlier windows/pages of this file are ALREADY saved (they reference "${src}"). ` +
		`First call getRecords with reference "${src}" to see how far the previous pass got (the furthest page/row/window already saved). ` +
		`Then call readFileContent with the storage path above and a CURSOR that RESUMES just after that point - do NOT start at the beginning. The cursor is derivable from what you already saved:\n` +
		`  - PDF: the cursor is the NUMBER OF PAGES already read (0-based next page). If you saved up to page N, call readFileContent with cursor="N" to get page N+1 onward.\n` +
		`  - Spreadsheet: the cursor is "<sheetIndex>:<nextRow>" (0-based sheet index, 1-based row). If you saved up to row R of sheet S, use cursor="S:R+1".\n` +
		`  - Text: the cursor is the character offset already read.\n` +
		`Index the REMAINING windows - one record per row/item, looking at any page images or embedded photos - saving as you go until readFileContent reports END OF FILE. ` +
		`Do NOT re-save windows that are already saved. ` +
		`Use the storage path above for the "src::" unique_id. When the ENTIRE file is finally indexed, end your message with the token INDEXING_COMPLETE.`
	);
}
