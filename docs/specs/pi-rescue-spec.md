# pi-rescue-runtime — design spec (v0)

## Goal
A pi skill-pack that turns a limited local model (or the metabolomics gateway) into an
effective **diagnose / harden / recover / operate** assistant for any box, riding on the
`fiehnlab-live` rescue USB.

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
