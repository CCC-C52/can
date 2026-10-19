import pg from "pg";
import { config } from "@/lib/config";

// numeric -> number (maliyet ve fiyatlar için yeterli hassasiyet), bigint -> number
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const g = globalThis as unknown as { __aiopsPool?: pg.Pool; __aiopsPoolUrl?: string };

export function getPool(): pg.Pool {
  const url = process.env.DATABASE_URL_OVERRIDE ?? config.databaseUrl;
  if (!g.__aiopsPool || g.__aiopsPoolUrl !== url) {
    g.__aiopsPool = new pg.Pool({ connectionString: url, max: 10 });
    g.__aiopsPoolUrl = url;
    g.__aiopsPool.on("error", (err) => console.error("[db] havuz hatası:", err.message));
  }
  return g.__aiopsPool;
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = [], db: Queryable = getPool()): Promise<T[]> {
  const res = await db.query(text, params as unknown[]);
  return res.rows as T[];
}

export async function q1<T = Record<string, unknown>>(text: string, params: unknown[] = [], db: Queryable = getPool()): Promise<T | null> {
  const rows = await q<T>(text, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (g.__aiopsPool) {
    await g.__aiopsPool.end();
    g.__aiopsPool = undefined;
  }
}
