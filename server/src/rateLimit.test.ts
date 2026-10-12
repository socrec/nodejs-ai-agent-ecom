import assert from "node:assert/strict";
import { test } from "node:test";
import { hit } from "./rateLimit.ts";

test("allows up to max hits then returns seconds to wait", () => {
  const now = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(hit("a", 3, 10_000, now + i), 0);
  const retry = hit("a", 3, 10_000, now + 3);
  assert.ok(retry >= 1 && retry <= 10, `retry=${retry}`);
});

test("window slides: old hits expire", () => {
  assert.equal(hit("b", 1, 1_000, 0), 0);
  assert.equal(hit("b", 1, 1_000, 500), 1);
  assert.equal(hit("b", 1, 1_000, 1_001), 0);
});

test("keys are independent", () => {
  assert.equal(hit("c1", 1, 1_000, 0), 0);
  assert.equal(hit("c2", 1, 1_000, 0), 0);
});
