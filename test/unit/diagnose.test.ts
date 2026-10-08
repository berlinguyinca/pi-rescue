import assert from "node:assert/strict";
import { test } from "node:test";
import type { RagEngine } from "../../src/rag/index.ts";
import type { CollectedOutput } from "../../src/skills/collectors.ts";
import { diagnoseCollectors } from "../../src/skills/collectors.ts";
import { buildContextSummary, buildRagQuery, runDiagnose, suggestFixes } from "../../src/skills/diagnose.ts";
import { collectingIO } from "../../src/skills/types.ts";

function collected(name: string, ok: boolean, output: string, note?: string): CollectedOutput {
  return { name, command: name, ok, output, note };
}

test("diagnoseCollectors: df excludes pseudo filesystems that always read ~100%", () => {
  const df = diagnoseCollectors().find((c) => c.name === "df");
  assert.ok(df);
  for (const fs of ["tmpfs", "devtmpfs", "squashfs", "iso9660", "overlay"]) {
    assert.ok(df?.args.includes(fs), `expected df to exclude ${fs}`);
  }
});

test("suggestFixes: proposes the journal-vacuum fix (via sudo -n) when a real filesystem is nearly full", () => {
  const results = [collected("df", true, "/dev/sda1       100G   98G  0G  98% /")];
  const fixes = suggestFixes(results);
  assert.equal(fixes.length, 1);
  assert.deepEqual(fixes[0]?.command, "sudo");
  assert.deepEqual(fixes[0]?.args, ["-n", "journalctl", "--vacuum-time=2weeks"]);
});

test("suggestFixes: proposes nothing when disk usage is unremarkable", () => {
  const results = [collected("df", true, "/dev/sda1       100G   40G  60G  40% /")];
  assert.deepEqual(suggestFixes(results), []);
});

test("buildContextSummary: a smartctl device section shows parsed attributes, not just the raw table", () => {
  const output = [
    "SMART overall-health self-assessment test result: PASSED",
    "  5 Reallocated_Sector_Ct   0x0033   100   100   010    Pre-fail  Always       -       12",
    "197 Current_Pending_Sector  0x0012   100   100   000    Old_age   Always       -       3",
  ].join("\n");
  const summary = buildContextSummary([collected("smartctl:/dev/sda", true, output)]);
  assert.match(summary, /reallocated=12/);
  assert.match(summary, /pending=3/);
  assert.match(summary, /real problem/);
});

test("buildContextSummary: an inxi section gets a parsed memory headline ahead of the raw text", () => {
  const output = "Memory:\n  System RAM: total: 32 GiB available: 31.28 GiB used: 22.65 GiB (72.4%)\n";
  const summary = buildContextSummary([collected("inxi", true, output)]);
  assert.match(summary, /Memory used: 22\.65 GiB of 32 GiB \(72\.4%\)/);
});

test("buildRagQuery: pulls from dmesg/journal errors and unhealthy SMART findings, not just the first 500 chars", () => {
  const results = [
    collected("inxi", true, "System:\n  Kernel: 6.8.0\nMemory:\n  used: 1 GiB (1%)"),
    collected("dmesg", true, "[   12.0] ata1: exception Emask 0x0 SAct 0x0\n"),
    collected(
      "smartctl:/dev/sda",
      true,
      "SMART overall-health self-assessment test result: PASSED\n  5 Reallocated_Sector_Ct 0x0033 100 100 010 Pre-fail Always - 12",
    ),
  ];
  const query = buildRagQuery(results);
  assert.match(query, /ata1/);
  assert.match(query, /reallocated/i);
  assert.doesNotMatch(query, /^System:/);
});

test("buildRagQuery: falls back to a generic query when nothing looks like a problem", () => {
  const results = [collected("inxi", true, "System:\n  Kernel: 6.8.0")];
  assert.match(buildRagQuery(results), /general system health check/);
});

test("runDiagnose: a RAG engine that throws on retrieve() doesn't crash the whole skill", async () => {
  const flakyRag = {
    retrieve: async () => {
      throw new Error("vector dimension mismatch");
    },
  } as unknown as RagEngine;
  const io = collectingIO();
  const result = await runDiagnose({
    io,
    rag: flakyRag,
    exec: async () => ({ stdout: "", stderr: "", code: null, failure: "ENOENT" }),
  });
  assert.ok(result.report.length > 0);
});
