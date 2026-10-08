// The RAG engine: loads kb/*.md, chunks it, embeds each chunk, stores the
// vectors, and answers `retrieve(query, topK)` with ranked chunks. See
// docs/specs/pi-rescue-spec.md §Components ("src/rag/").
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ChunkOptions, type KbChunk, chunkKb } from "./chunk.ts";
import { type Embedder, FailoverEmbedder } from "./embed.ts";
import { InMemoryCosineStore, type VectorStore, tryCreateSqliteVecStore } from "./vectorStore.ts";

export interface RankedChunk {
  chunk: KbChunk;
  score: number;
}

export interface RagEngineOptions {
  embedder?: Embedder;
  store?: VectorStore;
}

interface IndexedEntry {
  chunk: KbChunk;
  vector: number[];
}

/** On-disk snapshot written by the `build-index` path, consumed by the image bake. */
export interface RagIndexSnapshot {
  embedderId: string;
  builtAt: string;
  entries: IndexedEntry[];
}

export class RagEngine {
  private readonly embedder: Embedder;
  private readonly store: VectorStore;
  /** Kept alongside the store so the index can be dumped to disk regardless of store backend. */
  private entries: IndexedEntry[] = [];
  private embedderId: string | undefined;

  constructor(options: RagEngineOptions = {}) {
    this.embedder = options.embedder ?? new FailoverEmbedder();
    this.store = options.store ?? new InMemoryCosineStore();
  }

  get size(): number {
    return this.store.size();
  }

  /** Embeds and stores a batch of chunks. Re-indexing clears any previous content first. */
  async indexChunks(chunks: KbChunk[]): Promise<void> {
    this.store.clear();
    this.entries = [];
    for (const chunk of chunks) {
      const vector = await this.embedder.embed(chunk.text, "document");
      this.store.add(chunk.id, vector, chunk);
      this.entries.push({ chunk, vector });
    }
    this.embedderId = this.embedder.id;
  }

  /** Loads a previously built snapshot in place of re-embedding (used when Ollama built it offline/at bake time). */
  loadSnapshot(snapshot: RagIndexSnapshot): void {
    this.store.clear();
    this.entries = snapshot.entries;
    this.embedderId = snapshot.embedderId;
    for (const { chunk, vector } of snapshot.entries) {
      this.store.add(chunk.id, vector, chunk);
    }
  }

  toSnapshot(): RagIndexSnapshot {
    return {
      embedderId: this.embedderId ?? this.embedder.id,
      builtAt: new Date().toISOString(),
      entries: this.entries,
    };
  }

  /**
   * Returns the `topK` chunks most relevant to `query`. If the loaded index
   * was built with a different embedder than the one configured now (e.g.
   * the snapshot is nomic-based but Ollama is offline at query time), the
   * mismatch would score garbage, so the whole KB is re-embedded with the
   * embedder actually available before scoring.
   */
  async retrieve(query: string, topK: number): Promise<RankedChunk[]> {
    if (this.entries.length === 0) return [];
    const queryVector = await this.embedder.embed(query, "query");
    if (this.embedderId && this.embedderId !== this.embedder.id) {
      await this.indexChunks(this.entries.map((e) => e.chunk));
      return this.retrieve(query, topK);
    }
    const matches = this.store.query(queryVector, topK);
    return matches.map((m) => ({ chunk: m.chunk, score: m.score }));
  }
}

/** Reads every `*.md` file directly inside `kbDir` (non-recursive — kb/ is a flat directory). */
export async function loadKbFiles(kbDir: string): Promise<Array<{ name: string; content: string }>> {
  const entries = await readdir(kbDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    files.map(async (entry) => ({
      name: entry.name,
      content: await readFile(join(kbDir, entry.name), "utf8"),
    })),
  );
}

/** Builds (chunks + embeds) a RagEngine from a KB directory on disk. */
export async function buildRagEngineFromKb(
  kbDir: string,
  options?: RagEngineOptions & { chunkOptions?: ChunkOptions },
): Promise<RagEngine> {
  const files = await loadKbFiles(kbDir);
  const chunks = chunkKb(files, options?.chunkOptions);
  const engine = new RagEngine(options);
  await engine.indexChunks(chunks);
  return engine;
}

/** Writes a RagEngine's index to a JSON file for the image bake (`build-index`). */
export async function saveIndexSnapshot(engine: RagEngine, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(engine.toSnapshot(), null, 2), "utf8");
}

/** Loads a previously saved snapshot into a fresh RagEngine. */
export async function loadIndexSnapshot(path: string, options?: RagEngineOptions): Promise<RagEngine> {
  const raw = await readFile(path, "utf8");
  const snapshot = JSON.parse(raw) as RagIndexSnapshot;
  const engine = new RagEngine(options);
  engine.loadSnapshot(snapshot);
  return engine;
}

/**
 * Best-effort: prefers a sqlite-vec-backed store when both `node:sqlite` and
 * the `sqlite-vec` loadable extension are available (the rescue-os
 * image); otherwise returns the pure-JS in-memory cosine store, which is
 * what runs in this repo's tests and on any box without sqlite-vec baked in.
 */
export async function createVectorStore(dbPath: string): Promise<VectorStore> {
  const sqliteVec = await tryCreateSqliteVecStore(dbPath);
  return sqliteVec ?? new InMemoryCosineStore();
}

export type { KbChunk } from "./chunk.ts";
export { chunkKb, chunkMarkdown } from "./chunk.ts";
export type { Embedder } from "./embed.ts";
export { FailoverEmbedder, HashEmbedder, OllamaEmbedder, OpenAIEmbedder } from "./embed.ts";
export type { VectorStore, VectorMatch } from "./vectorStore.ts";
export { InMemoryCosineStore, cosineSimilarity } from "./vectorStore.ts";
