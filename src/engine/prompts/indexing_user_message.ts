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

	return head + `- temporary URL (fetch this to read the file contents): ${attachment.url}`;
}
