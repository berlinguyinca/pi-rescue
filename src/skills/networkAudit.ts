import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Whole-network audit (complements single-host /network-triage). Four passes:
 *   1. MAP        — discover subnets/hosts/gateways (nmap -sn, arp-scan, fping,
 *                   netdiscover, LLDP via lldpd) + pull routing/ARP/DHCP/interface
 *                   stats from MikroTik (RouterOS API/SSH) and build a topology.
 *   2. ROUTING    — traceroute/mtr/tcptraceroute to key targets; detect asymmetry,
 *                   loops, blackholes, bad gateways, VLAN/segmentation + path-MTU issues.
 *   3. PERFORMANCE— latency/loss/jitter matrix (mtr/fping); iperf3 throughput between
 *                   reachable hosts; bufferbloat; link saturation / top talkers (iftop/
 *                   nethogs/ntopng); DNS resolution latency.
 *   4. SECURITY   — nmap service/version + NSE vuln scan, masscan for breadth; TLS posture
 *                   (testssl.sh/sslscan); exposed SNMP; rogue-device / ARP-spoof detection
 *                   (bettercap); segmentation & firewall-gap checks; default/weak creds
 *                   (authorized only).
 * Then RAG-interpret the findings and produce a prioritized report + remediation.
 *
 * AUTHORIZED USE ONLY — networks you own or are explicitly authorized to assess.
 * Scanning/vuln passes are confirmation-gated and scoped to a target range you supply;
 * no auto-wide scanning, no exploitation, no stealth/evasion.
 */
export async function networkAudit(ctx: ExtensionCommandContext, _args: string[]): Promise<void> {
  // TODO(v2): implement MAP → ROUTING → PERFORMANCE → SECURITY → report.
  ctx.print?.("[pi-rescue:network-audit] not yet implemented — see docs/specs/pi-rescue-spec.md");
}
