// Intent -> skill routing table, tested against every example phrase from
// docs/specs/pi-rescue-spec.md §"Zero-knowledge UX" and the README, verbatim.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IMPLEMENTED_SKILLS,
  type SkillId,
  classifyIntent,
  decideAssistAction,
  runAssist,
} from "../../src/skills/assist.ts";
import { collectingIO } from "../../src/skills/types.ts";

// [verbatim phrase, expected skill id] — one row per example phrase in the spec/README.
const SPEC_PHRASES: Array<[string, SkillId]> = [
  // README examples
  ["the wifi is really slow", "network-audit-perf"],
  ["this laptop won't start", "boot-repair"],
  ["is my network safe?", "network-audit-map-security"],
  ["show me what this app is sending", "intercept"],
  ["I deleted a file, can I get it back?", "disk-rescue"],
  ["I think I got hacked", "incident-triage"],
  // spec routing table
  ["internet/wifi is slow", "network-audit-perf"],
  ["pages take forever", "network-audit-perf"],
  ["network feels laggy", "network-audit-perf"],
  ["I can't reach X", "network-triage"],
  ["no internet on this machine", "network-triage"],
  ["dns not working", "network-triage"],
  ["map my network", "network-audit-map-security"],
  ["what's on my network", "network-audit-map-security"],
  ["this PC won't boot", "boot-repair"],
  ["this PC won't start", "boot-repair"],
  ["the computer is slow", "diagnose"],
  ["the computer is crashing", "diagnose"],
  ["the computer is hot", "diagnose"],
  ["is this box secure?", "harden"],
  ["lock this down", "harden"],
  ["recover files", "disk-rescue"],
  ["the disk is failing", "disk-rescue"],
  ["capture its traffic", "intercept"],
  ["decrypt its https", "intercept"],
  ["reverse engineer this app", "reverse"],
  ["what API does it call", "reverse"],
  ["tunnel to my server", "ssh-tunnel"],
  ["run this on my servers", "remote"],
  ["rotate my keys", "keys"],
  ["manage my keys", "keys"],
  ["check my mikrotik", "mikrotik"],
  ["I think I was hacked", "incident-triage"],
];

for (const [phrase, expected] of SPEC_PHRASES) {
  test(`classifyIntent: "${phrase}" -> ${expected}`, () => {
    const result = classifyIntent(phrase);
    assert.ok(result, `expected a match for "${phrase}"`);
    assert.equal(result?.id, expected);
  });
}

test("classifyIntent: network-ish 'slow' wins over the generic diagnose 'slow' rule", () => {
  assert.equal(classifyIntent("the wifi is really slow")?.id, "network-audit-perf");
  assert.equal(classifyIntent("the computer is slow")?.id, "diagnose");
});

test("classifyIntent: unrelated text has no match, so assist can ask instead of guessing", () => {
  assert.equal(classifyIntent("what's the capital of France"), undefined);
});

test("decideAssistAction: an implemented skill is dispatched directly", () => {
  const action = decideAssistAction("the computer is crashing");
  assert.equal(action.kind, "run");
  assert.equal(action.id, "diagnose");
  assert.ok(IMPLEMENTED_SKILLS.has("diagnose"));
});

test("decideAssistAction: an unbuilt skill says so plainly and offers an alternative", () => {
  const action = decideAssistAction("is this box secure?");
  assert.equal(action.kind, "not-ready");
  assert.equal(action.id, "harden");
  assert.ok(!IMPLEMENTED_SKILLS.has("harden"));
  assert.match(action.message, /isn't built yet/);
});

test("decideAssistAction: a not-ready network-shaped skill offers network-triage, not the generic diagnose", () => {
  const action = decideAssistAction("is my network safe?");
  assert.equal(action.kind, "not-ready");
  assert.equal(action.id, "network-audit-map-security");
  assert.equal(action.fallbackId, "network-triage");
  assert.match(action.message, /network connection check/);
});

test("decideAssistAction: unclassifiable input asks exactly one clarifying question", () => {
  const action = decideAssistAction("hello there");
  assert.equal(action.kind, "clarify");
});

test("runAssist: dispatches an implemented skill without asking anything first", async () => {
  const io = collectingIO();
  const dispatched: SkillId[] = [];
  await runAssist("the computer is crashing", {
    io,
    dispatch: async (id) => {
      dispatched.push(id);
    },
  });
  assert.deepEqual(dispatched, ["diagnose"]);
});

test("runAssist: a not-ready skill only runs the diagnose fallback if the user confirms", async () => {
  const dispatched: SkillId[] = [];
  const io = { ...collectingIO(), confirm: async () => true };
  await runAssist("lock this down", {
    io,
    dispatch: async (id) => {
      dispatched.push(id);
    },
  });
  assert.deepEqual(dispatched, ["diagnose"]);
});

test("runAssist: a not-ready network-shaped skill falls back to network-triage, not diagnose", async () => {
  const dispatched: SkillId[] = [];
  const io = { ...collectingIO(), confirm: async () => true };
  await runAssist("is my network safe?", {
    io,
    dispatch: async (id) => {
      dispatched.push(id);
    },
  });
  assert.deepEqual(dispatched, ["network-triage"]);
});

test("runAssist: declining the not-ready fallback runs nothing", async () => {
  const dispatched: SkillId[] = [];
  const io = { ...collectingIO(), confirm: async () => false };
  await runAssist("lock this down", {
    io,
    dispatch: async (id) => {
      dispatched.push(id);
    },
  });
  assert.deepEqual(dispatched, []);
});

test("runAssist: a clarifying answer dispatches the matching skill", async () => {
  const dispatched: SkillId[] = [];
  const io = { ...collectingIO(), choose: async () => "Network or wifi problem" };
  await runAssist("hello there", {
    io,
    dispatch: async (id) => {
      dispatched.push(id);
    },
  });
  assert.deepEqual(dispatched, ["network-triage"]);
});
