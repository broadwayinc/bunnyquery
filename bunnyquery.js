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
    // MCP host. Override BunnyQuery.MCP_BASE_URL before init() to swap.
    const DEFAULTS = {
        MCP_BASE_URL: 'https://mcp-dev.broadwayinc.computer',
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
        PENDING_POLL_INTERVAL_MS: 4000,
        ATTACHMENT_URL_EXPIRES_SECONDS: 600, // 10 min
    };

    // localStorage keys are namespaced by origin so multiple embeds on the
    // same machine do not stomp each other's tokens.
    const STORAGE_PREFIX = 'bq_embed_v1:';
    const CLIENT_KEY = STORAGE_PREFIX + 'mcp_client';
    const TOKEN_KEY = STORAGE_PREFIX + 'mcp_token';
    const STATE_KEY = STORAGE_PREFIX + 'mcp_state';

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
        return skapi.clientSecretRequest({
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
                        url: DEFAULTS.MCP_BASE_URL,
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
        });
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
                        server_url: DEFAULTS.MCP_BASE_URL,
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
            } else if (item.status === 'failed' || (res && res.error)) {
                out.push({
                    role: 'assistant',
                    content: (res && res.error && res.error.message) || 'Request failed.',
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

            this.oauth = new McpOAuth(BunnyQuery.MCP_BASE_URL || DEFAULTS.MCP_BASE_URL);

            this.messages = [];
            this.attachments = [];
            this.startKeyHistory = null;
            this.endOfList = false;
            this.sending = false;
            this.uploading = false;
            this.pendingTimer = null;
            this._loadingOlder = false;

            this.refs = {};

            this._injectStylesheetOnce();
            this._bootstrap();
        }

        static async init(skapi, elementId) {
            const container = typeof elementId === 'string'
                ? document.getElementById(elementId)
                : elementId;
            if (!container) throw new Error(`BunnyQuery: container "${elementId}" not found`);
            const info = await skapi.__connection;
            console.log('[BunnyQuery] initializing with info', info);
            return new BunnyQuery(skapi, info, container);
        }

        // ---- bootstrap order ----------------------------------------------
        async _bootstrap() {
            // 1. Validate that the project has a configured AI platform.
            if (!this.platform) {
                this._renderFatal('This project does not have an AI agent configured yet. Set one in your project settings.');
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

        _renderLogin() {
            this._clear();
            const errLabel = $('p', { class: 'bq-apikey-error', style: { display: 'none' } });
            const userInput = $('input', {
                type: 'text',
                class: 'bq-input',
                placeholder: 'Email or username',
                autocomplete: 'username',
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
                errLabel,
                userInput,
                passInput,
                submitBtn,
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
            const titleLeft = $('div', { class: 'bq-title-left' }, [
                $('h2', null, titleText),
            ]);

            const clearIcon = $('button', {
                type: 'button',
                class: 'bq-text-btn bq-text-btn--danger',
                title: 'Clear chat history',
                'aria-label': 'Clear chat history',
                onclick: () => this._onClearHistoryClick(),
            }, 'Clear');

            const logoutIcon = $('button', {
                type: 'button',
                class: 'bq-text-btn',
                title: 'Logout',
                'aria-label': 'Logout',
                onclick: () => this._logout(),
            }, 'Logout');

            const titleRight = $('div', { class: 'bq-title-right' }, [
                clearIcon,
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
                placeholder: 'Ask anything about the project...',
                oninput: (e) => this._autoGrow(e.target),
                onkeydown: (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        this._sendMessage();
                    }
                },
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

            if (!this.messages.length) {
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
                    bubble.textContent = msg.content || '';
                }
                const wrapper = $('div', {
                    class:
                        'bq-message ' +
                        (msg.role === 'user' ? 'is-user' : 'is-assistant') +
                        (msg.isError ? ' is-error' : ''),
                }, [bubble]);
                box.appendChild(wrapper);
            });

            if (stickToBottom) {
                box.scrollTop = box.scrollHeight;
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
            const busy = this.sending || this.uploading || this._anyPending();
            if (this.refs.textarea) {
                this.refs.textarea.disabled = busy;
                this.refs.textarea.placeholder = busy
                    ? 'Request in process. Please wait...'
                    : 'Ask anything about the project...';
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

        _anyPending() {
            return this.messages.some((m) => m.isPending);
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
            const busy = this.sending || this.uploading || this._anyPending();
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

            const modal = $('div', {
                class: 'bq-modal-backdrop',
                onclick: (e) => { if (e.target === modal) close(); },
            }, [
                $('div', { class: 'bq-modal-delete' }, [
                    $('div', { class: 'bq-modal-delete-header' }, [
                        $('span', null, 'Clear chat history'),
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
            const busy = this.sending || this.uploading || this._anyPending();
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

            const modal = $('div', {
                class: 'bq-modal-backdrop',
                onclick: (e) => { if (e.target === modal) close(); },
            }, [
                $('div', { class: 'bq-modal-delete' }, [
                    $('div', { class: 'bq-modal-delete-header' }, [
                        $('span', null, 'Logout'),
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
            try {
                const res = await getChatHistory(
                    this.skapi,
                    { service: this.serviceId, owner: this.ownerId, platform: this.platform },
                    { ascending: false }
                );
                this.startKeyHistory = res && res.startKeyHistory;
                const list = this._filterByClearHorizon((res && res.list) || []);
                // If the clear horizon has filtered the entire first page,
                // there are no older entries the user is allowed to see.
                this.endOfList = !!(res && res.endOfList) || (this._getClearedAt() > 0 && list.length === 0);
                this.messages = mapHistoryToMessages(list, this.platform);
                this._renderMessages();
                this._schedulePendingPoll();
            } catch (err) {
                console.error('[BunnyQuery] history load failed', err);
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

        _schedulePendingPoll() {
            if (this.pendingTimer) clearTimeout(this.pendingTimer);
            if (!this._anyPending()) return;
            this.pendingTimer = setTimeout(async () => {
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
                    this._schedulePendingPoll();
                }
            }, DEFAULTS.PENDING_POLL_INTERVAL_MS);
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
                        // After upload, fetch a temporary URL the AI can read.
                        const completed = (res && (res.completed || res)) || [];
                        const first = Array.isArray(completed) ? completed[0] : completed;
                        const path = (first && (first.path || first.url || first.key)) || a.name;
                        const url = await this.skapi.getTemporaryUrl({
                            request: 'get-db',
                            path,
                            expires: DEFAULTS.ATTACHMENT_URL_EXPIRES_SECONDS,
                            generate_temporary_cdn_url: true,
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
        _buildSystemPrompt() {
            let p = `You are the AI assistant for project "${this.projectName || this.serviceId}".`;
            if (this.projectDescription) {
                p += `\nProject description: """${this.projectDescription}"""`;
            }
            return p;
        }

        async _sendMessage() {
            if (this.sending || this.uploading || this._anyPending()) return;
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

                const result = this.platform === 'claude'
                    ? await buildClaudeRequest(this.skapi, args)
                    : await buildOpenAIRequest(this.skapi, args);

                const responseText = this.platform === 'claude'
                    ? extractClaudeText(result)
                    : extractOpenAIText(result);

                // Replace the trailing pending assistant with the result.
                const last = this.messages[this.messages.length - 1];
                if (last && last.isPending) {
                    last.isPending = false;
                    last.content = responseText || '(no response)';
                } else {
                    this.messages.push({ role: 'assistant', content: responseText || '(no response)' });
                }
                this._renderMessages();
                this._schedulePendingPoll();
            } catch (err) {
                const last = this.messages[this.messages.length - 1];
                const errMsg = (err && err.message) || String(err);
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
