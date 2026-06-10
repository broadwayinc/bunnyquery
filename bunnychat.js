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
                console.log("[bunnychat] loadServiceInfo", conn)
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

    // ---- budgeting constants (from agent.vue) ----------------------------
    var CONTEXT_WINDOW_DEFAULT = { claude: 200000, openai: 128000 };
    var CONTEXT_WINDOW_BY_MODEL = {
        "claude-opus-4-7": 200000, "claude-sonnet-4": 200000, "gpt-5.4": 128000,
    };
    var OUTPUT_TOKEN_RESERVE = 22000;
    var TOOL_AND_RESPONSE_BUFFER = 4000;
    var MIN_INPUT_TOKEN_BUDGET = 8000;
    var CLAUDE_PER_REQUEST_INPUT_CAP = 28000;
    var MAX_HISTORY_MESSAGES = 20;
    var HISTORY_TOKEN_BUDGET = 8000;

    // ---- link/file render constants (from agent.vue) ---------------------
    var EXPIRED_ATTACHMENT_URL_HOST = "_expired_.url";
    var EXPIRED_ATTACHMENT_URL_ORIGIN = "https://" + EXPIRED_ATTACHMENT_URL_HOST;
    var LINK_LABEL_MAX_DISPLAY_CHARS = 32;

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

    function hostDomain() { return S.opts.hostDomain || "skapi.com"; }
    function getHistoryCacheKey() {
        if (!S.serviceId || S.aiPlatform === "none") return "";
        return S.serviceId + "#" + S.aiPlatform;
    }
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
    function getErrorMessage(input) {
        if (!input) return "Something went wrong.";
        if (typeof input === "string") return input;
        if (input.error && input.error.message) return input.error.message;
        if (input.body && input.body.error && input.body.error.message) return input.body.error.message;
        if (input.body && typeof input.body.message === "string") return input.body.message;
        if (input.message) return input.message;
        return "Something went wrong.";
    }

    /* ---- AI request layer (ai_agent.ts) ---------------------------------- */
    function transformContentWithImages(content) {
        if (typeof content !== "string" || !content) return content;
        var matches = content.match(IMAGE_URL_REGEX);
        if (!matches || !matches.length) return content;
        var seen = {}, blocks = [];
        matches.forEach(function (url) {
            if (seen[url]) return; seen[url] = 1;
            blocks.push({ type: "image", source: { type: "url", url: url } });
        });
        return blocks.concat([{ type: "text", text: content }]);
    }
    function transformContentWithOpenAIImages(content, detail) {
        detail = detail || DEFAULT_OPENAI_IMAGE_DETAIL;
        if (typeof content !== "string" || !content) return content;
        var matches = content.match(IMAGE_URL_REGEX);
        if (!matches || !matches.length) return content;
        var seen = {}, blocks = [];
        matches.forEach(function (url) {
            if (seen[url]) return; seen[url] = 1;
            blocks.push({ type: "input_image", image_url: url, detail: detail });
        });
        return [{ type: "input_text", text: content }].concat(blocks);
    }
    function getOpenAIImageDetail(model) {
        var normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
        var m = normalized.match(/^gpt-(\d+)(?:\.(\d+))?$/);
        if (!m) return DEFAULT_OPENAI_IMAGE_DETAIL;
        var major = Number(m[1]); var minor = m[2] === undefined ? null : Number(m[2]);
        if (major > 5) return "original";
        if (major === 5 && minor !== null && minor >= 4) return "original";
        return DEFAULT_OPENAI_IMAGE_DETAIL;
    }
    function prepareClaudeMessages(messages) {
        if (!messages.length) return messages;
        var li = messages.length - 1, last = messages[li];
        if (last.role !== "user") return messages;
        var content = transformContentWithImages(last.content);
        if (content === last.content) return messages;
        var next = messages.slice();
        next[li] = { role: last.role, content: content };
        return next;
    }
    function prepareOpenAIMessages(messages, detail) {
        if (!messages.length) return messages;
        var li = messages.length - 1, last = messages[li];
        if (last.role !== "user") return messages;
        var content = transformContentWithOpenAIImages(last.content, detail);
        if (content === last.content) return messages;
        var next = messages.slice();
        next[li] = { role: last.role, content: content };
        return next;
    }
    function applyHistoryCacheBreakpoint(messages) {
        if (messages.length < 2) return messages;
        var bp = messages.length - 2;
        return messages.map(function (m, i) {
            if (i !== bp) return m;
            var blocks = Array.isArray(m.content) ? m.content.slice() : [{ type: "text", text: m.content }];
            if (!blocks.length) return m;
            var lb = blocks.length - 1;
            blocks[lb] = Object.assign({}, blocks[lb], { cache_control: { type: "ephemeral" } });
            return Object.assign({}, m, { content: blocks });
        });
    }
    function callClaudeWithPublicMcp(prompt, service, owner, messages, system, model, userId) {
        var mcpDef = { type: "url", name: MCP_NAME, url: mcpBaseUrl(), authorization_token: "$ACCESS_TOKEN" };
        var preparedMessages = (messages && messages.length)
            ? prepareClaudeMessages(messages)
            : [{ role: "user", content: transformContentWithImages(prompt) }];
        var data = {
            model: model || DEFAULT_CLAUDE_MODEL,
            max_tokens: MAX_TOKENS,
            messages: applyHistoryCacheBreakpoint(preparedMessages),
            mcp_servers: [mcpDef],
            tools: [
                { type: "mcp_toolset", mcp_server_name: MCP_NAME },
                { type: "web_fetch_20250910", name: "web_fetch", max_uses: WEB_FETCH_MAX_USES,
                  citations: { enabled: true }, max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS },
            ],
        };
        if (system) {
            data.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
        }
        return S.skapi.clientSecretRequest({
            clientSecretName: "claude", queue: userId || service, service: service, owner: owner,
            poll: POLL_INTERVAL, // let skapi run the poll loop and resolve with the final body
            url: ANTHROPIC_MESSAGES_API_URL, method: "POST",
            headers: {
                "content-type": "application/json", "x-api-key": "$CLIENT_SECRET",
                "anthropic-version": ANTHROPIC_VERSION, "anthropic-beta": ANTHROPIC_BETA_HEADER,
            },
            data: data,
        });
    }
    function callOpenAIWithPublicMcp(prompt, service, owner, messages, system, model, userId) {
        var resolvedModel = model || DEFAULT_OPENAI_MODEL;
        var imageDetail = getOpenAIImageDetail(resolvedModel);
        var messageList = (messages && messages.length)
            ? prepareOpenAIMessages(messages, imageDetail)
            : [{ role: "user", content: transformContentWithOpenAIImages(prompt, imageDetail) }];
        var input = (system ? [{ role: "system", content: system }] : []).concat(
            messageList.map(function (m) { return { role: m.role, content: m.content }; })
        );
        var tools = [
            { type: "mcp", server_label: MCP_NAME, server_url: mcpBaseUrl(),
              require_approval: "never", headers: { Authorization: "Bearer $ACCESS_TOKEN" } },
        ];
        if (OPENAI_WEB_SEARCH_ENABLED) {
            tools.push({ type: "web_search", external_web_access: OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS });
        }
        return S.skapi.clientSecretRequest({
            clientSecretName: "openai", queue: userId || service, service: service, owner: owner,
            poll: POLL_INTERVAL, // let skapi run the poll loop and resolve with the final body
            url: OPENAI_RESPONSES_API_URL, method: "POST",
            headers: { "content-type": "application/json", Authorization: "Bearer $CLIENT_SECRET" },
            data: { model: resolvedModel, max_output_tokens: MAX_TOKENS, input: input, tools: tools },
        });
    }
    function extractClaudeText(response) {
        if (!response || !Array.isArray(response.content)) return "";
        return response.content
            .filter(function (b) { return b && b.type === "text"; })
            .map(function (b) { return b.text; })
            .join("\n");
    }
    function extractOpenAIText(response) {
        if (response && typeof response.output_text === "string" && response.output_text.length) {
            return response.output_text;
        }
        if (response && Array.isArray(response.output)) {
            var text = response.output
                .reduce(function (acc, item) { return acc.concat((item && item.content) || []); }, [])
                .filter(function (p) { return p && p.type === "output_text"; })
                .map(function (p) { return p.text || ""; })
                .join("\n").trim();
            if (text) return text;
        }
        var content = response && response.choices && response.choices[0] &&
            response.choices[0].message && response.choices[0].message.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map(function (p) {
                if (typeof p === "string") return p;
                if (p && p.type === "text") return p.text || "";
                return "";
            }).join("\n");
        }
        return "";
    }
    function getChatHistory(params, fetchOptions) {
        var url = params.platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
        var p = Object.assign({ url: url, method: "POST" }, { service: params.service, owner: params.owner },
            params.queue ? { queue: params.queue } : {});
        return S.skapi.clientSecretRequestHistory(p, Object.assign({ ascending: false }, fetchOptions));
    }

    /* ---- error detection + session refresh (agent.vue) ------------------- */
    function isErrorResponseBody(response) {
        if (!response || typeof response !== "object") return false;
        if (typeof response.status_code === "number" && response.status_code >= 400) return true;
        if (response.type === "error") return true;
        if (response.error && (response.error.message || response.error.type)) return true;
        var body = response.body;
        if (body && typeof body === "object") {
            if (body.type === "error") return true;
            if (body.error && (body.error.message || body.error.type)) return true;
        }
        if (typeof response.message === "string" && response.message.length) {
            var hasClaude = Array.isArray(response.content);
            var hasOpenAI = typeof response.output_text === "string" ||
                Array.isArray(response.output) || Array.isArray(response.choices);
            if (!hasClaude && !hasOpenAI) return true;
        }
        return false;
    }
    function isAuthExpiredError(input) {
        if (!input) return false;
        var blobs = [];
        var push = function (v) { if (typeof v === "string" && v) blobs.push(v); };
        if (typeof input === "string") push(input);
        else {
            push(input.message); push(input.code);
            if (input.error) { push(input.error.message); push(input.error.code); push(input.error.type); }
            if (input.body) {
                push(input.body.message);
                if (input.body.error) { push(input.body.error.message); push(input.body.error.code); push(input.body.error.type); }
            }
            if (typeof input.status === "number" && input.status === 401) return true;
            if (typeof input.status_code === "number" && input.status_code === 401) return true;
        }
        var hay = blobs.join(" | ").toLowerCase();
        if (!hay) return false;
        return hay.indexOf("token has expired") !== -1 || hay.indexOf("token is expired") !== -1 ||
            hay.indexOf("expired_token") !== -1 || hay.indexOf("invalid_token") !== -1 ||
            hay.indexOf("unauthorized") !== -1 || hay.indexOf("not authorized") !== -1 ||
            (hay.indexOf("invalid_request") !== -1 && hay.indexOf("token") !== -1);
    }

    /* ---- token budgeting (agent.vue) ------------------------------------- */
    function estimateTextTokens(text) { return Math.ceil((text || "").length / 3); }
    function estimateMessageTokens(msg) {
        return estimateTextTokens(msg.content) + estimateTextTokens(msg.role) + 6;
    }
    function getContextWindow(platform, model) {
        var normalized = (model || "").trim().toLowerCase();
        if (normalized && CONTEXT_WINDOW_BY_MODEL[normalized]) return CONTEXT_WINDOW_BY_MODEL[normalized];
        return CONTEXT_WINDOW_DEFAULT[platform];
    }
    function stripFileBlocksFromHistory(content) {
        if (!content) return content;
        return content.replace(/```([\w.-]+\.[a-zA-Z0-9]+)\n[\s\S]*?```/g, "[file previously attached: $1]");
    }
    function buildBoundedChatMessages(options) {
        var contextWindow = getContextWindow(options.platform, options.model);
        var contextBasedBudget = Math.max(MIN_INPUT_TOKEN_BUDGET,
            contextWindow - OUTPUT_TOKEN_RESERVE - TOOL_AND_RESPONSE_BUFFER);
        var availableInputBudget = options.platform === "claude"
            ? Math.min(contextBasedBudget, CLAUDE_PER_REQUEST_INPUT_CAP) : contextBasedBudget;
        var systemCost = estimateTextTokens(options.systemPrompt) + 12;
        var budgetForHistory = Math.max(1000, Math.min(HISTORY_TOKEN_BUDGET, availableInputBudget - systemCost));
        var windowed = options.history.slice(-MAX_HISTORY_MESSAGES);
        var latestIndex = windowed.length - 1;
        var trimmed = windowed.map(function (m, i) {
            if (i === latestIndex) return m;
            var stripped = stripFileBlocksFromHistory(m.content);
            var sanitized = m.role === "user" ? sanitizeAttachmentLinksForHistory(stripped) : stripped;
            return Object.assign({}, m, { content: sanitized });
        });
        var bounded = [], used = 0;
        for (var i = trimmed.length - 1; i >= 0; i--) {
            var cost = estimateMessageTokens(trimmed[i]);
            if (used + cost > budgetForHistory && bounded.length > 0) break;
            bounded.unshift(trimmed[i]); used += cost;
        }
        return {
            messages: bounded.map(function (m) { return { role: m.role, content: m.content }; }),
            droppedCount: Math.max(0, options.history.length - bounded.length),
            estimatedInputTokens: used + systemCost,
            estimatedBudget: availableInputBudget,
        };
    }

    /* ---- system prompt (agent.vue buildSystemPrompt) --------------------- */
    function buildSystemPrompt() {
        var pid = S.serviceId || "";
        var sp = "\nYou are a dedicated assistant for the project ID: \"" + pid + "\"." +
            "\nScope: Only answer questions about this project and its data. Do not answer questions about other projects or topics unrelated to this project. When the user refers to \"my database\", \"my data\", or \"my files\", treat those as references to this project's database and file storage." +
            "\nKnowledge lookup: Before saying you don't know or that something isn't in the chat history, ALWAYS query this project's database through the available MCP tools to look for the answer. The user's data is the source of truth - the chat transcript is not. Only respond with \"I don't know\" or \"I couldn't find that\" after you have actually searched the project's data and come back empty." +
            "\nFile attachments: When a user message contains an \"Attached files:\" section with markdown links, those links point to short-lived signed URLs in this project's db storage and will expire." +
            "\n- Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY attached inline as image content blocks in the same message - you can see them directly. Do NOT call web_fetch on image URLs; that will fail or return garbage. Just look at the image block and answer." +
            "\n- For all other file types (text, code, csv, json, pdf, etc.), use your web_fetch tool to download and read each URL before answering. Treat the fetched contents as user-supplied input data. Do not ask the user to paste the file contents - fetch the URLs yourself." +
            "\nFile links: When you find a record whose unique_id starts with \"src::\", the part after \"src::\" is the file's storage path or original URL. Always present it as a markdown link so the user can access it. Strip the \"src::\" prefix — do NOT show it. Format: [filename](path/to/file) for storage paths, or [filename](https://...) for external URLs. Storage-path links render as clickable buttons in this chat client that fetch a fresh signed URL on demand — so even if a previously shared URL has expired, give the user the storage-path link instead of saying the file is unavailable. Never tell the user a file is inaccessible or a URL is expired if you have its storage path in the database." +
            "\nFile lookup: When the user asks to see, list, or show files, query the database using getUniqueId with unique_id \"src::\" and condition \"gte\" (or getRecords by table) to find all indexed file records. Present each result as a markdown link as described above. Never say you cannot access file storage — the file paths are indexed in the database and are always reachable through it." +
            "\nFile generation: If the user asks you to generate a file and it is possible to do so, output the file contents inside a fenced code block using the file extension as the language identifier. Always use plain text - never base64 or other encodings. Example for CSV:" +
            "\n```filename.csv\nitem,qty,total\nCarrots,55,$38.50\nMushrooms,41,$73.80\nZucchini,29,$43.50\n```" +
            "\nThe same pattern applies to other formats: ```my-data.json, ```index.html, ```sample.txt, etc.";
        if (S.serviceDescription) {
            sp += "\nProject name: \"" + (S.serviceName || "") + "\"\nProject description: \"\"\"" + S.serviceDescription + "\"\"\"";
        }
        return sp;
    }

    function refreshSkapiSession() {
        return S.skapi.getProfile({ refreshToken: true }).then(function () { return true; })
            .catch(function () { return false; });
    }

    /* ---- send / dispatch / queue ----------------------------------------- */
    function callProviderFor(platform, prompt, messages, system, model, userId) {
        return platform === "openai"
            ? callOpenAIWithPublicMcp(prompt, S.serviceId, S.owner, messages, system, model, userId)
            : callClaudeWithPublicMcp(prompt, S.serviceId, S.owner, messages, system, model, userId);
    }

    function dispatchAgentRequest(params) {
        var sendAndPoll = function () {
            return Promise.resolve(
                callProviderFor(params.aiPlatform, params.text, params.boundedMessages, params.systemPrompt, params.aiModel, params.userId)
            ).then(function (initial) {
                // Belt-and-suspenders: the builders pass `poll`, so skapi already
                // resolves with the final body. If a build ever returns a raw ack,
                // fall back to the manual poll.
                if (initial && initial.poll && (initial.status === "pending" || initial.status === "running")) {
                    return initial.poll({ latency: POLL_INTERVAL });
                }
                return initial;
            });
        };
        var run = sendAndPoll()
            .catch(function (err) {
                if (isAuthExpiredError(err)) return refreshSkapiSession().then(sendAndPoll);
                throw err;
            })
            .then(function (response) {
                if (isErrorResponseBody(response) && isAuthExpiredError(response)) {
                    return refreshSkapiSession().then(sendAndPoll);
                }
                return response;
            })
            .then(function (response) {
                if (isErrorResponseBody(response)) return { content: getErrorMessage(response), isError: true };
                var answer = (params.aiPlatform === "openai" ? extractOpenAIText(response) : extractClaudeText(response));
                answer = (answer || "").trim();
                return { content: answer || "No text response received from AI provider.", isError: false };
            })
            .catch(function (err) { return { content: getErrorMessage(err), isError: true }; })
            .then(function (result) { delete pendingAgentRequests[params.key]; return result; });
        pendingAgentRequests[params.key] = run;
        return run;
    }

    function sendMessage() {
        var inputEl = CS.messagesBox && CS.messagesBox.parentNode &&
            CS.messagesBox.parentNode.querySelector(".bq-input");
        var text = (inputEl ? inputEl.value : "").trim();
        if (!text) return;
        if (!chatEnabled() || S.aiPlatform === "none") return;

        var isQueuedSend = CS.sending || CS.messages.some(function (m) {
            return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue;
        });

        var composed = text;
        var aiPlatform = S.aiPlatform;
        var aiModel = S.aiModel || undefined;
        var systemPrompt = buildSystemPrompt();
        var userId = (S.user && S.user.user_id) || S.serviceId;
        var chatQueue = userId; // no bg indexing tasks in core chat yet

        if (inputEl) { inputEl.value = ""; autoGrowInput(inputEl); }

        if (isQueuedSend) {
            var resolvedHistory = CS.messages.filter(function (m) {
                return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder &&
                    !m.isCancelled && !m.isBackgroundTask;
            });
            var boundedQ = buildBoundedChatMessages({
                platform: aiPlatform, model: aiModel, systemPrompt: systemPrompt,
                history: resolvedHistory.concat([{ role: "user", content: composed }]),
            });
            // skapi auto-polls (poll param), so there's no early ack / _serverItemId.
            // Track the queued bubble purely locally: it shows "(In queue)" until the
            // request ahead of it finishes (promoteNextQueuedToRunning then turns it
            // white + Thinking), and its own auto-poll resolves it to the answer.
            CS.messages.push({ role: "user", content: composed, isPendingQueued: true });
            renderMessages(); updateHistoryCache(); scrollToBottom(true);

            var capturedComposed = composed, capturedPlatform = aiPlatform;
            Promise.resolve(callProviderFor(aiPlatform, composed, boundedQ.messages, systemPrompt, aiModel, chatQueue))
                .then(function (result) { return onQueuedSendResponse(capturedComposed, result, capturedPlatform); })
                .catch(function (err) { return onQueuedSendError(capturedComposed, err); });
            return;
        }

        // immediate send
        var lid = newLocalId();
        CS.messages.push({ role: "user", content: composed });
        CS.messages.push({ role: "assistant", content: "", isPending: true, isPendingInProcess: true, _localId: lid });
        renderMessages(); updateHistoryCache(); CS.sending = true; scrollToBottom(true);

        var key = getHistoryCacheKey();
        var bounded = buildBoundedChatMessages({
            platform: aiPlatform, model: aiModel, systemPrompt: systemPrompt,
            history: CS.messages.filter(function (m) { return !m.isCancelled && !m.isBackgroundTask; }),
        });
        var requestToken = CS.gateRefreshToken;
        dispatchAgentRequest({
            key: key, serviceId: S.serviceId, owner: S.owner, aiPlatform: aiPlatform, aiModel: aiModel,
            systemPrompt: systemPrompt, text: composed, boundedMessages: bounded.messages, userId: chatQueue,
        }).then(function (result) {
            if (requestToken !== CS.gateRefreshToken || getHistoryCacheKey() !== key) return;
            var idx = CS.messages.findIndex(function (m) { return m._localId === lid; });
            if (idx === -1) return;
            if (result.isError) {
                CS.messages[idx] = { role: "assistant", content: result.content, isError: true };
                renderMessages();
            } else {
                CS.messages[idx] = { role: "assistant", content: "", _localId: lid };
                renderMessages();
                enqueueTypewrite(idx, result.content, lid);
            }
            updateHistoryCache();
        }).finally(function () {
            if (requestToken === CS.gateRefreshToken && getHistoryCacheKey() === key) {
                CS.sending = false;
                // Advance the queue display: turn the next "(In queue)" bubble
                // white + Thinking now that this request has finished.
                promoteNextQueuedToRunning();
            }
        });
    }

    // queue resolution helpers (agent.vue)
    function promoteNextBgQueuedToRunning() { /* bg tasks land in the attachments phase */ }
    function promoteNextQueuedToRunning() {
        if (CS.messages.some(function (m) { return m.isPending && m.role === "assistant" && !m.isBackgroundTask; })) return;
        var nextIdx = CS.messages.findIndex(function (m) {
            return m.isPendingQueued && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue;
        });
        if (nextIdx === -1) return;
        var existing = CS.messages[nextIdx];
        var promoted = { role: "user", content: existing.content, isPendingInProcess: true };
        if (existing.isBackgroundTask) promoted.isBackgroundTask = true;
        if (existing._serverItemId !== undefined) promoted._serverItemId = existing._serverItemId;
        if (existing.isSendingToServer) promoted.isSendingToServer = true;
        CS.messages[nextIdx] = promoted;
        CS.messages.splice(nextIdx + 1, 0, { role: "assistant", content: "", isPending: true });
        renderMessages();
    }
    function resolveQueuedUserBubble(serverId) {
        var userIdx = -1;
        if (serverId) {
            userIdx = CS.messages.findIndex(function (m) {
                return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) &&
                    m.role === "user" && !m.isBackgroundTask;
            });
        }
        if (userIdx === -1) {
            userIdx = CS.messages.findIndex(function (m) {
                return m.isPendingInProcess && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue;
            });
        }
        if (userIdx === -1) {
            userIdx = CS.messages.findIndex(function (m) {
                return m.isPendingQueued && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue;
            });
        }
        if (serverId && cancelledServerIds.has(serverId)) {
            cancelledServerIds.delete(serverId);
            if (userIdx >= 0) {
                var ex = CS.messages[userIdx];
                CS.messages[userIdx] = { role: "user", content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId };
                var thIdx = CS.messages.findIndex(function (m, i) {
                    return i > userIdx && m.isPending && m.role === "assistant" && !m.isBackgroundTask;
                });
                if (thIdx !== -1) CS.messages.splice(thIdx, 1);
            }
            promoteNextQueuedToRunning();
            return undefined;
        }
        if (userIdx >= 0) {
            var exist = CS.messages[userIdx];
            var repl = { role: "user", content: exist.content };
            if (exist._serverItemId !== undefined) repl._serverItemId = exist._serverItemId;
            CS.messages[userIdx] = repl;
        }
        var thinkingIdx = userIdx >= 0
            ? CS.messages.findIndex(function (m, i) { return i > userIdx && m.isPending && m.role === "assistant" && !m.isBackgroundTask; })
            : -1;
        return thinkingIdx !== -1 ? thinkingIdx : (userIdx >= 0 ? userIdx + 1 : -1);
    }
    function insertAtTarget(msg, targetIdx) {
        if (targetIdx >= 0 && CS.messages[targetIdx] && CS.messages[targetIdx].isPending) CS.messages[targetIdx] = msg;
        else if (targetIdx >= 0) CS.messages.splice(targetIdx, 0, msg);
        else CS.messages.push(msg);
    }
    function onQueuedSendResponse(_composed, response, platform, serverId) {
        var targetIdx = resolveQueuedUserBubble(serverId);
        if (targetIdx === undefined) { renderMessages(); updateHistoryCache(); return; }
        if (isErrorResponseBody(response)) {
            insertAtTarget({ role: "assistant", content: getErrorMessage(response), isError: true }, targetIdx);
        } else {
            var answer = (platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response));
            answer = (answer || "").trim() || "No text response received from AI provider.";
            var lid = newLocalId();
            if (targetIdx >= 0 && CS.messages[targetIdx] && CS.messages[targetIdx].isPending) {
                CS.messages[targetIdx] = { role: "assistant", content: "", _localId: lid };
                renderMessages(); enqueueTypewrite(targetIdx, answer, lid);
            } else if (targetIdx >= 0) {
                CS.messages.splice(targetIdx, 0, { role: "assistant", content: "", _localId: lid });
                renderMessages(); enqueueTypewrite(targetIdx, answer, lid);
            } else {
                var aiIdx = CS.messages.length;
                CS.messages.push({ role: "assistant", content: "", _localId: lid });
                renderMessages(); enqueueTypewrite(aiIdx, answer, lid);
            }
        }
        promoteNextQueuedToRunning();
        updateHistoryCache();
        renderMessages();
        scrollToBottom(true);
    }
    function onQueuedSendError(_composed, err, serverId) {
        var isNotExists = err && (err.code === "NOT_EXISTS" || (err.body && err.body.code === "NOT_EXISTS"));
        if (isNotExists) {
            var userIdx = serverId
                ? CS.messages.findIndex(function (m) { return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) && m.role === "user" && !m.isBackgroundTask; })
                : CS.messages.findIndex(function (m) { return m.isPendingInProcess && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue; });
            if (!serverId && userIdx === -1) {
                userIdx = CS.messages.findIndex(function (m) { return m.isPendingQueued && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue; });
            }
            if (userIdx >= 0) {
                var ex = CS.messages[userIdx];
                var repl = { role: "user", content: ex.content, isCancelled: true };
                if (ex._serverItemId !== undefined) repl._serverItemId = ex._serverItemId;
                CS.messages[userIdx] = repl;
            }
            if (serverId) {
                var thById = CS.messages.findIndex(function (m) { return m._serverItemId === serverId && m.isPending && m.role === "assistant" && !m.isBackgroundTask; });
                if (thById !== -1) CS.messages.splice(thById, 1);
                else if (userIdx >= 0) {
                    var thPos = CS.messages.findIndex(function (m, i) { return i > userIdx && m.isPending && m.role === "assistant" && !m.isBackgroundTask; });
                    if (thPos !== -1) CS.messages.splice(thPos, 1);
                }
            } else if (userIdx >= 0) {
                var thPos2 = CS.messages.findIndex(function (m, i) { return i > userIdx && m.isPending && m.role === "assistant" && !m.isBackgroundTask; });
                if (thPos2 !== -1) CS.messages.splice(thPos2, 1);
            }
            if (serverId) cancelledServerIds.delete(serverId);
            promoteNextQueuedToRunning(); updateHistoryCache(); renderMessages(); scrollToBottom(true);
            return;
        }
        var targetIdx = resolveQueuedUserBubble(serverId);
        if (targetIdx === undefined) { renderMessages(); updateHistoryCache(); return; }
        insertAtTarget({ role: "assistant", content: getErrorMessage(err), isError: true }, targetIdx);
        promoteNextQueuedToRunning(); updateHistoryCache(); renderMessages(); scrollToBottom(true);
    }

    function cancelQueuedMessage(msg, idx) {
        var id = msg._serverItemId;
        if (!id || msg._cancelling) return;
        var platform = S.aiPlatform;
        if (platform !== "claude" && platform !== "openai") return;
        var url = platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
        var queueBase = (S.user && S.user.user_id) || S.serviceId;
        var queue = (msg.isBackgroundTask || msg._useBgQueue) ? queueBase + BG_INDEXING_QUEUE_SUFFIX : queueBase;
        CS.messages[idx] = Object.assign({}, msg, { _cancelling: true, _cancelError: undefined });
        renderMessages();
        Promise.resolve(S.skapi.cancelClientSecretRequest({
            url: url, method: "POST", id: id, queue: queue, service: S.serviceId, owner: S.owner,
        })).then(function (result) {
            if (result && result.removed) {
                cancelledServerIds.add(id);
                var qi = bgTaskQueue.findIndex(function (e) { return e.id === id; });
                if (qi !== -1) bgTaskQueue.splice(qi, 1);
                var removeIdx = CS.messages.findIndex(function (m) {
                    return m._serverItemId === id && (m.isPendingQueued || m.isPendingInProcess) && m.role === "user";
                });
                if (removeIdx !== -1) {
                    CS.messages[removeIdx] = { role: "user", content: CS.messages[removeIdx].content, isCancelled: true, _serverItemId: id };
                    var thById = CS.messages.findIndex(function (m) { return m._serverItemId === id && m.isPending && m.role === "assistant"; });
                    if (thById !== -1) CS.messages.splice(thById, 1);
                    else {
                        var thPos = CS.messages.findIndex(function (m, i) {
                            return i > removeIdx && m.isPending && m.role === "assistant" &&
                                (msg.isBackgroundTask ? !!m.isBackgroundTask : !m.isBackgroundTask);
                        });
                        if (thPos !== -1) CS.messages.splice(thPos, 1);
                    }
                    if (msg.isBackgroundTask) promoteNextBgQueuedToRunning(); else promoteNextQueuedToRunning();
                    updateHistoryCache();
                }
                renderMessages();
            } else {
                var errMsg = result && typeof result.message === "string" && result.message ? result.message : "Could not remove from queue.";
                var ci = CS.messages.findIndex(function (m) { return m._serverItemId === id && m.role === "user"; });
                if (ci !== -1) { CS.messages[ci] = Object.assign({}, CS.messages[ci], { _cancelling: false, _cancelError: errMsg }); renderMessages(); }
            }
        }).catch(function (err) {
            var errMsg = err && typeof err.message === "string" && err.message ? err.message : "Could not remove from queue.";
            var ci = CS.messages.findIndex(function (m) { return m._serverItemId === id && m.role === "user"; });
            if (ci !== -1) { CS.messages[ci] = Object.assign({}, CS.messages[ci], { _cancelling: false, _cancelError: errMsg }); renderMessages(); }
        });
    }

    /* ---- typewriter + scroll (agent.vue) --------------------------------- */
    function typewriteIntoIndex(idx, fullText, localId) {
        if (!fullText) return Promise.resolve();
        var TICK_MS = 16, charsPerTick = 3, FENCE_REVEAL_MS = 200;
        var fenceTicks = Math.max(1, Math.floor(FENCE_REVEAL_MS / TICK_MS));
        var fenceRegions = [], m;
        var fenceRegex = /```[\w.-]+\.[a-zA-Z0-9]+\n[\s\S]*?```/g;
        while ((m = fenceRegex.exec(fullText)) !== null) fenceRegions.push({ start: m.index, end: m.index + m[0].length });
        var linkRegions = [], lm; var linkRegex = createInlineLinkRegex();
        while ((lm = linkRegex.exec(fullText)) !== null) linkRegions.push({ start: lm.index, end: lm.index + lm[0].length });

        CS.typing = true; CS.typingAbort = false;
        var i = 0;
        return (function loop() {
            if (CS.typingAbort || i >= fullText.length) return Promise.resolve();
            var step = charsPerTick;
            var region = fenceRegions.find(function (r) { return i >= r.start && i < r.end; });
            var linkRegion = linkRegions.find(function (r) { return i >= r.start && i < r.end; });
            if (region) step = Math.max(charsPerTick, Math.ceil((region.end - i) / fenceTicks));
            else if (linkRegion) step = Math.max(charsPerTick, linkRegion.end - i);
            else {
                var nextLink = linkRegions.find(function (r) { return i < r.start && i + step > r.start; });
                if (nextLink) step = nextLink.end - i;
            }
            i = Math.min(fullText.length, i + step);
            var currentIdx = localId ? CS.messages.findIndex(function (mm) { return mm._localId === localId; }) : idx;
            if (currentIdx === -1) return Promise.resolve();
            var target = CS.messages[currentIdx];
            if (!target) return Promise.resolve();
            target.content = fullText.slice(0, i);
            refreshMessageBubble(currentIdx);
            return scrollToBottomIfSticky().then(function () { return sleep(TICK_MS); }).then(loop);
        })().then(function () {
            if (!CS.typingAbort) {
                var fi = localId ? CS.messages.findIndex(function (mm) { return mm._localId === localId; }) : idx;
                var t = fi !== -1 ? CS.messages[fi] : CS.messages[idx];
                if (t) { t.content = fullText; refreshMessageBubble(fi !== -1 ? fi : idx); }
            }
            CS.typing = false;
        });
    }
    function enqueueTypewrite(idx, fullText, localId) {
        CS.typewriterQueue = CS.typewriterQueue.then(function () { return typewriteIntoIndex(idx, fullText, localId); });
        return CS.typewriterQueue;
    }
    function scrollToBottom(smooth) {
        return raf2().then(function () {
            if (!CS.messagesBox) return;
            CS.stickToBottom = true;
            if (smooth) CS.messagesBox.scrollTo({ top: CS.messagesBox.scrollHeight, behavior: "smooth" });
            else CS.messagesBox.scrollTop = CS.messagesBox.scrollHeight;
        });
    }
    function scrollToBottomIfSticky(smooth) {
        if (CS.stickToBottom) return scrollToBottom(smooth);
        return Promise.resolve();
    }
    function onHistoryScroll() {
        if (!CS.messagesBox) return;
        var el = CS.messagesBox;
        CS.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
        if (el.scrollTop <= 60) fetchOlderHistoryIfNeeded();
    }

    /* ---- render helpers (agent.vue) -------------------------------------- */
    function createInlineLinkRegex() {
        return /src::(\S+)|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]+|\([^\s()]*\))+)\)|\[([^\]\n]+)\]\(((?:[^()\n]+|\([^()\n]*\))+)\)|(https?:\/\/[^\s<>"']+)/g;
    }
    function safeDecodeURIComponent(v) { try { return decodeURIComponent(v); } catch (e) { return v; } }
    function encodePathSegments(path) {
        return path.split("/").filter(Boolean).map(function (s) { return encodeURIComponent(s); }).join("/");
    }
    function normalizeAttachmentPathCandidate(value) {
        return safeDecodeURIComponent((value || "").trim()).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
    }
    function extractRemotePathFromAttachmentHref(href) {
        try {
            var parsed = new URL(href);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
            var path = normalizeAttachmentPathCandidate(parsed.pathname || "");
            var segs = path.split("/").filter(Boolean);
            if (!segs.length) return null;
            var HEX = /^[a-f0-9]{32,}$/i;
            var sid = S.serviceId || "";
            var start = 0;
            while (start < segs.length) {
                var seg = segs[start];
                if (seg === sid || HEX.test(seg)) { start++; continue; }
                break;
            }
            var real = segs.slice(start).join("/");
            return real || null;
        } catch (e) { return null; }
    }
    function getExpiredAttachmentVisiblePath(remotePath, fallback) {
        var n = normalizeAttachmentPathCandidate(remotePath);
        if (n) return n;
        return normalizeAttachmentPathCandidate(fallback || "file") || "file";
    }
    function buildDisplayExpiredAttachmentHref(remotePath, fallback) {
        return EXPIRED_ATTACHMENT_URL_ORIGIN + "/" + encodePathSegments(getExpiredAttachmentVisiblePath(remotePath, fallback));
    }
    function sanitizeAttachmentLinksForHistory(content) {
        if (!content || content.indexOf("Attached files:") === -1) return content;
        return content.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_m, label, href) {
            var remotePath = extractRemotePathFromAttachmentHref(href);
            var labelPath = normalizeAttachmentPathCandidate(label);
            var fullPath = remotePath || labelPath;
            if (!fullPath) return "[" + label + "](" + EXPIRED_ATTACHMENT_URL_ORIGIN + "/file)";
            return "[" + label + "](" + buildDisplayExpiredAttachmentHref(fullPath, label) + ")";
        });
    }
    function truncateLabelForDisplay(label) {
        if (!label) return label;
        if (label.length <= LINK_LABEL_MAX_DISPLAY_CHARS) return label;
        return "…" + label.slice(label.length - (LINK_LABEL_MAX_DISPLAY_CHARS - 1));
    }
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
        var href = URL.createObjectURL(new Blob([body], { type: contentType }));
        fileBlobCache.set(key, href);
        return href;
    }
    function fileToAnchorHtml(filename, href) {
        var text = "↗ " + filename;
        return '<a class="bq-file-download" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(text) + "</a>";
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
            var remotePath = isUrl ? (extractRemotePathFromAttachmentHref(rawPath) || normalizeAttachmentPathCandidate(rawPath)) : normalizeAttachmentPathCandidate(rawPath);
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
        var rmp = extractRemotePathFromAttachmentHref(originalHref);
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
            /```([\w.-]+\.[a-zA-Z0-9]+)\n([\s\S]*?)```/g,
            function (_full, filename, body) { return pushPlaceholder(fileToAnchorHtml(filename, getOrCreateFileHref(filename, body))); }
        );
        if (CS.typing) {
            var openFence = working.match(/```([\w.-]+\.[a-zA-Z0-9]+)\n?/);
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
    function getPublicTemporaryUrl(_remotePath) {
        return Promise.reject(new Error("Attachment link refresh isn't available yet."));
    }
    function fetchFreshHrefForExpiredLink(expiredHref, remotePath) {
        var cached = refreshedExpiredLinkMap[expiredHref];
        if (cached) return Promise.resolve(cached);
        var inFlight = refreshingLinkPromises.get(expiredHref);
        if (inFlight) return inFlight;
        var run = (function () {
            refreshingLinkMap[expiredHref] = true;
            var resolved = remotePath || extractRemotePathFromAttachmentHref(expiredHref);
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
        var cached = refreshedExpiredLinkMap[originalHref];
        if (cached) { anchor.href = cached; anchor.dataset.bqExpired = "0"; anchor.click(); return; }
        fetchFreshHrefForExpiredLink(originalHref, anchor.dataset.bqRemotePath).then(function (fresh) {
            anchor.href = fresh; anchor.dataset.bqExpired = "0"; anchor.click();
        }).catch(function (err) {
            console.error("[bunnychat] expired link refresh failed", err);
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
    function filterListByClearHorizon(list) {
        var clearedAt = getClearedAt();
        if (!clearedAt) return list;
        return list.filter(function (item) {
            var updated = Number(item && item.updated);
            return isFinite(updated) && updated > clearedAt;
        });
    }
    function normalizeTextContent(content) {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map(function (part) {
                if (typeof part === "string") return part;
                if (part && (part.type === "text" || part.type === "input_text" || part.type === "output_text")) return part.text || "";
                return "";
            }).join("\n").trim();
        }
        return "";
    }
    function extractLastUserTextFromRequest(requestBody) {
        var arr = requestBody && Array.isArray(requestBody.messages) ? requestBody.messages
            : (requestBody && Array.isArray(requestBody.input) ? requestBody.input : []);
        for (var i = arr.length - 1; i >= 0; i--) {
            if (arr[i] && arr[i].role === "user") {
                var t = normalizeTextContent(arr[i].content);
                if (t) return t;
            }
        }
        return "";
    }
    function mapHistoryListToMessages(list, platform) {
        var mapped = [], runningItemIds = [];
        var extractAssistantText = platform === "openai" ? extractOpenAIText : extractClaudeText;
        var filtered = filterListByClearHorizon(list);
        filtered.slice().reverse().forEach(function (item) {
            var requestBody = item && item.request_body;
            var isInProcess = item && item.status === "running";
            var isQueued = item && item.status === "pending";
            var isCancelledItem = item && item.status === "cancelled";
            var isPending = isInProcess || isQueued;
            var isFailed = item && item.status === "failed";
            var response = isFailed ? (item.error != null ? item.error : item.response_body)
                : (item && item.response_body != null ? item.response_body : item && item.error);
            var userText = extractLastUserTextFromRequest(requestBody);
            var assistantText = isPending ? "" : ((extractAssistantText(response) || "").trim() || "");
            var isErrorResponse = !isPending && (isFailed || isErrorResponseBody(response));
            var serverItemId = item && typeof item.id === "string" && item.id ? item.id : undefined;

            if (userText) {
                var displayContent;
                if (item._isBgTask) {
                    var nameMatch = userText.match(/^- name: (.+)$/m);
                    displayContent = nameMatch ? "Indexing: " + nameMatch[1].trim() : userText;
                } else {
                    displayContent = sanitizeAttachmentLinksForHistory(userText);
                }
                var userMsg = { role: "user", content: displayContent };
                if (isInProcess) userMsg.isPendingInProcess = true;
                if (isQueued) userMsg.isPendingQueued = true;
                if (isCancelledItem) userMsg.isCancelled = true;
                if (item._isBgTask) userMsg.isBackgroundTask = true;
                if (item._isOnBgQueue) userMsg._useBgQueue = true;
                if (serverItemId !== undefined) userMsg._serverItemId = serverItemId;
                mapped.push(userMsg);
            }
            if (isCancelledItem) { /* no assistant bubble */ }
            else if (isInProcess) {
                var ph = { role: "assistant", content: "", isPending: true, isPendingInProcess: true };
                if (item._isBgTask) ph.isBackgroundTask = true;
                if (serverItemId !== undefined) { ph._serverItemId = serverItemId; runningItemIds.push(serverItemId); }
                mapped.push(ph);
            } else if (isQueued) { /* no assistant placeholder */ }
            else if (isErrorResponse) {
                var em = { role: "assistant", content: getErrorMessage(response), isError: true };
                if (item._isBgTask) em.isBackgroundTask = true;
                if (serverItemId !== undefined) em._serverItemId = serverItemId;
                mapped.push(em);
            } else if (assistantText) {
                var okm = { role: "assistant", content: assistantText };
                if (item._isBgTask) okm.isBackgroundTask = true;
                if (serverItemId !== undefined) okm._serverItemId = serverItemId;
                mapped.push(okm);
            }
        });
        return { messages: mapped, runningItemIds: runningItemIds };
    }
    function updateHistoryCache() {
        var key = getHistoryCacheKey();
        if (!key) return;
        aiChatHistoryCache[key] = {
            messages: CS.messages.slice(),
            endOfList: CS.historyEndOfList,
            startKeyHistory: CS.historyStartKeyHistory.slice(),
        };
    }
    function drainBgTaskQueue() { /* bg-task injection lands in the attachments phase */ }
    function handleHistoryItemResolution(itemId, response, platform) {
        historyItemPolls.delete(itemId);
        var isErr = isErrorResponseBody(response);
        var answer = isErr ? getErrorMessage(response)
            : ((platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response)) || "").trim();
        // Running item: replace its "Thinking" assistant placeholder.
        var idx = CS.messages.findIndex(function (m) { return m.isPending && m._serverItemId === itemId; });
        if (idx !== -1) {
            if (isErr) {
                CS.messages[idx] = { role: "assistant", content: answer, isError: true, _serverItemId: itemId };
                renderMessages(); updateHistoryCache(); return;
            }
            var lid = newLocalId();
            CS.messages[idx] = { role: "assistant", content: "", _localId: lid, _serverItemId: itemId };
            renderMessages(); enqueueTypewrite(idx, answer || "No text response received from AI provider.", lid);
            updateHistoryCache(); return;
        }
        // Queued item (user bubble only, no placeholder): de-queue and insert
        // the assistant answer right after the user bubble.
        var userIdx = CS.messages.findIndex(function (m) {
            return m.role === "user" && m._serverItemId === itemId && (m.isPendingQueued || m.isPendingInProcess);
        });
        if (userIdx === -1) return;
        var ex = CS.messages[userIdx];
        CS.messages[userIdx] = { role: "user", content: ex.content, _serverItemId: itemId };
        if (isErr) {
            CS.messages.splice(userIdx + 1, 0, { role: "assistant", content: answer, isError: true, _serverItemId: itemId });
            renderMessages(); updateHistoryCache(); return;
        }
        var lid2 = newLocalId();
        CS.messages.splice(userIdx + 1, 0, { role: "assistant", content: "", _localId: lid2, _serverItemId: itemId });
        renderMessages(); enqueueTypewrite(userIdx + 1, answer || "No text response received from AI provider.", lid2);
        updateHistoryCache();
    }
    function fetchOlderHistoryIfNeeded() {
        if (CS.loadingHistory || CS.loadingOlderHistory || CS.historyEndOfList) return;
        fetchHistoryPage(true);
    }
    function fetchHistoryPage(fetchMore, token) {
        if (token === undefined) token = CS.gateRefreshToken;
        if ((CS.loadingHistory && CS.historyRequestToken === token) || !chatEnabled() || S.aiPlatform === "none" || !S.serviceId) {
            return Promise.resolve();
        }
        CS.historyRequestToken = token;
        CS.loadingHistory = true;
        if (fetchMore) CS.loadingOlderHistory = true;
        var prevScrollHeight = CS.messagesBox ? CS.messagesBox.scrollHeight : 0;
        var prevScrollTop = CS.messagesBox ? CS.messagesBox.scrollTop : 0;
        var platform = S.aiPlatform;
        var serviceId = S.serviceId, owner = S.owner;
        var options = { fetchMore: fetchMore };
        if (fetchMore && CS.historyStartKeyHistory.length) options.startKeyHistory = CS.historyStartKeyHistory.slice();

        var fetchHistory = function () { return getChatHistory({ service: serviceId, owner: owner, platform: platform }, options); };

        return Promise.resolve().then(fetchHistory).catch(function (err) {
            if (isAuthExpiredError(err)) return refreshSkapiSession().then(fetchHistory);
            throw err;
        }).then(function (history) {
            if (token !== CS.gateRefreshToken) return;
            var chatList = history && Array.isArray(history.list) ? history.list : [];
            chatList.forEach(function (item) {
                if (typeof item.queue_name === "string" && item.queue_name.slice(-BG_INDEXING_QUEUE_SUFFIX.length) === BG_INDEXING_QUEUE_SUFFIX) {
                    var userText = extractLastUserTextFromRequest(item.request_body);
                    if (typeof userText === "string" && userText.indexOf("A new file has just been uploaded") === 0) item._isBgTask = true;
                    else item._isOnBgQueue = true;
                }
            });
            var list = chatList.sort(function (a, b) {
                var ai = typeof a.id === "string" ? a.id : "", bi = typeof b.id === "string" ? b.id : "";
                return ai > bi ? -1 : (ai < bi ? 1 : 0);
            });
            var mapped = mapHistoryListToMessages(list, platform).messages;

            if (fetchMore) {
                CS.messages = mapped.concat(CS.messages);
            } else {
                if (CS.typing) CS.typingAbort = true;
                var serverIds = {};
                mapped.forEach(function (m) { if (m._serverItemId) serverIds[m._serverItemId] = 1; });
                var locallyCancelled = {};
                CS.messages.forEach(function (m) { if (m.isCancelled && m._serverItemId) locallyCancelled[m._serverItemId] = 1; });
                var rescued = [];
                for (var ri = 0; ri < CS.messages.length; ri++) {
                    var mm = CS.messages[ri];
                    if (mm.isBackgroundTask) continue;
                    if (mm._serverItemId && serverIds[mm._serverItemId]) continue;
                    if (!mm._serverItemId) {
                        if (mm.isSendingToServer || mm.isPendingQueued || mm.isPendingInProcess || mm.isPending) rescued.push(mm);
                        else if (CS.sending && mm.role === "user") {
                            var next = CS.messages[ri + 1];
                            if (next && !next.isBackgroundTask && next.isPending && !next._serverItemId) rescued.push(mm);
                        }
                    }
                }
                CS.messages = mapped;
                rescued.forEach(function (m) { CS.messages.push(m); });
                if (Object.keys(locallyCancelled).length) {
                    for (var ci = 0; ci < CS.messages.length; ci++) {
                        var c = CS.messages[ci];
                        if (!c._serverItemId || !locallyCancelled[c._serverItemId] || c.isCancelled) continue;
                        CS.messages[ci] = { role: "user", content: c.content, isCancelled: true, _serverItemId: c._serverItemId };
                        if (ci + 1 < CS.messages.length && CS.messages[ci + 1].isPending && CS.messages[ci + 1]._serverItemId === c._serverItemId) {
                            CS.messages.splice(ci + 1, 1);
                        }
                    }
                }
            }
            CS.historyEndOfList = !!(history && history.endOfList);
            CS.historyStartKeyHistory = history && Array.isArray(history.startKeyHistory) ? history.startKeyHistory : [];
            var clearedAt = getClearedAt();
            if (clearedAt && chatList.length > 0) {
                var oldestUpdated = Number(chatList[chatList.length - 1] && chatList[chatList.length - 1].updated);
                if (isFinite(oldestUpdated) && oldestUpdated <= clearedAt) CS.historyEndOfList = true;
            }
            updateHistoryCache();
            renderMessages();

            if (!fetchMore) {
                chatList.forEach(function (item) {
                    if (item.status !== "running" && item.status !== "pending") return;
                    if (!item.poll || !item.id) return;
                    if (historyItemPolls.has(item.id)) return;
                    if (item.status === "running" && pendingAgentRequests[getHistoryCacheKey()]) return;
                    historyItemPolls.set(item.id, true);
                    var capturedId = item.id;
                    var pp = item.poll({
                        latency: POLL_INTERVAL,
                        onResponse: function (response) { handleHistoryItemResolution(capturedId, response, platform); },
                        onError: function (err) {
                            historyItemPolls.delete(capturedId);
                            var isNotExists = err && (err.code === "NOT_EXISTS" || (err.body && err.body.code === "NOT_EXISTS"));
                            var aIdx = CS.messages.findIndex(function (m) { return m.isPending && m._serverItemId === capturedId; });
                            if (isNotExists) {
                                var isBg = aIdx !== -1 ? !!CS.messages[aIdx].isBackgroundTask : false;
                                if (aIdx !== -1) CS.messages.splice(aIdx, 1);
                                if (!isBg) {
                                    var uIdx = CS.messages.findIndex(function (m) { return m.role === "user" && m._serverItemId === capturedId && !m.isCancelled; });
                                    if (uIdx !== -1) { var ex = CS.messages[uIdx]; CS.messages[uIdx] = { role: "user", content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId }; }
                                    cancelledServerIds.delete(capturedId); promoteNextQueuedToRunning();
                                }
                                renderMessages(); updateHistoryCache(); return;
                            }
                            if (aIdx !== -1) {
                                var wasBg = CS.messages[aIdx].isBackgroundTask;
                                CS.messages[aIdx] = { role: "assistant", content: getErrorMessage(err), isError: true };
                                if (wasBg) CS.messages[aIdx].isBackgroundTask = true;
                                renderMessages(); updateHistoryCache();
                            }
                        },
                    });
                    if (pp && pp.catch) pp.catch(function () {});
                });
                drainBgTaskQueue();
            }

            if (fetchMore && CS.messagesBox) {
                return raf2().then(function () {
                    if (token !== CS.gateRefreshToken || !CS.messagesBox) return;
                    CS.messagesBox.scrollTop = prevScrollTop + (CS.messagesBox.scrollHeight - prevScrollHeight);
                });
            }
            if (!fetchMore) return scrollToBottom();
        }).catch(function (err) {
            // history is optional; ignore if unavailable
            console.warn("[bunnychat] getChatHistory failed", err);
        }).then(function () {
            if (CS.historyRequestToken === token) { CS.loadingHistory = false; CS.loadingOlderHistory = false; }
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
                var key = getHistoryCacheKey();
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
        el.style.height = Math.min(el.scrollHeight, 192) + "px";
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
            bubble = h("div", { class: "bq-bubble" }, h("span", { class: "bq-loader", text: "Thinking" }));
        } else {
            bubble = h("div", { class: "bq-bubble" });
            if (msg.role === "user" && msg.isPendingQueued) {
                var disabled = !msg._serverItemId || msg.isSendingToServer || msg._cancelling;
                var cancelBtn = h("button", {
                    class: "bq-cancel-queue-btn" + (disabled ? " is-disabled" : ""),
                    type: "button", title: "Cancel queued message", html: "&times;",
                });
                if (!disabled) cancelBtn.addEventListener("click", function (e) { e.stopPropagation(); cancelQueuedMessage(msg, idx); });
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

    function renderMessages() {
        if (!CS.messagesBox) return;
        clear(CS.messagesBox);
        CS.messageEls = [];
        if (!CS.messages.length) {
            var greet = h("div", { class: "bq-message is-assistant bq-empty-greeting" },
                h("div", { class: "bq-bubble" },
                    document.createTextNode("Hi! Ask me anything about " + (S.serviceName ? '"' + S.serviceName + '"' : "your project") +
                        ". You can also add data by pasting text into the chat.")));
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
        CS.gateRefreshToken += 1;
        historyItemPolls.clear();
        if (CS.pollTimer) { clearInterval(CS.pollTimer); CS.pollTimer = null; }

        render("chat", function () {
            var logoutBtn = h("button", { class: "bq-icon-btn", type: "button", title: "Log out",
                html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
                onclick: function () { logout(); } });
            var clearBtn = h("button", { class: "bq-icon-btn bq-icon-btn--danger", type: "button", title: "Clear chat history",
                html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
                onclick: function () { openClearHistoryModal(); } });

            var header = h("div", { class: "bq-section-title" },
                h("div", { class: "bq-title-row" },
                    h("div", { class: "bq-title-left" }, h("span", { class: "bq-agent-badge", text: agentBadgeText() })),
                    h("div", { class: "bq-title-right" }, themeToggleButton(), clearBtn, logoutBtn)));

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
            CS.messagesBox = box;

            var input = h("textarea", { class: "bq-input", rows: "1", placeholder: "Ask anything about the project…" });
            var composing = false;
            input.addEventListener("compositionstart", function () { composing = true; });
            input.addEventListener("compositionend", function () { composing = false; });
            input.addEventListener("input", function () { autoGrowInput(input); });
            input.addEventListener("keydown", function (e) {
                if (e.key === "Enter" && !e.shiftKey && !composing) { e.preventDefault(); sendMessage(); }
            });
            var sendBtn = h("button", { class: "btn", type: "submit" }, "Send");
            var composer = h("form", { class: "bq-input-row", onsubmit: function (e) { e.preventDefault(); sendMessage(); } },
                h("div", { class: "bq-input-wrap" }, input), sendBtn);

            chatArea = h("div", { class: "bq-chat" }, box, composer);
            return h("div", { class: "bq-meta" }, header, chatArea);
        });

        if (S.aiPlatform === "none") return;
        // load markdown renderer, then show history
        loadMarked().then(function () {
            renderMessages();
            return fetchHistoryPage(false, CS.gateRefreshToken);
        }).then(function () { schedulePendingPoll(); });
    }

    // generic modal helper (appended to <body>, themed)
    function openModal(builder) {
        var root = h("div", { class: "bq-modal-root", "data-bq-theme": S.theme });
        var backdrop = h("div", { class: "bq-modal-backdrop" });
        var close = function () { if (root.parentNode) root.parentNode.removeChild(root); };
        backdrop.addEventListener("click", close);
        root.appendChild(backdrop);
        root.appendChild(builder(close));
        document.body.appendChild(root);
        return { root: root, close: close };
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
            hostDomain: "skapi.com",     // used to detect db-CDN links in AI replies
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
