/**
 * Pure link/path helpers (no DOM, no marked). Moved verbatim from the chatbox.
 * `projectId` is passed as a PARAMETER (the original read it from a global) so
 * the engine stays consumer-agnostic. The HTML-emitting helpers
 * (buildLinkPartFromGroups, linkToAnchorHtml, fileToAnchorHtml, parseMsgParts*)
 * stay in each VIEW — only these pure pieces move here.
 */

export var EXPIRED_ATTACHMENT_URL_HOST = '_expired_.url';
export var EXPIRED_ATTACHMENT_URL_ORIGIN = 'https://' + EXPIRED_ATTACHMENT_URL_HOST;
export var LINK_LABEL_MAX_DISPLAY_CHARS = 32;

/**
 * Lifetime of the url minted when a user clicks an expired attachment chip.
 *
 * Mint it as a PLAIN get-db presign, never with generate_temporary_cdn_url: the
 * cdn branch ignores `expires` entirely and hands back a url good for the rest of
 * the current UTC day plus the next one, so a "20 minute" link would in fact live
 * 24 to 48 hours. The dashboard has always done this correctly and the widget did
 * not, which is precisely the kind of divergence a shared constant exists to stop.
 */
export var EXPIRED_LINK_REFRESH_EXPIRES_SECONDS = 20 * 60;

/**
 * Lifetime of the url minted for an inline image PREVIEW.
 *
 * Longer than the click url above, and for a different reason. A click hands the
 * user a url they may keep, so it stays short. A preview url is consumed by the
 * page itself and never leaves it, and it is the ONE lever on how long the
 * downloaded picture stays reusable: get_signed_url will not cache a mint for
 * longer than the credential inside it survives, so `browser_cache` cannot buy
 * local availability that `expires` has not paid for. Twenty minutes meant every
 * image re-downloaded three times an hour of ordinary reading.
 *
 * An hour, giving 55 minutes of cache once the server's five minute headroom is
 * taken off. Short enough that a leaked preview url is not a standing grant, long
 * enough that a conversation does not re-fetch its own pictures while the user is
 * still reading it.
 */
export var PREVIEW_URL_EXPIRES_SECONDS = 60 * 60;

/**
 * Seconds the browser may reuse a minted preview url (`browser_cache`).
 *
 * A presigned url is a fresh SigV4 query string on every mint, so it can never
 * be a browser cache key on its own and every reload re-downloads every image.
 * Asking for the MINT with a cacheable GET fixes it from the other end: the same
 * url comes back out of the browser cache, so the body already on disk stays
 * addressable.
 *
 * A CEILING, not a promise. get_signed_url caps what it grants at the lifetime of
 * the url inside the response (expires minus headroom, so 15 minutes for the
 * platform's 20 minute url), because a mint cached for longer than its own
 * credential is a guaranteed 403 that the browser keeps serving from its own
 * store. Asking for the week is still right: it says what this client would
 * reuse if the url were stable by construction, and the server decides.
 *
 * What keeps an image painting is the cached BODY, not a live url. Once the
 * browser evicts that body it refetches with a url that has since expired, gets a
 * 403, and the error path re-mints with `refresh` and mintCacheBustStamp. That
 * path is load-bearing, not a rare fallback.
 *
 * A week is the platform default for reading a private file, not a number chosen
 * here: skapi-js reads every private record file with
 * PRIVATE_FILE_BROWSER_CACHE_SECONDS = 7 days against the same 20-minute url, and
 * get_signed_url caps the header at BROWSER_CACHE_MAX_SECONDS = 7 days. A chat
 * that asked for a day was re-downloading images the rest of the product would
 * have served from disk.
 *
 * Applies to previews only. A CLICK must open a live url, so the chip refresh
 * stays on an uncached POST mint.
 */
export var PREVIEW_BROWSER_CACHE_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long a client may keep serving an href it already minted before dropping
 * back to the placeholder and re-minting.
 *
 * DERIVED from the TTL above, with five minutes of headroom, because the
 * invariant "the cache must expire before the url does" used to be a comment
 * next to two independent literals. If it is ever violated a client serves a
 * dead url with no way to notice; deriving it makes that unrepresentable.
 */
export var LINK_REFRESH_WINDOW_MS = (EXPIRED_LINK_REFRESH_EXPIRES_SECONDS - 5 * 60) * 1000;

/**
 * Cache generation for the mint request url. BUMP THIS to abandon every mint
 * response browsers are currently holding.
 *
 * Generation 2 retires the entries written before 2026-08-11. Those were stored
 * with `max-age=604800` around a presign that dies in twenty minutes, so from
 * minute 21 each one is a guaranteed 403 that the browser keeps serving from its
 * own store for the rest of the week. The server no longer grants a lifetime a
 * url cannot back (get_signed_url resolve_browser_cache), but that fixes what is
 * written from now on and cannot reach what is already stored on a user's
 * device. Changing the url is the only thing that can: an entry nobody requests
 * again is an entry that cannot answer again.
 */
export var MINT_CACHE_GENERATION = 2;

/**
 * Window stamp for a REFRESH mint.
 *
 * WINDOWED, not Date.now(): a per-call stamp is a new cache key per image per
 * retry, which is what made the original `nocache` parameter worse than the
 * disease. One stamp per refresh window means every repair inside those minutes
 * shares a single entry, and it rotates before the url it carries can die.
 */
export function mintCacheBustStamp(now?: number): number {
	return Math.floor((now == null ? Date.now() : now) / LINK_REFRESH_WINDOW_MS);
}

/**
 * The `nocache` value for a preview mint: the generation, plus a window stamp
 * when this mint is a repair.
 *
 * A repair MUST reach the origin, and the request header the clients used to
 * rely on cannot do it. `Cache-Control: no-cache` is not a CORS-safelisted
 * request header, and the record gateway's preflight answers
 * `Access-Control-Allow-Headers` WITHOUT it (verified against the live api on
 * 2026-08-11), so a mint carrying that header is rejected by the browser before
 * it is ever sent. Every repair therefore failed, in every browser, and the chip
 * went straight to "(unavailable)". Only a phone noticed, because only a phone
 * drops image bodies often enough to need the repair at all.
 *
 * A query parameter has no such problem: it is part of the url, so it needs no
 * preflight and no cooperation from the cache.
 */
export function previewMintCacheToken(refresh?: boolean): string {
	if (!refresh) return String(MINT_CACHE_GENERATION);
	return MINT_CACHE_GENERATION + '.' + mintCacheBustStamp();
}

/**
 * How long before a presign dies we stop handing it out.
 *
 * A url served with one second left is a 403 with extra steps: the request still
 * has to reach S3, and an image body still has to start arriving.
 */
export var PRESIGN_SAFETY_MARGIN_MS = 60 * 1000;

/**
 * When the url in hand actually dies, read out of the url itself, or null if it
 * carries no expiry we recognise.
 *
 * Every client-side cache here ages a url from the moment it ARRIVED, which is
 * only the same thing as its lifetime when the mint went to the network. Once
 * mint responses are cacheable that assumption breaks: a mint answered from the
 * browser's store can be nearly as old as its own max-age, and the client then
 * adds its own reuse window on top, so a 20 minute credential can be handed to an
 * <img> half an hour after it was signed. Asking the url when it dies removes the
 * stacking instead of trying to budget for it.
 *
 * Both signature versions, because the platform mints SigV2 through the host
 * bucket and SigV4 elsewhere.
 */
export function presignExpiryEpochMs(url: string): number | null {
	if (!url) return null;
	var q = url.indexOf('?');
	if (q < 0) return null;
	var params: URLSearchParams;
	try { params = new URLSearchParams(url.slice(q + 1)); }
	catch (e) { return null; }

	// SigV2: Expires is an absolute epoch in seconds.
	var v2 = params.get('Expires');
	if (v2 && /^\d+$/.test(v2)) return parseInt(v2, 10) * 1000;

	// SigV4: signing time plus a duration.
	var signed = params.get('X-Amz-Date');
	var lifetime = params.get('X-Amz-Expires');
	if (signed && lifetime && /^\d+$/.test(lifetime)) {
		var m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(signed);
		if (m) {
			var at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
			return at + parseInt(lifetime, 10) * 1000;
		}
	}
	return null;
}

// The two "balanced parens" groups match ONE CHARACTER per step, never a `+`
// run, so each position has exactly one way to be matched: `[^()\n]` cannot
// start with `(`, and the nested-paren alternative always does. That disjointness
// is load-bearing, not style.
//
// The obvious spelling — `(?:[^()\n]+|\([^()\n]*\))+` — is a nested quantifier:
// a run of N plain characters can be split across the outer `+` in 2^N ways, and
// the engine tries EVERY one before it can conclude the branch failed. A branch
// fails on ordinary input: a link whose url contains a space (the url branch
// forbids spaces), a link broken across a newline, or a reply truncated
// mid-link. Measured on the unfixed pattern: `[label](` plus 30 characters with
// no closing paren took 62 SECONDS, 45 characters never finished. Since this
// regex is scanned over the whole reply by the typewriter (session.ts) and by
// every message render (parseMsgParts), that is a permanently frozen tab the
// moment such a message arrives. Same matches either way, linear time.
export function createInlineLinkRegex(): RegExp {
	return /src::(\S+)|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|\[([^\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)|(https?:\/\/[^\s<>"']+)/g;
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

export function extractRemotePathFromAttachmentHref(href: string, projectId: string): string | null {
	try {
		var parsed = new URL(href);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		var path = normalizeAttachmentPathCandidate(parsed.pathname || '');
		var segs = path.split('/').filter(Boolean);
		if (!segs.length) return null;
		var HEX = /^[a-f0-9]{32,}$/i;
		var sid = projectId || '';
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
// path always begins with the projectId segment (…/<projectId>/<hash>/<path>). Used
// to SAFELY sanitize assistant messages — where an arbitrary external citation URL
// must never be rewritten, only the service's own volatile db links.
export function isServiceDbAttachmentHref(href: string, projectId: string): boolean {
	if (!projectId) return false;
	try {
		var parsed = new URL(href);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
		var segs = normalizeAttachmentPathCandidate(parsed.pathname || '').split('/').filter(Boolean);
		return segs.length > 0 && segs[0] === projectId;
	} catch (e) { return false; }
}

/**
 * Read the storage path back out of an `_expired_.url` placeholder.
 *
 * The placeholder is not a display detail: sanitizeAttachmentLinksForHistory
 * writes it into PERSISTED history, and buildBoundedChatMessages replays it into
 * the model's context. So it round-trips constantly and MUST be recognised on the
 * way back in. Returns null for anything that is not the carrier.
 */
export function readExpiredAttachmentHref(href: string): string | null {
	if (!href) return null;
	try {
		var parsed = new URL(href);
		if (parsed.hostname !== EXPIRED_ATTACHMENT_URL_HOST) return null;
		return normalizeAttachmentPathCandidate(parsed.pathname || '') || null;
	} catch (e) { return null; }
}

// Replace volatile attachment URLs with their durable `_expired_.url/<path>`
// placeholder so a stored/replayed copy re-mints on demand instead of going stale.
//
// Only THIS service's db urls are rewritten, whichever role wrote them. The user
// branch used to rewrite every url in any message that carried an "Attached
// files:" block, which quietly destroyed a third-party link the user happened to
// paste in the same message: it became a placeholder for a storage path that
// never existed. We can only re-mint what we host, so we only rewrite what we
// host.
export function sanitizeAttachmentLinksForHistory(content: string, projectId: string, forAssistant?: boolean): string {
	if (!content) return content;
	if (!forAssistant && content.indexOf('Attached files:') === -1) return content;
	return content.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_m: string, label: string, href: string) {
		if (!isServiceDbAttachmentHref(href, projectId)) return _m;
		var remotePath = extractRemotePathFromAttachmentHref(href, projectId);
		var fullPath = remotePath || normalizeAttachmentPathCandidate(label);
		if (!fullPath) return _m;
		return '[' + label + '](' + buildDisplayExpiredAttachmentHref(fullPath, label) + ')';
	});
}

/**
 * Is this markdown link target a URL rather than a db storage path?
 *
 * The inline-link regex decides that by whether the target contains whitespace:
 * its url branch forbids it, its bare-path branch allows it (a db path really can
 * contain spaces). So a url that picked up a stray space anywhere in transit
 * falls out of the url branch and is claimed by the path branch, and the view
 * renders it as an `_expired_.url/https%3A/…` attachment chip that resolves to
 * nothing. The view asks this FIRST, so what a link IS never depends on damage.
 */
export function isHttpUrlLike(target: string): boolean {
	return /^https?:\/\//i.test((target || '').trim());
}

/**
 * Repair whitespace inside a url. RFC 3986 has no legal whitespace anywhere in a
 * URI, so a space in an href is always damage, never content.
 *
 * Two repairs, because the right one differs:
 *   - Our own `/download/<id>` capability links (skapi-mcp file-download.js) are
 *     base64url, optionally with a single `.` separating the payload and hmac of
 *     the older self-describing token. That alphabet cannot contain whitespace,
 *     so the spaces are purely damage and REMOVING them restores the exact link,
 *     which is what makes an already-sent message clickable again. A model
 *     reproducing one of these into its reply is exactly where the spaces come
 *     from, which is also why the id is now short.
 *   - Anything else keeps every character and only has the whitespace encoded,
 *     the same thing a browser does with a space in an href. Stripping would be
 *     wrong there: `…/exports/my report.csv` is a real file whose name has a
 *     space in it, and deleting it points at a file that does not exist.
 */
export function repairUrlWhitespace(href: string): string {
	if (!href || !/\s/.test(href)) return href;
	var stripped = href.replace(/\s+/g, '');
	if (/^https?:\/\/[^/\s]+\/download\/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/i.test(stripped)) return stripped;
	return href.trim().replace(/\s/g, '%20');
}

/**
 * A model reproducing a URL sometimes HTML-escapes its `&` query separators as
 * `&amp;` (or the numeric `&#38;` / `&#x26;`). Left in the href that escaping
 * survives the client's own escapeAttr -> v-html/innerHTML decode round-trip and
 * reaches the browser LITERALLY, so a presigned S3 URL is navigated with its
 * parameters named `amp;Signature`, `amp;Expires`, `amp;response-content-type`,
 * ... — the real params vanish, the signature can't be located, and S3 rejects
 * it (the "링크가 안되" dead export link). Undo just that entity escaping.
 *
 * This is a no-op on a clean URL: a valid link carries a raw `&` between params
 * and percent-encodes (`%26`) any literal ampersand that is data, so a real URL
 * never contains `&amp;` to begin with. Mirrors repairUrlWhitespace: it repairs
 * model damage, not the URL. The loop collapses a doubly-escaped `&amp;amp;` too.
 */
export function repairUrlEntities(href: string): string {
	if (!href || href.indexOf('&') === -1) return href;
	var out = href, prev = '';
	while (out !== prev) {
		prev = out;
		out = out
			.replace(/&amp;/gi, '&')
			.replace(/&#0*38;/g, '&')
			.replace(/&#x0*26;/gi, '&');
	}
	return out;
}

/**
 * Trim punctuation and unmatched wrappers that cling to a token in prose.
 * `src::a/b.pdf).` -> `src::a/b.pdf`, while a balanced `file (v2).pdf` is kept.
 */
export function normalizeTrailingInlineToken(value: string): string {
	if (!value) return value;
	var out = value.replace(/[.,;:!?]+$/, '');
	var trimUnmatched = function (openCh: string, closeCh: string) {
		while (out.charAt(out.length - 1) === closeCh) {
			var openCount = (out.match(new RegExp('\\' + openCh, 'g')) || []).length;
			var closeCount = (out.match(new RegExp('\\' + closeCh, 'g')) || []).length;
			if (closeCount > openCount) out = out.slice(0, -1); else break;
		}
	};
	trimUnmatched('(', ')');
	trimUnmatched('[', ']');
	trimUnmatched('{', '}');
	out = out.replace(/[`'"*>]+$/, '');
	return out;
}

/**
 * Extensions a BROWSER can paint in an <img>, mapped to the content type the
 * presign must declare.
 *
 * The content type is not optional here. get_signed_url only sets
 * ResponseContentType when the caller passes `contentType`, and otherwise falls
 * back to application/octet-stream, which a new tab DOWNLOADS instead of
 * displaying. Since the whole point of the preview is that clicking it shows the
 * picture, the mint has to name the real type.
 *
 * Deliberately narrower than the extraction/vision lists elsewhere in the repo:
 *   heic/heif out: Safari paints them, Chrome and Firefox show a broken image,
 *                  and it is the format every iPhone photo arrives in, so the
 *                  failure would be common and would read as a bug.
 *   tif/wmf/emf out: no mainstream browser paints them.
 *   svg        out: inside an <img> an SVG is script-disabled and safe, but this
 *                  feature's click target is a TOP-LEVEL navigation, where an
 *                  SVG executes its own <script> in the serving origin with that
 *                  origin's cookies, from user-uploaded content. A preview is an
 *                  invitation to click exactly that.
 */
export var PREVIEWABLE_IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
};

/** Extension of a path or url, query and fragment stripped, '' when none. */
export function previewableExtOf(nameOrPath: string | null | undefined): string {
	var v = String(nameOrPath || '');
	// A storage path may legally contain '?', so this cannot reuse extOf().
	var cut = v.search(/[?#]/);
	if (cut !== -1) v = v.slice(0, cut);
	v = v.replace(/[\\/]+$/, '');
	var dot = v.lastIndexOf('.');
	if (dot <= 0) return '';
	var ext = v.slice(dot + 1).trim().toLowerCase();
	return /^[a-z0-9]+$/.test(ext) ? ext : '';
}

export function isPreviewableImagePath(nameOrPath: string | null | undefined): boolean {
	return !!PREVIEWABLE_IMAGE_CONTENT_TYPES[previewableExtOf(nameOrPath)];
}

/** Content type to hand the presign so a new tab displays rather than downloads. */
export function previewImageContentType(nameOrPath: string | null | undefined): string | null {
	return PREVIEWABLE_IMAGE_CONTENT_TYPES[previewableExtOf(nameOrPath)] || null;
}

/** A link the view renders. `expired` means the href is the `_expired_.url`
 *  placeholder and a click must mint a fresh one from `remotePath`. */
export interface InlineLinkPart {
	type: 'link';
	label: string;
	fullLabel: string;
	href: string;
	expired: boolean;
	expiredHref?: string;
	remotePath?: string;
	/**
	 * Set only for a file WE host whose PATH says a browser can paint it. Its
	 * presence IS the "render a preview" decision, so a view never re-tests the
	 * label and never tests `href` (which is the _expired_.url placeholder).
	 */
	image?: { ext: string; contentType: string };
}

export interface InlineLinkContext {
	/** Current project id: the leading segment to strip off a db url. */
	projectId: string;
	/** `https://db.<hostDomain>` for this deployment. */
	dbHostPrefix: string;
	/** A fresh url already minted for this placeholder, if the view cached one. */
	resolveFreshHref?: (expiredHref: string) => string | undefined;
}

/**
 * Decide what ONE inline-link regex match actually is, and how to render it.
 *
 * This is the single place that answers "is this an external url, this project's
 * db file, or a bare storage path", for every consumer. It used to live twice,
 * once in agent.vue and once in the widget, and both copies had to be found and
 * corrected for each of the link bugs this file's history records. A view now
 * supplies its own context (project id, db host, cached-href lookup) and does
 * nothing but turn the returned part into markup.
 *
 * `groups` is [g1..g6] from createInlineLinkRegex, in that order:
 *   g1 src::<token>   g2/g3 [label](url)   g4/g5 [label](path)   g6 bare url
 */
export function classifyInlineLink(
	full: string,
	groups: Array<string | undefined>,
	ctx: InlineLinkContext,
): { part: InlineLinkPart; tail?: string } | null {
	var g1 = groups[0], g2 = groups[1], g3 = groups[2], g4 = groups[3], g5 = groups[4], g6 = groups[5];
	var dbHostPrefix = (ctx.dbHostPrefix || '').toLowerCase();
	var fresh = function (expiredHref: string): string | undefined {
		return ctx.resolveFreshHref ? ctx.resolveFreshHref(expiredHref) : undefined;
	};
	var isDbHost = function (url: string): boolean {
		return !!dbHostPrefix && url.toLowerCase().indexOf(dbHostPrefix) === 0;
	};
	// A db path rendered as the placeholder the click handler resolves.
	var asStoredFile = function (remotePath: string, label: string): { part: InlineLinkPart } | null {
		if (!remotePath) return null;
		var expiredHref = buildDisplayExpiredAttachmentHref(remotePath, label);
		var cached = fresh(expiredHref);
		var part: InlineLinkPart = {
			type: 'link',
			label: truncateLabelForDisplay(label),
			fullLabel: label,
			href: cached || expiredHref,
			expired: !cached,
			expiredHref: expiredHref,
			remotePath: remotePath,
		};
		// The PATH decides, never the label. The file is fetched by path, so the
		// path is the only claim with consequences: a model-written label reading
		// "chart.png" on a .xlsx would otherwise mint a url and paint a broken box.
		var ext = previewableExtOf(remotePath);
		var ct = PREVIEWABLE_IMAGE_CONTENT_TYPES[ext];
		if (ct) part.image = { ext: ext, contentType: ct };
		return { part: part };
	};

	// src::<token> — a path, or a url the model copied out of a record.
	if (g1) {
		var rawPath = normalizeTrailingInlineToken(g1);
		var tail = full.slice(('src::' + rawPath).length);
		var srcIsUrl = isHttpUrlLike(rawPath);
		// `src::` values come straight out of a record's unique_id, and the prompt
		// says that may be "the file's storage path or original URL". http:// is as
		// much a url as https://; testing only for https sent every plain-http
		// source into the storage-path branch, where it became a chip pointing at
		// this project for someone else's file.
		if (srcIsUrl && !isDbHost(rawPath) && !readExpiredAttachmentHref(rawPath)) {
			// decode any model-introduced `&amp;` in the URL (tail stays keyed on
			// the raw match length, so it is left untouched)
			var srcUrl = repairUrlEntities(rawPath);
			return {
				part: { type: 'link', label: truncateLabelForDisplay(srcUrl), fullLabel: srcUrl, href: srcUrl, expired: false },
				tail: tail,
			};
		}
		var srcPath = readExpiredAttachmentHref(rawPath)
			|| (srcIsUrl
				? (extractRemotePathFromAttachmentHref(rawPath, ctx.projectId) || normalizeAttachmentPathCandidate(rawPath))
				// bare stored path: same NON-decoding normalize as the db: branch; only
				// URL-derived paths genuinely arrive percent-encoded.
				: rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/'));
		var srcBuilt = asStoredFile(srcPath, srcPath);
		return srcBuilt ? { part: srcBuilt.part, tail: tail } : null;
	}

	// [label](target) where target is NOT a url by the regex's reckoning.
	if (g4 && g5) {
		// An EXPLICIT db target, `[label](db:folder/file.csv)`, says what it is
		// instead of leaving us to infer it from the absence of "http". That is the
		// only form here that cannot be confused with anything else, and it matches
		// the scheme the backend already uses internally (db:<service>/<key>).
		// Accepted now so the clients tolerate it everywhere before anything starts
		// EMITTING it; until then this branch simply never fires.
		var dbTarget = /^db:(.+)$/i.exec(g5.trim());
		if (dbTarget) {
			// NON-decoding normalize: the prompt guarantees a db: target is the path exactly
			// as stored, NOT url-encoded, and the MCP's own key builder refuses to decode
			// bare paths for the same corruption: percent-decoding here turned a stored name
			// containing a literal "%20" into the wrong key.
			var rawDbPath = dbTarget[1].trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
			var declared = asStoredFile(rawDbPath, g4);
			if (!declared) return null;
			declared.part.label = truncateLabelForDisplay(g4);
			declared.part.fullLabel = g4;
			return declared;
		}
		// ...except when it is one. It only lands here because it contains
		// whitespace, which the url branch forbids and this one allows, and
		// reading a damaged url as a storage path is how a download link became a
		// dead chip. Repair it and classify it as what it is.
		if (isHttpUrlLike(g5)) {
			return classifyInlineLink(full, [undefined, g4, repairUrlWhitespace(g5), undefined, undefined, undefined], ctx);
		}
		// Any OTHER scheme, or a fragment, is a link the user wrote and not a file
		// we host. `mailto:`, `tel:` and `#section` were all being turned into
		// download chips for storage paths of that literal text, so clicking one
		// asked this project for a file called "mailto:a@b.com".
		var trimmedTarget = g5.trim();
		if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedTarget) || trimmedTarget.charAt(0) === '#') {
			return {
				part: { type: 'link', label: truncateLabelForDisplay(g4), fullLabel: g4, href: trimmedTarget, expired: false },
			};
		}
		var built = asStoredFile(normalizeAttachmentPathCandidate(g5), g4);
		if (!built) return null;
		// The label is the model's, not the path: keep it verbatim.
		built.part.label = truncateLabelForDisplay(g4);
		built.part.fullLabel = g4;
		return built;
	}

	// [label](url) and bare urls.
	var originalHref = g3 || g6 || '';
	if (!originalHref) return null;
	// A model that reproduces the URL may have HTML-escaped its `&` separators;
	// decode them now so every downstream check and the final href see a clean
	// URL (otherwise a presigned link navigates with `&amp;` and 403s).
	originalHref = repairUrlEntities(originalHref);
	// A bare url swallows the punctuation that ends the sentence it sits in, so
	// `see https://host/a.pdf.` linked to `a.pdf.` and 404'd. Trim it and hand the
	// trimmed text back as `tail`, exactly as the src:: branch does.
	var urlTail: string | undefined;
	if (!g3 && g6) {
		var trimmedUrl = normalizeTrailingInlineToken(originalHref);
		if (trimmedUrl !== originalHref) urlTail = originalHref.slice(trimmedUrl.length);
		originalHref = trimmedUrl;
	}
	var withTail = function (r: { part: InlineLinkPart }): { part: InlineLinkPart; tail?: string } {
		return urlTail ? { part: r.part, tail: urlTail } : r;
	};
	var urlLabel = g2 || originalHref;

	// THE PLACEHOLDER, read back. sanitizeAttachmentLinksForHistory writes this
	// form into stored history and buildBoundedChatMessages replays it to the
	// model, so it arrives here constantly: as a rebuilt bubble on every reload,
	// and as text the model copied out of its own context. It has to be checked
	// BEFORE the generic https branch, because it IS https and it is NOT the db
	// host, so that branch claimed it and rendered `expired: false` — a link to a
	// hostname that does not resolve, with no way to ever refresh it. Every stored
	// attachment link went dead on reload for exactly that reason.
	var carried = readExpiredAttachmentHref(originalHref);
	if (carried) {
		var carriedBuilt = asStoredFile(carried, g2 || carried);
		if (carriedBuilt) {
			if (g2) { carriedBuilt.part.label = truncateLabelForDisplay(g2); carriedBuilt.part.fullLabel = g2; }
			return withTail(carriedBuilt);
		}
	}

	// This project's own db url: volatile, so render it re-mintable. A db url for
	// a DIFFERENT project is not ours to mint, so it stays an ordinary link rather
	// than a chip that would query this project for someone else's key.
	if (isServiceDbAttachmentHref(originalHref, ctx.projectId)) {
		var remotePath = extractRemotePathFromAttachmentHref(originalHref, ctx.projectId);
		if (remotePath) {
			var dbBuilt = asStoredFile(remotePath, getExpiredAttachmentVisiblePath(remotePath, urlLabel));
			if (dbBuilt) return withTail(dbBuilt);
		}
	}

	// Everything else is a link, not a path. The old rule tested for `https://`
	// specifically and treated ANY other target as db storage, so a plain
	// `http://` citation, a `mailto:`, a `#anchor` and a `/relative` link all
	// rendered as download chips for storage paths that never existed, and
	// clicking one raised "failed to refresh" on a file the user never had.
	return withTail({
		part: { type: 'link', label: truncateLabelForDisplay(urlLabel), fullLabel: urlLabel, href: originalHref, expired: false },
	});
}

/**
 * "We asked for a url for this file and did not get one."
 *
 * A chip the client cannot mint a url for is not a link: the ↗ is a promise it
 * already knows it cannot keep, and clicking it opens a dead tab or nothing at
 * all. Both views therefore keep a map of failures and render those chips
 * unavailable (renderInlineLinkHtml's `unavailable` option): greyed, ✕ instead
 * of ↗, no href.
 *
 * The MAP lives in the view (agent.vue has to re-render when it changes, and
 * that means a ref), so only the keys are here. A failure is reported with
 * exactly one identifier (an image preview knows the storage path, a click knows
 * the placeholder href), so marking writes one key and the lookup tries all of
 * them.
 */
/**
 * Unicode form is not stable across the places a storage path travels through.
 *
 * macOS hands the browser a DECOMPOSED (NFD) filename, so a Korean name like
 * 운전면허-김대현.jpg arrives as 24 codepoints where the composed (NFC) form is 12.
 * Nothing in this engine normalized either way, so the SAME file could be keyed under
 * two different strings depending on which path it travelled: a mark left by a failed
 * mint under one form would never be cleared by a successful load under the other, and
 * the chip stayed greyed out as "(unavailable)" forever.
 *
 * NFC is the canonical choice: it is what the Unicode standard recommends for
 * interchange, and it is the shorter, more common form on the wire.
 */
export function canonicalizePathForm(value: string): string {
	if (!value) return value;
	try { return value.normalize('NFC'); } catch (e) { return value; }
}

export function linkUnavailableKeyForPath(remotePath: string): string {
	// Canonicalized so the NFC and NFD spellings of one file share ONE key.
	return 'path:' + canonicalizePathForm(remotePath || '');
}

export function linkUnavailableKeyForHref(href: string): string {
	// An `_expired_.url` placeholder carries the storage path percent-encoded, so NFC and
	// NFD spellings of one file produce two different href strings and therefore two
	// different keys. Route those through the path key instead, so a file has ONE key
	// however it is spelled and whichever carrier it arrived on.
	var carried = readExpiredAttachmentHref(href);
	if (carried) return linkUnavailableKeyForPath(carried);
	return 'href:' + canonicalizePathForm(href || '');
}

/**
 * Every key a stored file can be marked under, given only its path.
 *
 * Marking writes ONE key (whichever identifier the failing call had) and the
 * lookup ORs all of them, which is fine in one direction and wrong in the other:
 * a view that later learns the file is reachable knows only the path, and
 * clearing `path:` alone leaves a chip greyed by a failed CLICK (which marks
 * `href:` too) exactly as dead as before. The placeholder href is derived from
 * the path, so both keys can be rebuilt from it.
 */
export function linkUnavailableKeysForPath(remotePath: string): string[] {
	if (!remotePath) return [];
	var keys = [
		linkUnavailableKeyForPath(remotePath),
		linkUnavailableKeyForHref(buildDisplayExpiredAttachmentHref(remotePath)),
	];
	// Both now canonicalize to the same key for a placeholder href, so drop the duplicate
	// rather than marking and clearing the same entry twice.
	return keys.filter(function (k, i) { return keys.indexOf(k) === i; });
}

export function isLinkUnavailable(
	link: { href?: string; expiredHref?: string; remotePath?: string } | null | undefined,
	map: Record<string, boolean | undefined> | null | undefined,
): boolean {
	if (!link || !map) return false;
	if (link.remotePath && map[linkUnavailableKeyForPath(link.remotePath)]) return true;
	if (link.expiredHref && map[linkUnavailableKeyForHref(link.expiredHref)]) return true;
	if (link.href && map[linkUnavailableKeyForHref(link.href)]) return true;
	return false;
}

export function truncateLabelForDisplay(label: string): string {
	if (!label) return label;
	if (label.length <= LINK_LABEL_MAX_DISPLAY_CHARS) return label;
	return '…' + label.slice(label.length - (LINK_LABEL_MAX_DISPLAY_CHARS - 1));
}
