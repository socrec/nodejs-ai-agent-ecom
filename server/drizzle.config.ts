import { defineConfig } from "drizzle-kit";
try { process.loadEnvFile(); } catch {}
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL! },
});
