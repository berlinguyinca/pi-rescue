// Embedding backends for the RAG engine.
//
// `OllamaEmbedder` calls the local Ollama server's nomic-embed-text model.
// `HashEmbedder` is a deterministic, pure-JS, offline fallback (feature
// hashing / "hashing trick") used whenever Ollama is unreachable — including
// every unit test, which must not touch the network. Vectors from the two
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

/** Tries Ollama first; falls back to the hash embedder on any failure (network down, model not pulled, etc). */
export class FailoverEmbedder implements Embedder {
  private readonly ollama: OllamaEmbedder;
  private readonly fallback: Embedder;
  private ollamaFailed = false;

  constructor(ollama: OllamaEmbedder = new OllamaEmbedder(), fallback: Embedder = new HashEmbedder()) {
    this.ollama = ollama;
    this.fallback = fallback;
  }

  /** Reflects whichever embedder actually answered the most recent call. */
  get id(): string {
    return this.ollamaFailed ? this.fallback.id : this.ollama.id;
  }

  async embed(text: string, kind: EmbedKind): Promise<number[]> {
    if (!this.ollamaFailed) {
      try {
        return await this.ollama.embed(text, kind);
      } catch {
        this.ollamaFailed = true;
      }
    }
    return this.fallback.embed(text, kind);
  }
}
