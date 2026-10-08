# pi-rescue-runtime

A **fieldops / rescue skill-pack** for the [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding agent. Load it into pi (sibling to
[`berlinguyinca/pi-engineering`](https://github.com/berlinguyinca/pi-engineering))
and you can plug into **any box** — your own, a sick server, a stranger's laptop —
and **diagnose it, secure it, recover it, or start working on it**, with the agent
driving the right tools in the right order.

## You don't need to know anything

Just **describe the problem** or **ask a question** — in plain words. You don't pick a tool,
you don't learn commands. The **`assist`** concierge figures out what's wrong, runs the right
checks, explains what it found in plain language, and offers to fix it (confirming before any change):

> "the wifi is really slow" · "this laptop won't start" · "is my network safe?" ·
> "show me what this app is sending" · "I deleted a file, can I get it back?" · "I think I got hacked"

On the rescue USB it **boots straight into that greeting** (terminal + a desktop "Rescue Assistant"
launcher). The slash-commands below are just the expert shortcuts under the hood.

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
| **`/assist`** | **The front door.** Describe the problem in plain words → it classifies, routes to the skills below, explains findings simply, and offers to fix. Default behavior for freeform input. |
| **`/diagnose`** | Collects `inxi`, dmesg, journal, SMART, sensors, `ip`, lynis → RAG → root-cause + fix plan. |
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
| **`/intercept`** | Authorized MITM + **capture/analyze** (Proxyman-style): mitmweb flow explorer (filter/search/inspect/replay/breakpoints) or agent-driven `mitmdump` analysis; serve a CA, transparent/Wi-Fi-AP routing, decrypt HTTPS/HTTP2/WS; SSH capture via `ssh-mitm`. For traffic of apps/devices you control. |
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

First wave implemented: **`/diagnose`**, **`/network-triage`**, and **`/assist`** (the
zero-knowledge front door that routes to them). `src/rag/` (chunk + embed + vector store,
Ollama with a pure-JS fallback) and `src/model/` (the gateway↔local router) are implemented
and unit-tested. `/network-audit`, `/harden`, `/ssh-tunnel`, `/remote`, `/keys`, `/intercept`,
`/reverse` remain stubs — real skill modules that print a "not yet implemented" notice and are
wired into `extensions/index.ts` with the real `registerCommand` signature, so adding their
bodies later is a drop-in change. `disk-rescue`, `boot-repair`, `mikrotik`, and
`incident-triage` have no module yet at all (`assist` knows this and offers `/diagnose` or
`/network-triage` instead when one of those is requested).

### How `assist` is wired

`assist` is registered both as the explicit `/assist` command and via `pi.on("input", ...)`
for freeform auto-dispatch — but the input-event path only activates when **rescue-assist
mode** is on (`--rescue-assist` or `PI_RESCUE_ASSIST=1`), and even then only intercepts text
the routing table actually recognizes as rescue-shaped; anything else continues to pi's normal
chat. This is a deliberate narrowing of the spec's "always-on" design: loading pi-rescue as a
sibling extension should never hijack an unrelated pi coding session. The fiehnlab-live rescue
image's launcher is expected to set `PI_RESCUE_ASSIST=1` before starting pi.

### pi SDK surprises (vs. the original stubs)

The scaffold's stubs assumed an API shape the real `@earendil-works/pi-coding-agent` doesn't
have. Adapted during implementation:
- Command handlers are `(args: string, ctx: ExtensionCommandContext) => Promise<void>`, not
  `(ctx, args: string[])`, and are registered with `pi.registerCommand(name, { description,
  handler })`, not `{ name, summary, run }`.
- There is no `ctx.print()`. Output goes through `ctx.ui.notify(message, "info")`, which (per
  `interactive-mode.js`'s `showStatus`) is appended to the chat transcript, not a disappearing
  toast — safe to use for a full multi-paragraph report.
- `exec()` lives on `pi` (`ExtensionAPI`), not on `ctx`. Skills shell out themselves via
  `node:child_process.execFile`, wrapped behind the injectable `Exec` type in
  `src/skills/collectors.ts` for testability.
- Freeform-input interception is `pi.on("input", handler)`, returning `{ action: "continue" |
  "transform" | "handled" }` — there's no separate "default handler" concept.
- Node's `--experimental-strip-types` (which `node --test` uses here) rejects TypeScript
  parameter properties (`constructor(private readonly x: T)`) — every class in this repo
  assigns fields in the constructor body instead.

## Develop

```bash
npm install
npm run typecheck && npm run lint && npm test
npm run build-index   # optional: pre-embeds kb/*.md to kb/.vectors/index.json (baked into the image)
```

### What needs a live box to actually exercise

`node --test` covers all pure logic (chunking/ranking, parsers, the routing table, the
network-triage ladder, model-router failover) with everything side-effecting mocked. Running
the real thing for real needs: pi itself (for `ctx.ui`), a reachable Ollama for
`nomic-embed-text` and/or local chat completions, and/or `METABOLOMICS_API_KEY` for the
gateway. Collectors (`inxi`, `smartctl`, `dmesg`, `ip`, `dig`, `ufw`/`nft`, ...) need to exist
on the box they're diagnosing — every one of them degrades to a plain-language "not installed"
or "needs admin rights" note rather than failing, but the actual diagnosis is only as good as
what's installed. `createVectorStore()` (`src/rag/vectorStore.ts`, wired into `src/skills/
runtime.ts`) tries `node:sqlite` + the `sqlite-vec` loadable extension first and falls back to
the pure-JS in-memory cosine store on any failure. `node:sqlite` is available here (Node 22.5+,
experimental); `sqlite-vec` is **not** a project dependency, by design — it's expected to be
provisioned separately on the fiehnlab-live image. Until it is, the sqlite-vec path is wired but
inert everywhere, including the image: the pure-JS store is what actually runs. This code path
is explicitly not exercised by the test suite (unit tests build a `RagEngine` directly and never
call `createVectorStore()`), so it is unverified beyond "fails closed to the working fallback."

### Known gaps

- `.pi/rescue.yaml`'s `rag.top_k` and `rag.embed_model` aren't threaded through to `src/rag/`
  or `src/skills/*` yet — the code's own hardcoded defaults happen to match the yaml's, but
  changing the yaml alone won't currently change behavior. `rag.vector_store` *is* read (see
  above).
- A chat completion's `max_tokens` and per-provider timeout are router-wide
  (`src/model/router.ts`'s `ModelRouterOptions`), not per-role from `.pi/rescue.yaml`'s
  `max_context_tokens`.
- The metabolomics gateway's actual auth scheme (static bearer token vs. something in front of
  it) hasn't been exercised against a live endpoint; if `METABOLOMICS_API_KEY` doesn't work as a
  plain `Authorization: Bearer` header, every gateway call fails over to local silently (by
  design) rather than surfacing the auth problem loudly.

Load into pi by cloning next to your pi config and adding it as an extension (see the spec).
