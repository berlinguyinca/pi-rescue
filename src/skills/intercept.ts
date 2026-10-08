import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ioFromContext } from "./types.ts";

/**
 * Stand up a MITM inspection proxy (mitmproxy): generate+serve a CA, transparent-redirect or Wi-Fi AP routing, decrypt HTTPS/HTTP2/WebSocket, capture/inspect/replay flows; SSH session capture via ssh-mitm. For analyzing traffic of apps/devices you control.
 *
 * AUTHORIZED USE ONLY — operates on apps/devices/networks you own or are
 * explicitly authorized to test. Confirmation-gated; nothing is intercepted or
 * attacked without an explicit target + confirm. See AGENTS.md.
 *
 * Contract: collect → RAG → plan → (confirm) → act → record.
 */
export async function intercept(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  // TODO(v2): implement. Scaffold only.
  ioFromContext(ctx).print("[pi-rescue:intercept] not yet implemented — see docs/specs/pi-rescue-spec.md");
}
