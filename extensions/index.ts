// pi-rescue extension entry. Registers the rescue /commands with pi and wires
// up `assist`'s freeform-input auto-dispatch. See docs/specs/pi-rescue-spec.md
// and AGENTS.md for the operating policy (read-only first, confirm before
// anything destructive/outbound).
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { assist, decideAssistAction, runAssist } from "../src/skills/assist.ts";
import { diagnose } from "../src/skills/diagnose.ts";
import { harden } from "../src/skills/harden.ts";
import { intercept } from "../src/skills/intercept.ts";
import { keyManagement } from "../src/skills/keyManagement.ts";
import { networkAudit } from "../src/skills/networkAudit.ts";
import { networkTriage } from "../src/skills/networkTriage.ts";
import { remoteSession } from "../src/skills/remoteSession.ts";
import { reverseApp } from "../src/skills/reverseApp.ts";
import { sshTunnel } from "../src/skills/sshTunnel.ts";
import { ioFromContext, setReportSink } from "../src/skills/types.ts";

type SkillHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const SKILLS: Record<string, { summary: string; run: SkillHandler }> = {
  assist: {
    summary: "Zero-knowledge front door: describe the problem in plain words; routes + explains",
    run: assist,
  },
  diagnose: { summary: "Collect system context, RAG, and root-cause a box", run: diagnose },
  "network-triage": {
    summary: "link→DHCP→DNS→route→firewall network debugging ladder (single host)",
    run: networkTriage,
  },
  "network-audit": {
    summary: "Whole-network audit: topology, routing, performance & security",
    run: networkAudit,
  },
  harden: { summary: "Audit (lynis) + apply the fiehnlab hardening, then re-scan", run: harden },
  "ssh-tunnel": { summary: "Create/tear down SSH tunnels & port-forwards; inventory", run: sshTunnel },
  remote: { summary: "Remote sessions + fleet command across authorized hosts", run: remoteSession },
  keys: { summary: "SSH/LUKS/age key generation, rotation, distribution & hygiene", run: keyManagement },
  intercept: {
    summary: "Authorized MITM: mitmproxy CA + routing, decrypt HTTPS/SSH, capture/replay",
    run: intercept,
  },
  reverse: {
    summary: "Authorized app RE: decompile, Frida instrument, correlate with traffic",
    run: reverseApp,
  },
};

/** Env var the rescue-os rescue-assist launcher sets to turn on freeform auto-dispatch. */
const ASSIST_ENV_VAR = "PI_RESCUE_ASSIST";
const ASSIST_FLAG = "rescue-assist";

function assistModeEnabled(pi: ExtensionAPI): boolean {
  if (pi.getFlag(ASSIST_FLAG) === true) return true;
  const env = process.env[ASSIST_ENV_VAR];
  return env === "1" || env === "true";
}

/**
 * `pi.on("input")` handler: auto-dispatches plain freeform text to `assist`
 * when rescue-assist mode is on. This is opt-in (flag or env var), not
 * always-on, so loading pi-rescue never hijacks a normal pi coding session —
 * only the rescue-os rescue launcher (or an explicit `--rescue-assist`)
 * turns it on. Use `/assist` directly otherwise.
 */
export function makeInputHandler(pi: ExtensionAPI) {
  return async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> => {
    if (!assistModeEnabled(pi)) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };
    const text = event.text.trim();
    if (text.length === 0 || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };

    // Only intercept text that the routing table actually recognizes as a
    // rescue-shaped request; anything else (ordinary coding chat) continues
    // through to the model as normal, even in rescue-assist mode.
    const action = decideAssistAction(text);
    if (action.kind === "clarify") return { action: "continue" };

    await runAssist(text, { io: ioFromContext(ctx) });
    return { action: "handled" };
  };
}

export default function activate(pi: ExtensionAPI): void {
  pi.registerFlag(ASSIST_FLAG, {
    description: "Auto-dispatch freeform input to the pi-rescue /assist concierge (also: PI_RESCUE_ASSIST=1)",
    type: "boolean",
    default: false,
  });

  // Reports need their own durable chat entry: `ctx.ui.notify()` collapses consecutive status
  // lines (pi's `showStatus`), which would otherwise let a post-report "Skipped: …"/"Done: …"
  // fix-confirmation line silently erase the diagnostic report just printed before it. A custom
  // message always appends. It also means the report re-enters context as a user-role message on
  // the next turn (see @earendil-works/pi-coding-agent's messages.ts), so pi can act on it further.
  setReportSink((text) => {
    pi.sendMessage({ customType: "pi-rescue-report", content: text, display: true }, { triggerTurn: false });
  });

  for (const [name, skill] of Object.entries(SKILLS)) {
    pi.registerCommand(name, {
      description: skill.summary,
      handler: (args: string, ctx: ExtensionCommandContext) => skill.run(args, ctx),
    });
  }

  pi.on("input", makeInputHandler(pi));
}
