/**
 * The chip / preview markup for one classified inline link.
 *
 * `classifyInlineLink` was consolidated into the engine because deciding what a
 * link IS had drifted between the two clients and every link bug had to be found
 * and fixed twice. The EMITTER stayed forked, byte for byte identical in
 * agent.vue and the widget. The image preview is the first behaviour that would
 * have had to be written twice, so the emitter moves here too.
 *
 * Pure string in, pure string out: no DOM, no globals, nothing reactive. That is
 * what lets agent.vue keep memoizing parseMsgParts on the message text alone.
 */

/** Neither client sanitizes bubble HTML (no DOMPurify, no marked sanitize), so
 *  everything interpolated here is escaped at the point of interpolation. */
export function escapeInlineHtml(v: string | null | undefined): string {
	return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
		return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[ch];
	});
}

/**
 * Previews per MESSAGE. Each one costs a presign call and an image download the
 * moment it is hydrated, and a reply listing a folder can name dozens. Past this
 * many the link renders as the ordinary text chip.
 */
export var IMAGE_PREVIEWS_PER_MESSAGE = 8;

/**
 * The glyph IS the promise: ↗ says "click this and the file opens". When the
 * client could not get a url for the file, keeping that glyph on a chip it knows
 * is dead is the bug: the click either opens a tab on a 403/404 or, once the
 * href is gone, does nothing at all with no explanation. ✕ says what happened.
 */
export var INLINE_LINK_GLYPH = '↗';
export var INLINE_LINK_UNAVAILABLE_GLYPH = '✕';
export var INLINE_LINK_UNAVAILABLE_SUFFIX = ' (unavailable)';

/** Widened so each client's local link-part type is assignable. */
export interface RenderableInlineLink {
	label: string;
	fullLabel?: string;
	href: string;
	expired: boolean;
	expiredHref?: string;
	remotePath?: string;
	image?: { ext: string; contentType: string };
}

export interface InlineLinkMarkupOptions {
	/** The view's own "a mint is in flight for this href" flag. */
	refreshing?: boolean;
	/** False once the caller has spent its per-message preview budget. */
	allowImagePreview?: boolean;
	/**
	 * The view already tried to get a url for this file and failed (see
	 * isLinkUnavailable). Renders a dead chip: ✕, greyed, no href.
	 */
	unavailable?: boolean;
}

export function renderInlineLinkHtml(link: RenderableInlineLink, opts?: InlineLinkMarkupOptions): string {
	var o = opts || {};
	var unavailable = !!o.unavailable;
	// A dead chip is never also "fetching...": the mint that would have cleared
	// that state is the one that failed.
	var refreshing = !unavailable && !!o.refreshing;
	var full = link.fullLabel || link.label;
	// No preview either. The <img> hides itself when its url fails, but a
	// re-render emits a FRESH element with no state, so leaving the preview in
	// would re-mint and re-fail once per render for the rest of the session.
	var preview = !!link.image && !!link.remotePath && o.allowImagePreview !== false && !unavailable;

	var cls = ['bq-link-button'];
	if (link.expired) cls.push('is-expired');
	if (refreshing) cls.push('is-refreshing');
	if (unavailable) cls.push('is-unavailable');
	if (preview) cls.push('is-image-preview');

	var labelText = (unavailable ? INLINE_LINK_UNAVAILABLE_GLYPH : INLINE_LINK_GLYPH) + ' ' + link.label
		+ (unavailable ? INLINE_LINK_UNAVAILABLE_SUFFIX : refreshing ? ' (fetching...)' : '');
	var attrs = ['class="' + cls.join(' ') + '"'];
	// NO href when the file is unavailable. That is what disables the click:
	// an anchor with no href does not navigate, is not a tab stop and takes the
	// default cursor, so nothing else has to remember to swallow the event.
	if (unavailable) attrs.push('aria-disabled="true"', 'data-bq-unavailable="1"');
	else attrs.push('href="' + escapeInlineHtml(link.href) + '"', 'target="_blank"', 'rel="noopener noreferrer"');
	attrs.push('title="' + escapeInlineHtml(unavailable ? full + INLINE_LINK_UNAVAILABLE_SUFFIX : full) + '"');
	// `download` is ignored cross-origin and forces a save same-origin. On a
	// preview it states the wrong intent: the user clicked a picture to LOOK at
	// it. Every other chip keeps the attribute exactly where it was.
	if (!preview && !unavailable) attrs.push('download="' + escapeInlineHtml(full) + '"');
	attrs.push('data-bq-link="1"');
	// Deliberately NOT marked expired: `data-bq-expired` is what tells the
	// delegated click handler to mint a fresh url, and this is the chip whose
	// mint just failed.
	if (link.expired && !unavailable) attrs.push('data-bq-expired="1"');
	if (link.expiredHref) attrs.push('data-bq-expired-href="' + escapeInlineHtml(link.expiredHref) + '"');
	if (link.remotePath) attrs.push('data-bq-remote-path="' + escapeInlineHtml(link.remotePath) + '"');
	if (link.fullLabel) attrs.push('data-bq-full-label="' + escapeInlineHtml(link.fullLabel) + '"');

	if (!preview) return '<a ' + attrs.join(' ') + '>' + escapeInlineHtml(labelText) + '</a>';

	// NO src attribute. A stored file always classifies as the _expired_.url
	// placeholder until something mints a real url, so a src written here would be
	// a guaranteed broken image on every reload. The element carries the PATH and
	// hydrateImagePreviews fills the src in a DOM pass that runs after render.
	//
	// The caption is not decoration, it is the FALLBACK: if the url dies or the
	// file is gone the <img> hides itself and what is left is exactly the text
	// chip this feature replaced, still clickable.
	return '<a ' + attrs.join(' ') + '>' +
		'<img class="bq-img-preview" alt="' + escapeInlineHtml(full) + '"' +
		' data-bq-img-path="' + escapeInlineHtml(link.remotePath || '') + '"' +
		' data-bq-img-type="' + escapeInlineHtml(link.image ? link.image.contentType : '') + '"' +
		// decoding="async" but NOT loading="lazy". Lazy guarantees the bytes arrive
		// exactly when the image is near the viewport, which is the one case the
		// scroll anchor deliberately declines to compensate for (growth at or below
		// the fold happened on screen, under a line the reader is looking at) — so it
		// shoved up to 320px of text under their eyes on every scroll toward it. It
		// saved no mint either: hydration mints for every preview in the DOM
		// regardless of viewport. It was also what turned the widget's per-notify
		// teardown into a 13x amplifier (6224px vs 450px measured).
		' decoding="async">' +
		// Minting the url is a network round trip before the image even starts
		// downloading, so the wait is real and needs a state. Inline load, so the
		// dot trail, never the jumping bunny. CSS hides it the moment the <img>
		// gains a src, so no JS removes DOM and nothing re-parses.
		'<span class="bq-loader" data-bq-img-loader="1"></span>' +
		'<span class="bq-img-preview-caption" translate="no">' + escapeInlineHtml(labelText) + '</span>' +
		'</a>';
}
