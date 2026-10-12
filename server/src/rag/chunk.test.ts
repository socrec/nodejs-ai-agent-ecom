import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk } from "./chunk.ts";

test("splits on headings and keeps heading text", () => {
  const md = "# Returns\n\n## Return window\nYou have 30 days.\n\n## Opened items\nNo returns.\n";
  const c = chunk(md, "returns.md");
  assert.deepEqual(c.map((x) => x.heading), ["Return window", "Opened items"]);
  assert.equal(c[0]!.content, "You have 30 days.");
  assert.ok(c.every((x) => x.source === "returns.md"));
});

test("accumulates paragraphs up to max and splits beyond it", () => {
  const para = "x".repeat(300);
  const md = `## Long\n${para}\n\n${para}\n\n${para}\n\n${para}`;
  const c = chunk(md, "a.md", 800);
  assert.equal(c.length, 2);
  assert.ok(c.every((x) => x.content.length <= 800));
});

test("empty title section produces no chunk", () => {
  assert.deepEqual(chunk("# Title only\n\n## A\nbody", "f.md").map((x) => x.heading), ["A"]);
});
