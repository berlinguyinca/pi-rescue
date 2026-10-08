// End-to-end RAG test over a tiny fixed corpus: chunk -> embed (pure-JS hash
// fallback, no network) -> store -> retrieve -> rank. This is the test that
// proves the whole RAG pipeline works with neither Ollama nor sqlite-vec.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkKb } from "../../src/rag/chunk.ts";
import { HashEmbedder } from "../../src/rag/embed.ts";
import { RagEngine } from "../../src/rag/index.ts";

const CORPUS = [
  {
    name: "network.md",
    content: [
      "# Network triage",
      "Check the physical link and carrier first. A cable that isn't plugged in shows no carrier.",
      "",
      "# DNS",
      "If DNS resolution fails, compare against a public resolver like 1.1.1.1 to isolate the cause.",
    ].join("\n"),
  },
  {
    name: "disk.md",
    content: [
      "# SMART triage",
      "Reallocated sectors and pending sectors on a SMART report mean the disk is failing.",
      "",
      "# Recovery",
      "Image a failing disk read-only with ddrescue before attempting any filesystem repair.",
    ].join("\n"),
  },
];

async function buildEngine(): Promise<RagEngine> {
  const engine = new RagEngine({ embedder: new HashEmbedder() });
  const chunks = chunkKb(CORPUS, { minChars: 1, maxChars: 800 });
  await engine.indexChunks(chunks);
  return engine;
}

test("RagEngine: retrieves the disk chunk for a disk-shaped query, over the network chunks", async () => {
  const engine = await buildEngine();
  const results = await engine.retrieve("the disk has reallocated sectors, is it failing", 2);
  assert.ok(results.length > 0);
  assert.match(results[0]?.chunk.source ?? "", /disk\.md/);
});

test("RagEngine: retrieves the network chunk for a DNS-shaped query", async () => {
  const engine = await buildEngine();
  const results = await engine.retrieve("DNS resolution is not working, compare to a public resolver", 2);
  assert.ok(results.length > 0);
  assert.match(results[0]?.chunk.source ?? "", /network\.md/);
});

test("RagEngine: retrieve() respects topK", async () => {
  const engine = await buildEngine();
  const results = await engine.retrieve("disk network triage", 1);
  assert.equal(results.length, 1);
});

test("RagEngine: an empty index retrieves nothing, not an error", async () => {
  const engine = new RagEngine({ embedder: new HashEmbedder() });
  assert.deepEqual(await engine.retrieve("anything", 5), []);
});
