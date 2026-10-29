import { q, q1, getPool, type Queryable } from "@/lib/db/pool";
import { log } from "@/lib/log";
import { assertBudget, BudgetExceededError, recordCost } from "@/lib/services/costs";
import { getEmbedder, embeddingCostUsd, EMBEDDING_DIMS } from "./embeddings";
import { BRAIN_SERVICES, getBrainConfig, isBrainPaused } from "./settings";
import { processNextDocument, recoverBrainLeases, syncDocuments, type ProcessOutcome } from "./ingest";

// İşleyici adımı (Render Worker). Sınırlı: tur başına en fazla `docs` belge ve `budgetMs` süre; aynı anda tek tur
// (worker/index.ts bayrağı). Video render ve görev kuyruğu bu turdan bağımsız çalışır. Sıra:
//   kiralama kurtarma → marka başına eşitleme → belge işleme → (izin ve bütçe varsa) gömme.

export type BrainTick = { brandId: string; sync: Awaited<ReturnType<typeof syncDocuments>>; processed: ProcessOutcome[]; embedded: number; embedNote: string | null; recovered: number };

export async function runBrainTick(workerId: string, opts: { docs?: number; budgetMs?: number; brandId?: string } = {}): Promise<BrainTick[]> {
  // Video render'ı sürerken arşiv okunmaz: ikisi aynı küçük sunucuda belleği paylaşır; render önceliklidir
  if (await q1(`SELECT 1 FROM tasks WHERE kind = 'render' AND status = 'running' LIMIT 1`)) return [];
  const recovered = await recoverBrainLeases();
  const deadline = Date.now() + (opts.budgetMs ?? 25_000);
  const brands = await q<{ brand_id: string }>(
    `SELECT brand_id FROM drive_sources WHERE status IN ('active','reauth_required') AND folder_id IS NOT NULL AND ($1::uuid IS NULL OR brand_id = $1) ORDER BY updated_at`,
    [opts.brandId ?? null],
  );
  const out: BrainTick[] = [];
  for (const { brand_id } of brands) {
    if (await isBrainPaused(brand_id)) continue;
    const t: BrainTick = { brandId: brand_id, sync: await syncDocuments(brand_id), processed: [], embedded: 0, embedNote: null, recovered };
    const source = await q1<{ status: string }>(`SELECT status FROM drive_sources WHERE brand_id = $1`, [brand_id]);
    // Yetki yenilenene kadar içerik indirilemez (eşitleme ve kaldırma işlemleri yine çalışır)
    if (source?.status !== "reauth_required") {
      for (let i = 0; i < (opts.docs ?? 8) && Date.now() < deadline; i++) {
        const r = await processNextDocument(brand_id, workerId);
        if (!r) break;
        t.processed.push(r);
        if (r.stopBrand) break;
      }
    }
    if (Date.now() < deadline) {
      const e = await embedPending(brand_id);
      t.embedded = e.embedded;
      t.embedNote = e.note;
    }
    out.push(t);
    if (Date.now() >= deadline) break;
  }
  return out;
}

/** Gömme kuyruğu tahmini: gömülmemiş, ajanlara verilebilir parçaların belirteç toplamı ve tahmini maliyet. */
export async function embeddingBacklog(brandId: string | null, db: Queryable = getPool()) {
  const r = await q1<{ n: number; tokens: string | null }>(
    `SELECT count(*)::int AS n, SUM(token_estimate) AS tokens FROM kb_chunks c
     WHERE ($1::uuid IS NULL OR c.brand_id = $1) AND c.embedding IS NULL AND c.sensitivity <> 'private' AND NOT ('possible_prompt_injection' = ANY(c.flags))`,
    [brandId],
    db,
  );
  const { embedder } = getEmbedder();
  const tokens = Number(r?.tokens ?? 0);
  return { chunks: r?.n ?? 0, tokens, estimateUsd: embedder ? embeddingCostUsd(embedder, tokens) : null, model: embedder?.model ?? null };
}

async function poolSpend(pool: "initial" | "incremental", scope: "today" | "all") {
  const r = await q1<{ s: string | null }>(
    `SELECT SUM(amount_usd) AS s FROM cost_entries WHERE service = $1 AND kind = 'actual' AND units->>'pool' = $2 ${scope === "today" ? "AND created_at >= date_trunc('day', now())" : ""}`,
    [BRAIN_SERVICES.embeddings, pool],
  );
  return Number(r?.s ?? 0);
}

/**
 * Bütçeli gömme. Ücretli işlem ancak: sahip gömmeyi açtıysa, sağlayıcı yapılandırıldıysa, birim fiyat biliniyorsa ve
 * bütçe uygunsa yapılır. Kuyruk günlük artımlı sınırdan büyükse bu bir "büyük toplu işlem"dir ve yalnızca sahibin
 * onayladığı ilk toplu tutar (initialIngestionUsd) kadar harcanır. "private" ve enjeksiyon şüpheli parçalar gömülmez.
 */
export async function embedPending(brandId: string, maxChunks = 128): Promise<{ embedded: number; note: string | null; costUsd: number }> {
  const cfg = await getBrainConfig();
  if (!cfg.embeddingsEnabled) return { embedded: 0, note: "Gömme kapalı (sahip onayı yok).", costUsd: 0 };
  const { embedder, reason } = getEmbedder();
  if (!embedder) return { embedded: 0, note: reason, costUsd: 0 };
  if (embedder.pricePerMTokUsd === null) return { embedded: 0, note: `${embedder.model} birim fiyatı bilinmiyor; ücretli gömme engellendi.`, costUsd: 0 };
  const backlog = await embeddingBacklog(brandId);
  if (!backlog.chunks) return { embedded: 0, note: null, costUsd: 0 };
  const pool: "initial" | "incremental" = (backlog.estimateUsd ?? 0) > cfg.budgets.dailyIncrementalUsd ? "initial" : "incremental";
  const poolLeft = pool === "initial"
    ? cfg.budgets.initialIngestionUsd - (await poolSpend("initial", "all"))
    : cfg.budgets.dailyIncrementalUsd - (await poolSpend("incremental", "today"));
  const dayLeft = cfg.budgets.embeddingsDailyUsd - ((await poolSpend("initial", "today")) + (await poolSpend("incremental", "today")));
  const allowance = Math.min(poolLeft, dayLeft);
  if (allowance <= 0) {
    return { embedded: 0, costUsd: 0, note: pool === "initial"
      ? `Büyük toplu gömme sahip onayı bekliyor: ${backlog.chunks} parça, tahmini $${(backlog.estimateUsd ?? 0).toFixed(4)} (onaylı kalan $${Math.max(0, poolLeft).toFixed(4)}).`
      : "Bugünkü gömme bütçesi doldu; yarın devam eder." };
  }
  const rows = await q<{ id: string; text: string; token_estimate: number }>(
    `SELECT id, text, token_estimate FROM kb_chunks WHERE brand_id = $1 AND embedding IS NULL AND sensitivity <> 'private' AND NOT ('possible_prompt_injection' = ANY(flags))
     ORDER BY created_at LIMIT $2`,
    [brandId, maxChunks],
  );
  const batch: typeof rows = [];
  let tokens = 0;
  for (const r of rows) {
    const next = embeddingCostUsd(embedder, tokens + r.token_estimate) ?? Infinity;
    if (next > allowance) break;
    batch.push(r);
    tokens += r.token_estimate;
  }
  if (!batch.length) return { embedded: 0, costUsd: 0, note: "Kalan bütçe bir parçayı gömmeye yetmiyor." };
  const estimate = embeddingCostUsd(embedder, tokens)!;
  try {
    await assertBudget({ taskId: null, estimateUsd: estimate, service: BRAIN_SERVICES.embeddings });
  } catch (err) {
    if (err instanceof BudgetExceededError) return { embedded: 0, costUsd: 0, note: `Genel bütçe sınırı: ${err.message}` };
    throw err;
  }
  let res: { vectors: number[][]; tokens: number };
  try {
    res = await embedder.embed(batch.map((b) => b.text), "document");
  } catch (err) {
    log("warn", "brain.embed_failed", { brandId, chunks: batch.length, error: err });
    return { embedded: 0, costUsd: 0, note: `Gömme sağlayıcısı hatası: ${(err as Error).message.slice(0, 160)}` };
  }
  const actual = embeddingCostUsd(embedder, res.tokens || tokens);
  await recordCost({ brandId, service: BRAIN_SERVICES.embeddings, kind: "actual", amountUsd: actual, units: { pool, tokens: res.tokens || tokens, chunks: batch.length, model: embedder.model }, note: "Brand Brain gömme (yayımlanmış birim fiyat; fatura ile doğrulanmadı)" });
  for (const [i, b] of batch.entries()) {
    const v = res.vectors[i];
    if (!v || v.length !== EMBEDDING_DIMS) continue;
    await q(`UPDATE kb_chunks SET embedding = $2::real[], embedding_model = $3, embedding_dims = $4, embedded_at = now() WHERE id = $1`, [b.id, v, `${embedder.provider}:${embedder.model}`, v.length]);
  }
  return { embedded: batch.length, note: null, costUsd: actual ?? 0 };
}
