import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkKb, chunkMarkdown } from "../../src/rag/chunk.ts";

test("chunkMarkdown: never crosses a heading boundary", () => {
  const md = ["# Topic A", "short paragraph one.", "", "# Topic B", "short paragraph two."].join("\n");
  const chunks = chunkMarkdown("doc.md", md, { minChars: 10, maxChars: 800 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.heading, "Topic A");
  assert.match(chunks[0]?.text ?? "", /paragraph one/);
  assert.equal(chunks[1]?.heading, "Topic B");
  assert.match(chunks[1]?.text ?? "", /paragraph two/);
});

test("chunkMarkdown: windows are bounded roughly 500-800 chars within one section", () => {
  const paragraph = "word ".repeat(60).trim(); // ~300 chars
  const md = ["# Section", paragraph, "", paragraph, "", paragraph, "", paragraph].join("\n");
  const chunks = chunkMarkdown("doc.md", md, { minChars: 500, maxChars: 800 });
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 820, `chunk too large: ${chunk.text.length}`);
  }
  // Four ~300-char paragraphs (plus heading) should split into at least two windows.
  assert.ok(chunks.length >= 2);
});

test("chunkMarkdown: a single paragraph far over maxChars is hard-split", () => {
  const huge = "x".repeat(2000);
  const md = `# Big\n${huge}`;
  const chunks = chunkMarkdown("doc.md", md, { minChars: 500, maxChars: 800 });
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 820);
  }
});

test("chunkMarkdown: ids are stable and source-scoped", () => {
  const md = "# A\npara one\n\n# B\npara two";
  const chunks = chunkMarkdown("network-triage.md", md, { minChars: 1, maxChars: 800 });
  assert.equal(chunks[0]?.id, "network-triage.md#0");
  assert.equal(chunks[1]?.id, "network-triage.md#1");
});

test("chunkKb: flattens multiple files, each keeping its own source name", () => {
  const chunks = chunkKb(
    [
      { name: "a.md", content: "# A\nhello" },
      { name: "b.md", content: "# B\nworld" },
    ],
    { minChars: 1, maxChars: 800 },
  );
  assert.deepEqual(
    chunks.map((c) => c.source),
    ["a.md", "b.md"],
  );
});
