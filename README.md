# BunnyQuery Client

An embeddable, zero-dependency AI chat widget that connects to a [BunnyQuery](https://www.bunnyquery.com) project. Drop two `<script>` tags into any HTML page and your users get a fully featured chat UI backed by Claude or OpenAI — with login, password recovery, account settings, file attachments, persistent history, and MCP-based authentication.

---

## Features

- **Plug-and-play embed** — one `<script>` tag, one `BunnyQuery.init()` call.
- **Claude & OpenAI support** — the AI platform is selected in your project settings; the embed reads it automatically.
- **Built-in account UI**
  - Login form (email/username + password).
  - **Forgot password** flow — request a code, set a new password without leaving the embed.
  - **Account settings** dialog — change email (with verification), change password, see verification status.
- **MCP OAuth** — authentication uses the [Model Context Protocol](https://modelcontextprotocol.io/) OAuth flow (RFC 7591 + PKCE). API keys never reach the browser. After a host login the embed silently exchanges the Skapi session for an MCP access token.
- **Persistent history** — previous messages are loaded from the server on startup and paginated as the user scrolls up.
- **File attachments** — files are uploaded to the Skapi host-file store and linked into the message as temporary CDN URLs.
- **Clear / logout** — modal-confirmed actions that respect in-flight requests.
- **Responsive** — collapses to full-screen on narrow viewports.
- **Read-only mode** — the attach button is hidden automatically when `freeze_database` is set in the project settings.

---

## Quick Start

### 1. Get your project ID

Sign in at [www.bunnyquery.com](https://www.bunnyquery.com), open your project, and copy the **Project ID** from the project settings page.

### 2. Embed it

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- 1. Skapi SDK -->
    <script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
    <!-- 2. BunnyQuery widget (CSS is injected automatically) -->
    <script src="https://cdn.jsdelivr.net/npm/bunnyquery@latest/bunnyquery.js"></script>
</head>
<body>
    <!-- 3. Mount point -->
    <div id="bq-client"></div>

    <script type="module">
        const skapi = new Skapi('YOUR_PROJECT_ID', { autoLogin: true });
        await BunnyQuery.init(skapi, 'bq-client');
    </script>
</body>
</html>
```

That's it. The widget renders the chat if the user is signed in, otherwise it shows the login form.

---

## API Reference

### `BunnyQuery.init(skapi, elementId, dev?)` → `Promise<BunnyQuery>`

Initialises the widget and returns the instance.

| Parameter   | Type                       | Description                                                                                              |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `skapi`     | `Skapi`                    | An initialised `Skapi` instance.                                                                         |
| `elementId` | `string \| HTMLElement`    | The id string or DOM element to mount the widget into.                                                   |
| `dev`       | `boolean` *(optional)*     | When `true`, routes every MCP call to the dev MCP host (`MCP_DEV_BASE_URL`). Omit or pass `false` in production. |

### Static configuration

Set these **before** calling `init()`:

| Property                   | Default                                       | Description                                                                                          |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `BunnyQuery.MCP_BASE_URL`  | `https://mcp.broadwayinc.computer`            | Production MCP OAuth server base URL. Override to target a different MCP host. Automatically swapped to the dev host when `init(..., true)` is used. |
| `BunnyQuery.STYLESHEET_URL`| *(auto-resolved)*                             | Override the CSS file URL when auto-resolution fails (e.g. CDN-hosted scripts behind a custom domain). |

The widget auto-injects `bunnyquery.css` from the same directory as `bunnyquery.js`. If you bundle the script yourself or serve it from a path that breaks auto-resolution:

```js
BunnyQuery.STYLESHEET_URL = 'https://your-cdn.example.com/bunnyquery.css';
await BunnyQuery.init(skapi, 'bq-client');
```

---

## Built-in Account UI

### Login

Users who are not signed in see a username/password form. After a successful login the embed silently mints an MCP access token via `oauth.exchangeSession(skapi.session)` and switches to the chat view.

### Forgot password

A **Forgot password?** link sits under the login submit button and opens a two-step recovery flow inside the same overlay:

1. The user enters their email and presses **Send code** — calls `skapi.forgotPassword({ email })`.
2. The user enters the verification code from their inbox plus a new password (with confirmation), and presses **Reset password** — calls `skapi.resetPassword({ email, code, new_password })`.

On success the embed returns to the login form with the email pre-filled and a confirmation notice.

### Account settings

Once signed in, the chat header shows a **Settings** button between **Clear** and **Logout**. It opens a modal with two sections:

- **Email** — shows the current address with a *verified / unverified* badge.
  - For unverified accounts (or right after a change) the user can press **Send code** (`skapi.verifyEmail()`), enter the received code, and press **Verify** (`skapi.verifyEmail({ code })`).
  - Below that, **Change email** updates the address via `skapi.updateProfile({ email })`, marks it unverified, and re-opens the verify flow.
- **Password** — current / new / confirm fields with a client-side match check, calls `skapi.changePassword({ current_password, new_password })`.
  - Hidden automatically for OpenID / social-login accounts (Cognito password change is not available).

---

## Customisation

### Sizing

The widget fills the element you mount it into. Control size and chrome with normal CSS:

```css
#bq-client {
    width: 800px;
    height: 600px;
    border: 1px solid #ccc;
}
```

### CSS custom properties

All colours are CSS custom properties scoped to `.bq-agent`:

| Variable          | Default    | Usage                |
| ----------------- | ---------- | -------------------- |
| `--bq-ink`        | `#111`     | Primary text         |
| `--bq-paper`      | `#fff`     | Background           |
| `--bq-muted`      | `#666`     | Secondary text       |
| `--bq-line`       | `#c8c8c8`  | Borders              |
| `--bq-hover-bg`   | `#ebebeb`  | Hover states         |
| `--bq-pink`       | `#c2185b`  | Links                |
| `--bq-danger`     | `#c44`     | Destructive actions  |

Override them on a parent element:

```css
#bq-client {
    --bq-ink: #1a1a2e;
    --bq-paper: #f5f5f5;
    --bq-pink: #7c3aed;
}
```

---

## How It Works

1. **Skapi** handles user authentication and acts as the serverless backend (database, file storage, request queueing).
2. **MCP OAuth** — after login the embed exchanges the Skapi session for an MCP access token via `/oauth/session-exchange` (no browser redirect needed). The token is cached in `localStorage` and refreshed automatically on stale-token errors.
3. **AI requests** are made through `skapi.clientSecretRequest`, which keeps your Claude / OpenAI API key on the Skapi edge — it is never sent to the browser.
4. **History** is fetched with `skapi.clientSecretRequestHistory` and merged with the live message list. Pending (in-flight) requests are polled every 4 seconds until they resolve.

---

## Project Structure

```
bunnyquery-client/
├── index.html        # Example host page
├── bunnyquery.js     # Widget source (vanilla JS, no build step)
├── bunnyquery.css    # Widget styles (auto-injected)
└── package.json      # Dev server only (basic-node-server)
```

Run locally:

```sh
npm run dev   # serves the folder on http://localhost:3333
```

---

## Requirements

- A [Skapi](https://www.skapi.com) project with an AI agent configured (Claude or OpenAI).
- A modern browser with `crypto.subtle`, `fetch`, and ES2020 support.
- Node.js 16+ (dev server only).

---

## License

ISC
