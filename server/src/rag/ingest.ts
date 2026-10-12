// npm run rag:ingest — knowledge/<org>/*.md (+ generated products.md) → chunks → embeddings → knowledge_chunks
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { withTenant } from "../db/client.ts";
import { knowledgeChunks, orgs, products } from "../db/schema.ts";
import { chunk } from "./chunk.ts";
import { embed } from "./embed.ts";

const root = new URL("../../knowledge/", import.meta.url);

for (const orgId of readdirSync(root)) {
  const dir = new URL(`${orgId}/`, root);
  const [org] = await withTenant(orgId, (tx) => tx.select().from(orgs));
  if (!org) { console.warn(`skip ${orgId}: no org row`); continue; }

  const rows = await withTenant(orgId, (tx) => tx.select().from(products).orderBy(products.id));
  const productsMd = [`# Products — ${org.name}`, ...rows.map((p) =>
    `## ${p.name} ($${(p.priceCents / 100).toFixed(2)})\n${p.description} Category: ${p.category}. SKU ${p.sku}. ${p.stock > 0 ? "In stock." : "Out of stock."}`)].join("\n\n");
  writeFileSync(new URL("products.md", dir), productsMd);

  const chunks = readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
    .flatMap((f) => chunk(readFileSync(new URL(f, dir), "utf8"), f));
  const vectors = await embed(chunks.map((c) => `${c.heading}\n${c.content}`));
  await withTenant(orgId, async (tx) => {
    await tx.delete(knowledgeChunks); // RLS scopes this to the org
    await tx.insert(knowledgeChunks).values(chunks.map((c, i) => ({ ...c, orgId, embedding: vectors[i]! })));
  });
  console.log(`${orgId}: ${chunks.length} chunks`);
}
process.exit(0);
