// Applies rls.sql as admin. drizzle-kit push knows nothing about these policies and drops them on every
// push, so `npm run db:push` chains this script; seed.ts applies the same file after seeding.
import { readFileSync } from "node:fs";
import postgres from "postgres";

try { process.loadEnvFile(); } catch {}

const sql = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
await sql.unsafe(readFileSync(new URL("./rls.sql", import.meta.url), "utf8"));
await sql.end();
console.log("RLS policies applied");
