/**
 * BunnyQuery embeddable client.
 *
 * Vanilla JS port of the .bq-chat element from
 * www.skapi.com/src/views/service/agent.vue. Differences from the host app:
 *
 *   - No AI platform / model selectors. The project owner pre-selects them
 *     in the project settings page; the embed reads `info.ai_agent` and
 *     uses it as-is.
 *   - Shows a login form when there is no logged-in user. On successful
 *     login the client kicks off the MCP OAuth flow (RFC 7591 + PKCE) and
 *     persists the resulting access token in localStorage. On the OAuth
 *     redirect back the client picks the code+state out of the URL and
 *     finishes the exchange transparently before rendering the chat.
 *   - Hides the attach button when `info.freeze_database === true`.
 *
 * Usage:
 *   <script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
 *   <script src="bunnyquery.js"></script>
 *   <script type="module">
 *     const skapi = new Skapi("<service>", "<owner>");
 *     const bq = await BunnyQuery.init(skapi, "bq-client");
 *   </script>
 */
(function (global) {
    'use strict';

    // Capture the script element at parse time so we can resolve a sibling
    // `bunnyquery.css` URL even when the script is hosted on a CDN. The
    // consumer can override this by setting `BunnyQuery.STYLESHEET_URL`
    // before calling `BunnyQuery.init()`.
    const _CURRENT_SCRIPT_SRC =
        (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';

    // ---- MCP OAuth constants (mirrors src/code/mcp_oauth.ts) ---------------
    // The embed has no build-time env, so we always point at the production
    // MCP host. Override BunnyQuery.MCP_BASE_URL before init() to swap, or
    // pass `true` as the third arg to BunnyQuery.init() to target the dev
    // host (mcp-dev.broadwayinc.computer).
    const DEFAULTS = {
        MCP_BASE_URL: 'https://mcp.broadwayinc.computer',
        MCP_DEV_BASE_URL: 'https://mcp-dev.broadwayinc.computer',
        MCP_NAME: 'BunnyQuery',
        DEFAULT_CLAUDE_MODEL: 'claude-sonnet-4-6',
        DEFAULT_OPENAI_MODEL: 'gpt-5.4',
        ANTHROPIC_MESSAGES_API_URL: 'https://api.anthropic.com/v1/messages',
        ANTHROPIC_VERSION: '2023-06-01',
        ANTHROPIC_BETA_HEADER:
            'mcp-client-2025-11-20,web-fetch-2025-09-10,prompt-caching-2024-07-31',
        OPENAI_RESPONSES_API_URL: 'https://api.openai.com/v1/responses',
        MAX_TOKENS: 25000,
        POLL_INTERVAL: 1500,
        PENDING_POLL_INTERVAL_MS: 1000,
        ATTACHMENT_URL_EXPIRES_SECONDS: 600, // 10 min
    };

    // localStorage keys are namespaced by origin so multiple embeds on the
    // same machine do not stomp each other's tokens.
    const STORAGE_PREFIX = 'bq_embed_v1:';
    const CLIENT_KEY = STORAGE_PREFIX + 'mcp_client';
    const TOKEN_KEY = STORAGE_PREFIX + 'mcp_token';
    const STATE_KEY = STORAGE_PREFIX + 'mcp_state';

    // Resolve the active MCP base URL each time it's needed so a runtime
    // override of `BunnyQuery.MCP_BASE_URL` (e.g. via the `dev` flag on
    // init()) is reflected in subsequent send/auth calls.
    const _mcpBaseUrl = () => (global.BunnyQuery && global.BunnyQuery.MCP_BASE_URL) || DEFAULTS.MCP_BASE_URL;

    // ----- markdown loader (lazy) ------------------------------------------
    // Pulled from CDN on first use. While loading, parseMsgParts renders a
    // plain-text fallback; once `marked` resolves the instance re-renders.
    const MARKED_CDN_URL = 'https://cdn.jsdelivr.net/npm/marked@15.0.4/marked.min.js';
    let _markedReadyPromise = null;
    const _getMarked = () => {
        if (typeof global.marked !== 'undefined' && global.marked && global.marked.parse) {
            return Promise.resolve(global.marked);
        }
        if (_markedReadyPromise) return _markedReadyPromise;
        _markedReadyPromise = new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-bq-marked]');
            if (existing) {
                existing.addEventListener('load', () => resolve(global.marked), { once: true });
                existing.addEventListener('error', reject, { once: true });
                return;
            }
            const s = document.createElement('script');
            s.src = MARKED_CDN_URL;
            s.async = true;
            s.dataset.bqMarked = '1';
            s.addEventListener('load', () => resolve(global.marked), { once: true });
            s.addEventListener('error', reject, { once: true });
            document.head.appendChild(s);
        }).catch((err) => {
            console.error('[BunnyQuery] failed to load marked', err);
            _markedReadyPromise = null;
            return null;
        });
        return _markedReadyPromise;
    };
    // Eager kick-off so the first message render almost always has marked
    // ready by the time history finishes loading.
    if (typeof window !== 'undefined') {
        try { _getMarked(); } catch (_) { /* noop */ }
    }

    // ----- link parsing helpers (mirrors agent.vue) ------------------------
    // createInlineLinkRegex groups (in order):
    //   1: `src::<token>` — model-emitted reference to a db file (path or URL)
    //   2: markdown link label where href IS an http(s) URL
    //   3: markdown link href (URL)
    //   4: markdown link label where href is NOT a URL (storage path)
    //   5: markdown link path (non-URL) — treated like `src::<path>`
    //   6: bare http(s) URL
    const createInlineLinkRegex = () =>
        /src::(\S+)|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]+|\([^\s()]*\))+)\)|\[([^\]\n]+)\]\(((?:[^()\n]+|\([^()\n]*\))+)\)|(https?:\/\/[^\s<>"']+)/g;

    const EXPIRED_ATTACHMENT_URL_HOST = '_expired_.url';
    const EXPIRED_ATTACHMENT_URL_ORIGIN = `https://${EXPIRED_ATTACHMENT_URL_HOST}`;

    const _safeDecode = (v) => {
        try { return decodeURIComponent(v); } catch { return v; }
    };

    const _encodePathSegments = (p) =>
        p.split('/').filter(Boolean).map((s) => encodeURIComponent(s)).join('/');

    const normalizeAttachmentPathCandidate = (value) =>
        _safeDecode((value || '').trim())
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .replace(/\/+/g, '/');

    const extractRemotePathFromAttachmentHref = (href, serviceId) => {
        try {
            const parsed = new URL(href);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
            const path = normalizeAttachmentPathCandidate(parsed.pathname || '');
            const segs = path.split('/').filter(Boolean);
            if (!segs.length) return null;
            const HEX_HASH_RE = /^[a-f0-9]{32,}$/i;
            let start = 0;
            while (start < segs.length) {
                const seg = segs[start];
                if (seg === serviceId || HEX_HASH_RE.test(seg)) { start++; continue; }
                break;
            }
            const real = segs.slice(start).join('/');
            return real || null;
        } catch { return null; }
    };

    const getExpiredAttachmentVisiblePath = (remotePath, fallback = 'file') => {
        const n = normalizeAttachmentPathCandidate(remotePath);
        if (n) return n;
        return normalizeAttachmentPathCandidate(fallback) || 'file';
    };

    const buildDisplayExpiredAttachmentHref = (remotePath, fallback = 'file') => {
        const visible = getExpiredAttachmentVisiblePath(remotePath, fallback);
        return `${EXPIRED_ATTACHMENT_URL_ORIGIN}/${_encodePathSegments(visible)}`;
    };

    const LINK_LABEL_MAX_DISPLAY_CHARS = 32;
    const truncateLabelForDisplay = (label) => {
        if (!label) return label;
        if (label.length <= LINK_LABEL_MAX_DISPLAY_CHARS) return label;
        return '\u2026' + label.slice(label.length - (LINK_LABEL_MAX_DISPLAY_CHARS - 1));
    };

    const normalizeTrailingInlineToken = (value) => {
        if (!value) return value;
        let out = value;
        out = out.replace(/[.,;:!?]+$/, '');
        const trimUnmatched = (openCh, closeCh) => {
            while (out.endsWith(closeCh)) {
                const openCount = (out.match(new RegExp('\\' + openCh, 'g')) || []).length;
                const closeCount = (out.match(new RegExp('\\' + closeCh, 'g')) || []).length;
                if (closeCount > openCount) out = out.slice(0, -1);
                else break;
            }
        };
        trimUnmatched('(', ')');
        trimUnmatched('[', ']');
        trimUnmatched('{', '}');
        out = out.replace(/[`'"*>]+$/, '');
        return out;
    };

    // HTML-escape a string for use as element text or attribute value.
    const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));

    // Render an extracted file fence as an `<a>` HTML string. Embedded into
    // the markdown source via placeholder; marked passes raw HTML through.
    const fileToAnchorHtml = (filename, href) => {
        const text = '\u2197 ' + filename;
        return `<a class="bq-file-download" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" download="${escapeAttr(filename)}">${escapeAttr(text)}</a>`;
    };

    // Render an extracted link (link/src::/path/url) as an `<a>` HTML string
    // carrying data-bq-* attributes that the bubble's click delegation reads
    // to dispatch expired-link refresh.
    const linkToAnchorHtml = (link, ctx) => {
        const refreshing = !!(ctx && ctx.refreshingSet && ctx.refreshingSet.has(link.expiredHref || link.href));
        const cls = ['bq-link-button'];
        if (link.expired) cls.push('is-expired');
        if (refreshing) cls.push('is-refreshing');
        const labelText = '\u2197 ' + link.label + (refreshing ? ' (fetching...)' : '');
        const attrs = [
            `class="${cls.join(' ')}"`,
            `href="${escapeAttr(link.href)}"`,
            `target="_blank"`,
            `rel="noopener noreferrer"`,
            `title="${escapeAttr(link.fullLabel || link.label)}"`,
            `download="${escapeAttr(link.fullLabel || link.label)}"`,
            `data-bq-link="1"`,
        ];
        if (link.expired) attrs.push(`data-bq-expired="1"`);
        if (link.expiredHref) attrs.push(`data-bq-expired-href="${escapeAttr(link.expiredHref)}"`);
        if (link.remotePath) attrs.push(`data-bq-remote-path="${escapeAttr(link.remotePath)}"`);
        if (link.originalHref) attrs.push(`data-bq-original-href="${escapeAttr(link.originalHref)}"`);
        if (link.fullLabel) attrs.push(`data-bq-full-label="${escapeAttr(link.fullLabel)}"`);
        return `<a ${attrs.join(' ')}>${escapeAttr(labelText)}</a>`;
    };

    // Resolve a regex match from createInlineLinkRegex into a link object,
    // or null if it can't be parsed. ctx provides `serviceId` (for CDN-prefix
    // stripping) and `refreshedMap` (cached fresh hrefs keyed by expiredHref).
    const buildLinkPartFromGroups = (full, g1, g2, g3, g4, g5, g6, ctx) => {
        const serviceId = ctx && ctx.serviceId;
        const refreshedMap = (ctx && ctx.refreshedMap) || {};
        if (g1) {
            const rawPath = normalizeTrailingInlineToken(g1);
            const consumed = 'src::' + rawPath;
            const tail = full.slice(consumed.length);
            const isUrl = /^https?:\/\//i.test(rawPath);
            if (isUrl && /^https:\/\//i.test(rawPath)) {
                return {
                    part: {
                        label: truncateLabelForDisplay(rawPath),
                        fullLabel: rawPath,
                        href: rawPath,
                        expired: false,
                    },
                    tail,
                };
            }
            const remotePath = isUrl
                ? (extractRemotePathFromAttachmentHref(rawPath, serviceId) || normalizeAttachmentPathCandidate(rawPath))
                : normalizeAttachmentPathCandidate(rawPath);
            if (!remotePath) return null;
            const expiredHref = buildDisplayExpiredAttachmentHref(remotePath, remotePath);
            const cached = refreshedMap[expiredHref];
            const originalHref = isUrl ? rawPath : undefined;
            return {
                part: {
                    label: truncateLabelForDisplay(remotePath),
                    fullLabel: remotePath,
                    href: cached || expiredHref,
                    expired: !cached,
                    expiredHref,
                    remotePath,
                    originalHref,
                },
                tail,
            };
        }
        if (g4 && g5) {
            const rawPath = g5;
            const remotePath = normalizeAttachmentPathCandidate(rawPath);
            if (!remotePath) return null;
            const expiredHref = buildDisplayExpiredAttachmentHref(remotePath, remotePath);
            const cached = refreshedMap[expiredHref];
            return {
                part: {
                    label: truncateLabelForDisplay(g4),
                    fullLabel: g4,
                    href: cached || expiredHref,
                    expired: !cached,
                    expiredHref,
                    remotePath,
                },
            };
        }
        const originalHref = g3 || g6 || '';
        if (!originalHref) return null;
        if (/^https:\/\//i.test(originalHref)) {
            const plainLabel = g2 || originalHref;
            return {
                part: {
                    label: truncateLabelForDisplay(plainLabel),
                    fullLabel: plainLabel,
                    href: originalHref,
                    expired: false,
                },
            };
        }
        const remotePath = extractRemotePathFromAttachmentHref(originalHref, serviceId);
        const fallbackLabel = g2 || originalHref;
        const expiredHref = remotePath
            ? buildDisplayExpiredAttachmentHref(remotePath, fallbackLabel)
            : originalHref;
        const cached = refreshedMap[expiredHref];
        const expired = !!remotePath && !cached;
        const fullLabel = remotePath
            ? getExpiredAttachmentVisiblePath(remotePath, g2 || originalHref)
            : (g2 || originalHref);
        return {
            part: {
                label: truncateLabelForDisplay(fullLabel),
                fullLabel,
                href: cached || expiredHref,
                expired,
                expiredHref,
                remotePath: remotePath || undefined,
                originalHref,
            },
        };
    };

    // ----- file-fence helpers (mirrors agent.vue) ---------------------------
    // Only `\`\`\`filename.ext\n...\n\`\`\`` fences become downloadable file
    // anchors (matches the host system prompt in agent.vue). Bare-language
    // fences like \`\`\`html / \`\`\`csv render as normal code blocks.

    // Minimal MIME table for the file extensions the host agent is known to
    // emit. Anything else falls back to text/plain so the browser still
    // downloads the blob as a text file.
    const FENCE_MIME_TYPES = {
        html: 'text/html',
        htm: 'text/html',
        csv: 'text/csv',
        tsv: 'text/tab-separated-values',
        json: 'application/json',
        xml: 'application/xml',
        svg: 'image/svg+xml',
        md: 'text/markdown',
        yaml: 'text/yaml',
        yml: 'text/yaml',
        txt: 'text/plain',
        sql: 'application/sql',
        css: 'text/css',
    };

    // Open (still-streaming) filename fence, used to suppress the raw fence
    // text mid-typewriter.
    const OPEN_FENCE_FILENAME_RE = /```([\w.-]+\.[a-zA-Z0-9]+)\n?/;

    // Cache blob URLs keyed by (filename + content) so re-renders don't leak
    // a fresh ObjectURL on every tick of streaming text.
    const _fileBlobCache = new Map();
    const _getOrCreateFileHref = (filename, body) => {
        const key = filename + '\u0000' + body;
        const existing = _fileBlobCache.get(key);
        if (existing) return existing;
        const ext = (filename.split('.').pop() || '').toLowerCase();
        const type = FENCE_MIME_TYPES[ext] || 'text/plain';
        const blob = new Blob([body], { type });
        const href = URL.createObjectURL(blob);
        _fileBlobCache.set(key, href);
        return href;
    };

    // Split message content into renderable parts. When `marked` is loaded,
    // returns a single `{type:'html', html}` part containing the full
    // markdown-rendered bubble (with file/link anchors spliced back in).
    // When marked is not yet loaded, returns `{type:'fallback', text}` so the
    // bubble can render plain text until marked finishes loading.
    //
    // Mirrors agent.vue's parseMsgParts:
    //   1. extract closed file fences `\`\`\`filename.ext\n...\`\`\`` → file anchors
    //   2. mid-typewriter unclosed file fence → `[generating filename...]`
    //   3. mask inline `\`code\`` spans so links inside aren't extracted
    //   4. extract inline links (src::, [label](url), [label](path), bare URL)
    //      via createInlineLinkRegex → link anchors with data-bq-* attrs
    //   5. restore code masks
    //   6. marked.parse(working, { gfm:true, breaks:true })
    //   7. splice placeholders back as raw anchor HTML
    const parseMsgParts = (content, msgKey, ctx) => {
        if (!content) return [];
        ctx = ctx || {};
        const marked = (typeof global.marked !== 'undefined' && global.marked && global.marked.parse) ? global.marked : null;

        // Always extract files/links so the fallback text branch can still
        // render placeholders if we hit it. But the placeholder strategy
        // only works when marked is available; otherwise just hand the raw
        // content back as a plain-text fallback (marked load triggers a
        // re-render).
        if (!marked) {
            // Trigger lazy load if not already in flight, then re-render
            // once it resolves. The instance hooks this callback in via
            // `ctx.onMarkedReady`.
            if (ctx.onMarkedReady) {
                _getMarked().then((m) => { if (m) ctx.onMarkedReady(); });
            }
            return [{ type: 'fallback', text: content }];
        }

        const placeholderHtml = [];
        const PH = (idx) => `\uE000BQ${idx}\uE001`;
        const push = (anchorHtml) => {
            const idx = placeholderHtml.length;
            placeholderHtml.push(anchorHtml);
            return PH(idx);
        };

        // 1. Closed filename fences: ```filename.ext\n...\n```
        let working = content.replace(
            /```([\w.-]+\.[a-zA-Z0-9]+)\n([\s\S]*?)```/g,
            (_full, filename, body) =>
                push(fileToAnchorHtml(filename, _getOrCreateFileHref(filename, body))),
        );

        // 2. Mid-typewriter unclosed fence → hide raw streaming source.
        if (ctx.isTyping) {
            const open = working.match(OPEN_FENCE_FILENAME_RE);
            if (open && typeof open.index === 'number') {
                const dots = '.'.repeat(((ctx.dotTick || 0) % 3) + 1);
                working = working.slice(0, open.index) + `\n[generating ${open[1]}${dots}]`;
            }
        }

        // 3. Mask inline code spans so links inside backticks survive.
        const codeMasks = [];
        working = working.replace(/`[^`\n]+`/g, (m) => {
            const idx = codeMasks.length;
            codeMasks.push(m);
            return `\uE002C${idx}\uE003`;
        });

        // 4. Extract inline links/sources via createInlineLinkRegex.
        const linkRe = createInlineLinkRegex();
        working = working.replace(linkRe, (full, g1, g2, g3, g4, g5, g6) => {
            const built = buildLinkPartFromGroups(full, g1, g2, g3, g4, g5, g6, ctx);
            if (!built) return full;
            const placeholder = push(linkToAnchorHtml(built.part, ctx));
            return placeholder + (built.tail || '');
        });

        // 5. Restore code spans for marked to format.
        working = working.replace(/\uE002C(\d+)\uE003/g, (_m, idx) => codeMasks[Number(idx)] || '');

        // 6. Markdown → HTML.
        let html;
        try {
            html = marked.parse(working, { gfm: true, breaks: true, async: false });
        } catch (err) {
            console.error('[BunnyQuery] marked.parse failed', err);
            html = escapeAttr(working);
        }

        // 7. Splice anchor placeholders back.
        const finalHtml = html.replace(
            /\uE000BQ(\d+)\uE001/g,
            (_m, idx) => placeholderHtml[Number(idx)] || '',
        );

        return [{ type: 'html', html: finalHtml }];
    };

    // ----- helpers ----------------------------------------------------------
    const $ = (tag, attrs, children) => {
        const el = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                if (k === 'class') el.className = attrs[k];
                else if (k === 'style') Object.assign(el.style, attrs[k]);
                else if (k === 'dataset') Object.assign(el.dataset, attrs[k]);
                else if (k.startsWith('on') && typeof attrs[k] === 'function') {
                    el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
                } else if (attrs[k] != null && attrs[k] !== false) {
                    el.setAttribute(k, attrs[k]);
                }
            }
        }
        if (children != null) {
            (Array.isArray(children) ? children : [children]).forEach((c) => {
                if (c == null || c === false) return;
                el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
            });
        }
        return el;
    };

    const safeJSONParse = (raw) => {
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    };

    // ----- PKCE helpers -----------------------------------------------------
    const b64url = (bytes) => {
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const randomBytes = (n) => {
        const b = new Uint8Array(n);
        crypto.getRandomValues(b);
        return b;
    };
    const codeChallengeFor = async (verifier) => {
        if (crypto && crypto.subtle && crypto.subtle.digest) {
            try {
                const data = new TextEncoder().encode(verifier);
                const hash = await crypto.subtle.digest('SHA-256', data);
                return { challenge: b64url(new Uint8Array(hash)), method: 'S256' };
            } catch (_) { /* fall through */ }
        }
        return { challenge: verifier, method: 'plain' };
    };

    // ===== MCP OAuth ========================================================
    class McpOAuth {
        constructor(baseUrl) {
            this.baseUrl = baseUrl.replace(/\/$/, '');
        }

        get redirectUri() {
            // Strip any oauth params so the registered URI is stable across
            // login attempts on the same page.
            const u = new URL(window.location.href);
            u.search = '';
            u.hash = '';
            return u.toString();
        }

        getStoredClient() {
            return safeJSONParse(localStorage.getItem(CLIENT_KEY));
        }

        getStoredToken() {
            return safeJSONParse(localStorage.getItem(TOKEN_KEY));
        }

        clearToken() {
            localStorage.removeItem(TOKEN_KEY);
        }

        async register(force = false) {
            // The dynamically registered client is keyed by its redirect_uri
            // AND the MCP host - swapping MCP_BASE_URL must trigger a fresh
            // registration since the old client_id is unknown to the new host.
            const existing = this.getStoredClient();
            if (
                !force
                && existing
                && existing.redirect_uri === this.redirectUri
                && existing.base_url === this.baseUrl
            ) return existing;

            const res = await fetch(`${this.baseUrl}/oauth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    client_name: 'bunnyquery-embed',
                    grant_types: ['authorization_code', 'refresh_token'],
                    response_types: ['code'],
                    redirect_uris: [this.redirectUri],
                    token_endpoint_auth_method: 'client_secret_basic',
                }),
            });
            if (!res.ok) {
                throw new Error(`MCP /oauth/register failed: ${res.status} ${await res.text().catch(() => '')}`);
            }
            const json = await res.json();
            if (!json.client_id) throw new Error('MCP register missing client_id');
            const stored = {
                ...json,
                redirect_uri: this.redirectUri,
                base_url: this.baseUrl,
                registered_at: Date.now(),
            };
            localStorage.setItem(CLIENT_KEY, JSON.stringify(stored));
            return stored;
        }

        async startAuthorize() {
            const client = await this.register();
            const codeVerifier = b64url(randomBytes(32));
            const { challenge, method } = await codeChallengeFor(codeVerifier);
            const state = b64url(randomBytes(16));
            sessionStorage.setItem(
                STATE_KEY,
                JSON.stringify({ state, codeVerifier, returnTo: window.location.href })
            );
            const params = new URLSearchParams({
                response_type: 'code',
                client_id: client.client_id,
                redirect_uri: this.redirectUri,
                state,
                code_challenge: challenge,
                code_challenge_method: method,
            });
            window.location.href = `${this.baseUrl}/oauth/authorize?${params.toString()}`;
        }

        // Direct token handoff: hand the host-service skapi session to MCP
        // without bouncing through the SKAPI_LOGIN_PAGE redirect chain. The
        // server creates an authorization code from the supplied id_token,
        // we exchange it for an MCP access_token via the standard
        // /oauth/token endpoint, and persist it. No URL navigation occurs.
        async exchangeSession(skapiSession) {
            if (!skapiSession || !skapiSession.idToken || !skapiSession.accessToken) {
                throw new Error('Missing skapi session tokens; user is not logged in');
            }
            let client = await this.register();

            const buildExchangeBody = (clientId) => JSON.stringify({
                client_id: clientId,
                redirect_uri: this.redirectUri,
                id_token: skapiSession.idToken.jwtToken,
                access_token: skapiSession.accessToken.jwtToken,
                refresh_token:
                    (skapiSession.refreshToken && skapiSession.refreshToken.token) || '',
            });
            const postExchange = (clientId) => fetch(`${this.baseUrl}/oauth/session-exchange`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: buildExchangeBody(clientId),
            });
            let exchangeRes = await postExchange(client.client_id);
            // Stale client_id (MCP host swapped, server lost registrations,
            // etc.): force a fresh /oauth/register and retry once.
            if (exchangeRes.status === 401) {
                client = await this.register(true);
                exchangeRes = await postExchange(client.client_id);
            }
            if (!exchangeRes.ok) {
                throw new Error(
                    `MCP /oauth/session-exchange failed: ${exchangeRes.status} ${await exchangeRes
                        .text()
                        .catch(() => '')}`
                );
            }
            const exchangeText = await exchangeRes.text();
            if (!exchangeText) {
                throw new Error(
                    'MCP /oauth/session-exchange returned an empty body. The MCP server at ' +
                    this.baseUrl +
                    ' likely does not have the /oauth/session-exchange endpoint deployed.'
                );
            }
            let exchangeJson;
            try { exchangeJson = JSON.parse(exchangeText); }
            catch (_) {
                throw new Error('MCP /oauth/session-exchange returned non-JSON: ' + exchangeText.slice(0, 200));
            }
            if (!exchangeJson || !exchangeJson.code) {
                throw new Error('MCP session-exchange response missing code');
            }

            const body = new URLSearchParams({
                grant_type: 'authorization_code',
                code: exchangeJson.code,
                redirect_uri: this.redirectUri,
                client_id: client.client_id,
            });
            const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            if (client.client_secret) {
                headers.Authorization =
                    'Basic ' + btoa(`${client.client_id}:${client.client_secret}`);
            }
            const tokenRes = await fetch(`${this.baseUrl}/oauth/token`, {
                method: 'POST',
                headers,
                body: body.toString(),
            });
            if (!tokenRes.ok) {
                throw new Error(
                    `MCP /oauth/token failed: ${tokenRes.status} ${await tokenRes
                        .text()
                        .catch(() => '')}`
                );
            }
            const json = await tokenRes.json();
            if (!json.access_token) throw new Error('MCP token response missing access_token');
            const token = {
                ...json,
                expires_at:
                    typeof json.expires_in === 'number'
                        ? Date.now() + json.expires_in * 1000
                        : undefined,
            };
            localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
            return token;
        }

        // Detect whether the current URL contains a successful MCP OAuth
        // callback whose state matches a flow we started on this device.
        isCallbackInUrl() {
            const sp = new URLSearchParams(window.location.search);
            const code = sp.get('code');
            const state = sp.get('state');
            if (!code || !state) return false;
            const stored = safeJSONParse(sessionStorage.getItem(STATE_KEY));
            return !!(stored && stored.state === state);
        }

        async completeFromUrl() {
            const sp = new URLSearchParams(window.location.search);
            const code = sp.get('code');
            const state = sp.get('state');
            const stored = safeJSONParse(sessionStorage.getItem(STATE_KEY));
            sessionStorage.removeItem(STATE_KEY);
            if (!stored || stored.state !== state) {
                throw new Error('MCP OAuth state mismatch');
            }
            const client = this.getStoredClient();
            if (!client) throw new Error('No registered MCP client');

            const body = new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: this.redirectUri,
                code_verifier: stored.codeVerifier,
                client_id: client.client_id,
            });
            const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            if (client.client_secret) {
                headers.Authorization = 'Basic ' + btoa(`${client.client_id}:${client.client_secret}`);
            }
            const res = await fetch(`${this.baseUrl}/oauth/token`, {
                method: 'POST',
                headers,
                body: body.toString(),
            });
            if (!res.ok) {
                throw new Error(`MCP /oauth/token failed: ${res.status} ${await res.text().catch(() => '')}`);
            }
            const json = await res.json();
            if (!json.access_token) throw new Error('MCP token response missing access_token');
            const token = {
                ...json,
                expires_at:
                    typeof json.expires_in === 'number'
                        ? Date.now() + json.expires_in * 1000
                        : undefined,
            };
            localStorage.setItem(TOKEN_KEY, JSON.stringify(token));

            // Clean the OAuth params out of the URL so reloads do not retry.
            const url = new URL(window.location.href);
            url.searchParams.delete('code');
            url.searchParams.delete('state');
            history.replaceState({}, '', url.toString());
            return token;
        }
    }

    // ===== AI agent calls (mirrors src/code/ai_agent.ts) ====================
    function buildClaudeRequest(skapi, { service, owner, prompt, messages, system, model }) {
        const msgList = messages && messages.length
            ? messages
            : [{ role: 'user', content: prompt }];
        const request = {
            clientSecretName: 'claude',
            poll: DEFAULTS.POLL_INTERVAL,
            queue: service,
            service,
            owner,
            url: DEFAULTS.ANTHROPIC_MESSAGES_API_URL,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': '$CLIENT_SECRET',
                'anthropic-version': DEFAULTS.ANTHROPIC_VERSION,
                'anthropic-beta': DEFAULTS.ANTHROPIC_BETA_HEADER,
            },
            data: {
                model: model || DEFAULTS.DEFAULT_CLAUDE_MODEL,
                max_tokens: DEFAULTS.MAX_TOKENS,
                ...(system
                    ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }
                    : {}),
                messages: msgList,
                mcp_servers: [
                    {
                        type: 'url',
                        name: DEFAULTS.MCP_NAME,
                        url: _mcpBaseUrl(),
                        authorization_token: '$ACCESS_TOKEN',
                    },
                ],
                tools: [
                    { type: 'mcp_toolset', mcp_server_name: DEFAULTS.MCP_NAME },
                    {
                        type: 'web_fetch_20250910',
                        name: 'web_fetch',
                        max_uses: 40,
                        citations: { enabled: true },
                        max_content_tokens: 200000,
                    },
                ],
            },
        };
        return skapi.clientSecretRequest(request);
    }

    function buildOpenAIRequest(skapi, { service, owner, prompt, messages, system, model }) {
        const msgList = messages && messages.length
            ? messages
            : [{ role: 'user', content: prompt }];
        const input = [
            ...(system ? [{ role: 'system', content: system }] : []),
            ...msgList.map((m) => ({ role: m.role, content: m.content })),
        ];
        return skapi.clientSecretRequest({
            clientSecretName: 'openai',
            poll: DEFAULTS.POLL_INTERVAL,
            queue: service,
            service,
            owner,
            url: DEFAULTS.OPENAI_RESPONSES_API_URL,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                Authorization: 'Bearer $CLIENT_SECRET',
            },
            data: {
                model: model || DEFAULTS.DEFAULT_OPENAI_MODEL,
                max_output_tokens: DEFAULTS.MAX_TOKENS,
                input,
                tools: [
                    {
                        type: 'mcp',
                        server_label: DEFAULTS.MCP_NAME,
                        server_url: _mcpBaseUrl(),
                        require_approval: 'never',
                        headers: { Authorization: 'Bearer $ACCESS_TOKEN' },
                    },
                    { type: 'web_search', external_web_access: true },
                ],
            },
        });
    }

    function getChatHistory(skapi, { service, owner, platform }, fetchOptions) {
        const url =
            platform === 'claude'
                ? DEFAULTS.ANTHROPIC_MESSAGES_API_URL
                : DEFAULTS.OPENAI_RESPONSES_API_URL;
        return skapi.clientSecretRequestHistory(
            { url, method: 'POST', service, owner, queue: service, poll: DEFAULTS.POLL_INTERVAL },
            Object.assign({ ascending: false }, fetchOptions || {})
        );
    }

    function extractClaudeText(response) {
        if (!response || !Array.isArray(response.content)) return '';
        return response.content
            .filter((b) => b && b.type === 'text')
            .map((b) => b.text || '')
            .join('\n');
    }

    function extractOpenAIText(response) {
        if (!response) return '';
        if (typeof response.output_text === 'string' && response.output_text.length) {
            return response.output_text;
        }
        if (Array.isArray(response.output)) {
            const txt = response.output
                .flatMap((it) => (it && it.content) || [])
                .filter((p) => p && p.type === 'output_text')
                .map((p) => p.text || '')
                .join('\n')
                .trim();
            if (txt) return txt;
        }
        const c =
            response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content;
        return typeof c === 'string' ? c : '';
    }

    // Mirror of agent.vue's getErrorMessage — pulls the most useful string
    // out of either a thrown error or an error-shaped response body.
    function getErrorMessage(err) {
        if (typeof err === 'string') return err;
        if (err && err.body && err.body.error && typeof err.body.error.message === 'string') {
            return err.body.error.message;
        }
        if (err && err.error && typeof err.error.message === 'string') {
            return err.error.message;
        }
        if (err && typeof err.message === 'string') return err.message;
        return 'Request failed. Please try again.';
    }

    // Detect MCP / upstream "your access token is no longer valid" failures
    // so we can transparently re-mint the MCP token from the live skapi
    // session and retry the call once. Patterns observed in the wild:
    //   - skapi-js inside the MCP server throws "Token has expired"
    //     (surfaces here as part of err.message or response body text)
    //   - MCP returns OAuth-style error codes: invalid_token / expired_token
    //   - Proxy wraps it with INVALID_REQUEST + 401
    function _isAuthExpiredError(input) {
        if (!input) return false;
        const blobs = [];
        const push = (v) => { if (typeof v === 'string' && v) blobs.push(v); };
        if (typeof input === 'string') push(input);
        else {
            push(input.message);
            push(input.code);
            if (input.error) {
                push(input.error.message);
                push(input.error.code);
                push(input.error.type);
            }
            if (input.body) {
                push(input.body.message);
                if (input.body.error) {
                    push(input.body.error.message);
                    push(input.body.error.code);
                    push(input.body.error.type);
                }
            }
            if (typeof input.status === 'number' && input.status === 401) return true;
            if (typeof input.status_code === 'number' && input.status_code === 401) return true;
        }
        const hay = blobs.join(' | ').toLowerCase();
        if (!hay) return false;
        return (
            hay.includes('token has expired') ||
            hay.includes('token is expired') ||
            hay.includes('expired_token') ||
            hay.includes('invalid_token') ||
            hay.includes('unauthorized') ||
            hay.includes('not authorized') ||
            (hay.includes('invalid_request') && hay.includes('token'))
        );
    }

    // Mirror of agent.vue's isErrorResponseBody — detects provider/proxy
    // error payloads that should render as a red error bubble even when
    // no exception was thrown.
    function isErrorResponseBody(response) {
        if (!response || typeof response !== 'object') return false;
        if (typeof response.status_code === 'number' && response.status_code >= 400) return true;
        if (response.type === 'error') return true;
        if (response.error && (response.error.message || response.error.type)) return true;
        const body = response.body;
        if (body && typeof body === 'object') {
            if (body.type === 'error') return true;
            if (body.error && (body.error.message || body.error.type)) return true;
        }
        if (typeof response.message === 'string' && response.message.length) {
            const hasClaudeBody = Array.isArray(response.content);
            const hasOpenAIBody =
                typeof response.output_text === 'string' ||
                Array.isArray(response.output) ||
                Array.isArray(response.choices);
            if (!hasClaudeBody && !hasOpenAIBody) return true;
        }
        return false;
    }

    // Walk the persisted history list returned by clientSecretRequestHistory
    // and turn it into a flat user/assistant list ordered oldest -> newest.
    function mapHistoryToMessages(list, platform) {
        const out = [];
        // History pages return newest first; iterate in reverse so the chat
        // log reads naturally top-to-bottom.
        for (let i = list.length - 1; i >= 0; i--) {
            const item = list[i];
            const req = item && item.request_body;
            const res = item && item.response_body;

            // The user prompt is the LAST message of the request (Claude
            // appends history before the new prompt; OpenAI uses `input`).
            let userTurn = '';
            const reqMsgs = (req && (req.messages || req.input)) || [];
            for (let j = reqMsgs.length - 1; j >= 0; j--) {
                const m = reqMsgs[j];
                if (m && m.role === 'user') {
                    userTurn = typeof m.content === 'string'
                        ? m.content
                        : Array.isArray(m.content)
                            ? m.content.map((p) => (p && (p.text || p.input_text)) || '').join('')
                            : '';
                    break;
                }
            }
            if (userTurn) out.push({ role: 'user', content: userTurn, id: item.id });

            if (item.status === 'pending') {
                out.push({ role: 'assistant', content: '', id: item.id, isPending: true });
            } else if (item.status === 'failed' || isErrorResponseBody(res)) {
                out.push({
                    role: 'assistant',
                    content: getErrorMessage(res),
                    id: item.id,
                    isError: true,
                });
            } else {
                const text = platform === 'claude' ? extractClaudeText(res) : extractOpenAIText(res);
                out.push({ role: 'assistant', content: text, id: item.id });
            }
        }
        return out;
    }

    // ===== Embed UI =========================================================
    class BunnyQuery {
        constructor(skapi, info, container) {
            this.skapi = skapi;
            this.info = info;
            this.container = container;
            this.container.classList.add('bq-agent');

            // The Connection payload from skapi.__connection does NOT carry
            // service/owner ids - those live on the skapi instance itself
            // (see skapi-js/src/Types.ts -> Connection). The freeze flag is
            // nested under `opt`.
            this.serviceId = skapi.service;
            this.ownerId = skapi.owner;
            this.projectName = info.service_name || '';
            this.projectDescription = info.service_description || '';

            const ai = String(info.ai_agent || '').split('#');
            this.platform = (ai[0] || '').toLowerCase(); // 'claude' | 'openai'
            this.model = ai[1] || '';

            this.readOnly = !!(info.opt && info.opt.freeze_database);

            this.oauth = new McpOAuth(_mcpBaseUrl());

            this.messages = [];
            this.attachments = [];
            this.startKeyHistory = null;
            this.endOfList = false;
            this.sending = false;
            this.uploading = false;
            this.pendingTimer = null;
            this._pollingPending = false;
            this._loadingOlder = false;
            this._loadingFirstHistory = false;
            this._initialHistoryLoaded = false;
            this._isPromptComposing = false;

            this.refs = {};

            // Cache of expired-href -> fresh signed URL. Populated on
            // demand the first time a user clicks a `[label](path)` or
            // `src::token` source link, so subsequent clicks (and reflows
            // that re-render the bubble) reuse the same signed URL.
            this._refreshedLinkMap = Object.create(null);

            // Set of expired-hrefs currently in flight to getTemporaryUrl,
            // used to render "(fetching...)" labels and dedupe parallel
            // clicks on the same anchor.
            this._refreshingLinkSet = new Set();
            this._refreshingLinkPromises = new Map();

            // Animated dots for typewriter [generating filename...] labels.
            this._dotTick = 0;
            this._dotTickTimer = null;

            // Typewriter state. While `typing` is true the latest assistant
            // bubble streams character-by-character; while `typingAbort` is
            // true any active typewriter unwinds to the full text.
            this.typing = false;
            this._typingAbort = false;
            this._typewriterQueue = Promise.resolve();

            this._injectStylesheetOnce();
            this._bootstrap();
        }

        static async init(skapi, elementId, dev) {
            const container = typeof elementId === 'string'
                ? document.getElementById(elementId)
                : elementId;
            if (!container) throw new Error(`BunnyQuery: container "${elementId}" not found`);
            // When `dev` is truthy, route every MCP call (Claude tool URL,
            // OpenAI tool URL, and OAuth) to the dev host. Setting the
            // static here makes the change visible to any subsequent
            // BunnyQuery instance on the page; pass `false` (or omit) to
            // pin back to production.
            BunnyQuery.MCP_BASE_URL = dev ? DEFAULTS.MCP_DEV_BASE_URL : DEFAULTS.MCP_BASE_URL;
            const info = await skapi.__connection;
            console.log('[BunnyQuery] initializing with info', info);
            return new BunnyQuery(skapi, info, container);
        }

        // ---- bootstrap order ----------------------------------------------
        async _bootstrap() {
            // 0. Refresh connection info to ensure latest configuration.
            try {
                const info = await this.skapi.getConnectionInfo({ refresh: true });
                const ai = String(info.ai_agent || '').split('#');
                this.platform = (ai[0] || '').toLowerCase(); // 'claude' | 'openai'
                this.model = ai[1] || '';
            } catch (_) {
                // Non-fatal; continue with existing connection info
            }

            // 1. Validate that the project has a configured AI platform.
            if (!this.platform) {
                this._renderFatal('This project does not have an AI agent configured yet. Please ask the project owner to set up an AI agent in the project settings page.');
                return;
            }

            // 2. If we just came back from the MCP authorize redirect,
            //    finish the token exchange before doing anything else.
            try {
                if (this.oauth.isCallbackInUrl()) {
                    this._renderLoading(''); //Finalizing authorization
                    await this.oauth.completeFromUrl();
                }
            } catch (err) {
                this._renderFatal('MCP authorization failed: ' + (err && err.message ? err.message : err));
                return;
            }

            // 3. Decide whether to show the login form or the chat.
            await this._refreshGate();
        }

        async _refreshGate() {
            let profile = null;
            try {
                profile = await this.skapi.getProfile();
            } catch (_) { profile = null; }

            // Cache for the settings modal so it can show the current email
            // and decide whether to expose the password form (openid users
            // can't change passwords through Cognito).
            this.profile = profile;

            if (!profile) {
                this._renderLogin();
                return;
            }
            if (!this.oauth.getStoredToken()) {
                // Logged into the host service but MCP has not seen this
                // session yet. Hand the skapi tokens to MCP directly - no
                // redirect chain through bunnyquery.com.
                this._renderLoading(''); //Authorizing MCP server
                try {
                    await this.oauth.exchangeSession(this.skapi.session);
                } catch (err) {
                    this._renderFatal('MCP authorization failed: ' + (err && err.message ? err.message : err));
                    return;
                }
            }
            this._renderChat();
            await this._loadFirstHistoryPage();
        }

        // ---- rendering ----------------------------------------------------
        _clear() {
            while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
            this.refs = {};
        }

        _renderLoading(label) {
            this._clear();
            this.container.appendChild(
                $('div', { class: 'bq-gate-loading' }, [
                    $('span', { class: 'bq-loader' }, label || ''),
                ])
            );
        }

        _renderFatal(msg) {
            this._clear();
            this.container.appendChild(
                $('div', { class: 'bq-apikey-overlay' }, [
                    $('div', { class: 'bq-apikey-overlay-inner' }, [
                        $('p', { class: 'bq-apikey-error' }, msg),
                    ]),
                ])
            );
        }

        _renderLogin(prefill) {
            this._clear();
            const errLabel = $('p', { class: 'bq-apikey-error', style: { display: 'none' } });
            const noteLabel = $('p', { class: 'bq-login-note', style: { display: 'none' } });
            if (prefill && prefill.notice) {
                noteLabel.textContent = prefill.notice;
                noteLabel.style.display = '';
            }
            const userInput = $('input', {
                type: 'text',
                class: 'bq-input',
                placeholder: 'Email or username',
                autocomplete: 'username',
                value: (prefill && prefill.email) || '',
            });
            const passInput = $('input', {
                type: 'password',
                class: 'bq-input',
                placeholder: 'Password',
                autocomplete: 'current-password',
            });
            const submitBtn = $('button', { type: 'submit', class: 'btn bq-login-submit' }, [
                $('span', { class: 'bq-login-submit-label' }, 'Login'),
            ]);

            const forgotLink = $('button', {
                type: 'button',
                class: 'bq-login-link',
                onclick: () => this._renderForgotPassword({ email: userInput.value.trim() }),
            }, 'Forgot password?');

            const form = $('form', {
                class: 'bq-login-form',
                onsubmit: async (e) => {
                    e.preventDefault();
                    errLabel.style.display = 'none';
                    submitBtn.disabled = true;
                    submitBtn.classList.add('is-loading');
                    try {
                        await this.skapi.login({
                            email: userInput.value.trim(),
                            password: passInput.value,
                        });
                        // Successful host-service login -> hand the skapi
                        // session straight to MCP (no redirect round-trip).
                        await this.oauth.exchangeSession(this.skapi.session);
                        await this._refreshGate();
                    } catch (err) {
                        errLabel.textContent = (err && err.message) || String(err);
                        errLabel.style.display = '';
                        submitBtn.disabled = false;
                        submitBtn.classList.remove('is-loading');
                    }
                },
            }, [
                noteLabel,
                errLabel,
                userInput,
                passInput,
                submitBtn,
                $('div', { class: 'bq-login-actions' }, [forgotLink]),
            ]);

            this.container.appendChild(
                $('div', { class: 'bq-apikey-overlay' }, [
                    $('div', { class: 'bq-apikey-overlay-inner' }, [form]),
                ])
            );
        }

        _renderForgotPassword(prefill) {
            this._clear();
            const initialEmail = (prefill && prefill.email) || '';

            const errLabel = $('p', { class: 'bq-apikey-error', style: { display: 'none' } });
            const okLabel = $('p', { class: 'bq-login-note', style: { display: 'none' } });
            const setMsg = (text, ok) => {
                errLabel.style.display = 'none';
                okLabel.style.display = 'none';
                if (!text) return;
                const node = ok ? okLabel : errLabel;
                node.textContent = text;
                node.style.display = '';
            };

            const title = $('p', { class: 'bq-login-title' }, 'Reset password');

            // ----- Step 1: email -----------------------------------------
            const emailInput = $('input', {
                type: 'email',
                class: 'bq-input',
                placeholder: 'Email',
                autocomplete: 'username',
                value: initialEmail,
                required: true,
            });
            const sendBtn = $('button', { type: 'submit', class: 'btn bq-login-submit' }, [
                $('span', { class: 'bq-login-submit-label' }, 'Send code'),
            ]);
            const sendLabel = sendBtn.querySelector('.bq-login-submit-label');

            // ----- Step 2: code + new password (hidden until step 1 OK) --
            const codeInput = $('input', {
                type: 'text',
                class: 'bq-input',
                placeholder: 'Verification code',
                autocomplete: 'one-time-code',
                inputmode: 'numeric',
            });
            const newPwInput = $('input', {
                type: 'password',
                class: 'bq-input',
                placeholder: 'New password',
                autocomplete: 'new-password',
                minlength: '6',
            });
            const confirmPwInput = $('input', {
                type: 'password',
                class: 'bq-input',
                placeholder: 'Confirm new password',
                autocomplete: 'new-password',
                minlength: '6',
            });
            const resetBtn = $('button', { type: 'button', class: 'btn bq-login-submit' }, [
                $('span', { class: 'bq-login-submit-label' }, 'Reset password'),
            ]);
            const step2 = $('div', { class: 'bq-login-step', style: { display: 'none' } }, [
                codeInput,
                newPwInput,
                confirmPwInput,
                resetBtn,
            ]);

            resetBtn.onclick = async () => {
                setMsg('');
                const code = codeInput.value.trim();
                const np = newPwInput.value;
                const cp = confirmPwInput.value;
                if (!code) { setMsg('Enter the verification code.', false); return; }
                if (!np || np.length < 6) { setMsg('New password must be at least 6 characters.', false); return; }
                if (np !== cp) { setMsg('New password and confirmation do not match.', false); return; }
                resetBtn.disabled = true;
                resetBtn.classList.add('is-loading');
                try {
                    await this.skapi.resetPassword({
                        email: emailInput.value.trim(),
                        code,
                        new_password: np,
                    });
                    this._renderLogin({
                        email: emailInput.value.trim(),
                        notice: 'Password reset. Sign in with your new password.',
                    });
                } catch (err) {
                    setMsg((err && err.message) || String(err), false);
                    resetBtn.disabled = false;
                    resetBtn.classList.remove('is-loading');
                }
            };

            const backLink = $('button', {
                type: 'button',
                class: 'bq-login-link',
                onclick: () => this._renderLogin({ email: emailInput.value.trim() }),
            }, 'Back to login');

            const form = $('form', {
                class: 'bq-login-form',
                onsubmit: async (e) => {
                    e.preventDefault();
                    // Step 1 only: request the code.
                    const email = emailInput.value.trim();
                    if (!email) { setMsg('Enter your account email.', false); return; }
                    setMsg('');
                    sendBtn.disabled = true;
                    sendBtn.classList.add('is-loading');
                    try {
                        await this.skapi.forgotPassword({ email });
                        sendLabel.textContent = 'Resend code';
                        step2.style.display = '';
                        codeInput.focus();
                        setMsg('Verification code sent. Check your inbox.', true);
                    } catch (err) {
                        setMsg((err && err.message) || String(err), false);
                    } finally {
                        sendBtn.disabled = false;
                        sendBtn.classList.remove('is-loading');
                    }
                },
            }, [
                title,
                okLabel,
                errLabel,
                emailInput,
                sendBtn,
                step2,
                $('div', { class: 'bq-login-actions' }, [backLink]),
            ]);

            this.container.appendChild(
                $('div', { class: 'bq-apikey-overlay' }, [
                    $('div', { class: 'bq-apikey-overlay-inner' }, [form]),
                ])
            );
        }

        _renderChat() {
            this._clear();

            // Outer shell mirrors agent.vue: .bq-meta wraps a section title
            // (with the project name on the left and the clear / logout
            // icons on the right) and the chat surface below it.
            const meta = $('div', { class: 'bq-meta' });

            const titleText = this.projectName
                ? this.projectName
                : 'BunnyQuery';
            const platformLabel = this.platform === 'claude'
                ? 'Claude'
                : this.platform === 'openai'
                    ? 'OpenAI'
                    : 'Unknown';
            const modelLabel = this.model || (
                this.platform === 'claude'
                    ? DEFAULTS.DEFAULT_CLAUDE_MODEL
                    : this.platform === 'openai'
                        ? DEFAULTS.DEFAULT_OPENAI_MODEL
                        : 'N/A'
            );
            const titleLeft = $('div', { class: 'bq-title-left' }, [
                $('span', { class: 'bq-ai-status', title: `AI: ${platformLabel} / ${modelLabel}` }, `${platformLabel} · ${modelLabel}`),
            ]);

            const clearIcon = $('button', {
                type: 'button',
                class: 'bq-text-btn bq-text-btn--danger',
                title: 'Clear chat history',
                'aria-label': 'Clear chat history',
                onclick: () => this._onClearHistoryClick(),
            }, 'Clear');

            const settingsIcon = $('button', {
                type: 'button',
                class: 'bq-text-btn',
                title: 'Account settings',
                'aria-label': 'Account settings',
                onclick: () => this._openSettingsModal(),
            }, 'Settings');

            const logoutIcon = $('button', {
                type: 'button',
                class: 'bq-text-btn',
                title: 'Logout',
                'aria-label': 'Logout',
                onclick: () => this._logout(),
            }, 'Logout');

            const titleRight = $('div', { class: 'bq-title-right' }, [
                clearIcon,
                settingsIcon,
                logoutIcon,
            ]);

            const titleRow = $('div', { class: 'bq-title-row' }, [titleLeft, titleRight]);
            const sectionTitle = $('div', { class: 'bq-section-title' }, [titleRow]);

            const chat = $('div', { class: 'bq-chat' });
            const messagesBox = $('div', {
                class: 'bq-messages',
                onscroll: () => this._onHistoryScroll(),
            });

            // Input row
            const attachInput = $('input', {
                type: 'file',
                class: 'bq-attach-input',
                multiple: true,
                onchange: (e) => this._onAttachFromInput(e),
            });
            const textarea = $('textarea', {
                class: 'bq-input',
                rows: '1',
                placeholder: `Ask anything about ${this.projectName || 'the project'}...`,
                oninput: (e) => this._autoGrow(e.target),
                onkeydown: (e) => this._handlePromptEnter(e),
                oncompositionstart: () => {
                    this._isPromptComposing = true;
                },
                oncompositionend: () => this._handlePromptCompositionEnd(),
            });
            const sendBtn = $('button', { type: 'submit', class: 'btn' }, 'Send');

            const inputWrap = $('div', {
                class: 'bq-input-wrap no-attach',
            }, [
                attachInput,
                textarea,
            ]);
            const attachmentsBox = $('div', { class: 'bq-attachments', style: { display: 'none' } });
            const inputRow = $('form', {
                class: 'bq-input-row',
                onsubmit: (e) => { e.preventDefault(); this._sendMessage(); },
            }, [attachmentsBox, inputWrap, sendBtn]);

            chat.appendChild(messagesBox);
            chat.appendChild(inputRow);

            meta.appendChild(sectionTitle);
            meta.appendChild(chat);
            this.container.appendChild(meta);

            this.refs = {
                meta,
                chat,
                messagesBox,
                textarea,
                sendBtn,
                attachInput,
                attachmentsBox,
                clearIcon,
                logoutIcon,
            };

            this._renderMessages();
        }

        _renderMessages() {
            const box = this.refs.messagesBox;
            if (!box) return;
            const stickToBottom =
                box.scrollHeight - box.scrollTop - box.clientHeight < 80;
            box.innerHTML = '';

            if (!this._initialHistoryLoaded) {
                box.appendChild(
                    $('div', { class: 'bq-message is-assistant bq-empty-greeting' }, [
                        $('div', { class: 'bq-bubble' }, [
                            $('span', { class: 'bq-loader' }, 'Loading chat history'),
                        ]),
                    ])
                );
            } else if (!this.messages.length) {
                box.appendChild(
                    $('div', { class: 'bq-message is-assistant bq-empty-greeting' }, [
                        $('div', { class: 'bq-bubble' },
                            `Hi! Ask me anything about ${this.projectName || 'the project'}.`
                        ),
                    ])
                );
            }

            this.messages.forEach((msg) => {
                const bubble = $('div', { class: 'bq-bubble' });
                if (msg.isPending) {
                    bubble.appendChild($('span', { class: 'bq-loader' }, 'Thinking'));
                } else {
                    // Full markdown rendering via marked + placeholder
                    // substitution that preserves the bq-file-download /
                    // bq-link-button anchors with their data-bq-* attrs.
                    // A single delegated click handler dispatches expired-
                    // link refresh.
                    const parts = parseMsgParts(msg.content || '', msg, {
                        serviceId: this.serviceId,
                        refreshedMap: this._refreshedLinkMap,
                        refreshingSet: this._refreshingLinkSet,
                        isTyping: !!this.typing,
                        dotTick: this._dotTick,
                        onMarkedReady: () => this._renderMessages(),
                    });
                    if (!parts.length) {
                        bubble.textContent = msg.content || '';
                    } else if (parts.length === 1 && parts[0].type === 'html') {
                        const md = document.createElement('div');
                        md.className = 'bq-md';
                        md.innerHTML = parts[0].html;
                        md.addEventListener('click', (e) => this._onBubbleLinkClick(e));
                        bubble.appendChild(md);
                    } else if (parts.length === 1 && parts[0].type === 'fallback') {
                        // marked not loaded yet — show plain text; will
                        // re-render once `_getMarked()` resolves.
                        bubble.textContent = parts[0].text;
                    }
                }
                const wrapper = $('div', {
                    class:
                        'bq-message ' +
                        (msg.role === 'user' ? 'is-user' : 'is-assistant') +
                        (msg.isError ? ' is-error' : ''),
                }, [bubble]);
                box.appendChild(wrapper);
            });


            // Scroll to bottom if stickToBottom, or if the last message is a resolved assistant response
            const lastMsg = this.messages[this.messages.length - 1];
            if (
                stickToBottom ||
                (lastMsg && lastMsg.role === 'assistant' && !lastMsg.isPending && !lastMsg.isError)
            ) {
                // Use setTimeout to ensure DOM is updated before scrolling
                setTimeout(() => {
                    box.scrollTop = box.scrollHeight;
                }, 0);
            }

            // Hide the clear-history icon when there's nothing to clear.
            // Busy-state styling is handled in _updateInputDisabled() so it
            // stays in sync with the textarea/sendBtn after _sendMessage()
            // finishes (which only calls _updateInputDisabled, not
            // _renderMessages).
            if (this.refs.clearIcon) {
                this.refs.clearIcon.style.display = this.messages.length ? '' : 'none';
            }

            this._updateInputDisabled();
        }

        _updateInputDisabled() {
            const busy = this.sending || this.uploading || this.typing || this._anyPending() || this._loadingFirstHistory;
            if (this.refs.textarea) {
                this.refs.textarea.disabled = busy;
                this.refs.textarea.placeholder = busy
                    ? 'Request in process. Please wait...'
                    : `Ask anything about ${this.projectName || 'the project'}...`;
            }
            if (this.refs.sendBtn) this.refs.sendBtn.disabled = busy;
            if (this.refs.attachBtn) this.refs.attachBtn.disabled = busy;
            if (this.refs.clearIcon) this.refs.clearIcon.classList.toggle('disabled', busy);
            if (this.refs.logoutIcon) this.refs.logoutIcon.classList.toggle('disabled', busy);
        }

        _autoGrow(el) {
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 200) + 'px';
        }

        _handlePromptCompositionEnd() {
            this._isPromptComposing = false;
            if (this.refs.textarea) {
                this._autoGrow(this.refs.textarea);
            }
        }

        _handlePromptEnter(e) {
            if (e.key !== 'Enter' || e.shiftKey) return;
            if (e.isComposing || this._isPromptComposing || e.keyCode === 229 || e.which === 229) {
                return;
            }

            e.preventDefault();
            Promise.resolve().then(() => this._sendMessage());
        }

        _anyPending() {
            return this.messages.some((m) => m.isPending);
        }

        // ---- expired-link refresh + bubble click delegation ----------------
        // Click handler attached once per rendered bubble. Finds the closest
        // `a[data-bq-link]` ancestor; if the anchor is marked expired (i.e.
        // a source-path link the user has not refreshed yet), preventDefault
        // and round-trip through `getTemporaryUrl` to obtain a fresh signed
        // URL, then open it in a new tab. Cached on the instance so repeat
        // clicks (and re-renders) reuse the same URL.
        _onBubbleLinkClick(e) {
            const target = e.target;
            if (!target || !target.closest) return;
            const anchor = target.closest('a[data-bq-link]');
            if (!anchor) return;
            if (anchor.dataset.bqExpired !== '1') return; // normal link

            const expiredHref = anchor.dataset.bqExpiredHref || anchor.getAttribute('href') || '';
            const cached = this._refreshedLinkMap[expiredHref];
            if (cached) {
                anchor.href = cached;
                anchor.classList.remove('is-expired');
                return; // let the click proceed naturally
            }

            e.preventDefault();
            const remotePath = anchor.dataset.bqRemotePath || '';
            const originalHref = anchor.dataset.bqOriginalHref || '';
            this._fetchFreshHrefForExpiredLink(expiredHref, remotePath, originalHref)
                .then((fresh) => {
                    if (!fresh) return;
                    anchor.href = fresh;
                    anchor.classList.remove('is-expired');
                    anchor.classList.remove('is-refreshing');
                    // Re-render so the cached URL replaces all other live
                    // copies of the same expired anchor in the chat.
                    this._renderMessages();
                    // Open in new tab — preserves the user's click intent.
                    window.open(fresh, '_blank', 'noopener,noreferrer');
                })
                .catch((err) => {
                    console.error('[BunnyQuery] failed to refresh expired link', err);
                    alert('Failed to refresh this expired link. Please try again.');
                });
        }

        async _fetchFreshHrefForExpiredLink(expiredHref, remotePath, originalHref) {
            const cached = this._refreshedLinkMap[expiredHref];
            if (cached) return cached;
            const inFlight = this._refreshingLinkPromises.get(expiredHref);
            if (inFlight) return inFlight;

            this._refreshingLinkSet.add(expiredHref);
            this._renderMessages();

            const run = async () => {
                // Prefer the original full URL captured at parse time. The
                // user-facing Skapi.getFile() needs a real http(s) URL to a
                // skapi CDN endpoint; it cannot resolve bare storage paths.
                const sourceUrl = (originalHref && /^https?:\/\//i.test(originalHref))
                    ? originalHref
                    : null;
                if (!sourceUrl) {
                    throw new Error('Unable to refresh this expired attachment link: missing source URL.');
                }
                const res = await this.skapi.getFile(sourceUrl, {
                    dataType: 'endpoint',
                    expires: DEFAULTS.ATTACHMENT_URL_EXPIRES_SECONDS,
                });
                const fresh = typeof res === 'string' ? res : (res && (res.url || res.cdn_url));
                if (!fresh) throw new Error('Empty signed URL response.');
                this._refreshedLinkMap[expiredHref] = fresh;
                return fresh;
            };
            const p = run().finally(() => {
                this._refreshingLinkSet.delete(expiredHref);
                this._refreshingLinkPromises.delete(expiredHref);
            });
            this._refreshingLinkPromises.set(expiredHref, p);
            return p;
        }

        // ---- typewriter ----------------------------------------------------
        // Reveal `fullText` into messages[idx].content character-by-character.
        // Fast-forwards through fenced file blocks (rendered as a
        // [generating filename...] placeholder anyway) and inline link
        // tokens (kept atomic so half-rendered `[label]` doesn't show up).
        async _typewriteIntoIndex(idx, fullText) {
            if (!fullText) return;
            const TICK_MS = 16;
            const charsPerTick = 3;
            const FENCE_REVEAL_MS = 200;
            const fenceTicks = Math.max(1, Math.floor(FENCE_REVEAL_MS / TICK_MS));

            const fenceRegions = [];
            const fenceRegex = /```[\w.-]+\.[a-zA-Z0-9]+\n[\s\S]*?```/g;
            let fm;
            while ((fm = fenceRegex.exec(fullText)) !== null) {
                fenceRegions.push({ start: fm.index, end: fm.index + fm[0].length });
            }

            const linkRegions = [];
            const linkRegex = createInlineLinkRegex();
            let lm;
            while ((lm = linkRegex.exec(fullText)) !== null) {
                linkRegions.push({ start: lm.index, end: lm.index + lm[0].length });
            }

            // Start the dotTick animation while typewriting.
            this._startDotTick();
            this.typing = true;
            this._typingAbort = false;

            try {
                let i = 0;
                while (i < fullText.length) {
                    if (this._typingAbort) break;
                    let step = charsPerTick;
                    const region = fenceRegions.find((r) => i >= r.start && i < r.end);
                    const linkRegion = linkRegions.find((r) => i >= r.start && i < r.end);
                    if (region) {
                        step = Math.max(charsPerTick, Math.ceil((region.end - i) / fenceTicks));
                    } else if (linkRegion) {
                        step = Math.max(charsPerTick, linkRegion.end - i);
                    } else {
                        const next = linkRegions.find((r) => i < r.start && i + step > r.start);
                        if (next) step = next.end - i;
                    }
                    i = Math.min(fullText.length, i + step);
                    const target = this.messages[idx];
                    if (!target) break;
                    target.content = fullText.slice(0, i);
                    this._renderMessages();
                    await new Promise((r) => setTimeout(r, TICK_MS));
                }
            } finally {
                const target = this.messages[idx];
                if (target) target.content = fullText;
                this.typing = false;
                this._stopDotTick();
                this._renderMessages();
            }
        }

        _enqueueTypewrite(idx, fullText) {
            this._typewriterQueue = this._typewriterQueue.then(() => this._typewriteIntoIndex(idx, fullText));
            return this._typewriterQueue;
        }

        _startDotTick() {
            if (this._dotTickTimer) return;
            this._dotTickTimer = setInterval(() => {
                this._dotTick = (this._dotTick + 1) % 3;
                // No full re-render here — the dots only matter while a
                // fence is open mid-typewriter, which the next typewriter
                // tick will repaint anyway.
            }, 400);
        }

        _stopDotTick() {
            if (this._dotTickTimer) {
                clearInterval(this._dotTickTimer);
                this._dotTickTimer = null;
            }
            this._dotTick = 0;
        }

        // ---- clear history (soft delete via localStorage horizon) -------
        // Mirrors the strategy in agent.vue: persist a per-(service,platform)
        // `clearedAt` ms timestamp and drop any history entry whose `updated`
        // field is at-or-before it. The server keeps the records.
        _clearHistoryStorageKey() {
            if (!this.serviceId || !this.platform) return '';
            return `agent.clearedAt:${this.serviceId}#${this.platform}`;
        }

        _getClearedAt() {
            const key = this._clearHistoryStorageKey();
            if (!key) return 0;
            try {
                const raw = window.localStorage.getItem(key);
                const value = raw ? Number(raw) : 0;
                return Number.isFinite(value) && value > 0 ? value : 0;
            } catch { return 0; }
        }

        _setClearedAt(ts) {
            const key = this._clearHistoryStorageKey();
            if (!key) return;
            try { window.localStorage.setItem(key, String(ts)); } catch { }
        }

        _filterByClearHorizon(list) {
            const clearedAt = this._getClearedAt();
            if (!clearedAt) return list;
            return list.filter((item) => {
                const updated = Number(item && item.updated);
                return Number.isFinite(updated) && updated > clearedAt;
            });
        }

        _onClearHistoryClick() {
            const busy = this.sending || this.uploading || this.typing || this._anyPending();
            if (busy || !this.messages.length) return;
            this._openClearHistoryModal();
        }

        _openClearHistoryModal() {
            // Tear down any previous modal node first.
            if (this._clearModal) {
                this._clearModal.remove();
                this._clearModal = null;
            }
            const close = () => {
                if (this._clearModal) {
                    this._clearModal.remove();
                    this._clearModal = null;
                }
            };

            const cancelBtn = $('button', {
                class: 'bq-modal-delete-btn bq-modal-delete-btn--cancel',
                type: 'button',
                onclick: close,
            }, 'Cancel');

            const confirmBtn = $('button', {
                class: 'bq-modal-delete-btn bq-modal-delete-btn--delete',
                type: 'button',
                onclick: () => {
                    this._setClearedAt(Date.now());
                    this.messages = [];
                    this.startKeyHistory = null;
                    this.endOfList = true;
                    this._renderMessages();
                    close();
                },
            }, 'Clear');

            const closeBtn = $('button', {
                type: 'button',
                class: 'bq-modal-close',
                'aria-label': 'Close',
                onclick: close,
            }, '×');

            const modal = $('div', {
                class: 'bq-modal-backdrop',
                onclick: (e) => { if (e.target === modal) close(); },
            }, [
                $('div', { class: 'bq-modal-delete' }, [
                    $('div', { class: 'bq-modal-delete-header' }, [
                        $('span', null, 'Clear chat history'),
                        closeBtn,
                    ]),
                    $('div', { class: 'bq-modal-delete-body' }, [
                        $('p', null, 'Hide all previous messages from this chat?'),
                        $('p', { class: 'bq-modal-delete-warn' },
                            "New messages will appear normally. Existing history will be hidden from view and from the AI's context, but the records remain on the server."
                        ),
                    ]),
                    $('div', { class: 'bq-modal-delete-footer' }, [cancelBtn, confirmBtn]),
                ]),
            ]);

            this._clearModal = modal;
            document.body.appendChild(modal);
        }

        async _logout() {
            const busy = this.sending || this.uploading || this.typing || this._anyPending();
            if (busy) return;
            this._openLogoutModal();
        }

        _openLogoutModal() {
            // Tear down any previous logout modal node first.
            if (this._logoutModal) {
                this._logoutModal.remove();
                this._logoutModal = null;
            }
            const close = () => {
                if (this._logoutModal) {
                    this._logoutModal.remove();
                    this._logoutModal = null;
                }
            };

            const cancelBtn = $('button', {
                class: 'bq-modal-delete-btn bq-modal-delete-btn--cancel',
                type: 'button',
                onclick: close,
            }, 'Cancel');

            const confirmBtn = $('button', {
                class: 'bq-modal-delete-btn bq-modal-delete-btn--delete',
                type: 'button',
                onclick: async () => {
                    close();
                    await this._performLogout();
                },
            }, 'Logout');

            const closeBtn = $('button', {
                type: 'button',
                class: 'bq-modal-close',
                'aria-label': 'Close',
                onclick: close,
            }, '×');

            const modal = $('div', {
                class: 'bq-modal-backdrop',
                onclick: (e) => { if (e.target === modal) close(); },
            }, [
                $('div', { class: 'bq-modal-delete' }, [
                    $('div', { class: 'bq-modal-delete-header' }, [
                        $('span', null, 'Logout'),
                        closeBtn,
                    ]),
                    $('div', { class: 'bq-modal-delete-body' }, [
                        $('p', null, 'Log out of this chat?'),
                        $('p', { class: 'bq-modal-delete-warn' },
                            'You will need to sign in again to continue the conversation. Existing history is preserved on the server.'
                        ),
                    ]),
                    $('div', { class: 'bq-modal-delete-footer' }, [cancelBtn, confirmBtn]),
                ]),
            ]);

            this._logoutModal = modal;
            document.body.appendChild(modal);
        }

        _openSettingsModal() {
            // Tear down any previous settings modal node first.
            if (this._settingsModal) {
                this._settingsModal.remove();
                this._settingsModal = null;
            }

            const profile = this.profile || {};
            const isOpenId = !!profile.openid_id;

            const close = () => {
                if (this._settingsModal) {
                    this._settingsModal.remove();
                    this._settingsModal = null;
                }
            };

            // ----- helpers ------------------------------------------------
            const mkMsg = () => $('p', { class: 'bq-modal-msg', style: { display: 'none' } });
            const setMsg = (node, text, ok) => {
                node.textContent = text || '';
                node.className = 'bq-modal-msg ' + (ok ? 'bq-modal-msg--ok' : 'bq-modal-msg--err');
                node.style.display = text ? '' : 'none';
            };
            const lockBtn = (btn, locked, label) => {
                btn.disabled = !!locked;
                if (locked) btn.classList.add('is-loading');
                else btn.classList.remove('is-loading');
                if (label != null) btn.textContent = label;
            };

            // ----- Email section -----------------------------------------
            const emailValueEl = $('span', { class: 'bq-modal-value' }, profile.email || '—');
            const verifiedBadge = $('span', {
                class: 'bq-modal-badge ' + (profile.email_verified ? 'bq-modal-badge--ok' : 'bq-modal-badge--warn'),
            }, profile.email_verified ? 'verified' : 'unverified');

            const emailMsg = mkMsg();
            const verifyCodeInput = $('input', {
                type: 'text',
                class: 'bq-settings-input',
                placeholder: 'Verification code',
                autocomplete: 'one-time-code',
                inputmode: 'numeric',
                style: { display: profile.email_verified ? 'none' : '' },
            });
            const sendCodeBtn = $('button', {
                type: 'button',
                class: 'bq-settings-btn',
                style: { display: profile.email_verified ? 'none' : '' },
                onclick: async () => {
                    setMsg(emailMsg, '', true);
                    lockBtn(sendCodeBtn, true, 'Sending…');
                    try {
                        // verifyEmail() with no args asks Cognito to send the
                        // verification code to the pending email address.
                        await this.skapi.verifyEmail();
                        setMsg(emailMsg, 'Verification code sent. Check your inbox.', true);
                        lockBtn(sendCodeBtn, false, 'Resend code');
                    } catch (err) {
                        setMsg(emailMsg, (err && err.message) || String(err), false);
                        lockBtn(sendCodeBtn, false, 'Send code');
                    }
                },
            }, 'Send code');
            const confirmCodeBtn = $('button', {
                type: 'button',
                class: 'bq-settings-btn bq-settings-btn--primary',
                style: { display: profile.email_verified ? 'none' : '' },
                onclick: async () => {
                    const code = verifyCodeInput.value.trim();
                    if (!code) {
                        setMsg(emailMsg, 'Enter the verification code first.', false);
                        return;
                    }
                    setMsg(emailMsg, '', true);
                    lockBtn(confirmCodeBtn, true, 'Verifying…');
                    try {
                        await this.skapi.verifyEmail({ code });
                        if (this.profile) this.profile.email_verified = true;
                        setMsg(emailMsg, 'Email verified.', true);
                        verifiedBadge.textContent = 'verified';
                        verifiedBadge.className = 'bq-modal-badge bq-modal-badge--ok';
                        verifyCodeInput.style.display = 'none';
                        sendCodeBtn.style.display = 'none';
                        confirmCodeBtn.style.display = 'none';
                        lockBtn(confirmCodeBtn, false, 'Verify');
                    } catch (err) {
                        setMsg(emailMsg, (err && err.message) || String(err), false);
                        lockBtn(confirmCodeBtn, false, 'Verify');
                    }
                },
            }, 'Verify');

            const newEmailInput = $('input', {
                type: 'email',
                class: 'bq-settings-input',
                placeholder: 'New email address',
                autocomplete: 'email',
                required: true,
            });
            const changeEmailMsg = mkMsg();
            const changeEmailBtn = $('button', {
                type: 'submit',
                class: 'bq-settings-btn bq-settings-btn--primary',
            }, 'Change email');
            const changeEmailForm = $('form', {
                class: 'bq-modal-form',
                onsubmit: async (e) => {
                    e.preventDefault();
                    const next = newEmailInput.value.trim();
                    if (!next) return;
                    setMsg(changeEmailMsg, '', true);
                    lockBtn(changeEmailBtn, true, 'Saving…');
                    try {
                        await this.skapi.updateProfile({ email: next });
                        if (this.profile) {
                            this.profile.email = next;
                            this.profile.email_verified = false;
                        }
                        emailValueEl.textContent = next;
                        verifiedBadge.textContent = 'unverified';
                        verifiedBadge.className = 'bq-modal-badge bq-modal-badge--warn';
                        verifyCodeInput.style.display = '';
                        sendCodeBtn.style.display = '';
                        confirmCodeBtn.style.display = '';
                        newEmailInput.value = '';
                        setMsg(changeEmailMsg, 'Email updated. Use "Send code" above to verify the new address.', true);
                        lockBtn(changeEmailBtn, false, 'Change email');
                    } catch (err) {
                        setMsg(changeEmailMsg, (err && err.message) || String(err), false);
                        lockBtn(changeEmailBtn, false, 'Change email');
                    }
                },
            }, [
                newEmailInput,
                $('div', { class: 'bq-modal-form-actions' }, [changeEmailBtn]),
                changeEmailMsg,
            ]);

            const emailSection = $('section', { class: 'bq-modal-section' }, [
                $('h3', { class: 'bq-modal-section-title' }, 'Email'),
                $('div', { class: 'bq-modal-row' }, [emailValueEl, verifiedBadge]),
                $('div', { class: 'bq-modal-verify-row' }, [
                    verifyCodeInput,
                    sendCodeBtn,
                    confirmCodeBtn,
                ]),
                emailMsg,
                changeEmailForm,
            ]);

            // ----- Password section --------------------------------------
            let passwordSection = null;
            if (!isOpenId) {
                const currPw = $('input', { type: 'password', class: 'bq-settings-input', placeholder: 'Current password', autocomplete: 'current-password', required: true });
                const newPw = $('input', { type: 'password', class: 'bq-settings-input', placeholder: 'New password', autocomplete: 'new-password', minlength: '6', required: true });
                const confirmPw = $('input', { type: 'password', class: 'bq-settings-input', placeholder: 'Confirm new password', autocomplete: 'new-password', minlength: '6', required: true });
                const pwMsg = mkMsg();
                const pwBtn = $('button', {
                    type: 'submit',
                    class: 'bq-settings-btn bq-settings-btn--primary',
                }, 'Change password');

                const pwForm = $('form', {
                    class: 'bq-modal-form',
                    onsubmit: async (e) => {
                        e.preventDefault();
                        setMsg(pwMsg, '', true);
                        if (newPw.value !== confirmPw.value) {
                            setMsg(pwMsg, 'New password and confirmation do not match.', false);
                            return;
                        }
                        lockBtn(pwBtn, true, 'Saving…');
                        try {
                            await this.skapi.changePassword({
                                current_password: currPw.value,
                                new_password: newPw.value,
                            });
                            currPw.value = '';
                            newPw.value = '';
                            confirmPw.value = '';
                            setMsg(pwMsg, 'Password changed.', true);
                            lockBtn(pwBtn, false, 'Change password');
                        } catch (err) {
                            setMsg(pwMsg, (err && err.message) || String(err), false);
                            lockBtn(pwBtn, false, 'Change password');
                        }
                    },
                }, [
                    currPw,
                    newPw,
                    confirmPw,
                    $('div', { class: 'bq-modal-form-actions' }, [pwBtn]),
                    pwMsg,
                ]);

                passwordSection = $('section', { class: 'bq-modal-section' }, [
                    $('h3', { class: 'bq-modal-section-title' }, 'Password'),
                    pwForm,
                ]);
            }

            // ----- Modal shell -------------------------------------------
            const closeBtn = $('button', {
                type: 'button',
                class: 'bq-modal-close',
                'aria-label': 'Close settings',
                onclick: close,
            }, '×');

            const header = $('div', { class: 'bq-modal-header' }, [
                $('span', { class: 'bq-modal-title' }, 'Account Settings'),
                closeBtn,
            ]);

            const body = $('div', { class: 'bq-modal-body' }, [
                emailSection,
                passwordSection,
            ].filter(Boolean));

            const card = $('div', { class: 'bq-modal-card' }, [header, body]);

            const modal = $('div', {
                class: 'bq-modal-backdrop',
                onclick: (e) => { if (e.target === modal) close(); },
            }, [card]);

            this._settingsModal = modal;
            document.body.appendChild(modal);
        }

        async _performLogout() {
            // Stop any in-flight pending poll so the chat doesn't try to
            // refetch history right after we tear it down.
            if (this.pendingTimer) {
                clearTimeout(this.pendingTimer);
                this.pendingTimer = null;
            }
            this.oauth.clearToken();
            try { await this.skapi.logout(); } catch (_) { }
            this.messages = [];
            this.attachments = [];
            this.startKeyHistory = null;
            this.endOfList = false;
            this._renderLogin();
        }

        // ---- history ------------------------------------------------------
        async _loadFirstHistoryPage() {
            this._loadingFirstHistory = true;
            this._initialHistoryLoaded = false;
            this._renderMessages();

            const fetchPage = () => getChatHistory(
                this.skapi,
                { service: this.serviceId, owner: this.ownerId, platform: this.platform },
                { ascending: false }
            );
            try {
                let res;
                try {
                    res = await fetchPage();
                } catch (err) {
                    if (_isAuthExpiredError(err)) {
                        this.oauth.clearToken();
                        await this.oauth.exchangeSession(this.skapi.session);
                        res = await fetchPage();
                    } else {
                        throw err;
                    }
                }
                this.startKeyHistory = res && res.startKeyHistory;
                const list = this._filterByClearHorizon((res && res.list) || []);
                // If the clear horizon has filtered the entire first page,
                // there are no older entries the user is allowed to see.
                this.endOfList = !!(res && res.endOfList) || (this._getClearedAt() > 0 && list.length === 0);
                this.messages = mapHistoryToMessages(list, this.platform);
                this._schedulePendingPoll();
            } catch (err) {
                console.error('[BunnyQuery] history load failed', err);
            } finally {
                this._loadingFirstHistory = false;
                this._initialHistoryLoaded = true;
                this._renderMessages();
            }
        }

        async _onHistoryScroll() {
            const box = this.refs.messagesBox;
            if (!box || this.endOfList || this._loadingOlder) return;
            if (box.scrollTop > 80) return;
            this._loadingOlder = true;
            try {
                const res = await getChatHistory(
                    this.skapi,
                    { service: this.serviceId, owner: this.ownerId, platform: this.platform },
                    { ascending: false, fetchMore: true, startKeyHistory: this.startKeyHistory }
                );
                this.startKeyHistory = res && res.startKeyHistory;
                const olderList = this._filterByClearHorizon((res && res.list) || []);
                const clearedAt = this._getClearedAt();
                // Once we hit a page where every entry is at-or-before the
                // horizon we know we won't surface anything older.
                const allFiltered = clearedAt > 0 &&
                    olderList.length === 0 &&
                    Array.isArray(res && res.list) && res.list.length > 0;
                this.endOfList = !!(res && res.endOfList) || allFiltered;
                const older = mapHistoryToMessages(olderList, this.platform);
                this.messages = older.concat(this.messages);
                this._renderMessages();
            } catch (err) {
                console.error('[BunnyQuery] older history failed', err);
            } finally {
                this._loadingOlder = false;
            }
        }

        // Polling state machine. Invariant: at most ONE of the following
        // is true at any moment — (a) `pendingTimer` is armed, or (b)
        // `_pollingPending` is true (fetch in flight). Any call to
        // `_schedulePendingPoll` while either is true is a no-op; the
        // in-flight cycle's `finally` will continue the loop.
        //
        // This replaces an earlier clear-and-rearm pattern that, under
        // overlapping callers (`_sendMessage`, `_loadFirstHistoryPage`,
        // and the poll's own `finally`), could leave two timers
        // concurrently armed. Each tick's `finally` then scheduled
        // another, and the effective polling rate kept compounding —
        // the chat looked like it was polling faster and faster.
        _schedulePendingPoll() {
            if (this.pendingTimer != null) return;
            if (this._pollingPending) return;
            if (!this._anyPending()) return;
            this.pendingTimer = setTimeout(() => {
                this.pendingTimer = null;
                this._runPendingPoll();
            }, DEFAULTS.PENDING_POLL_INTERVAL_MS);
        }

        async _runPendingPoll() {
            // Defensive: if somehow re-entered, drop the duplicate.
            if (this._pollingPending) return;
            this._pollingPending = true;
            try {
                const res = await getChatHistory(
                    this.skapi,
                    { service: this.serviceId, owner: this.ownerId, platform: this.platform },
                    { ascending: false }
                );
                const fresh = mapHistoryToMessages(
                    this._filterByClearHorizon((res && res.list) || []),
                    this.platform
                );
                // Keep older messages whose ids are not on the freshly
                // fetched first page. The fresh page is appended last so
                // it always reflects the latest server state.
                const freshIds = new Set(fresh.filter((m) => m.id).map((m) => m.id));
                const older = this.messages.filter((m) => m.id && !freshIds.has(m.id));
                this.messages = older.concat(fresh);
                this._renderMessages();
            } catch (err) {
                console.error('[BunnyQuery] pending poll failed', err);
            } finally {
                this._pollingPending = false;
                this._schedulePendingPoll();
            }
        }

        // ---- attachments --------------------------------------------------
        _onAttachFromInput(e) {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            files.forEach((f) => {
                this.attachments.push({
                    id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                    file: f,
                    name: f.name,
                    size: f.size,
                    status: 'pending',
                });
            });
            this._renderAttachments();
        }

        _renderAttachments() {
            const box = this.refs.attachmentsBox;
            if (!box) return;
            box.innerHTML = '';
            if (!this.attachments.length) {
                box.style.display = 'none';
                return;
            }
            box.style.display = '';
            this.attachments.forEach((a) => {
                const chip = $('div', {
                    class:
                        'bq-attachment' +
                        (a.status === 'uploading' ? ' is-uploading' : '') +
                        (a.status === 'done' ? ' is-done' : '') +
                        (a.status === 'error' ? ' is-error' : ''),
                }, [
                    $('span', { class: 'bq-attachment-name' }, a.name),
                    a.status === 'uploading' && a.progress != null
                        ? $('span', { class: 'bq-attachment-meta' }, ` ${a.progress}%`)
                        : null,
                    a.status === 'error'
                        ? $('span', { class: 'bq-attachment-meta' }, ' failed')
                        : null,
                    a.status !== 'done'
                        ? $('button', {
                            type: 'button',
                            class: 'bq-attachment-remove',
                            onclick: (e) => {
                                e.stopPropagation();
                                this.attachments = this.attachments.filter((x) => x.id !== a.id);
                                this._renderAttachments();
                            },
                        }, '×')
                        : null,
                ]);
                box.appendChild(chip);
            });
        }

        async _uploadAllAttachments() {
            if (!this.attachments.length) return [];
            this.uploading = true;
            this._updateInputDisabled();
            const uploaded = [];
            try {
                for (const a of this.attachments) {
                    if (a.status === 'done') {
                        if (a.uploadedUrl) uploaded.push({ name: a.name, url: a.uploadedUrl });
                        continue;
                    }
                    a.status = 'uploading';
                    a.progress = 0;
                    this._renderAttachments();
                    try {
                        const form = new FormData();
                        form.append(a.name, a.file);
                        const res = await this.skapi.uploadHostFiles(form, {
                            request: 'post-db',
                            progress: (p) => {
                                if (p && typeof p.progress === 'number') {
                                    a.progress = Math.round(p.progress);
                                    this._renderAttachments();
                                }
                            },
                        });
                        // After upload, fetch a temporary signed URL the AI
                        // can read. uploadHostFiles returns an object whose
                        // `url` is a full https endpoint; getFile() turns it
                        // into a short-lived signed CDN URL.
                        const completed = (res && (res.completed || res)) || [];
                        const first = Array.isArray(completed) ? completed[0] : completed;
                        const sourceUrl = first && (first.url || first.path || first.key);
                        if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
                            throw new Error('Upload response missing a usable URL.');
                        }
                        const url = await this.skapi.getFile(sourceUrl, {
                            dataType: 'endpoint',
                            expires: DEFAULTS.ATTACHMENT_URL_EXPIRES_SECONDS,
                        });
                        a.uploadedUrl = typeof url === 'string' ? url : (url && (url.url || url.cdn_url));
                        a.status = 'done';
                        uploaded.push({ name: a.name, url: a.uploadedUrl });
                    } catch (err) {
                        a.status = 'error';
                        console.error('[BunnyQuery] attachment upload failed', err);
                    }
                    this._renderAttachments();
                }
            } finally {
                this.uploading = false;
                this._updateInputDisabled();
            }
            return uploaded;
        }

        // ---- send ---------------------------------------------------------
        // Mirrors www.skapi.com/src/views/service/agent.vue buildSystemPrompt
        // with one extra directive: always consult the project database via
        // the MCP toolset before saying you don't know. Without it the model
        // will often stop at "I don't see that in our chat history".
        _buildSystemPrompt() {
            const projectId = this.projectName || this.serviceId;
            let p = `
You are a dedicated assistant for the project ID: "${projectId}".
Scope: Only answer questions about this project and its data. Do not answer questions about other projects or topics unrelated to this project. When the user refers to "my database", "my data", or "my files", treat those as references to this project's database and file storage.
Knowledge lookup: Before saying you don't know or that something isn't in the chat history, ALWAYS query this project's database through the available MCP tools to look for the answer. The user's data is the source of truth - the chat transcript is not. Only respond with "I don't know" or "I couldn't find that" after you have actually searched the project's data and come back empty.
File attachments: When a user message contains an "Attached files:" section with markdown links, those links point to short-lived signed URLs in this project's db storage and will expire.
- Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY attached inline as image content blocks in the same message - you can see them directly. Do NOT call web_fetch on image URLs; that will fail or return garbage. Just look at the image block and answer.
- For all other file types (text, code, csv, json, pdf, etc.), use your web_fetch tool to download and read each URL before answering. Treat the fetched contents as user-supplied input data. Do not ask the user to paste the file contents - fetch the URLs yourself.
File generation: If the user asks you to generate a file and it is possible to do so, output the file contents inside a fenced code block using the file extension as the language identifier. Always use plain text - never base64 or other encodings. Example for CSV:
\`\`\`filename.csv
item,qty,total
Carrots,55,$38.50
Mushrooms,41,$73.80
Zucchini,29,$43.50
\`\`\`
The same pattern applies to other formats: \`\`\`my-data.json, \`\`\`index.html, \`\`\`sample.txt, etc.`;
            if (this.projectDescription) {
                p += `\nProject name: "${this.projectName || ''}"\nProject description: """${this.projectDescription}"""`;
            }
            return p;
        }

        async _sendMessage() {
            if (this.sending || this.uploading || this.typing || this._anyPending()) return;
            const text = (this.refs.textarea.value || '').trim();
            if (!text && !this.attachments.length) return;

            this.sending = true;
            this._updateInputDisabled();
            try {
                let uploaded = [];
                if (this.attachments.length) {
                    uploaded = await this._uploadAllAttachments();
                }

                let composed = text;
                if (uploaded.length) {
                    composed +=
                        (composed ? '\n\n' : '') +
                        'Attached files:\n' +
                        uploaded.map((u) => `- [${u.name}](${u.url})`).join('\n');
                }

                // Build full message history to send (keep last 20 turns).
                const history = this.messages
                    .filter((m) => !m.isPending && !m.isError && (m.content || '').length)
                    .map((m) => ({ role: m.role, content: m.content }))
                    .slice(-19);
                history.push({ role: 'user', content: composed });

                // Optimistically render the user turn + a pending assistant.
                this.messages.push({ role: 'user', content: composed });
                this.messages.push({ role: 'assistant', content: '', isPending: true });
                this._renderMessages();
                if (this.refs.textarea) {
                    this.refs.textarea.value = '';
                    this._autoGrow(this.refs.textarea);
                }
                this.attachments = [];
                this._renderAttachments();

                const args = {
                    service: this.serviceId,
                    owner: this.ownerId,
                    prompt: composed,
                    messages: history,
                    system: this._buildSystemPrompt(),
                    model: this.model || undefined,
                };

                const argsBuilder = () => (this.platform === 'claude'
                    ? buildClaudeRequest(this.skapi, args)
                    : buildOpenAIRequest(this.skapi, args));

                let result;
                try {
                    result = await argsBuilder();
                } catch (err) {
                    if (_isAuthExpiredError(err)) {
                        // The MCP-side skapi session expired. Re-mint a fresh
                        // MCP token bundle from the live host skapi session
                        // (skapi-js auto-refreshes its own tokens), then retry
                        // the call once.
                        try {
                            this.oauth.clearToken();
                            await this.oauth.exchangeSession(this.skapi.session);
                        } catch (reauthErr) {
                            throw reauthErr;
                        }
                        result = await argsBuilder();
                    } else {
                        throw err;
                    }
                }

                // The proxy may resolve with an error-shaped body instead of
                // throwing; surface that as an error bubble with the
                // upstream message rather than dropping it.
                if (isErrorResponseBody(result) && _isAuthExpiredError(result)) {
                    try {
                        this.oauth.clearToken();
                        await this.oauth.exchangeSession(this.skapi.session);
                        result = await argsBuilder();
                    } catch (_reauthErr) { /* fall through to normal error rendering */ }
                }

                if (isErrorResponseBody(result)) {
                    const errMsg = getErrorMessage(result);
                    const last = this.messages[this.messages.length - 1];
                    if (last && last.isPending) {
                        last.isPending = false;
                        last.isError = true;
                        last.content = errMsg;
                    } else {
                        this.messages.push({ role: 'assistant', content: errMsg, isError: true });
                    }
                    this._renderMessages();
                    this._schedulePendingPoll();
                    return;
                }

                const responseText = this.platform === 'claude'
                    ? extractClaudeText(result)
                    : extractOpenAIText(result);

                const finalText = responseText || '(no response)';
                // Replace the trailing pending assistant with an empty
                // shell, then stream the full response in via typewriter.
                // Mirrors agent.vue's typewriteLatestReply flow.
                const last = this.messages[this.messages.length - 1];
                let idx;
                if (last && last.isPending) {
                    last.isPending = false;
                    last.content = '';
                    idx = this.messages.length - 1;
                } else {
                    this.messages.push({ role: 'assistant', content: '' });
                    idx = this.messages.length - 1;
                }
                this._renderMessages();
                this._enqueueTypewrite(idx, finalText);
                this._schedulePendingPoll();
            } catch (err) {
                const last = this.messages[this.messages.length - 1];
                const errMsg = getErrorMessage(err);
                if (last && last.isPending) {
                    last.isPending = false;
                    last.isError = true;
                    last.content = errMsg;
                } else {
                    this.messages.push({ role: 'assistant', content: errMsg, isError: true });
                }
                this._renderMessages();
            } finally {
                this.sending = false;
                this._updateInputDisabled();
            }
        }

        // ---- styles -------------------------------------------------------
        // Inject a sibling `bunnyquery.css` once per document. We resolve
        // the URL relative to the script's `src` so the embed can be served
        // from any CDN without code changes. Override by setting
        // `BunnyQuery.STYLESHEET_URL` before calling `init()`.
        _injectStylesheetOnce() {
            const existing = document.getElementById('bq-embed-styles');
            if (existing) {
                // Stylesheet was already injected by a previous instance.
                // If it finished loading the container is already visible;
                // if it is still downloading keep this container hidden and
                // reveal it on the same load/error events.
                if (!existing._bqLoaded) {
                    this.container.style.visibility = 'hidden';
                    const reveal = () => { this.container.style.visibility = ''; };
                    existing.addEventListener('load', reveal, { once: true });
                    existing.addEventListener('error', reveal, { once: true });
                }
                return;
            }

            let href = BunnyQuery.STYLESHEET_URL || '';
            if (!href && _CURRENT_SCRIPT_SRC) {
                href = _CURRENT_SCRIPT_SRC.replace(/\.js(\?[^#]*)?(#.*)?$/i, '.css$1$2');
                if (href === _CURRENT_SCRIPT_SRC) {
                    // Script URL had no `.js` suffix (rare); fall back to
                    // a sibling file at the same path.
                    href = _CURRENT_SCRIPT_SRC.replace(/[^/]*$/, 'bunnyquery.css');
                }
            }
            if (!href) href = 'bunnyquery.css';

            this.container.style.visibility = 'hidden';
            const reveal = () => {
                link._bqLoaded = true;
                this.container.style.visibility = '';
            };

            const link = document.createElement('link');
            link.id = 'bq-embed-styles';
            link.rel = 'stylesheet';
            link.href = href;
            link.addEventListener('load', reveal, { once: true });
            link.addEventListener('error', reveal, { once: true });
            document.head.appendChild(link);
        }
    }

    BunnyQuery.MCP_BASE_URL = DEFAULTS.MCP_BASE_URL;

    global.BunnyQuery = BunnyQuery;
})(typeof window !== 'undefined' ? window : this);
