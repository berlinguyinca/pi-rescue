import assert from "node:assert/strict";
import { test } from "node:test";
import type { KbChunk } from "../../src/rag/chunk.ts";
import { InMemoryCosineStore, cosineSimilarity } from "../../src/rag/vectorStore.ts";

function chunk(id: string, text = ""): KbChunk {
  return { id, source: "doc.md", heading: "", text };
}

test("cosineSimilarity: identical vectors score 1, orthogonal vectors score 0", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: a zero vector never divides by zero", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("InMemoryCosineStore: ranks the closer vector first", () => {
  const store = new InMemoryCosineStore();
  store.add("near", [1, 0.1], chunk("near", "near"));
  store.add("far", [0, 1], chunk("far", "far"));
  const results = store.query([1, 0], 2);
  assert.equal(results[0]?.id, "near");
  assert.equal(results[1]?.id, "far");
  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
});

test("InMemoryCosineStore: query respects topK", () => {
  const store = new InMemoryCosineStore();
  for (let i = 0; i < 5; i++) store.add(`c${i}`, [i, 1], chunk(`c${i}`));
  assert.equal(store.query([0, 1], 2).length, 2);
});

test("InMemoryCosineStore: clear() empties the store", () => {
  const store = new InMemoryCosineStore();
  store.add("a", [1, 0], chunk("a"));
  assert.equal(store.size(), 1);
  store.clear();
  assert.equal(store.size(), 0);
  assert.deepEqual(store.query([1, 0], 5), []);
});
