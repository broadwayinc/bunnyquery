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
	 * The reader cannot see this box right now (the tab is hidden), so FREEZE:
	 * remember where they were and refuse to move them.
	 *
	 * A hidden tab still runs everything that mutates the list — a resumed poll, a
	 * head refresh and its deferred background batch, a settling request — and each
	 * of those would otherwise write scrollTop against a layout nobody is looking at
	 * and re-stamp the remembered position on the way through. The reader then comes
	 * back to wherever the last of those writes happened to land, which is the
	 * "somehow placed in the middle" they see, and only the NEXT correction puts
	 * them right. So while frozen, reads still happen but nothing writes and nothing
	 * re-stamps: the anchor holds the last position the reader actually had, and one
	 * hold() on return puts them back on it.
	 */
	isFrozen?: () => boolean;
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
	/** The reader is going away: park the exact place they are leaving. */
	park: () => void;
	/**
	 * They are back. Puts them on the parked place, and STAYS ARMED until it has
	 * actually landed. Returns true when the host must pin to the bottom instead
	 * (the reader left pinned), which only the host can do meaningfully.
	 */
	settleReturn: () => boolean;
	/** A return is armed: its position, not the host's, decides scrollTop. */
	isReturning: () => boolean;
	/**
	 * The reader is driving. Retire any armed return, at once.
	 *
	 * Call from the raw gesture handlers (wheel, touchstart, touchmove, keydown),
	 * which fire synchronously on a real user action and never for a programmatic
	 * scroll. Waiting for the scroll EVENT is not good enough: a background refresh
	 * can settle in between, and a settle with a return still armed puts the reader
	 * back where they were before they left, which lands as "I touched the scroll
	 * and it threw me somewhere else".
	 */
	release: () => void;
	/** Pin to the bottom, instantly, recording the write. The ONLY way to pin. */
	pinBottom: () => void;
	/** The box is not being painted (hidden tab). Shared so hosts agree. */
	isFrozen: () => boolean;
	/** Deprecated alias of settleReturn, kept so a stale dist does not break. */
	thaw: () => void;
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
/** Settles an armed return may act on: the two halves of one head refresh, plus
 *  one spare for a refresh that was already in flight when the reader left. */
var MAX_RETURN_SETTLES = 3;
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
			if (rawPos === null) {
				// An ordinary row: use it, and take a couple of standbys from the rows
				// after it in the same walk.
				cand.alts = collectAlts(box, boxTop, i + 1);
				return cand;
			}
			if (!fallback) { fallback = cand; fallbackAt = i; }  // group row: last resort
		}
		// The weak anchor needs standbys MORE than the strong one does, not less: a
		// screenful of collapsed indexing rows is exactly what a background sweep
		// re-keys and re-anchors, and without them state (c) fell straight into
		// lost()'s whole-list guess. Ordinary rows only — more group rows from the
		// same block are the very rows the same batch rewrites.
		if (fallback) {
			fallback.alts = collectAlts(box, boxTop, fallbackAt + 1, true);
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

	// A frozen stretch happened and has not been settled yet. hold() has to know,
	// because its own safety rule cannot survive one: on the first call after the
	// tab comes forward it must put the reader back rather than conclude they moved
	// (and, worse, re-measure — which is what DESTROYS the only record of where they
	// were, and why this cannot be left to whoever calls thaw() first).
	var sawFrozen = false;
	// Where the reader was when they went away. Held apart from `held` because the
	// ordinary compensation keeps re-stamping that one while they are gone.
	var parked: RowAnchor | null = null;
	// They left pinned to the bottom. capture() records nothing for such a reader
	// (there is no row to hold, the bottom IS the place), so this is the only note
	// of it — and without it a stickiness lost during the absence had no fallback.
	var parkedStuck = false;
	// A return is armed: it has not landed yet. It survives across BOTH halves of a
	// head refresh, which is what puts a pinned reader on the bottom that exists
	// after the deferred batch merges rather than the surface page's bottom.
	var returning = false;
	// How many more settles an armed return may act on. A return exists to survive
	// the two halves of one head refresh; beyond that it is a stale instruction
	// lying in wait, and the reader has moved on. Bounded so a blur that never got
	// a matching focus (clicking into devtools, another window, an iframe — all of
	// which fire window blur) cannot arm something that fires minutes later.
	var returnBudget = 0;
	// The last scrollTop THIS module wrote. A scroll event reporting anything else
	// is the reader, and the reader always wins — that is the whole retirement rule
	// for an armed return, and it is why every write below records it.
	var wroteTop = -1;
	// Did the last restore's write actually land, and was it a real row pin rather
	// than lost()'s guess. A shrink below the reader silently truncates a
	// correction, and a return that believes a clamped write succeeded is a reader
	// left a few hundred pixels off their line, permanently.
	var restoreExact = true;
	var restorePinned = false;
	function frozen(): boolean {
		var f = !!options.isFrozen && options.isFrozen();
		if (f) sawFrozen = true;
		return f;
	}

	function restore(anchor: RowAnchor | null, unbounded?: boolean): void {
		// Frozen: leave `held` exactly as it is. It is the reader's last real
		// position, and it is what hold() puts back when the tab comes forward.
		if (frozen()) return;
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
			// A relocation disqualifies the ROW, not the whole capture: fall through
			// to the standbys, which is a real measurement, rather than to lost()'s
			// whole-list guess.
			if (anchor.pos !== null && anchor.pos !== UNKNOWN_ROW_POS &&
				livePos !== UNKNOWN_ROW_POS && livePos !== anchor.pos) el = null;
		}
		if (el) {
			var boxTop = box.getBoundingClientRect().top;
			var delta = (el.getBoundingClientRect().top - boxTop) - anchor.top;
			// A row can also be MOVED rather than resized: a background refetch
			// that merges a run's passes into the middle of page 1 relocates the
			// bubble this anchor is holding, and following it would carry the
			// reader across the conversation. A real prepend or in-place growth
			// can only ever need a correction on the order of what the list gained,
			// so a delta a whole screen beyond that is a relocation, not a resize.
			// `unbounded` is the thaw: across a hidden stretch the box may have been
			// scrolled anywhere at all (a settling request, a clamp), so a correction
			// the size of the whole list is not evidence that the ROW moved — it is
			// just how far the reader has to be carried back.
			var slack = Math.abs(box.scrollHeight - anchor.scrollHeight) + box.clientHeight;
			if (!unbounded && (delta > slack || delta < -slack)) { lost(box, anchor); return; }
			// Sub-pixel noise is not a jump, and writing scrollTop for it costs a
			// scroll event (and a re-layout) on every settle.
			var want = box.scrollTop + delta;
			if (delta >= 1 || delta <= -1) box.scrollTop += delta;
			wroteTop = box.scrollTop;
			restorePinned = true;
			restoreExact = box.scrollTop >= want - 1 && box.scrollTop <= want + 1;
			// This position is now the reader's place, and hold() has to know it:
			// a bracketed restore MOVES scrollTop, which is exactly what hold()
			// reads as "someone scrolled, my anchor is stale". Without this, every
			// image that decodes after a re-render (which is all of them: the list
			// is rebuilt with src-less, zero-height previews and hydrated
			// afterwards) would find a stale anchor and go uncompensated.
			held = {
				key: anchor.key, top: anchor.top, pos: anchor.pos,
				scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, el: el,
				// Carried, not dropped: one successful restore used to disarm the
				// standbys for every later hold.
				alts: anchor.alts,
			};
			return;
		}
		// The anchor row is gone: its group collapsed, or the history was replaced.
		// A standby row that IS still there beats lost()'s guess outright.
		var alts = anchor.alts;
		for (var ai = 0; alts && ai < alts.length; ai++) {
			var alt = alts[ai];
			var ael = findRow(box, { key: alt.key, top: alt.top, pos: alt.pos, scrollTop: anchor.scrollTop, scrollHeight: anchor.scrollHeight, el: alt.el });
			if (!ael) continue;
			if (alt.pos !== null && alt.pos !== UNKNOWN_ROW_POS) {
				var altLive = ael.getAttribute(ROW_POS_ATTR) || UNKNOWN_ROW_POS;
				if (altLive !== UNKNOWN_ROW_POS && altLive !== alt.pos) continue;
			}
			var aboxTop = box.getBoundingClientRect().top;
			var adelta = (ael.getBoundingClientRect().top - aboxTop) - alt.top;
			var aslack = Math.abs(box.scrollHeight - anchor.scrollHeight) + box.clientHeight;
			if (!unbounded && (adelta > aslack || adelta < -aslack)) continue;
			var awant = box.scrollTop + adelta;
			if (adelta >= 1 || adelta <= -1) box.scrollTop += adelta;
			wroteTop = box.scrollTop;
			restorePinned = true;
			restoreExact = box.scrollTop >= awant - 1 && box.scrollTop <= awant + 1;
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
		if (grew > 0) { box.scrollTop = anchor.scrollTop + grew; wroteTop = box.scrollTop; return; }
		if (options.rawFallback) { box.scrollTop = anchor.scrollTop; wroteTop = box.scrollTop; }
	}

	function preserve<T>(mutate: () => T): T {
		var anchor = capture();
		var result = mutate();
		restore(anchor);
		return result;
	}

	function remember(): void {
		// THE retirement rule for an armed return, and the only one. This runs from
		// the host's scroll handler, which sees every scroll event; a position this
		// module did not write is the reader, and the reader always wins. Checked
		// before the frozen bail because it is the one thing allowed to end a return.
		var b0 = options.getBox();
		if (returning && b0 && b0.scrollTop !== wroteTop) release();
		// A scroll event while the tab is hidden is not the reader moving.
		if (frozen()) return;
		held = capture();
	}

	function hold(): void {
		if (frozen()) return;
		// Coming out of a FROZEN stretch, and only that. An armed return is settled
		// by the host, from its focus/visible handler and the refresh settles that
		// follow — never from here. hold() runs on every render, including the many
		// that happen WHILE the reader is still away, and letting those settle the
		// return spent it before they were back to see it.
		if (sawFrozen) { settleReturn(); return; }
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
		// The baseline is recorded even while frozen (and even while pinned to the
		// bottom): what must not happen is the WRITE. An image that decodes in a
		// hidden tab has still resized, and forgetting that would make the next
		// visible change pay for its whole height.
		if (seen) seen.set(el, h);
		if (options.isStuck()) return;
		if (prev === undefined) prev = 0;
		var delta = h - prev;
		if (delta === 0) return;
		if (frozen()) { foldFrozenGrowth(box, el, delta); return; }
		// The element's own TOP, which a resize never moves: everything BELOW it
		// slides by delta, everything above stays. So the reader's first visible
		// line moved exactly when that top is above the fold — whether the element
		// grew, collapsed, or straddles the fold now that it has grown. When the
		// top is at or below the fold the growth happens on screen, at or under a
		// line the reader is looking at, and moving them would be the jump.
		if (el.getBoundingClientRect().top >= box.getBoundingClientRect().top) return;
		box.scrollTop += delta;
		wroteTop = box.scrollTop;
		// Re-measure the remembered anchor, do not patch it. Its scrollTop is
		// stale after that write (hold() would read the difference as "the reader
		// scrolled" and throw the anchor away), and so is its offset whenever the
		// element that just resized lives INSIDE the anchored row: there the row's
		// own top never moved, so scrolling by delta changed the row's offset by
		// -delta and the next hold() would faithfully undo this correction.
		if (held) held = capture();
	}

	/**
	 * The tab has come forward. Put the reader back on the line they left, whatever
	 * scrollTop says now.
	 *
	 * hold() cannot do this job. Its safety rule is "the anchor is valid only while
	 * box.scrollTop still equals the value it was captured at", which is what stops
	 * it dragging a reader back after they scroll themselves — and across a hidden
	 * stretch that rule points the wrong way. Plenty of things write scrollTop while
	 * the tab is hidden without going through this module at all (a settling request
	 * scrolling to the bottom, the browser clamping after a refresh shortened the
	 * list), so on return the value has moved and hold() concludes the reader moved
	 * it and gives up — leaving them wherever the last invisible write landed. That
	 * IS the "somehow placed in the middle".
	 *
	 * Nothing that happened while nobody was looking was the reader, so here the
	 * remembered place simply wins.
	 */
	/**
	 * The reader is going away. Park the place they are leaving, in a slot that the
	 * ordinary compensation cannot overwrite.
	 *
	 * Not the same thing as freezing. A tab that goes HIDDEN stops being painted, so
	 * there is nothing to compensate and writing scrollTop is pointless. But a window
	 * that merely loses focus — the user switched to another application — is usually
	 * still `document.visibilityState === 'visible'`: nothing fires visibilitychange,
	 * the page keeps rendering, and the chat keeps mutating underneath a reader who
	 * is not there. Compensation must keep running for that case (they may still be
	 * able to SEE the window, on a second monitor or beside the other app), which is
	 * exactly why `held` cannot be trusted on return: every background correction
	 * re-stamps it. So the leaving place is parked separately.
	 */
	function park(): void {
		parked = capture();
		parkedStuck = !!options.isStuck();
		returning = true;
		returnBudget = MAX_RETURN_SETTLES;
	}

	/** The reader is driving: an armed return is no longer anyone's business. */
	function release(): void {
		parked = null;
		parkedStuck = false;
		returning = false;
		returnBudget = 0;
	}

	/**
	 * Pin to the bottom, instantly, recording the write.
	 *
	 * The ONE way anything is allowed to pin. Instant because a smooth glide fires a
	 * scroll event per frame at positions that are not the bottom, and the hosts
	 * clear stickToBottom on each of them — so any merge landing inside the ~130ms
	 * animation strands the reader off the bottom permanently, aiming at a target
	 * that was already stale when the glide started. Recorded because an unrecorded
	 * write looks like the reader and would retire an armed return early.
	 */
	function pinBottom(): void {
		var box = options.getBox();
		if (!box) return;
		box.scrollTop = box.scrollHeight;
		wroteTop = box.scrollTop;
	}

	/**
	 * The reader is back. Put them on the parked place, whatever scrollTop says now.
	 *
	 * hold() cannot do this job. Its safety rule is "the anchor is valid only while
	 * box.scrollTop still equals the value it was captured at", which is what stops
	 * it dragging a reader back after they scroll themselves — and across an absence
	 * that rule points the wrong way. Plenty of things write scrollTop while nobody
	 * is looking (a settling request scrolling to the bottom, the browser clamping
	 * after a refresh shortened the list), so on return the value has moved and
	 * hold() concludes the reader moved it and gives up — leaving them wherever the
	 * last unwatched write landed. That IS the "somehow placed in the middle".
	 *
	 * Nothing that happened while they were away was them, so the parked place wins.
	 */
	function settleReturn(): boolean {
		if (frozen()) return false;
		var wasFrozen = sawFrozen;
		sawFrozen = false;
		// Nothing is armed, so there is nothing to settle. Without this the call was
		// a licence to re-impose `held` UNBOUNDED at any time — which is exactly how
		// a reader who had already taken control got thrown back: they released the
		// return, and the next background settle simply used the live anchor instead.
		if (!returning && !wasFrozen) return false;
		if (returning) {
			if (returnBudget <= 0) { release(); return false; }
			returnBudget--;
		}
		// A reader who left pinned has no row to hold; the bottom is the place. Stay
		// armed so the NEXT settle re-pins after the deferred batch merges, which is
		// the bottom they actually mean.
		if (parkedStuck) { pinBottom(); return true; }
		var target = parked || held;
		restoreExact = true; restorePinned = false;
		restore(target, true);
		// Keep the parked place when the correction could not land. A phase-1 shrink
		// leaves the list at its shortest, so the browser truncates the write and the
		// reader ends up short — and phase 2 re-grows the list, making that same
		// place reachable again. Believing the clamped write was a success is what
		// made the error permanent.
		parked = (!restorePinned || !restoreExact) ? target : null;
		returning = !!parked && returnBudget > 0;
		if (!returning) { parked = null; parkedStuck = false; returnBudget = 0; }
		return false;
	}

	function isReturning(): boolean { return returning; }

	/** Deprecated alias. */
	function thaw(): void { settleReturn(); }

	/**
	 * An element resized while nobody was looking. Fold it into the remembered
	 * places instead of dropping it.
	 *
	 * The live box cannot be measured against here: while frozen every compensator
	 * no-ops, so a prepend or a clamp may have moved the box out from under the
	 * offsets these anchors were taken at. Judge it in the ANCHOR's own frame
	 * instead — is this element inside the anchored row, and above the reader's
	 * line — and adjust the anchor rather than the scroll.
	 *
	 * `held` and `parked` can be different rows, so each is folded separately. The
	 * standbys are deliberately not touched: a row below the growth is re-measured
	 * by restore() anyway.
	 */
	function foldFrozenGrowth(box: AnchorBoxEl, el: AnchorGrowableEl, delta: number): void {
		var elTop = el.getBoundingClientRect().top;
		foldInto(box, held, elTop, delta);
		foldInto(box, parked, elTop, delta);
	}

	function foldInto(box: AnchorBoxEl, a: RowAnchor | null, elTop: number, delta: number): void {
		if (!a || a.top >= 0) return;            // the row starts at or below the fold
		var rowEl = findRow(box, a);
		if (!rowEl) return;
		var within = elTop - rowEl.getBoundingClientRect().top;
		if (within < 0 || within >= rowEl.offsetHeight) return;   // outside, or stale
		if (within >= -a.top) return;            // at or below the reader's own line
		a.top -= delta;
		a.scrollHeight += delta;
	}

	function forget(): void {
		held = null;
		release();
	}

	return {
		capture: capture,
		restore: restore,
		preserve: preserve,
		remember: remember,
		hold: hold,
		park: park,
		settleReturn: settleReturn,
		isReturning: isReturning,
		release: release,
		pinBottom: pinBottom,
		isFrozen: frozen,
		thaw: thaw,
		absorb: absorb,
		forget: forget,
	};
}
