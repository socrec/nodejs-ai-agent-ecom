// Requests AND tokens: sliding windows per session/org in memory + per-org daily token budget from ai_usage.
// ponytail: single process; move the windows to Redis when horizontally scaled.
import type { NextFunction, Request, Response } from "express";
import { gte, sql } from "drizzle-orm";
import { withTenant } from "./db/client.ts";
import { aiUsage } from "./db/schema.ts";

export const LIMITS = {
  session: { max: 20, windowMs: 10 * 60_000 },
  org: { max: 300, windowMs: 60 * 60_000 },
  dailyTokens: 3_000_000,
};

const windows = new Map<string, number[]>();
const inflight = new Set<string>();

/** Returns 0 if allowed (and records the hit), else seconds until the oldest hit leaves the window. */
export function hit(key: string, max: number, windowMs: number, now = Date.now()): number {
  const times = (windows.get(key) ?? []).filter((t) => t > now - windowMs);
  windows.set(key, times);
  if (times.length >= max) return Math.max(1, Math.ceil((times[0]! + windowMs - now) / 1000));
  times.push(now);
  return 0;
}

setInterval(() => { for (const [k, v] of windows) if (v.every((t) => t < Date.now() - LIMITS.org.windowMs)) windows.delete(k); }, 60_000).unref();

export async function rateLimit(req: Request, res: Response, next: NextFunction) {
  const { orgId, sessionId } = req.ctx;
  if (!sessionId) return res.status(400).json({ error: "x-session-id header required" }); // the session window needs a key
  const sessKey = `sess:${orgId}:${sessionId}`;
  if (inflight.has(sessKey)) return res.status(409).json({ error: "A reply is still streaming for this session." });
  for (const [key, l] of [[sessKey, LIMITS.session], [`org:${orgId}`, LIMITS.org]] as const) {
    const retry = hit(key, l.max, l.windowMs);
    if (retry) return res.status(429).set("Retry-After", String(retry)).json({ error: "Too many messages. Please slow down.", retryAfter: retry });
  }
  const [{ used }] = await withTenant(orgId, (tx) => tx
    .select({ used: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::int` })
    .from(aiUsage).where(gte(aiUsage.createdAt, sql`date_trunc('day', now())`)));
  if (used! >= LIMITS.dailyTokens) {
    const retry = Math.ceil((new Date().setUTCHours(24, 0, 0, 0) - Date.now()) / 1000);
    return res.status(429).set("Retry-After", String(retry)).json({ error: "This store's daily AI budget is used up. Try again tomorrow.", reason: "budget", retryAfter: retry });
  }
  inflight.add(sessKey);
  res.on("close", () => inflight.delete(sessKey));
  next();
}
