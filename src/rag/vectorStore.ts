// Vector storage for the RAG engine: an in-memory pure-JS cosine store (the
// one that is unit-tested and the one that runs whenever sqlite-vec isn't
// available — which is every CI box and probably your laptop), plus a
// best-effort sqlite-vec-backed store for the rescue-os image build where
// it is baked in. See docs/specs/pi-rescue-spec.md "RAG over recall".
import type { KbChunk } from "./chunk.ts";

export interface VectorMatch {
  id: string;
  score: number;
  chunk: KbChunk;
}

export interface VectorStore {
  /** Removes everything previously added. */
  clear(): void;
  /** Adds (or replaces) one vector + its chunk payload. */
  add(id: string, vector: number[], chunk: KbChunk): void;
  /** Returns the `topK` closest vectors by cosine similarity, highest score first. */
  query(vector: number[], topK: number): VectorMatch[];
  /** Number of vectors currently stored. */
  size(): number;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Pure-JS, in-memory cosine-similarity vector store. No native deps, no I/O, always available. */
export class InMemoryCosineStore implements VectorStore {
  private readonly rows = new Map<string, { vector: number[]; chunk: KbChunk }>();

  clear(): void {
    this.rows.clear();
  }

  add(id: string, vector: number[], chunk: KbChunk): void {
    this.rows.set(id, { vector, chunk });
  }

  query(vector: number[], topK: number): VectorMatch[] {
    const scored: VectorMatch[] = [];
    for (const [id, row] of this.rows) {
      scored.push({ id, score: cosineSimilarity(vector, row.vector), chunk: row.chunk });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, topK));
  }

  size(): number {
    return this.rows.size;
  }
}

/**
 * Best-effort sqlite-vec-backed store for the image build, where both
 * Node's `node:sqlite` and the optional `sqlite-vec` loadable extension are
 * baked into the rescue-os runtime. Uses variable-specifier dynamic
 * imports so `tsc`/bundlers never need either package to resolve; any
 * failure (module missing, extension loading unsupported, etc.) resolves to
 * `undefined` so the caller falls back to {@link InMemoryCosineStore}.
 *
 * NOT exercised by this repo's test suite: neither `node:sqlite` nor
 * `sqlite-vec` is guaranteed present in a plain `npm test` environment, by
 * design (see docs/specs §Principles, "offline-capable"). Treat this as
 * unverified until it runs once on the real image.
 */
export async function tryCreateSqliteVecStore(dbPath: string): Promise<VectorStore | undefined> {
  try {
    // Check for `sqlite-vec` FIRST: it is not a project dependency (by design, see README), so
    // on every box without it this import is the one that fails, and failing here means never
    // importing `node:sqlite` at all. `node:sqlite` is experimental and logs an
    // "ExperimentalWarning" to stderr on first import — fine on the box that actually has
    // sqlite-vec baked in, but not something every other box's pi session should print once.
    const vecSpecifier = "sqlite-vec";
    const sqliteVec = (await import(vecSpecifier)) as { getLoadablePath(): string };

    const sqliteSpecifier = "node:sqlite";
    const nodeSqlite = (await import(sqliteSpecifier)) as {
      DatabaseSync: new (
        path: string,
        options?: { allowExtension?: boolean },
      ) => {
        exec(sql: string): void;
        prepare(sql: string): {
          run(...params: unknown[]): void;
          all(...params: unknown[]): unknown[];
        };
        loadExtension?: (path: string) => void;
        close(): void;
      };
    };

    // `loadExtension()` throws unless the database was explicitly opened with this.
    const db = new nodeSqlite.DatabaseSync(dbPath, { allowExtension: true });
    if (typeof db.loadExtension !== "function") return undefined;
    db.loadExtension(sqliteVec.getLoadablePath());
    db.exec(
      "CREATE TABLE IF NOT EXISTS rescue_chunks (id TEXT PRIMARY KEY, source TEXT, heading TEXT, text TEXT, vector BLOB)",
    );

    return new SqliteVecStore(db);
  } catch {
    return undefined;
  }
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): void;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

/** Thin sqlite-backed store: vectors persisted as JSON, scored in JS (no vec0 virtual-table dependency). */
class SqliteVecStore implements VectorStore {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  clear(): void {
    this.db.exec("DELETE FROM rescue_chunks");
  }

  add(id: string, vector: number[], chunk: KbChunk): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO rescue_chunks (id, source, heading, text, vector) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, chunk.source, chunk.heading, chunk.text, JSON.stringify(vector));
  }

  query(vector: number[], topK: number): VectorMatch[] {
    const rows = this.db
      .prepare("SELECT id, source, heading, text, vector FROM rescue_chunks")
      .all() as Array<{
      id: string;
      source: string;
      heading: string;
      text: string;
      vector: string;
    }>;
    const scored = rows.map((row) => ({
      id: row.id,
      score: cosineSimilarity(vector, JSON.parse(row.vector) as number[]),
      chunk: { id: row.id, source: row.source, heading: row.heading, text: row.text },
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, topK));
  }

  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM rescue_chunks").all()[0] as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
