// Unit tests for the OpenAI-compatible embedder (the rescue-os default,
// served by `llama-server --embeddings`) and the Failover wrapper. No network:
// fetch is mocked. The RAG end-to-end path is covered separately in rag.test.ts
// with the pure-JS HashEmbedder.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchLike, RequestInitLike, ResponseLike } from "../../src/model/types.ts";
import { FailoverEmbedder, HashEmbedder, OpenAIEmbedder } from "../../src/rag/embed.ts";

function jsonResponse(body: unknown, ok = true, status = 200): ResponseLike {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("OpenAIEmbedder: POSTs /v1/embeddings with {model,input} and the nomic prefix, returns data[0].embedding", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  const fetchImpl: FetchLike = async (url: string, init?: RequestInitLike) => {
    seenUrl = url;
    seenBody = JSON.parse(init?.body ?? "{}");
    return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
  };
  const embedder = new OpenAIEmbedder({
    baseUrl: "http://127.0.0.1:8081/v1",
    model: "nomic-embed-text",
    fetchImpl,
  });

  const docVec = await embedder.embed("reallocated sectors mean a failing disk", "document");
  assert.deepEqual(docVec, [0.1, 0.2, 0.3]);
  assert.equal(seenUrl, "http://127.0.0.1:8081/v1/embeddings");
  assert.equal(seenBody.model, "nomic-embed-text");
  assert.equal(seenBody.input, "search_document: reallocated sectors mean a failing disk");
  assert.equal(embedder.id, "openai:nomic-embed-text");

  const queryEmbedder = new OpenAIEmbedder({ fetchImpl });
  await queryEmbedder.embed("why is my disk slow", "query");
  assert.equal(seenBody.input, "search_query: why is my disk slow");
});

test("OpenAIEmbedder: a non-OK response throws (so Failover can fall back instead of indexing garbage)", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ error: "no model" }, false, 503);
  const embedder = new OpenAIEmbedder({ fetchImpl });
  await assert.rejects(() => embedder.embed("x", "query"), /embeddings HTTP 503/);
});

test("OpenAIEmbedder: an empty/missing vector throws rather than returning []", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ data: [{ embedding: [] }] });
  const embedder = new OpenAIEmbedder({ fetchImpl });
  await assert.rejects(() => embedder.embed("x", "query"), /no vector/);
});

test("FailoverEmbedder: falls back to the hash embedder when the primary throws, and reports the fallback id", async () => {
  const failing = new OpenAIEmbedder({ fetchImpl: async () => jsonResponse({}, false, 500) });
  const failover = new FailoverEmbedder(failing, new HashEmbedder());
  const vec = await failover.embed("network cable unplugged no carrier", "document");
  assert.ok(vec.length > 0, "fallback must still produce a vector");
  assert.equal(failover.id, "hash:256");
});

test("FailoverEmbedder: uses the primary (and its id) while it works", async () => {
  const primary = new OpenAIEmbedder({
    fetchImpl: async () => jsonResponse({ data: [{ embedding: [1, 0] }] }),
  });
  const failover = new FailoverEmbedder(primary, new HashEmbedder());
  const vec = await failover.embed("hi", "query");
  assert.deepEqual(vec, [1, 0]);
  assert.equal(failover.id, "openai:nomic-embed-text");
});
