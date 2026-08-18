/**
 * Hold the reader's place in the message list.
 *
 * A chat box mutates constantly WITHOUT the reader asking for it: an older page
 * prepends, a poll resolves, an indexing row splices in or changes label, a link
 * chip goes grey, an image preview finishes decoding, the "Fetching history..."
 * bar appears and disappears. Every one of those changes the height of something
 * that may sit ABOVE the viewport, and the browser answers by keeping scrollTop —
 * which slides the sentence the user was reading out from under them.
 *
 * Both clients had their own copy of a row anchor for the ONE case each could
 * bracket (agent.vue watched its row-key list, the widget bracketed its full
 * re-render). Everything else — anything that changed a height without changing
 * the row SET, and everything asynchronous — was uncovered in both. This is the
 * single implementation, and it covers both shapes:
 *
 *   preserve(fn) / capture() + restore(a)
 *       A mutation you can bracket. Measures immediately before and immediately
 *       after, so it is exact even when the mutation tears the list down.
 *
 *   remember() + hold()
 *       A layout change you CANNOT bracket — an image decoding, a font arriving,
 *       a re-parse triggered from a promise. `remember()` runs from the view's
 *       scroll handler, so the anchor is always the reader's own last position;
 *       `hold()` puts that position back whenever something settles.
 *
 * The staleness rule is what makes the unbracketed half safe. A layout change
 * above the viewport does NOT change scrollTop — the browser preserves it, which
 * is precisely why the content appears to jump. So a remembered anchor is still
 * valid exactly while `box.scrollTop` equals the value it was captured at. If it
 * differs, something moved the box on purpose (the user scrolled, a clamp fired,
 * or the browser's own scroll anchoring already compensated), and `hold()`
 * re-captures rather than dragging the reader back to a position they left.
 *
 * DOM-free like the rest of the engine: the element shapes below are structural,
 * so real DOM nodes satisfy them while this file imports nothing from lib.dom.
 */

export interface AnchorRect {
	top: number;
}

export interface AnchorRowEl {
	getAttribute(name: string): string | null;
	getBoundingClientRect(): AnchorRect;
	offsetHeight: number;
	parentNode: unknown;
}

/** Anything inside the list that resizes on its own schedule. See absorb(). */
export interface AnchorGrowableEl {
	getBoundingClientRect(): AnchorRect;
	offsetHeight: number;
}

export interface AnchorBoxEl {
	children: ArrayLike<AnchorRowEl>;
	getBoundingClientRect(): AnchorRect;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

export interface RowAnchor {
	/** data-row-key of the anchored row, or null when nothing was anchorable. */
	key: string | null;
	/** Offset of that row from the top of the viewport. Negative above the fold. */
	top: number;
	/** data-row-pos, present only on rows that can RELOCATE (see below). */
	pos: string | null;
	/** scrollTop at capture time. The staleness check, and the raw fallback. */
	scrollTop: number;
	/**
	 * scrollHeight at capture time. How much the list GREW is the best available
	 * answer when the anchored row itself cannot be found again, and the bound on
	 * how far a correction can legitimately be.
	 */
	scrollHeight: number;
	/**
	 * The anchored element itself. A view that patches in place (Vue) keeps the
	 * same node across an update, so restore is one rect read instead of a scan;
	 * a view that rebuilds the list (the widget) drops it and falls back to the
	 * key. Never trusted without re-checking that it is still in the box.
	 */
	el: AnchorRowEl | null;
}

export interface ScrollAnchorOptions {
	/** The scrolling message box, or null when it is not mounted. */
	getBox: () => AnchorBoxEl | null;
	/**
	 * The reader is pinned to the bottom. There the bottom IS the anchor and the
	 * scrollToBottom* paths own the position, so every method here no-ops.
	 */
	isStuck: () => boolean;
	/**
	 * Fall back to the raw scrollTop when the anchored row cannot be found again.
	 *
	 * For a view that REBUILDS the list (the widget's renderMessages), detaching
	 * every child collapses scrollHeight and the browser clamps scrollTop to 0,
	 * so the raw offset is strictly better than the clamp it would otherwise be
	 * left with. For a view that patches in place (Vue) the browser has already
	 * kept a sane position and re-imposing a stale offset is worse than nothing.
	 */
	rawFallback?: boolean;
}

export interface ScrollAnchor {
	/** Measure the reader's current place. Null while pinned to the bottom. */
	capture: () => RowAnchor | null;
	/** Put a captured place back. Safe to call with null. */
	restore: (anchor: RowAnchor | null) => void;
	/** capture -> mutate -> restore, for a mutation you can bracket. */
	preserve: <T>(mutate: () => T) => T;
	/** Record the reader's place. Call from the box's scroll handler. */
	remember: () => void;
	/** Put the remembered place back, if it is still the reader's own. */
	hold: () => void;
	/** Absorb one element's own resize. See below. */
	absorb: (el: AnchorGrowableEl | null | undefined) => void;
	/** Drop the remembered place (chat switch, unmount). */
	forget: () => void;
}

/**
 * A row is anchorable when it carries data-row-key. The bars that are not rows —
 * "Fetching history...", the greeting, the drafting bubble, an expanded group's
 * trailing loader — deliberately carry none, so they are never anchored ON while
 * still being fully covered BY the anchor: they change height above a row that
 * is held in place, and holding it is what absorbs them.
 */
var ROW_KEY_ATTR = 'data-row-key';
/**
 * A collapsed indexing row names the turn it currently renders at. It is a WEAK
 * anchor because it can RELOCATE — an older page carrying earlier passes of the
 * same run moves the row itself — and pinning a row while it moves is what would
 * drag the reader along with it. So an ordinary message row is always preferred,
 * and a group row is used only when nothing else is on screen, and then only if
 * it did not move.
 */
var ROW_POS_ATTR = 'data-row-pos';
/** data-row-pos is present but empty: the row cannot say where it is anchored. */
var UNKNOWN_ROW_POS = '\u0000?';

export function createScrollAnchor(options: ScrollAnchorOptions): ScrollAnchor {
	var held: RowAnchor | null = null;
	// Per-element height, so absorb() needs no "before" call from the caller.
	// Weak on purpose: a re-render throws every row away and a strong map would
	// hold the whole conversation's DOM alive behind it.
	var seen: WeakMap<object, number> | null =
		typeof WeakMap === 'function' ? new WeakMap<object, number>() : null;

	function capture(): RowAnchor | null {
		var box = options.getBox();
		if (!box || options.isStuck()) return null;
		var boxTop = box.getBoundingClientRect().top;
		var kids = box.children;
		var fallback: RowAnchor | null = null;
		for (var i = 0; i < kids.length; i++) {
			var el = kids[i];
			if (!el || typeof el.getAttribute !== 'function') continue;
			var key = el.getAttribute(ROW_KEY_ATTR);
			if (!key) continue;
			var top = el.getBoundingClientRect().top - boxTop;
			// Rows still (partly) on screen. `top` is negative when a row starts
			// above the fold, which is exactly the offset to preserve.
			if (top + el.offsetHeight <= 0) continue;
			// And STOP at the bottom of the viewport. Without this the preference
			// for an ordinary row walks straight past a screenful of collapsed
			// indexing rows and anchors on a message two screens down — which is
			// not the reader's place, and holds the wrong thing when a row between
			// the two changes height.
			if (top >= box.clientHeight) break;
			// An EMPTY data-row-pos means "this row cannot say where it is anchored
			// yet" — a run:: stub has no anchorId until its real group loads. Treating
			// "" as a position made every stub -> real-group handoff read as a
			// relocation and abort the anchor, which is a background resolution that
			// happens on every fresh open. Empty is normalised to null, which also
			// keeps such a row from being MISTAKEN for an ordinary one: the
			// ordinary/group split is the attribute's PRESENCE, tested first.
			var rawPos = el.getAttribute(ROW_POS_ATTR);
			var pos = rawPos === null ? null : (rawPos || UNKNOWN_ROW_POS);
			var cand: RowAnchor = {
				key: key, top: top, pos: pos,
				scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, el: el,
			};
			if (rawPos === null) return cand;   // an ordinary row: use it
			if (!fallback) fallback = cand;  // a group row: only if nothing better
		}
		return fallback || {
			key: null, top: 0, pos: null,
			scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, el: null,
		};
	}

	function findRow(box: AnchorBoxEl, anchor: RowAnchor): AnchorRowEl | null {
		// The same node, still in the box: one rect read instead of a scan. Vue
		// patches keyed rows in place, so this is the common path there, and it is
		// what keeps a per-update hold() cheap enough to run on every update.
		var el = anchor.el;
		if (el && el.parentNode === (box as unknown)) return el;
		if (!anchor.key) return null;
		var kids = box.children;
		for (var i = 0; i < kids.length; i++) {
			var kid = kids[i];
			if (!kid || typeof kid.getAttribute !== 'function') continue;
			if (kid.getAttribute(ROW_KEY_ATTR) === anchor.key) return kid;
		}
		return null;
	}

	function restore(anchor: RowAnchor | null): void {
		var box = options.getBox();
		if (!box || !anchor || options.isStuck()) return;
		var el = findRow(box, anchor);
		if (el) {
			// A row that MOVED (an older page re-anchored a collapsed run to its
			// true first pass) must not be pinned: doing so would drag the reader
			// along with it, to wherever the run now starts.
			// Only compare when BOTH sides actually name a turn. A stub that has since
			// learned its anchorId (or lost it) has not moved; it has just started (or
			// stopped) being able to answer.
			var livePos = el.getAttribute(ROW_POS_ATTR) || UNKNOWN_ROW_POS;
			if (anchor.pos !== null && anchor.pos !== UNKNOWN_ROW_POS &&
				livePos !== UNKNOWN_ROW_POS && livePos !== anchor.pos) {
				lost(box, anchor);
				return;
			}
			var boxTop = box.getBoundingClientRect().top;
			var delta = (el.getBoundingClientRect().top - boxTop) - anchor.top;
			// A row can also be MOVED rather than resized: a background refetch
			// that merges a run's passes into the middle of page 1 relocates the
			// bubble this anchor is holding, and following it would carry the
			// reader across the conversation. A real prepend or in-place growth
			// can only ever need a correction on the order of what the list gained,
			// so a delta a whole screen beyond that is a relocation, not a resize.
			var slack = Math.abs(box.scrollHeight - anchor.scrollHeight) + box.clientHeight;
			if (delta > slack || delta < -slack) { lost(box, anchor); return; }
			// Sub-pixel noise is not a jump, and writing scrollTop for it costs a
			// scroll event (and a re-layout) on every settle.
			if (delta >= 1 || delta <= -1) box.scrollTop += delta;
			// This position is now the reader's place, and hold() has to know it:
			// a bracketed restore MOVES scrollTop, which is exactly what hold()
			// reads as "someone scrolled, my anchor is stale". Without this, every
			// image that decodes after a re-render (which is all of them: the list
			// is rebuilt with src-less, zero-height previews and hydrated
			// afterwards) would find a stale anchor and go uncompensated.
			held = {
				key: anchor.key, top: anchor.top, pos: anchor.pos,
				scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, el: el,
			};
			return;
		}
		// The anchor row is gone: its group collapsed, or the history was replaced.
		lost(box, anchor);
	}

	/**
	 * The anchored row cannot be held: it is gone, or it relocated.
	 *
	 * What is still known is how much the list GREW, and in the case this branch
	 * exists for — the pager, whose page can carry the very pass that re-anchors a
	 * collapsed row — all of that growth is above the reader. So pay it. Missing it
	 * costs the reader a whole page of history in one jump, which is the single
	 * most visible version of this bug.
	 *
	 * With nothing gained there is nothing to pay, and then the two views differ:
	 * one REBUILDS the list (its teardown clamped scrollTop to 0, so the raw offset
	 * beats the clamp) and one patches in place (the browser already kept a sane
	 * position, so re-imposing a stale offset is worse than nothing).
	 */
	function lost(box: AnchorBoxEl, anchor: RowAnchor): void {
		held = null;
		var grew = box.scrollHeight - anchor.scrollHeight;
		if (grew > 0) { box.scrollTop = anchor.scrollTop + grew; return; }
		if (options.rawFallback) box.scrollTop = anchor.scrollTop;
	}

	function preserve<T>(mutate: () => T): T {
		var anchor = capture();
		var result = mutate();
		restore(anchor);
		return result;
	}

	function remember(): void {
		held = capture();
	}

	function hold(): void {
		var box = options.getBox();
		if (!box || options.isStuck()) { held = null; return; }
		if (!held) { held = capture(); return; }
		// Something moved the box on purpose since the anchor was taken — the user
		// scrolled, a shrink clamped it, or the browser's own scroll anchoring
		// already compensated. Restoring here would undo a move the reader made or
		// double-count one already made for us, so re-measure instead.
		if (box.scrollTop !== held.scrollTop) { held = capture(); return; }
		// restore() re-stamps `held` with the position it just pinned, so repeated
		// holds (one image after another finishing) each start from a valid anchor.
		restore(held);
	}

	/**
	 * Absorb a resize made by ONE element, wherever it sits.
	 *
	 * The row anchor cannot see this case. A reader partway through an assistant
	 * reply that is taller than the viewport is anchored ON that row, and a
	 * picture decoding higher up INSIDE it moves every line they are reading
	 * without moving the row's own top by a pixel. Rows above the fold have the
	 * same problem in reverse: hold() would fix them, but it cannot be allowed to
	 * run for an image as well or the two would each pay the same debt.
	 *
	 * So images go through here instead, and it is the more precise of the two:
	 * it compensates by the element's own height delta, and only while the
	 * element's TOP is above the fold — which is exactly the condition for
	 * "everything the reader can see just moved by this much". An element that
	 * starts at or below the fold is left alone: it grew on screen, under a line
	 * the reader is looking at, and moving them is what would be the jump.
	 *
	 * The height it last saw is remembered per element, so the caller does not
	 * have to bracket anything. An element it has never seen counts as zero,
	 * which is what an <img> measures before it has anything to paint — including
	 * the markdown `![alt](url)` images that have no hydration hook at all.
	 */
	function absorb(el: AnchorGrowableEl | null | undefined): void {
		if (!el) return;
		var box = options.getBox();
		if (!box) return;
		var h = el.offsetHeight;
		var prev = seen ? seen.get(el) : undefined;
		if (seen) seen.set(el, h);
		if (options.isStuck()) return;
		if (prev === undefined) prev = 0;
		var delta = h - prev;
		if (delta === 0) return;
		// The element's own TOP, which a resize never moves: everything BELOW it
		// slides by delta, everything above stays. So the reader's first visible
		// line moved exactly when that top is above the fold — whether the element
		// grew, collapsed, or straddles the fold now that it has grown. When the
		// top is at or below the fold the growth happens on screen, at or under a
		// line the reader is looking at, and moving them would be the jump.
		if (el.getBoundingClientRect().top >= box.getBoundingClientRect().top) return;
		box.scrollTop += delta;
		// Re-measure the remembered anchor, do not patch it. Its scrollTop is
		// stale after that write (hold() would read the difference as "the reader
		// scrolled" and throw the anchor away), and so is its offset whenever the
		// element that just resized lives INSIDE the anchored row: there the row's
		// own top never moved, so scrolling by delta changed the row's offset by
		// -delta and the next hold() would faithfully undo this correction.
		if (held) held = capture();
	}

	function forget(): void {
		held = null;
	}

	return {
		capture: capture,
		restore: restore,
		preserve: preserve,
		remember: remember,
		hold: hold,
		absorb: absorb,
		forget: forget,
	};
}
