import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, sql } from "drizzle-orm";
import express, { type Request, type Response } from "express";
import { addUsage, emptyUsage, runChat } from "./ai/agent.ts";
import { GUARD_MODEL } from "./ai/client.ts";
import { classifyIntent } from "./ai/guard.ts";
import { maskPhone, notify } from "./ai/notify.ts";
import { CANNED } from "./ai/prompt.ts";
import { type Tx, withTenant } from "./db/client.ts";
import * as s from "./db/schema.ts";
import { rateLimit } from "./rateLimit.ts";
import { operatorOnly } from "./tenant.ts";

export const routes = express.Router();
const MAX_INPUT = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (cents: number) => Math.round(cents) / 100;

/** Error → HTTP status + customer-safe message. Shared by the JSON error handler and the SSE error event. */
export function statusOf(e: unknown): { status: number; error: string } {
  if (e instanceof Anthropic.RateLimitError) return { status: 503, error: "The assistant is busy right now. Please retry in a moment." };
  if (e instanceof Anthropic.APIError) return { status: 502, error: "The AI service returned an error. Please try again." };
  const t = (e as { type?: string })?.type;
  if (t === "entity.parse.failed") return { status: 400, error: "Invalid JSON body." };
  if (t === "entity.too.large") return { status: 413, error: "Request body too large." };
  return { status: 500, error: "Something went wrong on our side." };
}

// ---------- UI shape: raw Claude blocks → one bubble per turn ----------
type Block = Anthropic.Beta.BetaContentBlockParam;
type Row = typeof s.messages.$inferSelect;
export type UiMessage = {
  id: number; role: "user" | "assistant"; text: string;
  tools: { id: string; name: string; input: unknown; result?: unknown }[];
  grounding?: { ungrounded: string[] } | null; guard?: { intent: string; confidence: number } | null; human?: boolean;
};
const parseJson = (v: unknown) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };

export function toUi(rows: Row[]): UiMessage[] {
  const out: UiMessage[] = [];
  let lastWasToolResult = false;
  for (const r of rows) {
    const content = r.content as string | Block[];
    if (r.role === "user") {
      if (typeof content === "string") { out.push({ id: r.id, role: "user", text: content, tools: [], guard: r.guard }); lastWasToolResult = false; continue; }
      const prev = out.at(-1);
      for (const b of content) {
        if (b.type === "tool_result") { const t = prev?.tools.find((x) => x.id === b.tool_use_id); if (t) t.result = parseJson(b.content); }
        else if (b.type === "text") out.push({ id: r.id, role: "user", text: b.text, tools: [] });
      }
      lastWasToolResult = true;
      continue;
    }
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    const tools = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const prev = out.at(-1);
    if (lastWasToolResult && prev?.role === "assistant") { // continuation of the same agent turn
      prev.id = r.id; prev.text += text; prev.tools.push(...tools); prev.grounding = r.grounding ?? prev.grounding;
    } else {
      out.push({ id: r.id, role: "assistant", text, tools, grounding: r.grounding, human: text.startsWith("[Human support agent]") });
    }
    lastWasToolResult = false;
  }
  return out;
}

const hasPendingOrder = async (tx: Tx, conversationId: string) =>
  (await tx.select({ st: s.orders.status }).from(s.orders).where(eq(s.orders.conversationId, conversationId))).some((o) => o.st === "pending_approval");

// ---------- chat (SSE) ----------  order: rateLimit → input cap → guard → (escalated ? handoff : agent)
routes.post("/chat", rateLimit, async (req, res) => {
  const { orgId, sessionId } = req.ctx;
  const body = (req.body ?? {}) as { message?: unknown; conversationId?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!sessionId) return res.status(400).json({ error: "x-session-id header required" });
  if (!message) return res.status(400).json({ error: "message required" });
  if (message.length > MAX_INPUT) return res.status(413).json({ error: `Message too long (max ${MAX_INPUT} characters).` });
  const requested = typeof body.conversationId === "string" && UUID.test(body.conversationId) ? body.conversationId : null;

  const conversation = await withTenant(orgId, async (tx) => {
    if (requested) {
      const [c] = await tx.select().from(s.conversations).where(and(eq(s.conversations.id, requested), eq(s.conversations.sessionId, sessionId)));
      if (c) return c;
    }
    return (await tx.insert(s.conversations).values({ orgId, sessionId }).returning())[0]!;
  });
  const ctx = { orgId, sessionId, conversationId: conversation.id };

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  send("meta", { conversationId: conversation.id, status: conversation.status });
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    const guard = await classifyIntent(orgId, message);
    send("guard", { intent: guard.intent, confidence: guard.confidence });
    const canned = CANNED[guard.intent];
    if (canned || conversation.status === "escalated") {
      // No agent call: store the turn, answer with the canned line or hand off to the human queue.
      const { messageId, pendingOrder } = await withTenant(orgId, async (tx) => {
        await tx.insert(s.messages).values({ orgId, conversationId: conversation.id, role: "user", content: message, guard: { intent: guard.intent, confidence: guard.confidence } });
        let messageId = 0;
        if (canned) {
          const [row] = await tx.insert(s.messages).values({ orgId, conversationId: conversation.id, role: "assistant", content: [{ type: "text", text: canned }], grounding: { ungrounded: [] } }).returning({ id: s.messages.id });
          messageId = row!.id;
        }
        return { messageId, pendingOrder: await hasPendingOrder(tx, conversation.id) };
      });
      const usage = emptyUsage(GUARD_MODEL);
      addUsage(usage, guard.model, guard.usage);
      if (canned) send("text_delta", { text: canned });
      else send("handoff", { message: "Your message was passed to a human support agent. They will reply here." });
      send("done", { messageId, usage, grounding: { ungrounded: [] }, status: conversation.status, pendingOrder });
    } else {
      for await (const ev of runChat(ctx, message, guard, abort.signal)) send(ev.type, ev);
    }
  } catch (e) {
    if (!abort.signal.aborted) {
      const mapped = statusOf(e);
      console.error("chat error:", (e as Error)?.constructor?.name, (e as Error)?.message);
      send("error", mapped);
    }
  } finally {
    res.end();
  }
});

// ---------- customer-side reads ----------
routes.get("/org", async (req, res) => {
  const [org] = await withTenant(req.ctx.orgId, (tx) => tx.select().from(s.orgs));
  if (!org) return res.status(404).json({ error: "unknown store" });
  res.json({ id: org.id, name: org.name, approvalThreshold: money(org.approvalThresholdCents) });
});

routes.get("/products", async (req, res) => {
  const rows = await withTenant(req.ctx.orgId, (tx) => tx.select().from(s.products).orderBy(s.products.id));
  res.json(rows.map((p) => ({ id: p.id, sku: p.sku, name: p.name, category: p.category, description: p.description, price: money(p.priceCents), stock: p.stock })));
});

routes.get("/conversations/:id", async (req, res) => {
  const id = req.params.id;
  if (!UUID.test(id)) return res.status(404).json({ error: "not found" });
  const data = await withTenant(req.ctx.orgId, async (tx) => {
    const [c] = await tx.select().from(s.conversations).where(and(eq(s.conversations.id, id), eq(s.conversations.sessionId, req.ctx.sessionId)));
    if (!c) return null;
    const rows = await tx.select().from(s.messages).where(eq(s.messages.conversationId, id)).orderBy(s.messages.id);
    return { id: c.id, status: c.status, messages: toUi(rows), pendingOrder: await hasPendingOrder(tx, id) };
  });
  if (!data) return res.status(404).json({ error: "not found" });
  res.json(data);
});

routes.post("/messages/:id/feedback", async (req, res) => {
  const id = Number(req.params.id);
  const { rating, note } = (req.body ?? {}) as { rating?: unknown; note?: unknown };
  if (!Number.isInteger(id) || (rating !== "up" && rating !== "down")) return res.status(400).json({ error: "rating must be up|down" });
  const cleanNote = typeof note === "string" ? note.slice(0, 500) : null;
  const ok = await withTenant(req.ctx.orgId, async (tx) => {
    const [m] = await tx.select({ id: s.messages.id }).from(s.messages).where(eq(s.messages.id, id));
    if (!m) return false;
    await tx.insert(s.messageFeedback).values({ messageId: id, orgId: req.ctx.orgId, rating, note: cleanNote })
      .onConflictDoUpdate({ target: s.messageFeedback.messageId, set: { rating, note: cleanNote } });
    return true;
  });
  ok ? res.sendStatus(204) : res.status(404).json({ error: "not found" });
});

// ---------- operator console (mock auth: x-user-id: operator) ----------
const op = express.Router();
op.use(operatorOnly);

const orderView = (o: typeof s.orders.$inferSelect) => ({
  id: o.id, number: o.number, status: o.status, conversationId: o.conversationId, createdAt: o.createdAt,
  subtotal: money(o.subtotalCents), shipping: money(o.shippingCents), total: money(o.totalCents),
  items: o.snapshot.items, address: o.snapshot.address, phone: maskPhone(o.snapshot.phone), email: o.snapshot.email,
  note: o.note, decidedBy: o.decidedBy, decidedAt: o.decidedAt,
});

op.get("/queue", async (req, res) => {
  const data = await withTenant(req.ctx.orgId, async (tx) => {
    const open = await tx.select().from(s.tickets).where(eq(s.tickets.status, "open")).orderBy(desc(s.tickets.createdAt));
    const tickets = [];
    for (const t of open) {
      const rows = await tx.select().from(s.messages).where(eq(s.messages.conversationId, t.conversationId)).orderBy(desc(s.messages.id)).limit(15);
      tickets.push({ ...t, messages: toUi(rows.reverse()).slice(-5) });
    }
    const pending = await tx.select().from(s.orders).where(eq(s.orders.status, "pending_approval")).orderBy(desc(s.orders.createdAt));
    return { tickets, orders: pending.map(orderView) };
  });
  res.json(data);
});

async function decide(req: Request, res: Response, approve: boolean) {
  const id = String(req.params.id);
  if (!UUID.test(id)) return res.status(404).json({ error: "not found" });
  const note = typeof (req.body as { note?: unknown })?.note === "string" ? ((req.body as { note: string }).note).slice(0, 500) : null;
  const order = await withTenant(req.ctx.orgId, async (tx) => {
    const [o] = await tx.update(s.orders)
      .set({ status: approve ? "confirmed" : "rejected", decidedBy: "operator", decidedAt: new Date(), note })
      .where(and(eq(s.orders.id, id), eq(s.orders.status, "pending_approval"))).returning();
    if (o && !approve) for (const i of o.snapshot.items) await tx.update(s.products).set({ stock: sql`${s.products.stock} + ${i.qty}` }).where(eq(s.products.id, i.productId));
    return o;
  });
  if (!order) return res.status(404).json({ error: "no pending order with that id" });
  await (approve ? notify.confirmation : notify.rejection)(req.ctx.orgId, order);
  res.json(orderView(order));
}
op.post("/orders/:id/approve", (req, res) => decide(req, res, true));
op.post("/orders/:id/reject", (req, res) => decide(req, res, false));

op.post("/tickets/:id/reply", async (req, res) => {
  const id = Number(req.params.id);
  const text = String((req.body as { text?: unknown })?.text ?? "").trim().slice(0, 2000);
  if (!Number.isInteger(id) || !text) return res.status(400).json({ error: "text required" });
  const data = await withTenant(req.ctx.orgId, async (tx) => {
    const [t] = await tx.select().from(s.tickets).where(and(eq(s.tickets.id, id), eq(s.tickets.status, "open")));
    if (!t) return null;
    const [c] = await tx.select().from(s.conversations).where(eq(s.conversations.id, t.conversationId));
    const [cart] = await tx.select({ phone: s.carts.phone, email: s.carts.email }).from(s.carts)
      .where(eq(s.carts.sessionId, c!.sessionId)).orderBy(desc(s.carts.createdAt)).limit(1);
    return { t, to: { phone: cart?.phone ?? undefined, email: cart?.email ?? undefined } };
  });
  if (!data) return res.status(404).json({ error: "no open ticket with that id" });
  await notify.handoff(req.ctx.orgId, data.t, text, data.to);
  res.sendStatus(204);
});

op.post("/tickets/:id/resolve", async (req, res) => {
  const id = Number(req.params.id);
  const ok = await withTenant(req.ctx.orgId, async (tx) => {
    const [t] = await tx.update(s.tickets).set({ status: "resolved" }).where(and(eq(s.tickets.id, id), eq(s.tickets.status, "open"))).returning();
    if (!t) return false;
    await tx.update(s.conversations).set({ status: "active" }).where(eq(s.conversations.id, t.conversationId));
    return true;
  });
  ok ? res.sendStatus(204) : res.status(404).json({ error: "no open ticket with that id" });
});
routes.use("/operator", op);

// ---------- outbox + usage ----------
routes.get("/outbox", async (req, res) => {
  const rows = await withTenant(req.ctx.orgId, (tx) => tx.select().from(s.outbox).orderBy(desc(s.outbox.id)).limit(50));
  res.json(rows.map((r) => ({ ...r, toAddr: r.channel === "sms" ? maskPhone(r.toAddr) : r.toAddr })));
});

routes.get("/usage", async (req, res) => {
  const agg = {
    calls: sql<number>`count(*)::int`,
    inputTokens: sql<number>`coalesce(sum(${s.aiUsage.inputTokens}), 0)::int`,
    outputTokens: sql<number>`coalesce(sum(${s.aiUsage.outputTokens}), 0)::int`,
    cacheReadTokens: sql<number>`coalesce(sum(${s.aiUsage.cacheReadTokens}), 0)::int`,
    cacheWriteTokens: sql<number>`coalesce(sum(${s.aiUsage.cacheWriteTokens}), 0)::int`,
    costUsd: sql<number>`coalesce(sum(${s.aiUsage.costUsd}), 0)::float`,
    ungrounded: sql<number>`coalesce(sum(${s.aiUsage.ungroundedNumbers}), 0)::int`,
    errors: sql<number>`count(${s.aiUsage.error})::int`,
  };
  const data = await withTenant(req.ctx.orgId, async (tx) => ({
    totals: (await tx.select(agg).from(s.aiUsage))[0],
    byFeature: await tx.select({ feature: s.aiUsage.feature, ...agg }).from(s.aiUsage).groupBy(s.aiUsage.feature),
    recent: await tx.select().from(s.aiUsage).orderBy(desc(s.aiUsage.id)).limit(20),
  }));
  res.json(data);
});
