import crypto from "node:crypto";
import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { audit } from "@/lib/audit";
import { redact } from "@/lib/security/crypto";
import { PermanentError } from "@/lib/models/types";
import { connectionCredentials, getConnection, upsertConnection } from "@/lib/services/connections";
import {
  DRIVE_ID_RE, DRIVE_SCOPES, DriveAuthError, FOLDER_MIME, driveAuthUrl, driveGet, escapeQueryValue, exchangeCode, refreshAccessToken, revokeToken,
  type CallStats, type TokenProvider,
} from "./google";

// Marka başına tek Drive kaynağı: OAuth bağlantısı (connections tablosunda, şifreli) + seçili klasör ve tarama durumu (drive_sources).
// Klasör kimliği hiçbir zaman varsayılmaz: kullanıcı yetki verdikten sonra adı eşleşen adaylar arasından açıkça seçer.

export type DriveCreds = { refresh_token: string; access_token: string; expires_at: number; scope: string };

export type QueueEntry = { id: string; path: string; depth: number };
export type FullScanState = { queue?: QueueEntry[]; pageToken?: string | null };

export type DriveSource = {
  id: string;
  brand_id: string;
  status: "awaiting_folder" | "active" | "paused" | "reauth_required" | "disconnected";
  folder_id: string | null;
  folder_name: string | null;
  drive_id: string | null;
  account_email: string | null;
  full_scan_state: FullScanState;
  full_scan_started_at: string | null;
  full_scan_completed_at: string | null;
  changes_page_token: string | null;
  last_scan_started_at: string | null;
  last_scan_finished_at: string | null;
  last_success_at: string | null;
  next_scan_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
  lock_owner: string | null;
  lock_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export class DriveValidationError extends Error {}

export async function getDriveSource(brandId: string, db: Queryable = getPool()) {
  return q1<DriveSource>(`SELECT * FROM drive_sources WHERE brand_id = $1`, [brandId], db);
}

// ---------------------------------------------------------------- OAuth

/** Tek kullanımlık, 10 dakika geçerli state (CSRF) ile yetkilendirme adresi. State markaya bağlıdır. */
export async function startDriveOAuth(brandId: string) {
  const state = crypto.randomBytes(24).toString("base64url");
  await q(`DELETE FROM oauth_states WHERE expires_at < now()`);
  await q(`INSERT INTO oauth_states (state, brand_id, provider, expires_at) VALUES ($1,$2,'google_drive', now() + interval '10 minutes')`, [state, brandId]);
  return driveAuthUrl(state);
}

/** State'i tüketir (tek kullanımlık). Geçersiz/süresi dolmuşsa null. */
export async function consumeDriveState(state: string) {
  if (!state || state.length > 200) return null;
  const row = await q1<{ brand_id: string }>(`DELETE FROM oauth_states WHERE state = $1 AND provider = 'google_drive' AND expires_at > now() RETURNING brand_id`, [state]);
  return row?.brand_id ?? null;
}

export async function completeDriveOAuth(brandId: string, code: string) {
  const t = await exchangeCode(code);
  const granted = (t.scope ?? "").split(/\s+/).filter(Boolean);
  if (!granted.includes(DRIVE_SCOPES[0])) throw new PermanentError("Gerekli izin (Drive dosyalarını görüntüleme, drive.readonly) verilmedi; bağlantı kaydedilmedi. Google izin ekranında kutuyu işaretleyip tekrar bağlanın.");
  if (!t.refresh_token) throw new PermanentError("Google yenileme belirteci vermedi. Google Hesabı → Güvenlik → Üçüncü taraf erişiminden uygulamayı kaldırıp tekrar bağlanın.");
  const creds: DriveCreds = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000, scope: granted.join(" ") };
  const about = await driveGet<{ user?: { emailAddress?: string } }>("/about", { fields: "user(emailAddress)" }, async () => creds.access_token);
  const email = typeof about.user?.emailAddress === "string" ? about.user.emailAddress.slice(0, 320) : null;
  await upsertConnection("google_drive", brandId, { status: "connected", config: { account_email: email }, credentials: creds, scopes: granted, lastError: null });
  const prev = await getDriveSource(brandId);
  if (!prev) {
    await q(`INSERT INTO drive_sources (brand_id, status, account_email) VALUES ($1,'awaiting_folder',$2) ON CONFLICT (brand_id) DO NOTHING`, [brandId, email]);
  } else if (prev.account_email && email && prev.account_email !== email) {
    // Başka Google hesabı: önceki klasöre erişim varsayılmaz; klasör yeniden seçilmeli. Dizin silinmez.
    await q(
      `UPDATE drive_sources SET status = 'awaiting_folder', account_email = $2, folder_id = NULL, folder_name = NULL, drive_id = NULL, full_scan_state = '{}'::jsonb,
         full_scan_started_at = NULL, full_scan_completed_at = NULL, changes_page_token = NULL, consecutive_failures = 0, last_error = NULL, next_scan_at = NULL, updated_at = now()
       WHERE brand_id = $1`,
      [brandId, email],
    );
  } else {
    await q(
      `UPDATE drive_sources SET status = CASE WHEN folder_id IS NULL THEN 'awaiting_folder' ELSE 'active' END, account_email = COALESCE($2, account_email),
         consecutive_failures = 0, last_error = NULL, next_scan_at = now(), updated_at = now()
       WHERE brand_id = $1`,
      [brandId, email],
    );
  }
  await audit({ brandId, actor: "user", action: "connection.google_drive", message: `Google Drive bağlandı (salt okunur${email ? `, ${email}` : ""})` });
  return { email };
}

export async function markReauth(brandId: string, message: string) {
  await upsertConnection("google_drive", brandId, { status: "reauth_required", lastError: message });
  await q(`UPDATE drive_sources SET status = 'reauth_required', last_error = $2, updated_at = now() WHERE brand_id = $1 AND status <> 'disconnected'`, [brandId, message]);
}

/** Geçerli erişim belirteci; süresi dolmak üzereyse yenileme belirteciyle yenilenir ve şifreli olarak saklanır. */
export async function driveAccessToken(brandId: string, forceRefresh = false): Promise<string> {
  const conn = await getConnection("google_drive", brandId);
  const c = connectionCredentials<DriveCreds>(conn);
  if (!conn || !c?.refresh_token || conn.status === "not_connected") throw new DriveAuthError("Google Drive bağlı değil.");
  if (conn.status === "reauth_required") throw new DriveAuthError("Google Drive yeniden yetkilendirme bekliyor.");
  if (!forceRefresh && c.access_token && c.expires_at - 60_000 > Date.now()) return c.access_token;
  try {
    const t = await refreshAccessToken(c.refresh_token);
    const next: DriveCreds = { ...c, access_token: t.access_token, expires_at: Date.now() + t.expires_in * 1000, refresh_token: t.refresh_token ?? c.refresh_token };
    await upsertConnection("google_drive", brandId, { status: "connected", credentials: next, lastError: null });
    return next.access_token;
  } catch (err) {
    if (err instanceof DriveAuthError) await markReauth(brandId, err.message);
    throw err;
  }
}

export function tokenProvider(brandId: string): TokenProvider {
  return (force = false) => driveAccessToken(brandId, force);
}

/**
 * Bağlantıyı kaldırır: Google'da izni iptal eder (revoke), şifreli belirteçleri siler, taramayı durdurur.
 * `purgeIndex` ile yalnızca bu uygulamadaki dizin kayıtları silinir; Drive'daki dosyalara hiçbir zaman dokunulmaz.
 */
export async function disconnectDrive(brandId: string, opts: { purgeIndex?: boolean } = {}) {
  const conn = await getConnection("google_drive", brandId);
  let c: DriveCreds | null = null;
  try {
    c = connectionCredentials<DriveCreds>(conn);
  } catch {
    c = null;
  }
  const revoked = c?.refresh_token ? await revokeToken(c.refresh_token) : false;
  if (conn) await upsertConnection("google_drive", brandId, { status: "not_connected", credentials: null, scopes: [], config: { account_email: null }, lastError: null });
  if (opts.purgeIndex) {
    await q(`DELETE FROM drive_sources WHERE brand_id = $1`, [brandId]);
  } else {
    await q(`UPDATE drive_sources SET status = 'disconnected', changes_page_token = NULL, next_scan_at = NULL, lock_owner = NULL, lock_expires_at = NULL, updated_at = now() WHERE brand_id = $1`, [brandId]);
  }
  await audit({
    brandId, actor: "user", action: "connection.disconnect",
    message: `Google Drive bağlantısı kaldırıldı${revoked ? " ve Google'da izin iptal edildi" : " (Google'da iptal doğrulanamadı; Google Hesabı → Üçüncü taraf erişiminden de kaldırabilirsiniz)"}${opts.purgeIndex ? "; yerel dizin silindi" : ""}`,
  });
  return { revoked };
}

// ---------------------------------------------------------------- Klasör seçimi

export type FolderCandidate = { id: string; name: string; driveId: string | null; modifiedTime: string | null; owner: string | null };

/** Yetkili hesapta adı tam eşleşen klasörler (yalnızca aday listesi; seçim kullanıcıya aittir). */
export async function findArchiveFolders(brandId: string, stats?: CallStats): Promise<FolderCandidate[]> {
  const name = config.googleDrive.folderName;
  const r = await driveGet<{ files?: { id?: string; name?: string; driveId?: string; modifiedTime?: string; owners?: { displayName?: string }[] }[] }>(
    "/files",
    {
      q: `name = '${escapeQueryValue(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id,name,driveId,modifiedTime,owners(displayName))",
      pageSize: 20, corpora: "allDrives", supportsAllDrives: true, includeItemsFromAllDrives: true,
    },
    tokenProvider(brandId),
    stats,
  );
  return (r.files ?? [])
    .filter((f) => typeof f.id === "string" && DRIVE_ID_RE.test(f.id) && f.name === name)
    .map((f) => ({ id: f.id!, name: f.name!, driveId: f.driveId ?? null, modifiedTime: f.modifiedTime ?? null, owner: f.owners?.[0]?.displayName ?? null }));
}

/**
 * Kullanıcının seçtiği klasörü doğrular ve kaydeder. Klasör olmalı, çöpte olmamalı ve adı yapılandırılan adla birebir eşleşmeli.
 * Farklı bir klasöre geçmek için önce mevcut dizin kaldırılmalıdır (inceleme kayıtları sessizce kaybolmasın).
 */
export async function selectArchiveFolder(brandId: string, folderId: string) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(folderId)) throw new DriveValidationError("Geçersiz klasör kimliği.");
  const src = await getDriveSource(brandId);
  if (!src || src.status === "disconnected") throw new DriveValidationError("Önce Google Drive'ı bağlayın.");
  if (src.folder_id === folderId) return src;
  if (src.folder_id) {
    const n = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM drive_items WHERE source_id = $1`, [src.id]);
    if ((n?.n ?? 0) > 0) throw new DriveValidationError("Bu marka için zaten dizinlenmiş bir klasör var. Farklı klasör seçmek için önce bağlantıyı 'dizini de sil' seçeneğiyle kaldırın.");
  }
  const f = await driveGet<{ id?: string; name?: string; mimeType?: string; trashed?: boolean; driveId?: string }>(
    `/files/${folderId}`,
    { fields: "id,name,mimeType,trashed,driveId", supportsAllDrives: true },
    tokenProvider(brandId),
  );
  if (f.mimeType !== FOLDER_MIME) throw new DriveValidationError("Seçilen öğe bir klasör değil.");
  if (f.trashed) throw new DriveValidationError("Seçilen klasör çöp kutusunda.");
  if (f.name !== config.googleDrive.folderName) throw new DriveValidationError(`Klasör adı '${config.googleDrive.folderName}' olmalı.`);
  const queue: QueueEntry[] = [{ id: folderId, path: f.name, depth: 0 }];
  const row = await q1<DriveSource>(
    `UPDATE drive_sources SET folder_id = $2, folder_name = $3, drive_id = $4, status = 'active', full_scan_state = $5,
       full_scan_started_at = NULL, full_scan_completed_at = NULL, changes_page_token = NULL, consecutive_failures = 0, last_error = NULL,
       next_scan_at = now(), updated_at = now()
     WHERE brand_id = $1 RETURNING *`,
    [brandId, folderId, f.name, f.driveId ?? null, JSON.stringify({ queue, pageToken: null })],
  );
  await audit({ brandId, actor: "user", action: "drive.folder_selected", message: `Drive arşiv klasörü seçildi: ${f.name}` });
  return row!;
}

// ---------------------------------------------------------------- Tarama denetimi

export async function requestDriveScan(brandId: string) {
  const r = await q1<{ id: string }>(
    `UPDATE drive_sources SET next_scan_at = now(), updated_at = now() WHERE brand_id = $1 AND status = 'active' AND folder_id IS NOT NULL RETURNING id`,
    [brandId],
  );
  if (!r) throw new DriveValidationError("Etkin bir Drive kaynağı yok (bağlantı ve klasör seçimi gerekli).");
}

export async function setDrivePaused(brandId: string, paused: boolean) {
  const r = await q1<{ id: string }>(
    paused
      ? `UPDATE drive_sources SET status = 'paused', updated_at = now() WHERE brand_id = $1 AND status = 'active' RETURNING id`
      : `UPDATE drive_sources SET status = 'active', next_scan_at = now(), consecutive_failures = 0, updated_at = now() WHERE brand_id = $1 AND status = 'paused' AND folder_id IS NOT NULL RETURNING id`,
    [brandId],
  );
  if (!r) throw new DriveValidationError(paused ? "Duraklatılacak etkin tarama yok." : "Sürdürülecek duraklatılmış tarama yok.");
}

export function safeError(err: unknown) {
  return redact(String((err as Error)?.message ?? err)).slice(0, 500);
}
