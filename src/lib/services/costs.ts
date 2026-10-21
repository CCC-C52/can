import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { getLimits } from "@/lib/settings";

export class BudgetExceededError extends Error {}

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

export async function taskSpend(taskId: string, db: Queryable = getPool()) {
  const row = await q1<{ actual: number }>(
    `SELECT COALESCE(SUM(amount_usd), 0) AS actual FROM cost_entries WHERE task_id = $1 AND kind = 'actual'`,
    [taskId],
    db,
  );
  return Number(row?.actual ?? 0);
}

/**
 * Ücretli çağrıdan ÖNCE çalışır. Tahmin sınırı aşıyorsa veya tahmin yapılamıyorsa (ve ayar gerektiriyorsa) engeller.
 * Ücretsiz (demo/yerel) işlemler için estimate = 0 verilir ve engellenmez.
 */
export async function assertBudget(args: { taskId: string | null; estimateUsd: number | null; service: string }, db: Queryable = getPool()) {
  const limits = await getLimits(db);
  if (args.estimateUsd === 0) return;
  if (args.estimateUsd === null) {
    if (limits.blockUnknownCost && (limits.perTaskBudgetUsd !== null || limits.dailyBudgetUsd !== null)) {
      throw new BudgetExceededError(`${args.service} için maliyet tahmin edilemiyor; harcama sınırı etkin olduğu için işlem durduruldu.`);
    }
    return;
  }
  if (limits.perTaskBudgetUsd !== null && args.taskId) {
    const spent = await taskSpend(args.taskId, db);
    if (spent + args.estimateUsd > limits.perTaskBudgetUsd) {
      throw new BudgetExceededError(`Görev bütçesi aşılacak: harcanan $${spent.toFixed(4)} + tahmini $${args.estimateUsd.toFixed(4)} > sınır $${limits.perTaskBudgetUsd}`);
    }
  }
  if (limits.dailyBudgetUsd !== null) {
    const today = await todaysAiSpend(db);
    if (today.actual + args.estimateUsd > limits.dailyBudgetUsd) {
      throw new BudgetExceededError(`Günlük bütçe aşılacak: bugün $${today.actual.toFixed(4)} + tahmini $${args.estimateUsd.toFixed(4)} > sınır $${limits.dailyBudgetUsd}`);
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
