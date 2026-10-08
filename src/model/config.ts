// Loads and parses `.pi/rescue.yaml` — the routing table, RAG settings, and
// skill/safety config described in docs/specs/pi-rescue-spec.md.
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export interface RescueModelRole {
  model: string;
  fallback?: string;
  max_context_tokens?: number;
}

export interface RescueProvider {
  base_url: string;
  api_key_env?: string;
}

export interface RescueRoutingConfig {
  mode: "auto" | "gateway" | "local";
  roles: Record<string, RescueModelRole>;
  providers: Record<string, RescueProvider>;
}

export interface RescueRagConfig {
  kb_dir: string;
  vector_store: string;
  embed_model: string;
  top_k: number;
}

export interface RescueSafetyConfig {
  confirm_destructive: boolean;
  mount_targets_readonly: boolean;
}

export interface RescueConfig {
  routing: RescueRoutingConfig;
  rag: RescueRagConfig;
  skills: string[];
  safety: RescueSafetyConfig;
}

/** Parses an already-read rescue.yaml string. Exported for tests (no filesystem needed). */
export function parseRescueConfig(yamlText: string): RescueConfig {
  const doc = parseYaml(yamlText) as Partial<RescueConfig> | undefined;
  if (!doc || typeof doc !== "object") {
    throw new Error("rescue.yaml: empty or not a mapping");
  }
  if (!doc.routing?.roles || !doc.routing?.providers) {
    throw new Error("rescue.yaml: routing.roles and routing.providers are required");
  }
  return {
    routing: {
      mode: doc.routing.mode ?? "auto",
      roles: doc.routing.roles,
      providers: doc.routing.providers,
    },
    rag: {
      kb_dir: doc.rag?.kb_dir ?? "kb",
      vector_store: doc.rag?.vector_store ?? "kb/.vectors/rescue.sqlite",
      embed_model: doc.rag?.embed_model ?? "nomic-embed-text",
      top_k: doc.rag?.top_k ?? 6,
    },
    skills: doc.skills ?? [],
    safety: {
      confirm_destructive: doc.safety?.confirm_destructive ?? true,
      mount_targets_readonly: doc.safety?.mount_targets_readonly ?? true,
    },
  };
}

/** Reads and parses rescue.yaml from disk. Defaults to the path next to this package. */
export async function loadRescueConfig(path: string): Promise<RescueConfig> {
  const text = await readFile(path, "utf8");
  return parseRescueConfig(text);
}
