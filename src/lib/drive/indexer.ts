import { q, q1 } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { log } from "@/lib/log";
import { DRIVE_ID_RE, DriveAuthError, FOLDER_MIME, driveGet, type CallStats, type TokenProvider } from "./google";
import { markReauth, safeError, tokenProvider, type DriveSource, type FullScanState, type QueueEntry } from "./source";

// Artımlı Drive dizinleyici. Yalnızca üst veri okunur; dosya içeriği indirilmez ve hiçbir şey yazılmaz.
//
// 1) İlk tarama (kaldığı yerden devam eder): seçili klasörden genişlik öncelikli gezinme. Kuyruk ve sayfa belirteci her
//    sayfadan sonra veritabanına yazılır; işleyici çökse/yeniden başlasa bile aynı sayfadan sürer.
// 2) Taramaya başlamadan önce Changes API başlangıç belirteci alınır; ilk tarama sırasında (ör. yükleme sürerken)
//    eklenen dosyalar daha sonra değişiklik akışından yakalanır.
// 3) Sonraki taramalar yalnızca değişiklikleri okur (changes.list). Klasör dışındaki değişiklikler saklanmaz.
// 4) Her turda en fazla `pagesPerTick` sayfa (kota koruması). Hata durumunda üstel geri çekilme ile yeniden planlanır.

export const FILE_FIELDS =
  "id,name,mimeType,parents,size,md5Checksum,sha1Checksum,sha256Checksum,createdTime,modifiedTime,version,trashed,hasThumbnail,imageMediaMetadata(width,height)";
const MAX_DEPTH = 64;
const MAX_QUEUE = 200_000;
const LOCK_MINUTES = 30;

export type ItemState = "indexed" | "pending_checksum" | "malformed" | "removed";

export type NormalizedItem = {
  file_id: string;
  name: string;
  mime_type: string;
  is_folder: boolean;
  parent_ids: string[];
  size_bytes: number | null;
  md5_checksum: string | null;
  sha1_checksum: string | null;
  sha256_checksum: string | null;
  created_time: string | null;
  modified_time: string | null;
  version: number | null;
  has_thumbnail: boolean;
  image_width: number | null;
  image_height: number | null;
  state: ItemState;
  state_detail: string | null;
  trashed: boolean;
};

function isoOrBad(v: unknown, problems: string[], field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) {
    problems.push(`geçersiz ${field}`);
    return null;
  }
  return new Date(v).toISOString();
}

function hex(v: unknown, len: number) {
  return typeof v === "string" && new RegExp(`^[a-f0-9]{${len}}$`, "i").test(v) ? v.toLowerCase() : null;
}

function posInt(v: unknown): number | null {
  const n = typeof v === "string" && /^\d{1,16}$/.test(v) ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Drive API'den gelen tek öğeyi doğrular. Kimliği olmayan öğe kaydedilemez (ok: false). Diğer bozuk alanlar öğeyi
 * "malformed" durumunda kaydeder; tarama durmaz.
 */
export function normalizeFile(raw: unknown): { ok: true; item: NormalizedItem } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "öğe nesne değil" };
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== "string" || !DRIVE_ID_RE.test(f.id)) return { ok: false, reason: "geçersiz veya eksik kimlik" };
  const problems: string[] = [];
  let name = typeof f.name === "string" ? f.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 1000) : "";
  if (!name) {
    problems.push("ad yok");
    name = `(adsız ${f.id})`;
  }
  let mime = typeof f.mimeType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(f.mimeType) ? f.mimeType : "";
  if (!mime) {
    problems.push("tür (mimeType) yok");
    mime = "application/octet-stream";
  }
  const isFolder = mime === FOLDER_MIME;
  let size: number | null = null;
  if (f.size !== undefined && f.size !== null) {
    size = posInt(f.size);
    if (size === null) problems.push("geçersiz boyut");
  }
  const parents = Array.isArray(f.parents) ? f.parents.filter((p): p is string => typeof p === "string" && DRIVE_ID_RE.test(p)).slice(0, 20) : [];
  const created = isoOrBad(f.createdTime, problems, "oluşturma tarihi");
  const modified = isoOrBad(f.modifiedTime, problems, "değişiklik tarihi");
  const md5 = hex(f.md5Checksum, 32);
  const sha1 = hex(f.sha1Checksum, 40);
  const sha256 = hex(f.sha256Checksum, 64);
  const img = f.imageMediaMetadata && typeof f.imageMediaMetadata === "object" ? (f.imageMediaMetadata as Record<string, unknown>) : {};
  const nativeDoc = mime.startsWith("application/vnd.google-apps.");
  let state: ItemState = "indexed";
  let detail: string | null = null;
  if (problems.length) {
    state = "malformed";
    detail = problems.join(", ");
  } else if (!isFolder && !nativeDoc && (size === null || (!md5 && !sha256))) {
    // İkili dosyada boyut/özet yoksa yükleme sürüyor veya Drive dosyayı hâlâ işliyor olabilir; sonraki taramada tamamlanır.
    state = "pending_checksum";
    detail = "Drive boyut/özet bilgisi henüz yok (yükleme veya işleme sürüyor olabilir).";
  }
  return {
    ok: true,
    item: {
      file_id: f.id, name, mime_type: mime, is_folder: isFolder, parent_ids: parents, size_bytes: size,
      md5_checksum: md5, sha1_checksum: sha1, sha256_checksum: sha256, created_time: created, modified_time: modified,
      version: posInt(f.version), has_thumbnail: f.hasThumbnail === true, image_width: posInt(img.width), image_height: posInt(img.height),
      state, state_detail: detail, trashed: f.trashed === true,
    },
  };
}

type Row = NormalizedItem & { path: string | null; depth: number | null };

/** Toplu ekle/güncelle. Aynı dosya bir sayfada iki kez gelirse sonuncusu geçerlidir. Eklenen satır sayısını döner. */
async function upsertItems(src: DriveSource, rows: Row[]): Promise<{ upserted: number; inserted: number }> {
  if (!rows.length) return { upserted: 0, inserted: 0 };
  const unique = [...new Map(rows.map((r) => [r.file_id, r])).values()].map(({ trashed: _t, ...r }) => r);
  const res = await q<{ inserted: boolean }>(
    `INSERT INTO drive_items (brand_id, source_id, file_id, name, mime_type, is_folder, parent_ids, path, depth, size_bytes, md5_checksum, sha1_checksum,
       sha256_checksum, created_time, modified_time, version, has_thumbnail, image_width, image_height, state, state_detail)
     SELECT $1, $2, x.file_id, x.name, x.mime_type, x.is_folder, x.parent_ids, x.path, x.depth, x.size_bytes, x.md5_checksum, x.sha1_checksum,
            x.sha256_checksum, x.created_time, x.modified_time, x.version, x.has_thumbnail, x.image_width, x.image_height, x.state, x.state_detail
     FROM jsonb_to_recordset($3::jsonb) AS x(file_id text, name text, mime_type text, is_folder boolean, parent_ids text[], path text, depth int,
            size_bytes bigint, md5_checksum text, sha1_checksum text, sha256_checksum text, created_time timestamptz, modified_time timestamptz,
            version bigint, has_thumbnail boolean, image_width int, image_height int, state text, state_detail text)
     ON CONFLICT (source_id, file_id) DO UPDATE SET
       name = EXCLUDED.name, mime_type = EXCLUDED.mime_type, is_folder = EXCLUDED.is_folder, parent_ids = EXCLUDED.parent_ids,
       path = EXCLUDED.path, depth = EXCLUDED.depth, size_bytes = EXCLUDED.size_bytes, md5_checksum = EXCLUDED.md5_checksum,
       sha1_checksum = EXCLUDED.sha1_checksum, sha256_checksum = EXCLUDED.sha256_checksum, created_time = EXCLUDED.created_time,
       modified_time = EXCLUDED.modified_time, version = EXCLUDED.version, has_thumbnail = EXCLUDED.has_thumbnail,
       image_width = EXCLUDED.image_width, image_height = EXCLUDED.image_height, state = EXCLUDED.state, state_detail = EXCLUDED.state_detail,
       last_seen_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [src.brand_id, src.id, JSON.stringify(unique.map((r) => ({ ...r, parent_ids: r.parent_ids })))],
  );
  return { upserted: res.length, inserted: res.filter((r) => r.inserted).length };
}

/** Öğeleri ve (klasörse) tüm alt öğelerini "removed" yapar. Drive'daki dosyalara dokunulmaz; yalnızca yerel dizin. */
async function markRemoved(src: DriveSource, fileIds: string[], detail: string): Promise<number> {
  if (!fileIds.length) return 0;
  const r = await q<{ file_id: string }>(
    `WITH RECURSIVE d AS (
       SELECT file_id FROM drive_items WHERE source_id = $1 AND file_id = ANY($2::text[])
       UNION
       SELECT i.file_id FROM drive_items i JOIN d ON i.parent_ids @> ARRAY[d.file_id] WHERE i.source_id = $1
     )
     UPDATE drive_items SET state = 'removed', state_detail = $3, last_seen_at = now()
     WHERE source_id = $1 AND file_id IN (SELECT file_id FROM d) AND state <> 'removed' RETURNING file_id`,
    [src.id, fileIds, detail],
  );
  return r.length;
}

/** Yeniden adlandırılan/taşınan klasörlerin alt öğelerinin yol bilgisini günceller. */
async function rewritePaths(src: DriveSource, changes: { oldPath: string; newPath: string; newDepth: number; oldDepth: number }[]) {
  for (const c of changes) {
    await q(
      `UPDATE drive_items SET path = $3 || substr(path, length($2) + 1), depth = depth + ($4::int - $5::int)
       WHERE source_id = $1 AND left(path, length($2) + 1) = $2 || '/'`,
      [src.id, c.oldPath, c.newPath, c.newDepth, c.oldDepth],
    );
  }
}

export type ScanStats = CallStats & { pages: number; seen: number; upserted: number; removed: number; malformed: number };

type Ctx = { src: DriveSource; token: TokenProvider; stats: ScanStats; workerId: string };

/** Kilit süresi dolup kaynağı başka bir işleyici aldıysa bu tur hiçbir şey yazmadan durur. */
export class DriveLockLostError extends Error {}

async function saveSource(ctx: Ctx, patch: Partial<DriveSource>) {
  const { src } = ctx;
  const keys = Object.keys(patch) as (keyof DriveSource)[];
  const sets = keys.map((k, i) => `${String(k)} = $${i + 3}`);
  const r = await q1<{ id: string }>(
    `UPDATE drive_sources SET ${sets.join(", ")}, lock_expires_at = now() + interval '${LOCK_MINUTES} minutes', updated_at = now()
     WHERE id = $1 AND lock_owner = $2 RETURNING id`,
    [src.id, ctx.workerId, ...keys.map((k) => (k === "full_scan_state" ? JSON.stringify(patch[k]) : patch[k]))],
  );
  if (!r) throw new DriveLockLostError("Tarama kilidi kaybedildi (başka işleyici devraldı veya bağlantı kaldırıldı).");
  Object.assign(src, patch);
}

/**
 * Tam tarama bitti: bu taramada görülmeyen öğeler Drive'da artık yok (bağlantı kopukken silinmiş/taşınmış olabilir).
 * Yerel dizinde "removed" yapılır; Drive'a dokunulmaz.
 */
async function completeFullScan(ctx: Ctx) {
  const { src, stats } = ctx;
  if (src.full_scan_started_at) {
    const gone = await q<{ id: string }>(
      `UPDATE drive_items SET state = 'removed', state_detail = $3
       WHERE source_id = $1 AND state <> 'removed' AND last_seen_at < $2 RETURNING id`,
      [src.id, src.full_scan_started_at, "Tam taramada bulunamadı (Drive'da silinmiş veya klasör dışına taşınmış)."],
    );
    stats.removed += gone.length;
  }
  await saveSource(ctx, { full_scan_completed_at: new Date().toISOString() });
}

const sharedDriveParams = (src: DriveSource) => (src.drive_id ? { driveId: src.drive_id } : {});

/** İlk tarama hazırlığı: değişiklik akışının başlangıç belirteci (taramadan ÖNCE alınır ki tarama sırasında olanlar kaçmasın). */
async function initFullScan(ctx: Ctx) {
  const { src } = ctx;
  const r = await driveGet<{ startPageToken?: string }>("/changes/startPageToken", { supportsAllDrives: true, ...sharedDriveParams(src) }, ctx.token, ctx.stats);
  if (typeof r.startPageToken !== "string" || !r.startPageToken) throw new Error("Drive değişiklik başlangıç belirteci alınamadı.");
  const queue = src.full_scan_state.queue?.length ? src.full_scan_state.queue : [{ id: src.folder_id!, path: src.folder_name ?? "", depth: 0 }];
  // Saat farkı olmasın diye başlangıç zamanı veritabanından alınır (last_seen_at ile aynı saat).
  const now = (await q1<{ t: string }>(`SELECT now()::text AS t`))!.t;
  await saveSource(ctx, { changes_page_token: r.startPageToken, full_scan_started_at: now, full_scan_completed_at: null, full_scan_state: { queue, pageToken: null } });
}

/** Kuyruğun başındaki klasörün bir sayfası. */
async function fullScanPage(ctx: Ctx) {
  const { src, stats } = ctx;
  const state: FullScanState = { queue: [...(src.full_scan_state.queue ?? [])], pageToken: src.full_scan_state.pageToken ?? null };
  const head = state.queue![0];
  if (!head || !DRIVE_ID_RE.test(head.id)) {
    state.queue!.shift();
    await saveSource(ctx, { full_scan_state: { queue: state.queue, pageToken: null } });
    return;
  }
  const r = await driveGet<{ files?: unknown; nextPageToken?: string }>(
    "/files",
    {
      q: `'${head.id}' in parents and trashed = false`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: 1000, pageToken: state.pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
      ...(src.drive_id ? { corpora: "drive", driveId: src.drive_id } : {}),
    },
    ctx.token,
    stats,
  );
  stats.pages++;
  const files = Array.isArray(r.files) ? r.files : [];
  if (!Array.isArray(r.files)) stats.malformed++;
  const rows: Row[] = [];
  const queued = new Set(state.queue!.map((e) => e.id));
  const subfolders: QueueEntry[] = [];
  for (const raw of files) {
    stats.seen++;
    const n = normalizeFile(raw);
    if (!n.ok) {
      stats.malformed++;
      continue;
    }
    if (n.item.state === "malformed") stats.malformed++;
    const path = `${head.path}/${n.item.name}`.slice(0, 4000);
    rows.push({ ...n.item, path, depth: head.depth + 1 });
    if (n.item.is_folder && n.item.state !== "malformed" && head.depth + 1 < MAX_DEPTH && !queued.has(n.item.file_id) && state.queue!.length + subfolders.length < MAX_QUEUE) {
      queued.add(n.item.file_id);
      subfolders.push({ id: n.item.file_id, path, depth: head.depth + 1 });
    }
  }
  const u = await upsertItems(src, rows);
  stats.upserted += u.upserted;
  state.queue!.push(...subfolders);
  if (typeof r.nextPageToken === "string" && r.nextPageToken) state.pageToken = r.nextPageToken;
  else {
    state.queue!.shift();
    state.pageToken = null;
  }
  await saveSource(ctx, { full_scan_state: state });
}

type ChangeRec = { fileId: string; removed: boolean; file: unknown };

/** Değişiklik akışının bir sayfası. Döner: güncel mi (newStartPageToken alındı). */
async function changesPage(ctx: Ctx): Promise<{ caughtUp: boolean; rootGone: boolean }> {
  const { src, stats } = ctx;
  const r = await driveGet<{ changes?: unknown; nextPageToken?: string; newStartPageToken?: string }>(
    "/changes",
    {
      pageToken: src.changes_page_token, pageSize: 1000, includeRemoved: true, spaces: "drive", supportsAllDrives: true, includeItemsFromAllDrives: true,
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
      ...sharedDriveParams(src),
    },
    ctx.token,
    stats,
  );
  stats.pages++;
  const raw = Array.isArray(r.changes) ? r.changes : [];
  const changes: ChangeRec[] = [];
  for (const c of raw) {
    const o = c && typeof c === "object" ? (c as Record<string, unknown>) : null;
    const fileId = typeof o?.fileId === "string" && DRIVE_ID_RE.test(o.fileId) ? o.fileId : null;
    if (!o || !fileId) {
      stats.malformed++;
      continue;
    }
    changes.push({ fileId, removed: o.removed === true, file: o.file });
  }
  stats.seen += changes.length;

  // Klasör içinde olup olmadığı yalnızca bilinen (dizinlenmiş, kaldırılmamış) klasörlere göre belirlenir.
  const folders = new Map<string, { path: string; depth: number }>([[src.folder_id!, { path: src.folder_name ?? "", depth: 0 }]]);
  for (const f of await q<{ file_id: string; path: string | null; depth: number | null }>(
    `SELECT file_id, path, depth FROM drive_items WHERE source_id = $1 AND is_folder AND state <> 'removed'`,
    [src.id],
  )) folders.set(f.file_id, { path: f.path ?? "", depth: f.depth ?? 1 });

  let rootGone = false;
  const removedIds: string[] = [];
  const rows: Row[] = [];
  const newFolders: QueueEntry[] = [];
  const pending = new Map<string, { change: ChangeRec; item: NormalizedItem }>();
  for (const c of changes) {
    if (c.fileId === src.folder_id) {
      const n = c.file ? normalizeFile(c.file) : null;
      if (c.removed || !n || (n.ok && n.item.trashed)) rootGone = true;
      continue;
    }
    if (c.removed || !c.file) {
      removedIds.push(c.fileId);
      continue;
    }
    const n = normalizeFile(c.file);
    if (!n.ok) {
      stats.malformed++;
      continue;
    }
    if (n.item.trashed) {
      removedIds.push(c.fileId);
      continue;
    }
    pending.set(c.fileId, { change: c, item: n.item });
  }
  // Aynı sayfada yeni klasör ve içindekiler herhangi bir sırayla gelebilir: ilerleme oldukça tekrar geç.
  let progress = true;
  while (progress && pending.size) {
    progress = false;
    for (const [id, { item }] of pending) {
      const parent = item.parent_ids.find((p) => folders.has(p));
      if (!parent) continue;
      const p = folders.get(parent)!;
      const path = `${p.path}/${item.name}`.slice(0, 4000);
      if (item.state === "malformed") stats.malformed++;
      rows.push({ ...item, path, depth: p.depth + 1 });
      if (item.is_folder && item.state !== "malformed" && !folders.has(id)) {
        folders.set(id, { path, depth: p.depth + 1 });
        if (p.depth + 1 < MAX_DEPTH) newFolders.push({ id, path, depth: p.depth + 1 });
      }
      pending.delete(id);
      progress = true;
    }
  }
  // Bilinen bir klasörün altında olmayanlar: dizindeyse klasör dışına taşınmıştır; değilse hiç saklanmaz.
  removedIds.push(...pending.keys());

  // Yeniden adlandırılan/taşınan klasörler için eski yollar
  const folderRows = rows.filter((r) => r.is_folder);
  const before = folderRows.length
    ? await q<{ file_id: string; path: string | null; depth: number | null; state: string }>(
        `SELECT file_id, path, depth, state FROM drive_items WHERE source_id = $1 AND file_id = ANY($2::text[])`,
        [src.id, folderRows.map((r) => r.file_id)],
      )
    : [];
  const u = await upsertItems(src, rows);
  stats.upserted += u.upserted;
  const moved = before
    .map((b) => ({ b, now: folderRows.find((r) => r.file_id === b.file_id)! }))
    .filter(({ b, now }) => b.path && b.state !== "removed" && now.path && b.path !== now.path)
    .map(({ b, now }) => ({ oldPath: b.path!, newPath: now.path!, oldDepth: b.depth ?? 0, newDepth: now.depth ?? 0 }));
  await rewritePaths(src, moved);
  // Çöpten geri gelen klasörlerin içi de yeniden taranmalı (alt öğeler için ayrı değişiklik gelmeyebilir)
  for (const b of before) if (b.state === "removed" && !newFolders.some((f) => f.id === b.file_id)) {
    const r = folderRows.find((x) => x.file_id === b.file_id)!;
    if (r.state !== "malformed") newFolders.push({ id: r.file_id, path: r.path ?? "", depth: r.depth ?? 1 });
  }
  stats.removed += await markRemoved(src, removedIds, "Drive'da silindi, çöpe taşındı veya seçili klasörün dışına taşındı.");

  const patch: Partial<DriveSource> = {};
  if (newFolders.length) {
    const queue = [...(src.full_scan_state.queue ?? [])];
    const inQueue = new Set(queue.map((e) => e.id));
    for (const f of newFolders) if (!inQueue.has(f.id) && queue.length < MAX_QUEUE) queue.push(f);
    patch.full_scan_state = { queue, pageToken: src.full_scan_state.pageToken ?? null };
  }
  let caughtUp = false;
  if (typeof r.nextPageToken === "string" && r.nextPageToken) patch.changes_page_token = r.nextPageToken;
  else if (typeof r.newStartPageToken === "string" && r.newStartPageToken) {
    patch.changes_page_token = r.newStartPageToken;
    caughtUp = true;
  } else {
    throw new Error("Drive değişiklik yanıtında sayfa belirteci yok; belirteç korunarak daha sonra tekrar denenecek.");
  }
  await saveSource(ctx, patch);
  return { caughtUp, rootGone };
}

export type ScanResult = { sourceId: string; brandId: string; status: "completed" | "partial" | "failed"; stats: ScanStats; error?: string };

/** Taraması gelmiş tek bir kaynağı kilitler (birden çok işleyici aynı kaynağı taramaz). */
async function claimSource(workerId: string, brandId?: string) {
  return q1<DriveSource>(
    `UPDATE drive_sources SET lock_owner = $1, lock_expires_at = now() + interval '${LOCK_MINUTES} minutes', last_scan_started_at = now()
     WHERE id = (
       SELECT id FROM drive_sources
       WHERE status = 'active' AND folder_id IS NOT NULL AND (next_scan_at IS NULL OR next_scan_at <= now())
         AND (lock_expires_at IS NULL OR lock_expires_at < now()) AND ($2::uuid IS NULL OR brand_id = $2)
       ORDER BY next_scan_at NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [workerId, brandId ?? null],
  );
}

/**
 * İşleyici turu: taraması gelmiş bir kaynakta en fazla `pages` sayfa işler. Taranacak kaynak yoksa null.
 * Ücretli hiçbir servis çağrılmaz; yalnızca Google Drive üst veri uç noktaları.
 */
export async function runDriveScanOnce(workerId: string, opts: { pages?: number; brandId?: string } = {}): Promise<ScanResult | null> {
  const src = await claimSource(workerId, opts.brandId);
  if (!src) return null;
  src.full_scan_state = src.full_scan_state ?? {};
  const stats: ScanStats = { calls: 0, retries: 0, pages: 0, seen: 0, upserted: 0, removed: 0, malformed: 0 };
  const kind = !src.full_scan_completed_at || (src.full_scan_state.queue?.length ?? 0) > 0 ? "full" : "incremental";
  const run = (await q1<{ id: string }>(`INSERT INTO drive_scan_runs (brand_id, source_id, kind) VALUES ($1,$2,$3) RETURNING id`, [src.brand_id, src.id, kind]))!;
  const ctx: Ctx = { src, token: tokenProvider(src.brand_id), stats, workerId };
  const budget = Math.max(1, opts.pages ?? config.googleDrive.pagesPerTick);
  const finishRun = (status: string, error: string | null) =>
    q(
      `UPDATE drive_scan_runs SET status = $2, pages = $3, items_seen = $4, items_upserted = $5, items_removed = $6, malformed = $7, api_calls = $8, retries = $9,
         error = $10, finished_at = now() WHERE id = $1`,
      [run.id, status, stats.pages, stats.seen, stats.upserted, stats.removed, stats.malformed, stats.calls, stats.retries, error],
    );
  try {
    if (!src.full_scan_started_at || !src.changes_page_token) await initFullScan(ctx);
    let caughtUp = false;
    let rootGone = false;
    while (stats.pages < budget && !rootGone) {
      if ((src.full_scan_state.queue?.length ?? 0) > 0) {
        await fullScanPage(ctx);
        continue;
      }
      if (!src.full_scan_completed_at) await completeFullScan(ctx);
      if (caughtUp) break;
      const c = await changesPage(ctx);
      caughtUp = c.caughtUp;
      rootGone = c.rootGone;
    }
    if (!rootGone && (src.full_scan_state.queue?.length ?? 0) === 0 && !src.full_scan_completed_at) await completeFullScan(ctx);
    const more = !rootGone && ((src.full_scan_state.queue?.length ?? 0) > 0 || !caughtUp);
    const status = more ? "partial" : "completed";
    if (rootGone) {
      await q(
        `UPDATE drive_sources SET status = 'paused', last_error = $2, lock_owner = NULL, lock_expires_at = NULL, last_scan_finished_at = now(), updated_at = now() WHERE id = $1 AND lock_owner = $3`,
        [src.id, "Seçili arşiv klasörü Drive'da silinmiş, çöpe taşınmış veya erişim kaldırılmış. Klasörü kontrol edip taramayı sürdürün.", workerId],
      );
    } else {
      await q(
        `UPDATE drive_sources SET last_success_at = now(), last_scan_finished_at = now(), consecutive_failures = 0, last_error = NULL,
           next_scan_at = CASE WHEN $2 THEN now() ELSE now() + make_interval(mins => $3) END, lock_owner = NULL, lock_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lock_owner = $4`,
        [src.id, more, config.googleDrive.scanIntervalMinutes, workerId],
      );
    }
    await finishRun(status, rootGone ? "Seçili klasör kaldırıldı; tarama duraklatıldı." : null);
    // Yeni ürün fotoğrafları inceleme kuyruğuna otomatik girer (öneriyle; doğrulama sahipte). Hata taramayı bozmaz.
    if (!rootGone) {
      const { autoQueueReferences } = await import("./references");
      await autoQueueReferences(src.brand_id).catch((e) => log("warn", "drive.auto_queue_failed", { brandId: src.brand_id, error: e }));
    }
    return { sourceId: src.id, brandId: src.brand_id, status, stats };
  } catch (err) {
    const msg = safeError(err);
    if (err instanceof DriveLockLostError) {
      // Kaynak artık bu işleyicinin değil: durumuna dokunulmaz.
    } else if (err instanceof DriveAuthError) {
      // Yetki yok (401/iptal): yeniden bağlanana kadar tarama planlanmaz (sürekli deneme döngüsü olmaz).
      await markReauth(src.brand_id, msg).catch(() => {});
      await q(`UPDATE drive_sources SET lock_owner = NULL, lock_expires_at = NULL, last_scan_finished_at = now(), last_error = $2, updated_at = now() WHERE id = $1 AND lock_owner = $3`, [src.id, msg, workerId]);
    } else {
      // Üstel geri çekilme: 1, 2, 4 … dk, en çok 6 saat. Tarama durumu (kuyruk/belirteç) korunur; kaldığı yerden sürer.
      await q(
        `UPDATE drive_sources SET consecutive_failures = consecutive_failures + 1, last_error = $2, last_scan_finished_at = now(),
           next_scan_at = now() + make_interval(secs => LEAST(21600, 60 * power(2, LEAST(consecutive_failures, 12)))),
           lock_owner = NULL, lock_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lock_owner = $3`,
        [src.id, msg, workerId],
      );
    }
    await finishRun("failed", msg);
    log("warn", "drive.scan_failed", { brandId: src.brand_id, error: msg });
    return { sourceId: src.id, brandId: src.brand_id, status: "failed", stats, error: msg };
  }
}
