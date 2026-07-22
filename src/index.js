/* ============================================================================
 * BunnyQuery — embeddable AI chat widget for Skapi-powered projects.
 *
 * Standalone IIFE exposing `window.BunnyQuery`. Vanilla-JS port of the bunnyquery
 * (www.skapi.com) agent.vue chatbox + account/auth views.
 *
 * Usage:
 *   <link rel="stylesheet" href="bunnyquery.css">
 *   <script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
 *   <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bunnyquery@latest/bunnyquery.css"/>
 *   <script src="https://cdn.jsdelivr.net/npm/bunnyquery@latest/bunnyquery.js"></script>
 *   <script>
 *     const skapi = new Skapi("<project_id>", { autoLogin: true });
 *     BunnyQuery.init(skapi, "chatbox", { theme: "light", signup: true });
 *   </script>
 *
 * Build order in this file:
 *   1. Constants            6. View manager
 *   2. Utilities            7. OAuth (MCP + Google)
 *   3. State                8. Views (login/signup/.../chat)  [later phases]
 *   4. Theme                9. AI agent + chat engine          [later phases]
 *   5. skapi helpers       10. Public init() + boot
 * ==========================================================================*/

// Shared chat engine (request builders, office extraction, prompts, response
// extractors). Bundled into this file by tsup (the engine has no runtime deps;
// skapi + marked are reached via the host's instance / window globals). The
// transport + MCP base URL + poll value are injected in init() below.
import {
    configureChatEngine,
    registerAttachmentParser,
    ChatSession,
    extractClaudeText,
    extractOpenAIText,
    getChatHistory,
    composeUserMessage,
    groupAttachmentFailures,
    notifyAgentSaveAttachment,
    buildChatSystemPrompt,
    // pure helpers (Tier-1.5) — error detection, token budget, link/path, history mapping
    getErrorMessage,
    isErrorResponseBody,
    isAuthExpiredError,
    getContextWindow,
    buildBoundedChatMessages,
    // budget constants used by the view-side attachment-warning calc (currentInputTokenBudget)
    MIN_INPUT_TOKEN_BUDGET,
    OUTPUT_TOKEN_RESERVE,
    TOOL_AND_RESPONSE_BUFFER,
    CLAUDE_PER_REQUEST_INPUT_CAP,
    createInlineLinkRegex,
    extractRemotePathFromAttachmentHref,
    normalizeAttachmentPathCandidate,
    buildDisplayExpiredAttachmentHref,
    getExpiredAttachmentVisiblePath,
    truncateLabelForDisplay,
    extractLastUserTextFromRequest,
    mapHistoryListToMessages,
} from "./engine";

(function () {
    "use strict";

    /* ========================================================================
     * 1. CONSTANTS
     * ======================================================================*/

    // MCP server (RFC 7591 dynamic registration + RFC 6749 auth-code + PKCE).
    // OAuth endpoints live on the MCP server (mcp.broadwayinc.computer); the
    // post-authorize redirect comes back to the CURRENT HOST PAGE (not a
    // bunnyquery.com page). Override the base via `opts.mcpBaseUrl`, or toggle
    // the dev host with `opts.dev`.
    var MCP_PROD = "https://mcp.broadwayinc.computer";
    var MCP_DEV = "https://mcp-dev.broadwayinc.computer";
    var MCP_NAME = "BunnyQuery";

    // Package version, injected at build time by tsup (define: __BQ_VERSION__).
    // Falls back to "dev" when the source runs unbuilt (e.g. tests).
    var BQ_VERSION = typeof __BQ_VERSION__ !== "undefined" ? __BQ_VERSION__ : "dev";

    // Anthropic (Claude)
    var ANTHROPIC_MESSAGES_API_URL = "https://api.anthropic.com/v1/messages";
    var ANTHROPIC_VERSION = "2023-06-01";
    var ANTHROPIC_BETA_HEADER =
        "mcp-client-2025-11-20,web-fetch-2025-09-10,prompt-caching-2024-07-31";

    // OpenAI
    var OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";

    var MAX_TOKENS = 25000;
    var DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
    var DEFAULT_OPENAI_MODEL = "gpt-5.4";

    var POLL_INTERVAL = 1500;
    var BG_INDEXING_QUEUE_SUFFIX = "-bg";

    var ATTACHMENT_URL_EXPIRES_SECONDS = 600;

    // Google OAuth endpoint (token exchange goes through skapi clientSecretRequest
    // with the project's "ggl" client secret, exactly like bunnyquery oauth.ts).
    var GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
    var GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
    var GOOGLE_SCOPE =
        "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email";

    // marked (markdown) — lazy-loaded from CDN on first chat render.
    var MARKED_CDN = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";

    // Storage keys (namespaced; per-service suffix applied at runtime).
    var SK = {
        theme: "bq_embed:theme",
        mcpClient: "bq_embed:mcp_client",
        mcpToken: "bq_embed:mcp_token",
        mcpState: "bq_embed:mcp_state", // sessionStorage
        googleInProgress: "bq_embed:google_in_progress", // sessionStorage
        googleRedirect: "bq_embed:google_redirect", // sessionStorage
        clearHorizon: "bq_embed:clearedAt",
    };

    /* ========================================================================
     * 2. UTILITIES
     * ======================================================================*/

    // Element factory. h("div", {class:"x", onclick:fn}, child, "text", ...)
    function h(tag, attrs /* , ...children */) {
        var el = document.createElement(tag);
        if (attrs) {
            for (var k in attrs) {
                if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
                var v = attrs[k];
                if (v == null || v === false) continue;
                if (k === "class") el.className = v;
                else if (k === "html") el.innerHTML = v;
                else if (k === "text") el.textContent = v;
                else if (k === "dataset") {
                    for (var dk in v) el.dataset[dk] = v[dk];
                } else if (k.slice(0, 2) === "on" && typeof v === "function") {
                    el.addEventListener(k.slice(2).toLowerCase(), v);
                } else if (k === "style" && typeof v === "object") {
                    for (var sk in v) el.style[sk] = v[sk];
                } else if (v === true) {
                    el.setAttribute(k, "");
                } else {
                    el.setAttribute(k, v);
                }
            }
        }
        for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
        return el;
    }

    function append(parent, child) {
        if (child == null || child === false) return;
        if (Array.isArray(child)) {
            child.forEach(function (c) { append(parent, c); });
        } else if (child instanceof Node) {
            parent.appendChild(child);
        } else {
            parent.appendChild(document.createTextNode(String(child)));
        }
    }

    function clear(el) {
        while (el && el.firstChild) el.removeChild(el.firstChild);
        return el;
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function escapeAttr(s) {
        return String(s == null ? "" : s).replace(/"/g, "&quot;").replace(/</g, "&lt;");
    }

    function delay(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    var _localIdSeq = 0;
    function newLocalId() {
        _localIdSeq += 1;
        return "bqc_" + Date.now().toString(36) + "_" + _localIdSeq;
    }

    function getQueryParam(name) {
        var m = window.location.search.match(new RegExp("[?&]" + name + "=([^&]+)"));
        return m ? decodeURIComponent(m[1]) : null;
    }

    // Strip OAuth params from the URL bar without reloading.
    function cleanUrl() {
        try {
            var url = window.location.origin + window.location.pathname + window.location.hash;
            window.history.replaceState({}, document.title, url);
        } catch (e) { /* noop */ }
    }

    // base64url helpers for PKCE
    function base64UrlEncode(bytes) {
        var str = "";
        for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
        return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function randBytes(n) {
        var b = new Uint8Array(n);
        crypto.getRandomValues(b);
        return b;
    }

    function safeJsonParse(raw, fallback) {
        if (!raw) return fallback;
        try { return JSON.parse(raw); } catch (e) { return fallback; }
    }

    function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
    function lsSet(key, v) { try { localStorage.setItem(key, v); } catch (e) {} }
    function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }
    function ssGet(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
    function ssSet(key, v) { try { sessionStorage.setItem(key, v); } catch (e) {} }
    function ssDel(key) { try { sessionStorage.removeItem(key); } catch (e) {} }

    // decode the `sub` from a JWT without verifying (used to detect user mismatch)
    function getJwtSub(token) {
        if (!token || typeof token !== "string") return null;
        var parts = token.split(".");
        if (parts.length < 2) return null;
        try {
            var payload = JSON.parse(
                atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
            );
            return payload && payload.sub ? payload.sub : null;
        } catch (e) {
            return null;
        }
    }

    /* ========================================================================
     * 3. STATE
     * ======================================================================*/

    var S = {
        skapi: null,
        opts: {},
        mountEl: null,     // host-provided container
        root: null,        // .bq-agent element we own
        booted: false,
        user: null,        // current UserProfile or null
        service: null,     // resolved service info ({ ai_agent, name, ... })
        serviceId: null,
        owner: null,
        theme: null,
        // agent config (read-only, admin-provided)
        aiPlatform: "none", // "claude" | "openai" | "none"
        aiModel: "",
        // chat state (populated in the chat-engine phase)
        messages: [],
        attachments: [],
        view: null,        // current view name
    };

    // Per-service storage key helper
    function skey(base) {
        return base + ":" + (S.serviceId || "default");
    }

    /* ========================================================================
     * 4. THEME
     * ======================================================================*/

    function loadTheme() {
        // Fixed key (NOT per-service): theme is a global UI preference, and at
        // init() serviceId isn't known yet — a per-service key would save/load
        // under different names and never persist.
        var stored = lsGet(SK.theme);
        if (stored === "dark" || stored === "light") return stored;
        if (S.opts.theme === "dark" || S.opts.theme === "light") return S.opts.theme;
        // fall back to OS preference
        try {
            if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
                return "dark";
            }
        } catch (e) {}
        return "light";
    }

    function applyTheme(theme) {
        S.theme = theme === "dark" ? "dark" : "light";
        if (S.root) S.root.setAttribute("data-bq-theme", S.theme);
        // keep any open modal roots in sync
        var modals = document.querySelectorAll(".bq-modal-root");
        for (var i = 0; i < modals.length; i++) {
            modals[i].setAttribute("data-bq-theme", S.theme);
        }
        lsSet(SK.theme, S.theme); // fixed key (see loadTheme) so the choice persists
        // swap theme-toggle icons in place (avoids re-rendering / losing form input)
        var toggles = document.querySelectorAll("[data-bq-theme-toggle]");
        for (var j = 0; j < toggles.length; j++) {
            toggles[j].innerHTML = S.theme === "dark" ? THEME_ICON_SUN : THEME_ICON_MOON;
        }
    }

    function toggleTheme() {
        applyTheme(S.theme === "dark" ? "light" : "dark");
    }

    /* ========================================================================
     * 5. SKAPI HELPERS
     * ======================================================================*/

    // Resolve the current user (or null). skapi.getProfile() returns the profile
    // for the active (incl. auto-login restored) session, or null.
    function getProfile(refresh) {
        try {
            return S.skapi
                .getProfile(refresh ? { refreshToken: true } : undefined)
                .then(function (u) { return u || null; })
                .catch(function () { return null; });
        } catch (e) {
            return Promise.resolve(null);
        }
    }

    // Force a fresh JWT so the next clientSecretRequest carries a valid
    // $ACCESS_TOKEN (the MCP server validates it via loginWithToken).
    function refreshSkapiSession() {
        return getProfile(true).then(function (u) { return !!u; });
    }

    // Pull the service info (so we can read the admin-configured ai_agent).
    // The Skapi connection object carries the service record once resolved.
    function loadServiceInfo() {
        S.serviceId = (S.skapi && (S.skapi.service || (S.skapi.connection && S.skapi.connection.service))) || S.serviceId;
        S.owner = (S.skapi && (S.skapi.owner || (S.skapi.connection && S.skapi.connection.owner))) || S.owner;
        return Promise.resolve()
            .then(function () {
                if (typeof S.skapi.getConnectionInfo === "function") return S.skapi.getConnectionInfo();
                return S.skapi.connection || null;
            })
            .then(function (conn) {
                if (S.opts && S.opts.dev) console.log("[bunnyquery] loadServiceInfo", conn);
                if (conn) {
                    S.serviceId = conn.service || S.serviceId;
                    S.owner = conn.owner || S.owner;
                }
                return conn;
            })
            .catch(function () { return null; });
    }

    /* ========================================================================
     * 6. VIEW MANAGER
     * ======================================================================*/

    // Render a view builder (function returning a Node) into the root,
    // replacing whatever was there. Each view fn receives no args and reads S.
    function render(viewName, builder) {
        if (!S.root) return;
        S.view = viewName;
        clear(S.root);
        var node = builder();
        if (node) S.root.appendChild(node);
    }

    // Standalone-page parent: a padded scroll container wrapping the centered
    // .bq-settings content. (The chat view supplies its own padding on
    // .bq-messages / .bq-input-row, so page padding lives here.)
    function pageRoot(content) {
        // Same top-left header the chat/settings views use (.bq-section-title >
        // .bq-title-row > .bq-title-left), so the service badge sits flush at the
        // widget's top-left instead of being indented into the centered content
        // column. The scrollable .bq-page below holds the centered form + footer.
        return h("div", { class: "bq-meta" },
            h("div", { class: "bq-section-title" },
                h("div", { class: "bq-title-row" },
                    h("div", { class: "bq-title-left" },
                        h("span", { class: "bq-agent-badge", text: agentBadgeText() })))),
            h("div", { class: "bq-page" },
                h("div", { class: "bq-settings" }, content),
                pageFooter()));
    }
    // Gray "www.bunnyquery.com" link + current widget version, centered at the
    // bottom of standalone pages.
    function pageFooter() {
        return h("div", { class: "bq-page-footer" },
            h("a", { class: "bq-page-footer-link", href: "https://www.bunnyquery.com",
                target: "_blank", rel: "noopener noreferrer", text: "www.bunnyquery.com" }),
            h("div", { class: "bq-page-footer-version", text: "v" + BQ_VERSION }));
    }
    // Jumping ASCII bunny — the full-area "loading/fetching" indicator (page/gate
    // loads, initial history fetch, settings panel). Ported from www.bunnyquery.com
    // bunnyLoader.vue; small inline states (Thinking, older-history) keep .bq-loader.
    // The two frames toggle + hop; an explicit Latin mono font (--bq-mono, applied
    // in CSS) keeps CJK systems from drawing U+005C (backslash) as ₩/¥.
    var BUNNY_FRAME_A = "  (\\(\\\n  ( - -)\n c(\")(\")";
    var BUNNY_FRAME_B = "  /)/)\n ( . .)\nc(\")(\")";
    function bunnyLoader(label, overlay) {
        return h("div", {
                class: "bq-bunny-loader" + (overlay ? " bq-bunny-loader--overlay" : ""),
                "aria-hidden": "true", translate: "no",
            },
            h("div", { class: "bq-bunny-stage" },
                h("div", { class: "bq-bunny-track" },
                    h("div", { class: "bq-bunny-dir" },
                        h("pre", { class: "bq-frame bq-frame-a", translate: "no", text: BUNNY_FRAME_A }),
                        h("pre", { class: "bq-frame bq-frame-b", translate: "no", text: BUNNY_FRAME_B })))),
            label ? h("div", { class: "bq-bunny-loader__label", text: label }) : null);
    }
    function showLoading(label) {
        render("loading", function () {
            // Fill the page and center the bunny (matching the "Fetching history..."
            // initial loader), rather than top-anchoring it. The footer stays pinned
            // at the bottom via .bq-page's column flex.
            return h("div", { class: "bq-page" },
                h("div", { class: "bq-page-loading" },
                    bunnyLoader(label || "Loading...")),
                pageFooter());
        });
    }

    /* ========================================================================
     * 7. OAUTH — MCP (RFC 7591 + auth-code + PKCE) and Google
     * ======================================================================*/

    function mcpBaseUrl() {
        // The MCP OAuth server (defaults to mcp.broadwayinc.computer). The
        // redirect_uri (mcpRedirectUri) still points back to the host page.
        return String(S.opts.mcpBaseUrl || (S.opts.dev ? MCP_DEV : MCP_PROD)).replace(/\/+$/, "");
    }
    // Embeddable: the redirect target is the current host page (sans query),
    // so the browser returns here and BunnyQuery.init() re-runs + completes.
    function mcpRedirectUri() {
        return window.location.origin + window.location.pathname;
    }

    function getStoredMcpClient() {
        return safeJsonParse(lsGet(skey(SK.mcpClient)), null);
    }
    function getStoredMcpToken() {
        return safeJsonParse(lsGet(skey(SK.mcpToken)), null);
    }
    function clearStoredMcpToken() {
        lsDel(skey(SK.mcpToken));
    }

    function generateCodeChallenge(verifier) {
        if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
            var data = new TextEncoder().encode(verifier);
            return crypto.subtle.digest("SHA-256", data).then(function (hash) {
                return { challenge: base64UrlEncode(new Uint8Array(hash)), method: "S256" };
            }).catch(function () {
                return { challenge: verifier, method: "plain" };
            });
        }
        return Promise.resolve({ challenge: verifier, method: "plain" });
    }

    function registerMcpClient() {
        var body = {
            client_name: "bunnyquery",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            redirect_uris: [mcpRedirectUri()],
            token_endpoint_auth_method: "client_secret_basic",
        };
        return fetch(mcpBaseUrl() + "/oauth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }).then(function (res) {
            if (!res.ok) {
                return res.text().catch(function () { return ""; }).then(function (t) {
                    throw new Error("MCP /oauth/register failed: " + res.status + " " + t);
                });
            }
            return res.json();
        }).then(function (json) {
            if (!json || !json.client_id) throw new Error("MCP register missing client_id");
            var stored = Object.assign({}, json, { registered_at: Date.now() });
            lsSet(skey(SK.mcpClient), JSON.stringify(stored));
            return stored;
        });
    }

    function startMcpAuthorize(client, redirectAfter) {
        var verifier = base64UrlEncode(randBytes(32));
        var state = base64UrlEncode(randBytes(16));
        return generateCodeChallenge(verifier).then(function (cc) {
            ssSet(skey(SK.mcpState), JSON.stringify({
                state: state, codeVerifier: verifier, redirectAfter: redirectAfter || "chat",
            }));
            var currentUri = mcpRedirectUri();
            var params = new URLSearchParams({
                response_type: "code",
                client_id: client.client_id,
                redirect_uri: currentUri,
                login_page: currentUri,
                state: state,
                code_challenge: cc.challenge,
                code_challenge_method: cc.method,
            });
            // replace() so the host page isn't left in history — Back won't land
            // on a stale ?code/?state URL that re-triggers an expired exchange.
            window.location.replace(mcpBaseUrl() + "/oauth/authorize?" + params.toString());
        });
    }

    // Full MCP OAuth bootstrap on login — registers a client and redirects the
    // browser away to /oauth/authorize. The host page leaves; on return,
    // boot() detects ?code&state and calls completeMcpAuthorize().
    function beginMcpOAuthOnLogin(redirectAfter) {
        return registerMcpClient().then(function (client) {
            return startMcpAuthorize(client, redirectAfter);
        });
    }

    function isMcpOAuthCallback() {
        var code = getQueryParam("code");
        var state = getQueryParam("state");
        if (!code || !state) return false;
        var stored = safeJsonParse(ssGet(skey(SK.mcpState)), null);
        return !!(stored && stored.state === state);
    }

    function basicAuthHeader(id, secret) {
        return "Basic " + btoa(id + ":" + secret);
    }

    function completeMcpAuthorize() {
        var stored = safeJsonParse(ssGet(skey(SK.mcpState)), null);
        if (!stored) return Promise.reject(new Error("Missing MCP OAuth state"));
        ssDel(skey(SK.mcpState));
        var code = getQueryParam("code");
        var state = getQueryParam("state");
        if (stored.state !== state) return Promise.reject(new Error("MCP OAuth state mismatch"));
        var client = getStoredMcpClient();
        if (!client) return Promise.reject(new Error("No registered MCP client"));

        var body = new URLSearchParams({
            grant_type: "authorization_code",
            code: String(code),
            redirect_uri: mcpRedirectUri(),
            code_verifier: stored.codeVerifier,
            client_id: client.client_id,
        });
        var headers = { "Content-Type": "application/x-www-form-urlencoded" };
        if (client.client_secret) {
            headers.Authorization = basicAuthHeader(client.client_id, client.client_secret);
        }
        return fetch(mcpBaseUrl() + "/oauth/token", {
            method: "POST", headers: headers, body: body.toString(),
        }).then(function (res) {
            if (!res.ok) {
                return res.text().catch(function () { return ""; }).then(function (t) {
                    throw new Error("MCP /oauth/token failed: " + res.status + " " + t);
                });
            }
            return res.json();
        }).then(function (json) {
            if (!json || !json.access_token) throw new Error("MCP token missing access_token");
            var token = Object.assign({}, json, {
                expires_at: typeof json.expires_in === "number"
                    ? Date.now() + json.expires_in * 1000 : undefined,
            });
            lsSet(skey(SK.mcpToken), JSON.stringify(token));
            return { token: token, redirectAfter: stored.redirectAfter || "chat" };
        });
    }

    // Decide whether the stored MCP grant needs (re)establishing for this user.
    // Mirrors user.ts: refresh if missing/expired/belongs to a different user.
    function mcpGrantNeedsRefresh(user) {
        var tok = getStoredMcpToken();
        var now = Date.now();
        var tokenSub = getJwtSub(tok && tok.access_token);
        var currentSub = user && typeof user.user_id === "string" ? user.user_id : null;
        var expired = !tok || (typeof tok.expires_at === "number" && tok.expires_at < now + 60000);
        var mismatched = !!tok && !!currentSub && !!tokenSub && tokenSub !== currentSub;
        return expired || mismatched;
    }

    // Silently refresh the MCP grant via the OAuth refresh_token flow — NO
    // browser redirect. Works while the stored refresh_token is valid and the
    // server session still exists (~30d): the server re-reads + re-persists the
    // user's session file on this call (skapi_admin.SkapiAdmin.load), which is
    // exactly what reconnects a "disconnected" MCP user. Resolves to the new
    // token, or null when there's nothing to refresh or the server rejected it.
    function refreshMcpToken() {
        var client = getStoredMcpClient();
        var current = getStoredMcpToken();
        if (!client || !current || !current.refresh_token) return Promise.resolve(null);

        var body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: current.refresh_token,
            client_id: client.client_id,
        });
        var headers = { "Content-Type": "application/x-www-form-urlencoded" };
        if (client.client_secret) {
            headers.Authorization = basicAuthHeader(client.client_id, client.client_secret);
        }
        return fetch(mcpBaseUrl() + "/oauth/token", {
            method: "POST", headers: headers, body: body.toString(),
        }).then(function (res) {
            return res.ok ? res.json() : null;
        }).then(function (json) {
            if (!json || !json.access_token) return null;
            var token = Object.assign({}, json, {
                refresh_token: json.refresh_token || current.refresh_token,
                expires_at: typeof json.expires_in === "number"
                    ? Date.now() + json.expires_in * 1000 : undefined,
            });
            lsSet(skey(SK.mcpToken), JSON.stringify(token));
            return token;
        }).catch(function () { return null; });
    }

    // Keep the MCP grant live WITHOUT disrupting the embedded host page. When
    // the stored grant is missing/expired/for-another-user, try the silent
    // refresh_token exchange first (no redirect). Resolves true if the grant is
    // now fresh (or already was), false if it could not be refreshed silently —
    // callers that can afford a redirect (boot) then fall back to
    // beginMcpOAuthOnLogin(); mid-chat callers stay silent so the host page
    // isn't yanked away (the next boot re-establishes the hard case).
    function ensureMcpGrantFresh() {
        if (!S.user || !mcpGrantNeedsRefresh(S.user)) return Promise.resolve(true);
        return refreshMcpToken().then(function (tok) {
            return !!(tok && !mcpGrantNeedsRefresh(S.user));
        });
    }

    /* ---- Google OAuth (outbound) ----------------------------------------- */

    function googleEnabled() {
        return !!S.opts.googleClientId;
    }

    function googleLogin() {
        if (!googleEnabled()) return;
        var redirectUrl = window.location.origin + window.location.pathname;
        // During an inbound platform flow, reuse the caller's state so the
        // post-Google IdP bounce returns the right state (oauth.ts useExistingState).
        var rnd = isInboundPlatformOAuth()
            ? getQueryParam("state")
            : Math.random().toString(36).substring(2);
        ssSet(skey(SK.googleInProgress), "1");
        ssSet(skey(SK.googleRedirect), redirectUrl);
        var url = GOOGLE_AUTH_URL +
            "?client_id=" + encodeURIComponent(S.opts.googleClientId) +
            "&redirect_uri=" + encodeURIComponent(redirectUrl) +
            "&response_type=code" +
            "&scope=" + encodeURIComponent(GOOGLE_SCOPE) +
            "&prompt=consent" +
            "&state=" + encodeURIComponent(rnd) +
            "&access_type=offline";
        window.location.replace(url); // replace() so Back won't return to a stale OAuth URL
    }

    function isGoogleOAuthReturn() {
        return !!getQueryParam("code") && ssGet(skey(SK.googleInProgress)) === "1";
    }

    // Exchange the Google auth code for a token via skapi's "ggl" client secret,
    // then openIdLogin. Mirrors oauth.ts handleGoogleOAuthReturn; the inbound
    // IdP bounce (oauth=platform) is handled by the caller in boot().
    function completeGoogleOAuthReturn() {
        var code = getQueryParam("code");
        var redirectUrl = ssGet(skey(SK.googleRedirect)) || (window.location.origin + window.location.pathname);
        var secretName = S.opts.googleClientSecretName || "ggl";

        return S.skapi.clientSecretRequest({
            clientSecretName: secretName,
            url: GOOGLE_TOKEN_URL,
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            data: {
                code: code,
                client_id: S.opts.googleClientId,
                client_secret: "$CLIENT_SECRET",
                redirect_uri: redirectUrl,
                grant_type: "authorization_code",
            },
        }).then(function (data) {
            ssDel(skey(SK.googleInProgress));
            ssDel(skey(SK.googleRedirect));
            if (!data || data.error || !data.access_token) {
                throw new Error((data && data.error) || "Google login failed.");
            }
            return S.skapi.openIdLogin({ id: "by_skapi", token: data.access_token })
                .catch(function (err) {
                    // Offer account merge on conflict, same as oauth.ts.
                    if (err && err.code === "ACCOUNT_EXISTS") {
                        if (window.confirm(
                            "An account with this Google account already exists.\n" +
                            "Merge accounts? Once merged you cannot login with the previous method."
                        )) {
                            return S.skapi.openIdLogin({ id: "by_skapi", token: data.access_token, merge: ["name"] });
                        }
                    }
                    throw err;
                });
        });
    }

    /* ---- Inbound IdP bounce (oauth=platform) ----------------------------- */
    // The MCP server's /oauth/authorize step authenticates the user against
    // skapi by redirecting the browser back here with
    //   ?oauth=platform&redirect_uri=<caller_cb>&state=<s>
    // bunnyquery then acts as the identity provider: it packages the skapi
    // session tokens into a `code` and bounces back to the caller's
    // redirect_uri. WITHOUT this, boot() would treat the logged-in user as
    // "needs MCP grant" and call beginMcpOAuthOnLogin() again — and the MCP
    // authorize step would bounce back here once more → infinite loop.
    // Mirrors oauth.ts (genOAuthCallbackUrl) + login.vue (returnOAuthToMCP).

    function isInboundPlatformOAuth() {
        return getQueryParam("oauth") === "platform" &&
            !!getQueryParam("state") &&
            !!getQueryParam("redirect_uri");
    }

    function genOAuthCallbackUrl(state, session, params) {
        var redirectUri = (params && params.redirect_uri) || getQueryParam("redirect_uri") || "";
        var code = {
            access_token: session.accessToken && session.accessToken.jwtToken,
            refresh_token: session.refreshToken && session.refreshToken.token,
            id_token: session.idToken && session.idToken.jwtToken,
        };
        var encoded = btoa(JSON.stringify(code));
        return redirectUri +
            (redirectUri.indexOf("?") !== -1 ? "&" : "?") +
            "code=" + encodeURIComponent(encoded) +
            "&state=" + encodeURIComponent(state);
    }

    // Bounce the browser back to the calling platform with a session-derived
    // code. Includes login.vue's race-guard: on refresh the logged-in user can
    // resolve before skapi.session is wired, so poll briefly before reading it.
    function returnOAuthToMCP() {
        var state = getQueryParam("state");
        if (!state) { renderLogin(); return; }
        var stashed = safeJsonParse(ssGet("oauth:" + state), null);
        var params = stashed || {
            oauth: "platform",
            state: state,
            redirect_uri: getQueryParam("redirect_uri"),
        };
        var waited = 0;
        (function attempt() {
            var session = S.skapi.session;
            if (session && session.accessToken && session.accessToken.jwtToken) {
                ssDel("oauth:" + state);
                window.location.replace(genOAuthCallbackUrl(state, session, params));
                return;
            }
            if (waited >= 3000) {
                console.error("[bunnyquery] OAuth bounce aborted: no skapi session.");
                renderLogin();
                return;
            }
            waited += 100;
            setTimeout(attempt, 100);
        })();
    }

    // Persist the inbound params so a fresh login (or a Google round-trip) can
    // recover redirect_uri after navigation. Keyed by state (no per-service
    // namespace) to match login.vue / oauth.ts.
    function stashInboundPlatformOAuth() {
        var state = getQueryParam("state");
        if (!state) return;
        try {
            var all = {};
            new URLSearchParams(window.location.search).forEach(function (v, k) { all[k] = v; });
            ssSet("oauth:" + state, JSON.stringify(all));
        } catch (e) { /* noop */ }
    }

    /* ========================================================================
     * 8. SHARED VIEW BITS
     * ======================================================================*/

    function authHeader(title) {
        return [
            title ? h("h1", { class: "bq-settings-title", text: title }) : null,
        ];
    }

    var THEME_ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
    var THEME_ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

    function themeToggleButton() {
        return h("button", {
            class: "bq-icon-btn",
            type: "button",
            title: "Toggle theme",
            dataset: { bqThemeToggle: "1" },
            html: S.theme === "dark" ? THEME_ICON_SUN : THEME_ICON_MOON,
            onclick: function () { toggleTheme(); },
        });
    }

    function loadingBtnLabel(loading, label) {
        return loading
            ? h("span", { class: "bq-btn-spinner" })
            : document.createTextNode(label);
    }

    function googleIconSvg() {
        return '<svg viewBox="0 0 48 48" style="width:20px;height:20px;flex:none">' +
            '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
            '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
            '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
            '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
            '</svg>';
    }

    /* ========================================================================
     * 9. LOGIN VIEW (other auth/account views land in later phases)
     * ======================================================================*/

    function loginErrorMessage(err) {
        if (!err) return "Login failed.";
        if (err.code === "USER_IS_DISABLED") return "This account is disabled.";
        if (err.code === "INCORRECT_USERNAME_OR_PASSWORD") return "Incorrect email or password.";
        if (err.code === "NOT_EXISTS") return "Incorrect email or password.";
        if (err.code === "SIGNUP_CONFIRMATION_NEEDED") return "Please confirm your email to log in.";
        if (err.message && err.message.indexOf("NOT_EXISTS") !== -1) return "The account does not exist.";
        return err.message || "Login failed.";
    }

    function renderLogin(prefill) {
        render("login", function () {
            var busy = false;
            var emailInput = h("input", {
                class: "bq-input-text", type: "email", autocomplete: "email",
                placeholder: "your@email.com", required: true,
                value: (prefill && prefill.email) || "",
            });
            var pwInput = h("input", {
                class: "bq-input-text", type: "password", autocomplete: "current-password",
                placeholder: "Enter password", required: true,
            });
            var submitBtn = h("button", { class: "btn", type: "submit" }, "Login");
            var errorBox = h("div", { class: "bq-error", style: { display: "none" } });

            function setBusy(b) {
                busy = b;
                emailInput.disabled = b;
                pwInput.disabled = b;
                submitBtn.disabled = b;
                clear(submitBtn).appendChild(loadingBtnLabel(b, "Login"));
            }
            function setError(msg) {
                errorBox.style.display = msg ? "" : "none";
                errorBox.textContent = msg || "";
            }

            function submit(e) {
                e.preventDefault();
                if (busy) return;
                setError("");
                setBusy(true);
                S.skapi.login({ email: emailInput.value, password: pwInput.value })
                    .then(function () {
                        // Inbound platform OAuth (e.g. MCP using skapi as IdP):
                        // bounce back to the caller instead of starting our own
                        // MCP oauth (which would loop).
                        if (isInboundPlatformOAuth()) {
                            return returnOAuthToMCP();
                        }
                        return beginMcpOAuthOnLogin("chat").catch(function (err) {
                            console.error("[bunnyquery] MCP OAuth bootstrap failed", err);
                            enterAfterLogin(); // MCP down — chat still works off skapi JWT
                        });
                    })
                    .catch(function (err) {
                        setBusy(false);
                        setError(loginErrorMessage(err));
                        if (err && err.code === "SIGNUP_CONFIRMATION_NEEDED") {
                            renderSignupConfirmation(emailInput.value);
                        } else if (err && err.code === "USER_IS_DISABLED" && S.opts.signup) {
                            // disabled account + signup enabled → offer recovery
                            renderEnableAccount(emailInput.value);
                        }
                    });
            }

            var actions = h("div", { class: "bq-actions" });
            actions.appendChild(h("button", { class: "bq-link", type: "button",
                onclick: function () { renderForgotPassword(emailInput.value); }, text: "Forgot password?" }));
            if (S.opts.signup) {
                actions.appendChild(h("button", { class: "bq-link", type: "button",
                    onclick: function () { renderSignup(); }, text: "Sign up →" }));
            }

            var form = h("form", { class: "bq-form", onsubmit: submit },
                h("label", { class: "bq-label" }, h("span", { text: "Email" }), emailInput),
                h("label", { class: "bq-label" }, h("span", { text: "Password" }), pwInput),
                actions,
                errorBox,
                h("div", { class: "bq-form-bottom" }, submitBtn)
            );

            var children = authHeader("Login").concat([form]);

            if (googleEnabled()) {
                children.push(
                    h("div", { class: "bq-divider" },
                        h("div", { class: "bq-divider-line" }),
                        h("span", { class: "bq-divider-text", text: "or" }),
                        h("div", { class: "bq-divider-line" })
                    ),
                    h("button", { class: "bq-google", type: "button", onclick: function () { googleLogin(); } },
                        h("span", { html: googleIconSvg() }),
                        h("span", { text: "Continue with Google" })
                    )
                );
            }

            return pageRoot(children);
        });
    }

    // Shared settings-view shell: header + optional back link. By default a
    // "← Back to login" link is appended at the bottom. Pass opts.topBack =
    // { label, onClick } to instead place a back link ABOVE the title (the
    // settings-page layout, e.g. the verify-email page's "← Back to settings").
    function authShell(title, children, opts) {
        opts = opts || {};
        var kids = [];
        if (opts.topBack) {
            kids.push(h("div", { class: "bq-settings-top" },
                h("button", { class: "bq-link", type: "button",
                    onclick: opts.topBack.onClick,
                    text: opts.topBack.label || "← Back" })));
        }
        kids = kids.concat(authHeader(title)).concat(children);
        if (opts.back !== false && !opts.topBack) {
            kids.push(h("div", { class: "bq-actions", style: { marginTop: "1.5rem" } },
                h("button", { class: "bq-link", type: "button",
                    onclick: function () { renderLogin(opts.backPrefill); },
                    text: "← Back to login" })));
        }
        return pageRoot(kids);
    }

    function genericErrorMessage(err) {
        if (!err) return "Something went wrong. Please try again.";
        if (err.code === "EXISTS" || err.code === "UsernameExistsException" ||
            (err.message && err.message.indexOf("already") !== -1 && err.message.indexOf("use") !== -1)) {
            return "This email is already in use.";
        }
        return err.message || "Something went wrong. Please try again.";
    }

    /* ---- signup ---------------------------------------------------------- */
    function renderSignup() {
        render("signup", function () {
            var busy = false;
            var email = h("input", { class: "bq-input-text", type: "email", autocomplete: "email",
                placeholder: "your@email.com", required: true });
            var name = h("input", { class: "bq-input-text", type: "text", autocomplete: "name",
                placeholder: "Your name", required: true });
            var pw = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password",
                placeholder: "Create a password", required: true, minlength: "6", maxlength: "60" });
            var pw2 = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password",
                placeholder: "Confirm password", required: true, minlength: "6", maxlength: "60" });
            var subscribe = h("input", { type: "checkbox", checked: true });
            var btn = h("button", { class: "btn", type: "submit" }, "Create account");
            var errBox = h("div", { class: "bq-error", style: { display: "none" } });

            function setBusy(b) {
                busy = b;
                [email, name, pw, pw2].forEach(function (i) { i.disabled = b; });
                subscribe.disabled = b;
                btn.disabled = b;
                clear(btn).appendChild(loadingBtnLabel(b, "Create account"));
            }
            function setError(m) { errBox.style.display = m ? "" : "none"; errBox.textContent = m || ""; }

            function submit(e) {
                e.preventDefault();
                if (busy) return;
                setError("");
                if (pw.value !== pw2.value) { setError("Passwords do not match."); return; }
                setBusy(true);
                var confirmUrl = S.opts.signupConfirmationUrl || (window.location.origin + window.location.pathname);
                S.skapi.signup(
                    { email: email.value, name: name.value, password: pw.value },
                    { signup_confirmation: confirmUrl, email_subscription: !!subscribe.checked }
                ).then(function () {
                    renderSignupConfirmation(email.value);
                }).catch(function (err) {
                    setBusy(false);
                    setError(genericErrorMessage(err));
                });
            }

            var form = h("form", { class: "bq-form", onsubmit: submit },
                h("label", { class: "bq-label" }, h("span", { text: "Email" }), email),
                h("label", { class: "bq-label" }, h("span", { text: "Name" }), name),
                h("label", { class: "bq-label" }, h("span", { text: "Password" }), pw),
                h("label", { class: "bq-label" }, h("span", { text: "Confirm password" }), pw2),
                h("label", { class: "bq-checkbox" }, subscribe, h("span", { text: "Receive newsletters from admin" })),
                errBox,
                h("div", { class: "bq-form-bottom" }, btn)
            );
            return authShell("Sign up", [form]);
        });
    }

    /* ---- signup confirmation (resend) ------------------------------------ */
    function renderSignupConfirmation(email) {
        render("signup-confirmation", function () {
            var busy = false;
            var btn = h("button", { class: "btn", type: "button" }, "Resend confirmation email");
            var note = h("div", { class: "bq-step-note" });

            function setBusy(b) { busy = b; btn.disabled = b; clear(btn).appendChild(loadingBtnLabel(b, "Resend confirmation email")); }
            function setNote(m, ok) {
                note.className = ok ? "bq-success-box" : "bq-error";
                note.style.display = m ? "" : "none";
                note.textContent = m || "";
            }
            setNote("", true); note.style.display = "none";

            btn.addEventListener("click", function () {
                if (busy) return;
                setBusy(true);
                S.skapi.resendSignupConfirmation().then(function () {
                    setBusy(false);
                    setNote("Confirmation email sent. Check your inbox.", true);
                }).catch(function (err) {
                    setBusy(false);
                    var msg = err && err.message ? err.message : "Could not resend.";
                    if (msg.indexOf("Least one login attempt") !== -1) {
                        msg = "Request expired. Please log in again to receive a new confirmation email.";
                    } else if (err && err.code === "INVALID_REQUEST") {
                        msg = "This account has already been confirmed. You can log in.";
                    }
                    setNote(msg, false);
                });
            });

            return authShell("Verify your email", [
                h("p", { class: "bq-settings-sub" },
                    "We sent a confirmation link to ",
                    h("strong", { text: email || "your email" }),
                    ". Click it to activate your account, then log in."),
                h("div", { class: "bq-form-bottom", style: { marginTop: "1.5rem" } }, btn, note),
            ], { backPrefill: { email: email } });
        });
    }

    /* ---- forgot password (3-step) ---------------------------------------- */
    function renderForgotPassword(prefillEmail) {
        var ctx = { step: 1, email: prefillEmail || "", code: "" };

        function go() {
            render("forgot-password", function () {
                if (ctx.step === 1) return stepRequest();
                if (ctx.step === 2) return stepVerify();
                if (ctx.step === 3) return stepReset();
                return stepDone();
            });
        }

        function stepRequest() {
            var busy = false;
            var email = h("input", { class: "bq-input-text", type: "email", autocomplete: "email",
                placeholder: "your@email.com", required: true, value: ctx.email });
            var btn = h("button", { class: "btn", type: "submit" }, "Send code");
            var errBox = h("div", { class: "bq-error", style: { display: "none" } });
            function setBusy(b) { busy = b; email.disabled = b; btn.disabled = b; clear(btn).appendChild(loadingBtnLabel(b, "Send code")); }
            function submit(e) {
                e.preventDefault();
                if (busy) return;
                errBox.style.display = "none";
                setBusy(true);
                ctx.email = email.value;
                S.skapi.forgotPassword({ email: ctx.email }).then(function () {
                    ctx.step = 2; go();
                }).catch(function (err) {
                    setBusy(false);
                    errBox.style.display = ""; errBox.textContent = (err && err.message) || "Could not send code.";
                });
            }
            return authShell("Reset password", [
                h("p", { class: "bq-step-note", text: "Enter your email and we'll send a verification code." }),
                h("form", { class: "bq-form", onsubmit: submit },
                    h("label", { class: "bq-label" }, h("span", { text: "Email" }), email),
                    errBox,
                    h("div", { class: "bq-form-bottom" }, btn))
            ]);
        }

        function stepVerify() {
            var code = h("input", { class: "bq-input-text", type: "text", placeholder: "Enter verification code", required: true });
            var resendBusy = false;
            var resendBtn = h("button", { class: "bq-link", type: "button", text: "Resend code" });
            var note = h("div", { class: "bq-step-note", style: { display: "none" } });
            resendBtn.addEventListener("click", function () {
                if (resendBusy) return;
                resendBusy = true; resendBtn.textContent = "Resending…";
                S.skapi.forgotPassword({ email: ctx.email }).then(function () {
                    resendBusy = false; resendBtn.textContent = "Resend code";
                    note.style.display = ""; note.className = "bq-success-box"; note.textContent = "Code re-sent.";
                }).catch(function (err) {
                    resendBusy = false; resendBtn.textContent = "Resend code";
                    note.style.display = ""; note.className = "bq-error"; note.textContent = (err && err.message) || "Could not resend.";
                });
            });
            function submit(e) {
                e.preventDefault();
                if (!code.value.trim()) return;
                ctx.code = code.value.trim();
                ctx.step = 3; go();
            }
            return authShell("Reset password", [
                h("p", { class: "bq-step-note" }, "We sent a code to ", h("strong", { text: ctx.email }), "."),
                h("form", { class: "bq-form", onsubmit: submit },
                    h("label", { class: "bq-label" }, h("span", { text: "Verification code" }), code),
                    h("div", { class: "bq-actions" }, resendBtn),
                    note,
                    h("div", { class: "bq-form-bottom" }, h("button", { class: "btn", type: "submit" }, "Continue")))
            ]);
        }

        function stepReset() {
            var busy = false;
            var pw = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password",
                placeholder: "New password", required: true, minlength: "6", maxlength: "60" });
            var pw2 = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password",
                placeholder: "Confirm new password", required: true, minlength: "6", maxlength: "60" });
            var btn = h("button", { class: "btn", type: "submit" }, "Reset password");
            var errBox = h("div", { class: "bq-error", style: { display: "none" } });
            function setBusy(b) { busy = b; pw.disabled = b; pw2.disabled = b; btn.disabled = b; clear(btn).appendChild(loadingBtnLabel(b, "Reset password")); }
            function submit(e) {
                e.preventDefault();
                if (busy) return;
                errBox.style.display = "none";
                if (pw.value !== pw2.value) { errBox.style.display = ""; errBox.textContent = "Passwords do not match."; return; }
                setBusy(true);
                S.skapi.resetPassword({ email: ctx.email, code: ctx.code, new_password: pw.value }).then(function () {
                    ctx.step = 4; go();
                }).catch(function (err) {
                    setBusy(false);
                    errBox.style.display = ""; errBox.textContent = (err && err.message) || "Could not reset password.";
                    ctx.step = 2; // bad/expired code → back to code entry
                    setTimeout(go, 1200);
                });
            }
            return authShell("Reset password", [
                h("form", { class: "bq-form", onsubmit: submit },
                    h("label", { class: "bq-label" }, h("span", { text: "New password" }), pw),
                    h("label", { class: "bq-label" }, h("span", { text: "Confirm new password" }), pw2),
                    errBox,
                    h("div", { class: "bq-form-bottom" }, btn))
            ]);
        }

        function stepDone() {
            return authShell("Password reset", [
                h("div", { class: "bq-success-box", text: "Your password has been changed. You can now log in with your new password." }),
                h("div", { class: "bq-form-bottom", style: { marginTop: "1.5rem" } },
                    h("button", { class: "btn", type: "button", onclick: function () { renderLogin({ email: ctx.email }); } }, "Go to login"))
            ], { back: false });
        }

        go();
    }

    /* ---- email verification (for logged-in users) ------------------------ */
    function renderEmailVerification(onDone) {
        var ctx = { step: 1, sending: false };

        function go() {
            render("email-verification", function () {
                return ctx.step === 1 ? stepEnter() : stepDone();
            });
        }

        function sendCode(noteEl) {
            if (ctx.sending) return Promise.resolve();
            ctx.sending = true;
            return S.skapi.verifyEmail().then(function () {
                ctx.sending = false;
                if (noteEl) { noteEl.style.display = ""; noteEl.className = "bq-success-box"; noteEl.textContent = "Code sent. Check your inbox."; }
            }).catch(function (err) {
                ctx.sending = false;
                if (noteEl) { noteEl.style.display = ""; noteEl.className = "bq-error"; noteEl.textContent = (err && err.message) || "Could not send code."; }
            });
        }

        function stepEnter() {
            var code = h("input", { class: "bq-input-text", type: "text", placeholder: "6-digit code", required: true });
            var btn = h("button", { class: "btn", type: "submit" }, "Verify");
            var note = h("div", { style: { display: "none" } });
            var resend = h("button", { class: "bq-link", type: "button", text: "Resend code",
                onclick: function () { sendCode(note); } });
            var busy = false;
            function setBusy(b) { busy = b; code.disabled = b; btn.disabled = b; clear(btn).appendChild(loadingBtnLabel(b, "Verify")); }
            function submit(e) {
                e.preventDefault();
                if (busy || !code.value.trim()) return;
                setBusy(true);
                S.skapi.verifyEmail({ code: code.value.trim() }).then(function () {
                    ctx.step = 2; go();
                }).catch(function (err) {
                    setBusy(false);
                    note.style.display = ""; note.className = "bq-error"; note.textContent = (err && err.message) || "Invalid code.";
                });
            }
            var emailTxt = (S.user && S.user.email) || "your email";
            var shell = authShell("Verify your email", [
                h("p", { class: "bq-step-note" }, "We sent a code to ", h("strong", { text: emailTxt }), "."),
                h("form", { class: "bq-form", onsubmit: submit },
                    h("label", { class: "bq-label" }, h("span", { text: "Verification code" }), code),
                    h("div", { class: "bq-actions" }, resend),
                    note,
                    h("div", { class: "bq-form-bottom" }, btn))
            ], { topBack: { label: "← Back to settings",
                onClick: function () { renderChat(); openChatSettings(); } } });
            // auto-send the first code on entry
            sendCode(note);
            return shell;
        }

        function stepDone() {
            return authShell("Email verified", [
                h("div", { class: "bq-success-box", text: ((S.user && S.user.email) || "Your email") + " has been verified." }),
                h("div", { class: "bq-form-bottom", style: { marginTop: "1.5rem" } },
                    h("button", { class: "btn", type: "button", onclick: function () { (onDone || renderChat)(); } }, "Continue"))
            ], { back: false });
        }

        go();
    }

    /* ---- settings (in-place panel reached from the chat header gear) ------ */
    function settingsSectionTitle(text) {
        return h("div", { class: "bq-settings-section-title", text: text });
    }
    function accountRow(label, valueNodes, actionLabel, onAction, opts) {
        opts = opts || {};
        return h("div", { class: "bq-account-row" },
            h("div", { class: "bq-account-row-main" },
                h("div", { class: "bq-account-label", text: label }),
                h("div", { class: "bq-account-value" + (opts.muted ? " is-muted" : "") }, valueNodes)),
            onAction ? h("button", { class: "bq-link" + (opts.dangerAction ? " bq-link--danger" : ""), type: "button", onclick: onAction, text: actionLabel || "Change" }) : null);
    }
    function getNewsletterStatus() {
        // getNewsletterSubscription returns [{ active, group, subscribed_email, timestamp }]
        // (or a DatabaseResponse with that as .list). An UNSUBSCRIBED user can still have a
        // record with active:false, so check for an *active* record in the authorized group (1).
        try {
            return Promise.resolve(S.skapi.getNewsletterSubscription({ group: "authorized" }))
                .then(function (res) {
                    var list = res && res.list ? res.list : res;
                    if (!Array.isArray(list)) return false;
                    return list.some(function (s) { return s && s.active && s.group === 1; });
                })
                .catch(function () { return false; });
        } catch (e) { return Promise.resolve(false); }
    }
    // Settings opens IN PLACE inside the chat's messages area (the header stays;
    // the composer is swapped for a "Close" bar; the gear takes the main color). Toggling
    // the gear again — or the close bar — returns to the chat.
    function toggleChatSettings() {
        if (CS.chatSettingsOpen) closeChatSettings(); else openChatSettings();
    }
    function openChatSettings() {
        if (!CS.messagesBox || !CS.chatEl || !CS.composerEl) return;
        CS.chatSettingsOpen = true;
        if (CS.settingsBtnEl) CS.settingsBtnEl.classList.add("is-active");
        // remove the composer entirely so the settings panel fills the chat area
        if (CS.composerEl.parentNode === CS.chatEl) CS.chatEl.removeChild(CS.composerEl);
        renderAccount();
    }
    function closeChatSettings() {
        CS.chatSettingsOpen = false;
        if (CS.settingsBtnEl) CS.settingsBtnEl.classList.remove("is-active");
        // restore the composer
        if (CS.composerEl && CS.chatEl && CS.composerEl.parentNode !== CS.chatEl) CS.chatEl.appendChild(CS.composerEl);
        renderMessages();   // restore the chat (renderMessages no-ops while settings is open)
        scrollToBottom();
    }
    // Fetch profile/newsletter, then render the settings panel into the box.
    function renderAccount() {
        if (!CS.messagesBox) return;
        clear(CS.messagesBox);
        CS.messagesBox.appendChild(h("div", { class: "bq-chat-settings" },
            h("div", { class: "bq-chat-settings-loading" }, bunnyLoader("Loading..."))));
        Promise.all([getProfile(), getNewsletterStatus()]).then(function (res) {
            if (res[0]) S.user = res[0];
            S.newsletterSubscribed = res[1];
            renderSettingsIntoBox();
        }).catch(function () { renderSettingsIntoBox(); });
    }
    function newsletterRow() {
        var checkbox = h("input", { type: "checkbox", checked: !!S.newsletterSubscribed });
        var busy = false;
        checkbox.addEventListener("change", function () {
            if (busy) return;
            busy = true;
            var want = checkbox.checked;
            var op = want ? S.skapi.subscribeNewsletter({ group: "authorized" })
                : S.skapi.unsubscribeNewsletter({ group: "authorized" });
            Promise.resolve(op).then(function () { S.newsletterSubscribed = want; busy = false; })
                .catch(function (err) { checkbox.checked = !want; busy = false; alert((err && err.message) || "Could not update subscription."); });
        });
        return h("div", { class: "bq-account-row" },
            h("label", { class: "bq-checkbox" }, checkbox,
                h("span", { text: "Receive newsletter from admin" })));
    }
    function themeRow() {
        var current = S.theme === "dark" ? "dark" : "light";
        function themeRadio(value, label) {
            var input = h("input", { type: "radio", name: "bq-theme" });
            input.checked = (value === current);
            input.addEventListener("change", function () { if (input.checked) applyTheme(value); });
            return h("label", { class: "bq-checkbox" }, input, h("span", { text: label }));
        }
        return h("div", { class: "bq-account-row" },
            // h("div", { class: "bq-account-row-main" },
            //     h("div", { class: "bq-account-label", text: "Theme" })),
            h("div", { class: "bq-theme-radios" },
                themeRadio("light", "Light mode"),
                themeRadio("dark", "Dark mode")));
    }
    function dangerItem(label, desc, btnLabel, onClick) {
        return h("div", { class: "bq-danger-item" },
            h("div", { class: "bq-danger-item-title", text: label }),
            h("p", { class: "bq-danger-item-desc", text: desc }),
            h("button", { class: "btn btn--danger", type: "button", onclick: onClick, text: btnLabel }));
    }
    function renderSettingsIntoBox() {
        if (!CS.messagesBox) return;
        var u = S.user || {};
        var children = [];
        children.push(h("div", { class: "bq-settings-top" },
            h("button", { class: "bq-link", type: "button", onclick: function () { closeChatSettings(); }, text: "← Back to chat" })));
        children.push(h("h1", { class: "bq-settings-title", text: "Settings" }));
        if (!u.email_verified) {
            children.push(h("div", { class: "bq-account-tip" },
                h("strong", { text: "Verify your email. " }),
                document.createTextNode("A verified email is required to recover your password or re-enable your account if you ever lose access."),
                h("div", { style: { marginTop: "0.75rem" } },
                    h("button", { class: "btn", type: "button",
                        onclick: function () { renderEmailVerification(renderChat); }, text: "Verify now" }))));
        }

        // ── Chat box section ──
        children.push(settingsSectionTitle("Theme"));
        children.push(h("div", { class: "bq-account-section" }, themeRow()));

        // ── Account section ──
        var emailValue = [
            document.createTextNode(u.email || "—"),
            h("span", { class: "bq-verify-badge " + (u.email_verified ? "is-verified" : "is-unverified"),
                text: u.email_verified ? "verified" : "unverified" }),
        ];
        children.push(settingsSectionTitle("Account"));
        children.push(h("div", { class: "bq-account-section" },
            accountRow("Email", emailValue, "Change", function () { openChangeEmailModal(); }),
            accountRow("Name", [document.createTextNode(u.name || "Unnamed user")], "Change", function () { openChangeNameModal(); }),
            (u.signup_ticket === "OIDPASS"
                ? accountRow("Password", [document.createTextNode("Managed by your login provider")], null, null, { muted: true })
                : accountRow("Password", [document.createTextNode("••••••••")], "Change", function () { openChangePasswordModal(); })),
            newsletterRow()
        ));
        // ── Danger zone (clear history always; remove account when signup) ──
        var danger = [h("div", { class: "bq-account-danger-title", text: "Danger zone" })];
        danger.push(dangerItem("Clear history",
            "Hide the current conversation. Your messages stay on the server but won't be shown here again.",
            "Clear history", function () { openClearHistoryModal(); }));
        if (S.opts.signup) {
            danger.push(dangerItem("Remove account",
                "Remove your account and delete all your data. You can re-enable within 30 days by logging in.",
                "Remove account", function () { openDeleteAccountModal(); }));
        }
        children.push(h("div", { class: "bq-account-danger" }, danger));
        children.push(h("div", { class: "bq-account-logout" },
            h("button", { class: "bq-link", type: "button", onclick: function () { logout(); }, text: "Logout →" })));
        children.push(pageFooter());

        clear(CS.messagesBox);
        CS.messagesBox.appendChild(h("div", { class: "bq-chat-settings" }, children));
    }

    // edit modals
    function modalForm(title, desc, fields, submitLabel, onSubmit) {
        return openModal(function (close) {
            var err = h("div", { class: "bq-error", style: { display: "none" } });
            var btn = h("button", { class: "btn", type: "submit" }, submitLabel);
            var busy = false;
            function setBusy(b) { busy = b; btn.disabled = b; clear(btn).appendChild(loadingBtnLabel(b, submitLabel)); }
            function setErr(m) { err.style.display = m ? "" : "none"; err.textContent = m || ""; }
            function submit(e) {
                e.preventDefault();
                if (busy) return;
                setErr("");
                setBusy(true);
                Promise.resolve(onSubmit(close)).then(function (msg) {
                    if (msg && msg.error) { setBusy(false); setErr(msg.error); }
                }).catch(function (e2) { setBusy(false); setErr((e2 && e2.message) || "Something went wrong."); });
            }
            var labels = fields.map(function (f) { return h("label", { class: "bq-label" }, h("span", { text: f.label }), f.input); });
            return h("div", { class: "bq-modal" },
                h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
                h("h2", { class: "bq-modal-title", text: title }),
                desc ? h("p", { class: "bq-modal-desc", text: desc }) : null,
                h("form", { class: "bq-form", onsubmit: submit }, labels.concat([err,
                    h("div", { class: "bq-modal-btns" },
                        h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Cancel"), btn)])));
        });
    }
    function openChangeNameModal() {
        var input = h("input", { class: "bq-input-text", type: "text", value: (S.user && S.user.name) || "", placeholder: "Your name", required: true });
        modalForm("Change name", null, [{ label: "Name", input: input }], "Save", function (close) {
            return S.skapi.updateProfile({ name: input.value }).then(function () {
                if (S.user) S.user.name = input.value;
                close(); renderAccount();
            });
        });
    }
    function openChangeEmailModal() {
        var input = h("input", { class: "bq-input-text", type: "email", value: (S.user && S.user.email) || "", placeholder: "your@email.com", required: true });
        modalForm("Change email",
            "After changing your email you'll need to verify it. A verified email is required to recover your account.",
            [{ label: "New email", input: input }], "Save", function (close) {
                return S.skapi.updateProfile({ email: input.value }).then(function () {
                    if (S.user) { S.user.email = input.value; S.user.email_verified = false; }
                    close(); renderEmailVerification(renderChat);
                });
            });
    }
    function openChangePasswordModal() {
        var cur = h("input", { class: "bq-input-text", type: "password", autocomplete: "current-password", placeholder: "Current password", required: true });
        var pw = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password", placeholder: "New password", required: true, minlength: "6", maxlength: "60" });
        var pw2 = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password", placeholder: "Confirm new password", required: true, minlength: "6", maxlength: "60" });
        modalForm("Change password", null,
            [{ label: "Current password", input: cur }, { label: "New password", input: pw }, { label: "Confirm new password", input: pw2 }],
            "Change password", function (close) {
                if (pw.value !== pw2.value) return { error: "New passwords do not match." };
                return S.skapi.changePassword({ current_password: cur.value, new_password: pw.value }).then(function () {
                    close();
                });
            });
    }
    function openDeleteAccountModal() {
        openModal(function (close) {
            var agree = h("input", { type: "checkbox" });
            var err = h("div", { class: "bq-error", style: { display: "none" } });
            var btn = h("button", { class: "btn btn--danger", type: "button" }, "Disable account");
            var busy = false;
            btn.addEventListener("click", function () {
                if (busy) return;
                if (!agree.checked) { err.style.display = ""; err.textContent = "Please confirm you want to disable your account."; return; }
                err.style.display = "none";
                busy = true; btn.disabled = true; clear(btn).appendChild(loadingBtnLabel(true, "Disable account"));
                Promise.resolve(S.skapi.disableAccount()).then(function () {
                    clearStoredMcpToken(); S.user = null; close(); renderBye();
                }).catch(function (e2) {
                    busy = false; btn.disabled = false; clear(btn).appendChild(document.createTextNode("Disable account"));
                    err.style.display = ""; err.textContent = (e2 && e2.message) || "Could not disable account.";
                });
            });
            return h("div", { class: "bq-modal" },
                h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
                h("div", { class: "bq-modal-delete-header" }, h("span", { text: "Disable account" })),
                h("p", { class: "bq-modal-desc" }, "Your data and projects will be hidden and permanently removed after 30 days. You can re-enable within that window by logging in."),
                h("label", { class: "bq-checkbox", style: { marginBottom: "1rem" } }, agree, h("span", { text: "I understand and want to disable my account." })),
                err,
                h("div", { class: "bq-modal-btns" },
                    h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Cancel"), btn));
        });
    }
    function renderBye() {
        render("bye", function () {
            return pageRoot(authHeader("Account disabled").concat([
                h("p", { class: "bq-settings-sub" }, "Your account has been disabled. All your data will be removed after 90 days. You can recover within that period by logging in and following the recovery email."),
                h("div", { class: "bq-form-bottom", style: { marginTop: "1.5rem" } },
                    h("button", { class: "btn", type: "button", onclick: function () { renderLogin(); }, text: "Back to login" })),
            ]));
        });
    }
    function renderEnableAccount(email) {
        var sent = false;
        render("enable-account", function () {
            var busy = false;
            var btn = h("button", { class: "btn", type: "button" }, "Re-send recovery email");
            var note = h("div", { style: { display: "none" } });
            function send() {
                if (busy) return;
                busy = true; btn.disabled = true; clear(btn).appendChild(loadingBtnLabel(true, "Re-send recovery email"));
                Promise.resolve(S.skapi.recoverAccount(window.location.origin + window.location.pathname)).then(function () {
                    busy = false; btn.disabled = false; clear(btn).appendChild(document.createTextNode("Re-send recovery email"));
                    note.style.display = ""; note.className = "bq-success-box"; note.textContent = "Recovery email sent. Check your inbox.";
                }).catch(function (err) {
                    busy = false; btn.disabled = false; clear(btn).appendChild(document.createTextNode("Re-send recovery email"));
                    note.style.display = ""; note.className = "bq-error"; note.textContent = (err && err.message) || "Could not send recovery email.";
                });
            }
            btn.addEventListener("click", send);
            if (!sent) { sent = true; send(); } // auto-send on first entry
            return authShell("Re-enable account", [
                h("p", { class: "bq-settings-sub" }, "We've sent a recovery link to ", h("strong", { text: email || "your email" }),
                    ". Click it to re-enable your account."),
                h("div", { class: "bq-form-bottom", style: { marginTop: "1.5rem" } }, btn, note),
            ]);
        });
    }

    /* ========================================================================
     * CHAT ENGINE
     * Ported from agent.vue + ai_agent.ts. Vue reactivity → explicit
     * renderMessages()/refreshMessageBubble() calls. `currentService.value`
     * → S.serviceId/S.owner/S.serviceName/S.serviceDescription.
     * Attachments + expired-link refresh are stubbed (next phase).
     * ======================================================================*/

    // ---- chat constants (from ai_agent.ts) -------------------------------
    var WEB_FETCH_MAX_USES = 40;
    var WEB_FETCH_MAX_CONTENT_TOKENS = 200000;
    var DEFAULT_OPENAI_IMAGE_DETAIL = "auto";
    var OPENAI_WEB_SEARCH_ENABLED = true;
    var OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS = true;
    var IMAGE_URL_REGEX =
        /\bhttps?:\/\/[^\s<>"'()\[\]]+?\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s<>"'()\[\]]*)?/gi;



    // ---- chat state ------------------------------------------------------
    var CS = {
        messages: [],
        messageEls: [],          // parallel rendered .bq-message nodes
        messagesBox: null,       // .bq-messages element
        sending: false,
        typing: false,
        typingAbort: false,
        typewriterQueue: Promise.resolve(),
        stickToBottom: true,
        loadingHistory: false,
        loadingOlderHistory: false,
        historyEndOfList: false,
        historyStartKeyHistory: [],
        historyRequestToken: 0,
        gateRefreshToken: 0,
        clearing: false,
        pollTimer: null,
        attachments: [],          // [{ id, name, file, status, progress, uploadedUrl, storagePath, errorMessage }]
        uploadingAttachments: false,
        attachmentWarning: "",
        attachmentCapNotice: "",  // informational "N files not added" when an add hit MAX_ATTACHMENT_FILE_COUNT
        attachmentsRow: null,     // .bq-attachments DOM node
        attachBtnEl: null,
        sendBtnEl: null,
        inputEl: null,            // .bq-input textarea
        chatEl: null,             // .bq-chat (for overflow height measurement)
        visibleAttachmentCount: Infinity, // how many chips fit before "...(x) more"
    };
    var aiChatHistoryCache = {};
    var pendingAgentRequests = {};
    var historyItemPolls = new Map();
    var bgTaskQueue = [];
    var cancelledServerIds = new Set();
    var refreshingLinkMap = {};
    var refreshedExpiredLinkMap = {};
    var refreshingLinkPromises = new Map();
    var fileBlobCache = new Map();
    var markedReady = null;

    /* ---- shared chat engine (ChatSession) -------------------------------- *
     * The chat state machine (send / queue / cancel / typewriter / dispatch /
     * history-item resolution / bg-task drain / history cache) lives in
     * @skapi/chat-engine. We construct ONE session and bridge it to the existing
     * view code: (1) the session's queue/cache fields point at THIS module's
     * globals so both mutate the same objects; (2) the session-owned CS chat-
     * state fields are delegated to session.state via accessors, so every
     * existing `CS.<field>` read/write in renderMessages/fetchHistoryPage/etc.
     * transparently drives the single source of truth. The view keeps rendering,
     * markdown parse, DOM refs, scroll, attachments, and the auth/account shell.
     * Host fns are hoisted function declarations, so referencing them here (before
     * their definitions further down) is fine; the constructor never calls them. */
    var session = new ChatSession({
        getIdentity: function () {
            return {
                serviceId: S.serviceId, owner: S.owner,
                userId: (S.user && S.user.user_id) || S.serviceId,
                platform: S.aiPlatform, model: S.aiModel || undefined,
                serviceName: S.serviceName, serviceDescription: S.serviceDescription,
            };
        },
        buildSystemPrompt: function () { return buildSystemPrompt(); },
        notify: function () { renderMessages(); },
        refreshMessageBubble: function (i) { refreshMessageBubble(i); },
        scrollToBottom: function (smooth) { return scrollToBottom(smooth); },
        scrollToBottomIfSticky: function (smooth) { return scrollToBottomIfSticky(smooth); },
        cancelRequest: function (opts) { return S.skapi.cancelClientSecretRequest(opts); },
        refreshSession: function () { return refreshSkapiSession(); },
        formatIndexingLabel: function (name, mime, size, storagePath, reindex) {
            return buildIndexingLabel(name, mime, size, storagePath, reindex);
        },
        isViewMounted: function () { return !!CS.messagesBox; },
        getClearedAt: function () { return getClearedAt(); },
        // attachment upload I/O (bunnyquery: get-signed-url + db CDN)
        uploadFile: function (a) { return uploadFileToDb(a.file, a.storagePath, a.onProgress, a.setAbort, a.checkExistence); },
        getTemporaryUrl: function (path) { return getTemporaryUrlDb(path, ATTACHMENT_URL_EXPIRES_SECONDS); },
        deleteExistingFileRecord: function (path) { return deleteFileIndexRecordDb(path); },
        storagePathFor: function (relPath) { return attachmentStoragePath(relPath); },
        getMimeType: function (name) { return mimeGetType(name); },
        promptOverwrite: function (filename) { return promptOverwrite(filename); },
        resetOverwriteBatch: function () { return resetOverwriteBatch(); },
        renderAttachmentChips: function () { renderAttachmentChips(); },
        updateComposerControls: function () { updateComposerControls(); },
    });
    // Share the queue/cache objects (all mutated in place) between the session
    // and this module's globals so the still-view-side code (fetchHistoryPage,
    // uploadSingleAttachment) and the session never diverge.
    session.bgTaskQueue = bgTaskQueue;
    session.cancelledServerIds = cancelledServerIds;
    session.pendingAgentRequests = pendingAgentRequests;
    session.aiChatHistoryCache = aiChatHistoryCache;
    session.historyItemPolls = historyItemPolls;
    // Delegate the session-owned chat-state fields: existing `CS.x` references
    // now read/write session.state.x.
    ["messages", "attachments", "uploadingAttachments", "sending", "typing", "typingAbort",
        "loadingHistory", "loadingOlderHistory", "historyEndOfList", "historyStartKeyHistory",
        "historyRequestToken", "gateRefreshToken"
    ].forEach(function (k) {
        Object.defineProperty(CS, k, {
            get: function () { return session.state[k]; },
            set: function (v) { session.state[k] = v; },
            configurable: true, enumerable: true,
        });
    });

    // db-CDN host for temporary file URLs. Mirrors bunnyquery's env split:
    // dev files are served from db.skapi.app, prod from db.skapi.com. An
    // explicit opts.hostDomain always wins (e.g. a project on a custom domain).
    function hostDomain() { return S.opts.hostDomain || (S.opts.dev ? "skapi.app" : "skapi.com"); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function raf2() {
        return new Promise(function (res) {
            requestAnimationFrame(function () { requestAnimationFrame(function () { res(); }); });
        });
    }
    function mimeGetType(name) {
        var ext = (String(name || "").split(".").pop() || "").toLowerCase();
        var map = {
            txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
            html: "text/html", htm: "text/html", js: "text/javascript", ts: "text/plain",
            css: "text/css", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
            pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
        };
        return map[ext] || null;
    }
    function loadMarked() {
        if (markedReady) return markedReady;
        if (window.marked && typeof window.marked.parse === "function") {
            markedReady = Promise.resolve();
            return markedReady;
        }
        markedReady = new Promise(function (resolve) {
            var s = document.createElement("script");
            s.src = MARKED_CDN;
            s.onload = function () { resolve(); };
            s.onerror = function () { resolve(); }; // fall back to plain text
            document.head.appendChild(s);
        });
        return markedReady;
    }


    /* ---- system prompt (agent.vue buildSystemPrompt) --------------------- */
    function buildSystemPrompt() {
        // The chat system prompt now lives in @skapi/chat-engine (shared with the
        // agent.vue chatbox so the two can't drift). bunnyquery has no "formatted"
        // service id, so the raw serviceId is used directly.
        return buildChatSystemPrompt({
            formattedServiceId: S.serviceId || "",
            serviceName: S.serviceName,
            serviceDescription: S.serviceDescription,
        });
    }

    function refreshSkapiSession() {
        // Refresh BOTH credentials the chat depends on: (1) the skapi JWT (the
        // $ACCESS_TOKEN bearer the MCP server decodes for the user's sub), and
        // (2) the MCP grant / server-side session. The engine calls this on any
        // auth-expired (401) before resending — and an MCP 401 (a stale/cleaned
        // server session) is NOT fixed by a fresh JWT alone, so silently
        // re-establish the grant here too. No redirect: a mid-chat reconnect
        // stays transparent (the engine resends right after this resolves).
        return S.skapi.getProfile({ refreshToken: true })
            .then(function () { return ensureMcpGrantFresh(); })
            .then(function () { return true; })
            .catch(function () { return false; });
    }

    function sendMessage() {
        var inputEl = CS.messagesBox && CS.messagesBox.parentNode &&
            CS.messagesBox.parentNode.querySelector(".bq-input");
        var text = (inputEl ? inputEl.value : "").trim();
        var hasAttachments = CS.attachments.length > 0;
        if (!text && !hasAttachments) return;
        if (!chatEnabled() || S.aiPlatform === "none") return;
        if (CS.uploadingAttachments) return; // already uploading; ignore double-submit

        // Over the attachment limit *with* a chat message: block the send. The
        // send button is disabled in this state, but the Enter key would bypass
        // it. The warning clears when the user removes files or clears the text.
        recomputeAttachmentWarning();
        if (CS.attachmentWarning) { renderAttachmentChips(); updateComposerControls(); return; }

        if (inputEl) { inputEl.value = ""; autoGrowInput(inputEl); }

        if (!hasAttachments) { session.dispatchComposedMessage(text, false); return; }

        // Upload attachments to db storage first, kick off background indexing,
        // then send the (optional) chat turn on the bg queue so it runs AFTER
        // the newly uploaded files have been indexed.
        var bgBefore = bgTaskQueue.length;
        session.uploadPendingAttachments().then(function (attachmentUrls) {
            var hasNewIndexing = bgTaskQueue.length > bgBefore;
            // Collect any failures (upload or indexing) now, grouped by error
            // code + description, so we can report them once after the send below.
            var failureGroups = groupAttachmentFailures(CS.attachments);
            // Per-file "Indexing:" bubbles were already injected during upload (#1).
            // Keep only the FAILED chips (red/yellow) so the user can see/retry;
            // clear the successful ones.
            clearSuccessfulAttachments();
            if (text) {
                // Compose the user message (attachment-link block + office-extraction
                // placeholders) via the shared engine helper — identical to agent.vue —
                // then dispatch through the shared ChatSession (which owns the queued-
                // vs-immediate decision, the cache+resume immediate-send model, the
                // office extractContent, and the "-bg" queue routing).
                var c = composeUserMessage(text, attachmentUrls);
                session.dispatchComposedMessage(c.composed, hasNewIndexing, c.composedForLlm, c.extractContent, c.fileUrls);
            }
            // After the uploads + indexing-queue requests are all made, surface a
            // single report of everything that failed (grouped by error).
            if (failureGroups.length) showUploadErrorReport(failureGroups);
        }).catch(function (err) {
            console.error("[bunnyquery] attachment upload failed", err);
            CS.uploadingAttachments = false; updateComposerControls(); renderAttachmentChips();
            CS.messages.push({ role: "assistant", content: "Something went wrong while uploading attachments. " + ((err && err.message) || ""), isError: true });
            renderMessages(); scrollToBottom(true);
        });
    }

    function scrollToBottom(smooth) {
        return raf2().then(function () {
            if (!CS.messagesBox) return;
            CS.stickToBottom = true;
            if (smooth) CS.messagesBox.scrollTo({ top: CS.messagesBox.scrollHeight, behavior: "smooth" });
            else CS.messagesBox.scrollTop = CS.messagesBox.scrollHeight;
        });
    }
    // Only scrolls if the user is already at the bottom. Used by automated
    // resolutions (the streaming typewriter, bg-task polls, history polling) so
    // they don't yank the user away when they've scrolled up to read old
    // messages. Unlike scrollToBottom, this does NOT force-pin CS.stickToBottom:
    // it re-checks after the DOM settles and bails if the user scrolled up
    // mid-tick, so a streamed response can't repeatedly drag them back down.
    function scrollToBottomIfSticky(smooth) {
        if (!CS.stickToBottom) return Promise.resolve();
        return raf2().then(function () {
            if (!CS.stickToBottom || !CS.messagesBox) return;
            if (smooth) CS.messagesBox.scrollTo({ top: CS.messagesBox.scrollHeight, behavior: "smooth" });
            else CS.messagesBox.scrollTop = CS.messagesBox.scrollHeight;
        });
    }
    function onHistoryScroll() {
        if (!CS.messagesBox || CS.chatSettingsOpen) return;
        var el = CS.messagesBox;
        CS.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
        if (el.scrollTop <= 60) fetchOlderHistoryIfNeeded();
    }
    // Explicit user scroll-UP intent. wheel/touch fire synchronously on the
    // user's action (and never for programmatic scrolls), so releasing
    // stickToBottom here beats the streaming typewriter's per-tick auto-scroll —
    // letting the user scroll up to read earlier messages while a response is
    // still generating. (Re-sticking on scroll-to-bottom is done by onHistoryScroll.)
    var _touchStartY = 0;
    function onMessagesWheel(e) {
        if (e.deltaY < 0) CS.stickToBottom = false;
    }
    function onMessagesTouchStart(e) {
        _touchStartY = (e.touches && e.touches[0]) ? e.touches[0].clientY : 0;
    }
    function onMessagesTouchMove(e) {
        // Finger dragging DOWN the screen scrolls content UP (toward earlier
        // messages), so release stickiness.
        var y = (e.touches && e.touches[0]) ? e.touches[0].clientY : 0;
        if (y > _touchStartY + 4) CS.stickToBottom = false;
    }

    /* ---- render helpers (agent.vue) -------------------------------------- */
    function normalizeTrailingInlineToken(value) {
        if (!value) return value;
        var out = value.replace(/[.,;:!?]+$/, "");
        var trimUnmatched = function (openCh, closeCh) {
            while (out.charAt(out.length - 1) === closeCh) {
                var openCount = (out.match(new RegExp("\\" + openCh, "g")) || []).length;
                var closeCount = (out.match(new RegExp("\\" + closeCh, "g")) || []).length;
                if (closeCount > openCount) out = out.slice(0, -1); else break;
            }
        };
        trimUnmatched("(", ")"); trimUnmatched("[", "]"); trimUnmatched("{", "}");
        out = out.replace(/[`'"*>]+$/, "");
        return out;
    }
    function getOrCreateFileHref(filename, body) {
        var key = filename + " " + body;
        var existing = fileBlobCache.get(key);
        if (existing) return existing;
        var contentType = mimeGetType(filename) || "text/plain";
        var ext = (String(filename || "").split(".").pop() || "").toLowerCase();
        var isText = /^text\//i.test(contentType) || /application\/(json|xml|csv|yaml|x-yaml|javascript)/i.test(contentType);
        // Prepend a UTF-8 BOM for spreadsheet-family text: Korean-Windows Excel
        // otherwise decodes a BOM-less CSV as CP949 and mojibakes every column.
        var needsBom = ext === "csv" || ext === "tsv" || ext === "tab";
        var type = isText ? contentType + "; charset=utf-8" : contentType;
        var data = needsBom ? "﻿" + body : body;
        var href = URL.createObjectURL(new Blob([data], { type: type }));
        fileBlobCache.set(key, href);
        return href;
    }
    function fileToAnchorHtml(filename, href) {
        var text = "↗ " + filename;
        return '<a class="bq-file-download" href="' + escapeHtml(href) + '" download="' + escapeHtml(filename) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(text) + "</a>";
    }
    function linkToAnchorHtml(link) {
        var refreshing = !!refreshingLinkMap[link.expiredHref || link.href];
        var cls = ["bq-link-button"];
        if (link.expired) cls.push("is-expired");
        if (refreshing) cls.push("is-refreshing");
        var labelText = "↗ " + link.label + (refreshing ? " (fetching...)" : "");
        var attrs = [
            'class="' + cls.join(" ") + '"', 'href="' + escapeHtml(link.href) + '"',
            'target="_blank"', 'rel="noopener noreferrer"',
            'title="' + escapeHtml(link.fullLabel || link.label) + '"',
            'download="' + escapeHtml(link.fullLabel || link.label) + '"', 'data-bq-link="1"',
        ];
        if (link.expired) attrs.push('data-bq-expired="1"');
        if (link.expiredHref) attrs.push('data-bq-expired-href="' + escapeHtml(link.expiredHref) + '"');
        if (link.remotePath) attrs.push('data-bq-remote-path="' + escapeHtml(link.remotePath) + '"');
        if (link.fullLabel) attrs.push('data-bq-full-label="' + escapeHtml(link.fullLabel) + '"');
        return "<a " + attrs.join(" ") + ">" + escapeHtml(labelText) + "</a>";
    }
    function buildLinkPartFromGroups(full, g1, g2, g3, g4, g5, g6) {
        var dbHostPrefix = "https://db." + hostDomain();
        if (g1) {
            var rawPath = normalizeTrailingInlineToken(g1);
            var consumed = "src::" + rawPath;
            var tail = full.slice(consumed.length);
            var isUrl = /^https?:\/\//i.test(rawPath);
            if (isUrl && /^https:\/\//i.test(rawPath) && rawPath.toLowerCase().indexOf(dbHostPrefix.toLowerCase()) !== 0) {
                return { part: { type: "link", label: truncateLabelForDisplay(rawPath), fullLabel: rawPath, href: rawPath, expired: false }, tail: tail };
            }
            var remotePath = isUrl ? (extractRemotePathFromAttachmentHref(rawPath, S.serviceId) || normalizeAttachmentPathCandidate(rawPath)) : normalizeAttachmentPathCandidate(rawPath);
            if (!remotePath) return null;
            var expiredHref = buildDisplayExpiredAttachmentHref(remotePath, remotePath);
            var cached = refreshedExpiredLinkMap[expiredHref];
            return { part: { type: "link", label: truncateLabelForDisplay(remotePath), fullLabel: remotePath, href: cached || expiredHref, expired: !cached, expiredHref: expiredHref, remotePath: remotePath }, tail: tail };
        }
        if (g4 && g5) {
            var rp = normalizeAttachmentPathCandidate(g5);
            if (!rp) return null;
            var eh = buildDisplayExpiredAttachmentHref(rp, rp);
            var c2 = refreshedExpiredLinkMap[eh];
            return { part: { type: "link", label: truncateLabelForDisplay(g4), fullLabel: g4, href: c2 || eh, expired: !c2, expiredHref: eh, remotePath: rp } };
        }
        var originalHref = g3 || g6 || "";
        if (!originalHref) return null;
        if (/^https:\/\//i.test(originalHref) && originalHref.toLowerCase().indexOf(dbHostPrefix.toLowerCase()) !== 0) {
            var plainLabel = g2 || originalHref;
            return { part: { type: "link", label: truncateLabelForDisplay(plainLabel), fullLabel: plainLabel, href: originalHref, expired: false } };
        }
        var rmp = extractRemotePathFromAttachmentHref(originalHref, S.serviceId);
        var fbLabel = g2 || originalHref;
        var ehref = rmp ? buildDisplayExpiredAttachmentHref(rmp, fbLabel) : originalHref;
        var cfresh = refreshedExpiredLinkMap[ehref];
        var expired = !!rmp && !cfresh;
        var fullLabel = rmp ? getExpiredAttachmentVisiblePath(rmp, g2 || originalHref) : (g2 || originalHref);
        return { part: { type: "link", label: truncateLabelForDisplay(fullLabel), fullLabel: fullLabel, href: cfresh || ehref, expired: expired, expiredHref: ehref, remotePath: rmp || undefined } };
    }
    function parseMsgPartsHtml(content) {
        var placeholderHtml = [];
        var PH = function (idx) { return "BQ" + idx + ""; };
        var pushPlaceholder = function (anchorHtml) { var idx = placeholderHtml.length; placeholderHtml.push(anchorHtml); return PH(idx); };
        var working = String(content == null ? "" : content).replace(
            /```([^\n`]+?\.[^\s.`]+)\n([\s\S]*?)```/g,
            function (_full, filename, body) { return pushPlaceholder(fileToAnchorHtml(filename, getOrCreateFileHref(filename, body))); }
        );
        if (CS.typing) {
            var openFence = working.match(/```([^\n`]+?\.[^\s.`]+)\n?/);
            if (openFence && typeof openFence.index === "number") {
                working = working.slice(0, openFence.index) + "\n[generating " + openFence[1] + "…]";
            }
        }
        var codeMasks = [];
        working = working.replace(/`[^`\n]+`/g, function (match) { var idx = codeMasks.length; codeMasks.push(match); return "C" + idx + ""; });
        var linkRe = createInlineLinkRegex();
        working = working.replace(linkRe, function (full) {
            var args = Array.prototype.slice.call(arguments, 1, 7);
            var built = buildLinkPartFromGroups(full, args[0], args[1], args[2], args[3], args[4], args[5]);
            if (!built) return full;
            return pushPlaceholder(linkToAnchorHtml(built.part)) + (built.tail || "");
        });
        working = working.replace(/C(\d+)/g, function (_m, idx) { return codeMasks[Number(idx)] || ""; });
        var html;
        if (window.marked && typeof window.marked.parse === "function") {
            html = window.marked.parse(working, { gfm: true, breaks: true, async: false });
        } else {
            html = "<p>" + escapeHtml(working).replace(/\n/g, "<br>") + "</p>";
        }
        return html.replace(/BQ(\d+)/g, function (_m, idx) { return placeholderHtml[Number(idx)] || ""; });
    }

    /* ---- expired-link refresh (wired fully in the attachments phase) ----- */
    /* ====================================================================== *
     * ATTACHMENTS — db-storage upload + AI indexing (agent.vue model)
     *
     * Public end-user uploads go to the project's `db` host-storage exactly
     * like the admin client's Service.uploadHostFiles({target:'db'}) /
     * getTemporaryUrl({request:'get-db'}). We replicate those calls on the
     * public instance via skapi.util.request('get-signed-url', ...), which the
     * skapi request router resolves to the record_private gateway (auth:true).
     * NOTE: requires the backend `db` upload gate (get_signed_url is_master
     * check) to be relaxed for authenticated end users.
     * ====================================================================== */
    var _uploadReservedKey = null;
    function uploadReservedKey() {
        if (!_uploadReservedKey) _uploadReservedKey = randomLowerString(16);
        return _uploadReservedKey;
    }
    function randomLowerString(n) {
        var c = "abcdefghijklmnopqrstuvwxyz0123456789", s = "";
        for (var i = 0; i < n; i++) s += c.charAt(Math.floor(Math.random() * c.length));
        return s;
    }
    function formatBytes(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / (1024 * 1024)).toFixed(1) + " MB";
    }
    // Build the "Indexing: <file> · <mime> · <size>" label for background
    // indexing tasks (live bubble + history). mime/size are appended when known.
    // When the storage path is known, the name renders as a *bare* storage-path
    // markdown link `[name](path)` — the same form the agent is told to emit — so
    // parseMsgParts routes it through buildLinkPartFromGroups' bare-path branch,
    // marking it expired so a click fetches a fresh temporary URL. A full
    // https://_expired_.url/… href must NOT be used here (it would render as a
    // plain external link that never refreshes). reindex=true shows "Reindexing:".
    function buildIndexingLabel(name, mime, size, storagePath, reindex) {
        var extras = [];
        var nameLabel = storagePath ? "[" + name + "](" + storagePath + ")" : name;
        if (mime) extras.push(mime);
        if (size != null && size !== "" && !isNaN(Number(size))) extras.push(formatBytes(size));
        return (reindex ? "Reindexing: " : "Indexing: ") + nameLabel + (extras.length ? " · " + extras.join(" · ") : "");
    }
    function sanitizeStorageSegment(name) {
        // Keep the stored object key human-readable while ensuring it round-trips
        // through retrieval. Both retrieval paths encode the key per-segment:
        // the agent/preview URL comes from the backend's generate_temporary_cdn_url
        // (quote(unquote(seg), safe="")) and the download URL is signed by boto3 —
        // so spaces and Unicode become %20 / %XX and match the raw S3 key on the
        // way back. The key is also reused verbatim as the "src::<key>" record
        // unique_id, which skapi does NOT char-restrict.
        //
        // So PRESERVE Unicode letters/digits (Korean, Japanese, accented Latin, …)
        // AND spaces, and only replace genuinely unsafe chars (other punctuation/
        // symbols/control) with "_". NFC-normalize first so composed/decomposed
        // forms (macOS NFD filenames) yield a stable, matchable key. (An old
        // ASCII-only allowlist erased whole non-Latin names, e.g.
        // "외국인 고용보험.pdf" → ".pdf".) The original name is kept for display.
        var n = String(name == null ? "file" : name).normalize("NFC").trim()
            .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
            .replace(/ {2,}/g, " ")
            .replace(/_{2,}/g, "_")
            .replace(/^[_ ]+/, "");
        return n || "file";
    }
    function attachmentStoragePath(relPath) {
        // namespace by user so end users don't collide on a shared db namespace.
        // Sanitize EACH path segment so folder structure (folder/file) is kept
        // while spaces/odd chars are normalized.
        var uid = (S.user && S.user.user_id) ? S.user.user_id : "anon";
        var sanitized = String(relPath == null ? "file" : relPath).split("/")
            .map(sanitizeStorageSegment).filter(Boolean).join("/");
        return uid + "/" + (sanitized || "file");
    }

    function xhrUploadForm(url, form, onProgress, setAbort) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open("POST", url);
            xhr.onload = function () {
                var result = xhr.responseText;
                try { result = JSON.parse(result); } catch (e) {}
                if (xhr.status >= 200 && xhr.status < 300) resolve(result);
                else reject(result);
            };
            xhr.onerror = function () { reject(new Error("Network error")); };
            xhr.onabort = function () { reject(new Error("Aborted")); };
            xhr.ontimeout = function () { reject(new Error("Timeout")); };
            if (xhr.upload && typeof onProgress === "function") xhr.upload.onprogress = onProgress;
            if (typeof setAbort === "function") setAbort(function () { try { xhr.abort(); } catch (e) {} });
            xhr.send(form);
        });
    }
    // Upload one File to db host storage. Resolves on success; rejects with
    // { code:"EXISTS" } when the file already exists AND checkExistence is set
    // (the default). Pass checkExistence=false to overwrite an existing file.
    function uploadFileToDb(file, storagePath, onProgress, setAbort, checkExistence) {
        if (checkExistence === undefined) checkExistence = true;
        var params = {
            reserved_key: uploadReservedKey(),
            service: S.serviceId,
            owner: S.owner,
            request: "db",
            key: storagePath,
            size: file.size || 0,
            contentType: file.type || mimeGetType(file.name) || null,
        };
        if (checkExistence) params.check_existence = true;
        return S.skapi.util.request("get-signed-url", params, { auth: true }).then(function (signed) {
            var form = new FormData();
            var fields = signed && signed.fields ? signed.fields : {};
            for (var name in fields) form.append(name, fields[name]);
            form.append("file", file);
            return xhrUploadForm(signed.url, form, onProgress, setAbort);
        });
    }
    // Delete a file's AI-index record ("src::<storagePath>") ahead of a
    // reindex/overwrite so the agent re-creates it fresh instead of colliding/
    // duplicating. The skapi backend cascades a src:: record delete to every
    // record that references it (its reference-linked children). Best-effort: a
    // missing record (file never indexed, or an anon upload that can't carry a
    // unique_id) or a permission error must not block indexing.
    function deleteFileIndexRecordDb(storagePath) {
        if (!storagePath || !S.skapi || typeof S.skapi.deleteRecords !== "function") return Promise.resolve();
        return S.skapi.deleteRecords({ service: S.serviceId, unique_id: "src::" + storagePath })
            .catch(function () { });
    }
    // Mint a temporary CDN url for a db file (request:'get-db'), matching
    // Service.getTemporaryUrl: backend returns { url:<path> }, client prepends
    // https://db.<hostDomain>/.
    function getTemporaryUrlDb(path, expires) {
        return S.skapi.util.request("get-signed-url", {
            service: S.serviceId,
            owner: S.owner,
            request: "get-db",
            key: path,
            expires: expires || ATTACHMENT_URL_EXPIRES_SECONDS,
            contentType: mimeGetType(path) || "application/octet-stream",
            generate_temporary_cdn_url: true,
        }, { auth: true, method: "post" }).then(function (res) {
            var u = typeof res === "string" ? res : (res && res.url);
            if (!u) throw new Error("No temporary URL returned.");
            return "https://db." + hostDomain() + "/" + u;
        });
    }


    /* ---- attachment UI: chips, file input, drag-drop --------------------- */
    var ATTACH_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
    var FILE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    var FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

    /* ---- attachment budget warning (agent.vue) --------------------------- *
     * The warning is recomputed from the CURRENT attachment set on every add/
     * remove, so it appears when limits are exceeded and clears as the user
     * removes files back down to an acceptable level. Files are never rejected
     * — they are all attached and the warning is informational.
     * ---------------------------------------------------------------------- */
    var MAX_CHATBOX_FILE_COUNT = 20;
    // Hard ceiling on how many files can be attached to a single chat message.
    // Unlike MAX_CHATBOX_FILE_COUNT (an advisory warning), this is enforced in
    // appendAttachments so a 10k-file drop/select can't freeze the tab. Bulk
    // uploads belong on the Upload Files page (bounded worker pool + paging).
    var MAX_ATTACHMENT_FILE_COUNT = 20;
    // Never materialize more than this many attachment chips as DOM nodes; the
    // "...(n) more" pill absorbs the rest. Bounds renderAttachmentChips and the
    // overflow-shrink loop to O(cap) regardless of attachment count.
    var VISIBLE_CHIP_CAP = 30;
    var ESTIMATED_BYTES_PER_TOKEN = 3;
    var ESTIMATED_PDF_BYTES_PER_TOKEN = 5000;
    var ESTIMATED_IMAGE_TOKENS = 800;
    var TEXTLIKE_EXTENSION_RE = /\.(txt|md|markdown|rst|csv|tsv|json|jsonl|ndjson|ya?ml|xml|html?|css|less|scss|sass|js|mjs|cjs|ts|tsx|jsx|vue|svelte|astro|py|rb|go|rs|java|kt|swift|c|h|hpp|cpp|cc|cs|php|sh|bash|zsh|ps1|sql|log|conf|cfg|ini|toml|env|gitignore|dockerfile|makefile|lock)$/i;
    var PDF_EXTENSION_RE = /\.pdf$/i;
    var IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg)$/i;
    function estimateFileTokenCost(file) {
        var name = file.name || "", size = file.size || 0, type = (file.type || "").toLowerCase();
        if (TEXTLIKE_EXTENSION_RE.test(name) || type.indexOf("text/") === 0 || type.indexOf("json") !== -1 || type.indexOf("xml") !== -1) {
            return Math.ceil(size / ESTIMATED_BYTES_PER_TOKEN);
        }
        if (PDF_EXTENSION_RE.test(name) || type === "application/pdf") return Math.ceil(size / ESTIMATED_PDF_BYTES_PER_TOKEN);
        if (IMAGE_EXTENSION_RE.test(name) || type.indexOf("image/") === 0) return ESTIMATED_IMAGE_TOKENS;
        return 0; // unknown/opaque binary: web_fetch likely returns nothing useful
    }
    function attachmentsTokenEstimate() {
        var total = 0;
        CS.attachments.forEach(function (a) {
            if (a.kind === "folder") { (a.files || []).forEach(function (f) { total += estimateFileTokenCost(f.file); }); }
            else if (a.file) total += estimateFileTokenCost(a.file);
        });
        return total;
    }
    // Total FILE count (a folder counts as its file count), for the 20-file cap.
    function attachmentFileCount() {
        var n = 0;
        CS.attachments.forEach(function (a) { n += (a.kind === "folder") ? (a.files ? a.files.length : 0) : 1; });
        return n;
    }
    function currentInputTokenBudget() {
        var platform = S.aiPlatform;
        if (platform !== "claude" && platform !== "openai") return 0;
        var contextWindow = getContextWindow(platform, S.aiModel);
        var contextBased = Math.max(MIN_INPUT_TOKEN_BUDGET, contextWindow - OUTPUT_TOKEN_RESERVE - TOOL_AND_RESPONSE_BUFFER);
        return platform === "claude" ? Math.min(contextBased, CLAUDE_PER_REQUEST_INPUT_CAP) : contextBased;
    }
    function formatTokenCount(tokens) {
        if (tokens >= 1000) { var k = tokens / 1000; return (k >= 10 ? Math.round(k) : k.toFixed(1)) + "k"; }
        return String(tokens);
    }
    function currentChatInputText() {
        var el = CS.inputEl || (CS.messagesBox && CS.messagesBox.parentNode &&
            CS.messagesBox.parentNode.querySelector(".bq-input"));
        return el ? (el.value || "").trim() : "";
    }
    function recomputeAttachmentWarning() {
        // The per-request overload only happens when a chat message bundles all
        // the file URLs into one prompt. Attachment-only sends index the files
        // one-by-one (no aggregate per-request cost), so the limit — and the
        // warning — applies ONLY when there is chat input text.
        if (!currentChatInputText()) { CS.attachmentWarning = ""; return; }
        var count = attachmentFileCount();
        if (count > MAX_CHATBOX_FILE_COUNT) {
            CS.attachmentWarning = "You've attached " + count + " files. Up to " + MAX_CHATBOX_FILE_COUNT +
                " per message is recommended — remove " + (count - MAX_CHATBOX_FILE_COUNT) + " to send with a message.";
            return;
        }
        var budget = currentInputTokenBudget();
        var est = attachmentsTokenEstimate();
        if (budget && est > budget) {
            CS.attachmentWarning = "Attachments are ~" + formatTokenCount(est) + " tokens, which may exceed the ~" +
                formatTokenCount(budget) + "-token per-request limit. Remove some files to send with a message.";
            return;
        }
        CS.attachmentWarning = "";
    }

    // Stable content key so repeat drops of the same file/folder don't stack
    // duplicate chips. Files use name+size+lastModified; folders name+count+size.
    function attachmentKey(a) {
        if (a.kind === "folder") {
            var total = 0; (a.files || []).forEach(function (f) { total += (f.file && f.file.size) || 0; });
            return "d|" + a.name + "|" + (a.files ? a.files.length : 0) + "|" + total;
        }
        return "f|" + a.name + "|" + (a.file ? a.file.size : 0) + "|" + (a.file ? a.file.lastModified : 0);
    }
    function newAttachment(props) {
        return Object.assign({ id: "att_" + randomLowerString(10), status: "pending", progress: 0,
            uploadedUrl: "", storagePath: "", errorMessage: "" }, props);
    }
    // Append pre-built attachment objects (kind:"file" | "folder"), de-duped and
    // hard-capped at MAX_ATTACHMENT_FILE_COUNT total files (folders count as their
    // file count). Excess files are dropped (the boundary folder is truncated) so
    // a mass drop/select can never balloon the attachment set past the ceiling.
    function appendAttachments(attObjs) {
        var seen = {};
        CS.attachments.forEach(function (a) { seen[attachmentKey(a)] = true; });
        var remaining = MAX_ATTACHMENT_FILE_COUNT - attachmentFileCount();
        var dropped = 0;
        var changed = false;
        (attObjs || []).forEach(function (a) {
            if (!a) return;
            var k = attachmentKey(a);
            if (seen[k]) return;
            var count = (a.kind === "folder") ? (a.files ? a.files.length : 0) : 1;
            if (remaining <= 0) { dropped += count; return; }
            if (a.kind === "folder" && count > remaining) {
                dropped += count - remaining;
                a.files = a.files.slice(0, remaining);
                count = remaining;
            }
            seen[k] = true;
            CS.attachments.push(a);
            remaining -= count;
            changed = true;
        });
        // Over-cap adds are truncated (not rejected) and reported informationally:
        // show how many files were left out, but do NOT block the composer. The
        // user can still send with the files that were attached.
        CS.attachmentCapNotice = dropped > 0
            ? "You can attach up to " + MAX_ATTACHMENT_FILE_COUNT + " files per message. " +
              dropped + " file" + (dropped === 1 ? " was" : "s were") + " not added."
            : "";
        if (changed) { recomputeAttachmentWarning(); renderAttachmentChips(); scheduleAttachmentOverflowRecompute(); }
        else if (dropped > 0) { renderAttachmentChips(); }
        updateComposerControls();
    }
    function addFilesToAttachments(files) {
        var objs = [];
        Array.prototype.slice.call(files || []).forEach(function (f) {
            if (!f || typeof f.size !== "number") return;
            objs.push(newAttachment({ kind: "file", name: f.name, file: f }));
        });
        if (objs.length) appendAttachments(objs);
    }
    // Recursively read a drag-dropped FileSystemEntry (file or directory) into a
    // flat [{file, path}] list; paths are prefixed for nested directories.
    function readEntry(entry, prefix) {
        prefix = prefix || "";
        return new Promise(function (resolve) {
            if (!entry) { resolve([]); return; }
            if (entry.isFile) {
                entry.file(function (file) { resolve([{ file: file, path: prefix + file.name }]); }, function () { resolve([]); });
                return;
            }
            if (entry.isDirectory) {
                var reader = entry.createReader();
                var all = [];
                var readBatch = function () {
                    reader.readEntries(function (entries) {
                        if (!entries.length) { resolve(all); return; }
                        Promise.all(entries.map(function (e) { return readEntry(e, prefix + entry.name + "/"); }))
                            .then(function (groups) {
                                groups.forEach(function (g) { all.push.apply(all, g); });
                                readBatch(); // readEntries returns chunks; keep going
                            });
                    }, function () { resolve(all); });
                };
                readBatch();
                return;
            }
            resolve([]);
        });
    }
    // #8/#9: hide overflowing chips behind a "...(x) more" pill once the wrap row
    // would exceed 30% of the chat height. sortedAttachments keeps the uploading
    // file first, so it's always within the visible slice.
    var ATTACHMENTS_MAX_HEIGHT_RATIO = 0.3;
    var _attOverflowFrame = 0;
    function scheduleAttachmentOverflowRecompute() {
        if (typeof requestAnimationFrame !== "function") { recomputeAttachmentOverflow(); return; }
        if (_attOverflowFrame) cancelAnimationFrame(_attOverflowFrame);
        _attOverflowFrame = requestAnimationFrame(function () { _attOverflowFrame = 0; recomputeAttachmentOverflow(); });
    }
    function recomputeAttachmentOverflow() {
        var row = CS.attachmentsRow, chat = CS.chatEl;
        var total = CS.attachments.length;
        if (!row || !chat) return;
        if (!total) { CS.visibleAttachmentCount = Infinity; return; }
        // Start from the render cap (not `total`): renderAttachmentChips never
        // materializes more than VISIBLE_CHIP_CAP chips, so measuring/shrinking
        // from a higher count would spin uselessly. This bounds the loop to
        // O(cap) iterations instead of O(n).
        var count = Math.min(total, VISIBLE_CHIP_CAP);
        CS.visibleAttachmentCount = count; // start at the cap, then shrink to fit
        renderAttachmentChips();
        var maxHeight = chat.clientHeight * ATTACHMENTS_MAX_HEIGHT_RATIO;
        if (maxHeight <= 0) return;
        while (count > 0 && row.scrollHeight > maxHeight) {
            count--;
            CS.visibleAttachmentCount = count;
            renderAttachmentChips();
        }
    }
    // Remove a set of attachments at once (used by the "...(x) more" × and
    // remove-all), without re-rendering per item.
    function removeAttachments(ids) {
        var idset = {};
        ids.forEach(function (id) { idset[id] = true; });
        CS.attachments = CS.attachments.filter(function (a) {
            if (idset[a.id]) { if (a._abort) { try { a._abort(); } catch (e) {} } return false; }
            return true;
        });
        CS.visibleAttachmentCount = Infinity;
        CS.attachmentCapNotice = ""; // removing files clears the "N not added" notice
        recomputeAttachmentWarning();
        renderAttachmentChips();
        updateComposerControls();
        scheduleAttachmentOverflowRecompute();
    }
    function removeAttachment(id) {
        var i = CS.attachments.findIndex(function (a) { return a.id === id; });
        if (i === -1) return;
        var att = CS.attachments[i];
        if (att._abort) { try { att._abort(); } catch (e) {} }
        CS.attachments.splice(i, 1);
        CS.attachmentCapNotice = ""; // removing files clears the "N not added" notice
        recomputeAttachmentWarning();
        renderAttachmentChips();
        updateComposerControls();
        scheduleAttachmentOverflowRecompute();
    }
    function clearAttachments() {
        CS.attachments.forEach(function (a) { if (a._abort) { try { a._abort(); } catch (e) {} } });
        CS.attachments = [];
        CS.attachmentWarning = "";
        CS.attachmentCapNotice = "";
        renderAttachmentChips();
        updateComposerControls();
        scheduleAttachmentOverflowRecompute();
    }
    // Keep only failed chips (red upload-fail / yellow index-fail) after a send so
    // the user can see/retry them; clear the successfully-handled ones.
    function clearSuccessfulAttachments() {
        CS.attachments = CS.attachments.filter(function (a) {
            return a.status === "error" || a.status === "indexError";
        });
        CS.attachments.forEach(function (a) { a._abort = null; });
        CS.attachmentCapNotice = "";
        recomputeAttachmentWarning();
        renderAttachmentChips();
        updateComposerControls();
        scheduleAttachmentOverflowRecompute();
    }
    // Display order: active chips first, terminal chips last, so the "...(n) more"
    // truncation tail falls on finished items instead of hiding what's actively
    // happening. The order is: uploading → queued(pending) → failed → completed.
    // A chip with no status yet is queued to upload, so a missing status is
    // treated as "pending". Mirrors agent.vue's sortedAttachments.
    var ATTACHMENT_STATUS_PRIORITY = { uploading: 0, pending: 1, error: 2, indexError: 2, done: 3 };
    function attachmentStatusPriority(status) {
        var p = ATTACHMENT_STATUS_PRIORITY[status == null ? "pending" : status];
        return p === undefined ? 99 : p;
    }
    function sortedAttachments() {
        return CS.attachments.map(function (a, i) { return { a: a, i: i }; }).sort(function (x, y) {
            var px = attachmentStatusPriority(x.a.status);
            var py = attachmentStatusPriority(y.a.status);
            if (px !== py) return px - py;
            // Newest-first within the in-flight uploading group and the failed
            // group (so the chip that most recently started — or most recently
            // failed — sits at the front of its group). Queued + completed keep
            // insertion order.
            if (px === 0 || px === 2) return y.i - x.i;
            return x.i - y.i;
        }).map(function (e) { return e.a; });
    }
    function renderAttachmentChips() {
        var row = CS.attachmentsRow;
        if (!row) return;
        row.innerHTML = "";
        if (!CS.attachments.length && !CS.attachmentWarning && !CS.attachmentCapNotice) { row.style.display = "none"; return; }
        row.style.display = "";
        // Informational cap notice ("N files not added"): shown but non-blocking.
        if (CS.attachmentCapNotice) {
            row.appendChild(h("div", { class: "bq-attachment-warning" }, h("span", { text: CS.attachmentCapNotice })));
        }
        if (CS.attachmentWarning) {
            row.appendChild(h("div", { class: "bq-attachment-warning" }, h("span", { text: CS.attachmentWarning })));
        }
        var sorted = sortedAttachments();
        // Hard cap the number of chips ever built as DOM nodes, independent of
        // visibleAttachmentCount (which the overflow loop may leave high). Excess
        // attachments collapse into the "...(n) more" pill below.
        var vis = Math.min(CS.visibleAttachmentCount, VISIBLE_CHIP_CAP);
        var shown = (vis >= sorted.length) ? sorted : sorted.slice(0, Math.max(0, vis));
        var hidden = sorted.slice(shown.length);
        shown.forEach(function (att) {
            var isFolder = att.kind === "folder";
            var clickable = att.status === "done" && !isFolder && !!att.uploadedUrl;
            var cls = "bq-attachment";
            if (att.status === "uploading") cls += " is-uploading";
            else if (att.status === "error") cls += " is-error";            // red: upload failed
            else if (att.status === "indexError") cls += " is-index-error"; // yellow: indexing failed
            else if (att.status === "done") cls += " is-done";              // green: uploaded + indexed
            if (clickable) cls += " is-clickable";
            var chip = h("div", { class: cls });
            if (att.status === "uploading") chip.style.setProperty("--att-progress", (att.progress || 0) + "%");
            // Hover title: failure explanation, or open-hint for finished files.
            chip.title = att.status === "error" ? "File upload has failed"
                : att.status === "indexError" ? "File indexing failed"
                : clickable ? "Open " + att.name
                : isFolder ? att.name + "/ — " + (att.files ? att.files.length : 0) + " file(s)"
                : att.name;
            if (clickable) chip.addEventListener("click", function () { window.open(att.uploadedUrl, "_blank", "noopener,noreferrer"); });
            chip.appendChild(h("span", { class: "bq-attachment-icon", html: isFolder ? FOLDER_ICON_SVG : FILE_ICON_SVG }));
            chip.appendChild(h("span", { class: "bq-attachment-name", text: att.name, title: att.name }));
            var meta = att.status === "error" ? "(Failed)"
                : att.status === "indexError" ? "(Error)"
                : att.status === "uploading" ? (att.progress || 0) + "%"
                : isFolder ? "(" + (att.files ? att.files.length : 0) + ")"
                : formatBytes(att.file ? att.file.size : att.size);
            chip.appendChild(h("span", { class: "bq-attachment-meta", text: meta }));
            if (clickable) chip.appendChild(h("span", { class: "bq-attachment-arrow", text: "↗" }));
            // Remove button: hidden during the upload batch (#2) and for finished
            // (done) chips (the ↗ replaces it). Shown for pending + persisted
            // failures so the user can clear them.
            if (!CS.uploadingAttachments && att.status !== "done") {
                var rm = h("button", { class: "bq-attachment-remove", type: "button", title: "Remove", text: "×" });
                rm.addEventListener("click", function (e) { e.stopPropagation(); removeAttachment(att.id); });
                chip.appendChild(rm);
            }
            row.appendChild(chip);
        });
        // #10: when chips overflow, a "...(x) more" pill whose × drops the hidden
        // files; when nothing is hidden, a single "Remove all" button instead.
        if (hidden.length > 0) {
            var moreNames = hidden.slice(0, 50).map(function (a) { return a.kind === "folder" ? a.name + "/" : a.name; });
            if (hidden.length > moreNames.length) moreNames.push("...and " + (hidden.length - moreNames.length) + " more");
            var moreChip = h("div", { class: "bq-attachment bq-attachment-more",
                title: moreNames.join("\n") });
            moreChip.appendChild(h("span", { class: "bq-attachment-name", text: "…(" + hidden.length + ") more" }));
            if (!CS.uploadingAttachments) {
                var moreRm = h("button", { class: "bq-attachment-remove", type: "button",
                    title: "Remove these " + hidden.length, text: "×" });
                moreRm.addEventListener("click", function (e) { e.stopPropagation(); removeAttachments(hidden.map(function (a) { return a.id; })); });
                moreChip.appendChild(moreRm);
            }
            row.appendChild(moreChip);
        } else if (!CS.uploadingAttachments && CS.attachments.length >= 2) {
            var removeAll = h("button", { class: "bq-attachment-remove-all", type: "button",
                title: "Remove all attachments" }, "Remove all ×");
            removeAll.addEventListener("click", function (e) { e.stopPropagation(); clearAttachments(); });
            row.appendChild(removeAll);
        }
    }
    // Uploads are blocked for non-admin users when the service database is
    // frozen: this mirrors the backend get_signed_url gate
    // (freeze_database && not is_master). access_group 99 == admin/master, so we
    // hide the attach affordances (clip button + drag-drop) below that. The flag
    // lives under ConnectionInfo.conf (S.service = getConnectionInfo() result).
    function uploadsFrozenForUser() {
        var conf = (S.service && S.service.conf) || {};
        if (!conf.freeze_database) return false;
        var ag = (S.user && typeof S.user.access_group === "number") ? S.user.access_group : 0;
        return ag < 99;
    }
    function updateComposerControls() {
        var uploading = CS.uploadingAttachments;
        if (CS.attachBtnEl) CS.attachBtnEl.disabled = uploading;
        // #3: lock the chat input while the upload batch runs.
        if (CS.inputEl) CS.inputEl.disabled = uploading;
        // Block sending while uploading, or while an attachment warning is shown
        // (too many files / over budget together with a chat message). The
        // warning is only set when there is chat input text (recomputeAttachmentWarning).
        // The cap notice (attachmentCapNotice) is informational and does NOT block.
        if (CS.sendBtnEl) CS.sendBtnEl.disabled = uploading || !!CS.attachmentWarning;
    }
    function onAttachInputChange(inputEl) {
        if (inputEl && inputEl.files && inputEl.files.length) addFilesToAttachments(inputEl.files);
        if (inputEl) inputEl.value = ""; // allow re-selecting the same file
    }
    function setupDragAndDrop(chatEl) {
        var depth = 0, overlay = null;
        function showOverlay() {
            if (overlay || S.aiPlatform === "none") return;
            overlay = h("div", { class: "bq-drop-overlay" },
                h("div", { class: "bq-drop-overlay-inner" },
                    h("span", { html: ATTACH_ICON_SVG }),
                    h("span", { text: "Drop files to attach" })));
            chatEl.appendChild(overlay);
        }
        function hideOverlay() { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); overlay = null; }
        function hasFiles(e) {
            var dt = e.dataTransfer;
            if (!dt) return false;
            if (dt.types) { for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === "Files") return true; return false; }
            return true;
        }
        chatEl.addEventListener("dragenter", function (e) {
            if (!hasFiles(e) || S.aiPlatform === "none" || CS.chatSettingsOpen) return;
            e.preventDefault(); depth++; showOverlay();
        });
        chatEl.addEventListener("dragover", function (e) {
            if (!hasFiles(e) || S.aiPlatform === "none" || CS.chatSettingsOpen) return;
            e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        });
        chatEl.addEventListener("dragleave", function (e) {
            if (!hasFiles(e)) return;
            depth--; if (depth <= 0) { depth = 0; hideOverlay(); }
        });
        chatEl.addEventListener("drop", function (e) {
            if (!hasFiles(e) || S.aiPlatform === "none" || CS.chatSettingsOpen) return;
            e.preventDefault(); depth = 0; hideOverlay();
            handleDrop(e.dataTransfer);
        });
    }
    // Build file/folder attachments from a drop. Uses webkitGetAsEntry so dropped
    // directories become folder attachments (recursively read via readEntry).
    function handleDrop(dt) {
        if (!dt) return;
        var items = dt.items;
        if (items && items.length) {
            var entries = [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (it.kind !== "file") continue;
                var entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
                entries.push(entry || it.getAsFile());
            }
            Promise.all(entries.map(function (entry) {
                if (!entry) return Promise.resolve(null);
                if (entry instanceof File) return Promise.resolve(newAttachment({ kind: "file", name: entry.name, file: entry }));
                if (entry.isFile) {
                    return readEntry(entry).then(function (files) {
                        return files[0] ? newAttachment({ kind: "file", name: files[0].file.name, file: files[0].file }) : null;
                    });
                }
                if (entry.isDirectory) {
                    return readEntry(entry).then(function (files) {
                        return newAttachment({ kind: "folder", name: entry.name, files: files });
                    });
                }
                return Promise.resolve(null);
            })).then(function (objs) {
                appendAttachments(objs.filter(Boolean));
            });
        } else if (dt.files && dt.files.length) {
            addFilesToAttachments(dt.files);
        }
    }

    function getPublicTemporaryUrl(remotePath) {
        if (!remotePath) return Promise.reject(new Error("Missing attachment path."));
        return getTemporaryUrlDb(remotePath, ATTACHMENT_URL_EXPIRES_SECONDS);
    }
    function fetchFreshHrefForExpiredLink(expiredHref, remotePath) {
        var cached = refreshedExpiredLinkMap[expiredHref];
        if (cached) return Promise.resolve(cached);
        var inFlight = refreshingLinkPromises.get(expiredHref);
        if (inFlight) return inFlight;
        var run = (function () {
            refreshingLinkMap[expiredHref] = true;
            var resolved = remotePath || extractRemotePathFromAttachmentHref(expiredHref, S.serviceId);
            if (!resolved) return Promise.reject(new Error("Unable to refresh this expired attachment link."));
            return getPublicTemporaryUrl(resolved).then(function (fresh) {
                refreshedExpiredLinkMap[expiredHref] = fresh;
                return fresh;
            });
        })().then(function (v) { refreshingLinkPromises.delete(expiredHref); delete refreshingLinkMap[expiredHref]; return v; },
            function (e) { refreshingLinkPromises.delete(expiredHref); delete refreshingLinkMap[expiredHref]; throw e; });
        refreshingLinkPromises.set(expiredHref, run);
        return run;
    }
    function onBubbleLinkClick(e) {
        var target = e.target;
        if (!target) return;
        var anchor = target.closest ? target.closest("a[data-bq-link]") : null;
        if (!anchor) return;
        if (anchor.dataset.bqExpired !== "1") return;
        e.preventDefault();
        var originalHref = anchor.dataset.bqExpiredHref || anchor.href;
        // A previous click is already re-resolving this link (the chip shows
        // "(fetching...)"). Swallow further clicks so a rapid repeat doesn't each
        // await the shared in-flight fetch and then fire anchor.click() — which
        // would open the file in several tabs at once when it resolves.
        if (refreshingLinkMap[originalHref]) return;
        var cached = refreshedExpiredLinkMap[originalHref];
        if (cached) { anchor.href = cached; anchor.dataset.bqExpired = "0"; anchor.click(); return; }
        fetchFreshHrefForExpiredLink(originalHref, anchor.dataset.bqRemotePath).then(function (fresh) {
            anchor.href = fresh; anchor.dataset.bqExpired = "0"; anchor.click();
        }).catch(function (err) {
            console.error("[bunnyquery] expired link refresh failed", err);
            alert((err && err.message) || "Failed to refresh this expired link.");
        });
    }

    /* ---- history + clear-horizon (agent.vue) ----------------------------- */
    function getClearHistoryStorageKey() {
        if (!S.serviceId || S.aiPlatform === "none") return "";
        return SK.clearHorizon + ":" + S.serviceId + "#" + S.aiPlatform;
    }
    function getClearedAt() {
        var key = getClearHistoryStorageKey();
        if (!key) return 0;
        var raw = lsGet(key);
        var value = raw ? Number(raw) : 0;
        return isFinite(value) && value > 0 ? value : 0;
    }
    function setClearedAt(ts) {
        var key = getClearHistoryStorageKey();
        if (key) lsSet(key, String(ts));
    }
    // History fetch + bg-drain + poll-attach now live in session.loadHistory().
    // The DOM scroll-restore for the older-prepend stays here (the engine is
    // DOM-free): capture the pre-prepend scroll position, then re-anchor the
    // viewport after the session prepends older messages + re-renders.
    function fetchOlderHistoryIfNeeded() {
        if (CS.loadingHistory || CS.loadingOlderHistory || CS.historyEndOfList) return;
        var prevH = CS.messagesBox ? CS.messagesBox.scrollHeight : 0;
        var prevT = CS.messagesBox ? CS.messagesBox.scrollTop : 0;
        session.loadHistory(true).then(function () {
            if (!CS.messagesBox) return;
            raf2().then(function () {
                if (!CS.messagesBox) return;
                CS.messagesBox.scrollTop = prevT + (CS.messagesBox.scrollHeight - prevH);
            });
        });
    }

    // Periodic re-map is intentionally disabled: local sends resolve via their
    // own auto-poll, and history-loaded running/pending items resolve via the
    // item.poll attached in fetchHistoryPage. A periodic fetchHistoryPage would
    // re-map the server's "running" copy of a locally-queued message while also
    // rescuing the local bubble (which has no _serverItemId under auto-poll),
    // producing a duplicate (white running + leftover yellow queued).
    function schedulePendingPoll() { /* no-op */ }

    /* ---- clear-history modal --------------------------------------------- */
    function openClearHistoryModal() {
        if (!chatEnabled() || CS.sending || CS.typing) return;
        if (!CS.messages.length) return;
        var modal = openModal(function (close) {
            var clearBtn = h("button", { class: "btn btn--danger", type: "button" }, "Clear");
            clearBtn.addEventListener("click", function () {
                if (CS.clearing) return;
                CS.clearing = true;
                setClearedAt(Date.now());
                var key = session.getHistoryCacheKey();
                if (key) delete aiChatHistoryCache[key];
                CS.messages = []; CS.historyStartKeyHistory = []; CS.historyEndOfList = true;
                renderMessages();
                CS.clearing = false;
                close();
            });
            return h("div", { class: "bq-modal" },
                h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
                h("div", { class: "bq-modal-delete-header" },
                    h("span", { text: "Clear chat history" })),
                h("p", { class: "bq-modal-desc" }, "This hides the current conversation from view. Your messages stay on the server but won't be shown here again."),
                h("div", { class: "bq-modal-btns" },
                    h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Cancel"),
                    clearBtn)
            );
        });
        return modal;
    }

    /* ---- DOM rendering --------------------------------------------------- */
    function chatEnabled() { return S.aiPlatform !== "none"; }

    function autoGrowInput(el) {
        if (!el) return;
        el.style.height = "auto";
        // scrollHeight covers content+padding but NOT the border under
        // box-sizing:border-box, so add the border or the last line overflows
        // by the border width and a scrollbar appears.
        var cs = window.getComputedStyle(el);
        var border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
        var max = 192; // 12rem at the widget's 16px root
        var h = el.scrollHeight + border;
        if (h > max) {
            el.style.height = max + "px";
            el.style.overflowY = "auto";
        } else {
            el.style.height = h + "px";
            el.style.overflowY = "hidden";
        }
    }

    function buildMessageEl(msg, idx) {
        var cls = ["bq-message"];
        cls.push(msg.role === "user" ? "is-user" : "is-assistant");
        if (msg.isError) cls.push("is-error");
        if (msg.isCancelled) cls.push("is-cancelled");
        if (msg.isPendingQueued || msg.isPendingOlder) cls.push("is-pending-older");
        if (msg.isSendingToServer || msg._cancelling) cls.push("is-sending-to-server");

        var bubble;
        if (msg.isPending) {
            bubble = h("div", { class: "bq-bubble" }, h("span", { class: "bq-loader" }));
        } else {
            bubble = h("div", { class: "bq-bubble" });
            if (msg.role === "user" && msg.isPendingQueued) {
                var disabled = !msg._serverItemId || msg.isSendingToServer || msg._cancelling;
                var cancelBtn = h("button", {
                    class: "bq-cancel-queue-btn" + (disabled ? " is-disabled" : ""),
                    type: "button", title: "Cancel queued message", html: "&times;",
                });
                if (!disabled) cancelBtn.addEventListener("click", function (e) { e.stopPropagation(); session.cancelQueuedMessage(msg, idx); });
                bubble.appendChild(cancelBtn);
            }
            var md = h("div", { class: "bq-md", html: parseMsgPartsHtml(msg.content) });
            md.addEventListener("click", onBubbleLinkClick);
            bubble.appendChild(md);
            if (msg.isPendingQueued) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(In queue)" }));
            if (msg.isCancelled) bubble.appendChild(h("span", { class: "bq-cancel-error", text: "(cancelled)" }));
            if (msg._cancelError) bubble.appendChild(h("span", { class: "bq-cancel-error", text: msg._cancelError }));
        }
        return h("div", { class: cls.join(" "), dataset: { msgIndex: String(idx) } }, bubble);
    }

    function historyLoadingEl(initial) {
        // Initial (empty messages area) load gets the jumping bunny, matching
        // www.bunnyquery.com's .bq-gate-loading. Older-history pagination keeps the
        // compact inline "Fetching history..." dot-trail so it stays a thin sticky bar.
        if (initial) {
            return h("div", { class: "bq-history-loading is-initial" },
                bunnyLoader("Fetching history..."));
        }
        return h("div", { class: "bq-history-loading" },
            h("span", { text: "Fetching history" }), h("span", { class: "bq-loader" }));
    }
    function renderMessages() {
        if (!CS.messagesBox) return;
        if (CS.chatSettingsOpen) return; // the settings panel occupies the messages area
        clear(CS.messagesBox);
        CS.messageEls = [];
        // "Fetching history..." pinned at the top while paginating older history (scroll-up).
        if (CS.loadingOlderHistory) CS.messagesBox.appendChild(historyLoadingEl(false));
        if (!CS.messages.length) {
            // Initial load: show "Fetching history..." instead of the greeting.
            if (CS.loadingHistory && !CS.loadingOlderHistory) {
                CS.messagesBox.appendChild(historyLoadingEl(true));
                return;
            }
            var greet = h("div", { class: "bq-message is-assistant bq-empty-greeting" },
                h("div", { class: "bq-bubble" },
                    document.createTextNode("Hi! Ask me anything about " + (S.serviceName ? '"' + S.serviceName + '"' : "your project") +
                        ".")));
            CS.messagesBox.appendChild(greet);
            return;
        }
        CS.messages.forEach(function (msg, idx) {
            var el = buildMessageEl(msg, idx);
            CS.messageEls.push(el);
            CS.messagesBox.appendChild(el);
        });
    }

    function refreshMessageBubble(idx) {
        if (idx < 0 || idx >= CS.messages.length) return;
        var oldEl = CS.messageEls[idx];
        if (!oldEl || !oldEl.parentNode) return;
        var newEl = buildMessageEl(CS.messages[idx], idx);
        oldEl.parentNode.replaceChild(newEl, oldEl);
        CS.messageEls[idx] = newEl;
    }

    function renderChat() {
        // reset transient chat state on (re)entry
        CS.messages = []; CS.messageEls = []; CS.sending = false; CS.typing = false; CS.typingAbort = true;
        CS.historyEndOfList = false; CS.historyStartKeyHistory = []; CS.stickToBottom = true;
        CS.attachments = []; CS.uploadingAttachments = false; CS.attachmentWarning = ""; CS.attachmentCapNotice = "";
        CS.attachmentsRow = null; CS.attachBtnEl = null; CS.sendBtnEl = null; CS.inputEl = null;
        CS.chatEl = null; CS.visibleAttachmentCount = Infinity;
        CS.chatSettingsOpen = false; CS.settingsBtnEl = null; CS.composerEl = null;
        CS.gateRefreshToken += 1;
        // Do NOT clear historyItemPolls here. Its entries track LIVE polls
        // (immediate dispatch / queued send / bg task / history poll), and every
        // poll deletes its own entry when it settles or errors — so a surviving
        // entry always means a still-running poll that outlives this remount
        // (skapi item.poll() loops are uncancellable). Wiping it made loadHistory
        // re-attach a SECOND poll on top of the live one (double-poll → duplicate
        // reply / stranded "Thinking"); keeping it lets loadHistory's has() dedup
        // skip exactly the items already covered. A full page reload resets the
        // Map anyway, so nothing leaks across sessions.
        if (CS.pollTimer) { clearInterval(CS.pollTimer); CS.pollTimer = null; }

        render("chat", function () {
            var settingsBtn = h("button", { class: "bq-icon-btn", type: "button", title: "Settings",
                html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
                onclick: function () { toggleChatSettings(); } });
            CS.settingsBtnEl = settingsBtn;

            var header = h("div", { class: "bq-section-title" },
                h("div", { class: "bq-title-row" },
                    h("div", { class: "bq-title-left" }, h("span", { class: "bq-agent-badge", text: agentBadgeText() })),
                    h("div", { class: "bq-title-right" }, settingsBtn)));

            var chatArea;
            if (S.aiPlatform === "none") {
                chatArea = h("div", { class: "bq-chat" },
                    h("div", { class: "bq-disabled-overlay" },
                        h("div", { class: "bq-disabled-inner" },
                            h("div", { text: "This chat isn't available yet — the project admin hasn't set up an AI agent." }))));
                return h("div", { class: "bq-meta" }, header, chatArea);
            }

            var box = h("div", { class: "bq-messages" });
            box.addEventListener("scroll", onHistoryScroll, { passive: true });
            box.addEventListener("wheel", onMessagesWheel, { passive: true });
            box.addEventListener("touchstart", onMessagesTouchStart, { passive: true });
            box.addEventListener("touchmove", onMessagesTouchMove, { passive: true });
            CS.messagesBox = box;

            var input = h("textarea", { class: "bq-input", rows: "1", placeholder: "Ask anything about: " + (S.serviceName || "your project") });
            CS.inputEl = input;
            var composing = false;
            input.addEventListener("compositionstart", function () { composing = true; });
            input.addEventListener("compositionend", function () { composing = false; });
            input.addEventListener("input", function () {
                autoGrowInput(input);
                // The attachment warning + send-disable depend on whether there is
                // chat text. Re-evaluate when it crosses the empty/non-empty line.
                var prev = CS.attachmentWarning;
                recomputeAttachmentWarning();
                if (CS.attachmentWarning !== prev) { renderAttachmentChips(); updateComposerControls(); scheduleAttachmentOverflowRecompute(); }
            });
            input.addEventListener("keydown", function (e) {
                if (e.key === "Enter" && !e.shiftKey && !composing) { e.preventDefault(); sendMessage(); }
            });
            // size the empty input correctly once it's in the DOM (avoids a
            // first-keystroke height jump / bottom clip from the CSS min-height)
            requestAnimationFrame(function () { autoGrowInput(input); });

            // When the DB is frozen for a non-admin user, omit the attach clip
            // button + file input entirely (null children are skipped by h()).
            // Drag-drop is likewise gated below so there's no upload path at all.
            var attachDisabled = uploadsFrozenForUser();
            // No clip button means no absolutely-positioned control in the left
            // gutter, so drop the reserved left padding on the textarea.
            if (attachDisabled) input.classList.add("bq-input--noattach");
            var attachFileInput = null, attachBtn = null;
            if (!attachDisabled) {
                attachFileInput = h("input", { class: "bq-attach-input", type: "file", multiple: "multiple" });
                attachFileInput.addEventListener("change", function () { onAttachInputChange(attachFileInput); });
                attachBtn = h("button", { class: "bq-attach-btn", type: "button", title: "Attach files", html: ATTACH_ICON_SVG });
                attachBtn.addEventListener("click", function () { attachFileInput.click(); });
                CS.attachBtnEl = attachBtn;
            }

            var attachmentsRow = h("div", { class: "bq-attachments" });
            attachmentsRow.style.display = "none";
            CS.attachmentsRow = attachmentsRow;

            var sendBtn = h("button", { class: "btn", type: "submit" }, "Send");
            CS.sendBtnEl = sendBtn;
            var composer = h("form", { class: "bq-input-row", onsubmit: function (e) { e.preventDefault(); sendMessage(); } },
                attachmentsRow,
                h("div", { class: "bq-input-wrap" }, attachBtn, attachFileInput, input), sendBtn);

            chatArea = h("div", { class: "bq-chat" }, box, composer);
            CS.chatEl = chatArea; CS.composerEl = composer;
            if (!attachDisabled) setupDragAndDrop(chatArea);
            return h("div", { class: "bq-meta" }, header, chatArea);
        });

        if (S.aiPlatform === "none") return;
        // load markdown renderer, then show history
        loadMarked().then(function () {
            renderMessages();
            return session.loadHistory(false, CS.gateRefreshToken);
        }).then(function () { schedulePendingPoll(); });
    }

    // generic modal helper (appended to <body>, themed)
    function openModal(builder, opts) {
        var dismissible = !(opts && opts.dismissible === false);
        var root = h("div", { class: "bq-modal-root", "data-bq-theme": S.theme });
        var backdrop = h("div", { class: "bq-modal-backdrop" });
        var close = function () { if (root.parentNode) root.parentNode.removeChild(root); };
        // Non-dismissible modals (e.g. the overwrite/reindex prompt) have no
        // backdrop-click close and no × button — the user must pick an action.
        if (dismissible) backdrop.addEventListener("click", close);
        root.appendChild(backdrop);
        root.appendChild(builder(close));
        document.body.appendChild(root);
        return { root: root, close: close };
    }

    /* ---- overwrite / reindex prompt (agent.vue useOverwritePrompt) -------- *
     * When an upload hits an existing file, promptOverwrite(filename) surfaces a
     * NON-DISMISSIBLE modal (no backdrop/×): "Skip" leaves the existing file
     * untouched (no upload/index); "Reindex only" keeps the existing file and
     * just re-indexes it; "Overwrite" replaces it. "Apply to all remaining"
     * makes the chosen outcome sticky for the rest of the current upload batch;
     * resetOverwriteBatch() clears it at the start of each batch. Uploads run
     * sequentially, so only one prompt is ever open at a time. */
    var overwriteState = { resolver: null, sticky: null, handle: null, applyToAll: false };
    function resetOverwriteBatch() { overwriteState.sticky = null; overwriteState.applyToAll = false; }
    function chooseOverwrite(choice) {
        if (overwriteState.applyToAll) overwriteState.sticky = choice;
        if (overwriteState.handle) { overwriteState.handle.close(); overwriteState.handle = null; }
        var r = overwriteState.resolver; overwriteState.resolver = null;
        if (r) r(choice);
    }
    function promptOverwrite(filename) {
        // A prior file in this batch chose "apply to all" — honor it silently.
        if (overwriteState.sticky) return Promise.resolve(overwriteState.sticky);
        overwriteState.applyToAll = false;
        return new Promise(function (resolve) {
            overwriteState.resolver = resolve;
            overwriteState.handle = openModal(function () {
                var applyCb = h("input", { type: "checkbox" });
                applyCb.addEventListener("change", function () { overwriteState.applyToAll = !!applyCb.checked; });
                var applyLabel = h("label", { class: "bq-overwrite-applyall" }, applyCb,
                    h("span", { text: "Apply to all remaining files" }));
                return h("div", { class: "bq-modal" },
                    h("div", { class: "bq-modal-delete-header" }, h("span", { text: "File already exists" })),
                    h("p", { class: "bq-modal-desc" },
                        "A file named “" + filename + "” already exists. Skip it, keep the existing file and just reindex it, or overwrite it completely?"),
                    applyLabel,
                    h("div", { class: "bq-modal-btns" },
                        h("button", { class: "btn btn--outline", type: "button", onclick: function () { chooseOverwrite("skip"); } }, "Skip"),
                        h("button", { class: "btn btn--outline", type: "button", onclick: function () { chooseOverwrite("reindex"); } }, "Reindex only"),
                        h("button", { class: "btn btn--danger", type: "button", onclick: function () { chooseOverwrite("overwrite"); } }, "Overwrite"))
                );
            }, { dismissible: false });
        });
    }

    /* ---- upload error report ------------------------------------------------ *
     * After a send's uploads + indexing-queue requests all settle, any files that
     * failed are reported here in ONE dismissible dialog. The failures arrive
     * pre-grouped by (error code, description) from groupAttachmentFailures(); we
     * list each distinct error once with the files it affected. The failed chips
     * stay in the attachment row so the user can remove or retry them. */
    function showUploadErrorReport(groups) {
        if (!groups || !groups.length) return;
        var totalFiles = groups.reduce(function (n, g) { return n + g.files.length; }, 0);
        openModal(function (close) {
            var sections = groups.map(function (g) {
                var heading = g.code ? g.code + " — " + g.message : g.message;
                return h("div", { class: "bq-upload-error-group" },
                    h("p", { class: "bq-upload-error-heading", text: heading }),
                    h("ul", { class: "bq-upload-error-files" },
                        g.files.map(function (name) { return h("li", { text: name }); })));
            });
            return h("div", { class: "bq-modal" },
                h("div", { class: "bq-modal-delete-header" },
                    h("span", { text: totalFiles === 1 ? "1 file could not be added" : totalFiles + " files could not be added" })),
                h("p", { class: "bq-modal-desc", text: "These files were not added to your message. They stay in the attachment row so you can remove or retry them." }),
                h("div", { class: "bq-upload-error-list" }, sections),
                h("div", { class: "bq-modal-btns" },
                    h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Close")));
        });
    }

    function agentBadgeText() {
        if (S.aiPlatform === "none") return "No agent configured";
        return S.serviceName || "BunnyQuery";
    }

    /* ========================================================================
     * 10. AGENT CONFIG (read-only, admin-provided)
     * ======================================================================*/

    function parseAiAgentValue(value) {
        var raw = (value || "").trim();
        var platform = raw, model = "";
        if (raw.indexOf("#") !== -1) {
            var parts = raw.split("#");
            platform = parts[0];
            model = parts[1] || "";
        }
        var normalized = (platform === "claude" || platform === "openai") ? platform : "none";
        return { raw: raw, platform: normalized, model: model, hasPlatform: normalized !== "none" };
    }

    function applyAgentConfig() {
        // getConnectionInfo() resolves to a flat object:
        // { user_ip, user_agent, user_location, service_name, version,
        //   service_description, ai_agent: "<platform>#<model>" }
        var conn = S.service || {};
        var raw = conn.ai_agent || "";
        var parsed = parseAiAgentValue(raw);
        S.aiPlatform = parsed.platform;
        S.aiModel = parsed.model;
        S.serviceName = conn.service_name || "";
        S.serviceDescription = conn.service_description || "";
    }

    /* ========================================================================
     * 11. LOGOUT + POST-LOGIN ENTRY
     * ======================================================================*/

    function logout() {
        showLoading("");
        clearStoredMcpToken();
        Promise.resolve()
            .then(function () { return S.skapi.logout(); })
            .catch(function () {})
            .then(function () {
                S.user = null;
                renderLogin();
            });
    }

    // Called once the user is authenticated and (optionally) the MCP grant is
    // settled: load agent config and show the chat.
    function enterAfterLogin() {
        showLoading("");
        // S.user may be unset here: the MCP-OAuth callback path reaches this
        // function without going through the boot getProfile() that populates
        // it, leaving every (S.user && S.user.user_id) check to fall back to
        // "anon". Ensure the profile is loaded before rendering the chat.
        return Promise.resolve()
            .then(function () { return S.user ? S.user : getProfile().then(function (u) { S.user = u; return u; }); })
            .then(function () { return loadServiceInfo(); })
            .then(function (conn) { S.service = conn; applyAgentConfig(); })
            .then(function () { renderChat(); })
            .catch(function (err) {
                console.error("[bunnyquery] enterAfterLogin failed", err);
                renderChat();
            });
    }

    /* ========================================================================
     * 12. BOOT
     * ======================================================================*/

    function boot() {
        showLoading("");
        // Load connection info up-front (needs no auth) so the service-name badge
        // is populated before the login/signup/verify pages render. enterAfterLogin
        // re-loads it post-auth, so a miss here (offline, etc.) is non-fatal.
        return loadServiceInfo()
            .then(function (conn) { if (conn) { S.service = conn; applyAgentConfig(); } })
            .catch(function () {})
            .then(bootFlow);
    }

    function bootFlow() {
        // 0. INBOUND IdP: the MCP authorize step (or another platform) sent the
        // user here to authenticate against skapi. Bounce back with a session
        // code if logged in; otherwise show login (the submit handler bounces
        // after a successful login). This is what breaks the MCP-authorize loop.
        if (isInboundPlatformOAuth()) {
            stashInboundPlatformOAuth();
            return getProfile().then(function (user) {
                S.user = user;
                if (user) { returnOAuthToMCP(); return; } // browser leaves
                renderLogin();
            });
        }

        // 1. Returning from Google's authorize endpoint?
        if (isGoogleOAuthReturn()) {
            return completeGoogleOAuthReturn()
                .then(function () {
                    // If a platform initiated this (inbound), bounce back with a
                    // code instead of starting our own MCP grant.
                    var st = getQueryParam("state");
                    if (st && ssGet("oauth:" + st)) { returnOAuthToMCP(); return; }
                    cleanUrl();
                    return beginMcpOAuthOnLogin("chat"); // also establish MCP grant
                })
                .catch(function (err) {
                    console.error("[bunnyquery] Google OAuth return failed", err);
                    cleanUrl();
                    renderLogin();
                });
        }

        // 2. Returning from the MCP /oauth/authorize redirect?
        if (isMcpOAuthCallback()) {
            return completeMcpAuthorize()
                .then(function () { cleanUrl(); return enterAfterLogin(); })
                .catch(function (err) {
                    console.error("[bunnyquery] MCP OAuth token exchange failed", err);
                    cleanUrl();
                    return enterAfterLogin(); // chat still works off skapi JWT
                });
        }

        // 3. Normal boot — check for an existing (auto-login) session.
        // Strip any leftover OAuth callback params: reaching here means none of
        // the recognized return-flows above matched (saved state already
        // consumed, a reload mid-exchange, or a replayed/foreign code), so the
        // params are stale — don't let them linger in the address bar.
        if (getQueryParam("code") || getQueryParam("oauth")) cleanUrl();
        return getProfile().then(function (user) {
            S.user = user;
            if (!user) {
                renderLogin();
                return;
            }
            if (mcpGrantNeedsRefresh(user)) {
                // Prefer a SILENT refresh (no redirect): reconnects a returning
                // user whose local grant aged out but whose server session +
                // refresh_token are still valid (~30d). Only fall back to the
                // full OAuth redirect when the silent path can't refresh.
                return refreshMcpToken().then(function (tok) {
                    if (tok && !mcpGrantNeedsRefresh(user)) return enterAfterLogin();
                    return beginMcpOAuthOnLogin("chat").catch(function (err) {
                        console.error("[bunnyquery] MCP refresh failed", err);
                        return enterAfterLogin();
                    });
                });
            }
            return enterAfterLogin();
        });
    }

    /* ========================================================================
     * 13. PUBLIC API
     * ======================================================================*/

    function init(skapi, target, opts) {
        if (S.booted) {
            console.warn("[bunnyquery] already initialised");
            return PUBLIC;
        }
        if (!skapi) throw new Error("BunnyQuery.init: a Skapi instance is required");

        var mountEl = typeof target === "string" ? document.getElementById(target) : target;
        if (!mountEl) throw new Error("BunnyQuery.init: mount element not found: " + target);

        S.skapi = skapi;
        S.opts = Object.assign({
            theme: "light",
            signup: false,        // include signup (and thus delete/recover account)
            dev: false,          // use the MCP dev host (mcp-dev.broadwayinc.computer)
            mcpBaseUrl: null,    // override the MCP OAuth server base entirely
            googleClientId: null,
            googleClientSecretName: "ggl",
            signupConfirmationUrl: null, // defaults to current host page
            hostDomain: null,            // db-CDN host; null → skapi.app (dev) / skapi.com (prod)
            attachmentParsers: null,     // client-side attachment parsers, e.g. [createHwpParser()]
        }, opts || {});
        S.mountEl = mountEl;

        // Build our owned root inside the host element.
        clear(mountEl);
        S.root = h("div", { class: "bq-agent" });
        mountEl.appendChild(S.root);

        applyTheme(loadTheme());
        S.booted = true;
        console.log("[bunnyquery] v" + BQ_VERSION);

        // Inject this widget's transport + MCP endpoint into the shared chat
        // engine. poll: 0 — the deployed skapi-js@latest returns the early ack
        // (with id + a manual .poll()) only when poll===0, which queued-send
        // cancel relies on (the agent.vue build omits poll; see chat-engine).
        configureChatEngine({
            clientSecretRequest: function (o) { return S.skapi.clientSecretRequest(o); },
            clientSecretRequestHistory: function (p, f) { return S.skapi.clientSecretRequestHistory(p, f); },
            mcpBaseUrl: mcpBaseUrl(),
            poll: 0,
            // Client-side attachment parsers (e.g. an .hwp parser) passed via init opts.
            attachmentParsers: S.opts.attachmentParsers || undefined,
        });

        // Recompute the attachment "...(x) more" overflow when the viewport
        // changes (no-op when the chat/attachments aren't mounted).
        if (!S._resizeBound && typeof window !== "undefined" && window.addEventListener) {
            S._resizeBound = true;
            window.addEventListener("resize", function () { scheduleAttachmentOverflowRecompute(); });
        }

        // Keep the MCP grant warm: returning to a backgrounded tab after the
        // grant aged out would otherwise disconnect the next message. Silently
        // refresh it (no redirect) when the tab becomes visible again.
        if (!S._visBound && typeof document !== "undefined" && document.addEventListener) {
            S._visBound = true;
            document.addEventListener("visibilitychange", function () {
                if (document.visibilityState === "hidden") {
                    // Nobody is looking: stop background indexing polls. The server keeps
                    // working (the worker drives the document loop itself), so this only
                    // drops traffic, never progress.
                    if (session && session.pausePolling) session.pausePolling("hidden");
                    return;
                }
                if (document.visibilityState === "visible") {
                    // Refresh the MCP grant BEFORE resuming, or the first poll after a long
                    // hidden stretch 401s on an aged-out grant.
                    var refreshed = S.user ? ensureMcpGrantFresh() : null;
                    Promise.resolve(refreshed).catch(function () { }).then(function () {
                        if (session && session.resumePolling) session.resumePolling("hidden");
                    });
                }
            });
        }

        boot();
        return PUBLIC;
    }

    var PUBLIC = {
        init: init,
        // Register a client-side attachment parser (e.g. createHwpParser()) so the
        // widget parses matching uploads in-browser and sends the text for indexing.
        // Can be called before or after init(); also settable via init opts.attachmentParsers.
        registerAttachmentParser: registerAttachmentParser,
        setTheme: function (t) { applyTheme(t); },
        toggleTheme: toggleTheme,
        logout: logout,
        version: BQ_VERSION,
        _state: S, // exposed for later-phase modules / debugging
    };

    if (typeof window !== "undefined") {
        window.BunnyQuery = PUBLIC;
    }
})();
