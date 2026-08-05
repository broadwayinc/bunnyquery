/**
 * Keep older history REACHABLE by paging until the message box actually gains
 * something to scroll to.
 *
 * Older history is paged in by one trigger only: the user scrolling to the top
 * of the message box. That trigger has two ways to die, and collapsed indexing
 * rows cause both:
 *
 *   1. The box never scrolls. A file's every indexing pass (the first plus every
 *      CONTINUE pass, request AND response bubble each) folds into ONE row, so a
 *      full history page — twenty-plus messages — can render as a single line.
 *      Content shorter than the viewport fires no scroll event, so page 2 is
 *      never requested and any conversation the user had before that upload is
 *      permanently out of reach.
 *   2. The fetched page adds no height. A page that is entirely the same file's
 *      earlier passes joins the collapsed row already on screen and renders
 *      nothing new. The user, sitting at scrollTop 0, scrolls up again — and
 *      because the position never changed, no further scroll event fires.
 *
 * Both are the same shape: fetch, re-measure, and keep going until the user
 * genuinely gained reachable content, history ran out, or the pager stopped
 * advancing. `isSatisfied` is what differs between the two (can the box scroll
 * at all / did it grow), so the loop below takes it as a predicate.
 *
 * DOM-free like the rest of the engine — the caller supplies the measurement and
 * awaits its own render before measuring, so agent.vue and the widget run the
 * identical loop over their own pagers.
 */

/** Overflow (px) that counts as "the user can scroll here". Comfortably more
 *  than the 60px top threshold that triggers the next page, so a filled box has
 *  real room to scroll rather than sitting one pixel from the trigger. */
export const HISTORY_FILL_SLACK_PX = 64;

/** Pages one fill pass will request before giving up. Reached only by a chat
 *  whose history really is dozens of pages of one file's indexing passes; the
 *  cap exists so a pager that stops advancing can never spin forever. */
export const MAX_HISTORY_FILL_PAGES = 24;

export type FillHistoryViewportOptions = {
	/** The user has reachable content and paging can stop. Called AFTER the
	 *  caller's own render has settled (nextTick / rAF), since only the caller
	 *  knows when its view has painted — hence the allowance for a promise. */
	isSatisfied: () => boolean | Promise<boolean>;
	/** All history is loaded — nothing left to page in. */
	isEndOfList: () => boolean;
	/** A history request is already in flight. Waited out, not treated as a stop
	 *  condition: a background first-page refresh (the queue-detect tick fires one
	 *  every couple of seconds while a file is indexing) would otherwise swallow
	 *  the user's scroll-up entirely, and scrolling up again from scrollTop 0
	 *  produces no second event to retry with. */
	isLoading: () => boolean;
	/** Messages currently loaded. Used to detect a page that added nothing, which
	 *  means the pager is not advancing and looping would never terminate. */
	messageCount: () => number;
	/** Fetch ONE older page (the caller's own fetchMore path, scroll-restore and
	 *  all). Return `false` when the request was NOT issued (the caller's own
	 *  single-flight guard swallowed it) so the loop retries instead of reading
	 *  the unchanged message count as an exhausted pager. Anything else, including
	 *  undefined, means it was attempted. */
	fetchOlder: () => Promise<boolean | void | any>;
	/** The chat this fill was started for is gone (project switched, view
	 *  unmounted, gate token bumped). Checked between pages so a stale fill can
	 *  never keep paging another chat's history. */
	isStale?: () => boolean;
	maxPages?: number;
};

/** How long to wait out an in-flight history request before giving up on it. */
const IDLE_WAIT_STEP_MS = 120;
const IDLE_WAIT_MAX_MS = 15000;

/** Resolve once no history request is in flight. False if the wait timed out or
 *  the chat went stale, in which case the caller should stop. */
async function waitForIdle(
	opts: FillHistoryViewportOptions,
	stale: () => boolean,
): Promise<boolean> {
	var waited = 0;
	while (opts.isLoading()) {
		if (stale() || waited >= IDLE_WAIT_MAX_MS) return false;
		await new Promise(function (r) { setTimeout(r, IDLE_WAIT_STEP_MS); });
		waited += IDLE_WAIT_STEP_MS;
	}
	return !stale();
}

/**
 * Page older history until `isSatisfied`, until history runs out, or until the
 * pager stops advancing. Never throws: a failed page ends the fill, and the
 * user's own scrolling remains the fallback trigger.
 */
export async function fillHistoryViewport(opts: FillHistoryViewportOptions): Promise<void> {
	var maxPages = typeof opts.maxPages === 'number' ? opts.maxPages : MAX_HISTORY_FILL_PAGES;
	var stale = function () { return !!(opts.isStale && opts.isStale()); };
	var swallowed = 0;

	for (var page = 0; page < maxPages; page++) {
		if (stale() || opts.isEndOfList()) return;
		if (!(await waitForIdle(opts, stale))) return;
		var satisfied = false;
		try {
			satisfied = !!(await opts.isSatisfied());
		} catch {
			return; // cannot measure (view torn down mid-fill) — stop.
		}
		if (satisfied || stale()) return;

		// Re-check immediately before dispatching: measuring above yields for a
		// frame, and a background first-page refresh landing in that gap would make
		// the caller's own single-flight guard swallow this request. A swallowed
		// page adds no messages, which used to read as "the pager is exhausted" and
		// abandoned the fill for good.
		if (!(await waitForIdle(opts, stale))) return;
		var before = opts.messageCount();
		var attempted: boolean | void;
		try {
			attempted = await opts.fetchOlder();
		} catch {
			return; // history is optional; the scroll trigger stays as the fallback.
		}
		if (stale()) return;
		if (attempted === false) {
			// The caller reported it never issued the request. Retry it rather than
			// mistaking it for an exhausted pager, but not forever.
			if (++swallowed > 3) return;
			page--;
			continue;
		}
		// The page came back with nothing new. Either the pager is exhausted (and
		// endOfList simply has not been set) or it is stuck; either way another
		// round would request the same page again.
		if (opts.messageCount() <= before) return;
	}
}

/**
 * One fill loop per view, with predicates COMBINED rather than dropped.
 *
 * Fills come from several places at once — a first page finishing, a window
 * resize, a row being collapsed, and the user's own scroll to the top — and a
 * plain "one at a time, drop the rest" guard picks the wrong winner: a resize
 * fill (satisfied the moment the box can scroll at all) would swallow the user's
 * scroll-up (which needs content specifically ABOVE them), and the scroll-up
 * cannot be retried, because a reader parked at scrollTop 0 produces no further
 * scroll event. Dropping the guard entirely is no better: every frame of a
 * window drag would start its own 24-page loop.
 *
 * So a request that arrives mid-loop ANDs its predicate into the running one:
 * the loop then keeps paging until EVERY caller is satisfied. Predicates that
 * come true are dropped as it goes, so the cost stays flat.
 */
export function createHistoryFiller(
	base: Omit<FillHistoryViewportOptions, 'isSatisfied'> & {
		/** Fired when the loop starts FETCHING and when it stops, and only on a real
		 *  change.
		 *
		 *  This — not the caller's own per-request `isLoading` — is what "older
		 *  history is still coming in" means to a view. A fill is many pages, and
		 *  `isLoading` drops to false between every one of them, so anything
		 *  rendered off it flickers once per page for the whole loop. A collapsed
		 *  indexing row whose run begins above the loaded window renders exactly
		 *  that ("still loading this run" vs a status it cannot know yet), which is
		 *  why the loop has to publish its own span.
		 *
		 *  Fetching, NOT requested. Most fills fetch nothing: they are fired on every
		 *  window resize, every row a user collapses, and every first-page load, and
		 *  the overwhelmingly common outcome is `isSatisfied` returning true on the
		 *  first look. Announcing at request time published a true/false pair for
		 *  each of those, and the widget's own satisfied-check spans two animation
		 *  frames — long enough for the browser to PAINT the intermediate state. Every
		 *  collapsed row strobed through "loading" on every resize tick. So the span
		 *  opens at the first actual page request, which is also the first moment the
		 *  claim is true. */
		onRunningChange?: (running: boolean) => void;
	},
): { fill: (isSatisfied: () => boolean | Promise<boolean>) => Promise<void>; isRunning: () => boolean } {
	var pending: Array<() => boolean | Promise<boolean>> = [];
	// One loop at a time. Set the instant a fill is REQUESTED, whether or not that
	// fill goes on to fetch anything.
	var running = false;
	// What the view is told: a page is actually being fetched. Deliberately a
	// different fact from `running` — see onRunningChange.
	var fetching = false;

	// The callback can NEVER break the loop, and the swallow is the point. It is a
	// view render (the widget rebuilds its whole message list from here), so it is
	// the least trustworthy code this module touches, and it is invoked from two
	// places that must both survive it: inside the fetch wrapper, and inside `done`
	// — where a throw would reject the promise `fill()` returns and leave the
	// closing edge unsent, pinning every row that renders off this at "loading"
	// forever. A view that cannot paint is the view's problem, not the pager's.
	function announce(next: boolean): void {
		if (fetching === next) return;
		fetching = next;
		if (!base.onRunningChange) return;
		try { base.onRunningChange(next); } catch (e) { /* never break the pager */ }
	}

	async function allSatisfied(): Promise<boolean> {
		var next: Array<() => boolean | Promise<boolean>> = [];
		for (var i = 0; i < pending.length; i++) {
			if (!(await pending[i]())) next.push(pending[i]);
		}
		pending = next;
		return pending.length === 0;
	}

	return {
		// The published fact, so a view and `isRunning()` can never disagree about
		// what they are showing. A fill that never fetches is not something anyone
		// outside this module has any use for knowing about.
		isRunning: function () { return fetching; },
		fill: function (isSatisfied) {
			pending.push(isSatisfied);
			if (running) return Promise.resolve();
			running = true;
			var done = function () { pending = []; running = false; announce(false); };
			return fillHistoryViewport({
				isSatisfied: allSatisfied,
				isEndOfList: base.isEndOfList,
				isLoading: base.isLoading,
				messageCount: base.messageCount,
				// The span opens HERE, at the first real page request: past
				// isEndOfList, past isStale, past isSatisfied. Everything before this
				// point is a fill that concluded there was nothing to do.
				fetchOlder: function () { announce(true); return base.fetchOlder(); },
				isStale: base.isStale,
				maxPages: base.maxPages,
			}).then(done, done);
		},
	};
}
