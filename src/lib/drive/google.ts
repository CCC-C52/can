import { config } from "@/lib/config";
import { PermanentError, TransientError } from "@/lib/models/types";

// Google OAuth 2.0 ve Drive API v3 (salt okunur üst veri). Yalnızca Google uç noktalarıyla konuşur.
// - İzin: drive.metadata.readonly (dosya içeriği okunamaz, hiçbir şey yazılamaz, paylaşım değiştirilemez).
// - Belirteçler bu modülden dışarı yalnızca çağırana döner; günlük/hata metnine yazılmaz.
// - 429 / 5xx / 403 rateLimitExceeded: üstel geri çekilme + rastgele sapma, Retry-After'a uyulur.
// Resmi belgeler: https://developers.google.com/identity/protocols/oauth2/web-server
//                 https://developers.google.com/workspace/drive/api/guides/limits

export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.metadata.readonly"] as const;
export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Drive dosya/klasör kimliği biçimi. Sorgu metnine girmeden önce her kimlik bununla doğrulanır (sorgu enjeksiyonu yok). */
export const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** Yeniden yetkilendirme gerekir (yenileme belirteci geçersiz/iptal, 401). Otomatik tekrar denenmez. */
export class DriveAuthError extends PermanentError {}
/** Kota/hız sınırı tekrar denemelere rağmen aşıldı. Tarama geri çekilmeyle daha sonra sürer. */
export class DriveQuotaError extends TransientError {}
/** Öğe yok veya bu hesabın erişimi yok. */
export class DriveNotFoundError extends PermanentError {}

/** Testlerde beklemeyi ve rastgeleliği değiştirmek için. */
export const driveRuntime = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  random: () => Math.random(),
  maxAttempts: 5,
  baseDelayMs: 1000,
  timeoutMs: 30_000,
};

export function driveRedirectUri() {
  return `${config.publicBaseUrl}/api/integrations/google-drive/callback`;
}

export function driveAuthUrl(state: string) {
  if (!config.googleDrive.clientId) throw new PermanentError("GOOGLE_DRIVE_CLIENT_ID tanımlı değil.");
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", config.googleDrive.clientId);
  u.searchParams.set("redirect_uri", driveRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", DRIVE_SCOPES.join(" "));
  // Yenileme belirteci için çevrimdışı erişim; daha önce verilmiş başka izinler bu bağlantıya EKLENMEZ.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  return u.toString();
}

export type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; token_type?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(driveRuntime.timeoutMs),
    });
  } catch {
    throw new TransientError("Google belirteç uç noktasına ulaşılamadı.");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && typeof body.access_token === "string") {
    return { ...(body as unknown as TokenResponse), expires_in: Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600 };
  }
  // Yalnızca hata kodu aktarılır; yanıt gövdesi (ve olası belirteç parçaları) aktarılmaz.
  const code = typeof body.error === "string" ? body.error.replace(/[^a-z_]/gi, "").slice(0, 40) : String(res.status);
  if (code === "invalid_grant" || code === "unauthorized_client") throw new DriveAuthError("Google yetkisi geçersiz, süresi dolmuş veya iptal edilmiş; yeniden bağlanın.");
  if (res.status === 429 || res.status >= 500) throw new TransientError(`Google belirteç hatası ${res.status}.`);
  throw new PermanentError(`Google belirteç isteği reddedildi (${code}).`);
}

function clientCreds() {
  const { clientId, clientSecret } = config.googleDrive;
  if (!clientId || !clientSecret) throw new PermanentError("Google Drive OAuth istemci bilgileri tanımlı değil (GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET).");
  return { client_id: clientId, client_secret: clientSecret };
}

export function exchangeCode(code: string) {
  return tokenRequest({ ...clientCreds(), code, grant_type: "authorization_code", redirect_uri: driveRedirectUri() });
}

export function refreshAccessToken(refreshToken: string) {
  return tokenRequest({ ...clientCreds(), refresh_token: refreshToken, grant_type: "refresh_token" });
}

/** Google tarafında izni iptal eder. Başarısızlık bağlantının yerelde kaldırılmasını engellemez. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(driveRuntime.timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type TokenProvider = (forceRefresh?: boolean) => Promise<string>;
export type CallStats = { calls: number; retries: number };

const RATE_REASONS = /^(rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded|RESOURCE_EXHAUSTED)$/;

/** Drive API GET isteği: kimlik doğrulama, tekrar deneme ve hata sınıflandırması. Yalnızca okuma yapar. */
export async function driveGet<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
  token: TokenProvider,
  stats: CallStats = { calls: 0, retries: 0 },
): Promise<T> {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new PermanentError("Geçersiz Drive yolu.");
  const url = new URL(DRIVE_API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const access = await token(false);
    let res: Response | null = null;
    try {
      stats.calls++;
      res = await fetch(url, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" }, signal: AbortSignal.timeout(driveRuntime.timeoutMs) });
    } catch {
      res = null;
    }
    if (res?.ok) {
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== "object") throw new TransientError("Drive yanıtı çözümlenemedi.");
      return body as T;
    }
    let reason = "";
    let retryAfterS = NaN;
    if (res) {
      const body = (await res.json().catch(() => null)) as { error?: { status?: string; errors?: { reason?: string }[] } } | null;
      reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? "").replace(/[^A-Za-z_]/g, "").slice(0, 60);
      retryAfterS = Number(res.headers.get("retry-after"));
    }
    if (res?.status === 401) {
      if (!refreshed) {
        refreshed = true;
        await token(true);
        continue;
      }
      throw new DriveAuthError("Google Drive yetkisi reddedildi (401); yeniden bağlanın.");
    }
    if (res?.status === 404) throw new DriveNotFoundError("Drive öğesi bulunamadı veya bu hesabın erişimi yok.");
    const rateLimited = !!res && (res.status === 429 || (res.status === 403 && RATE_REASONS.test(reason)));
    const transient = !res || res.status >= 500 || rateLimited;
    if (res && !transient) {
      throw new PermanentError(res.status === 403 ? `Drive erişimi reddedildi (${reason || 403}).` : `Drive isteği reddedildi: ${res.status}${reason ? ` (${reason})` : ""}.`);
    }
    if (attempt >= driveRuntime.maxAttempts) {
      if (rateLimited) throw new DriveQuotaError(`Drive kota/hız sınırı (${reason || res!.status}); tarama daha sonra kaldığı yerden sürecek.`);
      throw new TransientError(res ? `Drive geçici hatası ${res.status}.` : "Drive'a ulaşılamadı (ağ hatası).");
    }
    stats.retries++;
    const base = driveRuntime.baseDelayMs;
    const delay = Number.isFinite(retryAfterS) && retryAfterS > 0
      ? Math.min(retryAfterS * 1000, 120_000)
      : Math.min(64_000, base * 2 ** (attempt - 1)) + Math.floor(driveRuntime.random() * base);
    await driveRuntime.sleep(delay);
  }
}

const THUMB_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Drive'ın ürettiği önizleme görselini (thumbnailLink) indirir. Orijinal dosya indirilmez.
 * Yalnızca Google'ın görsel sunucularından, HTTPS ile ve boyut sınırıyla.
 */
export async function fetchThumbnail(link: string, token: TokenProvider, size = 1600): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw new PermanentError("Geçersiz önizleme adresi.");
  }
  if (u.protocol !== "https:" || !(u.hostname.endsWith(".googleusercontent.com") || u.hostname === "drive.google.com")) {
    throw new PermanentError("Önizleme adresi Google görsel sunucusu değil; indirilmedi.");
  }
  const sized = u.toString().replace(/=s\d+(-[a-z0-9-]+)?$/i, `=s${Math.min(2000, Math.max(64, size))}`);
  let res: Response;
  try {
    res = await fetch(sized, { headers: { Authorization: `Bearer ${await token(false)}` }, signal: AbortSignal.timeout(driveRuntime.timeoutMs), redirect: "follow" });
  } catch {
    throw new TransientError("Önizleme indirilemedi (ağ hatası).");
  }
  if (res.status === 429 || res.status >= 500) throw new TransientError(`Önizleme geçici hatası ${res.status}.`);
  if (!res.ok) throw new PermanentError(`Önizleme alınamadı (${res.status}).`);
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > THUMB_MAX_BYTES) throw new PermanentError("Önizleme çok büyük.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new PermanentError("Önizleme boş.");
  if (buf.length > THUMB_MAX_BYTES) throw new PermanentError("Önizleme çok büyük.");
  return buf;
}

/** Drive sorgu dizgesindeki tek tırnaklı değeri kaçışlar. */
export function escapeQueryValue(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
