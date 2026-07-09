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
  var _extractPlaceholderSeq = 0;
  function makeExtractPlaceholder(seed) {
    _extractPlaceholderSeq += 1;
    const slug = (seed || "file").replace(/[^a-zA-Z0-9]+/g, "_").slice(-48);
    return `{{SKAPI_FILE_CONTENT::${slug}-${_extractPlaceholderSeq}}}`;
  }
  function composeUserMessage(text, attachmentUrls) {
    let composed = text;
    if (attachmentUrls.length > 0) {
      const lines = attachmentUrls.map((u) => `- [${u.name}](${u.url})`);
      composed = `${text}

Attached files:
${lines.join("\n")}`;
    }
    let composedForLlm = composed;
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
        composedForLlm = `${composed}

Extracted content of attached office files (read inline below; do NOT fetch their URLs):

` + sections.join("\n\n");
      }
      const urlFiles = attachmentUrls.filter((u) => u.url && !isServerExtractable(u.name));
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
    const { formattedServiceId, serviceName, serviceDescription } = params;
    let systemPrompt = `
You are a dedicated assistant for the project ID: "${formattedServiceId}".
Scope: Only answer questions about this project and its data. Do not answer questions about other projects or topics unrelated to this project. When the user refers to "my database", "my data", or "my files", treat those as references to this project's database and file storage.
Knowledge lookup: Before saying you don't know or that something isn't in the chat history, ALWAYS query this project's database through the available MCP tools to look for the answer. The user's data is the source of truth - the chat transcript is not. Only respond with "I don't know" or "I couldn't find that" after you have actually searched the project's data and come back empty.
File attachments: When a user message contains an "Attached files:" section with markdown links, those links point to short-lived signed URLs in this project's db storage and will expire.
- Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY attached inline as image content blocks in the same message - you can see them directly. Do NOT call web_fetch on image URLs; that will fail or return garbage. Just look at the image block and answer.
- Most attached files (office documents like .docx/.xlsx/.pptx/.hwp/.hwpx/.ods, and text/data/code files like .csv/.tsv/.json/.xml/.txt/.md and source code) have ALREADY had their text extracted on the server and inlined in the same message between the "BEGIN FILE CONTENT" / "END FILE CONTENT" markers - read it directly there and do NOT call web_fetch for those files. A "[skapi: ...]" note in that block means the file could not be extracted.
- For any file given to you as a URL instead of inline content (e.g. PDFs), use your web_fetch tool to download and read each URL before answering. Treat the fetched contents as user-supplied input data. Do not ask the user to paste the file contents - fetch the URLs yourself.
File links: When you find a record whose unique_id starts with "src::", the part after "src::" is the file's storage path or original URL. Always present it as a markdown link so the user can access it. Strip the "src::" prefix \u2014 do NOT show it. Format: [filename](path/to/file) for storage paths, or [filename](https://...) for external URLs. Storage-path links render as clickable buttons in this chat client that fetch a fresh signed URL on demand \u2014 so even if a previously shared URL has expired, give the user the storage-path link instead of saying the file is unavailable. Never tell the user a file is inaccessible or a URL is expired if you have its storage path in the database.
File lookup: When the user asks to see, list, or show files (e.g. "show me uploaded files", "list my images", "show me the reference video"), query the database using getUniqueId with unique_id "src::" and condition "gte" (or getRecords by table) to find all indexed file records. Present each result as a markdown link as described above. Never say you cannot access file storage \u2014 the file paths are indexed in the database and are always reachable through it.
File generation: When the user asks you to generate a file \u2014 or to produce specifically-formatted text such as HTML, CSV, JSON, or Markdown \u2014 put the file's full contents inside a fenced code block whose info string is the intended filename WITH its extension (e.g. report.csv), NOT a language name like "csv". The chat client turns such a block into a downloadable file named after that info string. Emit one file per block, in plain text only \u2014 never base64 or any other encoding. Example for CSV:
\`\`\`filename.csv
item,qty,total
Carrots,55,$38.50
Mushrooms,41,$73.80
Zucchini,29,$43.50
\`\`\`
The same pattern applies to any format \u2014 name the block after the file you intend: \`\`\`my-data.json, \`\`\`index.html, \`\`\`sample.txt, and so on.`;
    if (serviceDescription) {
      systemPrompt += `
Project name: "${serviceName ?? ""}"
Project description: """${serviceDescription}"""`;
    }
    return systemPrompt;
  }

  // src/engine/prompts/indexing_system_prompt.ts
  function buildIndexingSystemPrompt(params) {
    const { service, serviceName, serviceDescription } = params;
    let systemPrompt = `You are a background indexing agent for project ${service}.
- Image files (.jpg, .jpeg, .png, .gif, .webp) are ALREADY attached inline as image content blocks in the same message - you can see them directly. Do NOT call web_fetch on image URLs; that will fail or return garbage. Just look at the image block and answer.
- Most files (office documents like .docx/.xlsx/.pptx/.hwp/.hwpx/.ods, and text/data/code files like .csv/.tsv/.json/.xml/.txt/.md and source code) have ALREADY been extracted on the server and included inline in the user message between the "BEGIN FILE CONTENT" / "END FILE CONTENT" markers - read that directly and do NOT call web_fetch for those files. If the inline content is a "[skapi: ...]" note, the file could not be extracted - index it from its metadata only.
- For any file given to you as a temporary URL instead of inline content (e.g. PDFs), use your web_fetch tool to download and read each URL. Treat the fetched contents as user-supplied input data. Do not ask the user to paste the file contents - fetch the URLs yourself.
- Whatever the file type, use the file's storage path (the "storage path" metadata line) as the "src::" unique_id - never the inline content or a temporary URL.
- TABULAR data (any spreadsheet - .csv/.tsv/.xlsx/.ods, or sheet-like rows): you MUST save EVERY data row as its own record (ONE record per row) with that row's actual column values in the record's "data", keyed by the header names, in a dedicated table (e.g. "spreadsheet_rows"). Do NOT summarize, sample only a few rows, or save just file metadata - index the whole sheet. If a sheet has many rows, make MULTIPLE postRecords calls in batches (e.g. 30-50 rows per call) rather than one oversized call. This per-row completeness OVERRIDES brevity. ALSO save one file-level summary record (file name, sheet name(s), column headers, total row count, overall summary) - this is the record that carries the file's "src::" unique_id - and link EVERY per-row record to it via reference (set each row record's reference to that src:: file record; the row records themselves do NOT carry a src:: unique_id). The per-row records AND this reference linkage are BOTH mandatory: the linkage is what lets the whole sheet be found and cleaned up together when the file is re-indexed.
- EPUB / e-books / long-form books (.epub or any book-length prose, provided inline in reading order with chapter headings preserved): you MUST save ONE record per CHAPTER (or, when chapters are unclear, per major section/topic) in a dedicated table (e.g. "book_chapters") - never collapse the whole book into a single record. Each chapter record's "data" must capture the chapter title plus its order/number AND a substantive summary of that chapter's content (key events, arguments, characters, places, concepts, terms, notable quotes). Apply AS MANY relevant tags as possible to EVERY chapter record (characters, locations, themes, topics, key concepts, key terms, dates, named entities) so the book is easy to SEARCH and cross-reference later - this is the whole point. ALSO save one book-level record (title, author, language, overall summary, chapter list / table of contents, genre/subjects) and link each chapter record to it via reference. This per-chapter completeness OVERRIDES brevity; human-readable summaries only, never raw/binary bytes.
- This is a ONE-SHOT background indexing task: do ALL the MCP saving FIRST, never reply mid-task, and never ask the user questions or invite back-and-forth. Always use the MCP tools to save what you learn - be exhaustive about meaning (and, for tabular data, about every row). Never store raw or binary bytes (base64, blobs); describe them in human-readable text instead.
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
The file's content was parsed by the client and is provided inline below. Read it directly \u2014 do NOT fetch any URL for this file. Use the storage path above (not this content) for the "src::" unique_id.

----- BEGIN FILE CONTENT -----
${options.inlineContent}
----- END FILE CONTENT -----`;
    }
    if (options?.inlineContentPlaceholder) {
      return head + `
The file's text content was extracted on the server and is provided inline below. Read it directly \u2014 do NOT fetch any URL for this file. Use the storage path above (not this content) for the "src::" unique_id.

----- BEGIN FILE CONTENT -----
${options.inlineContentPlaceholder}
----- END FILE CONTENT -----`;
    }
    return head + `- temporary URL (fetch this to read the file contents): ${attachment.url}`;
  }

  // src/engine/errors.ts
  function getErrorMessage(input) {
    if (!input) return "Something went wrong.";
    if (typeof input === "string") return input;
    if (input.error && input.error.message) return input.error.message;
    if (input.body && input.body.error && input.body.error.message) return input.body.error.message;
    if (input.body && typeof input.body.message === "string") return input.body.message;
    if (input.message) return input.message;
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
  function createInlineLinkRegex() {
    return /src::(\S+)|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]+|\([^\s()]*\))+)\)|\[([^\]\n]+)\]\(((?:[^()\n]+|\([^()\n]*\))+)\)|(https?:\/\/[^\s<>"']+)/g;
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
  function extractRemotePathFromAttachmentHref(href, serviceId) {
    try {
      var parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      var path = normalizeAttachmentPathCandidate(parsed.pathname || "");
      var segs = path.split("/").filter(Boolean);
      if (!segs.length) return null;
      var HEX = /^[a-f0-9]{32,}$/i;
      var sid = serviceId || "";
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
  function isServiceDbAttachmentHref(href, serviceId) {
    if (!serviceId) return false;
    try {
      var parsed = new URL(href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      var segs = normalizeAttachmentPathCandidate(parsed.pathname || "").split("/").filter(Boolean);
      return segs.length > 0 && segs[0] === serviceId;
    } catch (e) {
      return false;
    }
  }
  function sanitizeAttachmentLinksForHistory(content, serviceId, forAssistant) {
    if (!content) return content;
    if (!forAssistant && content.indexOf("Attached files:") === -1) return content;
    return content.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function(_m, label, href) {
      if (forAssistant && !isServiceDbAttachmentHref(href, serviceId)) return _m;
      var remotePath = extractRemotePathFromAttachmentHref(href, serviceId);
      var labelPath = normalizeAttachmentPathCandidate(label);
      var fullPath = remotePath || labelPath;
      if (!fullPath) return forAssistant ? _m : "[" + label + "](" + EXPIRED_ATTACHMENT_URL_ORIGIN + "/file)";
      return "[" + label + "](" + buildDisplayExpiredAttachmentHref(fullPath, label) + ")";
    });
  }
  function truncateLabelForDisplay(label) {
    if (!label) return label;
    if (label.length <= LINK_LABEL_MAX_DISPLAY_CHARS) return label;
    return "\u2026" + label.slice(label.length - (LINK_LABEL_MAX_DISPLAY_CHARS - 1));
  }

  // src/engine/budget.ts
  var CONTEXT_WINDOW_DEFAULT = { claude: 2e5, openai: 128e3 };
  var CONTEXT_WINDOW_BY_MODEL = {
    "claude-opus-4-7": 2e5,
    "claude-sonnet-4": 2e5,
    "gpt-5.4": 128e3
  };
  var OUTPUT_TOKEN_RESERVE = 22e3;
  var TOOL_AND_RESPONSE_BUFFER = 4e3;
  var MIN_INPUT_TOKEN_BUDGET = 8e3;
  var CLAUDE_PER_REQUEST_INPUT_CAP = 28e3;
  var HISTORY_TOKEN_BUDGET = 8e3;
  function estimateTextTokens(text) {
    return Math.ceil((text || "").length / 3);
  }
  function estimateMessageTokens(msg) {
    return estimateTextTokens(msg.content) + estimateTextTokens(msg.role) + 6;
  }
  function getContextWindow(platform, model) {
    var normalized = (model || "").trim().toLowerCase();
    if (normalized && CONTEXT_WINDOW_BY_MODEL[normalized]) return CONTEXT_WINDOW_BY_MODEL[normalized];
    return CONTEXT_WINDOW_DEFAULT[platform];
  }
  function stripFileBlocksFromHistory(content) {
    if (!content) return content;
    return content.replace(/```([^\n`]+?\.[^\s.`]+)\n[\s\S]*?```/g, "[file previously attached: $1]");
  }
  function buildBoundedChatMessages(options) {
    var contextWindow = getContextWindow(options.platform, options.model);
    var contextBasedBudget = Math.max(
      MIN_INPUT_TOKEN_BUDGET,
      contextWindow - OUTPUT_TOKEN_RESERVE - TOOL_AND_RESPONSE_BUFFER
    );
    var availableInputBudget = options.platform === "claude" ? Math.min(contextBasedBudget, CLAUDE_PER_REQUEST_INPUT_CAP) : contextBasedBudget;
    var systemCost = estimateTextTokens(options.systemPrompt) + 12;
    var budgetForHistory = Math.max(1e3, Math.min(HISTORY_TOKEN_BUDGET, availableInputBudget - systemCost));
    var windowed = options.history.slice(-20);
    var latestIndex = windowed.length - 1;
    var trimmed = windowed.map(function(m, i2) {
      if (i2 === latestIndex) return m;
      var stripped = stripFileBlocksFromHistory(m.content);
      var sanitized = sanitizeAttachmentLinksForHistory(stripped, options.serviceId, m.role !== "user");
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
  var MAX_TOKENS = 25e3;
  var DEFAULT_OPENAI_IMAGE_DETAIL = "auto";
  var OPENAI_WEB_SEARCH_EXTERNAL_WEB_ACCESS = true;
  var MCP_NAME = "BunnyQuery";
  var DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
  var DEFAULT_OPENAI_MODEL = "gpt-5.4";
  var mcpUrl = () => chatEngineConfig().mcpBaseUrl;
  var clientSecretRequest = (opts) => chatEngineConfig().clientSecretRequest(opts);
  var getOpenAIImageDetail = (model) => {
    const normalized = (model || DEFAULT_OPENAI_MODEL).trim().toLowerCase();
    const match = normalized.match(/^gpt-(\d+)(?:\.(\d+))?$/);
    if (!match) {
      return DEFAULT_OPENAI_IMAGE_DETAIL;
    }
    const major = Number(match[1]);
    const minor = match[2] === void 0 ? null : Number(match[2]);
    if (major > 5) {
      return "original";
    }
    if (major === 5 && minor !== null && minor >= 4) {
      return "original";
    }
    return DEFAULT_OPENAI_IMAGE_DETAIL;
  };
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
  var POLL_INTERVAL = 1500;
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
  async function notifyAgentSaveAttachment(info) {
    const { platform, service, owner, attachment, parsedContent } = info;
    const serverExtract = !parsedContent && isServerExtractable(attachment.name, attachment.mime);
    const placeholder = serverExtract ? makeExtractPlaceholder(attachment.storagePath) : void 0;
    const extractContent = serverExtract && placeholder ? [{ path: attachment.storagePath, placeholder, name: attachment.name, mime: attachment.mime }] : void 0;
    const skapiExtract = extractContent && extractContent.length ? { _skapi_extract: extractContent } : {};
    const userMessage = buildIndexingUserMessage(
      attachment,
      parsedContent ? { inlineContent: parsedContent } : placeholder ? { inlineContentPlaceholder: placeholder } : void 0
    );
    const systemPrompt = buildIndexingSystemPrompt({
      service,
      serviceName: info.serviceName,
      serviceDescription: info.serviceDescription
    });
    if (platform === "openai") {
      const resolvedModel2 = info.model || DEFAULT_OPENAI_MODEL;
      const imageDetail = getOpenAIImageDetail(resolvedModel2);
      return clientSecretRequest({
        clientSecretName: "openai",
        queue: (info.userId || service) + BG_INDEXING_QUEUE_SUFFIX,
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
          ...skapiExtract,
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
      queue: (info.userId || service) + BG_INDEXING_QUEUE_SUFFIX,
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
  var BG_INDEXING_QUEUE_SUFFIX = "-bg";
  async function getChatHistory(params, fetchOptions) {
    const url = params.platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
    const p = Object.assign(
      {
        url,
        method: "POST"
      },
      { service: params.service, owner: params.owner },
      params.queue ? { queue: params.queue } : {}
    );
    return chatEngineConfig().clientSecretRequestHistory(
      p,
      Object.assign({ ascending: false }, fetchOptions)
    );
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
      var userText = extractLastUserTextFromRequest(requestBody);
      var assistantText = isPending ? "" : (extractAssistantText(response) || "").trim() || "";
      var isErrorResponse = !isPending && (isFailed || isErrorResponseBody(response));
      var serverItemId = item && typeof item.id === "string" && item.id ? item.id : void 0;
      if (userText) {
        var displayContent;
        if (item._isBgTask) {
          var nameMatch = userText.match(/^- name: (.+)$/m);
          if (nameMatch) {
            var mimeMatch = userText.match(/^- mime type: (.+)$/m);
            var sizeMatch = userText.match(/^- size \(bytes\): (\d+)$/m);
            var pathMatch = userText.match(/^- storage path: (.+)$/m);
            displayContent = opts.formatIndexingLabel(
              nameMatch[1].trim(),
              mimeMatch ? mimeMatch[1].trim() : "",
              sizeMatch ? Number(sizeMatch[1]) : null,
              pathMatch ? pathMatch[1].trim() : void 0
            );
          } else {
            displayContent = userText;
          }
        } else {
          displayContent = sanitizeAttachmentLinksForHistory(userText, opts.serviceId);
        }
        var userMsg = { role: "user", content: displayContent };
        if (isInProcess) userMsg.isPendingInProcess = true;
        if (isQueued) userMsg.isPendingQueued = true;
        if (isCancelledItem) userMsg.isCancelled = true;
        if (item._isBgTask) userMsg.isBackgroundTask = true;
        if (item._isOnBgQueue) userMsg._useBgQueue = true;
        if (serverItemId !== void 0) userMsg._serverItemId = serverItemId;
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
        mapped.push(em);
      } else if (assistantText) {
        var okm = { role: "assistant", content: sanitizeAttachmentLinksForHistory(assistantText, opts.serviceId, true) };
        if (item._isBgTask) okm.isBackgroundTask = true;
        if (serverItemId !== void 0) okm._serverItemId = serverItemId;
        mapped.push(okm);
      }
    });
    return { messages: mapped, runningItemIds };
  }

  // src/engine/session.ts
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
  var ChatSession = class {
    constructor(host) {
      this.typewriterQueue = Promise.resolve();
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
        gateRefreshToken: 0
      };
      this.bgTaskQueue = [];
      this.cancelledServerIds = /* @__PURE__ */ new Set();
      this.pendingAgentRequests = {};
      this.aiChatHistoryCache = {};
      this.historyItemPolls = /* @__PURE__ */ new Map();
      this._lidSeq = 0;
    }
    _newLocalId() {
      this._lidSeq += 1;
      return "lid_" + this._lidSeq;
    }
    getHistoryCacheKey() {
      var id = this.host.getIdentity();
      if (!id.serviceId || id.platform === "none") return "";
      return id.serviceId + "#" + id.platform;
    }
    updateHistoryCache() {
      var key = this.getHistoryCacheKey();
      if (!key) return;
      this.aiChatHistoryCache[key] = {
        messages: this.state.messages.slice(),
        endOfList: this.state.historyEndOfList,
        startKeyHistory: this.state.historyStartKeyHistory.slice()
      };
    }
    _callProviderFor(platform, prompt, messages, system, model, userId, extractContent, fileUrls) {
      var id = this.host.getIdentity();
      return platform === "openai" ? callOpenAIWithPublicMcp(prompt, id.serviceId, id.owner, messages, system, model, userId, extractContent, fileUrls) : callClaudeWithPublicMcp(prompt, id.serviceId, id.owner, messages, system, model, userId, extractContent, fileUrls);
    }
    dispatchAgentRequest(params) {
      var self = this;
      var dispatchItemId;
      var sendAndPoll = function() {
        return Promise.resolve(
          self._callProviderFor(params.aiPlatform, params.text, params.boundedMessages, params.systemPrompt, params.aiModel, params.userId, params.extractContent, params.fileUrls)
        ).then(function(initial) {
          if (initial && initial.poll && (initial.status === "pending" || initial.status === "running")) {
            if (initial.id) {
              if (dispatchItemId && dispatchItemId !== initial.id) self.historyItemPolls.delete(dispatchItemId);
              dispatchItemId = initial.id;
              self.historyItemPolls.set(initial.id, true);
            }
            return initial.poll({ latency: POLL_INTERVAL });
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
    // composed = clean display text; composedForLlm carries office-extraction
    // placeholders for the provider only. useBgQueue routes a post-attachment turn
    // onto the "-bg" queue so it runs after indexing.
    dispatchComposedMessage(composed, useBgQueue, composedForLlm, extractContent, fileUrls) {
      var self = this;
      if (!composed) return;
      var id = this.host.getIdentity();
      if (id.platform === "none") return;
      var llmComposed = composedForLlm || composed;
      var isQueuedSend = useBgQueue || this.state.sending || this.state.messages.some(function(m) {
        return (m.isPending || m.isPendingQueued) && !m.isBackgroundTask && !m._useBgQueue;
      });
      var aiPlatform = id.platform;
      var aiModel = id.model || void 0;
      var systemPrompt = this.host.buildSystemPrompt();
      var userId = id.userId || id.serviceId;
      var chatQueue = useBgQueue ? userId + BG_INDEXING_QUEUE_SUFFIX : userId;
      if (isQueuedSend) {
        var resolvedHistory = this.state.messages.filter(function(m) {
          return !m.isPending && !m.isPendingQueued && !m.isPendingInProcess && !m.isPendingOlder && !m.isCancelled && !m.isBackgroundTask;
        });
        var boundedQ = buildBoundedChatMessages({
          platform: aiPlatform,
          model: aiModel,
          systemPrompt,
          serviceId: id.serviceId,
          history: resolvedHistory.concat([{ role: "user", content: llmComposed }])
        });
        var queuedBubble = { role: "user", content: composed, isPendingQueued: true, isSendingToServer: true };
        if (useBgQueue) queuedBubble._useBgQueue = true;
        this.state.messages.push(queuedBubble);
        this.host.notify();
        this.updateHistoryCache();
        this.host.scrollToBottom(true);
        var capturedComposed = composed, capturedPlatform = aiPlatform;
        Promise.resolve(this._callProviderFor(aiPlatform, composed, boundedQ.messages, systemPrompt, aiModel, chatQueue, extractContent, fileUrls)).then(function(result) {
          var sendingIdx = self.state.messages.findIndex(function(m) {
            return m.isSendingToServer && (m.isPendingQueued || m.isPendingInProcess) && m.role === "user";
          });
          var serverId = result && typeof result.id === "string" ? result.id : void 0;
          if (sendingIdx >= 0) {
            var upd = Object.assign({}, self.state.messages[sendingIdx], { isSendingToServer: false });
            if (serverId) upd._serverItemId = serverId;
            self.state.messages[sendingIdx] = upd;
            self.host.notify();
          }
          if (result && result.poll && (result.status === "pending" || result.status === "running")) {
            if (serverId) self.historyItemPolls.set(serverId, true);
            return result.poll({ latency: POLL_INTERVAL }).then(function(res) {
              return self.onQueuedSendResponse(capturedComposed, res, capturedPlatform, serverId);
            }).catch(function(err) {
              return self.onQueuedSendError(capturedComposed, err, serverId);
            });
          }
          return self.onQueuedSendResponse(capturedComposed, result, capturedPlatform, serverId);
        }).catch(function(err) {
          return self.onQueuedSendError(capturedComposed, err, void 0);
        });
        return;
      }
      this.state.messages.push({ role: "user", content: composed });
      this.state.messages.push({ role: "assistant", content: "", isPending: true, isPendingInProcess: true });
      this.host.notify();
      this.updateHistoryCache();
      this.state.sending = true;
      this.host.scrollToBottom(true);
      var key = this.getHistoryCacheKey();
      var historyForLlm = this.state.messages.filter(function(m) {
        return !m.isCancelled && !m.isBackgroundTask;
      });
      if (llmComposed !== composed) {
        for (var li = historyForLlm.length - 1; li >= 0; li--) {
          if (historyForLlm[li].role === "user" && historyForLlm[li].content === composed) {
            historyForLlm[li] = Object.assign({}, historyForLlm[li], { content: llmComposed });
            break;
          }
        }
      }
      var bounded = buildBoundedChatMessages({
        platform: aiPlatform,
        model: aiModel,
        systemPrompt,
        serviceId: id.serviceId,
        history: historyForLlm
      });
      var run = this.dispatchAgentRequest({
        key,
        serviceId: id.serviceId,
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
        if (!(self.host.isViewMounted() && self.getHistoryCacheKey() === key)) return;
        self.state.sending = false;
        return Promise.resolve(self.typewriteLatestReply(key)).then(function() {
          self.host.scrollToBottom(true);
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
      if (existing._serverItemId !== void 0) promoted._serverItemId = existing._serverItemId;
      this.state.messages[nextIdx] = promoted;
      var placeholder = { role: "assistant", content: "", isPending: true, isPendingInProcess: true, isBackgroundTask: true };
      if (existing._serverItemId !== void 0) placeholder._serverItemId = existing._serverItemId;
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
      if (existing._serverItemId !== void 0) promoted._serverItemId = existing._serverItemId;
      if (existing.isSendingToServer) promoted.isSendingToServer = true;
      this.state.messages[nextIdx] = promoted;
      var placeholder = { role: "assistant", content: "", isPending: true };
      if (existing._serverItemId !== void 0) placeholder._serverItemId = existing._serverItemId;
      this.state.messages.splice(nextIdx + 1, 0, placeholder);
      this.host.notify();
    }
    resolveQueuedUserBubble(serverId) {
      var userIdx = -1;
      if (serverId) {
        userIdx = this.state.messages.findIndex(function(m) {
          return m._serverItemId === serverId && (m.isPendingInProcess || m.isPendingQueued) && m.role === "user" && !m.isBackgroundTask;
        });
      }
      if (userIdx === -1) {
        userIdx = this.state.messages.findIndex(function(m) {
          return m.isPendingInProcess && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue;
        });
      }
      if (userIdx === -1) {
        userIdx = this.state.messages.findIndex(function(m) {
          return m.isPendingQueued && m.role === "user" && !m.isBackgroundTask && !m._useBgQueue;
        });
      }
      if (serverId && this.cancelledServerIds.has(serverId)) {
        this.cancelledServerIds.delete(serverId);
        if (userIdx >= 0) {
          var ex = this.state.messages[userIdx];
          this.state.messages[userIdx] = { role: "user", content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId };
          var thIdx = this.state.messages.findIndex(function(m, i) {
            return i > userIdx && m.isPending && m.role === "assistant" && !m.isBackgroundTask;
          });
          if (thIdx !== -1) this.state.messages.splice(thIdx, 1);
        }
        this.promoteNextQueuedToRunning();
        return void 0;
      }
      if (userIdx >= 0) {
        var exist = this.state.messages[userIdx];
        var repl = { role: "user", content: exist.content };
        if (exist._serverItemId !== void 0) repl._serverItemId = exist._serverItemId;
        this.state.messages[userIdx] = repl;
      }
      var thinkingIdx = userIdx >= 0 ? this.state.messages.findIndex(function(m, i) {
        return i > userIdx && m.isPending && m.role === "assistant" && !m.isBackgroundTask;
      }) : -1;
      return thinkingIdx !== -1 ? thinkingIdx : userIdx >= 0 ? userIdx + 1 : -1;
    }
    insertAtTarget(msg, targetIdx) {
      if (targetIdx >= 0 && this.state.messages[targetIdx] && this.state.messages[targetIdx].isPending) this.state.messages[targetIdx] = msg;
      else if (targetIdx >= 0) this.state.messages.splice(targetIdx, 0, msg);
      else this.state.messages.push(msg);
    }
    onQueuedSendResponse(_composed, response, platform, serverId) {
      if (serverId) this.historyItemPolls.delete(serverId);
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
      this.host.scrollToBottom(true);
    }
    onQueuedSendError(_composed, err, serverId) {
      if (serverId) this.historyItemPolls.delete(serverId);
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
        this.host.scrollToBottom(true);
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
      this.host.scrollToBottom(true);
    }
    cancelQueuedMessage(msg, idx) {
      var self = this;
      var id = this.host.getIdentity();
      var serverId = msg._serverItemId;
      if (!serverId || msg._cancelling) return;
      var platform = id.platform;
      if (platform !== "claude" && platform !== "openai") return;
      var url = platform === "claude" ? ANTHROPIC_MESSAGES_API_URL : OPENAI_RESPONSES_API_URL;
      var queueBase = id.userId || id.serviceId;
      var queue = msg.isBackgroundTask || msg._useBgQueue ? queueBase + BG_INDEXING_QUEUE_SUFFIX : queueBase;
      this.state.messages[idx] = Object.assign({}, msg, { _cancelling: true, _cancelError: void 0 });
      this.host.notify();
      Promise.resolve(this.host.cancelRequest({
        url,
        method: "POST",
        id: serverId,
        queue,
        service: id.serviceId,
        owner: id.owner
      })).then(function(result) {
        if (result && result.removed) {
          self.cancelledServerIds.add(serverId);
          var qi = self.bgTaskQueue.findIndex(function(e) {
            return e.id === serverId;
          });
          if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
          var removeIdx = self.state.messages.findIndex(function(m) {
            return m._serverItemId === serverId && (m.isPendingQueued || m.isPendingInProcess) && m.role === "user";
          });
          if (removeIdx !== -1) {
            self.state.messages[removeIdx] = { role: "user", content: self.state.messages[removeIdx].content, isCancelled: true, _serverItemId: serverId };
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
    // Remove any leftover non-background pending ("Thinking…") assistant bubbles.
    // There is normally at most ONE such bubble at a time (promoteNext* refuses to
    // add a second), so any extra is a duplicate — it appears when a concurrent
    // history refetch re-maps the still-"running" turn into a pending placeholder
    // (with a real _serverItemId) while the local pending bubble (no _serverItemId)
    // is rescued and re-appended (see loadHistory rescue below). Each resolve path
    // only replaces the FIRST pending bubble, so without this a stray "Thinking…"
    // survives next to the reply/error. MUST run AFTER the resolved bubble has been
    // made non-pending and BEFORE promoteNext*() (so a freshly-promoted Thinking,
    // which is added only once no pending assistant remains, is preserved).
    _removeStrayPendingAssistants() {
      for (var k = this.state.messages.length - 1; k >= 0; k--) {
        var m = this.state.messages[k];
        if (m.isPending && m.role === "assistant" && !m.isBackgroundTask) this.state.messages.splice(k, 1);
      }
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
      this.host.scrollToBottom(true);
      return Promise.resolve(pending).catch(function() {
      }).then(function() {
        if (token !== self.state.gateRefreshToken) return;
        self.state.sending = false;
        return Promise.resolve(self.typewriteLatestReply(key)).then(function() {
          self.host.scrollToBottom(true);
        });
      });
    }
    // --- background-task resolution + drain -------------------------------
    handleHistoryItemResolution(itemId, response, platform) {
      this.applyHistoryItemResolution(itemId, response, platform);
      this.promoteNextBgQueuedToRunning();
    }
    applyHistoryItemResolution(itemId, response, platform) {
      this.historyItemPolls.delete(itemId);
      var isErr = isErrorResponseBody(response);
      var answer = isErr ? getErrorMessage(response) : ((platform === "openai" ? extractOpenAIText(response) : extractClaudeText(response)) || "").trim();
      var idx = this.state.messages.findIndex(function(m) {
        return m.isPending && m._serverItemId === itemId;
      });
      if (idx !== -1) {
        this._clearPendingUserBubble(itemId);
        if (isErr) {
          this.state.messages[idx] = { role: "assistant", content: answer, isError: true, _serverItemId: itemId };
          this.host.notify();
          this.updateHistoryCache();
          return;
        }
        var lid = this._newLocalId();
        this.state.messages[idx] = { role: "assistant", content: "", _localId: lid, _serverItemId: itemId };
        this.host.notify();
        this.enqueueTypewrite(idx, answer || "No text response received from AI provider.", lid);
        this.updateHistoryCache();
        return;
      }
      var userIdx = this.state.messages.findIndex(function(m) {
        return m.role === "user" && m._serverItemId === itemId && (m.isPendingQueued || m.isPendingInProcess);
      });
      if (userIdx === -1) return;
      var ex = this.state.messages[userIdx];
      this.state.messages[userIdx] = { role: "user", content: ex.content, _serverItemId: itemId };
      if (isErr) {
        this.state.messages.splice(userIdx + 1, 0, { role: "assistant", content: answer, isError: true, _serverItemId: itemId });
        this.host.notify();
        this.updateHistoryCache();
        return;
      }
      var lid2 = this._newLocalId();
      this.state.messages.splice(userIdx + 1, 0, { role: "assistant", content: "", _localId: lid2, _serverItemId: itemId });
      this.host.notify();
      this.enqueueTypewrite(userIdx + 1, answer || "No text response received from AI provider.", lid2);
      this.updateHistoryCache();
    }
    // Inject "Indexing: <file>" bubbles for queued bg tasks + attach their polls.
    drainBgTaskQueue() {
      var self = this;
      var id = this.host.getIdentity();
      var svcId = id.serviceId, plat = id.platform;
      if (!svcId || plat === "none" || !this.host.isViewMounted()) return;
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
        if (e.serviceId !== svcId || e.platform !== plat) continue;
        if (presentIds[e.id] && !pendingIds[e.id]) this.bgTaskQueue.splice(i, 1);
      }
      this.bgTaskQueue.forEach(function(entry) {
        if (entry.serviceId !== svcId || entry.platform !== plat) return;
        if (presentIds[entry.id]) return;
        var isRunning = entry.status === "running";
        var userBubble = { role: "user", content: self.host.formatIndexingLabel(entry.filename, entry.mime, entry.size, entry.storagePath, entry.isReindex), isBackgroundTask: true, _serverItemId: entry.id };
        if (isRunning) userBubble.isPendingInProcess = true;
        else userBubble.isPendingQueued = true;
        self.state.messages.push(userBubble);
        if (isRunning) {
          self.state.messages.push({ role: "assistant", content: "", isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: entry.id });
        }
        presentIds[entry.id] = true;
        self.host.notify();
        self.updateHistoryCache();
        self.host.scrollToBottom(false);
        if (!self.historyItemPolls.has(entry.id) && typeof entry.poll === "function") {
          self.historyItemPolls.set(entry.id, true);
          var capturedId = entry.id, capturedPlat = plat;
          entry.poll({ latency: POLL_INTERVAL }).then(function(response) {
            self.handleHistoryItemResolution(capturedId, response, capturedPlat);
          }).catch(function(err) {
            self.historyItemPolls.delete(capturedId);
            var isNotExists = err && (err.code === "NOT_EXISTS" || err.body && err.body.code === "NOT_EXISTS");
            var bi = self.state.messages.findIndex(function(m) {
              return m.isPending && m._serverItemId === capturedId;
            });
            if (bi !== -1) {
              if (isNotExists) self.state.messages.splice(bi, 1);
              else self.state.messages[bi] = { role: "assistant", content: getErrorMessage(err), isError: true, isBackgroundTask: true, _serverItemId: capturedId };
              self.host.notify();
              self.updateHistoryCache();
            }
          }).then(function() {
            var qi = self.bgTaskQueue.findIndex(function(q) {
              return q.id === capturedId;
            });
            if (qi !== -1) self.bgTaskQueue.splice(qi, 1);
          });
        }
      });
      this.promoteNextBgQueuedToRunning();
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
      if (token === void 0) token = this.state.gateRefreshToken;
      if (this.state.loadingHistory && this.state.historyRequestToken === token || id.platform === "none" || !id.serviceId) {
        return Promise.resolve();
      }
      this.state.historyRequestToken = token;
      this.state.loadingHistory = true;
      if (fetchMore) this.state.loadingOlderHistory = true;
      this.host.notify();
      var platform = id.platform;
      var serviceId = id.serviceId, owner = id.owner;
      var options = { fetchMore };
      if (fetchMore && this.state.historyStartKeyHistory.length) options.startKeyHistory = this.state.historyStartKeyHistory.slice();
      var fetchHistory = function() {
        return getChatHistory({ service: serviceId, owner, platform }, options);
      };
      return Promise.resolve().then(fetchHistory).catch(function(err) {
        if (isAuthExpiredError(err) && !isNonRetryableRequestError(err)) return self.host.refreshSession().then(fetchHistory);
        throw err;
      }).then(function(history) {
        if (token !== self.state.gateRefreshToken) return;
        var chatList = history && Array.isArray(history.list) ? history.list : [];
        chatList.forEach(function(item) {
          if (typeof item.queue_name === "string" && item.queue_name.slice(-BG_INDEXING_QUEUE_SUFFIX.length) === BG_INDEXING_QUEUE_SUFFIX) {
            var userText = extractLastUserTextFromRequest(item.request_body);
            if (typeof userText === "string" && userText.indexOf("A new file has just been uploaded") === 0) item._isBgTask = true;
            else item._isOnBgQueue = true;
          }
        });
        var list = chatList.sort(function(a, b) {
          var ai = typeof a.id === "string" ? a.id : "", bi = typeof b.id === "string" ? b.id : "";
          return ai > bi ? -1 : ai < bi ? 1 : 0;
        });
        var mapped = mapHistoryListToMessages(list, platform, {
          clearedAt: self.host.getClearedAt(),
          serviceId: id.serviceId,
          formatIndexingLabel: self.host.formatIndexingLabel
        }).messages;
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
            if (m.isCancelled && m._serverItemId) locallyCancelled[m._serverItemId] = 1;
          });
          var mappedHasPendingAssistant = mapped.some(function(m) {
            return m.isPending && m.role === "assistant" && !m.isBackgroundTask;
          });
          var rescued = [];
          for (var ri = 0; ri < self.state.messages.length; ri++) {
            var mm = self.state.messages[ri];
            if (mm.isBackgroundTask) continue;
            if (mm._serverItemId && serverIds[mm._serverItemId]) continue;
            if (!mm._serverItemId) {
              if (mappedHasPendingAssistant) continue;
              if (mm.isSendingToServer || mm.isPendingQueued || mm.isPendingInProcess || mm.isPending) rescued.push(mm);
              else if (self.state.sending && mm.role === "user") {
                var next = self.state.messages[ri + 1];
                if (next && !next.isBackgroundTask && next.isPending && !next._serverItemId) rescued.push(mm);
              }
            }
          }
          self.state.messages = mapped;
          rescued.forEach(function(m) {
            self.state.messages.push(m);
          });
          if (Object.keys(locallyCancelled).length) {
            for (var ci = 0; ci < self.state.messages.length; ci++) {
              var c = self.state.messages[ci];
              if (!c._serverItemId || !locallyCancelled[c._serverItemId] || c.isCancelled) continue;
              self.state.messages[ci] = { role: "user", content: c.content, isCancelled: true, _serverItemId: c._serverItemId };
              if (ci + 1 < self.state.messages.length && self.state.messages[ci + 1].isPending && self.state.messages[ci + 1]._serverItemId === c._serverItemId) {
                self.state.messages.splice(ci + 1, 1);
              }
            }
          }
        }
        self.state.historyEndOfList = !!(history && history.endOfList);
        self.state.historyStartKeyHistory = history && Array.isArray(history.startKeyHistory) ? history.startKeyHistory : [];
        var clearedAt = self.host.getClearedAt();
        if (clearedAt && chatList.length > 0) {
          var oldestUpdated = Number(chatList[chatList.length - 1] && chatList[chatList.length - 1].updated);
          if (isFinite(oldestUpdated) && oldestUpdated <= clearedAt) self.state.historyEndOfList = true;
        }
        if (self.state.historyRequestToken === token) {
          self.state.loadingHistory = false;
          self.state.loadingOlderHistory = false;
        }
        self.updateHistoryCache();
        self.host.notify();
        if (!fetchMore) {
          chatList.forEach(function(item) {
            if (item.status !== "running" && item.status !== "pending") return;
            if (!item.poll || !item.id) return;
            if (self.historyItemPolls.has(item.id)) return;
            if (self.pendingAgentRequests[self.getHistoryCacheKey()] && !item._isBgTask && !item._isOnBgQueue) return;
            self.historyItemPolls.set(item.id, true);
            var capturedId = item.id;
            var pp = item.poll({
              latency: POLL_INTERVAL,
              onResponse: function(response) {
                self.handleHistoryItemResolution(capturedId, response, platform);
              },
              onError: function(err) {
                self.historyItemPolls.delete(capturedId);
                var isNotExists = err && (err.code === "NOT_EXISTS" || err.body && err.body.code === "NOT_EXISTS");
                var aIdx = self.state.messages.findIndex(function(m) {
                  return m.isPending && m._serverItemId === capturedId;
                });
                if (isNotExists) {
                  var isBg = aIdx !== -1 ? !!self.state.messages[aIdx].isBackgroundTask : false;
                  if (aIdx !== -1) self.state.messages.splice(aIdx, 1);
                  if (!isBg) {
                    var uIdx = self.state.messages.findIndex(function(m) {
                      return m.role === "user" && m._serverItemId === capturedId && !m.isCancelled;
                    });
                    if (uIdx !== -1) {
                      var ex = self.state.messages[uIdx];
                      self.state.messages[uIdx] = { role: "user", content: ex.content, isCancelled: true, _serverItemId: ex._serverItemId };
                    }
                    self.cancelledServerIds.delete(capturedId);
                    self.promoteNextQueuedToRunning();
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
            if (pp && pp.catch) pp.catch(function() {
            });
          });
          self.drainBgTaskQueue();
        }
        if (!fetchMore) return self.host.scrollToBottom();
      }).catch(function(err) {
        console.warn("[chat-engine] getChatHistory failed", err);
      }).then(function() {
        if (self.state.historyRequestToken === token) {
          var wasLoading = self.state.loadingHistory || self.state.loadingOlderHistory;
          self.state.loadingHistory = false;
          self.state.loadingOlderHistory = false;
          if (wasLoading) self.host.notify();
        }
      });
    }
    // --- attachment upload orchestration ---------------------------------
    // Upload one attachment (a file = 1 member, a folder = N) to db storage and
    // queue indexing per member. The bytes I/O + chip rendering go through host
    // hooks; the overwrite/reindex flow, status lifecycle, and indexing live here.
    uploadSingleAttachment(att) {
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
            var preIndex = existedBefore && typeof self.host.deleteExistingFileRecord === "function" ? Promise.resolve(self.host.deleteExistingFileRecord(member.storagePath)).catch(function() {
            }) : Promise.resolve();
            return preIndex.then(function() {
              return parseAttachmentContent(member.file, member.file.name, mime || void 0);
            }).then(function(parsedContent) {
              return notifyAgentSaveAttachment({
                platform: id.platform,
                model: id.model,
                service: id.serviceId,
                owner: id.owner,
                userId: id.userId || id.serviceId,
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
                    serviceId: id.serviceId,
                    platform: id.platform,
                    id: ack.id,
                    filename: member.file.name,
                    storagePath: member.storagePath,
                    isReindex: hadExists,
                    mime: mime || void 0,
                    size: member.file.size,
                    status: ack.status === "running" ? "running" : "pending",
                    poll: ack.poll
                  });
                  self.drainBgTaskQueue();
                }
              }, function(e) {
                console.error("[chat-engine] indexing request failed", e);
                anyIndexFailed = true;
                if (!att.errorCode && !att.errorDetail) {
                  att.errorCode = e && (e.code || e.body && e.body.code) || "";
                  att.errorDetail = e && (e.message || e.body && e.body.message) || (typeof e === "string" ? e : "");
                }
              });
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
    uploadPendingAttachments() {
      var self = this;
      this.host.resetOverwriteBatch();
      this.state.uploadingAttachments = true;
      this.host.updateComposerControls();
      this.host.renderAttachmentChips();
      var collected = [];
      var snapshot = this.state.attachments.slice();
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
          return self.uploadSingleAttachment(att).then(function(us) {
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
        self.state.uploadingAttachments = false;
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

  // src/index.js
  (function() {
    var MCP_PROD = "https://mcp.broadwayinc.computer";
    var MCP_DEV = "https://mcp-dev.broadwayinc.computer";
    var BQ_VERSION = "1.5.4" ;
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
      clearHorizon: "bq_embed:clearedAt"
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
      var str = "";
      for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
      return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
      serviceId: null,
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
      return base + ":" + (S.serviceId || "default");
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
      S.serviceId = S.skapi && (S.skapi.service || S.skapi.connection && S.skapi.connection.service) || S.serviceId;
      S.owner = S.skapi && (S.skapi.owner || S.skapi.connection && S.skapi.connection.owner) || S.owner;
      return Promise.resolve().then(function() {
        if (typeof S.skapi.getConnectionInfo === "function") return S.skapi.getConnectionInfo();
        return S.skapi.connection || null;
      }).then(function(conn) {
        if (S.opts && S.opts.dev) console.log("[bunnyquery] loadServiceInfo", conn);
        if (conn) {
          S.serviceId = conn.service || S.serviceId;
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
    function pageRoot(content) {
      return h(
        "div",
        { class: "bq-meta" },
        h(
          "div",
          { class: "bq-section-title" },
          h(
            "div",
            { class: "bq-title-row" },
            h(
              "div",
              { class: "bq-title-left" },
              h("span", { class: "bq-agent-badge", text: agentBadgeText() })
            )
          )
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
        var form = h(
          "form",
          { class: "bq-form", onsubmit: submit },
          h("label", { class: "bq-label" }, h("span", { text: "Email" }), emailInput),
          h("label", { class: "bq-label" }, h("span", { text: "Password" }), pwInput),
          actions,
          errorBox,
          h("div", { class: "bq-form-bottom" }, submitBtn)
        );
        var children = authHeader("Login").concat([form]);
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
      messageEls: [],
      // parallel rendered .bq-message nodes
      messagesBox: null,
      // .bq-messages element
      sending: false,
      typing: false,
      typingAbort: false,
      typewriterQueue: Promise.resolve(),
      stickToBottom: true,
      loadingHistory: false,
      loadingOlderHistory: false,
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
      attachmentCapHit: false,
      // true once an add hit MAX_ATTACHMENT_FILE_COUNT; blocks the composer
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
    var fileBlobCache = /* @__PURE__ */ new Map();
    var markedReady = null;
    var session = new ChatSession({
      getIdentity: function() {
        return {
          serviceId: S.serviceId,
          owner: S.owner,
          userId: S.user && S.user.user_id || S.serviceId,
          platform: S.aiPlatform,
          model: S.aiModel || void 0,
          serviceName: S.serviceName,
          serviceDescription: S.serviceDescription
        };
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
        return scrollToBottom(smooth);
      },
      scrollToBottomIfSticky: function(smooth) {
        return scrollToBottomIfSticky(smooth);
      },
      cancelRequest: function(opts) {
        return S.skapi.cancelClientSecretRequest(opts);
      },
      refreshSession: function() {
        return refreshSkapiSession();
      },
      formatIndexingLabel: function(name, mime, size, storagePath, reindex) {
        return buildIndexingLabel(name, mime, size, storagePath, reindex);
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
        return resetOverwriteBatch();
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
        svg: "image/svg+xml"
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
      return buildChatSystemPrompt({
        formattedServiceId: S.serviceId || "",
        serviceName: S.serviceName,
        serviceDescription: S.serviceDescription
      });
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
    function sendMessage() {
      var inputEl = CS.messagesBox && CS.messagesBox.parentNode && CS.messagesBox.parentNode.querySelector(".bq-input");
      var text = (inputEl ? inputEl.value : "").trim();
      var hasAttachments = CS.attachments.length > 0;
      if (!text && !hasAttachments) return;
      if (!chatEnabled() || S.aiPlatform === "none") return;
      if (CS.uploadingAttachments) return;
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
      if (!hasAttachments) {
        session.dispatchComposedMessage(text, false);
        return;
      }
      var bgBefore = bgTaskQueue.length;
      session.uploadPendingAttachments().then(function(attachmentUrls) {
        var hasNewIndexing = bgTaskQueue.length > bgBefore;
        var failureGroups = groupAttachmentFailures(CS.attachments);
        clearSuccessfulAttachments();
        if (text) {
          var c = composeUserMessage(text, attachmentUrls);
          session.dispatchComposedMessage(c.composed, hasNewIndexing, c.composedForLlm, c.extractContent, c.fileUrls);
        }
        if (failureGroups.length) showUploadErrorReport(failureGroups);
      }).catch(function(err) {
        console.error("[bunnyquery] attachment upload failed", err);
        CS.uploadingAttachments = false;
        updateComposerControls();
        renderAttachmentChips();
        CS.messages.push({ role: "assistant", content: "Something went wrong while uploading attachments. " + (err && err.message || ""), isError: true });
        renderMessages();
        scrollToBottom(true);
      });
    }
    function scrollToBottom(smooth) {
      return raf2().then(function() {
        if (!CS.messagesBox) return;
        CS.stickToBottom = true;
        if (smooth) CS.messagesBox.scrollTo({ top: CS.messagesBox.scrollHeight, behavior: "smooth" });
        else CS.messagesBox.scrollTop = CS.messagesBox.scrollHeight;
      });
    }
    function scrollToBottomIfSticky(smooth) {
      if (!CS.stickToBottom) return Promise.resolve();
      return raf2().then(function() {
        if (!CS.stickToBottom || !CS.messagesBox) return;
        if (smooth) CS.messagesBox.scrollTo({ top: CS.messagesBox.scrollHeight, behavior: "smooth" });
        else CS.messagesBox.scrollTop = CS.messagesBox.scrollHeight;
      });
    }
    function onHistoryScroll() {
      if (!CS.messagesBox || CS.chatSettingsOpen) return;
      var el = CS.messagesBox;
      CS.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
      if (el.scrollTop <= 60) fetchOlderHistoryIfNeeded();
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
    function getOrCreateFileHref(filename, body) {
      var key = filename + "\0" + body;
      var existing = fileBlobCache.get(key);
      if (existing) return existing;
      var contentType = mimeGetType(filename) || "text/plain";
      var ext = (String(filename || "").split(".").pop() || "").toLowerCase();
      var isText = /^text\//i.test(contentType) || /application\/(json|xml|csv|yaml|x-yaml|javascript)/i.test(contentType);
      var needsBom = ext === "csv" || ext === "tsv" || ext === "tab";
      var type = isText ? contentType + "; charset=utf-8" : contentType;
      var data = needsBom ? "\uFEFF" + body : body;
      var href = URL.createObjectURL(new Blob([data], { type }));
      fileBlobCache.set(key, href);
      return href;
    }
    function fileToAnchorHtml(filename, href) {
      var text = "\u2197 " + filename;
      return '<a class="bq-file-download" href="' + escapeHtml(href) + '" download="' + escapeHtml(filename) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(text) + "</a>";
    }
    function linkToAnchorHtml(link) {
      var refreshing = !!refreshingLinkMap[link.expiredHref || link.href];
      var cls = ["bq-link-button"];
      if (link.expired) cls.push("is-expired");
      if (refreshing) cls.push("is-refreshing");
      var labelText = "\u2197 " + link.label + (refreshing ? " (fetching...)" : "");
      var attrs = [
        'class="' + cls.join(" ") + '"',
        'href="' + escapeHtml(link.href) + '"',
        'target="_blank"',
        'rel="noopener noreferrer"',
        'title="' + escapeHtml(link.fullLabel || link.label) + '"',
        'download="' + escapeHtml(link.fullLabel || link.label) + '"',
        'data-bq-link="1"'
      ];
      if (link.expired) attrs.push('data-bq-expired="1"');
      if (link.expiredHref) attrs.push('data-bq-expired-href="' + escapeHtml(link.expiredHref) + '"');
      if (link.remotePath) attrs.push('data-bq-remote-path="' + escapeHtml(link.remotePath) + '"');
      if (link.fullLabel) attrs.push('data-bq-full-label="' + escapeHtml(link.fullLabel) + '"');
      return "<a " + attrs.join(" ") + ">" + escapeHtml(labelText) + "</a>";
    }
    function buildLinkPartFromGroups(full, g1, g2, g3, g4, g5, g6) {
      var dbHostPrefix = "https://db." + hostDomain();
      if (g1) {
        var rawPath = normalizeTrailingInlineToken(g1);
        var consumed = "src::" + rawPath;
        var tail = full.slice(consumed.length);
        var isUrl = /^https?:\/\//i.test(rawPath);
        if (isUrl && /^https:\/\//i.test(rawPath) && rawPath.toLowerCase().indexOf(dbHostPrefix.toLowerCase()) !== 0) {
          return { part: { type: "link", label: truncateLabelForDisplay(rawPath), fullLabel: rawPath, href: rawPath, expired: false }, tail };
        }
        var remotePath = isUrl ? extractRemotePathFromAttachmentHref(rawPath, S.serviceId) || normalizeAttachmentPathCandidate(rawPath) : normalizeAttachmentPathCandidate(rawPath);
        if (!remotePath) return null;
        var expiredHref = buildDisplayExpiredAttachmentHref(remotePath, remotePath);
        var cached = refreshedExpiredLinkMap[expiredHref];
        return { part: { type: "link", label: truncateLabelForDisplay(remotePath), fullLabel: remotePath, href: cached || expiredHref, expired: !cached, expiredHref, remotePath }, tail };
      }
      if (g4 && g5) {
        var rp = normalizeAttachmentPathCandidate(g5);
        if (!rp) return null;
        var eh = buildDisplayExpiredAttachmentHref(rp, rp);
        var c2 = refreshedExpiredLinkMap[eh];
        return { part: { type: "link", label: truncateLabelForDisplay(g4), fullLabel: g4, href: c2 || eh, expired: !c2, expiredHref: eh, remotePath: rp } };
      }
      var originalHref = g3 || g6 || "";
      if (!originalHref) return null;
      if (/^https:\/\//i.test(originalHref) && originalHref.toLowerCase().indexOf(dbHostPrefix.toLowerCase()) !== 0) {
        var plainLabel = g2 || originalHref;
        return { part: { type: "link", label: truncateLabelForDisplay(plainLabel), fullLabel: plainLabel, href: originalHref, expired: false } };
      }
      var rmp = extractRemotePathFromAttachmentHref(originalHref, S.serviceId);
      var fbLabel = g2 || originalHref;
      var ehref = rmp ? buildDisplayExpiredAttachmentHref(rmp, fbLabel) : originalHref;
      var cfresh = refreshedExpiredLinkMap[ehref];
      var expired = !!rmp && !cfresh;
      var fullLabel = rmp ? getExpiredAttachmentVisiblePath(rmp, g2 || originalHref) : g2 || originalHref;
      return { part: { type: "link", label: truncateLabelForDisplay(fullLabel), fullLabel, href: cfresh || ehref, expired, expiredHref: ehref, remotePath: rmp || void 0 } };
    }
    function parseMsgPartsHtml(content) {
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
      var linkRe = createInlineLinkRegex();
      working = working.replace(linkRe, function(full) {
        var args = Array.prototype.slice.call(arguments, 1, 7);
        var built = buildLinkPartFromGroups(full, args[0], args[1], args[2], args[3], args[4], args[5]);
        if (!built) return full;
        return pushPlaceholder(linkToAnchorHtml(built.part)) + (built.tail || "");
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
    function buildIndexingLabel(name, mime, size, storagePath, reindex) {
      var extras = [];
      var nameLabel = storagePath ? "[" + name + "](" + storagePath + ")" : name;
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
        service: S.serviceId,
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
      return S.skapi.deleteRecords({ service: S.serviceId, unique_id: "src::" + storagePath }).catch(function() {
      });
    }
    function getTemporaryUrlDb(path, expires) {
      return S.skapi.util.request("get-signed-url", {
        service: S.serviceId,
        owner: S.owner,
        request: "get-db",
        key: path,
        expires: expires,
        contentType: mimeGetType(path) || "application/octet-stream",
        generate_temporary_cdn_url: true
      }, { auth: true, method: "post" }).then(function(res) {
        var u = typeof res === "string" ? res : res && res.url;
        if (!u) throw new Error("No temporary URL returned.");
        return "https://db." + hostDomain() + "/" + u;
      });
    }
    var ATTACH_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
    var FILE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    var FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    var MAX_CHATBOX_FILE_COUNT = 20;
    var MAX_ATTACHMENT_FILE_COUNT = 100;
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
    function attachmentsTokenEstimate() {
      var total = 0;
      CS.attachments.forEach(function(a) {
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
      CS.attachments.forEach(function(a) {
        n += a.kind === "folder" ? a.files ? a.files.length : 0 : 1;
      });
      return n;
    }
    function currentInputTokenBudget() {
      var platform = S.aiPlatform;
      if (platform !== "claude" && platform !== "openai") return 0;
      var contextWindow = getContextWindow(platform, S.aiModel);
      var contextBased = Math.max(MIN_INPUT_TOKEN_BUDGET, contextWindow - OUTPUT_TOKEN_RESERVE - TOOL_AND_RESPONSE_BUFFER);
      return platform === "claude" ? Math.min(contextBased, CLAUDE_PER_REQUEST_INPUT_CAP) : contextBased;
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
      if (CS.attachmentCapHit) {
        CS.attachmentWarning = "You can attach up to " + MAX_ATTACHMENT_FILE_COUNT + " files per message.";
        return;
      }
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
      if (dropped > 0) CS.attachmentCapHit = true;
      if (changed) {
        recomputeAttachmentWarning();
        renderAttachmentChips();
        scheduleAttachmentOverflowRecompute();
      } else if (dropped > 0) {
        recomputeAttachmentWarning();
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
    function readEntry(entry, prefix) {
      prefix = prefix || "";
      return new Promise(function(resolve) {
        if (!entry) {
          resolve([]);
          return;
        }
        if (entry.isFile) {
          entry.file(function(file) {
            resolve([{ file, path: prefix + file.name }]);
          }, function() {
            resolve([]);
          });
          return;
        }
        if (entry.isDirectory) {
          var reader = entry.createReader();
          var all = [];
          var readBatch = function() {
            reader.readEntries(function(entries) {
              if (!entries.length) {
                resolve(all);
                return;
              }
              Promise.all(entries.map(function(e) {
                return readEntry(e, prefix + entry.name + "/");
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
      CS.attachmentCapHit = false;
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
      CS.attachmentCapHit = false;
      recomputeAttachmentWarning();
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    function clearAttachments() {
      CS.attachments.forEach(function(a) {
        if (a._abort) {
          try {
            a._abort();
          } catch (e) {
          }
        }
      });
      CS.attachments = [];
      CS.attachmentWarning = "";
      CS.attachmentCapHit = false;
      renderAttachmentChips();
      updateComposerControls();
      scheduleAttachmentOverflowRecompute();
    }
    function clearSuccessfulAttachments() {
      CS.attachments = CS.attachments.filter(function(a) {
        return a.status === "error" || a.status === "indexError";
      });
      CS.attachments.forEach(function(a) {
        a._abort = null;
      });
      CS.attachmentCapHit = false;
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
      if (!CS.attachments.length && !CS.attachmentWarning) {
        row.style.display = "none";
        return;
      }
      row.style.display = "";
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
        var cls = "bq-attachment";
        if (att.status === "uploading") cls += " is-uploading";
        else if (att.status === "error") cls += " is-error";
        else if (att.status === "indexError") cls += " is-index-error";
        else if (att.status === "done") cls += " is-done";
        if (clickable) cls += " is-clickable";
        var chip = h("div", { class: cls });
        if (att.status === "uploading") chip.style.setProperty("--att-progress", (att.progress || 0) + "%");
        chip.title = att.status === "error" ? "File upload has failed" : att.status === "indexError" ? "File indexing failed" : clickable ? "Open " + att.name : isFolder ? att.name + "/ \u2014 " + (att.files ? att.files.length : 0) + " file(s)" : att.name;
        if (clickable) chip.addEventListener("click", function() {
          window.open(att.uploadedUrl, "_blank", "noopener,noreferrer");
        });
        chip.appendChild(h("span", { class: "bq-attachment-icon", html: isFolder ? FOLDER_ICON_SVG : FILE_ICON_SVG }));
        chip.appendChild(h("span", { class: "bq-attachment-name", text: att.name, title: att.name }));
        var meta = att.status === "error" ? "(Failed)" : att.status === "indexError" ? "(Error)" : att.status === "uploading" ? (att.progress || 0) + "%" : isFolder ? "(" + (att.files ? att.files.length : 0) + ")" : formatBytes(att.file ? att.file.size : att.size);
        chip.appendChild(h("span", { class: "bq-attachment-meta", text: meta }));
        if (clickable) chip.appendChild(h("span", { class: "bq-attachment-arrow", text: "\u2197" }));
        if (!CS.uploadingAttachments && att.status !== "done") {
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
        if (!CS.uploadingAttachments) {
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
        }
        row.appendChild(moreChip);
      } else if (!CS.uploadingAttachments && CS.attachments.length >= 2) {
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
      var conf = S.service && S.service.conf || {};
      if (!conf.freeze_database) return false;
      var ag = S.user && typeof S.user.access_group === "number" ? S.user.access_group : 0;
      return ag < 99;
    }
    function updateComposerControls() {
      var uploading = CS.uploadingAttachments;
      var blocked = uploading || CS.attachmentCapHit;
      if (CS.attachBtnEl) CS.attachBtnEl.disabled = blocked;
      if (CS.inputEl) CS.inputEl.disabled = blocked;
      if (CS.sendBtnEl) CS.sendBtnEl.disabled = blocked || !!CS.attachmentWarning;
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
          var entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
          entries.push(entry || it.getAsFile());
        }
        Promise.all(entries.map(function(entry2) {
          if (!entry2) return Promise.resolve(null);
          if (entry2 instanceof File) return Promise.resolve(newAttachment({ kind: "file", name: entry2.name, file: entry2 }));
          if (entry2.isFile) {
            return readEntry(entry2).then(function(files) {
              return files[0] ? newAttachment({ kind: "file", name: files[0].file.name, file: files[0].file }) : null;
            });
          }
          if (entry2.isDirectory) {
            return readEntry(entry2).then(function(files) {
              return newAttachment({ kind: "folder", name: entry2.name, files });
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
      return getTemporaryUrlDb(remotePath, ATTACHMENT_URL_EXPIRES_SECONDS);
    }
    function fetchFreshHrefForExpiredLink(expiredHref, remotePath) {
      var cached = refreshedExpiredLinkMap[expiredHref];
      if (cached) return Promise.resolve(cached);
      var inFlight = refreshingLinkPromises.get(expiredHref);
      if (inFlight) return inFlight;
      var run = (function() {
        refreshingLinkMap[expiredHref] = true;
        var resolved = remotePath || extractRemotePathFromAttachmentHref(expiredHref, S.serviceId);
        if (!resolved) return Promise.reject(new Error("Unable to refresh this expired attachment link."));
        return getPublicTemporaryUrl(resolved).then(function(fresh) {
          refreshedExpiredLinkMap[expiredHref] = fresh;
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
        alert(err && err.message || "Failed to refresh this expired link.");
      });
    }
    function getClearHistoryStorageKey() {
      if (!S.serviceId || S.aiPlatform === "none") return "";
      return SK.clearHorizon + ":" + S.serviceId + "#" + S.aiPlatform;
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
      if (CS.loadingHistory || CS.loadingOlderHistory || CS.historyEndOfList) return;
      var prevH = CS.messagesBox ? CS.messagesBox.scrollHeight : 0;
      var prevT = CS.messagesBox ? CS.messagesBox.scrollTop : 0;
      session.loadHistory(true).then(function() {
        if (!CS.messagesBox) return;
        raf2().then(function() {
          if (!CS.messagesBox) return;
          CS.messagesBox.scrollTop = prevT + (CS.messagesBox.scrollHeight - prevH);
        });
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
    }
    function buildMessageEl(msg, idx) {
      var cls = ["bq-message"];
      cls.push(msg.role === "user" ? "is-user" : "is-assistant");
      if (msg.isError) cls.push("is-error");
      if (msg.isCancelled) cls.push("is-cancelled");
      if (msg.isPendingQueued || msg.isPendingOlder) cls.push("is-pending-older");
      if (msg.isSendingToServer || msg._cancelling) cls.push("is-sending-to-server");
      var bubble;
      if (msg.isPending) {
        bubble = h("div", { class: "bq-bubble" }, h("span", { class: "bq-loader" }));
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
        var md = h("div", { class: "bq-md", html: parseMsgPartsHtml(msg.content) });
        md.addEventListener("click", onBubbleLinkClick);
        bubble.appendChild(md);
        if (msg.isPendingQueued) bubble.appendChild(h("span", { class: "bq-pending-note", text: "(In queue)" }));
        if (msg.isCancelled) bubble.appendChild(h("span", { class: "bq-cancel-error", text: "(cancelled)" }));
        if (msg._cancelError) bubble.appendChild(h("span", { class: "bq-cancel-error", text: msg._cancelError }));
      }
      return h("div", { class: cls.join(" "), dataset: { msgIndex: String(idx) } }, bubble);
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
        h("span", { text: "Fetching history" }),
        h("span", { class: "bq-loader" })
      );
    }
    function renderMessages() {
      if (!CS.messagesBox) return;
      if (CS.chatSettingsOpen) return;
      clear(CS.messagesBox);
      CS.messageEls = [];
      if (CS.loadingOlderHistory) CS.messagesBox.appendChild(historyLoadingEl(false));
      if (!CS.messages.length) {
        if (CS.loadingHistory && !CS.loadingOlderHistory) {
          CS.messagesBox.appendChild(historyLoadingEl(true));
          return;
        }
        var greet = h(
          "div",
          { class: "bq-message is-assistant bq-empty-greeting" },
          h(
            "div",
            { class: "bq-bubble" },
            document.createTextNode("Hi! Ask me anything about " + (S.serviceName ? '"' + S.serviceName + '"' : "your project") + ".")
          )
        );
        CS.messagesBox.appendChild(greet);
        return;
      }
      CS.messages.forEach(function(msg, idx) {
        var el = buildMessageEl(msg, idx);
        CS.messageEls.push(el);
        CS.messagesBox.appendChild(el);
      });
    }
    function refreshMessageBubble(idx) {
      if (idx < 0 || idx >= CS.messages.length) return;
      var oldEl = CS.messageEls[idx];
      if (!oldEl || !oldEl.parentNode) return;
      var newEl = buildMessageEl(CS.messages[idx], idx);
      oldEl.parentNode.replaceChild(newEl, oldEl);
      CS.messageEls[idx] = newEl;
    }
    function renderChat() {
      CS.messages = [];
      CS.messageEls = [];
      CS.sending = false;
      CS.typing = false;
      CS.typingAbort = true;
      CS.historyEndOfList = false;
      CS.historyStartKeyHistory = [];
      CS.stickToBottom = true;
      CS.attachments = [];
      CS.uploadingAttachments = false;
      CS.attachmentWarning = "";
      CS.attachmentCapHit = false;
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
          html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
          onclick: function() {
            toggleChatSettings();
          }
        });
        CS.settingsBtnEl = settingsBtn;
        var header = h(
          "div",
          { class: "bq-section-title" },
          h(
            "div",
            { class: "bq-title-row" },
            h("div", { class: "bq-title-left" }, h("span", { class: "bq-agent-badge", text: agentBadgeText() })),
            h("div", { class: "bq-title-right" }, settingsBtn)
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
          if (CS.attachmentWarning !== prev) {
            renderAttachmentChips();
            updateComposerControls();
            scheduleAttachmentOverflowRecompute();
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
        if (!attachDisabled) setupDragAndDrop(chatArea);
        return h("div", { class: "bq-meta" }, header, chatArea);
      });
      if (S.aiPlatform === "none") return;
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
    function agentBadgeText() {
      if (S.aiPlatform === "none") return "No agent configured";
      return S.serviceName || "BunnyQuery";
    }
    function parseAiAgentValue(value) {
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
      var parsed = parseAiAgentValue(raw);
      S.aiPlatform = parsed.platform;
      S.aiModel = parsed.model;
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
        S.service = conn;
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
        attachmentParsers: null
        // client-side attachment parsers, e.g. [createHwpParser()]
      }, opts || {});
      S.mountEl = mountEl;
      clear(mountEl);
      S.root = h("div", { class: "bq-agent" });
      mountEl.appendChild(S.root);
      applyTheme(loadTheme());
      S.booted = true;
      console.log("[bunnyquery] v" + BQ_VERSION);
      configureChatEngine({
        clientSecretRequest: function(o) {
          return S.skapi.clientSecretRequest(o);
        },
        clientSecretRequestHistory: function(p, f) {
          return S.skapi.clientSecretRequestHistory(p, f);
        },
        mcpBaseUrl: mcpBaseUrl(),
        poll: 0,
        // Client-side attachment parsers (e.g. an .hwp parser) passed via init opts.
        attachmentParsers: S.opts.attachmentParsers || void 0
      });
      if (!S._resizeBound && typeof window !== "undefined" && window.addEventListener) {
        S._resizeBound = true;
        window.addEventListener("resize", function() {
          scheduleAttachmentOverflowRecompute();
        });
      }
      if (!S._visBound && typeof document !== "undefined" && document.addEventListener) {
        S._visBound = true;
        document.addEventListener("visibilitychange", function() {
          if (document.visibilityState === "visible" && S.user) ensureMcpGrantFresh();
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
