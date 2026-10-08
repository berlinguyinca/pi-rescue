import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseInxiMemoryUsage,
  parseInxiSections,
  parseSmartctlSummary,
  smartctlLooksUnhealthy,
} from "../../src/skills/parsers.ts";

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

test("parseInxiSections: groups indented lines under their heading", async () => {
  const output = await readFile(fixture("inxi-sample.txt"), "utf8");
  const sections = parseInxiSections(output);
  assert.ok(sections.Memory);
  assert.ok(sections.Drives);
  assert.ok(sections.Memory?.some((l) => l.includes("System RAM")));
});

test("parseInxiMemoryUsage: reads total/used/percent out of the Memory section", async () => {
  const output = await readFile(fixture("inxi-sample.txt"), "utf8");
  const usage = parseInxiMemoryUsage(parseInxiSections(output));
  assert.ok(usage);
  assert.equal(usage?.percent, 72.4);
  assert.match(usage?.usedRaw ?? "", /22\.65 GiB/);
  assert.match(usage?.totalRaw ?? "", /32 GiB/);
});

test("parseInxiMemoryUsage: undefined when there's no Memory section at all", () => {
  assert.equal(parseInxiMemoryUsage({}), undefined);
});

test("parseSmartctlSummary: a healthy drive has no reallocated/pending sectors", async () => {
  const output = await readFile(fixture("smartctl-healthy.txt"), "utf8");
  const summary = parseSmartctlSummary(output);
  assert.equal(summary.health, "PASSED");
  assert.equal(summary.reallocatedSectors, 0);
  assert.equal(summary.pendingSectors, 0);
  assert.equal(summary.temperatureCelsius, 33);
  assert.equal(smartctlLooksUnhealthy(summary), false);
});

test("parseSmartctlSummary: reallocated/pending sectors flag a drive as unhealthy even when PASSED", async () => {
  const output = await readFile(fixture("smartctl-unhealthy.txt"), "utf8");
  const summary = parseSmartctlSummary(output);
  assert.equal(summary.health, "PASSED", "the coarse self-assessment still says PASSED");
  assert.equal(summary.reallocatedSectors, 12);
  assert.equal(summary.pendingSectors, 3);
  assert.equal(smartctlLooksUnhealthy(summary), true, "attributes should override the coarse health line");
});

test("parseSmartctlSummary: an unparseable report comes back UNKNOWN, not a throw", () => {
  const summary = parseSmartctlSummary("garbage output, no smart data here");
  assert.equal(summary.health, "UNKNOWN");
  assert.equal(summary.reallocatedSectors, undefined);
});
