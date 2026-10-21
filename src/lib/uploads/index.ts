import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { q, q1, getPool, type Queryable } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { getStorage } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { redact } from "@/lib/security/crypto";
import { MediaValidationError, UNSUPPORTED, readHead, registerFile, sha256File, sniff, type UploadMeta } from "@/lib/services/media";

// Parçalı, sürdürülebilir yükleme.
// Akış: init (oturum + depolamada parçalı yükleme) → parçalar (8 MB; sunucu üzerinden akış veya imzalı doğrudan URL)
//       → complete (depolama parçaları birleştirir; durum "verifying") → işleyici doğrular (SHA-256, bayt düzeyinde tür,
//       boyut, ffprobe/sharp) → arşive kaydeder ("processing") → analiz kuyruğu → "completed".
// Kesinti: aynı dosya (client_key) yeniden seçilirse aynı oturum döner; yalnızca eksik parçalar yüklenir.

export const PART_SIZE = 8 * 1024 * 1024;
const ALLOWED_DECLARED = /^(image\/(jpeg|png|webp|gif|svg\+xml|vnd\.adobe\.photoshop)|video\/(mp4|quicktime|webm)|application\/(pdf|octet-stream))$/;
const EXT_OK = /\.(jpe?g|png|webp|gif|svg|psd|mp4|mov|m4v|webm|pdf)$/i;

export type UploadSession = {
  id: string;
  brand_id: string;
  client_key: string;
  filename: string;
  declared_mime: string | null;
  size_bytes: number;
  part_size: number;
  part_count: number;
  storage_driver: string;
  temp_key: string;
  s3_upload_id: string | null;
  meta: UploadMeta;
  status: "preparing" | "uploading" | "verifying" | "processing" | "completed" | "failed" | "aborted";
  asset_id: string | null;
  duplicate: boolean;
  error: string | null;
  verify_attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export class UploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function partBytes(s: Pick<UploadSession, "size_bytes" | "part_size" | "part_count">, n: number) {
  return n < s.part_count ? s.part_size : s.size_bytes - s.part_size * (s.part_count - 1);
}

export async function getSession(brandId: string, id: string, db: Queryable = getPool()) {
  return q1<UploadSession>(`SELECT * FROM upload_sessions WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
}

/** Oturum başlatır veya aynı dosya için yarım kalan oturumu döndürür (sürdürme). */
export async function initUpload(
  brandId: string,
  args: { filename: string; size: number; mime?: string; clientKey: string; meta?: UploadMeta },
): Promise<{ session: UploadSession; uploadedParts: number[]; resumed: boolean }> {
  const filename = args.filename.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200);
  if (!filename || !EXT_OK.test(filename)) throw new UploadError(UNSUPPORTED);
  if (!Number.isInteger(args.size) || args.size <= 0) throw new UploadError("Geçersiz dosya boyutu.");
  if (args.size > config.maxUploadBytes) throw new UploadError(`Dosya çok büyük (${(args.size / 1e6).toFixed(0)} MB). Sınır: ${config.maxUploadBytes / 1024 / 1024} MB.`, 413);
  if (args.mime && !ALLOWED_DECLARED.test(args.mime)) throw new UploadError(UNSUPPORTED);
  if (!args.clientKey || args.clientKey.length > 300) throw new UploadError("Geçersiz istemci anahtarı.");
  if (args.meta?.productId) {
    const p = await q1(`SELECT 1 FROM products WHERE id = $1 AND brand_id = $2`, [args.meta.productId, brandId]);
    if (!p) throw new UploadError("Ürün bu markaya ait değil.");
  }
  const existing = await q1<UploadSession>(
    `SELECT * FROM upload_sessions WHERE brand_id = $1 AND client_key = $2 AND status IN ('preparing','uploading') AND size_bytes = $3`,
    [brandId, args.clientKey, args.size],
  );
  if (existing) {
    const parts = await getStorage().multipartList(existing.temp_key, existing.s3_upload_id!);
    return { session: existing, uploadedParts: parts.filter((p) => p.size === partBytes(existing, p.part)).map((p) => p.part), resumed: true };
  }
  const id = crypto.randomUUID();
  const tempKey = `brands/${brandId}/incoming/${id}`;
  const partCount = Math.max(1, Math.ceil(args.size / PART_SIZE));
  const storage = getStorage();
  const row = await q1<UploadSession>(
    `INSERT INTO upload_sessions (id, brand_id, client_key, filename, declared_mime, size_bytes, part_size, part_count, storage_driver, temp_key, meta, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'preparing')
     ON CONFLICT (brand_id, client_key) WHERE status IN ('preparing','uploading') DO NOTHING RETURNING *`,
    [id, brandId, args.clientKey, filename, args.mime ?? null, args.size, PART_SIZE, partCount, storage.driver, tempKey, JSON.stringify(args.meta ?? {})],
  );
  if (!row) return initUpload(brandId, args); // eşzamanlı ikinci istek: mevcut oturumu kullan
  try {
    const uploadId = await storage.multipartStart(tempKey, args.mime ?? "application/octet-stream");
    const s = await q1<UploadSession>(`UPDATE upload_sessions SET s3_upload_id = $2, status = 'uploading', updated_at = now() WHERE id = $1 RETURNING *`, [id, uploadId]);
    return { session: s!, uploadedParts: [], resumed: false };
  } catch (err) {
    await q(`UPDATE upload_sessions SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [id, redact((err as Error).message).slice(0, 300)]);
    throw new UploadError("Depolama yüklemeyi başlatamadı. Daha sonra tekrar deneyin.", 503);
  }
}

/** Parça adresleri: doğrudan mod (S3 + UPLOAD_DIRECT=true) imzalı URL, aksi halde sunucu üzerinden. */
export async function partTargets(brandId: string, id: string, parts: number[]) {
  const s = await getSession(brandId, id);
  if (!s || s.status !== "uploading") throw new UploadError("Yükleme oturumu bulunamadı veya kapandı.", 404);
  const storage = getStorage();
  const direct = process.env.UPLOAD_DIRECT === "true" && storage.multipartPartUrl;
  const out: { part: number; url: string; direct: boolean; bytes: number }[] = [];
  for (const n of parts) {
    if (!Number.isInteger(n) || n < 1 || n > s.part_count) throw new UploadError("Geçersiz parça numarası.");
    out.push({
      part: n,
      bytes: partBytes(s, n),
      direct: !!direct,
      url: direct ? await storage.multipartPartUrl!(s.temp_key, s.s3_upload_id!, n, 900) : `/api/uploads/${s.id}/parts/${n}`,
    });
  }
  return out;
}

/** Sunucu üzerinden parça yükleme. Gövde, beklenen parça boyutunu aşarsa okuma kesilir (bellek sınırı). */
export async function putPart(brandId: string, id: string, n: number, body: ReadableStream<Uint8Array> | null) {
  const s = await getSession(brandId, id);
  if (!s || s.status !== "uploading") throw new UploadError("Yükleme oturumu bulunamadı veya kapandı.", 404);
  if (!Number.isInteger(n) || n < 1 || n > s.part_count) throw new UploadError("Geçersiz parça numarası.");
  if (!body) throw new UploadError("Boş parça.");
  const expected = partBytes(s, n);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > expected) {
      await reader.cancel().catch(() => {});
      throw new UploadError(`Parça ${n} beklenenden büyük.`, 413);
    }
    chunks.push(value);
  }
  if (total !== expected) throw new UploadError(`Parça ${n} eksik geldi (${total}/${expected} bayt). Tekrar deneyin.`);
  await getStorage().multipartPut(s.temp_key, s.s3_upload_id!, n, Buffer.concat(chunks));
  await q(`UPDATE upload_sessions SET updated_at = now(), expires_at = now() + interval '24 hours' WHERE id = $1`, [s.id]);
  return { part: n, bytes: total };
}

export async function uploadedParts(brandId: string, id: string) {
  const s = await getSession(brandId, id);
  if (!s) throw new UploadError("Bulunamadı.", 404);
  if (s.status !== "uploading") return { session: s, parts: [] as number[] };
  const parts = await getStorage().multipartList(s.temp_key, s.s3_upload_id!);
  return { session: s, parts: parts.filter((p) => p.size === partBytes(s, p.part)).map((p) => p.part) };
}

/** Tamamlama: tüm parçalar depolamada doğrulanır, birleştirilir, oturum "verifying" olur. Tekrar çağrılabilir (idempotent). */
export async function completeUpload(brandId: string, id: string) {
  const s = await getSession(brandId, id);
  if (!s) throw new UploadError("Bulunamadı.", 404);
  if (["verifying", "processing", "completed"].includes(s.status)) return s;
  if (s.status !== "uploading") throw new UploadError(`Oturum durumu uygun değil: ${s.status}`, 409);
  const storage = getStorage();
  const parts = await storage.multipartList(s.temp_key, s.s3_upload_id!);
  const ok = new Set(parts.filter((p) => p.size === partBytes(s, p.part)).map((p) => p.part));
  const missing = Array.from({ length: s.part_count }, (_, i) => i + 1).filter((n) => !ok.has(n));
  if (missing.length) throw new UploadError(`Eksik parçalar: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`, 409);
  // Durumu önce kilitle: iki eşzamanlı tamamlama birleştirmeyi iki kez yapmaz
  const locked = await q1<UploadSession>(`UPDATE upload_sessions SET status = 'verifying', updated_at = now() WHERE id = $1 AND status = 'uploading' RETURNING *`, [s.id]);
  if (!locked) return (await getSession(brandId, id))!;
  try {
    await storage.multipartComplete(s.temp_key, s.s3_upload_id!);
  } catch (err) {
    await q(`UPDATE upload_sessions SET status = 'uploading', error = $2, updated_at = now() WHERE id = $1`, [s.id, redact((err as Error).message).slice(0, 300)]);
    throw new UploadError("Parçalar birleştirilemedi; tekrar deneyin.", 503);
  }
  return locked;
}

export async function abortUpload(brandId: string, id: string) {
  const s = await getSession(brandId, id);
  if (!s) throw new UploadError("Bulunamadı.", 404);
  if (!["preparing", "uploading", "failed"].includes(s.status)) return s;
  if (s.s3_upload_id) await getStorage().multipartAbort(s.temp_key, s.s3_upload_id).catch(() => {});
  return (await q1<UploadSession>(`UPDATE upload_sessions SET status = 'aborted', updated_at = now() WHERE id = $1 RETURNING *`, [s.id]))!;
}

/** İşleyici: birleştirilmiş dosyayı doğrular ve arşive kaydeder. */
export async function verifyUpload(s: UploadSession): Promise<UploadSession> {
  const storage = getStorage();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-"));
  const file = path.join(dir, "upload.bin");
  try {
    // Önceki denemede kayıt oluşturulup geçici dosya silindiyse (çökme sonrası) tekrar işleme gerek yok
    const knownSha = (s.meta as UploadMeta & { _sha256?: string })._sha256;
    if (knownSha && !(await storage.exists(s.temp_key))) {
      const a = await q1<{ id: string }>(`SELECT id FROM media_assets WHERE brand_id = $1 AND sha256 = $2`, [s.brand_id, knownSha]);
      if (a) {
        return (await q1<UploadSession>(`UPDATE upload_sessions SET status = 'completed', asset_id = $2, lease_owner = NULL, completed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [s.id, a.id]))!;
      }
    }
    const size = await storage.downloadToFile(s.temp_key, file);
    if (size !== Number(s.size_bytes)) throw new MediaValidationError(`Boyut uyuşmuyor (${size} / ${s.size_bytes} bayt).`);
    const sniffed = sniff(await readHead(file));
    if (!sniffed) throw new MediaValidationError(UNSUPPORTED);
    const hash = await sha256File(file);
    await q(`UPDATE upload_sessions SET status = 'processing', meta = meta || jsonb_build_object('_sha256', $2::text), updated_at = now() WHERE id = $1`, [s.id, hash]);
    const r = await registerFile(s.brand_id, { file, filename: s.filename, sizeBytes: size, sha256: hash, sniffed, sourceKey: s.temp_key }, s.meta);
    await storage.delete(s.temp_key).catch(() => {});
    const done = await q1<UploadSession>(
      `UPDATE upload_sessions SET status = 'completed', asset_id = $2, duplicate = $3, error = NULL, lease_owner = NULL, completed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [s.id, r.asset.id, r.duplicate],
    );
    return done!;
  } catch (err) {
    const permanent = err instanceof MediaValidationError;
    const msg = redact((err as Error).message).slice(0, 400);
    const failed = permanent || s.verify_attempts >= 3;
    if (failed) await storage.delete(s.temp_key).catch(() => {});
    const row = await q1<UploadSession>(
      `UPDATE upload_sessions SET status = $2, error = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [s.id, failed ? "failed" : "verifying", msg],
    );
    if (failed) await audit({ brandId: s.brand_id, actor: "worker", action: "upload.failed", message: `Yükleme doğrulanamadı: ${s.filename} — ${msg}` });
    return row!;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** İşleyici döngüsü: doğrulama bekleyen bir oturumu kiralar ve işler; süresi geçmiş yarım yüklemeleri temizler. */
export async function runUploadQueueOnce(workerId: string) {
  // Süresi dolmuş yarım yüklemeler
  const stale = await q<UploadSession>(`SELECT * FROM upload_sessions WHERE status IN ('preparing','uploading') AND expires_at < now() LIMIT 20`);
  for (const s of stale) {
    if (s.s3_upload_id) await getStorage().multipartAbort(s.temp_key, s.s3_upload_id).catch(() => {});
    await q(`UPDATE upload_sessions SET status = 'aborted', error = 'Süresi doldu (24 saat işlem yok).', updated_at = now() WHERE id = $1`, [s.id]);
  }
  const s = await q1<UploadSession>(
    `UPDATE upload_sessions SET lease_owner = $1, lease_expires_at = now() + interval '20 minutes', verify_attempts = verify_attempts + 1, updated_at = now()
     WHERE id = (SELECT id FROM upload_sessions WHERE status IN ('verifying','processing') AND (lease_expires_at IS NULL OR lease_expires_at < now())
                 ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
    [workerId],
  );
  if (!s) return null;
  return verifyUpload(s);
}
