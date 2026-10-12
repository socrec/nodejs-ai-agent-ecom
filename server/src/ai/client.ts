import Anthropic from "@anthropic-ai/sdk";
import { withTenant } from "../db/client.ts";
import { aiUsage } from "../db/schema.ts";

try { process.loadEnvFile(); } catch {}

export const client = new Anthropic();
export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
export const GUARD_MODEL = process.env.GUARD_MODEL ?? "claude-haiku-5-5";

/** USD per 1M tokens: [input, output, cache read, cache write] */
export const PRICING: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

export type Usage = Pick<Anthropic.Beta.BetaUsage,
  "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens">;

export function costUsd(model: string, u: Usage): number {
  const p = Object.entries(PRICING).find(([k]) => model.startsWith(k))?.[1] ?? PRICING["claude-opus-5-5"]!;
  return (u.input_tokens * p[0] + u.output_tokens * p[1]
    + (u.cache_read_input_tokens ?? 0) * p[2] + (u.cache_creation_input_tokens ?? 0) * p[3]) / 1e6;
}

export type Feature = "chat" | "guard" | "summary" | "eval";

/** Every model call lands here. No message text, no PII. */
export async function logUsage(row: {
  orgId: string; feature: Feature; model: string; usage?: Usage | null; latencyMs: number; ungrounded?: number; error?: string;
}): Promise<number> {
  const u = row.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const cost = costUsd(row.model, u);
  await withTenant(row.orgId, (tx) => tx.insert(aiUsage).values({
    orgId: row.orgId, feature: row.feature, model: row.model,
    inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: cost, latencyMs: row.latencyMs, ungroundedNumbers: row.ungrounded ?? 0, error: row.error,
  }));
  return cost;
}
