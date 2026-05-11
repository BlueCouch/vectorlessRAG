/**
 * Indexer — Builds a hierarchical tree index from a document.
 *
 *
 * This is the core of Vectorless RAG: instead of chunking + embedding,
 * we ask an LLM to produce a structured table-of-contents-style tree
 * with summaries for each node.
 */

const fs = require("fs");
const https = require("https");
const http = require("http");

// ---------------------------------------------------------------------------
// Provider configs — each provider's endpoint, auth, and response parsing
// ---------------------------------------------------------------------------

const PROVIDERS = {
  openai: {
    hostname: "api.openai.com",
    path: "/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
    authHeader: (key) => `Bearer ${key}`,
    buildBody: (model, systemPrompt, userPrompt) => ({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
    parseResponse: (json) => json.choices[0].message.content,
  },
  gemini: {
    hostname: "generativelanguage.googleapis.com",
    pathFn: (model, key) =>
      `/v1beta/models/${model}:generateContent?key=${key}`,
    envKey: "GEMINI_API_KEY",
    authHeader: null, // key is in the URL
    buildBody: (_model, systemPrompt, userPrompt) => ({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    }),
    parseResponse: (json) => {
      if (json.error) throw new Error(json.error.message);
      return json.candidates[0].content.parts[0].text;
    },
  },
  anthropic: {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    envKey: "ANTHROPIC_API_KEY",
    authHeader: (key) => key, // uses x-api-key header instead
    extraHeaders: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
    buildBody: (model, systemPrompt, userPrompt) => ({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.2,
    }),
    parseResponse: (json) => {
      if (json.error) throw new Error(json.error.message);
      const block = json.content.find((b) => b.type === "text");
      return block ? block.text : "";
    },
  },
  ollama: {
    hostname: "localhost",
    port: 11434,
    path: "/api/chat",
    envKey: null, // no key needed
    authHeader: null,
    useHttp: true,
    buildBody: (model, systemPrompt, userPrompt) => ({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
      format: "json",
      options: { temperature: 0.2 },
    }),
    parseResponse: (json) => {
      const content =
        json && json.message && typeof json.message.content === "string"
          ? json.message.content
          : null;
      if (content === null) {
        throw new Error(
          `Unexpected ollama response shape (missing message.content). Keys: ${
            json && typeof json === "object"
              ? Object.keys(json).join(", ")
              : typeof json
          }`,
        );
      }
      return content;
    },
  },
};

// ---------------------------------------------------------------------------
// Ollama helpers
// ---------------------------------------------------------------------------

function httpRequestJson({
  hostname,
  port,
  path,
  method = "GET",
  headers,
  body,
}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = data ? JSON.parse(data) : null;
            if (res.statusCode && res.statusCode >= 400) {
              return reject(
                new Error(
                  `HTTP ${res.statusCode}${res.statusMessage ? ` ${res.statusMessage}` : ""}\n` +
                    `Raw: ${data.slice(0, 800)}`,
                ),
              );
            }
            resolve(json);
          } catch (e) {
            reject(
              new Error(
                `Failed to parse HTTP JSON: ${e.message}\nRaw: ${data.slice(0, 800)}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function listOllamaModels() {
  // https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models
  const json = await httpRequestJson({
    hostname: PROVIDERS.ollama.hostname,
    port: PROVIDERS.ollama.port,
    path: "/api/tags",
    method: "GET",
  });
  const models = (json && Array.isArray(json.models) ? json.models : [])
    .map((m) => (m && typeof m.name === "string" ? m.name : null))
    .filter(Boolean);
  return models;
}

function pickDefaultOllamaModel(installedModels, preferred) {
  if (!Array.isArray(installedModels) || installedModels.length === 0)
    return null;
  if (preferred && installedModels.includes(preferred)) return preferred;

  const candidates = [
    "llama3",
    "llama3:latest",
    "llama3.1",
    "llama3.1:latest",
    "llama3.2",
    "llama3.2:latest",
    "qwen2.5",
    "qwen2.5:latest",
    "mistral",
    "mistral:latest",
  ];
  for (const c of candidates) {
    if (installedModels.includes(c)) return c;
  }
  return installedModels[0];
}

// ---------------------------------------------------------------------------
// LLM helper — multi-provider, zero dependencies
// ---------------------------------------------------------------------------

function callLLM(apiKey, model, systemPrompt, userPrompt, provider = "ollama") {
  return new Promise((resolve, reject) => {
    const cfg = PROVIDERS[provider];
    if (!cfg) return reject(new Error(`Unknown provider: ${provider}`));

    const bodyObj = cfg.buildBody(model, systemPrompt, userPrompt);
    const body = JSON.stringify(bodyObj);

    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };

    if (cfg.extraHeaders) {
      Object.assign(headers, cfg.extraHeaders(apiKey));
    } else if (cfg.authHeader && apiKey) {
      headers["Authorization"] = cfg.authHeader(apiKey);
    }

    const reqPath = cfg.pathFn ? cfg.pathFn(model, apiKey) : cfg.path;

    const options = {
      hostname: cfg.hostname,
      port: cfg.port,
      path: reqPath,
      method: "POST",
      headers,
    };

    const transport = cfg.useHttp ? http : https;
    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          if (res.statusCode && res.statusCode >= 400) {
            const snippet = data ? data.slice(0, 800) : "";
            return reject(
              new Error(
                `${provider} HTTP ${res.statusCode}${res.statusMessage ? ` ${res.statusMessage}` : ""}\n` +
                  `Raw: ${snippet}`,
              ),
            );
          }
          const json = JSON.parse(data);
          if (json.error) {
            const msg =
              typeof json.error === "string"
                ? json.error
                : json.error &&
                    typeof json.error === "object" &&
                    "message" in json.error &&
                    json.error.message
                  ? json.error.message
                  : JSON.stringify(json.error);
            return reject(new Error(`${provider} error: ${msg}`));
          }
          resolve(cfg.parseResponse(json));
        } catch (e) {
          reject(
            new Error(
              `Failed to parse ${provider} response: ${e.message}\nRaw: ${data.slice(0, 500)}`,
            ),
          );
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Document parsing — split markdown into numbered "pages"
// ---------------------------------------------------------------------------

function parseMarkdownIntoPages(filePath, linesPerPage = 40) {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const pages = [];

  for (let i = 0; i < lines.length; i += linesPerPage) {
    const pageLines = lines.slice(i, i + linesPerPage);
    pages.push({
      pageNumber: pages.length + 1,
      text: pageLines.join("\n"),
    });
  }``

  return pages;
}

// ---------------------------------------------------------------------------
// Build hierarchical tree index via LLM
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a document indexing assistant. Your job is to analyze document content and produce a hierarchical tree structure (like a table of contents) with summaries.

You MUST respond with valid JSON only. No markdown, no explanation.`;

function buildIndexPrompt(pages) {
  let taggedContent = "";
  for (const page of pages) {
    taggedContent += `<page_${page.pageNumber}>\n${page.text}\n</page_${page.pageNumber}>\n\n`;
  }

  return `Analyze the following document and produce a hierarchical tree index.

DOCUMENT:
${taggedContent}

INSTRUCTIONS:
1. Identify the natural hierarchical structure (sections, subsections).
2. For each node, provide:
   - "title": section title
   - "start_page": first page number where the section starts
   - "end_page": last page number where the section ends
   - "summary": a concise 1-2 sentence summary of what this section covers
   - "children": array of child nodes (subsections), or empty array if leaf node
3. The root should be the document itself.
4. Every page must be covered by at least one leaf node.

Respond with this exact JSON structure:
{
  "title": "Document Title",
  "start_page": 1,
  "end_page": <last page>,
  "summary": "Overall document summary",
  "children": [
    {
      "title": "Section Title",
      "start_page": N,
      "end_page": M,
      "summary": "Section summary",
      "children": [...]
    }
  ]
}`;
}

async function buildIndex(
  filePath,
  apiKey,
  model = "gpt-4o-mini",
  provider = "openai",
) {
  console.log(`\n📄 Parsing document: ${filePath}`);
  const pages = parseMarkdownIntoPages(filePath);
  console.log(`   Found ${pages.length} pages`);

  console.log(
    `\n🌳 Building hierarchical tree index via LLM (${provider}/${model})...`,
  );
  const response = await callLLM(
    apiKey,
    model,
    SYSTEM_PROMPT,
    buildIndexPrompt(pages),
    provider,
  );

  let tree;
  try {
    tree = JSON.parse(response);
  } catch (e) {
    throw new Error(`Failed to parse LLM response as JSON: ${e.message}`);
  }

  // Assign node IDs for easy reference
  assignNodeIds(tree);

  const index = {
    source: filePath,
    model,
    created_at: new Date().toISOString(),
    total_pages: pages.length,
    tree,
    pages, // store pages for retrieval later
  };

  return index;
}

// ---------------------------------------------------------------------------
// Assign unique node IDs (depth-first)
// ---------------------------------------------------------------------------

function assignNodeIds(node, prefix = "0") {
  node.node_id = prefix;
  if (node.children) {
    node.children.forEach((child, i) => {
      assignNodeIds(child, `${prefix}.${i + 1}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Save / load index
// ---------------------------------------------------------------------------

function saveIndex(index, outputPath) {
  // Save without pages to keep the index file small
  const indexOnly = { ...index, pages: undefined };
  fs.writeFileSync(outputPath, JSON.stringify(indexOnly, null, 2));
  console.log(`\n💾 Index saved to: ${outputPath}`);
  return outputPath;
}

function loadIndex(indexPath, docPath) {
  const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  // Reload pages from original document
  if (docPath) {
    index.pages = parseMarkdownIntoPages(docPath);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Utility: print tree for visualization
// ---------------------------------------------------------------------------

function printTree(node, indent = 0) {
  const pad = "  ".repeat(indent);
  const pages = `[pages ${node.start_page}-${node.end_page}]`;
  console.log(`${pad}${node.node_id} ${node.title} ${pages}`);
  if (node.summary) {
    console.log(`${pad}  → ${node.summary}`);
  }
  if (node.children) {
    node.children.forEach((child) => printTree(child, indent + 1));
  }
}

module.exports = {
  PROVIDERS,
  callLLM,
  listOllamaModels,
  pickDefaultOllamaModel,
  parseMarkdownIntoPages,
  buildIndex,
  saveIndex,
  loadIndex,
  printTree,
};
