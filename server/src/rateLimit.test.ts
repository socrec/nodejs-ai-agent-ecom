import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, hit, inflight, pauseFor, waitFor } from "./rateLimit.ts";

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

test("concurrency: per-org cap, then global cap, other orgs unaffected until global", () => {
  inflight.clear();
  for (let i = 0; i < LIMITS.concurrent.org; i++) inflight.add(`sess:acme:${i}`);
  assert.equal(waitFor("acme"), 5);
  assert.equal(waitFor("other"), 0);
  for (let i = inflight.size; i < LIMITS.concurrent.global; i++) inflight.add(`sess:big${i}:x`);
  assert.equal(waitFor("other"), 5);
  inflight.clear();
  assert.equal(waitFor("acme"), 0);
});

test("upstream 429 pauses every org for retry-after, then lifts", () => {
  const now = 5_000_000;
  pauseFor(7, now);
  assert.equal(waitFor("acme", now), 7);
  assert.equal(waitFor("other", now + 6_500), 1);
  assert.equal(waitFor("other", now + 7_000), 0);
  pauseFor(3, now + 7_000); // a shorter later pause never cuts an existing one
  pauseFor(1, now);
  assert.equal(waitFor("acme", now + 9_000), 1);
});
