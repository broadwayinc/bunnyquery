# BunnyChat

An embeddable, dependency-free AI chat widget for [Skapi](https://skapi.com)-powered
projects. Drop it into any web page and your users get a full chat experience —
account login/signup, conversation history, file & folder uploads, and a settings
panel — all talking to your project's **BunnyQuery** AI agent.

BunnyChat is a standalone vanilla-JS port of the BunnyQuery (www.skapi.com) agent
chatbox. It ships as a single IIFE that exposes `window.BunnyChat`, plus one
stylesheet. No build step, no framework, no npm install.

## Features

- **AI chat** against your project's configured agent (Claude or OpenAI under the
  hood), with streaming-style "Thinking…" indicators and a background indexing queue.
- **Authentication** — email/password login, optional signup, password change,
  email verification, account recovery, and "Sign in with Google".
- **Conversation history** — paginated, with "Fetching history…" indicators on
  first load and on scroll-up.
- **Attachments** — drag-and-drop files and folders, per-file upload status
  (uploading / failed / indexed), and overflow collapsing for large batches.
- **Settings panel** — in-place inside the chat: light/dark theme, account details,
  newsletter subscription, clear history, and remove account.
- **Theming** — light and dark modes via CSS custom properties; the choice is
  remembered in `localStorage` and falls back to the OS preference.

## Requirements

- A Skapi service (you need its **service ID**).
- The [`skapi-js`](https://www.npmjs.com/package/skapi-js) SDK loaded on the page.
- A mount element with an explicit height (the widget fills its container).

## Quick start

Add the two BunnyChat files and the Skapi SDK, give it a sized container, then
call `BunnyChat.init()`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Skapi SDK + BunnyChat -->
  <script src="https://cdn.jsdelivr.net/npm/skapi-js@latest/dist/skapi.js"></script>
  <link rel="stylesheet" href="bunnyquery.css" />
  <script src="bunnyquery.js"></script>
</head>
<body style="margin: 0">
  <!-- The widget fills this element, so give it a height -->
  <div id="chatbox" style="width: 100%; height: 100dvh"></div>

  <script>
    // 1. Create your Skapi instance
    const skapi = new Skapi("<your-service-id>", { autoLogin: true });

    // 2. Mount BunnyChat into the container
    BunnyChat.init(skapi, "chatbox", {
      theme: "light",
      signup: true,
    });
  </script>
</body>
</html>
```

That's it — BunnyChat takes over the `#chatbox` element and renders the login or
chat view depending on the user's session.

## Files

| File            | Purpose                                                        |
| --------------- | ------------------------------------------------------------- |
| `bunnyquery.js`  | The widget. Exposes the global `window.BunnyChat`.            |
| `bunnyquery.css` | All styles, scoped under `.bq-agent` / `[data-bq-theme]`.    |

Host them yourself (same origin recommended) or from a CDN.

## API

### `BunnyChat.init(skapi, target, opts?)`

Mounts the widget. Returns the `BunnyChat` object.

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

### Methods

The `BunnyChat` global also exposes:

| Method               | Description                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `setTheme(theme)`    | Apply `"light"` or `"dark"` and persist it.                       |
| `toggleTheme()`      | Switch between light and dark.                                    |
| `logout()`           | Sign the current user out and return to the login view.           |
| `version`            | The widget version string.                                        |

```js
BunnyChat.setTheme("dark");
BunnyChat.toggleTheme();
BunnyChat.logout();
```

> `init()` is idempotent — calling it twice logs a warning and returns the existing
> instance rather than re-mounting.

## Theming

BunnyChat is themed with CSS custom properties (`--bq-*`) under a
`[data-bq-theme="light"|"dark"]` attribute that the widget sets on its own root.
To customize colors, override the variables in your own stylesheet **after**
`bunnyquery.css`, scoped to `.bq-agent`:

```css
.bq-agent {
  --bq-pink: #ff4fa3;
  --bq-ink: #111;
}
```

The active theme is saved to `localStorage`, so a returning user keeps their choice.

## OAuth & redirects

BunnyChat connects to your AI agent through an MCP OAuth server
(`mcp.broadwayinc.computer` in production, `mcp-dev.broadwayinc.computer` when
`dev: true`). After authorization, the OAuth server redirects back to **the current
host page** — BunnyChat reads the `?code=…&state=…` parameters, completes the
exchange, and cleans them from the URL automatically. No dedicated callback page is
needed; just make sure the page that hosts the widget is a stable, reachable URL.

## Notes

- The widget fills its mount element. Give that element a real height (e.g.
  `height: 100dvh`) or it will collapse.
- File and folder uploads are stored in your Skapi project's database storage and
  served from a temporary db-CDN URL (`hostDomain`); links in chat refresh on expiry.
- The agent shown in the header (`BunnyQuery · <project name>`) reflects the project
  configured for your Skapi service.
