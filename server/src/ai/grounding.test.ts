import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyNumbers } from "./grounding.ts";

test("numbers present in tool data are grounded", () => {
  const data = [{ items: [{ qty: 2, unit_price: 3.99 }], shipping: 5.99, total: 13.97, order_number: 1001 }];
  assert.deepEqual(verifyNumbers("2 bags at $3.99 each, $5.99 shipping, total $13.97. Order #1001.", data).ungrounded, []);
});

test("tolerant to currency, commas and trailing zeros", () => {
  assert.deepEqual(verifyNumbers("1,299 units for $13.00", [{ stock: 1299, price: 13 }]).ungrounded, []);
});

test("flags invented numbers", () => {
  assert.deepEqual(verifyNumbers("Your total is $20.00 and ships in 2 days", [{ total: 13.97 }]).ungrounded, ["$20.00", "2"]);
});

test("phone fragments and list markers are not flagged", () => {
  const data = [{ phone: "+14155550134", content: "within 30 days" }];
  assert.deepEqual(verifyNumbers("1. We'll text (415) 555-0134\n2. Returns within 30 days", data).ungrounded, []);
});
