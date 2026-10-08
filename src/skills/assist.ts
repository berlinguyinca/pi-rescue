// assist — the ZERO-KNOWLEDGE front door (docs/specs §"Zero-knowledge UX").
//
// `classifyIntent()`/`decideAssistAction()` are pure and unit-tested against
// every example phrase in the spec, verbatim. `runAssist()` is the thin I/O
// layer on top: narrate, ask at most one clarifying question, dispatch to an
// implemented skill, or say plainly that an unbuilt skill isn't ready yet and
// offer a working alternative instead.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runDiagnose } from "./diagnose.ts";
import { runNetworkTriage } from "./networkTriage.ts";
import { loadRescueRuntime } from "./runtime.ts";
import { type SkillIO, ioFromContext } from "./types.ts";

export type SkillId =
  | "network-audit-perf"
  | "network-triage"
  | "network-audit-map-security"
  | "boot-repair"
  | "diagnose"
  | "harden"
  | "disk-rescue"
  | "intercept"
  | "reverse"
  | "remote"
  | "ssh-tunnel"
  | "keys"
  | "mikrotik"
  | "incident-triage";

export interface RouteRule {
  id: SkillId;
  /** Plain-language description of what running this skill does, for narration. */
  description: string;
  /** Lower-cased substrings; any match routes to this rule. Checked in table order, first match wins. */
  triggers: string[];
  /** Which implemented skill to offer instead when `id` itself isn't built yet. Defaults to "diagnose". */
  fallback?: "diagnose" | "network-triage";
}

/**
 * The intent -> skill routing table from docs/specs/pi-rescue-spec.md
 * §"Zero-knowledge UX". Order matters: more specific rules (a network-flavored
 * "slow") are listed before the generic "the computer is slow" rule so they
 * win the first-match-wins scan.
 */
export const ROUTING_TABLE: RouteRule[] = [
  {
    id: "network-audit-perf",
    description: "check how well your network is performing (speed and latency across the whole network)",
    fallback: "network-triage",
    triggers: [
      "wifi",
      "wi-fi",
      "pages take forever",
      "page takes forever",
      "network feels laggy",
      "network is slow",
      "network laggy",
      "internet is slow",
      "internet laggy",
      "laggy",
    ],
  },
  {
    id: "network-triage",
    description: "check this machine's own network connection, step by step",
    triggers: [
      "can't reach",
      "cannot reach",
      "no internet on this machine",
      "dns not working",
      "dns is not working",
      "no internet",
      "not connecting to the internet",
    ],
  },
  {
    id: "network-audit-map-security",
    description: "map everything connected to your network and check it for obvious security problems",
    fallback: "network-triage",
    triggers: [
      "map my network",
      "what's on my network",
      "whats on my network",
      "is my network safe",
      "is my network secure",
    ],
  },
  {
    id: "boot-repair",
    description: "figure out why the machine won't boot and fix it",
    triggers: [
      "won't boot",
      "wont boot",
      "won't start",
      "wont start",
      "doesn't start",
      "doesnt start",
      "won't turn on",
      "wont turn on",
    ],
  },
  {
    id: "diagnose",
    description:
      "look at what's going on with this machine overall (performance, crashes, heat, disk, hardware)",
    triggers: [
      "is slow",
      "slow",
      "crashing",
      "crashes",
      "keeps crashing",
      "very hot",
      "is hot",
      "running hot",
      "overheating",
    ],
  },
  {
    id: "harden",
    description: "check security settings and lock the machine down",
    triggers: ["is this box secure", "is this secure", "lock this down", "lock it down", "harden this"],
  },
  {
    id: "disk-rescue",
    description: "try to recover deleted files or rescue data off a failing disk",
    triggers: [
      "recover files",
      "i deleted",
      "get it back",
      "disk is failing",
      "drive is failing",
      "lost my files",
      "deleted a file",
    ],
  },
  {
    id: "intercept",
    description: "capture and inspect the network traffic an app or device you control sends",
    triggers: [
      "show me what this app is sending",
      "what this app is sending",
      "what this website is sending",
      "capture its traffic",
      "decrypt its https",
      "see what it's sending",
      "see what it is sending",
    ],
  },
  {
    id: "reverse",
    description: "reverse-engineer an app you're authorized to test",
    triggers: ["reverse engineer", "what api does it call", "what api it calls"],
  },
  {
    id: "ssh-tunnel",
    description: "set up a tunnel or port-forward to one of your own servers",
    triggers: ["tunnel to", "set up a tunnel", "port forward"],
  },
  {
    id: "remote",
    description: "connect to, or run a command across, your own servers",
    triggers: ["run this on my servers", "connect me to my servers", "run this on my hosts"],
  },
  {
    id: "keys",
    description: "manage or rotate your SSH/encryption keys",
    triggers: ["rotate my keys", "manage my keys", "rotate keys", "manage keys", "ssh key"],
  },
  {
    id: "mikrotik",
    description: "check your MikroTik router's configuration and logs",
    fallback: "network-triage",
    triggers: ["mikrotik", "check my router"],
  },
  {
    id: "incident-triage",
    description: "collect evidence and check for signs of a break-in",
    triggers: ["i think i got hacked", "i think i was hacked", "got hacked", "been hacked", "was hacked"],
  },
];

export interface ClassifyResult {
  id: SkillId;
  description: string;
  trigger: string;
  /** Which implemented skill to fall back to if `id` itself isn't built yet. */
  fallback: "diagnose" | "network-triage";
}

/** Pure intent classifier: lower-cases `text` and returns the first routing rule whose trigger matches. */
export function classifyIntent(text: string): ClassifyResult | undefined {
  const lower = text.toLowerCase();
  for (const rule of ROUTING_TABLE) {
    const trigger = rule.triggers.find((t) => lower.includes(t));
    if (trigger)
      return { id: rule.id, description: rule.description, trigger, fallback: rule.fallback ?? "diagnose" };
  }
  return undefined;
}

/** Skills this wave actually implements; everything else in the routing table is a real, named gap. */
export const IMPLEMENTED_SKILLS: ReadonlySet<SkillId> = new Set<SkillId>(["diagnose", "network-triage"]);

export type AssistActionKind = "run" | "not-ready" | "clarify";

export interface AssistAction {
  kind: AssistActionKind;
  id?: SkillId;
  /** Only set when `kind === "not-ready"`: the implemented skill to offer running instead. */
  fallbackId?: "diagnose" | "network-triage";
  message: string;
}

const FALLBACK_LABEL: Record<"diagnose" | "network-triage", string> = {
  diagnose: "a general check-up",
  "network-triage": "a network connection check",
};

/** Pure decision step: classify, then decide whether to run, admit a gap, or ask one clarifying question. */
export function decideAssistAction(text: string): AssistAction {
  const match = classifyIntent(text);
  if (!match) {
    return {
      kind: "clarify",
      message:
        "I'm not sure exactly what's wrong yet. In a word or two: is it the machine (slow, crashing, won't start), the network, or security?",
    };
  }
  if (!IMPLEMENTED_SKILLS.has(match.id)) {
    return {
      kind: "not-ready",
      id: match.id,
      fallbackId: match.fallback,
      message: `That would normally ${match.description}, but that part of pi-rescue isn't built yet. I can run ${FALLBACK_LABEL[match.fallback]} instead — want me to?`,
    };
  }
  return {
    kind: "run",
    id: match.id,
    message: `That sounds like I should ${match.description}. Let me take a look.`,
  };
}

const CLARIFY_OPTIONS: Record<string, SkillId> = {
  "Machine is slow, crashing, or won't start": "diagnose",
  "Network or wifi problem": "network-triage",
};

export interface AssistDeps {
  io: SkillIO;
  dispatch?: (id: SkillId, io: SkillIO) => Promise<void>;
}

/** Runs the real, implemented skill behind `id` with the live runtime (model + RAG). */
async function dispatchImplemented(id: SkillId, io: SkillIO): Promise<void> {
  const { model, rag } = await loadRescueRuntime();
  if (id === "diagnose") {
    await runDiagnose({ io, model, rag });
    return;
  }
  if (id === "network-triage") {
    await runNetworkTriage({ io, model, rag });
    return;
  }
  throw new Error(`assist: "${id}" is not an implemented skill`);
}

/** The full assist flow: classify -> clarify (at most once) / admit a gap / dispatch -> narrate. */
export async function runAssist(text: string, deps: AssistDeps): Promise<void> {
  const dispatch = deps.dispatch ?? dispatchImplemented;
  const action = decideAssistAction(text);
  deps.io.print(action.message);

  if (action.kind === "run" && action.id) {
    await dispatch(action.id, deps.io);
    return;
  }

  if (action.kind === "not-ready") {
    const fallbackId = action.fallbackId ?? "diagnose";
    const runFallback = await deps.io.confirm(`Run ${FALLBACK_LABEL[fallbackId]} instead?`, action.message);
    if (runFallback) await dispatch(fallbackId, deps.io);
    return;
  }

  // kind === "clarify": ask exactly one simple question, then dispatch on the answer (or stop).
  const choice = await deps.io.choose("What's going on?", [
    ...Object.keys(CLARIFY_OPTIONS),
    "Something else",
  ]);
  const id = choice ? CLARIFY_OPTIONS[choice] : undefined;
  if (id) {
    await dispatch(id, deps.io);
  } else {
    deps.io.print(
      "No problem — describe it in your own words whenever you're ready, or try /diagnose or /network-triage directly.",
    );
  }
}

/** The pi `/assist` command handler. */
export async function assist(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const text = args.trim();
  const io = ioFromContext(ctx);
  if (!text) {
    io.print(
      'Tell me what\'s wrong, in your own words — e.g. "the wifi is slow" or "this laptop won\'t start".',
    );
    return;
  }
  await runAssist(text, { io });
}
