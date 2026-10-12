// runChat: one customer turn → SDK tool runner (streaming) → ChatEvents for SSE. Persists the raw Claude
// content blocks append-only, logs every model call to ai_usage, runs number grounding on the final text.
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { type Tx, withTenant } from "../db/client.ts";
import * as s from "../db/schema.ts";
import { MODEL, client, costUsd, logUsage, type Usage } from "./client.ts";
import { verifyNumbers } from "./grounding.ts";
import type { GuardResult } from "./guard.ts";
import { SYSTEM } from "./prompt.ts";
import { type Ctx, type ToolRecord, makeTools } from "./tools.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

export type UsageSummary = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
export type ChatEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string }
  | ({ type: "tool_result" } & ToolRecord)
  | { type: "handoff"; message: string }
  | { type: "done"; messageId: number; usage: UsageSummary; grounding: { ungrounded: string[] }; status: string; pendingOrder: boolean };

/** Turn totals for the `done` event: the guard call plus every agent iteration. */
export function summarize(calls: { model: string; usage: Usage }[]): UsageSummary {
  const sum: UsageSummary = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  for (const { model, usage: u } of calls) {
    sum.calls++; sum.input += u.input_tokens; sum.output += u.output_tokens;
    sum.cacheRead += u.cache_read_input_tokens ?? 0; sum.cacheWrite += u.cache_creation_input_tokens ?? 0;
    sum.costUsd += costUsd(model, u);
  }
  return sum;
}

export const hasPendingOrder = async (tx: Tx, conversationId: string) =>
  (await tx.select({ status: s.orders.status }).from(s.orders).where(eq(s.orders.conversationId, conversationId))).some((o) => o.status === "pending_approval");

/** Numbers the model was allowed to use: every tool input and tool result in the conversation. */
export function toolData(history: MessageParam[]): unknown[] {
  const out: unknown[] = [];
  for (const m of history) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") out.push(b.input);
      else if (b.type === "tool_result" && typeof b.content === "string") { try { out.push(JSON.parse(b.content)); } catch { out.push(b.content); } }
    }
  }
  return out;
}

export async function* runChat(ctx: Ctx, message: string, guard: GuardResult, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const { org, prior } = await withTenant(ctx.orgId, async (tx) => ({
    org: (await tx.select().from(s.orgs))[0]!,
    prior: await tx.select({ role: s.messages.role, content: s.messages.content }).from(s.messages)
      .where(eq(s.messages.conversationId, ctx.conversationId)).orderBy(s.messages.id),
  }));
  await withTenant(ctx.orgId, (tx) => tx.insert(s.messages).values({
    orgId: ctx.orgId, conversationId: ctx.conversationId, role: "user", content: message,
    guard: { intent: guard.intent, confidence: guard.confidence },
  }));

  const history: MessageParam[] = [
    { role: "user", content: `Store: ${org.name}` }, // per-org preamble keeps the system block byte-stable
    ...prior.map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string | Block[] })),
    { role: "user", content: message },
  ];
  const baseLen = history.length;
  const pending: ToolRecord[] = [];
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    tools: makeTools(ctx, (r) => pending.push(r)),
    messages: history,
    stream: true,
    max_iterations: 8,
    output_config: { effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  }, { signal });

  const calls: { model: string; usage: Usage; latencyMs: number }[] = [];
  let text = "";
  let cutOff: Anthropic.Beta.BetaMessage | undefined;
  try {
    for await (const stream of runner) {
      for (const r of pending.splice(0)) yield { type: "tool_result", ...r };
      const t0 = Date.now();
      for await (const ev of stream) {
        if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
          yield { type: "tool_call", id: ev.content_block.id, name: ev.content_block.name };
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          text += ev.delta.text;
          yield { type: "text_delta", text: ev.delta.text };
        }
      }
      const msg = await stream.finalMessage();
      calls.push({ model: msg.model, usage: msg.usage, latencyMs: Date.now() - t0 });
      // Break before the runner appends the message so the repair below owns it (and its unanswered tool calls).
      if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") { cutOff = msg; break; }
    }
  } catch (e) {
    for (const c of calls) await logUsage({ orgId: ctx.orgId, feature: "chat", ...c });
    await logUsage({ orgId: ctx.orgId, feature: "chat", model: MODEL, latencyMs: 0, error: (e as Error).constructor.name });
    throw e;
  }
  for (const r of pending.splice(0)) yield { type: "tool_result", ...r };

  // New history = what the runner appended (assistant turns + tool results), repaired when the turn ended mid-way.
  const added: MessageParam[] = runner.params.messages.slice(baseLen).map((m) => ({ role: m.role, content: m.content }));
  if (cutOff) {
    added.push({ role: "assistant", content: cutOff.content });
    const uses = cutOff.content.filter((b) => b.type === "tool_use");
    if (uses.length) added.push({ role: "user", content: uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: "Cancelled: the reply was cut off.", is_error: true })) });
  }
  if (cutOff || added.at(-1)?.role === "user") { // cut off, or max_iterations ended the turn on tool results
    const apology = cutOff?.stop_reason === "refusal"
      ? "I can't help with that request. I can help with products, your cart and orders."
      : "I ran out of room for that reply. Could you rephrase or split your request?";
    added.push({ role: "assistant", content: [{ type: "text", text: apology }] });
    text += apology;
    yield { type: "text_delta", text: apology };
  }
  const grounding = verifyNumbers(text, toolData([...history, ...added]));

  const { messageId, status, pendingOrder } = await withTenant(ctx.orgId, async (tx) => {
    let messageId = 0;
    for (const [i, m] of added.entries()) {
      const [row] = await tx.insert(s.messages).values({
        orgId: ctx.orgId, conversationId: ctx.conversationId, role: m.role, content: m.content,
        grounding: i === added.length - 1 ? grounding : undefined,
      }).returning({ id: s.messages.id });
      if (m.role === "assistant") messageId = row!.id;
    }
    const [c] = await tx.select({ status: s.conversations.status }).from(s.conversations).where(eq(s.conversations.id, ctx.conversationId));
    return { messageId, status: c!.status, pendingOrder: await hasPendingOrder(tx, ctx.conversationId) };
  });
  for (const [i, c] of calls.entries()) {
    await logUsage({ orgId: ctx.orgId, feature: "chat", ...c, ungrounded: i === calls.length - 1 ? grounding.ungrounded.length : 0 });
  }
  yield { type: "done", messageId, usage: summarize([guard, ...calls]), grounding, status, pendingOrder };
}
