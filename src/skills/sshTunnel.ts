import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Create/tear down local/remote/dynamic SSH forwards & jump hosts; autossh; inventory.
 *
 * Contract (see docs/specs/pi-rescue-spec.md):
 *   1. collect()   — gather context, READ-ONLY
 *   2. retrieve()  — RAG from kb/ (sqlite-vec + nomic-embed-text)
 *   3. plan()      — ask the model (gateway or local Ollama)
 *   4. act()       — gated on confirmation for destructive/outbound steps
 */
export async function sshTunnel(ctx: ExtensionCommandContext, _args: string[]): Promise<void> {
  // TODO(v2): implement. Scaffold only.
  ctx.print?.("[pi-rescue:sshTunnel] not yet implemented — see docs/specs/pi-rescue-spec.md");
}
