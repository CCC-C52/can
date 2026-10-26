import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { firecrawlConfigured } from "@/lib/adapters/firecrawl";
import { researchBlockedReason } from "@/lib/services/research";
import { effectiveStatus } from "@/lib/services/connections";
import {
  CONNECTORS, WORKSTREAMS, classifyFreshness, collectionsFor, dedupeEvidence, scoreRelevance, workstreamAvailability,
  type Availability, type ConnectorId, type Evidence, type Freshness, type Verification,
} from "@/lib/pr-agency/model";

// FriBee PR Ajansı — salt okunur genel bakış ve kanıt listesi.
// Yalnızca mevcut, marka kapsamlı tablolar okunur (research_runs, research_sources, projects, outputs).
// Bu servis dış çağrı yapmaz, ücretli işlem başlatmaz ve hiçbir kaydı değiştirmez.

export type ConnectorStatus = { id: ConnectorId; name: string; availability: Availability; detail: string; cadence: string; policy: string };

export async function connectorStatuses(brandId: string, db: Queryable = getPool()): Promise<ConnectorStatus[]> {
  const research = await researchBlockedReason(db);
  const shopify = await effectiveStatus("shopify", brandId);
  return CONNECTORS.map((c) => {
    let availability: Availability = "not_built";
    let detail = "Bu sürümde bağlayıcı yok.";
    if (c.id === "research_firecrawl") {
      availability = research === null ? "available" : firecrawlConfigured() ? "blocked" : "needs_credentials";
      detail = research ?? "Anahtar tanımlı ve web araştırması açık (elle başlatılır).";
    } else if (c.id === "shopify_catalog") {
      availability = shopify.status === "connected" ? "available" : shopify.status === "not_connected" ? "needs_credentials" : "blocked";
      detail = shopify.status === "connected" ? "Bağlı (yalnızca okuma kullanılır)." : (shopify.detail ?? shopify.status);
    }
    return { id: c.id, name: c.name, availability, detail, cadence: c.cadence, policy: c.policy };
  });
}

type SourceRow = { id: string; url: string; title: string | null; excerpt: string | null; verification: Verification; created_at: string | Date };
const toEvidence = (r: SourceRow): Evidence => ({
  id: r.id, url: r.url, title: r.title, excerpt: r.excerpt, verification: r.verification,
  retrievedAt: new Date(r.created_at).toISOString(), connector: "research_firecrawl",
});

export type PrOverview = Awaited<ReturnType<typeof prAgencyOverview>>;

export async function prAgencyOverview(brand: { id: string; name: string; slug: string }, opts: { db?: Queryable; now?: Date } = {}) {
  const db = opts.db ?? getPool();
  const now = opts.now ?? new Date();
  const [connectors, stats, lastRun, work, verifiedRows] = await Promise.all([
    connectorStatuses(brand.id, db),
    q1<{ total: number; verified: number; unverified: number; rejected: number; last_verified_at: string | null; last_retrieved_at: string | null }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE verification = 'verified')::int AS verified,
              COUNT(*) FILTER (WHERE verification = 'unverified')::int AS unverified,
              COUNT(*) FILTER (WHERE verification = 'rejected')::int AS rejected,
              MAX(created_at) FILTER (WHERE verification = 'verified') AS last_verified_at,
              MAX(created_at) AS last_retrieved_at
       FROM research_sources WHERE brand_id = $1`,
      [brand.id],
      db,
    ),
    q1<{ status: string; created_at: string; finished_at: string | null; error: string | null }>(
      `SELECT status, created_at, finished_at, error FROM research_runs WHERE brand_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [brand.id],
      db,
    ),
    q1<{ active_projects: number; outputs: number }>(
      `SELECT (SELECT COUNT(*)::int FROM projects WHERE brand_id = $1 AND status IN ('planning','running','needs_attention')) AS active_projects,
              (SELECT COUNT(*)::int FROM outputs WHERE brand_id = $1) AS outputs`,
      [brand.id],
      db,
    ),
    q<SourceRow>(
      `SELECT id, url, title, excerpt, verification, created_at FROM research_sources
       WHERE brand_id = $1 AND verification = 'verified' ORDER BY created_at DESC, id DESC LIMIT 50`,
      [brand.id],
      db,
    ),
  ]);
  const byId = Object.fromEntries(connectors.map((c) => [c.id, c.availability])) as Record<ConnectorId, Availability>;
  const collections = collectionsFor(brand);
  const verified = dedupeEvidence(verifiedRows.map(toEvidence));
  const toIso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);
  const freshness: Freshness = classifyFreshness(stats?.last_verified_at ?? null, { now, lastRunStatus: lastRun?.status ?? null });
  return {
    brand: { id: brand.id, name: brand.name },
    generatedAt: now.toISOString(),
    collections,
    connectors,
    evidence: {
      total: stats?.total ?? 0,
      verified: stats?.verified ?? 0,
      unverified: stats?.unverified ?? 0,
      rejected: stats?.rejected ?? 0,
      lastVerifiedAt: toIso(stats?.last_verified_at),
      lastRetrievedAt: toIso(stats?.last_retrieved_at),
      freshness,
    },
    lastRun: lastRun ? { status: lastRun.status, createdAt: toIso(lastRun.created_at)!, finishedAt: toIso(lastRun.finished_at), error: lastRun.error ? lastRun.error.slice(0, 200) : null } : null,
    work: { activeProjects: work?.active_projects ?? 0, outputs: work?.outputs ?? 0 },
    relevance: scoreRelevance(verified.items, collections),
    workstreams: WORKSTREAMS.map((ws) => ({ ...ws, ...workstreamAvailability(ws, byId) })),
  };
}

export const EVIDENCE_PAGE_MAX = 50;

/** Marka kapsamlı, sayfalı kanıt listesi. Aynı sayfadaki tekrar eden adresler tek kayda indirilir ve sayısı raporlanır. */
export async function listPrEvidence(
  brandId: string,
  opts: { page?: number; pageSize?: number; verification?: Verification | null } = {},
  db: Queryable = getPool(),
) {
  const pageSize = Math.max(1, Math.min(EVIDENCE_PAGE_MAX, Math.trunc(opts.pageSize ?? 20) || 20));
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const verification = opts.verification && ["verified", "unverified", "rejected"].includes(opts.verification) ? opts.verification : null;
  const [rows, count] = await Promise.all([
    q<SourceRow>(
      `SELECT id, url, title, excerpt, verification, created_at FROM research_sources
       WHERE brand_id = $1 AND ($2::text IS NULL OR verification = $2)
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [brandId, verification, pageSize, (page - 1) * pageSize],
      db,
    ),
    q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM research_sources WHERE brand_id = $1 AND ($2::text IS NULL OR verification = $2)`, [brandId, verification], db),
  ]);
  const { items, duplicates } = dedupeEvidence(rows.map(toEvidence));
  const total = count?.n ?? 0;
  return { items, duplicatesHidden: duplicates, page, pageSize, total, hasMore: page * pageSize < total };
}
