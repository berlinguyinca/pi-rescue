# pi-rescue-runtime — design spec (v0)

## Goal
A pi skill-pack that turns a limited local model (or the metabolomics gateway) into an
effective **diagnose / harden / recover / operate** assistant for any box, riding on the
`rescue-os` rescue USB.

## Principles
1. **Workflows as skills.** Encode the expert procedure (what to collect, order, interpretation),
   not just a prompt. The model supplies judgement; the skill supplies method + tools + facts.
2. **RAG over recall.** A 7-8B model can't hold Linux/hardware/network lore. Retrieve from `kb/`
   (sqlite-vec + nomic-embed-text) and inject. Augments gateway models with lab-specific context too.
3. **Safety-first.** Read-only by default; destructive/outbound actions gated; targets mounted `ro`.
4. **Offline-capable.** Works against local Ollama with no network; prefers the gateway when reachable.

## Components
- `extensions/index.ts` — registers the `/skill` commands with pi's `ExtensionAPI`.
- `src/skills/*.ts` — one module per skill: `collect()`, `retrieve()`, `plan()`, `act()`.
- `src/rag/` — KB loader + sqlite-vec query + embed (nomic-embed-text via Ollama).
- `src/model/` — router: Ollama (local) ↔ metabolomics gateway, per `.pi/rescue.yaml`.
- `kb/` — curated markdown (Linux/HW/net diagnostics, the fiehnlab hardening playbook, sanitized runbooks).

## Skill roadmap (implementation order)
1. **diagnose** (collect: inxi/dmesg/journal/smartctl/sensors/ip/lynis) — flagship, exercises RAG+model+report.
2. **network-triage** (link→carrier→DHCP→DNS→route→MTU→firewall).
3. **harden** (lynis + fiehnlab-harden; interpret; apply; re-scan).
4. **ssh-tunnel** (local/remote/dynamic forwards, jump hosts, autossh, inventory).
5. **remote** (ssh/mosh/tmux sessions; parallel fan-out across a host inventory; collect results).
6. **keys** (ssh keygen/rotate/distribute; known_hosts/authorized_keys; LUKS unlock+rotate; age/sops; gh/aws/gateway key hygiene).
7. disk-rescue, boot-repair, mikrotik, incident-triage.

## Non-goals
- No baked credentials. No unauthorized access tooling. No heavyweight web stack (that's why not LibreChat).

## Open questions
- KB chunking/embedding params; exact sqlite-vec schema.
- `remote` inventory format (reuse the lab's Ansible inventory?).
- Whether `keys`/`remote` should shell out to existing tools (parallel-ssh, ssh-add, age) vs reimplement (prefer shell-out).

## Traffic interception & reverse-engineering (authorized)
- **intercept** — mitmproxy-based MITM for app/device traffic you control: issue+serve a CA,
  route via transparent proxy (iptables REDIRECT) or a Wi-Fi AP (hostapd+dnsmasq), decrypt
  HTTPS/HTTP2/WS, capture+replay flows (mitmweb/mitmdump). `ssh-mitm` for SSH session capture
  where you control the client's host-key trust. Tools: mitmproxy, bettercap, sslsplit, ssh-mitm,
  tshark, hostapd, dnsmasq. **Requires installing the CA on the client you own** for HTTPS to decrypt.
- **reverse** — app RE: apktool/jadx (Android), Ghidra (binaries), Frida/objection (live
  instrumentation + pinning bypass on a controlled device), correlated with intercept flows.
- Both are **authorized-use** (own/authorized targets), confirmation-gated, and never auto-scan
  or auto-attack a network. No credential exfiltration tooling; no stealth/evasion features.

## Whole-network audit (network-audit)
Complements single-host `network-triage`. Four passes, each read-only until a gated action:
- **MAP** — nmap -sn / arp-scan / fping / netdiscover / LLDP (lldpd); pull routing tables, ARP,
  DHCP leases and interface stats from MikroTik (RouterOS API/SSH); build a topology graph.
- **ROUTING** — mtr / traceroute / tcptraceroute to key targets; detect asymmetry, loops,
  blackholes, wrong gateways, path-MTU, VLAN/segmentation issues.
- **PERFORMANCE** — latency/loss/jitter matrix; iperf3 throughput mesh; bufferbloat; top talkers
  (iftop/nethogs/ntopng); DNS latency; duplex/retransmit checks.
- **SECURITY** — nmap service/version + NSE vuln, masscan for breadth; TLS posture
  (testssl.sh/sslscan); exposed SNMP; rogue-device / ARP-spoof detection (bettercap);
  segmentation + firewall-gap checks; weak/default creds (authorized).
Then RAG-interpret → prioritized findings + remediation.

Image tools (add in v2 pass): nmap+NSE, masscan, arp-scan, fping, netdiscover, lldpd, mtr,
tcptraceroute, iperf3, iftop, nethogs, ntopng (optional), testssl.sh, sslscan, snmp, bettercap, tshark.
Scope: authorized networks only; scans are target-scoped + confirmation-gated; no exploitation/evasion.

### HTTPS/SSL/SSH decryption — mechanisms & limits
`/intercept` provides two decryption paths, plus `/reverse` for pinning:
1. **MITM-with-your-CA** (arbitrary client you control): mitmproxy issues a CA; you install it in the
   client's trust store; proxy is placed in path (transparent iptables REDIRECT / explicit proxy /
   Wi-Fi AP via hostapd+dnsmasq); TLS is terminated with an on-the-fly leaf signed by your CA →
   plaintext. Handles TLS 1.3, HTTP/2, WebSocket. Tools: mitmproxy/mitmweb/mitmdump, bettercap, sslsplit.
2. **SSLKEYLOGFILE** (apps you launch): run with `SSLKEYLOGFILE=…`; app writes TLS keys; tshark/Wireshark
   decrypts the capture. No CA, no in-path proxy, immune to pinning. Best for debugging your own apps.

Pinning: apps that pin reject the CA → bypass via `/reverse` (Frida/objection) on a controlled device,
or APK patch (apktool). Limits: cannot decrypt a client you don't control (no CA / no keylog); mTLS needs
the client cert; QUIC/HTTP3 → block UDP/443 to force TCP fallback.

SSH: `ssh-mitm` only where the client doesn't verify the host key (TOFU) or you control its known_hosts —
authorized SSH-session capture on clients whose host-key trust you manage. Narrower than HTTPS by design.

All of the above is authorized-use (own/authorized targets), target-scoped, confirmation-gated.

### Capture & analysis (Proxyman-style flow explorer)
`/intercept` captures and inspects flows two ways:
- **Human GUI:** `mitmweb` (mitmproxy's browser UI — live flow list, filter/search, pretty-printed
  request/response bodies, replay + edit-and-resend, breakpoints, HAR export) is the primary Proxyman
  equivalent on Linux. Optional GUIs: HTTP Toolkit (most Proxyman-like feel, one-click app intercept),
  Burp Suite Community (Proxy+Repeater), Wireshark (packet-level, SSLKEYLOGFILE-decrypted).
- **Agent-driven:** capture with `mitmdump` to a flow file, then the skill analyzes programmatically via
  mitmproxy addons — search across flows, extract endpoints/tokens/secrets, diff, auto-replay, and
  RAG-flag security issues. This is the value-add over a manual GUI for a small-model-plus-RAG setup.
Image tools (v2 pass): mitmproxy (mitmweb/mitmdump), wireshark/tshark, + optional HTTP Toolkit & Burp Community.

## Zero-knowledge UX (the point)
Someone with **no technical knowledge** must be able to use this by **describing the problem or
asking a question** — nothing else. `assist` is the default front door; plain freeform input is
auto-dispatched to it, so slash-commands are optional/expert-only.

**Persona:** calm, plain-language, non-judgmental. No jargon unless asked. One simple question at a
time. Always say what it's about to do and why, in a sentence a non-expert understands. Never dump logs.

**Intent → skill routing (examples):**
| The user says… | Routes to |
|---|---|
| "internet/wifi is slow", "pages take forever", "network feels laggy" | network-audit (perf) |
| "I can't reach X", "no internet on this machine", "dns not working" | network-triage |
| "map my network", "what's on my network", "is my network safe?" | network-audit (map+security) + harden |
| "this PC won't boot / start" | boot-repair → diagnose |
| "the computer is slow / crashing / hot" | diagnose |
| "is this box secure?", "lock this down" | harden |
| "recover files", "I deleted …", "the disk is failing" | disk-rescue |
| "see what this app/website sends", "capture its traffic", "decrypt its https" | intercept (+reverse for pinning) |
| "reverse engineer this app", "what API does it call" | reverse (+intercept) |
| "connect me to / run this on my servers", "tunnel to …" | remote / ssh-tunnel |
| "rotate/manage my keys" | keys |
| "check my mikrotik / router" | mikrotik |
| "I think I was hacked" | incident-triage |

**Safety for non-experts:** read-only first; every change is confirmed in plain language with the
risk stated; nothing destructive on a guessed intent; "what did you change?" is always answerable.

**Autostart on rescue-os (image side):** boot drops into a friendly greeting — a terminal TUI
*and* a desktop launcher ("Rescue Assistant") that start pi with the rescue extension in assist mode:
> "Hi — tell me what's wrong, or ask a question. e.g. 'the wifi is slow', 'this PC won't start',
>  'is my network safe?', 'show me what this app is sending'."
Delivered via a `fiehnlab-assist` command + a .desktop entry (image v2 pass).

## v3+ backlog — the "eierlegende Wollmilchsau" roadmap
Candidate skills + image tools for a do-everything rescue/diagnostic/dev/sec image. Curated; not all at once.

### Candidate pi skills (beyond the current 14)
- **backup / migrate** — image a box, back up data (restic/borg/rclone→S3), clone a disk to new hardware (P2V/V2P). "Move this box."
- **provision** — blank box → configured system (autoinstall/ansible/cluster-join). Bridges the fiehnlab autoinstall work.
- **update** — snapshot → upgrade → verify → auto-rollback on failure. "Update this safely."
- **benchmark** — CPU/mem/disk/GPU/net suite vs baselines; flag degraded hardware.
- **monitor** — stand up instant observability (netdata / node_exporter+Prom/Grafana) on a box or fleet; aggregate logs.
- **log-analysis** — ingest journald/syslog/app logs → AI anomaly/error/timeline. "What happened last night?"
- **perf-profile** — profile a slow app (perf/flamegraph/bpftrace/py-spy/strace). "Why is this slow?"
- **power / ipmi** — remote power + serial console via IPMI/Redfish/iLO/racadm (DIRECTLY addresses the lab's BMC recovery pain).
- **firmware** — inventory + update firmware (fwupd); BIOS/BMC access.
- **storage** — RAID/LVM/ZFS/BeeGFS health + recovery, SMART trends, capacity planning.
- **cluster** — Slurm/HPC: node health, job failures, munge/slurmd/BeeGFS (multiple clusters).
- **gpu** — driver/CUDA/ROCm health, thermal/ECC/MIG, container-GPU, GPU benchmark.
- **db** — Postgres/MySQL/Mongo: connectivity, slow queries, bloat, replication lag (lab is Postgres-heavy).
- **container** — docker/apptainer/k8s: won't-start triage, image inspection (dive), registry, GPU-in-container.
- **cert / tls** — inspect/renew certs, Let's Encrypt, find expiring certs across a fleet, CA mgmt.
- **dns** — zone/DNSSEC/propagation checks, local resolver setup.
- **vpn / mesh** — WireGuard/Tailscale mesh set-up + diagnosis.
- **wifi** — survey/channel analysis, hostapd AP, captive-portal test rig.
- **secrets-audit** — gitleaks/trufflehog across a box/repo; key hygiene (lab incident relevance).
- **compliance / baseline** — CIS/STIG via openscap; golden-image drift detection.
- **web-audit** — authorized web app scan (nuclei/nikto/zap/wpscan/whatweb).
- **malware** — deeper analysis: yara, clamav, static+sandbox detonation.
- **inventory** — full hw/sw inventory of box or fleet → JSON/CMDB.
- **recover-os** — reinstall/repair any OS, bootloader re-create, chroot-repair, password reset (incl. Windows via chntpw).
- **doc / runbook** — auto-write up what it found/fixed as a runbook.
- **teach / explain** — explain a finding/concept at the user's level (extends the zero-knowledge angle to learning).

### Candidate image tools (beyond current)
- **Network**: termshark, ngrep, tcpflow, scapy, hping3/nping, rustscan, projectdiscovery (subfinder/dnsx/httpx/nuclei), nikto, whatweb, wpscan, ffuf/gobuster, sqlmap, aircrack-ng/wifite/kismet (authorized), vnstat, bmon, netdata, smokeping, sshuttle, wireguard-tools, mosh, zellij.
- **System/HW**: ipmitool/freeipmi/redfishtool (BMC!), fwupd, s-tui, sysbench, phoronix-test-suite, sg3-utils/lsscsi, zfsutils, woeusb/ventoy (make boot USBs), rescuezilla, memtest86+ boot entry.
- **Containers/virt/cloud**: podman, dive/ctop/lazydocker, k9s/kubectl/helm, terraform/opentofu, qemu/libvirt/virt-manager (sandbox VMs), gcloud/az CLIs.
- **Security/RE/forensics**: trivy/grype/syft (vuln+SBOM), gitleaks/trufflehog, openscap, radare2/rizin/cutter, gdb+pwndbg, dex2jar/jd-gui, cyberchef (local), plaso/log2timeline, autopsy, searchsploit/exploitdb, metasploit (authorized, heavy), hashcat/john (authorized).
- **Data**: duckdb (lab uses it), visidata, miller/csvkit, gron, datasette, pandoc, tesseract (OCR).
- **AI/voice** (big UX win for zero-knowledge): whisper.cpp (speech→text) + piper (text→speech) ⇒ **talk to the Rescue Assistant**; llama.cpp (lab runs it) as an alt local engine.
- **Remote access to the rescue box itself**: ttyd (web terminal — drive the stick from a phone browser), novnc/rustdesk (remote desktop), asciinema (record sessions).

### Two "wow" ideas worth prioritizing
1. **Voice I/O** (whisper.cpp + piper): a non-technical user literally *talks* to the stick — the ultimate zero-knowledge front door.
2. **ttyd web terminal + QR**: the rescue box shows a QR → phone opens a web terminal/assistant to it, so you drive a headless/far box from your pocket.
