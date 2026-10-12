// tsx scripts/ask.ts "return window" — prints top chunks per org (Phase 2 smoke test)
import { retrieve } from "../src/rag/retrieve.ts";

const q = process.argv[2] ?? "return window";
for (const org of ["acme", "blueharbor"]) {
  console.log(`\n## ${org}: "${q}"`);
  for (const r of await retrieve(org, q, 2)) console.log(` ${r.score}  ${r.source} › ${r.heading}\n    ${r.content.slice(0, 110)}…`);
}
process.exit(0);
