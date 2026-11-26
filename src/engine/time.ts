/**
 * Chat timestamp formatting, shared so agent.vue and the widget render an
 * identical "small text under the bubble". Pure and locale-aware: it formats a
 * given epoch-ms value, it never reads the current time, so it stays testable and
 * DOM-free.
 */

/** Wall-clock epoch ms. Separate from the engine's monotonic nowMs() (which is
 *  performance.now() when available and therefore NOT epoch): a displayed
 *  timestamp must be wall time. */
export function wallClockNow(): number {
	return Date.now();
}

/**
 * "Jul 24, 2026, 3:42:07 PM" (locale-formatted). Empty string for a missing or
 * non-finite value, so a caller can gate rendering on the result being truthy and
 * a pending bubble (no timestamp yet) simply shows nothing.
 */
export function formatChatTimestamp(ms?: number): string {
	if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
	try {
		return new Date(ms).toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			second: '2-digit',
		});
	} catch (e) {
		return '';
	}
}

/**
 * "4s", "2m 4s", "1h 2m 4s" — how long one indexing pass took.
 *
 * HOURS ARE THE LARGEST UNIT, deliberately: a pass is a single model turn, so a
 * span of days is not a long read but bad data (a stale `updated` stamp, a clock
 * skew, a row rewritten much later). Rolling those into hours makes them read as
 * the anomaly they are — "49h" — instead of dressing them up as a plausible
 * "2d 1h".
 *
 * A zero unit is dropped rather than padded ("1h 4s", not "1h 0m 4s"); seconds
 * are always shown so the string is never bare.
 *
 * Empty string for anything under a second, negative, or non-finite — a pass
 * cannot take no time, so those are skew or missing data, and callers gate on
 * the result being truthy exactly as they do for formatChatTimestamp.
 */
export function formatDuration(ms?: number): string {
	if (typeof ms !== 'number' || !isFinite(ms) || ms < 1000) return '';
	var total = Math.floor(ms / 1000);
	var h = Math.floor(total / 3600);
	var m = Math.floor((total % 3600) / 60);
	var s = total % 60;
	var out = [];
	if (h) out.push(h + 'h');
	if (m) out.push(m + 'm');
	out.push(s + 's');
	return out.join(' ');
}

/**
 * "45 s", "12 min 5 s", "1 h 3 min": how long a whole file took to index, from its run::
 * record's `started` to its `finished`. Coarser than formatDuration on purpose: a file run
 * spans many passes and often minutes, so seconds are dropped once it passes an hour, and a
 * zero unit is left out ("12 min", "1 h"). Hours stay the largest unit for the reason
 * formatDuration gives.
 *
 * Empty string for anything under a second, negative, or non-finite: a file cannot be read
 * in no time, so those are missing data or clock skew, and callers gate on the result.
 */
export function formatIndexDuration(ms?: number): string {
	if (typeof ms !== 'number' || !isFinite(ms) || ms < 1000) return '';
	var total = Math.floor(ms / 1000);
	var h = Math.floor(total / 3600);
	var m = Math.floor((total % 3600) / 60);
	var s = total % 60;
	if (h) return h + ' h' + (m ? ' ' + m + ' min' : '');
	if (m) return m + ' min' + (s ? ' ' + s + ' s' : '');
	return s + ' s';
}

/**
 * Creation time (ms epoch) of a request id "stamp:entropy", whose stamp is a time_ns written
 * as 8 bytes of base32hex without padding (the worker's and the producer's _generate_req_id).
 * 0 when it is not one.
 */
export function requestIdTimeMs(rid: string): number {
	if (typeof rid !== 'string') return 0;
	var stamp = rid.split(':')[0] || '';
	if (stamp.length !== 13) return 0;
	var alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
	var v = 0;
	for (var i = 0; i < stamp.length; i++) {
		var d = alphabet.indexOf(stamp.charAt(i).toUpperCase());
		if (d < 0) return 0;
		v = v * 32 + d;
	}
	// 13 digits are 65 bits for 64 of data: the last bit is padding.
	return Math.floor(v / 2 / 1e6);
}

/**
 * A chat message's time in epoch ms, for ORDERING and grouping (never for display): the time
 * in its request id (`_serverItemId`, "stamp:entropy", the server's clock) when it has one,
 * else its `_ts`, else 0 (unknown). Request-id first so every comparison uses one clock: a
 * live-settled reply's `_ts` is the browser's Date.now(), and mixing the two let a browser
 * running ahead of the server fold a re-index into the previous run. A request and its reply
 * share one id, so nothing is ever ordered between them. A live background pass adopted from
 * the queue has no `_ts` at all until it settles.
 */
export function messageTimeMs(m: { _ts?: number; _serverItemId?: string } | null | undefined): number {
	if (!m) return 0;
	var r = typeof m._serverItemId === 'string' ? requestIdTimeMs(m._serverItemId) : 0;
	if (r > 0) return r;
	return typeof m._ts === 'number' && m._ts > 0 ? m._ts : 0;
}
