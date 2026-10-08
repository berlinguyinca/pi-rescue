import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Run lynis + the fiehnlab hardening playbook; interpret; apply; re-scan.
 *
 * Contract (see docs/specs/pi-rescue-spec.md):
 *   1. collect()   — gather context, READ-ONLY
 *   2. retrieve()  — RAG from kb/ (sqlite-vec + nomic-embed-text)
 *   3. plan()      — ask the model (gateway or local Ollama)
 *   4. act()       — gated on confirmation for destructive/outbound steps
 */
export async function harden(ctx: ExtensionCommandContext, _args: string[]): Promise<void> {
  // TODO(v2): implement. Scaffold only.
  ctx.print?.("[pi-rescue:harden] not yet implemented — see docs/specs/pi-rescue-spec.md");
}
