import fs from "node:fs/promises";
import path from "node:path";
import { getPool } from "./pool";
import { config } from "@/lib/config";
import { classifySql, loadPolicy, sha256 } from "./migration-safety";

/**
 * Üretimde geçiş uygulanmadan önce politika denetimi (dağıtım iş akışından bağımsız ikinci savunma hattı):
 * kayıtlı geçişin içeriği değişmişse veya kayıtsız geçiş "additive" değilse uygulama başlamaz; mevcut sürüm canlı kalır.
 */
export function assertMigrationAllowed(dir: string, file: string, sql: string) {
  const policy = loadPolicy(dir);
  const entry = policy.migrations[file];
  if (entry) {
    if (entry.sha256 !== sha256(sql)) throw new Error(`Geçiş politikası: ${file} içeriği onaylı kayıtla eşleşmiyor; uygulanmadı.`);
    return;
  }
  const c = classifySql(sql);
  if (c.class !== "additive") {
    throw new Error(`Geçiş politikası: ${file} '${c.class}' sınıfında (${c.findings.map((f) => f.rule).join(", ")}); inceleme ve migrations/policy.json kaydı olmadan uygulanmaz.`);
  }
}

/** migrations/ klasöründeki .sql dosyalarını sırayla ve bir kez uygular. */
export async function runMigrations(dir = path.resolve(process.cwd(), "migrations"), opts: { until?: string; pool?: import("pg").Pool; enforcePolicy?: boolean } = {}): Promise<string[]> {
  const enforce = opts.enforcePolicy ?? config.appMode === "production";
  const pool = opts.pool ?? getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort().filter((f) => !opts.until || f <= opts.until);
  const applied = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name as string));
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), "utf8");
    if (enforce) assertMigrationAllowed(dir, file, sql);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Aynı anda iki süreç geçiş yapmasın
      await client.query("SELECT pg_advisory_xact_lock(424242)");
      const again = await client.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [file]);
      if (again.rowCount === 0) {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
        done.push(file);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Geçiş başarısız (${file}): ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return done;
}
