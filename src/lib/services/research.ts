import { createHash } from "node:crypto";
import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { getLimits } from "@/lib/settings";
import { assertBudget, BudgetExceededError, recordCost } from "@/lib/services/costs";
import { audit } from "@/lib/audit";
import { redact } from "@/lib/security/crypto";
import {
  assertPublicUrl, creditsToUsd, estimateCredits, firecrawlConfigured, firecrawlScrape, firecrawlSearch, type ResearchResult,
} from "@/lib/adapters/firecrawl";

// Araştırma Merkezi. Web araştırması yalnızca SAHİP tarafından başlatılır (ajanların web çağrısı yetkisi yoktur).
// Kapılar (hepsi geçilmeden ücretli çağrı yapılmaz):
//   1) FIRECRAWL_API_KEY sunucuda tanımlı,  2) Ayarlar → web araştırması açık,
//   3) aylık kredi sınırı,  4) bütçe kontrolü (günlük / sağlayıcı aylık; birim fiyat bilinmiyorsa engellenebilir).
// Sonuçlar "doğrulanmamış" saklanır; ajanlar yalnızca sahibin doğruladığı kaynakları, güvenilmeyen veri olarak görür.

export type ResearchRun = {
  id: string;
  brand_id: string;
  project_id: string | null;
  mode: "search" | "scrape";
  query: string;
  provider: string;
  status: "pending" | "completed" | "failed" | "blocked";
  credits_estimated: number | null;
  credits_used: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type ResearchSource = {
  id: string;
  run_id: string;
  brand_id: string;
  url: string;
  title: string | null;
  excerpt: string | null;
  verification: "unverified" | "verified" | "rejected";
  created_at: string;
};

export class ResearchBlockedError extends Error {}

type Runner = (mode: "search" | "scrape", query: string, limit: number) => Promise<ResearchResult>;
const defaultRunner: Runner = (mode, query, limit) => (mode === "scrape" ? firecrawlScrape(query) : firecrawlSearch(query, { limit }));

/** Araştırmanın neden kullanılamadığı (null = kullanılabilir). Arayüz ve servis aynı kontrolü kullanır. */
export async function researchBlockedReason(db: Queryable = getPool()): Promise<string | null> {
  if (!firecrawlConfigured()) return "Firecrawl hesabı ve API anahtarı gerekli (sunucu ortamında FIRECRAWL_API_KEY). Bağlanmadı.";
  const limits = await getLimits(db);
  if (!limits.webResearch) return "Web araştırması Ayarlar'da kapalı (ücretli; sahip izni gerekir).";
  return null;
}

export async function monthlyResearchCredits(db: Queryable = getPool()) {
  const row = await q1<{ n: number }>(
    `SELECT COALESCE(SUM(COALESCE(credits_used, credits_estimated, 0)), 0)::int AS n FROM research_runs
     WHERE status IN ('pending','completed') AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [],
    db,
  );
  return row?.n ?? 0;
}

export async function runResearch(
  brandId: string,
  input: { mode: "search" | "scrape"; query: string; limit?: number; projectId?: string | null; idempotencyKey?: string | null },
  opts: { runner?: Runner; db?: Queryable } = {},
): Promise<{ run: ResearchRun; sources: ResearchSource[]; reused: boolean }> {
  const db = opts.db ?? getPool();
  const mode = input.mode === "scrape" ? "scrape" : "search";
  let query = input.query.trim();
  if (!query) throw new ResearchBlockedError("Arama metni veya adres gerekli.");
  if (query.length > 2000) throw new ResearchBlockedError("Metin çok uzun (en fazla 2000 karakter).");
  if (mode === "scrape") query = assertPublicUrl(query);
  const limit = Math.max(1, Math.min(10, input.limit ?? 5));

  // Aynı istek tekrar gönderilirse (çift tıklama, yeniden deneme) yeni ücretli çağrı yapılmaz.
  if (input.idempotencyKey) {
    const existing = await q1<ResearchRun>(`SELECT * FROM research_runs WHERE brand_id = $1 AND idempotency_key = $2`, [brandId, input.idempotencyKey], db);
    if (existing) return { run: existing, sources: await listSources(brandId, existing.id, db), reused: true };
  }

  const estimate = estimateCredits(mode, limit);
  const insertRun = async (status: ResearchRun["status"], error: string | null) =>
    (await q1<ResearchRun>(
      `INSERT INTO research_runs (brand_id, project_id, mode, query, provider, status, credits_estimated, error, idempotency_key, finished_at)
       VALUES ($1,$2,$3,$4,'firecrawl',$5,$6,$7,$8, CASE WHEN $5 <> 'pending' THEN now() END)
       ON CONFLICT (brand_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`,
      [brandId, input.projectId ?? null, mode, query, status, estimate, error, input.idempotencyKey ?? null],
      db,
    ));

  let blocked = await researchBlockedReason(db);
  if (!blocked) {
    const limits = await getLimits(db);
    const used = await monthlyResearchCredits(db);
    if (used + estimate > limits.researchMonthlyCredits) blocked = `Aylık araştırma kredisi sınırı aşılacak: bu ay ${used} + tahmini ${estimate} > sınır ${limits.researchMonthlyCredits}.`;
  }
  if (!blocked) {
    try {
      await assertBudget({ taskId: null, estimateUsd: creditsToUsd(estimate), service: "firecrawl" }, db);
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      blocked = `${err.message}${creditsToUsd(estimate) === null ? " (FIRECRAWL_CREDIT_USD tanımlayın)" : ""}`;
    }
  }
  if (blocked) {
    const run = await insertRun("blocked", blocked);
    await audit({ brandId, actor: "user", action: "research.blocked", message: `Araştırma engellendi: ${blocked}` }, db);
    if (run) return { run, sources: [], reused: false };
    throw new ResearchBlockedError(blocked);
  }

  const run = await insertRun("pending", null);
  if (!run) {
    const existing = await q1<ResearchRun>(`SELECT * FROM research_runs WHERE brand_id = $1 AND idempotency_key = $2`, [brandId, input.idempotencyKey], db);
    return { run: existing!, sources: await listSources(brandId, existing!.id, db), reused: true };
  }
  await recordCost({ brandId, service: "firecrawl", kind: "estimated", amountUsd: creditsToUsd(estimate), units: { credits: estimate }, note: `araştırma (${mode}) üst sınır tahmini` }, db);

  let result: ResearchResult;
  try {
    result = await (opts.runner ?? defaultRunner)(mode, query, limit);
  } catch (err) {
    const msg = redact((err as Error).message).slice(0, 500);
    const failed = (await q1<ResearchRun>(`UPDATE research_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 RETURNING *`, [run.id, msg], db))!;
    await audit({ brandId, actor: "user", action: "research.failed", message: `Araştırma başarısız: ${msg}` }, db);
    return { run: failed, sources: [], reused: false };
  }

  const sources: ResearchSource[] = [];
  for (const h of result.hits) {
    const hash = createHash("sha256").update(`${h.url}\n${h.excerpt ?? ""}`).digest("hex");
    const s = await q1<ResearchSource>(
      `INSERT INTO research_sources (run_id, brand_id, url, title, excerpt, content_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [run.id, brandId, h.url, h.title, h.excerpt, hash],
      db,
    );
    sources.push(s!);
  }
  const credits = result.creditsUsed ?? estimate;
  const done = (await q1<ResearchRun>(`UPDATE research_runs SET status = 'completed', credits_used = $2, finished_at = now() WHERE id = $1 RETURNING *`, [run.id, credits], db))!;
  await recordCost({ brandId, service: "firecrawl", kind: "actual", amountUsd: creditsToUsd(credits), units: { credits, reported: result.creditsUsed !== null }, note: `araştırma (${mode}): ${sources.length} kaynak` }, db);
  await audit({ brandId, actor: "user", action: "research.completed", message: `Araştırma tamamlandı (${mode}): ${sources.length} kaynak, ${credits} kredi. Kaynaklar doğrulanmamış.` }, db);
  return { run: done, sources, reused: false };
}

export async function listRuns(brandId: string, db: Queryable = getPool()) {
  return q<ResearchRun>(`SELECT * FROM research_runs WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 50`, [brandId], db);
}

export async function listSources(brandId: string, runId?: string, db: Queryable = getPool()) {
  return q<ResearchSource>(
    `SELECT * FROM research_sources WHERE brand_id = $1 AND ($2::uuid IS NULL OR run_id = $2) ORDER BY created_at DESC LIMIT 200`,
    [brandId, runId ?? null],
    db,
  );
}

export async function setSourceVerification(brandId: string, sourceId: string, verification: ResearchSource["verification"], db: Queryable = getPool()) {
  const row = await q1<ResearchSource>(`UPDATE research_sources SET verification = $3 WHERE id = $1 AND brand_id = $2 RETURNING *`, [sourceId, brandId, verification], db);
  if (!row) throw new ResearchBlockedError("Kaynak bulunamadı.");
  return row;
}

/** Ajan bağlamı: yalnızca sahibin doğruladığı kaynaklar (en fazla 10, alıntı ≤ 800 karakter). */
export async function verifiedResearchFor(brandId: string, db: Queryable = getPool()) {
  const rows = await q<Pick<ResearchSource, "url" | "title" | "excerpt">>(
    `SELECT url, title, excerpt FROM research_sources WHERE brand_id = $1 AND verification = 'verified' ORDER BY created_at ASC, id ASC LIMIT 10`,
    [brandId],
    db,
  );
  return rows.map((r) => ({ url: r.url, title: r.title ?? "", excerpt: (r.excerpt ?? "").slice(0, 800) }));
}
