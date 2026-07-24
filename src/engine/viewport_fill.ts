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
	base: Omit<FillHistoryViewportOptions, 'isSatisfied'>,
): { fill: (isSatisfied: () => boolean | Promise<boolean>) => Promise<void>; isRunning: () => boolean } {
	var pending: Array<() => boolean | Promise<boolean>> = [];
	var running = false;

	async function allSatisfied(): Promise<boolean> {
		var next: Array<() => boolean | Promise<boolean>> = [];
		for (var i = 0; i < pending.length; i++) {
			if (!(await pending[i]())) next.push(pending[i]);
		}
		pending = next;
		return pending.length === 0;
	}

	return {
		isRunning: function () { return running; },
		fill: function (isSatisfied) {
			pending.push(isSatisfied);
			if (running) return Promise.resolve();
			running = true;
			var done = function () { running = false; pending = []; };
			return fillHistoryViewport({
				isSatisfied: allSatisfied,
				isEndOfList: base.isEndOfList,
				isLoading: base.isLoading,
				messageCount: base.messageCount,
				fetchOlder: base.fetchOlder,
				isStale: base.isStale,
				maxPages: base.maxPages,
			}).then(done, done);
		},
	};
}
