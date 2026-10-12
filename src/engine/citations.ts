/**
 * Citations and the no-source mark (reliability plan 3.5).
 *
 * The retrieval note (retrieval_memory.ts) already records what a turn READ:
 * the files it queried or linked and the pages searchText found a term on.
 * This module turns that note into what the two clients DRAW under an answer:
 *
 *   - a row of file chips, one per cited file (and page, when a page is
 *     known), each opening the file the way every other stored-file chip does
 *     (the `_expired_.url` placeholder that the client's click handler mints a
 *     fresh url for; the page is in the label only, there is no deep link);
 *   - a small mark when the answer used NO data tool at all, so an answer the
 *     model wrote from its own head is visibly different from one it read.
 *
 * Pure data in, pure data out: no DOM, nothing reactive. Each client renders the
 * parts with the same emitter it already uses for inline links, so a citation
 * chip is byte for byte the chip the model would have written inline, and the
 * same delegated click handler, the same unavailable state and the same minted
 * url cache serve it.
 */

import type { RetrievalNote, RetrievalHit } from './retrieval_memory';
import { isRetrievalNote } from './retrieval_memory';
import { buildDisplayExpiredAttachmentHref, isHttpUrlLike, truncateLabelForDisplay } from './links';

export interface Citation {
	/** Storage path, exactly as the note carries it. */
	path: string;
	/** 1-based page, when a searchText hit named one. */
	page?: number;
	/** What the chip says: the file name (last path segment) plus " p.N" when a page is known. */
	label: string;
}

/**
 * The tools that READ project data. An answer whose turn called none of these
 * (and no web tool) was written without looking at anything, which is what the
 * no-source mark says. Names are the MCP tool names as the body carries them.
 */
export var DATA_TOOL_NAMES = [
	'getRecords', 'queryGrid', 'readFileContent', 'searchText', 'getFileOutline',
	'getUniqueId', 'getTables', 'getTags', 'getIndexes',
];

/** The mark's text, single-sourced so the two clients cannot word it differently. */
export var NO_DATA_TOOL_MARK = 'No project data was read for this answer';

/** The file name of a storage path: its last non-empty segment. */
export function citationFileName(path: string): string {
	var segs = String(path || '').split('/');
	for (var i = segs.length - 1; i >= 0; i--) {
		if (segs[i]) return segs[i];
	}
	return String(path || '');
}

function citationLabel(path: string, page?: number): string {
	return citationFileName(path) + (typeof page === 'number' && page > 0 ? ' p.' + page : '');
}

/** A note entry that names a URL, not a stored file: nothing of ours to open. */
function isMintablePath(path: string): boolean {
	return !!path && !isHttpUrlLike(path);
}

/**
 * The citations of one note, deduplicated and ordered: searchText hits first
 * (files in the order they were first hit, pages ascending within a file), then
 * the files the turn read or linked without a page, in the note's order. A file
 * that has a page hit is not repeated as a page-less chip. Empty for a null note.
 */
export function citationsFor(note: RetrievalNote | null | undefined): Citation[] {
	if (!isRetrievalNote(note)) return [];
	var out: Citation[] = [];
	var hitPaths: string[] = [];
	var byPath: Record<string, number[]> = {};
	var i: number;
	for (i = 0; i < note.hits.length; i++) {
		var h: RetrievalHit = note.hits[i];
		if (!h || typeof h.path !== 'string' || !isMintablePath(h.path)) continue;
		var page = typeof h.page === 'number' ? h.page : Number(h.page);
		if (!isFinite(page) || page <= 0) continue;
		page = Math.floor(page);
		if (!byPath[h.path]) { byPath[h.path] = []; hitPaths.push(h.path); }
		if (byPath[h.path].indexOf(page) === -1) byPath[h.path].push(page);
	}
	for (i = 0; i < hitPaths.length; i++) {
		var p = hitPaths[i];
		var pages = byPath[p].slice().sort(function (a, b) { return a - b; });
		for (var j = 0; j < pages.length; j++) {
			out.push({ path: p, page: pages[j], label: citationLabel(p, pages[j]) });
		}
	}
	for (i = 0; i < note.files.length; i++) {
		var f = note.files[i];
		if (typeof f !== 'string' || !isMintablePath(f)) continue;
		if (byPath[f]) continue;
		var dup = false;
		for (var k = 0; k < out.length; k++) {
			if (out[k].path === f && out[k].page === undefined) { dup = true; break; }
		}
		if (dup) continue;
		out.push({ path: f, label: citationLabel(f) });
	}
	return out;
}

/** True when `name` is one of the data-reading tools. */
export function isDataToolName(name: string): boolean {
	return DATA_TOOL_NAMES.indexOf(name) !== -1;
}

/**
 * True when the turn has a note and that note shows no data tool and no web
 * tool: the answer was written without reading anything. A null note is
 * UNKNOWN (no body to read, a greeting, an indexing pass), never "no source".
 */
export function answerUsedNoDataTool(note: RetrievalNote | null | undefined): boolean {
	if (!isRetrievalNote(note)) return false;
	if (note.web) return false;
	for (var i = 0; i < note.tools.length; i++) {
		if (isDataToolName(note.tools[i])) return false;
	}
	return true;
}

/**
 * The retrieval note of a SETTLED CHAT ANSWER, or null: the one place both
 * clients decide which bubbles get chips and the mark. Not a user turn, not an
 * indexing pass (a collapsed row, never a bubble), not an error, not a bubble
 * still waiting for its answer. The greeting is client chrome with no note.
 */
export function retrievalNoteOfAnswer(msg: {
	role?: string;
	isError?: boolean;
	isPending?: boolean;
	isBackgroundTask?: boolean;
	_streamPending?: boolean;
	_retrieval?: RetrievalNote | null;
} | null | undefined): RetrievalNote | null {
	if (!msg || msg.role !== 'assistant') return null;
	if (msg.isError || msg.isPending || msg.isBackgroundTask || msg._streamPending) return null;
	return isRetrievalNote(msg._retrieval) ? msg._retrieval : null;
}

/** The shape both clients' link emitters accept (a RenderableInlineLink with the view's part tag). */
export interface CitationLinkPart {
	type: 'link';
	label: string;
	fullLabel: string;
	href: string;
	expired: boolean;
	expiredHref: string;
	remotePath: string;
}

/**
 * One citation as the link part the clients already know how to draw and click:
 * the `_expired_.url` placeholder for the file's storage path (or the fresh url
 * the view has cached for it), the storage path as `remotePath` so the click
 * handler and the unavailable map find it, and NO image, so a cited picture is
 * a chip under the answer rather than a second preview of it. The display label
 * is truncated from the front (truncateLabelForDisplay keeps the tail), so the
 * " p.N" suffix survives a long file name.
 */
export function citationLinkPart(
	citation: Citation,
	resolveFreshHref?: (expiredHref: string) => string | undefined,
): CitationLinkPart {
	var expiredHref = buildDisplayExpiredAttachmentHref(citation.path, citation.label);
	var cached = resolveFreshHref ? resolveFreshHref(expiredHref) : undefined;
	return {
		type: 'link',
		label: truncateLabelForDisplay(citation.label),
		fullLabel: citation.label,
		href: cached || expiredHref,
		expired: !cached,
		expiredHref: expiredHref,
		remotePath: citation.path,
	};
}
