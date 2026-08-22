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
    indexDoneUniqueId,
    runIndexUniqueId,
    composeUserMessage,
    groupAttachmentFailures,
    notifyAgentSaveAttachment,
    buildChatSystemPrompt,
    buildChatGreeting,
    setProjectContextWindow,
    parseAiAgentValue as engineParseAiAgentValue,
    // pure helpers (Tier-1.5) — error detection, token budget, link/path, history mapping
    getErrorMessage,
    isErrorResponseBody,
    isAuthExpiredError,
    getContextWindow,
    buildBoundedChatMessages,
    // The view-side attachment-warning calc (currentInputTokenBudget) calls this
    // rather than re-deriving the budget from the constants, which is how the
    // two drifted apart before.
    getInputTokenBudget,
    createInlineLinkRegex,
    extractRemotePathFromAttachmentHref,
    normalizeAttachmentPathCandidate,
    buildDisplayExpiredAttachmentHref,
    getExpiredAttachmentVisiblePath,
    truncateLabelForDisplay,
    // A file whose url could not be minted: shared keys so this chip reads the
    // same here and in agent.vue.
    isLinkUnavailable,
    linkUnavailableKeyForPath,
    linkUnavailableKeyForHref,
    isHttpUrlLike,
    repairUrlWhitespace,
    classifyInlineLink,
    normalizeTrailingInlineToken,
    formatChatTimestamp,
    // Inline image previews: the chip/preview markup is shared with agent.vue so
    // the two clients cannot drift, and the url mint is cached outside the parse.
    renderInlineLinkHtml,
    IMAGE_PREVIEWS_PER_MESSAGE,
    hydrateImagePreviews,
    clearImagePreviewCache,
    // Per-format UTF-8 declaration for downloadable files, single-sourced in
    // engine/download_encoding.ts and mirrored in skapi-mcp.
    prepareDownloadText,
    extOf,
    EXT_CONTENT_TYPES,
    EXPIRED_LINK_REFRESH_EXPIRES_SECONDS,
    PREVIEW_URL_EXPIRES_SECONDS,
    PREVIEW_BROWSER_CACHE_SECONDS,
    LINK_REFRESH_WINDOW_MS,
    // Which url a cacheable mint uses (cache generation, plus a window stamp on
    // a repair), and every key a file's chips can be marked unavailable under.
    previewMintCacheToken,
    linkUnavailableKeysForPath,
    extractLastUserTextFromRequest,
    mapHistoryListToMessages,
    buildChatDisplayList,
    createHistoryFiller,
    HISTORY_FILL_SLACK_PX,
    // Holding the reader's place while the list mutates underneath them. Shared
    // with agent.vue so the two cannot drift on the one behaviour a reader
    // notices most.
    createScrollAnchor,
    // The element a preview's own transitions actually resize (the anchor, not the
    // <img>). Shared so both this and the engine's layout hook measure one node.
    previewLayoutBox,
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
    var DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
    var DEFAULT_OPENAI_MODEL = "gpt-5.4";

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
        projectId: null,
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
        return base + ":" + (S.projectId || "default");
    }

    /* ========================================================================
     * 4. THEME
     * ======================================================================*/

    function loadTheme() {
        // Fixed key (NOT per-service): theme is a global UI preference, and at
        // init() projectId isn't known yet — a per-service key would save/load
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
        S.projectId = (S.skapi && (S.skapi.service || (S.skapi.connection && S.skapi.connection.service))) || S.projectId;
        S.owner = (S.skapi && (S.skapi.owner || (S.skapi.connection && S.skapi.connection.owner))) || S.owner;
        return Promise.resolve()
            .then(function () {
                if (typeof S.skapi.getConnectionInfo === "function") return S.skapi.getConnectionInfo();
                return S.skapi.connection || null;
            })
            .then(function (conn) {
                if (S.opts && S.opts.dev) console.log("[bunnyquery] loadServiceInfo", conn);
                if (conn) {
                    S.projectId = conn.service || S.projectId;
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
    // [bunny] BunnyQuery · <project> — the brand row shared by the chat header
    // and the standalone (logged-out) pages, so every view opens with the same
    // top-left identity. The project name is the only shrinkable piece
    // (.bq-brand-project ellipsizes); it is simply absent until known.
    function brandTitleEl() {
        return h("div", { class: "bq-title-left bq-brand" },
            h("img", { class: "bq-brand-icon", src: BQ_LOGO_URI, alt: "", "aria-hidden": "true" }),
            h("span", { class: "bq-brand-name", text: "BunnyQuery" }),
            S.serviceName ? h("span", { class: "bq-brand-sep", text: "·" }) : null,
            S.serviceName ? h("span", { class: "bq-brand-project", title: S.serviceName, text: S.serviceName }) : null);
    }
    function pageRoot(content) {
        // Same top-left header the chat/settings views use (.bq-section-title >
        // .bq-title-row), so the brand sits flush at the widget's top-left
        // instead of being indented into the centered content column. The
        // scrollable .bq-page below holds the centered form + footer.
        return h("div", { class: "bq-meta" },
            h("div", { class: "bq-section-title" },
                h("div", { class: "bq-title-row" }, brandTitleEl())),
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

    // Bunny mark for the chat header, inlined so the embedded widget never
    // depends on the host page (or our site) serving an image file.
    var BQ_LOGO_URI = "data:image/png;base64,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";
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
        // The box is measurable again. Any fill that wanted to run while the
        // panel was up was skipped, and the chat underneath may be a single
        // collapsed indexing row with no way to scroll to older history.
        ensureHistoryFillsViewport();
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
     * → S.projectId/S.owner/S.serviceName/S.serviceDescription.
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
        // Rendered .bq-message nodes, indexed BY MESSAGE INDEX (sparse: a message
        // folded into a collapsed indexing row has no node of its own).
        messageEls: [],
        // Expanded background-indexing rows, keyed by FILE (group.key). Not by run:
        // runKey is renamed whenever an earlier pass of the run loads, which closed
        // a row the user had opened. Two runs of one file therefore share an open
        // state, which is the right reading of "show me this file's steps".
        indexGroupsOpen: {},
        messagesBox: null,       // .bq-messages element
        sending: false,
        typing: false,
        typingAbort: false,
        typewriterQueue: Promise.resolve(),
        stickToBottom: true,
        loadingHistory: false,
        loadingOlderHistory: false,
        // The viewport-fill LOOP is running (createHistoryFiller.onRunningChange).
        // Spans the gaps between its pages, where loadingOlderHistory keeps dropping
        // back to false; a collapsed indexing row that is still waiting for its own
        // earlier passes renders off this rather than flickering once per page.
        // View-side, not delegated to session.state: the filler is view-side too.
        historyFilling: false,
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
    // Files we asked for a url for and did not get one: a failed mint (click or
    // image preview) or a preview whose minted url would not load. Keyed by the
    // engine's linkUnavailableKeyFor* so a failure reported with a storage path
    // and one reported with a placeholder href both find their chip.
    var unavailableLinkMap = {};
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
    // Live identity read. Also snapshotted at Send time (PinnedDispatchContext) so
    // a turn whose files are still uploading dispatches against the project/model
    // it was asked of, not whatever is selected when the upload finishes.
    function currentIdentity() {
        return {
            projectId: S.projectId,
            // Prefer the SDK's formatted token. The widget takes the page's own
            // skapi-js <script> pin, and builds older than 1.8.4 have no .project_id;
            // compose the formatted token exactly as buildSystemPrompt does, because
            // the raw regional id must never reach the indexing prompt - the model
            // copies it verbatim into project_id tool calls, which the MCP schema
            // pattern rejects.
            publicProjectId: (S.skapi && S.skapi.project_id) || (function () {
                if (S.projectId && S.owner && S.skapi && S.skapi.util && typeof S.skapi.util.formatServiceId === "function") {
                    try { return S.skapi.util.formatServiceId(S.projectId, S.owner); }
                    catch (e) { /* no public compound form; leave undefined */ }
                }
                return undefined;
            })(),
            owner: S.owner,
            userId: (S.user && S.user.user_id) || S.projectId,
            platform: S.aiPlatform, model: S.aiModel || undefined,
            serviceName: S.serviceName, serviceDescription: S.serviceDescription,
        };
    }
    var session = new ChatSession({
        getIdentity: function () { return currentIdentity(); },
        buildSystemPrompt: function () { return buildSystemPrompt(); },
        notify: function () { renderMessages(); },
        refreshMessageBubble: function (i) { refreshMessageBubble(i); },
        scrollToBottom: function (smooth) { return scrollToBottom(smooth); },
        scrollToBottomIfSticky: function (smooth) { return scrollToBottomIfSticky(smooth); },
        // A first page can render shorter than the box (a file's every indexing
        // pass folds into ONE row), and a box that cannot scroll never fires the
        // scroll-to-top that is the sole trigger for loading page 2. Page out of
        // it here — only the view can measure.
        onHistoryLoaded: function (fetchMore, token) {
            if (!fetchMore) ensureHistoryFillsViewport(token);
        },
        settleScroll: function () { settleScrollAfterRefresh(); },
        cancelRequest: function (opts) { return S.skapi.cancelClientSecretRequest(opts); },
        refreshSession: function () { return refreshSkapiSession(); },
        formatIndexingLabel: function (name, mime, size, storagePath, reindex, continued) {
            return buildIndexingLabel(name, mime, size, storagePath, reindex, continued);
        },
        isViewMounted: function () { return !!CS.messagesBox; },
        getClearedAt: function () { return getClearedAt(); },
        // attachment upload I/O (bunnyquery: get-signed-url + db CDN)
        uploadFile: function (a) { return uploadFileToDb(a.file, a.storagePath, a.onProgress, a.setAbort, a.checkExistence); },
        getTemporaryUrl: function (path) { return getTemporaryUrlDb(path, ATTACHMENT_URL_EXPIRES_SECONDS); },
        deleteExistingFileRecord: function (path) { return deleteFileIndexRecordDb(path); },
        ensureFileIndexRecord: function (path, meta) { return ensureFileIndexRecordDb(path, meta); },
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
        // The chat system prompt now lives in the shared engine (same as the
        // agent.vue chatbox so the two can't drift). The prompt must carry the
        // FORMATTED project id (the public two-segment token the MCP tools accept
        // and tell the model to copy verbatim) - S.projectId is the RAW regional
        // code the SDK decoded at construction, which the tools reject.
        var promptProjectId = S.projectId || "";
        if (S.projectId && S.owner && S.skapi && S.skapi.util && typeof S.skapi.util.formatServiceId === "function") {
            try { promptProjectId = S.skapi.util.formatServiceId(S.projectId, S.owner); }
            catch (e) { /* keep the raw id rather than an empty prompt */ }
        }
        return buildChatSystemPrompt({
            projectId: promptProjectId,
            serviceName: S.serviceName,
            serviceDescription: S.serviceDescription,
            // The opening bubble never enters the history (it is DOM the client
            // paints), so the model is told what it opened with. Same call as
            // buildGreetingEl, so the two can never disagree.
            greeting: greetingParts().text,
            canUpload: !uploadsFrozenForUser(),
            client: "widget",
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

    // A send with attachments is two serialized stages, chained SEPARATELY.
    //
    // Uploads run one at a time because a batch owns shared, single-instance
    // machinery: the "this file exists" prompt is one modal, and the per-batch
    // overwrite choice ("apply to all") is reset at the start of each run. Keeping
    // them in send order also puts each turn's indexing requests on the server
    // queue in that order.
    //
    // The dispatch stage is chained on its own so a turn waiting for indexing to
    // finish does not hold up the NEXT send's uploads — that wait can run for
    // minutes, and the point of all this is that the user is never blocked. Both
    // chains are appended at Send time, so the turns still reach the server in the
    // order they were typed.
    var attachmentUploadChain = Promise.resolve();
    var attachmentDispatchChain = Promise.resolve();
    var attachmentBatchSeq = 0;
    function enqueueAttachmentSend(job) {
        var uploaded = attachmentUploadChain
            .catch(function () { /* a failed batch must not stall the ones behind it */ })
            .then(function () { return runAttachmentUpload(job); });
        attachmentUploadChain = uploaded;
        attachmentDispatchChain = attachmentDispatchChain
            .catch(function () { /* likewise */ })
            .then(function () { return uploaded; })
            .then(function (urls) { return runAttachmentDispatch(job, urls); });
    }

    // Stage 1: upload this send's own batch of chips and enqueue their indexing.
    // Resolves to the attachment urls, or null when the upload failed outright (the
    // failure has been reported and nothing will be dispatched). Everything here
    // happens AFTER the user has moved on, so it touches only what it captured at
    // Send time.
    function runAttachmentUpload(job) {
        // stageId: each file's indexing row is inserted directly ABOVE this turn's
        // staged bubble, so the collapsed row sits right before the message its files
        // came with from the moment it appears (see BgTaskEntry.stageId).
        return session.uploadPendingAttachments(job.batchId, job.stageId).then(function (attachmentUrls) {
            // Collect any failures (upload or indexing) now, grouped by error
            // code + description, so we can report them once below.
            var failureGroups = groupAttachmentFailures(CS.attachments.filter(function (a) {
                return a._batchId === job.batchId;
            }));
            // Per-file "Indexing:" bubbles were already injected during upload (#1).
            // Keep only this batch's FAILED chips (red/yellow) so the user can
            // see/retry them; clear the successful ones.
            clearSuccessfulAttachments(job.batchId);
            if (failureGroups.length) showUploadErrorReport(failureGroups);
            return attachmentUrls;
        }).catch(function (err) {
            console.error("[bunnyquery] attachment upload failed", err);
            updateComposerControls(); renderAttachmentChips();
            // Nothing will be dispatched, so settle the staged bubble rather than
            // leaving it uploading forever — the user's text stays on screen above
            // the failure instead of disappearing with it.
            if (job.stageId) session.settleStagedMessage(job.stageId);
            CS.messages.push({ role: "assistant", content: "Something went wrong while uploading attachments. " + ((err && err.message) || ""), isError: true });
            // Sticky, not forcing. An upload can fail minutes after the user hit
            // Send, long after they scrolled away, and yanking them to the bottom
            // for it is the same unrequested move as the delayed dispatch. The
            // failure is already reported in the bubble above and in the error
            // report, so nothing is lost by leaving them where they are.
            renderMessages(); scrollToBottomIfSticky();
            return null;
        });
    }

    // Stage 2: send the chat turn those files belong to LAST — after every indexing
    // pass on the queue has finished, not merely after the uploads.
    function runAttachmentDispatch(job, attachmentUrls) {
        // Upload failed (already reported), or an attachment-only turn: the files
        // are indexing and there is no chat message to send.
        if (!attachmentUrls || !job.text) return Promise.resolve();
        // The files are up; what the turn is waiting on now is their INDEXING.
        if (job.stageId) session.markStagedMessageIndexing(job.stageId);
        // Indexing a file is a CHAIN — each pass is only enqueued once the previous
        // one lands — so a turn sent when the uploads finish is answered from a
        // half-read file, with the remaining passes queued up behind it. Wait for
        // the background queue to actually drain. (Times out rather than stranding
        // the message if a chain wedges server-side.)
        return session.awaitIndexingDrained(job.pinned.identity).then(function () {
            // The files are indexed: the turn is genuinely just queued now, so it
            // reads solid and "(In queue)" from this instant — not once the request
            // lands, which is another round trip after a wait measured in minutes.
            // Fires on 'timedout' and 'skipped' too: the turn is being sent either way.
            if (job.stageId) session.markStagedMessageReady(job.stageId);
            // Compose the user message (attachment-link block + office-extraction
            // placeholders) via the shared engine helper — identical to agent.vue —
            // then dispatch through the shared ChatSession (which owns the queued-
            // vs-immediate decision, the cache+resume immediate-send model, the
            // office extractContent, and the "-bg" queue routing). The pinned
            // context carries the stage id so the bubble staged at Send time is
            // replaced in place instead of a second one appearing at the bottom. A
            // turn with attachments always goes on the "-bg" queue: that is the
            // queue its files were indexed on, so it is the only one where being
            // enqueued last means running last.
            // inlineExtractedContent: false — these files were just indexed
            // (we awaited the drain above), so their content is already in the
            // database. Inlining it would make the worker download and re-parse
            // every attachment a SECOND time, which looks like the file being
            // indexed all over again, and would re-send the whole text as prompt
            // tokens. The agent reads the records instead (see the system
            // prompt), or readFileContent for exact raw text.
            var c = composeUserMessage(job.text, attachmentUrls, { inlineExtractedContent: false });
            session.dispatchComposedMessage(c.composed, true, c.composedForLlm, c.extractContent, c.fileUrls, job.pinned);
        });
    }

    function sendMessage() {
        var inputEl = CS.messagesBox && CS.messagesBox.parentNode &&
            CS.messagesBox.parentNode.querySelector(".bq-input");
        var text = (inputEl ? inputEl.value : "").trim();
        // The chips THIS send takes. Chips already handed to an earlier send stay
        // out of it (see composerAttachments).
        var batchAttachments = composerAttachments();
        var hasAttachments = batchAttachments.length > 0;
        if (!text && !hasAttachments) return;
        if (!chatEnabled() || S.aiPlatform === "none") return;

        // Over the attachment limit *with* a chat message: block the send. The
        // send button is disabled in this state, but the Enter key would bypass
        // it. The warning clears when the user removes files or clears the text.
        recomputeAttachmentWarning();
        if (CS.attachmentWarning) { renderAttachmentChips(); updateComposerControls(); return; }

        // Hand the composer back to the user before a single byte moves. The
        // input is empty again, so Send drops back to disabled.
        if (inputEl) { inputEl.value = ""; autoGrowInput(inputEl); }
        updateComposerControls();
        // Programmatic clears fire no input event; drop the "typing" bubble here.
        CS.drafting = false;
        syncDraftingIndicator();

        if (!hasAttachments) { session.dispatchComposedMessage(text, false); return; }

        // The turn takes its chips with it (stamped with a batch id) and, when it
        // has text, leaves a staged bubble behind so it holds the position it was
        // sent in. Its files upload to db storage in the background, kicking off
        // indexing; the chat turn then goes out on the bg queue so it runs AFTER
        // those files are indexed — all of it behind whatever the user does next.
        attachmentBatchSeq += 1;
        var batchId = "batch_" + attachmentBatchSeq + "_" + Date.now();
        batchAttachments.forEach(function (a) { a._batchId = batchId; });
        // The chips just left the composer, so its affordances (Remove all, the
        // warning) have to be recomputed now — the batch itself may not start for
        // a while if an earlier one is still uploading.
        recomputeAttachmentWarning(); renderAttachmentChips(); updateComposerControls();
        var stageId = text ? session.stageOutgoingMessage(text) : undefined;
        var pinned = {
            identity: currentIdentity(),
            systemPrompt: buildSystemPrompt(),
            stageId: stageId,
        };
        enqueueAttachmentSend({ text: text, batchId: batchId, stageId: stageId, pinned: pinned });
    }

    function scrollToBottom() {
        // No smooth branch any more, in either scroller. A glide fires a scroll event
        // per frame at positions that are NOT the bottom, and onHistoryScroll clears
        // stickToBottom on each of them - so anything merging inside the ~130ms
        // animation strands the reader off the bottom permanently, aiming at a target
        // that was already stale when the glide began.
        //
        // A hidden tab does not run rAF, so raf2 would land one to two frames after
        // it comes back. Write now instead.
        if (typeof document !== "undefined" && document.hidden) {
            CS.stickToBottom = true;
            chatScrollAnchor.pinBottom();
            return Promise.resolve();
        }
        return raf2().then(function () {
            if (!CS.messagesBox) return;
            CS.stickToBottom = true;
            chatScrollAnchor.pinBottom();
        });
    }
    // Only scrolls if the user is already at the bottom. Used by automated
    // resolutions (the streaming typewriter, bg-task polls, history polling) so
    // they don't yank the user away when they've scrolled up to read old
    // messages. Unlike scrollToBottom, this does NOT force-pin CS.stickToBottom:
    // it re-checks after the DOM settles and bails if the user scrolled up
    // mid-tick, so a streamed response can't repeatedly drag them back down.
    function scrollToBottomIfSticky() {
        if (!CS.stickToBottom) return Promise.resolve();
        // See scrollToBottom: never smooth, and never rAF-deferred while hidden.
        if (typeof document !== "undefined" && document.hidden) { chatScrollAnchor.pinBottom(); return Promise.resolve(); }
        return raf2().then(function () {
            if (!CS.stickToBottom || !CS.messagesBox) return;
            chatScrollAnchor.pinBottom();
        });
    }
    // The ONE place that decides where the reader sits after a list refresh. Mirror
    // of agent.vue's settleScrollAfterRefresh - see the settleScroll host hook.
    // Called at BOTH moments a first-page refresh changes heights: the surface page
    // landing, and the deferred indexing batch merging a round trip later. It decides
    // from the box AS IT IS at that moment and nothing else - a reader following the
    // bottom gets the bottom that exists now (which after the batch is the real one),
    // and any other reader gets the line they are on. There is deliberately no
    // "returning" state: an instruction recorded earlier and carried out at one of
    // these settles is exactly how the chat threw people around.
    function settleScrollAfterRefresh() {
        anchorWroteSinceScroll = true;
        if (CS.stickToBottom) scrollToBottomIfSticky();
        else chatScrollAnchor.hold();
    }
    // Where the box was at the previous scroll event. Only used to tell a scroll
    // DOWN from the browser clamping scrollTop after content above the reader
    // shrank.
    var lastHistoryScrollTop = 0;
    // The next scroll event was caused by our own compensation, not by the reader.
    var anchorWroteSinceScroll = false;
    function onHistoryScroll() {
        if (!CS.messagesBox || CS.chatSettingsOpen) return;
        var el = CS.messagesBox;
        // A scroll event dispatched while the tab is hidden is not the reader: it is
        // a shrink-then-grow patch firing one event against the grown scrollHeight,
        // which reads as "not at the bottom" and silently un-sticks someone who left
        // pinned. (agent.vue does the same.)
        if (typeof document !== "undefined" && document.hidden) { lastHistoryScrollTop = el.scrollTop; return; }
        // Re-sticking requires having moved DOWN. Content shrinking above the
        // reader - a group collapsing, a re-render, an image failing back to
        // nothing - makes the browser CLAMP scrollTop to the new maximum, which is
        // "at the bottom" by definition and fires a scroll event indistinguishable
        // from the reader arriving there. Read as sticky, that pinned someone who
        // was mid-history to the newest message and re-pinned them on every poll
        // after. A clamp can only ever LOWER scrollTop, so this separates the two
        // exactly. (agent.vue does the same.)
        var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
        var ours = anchorWroteSinceScroll;
        anchorWroteSinceScroll = false;
        if (!atBottom) CS.stickToBottom = false;
        // `ours`: the box's own compensation write can land exactly AT the bottom (content
        // above grew while content below shrank in the same update), and the scroll event
        // that follows is indistinguishable from the reader flicking down there. Read as
        // the reader, it silently converts them into a bottom-pinned one, and from then on
        // every keyboard open and every merge drags them to the newest message.
        // Flagged rather than value-matched: a clamp reports the POST-clamp position, never
        // the value that was written, and scroll events coalesce, so the number cannot say
        // who caused it. The host knows, because the host made the call.
        else if (!ours && el.scrollTop >= lastHistoryScrollTop) CS.stickToBottom = true;
        lastHistoryScrollTop = el.scrollTop;
        // This is where the reader's place comes from. Every scroll - theirs, and
        // every programmatic one - lands here, so the anchor is always the
        // position the box is actually at, and chatScrollAnchor.hold() can put it
        // back after anything that resolves in the background. Cheap: one pass
        // over the rows, and it stops at the first one on screen.
        chatScrollAnchor.remember();
        // Not a single page: keep going until the scroll-up revealed something,
        // or a page of pure indexing passes (which collapses into a row already
        // on screen) leaves the user pinned at the top with nothing new.
        if (el.scrollTop <= 60) pageOlderHistoryUntilTaller();
    }
    // An <img> (or anything else that loads) inside the list just settled and
    // changed its own box. Hold the reader's place; scrollToBottomIfSticky covers
    // the reader who is pinned to the bottom instead, and the two are exclusive.
    function onMessagesFontsSettled() { chatScrollAnchor.hold(); }
    function onMessagesImageSettled(e) {
        var t = e && e.target;
        if (!t || t.tagName !== "IMG") return;
        // absorb, not hold: an image inside the anchored row (a reply taller than
        // the viewport, a picture higher up in it) moves every line the reader is
        // on WITHOUT moving the row's own top, which is the one thing hold()
        // measures. absorb compensates by the element's own delta instead, and
        // only while the element's top is above the fold, so the two can never
        // both pay for the same pixel.
        //
        // previewLayoutBox, so this and the engine's own onLayoutChange hook key
        // absorb's per-element memo on the SAME node: the box that resizes is the
        // anchor (picture + dot-trail loader + caption chip), not the <img> alone.
        anchorWroteSinceScroll = true;
        chatScrollAnchor.absorb(previewLayoutBox(t));
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
    function getOrCreateFileHref(filename, body) {
        var key = filename + "\u0000" + body;
        var existing = fileBlobCache.get(key);
        if (existing) return existing;
        // The engine decides how this format declares UTF-8: a BOM for a spreadsheet
        // or a text file, <meta charset> for HTML, \u escapes for RTF, nothing at all
        // for the formats that are UTF-8 by spec and that a BOM would break. Without
        // it a Korean CSV opens as CP949 mojibake in Excel, and so does every other
        // non-Latin script. Mirrored server-side in skapi-mcp/download-encoding.js.
        var prepared = prepareDownloadText(filename, body);
        // mimeGetType covers the long tail the engine map does not name (images).
        var type = EXT_CONTENT_TYPES[extOf(filename)]
            || mimeGetType(filename)
            || "text/plain; charset=utf-8";
        var href = URL.createObjectURL(new Blob([prepared.text], { type: type }));
        fileBlobCache.set(key, href);
        return href;
    }
    function fileToAnchorHtml(filename, href) {
        var text = "↗ " + filename;
        return '<a class="bq-file-download" href="' + escapeHtml(href) + '" download="' + escapeHtml(filename) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(text) + "</a>";
    }
    // The markup is the ENGINE's (renderInlineLinkHtml): this used to be a byte
    // for byte copy of agent.vue's emitter, and the image preview would have had
    // to be written into both. This view supplies only what is local to it.
    function linkToAnchorHtml(link, allowImagePreview) {
        return renderInlineLinkHtml(link, {
            refreshing: !!refreshingLinkMap[link.expiredHref || link.href],
            allowImagePreview: allowImagePreview,
            unavailable: isLinkUnavailable(link, unavailableLinkMap),
        });
    }
    // Classification is the ENGINE's (classifyInlineLink): what a link IS must
    // not be decided twice, once here and once in agent.vue. This view supplies
    // only what is local to it and renders whatever comes back.
    function buildLinkPartFromGroups(full, g1, g2, g3, g4, g5, g6) {
        return classifyInlineLink(full, [g1, g2, g3, g4, g5, g6], {
            projectId: S.projectId,
            dbHostPrefix: "https://db." + hostDomain(),
            resolveFreshHref: function (expiredHref) { return refreshedExpiredLinkMap[expiredHref]; },
        });
    }
    // opts.imagePreviews: false — used by the collapsed indexing-row HEADER,
    // whose file chip must stay a plain inline chip: an is-image-preview block
    // there breaks the header's horizontal alignment (mirror of agent.vue).
    function parseMsgPartsHtml(content, opts) {
        var noPreviews = !!(opts && opts.imagePreviews === false);
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
        // Each preview costs a presign call and an image download once hydrated,
        // and a reply listing a folder can name dozens. Past the budget a link
        // renders as the ordinary text chip. Local to this call, so the output
        // stays a pure function of `content`.
        var previewsLeft = noPreviews ? 0 : IMAGE_PREVIEWS_PER_MESSAGE;
        var linkRe = createInlineLinkRegex();
        working = working.replace(linkRe, function (full) {
            var args = Array.prototype.slice.call(arguments, 1, 7);
            var built = buildLinkPartFromGroups(full, args[0], args[1], args[2], args[3], args[4], args[5]);
            if (!built) return full;
            var allow = previewsLeft > 0;
            var html = linkToAnchorHtml(built.part, allow);
            if (allow && built.part.image) previewsLeft--;
            return pushPlaceholder(html) + (built.tail || "");
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
    function buildIndexingLabel(name, mime, size, storagePath, reindex, continued) {
        var nameLabel = storagePath ? "[" + name + "](" + storagePath + ")" : name;
        // A CONTINUE pass of a big file gets a compact, visibly different label so a
        // long multi-window run reads as progress, not the same task repeating.
        if (continued) return "Indexing (continuing) " + nameLabel;
        var extras = [];
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
            service: S.projectId,
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
        // Also drop the backend's "indexing finished" marker (done::<path>): it
        // references the src:: record so the cascade normally sweeps it, but a
        // record from before the cascade flag has no cascade, and a re-index must
        // never start with a stale "finished" verdict standing. Same for the
        // run:: record — a rerun must never inherit the old run's verdict.
        var doneDelete = S.skapi.deleteRecords({ service: S.projectId, unique_id: indexDoneUniqueId(storagePath) })
            .catch(function () { });
        var runDelete = S.skapi.deleteRecords({ service: S.projectId, unique_id: runIndexUniqueId(storagePath) })
            .catch(function () { });
        return S.skapi.deleteRecords({ service: S.projectId, unique_id: "src::" + storagePath })
            .catch(function () { })
            .then(function () { return doneDelete; })
            .then(function () { return runDelete; });
    }
    // Mint the durable "indexing finished" marker (done::<path>) for a run whose
    // completion THIS client knows deterministically — the engine's
    // mintIndexDoneMarker hook decides when. Mirrors www's mintIndexDoneMarker;
    // the widget never wired the hook before, so its single-pass completions
    // relied on queue inference alone. Best-effort: "is already taken" is a
    // redelivered settle, i.e. completion, not a failure.
    function mintIndexDoneMarkerDb(service, storagePath) {
        if (!service || !storagePath || !S.skapi || typeof S.skapi.postRecord !== "function") return Promise.resolve();
        return Promise.resolve(S.skapi.postRecord(null, {
            service: service,
            unique_id: indexDoneUniqueId(storagePath),
            table: { name: "__INDEXING__", access_group: "authorized" },
            reference: "src::" + storagePath,
            data: { source: storagePath, completed_at: Date.now() }
        })).catch(function (err) {
            var msg = String((err && err.message) || err || "");
            if (msg.indexOf("is already taken") === -1) {
                console.warn("[bunnyquery] mintIndexDoneMarker failed (non-fatal)", storagePath, msg);
            }
        });
    }
    // Create-or-update the per-file indexing RUN record ("run::<path>") — the
    // widget half of www's upsertIndexRunRecord; see that implementation for the
    // full contract. No native upsert exists: create, and on "is already taken"
    // fetch the record and re-post with its record_id, merging the patch over
    // the stored data. A 'working' write never overwrites a terminal status.
    function upsertIndexRunRecordDb(service, storagePath, patch) {
        if (!service || !storagePath || !patch || !patch.status) return Promise.resolve();
        if (!S.skapi || typeof S.skapi.postRecord !== "function") return Promise.resolve();
        var uid = runIndexUniqueId(storagePath);
        var TERMINAL = { done: true, error: true, cancelled: true };
        function patchData(base) {
            var d = {};
            for (var k in (base || {})) d[k] = base[k];
            d.source = storagePath;
            d.status = patch.status;
            if (patch.filename) d.filename = patch.filename;
            if (typeof patch.started === "number") d.started = patch.started;
            if (typeof patch.finished === "number") d.finished = patch.finished;
            if (patch.error) d.error = patch.error;
            if (patch.queue) d.queue = patch.queue;
            // Chat that owns the run (project + platform); see agent.vue twin.
            if (patch.platform) d.platform = patch.platform;
            return d;
        }
        function createWith(reference) {
            var cfg = {
                service: service,
                unique_id: uid,
                table: { name: "__INDEXING__", access_group: "authorized" },
                data: patchData(null)
            };
            if (reference) cfg.reference = "src::" + storagePath;
            return S.skapi.postRecord(null, cfg);
        }
        // Absent and unfetchable both read as "no record".
        function lookup() {
            return Promise.resolve(S.skapi.getRecords({ service: service, unique_id: uid }))
                .then(function (found) { return (found && found.list && found.list[0]) || null; })
                .catch(function () { return null; });
        }
        function updateExisting(rec) {
            var existing = rec.data || {};
            if (patch.status === "working" && TERMINAL[String(existing.status)]) {
                // A NEW run may reopen a terminal record (orphaned verdict
                // from the path's previous life); only a LATE create from
                // the run the record already describes must lose — its
                // `started` predates the settle that closed it.
                var endedAt = typeof existing.finished === "number" ? existing.finished
                    : typeof existing.started === "number" ? existing.started : 0;
                if (!(typeof patch.started === "number" && patch.started > endedAt)) return Promise.resolve(null);
            }
            // Same terminal verdict already stored: re-writing it on every
            // stale-sweep re-observation was pure write noise.
            if (patch.status !== "working" && String(existing.status) === patch.status) return Promise.resolve(null);
            return Promise.resolve(S.skapi.postRecord(null, {
                service: service,
                record_id: rec.record_id,
                data: patchData(existing)
            }));
        }
        function settleAsUpdate() {
            return lookup().then(function (rec) {
                if (rec && rec.record_id) return updateExisting(rec);
                return null;
            }).catch(function (err) {
                console.warn("[bunnyquery] upsertIndexRunRecord update failed (non-fatal)", storagePath, String((err && err.message) || err || ""));
            });
        }
        function createChain() {
            return Promise.resolve(createWith(true)).catch(function (err) {
                var msg = String((err && err.message) || err || "");
                if (msg.indexOf("is already taken") === -1) {
                    // Not the exists-signal — almost always the src:: record not
                    // existing yet. Mint it and retry WITH the reference (a
                    // reference-less record cannot be cascade-swept on reindex);
                    // only if that still fails does a reference-less create beat
                    // having no record at all.
                    return ensureFileIndexRecordDb(storagePath).then(function () {
                        return createWith(true);
                    }).catch(function (errRef) {
                        var msgRef = String((errRef && errRef.message) || errRef || "");
                        if (msgRef.indexOf("is already taken") !== -1) return settleAsUpdate();
                        return Promise.resolve(createWith(false)).catch(function (err2) {
                            var msg2 = String((err2 && err2.message) || err2 || "");
                            if (msg2.indexOf("is already taken") === -1) {
                                console.warn("[bunnyquery] upsertIndexRunRecord create failed (non-fatal)", storagePath, msg2);
                                return null;
                            }
                            return settleAsUpdate();
                        });
                    });
                }
                return settleAsUpdate();
            });
        }
        // Terminal flips usually target an EXISTING record: look it up first, so
        // the common path never fires the guaranteed-400 create. 'working' mints
        // usually target a MISSING one (cascade swept it): create straight away
        // (agent.vue same).
        if (patch.status !== "working") {
            return lookup().then(function (rec) {
                if (rec && rec.record_id) return updateExisting(rec);
                return createChain();
            });
        }
        return createChain();
    }
    // Create the file's "src::<storagePath>" record BEFORE any indexing pass runs, so every
    // pass has a reference target that is guaranteed to exist (mirrors ai_agent.ts). Without
    // it the backend rejected every referencing record - including the pipeline's own
    // "__MEDIA__" media-index writes, which land while window 1 is still being BUILT, before
    // the model's first turn could create anything. Best-effort: losing the guarantee must
    // not lose the upload.
    function ensureFileIndexRecordDb(storagePath, meta) {
        if (!storagePath || !S.skapi || typeof S.skapi.postRecord !== "function") return Promise.resolve();
        return Promise.resolve(S.skapi.postRecord(null, {
            service: S.projectId,
            unique_id: "src::" + storagePath,
            table: { name: "file_summaries", access_group: "authorized" },
            // Deleting the file record must cascade to every record referencing it.
            source: { can_remove_referencing_records: true },
            data: {
                file_name: (meta && meta.name) || storagePath.split("/").pop() || storagePath,
                storage_path: storagePath,
                mime_type: (meta && meta.mime) || null,
                size_bytes: (meta && typeof meta.size === "number") ? meta.size : null,
                indexed_at: Date.now(),
                note: "File-level record created at upload. The indexing agent enriches this with sheet names, column headers and row counts."
            }
        })).catch(function () { });
    }
    // Mint a temporary CDN url for a db file (request:'get-db'), matching
    // Service.getTemporaryUrl: backend returns { url:<path> }, client prepends
    // https://db.<hostDomain>/.
    // `cdn` picks the branch DELIBERATELY. A generate_temporary_cdn_url url
    // ignores `expires` entirely and lives until the end of the next UTC day
    // (24-48h); a plain get-db presign honours `expires` to the second. Passing
    // the flag while also passing a short `expires` is the trap: it reads as a
    // 10 minute url and behaves as a two day one.
    // `contentType` overrides the extension guess. It is what decides whether a
    // new tab DISPLAYS the file or downloads it: get_signed_url only sets
    // ResponseContentType when we pass one, and application/octet-stream always
    // downloads. The image preview passes the type the engine classified.
    // `opts.browserCache` (seconds) mints through a CACHEABLE GET instead of a
    // POST, so the same url comes back out of the browser cache and the body it
    // already downloaded stays addressable. `opts.refresh` bypasses that cache.
    // Neither applies to the cdn branch, whose url is stable by construction.
    function getTemporaryUrlDb(path, expires, cdn, contentType, opts) {
        opts = opts || {};
        var body = {
            service: S.projectId,
            owner: S.owner,
            request: "get-db",
            key: path,
            expires: expires || ATTACHMENT_URL_EXPIRES_SECONDS,
            contentType: contentType || mimeGetType(path) || "application/octet-stream",
        };
        if (cdn !== false) body.generate_temporary_cdn_url = true;

        var reqOpts = { auth: true, method: "post" };
        if (cdn === false && opts.browserCache) {
            reqOpts.method = "get";
            // PIN THE HOST. This dest routes through the record gateway's round
            // robin, which alternates between record_private and record_private_2
            // — two urls for one mint, so the browser stores two entries holding
            // two different signed urls and downloads the same image twice. The
            // dashboard never had this because it passes a full endpoint url.
            reqOpts.stableGateway = true;
            // Cache generation, plus a window stamp when this mint is a repair.
            // NOT `revalidate`: that sends Cache-Control: no-cache as a REQUEST
            // header, which is not CORS-safelisted and which the record gateway's
            // preflight does not allow, so the browser refused to send the repair
            // at all and the preview died as unavailable. A query parameter is
            // part of the url, so nothing can veto it.
            body.nocache = previewMintCacheToken(opts.refresh);
            body.browser_cache = opts.browserCache;
            // Partitions the browser cache per user: a cache is keyed by url
            // alone and shared by everyone using the profile, so without this a
            // second user signing in here would be handed the first user's
            // signed urls. The backend rejects a uid that is not the caller.
            var uid = S.user && S.user.user_id;
            if (uid) body.uid = uid;
        }

        function unwrap(res) {
            var u = typeof res === "string" ? res : (res && res.url);
            if (!u) throw new Error("No temporary URL returned.");
            // ONLY the cdn branch returns a bare path to prepend the db host to.
            // A presign is already absolute, and prefixing it produced
            // "https://db.<host>/https://<bucket>.s3..." — a url that resolves to
            // the db CDN, fails signature validation and 401s. That is why every
            // cdn:false mint (image previews, expired-chip clicks) was dead.
            if (/^https?:\/\//i.test(u)) return u;
            return "https://db." + hostDomain() + "/" + u;
        }

        // The backend already resolves this. get_signed_url/index.py:1154 runs
        // resolve_existing_key() on every "get" request, which head_objects the NFC and
        // NFD variants and signs whichever exists (added 2026-07-08, "fix multilang texts").
        // A client-side retry here would also be INERT: when no variant exists the backend
        // falls back "as-given" and signs it anyway, so the mint resolves 200 and the .catch
        // never fires. The failure surfaces later as a 404 on image load, handled by onError.
        return S.skapi.util.request("get-signed-url", body, reqOpts).then(unwrap);
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
    // Chips that belong to the message being composed RIGHT NOW — everything not
    // already handed to a send. Chips of an in-flight batch stay in the row (that
    // is where their progress renders) but they belong to a message that is
    // already on its way, so every composer-side rule reads this list instead of
    // the raw one: the per-message file cap, the token budget, Send, Remove all.
    function composerAttachments() {
        return CS.attachments.filter(function (a) { return !a._batchId; });
    }
    function attachmentsTokenEstimate() {
        var total = 0;
        // Composer chips only: the budget is per REQUEST, and an already-batched
        // chip is part of a request that has been sent.
        composerAttachments().forEach(function (a) {
            if (a.kind === "folder") { (a.files || []).forEach(function (f) { total += estimateFileTokenCost(f.file); }); }
            else if (a.file) total += estimateFileTokenCost(a.file);
        });
        return total;
    }
    // Total FILE count (a folder counts as its file count), for the 20-file cap.
    function attachmentFileCount() {
        var n = 0;
        composerAttachments().forEach(function (a) { n += (a.kind === "folder") ? (a.files ? a.files.length : 0) : 1; });
        return n;
    }
    function currentInputTokenBudget() {
        var platform = S.aiPlatform;
        if (platform !== "claude" && platform !== "openai") return 0;
        // Passes S.projectId so the guard honours the project's context-window
        // setting. The local re-derivation this replaced did not, so a project
        // configured for a large window still warned at the 28,000 floor.
        return getInputTokenBudget(platform, S.aiModel, S.projectId);
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
        // Cap is per message, so it counts the composer's chips (attachmentFileCount)
        // — files already handed to an in-flight send do not eat this budget.
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
    // "Remove all" is a composer affordance: it drops what the user has staged for
    // the NEXT message and leaves in-flight batches alone (those files belong to a
    // message that is already sent — their own chip × cancels them individually).
    function clearAttachments() {
        CS.attachments = CS.attachments.filter(function (a) { return !!a._batchId; });
        CS.attachmentWarning = "";
        CS.attachmentCapNotice = "";
        renderAttachmentChips();
        updateComposerControls();
        scheduleAttachmentOverflowRecompute();
    }
    // Called when a batch finishes. Its successfully-handled chips go away; its
    // failed ones (red upload-fail / yellow index-fail) are handed BACK to the
    // composer — un-batched — so the next Send retries them. Chips belonging to
    // other batches, and to the message being composed, are untouched.
    function clearSuccessfulAttachments(batchId) {
        CS.attachments = CS.attachments.filter(function (a) {
            if (a._batchId !== batchId) return true;
            if (a.status !== "error" && a.status !== "indexError") return false;
            a._abort = null;
            delete a._batchId;
            return true;
        });
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
            // Bytes done but the post-upload work (signed url, src:: record,
            // indexing dispatch) hasn't settled: show "Finalizing" with an
            // indeterminate fill instead of freezing at 100% (mirror of
            // agent.vue's is-finalizing treatment).
            var finalizing = att.status === "uploading" && (att.progress || 0) >= 100;
            // No byte-progress event yet: the get-signed-url round trip is still
            // in flight, so there is no percentage to show. Barber pole rather
            // than a bar frozen at 0%, which reads as a stalled upload.
            var preparing = att.status === "uploading" && att.progress == null;
            var cls = "bq-attachment";
            if (att.status === "uploading") cls += " is-uploading";
            if (preparing) cls += " is-preparing";
            else if (finalizing) cls += " is-finalizing";
            else if (att.status === "error") cls += " is-error";            // red: upload failed
            else if (att.status === "indexError") cls += " is-index-error"; // yellow: indexing failed
            else if (att.status === "done") cls += " is-done";              // green: uploaded + indexed
            if (clickable) cls += " is-clickable";
            var chip = h("div", { class: cls });
            // Only bind the bar width once there IS a percentage; while preparing
            // the barber pole owns the fill and a stale width would fight it.
            if (att.status === "uploading" && att.progress != null) chip.style.setProperty("--att-progress", att.progress + "%");
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
                : preparing ? "Preparing"
                : finalizing ? "Finalizing"
                : att.status === "uploading" ? att.progress + "%"
                : isFolder ? "(" + (att.files ? att.files.length : 0) + ")"
                : formatBytes(att.file ? att.file.size : att.size);
            chip.appendChild(h("span", { class: "bq-attachment-meta", text: meta }));
            if (clickable) chip.appendChild(h("span", { class: "bq-attachment-arrow", text: "↗" }));
            // Remove button: hidden once the chip's bytes are moving (uploading) and
            // for finished (done) chips (the ↗ replaces it). Shown for pending +
            // persisted failures so the user can clear them — including a chip
            // queued behind a big upload in the same batch.
            if (att.status !== "uploading" && att.status !== "done") {
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
            var moreRm = h("button", { class: "bq-attachment-remove", type: "button",
                title: "Remove these " + hidden.length, text: "×" });
            moreRm.addEventListener("click", function (e) { e.stopPropagation(); removeAttachments(hidden.map(function (a) { return a.id; })); });
            moreChip.appendChild(moreRm);
            row.appendChild(moreChip);
        } else if (composerAttachments().length >= 2) {
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
        // ANONYMOUS SESSIONS CANNOT UPLOAD, ever. The whole indexing chain runs as the
        // uploading user, and the backend forbids anonymous users from setting unique_ids,
        // so an anon upload would store a file whose records (the "src::" file record and
        // every "__MEDIA__" media record) are all rejected: an unsearchable orphan. The
        // MCP rejects the writes server-side too; hiding the affordance here means the
        // user never hits that wall.
        if (!S.user) return true;
        var conf = (S.service && S.service.conf) || {};
        if (!conf.freeze_database) return false;
        var ag = (S.user && typeof S.user.access_group === "number") ? S.user.access_group : 0;
        return ag < 99;
    }
    function updateComposerControls() {
        // Nothing here is gated on CS.uploadingAttachments any more: a send whose
        // files are still uploading has already left the composer (its chips are
        // batched, its bubble is staged), so the user goes right on typing — and
        // attaching — the next message.
        if (CS.attachBtnEl) CS.attachBtnEl.disabled = false;
        if (CS.inputEl) CS.inputEl.disabled = false;
        // Block sending while an attachment warning is shown (too many files /
        // over budget together with a chat message). The warning is only set when
        // there is chat input text (recomputeAttachmentWarning). The cap notice
        // (attachmentCapNotice) is informational and does NOT block.
        //
        // Also disabled while there is nothing to send — no chat text and no
        // composer chip that still needs uploading or retrying (a chip already
        // "done" has nothing left to do) — mirroring agent.vue's canSend.
        if (CS.sendBtnEl) {
            var hasText = !!(CS.inputEl && CS.inputEl.value.trim());
            var hasSendableAttachment = composerAttachments().some(function (a) { return a.status !== "done"; });
            CS.sendBtnEl.disabled = !!CS.attachmentWarning || (!hasText && !hasSendableAttachment);
        }
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
        // Same as the dashboard: a PLAIN presign honouring the shared TTL, not a
        // cdn url. This used to hand out a 24-48h url while calling it 10 minutes.
        return getTemporaryUrlDb(remotePath, EXPIRED_LINK_REFRESH_EXPIRES_SECONDS, false);
    }

    // A url for this file could not be produced, so every chip for it stops
    // pretending to be a link: ✕ instead of ↗, greyed, no href and no click.
    //
    // The re-render is coalesced because the trigger is per-IMAGE: a reply
    // listing a folder of deleted pictures reports one failure per preview, and
    // renderMessages rebuilds every bubble in the list. Marking is idempotent, so
    // the repaint only happens for keys that are actually new.
    var unavailableRepaintQueued = false;
    function queueUnavailableRepaint() {
        if (unavailableRepaintQueued) return;
        unavailableRepaintQueued = true;
        setTimeout(function () { unavailableRepaintQueued = false; renderMessages(); }, 0);
    }
    function markLinkUnavailable(key) {
        if (!key || unavailableLinkMap[key]) return;
        unavailableLinkMap[key] = true;
        // Nothing has necessarily minted successfully yet, so the boundary timer
        // that clears this map may not be running.
        if (!refreshedLinkExpiryTimer) scheduleNextLinkExpiryBoundary();
        queueUnavailableRepaint();
    }

    // A preview for this file just painted, so it is reachable and no chip for it
    // should still read (unavailable).
    //
    // A RACE GUARD, not the general recovery: once a key is marked the chip
    // renders with no <img> at all (renderInlineLinkHtml drops the preview so a
    // re-render cannot re-mint and re-fail forever), so nothing for that file can
    // paint again and reach this. What it catches is one element failing while a
    // second element for the same file is still loading. A settled mark still
    // recovers on the LINK_REFRESH_WINDOW_MS boundary.
    //
    // Clears EVERY key the file can be marked under, because a failed chip click
    // marks the href key as well as the path key.
    function clearLinkUnavailable(keys) {
        var changed = false;
        for (var i = 0; i < (keys || []).length; i++) {
            var k = keys[i];
            if (!k || !unavailableLinkMap[k]) continue;
            delete unavailableLinkMap[k];
            changed = true;
        }
        if (changed) queueUnavailableRepaint();
    }

    // Inline image previews. The same plain presign the link chips use, with the
    // content type the engine classified, but minted through a CACHEABLE GET:
    // without it every reload re-mints a fresh SigV4 url, which is a fresh cache
    // key, so every visible image downloads again. See
    // PREVIEW_BROWSER_CACHE_SECONDS. `refresh` is how the error path escapes
    // that cache when the url it cached has since expired.
    function imagePreviewCtx() {
        return {
            scope: S.projectId || "default",
            mint: function (remotePath, contentType, refresh) {
                // PREVIEW ttl, not the click ttl: this url never leaves the page,
                // and its length is what decides how long the picture stays
                // locally reusable (the server will not cache a mint past the
                // life of the credential in it).
                return getTemporaryUrlDb(remotePath, PREVIEW_URL_EXPIRES_SECONDS, false, contentType, {
                    browserCache: PREVIEW_BROWSER_CACHE_SECONDS,
                    refresh: refresh,
                });
            },
            // An image arriving late pushes the conversation down under the
            // viewport. Re-pin only if the user was already at the bottom. A
            // paint is also proof the file is reachable, so it lifts any mark an
            // earlier failure left on this file's chips.
            onLoad: function (path) {
                clearLinkUnavailable(linkUnavailableKeysForPath(path));
                scrollToBottomIfSticky(false);
            },
            // The resizes an <img> makes with no event of its own to announce
            // them: the src landing, and the src being dropped for a retry (which
            // collapses an already-painted picture to nothing). load and error are
            // covered by the listener on the message box, which also catches the
            // markdown images this module never sees.
            onLayoutChange: function (img) { chatScrollAnchor.absorb(img); },
            // The mint was refused, or the url it minted would not load. Either
            // way there is no url for this file, so the caption chip left behind
            // must not keep offering a click that opens a dead tab.
            onError: function (path, err) {
                console.warn("[bunnyquery] image preview failed", path, err);
                markLinkUnavailable(linkUnavailableKeyForPath(path));
            },
        };
    }
    function hydrateMessageImagePreviews() {
        if (!CS.messagesBox) return;
        var nodes = CS.messagesBox.querySelectorAll("img.bq-img-preview:not([data-bq-img-state])");
        if (!nodes.length) return;
        // A collapsed indexing row is one line and its label is the indexed
        // file's own path, which is often an image. Never mint for those.
        var list = Array.prototype.filter.call(nodes, function (n) {
            return !(n.closest && n.closest(".bq-index-label"));
        });
        if (list.length) hydrateImagePreviews(list, imagePreviewCtx());
    }

    // Drop minted hrefs on the same wall-clock boundary the dashboard uses, so a
    // cached href can never outlive the url behind it. Without this the widget
    // held a fresh href for the life of the page.
    var refreshedLinkExpiryTimer = null;
    // Returns whether anything actually changed, because the caller's answer to
    // "yes" is a full teardown of the message list.
    function expireAllRefreshedLinks() {
        var changed = false;
        for (var k in refreshedExpiredLinkMap) { delete refreshedExpiredLinkMap[k]; changed = true; }
        // Failures expire on the same boundary. A mint can fail because the file
        // is gone, but it can also fail because the network blinked, and a chip
        // greyed out by a five-second outage that stays grey for the life of the
        // page is its own bug. The boundary already re-renders.
        for (var u in unavailableLinkMap) { delete unavailableLinkMap[u]; changed = true; }
        return changed;
    }
    function scheduleNextLinkExpiryBoundary() {
        if (refreshedLinkExpiryTimer) clearTimeout(refreshedLinkExpiryTimer);
        var now = Date.now();
        var next = Math.ceil(now / LINK_REFRESH_WINDOW_MS) * LINK_REFRESH_WINDOW_MS;
        refreshedLinkExpiryTimer = setTimeout(function () {
            // Only when a chip's markup can have changed. This fires on a
            // wall-clock boundary with no user action behind it, and a
            // renderMessages destroys and re-creates every <img> in the
            // conversation: with nothing to expire that is a periodic collapse and
            // re-decode of every picture on screen, in exchange for no change at
            // all. (agent.vue's map assignments are already guarded the same way,
            // so its reactivity does not re-render either.)
            if (expireAllRefreshedLinks()) renderMessages();
            scheduleNextLinkExpiryBoundary();
        }, Math.max(1, next - now));
    }
    function fetchFreshHrefForExpiredLink(expiredHref, remotePath) {
        var cached = refreshedExpiredLinkMap[expiredHref];
        if (cached) return Promise.resolve(cached);
        var inFlight = refreshingLinkPromises.get(expiredHref);
        if (inFlight) return inFlight;
        var run = (function () {
            refreshingLinkMap[expiredHref] = true;
            var resolved = remotePath || extractRemotePathFromAttachmentHref(expiredHref, S.projectId);
            if (!resolved) return Promise.reject(new Error("Unable to refresh this expired attachment link."));
            return getPublicTemporaryUrl(resolved).then(function (fresh) {
                refreshedExpiredLinkMap[expiredHref] = fresh;
                scheduleNextLinkExpiryBoundary();
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
        // A chip we already failed to mint a url for carries no href and no
        // `data-bq-expired`, so it cannot navigate and cannot ask for another
        // mint. Swallowing the click keeps a stray listener from reviving it.
        if (anchor.dataset.bqUnavailable === "1") { e.preventDefault(); return; }
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
            // The chip itself is the message now: it turns grey and takes a ✕,
            // which survives past the moment an alert would have been dismissed
            // and does not interrupt whatever else the user was doing.
            markLinkUnavailable(linkUnavailableKeyForHref(originalHref));
            if (anchor.dataset.bqRemotePath) markLinkUnavailable(linkUnavailableKeyForPath(anchor.dataset.bqRemotePath));
        });
    }

    /* ---- history + clear-horizon (agent.vue) ----------------------------- */
    function getClearHistoryStorageKey() {
        if (!S.projectId || S.aiPlatform === "none") return "";
        return SK.clearHorizon + ":" + S.projectId + "#" + S.aiPlatform;
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
    // History fetch + bg-drain + poll-attach live in session.loadHistory(). The
    // viewport is re-anchored by renderMessages itself (captureScrollAnchor /
    // restoreScrollAnchor), which has to do it anyway because a full re-render
    // detaches every child and clamps scrollTop to 0. Anchoring to a ROW also
    // survives what a pre/post scrollHeight delta cannot: an older page whose
    // messages all join a collapsed indexing row already on screen adds no height
    // at all, but does change that row's own height ("3+ passes" → "10 passes").
    // Returns false when it did NOT issue a request, so the fill loop retries
    // rather than reading the unchanged message count as an exhausted pager.
    function fetchOlderHistoryIfNeeded() {
        if (CS.historyEndOfList) return Promise.resolve(true);
        if (CS.loadingHistory || CS.loadingOlderHistory) return Promise.resolve(false);
        return session.loadHistory(true).then(function () { return true; });
    }

    // Can the user reach older history at all? Paging is triggered ONLY by
    // scrolling to the top of this box, so a box with nothing to scroll has no
    // trigger. No box (chat view not rendered) counts as "fine" — the load that
    // renders it runs the fill again.
    function messagesBoxCanScroll() {
        // Not showing messages at all: no box, or the settings panel has taken
        // over the box (renderMessages no-ops while it is open, so paging could
        // never change the height and the loop would burn every page it has).
        if (!CS.messagesBox || CS.chatSettingsOpen) return true;
        // The drafting bubble is cosmetic and vanishes on send; if it counted,
        // the fill loop could stop a bubble short of genuinely scrollable
        // history and lose its only trigger when the bubble leaves.
        var drafting = (CS.draftingEl && CS.draftingEl.parentNode === CS.messagesBox)
            ? CS.draftingEl.offsetHeight : 0;
        return CS.messagesBox.scrollHeight - drafting - CS.messagesBox.clientHeight > HISTORY_FILL_SLACK_PX;
    }

    // The row currently at the top of the viewport, and how much scrollable
    // content sits above it. GROWTH in that number — not growth in the box's
    // total height — is what makes a scroll-up worthwhile: an older page whose
    // messages all join a collapsed indexing row adds no row of its own (they
    // fold into the row that is already there), so the box can get taller while
    // nothing new comes within the reader's reach.
    function topVisibleRowKey() {
        var box = CS.messagesBox;
        if (!box) return null;
        var boxTop = box.getBoundingClientRect().top;
        var kids = box.children;
        for (var i = 0; i < kids.length; i++) {
            var key = kids[i].getAttribute && kids[i].getAttribute("data-row-key");
            if (!key) continue;
            if (kids[i].getBoundingClientRect().top - boxTop + kids[i].offsetHeight > 0) return key;
        }
        return null;
    }
    function contentAboveRow(key) {
        var box = CS.messagesBox;
        if (!box) return null;
        var boxTop = box.getBoundingClientRect().top;
        var kids = box.children;
        for (var i = 0; i < kids.length; i++) {
            if (!kids[i].getAttribute || kids[i].getAttribute("data-row-key") !== key) continue;
            return kids[i].getBoundingClientRect().top - boxTop + box.scrollTop;
        }
        return null;
    }

    // Shared plumbing for the two "keep paging older history" loops below. The
    // loop is the engine's (createHistoryFiller), so agent.vue behaves
    // identically; only the DOM measurement is view-side.
    //
    // One loop at a time, with a request that arrives mid-loop ANDed into it
    // rather than dropped — see createHistoryFiller for why dropping picks the
    // wrong winner. The token is captured per call, so the guards read the LIVE
    // chat rather than whichever one happened to start the loop.
    var _historyFillToken = 0;
    var _historyFiller = createHistoryFiller({
        isEndOfList: function () { return !!CS.historyEndOfList; },
        isLoading: function () { return !!(CS.loadingHistory || CS.loadingOlderHistory); },
        // The settings panel occupies the messages box and suppresses
        // renderMessages, so a fill started before it opened must stop.
        isStale: function () { return _historyFillToken !== CS.gateRefreshToken || !CS.messagesBox || CS.chatSettingsOpen; },
        messageCount: function () { return CS.messages.length; },
        fetchOlder: function () { return fetchOlderHistoryIfNeeded(); },
        // A collapsed indexing row whose run begins above the loaded window says
        // "loading" for as long as the pages that would complete it keep coming, and
        // that span is the LOOP, not a page (see createHistoryFiller). Rendering the
        // flip is safe from here: renderMessages never starts a fill of its own, and
        // the loop's own guard has already flipped before this is called.
        onRunningChange: function (running) {
            CS.historyFilling = running;
            renderMessages();
        },
    });
    function pageOlderHistoryUntil(isSatisfied, token) {
        if (token === undefined) token = CS.gateRefreshToken;
        if (token !== CS.gateRefreshToken) return Promise.resolve();
        _historyFillToken = token;
        // Measure only once the just-fetched page has actually painted.
        return _historyFiller.fill(function () { return raf2().then(isSatisfied); });
    }

    // Keep paging older history until this box can actually scroll. Without it a
    // chat whose newest page collapses to a single indexing row (a file's every
    // pass folds into ONE row — twenty-plus messages, one line) never overflows,
    // never fires a scroll event, and so never loads page 2: the user's own
    // conversation underneath the upload is unreachable.
    function ensureHistoryFillsViewport(token) {
        return pageOlderHistoryUntil(messagesBoxCanScroll, token);
    }

    // Keep paging until the scroll-up the user just made actually put something
    // ABOVE them. One page is not enough: a page that is entirely one file's
    // earlier passes joins the collapsed row already on screen and adds no row of
    // its own, so the reader stays pinned at scrollTop 0, where scrolling up again
    // fires no further event. (If that page carried the run's FIRST pass, the row
    // is re-identified — `contentAboveRow` finds no such row, and the loop stops
    // rather than paging on a measurement it can no longer make.)
    function pageOlderHistoryUntilTaller() {
        var anchorKey = topVisibleRowKey();
        var before = anchorKey ? contentAboveRow(anchorKey) : null;
        return pageOlderHistoryUntil(function () {
            // Nothing to measure against (empty list, anchor row gone): let the
            // single page that was just fetched stand.
            if (!CS.messagesBox || !anchorKey || before === null) return true;
            var now = contentAboveRow(anchorKey);
            return now === null || now > before + HISTORY_FILL_SLACK_PX;
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
        // The composer growing SHRINKS the message box (.bq-messages is flex:1 with
        // min-height:0 under a flex-shrink:0 input row), which pushes a bottom-pinned
        // reader off the bottom with NO scroll event at all - so CS.stickToBottom
        // stays true while the view no longer matches it, and the next background
        // settle jumps them to catch up. That is the typing half of "I tapped the
        // input and the scroll went somewhere else".
        //
        // A viewport change is not a content change, so the only legal answer is a
        // pin decided from the box as it is right now. Nothing is stored.
        //
        // Deliberately NOT gated on the height having changed: the height:"auto"
        // probe below forces a layout at the COLLAPSED height, which makes the
        // message box taller, drops its maxScrollTop and clamps a pinned reader down
        // - on every keystroke, including the ones whose net height is unchanged.
        var prevH = el.offsetHeight;
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
        var nextH = el.offsetHeight;   // forces the final layout before we measure
        if (CS.stickToBottom) chatScrollAnchor.pinBottom();
        // A TALLER box can stop overflowing, which takes the scroll-to-top pager
        // trigger away with it. Not an `else`: a pinned reader is exactly who ends up
        // there, having just cleared a long draft.
        if (nextH < prevH) ensureHistoryFillsViewport();
    }

    function buildMessageEl(msg, idx) {
        var cls = ["bq-message"];
        cls.push(msg.role === "user" ? "is-user" : "is-assistant");
        if (msg.isError) cls.push("is-error");
        if (msg.isCancelled) cls.push("is-cancelled");
        if (msg.isPendingQueued || msg.isPendingOlder) cls.push("is-pending-older");
        // The DIM reads _dimSending, not isSendingToServer: an attachment turn is
        // un-dimmed the moment its files finish indexing, while its own request is
        // still un-acked for a moment longer (see ChatMessage._dimSending).
        if (msg._dimSending || msg._cancelling) cls.push("is-sending-to-server");

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
            // translate:"no" keeps the browser's auto-translator from re-tokenizing
            // the message text and dropping spaces (notably in Korean/CJK). It is the
            // one text element that was missing the tag; mirrors agent.vue's div.bq-md.
            var md = h("div", { class: "bq-md", translate: "no", html: parseMsgPartsHtml(msg.content) });
            md.addEventListener("click", onBubbleLinkClick);
            bubble.appendChild(md);
            // Order matters: a staged turn carries isPendingQueued the whole way
            // through, so the two attachment phases have to be tested first.
            if (msg.isUploadingAttachments) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(Uploading files...)" }));
            else if (msg.isAwaitingIndexing) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(Indexing files...)" }));
            else if (msg.isPendingQueued) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(In queue)" }));
            if (msg.isCancelled) bubble.appendChild(h("span", { class: "bq-cancel-error", text: "(cancelled)" }));
            if (msg._cancelError) bubble.appendChild(h("span", { class: "bq-cancel-error", text: msg._cancelError }));
            var ts = formatChatTimestamp(msg._ts);
            if (ts) bubble.appendChild(h("time", { class: "bq-msg-time", text: ts }));
        }
        return h("div", { class: cls.join(" "), dataset: { msgIndex: String(idx) } }, bubble);
    }

    /* ---- collapsed background-indexing rows ------------------------------
     * One file's indexing turns (first pass + every CONTINUE pass, request AND
     * response) render as a SINGLE status row wherever they sit in the
     * conversation. Grouping is the shared engine's (buildChatDisplayList) so
     * agent.vue collapses identically; only this markup is widget-side.
     */
    // Inlined SVG, never an icon font (the widget ships none). The active one is
    // spun by CSS (.bq-index-group.is-active .bq-index-icon svg).
    var INDEX_ICON_ACTIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 0 1-8.5 8.5 8.5 8.5 0 0 1-7.6-4.7"/><path d="M3.5 12A8.5 8.5 0 0 1 12 3.5a8.5 8.5 0 0 1 7.6 4.7"/><path d="M20 3.6v4.8h-4.8"/><path d="M4 20.4v-4.8h4.8"/></svg>';
    var INDEX_ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
    var INDEX_ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.6h.01"/></svg>';
    var INDEX_ICON_CANCELLED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.2 8.2l7.6 7.6"/></svg>';
    // "Not known yet" — a clock, deliberately NOT the circular arrow: a spinning
    // sync glyph is how this row says WORK IS HAPPENING, and the whole point of
    // this state is that it is not claiming that. CSS fades it instead of spinning.
    var INDEX_ICON_PENDING = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.4V12l3.3 2"/></svg>';

    // Head and tail must never contradict each other, so both read `finished` BEFORE
    // status: a run between two passes has status "done" and is not finished, and a
    // check-mark reading "Indexed" over a still-spinning tail is the exact claim this
    // is meant to stop making. Cancelled is tested first because a stop is final
    // whatever else is true, then `resolving` — which outranks `finished` for the
    // same reason `finished` outranks status: it is the coarsest thing known, and
    // both of the answers below it are derived from data still arriving. Mirrored
    // verbatim in agent.vue.
    function indexGroupIcon(group) {
        if (group.status === "cancelled") return INDEX_ICON_CANCELLED;
        if (group.resolving) return INDEX_ICON_PENDING;
        if (!group.finished) return INDEX_ICON_ACTIVE;
        if (group.status === "error") return INDEX_ICON_ERROR;
        return INDEX_ICON_DONE;
    }

    function indexGroupVerb(group) {
        if (group.status === "cancelled") return "Indexing cancelled:";
        // Name the wait. "Loading history" is a statement about the CHAT being paged
        // in, not about the file — the row deliberately says nothing about the file
        // until it has the run's beginning to say it from.
        //
        // Short on purpose. The label is one nowrap ellipsized line shared with the
        // file name, and at the widget's narrow end (~360px) the row has roughly
        // 196px for both: a 26-character verb ate the name down to a few characters
        // for the whole wait, which trades one confusing row for another.
        if (group.resolving) {
            return group.resolvingReason === "history" ? "Loading history:" : "Checking status:";
        }
        if (!group.finished) return group.isReindex ? "Reindexing" : "Indexing";
        if (group.status === "error") return "Indexing failed:";
        return group.isReindex ? "Reindexed" : "Indexed";
    }

    // The file renders as a BARE storage-path markdown link, the same form the
    // uncollapsed bubble used, so a click mints a fresh temporary URL.
    function indexGroupLabel(group) {
        var nameLabel = group.path ? "[" + group.name + "](" + group.path + ")" : group.name;
        return indexGroupVerb(group) + " " + nameLabel;
    }

    // Passes LOADED, never a server-side total: history pages newest-first, so a
    // scroll-up can always reveal more. "+" marks a run whose start is unpaged.
    function indexGroupCount(group) {
        // A run:: stub has NO loaded passes — "0+ passes" is noise (agent.vue same).
        if (group.stub) return "";
        if (group.passCount <= 1 && !group.mayHaveOlder) return "";
        return group.passCount + (group.mayHaveOlder ? "+" : "") + " passes";
    }

    // Everything buildChatDisplayList needs to state a row's case, in ONE place:
    // renderMessages draws the rows from it and the stop dialog re-resolves its
    // target from it, and the two asking different questions is a bug the dialog
    // already had (see findCancellableIndexGroup).
    /* ---- indexing marker sweep (done:: + run::) ----------------------------
     * Widget twin of www's sweepIndexMarkers (file.ts): ONE records query on
     * the __INDEXING__ table answers, for the whole project, both "which files
     * are confirmed fully indexed" (done:: markers) and "which runs exist and
     * how did they end" (run:: records with status). Cached with a short TTL,
     * in-flight deduped, keyed to the project it was fetched for. The results
     * feed displayListOptions synchronously; refreshIndexMarkers re-renders
     * when a fresh sweep lands. */
    var markerSweep = { svc: "", at: 0, gen: 0, done: {}, runs: {}, partial: false, inflight: null };
    var MARKER_SWEEP_TTL_MS = 30000;
    // Records, not ids: up to TWO per file (done:: + run::), 10 pages of 1000.
    var MARKER_SWEEP_MAX_PAGES = 10;
    function sweepIndexMarkersDb() {
        if (!S.skapi || !S.projectId || typeof S.skapi.getRecords !== "function") return Promise.resolve(null);
        var svc = S.projectId;
        if (markerSweep.svc === svc && markerSweep.at && Date.now() - markerSweep.at < MARKER_SWEEP_TTL_MS) {
            return Promise.resolve(markerSweep);
        }
        if (markerSweep.inflight) {
            // An invalidation AFTER this sweep started means its snapshot is
            // already suspect: serve the current sweep to its own callers, but
            // chain one fresh sweep behind it for this caller instead of
            // adopting the pre-invalidation data as fresh.
            if (!markerSweep.at) {
                return markerSweep.inflight.then(function () { return sweepIndexMarkersDb(); });
            }
            return markerSweep.inflight;
        }
        var gen = markerSweep.gen;
        var done = {}; var runs = {}; var partial = false;
        function page(fetchMore, n) {
            return Promise.resolve(S.skapi.getRecords(
                { service: svc, table: { name: "__INDEXING__", access_group: "authorized" } },
                { limit: 1000, fetchMore: fetchMore, ascending: false }
            )).then(function (res) {
                var list = (res && res.list) || [];
                for (var i = 0; i < list.length; i++) {
                    var uid = String((list[i] && list[i].unique_id) || "");
                    if (uid.indexOf("done::") === 0) {
                        done[uid.slice(6)] = true;
                    } else if (uid.indexOf("run::") === 0) {
                        var path = uid.slice(5);
                        var d = (list[i] && list[i].data) || {};
                        var st = String(d.status || "");
                        // Newest-first listing: the first record seen for a path wins.
                        if (path && !runs[path] &&
                            (st === "working" || st === "done" || st === "error" || st === "cancelled")) {
                            runs[path] = {
                                status: st,
                                filename: typeof d.filename === "string" ? d.filename : undefined,
                                started: typeof d.started === "number" ? d.started : undefined,
                                finished: typeof d.finished === "number" ? d.finished : undefined,
                                error: typeof d.error === "string" ? d.error : undefined,
                                platform: (d.platform === "claude" || d.platform === "openai") ? d.platform : undefined,
                                owner: (list[i] && typeof list[i].user_id === "string") ? list[i].user_id : undefined,
                            };
                        }
                    }
                }
                if (res && res.endOfList === false) {
                    if (n < MARKER_SWEEP_MAX_PAGES - 1) return page(true, n + 1);
                    partial = true; // cap hit: the done-set is incomplete
                }
                return null;
            });
        }
        var p = page(false, 0).then(function () {
            // A project switch mid-sweep must not stamp another project's
            // markers, and an invalidation mid-sweep must not stamp a
            // pre-invalidation snapshot as fresh (gen moved on).
            if (S.projectId !== svc || markerSweep.gen !== gen) return markerSweep;
            markerSweep.svc = svc;
            markerSweep.at = Date.now();
            markerSweep.done = done;
            markerSweep.runs = runs;
            markerSweep.partial = partial;
            return markerSweep;
        });
        markerSweep.inflight = p;
        p.then(function () { markerSweep.inflight = null; }, function () { markerSweep.inflight = null; });
        return p;
    }
    function invalidateIndexMarkerSweep() { markerSweep.at = 0; markerSweep.gen++; }
    // Re-sweep cadence while a fresh 'working' run record has no live-queue
    // confirmation: nothing else can ever settle its stub row in-session (no
    // poll, no queue entry, no adoption). Matches the sweep TTL so each tick
    // fetches at most one naturally-fresh sweep.
    var STUB_RECHECK_MS = 30000;
    var STUB_RECHECK_MAX_ROUNDS = 5;
    var stubRecheckTimer = null;
    var stubRecheckSig = "";
    var stubRecheckRounds = 0;
    // True once the current project's sweep has answered (success or failure):
    // the empty-chat greeting holds on it (agent.vue markerSweepSettled same).
    var markerSweepSettled = false;
    function armStubRecheck() {
        if (stubRecheckTimer !== null) return;
        stubRecheckTimer = setTimeout(function () {
            stubRecheckTimer = null;
            // A tick on a hidden tab defers; the visibility handler's resume
            // path re-renders, which re-arms via maybeArmStubRecheck.
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            stubRecheckRounds++;
            void refreshIndexMarkers();
        }, STUB_RECHECK_MS);
    }
    function maybeArmStubRecheck() {
        try {
            if (markerSweep.svc !== S.projectId) return;
            var lk = (session && session.getLiveIndexState().keys) || {};
            var sig = [];
            for (var pth in markerSweep.runs) {
                var r = markerSweep.runs[pth];
                // Unconfirmed 'working' records settle only through a fresh
                // sweep — but a done:: marker already settles the row (the
                // display's doneKeys disjunct), and live-confirmed ones ride
                // the live-key drain edge instead.
                if (!r || r.status !== "working" || lk[pth]) continue;
                var fn = r.filename || pth.split("/").pop() || pth;
                if (markerSweep.done[pth] || markerSweep.done[fn]) continue;
                sig.push(pth);
            }
            if (!sig.length) {
                stubRecheckSig = ""; stubRecheckRounds = 0;
                if (stubRecheckTimer !== null) { clearTimeout(stubRecheckTimer); stubRecheckTimer = null; }
                return;
            }
            var s = sig.sort().join("|");
            if (s !== stubRecheckSig) { stubRecheckSig = s; stubRecheckRounds = 0; }
            // Dead records: the same set has come back unchanged for several
            // sweeps — stop hammering; any change to the set re-opens the loop.
            if (stubRecheckRounds >= STUB_RECHECK_MAX_ROUNDS) return;
            armStubRecheck();
        } catch (e) { /* display-side best effort */ }
    }
    function refreshIndexMarkers(invalidate) {
        if (invalidate) invalidateIndexMarkerSweep();
        return sweepIndexMarkersDb().then(function (res) {
            markerSweepSettled = true;
            if (res) { maybeArmStubRecheck(); renderMessages(); }
            return res;
        }).catch(function () {
            // A failed sweep still SETTLES the greeting hold — better an early
            // greeting than one that can never appear.
            markerSweepSettled = true;
            renderMessages();
            return null;
        });
    }

    function displayListOptions() {
        var liveIndex = session.getLiveIndexState();
        // svc match only — NOT `at`: an invalidation zeroes `at` to force the
        // next fetch, and dropping already-rendered markers for that window
        // would blink every stub row out and back (agent.vue keeps
        // last-known-good the same way). svc is only ever stamped by a sweep
        // for the current project.
        var fresh = markerSweep.svc === S.projectId;
        // Stub rows are per-CHAT and this chat belongs to the signed-in end
        // user: another user's runs must not splice rows into it. Ownerless
        // records (pre-owner sweeps) are kept.
        var stubs = undefined;
        if (fresh) {
            stubs = {};
            var myId = (S.user && S.user.user_id) || "";
            for (var rp in markerSweep.runs) {
                var rr = markerSweep.runs[rp];
                if (rr && rr.owner && myId && rr.owner !== myId) continue;
                // Copy: the sweep cache owns these objects and patches them in
                // place, which would change a rendered row invisibly.
                stubs[rp] = { status: rr.status, filename: rr.filename, started: rr.started,
                    finished: rr.finished, error: rr.error, platform: rr.platform, owner: rr.owner };
            }
        }
        return {
            hasMoreHistory: !CS.historyEndOfList,
            // Older pages coming in RIGHT NOW. CS.historyFilling, not just the
            // per-request flag: the viewport fill is many pages and that flag drops
            // to false between every one of them, which is once per page of flicker
            // on any row rendered off it.
            loadingOlderHistory: !!(CS.loadingOlderHistory || CS.historyFilling),
            liveIndexKeys: liveIndex.keys,
            liveIndexChecked: liveIndex.checked,
            // Runs the user stopped. A stop that landed on a RUNNING pass leaves no
            // cancelled bubble behind (that pass finishes and answers normally), so
            // without this the row reports the stop as a finished "Indexed".
            stoppedIndexIds: session.getStoppedIndexIds(),
            // Durable completion markers + run records (one sweep, see above).
            // doneKeys settle worker-run greens without a queue round trip;
            // runStubs paint rows for runs whose passes are not loaded yet.
            doneKeys: fresh ? markerSweep.done : undefined,
            runStubs: stubs,
            // Records are service-wide and horizon-blind; without this every
            // "Clear chat history" resurrected one row per indexed file.
            stubClearedAt: getClearedAt(),
            // A run:: record is per FILE; a chat is per (project, PLATFORM).
            stubPlatform: (S.aiPlatform === "claude" || S.aiPlatform === "openai") ? S.aiPlatform : undefined,
        };
    }

    /* ---- stop-indexing confirmation ----------------------------------------
     * The row's Stop only ASKS. Cancelling is not resumable from the row (the
     * queued passes are dropped, not paused, so finishing the file means
     * reindexing it from the start), and the button sits inside a one-line row
     * the user is often just trying to expand — one stray click should not throw
     * away an hour of indexing. agent.vue asks with the same wording.
     *
     * State holds the run KEY, not the group object: the display list is rebuilt
     * on every render, so a group captured at click time goes stale within
     * seconds and a pass queued while the dialog sat open would be missing from
     * the cancellableIds we would then cancel. */
    var stopIndexState = { runKey: "", fileKey: "", handle: null };

    // Is there still work to stop? NOT "does the row have a cancellable pass right
    // now", which is what this used to ask. A worker-driven file (any PDF, and every
    // windowed read) has no pass in this client between two passes: the worker mints
    // the next one itself and the client only learns about it a beat later. That gap
    // is seconds long, happens once per pass, and is the most likely moment for a
    // user to be looking at the row — so keying the button and the dialog off a live
    // pass made both blink out mid-run, and a confirm that landed in the gap
    // cancelled nothing at all while the worker carried on. `finished` is the
    // question actually being asked, and for a worker run it is answered by the
    // queue; `resolving` keeps it from being asked before anything is known.
    // agent.vue's indexGroupStoppable is the same predicate.
    function indexGroupStoppable(group) {
        // A run:: STUB is never stoppable: its passes are not loaded, and the
        // record may describe ANOTHER user's run, whose queue this client's
        // cancel cannot reach (agent.vue same).
        return !!group && !group.stub && !group.finished && !group.resolving && !group.stopped && !group.cancelling;
    }

    // The group the open dialog is about, or null once there is nothing left to
    // stop. Rows are matched by runKey; the FILE key is the fallback for the one
    // thing that renames a run under an open dialog — an older history page arriving
    // with the run's true first pass, which the run is named after. Without it the
    // confirm would silently cancel nothing.
    function findCancellableIndexGroup(runKey, fileKey) {
        if (!runKey) return null;
        // The SAME options renderMessages builds the rows from. Anything less and
        // this asks a different question than the row the user clicked: without
        // liveIndexKeys, `finished` is false for every worker-driven run, so a file
        // the queue has confirmed is over would still look stoppable here.
        var list = buildChatDisplayList(CS.messages, displayListOptions());
        var byFile = null;
        for (var i = 0; i < list.length; i++) {
            var row = list[i];
            if (row.kind !== "indexing") continue;
            var live = indexGroupStoppable(row.group) ? row.group : null;
            if (row.group.runKey === runKey) return live;
            if (!byFile && live && fileKey && row.group.key === fileKey) byFile = row.group;
        }
        return byFile;
    }

    // openModal's own dismissals (backdrop click, ×) just detach the root, so a
    // dismissed dialog is detected here rather than through a callback.
    function stopIndexModalIsOpen() {
        var hnd = stopIndexState.handle;
        if (hnd && hnd.root && hnd.root.parentNode) return true;
        stopIndexState.runKey = "";
        stopIndexState.fileKey = "";
        stopIndexState.handle = null;
        return false;
    }

    function closeStopIndexModal() {
        var hnd = stopIndexState.handle;
        stopIndexState.runKey = "";
        stopIndexState.fileKey = "";
        stopIndexState.handle = null;
        if (hnd) hnd.close();
    }

    // The file can finish (or fail, or start cancelling) while the dialog sits
    // open, which takes the row's Stop away — drop the dialog with it rather than
    // leave a dead confirm on screen offering to cancel nothing. Called from every
    // renderMessages; the list rebuild only happens while a confirm is actually
    // open, which is a human-timescale window.
    function syncStopIndexModal() {
        if (!stopIndexModalIsOpen()) return;
        if (!findCancellableIndexGroup(stopIndexState.runKey, stopIndexState.fileKey)) closeStopIndexModal();
    }

    function openStopIndexModal(group) {
        if (!indexGroupStoppable(group)) return;
        closeStopIndexModal();
        stopIndexState.runKey = group.runKey;
        stopIndexState.fileKey = group.key;
        var name = group.name;
        stopIndexState.handle = openModal(function (close) {
            var stopBtn = h("button", { class: "btn btn--danger", type: "button" }, "Stop indexing");
            stopBtn.addEventListener("click", function () {
                var runKey = stopIndexState.runKey;
                var fileKey = stopIndexState.fileKey;
                closeStopIndexModal();
                // Re-resolve: the row this was opened from is several renders old.
                var live = findCancellableIndexGroup(runKey, fileKey);
                if (live) session.cancelIndexingGroup(live);
            });
            return h("div", { class: "bq-modal" },
                h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
                h("div", { class: "bq-modal-delete-header" }, h("span", { text: "Stop indexing" })),
                // The file name is user data: translate="no" keeps a browser
                // translator from rewriting it (agent.vue tags it the same way).
                h("p", { class: "bq-modal-desc" },
                    "Stop indexing “", h("span", { translate: "no", text: name }), "”?"),
                h("p", { class: "bq-modal-desc bq-modal-delete-warn" },
                    "Whatever has been indexed so far stays searchable, and the pass already running finishes on the server. " +
                    "The remaining passes are dropped, not paused, so the file stays partly indexed until you reindex it."),
                h("div", { class: "bq-modal-btns" },
                    h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Keep indexing"),
                    stopBtn));
        });
    }

    // Keyed by FILE (group.key), NOT by run (group.runKey): a run is named after its
    // first LOADED pass, so it is renamed the moment an earlier pass arrives —
    // routine while a worker-driven chain runs, because an adopted pass reaches the
    // client before the ones before it are paged in. Keyed by run, a row the user had
    // opened closed itself every time that happened. See IndexingGroup.key.
    function toggleIndexGroup(key) {
        if (CS.indexGroupsOpen[key]) delete CS.indexGroupsOpen[key];
        else {
            CS.indexGroupsOpen[key] = true;
            // The row's settled replies may be compact stubs (split history
            // fetch) — ask the engine for their real bodies now that someone
            // wants to read them. The engine memoizes per chat, so refreshes
            // cannot revert an expanded row to its stub heads.
            hydrateCompactIndexGroup(key);
            // And an INCOMPLETE row starts paging its history in now — opening
            // it is the demand signal the lazy split fetch was waiting for
            // (agent.vue same).
            void loadIndexGroupHistory(key);
        }
        renderMessages();
        // Collapsing a row can drop the list below one screen, which removes the
        // scroll-to-top pager trigger along with the height.
        ensureHistoryFillsViewport();
    }

    /* ---- expand-triggered lazy history fetch (agent.vue mirror) ------------
     * An opened row whose passes are not fully loaded pages older history until
     * its run is complete on screen, the history ends, or a cap trips. The row
     * shows a spinner in its head and a loading note in its body throughout —
     * whatever its status verdict (a green row can be fetching detail). */
    var INDEX_GROUP_FETCH_MAX_PAGES = 40;
    var indexGroupFetching = {};
    function groupNeedsHistory(key) {
        if (CS.historyEndOfList) return false;
        try {
            var entries = buildChatDisplayList(CS.messages, displayListOptions());
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].kind !== "indexing" || entries[i].group.key !== key) continue;
                return !!(entries[i].group.stub || entries[i].group.mayHaveOlder);
            }
        } catch (e) { /* fall through */ }
        return false;
    }
    function loadIndexGroupHistory(key) {
        if (indexGroupFetching[key]) return Promise.resolve();
        if (!groupNeedsHistory(key)) return Promise.resolve();
        indexGroupFetching[key] = true;
        renderMessages();
        var pages = 0, waits = 0;
        function step() {
            if (!CS.indexGroupsOpen[key]) return null;          // closed: stop paying
            if (!groupNeedsHistory(key)) return null;
            if (pages >= INDEX_GROUP_FETCH_MAX_PAGES) return null;
            if (CS.loadingOlderHistory || CS.historyFilling || session.state.bgHistoryLoading) {
                // Another pager (or the deferred stub batch) owns the wire.
                // Bounded: a stuck flag must not pin the spinner forever.
                if (++waits > 240) return null;
                return new Promise(function (r) { setTimeout(r, 250); }).then(step);
            }
            pages++;
            return fetchOlderHistoryIfNeeded().then(step);
        }
        return Promise.resolve(step()).catch(function () { }).then(function () {
            delete indexGroupFetching[key];
            // Newly-paged passes may be compact stubs — fetch their bodies.
            hydrateCompactIndexGroup(key);
            renderMessages();
        });
    }

    // Map an expanded group's compact passes to their item ids and delegate the
    // fetch/memo/swap to the engine (mirror of agent.vue's wrapper).
    function hydrateCompactIndexGroup(key) {
        try {
            var entries = buildChatDisplayList(session.state.messages, displayListOptions());
            for (var i = 0; i < entries.length; i++) {
                var en = entries[i];
                if (en.kind !== "indexing" || en.group.key !== key) continue;
                var ids = [];
                for (var mi = 0; mi < en.group.members.length; mi++) {
                    var m = en.group.members[mi].msg;
                    if (m && m._compact && m.role === "assistant" && m._serverItemId && !m.isError && !m.isPending) ids.push(m._serverItemId);
                }
                if (ids.length) session.hydrateCompactItems(ids);
                return;
            }
        } catch (e) { /* best-effort: stubs keep their heads */ }
    }

    function buildIndexGroupEl(group, isOpen) {
        var cls = ["bq-index-group"];
        // The row's colour, one class per state: yellow working, green indexed, red
        // failed, grey not-known-yet and grey for anything else, cancelled included.
        // Same ordering as indexGroupIcon: is-active is the WORKING look (warning
        // colour, a spinning glyph) and must never win over is-resolving, where "not
        // confirmed over" is precisely what has not been established; is-indexed
        // mirrors the DONE glyph and is reachable only from status 'done', so a
        // failure or a stop can never come out green.
        //
        // Each condition is self-contained, NOT chained with `else`: agent.vue
        // expresses these as a class-binding object, where every entry stands alone,
        // and the two clients must be the same booleans rather than the same
        // outcome reached two different ways.
        if (group.resolving) cls.push("is-resolving");
        if (!group.resolving && !group.finished && group.status !== "cancelled") cls.push("is-active");
        if (!group.resolving && group.finished && group.status === "done") cls.push("is-indexed");
        if (group.finished && group.status === "error") cls.push("is-error");
        if (isOpen) cls.push("is-open");

        // The rendered html goes inside a .bq-md wrapper, matching agent.vue's
        // label DOM: every shared chat.css rule that flattens the label
        // (.bq-index-label .bq-md p { display:inline; margin:0 }, the image-
        // preview hiding) is scoped through .bq-md. Setting the html directly
        // on the label span left a bare <p> carrying the host page's default
        // margins, which made the collapsed row tall in the widget only.
        var label = h("span", { class: "bq-index-label" },
            h("span", { class: "bq-md", html: parseMsgPartsHtml(indexGroupLabel(group), { imagePreviews: false }) }));
        label.addEventListener("click", function (e) {
            // A click on the file name is a download, not a collapse toggle.
            if (e.target && e.target.closest && e.target.closest("a")) e.stopPropagation();
            onBubbleLinkClick(e);
        });

        // Stop indexing this file: cancels every queued/running pass and keeps the
        // client from dispatching the next one. Sits in the head so it is reachable
        // without expanding the row; its click must not toggle that row.
        // Offered while there is work left to stop, not while a pass happens to be
        // live in THIS client: a worker-driven file has none between passes and the
        // button used to blink out for the whole gap. See indexGroupStoppable.
        var cancelBtn = null;
        if (indexGroupStoppable(group) || group.cancelling) {
            cancelBtn = h("button", {
                class: "bq-index-cancel" + (group.cancelling ? " is-disabled" : ""),
                type: "button",
                title: group.cancelling ? "Stopping..." : "Stop indexing this file",
                "aria-label": "Stop indexing " + group.name,
                text: group.cancelling ? "Stopping..." : "Stop",
            });
            if (group.cancelling) cancelBtn.disabled = true;
            else cancelBtn.addEventListener("click", function (e) {
                e.stopPropagation();
                openStopIndexModal(group);
            });
            cancelBtn.addEventListener("keydown", function (e) { e.stopPropagation(); });
        }

        // A div, not a button: the file name inside is a real anchor, and an
        // anchor nested in a button is invalid and swallows its own activation.
        var head = h("div", {
            class: "bq-index-head",
            role: "button",
            tabindex: "0",
            "aria-expanded": isOpen ? "true" : "false",
            title: isOpen ? "Hide indexing steps" : "Show indexing steps",
            onclick: function () { toggleIndexGroup(group.key); },
            onkeydown: function (e) {
                if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
                e.preventDefault();
                toggleIndexGroup(group.key);
            },
        },
            h("span", { class: "bq-index-icon", html: indexGroupIcon(group) }),
            label,
            indexGroupCount(group) ? h("span", { class: "bq-index-count", text: indexGroupCount(group) }) : null,
            // Spinning arrows while this row's history is being paged in —
            // separate from the status icon, so a green (done) row spins too.
            indexGroupFetching[group.key]
                ? h("span", { class: "bq-index-fetch", html: INDEX_ICON_ACTIVE, title: "Fetching this file's indexing history" })
                : null,
            cancelBtn,
            h("span", { class: "bq-index-chevron", text: "▶" }));

        var el = h("div", { class: cls.join(" ") }, head);
        if (group.cancelError) {
            el.appendChild(h("div", {
                class: "bq-index-note is-error",
                text: "Could not stop this file: " + group.cancelError,
            }));
        }
        // "Scroll up to load them" is an instruction, so it must not be given while
        // the loading it asks for is already in flight: following it does nothing the
        // row is not doing, and reads as the row not having noticed.
        if (isOpen && indexGroupFetching[group.key]) {
            // While the expand-triggered fetch runs, the note IS the progress:
            // dot-trail loader, not an instruction (agent.vue same).
            el.appendChild(h("div", { class: "bq-index-note" },
                h("span", { text: "Loading this file's indexing history" }),
                h("span", { class: "bq-loader" })));
        } else if (isOpen && group.mayHaveOlder) {
            var loadingNow = group.resolvingReason === "history" ||
                (group.stub && session.state.bgHistoryLoading);
            el.appendChild(h("div", {
                class: "bq-index-note",
                text: "Earlier passes of this file are further back in the conversation. "
                    + (loadingNow ? "Loading them now." : "Scroll up to load them."),
            }));
        } else if (isOpen && !group.visibleMembers.length) {
            // An open row must NEVER be a void: when the whole history is
            // walked and the passes still are not here (cleared conversation,
            // another chat or platform's run), say so (agent.vue same).
            el.appendChild(h("div", {
                class: "bq-index-note",
                text: "This file's indexing steps aren't in this chat's history. They may belong to another chat or platform, or the conversation was cleared.",
            }));
        }
        return el;
    }

    /** The opening line, from the engine so agent.vue cannot say something else.
     *  It leads with the UPLOAD, not with "ask me anything": a project with no
     *  indexed files has nothing to answer from, and inviting questions first
     *  reads as a promise the box cannot keep. When the user cannot upload at
     *  all (anonymous session, or a frozen database for a non-admin, both
     *  uploadsFrozenForUser) that instruction would be a dead end, so those
     *  sessions get the ask-first line instead. buildSystemPrompt sends this
     *  same text to the model, which never sees the bubble itself. */
    function greetingParts() {
        return buildChatGreeting({ projectName: S.serviceName, canUpload: !uploadsFrozenForUser() });
    }
    /** The permanent opening bubble. An ordinary assistant message: same class,
     *  same bubble, so it wears the bunny face chat.css gives every one of them. */
    function buildGreetingEl() {
        var parts = greetingParts();
        // The project name is user data: translate="no" keeps a browser's auto
        // translator from rewriting it (same as agent.vue's <strong>).
        var name = parts.name
            ? [document.createTextNode(" "), h("strong", { translate: "no", text: parts.name })]
            : null;
        var bubble = h("div", { class: "bq-bubble" });
        append(bubble, parts.lead);
        append(bubble, name);
        append(bubble, parts.tail);
        return h("div", { class: "bq-message is-assistant bq-empty-greeting" }, bubble);
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
    /* ---- scroll anchoring across a full re-render ---------------------------
     * renderMessages rebuilds the whole list, and detaching every child collapses
     * scrollHeight, which makes the browser clamp scrollTop to 0. A reader
     * scrolled up into history was therefore yanked to the very top of the chat
     * on EVERY re-render — a bg-indexing turn arriving, a poll resolving, a
     * response streaming in — and landed on the scroll-to-top pager trigger while
     * they were at it.
     *
     * Restoring the raw scrollTop is not enough either: rows move. A collapsed
     * indexing row renders at its run's FIRST pass, so a new pass no longer moves
     * it, but an older page carrying earlier passes of that run still does — and
     * everything below a row that moves or changes height slides by. Anchoring to
     * a ROW — remember which row was at the top of the viewport and where, then
     * put that row back — is the only thing that survives both, and it subsumes
     * the older-page prepend as well.
     *
     * Anchor identity must be stable across the re-render, so it is the server
     * item id (or local id) rather than the array index, which every prepend
     * renumbers.
     *
     * A collapsed indexing row is a WEAK anchor because it can still relocate:
     * pinning it while it moves is what would drag the reader along with it. So
     * an ordinary message row is always preferred, and a group row is used only
     * when nothing else is on screen — and then only if it did not move
     * (data-row-pos names the turn it is anchored at). */
    function rowAnchorKey(msg, index) {
        if (!msg) return null;
        // role, because one server item produces both a request and a response
        // bubble under a single id.
        var id = msg._serverItemId || msg._localId;
        return id ? "s" + id + ":" + msg.role : "i" + index;
    }
    // Identifies the turn a collapsed row is currently anchored at. Straight from
    // the engine: WHICH member the row renders at is buildChatDisplayList's
    // decision, and re-deriving it here as "the last member" made this disagree
    // with the engine the moment the anchor moved to the run's FIRST pass. "" when
    // that turn has no id yet, which reads as "cannot tell" and simply skips the
    // moved-row check.
    function indexGroupAnchorId(group) {
        return group.anchorId || "";
    }
    // One implementation, shared with agent.vue (engine/scroll_anchor.ts).
    // rawFallback, unlike there: this view REBUILDS the list, and the teardown
    // clamps scrollTop to 0, so when the anchored row cannot be found again the
    // raw offset is strictly better than the clamp it would be left with.
    var chatScrollAnchor = createScrollAnchor({
        getBox: function () { return CS.messagesBox; },
        isStuck: function () { return !!CS.stickToBottom; },
        rawFallback: true,
    });
    function captureScrollAnchor() { return chatScrollAnchor.capture(); }
    function restoreScrollAnchor(anchor) {
        var box = CS.messagesBox;
        if (!box) return;
        // A reader pinned to the bottom stays pinned. This matters most for the
        // viewport fill: prepending older history onto a list that was too short
        // to scroll would otherwise leave the user staring at the OLDEST message,
        // because the teardown above clamped scrollTop to 0. The shared anchor
        // no-ops while pinned (there the bottom IS the anchor), so re-pinning has
        // to happen at this call site.
        if (CS.stickToBottom) { chatScrollAnchor.pinBottom(); return; }
        anchorWroteSinceScroll = true;
        chatScrollAnchor.restore(anchor);
    }

    // Local "you are typing" indicator: while the composer holds text, the list
    // ends with a user-side bubble running the same dot-trail as the assistant's
    // Thinking placeholder. Cosmetic only; it never becomes a message and never
    // enters history. renderMessages clears the box on every rebuild, so it (and
    // every other exit that leaves the list on screen) re-appends via this sync.
    function syncDraftingIndicator() {
        if (!CS.messagesBox) return;
        if (CS.drafting && !CS.chatSettingsOpen) {
            if (!CS.draftingEl) {
                CS.draftingEl = h("div", { class: "bq-message is-user bq-user-drafting", "aria-hidden": "true" },
                    h("div", { class: "bq-bubble" }, h("span", { class: "bq-loader" })));
            }
            // appendChild moves it if already attached, so it is always LAST.
            CS.messagesBox.appendChild(CS.draftingEl);
        } else if (CS.draftingEl && CS.draftingEl.parentNode) {
            CS.draftingEl.parentNode.removeChild(CS.draftingEl);
        }
    }

    function renderMessages() {
        // Before the early returns below: a cleared history and an opened settings
        // panel both take the row (and its Stop) off screen while the confirm this
        // opened is still sitting on top of the widget.
        syncStopIndexModal();
        // Live-key set shrinking = a run just ended, so a fresh done::/run::
        // marker may exist — re-sweep (agent.vue watches the same edge).
        var _lk = session.getLiveIndexState().keys || {};
        var _lc = 0; for (var _k in _lk) _lc++;
        if (CS._lastLiveKeyCount > 0 && _lc < CS._lastLiveKeyCount) void refreshIndexMarkers(true);
        CS._lastLiveKeyCount = _lc;
        if (!CS.messagesBox) return;
        if (CS.chatSettingsOpen) return; // the settings panel occupies the messages area
        var anchor = captureScrollAnchor();
        clear(CS.messagesBox);
        CS.messageEls = [];
        // "Fetching history..." pinned at the top while paginating older history (scroll-up).
        if (CS.loadingOlderHistory) CS.messagesBox.appendChild(historyLoadingEl(false));
        // Deferred indexing-stub batch (first-paint split): conversation is
        // painted, stubs still flying — a thin hint where rows will merge in.
        else if (session.state.bgHistoryLoading) {
            // No messages.length requirement: an all-bg chat's first paint has
            // an EMPTY message list while the batch flies, and requiring
            // messages here left the box completely blank for that window
            // (agent.vue's bar has no such requirement either).
            CS.messagesBox.appendChild(h("div", { class: "bq-history-loading" },
                h("span", { text: "Loading indexing history" }), h("span", { class: "bq-loader" })));
        }
        // ALWAYS, and always first. The greeting is the opening line of the
        // conversation, not a placeholder for an empty one: it goes in before any
        // history so a long chat simply carries it at the top of its scrollback.
        // It used to be appended only in the empty-chat branch below, so the one
        // message that says what this box is for disappeared the moment someone
        // used it. Mirrored in agent.vue.
        CS.messagesBox.appendChild(buildGreetingEl());

        if (!CS.messages.length) {
            // Initial load: show "Fetching history..." instead of the greeting.
            if (CS.loadingHistory && !CS.loadingOlderHistory) {
                CS.messagesBox.appendChild(historyLoadingEl(true));
                // Same contract as every other exit that leaves the list on
                // screen: the input listener shows the bubble under this bar,
                // so a rebuild here must not silently drop it (a later
                // keystroke cannot restore it; CS.drafting does not change).
                syncDraftingIndicator();
                // Every exit that leaves a list on screen has to put the reader
                // back: this branch rebuilt the box just as thoroughly as the main
                // one did, and the teardown above clamped scrollTop to 0. An empty
                // surface conversation is not an empty SCREEN — a chat that is all
                // background indexing renders one stub row per file, which
                // overflows easily.
                restoreScrollAnchor(anchor);
                return;
            }
            // run:: stub rows render even with no messages (a returning user's
            // indexed files) — agent.vue paints the same rows, so the two
            // clients must match.
            var emptyStubEls = [];
            try {
                var emptyEntries = buildChatDisplayList([], displayListOptions());
                for (var ge = 0; ge < emptyEntries.length; ge++) {
                    if (emptyEntries[ge].kind !== "indexing") continue;
                    var sg = emptyEntries[ge].group;
                    var stubEl = buildIndexGroupEl(sg, !!CS.indexGroupsOpen[sg.key]);
                    // Keyed exactly as the main path keys a group row. These are
                    // the ONLY rows on screen in this branch, so without the
                    // attributes the anchor has nothing to hold and the reader is
                    // dropped at the top of the file list on every re-render.
                    stubEl.setAttribute("data-row-key", "g" + sg.runKey);
                    stubEl.setAttribute("data-row-pos", indexGroupAnchorId(sg));
                    emptyStubEls.push(stubEl);
                }
            } catch (e) { /* display-side best effort */ }
            for (var gse = 0; gse < emptyStubEls.length; gse++) CS.messagesBox.appendChild(emptyStubEls[gse]);
            // A first-ever message can be mid-draft under the greeting.
            syncDraftingIndicator();
            // Same contract as the branch above and as the main exit below.
            restoreScrollAnchor(anchor);
            return;
        }
        // Rows, not raw messages: a file's many background-indexing turns collapse
        // into one status row. An expanded row's own turns are emitted as ordinary
        // message rows right after it, so buildMessageEl stays the single source.
        var rows = buildChatDisplayList(CS.messages, displayListOptions());
        // Mint-on-observe (mirror of agent.vue's recordChatIndexVerdicts tail):
        // a loaded REAL row proving a run deterministically over — single-pass
        // settled clean, or a done:: marker — while its run:: record still says
        // 'working' means no client ever observed the settle (tab closed
        // mid-run, or a pre-flip record). Flip it once per path.
        try {
            if (markerSweep.svc === S.projectId) {
                var moSeen = S._mintObserved || (S._mintObserved = {});
                for (var moi = 0; moi < rows.length; moi++) {
                    var moe = rows[moi];
                    if (moe.kind !== "indexing" || moe.group.stub) continue;
                    var mog = moe.group;
                    if (!mog.path || !mog.finished || mog.status !== "done" || mog.resolving) continue;
                    if (!(mog.driver === "single" || markerSweep.done[mog.path])) continue;
                    // Existing-but-unobserved 'working' AND missing-entirely
                    // (LEGACY run, pre-run::) both mint: same deterministic
                    // authority as the done:: marker, and the create is what
                    // moves a legacy run onto the fast path (agent.vue same).
                    var morec = markerSweep.runs[mog.path];
                    if ((!morec || morec.status === "working") && !moSeen[mog.path]) {
                        moSeen[mog.path] = true;
                        var moFirst = mog.members && mog.members[0] && mog.members[0].msg && mog.members[0].msg._ts;
                        var moLast = mog.members && mog.members.length &&
                            mog.members[mog.members.length - 1].msg && mog.members[mog.members.length - 1].msg._ts;
                        var moPatch = { status: "done", finished: typeof moLast === "number" ? moLast : Date.now() };
                        if (typeof moFirst === "number") moPatch.started = moFirst;
                        if (mog.name) moPatch.filename = mog.name;
                        void upsertIndexRunRecordDb(S.projectId, mog.path, moPatch);
                        // Patch the local sweep too, or its TTL-cached 'working'
                        // re-fires this block on every re-render (agent.vue same).
                        if (morec) morec.status = "done";
                        else markerSweep.runs[mog.path] = { status: "done" };
                    }
                }
            }
        } catch (e) { /* best-effort */ }
        rows.forEach(function (row) {
            if (row.kind === "indexing") {
                var isOpen = !!CS.indexGroupsOpen[row.group.key];
                var groupEl = buildIndexGroupEl(row.group, isOpen);
                // The group's own key: it survives passes joining the group and
                // the row relocating to the file's newest turn. data-row-pos says
                // WHICH turn it is currently anchored at, so the scroll anchor can
                // tell that the row moved rather than dutifully following it (see
                // captureScrollAnchor). It is the newest member's server id, not
                // its array index, because a prepend renumbers indices without
                // moving anything.
                groupEl.setAttribute("data-row-key", "g" + row.group.runKey);
                groupEl.setAttribute("data-row-pos", indexGroupAnchorId(row.group));
                CS.messagesBox.appendChild(groupEl);
                if (!isOpen) return;
                // visibleMembers, not members: a CONTINUE pass's request bubble only
                // repeats the row's own header, and the running placeholder is
                // superseded by the group's own loader below. members stays the full
                // list for every count/status/cancel/anchor decision.
                row.group.visibleMembers.forEach(function (member) {
                    var pass = buildMessageEl(member.msg, member.index);
                    pass.classList.add("bq-index-pass");
                    pass.setAttribute("data-row-key", rowAnchorKey(member.msg, member.index));
                    CS.messageEls[member.index] = pass;
                    CS.messagesBox.appendChild(pass);
                });
                // Still working, or we cannot confirm otherwise. Carries NO
                // data-row-key: the scroll anchor picks its target by that attribute
                // and a keyed element with no data-row-pos would be preferred over the
                // real rows. aria-hidden because the state is already on the row head.
                //
                // NOT while resolving, for the same reason the head refuses to spin
                // there: an animated rail under an open row is the "work is happening
                // here" signal, and this state exists to withhold exactly that claim.
                // It also has nothing to point at — the passes a 'history' wait is
                // missing are EARLIER ones, which arrive above the row, not below it.
                //
                // Cancelled is tested here for the same reason indexGroupIcon tests it
                // first: a stop is final whatever else is true. The engine does already
                // force `finished` on a cancelled run, so this can never fire — but the
                // head does not lean on that and neither should the tail, which is the
                // whole point of the two being one claim made twice.
                if (!row.group.finished && !row.group.resolving && row.group.status !== "cancelled") {
                    CS.messagesBox.appendChild(h("div", {
                        class: "bq-index-pass bq-index-tail", "aria-hidden": "true",
                    }, h("span", { class: "bq-loader" })));
                }
                return;
            }
            var el = buildMessageEl(row.msg, row.index);
            el.setAttribute("data-row-key", rowAnchorKey(row.msg, row.index));
            CS.messageEls[row.index] = el;
            CS.messagesBox.appendChild(el);
        });
        // BEFORE the anchor restore: the sticky-bottom branch measures
        // scrollHeight, and it must include the drafting bubble or a pinned
        // reader is left one bubble short of the bottom (and the resulting
        // scroll event then flips stickToBottom off). Safe here: the bubble
        // carries no data-row-key, so the anchor math never picks it, and as
        // the last child it cannot shift the anchored rows above it.
        syncDraftingIndicator();
        // BEFORE the restore, not after. This is the whole reason a reader who
        // leaves the page and comes back lands somewhere unrelated to where they
        // were, and it is entirely mechanical:
        //
        //   clear()      every <img> is destroyed and scrollTop clamps toward 0
        //   rebuild      the new <img> elements have NO src yet, and the sheet
        //                hides a src-less preview, so each one measures 0px
        //   restore      the anchor math therefore runs against a list that is
        //                short by the full height of every picture in it
        //   hydrate      the pictures come back and the list grows underneath
        //
        // Two things go wrong there, and the second is the nasty one. The offsets
        // are measured against the wrong layout; AND the shortened content lowers
        // the box's maximum scrollTop, so the corrective write is CLAMPED and
        // cannot reach the right position even in principle. The error scales with
        // how many previews the conversation has.
        //
        // Hydrating first costs nothing and fixes both: a warm preview is already
        // complete in the memory cache, so assigning its src gives the element its
        // real height in this same synchronous block (measured: 0px before the
        // src, 320px immediately after, img.complete true). The anchor then
        // measures the heights the reader actually had.
        hydrateMessageImagePreviews();
        restoreScrollAnchor(anchor);
    }

    function refreshMessageBubble(idx) {
        if (idx < 0 || idx >= CS.messages.length) return;
        var oldEl = CS.messageEls[idx];
        // No node means the message is folded into a collapsed indexing row; its
        // text is not on screen, so there is nothing to patch.
        if (!oldEl || !oldEl.parentNode) return;
        // Bracketed, like renderMessages: this swaps ONE bubble for a taller or
        // shorter one, and when that bubble is above the viewport (a chip
        // re-parsed unavailable, a settled turn growing its timestamp) everything
        // below it slides. renderMessages anchors because it tears the list down;
        // this anchors because the replacement changes a height in place.
        anchorWroteSinceScroll = true;
        chatScrollAnchor.preserve(function () {
            var newEl = buildMessageEl(CS.messages[idx], idx);
            if (oldEl.classList.contains("bq-index-pass")) newEl.classList.add("bq-index-pass");
            oldEl.parentNode.replaceChild(newEl, oldEl);
            CS.messageEls[idx] = newEl;
            // INSIDE the bracket, for the same reason as renderMessages: preserve()
            // measures the moment this callback returns, and a freshly built bubble's
            // previews are src-less (0px) until hydration gives them one back.
            hydrateMessageImagePreviews();
        });
    }

    function renderChat() {
        // reset transient chat state on (re)entry
        // Preview urls are keyed by project, and an identity-blind cache is how
        // one project's content has reached another project's chat before.
        clearImagePreviewCache(S.projectId || "default");
        // The reader's place belongs to the conversation that is going away.
        chatScrollAnchor.forget();
        // Same reason, and the same blast radius: a "this file has no url" mark
        // is keyed by a project-relative storage path.
        for (var uk in unavailableLinkMap) delete unavailableLinkMap[uk];
        CS.messages = []; CS.messageEls = []; CS.indexGroupsOpen = {}; CS.sending = false; CS.typing = false; CS.typingAbort = true;
        CS.drafting = false; CS.draftingEl = null;
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
                "aria-label": "Settings",
                html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
                onclick: function () { toggleChatSettings(); } });
            CS.settingsBtnEl = settingsBtn;

            // Landing-style brand header (brandTitleEl, shared with the
            // logged-out pages) with the gear (settings) on the right.
            var header = h("div", { class: "bq-section-title" },
                h("div", { class: "bq-title-row" },
                    brandTitleEl(),
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
            // Any image inside the list finishing (or failing) is a height change
            // nobody asked for, and for a reader scrolled up into history it is a
            // jump mid-sentence. Delegated and in the CAPTURE phase because `load`
            // does not bubble; on the box rather than per element because this has
            // to cover the images the preview machinery never sees - a markdown
            // `![alt](url)` the model wrote is a plain <img> with a live src, with
            // no state attribute, no hydration and no hook of its own.
            box.addEventListener("load", onMessagesImageSettled, true);
            box.addEventListener("error", onMessagesImageSettled, true);
            // A late web font re-wraps every bubble at once, with no DOM mutation
            // and no event any other hook is bound to - and with native scroll
            // anchoring off (see .bq-messages in widget.css) nothing else would
            // absorb it. "loadingdone", not document.fonts.ready: ready resolves
            // once and misses every later arrival.
            if (document.fonts && document.fonts.addEventListener) {
                document.fonts.addEventListener("loadingdone", onMessagesFontsSettled);
            }
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
                // Always refresh the controls: Send enables/disables as the text
                // crosses the empty line even when the warning did not change.
                updateComposerControls();
                if (CS.attachmentWarning !== prev) { renderAttachmentChips(); scheduleAttachmentOverflowRecompute(); }
                // Show/hide the user-side "typing" bubble as the text crosses the
                // empty line, keeping a bottom-pinned reader pinned.
                var drafting = !!input.value.trim();
                if (drafting !== CS.drafting) {
                    CS.drafting = drafting;
                    syncDraftingIndicator();
                    scrollToBottomIfSticky(false);
                }
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
            // Fresh composer, empty input, no chips: Send starts disabled.
            updateComposerControls();
            if (!attachDisabled) setupDragAndDrop(chatArea);
            return h("div", { class: "bq-meta" }, header, chatArea);
        });

        if (S.aiPlatform === "none") return;
        // Durable index markers, in parallel with the history fetch: run::
        // stubs let indexing rows paint before any bg history arrives.
        void refreshIndexMarkers();
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
        // Honor the project's context-window override (third segment of
        // `ai_agent`, set by the owner in the dashboard's project settings).
        // The widget has no settings surface of its own: its users are site
        // visitors, not project owners, so it applies the setting rather than
        // offering a control. Without an override the engine keeps its fixed
        // ceilings, so this is a no-op for every project that has not set one.
        setProjectContextWindow(S.projectId, engineParseAiAgentValue(raw).contextWindow);
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
            // Single-item csr-poll point lookup: how the engine hydrates a
            // compact history stub's real body when an indexing row expands.
            csrHistoryItemLookup: function (fullId, service, owner) {
                return S.skapi.util.request('csr-poll', { id: fullId, service: service, owner: owner }, { auth: true });
            },
            // Durable index markers. Both read S lazily at call time — S.skapi /
            // S.projectId are not set yet when init() runs.
            mintIndexDoneMarker: function (info) {
                void mintIndexDoneMarkerDb(info.service, info.storagePath);
            },
            upsertIndexRunRecord: function (info) {
                void upsertIndexRunRecordDb(info.service, info.storagePath, info.patch);
            },
            mcpBaseUrl: mcpBaseUrl(),
            poll: 0,
            // Server-driven windowed indexing. Off by default in the engine because the
            // worker must strip `_skapi_window` first, or the provider rejects the whole
            // call with no retry. `apply_file_windows` is deployed in every region
            // (verified 2026-07-27 against the deployed ClientSecretKeyPollingWorker in
            // all 7), so the widget now opts in like agent.vue does. Without it the
            // widget fell back to the client-driven CONTINUE loop capped at
            // MAX_INDEXING_RESUME_PASSES, which needs the tab kept open and stops early
            // on a big file. Pass windowedIndexing: false in init opts to opt back out.
            windowedIndexing: S.opts.windowedIndexing !== false,
            // Client-side attachment parsers (e.g. an .hwp parser) passed via init opts.
            attachmentParsers: S.opts.attachmentParsers || undefined,
        });

        // Recompute the attachment "...(x) more" overflow when the viewport
        // changes (no-op when the chat/attachments aren't mounted).
        if (!S._resizeBound && typeof window !== "undefined" && window.addEventListener) {
            S._resizeBound = true;
            window.addEventListener("resize", function () {
                scheduleAttachmentOverflowRecompute();
                // The box changed height without re-rendering, so nothing has put a
                // reader who was pinned to the bottom back there — on mobile the
                // on-screen keyboard opening pushes the newest reply below the fold
                // and leaves it there. scrollToBottomIfSticky bails on its own if
                // they had scrolled away. (agent.vue does this in
                // applyAgentViewportHeight.)
                scrollToBottomIfSticky(false);
                // And a TALLER box can stop overflowing, which takes the
                // scroll-to-top pager trigger away with it. The chat reaches that
                // state easily: a page of indexing turns collapses to one ~40px row.
                ensureHistoryFillsViewport();
            });
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
                    // Nothing here touches the scroll, and that is the point: the
                    // reader was never moved while they were away, because
                    // compensation runs whether or not the tab is visible.
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
