/**
 * Error detection + message extraction (pure). Moved verbatim from the
 * agent.vue / bunnyquery chatbox so both consumers share one implementation.
 */

export function getErrorMessage(input: any): string {
	if (!input) return 'Something went wrong.';
	if (typeof input === 'string') return input;
	if (input.error && input.error.message) return input.error.message;
	if (input.body && input.body.error && input.body.error.message) return input.body.error.message;
	if (input.body && typeof input.body.message === 'string') return input.body.message;
	if (input.message) return input.message;
	return 'Something went wrong.';
}

export function isErrorResponseBody(response: any): boolean {
	if (!response || typeof response !== 'object') return false;
	if (typeof response.status_code === 'number' && response.status_code >= 400) return true;
	if (response.type === 'error') return true;
	if (response.error && (response.error.message || response.error.type)) return true;
	var body = response.body;
	if (body && typeof body === 'object') {
		if (body.type === 'error') return true;
		if (body.error && (body.error.message || body.error.type)) return true;
	}
	if (typeof response.message === 'string' && response.message.length) {
		var hasClaude = Array.isArray(response.content);
		var hasOpenAI =
			typeof response.output_text === 'string' ||
			Array.isArray(response.output) ||
			Array.isArray(response.choices);
		if (!hasClaude && !hasOpenAI) return true;
	}
	return false;
}

// A request that failed because the REQUEST ITSELF is malformed — an unknown or
// rejected parameter on a 400/422 — will deterministically re-fail if resent
// unchanged; no session refresh or retry can fix it. Detecting it lets the retry
// gates refuse to auto-resend (otherwise a 400 whose param name merely contains
// "token", e.g. `max_output_tokens`, trips the `invalid_request + token` branch
// of isAuthExpiredError below and loops refresh->resend forever, burning tokens).
// This is the `_skapi_extract` 400 class. Distinct from auth-expiry, which IS
// retryable after a token refresh — so 401 (auth) and 429/5xx (transient) are
// intentionally NOT treated as non-retryable here.
export function isNonRetryableRequestError(input: any): boolean {
	if (!input || typeof input !== 'object') return false;

	var status = typeof input.status_code === 'number' ? input.status_code
		: typeof input.status === 'number' ? input.status : undefined;

	// Collect the error envelope wherever it lives (response, response.body, or a
	// thrown error), mirroring isErrorResponseBody / isAuthExpiredError.
	var param: any = undefined;
	var blobs: string[] = [];
	var sources = [input.error, input.body && input.body.error, input.body, input];
	for (var i = 0; i < sources.length; i++) {
		var e = sources[i];
		if (!e) continue;
		if (typeof e === 'string') { blobs.push(e); continue; }
		if (typeof e !== 'object') continue;
		if (param === undefined && e.param != null) param = e.param;
		if (typeof e.code === 'string') blobs.push(e.code);
		if (typeof e.type === 'string') blobs.push(e.type);
		if (typeof e.message === 'string') blobs.push(e.message);
	}
	var hay = blobs.join(' | ').toLowerCase();

	// Explicit "unknown / unsupported parameter" is always a malformed request.
	if (hay.indexOf('unknown_parameter') !== -1 || hay.indexOf('unknown parameter') !== -1 ||
		hay.indexOf('unsupported_parameter') !== -1 || hay.indexOf('unsupported parameter') !== -1) {
		return true;
	}

	// A 400/422 invalid_request that points at a specific rejected field: resending
	// the identical body re-fails. (401 -> isAuthExpiredError; 429/5xx -> transient.)
	var isClientReqStatus = status === 400 || status === 422;
	if (isClientReqStatus && param != null && param !== '') return true;
	if (isClientReqStatus && hay.indexOf('invalid_request') !== -1 &&
		(hay.indexOf('parameter') !== -1 || hay.indexOf('param') !== -1)) {
		return true;
	}
	return false;
}

export function isAuthExpiredError(input: any): boolean {
	if (!input) return false;
	var blobs: string[] = [];
	var push = function (v: any) { if (typeof v === 'string' && v) blobs.push(v); };
	if (typeof input === 'string') push(input);
	else {
		push(input.message); push(input.code);
		if (input.error) { push(input.error.message); push(input.error.code); push(input.error.type); }
		if (input.body) {
			push(input.body.message);
			if (input.body.error) { push(input.body.error.message); push(input.body.error.code); push(input.body.error.type); }
		}
		if (typeof input.status === 'number' && input.status === 401) return true;
		if (typeof input.status_code === 'number' && input.status_code === 401) return true;
	}
	var hay = blobs.join(' | ').toLowerCase();
	if (!hay) return false;
	return hay.indexOf('token has expired') !== -1 || hay.indexOf('token is expired') !== -1 ||
		hay.indexOf('expired_token') !== -1 || hay.indexOf('invalid_token') !== -1 ||
		hay.indexOf('unauthorized') !== -1 || hay.indexOf('not authorized') !== -1 ||
		(hay.indexOf('invalid_request') !== -1 && hay.indexOf('token') !== -1);
}
