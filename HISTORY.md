# BunnyQuery release history

Changes to the widget (`bunnyquery.js` / `bunnyquery.css`) and the chat engine
(`bunnyquery/engine`) from the start of the current 1.x source line to today.

A few notes on how to read this:

- **Published vs built.** The source tree is at **1.21.3**. The latest version on npm
  when this was written is 1.21.0. Versions that never reached npm on their own: 1.6.1, 1.6.3 and 1.6.4 (their changes shipped inside 1.6.2
  and 1.7.0) and the source bumps 1.8.7, 1.9.2, 1.9.12, 1.12.0, 1.14.0-beta.0 and
  1.15.0-beta.0. Two numbers were skipped outright and exist nowhere: 1.10.9 and 1.15.3.
- **Gap between 1.8.0 and 1.10.0.** Versions 1.8.1 to 1.9.12 shipped without
  their own entries here, so their changes are not itemized below. Two features
  landed in that window and are documented only in the README: the widget's
  `allowAnonymous` option, and the expanded extractable-document set.
- **Republishes.** A few versions on npm are republishes with no source change behind
  them: 1.2.1, 1.10.5 and 1.10.11. They are listed below with a line saying so.
- **Moved entries.** Three early entries were filed one version too early when first
  written and now sit where the work shipped: the office-extraction work of 2026-06-23
  (shipped inside 1.3.0, not 1.2.3), paged `readFileContent` indexing (1.5.7, not 1.5.6)
  and vision indexing for PDFs (1.6.0, not 1.5.7). Dates are the npm publish dates, UTC.
- Both chat clients (this widget and `agent.vue` on bunnyquery.com) consume the same
  engine, so an engine fix only reaches bunnyquery.com once the package is republished
  and the dashboard's `bunnyquery` dependency is bumped.

---

## 1.21.3 (2026-11-25, not yet published)

Pictures read as text at indexing, and fewer lookups before a search.

- **Image files.** An image file indexed in one pass is now asked to transcribe every character at whatever angle it sits, to put every identifier (serial, part number, tag) in `printed_text` or `handwritten_text`, and to report `text_rotation` and `text_legibility` on its `src::` record. A 2026-11-25 worker turns a turned or tagged photo upright for the model, stores its text as page 1 of the file's page text (so `searchText` finds it), and takes one second look when the text was turned. A .tif, .tiff, .bmp or .heic file is never claimed as attached unless the server attached a converted copy. On OpenAI the file entry carries the model's image `detail`. Applies to new and re-indexed files.
- **Scanned documents.** No engine change: with the 2026-11-25 worker, a document whose pages are pictures (a scanned .hwpx, .docx and so on) is read page by page through vision, and its page text is searchable like a PDF's.
- **Chat.** The chat prompt no longer lists or looks up files (`getUniqueId` on `src::`) to check whether a document, quote or title exists before searching: `searchText`'s hits name the file.

## 1.21.2 (2026-11-25, not yet published)

Spreadsheets in search, and image indexing that survives a closed page.

- **Spreadsheet hits.** With the 2026-11-25 MCP server a spreadsheet's sheets are page text too (one page per block of rows; a hit carries `sheet`, `rows`, `row_id_prefix` and `row_text`, the matching row). Citation chips name the sheet ("quote.xlsx · 총괄") instead of a page number, one chip per sheet; the retrieval note keeps the sheet and gives a sheet one slot. The chat prompt sends a question that names a code, number or phrase to `searchText` first, says a document title or quote is not a file name, cites a sheet hit by file and sheet, and keeps totals computed from the full row set.
- **`workerIndexEndings` (new, off by default; bunnyquery.com on).** A file read in one pass (an image, or any file not rendered, windowed or paged) now carries `index_end` on its `_skapi_file_urls` entry, and a 2026-11-25 worker writes its done marker and run status itself. With the switch on, the engine no longer marks such a run "Indexing stopped ... (the page was closed)". For every file, a run the server still lists as pending or running (by path or file name) is never marked lost, and a run must be idle on two complete looks in a row before it is.

## 1.21.1 (2026-11-25, not yet published)

Faster document answers in the chat.

- **Chat prompt, documents.** A question about what the documents say (a procedure, a passage, a definition, how to fix or do something) now starts with `searchText`, without `getTables` or a file lookup first. A named file is found by its `src::` record and then searched with its path; a named spreadsheet is read by its rows, since it has no page text. `getFileOutline` is now a fallback, used only when a search of the whole file gives too many hits or none that fit. On the MRO DB logs those first calls cost 0.4 to 3.6 s each, plus a model step.
- **Widget: `reuseMcpToolList` on by default.** OpenAI chat turns carry the MCP tool listing an earlier turn got, so OpenAI skips the four-request tool handshake with the MCP server. Verified on a live OpenAI chat on dev: the second turn sent only `initialize` before its first tool call. Pass `reuseMcpToolList: false` to turn it off. The engine's own default stays off; bunnyquery.com turns it on in its `configureChatEngine`.
- Works with any MCP server. With the 2026-11-25 MCP server, a glossary search result also carries the full text of its top hit pages (`page_text`), and `readFileContent` gives scanned PDF pages and image files as their indexed text.

## 1.21.0 (2026-11-24)

The chat follows every unfinished request from the server (the reconciler), so it is right after the user comes back from sleep, other tabs or a network loss. Needs skapi-js 2.7.0 and the backend reads in infra (older ones fall back to polls).

Results are applied by request id through one engine funnel, and a failed read no longer changes the screen (step 3). Every waiting item is then followed by one reconciler per page that reads the server about all of them at once (step 4). Plan: `BUNNYQUERY_CHAT_RECONCILER_PLAN.md`, sections 3 and 4b.

### Engine

- **New:** `ChatSession.applyTerminal(itemId, result, ctx)`, the only writer of a settled result. It finds the turn by `_serverItemId` on screen, or in that chat's history cache when another chat is showing; a settled id is tombstoned for the life of the page (a second result is refused, and a stale history page that shows it waiting again keeps the settled copy); state only moves forward; a resolved status envelope of a streamed turn is never an answer (the chunks are read back instead). The immediate send, the queued send, every history poll (engine and agent.vue), the background drain, the queue check, the live stream settle and stream recovery all go through it.
- **New:** `ChatSession.onPollFailure(itemId, err, ctx)`: NOT_EXISTS settles the item as cancelled; a read that failed on the way (network, timeout, 429, 5xx, sign-in) leaves the item exactly as it is, with no error bubble and no run:: flip; any other refusal is shown on the item, by id. `isTransportFailure` and `isNotExistsError` are exported.
- **New:** `trackOpenItem`, `getOpenItem`, `isItemSettled`: every followed item carries the identity (chat key, project, owner, platform, queue) pinned at the ack, the history page or the drain's adoption, and settles, by-id reads and a client-driven file's next pass use it. `BgTaskEntry` gains `identity`, `owner`, `ownerKey`.
- **Changed:** `state.sending` and `pendingAgentRequests` clear at the ack of the POST, not when the answer lands. Only a 401 on the POST itself refreshes and sends again; a 401 or any other error on a poll never resends the turn. `resumePendingRequest` only shows the sending state until the ack.
- **Changed:** a queued turn is shown running when the server says so, by id (a by-id read after each settle and after a queued send's ack, a status frame, or the first streamed bytes of its answer), not by promoting the first waiting bubble. `promoteNextQueuedToRunning` keeps its name and does that.
- **Fixed:** when the one resend after an expired-credentials answer cannot go out (the refresh or the POST fails), the turn shows its own error instead of staying on "Thinking..."; a throw while building a send still releases the sending state.
- **Changed:** a file's indexing steps whose read failed on the way are left out and asked again by the next "Load more", instead of being drawn as failed passes.
- **Removed:** the positional writers `typewriteLatestReply`, `resolveQueuedUserBubble`, `insertAtTarget`, `_applyReplyToCache`, `_removeStrayPendingAssistants`; the queued ack's "first sending bubble" stamp (the ack now stamps by local id, in the cache too). `onQueuedSendResponse` / `onQueuedSendError` settle by server id only.
- **Changed:** sends made while another chat is on screen carry local ids and are stamped at the ack; every error bubble a settle writes carries the item id.
- **Fixed:** an error bubble is never adopted as a streamed turn's answer (`adoptLocalAnswerIntoPage`), and a first-page load keeps the live text of a turn still streaming (`adoptLiveTextIntoRunningRow`).
- **Changed:** an answer is typed out only when the reader watched the turn (live text was painted, or the tab stayed visible since it was sent or followed); an answer that landed while they were away is written at once.

### Engine: the reconciler (step 4)

- **New:** the open set. Every chat turn and indexing pass the page shows as unfinished is one entry by server id (`trackOpenItem`: chat key, project, owner, platform, queue, kind, cref, state, last confirmed), whoever added it: the ack, a history page, the drain, and every `bgTaskQueue` entry a host pushed (the files page, with no chat view). Adding an id that is there changes nothing.
- **New:** one timer chain per page (`LookScheduler`, new `reconciler.ts`). Each look reads the queue counters of the queues with open items (`forwardRequestQueueCounters`), and only when a counter moved, on a trigger, once a minute, or while a queue holds only waiting turns, one batch status read per project (`forwardRequestStatus`, 100 ids a call). Items that turned terminal are read once (`forwardRequestRead`) and applied through the funnel; a streamed turn is read from its cursor (`since`) until it reaches `final_seq` (or `more` is false), then finalized with `ifAbsent`, and when another tab stored first (`reason: "exists"`) the stored answer is shown. `missing` reads "This request is no longer available." ("no longer reachable from this network" for an anonymous visitor). Each look has a 15 s deadline and a generation; a trigger during a look runs exactly one more look; triggers fired by one event are one look.
- **New:** cadence: every 3 s while the tab is visible and anything is open (a minute while status frames arrive), once a minute while hidden only for a client-driven indexing chain, at once on tab shown, wake (a timer that fires far too late), online, socket reconnect, bfcache restore, a chat view opened, and a frame naming an open id. Nothing open: no timer at all.
- **New:** a return (any of those) stops each live stream reader first (and aborts its read), then runs the discovery listing (`fields: "ids"`, `after` a watermark, exact queue) and the first-page merge, and starts one fresh reader for a turn still streaming on screen: at most one reader per request.
- **New:** errors never change the screen. A read that failed on the way sets `state.reconnecting` and the next look comes after 1, 2, 4 ... 30 s; a lost sign-in sets `state.signInNeeded` and stops the 3 s looks until `noteSignedIn()` (both clients call it on sign-in).
- **New:** `cref` on every send (`newClientRef`, stored on the send's bubble as `_cref`). A send whose POST got no answer stays waiting while the discovery listing looks for its row by cref; found, it is followed as if acked and never resent; not found by two complete listings, the reply reads "Not sent. Retry?" (`_notSent`) and `retryNotSent(msg)` sends it again on the user's click only.
- **New:** queued chat turns and waiting indexing passes are shown running from the batch statuses, by id. `promoteNextQueuedToRunning` asks for a look; `promoteNextBgQueuedToRunning`'s positional guess and the 0.6/2.5/6 s lookups run only on an skapi-js without the batch reads.
- **New:** side effects that send or write (the next pass of a client-driven file, run:: and done:: records, finalize, the records refresh) run in one tab: the one holding `navigator.locks` `bq-settle:<project>:<queue>`, once per pass across the tabs (a registry in localStorage). The next pass of a file is sent once per settled pass.
- **New:** file runs. `syncFileRuns(projectId, workingPaths)` follows each file whose run:: record says working until the record says it ended or a complete queue look finds no pass of it; meanwhile `host.recheckFileRuns(projectId, paths)` is asked every 30 s while the file is not seen live (replaces both clients' 5-round stub recheck).
- **New:** `ChatEngineConfig.forwardRequestStatus`, `forwardRequestRead`, `forwardRequestQueueCounters` (skapi-js 2.7.0) and `refreshRecords(projectId)` (a data hook, called with no view too). Without the two reads the engine keeps today's polls, and its looks re-attach a poll that failed on the way through `csrHistoryItemLookup`.
- **Changed:** with the batch reads, a history page and the drain attach no poll per request: the reconciler follows them. `catchUpHistory`, the return watch, the adoption tick and the frame nudge are thin wrappers over the reconciler's chain (same names). `resumePolling` runs the return look with no chat view too. `needsHistoryRefetch` is false for an id the reconciler follows.
- **New:** `reconcileNow(trigger)`, `noteViewOpened()`, `noteBgQueueChanged()`, `noteSignedIn()`, `reconcilerStats()`, `stopReconciler()`, `canRetryNotSent(msg)`; `NOT_SENT_TEXT`, `REQUEST_GONE_TEXT`, `REQUEST_UNREACHABLE_TEXT`, `reconcilerReadsEnabled`, `crefSupported` exported.

- **Fixed (step 4 review):** a send with attachments whose POST got no answer is looked for on its own queue (the chat's background queue), so a return no longer lists only the main queue for it and calls it "Not sent" while it was queued (a Retry would have sent it twice).
- **Fixed (step 4 review):** after a sign-out (or with another account) the items of the user who sent them are not read, not settled and never marked "no longer available"; they wait, with no looks, until that user signs in again. Each open item and waiting send pins the user id it was sent under.
- **Changed (step 4 review):** between full reads (a return, the once-a-minute stale watch) a look reads only what can have changed: items never confirmed or seen terminal, items a status frame named, and on a counter move or a nudge the running items plus the first 5 waiting ones of each queue. A bulk upload's waiting passes are no longer read on every finish or frame.
- **Fixed (step 4 review):** a first page that failed on the way is owed and read again by the next look; a finished row newer than anything the chat shows (answered from another tab or device) makes the next look read the first page; `resumePolling` right after a return look rides on that look instead of running a second one.
- **Fixed (step 4 review):** the settle lock is held for at most 20 s per side effect, and a side effect whose lock stays busy for good runs anyway (the registry still runs it once) instead of being dropped.
- **Fixed (step 4 review):** with an older skapi-js the look no longer reads waiting background passes by id on every look; a pass without a poll is re-attached by the drain when a poll slot is free.
- **Fixed (step 4 review):** passes the drain adds join the open set with their queue (so their queue counters are read); a matched lost-ack send drops its `_unconfirmed` mark; a throwing `work()` or `pushLive()` hook no longer ends the timer chain.
- **New:** `ChatSession.followsBackgroundQueue()`: true when the reconciler follows `bgTaskQueue` itself (web-bunnyquery's fallback poller in main.vue stands down then).

### Widget (step 4)

- Hands the engine `forwardRequestStatus`, `forwardRequestRead` and `forwardRequestQueueCounters` when the embedder's skapi-js has them.
- Coming back to the tab looks at once; the MCP grant refresh no longer holds the look back. `isViewMounted` is false once the message list left the page.
- A "Retry" button under "Not sent. Retry?". The run:: stub recheck is the engine's (no 5-round limit). The chat view opening and signing in tell the engine (`noteViewOpened`, `noteSignedIn`).

### Engine (step 5)

- **New:** `ChatSession.watchIndexQueue({ identity, wantsConfirm?, runsOpen?, recheckRuns? })` (returns `{ stop, refresh(maxAgeMs), ensure }`) and `indexQueueSnapshot(projectId)`: a page that draws indexing state from the background queue, with or without a chat view (the dashboard's files page), has the queue read on the reconciler's one timer chain. At once on start, on every return and on a status frame about the indexing queue; every 8 s while it holds work or the read came back cut off (a minute while status frames arrive); every 2.5 s while the page waits for a second, independent look; never while the tab is hidden. The answer is `state.indexQueues[projectId]` (`{ keys, checked, at }`, type `IndexQueueSnapshot`); a failed read keeps the last one. `recheckRuns` is called every 30 s while `runsOpen()` says so. Status frames are held only while a watched queue has work. Types `IndexQueueIdentity`, `IndexQueueWatchOptions`, `IndexQueueWatchHandle` exported.
- **Changed:** `awaitIndexingDrained` reads the queue through such a watch on the same chain instead of a timer of its own. Same rules: fresh reads, two idle reads with distinct times and the confirm gap between them, at least 8 s in all, a read that fails or never answers (45 s) counts as busy, a nudge pulls the next read forward, 15 minutes at most. While the tab is hidden it is read once a minute.
- **New:** `ChatHost.onProviderAnswer(projectId, platform, result)` (optional): called once per request after its answer or provider error is written, whichever path read it (a poll, a look, a stream). The dashboard judges the project's API key from it.
- **Changed:** with an skapi-js without the batch reads and no chat view (nothing drains), a look reads by id the oldest waiting background passes too, as many as the drain would poll at once (6), so passes the files page queued are still followed and settled with the chat closed. The `executed` time a running read gives is kept on the item and handed to the settle, so such a pass keeps its duration (main.vue's poller carried it from the poll's running ticks).
- **New:** `fetchLiveIndexingKeys(params, { maxAgeMs })`: how old a shared answer may be (default 4 s; 0 always asks).
- **New:** `styles/chat.css` `.bq-chat-status`: the look of the "Reconnecting..." / "Sign in to see the latest answers." line both clients show.

### web-bunnyquery dashboard (step 5, not part of this package)

- agent.vue loads history only through the engine's `loadHistory` (its own mapper, merge, poll attach with a background poll budget, onError writer and the queue-detect polling loop are gone); main.vue's fallback poller is gone; the files page reads `watchIndexQueue` instead of its own probe timer, confirmation timer and status frame listener. The chat view shows the two connection notes.

### Widget (step 5)

- **New:** the chat shows "Reconnecting..." while the engine's looks fail on the way (`state.reconnecting`) and "Sign in to see the latest answers." while they are refused for want of a sign-in (`state.signInNeeded`), the same words as the dashboard. Class `bq-chat-status` (shared look in `styles/chat.css`); in the widget it sits between the list and the composer with no height of its own, so it never moves the list. Hidden while the settings panel is open.
- **Changed:** coming back to the tab resumes background polling at once, as agent.vue does, instead of after the MCP grant refresh (the step 4 version waited for it, up to 10 s, and re-checked visibility after). The grant is refreshed on return only when it is missing, aged out or another user's; a fresh grant no longer runs the full MCP session exchange on every return (that stays the answer to a 401, through `refreshSession`).
- **New:** a sign-in the embedding page makes on its shared skapi instance also resumes the looks (`noteSignedIn`), through skapi-js's `onLogin` listener list (agent.vue: `onLoginHanger`). Only on an SDK whose `onLogin` is a list; an older one's single function is never replaced.
- **Changed:** the chat view tells the engine it opened (`noteViewOpened`) after the cached conversation is put back, so the look works against the restored list.

### Engine (bug sweep, step 6)

- **Changed:** opening the chat view is a return (owner, 2026-11-24, replaces the 2026-11-20 "history loaded once" rule): the first page is read and merged by id every time the view opens, in both clients and in the engine's 'view' look (which reads it only when the host did not start one a moment before). A first page dropped because the view was redrawn while it was on the way is owed to the next look.
- **Fixed:** history attaches the waiting rows of a page oldest first, so an older skapi-js (before 2.7.0) puts the one row that can settle next at the head of its poll line.
- **Changed:** the background queue look (`probeBgQueue`, `fetchLiveIndexingKeys`, worker-pass adoption) asks for compact stubs of the exact queue (`compact`, `queue_exact`) and reads the label from `request_text`, so it no longer carries each pass's request echo. New export `listedRequestText(item)`.
- **Fixed:** `fetchLiveIndexingKeys` reports `checked: false` when the server says more rows exist (`endOfList: false`), not only when the page is full.
- **Fixed:** a failed pass of a file the worker drives is read once more (after the next complete queue look, or 30 s) before it is shown as failed, and a live settle marks a failure the worker already sent again (`isRetried`), so the file's row does not go red over it (plan 3.8).
- **Fixed:** a "running" read no longer promotes a turn or a pass whose cancel is still on the way, or one this page cancelled.
- **Fixed:** a client-driven indexing chain survives a reload or a discarded tab: each chain is kept in localStorage (`bq-chain:<project>|<path>`) until it ends, and a new page follows its current pass and sends the next one (once across tabs). A run of this user's own whose chain is lost and whose queue went idle says "Indexing stopped before the file finished (the page was closed). Index it again." `syncFileRuns(projectId, paths, info?)` takes each record's `owner` and `filename` for this.
- **Fixed:** a next indexing pass whose POST failed on the way carries a cref and is looked for on the queue: found, it is followed; not found by two complete looks, it is sent once more; if that fails too (or the server refused it) run:: says "Could not send the next indexing pass."
- **Fixed:** the settle lock marks a side effect done only when it worked: it is marked in flight (60 s) while it runs, and a throw or a rejected promise is tried again with backoff, up to 5 times. `mintIndexDoneMarker` and `upsertIndexRunRecord` may return a promise that rejects on a failed write; `upsertIndexRunRecordSafe(..., { report: true })` passes it on. A finalize that failed on the way is tried again too. The in-memory registry is pruned with the stored one.
- **Fixed:** when a look (not the dispatch's poll) reads a turn's answer, an expired sign-in sends the turn once more instead of showing the error (once in all, when the dispatch's poll and a look both read that answer), and the turn's tool listing is settled.
- **Fixed:** an answer that is stored but cannot be loaded (`body_unavailable`) is read at every look 3 times, then once a minute; after 5 reads the turn says "The answer is stored but could not be loaded right now. Reload to try again.", and a later read that loads it replaces that.
- **Fixed:** "Retry" on a "Not sent" turn while another send of that chat is in flight sends it as a queued turn, so it no longer takes over the running send's state.
- **Fixed:** an item sent by a user is never read after a full sign-out leaves no identity at all.
- **Fixed:** the files page's green confirmation reads the queue fresh (about 3 s, was about 6 s).
- **Fixed:** `awaitIndexingDrained`'s 15 minute cap has its own timer, so it holds while the tab is hidden or a sign-in is needed.
- **Fixed:** a pass settled by an older skapi-js's look takes its start time from the terminal read when no running read saw it.
- **Fixed:** a pass the engine sends itself (an attached file, a reindex of a stored file) joins the followed items the moment its POST is answered, with or without a chat view, like the passes a host pushes (`noteBgQueueChanged`). Before, it waited for the next look, and with nothing else open no look came.

### Widget (bug sweep, step 6)

- **Changed:** drawing the chat view always reads the first page after the cached conversation is put back (was: only when a waiting bubble had nothing to settle it).
- **Fixed:** a by-id read for a signed-out visitor goes without a token (`csrHistoryItemLookup` sent `auth: true` and failed with no session).
- **Changed:** the run:: and done:: writers return a promise that rejects when the write failed, so the engine writes it again; the run records sweep passes each record's owner and file name to `syncFileRuns`.

### web-bunnyquery dashboard (bug sweep, not part of this package)

- agent.vue reads the first page every time the chat view opens; the files page and agent.vue tell the engine at once when they push a pass (`noteBgQueueChanged`); `agentViewMounted` is gone (nothing read it); the run:: and done:: hooks hand back the write's promise (`throwOnFailure`).

## 1.20.2 (2026-11-24, not yet published)

The saved-findings code that 1.20.1 switched off is removed.

### Engine

- **Removed:** `findings.ts` and its exports (`FINDINGS_TABLE`, `FINDING_ID_PREFIX`, `findingsForTurn`, `findingKeyWords`, `SearchFinding`), the `saveSearchFinding` hook in `configureChatEngine`, and `ChatSession.SAVE_SEARCH_FINDINGS`. A host that still passes `saveSearchFinding` is ignored. Records already in table "search_findings" stay where they are and are no longer read or written.

### Widget

- The `saveSearchFinding` hook is removed (agent.vue's too).

## 1.20.1 (2026-11-24)

The chat no longer starts every turn by reading saved search findings.

### Engine

- **SAVED FINDINGS FIRST removed from the chat prompt, and findings are no longer saved.** The MCP's searchText now learns which page answered a question by itself (learned links, which every search reads first), so the agent's own getRecords on table "search_findings" was a second copy of the same thing. In production it was the slowest call of every turn (7 to 8 s for a 3.6 KB answer). `ChatSession.SAVE_SEARCH_FINDINGS` (false) switched the saving off; the code itself was removed in 1.20.2.

## Unreleased (book search, 2026-11-23)

A "Wrong answer?" button under answers that read data, and chat prompt rules for searching long files by chapter and for checking a disputed answer. Needs an MCP with the book-search tools (searchText `page_from`, `page_to` and `question`, getFileOutline's `outline`, `correctSearchLink`).

### Engine

- **"Wrong answer?"** `ChatSession.reportWrongAnswer(msg, pinned?)` sends the visible user message "This answer seems wrong. Please check it again against the documents." through `dispatchComposedMessage`, so it is an ordinary turn and reads the same after a reload. `ChatSession.canReportWrongAnswer(msg)` is the gate both clients use (a settled answer with a retrieval note that is not the no-source mark, not cancelled, and the latest answer: no chat turn below it, since the message names no answer; an answer already reported keeps its disabled button), and `wrongAnswerReported(msg)` makes it one click per answer, also across a history refetch in the same page. `wrongAnswerLabel` and `wrongAnswerMessage` carry the words. `WRONG_ANSWER_MESSAGE`, `WRONG_ANSWER_LABEL` and `canReportWrongAnswer` are exported from the session module.
- **Chat prompt, DOCUMENTS.** For a long file (a manual, a book) the agent calls getFileOutline first and searches the chapter with searchText `page_from` and `page_to`, and passes searchText `question` only for a question about the documents (in the user's own words, without names or personal details that are not about the documents), which the MCP uses to learn which page answered it. The learned terms land in records other users of the file's group can read, so the owner still has to decide how much of a question is stored.
- **Chat prompt, WRONG ANSWER.** When the user says an answer is wrong, or presses the button, the agent re-reads the cited pages and searches again with searchText `question` set to the original question, never the complaint, then does exactly one of: corrects the answer only; corrects it and calls `correctSearchLink` (when it has that tool); or keeps it and quotes the supporting text. `correctSearchLink` only with the page and an exact quote that prove it, never on the user's word alone. SAVED FINDINGS FIRST is unchanged.

### Widget

- The "Wrong answer?" button under the citations (`.bq-wrong-answer-btn` in `chat.css`, a small muted text button), disabled once sent. Mirrored in `agent.vue`.
- The File already exists dialog and the skipped-duplicates Reindex now say: "Re-indexing also removes everything search has learned about this file from people's questions and corrections."

## 1.20.0 (2026-11-23, not yet published)

Coming back to the chat always re-reads it, and indexing status can arrive over the websocket instead of being polled.

### Engine

- **Every return re-reads the chat.** When the tab is shown again (`resumePolling`), the computer wakes from sleep with the tab open, the network comes back, a page is restored from the back-forward cache, or the status websocket reconnects, `ChatSession.catchUpHistory()` runs the same first-page refresh a mount runs (`loadHistory(false)`): older pages stay, a send in flight is kept, an empty answer never replaces a known one, waiting items get their polls back, and a streamed answer nobody finalized is read back. Several reasons at once run one refresh (2 s apart). This replaces the 1.19.0 rule that loaded history once and relied on polls alone after a return.
- **Request status push (off by default).** With `statusPush: true` and `onRequestStatus` / `isRequestStatusLive` from skapi-js 2.5.0 in `configureChatEngine`, indexing passes are dispatched with `notify: true` and their polls read the row once a minute while status messages arrive, and at once when one names them. A message about a pass the page does not follow yet runs the queue check at once (at most every 2 s), and the 10 s queue check becomes once a minute while messages arrive. The checks that decide a file has finished (the 0/2/6 s look after a pass, and the wait before an answer that needs the files) are unchanged. With an older skapi-js, an older backend, or no socket, nothing changes. New exports: `statusPushEnabled`, `statusPushLive`.

### Widget

- The return re-read above, through the engine.
- **`statusPush` option**, off by default because it keeps a websocket open on the host page's skapi instance. Needs skapi-js 2.5.0 or newer on the page.

## 1.19.3 (2026-11-23, not yet published)

The production MCP server moves to `mcp.skapi.com`, and the chat and indexing prompts are shorter.

### Engine

- **Chat prompt.** The access-group rule no longer explains how the server fills in a missing group (an index or tag query auto-filled with `"authorized"`, a plain table query not at all); it keeps only what that implies: pass the project's group on every query that names a table, a group left off is not "all groups", a non-owner is then answered from group 0 alone, an empty result is retried in the other groups, and reference alone spans every table and group. "An index or tag filter needs table_name" was removed, since getRecords' own description says it. The knowledge-lookup line is reworded: search the project's data before saying you don't know, because the data lives in the database, not in earlier chat messages.
- **Indexing prompts.** The image line is shorter (look at the attached images, never fetch an image URL). The `readFileContent` window description now lists text as a character range instead of PDFs as page images. Page records are told to transcribe the text in photos and diagrams before describing them, and the orphan-record explanation was folded into the shorter "never post the file record" rule.

### Widget

- **Production MCP server is `https://mcp.skapi.com`** (was `https://mcp.broadwayinc.computer`). The dev host (`dev: true`) is unchanged, and `opts.mcpBaseUrl` still overrides both. The README's examples and OAuth section say the same.
- The prompt changes above, through the engine.

## 1.19.2 (2026-11-22)

Chat turns: the question is sent once, OpenAI turns skip the MCP tool handshake, and an optional per-project answer mode.

### Engine

- **The latest question is no longer sent twice.** On bunnyquery.com every immediate send ended its `input` (OpenAI) or `messages` (Claude) with the user's message two times. The engine left the new bubble out of the history by comparing objects, and agent.vue holds the chat state in a Vue `reactive()`, so the history saw a proxy of the bubble that never compared equal and kept it, then the engine appended the message again. The bubble is now left out by its local id. The widget's plain state was never affected, and queued and off-screen sends built their history before adding the bubble.
- **OpenAI chat turns can reuse the MCP tool listing (off by default).** With `reuseMcpToolList: true` in `configureChatEngine`, `ChatSession` keeps the `mcp_list_tools` item an OpenAI chat response returned and puts it in the next turn's `input` after the system message, so OpenAI does not ask the MCP server for its tools again (four requests, about 0.6 s per turn). Off unless the host sets it, because no real OpenAI request has carried the item yet: turn it on after one live chat on a dev project answers with it. Kept in memory per exact MCP server URL (endpoint, `profile`, `ctx`), signed in or anonymous, project and user; a reload starts empty. A turn that carried the item and failed always drops the entry and is not retried (its error shows as usual). If the error names the item, reuse stays off for that project in this browser (localStorage); any other malformed-request error (400, 422, `invalid_request_error`) turns it off for the page; a rate limit, provider 5xx or network error drops only the entry. A listing that contains `$CLIENT_SECRET`, `$ACCESS_TOKEN` or `$ID_TOKEN` is never stored, since the server's enqueue step substitutes those literals. Known cost when on: each reused turn's request body and stored history row carries the tool list (about 31 to 34 KB for the chat profile), which also comes back with every history page. Claude turns and indexing passes are unchanged, and so is a direct `callOpenAIWithPublicMcp` call that passes no `turn` (new last argument, `ChatTurnContext`).
- **Answer mode** (`answer_mode` in the project's `bq::settings` record): `'fast'` sends effort `low`, `'thorough'` sends effort `high` (OpenAI `reasoning.effort`, Claude `output_config.effort`), on chat turns only and only to models known to accept the field (OpenAI gpt-5.4 and newer; Claude Opus 4.5 and newer, Sonnet 4.6 and newer, Haiku 5.5 and newer, Fable, Mythos). Absent or any other value is Standard and the request is unchanged. Read with the same awaited settings fetch as `web_access`, so the first turn after a page load uses the stored value. New exports: `ANSWER_MODES`, `DEFAULT_ANSWER_MODE`, `ANSWER_MODE_SETTING_LABEL`, `ANSWER_MODE_LABELS`, `ANSWER_MODE_HINTS`, `ANSWER_MODE_OPTIONS`, `normalizeAnswerMode`, `answerModeFrom`, `projectAnswerMode`, `resolveAnswerMode`, `chatEffortFields`, and the types `AnswerMode` and `ChatTurnContext`.
- **Chat prompt.** The access-group rule no longer contradicts itself on projects that index at `"authorized"` (the default): it now says the index and tag auto-fill happens to match that group, while a plain table query is not auto-filled, and keeps the "comes back empty" warning for other groups. Rules the chat tool descriptions already state (the searchText steps, paging and fetch_all, the db: link format, readFileContent pictures and paging, export links, the gte/lte search mechanics) were removed from the prompt, about 3.6k characters shorter; the BunnyQuery-only rules stay, including listing files with getUniqueId `"src::"` and condition `gte`, and skipping the table-name search when getTables returned the whole list. The Settings sentence names Answer mode. `buildChatSystemPrompt`'s signature is unchanged.

### Widget

- The same changes through the engine (tool-list reuse only when the embedder sets `reuseMcpToolList: true`). The widget never sent the question twice.

## 1.19.1 (2026-11-22)

Fixes to the indexing rows, and file uploads for users who are not the project owner. 1.18.0 and 1.19.0 have no entries here.

### Engine

- **Uploads by users other than the project owner index again.** skapi lets only the owner read a stored file that has no file record yet, and the engine read the file's link before creating that record, so for anyone else the upload failed with "No access to this file." When the link is refused, the engine now creates the file record first (as the uploader, at the group they chose) and asks again.
- **A row says "Queued" only before its file's first pass finishes.** Between two passes of one file the queue can still list the pass that just ended, and the row read "Queued" next to pages already saved.
- **Rows when more than 20 passes wait in the queue.** The queue check reads 20 running and 20 waiting passes. A list the server marks as not ended now counts as cut off even when it is shorter than 20. A file whose run is open and that is not in the complete running list reads "Queued" instead of "Fetching status". A file seen leaving the queue stays "Indexed" when a later check comes back cut off. A file just sent reads "Queued" while another file is running.
- **Page progress** ("9 of 40 pages") is found by the row's key or file name when the row has no storage path yet, so it no longer drops out between passes.

### Widget

- The same rows through the engine.
- Also in this release, from a commit after the 1.19.0 publish (46b6545): retrying a file whose indexing failed, upload error summaries, the "Preparing files..." loader on drop, link refresh feedback and animated dots while a reply is generated.

## 1.17.0 (2026-10-26, not yet published)

The chat prompt no longer sends spreadsheet numbers to `queryGrid`. It now gives the agent a search path through the database (tables, then indexes and tags, then records, each searched by beginning and by ending when the exact name is unknown) and computes figures from the detail rows of the indexed records, with the roll-up sheets and total rows excluded. Pairs with the MCP server dropping `queryGrid` from the chat tool profile.

## 1.16.1 (2026-10-24)

Store file links follow skapi's new rule for them.

### Engine

- `composeUserMessage` sends the `file_urls` directive again (`WORKER_URL_REMINT_ENABLED`
  is true): a link to a store file now lives 10 minutes unless the file is public (skapi's
  `get-signed-url`), so the indexing worker mints a fresh CDN link right before each provider
  call and a request that waited in the queue never hands over a stale one. The directive was
  off since 2026-07-27 because the worker then minted an S3 presign, which refuses a provider's
  HEAD probe; the worker mints the CDN link now, which answers HEAD and GET.

### Widget

- `getTemporaryUrlDb`'s notes describe the link as it is now: 24 hours for a public file,
  `expires` (10 minutes by default, 1 hour at most) for any other, `?v=<etag>` so a changed file
  is a new address, and minted only for a caller who may read the file. The widget's own
  behaviour is unchanged.

## 1.16.0 (2026-10-23)

Streaming is no longer a choice, and the socket takes its name.

### Engine

- `configureChatEngine`'s `liveStreaming` key now means **socket delivery** of the streamed
  reply, which `liveStreamingRealtime` meant until 1.15.6; `liveStreamingRealtime` is
  ignored. Streaming itself has no key any more: the engine streams every chat turn whenever
  the host handed over both `forwardRequestFinalize` and `forwardRequestStream` (under either
  spelling), and a host that wants buffered replies hands over neither.
  `liveStreamingEnabled()` derives from the hooks; `liveStreamingSocketEnabled()` is the
  socket.
- Why: every deployed region's worker relays the response bytes and every current skapi-js
  carries the flag, so "stream or buffer" had one right answer, while "push the stream over
  the host's websocket" is a real choice: `joinRealtime` takes the connection's room for the
  length of a turn.

### Widget

- The `liveStreaming` init option now means the websocket, **off** by default: `null` or
  `false` streams on the one-second poll alone, `true` pushes each chunk as it is relayed.
  `liveStreamingRealtime` is ignored. An embed that passed `liveStreaming: false` to buffer
  replies now gets them streamed on the poll instead. The widget still buffers, with its one
  console warning, when the page's skapi-js is too old to carry the stream flag.
- The hosted chat page (`infra/bq-template.html`) passes `liveStreaming: true`: it owns its
  skapi instance, so the socket is safe there.

## 1.15.6 (2026-10-23)

Documentation only; the widget and the engine are byte-for-byte 1.15.5.

- README rewritten for the current code base: the 1.15 init options and their ceiling rule,
  live replies and websocket delivery, grounded answers with citations, duplicate skipping,
  text-first PDFs with parallel lanes and stored page text, spreadsheet rows stored by the
  server, the web-off default for plain links, the engine's citation, stop-waiting and
  duplicate helpers, and the default models (Claude Haiku 5.5, GPT-6 Luna).
- HISTORY.md rebuilt from the npm publish dates and the version-bump commits: every
  "Unreleased" block filed under the version that shipped it, entries added for 1.10.1 to
  1.15.2, three early entries moved to where their work shipped, two dates corrected.

## 1.15.5 (2026-10-21, published)

### Widget

- The **"Fetching history..."** strip at the top of the chat is translucent: the band
  behind the words is the page colour at 78% and fades to clear below, so the newest rows
  keep showing through while older history loads. The dashboard's chat page got the same
  change on the same day.

## 1.15.4 (2026-10-19, published)

New default models. 1.15.3 was skipped: the source went from 1.15.2 straight to 1.15.4.

### Engine

- A project that never picked a model now uses **Claude Haiku 5.5** on Claude and
  **GPT-6 Luna** on OpenAI (`DEFAULT_CLAUDE_MODEL` / `DEFAULT_OPENAI_MODEL`; the widget
  carries the same two values). Until now the defaults were Claude Sonnet 5.5 and
  GPT-6.1 Sol. A model a project saved is kept.
- `budget.ts` gains an exact row for `claude-haiku-5-5` (1,000,000 context, 128,000
  output, the catalogue's numbers), so a widget host that never loads the model
  catalogue does not fall to the 200,000 / 64,000 `claude-haiku` family row.

### Repo

- The `tests/` folder and the `npm test` script were removed from the repository on
  2026-10-16. The package's `files` list never included them, so nothing published changed.

## 1.15.2 (2026-10-12, published)

### Engine

- `ChatSession` keeps a derived index of the background task queue, so `hasLiveIndexRun`
  and `claimIndexRun` answer from a map instead of scanning every queued entry. With
  thousands of files queued at once (a bulk upload) the cost of each dispatch stays flat.

## 1.15.1 (2026-10-12, published)

Duplicate attachments are skipped, and scanned pages get their text stored once.

### Engine

- New `skipDuplicateFiles` config key and `duplicates.ts` (`findDuplicateUpload`,
  `isDuplicateCandidateId`). A chat attachment the signed-in user already uploaded to the
  project (same stored name, same size in bytes, same uploader, found from the file's
  `src::` record) is neither uploaded nor indexed again; the turn uses the stored copy's
  url. The project's `skip_duplicate_files` setting (`bq::settings`, on unless the owner
  turned it off) is the ceiling; a host can only restrict below it. A failed lookup never
  blocks an upload.
- Indexing user message: the page-text rule for scanned pages. A page without a text layer
  gets one record from the model's own pass naming the page and carrying its text, which the
  server stores once as that page's verbatim text; a page with a text layer is stored
  server-side before the model is called.

### Widget

- `skipDuplicateFiles` init option (`null` follows the project). A reused attachment's chip
  reads "already uploaded".

## 1.15.0 (2026-10-12, published)

### Engine

- Default models moved to **Claude Sonnet 5.5** and **GPT-6.1 Sol** (`DEFAULT_CLAUDE_MODEL`
  / `DEFAULT_OPENAI_MODEL`, mirrored in the widget). `budget.ts` gains `gpt-6.1-sol` and a
  `gpt-6.1` family row at the gpt-6 figures. Superseded by 1.15.4 on 2026-10-19.
- 1.15.0-beta.0 was a source bump only and never reached npm.

## 1.14.0 (2026-10-12, published)

The accuracy release of the reliability plan: answers grounded in documents and cited, with
the web off unless a project turns it on.

### Engine

- **Retrieval memory** (`retrieval_memory.ts`): the engine keeps a note of what each answer
  read (tool names, files, pages) and carries recent notes into the next request under a
  token budget (`applyRetrievalNotes`), so a follow-up question does not start from zero.
- **Citations** (`citations.ts`): `citationsFor`, `citationLinkPart`, `retrievalNoteOfAnswer`
  and `answerUsedNoDataTool` turn a reply's note into file-and-page citations, and tell a
  reply that read no data apart from one that did.
- **Web access switch.** New `webAccess` config key, resolved against the project's
  `web_access` setting (`bq::settings`, off by default). Claude's `web_fetch` and OpenAI's
  `web_search` are attached to a chat turn only when the resolved value is true, and the
  system prompt says which case applies. `webAccessEnabled` / `resolveWebAccess` exported.
- **Document rules** in the chat system prompt: for a question about an uploaded file, find
  the file first (`getFileOutline`, `searchText`), read it instead of guessing from record
  summaries, and say so when the data does not hold the answer.
- A chat turn asks the MCP server for its `chat` tool profile (`?profile=chat`): the data
  tools only, instead of the full list, on every model step.

### Widget

- `liveStreaming` is **on by default**. New `webAccess` init option (`null` follows the
  project).
- Citation chips (`.bq-citations`) under an answer, and the no-source mark when nothing was
  read.
- 1.14.0-beta.0 was a source bump only and never reached npm.

## 1.13.0 (2026-10-06, published)

### Engine

- Three **grounding rules** in the chat system prompt, right after "Knowledge lookup": answer
  only from the data (a tool result in this conversation, an attached file, the project
  description, what the user said); when the data does not have it, say so and say what was
  searched; keep what the data says apart from what was worked out from it.
- A reply's timestamp is the moment skapi received the response (`responded`, the row's
  `rtmp`), on a history load and on a live settle alike, instead of the browser's poll clock
  or an `updated` value that csr-finalize rewrites.
- `skapi-js` is no longer a dependency of the package: the SDK is host-injected through
  `configureChatEngine` and never bundled. Source maps ship beside `dist/engine.*`.

### Widget

- The Stop dialog of an indexing row offers "Also stop the N other files being indexed", so
  one confirmation ends every file in flight.

## 1.12.1 (2026-10-01, published)

The reply a user is waiting on can be cancelled, in both chatboxes.

### Stop waiting for a reply

- The running turn's "Thinking" bubble carries a small x ("Stop waiting for this reply").
  It cancels the request on the server (csr-cancel marks the running row cancelled, so
  the worker stops relaying and no answer is ever stored for it), stops the poll,
  marks the question "(cancelled)" the same way a cancelled queued message is, and
  promotes the next queued message so its own "Thinking" appears. The composer is
  free immediately: the next send goes out as an ordinary send rather than queueing
  behind the cancelled turn. Disabled until the server has acknowledged the request,
  exactly like the queued-message x. Indexing passes keep their own Stop on the
  collapsed row.
- Engine: `ChatSession.cancelPendingReply(msg, idx)`, handed the pending ASSISTANT
  bubble. Both clients call it.
- Engine fix underneath it: stopping a foreground poll now SETTLES it. The early-probe
  wrapper used to mark itself settled inside `stop()` and then ignore the base poll's
  stopped result, so the promise never resolved; a dispatch chain awaits that promise
  to clear `sending`, so stopping a running turn's poll would have wedged every later
  send onto the queued path.
- Engine fix: a stopped poll result, or a `cancelled` envelope from a row cancelled
  elsewhere (another tab or device), is no longer read as an empty answer. It used to
  become "No text response received from AI provider." on the immediate-send and
  queued-send paths and was written into the history cache under that name.
- Styles: `.bq-cancel-wait-btn` in the shared `styles/chat.css`.
- Styles: the dot-trail inside a bubble now reserves the width of its widest frame, so
  the bubble no longer changes width three times per cycle and the stop-waiting control
  holds still. Applies to the "Thinking" bubble and the drafting bubble in both
  chatboxes; loaders that trail a label are unchanged.

### Also in 1.12.1

- `isRetriedFailure` (`errors.ts`): an error the worker went on to retry is marked
  `isRetried` on its bubble, styled apart from a real failure, and skipped when a file's
  status is read, so a retried pass no longer paints the row red.
- `cancelIndexingGroup` sweeps the file's worker-queued windows at once
  (`_sweepCancelledIndexing`), which matters now that a document's windows run in several
  lanes and settle out of order.
- 1.12.0 was the source bump of the cancel work and never reached npm; 1.12.1 is what shipped.

## 1.11.1 (2026-09-29, published)

### Engine

- `budget.ts` gains rows for Claude Sonnet 5.5, Opus 5.5 and Fable 5.1, for `gpt-6-astra`,
  `gpt-6-sol` and `gpt-6-luna`, and a `gpt-6` family key. Without them the three GPT-6
  models fell to OpenAI's 128,000-token platform default: a 28,000-token chat input budget
  and 10,000-character MCP pages instead of 136,160 and 60,000.

## 1.11.0 (2026-09-20, published)

The engine and the widget move to skapi-js's `forwardRequest` family, which replaces the
`clientSecretRequest` family. Nothing an existing host does changes.

### Engine

- New `configureChatEngine` keys: `forwardRequest`, `forwardRequestHistory`,
  `forwardRequestFinalize` and `forwardRequestStream`. The engine calls
  `forwardRequest(null, opts)` and sends the secret's name as `secretName`.
- The old keys, `clientSecretRequest`, `clientSecretRequestHistory`,
  `clientSecretRequestFinalize` and `clientSecretRequestStream`, are still accepted and marked
  deprecated. Through them the engine sends `clientSecretName` exactly as before, so a host
  written against an earlier release keeps working unchanged. Where both spellings are given,
  the new one wins. A host that injects neither fails with a message naming both.
- `skapiSupportsStreaming` and `streamRecoveryEnabled` accept either spelling. A streaming SDK
  still has to carry a whole pair, reader and finalize, under one spelling.

### Widget

- The widget picks the family on each embedder's page. It uses the `forwardRequest` family when
  the page's skapi-js has `forwardRequestHistory`, and the `clientSecretRequest` family otherwise.
  It never decides by `forwardRequest` alone, because on an earlier skapi-js that name is a
  different, retired method with its own endpoint.
- The chat transport, the queued-send cancel and the Google sign-in code exchange all go through
  that one decision.

## 1.10.12 (2026-09-11, published)

### Widget

- A small style cleanup in `styles/chat.css`.

## 1.10.11 (2026-09-10, published)

A republish of 1.10.10 with no source change.

## 1.10.10 (2026-09-10, published)

The bump commit is titled 1.10.9, but the version went from 1.10.8 straight to 1.10.10, so
1.10.9 does not exist.

### Engine

- A live indexing pass records its duration the moment it settles (`_stampPassDuration`),
  not only when it is read back from history. `BgTaskEntry.poll` takes an `onResponse`
  callback that receives the response and its meta.

## 1.10.8 (2026-09-09, published)

### Engine

- A failed pass also reports how long it ran (`_tsStart` is set on failed passes by the
  history mapper).

## 1.10.7 (2026-09-09, published)

### Engine

- Indexing pass duration: `ChatMessage._tsStart`, `formatDuration` in `time.ts`, and the
  duration appended to an indexing response bubble.

## 1.10.6 (2026-09-09, published)

### Engine

- `_hasLiveIndexEvidence` counts a pass settled within `RECENT_INDEX_PASS_EVIDENCE_MS` as
  evidence that indexing is live, so a chat with no local dispatch of its own still sees it.

## 1.10.5 (2026-09-09, published)

A republish of 1.10.4 with no source change.

## 1.10.4 (2026-09-09, published)

### Engine

- Custom chat greeting per project: `greeting.ts` and the `chat_greeting` key of the
  project's `bq::settings` record (`project_settings.ts`). A custom greeting replaces the
  default one, project name included; the default is unchanged when none is set.

### Widget

- Shows the project's greeting; small `widget.css` and `chat.css` adjustments.

## 1.10.3 (2026-09-08, published)

### Widget

- Link text-decoration styles in `widget.css`.

## 1.10.2 (2026-09-07, published)

### Engine

- `link_markup.ts` renders a link's glyph and label as separate HTML so each can be styled,
  with the matching rules in `chat.css`. The widget's file-download anchor uses the same
  glyph.

## 1.10.1 (2026-09-06, published)

### Engine

- Indexing groups show only the **newest** run of a file once older runs have settled; a
  superseded run is hidden while an active one stays visible.
- The `run::` record's terminal verdict is laid over a loaded group
  (`overlayRunRecordVerdict`). A run the worker ended (three failed retries, a stale grant,
  a cap-out) used to read "Indexed" off its last settled pass, and the files page painted
  the badge green over the record's "error"; the record's error, cancelled or done now wins
  when it describes this run. Visible work and a live queue hit still win over the record.
- Indexing prompts: the TABULAR rule yields when the message says the server has already
  saved the spreadsheet rows; every record saved from a window carries the window's `win::`
  tag, so the worker can remove exactly that window's records before re-sending it; the
  e-mail rules are tightened.

## 1.10.0 (2026-09-04, published)

Email (`.eml`) is read, windowed and indexed like any other document.

### Email (.eml) indexing

- `.eml` (RFC822 email) joins the server-extractable set and the paged set, so a
  message of any size is read end to end instead of being decoded as text
  (which would have inlined its base64 attachment blobs as prose). The layer
  parses the MIME container and hands back one text: a header block (Subject,
  From, To, Cc, Bcc, Reply-To, Date as ISO 8601 when it parses (else the raw
  header text), Message-ID, In-Reply-To, References, and an `Attachments: N`
  count when the message has any), the body (`text/plain` preferred over its html twin, which is
  tag-stripped when it is all there is), and the text of every attached
  document under its own `=== ATTACHMENT i/N ===` heading: spreadsheets,
  documents, csv, calendars and the text layer of a PDF. A forwarded message
  nested inside is rendered as its own `=== EMAIL ===` block.
- Pictures attached to or inlined in a message are extracted into `__MEDIA__`
  like the pictures embedded in any other document, with the media anchor
  quoted on the `[picture ...]` line. Every other attachment is read inline and
  never saved as a separate file; signed, encrypted and `winmail.dat` parts are
  marked and skipped, and a scanned PDF attachment yields a marker, not pages.
- New indexing rule: one record per email message in `email_messages` (a
  forwarded message gets its own), indexed on the ISO date and tagged with the
  sender, every recipient and the subject; attachment text is datafied by its
  own kind and every record carries the email's `src::` reference.
- `.eml` reaches the widget's MIME map (`message/rfc822`), the landing-page
  format list, the MCP `readFileContent` description and both READMEs. The
  widget and console token estimators count an `.eml` like any other
  server-parsed container (0), not as text: its bytes are mostly base64
  attachment blobs, and a 380 KB mail with one photo had estimated at 127k
  tokens and disabled Send. The engine now also exports
  `isPagedReadFile`, `isImageVisionFile` and `isWindowedReadFile`, pinned by the
  new `tests/email-format.cjs`.
- Deploy order: the OfficeExtractionPy layer (the admin-stack worker AND the
  record-stack ExtractFileText, per region) must land BEFORE this package is
  republished. In the reverse order every `.eml` is paged and answered with
  UNSUPPORTED_FORMAT on every window until the layer arrives.

---

## 1.8.0 (2026-07-27, published)

A date-and-time under every message, the export-link fix, and the indexing
prompt rules that stop an answer being drawn from a partial read.

### Timestamps under every message (new engine module `src/engine/time.ts`)

- `formatChatTimestamp(ms)` and `wallClockNow()`, plus `ChatMessage._ts`. Every
  settled bubble shows a small, muted date and time: a user bubble the request
  time (`created`), an assistant bubble the response time (`updated`), down to the
  second. Pending "Thinking" bubbles show nothing. History bubbles are stamped
  from the request record; live bubbles are stamped from the wall clock and
  reconciled to the server value on the next history load. Depends on the
  `created` timestamp now exposed by `clientSecretRequestHistory` in skapi-js.

### Export and download links repaired

- New `repairUrlEntities` in `src/engine/links.ts`, applied in both the `src::`
  branch and the generic `[label](url)` / bare-URL branch of
  `classifyInlineLink`. A model reproducing a download link sometimes wrote the
  query separators HTML-escaped (`&amp;`), which reached the browser literally, so
  the real parameters vanished, the signature could not be found, and storage
  rejected the link. This is the dead CSV/export link.

### Answers must not come from a partial read

- Three new instruction blocks in `src/engine/prompts/chat_system_prompt.ts`:
  "Complete answers over stored data", "Never assert absence from a partial read",
  and "Embedded values". A default query returns roughly the first 50 records,
  which is a sample; the model was counting, totalling and asserting absence from
  it. It must now read the complete matching set across every relevant table and
  file, and fetch-and-match itself when the value it wants sits inside a longer
  string. Mirrored in the MCP tool descriptions.

### Widget parity

- The message body carries `translate: "no"`, matching `agent.vue`. Chrome's page
  translator was re-tokenizing bubble text and dropping spaces, which mangled
  Korean and other CJK content, including data read out of the user's own files.
- The widget bootstrap now passes `windowedIndexing` (default on, opt out with
  `windowedIndexing: false` in init opts). It was never passing the key, so
  `windowedIndexingEnabled()` stayed false and embedders fell back to the
  client-driven CONTINUE loop capped at `MAX_INDEXING_RESUME_PASSES`: the tab had
  to stay open and a large text or grid file stopped early. `apply_file_windows`
  is deployed in all 7 regions, which is the precondition the flag exists for.

---

## 1.7.0 (2026-07-24, published)

Per-run indexing rows, making older history reachable once a page of it collapses
into a single row, and the inline-link system rebuilt around one shared
classifier.

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

### One link classifier, shared (was forked)

- New `classifyInlineLink` in `src/engine/links.ts` is the single place that
  decides what a link target IS: an external URL, a file in this project's db
  storage (rendered as a re-mintable chip), or a bare storage path. Both clients
  now render from it. `agent.vue`'s private fork of ~13 link helpers is deleted
  and the widget's `buildLinkPartFromGroups` is a thin wrapper, so a link bug can
  no longer be fixed in one client and left in the other, which is exactly how
  every item in the next section reached production.

### Link handling, fixed

- **A URL containing a space no longer freezes the tab.** `createInlineLinkRegex`
  had a nested-quantifier alternative that backtracks exponentially: a link whose
  URL contained a space (which the MCP tools legitimately emit) took ~60s to parse
  at 30 characters and did not finish beyond ~45. The regex now matches one
  character per step with disjoint branches, so it is linear. Runs over the whole
  reply on every render, so this was a hard hang, not a slow case.
- **A URL with a space no longer renders as a dead download chip.** Whitespace
  knocked a URL out of the URL branch into the storage-path branch, so an MCP
  download link rendered as an `_expired_.url/https%3A/…` chip that resolved to
  nothing. `isHttpUrlLike` classifies it correctly and `repairUrlWhitespace`
  repairs it (whitespace stripped from our own `/download/<id>` links, whose
  alphabet cannot contain it; percent-encoded elsewhere so a real `my report.csv`
  survives).
- **Stored attachment links no longer go dead on reload.** The `_expired_.url`
  placeholder that the history sanitizer writes was not recognised when read back,
  so every stored attachment link rendered as a non-refreshable link to a host
  that does not resolve, and the model would copy the dead URL into new replies.
  New `readExpiredAttachmentHref` is consulted before the plain-URL branch. Fixes
  existing history on read; no migration.
- **Only real files render as chips.** `mailto:`, `tel:`, `#anchor`, `http://`
  and a db URL belonging to another project were all being turned into download
  chips for storage paths that never existed. Only an `http(s)` URL on this
  project's db host becomes a re-mintable file now; everything else is a plain
  link.
- A bare URL no longer swallows the sentence's trailing punctuation into its href.
- The history sanitizer rewrites only this service's own db URLs, so a
  third-party link pasted alongside an attachment is left intact instead of being
  turned into a placeholder for a path that never existed.

### `db:` link scheme

- Storage-path links can now be **declared** rather than inferred:
  `[name](db:folder/file.csv)`. The classifier strips the `db:` prefix and treats
  the rest as a storage path, so link identity no longer depends on guessing from
  the absence of `http`. Bare paths still resolve exactly as before, so no
  existing message changes.

### Expired-link TTLs unified

- `EXPIRED_LINK_REFRESH_EXPIRES_SECONDS` (20 min) and `LINK_REFRESH_WINDOW_MS`
  moved into the engine, with the trust window derived from the TTL so "the cache
  must expire before the URL does" holds by construction.
- **Widget parity.** The widget's expired-chip re-mint was minting a
  `generate_temporary_cdn_url` link, which ignores `expires` and lives for the
  rest of the UTC day plus the next (24 to 48h), while calling it a 10-minute
  link, and it never dropped its cached href. It now mints a plain short-lived
  presign like the dashboard and expires its cache on the same wall-clock
  boundary.

---

## 1.6.4 (never published on its own; shipped inside 1.7.0)

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

## 1.6.3 (never published on its own; shipped inside 1.7.0)

- Continue passes get a compact "Indexing (continuing)" label so a big file's
  multi-window run reads as progress rather than the same task repeating.
  Mirrors `agent.vue`'s history mapping.
- **Fixed a forked continuation chain.** With windowed indexing on, the worker
  drives the text/grid loop, so the client must not also resume. Two drivers
  each enqueueing a continuation per pass produced duplicate records and runaway
  passes. Gated on the flag, so the old client-driven path is untouched when
  windowing is off.

---

## 1.6.2 (2026-07-22, published)

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

## 1.6.0 (2026-07-16, published)

Vision indexing for PDFs, and resume across passes. (Filed under 1.5.7 when first written;
the work is commit f9a53b9 of 2026-07-16 and shipped as 1.6.0.)

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

## 1.5.7 (2026-07-13, published)

- **`isPagedReadFile`**: spreadsheets and PDFs are indexed by **paging through
  the `readFileContent` tool** rather than a capped inline dump or a web_fetch
  URL. That is what lets a huge sheet be read row-window by row-window and a
  scanned PDF page image by page image, with embedded photos reaching the vision
  model. The indexing message instructs the agent to page every window and
  datafy each.

---

## 1.5.6 (2026-07-13, published)

- Indexing system prompt: the BIG or SCANNED files rule (the inline content may be only
  the first part of a large file) and the VISION rule (read the images a `readFileContent`
  window or an inline attachment carries: scanned PDF pages, embedded photos).

---

## 1.5.5 (2026-07-09, published)

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

## 1.4.5 (2026-06-30, published)

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

## 2026-06-23 (no version bump; shipped inside 1.3.0)

Server-side office extraction, and the overwrite prompt. Commit 7fb6a6b, the day before
1.3.0; filed under 1.2.3 when first written.

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

## 1.2.3 (2026-06-12, published)

- The "Indexing: <file>" label carries the file's MIME type and size when they are known
  (commit 395280f, "mime fix", in the single-file widget of the time).

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
