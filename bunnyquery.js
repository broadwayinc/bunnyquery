(function () {
  'use strict';

  // src/engine/attachment_parsers.ts
  var MAX_PARSED_CONTENT_CHARS = 2e5;
  var _parsers = [];
  function registerAttachmentParser(parser) {
    if (parser && typeof parser.match === "function" && typeof parser.parse === "function" && _parsers.indexOf(parser) === -1) {
      _parsers.push(parser);
    }
  }
  function findAttachmentParser(name, mime) {
    for (let i = 0; i < _parsers.length; i++) {
      try {
        if (_parsers[i].match({ name, mime })) return _parsers[i];
      } catch {
      }
    }
    return void 0;
  }
  async function parseAttachmentContent(file, name, mime) {
    const parser = findAttachmentParser(name, mime);
    if (!parser) return null;
    let raw;
    try {
      raw = await parser.parse(file);
    } catch (err) {
      console.error(
        `[chat-engine] attachment parser ${parser.name || "(unnamed)"} failed for ${name}:`,
        err
      );
      return null;
    }
    let text = (raw == null ? "" : String(raw)).trim();
    if (!text) return null;
    if (text.length > MAX_PARSED_CONTENT_CHARS) {
      text = text.slice(0, MAX_PARSED_CONTENT_CHARS) + `
...[truncated for length; original ${text.length} characters]`;
    }
    return text;
  }

  // src/engine/config.ts
  var _config = null;
  function configureChatEngine(config) {
    _config = config;
    if (config.attachmentParsers) {
      for (const parser of config.attachmentParsers) registerAttachmentParser(parser);
    }
  }
  function chatEngineConfig() {
    if (!_config) {
      throw new Error(
        "[chat-engine] configureChatEngine() must be called before using the engine."
      );
    }
    return _config;
  }
  function windowedIndexingEnabled() {
    return _config?.windowedIndexing === true;
  }
  function liveStreamingRealtimeEnabled() {
    return liveStreamingEnabled() && _config?.liveStreamingRealtime === true;
  }
  function liveStreamingEnabled() {
    return _config?.liveStreaming === true;
  }
  function streamRecoveryEnabled() {
    if (_config?.streamRecovery === false) return false;
    return typeof _config?.clientSecretRequestStream === "function";
  }
  function skapiSupportsStreaming(sk) {
    return !!sk && typeof sk.clientSecretRequestStream === "function" && typeof sk.clientSecretRequestFinalize === "function";
  }
  function pollOpt() {
    const p = _config?.poll;
    return p === void 0 ? {} : { poll: p };
  }

  // src/engine/office.ts
  var OFFICE_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
    "doc",
    "docx",
    "docm",
    "xls",
    "xlsx",
    "xlsm",
    "ppt",
    "pptx",
    "pptm",
    "hwp",
    "hwpx",
    "ods",
    "odt",
    "odp",
    "epub",
    "eml"
  ]);
  var TEXT_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
    "csv",
    "tsv",
    "tab",
    "txt",
    "text",
    "log",
    "md",
    "markdown",
    "rst",
    "json",
    "ndjson",
    "jsonl",
    "geojson",
    "xml",
    "yaml",
    "yml",
    "toml",
    "ini",
    "conf",
    "cfg",
    "properties",
    "env",
    "rtf",
    "html",
    "htm",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "c",
    "h",
    "cpp",
    "cc",
    "hpp",
    "cs",
    "php",
    "swift",
    "sh",
    "bash",
    "zsh",
    "sql",
    "css",
    "scss",
    "less",
    "vue",
    "svelte",
    "tex",
    "srt",
    "vtt"
  ]);
  function isTextMime(m) {
    return m.startsWith("text/") || m.endsWith("+json") || m.endsWith("+xml") || m.endsWith("+yaml") || m === "application/json" || m === "application/ld+json" || m === "application/xml" || m === "application/yaml" || m === "application/x-yaml" || m === "application/javascript" || m === "application/x-javascript" || m === "application/x-sh" || m === "application/x-ndjson" || m === "application/csv" || m === "application/rtf" || m === "application/sql" || m === "application/toml";
  }
  function isServerExtractable(name, mime) {
    const ext = (name || "").split(".").pop()?.toLowerCase() || "";
    if (OFFICE_FILE_EXTENSIONS.has(ext)) return true;
    if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
    const m = (mime || "").toLowerCase();
    if (isTextMime(m)) return true;
    return m.includes("officedocument") || m.includes("opendocument") || m.includes("hwp") || m.includes("epub") || m === "application/msword" || m === "application/vnd.ms-excel" || m === "application/vnd.ms-powerpoint";
  }
  var PAGED_READ_EXTENSIONS = /* @__PURE__ */ new Set([
    // grids
    "xls",
    "xlsx",
    "xlsm",
    "ods",
    // delimited text (row-windowed by the layer)
    "csv",
    "tsv",
    "tab",
    // documents
    "pdf",
    "docx",
    "docm",
    "pptx",
    "pptm",
    "doc",
    "ppt",
    // Korean word processor (OLE/CFB and OOXML-style variants)
    "hwp",
    "hwpx",
    // opendocument text/presentation (ods is a grid, listed above)
    "odt",
    "odp",
    // other long-form documents
    "epub",
    "rtf",
    "html",
    "htm",
    "eml",
    // email (RFC822): body plus attachment text, char-windowed
    // plain text / data / markup
    "txt",
    "md",
    "markdown",
    "log",
    "json",
    "jsonl",
    "ndjson",
    "xml",
    "yaml",
    "yml"
  ]);
  function isPagedReadFile(name, mime) {
    const ext = (name || "").split(".").pop()?.toLowerCase() || "";
    if (PAGED_READ_EXTENSIONS.has(ext)) return true;
    const m = (mime || "").toLowerCase();
    return m === "application/pdf" || m === "application/vnd.ms-excel" || m.includes("spreadsheetml") || m.includes("opendocument.spreadsheet");
  }
  function isImageVisionFile(name, mime) {
    const ext = (name || "").split(".").pop()?.toLowerCase() || "";
    return ext === "pdf" || (mime || "").toLowerCase() === "application/pdf";
  }
  var _extractPlaceholderSeq = 0;
  function makeExtractPlaceholder(seed) {
    _extractPlaceholderSeq += 1;
    const slug = (seed || "file").replace(/[^a-zA-Z0-9]+/g, "_").slice(-48);
    return `{{SKAPI_FILE_CONTENT::${slug}-${_extractPlaceholderSeq}}}`;
  }
  var _renderPlaceholderSeq = 0;
  function makeRenderPlaceholder(seed) {
    _renderPlaceholderSeq += 1;
    const slug = (seed || "file").replace(/[^a-zA-Z0-9]+/g, "_").slice(-48);
    return `{{SKAPI_RENDER::${slug}-${_renderPlaceholderSeq}}}`;
  }
  var RENDER_PAGES_PER_WINDOW = 5;
  var _windowPlaceholderSeq = 0;
  function makeWindowPlaceholder(seed) {
    _windowPlaceholderSeq += 1;
    const slug = (seed || "file").replace(/[^a-zA-Z0-9]+/g, "_").slice(-48);
    return `{{SKAPI_WINDOW::${slug}-${_windowPlaceholderSeq}}}`;
  }
  function isWindowedReadFile(name, mime) {
    if (isImageVisionFile(name, mime)) return false;
    return isPagedReadFile(name, mime);
  }
  function composeUserMessage(text, attachmentUrls, opts) {
    let composed = text;
    let composedForLlm = composed;
    if (attachmentUrls.length > 0) {
      const lines = attachmentUrls.map((u) => `- [${u.name}](${u.url})`);
      composed = `${text}

Attached files:
${lines.join("\n")}`;
      composedForLlm = composed;
    }
    let extractContent;
    let fileUrls;
    if (attachmentUrls.length > 0) {
      const extractFiles = [];
      if (extractFiles.length > 0) {
        const directives = [];
        const sections = extractFiles.map((u) => {
          const storagePath = u.storagePath || u.name;
          const placeholder = makeExtractPlaceholder(storagePath);
          directives.push({ path: storagePath, placeholder, name: u.name });
          return `===== ${u.name} =====
----- BEGIN FILE CONTENT -----
${placeholder}
----- END FILE CONTENT -----`;
        });
        extractContent = directives;
        composedForLlm = `${composedForLlm}

Extracted content of attached office files (read inline below; do NOT fetch their URLs):

` + sections.join("\n\n");
      }
      const urlFiles = [];
      if (urlFiles.length > 0) {
        fileUrls = urlFiles.map((u) => ({ path: u.storagePath || u.name, url: u.url }));
      }
    }
    return { composed, composedForLlm, extractContent, fileUrls };
  }

  // src/engine/attachments.ts
  function groupAttachmentFailures(attachments) {
    const groups = {};
    const order = [];
    (attachments || []).forEach(function(att) {
      if (!att || att.status !== "error" && att.status !== "indexError") return;
      const code = String(att.errorCode || "");
      const message = String(
        att.errorDetail || att.errorMessage || (att.status === "indexError" ? "File indexing failed" : "File upload has failed")
      );
      const key = code + "\0" + message;
      if (!groups[key]) {
        groups[key] = { code, message, files: [] };
        order.push(key);
      }
      groups[key].files.push(String(att.name || "(unnamed file)"));
    });
    return order.map(function(k) {
      return groups[k];
    });
  }

  // src/engine/prompts/chat_system_prompt.ts
  function buildChatSystemPrompt(params) {
    const { projectId, serviceName, serviceDescription, greeting, canUpload} = params;
    const g = params.indexAccessGroup;
    const indexGroupLiteral = typeof g === "number" ? String(g) : g === "public" || g === "private" || g === "authorized" || g === "admin" ? `"${g}"` : '"authorized"';
    let systemPrompt = `
You are a dedicated assistant for the project ID: "${projectId}".
Scope: Only answer questions about this project and its data. Do not answer questions about other projects or topics unrelated to this project. When the user refers to "my database", "my data", or "my files", treat those as references to this project's database and file storage. The ONE exception is BunnyQuery itself - what this app is, what it can do, and how to use it - which is always in scope: answer it from the "About BunnyQuery" section at the end of this prompt.
Knowledge lookup: Before saying you don't know or that something isn't in the chat history, ALWAYS query this project's database through the available MCP tools to look for the answer. The user's data is the source of truth - the chat transcript is not. Only respond with "I don't know" or "I couldn't find that" after you have actually searched the project's data and come back empty.
NUMBERS FROM A SPREADSHEET: use queryGrid, never mental arithmetic over records. A total, a count, an average, a "how many mention X", a "which one is biggest" - all of those are computed server-side over EVERY row of the file and come back with the sheet, the row count and the row numbers they were made from. Records are a SAMPLE, and a sample added up is a confident wrong number. Quote the row count and the sheet alongside the figure so the reader can check it.
CALL queryGrid describe FIRST, before any figure. Workbooks routinely state the same money more than once: a detail sheet, then per-song, per-album and per-artist sheets that each re-total it, plus a summary sheet whose bottom row is the file total. Those look like four different answers and are one. describe names which sheets restate which, and which rows are totals. Pick ONE sheet, say which you picked, and never add figures across a sheet and its summary. If the reply carries a warning about restatement, repeat it to the user.
A FILE TOTAL IS NOT A ROW'S TOTAL. The biggest number on a summary sheet is the whole file, not the thing that was asked about. Before quoting any figure, check it is scoped to what the question named: filter by the column that identifies it and report how many rows matched.
Complete answers over stored data: The database holds one record per spreadsheet row, and each uploaded file becomes many records. ONE file is routinely SPLIT ACROSS SEVERAL TABLES - a summary row in one table, its page or row content in another, its extracted photos and other media in "__MEDIA__", and the indexer often invents a differently-named table on each pass. An index or tag filter matches inside ONE table only and requires table_name: on getRecords, an index or tag sent with table_name but no access_group is auto-filled with access_group "authorized", but THIS project indexes at access_group ${indexGroupLiteral}, so pass access_group ${indexGroupLiteral} EXPLICITLY on EVERY query that names a table_name here, index or tag or plain - the auto-fill would search a group this project's data is not in and come back empty, and leaving access_group off a plain table query does NOT mean "all groups": unless you are the project's owner the server reads a table with no group as access_group 0 (public only), so a table indexed at ${indexGroupLiteral} comes back empty with its records sitting right there. Files uploaded before the project's setting changed may sit at another group, so when a scoped query comes back empty, retry it across the other groups (0, 1, "private") before concluding there is nothing, while an index or tag WITHOUT table_name FAILS with an error instead of answering, so read the error rather than guessing. Reference is the exception: reference ALONE spans EVERY table and EVERY access group, so getRecords with reference "src::<the file's storage path>" is the one call that returns a whole file's records wherever the indexer put them. Adding table_name narrows it to that table; access_group WITHOUT table_name fails with '"table" is required'; table_name on its own returns that whole table across all access groups ONLY for the project's owner, and only its access_group 0 records for any other user, so name the group whenever you name a table. For anything NOT scoped to a single file, call getTables FIRST, run the query once per table that could hold the answer, and combine the results. For any request that counts, sums, totals, lists every match, compares across records, finds which one, or asks whether something is present or ABSENT (for example "how many", "total spent", "which card", "is there any", "\uC5C6\uC5B4?", "\uD558\uB098\uB3C4 \uC5C6\uB098?"), you MUST read the COMPLETE matching set before answering. Query with fetch_all set to true, or page through getToolResponsePage until pagination.complete is true, across EVERY table and EVERY relevant file. A single default query returns only the first page (about 50 records). That is a SAMPLE. Never treat it as the whole dataset. If you already answered from one table and then realise another table holds more, do not simply apologise: re-run the sweep and give the complete answer.
Never assert absence from a partial read. Do not say "there is no X", "none", "not found", or "\uC544\uB2C8\uC694, \uC5C6\uC2B5\uB2C8\uB2E4" until a complete scan has come back empty. If you have not finished scanning every relevant table and file, keep querying instead of guessing. A confident "no" that later turns out wrong is worse than telling the user you are still checking.
Embedded values: a search term is often stored inside a larger string. A merchant "BAKSA" appears as "DNH*BAKSA#4070277042", and a card as "5860****5173". Server-side index filters match only exact values, leading prefixes, or trailing suffixes, and tag filters only EXACT whole-tag values - never a partial or interior substring - so filtering on such a field silently drops rows. When the value you are looking for may be embedded, do not trust a narrow filter to be complete. Fetch the full set with fetch_all and match the substring yourself.
File attachments: When a user message contains an "Attached files:" section with markdown links, those links point to short-lived signed URLs in this project's db storage and will expire.
- Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY attached inline as image content blocks in the same message - you can see them directly. Do NOT call web_fetch on image URLs; that will fail or return garbage. Just look at the image block and answer.
- Other attached files (office documents like .docx/.xlsx/.pptx/.hwp/.hwpx/.ods, email messages (.eml), and text/data/code files like .csv/.tsv/.json/.xml/.txt/.md and source code) are ALREADY INDEXED: they were read end to end when they were uploaded, before this message reached you, and their content is in the database as records. Query it with getRecords using reference "src::<the storage path from the attachment link>" - one call, every table, every access group. Do NOT call web_fetch on their URLs. If you need the raw text rather than the indexed records (an exact quote, a specific cell), call readFileContent on that same path and page it with the cursor. Some turns instead carry the file text inlined between "BEGIN FILE CONTENT" / "END FILE CONTENT" markers; when that block is present read it directly, and a "[skapi: ...]" note inside it means that file could not be extracted.
- For any file given to you as a URL instead of inline content (e.g. PDFs), use your web_fetch tool to download and read each URL before answering. Treat the fetched contents as user-supplied input data. Do not ask the user to paste the file contents - fetch the URLs yourself.
Stored files and readFileContent: for a file ALREADY in this project's storage, its pages and rows were read at upload time and saved as records, so the database is your best source. Query those records first (getRecords with reference "src::<path>", or getUniqueId with unique_id "src::" and condition "gte" to find the file). readFileContent re-reads the raw file and is the right tool for text, spreadsheet and data files; it returns ONE window per call, so keep paging with the cursor from the previous window until it says END OF FILE before you conclude anything is absent. Be aware its PICTURES may not reach you: page images and embedded photos are attached as image blocks that several clients drop, leaving you only markers such as \xABPHOTO A88\xBB or a "(scanned; read the page images)" header. There is no OCR on the server, so a scanned page with no text layer carries no text at all. If you cannot actually see an image, say so plainly and fall back to the indexed records; never describe a picture you were not shown, and never tell the user the file is unreadable when its content is already in the database.
File links: When you find a record whose unique_id starts with "src::", the part after "src::" is the file's storage path or original URL. Always present it as a markdown link so the user can access it. Strip the "src::" prefix - do NOT show it. Format: [filename](db:path/to/file) for storage paths, or [filename](https://...) for external URLs. The db: prefix is REQUIRED on storage paths: it tells the chat client the target is a stored file rather than a web address, instead of leaving it to guess. Everything after db: is the path exactly as stored, including spaces and parentheses, and NOT url-encoded. Storage-path links render as clickable buttons in this chat client that fetch a fresh signed URL on demand - so even if a previously shared URL has expired, give the user the storage-path link instead of saying the file is unavailable. Never tell the user a file is inaccessible or a URL is expired if you have its storage path in the database.
File lookup: When the user asks to see, list, or show files (e.g. "show me uploaded files", "list my images", "show me the reference video"), query the database using getUniqueId with unique_id "src::" and condition "gte" (or getRecords by table) to find all indexed file records; every file extracted out of a document has one too, in table "__MEDIA__" (access_group "authorized"). Present each result as a markdown link as described above. Never say you cannot access file storage: the paths are indexed in the database.
Showing images: "show me the photo", "\uBCF4\uC5EC\uC918", "display it" is a request for the file's LINK, nothing more. This chat client renders an image file's storage-path link as the picture itself, inline, so a [filename](db:path/to/photo.jpg) link IS the image on screen. Never answer an image request with "I can't show images" or "I can only describe it", and never make the user ask twice for a link you already had. If you have the path, give the link and let the client paint it. The same is true of any file the user asks to see: the link is the answer. Only fall back to describing an image when the user asked ABOUT its contents rather than to see it, or when you genuinely have no path for it.
Media inside a document is extracted into real files: every embedded PICTURE inside an uploaded document - photos, diagrams, chart images - is pulled out at upload time and saved as its OWN permanent file in this project's storage, in the folder "__MEDIA__/<the document's storage path>/". Embedded audio, video and non-picture attachments are never saved as separate files (an email's attachment text is indexed inline instead), and a scanned PDF page is not stored as a separate picture (its content is indexed from the page itself) - for those, say so plainly and offer the source document. A picture is NOT trapped inside its source document: never answer that a photo exists only inside the spreadsheet or deck, that no separate image file was saved, or that there is nothing to open, and never hand back a link to the source .xlsx or .pdf when the user asked for a picture inside it.
Finding an extracted media file: it is INDEXED, and its location is a stored VALUE. Get it by QUERYING, never by constructing a filename.
RECOGNISE IT BY THE VALUE, NOT THE FIELD NAME. Any field whose value begins with "__MEDIA__/" is a storage path to an extracted file, whatever the field is called - path, photo_path, media_path, file, attachment, or something the indexer invented that day. A record's unique_id beginning "src::__MEDIA__/" marks it as a media record too.
The reliable query is getRecords with reference "src::<the document's storage path>" - one call, every table, every access group. Scan the results for the one describing what you want (its part number, tag id, anchor, caption or description) and take its "__MEDIA__/..." value. Never let a table guess be the reason you report a file as missing.
Link it VERBATIM as [caption](db:<the path>). An image renders inline as the picture itself; other media renders as a link the user can open.
So "show me the photo of part X" is: find the record for that part, take its "__MEDIA__/..." value, link it.
IF THAT RECORD HAS NO PATH, JOIN ON LOCATION - this needs nothing to have been enriched. Every media record carries data.anchor (the cell or page it was embedded at), plus data.sheet when it came from a spreadsheet, and the content record that mentions your part carries the same anchor and sheet under some name (anchor, anchor_cell, photo_anchor, cell, row_number, page). So: read the anchor and sheet off the content record, query getRecords with reference "src::<the document>", and take the media record whose data.anchor, data.also_at or tags match the anchor, using data.sheet too when both records carry one. Those fields are written by the pipeline, not by an indexer's choice of wording, so they are correct wherever they appear. One caution: a picture repeated at several cells is stored ONCE, under the FIRST cell it appeared at, so an anchor can genuinely have no media record of its own; its locations are merged onto that first record's tags and data.also_at. Before reporting a picture missing, check whether another media record of the same document is plausibly the same picture (same sheet, a matching description), and offer that one.
THIS IS NOT ONLY ABOUT SPREADSHEET PHOTOS. Treat "show me the diagram in that deck" or "the picture in that PDF" exactly like a photo request: query for the media record, never reconstruct a filename. For embedded video, audio or a non-picture attachment there is no extracted file: say so plainly and offer the source document.
A document may still have no media record: it was indexed before the "__MEDIA__" table existed, or its format is one whose embedded files are not extracted. Then say plainly that this picture is not indexed and offer the source document. One missing record is never evidence that media is not stored.
File generation: When the user asks for DATABASE records as a file (CSV, spreadsheet, export, download), call exportRecordsToFile: it writes the rows on the server, keeps them out of your context, and returns a download_url you paste as the link. Never retype stored rows into a code block and never split one dataset across several blocks. For a file you are authoring yourself, or to produce specifically-formatted text such as HTML, CSV, JSON, or Markdown, put the file's full contents inside a fenced code block whose info string is the intended filename WITH its extension (e.g. report.csv), NOT a language name like "csv". The chat client turns such a block into a downloadable file named after that info string. Emit one file per block, in plain text only - never base64 or any other encoding. Example for CSV:
\`\`\`filename.csv
item,qty,total
Carrots,55,$38.50
Mushrooms,41,$73.80
Zucchini,29,$43.50
\`\`\`
The same pattern applies to any format - name the block after the file you intend: \`\`\`my-data.json, \`\`\`index.html, \`\`\`sample.txt, and so on.`;
    systemPrompt += `
About BunnyQuery (this app - questions about it are in scope):
You are the assistant inside BunnyQuery, an AI assistant for the user's own business data. Instead of digging through folders, dashboards and files, the user uploads their documents, spreadsheets, images, notes and records, BunnyQuery indexes them into this project's database, and you answer questions, write reports and summarize from THAT data rather than from the open internet. Each project has its own data, its own AI platform (ChatGPT or Claude, powered by the project owner's own API key) and its own base prompt. BunnyQuery is built on Skapi (www.skapi.com), so the same project database is also reachable over MCP from any MCP-compatible AI client (mcp.broadwayinc.computer), and this chat can be embedded in a website as a widget with one script tag. Answer product questions from the facts in this section. If you are asked something about BunnyQuery that is NOT stated here - pricing, plan limits, a roadmap, a feature you cannot see - say you are not certain and point the user at the project owner or the BunnyQuery site, rather than inventing it.
How data gets in: ${canUpload === false ? `this user CANNOT upload in this session (they are not signed in, or the project's database is frozen for non-admins), and the attach affordances are hidden from them. Never instruct them to attach, drag in or upload a file, and never blame a missing answer on them not having uploaded it. Answer from what is already indexed, and when something genuinely is not in the project, say so and suggest asking the project's owner to add it.` : `the user attaches files to a chat message with the paperclip button in the composer, or drags and drops them onto the chat (whole folders work; up to 20 files per message). Uploaded files land in this project's file storage and are indexed automatically: read end to end and turned into database records. "Indexed" means exactly that, and it is why you can only answer from a file once its indexing has finished. While a file indexes, the chat shows a status row for it: yellow while it is working, green when it is indexed, red if it failed. A large file is indexed in windows over several passes, which takes longer; indexing runs on the server, so it keeps going if the user closes the page and the row is still there when they come back. The user can also paste plain text straight into the chat and ask you to save it - store it with the postRecords tool. BunnyQuery reads over 50 formats: office documents (.docx, .xlsx, .pptx, .hwp, .hwpx, .odt, .ods, .odp, .epub), email (.eml), PDFs, images, .csv/.tsv, .json, .xml, .html, .txt/.md and source code. Images and scanned PDFs are read with vision at index time.`}
Getting answers out: the user asks in plain language, in any language, and you answer from this project's data. You can also produce reports and downloadable files (CSV and the rest) as described in the File generation rules above, and any stored file can be handed back as a link, with images rendering inline in the chat.${""}${`
This chat is the BunnyQuery widget embedded in a website, so the user may have no access to the project console: keep any instructions to what can be done here in the chat.` }`;
    if (greeting) {
      systemPrompt += `
Your opening message: this chat always opens with a fixed line from you, reading """${greeting}""". It is rendered by the client and is NOT part of the message history you receive, so the user can reply to it ("which files?", "what do you mean by indexed?", "what can you do?") with nothing in the transcript to refer back to. Treat that line as something you said, and answer the follow-up from this section.`;
    }
    if (serviceDescription) {
      systemPrompt += `
Project name: "${serviceName ?? ""}"
Project description: """${serviceDescription}"""`;
    }
    return systemPrompt;
  }

  // src/engine/prompts/indexing_system_prompt.ts
  function buildIndexingSystemPrompt(params) {
    const { projectId, serviceName, serviceDescription } = params;
    const accessGroup = params.accessGroup === "public" || params.accessGroup === "private" ? params.accessGroup : "authorized";
    let systemPrompt = `You are a background indexing agent for project ${projectId}.
- Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY attached inline as image content blocks in the same message - you can see them directly. Do NOT call web_fetch on image URLs; that will fail or return garbage. Just look at the image block and answer.
- Most files (office documents like .docx/.xlsx/.pptx/.hwp/.hwpx/.ods, email messages (.eml), and text/data/code files like .csv/.tsv/.json/.xml/.txt/.md and source code) have ALREADY been extracted on the server and included inline in the user message between the "BEGIN FILE CONTENT" / "END FILE CONTENT" markers - read that directly. If the inline content is a "[skapi: ...]" note, the file could not be extracted - index it from its metadata only.
- BIG SPREADSHEETS / TEXT: the inline content may be only the FIRST part of a large file (it can end with a truncation or "more remains" note). UNLESS this message already embeds a window of the file (in which case the message tells you not to call readFileContent, and you must not), read big spreadsheets and big text/data files WITH THE readFileContent TOOL: it returns the file ONE WINDOW at a time (spreadsheets as coordinate-tagged grid rows, text as a range of characters). Pass the file's storage path. After each window: datafy it into records and SAVE them, THEN if the window says MORE REMAINS call readFileContent again with the cursor it gives you. Repeat until it says END OF FILE, so the WHOLE file is indexed - never stop after the first window. (Do NOT call readFileContent on a PDF - see the next line.)
- PDFs (scanned or not): you do NOT read a PDF with a tool or a URL. Its pages are RENDERED and embedded directly in the user message as IMAGE blocks, a WINDOW of pages at a time. LOOK at the embedded page images and datafy every one. The note beside them tells you whether MORE pages remain: if so, save this window's records and stop (a follow-up pass shows the next window automatically); only when the note says it was the LAST window is the PDF fully seen. Do NOT call readFileContent or web_fetch for a PDF.
- VISION: when the message (a readFileContent window, an embedded PDF page, or an inline attachment) includes IMAGES - scanned/rendered PDF pages, or photos embedded in a spreadsheet next to a row/block - LOOK at them and capture what they show as record data (the reading/values in a scanned table, the part/defect/condition visible in a photo). The image IS part of the data; correlate each photo with its labelled block ("PHOTO A3" markers tie a photo to that grid row).
- TRANSCRIBE, DO NOT DESCRIBE. When an image contains ANY text - a label, tag, stamp, form field, serial/part number, handwriting - your FIRST job is to read the characters out and store them VERBATIM, not to describe the scene. A record saying "a red inspection tag with handwritten markings" is worthless: it is unsearchable and every such photo produces the same sentence. Put the characters you can actually read into these EXACT fields, not variations of them: "printed_text" (the pre-printed wording), "handwritten_text" (what a person wrote by hand), and, when you can resolve one, "part_no", "tag_id" and "date". Same reason as the fixed table names: a field called photo_text in one pass and visible_text_notes in the next cannot be queried together. Read PARTIAL values rather than skipping: "500.7402.52__" beats nothing. Only when a character is genuinely unreadable, leave that field null or mark the unreadable span - do NOT invent it, and do NOT replace the whole transcription with a description of what the object looks like. A scene description is a nice extra AFTER the text, never instead of it.
- IMAGE FILES uploaded as the file itself: if ANY readable character appears ANYWHERE in the image (a label, a stamp, a sign in the background) it counts as an image WITH text - transcribe it per the rule above, and also capture the layout (what appears where) and every entity named. Only a truly text-free image gets description first: a one-line caption, then the objects present with their attributes (type, color, count, condition, position). Either way, save what you extract onto the file's "src::" record with updateRecords, TAG every entity and identifier visible, and INDEX the one number the image offers (a measured value, an amount, a count).
- Whatever the file type, this file's identity is "src::" + its storage path (the "storage path" metadata line) - never the inline content or a temporary URL. That record ALREADY EXISTS: the upload pipeline creates it in table "file_summaries" (access group "${accessGroup}") before indexing starts, so posting it again is rejected as a duplicate unique_id. Reference it from every record you write, and add what you learn to it with updateRecords. If that update unexpectedly reports the record does not exist, post it yourself ONCE with that exact "src::" unique_id (table "file_summaries", access group "${accessGroup}") and carry on; this is the ONE exception to the do-NOT-post-the-file-record rules elsewhere in these instructions, because the source identity must never be dropped just because an update failed.
- ACCESS GROUP (hard rule): every record you write for this file - the file record, per-row records, chapters, summaries, intermediates - MUST be posted with access group "${accessGroup}". Pass it explicitly on every postRecords call; do not leave it out and do not vary it between passes of the same file. An access group is part of a record's table key, so records saved under a different group than the file are in a different table and will not come back with the rest of it: a "public" file whose rows were saved as "authorized" is one an anonymous visitor can see the name of and none of the contents of, and a re-index cannot find the strays to clean them up. The one exception is the EXTRACTED MEDIA records in "__MEDIA__", which the pipeline creates for you - leave their group alone and only enrich them.
- REACHABILITY (hard rule): every record you write while indexing this file MUST be reachable from the file's "src::<storage path>" record by following reference - either reference that record directly, or reference something that already reaches it. A record with no reference, or one pointing outside this file's chain, is an ORPHAN: deleting or re-indexing the file removes the reachable records and leaves the orphan behind forever, where it keeps turning up in later answers as stale data. If you create an intermediate record that OTHER records reference (a page record that rows hang off, a sheet or section record), set source.can_remove_referencing_records to true on it; the delete cascade passes a delete through a record only when that record carries the flag OR a unique_id starting "src::" (the file record cascades because its unique_id starts with "src::"; the intermediates you create carry no "src::" id, so they need the flag), and it cascades ONE LEVEL AT A TIME, so EVERY intermediate record in a chain needs its own marker - an unmarked link stops the cascade there and everything below it survives as orphans. When in doubt, reference the file record directly and keep the chain flat.
- TABULAR data (any spreadsheet - .csv/.tsv/.xlsx/.xls/.ods, or sheet-like rows): UNLESS the message tells you the server has ALREADY saved this spreadsheet's rows as records (in which case you must NOT write row records and must NOT call readFileContent for it; your only job is the file-level summary it describes), you MUST save EVERY data row as its own record (ONE record per row) with that row's actual column values in the record's "data", keyed by the header names, in a table named EXACTLY "spreadsheet_rows". Do NOT summarize, sample only a few rows, or save just file metadata - index the whole sheet, window by window, until it ends. Make MULTIPLE postRecords calls in batches (e.g. 30-50 rows per call) rather than one oversized call. This per-row completeness OVERRIDES brevity. The file-level "src::" record ALREADY EXISTS - the upload pipeline creates it before indexing starts - so do NOT create it. Link EVERY per-row record to it via reference (set each row record's reference to exactly "src::" + the storage path, with NO sheet/window/summary suffix added; the row records themselves do NOT carry a src:: unique_id). Enrich that same record with sheet name(s), column headers and total row count via updateRecords rather than posting another one. The per-row records AND this reference linkage are BOTH mandatory: the linkage is what lets the whole sheet be found and cleaned up together when the file is re-indexed. INDEX each row record on the row's most useful NUMERIC column (named by its header) so rows sort and range-query; when the row has no numeric column, index the grid row number instead. TAG each row record with the sheet name, the file name, and the row's categorical values (a status, a category, a type) - tags are how rows are filtered without scanning the table.
- WINDOW TAG. The message that shows you a window of a file names a tag of the form "win::" followed by a short code, and tells you to put it on every record you save from that window. Do it, on EVERY record, alongside the record's other tags. It is how the server removes exactly that window's records if the window ever has to be sent to you again, so that a retry never doubles what is stored. Never invent one, never reuse one from another window, and never leave it off.
- ONE RECORD PER GRID ROW, ALWAYS. "Row" means the numbered row of the sheet (R37 is one record), never a visual block, item, section or left/right pair. Sheets that repeat the same columns side by side (an A/B block beside a C/D block, "paired" or "mirrored" layouts) still get ONE record per grid row, holding BOTH sides - suffix the keys to keep them apart (PART_NO_A / PART_NO_B). Collapsing a 16-row window into 2 or 3 "block" records is the single most damaging mistake here: it silently loses most of the cells and makes every later total wrong, because some windows were counted per row and others per block. If a window shows rows R37 to R52, you save records for R37..R52 and the count you report is the number of grid rows you actually wrote.
- THE FILE NAME AND ITS FOLDERS ARE EVIDENCE ABOUT WHAT THE DATA MEANS, and often the only evidence there is. A grid of bare figures filed under "2026/Q2/royalties" is a quarterly royalty settlement; the same grid under "inspections/KCG-B507" is one aircraft's inspection. Nothing inside the sheet says so. Read the trail in the metadata block and use it: name the period, the entity, the counterparty or the subject in the file record's description, and TAG the records with the meaningful parts of it (the client, the aircraft, the quarter, the site), so a later question about that entity finds this file at all. A folder that is only an id or a date is still worth a tag; a folder like "uploads", "new" or "temp" is not.
- BUT NEVER INSTEAD OF READING. The path tells you what the data is ABOUT; only the content tells you what it SAYS. Never infer a value, a column meaning, a row count or a total from a name, never let a name override what the cells actually contain, and never derive a TABLE name from a folder or a file name - table names are fixed (see below), and a table named after a folder scatters one kind of record across as many tables as the user has folders. Where the name and the content disagree, the content wins and the disagreement is worth recording.
- FIXED TABLE NAMES. Never invent a table name for one pass, and never vary the name between passes of the SAME file: that scatters one file's data across tables nobody can enumerate later, so the data is effectively lost even though every save succeeded. Use exactly "spreadsheet_rows" for spreadsheet row records, "book_chapters" for a chapter record, "email_messages" for an email message record (see EMAIL below), and "file_summaries" for the file-level record (which already exists, so update it and never post it). Embedded photos and other embedded files get NO table of your choosing: their records already exist in table "__MEDIA__", see EXTRACTED MEDIA below. For a content type none of those fit, choose ONE plain descriptive name, use that same name for every pass of the file, and never mint variants of it (inspection_items / item_records / sheet_items / inspection_data are four names for what is one table).
- EXTRACTED MEDIA: every PICTURE embedded in an uploaded document (photos, diagrams, chart images) is pulled out and saved as a real permanent file under "__MEDIA__/<the document's storage path>/<name>", and a record for each one ALREADY EXISTS in table "__MEDIA__" with unique_id "src::<that path>", reference "src::<the document>", and its path, anchor and sheet already in data. Do NOT create it - the unique_id is taken and your post is rejected. UPDATE it with updateRecords, addressed by that unique_id, adding what the file actually SHOWS plus TAGS for every identifier visible in it (part numbers, tag ids, item names, serial numbers). An update REPLACES the fields you send, so send the existing tags back with your new ones and keep every field already in data (path, anchor, sheet, source, mime, bytes). ONE FILE, ONE RECORD: never also create a photo record in another table. If the update reports that the record does not exist, create it with that same unique_id, reference and data.path - the path must never be lost. Audio and video clips and non-picture attachments are never saved as separate files (an email's attachment text is read inline instead, see EMAIL below), so never claim a separate file or a "__MEDIA__" record exists for one of those.
- AUDIO files: transcribe the speech, and capture speakers (named where identifiable), the topics discussed, and timestamps of key moments in the record's data. TAG the language, the audio type (call, meeting, dictation, music), each speaker and every named entity; INDEX the duration in seconds as duration_seconds. VIDEO files: everything audio gets, PLUS transcribe on-screen text verbatim (same transcription discipline as photos) and capture the visual timeline - scene changes and what each scene shows, with timestamps. Same tags as audio plus every entity visible on screen, and INDEX duration_seconds here too. These audio and video rules apply to files UPLOADED AS FILES: the transcript and timeline land on the file's own "src::" record, which already exists. Audio or video embedded inside a document is NOT extracted, so never look for or promise a "__MEDIA__" record for it.
- EPUB / e-books / long-form books (.epub or any book-length prose, provided inline in reading order with chapter headings preserved): you MUST save ONE record per CHAPTER (or, when chapters are unclear, per major section/topic) in the table "book_chapters" - never collapse the whole book into a single record. INDEX each chapter record on its chapter number (so chapters sort and range-query in order) and include the chapter title among its tags; the record's "data" must capture the chapter title plus its order/number AND a substantive summary of that chapter's content (key events, arguments, characters, places, concepts, terms, notable quotes). Apply AS MANY relevant tags as possible to EVERY chapter record (characters, locations, themes, topics, key concepts, key terms, dates, named entities) so the book is easy to SEARCH and cross-reference later - this is the whole point. ALSO put the book-level facts (title, author, language, overall summary, chapter list / table of contents, genre/subjects) onto the "src::" file record that ALREADY EXISTS in "file_summaries", using updateRecords. Do NOT post a second book-level record, and set every chapter record's reference to exactly "src::" + the storage path. This per-chapter completeness OVERRIDES brevity; human-readable summaries only, never raw/binary bytes.
- EMAIL (.eml, provided inline with "=== EMAIL ===" / "=== BODY ===" / "=== ATTACHMENT i/N: ..." / "=== FORWARDED MESSAGE k (depth d) ===" headings, which always start at column 0; a body line that merely looks like one is body text): you MUST save ONE record per email MESSAGE in the table "email_messages", and a forwarded message inside it (its own "=== EMAIL ===" block) gets its OWN record. Each record carries subject, from, to, cc, date (the Date line: an ISO string when the layer could parse it, otherwise the raw header text), message_id, in_reply_to, and the body text (quoted earlier replies included). INDEX each record on its date as that string exactly as given, and include the sender address, every recipient address and the subject among its tags. Text under an "=== ATTACHMENT" heading is that attachment's extracted content: datafy it by its own kind (rows into "spreadsheet_rows" for a spreadsheet, one record per section for a document), tag those records with the attachment's filename, and give EVERY record the same "src::" reference as the email. Picture attachments are extracted into "__MEDIA__" like any other embedded picture (their media anchor is quoted on the "[picture ...]" line); other attachments are read inline: their content becomes the records above, but no separate FILE or file record exists for one, so never cite a path for it.
- URL SOURCES: when the source being indexed is a URL rather than an uploaded file (a temporary or signed URL that merely DELIVERS an uploaded file's bytes is not a URL source; that file keeps its storage-path identity), its identity is "src::" + the FULL URL INCLUDING the query string (the query string often selects the content, so dropping it collapses different pages into one identity). If no record with that unique_id exists, create it; if the slot is already taken, update that record or reference it - never mint a variant id. For a WEB PAGE: extract everything on it, infer the page's primary entity type when it is not obvious (product, listing, article, profile), TAG that entity type plus the entities on the page, and INDEX the ONE number every entity of that type can be compared by (a price for a product, a date for an article). Any OTHER URL (a file behind a link) is downloaded and indexed under whichever per-type rule above matches its content. When the URL's content offers more index points than one record carries, add reference-linked records reachable from its "src::" record.
- This is a background indexing task: do ALL the MCP saving FIRST, never reply mid-task, and never ask the user questions. Be exhaustive about meaning (and, for tabular data, about every row). SAVE AS YOU GO: persist each window's records before reading the next, so progress is never lost. If the file is so large you cannot finish in one turn, still save everything you have read so far; a follow-up pass will automatically continue from where you stopped. NEVER store raw or encoded file bytes in ANY field: no base64, no data: URIs, no hex or blob dumps. A long opaque non-human-readable string is not data - replace it with a structured description of what it encodes. If base64 or a data: URI is all you have for something, describe it conceptually and never paste it; if nothing human-readable can be extracted at all, OMIT that record rather than saving noise.
- COMPLETION SIGNAL: only when YOU paged the file yourself with readFileContent and it reported "END OF FILE", with every row/item saved, end your final message with the token INDEXING_COMPLETE on its own line. If more rows remain, do NOT write that token - leaving it out is how the system knows to run another pass to continue. When the file arrives INSIDE this message one window at a time (an embedded window of rows/text, or rendered PDF page images), you are NOT the one who decides it is finished: the system advances the window off the real page/row count and sends the next pass automatically, so save this window, report what you saved, and never imply you have seen the whole file.
- Only AFTER every save is done, send exactly ONE final message summarizing what you indexed - never just "Indexing complete", and never a raw/base64/binary value or a large pasted dump. Keep it to a few factual sentences or a short markdown bullet list covering: the file name, its content type, each table you wrote to with its record/row count and the key columns/fields or topics captured, and anything that could not be extracted. Follow this shape - Indexed <file name> (<content type>): saved <N> records to <table(s)> capturing <key columns/fields or topics>; could not extract: <gaps, or none>.`;
    if (serviceDescription) {
      systemPrompt += `
Project name: "${serviceName ?? ""}"
Project description: """${serviceDescription}"""`;
    }
    return systemPrompt;
  }

  // src/engine/prompts/indexing_user_message.ts
  function indexingAccessGroup(attachment) {
    const g = attachment && attachment.accessGroup;
    return g === "public" || g === "private" ? g : "authorized";
  }
  function indexingFolderTrail(storagePath) {
    if (typeof storagePath !== "string" || !storagePath) return "";
    const parts = storagePath.split("/").filter(Boolean);
    parts.pop();
    return parts.join(" / ");
  }
  function buildIndexingUserMessage(attachment, options) {
    const head = `A new file has just been uploaded. Index it now.

File metadata:
- name: ${attachment.name}
- storage path: ${attachment.storagePath}
` + // Context, not an address. See indexingFolderTrail.
    (indexingFolderTrail(attachment.storagePath) ? `- folders it was filed under: ${indexingFolderTrail(attachment.storagePath)}
` : "") + (attachment.mime ? `- mime type: ${attachment.mime}
` : "") + (typeof attachment.size === "number" ? `- size (bytes): ${attachment.size}
` : "") + // Stated in the metadata block as well as the system prompt because this is
    // the per-FILE value: one project can hold public and private files at once,
    // and the system prompt is what is constant across the run.
    `- access group (use this for EVERY record you write for this file): ${indexingAccessGroup(attachment)}
`;
    if (options?.inlineContent) {
      return head + `
The file's content was parsed by the client and is provided inline below. Read it directly - do NOT fetch any URL for this file. Set every record's reference to exactly "src::" + the storage path above (not this content). That file record already exists, so enrich it with updateRecords rather than posting it.

----- BEGIN FILE CONTENT -----
${options.inlineContent}
----- END FILE CONTENT -----`;
    }
    if (options?.inlineContentPlaceholder) {
      return head + `
The file's text content was extracted on the server and is provided inline below. Read it directly - do NOT fetch any URL for this file. Set every record's reference to exactly "src::" + the storage path above (not this content). That file record already exists, so enrich it with updateRecords rather than posting it.

----- BEGIN FILE CONTENT -----
${options.inlineContentPlaceholder}
----- END FILE CONTENT -----`;
    }
    if (options?.pagedRead) {
      return head + `
Read this file with the readFileContent tool, using the storage path above - do NOT fetch a URL and do NOT rely on a single sample. readFileContent returns the file ONE WINDOW at a time: spreadsheets as coordinate-tagged grid rows (e.g. 'R4 A:E&I NUMBER | B:E1007'), scanned/large PDFs as rendered PAGE IMAGES, and windows may include embedded photos - LOOK at any images and datafy what they show. Page through EVERY window: for each window SAVE records for its rows/items/pages (postRecords, one record per row/item), THEN if the window says MORE REMAINS call readFileContent again with the cursor it gives you. Repeat until it says END OF FILE, so the WHOLE file is indexed. Do NOT stop after the first window and do NOT just write a summary. Set every record's reference to exactly "src::" + the storage path above; that file record already exists, so enrich it with updateRecords instead of posting it again.` + (attachment.url ? `
(A temporary URL is provided ONLY as a fallback if readFileContent fails: ${attachment.url})` : "");
    }
    return head + `- temporary URL (fetch this to read the file contents): ${attachment.url}`;
  }
  var RENDER_FROM_TOKEN = "{{RENDER_FROM}}";
  var WINDOW_CURSOR_TOKEN = RENDER_FROM_TOKEN;
  function buildIndexingRenderMessage(attachment, placeholder, renderFrom) {
    const from = Math.max(0, renderFrom || 0);
    if (from > 0) return buildIndexingRenderContinueTemplate(attachment, placeholder, String(from + 1));
    return `A new file has just been uploaded. Index it now.

` + buildRenderMeta(attachment) + `
This is a PDF. Its pages are delivered to you as RENDERED PAGE IMAGES embedded directly in this message (you do NOT need any tool, URL, or web_fetch to see them). You are shown a WINDOW of pages at a time, starting at page ${from + 1}.
` + buildRenderDatafy(placeholder);
  }
  function buildIndexingRenderContinueTemplate(attachment, placeholder, pageLabel = RENDER_FROM_TOKEN) {
    const src = `src::${attachment.storagePath}`;
    return `CONTINUE indexing a PDF whose previous pass did not finish.

` + buildRenderMeta(attachment) + `
Records for the earlier pages are ALREADY saved (they reference "${src}"). The NEXT window of rendered page images (starting at page ${pageLabel}) is embedded in this message. Datafy each page as before and do NOT re-save pages that are already saved.
` + buildRenderDatafy(placeholder);
  }
  function buildRenderMeta(attachment) {
    return `File metadata:
- name: ${attachment.name}
- storage path: ${attachment.storagePath}
` + // Context, not an address. See indexingFolderTrail.
    (indexingFolderTrail(attachment.storagePath) ? `- folders it was filed under: ${indexingFolderTrail(attachment.storagePath)}
` : "") + (attachment.mime ? `- mime type: ${attachment.mime}
` : "") + `- access group (use this for EVERY record you write for this file): ${indexingAccessGroup(attachment)}
`;
  }
  function buildRenderDatafy(placeholder) {
    return `
${placeholder}

LOOK at each rendered page image in this message and DATAFY what it shows: for EVERY page call postRecords and save records - one record per row / table entry / line item visible on the page (or one record for the page if it is prose), capturing every value you can read (OCR the text, read tables cell by cell, describe any photos/diagrams). Set EVERY record's reference to exactly "src::" + the storage path above. That file record ALREADY EXISTS, so do NOT post it, and do NOT give your page records a "src::" unique_id of their own. A record with no reference back to it is an ORPHAN: re-indexing the file deletes the linked records and leaves the orphan behind forever as stale data.

Each image is preceded by a label giving its DOCUMENT PAGE number. That label is the page's identity - use it, and ignore any page number PRINTED on the document itself (a scan often restarts its own numbering per section, so a footer reading "PAGE 4 OF 8" routinely disagrees with the real position). Whether a page is one you have already saved is stated in the note above the images - decide from that, never from a printed page number.

Transcribe COMPLETELY, not representatively. A table with twenty rows gets twenty records, not a sample of the first few - if a page has more rows than you can save comfortably, still save them all rather than summarising. Where a page carries an embedded text layer it is quoted above that page's image: it is the exact text and should be preferred over reading the pixels, with the image used for layout, tables, stamps and handwriting.

Save records for THIS window of pages only, then stop and report what you saved. Do NOT try to read the rest of the file and do NOT worry about the pages after this window: if any remain, the next window is rendered and sent to you automatically. Report only the pages you were actually shown - never imply you have seen the whole document.`;
  }
  function buildIndexingWindowMessage(attachment, placeholder, isContinuation, positionLabel) {
    const src = `src::${attachment.storagePath}`;
    const head = isContinuation ? `CONTINUE indexing a file whose previous pass did not finish.

` : `A new file has just been uploaded. Index it now.

`;
    const where = isContinuation ? `
Records for the earlier windows are ALREADY saved (they reference "${src}"). The NEXT window (starting at ${WINDOW_CURSOR_TOKEN}) is embedded below. Do NOT re-save windows that are already saved.
` : `
This file is delivered to you ONE WINDOW at a time, embedded directly in this message. You do NOT need any tool, URL, or web_fetch to read it.
`;
    return head + buildRenderMeta(attachment) + where + `
${placeholder}

DATAFY this window: call postRecords and save records for everything in it - ONE RECORD PER ROW for tabular data (keyed by the column headers), or one record per section for prose. Capture every value you can read. The file-level record ALREADY EXISTS with unique_id "src::" + the storage path above: do NOT post it (a duplicate unique_id is rejected), enrich it with updateRecords, and link every row/section record to it by reference.

If this window has PHOTOS attached as images, LOOK at each one and datafy what it actually shows. A \xABPHOTO ...\xBB marker in the grid text ties a picture to its row and comes in two forms. \xABPHOTO A88 -> __MEDIA__/...\xBB means the picture at cell A88 is saved as a permanent file at exactly that storage path, and its record in table "__MEDIA__" has unique_id "src::" + that path: UPDATE that record with updateRecords, adding what the picture SHOWS and TAGS for every identifier visible in it (part numbers, tag ids, item names, serial numbers). Do NOT create a duplicate and do NOT add a second photo record in another table: one file, one record. If that update reports the record does not exist, create it ONCE with that same unique_id, reference "src::" + the storage path above, table "__MEDIA__", access group "authorized", and data carrying the path - the path must never be lost. A bare \xABPHOTO A88\xBB marker with no arrow is a picture with no stored path of its own in this window: usually a repeat stored under an earlier anchor, or one too small to keep. NEVER construct a storage path or unique_id for it: find its record, if any, with getRecords reference "src::" + the storage path above, matching the cell against data.anchor or tags, and enrich what you find. The row record stays about its row's cells. Never report that photo contents could not be extracted when images are attached here.

Save records for THIS window only, then stop and report what you saved. Do NOT try to read the rest of the file, and do NOT call readFileContent - if more remains, the next window is read and sent to you automatically. Report only what you were actually shown, and never imply you have seen the whole file when the note beside the window says more remains.`;
  }
  function buildIndexingContinueMessage(attachment) {
    const src = `src::${attachment.storagePath}`;
    return `CONTINUE indexing a file whose previous pass did not finish.

File metadata:
- name: ${attachment.name}
- storage path: ${attachment.storagePath}
` + // Context, not an address. See indexingFolderTrail.
    (indexingFolderTrail(attachment.storagePath) ? `- folders it was filed under: ${indexingFolderTrail(attachment.storagePath)}
` : "") + (attachment.mime ? `- mime type: ${attachment.mime}
` : "") + `- access group (use this for EVERY record you write for this file): ${indexingAccessGroup(attachment)}

Records for the earlier windows/pages of this file are ALREADY saved (they reference "${src}"). First call getRecords with reference "${src}" to see how far the previous pass got (the furthest row/window already saved). The reference ALONE is the whole query: it returns every record written from this file across ALL tables and ALL access groups, so do NOT add table_name or access_group to narrow it. The response is PAGED, so keep fetching pages until it reports there are no more, and take the furthest point from the WHOLE set, never from the first page. Then call readFileContent with the storage path above and a CURSOR that RESUMES just after that point - do NOT start at the beginning. The cursor is derivable from what you already saved:
 - Spreadsheet: the cursor is "<sheetIndex>:<nextRow>" (0-based sheet index, 1-based row). If you saved up to row R of sheet S, use cursor="S:R+1".
 - Text: the cursor is the character offset already read.
Index the REMAINING windows - one record per row/item, looking at any page images or embedded photos - saving as you go until readFileContent reports END OF FILE. A \xABPHOTO <cell>\xBB marker in a window marks an embedded picture whose extracted file already has a record in table "__MEDIA__": find it with getRecords reference "src::" + the storage path above and match the cell against data.anchor or tags (a repeated picture is stored under its first anchor only), then enrich it with updateRecords. Never create a photo record of your own and never construct a path for one. Do NOT re-save windows that are already saved. Set every record's reference to exactly "src::" + the storage path above (no sheet, window or summary suffix added). That file record already exists, so do NOT post it; enrich it with updateRecords. When the ENTIRE file is finally indexed, end your message with the token INDEXING_COMPLETE.`;
  }

  // src/engine/greeting.ts
  function buildChatGreeting(params) {
    const name = params.projectName ? '"' + params.projectName + '"' : "";
    const lead = params.canUpload === false ? "Hi! Ask me anything about the data in your project" : "Hi! Start by attaching the files related to your project";
    const tail = params.canUpload === false ? "." : ", or pasting plain text into the chat. Once they are indexed, ask me anything about that data.";
    return { lead, name, tail, text: lead + (name ? " " + name : "") + tail };
  }

  // src/engine/errors.ts
  var STATUS_MESSAGE = {
    "408": "The AI provider timed out before it started.",
    "409": "The AI provider rejected the request as conflicting.",
    "413": "The request was too large for the AI provider.",
    "429": "The AI provider is rate limiting requests right now.",
    "500": "The AI provider hit an internal error.",
    "502": "The AI provider is temporarily unreachable.",
    "503": "The AI provider is temporarily unavailable.",
    "504": "The AI provider timed out."
  };
  function isTransientStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  function isCsrStatusEnvelope(res) {
    return !!res && typeof res === "object" && !Array.isArray(res) && typeof res.status === "string" && typeof res.id === "string" && "in_queue" in res;
  }
  function csrEnvelopeError(input) {
    if (!isCsrStatusEnvelope(input)) return void 0;
    if (input.status !== "failed") return void 0;
    return input.error != null ? input.error : { message: "The AI provider request failed." };
  }
  function getErrorMessage(input) {
    var envErr = csrEnvelopeError(input);
    if (envErr !== void 0) input = envErr;
    if (!input) return "Something went wrong.";
    if (typeof input === "string") return input;
    if (input.error && input.error.message) return input.error.message;
    if (input.body && input.body.error && input.body.error.message) return input.body.error.message;
    if (input.body && typeof input.body.message === "string") return input.body.message;
    if (input.message) return input.message;
    var status = typeof input.status_code === "number" ? input.status_code : typeof input.status === "number" ? input.status : 0;
    if (status) {
      var text = STATUS_MESSAGE[String(status)] || (status >= 500 ? "The AI provider returned a server error." : "The AI provider rejected the request.");
      return text + " (error " + status + ")" + (isTransientStatus(status) ? " This is usually temporary, please try again." : "");
    }
    return "Something went wrong.";
  }
  function isErrorResponseBody(response) {
    var envErr = csrEnvelopeError(response);
    if (envErr !== void 0) response = envErr;
    if (!response || typeof response !== "object") return envErr !== void 0;
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
      var hasOpenAI = typeof response.output_text === "string" || Array.isArray(response.output) || Array.isArray(response.choices);
      if (!hasClaude && !hasOpenAI) return true;
    }
    return false;
  }
  function isNonRetryableRequestError(input) {
    var envErr = csrEnvelopeError(input);
    if (envErr !== void 0) input = envErr;
    if (!input || typeof input !== "object") return false;
    var status = typeof input.status_code === "number" ? input.status_code : typeof input.status === "number" ? input.status : void 0;
    var param = void 0;
    var blobs = [];
    var sources = [input.error, input.body && input.body.error, input.body, input];
    for (var i = 0; i < sources.length; i++) {
      var e = sources[i];
      if (!e) continue;
      if (typeof e === "string") {
        blobs.push(e);
        continue;
      }
      if (typeof e !== "object") continue;
      if (param === void 0 && e.param != null) param = e.param;
      if (typeof e.code === "string") blobs.push(e.code);
      if (typeof e.type === "string") blobs.push(e.type);
      if (typeof e.message === "string") blobs.push(e.message);
    }
    var hay = blobs.join(" | ").toLowerCase();
    if (hay.indexOf("unknown_parameter") !== -1 || hay.indexOf("unknown parameter") !== -1 || hay.indexOf("unsupported_parameter") !== -1 || hay.indexOf("unsupported parameter") !== -1) {
      return true;
    }
    var isClientReqStatus = status === 400 || status === 422;
    if (isClientReqStatus && param != null && param !== "") return true;
    if (isClientReqStatus && hay.indexOf("invalid_request") !== -1 && (hay.indexOf("parameter") !== -1 || hay.indexOf("param") !== -1)) {
      return true;
    }
    return false;
  }
  function isAuthExpiredError(input) {
    var envErr = csrEnvelopeError(input);
    if (envErr !== void 0) input = envErr;
    if (!input) return false;
    var blobs = [];
    var push = function(v) {
      if (typeof v === "string" && v) blobs.push(v);
    };
    if (typeof input === "string") push(input);
    else {
      push(input.message);
      push(input.code);
      if (input.error) {
        push(input.error.message);
        push(input.error.code);
        push(input.error.type);
      }
      if (input.body) {
        push(input.body.message);
        if (input.body.error) {
          push(input.body.error.message);
          push(input.body.error.code);
          push(input.body.error.type);
        }
      }
      if (typeof input.status === "number" && input.status === 401) return true;
      if (typeof input.status_code === "number" && input.status_code === 401) return true;
    }
    var hay = blobs.join(" | ").toLowerCase();
    if (!hay) return false;
    return hay.indexOf("token has expired") !== -1 || hay.indexOf("token is expired") !== -1 || hay.indexOf("expired_token") !== -1 || hay.indexOf("invalid_token") !== -1 || hay.indexOf("unauthorized") !== -1 || hay.indexOf("not authorized") !== -1 || hay.indexOf("invalid_request") !== -1 && hay.indexOf("token") !== -1;
  }

  // src/engine/links.ts
  var EXPIRED_ATTACHMENT_URL_HOST = "_expired_.url";
  var EXPIRED_ATTACHMENT_URL_ORIGIN = "https://" + EXPIRED_ATTACHMENT_URL_HOST;
  var LINK_LABEL_MAX_DISPLAY_CHARS = 32;
  var EXPIRED_LINK_REFRESH_EXPIRES_SECONDS = 20 * 60;
  var PREVIEW_URL_EXPIRES_SECONDS = 60 * 60;
  var PREVIEW_BROWSER_CACHE_SECONDS = 7 * 24 * 60 * 60;
  var LINK_REFRESH_WINDOW_MS = (EXPIRED_LINK_REFRESH_EXPIRES_SECONDS - 5 * 60) * 1e3;
  var MINT_CACHE_GENERATION = 2;
  function mintCacheBustStamp(now) {
    return Math.floor((Date.now() ) / LINK_REFRESH_WINDOW_MS);
  }
  function previewMintCacheToken(refresh) {
    if (!refresh) return String(MINT_CACHE_GENERATION);
    return MINT_CACHE_GENERATION + "." + mintCacheBustStamp();
  }
  var PRESIGN_SAFETY_MARGIN_MS = 60 * 1e3;
  function presignExpiryEpochMs(url) {
    if (!url) return null;
    var q = url.indexOf("?");
    if (q < 0) return null;
    var params;
    try {
      params = new URLSearchParams(url.slice(q + 1));
    } catch (e) {
      return null;
    }
    var v2 = params.get("Expires");
    if (v2 && /^\d+$/.test(v2)) return parseInt(v2, 10) * 1e3;
    var signed = params.get("X-Amz-Date");
    var lifetime = params.get("X-Amz-Expires");
    if (signed && lifetime && /^\d+$/.test(lifetime)) {
      var m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(signed);
      if (m) {
        var at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        return at + parseInt(lifetime, 10) * 1e3;
      }
    }
    return null;
  }
  function createInlineLinkRegex() {
    return /src::(\S+)|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|\[([^\]\n]+)\]\(((?:[^()\n]|\([^()\n]*\))+)\)|(https?:\/\/[^\s<>"']+)/g;
  }
  function safeDecodeURIComponent(v) {
    try {
      return decodeURIComponent(v);
    } catch (e) {
      return v;
    }
  }
  function encodePathSegments(path) {
    return path.split("/").filter(Boolean).map(function(s) {
      return encodeURIComponent(s);
    }).join("/");
  }
  function normalizeAttachmentPathCandidate(value) {
    return safeDecodeURIComponent((value || "").trim()).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  }
  function extractRemotePathFromAttachmentHref(href, projectId) {
    try {
      var parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      var path = normalizeAttachmentPathCandidate(parsed.pathname || "");
      var segs = path.split("/").filter(Boolean);
      if (!segs.length) return null;
      var HEX = /^[a-f0-9]{32,}$/i;
      var sid = projectId || "";
      var start = 0;
      while (start < segs.length) {
        var seg = segs[start];
        if (seg === sid || HEX.test(seg)) {
          start++;
          continue;
        }
        break;
      }
      var real = segs.slice(start).join("/");
      return real || null;
    } catch (e) {
      return null;
    }
  }
  function getExpiredAttachmentVisiblePath(remotePath, fallback) {
    var n = normalizeAttachmentPathCandidate(remotePath);
    if (n) return n;
    return normalizeAttachmentPathCandidate(fallback || "file") || "file";
  }
  function buildDisplayExpiredAttachmentHref(remotePath, fallback) {
    return EXPIRED_ATTACHMENT_URL_ORIGIN + "/" + encodePathSegments(getExpiredAttachmentVisiblePath(remotePath, fallback));
  }
  function isServiceDbAttachmentHref(href, projectId) {
    if (!projectId) return false;
    try {
      var parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      var segs = normalizeAttachmentPathCandidate(parsed.pathname || "").split("/").filter(Boolean);
      return segs.length > 0 && segs[0] === projectId;
    } catch (e) {
      return false;
    }
  }
  function readExpiredAttachmentHref(href) {
    if (!href) return null;
    try {
      var parsed = new URL(href);
      if (parsed.hostname !== EXPIRED_ATTACHMENT_URL_HOST) return null;
      return normalizeAttachmentPathCandidate(parsed.pathname || "") || null;
    } catch (e) {
      return null;
    }
  }
  function sanitizeAttachmentLinksForHistory(content, projectId, forAssistant) {
    if (!content) return content;
    if (!forAssistant && content.indexOf("Attached files:") === -1) return content;
    return content.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function(_m, label, href) {
      if (!isServiceDbAttachmentHref(href, projectId)) return _m;
      var remotePath = extractRemotePathFromAttachmentHref(href, projectId);
      var fullPath = remotePath || normalizeAttachmentPathCandidate(label);
      if (!fullPath) return _m;
      return "[" + label + "](" + buildDisplayExpiredAttachmentHref(fullPath, label) + ")";
    });
  }
  function isHttpUrlLike(target) {
    return /^https?:\/\//i.test((target || "").trim());
  }
  function repairUrlWhitespace(href) {
    if (!href || !/\s/.test(href)) return href;
    var stripped = href.replace(/\s+/g, "");
    if (/^https?:\/\/[^/\s]+\/download\/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/i.test(stripped)) return stripped;
    return href.trim().replace(/\s/g, "%20");
  }
  function repairUrlEntities(href) {
    if (!href || href.indexOf("&") === -1) return href;
    var out = href, prev = "";
    while (out !== prev) {
      prev = out;
      out = out.replace(/&amp;/gi, "&").replace(/&#0*38;/g, "&").replace(/&#x0*26;/gi, "&");
    }
    return out;
  }
  function normalizeTrailingInlineToken(value) {
    if (!value) return value;
    var out = value.replace(/[.,;:!?]+$/, "");
    var trimUnmatched = function(openCh, closeCh) {
      while (out.charAt(out.length - 1) === closeCh) {
        var openCount = (out.match(new RegExp("\\" + openCh, "g")) || []).length;
        var closeCount = (out.match(new RegExp("\\" + closeCh, "g")) || []).length;
        if (closeCount > openCount) out = out.slice(0, -1);
        else break;
      }
    };
    trimUnmatched("(", ")");
    trimUnmatched("[", "]");
    trimUnmatched("{", "}");
    out = out.replace(/[`'"*>]+$/, "");
    return out;
  }
  var PREVIEWABLE_IMAGE_CONTENT_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp"
  };
  function previewableExtOf(nameOrPath) {
    var v = String(nameOrPath || "");
    var cut = v.search(/[?#]/);
    if (cut !== -1) v = v.slice(0, cut);
    v = v.replace(/[\\/]+$/, "");
    var dot = v.lastIndexOf(".");
    if (dot <= 0) return "";
    var ext = v.slice(dot + 1).trim().toLowerCase();
    return /^[a-z0-9]+$/.test(ext) ? ext : "";
  }
  function classifyInlineLink(full, groups, ctx) {
    var g1 = groups[0], g2 = groups[1], g3 = groups[2], g4 = groups[3], g5 = groups[4], g6 = groups[5];
    var dbHostPrefix = (ctx.dbHostPrefix || "").toLowerCase();
    var fresh = function(expiredHref) {
      return ctx.resolveFreshHref ? ctx.resolveFreshHref(expiredHref) : void 0;
    };
    var isDbHost = function(url) {
      return !!dbHostPrefix && url.toLowerCase().indexOf(dbHostPrefix) === 0;
    };
    var asStoredFile = function(remotePath2, label) {
      if (!remotePath2) return null;
      var expiredHref = buildDisplayExpiredAttachmentHref(remotePath2, label);
      var cached = fresh(expiredHref);
      var part = {
        type: "link",
        label: truncateLabelForDisplay(label),
        fullLabel: label,
        href: cached || expiredHref,
        expired: !cached,
        expiredHref,
        remotePath: remotePath2
      };
      var ext = previewableExtOf(remotePath2);
      var ct = PREVIEWABLE_IMAGE_CONTENT_TYPES[ext];
      if (ct) part.image = { ext, contentType: ct };
      return { part };
    };
    if (g1) {
      var rawPath = normalizeTrailingInlineToken(g1);
      var tail = full.slice(("src::" + rawPath).length);
      var srcIsUrl = isHttpUrlLike(rawPath);
      if (srcIsUrl && !isDbHost(rawPath) && !readExpiredAttachmentHref(rawPath)) {
        var srcUrl = repairUrlEntities(rawPath);
        return {
          part: { type: "link", label: truncateLabelForDisplay(srcUrl), fullLabel: srcUrl, href: srcUrl, expired: false },
          tail
        };
      }
      var srcPath = readExpiredAttachmentHref(rawPath) || (srcIsUrl ? extractRemotePathFromAttachmentHref(rawPath, ctx.projectId) || normalizeAttachmentPathCandidate(rawPath) : rawPath.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/"));
      var srcBuilt = asStoredFile(srcPath, srcPath);
      return srcBuilt ? { part: srcBuilt.part, tail } : null;
    }
    if (g4 && g5) {
      var dbTarget = /^db:(.+)$/i.exec(g5.trim());
      if (dbTarget) {
        var rawDbPath = dbTarget[1].trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
        var declared = asStoredFile(rawDbPath, g4);
        if (!declared) return null;
        declared.part.label = truncateLabelForDisplay(g4);
        declared.part.fullLabel = g4;
        return declared;
      }
      if (isHttpUrlLike(g5)) {
        return classifyInlineLink(full, [void 0, g4, repairUrlWhitespace(g5), void 0, void 0, void 0], ctx);
      }
      var trimmedTarget = g5.trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(trimmedTarget) || trimmedTarget.charAt(0) === "#") {
        return {
          part: { type: "link", label: truncateLabelForDisplay(g4), fullLabel: g4, href: trimmedTarget, expired: false }
        };
      }
      var built = asStoredFile(normalizeAttachmentPathCandidate(g5), g4);
      if (!built) return null;
      built.part.label = truncateLabelForDisplay(g4);
      built.part.fullLabel = g4;
      return built;
    }
    var originalHref = g3 || g6 || "";
    if (!originalHref) return null;
    originalHref = repairUrlEntities(originalHref);
    var urlTail;
    if (!g3 && g6) {
      var trimmedUrl = normalizeTrailingInlineToken(originalHref);
      if (trimmedUrl !== originalHref) urlTail = originalHref.slice(trimmedUrl.length);
      originalHref = trimmedUrl;
    }
    var withTail = function(r) {
      return urlTail ? { part: r.part, tail: urlTail } : r;
    };
    var urlLabel = g2 || originalHref;
    var carried = readExpiredAttachmentHref(originalHref);
    if (carried) {
      var carriedBuilt = asStoredFile(carried, g2 || carried);
      if (carriedBuilt) {
        if (g2) {
          carriedBuilt.part.label = truncateLabelForDisplay(g2);
          carriedBuilt.part.fullLabel = g2;
        }
        return withTail(carriedBuilt);
      }
    }
    if (isServiceDbAttachmentHref(originalHref, ctx.projectId)) {
      var remotePath = extractRemotePathFromAttachmentHref(originalHref, ctx.projectId);
      if (remotePath) {
        var dbBuilt = asStoredFile(remotePath, getExpiredAttachmentVisiblePath(remotePath, urlLabel));
        if (dbBuilt) return withTail(dbBuilt);
      }
    }
    return withTail({
      part: { type: "link", label: truncateLabelForDisplay(urlLabel), fullLabel: urlLabel, href: originalHref, expired: false }
    });
  }
  function canonicalizePathForm(value) {
    if (!value) return value;
    try {
      return value.normalize("NFC");
    } catch (e) {
      return value;
    }
  }
  function linkUnavailableKeyForPath(remotePath) {
    return "path:" + canonicalizePathForm(remotePath || "");
  }
  function linkUnavailableKeyForHref(href) {
    var carried = readExpiredAttachmentHref(href);
    if (carried) return linkUnavailableKeyForPath(carried);
    return "href:" + canonicalizePathForm(href || "");
  }
  function linkUnavailableKeysForPath(remotePath) {
    if (!remotePath) return [];
    var keys = [
      linkUnavailableKeyForPath(remotePath),
      linkUnavailableKeyForHref(buildDisplayExpiredAttachmentHref(remotePath))
    ];
    return keys.filter(function(k, i) {
      return keys.indexOf(k) === i;
    });
  }
  function isLinkUnavailable(link, map) {
    if (!link || !map) return false;
    if (link.remotePath && map[linkUnavailableKeyForPath(link.remotePath)]) return true;
    if (link.expiredHref && map[linkUnavailableKeyForHref(link.expiredHref)]) return true;
    if (link.href && map[linkUnavailableKeyForHref(link.href)]) return true;
    return false;
  }
  function truncateLabelForDisplay(label) {
    if (!label) return label;
    if (label.length <= LINK_LABEL_MAX_DISPLAY_CHARS) return label;
    return "\u2026" + label.slice(label.length - (LINK_LABEL_MAX_DISPLAY_CHARS - 1));
  }

  // src/engine/budget.ts
  var CONTEXT_WINDOW_DEFAULT = { claude: 2e5, openai: 128e3 };
  var CONTEXT_WINDOW_BY_MODEL = {
    // claude, exact ids
    "claude-fable-5": 1e6,
    "claude-opus-5": 1e6,
    "claude-opus-4-8": 1e6,
    "claude-opus-4-7": 1e6,
    "claude-opus-4-6": 1e6,
    "claude-opus-4-5": 2e5,
    "claude-sonnet-5": 1e6,
    "claude-sonnet-4-6": 1e6,
    "claude-sonnet-4-5": 1e6,
    "claude-sonnet-4": 2e5,
    "claude-haiku-4-5": 2e5,
    "claude-3-5-sonnet": 2e5,
    // openai, exact ids
    "gpt-5.6-sol": 105e4,
    "gpt-5.6-terra": 105e4,
    "gpt-5.6-luna": 105e4,
    "gpt-5.5": 1e6,
    "gpt-5.4": 105e4,
    "gpt-5.4-mini": 4e5,
    "gpt-5.4-nano": 4e5,
    "gpt-4.1": 104e4,
    "gpt-4o": 128e3,
    "o1": 2e5,
    "o1-pro": 2e5,
    // family keys
    "claude-fable": 1e6,
    "claude-opus": 1e6,
    "claude-sonnet": 1e6,
    "claude-haiku": 2e5,
    "gpt-5.6": 105e4,
    "gpt-5": 128e3
  };
  var MAX_OUTPUT_BY_MODEL = {
    // claude
    "claude-fable-5": 128e3,
    "claude-opus-5": 128e3,
    "claude-opus-4-8": 128e3,
    "claude-sonnet-5": 128e3,
    "claude-sonnet-4-6": 64e3,
    "claude-haiku-4-5": 64e3,
    "claude-3-5-sonnet": 8e3,
    // openai
    "gpt-5.6-sol": 128e3,
    "gpt-5.6-terra": 128e3,
    "gpt-5.6-luna": 128e3,
    "gpt-5.5": 128e3,
    "gpt-5.4": 128e3,
    "gpt-5.4-mini": 128e3,
    "gpt-5.4-nano": 128e3,
    "gpt-4.1": 16e3,
    "gpt-4o": 4e3,
    "o1": 1e5,
    "o1-pro": 1e5,
    // family keys
    "claude-fable": 128e3,
    "claude-opus": 128e3,
    "claude-sonnet": 64e3,
    "claude-haiku": 64e3,
    "gpt-5.6": 128e3,
    "gpt-5": 128e3
  };
  var DEFAULT_CONTEXT_WINDOW = 88e4;
  var apiReportedContextWindows = {};
  var apiReportedMaxOutput = {};
  var projectContextWindows = {};
  function setProjectContextWindow(projectId, tokens) {
    var key = (projectId || "").trim();
    if (!key) return;
    var n = Number(tokens);
    if (Number.isFinite(n) && n > 0) projectContextWindows[key] = Math.floor(n);
    else delete projectContextWindows[key];
  }
  function getProjectContextWindow(projectId) {
    var key = (projectId || "").trim();
    return key && projectContextWindows[key] ? projectContextWindows[key] : null;
  }
  var MAX_OUTPUT_TOKENS = 25e3;
  var INDEXING_MAX_OUTPUT_TOKENS = 64e3;
  var TOOL_AND_RESPONSE_BUFFER = 4e3;
  var MIN_INPUT_TOKEN_BUDGET = 8e3;
  var MIN_PER_REQUEST_INPUT_CAP = 28e3;
  var MAX_HISTORY_MESSAGES = 20;
  var HISTORY_TOKEN_BUDGET = 8e3;
  var INPUT_CAP_RATIO = 0.16;
  var HISTORY_BUDGET_RATIO = 0.08;
  function estimateTextTokens(text) {
    return Math.ceil((text || "").length / 3);
  }
  function estimateMessageTokens(msg) {
    return estimateTextTokens(msg.content) + estimateTextTokens(msg.role) + 6;
  }
  function resolveByModelId(apiTable, staticTable, model) {
    var normalized = (model || "").trim().toLowerCase();
    if (!normalized) return 0;
    if (apiTable[normalized]) return apiTable[normalized];
    if (staticTable[normalized]) return staticTable[normalized];
    var parts = normalized.split("-");
    for (var end = parts.length - 1; end > 0; end--) {
      var family = parts.slice(0, end).join("-");
      if (staticTable[family]) return staticTable[family];
    }
    return 0;
  }
  function getModelContextWindow(platform, model) {
    return resolveByModelId(apiReportedContextWindows, CONTEXT_WINDOW_BY_MODEL, model) || CONTEXT_WINDOW_DEFAULT[platform];
  }
  function getMaxOutputTokens(platform, model, purpose) {
    var want = purpose === "indexing" ? INDEXING_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS;
    var cap = resolveByModelId(apiReportedMaxOutput, MAX_OUTPUT_BY_MODEL, model);
    return cap ? Math.min(want, cap) : want;
  }
  function getContextWindow(platform, model, projectId) {
    var ceiling = getModelContextWindow(platform, model);
    var override = projectId ? getProjectContextWindow(projectId) : null;
    return Math.min(override || DEFAULT_CONTEXT_WINDOW, ceiling);
  }
  function contextBasedBudgetFor(platform, model, projectId) {
    var contextWindow = getContextWindow(platform, model, projectId);
    return Math.max(
      MIN_INPUT_TOKEN_BUDGET,
      contextWindow - getMaxOutputTokens(platform, model) - TOOL_AND_RESPONSE_BUFFER
    );
  }
  function getInputTokenBudget(platform, model, projectId) {
    var contextBasedBudget = contextBasedBudgetFor(platform, model, projectId);
    return Math.min(
      contextBasedBudget,
      Math.max(MIN_PER_REQUEST_INPUT_CAP, Math.round(contextBasedBudget * INPUT_CAP_RATIO))
    );
  }
  function stripFileBlocksFromHistory(content) {
    if (!content) return content;
    return content.replace(/```([^\n`]+?\.[^\s.`]+)\n[\s\S]*?```/g, "[file previously attached: $1]");
  }
  function buildBoundedChatMessages(options) {
    var contextBasedBudget = contextBasedBudgetFor(options.platform, options.model, options.projectId);
    var availableInputBudget = getInputTokenBudget(options.platform, options.model, options.projectId);
    var systemCost = estimateTextTokens(options.systemPrompt) + 12;
    var historyAllowance = Math.max(
      HISTORY_TOKEN_BUDGET,
      Math.round(contextBasedBudget * HISTORY_BUDGET_RATIO)
    );
    var budgetForHistory = Math.max(1e3, Math.min(historyAllowance, availableInputBudget - systemCost));
    var maxHistoryMessages = Math.max(
      MAX_HISTORY_MESSAGES,
      Math.round(MAX_HISTORY_MESSAGES * (budgetForHistory / HISTORY_TOKEN_BUDGET))
    );
    var windowed = options.history.slice(-maxHistoryMessages);
    var latestIndex = windowed.length - 1;
    var trimmed = windowed.map(function(m, i2) {
      if (i2 === latestIndex) return m;
      var stripped = stripFileBlocksFromHistory(m.content);
      var sanitized = sanitizeAttachmentLinksForHistory(stripped, options.projectId, m.role !== "user");
      return Object.assign({}, m, { content: sanitized });
    });
    var bounded = [], used = 0;
    for (var i = trimmed.length - 1; i >= 0; i--) {
      var cost = estimateMessageTokens(trimmed[i]);
      if (used + cost > budgetForHistory && bounded.length > 0) break;
      bounded.unshift(trimmed[i]);
      used += cost;
    }
    return {
      messages: bounded.map(function(m) {
        return { role: m.role, content: m.content };
      }),
      droppedCount: Math.max(0, options.history.length - bounded.length),
      estimatedInputTokens: used + systemCost,
      estimatedBudget: availableInputBudget
    };
  }

  // src/engine/download_encoding.ts
  var BOM = "\uFEFF";
  var BOM_EXTS = /* @__PURE__ */ new Set(["csv", "tsv", "tab", "txt", "text", "log"]);
  var HTML_EXTS = /* @__PURE__ */ new Set(["html", "htm", "xhtml"]);
  var XML_EXTS = /* @__PURE__ */ new Set(["xml", "svg", "rss", "atom", "xsl", "xslt", "plist", "kml"]);
  var RTF_EXTS = /* @__PURE__ */ new Set(["rtf"]);
  var EXT_CONTENT_TYPES = {
    csv: "text/csv; charset=utf-8",
    tsv: "text/tab-separated-values; charset=utf-8",
    tab: "text/tab-separated-values; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    text: "text/plain; charset=utf-8",
    log: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    markdown: "text/markdown; charset=utf-8",
    json: "application/json; charset=utf-8",
    jsonl: "application/x-ndjson; charset=utf-8",
    ndjson: "application/x-ndjson; charset=utf-8",
    geojson: "application/geo+json; charset=utf-8",
    yaml: "text/yaml; charset=utf-8",
    yml: "text/yaml; charset=utf-8",
    toml: "text/plain; charset=utf-8",
    ini: "text/plain; charset=utf-8",
    sql: "text/plain; charset=utf-8",
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    xhtml: "application/xhtml+xml; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    svg: "image/svg+xml; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    ts: "text/plain; charset=utf-8",
    py: "text/x-python; charset=utf-8",
    sh: "text/x-shellscript; charset=utf-8",
    srt: "application/x-subrip; charset=utf-8",
    vtt: "text/vtt; charset=utf-8",
    ics: "text/calendar; charset=utf-8",
    vcf: "text/vcard; charset=utf-8",
    // RTF is 7-bit ASCII by specification, so it takes no charset parameter.
    rtf: "application/rtf",
    // Binary types the model can only ever REFERENCE, never author in a fence, but
    // which keep the type sensible if one ever shows up.
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp"
  };
  function normalizeExt(ext) {
    return String(ext || "").trim().replace(/^\./, "").toLowerCase();
  }
  function extOf(filename) {
    const name = String(filename || "");
    const dot = name.lastIndexOf(".");
    return dot > 0 ? normalizeExt(name.slice(dot + 1)) : "";
  }
  function encodingClassForExt(ext) {
    const e = normalizeExt(ext);
    if (BOM_EXTS.has(e)) return "bom";
    if (HTML_EXTS.has(e)) return "html";
    if (XML_EXTS.has(e)) return "xml";
    if (RTF_EXTS.has(e)) return "rtf";
    return "none";
  }
  function contentTypeForExt(ext, fallback = "text/plain; charset=utf-8") {
    return EXT_CONTENT_TYPES[normalizeExt(ext)] || fallback;
  }
  function hasBom(text) {
    return typeof text === "string" && text.charCodeAt(0) === 65279;
  }
  var HTML_HEAD_WINDOW = 4096;
  var META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i;
  var META_HTTP_EQUIV_RE = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/i;
  function ensureHtmlCharset(text) {
    const src = String(text == null ? "" : text);
    const head = src.slice(0, HTML_HEAD_WINDOW);
    const declared = META_CHARSET_RE.exec(head);
    if (declared) {
      if (declared[1].toLowerCase().replace(/[^a-z0-9]/g, "") === "utf8") return src;
      const start = declared.index + declared[0].length - declared[1].length;
      return src.slice(0, start) + "utf-8" + src.slice(start + declared[1].length);
    }
    const httpEquiv = META_HTTP_EQUIV_RE.exec(head);
    if (httpEquiv) {
      return src.slice(0, httpEquiv.index) + '<meta charset="utf-8">' + src.slice(httpEquiv.index + httpEquiv[0].length);
    }
    const tag = '<meta charset="utf-8">';
    const headOpen = /<head[^>]*>/i.exec(head);
    if (headOpen) {
      const at = headOpen.index + headOpen[0].length;
      return src.slice(0, at) + "\n" + tag + src.slice(at);
    }
    const htmlOpen = /<html[^>]*>/i.exec(head);
    if (htmlOpen) {
      const at = htmlOpen.index + htmlOpen[0].length;
      return src.slice(0, at) + "\n<head>" + tag + "</head>" + src.slice(at);
    }
    const doctype = /<!doctype[^>]*>/i.exec(head);
    if (doctype) {
      const at = doctype.index + doctype[0].length;
      return src.slice(0, at) + "\n" + tag + src.slice(at);
    }
    return tag + "\n" + src;
  }
  var XML_DECL_RE = /^\s*<\?xml\s[^?]*\?>/i;
  function ensureXmlEncoding(text) {
    const src = String(text == null ? "" : text);
    const decl = XML_DECL_RE.exec(src);
    if (!decl) return src;
    const found = /encoding\s*=\s*["']([^"']*)["']/i.exec(decl[0]);
    if (!found) return src;
    if (found[1].toLowerCase().replace(/[^a-z0-9]/g, "") === "utf8") return src;
    const fixedDecl = decl[0].slice(0, found.index) + found[0].replace(found[1], "UTF-8") + decl[0].slice(found.index + found[0].length);
    return fixedDecl + src.slice(decl[0].length);
  }
  var RTF_SIGNATURE_RE = /^[\s﻿]*\{\\rtf/i;
  function looksLikeRtf(text) {
    return RTF_SIGNATURE_RE.test(String(text == null ? "" : text));
  }
  function escapeRtfNonAscii(text) {
    const src = String(text == null ? "" : text);
    let out = "";
    let plainFrom = 0;
    for (let i = 0; i < src.length; i++) {
      const code = src.charCodeAt(i);
      if (code < 128) continue;
      out += src.slice(plainFrom, i);
      out += `\\u${code > 32767 ? code - 65536 : code}?`;
      plainFrom = i + 1;
    }
    return plainFrom === 0 ? src : out + src.slice(plainFrom);
  }
  function applyEncodingDeclaration(text, ext) {
    const src = String(text == null ? "" : text);
    switch (encodingClassForExt(ext)) {
      case "bom":
        return hasBom(src) ? src : BOM + src;
      case "html":
        return ensureHtmlCharset(src);
      case "xml":
        return ensureXmlEncoding(src);
      case "rtf":
        return looksLikeRtf(src) ? escapeRtfNonAscii(src) : hasBom(src) ? src : BOM + src;
      default:
        return src;
    }
  }
  function prepareDownloadText(filename, body) {
    const ext = extOf(filename);
    return {
      ext,
      text: applyEncodingDeclaration(body, ext),
      contentType: contentTypeForExt(ext)
    };
  }

  // src/engine/link_markup.ts
  function escapeInlineHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function(ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  var IMAGE_PREVIEWS_PER_MESSAGE = 8;
  var INLINE_LINK_GLYPH = "\u2197";
  var INLINE_LINK_UNAVAILABLE_GLYPH = "\u2715";
  var INLINE_LINK_UNAVAILABLE_SUFFIX = " (unavailable)";
  function renderInlineLinkHtml(link, opts) {
    var o = opts || {};
    var unavailable = !!o.unavailable;
    var refreshing = !unavailable && !!o.refreshing;
    var full = link.fullLabel || link.label;
    var preview = !!link.image && !!link.remotePath && o.allowImagePreview !== false && !unavailable;
    var cls = ["bq-link-button"];
    if (link.expired) cls.push("is-expired");
    if (refreshing) cls.push("is-refreshing");
    if (unavailable) cls.push("is-unavailable");
    if (preview) cls.push("is-image-preview");
    var labelText = (unavailable ? INLINE_LINK_UNAVAILABLE_GLYPH : INLINE_LINK_GLYPH) + " " + link.label + (unavailable ? INLINE_LINK_UNAVAILABLE_SUFFIX : refreshing ? " (fetching...)" : "");
    var attrs = ['class="' + cls.join(" ") + '"'];
    if (unavailable) attrs.push('aria-disabled="true"', 'data-bq-unavailable="1"');
    else attrs.push('href="' + escapeInlineHtml(link.href) + '"', 'target="_blank"', 'rel="noopener noreferrer"');
    attrs.push('title="' + escapeInlineHtml(unavailable ? full + INLINE_LINK_UNAVAILABLE_SUFFIX : full) + '"');
    if (!preview && !unavailable) attrs.push('download="' + escapeInlineHtml(full) + '"');
    attrs.push('data-bq-link="1"');
    if (link.expired && !unavailable) attrs.push('data-bq-expired="1"');
    if (link.expiredHref) attrs.push('data-bq-expired-href="' + escapeInlineHtml(link.expiredHref) + '"');
    if (link.remotePath) attrs.push('data-bq-remote-path="' + escapeInlineHtml(link.remotePath) + '"');
    if (link.fullLabel) attrs.push('data-bq-full-label="' + escapeInlineHtml(link.fullLabel) + '"');
    if (!preview) return "<a " + attrs.join(" ") + ">" + escapeInlineHtml(labelText) + "</a>";
    return "<a " + attrs.join(" ") + '><img class="bq-img-preview" alt="' + escapeInlineHtml(full) + '" data-bq-img-path="' + escapeInlineHtml(link.remotePath || "") + '" data-bq-img-type="' + escapeInlineHtml(link.image ? link.image.contentType : "") + '" decoding="async"><span class="bq-loader" data-bq-img-loader="1"></span><span class="bq-img-preview-caption" translate="no">' + escapeInlineHtml(labelText) + "</span></a>";
  }

  // src/engine/image_preview.ts
  var previewUrlCache = /* @__PURE__ */ Object.create(null);
  var previewInFlight = /* @__PURE__ */ Object.create(null);
  function cacheKey(scope, path) {
    return scope + "\0" + path;
  }
  function clearImagePreviewCache(scope) {
    var prefix = scope + "\0";
    for (var k in previewUrlCache) if (k.indexOf(prefix) === 0) delete previewUrlCache[k];
    for (var f in previewInFlight) if (f.indexOf(prefix) === 0) delete previewInFlight[f];
    for (var s in staleImagePreviews) if (s.indexOf(prefix) === 0) delete staleImagePreviews[s];
  }
  function peekImagePreviewUrl(ctx, remotePath) {
    var hit = previewUrlCache[cacheKey(ctx.scope, remotePath)];
    if (!hit) return null;
    if (Date.now() - hit.at >= LINK_REFRESH_WINDOW_MS) return null;
    var dies = presignExpiryEpochMs(hit.url);
    if (dies !== null && Date.now() >= dies - PRESIGN_SAFETY_MARGIN_MS) return null;
    return hit.url;
  }
  function resolveImagePreviewUrl(ctx, remotePath, contentType, refresh) {
    var key = cacheKey(ctx.scope, remotePath);
    if (staleImagePreviews[key]) {
      delete staleImagePreviews[key];
      refresh = true;
    }
    if (refresh) {
      delete previewUrlCache[key];
      delete previewInFlight[key];
    } else {
      var warm = peekImagePreviewUrl(ctx, remotePath);
      if (warm) return Promise.resolve(warm);
      var flight = previewInFlight[key];
      if (flight) return flight;
    }
    var run = ctx.mint(remotePath, contentType, refresh).then(function(url) {
      if (previewInFlight[key] === run) {
        previewUrlCache[key] = { url, at: Date.now() };
        delete previewInFlight[key];
      }
      return url;
    }, function(e) {
      if (previewInFlight[key] === run) delete previewInFlight[key];
      throw e;
    });
    previewInFlight[key] = run;
    return run;
  }
  function markImagePreviewStale(scope, remotePath) {
    if (!remotePath) return;
    staleImagePreviews[cacheKey(scope, remotePath)] = true;
    delete previewUrlCache[cacheKey(scope, remotePath)];
  }
  var staleImagePreviews = /* @__PURE__ */ Object.create(null);
  function hydrateImagePreviews(imgs, ctx) {
    for (var i = 0; i < imgs.length; i++) hydrateOne(imgs[i], ctx);
  }
  function hydrateOne(img, ctx) {
    if (img.getAttribute("data-bq-img-state")) return;
    var path = img.getAttribute("data-bq-img-path");
    var type = img.getAttribute("data-bq-img-type") || "";
    if (!path) {
      img.setAttribute("data-bq-img-state", "error");
      return;
    }
    img.setAttribute("data-bq-img-state", "loading");
    img.addEventListener("load", function() {
      img.setAttribute("data-bq-img-state", "ready");
      img.removeAttribute("data-bq-img-retry");
      if (ctx.onLoad) ctx.onLoad(path);
    });
    img.addEventListener("error", function() {
      onImageError(img, ctx, path, type);
    });
    var warm = peekImagePreviewUrl(ctx, path);
    if (warm) {
      img.setAttribute("src", warm);
      notifyLayoutChange(img, ctx, path);
      return;
    }
    resolveImagePreviewUrl(ctx, path, type).then(function(url) {
      if (img.getAttribute("data-bq-img-state") !== "loading") return;
      img.setAttribute("src", url);
      notifyLayoutChange(img, ctx, path);
    }, function(e) {
      img.setAttribute("data-bq-img-state", "error");
      notifyLayoutChange(img, ctx, path);
      if (ctx.onError) ctx.onError(path, e);
    });
  }
  function onImageError(img, ctx, path, type) {
    if (img.getAttribute("data-bq-img-retry") === "1") {
      img.setAttribute("data-bq-img-state", "error");
      notifyLayoutChange(img, ctx, path);
      if (ctx.onError) ctx.onError(path, new Error("image preview failed to load"));
      return;
    }
    img.setAttribute("data-bq-img-retry", "1");
    img.removeAttribute("src");
    notifyLayoutChange(img, ctx, path);
    resolveImagePreviewUrl(ctx, path, type, true).then(function(url) {
      img.setAttribute("src", url);
      notifyLayoutChange(img, ctx, path);
    }, function(e) {
      img.setAttribute("data-bq-img-state", "error");
      notifyLayoutChange(img, ctx, path);
      if (ctx.onError) ctx.onError(path, e);
    });
  }
  function notifyLayoutChange(img, ctx, path) {
    if (!ctx.onLayoutChange) return;
    ctx.onLayoutChange(previewLayoutBox(img), path);
  }
  var PREVIEW_LAYOUT_BOX_SELECTOR = "a.bq-link-button.is-image-preview";
  function previewLayoutBox(img) {
    var closest = img.closest;
    if (typeof closest !== "function") return img;
    return closest.call(img, PREVIEW_LAYOUT_BOX_SELECTOR) || img;
  }

  // src/engine/time.ts
  function wallClockNow() {
    return Date.now();
  }
  function formatChatTimestamp(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "";
    try {
      return new Date(ms).toLocaleString(void 0, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      });
    } catch (e) {
      return "";
    }
  }

  // src/engine/ai_agent.ts
  function normalizePlatform(raw) {
    var p = (raw || "").trim().toLowerCase();
    return p === "claude" || p === "openai" ? p : null;
  }
  function parseAiAgentValue(value) {
    var raw = (value || "").trim();
    if (!raw || raw.toLowerCase() === "none") {
      return { platform: null, model: "", contextWindow: null, hasPlatform: false };
    }
    var firstHash = raw.indexOf("#");
    if (firstHash === -1) {
      var only = normalizePlatform(raw);
      return { platform: only, model: "", contextWindow: null, hasPlatform: !!only };
    }
    var platform = normalizePlatform(raw.slice(0, firstHash));
    var rest = raw.slice(firstHash + 1);
    var secondHash = rest.indexOf("#");
    var model = (secondHash === -1 ? rest : rest.slice(0, secondHash)).trim();
    var windowRaw = secondHash === -1 ? "" : rest.slice(secondHash + 1).trim();
    var parsedWindow = windowRaw ? Number(windowRaw) : NaN;
    var contextWindow = Number.isFinite(parsedWindow) && parsedWindow > 0 ? Math.floor(parsedWindow) : null;
    return { platform, model, contextWindow, hasPlatform: !!platform };
  }

  // src/engine/sse.ts
  var CLAUDE_EVENTS = {
    message_start: true,
    message_delta: true,
    message_stop: true,
    content_block_start: true,
    content_block_delta: true,
    content_block_stop: true,
    ping: true
  };
  var CLAUDE_TOOL_BLOCKS = {
    tool_use: true,
    server_tool_use: true,
    mcp_tool_use: true,
    web_search_tool_use: true
  };
  var OPENAI_TOOL_ITEMS = {
    function_call: true,
    mcp_call: true,
    web_search_call: true,
    file_search_call: true,
    code_interpreter_call: true,
    computer_call: true,
    image_generation_call: true
  };
  function detectProvider(type) {
    if (!type) return null;
    if (type.indexOf("response.") === 0) return "openai";
    if (CLAUDE_EVENTS[type]) return "claude";
    return null;
  }
  function lineEnd(s, from) {
    for (var i = from; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 10) return { at: i, len: 1 };
      if (c === 13) {
        if (i + 1 >= s.length) return null;
        return { at: i, len: s.charCodeAt(i + 1) === 10 ? 2 : 1 };
      }
    }
    return null;
  }
  function readFrame(lines) {
    var event = "";
    var data = [];
    var framed = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.length) continue;
      if (line.charCodeAt(0) === 58) {
        framed = true;
        continue;
      }
      var colon = line.indexOf(":");
      var field = colon === -1 ? line : line.slice(0, colon);
      var value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.charCodeAt(0) === 32) value = value.slice(1);
      if (field === "data") {
        framed = true;
        data.push(value);
      } else if (field === "event") {
        framed = true;
        event = value;
      } else if (field === "id" || field === "retry") {
        framed = true;
      }
    }
    return { event, data: data.join("\n"), framed };
  }
  function createSseParser() {
    var buf = "";
    var lines = [];
    var lastSeq = 0;
    var sawFraming = false;
    var raw = "";
    var rawHasContent = false;
    var ended = false;
    var rawParsed = false;
    var rawBody = null;
    var provider = null;
    var terminalEvent = null;
    var errored = false;
    var error = null;
    var stopReason = null;
    var toolCalls = [];
    var malformedFrames = 0;
    var malformedToolJson = 0;
    var message = null;
    var blocks = /* @__PURE__ */ new Map();
    var parts = /* @__PURE__ */ new Map();
    var reasoning = /* @__PURE__ */ new Map();
    var response = null;
    var textCache = null;
    var thinkingCache = null;
    function feed(text) {
      if (typeof text !== "string" || !text.length) return;
      if (!sawFraming) {
        raw += text;
        if (!rawHasContent) rawHasContent = /\S/.test(text);
        rawParsed = false;
        rawBody = null;
      }
      buf += text;
      var i = 0;
      for (; ; ) {
        var end2 = lineEnd(buf, i);
        if (!end2) break;
        var line = buf.slice(i, end2.at);
        i = end2.at + end2.len;
        if (line.length === 0) dispatch();
        else lines.push(line);
      }
      if (i > 0) buf = buf.slice(i);
    }
    function feedChunks(chunks) {
      if (!chunks || !chunks.length) return;
      for (var i = 0; i < chunks.length; i++) {
        var c = chunks[i];
        if (!c || typeof c !== "object") continue;
        var seq = typeof c.seq === "number" ? c.seq : 0;
        if (seq && seq <= lastSeq) continue;
        if (seq > lastSeq) lastSeq = seq;
        feed(typeof c.txt === "string" ? c.txt : "");
      }
    }
    function end() {
      if (buf.length) {
        var tail = buf.charCodeAt(buf.length - 1) === 13 ? buf.slice(0, -1) : buf;
        if (tail.length) lines.push(tail);
        buf = "";
      }
      if (lines.length) dispatch();
      ended = true;
    }
    function isUnframed() {
      return ended && !sawFraming && rawHasContent;
    }
    function dispatch() {
      var pending = lines;
      lines = [];
      if (!pending.length) return;
      try {
        var frame = readFrame(pending);
        if (frame.framed && !sawFraming) {
          sawFraming = true;
          raw = "";
          rawHasContent = false;
        }
        if (!frame.data.length) return;
        if (frame.data === "[DONE]") return;
        var ev = JSON.parse(frame.data);
        if (!ev || typeof ev !== "object") {
          malformedFrames++;
          return;
        }
        var type = typeof ev.type === "string" && ev.type ? ev.type : frame.event;
        if (!type) {
          malformedFrames++;
          return;
        }
        if (!provider) provider = detectProvider(type);
        if (provider === "openai") handleOpenAI(type, ev);
        else if (provider === "claude") handleClaude(type, ev);
        else handleUnattributed(type, ev);
      } catch (e) {
        malformedFrames++;
      }
    }
    function handleUnattributed(type, ev) {
      if (type === "error") {
        takeError(ev && ev.error ? ev : { type: "error", error: ev });
        return;
      }
      malformedFrames++;
    }
    function takeError(payload) {
      errored = true;
      terminalEvent = "error";
      error = payload;
    }
    function handleClaude(type, ev) {
      if (type === "ping") return;
      if (type === "error") {
        takeError({ type: "error", error: ev && ev.error ? ev.error : ev });
        return;
      }
      if (type === "message_start") {
        message = ev && ev.message ? shallowClone(ev.message) : { type: "message", role: "assistant" };
        if (typeof message.stop_reason === "string") stopReason = message.stop_reason;
        return;
      }
      if (type === "content_block_start") {
        var idx = numberOr(ev.index, -1);
        if (idx < 0) {
          malformedFrames++;
          return;
        }
        var block = ev.content_block ? shallowClone(ev.content_block) : {};
        blocks.set(idx, { block, json: "", sawJson: false });
        invalidate();
        if (block && typeof block.type === "string" && CLAUDE_TOOL_BLOCKS[block.type]) {
          var call = {
            index: idx,
            name: typeof block.name === "string" && block.name ? block.name : block.type,
            type: block.type
          };
          if (typeof block.server_name === "string") call.serverName = block.server_name;
          toolCalls.push(call);
        }
        return;
      }
      if (type === "content_block_delta") {
        var i = numberOr(ev.index, -1);
        var d = ev.delta;
        if (i < 0 || !d || typeof d !== "object") {
          malformedFrames++;
          return;
        }
        var st = blocks.get(i);
        if (!st) {
          st = { block: { type: deltaBlockType(d.type) }, json: "", sawJson: false };
          blocks.set(i, st);
        }
        applyClaudeDelta(st, d);
        invalidate();
        return;
      }
      if (type === "content_block_stop") {
        var j = numberOr(ev.index, -1);
        var s = j >= 0 ? blocks.get(j) : void 0;
        if (s && s.sawJson) finishToolJson(s);
        return;
      }
      if (type === "message_delta") {
        if (!message) message = { type: "message", role: "assistant" };
        var delta = ev.delta;
        if (delta && typeof delta === "object") {
          for (var k in delta) {
            if (Object.prototype.hasOwnProperty.call(delta, k)) message[k] = delta[k];
          }
          if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
        }
        if (ev.usage && typeof ev.usage === "object") {
          message.usage = mergeInto(shallowClone(message.usage) || {}, ev.usage);
        }
        return;
      }
      if (type === "message_stop") {
        terminalEvent = "message_stop";
        return;
      }
      malformedFrames++;
    }
    function applyClaudeDelta(st, d) {
      var t = d.type;
      if (t === "text_delta") {
        st.block.text = (st.block.text || "") + str(d.text);
        return;
      }
      if (t === "thinking_delta") {
        st.block.thinking = (st.block.thinking || "") + str(d.thinking);
        return;
      }
      if (t === "signature_delta") {
        st.block.signature = (st.block.signature || "") + str(d.signature);
        return;
      }
      if (t === "input_json_delta") {
        st.json += str(d.partial_json);
        st.sawJson = true;
        return;
      }
      if (t === "citations_delta") {
        if (d.citation) {
          if (!Array.isArray(st.block.citations)) st.block.citations = [];
          st.block.citations.push(d.citation);
        }
        return;
      }
      malformedFrames++;
    }
    function finishToolJson(st) {
      if (!st.json.length) {
        return;
      }
      try {
        st.block.input = JSON.parse(st.json);
      } catch (e) {
        malformedToolJson++;
      }
    }
    function deltaBlockType(deltaType) {
      if (deltaType === "thinking_delta" || deltaType === "signature_delta") return "thinking";
      if (deltaType === "input_json_delta") return "tool_use";
      return "text";
    }
    function handleOpenAI(type, ev) {
      if (type === "response.output_text.delta") {
        putPart(ev, str(ev.delta), false);
        invalidate();
        return;
      }
      if (type === "response.output_text.done") {
        if (typeof ev.text === "string") {
          putPart(ev, ev.text, true);
          invalidate();
        }
        return;
      }
      if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
        putReasoning(type, ev, str(ev.delta), false);
        invalidate();
        return;
      }
      if (type === "response.reasoning_summary_text.done" || type === "response.reasoning_text.done") {
        if (typeof ev.text === "string") {
          putReasoning(type, ev, ev.text, true);
          invalidate();
        }
        return;
      }
      if (type === "response.output_item.added") {
        var item = ev.item;
        if (item && typeof item.type === "string" && OPENAI_TOOL_ITEMS[item.type]) {
          toolCalls.push({
            index: numberOr(ev.output_index, toolCalls.length),
            // A built-in tool (web_search_call) has no name of its own, so the item
            // type is the only label there is and a row can still be drawn.
            name: typeof item.name === "string" && item.name ? item.name : item.type,
            type: item.type
          });
        }
        return;
      }
      if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
        terminalEvent = type;
        if (ev.response && typeof ev.response === "object") {
          response = ev.response;
          var st = response.status;
          if (st === "incomplete") {
            var reason = response.incomplete_details && response.incomplete_details.reason;
            stopReason = typeof reason === "string" && reason ? reason : "incomplete";
          } else if (typeof st === "string" && st) {
            stopReason = st;
          }
          if (response.error && (response.error.message || response.error.code)) {
            errored = true;
            error = response;
          }
        }
        if (type === "response.failed") errored = true;
        return;
      }
      if (type === "response.error" || type === "error") {
        takeError(ev && ev.error ? ev : { type: "error", error: ev });
        return;
      }
    }
    function putReasoning(type, ev, text, replace) {
      var summary = type.indexOf("response.reasoning_summary_text.") === 0;
      var oi = numberOr(ev.output_index, 0);
      var idx = numberOr(summary ? ev.summary_index : ev.content_index, 0);
      var key = oi + ":" + (summary ? "s" : "r") + ":" + idx;
      var r = reasoning.get(key);
      if (!r) {
        r = { oi, idx, kind: summary ? 0 : 1, text: "" };
        reasoning.set(key, r);
      }
      r.text = replace ? text : r.text + text;
    }
    function putPart(ev, text, replace) {
      var oi = numberOr(ev.output_index, 0);
      var ci = numberOr(ev.content_index, 0);
      var key = oi + ":" + ci;
      var p = parts.get(key);
      if (!p) {
        p = { oi, ci, text: "" };
        parts.set(key, p);
      }
      p.text = replace ? text : p.text + text;
    }
    function invalidate() {
      textCache = null;
      thinkingCache = null;
    }
    function claudeTextBlocks() {
      return orderedBlocks().filter(function(b) {
        return b && b.type === "text";
      });
    }
    function orderedBlocks() {
      var idx = [];
      blocks.forEach(function(_v, k) {
        idx.push(k);
      });
      idx.sort(function(a, b) {
        return a - b;
      });
      var out = [];
      for (var i = 0; i < idx.length; i++) out.push(blocks.get(idx[i]).block);
      return out;
    }
    function orderedParts() {
      var out = [];
      parts.forEach(function(p) {
        out.push(p);
      });
      out.sort(function(a, b) {
        return a.oi !== b.oi ? a.oi - b.oi : a.ci - b.ci;
      });
      return out;
    }
    function currentText() {
      if (textCache !== null) return textCache;
      var out;
      if (provider === "openai") {
        out = orderedParts().map(function(p) {
          return p.text;
        }).join("\n");
      } else {
        out = claudeTextBlocks().map(function(b) {
          return b.text || "";
        }).join("\n");
      }
      textCache = out;
      return out;
    }
    function currentThinking() {
      if (thinkingCache !== null) return thinkingCache;
      var out;
      if (provider === "openai") {
        var rs = [];
        reasoning.forEach(function(r) {
          rs.push(r);
        });
        rs.sort(function(a, b) {
          if (a.oi !== b.oi) return a.oi - b.oi;
          if (a.idx !== b.idx) return a.idx - b.idx;
          return a.kind - b.kind;
        });
        out = rs.map(function(r) {
          return r.text;
        }).join("\n");
      } else {
        out = orderedBlocks().filter(function(b) {
          return b && b.type === "thinking";
        }).map(function(b) {
          return b.thinking || "";
        }).join("\n");
      }
      thinkingCache = out;
      return out;
    }
    function buildBody() {
      if (provider === "openai") {
        if (response) return response;
      } else if (blocks.size || message) {
        var base = message ? shallowClone(message) : { type: "message", role: "assistant" };
        base.content = orderedBlocks();
        return base;
      }
      if (errored && error) return error;
      return unframedBody();
    }
    function unframedBody() {
      if (!isUnframed()) return null;
      if (rawParsed) return rawBody;
      rawParsed = true;
      try {
        var v = JSON.parse(raw);
        rawBody = v && typeof v === "object" ? v : null;
      } catch (e) {
        rawBody = null;
      }
      return rawBody;
    }
    function snapshot() {
      return {
        provider,
        text: currentText(),
        thinkingText: currentThinking(),
        toolCalls: toolCalls.slice(),
        toolNames: toolCalls.map(function(t) {
          return t.name;
        }),
        stopReason,
        complete: terminalEvent !== null,
        // A terminal event that ENDED the answer rather than KILLED it. The
        // `errored` term covers all three ways a stream dies with a terminal event
        // on it: an Anthropic or OpenAI `error` frame (takeError sets both), a
        // response.failed, and a response.completed/incomplete whose Response
        // object carries an error payload. See the field's own doc for the loss
        // this separation prevents.
        answerComplete: terminalEvent !== null && terminalEvent !== "error" && !errored,
        terminalEvent,
        errored,
        error,
        malformedFrames,
        malformedToolJson,
        unframed: isUnframed(),
        unframedText: isUnframed() ? raw : null,
        lastSeq
      };
    }
    return {
      feed,
      feedChunks,
      end,
      snapshot,
      finalBody: buildBody
    };
  }
  function str(v) {
    return typeof v === "string" ? v : "";
  }
  function numberOr(v, fallback) {
    return typeof v === "number" && isFinite(v) ? v : fallback;
  }
  function shallowClone(o) {
    if (!o || typeof o !== "object") return o;
    var out = Array.isArray(o) ? o.slice() : {};
    if (!Array.isArray(o)) {
      for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
      }
    }
    return out;
  }
  function mergeInto(target, src) {
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  // src/engine/requests.ts
  var ANTHROPIC_MESSAGES_API_URL = "https://api.anthropic.com/v1/messages";
  var ANTHROPIC_VERSION = "2023-06-01";
  var ANTHROPIC_MCP_BETA = "mcp-client-2025-11-20";
  var ANTHROPIC_WEB_FETCH_BETA = "web-fetch-2025-09-10";
  var ANTHROPIC_PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";
  var ANTHROPIC_BETA_HEADER = `${ANTHROPIC_MCP_BETA},${ANTHROPIC_WEB_FETCH_BETA},${ANTHROPIC_PROMPT_CACHING_BETA}`;
  var WEB_FETCH_MAX_USES = 40;
  var WEB_FETCH_MAX_CONTENT_TOKENS = 2e5;
  var OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";
  var DEFAULT_OPENAI_IMAGE_DETAIL = "auto";
  var OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS = true;
  var MCP_NAME = "BunnyQuery";
  var DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
  var DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
  var mcpUrl = () => chatEngineConfig().mcpBaseUrl;
  function withMcpParams(base, params) {
    if (!base) return base;
    const pairs = Object.keys(params).filter((k) => params[k] !== void 0 && params[k] !== null && params[k] !== "").map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])));
    if (!pairs.length) return base;
    const [addr, existing] = base.split("?");
    const hasPath = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/./i.test(addr);
    const path = hasPath ? addr : addr.replace(/\/+$/, "") + "/";
    return path + "?" + (existing ? existing + "&" : "") + pairs.join("&");
  }
  var mcpContextParam = (platform, model) => getModelContextWindow(platform, model);
  var mcpIndexingUrl = (platform = "openai", model) => withMcpParams(mcpUrl(), { profile: "index", ctx: mcpContextParam(platform, model) });
  function mcpEndpointFor(anonymous, publicProjectId, service) {
    if (!anonymous) return { url: mcpUrl(), token: "$ACCESS_TOKEN" };
    const project = publicProjectId || service;
    return { url: String(mcpUrl()).replace(/\/+$/, "") + "/p/" + project };
  }
  var clientSecretRequest = (opts) => chatEngineConfig().clientSecretRequest(opts);
  var CHAT_STREAM_ON = Object.freeze({
    transport: Object.freeze({ stream: true }),
    body: Object.freeze({ stream: true })
  });
  var CHAT_STREAM_OFF = Object.freeze({
    transport: Object.freeze({}),
    body: Object.freeze({})
  });
  var CHAT_STREAM_ON_REALTIME = Object.freeze({
    // `realtime` rides on the TRANSPORT arm only. It is a skapi option, not a field
    // the destination understands, so it must never reach `data`: the body arm stays
    // exactly what it is with the socket off.
    transport: Object.freeze({ stream: true, realtime: true }),
    body: Object.freeze({ stream: true })
  });
  function chatStreamWiring(queue) {
    if (!liveStreamingEnabled()) return CHAT_STREAM_OFF;
    if (isBgIndexingQueue(queue)) return CHAT_STREAM_OFF;
    return liveStreamingRealtimeEnabled() ? CHAT_STREAM_ON_REALTIME : CHAT_STREAM_ON;
  }
  var VARIANT_IMAGE_DETAIL = "original";
  var VARIANT_TEXT_VERBOSITY = "high";
  var OLDEST_NANO_REASONING_EFFORT = "high";
  var isOpenAINano = (model) => {
    const normalized = (model).trim().toLowerCase();
    if (!/(^|-)nano(-|$)/.test(normalized)) return false;
    const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = match[2] === void 0 ? null : Number(match[2]);
    return major > 5 || major === 5 && minor !== null && minor >= 4;
  };
  var variantIndexingOptions = (model) => {
    if (!isOpenAINano(model) || !isOldestNano(model)) return {};
    return {
      ...{ text: { verbosity: VARIANT_TEXT_VERBOSITY } } ,
      ...{ reasoning: { effort: OLDEST_NANO_REASONING_EFFORT } } 
    };
  };
  var getOpenAIImageDetail = (model) => {
    const normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
    const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/);
    if (!match) {
      return DEFAULT_OPENAI_IMAGE_DETAIL;
    }
    const major = Number(match[1]);
    const minor = match[2] === void 0 ? null : Number(match[2]);
    const isVariant = !!match[3];
    const supportsOriginal = major > 5 || major === 5 && minor !== null && minor >= 4;
    if (!supportsOriginal) {
      return DEFAULT_OPENAI_IMAGE_DETAIL;
    }
    return isVariant ? VARIANT_IMAGE_DETAIL : "original";
  };
  var getRenderImageDetail = (model) => {
    const detail = getOpenAIImageDetail(model);
    return detail === DEFAULT_OPENAI_IMAGE_DETAIL ? "high" : detail;
  };
  var OPENAI_VERSIONED_ID = /^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/;
  var isRecognisedOpenAIVersion = (model) => OPENAI_VERSIONED_ID.test((model).trim().toLowerCase());
  var isOldestNano = (model) => {
    const normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
    if (!/(^|-)nano(-|$)/.test(normalized)) return false;
    const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(-[a-z0-9.\-]+)?$/);
    if (!match) return true;
    const major = Number(match[1]);
    const minor = match[2] === void 0 ? null : Number(match[2]);
    if (major < 5) return true;
    if (major > 5) return false;
    return minor === null || minor <= 4;
  };
  var SMALL_TIER_PAGES_PER_WINDOW = 2;
  var DOWNSAMPLED_TIER_TILE = 2;
  function getVisionProfile(model) {
    const detail = getRenderImageDetail(model);
    if (!isRecognisedOpenAIVersion(model)) {
      return { detail, pagesPerWindow: RENDER_PAGES_PER_WINDOW, tile: 1 };
    }
    if (detail !== "original") {
      return { detail, pagesPerWindow: SMALL_TIER_PAGES_PER_WINDOW, tile: DOWNSAMPLED_TIER_TILE };
    }
    if (isOldestNano(model)) {
      return { detail, pagesPerWindow: SMALL_TIER_PAGES_PER_WINDOW, tile: 1 };
    }
    return { detail, pagesPerWindow: RENDER_PAGES_PER_WINDOW, tile: 1 };
  }
  var IMAGE_URL_REGEX = /\bhttps?:\/\/[^\s<>"'()\[\]]+?\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s<>"'()\[\]]*)?/gi;
  function transformContentWithImages(content) {
    if (typeof content !== "string" || !content) {
      return content;
    }
    const matches = content.match(IMAGE_URL_REGEX);
    if (!matches || !matches.length) {
      return content;
    }
    const seen = /* @__PURE__ */ new Set();
    const imageBlocks = [];
    for (const url of matches) {
      if (seen.has(url)) continue;
      seen.add(url);
      imageBlocks.push({
        type: "image",
        source: { type: "url", url }
      });
    }
    return [...imageBlocks, { type: "text", text: content }];
  }
  function prepareClaudeMessages(messages) {
    if (!messages.length) return messages;
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (last.role !== "user") return messages;
    const content = transformContentWithImages(last.content);
    if (content === last.content) return messages;
    const next = messages.slice();
    next[lastIndex] = { role: last.role, content };
    return next;
  }
  function transformContentWithOpenAIImages(content, detail = DEFAULT_OPENAI_IMAGE_DETAIL) {
    if (typeof content !== "string" || !content) {
      return content;
    }
    const matches = content.match(IMAGE_URL_REGEX);
    if (!matches || !matches.length) {
      return content;
    }
    const seen = /* @__PURE__ */ new Set();
    const imageBlocks = [];
    for (const url of matches) {
      if (seen.has(url)) continue;
      seen.add(url);
      imageBlocks.push({
        type: "input_image",
        image_url: url,
        detail
      });
    }
    return [{ type: "input_text", text: content }, ...imageBlocks];
  }
  function prepareOpenAIMessages(messages, detail = DEFAULT_OPENAI_IMAGE_DETAIL) {
    if (!messages.length) return messages;
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    if (last.role !== "user") return messages;
    const content = transformContentWithOpenAIImages(last.content, detail);
    if (content === last.content) return messages;
    const next = messages.slice();
    next[lastIndex] = { role: last.role, content };
    return next;
  }
  function applyHistoryCacheBreakpoint(messages) {
    if (messages.length < 2) return messages;
    const breakpointIndex = messages.length - 2;
    return messages.map((m, i) => {
      if (i !== breakpointIndex) return m;
      const blocks = Array.isArray(m.content) ? m.content.slice() : [{ type: "text", text: m.content }];
      if (!blocks.length) return m;
      const lastBlockIndex = blocks.length - 1;
      blocks[lastBlockIndex] = {
        ...blocks[lastBlockIndex],
        cache_control: { type: "ephemeral" }
      };
      return { ...m, content: blocks };
    });
  }
  var POLL_INTERVAL = 3e3;
  var STREAM_POLL_INTERVAL = 1e3;
  var MAX_CONCURRENT_BG_POLLS = 6;
  async function callClaudeWithMcp({
    prompt,
    messages,
    service,
    owner,
    userId,
    model = DEFAULT_CLAUDE_MODEL,
    maxTokens = 1e3,
    system,
    mcpServer,
    extractContent,
    fileUrls
  }) {
    const mcpServerDefinition = {
      type: "url",
      name: mcpServer.name,
      url: mcpServer.url
    };
    if (mcpServer.authorizationToken) {
      mcpServerDefinition.authorization_token = mcpServer.authorizationToken;
    }
    const stream = chatStreamWiring(userId || service);
    return clientSecretRequest({
      clientSecretName: "claude",
      queue: userId || service,
      service,
      owner,
      ...pollOpt(),
      ...stream.transport,
      url: ANTHROPIC_MESSAGES_API_URL,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "$CLIENT_SECRET",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA_HEADER
      },
      data: {
        model,
        max_tokens: maxTokens,
        // Top level beside model/messages/mcp_servers, which is where the
        // Messages API takes it.
        ...stream.body,
        ...extractContent && extractContent.length ? { _skapi_extract: extractContent } : {},
        ...fileUrls && fileUrls.length ? { _skapi_file_urls: fileUrls } : {},
        ...system ? {
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" }
            }
          ]
        } : {},
        messages: (() => {
          const prepared = messages && messages.length ? prepareClaudeMessages(messages) : [
            {
              role: "user",
              content: transformContentWithImages(prompt)
            }
          ];
          return applyHistoryCacheBreakpoint(prepared);
        })(),
        mcp_servers: [mcpServerDefinition],
        tools: [
          {
            type: "mcp_toolset",
            mcp_server_name: mcpServer.name,
            ...mcpServer.defaultConfig ? { default_config: mcpServer.defaultConfig } : {},
            ...mcpServer.configs ? { configs: mcpServer.configs } : {}
          },
          {
            type: "web_fetch_20250910",
            name: "web_fetch",
            max_uses: WEB_FETCH_MAX_USES,
            citations: { enabled: true },
            max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS
          }
        ]
      }
    });
  }
  async function callClaudeWithPublicMcp(prompt, service, owner, messages, system, model, userId, extractContent, fileUrls, onResponse, onError, mcpScope) {
    const endpoint = mcpEndpointFor(mcpScope?.anonymous, mcpScope?.publicProjectId, service);
    return callClaudeWithMcp({
      prompt,
      messages,
      service,
      owner,
      userId,
      model: model || DEFAULT_CLAUDE_MODEL,
      maxTokens: getMaxOutputTokens("claude", model || DEFAULT_CLAUDE_MODEL),
      system,
      extractContent,
      fileUrls,
      mcpServer: {
        name: MCP_NAME,
        url: withMcpParams(endpoint.url, {
          ctx: mcpContextParam("claude", model || DEFAULT_CLAUDE_MODEL)
        }),
        // Omitted entirely for an anonymous turn; the `if (mcpServer.authorizationToken)`
        // guard below drops the key rather than sending an empty one.
        authorizationToken: endpoint.token
      }});
  }
  async function callOpenAIWithPublicMcp(prompt, service, owner, messages, system, model, userId, extractContent, fileUrls, onResponse, onError, mcpScope) {
    const endpoint = mcpEndpointFor(mcpScope?.anonymous, mcpScope?.publicProjectId, service);
    const resolvedModel = model || DEFAULT_OPENAI_MODEL;
    const imageDetail = getOpenAIImageDetail(resolvedModel);
    const messageList = messages && messages.length ? prepareOpenAIMessages(messages, imageDetail) : [
      {
        role: "user",
        content: transformContentWithOpenAIImages(prompt, imageDetail)
      }
    ];
    const responseInput = [
      ...system ? [
        {
          role: "system",
          content: system
        }
      ] : [],
      ...messageList.map((m) => ({
        role: m.role,
        content: m.content
      }))
    ];
    const stream = chatStreamWiring(userId || service);
    return clientSecretRequest({
      clientSecretName: "openai",
      queue: userId || service,
      service,
      owner,
      ...pollOpt(),
      ...stream.transport,
      url: OPENAI_RESPONSES_API_URL,
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer $CLIENT_SECRET"
      },
      data: {
        model: resolvedModel,
        max_output_tokens: getMaxOutputTokens("openai", resolvedModel),
        // Top level beside model/input/tools, which is where the Responses API
        // takes it.
        ...stream.body,
        ...extractContent && extractContent.length ? { _skapi_extract: extractContent } : {},
        ...fileUrls && fileUrls.length ? { _skapi_file_urls: fileUrls } : {},
        input: responseInput,
        tools: [
          {
            type: "mcp",
            server_label: MCP_NAME,
            server_url: withMcpParams(endpoint.url, { ctx: mcpContextParam("openai", resolvedModel) }),
            require_approval: "never",
            // No `headers` at all for an anonymous turn: `Bearer ` with an
            // empty token is a credential the MCP server rejects, and the
            // project-scoped endpoint needs none.
            ...endpoint.token ? { headers: { Authorization: "Bearer " + endpoint.token } } : {}
          },
          ...[
            {
              type: "web_search",
              external_web_access: OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS
            }
          ] 
        ]
      }
    });
  }
  async function notifyAgentContinueIndexing(info) {
    return notifyAgentSaveAttachment({ ...info, continueIndexing: true });
  }
  async function notifyAgentSaveAttachment(info) {
    const { platform, service, owner, attachment, parsedContent } = info;
    const continuing = !!info.continueIndexing;
    if (!continuing) {
      upsertIndexRunRecordSafe(service, attachment.storagePath, {
        status: "working",
        filename: attachment.name,
        started: Date.now(),
        queue: bgIndexingQueueName(info.userId, service),
        platform
      });
    }
    const tapDispatchFailure = (p) => {
      if (continuing) return p;
      return p.then(
        (ack) => ack,
        (err) => {
          upsertIndexRunRecordSafe(service, attachment.storagePath, {
            status: "error",
            finished: Date.now(),
            error: err && (err.message || String(err)) || "The indexing request could not be enqueued."
          });
          throw err;
        }
      );
    };
    const visionFile = !parsedContent && isImageVisionFile(attachment.name, attachment.mime);
    const renderFrom = Math.max(0, info.renderFrom || 0);
    const renderPlaceholder = visionFile ? makeRenderPlaceholder(attachment.storagePath) : void 0;
    const renderDetail = platform === "openai" ? getRenderImageDetail(info.model || DEFAULT_OPENAI_MODEL) : void 0;
    const visionProfile = platform === "openai" ? getVisionProfile(info.model || DEFAULT_OPENAI_MODEL) : { pagesPerWindow: RENDER_PAGES_PER_WINDOW, tile: 1 };
    const skapiRender = visionFile && renderPlaceholder ? {
      _skapi_render: [
        {
          path: attachment.storagePath,
          from: renderFrom,
          count: visionProfile.pagesPerWindow,
          placeholder: renderPlaceholder,
          name: attachment.name,
          mime: attachment.mime,
          detail: renderDetail,
          tile: visionProfile.tile,
          auto_continue: true,
          continue_text: buildIndexingRenderContinueTemplate(attachment, renderPlaceholder)
        }
      ]
    } : {};
    const windowedRead = !visionFile && !parsedContent && windowedIndexingEnabled() && isWindowedReadFile(attachment.name, attachment.mime);
    const windowPlaceholder = windowedRead ? makeWindowPlaceholder(attachment.storagePath) : void 0;
    const skapiWindow = windowedRead && windowPlaceholder ? {
      _skapi_window: [
        {
          path: attachment.storagePath,
          cursor: null,
          placeholder: windowPlaceholder,
          name: attachment.name,
          mime: attachment.mime,
          kind: "window",
          // Same per-image `detail` the render path sends. Without it the worker falls
          // back to its model-blind default of 'high', so a spreadsheet's embedded
          // photos were tiled at lower resolution than the SAME model gets for a PDF
          // page or a chat attachment. That is why a model could describe an attached
          // photo but reported the pictures inside a sheet as only partly legible.
          detail: renderDetail,
          auto_continue: true,
          continue_text: buildIndexingWindowMessage(attachment, windowPlaceholder, true)
        }
      ]
    } : {};
    const pagedRead = !visionFile && !windowedRead && (continuing || !parsedContent && isPagedReadFile(attachment.name, attachment.mime));
    const serverExtract = !visionFile && !windowedRead && !continuing && !parsedContent && !pagedRead && isServerExtractable(attachment.name, attachment.mime);
    const placeholder = serverExtract ? makeExtractPlaceholder(attachment.storagePath) : void 0;
    const extractContent = serverExtract && placeholder ? [{ path: attachment.storagePath, placeholder, name: attachment.name, mime: attachment.mime }] : void 0;
    const skapiExtract = extractContent && extractContent.length ? {
      _skapi_extract: extractContent.map((d) => ({
        ...d,
        // FIRST pass of an INDEXING run only: tells the worker to also pull the
        // file's embedded pictures into __MEDIA__ and register their records.
        // Chat-turn extraction (callClaudeWithMcp / callOpenAIWithPublicMcp)
        // never sets this, so merely ATTACHING a file to a chat message cannot
        // write media records; a CONTINUE pass skips it because the first pass
        // already saved (the save is whole-file, not windowed).
        save_media: !continuing
      }))
    } : {};
    const skapiFileUrls = attachment.url && attachment.storagePath ? { _skapi_file_urls: [{ path: attachment.storagePath, url: attachment.url }] } : {};
    const userMessage = visionFile && renderPlaceholder ? buildIndexingRenderMessage(attachment, renderPlaceholder, renderFrom) : windowedRead && windowPlaceholder ? buildIndexingWindowMessage(attachment, windowPlaceholder, false) : continuing ? buildIndexingContinueMessage(attachment) : buildIndexingUserMessage(
      attachment,
      parsedContent ? { inlineContent: parsedContent } : placeholder ? { inlineContentPlaceholder: placeholder } : pagedRead ? { pagedRead: true } : void 0
    );
    const systemPrompt = buildIndexingSystemPrompt({
      // The model copies this id verbatim into project_id tool calls, so it must be
      // the PUBLIC token whenever the host supplied one; the raw code is rejected
      // by the tools' schema pattern.
      projectId: info.publicProjectId || service,
      serviceName: info.serviceName,
      serviceDescription: info.serviceDescription,
      // Per-FILE, not per-project: one project holds public and private files at
      // once, so this travels on the attachment rather than the identity.
      accessGroup: attachment.accessGroup
    });
    if (platform === "openai") {
      const resolvedModel2 = info.model || DEFAULT_OPENAI_MODEL;
      const imageDetail = getOpenAIImageDetail(resolvedModel2);
      return tapDispatchFailure(clientSecretRequest({
        clientSecretName: "openai",
        queue: bgIndexingQueueName(info.userId, service),
        service,
        owner,
        ...pollOpt(),
        url: OPENAI_RESPONSES_API_URL,
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer $CLIENT_SECRET"
        },
        data: {
          model: resolvedModel2,
          max_output_tokens: getMaxOutputTokens("openai", resolvedModel2, "indexing"),
          // Nano-only transcription knobs. Indexing only; see variantIndexingOptions.
          ...variantIndexingOptions(resolvedModel2),
          ...skapiExtract,
          ...skapiRender,
          ...skapiWindow,
          ...skapiFileUrls,
          input: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: transformContentWithOpenAIImages(userMessage, imageDetail)
            }
          ],
          tools: [
            {
              type: "mcp",
              server_label: MCP_NAME,
              server_url: mcpIndexingUrl("openai", resolvedModel2),
              require_approval: "never",
              headers: { Authorization: "Bearer $ACCESS_TOKEN" }
            },
            ...[
              {
                type: "web_search",
                external_web_access: OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS
              }
            ] 
          ]
        }
      }));
    }
    const resolvedModel = info.model || DEFAULT_CLAUDE_MODEL;
    return tapDispatchFailure(clientSecretRequest({
      clientSecretName: "claude",
      queue: bgIndexingQueueName(info.userId, service),
      service,
      owner,
      ...pollOpt(),
      url: ANTHROPIC_MESSAGES_API_URL,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "$CLIENT_SECRET",
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_BETA_HEADER
      },
      data: {
        model: resolvedModel,
        max_tokens: getMaxOutputTokens("claude", resolvedModel, "indexing"),
        ...skapiExtract,
        ...skapiRender,
        ...skapiWindow,
        ...skapiFileUrls,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" }
          }
        ],
        messages: [
          {
            role: "user",
            content: transformContentWithImages(userMessage)
          }
        ],
        mcp_servers: [
          {
            type: "url",
            name: MCP_NAME,
            url: mcpIndexingUrl("claude", resolvedModel),
            authorization_token: "$ACCESS_TOKEN"
          }
        ],
        tools: [
          {
            type: "mcp_toolset",
            mcp_server_name: MCP_NAME
          },
          {
            type: "web_fetch_20250910",
            name: "web_fetch",
            max_uses: WEB_FETCH_MAX_USES,
            citations: { enabled: true },
            max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS
          }
        ]
      }
    }));
  }
  function extractClaudeText(response) {
    if (!Array.isArray(response?.content)) {
      return "";
    }
    return response.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
  }
  function extractOpenAIText(response) {
    if (typeof response?.output_text === "string" && response.output_text.length) {
      return response.output_text;
    }
    if (Array.isArray(response?.output)) {
      const text = response.output.flatMap((item) => item?.content || []).filter((part) => part?.type === "output_text").map((part) => part.text || "").join("\n").trim();
      if (text) {
        return text;
      }
    }
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part?.type === "text") {
          return part.text || "";
        }
        return "";
      }).join("\n");
    }
    return "";
  }
  var BG_INDEXING_QUEUE_SUFFIX = "-bg";
  function indexDoneUniqueId(storagePath) {
    return "done::" + storagePath;
  }
  function runIndexUniqueId(storagePath) {
    return "run::" + storagePath;
  }
  function upsertIndexRunRecordSafe(service, storagePath, patch) {
    if (!service || !storagePath) return;
    try {
      const hook = chatEngineConfig().upsertIndexRunRecord;
      if (typeof hook !== "function") return;
      hook({ service, storagePath, patch });
    } catch (e) {
    }
  }
  function bgIndexingQueueName(userId, service) {
    return (userId || service || "") + BG_INDEXING_QUEUE_SUFFIX;
  }
  function isBgIndexingQueue(queueName) {
    if (typeof queueName !== "string" || !queueName) return false;
    const prefix = queueName.split("|")[0];
    const idx = prefix.lastIndexOf(":");
    const name = idx === -1 ? prefix : prefix.slice(idx + 1);
    return name.slice(-BG_INDEXING_QUEUE_SUFFIX.length) === BG_INDEXING_QUEUE_SUFFIX;
  }
  var INDEXING_COMPLETE_MARKER = "INDEXING_COMPLETE";
  var EMPTY_INDEXING_REPLY = "Finished reading this file.";
  var MAX_INDEXING_RESUME_PASSES = 6;
  var CHAT_HISTORY_PAGE_LIMIT = 500;
  async function getChatHistory(params, fetchOptions) {
    const url = params.platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
    const p = Object.assign(
      {
        url,
        method: "POST"
      },
      { service: params.service, owner: params.owner },
      params.queue ? { queue: params.queue } : {},
      params.status ? { status: params.status } : {},
      params.queue_exact ? { queue_exact: true } : {},
      params.compact ? { compact: true } : {},
      params.queue_exclude ? { queue_exclude: params.queue_exclude } : {}
    );
    return chatEngineConfig().clientSecretRequestHistory(
      p,
      Object.assign({ ascending: false, limit: CHAT_HISTORY_PAGE_LIMIT }, fetchOptions)
    );
  }
  function buildHistoryItemFullId(platform, service, itemId) {
    const url = platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
    return `[POST]${url.toLowerCase()}#${service}:${itemId}`;
  }

  // src/engine/history.ts
  function filterListByClearHorizon(list, clearedAt) {
    if (!clearedAt) return list;
    return list.filter(function(item) {
      var updated = Number(item && item.updated);
      return isFinite(updated) && updated > clearedAt;
    });
  }
  function normalizeTextContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(function(part) {
        if (typeof part === "string") return part;
        if (part && (part.type === "text" || part.type === "input_text" || part.type === "output_text")) return part.text || "";
        return "";
      }).join("\n").trim();
    }
    return "";
  }
  function extractLastUserTextFromRequest(requestBody) {
    var arr = requestBody && Array.isArray(requestBody.messages) ? requestBody.messages : requestBody && Array.isArray(requestBody.input) ? requestBody.input : [];
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].role === "user") {
        var t = normalizeTextContent(arr[i].content);
        if (t) return t;
      }
    }
    return "";
  }
  function isIndexingRequestText(userText) {
    if (typeof userText !== "string") return false;
    return userText.indexOf("A new file has just been uploaded") === 0 || userText.indexOf("CONTINUE indexing") === 0;
  }
  function parseIndexingRequestText(userText) {
    if (typeof userText !== "string" || !userText) return null;
    var nameMatch = userText.match(/^- name: (.+)$/m);
    if (!nameMatch) return null;
    var mimeMatch = userText.match(/^- mime type: (.+)$/m);
    var sizeMatch = userText.match(/^- size \(bytes\): (\d+)$/m);
    var pathMatch = userText.match(/^- storage path: (.+)$/m);
    return {
      name: nameMatch[1].trim(),
      path: pathMatch ? pathMatch[1].trim() : void 0,
      mime: mimeMatch ? mimeMatch[1].trim() : void 0,
      size: sizeMatch ? Number(sizeMatch[1]) : void 0,
      continued: userText.indexOf("CONTINUE indexing") === 0
    };
  }
  var BG_PROBE_TTL_MS = 4e3;
  var bgProbeCache = {};
  var bgProbeInflight = {};
  function probeBgQueue(params, opts) {
    const key = [params.service, params.owner, params.platform, params.queue, params.status, params.limit].join("|");
    const maxAge = opts && typeof opts.maxAgeMs === "number" ? opts.maxAgeMs : 0;
    const cached = bgProbeCache[key];
    if (maxAge > 0 && cached && Date.now() - cached.at < maxAge) {
      return Promise.resolve(cached);
    }
    const inflight = bgProbeInflight[key];
    if (inflight) return inflight;
    const p = Promise.resolve(getChatHistory(
      { service: params.service, owner: params.owner, platform: params.platform, queue: params.queue, status: params.status },
      { limit: params.limit, fetchMore: false }
    )).then(function(result) {
      const entry2 = { result, at: Date.now() };
      bgProbeCache[key] = entry2;
      return entry2;
    });
    bgProbeInflight[key] = p;
    p.then(function() {
      delete bgProbeInflight[key];
    }, function() {
      delete bgProbeInflight[key];
    });
    return p;
  }
  var BG_COVERAGE_MAX_PAGES = 2;
  var splitHistoryStates = {};
  var splitHistoryLocks = {};
  function freshSplitState() {
    return { bgBuffer: [], bgEnd: false, bgStarted: false, surfaceEnd: false, pendingSurface: null, surfaceCarry: [], lastSurfaceKeys: [], newestBgId: "" };
  }
  function noteBgIds(state, list) {
    for (const it of list) {
      const id = it && typeof it.id === "string" ? it.id : "";
      if (id && id > state.newestBgId) state.newestBgId = id;
    }
  }
  var createdOf = (it) => {
    const c = Number(it && it.created);
    return isFinite(c) && c > 0 ? c : NaN;
  };
  var oldestCreated = (lst) => {
    let m = Infinity;
    for (const it of lst) {
      const c = createdOf(it);
      if (!isNaN(c) && c < m) m = c;
    }
    return m;
  };
  var SURFACE_EMPTY_MAX_PAGES = 10;
  async function getSplitChatHistory(params, fetchOptions, _fetchImpl) {
    const key = [params.service, params.owner, params.platform, params.userId || ""].join("|");
    const prev = splitHistoryLocks[key] || Promise.resolve();
    let releaseLock;
    const lockTail = new Promise((r) => {
      releaseLock = r;
    });
    const run = () => _getSplitChatHistoryLocked(key, params, fetchOptions, releaseLock);
    const p = prev.then(run, run);
    p.then((res) => {
      if (!res || !res.bgPending) releaseLock();
    }, () => releaseLock());
    splitHistoryLocks[key] = p.then(() => lockTail, () => lockTail);
    return p;
  }
  async function _getSplitChatHistoryLocked(key, params, fetchOptions, releaseLock, _fetchImpl) {
    const fetch2 = getChatHistory;
    const bgQueue = bgIndexingQueueName(params.userId, params.service);
    const base = { service: params.service, owner: params.owner, platform: params.platform };
    const surfaceScope = params.scopeSurfaceToQueue && params.userId ? { queue: params.userId, queue_exact: true } : { queue_exclude: bgQueue };
    const fetchMore = !!(fetchOptions && fetchOptions.fetchMore);
    const limit = fetchOptions && fetchOptions.limit;
    const firstLoad = !splitHistoryStates[key];
    let headRefresh = false;
    if (!splitHistoryStates[key]) {
      splitHistoryStates[key] = freshSplitState();
    } else if (!fetchMore) {
      const prev = splitHistoryStates[key];
      if (prev.surfaceEnd && prev.bgEnd) {
        headRefresh = true;
        prev.pendingSurface = null;
        prev.surfaceCarry = [];
        prev.bgBuffer = [];
      } else {
        splitHistoryStates[key] = freshSplitState();
      }
    }
    const state = splitHistoryStates[key];
    if (state.pendingSurface && state.pendingSurface.forFetchMore !== fetchMore) {
      state.pendingSurface = null;
    }
    if (!state.pendingSurface) {
      if (state.surfaceEnd && !headRefresh) {
        state.pendingSurface = { list: [], endOfList: true, startKeyHistory: state.lastSurfaceKeys, forFetchMore: fetchMore };
      } else {
        const sOpts = { fetchMore };
        if (limit) sOpts.limit = limit;
        let s = await fetch2({ ...base, ...surfaceScope }, sOpts);
        let hops = 0;
        while (s && !s.endOfList && !(s.list || []).length && hops < SURFACE_EMPTY_MAX_PAGES) {
          hops++;
          const nOpts = { fetchMore: true };
          if (limit) nOpts.limit = limit;
          s = await fetch2({ ...base, ...surfaceScope }, nOpts);
        }
        state.pendingSurface = {
          list: s && Array.isArray(s.list) ? s.list : [],
          endOfList: !!(s && s.endOfList),
          startKeyHistory: s && Array.isArray(s.startKeyHistory) ? s.startKeyHistory : [],
          forFetchMore: fetchMore
        };
      }
    }
    const surface = state.pendingSurface;
    if (fetchOptions && fetchOptions.deferBg && (!state.bgEnd || headRefresh)) {
      const surfaceList0 = state.surfaceCarry.length ? state.surfaceCarry.concat(surface.list) : surface.list.slice();
      state.surfaceCarry = [];
      const emitNow = surfaceList0.concat(state.bgBuffer);
      state.bgBuffer = [];
      if (!headRefresh) state.surfaceEnd = surface.endOfList;
      state.lastSurfaceKeys = surface.startKeyHistory;
      state.pendingSurface = null;
      const bgPending = (async () => {
        try {
          const batch = [];
          if (headRefresh) {
            const bOpts = { fetchMore: false };
            if (limit) bOpts.limit = limit;
            const b = await fetch2({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
            const bList = b && Array.isArray(b.list) ? b.list : [];
            for (const it of bList) {
              if (it && typeof it === "object") it._fromBgChain = true;
              batch.push(it);
            }
            const prevNewest = state.newestBgId;
            noteBgIds(state, bList);
            if (prevNewest && !(b && b.endOfList) && !bList.some((it) => it && it.id === prevNewest)) {
              state.bgEnd = false;
              state.bgStarted = true;
            }
          } else {
            let hops = 0;
            while (!state.bgEnd && hops < BG_COVERAGE_MAX_PAGES) {
              hops++;
              const bOpts = { fetchMore: state.bgStarted };
              if (limit) bOpts.limit = limit;
              const b = await fetch2({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
              state.bgStarted = true;
              const bList = b && Array.isArray(b.list) ? b.list : [];
              for (const it of bList) {
                if (it && typeof it === "object") it._fromBgChain = true;
                batch.push(it);
              }
              noteBgIds(state, bList);
              state.bgEnd = !!(b && b.endOfList);
              if (!bList.length && !state.bgEnd) break;
              if (state.bgEnd) break;
            }
          }
          return { list: batch, endOfList: state.surfaceEnd && state.bgEnd };
        } finally {
          releaseLock();
        }
      })();
      return {
        list: emitNow,
        // A head-refreshed ended chain KNOWS it is still ended — reporting
        // the hardcoded false here was what un-gated the fill loop on every
        // tab return. Mid-walk it computes to false exactly as before (this
        // branch is only entered with bgEnd false then); the bg batch still
        // carries the final word for that case.
        endOfList: state.surfaceEnd && state.bgEnd,
        startKeyHistory: surface.startKeyHistory,
        firstLoad,
        bgPending
      };
    }
    const surfaceList = state.surfaceCarry.length ? state.surfaceCarry.concat(surface.list) : surface.list.slice();
    const boundary = surface.endOfList ? -Infinity : oldestCreated(surfaceList);
    if (headRefresh) {
      const hOpts = { fetchMore: false };
      if (limit) hOpts.limit = limit;
      const hb = await fetch2({ ...base, queue: bgQueue, queue_exact: true, compact: true }, hOpts);
      const hbList = hb && Array.isArray(hb.list) ? hb.list : [];
      for (const it of hbList) {
        if (it && typeof it === "object") it._fromBgChain = true;
        state.bgBuffer.push(it);
      }
      const prevNewestH = state.newestBgId;
      noteBgIds(state, hbList);
      if (prevNewestH && !(hb && hb.endOfList) && !hbList.some((it) => it && it.id === prevNewestH)) {
        state.bgEnd = false;
        state.bgStarted = true;
      }
    } else if (boundary !== Infinity || surface.endOfList) {
      let hops = 0;
      while (!state.bgEnd && hops < BG_COVERAGE_MAX_PAGES) {
        const bufOldest = state.bgBuffer.length ? oldestCreated(state.bgBuffer) : Infinity;
        if (state.bgBuffer.length && bufOldest <= boundary) break;
        hops++;
        const bOpts = { fetchMore: state.bgStarted };
        if (limit) bOpts.limit = limit;
        const b = await fetch2({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
        state.bgStarted = true;
        const bList = b && Array.isArray(b.list) ? b.list : [];
        for (const it of bList) {
          if (it && typeof it === "object") it._fromBgChain = true;
          state.bgBuffer.push(it);
        }
        noteBgIds(state, bList);
        state.bgEnd = !!(b && b.endOfList);
        if (!bList.length && !state.bgEnd) break;
        if (state.bgEnd) break;
      }
    }
    const emitSurface = surfaceList;
    state.surfaceCarry = [];
    const emitBg = state.bgBuffer;
    state.bgBuffer = [];
    const seen = {};
    for (const it of emitSurface) {
      if (it && typeof it.id === "string") seen[it.id] = true;
    }
    const merged = emitSurface.concat(emitBg.filter((it) => !(it && typeof it.id === "string" && seen[it.id])));
    if (!headRefresh) state.surfaceEnd = surface.endOfList;
    state.lastSurfaceKeys = surface.startKeyHistory;
    state.pendingSurface = null;
    return {
      list: merged,
      endOfList: state.surfaceEnd && state.bgEnd && state.bgBuffer.length === 0 && state.surfaceCarry.length === 0,
      // Bookkeeping only (both the consumers and the SDK treat it opaquely);
      // the real cursors are the SDK's internal ones plus this module's state.
      startKeyHistory: surface.startKeyHistory,
      firstLoad
    };
  }
  function chatCacheKey(projectId, platform, userId) {
    if (!projectId || platform === "none") return "";
    return projectId + "#" + platform + "#" + (userId || "");
  }
  function indexScopeKey(projectId, platform) {
    if (!projectId || platform === "none") return "";
    return projectId + "#" + platform;
  }
  function mapHistoryListToMessages(list, platform, opts) {
    var mapped = [], runningItemIds = [], streamPendingItemIds = [];
    var extractAssistantText = platform === "openai" ? extractOpenAIText : extractClaudeText;
    var canRecoverStreams = streamRecoveryEnabled();
    var filtered = filterListByClearHorizon(list, opts.clearedAt);
    filtered.slice().reverse().forEach(function(item) {
      var requestBody = item && item.request_body;
      var isInProcess = item && item.status === "running";
      var isQueued = item && item.status === "pending";
      var isCancelledItem = item && item.status === "cancelled";
      var isPending = isInProcess || isQueued;
      var isFailed = item && item.status === "failed";
      var response = isFailed ? item.error != null ? item.error : item.response_body : item && item.response_body != null ? item.response_body : item && item.error;
      var isCompact = !!(item && item.compact);
      var userText = isCompact ? typeof item.request_text === "string" ? item.request_text : "" : extractLastUserTextFromRequest(requestBody);
      var assistantText = isPending ? "" : isCompact ? (typeof item.response_text === "string" ? item.response_text : "").trim() : (extractAssistantText(response) || "").trim() || "";
      var isErrorResponse = !isPending && (isFailed || !isCompact && isErrorResponseBody(response));
      var isStreamPending = canRecoverStreams && !isCompact && !isPending && !isCancelledItem && !isErrorResponse && !item._isBgTask && !item._isOnBgQueue && item.status === "resolved" && item.response_body == null && item.error == null && !assistantText;
      var reportedComplete = !!(item && item._isBgTask) && !isErrorResponse && (isCompact ? item.response_complete_marker === true : !!assistantText && assistantText.indexOf(INDEXING_COMPLETE_MARKER) !== -1);
      if (reportedComplete) assistantText = assistantText.split(INDEXING_COMPLETE_MARKER).join("").trim();
      var serverItemId = item && typeof item.id === "string" && item.id ? item.id : void 0;
      var createdTs = Number(item && item.created);
      var updatedTs = Number(item && item.updated);
      var userTs = isFinite(createdTs) && createdTs > 0 ? createdTs : isFinite(updatedTs) && updatedTs > 0 ? updatedTs : void 0;
      var replyTs = isFinite(updatedTs) && updatedTs > 0 ? updatedTs : isFinite(createdTs) && createdTs > 0 ? createdTs : void 0;
      if (userText) {
        var displayContent;
        var indexFile = void 0;
        if (item._isBgTask) {
          var ref = parseIndexingRequestText(userText);
          if (ref) {
            displayContent = opts.formatIndexingLabel(
              ref.name,
              ref.mime || "",
              typeof ref.size === "number" ? ref.size : null,
              ref.path,
              false,
              ref.continued
            );
            indexFile = ref;
          } else {
            displayContent = userText;
          }
        } else {
          displayContent = sanitizeAttachmentLinksForHistory(userText, opts.projectId);
        }
        var userMsg = { role: "user", content: displayContent };
        if (item._fromBgChain) userMsg._fromBgChain = true;
        if (isInProcess) userMsg.isPendingInProcess = true;
        if (isQueued) userMsg.isPendingQueued = true;
        if (isCancelledItem) userMsg.isCancelled = true;
        if (isCompact) userMsg._compact = true;
        if (item._isBgTask) userMsg.isBackgroundTask = true;
        if (indexFile) userMsg._indexFile = indexFile;
        if (item._isOnBgQueue) userMsg._useBgQueue = true;
        if (serverItemId !== void 0) userMsg._serverItemId = serverItemId;
        if (userTs !== void 0) userMsg._ts = userTs;
        mapped.push(userMsg);
      }
      if (isCancelledItem) ; else if (isInProcess) {
        var ph = { role: "assistant", content: "", isPending: true, isPendingInProcess: true };
        if (userTs !== void 0) ph._ts = userTs;
        if (item._fromBgChain) ph._fromBgChain = true;
        if (item._isBgTask) ph.isBackgroundTask = true;
        if (serverItemId !== void 0) {
          ph._serverItemId = serverItemId;
          runningItemIds.push(serverItemId);
        }
        mapped.push(ph);
      } else if (isQueued) ; else if (isErrorResponse) {
        var em = { role: "assistant", content: getErrorMessage(response), isError: true };
        if (item._fromBgChain) em._fromBgChain = true;
        if (item._isBgTask) em.isBackgroundTask = true;
        if (serverItemId !== void 0) em._serverItemId = serverItemId;
        if (replyTs !== void 0) em._ts = replyTs;
        mapped.push(em);
      } else if (isStreamPending) {
        var sp = { role: "assistant", content: "", _streamPending: true };
        if (serverItemId !== void 0) {
          sp._serverItemId = serverItemId;
          streamPendingItemIds.push(serverItemId);
        }
        if (replyTs !== void 0) sp._ts = replyTs;
        mapped.push(sp);
      } else if (assistantText || reportedComplete) {
        var okm = { role: "assistant", content: sanitizeAttachmentLinksForHistory(assistantText, opts.projectId, true) || EMPTY_INDEXING_REPLY };
        if (item._fromBgChain) okm._fromBgChain = true;
        if (item._isBgTask) okm.isBackgroundTask = true;
        if (isCompact) okm._compact = true;
        if (serverItemId !== void 0) okm._serverItemId = serverItemId;
        if (replyTs !== void 0) okm._ts = replyTs;
        if (reportedComplete) okm._indexComplete = true;
        mapped.push(okm);
      }
    });
    if (opts.projectId) {
      var ownerKey = chatCacheKey(opts.projectId, platform, opts.userId);
      for (var oi = 0; oi < mapped.length; oi++) mapped[oi]._ownerKey = ownerKey;
    }
    return { messages: mapped, runningItemIds, streamPendingItemIds };
  }
  function adoptLocalAnswerIntoPage(incoming, local) {
    if (!incoming || !local || !incoming._streamPending) return false;
    if (incoming.role !== "assistant" || local.role !== "assistant") return false;
    var hasText = typeof local.content === "string" && local.content.length > 0;
    var isLive = !!(local.isPending || local._streaming);
    if (!hasText && !isLive) return false;
    if (hasText) {
      incoming.content = local.content;
      incoming._streamPending = false;
    }
    if (local._localId !== void 0) incoming._localId = local._localId;
    if (local.isPending) incoming.isPending = true;
    if (local.isPendingInProcess) incoming.isPendingInProcess = true;
    if (local._streaming) incoming._streaming = true;
    return true;
  }
  function shouldRescueInFlightMessage(m, ctx) {
    if (!m) return false;
    if (m.isBackgroundTask) return false;
    if (m._ownerKey !== void 0 && ctx.loadKey !== void 0 && m._ownerKey !== ctx.loadKey) return false;
    if (m._serverItemId && ctx.hasServerId(m._serverItemId)) return false;
    if (m._stageId) return true;
    if (m._streaming && !m._serverItemId) return true;
    if (!m._serverItemId && ctx.pageHasPendingAssistant) return false;
    if (m.isSendingToServer || m.isPendingQueued || m.isPendingInProcess || m.isPending) return true;
    if (ctx.sending && m.role === "user") {
      var next = ctx.next;
      if (!next || next.isBackgroundTask || !next.isPending) return false;
      return next._serverItemId === void 0 || next._serverItemId === m._serverItemId;
    }
    return false;
  }

  // src/engine/scroll_anchor.ts
  var ROW_KEY_ATTR = "data-row-key";
  var ROW_POS_ATTR = "data-row-pos";
  var MAX_ALTS = 2;
  var ALT_SCAN_LIMIT = 64;
  var UNKNOWN_ROW_POS = "\0?";
  function createScrollAnchor(options) {
    var held = null;
    var seen = typeof WeakMap === "function" ? /* @__PURE__ */ new WeakMap() : null;
    function capture() {
      var box = options.getBox();
      if (!box || options.isStuck()) return null;
      var boxTop = box.getBoundingClientRect().top;
      var kids = box.children;
      var fallback = null;
      var fallbackAt = -1;
      var behind = [];
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (!el || typeof el.getAttribute !== "function") continue;
        var key = el.getAttribute(ROW_KEY_ATTR);
        if (!key) continue;
        var top = el.getBoundingClientRect().top - boxTop;
        if (top + el.offsetHeight <= 0) {
          var bpos = el.getAttribute(ROW_POS_ATTR);
          behind.push({
            key,
            top,
            pos: bpos === null ? null : bpos || UNKNOWN_ROW_POS,
            el
          });
          if (behind.length > MAX_ALTS) behind.shift();
          continue;
        }
        if (top >= box.clientHeight) break;
        var rawPos = el.getAttribute(ROW_POS_ATTR);
        var pos = rawPos === null ? null : rawPos || UNKNOWN_ROW_POS;
        var cand = {
          key,
          top,
          pos,
          scrollTop: box.scrollTop,
          scrollHeight: box.scrollHeight,
          el
        };
        if (rawPos === null) {
          cand.alts = withBehind(collectAlts(box, boxTop, i + 1), behind);
          return cand;
        }
        if (!fallback) {
          fallback = cand;
          fallbackAt = i;
        }
      }
      if (fallback) {
        fallback.alts = withBehind(
          collectAlts(box, boxTop, fallbackAt + 1, true) || collectAlts(box, boxTop, fallbackAt + 1),
          behind
        );
        return fallback;
      }
      return {
        key: null,
        top: 0,
        pos: null,
        scrollTop: box.scrollTop,
        scrollHeight: box.scrollHeight,
        el: null
      };
    }
    function collectAlts(box, boxTop, from, ordinaryOnly) {
      var out = [];
      var kids = box.children;
      var stop = Math.min(kids.length, from + ALT_SCAN_LIMIT);
      for (var i = from; i < stop && out.length < MAX_ALTS; i++) {
        var el = kids[i];
        if (!el || typeof el.getAttribute !== "function") continue;
        var key = el.getAttribute(ROW_KEY_ATTR);
        if (!key) continue;
        var rawPos = el.getAttribute(ROW_POS_ATTR);
        if (ordinaryOnly && rawPos !== null) continue;
        out.push({
          key,
          top: el.getBoundingClientRect().top - boxTop,
          pos: rawPos === null ? null : rawPos || UNKNOWN_ROW_POS,
          el
        });
      }
      return out.length ? out : void 0;
    }
    function withBehind(forward, behind) {
      var out = (forward || []).concat(behind.slice().reverse());
      return out.length ? out : void 0;
    }
    function findRow(box, anchor) {
      var el = anchor.el;
      if (el && el.parentNode === box) return el;
      if (!anchor.key) return null;
      var kids = box.children;
      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (!kid || typeof kid.getAttribute !== "function") continue;
        if (kid.getAttribute(ROW_KEY_ATTR) === anchor.key) return kid;
      }
      return null;
    }
    function restore(anchor) {
      var box = options.getBox();
      if (!box || !anchor || options.isStuck()) return;
      var el = findRow(box, anchor);
      if (el) {
        var livePos = el.getAttribute(ROW_POS_ATTR) || UNKNOWN_ROW_POS;
        if (anchor.pos !== null && anchor.pos !== UNKNOWN_ROW_POS && livePos !== UNKNOWN_ROW_POS && livePos !== anchor.pos) el = null;
      }
      if (el) {
        var boxTop = box.getBoundingClientRect().top;
        var delta = el.getBoundingClientRect().top - boxTop - anchor.top;
        var slack = Math.abs(box.scrollHeight - anchor.scrollHeight) + box.clientHeight;
        var moved = delta - (anchor.scrollTop - box.scrollTop);
        if (moved > slack || moved < -slack) {
          el = null;
        } else {
          if (delta >= 1 || delta <= -1) box.scrollTop += delta;
          held = {
            key: anchor.key,
            top: anchor.top,
            pos: anchor.pos,
            scrollTop: box.scrollTop,
            scrollHeight: box.scrollHeight,
            el,
            // Carried, not dropped: one successful restore used to disarm the
            // standbys for every later hold.
            alts: anchor.alts
          };
          return;
        }
      }
      var alts = anchor.alts;
      for (var ai = 0; alts && ai < alts.length; ai++) {
        var alt = alts[ai];
        var ael = findRow(box, {
          key: alt.key,
          top: alt.top,
          pos: alt.pos,
          scrollTop: anchor.scrollTop,
          scrollHeight: anchor.scrollHeight,
          el: alt.el
        });
        if (!ael) continue;
        if (alt.pos !== null && alt.pos !== UNKNOWN_ROW_POS) {
          var altLive = ael.getAttribute(ROW_POS_ATTR) || UNKNOWN_ROW_POS;
          if (altLive !== UNKNOWN_ROW_POS && altLive !== alt.pos) continue;
        }
        var aboxTop = box.getBoundingClientRect().top;
        var adelta = ael.getBoundingClientRect().top - aboxTop - alt.top;
        var aslack = Math.abs(box.scrollHeight - anchor.scrollHeight) + box.clientHeight;
        var amoved = adelta - (anchor.scrollTop - box.scrollTop);
        if (amoved > aslack || amoved < -aslack) continue;
        if (adelta >= 1 || adelta <= -1) box.scrollTop += adelta;
        held = {
          key: alt.key,
          top: alt.top,
          pos: alt.pos,
          scrollTop: box.scrollTop,
          scrollHeight: box.scrollHeight,
          el: ael,
          alts: alts.slice(ai + 1)
        };
        return;
      }
      lost(box, anchor);
    }
    function lost(box, anchor) {
      held = null;
      var grew = box.scrollHeight - anchor.scrollHeight;
      if (grew > 0) {
        box.scrollTop = anchor.scrollTop + grew;
        return;
      }
      if (options.rawFallback) box.scrollTop = anchor.scrollTop;
    }
    function preserve(mutate) {
      var anchor = capture();
      var result = mutate();
      restore(anchor);
      return result;
    }
    function remember() {
      held = capture();
    }
    function hold() {
      var box = options.getBox();
      if (!box || options.isStuck()) {
        held = null;
        return;
      }
      if (!held) {
        held = capture();
        return;
      }
      if (box.scrollTop !== held.scrollTop) {
        held = capture();
        return;
      }
      restore(held);
    }
    function absorb(el) {
      if (!el) return;
      var box = options.getBox();
      if (!box) return;
      var h = el.offsetHeight;
      var prev = seen ? seen.get(el) : void 0;
      if (seen) seen.set(el, h);
      if (options.isStuck()) return;
      if (prev === void 0) prev = 0;
      var delta = h - prev;
      if (delta === 0) return;
      if (el.getBoundingClientRect().top >= box.getBoundingClientRect().top) return;
      box.scrollTop += delta;
      if (held) held = capture();
    }
    function pinBottom() {
      var box = options.getBox();
      if (!box) return;
      box.scrollTop = box.scrollHeight;
    }
    function forget() {
      held = null;
    }
    return {
      capture,
      restore,
      preserve,
      remember,
      hold,
      pinBottom,
      absorb,
      forget
    };
  }

  // src/engine/viewport_fill.ts
  var HISTORY_FILL_SLACK_PX = 64;
  var MAX_HISTORY_FILL_PAGES = 24;
  var IDLE_WAIT_STEP_MS = 120;
  var IDLE_WAIT_MAX_MS = 15e3;
  async function waitForIdle(opts, stale) {
    var waited = 0;
    while (opts.isLoading()) {
      if (stale() || waited >= IDLE_WAIT_MAX_MS) return false;
      await new Promise(function(r) {
        setTimeout(r, IDLE_WAIT_STEP_MS);
      });
      waited += IDLE_WAIT_STEP_MS;
    }
    return !stale();
  }
  async function fillHistoryViewport(opts) {
    var maxPages = typeof opts.maxPages === "number" ? opts.maxPages : MAX_HISTORY_FILL_PAGES;
    var stale = function() {
      return !!(opts.isStale && opts.isStale());
    };
    var swallowed = 0;
    for (var page = 0; page < maxPages; page++) {
      if (stale() || opts.isEndOfList()) return;
      if (!await waitForIdle(opts, stale)) return;
      var satisfied = false;
      try {
        satisfied = !!await opts.isSatisfied();
      } catch {
        return;
      }
      if (satisfied || stale()) return;
      if (!await waitForIdle(opts, stale)) return;
      var before = opts.messageCount();
      var attempted;
      try {
        attempted = await opts.fetchOlder();
      } catch {
        return;
      }
      if (stale()) return;
      if (attempted === false) {
        if (++swallowed > 3) return;
        page--;
        continue;
      }
      if (opts.messageCount() <= before) return;
    }
  }
  function createHistoryFiller(base) {
    var pending = [];
    var running = false;
    var fetching = false;
    function announce(next) {
      if (fetching === next) return;
      fetching = next;
      if (!base.onRunningChange) return;
      try {
        base.onRunningChange(next);
      } catch (e) {
      }
    }
    async function allSatisfied() {
      var next = [];
      for (var i = 0; i < pending.length; i++) {
        if (!await pending[i]()) next.push(pending[i]);
      }
      pending = next;
      return pending.length === 0;
    }
    return {
      // The published fact, so a view and `isRunning()` can never disagree about
      // what they are showing. A fill that never fetches is not something anyone
      // outside this module has any use for knowing about.
      isRunning: function() {
        return fetching;
      },
      fill: function(isSatisfied) {
        pending.push(isSatisfied);
        if (running) return Promise.resolve();
        running = true;
        var done = function() {
          pending = [];
          running = false;
          announce(false);
        };
        return fillHistoryViewport({
          isSatisfied: allSatisfied,
          isEndOfList: base.isEndOfList,
          isLoading: base.isLoading,
          messageCount: base.messageCount,
          // The span opens HERE, at the first real page request: past
          // isEndOfList, past isStale, past isSatisfied. Everything before this
          // point is a fill that concluded there was nothing to do.
          fetchOlder: function() {
            announce(true);
            return base.fetchOlder();
          },
          isStale: base.isStale,
          maxPages: base.maxPages
        }).then(done, done);
      }
    };
  }

  // src/engine/session.ts
  var WORKER_PASS_ADOPT_LIMIT = 20;
  var LIVE_INDEX_SNAPSHOT_MAX_AGE_MS = 5e3;
  var INDEX_DISPATCH_CLAIM_MS = 2 * 60 * 1e3;
  var WORKER_PASS_ADOPT_ATTEMPTS = [0, 2e3, 6e3];
  var EARLY_PROBE_SCHEDULE_MS = [400, 900, 1700];
  var INDEXING_DRAIN_BUSY_POLL_MS = 8e3;
  var INDEXING_DRAIN_CONFIRM_POLL_MS = 3e3;
  var INDEXING_DRAIN_IDLE_LOOKS = 2;
  var INDEXING_DRAIN_MIN_MS = 8e3;
  var _bgHistoryBatchSeq = 0;
  var INDEXING_DRAIN_TIMEOUT_MS = 15 * 60 * 1e3;
  var INDEXING_DRAIN_LOOK_TIMEOUT_MS = 45e3;
  var INDEXING_DRAIN_NUDGE_MIN_GAP_MS = 1500;
  var _g = typeof globalThis !== "undefined" ? globalThis : {};
  function nowMs() {
    return _g.performance && typeof _g.performance.now === "function" ? _g.performance.now() : Date.now();
  }
  function nextFrame(cb) {
    if (typeof _g.requestAnimationFrame === "function") {
      _g.requestAnimationFrame(cb);
      return;
    }
    setTimeout(function() {
      cb(nowMs());
    }, 16);
  }
  function isPollStopped(res) {
    return !!res && typeof res === "object" && res.status === "stopped";
  }
  var LIVE_PENDING_LINK_WINDOW = 512;
  var STREAM_RECOVERY_PER_LOAD = 2;
  function liveSafePrefix(text) {
    if (!text) return "";
    var cut = text.length;
    var fenceAt = -1, fences = 0, from = 0, hit;
    for (; ; ) {
      hit = text.indexOf("```", from);
      if (hit === -1) break;
      fences++;
      fenceAt = hit;
      from = hit + 3;
    }
    if (fences % 2 === 1 && fenceAt !== -1) cut = fenceAt;
    var head = text.slice(0, cut);
    var lineStart = head.lastIndexOf("\n") + 1;
    var line = head.slice(lineStart);
    var open = line.lastIndexOf("[");
    if (open !== -1 && line.length - open <= LIVE_PENDING_LINK_WINDOW) {
      var rest = line.slice(open);
      var close = rest.indexOf("]");
      if (close === -1) {
        cut = lineStart + open;
      } else if (rest.charAt(close + 1) === "(" && rest.indexOf(")", close + 1) === -1) {
        cut = lineStart + open;
      }
    }
    var tokStart = line.length;
    while (tokStart > 0 && !/\s/.test(line.charAt(tokStart - 1))) tokStart--;
    var tok = line.slice(tokStart);
    if (tok && /^(?:https?:\/\/|src::)/i.test(tok)) {
      var tokCut = lineStart + tokStart;
      if (tokCut < cut) cut = tokCut;
    }
    if (line.indexOf("```") === -1) {
      var ticks = 0, lastTick = -1;
      for (var i = 0; i < line.length; i++) {
        if (line.charAt(i) === "`") {
          ticks++;
          lastTick = i;
        }
      }
      if (ticks % 2 === 1 && lastTick !== -1) {
        var tickCut = lineStart + lastTick;
        if (tickCut < cut) cut = tickCut;
      }
    }
    if (cut >= text.length) return text;
    if (cut < 0) cut = 0;
    return text.slice(0, cut);
  }
  function commonPrefixLength(a, b) {
    var n = Math.min(a.length, b.length), i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    if (i > 0) {
      var prev = a.charCodeAt(i - 1);
      if (prev >= 55296 && prev <= 56319) i--;
    }
    return i;
  }
  function typewriterResumeIndex(painted, fullText, regions) {
    if (!painted || !fullText) return 0;
    if (/^\s/.test(painted) && !/^\s/.test(fullText)) {
      painted = painted.replace(/^\s+/, "");
      if (!painted) return 0;
    }
    var i = commonPrefixLength(painted, fullText);
    if (i <= 0) return 0;
    if (i >= fullText.length) return fullText.length;
    for (var changed = true; changed; ) {
      changed = false;
      for (var k = 0; k < regions.length; k++) {
        var r = regions[k];
        if (i > r.start && i < r.end) {
          i = r.end;
          changed = true;
        }
      }
    }
    return i > fullText.length ? fullText.length : i;
  }
  function mayKeepStreamedAnswer(snap, rowStatus) {
    if (rowStatus !== void 0 && rowStatus !== null && rowStatus !== "" && rowStatus !== "resolved") return false;
    if (!snap || typeof snap !== "object") return false;
    if (snap.errored) return false;
    if (snap.answerComplete) return true;
    if (snap.unframed) return true;
    return false;
  }
  function streamRecoveryPhase(msg) {
    if (!msg || !msg._streamPending || msg.content || !msg._serverItemId) return "";
    if (msg._streamRecovery === "active") return "active";
    if (msg._streamRecovery === "failed") return "failed";
    return "idle";
  }
  function streamRecoveryLabels(phase) {
    if (phase === "failed") {
      return { note: "Could not load this answer.", action: "Try again" };
    }
    return { note: "This answer was not saved with the conversation.", action: "Load answer" };
  }
  var LIVE_PAINT_MIN_MS = 250;
  var LIVE_TYPE_MAX_STEP = 1200;
  var ChatSession = class {
    constructor(host) {
      // --- live streaming ----------------------------------------------------
      //
      // A streamed turn's answer NEVER reaches the polling row: the relay appends the
      // destination's raw bytes to a chunk table and the row settles with a status and
      // nothing else. So for a streamed turn this parser is not a nicety that makes the
      // wait prettier, it is the only place the answer exists until csr-finalize stores
      // one. Three things follow, and all three are load-bearing:
      //
      //   1. EVERY foreground poll gets a sink while streaming is on, not just the one
      //      the dispatch attaches. A tab return, a reload, a resumePolling all
      //      re-attach a poll to a still-running item, and skapi's reader sends
      //      `since: 0` on its first tick, so a fresh sink REPLAYS the whole stream from
      //      the beginning. Attaching without one settles that turn on an envelope and
      //      the user's answer is gone.
      //   2. The parser is keyed by SERVER ITEM ID, and so is the bubble it paints into.
      //      A history refetch replaces the local pending bubble with the server's copy
      //      of the same turn; that copy carries the same _serverItemId, so the next
      //      paint finds it and carries on. Nothing has to be rescued and nothing can be
      //      painted twice.
      //   3. The stream is never the source of truth. At settle the parser's ASSEMBLED
      //      body (byte equivalent to what a buffered call returns) goes through the
      //      same extractClaudeText / extractOpenAIText the buffered path uses, and a
      //      row that does hold a stored body wins outright.
      //
      // Background polls never get a sink, and that is safe because nothing on the bg
      // queue ever streams: an indexing pass must not (the worker READS its reply), and
      // a chat turn sent with attachments is deliberately left buffered for exactly the
      // reason point 1 gives, since the re-attach loop would poll it as a background
      // item and hand it no reader. See chatStreamWiring. A sink there would also spend
      // the request budget MAX_CONCURRENT_BG_POLLS exists to protect.
      /** Live streams by server item id. One per in-flight streamed turn. */
      this.liveStreams = {};
      // ─── compact-stub hydration ─────────────────────────────────────────────
      // Split-fetch bg pages arrive as label stubs (no bodies). When the user
      // expands a row, the real reply text is fetched per item (csr-poll point
      // lookup) and MEMOIZED per chat: every later remap (first-page refresh,
      // queue-detect tick, cache restore) re-applies the memo, so a hydrated
      // bubble can never silently revert to its 200-char head.
      this._hydratedBodies = {};
      this._hydratingItems = {};
      this.typewriterQueue = Promise.resolve();
      /**
       * Pick up indexing passes the WORKER minted, which no client ever dispatched.
       *
       * For a PDF (and for text/grid when windowed indexing is on) the worker writes
       * pass N+1's row itself, inside pass N's invocation, right after saving pass
       * N's result. That row reaches this client through nothing at all: it is not in
       * bgTaskQueue (the client never asked for it) and it is not in state.messages
       * (only a first-page history load maps it in, which happens on mount, project
       * switch or tab return). So between two worker passes every pass the client
       * knows about is settled, and the collapsed row renders "Indexed  N passes"
       * with no spinner and no Stop, for a file that is still being read. A user who
       * believes that then asks questions against a half-indexed file — which is what
       * this exists to prevent.
       *
       * So when a background indexing pass settles, ask the bg queue what is still
       * unresolved on it and adopt anything unknown as an ordinary BgTaskEntry.
       * drainBgTaskQueue then treats it exactly like a pass this client dispatched:
       * same bubble, same `_indexFile` (so it joins the file's collapsed row), same
       * poll — and that poll settling runs this again, so the chain is followed to
       * its end. `status`-scoped so the reply carries the live items only, never a
       * page of finished ones with their bodies.
       *
       * Termination: the only trigger is a pass SETTLING, which happens once per
       * pass. An adopted item that is still running is not re-adopted (its id is
       * already polled), and when the queue holds nothing unknown the chain stops on
       * its own. Nothing here is periodic — a timer that re-reads history is the
       * shape that previously looped fetchHistoryPage after an already-DONE index.
       */
      this._adoptingWorkerPasses = false;
      this.host = host;
      this.state = {
        messages: [],
        attachments: [],
        uploadingAttachments: false,
        sending: false,
        typing: false,
        typingAbort: false,
        loadingHistory: false,
        loadingOlderHistory: false,
        // A deferred bg stub batch (first-paint split) is still in flight; the
        // views show a small 'loading indexing history' hint while true.
        bgHistoryLoading: false,
        historyEndOfList: false,
        historyStartKeyHistory: [],
        historyRequestToken: 0,
        gateRefreshToken: 0,
        liveIndexKeys: {},
        liveIndexChecked: false,
        stoppedIndexIds: {}
      };
      this.bgTaskQueue = [];
      this.cancelledServerIds = /* @__PURE__ */ new Set();
      this.cancelledIndexKeys = /* @__PURE__ */ new Set();
      this.pendingAgentRequests = {};
      this.aiChatHistoryCache = {};
      this.historyItemPolls = /* @__PURE__ */ new Map();
      this._pauseReasons = /* @__PURE__ */ new Set();
      this._resuming = false;
      this._lidSeq = 0;
      this._stageSeq = 0;
      this._uploadBatches = 0;
      this._indexDispatchesInFlight = 0;
      this._drainNudges = [];
      this._liveStages = {};
      this._liveIndexKey = "";
      this._liveIndexAt = 0;
      this._indexClaims = {};
    }
    /** What the display layer needs to decide whether a run is finished. `keys` holds
     *  every file the server still has indexing work for; `checked` is false until the
     *  first answer for this chat, and false means "we do not know yet". */
    getLiveIndexState() {
      return { keys: this.state.liveIndexKeys, checked: this.state.liveIndexChecked };
    }
    /** Passes that were on a row when the user stopped it, so the display layer can
     *  still tell that this run was stopped once the stop has left no other trace.
     *  See cancelIndexingGroup, which fills it, and buildChatDisplayList, which is
     *  the only reader. */
    getStoppedIndexIds() {
      return this.state.stoppedIndexIds;
    }
    /**
     * Is this file ALREADY being indexed by this client?
     *
     * One live run per file, and the reason is what a second one looks like: the
     * conversation grows a SECOND collapsed row for the same file (a run is opened
     * by every FIRST pass, so two of them are two rows), the same document is read
     * twice at full provider cost, and the two chains fight over the same records —
     * the delete-then-repost that starts run 2 wipes what run 1 has saved so far.
     *
     * Asked of this client's own live work, so it cannot be wrong in the dangerous
     * direction: a queued/running pass keeps its bgTaskQueue entry until its bubble
     * settles, and a settled run answers false, which is what a genuine later
     * re-index needs.
     *
     * The retry that made this necessary: a chip whose INDEX request failed is
     * handed back to the composer to be retried on the next send, and an index
     * request can fail from the client's side (a lost ack, an expired token on the
     * response) while the server has already queued the pass. The retry then indexes
     * a file that was never not being indexed.
     */
    hasLiveIndexRun(storagePath) {
      if (!storagePath) return false;
      var claimed = this._indexClaims[this._indexClaimKey(storagePath)];
      if (claimed && nowMs() - claimed < INDEX_DISPATCH_CLAIM_MS) return true;
      var id = this.host.getIdentity();
      for (var i = 0; i < this.bgTaskQueue.length; i++) {
        var e = this.bgTaskQueue[i];
        if (e && e.storagePath === storagePath && e.projectId === id.projectId && e.platform === id.platform) return true;
      }
      return this.state.messages.some(function(m) {
        if (!m.isBackgroundTask || m.role !== "user" || m.isCancelled) return false;
        if (!(m.isPendingQueued || m.isPendingInProcess || m.isSendingToServer)) return false;
        return !!m._indexFile && m._indexFile.path === storagePath;
      });
    }
    /** Storage paths are project-relative, and one ChatSession serves every
     *  project, so a claim has to be scoped the way a stop is (_indexKeyOf). */
    _indexClaimKey(storagePath) {
      var id = this.host.getIdentity();
      return indexScopeKey(id.projectId, id.platform) + "|" + storagePath;
    }
    /**
     * Take this file's indexing slot, or report that someone already has it.
     *
     * The check-and-CLAIM is what makes it safe against a second caller arriving
     * mid-flight: the claim is written SYNCHRONOUSLY, before the first await, so a
     * concurrent caller sees it even though no request has completed and no queue
     * has admitted anything. Ask-then-dispatch could not do that — every source it
     * consults only learns about a dispatch after the ack.
     *
     * Returns true when the caller owns the slot and should dispatch. A caller that
     * then fails to dispatch MUST releaseIndexRun, or the file waits out the claim
     * (a few minutes) before it can be retried.
     */
    claimIndexRun(storagePath) {
      var self = this;
      if (!storagePath) return Promise.resolve(true);
      if (this.hasLiveIndexRun(storagePath)) return Promise.resolve(false);
      this._indexClaims[this._indexClaimKey(storagePath)] = nowMs();
      return this._refreshLiveIndexKeys(LIVE_INDEX_SNAPSHOT_MAX_AGE_MS).then(function() {
        if (!self.state.liveIndexKeys[storagePath]) return true;
        self.releaseIndexRun(storagePath);
        return false;
      }).catch(function() {
        return true;
      });
    }
    /** Give the slot back — the dispatch failed, or was abandoned. */
    releaseIndexRun(storagePath) {
      if (storagePath) delete this._indexClaims[this._indexClaimKey(storagePath)];
    }
    /**
     * The same question, asked of the SERVER when this page cannot answer it.
     *
     * hasLiveIndexRun only knows what this page did. That is not enough for the
     * case duplicates actually come from: the first run was started before a
     * reload, or in another tab, or its bubble has since been paged out of the
     * loaded window — and then the retry finds nothing locally and starts a second
     * run of a file that is still being indexed. The queue is the one place that
     * knows, and it is already asked for exactly this list.
     *
     * Only a POSITIVE answer is used. Absence proves nothing here (the query is
     * capped, and `liveIndexChecked` records that), so an unanswerable question
     * falls back to dispatching — the cost of a wrong "no" is the duplicate this
     * exists to prevent, and the cost of a wrong "yes" is a file that never gets
     * indexed at all. Only one of those is recoverable by the user.
     */
    isIndexRunLive(storagePath) {
      var self = this;
      if (!storagePath) return Promise.resolve(false);
      if (this.hasLiveIndexRun(storagePath)) return Promise.resolve(true);
      return this._refreshLiveIndexKeys(LIVE_INDEX_SNAPSHOT_MAX_AGE_MS).then(function() {
        return !!self.state.liveIndexKeys[storagePath];
      }).catch(function() {
        return false;
      });
    }
    /** Re-ask the queue which files are still being indexed, unless the answer we
     *  have is younger than `maxAgeMs`. Shared by every caller that needs a current
     *  one; the display layer's own refresh path is the adopt ladder. */
    _refreshLiveIndexKeys(maxAgeMs) {
      var self = this;
      var id = this.host.getIdentity();
      var platform = id.platform;
      if (!id.projectId || platform !== "claude" && platform !== "openai") return Promise.resolve();
      var askedKey = this.getHistoryCacheKey();
      if (this._liveIndexKey === askedKey && nowMs() - this._liveIndexAt < maxAgeMs) {
        return Promise.resolve();
      }
      var queue = bgIndexingQueueName(id.userId, id.projectId);
      var ask = function(status) {
        return Promise.resolve(probeBgQueue(
          { service: id.projectId, owner: id.owner, platform, queue, status, limit: WORKER_PASS_ADOPT_LIMIT },
          { maxAgeMs: BG_PROBE_TTL_MS }
        )).then(function(entry2) {
          return entry2.result;
        }).catch(function() {
          return null;
        });
      };
      return Promise.all([ask("pending"), ask("running")]).then(function(results) {
        if (results[0] === null || results[1] === null) return;
        if (self.getHistoryCacheKey() !== askedKey) return;
        self._liveIndexKey = askedKey;
        self._recordLiveIndexKeys(results);
      });
    }
    /**
     * Replace the live-index snapshot from a queue query's raw items.
     *
     * Whole-snapshot, never incremental: the query returns everything unresolved on
     * the queue, so a file MISSING from it is precisely the fact we are after. Merging
     * would make a finished file impossible to observe.
     */
    _recordLiveIndexKeys(lists) {
      var next = {};
      var truncated = false;
      var settledIds = {};
      this.state.messages.forEach(function(m) {
        if (!m._serverItemId) return;
        if (m.isPending || m.isPendingInProcess || m.isPendingQueued) return;
        settledIds[m._serverItemId] = true;
      });
      for (var li = 0; li < lists.length; li++) {
        var list = lists[li] && Array.isArray(lists[li].list) ? lists[li].list : [];
        if (list.length >= WORKER_PASS_ADOPT_LIMIT) truncated = true;
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (!item || item.status !== "pending" && item.status !== "running") continue;
          if (item.id && settledIds[item.id]) continue;
          var text = extractLastUserTextFromRequest(item.request_body);
          if (!isIndexingRequestText(text)) continue;
          var ref = parseIndexingRequestText(text);
          if (!ref) continue;
          if (ref.path) next[ref.path] = true;
          if (ref.name) next[ref.name] = true;
        }
      }
      var nowChecked = !truncated;
      var was = this.state.liveIndexKeys, changed = this.state.liveIndexChecked !== nowChecked;
      if (!changed) {
        for (var k in next) if (!was[k]) {
          changed = true;
          break;
        }
        if (!changed) {
          for (var k2 in was) if (!next[k2]) {
            changed = true;
            break;
          }
        }
      }
      this.state.liveIndexKeys = next;
      this.state.liveIndexChecked = nowChecked;
      this._liveIndexAt = nowMs();
      this._liveIndexKey = this.getHistoryCacheKey();
      if (changed) this.host.notify();
    }
    /** Forget the snapshot: it describes ONE chat's queue, and the answer for the
     *  project the user just switched to is unknown until it is asked for again. */
    _resetLiveIndexKeys() {
      this.state.liveIndexKeys = {};
      this.state.liveIndexChecked = false;
      this._liveIndexAt = 0;
    }
    /**
     * Ask the queue what is still indexing, once, for the chat that is on screen.
     *
     * Seeds the snapshot on a history load. Without it a reloaded chat has no way to
     * learn that a run it can see is over: the adopt ladder that normally answers this
     * only fires when a pass SETTLES, and after a reload there is no pass left to
     * settle — so every finished worker-driven row would spin forever.
     *
     * Best-effort: a failure leaves `checked` false, which reads as "still working"
     * rather than as a false all-clear.
     *
     * Delegates to the adopt ladder rather than asking once. A single empty look is
     * exactly what that ladder exists to distrust — the worker writes pass N+1 a few
     * milliseconds AFTER flipping pass N to resolved, so a query landing in that gap
     * sees an empty queue for a chain that is very much alive. One look would turn
     * that into a confident "Indexed" with a green check, on the one scenario this
     * whole feature is for, and nothing would ever re-ask: the ladder is normally
     * triggered by a pass SETTLING, and after a reload there is no pass left to
     * settle. The ladder re-asks at 0/2s/6s, records each answer, and as a bonus
     * adopts and polls any live pass it finds, which makes the row genuinely active
     * instead of merely unconfirmed.
     */
    refreshLiveIndexState() {
      this._adoptWorkerIndexingPasses(0, true);
    }
    /** Forget what we know about which files are indexing — but ONLY when the
     *  snapshot was taken for a different chat than the one on screen now. For a
     *  consumer whose history loading is its own fork and so never reaches
     *  loadHistory's reset — a snapshot describes ONE chat's queue, and carrying it
     *  into another project would let a row there claim to be finished on someone
     *  else's evidence.
     *
     *  Conditional for the same reason loadHistory's own reset is (the
     *  `loadKey !== _liveIndexKey` gate): the view calls this on every mount, and
     *  an unconditional wipe turned every re-entry to the chat into a grey
     *  "Checking status:" sweep across rows whose state was already known. A
     *  RE-entry keeps showing the last answer (green/yellow) while the first-page
     *  refresh re-asks quietly; only a genuine project/platform switch starts from
     *  "not known yet". Claiming `_liveIndexKey` here (before any answer) is the
     *  same fudge loadHistory makes: it marks WHOSE chat the empty snapshot is
     *  for, so repeated calls do not re-wipe, and _recordLiveIndexKeys re-claims
     *  it when the real answer lands. */
    resetLiveIndexState() {
      var key = this.getHistoryCacheKey();
      if (key === this._liveIndexKey) return;
      this._liveIndexKey = key;
      this._resetLiveIndexKeys();
    }
    /** Wrap an indexing-request dispatch so awaitIndexingDrained counts it as
     *  live work from the moment it is sent, not from the moment it is acked. */
    trackIndexDispatch(p) {
      var self = this;
      this._indexDispatchesInFlight += 1;
      var release = function() {
        self._indexDispatchesInFlight = Math.max(0, self._indexDispatchesInFlight - 1);
      };
      return p.then(function(v) {
        release();
        return v;
      }, function(e) {
        release();
        throw e;
      });
    }
    /**
     * Something just happened that plausibly ENDED indexing work, so let any waiting
     * turn look now instead of sitting out the rest of its busy interval.
     *
     * A nudge changes only WHEN a look happens, never what it concludes: the two
     * agreeing idle looks, the confirm gap between them, "a failed look counts as
     * busy" and the minimum wait are all untouched. That is why it is safe to fire
     * from places that are merely good guesses.
     *
     * Fired from end-of-chain points ONLY: the adopt ladder giving up, a resume
     * declining to continue, a pass failing. Not from every settling pass (one nudge
     * per pass per file for the whole run), and not from an indexing request being
     * accepted — see the note in trackIndexDispatch for why that one is actively
     * harmful rather than merely wasteful.
     */
    _nudgeIndexingDrain() {
      if (!this._drainNudges.length) return;
      var list = this._drainNudges.slice();
      for (var i = 0; i < list.length; i++) {
        try {
          list[i]();
        } catch (e) {
        }
      }
    }
    /**
     * Register a live poll so (a) a remount dedupes against it instead of stacking a
     * SECOND poll on the same item, and (b) pausePolling can stop it.
     *
     * `stop` comes from the SDK and may be absent on an older skapi-js, in which case the
     * poll simply cannot be stopped and is left running — see pausePolling.
     *
     * (This block documents _trackPoll, further down. The two methods below sit between it
     * and its subject.)
     */
    /**
     * Foreground poll with an early-probe race.
     *
     * skapi's poll() is a bare setInterval(fn, latency) with NO check at t=0, so the earliest a
     * reply can be observed is one full POLL_INTERVAL (3s) after dispatch. For a long generation
     * that granularity is free. For a SHORT one it is nearly pure dead time: a greeting that the
     * provider finishes in 1s still waits until the 3s tick, which measured as a large share of a
     * 5s "yo" round trip.
     *
     * So keep the 3s interval as the steady state, and additionally point-look-up the item a few
     * times early, on a widening schedule. Whichever answers first wins and the other is stopped.
     * The probe uses the csrHistoryItemLookup hook both clients already implement; without it this
     * degrades to exactly the old behaviour.
     *
     * FOREGROUND ONLY. Background indexing polls keep the flat cadence: nobody is watching them,
     * and they are the ones bounded by MAX_CONCURRENT_BG_POLLS, so adding probes there would spend
     * the request budget the cap exists to protect.
     */
    attachForegroundPoll(source, itemId, opts, ctx) {
      return this._fgPollWithEarlyProbe(source, itemId, opts, ctx);
    }
    _fgPollWithEarlyProbe(source, itemId, opts, ctx) {
      var self = this;
      var live = this._beginLiveStream(itemId, ctx);
      if (live) {
        var inner = opts || {};
        var callerResponse = typeof inner.onResponse === "function" ? inner.onResponse : null;
        var callerError = typeof inner.onError === "function" ? inner.onError : null;
        var streamOpts = Object.assign({}, inner, {
          onStream: function(chunk, _seq, via) {
            self._feedLiveStream(live, chunk, via);
          },
          onResponse: function(res) {
            var effective = res;
            if (isPollStopped(res)) self._closeLiveStream(live, false);
            else effective = self._settleLiveStream(live, res);
            if (callerResponse) callerResponse(effective);
          },
          onError: function(err) {
            self._closeLiveStream(live, false);
            if (callerError) callerError(err);
          }
        });
        var lp = source.poll(Object.assign({ latency: STREAM_POLL_INTERVAL }, streamOpts));
        var stopLp = lp && typeof lp.stop === "function" ? lp.stop.bind(lp) : null;
        var wrapped = Promise.resolve(lp).then(function(res) {
          if (isPollStopped(res)) {
            self._closeLiveStream(live, false);
            return res;
          }
          return self._settleLiveStream(live, res);
        }, function(err) {
          self._closeLiveStream(live, false);
          throw err;
        });
        wrapped.stop = function() {
          self._closeLiveStream(live, false);
          if (stopLp) stopLp();
        };
        return wrapped;
      }
      var base = source.poll(Object.assign({ latency: POLL_INTERVAL }, opts || {}));
      var lookup = chatEngineConfig().csrHistoryItemLookup;
      var ident = this.host.getIdentity();
      var platform = ident && ident.platform;
      if (!lookup || !itemId || !ident || !ident.projectId || platform !== "claude" && platform !== "openai") {
        return base;
      }
      var settled = false;
      var timers = [];
      var clearProbes = function() {
        for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
        timers = [];
      };
      var stopBase = base && typeof base.stop === "function" ? base.stop.bind(base) : null;
      var raced = new Promise(function(resolve, reject) {
        base.then(function(res) {
          if (settled) return;
          settled = true;
          clearProbes();
          resolve(res);
        }, function(err) {
          if (settled) return;
          settled = true;
          clearProbes();
          reject(err);
        });
        var fullId = buildHistoryItemFullId(platform, ident.projectId, itemId);
        EARLY_PROBE_SCHEDULE_MS.forEach(function(delay) {
          timers.push(setTimeout(function() {
            if (settled) return;
            Promise.resolve(lookup(fullId, ident.projectId, ident.owner)).then(function(body) {
              if (settled || !body || typeof body !== "object") return;
              if (body.status === "pending" || body.status === "running") return;
              if (isPollStopped(body)) return;
              settled = true;
              clearProbes();
              if (stopBase) {
                try {
                  stopBase();
                } catch (e) {
                }
              }
              if (opts && typeof opts.onResponse === "function") {
                try {
                  opts.onResponse(body);
                } catch (e) {
                }
              }
              resolve(body);
            }, function() {
            });
          }, delay));
        });
      });
      raced.stop = function() {
        settled = true;
        clearProbes();
        if (stopBase) stopBase();
      };
      return raced;
    }
    _trackPoll(id, kind, p) {
      var stop = p && typeof p.stop === "function" ? p.stop.bind(p) : void 0;
      if (!stop) {
        console.debug("[chat-engine] poll has no stop handle", { id, kind });
      }
      this.historyItemPolls.set(id, { kind, stop });
      return p;
    }
    /** Background polls currently attached, for the MAX_CONCURRENT_BG_POLLS budget.
     *  Counts the registry rather than a separate tally so it cannot drift: every
     *  attach goes through _trackPoll and every detach deletes the entry. Note an
     *  entry left behind by pausePolling on an older skapi-js (no stop handle)
     *  still counts, which is correct — that poll really is still running. */
    _countBgPolls() {
      var n = 0;
      this.historyItemPolls.forEach(function(handle) {
        if (handle && handle.kind === "bg") n++;
      });
      return n;
    }
    /**
     * Open (or re-open) the live stream for `itemId`, or null when this poll must
     * not carry one.
     *
     * Re-entrant on purpose: an auth-refresh retry re-dispatches the SAME turn under
     * a NEW id, and a re-attach after a tab return replays an existing id from seq 0.
     * Either way the bytes about to arrive are a whole stream, so an existing entry
     * is discarded and a fresh parser takes its place - feeding a replay into the old
     * parser would concatenate the answer with itself.
     *
     * `ctx` IS THE TURN'S OWN IDENTITY, and every caller that has one passes it.
     * This used to read the LIVE getIdentity(), which is a bug of exactly the kind
     * _callProviderFor documents and threads its own parameters to avoid: the user
     * hits Send, then switches project or platform inside the ack round trip, and the
     * stream that opens for the OLD turn is stamped with the NEW identity. What that
     * costs is not cosmetic - `platform` picks which url csr-finalize is addressed
     * with and which extractor reads the assembled body, `projectId`/`owner` scope
     * the finalize itself, and `ownerKey` decides which chat the answer is painted
     * into. Get them from the live read at the wrong moment and the turn is finalized
     * against the wrong service (so its answer is never stored), parsed with the
     * wrong provider's extractor, or painted into a conversation it does not belong
     * to. The live read stays only as the fallback for a caller with nothing pinned.
     */
    _beginLiveStream(itemId, ctx) {
      if (!liveStreamingEnabled()) return null;
      if (!itemId) {
        console.warn("[chat-engine] live streaming is on but the dispatch reported no item id");
        return null;
      }
      var pinnedPlatform = ctx && (ctx.platform === "claude" || ctx.platform === "openai") ? ctx.platform : void 0;
      var ident = pinnedPlatform && ctx && ctx.projectId !== void 0 && ctx.owner !== void 0 && ctx.ownerKey !== void 0 ? null : this.host.getIdentity();
      var platform = pinnedPlatform || (ident ? ident.platform : void 0);
      if (platform !== "claude" && platform !== "openai") return null;
      var projectId = ctx && ctx.projectId !== void 0 ? ctx.projectId : ident ? ident.projectId : "";
      var owner = ctx && ctx.owner !== void 0 ? ctx.owner : ident ? ident.owner : "";
      var ownerKey = ctx && ctx.ownerKey !== void 0 ? ctx.ownerKey : this.getHistoryCacheKey();
      var prev = this.liveStreams[itemId];
      if (prev) this._closeLiveStream(prev, false);
      var st = {
        id: itemId,
        ownerKey,
        platform,
        projectId,
        owner,
        parser: createSseParser(),
        painted: "",
        started: false,
        fed: false,
        ended: false,
        timer: null,
        lastPaintAt: 0,
        finalBody: null,
        transport: { socket: 0, poll: 0 }
      };
      this.liveStreams[itemId] = st;
      return st;
    }
    /** The chunk sink handed to skapi's poll. Raw relayed text, in order, never parsed
     *  here: the parser owns the grammar and this owns the pacing. */
    _feedLiveStream(st, chunk, via) {
      if (st.ended || typeof chunk !== "string" || !chunk) return;
      st.fed = true;
      if (via === "socket") st.transport.socket++;
      else if (via === "poll") st.transport.poll++;
      st.parser.feed(chunk);
      if (st.timer) return;
      var self = this;
      var wait = st.lastPaintAt ? Math.max(0, LIVE_PAINT_MIN_MS - (nowMs() - st.lastPaintAt)) : 0;
      st.timer = setTimeout(function() {
        st.timer = null;
        self._paintLiveStream(st);
      }, wait);
    }
    /**
     * Write the safe prefix of the answer so far into the turn's bubble.
     *
     * notify() is spent EXACTLY ONCE per turn, on the first paint, because that is a
     * state change the per-bubble refresh cannot express: the bubble stops being a
     * "Thinking..." spinner and becomes text. Every paint after it goes through
     * refreshMessageBubble, which is what keeps a growing answer from rebuilding the
     * whole display list once a second.
     */
    _paintLiveStream(st) {
      if (st.ended) return;
      st.lastPaintAt = nowMs();
      if (this.getHistoryCacheKey() !== st.ownerKey) return;
      var idx = this._liveTargetIndex(st.id);
      if (idx === -1) return;
      var msg = this.state.messages[idx];
      if (!msg) return;
      var snap = st.parser.snapshot();
      var next = liveSafePrefix(snap.text);
      if (next.length <= st.painted.length) return;
      var prev = st.painted;
      st.painted = next;
      var grew = next.length - prev.length;
      var animate = grew > 0 && grew <= LIVE_TYPE_MAX_STEP;
      if (animate) {
        if (!msg._localId) msg._localId = this._newLocalId();
        if (!msg._streaming) {
          msg._streaming = true;
          this.host.notify();
        }
        this.enqueueTypewrite(idx, next, msg._localId, prev);
      } else {
        msg.content = next;
        if (!msg._streaming) {
          msg._streaming = true;
          this.host.notify();
        } else this.host.refreshMessageBubble(idx);
      }
      this.host.scrollToBottomIfSticky();
      this._reportLiveStream(st, st.started ? "update" : "start", snap, next);
      st.started = true;
    }
    /** The bubble a live stream paints into: the turn's pending assistant placeholder,
     *  found by server item id. Not by _localId, deliberately - a history refetch
     *  replaces the local copy with the server's, and only the id survives that. */
    _liveTargetIndex(itemId) {
      return this.state.messages.findIndex(function(m) {
        return !!m && m.role === "assistant" && !m.isBackgroundTask && m._serverItemId === itemId && (!!m.isPending || !!m._streaming);
      });
    }
    /** Hand the host its optional observation update. Guarded: this runs on the paint
     *  path, and a throwing hook must not cost the user the rest of their answer. */
    _reportLiveStream(st, phase, snap, text) {
      var hook = chatEngineConfig().onLiveStreamUpdate;
      if (!hook) return;
      try {
        hook({
          serverItemId: st.id,
          ownerKey: st.ownerKey,
          phase,
          text,
          thinkingText: snap && snap.thinkingText || "",
          toolNames: snap && snap.toolNames ? snap.toolNames.slice() : [],
          complete: !!(snap && snap.complete),
          // Reported alongside `complete`, never instead of it: a host drawing
          // "still arriving" wants complete, a host drawing "this answer is
          // partial" wants this one, and an `error` frame is the case where the
          // two disagree. See sse.ts answerComplete.
          answerComplete: !!(snap && snap.answerComplete),
          errored: !!(snap && snap.errored),
          transport: { socket: st.transport.socket, poll: st.transport.poll }
        });
      } catch (e) {
        console.warn("[chat-engine] onLiveStreamUpdate threw", e);
      }
    }
    /** Stop painting and (when the turn really ended) assemble the body. `finished`
     *  is false for a stream being discarded rather than settled: a retry replacing
     *  it, or a stop, neither of which has an answer to assemble. */
    _closeLiveStream(st, finished) {
      var first = !st.ended;
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      if (first) {
        st.ended = true;
        if (finished && st.fed) {
          st.parser.end();
          st.finalBody = st.parser.finalBody();
        }
      }
      if (this.liveStreams[st.id] === st) delete this.liveStreams[st.id];
      if (first && st.started) this._reportLiveStream(st, "end", st.parser.snapshot(), "");
      if (this.getHistoryCacheKey() !== st.ownerKey) return;
      var idx = this._liveTargetIndex(st.id);
      if (idx !== -1 && this.state.messages[idx] && this.state.messages[idx]._streaming) {
        this.state.messages[idx]._streaming = false;
      }
    }
    /**
     * Settle a streamed turn: end the parse, decide the body the rest of the session
     * will read, and release the chunks.
     *
     * The substitution is one-directional and never a merge. A response that is a
     * real stored body (a buffered turn, or a streamed one somebody already
     * finalized) is returned untouched, because that is the destination's own answer
     * and the stream is not entitled to overwrite it. Only a STATUS ENVELOPE - the
     * shape a streamed row settles as, having stored nothing - is replaced, and then
     * by the assembled body, which every caller downstream reads with the same
     * extractor it uses for a buffered reply. Idempotent, because it is reached both
     * through the poll's onResponse and through the promise it resolves.
     */
    _settleLiveStream(st, response) {
      this._closeLiveStream(st, true);
      if (!isCsrStatusEnvelope(response)) return response;
      if (response.status !== "resolved") return response;
      if (!this._mayFinalize(st)) this._rec().incomplete[st.id] = true;
      if (st.finalBody == null) return response;
      this._finalizeStreamedTurn(st);
      return st.finalBody;
    }
    /**
     * May this parse be STORED as the turn's permanent answer?
     *
     * THE FAILURE THIS PREVENTS. Finalizing does two things at once: it stores what
     * you give it as the row's result, and it DELETES the chunks it was assembled
     * from. So finalizing a truncated parse is not a cosmetic loss, it is the
     * permanent one: the truncation becomes the stored answer and the only copy of
     * the missing part is deleted in the same call. And a truncated parse is a shape
     * this repo has already paid for - a degraded chunk read (the poller degrades to
     * "no chunks this tick, more=true" on any transient chunk-table error, and caps
     * a long answer at 500k characters per response) can hand the settle a stream
     * that stopped mid-answer. The row can settle 'resolved' on top of that, because
     * the ROW's status describes the destination's request, not the client's read of
     * it.
     *
     * THE POLICY ITSELF IS mayKeepStreamedAnswer (top of this file), shared with the
     * recovery path so the two cannot drift apart again - they did, and the drift was
     * silent: the live settle refused a failed turn while the recovery finalized one.
     * What is local to this method is only the two things the free function cannot
     * know: that there is an assembled body at all, and that this call site is
     * reached only on a row that settled 'resolved' (the caller returns before it
     * otherwise), which is the status it therefore states.
     *
     * The test the policy applies is deliberately NOT `complete`: a terminal event
     * arrived and the answer finished are two claims, and an `error` frame satisfies
     * the first while truncating the second. See sse.ts's answerComplete.
     */
    _mayFinalize(st) {
      if (st.finalBody == null) return false;
      return mayKeepStreamedAnswer(st.parser.snapshot(), "resolved");
    }
    /**
     * Store the assembled body as the version history keeps, which is also what
     * releases this request's chunks.
     *
     * The ASSEMBLED BODY and not the extracted text, because the row is read back by
     * mapHistoryListToMessages through extractClaudeText / extractOpenAIText: storing
     * the provider's own document is what makes a streamed turn indistinguishable
     * from a buffered one on the next load, with no branch anywhere in the mapper.
     *
     * BEST EFFORT, and loudly so: the answer is already on screen and already in the
     * history cache by the time this fires. A failure costs the chunks (they stay,
     * and the turn stays re-readable) and a row that reads back empty, never the
     * user's answer in front of them.
     *
     * WHAT IS DELIBERATELY NEVER FINALIZED, because finalize is also the only way to
     * release chunks and it is tempting to reach for it as a cleanup:
     *
     *   - an INCOMPLETE parse (see _mayFinalize). Storing a truncation makes it
     *     permanent AND deletes the part that was missing from it. A stream killed by
     *     an `error` frame is one of these however terminal it looks: the frame ends
     *     the stream, so `complete` is true, while the text is only what arrived
     *     before the error. That is why the gate reads answerComplete.
     *   - a FAILED turn. Its chunks hold the part of the answer that did arrive,
     *     which is the only copy of that text there is, and the two ways to release
     *     them both cost something real: storing the partial makes a truncated answer
     *     the turn's permanent history AND masks the failure on read (csr-poll hands
     *     back a finalized body before it ever looks at the row's error, so the turn
     *     would read back as a clean short answer), while storing the error throws
     *     the partial away outright. Keeping them costs storage on rows that produced
     *     bytes and then failed, which is rare - a failure before the first byte (a
     *     wrong API key, the common case) has no chunks to keep - and the poller
     *     hands those chunks back alongside the error on every later read, so nothing
     *     is stranded, only retained. Retention is the honest trade here; deletion is
     *     not reversible.
     *   - a CANCELLED turn, for the same reason plus one: the user's Stop means the
     *     half answer is to be discarded, so writing it into history as the kept
     *     version would resurrect exactly what the stop was for.
     */
    _finalizeStreamedTurn(st) {
      if (st.finalized) return;
      if (!this._mayFinalize(st)) return;
      var fin = chatEngineConfig().clientSecretRequestFinalize;
      if (!fin || st.finalBody == null) return;
      st.finalized = true;
      var url = st.platform === "openai" ? OPENAI_RESPONSES_API_URL : ANTHROPIC_MESSAGES_API_URL;
      try {
        Promise.resolve(fin(st.id, st.finalBody, {
          url,
          method: "POST",
          service: st.projectId,
          owner: st.owner
        })).catch(function(err) {
          console.warn("[chat-engine] clientSecretRequestFinalize failed", err);
        });
      } catch (e) {
        console.warn("[chat-engine] clientSecretRequestFinalize threw", e);
      }
    }
    /** Painted-but-unsettled live text on a bubble, for the typewriter to resume from.
     *  A pending assistant placeholder is created with content '' by every path that
     *  makes one, so non-empty content on one can only have been painted here. */
    _paintedTextAt(idx) {
      var m = idx >= 0 ? this.state.messages[idx] : void 0;
      if (!m || m.role !== "assistant" || typeof m.content !== "string") return "";
      return m.content;
    }
    /** The recovery bookkeeping, created on first touch.
     *
     *  LAZY, not constructor-initialised, and for a concrete reason: ChatSession is
     *  also built with Object.create(ChatSession.prototype) by the engine's own test
     *  harnesses, which drive one method against a hand-built state rather than a
     *  whole session. A field only the constructor creates is undefined there, and
     *  the method that reaches for it throws, turning a test of the settle into a
     *  crash about bookkeeping. */
    _rec() {
      if (!this._streamRecovery) this._streamRecovery = { incomplete: {}, attempted: {}, inflight: {}, failed: {}, queue: [], running: false };
      return this._streamRecovery;
    }
    /**
     * Put this session's fetching state onto the turn's bubble, so a view can tell a
     * loader that means something from one that means nothing.
     *
     * ONLY EVER ONTO A STILL-MARKED BUBBLE. Once `_streamPending` is off the turn has
     * an answer (or was proven to have none) and this says nothing about it; writing
     * it there would leave a stale 'active' on a settled bubble forever.
     *
     * host.notify() is what redraws the widget, whose renderer is imperative. It is a
     * no-op in agent.vue, whose state is a Vue reactive() - the property write above
     * is what redraws there. Both are covered by doing both, and neither is a
     * substitute for the other.
     */
    _markRecoveryPhase(itemId, phase) {
      var changed = false;
      for (var i = 0; i < this.state.messages.length; i++) {
        var m = this.state.messages[i];
        if (!m || m.role !== "assistant" || m._serverItemId !== itemId || !m._streamPending) continue;
        var next = phase === null ? void 0 : phase;
        if (m._streamRecovery === next) continue;
        if (next === void 0) delete m._streamRecovery;
        else m._streamRecovery = next;
        changed = true;
      }
      if (changed) this.host.notify();
    }
    /**
     * Let LOCAL answers survive a freshly-mapped page whose copies of them are
     * authoritative-but-empty. Call with the page BEFORE it replaces or merges into
     * state.messages; mutates the page's bubbles in place.
     *
     * The adoption itself is history.ts's adoptLocalAnswerIntoPage (shared, so the
     * clients' own mappers cannot fork it). What lives here is the one thing the
     * pure function cannot know: whether the local text is the WHOLE answer. Text
     * left by a stream that ended without a terminal event is not, so that bubble
     * keeps its marker and gets read back even though it has content - otherwise a
     * truncated answer would adopt itself over the row and never be corrected.
     */
    _adoptLocalAnswers(mapped, loadKey) {
      if (!mapped || !mapped.length) return;
      var pendingIncoming = [];
      for (var i = 0; i < mapped.length; i++) {
        if (mapped[i] && mapped[i]._streamPending) pendingIncoming.push(mapped[i]);
      }
      if (!pendingIncoming.length) return;
      var locals = {};
      for (var j = 0; j < this.state.messages.length; j++) {
        var lm = this.state.messages[j];
        if (!lm || lm.role !== "assistant" || !lm._serverItemId) continue;
        if (lm._ownerKey !== void 0 && loadKey !== void 0 && lm._ownerKey !== loadKey) continue;
        if (locals[lm._serverItemId] === void 0) locals[lm._serverItemId] = lm;
      }
      for (var k = 0; k < pendingIncoming.length; k++) {
        var inc = pendingIncoming[k];
        var id = inc._serverItemId;
        if (!id) continue;
        var local = locals[id];
        if (!local) continue;
        if (!adoptLocalAnswerIntoPage(inc, local)) continue;
        if (this._rec().incomplete[id]) inc._streamPending = true;
      }
      for (var p = 0; p < pendingIncoming.length; p++) {
        var pi = pendingIncoming[p];
        if (!pi._streamPending || !pi._serverItemId) continue;
        var phase = this._recoveryPhaseFor(pi._serverItemId);
        if (phase === null) delete pi._streamRecovery;
        else pi._streamRecovery = phase;
      }
    }
    /**
     * This session's fetching state for one turn, from the bookkeeping rather than
     * from any bubble. A queued entry counts as 'active': it is committed to be read,
     * serially, and the reader has no way to tell "being read" from "next in line"
     * apart from the wait.
     */
    _recoveryPhaseFor(itemId) {
      var rec = this._rec();
      if (rec.inflight[itemId]) return "active";
      for (var i = 0; i < rec.queue.length; i++) if (rec.queue[i].id === itemId) return "active";
      if (rec.failed[itemId]) return "failed";
      return null;
    }
    /**
     * PUBLIC DELEGATE, for a client that maps and merges its own history page.
     *
     * agent.vue keeps a forked mapper and a forked first-page merge (its mount path
     * runs them, while resumePolling routes through loadHistory below), so both
     * paths are live for the SAME row inside one component. Adoption is part of the
     * merge contract, not an optional extra: without it that fork erases a streamed
     * answer off the screen on every turn, which is the whole of MAJOR 3.
     *
     * Exposed rather than reimplemented because the rule needs the session's own
     * `incomplete` set, which the pure helper (history.ts adoptLocalAnswerIntoPage)
     * cannot see. A client that reached for the helper alone would adopt a TRUNCATED
     * answer over the row and clear the marker that would have gone back for the
     * rest - a fork that reads as correct and loses text.
     *
     * Call it exactly where loadHistory does: on the freshly mapped page, after
     * applyHydratedBodies and BEFORE the page replaces or merges into state.messages.
     */
    adoptLocalAnswers(mapped, loadKey) {
      this._adoptLocalAnswers(mapped, loadKey);
    }
    /**
     * Queue the on-screen turns whose answer is only in the chunk store, newest
     * first, and start draining. Never blocks and never throws.
     *
     * `ownerKey` is the chat the queue entries belong to, snapshotted by the caller:
     * a recovery that lands after the user has moved on writes into that chat's
     * cache, never into whatever list is on screen by then.
     */
    _scheduleStreamRecovery(ownerKey, platform, projectId, owner) {
      if (!streamRecoveryEnabled()) return;
      var rec = this._rec();
      var wanted = [];
      for (var i = this.state.messages.length - 1; i >= 0; i--) {
        var m = this.state.messages[i];
        if (!m || m.role !== "assistant" || !m._streamPending || !m._serverItemId) continue;
        var id = m._serverItemId;
        if (rec.attempted[id]) continue;
        if (this.liveStreams[id]) continue;
        if (rec.queue.some(function(e) {
          return e.id === id;
        })) continue;
        wanted.push(id);
        if (wanted.length >= STREAM_RECOVERY_PER_LOAD) break;
      }
      if (!wanted.length) return;
      for (var w = 0; w < wanted.length; w++) {
        rec.queue.push({ id: wanted[w], ownerKey, platform, projectId, owner });
        this._markRecoveryPhase(wanted[w], "active");
      }
      this._drainStreamRecovery();
    }
    /**
     * PUBLIC DELEGATE, the other half of what a forked history path needs.
     *
     * Same reason as adoptLocalAnswers: agent.vue's mount path never calls
     * loadHistory, so without this its pages would MARK unfinalized streamed turns
     * and then never read them back - CRITICAL 1 left unfixed on the client's
     * primary path, with the marker making it look handled.
     *
     * Takes the load's SNAPSHOTTED identity rather than reading it live, and that is
     * the reason this exists instead of the caller looping over recoverStreamedAnswer:
     * that one reads getIdentity() at call time (right, for an on-demand affordance
     * the user just clicked), which after a project switch racing the load would
     * finalize the turn against the project they switched TO. Call it AFTER the page
     * is rendered and the loading flags are cleared - it must never hold up the
     * conversation it belongs to.
     */
    scheduleStreamRecovery(ownerKey, platform, projectId, owner) {
      this._scheduleStreamRecovery(ownerKey, platform, projectId, owner);
    }
    /** Serial drain of the recovery queue. Each entry is one full chunk read. */
    _drainStreamRecovery() {
      var rec = this._rec();
      if (rec.running) return;
      var next = rec.queue.shift();
      if (!next) return;
      rec.running = true;
      var self = this;
      this._readBackStreamedTurn(next.id, next.ownerKey, next.platform, next.projectId, next.owner).catch(function() {
      }).then(function() {
        self._rec().running = false;
        self._drainStreamRecovery();
      });
    }
    /**
     * Read one unfinalized streamed turn back out of the chunk store and put its
     * answer where the turn's answer belongs.
     *
     * Public because the cap above is deliberately small: a host that wants to offer
     * "load the rest" on an older recoverable turn calls this with its
     * `_serverItemId`, and gets the same path the automatic recovery uses. Safe to
     * call for an id that turns out not to be recoverable, and safe to call twice -
     * a second call while the first is still in flight is a no-op.
     *
     * THIS IS THE USER ASKING, and that is why it passes `manual`. The automatic
     * recovery refuses a row it has already tried, so that a re-render, or the
     * history load that every visibilitychange fires, cannot loop on the same
     * chunks. A click is neither of those: it is one bounded request that a person
     * asked for, and applying the loop guard to it made the affordance a button that
     * silently did nothing for exactly the rows most likely to have it - every row
     * an earlier read touched and could not settle.
     */
    recoverStreamedAnswer(itemId) {
      if (!itemId) return Promise.resolve();
      var id = this.host.getIdentity();
      var platform = id && id.platform === "openai" ? "openai" : "claude";
      return this._readBackStreamedTurn(itemId, this.getHistoryCacheKey(), platform, id ? id.projectId : "", id ? id.owner : "", true);
    }
    _readBackStreamedTurn(itemId, ownerKey, platform, projectId, owner, manual) {
      var cfg = chatEngineConfig();
      var read = cfg.clientSecretRequestStream;
      if (!read || !itemId) return Promise.resolve();
      if (this._rec().inflight[itemId]) return Promise.resolve();
      if (!manual && this._rec().attempted[itemId]) {
        this._markRecoveryPhase(itemId, null);
        return Promise.resolve();
      }
      this._rec().attempted[itemId] = true;
      this._rec().inflight[itemId] = true;
      delete this._rec().failed[itemId];
      this._markRecoveryPhase(itemId, "active");
      var self = this;
      var url = platform === "openai" ? OPENAI_RESPONSES_API_URL : ANTHROPIC_MESSAGES_API_URL;
      var parser = createSseParser();
      var fed = false;
      return Promise.resolve(read(itemId, {
        url,
        method: "POST",
        service: projectId,
        owner,
        since: 0,
        onStream: function(chunk) {
          if (typeof chunk !== "string" || !chunk) return;
          fed = true;
          parser.feed(chunk);
        }
      })).then(function(res) {
        if (isPollStopped(res)) {
          delete self._rec().attempted[itemId];
          delete self._rec().inflight[itemId];
          self._markRecoveryPhase(itemId, null);
          return;
        }
        var envelope = isCsrStatusEnvelope(res);
        var body = null;
        if (res && !envelope) {
          body = res;
        } else if (fed) {
          parser.end();
          body = parser.finalBody();
        }
        var snap = parser.snapshot();
        var fromRow = !!(res && !envelope);
        var rowStatus = envelope && typeof res.status === "string" ? res.status : void 0;
        var degraded = !!(envelope && res && res.more === true);
        var store = !fromRow && !degraded && body != null && mayKeepStreamedAnswer(snap, rowStatus);
        delete self._rec().inflight[itemId];
        delete self._rec().failed[itemId];
        self._markRecoveryPhase(itemId, null);
        if (degraded) {
          delete self._rec().attempted[itemId];
        }
        self._applyRecoveredAnswer(itemId, ownerKey, platform, projectId, owner, body, store, degraded);
      }, function(err) {
        console.warn("[chat-engine] could not read back a streamed turn", itemId, err);
        delete self._rec().attempted[itemId];
        delete self._rec().inflight[itemId];
        self._rec().failed[itemId] = true;
        self._markRecoveryPhase(itemId, "failed");
      });
    }
    /**
     * Write a recovered answer into the turn's bubble (or into the owning chat's
     * cache when the reader has moved on), then store it as the version history
     * keeps.
     *
     * FINALIZING IS WHAT MAKES THIS RUN ONCE. It copies the answer onto the row and
     * releases the chunks, so the next load reads an ordinary turn and no recovery is
     * scheduled for it ever again, by anyone, in any tab. `store` is the caller's
     * decision and carries two gates at once: mayKeepStreamedAnswer, the SAME keep
     * policy the live settle applies (an incomplete, errored or failed read is shown
     * but never stored, because storing it would make the truncation permanent and
     * delete the part that was missing), and whether the body is new at all (one
     * that came off the row is already stored).
     */
    _applyRecoveredAnswer(itemId, ownerKey, platform, projectId, owner, body, store, degraded) {
      var text = "";
      var isErr = isErrorResponseBody(body);
      if (body != null && !isErr) {
        text = ((platform === "openai" ? extractOpenAIText(body) : extractClaudeText(body)) || "").trim();
      }
      if (!text && !isErr) {
        if (degraded) {
          return;
        }
        this._clearStreamPendingMark(itemId, ownerKey, true);
        return;
      }
      var reply = isErr ? { role: "assistant", content: getErrorMessage(body), isError: true, _serverItemId: itemId } : { role: "assistant", content: text, _serverItemId: itemId };
      if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
        this._applyReplyToCache(ownerKey, reply, itemId);
      } else {
        var idx = -1;
        for (var i = 0; i < this.state.messages.length; i++) {
          var m = this.state.messages[i];
          if (m && m.role === "assistant" && m._serverItemId === itemId) {
            idx = i;
            break;
          }
        }
        if (idx === -1) {
          this._applyReplyToCache(ownerKey, reply, itemId);
        } else {
          var prev = this.state.messages[idx];
          if (prev._ts !== void 0) reply._ts = prev._ts;
          if (prev._ownerKey !== void 0) reply._ownerKey = prev._ownerKey;
          this.state.messages[idx] = reply;
          this.updateHistoryCache();
          this.host.notify();
        }
      }
      if (!degraded) delete this._rec().incomplete[itemId];
      if (!store || body == null || isErr) return;
      var fin = chatEngineConfig().clientSecretRequestFinalize;
      if (!fin) return;
      var url = platform === "openai" ? OPENAI_RESPONSES_API_URL : ANTHROPIC_MESSAGES_API_URL;
      try {
        Promise.resolve(fin(itemId, body, { url, method: "POST", service: projectId, owner })).catch(function(err) {
          console.warn("[chat-engine] finalize of a recovered turn failed", err);
        });
      } catch (e) {
        console.warn("[chat-engine] finalize of a recovered turn threw", e);
      }
    }
    /**
     * Take the "answer is elsewhere" marker off a turn once it is settled one way or
     * the other. `drop` removes an assistant bubble that turned out to have no answer
     * at all, which restores exactly the list the mapper used to produce for such a
     * row (none), rather than leaving a permanently empty bubble behind.
     *
     * ONLY EVER CALLED FOR A TURN THAT WAS ACTUALLY READ. The marker is the one thing
     * that keeps an unrecovered answer reachable, so it comes off only on the strength
     * of an answer (the recovery wrote one) or of a read that came back empty. A read
     * that FAILED, or one that was STOPPED, knows neither, and taking the marker off
     * on either of those is how a bubble ends up empty forever with its answer still
     * in the chunk table. `drop` is likewise never passed for a bubble that HAS
     * content: an empty row is an empty turn, a failed read is not.
     */
    _clearStreamPendingMark(itemId, ownerKey, drop) {
      if (ownerKey && this.getHistoryCacheKey() !== ownerKey) return;
      var changed = false;
      for (var i = this.state.messages.length - 1; i >= 0; i--) {
        var m = this.state.messages[i];
        if (!m || m.role !== "assistant" || m._serverItemId !== itemId) continue;
        if (!m._streamPending) continue;
        if (drop && !m.content) {
          this.state.messages.splice(i, 1);
          changed = true;
          continue;
        }
        m._streamPending = false;
        changed = true;
      }
      if (changed) {
        this.updateHistoryCache();
        this.host.notify();
      }
    }
    /**
     * Stop and forget one item's poll. Used after a cancel: the row is either gone
     * (cancelled while queued) or flagged cancelled (cancelled while running), so
     * asking about it again only burns requests. Safe when no poll is attached, and
     * safe on an older skapi-js with no stop handle (the entry is then LEFT in the
     * map so a later drain cannot stack a second, unstoppable poll on the id).
     */
    _stopPoll(id) {
      var handle = this.historyItemPolls.get(id);
      if (!handle) return;
      if (typeof handle.stop !== "function") return;
      try {
        handle.stop();
      } catch (e) {
      }
      this.historyItemPolls.delete(id);
    }
    /** True while any pause reason is active. */
    isPollingPaused() {
      return this._pauseReasons.size > 0;
    }
    /**
     * Stop BACKGROUND polling until resumePolling. Foreground polls (a reply the user is
     * waiting on) keep running deliberately: their results must still land in the history
     * cache so resumePendingRequest can render them on return, otherwise a user who sends
     * a message then navigates away comes back to a permanently stuck "Thinking...".
     *
     * Server-side work is untouched; this only stops asking about it. That is safe for
     * document indexing because the worker drives that loop itself.
     */
    pausePolling(reason) {
      this._pauseReasons.add(reason || "paused");
      var self = this;
      var stopped = [];
      this.historyItemPolls.forEach(function(handle, id) {
        if (!handle || handle.kind !== "bg") return;
        if (typeof handle.stop !== "function") return;
        try {
          handle.stop();
        } catch (e) {
        }
        stopped.push(id);
      });
      stopped.forEach(function(id) {
        self.historyItemPolls.delete(id);
      });
    }
    /**
     * Lift a pause reason WITHOUT running the reconcile. For a caller that is about to
     * reload history anyway (a view remounting), letting resumePolling also reconcile
     * would race that load and can double-attach.
     */
    clearPauseReason(reason) {
      this._pauseReasons.delete(reason || "paused");
    }
    /**
     * Clear a pause reason and, once none remain, re-attach polling and reconcile.
     * Deliberately does NOT touch gateRefreshToken: bumping it would silently discard
     * the results of anything still in flight across the pause.
     */
    resumePolling(reason) {
      this._pauseReasons.delete(reason || "paused");
      if (this._pauseReasons.size > 0 || this._resuming) return Promise.resolve();
      if (!this.host.isViewMounted || !this.host.isViewMounted()) return Promise.resolve();
      var self = this;
      this._resuming = true;
      return Promise.resolve().then(function() {
        self.drainBgTaskQueue();
        return self.loadHistory(false, self.state.gateRefreshToken);
      }).catch(function(e) {
        console.error("[chat-engine] resume polling failed", e);
      }).then(function() {
        self._resuming = false;
      });
    }
    _newLocalId() {
      this._lidSeq += 1;
      return "lid_" + this._lidSeq;
    }
    /**
     * The key every per-chat cache hangs off: the restored message cache, the
     * hydrated-body memo, the live-index key and the per-file storage-path key.
     *
     * It carries the IDENTITY as well as the project and platform. A single
     * browser can hold more than one conversation on one project without a
     * reload — an anonymous visitor who signs in, or a dashboard user who logs
     * out and back in as someone else — and with an identity-free key the
     * previous conversation stayed in the cache and was re-rendered, and written
     * back, as the new one's. `userId` is the same value the request queue is
     * named after, so two identities that share a queue share a cache, which is
     * exactly right.
     */
    getHistoryCacheKey() {
      var id = this.host.getIdentity();
      return chatCacheKey(id.projectId, id.platform, id.userId);
    }
    /** Re-apply memoized hydrated texts onto freshly-mapped messages. Both
     *  clients call this right after their mapper runs (loadHistory does it
     *  internally); it mutates the given array's items in place. */
    applyHydratedBodies(messages) {
      var key = this.getHistoryCacheKey();
      var memo = key ? this._hydratedBodies[key] : null;
      if (!memo) return;
      var id = this.host.getIdentity();
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (!m || !m._compact || m.role !== "assistant" || !m._serverItemId) continue;
        var text = memo[m._serverItemId];
        if (typeof text !== "string") continue;
        m.content = sanitizeAttachmentLinksForHistory(text, id.projectId, true) || EMPTY_INDEXING_REPLY;
        delete m._compact;
      }
    }
    /** Fetch the real response bodies for compact history stubs (one csr-poll
     *  point lookup per item id), memoize, and swap them into the live list.
     *  Best-effort: a failed lookup leaves the stub (its head + fallback line
     *  still render) and a later expand retries. */
    hydrateCompactItems(itemIds) {
      var self = this;
      var lookup = chatEngineConfig().csrHistoryItemLookup;
      if (!lookup || !itemIds || !itemIds.length) return Promise.resolve();
      var id = this.host.getIdentity();
      var platform = id.platform;
      if (!id.projectId || platform !== "claude" && platform !== "openai") return Promise.resolve();
      var chatKey = this.getHistoryCacheKey();
      if (!chatKey) return Promise.resolve();
      var jobs = itemIds.map(function(itemId) {
        if (!itemId) return Promise.resolve();
        var already = self._hydratedBodies[chatKey] && self._hydratedBodies[chatKey][itemId] !== void 0;
        var inflightKey = chatKey + "|" + itemId;
        if (already || self._hydratingItems[inflightKey]) return Promise.resolve();
        self._hydratingItems[inflightKey] = true;
        return Promise.resolve(lookup(buildHistoryItemFullId(platform, id.projectId, itemId), id.projectId, id.owner)).then(function(body) {
          var text = ((platform === "openai" ? extractOpenAIText(body) : extractClaudeText(body)) || "").trim();
          if (text.indexOf(INDEXING_COMPLETE_MARKER) !== -1) text = text.split(INDEXING_COMPLETE_MARKER).join("").trim();
          if (!self._hydratedBodies[chatKey]) self._hydratedBodies[chatKey] = {};
          self._hydratedBodies[chatKey][itemId] = text;
          if (self.getHistoryCacheKey() !== chatKey) return;
          for (var i = 0; i < self.state.messages.length; i++) {
            var m = self.state.messages[i];
            if (m && m._compact && m.role === "assistant" && m._serverItemId === itemId) {
              m.content = sanitizeAttachmentLinksForHistory(text, id.projectId, true) || EMPTY_INDEXING_REPLY;
              delete m._compact;
            }
          }
        }).catch(function() {
        }).then(function() {
          delete self._hydratingItems[inflightKey];
        });
      });
      return Promise.all(jobs).then(function() {
        if (self.getHistoryCacheKey() !== chatKey) return;
        self.host.notify();
        self.updateHistoryCache();
      });
    }
    updateHistoryCache() {
      var key = this.getHistoryCacheKey();
      if (!key) return;
      this.aiChatHistoryCache[key] = {
        messages: this.state.messages.filter(function(m) {
          return m._ownerKey === void 0 || m._ownerKey === key;
        }),
        endOfList: this.state.historyEndOfList,
        startKeyHistory: this.state.historyStartKeyHistory.slice()
      };
    }
    /**
     * Give the immediate-send pair the server's id for their turn, the moment the
     * dispatch learns it.
     *
     * WHY THIS EXISTS. An immediate send pushes its user bubble and its
     * "Thinking..." placeholder locally, and until now neither ever carried a
     * _serverItemId — only the QUEUED path stamped one, off its ack. So for the
     * whole life of the turn there was no way to tell the local copy and the
     * server's copy of the SAME turn apart, and the history merge fell back to a
     * heuristic: rescue the local pair unless the freshly-fetched page happens to
     * contain a pending assistant.
     *
     * That heuristic has a hole exactly one poll interval wide. The server settles
     * the request; for up to POLL_INTERVAL the client has not noticed, so
     * `state.sending` is still true and the local pair is still on screen — while a
     * history fetch issued in that window returns the turn ALREADY SETTLED, with no
     * pending assistant in it. The rescue then re-appends the local pair below the
     * server's copy (the question, twice), and when the poll finally resolves,
     * typewriteLatestReply writes the answer into the rescued placeholder because it
     * is the only pending assistant left (the answer, twice). updateHistoryCache
     * persists the result, so it survives every later visit.
     *
     * Navigating away while waiting and coming back is what lands a fetch in that
     * window: a remount runs refreshGate -> a fresh first page, at an arbitrary
     * moment relative to the 3s poll.
     *
     * With the id on the bubbles, both clients' rescue loops skip them through the
     * dedup they already have (`_serverItemId is in this page`), the reply the
     * dispatch caches inherits the id too, and nothing needs a new special case.
     *
     * Matched by _localId, never by index: a file's indexing rows are spliced in
     * above these bubbles while the request is in flight.
     */
    _stampTurnWithItemId(key, userLid, placeholderLid, itemId) {
      if (!itemId) return;
      var changed = false;
      var stamp = function(list) {
        var hit = false;
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          if (!m || !m._localId) continue;
          if (m._localId !== userLid && m._localId !== placeholderLid) continue;
          if (m._serverItemId === itemId) continue;
          list[i] = Object.assign({}, m, { _serverItemId: itemId });
          hit = true;
        }
        return hit;
      };
      changed = stamp(this.state.messages);
      var cached = key ? this.aiChatHistoryCache[key] : void 0;
      if (cached) {
        var msgs = cached.messages.slice();
        if (stamp(msgs)) {
          this.aiChatHistoryCache[key] = {
            messages: msgs,
            endOfList: cached.endOfList,
            startKeyHistory: cached.startKeyHistory
          };
        }
      }
      if (changed) this.host.notify();
    }
    /**
     * Land a resolved reply in the history cache of a chat that is NOT currently
     * visible, without touching state.messages. Mirrors the cache-only path in
     * dispatchAgentRequest: REPLACE the trailing pending "Thinking..." bubble
     * (append only when there is none), and settle the matching pending user
     * bubble, so the cached copy never keeps a stuck "Thinking..." that a later
     * cache-first load would re-render forever.
     */
    _applyReplyToCache(key, reply, serverId) {
      if (!key) return;
      var existing = this.aiChatHistoryCache[key] || { messages: [], endOfList: false, startKeyHistory: [] };
      var msgs = existing.messages.slice();
      var thIdx = -1;
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        if (!m || !m.isPending || m.role !== "assistant" || m.isBackgroundTask) continue;
        if (serverId && m._serverItemId && m._serverItemId !== serverId) continue;
        thIdx = i;
        break;
      }
      if (thIdx !== -1) {
        if (reply._serverItemId === void 0 && msgs[thIdx]._serverItemId !== void 0) reply._serverItemId = msgs[thIdx]._serverItemId;
        msgs[thIdx] = reply;
      } else {
        var dupIdx = -1;
        if (serverId) {
          for (var d = msgs.length - 1; d >= 0; d--) {
            var dm = msgs[d];
            if (dm && dm.role === "assistant" && dm._serverItemId === serverId) {
              dupIdx = d;
              break;
            }
          }
        }
        if (dupIdx !== -1) msgs[dupIdx] = reply;
        else msgs.push(reply);
      }
      for (var j = 0; j < msgs.length; j++) {
        var u = msgs[j];
        if (!u || u.role !== "user" || u.isBackgroundTask) continue;
        if (u._stageId) continue;
        if (!(u.isPendingQueued || u.isPendingInProcess || u.isSendingToServer)) continue;
        if (serverId && u._serverItemId && u._serverItemId !== serverId) continue;
        var settled = { role: "user", content: u.content };
        if (u._serverItemId !== void 0) settled._serverItemId = u._serverItemId;
        if (u._ownerKey !== void 0) settled._ownerKey = u._ownerKey;
        msgs[j] = settled;
        break;
      }
      this.aiChatHistoryCache[key] = {
        messages: msgs,
        endOfList: existing.endOfList,
        startKeyHistory: existing.startKeyHistory
      };
    }
    /**
     * projectId/owner are passed explicitly by every caller: a request can be
     * dispatched after the user moved to another project, and re-reading the live
     * identity here would silently send the turn to THAT project instead of the
     * one it was composed for. Falls back to the live read only when a caller
     * omits them.
     */
    _callProviderFor(platform, prompt, messages, system, model, userId, extractContent, fileUrls, projectId, owner) {
      if (projectId === void 0 || owner === void 0) {
        var id = this.host.getIdentity();
        if (projectId === void 0) projectId = id.projectId;
        if (owner === void 0) owner = id.owner;
      }
      var liveId = this.host.getIdentity();
      var mcpScope = { anonymous: liveId.anonymous, publicProjectId: liveId.publicProjectId };
      return platform === "openai" ? callOpenAIWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls, void 0, void 0, mcpScope) : callClaudeWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls, void 0, void 0, mcpScope);
    }
    dispatchAgentRequest(params) {
      var self = this;
      var dispatchItemId;
      var sendAndPoll = function() {
        return Promise.resolve(
          self._callProviderFor(params.aiPlatform, params.text, params.boundedMessages, params.systemPrompt, params.aiModel, params.userId, params.extractContent, params.fileUrls, params.projectId, params.owner)
        ).then(function(initial) {
          if (initial && initial.poll && (initial.status === "pending" || initial.status === "running")) {
            if (initial.id) {
              if (dispatchItemId && dispatchItemId !== initial.id) self.historyItemPolls.delete(dispatchItemId);
              dispatchItemId = initial.id;
              if (typeof params.onItemId === "function") params.onItemId(initial.id);
            }
            var dp = self._fgPollWithEarlyProbe(initial, initial.id, void 0, {
              platform: params.aiPlatform,
              projectId: params.projectId,
              owner: params.owner,
              ownerKey: params.key
            });
            if (initial.id) self._trackPoll(initial.id, "fg", dp);
            return dp;
          }
          return initial;
        });
      };
      var run = sendAndPoll().catch(function(err) {
        if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(sendAndPoll);
        throw err;
      }).then(function(response) {
        if (isErrorResponseBody(response) && isAuthExpiredError(response) && !isNonRetryableRequestError(response)) {
          return self.host.refreshSession().then(sendAndPoll);
        }
        return response;
      }).then(function(response) {
        if (isErrorResponseBody(response)) return { content: getErrorMessage(response), isError: true };
        var answer = params.aiPlatform === "openai" ? extractOpenAIText(response) : extractClaudeText(response);
        answer = (answer || "").trim();
        return { content: answer || "No text response received from AI provider.", isError: false };
      }).catch(function(err) {
        return { content: getErrorMessage(err), isError: true };
      }).then(function(result) {
        delete self.pendingAgentRequests[params.key];
        if (dispatchItemId) self.historyItemPolls.delete(dispatchItemId);
        var reply = { role: "assistant", content: result.content, isError: result.isError };
        if (dispatchItemId) reply._serverItemId = dispatchItemId;
        self._applyReplyToCache(params.key, reply, dispatchItemId);
        return result;
      });
      this.pendingAgentRequests[params.key] = run;
      return run;
    }
    /**
     * Put a turn on screen the INSTANT the user hits Send, before its attachments
     * have finished uploading. Uploads run in the background now (the composer is
     * cleared and stays usable), so without a staged bubble the message would
     * appear only once its files were up — below anything the user sent in the
     * meantime, in an order that never matches what they typed.
     *
     * Staged bubbles carry _useBgQueue because that is where a turn with
     * attachments ultimately dispatches (behind its own indexing tasks). That flag
     * is also what keeps promoteNextQueuedToRunning / resolveQueuedUserBubble off
     * them: those advance the SERVER queue, and a staged turn has no server
     * request behind it yet.
     *
     * Returns the id to hand back as PinnedDispatchContext.stageId at dispatch.
     */
    stageOutgoingMessage(displayText) {
      this._stageSeq += 1;
      var stageId = "stg_" + this._stageSeq;
      var key = this.getHistoryCacheKey();
      var staged = {
        role: "user",
        content: displayText,
        isPendingQueued: true,
        isUploadingAttachments: true,
        isSendingToServer: true,
        _dimSending: true,
        // A staged bubble has no server id for minutes, and its indexing rows are
        // now inserted ABOVE it — so its array index moves. Both views fall back to
        // the index when a bubble has no id, which would re-key (and in Vue, remount)
        // this bubble on every file, restarting its transition and losing it as a
        // scroll anchor. A local id it keeps for its whole life fixes both.
        _localId: this._newLocalId(),
        _useBgQueue: true,
        _stageId: stageId,
        _ts: wallClockNow()
      };
      if (key) staged._ownerKey = key;
      this._liveStages[stageId] = true;
      this.state.messages.push(staged);
      this.host.notify();
      this.host.scrollToBottom(true);
      return stageId;
    }
    /** Is anything in this page still uploading/dispatching for this stage? */
    isLiveStage(stageId) {
      return !!stageId && !!this._liveStages[stageId];
    }
    /**
     * Settle any staged bubble in `list` whose chain no longer exists, and return the
     * list (a new array only if something changed).
     *
     * The caller is a cache restore. A staged bubble is the one kind of message whose
     * resolution lives entirely in page memory — no server request stands behind it
     * yet — so a copy that outlives its upload would render "(Uploading files...)"
     * forever with nothing left to finish it. Today nothing can: this cache dies with
     * the page, so every restored stage is still live and this is a no-op. It exists
     * so that stops being a silent assumption.
     */
    settleDeadStagedMessages(list) {
      if (!Array.isArray(list)) return list;
      var self = this;
      var dead = false;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m && m._stageId && !self._liveStages[m._stageId]) {
          dead = true;
          break;
        }
      }
      if (!dead) return list;
      return list.map(function(m2) {
        if (!m2 || !m2._stageId || self._liveStages[m2._stageId]) return m2;
        var settled = { role: "user", content: m2.content };
        if (m2._ownerKey !== void 0) settled._ownerKey = m2._ownerKey;
        if (m2._ts !== void 0) settled._ts = m2._ts;
        if (m2._localId !== void 0) settled._localId = m2._localId;
        return settled;
      });
    }
    _stageIndex(list, stageId) {
      if (!stageId) return -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i]._stageId === stageId) return i;
      }
      return -1;
    }
    /**
     * Staged turn, phase 2: its files are up and it is now waiting for the whole
     * indexing chain behind them. Swaps "(Uploading files...)" for
     * "(Indexing files...)"; the bubble stays dimmed, because from the user's side
     * nothing has been handed over yet.
     *
     * It deliberately does NOT say "(In queue)" here. The turn is not queued behind
     * anything the server knows about yet — it is waiting on work that can run for
     * minutes — and claiming otherwise is what made the wait look like a stall.
     */
    markStagedMessageIndexing(stageId) {
      var idx = this._stageIndex(this.state.messages, stageId);
      if (idx === -1) return;
      var ex = this.state.messages[idx];
      if (!ex.isUploadingAttachments) return;
      this.state.messages[idx] = Object.assign({}, ex, {
        isUploadingAttachments: false,
        isAwaitingIndexing: true
      });
      this.host.notify();
    }
    /**
     * Staged turn, phase 3: the last of its files has finished indexing, so the turn
     * is genuinely just queued now. Full opacity + "(In queue)".
     *
     * Clears the PRESENTATIONAL _dimSending only; isSendingToServer stays set until
     * the server actually acks (it is the token that ack matches on). Called by the
     * clients the instant awaitIndexingDrained resolves, i.e. immediately before the
     * dispatch that replaces this bubble — dispatchComposedMessage carries the
     * cleared flag onto the replacement so the turn does not blink back to dimmed.
     */
    markStagedMessageReady(stageId) {
      var idx = this._stageIndex(this.state.messages, stageId);
      if (idx === -1) return;
      var ex = this.state.messages[idx];
      if (!ex.isAwaitingIndexing && !ex._dimSending && !ex.isUploadingAttachments) return;
      this.state.messages[idx] = Object.assign({}, ex, {
        isUploadingAttachments: false,
        isAwaitingIndexing: false,
        _dimSending: false
      });
      this.host.notify();
    }
    /**
     * Resolves once this project's background-indexing queue has nothing left to
     * run, so a chat enqueued right after it is genuinely last.
     *
     * Sending the chat as soon as the uploads finish is not enough, which is the
     * whole reason this exists: indexing a file is a CHAIN, and each pass is only
     * enqueued once the previous one lands (the client mints CONTINUE passes for
     * text/grid files, the worker mints them for PDFs and windowed reads). Every
     * one of those passes therefore queues up BEHIND a chat sent at upload time,
     * and the model answers from a file it has only partly read.
     *
     * The queue is read from the server's status index rather than from
     * bgTaskQueue: that mirror holds only what this client dispatched or adopted,
     * and it stops being maintained once the view unmounts. An empty answer has to
     * repeat before it is believed — see INDEXING_DRAIN_IDLE_LOOKS — and a look
     * that fails counts as busy, so a dropped request delays the turn instead of
     * releasing it early.
     *
     * Reads the identity PINNED at Send time, never a live one: the user may be in
     * another project by now, and this must keep asking about the one they sent
     * from.
     */
    awaitIndexingDrained(identity) {
      var self = this;
      var svcId = identity && identity.projectId;
      var platform = identity && identity.platform;
      if (!svcId || platform !== "claude" && platform !== "openai") return Promise.resolve("skipped");
      var owner = identity.owner;
      var queue = bgIndexingQueueName(identity.userId, svcId);
      var startedAt = nowMs();
      var deadline = startedAt + INDEXING_DRAIN_TIMEOUT_MS;
      var idleLooks = 0;
      var ask = function(status) {
        var answered = false;
        return new Promise(function(res) {
          var bail = null;
          var settle = function(v) {
            if (answered) return;
            answered = true;
            if (bail) {
              clearTimeout(bail);
              bail = null;
            }
            res(v);
          };
          bail = setTimeout(function() {
            settle(null);
          }, INDEXING_DRAIN_LOOK_TIMEOUT_MS);
          Promise.resolve(probeBgQueue(
            { service: svcId, owner, platform, queue, status, limit: WORKER_PASS_ADOPT_LIMIT },
            { maxAgeMs: 0 }
          )).then(function(entry2) {
            settle(entry2.result);
          }, function() {
            settle(null);
          });
        });
      };
      var hasLiveIndexing = function(res) {
        var list = res && Array.isArray(res.list) ? res.list : [];
        for (var i = 0; i < list.length; i++) {
          var item = list[i];
          if (!item || item.status !== "pending" && item.status !== "running") continue;
          if (isIndexingRequestText(extractLastUserTextFromRequest(item.request_body))) return true;
        }
        return false;
      };
      return new Promise(function(resolve) {
        var timer = null;
        var lastLookAt = -Infinity;
        var nudgedThisInterval = false;
        var inFlight = false;
        var finish = function(v) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          var ni = self._drainNudges.indexOf(nudge);
          if (ni !== -1) self._drainNudges.splice(ni, 1);
          resolve(v);
        };
        var again = function(ms) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          var wait = ms == null ? idleLooks > 0 ? INDEXING_DRAIN_CONFIRM_POLL_MS : INDEXING_DRAIN_BUSY_POLL_MS : ms;
          timer = setTimeout(look, wait);
        };
        var nudge = function() {
          if (idleLooks > 0) return;
          if (inFlight) return;
          if (nudgedThisInterval) return;
          if (self._indexDispatchesInFlight > 0) return;
          nudgedThisInterval = true;
          again(Math.max(0, INDEXING_DRAIN_NUDGE_MIN_GAP_MS - (nowMs() - lastLookAt)));
        };
        var look = function() {
          timer = null;
          if (inFlight) return;
          lastLookAt = nowMs();
          nudgedThisInterval = false;
          if (nowMs() >= deadline) {
            finish("timedout");
            return;
          }
          if (self._indexDispatchesInFlight > 0) {
            idleLooks = 0;
            again();
            return;
          }
          inFlight = true;
          Promise.all([ask("running"), ask("pending")]).then(function(res) {
            inFlight = false;
            var unknown = res[0] === null || res[1] === null;
            if (unknown || hasLiveIndexing(res[0]) || hasLiveIndexing(res[1])) idleLooks = 0;
            else idleLooks += 1;
            if (idleLooks >= INDEXING_DRAIN_IDLE_LOOKS && nowMs() - startedAt >= INDEXING_DRAIN_MIN_MS) {
              finish("drained");
              return;
            }
            again();
          }, function() {
            inFlight = false;
            idleLooks = 0;
            again();
          });
        };
        self._drainNudges.push(nudge);
        look();
      });
    }
    /**
     * Abandon a staged turn — its uploads failed outright, so nothing will be
     * dispatched. The bubble stays (the user's text is not silently thrown away)
     * but settles into a plain, non-pending message; the caller reports the
     * failure separately.
     */
    settleStagedMessage(stageId) {
      delete this._liveStages[stageId];
      var idx = this._stageIndex(this.state.messages, stageId);
      if (idx === -1) return;
      var ex = this.state.messages[idx];
      var settled = { role: "user", content: ex.content };
      if (ex._ownerKey !== void 0) settled._ownerKey = ex._ownerKey;
      if (ex._ts !== void 0) settled._ts = ex._ts;
      if (ex._localId !== void 0) settled._localId = ex._localId;
      this.state.messages[idx] = settled;
      this.host.notify();
      this.updateHistoryCache();
    }
    // composed = clean display text; composedForLlm carries office-extraction
    // placeholders for the provider only. useBgQueue routes a post-attachment turn
    // onto the "-bg" queue so it runs after indexing.
    dispatchComposedMessage(composed, useBgQueue, composedForLlm, extractContent, fileUrls, pinned) {
      var self = this;
      var stageId = pinned ? pinned.stageId : void 0;
      if (!composed) {
        if (stageId) this.settleStagedMessage(stageId);
        return;
      }
      var id = pinned ? pinned.identity : this.host.getIdentity();
      if (id.platform === "none") {
        if (stageId) this.settleStagedMessage(stageId);
        return;
      }
      if (stageId) delete this._liveStages[stageId];
      var llmComposed = composedForLlm || composed;
      var key = chatCacheKey(id.projectId, id.platform, id.userId);
      var offChat = !!key && key !== this.getHistoryCacheKey();
      var isQueuedSend = !offChat && (useBgQueue || this.state.sending || this.state.messages.some(function(m) {
        return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue;
      }));
      var aiPlatform = id.platform;
      var aiModel = id.model || void 0;
      var systemPrompt = pinned ? pinned.systemPrompt : this.host.buildSystemPrompt();
      var userId = id.userId || id.projectId;
      var chatQueue = useBgQueue ? bgIndexingQueueName(userId) : userId;
      if (offChat) {
        var offHistory = (this.aiChatHistoryCache[key] ? this.aiChatHistoryCache[key].messages : []).filter(function(m) {
          return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder && !m.isCancelled && !m.isBackgroundTask && !m.isError;
        });
        var offBounded = buildBoundedChatMessages({
          platform: aiPlatform,
          model: aiModel,
          systemPrompt,
          projectId: id.projectId,
          history: offHistory.concat([{ role: "user", content: llmComposed }])
        });
        var offExisting = this.aiChatHistoryCache[key] || { messages: [], endOfList: false, startKeyHistory: [] };
        var offUser = { role: "user", content: composed, _ownerKey: key, _ts: wallClockNow() };
        var offStage = this._stageIndex(this.state.messages, stageId);
        if (offStage !== -1) {
          if (this.state.messages[offStage]._ts !== void 0) offUser._ts = this.state.messages[offStage]._ts;
          this.state.messages.splice(offStage, 1);
          this.host.notify();
        }
        var offCached = offExisting.messages;
        if (stageId) {
          offCached = offCached.filter(function(m) {
            if (m._stageId !== stageId) return true;
            if (offStage === -1 && m._ts !== void 0) offUser._ts = m._ts;
            return false;
          });
        }
        this.aiChatHistoryCache[key] = {
          messages: offCached.concat([
            offUser,
            { role: "assistant", content: "", isPending: true, isPendingInProcess: true, _ownerKey: key }
          ]),
          endOfList: offExisting.endOfList,
          startKeyHistory: offExisting.startKeyHistory
        };
        this.dispatchAgentRequest({
          key,
          projectId: id.projectId,
          owner: id.owner,
          aiPlatform,
          aiModel,
          systemPrompt,
          text: composed,
          boundedMessages: offBounded.messages,
          userId: chatQueue,
          extractContent,
          fileUrls
        });
        return;
      }
      if (isQueuedSend) {
        var resolvedHistory = this.state.messages.filter(function(m) {
          return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder && !m.isCancelled && !m.isBackgroundTask && !m.isError;
        });
        var boundedQ = buildBoundedChatMessages({
          platform: aiPlatform,
          model: aiModel,
          systemPrompt,
          projectId: id.projectId,
          history: resolvedHistory.concat([{ role: "user", content: llmComposed }])
        });
        var queuedBubble = { role: "user", content: composed, isPendingQueued: true, isSendingToServer: true, _dimSending: true, _localId: this._newLocalId(), _ts: wallClockNow() };
        if (key) queuedBubble._ownerKey = key;
        if (useBgQueue) queuedBubble._useBgQueue = true;
        var qStage = this._stageIndex(this.state.messages, stageId);
        if (qStage !== -1) {
          var qEx = this.state.messages[qStage];
          if (qEx._ts !== void 0) queuedBubble._ts = qEx._ts;
          if (qEx._dimSending === false) queuedBubble._dimSending = false;
          if (qEx._localId) queuedBubble._localId = qEx._localId;
          this.state.messages.splice(qStage, 1, queuedBubble);
        } else {
          this.state.messages.push(queuedBubble);
        }
        this.host.notify();
        this.updateHistoryCache();
        this.scrollForDispatch(stageId);
        var capturedComposed = composed, capturedPlatform = aiPlatform, capturedKey = key;
        var capturedQueuedLid = queuedBubble._localId;
        Promise.resolve(this._callProviderFor(aiPlatform, composed, boundedQ.messages, systemPrompt, aiModel, chatQueue, extractContent, fileUrls, id.projectId, id.owner)).then(function(result) {
          var sendingIdx = self.getHistoryCacheKey() !== capturedKey ? -1 : self.state.messages.findIndex(function(m) {
            return m.isSendingToServer && (m.isPendingQueued || m.isPendingInProcess) && m.role === "user" && !m._stageId && (m._ownerKey === void 0 || m._ownerKey === capturedKey);
          });
          var serverId = result && typeof result.id === "string" ? result.id : void 0;
          if (sendingIdx >= 0) {
            var upd = Object.assign({}, self.state.messages[sendingIdx], { isSendingToServer: false, _dimSending: false });
            if (serverId) upd._serverItemId = serverId;
            self.state.messages[sendingIdx] = upd;
            self.host.notify();
          }
          if (serverId) self._stampTurnWithItemId(capturedKey, capturedQueuedLid, void 0, serverId);
          if (result && result.poll && (result.status === "pending" || result.status === "running")) {
            var qp = self._fgPollWithEarlyProbe(result, serverId, void 0, {
              platform: capturedPlatform,
              projectId: id.projectId,
              owner: id.owner,
              ownerKey: capturedKey
            });
            if (serverId) self._trackPoll(serverId, "fg", qp);
            return qp.then(function(res) {
              if (isPollStopped(res)) return;
              return self.onQueuedSendResponse(capturedComposed, res, capturedPlatform, serverId, capturedKey);
            }).catch(function(err) {
              return self.onQueuedSendError(capturedComposed, err, serverId, capturedKey);
            });
          }
          return self.onQueuedSendResponse(capturedComposed, result, capturedPlatform, serverId, capturedKey);
        }).catch(function(err) {
          return self.onQueuedSendError(capturedComposed, err, void 0, capturedKey);
        });
        return;
      }
      var immediateUser = { role: "user", content: composed, _localId: this._newLocalId(), _ts: wallClockNow(), ...key ? { _ownerKey: key } : {} };
      var immediatePlaceholder = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, _localId: this._newLocalId(), ...key ? { _ownerKey: key } : {} };
      var iStage = this._stageIndex(this.state.messages, stageId);
      if (iStage !== -1) {
        var iEx = this.state.messages[iStage];
        if (iEx._ts !== void 0) immediateUser._ts = iEx._ts;
        if (iEx._localId) immediateUser._localId = iEx._localId;
        this.state.messages.splice(iStage, 1, immediateUser, immediatePlaceholder);
      } else {
        this.state.messages.push(immediateUser);
        this.state.messages.push(immediatePlaceholder);
      }
      this.host.notify();
      this.updateHistoryCache();
      this.state.sending = true;
      this.scrollForDispatch(stageId);
      var historyForLlm = this.state.messages.filter(function(m) {
        if (m === immediateUser) return false;
        return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder && !m.isCancelled && !m.isBackgroundTask && !m.isError;
      });
      historyForLlm.push({ role: "user", content: llmComposed });
      var bounded = buildBoundedChatMessages({
        platform: aiPlatform,
        model: aiModel,
        systemPrompt,
        projectId: id.projectId,
        history: historyForLlm
      });
      var immediateUserLid = immediateUser._localId, immediatePlaceholderLid = immediatePlaceholder._localId;
      var run = this.dispatchAgentRequest({
        key,
        projectId: id.projectId,
        owner: id.owner,
        aiPlatform,
        aiModel,
        systemPrompt,
        text: composed,
        boundedMessages: bounded.messages,
        userId: chatQueue,
        extractContent,
        fileUrls,
        // THE fix for a turn rendering twice after navigate-away-and-back. Until
        // this existed the immediate-send pair carried no server id for its whole
        // life (only the QUEUED path stamped one, off its ack), so nothing could
        // tell the local copy and the server's copy of the same turn apart. See
        // _stampTurnWithItemId.
        onItemId: function(itemId) {
          self._stampTurnWithItemId(key, immediateUserLid, immediatePlaceholderLid, itemId);
        }
      });
      Promise.resolve(run).catch(function() {
      }).then(function() {
        self.state.sending = false;
        if (!(self.host.isViewMounted() && self.getHistoryCacheKey() === key)) return;
        return Promise.resolve(self.typewriteLatestReply(key)).then(function() {
          self.host.scrollToBottomIfSticky(true);
        });
      });
    }
    /**
     * Scroll for a dispatch that is going out NOW, but never for one arriving late.
     *
     * A turn with attachments does not dispatch when the user hits Send: it waits out
     * its uploads and then its whole indexing chain, which is minutes
     * (awaitIndexingDrained). By then the reader has very often scrolled up into
     * history to pass the time, and the forcing scrollToBottom yanked them out of it
     * — and worse, force-pinned stickToBottom, which no-ops every method on the
     * scroll anchor and re-arms the queue-detect poll whose only bail is
     * !stickToBottom.
     *
     * `stageId` is the exact marker for that case: only the attachment path ever
     * produces one. The gesture itself was already paid for at stage time, where
     * stageOutgoingMessage forces the scroll while the user is still looking at the
     * composer. Deliberately NOT gated on "did we find the staged bubble" — a remount
     * rebuilds from the cache and the turn is appended rather than replaced, which is
     * just as late and just as unrequested.
     */
    scrollForDispatch(stageId) {
      if (stageId) this.host.scrollToBottomIfSticky(true);
      else this.host.scrollToBottom(true);
    }
    promoteNextBgQueuedToRunning() {
      if (this.state.messages.some(function(m) {
        return m.isPending && m.role === "assistant" && m.isBackgroundTask;
      })) return;
      var nextIdx = this.state.messages.findIndex(function(m) {
        return m.isPendingQueued && m.role === "user" && m.isBackgroundTask;
      });
      if (nextIdx === -1) return;
      var existing = this.state.messages[nextIdx];
      var promoted = { role: "user", content: existing.content, isPendingInProcess: true, isBackgroundTask: true };
      if (existing._indexFile) promoted._indexFile = existing._indexFile;
      if (existing._ts !== void 0) promoted._ts = existing._ts;
      if (existing._serverItemId !== void 0) promoted._serverItemId = existing._serverItemId;
      if (existing._ownerKey !== void 0) promoted._ownerKey = existing._ownerKey;
      this.state.messages[nextIdx] = promoted;
      var placeholder = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, isBackgroundTask: true };
      if (existing._serverItemId !== void 0) placeholder._serverItemId = existing._serverItemId;
      if (existing._ownerKey !== void 0) placeholder._ownerKey = existing._ownerKey;
      this.state.messages.splice(nextIdx + 1, 0, placeholder);
      this.host.notify();
    }
    promoteNextQueuedToRunning() {
      if (this.state.messages.some(function(m) {
        return m.isPending && m.role === "assistant" && !m.isBackgroundTask;
      })) return;
      var nextIdx = this.state.messages.findIndex(function(m) {
        return m.isPendingQueued && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue;
      });
      if (nextIdx === -1) return;
      var existing = this.state.messages[nextIdx];
      var promoted = { role: "user", content: existing.content, isPendingInProcess: true };
      if (existing.isBackgroundTask) promoted.isBackgroundTask = true;
      if (existing._indexFile) promoted._indexFile = existing._indexFile;
      if (existing._ts !== void 0) promoted._ts = existing._ts;
      if (existing._serverItemId !== void 0) promoted._serverItemId = existing._serverItemId;
      if (existing._ownerKey !== void 0) promoted._ownerKey = existing._ownerKey;
      if (existing.isSendingToServer) promoted.isSendingToServer = true;
      if (existing._dimSending) promoted._dimSending = true;
      if (existing._localId !== void 0) promoted._localId = existing._localId;
      this.state.messages[nextIdx] = promoted;
      var placeholder = { role: "assistant", content: "", isPending: true };
      if (existing._serverItemId !== void 0) placeholder._serverItemId = existing._serverItemId;
      if (existing._ownerKey !== void 0) placeholder._ownerKey = existing._ownerKey;
      this.state.messages.splice(nextIdx + 1, 0, placeholder);
      this.host.notify();
    }
    /**
     * The "Thinking..." placeholder belonging to the user bubble at `userIdx`, or -1.
     *
     * Every path that creates one puts it IMMEDIATELY after its user bubble
     * (promoteNextQueuedToRunning, the immediate-send pair, applyHistoryItemResolution),
     * so ownership is adjacency — modulo background bubbles, which get spliced in
     * around them. Taking the first pending assistant ANYWHERE below instead was a
     * hijack: a turn sent with attachments never gets a placeholder of its own
     * (promoteNextQueuedToRunning skips _useBgQueue turns) and now keeps the position
     * it was sent in, so an ordinary turn sent while its files indexed sits BELOW it
     * with a placeholder of its own — and the attachment turn's answer was rendered
     * as the answer to that unrelated question.
     */
    _ownThinkingIndex(userIdx, serverId) {
      if (userIdx < 0) return -1;
      for (var i = userIdx + 1; i < this.state.messages.length; i++) {
        var m = this.state.messages[i];
        if (!m) return -1;
        if (m.isBackgroundTask) continue;
        if (m.isPending && m.role === "assistant") {
          if (serverId && m._serverItemId && m._serverItemId !== serverId) return -1;
          return i;
        }
        return -1;
      }
      return -1;
    }
    resolveQueuedUserBubble(serverId) {
      var liveKey = this.getHistoryCacheKey();
      var isLocal = function(m) {
        return m._ownerKey === void 0 || m._ownerKey === liveKey;
      };
      var userIdx = -1;
      if (serverId) {
        userIdx = this.state.messages.findIndex(function(m) {
          return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) && m.role === "user" && !m.isBackgroundTask;
        });
      }
      if (userIdx === -1) {
        userIdx = this.state.messages.findIndex(function(m) {
          return m.isPendingInProcess && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue && isLocal(m);
        });
      }
      if (userIdx === -1) {
        userIdx = this.state.messages.findIndex(function(m) {
          return m.isPendingQueued && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue && isLocal(m);
        });
      }
      if (serverId && this.cancelledServerIds.has(serverId)) {
        this.cancelledServerIds.delete(serverId);
        if (userIdx >= 0) {
          var ex = this.state.messages[userIdx];
          this.state.messages[userIdx] = { role: "user", content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId, ...ex._ownerKey !== void 0 ? { _ownerKey: ex._ownerKey } : {} };
          var thIdx = this._ownThinkingIndex(userIdx, serverId);
          if (thIdx !== -1) this.state.messages.splice(thIdx, 1);
        }
        this.promoteNextQueuedToRunning();
        return void 0;
      }
      if (userIdx >= 0) {
        var exist = this.state.messages[userIdx];
        var repl = { role: "user", content: exist.content };
        if (exist._serverItemId !== void 0) repl._serverItemId = exist._serverItemId;
        if (exist._ownerKey !== void 0) repl._ownerKey = exist._ownerKey;
        if (exist._ts !== void 0) repl._ts = exist._ts;
        if (exist._localId !== void 0) repl._localId = exist._localId;
        this.state.messages[userIdx] = repl;
      }
      var thinkingIdx = this._ownThinkingIndex(userIdx, serverId);
      return thinkingIdx !== -1 ? thinkingIdx : userIdx >= 0 ? userIdx + 1 : -1;
    }
    insertAtTarget(msg, targetIdx) {
      if (msg && msg.role === "assistant" && msg._ts === void 0) msg._ts = wallClockNow();
      var tgt = targetIdx >= 0 ? this.state.messages[targetIdx] : void 0;
      var replaceable = !!tgt && !!tgt.isPending && !tgt.isBackgroundTask && this._isOwnPlaceholderOf(targetIdx, this._owningUserIndex(targetIdx));
      if (replaceable) this.state.messages[targetIdx] = msg;
      else if (targetIdx >= 0) this.state.messages.splice(targetIdx, 0, msg);
      else this.state.messages.push(msg);
    }
    /**
     * The server's OWN copy of this turn is already on screen.
     *
     * A first-page fetch can land between the server settling the item and this
     * poll's tick, and now that the local bubbles carry the item id
     * (_stampTurnWithItemId) the rescue correctly drops them and renders the
     * server's settled pair instead. There is then nothing left to resolve: the
     * -1 fallback would push the answer in a SECOND time at the bottom of the list,
     * and the positional fallbacks would hijack some other turn's bubble.
     *
     * The USER bubble counts, not just a settled assistant: an item whose answer is
     * empty produces no assistant bubble at all in the mapper, and that variant
     * would otherwise still bottom-push "No text response received...". While a turn
     * is genuinely live its user bubble is always pending (the queued branch sets
     * isPendingQueued, promoteNextQueuedToRunning sets isPendingInProcess), so this
     * cannot fire early.
     */
    _turnAlreadyRendered(serverId) {
      if (!serverId) return false;
      return this.state.messages.some(function(m) {
        return m._serverItemId === serverId && !m.isPending && !m.isPendingQueued && !m.isPendingInProcess;
      });
    }
    onQueuedSendResponse(_composed, response, platform, serverId, ownerKey) {
      if (serverId) this.historyItemPolls.delete(serverId);
      if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
        var offReply = isErrorResponseBody(response) ? { role: "assistant", content: getErrorMessage(response), isError: true } : { role: "assistant", content: ((platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response)) || "").trim() || "No text response received from AI provider." };
        this._applyReplyToCache(ownerKey, offReply, serverId);
        if (serverId) this.cancelledServerIds.delete(serverId);
        return;
      }
      if (this._turnAlreadyRendered(serverId)) {
        if (serverId) this.cancelledServerIds.delete(serverId);
        this.host.notify();
        this.updateHistoryCache();
        return;
      }
      var targetIdx = this.resolveQueuedUserBubble(serverId);
      if (targetIdx === void 0) {
        this.host.notify();
        this.updateHistoryCache();
        return;
      }
      if (isErrorResponseBody(response)) {
        this.insertAtTarget({ role: "assistant", content: getErrorMessage(response), isError: true }, targetIdx);
      } else {
        var answer = platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response);
        answer = (answer || "").trim() || "No text response received from AI provider.";
        var lid = this._newLocalId();
        if (targetIdx >= 0 && this.state.messages[targetIdx] && this.state.messages[targetIdx].isPending) {
          var qPainted = this._paintedTextAt(targetIdx);
          var prevQ = this.state.messages[targetIdx] || {};
          var qSettled = { role: "assistant", content: qPainted, _localId: lid };
          if (prevQ._serverItemId) qSettled._serverItemId = prevQ._serverItemId;
          if (prevQ._ownerKey) qSettled._ownerKey = prevQ._ownerKey;
          this.state.messages[targetIdx] = qSettled;
          this.host.notify();
          this.enqueueTypewrite(targetIdx, answer, lid, qPainted);
        } else if (targetIdx >= 0) {
          this.state.messages.splice(targetIdx, 0, { role: "assistant", content: "", _localId: lid });
          this.host.notify();
          this.enqueueTypewrite(targetIdx, answer, lid);
        } else {
          var aiIdx = this.state.messages.length;
          this.state.messages.push({ role: "assistant", content: "", _localId: lid });
          this.host.notify();
          this.enqueueTypewrite(aiIdx, answer, lid);
        }
      }
      this._removeStrayPendingAssistants();
      this.promoteNextQueuedToRunning();
      this.updateHistoryCache();
      this.host.notify();
      this.host.scrollToBottomIfSticky(true);
    }
    onQueuedSendError(_composed, err, serverId, ownerKey) {
      if (serverId) this.historyItemPolls.delete(serverId);
      if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
        var isGone = err && (err.code === "NOT_EXISTS" || err.body && err.body.code === "NOT_EXISTS");
        this._applyReplyToCache(ownerKey, isGone ? { role: "assistant", content: "Request was cancelled.", isError: true } : { role: "assistant", content: getErrorMessage(err), isError: true }, serverId);
        if (serverId) this.cancelledServerIds.delete(serverId);
        return;
      }
      if (this._turnAlreadyRendered(serverId)) {
        if (serverId) this.cancelledServerIds.delete(serverId);
        this.host.notify();
        this.updateHistoryCache();
        return;
      }
      var isNotExists = err && (err.code === "NOT_EXISTS" || err.body && err.body.code === "NOT_EXISTS");
      if (isNotExists) {
        var userIdx = serverId ? this.state.messages.findIndex(function(m) {
          return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) && m.role === "user" && !m.isBackgroundTask;
        }) : this.state.messages.findIndex(function(m) {
          return m.isPendingInProcess && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue;
        });
        if (!serverId && userIdx === -1) {
          userIdx = this.state.messages.findIndex(function(m) {
            return m.isPendingQueued && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue;
          });
        }
        if (userIdx >= 0) {
          var ex = this.state.messages[userIdx];
          var repl = { role: "user", content: ex.content, isCancelled: true };
          if (ex._serverItemId !== void 0) repl._serverItemId = ex._serverItemId;
          this.state.messages[userIdx] = repl;
        }
        if (serverId) {
          var thById = this.state.messages.findIndex(function(m) {
            return m._serverItemId === serverId && m.isPending && m.role === "assistant" && !m.isBackgroundTask;
          });
          if (thById !== -1) this.state.messages.splice(thById, 1);
          else if (userIdx >= 0) {
            var thPos = this.state.messages.findIndex(function(m, i) {
              return i > userIdx && m.isPending && m.role === "assistant" && !m.isBackgroundTask;
            });
            if (thPos !== -1) this.state.messages.splice(thPos, 1);
          }
        } else if (userIdx >= 0) {
          var thPos2 = this.state.messages.findIndex(function(m, i) {
            return i > userIdx && m.isPending && m.role === "assistant" && !m.isBackgroundTask;
          });
          if (thPos2 !== -1) this.state.messages.splice(thPos2, 1);
        }
        if (serverId) this.cancelledServerIds.delete(serverId);
        this._removeStrayPendingAssistants();
        this.promoteNextQueuedToRunning();
        this.updateHistoryCache();
        this.host.notify();
        this.host.scrollToBottomIfSticky(true);
        return;
      }
      var targetIdx = this.resolveQueuedUserBubble(serverId);
      if (targetIdx === void 0) {
        this.host.notify();
        this.updateHistoryCache();
        return;
      }
      this.insertAtTarget({ role: "assistant", content: getErrorMessage(err), isError: true }, targetIdx);
      this._removeStrayPendingAssistants();
      this.promoteNextQueuedToRunning();
      this.updateHistoryCache();
      this.host.notify();
      this.host.scrollToBottomIfSticky(true);
    }
    cancelQueuedMessage(msg, idx) {
      var self = this;
      var id = this.host.getIdentity();
      var serverId = msg._serverItemId;
      if (!serverId || msg._cancelling) return;
      var platform = id.platform;
      if (platform !== "claude" && platform !== "openai") return;
      var url = platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
      var queueBase = id.userId || id.projectId;
      var queue = msg.isBackgroundTask || msg._useBgQueue ? bgIndexingQueueName(queueBase) : queueBase;
      var at = this.state.messages[idx] && this.state.messages[idx]._serverItemId === serverId && this.state.messages[idx].role === msg.role ? idx : this.state.messages.findIndex(function(m) {
        return m._serverItemId === serverId && m.role === msg.role;
      });
      if (at !== -1) {
        this.state.messages[at] = Object.assign({}, this.state.messages[at], { _cancelling: true, _cancelError: void 0 });
      }
      this.host.notify();
      Promise.resolve(this.host.cancelRequest({
        url,
        method: "POST",
        id: serverId,
        queue,
        service: id.projectId,
        owner: id.owner
      })).then(function(result) {
        if (result && result.removed) {
          self.cancelledServerIds.add(serverId);
          self._stopPoll(serverId);
          var qi = self.bgTaskQueue.findIndex(function(e) {
            return e.id === serverId;
          });
          if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
          var removeIdx = self.state.messages.findIndex(function(m) {
            return m._serverItemId === serverId && (m.isPendingQueued || m.isPendingInProcess) && m.role === "user";
          });
          if (removeIdx !== -1) {
            var wasMsg = self.state.messages[removeIdx];
            var cancelledMsg = { role: "user", content: wasMsg.content, isCancelled: true, _serverItemId: serverId };
            if (wasMsg.isBackgroundTask) cancelledMsg.isBackgroundTask = true;
            if (wasMsg._indexFile) cancelledMsg._indexFile = wasMsg._indexFile;
            if (wasMsg._useBgQueue) cancelledMsg._useBgQueue = true;
            if (wasMsg._ownerKey !== void 0) cancelledMsg._ownerKey = wasMsg._ownerKey;
            self.state.messages[removeIdx] = cancelledMsg;
            var thById = self.state.messages.findIndex(function(m) {
              return m._serverItemId === serverId && m.isPending && m.role === "assistant";
            });
            if (thById !== -1) self.state.messages.splice(thById, 1);
            else {
              var thPos = self.state.messages.findIndex(function(m, i) {
                return i > removeIdx && m.isPending && m.role === "assistant" && (msg.isBackgroundTask ? !!m.isBackgroundTask : !m.isBackgroundTask);
              });
              if (thPos !== -1) self.state.messages.splice(thPos, 1);
            }
            if (msg.isBackgroundTask) self.promoteNextBgQueuedToRunning();
            else self.promoteNextQueuedToRunning();
            self.updateHistoryCache();
          }
          self.host.notify();
        } else {
          var errMsg = result && typeof result.message === "string" && result.message ? result.message : "Could not remove from queue.";
          var ci = self.state.messages.findIndex(function(m) {
            return m._serverItemId === serverId && m.role === "user";
          });
          if (ci !== -1) {
            self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg });
            self.host.notify();
          }
        }
      }).catch(function(err) {
        var errMsg = err && typeof err.message === "string" && err.message ? err.message : "Could not remove from queue.";
        var ci = self.state.messages.findIndex(function(m) {
          return m._serverItemId === serverId && m.role === "user";
        });
        if (ci !== -1) {
          self.state.messages[ci] = Object.assign({}, self.state.messages[ci], { _cancelling: false, _cancelError: errMsg });
          self.host.notify();
        }
      });
    }
    /**
     * Stop indexing a file, from its collapsed row — every pass at once, not just
     * the bubble the user happens to see.
     *
     * A big file is indexed as a CHAIN of passes, so cancelling only the live one
     * accomplishes nothing: the next pass is dispatched as soon as it settles.
     * Three things end the chain:
     *   1. every queued/running pass of this file is cancelled server-side
     *      (csr-cancel deletes a queued row and flags a running one "cancelled",
     *      which is also the worker's gate for NOT enqueueing the next window);
     *   2. the file is remembered in cancelledIndexKeys, so the client-driven
     *      resume (maybeResumeIndexing) stops dispatching CONTINUE passes; and
     *   3. any of its passes still sitting in bgTaskQueue is dropped by the next
     *      drain rather than surfacing a fresh "Indexing…" bubble; and
     *   4. the RUN is remembered (state.stoppedIndexIds), because none of the above
     *      necessarily leaves a mark on the conversation — see below — and without
     *      it the collapsed row reported the stopped file as finished.
     *
     * Records already written by the passes that DID run are kept — this stops the
     * work, it does not undo it.
     */
    cancelIndexingGroup(group) {
      var self = this;
      if (!group || !group.key) return;
      var idn = this.host.getIdentity();
      var scoped = indexScopeKey(idn.projectId, idn.platform) + "|" + group.key;
      this.cancelledIndexKeys.add(scoped);
      if (!group.finished) {
        var stoppedIds = {};
        for (var sk in this.state.stoppedIndexIds) stoppedIds[sk] = true;
        (group.members || []).forEach(function(m) {
          var sid = m && m.msg && m.msg._serverItemId;
          if (sid) stoppedIds[sid] = true;
        });
        this.bgTaskQueue.forEach(function(e) {
          if (e && e.id && self._indexKeyOf(e) === scoped) stoppedIds[e.id] = true;
        });
        this.state.stoppedIndexIds = stoppedIds;
        var runPath = group.path || "";
        if (!runPath) {
          (group.members || []).some(function(m) {
            var p = m && m.msg && m.msg._indexFile && m.msg._indexFile.path;
            if (p) {
              runPath = p;
              return true;
            }
            return false;
          });
        }
        if (!runPath) {
          this.bgTaskQueue.some(function(e) {
            if (e && e.storagePath && self._indexKeyOf(e) === scoped) {
              runPath = e.storagePath;
              return true;
            }
            return false;
          });
        }
        if (runPath) {
          var ident = this.host.getIdentity();
          if (ident && ident.projectId) {
            upsertIndexRunRecordSafe(ident.projectId, runPath, { status: "cancelled", finished: Date.now() });
          }
        }
      }
      this._adoptWorkerIndexingPasses(0);
      var ids = group.cancellableIds || [];
      if (!ids.length) {
        this.host.notify();
        return;
      }
      ids.forEach(function(serverId) {
        var idx = self.state.messages.findIndex(function(m) {
          return m._serverItemId === serverId && m.role === "user" && (m.isPendingQueued || m.isPendingInProcess);
        });
        if (idx === -1) return;
        self.cancelQueuedMessage(self.state.messages[idx], idx);
      });
    }
    // --- typewriter -------------------------------------------------------
    // Reveal `fullText` into a message bubble at a constant wall-clock RATE
    // (chars/second) driven by requestAnimationFrame, rather than a fixed number
    // of characters per fixed-delay tick. This is what keeps typing smooth and
    // cheap on slow machines:
    //
    //   * Each frame reveals `elapsed_ms * CHARS_PER_SEC` characters, so the
    //     visual speed is the same regardless of how long a frame actually took.
    //   * As the bubble's markdown grows, each re-render gets more expensive, so
    //     frames get longer — which makes each frame reveal MORE characters and
    //     therefore do FEWER, larger renders. That converts the old O(n^2)
    //     "re-render the whole growing string once per 3 characters" (which got
    //     slower and slower and pegged the CPU) into roughly O(n): the number of
    //     renders self-throttles to what the machine can actually paint.
    //   * rAF paces us to the browser's paint cycle and pauses in background
    //     tabs, so we never queue work faster than it can be drawn.
    //
    // `paintedText` is what a LIVE STREAM already put in this bubble. The reveal
    // starts from the point the two texts stop agreeing rather than from zero: the
    // authoritative answer still replaces the live one character for character (it is
    // the only source of truth, and this method writes fullText and nothing else), but
    // retyping a paragraph the reader has just watched arrive is the one thing that
    // would make a streamed turn look worse than an unstreamed one.
    typewriteIntoIndex(idx, fullText, localId, paintedText) {
      var self = this;
      if (!fullText) return Promise.resolve();
      var CHARS_PER_SEC = 300;
      var MIN_STEP = 1;
      var MAX_FRAME_MS = 1e3;
      var regions = [], m;
      var fenceRegex = /```[^\n`]+?\.[^\s.`]+\n[\s\S]*?```/g;
      while ((m = fenceRegex.exec(fullText)) !== null) regions.push({ start: m.index, end: m.index + m[0].length });
      var linkRegex = createInlineLinkRegex();
      while ((m = linkRegex.exec(fullText)) !== null) regions.push({ start: m.index, end: m.index + m[0].length });
      regions.sort(function(a, b) {
        return a.start - b.start;
      });
      this.state.typing = true;
      this.state.typingAbort = false;
      var i = paintedText ? typewriterResumeIndex(paintedText, fullText, regions) : 0;
      var last = nowMs();
      return new Promise(function(resolve) {
        var done = false;
        var doc = _g.document;
        function isHidden() {
          return !!(doc && doc.hidden);
        }
        function cleanup() {
          if (doc && doc.removeEventListener) doc.removeEventListener("visibilitychange", onVisibility);
        }
        function finish() {
          if (done) return;
          done = true;
          cleanup();
          var fi = localId ? self.state.messages.findIndex(function(mm) {
            return mm._localId === localId;
          }) : idx;
          if (fi !== -1) {
            var t = self.state.messages[fi];
            if (t) {
              t.content = fullText;
              self.host.refreshMessageBubble(fi);
            }
          }
          self.state.typing = false;
          resolve();
        }
        function onVisibility() {
          if (isHidden()) finish();
        }
        if (doc && doc.addEventListener) doc.addEventListener("visibilitychange", onVisibility);
        function frame(t) {
          if (done) return;
          if (self.state.typingAbort || i >= fullText.length || isHidden()) {
            finish();
            return;
          }
          var dt = t - last;
          last = t;
          if (!(dt > 0)) dt = 16;
          if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;
          var step = Math.round(dt * CHARS_PER_SEC / 1e3);
          if (step < MIN_STEP) step = MIN_STEP;
          var next = Math.min(fullText.length, i + step);
          for (var changed = true; changed; ) {
            changed = false;
            for (var k = 0; k < regions.length; k++) {
              var r = regions[k];
              if (next > r.start && i < r.end && r.end > next) {
                next = r.end;
                changed = true;
              }
            }
          }
          if (next > fullText.length) next = fullText.length;
          i = next;
          var currentIdx = localId ? self.state.messages.findIndex(function(mm) {
            return mm._localId === localId;
          }) : idx;
          if (currentIdx === -1) {
            finish();
            return;
          }
          var target = self.state.messages[currentIdx];
          if (!target) {
            finish();
            return;
          }
          target.content = fullText.slice(0, i);
          self.host.refreshMessageBubble(currentIdx);
          self.host.scrollToBottomIfSticky();
          nextFrame(frame);
        }
        if (isHidden()) {
          finish();
          return;
        }
        nextFrame(frame);
      });
    }
    enqueueTypewrite(idx, fullText, localId, paintedText) {
      var self = this;
      var target = this.state.messages[idx];
      if (target && target._ts === void 0) target._ts = wallClockNow();
      if (!this.typewriterQueue) this.typewriterQueue = Promise.resolve();
      this.typewriterQueue = this.typewriterQueue.then(function() {
        return self.typewriteIntoIndex(idx, fullText, localId, paintedText);
      });
      return this.typewriterQueue;
    }
    // --- cache+resume immediate-send rendering -----------------------------
    // Render the just-resolved reply (read from aiChatHistoryCache) into the
    // pending assistant bubble, character-by-character. Runs AFTER the reply is
    // already in the cache (dispatchAgentRequest appended it); errors are shown
    // instantly (no typing). Promotes the next queued message immediately so its
    // "Thinking…" bubble appears without waiting for this typewriter to finish.
    typewriteLatestReply(key) {
      var cached = this.aiChatHistoryCache[key];
      if (!cached || !cached.messages.length) return Promise.resolve();
      var latest;
      for (var i = cached.messages.length - 1; i >= 0; i--) {
        var m = cached.messages[i];
        if (m.role === "assistant" && !m.isPending) {
          latest = m;
          break;
        }
      }
      if (!latest) return Promise.resolve();
      var pendingIdx = this.state.messages.findIndex(function(mm) {
        return mm.isPending && mm.role === "assistant" && !mm.isBackgroundTask;
      });
      if (pendingIdx === -1) return Promise.resolve();
      if (latest.isError || !latest.content) {
        this.state.messages[pendingIdx] = { role: "assistant", content: latest.content || "", isError: !!latest.isError };
        this._removeStrayPendingAssistants();
        this.host.notify();
        this.promoteNextQueuedToRunning();
        return Promise.resolve();
      }
      var painted = this._paintedTextAt(pendingIdx);
      var lid = this._newLocalId();
      var prevSettled = this.state.messages[pendingIdx] || {};
      var settled = { role: "assistant", content: painted, isPending: false, _localId: lid };
      if (prevSettled._serverItemId) settled._serverItemId = prevSettled._serverItemId;
      if (prevSettled._ownerKey) settled._ownerKey = prevSettled._ownerKey;
      this.state.messages[pendingIdx] = settled;
      this._removeStrayPendingAssistants();
      this.host.notify();
      this.promoteNextQueuedToRunning();
      return this.enqueueTypewrite(pendingIdx, latest.content, lid, painted);
    }
    // Remove leftover non-background pending ("Thinking…") assistant bubbles: the
    // duplicate that appears when a concurrent history refetch re-maps the still-
    // "running" turn into a pending placeholder (with a real _serverItemId) while the
    // local pending bubble (no _serverItemId) is rescued and re-appended (see the
    // loadHistory rescue below), and the orphan a resolve leaves when it splices its
    // reply beside a placeholder instead of into it. Each resolve path only replaces
    // ONE pending bubble, so without this a stray "Thinking…" survives forever next to
    // the reply. MUST run AFTER the resolved bubble has been made non-pending and
    // BEFORE promoteNext*() (which only adds a Thinking once none remains).
    //
    // It used to take EVERY one, on the premise that there is at most one at a time
    // because promoteNext* refuses to add a second. That premise never covered the
    // immediate-send path, which creates its pair directly — and a turn sent with
    // attachments does not block the composer and resolves on its own queue, so an
    // ordinary question asked while files index is in flight, with a placeholder of
    // its own, exactly when the attachment turn resolves. Sweeping it left that
    // question with no spinner and, worse, nowhere for its answer to land:
    // typewriteLatestReply bails when there is no pending assistant, so the reply
    // reached the cache and never the screen.
    //
    // The discriminator is the owning USER bubble. A live immediate send's user bubble
    // carries NO pending flags (its in-flight-ness lives in state.sending), while every
    // duplicate this sweep is for belongs to a user bubble that is still pending — and
    // an orphan has no user bubble above it at all.
    _removeStrayPendingAssistants() {
      for (var k = this.state.messages.length - 1; k >= 0; k--) {
        var m = this.state.messages[k];
        if (!m || !m.isPending || m.role !== "assistant" || m.isBackgroundTask) continue;
        if (m._streaming) continue;
        if (this._isLiveImmediatePlaceholder(k)) continue;
        this.state.messages.splice(k, 1);
      }
    }
    /** Index of the USER bubble the message at `idx` belongs to — the nearest one
     *  above it, stepping over background bubbles (a file's indexing rows are
     *  inserted between turns). -1 when the nearest thing above is not a user turn,
     *  which for a placeholder means it is an orphan. */
    _owningUserIndex(idx) {
      for (var j = idx - 1; j >= 0; j--) {
        var p = this.state.messages[j];
        if (!p) return -1;
        if (p.isBackgroundTask) continue;
        return p.role === "user" ? j : -1;
      }
      return -1;
    }
    /** The bubble at `idx` is the "Thinking…" of a DIFFERENT turn that is still
     *  waiting for its answer, so the sweep above must leave it alone. */
    _isLiveImmediatePlaceholder(idx) {
      var ui = this._owningUserIndex(idx);
      if (ui === -1) return false;
      var p = this.state.messages[ui];
      return !p.isPending && !p.isPendingQueued && !p.isPendingInProcess && !p.isPendingOlder && !p.isSendingToServer && !p.isCancelled;
    }
    /** A pending assistant at `idx` is the placeholder OF the turn above it, so a
     *  reply may take its slot. Every path that makes one copies the parent's
     *  _serverItemId (or neither has one yet), so a mismatch means the slot belongs to
     *  some other request and the reply must be spliced in beside it, not on top. */
    _isOwnPlaceholderOf(idx, userIdx) {
      if (userIdx === -1) return false;
      var ph = this.state.messages[idx], u = this.state.messages[userIdx];
      if (!ph || !u) return false;
      if (ph._serverItemId === void 0 || u._serverItemId === void 0) return true;
      return ph._serverItemId === u._serverItemId;
    }
    // Drop the pending flags on the resolved turn's USER bubble (preserving its
    // content + background-task marker). Needed because a bg "Indexing:" turn's user
    // bubble carries isPendingInProcess; leaving it set keeps the bubble visually
    // stuck and keeps its bgTaskQueue entry alive forever.
    _clearPendingUserBubble(itemId) {
      var uIdx = this.state.messages.findIndex(function(m) {
        return m.role === "user" && m._serverItemId === itemId && (m.isPendingInProcess || m.isPendingQueued || m.isSendingToServer);
      });
      if (uIdx === -1) return;
      var u = this.state.messages[uIdx];
      var cleaned = { role: "user", content: u.content, _serverItemId: itemId };
      if (u.isBackgroundTask) cleaned.isBackgroundTask = true;
      if (u._ts !== void 0) cleaned._ts = u._ts;
      if (u._indexFile) cleaned._indexFile = u._indexFile;
      this.state.messages[uIdx] = cleaned;
    }
    // If an immediate-send request for the current cache key is still in flight
    // (e.g. the view unmounted then remounted mid-request), show the sending
    // state, await it, then render the reply from the cache. Skipped when the
    // list already has its own pending/queued bubbles (those resolve via their
    // own polls). The displayed reply also lands via dispatchComposedMessage's
    // own finally if the view never unmounted — this is the remount recovery.
    resumePendingRequest(token) {
      var self = this;
      var key = this.getHistoryCacheKey();
      var pending = key ? this.pendingAgentRequests[key] : void 0;
      if (!pending) return Promise.resolve();
      if (this.state.messages.some(function(m) {
        return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue;
      })) return Promise.resolve();
      this.state.sending = true;
      this.host.scrollToBottomIfSticky(true);
      return Promise.resolve(pending).catch(function() {
      }).then(function() {
        if (token !== self.state.gateRefreshToken) return;
        self.state.sending = false;
        return Promise.resolve(self.typewriteLatestReply(key)).then(function() {
          self.host.scrollToBottomIfSticky(true);
        });
      });
    }
    // --- background-task resolution + drain -------------------------------
    handleHistoryItemResolution(itemId, response, platform) {
      var indexRef = this._indexRefOfItem(itemId);
      this.applyHistoryItemResolution(itemId, response, platform);
      this.promoteNextBgQueuedToRunning();
      this.drainBgTaskQueue();
      if (indexRef) this._followWorkerIndexingChain(indexRef.name, indexRef.mime);
    }
    /** The file an already-rendered background pass is about, off its request
     *  bubble. Null for an ordinary turn, which is most of them. */
    _indexRefOfItem(itemId) {
      if (!itemId) return null;
      for (var i = 0; i < this.state.messages.length; i++) {
        var m = this.state.messages[i];
        if (m._serverItemId !== itemId || m.role !== "user" || !m.isBackgroundTask) continue;
        return m._indexFile || null;
      }
      return null;
    }
    /**
     * Settle a turn the server reports as cancelled: the request bubble goes to its
     * cancelled form and the "Thinking..." placeholder goes away. The same shape
     * cancelQueuedMessage produces locally, so a cancel this client made and one it
     * merely found out about render identically — and an indexing pass keeps the
     * markers that hold it in its file's collapsed row.
     */
    _settleCancelledItem(itemId) {
      var uIdx = this.state.messages.findIndex(function(m) {
        return m.role === "user" && m._serverItemId === itemId && !m.isCancelled;
      });
      if (uIdx !== -1) {
        var u = this.state.messages[uIdx];
        var cancelled = { role: "user", content: u.content, isCancelled: true, _serverItemId: itemId };
        if (u.isBackgroundTask) cancelled.isBackgroundTask = true;
        if (u._indexFile) cancelled._indexFile = u._indexFile;
        if (u._useBgQueue) cancelled._useBgQueue = true;
        if (u._ownerKey !== void 0) cancelled._ownerKey = u._ownerKey;
        if (u._ts !== void 0) cancelled._ts = u._ts;
        this.state.messages[uIdx] = cancelled;
      }
      var pIdx = this.state.messages.findIndex(function(m) {
        return m.isPending && m.role === "assistant" && m._serverItemId === itemId;
      });
      if (pIdx !== -1) this.state.messages.splice(pIdx, 1);
      this.cancelledServerIds.delete(itemId);
      this._removeStrayPendingAssistants();
      this.host.notify();
      this.updateHistoryCache();
    }
    /**
     * A poll that came back saying the request was CANCELLED, rather than with an
     * answer.
     *
     * The server keeps a cancelled request as a terminal row instead of deleting it
     * (that row is the durable record of the stop, and the chat history it belongs
     * to), so a poll still running when the cancel lands now RESOLVES on it. It used
     * to reject with NOT_EXISTS, and the resolution path below reads a status object
     * as an answer with no text — which would stamp "No text response received from
     * AI provider" over a turn the user had just stopped.
     *
     * Reachable whenever the poll was not stopped by whoever cancelled: another tab,
     * another device, or the row being cancelled server-side by the file's own stop.
     */
    _isCancelledPollResult(response) {
      if (!response || typeof response !== "object" || response.status !== "cancelled") return false;
      if (response.content !== void 0 || response.output !== void 0) return false;
      return response.queue_name !== void 0 || response.in_queue !== void 0;
    }
    applyHistoryItemResolution(itemId, response, platform) {
      this.historyItemPolls.delete(itemId);
      if (this._isCancelledPollResult(response)) {
        this._settleCancelledItem(itemId);
        return;
      }
      var isErr = isErrorResponseBody(response);
      var answer = isErr ? getErrorMessage(response) : ((platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response)) || "").trim();
      var reportedComplete = !isErr && !!answer && answer.indexOf(INDEXING_COMPLETE_MARKER) !== -1;
      var stripMarker = function(t) {
        return reportedComplete ? t.split(INDEXING_COMPLETE_MARKER).join("").trim() : t;
      };
      var idx = this.state.messages.findIndex(function(m) {
        return m.isPending && m._serverItemId === itemId;
      });
      if (idx !== -1) {
        this._clearPendingUserBubble(itemId);
        var wasBgTask = !!this.state.messages[idx].isBackgroundTask;
        if (isErr) {
          this.state.messages[idx] = { role: "assistant", content: answer, isError: true, _serverItemId: itemId };
          if (wasBgTask) this.state.messages[idx].isBackgroundTask = true;
          this.host.notify();
          this.updateHistoryCache();
          return;
        }
        var text = answer || "No text response received from AI provider.";
        if (wasBgTask) {
          this.state.messages[idx] = { role: "assistant", content: stripMarker(text) || EMPTY_INDEXING_REPLY, isBackgroundTask: true, _serverItemId: itemId, ...reportedComplete ? { _indexComplete: true } : {} };
          this.host.notify();
          this.updateHistoryCache();
          return;
        }
        var hPainted = this._paintedTextAt(idx);
        var lid = this._newLocalId();
        this.state.messages[idx] = { role: "assistant", content: hPainted, _localId: lid, _serverItemId: itemId };
        this.host.notify();
        this.enqueueTypewrite(idx, text, lid, hPainted);
        this.updateHistoryCache();
        return;
      }
      var userIdx = this.state.messages.findIndex(function(m) {
        return m.role === "user" && m._serverItemId === itemId && (m.isPendingQueued || m.isPendingInProcess);
      });
      if (userIdx === -1) return;
      var ex = this.state.messages[userIdx];
      var settledUser = { role: "user", content: ex.content, _serverItemId: itemId };
      if (ex.isBackgroundTask) settledUser.isBackgroundTask = true;
      if (ex._ts !== void 0) settledUser._ts = ex._ts;
      if (ex._indexFile) settledUser._indexFile = ex._indexFile;
      if (ex._useBgQueue) settledUser._useBgQueue = true;
      this.state.messages[userIdx] = settledUser;
      if (isErr) {
        var errReply = { role: "assistant", content: answer, isError: true, _serverItemId: itemId };
        if (ex.isBackgroundTask) errReply.isBackgroundTask = true;
        this.state.messages.splice(userIdx + 1, 0, errReply);
        this.host.notify();
        this.updateHistoryCache();
        return;
      }
      var text2 = answer || "No text response received from AI provider.";
      if (ex.isBackgroundTask) {
        this.state.messages.splice(userIdx + 1, 0, { role: "assistant", content: stripMarker(text2) || EMPTY_INDEXING_REPLY, isBackgroundTask: true, _serverItemId: itemId, ...reportedComplete ? { _indexComplete: true } : {} });
        this.host.notify();
        this.updateHistoryCache();
        return;
      }
      var lid2 = this._newLocalId();
      var reply = { role: "assistant", content: "", _localId: lid2, _serverItemId: itemId };
      this.state.messages.splice(userIdx + 1, 0, reply);
      this.host.notify();
      this.enqueueTypewrite(userIdx + 1, text2, lid2);
      this.updateHistoryCache();
    }
    /** How a bg task maps onto a collapsed row: the row's own key (storage path
     *  when known, else the filename), scoped to the chat it belongs to. A storage
     *  path is project-relative ("report.xlsx"), and ONE ChatSession serves every
     *  project — unscoped, stopping a file in one project would silently suppress
     *  the same filename's continuations in another. */
    _indexKeyOf(entry2) {
      if (!entry2) return "";
      var file = entry2.storagePath || entry2.filename;
      if (!file) return "";
      return indexScopeKey(entry2.projectId, entry2.platform) + "|" + file;
    }
    /**
     * Reconcile the bg queue with the files the user has stopped.
     *
     * A FIRST pass (no resumePass) is a fresh indexing request — a re-upload, or a
     * Reindex from the file manager — so it LIFTS the stop: the key is a storage
     * path, and without this an earlier cancel would silently kill every future
     * index of the same path. A continuation of a stopped file is dropped instead,
     * covering the pass that was dispatched in the moment before the cancel landed.
     *
     * "Fresh" is the load-bearing word, and it used to be missing. A run's OWN first
     * pass sits in this queue for as long as it runs (entries are only dropped once
     * their bubble settles), so stopping a file during its first pass — which is
     * exactly when a user who has just uploaded it does — met that first-pass entry
     * on the very next drain and lifted the stop the user had just asked for. The
     * chain then carried on, one worker-minted window after another, with nothing
     * client-side left to suppress it. The ids recorded at stop time are what tells
     * the two apart: a pass that was already there when the user hit Stop cannot be
     * the new request that lifts it.
     */
    _applyIndexCancellations() {
      if (!this.cancelledIndexKeys.size) return;
      var surfaced = {};
      this.state.messages.forEach(function(m) {
        if (!m._serverItemId) return;
        if (m.isPending || m.isPendingQueued || m.isPendingInProcess) surfaced[m._serverItemId] = true;
      });
      for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
        var entry2 = this.bgTaskQueue[i];
        var key = this._indexKeyOf(entry2);
        if (!key || !this.cancelledIndexKeys.has(key)) continue;
        if (!entry2.resumePass && !this.state.stoppedIndexIds[entry2.id]) {
          this.cancelledIndexKeys.delete(key);
          continue;
        }
        if (surfaced[entry2.id]) continue;
        this.bgTaskQueue.splice(i, 1);
        this._stopPoll(entry2.id);
        this._cancelServerItem(entry2.id);
      }
    }
    /**
     * Cancel any live pass of a stopped file that turned up on its own.
     *
     * The client is not the only thing that continues a file: for PDFs and (when
     * windowed indexing is on) text/grid files the WORKER enqueues the next window
     * itself, and that pass reaches the chat through the history poll, never
     * through bgTaskQueue. The worker's own gate stops the chain when the running
     * row is cancelled — but if the row had already finished when the user hit
     * stop, the next window was queued a moment earlier and still arrives. Stop it
     * here rather than making the user hit stop again.
     *
     * Runs from drainBgTaskQueue, which both clients call after a history load.
     */
    _sweepCancelledIndexing() {
      if (!this.cancelledIndexKeys.size) return;
      var self = this;
      var chatKey = this.getHistoryCacheKey();
      var targets = [];
      this.state.messages.forEach(function(m, i) {
        if (!m.isBackgroundTask || m.role !== "user" || !m._serverItemId) return;
        if (m._cancelling || m.isSendingToServer) return;
        if (!(m.isPendingQueued || m.isPendingInProcess)) return;
        var ref = m._indexFile;
        var file = ref && (ref.path || ref.name);
        if (!file || !self.cancelledIndexKeys.has(chatKey + "|" + file)) return;
        targets.push({ msg: m, idx: i });
      });
      targets.forEach(function(t) {
        var idx = self.state.messages.indexOf(t.msg);
        self.cancelQueuedMessage(t.msg, idx === -1 ? t.idx : idx);
      });
    }
    /**
     * True when the WORKER, not this client, drives the rest of this file's chain.
     * The mirror image of the early returns in maybeResumeIndexing: whatever that
     * refuses to continue is exactly what nothing client-side is tracking.
     */
    _isWorkerDrivenIndexing(filename, mime) {
      if (!isPagedReadFile(filename, mime)) return false;
      if (isImageVisionFile(filename, mime)) return true;
      return windowedIndexingEnabled() && isWindowedReadFile(filename, mime);
    }
    _adoptWorkerIndexingPasses(attempt, passive) {
      var self = this;
      if (this._adoptingWorkerPasses) return;
      var id = this.host.getIdentity();
      var platform = id.platform;
      if (!id.projectId || platform !== "claude" && platform !== "openai") return;
      if (this.isPollingPaused() || !this.host.isViewMounted()) return;
      var svcId = id.projectId, owner = id.owner;
      var queue = bgIndexingQueueName(id.userId, id.projectId);
      var ask = function(status) {
        return Promise.resolve(probeBgQueue(
          { service: svcId, owner, platform, queue, status, limit: WORKER_PASS_ADOPT_LIMIT },
          { maxAgeMs: 0 }
        )).then(function(entry2) {
          return entry2.result;
        }).catch(function() {
          return null;
        });
      };
      this._adoptingWorkerPasses = true;
      Promise.all([ask("running"), ask("pending")]).then(function(results) {
        self._adoptingWorkerPasses = false;
        var now = self.host.getIdentity();
        if (now.projectId !== svcId || now.platform !== platform) return;
        if (!self.host.isViewMounted()) return;
        if (results[0] !== null && results[1] !== null) self._recordLiveIndexKeys(results);
        var adoptedIds = [];
        for (var ri = 0; ri < results.length; ri++) {
          var list = results[ri] && Array.isArray(results[ri].list) ? results[ri].list : [];
          for (var i = 0; i < list.length; i++) {
            if (self._adoptWorkerIndexingItem(list[i], svcId, platform)) adoptedIds.push(list[i].id);
          }
        }
        if (adoptedIds.length) {
          self.drainBgTaskQueue();
          if (self._isTrackingAny(adoptedIds)) return;
        }
        if (passive && !self._hasLiveIndexEvidence(svcId)) return;
        if (attempt + 1 >= WORKER_PASS_ADOPT_ATTEMPTS.length) {
          self._nudgeIndexingDrain();
          return;
        }
        setTimeout(function() {
          var later = self.host.getIdentity();
          if (later.projectId !== svcId || later.platform !== platform) return;
          if (self.isPollingPaused() || !self.host.isViewMounted()) return;
          self._adoptWorkerIndexingPasses(attempt + 1, passive);
        }, WORKER_PASS_ADOPT_ATTEMPTS[attempt + 1]);
      }, function() {
        self._adoptingWorkerPasses = false;
      });
    }
    /** Anything at all suggesting THIS project's indexing may be live: a queued
     *  local entry, a recorded live key (the adopt look just wrote them), or an
     *  attached poll. Gates the passive adopt ladder's climb. */
    _hasLiveIndexEvidence(svcId) {
      for (var i = 0; i < this.bgTaskQueue.length; i++) {
        var e = this.bgTaskQueue[i];
        if (e && e.projectId === svcId) return true;
      }
      var keys = this.state.liveIndexKeys || {};
      for (var k in keys) {
        if (keys[k]) return true;
      }
      var found = false;
      this.historyItemPolls.forEach(function(h) {
        if (h && h.kind === "bg") found = true;
      });
      return found;
    }
    /** Any of these ids still queued or still polled, i.e. surviving work. */
    _isTrackingAny(ids) {
      for (var i = 0; i < ids.length; i++) {
        if (this.historyItemPolls.has(ids[i])) return true;
        for (var q = 0; q < this.bgTaskQueue.length; q++) {
          if (this.bgTaskQueue[q].id === ids[i]) return true;
        }
      }
      return false;
    }
    /** One live bg-queue item -> a BgTaskEntry, if it is an indexing pass this
     *  client is not already tracking. Returns whether it was adopted. */
    _adoptWorkerIndexingItem(item, svcId, platform) {
      if (!item || typeof item.id !== "string" || !item.id) return false;
      if (item.status !== "pending" && item.status !== "running") return false;
      if (typeof item.poll !== "function") return false;
      if (this.historyItemPolls.has(item.id)) return false;
      for (var q = 0; q < this.bgTaskQueue.length; q++) {
        if (this.bgTaskQueue[q].id === item.id) return false;
      }
      for (var m = 0; m < this.state.messages.length; m++) {
        var msg = this.state.messages[m];
        if (msg._serverItemId !== item.id) continue;
        if (!(msg.isPending || msg.isPendingInProcess || msg.isPendingQueued)) return false;
      }
      var body = item.request_body;
      if (!body || typeof body !== "object") return false;
      if (platform === "claude" ? !Array.isArray(body.messages) : !Array.isArray(body.input)) return false;
      var userText = extractLastUserTextFromRequest(body);
      if (!isIndexingRequestText(userText)) return false;
      var ref = parseIndexingRequestText(userText);
      if (!ref || !ref.name) return false;
      if (!this._isWorkerDrivenIndexing(ref.name, ref.mime)) return false;
      this.bgTaskQueue.push({
        projectId: svcId,
        platform,
        id: item.id,
        filename: ref.name,
        storagePath: ref.path,
        mime: ref.mime,
        size: ref.size,
        status: item.status === "running" ? "running" : "pending",
        poll: item.poll,
        // Drives the "(continuing)" label and marks this as a continuation for
        // _applyIndexCancellations, which must not read a CONTINUE pass as the
        // fresh first pass that lifts a stop.
        resumePass: ref.continued ? 1 : 0
      });
      return true;
    }
    /** Follow the chain on from a background indexing pass that just settled. */
    _followWorkerIndexingChain(filename, mime) {
      if (!this._isWorkerDrivenIndexing(filename, mime)) return;
      this._adoptWorkerIndexingPasses(0);
    }
    /** Best-effort server-side cancel of a bg-queue item that has no bubble (so
     *  cancelQueuedMessage, which drives one, has nothing to act on). */
    _cancelServerItem(serverId) {
      var id = this.host.getIdentity();
      if (!serverId || id.platform !== "claude" && id.platform !== "openai") return;
      var url = id.platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
      Promise.resolve(this.host.cancelRequest({
        url,
        method: "POST",
        id: serverId,
        queue: bgIndexingQueueName(id.userId, id.projectId),
        service: id.projectId,
        owner: id.owner
      })).catch(function() {
      });
    }
    // Inject "Indexing: <file>" bubbles for queued bg tasks + attach their polls.
    drainBgTaskQueue() {
      var self = this;
      var id = this.host.getIdentity();
      var svcId = id.projectId, plat = id.platform;
      if (!svcId || plat === "none" || !this.host.isViewMounted()) return;
      this._applyIndexCancellations();
      this._sweepCancelledIndexing();
      var presentIds = {};
      var pendingIds = {};
      this.state.messages.forEach(function(m) {
        var sid = m._serverItemId;
        if (sid == null) return;
        presentIds[sid] = true;
        if (m.isPending || m.isPendingInProcess || m.isPendingQueued) pendingIds[sid] = true;
      });
      for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
        var e = this.bgTaskQueue[i];
        if (e.projectId !== svcId || e.platform !== plat) continue;
        if (presentIds[e.id] && !pendingIds[e.id]) {
          this._flipRunFromSettledEntry(e);
          this.bgTaskQueue.splice(i, 1);
        }
      }
      var bgPollBudget = MAX_CONCURRENT_BG_POLLS - this._countBgPolls();
      var injectedAny = false;
      this.bgTaskQueue.forEach(function(entry2) {
        if (entry2.projectId !== svcId || entry2.platform !== plat) return;
        if (!presentIds[entry2.id]) {
          var isRunning = entry2.status === "running";
          var userBubble = {
            role: "user",
            content: self.host.formatIndexingLabel(entry2.filename, entry2.mime, entry2.size, entry2.storagePath, entry2.isReindex, !!entry2.resumePass),
            isBackgroundTask: true,
            _serverItemId: entry2.id,
            // Structured ref so this live pass groups with the same file's passes
            // rebuilt from history (see indexing_groups.buildChatDisplayList).
            _indexFile: {
              name: entry2.filename,
              path: entry2.storagePath,
              mime: entry2.mime,
              size: entry2.size,
              isReindex: !!entry2.isReindex,
              continued: !!entry2.resumePass
            }
          };
          if (isRunning) userBubble.isPendingInProcess = true;
          else userBubble.isPendingQueued = true;
          var stageAt = self._stageIndex(self.state.messages, entry2.stageId);
          var runningBubble = isRunning ? { role: "assistant", content: "", isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: entry2.id } : null;
          if (stageAt === -1) {
            self.state.messages.push(userBubble);
            if (runningBubble) self.state.messages.push(runningBubble);
          } else if (runningBubble) {
            self.state.messages.splice(stageAt, 0, userBubble, runningBubble);
          } else {
            self.state.messages.splice(stageAt, 0, userBubble);
          }
          presentIds[entry2.id] = true;
          injectedAny = true;
        }
        if (bgPollBudget > 0 && !self.isPollingPaused() && !self.historyItemPolls.has(entry2.id) && typeof entry2.poll === "function") {
          bgPollBudget--;
          var capturedId = entry2.id, capturedPlat = plat;
          var capturedEntry = entry2;
          var wasStopped = false;
          var bp = entry2.poll({ latency: POLL_INTERVAL });
          self._trackPoll(entry2.id, "bg", bp);
          bp.then(function(response) {
            if (isPollStopped(response)) {
              wasStopped = true;
              return;
            }
            self.handleHistoryItemResolution(capturedId, response, capturedPlat);
            self.maybeResumeIndexing(capturedEntry, response, capturedPlat);
          }).catch(function(err) {
            self.historyItemPolls.delete(capturedId);
            var isNotExists = err && (err.code === "NOT_EXISTS" || err.body && err.body.code === "NOT_EXISTS");
            self._clearPendingUserBubble(capturedId);
            var bi = self.state.messages.findIndex(function(m) {
              return m.isPending && m._serverItemId === capturedId;
            });
            if (bi !== -1) {
              if (isNotExists) self.state.messages.splice(bi, 1);
              else self.state.messages[bi] = { role: "assistant", content: getErrorMessage(err), isError: true, isBackgroundTask: true, _serverItemId: capturedId };
            } else if (!isNotExists) {
              var ui = self.state.messages.findIndex(function(m) {
                return m.role === "user" && m._serverItemId === capturedId;
              });
              if (ui !== -1) {
                self.state.messages.splice(ui + 1, 0, { role: "assistant", content: getErrorMessage(err), isError: true, isBackgroundTask: true, _serverItemId: capturedId });
              }
            }
            self.host.notify();
            self.updateHistoryCache();
            if (!self._isWorkerDrivenIndexing(capturedEntry.filename, capturedEntry.mime)) {
              if (isNotExists) self._flipRunRecord(capturedEntry, "cancelled");
              else self._flipRunRecord(capturedEntry, "error", self._runErrorText(err));
              self._nudgeIndexingDrain();
            }
          }).then(function() {
            if (wasStopped) return;
            var qi = self.bgTaskQueue.findIndex(function(q) {
              return q.id === capturedId;
            });
            if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
            self.drainBgTaskQueue();
          });
        }
      });
      if (injectedAny) {
        this.host.notify();
        this.updateHistoryCache();
        this.host.scrollToBottomIfSticky(false);
      }
      this.promoteNextBgQueuedToRunning();
    }
    // Resume-across-passes: if a background INDEXING task for a paged file (spreadsheet or
    // text) finished WITHOUT the completion marker, the agent ran out of room before reading
    // the whole file - dispatch a CONTINUE pass (up to a cap) that resumes from where the
    // already-saved records leave off. Additive + guarded so it never loops forever and
    // never breaks the resolution path.
    //
    // VISION files (PDFs rendered to page images) are NOT resumed here: the proxy worker
    // advances their page window itself, off the renderer's true page count. Driving them
    // from the browser is what used to lose pages on long documents - the chain lived in tab
    // memory (a reload or a closed tab ended it), and it stopped whenever the model claimed
    // completion, which on an 88-page file happened at page 15. Continuing to dispatch here
    // as well would now double-index every window.
    /** Fire the consumer's done::-marker hook for a run whose completion this
     *  client knows DETERMINISTICALLY (see the two call sites in
     *  maybeResumeIndexing). Best-effort by contract; identity-checked so a
     *  project switch mid-settle cannot stamp the wrong service. */
    _mintDoneMarker(entry2) {
      try {
        var mint = chatEngineConfig().mintIndexDoneMarker;
        if (!mint || !entry2 || !entry2.storagePath || !entry2.projectId) return;
        var id = this.host.getIdentity();
        if (!id || id.projectId !== entry2.projectId) return;
        mint({ service: entry2.projectId, storagePath: entry2.storagePath });
      } catch (_e) {
      }
    }
    /** Short, storable form of an error body for the run:: record. */
    _runErrorText(response) {
      var msg = "";
      try {
        msg = String(getErrorMessage(response) || "");
      } catch (_e) {
      }
      msg = msg.replace(/\s+/g, " ").trim();
      return msg ? msg.slice(0, 300) : "Indexing failed.";
    }
    /** Close the records of a run whose pass settled OFF-POLL — the answer came
     *  back as history (hidden tab, dead poll, resume refetch), so none of the
     *  poll-side settle handlers ran. Only for SINGLE-PASS files, where one
     *  settled pass is deterministically the whole run (the same contract as
     *  maybeResumeIndexing's single-pass branch); paged files stay with their
     *  drivers. Outcome is read from the settled bubbles' own flags, which is
     *  all the history mapping left us. Best-effort and idempotent throughout. */
    _flipRunFromSettledEntry(entry2) {
      try {
        if (!entry2 || !entry2.storagePath || !entry2.id || !entry2.projectId) return;
        if (isPagedReadFile(entry2.filename, entry2.mime)) return;
        if (this.cancelledIndexKeys.has(this._indexKeyOf(entry2))) return;
        if (this.state.stoppedIndexIds[entry2.id]) return;
        var userMsg = null, replyMsg = null;
        this.state.messages.forEach(function(m) {
          if (m._serverItemId !== entry2.id) return;
          if (m.role === "user") {
            if (!userMsg) userMsg = m;
          } else if (!replyMsg) replyMsg = m;
        });
        if (userMsg && userMsg.isCancelled || replyMsg && replyMsg.isCancelled) {
          this._flipRunRecord(entry2, "cancelled");
        } else if (replyMsg && replyMsg.isError) {
          var errText = typeof replyMsg.content === "string" ? replyMsg.content.replace(/\s+/g, " ").trim().slice(0, 300) : "";
          this._flipRunRecord(entry2, "error", errText || "Indexing failed.");
        } else if (replyMsg) {
          this._mintDoneMarker(entry2);
          this._flipRunRecord(entry2, "done");
        }
      } catch (_e) {
      }
    }
    /** Close the durable run:: record for an ending THIS client observed.
     *  service comes from the ENTRY, not the current identity: unlike the done::
     *  mint above, a status flip must land even if the user switched projects
     *  mid-settle — otherwise the record lies 'working' forever. Best-effort
     *  through upsertIndexRunRecordSafe; the consumer's precedence guard keeps
     *  repeats and races harmless. */
    _flipRunRecord(entry2, status, error) {
      if (!entry2 || !entry2.storagePath || !entry2.projectId) return;
      var patch = { status, finished: Date.now() };
      if (error) patch.error = error;
      upsertIndexRunRecordSafe(entry2.projectId, entry2.storagePath, patch);
    }
    maybeResumeIndexing(entry2, response, platform) {
      var self = this;
      var endOfClientChain = function() {
        self._nudgeIndexingDrain();
      };
      try {
        if (!entry2 || !entry2.storagePath) return;
        if (this.cancelledIndexKeys.has(this._indexKeyOf(entry2))) return;
        if (!isPagedReadFile(entry2.filename, entry2.mime)) {
          if (!isErrorResponseBody(response) && !this._isCancelledPollResult(response)) {
            this._mintDoneMarker(entry2);
            this._flipRunRecord(entry2, "done");
          } else if (this._isCancelledPollResult(response)) {
            this._flipRunRecord(entry2, "cancelled");
          } else {
            this._flipRunRecord(entry2, "error", this._runErrorText(response));
          }
          endOfClientChain();
          return;
        }
        if (isImageVisionFile(entry2.filename, entry2.mime)) return;
        if (windowedIndexingEnabled() && isWindowedReadFile(entry2.filename, entry2.mime)) return;
        if (isErrorResponseBody(response)) {
          this._flipRunRecord(entry2, "error", this._runErrorText(response));
          endOfClientChain();
          return;
        }
        var answer = (platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response)) || "";
        if (answer.indexOf(INDEXING_COMPLETE_MARKER) !== -1) {
          this._mintDoneMarker(entry2);
          this._flipRunRecord(entry2, "done");
          endOfClientChain();
          return;
        }
        var pass = (entry2.resumePass || 0) + 1;
        if (pass > MAX_INDEXING_RESUME_PASSES) {
          this._flipRunRecord(entry2, "error", "Stopped after " + MAX_INDEXING_RESUME_PASSES + " passes without finishing.");
          endOfClientChain();
          return;
        }
        var id = this.host.getIdentity();
        if (!id || id.platform === "none" || id.projectId !== entry2.projectId) {
          this._flipRunRecord(entry2, "error", "Indexing stopped: the session or project changed before the file finished.");
          endOfClientChain();
          return;
        }
        this.trackIndexDispatch(notifyAgentContinueIndexing({
          platform: id.platform,
          model: id.model,
          service: id.projectId,
          // Without this the resume pass rebuilds its system prompt from the RAW
          // regional id (requests.ts falls back to `service`), and the model copies
          // that id verbatim into project_id tool calls, which the MCP schema
          // pattern rejects - the whole continue pass saves nothing.
          publicProjectId: id.publicProjectId,
          owner: id.owner,
          userId: id.userId || id.projectId,
          serviceName: id.serviceName,
          serviceDescription: id.serviceDescription,
          attachment: {
            name: entry2.filename,
            storagePath: entry2.storagePath,
            mime: entry2.mime,
            size: entry2.size,
            url: ""
          }
        }).then(function(ack) {
          if (ack && typeof ack.id === "string") {
            self.bgTaskQueue.push({
              projectId: id.projectId,
              platform: id.platform,
              id: ack.id,
              filename: entry2.filename,
              storagePath: entry2.storagePath,
              isReindex: entry2.isReindex,
              mime: entry2.mime,
              size: entry2.size,
              status: ack.status === "running" ? "running" : "pending",
              poll: ack.poll,
              resumePass: pass
              // Deliberately NOT stamped with entry.stageId. Only a batch's FIRST
              // pass anchors to the turn; a continuation appends, which is the
              // order the server queued it in and therefore the order
              // promoteNextBgQueuedToRunning should spin it in. It costs nothing
              // on screen: a continuation is folded into the run whose row
              // already sits above the turn, and renders nothing at its own
              // index (indexing_groups anchors a run at its FIRST loaded pass).
            });
            self.drainBgTaskQueue();
          }
        }, function(e) {
          console.error("[chat-engine] resume-indexing dispatch failed", e);
        }));
      } catch (e) {
      }
    }
    // --- history fetch + pagination --------------------------------------
    // Initial load (fetchMore=false) replaces the list (with in-flight rescue +
    // cancelled-merge) and attaches polls to running/pending items; pagination
    // (fetchMore=true) prepends older messages. The DOM scroll-restore for the
    // older-prepend is the VIEW's job (it captures the pre-prepend scroll position
    // and restores after this resolves) — the engine never measures the DOM.
    loadHistory(fetchMore, token) {
      var self = this;
      var id = this.host.getIdentity();
      var loadKey = chatCacheKey(id.projectId, id.platform, id.userId);
      if (token === void 0) token = this.state.gateRefreshToken;
      if (this.state.loadingHistory && this.state.historyRequestToken === token || id.platform === "none" || !id.projectId) {
        return Promise.resolve();
      }
      this.state.historyRequestToken = token;
      this.state.loadingHistory = true;
      if (!fetchMore && loadKey !== this._liveIndexKey) {
        this._liveIndexKey = loadKey;
        this._resetLiveIndexKeys();
      }
      if (fetchMore) this.state.loadingOlderHistory = true;
      this.host.notify();
      var platform = id.platform;
      var projectId = id.projectId, owner = id.owner;
      var options = { fetchMore };
      if (fetchMore && this.state.historyStartKeyHistory.length) options.startKeyHistory = this.state.historyStartKeyHistory.slice();
      if (!fetchMore) options.deferBg = true;
      var fetchHistory = function() {
        return getSplitChatHistory({
          service: projectId,
          owner,
          platform,
          userId: id.userId,
          // An anonymous visitor's history is scoped server side by
          // ip + "(" + user_agent + ")", which two devices behind one NAT
          // share. Read this device's own queue instead. See
          // scopeSurfaceToQueue.
          scopeSurfaceToQueue: !!id.anonymous
        }, options);
      };
      return Promise.resolve().then(fetchHistory).catch(function(err) {
        if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(fetchHistory);
        throw err;
      }).then(function(history) {
        if (token !== self.state.gateRefreshToken) return;
        var chatList = history && Array.isArray(history.list) ? history.list : [];
        chatList.forEach(function(item) {
          if (isBgIndexingQueue(item.queue_name)) {
            var clsText = item.compact ? item.request_text : extractLastUserTextFromRequest(item.request_body);
            if (isIndexingRequestText(clsText)) item._isBgTask = true;
            else item._isOnBgQueue = true;
          }
        });
        var list = chatList.sort(function(a, b) {
          var ai = typeof a.id === "string" ? a.id : "", bi = typeof b.id === "string" ? b.id : "";
          return ai > bi ? -1 : ai < bi ? 1 : 0;
        });
        var mapped = mapHistoryListToMessages(list, platform, {
          clearedAt: self.host.getClearedAt(),
          projectId: id.projectId,
          // So the `_ownerKey` stamped on server history matches loadKey and
          // the cache key. Without it every mapped bubble carries a
          // two-segment stamp that no comparison can ever match.
          userId: id.userId,
          formatIndexingLabel: self.host.formatIndexingLabel
        }).messages;
        self.applyHydratedBodies(mapped);
        self._adoptLocalAnswers(mapped, loadKey);
        var keptOlderPages = false;
        var keptScreenAwaitingBg = false;
        if (fetchMore) {
          var incomingKeys = {};
          mapped.forEach(function(m) {
            if (m._serverItemId) incomingKeys[m._serverItemId + "|" + m.role] = m;
          });
          var existing = self.state.messages.filter(function(m) {
            if (!m._serverItemId) return true;
            var inc = incomingKeys[m._serverItemId + "|" + m.role];
            if (!inc) return true;
            if (m._cancelling) inc._cancelling = m._cancelling;
            if (m._cancelError) inc._cancelError = m._cancelError;
            return false;
          });
          var mergedList = [];
          var pi = 0, ei = 0;
          while (pi < mapped.length && ei < existing.length) {
            var pm = mapped[pi], em = existing[ei];
            var eid = em._serverItemId;
            if (typeof eid !== "string") break;
            var pid = pm._serverItemId;
            if (typeof pid !== "string" || pid <= eid) {
              mergedList.push(pm);
              pi++;
            } else {
              mergedList.push(em);
              ei++;
            }
          }
          while (pi < mapped.length) mergedList.push(mapped[pi++]);
          while (ei < existing.length) mergedList.push(existing[ei++]);
          self.state.messages = mergedList;
        } else if (!mapped.length && history && (history.endOfList === false || history.bgPending) && self.state.messages.some(function(m) {
          return m._ownerKey === void 0 || m._ownerKey === loadKey;
        })) {
          if (history.endOfList !== false) keptScreenAwaitingBg = true;
        } else {
          if (self.state.typing) self.state.typingAbort = true;
          var serverIds = {};
          mapped.forEach(function(m) {
            if (m._serverItemId) serverIds[m._serverItemId] = 1;
          });
          var surfaceOldestId = void 0;
          mapped.forEach(function(m) {
            if (typeof m._serverItemId !== "string" || m._fromBgChain) return;
            if (surfaceOldestId === void 0 || m._serverItemId < surfaceOldestId) surfaceOldestId = m._serverItemId;
          });
          var locallyCancelled = {};
          self.state.messages.forEach(function(m) {
            if (m.isCancelled && m._serverItemId) locallyCancelled[m._serverItemId] = m;
          });
          var inFlightCancel = {};
          self.state.messages.forEach(function(m) {
            if (!m._serverItemId) return;
            if (m._cancelling || m._cancelError) inFlightCancel[m._serverItemId] = m;
          });
          var mappedHasPendingAssistant = mapped.some(function(m) {
            return m.isPending && m.role === "assistant" && !m.isBackgroundTask;
          });
          var rescued = [];
          for (var ri = 0; ri < self.state.messages.length; ri++) {
            var mm = self.state.messages[ri];
            if (shouldRescueInFlightMessage(mm, {
              hasServerId: function(sid) {
                return !!serverIds[sid];
              },
              pageHasPendingAssistant: mappedHasPendingAssistant,
              sending: !!self.state.sending,
              next: self.state.messages[ri + 1],
              loadKey
            })) rescued.push(mm);
          }
          var oldestInPage1 = void 0;
          mapped.forEach(function(m) {
            var sid = m._serverItemId;
            if (typeof sid !== "string") return;
            if (oldestInPage1 === void 0 || sid < oldestInPage1) oldestInPage1 = sid;
          });
          var sharesPage1 = self.state.messages.some(function(m) {
            return typeof m._serverItemId === "string" && !!serverIds[m._serverItemId];
          });
          var deferredBg = !!(history && history.bgPending);
          var retainBoundary = surfaceOldestId !== void 0 ? surfaceOldestId : oldestInPage1;
          var retainedOlder = !sharesPage1 || retainBoundary === void 0 ? [] : self.state.messages.filter(function(m) {
            if (typeof m._serverItemId !== "string") return false;
            if (m._ownerKey !== void 0 && m._ownerKey !== loadKey) return false;
            if (deferredBg && m.isBackgroundTask) return true;
            if (m._fromBgChain) return true;
            return m._serverItemId < retainBoundary;
          });
          var prependOlder = [];
          var interleave = [];
          retainedOlder.forEach(function(m) {
            var sid = m._serverItemId;
            if (serverIds[sid]) return;
            if (retainBoundary !== void 0 && sid < retainBoundary) prependOlder.push(m);
            else interleave.push(m);
          });
          var page1 = mapped;
          if (interleave.length) {
            var mergedP = [];
            var ii2 = 0, mi2 = 0;
            while (ii2 < interleave.length && mi2 < mapped.length) {
              var iv = interleave[ii2], mv = mapped[mi2];
              var mid2 = typeof mv._serverItemId === "string" ? mv._serverItemId : void 0;
              if (mid2 === void 0) break;
              if (iv._serverItemId <= mid2) {
                mergedP.push(iv);
                ii2++;
              } else {
                mergedP.push(mv);
                mi2++;
              }
            }
            while (ii2 < interleave.length) mergedP.push(interleave[ii2++]);
            while (mi2 < mapped.length) mergedP.push(mapped[mi2++]);
            page1 = mergedP;
          }
          keptOlderPages = prependOlder.length > 0 || interleave.length > 0;
          self.state.messages = prependOlder.length ? prependOlder.concat(page1) : page1;
          rescued.forEach(function(m) {
            if (m._serverItemId && self.state.messages.some(function(x) {
              return x._serverItemId === m._serverItemId && x.role === m.role;
            })) return;
            self.state.messages.push(m);
          });
          if (Object.keys(locallyCancelled).length) {
            for (var ci = 0; ci < self.state.messages.length; ci++) {
              var c = self.state.messages[ci];
              if (!c._serverItemId || !locallyCancelled[c._serverItemId] || c.isCancelled) continue;
              self.state.messages[ci] = {
                role: "user",
                content: c.content,
                isCancelled: true,
                _serverItemId: c._serverItemId,
                isBackgroundTask: c.isBackgroundTask,
                _indexFile: c._indexFile,
                _useBgQueue: c._useBgQueue,
                _ownerKey: c._ownerKey
              };
              if (ci + 1 < self.state.messages.length && self.state.messages[ci + 1].isPending && self.state.messages[ci + 1]._serverItemId === c._serverItemId) {
                self.state.messages.splice(ci + 1, 1);
              }
            }
          }
          for (var fi = 0; fi < self.state.messages.length; fi++) {
            var fm = self.state.messages[fi];
            var was = fm._serverItemId && inFlightCancel[fm._serverItemId];
            if (!was || fm.isCancelled) continue;
            if (!(fm.isPendingQueued || fm.isPendingInProcess || fm.isPending)) continue;
            if (was._cancelling) fm._cancelling = true;
            if (was._cancelError) fm._cancelError = was._cancelError;
          }
        }
        if (!keptOlderPages) {
          self.state.historyEndOfList = !!(history && history.endOfList);
          self.state.historyStartKeyHistory = history && Array.isArray(history.startKeyHistory) ? history.startKeyHistory : [];
          var clearedAt = self.host.getClearedAt();
          if (clearedAt) {
            var surfaceItems = chatList.filter(function(it) {
              return !(it && it._fromBgChain);
            });
            if (surfaceItems.length > 0) {
              var oldestUpdated = Number(surfaceItems[surfaceItems.length - 1] && surfaceItems[surfaceItems.length - 1].updated);
              if (isFinite(oldestUpdated) && oldestUpdated <= clearedAt) self.state.historyEndOfList = true;
            }
          }
        }
        if (self.state.historyRequestToken === token) {
          self.state.loadingHistory = false;
          self.state.loadingOlderHistory = false;
        }
        self.updateHistoryCache();
        self.host.notify();
        self._scheduleStreamRecovery(loadKey, platform, projectId, owner);
        var bgPending = !fetchMore && history && history.bgPending;
        if (bgPending) {
          var batchId = ++_bgHistoryBatchSeq;
          if (history.endOfList !== true && history.firstLoad === true) {
            self.state.bgHistoryLoading = true;
            self.host.notify();
          }
          var releaseBgFlag = function() {
            if (_bgHistoryBatchSeq === batchId) self.state.bgHistoryLoading = false;
          };
          bgPending.then(function(batch) {
            if (token !== self.state.gateRefreshToken) {
              releaseBgFlag();
              return;
            }
            var bList = batch && Array.isArray(batch.list) ? batch.list : [];
            bList.forEach(function(item) {
              if (isBgIndexingQueue(item.queue_name)) {
                var t = item.compact ? item.request_text : extractLastUserTextFromRequest(item.request_body);
                if (isIndexingRequestText(t)) item._isBgTask = true;
                else item._isOnBgQueue = true;
              }
            });
            var sorted = bList.sort(function(a, b) {
              var ai = typeof a.id === "string" ? a.id : "", bi = typeof b.id === "string" ? b.id : "";
              return ai > bi ? -1 : ai < bi ? 1 : 0;
            });
            var m2 = mapHistoryListToMessages(sorted, platform, {
              clearedAt: self.host.getClearedAt(),
              projectId: id.projectId,
              userId: id.userId,
              formatIndexingLabel: self.host.formatIndexingLabel
            }).messages;
            self.applyHydratedBodies(m2);
            if (keptScreenAwaitingBg && !m2.length && batch && batch.endOfList === true) {
              self.state.messages = self.state.messages.filter(function(m) {
                if (typeof m._serverItemId !== "string") return true;
                if (m._ownerKey !== void 0 && m._ownerKey !== loadKey) return true;
                return false;
              });
              self.state.historyEndOfList = true;
              releaseBgFlag();
              self.updateHistoryCache();
              self.host.notify();
              return;
            }
            var incoming = {};
            m2.forEach(function(m) {
              if (m._serverItemId) incoming[m._serverItemId + "|" + m.role] = true;
            });
            var baseList = self.state.messages.filter(function(m) {
              return !(m._serverItemId && incoming[m._serverItemId + "|" + m.role]);
            });
            var mergedList2 = [];
            var pi2 = 0, ei2 = 0;
            while (pi2 < m2.length && ei2 < baseList.length) {
              var pm2 = m2[pi2], em2 = baseList[ei2];
              var eid2 = em2._serverItemId;
              if (typeof eid2 !== "string") break;
              var pid2 = pm2._serverItemId;
              if (typeof pid2 !== "string" || pid2 <= eid2) {
                mergedList2.push(pm2);
                pi2++;
              } else {
                mergedList2.push(em2);
                ei2++;
              }
            }
            while (pi2 < m2.length) mergedList2.push(m2[pi2++]);
            while (ei2 < baseList.length) mergedList2.push(baseList[ei2++]);
            self.state.messages = mergedList2;
            if (batch && batch.endOfList === true) self.state.historyEndOfList = true;
            releaseBgFlag();
            self.updateHistoryCache();
            self.host.notify();
            if (self.host.settleScroll) self.host.settleScroll();
          }, function() {
            releaseBgFlag();
            self.host.notify();
          });
        }
        if (!fetchMore) {
          var bgAllow = {};
          var bgHistBudget = MAX_CONCURRENT_BG_POLLS - self._countBgPolls();
          if (bgHistBudget > 0) {
            var bgIds = chatList.filter(function(it) {
              if (it.status !== "running" && it.status !== "pending") return false;
              if (!it.poll || !it.id) return false;
              if (!(it._isBgTask || it._isOnBgQueue)) return false;
              return !self.historyItemPolls.has(it.id);
            }).map(function(it) {
              return it.id;
            }).sort();
            for (var ba = 0; ba < bgIds.length && ba < bgHistBudget; ba++) bgAllow[bgIds[ba]] = true;
          }
          chatList.forEach(function(item) {
            if (item.status !== "running" && item.status !== "pending") return;
            if (!item.poll || !item.id) return;
            if (self.historyItemPolls.has(item.id)) return;
            if (self.pendingAgentRequests[self.getHistoryCacheKey()] && !item._isBgTask && !item._isOnBgQueue) return;
            if ((item._isBgTask || item._isOnBgQueue) && self.isPollingPaused()) return;
            if ((item._isBgTask || item._isOnBgQueue) && !bgAllow[item.id]) return;
            var capturedId = item.id;
            var isBg = !!(item._isBgTask || item._isOnBgQueue);
            var pollOpts = {
              onResponse: function(response) {
                if (isPollStopped(response)) return;
                self.handleHistoryItemResolution(capturedId, response, platform);
              },
              onError: function(err) {
                self.historyItemPolls.delete(capturedId);
                var isNotExists = err && (err.code === "NOT_EXISTS" || err.body && err.body.code === "NOT_EXISTS");
                var aIdx = self.state.messages.findIndex(function(m) {
                  return m.isPending && m._serverItemId === capturedId;
                });
                if (isNotExists) {
                  var uIdx = self.state.messages.findIndex(function(m) {
                    return m.role === "user" && m._serverItemId === capturedId && !m.isCancelled;
                  });
                  var isBg2 = aIdx !== -1 && !!self.state.messages[aIdx].isBackgroundTask || uIdx !== -1 && !!self.state.messages[uIdx].isBackgroundTask;
                  if (aIdx !== -1) self.state.messages.splice(aIdx, 1);
                  if (!isBg2) {
                    if (uIdx !== -1) {
                      var ex = self.state.messages[uIdx];
                      self.state.messages[uIdx] = { role: "user", content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId };
                    }
                    self.cancelledServerIds.delete(capturedId);
                    self.promoteNextQueuedToRunning();
                  } else if (uIdx !== -1) {
                    var bex = self.state.messages[uIdx];
                    var bcancelled = { role: "user", content: bex.content, isCancelled: true, isBackgroundTask: true, _serverItemId: bex._serverItemId };
                    if (bex._indexFile) bcancelled._indexFile = bex._indexFile;
                    if (bex._useBgQueue) bcancelled._useBgQueue = true;
                    self.state.messages[uIdx] = bcancelled;
                    self.promoteNextBgQueuedToRunning();
                  }
                  self.host.notify();
                  self.updateHistoryCache();
                  return;
                }
                if (aIdx !== -1) {
                  var wasBg = self.state.messages[aIdx].isBackgroundTask;
                  self.state.messages[aIdx] = { role: "assistant", content: getErrorMessage(err), isError: true };
                  if (wasBg) self.state.messages[aIdx].isBackgroundTask = true;
                  self.host.notify();
                  self.updateHistoryCache();
                }
              }
            };
            var pp = isBg ? item.poll(Object.assign({ latency: POLL_INTERVAL }, pollOpts)) : self._fgPollWithEarlyProbe(item, capturedId, pollOpts, {
              platform,
              projectId,
              owner,
              ownerKey: loadKey
            });
            self._trackPoll(capturedId, item._isBgTask || item._isOnBgQueue ? "bg" : "fg", pp);
            if (pp && pp.catch) pp.catch(function() {
            });
          });
          self.drainBgTaskQueue();
        }
        if (!fetchMore) self.refreshLiveIndexState();
        if (!fetchMore) return self.host.settleScroll ? self.host.settleScroll() : self.host.scrollToBottomIfSticky();
      }).catch(function(err) {
        console.warn("[chat-engine] getChatHistory failed", err);
      }).then(function() {
        if (self.state.historyRequestToken === token) {
          var wasLoading = self.state.loadingHistory || self.state.loadingOlderHistory;
          self.state.loadingHistory = false;
          self.state.loadingOlderHistory = false;
          if (wasLoading) self.host.notify();
        }
        if (self.host.onHistoryLoaded) self.host.onHistoryLoaded(!!fetchMore, token);
      });
    }
    // --- attachment upload orchestration ---------------------------------
    // Upload one attachment (a file = 1 member, a folder = N) to db storage and
    // queue indexing per member. The bytes I/O + chip rendering go through host
    // hooks; the overwrite/reindex flow, status lifecycle, and indexing live here.
    uploadSingleAttachment(att, stageId) {
      var self = this;
      var id = this.host.getIdentity();
      att.status = "uploading";
      att.progress = null;
      att.errorMessage = "";
      att.errorCode = "";
      att.errorDetail = "";
      this.host.renderAttachmentChips();
      var members = att.kind === "folder" ? (att.files || []).map(function(f) {
        return { file: f.file, relPath: f.path, storagePath: self.host.storagePathFor(f.path) };
      }) : [{ file: att.file, relPath: att.name, storagePath: this.host.storagePathFor(att.name) }];
      var total = members.length;
      if (!total) return Promise.reject(new Error("Empty attachment"));
      var urls = [];
      var anyIndexFailed = false;
      var chain = Promise.resolve();
      members.forEach(function(member, idx) {
        chain = chain.then(function() {
          var hadExists = false;
          var skipped = false;
          var existedBefore = false;
          var onProg = function(p) {
            if (p && p.total) {
              att.progress = Math.floor((idx + p.loaded / p.total) / total * 100);
              self.host.renderAttachmentChips();
            }
          };
          var doMemberUpload = function(checkExistence) {
            return self.host.uploadFile({
              file: member.file,
              storagePath: member.storagePath,
              checkExistence,
              onProgress: onProg,
              setAbort: function(abort) {
                att._abort = abort;
              }
            });
          };
          return doMemberUpload(true).catch(function(err) {
            var code = err && (err.code || err.body && err.body.code);
            var msg = err && (err.message || err.body && err.body.message || (typeof err === "string" ? err : ""));
            var isExists = code === "EXISTS" || msg && /exist/i.test(msg);
            if (!isExists) throw err;
            return self.host.promptOverwrite(member.file.name).then(function(choice) {
              if (choice === "overwrite") {
                existedBefore = true;
                markImagePreviewStale(self.host.getIdentity().projectId || "default", member.storagePath);
                return doMemberUpload(false);
              }
              if (choice === "skip") {
                skipped = true;
                return;
              }
              hadExists = true;
              existedBefore = true;
            });
          }).then(function() {
            if (skipped) return;
            return self.host.getTemporaryUrl(member.storagePath);
          }).then(function(url) {
            if (skipped) return;
            urls.push({ name: member.relPath, url, storagePath: member.storagePath });
            if (att.kind !== "folder") {
              att.uploadedUrl = url;
              att.storagePath = member.storagePath;
            }
            var mime = member.file.type || self.host.getMimeType(member.file.name);
            var alreadyIndexing = false;
            var preIndex = self.claimIndexRun(member.storagePath).then(function(claimed) {
              alreadyIndexing = !claimed;
              if (alreadyIndexing) {
                console.log("[chat-engine] skipping a duplicate index request for", member.storagePath);
                return;
              }
              if (existedBefore && typeof self.host.deleteExistingFileRecord === "function") {
                return Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function() {
                });
              }
            });
            preIndex = preIndex.then(function() {
              if (alreadyIndexing) return;
              if (typeof self.host.ensureFileIndexRecord !== "function") return;
              return Promise.resolve(self.host.ensureFileIndexRecord(member.storagePath, {
                name: member.file.name,
                mime: mime || void 0,
                size: member.file.size
              })).catch(function() {
              });
            });
            var accessGroup;
            preIndex = preIndex.then(function() {
              if (alreadyIndexing) return;
              if (typeof self.host.uploadAccessGroup !== "function") return;
              return Promise.resolve(self.host.uploadAccessGroup(member.storagePath)).then(function(g) {
                accessGroup = g || void 0;
              }).catch(function() {
              });
            });
            return preIndex.then(function() {
              return parseAttachmentContent(member.file, member.file.name, mime || void 0);
            }).then(function(parsedContent) {
              if (alreadyIndexing) return;
              return self.trackIndexDispatch(notifyAgentSaveAttachment({
                platform: id.platform,
                model: id.model,
                service: id.projectId,
                publicProjectId: id.publicProjectId,
                owner: id.owner,
                userId: id.userId || id.projectId,
                serviceName: id.serviceName,
                serviceDescription: id.serviceDescription,
                attachment: {
                  name: member.file.name,
                  storagePath: member.storagePath,
                  mime: mime || void 0,
                  size: member.file.size,
                  url,
                  accessGroup
                },
                parsedContent: parsedContent || void 0
              }).then(function(ack) {
                if (ack && typeof ack.id === "string") {
                  self.bgTaskQueue.push({
                    projectId: id.projectId,
                    platform: id.platform,
                    id: ack.id,
                    filename: member.file.name,
                    storagePath: member.storagePath,
                    isReindex: hadExists,
                    mime: mime || void 0,
                    size: member.file.size,
                    status: ack.status === "running" ? "running" : "pending",
                    poll: ack.poll,
                    // Puts this file's row directly above the chat turn it was
                    // attached to (drainBgTaskQueue). Undefined for an
                    // attachment-only send, which appends.
                    stageId
                  });
                  self.drainBgTaskQueue();
                }
              }, function(e) {
                console.error("[chat-engine] indexing request failed", e);
                self.releaseIndexRun(member.storagePath);
                anyIndexFailed = true;
                if (!att.errorCode && !att.errorDetail) {
                  att.errorCode = e && (e.code || e.body && e.body.code) || "";
                  att.errorDetail = e && (e.message || e.body && e.body.message) || (typeof e === "string" ? e : "");
                }
              }));
            });
          });
        });
      });
      return chain.then(function() {
        att._abort = null;
        att.progress = 100;
        if (att.kind === "folder") att.uploadedUrls = urls.map(function(u) {
          return { path: u.name, url: u.url, storagePath: u.storagePath };
        });
        att.status = anyIndexFailed ? "indexError" : "done";
        if (att.status === "indexError") att.errorMessage = "File indexing failed";
        self.host.renderAttachmentChips();
        return urls;
      });
    }
    // Upload all not-yet-done attachments sequentially. Resolves to the full
    // list of { name, url, storagePath } for composing the chat message.
    //
    // `batchId` scopes the run to the chips stamped with it at Send time. The
    // composer stays live during an upload, so by the time this runs the
    // attachment list can already hold chips the user picked for the NEXT
    // message — uploading those here would attach them to the wrong turn, and
    // collecting the previous batch's finished urls would attach files the user
    // already sent. Omitted (no batch) means every chip, the old behavior.
    //
    // `stageId` is the turn these chips were attached to, carried onto every indexing
    // task so its collapsed row renders directly ABOVE that turn's bubble (see
    // BgTaskEntry.stageId). Omitted for an attachment-only send, which has no turn.
    uploadPendingAttachments(batchId, stageId) {
      var self = this;
      this.host.resetOverwriteBatch();
      this._uploadBatches += 1;
      this.state.uploadingAttachments = true;
      this.host.updateComposerControls();
      this.host.renderAttachmentChips();
      var collected = [];
      var snapshot = this.state.attachments.filter(function(a) {
        return batchId ? a._batchId === batchId : true;
      });
      var chain = Promise.resolve();
      snapshot.forEach(function(att) {
        chain = chain.then(function() {
          if (!self.state.attachments.some(function(a) {
            return a.id === att.id;
          })) return;
          if (att.status === "done" || att.status === "indexError") {
            if (att.kind === "folder" && att.uploadedUrls) {
              att.uploadedUrls.forEach(function(u) {
                collected.push({ name: u.path, url: u.url, storagePath: u.storagePath });
              });
              return;
            }
            if (att.uploadedUrl) {
              collected.push({ name: att.name, url: att.uploadedUrl, storagePath: att.storagePath });
              return;
            }
          }
          return self.uploadSingleAttachment(att, stageId).then(function(us) {
            collected.push.apply(collected, us);
          }).catch(function(err) {
            var removed = !self.state.attachments.some(function(a) {
              return a.id === att.id;
            });
            var aborted = err && (err.message === "Aborted" || err === "Aborted");
            if (removed || aborted) return;
            att.status = "error";
            att.errorMessage = "File upload has failed";
            att.errorCode = err && (err.code || err.body && err.body.code) || "";
            att.errorDetail = err && (err.message || err.body && err.body.message) || (typeof err === "string" ? err : "");
            self.host.renderAttachmentChips();
          });
        });
      });
      var done = function() {
        self._uploadBatches = Math.max(0, self._uploadBatches - 1);
        self.state.uploadingAttachments = self._uploadBatches > 0;
        self.host.updateComposerControls();
        self.host.renderAttachmentChips();
        return collected;
      };
      return chain.then(done, done);
    }
    // Stop timers / abort the typewriter (view teardown).
    stop() {
      this.state.typingAbort = true;
    }
    // Bump the gate token so any in-flight immediate-send result is dropped
    // (called by the view on a service/platform switch or history clear).
    bumpGate() {
      this.state.gateRefreshToken += 1;
    }
  };

  // src/engine/indexing_groups.ts
  function canonIndexKey(s) {
    return typeof s === "string" && s ? s.trim() : "";
  }
  var RUN_RECORD_WORKING_STALE_MS = 6 * 60 * 60 * 1e3;
  var INDEXING_LABEL_RE = /^(Re)?[Ii]ndexing(\s*\(continuing\))?\s*:?\s+(.+)$/;
  var LEADING_MD_LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)/;
  function parseIndexingLabel(content) {
    if (typeof content !== "string" || !content) return null;
    var firstLine = content.split("\n")[0].trim();
    var m = firstLine.match(INDEXING_LABEL_RE);
    if (!m) return null;
    var head = m[3].split(" \xB7 ")[0].trim();
    var link = head.match(LEADING_MD_LINK_RE);
    var name = link ? link[1].trim() : head;
    if (!name) return null;
    return {
      name,
      path: link ? link[2].trim() : void 0,
      continued: !!m[2],
      isReindex: !!m[1]
    };
  }
  function readFileRef(msg) {
    var ref = msg && msg._indexFile;
    if (ref && (ref.path || ref.name)) {
      return {
        name: ref.name || ref.path || "",
        path: ref.path,
        mime: ref.mime,
        size: ref.size,
        isReindex: ref.isReindex,
        continued: !!ref.continued
      };
    }
    var parsed = parseIndexingLabel(msg && msg.content);
    if (!parsed) return null;
    return {
      name: parsed.name,
      path: parsed.path,
      isReindex: parsed.isReindex,
      continued: parsed.continued
    };
  }
  function isPendingMsg(m) {
    return !!(m.isPending || m.isPendingInProcess || m.isPendingQueued || m.isSendingToServer);
  }
  function isHiddenPass(m) {
    if (m.role === "user") {
      if (m.isCancelled) return false;
      var ref = readFileRef(m);
      return !!(ref && ref.continued);
    }
    return !!m.isPending;
  }
  function overlayRunRecordVerdict(grp, rec, liveIndexKeys) {
    if (!grp.members.length || grp.status === "active" || grp.cancelling) return;
    if (rec.status === "working" || typeof rec.started !== "number") return;
    if (liveIndexKeys[grp.key] || liveIndexKeys[canonIndexKey(grp.key)]) return;
    var firstTs = grp.members[0].msg._ts;
    var lastTs = grp.members[grp.members.length - 1].msg._ts;
    if (typeof lastTs !== "number" || typeof firstTs !== "number") return;
    if (rec.started > lastTs) return;
    var when = typeof rec.finished === "number" ? rec.finished : void 0;
    if (when === void 0) return;
    if (when < firstTs) return;
    if (when < lastTs - 5e3) return;
    if (rec.status === "error" || rec.status === "cancelled") {
      grp.status = rec.status;
    } else if (rec.status === "done") {
      grp.status = "done";
    } else {
      return;
    }
    grp.finished = true;
    grp.resolving = false;
    grp.resolvingReason = void 0;
  }
  function buildChatDisplayList(messages, opts) {
    var list = Array.isArray(messages) ? messages : [];
    var liveIndexKeys = opts && opts.liveIndexKeys || {};
    var liveIndexChecked = !!(opts && opts.liveIndexChecked);
    var doneKeys = opts && opts.doneKeys || {};
    var stoppedIndexIds = opts && opts.stoppedIndexIds || {};
    var windowedIndexing = opts && opts.windowedIndexing !== void 0 ? !!opts.windowedIndexing : windowedIndexingEnabled();
    var hasMoreHistory = !!(opts && opts.hasMoreHistory);
    var loadingOlderHistory = !!(opts && opts.loadingOlderHistory);
    var stubPlatform = opts && opts.stubPlatform;
    var groups = {};
    var order = [];
    var runOfIndex = new Array(list.length);
    var runByItemId = {};
    var keyByName = {};
    var openRunOfKey = {};
    var runsOfKey = {};
    var keyOfRun = {};
    var newestTsOfRun = {};
    var runSeq = 0;
    for (var i = 0; i < list.length; i++) {
      var msg = list[i];
      if (!msg || !msg.isBackgroundTask) continue;
      var runId;
      var ref = msg.role === "user" ? readFileRef(msg) : null;
      if (msg._serverItemId && runByItemId[msg._serverItemId]) {
        runId = runByItemId[msg._serverItemId];
      } else if (ref) {
        var key = ref.path || keyByName[ref.name] || ref.name;
        var alreadySeen = !!(msg._serverItemId && runByItemId[msg._serverItemId]);
        var openId = openRunOfKey[key];
        var notLater = false;
        if (openId && typeof msg._ts === "number" && typeof newestTsOfRun[openId] === "number") {
          notLater = msg._ts <= newestTsOfRun[openId];
        }
        if (!ref.continued && !alreadySeen && !notLater && openRunOfKey[key]) delete openRunOfKey[key];
        runId = openRunOfKey[key];
        if (!runId) {
          runId = "run" + runSeq++;
          openRunOfKey[key] = runId;
          keyOfRun[runId] = key;
          (runsOfKey[key] || (runsOfKey[key] = [])).push(runId);
        }
      } else if (msg.role !== "user") {
        runId = runOfIndex[i - 1];
      }
      if (!runId) continue;
      if (typeof msg._ts === "number") {
        var prevTs = newestTsOfRun[runId];
        if (typeof prevTs !== "number" || msg._ts > prevTs) newestTsOfRun[runId] = msg._ts;
      }
      var g = groups[runId];
      if (!g) {
        var fileKey = keyOfRun[runId];
        g = groups[runId] = {
          key: fileKey,
          runKey: runId,
          // provisional; renumbered newest-first below
          name: ref ? ref.name : fileKey,
          path: ref ? ref.path : void 0,
          mime: ref ? ref.mime : void 0,
          size: ref ? ref.size : void 0,
          isReindex: !!(ref && ref.isReindex),
          members: [],
          passCount: 0,
          status: "done",
          cancellableIds: [],
          cancelling: false,
          stopped: false,
          mayHaveOlder: false,
          // The run's first loaded pass, and never re-stamped: see the file
          // docstring. `anchorId` is filled in once every member is known.
          anchorIndex: i,
          anchorId: "",
          // All five are derived once every member is known, below.
          visibleMembers: [],
          driver: "single",
          finished: false,
          resolving: false
        };
        order.push(runId);
      }
      if (ref) {
        if (ref.name) g.name = ref.name;
        if (ref.path) g.path = ref.path;
        if (ref.mime) g.mime = ref.mime;
        if (typeof ref.size === "number") g.size = ref.size;
        if (ref.isReindex) g.isReindex = true;
        if (!ref.continued) g.mayHaveOlder = false;
        g.passCount++;
      }
      g.members.push({ msg, index: i });
      runOfIndex[i] = runId;
      if (msg._serverItemId) runByItemId[msg._serverItemId] = runId;
      if (ref && ref.name) keyByName[ref.name] = g.key;
    }
    var newestRunOfKey = {};
    for (var nk in runsOfKey) {
      var nrs = runsOfKey[nk];
      if (nrs.length) newestRunOfKey[nrs[nrs.length - 1]] = true;
    }
    for (var rk in runsOfKey) {
      var runIds = runsOfKey[rk];
      for (var ri = 0; ri < runIds.length; ri++) {
        var grpR = groups[runIds[ri]];
        if (!grpR) continue;
        var first = grpR.members[0];
        var firstId = first && first.msg && (first.msg._serverItemId || first.msg._localId);
        grpR.runKey = rk + "#" + (firstId || "n" + ri);
      }
    }
    for (var oi = 0; oi < order.length; oi++) {
      var grp = groups[order[oi]];
      var lastSettled = -1;
      for (var si = 0; si < grp.members.length; si++) {
        if (!isPendingMsg(grp.members[si].msg)) lastSettled = si;
      }
      var active = false;
      for (var mi = lastSettled + 1; mi < grp.members.length; mi++) {
        if (isPendingMsg(grp.members[mi].msg)) {
          active = true;
          break;
        }
      }
      var stopped = false;
      for (var ki = 0; ki < grp.members.length; ki++) {
        var km = grp.members[ki].msg;
        if (km.isCancelled) {
          stopped = true;
          break;
        }
        if (km._serverItemId && stoppedIndexIds[km._serverItemId]) {
          stopped = true;
          break;
        }
      }
      grp.stopped = stopped;
      for (var xi = 0; xi < grp.members.length; xi++) {
        if (grp.members[xi].msg._cancelling) {
          grp.cancelling = true;
          break;
        }
      }
      var seenIds = {};
      for (var ci = 0; ci < grp.members.length; ci++) {
        var cm = grp.members[ci].msg;
        if (cm._cancelError && !stopped && (active || grp.cancelling)) grp.cancelError = cm._cancelError;
        if (cm.role !== "user" || !cm._serverItemId || cm._cancelling || cm.isSendingToServer) continue;
        if (!(cm.isPendingQueued || cm.isPendingInProcess)) continue;
        if (ci < lastSettled) continue;
        if (seenIds[cm._serverItemId]) continue;
        seenIds[cm._serverItemId] = true;
        grp.cancellableIds.push(cm._serverItemId);
      }
      if (active) {
        grp.status = "active";
        if (stopped) grp.cancelling = true;
      } else if (stopped) {
        grp.status = "cancelled";
      } else {
        var last = grp.members[grp.members.length - 1].msg;
        grp.status = last.isError ? "error" : "done";
      }
      var sawFirstPass = false;
      for (var pi = 0; pi < grp.members.length; pi++) {
        var pm = grp.members[pi].msg;
        if (pm.role !== "user") continue;
        var pref = readFileRef(pm);
        if (pref && !pref.continued) {
          sawFirstPass = true;
          break;
        }
      }
      grp.mayHaveOlder = !sawFirstPass && hasMoreHistory;
      var anchor = grp.members[0];
      grp.anchorIndex = anchor.index;
      grp.anchorId = anchor.msg._serverItemId || anchor.msg._localId || "";
      var sawComplete = false;
      for (var vi = 0; vi < grp.members.length; vi++) {
        var vm = grp.members[vi];
        if (vm.msg._indexComplete) sawComplete = true;
        if (!isHiddenPass(vm.msg)) grp.visibleMembers.push(vm);
      }
      grp.driver = !isPagedReadFile(grp.name, grp.mime) ? "single" : isImageVisionFile(grp.name, grp.mime) ? "worker" : windowedIndexing ? "worker" : "client";
      if (grp.status === "active") {
        grp.finished = false;
      } else if (grp.status === "cancelled") {
        grp.finished = true;
      } else if (grp.driver === "single") {
        grp.finished = true;
      } else if (grp.driver === "client") {
        grp.finished = sawComplete || grp.status === "error" || grp.passCount >= MAX_INDEXING_RESUME_PASSES;
      } else {
        grp.finished = !newestRunOfKey[order[oi]] || !!doneKeys[grp.key] && !liveIndexKeys[grp.key] || liveIndexChecked && !liveIndexKeys[grp.key];
      }
      if (grp.status !== "done") {
        grp.resolving = false;
      } else if (grp.mayHaveOlder && loadingOlderHistory && !liveIndexKeys[grp.key] && !doneKeys[grp.key] && newestRunOfKey[order[oi]]) {
        grp.resolving = true;
        grp.resolvingReason = "history";
      } else if (!grp.finished && grp.driver === "worker" && !liveIndexChecked && !liveIndexKeys[grp.key]) {
        grp.resolving = true;
        grp.resolvingReason = "status";
      } else {
        grp.resolving = false;
      }
    }
    var stubList = [];
    var runStubs = opts && opts.runStubs;
    if (runStubs) {
      var coveredPaths = {};
      var coveredPathlessNames = {};
      for (var ci = 0; ci < order.length; ci++) {
        var cg = groups[order[ci]];
        if (cg.path) {
          coveredPaths[canonIndexKey(cg.path)] = true;
          if (cg.key) coveredPaths[canonIndexKey(cg.key)] = true;
        } else if (cg.name) coveredPathlessNames[canonIndexKey(cg.name)] = true;
        else if (cg.key) coveredPaths[canonIndexKey(cg.key)] = true;
      }
      var now = opts && typeof opts.now === "number" ? opts.now : Date.now();
      var stubClearedAt = opts && typeof opts.stubClearedAt === "number" && opts.stubClearedAt > 0 ? opts.stubClearedAt : 0;
      for (var sp in runStubs) {
        var rec = runStubs[sp];
        if (!sp || !rec || !rec.status || coveredPaths[canonIndexKey(sp)]) continue;
        var fname = rec.filename || sp.split("/").pop() || sp;
        if (coveredPathlessNames[canonIndexKey(fname)]) continue;
        if (stubPlatform && rec.platform && rec.platform !== stubPlatform) continue;
        var live = !!liveIndexKeys[sp] || !!liveIndexKeys[canonIndexKey(sp)];
        if (!live && (liveIndexKeys[fname] || liveIndexKeys[canonIndexKey(fname)])) {
          var claimedByOther = false;
          for (var lk in liveIndexKeys) {
            if (!liveIndexKeys[lk]) continue;
            var lkc = canonIndexKey(lk);
            if (lkc === canonIndexKey(sp)) continue;
            if (lkc.length > fname.length && lkc.slice(-(fname.length + 1)) === "/" + fname) {
              claimedByOther = true;
              break;
            }
          }
          live = !claimedByOther;
        }
        var recWhen = typeof rec.finished === "number" ? rec.finished : typeof rec.started === "number" ? rec.started : void 0;
        if (stubClearedAt && !live && recWhen !== void 0 && recWhen <= stubClearedAt) continue;
        var st = "active";
        var fin = false;
        var res = false;
        var reason;
        if (!live) {
          if (rec.status === "done" || doneKeys[sp] || doneKeys[canonIndexKey(sp)] || doneKeys[fname] || doneKeys[canonIndexKey(fname)]) {
            st = "done";
            fin = true;
          } else if (rec.status === "error") {
            st = "error";
            fin = true;
          } else if (rec.status === "cancelled") {
            st = "cancelled";
            fin = true;
          } else if (liveIndexChecked) {
            st = "done";
            fin = true;
          } else if (typeof rec.started === "number" && now - rec.started > RUN_RECORD_WORKING_STALE_MS) {
            st = "error";
            fin = true;
          } else {
            res = true;
            reason = "status";
          }
        }
        var sg = {
          key: sp,
          // ONE identity for the run whether it renders from the record or
          // from its loaded passes: the views key the DOM off runKey, so a
          // 'stub:'-prefixed key meant every handoff was an unmount plus a
          // remount somewhere else. Named after the record's start, which
          // the real group below reuses when it has one.
          runKey: "run:" + sp + "#" + (typeof rec.started === "number" ? rec.started : "n"),
          name: fname,
          path: sp,
          mime: void 0,
          size: void 0,
          isReindex: false,
          members: [],
          passCount: 0,
          status: st,
          cancellableIds: [],
          cancelling: false,
          stopped: st === "cancelled",
          mayHaveOlder: hasMoreHistory,
          anchorIndex: -1,
          anchorId: "",
          visibleMembers: [],
          driver: !isPagedReadFile(fname, void 0) ? "single" : isImageVisionFile(fname, void 0) ? "worker" : windowedIndexing ? "worker" : "client",
          finished: fin,
          resolving: res,
          resolvingReason: reason,
          stub: true,
          stubError: rec.error || (st === "error" && !rec.error ? "Indexing did not finish." : void 0)
        };
        stubList.push({ started: typeof rec.started === "number" ? rec.started : Infinity, group: sg });
      }
    }
    var suppressAnchor = {};
    var stubByCanon = {};
    if (runStubs) for (var ck in runStubs) stubByCanon[canonIndexKey(ck)] = runStubs[ck];
    if (runStubs) {
      for (var ti2 = 0; ti2 < order.length; ti2++) {
        var tg = groups[order[ti2]];
        if (!newestRunOfKey[order[ti2]]) continue;
        var trec = tg.path && (runStubs[tg.path] || stubByCanon[canonIndexKey(tg.path)]) || runStubs[tg.key] || stubByCanon[canonIndexKey(tg.key)];
        if (!trec || typeof trec.started !== "number") continue;
        if (stubPlatform && trec.platform && trec.platform !== stubPlatform) continue;
        suppressAnchor[order[ti2]] = true;
        tg.runKey = "run:" + (tg.path || tg.key) + "#" + trec.started;
        stubList.push({ started: trec.started, group: tg });
        overlayRunRecordVerdict(tg, trec, liveIndexKeys);
      }
    }
    stubList.sort(function(a, b) {
      return a.started - b.started;
    });
    var out = [];
    var si = 0;
    for (var j = 0; j < list.length; j++) {
      var mts = list[j] && typeof list[j]._ts === "number" ? list[j]._ts : void 0;
      if (mts !== void 0) {
        while (si < stubList.length && stubList[si].started <= mts) {
          out.push({ kind: "indexing", group: stubList[si].group, index: -1 - si });
          si++;
        }
      }
      var r = runOfIndex[j];
      if (r === void 0) {
        out.push({ kind: "message", msg: list[j], index: j });
        continue;
      }
      if (groups[r].anchorIndex === j && !suppressAnchor[r]) {
        out.push({ kind: "indexing", group: groups[r], index: j });
      }
    }
    while (si < stubList.length) {
      out.push({ kind: "indexing", group: stubList[si].group, index: -1 - si });
      si++;
    }
    return out;
  }

  // src/engine/project_settings.ts
  var UPLOAD_ACCESS_GROUPS = ["public", "authorized", "private"];
  var DEFAULT_UPLOAD_ACCESS_GROUP = "authorized";
  var PROJECT_SETTINGS_UNIQUE_ID = "bq::settings";
  var UPLOAD_ACCESS_LABELS = {
    public: "Public",
    authorized: "Signed in users",
    private: "Only me"
  };
  var UPLOAD_ACCESS_HINTS = {
    public: "Anyone can ask about this file, including visitors who are not logged in.",
    authorized: "Only users signed in to this project can ask about this file.",
    private: "Only you can ask about this file."
  };
  function normalizeUploadAccessGroup(value) {
    return UPLOAD_ACCESS_GROUPS.indexOf(value) === -1 ? DEFAULT_UPLOAD_ACCESS_GROUP : value;
  }
  function normalizeProjectAccessSetting(value) {
    if (value === "ask") return "ask";
    return UPLOAD_ACCESS_GROUPS.indexOf(value) === -1 ? null : value;
  }
  function accessSettingFrom(data) {
    return normalizeProjectAccessSetting(data?.upload_access_group);
  }
  function uploadAccessGroupFrom(data) {
    const v = accessSettingFrom(data);
    return v && v !== "ask" ? v : DEFAULT_UPLOAD_ACCESS_GROUP;
  }
  function asksUploadAccessFrom(data) {
    return accessSettingFrom(data) === "ask";
  }
  var reader = null;
  var cache = /* @__PURE__ */ new Map();
  function configureProjectSettings(fn) {
    reader = fn;
  }
  function entry(service) {
    let e = cache.get(service);
    if (!e) {
      e = { data: null, settled: false, inflight: null };
      cache.set(service, e);
    }
    return e;
  }
  function loadProjectSettings(service) {
    if (!service) return Promise.resolve(null);
    const e = entry(service);
    if (e.settled) return Promise.resolve(e.data);
    if (e.inflight) return e.inflight;
    if (!reader) return Promise.resolve(null);
    const run = reader(service).then((data) => data && typeof data === "object" ? data : null).catch(() => null).then((data) => {
      const cur = entry(service);
      if (cur.inflight === run) {
        cur.data = data;
        cur.settled = true;
        cur.inflight = null;
      }
      return data;
    });
    e.inflight = run;
    return run;
  }
  function primeProjectSettings(service) {
    void loadProjectSettings(service);
  }
  function readyProjectSettings(service) {
    return loadProjectSettings(service);
  }
  function cachedProjectSettings(service) {
    const e = cache.get(service);
    return e && e.settled ? e.data : null;
  }
  function projectUploadAccessGroup(service) {
    return uploadAccessGroupFrom(cachedProjectSettings(service));
  }
  function projectAsksUploadAccess(service) {
    return asksUploadAccessFrom(cachedProjectSettings(service));
  }

  // src/index.js
  (function() {
    var MCP_PROD = "https://mcp.broadwayinc.computer";
    var MCP_DEV = "https://mcp-dev.broadwayinc.computer";
    var BQ_VERSION = "1.10.0" ;
    var ATTACHMENT_URL_EXPIRES_SECONDS = 600;
    var GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
    var GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
    var GOOGLE_SCOPE = "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email";
    var MARKED_CDN = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
    var SK = {
      theme: "bq_embed:theme",
      mcpClient: "bq_embed:mcp_client",
      mcpToken: "bq_embed:mcp_token",
      mcpState: "bq_embed:mcp_state",
      // sessionStorage
      googleInProgress: "bq_embed:google_in_progress",
      // sessionStorage
      googleRedirect: "bq_embed:google_redirect",
      // sessionStorage
      clearHorizon: "bq_embed:clearedAt",
      anonId: "bq_embed:anon_id"
      // per-project anonymous device id
    };
    function h(tag, attrs) {
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
        child.forEach(function(c) {
          append(parent, c);
        });
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
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function getQueryParam(name) {
      var m = window.location.search.match(new RegExp("[?&]" + name + "=([^&]+)"));
      return m ? decodeURIComponent(m[1]) : null;
    }
    function cleanUrl() {
      try {
        var url = window.location.origin + window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, url);
      } catch (e) {
      }
    }
    function base64UrlEncode(bytes) {
      var str2 = "";
      for (var i = 0; i < bytes.length; i++) str2 += String.fromCharCode(bytes[i]);
      return btoa(str2).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    function randBytes(n) {
      var b = new Uint8Array(n);
      crypto.getRandomValues(b);
      return b;
    }
    function safeJsonParse(raw, fallback) {
      if (!raw) return fallback;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    }
    function lsGet(key) {
      try {
        return localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    }
    function lsSet(key, v) {
      try {
        localStorage.setItem(key, v);
      } catch (e) {
      }
    }
    function lsDel(key) {
      try {
        localStorage.removeItem(key);
      } catch (e) {
      }
    }
    function ssGet(key) {
      try {
        return sessionStorage.getItem(key);
      } catch (e) {
        return null;
      }
    }
    function ssSet(key, v) {
      try {
        sessionStorage.setItem(key, v);
      } catch (e) {
      }
    }
    function ssDel(key) {
      try {
        sessionStorage.removeItem(key);
      } catch (e) {
      }
    }
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
    var S = {
      skapi: null,
      opts: {},
      mountEl: null,
      // host-provided container
      root: null,
      // .bq-agent element we own
      booted: false,
      user: null,
      // current UserProfile or null
      service: null,
      // resolved service info ({ ai_agent, name, ... })
      projectId: null,
      owner: null,
      theme: null,
      // agent config (read-only, admin-provided)
      aiPlatform: "none",
      // "claude" | "openai" | "none"
      aiModel: "",
      // chat state (populated in the chat-engine phase)
      messages: [],
      attachments: [],
      view: null
      // current view name
    };
    function skey(base) {
      return base + ":" + (S.projectId || "default");
    }
    function anonymousAllowed() {
      if (S.opts && typeof S.opts.allowAnonymous === "boolean") return S.opts.allowAnonymous;
      var conf = S.service && S.service.conf || null;
      if (!conf) return false;
      return conf.require_login === false;
    }
    function isAnonymousSession() {
      return !S.user && anonymousAllowed();
    }
    function randomId() {
      try {
        var buf = new Uint8Array(16);
        (window.crypto || window.msCrypto).getRandomValues(buf);
        var out = "";
        for (var i = 0; i < buf.length; i++) out += ("0" + buf[i].toString(16)).slice(-2);
        return out;
      } catch (e) {
        return "x" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      }
    }
    var _anonIdMemo = null;
    function anonDeviceId() {
      if (_anonIdMemo) return _anonIdMemo;
      var key = skey(SK.anonId);
      var stored = lsGet(key);
      if (stored) {
        _anonIdMemo = stored;
        return stored;
      }
      var minted = "anon_" + randomId();
      lsSet(key, minted);
      _anonIdMemo = lsGet(key) || minted;
      return _anonIdMemo;
    }
    function loadTheme() {
      var stored = lsGet(SK.theme);
      if (stored === "dark" || stored === "light") return stored;
      if (S.opts.theme === "dark" || S.opts.theme === "light") return S.opts.theme;
      try {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
          return "dark";
        }
      } catch (e) {
      }
      return "light";
    }
    function applyTheme(theme) {
      S.theme = theme === "dark" ? "dark" : "light";
      if (S.root) S.root.setAttribute("data-bq-theme", S.theme);
      var modals = document.querySelectorAll(".bq-modal-root");
      for (var i = 0; i < modals.length; i++) {
        modals[i].setAttribute("data-bq-theme", S.theme);
      }
      lsSet(SK.theme, S.theme);
      var toggles = document.querySelectorAll("[data-bq-theme-toggle]");
      for (var j = 0; j < toggles.length; j++) {
        toggles[j].innerHTML = S.theme === "dark" ? THEME_ICON_SUN : THEME_ICON_MOON;
      }
    }
    function toggleTheme() {
      applyTheme(S.theme === "dark" ? "light" : "dark");
    }
    function getProfile(refresh) {
      try {
        return S.skapi.getProfile(refresh ? { refreshToken: true } : void 0).then(function(u) {
          return u || null;
        }).catch(function() {
          return null;
        });
      } catch (e) {
        return Promise.resolve(null);
      }
    }
    function refreshSkapiSession() {
      return getProfile(true).then(function(u) {
        return !!u;
      });
    }
    function loadServiceInfo() {
      S.projectId = S.skapi && (S.skapi.service || S.skapi.connection && S.skapi.connection.service) || S.projectId;
      S.owner = S.skapi && (S.skapi.owner || S.skapi.connection && S.skapi.connection.owner) || S.owner;
      return Promise.resolve().then(function() {
        if (typeof S.skapi.getConnectionInfo === "function") return S.skapi.getConnectionInfo();
        return S.skapi.connection || null;
      }).then(function(conn) {
        if (S.opts && S.opts.dev) console.log("[bunnyquery] loadServiceInfo", conn);
        if (conn) {
          S.projectId = conn.service || S.projectId;
          S.owner = conn.owner || S.owner;
        }
        return conn;
      }).catch(function() {
        return null;
      });
    }
    function render(viewName, builder) {
      if (!S.root) return;
      S.view = viewName;
      clear(S.root);
      var node = builder();
      if (node) S.root.appendChild(node);
    }
    function brandTitleEl() {
      return h(
        "div",
        { class: "bq-title-left bq-brand" },
        h("img", { class: "bq-brand-icon", src: BQ_LOGO_URI, alt: "", "aria-hidden": "true" }),
        h("span", { class: "bq-brand-name", text: "BunnyQuery" }),
        S.serviceName ? h("span", { class: "bq-brand-sep", text: "\xB7" }) : null,
        S.serviceName ? h("span", { class: "bq-brand-project", title: S.serviceName, text: S.serviceName }) : null
      );
    }
    function pageRoot(content) {
      return h(
        "div",
        { class: "bq-meta" },
        h(
          "div",
          { class: "bq-section-title" },
          h("div", { class: "bq-title-row" }, brandTitleEl())
        ),
        h(
          "div",
          { class: "bq-page" },
          h("div", { class: "bq-settings" }, content),
          pageFooter()
        )
      );
    }
    function pageFooter() {
      return h(
        "div",
        { class: "bq-page-footer" },
        h("a", {
          class: "bq-page-footer-link",
          href: "https://www.bunnyquery.com",
          target: "_blank",
          rel: "noopener noreferrer",
          text: "www.bunnyquery.com"
        }),
        h("div", { class: "bq-page-footer-version", text: "v" + BQ_VERSION })
      );
    }
    var BUNNY_FRAME_A = '  (\\(\\\n  ( - -)\n c(")(")';
    var BUNNY_FRAME_B = '  /)/)\n ( . .)\nc(")(")';
    var BQ_LOGO_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAAQHRFWHRTb2Z0d2FyZQBSZWFsRmF2aWNvbkdlbmVyYXRvciAoaHR0cHM6Ly9yZWFsZmF2aWNvbmdlbmVyYXRvci5uZXQpmZlW4QAAEABJREFUeAHsXQmAjVXf/517Z7U0jMaMZQZFRJaslX1rEaIQEqlICinCm7VNKhWVpaIsoRLefG1StHzFi1JooSwZY2eEMWNm7vP9fufeO2aScWexvZ9xznP2c/7LOf/zP//zPJcLF//OKQUuMuCckh+4yICLDDjHFDjHw19cARcZcI4pcI6Hv7gCLjLgHFPgHA9/tlZAWGxsbMlSpUqVjoyMvOQc43yq4U1ERERRwShYWSmE/oy7M8WA4NKlS5ePi4vrR2S+ZHy/A2eHcZntBQqEJ5YuXWor86bR31i2bFQMsTxTcLDrUzo3YSvJv3aEYxb9tkKFCu1n7e2O4+xg+gD9F/QP0pdnfhB9vrt8RzwmJiaKAD9mjPmYiExwu92NOKsKVK9WHbVq1kL58hVMgYKFyhCTu43BorS00PdZ3v/SSy8twbyz4kpzBpD4AwnfQpfb9S4H7Va4cOHYK6+80tStWxdVq1ZFdEx0QZfLNGXZRBh8VKpUqaH0xZjOV5evDChRokQZEvxtGPMvhuVbtGhhpk2bhnfffRcKX3vtNcyePRuLP/gAY8Y8jiuuqBhqjLmOK+OZ8PCwedHRsVflK3b/0BmJWJ3Zc0n8Jzl23SqVqwQ//fTT+IAwzZgxA1OnTsX06dMx/735FuYmTZoYl8tdgXVHuFyuucKR7fPN5RsDoqOji5PoL5CYLUqWKBk8btw4TJkyBU2bNgVnG4oXL46oqChwyaNChQro2fMuLFq0CCNGjECJmBJkhKtRcLCzjAjeULly5XyXv+pTfXNyfE44GxKO0DFjxmDhwoXo1q0bLr/8crAcXImIjo5GmTJl0Lx5C7zxxjQ8M3YsuLJDHKBFUJB7AnGJzi8O5BcDTFBQ0BDOqrZl48qa8eOfR4cOHRAcHJwtnAULFsS9995rZ1rLltcjKDj4UhJn1uHDh7uJYNk2zllhyKFDh7pyBs8MCQ4uduONN+Ktt97CXXfdhbCwsGx7CgkJRqdOnfD8888jtnSs8Xic1sRrGBsZ+jy7fGEAZ1NzQtI3IiIi6Iknn0D9+vU50bLCR+ZAnvVOclWqVMEzz4xFm9ZtVBbFemMTExMbKZEfnvA1oggZS1+8w20dIJFTqVKlLF07THFcC6NCJjMcGYdGjRrhyaeeBPcKNwv6cJXczDDPLs8M4IYbTgBH0ofdcsstqFevXhagPEeOInXtOqS8swDJb85CyqLFSF3/C9L/OgzHI7RhmVWsWDG88MJ4tGvXDlxNxQHM4bKvwjBPjhpBBXYwm33G3HrrrXh67NMoWrQos7zOSUtH+oGDSF2xCinz5iN52gwkv7sAx3/aAE/yMW8l3/Ma4ta2bVvBG8qVOpiMLeArynWQZwYgDXU5YyoWKVIEN910U8aSFmnT9x/AcRI87YP/gfPbb0B8PDw/rUPagoVIJbLpG36BCOCHnkjZPUGzjfEoMnUykYz1l+c05N5TMsRxprjdQdHNmjXH8OHDwX4zuvEkpyD1P6uROmsuPJ8sgbNpE5CwA/jlV6Qv+gCpiz+BczQpo354eLjFUbhyNVUi3rUzCnMZySsDjMflqcuxI3nKQq1atRj1Oic1FamfLoWzebM3w/hEkkPWpHt4KtiB1A8/RurK1SAi3jp8ahMcOHCg3bTJgGsAV0/2m/1mwnb/4II8Hs9dxpgG0dHF8dCAAdAq89djGVKXLEX6F8vhJB4EDEBArDeGMHrS4dnwM1KXLmM20yyWq127NrgywX6LEr6aysuLzxMDKH60g11BAILqUX/WDGHcOs/2HXASEmycWDEkEh4PQLHDQ5kXqWPHkLb0c6StXAMnPZ11IMRQvXp1PPjgg5qtwS4X7tqxd6/ECHLyx5Wjw1NPEimkX79+uKrqVbZv9eE5fhypHy2B5/u1cBjXBBBMBAogmFY0aqLQe7gqPLt2q5n1Uhx0VmCbYPry/Au1Bbl85IkBHDOcM6EEQ0s0hdYTCQt0SjKTTDgkvAhM4gtDTTYW0DkwRDL9y6+R/huXP+PMtK5Lly5o0KCB4uVcHs9ARXLo+7F++WbNmqFz586Mep0YnbZmLTw//uTNEDAalyCK+JYJtoQFdDieCouLzfM+KlNp8MZQMi0tLdwXz1WQJwakpqbqeF5II9PMo8DrOdOdw4cBbnCOxI0ILySFoeOtYjSyIYbMd44eRdpX38I5fMRbyGdISAgefvhhXHLJJWDVbpzRVzM7IEc9vZoxpqdk9QCKHqqNGe08+w/C891KgCKS3PeuCsLg4SThjPbWI1iaKDaRlgoQPhv3PXiYszGOUTQ5OTk34tG214O4Kci9J9AW3LCwEyvRLmfOeIeMyJhRLlsNQtp6MsKxWYyQMc4O7gkSCUrC+6cDmw5yRDSMouRh5koFZJCtc5Pgg9gmvGnTZvaA5a+t2Z/61TeU+Yk2y4HhyD5SkwmC2zEEis7CqFrMR1qaYhm+YIECMEaVWMtxbCSjMIeRPDPAP94xynN/3BgDExoC4zIAnbwDImqIMCOOvMoYQiHLVCft25Xw7N+vlPWFChUCzRmQ3GVGk5i4mEoMs3XR0dGVWaGp2rZs2QIKmbaETtu8FQ41LxAOCC7OenCSSAwqKW8njOASXQmow7qOOyvfk5KOsZrDph4Wa8fWCLnzeWIAdWvtnFZP27tnzwkIuHOSaoBLgJtM+YyL4MbFqePNJo6WOEoZ6t2pX1MUKeHzDRo0tKYBJqOCPEFNGWbnjNvtbsIKtHpE4brrrmPU51LTkP6/33EWEGSXL0+EtlEvXHwSLmZ6HEtgAWZcbhjOeFvN99izx7spG2OOUFRmXR6+OoEGflACrZ+lHjegZAJhofnDr276argou+HmFkEKW8SMsZPOW+xHkMiyPKOAdbCFs3TviVVQrFgkmjfXQRuhVB3rU00t7O3j5CfLtB9dy5JQbb7FeLhj3Lp0aWV799q4CEsIvHGjgHBobHkmmQLIBLCiQ3OK4RmH2Rnu999/98d3kwYp/kRuwjwxYPfu3ce4B2zlwJ41a773zhom5EzUpQDtKBB1hREJzbqA0vQWb/BPZTZghCJBG3I6mUDcmet1Oh0rZoypyRl34hirzEyesj+SdWrTW1uUv0iKQPqWLYAVkxyHnUvsiMCqa1wuznzWFlCMQ94wQZhBZcAlXFgsx0mAn36yGpT0pu0JCQlS9VSUK+/KVasTjTzcHKk/ImnLls3Yt29fRomLM5emReIohBUIIV+xovTeFOciEfXWYg43PM/27XBSjzPhdbTT47LLLlPicj5OeTJ2u93ljDGXUTdHFltPcjIcrgBQIyPtCQx74ZiGE4Exr2PalilFYNgPY6wRWxqmsBYWk3S7du3Ctm3bGMNRPjbSixEMcufyygDN+vUElsbGQ1i/fn0GFJpV7to1AWOgP+8T3qThsMw3xsBwTzCGIUQXw4cHnh074SSdmFgkLJo0acK2xm2MOaWRjrOzEVeZu1HDRlAbdmldelISHBKOwLJ/ZZHCEjE+onsDKggaXgmGHAwOV4K71tWMKkPtgJ9//hmHDv2lxKH09PR1iuTFkxJ5aQ6ZnGnkwSaakLF69WpqbCf2pKCKFWBK2nMaByHShkhCyDAuR2TpWMY8pkUdmz54EM7RE2cCVkDtOnUUyGfaWZU84bka6ytV75p6CjK8oz3F6vIchEOBMDhkPAgP+KfAuOAVQwJAnsvBlC2DoDKx8P/x3GNxPHKEZxzgj927C2v1+4tzFXLYXLXLaLR161ZN1TmcDfjmm29w4MCBjDIXN7CgRg05k9xEh9lCTD6dhNAMZBYgijAN/TEuwlA19OzybZjKpq9Qvjxk6jDcB5hkRT6zOuXVltqpyxV/kXr2bPsT4GyGMZBXngVIsMD3ZzMVNzAKCHtw4wbQSlZS/iAnxnfffQfhShDnAL/naQNWn3lmgDrhzCAw2KXN6ccff1RWhneXKQ2U4xWwELTePliukIEokRFlhA5kgmen346kOkABqoLULZUoGRkZeZImxLJoiqBIngOoARdUPa9nf85uKmrsE4Yr0FLXW6QnRZYC6/38YBNw04ErJsbm+x/r1q2zG7AxZmda2nHh7C/KdZgvDKA2dJTIv0iVzHn55ZfB43kGQC4SLrjm1YA9KRM1Th0ri0UIeWbZtFowbegVdWijz8hnRmhoKEh4xqCVUM5GMj14JtG9LS2ekVDdTEU83HFVcsVZYjO0ZYao+1aFwzEFhkSgykxoOIJq1oCL5mel5YWTcBOOXAEv7927N6uMVKV/8KfLIhSnqxJYOQGbTwR/0wp45513TjQiRYMqXQE374FBpI2bQxphbGBsLaLum3rG5hjmUjOiLYkljHsdVUzwxg1qaoyZEBsXO4P2/hlxDOPi4mbwrvY55iOiSBHtS95GesokwkshRdWzAf8ZeoJBeJVNujswxgCCzxi4qlZBUHkqXMyC7+/9+e/jhx9+UGoTN/j3FMkPTzDyoxtgz549fxpj3iZSqW9Mm4Y//6Tc9XVtgoIQ3Op6mGJ6q4NYieD0jsqZJPaQ2HGMYQ5z5azOzqTPcYbrOpDEDdGlT+Ow0LDuYeH0YeHdOeO7BweH1LN1ChWGQl8zyNxMoQ2oa/tg57T124MWYbBD6sFy0h9OTDSCWzaDCXLD/7edavHU16aCqzyN+M2Nj4/X2cdfnKfQlafWWRunuVyuucz6NYGGtVmzZmUVRbyAD259I2jeJBmILWW/oTgwSrnsE6KDfbiDePwvCMPO/C6UIqh9+/b417/+hZEjR0JvNIwePQajRo226cceewxDhwxFmzZteHYK8Tdj6MAUiQD1UnjVHACiNABjQ8NsA4IDFCmK0JtvgsuKS9g/iR69SrODOJH4m4wxkv0nVD1bK/eP/GQAOFM2c5aM5KbsSAyt4/VjZtDcVOtc114DhysCQl4eRN7Qc68wla+E++ZWCLm7O0K7dgSUD+8fT8Bo2bIl7r77bvsaiWz8XWjn79KlM+644w707NkTve/rbY13ElfeViAxwxDWsxv77IGgm2+GqUJbXYGC/mIv4WGAkFC4r7sGrtIlT5QxJpE6b948HD9+3GHySTIiz6on+8lw+coA9spLsIRFnCmvJSYmpg8a/IhEE7O9znDTC6lTE64a1eAUCIdzaTG4uEEHdeuC0IEPIqzTbVC5u1RJuCjLva3y+OSYLl7Cq89gjq0xQgf2Q1C3rnDVrgVE0WRCWNxX10BwzRoQjP4RudFi6NChoPpJCx5m0uyg2S9G+KvkOcxvBvgBepKRb7Zs2eqMHDkii4nCcPaH3NgSIe3bIvSuOxHSthU3vMvgos2Fbc6KMyHBCKpwOUIoEkN6dENQuzYIatEEVkz5IJBZRS+N/fHHH1TGnO+4skf5ivI1OCMM4DLdyVWwyBiTspR3vtOnTUdKyokzi4gdXJGaEW0srEMBYPIVqdN1ptGsNwZuwhDME7sOjcoD/wTrNMK8dOlSGOLArEU7d+7czjDfXb4zgLr6JXgyBi8AABAASURBVCVKlLiXgI8gE8IKcvNNOZ7CG0Be7eU7+GemQ+5hSEo6qvOGZn+ocZlhcXGl7qW5+6QDYF4hyFcGlC5dujzNBS9RT36ZDIjU2wPPP/88hgwZknEzlVeAz0Z7mTOkbQn2OrRBuYyrmMdjXqUmNkE45icM+caAokWLxnHGv07gulMPD5aWMnHCRKu5SINh/gXlSGzccMMNeJkne+FCnII4qboTielc4bStMJYPLj8YYAjQlbTVLCY8TTh73H363I/HxzyOktRmmHf2XT6OWLJkSXvmuP/++1GocCE3u27IFf5RTEwM9Vn4tw1m587llQGGgNR2uVxSz6rJECbNYdCgRxCa6TCTO9DOn1ahPAQ+8sgjGDF8BDjZBFhlMmEucZeNPE9MyBMDoqKiognIOEJUTe/vDOFJVK9ykyHM+u9ywqljx44YNGiQNYlQHF1FsfQcN+asJtMcop1rBnAzCueJcyzHa0oZ73rggQd4D3tbFjsMy/6rHAlOHDugf79+sri6uOc1Iu7Pc+UXzC2iuWVAEAcfyFlAI1iw/cjivvvuA9O5heOCaScc7+3VC/fccw84AYVzF0qBwUQgmD7HLlcMKFWqVGMyQO9eunRX27t3bx4itT/lePwLsgEJDuGsV1+IAK0Xpi9pcj3jOXY5ZkAR/vFY3pcjxXDpWUAyv3/D/P8XjgdOu/JFA1q1o4h0H4rlSIY5cjlmQHh4eFMuwxs0SpcuXaCDiuL/H71w79z5dj/qzXgp1cKfCDTMKQPc1AZGkwEF9eJsnz59ciR6KLZ0tLc+UADPVr3cwCZR1IdnnnLl7A1pAW7SIwlvjvaCHDGAeu8dHKCaBn7ooYeyXn6z4FSOpmnoG2HtF/ogT+rcZ58tyXJhc6q2Zzo/KSnJfiPcrt0tqFSpEpo0aYzXX38dgjmQsXnwRP/+/e1EJBOr8ODWLZB2/joBM4CyriAJ30sNq1SujGuuuUbR0/ojR47ghfEv4LnnnsXWbVtxlEauVatXQQx87733srxHdNrO8rmCjG5z5syhrepRrF37o50QW7dtg75xfu655yDYAxmyQYMGlnm+unfzfFTIFz9tEDADSPyr2VsFiiA0bNQIJ2+8LP0HRzMuFi5ayBslWkN9VxkOryIPHz4C3TTJ7v73ZiLMhg0b/G+g/b04R2m9MLbh55//0RqrsefPn89JkelrSMKo8RcsWIDtme61sxtUtBATRBuK5ysoikSr7JpklAXKAB23r2GrSJ14a9euHfCBSwz46y/7Kh+b0xFBPq3bmbDTzjqb8D1ki3/22Wft3W779reAt1C+kpOD9PR0yJ9c4s3Re5y33XYbWvMqcty4Z7LcSaiGvmng3QW4KdkrYeV5vWNnfzzvgb3p7J86D9Ti7VrhwoV1LihKJtRjC9GMQfYuIAZwSRWkfKvOroIjIiLsj1kwHpDT7NCdwD9Vjo6JRtjfvlTXNeCnn35qRVNERJFTElizd9KkSZg0aTJv3E68zp55HM1k2XGoneCzz5ay3r7MxXZsilZvHnVJ4kheOPSwdwEZZd4a2T6rXlUVmpzsQ5twDdEs2wa+woAYQCJdQq5eqTbSfti5ogH5uLg4+3sRbJ+lvmaNviumLSVLPi+/sd/3lYzuEXjAyVLuT6xYsQL6LYqpU6dg1apV/uwsodrqOzNlHjp0iGLwuKIZXnjczNUhWDIyfRF9q1ymTOBWZ26+EK6+5hXJiMK+eLZBQAxgZwUp36yuVbNmTTCebaeZC7Ushw4dhuuvv95+6SKC88Bij/L6nQjKy8zV7fGedwuchQ62bNmiJZ2lXAltjsuWLYPku/zXX38FiROVZfZi+mbfhyPFIovJfpO52I4lE4rgELMEW0xMjP0gZDgtn1rtWRpkkxBNatSo4a9RhpM2IPtQoAy4lD0XpUelihUV5MjHxpbGq6++ijfffBOTJ0+2m69unHiHcFI/Ir6fyfqJG72NxpN3Rj2JnilTpuLjTz6xE4GTw6qR06dPQ+a9RnvD6lWrMWvWbKsi1qlbBzzEZ/TjjwiGYcOGYe7cuRY2wTh16lSULVtGL2JBIlEX87/++iu2bt1qx9CY/vaZw4onaBPJ8YtkLjtVPCAGsHFpeqOBY8vEMZpzp2WuM4CuKTMt1ZM60n6hE3YkZ6w+Berbty+GDRtKcTMZumvQ7dSUKVPsJtm9e3dIhEi8vPTSBPurJqNHj7KEfPTRR/FAvwftKpIsV58i9kkD+jLKli1rf+eiMlVsEV0T5vbbO6Fjxw6488470eOuHuh6R1e0a9fOmiCkwR08eNDX2hv48eLKc9OX8OZm/wyUAZGOb5MqHqXf0ci+07yUEnBce+21GM+75NjYWLsfzJ07D08/PRYzZs6AvkWLiLgEvWmR1B4xbtyzJFB3eyj85ZdfMH36mxg7dix0xkgkgfRlzcSJL2f9kPwfAOSMxaZNmyyTJf91Dli3bj1n/GG7EmgCQFpqmoVn+fLleJT33NrDpk+fbleJ6CMRpq6FA0PZhxhk7wJiADvMWE6Ubdn3mE+lzZo3w9uz34ZeOezStStatWqFjh064uGBA6n5TMKjgx+1RL/kksLQu0easTrcWbWzdWv79pxeYZw9ezZndt1sodLGP4v1ZOFU/UujonD77bfbq8hJ1LRmzpyJOXPmcgLMxATecw+jyBLxte+MGT3a/qyCvo3gWSljnMzxjMx/iATEAHLX+2UzO5Bqx+CsuDiKux49ekBIakY+8cQT0MWPfhInJDQkAwZNivr162PAgAF46qmnoHPEqFGj7CuLpU5zL613P9Xv2Kefti8Ui9nvzJuH0SSsmKCxpPlJvGj/a9y4sRVBz/OkrL2ieo0akEY26JFB+OKLZUBA2j8y/gJigPGYI2rBlZDlVUPlnWmvMUVgaVOS4dI2TjWmylRH9hnp/2p7qrrK18yfzHOENmCNoT3m8TFjIJVSH+JNnDgRt3XqjJr16qPK1XVwXcOmuOfeXlaJkCYma6hEXUdeVR44eIDiazjp7+UAFYc9GuN0PiAGeIxnGztyhJA0Acb/K5zEhvYViQtpZXrJV0a4F154Af2HjMSSnxIQWf0GtOo1HB0HjkO19v2QFFUFU977FL369IXMGJQOdrVok/er1MxLJwN2BkKkgBhAwu+ht2JIn+kE0vH5XscvevRNm6yZ+o07qbg6uC1Z9Ruu6/QQHhv6KMYOuBODu12Phzs1QePGDVG5SXs06DYYpZp0x0uvzbBWXmlu6kNaHokP+v1k6qFAaOAKpBI5e5j1/qDHypUrT2keUPmF4iV2pObW5MFSIkTi6BWeVXYeD8edA5/CA21ro97lRVEgxFgtKDXdg+Q0GbJcCAkvhBIVa6Jqmz6YPH22/YnLyMhI+4tcvKQH/xKpVaUyPK0LiAHceA+Rq/oeGBJBW3lCPW3P53GFo0ePYtGiRfZkfMONN1jL7po1a7Byw2bc1LUv2teMQpECQdiwMwnzv9+L6St2Yxr99sQTLxgLvRIVqqN2u954ZdKr0Klde0LTpk11QJTVwJpuVC87HxADaJE8xk7+Q5+sw8fKU9heWH5BOM18WUEjaFisW6euCIbZc+Yh6oq6uLluBUSEe4m/5s8jqBlXGCFBLqSkw7fBOvDwTAT+GZdBuTrNkVbgUixfvpw5sOorI8FUCG5keFoXEAPYi8Ml9RVXwR7JzuW0w2Q+9rP8gnL6fk03YZLd+lkD4fS/K/6DylWro2SRUCQd9+C3PcfQ7IoI7DqcisRjHhJfKHqJTzoAJL7NNAYlqzayn6+qT/XnM3nUUYvT+UAZANrWf+XAn9LbD7L1VfzpOj9fy7WKKVbtG25Sb8UQinhEFY9GkNsgJc2DUIbJqR58u0Xbn2S/o83VosTZbUOby0dk6cuxe/due7ehPaBo0aIql/lGYbY+YAawl3TOlCcMzEFZIJ955hkOmFUmss4F4agiWmJSuYAxJHhKCozLBce4mQ+QpjhMmfND/FFb7kWKuQbetLERb0UAISHhSOPlkCanMQbUgFQvGAH85YQBoMq2Pd2TPsYYkyrr4HO855X2EMA451UVHdZEJE0krQS9cOt40rB95x7Ec6OV/zPxODbuSyYhAZIb+nMZF/yzX1wSwZV/5NA+FOF+IoOj+tMhzePxHFTZ6XyOGKDOCMBsDryE3pFFcPHixdCNk8ouFC/rqE6+x5KOIWFHgtWCysWVRvyWjVjw4z58uOEgPB6vyCGeFi2Xyw2tEiWMnyVcFCrf9dtqyOgnxnKScqLuhzFmveqezueYAdQeDrDTp+h3aiMeN24cvv/+eybPosvjUCKWNuC/Dv+F9RvW21ndgffP8RtWQCpqmojPMXzKDkhN60Vs0pxiik9b6CDlyCHs+/lbyMyuFfDVV1/x5s0eAZYhgL8cM4B9OmTCdx5j+pHLB3XprhulFStWXjArQTdy+nFYiaCvv/6ae1my/UniCE8idm38AXprwxLbkNDcG2BckOqpPA93a9oZbPp4chJWvf8qKlW4zP5guUTPXBryWG8v6fQF/WldbhhgO90ZH7+Aqqle0I2XVvHggw9YGzw3alt+Pj+MMejd+z57EPvss8+wdu1a+1PJ9917DzYumYGt3y+DJ10fw/vJQ0bQWSb4EEs5ehjrPpmFoukHMXrUKHu9qYsiTk7WxMcpKSn5ZwvyjXlSwNn/DjMf4RLdt2fPHsisK2uiZgLzz2tXvXo1dO3a1b4poXsDiVP9ROYTI/+FXz59E//hzE7+6wC0GiwiFDlaEPB4sGfzT/hy2khEHNuBZ8c9Y3+bVKJnzpw5MEASV8CXtCsdse1O8/Cz+DTVTlmcRo6/63g87TnoRi7ptNlvv422bdvg888/hw4mp2x5jgtcFC267qxVuzY2btyIvg/0tbq8bsPemT0LZcOSsOzF+/HV68OxetFU/PTpLKxZ8Aq+eGUg1r/zLFrVr4EJL45H+fKXQz/V9hzvB7QBRxUvXjA0NOTRuLhSzQL50fG8MsCSkaaKbxhpQya86fF4jm7a9Lu9HJGJd/ny5ectI4oXL86btcEoV64cVny3AoMHD7aHzNjY0tAd82tTJuPuW69Ho8uLoFa0wfXV4zD4/p6YxRsyfS8WHh5ubUq6CNKbfLq8mfbGG5yAt1QMDgl7h3fLD8fFxRUlbU7p8oUB6p0rYSN14IfJgE70G3RR/v7771tG9O17P7TZkUGqet54YwyvK+vxwn+KFSPffvstBvTvj4ceegi6H77qqqvsrZpM1LoC1S+6t23bFmV5ga+fLus/oD8eGz7c1hVSenuCsh/6JZcB/QcUc7nMaJ7WXsyOCfnGAAFAjh+hyeIjMuLadMcZxbw/uCyP66pO8rYV73V1dpDlUAwio1jl3DrBoJWg/UuE3X/gAP79739zFrfFbR062Bd1BfNHH34I/QSP3hfStWTnzp2xdOnnSUcOH070Y7Bn715u7r2tYU7vG02ePCWsVKnYHiz/kJrhO1yUAAADzUlEQVRXBYaGPovLVwb4e+YGdHhXQsITRE5iaThn/pfGmGTJSr0ucjsvvDWrXnmFMvWLL+z7n2frMEdYrNqpGf4hiTp+/Hh7qd6rVy/oJS6V0+9LTUv77vs1axJ42e/o7YsH+/XD8BHDMXPmjLStW7duIa7zHY9nIHG8i/XX0AOOo19WweOPPw69LaH9ZOLECahWrdq1xmBObGzxy9guizsjDPCN4FBL+oX7w3gStxP9TQRSe0Qi87BkyRK8+OKLkPzUhYhWiP4jn48//hjbt2+3lz6s7+sq94H6kFiQjNZvGA0bNszObL3ro8mgF8UkHhMTE1nV2UaCPkFYGx9PSbmVG3VDrWbmdSEE99D80J5l19E3o9HtXord14nLv5kWE1azjnXSCMVYaVe60Ne3ZOTNlR5PcH1bIdPjTDLAP4yHlsI9FE3LCezdxpjyREgALyZyW3iGOEBrZKpk6quvToKWrt5wqFGjBvQLWWKQDH96823hwgX4gitGt3Jrqbvrx5Tk9W6o1MBPPvkEUgW1snTB3rNnT0i11MtW+q+rBg0ahLeppf30449OQkLCMaqee3iW+Y2Un82wNcPKzB9JWH+mON1FuDYT9pXMm8dJMZ1+EctW0W/lajlEBKXzS3vSZVUv4vU9+2A27CrTf2DXokVz+6IY8Ratw2xhpocyMyWzi+ZPGWfNfiIwg0i1Y4+NCbS+KBnK8DUC/zn9H/THOCOhWyq9p693c0aNGo3+/QdAr6l07NiBMroNWrdpjdatW+PWW9ujW7c7rPwdMnSIldtvvfUWZfRSq2LSYChCHeIY69j3YoYTSPCB9J3oGxKm7oTpI8JkfwmecOXYsY+17PdONlxGr/EokRzs2rXbvrfKcfex/CSbzVlnAIHzOw8R3r5r166PCfyLbrf7IRZ0JpDNOVvqEeC2xniU9xLzFjIt4Dezzk4uZx5yDA89hkk5Q2RxkHUSHI/zC8OlbDOTJU8yfjfjjRmvS5HSiraeHhSNQ+incuwv6feyzBKMYZ4c+/qZY/TimFmYwHQy/SCOufbvA5xLBmSGxYmPjz9GhuwjkNsYX8f44vj4nRPInIGM30pfi/HL6UvSR7COW55xt89HMizFehIjLdlPD6ZHMP0m418zvpE+ntrXQQ58nP6MOIqpP7jn3EmCPwljZDWexD2iLsd+lwPKvsHghDtfGHACosBiHlb7u2fW+eGoBSaQ4CPjt2+/gRPgAe4j604F2YXKgFPhc8HlX2TAOWbZRQZcZMA5psA5Hv7iCrjIgHNMgXM8/MUVcBoGnOni/wMAAP//JHToiQAAAAZJREFUAwDDElGiVkDzSQAAAABJRU5ErkJggg==";
    function bunnyLoader(label, overlay) {
      return h(
        "div",
        {
          class: "bq-bunny-loader" + (""),
          "aria-hidden": "true",
          translate: "no"
        },
        h(
          "div",
          { class: "bq-bunny-stage" },
          h(
            "div",
            { class: "bq-bunny-track" },
            h(
              "div",
              { class: "bq-bunny-dir" },
              h("pre", { class: "bq-frame bq-frame-a", translate: "no", text: BUNNY_FRAME_A }),
              h("pre", { class: "bq-frame bq-frame-b", translate: "no", text: BUNNY_FRAME_B })
            )
          )
        ),
        label ? h("div", { class: "bq-bunny-loader__label", text: label }) : null
      );
    }
    function showLoading(label) {
      render("loading", function() {
        return h(
          "div",
          { class: "bq-page" },
          h(
            "div",
            { class: "bq-page-loading" },
            bunnyLoader("Loading...")
          ),
          pageFooter()
        );
      });
    }
    function mcpBaseUrl() {
      return String(S.opts.mcpBaseUrl || (S.opts.dev ? MCP_DEV : MCP_PROD)).replace(/\/+$/, "");
    }
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
        return crypto.subtle.digest("SHA-256", data).then(function(hash) {
          return { challenge: base64UrlEncode(new Uint8Array(hash)), method: "S256" };
        }).catch(function() {
          return { challenge: verifier, method: "plain" };
        });
      }
      return Promise.resolve({ challenge: verifier, method: "plain" });
    }
    function registerMcpClient() {
      var body = {
        client_name: "bunnyquery",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: [mcpRedirectUri()],
        token_endpoint_auth_method: "client_secret_basic"
      };
      return fetch(mcpBaseUrl() + "/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function(res) {
        if (!res.ok) {
          return res.text().catch(function() {
            return "";
          }).then(function(t) {
            throw new Error("MCP /oauth/register failed: " + res.status + " " + t);
          });
        }
        return res.json();
      }).then(function(json) {
        if (!json || !json.client_id) throw new Error("MCP register missing client_id");
        var stored = Object.assign({}, json, { registered_at: Date.now() });
        lsSet(skey(SK.mcpClient), JSON.stringify(stored));
        return stored;
      });
    }
    function startMcpAuthorize(client, redirectAfter) {
      var verifier = base64UrlEncode(randBytes(32));
      var state = base64UrlEncode(randBytes(16));
      return generateCodeChallenge(verifier).then(function(cc) {
        ssSet(skey(SK.mcpState), JSON.stringify({
          state,
          codeVerifier: verifier,
          redirectAfter: redirectAfter
        }));
        var currentUri = mcpRedirectUri();
        var params = new URLSearchParams({
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: currentUri,
          login_page: currentUri,
          state,
          code_challenge: cc.challenge,
          code_challenge_method: cc.method
        });
        window.location.replace(mcpBaseUrl() + "/oauth/authorize?" + params.toString());
      });
    }
    function beginMcpOAuthOnLogin(redirectAfter) {
      return registerMcpClient().then(function(client) {
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
        client_id: client.client_id
      });
      var headers = { "Content-Type": "application/x-www-form-urlencoded" };
      if (client.client_secret) {
        headers.Authorization = basicAuthHeader(client.client_id, client.client_secret);
      }
      return fetch(mcpBaseUrl() + "/oauth/token", {
        method: "POST",
        headers,
        body: body.toString()
      }).then(function(res) {
        if (!res.ok) {
          return res.text().catch(function() {
            return "";
          }).then(function(t) {
            throw new Error("MCP /oauth/token failed: " + res.status + " " + t);
          });
        }
        return res.json();
      }).then(function(json) {
        if (!json || !json.access_token) throw new Error("MCP token missing access_token");
        var token = Object.assign({}, json, {
          expires_at: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1e3 : void 0
        });
        lsSet(skey(SK.mcpToken), JSON.stringify(token));
        return { token, redirectAfter: stored.redirectAfter || "chat" };
      });
    }
    function mcpGrantNeedsRefresh(user) {
      var tok = getStoredMcpToken();
      var now = Date.now();
      var tokenSub = getJwtSub(tok && tok.access_token);
      var currentSub = user && typeof user.user_id === "string" ? user.user_id : null;
      var expired = !tok || typeof tok.expires_at === "number" && tok.expires_at < now + 6e4;
      var mismatched = !!tok && !!currentSub && !!tokenSub && tokenSub !== currentSub;
      return expired || mismatched;
    }
    function refreshMcpToken() {
      var client = getStoredMcpClient();
      var current = getStoredMcpToken();
      if (!client || !current || !current.refresh_token) return Promise.resolve(null);
      var body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
        client_id: client.client_id
      });
      var headers = { "Content-Type": "application/x-www-form-urlencoded" };
      if (client.client_secret) {
        headers.Authorization = basicAuthHeader(client.client_id, client.client_secret);
      }
      return fetch(mcpBaseUrl() + "/oauth/token", {
        method: "POST",
        headers,
        body: body.toString()
      }).then(function(res) {
        return res.ok ? res.json() : null;
      }).then(function(json) {
        if (!json || !json.access_token) return null;
        var token = Object.assign({}, json, {
          refresh_token: json.refresh_token || current.refresh_token,
          expires_at: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1e3 : void 0
        });
        lsSet(skey(SK.mcpToken), JSON.stringify(token));
        return token;
      }).catch(function() {
        return null;
      });
    }
    function ensureMcpGrantFresh() {
      if (!S.user || !mcpGrantNeedsRefresh(S.user)) return Promise.resolve(true);
      return refreshMcpToken().then(function(tok) {
        return !!(tok && !mcpGrantNeedsRefresh(S.user));
      });
    }
    function googleEnabled() {
      return !!S.opts.googleClientId;
    }
    function googleLogin() {
      if (!googleEnabled()) return;
      var redirectUrl = window.location.origin + window.location.pathname;
      var rnd = isInboundPlatformOAuth() ? getQueryParam("state") : Math.random().toString(36).substring(2);
      ssSet(skey(SK.googleInProgress), "1");
      ssSet(skey(SK.googleRedirect), redirectUrl);
      var url = GOOGLE_AUTH_URL + "?client_id=" + encodeURIComponent(S.opts.googleClientId) + "&redirect_uri=" + encodeURIComponent(redirectUrl) + "&response_type=code&scope=" + encodeURIComponent(GOOGLE_SCOPE) + "&prompt=consent&state=" + encodeURIComponent(rnd) + "&access_type=offline";
      window.location.replace(url);
    }
    function isGoogleOAuthReturn() {
      return !!getQueryParam("code") && ssGet(skey(SK.googleInProgress)) === "1";
    }
    function completeGoogleOAuthReturn() {
      var code = getQueryParam("code");
      var redirectUrl = ssGet(skey(SK.googleRedirect)) || window.location.origin + window.location.pathname;
      var secretName = S.opts.googleClientSecretName || "ggl";
      return S.skapi.clientSecretRequest({
        clientSecretName: secretName,
        url: GOOGLE_TOKEN_URL,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        data: {
          code,
          client_id: S.opts.googleClientId,
          client_secret: "$CLIENT_SECRET",
          redirect_uri: redirectUrl,
          grant_type: "authorization_code"
        }
      }).then(function(data) {
        ssDel(skey(SK.googleInProgress));
        ssDel(skey(SK.googleRedirect));
        if (!data || data.error || !data.access_token) {
          throw new Error(data && data.error || "Google login failed.");
        }
        return S.skapi.openIdLogin({ id: "by_skapi", token: data.access_token }).catch(function(err) {
          if (err && err.code === "ACCOUNT_EXISTS") {
            if (window.confirm(
              "An account with this Google account already exists.\nMerge accounts? Once merged you cannot login with the previous method."
            )) {
              return S.skapi.openIdLogin({ id: "by_skapi", token: data.access_token, merge: ["name"] });
            }
          }
          throw err;
        });
      });
    }
    function isInboundPlatformOAuth() {
      return getQueryParam("oauth") === "platform" && !!getQueryParam("state") && !!getQueryParam("redirect_uri");
    }
    function genOAuthCallbackUrl(state, session2, params) {
      var redirectUri = params && params.redirect_uri || getQueryParam("redirect_uri") || "";
      var code = {
        access_token: session2.accessToken && session2.accessToken.jwtToken,
        refresh_token: session2.refreshToken && session2.refreshToken.token,
        id_token: session2.idToken && session2.idToken.jwtToken
      };
      var encoded = btoa(JSON.stringify(code));
      return redirectUri + (redirectUri.indexOf("?") !== -1 ? "&" : "?") + "code=" + encodeURIComponent(encoded) + "&state=" + encodeURIComponent(state);
    }
    function returnOAuthToMCP() {
      var state = getQueryParam("state");
      if (!state) {
        renderLogin();
        return;
      }
      var stashed = safeJsonParse(ssGet("oauth:" + state), null);
      var params = stashed || {
        oauth: "platform",
        state,
        redirect_uri: getQueryParam("redirect_uri")
      };
      var waited = 0;
      (function attempt() {
        var session2 = S.skapi.session;
        if (session2 && session2.accessToken && session2.accessToken.jwtToken) {
          ssDel("oauth:" + state);
          window.location.replace(genOAuthCallbackUrl(state, session2, params));
          return;
        }
        if (waited >= 3e3) {
          console.error("[bunnyquery] OAuth bounce aborted: no skapi session.");
          renderLogin();
          return;
        }
        waited += 100;
        setTimeout(attempt, 100);
      })();
    }
    function stashInboundPlatformOAuth() {
      var state = getQueryParam("state");
      if (!state) return;
      try {
        var all = {};
        new URLSearchParams(window.location.search).forEach(function(v, k) {
          all[k] = v;
        });
        ssSet("oauth:" + state, JSON.stringify(all));
      } catch (e) {
      }
    }
    function authHeader(title) {
      return [
        title ? h("h1", { class: "bq-settings-title", text: title }) : null
      ];
    }
    var THEME_ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
    var THEME_ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    function loadingBtnLabel(loading, label) {
      return loading ? h("span", { class: "bq-btn-spinner" }) : document.createTextNode(label);
    }
    function googleIconSvg() {
      return '<svg viewBox="0 0 48 48" style="width:20px;height:20px;flex:none"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
    }
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
      render("login", function() {
        var busy = false;
        var emailInput = h("input", {
          class: "bq-input-text",
          type: "email",
          autocomplete: "email",
          placeholder: "your@email.com",
          required: true,
          value: prefill && prefill.email || ""
        });
        var pwInput = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "current-password",
          placeholder: "Enter password",
          required: true
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
          S.skapi.login({ email: emailInput.value, password: pwInput.value }).then(function() {
            if (isInboundPlatformOAuth()) {
              return returnOAuthToMCP();
            }
            return beginMcpOAuthOnLogin("chat").catch(function(err) {
              console.error("[bunnyquery] MCP OAuth bootstrap failed", err);
              enterAfterLogin();
            });
          }).catch(function(err) {
            setBusy(false);
            setError(loginErrorMessage(err));
            if (err && err.code === "SIGNUP_CONFIRMATION_NEEDED") {
              renderSignupConfirmation(emailInput.value);
            } else if (err && err.code === "USER_IS_DISABLED" && S.opts.signup) {
              renderEnableAccount(emailInput.value);
            }
          });
        }
        var actions = h("div", { class: "bq-actions" });
        actions.appendChild(h("button", {
          class: "bq-link",
          type: "button",
          onclick: function() {
            renderForgotPassword(emailInput.value);
          },
          text: "Forgot password?"
        }));
        if (S.opts.signup) {
          actions.appendChild(h("button", {
            class: "bq-link",
            type: "button",
            onclick: function() {
              renderSignup();
            },
            text: "Sign up \u2192"
          }));
        }
        var canReturnToChat = !S.user && anonymousAllowed();
        var form = h(
          "form",
          { class: "bq-form", onsubmit: submit },
          h("label", { class: "bq-label" }, h("span", { text: "Email" }), emailInput),
          h("label", { class: "bq-label" }, h("span", { text: "Password" }), pwInput),
          actions,
          errorBox,
          h("div", { class: "bq-form-bottom" }, submitBtn)
        );
        var children = [];
        if (canReturnToChat) {
          children.push(h(
            "div",
            { class: "bq-settings-top" },
            h("button", {
              class: "bq-link",
              type: "button",
              onclick: function() {
                enterAfterLogin();
              },
              text: "\u2190 Back to chat"
            })
          ));
        }
        children = children.concat(authHeader("Login")).concat([form]);
        if (googleEnabled()) {
          children.push(
            h(
              "div",
              { class: "bq-divider" },
              h("div", { class: "bq-divider-line" }),
              h("span", { class: "bq-divider-text", text: "or" }),
              h("div", { class: "bq-divider-line" })
            ),
            h(
              "button",
              { class: "bq-google", type: "button", onclick: function() {
                googleLogin();
              } },
              h("span", { html: googleIconSvg() }),
              h("span", { text: "Continue with Google" })
            )
          );
        }
        return pageRoot(children);
      });
    }
    function authShell(title, children, opts) {
      opts = opts || {};
      var kids = [];
      if (opts.topBack) {
        kids.push(h(
          "div",
          { class: "bq-settings-top" },
          h("button", {
            class: "bq-link",
            type: "button",
            onclick: opts.topBack.onClick,
            text: opts.topBack.label || "\u2190 Back"
          })
        ));
      }
      kids = kids.concat(authHeader(title)).concat(children);
      if (opts.back !== false && !opts.topBack) {
        kids.push(h(
          "div",
          { class: "bq-actions", style: { marginTop: "1.5rem" } },
          h("button", {
            class: "bq-link",
            type: "button",
            onclick: function() {
              renderLogin(opts.backPrefill);
            },
            text: "\u2190 Back to login"
          })
        ));
      }
      return pageRoot(kids);
    }
    function genericErrorMessage(err) {
      if (!err) return "Something went wrong. Please try again.";
      if (err.code === "EXISTS" || err.code === "UsernameExistsException" || err.message && err.message.indexOf("already") !== -1 && err.message.indexOf("use") !== -1) {
        return "This email is already in use.";
      }
      return err.message || "Something went wrong. Please try again.";
    }
    function renderSignup() {
      render("signup", function() {
        var busy = false;
        var email = h("input", {
          class: "bq-input-text",
          type: "email",
          autocomplete: "email",
          placeholder: "your@email.com",
          required: true
        });
        var name = h("input", {
          class: "bq-input-text",
          type: "text",
          autocomplete: "name",
          placeholder: "Your name",
          required: true
        });
        var pw = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "new-password",
          placeholder: "Create a password",
          required: true,
          minlength: "6",
          maxlength: "60"
        });
        var pw2 = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "new-password",
          placeholder: "Confirm password",
          required: true,
          minlength: "6",
          maxlength: "60"
        });
        var subscribe = h("input", { type: "checkbox", checked: true });
        var btn = h("button", { class: "btn", type: "submit" }, "Create account");
        var errBox = h("div", { class: "bq-error", style: { display: "none" } });
        function setBusy(b) {
          busy = b;
          [email, name, pw, pw2].forEach(function(i) {
            i.disabled = b;
          });
          subscribe.disabled = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Create account"));
        }
        function setError(m) {
          errBox.style.display = m ? "" : "none";
          errBox.textContent = m || "";
        }
        function submit(e) {
          e.preventDefault();
          if (busy) return;
          setError("");
          if (pw.value !== pw2.value) {
            setError("Passwords do not match.");
            return;
          }
          setBusy(true);
          var confirmUrl = S.opts.signupConfirmationUrl || window.location.origin + window.location.pathname;
          S.skapi.signup(
            { email: email.value, name: name.value, password: pw.value },
            { signup_confirmation: confirmUrl, email_subscription: !!subscribe.checked }
          ).then(function() {
            renderSignupConfirmation(email.value);
          }).catch(function(err) {
            setBusy(false);
            setError(genericErrorMessage(err));
          });
        }
        var form = h(
          "form",
          { class: "bq-form", onsubmit: submit },
          h("label", { class: "bq-label" }, h("span", { text: "Email" }), email),
          h("label", { class: "bq-label" }, h("span", { text: "Name" }), name),
          h("label", { class: "bq-label" }, h("span", { text: "Password" }), pw),
          h("label", { class: "bq-label" }, h("span", { text: "Confirm password" }), pw2),
          h("label", { class: "bq-checkbox" }, subscribe, h("span", { text: "Receive newsletters from admin" })),
          errBox,
          h("div", { class: "bq-form-bottom" }, btn)
        );
        return authShell("Sign up", [form]);
      });
    }
    function renderSignupConfirmation(email) {
      render("signup-confirmation", function() {
        var busy = false;
        var btn = h("button", { class: "btn", type: "button" }, "Resend confirmation email");
        var note = h("div", { class: "bq-step-note" });
        function setBusy(b) {
          busy = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Resend confirmation email"));
        }
        function setNote(m, ok) {
          note.className = ok ? "bq-success-box" : "bq-error";
          note.style.display = m ? "" : "none";
          note.textContent = m || "";
        }
        setNote("", true);
        note.style.display = "none";
        btn.addEventListener("click", function() {
          if (busy) return;
          setBusy(true);
          S.skapi.resendSignupConfirmation().then(function() {
            setBusy(false);
            setNote("Confirmation email sent. Check your inbox.", true);
          }).catch(function(err) {
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
          h(
            "p",
            { class: "bq-settings-sub" },
            "We sent a confirmation link to ",
            h("strong", { text: email || "your email" }),
            ". Click it to activate your account, then log in."
          ),
          h("div", { class: "bq-form-bottom", style: { marginTop: "1.5rem" } }, btn, note)
        ], { backPrefill: { email } });
      });
    }
    function renderForgotPassword(prefillEmail) {
      var ctx = { step: 1, email: prefillEmail || "", code: "" };
      function go() {
        render("forgot-password", function() {
          if (ctx.step === 1) return stepRequest();
          if (ctx.step === 2) return stepVerify();
          if (ctx.step === 3) return stepReset();
          return stepDone();
        });
      }
      function stepRequest() {
        var busy = false;
        var email = h("input", {
          class: "bq-input-text",
          type: "email",
          autocomplete: "email",
          placeholder: "your@email.com",
          required: true,
          value: ctx.email
        });
        var btn = h("button", { class: "btn", type: "submit" }, "Send code");
        var errBox = h("div", { class: "bq-error", style: { display: "none" } });
        function setBusy(b) {
          busy = b;
          email.disabled = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Send code"));
        }
        function submit(e) {
          e.preventDefault();
          if (busy) return;
          errBox.style.display = "none";
          setBusy(true);
          ctx.email = email.value;
          S.skapi.forgotPassword({ email: ctx.email }).then(function() {
            ctx.step = 2;
            go();
          }).catch(function(err) {
            setBusy(false);
            errBox.style.display = "";
            errBox.textContent = err && err.message || "Could not send code.";
          });
        }
        return authShell("Reset password", [
          h("p", { class: "bq-step-note", text: "Enter your email and we'll send a verification code." }),
          h(
            "form",
            { class: "bq-form", onsubmit: submit },
            h("label", { class: "bq-label" }, h("span", { text: "Email" }), email),
            errBox,
            h("div", { class: "bq-form-bottom" }, btn)
          )
        ]);
      }
      function stepVerify() {
        var code = h("input", { class: "bq-input-text", type: "text", placeholder: "Enter verification code", required: true });
        var resendBusy = false;
        var resendBtn = h("button", { class: "bq-link", type: "button", text: "Resend code" });
        var note = h("div", { class: "bq-step-note", style: { display: "none" } });
        resendBtn.addEventListener("click", function() {
          if (resendBusy) return;
          resendBusy = true;
          resendBtn.textContent = "Resending\u2026";
          S.skapi.forgotPassword({ email: ctx.email }).then(function() {
            resendBusy = false;
            resendBtn.textContent = "Resend code";
            note.style.display = "";
            note.className = "bq-success-box";
            note.textContent = "Code re-sent.";
          }).catch(function(err) {
            resendBusy = false;
            resendBtn.textContent = "Resend code";
            note.style.display = "";
            note.className = "bq-error";
            note.textContent = err && err.message || "Could not resend.";
          });
        });
        function submit(e) {
          e.preventDefault();
          if (!code.value.trim()) return;
          ctx.code = code.value.trim();
          ctx.step = 3;
          go();
        }
        return authShell("Reset password", [
          h("p", { class: "bq-step-note" }, "We sent a code to ", h("strong", { text: ctx.email }), "."),
          h(
            "form",
            { class: "bq-form", onsubmit: submit },
            h("label", { class: "bq-label" }, h("span", { text: "Verification code" }), code),
            h("div", { class: "bq-actions" }, resendBtn),
            note,
            h("div", { class: "bq-form-bottom" }, h("button", { class: "btn", type: "submit" }, "Continue"))
          )
        ]);
      }
      function stepReset() {
        var busy = false;
        var pw = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "new-password",
          placeholder: "New password",
          required: true,
          minlength: "6",
          maxlength: "60"
        });
        var pw2 = h("input", {
          class: "bq-input-text",
          type: "password",
          autocomplete: "new-password",
          placeholder: "Confirm new password",
          required: true,
          minlength: "6",
          maxlength: "60"
        });
        var btn = h("button", { class: "btn", type: "submit" }, "Reset password");
        var errBox = h("div", { class: "bq-error", style: { display: "none" } });
        function setBusy(b) {
          busy = b;
          pw.disabled = b;
          pw2.disabled = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Reset password"));
        }
        function submit(e) {
          e.preventDefault();
          if (busy) return;
          errBox.style.display = "none";
          if (pw.value !== pw2.value) {
            errBox.style.display = "";
            errBox.textContent = "Passwords do not match.";
            return;
          }
          setBusy(true);
          S.skapi.resetPassword({ email: ctx.email, code: ctx.code, new_password: pw.value }).then(function() {
            ctx.step = 4;
            go();
          }).catch(function(err) {
            setBusy(false);
            errBox.style.display = "";
            errBox.textContent = err && err.message || "Could not reset password.";
            ctx.step = 2;
            setTimeout(go, 1200);
          });
        }
        return authShell("Reset password", [
          h(
            "form",
            { class: "bq-form", onsubmit: submit },
            h("label", { class: "bq-label" }, h("span", { text: "New password" }), pw),
            h("label", { class: "bq-label" }, h("span", { text: "Confirm new password" }), pw2),
            errBox,
            h("div", { class: "bq-form-bottom" }, btn)
          )
        ]);
      }
      function stepDone() {
        return authShell("Password reset", [
          h("div", { class: "bq-success-box", text: "Your password has been changed. You can now log in with your new password." }),
          h(
            "div",
            { class: "bq-form-bottom", style: { marginTop: "1.5rem" } },
            h("button", { class: "btn", type: "button", onclick: function() {
              renderLogin({ email: ctx.email });
            } }, "Go to login")
          )
        ], { back: false });
      }
      go();
    }
    function renderEmailVerification(onDone) {
      var ctx = { step: 1, sending: false };
      function go() {
        render("email-verification", function() {
          return ctx.step === 1 ? stepEnter() : stepDone();
        });
      }
      function sendCode(noteEl) {
        if (ctx.sending) return Promise.resolve();
        ctx.sending = true;
        return S.skapi.verifyEmail().then(function() {
          ctx.sending = false;
          if (noteEl) {
            noteEl.style.display = "";
            noteEl.className = "bq-success-box";
            noteEl.textContent = "Code sent. Check your inbox.";
          }
        }).catch(function(err) {
          ctx.sending = false;
          if (noteEl) {
            noteEl.style.display = "";
            noteEl.className = "bq-error";
            noteEl.textContent = err && err.message || "Could not send code.";
          }
        });
      }
      function stepEnter() {
        var code = h("input", { class: "bq-input-text", type: "text", placeholder: "6-digit code", required: true });
        var btn = h("button", { class: "btn", type: "submit" }, "Verify");
        var note = h("div", { style: { display: "none" } });
        var resend = h("button", {
          class: "bq-link",
          type: "button",
          text: "Resend code",
          onclick: function() {
            sendCode(note);
          }
        });
        var busy = false;
        function setBusy(b) {
          busy = b;
          code.disabled = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, "Verify"));
        }
        function submit(e) {
          e.preventDefault();
          if (busy || !code.value.trim()) return;
          setBusy(true);
          S.skapi.verifyEmail({ code: code.value.trim() }).then(function() {
            ctx.step = 2;
            go();
          }).catch(function(err) {
            setBusy(false);
            note.style.display = "";
            note.className = "bq-error";
            note.textContent = err && err.message || "Invalid code.";
          });
        }
        var emailTxt = S.user && S.user.email || "your email";
        var shell = authShell("Verify your email", [
          h("p", { class: "bq-step-note" }, "We sent a code to ", h("strong", { text: emailTxt }), "."),
          h(
            "form",
            { class: "bq-form", onsubmit: submit },
            h("label", { class: "bq-label" }, h("span", { text: "Verification code" }), code),
            h("div", { class: "bq-actions" }, resend),
            note,
            h("div", { class: "bq-form-bottom" }, btn)
          )
        ], { topBack: {
          label: "\u2190 Back to settings",
          onClick: function() {
            renderChat();
            openChatSettings();
          }
        } });
        sendCode(note);
        return shell;
      }
      function stepDone() {
        return authShell("Email verified", [
          h("div", { class: "bq-success-box", text: (S.user && S.user.email || "Your email") + " has been verified." }),
          h(
            "div",
            { class: "bq-form-bottom", style: { marginTop: "1.5rem" } },
            h("button", { class: "btn", type: "button", onclick: function() {
              (onDone || renderChat)();
            } }, "Continue")
          )
        ], { back: false });
      }
      go();
    }
    function settingsSectionTitle(text) {
      return h("div", { class: "bq-settings-section-title", text });
    }
    function accountRow(label, valueNodes, actionLabel, onAction, opts) {
      opts = opts || {};
      return h(
        "div",
        { class: "bq-account-row" },
        h(
          "div",
          { class: "bq-account-row-main" },
          h("div", { class: "bq-account-label", text: label }),
          h("div", { class: "bq-account-value" + (opts.muted ? " is-muted" : "") }, valueNodes)
        ),
        onAction ? h("button", { class: "bq-link" + (opts.dangerAction ? " bq-link--danger" : ""), type: "button", onclick: onAction, text: actionLabel || "Change" }) : null
      );
    }
    function getNewsletterStatus() {
      try {
        return Promise.resolve(S.skapi.getNewsletterSubscription({ group: "authorized" })).then(function(res) {
          var list = res && res.list ? res.list : res;
          if (!Array.isArray(list)) return false;
          return list.some(function(s) {
            return s && s.active && s.group === 1;
          });
        }).catch(function() {
          return false;
        });
      } catch (e) {
        return Promise.resolve(false);
      }
    }
    function toggleChatSettings() {
      if (CS.chatSettingsOpen) closeChatSettings();
      else openChatSettings();
    }
    function openChatSettings() {
      if (!CS.messagesBox || !CS.chatEl || !CS.composerEl) return;
      CS.chatSettingsOpen = true;
      if (CS.settingsBtnEl) CS.settingsBtnEl.classList.add("is-active");
      if (CS.composerEl.parentNode === CS.chatEl) CS.chatEl.removeChild(CS.composerEl);
      renderAccount();
    }
    function closeChatSettings() {
      CS.chatSettingsOpen = false;
      if (CS.settingsBtnEl) CS.settingsBtnEl.classList.remove("is-active");
      if (CS.composerEl && CS.chatEl && CS.composerEl.parentNode !== CS.chatEl) CS.chatEl.appendChild(CS.composerEl);
      renderMessages();
      scrollToBottom();
      ensureHistoryFillsViewport();
    }
    function renderAccount() {
      if (!CS.messagesBox) return;
      clear(CS.messagesBox);
      CS.messagesBox.appendChild(h(
        "div",
        { class: "bq-chat-settings" },
        h("div", { class: "bq-chat-settings-loading" }, bunnyLoader("Loading..."))
      ));
      Promise.all([getProfile(), getNewsletterStatus()]).then(function(res) {
        if (res[0]) S.user = res[0];
        S.newsletterSubscribed = res[1];
        renderSettingsIntoBox();
      }).catch(function() {
        renderSettingsIntoBox();
      });
    }
    function newsletterRow() {
      var checkbox = h("input", { type: "checkbox", checked: !!S.newsletterSubscribed });
      var busy = false;
      checkbox.addEventListener("change", function() {
        if (busy) return;
        busy = true;
        var want = checkbox.checked;
        var op = want ? S.skapi.subscribeNewsletter({ group: "authorized" }) : S.skapi.unsubscribeNewsletter({ group: "authorized" });
        Promise.resolve(op).then(function() {
          S.newsletterSubscribed = want;
          busy = false;
        }).catch(function(err) {
          checkbox.checked = !want;
          busy = false;
          alert(err && err.message || "Could not update subscription.");
        });
      });
      return h(
        "div",
        { class: "bq-account-row" },
        h(
          "label",
          { class: "bq-checkbox" },
          checkbox,
          h("span", { text: "Receive newsletter from admin" })
        )
      );
    }
    function themeRow() {
      var current = S.theme === "dark" ? "dark" : "light";
      function themeRadio(value, label) {
        var input = h("input", { type: "radio", name: "bq-theme" });
        input.checked = value === current;
        input.addEventListener("change", function() {
          if (input.checked) applyTheme(value);
        });
        return h("label", { class: "bq-checkbox" }, input, h("span", { text: label }));
      }
      return h(
        "div",
        { class: "bq-account-row" },
        // h("div", { class: "bq-account-row-main" },
        //     h("div", { class: "bq-account-label", text: "Theme" })),
        h(
          "div",
          { class: "bq-theme-radios" },
          themeRadio("light", "Light mode"),
          themeRadio("dark", "Dark mode")
        )
      );
    }
    function dangerItem(label, desc, btnLabel, onClick) {
      return h(
        "div",
        { class: "bq-danger-item" },
        h("div", { class: "bq-danger-item-title", text: label }),
        h("p", { class: "bq-danger-item-desc", text: desc }),
        h("button", { class: "btn btn--danger", type: "button", onclick: onClick, text: btnLabel })
      );
    }
    function renderSettingsIntoBox() {
      if (!CS.messagesBox) return;
      var u = S.user || {};
      var children = [];
      children.push(h(
        "div",
        { class: "bq-settings-top" },
        h("button", { class: "bq-link", type: "button", onclick: function() {
          closeChatSettings();
        }, text: "\u2190 Back to chat" })
      ));
      children.push(h("h1", { class: "bq-settings-title", text: "Settings" }));
      if (!u.email_verified) {
        children.push(h(
          "div",
          { class: "bq-account-tip" },
          h("strong", { text: "Verify your email. " }),
          document.createTextNode("A verified email is required to recover your password or re-enable your account if you ever lose access."),
          h(
            "div",
            { style: { marginTop: "0.75rem" } },
            h("button", {
              class: "btn",
              type: "button",
              onclick: function() {
                renderEmailVerification(renderChat);
              },
              text: "Verify now"
            })
          )
        ));
      }
      children.push(settingsSectionTitle("Theme"));
      children.push(h("div", { class: "bq-account-section" }, themeRow()));
      var emailValue = [
        document.createTextNode(u.email || "\u2014"),
        h("span", {
          class: "bq-verify-badge " + (u.email_verified ? "is-verified" : "is-unverified"),
          text: u.email_verified ? "verified" : "unverified"
        })
      ];
      children.push(settingsSectionTitle("Account"));
      children.push(h(
        "div",
        { class: "bq-account-section" },
        accountRow("Email", emailValue, "Change", function() {
          openChangeEmailModal();
        }),
        accountRow("Name", [document.createTextNode(u.name || "Unnamed user")], "Change", function() {
          openChangeNameModal();
        }),
        u.signup_ticket === "OIDPASS" ? accountRow("Password", [document.createTextNode("Managed by your login provider")], null, null, { muted: true }) : accountRow("Password", [document.createTextNode("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022")], "Change", function() {
          openChangePasswordModal();
        }),
        newsletterRow()
      ));
      var danger = [h("div", { class: "bq-account-danger-title", text: "Danger zone" })];
      danger.push(dangerItem(
        "Clear history",
        "Hide the current conversation. Your messages stay on the server but won't be shown here again.",
        "Clear history",
        function() {
          openClearHistoryModal();
        }
      ));
      if (S.opts.signup) {
        danger.push(dangerItem(
          "Remove account",
          "Remove your account and delete all your data. You can re-enable within 30 days by logging in.",
          "Remove account",
          function() {
            openDeleteAccountModal();
          }
        ));
      }
      children.push(h("div", { class: "bq-account-danger" }, danger));
      children.push(h(
        "div",
        { class: "bq-account-logout" },
        h("button", { class: "bq-link", type: "button", onclick: function() {
          logout();
        }, text: "Logout \u2192" })
      ));
      children.push(pageFooter());
      clear(CS.messagesBox);
      CS.messagesBox.appendChild(h("div", { class: "bq-chat-settings" }, children));
    }
    function modalForm(title, desc, fields, submitLabel, onSubmit) {
      return openModal(function(close) {
        var err = h("div", { class: "bq-error", style: { display: "none" } });
        var btn = h("button", { class: "btn", type: "submit" }, submitLabel);
        var busy = false;
        function setBusy(b) {
          busy = b;
          btn.disabled = b;
          clear(btn).appendChild(loadingBtnLabel(b, submitLabel));
        }
        function setErr(m) {
          err.style.display = m ? "" : "none";
          err.textContent = m || "";
        }
        function submit(e) {
          e.preventDefault();
          if (busy) return;
          setErr("");
          setBusy(true);
          Promise.resolve(onSubmit(close)).then(function(msg) {
            if (msg && msg.error) {
              setBusy(false);
              setErr(msg.error);
            }
          }).catch(function(e2) {
            setBusy(false);
            setErr(e2 && e2.message || "Something went wrong.");
          });
        }
        var labels = fields.map(function(f) {
          return h("label", { class: "bq-label" }, h("span", { text: f.label }), f.input);
        });
        return h(
          "div",
          { class: "bq-modal" },
          h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
          h("h2", { class: "bq-modal-title", text: title }),
          desc ? h("p", { class: "bq-modal-desc", text: desc }) : null,
          h("form", { class: "bq-form", onsubmit: submit }, labels.concat([
            err,
            h(
              "div",
              { class: "bq-modal-btns" },
              h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Cancel"),
              btn
            )
          ]))
        );
      });
    }
    function openChangeNameModal() {
      var input = h("input", { class: "bq-input-text", type: "text", value: S.user && S.user.name || "", placeholder: "Your name", required: true });
      modalForm("Change name", null, [{ label: "Name", input }], "Save", function(close) {
        return S.skapi.updateProfile({ name: input.value }).then(function() {
          if (S.user) S.user.name = input.value;
          close();
          renderAccount();
        });
      });
    }
    function openChangeEmailModal() {
      var input = h("input", { class: "bq-input-text", type: "email", value: S.user && S.user.email || "", placeholder: "your@email.com", required: true });
      modalForm(
        "Change email",
        "After changing your email you'll need to verify it. A verified email is required to recover your account.",
        [{ label: "New email", input }],
        "Save",
        function(close) {
          return S.skapi.updateProfile({ email: input.value }).then(function() {
            if (S.user) {
              S.user.email = input.value;
              S.user.email_verified = false;
            }
            close();
            renderEmailVerification(renderChat);
          });
        }
      );
    }
    function openChangePasswordModal() {
      var cur = h("input", { class: "bq-input-text", type: "password", autocomplete: "current-password", placeholder: "Current password", required: true });
      var pw = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password", placeholder: "New password", required: true, minlength: "6", maxlength: "60" });
      var pw2 = h("input", { class: "bq-input-text", type: "password", autocomplete: "new-password", placeholder: "Confirm new password", required: true, minlength: "6", maxlength: "60" });
      modalForm(
        "Change password",
        null,
        [{ label: "Current password", input: cur }, { label: "New password", input: pw }, { label: "Confirm new password", input: pw2 }],
        "Change password",
        function(close) {
          if (pw.value !== pw2.value) return { error: "New passwords do not match." };
          return S.skapi.changePassword({ current_password: cur.value, new_password: pw.value }).then(function() {
            close();
          });
        }
      );
    }
    function openDeleteAccountModal() {
      openModal(function(close) {
        var agree = h("input", { type: "checkbox" });
        var err = h("div", { class: "bq-error", style: { display: "none" } });
        var btn = h("button", { class: "btn btn--danger", type: "button" }, "Disable account");
        var busy = false;
        btn.addEventListener("click", function() {
          if (busy) return;
          if (!agree.checked) {
            err.style.display = "";
            err.textContent = "Please confirm you want to disable your account.";
            return;
          }
          err.style.display = "none";
          busy = true;
          btn.disabled = true;
          clear(btn).appendChild(loadingBtnLabel(true, "Disable account"));
          Promise.resolve(S.skapi.disableAccount()).then(function() {
            clearStoredMcpToken();
            S.user = null;
            close();
            renderBye();
          }).catch(function(e2) {
            busy = false;
            btn.disabled = false;
            clear(btn).appendChild(document.createTextNode("Disable account"));
            err.style.display = "";
            err.textContent = e2 && e2.message || "Could not disable account.";
          });
        });
        return h(
          "div",
          { class: "bq-modal" },
          h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
          h("div", { class: "bq-modal-delete-header" }, h("span", { text: "Disable account" })),
          h("p", { class: "bq-modal-desc" }, "Your data and projects will be hidden and permanently removed after 30 days. You can re-enable within that window by logging in."),
          h("label", { class: "bq-checkbox", style: { marginBottom: "1rem" } }, agree, h("span", { text: "I understand and want to disable my account." })),
          err,
          h(
            "div",
            { class: "bq-modal-btns" },
            h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Cancel"),
            btn
          )
        );
      });
    }
    function renderBye() {
      render("bye", function() {
        return pageRoot(authHeader("Account disabled").concat([
          h("p", { class: "bq-settings-sub" }, "Your account has been disabled. All your data will be removed after 90 days. You can recover within that period by logging in and following the recovery email."),
          h(
            "div",
            { class: "bq-form-bottom", style: { marginTop: "1.5rem" } },
            h("button", { class: "btn", type: "button", onclick: function() {
              renderLogin();
            }, text: "Back to login" })
          )
        ]));
      });
    }
    function renderEnableAccount(email) {
      var sent = false;
      render("enable-account", function() {
        var busy = false;
        var btn = h("button", { class: "btn", type: "button" }, "Re-send recovery email");
        var note = h("div", { style: { display: "none" } });
        function send() {
          if (busy) return;
          busy = true;
          btn.disabled = true;
          clear(btn).appendChild(loadingBtnLabel(true, "Re-send recovery email"));
          Promise.resolve(S.skapi.recoverAccount(window.location.origin + window.location.pathname)).then(function() {
            busy = false;
            btn.disabled = false;
            clear(btn).appendChild(document.createTextNode("Re-send recovery email"));
            note.style.display = "";
            note.className = "bq-success-box";
            note.textContent = "Recovery email sent. Check your inbox.";
          }).catch(function(err) {
            busy = false;
            btn.disabled = false;
            clear(btn).appendChild(document.createTextNode("Re-send recovery email"));
            note.style.display = "";
            note.className = "bq-error";
            note.textContent = err && err.message || "Could not send recovery email.";
          });
        }
        btn.addEventListener("click", send);
        if (!sent) {
          sent = true;
          send();
        }
        return authShell("Re-enable account", [
          h(
            "p",
            { class: "bq-settings-sub" },
            "We've sent a recovery link to ",
            h("strong", { text: email || "your email" }),
            ". Click it to re-enable your account."
          ),
          h("div", { class: "bq-form-bottom", style: { marginTop: "1.5rem" } }, btn, note)
        ]);
      });
    }
    var CS = {
      messages: [],
      // Rendered .bq-message nodes, indexed BY MESSAGE INDEX (sparse: a message
      // folded into a collapsed indexing row has no node of its own).
      messageEls: [],
      // Expanded background-indexing rows, keyed by FILE (group.key). Not by run:
      // runKey is renamed whenever an earlier pass of the run loads, which closed
      // a row the user had opened. Two runs of one file therefore share an open
      // state, which is the right reading of "show me this file's steps".
      indexGroupsOpen: {},
      messagesBox: null,
      // .bq-messages element
      sending: false,
      typing: false,
      typingAbort: false,
      typewriterQueue: Promise.resolve(),
      stickToBottom: true,
      loadingHistory: false,
      loadingOlderHistory: false,
      // The viewport-fill LOOP is running (createHistoryFiller.onRunningChange).
      // Spans the gaps between its pages, where loadingOlderHistory keeps dropping
      // back to false; a collapsed indexing row that is still waiting for its own
      // earlier passes renders off this rather than flickering once per page.
      // View-side, not delegated to session.state: the filler is view-side too.
      historyFilling: false,
      historyEndOfList: false,
      historyStartKeyHistory: [],
      historyRequestToken: 0,
      gateRefreshToken: 0,
      clearing: false,
      pollTimer: null,
      attachments: [],
      // [{ id, name, file, status, progress, uploadedUrl, storagePath, errorMessage }]
      uploadingAttachments: false,
      attachmentWarning: "",
      attachmentCapNotice: "",
      // informational "N files not added" when an add hit MAX_ATTACHMENT_FILE_COUNT
      attachmentsRow: null,
      // .bq-attachments DOM node
      attachBtnEl: null,
      sendBtnEl: null,
      inputEl: null,
      // .bq-input textarea
      chatEl: null,
      // .bq-chat (for overflow height measurement)
      visibleAttachmentCount: Infinity
      // how many chips fit before "...(x) more"
    };
    var aiChatHistoryCache = {};
    var pendingAgentRequests = {};
    var historyItemPolls = /* @__PURE__ */ new Map();
    var bgTaskQueue = [];
    var cancelledServerIds = /* @__PURE__ */ new Set();
    var refreshingLinkMap = {};
    var refreshedExpiredLinkMap = {};
    var refreshingLinkPromises = /* @__PURE__ */ new Map();
    var unavailableLinkMap = {};
    var fileBlobCache = /* @__PURE__ */ new Map();
    var markedReady = null;
    function currentIdentity() {
      return {
        projectId: S.projectId,
        // Prefer the SDK's formatted token. The widget takes the page's own
        // skapi-js <script> pin, and builds older than 1.8.4 have no .project_id;
        // compose the formatted token exactly as buildSystemPrompt does, because
        // the raw regional id must never reach the indexing prompt - the model
        // copies it verbatim into project_id tool calls, which the MCP schema
        // pattern rejects.
        publicProjectId: S.skapi && S.skapi.project_id || (function() {
          if (S.projectId && S.owner && S.skapi && S.skapi.util && typeof S.skapi.util.formatServiceId === "function") {
            try {
              return S.skapi.util.formatServiceId(S.projectId, S.owner);
            } catch (e) {
            }
          }
          return void 0;
        })(),
        owner: S.owner,
        // The chat identity, which the engine turns into the request queue
        // name. An anonymous visitor gets their DEVICE id rather than the
        // project id: the old fallback gave every anonymous visitor of a
        // project the same queue, so they would have shared one transcript
        // and head-of-line-blocked each other's turns on a single FIFO.
        userId: S.user && S.user.user_id || (isAnonymousSession() ? anonDeviceId() : S.projectId),
        // Sends the turn's MCP tools to the project-scoped, credential-free
        // endpoint instead of the root one with an empty bearer.
        anonymous: isAnonymousSession(),
        platform: S.aiPlatform,
        model: S.aiModel || void 0,
        serviceName: S.serviceName,
        serviceDescription: S.serviceDescription
      };
    }
    var session = new ChatSession({
      getIdentity: function() {
        return currentIdentity();
      },
      buildSystemPrompt: function() {
        return buildSystemPrompt();
      },
      notify: function() {
        renderMessages();
      },
      refreshMessageBubble: function(i) {
        refreshMessageBubble(i);
      },
      scrollToBottom: function(smooth) {
        return scrollToBottom();
      },
      scrollToBottomIfSticky: function(smooth) {
        return scrollToBottomIfSticky();
      },
      // A first page can render shorter than the box (a file's every indexing
      // pass folds into ONE row), and a box that cannot scroll never fires the
      // scroll-to-top that is the sole trigger for loading page 2. Page out of
      // it here — only the view can measure.
      onHistoryLoaded: function(fetchMore, token) {
        if (!fetchMore) ensureHistoryFillsViewport(token);
      },
      settleScroll: function() {
        settleScrollAfterRefresh();
      },
      cancelRequest: function(opts) {
        return S.skapi.cancelClientSecretRequest(opts);
      },
      refreshSession: function() {
        return refreshSkapiSession();
      },
      formatIndexingLabel: function(name, mime, size, storagePath, reindex, continued) {
        return buildIndexingLabel(name, mime, size, storagePath, reindex, continued);
      },
      isViewMounted: function() {
        return !!CS.messagesBox;
      },
      getClearedAt: function() {
        return getClearedAt();
      },
      // attachment upload I/O (bunnyquery: get-signed-url + db CDN)
      uploadFile: function(a) {
        return uploadFileToDb(a.file, a.storagePath, a.onProgress, a.setAbort, a.checkExistence);
      },
      getTemporaryUrl: function(path) {
        return getTemporaryUrlDb(path, ATTACHMENT_URL_EXPIRES_SECONDS);
      },
      deleteExistingFileRecord: function(path) {
        return deleteFileIndexRecordDb(path);
      },
      ensureFileIndexRecord: function(path, meta) {
        return resolveUploadAccessGroup(path).then(function(g) {
          return ensureFileIndexRecordDb(path, meta, g);
        });
      },
      uploadAccessGroup: function(path) {
        return resolveUploadAccessGroup(path);
      },
      storagePathFor: function(relPath) {
        return attachmentStoragePath(relPath);
      },
      getMimeType: function(name) {
        return mimeGetType(name);
      },
      promptOverwrite: function(filename) {
        return promptOverwrite(filename);
      },
      resetOverwriteBatch: function() {
        resetOverwriteBatch();
        resetAccessGroupBatch();
      },
      renderAttachmentChips: function() {
        renderAttachmentChips();
      },
      updateComposerControls: function() {
        updateComposerControls();
      }
    });
    session.bgTaskQueue = bgTaskQueue;
    session.cancelledServerIds = cancelledServerIds;
    session.pendingAgentRequests = pendingAgentRequests;
    session.aiChatHistoryCache = aiChatHistoryCache;
    session.historyItemPolls = historyItemPolls;
    [
      "messages",
      "attachments",
      "uploadingAttachments",
      "sending",
      "typing",
      "typingAbort",
      "loadingHistory",
      "loadingOlderHistory",
      "historyEndOfList",
      "historyStartKeyHistory",
      "historyRequestToken",
      "gateRefreshToken"
    ].forEach(function(k) {
      Object.defineProperty(CS, k, {
        get: function() {
          return session.state[k];
        },
        set: function(v) {
          session.state[k] = v;
        },
        configurable: true,
        enumerable: true
      });
    });
    function hostDomain() {
      return S.opts.hostDomain || (S.opts.dev ? "skapi.app" : "skapi.com");
    }
    function raf2() {
      return new Promise(function(res) {
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            res();
          });
        });
      });
    }
    function mimeGetType(name) {
      var ext = (String(name || "").split(".").pop() || "").toLowerCase();
      var map = {
        txt: "text/plain",
        md: "text/markdown",
        csv: "text/csv",
        json: "application/json",
        html: "text/html",
        htm: "text/html",
        js: "text/javascript",
        ts: "text/plain",
        css: "text/css",
        xml: "application/xml",
        yaml: "text/yaml",
        yml: "text/yaml",
        pdf: "application/pdf",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        eml: "message/rfc822"
      };
      return map[ext] || null;
    }
    function loadMarked() {
      if (markedReady) return markedReady;
      if (window.marked && typeof window.marked.parse === "function") {
        markedReady = Promise.resolve();
        return markedReady;
      }
      markedReady = new Promise(function(resolve) {
        var s = document.createElement("script");
        s.src = MARKED_CDN;
        s.onload = function() {
          resolve();
        };
        s.onerror = function() {
          resolve();
        };
        document.head.appendChild(s);
      });
      return markedReady;
    }
    function buildSystemPrompt() {
      var promptProjectId = S.projectId || "";
      if (S.projectId && S.owner && S.skapi && S.skapi.util && typeof S.skapi.util.formatServiceId === "function") {
        try {
          promptProjectId = S.skapi.util.formatServiceId(S.projectId, S.owner);
        } catch (e) {
        }
      }
      return buildChatSystemPrompt({
        projectId: promptProjectId,
        serviceName: S.serviceName,
        serviceDescription: S.serviceDescription,
        // The opening bubble never enters the history (it is DOM the client
        // paints), so the model is told what it opened with. Same call as
        // buildGreetingEl, so the two can never disagree.
        greeting: greetingParts().text,
        canUpload: !uploadsFrozenForUser(),
        // Where THIS project's indexer writes, from the "bq::settings"
        // record. The MCP's auto-fill assumes "authorized"; on a project set
        // to public or private that would search the wrong group and answer
        // "nothing found". A SYNC CACHE READ, because the engine calls this
        // hook from paths with nowhere to put an await. Every send that
        // reaches it has settled the fetch first: sendMessage awaits
        // readyProjectSettings on the text-only branch, and the attachment
        // branch resolves the upload group before it dispatches.
        indexAccessGroup: projectUploadAccessGroup(S.projectId)});
    }
    function refreshSkapiSession() {
      return S.skapi.getProfile({ refreshToken: true }).then(function() {
        return ensureMcpGrantFresh();
      }).then(function() {
        return true;
      }).catch(function() {
        return false;
      });
    }
    var attachmentUploadChain = Promise.resolve();
    var attachmentDispatchChain = Promise.resolve();
    var attachmentBatchSeq = 0;
    function enqueueAttachmentSend(job) {
      var uploaded = attachmentUploadChain.catch(function() {
      }).then(function() {
        return runAttachmentUpload(job);
      });
      attachmentUploadChain = uploaded;
      attachmentDispatchChain = attachmentDispatchChain.catch(function() {
      }).then(function() {
        return uploaded;
      }).then(function(urls) {
        return runAttachmentDispatch(job, urls);
      });
    }
    function runAttachmentUpload(job) {
      return session.uploadPendingAttachments(job.batchId, job.stageId).then(function(attachmentUrls) {
        var failureGroups = groupAttachmentFailures(CS.attachments.filter(function(a) {
          return a._batchId === job.batchId;
        }));
        clearSuccessfulAttachments(job.batchId);
        if (failureGroups.length) showUploadErrorReport(failureGroups);
        return attachmentUrls;
      }).catch(function(err) {
        console.error("[bunnyquery] attachment upload failed", err);
        updateComposerControls();
        renderAttachmentChips();
        if (job.stageId) session.settleStagedMessage(job.stageId);
        CS.messages.push({ role: "assistant", content: "Something went wrong while uploading attachments. " + (err && err.message || ""), isError: true });
        renderMessages();
        scrollToBottomIfSticky();
        return null;
      });
    }
    function runAttachmentDispatch(job, attachmentUrls) {
      if (!attachmentUrls || !job.text) return Promise.resolve();
      if (job.stageId) session.markStagedMessageIndexing(job.stageId);
      return session.awaitIndexingDrained(job.pinned.identity).then(function() {
        if (job.stageId) session.markStagedMessageReady(job.stageId);
        var c = composeUserMessage(job.text, attachmentUrls);
        session.dispatchComposedMessage(c.composed, true, c.composedForLlm, c.extractContent, c.fileUrls, job.pinned);
      });
    }
    function sendMessage() {
      var inputEl = CS.messagesBox && CS.messagesBox.parentNode && CS.messagesBox.parentNode.querySelector(".bq-input");
      var text = (inputEl ? inputEl.value : "").trim();
      var batchAttachments = composerAttachments();
      var hasAttachments = batchAttachments.length > 0;
      if (!text && !hasAttachments) return;
      if (!chatEnabled() || S.aiPlatform === "none") return;
      recomputeAttachmentWarning();
      if (CS.attachmentWarning) {
        renderAttachmentChips();
        updateComposerControls();
        return;
      }
      if (inputEl) {
        inputEl.value = "";
        autoGrowInput(inputEl);
      }
      updateComposerControls();
      CS.drafting = false;
      syncDraftingIndicator();
      if (!hasAttachments) {
        readyProjectSettings(S.projectId).then(function() {
          session.dispatchComposedMessage(text, false);
        });
        return;
      }
      attachmentBatchSeq += 1;
      var batchId = "batch_" + attachmentBatchSeq + "_" + Date.now();
      batchAttachments.forEach(function(a) {
        a._batchId = batchId;
      });
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      var stageId = text ? session.stageOutgoingMessage(text) : void 0;
      var pinned = {
        identity: currentIdentity(),
        systemPrompt: buildSystemPrompt(),
        stageId
      };
      enqueueAttachmentSend({ text, batchId, stageId, pinned });
    }
    function scrollToBottom() {
      if (typeof document !== "undefined" && document.hidden) {
        CS.stickToBottom = true;
        chatScrollAnchor.pinBottom();
        return Promise.resolve();
      }
      return raf2().then(function() {
        if (!CS.messagesBox) return;
        CS.stickToBottom = true;
        chatScrollAnchor.pinBottom();
      });
    }
    function scrollToBottomIfSticky() {
      if (!CS.stickToBottom) return Promise.resolve();
      if (typeof document !== "undefined" && document.hidden) {
        chatScrollAnchor.pinBottom();
        return Promise.resolve();
      }
      return raf2().then(function() {
        if (!CS.stickToBottom || !CS.messagesBox) return;
        chatScrollAnchor.pinBottom();
      });
    }
    function settleScrollAfterRefresh() {
      anchorWroteSinceScroll = true;
      if (CS.stickToBottom) scrollToBottomIfSticky();
      else chatScrollAnchor.hold();
    }
    var lastHistoryScrollTop = 0;
    var anchorWroteSinceScroll = false;
    function onHistoryScroll() {
      if (!CS.messagesBox || CS.chatSettingsOpen) return;
      var el = CS.messagesBox;
      if (typeof document !== "undefined" && document.hidden) {
        lastHistoryScrollTop = el.scrollTop;
        return;
      }
      var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
      var ours = anchorWroteSinceScroll;
      anchorWroteSinceScroll = false;
      if (!atBottom) CS.stickToBottom = false;
      else if (!ours && el.scrollTop >= lastHistoryScrollTop) CS.stickToBottom = true;
      lastHistoryScrollTop = el.scrollTop;
      chatScrollAnchor.remember();
      if (el.scrollTop <= 60) pageOlderHistoryUntilTaller();
    }
    function onMessagesFontsSettled() {
      chatScrollAnchor.hold();
    }
    function onMessagesImageSettled(e) {
      var t = e && e.target;
      if (!t || t.tagName !== "IMG") return;
      anchorWroteSinceScroll = true;
      chatScrollAnchor.absorb(previewLayoutBox(t));
    }
    var _touchStartY = 0;
    function onMessagesWheel(e) {
      if (e.deltaY < 0) CS.stickToBottom = false;
    }
    function onMessagesTouchStart(e) {
      _touchStartY = e.touches && e.touches[0] ? e.touches[0].clientY : 0;
    }
    function onMessagesTouchMove(e) {
      var y = e.touches && e.touches[0] ? e.touches[0].clientY : 0;
      if (y > _touchStartY + 4) CS.stickToBottom = false;
    }
    function getOrCreateFileHref(filename, body) {
      var key = filename + "\0" + body;
      var existing = fileBlobCache.get(key);
      if (existing) return existing;
      var prepared = prepareDownloadText(filename, body);
      var type = EXT_CONTENT_TYPES[extOf(filename)] || mimeGetType(filename) || "text/plain; charset=utf-8";
      var href = URL.createObjectURL(new Blob([prepared.text], { type }));
      fileBlobCache.set(key, href);
      return href;
    }
    function fileToAnchorHtml(filename, href) {
      var text = "\u2197 " + filename;
      return '<a class="bq-file-download" href="' + escapeHtml(href) + '" download="' + escapeHtml(filename) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(text) + "</a>";
    }
    function linkToAnchorHtml(link, allowImagePreview) {
      return renderInlineLinkHtml(link, {
        refreshing: !!refreshingLinkMap[link.expiredHref || link.href],
        allowImagePreview,
        unavailable: isLinkUnavailable(link, unavailableLinkMap)
      });
    }
    function buildLinkPartFromGroups(full, g1, g2, g3, g4, g5, g6) {
      return classifyInlineLink(full, [g1, g2, g3, g4, g5, g6], {
        projectId: S.projectId,
        dbHostPrefix: "https://db." + hostDomain(),
        resolveFreshHref: function(expiredHref) {
          return refreshedExpiredLinkMap[expiredHref];
        }
      });
    }
    function parseMsgPartsHtml(content, opts) {
      var noPreviews = !!(opts && opts.imagePreviews === false);
      var placeholderHtml = [];
      var PH = function(idx) {
        return "\uE000BQ" + idx + "\uE001";
      };
      var pushPlaceholder = function(anchorHtml) {
        var idx = placeholderHtml.length;
        placeholderHtml.push(anchorHtml);
        return PH(idx);
      };
      var working = String(content == null ? "" : content).replace(
        /```([^\n`]+?\.[^\s.`]+)\n([\s\S]*?)```/g,
        function(_full, filename, body) {
          return pushPlaceholder(fileToAnchorHtml(filename, getOrCreateFileHref(filename, body)));
        }
      );
      if (CS.typing) {
        var openFence = working.match(/```([^\n`]+?\.[^\s.`]+)\n?/);
        if (openFence && typeof openFence.index === "number") {
          working = working.slice(0, openFence.index) + "\n[generating " + openFence[1] + "\u2026]";
        }
      }
      var codeMasks = [];
      working = working.replace(/`[^`\n]+`/g, function(match) {
        var idx = codeMasks.length;
        codeMasks.push(match);
        return "\uE002C" + idx + "\uE003";
      });
      var previewsLeft = noPreviews ? 0 : IMAGE_PREVIEWS_PER_MESSAGE;
      var linkRe = createInlineLinkRegex();
      working = working.replace(linkRe, function(full) {
        var args = Array.prototype.slice.call(arguments, 1, 7);
        var built = buildLinkPartFromGroups(full, args[0], args[1], args[2], args[3], args[4], args[5]);
        if (!built) return full;
        var allow = previewsLeft > 0;
        var html2 = linkToAnchorHtml(built.part, allow);
        if (allow && built.part.image) previewsLeft--;
        return pushPlaceholder(html2) + (built.tail || "");
      });
      working = working.replace(/C(\d+)/g, function(_m, idx) {
        return codeMasks[Number(idx)] || "";
      });
      var html;
      if (window.marked && typeof window.marked.parse === "function") {
        html = window.marked.parse(working, { gfm: true, breaks: true, async: false });
      } else {
        html = "<p>" + escapeHtml(working).replace(/\n/g, "<br>") + "</p>";
      }
      return html.replace(/BQ(\d+)/g, function(_m, idx) {
        return placeholderHtml[Number(idx)] || "";
      });
    }
    var _uploadReservedKey = null;
    function uploadReservedKey() {
      if (!_uploadReservedKey) _uploadReservedKey = randomLowerString(16);
      return _uploadReservedKey;
    }
    function randomLowerString(n) {
      var c = "abcdefghijklmnopqrstuvwxyz0123456789", s = "";
      for (var i = 0; i < n; i++) s += c.charAt(Math.floor(Math.random() * c.length));
      return s;
    }
    function formatBytes(n) {
      n = Number(n) || 0;
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / (1024 * 1024)).toFixed(1) + " MB";
    }
    function buildIndexingLabel(name, mime, size, storagePath, reindex, continued) {
      var nameLabel = storagePath ? "[" + name + "](" + storagePath + ")" : name;
      if (continued) return "Indexing (continuing) " + nameLabel;
      var extras = [];
      if (mime) extras.push(mime);
      if (size != null && size !== "" && !isNaN(Number(size))) extras.push(formatBytes(size));
      return (reindex ? "Reindexing: " : "Indexing: ") + nameLabel + (extras.length ? " \xB7 " + extras.join(" \xB7 ") : "");
    }
    function sanitizeStorageSegment(name) {
      var n = String(name == null ? "file" : name).normalize("NFC").trim().replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/ {2,}/g, " ").replace(/_{2,}/g, "_").replace(/^[_ ]+/, "");
      return n || "file";
    }
    function attachmentStoragePath(relPath) {
      var uid = S.user && S.user.user_id ? S.user.user_id : "anon";
      var sanitized = String(relPath == null ? "file" : relPath).split("/").map(sanitizeStorageSegment).filter(Boolean).join("/");
      return uid + "/" + (sanitized || "file");
    }
    function xhrUploadForm(url, form, onProgress, setAbort) {
      return new Promise(function(resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.onload = function() {
          var result = xhr.responseText;
          try {
            result = JSON.parse(result);
          } catch (e) {
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(result);
          else reject(result);
        };
        xhr.onerror = function() {
          reject(new Error("Network error"));
        };
        xhr.onabort = function() {
          reject(new Error("Aborted"));
        };
        xhr.ontimeout = function() {
          reject(new Error("Timeout"));
        };
        if (xhr.upload && typeof onProgress === "function") xhr.upload.onprogress = onProgress;
        if (typeof setAbort === "function") setAbort(function() {
          try {
            xhr.abort();
          } catch (e) {
          }
        });
        xhr.send(form);
      });
    }
    function uploadFileToDb(file, storagePath, onProgress, setAbort, checkExistence) {
      if (checkExistence === void 0) checkExistence = true;
      var params = {
        reserved_key: uploadReservedKey(),
        service: S.projectId,
        owner: S.owner,
        request: "db",
        key: storagePath,
        size: file.size || 0,
        contentType: file.type || mimeGetType(file.name) || null
      };
      if (checkExistence) params.check_existence = true;
      return S.skapi.util.request("get-signed-url", params, { auth: true }).then(function(signed) {
        var form = new FormData();
        var fields = signed && signed.fields ? signed.fields : {};
        for (var name in fields) form.append(name, fields[name]);
        form.append("file", file);
        return xhrUploadForm(signed.url, form, onProgress, setAbort);
      });
    }
    function deleteFileIndexRecordDb(storagePath) {
      if (!storagePath || !S.skapi || typeof S.skapi.deleteRecords !== "function") return Promise.resolve();
      var doneDelete = S.skapi.deleteRecords({ service: S.projectId, unique_id: indexDoneUniqueId(storagePath) }).catch(function() {
      });
      var runDelete = S.skapi.deleteRecords({ service: S.projectId, unique_id: runIndexUniqueId(storagePath) }).catch(function() {
      });
      return S.skapi.deleteRecords({ service: S.projectId, unique_id: "src::" + storagePath }).catch(function() {
      }).then(function() {
        return doneDelete;
      }).then(function() {
        return runDelete;
      });
    }
    function mintIndexDoneMarkerDb(service, storagePath) {
      if (!service || !storagePath || !S.skapi || typeof S.skapi.postRecord !== "function") return Promise.resolve();
      return Promise.resolve(S.skapi.postRecord(null, {
        service,
        unique_id: indexDoneUniqueId(storagePath),
        table: { name: "__INDEXING__", access_group: "authorized" },
        reference: "src::" + storagePath,
        data: { source: storagePath, completed_at: Date.now() }
      })).catch(function(err) {
        var msg = String(err && err.message || err || "");
        if (msg.indexOf("is already taken") === -1) {
          console.warn("[bunnyquery] mintIndexDoneMarker failed (non-fatal)", storagePath, msg);
        }
      });
    }
    function upsertIndexRunRecordDb(service, storagePath, patch) {
      if (!service || !storagePath || !patch || !patch.status) return Promise.resolve();
      if (!S.skapi || typeof S.skapi.postRecord !== "function") return Promise.resolve();
      var uid = runIndexUniqueId(storagePath);
      var TERMINAL = { done: true, error: true, cancelled: true };
      function patchData(base) {
        var d = {};
        for (var k in base || {}) d[k] = base[k];
        d.source = storagePath;
        d.status = patch.status;
        if (patch.filename) d.filename = patch.filename;
        if (typeof patch.started === "number") d.started = patch.started;
        if (typeof patch.finished === "number") d.finished = patch.finished;
        if (patch.error) d.error = patch.error;
        if (patch.queue) d.queue = patch.queue;
        if (patch.platform) d.platform = patch.platform;
        return d;
      }
      function createWith(reference) {
        var cfg = {
          service,
          unique_id: uid,
          table: { name: "__INDEXING__", access_group: "authorized" },
          data: patchData(null)
        };
        if (reference) cfg.reference = "src::" + storagePath;
        return S.skapi.postRecord(null, cfg);
      }
      function lookup() {
        return Promise.resolve(S.skapi.getRecords({ service, unique_id: uid })).then(function(found) {
          return found && found.list && found.list[0] || null;
        }).catch(function() {
          return null;
        });
      }
      function updateExisting(rec) {
        var existing = rec.data || {};
        if (patch.status === "working" && TERMINAL[String(existing.status)]) {
          var endedAt = typeof existing.finished === "number" ? existing.finished : typeof existing.started === "number" ? existing.started : 0;
          if (!(typeof patch.started === "number" && patch.started > endedAt)) return Promise.resolve(null);
        }
        if (patch.status !== "working" && String(existing.status) === patch.status) return Promise.resolve(null);
        return Promise.resolve(S.skapi.postRecord(null, {
          service,
          record_id: rec.record_id,
          data: patchData(existing)
        }));
      }
      function settleAsUpdate() {
        return lookup().then(function(rec) {
          if (rec && rec.record_id) return updateExisting(rec);
          return null;
        }).catch(function(err) {
          console.warn("[bunnyquery] upsertIndexRunRecord update failed (non-fatal)", storagePath, String(err && err.message || err || ""));
        });
      }
      function createChain() {
        return Promise.resolve(createWith(true)).catch(function(err) {
          var msg = String(err && err.message || err || "");
          if (msg.indexOf("is already taken") === -1) {
            return ensureFileIndexRecordDb(storagePath).then(function() {
              return createWith(true);
            }).catch(function(errRef) {
              var msgRef = String(errRef && errRef.message || errRef || "");
              if (msgRef.indexOf("is already taken") !== -1) return settleAsUpdate();
              return Promise.resolve(createWith(false)).catch(function(err2) {
                var msg2 = String(err2 && err2.message || err2 || "");
                if (msg2.indexOf("is already taken") === -1) {
                  console.warn("[bunnyquery] upsertIndexRunRecord create failed (non-fatal)", storagePath, msg2);
                  return null;
                }
                return settleAsUpdate();
              });
            });
          }
          return settleAsUpdate();
        });
      }
      if (patch.status !== "working") {
        return lookup().then(function(rec) {
          if (rec && rec.record_id) return updateExisting(rec);
          return createChain();
        });
      }
      return createChain();
    }
    function ensureFileIndexRecordDb(storagePath, meta, accessGroup) {
      if (!storagePath || !S.skapi || typeof S.skapi.postRecord !== "function") return Promise.resolve();
      return Promise.resolve(S.skapi.postRecord(null, {
        service: S.projectId,
        unique_id: "src::" + storagePath,
        table: { name: "file_summaries", access_group: normalizeUploadAccessGroup(accessGroup) },
        // Deleting the file record must cascade to every record referencing it.
        source: { can_remove_referencing_records: true },
        data: {
          file_name: meta && meta.name || storagePath.split("/").pop() || storagePath,
          storage_path: storagePath,
          mime_type: meta && meta.mime || null,
          size_bytes: meta && typeof meta.size === "number" ? meta.size : null,
          indexed_at: Date.now(),
          note: "File-level record created at upload. The indexing agent enriches this with sheet names, column headers and row counts."
        }
      })).catch(function() {
      });
    }
    function getTemporaryUrlDb(path, expires, cdn, contentType, opts) {
      opts = opts || {};
      var body = {
        service: S.projectId,
        owner: S.owner,
        request: "get-db",
        key: path,
        expires: expires || ATTACHMENT_URL_EXPIRES_SECONDS,
        contentType: contentType || mimeGetType(path) || "application/octet-stream"
      };
      if (cdn !== false) body.generate_temporary_cdn_url = true;
      var reqOpts = { auth: true, method: "post" };
      if (cdn === false && opts.browserCache) {
        reqOpts.method = "get";
        reqOpts.stableGateway = true;
        body.nocache = previewMintCacheToken(opts.refresh);
        body.browser_cache = opts.browserCache;
        var uid = S.user && S.user.user_id;
        if (uid) body.uid = uid;
      }
      function unwrap(res) {
        var u = typeof res === "string" ? res : res && res.url;
        if (!u) throw new Error("No temporary URL returned.");
        if (/^https?:\/\//i.test(u)) return u;
        return "https://db." + hostDomain() + "/" + u;
      }
      return S.skapi.util.request("get-signed-url", body, reqOpts).then(unwrap);
    }
    var ATTACH_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
    var FILE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    var FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    var MAX_CHATBOX_FILE_COUNT = 20;
    var MAX_ATTACHMENT_FILE_COUNT = 20;
    var VISIBLE_CHIP_CAP = 30;
    var ESTIMATED_BYTES_PER_TOKEN = 3;
    var ESTIMATED_PDF_BYTES_PER_TOKEN = 5e3;
    var ESTIMATED_IMAGE_TOKENS = 800;
    var TEXTLIKE_EXTENSION_RE = /\.(txt|md|markdown|rst|csv|tsv|json|jsonl|ndjson|ya?ml|xml|html?|css|less|scss|sass|js|mjs|cjs|ts|tsx|jsx|vue|svelte|astro|py|rb|go|rs|java|kt|swift|c|h|hpp|cpp|cc|cs|php|sh|bash|zsh|ps1|sql|log|conf|cfg|ini|toml|env|gitignore|dockerfile|makefile|lock)$/i;
    var PDF_EXTENSION_RE = /\.pdf$/i;
    var IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|svg)$/i;
    function estimateFileTokenCost(file) {
      var name = file.name || "", size = file.size || 0, type = (file.type || "").toLowerCase();
      if (TEXTLIKE_EXTENSION_RE.test(name) || type.indexOf("text/") === 0 || type.indexOf("json") !== -1 || type.indexOf("xml") !== -1) {
        return Math.ceil(size / ESTIMATED_BYTES_PER_TOKEN);
      }
      if (PDF_EXTENSION_RE.test(name) || type === "application/pdf") return Math.ceil(size / ESTIMATED_PDF_BYTES_PER_TOKEN);
      if (IMAGE_EXTENSION_RE.test(name) || type.indexOf("image/") === 0) return ESTIMATED_IMAGE_TOKENS;
      return 0;
    }
    function composerAttachments() {
      return CS.attachments.filter(function(a) {
        return !a._batchId;
      });
    }
    function attachmentsTokenEstimate() {
      var total = 0;
      composerAttachments().forEach(function(a) {
        if (a.kind === "folder") {
          (a.files || []).forEach(function(f) {
            total += estimateFileTokenCost(f.file);
          });
        } else if (a.file) total += estimateFileTokenCost(a.file);
      });
      return total;
    }
    function attachmentFileCount() {
      var n = 0;
      composerAttachments().forEach(function(a) {
        n += a.kind === "folder" ? a.files ? a.files.length : 0 : 1;
      });
      return n;
    }
    function currentInputTokenBudget() {
      var platform = S.aiPlatform;
      if (platform !== "claude" && platform !== "openai") return 0;
      return getInputTokenBudget(platform, S.aiModel, S.projectId);
    }
    function formatTokenCount(tokens) {
      if (tokens >= 1e3) {
        var k = tokens / 1e3;
        return (k >= 10 ? Math.round(k) : k.toFixed(1)) + "k";
      }
      return String(tokens);
    }
    function currentChatInputText() {
      var el = CS.inputEl || CS.messagesBox && CS.messagesBox.parentNode && CS.messagesBox.parentNode.querySelector(".bq-input");
      return el ? (el.value || "").trim() : "";
    }
    function recomputeAttachmentWarning() {
      if (!currentChatInputText()) {
        CS.attachmentWarning = "";
        return;
      }
      var count = attachmentFileCount();
      if (count > MAX_CHATBOX_FILE_COUNT) {
        CS.attachmentWarning = "You've attached " + count + " files. Up to " + MAX_CHATBOX_FILE_COUNT + " per message is recommended \u2014 remove " + (count - MAX_CHATBOX_FILE_COUNT) + " to send with a message.";
        return;
      }
      var budget = currentInputTokenBudget();
      var est = attachmentsTokenEstimate();
      if (budget && est > budget) {
        CS.attachmentWarning = "Attachments are ~" + formatTokenCount(est) + " tokens, which may exceed the ~" + formatTokenCount(budget) + "-token per-request limit. Remove some files to send with a message.";
        return;
      }
      CS.attachmentWarning = "";
    }
    function attachmentKey(a) {
      if (a.kind === "folder") {
        var total = 0;
        (a.files || []).forEach(function(f) {
          total += f.file && f.file.size || 0;
        });
        return "d|" + a.name + "|" + (a.files ? a.files.length : 0) + "|" + total;
      }
      return "f|" + a.name + "|" + (a.file ? a.file.size : 0) + "|" + (a.file ? a.file.lastModified : 0);
    }
    function newAttachment(props) {
      return Object.assign({
        id: "att_" + randomLowerString(10),
        status: "pending",
        progress: 0,
        uploadedUrl: "",
        storagePath: "",
        errorMessage: ""
      }, props);
    }
    function appendAttachments(attObjs) {
      var seen = {};
      CS.attachments.forEach(function(a) {
        seen[attachmentKey(a)] = true;
      });
      var remaining = MAX_ATTACHMENT_FILE_COUNT - attachmentFileCount();
      var dropped = 0;
      var changed = false;
      (attObjs || []).forEach(function(a) {
        if (!a) return;
        var k = attachmentKey(a);
        if (seen[k]) return;
        var count = a.kind === "folder" ? a.files ? a.files.length : 0 : 1;
        if (remaining <= 0) {
          dropped += count;
          return;
        }
        if (a.kind === "folder" && count > remaining) {
          dropped += count - remaining;
          a.files = a.files.slice(0, remaining);
          count = remaining;
        }
        seen[k] = true;
        CS.attachments.push(a);
        remaining -= count;
        changed = true;
      });
      CS.attachmentCapNotice = dropped > 0 ? "You can attach up to " + MAX_ATTACHMENT_FILE_COUNT + " files per message. " + dropped + " file" + (dropped === 1 ? " was" : "s were") + " not added." : "";
      if (changed) {
        recomputeAttachmentWarning();
        renderAttachmentChips();
        scheduleAttachmentOverflowRecompute();
      } else if (dropped > 0) {
        renderAttachmentChips();
      }
      updateComposerControls();
    }
    function addFilesToAttachments(files) {
      var objs = [];
      Array.prototype.slice.call(files || []).forEach(function(f) {
        if (!f || typeof f.size !== "number") return;
        objs.push(newAttachment({ kind: "file", name: f.name, file: f }));
      });
      if (objs.length) appendAttachments(objs);
    }
    function readEntry(entry2, prefix) {
      prefix = prefix || "";
      return new Promise(function(resolve) {
        if (!entry2) {
          resolve([]);
          return;
        }
        if (entry2.isFile) {
          entry2.file(function(file) {
            resolve([{ file, path: prefix + file.name }]);
          }, function() {
            resolve([]);
          });
          return;
        }
        if (entry2.isDirectory) {
          var reader2 = entry2.createReader();
          var all = [];
          var readBatch = function() {
            reader2.readEntries(function(entries) {
              if (!entries.length) {
                resolve(all);
                return;
              }
              Promise.all(entries.map(function(e) {
                return readEntry(e, prefix + entry2.name + "/");
              })).then(function(groups) {
                groups.forEach(function(g) {
                  all.push.apply(all, g);
                });
                readBatch();
              });
            }, function() {
              resolve(all);
            });
          };
          readBatch();
          return;
        }
        resolve([]);
      });
    }
    var ATTACHMENTS_MAX_HEIGHT_RATIO = 0.3;
    var _attOverflowFrame = 0;
    function scheduleAttachmentOverflowRecompute() {
      if (typeof requestAnimationFrame !== "function") {
        recomputeAttachmentOverflow();
        return;
      }
      if (_attOverflowFrame) cancelAnimationFrame(_attOverflowFrame);
      _attOverflowFrame = requestAnimationFrame(function() {
        _attOverflowFrame = 0;
        recomputeAttachmentOverflow();
      });
    }
    function recomputeAttachmentOverflow() {
      var row = CS.attachmentsRow, chat = CS.chatEl;
      var total = CS.attachments.length;
      if (!row || !chat) return;
      if (!total) {
        CS.visibleAttachmentCount = Infinity;
        return;
      }
      var count = Math.min(total, VISIBLE_CHIP_CAP);
      CS.visibleAttachmentCount = count;
      renderAttachmentChips();
      var maxHeight = chat.clientHeight * ATTACHMENTS_MAX_HEIGHT_RATIO;
      if (maxHeight <= 0) return;
      while (count > 0 && row.scrollHeight > maxHeight) {
        count--;
        CS.visibleAttachmentCount = count;
        renderAttachmentChips();
      }
    }
    function removeAttachments(ids) {
      var idset = {};
      ids.forEach(function(id) {
        idset[id] = true;
      });
      CS.attachments = CS.attachments.filter(function(a) {
        if (idset[a.id]) {
          if (a._abort) {
            try {
              a._abort();
            } catch (e) {
            }
          }
          return false;
        }
        return true;
      });
      CS.visibleAttachmentCount = Infinity;
      CS.attachmentCapNotice = "";
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    function removeAttachment(id) {
      var i = CS.attachments.findIndex(function(a) {
        return a.id === id;
      });
      if (i === -1) return;
      var att = CS.attachments[i];
      if (att._abort) {
        try {
          att._abort();
        } catch (e) {
        }
      }
      CS.attachments.splice(i, 1);
      CS.attachmentCapNotice = "";
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    function clearAttachments() {
      CS.attachments = CS.attachments.filter(function(a) {
        return !!a._batchId;
      });
      CS.attachmentWarning = "";
      CS.attachmentCapNotice = "";
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    function clearSuccessfulAttachments(batchId) {
      CS.attachments = CS.attachments.filter(function(a) {
        if (a._batchId !== batchId) return true;
        if (a.status !== "error" && a.status !== "indexError") return false;
        a._abort = null;
        delete a._batchId;
        return true;
      });
      CS.attachmentCapNotice = "";
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    var ATTACHMENT_STATUS_PRIORITY = { uploading: 0, pending: 1, error: 2, indexError: 2, done: 3 };
    function attachmentStatusPriority(status) {
      var p = ATTACHMENT_STATUS_PRIORITY[status == null ? "pending" : status];
      return p === void 0 ? 99 : p;
    }
    function sortedAttachments() {
      return CS.attachments.map(function(a, i) {
        return { a, i };
      }).sort(function(x, y) {
        var px = attachmentStatusPriority(x.a.status);
        var py = attachmentStatusPriority(y.a.status);
        if (px !== py) return px - py;
        if (px === 0 || px === 2) return y.i - x.i;
        return x.i - y.i;
      }).map(function(e) {
        return e.a;
      });
    }
    function renderAttachmentChips() {
      var row = CS.attachmentsRow;
      if (!row) return;
      row.innerHTML = "";
      if (!CS.attachments.length && !CS.attachmentWarning && !CS.attachmentCapNotice) {
        row.style.display = "none";
        return;
      }
      row.style.display = "";
      if (CS.attachmentCapNotice) {
        row.appendChild(h("div", { class: "bq-attachment-warning" }, h("span", { text: CS.attachmentCapNotice })));
      }
      if (CS.attachmentWarning) {
        row.appendChild(h("div", { class: "bq-attachment-warning" }, h("span", { text: CS.attachmentWarning })));
      }
      var sorted = sortedAttachments();
      var vis = Math.min(CS.visibleAttachmentCount, VISIBLE_CHIP_CAP);
      var shown = vis >= sorted.length ? sorted : sorted.slice(0, Math.max(0, vis));
      var hidden = sorted.slice(shown.length);
      shown.forEach(function(att) {
        var isFolder = att.kind === "folder";
        var clickable = att.status === "done" && !isFolder && !!att.uploadedUrl;
        var finalizing = att.status === "uploading" && (att.progress || 0) >= 100;
        var preparing = att.status === "uploading" && att.progress == null;
        var cls = "bq-attachment";
        if (att.status === "uploading") cls += " is-uploading";
        if (preparing) cls += " is-preparing";
        else if (finalizing) cls += " is-finalizing";
        else if (att.status === "error") cls += " is-error";
        else if (att.status === "indexError") cls += " is-index-error";
        else if (att.status === "done") cls += " is-done";
        if (clickable) cls += " is-clickable";
        var chip = h("div", { class: cls });
        if (att.status === "uploading" && att.progress != null) chip.style.setProperty("--att-progress", att.progress + "%");
        chip.title = att.status === "error" ? "File upload has failed" : att.status === "indexError" ? "File indexing failed" : clickable ? "Open " + att.name : isFolder ? att.name + "/ \u2014 " + (att.files ? att.files.length : 0) + " file(s)" : att.name;
        if (clickable) chip.addEventListener("click", function() {
          window.open(att.uploadedUrl, "_blank", "noopener,noreferrer");
        });
        chip.appendChild(h("span", { class: "bq-attachment-icon", html: isFolder ? FOLDER_ICON_SVG : FILE_ICON_SVG }));
        chip.appendChild(h("span", { class: "bq-attachment-name", text: att.name, title: att.name }));
        var meta = att.status === "error" ? "(Failed)" : att.status === "indexError" ? "(Error)" : preparing ? "Preparing" : finalizing ? "Finalizing" : att.status === "uploading" ? att.progress + "%" : isFolder ? "(" + (att.files ? att.files.length : 0) + ")" : formatBytes(att.file ? att.file.size : att.size);
        chip.appendChild(h("span", { class: "bq-attachment-meta", text: meta }));
        if (clickable) chip.appendChild(h("span", { class: "bq-attachment-arrow", text: "\u2197" }));
        if (att.status !== "uploading" && att.status !== "done") {
          var rm = h("button", { class: "bq-attachment-remove", type: "button", title: "Remove", text: "\xD7" });
          rm.addEventListener("click", function(e) {
            e.stopPropagation();
            removeAttachment(att.id);
          });
          chip.appendChild(rm);
        }
        row.appendChild(chip);
      });
      if (hidden.length > 0) {
        var moreNames = hidden.slice(0, 50).map(function(a) {
          return a.kind === "folder" ? a.name + "/" : a.name;
        });
        if (hidden.length > moreNames.length) moreNames.push("...and " + (hidden.length - moreNames.length) + " more");
        var moreChip = h("div", {
          class: "bq-attachment bq-attachment-more",
          title: moreNames.join("\n")
        });
        moreChip.appendChild(h("span", { class: "bq-attachment-name", text: "\u2026(" + hidden.length + ") more" }));
        var moreRm = h("button", {
          class: "bq-attachment-remove",
          type: "button",
          title: "Remove these " + hidden.length,
          text: "\xD7"
        });
        moreRm.addEventListener("click", function(e) {
          e.stopPropagation();
          removeAttachments(hidden.map(function(a) {
            return a.id;
          }));
        });
        moreChip.appendChild(moreRm);
        row.appendChild(moreChip);
      } else if (composerAttachments().length >= 2) {
        var removeAll = h("button", {
          class: "bq-attachment-remove-all",
          type: "button",
          title: "Remove all attachments"
        }, "Remove all \xD7");
        removeAll.addEventListener("click", function(e) {
          e.stopPropagation();
          clearAttachments();
        });
        row.appendChild(removeAll);
      }
    }
    function uploadsFrozenForUser() {
      if (!S.user) return true;
      var conf = S.service && S.service.conf || {};
      if (!conf.freeze_database) return false;
      var ag = S.user && typeof S.user.access_group === "number" ? S.user.access_group : 0;
      return ag < 99;
    }
    function updateComposerControls() {
      if (CS.attachBtnEl) CS.attachBtnEl.disabled = false;
      if (CS.inputEl) CS.inputEl.disabled = false;
      if (CS.sendBtnEl) {
        var hasText = !!(CS.inputEl && CS.inputEl.value.trim());
        var hasSendableAttachment = composerAttachments().some(function(a) {
          return a.status !== "done";
        });
        CS.sendBtnEl.disabled = !!CS.attachmentWarning || !hasText && !hasSendableAttachment;
      }
    }
    function onAttachInputChange(inputEl) {
      if (inputEl && inputEl.files && inputEl.files.length) addFilesToAttachments(inputEl.files);
      if (inputEl) inputEl.value = "";
    }
    function setupDragAndDrop(chatEl) {
      var depth = 0, overlay = null;
      function showOverlay() {
        if (overlay || S.aiPlatform === "none") return;
        overlay = h(
          "div",
          { class: "bq-drop-overlay" },
          h(
            "div",
            { class: "bq-drop-overlay-inner" },
            h("span", { html: ATTACH_ICON_SVG }),
            h("span", { text: "Drop files to attach" })
          )
        );
        chatEl.appendChild(overlay);
      }
      function hideOverlay() {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        overlay = null;
      }
      function hasFiles(e) {
        var dt = e.dataTransfer;
        if (!dt) return false;
        if (dt.types) {
          for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === "Files") return true;
          return false;
        }
        return true;
      }
      chatEl.addEventListener("dragenter", function(e) {
        if (!hasFiles(e) || S.aiPlatform === "none" || CS.chatSettingsOpen) return;
        e.preventDefault();
        depth++;
        showOverlay();
      });
      chatEl.addEventListener("dragover", function(e) {
        if (!hasFiles(e) || S.aiPlatform === "none" || CS.chatSettingsOpen) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      });
      chatEl.addEventListener("dragleave", function(e) {
        if (!hasFiles(e)) return;
        depth--;
        if (depth <= 0) {
          depth = 0;
          hideOverlay();
        }
      });
      chatEl.addEventListener("drop", function(e) {
        if (!hasFiles(e) || S.aiPlatform === "none" || CS.chatSettingsOpen) return;
        e.preventDefault();
        depth = 0;
        hideOverlay();
        handleDrop(e.dataTransfer);
      });
    }
    function handleDrop(dt) {
      if (!dt) return;
      var items = dt.items;
      if (items && items.length) {
        var entries = [];
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it.kind !== "file") continue;
          var entry2 = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
          entries.push(entry2 || it.getAsFile());
        }
        Promise.all(entries.map(function(entry3) {
          if (!entry3) return Promise.resolve(null);
          if (entry3 instanceof File) return Promise.resolve(newAttachment({ kind: "file", name: entry3.name, file: entry3 }));
          if (entry3.isFile) {
            return readEntry(entry3).then(function(files) {
              return files[0] ? newAttachment({ kind: "file", name: files[0].file.name, file: files[0].file }) : null;
            });
          }
          if (entry3.isDirectory) {
            return readEntry(entry3).then(function(files) {
              return newAttachment({ kind: "folder", name: entry3.name, files });
            });
          }
          return Promise.resolve(null);
        })).then(function(objs) {
          appendAttachments(objs.filter(Boolean));
        });
      } else if (dt.files && dt.files.length) {
        addFilesToAttachments(dt.files);
      }
    }
    function getPublicTemporaryUrl(remotePath) {
      if (!remotePath) return Promise.reject(new Error("Missing attachment path."));
      return getTemporaryUrlDb(remotePath, EXPIRED_LINK_REFRESH_EXPIRES_SECONDS, false);
    }
    var unavailableRepaintQueued = false;
    function queueUnavailableRepaint() {
      if (unavailableRepaintQueued) return;
      unavailableRepaintQueued = true;
      setTimeout(function() {
        unavailableRepaintQueued = false;
        renderMessages();
      }, 0);
    }
    function markLinkUnavailable(key) {
      if (!key || unavailableLinkMap[key]) return;
      unavailableLinkMap[key] = true;
      if (!refreshedLinkExpiryTimer) scheduleNextLinkExpiryBoundary();
      queueUnavailableRepaint();
    }
    function clearLinkUnavailable(keys) {
      var changed = false;
      for (var i = 0; i < (keys || []).length; i++) {
        var k = keys[i];
        if (!k || !unavailableLinkMap[k]) continue;
        delete unavailableLinkMap[k];
        changed = true;
      }
      if (changed) queueUnavailableRepaint();
    }
    function imagePreviewCtx() {
      return {
        scope: S.projectId || "default",
        mint: function(remotePath, contentType, refresh) {
          return getTemporaryUrlDb(remotePath, PREVIEW_URL_EXPIRES_SECONDS, false, contentType, {
            browserCache: PREVIEW_BROWSER_CACHE_SECONDS,
            refresh
          });
        },
        // An image arriving late pushes the conversation down under the
        // viewport. Re-pin only if the user was already at the bottom. A
        // paint is also proof the file is reachable, so it lifts any mark an
        // earlier failure left on this file's chips.
        onLoad: function(path) {
          clearLinkUnavailable(linkUnavailableKeysForPath(path));
          scrollToBottomIfSticky();
        },
        // The resizes an <img> makes with no event of its own to announce
        // them: the src landing, and the src being dropped for a retry (which
        // collapses an already-painted picture to nothing). load and error are
        // covered by the listener on the message box, which also catches the
        // markdown images this module never sees.
        onLayoutChange: function(img) {
          chatScrollAnchor.absorb(img);
        },
        // The mint was refused, or the url it minted would not load. Either
        // way there is no url for this file, so the caption chip left behind
        // must not keep offering a click that opens a dead tab.
        onError: function(path, err) {
          console.warn("[bunnyquery] image preview failed", path, err);
          markLinkUnavailable(linkUnavailableKeyForPath(path));
        }
      };
    }
    function hydrateMessageImagePreviews() {
      if (!CS.messagesBox) return;
      var nodes = CS.messagesBox.querySelectorAll("img.bq-img-preview:not([data-bq-img-state])");
      if (!nodes.length) return;
      var list = Array.prototype.filter.call(nodes, function(n) {
        return !(n.closest && n.closest(".bq-index-label"));
      });
      if (list.length) hydrateImagePreviews(list, imagePreviewCtx());
    }
    var refreshedLinkExpiryTimer = null;
    function expireAllRefreshedLinks() {
      var changed = false;
      for (var k in refreshedExpiredLinkMap) {
        delete refreshedExpiredLinkMap[k];
        changed = true;
      }
      for (var u in unavailableLinkMap) {
        delete unavailableLinkMap[u];
        changed = true;
      }
      return changed;
    }
    function scheduleNextLinkExpiryBoundary() {
      if (refreshedLinkExpiryTimer) clearTimeout(refreshedLinkExpiryTimer);
      var now = Date.now();
      var next = Math.ceil(now / LINK_REFRESH_WINDOW_MS) * LINK_REFRESH_WINDOW_MS;
      refreshedLinkExpiryTimer = setTimeout(function() {
        if (expireAllRefreshedLinks()) renderMessages();
        scheduleNextLinkExpiryBoundary();
      }, Math.max(1, next - now));
    }
    function fetchFreshHrefForExpiredLink(expiredHref, remotePath) {
      var cached = refreshedExpiredLinkMap[expiredHref];
      if (cached) return Promise.resolve(cached);
      var inFlight = refreshingLinkPromises.get(expiredHref);
      if (inFlight) return inFlight;
      var run = (function() {
        refreshingLinkMap[expiredHref] = true;
        var resolved = remotePath || extractRemotePathFromAttachmentHref(expiredHref, S.projectId);
        if (!resolved) return Promise.reject(new Error("Unable to refresh this expired attachment link."));
        return getPublicTemporaryUrl(resolved).then(function(fresh) {
          refreshedExpiredLinkMap[expiredHref] = fresh;
          scheduleNextLinkExpiryBoundary();
          return fresh;
        });
      })().then(
        function(v) {
          refreshingLinkPromises.delete(expiredHref);
          delete refreshingLinkMap[expiredHref];
          return v;
        },
        function(e) {
          refreshingLinkPromises.delete(expiredHref);
          delete refreshingLinkMap[expiredHref];
          throw e;
        }
      );
      refreshingLinkPromises.set(expiredHref, run);
      return run;
    }
    function onBubbleLinkClick(e) {
      var target = e.target;
      if (!target) return;
      var anchor = target.closest ? target.closest("a[data-bq-link]") : null;
      if (!anchor) return;
      if (anchor.dataset.bqUnavailable === "1") {
        e.preventDefault();
        return;
      }
      if (anchor.dataset.bqExpired !== "1") return;
      e.preventDefault();
      var originalHref = anchor.dataset.bqExpiredHref || anchor.href;
      if (refreshingLinkMap[originalHref]) return;
      var cached = refreshedExpiredLinkMap[originalHref];
      if (cached) {
        anchor.href = cached;
        anchor.dataset.bqExpired = "0";
        anchor.click();
        return;
      }
      fetchFreshHrefForExpiredLink(originalHref, anchor.dataset.bqRemotePath).then(function(fresh) {
        anchor.href = fresh;
        anchor.dataset.bqExpired = "0";
        anchor.click();
      }).catch(function(err) {
        console.error("[bunnyquery] expired link refresh failed", err);
        markLinkUnavailable(linkUnavailableKeyForHref(originalHref));
        if (anchor.dataset.bqRemotePath) markLinkUnavailable(linkUnavailableKeyForPath(anchor.dataset.bqRemotePath));
      });
    }
    function getClearHistoryStorageKey() {
      if (!S.projectId || S.aiPlatform === "none") return "";
      var key = SK.clearHorizon + ":" + S.projectId + "#" + S.aiPlatform;
      if (isAnonymousSession()) key += "#" + anonDeviceId();
      return key;
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
    function fetchOlderHistoryIfNeeded() {
      if (CS.historyEndOfList) return Promise.resolve(true);
      if (CS.loadingHistory || CS.loadingOlderHistory) return Promise.resolve(false);
      return session.loadHistory(true).then(function() {
        return true;
      });
    }
    function messagesBoxCanScroll() {
      if (!CS.messagesBox || CS.chatSettingsOpen) return true;
      var drafting = CS.draftingEl && CS.draftingEl.parentNode === CS.messagesBox ? CS.draftingEl.offsetHeight : 0;
      return CS.messagesBox.scrollHeight - drafting - CS.messagesBox.clientHeight > HISTORY_FILL_SLACK_PX;
    }
    function topVisibleRowKey() {
      var box = CS.messagesBox;
      if (!box) return null;
      var boxTop = box.getBoundingClientRect().top;
      var kids = box.children;
      for (var i = 0; i < kids.length; i++) {
        var key = kids[i].getAttribute && kids[i].getAttribute("data-row-key");
        if (!key) continue;
        if (kids[i].getBoundingClientRect().top - boxTop + kids[i].offsetHeight > 0) return key;
      }
      return null;
    }
    function contentAboveRow(key) {
      var box = CS.messagesBox;
      if (!box) return null;
      var boxTop = box.getBoundingClientRect().top;
      var kids = box.children;
      for (var i = 0; i < kids.length; i++) {
        if (!kids[i].getAttribute || kids[i].getAttribute("data-row-key") !== key) continue;
        return kids[i].getBoundingClientRect().top - boxTop + box.scrollTop;
      }
      return null;
    }
    var _historyFillToken = 0;
    var _historyFiller = createHistoryFiller({
      isEndOfList: function() {
        return !!CS.historyEndOfList;
      },
      isLoading: function() {
        return !!(CS.loadingHistory || CS.loadingOlderHistory);
      },
      // The settings panel occupies the messages box and suppresses
      // renderMessages, so a fill started before it opened must stop.
      isStale: function() {
        return _historyFillToken !== CS.gateRefreshToken || !CS.messagesBox || CS.chatSettingsOpen;
      },
      messageCount: function() {
        return CS.messages.length;
      },
      fetchOlder: function() {
        return fetchOlderHistoryIfNeeded();
      },
      // A collapsed indexing row whose run begins above the loaded window says
      // "loading" for as long as the pages that would complete it keep coming, and
      // that span is the LOOP, not a page (see createHistoryFiller). Rendering the
      // flip is safe from here: renderMessages never starts a fill of its own, and
      // the loop's own guard has already flipped before this is called.
      onRunningChange: function(running) {
        CS.historyFilling = running;
        renderMessages();
      }
    });
    function pageOlderHistoryUntil(isSatisfied, token) {
      if (token === void 0) token = CS.gateRefreshToken;
      if (token !== CS.gateRefreshToken) return Promise.resolve();
      _historyFillToken = token;
      return _historyFiller.fill(function() {
        return raf2().then(isSatisfied);
      });
    }
    function ensureHistoryFillsViewport(token) {
      return pageOlderHistoryUntil(messagesBoxCanScroll, token);
    }
    function pageOlderHistoryUntilTaller() {
      var anchorKey = topVisibleRowKey();
      var before = anchorKey ? contentAboveRow(anchorKey) : null;
      return pageOlderHistoryUntil(function() {
        if (!CS.messagesBox || !anchorKey || before === null) return true;
        var now = contentAboveRow(anchorKey);
        return now === null || now > before + HISTORY_FILL_SLACK_PX;
      });
    }
    function openClearHistoryModal() {
      if (!chatEnabled() || CS.sending || CS.typing) return;
      if (!CS.messages.length) return;
      var modal = openModal(function(close) {
        var clearBtn = h("button", { class: "btn btn--danger", type: "button" }, "Clear");
        clearBtn.addEventListener("click", function() {
          if (CS.clearing) return;
          CS.clearing = true;
          setClearedAt(Date.now());
          var key = session.getHistoryCacheKey();
          if (key) delete aiChatHistoryCache[key];
          CS.messages = [];
          CS.historyStartKeyHistory = [];
          CS.historyEndOfList = true;
          renderMessages();
          CS.clearing = false;
          close();
        });
        return h(
          "div",
          { class: "bq-modal" },
          h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
          h(
            "div",
            { class: "bq-modal-delete-header" },
            h("span", { text: "Clear chat history" })
          ),
          h("p", { class: "bq-modal-desc" }, "This hides the current conversation from view. Your messages stay on the server but won't be shown here again."),
          h(
            "div",
            { class: "bq-modal-btns" },
            h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Cancel"),
            clearBtn
          )
        );
      });
      return modal;
    }
    function chatEnabled() {
      return S.aiPlatform !== "none";
    }
    function autoGrowInput(el) {
      if (!el) return;
      var prevH = el.offsetHeight;
      el.style.height = "auto";
      var cs = window.getComputedStyle(el);
      var border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      var max = 192;
      var h2 = el.scrollHeight + border;
      if (h2 > max) {
        el.style.height = max + "px";
        el.style.overflowY = "auto";
      } else {
        el.style.height = h2 + "px";
        el.style.overflowY = "hidden";
      }
      var nextH = el.offsetHeight;
      if (CS.stickToBottom) chatScrollAnchor.pinBottom();
      if (nextH < prevH) ensureHistoryFillsViewport();
    }
    function buildMessageEl(msg, idx) {
      var cls = ["bq-message"];
      cls.push(msg.role === "user" ? "is-user" : "is-assistant");
      if (msg.isError) cls.push("is-error");
      if (msg.isCancelled) cls.push("is-cancelled");
      if (msg.isPendingQueued || msg.isPendingOlder) cls.push("is-pending-older");
      if (msg._dimSending || msg._cancelling) cls.push("is-sending-to-server");
      var bubble;
      if (msg.isPending && !msg._streaming || streamRecoveryPhase(msg) === "active") {
        bubble = h("div", { class: "bq-bubble" }, h("span", { class: "bq-loader" }));
      } else if (streamRecoveryPhase(msg)) {
        var labels = streamRecoveryLabels(streamRecoveryPhase(msg));
        bubble = h("div", { class: "bq-bubble is-stream-recover" + (streamRecoveryPhase(msg) === "failed" ? " is-stream-failed" : "") });
        bubble.appendChild(h("span", { class: "bq-stream-recover-note", text: labels.note }));
        var recoverBtn = h("button", { class: "bq-stream-recover-btn", type: "button", text: labels.action });
        recoverBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          session.recoverStreamedAnswer(msg._serverItemId);
        });
        bubble.appendChild(recoverBtn);
      } else {
        bubble = h("div", { class: "bq-bubble" });
        if (msg.role === "user" && msg.isPendingQueued) {
          var disabled = !msg._serverItemId || msg.isSendingToServer || msg._cancelling;
          var cancelBtn = h("button", {
            class: "bq-cancel-queue-btn" + (disabled ? " is-disabled" : ""),
            type: "button",
            title: "Cancel queued message",
            html: "&times;"
          });
          if (!disabled) cancelBtn.addEventListener("click", function(e) {
            e.stopPropagation();
            session.cancelQueuedMessage(msg, idx);
          });
          bubble.appendChild(cancelBtn);
        }
        var md = h("div", { class: "bq-md", translate: "no", html: parseMsgPartsHtml(msg.content) });
        md.addEventListener("click", onBubbleLinkClick);
        bubble.appendChild(md);
        if (msg.isUploadingAttachments) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(Uploading files...)" }));
        else if (msg.isAwaitingIndexing) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(Indexing files...)" }));
        else if (msg.isPendingQueued) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(In queue)" }));
        if (msg.isCancelled) bubble.appendChild(h("span", { class: "bq-cancel-error", text: "(cancelled)" }));
        if (msg._cancelError) bubble.appendChild(h("span", { class: "bq-cancel-error", text: msg._cancelError }));
        var ts = msg.isPending ? "" : formatChatTimestamp(msg._ts);
        if (ts) bubble.appendChild(h("time", { class: "bq-msg-time", text: ts }));
      }
      return h("div", { class: cls.join(" "), dataset: { msgIndex: String(idx) } }, bubble);
    }
    var INDEX_ICON_ACTIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 0 1-8.5 8.5 8.5 8.5 0 0 1-7.6-4.7"/><path d="M3.5 12A8.5 8.5 0 0 1 12 3.5a8.5 8.5 0 0 1 7.6 4.7"/><path d="M20 3.6v4.8h-4.8"/><path d="M4 20.4v-4.8h4.8"/></svg>';
    var INDEX_ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
    var INDEX_ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.6h.01"/></svg>';
    var INDEX_ICON_CANCELLED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.2 8.2l7.6 7.6"/></svg>';
    var INDEX_ICON_PENDING = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.4V12l3.3 2"/></svg>';
    function indexGroupIcon(group) {
      if (group.status === "cancelled") return INDEX_ICON_CANCELLED;
      if (group.resolving) return INDEX_ICON_PENDING;
      if (!group.finished) return INDEX_ICON_ACTIVE;
      if (group.status === "error") return INDEX_ICON_ERROR;
      return INDEX_ICON_DONE;
    }
    function indexGroupVerb(group) {
      if (group.status === "cancelled") return "Indexing cancelled:";
      if (group.resolving) {
        return group.resolvingReason === "history" ? "Loading history:" : "Checking status:";
      }
      if (!group.finished) return group.isReindex ? "Reindexing" : "Indexing";
      if (group.status === "error") return "Indexing failed:";
      return group.isReindex ? "Reindexed" : "Indexed";
    }
    function indexGroupLabel(group) {
      var nameLabel = group.path ? "[" + group.name + "](" + group.path + ")" : group.name;
      return indexGroupVerb(group) + " " + nameLabel;
    }
    function indexGroupCount(group) {
      if (group.stub) return "";
      if (group.passCount <= 1 && !group.mayHaveOlder) return "";
      return group.passCount + (group.mayHaveOlder ? "+" : "") + " passes";
    }
    var markerSweep = { svc: "", at: 0, gen: 0, done: {}, runs: {}, partial: false, inflight: null };
    var MARKER_SWEEP_TTL_MS = 3e4;
    var MARKER_SWEEP_MAX_PAGES = 10;
    function sweepIndexMarkersDb() {
      if (!S.skapi || !S.projectId || typeof S.skapi.getRecords !== "function") return Promise.resolve(null);
      var svc = S.projectId;
      if (markerSweep.svc === svc && markerSweep.at && Date.now() - markerSweep.at < MARKER_SWEEP_TTL_MS) {
        return Promise.resolve(markerSweep);
      }
      if (markerSweep.inflight) {
        if (!markerSweep.at) {
          return markerSweep.inflight.then(function() {
            return sweepIndexMarkersDb();
          });
        }
        return markerSweep.inflight;
      }
      var gen = markerSweep.gen;
      var done = {};
      var runs = {};
      var partial = false;
      function page(fetchMore, n) {
        return Promise.resolve(S.skapi.getRecords(
          { service: svc, table: { name: "__INDEXING__", access_group: "authorized" } },
          { limit: 1e3, fetchMore, ascending: false }
        )).then(function(res) {
          var list = res && res.list || [];
          for (var i = 0; i < list.length; i++) {
            var uid = String(list[i] && list[i].unique_id || "");
            if (uid.indexOf("done::") === 0) {
              done[uid.slice(6)] = true;
            } else if (uid.indexOf("run::") === 0) {
              var path = uid.slice(5);
              var d = list[i] && list[i].data || {};
              var st = String(d.status || "");
              if (path && !runs[path] && (st === "working" || st === "done" || st === "error" || st === "cancelled")) {
                runs[path] = {
                  status: st,
                  filename: typeof d.filename === "string" ? d.filename : void 0,
                  started: typeof d.started === "number" ? d.started : void 0,
                  finished: typeof d.finished === "number" ? d.finished : void 0,
                  error: typeof d.error === "string" ? d.error : void 0,
                  platform: d.platform === "claude" || d.platform === "openai" ? d.platform : void 0,
                  owner: list[i] && typeof list[i].user_id === "string" ? list[i].user_id : void 0
                };
              }
            }
          }
          if (res && res.endOfList === false) {
            if (n < MARKER_SWEEP_MAX_PAGES - 1) return page(true, n + 1);
            partial = true;
          }
          return null;
        });
      }
      var p = page(false, 0).then(function() {
        if (S.projectId !== svc || markerSweep.gen !== gen) return markerSweep;
        markerSweep.svc = svc;
        markerSweep.at = Date.now();
        markerSweep.done = done;
        markerSweep.runs = runs;
        markerSweep.partial = partial;
        return markerSweep;
      });
      markerSweep.inflight = p;
      p.then(function() {
        markerSweep.inflight = null;
      }, function() {
        markerSweep.inflight = null;
      });
      return p;
    }
    function invalidateIndexMarkerSweep() {
      markerSweep.at = 0;
      markerSweep.gen++;
    }
    var STUB_RECHECK_MS = 3e4;
    var STUB_RECHECK_MAX_ROUNDS = 5;
    var stubRecheckTimer = null;
    var stubRecheckSig = "";
    var stubRecheckRounds = 0;
    function armStubRecheck() {
      if (stubRecheckTimer !== null) return;
      stubRecheckTimer = setTimeout(function() {
        stubRecheckTimer = null;
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        stubRecheckRounds++;
        void refreshIndexMarkers();
      }, STUB_RECHECK_MS);
    }
    function maybeArmStubRecheck() {
      try {
        if (markerSweep.svc !== S.projectId) return;
        var lk = session && session.getLiveIndexState().keys || {};
        var sig = [];
        for (var pth in markerSweep.runs) {
          var r = markerSweep.runs[pth];
          if (!r || r.status !== "working" || lk[pth]) continue;
          var fn = r.filename || pth.split("/").pop() || pth;
          if (markerSweep.done[pth] || markerSweep.done[fn]) continue;
          sig.push(pth);
        }
        if (!sig.length) {
          stubRecheckSig = "";
          stubRecheckRounds = 0;
          if (stubRecheckTimer !== null) {
            clearTimeout(stubRecheckTimer);
            stubRecheckTimer = null;
          }
          return;
        }
        var s = sig.sort().join("|");
        if (s !== stubRecheckSig) {
          stubRecheckSig = s;
          stubRecheckRounds = 0;
        }
        if (stubRecheckRounds >= STUB_RECHECK_MAX_ROUNDS) return;
        armStubRecheck();
      } catch (e) {
      }
    }
    function refreshIndexMarkers(invalidate) {
      if (invalidate) invalidateIndexMarkerSweep();
      return sweepIndexMarkersDb().then(function(res) {
        if (res) {
          maybeArmStubRecheck();
          renderMessages();
        }
        return res;
      }).catch(function() {
        renderMessages();
        return null;
      });
    }
    function displayListOptions() {
      var liveIndex = session.getLiveIndexState();
      var fresh = markerSweep.svc === S.projectId;
      var stubs = void 0;
      if (fresh && !isAnonymousSession()) {
        stubs = {};
        var myId = S.user && S.user.user_id || "";
        for (var rp in markerSweep.runs) {
          var rr = markerSweep.runs[rp];
          if (rr && rr.owner && myId && rr.owner !== myId) continue;
          stubs[rp] = {
            status: rr.status,
            filename: rr.filename,
            started: rr.started,
            finished: rr.finished,
            error: rr.error,
            platform: rr.platform,
            owner: rr.owner
          };
        }
      }
      return {
        hasMoreHistory: !CS.historyEndOfList,
        // Older pages coming in RIGHT NOW. CS.historyFilling, not just the
        // per-request flag: the viewport fill is many pages and that flag drops
        // to false between every one of them, which is once per page of flicker
        // on any row rendered off it.
        loadingOlderHistory: !!(CS.loadingOlderHistory || CS.historyFilling),
        liveIndexKeys: liveIndex.keys,
        liveIndexChecked: liveIndex.checked,
        // Runs the user stopped. A stop that landed on a RUNNING pass leaves no
        // cancelled bubble behind (that pass finishes and answers normally), so
        // without this the row reports the stop as a finished "Indexed".
        stoppedIndexIds: session.getStoppedIndexIds(),
        // Durable completion markers + run records (one sweep, see above).
        // doneKeys settle worker-run greens without a queue round trip;
        // runStubs paint rows for runs whose passes are not loaded yet.
        doneKeys: fresh ? markerSweep.done : void 0,
        runStubs: stubs,
        // Records are service-wide and horizon-blind; without this every
        // "Clear chat history" resurrected one row per indexed file.
        stubClearedAt: getClearedAt(),
        // A run:: record is per FILE; a chat is per (project, PLATFORM).
        stubPlatform: S.aiPlatform === "claude" || S.aiPlatform === "openai" ? S.aiPlatform : void 0
      };
    }
    var stopIndexState = { runKey: "", fileKey: "", handle: null };
    function indexGroupStoppable(group) {
      return !!group && !group.stub && !group.finished && !group.resolving && !group.stopped && !group.cancelling;
    }
    function findCancellableIndexGroup(runKey, fileKey) {
      if (!runKey) return null;
      var list = buildChatDisplayList(CS.messages, displayListOptions());
      var byFile = null;
      for (var i = 0; i < list.length; i++) {
        var row = list[i];
        if (row.kind !== "indexing") continue;
        var live = indexGroupStoppable(row.group) ? row.group : null;
        if (row.group.runKey === runKey) return live;
        if (!byFile && live && fileKey && row.group.key === fileKey) byFile = row.group;
      }
      return byFile;
    }
    function stopIndexModalIsOpen() {
      var hnd = stopIndexState.handle;
      if (hnd && hnd.root && hnd.root.parentNode) return true;
      stopIndexState.runKey = "";
      stopIndexState.fileKey = "";
      stopIndexState.handle = null;
      return false;
    }
    function closeStopIndexModal() {
      var hnd = stopIndexState.handle;
      stopIndexState.runKey = "";
      stopIndexState.fileKey = "";
      stopIndexState.handle = null;
      if (hnd) hnd.close();
    }
    function syncStopIndexModal() {
      if (!stopIndexModalIsOpen()) return;
      if (!findCancellableIndexGroup(stopIndexState.runKey, stopIndexState.fileKey)) closeStopIndexModal();
    }
    function openStopIndexModal(group) {
      if (!indexGroupStoppable(group)) return;
      closeStopIndexModal();
      stopIndexState.runKey = group.runKey;
      stopIndexState.fileKey = group.key;
      var name = group.name;
      stopIndexState.handle = openModal(function(close) {
        var stopBtn = h("button", { class: "btn btn--danger", type: "button" }, "Stop indexing");
        stopBtn.addEventListener("click", function() {
          var runKey = stopIndexState.runKey;
          var fileKey = stopIndexState.fileKey;
          closeStopIndexModal();
          var live = findCancellableIndexGroup(runKey, fileKey);
          if (live) session.cancelIndexingGroup(live);
        });
        return h(
          "div",
          { class: "bq-modal" },
          h("button", { class: "bq-modal-close", type: "button", html: "&times;", onclick: close }),
          h("div", { class: "bq-modal-delete-header" }, h("span", { text: "Stop indexing" })),
          // The file name is user data: translate="no" keeps a browser
          // translator from rewriting it (agent.vue tags it the same way).
          h(
            "p",
            { class: "bq-modal-desc" },
            "Stop indexing \u201C",
            h("span", { translate: "no", text: name }),
            "\u201D?"
          ),
          h(
            "p",
            { class: "bq-modal-desc bq-modal-delete-warn" },
            "Whatever has been indexed so far stays searchable, and the pass already running finishes on the server. The remaining passes are dropped, not paused, so the file stays partly indexed until you reindex it."
          ),
          h(
            "div",
            { class: "bq-modal-btns" },
            h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Keep indexing"),
            stopBtn
          )
        );
      });
    }
    function toggleIndexGroup(key) {
      if (CS.indexGroupsOpen[key]) delete CS.indexGroupsOpen[key];
      else {
        CS.indexGroupsOpen[key] = true;
        hydrateCompactIndexGroup(key);
        void loadIndexGroupHistory(key);
      }
      renderMessages();
      ensureHistoryFillsViewport();
    }
    var INDEX_GROUP_FETCH_MAX_PAGES = 40;
    var indexGroupFetching = {};
    function groupNeedsHistory(key) {
      if (CS.historyEndOfList) return false;
      try {
        var entries = buildChatDisplayList(CS.messages, displayListOptions());
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].kind !== "indexing" || entries[i].group.key !== key) continue;
          return !!(entries[i].group.stub || entries[i].group.mayHaveOlder);
        }
      } catch (e) {
      }
      return false;
    }
    function loadIndexGroupHistory(key) {
      if (indexGroupFetching[key]) return Promise.resolve();
      if (!groupNeedsHistory(key)) return Promise.resolve();
      indexGroupFetching[key] = true;
      renderMessages();
      var pages = 0, waits = 0;
      function step() {
        if (!CS.indexGroupsOpen[key]) return null;
        if (!groupNeedsHistory(key)) return null;
        if (pages >= INDEX_GROUP_FETCH_MAX_PAGES) return null;
        if (CS.loadingOlderHistory || CS.historyFilling || session.state.bgHistoryLoading) {
          if (++waits > 240) return null;
          return new Promise(function(r) {
            setTimeout(r, 250);
          }).then(step);
        }
        pages++;
        return fetchOlderHistoryIfNeeded().then(step);
      }
      return Promise.resolve(step()).catch(function() {
      }).then(function() {
        delete indexGroupFetching[key];
        hydrateCompactIndexGroup(key);
        renderMessages();
      });
    }
    function hydrateCompactIndexGroup(key) {
      try {
        var entries = buildChatDisplayList(session.state.messages, displayListOptions());
        for (var i = 0; i < entries.length; i++) {
          var en = entries[i];
          if (en.kind !== "indexing" || en.group.key !== key) continue;
          var ids = [];
          for (var mi = 0; mi < en.group.members.length; mi++) {
            var m = en.group.members[mi].msg;
            if (m && m._compact && m.role === "assistant" && m._serverItemId && !m.isError && !m.isPending) ids.push(m._serverItemId);
          }
          if (ids.length) session.hydrateCompactItems(ids);
          return;
        }
      } catch (e) {
      }
    }
    function buildIndexGroupEl(group, isOpen) {
      var cls = ["bq-index-group"];
      if (group.resolving) cls.push("is-resolving");
      if (!group.resolving && !group.finished && group.status !== "cancelled") cls.push("is-active");
      if (!group.resolving && group.finished && group.status === "done") cls.push("is-indexed");
      if (group.finished && group.status === "error") cls.push("is-error");
      if (isOpen) cls.push("is-open");
      var label = h(
        "span",
        { class: "bq-index-label" },
        h("span", { class: "bq-md", html: parseMsgPartsHtml(indexGroupLabel(group), { imagePreviews: false }) })
      );
      label.addEventListener("click", function(e) {
        if (e.target && e.target.closest && e.target.closest("a")) e.stopPropagation();
        onBubbleLinkClick(e);
      });
      var cancelBtn = null;
      if (indexGroupStoppable(group) || group.cancelling) {
        cancelBtn = h("button", {
          class: "bq-index-cancel" + (group.cancelling ? " is-disabled" : ""),
          type: "button",
          title: group.cancelling ? "Stopping..." : "Stop indexing this file",
          "aria-label": "Stop indexing " + group.name,
          text: group.cancelling ? "Stopping..." : "Stop"
        });
        if (group.cancelling) cancelBtn.disabled = true;
        else cancelBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          openStopIndexModal(group);
        });
        cancelBtn.addEventListener("keydown", function(e) {
          e.stopPropagation();
        });
      }
      var head = h(
        "div",
        {
          class: "bq-index-head",
          role: "button",
          tabindex: "0",
          "aria-expanded": isOpen ? "true" : "false",
          title: isOpen ? "Hide indexing steps" : "Show indexing steps",
          onclick: function() {
            toggleIndexGroup(group.key);
          },
          onkeydown: function(e) {
            if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
            e.preventDefault();
            toggleIndexGroup(group.key);
          }
        },
        h("span", { class: "bq-index-icon", html: indexGroupIcon(group) }),
        label,
        indexGroupCount(group) ? h("span", { class: "bq-index-count", text: indexGroupCount(group) }) : null,
        // Spinning arrows while this row's history is being paged in —
        // separate from the status icon, so a green (done) row spins too.
        indexGroupFetching[group.key] ? h("span", { class: "bq-index-fetch", html: INDEX_ICON_ACTIVE, title: "Fetching this file's indexing history" }) : null,
        cancelBtn,
        h("span", { class: "bq-index-chevron", text: "\u25B6" })
      );
      var el = h("div", { class: cls.join(" ") }, head);
      if (group.cancelError) {
        el.appendChild(h("div", {
          class: "bq-index-note is-error",
          text: "Could not stop this file: " + group.cancelError
        }));
      }
      if (isOpen && indexGroupFetching[group.key]) {
        el.appendChild(h(
          "div",
          { class: "bq-index-note" },
          h("span", { text: "Loading this file's indexing history" }),
          h("span", { class: "bq-loader" })
        ));
      } else if (isOpen && group.mayHaveOlder) {
        var loadingNow = group.resolvingReason === "history" || group.stub && session.state.bgHistoryLoading;
        el.appendChild(h("div", {
          class: "bq-index-note",
          text: "Earlier passes of this file are further back in the conversation. " + (loadingNow ? "Loading them now." : "Scroll up to load them.")
        }));
      } else if (isOpen && !group.visibleMembers.length) {
        el.appendChild(h("div", {
          class: "bq-index-note",
          text: "This file's indexing steps aren't in this chat's history. They may belong to another chat or platform, or the conversation was cleared."
        }));
      }
      return el;
    }
    function greetingParts() {
      return buildChatGreeting({ projectName: S.serviceName, canUpload: !uploadsFrozenForUser() });
    }
    function buildGreetingEl() {
      var parts = greetingParts();
      var name = parts.name ? [document.createTextNode(" "), h("strong", { translate: "no", text: parts.name })] : null;
      var bubble = h("div", { class: "bq-bubble" });
      append(bubble, parts.lead);
      append(bubble, name);
      append(bubble, parts.tail);
      return h("div", { class: "bq-message is-assistant bq-empty-greeting" }, bubble);
    }
    function historyLoadingEl(initial) {
      if (initial) {
        return h(
          "div",
          { class: "bq-history-loading is-initial" },
          bunnyLoader("Fetching history...")
        );
      }
      return h(
        "div",
        { class: "bq-history-loading" },
        h(
          "span",
          { class: "bq-history-loading-inner" },
          h("span", { text: "Fetching history" }),
          h("span", { class: "bq-loader" })
        )
      );
    }
    function rowAnchorKey(msg, index) {
      if (!msg) return null;
      var id = msg._serverItemId || msg._localId;
      return id ? "s" + id + ":" + msg.role : "i" + index;
    }
    function indexGroupAnchorId(group) {
      return group.anchorId || "";
    }
    var chatScrollAnchor = createScrollAnchor({
      getBox: function() {
        return CS.messagesBox;
      },
      isStuck: function() {
        return !!CS.stickToBottom;
      },
      rawFallback: true
    });
    function captureScrollAnchor() {
      return chatScrollAnchor.capture();
    }
    function restoreScrollAnchor(anchor) {
      var box = CS.messagesBox;
      if (!box) return;
      if (CS.stickToBottom) {
        chatScrollAnchor.pinBottom();
        return;
      }
      anchorWroteSinceScroll = true;
      chatScrollAnchor.restore(anchor);
    }
    function syncDraftingIndicator() {
      if (!CS.messagesBox) return;
      if (CS.drafting && !CS.chatSettingsOpen) {
        if (!CS.draftingEl) {
          CS.draftingEl = h(
            "div",
            { class: "bq-message is-user bq-user-drafting", "aria-hidden": "true" },
            h("div", { class: "bq-bubble" }, h("span", { class: "bq-loader" }))
          );
        }
        CS.messagesBox.appendChild(CS.draftingEl);
      } else if (CS.draftingEl && CS.draftingEl.parentNode) {
        CS.draftingEl.parentNode.removeChild(CS.draftingEl);
      }
    }
    function renderMessages() {
      syncStopIndexModal();
      var _lk = session.getLiveIndexState().keys || {};
      var _lc = 0;
      for (var _k in _lk) _lc++;
      if (CS._lastLiveKeyCount > 0 && _lc < CS._lastLiveKeyCount) void refreshIndexMarkers(true);
      CS._lastLiveKeyCount = _lc;
      if (!CS.messagesBox) return;
      if (CS.chatSettingsOpen) return;
      var anchor = captureScrollAnchor();
      clear(CS.messagesBox);
      CS.messageEls = [];
      if (CS.loadingOlderHistory) CS.messagesBox.appendChild(historyLoadingEl(false));
      else if (session.state.bgHistoryLoading) {
        CS.messagesBox.appendChild(h(
          "div",
          { class: "bq-history-loading" },
          h(
            "span",
            { class: "bq-history-loading-inner" },
            h("span", { text: "Loading indexing history" }),
            h("span", { class: "bq-loader" })
          )
        ));
      }
      CS.messagesBox.appendChild(buildGreetingEl());
      if (!CS.messages.length) {
        if (CS.loadingHistory && !CS.loadingOlderHistory) {
          CS.messagesBox.appendChild(historyLoadingEl(true));
          syncDraftingIndicator();
          restoreScrollAnchor(anchor);
          return;
        }
        var emptyStubEls = [];
        try {
          var emptyEntries = buildChatDisplayList([], displayListOptions());
          for (var ge = 0; ge < emptyEntries.length; ge++) {
            if (emptyEntries[ge].kind !== "indexing") continue;
            var sg = emptyEntries[ge].group;
            var stubEl = buildIndexGroupEl(sg, !!CS.indexGroupsOpen[sg.key]);
            stubEl.setAttribute("data-row-key", "g" + sg.runKey);
            stubEl.setAttribute("data-row-pos", indexGroupAnchorId(sg));
            emptyStubEls.push(stubEl);
          }
        } catch (e) {
        }
        for (var gse = 0; gse < emptyStubEls.length; gse++) CS.messagesBox.appendChild(emptyStubEls[gse]);
        syncDraftingIndicator();
        restoreScrollAnchor(anchor);
        return;
      }
      var rows = buildChatDisplayList(CS.messages, displayListOptions());
      try {
        if (markerSweep.svc === S.projectId) {
          var moSeen = S._mintObserved || (S._mintObserved = {});
          for (var moi = 0; moi < rows.length; moi++) {
            var moe = rows[moi];
            if (moe.kind !== "indexing" || moe.group.stub) continue;
            var mog = moe.group;
            if (!mog.path || !mog.finished || mog.status !== "done" || mog.resolving) continue;
            if (!(mog.driver === "single" || markerSweep.done[mog.path])) continue;
            var morec = markerSweep.runs[mog.path];
            if ((!morec || morec.status === "working") && !moSeen[mog.path]) {
              moSeen[mog.path] = true;
              var moFirst = mog.members && mog.members[0] && mog.members[0].msg && mog.members[0].msg._ts;
              var moLast = mog.members && mog.members.length && mog.members[mog.members.length - 1].msg && mog.members[mog.members.length - 1].msg._ts;
              var moPatch = { status: "done", finished: typeof moLast === "number" ? moLast : Date.now() };
              if (typeof moFirst === "number") moPatch.started = moFirst;
              if (mog.name) moPatch.filename = mog.name;
              void upsertIndexRunRecordDb(S.projectId, mog.path, moPatch);
              if (morec) morec.status = "done";
              else markerSweep.runs[mog.path] = { status: "done" };
            }
          }
        }
      } catch (e) {
      }
      rows.forEach(function(row) {
        if (row.kind === "indexing") {
          var isOpen = !!CS.indexGroupsOpen[row.group.key];
          var groupEl = buildIndexGroupEl(row.group, isOpen);
          groupEl.setAttribute("data-row-key", "g" + row.group.runKey);
          groupEl.setAttribute("data-row-pos", indexGroupAnchorId(row.group));
          CS.messagesBox.appendChild(groupEl);
          if (!isOpen) return;
          row.group.visibleMembers.forEach(function(member) {
            var pass = buildMessageEl(member.msg, member.index);
            pass.classList.add("bq-index-pass");
            pass.setAttribute("data-row-key", rowAnchorKey(member.msg, member.index));
            CS.messageEls[member.index] = pass;
            CS.messagesBox.appendChild(pass);
          });
          if (!row.group.finished && !row.group.resolving && row.group.status !== "cancelled") {
            CS.messagesBox.appendChild(h("div", {
              class: "bq-index-pass bq-index-tail",
              "aria-hidden": "true"
            }, h("span", { class: "bq-loader" })));
          }
          return;
        }
        var el = buildMessageEl(row.msg, row.index);
        el.setAttribute("data-row-key", rowAnchorKey(row.msg, row.index));
        CS.messageEls[row.index] = el;
        CS.messagesBox.appendChild(el);
      });
      syncDraftingIndicator();
      hydrateMessageImagePreviews();
      restoreScrollAnchor(anchor);
    }
    function refreshMessageBubble(idx) {
      if (idx < 0 || idx >= CS.messages.length) return;
      var oldEl = CS.messageEls[idx];
      if (!oldEl || !oldEl.parentNode) return;
      anchorWroteSinceScroll = true;
      chatScrollAnchor.preserve(function() {
        var newEl = buildMessageEl(CS.messages[idx], idx);
        if (oldEl.classList.contains("bq-index-pass")) newEl.classList.add("bq-index-pass");
        oldEl.parentNode.replaceChild(newEl, oldEl);
        CS.messageEls[idx] = newEl;
        hydrateMessageImagePreviews();
      });
    }
    function renderChat() {
      primeProjectSettings(S.projectId);
      clearImagePreviewCache(S.projectId || "default");
      chatScrollAnchor.forget();
      for (var uk in unavailableLinkMap) delete unavailableLinkMap[uk];
      CS.messages = [];
      CS.messageEls = [];
      CS.indexGroupsOpen = {};
      CS.sending = false;
      CS.typing = false;
      CS.typingAbort = true;
      CS.drafting = false;
      CS.draftingEl = null;
      CS.historyEndOfList = false;
      CS.historyStartKeyHistory = [];
      CS.stickToBottom = true;
      CS.attachments = [];
      CS.uploadingAttachments = false;
      CS.attachmentWarning = "";
      CS.attachmentCapNotice = "";
      CS.attachmentsRow = null;
      CS.attachBtnEl = null;
      CS.sendBtnEl = null;
      CS.inputEl = null;
      CS.chatEl = null;
      CS.visibleAttachmentCount = Infinity;
      CS.chatSettingsOpen = false;
      CS.settingsBtnEl = null;
      CS.composerEl = null;
      CS.gateRefreshToken += 1;
      if (CS.pollTimer) {
        clearInterval(CS.pollTimer);
        CS.pollTimer = null;
      }
      render("chat", function() {
        var settingsBtn = h("button", {
          class: "bq-icon-btn",
          type: "button",
          title: "Settings",
          "aria-label": "Settings",
          html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
          onclick: function() {
            toggleChatSettings();
          }
        });
        CS.settingsBtnEl = settingsBtn;
        var headerRight = isAnonymousSession() ? h("button", {
          class: "bq-link",
          type: "button",
          title: "Login",
          onclick: function() {
            renderLogin();
          },
          text: "Login"
        }) : settingsBtn;
        if (isAnonymousSession()) CS.settingsBtnEl = null;
        var header = h(
          "div",
          { class: "bq-section-title" },
          h(
            "div",
            { class: "bq-title-row" },
            brandTitleEl(),
            h("div", { class: "bq-title-right" }, headerRight)
          )
        );
        var chatArea;
        if (S.aiPlatform === "none") {
          chatArea = h(
            "div",
            { class: "bq-chat" },
            h(
              "div",
              { class: "bq-disabled-overlay" },
              h(
                "div",
                { class: "bq-disabled-inner" },
                h("div", { text: "This chat isn't available yet \u2014 the project admin hasn't set up an AI agent." })
              )
            )
          );
          return h("div", { class: "bq-meta" }, header, chatArea);
        }
        var box = h("div", { class: "bq-messages" });
        box.addEventListener("scroll", onHistoryScroll, { passive: true });
        box.addEventListener("wheel", onMessagesWheel, { passive: true });
        box.addEventListener("touchstart", onMessagesTouchStart, { passive: true });
        box.addEventListener("touchmove", onMessagesTouchMove, { passive: true });
        box.addEventListener("load", onMessagesImageSettled, true);
        box.addEventListener("error", onMessagesImageSettled, true);
        if (document.fonts && document.fonts.addEventListener) {
          document.fonts.addEventListener("loadingdone", onMessagesFontsSettled);
        }
        CS.messagesBox = box;
        var input = h("textarea", { class: "bq-input", rows: "1", placeholder: "Ask anything about: " + (S.serviceName || "your project") });
        CS.inputEl = input;
        var composing = false;
        input.addEventListener("compositionstart", function() {
          composing = true;
        });
        input.addEventListener("compositionend", function() {
          composing = false;
        });
        input.addEventListener("input", function() {
          autoGrowInput(input);
          var prev = CS.attachmentWarning;
          recomputeAttachmentWarning();
          updateComposerControls();
          if (CS.attachmentWarning !== prev) {
            renderAttachmentChips();
            scheduleAttachmentOverflowRecompute();
          }
          var drafting = !!input.value.trim();
          if (drafting !== CS.drafting) {
            CS.drafting = drafting;
            syncDraftingIndicator();
            scrollToBottomIfSticky();
          }
        });
        input.addEventListener("keydown", function(e) {
          if (e.key === "Enter" && !e.shiftKey && !composing) {
            e.preventDefault();
            sendMessage();
          }
        });
        requestAnimationFrame(function() {
          autoGrowInput(input);
        });
        var attachDisabled = uploadsFrozenForUser();
        if (attachDisabled) input.classList.add("bq-input--noattach");
        var attachFileInput = null, attachBtn = null;
        if (!attachDisabled) {
          attachFileInput = h("input", { class: "bq-attach-input", type: "file", multiple: "multiple" });
          attachFileInput.addEventListener("change", function() {
            onAttachInputChange(attachFileInput);
          });
          attachBtn = h("button", { class: "bq-attach-btn", type: "button", title: "Attach files", html: ATTACH_ICON_SVG });
          attachBtn.addEventListener("click", function() {
            attachFileInput.click();
          });
          CS.attachBtnEl = attachBtn;
        }
        var attachmentsRow = h("div", { class: "bq-attachments" });
        attachmentsRow.style.display = "none";
        CS.attachmentsRow = attachmentsRow;
        var sendBtn = h("button", { class: "btn", type: "submit" }, "Send");
        CS.sendBtnEl = sendBtn;
        var composer = h(
          "form",
          { class: "bq-input-row", onsubmit: function(e) {
            e.preventDefault();
            sendMessage();
          } },
          attachmentsRow,
          h("div", { class: "bq-input-wrap" }, attachBtn, attachFileInput, input),
          sendBtn
        );
        chatArea = h("div", { class: "bq-chat" }, box, composer);
        CS.chatEl = chatArea;
        CS.composerEl = composer;
        updateComposerControls();
        if (!attachDisabled) setupDragAndDrop(chatArea);
        return h("div", { class: "bq-meta" }, header, chatArea);
      });
      if (S.aiPlatform === "none") return;
      void refreshIndexMarkers();
      loadMarked().then(function() {
        renderMessages();
        return session.loadHistory(false, CS.gateRefreshToken);
      }).then(function() {
      });
    }
    function openModal(builder, opts) {
      var dismissible = !(opts && opts.dismissible === false);
      var root = h("div", { class: "bq-modal-root", "data-bq-theme": S.theme });
      var backdrop = h("div", { class: "bq-modal-backdrop" });
      var close = function() {
        if (root.parentNode) root.parentNode.removeChild(root);
      };
      if (dismissible) backdrop.addEventListener("click", close);
      root.appendChild(backdrop);
      root.appendChild(builder(close));
      document.body.appendChild(root);
      return { root, close };
    }
    var overwriteState = { resolver: null, sticky: null, handle: null, applyToAll: false };
    function resetOverwriteBatch() {
      overwriteState.sticky = null;
      overwriteState.applyToAll = false;
    }
    function chooseOverwrite(choice) {
      if (overwriteState.applyToAll) overwriteState.sticky = choice;
      if (overwriteState.handle) {
        overwriteState.handle.close();
        overwriteState.handle = null;
      }
      var r = overwriteState.resolver;
      overwriteState.resolver = null;
      if (r) r(choice);
    }
    var accessGroupState = { resolver: null, sticky: null, handle: null, applyToAll: false, choice: "authorized", perPath: {} };
    function resetAccessGroupBatch() {
      accessGroupState.sticky = null;
      accessGroupState.applyToAll = false;
      accessGroupState.perPath = {};
    }
    function chooseAccessGroup(choice) {
      var picked = normalizeUploadAccessGroup(choice);
      if (accessGroupState.applyToAll) accessGroupState.sticky = picked;
      if (accessGroupState.handle) {
        accessGroupState.handle.close();
        accessGroupState.handle = null;
      }
      var r = accessGroupState.resolver;
      accessGroupState.resolver = null;
      if (r) r(picked);
    }
    var accessGroupChain = Promise.resolve();
    function resolveUploadAccessGroup(storagePath) {
      return readyProjectSettings(S.projectId).then(function() {
        return decideUploadAccessGroup(storagePath);
      });
    }
    function decideUploadAccessGroup(storagePath) {
      var svc = S.projectId;
      if (!projectAsksUploadAccess(svc)) return Promise.resolve(projectUploadAccessGroup(svc));
      var fallback = projectUploadAccessGroup(svc);
      if (accessGroupState.sticky) return Promise.resolve(accessGroupState.sticky);
      var pathKey = String(storagePath || "");
      if (pathKey && accessGroupState.perPath[pathKey]) {
        return Promise.resolve(accessGroupState.perPath[pathKey]);
      }
      var run = accessGroupChain.then(function() {
        if (accessGroupState.sticky) return accessGroupState.sticky;
        if (pathKey && accessGroupState.perPath[pathKey]) {
          return accessGroupState.perPath[pathKey];
        }
        accessGroupState.applyToAll = false;
        accessGroupState.choice = fallback;
        var filename = String(storagePath || "").split("/").pop() || "this file";
        return new Promise(function(resolve) {
          accessGroupState.resolver = resolve;
          accessGroupState.handle = openModal(function() {
            var list = h("div", { class: "bq-access-options" });
            UPLOAD_ACCESS_GROUPS.forEach(function(g) {
              var input = h("input", { type: "radio", name: "bq-access-group", value: g });
              input.checked = g === accessGroupState.choice;
              input.addEventListener("change", function() {
                if (input.checked) accessGroupState.choice = g;
              });
              list.appendChild(h(
                "label",
                { class: "bq-access-option" },
                input,
                h("span", { class: "bq-access-option-label", text: UPLOAD_ACCESS_LABELS[g] }),
                h("span", { class: "bq-access-option-hint", text: UPLOAD_ACCESS_HINTS[g] })
              ));
            });
            var applyCb = h("input", { type: "checkbox" });
            applyCb.addEventListener("change", function() {
              accessGroupState.applyToAll = !!applyCb.checked;
            });
            var applyLabel = h(
              "label",
              { class: "bq-overwrite-applyall" },
              applyCb,
              h("span", { text: "Apply to all remaining files" })
            );
            return h(
              "div",
              { class: "bq-modal" },
              h("div", { class: "bq-modal-delete-header" }, h("span", { text: "Who can read this file?" })),
              h(
                "p",
                { class: "bq-modal-desc" },
                "Choose who can ask questions about \u201C" + filename + "\u201D once it is indexed."
              ),
              list,
              applyLabel,
              h(
                "div",
                { class: "bq-modal-btns" },
                h("button", { class: "btn", type: "button", onclick: function() {
                  chooseAccessGroup(accessGroupState.choice);
                } }, "Upload")
              )
            );
          }, { dismissible: false });
        });
      });
      accessGroupChain = run.catch(function() {
        return void 0;
      });
      return run.then(function(picked) {
        var g = normalizeUploadAccessGroup(picked);
        if (pathKey) accessGroupState.perPath[pathKey] = g;
        return g;
      }).catch(function() {
        return fallback;
      });
    }
    function promptOverwrite(filename) {
      if (overwriteState.sticky) return Promise.resolve(overwriteState.sticky);
      overwriteState.applyToAll = false;
      return new Promise(function(resolve) {
        overwriteState.resolver = resolve;
        overwriteState.handle = openModal(function() {
          var applyCb = h("input", { type: "checkbox" });
          applyCb.addEventListener("change", function() {
            overwriteState.applyToAll = !!applyCb.checked;
          });
          var applyLabel = h(
            "label",
            { class: "bq-overwrite-applyall" },
            applyCb,
            h("span", { text: "Apply to all remaining files" })
          );
          return h(
            "div",
            { class: "bq-modal" },
            h("div", { class: "bq-modal-delete-header" }, h("span", { text: "File already exists" })),
            h(
              "p",
              { class: "bq-modal-desc" },
              "A file named \u201C" + filename + "\u201D already exists. Skip it, keep the existing file and just reindex it, or overwrite it completely?"
            ),
            applyLabel,
            h(
              "div",
              { class: "bq-modal-btns" },
              h("button", { class: "btn btn--outline", type: "button", onclick: function() {
                chooseOverwrite("skip");
              } }, "Skip"),
              h("button", { class: "btn btn--outline", type: "button", onclick: function() {
                chooseOverwrite("reindex");
              } }, "Reindex only"),
              h("button", { class: "btn btn--danger", type: "button", onclick: function() {
                chooseOverwrite("overwrite");
              } }, "Overwrite")
            )
          );
        }, { dismissible: false });
      });
    }
    function showUploadErrorReport(groups) {
      if (!groups || !groups.length) return;
      var totalFiles = groups.reduce(function(n, g) {
        return n + g.files.length;
      }, 0);
      openModal(function(close) {
        var sections = groups.map(function(g) {
          var heading = g.code ? g.code + " \u2014 " + g.message : g.message;
          return h(
            "div",
            { class: "bq-upload-error-group" },
            h("p", { class: "bq-upload-error-heading", text: heading }),
            h(
              "ul",
              { class: "bq-upload-error-files" },
              g.files.map(function(name) {
                return h("li", { text: name });
              })
            )
          );
        });
        return h(
          "div",
          { class: "bq-modal" },
          h(
            "div",
            { class: "bq-modal-delete-header" },
            h("span", { text: totalFiles === 1 ? "1 file could not be added" : totalFiles + " files could not be added" })
          ),
          h("p", { class: "bq-modal-desc", text: "These files were not added to your message. They stay in the attachment row so you can remove or retry them." }),
          h("div", { class: "bq-upload-error-list" }, sections),
          h(
            "div",
            { class: "bq-modal-btns" },
            h("button", { class: "btn btn--outline", type: "button", onclick: close }, "Close")
          )
        );
      });
    }
    function parseAiAgentValue2(value) {
      var raw = (value || "").trim();
      var platform = raw, model = "";
      if (raw.indexOf("#") !== -1) {
        var parts = raw.split("#");
        platform = parts[0];
        model = parts[1] || "";
      }
      var normalized = platform === "claude" || platform === "openai" ? platform : "none";
      return { raw, platform: normalized, model, hasPlatform: normalized !== "none" };
    }
    function applyAgentConfig() {
      var conn = S.service || {};
      var raw = conn.ai_agent || "";
      var parsed = parseAiAgentValue2(raw);
      S.aiPlatform = parsed.platform;
      S.aiModel = parsed.model;
      setProjectContextWindow(S.projectId, parseAiAgentValue(raw).contextWindow);
      S.serviceName = conn.service_name || "";
      S.serviceDescription = conn.service_description || "";
    }
    function logout() {
      showLoading();
      clearStoredMcpToken();
      Promise.resolve().then(function() {
        return S.skapi.logout();
      }).catch(function() {
      }).then(function() {
        S.user = null;
        if (anonymousAllowed()) return enterAfterLogin();
        renderLogin();
      });
    }
    function enterAfterLogin() {
      showLoading();
      return Promise.resolve().then(function() {
        return S.user ? S.user : getProfile().then(function(u) {
          S.user = u;
          return u;
        });
      }).then(function() {
        return loadServiceInfo();
      }).then(function(conn) {
        if (conn) S.service = conn;
        applyAgentConfig();
      }).then(function() {
        renderChat();
      }).catch(function(err) {
        console.error("[bunnyquery] enterAfterLogin failed", err);
        renderChat();
      });
    }
    function boot() {
      showLoading();
      return loadServiceInfo().then(function(conn) {
        if (conn) {
          S.service = conn;
          applyAgentConfig();
        }
      }).catch(function() {
      }).then(bootFlow);
    }
    function bootFlow() {
      if (isInboundPlatformOAuth()) {
        stashInboundPlatformOAuth();
        return getProfile().then(function(user) {
          S.user = user;
          if (user) {
            returnOAuthToMCP();
            return;
          }
          renderLogin();
        });
      }
      if (isGoogleOAuthReturn()) {
        return completeGoogleOAuthReturn().then(function() {
          var st = getQueryParam("state");
          if (st && ssGet("oauth:" + st)) {
            returnOAuthToMCP();
            return;
          }
          cleanUrl();
          return beginMcpOAuthOnLogin("chat");
        }).catch(function(err) {
          console.error("[bunnyquery] Google OAuth return failed", err);
          cleanUrl();
          renderLogin();
        });
      }
      if (isMcpOAuthCallback()) {
        return completeMcpAuthorize().then(function() {
          cleanUrl();
          return enterAfterLogin();
        }).catch(function(err) {
          console.error("[bunnyquery] MCP OAuth token exchange failed", err);
          cleanUrl();
          return enterAfterLogin();
        });
      }
      if (getQueryParam("code") || getQueryParam("oauth")) cleanUrl();
      return getProfile().then(function(user) {
        S.user = user;
        if (!user) {
          if (anonymousAllowed()) return enterAfterLogin();
          renderLogin();
          return;
        }
        if (mcpGrantNeedsRefresh(user)) {
          return refreshMcpToken().then(function(tok) {
            if (tok && !mcpGrantNeedsRefresh(user)) return enterAfterLogin();
            return beginMcpOAuthOnLogin("chat").catch(function(err) {
              console.error("[bunnyquery] MCP refresh failed", err);
              return enterAfterLogin();
            });
          });
        }
        return enterAfterLogin();
      });
    }
    function init(skapi, target, opts) {
      if (S.booted) {
        console.warn("[bunnyquery] already initialised");
        return PUBLIC;
      }
      if (!skapi) throw new Error("BunnyQuery.init: a Skapi instance is required");
      var mountEl = typeof target === "string" ? document.getElementById(target) : target;
      if (!mountEl) throw new Error("BunnyQuery.init: mount element not found: " + target);
      S.skapi = skapi;
      S.opts = Object.assign({
        theme: "light",
        signup: false,
        // include signup (and thus delete/recover account)
        dev: false,
        // use the MCP dev host (mcp-dev.broadwayinc.computer)
        mcpBaseUrl: null,
        // override the MCP OAuth server base entirely
        googleClientId: null,
        googleClientSecretName: "ggl",
        signupConfirmationUrl: null,
        // defaults to current host page
        hostDomain: null,
        // db-CDN host; null → skapi.app (dev) / skapi.com (prod)
        attachmentParsers: null,
        // client-side attachment parsers, e.g. [createHwpParser()]
        // Open the chat with no login for visitors without an account.
        // null → follow the project's own "Allow anonymous users" setting
        // (getConnectionInfo().conf.require_login); true/false pins it.
        allowAnonymous: null,
        // Server-driven windowed indexing; read at configureChatEngine time.
        // Listed here so the defaults object is the full opt surface.
        windowedIndexing: true,
        // Live streaming of chat turns; read at configureChatEngine time.
        // OFF until the region's polling worker relays the response bytes:
        // see the configureChatEngine call for what goes wrong without it.
        // A REQUEST, not a switch: it is also refused (with a warning, falling
        // back to buffered) when the embedder's own skapi-js is too old to
        // carry skapi's half of the stream flag. See skapiSupportsStreaming.
        liveStreaming: false,
        // Socket delivery for the streamed reply. OFF unless the embedder asks,
        // and separately from liveStreaming, because this widget runs on someone
        // else's page with someone else's skapi instance: skapi's joinRealtime
        // REPLACES the connection's group rather than adding to it, so for the
        // length of a turn this would take the room out from under whatever the
        // host app uses realtime for, and the host would see its own messages
        // simply stop. Only an embedder who knows their app does not use realtime
        // (or does not mind) can answer that, so only they can turn it on. It is
        // purely an accelerator: with it off the reply still streams, just on the
        // poll's cadence rather than as the text is relayed.
        liveStreamingRealtime: false
      }, opts || {});
      S.mountEl = mountEl;
      clear(mountEl);
      S.root = h("div", { class: "bq-agent" });
      mountEl.appendChild(S.root);
      applyTheme(loadTheme());
      S.booted = true;
      console.log("[bunnyquery] v" + BQ_VERSION);
      var canStream = skapiSupportsStreaming(S.skapi);
      var liveStreaming = S.opts.liveStreaming === true;
      if (liveStreaming && !canStream) {
        liveStreaming = false;
        console.warn(
          "[bunnyquery] liveStreaming was requested but this page's skapi-js has no clientSecretRequestStream/clientSecretRequestFinalize, so skapi's half of the stream flag would be dropped and every reply would read back empty. Falling back to buffered replies - update skapi-js to enable streaming."
        );
      }
      configureProjectSettings(function(service) {
        if (!S.skapi || typeof S.skapi.getRecords !== "function") return Promise.resolve(null);
        return Promise.resolve(S.skapi.getRecords({ service, unique_id: PROJECT_SETTINGS_UNIQUE_ID })).then(function(res) {
          var rec = res && res.list && res.list[0] || null;
          return rec && rec.data || null;
        });
      });
      configureChatEngine({
        clientSecretRequest: function(o) {
          return S.skapi.clientSecretRequest(o);
        },
        clientSecretRequestHistory: function(p, f) {
          return S.skapi.clientSecretRequestHistory(p, f);
        },
        // Single-item csr-poll point lookup: how the engine hydrates a
        // compact history stub's real body when an indexing row expands.
        csrHistoryItemLookup: function(fullId, service, owner) {
          return S.skapi.util.request("csr-poll", { id: fullId, service, owner }, { auth: true });
        },
        // Durable index markers. Both read S lazily at call time — S.skapi /
        // S.projectId are not set yet when init() runs.
        mintIndexDoneMarker: function(info) {
          void mintIndexDoneMarkerDb(info.service, info.storagePath);
        },
        upsertIndexRunRecord: function(info) {
          void upsertIndexRunRecordDb(info.service, info.storagePath, info.patch);
        },
        mcpBaseUrl: mcpBaseUrl(),
        poll: 0,
        // Server-driven windowed indexing. Off by default in the engine because the
        // worker must strip `_skapi_window` first, or the provider rejects the whole
        // call with no retry. `apply_file_windows` is deployed in every region
        // (verified 2026-07-27 against the deployed ClientSecretKeyPollingWorker in
        // all 7), so the widget now opts in like agent.vue does. Without it the
        // widget fell back to the client-driven CONTINUE loop capped at
        // MAX_INDEXING_RESUME_PASSES, which needs the tab kept open and stops early
        // on a big file. Pass windowedIndexing: false in init opts to opt back out.
        windowedIndexing: S.opts.windowedIndexing !== false,
        // Client-side attachment parsers (e.g. an .hwp parser) passed via init opts.
        attachmentParsers: S.opts.attachmentParsers || void 0,
        // ---- live streaming (mirrored in agent.vue's ai_agent.ts) --------
        // Off by default, and for the same shipping-order reason
        // windowedIndexing had one: THE RELAYING POLLING WORKER MUST SHIP
        // FIRST. With this on against a region whose worker does not relay,
        // the request either has its `since` cursor rejected or the row keeps
        // an SSE transcript where the readers expect a parsed document, and
        // the turn reads back as an empty answer. A streamed row settles with
        // a STATUS AND NO BODY on purpose, so there is no fallback to read.
        // Flip it per environment once the worker is deployed there; the
        // widget takes it as an init opt because an embed picks its own
        // region, where agent.vue flips one module constant.
        // It also needs a skapi-js that supports `stream`/`onStream`, and the
        // page's pin is the EMBEDDER's, so the request is granted above by
        // skapiSupportsStreaming rather than taken on trust here.
        liveStreaming,
        // Requires liveStreaming, and cannot outlive it: the AND is what stops an
        // embedder turning on socket delivery for a reply that is not streamed.
        liveStreamingRealtime: liveStreaming && S.opts.liveStreamingRealtime === true,
        // What stores the version of a streamed turn that history keeps. The
        // engine sends the ASSEMBLED provider body, so a streamed turn reads
        // back through exactly the extractors a buffered one does, with no
        // branch in the mapper; storing is also what releases the chunks.
        // Called only for a streamed turn, and best-effort inside the engine.
        // Handed over only when the SDK actually has it, so the engine's own
        // "is this host able to?" checks answer honestly instead of a call
        // reaching an undefined method mid-turn.
        clientSecretRequestFinalize: canStream ? function(requestId, data, options) {
          return S.skapi.clientSecretRequestFinalize(requestId, data, options);
        } : void 0,
        // THE SECOND HALF OF THE DURABILITY GUARANTEE. A streamed row settles
        // with a status and NO body: the answer is chunks until finalize copies
        // a version onto the row. A row that settles while no poll is attached
        // (the tab was closed, a mobile browser discarded it, the device slept
        // and the interval stopped) is therefore never finalized, and without
        // this hook the engine has no way back to it - the answer reads as gone
        // from the conversation with every byte of it still stored. Given the
        // request id this drains that turn's chunks in one pass, and the engine
        // parses them exactly as it parses a live stream, finalizing what it
        // read so the row becomes ordinary history and is never re-read.
        clientSecretRequestStream: canStream ? function(requestId, options) {
          return S.skapi.clientSecretRequestStream(requestId, options);
        } : void 0
      });
      if (!S._resizeBound && typeof window !== "undefined" && window.addEventListener) {
        S._resizeBound = true;
        window.addEventListener("resize", function() {
          scheduleAttachmentOverflowRecompute();
          scrollToBottomIfSticky();
          ensureHistoryFillsViewport();
        });
      }
      if (!S._visBound && typeof document !== "undefined" && document.addEventListener) {
        S._visBound = true;
        document.addEventListener("visibilitychange", function() {
          if (document.visibilityState === "hidden") {
            if (session && session.pausePolling) session.pausePolling("hidden");
            return;
          }
          if (document.visibilityState === "visible") {
            var refreshed = S.user ? ensureMcpGrantFresh() : null;
            Promise.resolve(refreshed).catch(function() {
            }).then(function() {
              if (session && session.resumePolling) session.resumePolling("hidden");
            });
          }
        });
      }
      boot();
      return PUBLIC;
    }
    var PUBLIC = {
      init,
      // Register a client-side attachment parser (e.g. createHwpParser()) so the
      // widget parses matching uploads in-browser and sends the text for indexing.
      // Can be called before or after init(); also settable via init opts.attachmentParsers.
      registerAttachmentParser,
      setTheme: function(t) {
        applyTheme(t);
      },
      toggleTheme,
      logout,
      version: BQ_VERSION,
      _state: S
      // exposed for later-phase modules / debugging
    };
    if (typeof window !== "undefined") {
      window.BunnyQuery = PUBLIC;
    }
  })();

})();
