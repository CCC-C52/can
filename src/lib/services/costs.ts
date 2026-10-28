import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { getLimits } from "@/lib/settings";

export class BudgetExceededError extends Error {}

/** Ücretli sağlayıcılar (cost_entries.service adları) ve paneldeki adları. */
export const COST_PROVIDERS = ["anthropic", "openai_images", "video_generation", "firecrawl"] as const;
export const COST_PROVIDER_LABEL: Record<(typeof COST_PROVIDERS)[number], string> = {
  anthropic: "Anthropic (metin modeli)",
  openai_images: "OpenAI Images (AI görsel)",
  video_generation: "Google Gemini Omni Video (AI video)",
  firecrawl: "Firecrawl (web araştırması)",
};

/** Bu ayın sağlayıcı bazında gerçekleşen harcaması ve önbellek token toplamları. */
export async function monthlyProviderSummary(db: Queryable = getPool()) {
  return q<{ service: string; actual: number | null; unknown_count: number; entries: number; cache_read: number; cache_write: number; input: number }>(
    `SELECT service,
       SUM(amount_usd) AS actual,
       COUNT(*) FILTER (WHERE amount_usd IS NULL)::int AS unknown_count,
       COUNT(*)::int AS entries,
       COALESCE(SUM((units->>'cache_read_input_tokens')::bigint), 0)::bigint AS cache_read,
       COALESCE(SUM((units->>'cache_creation_input_tokens')::bigint), 0)::bigint AS cache_write,
       COALESCE(SUM((units->>'input_tokens')::bigint), 0)::bigint AS input
     FROM cost_entries
     WHERE kind = 'actual' AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     GROUP BY service ORDER BY service`,
    [],
    db,
  );
}

/** Bugünkü (UTC) AI üretim harcaması: gerçekleşen + gerçekleşeni henüz olmayan tahminler. */
export async function todaysAiSpend(db: Queryable = getPool()) {
  const row = await q1<{ actual: number | null; unknown_count: number }>(
    `SELECT COALESCE(SUM(amount_usd), 0) AS actual, COUNT(*) FILTER (WHERE amount_usd IS NULL)::int AS unknown_count
     FROM cost_entries WHERE category = 'ai_generation' AND kind = 'actual' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [],
    db,
  );
  return { actual: Number(row?.actual ?? 0), unknownCount: row?.unknown_count ?? 0 };
}

/** Bu takvim ayındaki (UTC) bir servisin gerçekleşen harcaması. */
export async function monthlyServiceSpend(service: string, db: Queryable = getPool()) {
  const row = await q1<{ actual: number }>(
    `SELECT COALESCE(SUM(amount_usd), 0) AS actual FROM cost_entries
     WHERE service = $1 AND kind = 'actual' AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [service],
    db,
  );
  return Number(row?.actual ?? 0);
}

export async function taskSpend(taskId: string, db: Queryable = getPool()) {
  const row = await q1<{ actual: number }>(
    `SELECT COALESCE(SUM(amount_usd), 0) AS actual FROM cost_entries WHERE task_id = $1 AND kind = 'actual'`,
    [taskId],
    db,
  );
  return Number(row?.actual ?? 0);
}

/**
 * Gönderilmiş ama henüz gerçekleşen maliyeti yazılmamış ücretli sağlayıcı işlerinin tahmini tutarı (taahhüt edilmiş
 * harcama). Aynı render'da art arda gönderilen sahneler bütçe kontrolünde birbirini görür; aksi halde hepsi sınırı geçer.
 */
async function committedSpend(filter: { day?: boolean; month?: boolean; taskId?: string; service?: string; excludeJobId?: string | null }, db: Queryable) {
  const row = await q1<{ s: number }>(
    `SELECT COALESCE(SUM(cost_estimated_usd), 0)::float AS s FROM provider_jobs
     WHERE status IN ('submitting','submitted','running','downloading','unknown') AND cost_actual_usd IS NULL
       AND ($1::uuid IS NULL OR id <> $1)
       AND ($2::boolean IS NOT TRUE OR created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
       AND ($3::boolean IS NOT TRUE OR created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
       AND ($4::uuid IS NULL OR task_id = $4) AND ($5::text IS NULL OR provider = $5)`,
    [filter.excludeJobId ?? null, filter.day ?? null, filter.month ?? null, filter.taskId ?? null, filter.service ?? null],
    db,
  );
  return Number(row?.s ?? 0);
}

/**
 * Ücretli çağrıdan ÖNCE çalışır. Tahmin sınırı aşıyorsa veya tahmin yapılamıyorsa (ve ayar gerektiriyorsa) engeller.
 * Ücretsiz (demo/yerel) işlemler için estimate = 0 verilir ve engellenmez.
 */
export async function assertBudget(args: { taskId: string | null; estimateUsd: number | null; service: string; excludeJobId?: string | null }, db: Queryable = getPool()) {
  const limits = await getLimits(db);
  if (args.estimateUsd === 0) return;
  const providerLimit = limits.providerMonthlyUsd?.[args.service];
  if (args.estimateUsd === null) {
    if (limits.blockUnknownCost && (limits.perTaskBudgetUsd !== null || limits.dailyBudgetUsd !== null || providerLimit !== undefined)) {
      throw new BudgetExceededError(`${args.service} için maliyet tahmin edilemiyor; harcama sınırı etkin olduğu için işlem durduruldu.`);
    }
    return;
  }
  if (limits.perTaskBudgetUsd !== null && args.taskId) {
    const spent = (await taskSpend(args.taskId, db)) + (await committedSpend({ taskId: args.taskId, excludeJobId: args.excludeJobId }, db));
    if (spent + args.estimateUsd > limits.perTaskBudgetUsd) {
      throw new BudgetExceededError(`Görev bütçesi aşılacak: harcanan $${spent.toFixed(4)} + tahmini $${args.estimateUsd.toFixed(4)} > sınır $${limits.perTaskBudgetUsd}`);
    }
  }
  if (providerLimit !== undefined) {
    const month = (await monthlyServiceSpend(args.service, db)) + (await committedSpend({ month: true, service: args.service, excludeJobId: args.excludeJobId }, db));
    if (month + args.estimateUsd > providerLimit) {
      throw new BudgetExceededError(`${args.service} aylık sınırı aşılacak: bu ay $${month.toFixed(4)} + tahmini $${args.estimateUsd.toFixed(4)} > sınır $${providerLimit}`);
    }
  }
  if (limits.dailyBudgetUsd !== null) {
    const today = await todaysAiSpend(db);
    const pending = await committedSpend({ day: true, excludeJobId: args.excludeJobId }, db);
    if (today.actual + pending + args.estimateUsd > limits.dailyBudgetUsd) {
      throw new BudgetExceededError(`Günlük bütçe aşılacak: bugün $${today.actual.toFixed(4)} gerçekleşen + $${pending.toFixed(4)} süren işler + tahmini $${args.estimateUsd.toFixed(4)} > sınır $${limits.dailyBudgetUsd}`);
    }
  }
}

export async function recordCost(
  e: { brandId: string | null; projectId?: string | null; taskId?: string | null; service: string; category?: "ai_generation" | "ad_spend"; kind: "estimated" | "actual"; amountUsd: number | null; units?: unknown; note?: string; analysisId?: string | null; providerJobId?: string | null },
  db: Queryable = getPool(),
) {
  await q(
    `INSERT INTO cost_entries (brand_id, project_id, task_id, service, category, kind, amount_usd, units, note, analysis_id, provider_job_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [e.brandId, e.projectId ?? null, e.taskId ?? null, e.service, e.category ?? "ai_generation", e.kind, e.amountUsd, JSON.stringify(e.units ?? {}), e.note ?? null, e.analysisId ?? null, e.providerJobId ?? null],
    db,
  );
  if (e.taskId) {
    if (e.kind === "estimated") {
      await q(`UPDATE tasks SET cost_estimated_usd = COALESCE(cost_estimated_usd, 0) + COALESCE($2::numeric, 0), cost_unknown = cost_unknown OR $2::numeric IS NULL WHERE id = $1`, [e.taskId, e.amountUsd], db);
    } else {
      await q(`UPDATE tasks SET cost_actual_usd = COALESCE(cost_actual_usd, 0) + COALESCE($2::numeric, 0), cost_unknown = cost_unknown OR $2::numeric IS NULL WHERE id = $1`, [e.taskId, e.amountUsd], db);
    }
  }
}

export type CostRow = { key: string; estimated: number | null; actual: number | null; unknown_count: number; entries: number };

export async function costSummary(brandId: string | null, groupBy: "service" | "task" | "brand" | "day", category: "ai_generation" | "ad_spend" = "ai_generation", db: Queryable = getPool()) {
  const keyExpr =
    groupBy === "service" ? "c.service" :
    groupBy === "task" ? "COALESCE(t.title, 'Görevsiz')" :
    groupBy === "brand" ? "COALESCE(b.name, 'Genel')" :
    "to_char(c.created_at, 'YYYY-MM-DD')";
  return q<CostRow>(
    `SELECT ${keyExpr} AS key,
       SUM(c.amount_usd) FILTER (WHERE c.kind = 'estimated') AS estimated,
       SUM(c.amount_usd) FILTER (WHERE c.kind = 'actual') AS actual,
       COUNT(*) FILTER (WHERE c.amount_usd IS NULL)::int AS unknown_count,
       COUNT(*)::int AS entries
     FROM cost_entries c LEFT JOIN tasks t ON t.id = c.task_id LEFT JOIN brands b ON b.id = c.brand_id
     WHERE c.category = $2 AND ($1::uuid IS NULL OR c.brand_id = $1)
     GROUP BY 1 ORDER BY 1 DESC LIMIT 100`,
    [brandId, category],
    db,
  );
}
