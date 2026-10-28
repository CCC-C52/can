import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { getEmbedder } from "./embeddings";
import { BRAIN_SERVICES, getBrainConfig, isBrainPaused } from "./settings";
import { embeddingBacklog } from "./worker";
import { listConflicts } from "./claims";

// Brand Brain durum ve başlangıç ölçümü (baseline). Her değer veritabanındaki gerçek kayıtlardan veya sağlayıcı
// durumundan okunur; tahmin/uydurma yoktur. Ölçülemeyen değer null döner ve panelde "ölçülmedi" yazar.

const FAMILY_SQL = `CASE
  WHEN mime_type = 'application/vnd.google-apps.document' THEN 'Google Dokümanı'
  WHEN mime_type = 'application/vnd.google-apps.spreadsheet' THEN 'Google E-Tablo'
  WHEN mime_type = 'application/vnd.google-apps.presentation' THEN 'Google Slaytlar'
  WHEN mime_type = 'application/pdf' THEN 'PDF'
  WHEN mime_type LIKE 'application/vnd.openxmlformats-officedocument.wordprocessingml%' THEN 'DOCX'
  WHEN mime_type LIKE 'application/vnd.openxmlformats-officedocument.spreadsheetml%' THEN 'XLSX'
  WHEN mime_type LIKE 'application/vnd.openxmlformats-officedocument.presentationml%' THEN 'PPTX'
  WHEN mime_type IN ('text/plain','text/markdown','text/csv') THEN 'Metin/CSV/Markdown'
  WHEN mime_type LIKE 'image/%' THEN 'Görsel'
  WHEN mime_type LIKE 'video/%' THEN 'Video'
  WHEN mime_type LIKE 'audio/%' THEN 'Ses'
  ELSE 'Diğer' END`;

export async function brainStatus(brandId: string, db: Queryable = getPool()) {
  const [source, archive, families, docs, chunks, reviews, refs, queue, retrievals, costs, ext, errors, unsupported, folders] = await Promise.all([
    q1<{ status: string; folder_name: string | null; account_email: string | null; last_success_at: string | null; last_scan_finished_at: string | null; full_scan_completed_at: string | null; consecutive_failures: number; last_error: string | null }>(
      `SELECT status, folder_name, account_email, last_success_at, last_scan_finished_at, full_scan_completed_at, consecutive_failures, last_error FROM drive_sources WHERE brand_id = $1`, [brandId], db),
    q1<{ files: number; bytes: string | null; removed: number; pending_checksum: number; malformed: number; folders: number }>(
      `SELECT count(*) FILTER (WHERE NOT is_folder AND state <> 'removed')::int AS files,
              SUM(size_bytes) FILTER (WHERE NOT is_folder AND state <> 'removed') AS bytes,
              count(*) FILTER (WHERE NOT is_folder AND state = 'removed')::int AS removed,
              count(*) FILTER (WHERE NOT is_folder AND state = 'pending_checksum')::int AS pending_checksum,
              count(*) FILTER (WHERE NOT is_folder AND state = 'malformed')::int AS malformed,
              count(*) FILTER (WHERE is_folder AND state <> 'removed')::int AS folders
       FROM drive_items WHERE brand_id = $1`, [brandId], db),
    q<{ family: string; files: number; bytes: string | null }>(
      `SELECT ${FAMILY_SQL} AS family, count(*)::int AS files, SUM(size_bytes) AS bytes FROM drive_items WHERE brand_id = $1 AND NOT is_folder AND state <> 'removed' GROUP BY 1 ORDER BY 2 DESC`, [brandId], db),
    q<{ status: string; n: number; dup: number }>(
      `SELECT status, count(*)::int AS n, count(*) FILTER (WHERE duplicate_of IS NOT NULL)::int AS dup FROM kb_documents WHERE brand_id = $1 GROUP BY status`, [brandId], db),
    q1<{ total: number; embedded: number; eligible: number; private: number; flagged: number; chars: string | null }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
              count(*) FILTER (WHERE sensitivity <> 'private' AND NOT ('possible_prompt_injection' = ANY(flags)))::int AS eligible,
              count(*) FILTER (WHERE sensitivity = 'private')::int AS private,
              count(*) FILTER (WHERE 'possible_prompt_injection' = ANY(flags))::int AS flagged,
              SUM(length(text)) AS chars
       FROM kb_chunks WHERE brand_id = $1`, [brandId], db),
    q1<{ extracted: number; suggested: number; confirmed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'extracted')::int AS extracted, count(*) FILTER (WHERE status = 'suggested')::int AS suggested,
              count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed FROM knowledge_facts WHERE brand_id = $1`, [brandId], db),
    q1<{ uncertain: number; verified: number }>(
      `SELECT count(*) FILTER (WHERE status = 'uncertain')::int AS uncertain, count(*) FILTER (WHERE status = 'verified')::int AS verified FROM drive_references WHERE brand_id = $1`, [brandId], db),
    q1<{ due: number; waiting: number; processing: number; next_retry: string | null }>(
      `SELECT count(*) FILTER (WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))::int AS due,
              count(*) FILTER (WHERE status = 'pending' AND next_attempt_at > now())::int AS waiting,
              count(*) FILTER (WHERE status = 'processing')::int AS processing,
              MIN(next_attempt_at) FILTER (WHERE status = 'pending' AND next_attempt_at > now()) AS next_retry
       FROM kb_documents WHERE brand_id = $1`, [brandId], db),
    q1<{ n: number; with_hits: number; avg_ms: number | null; hybrid: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE hits > 0)::int AS with_hits, round(avg(latency_ms))::int AS avg_ms,
              count(*) FILTER (WHERE mode = 'hybrid')::int AS hybrid
       FROM kb_retrievals WHERE brand_id = $1 AND purpose = 'agent' AND created_at > now() - interval '30 days'`, [brandId], db),
    q<{ service: string; today: string | null; month: string | null; total: string | null }>(
      `SELECT service, SUM(amount_usd) FILTER (WHERE created_at >= date_trunc('day', now())) AS today,
              SUM(amount_usd) FILTER (WHERE created_at > now() - interval '30 days') AS month, SUM(amount_usd) AS total
       FROM cost_entries WHERE kind = 'actual' AND service = ANY($1::text[]) AND (brand_id = $2 OR brand_id IS NULL) GROUP BY service`,
      [[BRAIN_SERVICES.embeddings, BRAIN_SERVICES.query], brandId], db),
    q1<{ available: boolean; installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available, EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed`, [], db).catch(() => null),
    q<{ id: string; name: string; path: string | null; status: string; error: string | null; attempts: number; updated_at: string }>(
      `SELECT id, name, path, status, error, attempts, updated_at FROM kb_documents WHERE brand_id = $1 AND status IN ('failed','dead') ORDER BY updated_at DESC LIMIT 50`, [brandId], db),
    q<{ mime_type: string; status: string; limitation: string | null; n: number }>(
      `SELECT mime_type, status, MIN(limitation) AS limitation, count(*)::int AS n FROM kb_documents WHERE brand_id = $1 AND status IN ('unsupported','metadata_only')
       GROUP BY mime_type, status ORDER BY n DESC LIMIT 30`, [brandId], db),
    q<{ top: string; files: number }>(
      `SELECT split_part(COALESCE(path, ''), '/', 2) AS top, count(*)::int AS files FROM drive_items WHERE brand_id = $1 AND NOT is_folder AND state <> 'removed' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, [brandId], db),
  ]);
  const byStatus = Object.fromEntries(docs.map((d) => [d.status, d.n])) as Record<string, number>;
  const duplicates = docs.reduce((a, d) => a + d.dup, 0);
  const cfg = await getBrainConfig(db);
  const { embedder, reason } = getEmbedder();
  const backlog = await embeddingBacklog(brandId, db);
  const conflicts = await listConflicts(brandId, db);
  const num = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
  const contentDocs = (byStatus.indexed ?? 0) - duplicates;
  const tracked = Object.values(byStatus).reduce((a, b) => a + b, 0) - (byStatus.removed ?? 0);
  return {
    drive: source ? { ...source, connected: source.status === "active" } : null,
    paused: await isBrainPaused(brandId, db),
    archive: { files: archive?.files ?? 0, bytes: num(archive?.bytes), folders: archive?.folders ?? 0, removed: archive?.removed ?? 0, pendingChecksum: archive?.pending_checksum ?? 0, malformed: archive?.malformed ?? 0, families, topFolders: folders },
    documents: {
      tracked, byStatus, duplicates, contentExtracted: contentDocs, metadataOnly: byStatus.metadata_only ?? 0, unsupported: byStatus.unsupported ?? 0,
      failed: byStatus.failed ?? 0, dead: byStatus.dead ?? 0, pending: (byStatus.pending ?? 0) + (byStatus.processing ?? 0),
      // Kapsam: dizindeki (silinmemiş) dosyalardan Brand Brain'in işlediği oran
      coverage: archive?.files ? Math.round((((byStatus.indexed ?? 0) + (byStatus.metadata_only ?? 0) + (byStatus.unsupported ?? 0)) / archive.files) * 1000) / 10 : null,
    },
    chunks: { total: chunks?.total ?? 0, embedded: chunks?.embedded ?? 0, eligible: chunks?.eligible ?? 0, private: chunks?.private ?? 0, flagged: chunks?.flagged ?? 0, chars: num(chunks?.chars),
      semanticCoverage: chunks?.eligible ? Math.round(((chunks.embedded ?? 0) / chunks.eligible) * 1000) / 10 : null },
    reviews: { extracted: reviews?.extracted ?? 0, suggested: reviews?.suggested ?? 0, confirmed: reviews?.confirmed ?? 0, referencesUncertain: refs?.uncertain ?? 0, referencesVerified: refs?.verified ?? 0, conflicts: conflicts.length },
    queue: queue ?? { due: 0, waiting: 0, processing: 0, next_retry: null },
    retrieval: { last30d: retrievals?.n ?? 0, withHits: retrievals?.with_hits ?? 0, successRate: retrievals?.n ? Math.round((retrievals.with_hits / retrievals.n) * 1000) / 10 : null, avgLatencyMs: retrievals?.avg_ms ?? null, hybrid: retrievals?.hybrid ?? 0 },
    costs: Object.fromEntries(costs.map((c) => [c.service, { today: num(c.today), month: num(c.month), total: num(c.total) }])) as Record<string, { today: number; month: number; total: number }>,
    semantic: {
      enabled: cfg.embeddingsEnabled, provider: embedder ? `${embedder.provider}:${embedder.model}` : null, providerReason: reason,
      pricePerMTok: embedder?.pricePerMTokUsd ?? null, pgvector: ext ?? { available: false, installed: false }, backlog, budgets: cfg.budgets,
    },
    errors,
    unsupported,
    conflicts,
  };
}

export type BrainStatus = Awaited<ReturnType<typeof brainStatus>>;
