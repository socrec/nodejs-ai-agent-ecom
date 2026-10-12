import { cosineDistance, desc, sql } from "drizzle-orm";
import { withTenant } from "../db/client.ts";
import { knowledgeChunks } from "../db/schema.ts";
import { embed } from "./embed.ts";

const MIN_SCORE = 0.25; // below this the model should say "I don't know" rather than guess

export async function retrieve(orgId: string, query: string, k = 4) {
  const [q] = await embed([query]);
  const score = sql<number>`1 - (${cosineDistance(knowledgeChunks.embedding, q!)})`;
  // ponytail: sequential scan; add an HNSW index when chunks > 50k.
  const rows = await withTenant(orgId, (tx) => tx
    .select({ source: knowledgeChunks.source, heading: knowledgeChunks.heading, content: knowledgeChunks.content, score })
    .from(knowledgeChunks).orderBy(desc(score)).limit(k));
  return rows.filter((r) => r.score >= MIN_SCORE).map((r) => ({ ...r, score: Math.round(r.score * 100) / 100 }));
}
