// src/engine/attachment_parsers.ts
var MAX_PARSED_CONTENT_CHARS = 2e5;
var _parsers = [];
function registerAttachmentParser(parser) {
  if (parser && typeof parser.match === "function" && typeof parser.parse === "function" && _parsers.indexOf(parser) === -1) {
    _parsers.push(parser);
  }
}
function clearAttachmentParsers() {
  _parsers.length = 0;
}
function getAttachmentParsers() {
  return _parsers.slice();
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
var isOfficeFile = isServerExtractable;
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
  const inlineExtracted = opts?.inlineExtractedContent !== false;
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
    const extractFiles = inlineExtracted ? attachmentUrls.filter((u) => isServerExtractable(u.name)) : [];
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
  const { projectId, serviceName, serviceDescription, greeting, canUpload, client } = params;
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
Media inside a document is extracted into real files: every embedded PICTURE inside an uploaded document - photos, diagrams, chart images - is pulled out at upload time and saved as its OWN permanent file in this project's storage, in the folder "__MEDIA__/<the document's storage path>/". Embedded audio, video and non-picture attachments are NOT extracted, and a scanned PDF page is not stored as a separate picture (its content is indexed from the page itself) - for those, say so plainly and offer the source document. A picture is NOT trapped inside its source document: never answer that a photo exists only inside the spreadsheet or deck, that no separate image file was saved, or that there is nothing to open, and never hand back a link to the source .xlsx or .pdf when the user asked for a picture inside it.
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
Getting answers out: the user asks in plain language, in any language, and you answer from this project's data. You can also produce reports and downloadable files (CSV and the rest) as described in the File generation rules above, and any stored file can be handed back as a link, with images rendering inline in the chat.${client === "console" ? `
Where things are in the BunnyQuery console (this user is in it, at bunnyquery.com): the left nav has "Query" (this chat), "Files" (browse this project's stored files, upload more, and see which are indexed), "Collaborators" (invite teammates or clients so they can ask questions themselves) and "Settings" (the AI platform, model and API key, the project's description / base prompt, which is added to your instructions, and the Freeze Database switch that blocks writes). Plans and billing live on the project's Subscription page - send the user there rather than quoting prices, which you do not know.` : ""}${client === "widget" ? `
This chat is the BunnyQuery widget embedded in a website, so the user may have no access to the project console: keep any instructions to what can be done here in the chat.` : ""}`;
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
- TABULAR data (any spreadsheet - .csv/.tsv/.xlsx/.xls/.ods, or sheet-like rows): you MUST save EVERY data row as its own record (ONE record per row) with that row's actual column values in the record's "data", keyed by the header names, in a table named EXACTLY "spreadsheet_rows". Do NOT summarize, sample only a few rows, or save just file metadata - index the whole sheet, window by window, until it ends. Make MULTIPLE postRecords calls in batches (e.g. 30-50 rows per call) rather than one oversized call. This per-row completeness OVERRIDES brevity. The file-level "src::" record ALREADY EXISTS - the upload pipeline creates it before indexing starts - so do NOT create it. Link EVERY per-row record to it via reference (set each row record's reference to exactly "src::" + the storage path, with NO sheet/window/summary suffix added; the row records themselves do NOT carry a src:: unique_id). Enrich that same record with sheet name(s), column headers and total row count via updateRecords rather than posting another one. The per-row records AND this reference linkage are BOTH mandatory: the linkage is what lets the whole sheet be found and cleaned up together when the file is re-indexed. INDEX each row record on the row's most useful NUMERIC column (named by its header) so rows sort and range-query; when the row has no numeric column, index the grid row number instead. TAG each row record with the sheet name, the file name, and the row's categorical values (a status, a category, a type) - tags are how rows are filtered without scanning the table.
- ONE RECORD PER GRID ROW, ALWAYS. "Row" means the numbered row of the sheet (R37 is one record), never a visual block, item, section or left/right pair. Sheets that repeat the same columns side by side (an A/B block beside a C/D block, "paired" or "mirrored" layouts) still get ONE record per grid row, holding BOTH sides - suffix the keys to keep them apart (PART_NO_A / PART_NO_B). Collapsing a 16-row window into 2 or 3 "block" records is the single most damaging mistake here: it silently loses most of the cells and makes every later total wrong, because some windows were counted per row and others per block. If a window shows rows R37 to R52, you save records for R37..R52 and the count you report is the number of grid rows you actually wrote.
- THE FILE NAME AND ITS FOLDERS ARE EVIDENCE ABOUT WHAT THE DATA MEANS, and often the only evidence there is. A grid of bare figures filed under "2026/Q2/royalties" is a quarterly royalty settlement; the same grid under "inspections/KCG-B507" is one aircraft's inspection. Nothing inside the sheet says so. Read the trail in the metadata block and use it: name the period, the entity, the counterparty or the subject in the file record's description, and TAG the records with the meaningful parts of it (the client, the aircraft, the quarter, the site), so a later question about that entity finds this file at all. A folder that is only an id or a date is still worth a tag; a folder like "uploads", "new" or "temp" is not.
- BUT NEVER INSTEAD OF READING. The path tells you what the data is ABOUT; only the content tells you what it SAYS. Never infer a value, a column meaning, a row count or a total from a name, never let a name override what the cells actually contain, and never derive a TABLE name from a folder or a file name - table names are fixed (see below), and a table named after a folder scatters one kind of record across as many tables as the user has folders. Where the name and the content disagree, the content wins and the disagreement is worth recording.
- FIXED TABLE NAMES. Never invent a table name for one pass, and never vary the name between passes of the SAME file: that scatters one file's data across tables nobody can enumerate later, so the data is effectively lost even though every save succeeded. Use exactly "spreadsheet_rows" for spreadsheet row records, "book_chapters" for a chapter record, and "file_summaries" for the file-level record (which already exists, so update it and never post it). Embedded photos and other embedded files get NO table of your choosing: their records already exist in table "__MEDIA__", see EXTRACTED MEDIA below. For a content type none of those fit, choose ONE plain descriptive name, use that same name for every pass of the file, and never mint variants of it (inspection_items / item_records / sheet_items / inspection_data are four names for what is one table).
- EXTRACTED MEDIA: every PICTURE embedded in an uploaded document (photos, diagrams, chart images) is pulled out and saved as a real permanent file under "__MEDIA__/<the document's storage path>/<name>", and a record for each one ALREADY EXISTS in table "__MEDIA__" with unique_id "src::<that path>", reference "src::<the document>", and its path, anchor and sheet already in data. Do NOT create it - the unique_id is taken and your post is rejected. UPDATE it with updateRecords, addressed by that unique_id, adding what the file actually SHOWS plus TAGS for every identifier visible in it (part numbers, tag ids, item names, serial numbers). An update REPLACES the fields you send, so send the existing tags back with your new ones and keep every field already in data (path, anchor, sheet, source, mime, bytes). ONE FILE, ONE RECORD: never also create a photo record in another table. If the update reports that the record does not exist, create it with that same unique_id, reference and data.path - the path must never be lost. Audio and video clips and non-picture attachments are NOT extracted, so never claim a separate file or a "__MEDIA__" record exists for one of those.
- AUDIO files: transcribe the speech, and capture speakers (named where identifiable), the topics discussed, and timestamps of key moments in the record's data. TAG the language, the audio type (call, meeting, dictation, music), each speaker and every named entity; INDEX the duration in seconds as duration_seconds. VIDEO files: everything audio gets, PLUS transcribe on-screen text verbatim (same transcription discipline as photos) and capture the visual timeline - scene changes and what each scene shows, with timestamps. Same tags as audio plus every entity visible on screen, and INDEX duration_seconds here too. These audio and video rules apply to files UPLOADED AS FILES: the transcript and timeline land on the file's own "src::" record, which already exists. Audio or video embedded inside a document is NOT extracted, so never look for or promise a "__MEDIA__" record for it.
- EPUB / e-books / long-form books (.epub or any book-length prose, provided inline in reading order with chapter headings preserved): you MUST save ONE record per CHAPTER (or, when chapters are unclear, per major section/topic) in the table "book_chapters" - never collapse the whole book into a single record. INDEX each chapter record on its chapter number (so chapters sort and range-query in order) and include the chapter title among its tags; the record's "data" must capture the chapter title plus its order/number AND a substantive summary of that chapter's content (key events, arguments, characters, places, concepts, terms, notable quotes). Apply AS MANY relevant tags as possible to EVERY chapter record (characters, locations, themes, topics, key concepts, key terms, dates, named entities) so the book is easy to SEARCH and cross-reference later - this is the whole point. ALSO put the book-level facts (title, author, language, overall summary, chapter list / table of contents, genre/subjects) onto the "src::" file record that ALREADY EXISTS in "file_summaries", using updateRecords. Do NOT post a second book-level record, and set every chapter record's reference to exactly "src::" + the storage path. This per-chapter completeness OVERRIDES brevity; human-readable summaries only, never raw/binary bytes.
- EMAIL (.eml, provided inline with "=== EMAIL ===" / "=== BODY ===" / "=== ATTACHMENT i/N: ..." / "=== FORWARDED MESSAGE k ===" headings): you MUST save ONE record per email MESSAGE in the table "email_messages", and a forwarded message inside it (its own "=== EMAIL ===" block) gets its OWN record. Each record carries subject, from, to, cc, date (the ISO string from the Date line), message_id, in_reply_to, and the body text (quoted earlier replies included). INDEX each record on its date as the ISO string exactly as given, and include the sender address, every recipient address and the subject among its tags. Text under an "=== ATTACHMENT" heading is that attachment's extracted content: datafy it by its own kind (rows into "spreadsheet_rows" for a spreadsheet, one record per section for a document), tag those records with the attachment's filename, and give EVERY record the same "src::" reference as the email. Picture attachments are extracted into "__MEDIA__" like any other embedded picture (their media anchor is quoted on the "[picture ...]" line); other attachments are read inline but NOT saved as separate files, so never claim a separate file or record exists for one.
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
Records for the earlier windows are ALREADY saved (they reference "${src}"). The NEXT window (starting at ${positionLabel || WINDOW_CURSOR_TOKEN}) is embedded below. Do NOT re-save windows that are already saved.
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
function isProviderApiKeyError(input) {
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
    push(input.type);
    if (input.error) {
      push(input.error.message);
      push(input.error.code);
      push(input.error.type);
    }
    if (input.body) {
      push(input.body.message);
      push(input.body.type);
      if (input.body.error) {
        push(input.body.error.message);
        push(input.body.error.code);
        push(input.body.error.type);
      }
    }
  }
  var hay = blobs.join(" | ").toLowerCase();
  if (!hay) return false;
  return hay.indexOf("authentication_error") !== -1 || hay.indexOf("invalid_api_key") !== -1 || hay.indexOf("invalid x-api-key") !== -1 || hay.indexOf("incorrect api key") !== -1 || hay.indexOf("invalid api key") !== -1 || hay.indexOf("no api key provided") !== -1;
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
  return Math.floor((now == null ? Date.now() : now) / LINK_REFRESH_WINDOW_MS);
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
function isPreviewableImagePath(nameOrPath) {
  return !!PREVIEWABLE_IMAGE_CONTENT_TYPES[previewableExtOf(nameOrPath)];
}
function previewImageContentType(nameOrPath) {
  return PREVIEWABLE_IMAGE_CONTENT_TYPES[previewableExtOf(nameOrPath)] || null;
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
function registerModelContextWindows(models) {
  if (!Array.isArray(models)) return;
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    var id = (m && m.id ? String(m.id) : "").trim().toLowerCase();
    if (!id) continue;
    var reported = m ? Number(m.max_input_tokens) : NaN;
    if (Number.isFinite(reported) && reported > 0) {
      apiReportedContextWindows[id] = Math.floor(reported);
    }
    var out = m ? Number(m.max_tokens) : NaN;
    if (Number.isFinite(out) && out > 0) {
      apiReportedMaxOutput[id] = Math.floor(out);
    }
  }
}
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
var OUTPUT_TOKEN_RESERVE = MAX_OUTPUT_TOKENS;
var TOOL_AND_RESPONSE_BUFFER = 4e3;
var MIN_INPUT_TOKEN_BUDGET = 8e3;
var MIN_PER_REQUEST_INPUT_CAP = 28e3;
var CLAUDE_PER_REQUEST_INPUT_CAP = MIN_PER_REQUEST_INPUT_CAP;
var MAX_HISTORY_MESSAGES = 20;
var HISTORY_TOKEN_BUDGET = 8e3;
var INPUT_CAP_RATIO = 0.16;
var CLAUDE_INPUT_CAP_RATIO = INPUT_CAP_RATIO;
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
function needsBomForExt(ext) {
  return encodingClassForExt(ext) === "bom";
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
  if (!scope) {
    previewUrlCache = /* @__PURE__ */ Object.create(null);
    previewInFlight = /* @__PURE__ */ Object.create(null);
    staleImagePreviews = /* @__PURE__ */ Object.create(null);
    return;
  }
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
  if (!scope || !remotePath) return;
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
function buildAiAgentValue(platform, model, contextWindow) {
  var p = (platform || "").trim().toLowerCase();
  if (!p || p === "none") return "none";
  var m = (model || "").trim();
  if (!m) return p;
  var n = Number(contextWindow);
  if (!Number.isFinite(n) || n <= 0) return p + "#" + m;
  return p + "#" + m + "#" + Math.floor(n);
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
var ANTHROPIC_MODELS_API_URL = "https://api.anthropic.com/v1/models";
var ANTHROPIC_VERSION = "2023-06-01";
var ANTHROPIC_MCP_BETA = "mcp-client-2025-11-20";
var ANTHROPIC_WEB_FETCH_BETA = "web-fetch-2025-09-10";
var ANTHROPIC_PROMPT_CACHING_BETA = "prompt-caching-2024-07-31";
var ANTHROPIC_BETA_HEADER = `${ANTHROPIC_MCP_BETA},${ANTHROPIC_WEB_FETCH_BETA},${ANTHROPIC_PROMPT_CACHING_BETA}`;
var WEB_FETCH_MAX_USES = 40;
var WEB_FETCH_MAX_CONTENT_TOKENS = 2e5;
var OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";
var OPENAI_MODELS_API_URL = "https://api.openai.com/v1/models";
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
var isRecognisedOpenAIVersion = (model) => OPENAI_VERSIONED_ID.test((model || DEFAULT_OPENAI_MODEL).trim().toLowerCase());
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
async function listClaudeModels(service, owner) {
  return clientSecretRequest({
    clientSecretName: "claude",
    service,
    owner,
    url: ANTHROPIC_MODELS_API_URL,
    method: "GET",
    headers: {
      "x-api-key": "$CLIENT_SECRET",
      "anthropic-version": ANTHROPIC_VERSION
    }
  });
}
async function listOpenAIModels(service, owner) {
  return clientSecretRequest({
    clientSecretName: "openai",
    service,
    owner,
    url: OPENAI_MODELS_API_URL,
    method: "GET",
    headers: {
      Authorization: "Bearer $CLIENT_SECRET"
    }
  });
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
var LIVE_INDEX_PROBE_LIMIT = 20;
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
async function fetchLiveIndexingKeys(params) {
  const queue = bgIndexingQueueName(params.userId, params.service);
  const base = { service: params.service, owner: params.owner, platform: params.platform, queue };
  const [pending, running] = await Promise.all([
    probeBgQueue({ ...base, status: "pending", limit: LIVE_INDEX_PROBE_LIMIT }, { maxAgeMs: BG_PROBE_TTL_MS }),
    probeBgQueue({ ...base, status: "running", limit: LIVE_INDEX_PROBE_LIMIT }, { maxAgeMs: BG_PROBE_TTL_MS })
  ]);
  const keys = /* @__PURE__ */ new Set();
  let truncated = false;
  for (const entry2 of [pending, running]) {
    const res = entry2.result;
    const list = res && Array.isArray(res.list) ? res.list : [];
    if (list.length >= LIVE_INDEX_PROBE_LIMIT) truncated = true;
    for (const item of list) {
      const text = extractLastUserTextFromRequest(item && item.request_body);
      if (!text || !isIndexingRequestText(text)) continue;
      const ref = parseIndexingRequestText(text);
      if (!ref) continue;
      if (ref.path) keys.add(ref.path);
      if (ref.name) keys.add(ref.name);
    }
  }
  return { keys, checked: !truncated, at: Math.min(pending.at, running.at) };
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
function __resetSplitHistoryState(key) {
  if (key !== void 0) {
    delete splitHistoryStates[key];
    delete splitHistoryLocks[key];
    return;
  }
  for (const k in splitHistoryStates) delete splitHistoryStates[k];
  for (const k in splitHistoryLocks) delete splitHistoryLocks[k];
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
  const run = () => _getSplitChatHistoryLocked(key, params, fetchOptions, releaseLock, _fetchImpl);
  const p = prev.then(run, run);
  p.then((res) => {
    if (!res || !res.bgPending) releaseLock();
  }, () => releaseLock());
  splitHistoryLocks[key] = p.then(() => lockTail, () => lockTail);
  return p;
}
async function _getSplitChatHistoryLocked(key, params, fetchOptions, releaseLock, _fetchImpl) {
  const fetch = _fetchImpl || getChatHistory;
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
      let s = await fetch({ ...base, ...surfaceScope }, sOpts);
      let hops = 0;
      while (s && !s.endOfList && !(s.list || []).length && hops < SURFACE_EMPTY_MAX_PAGES) {
        hops++;
        const nOpts = { fetchMore: true };
        if (limit) nOpts.limit = limit;
        s = await fetch({ ...base, ...surfaceScope }, nOpts);
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
          const b = await fetch({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
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
            const b = await fetch({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
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
    const hb = await fetch({ ...base, queue: bgQueue, queue_exact: true, compact: true }, hOpts);
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
      const b = await fetch({ ...base, queue: bgQueue, queue_exact: true, compact: true }, bOpts);
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
var PROJECT_SETTINGS_TABLE = "__SETTINGS__";
var PROJECT_SETTINGS_UNIQUE_ID = "bq::settings";
var PROJECT_SETTINGS_ACCESS_GROUP = "public";
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
var UPLOAD_ACCESS_OPTIONS = UPLOAD_ACCESS_GROUPS.map((value) => ({
  value,
  label: UPLOAD_ACCESS_LABELS[value],
  hint: UPLOAD_ACCESS_HINTS[value]
}));
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
function projectSettingsSettled(service) {
  const e = cache.get(service);
  return !!e && e.settled;
}
function projectAccessSetting(service) {
  return accessSettingFrom(cachedProjectSettings(service));
}
function projectUploadAccessGroup(service) {
  return uploadAccessGroupFrom(cachedProjectSettings(service));
}
function projectAsksUploadAccess(service) {
  return asksUploadAccessFrom(cachedProjectSettings(service));
}
function setProjectSettings(service, data) {
  if (!service) return;
  cache.set(service, { data: data || null, settled: true, inflight: null });
}
function patchProjectSettings(service, patch) {
  if (!service) return;
  const cur = cachedProjectSettings(service) || {};
  setProjectSettings(service, Object.assign({}, cur, patch));
}
function clearProjectSettings(service) {
  if (service) cache.delete(service);
  else cache.clear();
}

export { BG_INDEXING_QUEUE_SUFFIX, BOM, BOM_EXTS, CLAUDE_INPUT_CAP_RATIO, CLAUDE_PER_REQUEST_INPUT_CAP, CONTEXT_WINDOW_BY_MODEL, CONTEXT_WINDOW_DEFAULT, ChatSession, DEFAULT_CLAUDE_MODEL, DEFAULT_CONTEXT_WINDOW, DEFAULT_OPENAI_MODEL, DEFAULT_UPLOAD_ACCESS_GROUP, EMPTY_INDEXING_REPLY, EXPIRED_ATTACHMENT_URL_HOST, EXPIRED_ATTACHMENT_URL_ORIGIN, EXPIRED_LINK_REFRESH_EXPIRES_SECONDS, EXT_CONTENT_TYPES, HISTORY_BUDGET_RATIO, HISTORY_FILL_SLACK_PX, HISTORY_TOKEN_BUDGET, HTML_EXTS, HTML_HEAD_WINDOW, IMAGE_PREVIEWS_PER_MESSAGE, INDEXING_COMPLETE_MARKER, INDEXING_MAX_OUTPUT_TOKENS, INLINE_LINK_GLYPH, INLINE_LINK_UNAVAILABLE_GLYPH, INLINE_LINK_UNAVAILABLE_SUFFIX, INPUT_CAP_RATIO, LINK_LABEL_MAX_DISPLAY_CHARS, LINK_REFRESH_WINDOW_MS, MAX_CONCURRENT_BG_POLLS, MAX_HISTORY_FILL_PAGES, MAX_HISTORY_MESSAGES, MAX_OUTPUT_BY_MODEL, MAX_OUTPUT_TOKENS, MAX_PARSED_CONTENT_CHARS, MCP_NAME, MINT_CACHE_GENERATION, MIN_INPUT_TOKEN_BUDGET, MIN_PER_REQUEST_INPUT_CAP, OUTPUT_TOKEN_RESERVE, POLL_INTERVAL, PRESIGN_SAFETY_MARGIN_MS, PREVIEWABLE_IMAGE_CONTENT_TYPES, PREVIEW_BROWSER_CACHE_SECONDS, PREVIEW_LAYOUT_BOX_SELECTOR, PREVIEW_URL_EXPIRES_SECONDS, PROJECT_SETTINGS_ACCESS_GROUP, PROJECT_SETTINGS_TABLE, PROJECT_SETTINGS_UNIQUE_ID, RENDER_FROM_TOKEN, RTF_EXTS, RUN_RECORD_WORKING_STALE_MS, STREAM_POLL_INTERVAL, TOOL_AND_RESPONSE_BUFFER, UPLOAD_ACCESS_GROUPS, UPLOAD_ACCESS_HINTS, UPLOAD_ACCESS_LABELS, UPLOAD_ACCESS_OPTIONS, XML_EXTS, __resetSplitHistoryState, accessSettingFrom, adoptLocalAnswerIntoPage, applyEncodingDeclaration, asksUploadAccessFrom, bgIndexingQueueName, buildAiAgentValue, buildBoundedChatMessages, buildChatDisplayList, buildChatGreeting, buildChatSystemPrompt, buildDisplayExpiredAttachmentHref, buildHistoryItemFullId, buildIndexingContinueMessage, buildIndexingRenderContinueTemplate, buildIndexingRenderMessage, buildIndexingSystemPrompt, buildIndexingUserMessage, buildIndexingWindowMessage, cachedProjectSettings, callClaudeWithMcp, callClaudeWithPublicMcp, callOpenAIWithPublicMcp, canonicalizePathForm, chatCacheKey, chatEngineConfig, chatStreamWiring, classifyInlineLink, clearAttachmentParsers, clearImagePreviewCache, clearProjectSettings, composeUserMessage, configureChatEngine, configureProjectSettings, contentTypeForExt, createHistoryFiller, createInlineLinkRegex, createScrollAnchor, createSseParser, csrEnvelopeError, encodePathSegments, encodingClassForExt, ensureHtmlCharset, ensureXmlEncoding, escapeInlineHtml, escapeRtfNonAscii, estimateMessageTokens, estimateTextTokens, extOf, extractClaudeText, extractLastUserTextFromRequest, extractOpenAIText, extractRemotePathFromAttachmentHref, fetchLiveIndexingKeys, fillHistoryViewport, filterListByClearHorizon, findAttachmentParser, formatChatTimestamp, getAttachmentParsers, getChatHistory, getContextWindow, getErrorMessage, getExpiredAttachmentVisiblePath, getInputTokenBudget, getMaxOutputTokens, getModelContextWindow, getProjectContextWindow, getSplitChatHistory, getVisionProfile, groupAttachmentFailures, hasBom, hydrateImagePreviews, indexDoneUniqueId, indexScopeKey, indexingAccessGroup, isAuthExpiredError, isBgIndexingQueue, isCsrStatusEnvelope, isErrorResponseBody, isHttpUrlLike, isImageVisionFile, isIndexingRequestText, isLinkUnavailable, isNonRetryableRequestError, isOfficeFile, isPagedReadFile, isPreviewableImagePath, isProviderApiKeyError, isServerExtractable, isServiceDbAttachmentHref, isWindowedReadFile, linkUnavailableKeyForHref, linkUnavailableKeyForPath, linkUnavailableKeysForPath, listClaudeModels, listOpenAIModels, liveSafePrefix, loadProjectSettings, looksLikeRtf, makeExtractPlaceholder, mapHistoryListToMessages, markImagePreviewStale, mayKeepStreamedAnswer, mintCacheBustStamp, needsBomForExt, normalizeAttachmentPathCandidate, normalizeExt, normalizeProjectAccessSetting, normalizeTextContent, normalizeTrailingInlineToken, normalizeUploadAccessGroup, notifyAgentSaveAttachment, parseAiAgentValue, parseAttachmentContent, parseIndexingLabel, parseIndexingRequestText, patchProjectSettings, peekImagePreviewUrl, prepareDownloadText, presignExpiryEpochMs, previewImageContentType, previewLayoutBox, previewMintCacheToken, previewableExtOf, primeProjectSettings, projectAccessSetting, projectAsksUploadAccess, projectSettingsSettled, projectUploadAccessGroup, readExpiredAttachmentHref, readyProjectSettings, registerAttachmentParser, registerModelContextWindows, renderInlineLinkHtml, repairUrlEntities, repairUrlWhitespace, resolveImagePreviewUrl, runIndexUniqueId, safeDecodeURIComponent, sanitizeAttachmentLinksForHistory, setProjectContextWindow, setProjectSettings, shouldRescueInFlightMessage, skapiSupportsStreaming, streamRecoveryEnabled, streamRecoveryLabels, streamRecoveryPhase, stripFileBlocksFromHistory, transformContentWithImages, transformContentWithOpenAIImages, truncateLabelForDisplay, typewriterResumeIndex, uploadAccessGroupFrom, upsertIndexRunRecordSafe, wallClockNow };
//# sourceMappingURL=engine.mjs.map
//# sourceMappingURL=engine.mjs.map