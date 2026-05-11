/**
 * Retriever — LLM-driven tree traversal for Vectorless RAG.
 *
 *
 * Instead of vector similarity search, the LLM reads the tree index
 * (titles + summaries) and REASONS about which nodes contain the answer.
 * Then it reads only those sections and generates a grounded answer.
 */

const { callLLM } = require("./indexer");

// ---------------------------------------------------------------------------
// Step 1: Tree search — LLM reasons over the tree to find relevant nodes
// ---------------------------------------------------------------------------

function stripTextFromTree(node) {
  const slim = {
    node_id: node.node_id,
    title: node.title,
    start_page: node.start_page,
    end_page: node.end_page,
    summary: node.summary,
  };
  if (node.children && node.children.length > 0) {
    slim.children = node.children.map(stripTextFromTree);
  }
  return slim;
}

function buildSearchPrompt(query, tree) {
  const slimTree = stripTextFromTree(tree);

  return `You are given a user question and a hierarchical tree index of a document.
Each node has a node_id, title, page range, and summary.

Your task: reason about which nodes are most likely to contain the answer.

QUESTION: ${query}

DOCUMENT TREE:
${JSON.stringify(slimTree, null, 2)}

INSTRUCTIONS:
1. Think step-by-step about which sections are relevant to the question.
2. Select the most specific nodes (prefer leaf nodes over parents when possible).
3. Return your answer as JSON.

{
  "thinking": "Your reasoning about which sections are relevant and why",
  "selected_nodes": ["node_id_1", "node_id_2"]
}`;
}

async function searchTree(query, tree, apiKey, model, provider) {
  const response = await callLLM(
    apiKey,
    model,
    "You are a document retrieval assistant. Respond with valid JSON only.",
    buildSearchPrompt(query, tree),
    provider
  );

  const result = JSON.parse(response);
  return result;
}

// ---------------------------------------------------------------------------
// Step 2: Extract text from selected nodes
// ---------------------------------------------------------------------------

function collectAllNodes(node) {
  const nodes = [node];
  if (node.children) {
    for (const child of node.children) {
      nodes.push(...collectAllNodes(child));
    }
  }
  return nodes;
}

function extractContext(selectedNodeIds, tree, pages) {
  const allNodes = collectAllNodes(tree);
  const contexts = [];

  for (const nodeId of selectedNodeIds) {
    const node = allNodes.find((n) => n.node_id === nodeId);
    if (!node) continue;

    // Gather page text for this node's range
    const nodePages = pages.filter(
      (p) => p.pageNumber >= node.start_page && p.pageNumber <= node.end_page
    );
    const text = nodePages.map((p) => p.text).join("\n\n");

    contexts.push({
      node_id: node.node_id,
      title: node.title,
      pages: `${node.start_page}-${node.end_page}`,
      text,
    });
  }

  return contexts;
}

// ---------------------------------------------------------------------------
// Step 3: Generate answer from retrieved context
// ---------------------------------------------------------------------------

function buildAnswerPrompt(query, contexts) {
  let contextText = "";
  for (const ctx of contexts) {
    contextText += `\n--- Section: ${ctx.title} (Pages ${ctx.pages}, Node ${ctx.node_id}) ---\n`;
    contextText += ctx.text;
    contextText += "\n";
  }

  return `Answer the following question based ONLY on the provided context.
Cite the specific section titles and page numbers in your answer.

QUESTION: ${query}

CONTEXT:
${contextText}

If the answer is not found in the context, say so explicitly.

Respond with JSON:
{
  "answer": "Your detailed answer with citations",
  "sources": [{"node_id": "...", "title": "...", "pages": "..."}]
}`;
}

async function generateAnswer(query, contexts, apiKey, model, provider) {
  const response = await callLLM(
    apiKey,
    model,
    "You are a helpful assistant that answers questions based on document context. Respond with valid JSON only.",
    buildAnswerPrompt(query, contexts),
    provider
  );

  return JSON.parse(response);
}

// ---------------------------------------------------------------------------
// Full retrieval pipeline
// ---------------------------------------------------------------------------

async function retrieve(query, index, apiKey, model = "gpt-4o-mini", provider = "openai") {
  console.log(`\n🔍 Query: "${query}"`);

  // Step 1: LLM reasons over the tree
  console.log("\n🌳 Step 1: Searching tree index (LLM reasoning)...");
  const searchResult = await searchTree(query, index.tree, apiKey, model, provider);
  console.log(`   Thinking: ${searchResult.thinking}`);
  console.log(`   Selected nodes: ${searchResult.selected_nodes.join(", ")}`);

  // Step 2: Extract text from matched nodes
  console.log("\n📖 Step 2: Extracting context from selected nodes...");
  const contexts = extractContext(
    searchResult.selected_nodes,
    index.tree,
    index.pages
  );
  console.log(
    `   Extracted ${contexts.length} sections (${contexts.map((c) => c.title).join(", ")})`
  );

  // Step 3: Generate answer
  console.log("\n💡 Step 3: Generating answer from context...");
  const answer = await generateAnswer(query, contexts, apiKey, model, provider);

  return {
    query,
    search: searchResult,
    contexts: contexts.map((c) => ({
      node_id: c.node_id,
      title: c.title,
      pages: c.pages,
    })),
    answer: answer.answer,
    sources: answer.sources,
  };
}

module.exports = { retrieve, searchTree, extractContext, generateAnswer };