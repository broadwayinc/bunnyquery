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
 * User message for a VISION file (PDF): its pages are delivered as RENDERED PAGE IMAGES that
 * the proxy worker injects into THIS message at the `placeholder` token (tool-result images
 * render on neither provider, so the pages must be image blocks in the message itself). Each
 * pass shows one WINDOW of pages starting at `renderFrom` (0-based); the resume loop advances
 * the window a pass at a time until the injected note says the last window was reached.
 *
 * renderFrom === 0 is the FIRST pass (leads with "A new file has just been uploaded." so the
 * client builds the "Indexing: <name>" bubble); renderFrom > 0 is a RESUME pass (leads with
 * "CONTINUE indexing" like the paged continue message, so it is not a duplicate primary bubble).
 */
export function buildIndexingRenderMessage(
	attachment: IndexingAttachmentInfo,
	placeholder: string,
	renderFrom: number,
): string {
	const from = Math.max(0, renderFrom || 0);
	const src = `src::${attachment.storagePath}`;
	const meta =
		`File metadata:\n` +
		`- name: ${attachment.name}\n` +
		`- storage path: ${attachment.storagePath}\n` +
		(attachment.mime ? `- mime type: ${attachment.mime}\n` : '');

	// Shared datafy + completion guidance. The placeholder is where the worker splices the
	// note + rendered page images; instructions reference "the page images in this message"
	// so they read correctly whether the images land before or after this text.
	const datafy =
		`\n${placeholder}\n\n` +
		`LOOK at each rendered page image in this message and DATAFY what it shows: for EVERY page ` +
		`call postRecords and save records - one record per row / table entry / line item visible on the page ` +
		`(or one record for the page if it is prose), capturing every value you can read (OCR the text, read tables ` +
		`cell by cell, describe any photos/diagrams). Use the storage path above for the "src::" unique_id.\n\n` +
		`The note next to the images tells you whether MORE pages remain after this window. ` +
		`If MORE remain: save this window's records and STOP - do NOT write INDEXING_COMPLETE; another pass shows the next window automatically. ` +
		`Only when the note says this is the LAST window (you have seen the whole file) AND everything is saved, end your message with the token INDEXING_COMPLETE.`;

	if (from === 0) {
		return (
			`A new file has just been uploaded. Index it now.\n\n` +
			meta +
			`\nThis is a PDF. Its pages are delivered to you as RENDERED PAGE IMAGES embedded directly in this ` +
			`message (you do NOT need any tool, URL, or web_fetch to see them). You are shown a WINDOW of pages ` +
			`at a time, starting at page ${from + 1}.\n` +
			datafy
		);
	}

	return (
		`CONTINUE indexing a PDF whose previous pass did not finish.\n\n` +
		meta +
		`\nRecords for the earlier pages are ALREADY saved (they reference "${src}"). The NEXT window of ` +
		`rendered page images (starting at page ${from + 1}) is embedded in this message. Datafy each page as ` +
		`before and do NOT re-save pages that are already saved.\n` +
		datafy
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
