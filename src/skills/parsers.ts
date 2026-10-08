// Pure parsers for collector output. Kept separate from execution so they can
// be unit-tested against fixture text with no process spawned at all.

/** One top-level `inxi -Fxxxz` section (e.g. "Memory") and its indented lines, trimmed. */
export type InxiSections = Record<string, string[]>;

/**
 * Splits `inxi -Fxxxz` output into sections. inxi prints unindented
 * `Label:` lines ("Memory:", "Drives:", ...) followed by indented detail
 * lines; this groups the detail lines under their section label.
 */
export function parseInxiSections(output: string): InxiSections {
  const sections: InxiSections = {};
  let current: string | undefined;
  for (const rawLine of output.split("\n")) {
    if (rawLine.trim().length === 0) continue;
    const isTopLevel = /^\S/.test(rawLine) && rawLine.trim().endsWith(":");
    if (isTopLevel) {
      current = rawLine.trim().slice(0, -1);
      sections[current] = [];
      continue;
    }
    if (current) {
      sections[current]?.push(rawLine.trim());
    }
  }
  return sections;
}

export interface MemoryUsage {
  totalRaw: string;
  usedRaw: string;
  percent: number;
}

/** Reads the `used: X GiB (NN%)` figure out of inxi's Memory section. */
export function parseInxiMemoryUsage(sections: InxiSections): MemoryUsage | undefined {
  const lines = sections.Memory ?? [];
  const line = lines.find((l) => /used:/.test(l));
  if (!line) return undefined;
  const totalMatch = /total:\s*([^\s]+(?:\s[A-Za-z]+)?)/.exec(line);
  const usedMatch = /used:\s*([0-9.]+\s*[A-Za-z]+)\s*\(([0-9.]+)%\)/.exec(line);
  if (!usedMatch) return undefined;
  return {
    totalRaw: totalMatch?.[1]?.trim() ?? "",
    usedRaw: usedMatch[1]?.trim() ?? "",
    percent: Number(usedMatch[2]),
  };
}

export type SmartHealth = "PASSED" | "FAILED" | "UNKNOWN";

export interface SmartctlSummary {
  health: SmartHealth;
  reallocatedSectors: number | undefined;
  pendingSectors: number | undefined;
  uncorrectableSectors: number | undefined;
  temperatureCelsius: number | undefined;
}

/**
 * Pulls the handful of attributes that actually predict drive failure out of
 * `smartctl -H -A` output: overall health, Reallocated_Sector_Ct,
 * Current_Pending_Sector, Offline_Uncorrectable, and temperature.
 */
export function parseSmartctlSummary(output: string): SmartctlSummary {
  const healthMatch = /overall-health self-assessment test result:\s*(\w+)/i.exec(output);
  const health: SmartHealth =
    healthMatch?.[1]?.toUpperCase() === "PASSED"
      ? "PASSED"
      : healthMatch?.[1]?.toUpperCase() === "FAILED"
        ? "FAILED"
        : "UNKNOWN";

  const attr = (name: string): number | undefined => {
    const re = new RegExp(`^\\s*\\d+\\s+${name}\\b.*?(\\d+)\\s*$`, "m");
    const match = re.exec(output);
    return match?.[1] !== undefined ? Number(match[1]) : undefined;
  };

  const tempMatch = /Temperature_Celsius\b.*?(\d+)(?:\s*\(|$)/m.exec(output);

  return {
    health,
    reallocatedSectors: attr("Reallocated_Sector_Ct"),
    pendingSectors: attr("Current_Pending_Sector"),
    uncorrectableSectors: attr("Offline_Uncorrectable"),
    temperatureCelsius: tempMatch?.[1] !== undefined ? Number(tempMatch[1]) : undefined,
  };
}

/** True when SMART data itself says the drive is in trouble — not just "could be healthier". */
export function smartctlLooksUnhealthy(summary: SmartctlSummary): boolean {
  return (
    summary.health === "FAILED" ||
    (summary.reallocatedSectors ?? 0) > 0 ||
    (summary.pendingSectors ?? 0) > 0 ||
    (summary.uncorrectableSectors ?? 0) > 0
  );
}
