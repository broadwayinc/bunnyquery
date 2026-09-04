/**
 * BASE PROMPT - Background file-indexing agent (user message)
 * ============================================================================
 * USER-role message paired with the indexing system prompt. Sent by
 * notifyAgentSaveAttachment() each time a file is uploaded or re-indexed.
 *
 * NOTE: the leading line "A new file has just been uploaded. Index it now." and
 * the "- name: ..." line are also what the chat client parses to build the
 * "Indexing: <name>" history bubble - keep those fields on their own lines.
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
	/**
	 * Access group every record extracted from this file must be written at.
	 *
	 * The uploader chooses it (project default, or a per-upload prompt), and the
	 * `src::` file record is already created at this group before indexing starts.
	 * The rows, chapters and summaries the agent writes have to MATCH it: skapi's
	 * access group is part of a record's table key, so a public file whose rows
	 * were saved as "authorized" is a file an anonymous visitor can see the name
	 * of and none of the contents of. Omitted means "authorized", which is what
	 * every record written before this setting existed used.
	 */
	accessGroup?: 'public' | 'authorized' | 'private';
};

export type BuildIndexingUserMessageOptions = {
	/**
	 * For files the layer parses server-side (office, e-book, email) and for text
	 * files, the text is inlined server-side: a binary container cannot be read via
	 * web_fetch, and a text file is inlined so providers without a file-fetch tool
	 * still see it. The proxy worker extracts the text and replaces this exact
	 * token with it. When provided, the message embeds the token (and
	 * drops the temporary-URL line - there is nothing for the model to fetch).
	 */
	inlineContentPlaceholder?: string;
	/**
	 * Actual file content parsed CLIENT-SIDE by an attachment-parser plugin (e.g.
	 * an .hwp parser). Embedded inline verbatim - no server extraction and no
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

/**
 * The access group to write this file's records at. One place, so the user
 * message, the continue message and the system prompt cannot disagree.
 */
export function indexingAccessGroup(attachment: { accessGroup?: string }): 'public' | 'authorized' | 'private' {
	const g = attachment && attachment.accessGroup;
	return g === 'public' || g === 'private' ? g : 'authorized';
}

/**
 * The folders a file was uploaded into, as a readable trail.
 *
 * WHY IT IS ITS OWN LINE and not left implicit in the storage path: people file things
 * meaningfully. "2026/Q2/royalties/settlement.xlsx" says what the numbers ARE in a way no
 * amount of reading the grid recovers, and a sheet of bare figures under
 * "inspections/KCG-B507/" is about one aircraft. The path is already in the metadata block,
 * but as one string it reads as an address to pass to a tool, which is how it has been used.
 *
 * Returns '' for a file at the root, so the line simply does not appear rather than showing
 * an empty value.
 */
export function indexingFolderTrail(storagePath: string): string {
	if (typeof storagePath !== 'string' || !storagePath) return '';
	const parts = storagePath.split('/').filter(Boolean);
	// The last segment is the file itself, and a folder named only by a date or an id tells
	// the reader nothing this line is for, so it is kept rather than filtered: deciding which
	// folder names are meaningful is the model's job, not this function's.
	parts.pop();
	return parts.join(' / ');
}

export function buildIndexingUserMessage(
	attachment: IndexingAttachmentInfo,
	options?: BuildIndexingUserMessageOptions,
): string {
	const head =
		`A new file has just been uploaded. Index it now.\n\n` +
		`File metadata:\n` +
		`- name: ${attachment.name}\n` +
		`- storage path: ${attachment.storagePath}\n` +
		// Context, not an address. See indexingFolderTrail.
		(indexingFolderTrail(attachment.storagePath)
			? `- folders it was filed under: ${indexingFolderTrail(attachment.storagePath)}\n`
			: '') +
		(attachment.mime ? `- mime type: ${attachment.mime}\n` : '') +
		(typeof attachment.size === 'number' ? `- size (bytes): ${attachment.size}\n` : '') +
		// Stated in the metadata block as well as the system prompt because this is
		// the per-FILE value: one project can hold public and private files at once,
		// and the system prompt is what is constant across the run.
		`- access group (use this for EVERY record you write for this file): ${indexingAccessGroup(attachment)}\n`;

	if (options?.inlineContent) {
		// Parsed client-side (an attachment-parser plugin). The content is already
		// inlined below - no server extraction, no URL to fetch.
		return (
			head +
			`\nThe file's content was parsed by the client and is provided inline below. ` +
			`Read it directly - do NOT fetch any URL for this file. ` +
			`Set every record's reference to exactly "src::" + the storage path above (not this content). That file record already exists, so enrich it with updateRecords rather than posting it.\n\n` +
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
			`Read it directly - do NOT fetch any URL for this file. ` +
			`Set every record's reference to exactly "src::" + the storage path above (not this content). That file record already exists, so enrich it with updateRecords rather than posting it.\n\n` +
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
			`Do NOT stop after the first window and do NOT just write a summary. Set every record's reference to exactly "src::" + the storage path above; that file record already exists, so enrich it with updateRecords instead of posting it again.` +
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
		// Context, not an address. See indexingFolderTrail.
		(indexingFolderTrail(attachment.storagePath)
			? `- folders it was filed under: ${indexingFolderTrail(attachment.storagePath)}\n`
			: '') +
		(attachment.mime ? `- mime type: ${attachment.mime}\n` : '') +
		`- access group (use this for EVERY record you write for this file): ${indexingAccessGroup(attachment)}\n`
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
		`cell by cell, describe any photos/diagrams). Set EVERY record's reference to exactly "src::" + the storage path above. That file record ALREADY EXISTS, so do NOT post it, and do NOT give your page records a "src::" unique_id of their own. A record with no reference back to it is an ORPHAN: re-indexing the file deletes the linked records and leaves the orphan behind forever as stale data.\n\n` +
		`Each image is preceded by a label giving its DOCUMENT PAGE number. That label is the page's identity - ` +
		`use it, and ignore any page number PRINTED on the document itself (a scan often restarts its own ` +
		`numbering per section, so a footer reading "PAGE 4 OF 8" routinely disagrees with the real position). ` +
		`Whether a page is one you have already saved is stated in the note above the images - decide from that, ` +
		`never from a printed page number.\n\n` +
		`Transcribe COMPLETELY, not representatively. A table with twenty rows gets twenty records, not a sample ` +
		`of the first few - if a page has more rows than you can save comfortably, still save them all rather than ` +
		`summarising. Where a page carries an embedded text layer it is quoted above that page's image: it is the ` +
		`exact text and should be preferred over reading the pixels, with the image used for layout, tables, ` +
		`stamps and handwriting.\n\n` +
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
		`value you can read. The file-level record ALREADY EXISTS with unique_id "src::" + the storage path above: do NOT post it (a duplicate unique_id is rejected), enrich it with updateRecords, ` +
		`and link every row/section record to it by reference.\n\n` +
		`If this window has PHOTOS attached as images, LOOK at each one and datafy what it actually shows. ` +
		`A «PHOTO ...» marker in the grid text ties a picture to its row and comes in two forms. ` +
		`«PHOTO A88 -> __MEDIA__/...» means the picture at cell A88 is saved as a permanent file at exactly that storage path, and its record in table "__MEDIA__" has unique_id "src::" + that path: UPDATE that record with updateRecords, adding what the picture SHOWS and TAGS for every identifier visible in it (part numbers, tag ids, item names, serial numbers). Do NOT create a duplicate and do NOT add a second photo record in another table: one file, one record. If that update reports the record does not exist, create it ONCE with that same unique_id, reference "src::" + the storage path above, table "__MEDIA__", access group "authorized", and data carrying the path - the path must never be lost. ` +
		`A bare «PHOTO A88» marker with no arrow is a picture with no stored path of its own in this window: usually a repeat stored under an earlier anchor, or one too small to keep. NEVER construct a storage path or unique_id for it: find its record, if any, with getRecords reference "src::" + the storage path above, matching the cell against data.anchor or tags, and enrich what you find. The row record stays about its row's cells. Never report that photo contents could not be extracted when images are attached here.\n\n` +
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
		// Context, not an address. See indexingFolderTrail.
		(indexingFolderTrail(attachment.storagePath)
			? `- folders it was filed under: ${indexingFolderTrail(attachment.storagePath)}\n`
			: '') +
		(attachment.mime ? `- mime type: ${attachment.mime}\n` : '') +
		`- access group (use this for EVERY record you write for this file): ${indexingAccessGroup(attachment)}\n` +
		`\nRecords for the earlier windows/pages of this file are ALREADY saved (they reference "${src}"). ` +
		`First call getRecords with reference "${src}" to see how far the previous pass got (the furthest row/window already saved). The reference ALONE is the whole query: it returns every record written from this file across ALL tables and ALL access groups, so do NOT add table_name or access_group to narrow it. The response is PAGED, so keep fetching pages until it reports there are no more, and take the furthest point from the WHOLE set, never from the first page. ` +
		`Then call readFileContent with the storage path above and a CURSOR that RESUMES just after that point - do NOT start at the beginning. The cursor is derivable from what you already saved:\n` +
		` - Spreadsheet: the cursor is "<sheetIndex>:<nextRow>" (0-based sheet index, 1-based row). If you saved up to row R of sheet S, use cursor="S:R+1".\n` +
		` - Text: the cursor is the character offset already read.\n` +
		`Index the REMAINING windows - one record per row/item, looking at any page images or embedded photos - saving as you go until readFileContent reports END OF FILE. ` +
		`A «PHOTO <cell>» marker in a window marks an embedded picture whose extracted file already has a record in table "__MEDIA__": find it with getRecords reference "src::" + the storage path above and match the cell against data.anchor or tags (a repeated picture is stored under its first anchor only), then enrich it with updateRecords. Never create a photo record of your own and never construct a path for one. ` +
		`Do NOT re-save windows that are already saved. ` +
		`Set every record's reference to exactly "src::" + the storage path above (no sheet, window or summary suffix added). That file record already exists, so do NOT post it; enrich it with updateRecords. When the ENTIRE file is finally indexed, end your message with the token INDEXING_COMPLETE.`
	);
}
