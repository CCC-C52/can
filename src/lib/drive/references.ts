import sharp from "sharp";
import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { looksSecret } from "@/lib/services/brand-memory";
import { uploadMedia } from "@/lib/services/media";
import { driveGet, fetchThumbnail, type CallStats } from "./google";
import { getDriveSource, tokenProvider, DriveValidationError, safeError } from "./source";
import { THEME_INFO, VIEW_LABEL, classifyGarmentColour, combineSuggestion, isTheme, isView, type FribeeTheme, type GarmentColour, type ReferenceView } from "./themes";

// Marka Bilgi Merkezi: Drive arşivindeki fotoğraflardan sahibin doğruladığı tema referansları.
// - Öneriler yalnızca sahibin seçtiği (en çok 50) görsel için ve ücretsiz yerel yöntemlerle üretilir.
// - "uncertain" ve "rejected" kayıtlar hiçbir video/tasarım isteğine referans olarak giremez.
// - Önizleme içe aktarma: yalnızca doğrulanmış referans için Drive'ın ürettiği önizleme (en çok 1600 px) alınır;
//   orijinal dosya indirilmez veya kopyalanmaz. İçe aktarılan görselde ücretli görsel analiz kapalıdır.

export const SUGGEST_MAX_ITEMS = 50;

export type DriveItem = {
  id: string;
  brand_id: string;
  source_id: string;
  file_id: string;
  name: string;
  mime_type: string;
  is_folder: boolean;
  parent_ids: string[];
  path: string | null;
  depth: number | null;
  size_bytes: string | null;
  md5_checksum: string | null;
  sha1_checksum: string | null;
  sha256_checksum: string | null;
  created_time: string | null;
  modified_time: string | null;
  has_thumbnail: boolean;
  image_width: number | null;
  image_height: number | null;
  state: "indexed" | "pending_checksum" | "malformed" | "removed";
  state_detail: string | null;
  last_seen_at: string;
};

export type DriveReference = {
  id: string;
  brand_id: string;
  item_id: string;
  theme: FribeeTheme | null;
  view: ReferenceView;
  status: "uncertain" | "verified" | "rejected";
  suggested_theme: FribeeTheme | null;
  suggested_view: ReferenceView | null;
  suggestion_confidence: number | null;
  suggestion_detail: { reasons?: string[]; colour?: GarmentColour | null; colour_error?: string };
  notes: string | null;
  artwork_confirmed: boolean;
  media_asset_id: string | null;
  verified_by: string | null;
  verified_at: string | null;
  updated_at: string;
};

const SUPPORTED_PREVIEW = /^image\/(jpeg|png|webp|heic|heif|tiff|gif|bmp)$/;

async function dominantColour(buf: Buffer): Promise<GarmentColour | null> {
  const { dominant } = await sharp(buf).stats();
  return classifyGarmentColour(dominant);
}

async function thumbnailLink(brandId: string, fileId: string, stats?: CallStats) {
  const f = await driveGet<{ thumbnailLink?: string }>(`/files/${fileId}`, { fields: "thumbnailLink", supportsAllDrives: true }, tokenProvider(brandId), stats);
  if (typeof f.thumbnailLink !== "string" || !f.thumbnailLink) throw new DriveValidationError("Drive bu dosya için önizleme sunmuyor.");
  return f.thumbnailLink;
}

/**
 * Seçilen görseller için tema/görünüm önerisi oluşturur veya yeniler (doğrulanmış kayıtlara dokunmaz).
 * `useThumbnails`: Drive önizlemesinin baskın rengi de kullanılır (Drive API kotası dışında maliyeti yoktur).
 */
export async function suggestReferences(brandId: string, itemIds: string[], opts: { useThumbnails?: boolean } = {}) {
  const ids = [...new Set(itemIds.filter(isUuid))];
  if (!ids.length) throw new DriveValidationError("Öneri için en az bir görsel seçin.");
  if (ids.length > SUGGEST_MAX_ITEMS) throw new DriveValidationError(`Tek seferde en çok ${SUGGEST_MAX_ITEMS} görsel seçilebilir (tüm arşiv toplu analiz edilmez).`);
  const items = await q<DriveItem>(
    `SELECT * FROM drive_items WHERE brand_id = $1 AND id = ANY($2::uuid[]) AND NOT is_folder AND state <> 'removed' AND mime_type LIKE 'image/%'`,
    [brandId, ids],
  );
  if (!items.length) throw new DriveValidationError("Seçilenler arasında bu markanın arşivinde öneri yapılabilecek görsel yok.");
  const stats: CallStats = { calls: 0, retries: 0 };
  let thumbnails = 0;
  const out: DriveReference[] = [];
  for (const it of items) {
    let colour: GarmentColour | null = null;
    let colourError: string | undefined;
    if (opts.useThumbnails && it.has_thumbnail) {
      try {
        colour = await dominantColour(await fetchThumbnail(await thumbnailLink(brandId, it.file_id, stats), tokenProvider(brandId), 220));
        thumbnails++;
      } catch (err) {
        colourError = safeError(err);
      }
    }
    const s = combineSuggestion(`${it.path ?? ""} ${it.name}`, colour);
    const detail = { ...s.detail, ...(colourError ? { colour_error: colourError } : {}) };
    const row = await q1<DriveReference>(
      `INSERT INTO drive_references (brand_id, item_id, theme, view, suggested_theme, suggested_view, suggestion_confidence, suggestion_detail)
       VALUES ($1,$2,$3,$4,$3,$4,$5,$6)
       ON CONFLICT (item_id) DO UPDATE SET suggested_theme = EXCLUDED.suggested_theme, suggested_view = EXCLUDED.suggested_view,
         suggestion_confidence = EXCLUDED.suggestion_confidence, suggestion_detail = EXCLUDED.suggestion_detail,
         theme = CASE WHEN drive_references.status = 'uncertain' THEN COALESCE(drive_references.theme, EXCLUDED.theme) ELSE drive_references.theme END,
         view = CASE WHEN drive_references.status = 'uncertain' AND drive_references.view = 'unknown' THEN EXCLUDED.view ELSE drive_references.view END,
         updated_at = now()
       WHERE drive_references.brand_id = $1 AND drive_references.status <> 'verified'
       RETURNING *`,
      [brandId, it.id, s.theme, s.view, s.confidence, JSON.stringify(detail)],
    );
    if (row) out.push(row);
  }
  await audit({ brandId, actor: "user", action: "drive.suggest", message: `Drive arşivinden ${out.length} görsel için tema önerisi oluşturuldu (yerel, ücretsiz; ${thumbnails} önizleme rengi).` });
  return { references: out, thumbnails, apiCalls: stats.calls };
}

export type ReviewInput = { action: "verify" | "reject" | "reset"; theme?: string | null; view?: string | null; artworkConfirmed?: boolean; notes?: string | null };

/** Sahip incelemesi. Doğrulama için tema, görünüm (ön/arka/detay/diğer) ve basılı tasarımın birebir doğru olduğu onayı gerekir. */
export async function reviewReference(brandId: string, refId: string, input: ReviewInput, actor = "user") {
  if (!isUuid(refId)) throw new DriveValidationError("Referans bulunamadı.");
  const ref = await q1<DriveReference & { item_state: string; item_name: string }>(
    `SELECT r.*, i.state AS item_state, i.name AS item_name FROM drive_references r JOIN drive_items i ON i.id = r.item_id AND i.brand_id = r.brand_id
     WHERE r.id = $1 AND r.brand_id = $2`,
    [refId, brandId],
  );
  if (!ref) throw new DriveValidationError("Referans bulunamadı.");
  const notes = (input.notes ?? "").trim() || null;
  if (notes && notes.length > 1000) throw new DriveValidationError("Not en çok 1000 karakter olabilir.");
  if (notes && looksSecret(notes)) throw new DriveValidationError("Not gizli bilgi içeriyor gibi görünüyor; kaydedilmedi.");
  let row: DriveReference | null;
  if (input.action === "verify") {
    if (ref.item_state === "removed") throw new DriveValidationError("Dosya Drive'da artık yok (silinmiş veya taşınmış); doğrulanamaz.");
    if (!isTheme(input.theme)) throw new DriveValidationError("Doğrulamak için dört FriBee temasından birini seçin.");
    if (!isView(input.view)) throw new DriveValidationError("Doğrulamak için görünümü (ön / arka / detay / diğer) seçin.");
    if (!input.artworkConfirmed) {
      throw new DriveValidationError(
        input.theme === "anime"
          ? "Anime: düz turuncu tişört yeterli değildir. Basılı Anime tasarımının görselde birebir doğru göründüğünü onaylayın."
          : "Basılı tasarımın görselde birebir doğru göründüğünü onaylayın.",
      );
    }
    row = await q1<DriveReference>(
      `UPDATE drive_references SET status = 'verified', theme = $3, view = $4, artwork_confirmed = true, notes = $5, verified_by = $6, verified_at = now(), updated_at = now()
       WHERE id = $1 AND brand_id = $2 RETURNING *`,
      [refId, brandId, input.theme, input.view, notes, actor],
    );
  } else if (input.action === "reject") {
    row = await q1<DriveReference>(
      `UPDATE drive_references SET status = 'rejected', artwork_confirmed = false, notes = COALESCE($3, notes), verified_by = $4, verified_at = now(), updated_at = now()
       WHERE id = $1 AND brand_id = $2 RETURNING *`,
      [refId, brandId, notes, actor],
    );
  } else {
    row = await q1<DriveReference>(
      `UPDATE drive_references SET status = 'uncertain', artwork_confirmed = false, verified_by = NULL, verified_at = NULL, updated_at = now()
       WHERE id = $1 AND brand_id = $2 RETURNING *`,
      [refId, brandId],
    );
  }
  await audit({
    brandId, actor, action: `drive.reference_${input.action}`,
    message: `Drive referansı ${input.action === "verify" ? `doğrulandı (${THEME_INFO[input.theme as FribeeTheme].label}, ${VIEW_LABEL[input.view as ReferenceView]})` : input.action === "reject" ? "reddedildi" : "incelemeye geri alındı"}: ${ref.item_name}`,
    data: { referenceId: refId },
  });
  return row!;
}

/**
 * Doğrulanmış referansın Drive önizlemesini (en çok 1600 px) medya arşivine fotoğraf olarak alır; böylece Video/Görsel
 * Stüdyosu'nda ürün referansı olarak seçilebilir. Orijinal dosya indirilmez. Ücretli görsel analiz tetiklenmez.
 */
export async function importReferencePreview(brandId: string, refId: string) {
  if (!isUuid(refId)) throw new DriveValidationError("Referans bulunamadı.");
  const ref = await q1<DriveReference & DriveItem & { ref_id: string }>(
    `SELECT r.id AS ref_id, r.status, r.theme, r.view, r.media_asset_id, i.file_id, i.name, i.mime_type, i.has_thumbnail, i.state
     FROM drive_references r JOIN drive_items i ON i.id = r.item_id AND i.brand_id = r.brand_id WHERE r.id = $1 AND r.brand_id = $2`,
    [refId, brandId],
  );
  if (!ref) throw new DriveValidationError("Referans bulunamadı.");
  if (ref.status !== "verified" || !ref.theme) throw new DriveValidationError("Yalnızca sahibin doğruladığı referanslar içe aktarılabilir.");
  if (ref.state === "removed") throw new DriveValidationError("Dosya Drive'da artık yok.");
  if (!SUPPORTED_PREVIEW.test(ref.mime_type) || !ref.has_thumbnail) throw new DriveValidationError("Bu dosya için Drive önizlemesi yok.");
  if (ref.media_asset_id) {
    const exists = await q1(`SELECT 1 FROM media_assets WHERE id = $1 AND brand_id = $2`, [ref.media_asset_id, brandId]);
    if (exists) return { assetId: ref.media_asset_id, duplicate: true };
  }
  const buf = await fetchThumbnail(await thumbnailLink(brandId, ref.file_id), tokenProvider(brandId), 1600);
  const base = ref.name.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 120);
  const { asset, duplicate } = await uploadMedia(
    brandId,
    { buffer: buf, filename: `drive-${base}` },
    {
      kind: "photo", origin: "real_photo", themes: [ref.theme], shotType: ref.view,
      rightsStatus: "owned", rightsNote: `Google Drive arşivinden doğrulanmış referans (önizleme, Drive dosyası ${ref.file_id}).`,
      tags: ["drive-referans", `tema:${ref.theme}`, `görünüm:${ref.view}`],
      vision: false,
    },
  );
  await q(`UPDATE drive_references SET media_asset_id = $3, updated_at = now() WHERE id = $1 AND brand_id = $2`, [refId, brandId, asset.id]);
  await audit({ brandId, actor: "user", action: "drive.reference_import", message: `Doğrulanmış Drive referansı medya arşivine alındı: ${ref.name}`, data: { referenceId: refId, assetId: asset.id } });
  return { assetId: asset.id, duplicate };
}

/** Doğrulanmamış (uncertain/rejected) Drive referansına bağlı medya kimlikleri: bunlar hiçbir AI isteğine giremez. */
export async function unverifiedDriveAssetIds(brandId: string, assetIds: string[], db: Queryable = getPool()) {
  const ids = assetIds.filter(isUuid);
  if (!ids.length) return [];
  const rows = await q<{ media_asset_id: string }>(
    `SELECT media_asset_id FROM drive_references WHERE brand_id = $1 AND media_asset_id = ANY($2::uuid[]) AND status <> 'verified'`,
    [brandId, ids],
    db,
  );
  return rows.map((r) => r.media_asset_id);
}

export type VerifiedReference = { reference_id: string; theme: FribeeTheme; theme_label: string; view: ReferenceView; name: string; path: string | null; media_asset_id: string | null; notes: string | null };

/** Bilgi Merkezi: doğrulanmış referanslar (arama, tema filtresi). Tüm ajanlara ve stüdyolara aynı kaynak. */
export async function verifiedReferences(brandId: string, opts: { search?: string; theme?: string; limit?: number } = {}, db: Queryable = getPool()): Promise<VerifiedReference[]> {
  const search = (opts.search ?? "").trim().slice(0, 100);
  const rows = await q<{ id: string; theme: FribeeTheme; view: ReferenceView; name: string; path: string | null; media_asset_id: string | null; notes: string | null }>(
    `SELECT r.id, r.theme, r.view, i.name, i.path, r.media_asset_id, r.notes
     FROM drive_references r JOIN drive_items i ON i.id = r.item_id AND i.brand_id = r.brand_id
     WHERE r.brand_id = $1 AND r.status = 'verified' AND i.state <> 'removed'
       AND ($2::text IS NULL OR r.theme = $2)
       AND ($3::text = '' OR i.name ILIKE '%' || $3 || '%' OR i.path ILIKE '%' || $3 || '%' OR r.notes ILIKE '%' || $3 || '%')
     ORDER BY r.theme, r.view, r.verified_at DESC LIMIT $4`,
    [brandId, isTheme(opts.theme) ? opts.theme : null, search.replace(/[%_\\]/g, (c) => `\\${c}`), Math.min(200, opts.limit ?? 60)],
    db,
  );
  return rows.map((r) => ({ reference_id: r.id, theme: r.theme, theme_label: THEME_INFO[r.theme].label, view: r.view, name: r.name, path: r.path, media_asset_id: r.media_asset_id, notes: r.notes }));
}

/** Ajan bağlamı için kısa liste (metin üst verisi; görsel içeriği veya Drive belirteci içermez). */
export async function archiveReferencesFor(brandId: string, db: Queryable = getPool()) {
  const refs = await verifiedReferences(brandId, { limit: 60 }, db);
  return refs.map((r) => ({ reference_id: r.reference_id, theme: r.theme_label, view: VIEW_LABEL[r.view], file: r.name, ...(r.media_asset_id ? { media_asset_id: r.media_asset_id } : {}), ...(r.notes ? { notes: r.notes } : {}) }));
}

// ---------------------------------------------------------------- Pano ve arama

export async function searchDriveItems(
  brandId: string,
  f: { search?: string; filter?: "images" | "all" | "pending" | "malformed" | "removed" | "duplicates" | "uncertain"; limit?: number; offset?: number } = {},
) {
  const search = (f.search ?? "").trim().slice(0, 100).replace(/[%_\\]/g, (c) => `\\${c}`);
  const filter = f.filter ?? "images";
  const where = {
    images: `NOT i.is_folder AND i.mime_type LIKE 'image/%' AND i.state <> 'removed'`,
    all: `i.state <> 'removed'`,
    pending: `i.state = 'pending_checksum'`,
    malformed: `i.state = 'malformed'`,
    removed: `i.state = 'removed'`,
    duplicates: `NOT i.is_folder AND i.state = 'indexed' AND i.md5_checksum IS NOT NULL AND EXISTS (SELECT 1 FROM drive_items d WHERE d.source_id = i.source_id AND d.id <> i.id AND d.md5_checksum = i.md5_checksum AND d.size_bytes IS NOT DISTINCT FROM i.size_bytes AND d.state = 'indexed')`,
    uncertain: `r.status = 'uncertain'`,
  }[filter];
  return q<DriveItem & { ref_id: string | null; ref_status: string | null; ref_theme: FribeeTheme | null; ref_view: ReferenceView | null; ref_confidence: number | null; ref_reasons: string[] | null; ref_asset: string | null; ref_artwork: boolean | null }>(
    `SELECT i.*, r.id AS ref_id, r.status AS ref_status, r.theme AS ref_theme, r.view AS ref_view, r.suggestion_confidence AS ref_confidence,
            r.suggestion_detail->'reasons' AS ref_reasons, r.media_asset_id AS ref_asset, r.artwork_confirmed AS ref_artwork
     FROM drive_items i LEFT JOIN drive_references r ON r.item_id = i.id AND r.brand_id = i.brand_id
     WHERE i.brand_id = $1 AND ${where} AND ($2::text = '' OR i.name ILIKE '%' || $2 || '%' OR i.path ILIKE '%' || $2 || '%')
     ORDER BY ${filter === "duplicates" ? "i.md5_checksum, i.path" : "i.path NULLS LAST, i.name"} LIMIT $3 OFFSET $4`,
    [brandId, search, Math.min(200, f.limit ?? 50), Math.max(0, f.offset ?? 0)],
  );
}

export async function driveDashboard(brandId: string) {
  const source = await getDriveSource(brandId);
  if (!source) return null;
  const [counts, dup, refs, runs] = await Promise.all([
    q1<{ folders: number; files: number; images: number; pending: number; malformed: number; removed: number; bytes: string | null }>(
      `SELECT count(*) FILTER (WHERE is_folder AND state <> 'removed')::int AS folders,
              count(*) FILTER (WHERE NOT is_folder AND state = 'indexed')::int AS files,
              count(*) FILTER (WHERE NOT is_folder AND state <> 'removed' AND mime_type LIKE 'image/%')::int AS images,
              count(*) FILTER (WHERE state = 'pending_checksum')::int AS pending,
              count(*) FILTER (WHERE state = 'malformed')::int AS malformed,
              count(*) FILTER (WHERE state = 'removed')::int AS removed,
              sum(size_bytes) FILTER (WHERE NOT is_folder AND state IN ('indexed','pending_checksum'))::text AS bytes
       FROM drive_items WHERE source_id = $1`,
      [source.id],
    ),
    q1<{ groups: number; extra: number }>(
      `SELECT count(*)::int AS groups, COALESCE(sum(n - 1), 0)::int AS extra FROM (
         SELECT count(*) AS n FROM drive_items WHERE source_id = $1 AND NOT is_folder AND state = 'indexed' AND md5_checksum IS NOT NULL
         GROUP BY md5_checksum, size_bytes HAVING count(*) > 1) g`,
      [source.id],
    ),
    q1<{ uncertain: number; verified: number; rejected: number; imported: number }>(
      `SELECT count(*) FILTER (WHERE status = 'uncertain')::int AS uncertain, count(*) FILTER (WHERE status = 'verified')::int AS verified,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected, count(*) FILTER (WHERE media_asset_id IS NOT NULL)::int AS imported
       FROM drive_references WHERE brand_id = $1`,
      [brandId],
    ),
    q<{ id: string; kind: string; status: string; pages: number; items_seen: number; items_upserted: number; items_removed: number; malformed: number; api_calls: number; retries: number; error: string | null; started_at: string; finished_at: string | null }>(
      `SELECT id, kind, status, pages, items_seen, items_upserted, items_removed, malformed, api_calls, retries, error, started_at, finished_at
       FROM drive_scan_runs WHERE source_id = $1 ORDER BY started_at DESC LIMIT 10`,
      [source.id],
    ),
  ]);
  const ageMin = source.last_success_at ? Math.round((Date.now() - Date.parse(source.last_success_at)) / 60_000) : null;
  const staleAfter = config.googleDrive.scanIntervalMinutes * 3;
  return {
    source,
    queueLength: source.full_scan_state?.queue?.length ?? 0,
    phase: !source.folder_id ? "awaiting_folder" : !source.full_scan_completed_at ? "initial_scan" : (source.full_scan_state?.queue?.length ?? 0) > 0 ? "subfolder_scan" : "incremental",
    counts: counts!,
    duplicates: dup!,
    references: refs!,
    runs,
    failedRuns: runs.filter((r) => r.status === "failed").length,
    freshness: { ageMinutes: ageMin, stale: ageMin === null || ageMin > staleAfter, staleAfterMinutes: staleAfter },
  };
}
