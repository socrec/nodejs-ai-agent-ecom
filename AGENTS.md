# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. `PLAN.md` is the *why*;
this file is the *how*.

## What this is

Interview demo: multi-tenant e-commerce ordering agent. Customer chat that completes an
order (cart → address → phone → confirmation), RAG over store policies (pgvector), human
escalation and order approval, layered guardrails, rate limits, per-tenant cost tracking.
Express/TS + Drizzle/Postgres (RLS) + React/Vite + `@anthropic-ai/sdk`.

## Commands

```bash
npm install                       # workspaces: server/, web/
npm run db:up                     # docker compose up -d (pgvector/pgvector:pg16)
npm run db:push                   # drizzle-kit push, then src/db/rls.ts (push drops the RLS policies)
npm run db:seed                   # deterministic seed + applies src/db/rls.sql
npm run rag:ingest                # chunk + embed server/knowledge/** → knowledge_chunks
npm run dev                       # server :3001 + web :5173 (vite proxies /api)
npm run check                     # tsc --noEmit in both workspaces
npm run test                      # node --test (chunk, grounding, rateLimit)
npm run eval                      # server/evals/run.ts: scenario pass/fail + cost
```

`server/.env`: `DATABASE_URL` (app_user), `DATABASE_ADMIN_URL` (postgres; push/seed/ingest),
`ANTHROPIC_API_KEY`, optional `CLAUDE_MODEL` (default `claude-opus-5-5`),
`GUARD_MODEL` (default `claude-haiku-5-5`).

## Layout

```
server/src/index.ts          express app; tenant.ts + rateLimit.ts middleware; error → status mapping
server/src/routes.ts         chat (SSE), conversations, feedback, products, operator/*, outbox, usage
server/src/tenant.ts         x-org-id / x-session-id / x-user-id → req.ctx
server/src/rateLimit.ts      sliding windows (session, org) + daily token budget from ai_usage
server/src/db/schema.ts      drizzle tables (every data table has org_id; vector(384) on knowledge_chunks)
server/src/db/rls.sql        policies + FORCE ROW LEVEL SECURITY
server/src/db/client.ts      withTenant(orgId, fn), the ONLY way tools touch the DB
server/src/db/seed.ts        deterministic seed (seeded PRNG), 2 stores, demo stories
server/src/ai/client.ts      Anthropic client, MODEL, GUARD_MODEL, PRICING, costUsd(), logUsage()
server/src/ai/prompt.ts      frozen system prompt (no timestamps, no store name; that goes in the first user turn)
server/src/ai/tools.ts       makeTools(ctx) → betaZodTool[]; org/session closed over
server/src/ai/agent.ts       runChat(ctx, conversation, message) → AsyncGenerator<ChatEvent>
server/src/ai/guard.ts       classifyIntent(message) via Haiku structured output
server/src/ai/grounding.ts   verifyNumbers(text, toolResults) → { ungrounded: string[] }
server/src/ai/notify.ts      confirmation()/rejection()/handoff() → outbox row + chat message
server/src/rag/embed.ts      embed(texts), MiniLM via @huggingface/transformers (swap seam)
server/src/rag/ingest.ts     markdown → chunks → embeddings → knowledge_chunks
server/src/rag/retrieve.ts   retrieve(orgId, query, k), cosine top-k inside withTenant
server/knowledge/<org>/*.md  shipping.md, returns.md, faq.md (+ generated products.md)
server/evals/                scenarios.json + run.ts
web/src/App.tsx              org switcher + Tabs: Storefront · Operator · Outbox
web/src/Storefront.tsx       chat (streaming), product/cart cards, grounding badge, thumbs, usage strip
web/src/Operator.tsx         queue: tickets (reply/resolve) + pending orders (approve/reject)
web/src/Outbox.tsx           mock email/SMS list
web/src/useChatStream.ts     fetch + ReadableStream SSE reader; 429 → toast with Retry-After
```

## Invariants (do not break)

1. **Tenant and session come from `req.ctx` only.** Never a tool parameter, never model
   input. Tools are built per request by `makeTools(ctx)`.
2. **All DB access from tools goes through `withTenant()`** (transaction +
   `select set_config('app.org_id', $1, true)`). Shopper-level scoping is an explicit
   `where session_id = ctx.sessionId` in cart/order queries.
3. **App connects as `app_user`** (non-superuser). RLS on every table with `org_id`,
   `FORCE ROW LEVEL SECURITY`. Admin URL only for push/seed/ingest.
4. **Order state lives in the DB.** `place_order` is the single gate: cart non-empty,
   address, phone, `confirmed: true`. Over threshold → `pending_approval`; never
   auto-approve, never send a confirmation for an unapproved order.
5. **Tools never throw into the loop.** Return `{ error: "..." }` so the model can relay it.
   Mutations are idempotent per cart.
6. **Numbers come from tools.** Prices/totals/stock are never computed by the model;
   `grounding.ts` runs on every final answer and the result is stored. Fix ungrounded
   numbers by extending a tool, not by loosening the prompt.
7. **Guard runs before the agent; rate limit runs before the guard.** Order in
   `routes.ts`: rateLimit → input cap → guard → (escalated? handoff : agent).
8. **Message history is append-only.** Store `response.content` whole (text, tool_use,
   tool_result, thinking); operator replies append an assistant text block prefixed
   `[Human support agent]`. Never edit or drop earlier blocks.
9. **No PII in logs or `ai_usage`.** Mask phone to last 4 in operator views.
10. **Every model call logs to `ai_usage`** (feature: chat | guard | summary | eval).

## Claude API rules (see the `claude-api` skill if unsure)

- Model ids exactly `claude-opus-5-5` (agent) and `claude-haiku-5-5` (guard). No date suffixes.
- Omit `thinking` (always on in this family). Never send `budget_tokens` or
  `thinking: {type:"disabled"}` (400). Depth via `output_config: { effort }`:
  agent `"medium"`, guard `"low"`.
- Never force `tool_choice` (`any`/`tool` → 400). Steer from the prompt; zod validates inputs.
- Agent loop: `client.beta.messages.toolRunner({ model, max_tokens: 16000, system, tools,
  messages, stream: true, max_iterations: 8, cache_control, context_management,
  betas: ["server-side-fallback-2026-07-01", "context-management-2025-06-27"],
  fallbacks: "default" })`. `for await (const stream of runner)` → forward `text_delta` and
  tool_use `content_block_start`; `await stream.finalMessage()`; stop on
  `stop_reason === "refusal"` or `"max_tokens"` and repair the history (cancelled tool results +
  apology). After `max_iterations` the history ends on tool results; append the apology there too.
- Classifier/summary: `client.messages.parse({ output_config: { format: zodOutputFormat(S) } })`,
  guard `parsed_output === null` → treat as `shopping` (fail open to the agent, log it).
- Caching: tools → system → messages; `cache_control: { type: "ephemeral" }` on the system
  block AND top-level (caches the last message, so history is a cache read per iteration);
  system text byte-stable. Check `usage.cache_read_input_tokens`.
- Context: `context_management: { edits: [{ type: "clear_tool_uses_20250919", ... }] }` with beta
  `context-management-2025-06-27` trims old tool results server-side. Never trim history
  client-side (preserved thinking → 400 on new accounts; breaks invariant 8).
- One shared key: `rateLimit.ts` caps concurrent turns (global/org) and `pauseFor()` holds new
  turns after an upstream 429 (`statusOf` in routes.ts sets it). Both answer 503 + Retry-After.
- Use SDK types (`Anthropic.Beta.BetaMessageParam`, …). Don't redefine message shapes.
- Errors: `Anthropic.RateLimitError` → 503 "busy, retry"; `Anthropic.APIError` → 502; else 500.

## Adding a tool

1. `tools.ts`: `betaZodTool({ name, description (say WHEN to use it), inputSchema:
   z.object({...}).strict(), run: (input) => withTenant(ctx.orgId, tx => ...) })`.
   Return JSON; on failure return `{ error }`.
2. If it mutates, make it idempotent and session-scoped.
3. Add one row to `PLAN.md` §4 and one scenario (or assertion) to `evals/scenarios.json`.
4. `npm run eval`.

## Style

- Ponytail: smallest working change, stdlib and installed deps before new ones, no
  abstractions with one implementation, no config for constants.
- Non-trivial logic gets one small `node --test` file next to it (grounding, rateLimit,
  chunking). No framework, no fixtures.
- Mark deliberate corner-cuts with `// ponytail: <ceiling>, <upgrade path>`.
- Frontend ≤ 6 components. Cards/tables render from tool JSON, never parsed from prose.

## Git

Never commit, push, merge, rebase, or tag. Report what changed; Dang commits manually.
