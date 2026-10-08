# Whole-network audit — map, routing, performance, security

Complements kb/network-triage.md (single host). Four passes, each read-only until a gated
action; authorized networks only (see AGENTS.md).

## 1. MAP — what's actually on this network
- `nmap -sn 192.168.1.0/24` (ping sweep) or `arp-scan --interface=eth0 --localnet` for a faster
  L2-only sweep; `fping -g 192.168.1.0/24 -a` as a third option if neither is installed.
- `ip neigh` for this host's own ARP cache (fast, no scan, but only what's recently talked to).
- `lldpctl` (lldpd) on managed switches/APs that speak LLDP — gives you switch port + VLAN
  without needing switch credentials.
- MikroTik (RouterOS): pull `/ip/dhcp-server/lease/print`, `/ip/arp/print`,
  `/ip/route/print`, and interface stats via the RouterOS API or SSH (`/system resource print`,
  `/interface print stats`) — the DHCP lease table is usually the fastest way to get hostnames.
- Build a topology from leases + ARP + LLDP rather than trusting any single source; a stale
  DHCP lease for a long-gone device is a common false "device" in naive scans.

## 2. ROUTING — asymmetry, loops, blackholes
- `mtr -rwzbc20 <target>` per key destination (default gateway, DNS server, internet egress);
  `tcptraceroute` when ICMP is filtered and plain traceroute dead-ends.
- Asymmetric routing: compare the forward path (`mtr` from this host) against the return path
  if you can get it (an `mtr` run on the far end, or inferred from TTL/hop-count oddities) —
  a different path each direction usually means multiple default gateways or VRF/policy routing.
- Path-MTU blackhole: `ping -M do -s 1472 -c3 <host>` (drop the -28 for other MTUs); packets
  vanish instead of returning "fragmentation needed" when a device in the path strips ICMP.
- VLAN/segmentation: a host reachable by IP but not by expected VLAN tag, or a port in the wrong
  VLAN on the switch, shows up as "pingable from the router, not from where the user actually is".

## 3. PERFORMANCE — where the time/bandwidth actually goes
- Latency/loss/jitter matrix: `mtr` or `fping -C20` run pairwise between the hosts that matter,
  not just to the gateway — a slow LAN hop is invisible if you only ever test "to the internet".
- Throughput: `iperf3 -s` on one end, `iperf3 -c <server>` on the other; run both directions
  (`-R`) since asymmetric throughput (e.g. good down, bad up) points at a different cause than
  symmetric slowness.
- Bufferbloat: `iperf3` with a concurrent `ping` — latency climbing under load (not just packet
  loss) is bufferbloat, fixed with queue management (fq_codel/SQM) on the bottleneck link, not
  by buying more bandwidth.
- Top talkers: `iftop` (per-connection) or `nethogs` (per-process) on the busiest host; `ntopng`
  if it's already running, don't stand up a new one just for a one-off check.
- DNS latency specifically (separate from general latency): `dig example.com` repeated a few
  times — a consistently slow-but-working DNS server behaves very differently from a flaky one.

## 4. SECURITY — exposure, not exploitation
- `nmap -sV --script=vuln <target-range>` for service/version + known-vuln scripts; `masscan`
  first for a fast full-port sweep across a large range, then `nmap -sV` on just the open ports
  masscan found (masscan alone doesn't reliably grab banners).
- TLS posture on anything serving HTTPS: `testssl.sh <host>:<port>` or `sslscan` for protocol
  versions, weak ciphers, cert expiry/chain issues.
- Exposed SNMP: `snmpwalk -v2c -c public <host>` — a default/guessable community string on a
  switch or printer is still common and gives config read (sometimes write) access.
- Rogue device / ARP-spoof detection: `bettercap` in passive/detection mode (not active
  MITM) watches for duplicate MAC-to-IP claims and unsolicited ARP replies.
- Segmentation/firewall-gap check: from a host in VLAN A, confirm you genuinely cannot reach a
  host in VLAN B on a port that's supposed to be blocked — don't just trust the switch config.
- Weak/default creds: only against devices you're authorized to test, and only with credentials
  you're testing on purpose (not a brute-force sweep) — e.g. confirming a newly deployed AP/switch
  no longer answers to its factory default.

## Then
RAG-interpret all four passes together (a slow link found in PERFORMANCE often explains a
"looks asymmetric" result in ROUTING) into one prioritized findings + remediation report.

## Safety
Every scan here is scoped to a target range you supply and confirmed before running; `masscan`
and `nmap --script=vuln` especially can be noisy/alarming on a shared network — say what's about
to run and why before running it. No exploitation, no stealth/evasion, no credential brute force.
