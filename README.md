# BunnyQuery

An embeddable, dependency-free AI chat widget for [Skapi](https://www.skapi.com)-powered
projects. Drop it into any web page and your users get a full chat experience —
account login/signup, conversation history, file & folder uploads, and a settings
panel — all talking to your project's **BunnyQuery** AI agent.

BunnyQuery is a standalone vanilla-JS port of the BunnyQuery (www.bunnyquery.com) agent
chatbox. The **widget** ships as a single IIFE that exposes `window.BunnyQuery` plus one
stylesheet — drop it in via `<script>`, no build step or framework required.

The package also exports the **framework-agnostic chat engine** that powers it
(`bunnyquery/engine`) — the same DOM-free core the Skapi admin chatbox consumes — so
you can build your own chat UI on top of it. See
[Importing the chat engine](#importing-the-chat-engine).

## Features

- **AI chat** against your project's configured agent (Claude or OpenAI under the
  hood), with streaming-style "Thinking…" indicators and a background indexing queue.
- **Authentication** — email/password login, optional signup, password change,
  email verification, account recovery, and "Sign in with Google".
- **Conversation history** — paginated, with "Fetching history…" indicators on
  first load and on scroll-up.
- **Attachments** — drag-and-drop files and folders, per-file upload status
  (uploading / failed / indexed), and overflow collapsing for large batches.
- **Attachment parser plugins** — register a client-side parser so the widget
  extracts text in the browser from formats the model can't otherwise read, and
  indexes it directly. See [Attachment parser plugins](#attachment-parser-plugins).
- **Settings panel** — in-place inside the chat: light/dark theme, account details,
  newsletter subscription, clear history, and remove account.
- **Theming** — light and dark modes via CSS custom properties; the choice is
  remembered in `localStorage` and falls back to the OS preference.

## Requirements

- A BunnyQuery project (you need its **project ID**).
- The [`skapi-js`](https://www.npmjs.com/package/skapi-js) SDK loaded on the page.
- A mount element with an explicit height (the widget fills its container).

## Quick start

Add the two BunnyQuery files and the Skapi SDK, give it a sized container, then
call `BunnyQuery.init()`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Skapi SDK + BunnyQuery -->
  <script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bunnyquery@latest/bunnyquery.css" />
  <script src="https://cdn.jsdelivr.net/npm/bunnyquery@latest/bunnyquery.js"></script>
</head>
<body style="margin: 0">
  <!-- The widget fills this element, so give it a height -->
  <div id="chatbox" style="width: 100%; height: 100dvh"></div>

  <script>
    // 1. Create your Skapi instance
    const skapi = new Skapi("<your-project-id>", { autoLogin: true });

    // 2. Mount BunnyQuery into the container
    BunnyQuery.init(skapi, "chatbox", {
      theme: "light",
      signup: true,
    });
  </script>
</body>
</html>
```

That's it — BunnyQuery takes over the `#chatbox` element and renders the login or
chat view depending on the user's session.

## What's in the package

| Path                          | Purpose                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `bunnyquery.js`               | The widget IIFE. Exposes the global `window.BunnyQuery`. CDN / `<script>` drop-in. |
| `bunnyquery.css`              | The widget's full stylesheet, scoped under `.bq-agent` / `[data-bq-theme]`.      |
| `bunnyquery/engine`           | The framework-agnostic chat engine — ships as ESM + CJS with TypeScript types.   |
| `bunnyquery/styles/chat.css`  | The shared chat-surface styles (bubbles, markdown, links) for an engine-built UI. |

The two widget files can be hosted yourself (same origin recommended) or loaded from a
CDN — no npm needed. The `engine` / `styles` subpaths are for bundler consumers
(`npm install bunnyquery`); see [Importing the chat engine](#importing-the-chat-engine).

## API

### `BunnyQuery.init(skapi, target, opts?)`

Mounts the widget. Returns the `BunnyQuery` object.

| Argument | Type                  | Description                                                        |
| -------- | --------------------- | ----------------------------------------------------------------- |
| `skapi`  | `Skapi`               | A constructed Skapi instance. **Required.**                       |
| `target` | `string \| Element`   | The mount element, or the `id` of one. **Required.**              |
| `opts`   | `object`              | Options (see below). Optional.                                    |

### Options

| Option                   | Type      | Default  | Description                                                                                  |
| ------------------------ | --------- | -------- | -------------------------------------------------------------------------------------------- |
| `theme`                  | `string`  | `"light"`| Initial theme, `"light"` or `"dark"`. Overridden by a remembered choice or OS preference.    |
| `signup`                 | `boolean` | `false`  | Enable signup flows (and account remove/recover). When `false`, only existing users can log in. |
| `googleClientId`         | `string`  | `null`   | Google OAuth client ID. Set this to show "Sign in with Google".                              |
| `googleClientSecretName` | `string`  | `"ggl"`  | The Skapi client-secret name holding your Google OAuth secret.                               |
| `signupConfirmationUrl`  | `string`  | `null`   | Link target used in the signup confirmation email. Defaults to the current page URL.         |
| `dev`                    | `boolean` | `false`  | Use the development MCP host and `skapi.app` db-CDN host instead of production.               |
| `mcpBaseUrl`             | `string`  | `null`   | Override the MCP OAuth server base URL entirely (advanced).                                   |
| `hostDomain`             | `string`  | `null`   | db-CDN host for temporary file URLs. Defaults to `skapi.app` (dev) / `skapi.com` (prod).     |
| `attachmentParsers`      | `array`   | `null`   | Client-side attachment parsers. See [Attachment parser plugins](#attachment-parser-plugins). |

### Methods

The `BunnyQuery` global also exposes:

| Method                             | Description                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `setTheme(theme)`                  | Apply `"light"` or `"dark"` and persist it.                                          |
| `toggleTheme()`                    | Switch between light and dark.                                                       |
| `logout()`                         | Sign the current user out and return to the login view.                             |
| `registerAttachmentParser(parser)` | Register a client-side attachment parser. May be called before or after `init()`. See [Attachment parser plugins](#attachment-parser-plugins). |
| `version`                          | The widget's package version string. Also logged to the console on `init()`.        |

```js
BunnyQuery.setTheme("dark");
BunnyQuery.toggleTheme();
BunnyQuery.logout();
```

> `init()` is idempotent — calling it twice logs a warning and returns the existing
> instance rather than re-mounting. On a successful mount it logs its version, e.g.
> `[bunnyquery] v1.3.5`.

## Attachment parser plugins

By default the chat agent reads most uploads via the model's `web_fetch` tool
(text, CSV, PDF, …), and Office/OpenDocument/EPUB files are extracted on the
server. For any format that can be read by **neither** (e.g. a proprietary
binary format), register a **parser plugin**: it runs in the browser, turns the
uploaded file into text (or an HTML string), and the widget sends that content
**inline** for indexing — no `web_fetch`, no server extraction for that file.

BunnyQuery ships only the **mechanism**. You bring the parsing library (so the
widget stays lean and you choose which formats and which library).

A parser is a plain object:

```ts
interface AttachmentParser {
  name?: string;                                   // label, used in logs
  match: (file: { name: string; mime?: string }) => boolean;   // handle this file?
  parse: (file: File) => string | null | undefined | Promise<string | null | undefined>; // text or HTML; falsy = skip
}
```

The first parser whose `match` returns `true` wins. A parser that throws or
returns nothing is ignored — the file falls back to its normal path. Output is
capped (~200k chars) before it is inlined.

### Example

Load whatever parsing library reads your format, then register a parser that
turns a `File` into text:

```html
<!-- bring your own parsing library, e.g. from a CDN -->
<script src="https://cdn.example.com/my-format-parser.js"></script>
<script>
  BunnyQuery.registerAttachmentParser({
    name: "my-format",
    match: (file) => /\.myext$/i.test(file.name),
    parse: async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return window.myFormatParser.toText(bytes); // return plain text OR an HTML string
    },
  });

  BunnyQuery.init(skapi, "chatbox", { theme: "light" });
</script>
```

Equivalent one-shot form via init options:

```js
BunnyQuery.init(skapi, "chatbox", {
  attachmentParsers: [ myParser ],
});
```

Bundler consumers can import the same registry from the engine:

```js
import { registerAttachmentParser } from "bunnyquery/engine";
registerAttachmentParser(myParser);
```

## Theming

BunnyQuery is themed with CSS custom properties (`--bq-*`) under a
`[data-bq-theme="light"|"dark"]` attribute that the widget sets on its own root.
To customize colors, override the variables in your own stylesheet **after**
`bunnyquery.css`, scoped to `.bq-agent`:

```css
.bq-agent {
  --bq-main: #ff4fa3;
  --bq-ink: #111;
}
```

The active theme is saved to `localStorage`, so a returning user keeps their choice.

## Importing the chat engine

`bunnyquery.js` is the ready-made widget. Under it sits a **framework-agnostic,
DOM-free chat engine** — the same core that powers both this widget and the Skapi
admin chatbox. Import it from `bunnyquery/engine` when you want to build your own chat
UI (React, Vue, Svelte, vanilla…) while reusing the engine's message/queue/typewriter/
cache state machine, request builders, markdown-message composition, and prompts.

Install the package, plus the `skapi-js` SDK (for the transport) and — if you don't
already have one — a markdown renderer such as `marked`:

```bash
npm install bunnyquery skapi-js marked
```

```ts
import {
  configureChatEngine,
  ChatSession,
  composeUserMessage,
  type ChatHost,
} from 'bunnyquery/engine';

// Shared chat-surface styles (message bubbles, rendered markdown, links).
// Pair it with your own container/layout CSS and the --bq-* design tokens.
import 'bunnyquery/styles/chat.css';

// 1. Inject the skapi transport + MCP endpoint ONCE at startup.
configureChatEngine({
  clientSecretRequest: (opts) => skapi.clientSecretRequest(opts),
  clientSecretRequestHistory: (params, fetchOptions) =>
    skapi.clientSecretRequestHistory(params, fetchOptions),
  mcpBaseUrl: 'https://mcp.broadwayinc.computer',
  poll: 0, // see the note below
});

// 2. Implement a ChatHost (identity, render/scroll hooks, the skapi
//    cancel/refresh surface) for your view, then drive a ChatSession.
const session = new ChatSession(host); // host: ChatHost
await session.loadHistory();
session.dispatchComposedMessage('Hello!'); // send a message
```

The engine owns chat **state and logic** and calls back into your view through the
`ChatHost` interface (render, scroll, identity, cancel/refresh). It has **no bundled
runtime dependencies** — you inject the skapi transport via `configureChatEngine()` and
render markdown yourself (e.g. with `marked`). Everything is fully typed: `ChatSession`,
`ChatHost`, `ChatMessage`, `ChatIdentity`, `ChatState`, `composeUserMessage`, the request
builders (`callClaudeWithPublicMcp` / `callOpenAIWithPublicMcp`, `getChatHistory`,
`notifyAgentSaveAttachment`), the prompt builders, and the token-budget / link / history
helpers — see the `.d.ts` shipped with `bunnyquery/engine`.

`configureChatEngine` options:

| Option                        | Type       | Description                                                                                                   |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `clientSecretRequest`         | `function` | `skapi.clientSecretRequest`, bound to your Skapi instance. **Required.**                                      |
| `clientSecretRequestHistory`  | `function` | `skapi.clientSecretRequestHistory`, bound to your Skapi instance. **Required.**                              |
| `mcpBaseUrl`                  | `string`   | MCP server base URL (you resolve prod vs dev). **Required.**                                                  |
| `poll`                        | `number?`  | Value attached as `poll` on every request. Omit it if your `clientSecretRequest` already resolves with the final body; pass `0` for the deployed `skapi-js@latest` (needed for the early ack + a manual `.poll()` handle that powers queued-send cancel — the widget's case). |

## OAuth & redirects

BunnyQuery connects to your AI agent through an MCP OAuth server
(`mcp.broadwayinc.computer` in production, `mcp-dev.broadwayinc.computer` when
`dev: true`). After authorization, the OAuth server redirects back to **the current
host page** — BunnyQuery reads the `?code=…&state=…` parameters, completes the
exchange, and cleans them from the URL automatically. No dedicated callback page is
needed; just make sure the page that hosts the widget is a stable, reachable URL.

## Notes

- The widget fills its mount element. Give that element a real height (e.g.
  `height: 100dvh`) or it will collapse.
- File and folder uploads are stored in your Skapi project's database storage and
  served from a temporary db-CDN URL (`hostDomain`); links in chat refresh on expiry.
- The agent shown in the header (`BunnyQuery · <project name>`) reflects the project
  configured for your Skapi service.
