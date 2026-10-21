import { q, q1, type Queryable, getPool } from "@/lib/db/pool";

// Harici AI üretim işleri (görsel/video). Her öğe için tek bir kayıt (idempotency_key) tutulur:
// yeniden deneme, işleyici yeniden başlatma veya aynı görevin iki kez teslim edilmesi İKİNCİ ÜCRETLİ GÖNDERİM yapmaz.
//   submitting → (submitted|running) → downloading → succeeded
//   submitting iken işleyici çökerse sonuç bilinemez → unknown (otomatik tekrar gönderilmez; sahip karar verir)

export type ProviderJobStatus = "submitting" | "submitted" | "running" | "downloading" | "succeeded" | "failed" | "unknown" | "cancelled";
export type ProviderJob = {
  id: string; brand_id: string; project_id: string | null; task_id: string | null; provider: string; kind: string; item_ref: string;
  idempotency_key: string; external_id: string | null; status: ProviderJobStatus; request: any; response: any; result_asset_id: string | null;
  error: string | null; poll_count: number; next_poll_at: string | null; cost_estimated_usd: string | null; cost_actual_usd: string | null;
  created_at: string; updated_at: string; completed_at: string | null;
};

export const ACTIVE_JOB = ["submitted", "running", "downloading"] as const;

export async function getJobByKey(key: string, db: Queryable = getPool()) {
  return q1<ProviderJob>(`SELECT * FROM provider_jobs WHERE idempotency_key = $1`, [key], db);
}

/**
 * Gönderimden ÖNCE kayıt açar. Aynı anahtarla kayıt varsa onu döndürür (created=false) ve çağıran gönderim YAPMAMALIDIR.
 * Başarısız/bilinmeyen bir işin yeniden gönderilmesi yalnızca sahibin açık kararıyla olur (releaseJob).
 */
export async function claimJob(args: {
  brandId: string; projectId: string | null; taskId: string | null; provider: string; kind: "image_generation" | "video_generation";
  itemRef: string; key: string; estimateUsd: number | null; request: Record<string, unknown>;
}, db: Queryable = getPool()): Promise<{ job: ProviderJob; created: boolean }> {
  const ins = await q1<ProviderJob>(
    `INSERT INTO provider_jobs (brand_id, project_id, task_id, provider, kind, item_ref, idempotency_key, status, request, cost_estimated_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'submitting',$8,$9) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [args.brandId, args.projectId, args.taskId, args.provider, args.kind, args.itemRef, args.key, JSON.stringify(args.request), args.estimateUsd],
    db,
  );
  if (ins) return { job: ins, created: true };
  return { job: (await getJobByKey(args.key, db))!, created: false };
}

/** Sağlayıcı isteği HİÇ kabul etmediğinde (ör. 429 hız sınırı) kayıt silinir; görev yeniden denediğinde temiz gönderim yapılır. */
export async function discardJob(id: string, db: Queryable = getPool()) {
  await q(`DELETE FROM provider_jobs WHERE id = $1 AND status = 'submitting'`, [id], db);
}

export async function updateJob(id: string, patch: Partial<{ status: ProviderJobStatus; external_id: string; response: unknown; error: string | null; result_asset_id: string; cost_actual_usd: number | null; next_poll_ms: number; poll_inc: boolean }>, db: Queryable = getPool()) {
  return q1<ProviderJob>(
    `UPDATE provider_jobs SET
       status = COALESCE($2, status), external_id = COALESCE($3, external_id), response = COALESCE($4, response),
       error = CASE WHEN $5::boolean THEN $6 ELSE error END, result_asset_id = COALESCE($7, result_asset_id),
       cost_actual_usd = COALESCE($8, cost_actual_usd),
       next_poll_at = CASE WHEN $9::int IS NULL THEN next_poll_at ELSE now() + ($9::int || ' milliseconds')::interval END,
       poll_count = poll_count + CASE WHEN $10::boolean THEN 1 ELSE 0 END,
       completed_at = CASE WHEN COALESCE($2, status) IN ('succeeded','failed','cancelled') THEN now() ELSE completed_at END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.status ?? null, patch.external_id ?? null, patch.response === undefined ? null : JSON.stringify(patch.response),
      patch.error !== undefined, patch.error ?? null, patch.result_asset_id ?? null, patch.cost_actual_usd ?? null,
      patch.next_poll_ms ?? null, !!patch.poll_inc],
    db,
  );
}

/**
 * İşleyici başlangıcında: gönderim sırasında yarıda kalan işler "unknown" olur (sağlayıcıya ulaşmış ve ücretlendirilmiş olabilir).
 * Dış kimliği olan aktif işler olduğu gibi kalır; render görevi tekrar çalıştığında sağlayıcıdan durumu sorgular (uzlaştırma).
 */
export async function reconcileStaleSubmissions(olderThanMs = 5 * 60_000, db: Queryable = getPool()) {
  const rows = await q<{ id: string }>(
    `UPDATE provider_jobs SET status = 'unknown', updated_at = now(),
       error = 'Gönderim sırasında işlem kesildi; sağlayıcıya ulaşıp ulaşmadığı bilinmiyor. Otomatik tekrar gönderilmedi.'
     WHERE status = 'submitting' AND updated_at < now() - ($1 || ' milliseconds')::interval RETURNING id`,
    [String(olderThanMs)],
    db,
  );
  return rows.length;
}

export async function listJobs(brandId: string, f: { projectId?: string; taskId?: string } = {}, db: Queryable = getPool()) {
  return q<ProviderJob>(
    `SELECT * FROM provider_jobs WHERE brand_id = $1 AND ($2::uuid IS NULL OR project_id = $2) AND ($3::uuid IS NULL OR task_id = $3) ORDER BY created_at`,
    [brandId, f.projectId ?? null, f.taskId ?? null],
    db,
  );
}

/**
 * Sahip kararı: başarısız veya sonucu bilinmeyen işi yeniden gönderime açar (yeni ücret oluşabilir).
 * Eski kayıt geçmiş için korunur; yalnızca idempotency anahtarı serbest bırakılır.
 */
export async function releaseJob(brandId: string, jobId: string, db: Queryable = getPool()) {
  return q1<ProviderJob>(
    `UPDATE provider_jobs SET idempotency_key = idempotency_key || ':released:' || id::text || ':' || extract(epoch from now())::bigint,
       error = COALESCE(error, '') || ' — sahip yeniden gönderime izin verdi', updated_at = now()
     WHERE id = $1 AND brand_id = $2 AND status IN ('failed','unknown') AND idempotency_key NOT LIKE '%:released:%' RETURNING *`,
    [jobId, brandId],
    db,
  );
}
