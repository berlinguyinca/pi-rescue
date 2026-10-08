import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Reverse-engineer an app: decompile (apktool/jadx for Android, Ghidra for binaries), instrument a running app (Frida/objection, incl. cert-pinning bypass on a device you control), and correlate with intercepted traffic to map endpoints/secrets/protocols.
 *
 * AUTHORIZED USE ONLY — operates on apps/devices/networks you own or are
 * explicitly authorized to test. Confirmation-gated; nothing is intercepted or
 * attacked without an explicit target + confirm. See AGENTS.md.
 *
 * Contract: collect → RAG → plan → (confirm) → act → record.
 */
export async function reverseApp(ctx: ExtensionCommandContext, _args: string[]): Promise<void> {
  // TODO(v2): implement. Scaffold only.
  ctx.print?.("[pi-rescue:reverseApp] not yet implemented — see docs/specs/pi-rescue-spec.md");
}
