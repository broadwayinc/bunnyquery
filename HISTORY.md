# BunnyQuery release history

Changes to the widget (`bunnyquery.js` / `bunnyquery.css`) and the chat engine
(`bunnyquery/engine`) from the start of the current 1.x source line to today.

A few notes on how to read this:

- **Published vs built.** The latest version on npm is **1.6.2**. Versions
  1.6.3, 1.6.4 and 1.7.0 are built in the source tree but not yet published, and
  are marked as such.
- **Missing patch numbers.** A few versions on npm (1.2.1 most notably) are
  republishes with no distinct source commit behind them, so they have no entry
  here. Version 1.6.1 is the reverse case: it has commits but was never
  published on its own, and its changes reached npm inside 1.6.2.
- Both chat clients (this widget and `agent.vue` on www.bunnyquery.com) consume
  the same engine, so an engine fix only reaches www.bunnyquery.com once the
  package is republished.

---

## 1.7.0 (2026-07-23, latest published)

Per-run indexing rows, and making older history reachable once a page of it
collapses into a single row.

### Collapsed rows are now per indexing RUN, not per file

- `IndexingGroup` gained `runKey` (the render and expansion key) alongside `key`
  (the file identity that `cancelIndexingGroup` matches on). A file indexed on
  Monday and re-indexed on Wednesday is two rows. Collapsing them into one had
  erased Monday's row from Monday's place in the conversation, claimed its
  passes for Wednesday, and let Monday's failure be overwritten by Wednesday's
  success.
- A run is named after its first loaded pass rather than an ordinal, so paging
  in older history never renames a row already on screen (an ordinal renumbers
  from either end and silently moves the user's expansion to a row they never
  opened).
- **Stale-pass rule.** A pass still marked queued or running with a settled pass
  after it is treated as stale history, not live work. Pages reached by
  scrolling up get no poll attached to resolve them, so one stale row used to
  flip a long-finished file back to a spinner with a Stop button aimed at a dead
  item id, permanently.
- A failed Stop ("Could not remove from queue") is reported only while the stop
  is still something the user can act on, instead of a row that went on to
  finish normally describing a one-off transient failure as a permanent property
  of the file.
- Response bubbles attach to the **immediately preceding** request only. Falling
  back to the last file seen anywhere above swallowed stray background bubbles
  into whichever file happened to be indexed most recently, however much
  unrelated conversation sat in between.

### History viewport fill (new engine module)

New `src/engine/viewport_fill.ts`, exported as `fillHistoryViewport`,
`createHistoryFiller`, `HISTORY_FILL_SLACK_PX` (64) and
`MAX_HISTORY_FILL_PAGES` (24).

- Older history is paged in by exactly one trigger: scrolling to the top of the
  message box. Collapsed indexing rows kill that trigger two ways. A file's
  every pass folds into one row, so a full history page (twenty-plus messages)
  can render as a single line that never overflows and never fires a scroll
  event. And a fetched page that is entirely the same file's earlier passes
  joins the row already on screen and adds no reachable height, leaving the
  reader pinned at `scrollTop` 0 where scrolling up again fires nothing.
- Both are the same shape, so the engine exposes one loop that keeps fetching
  until the caller's `isSatisfied` predicate passes, history runs out, or the
  pager stops advancing. The loop is DOM-free; the caller supplies the
  measurement and awaits its own render.
- New optional `ChatHost.onHistoryLoaded(fetchMore, token)` hook. Only the view
  can measure, so the engine announces the load and the view pages out of it.
- The widget runs the fill after every first-page load, after a scroll-up that
  revealed nothing, on window resize, and when the settings panel closes (the
  panel occupies the messages box and suppresses `renderMessages`).

### Row-anchored scroll restore

- `renderMessages` now captures the top visible row and its offset and puts that
  row back, instead of restoring a raw `scrollTop`. A full re-render detaches
  every child, which collapses `scrollHeight` and makes the browser clamp
  `scrollTop` to 0, so a reader scrolled up into history was yanked to the very
  top on every re-render (an arriving indexing turn, a poll resolving, a
  response streaming in) and landed on the pager trigger while they were at it.
- Restoring the raw offset is not enough either, because rows move: a collapsed
  row renders at its file's newest turn, so a new pass jumps it to the bottom
  and slides everything below it up by a row.
- Anchor identity is the server item id (or local id), never the array index,
  which every prepend renumbers. An ordinary message row is always preferred; a
  collapsed row is used only when nothing else is on screen and only if it did
  not move (`data-row-pos` names the turn it is anchored at).

### Fixed

- **Invisible replies no longer block the visible one.** A background indexing
  reply inside a collapsed row is written straight in rather than typewritten.
  Typewriting it put it on the single serial typewriter queue, so the user's own
  next reply lost its "Thinking..." spinner and sat as an empty bubble for as
  long as the invisible indexing summary took to reveal (seconds per pass,
  additive across files). It also held `state.typing` true throughout, which
  disables the platform and model pickers and no-ops Clear history, and ran a
  per-frame scroll for content nobody can see.
- **Queued passes settle.** Only a running pass gets an assistant placeholder,
  so for a queued one every resolution branch was skipped and the request bubble
  stayed `isPendingQueued` with its queue entry about to be spliced away, i.e.
  no poll left to ever clear it. One such bubble pinned a whole row to "active"
  until a page reload. The request bubble is now settled unconditionally, and a
  failed queued pass gets an error placeholder inserted after it so the row
  reports the failure instead of quietly settling to "Indexed".
- In-flight cancel flags are carried across bubble replacement, so a row
  mid-cancel keeps "Stopping..." rather than re-offering Stop, whose second
  click cancelled an id that was already gone and wrote a bogus failure onto a
  run that had been stopped successfully.
- Stopped passes are rebuilt from the mapped bubble rather than a bare literal,
  keeping `isBackgroundTask` / `_indexFile` so they stay in their row instead of
  rendering as a standalone "Indexing: &lt;file&gt;" bubble.
- Background-ness is read from whichever bubble actually exists. A queued pass
  has no assistant placeholder, so reading it off the placeholder alone
  classified every queued indexing pass as foreground, ejected it from its row,
  and span up a "Thinking..." on an unrelated queued foreground message.

---

## 1.6.4 (unpublished)

Collapsed background-indexing rows, and a Stop button that actually ends the
chain.

### Added

- **New engine module `src/engine/indexing_groups.ts`**: `buildChatDisplayList`,
  `parseIndexingLabel`, and the `IndexingGroup` / `DisplayEntry` /
  `IndexingGroupStatus` / `BuildDisplayListOptions` types. A file's many
  background-indexing turns (the first pass plus up to
  `MAX_INDEXING_RESUME_PASSES` continue passes, each with a request *and* a
  response bubble) collapse into ONE row, rendered at that file's **newest**
  turn. Newest, so a running index sits at the bottom where the activity is and
  paging older history in never moves a row already on screen. Pure and
  view-agnostic, so both chatboxes group identically.
- `IndexingFileRef` stamped on background-indexing request bubbles (`_indexFile`)
  so grouping never has to reverse-parse the view's formatted label. Label
  parsing survives only as the fallback for bubbles restored from a history
  cache written before the ref existed.
- A group reports state (indexing / indexed / failed), how many passes are
  currently **loaded**, and `mayHaveOlder`. Deliberately never a server-side
  total: history pages newest-first, so any total computed from loaded messages
  is a lower bound a later scroll-up would contradict.
- **`ChatSession.cancelIndexingGroup(group)`**: stop indexing a file from its
  row, every pass at once. A big file is indexed as a chain, so cancelling only
  the live pass accomplishes nothing. Three things end it: every queued or
  running pass is cancelled server-side (which is also the worker's gate for not
  enqueueing the next window), the file is remembered in `cancelledIndexKeys` so
  the client-driven resume stops dispatching, and any of its passes still in
  `bgTaskQueue` is dropped by the next drain. Records already written are kept:
  this stops the work, it does not undo it.
- A fresh first pass (a re-upload, or a Reindex from the file manager) lifts the
  stop, so stopping a file never poisons that storage path forever.
- `_sweepCancelledIndexing` cancels a worker-enqueued pass of a stopped file
  that arrives through the history poll rather than through `bgTaskQueue`. The
  worker's own gate stops the chain when the running row is cancelled, but if
  the row had already finished when the user hit Stop, the next window was
  queued a moment earlier and still arrives.
- Cancellation keys are scoped per chat (`chatKey|fileKey`). A storage path is
  project-relative and one `ChatSession` serves every project, so unscoped keys
  would have suppressed the same filename's continuations in another project.
- Widget UI: `.bq-index-group` with an inlined SVG status glyph (spun by CSS, no
  icon font), the file as a bare storage-path markdown link so a click mints a
  fresh temporary URL, a loaded-pass count with a `+` when the run's start is
  unpaged, a Stop button in the head (reachable without expanding), and a
  chevron. Expanded rows emit their own turns as ordinary message rows, so
  `buildMessageEl` stays the single source. Styles added to `styles/chat.css`.

### Fixed

- **A first-page refresh no longer wipes scrolled-in history.** It now preserves
  already-loaded older pages instead of blind-replacing the list with page 1.
  This path runs from `resumePolling` on `visibilitychange`, so merely leaving
  the tab and coming back threw away every page the user had scrolled in.
  Merging only happens when the current list genuinely continues this page 1
  (shares at least one id with it).
- **Duplicated question-and-answer.** Before appending a resolved reply to the
  cache, check whether a history fetch already mapped that turn in. The cache is
  restored verbatim on the next mount, so a duplicate written here survived
  every later visit.
- A cancelled indexing pass keeps its background and file markers on rebuild.
  Dropping them took it out of its file's row, so the row stayed "Indexing..."
  forever while a bare "Indexing: &lt;file&gt;" bubble appeared beside it. The
  same carry-over fixes a live-resolved pass rendering outside its group while
  the same pass rebuilt from history stayed grouped.
- The scroll after a first-page load is sticky, not forcing, so it stops yanking
  a reader who had scrolled up back to the bottom.

---

## 1.6.3 (unpublished)

- Continue passes get a compact "Indexing (continuing)" label so a big file's
  multi-window run reads as progress rather than the same task repeating.
  Mirrors `agent.vue`'s history mapping.
- **Fixed a forked continuation chain.** With windowed indexing on, the worker
  drives the text/grid loop, so the client must not also resume. Two drivers
  each enqueueing a continuation per pass produced duplicate records and runaway
  passes. Gated on the flag, so the old client-driven path is untouched when
  windowing is off.

---

## 1.6.2 (2026-07-22)

Server-driven windowed indexing, and polling that stops when nobody is looking.

### Added

- **`windowedIndexing` config flag** (off by default). When on, the client emits
  a `_skapi_window` directive and the **worker** reads the file one window at a
  time, continuing from the reader's own cursor until the file is exhausted, so
  the traversal no longer lives inside the model's turn budget. Off by default
  deliberately: the backend must ship first, because against a worker that does
  not strip the directive it reaches the provider as an unknown body field and
  the call fails terminally with no retry. New helpers `isWindowedReadFile`,
  `makeWindowPlaceholder`, `WINDOW_CURSOR_TOKEN`, `buildIndexingWindowMessage`,
  and `windowedIndexingEnabled()`.
- **The paged-read set widened well past spreadsheets and PDFs**: `.docx`,
  `.pptx`, `.txt`, `.md`, `.markdown`, `.log`, `.json`, `.jsonl`, `.ndjson`,
  `.xml`, `.yaml`, `.yml`, plus `.csv`/`.tsv`/`.tab`. Everything outside that set
  falls back to one-shot server extraction capped at 200k characters, and
  measured against real files that cap was discarding the overwhelming majority
  of every large upload: a 5MB `.txt` indexed 4.0% (4.8M characters silently
  dropped), a 4.8MB `.json` 4.2%, a 1.9M-character Korean `.txt` 10.5%, a
  `.docx` 70.6%. The truncation was invisible: the agent received a
  plausible-looking document with no way to know most of it was missing.
- CSV/TSV specifically moved onto the windowed path, where the layer gives them
  **row-bounded** windows with absolute row numbers. The character windower used
  to split rows across boundaries and emit no row numbers at all.
- **Pausable polling**: `pausePolling(reason)`, `resumePolling(reason)` and
  `clearPauseReason(reason)`, keyed by reason so overlapping causes (view
  detached *and* tab hidden) do not resume each other prematurely. Poll entries
  now carry `kind: 'bg' | 'fg'` and the SDK's `stop` handle. Background indexing
  polls stop when the tab is hidden; foreground polls (a reply the user is
  waiting on) keep running deliberately, so their results still land in the
  cache and a user who sends a message then navigates away does not come back to
  a permanently stuck "Thinking...". Server-side work is untouched, so this only
  drops traffic, never progress.
- The widget stops background polls on `visibilitychange` and refreshes the MCP
  grant **before** resuming, or the first poll after a long hidden stretch 401s
  on an aged-out grant.

### Fixed

- **`isBgIndexingQueue` now accepts both shapes the value arrives in**: the bare
  queue name the client sends (`<userId>-bg`) and the server qid that comes back
  on history and poll responses (`<service>:<queue>|<seq>`). A qid ends in
  `|<seq>`, so `endsWith('-bg')` was always false for it, which silently meant
  history items were never recognised as background tasks.
- Bubble injection and poll attachment decoupled in the drain. An entry whose
  bubble already exists may still need a poll, which is exactly the state a
  paused drain leaves behind; returning early there stranded it as a permanent
  "Thinking..." once polling resumed.
- Anything on the background queue is pausable, not just items whose prompt text
  is recognisable as an indexing task. `_isBgTask` vs `_isOnBgQueue` is a
  *display* distinction, and keying the pause off `_isBgTask` alone left every
  unmatched bg-queue item polling forever.
- A poll stopped by `pausePolling` is not treated as a result: the bubble and
  the queue entry are left exactly as they were so resuming can re-attach.
- Entries are deleted one at a time and only when actually stopped. Wholesale
  clearing of the poll map is what previously let `loadHistory` attach a
  duplicate poll on a live item, producing duplicate replies and stranded
  "Thinking" bubbles. On an older skapi-js with no stop handle the entry is left
  in place so a later drain cannot stack a second, unstoppable poll.

---

## 1.6.1 (never published on its own; shipped inside 1.6.2)

Cross-project chat leakage, and handing the PDF page loop to the worker.

### Fixed: chat bubbles leaking between projects

The dashboard renders every project through **one** `ChatSession` singleton, so
a turn dispatched in project A could still be in `state.messages` while the
identity already pointed at project B.

- `_ownerKey` (the history cache key the bubble was created under) is stamped on
  locally created bubbles: the optimistic user message and its "Thinking..."
  placeholder. Server-mapped bubbles keep using `_serverItemId`.
- The cache write filters out bubbles belonging to another chat, so A's user and
  "Thinking..." bubbles stop being written into B's cache entry and replaying on
  every later visit to B.
- New `PinnedDispatchContext`: the serviceId, owner and system prompt are
  snapshotted at the moment the user hits Send. A send can be dispatched long
  after that (attachment uploads are awaited first), by which time a live
  identity read would silently send the turn to whichever project the user had
  navigated to.
- Off-chat resolution settles in the **owning chat's cache** rather than
  mutating whatever chat is on screen. The positional fallbacks in
  `resolveQueuedUserBubble` would otherwise hijack that chat's pending bubble,
  or push this answer onto its list.
- `sending` is cleared unconditionally when a dispatch settles. It is
  session-global, so leaving it set after a project switch wedged every
  subsequent send in **every** project onto the queued path and kept the view's
  rescue arm armed forever.
- The history fetch compares against a snapshotted key rather than a live read,
  so a project switch mid-fetch cannot make another chat's in-flight bubbles
  look local.

### Changed: the worker drives the PDF page loop

- `auto_continue` + `continue_text` hand the render chain to the worker: when
  its renderer reports pages left after a window, it builds the next pass from
  `buildIndexingRenderContinueTemplate` (substituting the window's 1-based start
  page for `RENDER_FROM_TOKEN`) and enqueues it itself. That is what makes a
  500-page document index end to end. The loop no longer depends on the tab
  staying open, nor on the model correctly declaring itself unfinished.
- The vision path no longer asks the model whether it is finished. Asking it is
  what used to end an 88-page file at page 15. The `INDEXING_COMPLETE` marker
  now governs the text/grid path only.
- The client no longer resumes vision files at all; continuing to dispatch
  alongside the worker would double-index every window.

### Fixed: image detail on suffixed models

- The OpenAI per-image `detail` resolver now tolerates a trailing variant or
  date suffix (`gpt-5.4-nano`, `-mini`, `-2026-01-01`). The pattern was anchored
  with no suffix allowed, so every suffixed model silently fell through to
  `auto`, i.e. the cheap tiers that most need resolution were the ones getting
  downsampled images. Base models keep their exact previous behavior; a suffixed
  variant resolves to `high`, which is universally supported.
- Worker-rendered document pages get their own resolution, floored at `high`.
  These are dense scans whose entire purpose is to be read, so `auto` is never
  acceptable. The worker is model-blind, so without the client telling it, the
  strongest models never got the `original` detail they support.

---

## 1.6.0 (2026-07-16)

Version bump only, republishing 1.5.7's engine.

---

## 1.5.7 (2026-07-16)

Vision indexing for PDFs, and resume across passes.

- **`isImageVisionFile`** and the `_skapi_render` directive. PDF content is
  visual and must be delivered as **image blocks in the message**, because
  tool-result images render on neither provider. The worker renders a window of
  pages to image URLs and injects them at a `makeRenderPlaceholder` token,
  distinct from the text-extraction placeholder. `RENDER_PAGES_PER_WINDOW` is 5
  and must match the server default so the client's resume window lines up.
- `buildIndexingRenderMessage` and `buildIndexingContinueMessage`. A first pass
  leads with "A new file has just been uploaded" so the client builds the
  "Indexing: &lt;name&gt;" bubble; a resume pass leads with "CONTINUE indexing"
  so it is not a duplicate primary bubble.
- **Resume across passes.** A background indexing task for a paged file that
  finished *without* the `INDEXING_COMPLETE` marker means the agent ran out of
  room, so a continue pass is dispatched that resumes from where the saved
  records leave off rather than restarting. Additive and guarded, with a cap so
  a file the agent can never mark complete stops instead of re-dispatching
  forever.
- The vision path advances one page window per pass (the worker injects a single
  window per request), so it gets a much higher cap than the text/grid path,
  which reads many windows inside a single turn.
- The completion marker is hidden from the displayed summary.

---

## 1.5.6 (2026-07-13)

- **`isPagedReadFile`**: spreadsheets and PDFs are indexed by **paging through
  the `readFileContent` tool** rather than a capped inline dump or a web_fetch
  URL. That is what lets a huge sheet be read row-window by row-window and a
  scanned PDF page image by page image, with embedded photos reaching the vision
  model. The indexing message instructs the agent to page every window and
  datafy each.

---

## 1.5.5 (2026-07-13)

- Over-cap attachment adds are **truncated and reported informationally**
  instead of blocking the composer. The notice says how many files were left
  out; the user can still send with what was attached. (1.5.4 had blocked the
  composer until the user removed files back under the ceiling.)

---

## 1.5.4 (2026-07-09)

Bulk-upload survivability and the standalone page shell.

- **`MAX_ATTACHMENT_FILE_COUNT`**, a hard ceiling enforced in
  `appendAttachments` so a 10k-file drop or select cannot freeze the tab.
  Folders count as their file count and the boundary folder is truncated. Bulk
  uploads belong on the Upload Files page, which has a bounded worker pool and
  paging.
- **`VISIBLE_CHIP_CAP`**, a hard cap on how many attachment chips are ever
  materialized as DOM nodes. The "...(n) more" pill absorbs the rest, and the
  overflow-shrink loop measures from the render cap so it is O(cap) rather than
  O(n).
- `drainBgTaskQueue` indexes messages by `_serverItemId` once, making the
  per-entry presence and pending checks O(1). The old nested scan was
  O(queue x messages) per drain, and the drain runs once per uploaded file,
  i.e. O(n^3) over a bulk upload.
- Standalone pages (login, signup, verify) get the same top-left header as the
  chat and settings views, so the service badge sits flush at the widget's top
  left instead of being indented into the centered content column, plus a
  scrollable centered page body and a footer with a www.bunnyquery.com link and
  the widget version.

---

## 1.5.3 (2026-07-08)

- **Non-Latin filenames survive upload.** Storage keys now preserve Unicode
  letters, digits and spaces (NFC-normalized first, so macOS NFD filenames yield
  a stable key) and replace only genuinely unsafe characters. The old ASCII-only
  allowlist erased whole non-Latin names, turning `외국인 고용보험.pdf` into
  `.pdf`. Both retrieval paths percent-encode per segment, so spaces and Unicode
  round-trip and match the raw S3 key on the way back, and the key is reused
  verbatim as the `src::<key>` record unique_id, which skapi does not
  character-restrict.
- **Frozen database hides the attach affordances.** When `freeze_database` is
  set and the user is below access_group 99, the clip button, file input and
  drag-drop are omitted entirely, mirroring the backend `get_signed_url` gate so
  there is no upload path at all rather than one that fails at the end.

---

## 1.5.2 (2026-07-08)

Version bump only.

---

## 1.5.1 (2026-07-08)

Just-in-time URL re-minting, and replacing rather than duplicating on reindex.

- **`FileUrlDirective` / `fileUrls`**: files the model fetches by URL (PDFs,
  images, anything not server-extractable) now carry a directive telling the
  worker to mint a fresh, short-lived URL from the storage path and swap it into
  the request body **right before** the upstream call, so a queued request never
  hands the model a stale link. Extractable files are inlined as text and need
  no directive.
- **Delete-then-repost on reindex or overwrite.** New optional
  `ChatHost.deleteExistingFileRecord(storagePath)` hook deletes the stale
  `src::<storagePath>` index record before re-indexing, and the skapi backend
  cascades that delete to the record's reference-linked children, so re-indexing
  replaces rather than colliding or duplicating. Awaited before the index
  request is enqueued, and best-effort: a missing record, a permission error, or
  a host without the hook must not block indexing.
- **Assistant turns are sanitized too.** A volatile db URL the model emitted no
  longer gets replayed into the LLM context as a dead link. Assistant
  sanitization is restricted to this service's own db attachment URLs
  (`isServiceDbAttachmentHref`), so an arbitrary external citation URL is never
  rewritten. User turns keep the broader rewrite, gated by the "Attached files:"
  block.
- `ChatHost.promptOverwrite(filename)` typed as a host hook, resolving to
  `skip`, `reindex` or `overwrite`.
- **CSV/TSV downloads get a UTF-8 BOM.** Korean-Windows Excel decodes a BOM-less
  CSV as CP949 and mojibakes every column.

---

## 1.5.0 (2026-07-06)

- **Jumping ASCII bunny loader** for full-area loads: page and gate loads, the
  initial history fetch, and the settings panel. Ported from
  www.bunnyquery.com's `bunnyLoader.vue`, so the two clients match. Small inline
  states (the "Thinking" indicator, older-history pagination) keep the compact
  dot-trail so it stays a thin sticky bar.
- An explicit Latin monospace font is pinned on the bunny, or CJK systems draw
  U+005C (backslash) as ₩ or ¥ and the ears come out wrong.

---

## 1.4.6 (2026-07-01)

Version bump only.

---

## 1.4.5 (2026-07-01)

The rAF typewriter, and the end of the stranded "Thinking..." bubbles.

### Changed: typewriter rewritten around requestAnimationFrame

Text is revealed at a constant wall-clock **rate** (characters per second) driven
by `requestAnimationFrame`, rather than a fixed number of characters per
fixed-delay tick.

- Each frame reveals `elapsed_ms * CHARS_PER_SEC` characters, so visual speed is
  the same regardless of how long a frame took.
- As the bubble's markdown grows, each re-render gets more expensive, so frames
  get longer, so each frame reveals more characters and does fewer, larger
  renders. That converts the old O(n^2) "re-render the whole growing string once
  per 3 characters", which got slower and slower and pegged the CPU, into
  roughly O(n): the number of renders self-throttles to what the machine can
  actually paint.
- Atomic regions are never left half-revealed. A file fence (rendered as a
  download chip, hidden as "[generating ...]" while unclosed, and potentially
  huge) and an inline link (a partial one is broken markdown) are snapped to
  their end, iterating to convergence so back-to-back regions all land whole in
  one frame.
- `requestAnimationFrame` is **paused** in a backgrounded tab, not merely
  throttled like `setTimeout`, so a hidden page skips the animation and shows
  the full text immediately, keeping the sequential typewriter queue draining.

### Fixed

- **The cache never retains a pending "Thinking..." bubble.** A resolved reply
  now replaces the trailing pending bubble in the cache whether or not the chat
  is visible (appending only when there is none). The view's
  `typewriteLatestReply` swaps the bubble in `state.messages` and never
  re-snapshots the cache, so appending left the cached copy stuck pending and a
  later cache-first remount re-rendered that "Thinking..." forever.
- `_serverItemId` is carried onto a promoted "Thinking..." placeholder. Without
  it, a turn resolved via the history-poll path (which matches by
  `_serverItemId`) did not find the placeholder, so the reply was spliced in
  beside it and the "Thinking..." was stranded forever, e.g. after a reload or
  when a cancel advanced the queue.
- **History poll dedup narrowed correctly.** Main-queue items are skipped while
  a dispatch is in flight, because it registers its id only after its provider
  POST returns and a remount can surface the item in that sliver. But bg-queue
  items run on a separate queue the immediate dispatch never polls, so they must
  still get theirs. Blanket-skipping every running item was what stranded a
  concurrent indexing task with no live poller.
- `historyItemPolls` is no longer cleared on remount. Its entries track live
  polls and each deletes its own on settle, so a surviving entry always means a
  poll that outlives the remount (skapi `item.poll()` loops are uncancellable).
  Wiping it made `loadHistory` attach a second poll on top of the live one.

---

## 1.4.4 (2026-06-30)

- Replies land in the shared history cache **independently of the view
  lifecycle**, so a reply is captured even if the chatbox unmounted mid-request.
  When the chat is not visible, the trailing pending bubble in the cache is
  replaced rather than appended, so a remount does not render a stuck
  "Thinking..." beside the answer.
- **Render gate changed from token comparison to visibility.** The old guard
  bailed on `requestToken !== gateRefreshToken`, but every remount bumps
  `gateRefreshToken`, so a request that finished after the user navigated away
  and back left a stuck "Thinking...": no view typewriter ever ran, and
  `resumePendingRequest` bails when a pending bubble is already present. The
  gate is now "is this the visible chat".
- Every in-flight item registers its poll in `historyItemPolls`, so a remount or
  history refetch dedups against **that poll** instead of stacking a duplicate
  on the same item. The old cacheKey guard stopped covering an item once
  `pendingAgentRequests` cleared, e.g. a queued message still in flight after
  the immediate one resolved.

---

## 1.4.3 (2026-06-30)

Silent MCP re-authentication.

- The MCP grant is refreshed through the OAuth `refresh_token` flow with **no
  browser redirect**. It works while the stored refresh token is valid and the
  server session still exists (about 30 days): the server re-reads and
  re-persists the user's session file on that call, which is exactly what
  reconnects a "disconnected" MCP user.
- Mid-chat callers stay silent so the embedded host page is never yanked away;
  only boot falls back to the full redirect when the silent path cannot refresh.
- An auth-expired (401) refreshes **both** credentials the chat depends on: the
  skapi JWT (the bearer the MCP server decodes for the user's sub) *and* the MCP
  grant / server-side session. An MCP 401 is a stale or cleaned server session
  and is not fixed by a fresh JWT alone.
- The grant is kept warm on `visibilitychange`, so returning to a backgrounded
  tab after the grant aged out no longer disconnects the next message.

---

## 1.4.2 (2026-06-25)

- **`isOfficeFile` renamed to `isServerExtractable`** (the old name kept as a
  deprecated alias) and widened from binary office documents to **all
  text/data/markup/code formats**. Those are readable via web_fetch in
  principle, but some providers (OpenAI's Responses API) have no working
  file-fetch tool, so the agent cannot retrieve the URL at all. Extracting them
  server-side, where the worker just decodes the bytes, makes indexing
  provider-independent.
- Detection is **extension-first** with a text-MIME fallback for unlisted
  extensions, so a `.csv` reported as an Office MIME is still treated as text.
- README gained the "Supported file types" section.

---

## 1.4.0 (2026-06-25)

Attachment parser plugins.

- **New engine module `src/engine/attachment_parsers.ts`**:
  `registerAttachmentParser`, `clearAttachmentParsers`, `getAttachmentParsers`,
  `findAttachmentParser`, `parseAttachmentContent`, `MAX_PARSED_CONTENT_CHARS`
  and the `AttachmentParser` type. A parser runs **in the browser**, turns an
  uploaded `File` into indexable text or an HTML string, and the engine sends
  that content **inline** in the background indexing request: no upload-side
  server extraction and no web_fetch for that file. Intended for formats read by
  none of the existing paths, e.g. legacy Hancom `.hwp`.
- First matching parser wins. A parser that throws or yields nothing is ignored
  and the file falls back to its normal path, so a parser failure never breaks
  an upload. Output is capped at `MAX_PARSED_CONTENT_CHARS`, mirroring the
  worker's server-side cap, so a huge document cannot blow the context window or
  the request size.
- Registration via `configureChatEngine({ attachmentParsers: [...] })`, the
  widget's `attachmentParsers` init option, or
  `BunnyQuery.registerAttachmentParser()` at any time before or after `init()`.
- Client-parsed content takes precedence over server-side office extraction and
  over web_fetch.
- `.epub` added to server-side extraction. `.rtf` pinned as a **text** format so
  an `.rtf` reported as `application/msword` is not misrouted to extraction,
  which has no `.rtf` extractor.
- The package version is injected at build time (`__BQ_VERSION__` via tsup
  `define`), exposed as `BunnyQuery.version`, and logged on `init()`.

---

## 1.3.5 (2026-06-25)

- OpenDocument `.ods` / `.odt` / `.odp` extracted server-side. Legacy, macro and
  binary office extensions are still **flagged** so the worker returns a
  graceful note instead of the model fetching binary garbage.
- **A text-format guard list that the extension decides.** `.csv` most notably:
  Windows and Excel report it as `application/vnd.ms-excel`, and without the
  guard it was flagged for server-side extraction, which has no `.csv`
  extractor, so the model got an "unsupported format" note instead of the file's
  contents.
- **Stray "Thinking..." cleanup.** There is normally at most one pending
  assistant bubble, so any extra is a duplicate, which appears when a concurrent
  history refetch re-maps a still-running turn into a pending placeholder while
  the local pending bubble is rescued and re-appended. Extras are now removed
  after the resolved bubble is made non-pending and before the next promotion.
- A background "Indexing:" turn's **user** bubble is un-pended on resolution.
  Leaving it set kept the bubble visually stuck and kept its `bgTaskQueue` entry
  alive forever, because the drain's `stillPending` check stayed true.
- When the freshly-mapped server list already shows an in-flight turn as a
  pending placeholder with a real `_serverItemId`, the local copy is not
  re-pushed. There is at most one in-flight regular turn, so the mapped pending
  assistant *is* that turn, and re-pushing stranded a "Thinking..." beside the
  reply.

---

## 1.3.4 (2026-06-25)

- **`isNonRetryableRequestError`**: a 400 or 422 whose problem is the request
  itself (an unknown or rejected parameter, the `_skapi_extract` class)
  deterministically re-fails if resent unchanged, so the retry gates now refuse
  to auto-resend it. Without this, a 400 whose rejected param name merely
  *contains* "token", e.g. `max_output_tokens`, tripped the
  `invalid_request + token` branch of the auth-expiry heuristic and looped
  refresh-then-resend forever, burning tokens. 401 (auth, fixable by a refresh)
  and 429/5xx (transient) are intentionally not covered.

---

## 1.3.2 (2026-06-24)

- **`groupAttachmentFailures`** and a single dismissible upload-error report.
  After a send's uploads and indexing-queue requests all settle, everything that
  failed is reported once, grouped by error code and description, listing each
  distinct error with the files it affected. The original error code and message
  are preserved through the indexing path for the report. Failed chips stay in
  the attachment row so the user can remove or retry them.

---

## 1.3.0 (2026-06-24)

**The engine split.** The hand-written single-file widget became a source tree
with a tsup build producing two outputs.

- **`bunnyquery/engine`** (`dist/engine.mjs` + `.cjs` + `.d.ts`): the
  framework-agnostic, DOM-free chat engine, consumed by www.bunnyquery.com's
  `agent.vue` admin chatbox. **`bunnyquery.js`**: the standalone widget IIFE,
  which imports the local engine and gets it bundled inline. skapi and marked
  stay runtime globals and are never imported.
- New engine modules: `config` (dependency injection through
  `configureChatEngine`, including the `poll` knob, because `agent.vue` uses the
  npm-bundled skapi-js and omits it while the widget uses the deployed
  `skapi-js@latest` and must pass `poll: 0` to get the early ack and a manual
  `.poll()` handle that queued-send cancel relies on), `errors`, `budget`,
  `links`, `history`, `office`, `requests`, `session` (`ChatSession` plus the
  `ChatHost` interface), and `prompts`.
- **`ChatHost`** is the only view surface: identity, render and scroll hooks,
  and the skapi cancel/refresh surface. The clear-horizon timestamp and the
  "Indexing:" display label are **injected**, so the engine touches neither
  localStorage nor view-specific formatting.
- `bunnyquery.css` is now generated by `scripts/build-css.mjs` from
  `src/widget.css` (widget chrome, design tokens, layout) plus
  `styles/chat.css` (the shared chat surface: bubbles, markdown, links, queue
  and cancel). `styles/chat.css` is also published for engine consumers, so both
  chatboxes render the chat surface identically. Edit those two sources, never
  `bunnyquery.css`.

---

## 1.2.3 (2026-06-23)

Server-side office extraction, and the overwrite prompt.

- **`_skapi_extract`**: office documents (`.docx`, `.xlsx`, `.pptx`, `.hwpx`)
  cannot be read by web_fetch because they are binary zips, so the proxy worker
  downloads them from db storage, extracts their text server-side, and
  substitutes it for a `{{SKAPI_FILE_CONTENT::<id>}}` placeholder in the request
  body. The directive rides under a reserved key the worker strips before
  calling the provider.
- Placeholders go **only** into the LLM-bound copy of the message. The displayed
  bubble and the history cache stay clean, so stale tokens never accumulate
  across replayed turns.
- **Overwrite / reindex prompt.** An upload that hits an existing file surfaces
  a non-dismissible modal (no backdrop close, no ×): Skip leaves the existing
  file untouched, "Reindex only" keeps it and just re-indexes it, Overwrite
  replaces it. "Apply to all remaining" makes the choice sticky for the rest of
  the batch and is reset at the start of each new batch. Uploads run
  sequentially, so only one prompt is ever open.
- A kept-existing file re-indexes with a "Reindexing:" label, rendered as a bare
  storage-path markdown link so a click mints a fresh temporary URL.
- **Scroll behaviour.** Automated resolutions (the streaming typewriter, bg-task
  polls, history polling) scroll only if the user is already at the bottom, and
  re-check after the DOM settles so a streamed response cannot repeatedly drag
  them back down. `wheel` and `touch` fire synchronously on a real user action
  and never for programmatic scrolls, so scrolling up releases stickiness and
  lets the user read earlier messages while a response is still generating.
- Attachment chips sort active first, terminal last (uploading, queued, failed,
  completed), so the "...(n) more" truncation tail falls on finished items
  instead of hiding what is actively happening.
- Repeat clicks on a link that is being re-resolved are swallowed. Each used to
  await the shared in-flight fetch and then fire `anchor.click()`, opening the
  file in several tabs at once when it resolved. The chip shows a busy cursor
  while it works.

---

## 1.2.2 (2026-06-12)

- The `--bq-pink*` custom properties were renamed to `--bq-main*`, so a
  rebranding is a variable override rather than a search-and-replace. The
  attachment progress tint became a theme-reactive `color-mix()`.
- Background indexing bubbles show `Indexing: <file> · <mime> · <size>`, built
  by one shared formatter used by both the live bubble and the history rebuild.

---

## 1.2.0 (2026-06-11 to 2026-06-12)

- Renamed from **bunnychat** to **bunnyquery** throughout: files, the
  `window.BunnyQuery` global, and the `bq-` CSS prefix.
- First README.
