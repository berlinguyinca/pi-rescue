// Read-only system collectors for /diagnose and /network-triage. Every
// collector shells out via `execFile` (no shell, so no injection surface),
// never mutates anything, and is injected as an `Exec` function so unit
// tests never spawn a real process. See AGENTS.md: "read-only collection first".
import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /**
   * Set only when `code` is null, distinguishing "the binary doesn't exist"
   * from "it ran too long and was killed" — the two look identical as a bare
   * null exit code, but mean opposite things for an optional collector.
   */
  failure?: "ENOENT" | "TIMEOUT" | "SPAWN_ERROR";
}

/** The minimal process-spawning surface a collector needs — swap for a fake in tests. */
export type Exec = (command: string, args: string[], timeoutMs?: number) => Promise<ExecResult>;

/** Runs a real process. Never rejects: a spawn failure (ENOENT, timeout, non-zero exit) becomes a normal result. */
export const realExec: Exec = (command, args, timeoutMs = 15_000) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
        return;
      }
      const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      if (typeof err.code === "number") {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: err.code });
        return;
      }
      // Killed for running past `timeoutMs`: a real, installed command that was just too slow.
      if (err.killed || err.signal) {
        resolve({ stdout: stdout ?? "", stderr: stderr || err.message, code: null, failure: "TIMEOUT" });
        return;
      }
      // Spawn-level failure: the binary itself doesn't exist (ENOENT) or couldn't run (EACCES, ...).
      resolve({
        stdout: stdout ?? "",
        stderr: stderr || err.message,
        code: null,
        failure: err.code === "ENOENT" ? "ENOENT" : "SPAWN_ERROR",
      });
    });
  });

export interface CollectorSpec {
  /** Short, stable id used in the report and in tests. */
  name: string;
  command: string;
  args: string[];
  /** Needs elevated privileges on most distros (dmesg_restrict, smartctl, lynis, nft). */
  needsRoot?: boolean;
  /** Not part of the base image (e.g. lynis); a missing binary is a quiet skip, not a failure. */
  optional?: boolean;
}

export interface CollectedOutput {
  name: string;
  command: string;
  /** True when the command ran and exited 0. */
  ok: boolean;
  output: string;
  /** Plain-language reason it didn't run or didn't help, e.g. "not installed", "needs admin rights". */
  note?: string;
}

/**
 * Builds the actual argv for a spec. Root-needing commands are tried under
 * non-interactive `sudo -n` first so a missing password prompt fails fast
 * instead of hanging pi's TUI; the caller falls back to the bare command if
 * that invocation itself doesn't run.
 */
export function rootAwareInvocation(spec: CollectorSpec): { command: string; args: string[] } {
  if (!spec.needsRoot) return { command: spec.command, args: spec.args };
  return { command: "sudo", args: ["-n", spec.command, ...spec.args] };
}

const NOT_INSTALLED_NOTE = "not installed on this box";
const NEEDS_ROOT_NOTE = "needs admin rights to run here";
const TIMED_OUT_NOTE = "took too long to respond and was stopped";

/** Runs one collector, handling "not installed" and "needs root" as plain-language notes, never throwing. */
export async function runCollector(spec: CollectorSpec, exec: Exec = realExec): Promise<CollectedOutput> {
  const primary = rootAwareInvocation(spec);
  let result = await exec(primary.command, primary.args);

  if (result.code === null && result.failure !== "TIMEOUT" && primary.command === "sudo") {
    // sudo itself isn't present/didn't run (e.g. a minimal container) — fall back to the bare command.
    result = await exec(spec.command, spec.args);
  }

  if (result.code === null) {
    if (result.failure === "TIMEOUT") {
      return {
        name: spec.name,
        command: spec.command,
        ok: false,
        output: result.stdout,
        note: TIMED_OUT_NOTE,
      };
    }
    return { name: spec.name, command: spec.command, ok: false, output: "", note: NOT_INSTALLED_NOTE };
  }
  if (result.code !== 0) {
    if (spec.needsRoot && /password|sudo:|permission denied|must be root/i.test(result.stderr)) {
      return { name: spec.name, command: spec.command, ok: false, output: "", note: NEEDS_ROOT_NOTE };
    }
    return {
      name: spec.name,
      command: spec.command,
      ok: false,
      output: result.stdout,
      note: result.stderr.trim().slice(0, 300) || `exited with code ${result.code}`,
    };
  }
  return { name: spec.name, command: spec.command, ok: true, output: result.stdout };
}

/** Runs every collector, dropping an optional one silently if it isn't installed. */
export async function runCollectors(
  specs: CollectorSpec[],
  exec: Exec = realExec,
): Promise<CollectedOutput[]> {
  const results: CollectedOutput[] = [];
  for (const spec of specs) {
    const result = await runCollector(spec, exec);
    if (spec.optional && result.note === NOT_INSTALLED_NOTE) continue;
    results.push(result);
  }
  return results;
}

/** The flagship /diagnose collector set (docs/specs §Skill roadmap, item 1). `lynis` only runs with `includeLynis`. */
export function diagnoseCollectors(options: { includeLynis?: boolean } = {}): CollectorSpec[] {
  const specs: CollectorSpec[] = [
    { name: "inxi", command: "inxi", args: ["-Fxxxz"], optional: true },
    { name: "dmesg", command: "dmesg", args: ["-T", "--level=err,warn"], needsRoot: true },
    { name: "journal-errors", command: "journalctl", args: ["-p", "err", "-b", "--no-pager"] },
    { name: "smartctl-scan", command: "smartctl", args: ["--scan"], needsRoot: true, optional: true },
    { name: "sensors", command: "sensors", args: [], optional: true },
    { name: "ip-addr", command: "ip", args: ["-br", "addr"] },
    // Pseudo filesystems (snap loop mounts, squashfs, the live-USB's own iso9660, overlay) sit at
    // 100% by design — excluding them is the difference between a real finding and a false alarm.
    {
      name: "df",
      command: "df",
      args: ["-h", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs", "-x", "iso9660", "-x", "overlay"],
    },
    { name: "free", command: "free", args: ["-h"] },
  ];
  if (options.includeLynis) {
    specs.push({
      name: "lynis",
      command: "lynis",
      args: ["audit", "system", "--quick", "--no-colors"],
      needsRoot: true,
      optional: true,
    });
  }
  return specs;
}

/** Per-device SMART detail, once `smartctl --scan` has told us which devices exist. */
export function smartctlDeviceCollector(device: string): CollectorSpec {
  return { name: `smartctl:${device}`, command: "smartctl", args: ["-H", "-A", device], needsRoot: true };
}

/** Pulls `/dev/sdX`-style device paths out of `smartctl --scan` output. */
export function parseScannedDevices(scanOutput: string): string[] {
  const devices: string[] = [];
  for (const line of scanOutput.split("\n")) {
    const match = /^(\/dev\/\S+)/.exec(line.trim());
    if (match?.[1]) devices.push(match[1]);
  }
  return devices;
}
