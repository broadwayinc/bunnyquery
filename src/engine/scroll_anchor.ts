/**
 * Hold the reader's place in the message list.
 *
 * A chat box mutates constantly WITHOUT the reader asking for it: an older page
 * prepends, a poll resolves, an indexing row splices in or changes label, a link
 * chip goes grey, an image preview finishes decoding, the "Fetching history..."
 * bar appears and disappears. Every one of those changes the height of something
 * that may sit ABOVE the viewport, and the browser answers by keeping scrollTop,
 * which slides the sentence the reader was on out from under them.
 *
 * THE ONE RULE: nothing here stores a position to be applied later. Every method
 * acts at the moment it is called, against the box as it is at that moment, and
 * is finished when it returns.
 *
 * That rule is the whole design, and it was learned the hard way. An earlier
 * version of this module also had a "park the place they left, put them back when
 * they return" half — parked/parkedStuck/returning/returnBudget/sawFrozen, a
 * frozen mode, a retry budget. Every one of those was a stored instruction that
 * some later event would carry out, and the reader's experience of a stored
 * instruction is that the chat throws them somewhere for no reason they can see:
 * they came back from another app, tapped the composer, the on-screen keyboard
 * fired a resize, the resize triggered a fetch, the fetch settled, and the settle
 * dutifully executed an instruction recorded before they ever left. Compensating
 * at the moment of the change needs no such instruction, and a return then needs
 * no handling at all, because nothing moved the reader in the first place.
 *
 * Two shapes, both immediate:
 *
 *   preserve(fn) / capture() + restore(a)
 *       A mutation you can bracket. Measures immediately before and immediately
 *       after, so it is exact even when the mutation tears the list down.
 *
 *   remember() + hold()
 *       A layout change you CANNOT bracket: an image decoding, a font arriving, a
 *       re-parse from a promise. remember() runs from the view's scroll handler,
 *       so the anchor is always the reader's own last position.
 *
 * hold() is not an exception to the rule, and the staleness check is why. A height
 * change above the viewport does NOT change scrollTop; the browser preserves it,
 * which is precisely why the content appears to jump. So the remembered anchor is
 * valid exactly while `box.scrollTop` still equals the value it was captured at,
 * i.e. while nothing at all has moved the box. The instant that stops being true
 * it is re-measured, never replayed. hold() can therefore only ever undo a height
 * change that just happened, and can never carry out an old intention.
 *
 * Two more consequences worth stating, because both were once done the other way:
 *
 *   NO FREEZE. Compensation runs whether or not the tab is visible. Layout and
 *   getBoundingClientRect are live in a hidden tab; only painting and rAF stop.
 *   Suspending compensation while hidden is what created the need to restore
 *   something afterwards.
 *
 *   A CLAMP IS ACCEPTED. If the content below the reader shrank, their line is
 *   genuinely unreachable and the browser truncates the correction. Retrying that
 *   later is how a correction turns into an ambush.
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
	/**
	 * The next few anchorable rows below the primary, each with its own offset.
	 *
	 * The primary row does not always survive: a refresh can drop it, a collapsed
	 * indexing row can be re-identified, an expanded group can fold. Without a
	 * fallback the only thing left is lost(), which guesses from the list's total
	 * growth — and total growth includes everything added BELOW the reader, so a
	 * merge that lands rows on both sides of them over-pays. A second row that is
	 * still there beats any guess, and collecting them costs nothing: capture is
	 * already walking these rows.
	 */
	alts?: Array<{ key: string; top: number; pos: string | null; el: AnchorRowEl }>;
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
	/** Pin to the bottom, instantly, recording the write. The ONLY way to pin. */
	pinBottom: () => void;
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
/** How many standby rows capture() records. Two is enough to survive a refresh
 *  that drops the reader's own row without paying for a full-list guess. */
var MAX_ALTS = 2;
/** How far past the anchor collectAlts will look for them. */
var ALT_SCAN_LIMIT = 64;
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
		var fallbackAt = -1;
		// The last few rows passed on the way down, kept as standbys of last resort.
		var behind: Array<{ key: string; top: number; pos: string | null; el: AnchorRowEl }> = [];
		for (var i = 0; i < kids.length; i++) {
			var el = kids[i];
			if (!el || typeof el.getAttribute !== 'function') continue;
			var key = el.getAttribute(ROW_KEY_ATTR);
			if (!key) continue;
			var top = el.getBoundingClientRect().top - boxTop;
			// Rows still (partly) on screen. `top` is negative when a row starts
			// above the fold, which is exactly the offset to preserve.
			if (top + el.offsetHeight <= 0) {
				// Entirely above: not the reader's place, but a free standby. The rect
				// is already in hand, and a row ABOVE the anchor survives the batches
				// that rewrite the ones below it. Anything beats lost()'s guess.
				var bpos = el.getAttribute(ROW_POS_ATTR);
				behind.push({
					key: key, top: top,
					pos: bpos === null ? null : (bpos || UNKNOWN_ROW_POS), el: el,
				});
				if (behind.length > MAX_ALTS) behind.shift();
				continue;
			}
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
			if (rawPos === null) {
				// An ordinary row: use it, and take standbys from the rows after it in
				// the same walk, then the ones already passed. Forward first — they are
				// nearer the reader — but a batch that rewrites everything below the
				// fold leaves the rows above it alone, so backward is the better last
				// measurement.
				cand.alts = withBehind(collectAlts(box, boxTop, i + 1), behind);
				return cand;
			}
			if (!fallback) { fallback = cand; fallbackAt = i; }  // group row: last resort
		}
		// The weak anchor needs standbys MORE than the strong one does, not less: a
		// screenful of collapsed indexing rows is exactly what a background sweep
		// re-keys and re-anchors, and without them it fell straight into lost()'s
		// whole-list guess. Ordinary rows are PREFERRED, because they are the ones a
		// background batch does not rewrite — but no standby at all means the guess,
		// and a neighbouring group row is a real measurement that restore() will
		// reject anyway if it relocated. So group rows are the last thing before the
		// guess, not something to hold out against.
		if (fallback) {
			fallback.alts = withBehind(
				collectAlts(box, boxTop, fallbackAt + 1, true) || collectAlts(box, boxTop, fallbackAt + 1),
				behind,
			);
			return fallback;
		}
		return {
			key: null, top: 0, pos: null,
			scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, el: null,
		};
	}

	/** Up to MAX_ALTS anchorable rows starting at `from`, for restore's fallback. */
	function collectAlts(box: AnchorBoxEl, boxTop: number, from: number, ordinaryOnly?: boolean) {
		var out: Array<{ key: string; top: number; pos: string | null; el: AnchorRowEl }> = [];
		var kids = box.children;
		// Bounded: a chat can carry hundreds of collapsed rows below the fold, and
		// this must not become a full-list walk for two standbys.
		var stop = Math.min(kids.length, from + ALT_SCAN_LIMIT);
		for (var i = from; i < stop && out.length < MAX_ALTS; i++) {
			var el = kids[i];
			if (!el || typeof el.getAttribute !== 'function') continue;
			var key = el.getAttribute(ROW_KEY_ATTR);
			if (!key) continue;
			var rawPos = el.getAttribute(ROW_POS_ATTR);
			if (ordinaryOnly && rawPos !== null) continue;
			out.push({
				key: key,
				top: el.getBoundingClientRect().top - boxTop,
				pos: rawPos === null ? null : (rawPos || UNKNOWN_ROW_POS),
				el: el,
			});
		}
		return out.length ? out : undefined;
	}

	/** Forward standbys first, then the rows already passed, newest-first. */
	function withBehind(
		forward: Array<{ key: string; top: number; pos: string | null; el: AnchorRowEl }> | undefined,
		behind: Array<{ key: string; top: number; pos: string | null; el: AnchorRowEl }>,
	) {
		var out = (forward || []).concat(behind.slice().reverse());
		return out.length ? out : undefined;
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
			// A row that MOVED (an older page re-anchored a collapsed run to its true
			// first pass) must not be pinned: doing so would drag the reader along
			// with it, to wherever the run now starts. Only compare when BOTH sides
			// actually name a turn — a stub that has since learned its anchorId (or
			// lost it) has not moved, it has just started being able to answer.
			//
			// A relocation disqualifies the ROW, not the whole capture: fall through
			// to the standbys, which are a real measurement, rather than to lost()'s
			// whole-list guess.
			var livePos = el.getAttribute(ROW_POS_ATTR) || UNKNOWN_ROW_POS;
			if (anchor.pos !== null && anchor.pos !== UNKNOWN_ROW_POS &&
				livePos !== UNKNOWN_ROW_POS && livePos !== anchor.pos) el = null;
		}
		if (el) {
			var boxTop = box.getBoundingClientRect().top;
			var delta = (el.getBoundingClientRect().top - boxTop) - anchor.top;
			// A row can also be MOVED rather than resized: a background refetch that
			// merges a run's passes into the middle of page 1 relocates the bubble
			// this anchor is holding, and following it would carry the reader across
			// the conversation. A real prepend or in-place growth can only ever need a
			// correction on the order of what the list gained, so a delta a whole
			// screen beyond that is a relocation, not a resize.
			var slack = Math.abs(box.scrollHeight - anchor.scrollHeight) + box.clientHeight;
			// Test the relocation in CONTENT coordinates. `delta` is measured in the
			// VIEWPORT, so it also contains however far the box itself moved since the
			// capture — and the widget's teardown clamps scrollTop to 0, which makes
			// delta enormous for a row that never went anywhere. Judging that as a
			// relocation dropped a perfectly good anchor into lost()'s whole-list
			// guess. Subtracting the box's own movement leaves what the ROW did.
			var moved = delta - (anchor.scrollTop - box.scrollTop);
			if (moved > slack || moved < -slack) {
				// The row really did relocate. That disqualifies the ROW, not the
				// capture: fall through to the standbys, which are a real measurement.
				el = null;
			} else {
				// Sub-pixel noise is not a jump, and writing scrollTop for it costs a
				// scroll event (and a re-layout) on every settle.
				if (delta >= 1 || delta <= -1) box.scrollTop += delta;
				held = {
					key: anchor.key, top: anchor.top, pos: anchor.pos,
					scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, el: el,
					// Carried, not dropped: one successful restore used to disarm the
					// standbys for every later hold.
					alts: anchor.alts,
				};
				return;
			}
		}
		// The anchor row is gone or it relocated: its group collapsed, the history was
		// replaced, a background sweep re-keyed it.
		// A standby row that IS still there beats lost()'s guess outright.
		var alts = anchor.alts;
		for (var ai = 0; alts && ai < alts.length; ai++) {
			var alt = alts[ai];
			var ael = findRow(box, {
				key: alt.key, top: alt.top, pos: alt.pos,
				scrollTop: anchor.scrollTop, scrollHeight: anchor.scrollHeight, el: alt.el,
			});
			if (!ael) continue;
			if (alt.pos !== null && alt.pos !== UNKNOWN_ROW_POS) {
				var altLive = ael.getAttribute(ROW_POS_ATTR) || UNKNOWN_ROW_POS;
				if (altLive !== UNKNOWN_ROW_POS && altLive !== alt.pos) continue;
			}
			var aboxTop = box.getBoundingClientRect().top;
			var adelta = (ael.getBoundingClientRect().top - aboxTop) - alt.top;
			var aslack = Math.abs(box.scrollHeight - anchor.scrollHeight) + box.clientHeight;
			var amoved = adelta - (anchor.scrollTop - box.scrollTop);
			if (amoved > aslack || amoved < -aslack) continue;
			if (adelta >= 1 || adelta <= -1) box.scrollTop += adelta;
			held = {
				key: alt.key, top: alt.top, pos: alt.pos,
				scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, el: ael,
				alts: alts.slice(ai + 1),
			};
			return;
		}
		lost(box, anchor);
	}

	/**
	 * Neither the anchored row nor any standby survived: it is gone, or it moved.
	 *
	 * What is still known is how much the list GREW, and in the case this branch
	 * exists for — the pager, whose page can carry the very pass that re-anchors a
	 * collapsed row — all of that growth is above the reader. So pay it. Missing it
	 * costs a whole page of history in one jump.
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

	/** Record the reader's place. Call from the box's scroll handler. */
	function remember(): void {
		held = capture();
	}

	/**
	 * Put the remembered place back, if it is still the reader's own.
	 *
	 * The staleness check is what keeps this immediate rather than a stored
	 * intention: a height change above the viewport does NOT move scrollTop, so the
	 * anchor is valid exactly while scrollTop is still the value it was captured
	 * at. Anything else — the reader scrolled, a clamp fired, a pin ran — means the
	 * box moved for a reason of its own, and the answer is to re-measure, never to
	 * replay.
	 */
	function hold(): void {
		var box = options.getBox();
		if (!box || options.isStuck()) { held = null; return; }
		if (!held) { held = capture(); return; }
		if (box.scrollTop !== held.scrollTop) { held = capture(); return; }
		// restore() re-stamps `held` with the position it just pinned, so repeated
		// holds (one image after another finishing) each start from a valid anchor.
		restore(held);
	}

	/**
	 * Absorb a resize made by ONE element, wherever it sits.
	 *
	 * The row anchor cannot see this case. A reader partway through an assistant
	 * reply taller than the viewport is anchored ON that row, and a picture decoding
	 * higher up INSIDE it moves every line they are reading without moving the row's
	 * own top by a pixel. Rows above the fold have the same problem in reverse:
	 * hold() would fix them, but it cannot be allowed to run for an image as well or
	 * the two would each pay the same debt.
	 *
	 * So images go through here, and it is the more precise of the two: it
	 * compensates by the element's own height delta, and only while the element's
	 * TOP is above the fold, which is exactly the condition for "everything the
	 * reader can see just moved by this much". An element starting at or below the
	 * fold is left alone: it grew on screen, under a line the reader is looking at,
	 * and moving them is what would be the jump.
	 *
	 * The height it last saw is remembered per element, so the caller does not have
	 * to bracket anything. An element it has never seen counts as zero, which is
	 * what an <img> measures before it has anything to paint — including the
	 * markdown images that have no hydration hook at all.
	 */
	function absorb(el: AnchorGrowableEl | null | undefined): void {
		if (!el) return;
		var box = options.getBox();
		if (!box) return;
		var h = el.offsetHeight;
		var prev = seen ? seen.get(el) : undefined;
		// The baseline is recorded even while pinned to the bottom (where no write is
		// wanted): forgetting it would make the next change pay for this height too.
		if (seen) seen.set(el, h);
		if (options.isStuck()) return;
		if (prev === undefined) prev = 0;
		var delta = h - prev;
		if (delta === 0) return;
		// The element's own TOP, which a resize never moves: everything BELOW it
		// slides by delta, everything above stays. So the reader's first visible line
		// moved exactly when that top is above the fold.
		if (el.getBoundingClientRect().top >= box.getBoundingClientRect().top) return;
		box.scrollTop += delta;
		// Re-measure the remembered anchor, do not patch it. Its scrollTop is stale
		// after that write, and so is its offset whenever the element that resized
		// lives INSIDE the anchored row: there the row's own top never moved, so
		// scrolling by delta changed the row's offset by -delta and the next hold()
		// would faithfully undo this correction.
		if (held) held = capture();
	}

	/**
	 * Pin to the bottom, instantly.
	 *
	 * The ONE way anything is allowed to pin, and it reads the bottom at the moment
	 * it is called rather than aiming at a remembered one. Instant because a smooth
	 * glide fires a scroll event per frame at positions that are not the bottom, and
	 * the hosts clear stickToBottom on each of them, so any merge landing inside the
	 * animation strands the reader off the bottom permanently, aiming at a target
	 * that was already stale when the glide started.
	 */
	function pinBottom(): void {
		var box = options.getBox();
		if (!box) return;
		box.scrollTop = box.scrollHeight;
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
		pinBottom: pinBottom,
		absorb: absorb,
		forget: forget,
	};
}
