import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CollectorSpec,
  type Exec,
  type ExecResult,
  parseScannedDevices,
  rootAwareInvocation,
  runCollector,
  runCollectors,
} from "../../src/skills/collectors.ts";

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", code: 0 };
}

test("rootAwareInvocation: wraps root-needing commands in non-interactive sudo", () => {
  const spec: CollectorSpec = { name: "dmesg", command: "dmesg", args: ["-T"], needsRoot: true };
  assert.deepEqual(rootAwareInvocation(spec), { command: "sudo", args: ["-n", "dmesg", "-T"] });
});

test("rootAwareInvocation: leaves a non-root command alone", () => {
  const spec: CollectorSpec = { name: "ip", command: "ip", args: ["-br", "addr"] };
  assert.deepEqual(rootAwareInvocation(spec), { command: "ip", args: ["-br", "addr"] });
});

test("runCollector: a missing binary (ENOENT, code null) becomes a plain 'not installed' note, not a throw", async () => {
  const exec: Exec = async () => ({ stdout: "", stderr: "spawn inxi ENOENT", code: null });
  const result = await runCollector({ name: "inxi", command: "inxi", args: ["-Fxxxz"] }, exec);
  assert.equal(result.ok, false);
  assert.equal(result.note, "not installed on this box");
});

test("runCollector: sudo -n failing with a password prompt becomes a plain 'needs admin rights' note", async () => {
  const exec: Exec = async (command) => {
    if (command === "sudo") return { stdout: "", stderr: "sudo: a password is required", code: 1 };
    throw new Error("should not fall back to the bare command here");
  };
  const result = await runCollector({ name: "dmesg", command: "dmesg", args: ["-T"], needsRoot: true }, exec);
  assert.equal(result.ok, false);
  assert.equal(result.note, "needs admin rights to run here");
});

test("runCollector: falls back to the bare command when sudo itself isn't present", async () => {
  const calls: string[] = [];
  const exec: Exec = async (command) => {
    calls.push(command);
    if (command === "sudo") return { stdout: "", stderr: "", code: null };
    return ok("dmesg output");
  };
  const result = await runCollector({ name: "dmesg", command: "dmesg", args: ["-T"], needsRoot: true }, exec);
  assert.deepEqual(calls, ["sudo", "dmesg"]);
  assert.equal(result.ok, true);
  assert.equal(result.output, "dmesg output");
});

test("runCollector: a successful run is ok with its stdout as output", async () => {
  const exec: Exec = async () => ok("eth0 UP\n");
  const result = await runCollector({ name: "ip", command: "ip", args: ["-br", "link"] }, exec);
  assert.deepEqual(result, { name: "ip", command: "ip", ok: true, output: "eth0 UP\n" });
});

test("runCollectors: drops an optional collector silently when it's not installed", async () => {
  const exec: Exec = async (command) =>
    command === "lynis" ? { stdout: "", stderr: "ENOENT", code: null } : ok("fine");
  const results = await runCollectors(
    [
      { name: "ip", command: "ip", args: [] },
      { name: "lynis", command: "lynis", args: [], optional: true },
    ],
    exec,
  );
  assert.deepEqual(
    results.map((r) => r.name),
    ["ip"],
  );
});

test("parseScannedDevices: pulls /dev/... paths out of smartctl --scan output", () => {
  const output = [
    "/dev/sda -d scsi # /dev/sda, SCSI device",
    "/dev/nvme0 -d nvme # /dev/nvme0, NVMe device",
    "",
  ].join("\n");
  assert.deepEqual(parseScannedDevices(output), ["/dev/sda", "/dev/nvme0"]);
});
