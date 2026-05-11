#!/usr/bin/env node

/**
 * Vectorless RAG Demo — JavaScript Implementation
 *
 *
 * Usage:
 *   node index.js --file ./sample-data/sample-doc.md
 *   node index.js --file ./sample-data/sample-doc.md --model gpt-4o
 *   node index.js --index ./index.json --file ./sample-data/sample-doc.md   (skip indexing, use saved index)
 *
 * Environment:
 *   OPENAI_API_KEY=sk-...
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { buildIndex, saveIndex, loadIndex, printTree } = require("./indexer");

// ---------------------------------------------------------------------------
// Load .env file (no dotenv dependency)
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPaths = [
    path.resolve(__dirname, "..", ".env"),
    path.resolve(__dirname, ".env"),
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      return;
    }
  }
}

loadEnv();
const { retrieve } = require("./retriever");

// ---------------------------------------------------------------------------
// CLI argument parsing (no dependencies)
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    file: null,
    index: null,
    provider: "gemini",
    model: null, // set after provider is known
    modelExplicit: false,
    linesPerPage: 40,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--file":
      case "-f":
        opts.file = args[++i];
        break;
      case "--index":
      case "-i":
        opts.index = args[++i];
        break;
      case "--provider":
      case "-p":
        opts.provider = args[++i];
        break;
      case "--model":
      case "-m":
        opts.model = args[++i];
        opts.modelExplicit = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
    }
  }

  // Set default model per provider if not explicitly specified
  if (!opts.model) {
    const defaults = {
      openai: "gpt-4o-mini",
      gemini: "gemini-2.0-flash",
      anthropic: "claude-sonnet-4-20250514",
      ollama: "llama3",
    };
    opts.model = defaults[opts.provider] || "gpt-4o-mini";
  }

  return opts;
}

function printUsage() {
  console.log(`
─────────────────────────────────
Usage:
  node index.js --file <path>           Build index and start querying
  node index.js --index <json> --file <path>  Load existing index

Options:
  --file, -f      Path to markdown/text file (required)
  --index, -i     Path to saved index JSON (skip indexing step)
  --provider, -p  LLM provider: openai, gemini, anthropic, ollama (default: openai)
  --model, -m     Model name (default: auto per provider)
  --help, -h      Show this help

Environment (set in .env or shell):
  OPENAI_API_KEY      For OpenAI (default)
  GEMINI_API_KEY      For Google Gemini
  ANTHROPIC_API_KEY   For Anthropic Claude
  (Ollama needs no key — runs locally)
`);
}

// ---------------------------------------------------------------------------
// Interactive query loop
// ---------------------------------------------------------------------------

function askQuestion(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function queryLoop(index, apiKey, model, provider = "openai") {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n" + "═".repeat(60));
  console.log("  Vectorless RAG — Interactive Query Mode");
  console.log("  Type your question and press Enter.");
  console.log('  Type "quit" or "exit" to stop.');
  console.log('  Type "tree" to view the document index.');
  console.log("═".repeat(60));

  while (true) {
    const question = await askQuestion(rl, "\n❓ Your question: ");
    const trimmed = question.trim();

    if (!trimmed) continue;
    if (trimmed === "quit" || trimmed === "exit") break;
    if (trimmed === "tree") {
      console.log("\n📋 Document Index:");
      printTree(index.tree);
      continue;
    }

    try {
      const result = await retrieve(trimmed, index, apiKey, model, provider);

      console.log("\n" + "─".repeat(60));
      console.log("📝 ANSWER:");
      console.log("─".repeat(60));
      console.log(result.answer);
      console.log("\n📌 Sources:");
      for (const src of result.sources) {
        console.log(`   • ${src.title} (Pages ${src.pages})`);
      }
      console.log("─".repeat(60));
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}`);
    }
  }

  rl.close();
  console.log("\nGoodbye!");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  if (!opts.file) {
    printUsage();
    console.error("Error: --file is required\n");
    process.exit(1);
  }

  // Resolve API key for the chosen provider
  const { PROVIDERS } = require("./indexer");
  const providerCfg = PROVIDERS[opts.provider];
  if (!providerCfg) {
    console.error(
      `Error: Unknown provider "${opts.provider}". Choose from: openai, gemini, anthropic, ollama`,
    );
    process.exit(1);
  }

  const envKey = providerCfg.envKey;
  const apiKey = envKey ? process.env[envKey] : null;
  if (envKey && !apiKey) {
    console.error(
      `Error: ${envKey} environment variable is not set (required for ${opts.provider})`,
    );
    process.exit(1);
  }

  console.log(`🤖 Provider: ${opts.provider} | Model: ${opts.model}`);

  const filePath = path.resolve(opts.file);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  let index;

  if (opts.index) {
    // Load existing index
    console.log(`📂 Loading existing index: ${opts.index}`);
    index = loadIndex(path.resolve(opts.index), filePath);
    console.log("   Index loaded successfully");
  } else {
    if (opts.provider === "ollama" && !opts.modelExplicit) {
      const { listOllamaModels, pickDefaultOllamaModel } = require("./indexer");
      const installed = await listOllamaModels().catch(() => []);
      const picked = pickDefaultOllamaModel(installed, opts.model);
      if (picked && picked !== opts.model) {
        console.log(
          `ℹ️  Ollama: "${opts.model}" not installed; using "${picked}"`,
        );
        opts.model = picked;
      }
    }
    // Build new index
    index = await buildIndex(filePath, apiKey, opts.model, opts.provider);

    // Print the tree
    console.log("\n📋 Document Index:");
    printTree(index.tree);

    // Save index for reuse
    const indexPath = filePath.replace(/\.[^.]+$/, "_index.json");
    saveIndex(index, indexPath);
  }

  // Enter interactive query mode
  await queryLoop(index, apiKey, opts.model, opts.provider);
}

main().catch((err) => {
  const message =
    err && typeof err === "object" && "message" in err
      ? err.message
      : String(err);
  console.error(`\nFatal error: ${message}`);
  if (err && typeof err === "object" && "stack" in err && err.stack) {
    console.error(err.stack);
  } else if (err) {
    console.error(err);
  }
  process.exit(1);
});
