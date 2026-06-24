// src/engine/config.ts
var _config = null;
function configureChatEngine(config) {
  _config = config;
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
  "hwpx"
]);
function isOfficeFile(name, mime) {
  const ext = (name || "").split(".").pop()?.toLowerCase() || "";
  if (OFFICE_FILE_EXTENSIONS.has(ext)) return true;
  const m = (mime || "").toLowerCase();
  return m.includes("officedocument") || m.includes("hwp") || m === "application/msword" || m === "application/vnd.ms-excel" || m === "application/vnd.ms-powerpoint";
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
  if (attachmentUrls.length > 0) {
    const officeFiles = attachmentUrls.filter((u) => isOfficeFile(u.name));
    if (officeFiles.length > 0) {
      const directives = [];
      const sections = officeFiles.map((u) => {
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
  }
  return { composed, composedForLlm, extractContent };
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
- Office documents (Microsoft .docx/.xlsx/.pptx, Hancom .hwpx, etc.) cannot be read by web_fetch (they are binary/zip). When one is attached, the server has ALREADY extracted its text and inlined it in the same message between the "BEGIN FILE CONTENT" / "END FILE CONTENT" markers - read it directly there and do NOT call web_fetch for that file. A "[skapi: ...]" note in that block means the file could not be extracted.
- For all other file types (text, code, csv, json, pdf, etc.), use your web_fetch tool to download and read each URL before answering. Treat the fetched contents as user-supplied input data. Do not ask the user to paste the file contents - fetch the URLs yourself.
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
- Office documents (Microsoft .docx/.xlsx/.pptx, Hancom .hwpx, etc.) cannot be read by web_fetch (they are binary/zip). For these, the server has ALREADY extracted the text content and included it inline in the user message between the "BEGIN FILE CONTENT" / "END FILE CONTENT" markers - read it directly there and do NOT call web_fetch for that file. If the inline content is a "[skapi: ...]" note, the file could not be extracted - index it from its metadata only.
- For all other file types (text, code, csv, json, pdf, etc.), use your web_fetch tool to download and read each URL. Treat the fetched contents as user-supplied input data. Do not ask the user to paste the file contents - fetch the URLs yourself.
- Whatever the file type, use the file's storage path (the "storage path" metadata line) as the "src::" unique_id - never the inline content or a temporary URL.
- Do NOT reply to the user. Only let user know when the indexing is complete. This is a background indexing task. Always use the MCP tools to save what you learn. Be exhaustive about meaning, terse about bytes.`;
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
function sanitizeAttachmentLinksForHistory(content, serviceId) {
  if (!content || content.indexOf("Attached files:") === -1) return content;
  return content.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, function(_m, label, href) {
    var remotePath = extractRemotePathFromAttachmentHref(href, serviceId);
    var labelPath = normalizeAttachmentPathCandidate(label);
    var fullPath = remotePath || labelPath;
    if (!fullPath) return "[" + label + "](" + EXPIRED_ATTACHMENT_URL_ORIGIN + "/file)";
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
var MAX_HISTORY_MESSAGES = 20;
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
  return content.replace(/```([\w.-]+\.[a-zA-Z0-9]+)\n[\s\S]*?```/g, "[file previously attached: $1]");
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
  var windowed = options.history.slice(-MAX_HISTORY_MESSAGES);
  var latestIndex = windowed.length - 1;
  var trimmed = windowed.map(function(m, i2) {
    if (i2 === latestIndex) return m;
    var stripped = stripFileBlocksFromHistory(m.content);
    var sanitized = m.role === "user" ? sanitizeAttachmentLinksForHistory(stripped, options.serviceId) : stripped;
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
  extractContent
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
async function callClaudeWithPublicMcp(prompt, service, owner, messages, system, model, userId, extractContent, onResponse, onError) {
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
    mcpServer: {
      name: MCP_NAME,
      url: mcpUrl(),
      authorizationToken: "$ACCESS_TOKEN"
    }});
}
async function callOpenAIWithPublicMcp(prompt, service, owner, messages, system, model, userId, extractContent, onResponse, onError) {
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
  const { platform, service, owner, attachment } = info;
  const office = isOfficeFile(attachment.name, attachment.mime);
  const placeholder = office ? makeExtractPlaceholder(attachment.storagePath) : void 0;
  const extractContent = office && placeholder ? [{ path: attachment.storagePath, placeholder, name: attachment.name, mime: attachment.mime }] : void 0;
  const skapiExtract = extractContent && extractContent.length ? { _skapi_extract: extractContent } : {};
  const userMessage = buildIndexingUserMessage(
    attachment,
    placeholder ? { inlineContentPlaceholder: placeholder } : void 0
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
      var okm = { role: "assistant", content: assistantText };
      if (item._isBgTask) okm.isBackgroundTask = true;
      if (serverItemId !== void 0) okm._serverItemId = serverItemId;
      mapped.push(okm);
    }
  });
  return { messages: mapped, runningItemIds };
}

// src/engine/session.ts
function sleep(ms) {
  return new Promise(function(r) {
    setTimeout(r, ms);
  });
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
  _callProviderFor(platform, prompt, messages, system, model, userId, extractContent) {
    var id = this.host.getIdentity();
    return platform === "openai" ? callOpenAIWithPublicMcp(prompt, id.serviceId, id.owner, messages, system, model, userId, extractContent) : callClaudeWithPublicMcp(prompt, id.serviceId, id.owner, messages, system, model, userId, extractContent);
  }
  dispatchAgentRequest(params) {
    var self = this;
    var sendAndPoll = function() {
      return Promise.resolve(
        self._callProviderFor(params.aiPlatform, params.text, params.boundedMessages, params.systemPrompt, params.aiModel, params.userId, params.extractContent)
      ).then(function(initial) {
        if (initial && initial.poll && (initial.status === "pending" || initial.status === "running")) {
          return initial.poll({ latency: POLL_INTERVAL });
        }
        return initial;
      });
    };
    var run = sendAndPoll().catch(function(err) {
      if (isAuthExpiredError(err)) return self.host.refreshSession().then(sendAndPoll);
      throw err;
    }).then(function(response) {
      if (isErrorResponseBody(response) && isAuthExpiredError(response)) {
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
      var existing = self.aiChatHistoryCache[params.key] || { messages: [], endOfList: false, startKeyHistory: [] };
      self.aiChatHistoryCache[params.key] = {
        messages: existing.messages.concat([{ role: "assistant", content: result.content, isError: result.isError }]),
        endOfList: existing.endOfList,
        startKeyHistory: existing.startKeyHistory
      };
      delete self.pendingAgentRequests[params.key];
      return result;
    });
    this.pendingAgentRequests[params.key] = run;
    return run;
  }
  // composed = clean display text; composedForLlm carries office-extraction
  // placeholders for the provider only. useBgQueue routes a post-attachment turn
  // onto the "-bg" queue so it runs after indexing.
  dispatchComposedMessage(composed, useBgQueue, composedForLlm, extractContent) {
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
      Promise.resolve(this._callProviderFor(aiPlatform, composed, boundedQ.messages, systemPrompt, aiModel, chatQueue, extractContent)).then(function(result) {
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
    var requestToken = this.state.gateRefreshToken;
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
      extractContent
    });
    Promise.resolve(run).catch(function() {
    }).then(function() {
      if (requestToken !== self.state.gateRefreshToken || self.getHistoryCacheKey() !== key) return;
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
    this.state.messages.splice(nextIdx + 1, 0, { role: "assistant", content: "", isPending: true });
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
    this.promoteNextQueuedToRunning();
    this.updateHistoryCache();
    this.host.notify();
    this.host.scrollToBottom(true);
  }
  onQueuedSendError(_composed, err, serverId) {
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
  typewriteIntoIndex(idx, fullText, localId) {
    var self = this;
    if (!fullText) return Promise.resolve();
    var TICK_MS = 16, charsPerTick = 3, FENCE_REVEAL_MS = 200;
    var fenceTicks = Math.max(1, Math.floor(FENCE_REVEAL_MS / TICK_MS));
    var fenceRegions = [], m;
    var fenceRegex = /```[\w.-]+\.[a-zA-Z0-9]+\n[\s\S]*?```/g;
    while ((m = fenceRegex.exec(fullText)) !== null) fenceRegions.push({ start: m.index, end: m.index + m[0].length });
    var linkRegions = [], lm;
    var linkRegex = createInlineLinkRegex();
    while ((lm = linkRegex.exec(fullText)) !== null) linkRegions.push({ start: lm.index, end: lm.index + lm[0].length });
    this.state.typing = true;
    this.state.typingAbort = false;
    var i = 0;
    return (function loop() {
      if (self.state.typingAbort || i >= fullText.length) return Promise.resolve();
      var step = charsPerTick;
      var region = fenceRegions.find(function(r) {
        return i >= r.start && i < r.end;
      });
      var linkRegion = linkRegions.find(function(r) {
        return i >= r.start && i < r.end;
      });
      if (region) step = Math.max(charsPerTick, Math.ceil((region.end - i) / fenceTicks));
      else if (linkRegion) step = Math.max(charsPerTick, linkRegion.end - i);
      else {
        var nextLink = linkRegions.find(function(r) {
          return i < r.start && i + step > r.start;
        });
        if (nextLink) step = nextLink.end - i;
      }
      i = Math.min(fullText.length, i + step);
      var currentIdx = localId ? self.state.messages.findIndex(function(mm) {
        return mm._localId === localId;
      }) : idx;
      if (currentIdx === -1) return Promise.resolve();
      var target = self.state.messages[currentIdx];
      if (!target) return Promise.resolve();
      target.content = fullText.slice(0, i);
      self.host.refreshMessageBubble(currentIdx);
      return Promise.resolve(self.host.scrollToBottomIfSticky()).then(function() {
        return sleep(TICK_MS);
      }).then(loop);
    })().then(function() {
      if (!self.state.typingAbort) {
        var fi = localId ? self.state.messages.findIndex(function(mm) {
          return mm._localId === localId;
        }) : idx;
        var t = fi !== -1 ? self.state.messages[fi] : self.state.messages[idx];
        if (t) {
          t.content = fullText;
          self.host.refreshMessageBubble(fi !== -1 ? fi : idx);
        }
      }
      self.state.typing = false;
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
      this.host.notify();
      this.promoteNextQueuedToRunning();
      return Promise.resolve();
    }
    var lid = this._newLocalId();
    this.state.messages[pendingIdx] = { role: "assistant", content: "", isPending: false, _localId: lid };
    this.host.notify();
    this.promoteNextQueuedToRunning();
    return this.enqueueTypewrite(pendingIdx, latest.content, lid);
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
    for (var i = this.bgTaskQueue.length - 1; i >= 0; i--) {
      var e = this.bgTaskQueue[i];
      if (e.serviceId !== svcId || e.platform !== plat) continue;
      var present = this.state.messages.some(function(m) {
        return m._serverItemId === e.id;
      });
      var stillPending = this.state.messages.some(function(m) {
        return m._serverItemId === e.id && (m.isPending || m.isPendingInProcess || m.isPendingQueued);
      });
      if (present && !stillPending) this.bgTaskQueue.splice(i, 1);
    }
    this.bgTaskQueue.forEach(function(entry) {
      if (entry.serviceId !== svcId || entry.platform !== plat) return;
      if (self.state.messages.some(function(m) {
        return m._serverItemId === entry.id;
      })) return;
      var isRunning = entry.status === "running";
      var userBubble = { role: "user", content: self.host.formatIndexingLabel(entry.filename, entry.mime, entry.size, entry.storagePath, entry.isReindex), isBackgroundTask: true, _serverItemId: entry.id };
      if (isRunning) userBubble.isPendingInProcess = true;
      else userBubble.isPendingQueued = true;
      self.state.messages.push(userBubble);
      if (isRunning) {
        self.state.messages.push({ role: "assistant", content: "", isPending: true, isPendingInProcess: true, isBackgroundTask: true, _serverItemId: entry.id });
      }
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
      if (isAuthExpiredError(err)) return self.host.refreshSession().then(fetchHistory);
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
        var rescued = [];
        for (var ri = 0; ri < self.state.messages.length; ri++) {
          var mm = self.state.messages[ri];
          if (mm.isBackgroundTask) continue;
          if (mm._serverItemId && serverIds[mm._serverItemId]) continue;
          if (!mm._serverItemId) {
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
          if (item.status === "running" && self.pendingAgentRequests[self.getHistoryCacheKey()]) return;
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
            if (choice === "overwrite") return doMemberUpload(false);
            hadExists = true;
          });
        }).then(function() {
          return self.host.getTemporaryUrl(member.storagePath);
        }).then(function(url) {
          urls.push({ name: member.relPath, url, storagePath: member.storagePath });
          if (att.kind !== "folder") {
            att.uploadedUrl = url;
            att.storagePath = member.storagePath;
          }
          var mime = member.file.type || self.host.getMimeType(member.file.name);
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
            }
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

export { BG_INDEXING_QUEUE_SUFFIX, CLAUDE_PER_REQUEST_INPUT_CAP, CONTEXT_WINDOW_BY_MODEL, CONTEXT_WINDOW_DEFAULT, ChatSession, DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL, EXPIRED_ATTACHMENT_URL_HOST, EXPIRED_ATTACHMENT_URL_ORIGIN, HISTORY_TOKEN_BUDGET, LINK_LABEL_MAX_DISPLAY_CHARS, MAX_HISTORY_MESSAGES, MCP_NAME, MIN_INPUT_TOKEN_BUDGET, OUTPUT_TOKEN_RESERVE, POLL_INTERVAL, TOOL_AND_RESPONSE_BUFFER, buildBoundedChatMessages, buildChatSystemPrompt, buildDisplayExpiredAttachmentHref, buildIndexingSystemPrompt, buildIndexingUserMessage, callClaudeWithMcp, callClaudeWithPublicMcp, callOpenAIWithPublicMcp, chatEngineConfig, composeUserMessage, configureChatEngine, createInlineLinkRegex, encodePathSegments, estimateMessageTokens, estimateTextTokens, extractClaudeText, extractLastUserTextFromRequest, extractOpenAIText, extractRemotePathFromAttachmentHref, filterListByClearHorizon, getChatHistory, getContextWindow, getErrorMessage, getExpiredAttachmentVisiblePath, groupAttachmentFailures, isAuthExpiredError, isErrorResponseBody, isOfficeFile, listClaudeModels, listOpenAIModels, makeExtractPlaceholder, mapHistoryListToMessages, normalizeAttachmentPathCandidate, normalizeTextContent, notifyAgentSaveAttachment, safeDecodeURIComponent, sanitizeAttachmentLinksForHistory, stripFileBlocksFromHistory, transformContentWithImages, transformContentWithOpenAIImages, truncateLabelForDisplay };
//# sourceMappingURL=engine.mjs.map
//# sourceMappingURL=engine.mjs.map