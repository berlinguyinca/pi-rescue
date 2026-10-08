#!/usr/bin/env node
// CLI shim for pi-rescue (parity with pi-engineering's bin).
//
//   node scripts/pi-rescue.ts build-index [--kb <dir>] [--out <file>]
//
// Chunks + embeds kb/*.md and writes the index snapshot consumed by
// src/skills/runtime.ts, so the rescue-os image build can bake a
// pre-built KB index instead of every command re-embedding it on first use.
// Embeds via Ollama's nomic-embed-text when reachable, falling back to the
// pure-JS hash embedder otherwise (see src/rag/embed.ts) — either way the
// resulting snapshot works, it just means a different quality of ranking.
import { buildRagEngineFromKb, saveIndexSnapshot } from "../src/rag/index.ts";
import { KB_DIR, KB_INDEX_PATH } from "../src/skills/runtime.ts";

function parseArgs(argv: string[]): { command: string | undefined; kbDir: string; out: string } {
  let kbDir = KB_DIR;
  let out = KB_INDEX_PATH;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--kb" && argv[i + 1]) {
      kbDir = argv[++i] as string;
    } else if (argv[i] === "--out" && argv[i + 1]) {
      out = argv[++i] as string;
    }
  }
  return { command: argv[0], kbDir, out };
}

async function main(): Promise<number> {
  const { command, kbDir, out } = parseArgs(process.argv.slice(2));

  if (command === "build-index") {
    console.log(`pi-rescue: building KB index from ${kbDir} -> ${out}`);
    const engine = await buildRagEngineFromKb(kbDir);
    await saveIndexSnapshot(engine, out);
    console.log(
      `pi-rescue: indexed ${engine.size} chunk(s) using embedder "${engine.toSnapshot().embedderId}"`,
    );
    return 0;
  }

  console.log("pi-rescue-runtime — load via pi as an extension. See README.md");
  console.log("Usage: node scripts/pi-rescue.ts build-index [--kb <dir>] [--out <file>]");
  return command === undefined ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
