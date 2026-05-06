# BunnyQuery Client

An embeddable, zero-dependency AI chat widget that connects to a [BunnyQuery](https://www.skapi.com) project. Drop two script tags into any HTML page and your users get a fully featured chat UI backed by Claude or OpenAI, with file-attachment support, persistent history, and MCP-based authentication.

---

## Features

- **Plug-and-play embed** — one `<script>` tag, one `BunnyQuery.init()` call.
- **Claude & OpenAI support** — the AI platform is selected in your project settings; the embed reads it automatically.
- **MCP OAuth** — authentication uses the [Model Context Protocol](https://modelcontextprotocol.io/) OAuth flow (RFC 7591 + PKCE). No API keys are exposed to the browser.
- **Login form** — users who are not signed in see a username/password form; after login the MCP token exchange happens silently.
- **Persistent history** — previous messages are loaded from the server on startup and paginated as the user scrolls up.
- **File attachments** — users can attach files; they are uploaded to the Skapi host-file store and linked into the message as temporary CDN URLs.
- **Clear / logout** — modal-confirmed actions that respect in-flight requests.
- **Responsive** — collapses to full-screen on narrow viewports.
- **Read-only mode** — the attach button is hidden automatically when `freeze_database` is set in the project settings.

---

## Quick Start

### 1. Get your project ID

Sign in at [www.bunnyquery.com](https://www.bunnyquery.com) and open your project. Your **Project ID** is displayed in the project settings page. Copy it — you will need it in the next step.

### 2. Set your project ID

```html
<script type="module">
    const PROJECT_ID = 'your-project-id-here';   // ← paste your ID here
    let skapi = new Skapi(PROJECT_ID, { autoLogin: true });
    const bqClient = await BunnyQuery.init(skapi, 'bq-client');
</script>
```

## Embedding in Your Own Page

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- 1. Skapi SDK -->
    <script src="https://cdn.jsdelivr.net/npm/skapi-js@beta/dist/skapi.js"></script>
    <!-- 2. BunnyQuery widget (CSS is injected automatically) -->
    <script src="bunnyquery.js"></script>
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

The widget auto-injects `bunnyquery.css` from the same directory as `bunnyquery.js`. If you host the files on a CDN, override the stylesheet URL **before** calling `init`:

```js
BunnyQuery.STYLESHEET_URL = 'https://your-cdn.example.com/bunnyquery.css';
await BunnyQuery.init(skapi, 'bq-client');
```

---

## API Reference

### `BunnyQuery.init(skapi, elementId)` → `Promise<BunnyQuery>`

Initialises the widget and returns the instance.

| Parameter | Type | Description |
|-----------|------|-------------|
| `skapi` | `Skapi` | An initialised `Skapi` instance. |
| `elementId` | `string \| HTMLElement` | The id string or DOM element to mount the widget into. |

### Static configuration properties

Set these **before** calling `init()`.

| Property | Default | Description |
|----------|---------|-------------|
| `BunnyQuery.MCP_BASE_URL` | `https://mcp-dev.broadwayinc.computer` | MCP OAuth server base URL. Override to point at a different MCP host. |
| `BunnyQuery.STYLESHEET_URL` | *(auto-resolved)* | Override the CSS file URL when auto-resolution fails (e.g. CDN-hosted scripts). |

---

## Project Structure

```
bunnyquery-client/
├── index.html        # Example host page
├── bunnyquery.js     # Widget source (vanilla JS, no build step required)
├── bunnyquery.css    # Widget styles
└── package.json      # Dev server only (basic-node-server)
```

---

## How It Works

1. **Skapi** handles user authentication and acts as the serverless backend (database, file storage, request queueing).
2. **MCP OAuth** — after login, the embed exchanges the Skapi session tokens for an MCP access token via `/oauth/session-exchange` (no browser redirect needed). The token is cached in `localStorage`.
3. **AI requests** are made through `skapi.clientSecretRequest`, which keeps your Claude / OpenAI API key secure on the Skapi edge — it is never sent to the browser.
4. Chat history is fetched with `skapi.clientSecretRequestHistory` and merged with the live message list. Pending (in-flight) requests are polled every 4 seconds until they resolve.

---

## Customisation

### Mounting styles

The widget mounts inside the element you provide. Control its size via CSS on that element:

```css
#bq-client {
    width: 800px;
    height: 600px;
    border: 1px solid #ccc;
}
```

### CSS custom properties

All colours are CSS custom properties scoped to `.bq-agent`:

| Variable | Default | Usage |
|----------|---------|-------|
| `--bq-ink` | `#111` | Primary text |
| `--bq-paper` | `#fff` | Background |
| `--bq-muted` | `#666` | Secondary text |
| `--bq-line` | `#c8c8c8` | Borders |
| `--bq-hover-bg` | `#ebebeb` | Hover states |
| `--bq-pink` | `#c2185b` | Links |
| `--bq-danger` | `#c44` | Destructive actions |

Override them on a parent element:

```css
#bq-client {
    --bq-ink: #1a1a2e;
    --bq-paper: #f5f5f5;
    --bq-pink: #7c3aed;
}
```

---

## Requirements

- A [Skapi](https://www.skapi.com) project with an AI agent configured (Claude or OpenAI).
- A modern browser with `crypto.subtle`, `fetch`, and ES2020 support.
- Node.js 16+ (dev server only).

---

## License

ISC
