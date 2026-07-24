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
  (uploading / failed / indexed), overflow collapsing for large batches, and a
  prompt when an upload hits a file that already exists (skip / reindex only /
  overwrite, with "apply to all remaining"). Images are read with vision/OCR,
  large documents and spreadsheets are read window by window, PDFs are rendered
  to page images, and everything else extractable is inlined as text. See
  [Supported file types](#supported-file-types).
- **Background indexing**: an uploaded file is indexed in the background,
  across as many passes as it takes. A file's passes collapse into a single
  status row in the chat that can be expanded, and stopped: "Stop" cancels every
  queued and running pass at once and ends the continuation chain.
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
> `[bunnyquery] v1.7.0`.

See [HISTORY.md](HISTORY.md) for the release-by-release changelog.

## Supported file types

When a user attaches a file, BunnyQuery makes its contents available to the AI
automatically, detected by extension (with a MIME-type fallback), nothing to
configure.

An attachment is used in two places, and they take different routes:

- **In the chat message.** Extractable files are inlined as text; anything else
  (PDFs, images) is handed over as a temporary link, which the proxy worker
  re-mints just before the upstream call so a queued message can never hand the
  model a stale URL.
- **In background indexing**, where the file is read in full and saved into the
  project's knowledge. This is the path with the window and page loops below.

The routes are tried in this order: a [parser plugin](#attachment-parser-plugins),
then PDF page rendering, then windowed or paged reading, then server-side
extraction, then a plain link.

### 1. Images: read directly by the model (vision + OCR)

`.jpg` · `.jpeg` · `.png` · `.gif` · `.webp`

The image is attached to the request inline, so the model both **describes the
picture** and **reads any text in it (OCR)**. Works on both Claude and OpenAI.
Only images referenced in the **most recent** message are inlined (older links
may have expired).

### 2. PDFs: rendered to page images

`.pdf`

PDF text layers are often absent or unreliable, so a PDF is indexed **visually**:
the proxy worker renders a window of pages (5 at a time) to images and injects
them as image blocks in the indexing message. Tool-result images render on
neither provider, which is why the pages have to be in the message itself. That
makes scanned PDFs work as well as digital ones.

The worker advances the window itself, off its renderer's true page count, and
enqueues the next pass. Indexing a long document therefore does not depend on
the browser tab staying open, and does not depend on the model correctly
declaring itself finished.

### 3. Large documents, spreadsheets & data: read window by window

```
.xls .xlsx .xlsm .ods      grids (rows plus embedded photos)
.csv .tsv .tab             row-bounded windows with absolute row numbers
.docx .pptx                documents
.txt .md .markdown .log    plain text
.json .jsonl .ndjson .xml .yaml .yml
```

These are read **one window at a time** and continued until the file is
exhausted, rather than inlined once. Whole-file extraction is capped at 200,000
characters, and against real files that cap was discarding most of every large
upload: a 5MB `.txt` indexed 4.0% of its content, a 4.8MB `.json` 4.2%, a
1.9M-character Korean `.txt` 10.5%, a `.docx` 70.6%. Nothing surfaced the loss,
because the agent received a plausible-looking document with no way to know most
of it was missing.

Two drivers exist for this loop. By default the agent pages the file itself with
the `readFileContent` tool. With the engine's `windowedIndexing` option enabled,
the **worker** reads a window per request and continues from the reader's own
cursor, so the traversal no longer has to fit inside the model's turn budget.
That option is off by default and must only be turned on against a deployed
worker (see [Importing the chat engine](#importing-the-chat-engine)); the widget
does not enable it.

### 4. Everything else extractable: inlined as text server-side

The skapi proxy downloads the file, extracts its text **server-side**, and
inlines that text into the request, so the model reads it directly with no
fetching. This keeps indexing consistent across model providers.

**Office & e-book** (binary/zip, parsed):
`.docx` · `.xlsx` · `.pptx` · `.hwp` · `.hwpx` · `.ods` · `.odt` · `.odp` · `.epub`

**Text, data, markup & source code** (decoded as text; `.html`/`.htm` have their
tags stripped):

```
.csv .tsv .tab .txt .text .log .md .markdown .rst .json .ndjson .jsonl .geojson
.xml .yaml .yml .toml .ini .conf .cfg .properties .env .rtf .html .htm
.js .mjs .cjs .ts .tsx .jsx .py .rb .go .rs .java .kt .c .h .cpp .cc .hpp .cs
.php .swift .sh .bash .zsh .sql .css .scss .less .vue .svelte .tex .srt .vtt
```

Plus a **MIME fallback**: any file whose content type is text-like (`text/*`,
`application/json`, `application/xml`, `*+json`, `*+xml`, `*+yaml`, …) is decoded
even when its extension isn't in the list above.

Encoding is auto-detected: UTF-8 (BOM-aware), then CP949/EUC-KR (Korean), then
Latin-1. Extracted text is capped at **200,000 characters**; longer files are
truncated with a `...[truncated for length; original N characters]` marker. The
formats listed in section 3 are windowed precisely so they never hit that cap.

Note the overlap between sections 3 and 4 is deliberate: a `.docx` or a `.csv`
is windowed when it is indexed, and extracted whole when it rides along in a
chat message.

### 5. Anything else: a plain link

A file that is none of the above is handed to the model as a temporary link,
which it opens with its built-in web tool: **Claude** via `web_fetch`, **OpenAI**
via `web_search` (external web access is enabled).

> A provider's web tool opens document/page-style URLs, but not necessarily a
> bare *data-file* download (e.g. a raw `.csv`/`.tsv` link). That is why those
> data formats are extracted server-side instead of being left to the model.

### Caveats

- **Legacy / macro Office** — `.doc` `.xls` `.ppt` (legacy binary) and `.docm`
  `.xlsm` `.pptm` (macro-enabled) have no reliable server-side reader. They
  upload fine but are indexed from **metadata only**; re-save as
  `.docx` / `.xlsx` / `.pptx` (or PDF) to capture their contents.
- **Anything else** — a format covered by none of the above is indexed from its
  metadata. To support it, register your own
  [Attachment parser plugin](#attachment-parser-plugins) — it runs in the browser
  and feeds parsed text straight into indexing.

### Re-indexing an existing file

Uploading over a file that already exists prompts for skip, "reindex only", or
overwrite. Choosing either of the latter two deletes the file's existing
`src::<path>` index record first, and the skapi backend cascades that delete to
the record's reference-linked children, so re-indexing **replaces** the file's
knowledge rather than duplicating it.

### Filenames

Storage keys preserve Unicode letters, digits and spaces, NFC-normalized, so
Korean, Japanese and accented Latin filenames survive upload intact. Only
genuinely unsafe characters are replaced. The original name is always kept for
display.

## Attachment parser plugins

By default the chat agent reads images with vision/OCR, renders PDF pages to
images, reads large documents and spreadsheets window by window, and extracts
Office/OpenDocument/EPUB and text/data/code files on the server. See
[Supported file types](#supported-file-types). For any format read by **none**
of these (e.g. a proprietary binary format), register a **parser plugin**: it
runs in the browser, turns the uploaded file into text (or an HTML string), and
the widget sends that content **inline** for indexing. A parser plugin takes
precedence over every other route, so nothing is fetched or extracted for that
file.

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
| `attachmentParsers`           | `array?`   | Client-side attachment parsers, registered at configure time. More can be added later with `registerAttachmentParser()`. See [Attachment parser plugins](#attachment-parser-plugins). |
| `windowedIndexing`            | `boolean?` | Opt in to **server-driven** windowed indexing for text and grid files (see [file types](#supported-file-types)). Off by default and must stay off until the worker that strips the `_skapi_window` directive is deployed: against an older worker the directive reaches the provider as an unknown body field and the call fails terminally with no retry. |

### Display and paging helpers

Two shared transforms exist so that a second chat UI behaves identically to the
widget rather than approximately:

- **`buildChatDisplayList`** collapses a file's many background-indexing turns
  into one status row per indexing run, wherever those turns sit in the
  conversation, rendered at that run's newest turn. It is pure and
  view-agnostic; you render the resulting `DisplayEntry` list. Pair it with
  `ChatSession.cancelIndexingGroup(group)` to give the row a working Stop
  button, which cancels every queued and running pass of that file at once and
  ends the continuation chain.
- **`fillHistoryViewport` / `createHistoryFiller`** keep older history
  reachable. Paging is triggered only by scrolling to the top of the message
  box, so a box too short to scroll has no trigger at all, which is the normal
  state once a page of history collapses into a single indexing row. Implement
  the optional `ChatHost.onHistoryLoaded` hook, measure your own box, and let
  the loop page until the reader genuinely gained reachable content.

Other optional `ChatHost` hooks worth implementing: `deleteExistingFileRecord`
(so a reindex replaces the file's knowledge instead of duplicating it) and
`promptOverwrite` (the skip / reindex / overwrite prompt).

`ChatSession.pausePolling(reason)` and `resumePolling(reason)` stop background
indexing polls when nobody is looking (a hidden tab, a detached view). Replies
the user is waiting on keep polling deliberately, so their results still land in
the cache. Server-side work is untouched either way, so pausing drops traffic,
never progress.

## OAuth & redirects

BunnyQuery connects to your AI agent through an MCP OAuth server
(`mcp.broadwayinc.computer` in production, `mcp-dev.broadwayinc.computer` when
`dev: true`). After authorization, the OAuth server redirects back to **the current
host page** — BunnyQuery reads the `?code=…&state=…` parameters, completes the
exchange, and cleans them from the URL automatically. No dedicated callback page is
needed; just make sure the page that hosts the widget is a stable, reachable URL.

Once granted, the connection is kept alive **silently**. When the stored grant
ages out, BunnyQuery refreshes it through the OAuth `refresh_token` flow with no
redirect, so an embedded widget never yanks the host page away mid-chat. It also
refreshes on tab focus, because returning to a backgrounded tab after the grant
expired would otherwise disconnect the next message. The full redirect is only a
boot-time fallback for when the silent path cannot refresh.

## Notes

- The widget fills its mount element. Give that element a real height (e.g.
  `height: 100dvh`) or it will collapse.
- File and folder uploads are stored in your Skapi project's database storage and
  served from a temporary db-CDN URL (`hostDomain`); links in chat refresh on expiry.
  Links a queued message carries are re-minted server-side immediately before the
  upstream call, so a message that waits in the queue never hands the model a dead
  URL.
- The number of files attachable to a single message is capped, and beyond a
  point the chips collapse into a "...(n) more" pill rather than being rendered.
  Very large batches belong on a dedicated upload page, not the chat composer.
- When your service database is frozen, the attach button and drag-and-drop are
  hidden for non-admin users, mirroring the backend's own upload gate, so there
  is no upload path that fails only at the end.
- The agent shown in the header (`BunnyQuery · <project name>`) reflects the project
  configured for your Skapi service.
