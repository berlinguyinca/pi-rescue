// `pi.on("input")` wiring test: the rescue-assist auto-dispatch gate must stay
// off unless explicitly enabled, and even then must leave slash-commands,
// bang-bash, extension-sourced input, and unclassifiable chat alone. A fake
// `pi`/`ctx` are enough — no real pi runtime, no real collectors.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { makeInputHandler } from "../../extensions/index.ts";

function fakePi(flagValue: boolean | string | undefined): ExtensionAPI {
  return { getFlag: () => flagValue } as unknown as ExtensionAPI;
}

/** `hasUI: false` so a "not-ready" skill's confirm() auto-declines rather than reaching the real runtime. */
function fakeCtx(): ExtensionContext {
  return { ui: { notify: () => undefined }, hasUI: false } as unknown as ExtensionContext;
}

function inputEvent(text: string, source: InputEvent["source"] = "interactive"): InputEvent {
  return { type: "input", text, source };
}

test("makeInputHandler: continues (does nothing) when rescue-assist mode is off", async () => {
  const handler = makeInputHandler(fakePi(false));
  const result = await handler(inputEvent("the wifi is slow"), fakeCtx());
  assert.deepEqual(result, { action: "continue" });
});

test("makeInputHandler: continues for extension-sourced input even with assist mode on", async () => {
  const handler = makeInputHandler(fakePi(true));
  const result = await handler(inputEvent("the wifi is slow", "extension"), fakeCtx());
  assert.deepEqual(result, { action: "continue" });
});

test("makeInputHandler: continues for a slash command even with assist mode on (pi's own command handling owns it)", async () => {
  const handler = makeInputHandler(fakePi(true));
  assert.deepEqual(await handler(inputEvent("/diagnose"), fakeCtx()), { action: "continue" });
});

test("makeInputHandler: continues for bang-bash even with assist mode on", async () => {
  const handler = makeInputHandler(fakePi(true));
  assert.deepEqual(await handler(inputEvent("!ls"), fakeCtx()), { action: "continue" });
});

test("makeInputHandler: continues for unclassifiable freeform text even with assist mode on (never hijacks ordinary chat)", async () => {
  const handler = makeInputHandler(fakePi(true));
  const result = await handler(inputEvent("what's the capital of France"), fakeCtx());
  assert.deepEqual(result, { action: "continue" });
});

test("makeInputHandler: handles a rescue-shaped phrase once assist mode is on via the flag", async () => {
  const handler = makeInputHandler(fakePi(true));
  const result = await handler(inputEvent("lock this down"), fakeCtx());
  assert.deepEqual(result, { action: "handled" });
});

test("makeInputHandler: PI_RESCUE_ASSIST=1 enables the gate just like the flag does", async () => {
  const handler = makeInputHandler(fakePi(undefined));
  process.env.PI_RESCUE_ASSIST = "1";
  try {
    const result = await handler(inputEvent("lock this down"), fakeCtx());
    assert.deepEqual(result, { action: "handled" });
  } finally {
    // Assigning undefined would set the literal string "undefined" (process.env values are always
    // strings); delete is the correct way to actually remove the var so other tests don't see it.
    // biome-ignore lint/performance/noDelete: process.env entries must be deleted, not set to undefined
    delete process.env.PI_RESCUE_ASSIST;
  }
});
