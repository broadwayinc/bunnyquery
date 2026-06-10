/* ============================================================================
 * BunnyChat — embeddable AI chat widget for Skapi-powered projects.
 *
 * Standalone IIFE exposing `window.BunnyChat`. Vanilla-JS port of the bunnyquery
 * (www.skapi.com) agent.vue chatbox + account/auth views.
 *
 * Usage:
 *   <link rel="stylesheet" href="bunnychat.css">
 *   <script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
 *   <script src="bunnychat.js"></script>
 *   <script>
 *     const skapi = new Skapi("<service_id>", { autoLogin: true }, { hostDomain, target_cdn });
 *     BunnyChat.init(skapi, "chatbox", { theme: "light", signup: true });
 *   </script>
 *
 * Build order in this file:
 *   1. Constants            6. View manager
 *   2. Utilities            7. OAuth (MCP + Google)
 *   3. State                8. Views (login/signup/.../chat)  [later phases]
 *   4. Theme                9. AI agent + chat engine          [later phases]
 *   5. skapi helpers       10. Public init() + boot
 * ==========================================================================*/
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
        theme: "light",
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
        var stored = lsGet(skey(SK.theme));
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
        lsSet(skey(SK.theme), S.theme);
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
                console.log({conn})
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

    function showLoading(label) {
        render("loading", function () {
            return h("div", { class: "bq-auth" },
                h("div", { class: "bq-disabled-inner", style: { marginTop: "3rem" } },
                    h("span", { class: "bq-loader", text: label || "Loading" })
                )
            );
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
    // so the browser returns here and BunnyChat.init() re-runs + completes.
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
            client_name: "bunnychat",
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
            window.location.href = mcpBaseUrl() + "/oauth/authorize?" + params.toString();
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
        window.location.href = url;
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
    // bunnychat then acts as the identity provider: it packages the skapi
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
                window.location.href = genOAuthCallbackUrl(state, session, params);
                return;
            }
            if (waited >= 3000) {
                console.error("[bunnychat] OAuth bounce aborted: no skapi session.");
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
            h("div", { class: "bq-auth-top" },
                h("span", { class: "bq-auth-logo", text: "₍ᐢ•⩊•ᐢ₎ bunnychat" }),
                themeToggleButton()
            ),
            title ? h("h1", { class: "bq-auth-title", text: title }) : null,
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
                            console.error("[bunnychat] MCP OAuth bootstrap failed", err);
                            enterAfterLogin(); // MCP down — chat still works off skapi JWT
                        });
                    })
                    .catch(function (err) {
                        setBusy(false);
                        setError(loginErrorMessage(err));
                        if (err && err.code === "SIGNUP_CONFIRMATION_NEEDED") {
                            renderSignupConfirmation(emailInput.value);
                        }
                    });
            }

            var actions = h("div", { class: "bq-actions" });
            if (S.opts.signup) {
                actions.appendChild(h("button", { class: "bq-link", type: "button",
                    onclick: function () { renderForgotPassword(emailInput.value); }, text: "Forgot password?" }));
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

            return h("div", { class: "bq-auth" }, children);
        });
    }

    // Shared auth-view shell: header + optional "back to login" link.
    function authShell(title, children, opts) {
        opts = opts || {};
        var kids = authHeader(title).concat(children);
        if (opts.back !== false) {
            kids.push(h("div", { class: "bq-actions", style: { marginTop: "1.5rem" } },
                h("button", { class: "bq-link", type: "button",
                    onclick: function () { renderLogin(opts.backPrefill); },
                    text: "← Back to login" })));
        }
        return h("div", { class: "bq-auth" }, kids);
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
                h("label", { class: "bq-checkbox" }, subscribe, h("span", { text: "Send me product updates" })),
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
                h("p", { class: "bq-auth-sub" },
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
            ], { back: false });
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

    function renderChat() {
        // Placeholder shell until the chat-engine phase lands. The header,
        // read-only agent badge, theme toggle and logout are already wired.
        render("chat", function () {
            return h("div", { class: "bq-meta" },
                h("div", { class: "bq-section-title" },
                    h("div", { class: "bq-title-row" },
                        h("div", { class: "bq-title-left" },
                            h("span", { class: "bq-agent-badge", text: agentBadgeText() })
                        ),
                        h("div", { class: "bq-title-right" },
                            themeToggleButton(),
                            h("button", { class: "bq-icon-btn", type: "button", title: "Log out",
                                html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
                                onclick: function () { logout(); } })
                        )
                    )
                ),
                h("div", { class: "bq-chat" },
                    S.aiPlatform === "none"
                        ? h("div", { class: "bq-disabled-overlay" },
                            h("div", { class: "bq-disabled-inner" },
                                h("div", { text: "This chat isn't available yet — the project admin hasn't set up an AI agent." })
                            )
                        )
                        : h("div", { class: "bq-messages" },
                            h("div", { class: "bq-message is-assistant bq-empty-greeting" },
                                h("div", { class: "bq-bubble", text: "Chat engine wiring lands in the next build phase." })
                            )
                        )
                )
            );
        });
    }

    function agentBadgeText() {
        if (S.aiPlatform === "none") return "No agent configured";
        var plat = S.aiPlatform === "claude" ? "Claude" : "OpenAI";
        return S.aiModel ? plat + " · " + S.aiModel : plat;
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
        var conn = S.service || {};
        // getConnectionInfo() may surface ai_agent at the top level or nested
        // under service/info depending on skapi-js version — probe each.
        var raw =
            conn.ai_agent ||
            (conn.service && conn.service.ai_agent) ||
            (conn.info && conn.info.ai_agent) ||
            (conn.service && conn.service.info && conn.service.info.ai_agent) ||
            "";
        var parsed = parseAiAgentValue(raw);
        S.aiPlatform = parsed.platform;
        S.aiModel = parsed.model;
    }

    /* ========================================================================
     * 11. LOGOUT + POST-LOGIN ENTRY
     * ======================================================================*/

    function logout() {
        showLoading("Signing out");
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
        showLoading("Loading");
        return loadServiceInfo()
            .then(function (conn) { S.service = conn; applyAgentConfig(); })
            .then(function () { renderChat(); })
            .catch(function (err) {
                console.error("[bunnychat] enterAfterLogin failed", err);
                renderChat();
            });
    }

    /* ========================================================================
     * 12. BOOT
     * ======================================================================*/

    function boot() {
        showLoading("Loading");

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
                    console.error("[bunnychat] Google OAuth return failed", err);
                    cleanUrl();
                    renderLogin();
                });
        }

        // 2. Returning from the MCP /oauth/authorize redirect?
        if (isMcpOAuthCallback()) {
            return completeMcpAuthorize()
                .then(function () { cleanUrl(); return enterAfterLogin(); })
                .catch(function (err) {
                    console.error("[bunnychat] MCP OAuth token exchange failed", err);
                    cleanUrl();
                    return enterAfterLogin(); // chat still works off skapi JWT
                });
        }

        // 3. Normal boot — check for an existing (auto-login) session.
        return getProfile().then(function (user) {
            S.user = user;
            if (!user) {
                renderLogin();
                return;
            }
            if (mcpGrantNeedsRefresh(user)) {
                return beginMcpOAuthOnLogin("chat").catch(function (err) {
                    console.error("[bunnychat] MCP refresh failed", err);
                    return enterAfterLogin();
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
            console.warn("[bunnychat] already initialised");
            return PUBLIC;
        }
        if (!skapi) throw new Error("BunnyChat.init: a Skapi instance is required");

        var mountEl = typeof target === "string" ? document.getElementById(target) : target;
        if (!mountEl) throw new Error("BunnyChat.init: mount element not found: " + target);

        S.skapi = skapi;
        S.opts = Object.assign({
            theme: "light",
            signup: true,        // include signup (and thus delete/recover account)
            dev: false,          // use the MCP dev host (mcp-dev.broadwayinc.computer)
            mcpBaseUrl: null,    // override the MCP OAuth server base entirely
            googleClientId: null,
            googleClientSecretName: "ggl",
            signupConfirmationUrl: null, // defaults to current host page
        }, opts || {});
        S.mountEl = mountEl;

        // Build our owned root inside the host element.
        clear(mountEl);
        S.root = h("div", { class: "bq-agent" });
        mountEl.appendChild(S.root);

        applyTheme(loadTheme());
        S.booted = true;

        boot();
        return PUBLIC;
    }

    var PUBLIC = {
        init: init,
        setTheme: function (t) { applyTheme(t); },
        toggleTheme: toggleTheme,
        logout: logout,
        version: "0.1.0",
        _state: S, // exposed for later-phase modules / debugging
    };

    if (typeof window !== "undefined") {
        window.BunnyChat = PUBLIC;
    }
})();
