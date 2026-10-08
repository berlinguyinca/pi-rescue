# Operating policy for agents in pi-rescue-runtime

- This is a **rescue/fieldops** skill-pack. Real skills touch real machines. Default to
  **read-only collection first**; gate every destructive or outbound action behind explicit
  confirmation. Never auto-wipe, auto-overwrite, or push config to a target without a confirm step.
- **Never commit secrets.** Keys live only in the runtime (LUKS container → RAM). The repo holds
  tooling and the KB, never credentials.
- Remote-access / fleet / key-management features are for **authorized administration only**.
  Keep that framing in prompts, docs, and defaults.
- Mirror `berlinguyinca/pi-engineering` conventions: ES-module TS, NodeNext, `biome` for
  lint/format, `node --test`. `npm run typecheck && npm run lint && npm test` must pass.
- Each skill: collect → RAG → plan → (confirm) → act → record. Keep skills independent and testable.
