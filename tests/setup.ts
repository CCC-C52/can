import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll } from "vitest";
import pg from "pg";

for (const f of [".env.local", ".env"]) if (fs.existsSync(f)) process.loadEnvFile(f);
const url = process.env.TEST_DATABASE_URL ?? "postgres://aiops:aiops@127.0.0.1:5432/aiops_test";
if (!/test/.test(url)) throw new Error("TEST_DATABASE_URL 'test' içermeli (yanlışlıkla üretim veritabanını sıfırlamamak için).");
process.env.DATABASE_URL_OVERRIDE = url;
process.env.LOCAL_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aiops-test-storage-"));
process.env.APP_MODE = "local";
// Testler gerçek servis anahtarı kullanmaz
process.env.LOG_SILENT = "1";
for (const k of ["AIOPS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"]) delete process.env[k];

beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
});

afterAll(async () => {
  const { closePool } = await import("@/lib/db/pool");
  await closePool();
});
