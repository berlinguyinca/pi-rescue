// Embedding backends for the RAG engine.
//
// `OpenAIEmbedder` is the default: it calls an OpenAI-compatible
// `/v1/embeddings` endpoint, which is what `llama-server --embeddings` serves
// (the rescue-os image runs nomic-embed-text under a local llama-server)
// and what the metabolomics gateway serves. `OllamaEmbedder` (kept for
// back-compat) calls Ollama's native `/api/embeddings` instead. `HashEmbedder`
// is a deterministic, pure-JS, offline fallback (feature hashing / "hashing
// trick") used whenever the embeddings server is unreachable — including every
// unit test, which must not touch the network. Vectors from different
// embedders are never comparable (different dimensions, different id), so
// `embedderId()` lets the RAG engine detect a mismatch and re-embed instead
// of silently scoring garbage. See docs/specs §Principles (offline-capable).
import type { FetchLike, ResponseLike } from "../model/types.ts";

export type EmbedKind = "document" | "query";

export interface Embedder {
  /** A stable identifier (model + dimension) used to detect a store/query embedder mismatch. */
  readonly id: string;
  embed(text: string, kind: EmbedKind): Promise<number[]>;
}

export interface OllamaEmbedderOptions {
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** nomic-embed-text expects a task prefix on the raw text — see the model card. */
function nomicPrefix(kind: EmbedKind): string {
  return kind === "query" ? "search_query: " : "search_document: ";
}

export class OllamaEmbedder implements Embedder {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: OllamaEmbedderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.model = options.model ?? "nomic-embed-text";
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.id = `ollama:${this.model}`;
  }

  async embed(text: string, kind: EmbedKind): Promise<number[]> {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    let response: ResponseLike;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: nomicPrefix(kind) + text }),
        signal: controller?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`Ollama embeddings HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { embedding?: number[] };
    if (!payload.embedding || payload.embedding.length === 0) {
      throw new Error("Ollama embeddings returned no vector");
    }
    return payload.embedding;
  }
}

export interface OpenAIEmbedderOptions {
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Embeds against an OpenAI-compatible `/v1/embeddings` endpoint. This is what
 * `llama-server --embeddings` serves — the rescue-os image runs
 * nomic-embed-text under a local llama-server on :8081 — and also the shape the
 * metabolomics gateway serves. Override the endpoint/model without touching
 * code via RESCUE_EMBED_BASE_URL / RESCUE_EMBED_MODEL (the build-index step and
 * the runtime both honor them). nomic-embed-text still needs its
 * search_document:/search_query: task prefix regardless of transport.
 */
export class OpenAIEmbedder implements Embedder {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: OpenAIEmbedderOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : undefined;
    this.baseUrl = (options.baseUrl ?? env?.RESCUE_EMBED_BASE_URL ?? "http://127.0.0.1:8081/v1").replace(
      /\/+$/,
      "",
    );
    this.model = options.model ?? env?.RESCUE_EMBED_MODEL ?? "nomic-embed-text";
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.id = `openai:${this.model}`;
  }

  async embed(text: string, kind: EmbedKind): Promise<number[]> {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    let response: ResponseLike;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: nomicPrefix(kind) + text }),
        signal: controller?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`embeddings HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const vector = payload.data?.[0]?.embedding;
    if (!vector || vector.length === 0) {
      throw new Error("embeddings endpoint returned no vector");
    }
    return vector;
  }
}

/** Fixed dimension for the offline fallback embedder — small enough to be fast, large enough to separate topics. */
const HASH_DIMENSIONS = 256;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** 32-bit FNV-1a, used only to spread tokens across the hash-embedding dimensions. */
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic, offline, pure-JS embedder: feature-hashes tokens into a
 * fixed-size bag-of-words vector, L2-normalized so cosine similarity behaves
 * like a (crude) lexical-overlap score. No network, no native deps — this is
 * what RAG falls back to, and what every unit test uses.
 */
export class HashEmbedder implements Embedder {
  readonly id = `hash:${HASH_DIMENSIONS}`;

  async embed(text: string, _kind: EmbedKind): Promise<number[]> {
    const vector = new Array<number>(HASH_DIMENSIONS).fill(0);
    for (const token of tokenize(text)) {
      const bucket = fnv1a(token) % HASH_DIMENSIONS;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    return vector.map((v) => v / norm);
  }
}

/**
 * Tries the primary embedder first (an OpenAI-compatible `/v1/embeddings`
 * server by default — llama-server on the image), falling back to the pure-JS
 * hash embedder on any failure (server down, model not loaded, etc). Pass an
 * `OllamaEmbedder` as the primary to talk to a native Ollama instead.
 */
export class FailoverEmbedder implements Embedder {
  private readonly primary: Embedder;
  private readonly fallback: Embedder;
  private primaryFailed = false;

  constructor(primary: Embedder = new OpenAIEmbedder(), fallback: Embedder = new HashEmbedder()) {
    this.primary = primary;
    this.fallback = fallback;
  }

  /** Reflects whichever embedder actually answered the most recent call. */
  get id(): string {
    return this.primaryFailed ? this.fallback.id : this.primary.id;
  }

  async embed(text: string, kind: EmbedKind): Promise<number[]> {
    if (!this.primaryFailed) {
      try {
        return await this.primary.embed(text, kind);
      } catch {
        this.primaryFailed = true;
      }
    }
    return this.fallback.embed(text, kind);
  }
}
