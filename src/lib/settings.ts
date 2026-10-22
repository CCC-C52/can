import { q, q1, type Queryable, getPool } from "@/lib/db/pool";

export type Limits = {
  maxConcurrentTasks: number;      // aynı anda çalışan görev sayısı
  maxTasksPerProject: number;      // planın oluşturabileceği en fazla görev
  maxModelCallsPerProject: number; // proje başına model çağrısı sınırı
  taskTimeoutMs: number;           // tek görev çalışma süresi sınırı
  renderTimeoutMs: number;         // render (ffmpeg/derleme) görevlerinin süre sınırı; küçük CPU'da video kurgusu uzun sürer
  maxAttempts: number;             // geçici hatalarda en fazla deneme
  maxRegenerations: number;        // çıktı başına yeniden üretim sınırı
  perTaskBudgetUsd: number | null; // görev başına harcama sınırı (null = sınırsız)
  dailyBudgetUsd: number | null;   // günlük toplam AI harcama sınırı
  blockUnknownCost: boolean;       // maliyeti tahmin edilemeyen ücretli işlemler engellensin mi
  paidMediaGeneration: boolean;    // ücretli AI görsel/video üretimine sahip izni (varsayılan kapalı)
  maxVideoGenSeconds: number;      // proje başına AI video saniye sınırı
};

export const DEFAULT_LIMITS: Limits = {
  maxConcurrentTasks: 3,
  maxTasksPerProject: 12,
  maxModelCallsPerProject: 40,
  taskTimeoutMs: 180_000,
  renderTimeoutMs: 1_200_000,
  maxAttempts: 3,
  maxRegenerations: 3,
  perTaskBudgetUsd: 1,
  dailyBudgetUsd: 10,
  blockUnknownCost: true,
  paidMediaGeneration: false,
  maxVideoGenSeconds: 16,
};

export async function getSetting<T>(key: string, fallback: T, db: Queryable = getPool()): Promise<T> {
  const row = await q1<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key], db);
  return row ? row.value : fallback;
}

export async function setSetting(key: string, value: unknown, db: Queryable = getPool()) {
  await q(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
    db,
  );
}

export async function getLimits(db: Queryable = getPool()): Promise<Limits> {
  const stored = await getSetting<Partial<Limits>>("limits", {}, db);
  return { ...DEFAULT_LIMITS, ...stored };
}

export async function isPaused(db: Queryable = getPool()): Promise<boolean> {
  return getSetting<boolean>("paused", false, db);
}
