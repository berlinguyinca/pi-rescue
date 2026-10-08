// Network debugging ladder: link/carrier -> DHCP/address -> gateway/route ->
// DNS -> MTU -> firewall. Each rung is a pure `evaluate*()` function over
// already-collected text, tested with fixtures; the ladder runner stops at
// the first failing rung (link/address/route/gateway/dns), exactly like
// kb/network-triage.md describes it. MTU and firewall are the last two rungs
// in that doc; firewall is informational only (pass/skip, never a hard fail)
// and MTU only runs once DNS itself is confirmed working.
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelRouter } from "../model/router.ts";
import type { ChatMessage } from "../model/types.ts";
import type { RagEngine } from "../rag/index.ts";
import { type CollectedOutput, type CollectorSpec, type Exec, realExec, runCollector } from "./collectors.ts";
import { loadRescueRuntime } from "./runtime.ts";
import { type SkillIO, ioFromContext } from "./types.ts";

export type RungStatus = "pass" | "fail" | "skip";

export interface RungResult {
  rung: string;
  status: RungStatus;
  detail: string;
}

/**
 * Virtual/container/VPN interfaces that would hide a real "no lease" or
 * "no carrier" failure behind a healthy-looking docker0 or an active tunnel.
 */
const IGNORED_INTERFACES = /^(lo|docker\d*|veth.*|br-.*|virbr.*|tap.*|tun.*|wg.*|tailscale.*|zt.*)$/;

function parseIpBrTable(output: string): Array<{ name: string; state: string; rest: string }> {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", state = "", ...rest] = line.split(/\s+/);
      return { name, state, rest: rest.join(" ") };
    })
    .filter((row) => row.name && !IGNORED_INTERFACES.test(row.name));
}

/** Rung 1: physical link / carrier. `ip -br link`'s state column is "UP" only when carrier is actually detected. */
export function evaluateLinkCarrier(ipBrLinkOutput: string): RungResult {
  const interfaces = parseIpBrTable(ipBrLinkOutput);
  if (interfaces.length === 0) {
    return {
      rung: "link",
      status: "fail",
      detail: "No real network interface was found at all (only loopback/virtual ones).",
    };
  }
  const up = interfaces.find((i) => i.state.toUpperCase() === "UP");
  if (up) {
    return {
      rung: "link",
      status: "pass",
      detail: `${up.name} has a live link (cable plugged in / Wi-Fi associated).`,
    };
  }
  const names = interfaces.map((i) => i.name).join(", ");
  return {
    rung: "link",
    status: "fail",
    detail: `No interface shows a live link (${names} all down). Check that the Ethernet cable is in a live port, or that Wi-Fi is connected.`,
  };
}

/** Rung 2: DHCP / address. A real interface with only a link-local or no address at all means no lease. */
export function evaluateAddress(ipBrAddrOutput: string): RungResult {
  const interfaces = parseIpBrTable(ipBrAddrOutput);
  const withRealAddress = interfaces.find((i) => /\b(?!127\.|169\.254\.)\d+\.\d+\.\d+\.\d+/.test(i.rest));
  if (withRealAddress) {
    return { rung: "address", status: "pass", detail: `${withRealAddress.name} has a real IP address.` };
  }
  return {
    rung: "address",
    status: "fail",
    detail:
      "The network card has a live link but no real IP address — DHCP didn't hand one out. That usually means no DHCP server on this network segment, a slow DHCP server, or the wrong VLAN.",
  };
}

/** Rung 3: default route exists. */
export function evaluateRoute(ipRouteOutput: string): RungResult {
  const gateway = parseDefaultGateway(ipRouteOutput);
  if (gateway !== undefined) {
    return { rung: "route", status: "pass", detail: `There is a default route via ${gateway}.` };
  }
  if (ipRouteOutput.split("\n").some((l) => l.trim().startsWith("default"))) {
    return { rung: "route", status: "pass", detail: "There is a default route." };
  }
  return {
    rung: "route",
    status: "fail",
    detail:
      "There's no default route, so this machine has an address but doesn't know how to reach the internet.",
  };
}

/** Pulls the gateway IP out of `ip route`'s `default via <ip>` line, if any. */
export function parseDefaultGateway(ipRouteOutput: string): string | undefined {
  const defaultLine = ipRouteOutput.split("\n").find((l) => l.trim().startsWith("default"));
  return defaultLine ? /default via (\S+)/.exec(defaultLine)?.[1] : undefined;
}

function pingSucceeded(output: string): boolean {
  if (!output || output.trim().length === 0) return false;
  const lossMatch = /(\d+)%\s*packet loss/.exec(output);
  if (!lossMatch) return false;
  return Number(lossMatch[1]) < 100;
}

/**
 * Rung 3b: the gateway found above actually answers a ping (route existing
 * isn't the same as the router being up). Many routers/firewalls are
 * configured to ignore ICMP as a matter of policy, so a non-answering
 * gateway is only a real finding if nothing else gets through either — if a
 * plain ping to the public internet succeeds, this is "skip", not "fail",
 * and the ladder keeps going instead of stopping on a false alarm.
 */
export function evaluateGatewayPing(gatewayPingOutput: string, baselinePingOutput: string): RungResult {
  if (pingSucceeded(gatewayPingOutput)) {
    return { rung: "gateway", status: "pass", detail: "The router/gateway answers a ping." };
  }
  if (pingSucceeded(baselinePingOutput)) {
    return {
      rung: "gateway",
      status: "skip",
      detail:
        "The router/gateway doesn't answer pings, but traffic still gets through to the internet — some routers are configured to ignore ICMP, which is normal and not a problem on its own.",
    };
  }
  return {
    rung: "gateway",
    status: "fail",
    detail:
      "There's a default route, but nothing answers a ping — not the gateway, not the internet. The router/gateway is likely down.",
  };
}

/** Rung 4: DNS. Compares resolving via the configured resolver against a known-good public one (1.1.1.1). */
export function evaluateDns(configuredResult: string, publicResult: string): RungResult {
  const configuredOk = configuredResult.trim().length > 0;
  const publicOk = publicResult.trim().length > 0;
  if (configuredOk) {
    return {
      rung: "dns",
      status: "pass",
      detail: "Name resolution works through the configured DNS server.",
    };
  }
  if (publicOk) {
    return {
      rung: "dns",
      status: "fail",
      detail:
        "Names resolve through a public DNS server (1.1.1.1) but not through the one this machine is configured to use — that server is misconfigured or unreachable.",
    };
  }
  return {
    rung: "dns",
    status: "fail",
    detail:
      "Name resolution doesn't work at all, even against a public DNS server — this is likely still a routing or firewall problem, not DNS itself.",
  };
}

/** A "frag needed"/"message too long" reply means path-MTU discovery IS working — the path is
 *  correctly telling us to use a smaller MTU, not silently swallowing the packet. */
const MTU_DISCOVERY_WORKING = /frag(?:mentation)? needed|message too long|mtu\s*[=:]\s*\d+/i;
/** Pulled separately from whichever phrase above matched, so the reported MTU number doesn't
 *  depend on which alternative in `MTU_DISCOVERY_WORKING` happened to match first. */
const MTU_VALUE = /mtu\s*[=:]\s*(\d+)/i;

/**
 * Rung 5: path-MTU black hole. The signature is a full-size, don't-fragment
 * ping that silently disappears (no reply, no error) while a plain ping to
 * the same host succeeds. An explicit "fragmentation needed"/"message too
 * long" reply is the opposite finding — PMTU discovery working correctly —
 * common on PPPoE (1492) or inside a VPN tunnel (often ~1420), and must not
 * read as a black hole just because the don't-fragment ping itself failed.
 */
export function evaluateMtu(baselinePingOutput: string, mtuPingOutput: string): RungResult {
  if (!pingSucceeded(baselinePingOutput)) {
    return {
      rung: "mtu",
      status: "skip",
      detail: "Couldn't reach a test host at all, so a path-MTU check wouldn't tell us anything new.",
    };
  }
  if (pingSucceeded(mtuPingOutput)) {
    return { rung: "mtu", status: "pass", detail: "No path-MTU black hole detected." };
  }
  if (MTU_DISCOVERY_WORKING.test(mtuPingOutput)) {
    const mtuValue = MTU_VALUE.exec(mtuPingOutput)?.[1];
    return {
      rung: "mtu",
      status: "pass",
      detail: `Path-MTU discovery is working correctly (the path reported a smaller MTU${
        mtuValue ? ` of ${mtuValue}` : ""
      } instead of silently dropping packets).`,
    };
  }
  if (!mtuPingOutput.trim()) {
    return {
      rung: "mtu",
      status: "skip",
      detail:
        "Couldn't run the path-MTU check here (ping may need elevated permissions in this environment, or isn't installed).",
    };
  }
  return {
    rung: "mtu",
    status: "fail",
    detail:
      'A normal ping gets through, but a full-size "don\'t fragment" ping silently disappears — something in the path is dropping oversized packets without telling anyone (a path-MTU black hole). This can break VPNs and some HTTPS sites without a clear error.',
  };
}

/** Rung 6: local firewall — informational only. Never a hard failure; just says what it found or that it couldn't check. */
export function evaluateFirewall(
  ufw: CollectedOutput | undefined,
  nft: CollectedOutput | undefined,
): RungResult {
  if (ufw?.ok && ufw.output.trim().length > 0) {
    return { rung: "firewall", status: "pass", detail: `ufw: ${ufw.output.trim().split("\n")[0]}` };
  }
  if (nft?.ok && nft.output.trim().length > 0) {
    return { rung: "firewall", status: "pass", detail: "nftables has rules loaded on this machine." };
  }
  return {
    rung: "firewall",
    status: "skip",
    detail:
      "Couldn't check the local firewall (needs admin rights, or neither ufw nor nft is installed) — informational gap, not a finding.",
  };
}

export interface TriageDeps {
  io: SkillIO;
  exec?: Exec;
  rag?: RagEngine;
  model?: ModelRouter;
  topK?: number;
}

export interface TriageResult {
  rungs: RungResult[];
  firstFailure?: RungResult;
  report: string;
}

const RUNG_SPECS = {
  link: { name: "ip-br-link", command: "ip", args: ["-br", "link"] },
  address: { name: "ip-br-addr", command: "ip", args: ["-br", "addr"] },
  route: { name: "ip-route", command: "ip", args: ["route"] },
  dnsConfigured: {
    name: "dig-configured",
    command: "dig",
    args: ["+short", "+time=2", "example.com"],
    optional: true,
  },
  getentConfigured: {
    name: "getent-configured",
    command: "getent",
    args: ["ahostsv4", "example.com"],
    optional: true,
  },
  dnsPublic: {
    name: "dig-public",
    command: "dig",
    args: ["+short", "+time=2", "@1.1.1.1", "example.com"],
    optional: true,
  },
  pingBaseline: { name: "ping-baseline", command: "ping", args: ["-c1", "-W2", "1.1.1.1"], optional: true },
  pingMtu: {
    name: "ping-mtu",
    command: "ping",
    args: ["-M", "do", "-s", "1472", "-c1", "-W2", "1.1.1.1"],
    optional: true,
  },
  ufwStatus: {
    name: "ufw-status",
    command: "ufw",
    args: ["status", "verbose"],
    needsRoot: true,
    optional: true,
  },
  nftRuleset: {
    name: "nft-ruleset",
    command: "nft",
    args: ["list", "ruleset"],
    needsRoot: true,
    optional: true,
  },
} as const satisfies Record<string, CollectorSpec>;

/** `ping -c1 -W2 <gateway>` — built at runtime since the gateway comes from the route rung. */
function gatewayPingSpec(gateway: string): CollectorSpec {
  return { name: "ping-gateway", command: "ping", args: ["-c1", "-W2", gateway], optional: true };
}

const SYSTEM_PROMPT = [
  "You are a calm, plain-language network troubleshooting assistant for pi-rescue.",
  "You are given the single network-triage rung that failed, plus relevant knowledge-base notes.",
  "Explain in plain language what's wrong, why, and one concrete next step. No jargon dumps, no raw logs.",
].join(" ");

/** Runs the ladder, stopping at the first failing rung (or completing it, if everything passes). */
export async function runNetworkTriage(deps: TriageDeps): Promise<TriageResult> {
  const exec = deps.exec ?? realExec;
  deps.io.print("Checking your network connection, step by step — link, address, route, gateway, then DNS.");

  const rungs: RungResult[] = [];

  const link = evaluateLinkCarrier((await runCollector(RUNG_SPECS.link, exec)).output);
  rungs.push(link);
  if (link.status !== "fail") {
    const address = evaluateAddress((await runCollector(RUNG_SPECS.address, exec)).output);
    rungs.push(address);
    if (address.status !== "fail") {
      const routeOutput = (await runCollector(RUNG_SPECS.route, exec)).output;
      const route = evaluateRoute(routeOutput);
      rungs.push(route);
      const gateway = parseDefaultGateway(routeOutput);

      if (route.status !== "fail" && gateway) {
        const gatewayPing = await runCollector(gatewayPingSpec(gateway), exec);
        // Computed once, up front: used both to tell a genuinely-down gateway from one that just
        // ignores ICMP (below), and again by the MTU rung later on.
        const baseline = await runCollector(RUNG_SPECS.pingBaseline, exec);

        const gatewayResult: RungResult =
          !gatewayPing.ok && !baseline.ok
            ? {
                rung: "gateway",
                status: "skip",
                detail:
                  "Couldn't check connectivity with ping on this box (not installed, or not permitted here) — a tooling gap, not a finding.",
              }
            : evaluateGatewayPing(
                gatewayPing.ok ? gatewayPing.output : "",
                baseline.ok ? baseline.output : "",
              );
        rungs.push(gatewayResult);

        if (gatewayResult.status !== "fail") {
          const dnsRung = await runDnsRung(exec);
          rungs.push(dnsRung);

          if (dnsRung.status !== "fail") {
            const mtuPing = await runCollector(RUNG_SPECS.pingMtu, exec);
            rungs.push(evaluateMtu(baseline.ok ? baseline.output : "", mtuPing.ok ? mtuPing.output : ""));
          }
        }
      }
    }
  }

  // Firewall is informational only (pass/skip, never a hard "fail") so it's always worth checking,
  // even if an earlier rung already found the real problem.
  const ufw = await runCollector(RUNG_SPECS.ufwStatus, exec);
  const nft = await runCollector(RUNG_SPECS.nftRuleset, exec);
  rungs.push(evaluateFirewall(ufw, nft));

  const firstFailure = rungs.find((r) => r.status === "fail");
  const ragQuery = firstFailure
    ? `${firstFailure.rung} ${firstFailure.detail}`
    : "network triage all rungs passed";
  let ragHits: Array<{ chunk: { text: string } }> = [];
  if (deps.rag) {
    try {
      ragHits = await deps.rag.retrieve(ragQuery, deps.topK ?? 4);
    } catch {
      ragHits = [];
    }
  }
  const kbContext = ragHits.map((h) => h.chunk.text).join("\n\n---\n\n");

  let report: string;
  if (!firstFailure) {
    report =
      "Link, address, route, gateway, and DNS all check out — this machine's network stack looks healthy.";
  } else if (deps.model) {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `Failed rung: ${firstFailure.rung}`,
          `Finding: ${firstFailure.detail}`,
          kbContext ? `\nRelevant knowledge base notes:\n${kbContext}` : "",
        ].join("\n"),
      },
    ];
    try {
      report = (await deps.model.complete(messages, "triage")).text;
    } catch {
      report = firstFailure.detail;
    }
  } else {
    report = firstFailure.detail;
  }

  deps.io.report(report);
  return { rungs, firstFailure, report };
}

/**
 * Runs the DNS rung, preferring `dig` and falling back to `getent` for the
 * configured resolver when `dig` isn't installed. If neither tool can even
 * run, the rung is reported as "skip" (a tooling gap) rather than a false
 * "DNS doesn't work at all".
 */
async function runDnsRung(exec: Exec): Promise<RungResult> {
  const dig = await runCollector(RUNG_SPECS.dnsConfigured, exec);
  let configuredRan = dig.ok;
  let configuredOutput = dig.ok ? dig.output : "";

  if (!dig.ok && dig.note === "not installed on this box") {
    const getent = await runCollector(RUNG_SPECS.getentConfigured, exec);
    configuredRan = getent.ok;
    configuredOutput = getent.ok ? getent.output : "";
  }

  const pub = await runCollector(RUNG_SPECS.dnsPublic, exec);
  const publicRan = pub.ok;
  const publicOutput = pub.ok ? pub.output : "";

  if (!configuredRan && !publicRan) {
    return {
      rung: "dns",
      status: "skip",
      detail:
        "Couldn't check DNS at all on this box (no dig or getent available) — a tooling gap, not a finding.",
    };
  }
  return evaluateDns(configuredOutput, publicOutput);
}

/** The pi `/network-triage` command handler. */
export async function networkTriage(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { model, rag } = await loadRescueRuntime();
  await runNetworkTriage({ io: ioFromContext(ctx), model, rag });
}
