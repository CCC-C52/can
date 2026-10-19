import fs from "node:fs/promises";
import path from "node:path";
import { getPool } from "./pool";

/** migrations/ klasöründeki .sql dosyalarını sırayla ve bir kez uygular. */
export async function runMigrations(dir = path.resolve(process.cwd(), "migrations")): Promise<string[]> {
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await pool.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name as string));
  const done: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), "utf8");
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
