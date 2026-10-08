// Wires the default, real runtime (rescue.yaml + KB + model router) for pi
// command handlers. Deliberately the only module in src/skills that touches
// the filesystem or constructs a real ModelRouter — every skill's own logic
// takes these as injected dependencies instead, so tests never import this.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RescueConfig, loadRescueConfig } from "../model/config.ts";
import { ModelRouter } from "../model/router.ts";
import { type RagEngine, buildRagEngineFromKb, loadIndexSnapshot } from "../rag/index.ts";

/** Resolved from this module's own location, not `process.cwd()` — pi loads extensions from a project it isn't. */
export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const RESCUE_CONFIG_PATH = join(PACKAGE_ROOT, ".pi", "rescue.yaml");
export const KB_DIR = join(PACKAGE_ROOT, "kb");
export const KB_INDEX_PATH = join(PACKAGE_ROOT, "kb", ".vectors", "index.json");

export interface RescueRuntime {
  config: RescueConfig;
  model: ModelRouter;
  rag: RagEngine;
}

let cached: Promise<RescueRuntime> | undefined;

/**
 * Loads (once per process) the real rescue.yaml config, model router, and
 * RAG engine. Prefers a pre-built KB index (`build-index`, baked into the
 * fiehnlab-live image) over re-chunking + re-embedding the KB on every
 * command; falls back to building it on the fly when no snapshot exists.
 */
export async function loadRescueRuntime(): Promise<RescueRuntime> {
  cached ??= buildRuntime();
  return cached;
}

/** Test-only: drops the cached runtime so a fresh one is built next time. */
export function resetRescueRuntimeCache(): void {
  cached = undefined;
}

async function buildRuntime(): Promise<RescueRuntime> {
  const config = await loadRescueConfig(RESCUE_CONFIG_PATH);
  const model = new ModelRouter({ config: config.routing });
  const rag = await loadOrBuildRag();
  return { config, model, rag };
}

async function loadOrBuildRag(): Promise<RagEngine> {
  try {
    await stat(KB_INDEX_PATH);
    return await loadIndexSnapshot(KB_INDEX_PATH);
  } catch {
    return buildRagEngineFromKb(KB_DIR);
  }
}
