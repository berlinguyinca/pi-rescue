// pi-rescue extension entry. Registers the rescue /commands with pi and dispatches
// each to its skill module in ../src/skills. Mirrors the registration shape of
// berlinguyinca/pi-engineering/extensions/index.ts — align the exact ExtensionAPI
// surface with that reference when wiring up for real.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { diagnose } from "../src/skills/diagnose.ts";
import { networkTriage } from "../src/skills/networkTriage.ts";
import { networkAudit } from "../src/skills/networkAudit.ts";
import { harden } from "../src/skills/harden.ts";
import { sshTunnel } from "../src/skills/sshTunnel.ts";
import { remoteSession } from "../src/skills/remoteSession.ts";
import { keyManagement } from "../src/skills/keyManagement.ts";
import { intercept } from "../src/skills/intercept.ts";
import { reverseApp } from "../src/skills/reverseApp.ts";

type Skill = (ctx: ExtensionCommandContext, args: string[]) => Promise<void>;

const SKILLS: Record<string, { summary: string; run: Skill }> = {
  diagnose: { summary: "Collect system context, RAG, and root-cause a box", run: diagnose },
  "network-triage": { summary: "link→DHCP→DNS→route→firewall network debugging ladder (single host)", run: networkTriage },
  "network-audit": { summary: "Whole-network audit: topology, routing, performance & security", run: networkAudit },
  harden: { summary: "Audit (lynis) + apply the fiehnlab hardening, then re-scan", run: harden },
  "ssh-tunnel": { summary: "Create/tear down SSH tunnels & port-forwards; inventory", run: sshTunnel },
  remote: { summary: "Remote sessions + fleet command across authorized hosts", run: remoteSession },
  keys: { summary: "SSH/LUKS/age key generation, rotation, distribution & hygiene", run: keyManagement },
  intercept: { summary: "Authorized MITM: mitmproxy CA + routing, decrypt HTTPS/SSH, capture/replay", run: intercept },
  reverse: { summary: "Authorized app RE: decompile, Frida instrument, correlate with traffic", run: reverseApp },
};

export default function activate(api: ExtensionAPI): void {
  for (const [name, skill] of Object.entries(SKILLS)) {
    api.registerCommand({
      name,
      summary: skill.summary,
      run: (ctx: ExtensionCommandContext, args: string[]) => skill.run(ctx, args),
    });
  }
}
