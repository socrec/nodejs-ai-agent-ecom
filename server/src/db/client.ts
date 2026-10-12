import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

try { process.loadEnvFile(); } catch {}

export const db = drizzle(postgres(process.env.DATABASE_URL!, { max: 10 }), { schema });
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The only way application code touches the DB: transaction-local org id → RLS. */
export function withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
