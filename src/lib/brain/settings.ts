import { getSetting, setSetting } from "@/lib/settings";
import { getPool, q1, type Queryable } from "@/lib/db/pool";
import { audit } from "@/lib/audit";

// Brand Brain ayarları ve kategori bütçeleri. Ücretli işlem varsayılan olarak KAPALIDIR; sahip açar ve onaylar.
// Belge indirme/ayrıştırma/parçalama/tam metin dizini ücretsizdir (yerel, deterministik) ve otomatik çalışır.

export type BrainBudgets = {
  /** İlk toplu gömme (arşivin mevcut içeriği) için sahibin ONAYLADIĞI toplam tutar ($). 0 = onay yok. */
  initialIngestionUsd: number;
  /** Günlük artımlı işleme (yeni/değişen belgelerin gömmesi) üst sınırı ($/gün). */
  dailyIncrementalUsd: number;
  /** Gömme toplam günlük üst sınırı ($/gün; ilk toplu işlem dahil). */
  embeddingsDailyUsd: number;
  /** OCR, transkripsiyon ve AI sınıflandırma: bu sürümde sağlayıcı bağlı değil; 0 = kapalı. */
  ocrDailyUsd: number;
  transcriptionDailyUsd: number;
  classificationDailyUsd: number;
  /** Erişim sırasında sorgu gömmesi ($/gün). */
  retrievalDailyUsd: number;
};

export type BrainConfig = { embeddingsEnabled: boolean; budgets: BrainBudgets };

export const DEFAULT_BRAIN_CONFIG: BrainConfig = {
  embeddingsEnabled: false,
  budgets: { initialIngestionUsd: 0, dailyIncrementalUsd: 0.25, embeddingsDailyUsd: 1, ocrDailyUsd: 0, transcriptionDailyUsd: 0, classificationDailyUsd: 0, retrievalDailyUsd: 0.05 },
};

export const BRAIN_SERVICES = { embeddings: "brain_embeddings", query: "brain_query_embedding" } as const;

export async function getBrainConfig(db: Queryable = getPool()): Promise<BrainConfig> {
  const v = await getSetting<Partial<BrainConfig>>("brain:config", {}, db);
  return { embeddingsEnabled: v.embeddingsEnabled === true, budgets: { ...DEFAULT_BRAIN_CONFIG.budgets, ...(v.budgets ?? {}) } };
}

export async function setBrainConfig(patch: { embeddingsEnabled?: boolean; budgets?: Partial<BrainBudgets> }, actor = "user") {
  const cur = await getBrainConfig();
  const budgets = { ...cur.budgets };
  for (const [k, v] of Object.entries(patch.budgets ?? {})) {
    if (!(k in budgets)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 500) throw new Error(`Geçersiz bütçe: ${k}`);
    (budgets as Record<string, number>)[k] = Math.round(n * 10000) / 10000;
  }
  const next: BrainConfig = { embeddingsEnabled: patch.embeddingsEnabled ?? cur.embeddingsEnabled, budgets };
  await setSetting("brain:config", next);
  await audit({ actor, action: "brain.config", message: `Brand Brain ayarları güncellendi (gömme ${next.embeddingsEnabled ? "açık" : "kapalı"}, ilk toplu onay $${budgets.initialIngestionUsd}, günlük gömme $${budgets.embeddingsDailyUsd})` });
  return next;
}

export async function isBrainPaused(brandId: string, db: Queryable = getPool()) {
  return getSetting<boolean>(`brain:paused:${brandId}`, false, db);
}

export async function setBrainPaused(brandId: string, paused: boolean, actor = "user") {
  await setSetting(`brain:paused:${brandId}`, paused);
  await audit({ brandId, actor, action: paused ? "brain.pause" : "brain.resume", message: paused ? "Brand Brain içerik işleme duraklatıldı" : "Brand Brain içerik işleme devam ettirildi" });
}

/** Bir Brand Brain hizmetinin harcaması (gerçekleşen; bugün veya tüm zamanlar). */
export async function brainSpend(service: string, scope: "today" | "all", db: Queryable = getPool()) {
  const r = await q1<{ s: string | null }>(
    `SELECT SUM(amount_usd) AS s FROM cost_entries WHERE service = $1 AND kind = 'actual' ${scope === "today" ? "AND created_at >= date_trunc('day', now())" : ""}`,
    [service],
    db,
  );
  return Number(r?.s ?? 0);
}
