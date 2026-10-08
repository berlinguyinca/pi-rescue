# pi-rescue-runtime

A **fieldops / rescue skill-pack** for the [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding agent. Load it into pi (sibling to
[`berlinguyinca/pi-engineering`](https://github.com/berlinguyinca/pi-engineering))
and you can plug into **any box** — your own, a sick server, a stranger's laptop —
and **diagnose it, secure it, recover it, or start working on it**, with the agent
driving the right tools in the right order.

Built to ride on the **`fiehnlab-live`** rescue USB (Ubuntu live + full toolset),
where the local model is small, so every skill is **RAG-augmented**: it retrieves
from a curated diagnostic knowledge base before answering, and works against either
the local Ollama model (offline) or the `llm.metabolomics.us` gateway (online).

## Why

A small local model doesn't *know* the thousand failure modes of Linux, disks,
networks and GPUs. These skills encode the **workflows** (what to collect, in what
order, how to interpret it) and feed the model the **facts** (via RAG), so a 7-8B
model — or a strong gateway model given your lab's context — can actually fix things.

## Skills

Each skill is a pi command (`/<skill>`) that gathers context read-only first, retrieves
relevant KB, proposes a plan, and only acts with confirmation (destructive steps gated).

| Skill | What it does |
|-------|--------------|
| **`/diagnose`** | Flagship. Collects `inxi`, dmesg, journal, SMART, sensors, `ip`, lynis → RAG → root-cause + fix plan. |
| **`/network-triage`** | Single host: the link→carrier→DHCP→DNS→route→MTU→firewall ladder. Finds the dead NIC / missing lease / broken DNS. |
| **`/network-audit`** | Whole network: map topology (+MikroTik), analyze routing (asymmetry/loops/blackholes), measure performance (latency/loss/throughput/top-talkers), and survey security (nmap/NSE, TLS posture, exposed services, rogue devices). Authorized networks only. |
| **`/harden`** | Runs `lynis` + the fiehnlab hardening playbook, interprets findings, applies fixes, re-scans. |
| **`/disk-rescue`** | SMART triage → read-only `ddrescue` image → fs repair / `photorec` recovery. Safety-first. |
| **`/boot-repair`** | Diagnose + fix GRUB/EFI/initramfs on a target disk. |
| **`/ssh-tunnel`** | Stand up / tear down SSH tunnels & port-forwards (local/remote/dynamic SOCKS), jump hosts, autossh keepalive, inventory of live tunnels. |
| **`/remote`** | Remote-session & **fleet** orchestration: open sessions (ssh/mosh/tmux), run a command across many hosts (parallel), collect results — multi-host command & control for **your own** infrastructure. |
| **`/keys`** | Key management: generate/rotate/distribute SSH keys, manage `known_hosts`/`authorized_keys`, unlock & rotate the LUKS secrets container, `age`/`sops` encrypt/decrypt, gh/AWS/gateway key hygiene. |
| **`/mikrotik`** | RouterOS (API/SSH): pull config/leases/ARP/neighbors/logs, diagnose L2/L3. |
| **`/incident-triage`** | IR: collect volatile data, rootkit scan, timeline, preserve evidence read-only. |
| **`/intercept`** | Authorized MITM inspection (mitmproxy): serve a CA, transparent/Wi-Fi-AP routing, decrypt HTTPS/HTTP2/WS, capture+replay flows; SSH capture via `ssh-mitm`. For traffic of apps/devices you control. |
| **`/reverse`** | Authorized app reverse-engineering: apktool/jadx/Ghidra decompile + Frida/objection live instrumentation (cert-pinning bypass on a controlled device), correlated with intercepted traffic. |

> **Scope & authorization:** all remote-access / fleet / key-management and the
> **traffic-interception / reverse-engineering** features are for systems, apps, devices
> and networks you **own or are explicitly authorized to test**. HTTPS decryption works by
> installing *your* CA on a client you control; SSH capture requires controlling the client's
> host-key trust. Destructive and outbound actions are confirmation-gated — there is no
> auto-scan / auto-attack behavior, and no stealth/evasion or credential-exfiltration tooling.

## Architecture

```
pi  ──loads──▶  extensions/index.ts  ──registers──▶  /diagnose /network-triage /harden …
                                                          │
                         each skill ──▶ src/skills/<skill>.ts
                                            │  1. collect (read-only)
                                            │  2. RAG retrieve (kb/, sqlite-vec + nomic-embed-text)
                                            │  3. ask model (local Ollama OR metabolomics gateway)
                                            │  4. plan → confirm → act (gated)
                                            └─ evidence/log
```

- **Routing** is in `.pi/rescue.yaml` (gateway models with local-Ollama fallback).
- **KB** lives in `kb/` (markdown, version-controlled); pre-embedded at build into `kb/.vectors/`.
- **No secrets** in the repo; keys come from the LUKS container at runtime.

## Status

Scaffold. Skill bodies are stubs (`src/skills/*.ts`) — implementation tracked in
[`docs/specs/pi-rescue-spec.md`](docs/specs/pi-rescue-spec.md). First wave:
`/diagnose`, `/network-triage`, `/harden`.

## Develop

```bash
npm install
npm run typecheck && npm run lint && npm test
```

Load into pi by cloning next to your pi config and adding it as an extension (see the spec).
