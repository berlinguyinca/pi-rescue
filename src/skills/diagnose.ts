// Flagship skill: inxi/dmesg/journal/SMART/sensors/ip/lynis -> RAG -> model ->
// plain-language root-cause report. See docs/specs/pi-rescue-spec.md.
//
// `diagnose()` is the pi command handler (the exact shape `registerCommand`
// expects). `runDiagnose()` is the actual implementation, built entirely on
// injected dependencies (`io`, `exec`, `rag`, `model`) so it can run under
// `node --test` with no shell, no Ollama, and no network.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelRouter } from "../model/router.ts";
import type { ChatMessage } from "../model/types.ts";
import type { RagEngine } from "../rag/index.ts";
import {
  type CollectedOutput,
  type Exec,
  diagnoseCollectors,
  parseScannedDevices,
  realExec,
  runCollector,
  runCollectors,
  smartctlDeviceCollector,
} from "./collectors.ts";
import {
  parseInxiMemoryUsage,
  parseInxiSections,
  parseSmartctlSummary,
  smartctlLooksUnhealthy,
} from "./parsers.ts";
import { loadRescueRuntime } from "./runtime.ts";
import { type SkillIO, ioFromContext } from "./types.ts";

const MAX_SECTION_CHARS = 1_200;

export interface SuggestedFix {
  description: string;
  command: string;
  args: string[];
}

/** Trims one collector's raw output to something a small model's context can actually hold. */
function capSection(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= MAX_SECTION_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SECTION_CHARS)}\n…(truncated)`;
}

/** `smartctl:<device>` results get the parsed attributes, not the raw table — the signal (pending/reallocated
 *  sectors) can sit past the raw-text cutoff, where a plain truncation would hide it from the model. */
function formatSmartctlSection(result: CollectedOutput): string {
  const summary = parseSmartctlSummary(result.output);
  const flag = smartctlLooksUnhealthy(summary)
    ? "This drive's attributes indicate a real problem, even if the overall health line says otherwise."
    : "Attributes look normal.";
  return [
    `## ${result.name}`,
    `health=${summary.health} reallocated=${summary.reallocatedSectors ?? "?"} pending=${summary.pendingSectors ?? "?"} uncorrectable=${summary.uncorrectableSectors ?? "?"} temperature=${summary.temperatureCelsius ?? "?"}C`,
    flag,
  ].join("\n");
}

/** `inxi` gets a parsed memory-usage headline ahead of its (still capped) raw text. */
function formatInxiSection(result: CollectedOutput): string {
  const memory = parseInxiMemoryUsage(parseInxiSections(result.output));
  const lines = [`## ${result.name}`];
  if (memory) lines.push(`Memory used: ${memory.usedRaw} of ${memory.totalRaw} (${memory.percent}%)`);
  lines.push(capSection(result.output));
  return lines.join("\n");
}

/** Assembles the collected read-only context into one bounded block of text for the model. */
export function buildContextSummary(results: CollectedOutput[]): string {
  return results
    .map((r) => {
      if (!r.ok) return `## ${r.name}\n(skipped: ${r.note ?? "no output"})`;
      if (r.name.startsWith("smartctl:")) return formatSmartctlSection(r);
      if (r.name === "inxi") return formatInxiSection(r);
      return `## ${r.name}\n${capSection(r.output)}`;
    })
    .join("\n\n");
}

/**
 * Builds the RAG query from the findings that actually look like problems
 * (dmesg/journal error lines, unhealthy SMART attributes) instead of just
 * the first 500 characters of the context block, which in practice is only
 * ever inxi's kernel/distro header — never the thing that's actually wrong.
 */
export function buildRagQuery(results: CollectedOutput[]): string {
  const parts: string[] = [];
  for (const name of ["dmesg", "journal-errors"]) {
    const result = results.find((r) => r.name === name);
    if (result?.ok && result.output.trim()) {
      parts.push(result.output.split("\n").slice(0, 10).join(" "));
    }
  }
  for (const result of results) {
    if (
      result.ok &&
      result.name.startsWith("smartctl:") &&
      smartctlLooksUnhealthy(parseSmartctlSummary(result.output))
    ) {
      parts.push(`${result.name}: SMART attributes show reallocated or pending sectors, disk may be failing`);
    }
  }
  if (parts.length === 0) {
    return "general system health check: performance, crashes, disk, memory, hardware";
  }
  return parts.join(" ").slice(0, 800);
}

/** Detects disk-space pressure in `df -h` output and proposes the one safe, reversible housekeeping fix. */
export function suggestFixes(results: CollectedOutput[]): SuggestedFix[] {
  const fixes: SuggestedFix[] = [];
  const df = results.find((r) => r.name === "df");
  if (df?.ok && /\b(9[5-9]|100)%/.test(df.output)) {
    fixes.push({
      description:
        "A disk is almost full. I can free some space by trimming old system logs (journald) to the last 2 weeks — this doesn't touch your files.",
      command: "sudo",
      args: ["-n", "journalctl", "--vacuum-time=2weeks"],
    });
  }
  return fixes;
}

export interface DiagnoseDeps {
  io: SkillIO;
  exec?: Exec;
  rag?: RagEngine;
  model?: ModelRouter;
  includeLynis?: boolean;
  topK?: number;
}

export interface DiagnoseResult {
  report: string;
  findings: CollectedOutput[];
  fixesApplied: string[];
}

function fallbackReport(results: CollectedOutput[]): string {
  const problems = results.filter((r) => !r.ok && r.note && r.note !== "not installed on this box");
  if (problems.length === 0) {
    return "I collected system info but couldn't reach a diagnosis model (gateway and local Ollama are both unavailable). Nothing obviously broken turned up in the raw collection, but I can't explain it in plain language right now — try again once a model is reachable.";
  }
  const lines = problems.map((p) => `- ${p.name}: ${p.note}`);
  return [
    "I couldn't reach a diagnosis model (gateway and local Ollama are both unavailable), so here's the raw summary:",
    ...lines,
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are a calm, plain-language Linux diagnostic assistant for pi-rescue.",
  "You are given read-only system collector output and relevant knowledge-base excerpts.",
  "Explain, in plain language a non-expert can follow:",
  "1) what's wrong (if anything), 2) why, 3) how severe (low/medium/high), 4) a suggested fix.",
  "Never dump raw logs back at the user. No jargon unless the user used it first.",
  "If a fix would change the system, say so explicitly and that it needs confirmation first.",
].join(" ");

/** The actual diagnose implementation: collect -> RAG -> model -> plain-language report -> gated fix. */
export async function runDiagnose(deps: DiagnoseDeps): Promise<DiagnoseResult> {
  const exec = deps.exec ?? realExec;
  deps.io.print("Looking at your system now — this step only reads, it won't change anything.");

  let results = await runCollectors(diagnoseCollectors({ includeLynis: deps.includeLynis }), exec);
  const scan = results.find((r) => r.name === "smartctl-scan");
  if (scan?.ok) {
    for (const device of parseScannedDevices(scan.output)) {
      results = [...results, await runCollector(smartctlDeviceCollector(device), exec)];
    }
  }

  const context = buildContextSummary(results);
  let ragHits: Array<{ chunk: { text: string } }> = [];
  if (deps.rag) {
    try {
      ragHits = await deps.rag.retrieve(buildRagQuery(results), deps.topK ?? 6);
    } catch {
      ragHits = [];
    }
  }
  const kbContext = ragHits.map((h) => h.chunk.text).join("\n\n---\n\n");

  let report: string;
  if (deps.model) {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "Collected system context:",
          context,
          kbContext ? `\n\nRelevant knowledge base notes:\n${kbContext}` : "",
        ].join("\n"),
      },
    ];
    try {
      const completion = await deps.model.complete(messages, "diagnostician");
      report = completion.text;
    } catch {
      report = fallbackReport(results);
    }
  } else {
    report = fallbackReport(results);
  }

  deps.io.print(report);

  const fixesApplied: string[] = [];
  for (const fix of suggestFixes(results)) {
    const confirmed = await deps.io.confirm("Apply this fix?", fix.description);
    if (!confirmed) {
      deps.io.print(`Skipped: ${fix.description}`);
      continue;
    }
    const outcome = await exec(fix.command, fix.args);
    fixesApplied.push(fix.description);
    deps.io.print(
      outcome.code === 0
        ? `Done: ${fix.description}`
        : `That didn't fully work (${fix.command} exited ${outcome.code}); nothing else was changed.`,
    );
  }

  return { report, findings: results, fixesApplied };
}

/** The pi `/diagnose` command handler. */
export async function diagnose(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const includeLynis = args.trim() === "--full";
  const { model, rag } = await loadRescueRuntime();
  await runDiagnose({ io: ioFromContext(ctx), model, rag, includeLynis });
}
