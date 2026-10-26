import { isUuid } from "@/lib/ids";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { getStorage } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { config } from "@/lib/config";
import { sha256 } from "@/lib/security/crypto";

const execFileAsync = promisify(execFile);

export type MediaAsset = {
  id: string;
  brand_id: string;
  product_id: string | null;
  kind: string;
  origin: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  colors: string[];
  themes: string[];
  shot_type: string | null;
  format: string | null;
  rights_status: string;
  rights_note: string | null;
  usage_history: { date: string; channel: string; note?: string }[];
  tags: { tag: string; source: string }[];
  parent_asset_id: string | null;
  version: number;
  source_task_id: string | null;
  source_output_version_id: string | null;
  project_id?: string | null;
  generation_method?: string;
  alt_text?: string | null;
  created_at: string;
};

export class MediaValidationError extends Error {}

export type Sniffed = { mime: string; ext: string; kind: "photo" | "video" | "design" | "document" };

/** Dosya türünü uzantıya değil içeriğin ilk baytlarına bakarak belirler. */
export function sniff(buf: Buffer): Sniffed | null {
  const h = buf.subarray(0, 16);
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { mime: "image/jpeg", ext: "jpg", kind: "photo" };
  if (h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png", kind: "photo" };
  if (h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp", kind: "photo" };
  if (h.subarray(0, 4).toString("latin1") === "GIF8") return { mime: "image/gif", ext: "gif", kind: "photo" };
  if (h.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = h.subarray(8, 12).toString("latin1");
    if (brand === "qt  ") return { mime: "video/quicktime", ext: "mov", kind: "video" };
    if (/^(heic|heix|mif1|avif)/.test(brand)) return null; // HEIC/AVIF: önizleme desteği yok
    return { mime: "video/mp4", ext: "mp4", kind: "video" };
  }
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return { mime: "video/webm", ext: "webm", kind: "video" };
  if (h.subarray(0, 4).toString("latin1") === "%PDF") return { mime: "application/pdf", ext: "pdf", kind: "document" };
  if (h.subarray(0, 4).toString("latin1") === "8BPS") return { mime: "image/vnd.adobe.photoshop", ext: "psd", kind: "design" };
  const head = buf.subarray(0, 512).toString("utf8").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(head)) return { mime: "image/svg+xml", ext: "svg", kind: "design" };
  return null;
}

async function probeVideo(buf: Buffer, ext: string) {
  const tmp = path.join(os.tmpdir(), `probe-${crypto.randomUUID()}.${ext}`);
  await fs.writeFile(tmp, buf);
  try {
    return await probeVideoFile(tmp);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function probeVideoFile(file: string) {
  try {
    const { stdout } = await execFileAsync(config.ffprobePath, ["-protocol_whitelist", "file,pipe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeout: 60_000 });
    const info = JSON.parse(stdout);
    const v = (info.streams ?? []).find((s: any) => s.codec_type === "video");
    if (!v) throw new MediaValidationError("Dosyada video akışı bulunamadı.");
    return { width: v.width ?? null, height: v.height ?? null, duration: info.format?.duration ? Number(info.format.duration) : null };
  } catch (err) {
    if (err instanceof MediaValidationError) throw err;
    if ((err as any).code === "ENOENT") return { width: null, height: null, duration: null }; // ffprobe yok
    throw new MediaValidationError("Video dosyası okunamadı (bozuk veya desteklenmeyen kodek).");
  }
}

/** Dosyanın ilk baytlarını okur (tür tespiti için; tüm dosya belleğe alınmaz). */
export async function readHead(file: string, bytes = 4096) {
  const h = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await h.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await h.close();
  }
}

/** Dosyanın SHA-256 özeti (akışla; büyük videolar belleğe alınmaz). */
export async function sha256File(file: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function aspect(w: number | null, h: number | null): string | null {
  if (!w || !h) return null;
  const r = w / h;
  const known: [string, number][] = [["9:16", 9 / 16], ["4:5", 4 / 5], ["1:1", 1], ["16:9", 16 / 9], ["3:4", 3 / 4], ["4:3", 4 / 3]];
  const best = known.reduce((a, b) => (Math.abs(b[1] - r) < Math.abs(a[1] - r) ? b : a));
  return Math.abs(best[1] - r) < 0.03 ? best[0] : `${w}x${h}`;
}

async function dominantColor(buf: Buffer): Promise<string | null> {
  try {
    const { dominant } = await sharp(buf).stats();
    return `#${[dominant.r, dominant.g, dominant.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

export type UploadMeta = {
  productId?: string | null;
  kind?: string;          // logo | design | photo | video (kullanıcı seçimi; içerikle uyumlu olmalı)
  origin?: string;        // real_photo | real_video | ai_generated | design_file
  themes?: string[];
  colors?: string[];
  shotType?: string | null;
  rightsStatus?: string;
  rightsNote?: string | null;
  tags?: string[];
  /** false: içerik analizi yalnızca yerel yapılır (ücretli görsel model çağrılmaz). Verilmezse ayar geçerlidir. */
  vision?: boolean;
};

/**
 * Medya yükleme. Tür ve boyut kontrolü yapar, aynı markada tekrarlanan dosyayı algılar (SHA-256).
 * Orijinal dosya değiştirilmez; düzenlemeler yeni varlık (sürüm) olarak kaydedilir.
 */
export async function uploadMedia(
  brandId: string,
  file: { buffer: Buffer; filename: string },
  meta: UploadMeta = {},
  db: Queryable = getPool(),
): Promise<{ asset: MediaAsset; duplicate: boolean }> {
  if (file.buffer.length === 0) throw new MediaValidationError("Boş dosya.");
  if (file.buffer.length > config.maxUploadBytes) throw new MediaValidationError(`Dosya çok büyük (${(file.buffer.length / 1e6).toFixed(1)} MB). Sınır: ${config.maxUploadBytes / 1024 / 1024} MB.`);
  const s = sniff(file.buffer);
  if (!s) throw new MediaValidationError(UNSUPPORTED);
  const tmp = path.join(os.tmpdir(), `upload-${crypto.randomUUID()}.${s.ext}`);
  await fs.writeFile(tmp, file.buffer);
  try {
    return await registerFile(brandId, { file: tmp, filename: file.filename, sizeBytes: file.buffer.length, sha256: sha256(file.buffer), sniffed: s }, meta, db);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export const UNSUPPORTED = "Desteklenmeyen dosya türü. İzin verilenler: JPEG, PNG, WebP, GIF, MP4, MOV, WebM, PDF, PSD, SVG.";

/**
 * Doğrulanmış (türü baytlardan tespit edilmiş, özeti hesaplanmış) yerel dosyayı arşive kaydeder.
 * `sourceKey` verilirse dosya depolamada zaten oradadır (parçalı yükleme) ve kalıcı anahtara kopyalanır.
 */
export async function registerFile(
  brandId: string,
  f: { file: string; filename: string; sizeBytes: number; sha256: string; sniffed: Sniffed; sourceKey?: string },
  meta: UploadMeta = {},
  db: Queryable = getPool(),
): Promise<{ asset: MediaAsset; duplicate: boolean }> {
  const s = f.sniffed;
  if (meta.productId) {
    const p = await q1(`SELECT 1 FROM products WHERE id = $1 AND brand_id = $2`, [meta.productId, brandId], db);
    if (!p) throw new MediaValidationError("Ürün bu markaya ait değil.");
  }
  const existing = await q1<MediaAsset>(`SELECT * FROM media_assets WHERE brand_id = $1 AND sha256 = $2`, [brandId, f.sha256], db);
  if (existing) return { asset: existing, duplicate: true };

  let width: number | null = null, height: number | null = null, duration: number | null = null;
  const colors = [...(meta.colors ?? [])];
  const tags: { tag: string; source: string }[] = (meta.tags ?? []).filter(Boolean).map((t) => ({ tag: t, source: "user" }));
  if (s.kind === "photo") {
    try {
      const m = await sharp(f.file).metadata();
      width = m.width ?? null;
      height = m.height ?? null;
    } catch {
      throw new MediaValidationError("Görsel dosyası okunamadı (bozuk olabilir).");
    }
    const dom = await dominantColor(await fs.readFile(f.file));
    if (dom) tags.push({ tag: `baskın renk ${dom}`, source: "auto" });
  } else if (s.kind === "video") {
    const p = await probeVideoFile(f.file);
    width = p.width; height = p.height; duration = p.duration;
  }
  let kind: string = s.kind;
  if (meta.kind === "logo" && (s.kind === "photo" || s.kind === "design")) kind = "logo";
  if (meta.kind === "design") kind = "design";
  const origin = meta.origin ?? (s.kind === "video" ? "real_video" : kind === "photo" ? "real_photo" : "design_file");
  const key = `brands/${brandId}/originals/${f.sha256}.${s.ext}`;
  if (f.sourceKey) await getStorage().copy(f.sourceKey, key);
  else await getStorage().putFile(key, f.file, s.mime);
  const asset = await q1<MediaAsset>(
    `INSERT INTO media_assets (brand_id, product_id, kind, origin, filename, mime_type, size_bytes, sha256, storage_key, width, height, duration_s,
       colors, themes, shot_type, format, rights_status, rights_note, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (brand_id, sha256) DO NOTHING RETURNING *`,
    [brandId, meta.productId ?? null, kind, origin, f.filename.slice(0, 200), s.mime, f.sizeBytes, f.sha256, key, width, height, duration,
      colors, meta.themes ?? [], meta.shotType ?? null, aspect(width, height), meta.rightsStatus ?? "unknown", meta.rightsNote ?? null, JSON.stringify(tags)],
    db,
  );
  if (!asset) {
    // Eşzamanlı aynı dosya yüklemesi: diğer istek kaydı oluşturdu
    const again = await q1<MediaAsset>(`SELECT * FROM media_assets WHERE brand_id = $1 AND sha256 = $2`, [brandId, f.sha256], db);
    return { asset: again!, duplicate: true };
  }
  await audit({ brandId, actor: "user", action: "media.upload", message: `Medya yüklendi: ${asset.filename} (${kind}, ${origin}, ${(f.sizeBytes / 1e6).toFixed(1)} MB)`, data: { assetId: asset.id } }, db);
  // Gerçek içerik analizi arka planda (işleyici) yapılır
  const { enqueueAnalysis } = await import("@/lib/media-analysis");
  await enqueueAnalysis(asset, meta.vision === false ? { vision: false } : {}, db);
  return { asset, duplicate: false };
}

/** Üretilen/düzenlenen dosyayı yeni varlık olarak kaydeder ve kaynaklarla ilişkilendirir. */
export async function saveDerivedAsset(
  brandId: string,
  args: {
    buffer: Buffer; filename: string; origin: "edited" | "composed" | "ai_generated" | "export"; sourceAssetIds: string[]; productId?: string | null;
    taskId?: string | null; projectId?: string | null; outputVersionId?: string | null; tags?: { tag: string; source: string }[]; themes?: string[];
    generationMethod?: string; // sharp_compose | ffmpeg_edit | ai_image:<servis> | ai_video:<servis>
  },
  db: Queryable = getPool(),
) {
  const s = sniff(args.buffer);
  if (!s) throw new Error("Üretilen dosyanın türü tanınamadı.");
  const hash = sha256(args.buffer);
  const dup = await q1<MediaAsset>(`SELECT * FROM media_assets WHERE brand_id = $1 AND sha256 = $2`, [brandId, hash], db);
  if (dup) return dup;
  let width: number | null = null, height: number | null = null, duration: number | null = null;
  if (s.kind === "photo") {
    const m = await sharp(args.buffer).metadata();
    width = m.width ?? null; height = m.height ?? null;
  } else if (s.kind === "video") {
    const p = await probeVideo(args.buffer, s.ext);
    width = p.width; height = p.height; duration = p.duration;
  }
  const parent = args.sourceAssetIds[0] ?? null;
  let version = 1;
  if (parent) {
    const r = await q1<{ v: number }>(`SELECT COALESCE(MAX(version), 1) + 1 AS v FROM media_assets WHERE brand_id = $1 AND (id = $2 OR parent_asset_id = $2)`, [brandId, parent], db);
    version = r?.v ?? 2;
  }
  const key = `brands/${brandId}/derived/${hash}.${s.ext}`;
  await getStorage().put(key, args.buffer, s.mime);
  const asset = await q1<MediaAsset>(
    `INSERT INTO media_assets (brand_id, product_id, kind, origin, filename, mime_type, size_bytes, sha256, storage_key, width, height, duration_s,
       format, rights_status, tags, themes, parent_asset_id, version, source_task_id, source_output_version_id, project_id, generation_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [brandId, args.productId ?? null, s.kind, args.origin, args.filename, s.mime, args.buffer.length, hash, key, width, height, duration,
      aspect(width, height), "owned", JSON.stringify(args.tags ?? []), args.themes ?? [], parent, version, args.taskId ?? null, args.outputVersionId ?? null,
      args.projectId ?? null, args.generationMethod ?? (args.origin === "export" ? "export" : "derived")],
    db,
  );
  for (const src of args.sourceAssetIds) {
    await q(`INSERT INTO media_lineage (derived_asset_id, source_asset_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [asset!.id, src], db);
  }
  return asset!;
}

export async function listMedia(brandId: string, f: { kind?: string; origin?: string; productId?: string; search?: string } = {}, db: Queryable = getPool()) {
  return q<MediaAsset>(
    `SELECT * FROM media_assets WHERE brand_id = $1
       AND ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR origin = $3) AND ($4::uuid IS NULL OR product_id = $4)
       AND ($5::text IS NULL OR filename ILIKE '%' || $5 || '%' OR tags::text ILIKE '%' || $5 || '%' OR array_to_string(themes, ' ') ILIKE '%' || $5 || '%')
     ORDER BY created_at DESC LIMIT 500`,
    [brandId, f.kind || null, f.origin || null, f.productId || null, f.search || null],
    db,
  );
}

export async function getMedia(brandId: string, id: string, db: Queryable = getPool()) {
  if (!isUuid(id)) return null;
  return q1<MediaAsset>(`SELECT * FROM media_assets WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
}

export async function mediaLineage(brandId: string, id: string, db: Queryable = getPool()) {
  const sources = await q<MediaAsset>(
    `SELECT m.* FROM media_lineage l JOIN media_assets m ON m.id = l.source_asset_id WHERE l.derived_asset_id = $1 AND m.brand_id = $2`, [id, brandId], db);
  const derived = await q<MediaAsset>(
    `SELECT m.* FROM media_lineage l JOIN media_assets m ON m.id = l.derived_asset_id WHERE l.source_asset_id = $1 AND m.brand_id = $2`, [id, brandId], db);
  return { sources, derived };
}

export async function updateMediaMeta(
  brandId: string,
  id: string,
  m: { productId?: string | null; themes?: string[]; colors?: string[]; shotType?: string | null; rightsStatus?: string; rightsNote?: string | null; tags?: { tag: string; source: string }[]; origin?: string },
  db: Queryable = getPool(),
) {
  if (m.productId) {
    const p = await q1(`SELECT 1 FROM products WHERE id = $1 AND brand_id = $2`, [m.productId, brandId], db);
    if (!p) throw new MediaValidationError("Ürün bu markaya ait değil.");
  }
  const row = await q1<MediaAsset>(
    `UPDATE media_assets SET product_id = $3, themes = COALESCE($4, themes), colors = COALESCE($5, colors), shot_type = $6,
       rights_status = COALESCE($7, rights_status), rights_note = $8, tags = COALESCE($9, tags), origin = COALESCE($10, origin)
     WHERE id = $1 AND brand_id = $2 RETURNING *`,
    [id, brandId, m.productId ?? null, m.themes ?? null, m.colors ?? null, m.shotType ?? null, m.rightsStatus ?? null, m.rightsNote ?? null, m.tags ? JSON.stringify(m.tags) : null, m.origin ?? null],
    db,
  );
  if (row) await audit({ brandId, actor: "user", action: "media.update", message: `Medya bilgileri güncellendi: ${row.filename}` }, db);
  return row;
}

export async function recordUsage(brandId: string, id: string, usage: { channel: string; note?: string }, db: Queryable = getPool()) {
  await q(`UPDATE media_assets SET usage_history = usage_history || $3::jsonb WHERE id = $1 AND brand_id = $2`,
    [id, brandId, JSON.stringify([{ date: new Date().toISOString(), ...usage }])], db);
}

export async function readMediaFile(asset: MediaAsset) {
  return getStorage().get(asset.storage_key);
}
