/**
 * Pure link/path helpers (no DOM, no marked). Moved verbatim from the chatbox.
 * `serviceId` is passed as a PARAMETER (the original read it from a global) so
 * the engine stays consumer-agnostic. The HTML-emitting helpers
 * (buildLinkPartFromGroups, linkToAnchorHtml, fileToAnchorHtml, parseMsgParts*)
 * stay in each VIEW — only these pure pieces move here.
 */

export var EXPIRED_ATTACHMENT_URL_HOST = '_expired_.url';
export var EXPIRED_ATTACHMENT_URL_ORIGIN = 'https://' + EXPIRED_ATTACHMENT_URL_HOST;
export var LINK_LABEL_MAX_DISPLAY_CHARS = 32;

export function createInlineLinkRegex(): RegExp {
	return /src::(\S+)|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]+|\([^\s()]*\))+)\)|\[([^\]\n]+)\]\(((?:[^()\n]+|\([^()\n]*\))+)\)|(https?:\/\/[^\s<>"']+)/g;
}

export function safeDecodeURIComponent(v: string): string {
	try { return decodeURIComponent(v); } catch (e) { return v; }
}

export function encodePathSegments(path: string): string {
	return path.split('/').filter(Boolean).map(function (s) { return encodeURIComponent(s); }).join('/');
}

export function normalizeAttachmentPathCandidate(value: string): string {
	return safeDecodeURIComponent((value || '').trim()).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function extractRemotePathFromAttachmentHref(href: string, serviceId: string): string | null {
	try {
		var parsed = new URL(href);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		var path = normalizeAttachmentPathCandidate(parsed.pathname || '');
		var segs = path.split('/').filter(Boolean);
		if (!segs.length) return null;
		var HEX = /^[a-f0-9]{32,}$/i;
		var sid = serviceId || '';
		var start = 0;
		while (start < segs.length) {
			var seg = segs[start];
			if (seg === sid || HEX.test(seg)) { start++; continue; }
			break;
		}
		var real = segs.slice(start).join('/');
		return real || null;
	} catch (e) { return null; }
}

export function getExpiredAttachmentVisiblePath(remotePath: string, fallback?: string): string {
	var n = normalizeAttachmentPathCandidate(remotePath);
	if (n) return n;
	return normalizeAttachmentPathCandidate(fallback || 'file') || 'file';
}

export function buildDisplayExpiredAttachmentHref(remotePath: string, fallback?: string): string {
	return EXPIRED_ATTACHMENT_URL_ORIGIN + '/' + encodePathSegments(getExpiredAttachmentVisiblePath(remotePath, fallback));
}

// Does `href` point at THIS service's db attachment storage? A db attachment URL's
// path always begins with the serviceId segment (…/<serviceId>/<hash>/<path>). Used
// to SAFELY sanitize assistant messages — where an arbitrary external citation URL
// must never be rewritten, only the service's own volatile db links.
export function isServiceDbAttachmentHref(href: string, serviceId: string): boolean {
	if (!serviceId) return false;
	try {
		var parsed = new URL(href);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
		var segs = normalizeAttachmentPathCandidate(parsed.pathname || '').split('/').filter(Boolean);
		return segs.length > 0 && segs[0] === serviceId;
	} catch (e) { return false; }
}

// Replace volatile attachment URLs with their durable `_expired_.url/<path>`
// placeholder so a stored/replayed copy re-mints on demand instead of going stale.
// USER turns: the "Attached files:" block gates the (broad) rewrite — every url
// there is a db link. ASSISTANT turns (forAssistant=true): no marker exists and the
// text may contain external citation urls, so restrict the rewrite to THIS
// service's db attachment urls and leave every other link untouched.
export function sanitizeAttachmentLinksForHistory(content: string, serviceId: string, forAssistant?: boolean): string {
	if (!content) return content;
	if (!forAssistant && content.indexOf('Attached files:') === -1) return content;
	return content.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_m: string, label: string, href: string) {
		if (forAssistant && !isServiceDbAttachmentHref(href, serviceId)) return _m;
		var remotePath = extractRemotePathFromAttachmentHref(href, serviceId);
		var labelPath = normalizeAttachmentPathCandidate(label);
		var fullPath = remotePath || labelPath;
		if (!fullPath) return forAssistant ? _m : '[' + label + '](' + EXPIRED_ATTACHMENT_URL_ORIGIN + '/file)';
		return '[' + label + '](' + buildDisplayExpiredAttachmentHref(fullPath, label) + ')';
	});
}

export function truncateLabelForDisplay(label: string): string {
	if (!label) return label;
	if (label.length <= LINK_LABEL_MAX_DISPLAY_CHARS) return label;
	return '…' + label.slice(label.length - (LINK_LABEL_MAX_DISPLAY_CHARS - 1));
}
