import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { getSetting, setSetting, getLimits } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { getMedia } from "@/lib/services/media";
import { THEME_INFO, FRIBEE_THEMES, type FribeeTheme } from "@/lib/drive/themes";

// Ana ekran (FriBee HQ) verileri. Yalnızca veritabanındaki gerçek kayıtlar okunur; kaynağı olmayan metrik üretilmez.

export type HeroAsset = { id: string; filename: string; source: "owner" | "verified_reference" | "owned_photo"; theme: string | null };

const heroKey = (brandId: string) => `hq:hero:${brandId}`;

/**
 * Kapak görseli: sahibin seçtiği; yoksa doğrulanmış ürün referansı (orijinali içe alınmış); yoksa marka sahibi/lisanslı
 * gerçek fotoğraf. AI üretimi, logo veya doğrulanmamış görsel KULLANILMAZ.
 */
export async function heroAsset(brandId: string, db: Queryable = getPool()): Promise<HeroAsset | null> {
  const chosen = await getSetting<string | null>(heroKey(brandId), null, db);
  if (chosen) {
    const m = await getMedia(brandId, chosen, db);
    if (m && m.kind === "photo" && m.origin !== "ai_generated") return { id: m.id, filename: m.filename, source: "owner", theme: null };
  }
  const ref = await q1<{ id: string; filename: string; theme: string | null }>(
    `SELECT m.id, m.filename, r.theme FROM drive_references r JOIN media_assets m ON m.id = r.media_asset_id AND m.brand_id = r.brand_id
     WHERE r.brand_id = $1 AND r.status = 'verified' AND m.kind = 'photo' AND m.mime_type IN ('image/jpeg','image/png','image/webp')
     ORDER BY (r.view = 'front') DESC, COALESCE(m.width, 0) DESC, r.verified_at DESC LIMIT 1`,
    [brandId],
    db,
  );
  if (ref) return { ...ref, source: "verified_reference" };
  const own = await q1<{ id: string; filename: string }>(
    `SELECT id, filename FROM media_assets WHERE brand_id = $1 AND kind = 'photo' AND origin = 'real_photo' AND rights_status IN ('owned','licensed')
       AND mime_type IN ('image/jpeg','image/png','image/webp') ORDER BY COALESCE(width, 0) DESC, created_at DESC LIMIT 1`,
    [brandId],
    db,
  );
  return own ? { ...own, source: "owned_photo", theme: null } : null;
}

export async function setHeroAsset(brandId: string, mediaId: string | null) {
  if (mediaId) {
    const m = await getMedia(brandId, mediaId);
    if (!m || m.kind !== "photo") throw new Error("Kapak için marka arşivinden bir fotoğraf seçin.");
    if (m.origin === "ai_generated") throw new Error("AI ile üretilmiş görsel kapak olarak kullanılamaz.");
  }
  await setSetting(heroKey(brandId), mediaId);
  await audit({ brandId, actor: "user", action: "hq.hero", message: mediaId ? "Ana ekran kapak görseli seçildi" : "Ana ekran kapak görseli otomatiğe alındı" });
}

/** Koleksiyonlar: doğrulanmış ürün referansları ve onaylı koleksiyon bilgisi. */
export async function collectionsOverview(brandId: string, db: Queryable = getPool()) {
  const [refs, facts, products] = await Promise.all([
    q<{ theme: FribeeTheme; verified: number; imported: number; sample_id: string | null }>(
      `SELECT theme, COUNT(*)::int AS verified, COUNT(media_asset_id)::int AS imported,
              (ARRAY_AGG(media_asset_id ORDER BY (view = 'front') DESC, verified_at DESC) FILTER (WHERE media_asset_id IS NOT NULL))[1] AS sample_id
       FROM drive_references WHERE brand_id = $1 AND status = 'verified' AND theme IS NOT NULL GROUP BY theme`,
      [brandId],
      db,
    ),
    q<{ entity_name: string; value: string }>(`SELECT entity_name, value FROM knowledge_facts WHERE brand_id = $1 AND entity_type = 'collection' AND attribute = 'theme_color' AND status = 'confirmed' ORDER BY entity_name`, [brandId], db),
    q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM products WHERE brand_id = $1 AND is_sample = false AND status <> 'archived'`, [brandId], db),
  ]);
  const byTheme = new Map(refs.map((r) => [r.theme, r]));
  const confirmed = new Map(facts.map((f) => [f.entity_name.toLowerCase(), f.value]));
  const themes = FRIBEE_THEMES.map((t) => {
    const r = byTheme.get(t);
    const info = THEME_INFO[t];
    return { theme: t, label: info.label, garment: info.garmentLabel, confirmedColor: confirmed.get(info.label.toLowerCase()) ?? null, verified: r?.verified ?? 0, imported: r?.imported ?? 0, sampleId: r?.sample_id ?? null };
  });
  return { themes, confirmedCount: facts.length, products: products?.n ?? 0, anyVerified: refs.length > 0 };
}

export async function dashboardData(brandId: string, db: Queryable = getPool()) {
  const [tasks, approvals, outputs30, media, agents, campaigns, activity, budget, limits, worker, opsRuns] = await Promise.all([
    q1<{ running: number; queued: number; waiting: number; failed7: number; done7: number }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'running')::int AS running,
              COUNT(*) FILTER (WHERE status IN ('ready','planned','review_pending'))::int AS queued,
              COUNT(*) FILTER (WHERE status = 'waiting_connection')::int AS waiting,
              COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '7 days')::int AS failed7,
              COUNT(*) FILTER (WHERE status = 'completed' AND updated_at > now() - interval '7 days')::int AS done7
       FROM tasks WHERE brand_id = $1`, [brandId], db),
    q1<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM outputs o JOIN output_versions v ON v.output_id = o.id AND v.version = o.current_version
       WHERE o.brand_id = $1 AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.output_version_id = v.id AND a.revoked_at IS NULL)`, [brandId], db),
    q1<{ total: number; video: number; pr: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE kind IN ('video_plan'))::int AS video, COUNT(*) FILTER (WHERE agent = 'pr_agency' OR kind LIKE 'pr_%')::int AS pr
       FROM outputs WHERE brand_id = $1 AND created_at > now() - interval '30 days'`, [brandId], db),
    q1<{ photos: number; videos: number; new30: number; ai: number; refs: number; pending_refs: number }>(
      `SELECT COUNT(*) FILTER (WHERE kind = 'photo')::int AS photos, COUNT(*) FILTER (WHERE kind = 'video')::int AS videos,
              COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new30,
              COUNT(*) FILTER (WHERE origin = 'ai_generated')::int AS ai,
              (SELECT COUNT(*)::int FROM drive_references WHERE brand_id = $1 AND status = 'verified') AS refs,
              (SELECT COUNT(*)::int FROM drive_references WHERE brand_id = $1 AND status = 'uncertain') AS pending_refs
       FROM media_assets WHERE brand_id = $1`, [brandId], db),
    q<{ agent: string; active: number; done7: number }>(
      `SELECT agent, COUNT(*) FILTER (WHERE status IN ('running','ready','review_pending'))::int AS active,
              COUNT(*) FILTER (WHERE status = 'completed' AND updated_at > now() - interval '7 days')::int AS done7
       FROM tasks WHERE brand_id = $1 AND updated_at > now() - interval '30 days' GROUP BY agent ORDER BY active DESC, done7 DESC`, [brandId], db),
    q<{ id: string; title: string; status: string; created_at: string; tasks: number; done: number }>(
      `SELECT p.id, p.title, p.status, p.created_at,
              (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id) AS tasks,
              (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS done
       FROM projects p WHERE p.brand_id = $1 ORDER BY p.created_at DESC LIMIT 5`, [brandId], db),
    q<{ id: string; actor: string; action: string; message: string; created_at: string }>(
      `SELECT id::text, actor, action, message, created_at FROM audit_log WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 8`, [brandId], db),
    q1<{ today: string | null; month: string | null; unknown: number }>(
      `SELECT SUM(amount_usd) FILTER (WHERE kind = 'actual' AND created_at >= date_trunc('day', now())) AS today,
              SUM(amount_usd) FILTER (WHERE kind = 'actual' AND created_at > now() - interval '30 days') AS month,
              COUNT(*) FILTER (WHERE amount_usd IS NULL AND created_at > now() - interval '30 days')::int AS unknown
       FROM cost_entries WHERE brand_id = $1`, [brandId], db),
    getLimits(db),
    q1<{ last_seen: string }>(`SELECT last_seen FROM worker_heartbeats ORDER BY last_seen DESC LIMIT 1`, [], db),
    q1<{ completed: number; failed: number; last: string | null }>(
      `SELECT COUNT(*) FILTER (WHERE stage = 'completed')::int AS completed, COUNT(*) FILTER (WHERE stage = 'failed')::int AS failed, MAX(finished_at) AS last
       FROM pr_operation_runs WHERE brand_id = $1 AND created_at > now() - interval '30 days'`, [brandId], db),
  ]);
  const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return {
    tasks: tasks!, approvals: approvals?.n ?? 0, outputs30: outputs30!, media: media!, agents, campaigns, activity,
    budget: { today: num(budget?.today), month: num(budget?.month), unknown: budget?.unknown ?? 0, dailyLimit: limits.dailyBudgetUsd },
    workerAlive: !!worker && Date.now() - new Date(worker.last_seen).getTime() < 60_000,
    workerLastSeen: worker?.last_seen ?? null,
    ops: { completed: opsRuns?.completed ?? 0, failed: opsRuns?.failed ?? 0, last: opsRuns?.last ?? null },
  };
}
