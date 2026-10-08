import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * assist — the ZERO-KNOWLEDGE front door. The primary way to use pi-rescue.
 *
 * The user says what's wrong in plain words ("the wifi is slow", "this laptop
 * won't start", "is my network safe?", "show me what this app is sending",
 * "I deleted a file, can I get it back?") or asks a question. assist:
 *   1. CLASSIFY the intent (no jargon required from the user).
 *   2. ROUTE to the right skill(s) — see docs/specs §Zero-knowledge UX.
 *   3. CLARIFY only when needed, ONE simple question at a time, in plain language
 *      with concrete guidance ("plug the network cable into the blue socket").
 *   4. RUN the skill(s) read-only first; RAG-augment with the KB.
 *   5. EXPLAIN findings in plain language (what's wrong, why, how bad), never a log dump.
 *   6. OFFER to fix it; CONFIRM before any change; narrate each step and the result.
 *
 * Wired as the default concierge: plain freeform input is auto-dispatched here, so a
 * non-technical user never needs to know a slash-command exists. `/assist` is the explicit form.
 */
export async function assist(ctx: ExtensionCommandContext, _args: string[]): Promise<void> {
  // TODO(v2): intent-classify -> route -> clarify -> run -> explain -> (confirm) fix.
  ctx.print?.("[pi-rescue:assist] not yet implemented — see docs/specs/pi-rescue-spec.md (Zero-knowledge UX)");
}
