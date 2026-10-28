import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { audit } from "@/lib/audit";
import type { ConnectionStatus } from "@/lib/labels";

const execFileAsync = promisify(execFile);

export type ProviderId =
  | "anthropic" | "openai_images" | "video_generation" | "ffmpeg" | "storage"
  | "shopify" | "instagram" | "tiktok" | "meta_ads" | "google_drive"
  // Stratejik platformlar (Entegrasyon Merkezi; src/lib/integrations). PROVIDERS listesinde değildir.
  | "brandwatch" | "muck_rack" | "metricool" | "runway" | "adobe";

export type ProviderInfo = {
  id: ProviderId;
  name: string;
  category: string;
  scope: "global" | "brand";
  capabilities: string[];
  description: string;
  howToConnect: string;
  docs: string;
};

export const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic Claude API", category: "Metin ve planlama modeli", scope: "global", capabilities: ["text_model"], description: "Ana yönetici ve uzman ajanların gerçek AI üretimi.", howToConnect: "Sunucu ortamına ANTHROPIC_API_KEY ekleyin (Claude Code aboneliği bu kullanımı kapsamaz), uygulamayı yeniden başlatın ve 'Test et' ile doğrulayın.", docs: "https://platform.claude.com/docs" },
  { id: "openai_images", name: "OpenAI Images API", category: "Görsel üretimi", scope: "global", capabilities: ["image_generation"], description: "Tasarım uzmanının AI kampanya görseli üretimi (ürün fotoğrafı yerine geçmez).", howToConnect: "OPENAI_API_KEY ve OPENAI_IMAGE_COST_USD tanımlayın, ardından 'Test et'.", docs: "https://platform.openai.com/docs/api-reference/images" },
  { id: "video_generation", name: "Google Gemini Omni Video", category: "Video üretimi", scope: "global", capabilities: ["video_generation"], description: "Video uzmanının yeni AI video görüntüsü üretimi (Gemini Omni Flash; metinden, ürün fotoğrafından veya ürün referanslarından; 720p, 3-10 sn). Gerçek çekimin yerine geçmez. Ücretlidir; Ayarlar'dan ücretli medya üretimine izin verilmeden çalışmaz.", howToConnect: "GEMINI_API_KEY, GEMINI_VIDEO_MODEL (varsayılan gemini-omni-1.1-flash) ve GEMINI_VIDEO_COST_PER_SECOND_USD tanımlayın, ardından 'Test et' (yalnızca model erişimini okur, video üretmez).", docs: "https://ai.google.dev/gemini-api/docs/omni" },
  { id: "ffmpeg", name: "Yerel ffmpeg", category: "Mevcut videoları düzenleme ve render", scope: "global", capabilities: ["video_edit"], description: "Arşivdeki gerçek çekimlerden kesme, birleştirme, dikey format ve altyazı.", howToConnect: "Sunucuda ffmpeg/ffprobe kurulu olmalı (FFMPEG_PATH).", docs: "https://ffmpeg.org/documentation.html" },
  { id: "storage", name: "Dosya depolama", category: "Depolama", scope: "global", capabilities: ["storage"], description: "Yerel klasör veya S3 uyumlu depolama.", howToConnect: "STORAGE_DRIVER=s3 ve S3_* değişkenleri.", docs: "" },
  { id: "shopify", name: "Shopify Admin API", category: "Mağaza", scope: "brand", capabilities: ["store_read", "store_write"], description: "Ürünleri okuma; onaylı değişiklikleri canlı mağazaya yazma.", howToConnect: "Shopify Dev Dashboard'da kendi organizasyonunuzda uygulama oluşturun, mağazanıza kurun; SHOPIFY_CLIENT_ID/SECRET tanımlayın ve marka için mağaza alan adını girin (client credentials grant).", docs: "https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant" },
  { id: "instagram", name: "Instagram (Instagram Login)", category: "Sosyal yayın", scope: "brand", capabilities: ["social_publish_instagram"], description: "Profesyonel (Business/Creator) hesaba onaylı gönderi/reel yayını. Medya herkese açık bir URL'den alınır (S3 gerekir).", howToConnect: "Meta uygulaması oluşturun, INSTAGRAM_APP_ID/SECRET tanımlayın, 'Instagram ile bağlan' ile resmi OAuth akışını tamamlayın. Gerekli izin: instagram_business_content_publish (uygulama incelemesi gerekebilir).", docs: "https://developers.facebook.com/docs/instagram-platform/content-publishing" },
  { id: "google_drive", name: "Google Drive arşivi (salt okunur)", category: "Marka arşivi", scope: "brand", capabilities: ["archive_index"], description: "Seçtiğiniz tek klasörü (FriBee Master Archive) dizinler: ad, klasör yapısı, tür, boyut, tarih, özet. Yalnızca sizin doğruladığınız görselleri orijinal kalitede medya arşivine alır ve seçtiğiniz metin belgelerini marka hafızasına öneri olarak ekler. Drive'da hiçbir şeyi değiştirmez, silmez veya paylaşıma açmaz.", howToConnect: "Google Cloud'da OAuth istemcisi (Web uygulaması) oluşturun, GOOGLE_DRIVE_CLIENT_ID/SECRET tanımlayın, 'Google Drive ile bağlan' ile yetki verin ve Drive Arşivi sayfasında klasörü seçin. İzin: drive.readonly — salt okuma (ayrıntı: docs/GOOGLE_DRIVE.md).", docs: "https://developers.google.com/workspace/drive/api/guides/api-specific-auth" },
  { id: "tiktok", name: "TikTok Content Posting API", category: "Sosyal yayın", scope: "brand", capabilities: [], description: "Doğrudan yayın, TikTok uygulama denetimi gerektirir; denetimsiz istemciler yalnızca gizli yayın yapabilir. Bu sürümde manuel yayın paketi üretilir.", howToConnect: "Doğrudan yayın bu sürümde desteklenmiyor. Manuel paket (video + açıklama + kapak) indirilip TikTok uygulamasından yüklenir.", docs: "https://developers.tiktok.com/doc/content-posting-api-get-started" },
  { id: "meta_ads", name: "Meta reklam ve performans verileri", category: "Reklam / performans", scope: "brand", capabilities: [], description: "Reklam başlatma ve performans verisi okuma. Adaptör arayüzü hazır; bu sürümde bağlantı kurulmadı.", howToConnect: "Meta Marketing API erişimi ve reklam hesabı gerekir. Bu sürümde desteklenmiyor.", docs: "https://developers.facebook.com/docs/marketing-apis" },
];

export function providerInfo(id: string) {
  return PROVIDERS.find((p) => p.id === id);
}

export type Connection = {
  id: string;
  brand_id: string | null;
  provider: ProviderId;
  status: ConnectionStatus;
  config: Record<string, any>;
  credentials_encrypted: string | null;
  scopes: string[];
  last_checked_at: string | null;
  last_error: string | null;
};

export async function getConnection(provider: ProviderId, brandId: string | null, db: Queryable = getPool()) {
  return q1<Connection>(
    `SELECT * FROM connections WHERE provider = $1 AND brand_id IS NOT DISTINCT FROM $2`,
    [provider, brandId],
    db,
  );
}

export async function upsertConnection(
  provider: ProviderId,
  brandId: string | null,
  patch: { status?: ConnectionStatus; config?: Record<string, unknown>; credentials?: unknown | null; scopes?: string[]; lastError?: string | null },
  db: Queryable = getPool(),
) {
  const existing = await getConnection(provider, brandId, db);
  const creds = patch.credentials === undefined ? existing?.credentials_encrypted ?? null : patch.credentials === null ? null : encryptSecret(patch.credentials);
  const cfg = { ...(existing?.config ?? {}), ...(patch.config ?? {}) };
  if (existing) {
    await q(
      `UPDATE connections SET status = $2, config = $3, credentials_encrypted = $4, scopes = $5, last_error = $6, last_checked_at = now(), updated_at = now() WHERE id = $1`,
      [existing.id, patch.status ?? existing.status, JSON.stringify(cfg), creds, patch.scopes ?? existing.scopes, patch.lastError === undefined ? existing.last_error : patch.lastError],
      db,
    );
  } else {
    await q(
      `INSERT INTO connections (brand_id, provider, status, config, credentials_encrypted, scopes, last_error, last_checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now())`,
      [brandId, provider, patch.status ?? "not_connected", JSON.stringify(cfg), creds, patch.scopes ?? [], patch.lastError ?? null],
      db,
    );
  }
  return (await getConnection(provider, brandId, db))!;
}

export function connectionCredentials<T = Record<string, any>>(c: Connection | null): T | null {
  if (!c?.credentials_encrypted) return null;
  return decryptSecret<T>(c.credentials_encrypted);
}

export async function disconnect(provider: ProviderId, brandId: string | null) {
  await upsertConnection(provider, brandId, { status: "not_connected", credentials: null, lastError: null });
  await audit({ brandId, actor: "user", action: "connection.disconnect", message: `${providerInfo(provider)?.name ?? provider} bağlantısı kaldırıldı` });
}

let ffmpegCache: { ok: boolean; at: number; version?: string } | null = null;
export async function ffmpegAvailable(): Promise<{ ok: boolean; version?: string }> {
  if (ffmpegCache && Date.now() - ffmpegCache.at < 60_000) return ffmpegCache;
  try {
    const { stdout } = await execFileAsync(config.ffmpegPath, ["-hide_banner", "-version"], { timeout: 10_000 });
    ffmpegCache = { ok: true, at: Date.now(), version: stdout.split("\n")[0] };
  } catch {
    ffmpegCache = { ok: false, at: Date.now() };
  }
  return ffmpegCache;
}

/** Ortam yapılandırmasına göre (env) sağlayıcının yapılandırılıp yapılandırılmadığı. Gizli değer döndürmez. */
export function envConfigured(provider: ProviderId): boolean {
  switch (provider) {
    case "anthropic": return !!config.anthropic.apiKey;
    case "openai_images": return !!config.openaiImages.apiKey;
    case "video_generation": return !!config.gemini.apiKey;
    case "shopify": return !!(config.shopify.clientId && config.shopify.clientSecret);
    case "instagram": return !!(config.instagram.appId && config.instagram.appSecret);
    case "google_drive": return !!(config.googleDrive.clientId && config.googleDrive.clientSecret);
    case "storage": return config.storageDriver === "local" || !!config.s3.bucket;
    case "ffmpeg": return true;
    default: return false;
  }
}

/** Panelde gösterilecek etkin durum. Kayıt yoksa ortam yapılandırmasına göre "Bağlı değil" / "Desteklenmiyor". */
export async function effectiveStatus(provider: ProviderId, brandId: string | null): Promise<{ status: ConnectionStatus; detail: string | null; connection: Connection | null }> {
  const info = providerInfo(provider)!;
  if (provider === "tiktok" || provider === "meta_ads") {
    return { status: "unsupported", detail: info.howToConnect, connection: null };
  }
  if (provider === "ffmpeg") {
    const f = await ffmpegAvailable();
    return { status: f.ok ? "connected" : "error", detail: f.ok ? f.version ?? null : "ffmpeg bulunamadı", connection: null };
  }
  const conn = await getConnection(provider, info.scope === "brand" ? brandId : null);
  if (!envConfigured(provider) && provider !== "storage") {
    return { status: "not_connected", detail: "Sunucu ortam değişkenleri tanımlı değil.", connection: conn };
  }
  if (!conn) return { status: provider === "storage" && config.storageDriver === "local" ? "connected" : "not_connected", detail: provider === "storage" ? `Sürücü: ${config.storageDriver}` : "Henüz test edilmedi.", connection: null };
  return { status: conn.status, detail: conn.last_error, connection: conn };
}

/** Bir yeteneğin gerçek kullanıma hazır olup olmadığı. "Bağlı" olmayan servis için asla başarı varsayılmaz. */
export async function capabilityReady(capability: string, brandId: string): Promise<{ ready: boolean; provider: ProviderId | null; reason: string }> {
  const provider = PROVIDERS.find((p) => p.capabilities.includes(capability));
  if (!provider) return { ready: false, provider: null, reason: `'${capability}' için sağlayıcı yok.` };
  const s = await effectiveStatus(provider.id, brandId);
  return { ready: s.status === "connected", provider: provider.id, reason: s.status === "connected" ? "Bağlı" : `${provider.name}: ${s.detail ?? s.status}` };
}
