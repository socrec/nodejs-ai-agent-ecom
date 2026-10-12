// npm run eval — scripted multi-turn scenarios against the running server (localhost:3001).
// Assertions check SSE events (tools called, guard intent, grounding) and the DB (orders, outbox, tickets), not prose.
import { readFileSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "../src/db/client.ts";
import * as s from "../src/db/schema.ts";

const BASE = process.env.EVAL_BASE_URL ?? "http://localhost:3001";

type Expect = {
  status?: number; intent?: string; tools?: string[]; toolsOnly?: string[]; text?: string[]; notText?: string[]; textRegex?: string;
  handoff?: boolean; agentCalls?: number; searchProductsEmpty?: boolean; grounded?: boolean;
};
type DbExpect = {
  order?: "none" | "confirmed" | "pending_approval"; total_matches_sql?: boolean; outbox?: number; ticket?: boolean;
  conversation?: "active" | "escalated"; cart_items?: number; cart_subtotal_cents?: number; last_message_includes?: string;
};
type Step = { say: string; repeat?: number; expect?: Expect } | { check: DbExpect } | { approve: true };
type Scenario = { name: string; org: string; steps: Step[] };

type Turn = {
  status: number; text: string; intent?: string; handoff: boolean;
  tools: { name: string; input: unknown; data: any }[]; usage?: { calls: number; costUsd: number }; grounding?: { ungrounded: string[] };
};

async function chat(org: string, sessionId: string, conversationId: string | null, message: string): Promise<Turn & { conversationId: string | null }> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "x-org-id": org, "x-session-id": sessionId, "content-type": "application/json" },
    body: JSON.stringify({ conversationId, message }),
  });
  const turn: Turn & { conversationId: string | null } = { status: res.status, text: "", handoff: false, tools: [], conversationId };
  if (!res.ok) return turn;
  const raw = await res.text();
  for (const frame of raw.split("\n\n")) {
    const type = frame.split("\n").find((l) => l.startsWith("event: "))?.slice(7);
    const data = frame.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
    if (!type || !data) continue;
    const ev = JSON.parse(data);
    if (type === "meta") turn.conversationId = ev.conversationId;
    else if (type === "guard") turn.intent = ev.intent;
    else if (type === "text_delta") turn.text += ev.text;
    else if (type === "tool_result") turn.tools.push({ name: ev.name, input: ev.input, data: ev.data });
    else if (type === "handoff") turn.handoff = true;
    else if (type === "done") { turn.usage = ev.usage; turn.grounding = ev.grounding; }
    else if (type === "error") turn.text += `[error: ${ev.error}]`;
  }
  return turn;
}

function checkTurn(t: Turn, e: Expect, fail: (msg: string) => void) {
  const names = t.tools.map((x) => x.name);
  if (e.status != null && t.status !== e.status) fail(`status ${t.status} ≠ ${e.status}`);
  if (e.intent && t.intent !== e.intent) fail(`intent ${t.intent} ≠ ${e.intent}`);
  if (e.tools) { let i = 0; for (const n of names) if (n === e.tools[i]) i++; if (i < e.tools.length) fail(`tools ${JSON.stringify(names)} missing ${e.tools.slice(i).join(",")}`); }
  if (e.toolsOnly) for (const n of names) if (!e.toolsOnly.includes(n)) fail(`unexpected tool ${n}`);
  for (const sub of e.text ?? []) if (!t.text.toLowerCase().includes(sub.toLowerCase())) fail(`text missing "${sub}"`);
  for (const sub of e.notText ?? []) if (t.text.includes(sub)) fail(`text contains "${sub}"`);
  if (e.textRegex && !new RegExp(e.textRegex, "i").test(t.text)) fail(`text !~ /${e.textRegex}/`);
  if (e.handoff != null && t.handoff !== e.handoff) fail(`handoff ${t.handoff}`);
  if (e.agentCalls != null && (t.usage?.calls ?? 0) - 1 !== e.agentCalls) fail(`agent calls ${(t.usage?.calls ?? 0) - 1} ≠ ${e.agentCalls}`);
  if (e.searchProductsEmpty && !t.tools.some((x) => x.name === "search_products" && x.data?.products?.length === 0)) fail("search_products returned rows");
  if (e.grounded && (t.grounding?.ungrounded.length ?? 1) > 0) fail(`ungrounded: ${t.grounding?.ungrounded.join(", ")}`);
}

async function checkDb(org: string, sessionId: string, conversationId: string | null, e: DbExpect, fail: (msg: string) => void) {
  await withTenant(org, async (tx) => {
    const [order] = await tx.select().from(s.orders).where(eq(s.orders.sessionId, sessionId)).orderBy(desc(s.orders.createdAt)).limit(1);
    if (e.order && (order?.status ?? "none") !== e.order) fail(`order ${order?.status ?? "none"} ≠ ${e.order}`);
    if (e.total_matches_sql && order) {
      const items = await tx.select().from(s.cartItems).where(eq(s.cartItems.cartId, order.cartId));
      const sub = items.reduce((a, i) => a + i.qty * i.unitPriceCents, 0);
      const expected = sub + (sub >= 5000 ? 0 : 599);
      if (order.totalCents !== expected) fail(`total ${order.totalCents} ≠ sql ${expected}`);
    }
    if (e.outbox != null) {
      const rows = order ? await tx.select().from(s.outbox).where(and(eq(s.outbox.refType, "order"), eq(s.outbox.refId, order.id))) : [];
      if (rows.length !== e.outbox) fail(`outbox ${rows.length} ≠ ${e.outbox}`);
    }
    if (conversationId) {
      if (e.ticket != null) { const t = await tx.select().from(s.tickets).where(eq(s.tickets.conversationId, conversationId)); if ((t.length > 0) !== e.ticket) fail(`ticket ${t.length > 0}`); }
      if (e.conversation) { const [c] = await tx.select().from(s.conversations).where(eq(s.conversations.id, conversationId)); if (c?.status !== e.conversation) fail(`conversation ${c?.status}`); }
      if (e.last_message_includes) {
        const [m] = await tx.select().from(s.messages).where(eq(s.messages.conversationId, conversationId)).orderBy(desc(s.messages.id)).limit(1);
        const text = JSON.stringify(m?.content ?? "");
        if (!text.includes(e.last_message_includes)) fail(`last message lacks "${e.last_message_includes}"`);
      }
    }
    if (e.cart_items != null || e.cart_subtotal_cents != null) {
      const [cart] = await tx.select().from(s.carts).where(and(eq(s.carts.sessionId, sessionId), eq(s.carts.status, "open")));
      const items = cart ? await tx.select().from(s.cartItems).where(eq(s.cartItems.cartId, cart.id)) : [];
      if (e.cart_items != null && items.length !== e.cart_items) fail(`cart items ${items.length} ≠ ${e.cart_items}`);
      const sub = items.reduce((a, i) => a + i.qty * i.unitPriceCents, 0);
      if (e.cart_subtotal_cents != null && sub !== e.cart_subtotal_cents) fail(`cart subtotal ${sub} ≠ ${e.cart_subtotal_cents}`);
    }
  });
}

async function approve(org: string, sessionId: string, fail: (msg: string) => void) {
  const [order] = await withTenant(org, (tx) => tx.select().from(s.orders).where(and(eq(s.orders.sessionId, sessionId), eq(s.orders.status, "pending_approval"))));
  if (!order) return fail("no pending order to approve");
  const res = await fetch(`${BASE}/api/operator/orders/${order.id}/approve`, { method: "POST", headers: { "x-org-id": org, "x-user-id": "operator", "content-type": "application/json" }, body: "{}" });
  if (!res.ok) fail(`approve → ${res.status}`);
}

const scenarios: Scenario[] = JSON.parse(readFileSync(new URL("./scenarios.json", import.meta.url), "utf8"));
const only = process.argv[2] ? Number(process.argv[2]) : null;
const rows: { n: number; name: string; pass: boolean; turns: number; cost: number; grounded: [number, number]; notes: string[] }[] = [];
const run = Date.now();

for (const [i, sc] of scenarios.entries()) {
  if (only != null && only !== i + 1) continue;
  const sessionId = `eval-${run}-${i + 1}`;
  let conversationId: string | null = null;
  const notes: string[] = [];
  let turns = 0, cost = 0, groundedOk = 0, groundedTotal = 0;
  const fail = (m: string) => notes.push(m);
  process.stdout.write(`${i + 1}. ${sc.name} `);
  for (const step of sc.steps) {
    if ("check" in step) { await checkDb(sc.org, sessionId, conversationId, step.check, fail); continue; }
    if ("approve" in step) { await approve(sc.org, sessionId, fail); continue; }
    let t: Awaited<ReturnType<typeof chat>> | undefined;
    for (let r = 0; r < (step.repeat ?? 1); r++) t = await chat(sc.org, sessionId, conversationId, step.say);
    conversationId = t!.conversationId;
    turns++; cost += t!.usage?.costUsd ?? 0;
    if (t!.grounding && (t!.usage?.calls ?? 0) > 1) { groundedTotal++; if (t!.grounding.ungrounded.length === 0) groundedOk++; }
    if (step.expect) { const before = notes.length; checkTurn(t!, step.expect, fail); if (notes.length > before) notes.push(`  ↳ "${t!.text.slice(0, 140).replace(/\n/g, " ")}"`); }
    process.stdout.write(".");
  }
  const pass = notes.length === 0;
  rows.push({ n: i + 1, name: sc.name, pass, turns, cost, grounded: [groundedOk, groundedTotal], notes });
  console.log(pass ? " ✓" : " ✗");
}

console.log("\n| # | Scenario | Result | Turns | Grounded | Cost | Notes |\n|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.n} | ${r.name} | ${r.pass ? "PASS" : "FAIL"} | ${r.turns} | ${r.grounded[1] ? `${r.grounded[0]}/${r.grounded[1]}` : "–"} | $${r.cost.toFixed(4)} | ${r.notes.join("; ")} |`);
const passed = rows.filter((r) => r.pass).length;
const g = rows.reduce((a, r) => [a[0] + r.grounded[0], a[1] + r.grounded[1]], [0, 0]);
console.log(`\n${passed}/${rows.length} passed (${Math.round(100 * passed / rows.length)}%) · grounded ${g[0]}/${g[1]} agent turns · total $${rows.reduce((a, r) => a + r.cost, 0).toFixed(4)}`);
process.exit(passed === rows.length ? 0 : 1);
