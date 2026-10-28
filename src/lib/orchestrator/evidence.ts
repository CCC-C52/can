import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { deriveStage, type Evidence } from "./verification";

// Görev kanıtlarını veritabanından okur (salt okunur). Aşama hesabı verification.ts'deki saf kurallarla yapılır.

export async function taskEvidence(brandId: string, t: { id: string; output_id: string | null }, db: Queryable = getPool()): Promise<Evidence> {
  const [versions, videos, jobs, actions] = await Promise.all([
    t.output_id ? q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM output_versions WHERE output_id = $1 AND brand_id = $2`, [t.output_id, brandId], db) : Promise.resolve({ n: 0 }),
    q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM media_assets WHERE brand_id = $1 AND source_task_id = $2 AND kind = 'video' AND size_bytes > 0`, [brandId, t.id], db),
    q<{ status: string }>(`SELECT status FROM provider_jobs WHERE task_id = $1`, [t.id], db).catch(() => []),
    t.output_id
      ? q<{ status: string; external_id: string | null }>(
          `SELECT a.status, COALESCE(a.response->>'mediaId', a.response->>'id') AS external_id FROM external_actions a JOIN output_versions v ON v.id = a.output_version_id
           WHERE v.output_id = $1 AND a.brand_id = $2`, [t.output_id, brandId], db)
      : Promise.resolve([]),
  ]);
  const verifiedVideos = videos?.n ?? 0;
  return {
    savedVersions: versions?.n ?? 0,
    verifiedVideos,
    missingVideoDeliverables: verifiedVideos > 0 ? [] : ["oynatılabilir video dosyası yok"],
    providerJobs: jobs,
    externalActions: actions.map((a) => ({ status: a.status, externalId: a.external_id })),
    verifiedSources: 0,
  };
}

export async function taskStage(brandId: string, t: { id: string; output_id: string | null; status: string; kind: string; agent: string; requires_capability?: string | null; started_at?: string | null }, db: Queryable = getPool()) {
  return deriveStage(t, await taskEvidence(brandId, t, db));
}
