'use strict';

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
  "epub"
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
  "pptx",
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
function composeUserMessage(text, attachmentUrls) {
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
    const extractFiles = attachmentUrls.filter((u) => isServerExtractable(u.name));
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
  const { projectId, serviceName, serviceDescription } = params;
  let systemPrompt = `
You are a dedicated assistant for the project ID: "${projectId}".
Scope: Only answer questions about this project and its data. Do not answer questions about other projects or topics unrelated to this project. When the user refers to "my database", "my data", or "my files", treat those as references to this project's database and file storage.
Knowledge lookup: Before saying you don't know or that something isn't in the chat history, ALWAYS query this project's database through the available MCP tools to look for the answer. The user's data is the source of truth - the chat transcript is not. Only respond with "I don't know" or "I couldn't find that" after you have actually searched the project's data and come back empty.
Complete answers over stored data: The database holds one record per spreadsheet row, and each uploaded file becomes many records. ONE file is routinely SPLIT ACROSS SEVERAL TABLES - a summary row in one table, its page or row content in another, its extracted photos and other media in "__MEDIA__", and the indexer often invents a differently-named table on each pass. An index or tag filter matches inside ONE table only and requires table_name: on getRecords, an index or tag sent with table_name but no access_group is auto-filled with access_group "authorized" (where the indexer writes; pass access_group explicitly, including 0, to search another group), while an index or tag WITHOUT table_name FAILS with an error instead of answering, so read the error rather than guessing. Reference is the exception: reference ALONE spans EVERY table and EVERY access group, so getRecords with reference "src::<the file's storage path>" is the one call that returns a whole file's records wherever the indexer put them. Adding table_name narrows it to that table; access_group WITHOUT table_name fails with '"table" is required'; table_name on its own returns that whole table across all access groups. For anything NOT scoped to a single file, call getTables FIRST, run the query once per table that could hold the answer, and combine the results. For any request that counts, sums, totals, lists every match, compares across records, finds which one, or asks whether something is present or ABSENT (for example "how many", "total spent", "which card", "is there any", "\uC5C6\uC5B4?", "\uD558\uB098\uB3C4 \uC5C6\uB098?"), you MUST read the COMPLETE matching set before answering. Query with fetch_all set to true, or page through getToolResponsePage until pagination.complete is true, across EVERY table and EVERY relevant file. A single default query returns only the first page (about 50 records). That is a SAMPLE. Never treat it as the whole dataset. If you already answered from one table and then realise another table holds more, do not simply apologise: re-run the sweep and give the complete answer.
Never assert absence from a partial read. Do not say "there is no X", "none", "not found", or "\uC544\uB2C8\uC694, \uC5C6\uC2B5\uB2C8\uB2E4" until a complete scan has come back empty. If you have not finished scanning every relevant table and file, keep querying instead of guessing. A confident "no" that later turns out wrong is worse than telling the user you are still checking.
Embedded values: a search term is often stored inside a larger string. A merchant "GODADDY" appears as "DNH*GODADDY#4070277042", and a card as "4140****2941". Server-side index filters match only exact values, leading prefixes, or trailing suffixes, and tag filters only EXACT whole-tag values - never a partial or interior substring - so filtering on such a field silently drops rows. When the value you are looking for may be embedded, do not trust a narrow filter to be complete. Fetch the full set with fetch_all and match the substring yourself.
File attachments: When a user message contains an "Attached files:" section with markdown links, those links point to short-lived signed URLs in this project's db storage and will expire.
- Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY attached inline as image content blocks in the same message - you can see them directly. Do NOT call web_fetch on image URLs; that will fail or return garbage. Just look at the image block and answer.
- Most attached files (office documents like .docx/.xlsx/.pptx/.hwp/.hwpx/.ods, and text/data/code files like .csv/.tsv/.json/.xml/.txt/.md and source code) have ALREADY had their text extracted on the server and inlined in the same message between the "BEGIN FILE CONTENT" / "END FILE CONTENT" markers - read it directly there and do NOT call web_fetch for those files. A "[skapi: ...]" note in that block means the file could not be extracted.
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
  let systemPrompt = `You are a background indexing agent for project ${projectId}.
- Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY attached inline as image content blocks in the same message - you can see them directly. Do NOT call web_fetch on image URLs; that will fail or return garbage. Just look at the image block and answer.
- Most files (office documents like .docx/.xlsx/.pptx/.hwp/.hwpx/.ods, and text/data/code files like .csv/.tsv/.json/.xml/.txt/.md and source code) have ALREADY been extracted on the server and included inline in the user message between the "BEGIN FILE CONTENT" / "END FILE CONTENT" markers - read that directly. If the inline content is a "[skapi: ...]" note, the file could not be extracted - index it from its metadata only.
- BIG SPREADSHEETS / TEXT: the inline content may be only the FIRST part of a large file (it can end with a truncation or "more remains" note). UNLESS this message already embeds a window of the file (in which case the message tells you not to call readFileContent, and you must not), read big spreadsheets and big text/data files WITH THE readFileContent TOOL: it returns the file ONE WINDOW at a time (spreadsheets as coordinate-tagged grid rows, text as a range of characters). Pass the file's storage path. After each window: datafy it into records and SAVE them, THEN if the window says MORE REMAINS call readFileContent again with the cursor it gives you. Repeat until it says END OF FILE, so the WHOLE file is indexed - never stop after the first window. (Do NOT call readFileContent on a PDF - see the next line.)
- PDFs (scanned or not): you do NOT read a PDF with a tool or a URL. Its pages are RENDERED and embedded directly in the user message as IMAGE blocks, a WINDOW of pages at a time. LOOK at the embedded page images and datafy every one. The note beside them tells you whether MORE pages remain: if so, save this window's records and stop (a follow-up pass shows the next window automatically); only when the note says it was the LAST window is the PDF fully seen. Do NOT call readFileContent or web_fetch for a PDF.
- VISION: when the message (a readFileContent window, an embedded PDF page, or an inline attachment) includes IMAGES - scanned/rendered PDF pages, or photos embedded in a spreadsheet next to a row/block - LOOK at them and capture what they show as record data (the reading/values in a scanned table, the part/defect/condition visible in a photo). The image IS part of the data; correlate each photo with its labelled block ("PHOTO A3" markers tie a photo to that grid row).
- TRANSCRIBE, DO NOT DESCRIBE. When an image contains ANY text - a label, tag, stamp, form field, serial/part number, handwriting - your FIRST job is to read the characters out and store them VERBATIM, not to describe the scene. A record saying "a red inspection tag with handwritten markings" is worthless: it is unsearchable and every such photo produces the same sentence. Put the characters you can actually read into these EXACT fields, not variations of them: "printed_text" (the pre-printed wording), "handwritten_text" (what a person wrote by hand), and, when you can resolve one, "part_no", "tag_id" and "date". Same reason as the fixed table names: a field called photo_text in one pass and visible_text_notes in the next cannot be queried together. Read PARTIAL values rather than skipping: "500.7402.52__" beats nothing. Only when a character is genuinely unreadable, leave that field null or mark the unreadable span - do NOT invent it, and do NOT replace the whole transcription with a description of what the object looks like. A scene description is a nice extra AFTER the text, never instead of it.
- IMAGE FILES uploaded as the file itself: if ANY readable character appears ANYWHERE in the image (a label, a stamp, a sign in the background) it counts as an image WITH text - transcribe it per the rule above, and also capture the layout (what appears where) and every entity named. Only a truly text-free image gets description first: a one-line caption, then the objects present with their attributes (type, color, count, condition, position). Either way, save what you extract onto the file's "src::" record with updateRecords, TAG every entity and identifier visible, and INDEX the one number the image offers (a measured value, an amount, a count).
- Whatever the file type, this file's identity is "src::" + its storage path (the "storage path" metadata line) - never the inline content or a temporary URL. That record ALREADY EXISTS: the upload pipeline creates it in table "file_summaries" (access group "authorized") before indexing starts, so posting it again is rejected as a duplicate unique_id. Reference it from every record you write, and add what you learn to it with updateRecords. If that update unexpectedly reports the record does not exist, post it yourself ONCE with that exact "src::" unique_id (table "file_summaries", access group "authorized") and carry on; this is the ONE exception to the do-NOT-post-the-file-record rules elsewhere in these instructions, because the source identity must never be dropped just because an update failed.
- REACHABILITY (hard rule): every record you write while indexing this file MUST be reachable from the file's "src::<storage path>" record by following reference - either reference that record directly, or reference something that already reaches it. A record with no reference, or one pointing outside this file's chain, is an ORPHAN: deleting or re-indexing the file removes the reachable records and leaves the orphan behind forever, where it keeps turning up in later answers as stale data. If you create an intermediate record that OTHER records reference (a page record that rows hang off, a sheet or section record), set source.can_remove_referencing_records to true on it; the delete cascade passes a delete through a record only when that record carries the flag OR a unique_id starting "src::" (the file record cascades because its unique_id starts with "src::"; the intermediates you create carry no "src::" id, so they need the flag), and it cascades ONE LEVEL AT A TIME, so EVERY intermediate record in a chain needs its own marker - an unmarked link stops the cascade there and everything below it survives as orphans. When in doubt, reference the file record directly and keep the chain flat.
- TABULAR data (any spreadsheet - .csv/.tsv/.xlsx/.xls/.ods, or sheet-like rows): you MUST save EVERY data row as its own record (ONE record per row) with that row's actual column values in the record's "data", keyed by the header names, in a table named EXACTLY "spreadsheet_rows". Do NOT summarize, sample only a few rows, or save just file metadata - index the whole sheet, window by window, until it ends. Make MULTIPLE postRecords calls in batches (e.g. 30-50 rows per call) rather than one oversized call. This per-row completeness OVERRIDES brevity. The file-level "src::" record ALREADY EXISTS - the upload pipeline creates it before indexing starts - so do NOT create it. Link EVERY per-row record to it via reference (set each row record's reference to exactly "src::" + the storage path, with NO sheet/window/summary suffix added; the row records themselves do NOT carry a src:: unique_id). Enrich that same record with sheet name(s), column headers and total row count via updateRecords rather than posting another one. The per-row records AND this reference linkage are BOTH mandatory: the linkage is what lets the whole sheet be found and cleaned up together when the file is re-indexed. INDEX each row record on the row's most useful NUMERIC column (named by its header) so rows sort and range-query; when the row has no numeric column, index the grid row number instead. TAG each row record with the sheet name, the file name, and the row's categorical values (a status, a category, a type) - tags are how rows are filtered without scanning the table.
- ONE RECORD PER GRID ROW, ALWAYS. "Row" means the numbered row of the sheet (R37 is one record), never a visual block, item, section or left/right pair. Sheets that repeat the same columns side by side (an A/B block beside a C/D block, "paired" or "mirrored" layouts) still get ONE record per grid row, holding BOTH sides - suffix the keys to keep them apart (PART_NO_A / PART_NO_B). Collapsing a 16-row window into 2 or 3 "block" records is the single most damaging mistake here: it silently loses most of the cells and makes every later total wrong, because some windows were counted per row and others per block. If a window shows rows R37 to R52, you save records for R37..R52 and the count you report is the number of grid rows you actually wrote.
- FIXED TABLE NAMES. Never invent a table name for one pass, and never vary the name between passes of the SAME file: that scatters one file's data across tables nobody can enumerate later, so the data is effectively lost even though every save succeeded. Use exactly "spreadsheet_rows" for spreadsheet row records, "book_chapters" for a chapter record, and "file_summaries" for the file-level record (which already exists, so update it and never post it). Embedded photos and other embedded files get NO table of your choosing: their records already exist in table "__MEDIA__", see EXTRACTED MEDIA below. For a content type none of those fit, choose ONE plain descriptive name, use that same name for every pass of the file, and never mint variants of it (inspection_items / item_records / sheet_items / inspection_data are four names for what is one table).
- EXTRACTED MEDIA: every PICTURE embedded in an uploaded document (photos, diagrams, chart images) is pulled out and saved as a real permanent file under "__MEDIA__/<the document's storage path>/<name>", and a record for each one ALREADY EXISTS in table "__MEDIA__" with unique_id "src::<that path>", reference "src::<the document>", and its path, anchor and sheet already in data. Do NOT create it - the unique_id is taken and your post is rejected. UPDATE it with updateRecords, addressed by that unique_id, adding what the file actually SHOWS plus TAGS for every identifier visible in it (part numbers, tag ids, item names, serial numbers). An update REPLACES the fields you send, so send the existing tags back with your new ones and keep every field already in data (path, anchor, sheet, source, mime, bytes). ONE FILE, ONE RECORD: never also create a photo record in another table. If the update reports that the record does not exist, create it with that same unique_id, reference and data.path - the path must never be lost. Audio and video clips and non-picture attachments are NOT extracted, so never claim a separate file or a "__MEDIA__" record exists for one of those.
- AUDIO files: transcribe the speech, and capture speakers (named where identifiable), the topics discussed, and timestamps of key moments in the record's data. TAG the language, the audio type (call, meeting, dictation, music), each speaker and every named entity; INDEX the duration in seconds as duration_seconds. VIDEO files: everything audio gets, PLUS transcribe on-screen text verbatim (same transcription discipline as photos) and capture the visual timeline - scene changes and what each scene shows, with timestamps. Same tags as audio plus every entity visible on screen, and INDEX duration_seconds here too. These audio and video rules apply to files UPLOADED AS FILES: the transcript and timeline land on the file's own "src::" record, which already exists. Audio or video embedded inside a document is NOT extracted, so never look for or promise a "__MEDIA__" record for it.
- EPUB / e-books / long-form books (.epub or any book-length prose, provided inline in reading order with chapter headings preserved): you MUST save ONE record per CHAPTER (or, when chapters are unclear, per major section/topic) in the table "book_chapters" - never collapse the whole book into a single record. INDEX each chapter record on its chapter number (so chapters sort and range-query in order) and include the chapter title among its tags; the record's "data" must capture the chapter title plus its order/number AND a substantive summary of that chapter's content (key events, arguments, characters, places, concepts, terms, notable quotes). Apply AS MANY relevant tags as possible to EVERY chapter record (characters, locations, themes, topics, key concepts, key terms, dates, named entities) so the book is easy to SEARCH and cross-reference later - this is the whole point. ALSO put the book-level facts (title, author, language, overall summary, chapter list / table of contents, genre/subjects) onto the "src::" file record that ALREADY EXISTS in "file_summaries", using updateRecords. Do NOT post a second book-level record, and set every chapter record's reference to exactly "src::" + the storage path. This per-chapter completeness OVERRIDES brevity; human-readable summaries only, never raw/binary bytes.
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
function buildIndexingUserMessage(attachment, options) {
  const head = `A new file has just been uploaded. Index it now.

File metadata:
- name: ${attachment.name}
- storage path: ${attachment.storagePath}
` + (attachment.mime ? `- mime type: ${attachment.mime}
` : "") + (typeof attachment.size === "number" ? `- size (bytes): ${attachment.size}
` : "");
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
` + (attachment.mime ? `- mime type: ${attachment.mime}
` : "");
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
` + (attachment.mime ? `- mime type: ${attachment.mime}
` : "") + `
Records for the earlier windows/pages of this file are ALREADY saved (they reference "${src}"). First call getRecords with reference "${src}" to see how far the previous pass got (the furthest row/window already saved). The reference ALONE is the whole query: it returns every record written from this file across ALL tables and ALL access groups, so do NOT add table_name or access_group to narrow it. The response is PAGED, so keep fetching pages until it reports there are no more, and take the furthest point from the WHOLE set, never from the first page. Then call readFileContent with the storage path above and a CURSOR that RESUMES just after that point - do NOT start at the beginning. The cursor is derivable from what you already saved:
 - Spreadsheet: the cursor is "<sheetIndex>:<nextRow>" (0-based sheet index, 1-based row). If you saved up to row R of sheet S, use cursor="S:R+1".
 - Text: the cursor is the character offset already read.
Index the REMAINING windows - one record per row/item, looking at any page images or embedded photos - saving as you go until readFileContent reports END OF FILE. A \xABPHOTO <cell>\xBB marker in a window marks an embedded picture whose extracted file already has a record in table "__MEDIA__": find it with getRecords reference "src::" + the storage path above and match the cell against data.anchor or tags (a repeated picture is stored under its first anchor only), then enrich it with updateRecords. Never create a photo record of your own and never construct a path for one. Do NOT re-save windows that are already saved. Set every record's reference to exactly "src::" + the storage path above (no sheet, window or summary suffix added). That file record already exists, so do NOT post it; enrich it with updateRecords. When the ENTIRE file is finally indexed, end your message with the token INDEXING_COMPLETE.`;
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
function getErrorMessage(input) {
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
  if (!response || typeof response !== "object") return false;
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
var PREVIEW_BROWSER_CACHE_SECONDS = 7 * 24 * 60 * 60;
var LINK_REFRESH_WINDOW_MS = (EXPIRED_LINK_REFRESH_EXPIRES_SECONDS - 5 * 60) * 1e3;
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
function linkUnavailableKeyForPath(remotePath) {
  return "path:" + (remotePath || "");
}
function linkUnavailableKeyForHref(href) {
  return "href:" + (href || "");
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
  // exact ids
  "claude-opus-5": 1e6,
  "claude-opus-4-8": 1e6,
  "claude-opus-4-7": 1e6,
  "claude-sonnet-5": 1e6,
  "claude-sonnet-4-6": 1e6,
  "claude-sonnet-4": 2e5,
  "claude-haiku-4-5": 2e5,
  "gpt-5.4": 128e3,
  "gpt-5.6-luna": 128e3,
  // family keys
  "claude-opus": 1e6,
  "claude-sonnet": 1e6,
  "claude-haiku": 2e5,
  "gpt-5.6": 128e3,
  "gpt-5": 128e3
};
var apiReportedContextWindows = {};
function registerModelContextWindows(models) {
  if (!Array.isArray(models)) return;
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    var id = (m && m.id ? String(m.id) : "").trim().toLowerCase();
    var reported = m ? Number(m.max_input_tokens) : NaN;
    if (id && Number.isFinite(reported) && reported > 0) {
      apiReportedContextWindows[id] = Math.floor(reported);
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
var OUTPUT_TOKEN_RESERVE = 22e3;
var TOOL_AND_RESPONSE_BUFFER = 4e3;
var MIN_INPUT_TOKEN_BUDGET = 8e3;
var CLAUDE_PER_REQUEST_INPUT_CAP = 28e3;
var MAX_HISTORY_MESSAGES = 20;
var HISTORY_TOKEN_BUDGET = 8e3;
var CLAUDE_INPUT_CAP_RATIO = 0.16;
var HISTORY_BUDGET_RATIO = 0.08;
function estimateTextTokens(text) {
  return Math.ceil((text || "").length / 3);
}
function estimateMessageTokens(msg) {
  return estimateTextTokens(msg.content) + estimateTextTokens(msg.role) + 6;
}
function getContextWindow(platform, model, projectId) {
  var override = projectId ? getProjectContextWindow(projectId) : null;
  if (override) return override;
  var normalized = (model || "").trim().toLowerCase();
  if (normalized) {
    if (apiReportedContextWindows[normalized]) return apiReportedContextWindows[normalized];
    if (CONTEXT_WINDOW_BY_MODEL[normalized]) return CONTEXT_WINDOW_BY_MODEL[normalized];
    var parts = normalized.split("-");
    for (var end = parts.length - 1; end > 0; end--) {
      var family = parts.slice(0, end).join("-");
      if (CONTEXT_WINDOW_BY_MODEL[family]) return CONTEXT_WINDOW_BY_MODEL[family];
    }
  }
  return CONTEXT_WINDOW_DEFAULT[platform];
}
function stripFileBlocksFromHistory(content) {
  if (!content) return content;
  return content.replace(/```([^\n`]+?\.[^\s.`]+)\n[\s\S]*?```/g, "[file previously attached: $1]");
}
function buildBoundedChatMessages(options) {
  var contextWindow = getContextWindow(options.platform, options.model, options.projectId);
  var contextBasedBudget = Math.max(
    MIN_INPUT_TOKEN_BUDGET,
    contextWindow - OUTPUT_TOKEN_RESERVE - TOOL_AND_RESPONSE_BUFFER
  );
  var scaled = !!(options.projectId && getProjectContextWindow(options.projectId));
  var claudeInputCap = scaled ? Math.max(CLAUDE_PER_REQUEST_INPUT_CAP, Math.round(contextBasedBudget * CLAUDE_INPUT_CAP_RATIO)) : CLAUDE_PER_REQUEST_INPUT_CAP;
  var availableInputBudget = options.platform === "claude" ? Math.min(contextBasedBudget, claudeInputCap) : contextBasedBudget;
  var systemCost = estimateTextTokens(options.systemPrompt) + 12;
  var historyAllowance = scaled ? Math.max(HISTORY_TOKEN_BUDGET, Math.round(contextBasedBudget * HISTORY_BUDGET_RATIO)) : HISTORY_TOKEN_BUDGET;
  var budgetForHistory = Math.max(1e3, Math.min(historyAllowance, availableInputBudget - systemCost));
  var maxHistoryMessages = scaled ? Math.max(MAX_HISTORY_MESSAGES, Math.round(MAX_HISTORY_MESSAGES * (budgetForHistory / HISTORY_TOKEN_BUDGET))) : MAX_HISTORY_MESSAGES;
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
  return "<a " + attrs.join(" ") + '><img class="bq-img-preview" alt="' + escapeInlineHtml(full) + '" data-bq-img-path="' + escapeInlineHtml(link.remotePath || "") + '" data-bq-img-type="' + escapeInlineHtml(link.image ? link.image.contentType : "") + '" loading="lazy" decoding="async"><span class="bq-loader" data-bq-img-loader="1"></span><span class="bq-img-preview-caption" translate="no">' + escapeInlineHtml(labelText) + "</span></a>";
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
  if (hit && Date.now() - hit.at < LINK_REFRESH_WINDOW_MS) return hit.url;
  return null;
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
    if (ctx.onLoad) ctx.onLoad(path);
  });
  img.addEventListener("error", function() {
    onImageError(img, ctx, path, type);
  });
  var warm = peekImagePreviewUrl(ctx, path);
  if (warm) {
    img.setAttribute("src", warm);
    return;
  }
  resolveImagePreviewUrl(ctx, path, type).then(function(url) {
    if (img.getAttribute("data-bq-img-state") !== "loading") return;
    img.setAttribute("src", url);
  }, function(e) {
    img.setAttribute("data-bq-img-state", "error");
    if (ctx.onError) ctx.onError(path, e);
  });
}
function onImageError(img, ctx, path, type) {
  if (img.getAttribute("data-bq-img-retry") === "1") {
    img.setAttribute("data-bq-img-state", "error");
    if (ctx.onError) ctx.onError(path, new Error("image preview failed to load"));
    return;
  }
  img.setAttribute("data-bq-img-retry", "1");
  img.removeAttribute("src");
  resolveImagePreviewUrl(ctx, path, type, true).then(function(url) {
    img.setAttribute("src", url);
  }, function(e) {
    img.setAttribute("data-bq-img-state", "error");
    if (ctx.onError) ctx.onError(path, e);
  });
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
var MAX_TOKENS = 25e3;
var DEFAULT_OPENAI_IMAGE_DETAIL = "auto";
var OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS = true;
var MCP_NAME = "BunnyQuery";
var DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
var DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
var mcpUrl = () => chatEngineConfig().mcpBaseUrl;
var clientSecretRequest = (opts) => chatEngineConfig().clientSecretRequest(opts);
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
  return clientSecretRequest({
    clientSecretName: "claude",
    queue: userId || service,
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
      model,
      max_tokens: maxTokens,
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
async function callClaudeWithPublicMcp(prompt, service, owner, messages, system, model, userId, extractContent, fileUrls, onResponse, onError) {
  return callClaudeWithMcp({
    prompt,
    messages,
    service,
    owner,
    userId,
    model: model || DEFAULT_CLAUDE_MODEL,
    maxTokens: MAX_TOKENS,
    system,
    extractContent,
    fileUrls,
    mcpServer: {
      name: MCP_NAME,
      url: mcpUrl(),
      authorizationToken: "$ACCESS_TOKEN"
    }});
}
async function callOpenAIWithPublicMcp(prompt, service, owner, messages, system, model, userId, extractContent, fileUrls, onResponse, onError) {
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
  return clientSecretRequest({
    clientSecretName: "openai",
    queue: userId || service,
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
      model: resolvedModel,
      max_output_tokens: MAX_TOKENS,
      ...extractContent && extractContent.length ? { _skapi_extract: extractContent } : {},
      ...fileUrls && fileUrls.length ? { _skapi_file_urls: fileUrls } : {},
      input: responseInput,
      tools: [
        {
          type: "mcp",
          server_label: MCP_NAME,
          server_url: mcpUrl(),
          require_approval: "never",
          headers: {
            Authorization: "Bearer $ACCESS_TOKEN"
          }
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
    serviceDescription: info.serviceDescription
  });
  if (platform === "openai") {
    const resolvedModel2 = info.model || DEFAULT_OPENAI_MODEL;
    const imageDetail = getOpenAIImageDetail(resolvedModel2);
    return clientSecretRequest({
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
        max_output_tokens: MAX_TOKENS,
        // Nano-only transcription knobs. Indexing only; see variantIndexingOptions.
        ...variantIndexingOptions(resolvedModel2),
        ...skapiExtract,
        ...skapiRender,
        ...skapiWindow,
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
            server_url: mcpUrl(),
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
    });
  }
  const resolvedModel = info.model || DEFAULT_CLAUDE_MODEL;
  return clientSecretRequest({
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
      max_tokens: MAX_TOKENS,
      ...skapiExtract,
      ...skapiRender,
      ...skapiWindow,
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
          url: mcpUrl(),
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
  });
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
    const entry = { result, at: Date.now() };
    bgProbeCache[key] = entry;
    return entry;
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
  for (const entry of [pending, running]) {
    const res = entry.result;
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
var BG_COVERAGE_MAX_PAGES = 8;
var splitHistoryStates = {};
function freshSplitState() {
  return { bgBuffer: [], bgEnd: false, bgStarted: false, surfaceEnd: false, pendingSurface: null, lastSurfaceKeys: [] };
}
function __resetSplitHistoryState(key) {
  if (key !== void 0) {
    delete splitHistoryStates[key];
    return;
  }
  for (const k in splitHistoryStates) delete splitHistoryStates[k];
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
async function getSplitChatHistory(params, fetchOptions, _fetchImpl) {
  const fetch = _fetchImpl || getChatHistory;
  const bgQueue = bgIndexingQueueName(params.userId, params.service);
  const base = { service: params.service, owner: params.owner, platform: params.platform };
  const fetchMore = !!(fetchOptions && fetchOptions.fetchMore);
  const limit = fetchOptions && fetchOptions.limit;
  const key = [params.service, params.owner, params.platform, params.userId || ""].join("|");
  if (!fetchMore || !splitHistoryStates[key]) {
    splitHistoryStates[key] = freshSplitState();
  }
  const state = splitHistoryStates[key];
  if (!state.pendingSurface) {
    if (state.surfaceEnd) {
      state.pendingSurface = { list: [], endOfList: true, startKeyHistory: state.lastSurfaceKeys };
    } else {
      const sOpts = { fetchMore };
      if (limit) sOpts.limit = limit;
      const s = await fetch({ ...base, queue_exclude: bgQueue }, sOpts);
      state.pendingSurface = {
        list: s && Array.isArray(s.list) ? s.list : [],
        endOfList: !!(s && s.endOfList),
        startKeyHistory: s && Array.isArray(s.startKeyHistory) ? s.startKeyHistory : []
      };
    }
  }
  const surface = state.pendingSurface;
  const boundary = surface.endOfList ? -Infinity : oldestCreated(surface.list);
  if (boundary !== Infinity || surface.endOfList) {
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
      for (const it of bList) state.bgBuffer.push(it);
      state.bgEnd = !!(b && b.endOfList);
      if (!bList.length) break;
    }
  }
  let emit;
  if (boundary === -Infinity) {
    emit = state.bgBuffer;
    state.bgBuffer = [];
  } else {
    emit = [];
    const keep = [];
    for (const it of state.bgBuffer) {
      const c = createdOf(it);
      if (isNaN(c) || c >= boundary) emit.push(it);
      else keep.push(it);
    }
    state.bgBuffer = keep;
  }
  const seen = {};
  for (const it of surface.list) {
    if (it && typeof it.id === "string") seen[it.id] = true;
  }
  const merged = surface.list.concat(emit.filter((it) => !(it && typeof it.id === "string" && seen[it.id])));
  state.surfaceEnd = surface.endOfList;
  state.lastSurfaceKeys = surface.startKeyHistory;
  state.pendingSurface = null;
  return {
    list: merged,
    endOfList: state.surfaceEnd && state.bgEnd && state.bgBuffer.length === 0,
    // Bookkeeping only (both the consumers and the SDK treat it opaquely);
    // the real cursors are the SDK's internal ones plus this module's state.
    startKeyHistory: surface.startKeyHistory
  };
}
function mapHistoryListToMessages(list, platform, opts) {
  var mapped = [], runningItemIds = [];
  var extractAssistantText = platform === "openai" ? extractOpenAIText : extractClaudeText;
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
      if (item._isBgTask) ph.isBackgroundTask = true;
      if (serverItemId !== void 0) {
        ph._serverItemId = serverItemId;
        runningItemIds.push(serverItemId);
      }
      mapped.push(ph);
    } else if (isQueued) ; else if (isErrorResponse) {
      var em = { role: "assistant", content: getErrorMessage(response), isError: true };
      if (item._isBgTask) em.isBackgroundTask = true;
      if (serverItemId !== void 0) em._serverItemId = serverItemId;
      if (replyTs !== void 0) em._ts = replyTs;
      mapped.push(em);
    } else if (assistantText || reportedComplete) {
      var okm = { role: "assistant", content: sanitizeAttachmentLinksForHistory(assistantText, opts.projectId, true) || EMPTY_INDEXING_REPLY };
      if (item._isBgTask) okm.isBackgroundTask = true;
      if (isCompact) okm._compact = true;
      if (serverItemId !== void 0) okm._serverItemId = serverItemId;
      if (replyTs !== void 0) okm._ts = replyTs;
      if (reportedComplete) okm._indexComplete = true;
      mapped.push(okm);
    }
  });
  return { messages: mapped, runningItemIds };
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
var INDEXING_DRAIN_BUSY_POLL_MS = 8e3;
var INDEXING_DRAIN_CONFIRM_POLL_MS = 3e3;
var INDEXING_DRAIN_IDLE_LOOKS = 2;
var INDEXING_DRAIN_MIN_MS = 8e3;
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
var ChatSession = class {
  constructor(host) {
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
    return this.getHistoryCacheKey() + "|" + storagePath;
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
      )).then(function(entry) {
        return entry.result;
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
    this._adoptWorkerIndexingPasses(0);
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
   */
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
  getHistoryCacheKey() {
    var id = this.host.getIdentity();
    if (!id.projectId || id.platform === "none") return "";
    return id.projectId + "#" + id.platform;
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
    return platform === "openai" ? callOpenAIWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls) : callClaudeWithPublicMcp(prompt, projectId, owner, messages, system, model, userId, extractContent, fileUrls);
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
          }
          var dp = initial.poll({ latency: POLL_INTERVAL });
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
      var existing = self.aiChatHistoryCache[params.key] || { messages: [], endOfList: false, startKeyHistory: [] };
      var reply = { role: "assistant", content: result.content, isError: result.isError };
      var msgs = existing.messages.slice();
      var idx = -1;
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        if (m && m.isPending && m.role === "assistant" && !m.isBackgroundTask) {
          idx = i;
          break;
        }
      }
      if (idx !== -1) {
        reply._serverItemId = msgs[idx]._serverItemId;
        msgs[idx] = reply;
      } else {
        msgs.push(reply);
      }
      self.aiChatHistoryCache[params.key] = {
        messages: msgs,
        endOfList: existing.endOfList,
        startKeyHistory: existing.startKeyHistory
      };
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
        )).then(function(entry) {
          settle(entry.result);
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
    var key = !id.projectId ? "" : id.projectId + "#" + id.platform;
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
      this.host.scrollToBottom(true);
      var capturedComposed = composed, capturedPlatform = aiPlatform, capturedKey = key;
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
        if (result && result.poll && (result.status === "pending" || result.status === "running")) {
          var qp = result.poll({ latency: POLL_INTERVAL });
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
    var immediatePlaceholder = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, ...key ? { _ownerKey: key } : {} };
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
    this.host.scrollToBottom(true);
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
      fileUrls
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
  onQueuedSendResponse(_composed, response, platform, serverId, ownerKey) {
    if (serverId) this.historyItemPolls.delete(serverId);
    if (ownerKey && this.getHistoryCacheKey() !== ownerKey) {
      var offReply = isErrorResponseBody(response) ? { role: "assistant", content: getErrorMessage(response), isError: true } : { role: "assistant", content: ((platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response)) || "").trim() || "No text response received from AI provider." };
      this._applyReplyToCache(ownerKey, offReply, serverId);
      if (serverId) this.cancelledServerIds.delete(serverId);
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
        this.state.messages[targetIdx] = { role: "assistant", content: "", _localId: lid };
        this.host.notify();
        this.enqueueTypewrite(targetIdx, answer, lid);
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
    var scoped = this.getHistoryCacheKey() + "|" + group.key;
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
  typewriteIntoIndex(idx, fullText, localId) {
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
    var i = 0;
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
        if (!self.state.typingAbort) {
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
  enqueueTypewrite(idx, fullText, localId) {
    var self = this;
    var target = this.state.messages[idx];
    if (target && target._ts === void 0) target._ts = wallClockNow();
    this.typewriterQueue = this.typewriterQueue.then(function() {
      return self.typewriteIntoIndex(idx, fullText, localId);
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
    var lid = this._newLocalId();
    this.state.messages[pendingIdx] = { role: "assistant", content: "", isPending: false, _localId: lid };
    this._removeStrayPendingAssistants();
    this.host.notify();
    this.promoteNextQueuedToRunning();
    return this.enqueueTypewrite(pendingIdx, latest.content, lid);
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
      var lid = this._newLocalId();
      this.state.messages[idx] = { role: "assistant", content: "", _localId: lid, _serverItemId: itemId };
      this.host.notify();
      this.enqueueTypewrite(idx, text, lid);
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
  _indexKeyOf(entry) {
    if (!entry) return "";
    var file = entry.storagePath || entry.filename;
    if (!file) return "";
    return entry.projectId + "#" + entry.platform + "|" + file;
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
      var entry = this.bgTaskQueue[i];
      var key = this._indexKeyOf(entry);
      if (!key || !this.cancelledIndexKeys.has(key)) continue;
      if (!entry.resumePass && !this.state.stoppedIndexIds[entry.id]) {
        this.cancelledIndexKeys.delete(key);
        continue;
      }
      if (surfaced[entry.id]) continue;
      this.bgTaskQueue.splice(i, 1);
      this._stopPoll(entry.id);
      this._cancelServerItem(entry.id);
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
  _adoptWorkerIndexingPasses(attempt) {
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
      )).then(function(entry) {
        return entry.result;
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
      if (attempt + 1 >= WORKER_PASS_ADOPT_ATTEMPTS.length) {
        self._nudgeIndexingDrain();
        return;
      }
      setTimeout(function() {
        var later = self.host.getIdentity();
        if (later.projectId !== svcId || later.platform !== platform) return;
        if (self.isPollingPaused() || !self.host.isViewMounted()) return;
        self._adoptWorkerIndexingPasses(attempt + 1);
      }, WORKER_PASS_ADOPT_ATTEMPTS[attempt + 1]);
    }, function() {
      self._adoptingWorkerPasses = false;
    });
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
      if (presentIds[e.id] && !pendingIds[e.id]) this.bgTaskQueue.splice(i, 1);
    }
    var bgPollBudget = MAX_CONCURRENT_BG_POLLS - this._countBgPolls();
    var injectedAny = false;
    this.bgTaskQueue.forEach(function(entry) {
      if (entry.projectId !== svcId || entry.platform !== plat) return;
      if (!presentIds[entry.id]) {
        var isRunning = entry.status === "running";
        var userBubble = {
          role: "user",
          content: self.host.formatIndexingLabel(entry.filename, entry.mime, entry.size, entry.storagePath, entry.isReindex, !!entry.resumePass),
          isBackgroundTask: true,
          _serverItemId: entry.id,
          // Structured ref so this live pass groups with the same file's passes
          // rebuilt from history (see indexing_groups.buildChatDisplayList).
          _indexFile: {
            name: entry.filename,
            path: entry.storagePath,
            mime: entry.mime,
            size: entry.size,
            isReindex: !!entry.isReindex,
            continued: !!entry.resumePass
          }
        };
        if (isRunning) userBubble.isPendingInProcess = true;
        else userBubble.isPendingQueued = true;
        var stageAt = self._stageIndex(self.state.messages, entry.stageId);
        var runningBubble = isRunning ? { role: "assistant", content: "", isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: entry.id } : null;
        if (stageAt === -1) {
          self.state.messages.push(userBubble);
          if (runningBubble) self.state.messages.push(runningBubble);
        } else if (runningBubble) {
          self.state.messages.splice(stageAt, 0, userBubble, runningBubble);
        } else {
          self.state.messages.splice(stageAt, 0, userBubble);
        }
        presentIds[entry.id] = true;
        injectedAny = true;
      }
      if (bgPollBudget > 0 && !self.isPollingPaused() && !self.historyItemPolls.has(entry.id) && typeof entry.poll === "function") {
        bgPollBudget--;
        var capturedId = entry.id, capturedPlat = plat;
        var capturedEntry = entry;
        var wasStopped = false;
        var bp = entry.poll({ latency: POLL_INTERVAL });
        self._trackPoll(entry.id, "bg", bp);
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
  _mintDoneMarker(entry) {
    try {
      var mint = chatEngineConfig().mintIndexDoneMarker;
      if (!mint || !entry || !entry.storagePath || !entry.projectId) return;
      var id = this.host.getIdentity();
      if (!id || id.projectId !== entry.projectId) return;
      mint({ service: entry.projectId, storagePath: entry.storagePath });
    } catch (_e) {
    }
  }
  maybeResumeIndexing(entry, response, platform) {
    var self = this;
    var endOfClientChain = function() {
      self._nudgeIndexingDrain();
    };
    try {
      if (!entry || !entry.storagePath) return;
      if (this.cancelledIndexKeys.has(this._indexKeyOf(entry))) return;
      if (!isPagedReadFile(entry.filename, entry.mime)) {
        if (!isErrorResponseBody(response) && !this._isCancelledPollResult(response)) {
          this._mintDoneMarker(entry);
        }
        endOfClientChain();
        return;
      }
      if (isImageVisionFile(entry.filename, entry.mime)) return;
      if (windowedIndexingEnabled() && isWindowedReadFile(entry.filename, entry.mime)) return;
      if (isErrorResponseBody(response)) {
        endOfClientChain();
        return;
      }
      var answer = (platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response)) || "";
      if (answer.indexOf(INDEXING_COMPLETE_MARKER) !== -1) {
        this._mintDoneMarker(entry);
        endOfClientChain();
        return;
      }
      var pass = (entry.resumePass || 0) + 1;
      if (pass > MAX_INDEXING_RESUME_PASSES) {
        endOfClientChain();
        return;
      }
      var id = this.host.getIdentity();
      if (!id || id.platform === "none" || id.projectId !== entry.projectId) return;
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
          name: entry.filename,
          storagePath: entry.storagePath,
          mime: entry.mime,
          size: entry.size,
          url: ""
        }
      }).then(function(ack) {
        if (ack && typeof ack.id === "string") {
          self.bgTaskQueue.push({
            projectId: id.projectId,
            platform: id.platform,
            id: ack.id,
            filename: entry.filename,
            storagePath: entry.storagePath,
            isReindex: entry.isReindex,
            mime: entry.mime,
            size: entry.size,
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
    var loadKey = !id.projectId || id.platform === "none" ? "" : id.projectId + "#" + id.platform;
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
    var fetchHistory = function() {
      return getSplitChatHistory({ service: projectId, owner, platform, userId: id.userId }, options);
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
        formatIndexingLabel: self.host.formatIndexingLabel
      }).messages;
      self.applyHydratedBodies(mapped);
      var keptOlderPages = false;
      if (fetchMore) {
        self.state.messages = mapped.concat(self.state.messages);
      } else {
        if (self.state.typing) self.state.typingAbort = true;
        var serverIds = {};
        mapped.forEach(function(m) {
          if (m._serverItemId) serverIds[m._serverItemId] = 1;
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
          if (mm.isBackgroundTask) continue;
          if (mm._ownerKey !== void 0 && mm._ownerKey !== loadKey) continue;
          if (mm._serverItemId && serverIds[mm._serverItemId]) continue;
          if (!mm._serverItemId) {
            if (mm._stageId) {
              rescued.push(mm);
              continue;
            }
            if (mappedHasPendingAssistant) continue;
            if (mm.isSendingToServer || mm.isPendingQueued || mm.isPendingInProcess || mm.isPending) rescued.push(mm);
            else if (self.state.sending && mm.role === "user") {
              var next = self.state.messages[ri + 1];
              if (next && !next.isBackgroundTask && next.isPending && !next._serverItemId) rescued.push(mm);
            }
          }
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
        var retainedOlder = !sharesPage1 || oldestInPage1 === void 0 ? [] : self.state.messages.filter(function(m) {
          if (typeof m._serverItemId !== "string") return false;
          if (m._ownerKey !== void 0 && m._ownerKey !== loadKey) return false;
          return m._serverItemId < oldestInPage1;
        });
        keptOlderPages = retainedOlder.length > 0;
        self.state.messages = keptOlderPages ? retainedOlder.concat(mapped) : mapped;
        rescued.forEach(function(m) {
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
        if (clearedAt && chatList.length > 0) {
          var oldestUpdated = Number(chatList[chatList.length - 1] && chatList[chatList.length - 1].updated);
          if (isFinite(oldestUpdated) && oldestUpdated <= clearedAt) self.state.historyEndOfList = true;
        }
      }
      if (self.state.historyRequestToken === token) {
        self.state.loadingHistory = false;
        self.state.loadingOlderHistory = false;
      }
      self.updateHistoryCache();
      self.host.notify();
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
          var pp = item.poll({
            latency: POLL_INTERVAL,
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
                var isBg = aIdx !== -1 && !!self.state.messages[aIdx].isBackgroundTask || uIdx !== -1 && !!self.state.messages[uIdx].isBackgroundTask;
                if (aIdx !== -1) self.state.messages.splice(aIdx, 1);
                if (!isBg) {
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
          });
          self._trackPoll(capturedId, item._isBgTask || item._isOnBgQueue ? "bg" : "fg", pp);
          if (pp && pp.catch) pp.catch(function() {
          });
        });
        self.drainBgTaskQueue();
      }
      if (!fetchMore) self.refreshLiveIndexState();
      if (!fetchMore) return self.host.scrollToBottomIfSticky();
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
    att.progress = 0;
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
                url
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
  var groups = {};
  var order = [];
  var runOfIndex = new Array(list.length);
  var runByItemId = {};
  var keyByName = {};
  var openRunOfKey = {};
  var runsOfKey = {};
  var keyOfRun = {};
  var runSeq = 0;
  for (var i = 0; i < list.length; i++) {
    var msg = list[i];
    if (!msg || !msg.isBackgroundTask) continue;
    var runId;
    var ref = msg.role === "user" ? readFileRef(msg) : null;
    if (ref) {
      var key = ref.path || keyByName[ref.name] || ref.name;
      if (!ref.continued && openRunOfKey[key]) delete openRunOfKey[key];
      runId = openRunOfKey[key];
      if (!runId) {
        runId = "run" + runSeq++;
        openRunOfKey[key] = runId;
        keyOfRun[runId] = key;
        (runsOfKey[key] || (runsOfKey[key] = [])).push(runId);
      }
    } else if (msg._serverItemId && runByItemId[msg._serverItemId]) {
      runId = runByItemId[msg._serverItemId];
    } else if (msg.role !== "user") {
      runId = runOfIndex[i - 1];
    }
    if (!runId) continue;
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
  var out = [];
  for (var j = 0; j < list.length; j++) {
    var r = runOfIndex[j];
    if (r === void 0) {
      out.push({ kind: "message", msg: list[j], index: j });
      continue;
    }
    if (groups[r].anchorIndex === j) out.push({ kind: "indexing", group: groups[r], index: j });
  }
  return out;
}

exports.BG_INDEXING_QUEUE_SUFFIX = BG_INDEXING_QUEUE_SUFFIX;
exports.BOM = BOM;
exports.BOM_EXTS = BOM_EXTS;
exports.CLAUDE_INPUT_CAP_RATIO = CLAUDE_INPUT_CAP_RATIO;
exports.CLAUDE_PER_REQUEST_INPUT_CAP = CLAUDE_PER_REQUEST_INPUT_CAP;
exports.CONTEXT_WINDOW_BY_MODEL = CONTEXT_WINDOW_BY_MODEL;
exports.CONTEXT_WINDOW_DEFAULT = CONTEXT_WINDOW_DEFAULT;
exports.ChatSession = ChatSession;
exports.DEFAULT_CLAUDE_MODEL = DEFAULT_CLAUDE_MODEL;
exports.DEFAULT_OPENAI_MODEL = DEFAULT_OPENAI_MODEL;
exports.EMPTY_INDEXING_REPLY = EMPTY_INDEXING_REPLY;
exports.EXPIRED_ATTACHMENT_URL_HOST = EXPIRED_ATTACHMENT_URL_HOST;
exports.EXPIRED_ATTACHMENT_URL_ORIGIN = EXPIRED_ATTACHMENT_URL_ORIGIN;
exports.EXPIRED_LINK_REFRESH_EXPIRES_SECONDS = EXPIRED_LINK_REFRESH_EXPIRES_SECONDS;
exports.EXT_CONTENT_TYPES = EXT_CONTENT_TYPES;
exports.HISTORY_BUDGET_RATIO = HISTORY_BUDGET_RATIO;
exports.HISTORY_FILL_SLACK_PX = HISTORY_FILL_SLACK_PX;
exports.HISTORY_TOKEN_BUDGET = HISTORY_TOKEN_BUDGET;
exports.HTML_EXTS = HTML_EXTS;
exports.HTML_HEAD_WINDOW = HTML_HEAD_WINDOW;
exports.IMAGE_PREVIEWS_PER_MESSAGE = IMAGE_PREVIEWS_PER_MESSAGE;
exports.INDEXING_COMPLETE_MARKER = INDEXING_COMPLETE_MARKER;
exports.INLINE_LINK_GLYPH = INLINE_LINK_GLYPH;
exports.INLINE_LINK_UNAVAILABLE_GLYPH = INLINE_LINK_UNAVAILABLE_GLYPH;
exports.INLINE_LINK_UNAVAILABLE_SUFFIX = INLINE_LINK_UNAVAILABLE_SUFFIX;
exports.LINK_LABEL_MAX_DISPLAY_CHARS = LINK_LABEL_MAX_DISPLAY_CHARS;
exports.LINK_REFRESH_WINDOW_MS = LINK_REFRESH_WINDOW_MS;
exports.MAX_CONCURRENT_BG_POLLS = MAX_CONCURRENT_BG_POLLS;
exports.MAX_HISTORY_FILL_PAGES = MAX_HISTORY_FILL_PAGES;
exports.MAX_HISTORY_MESSAGES = MAX_HISTORY_MESSAGES;
exports.MAX_PARSED_CONTENT_CHARS = MAX_PARSED_CONTENT_CHARS;
exports.MCP_NAME = MCP_NAME;
exports.MIN_INPUT_TOKEN_BUDGET = MIN_INPUT_TOKEN_BUDGET;
exports.OUTPUT_TOKEN_RESERVE = OUTPUT_TOKEN_RESERVE;
exports.POLL_INTERVAL = POLL_INTERVAL;
exports.PREVIEWABLE_IMAGE_CONTENT_TYPES = PREVIEWABLE_IMAGE_CONTENT_TYPES;
exports.PREVIEW_BROWSER_CACHE_SECONDS = PREVIEW_BROWSER_CACHE_SECONDS;
exports.RENDER_FROM_TOKEN = RENDER_FROM_TOKEN;
exports.RTF_EXTS = RTF_EXTS;
exports.TOOL_AND_RESPONSE_BUFFER = TOOL_AND_RESPONSE_BUFFER;
exports.XML_EXTS = XML_EXTS;
exports.__resetSplitHistoryState = __resetSplitHistoryState;
exports.applyEncodingDeclaration = applyEncodingDeclaration;
exports.bgIndexingQueueName = bgIndexingQueueName;
exports.buildAiAgentValue = buildAiAgentValue;
exports.buildBoundedChatMessages = buildBoundedChatMessages;
exports.buildChatDisplayList = buildChatDisplayList;
exports.buildChatSystemPrompt = buildChatSystemPrompt;
exports.buildDisplayExpiredAttachmentHref = buildDisplayExpiredAttachmentHref;
exports.buildHistoryItemFullId = buildHistoryItemFullId;
exports.buildIndexingContinueMessage = buildIndexingContinueMessage;
exports.buildIndexingRenderContinueTemplate = buildIndexingRenderContinueTemplate;
exports.buildIndexingRenderMessage = buildIndexingRenderMessage;
exports.buildIndexingSystemPrompt = buildIndexingSystemPrompt;
exports.buildIndexingUserMessage = buildIndexingUserMessage;
exports.buildIndexingWindowMessage = buildIndexingWindowMessage;
exports.callClaudeWithMcp = callClaudeWithMcp;
exports.callClaudeWithPublicMcp = callClaudeWithPublicMcp;
exports.callOpenAIWithPublicMcp = callOpenAIWithPublicMcp;
exports.chatEngineConfig = chatEngineConfig;
exports.classifyInlineLink = classifyInlineLink;
exports.clearAttachmentParsers = clearAttachmentParsers;
exports.clearImagePreviewCache = clearImagePreviewCache;
exports.composeUserMessage = composeUserMessage;
exports.configureChatEngine = configureChatEngine;
exports.contentTypeForExt = contentTypeForExt;
exports.createHistoryFiller = createHistoryFiller;
exports.createInlineLinkRegex = createInlineLinkRegex;
exports.encodePathSegments = encodePathSegments;
exports.encodingClassForExt = encodingClassForExt;
exports.ensureHtmlCharset = ensureHtmlCharset;
exports.ensureXmlEncoding = ensureXmlEncoding;
exports.escapeInlineHtml = escapeInlineHtml;
exports.escapeRtfNonAscii = escapeRtfNonAscii;
exports.estimateMessageTokens = estimateMessageTokens;
exports.estimateTextTokens = estimateTextTokens;
exports.extOf = extOf;
exports.extractClaudeText = extractClaudeText;
exports.extractLastUserTextFromRequest = extractLastUserTextFromRequest;
exports.extractOpenAIText = extractOpenAIText;
exports.extractRemotePathFromAttachmentHref = extractRemotePathFromAttachmentHref;
exports.fetchLiveIndexingKeys = fetchLiveIndexingKeys;
exports.fillHistoryViewport = fillHistoryViewport;
exports.filterListByClearHorizon = filterListByClearHorizon;
exports.findAttachmentParser = findAttachmentParser;
exports.formatChatTimestamp = formatChatTimestamp;
exports.getAttachmentParsers = getAttachmentParsers;
exports.getChatHistory = getChatHistory;
exports.getContextWindow = getContextWindow;
exports.getErrorMessage = getErrorMessage;
exports.getExpiredAttachmentVisiblePath = getExpiredAttachmentVisiblePath;
exports.getProjectContextWindow = getProjectContextWindow;
exports.getSplitChatHistory = getSplitChatHistory;
exports.getVisionProfile = getVisionProfile;
exports.groupAttachmentFailures = groupAttachmentFailures;
exports.hasBom = hasBom;
exports.hydrateImagePreviews = hydrateImagePreviews;
exports.indexDoneUniqueId = indexDoneUniqueId;
exports.isAuthExpiredError = isAuthExpiredError;
exports.isBgIndexingQueue = isBgIndexingQueue;
exports.isErrorResponseBody = isErrorResponseBody;
exports.isHttpUrlLike = isHttpUrlLike;
exports.isIndexingRequestText = isIndexingRequestText;
exports.isLinkUnavailable = isLinkUnavailable;
exports.isNonRetryableRequestError = isNonRetryableRequestError;
exports.isOfficeFile = isOfficeFile;
exports.isPreviewableImagePath = isPreviewableImagePath;
exports.isServerExtractable = isServerExtractable;
exports.isServiceDbAttachmentHref = isServiceDbAttachmentHref;
exports.linkUnavailableKeyForHref = linkUnavailableKeyForHref;
exports.linkUnavailableKeyForPath = linkUnavailableKeyForPath;
exports.listClaudeModels = listClaudeModels;
exports.listOpenAIModels = listOpenAIModels;
exports.looksLikeRtf = looksLikeRtf;
exports.makeExtractPlaceholder = makeExtractPlaceholder;
exports.mapHistoryListToMessages = mapHistoryListToMessages;
exports.markImagePreviewStale = markImagePreviewStale;
exports.needsBomForExt = needsBomForExt;
exports.normalizeAttachmentPathCandidate = normalizeAttachmentPathCandidate;
exports.normalizeExt = normalizeExt;
exports.normalizeTextContent = normalizeTextContent;
exports.normalizeTrailingInlineToken = normalizeTrailingInlineToken;
exports.notifyAgentSaveAttachment = notifyAgentSaveAttachment;
exports.parseAiAgentValue = parseAiAgentValue;
exports.parseAttachmentContent = parseAttachmentContent;
exports.parseIndexingLabel = parseIndexingLabel;
exports.parseIndexingRequestText = parseIndexingRequestText;
exports.peekImagePreviewUrl = peekImagePreviewUrl;
exports.prepareDownloadText = prepareDownloadText;
exports.previewImageContentType = previewImageContentType;
exports.previewableExtOf = previewableExtOf;
exports.readExpiredAttachmentHref = readExpiredAttachmentHref;
exports.registerAttachmentParser = registerAttachmentParser;
exports.registerModelContextWindows = registerModelContextWindows;
exports.renderInlineLinkHtml = renderInlineLinkHtml;
exports.repairUrlEntities = repairUrlEntities;
exports.repairUrlWhitespace = repairUrlWhitespace;
exports.resolveImagePreviewUrl = resolveImagePreviewUrl;
exports.safeDecodeURIComponent = safeDecodeURIComponent;
exports.sanitizeAttachmentLinksForHistory = sanitizeAttachmentLinksForHistory;
exports.setProjectContextWindow = setProjectContextWindow;
exports.stripFileBlocksFromHistory = stripFileBlocksFromHistory;
exports.transformContentWithImages = transformContentWithImages;
exports.transformContentWithOpenAIImages = transformContentWithOpenAIImages;
exports.truncateLabelForDisplay = truncateLabelForDisplay;
exports.wallClockNow = wallClockNow;
//# sourceMappingURL=engine.cjs.map
//# sourceMappingURL=engine.cjs.map