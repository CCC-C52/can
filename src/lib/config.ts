// Ortam değişkenlerinin tek okunduğu yer. Gizli değerler yalnızca sunucu tarafında kullanılır.

function str(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function num(name: string, fallback: number): number {
  const v = str(name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export type AppMode = "local" | "production";

export const config = {
  get appMode(): AppMode {
    return str("APP_MODE") === "production" ? "production" : "local";
  },
  /** Canlı (production) ortamda DEMO üretici ve örnek veri kapalıdır. */
  get demoAllowed() {
    return this.appMode !== "production";
  },
  get localRequireLogin() {
    return str("LOCAL_REQUIRE_LOGIN") === "true";
  },
  get databaseUrl() {
    return str("DATABASE_URL") ?? "postgres://aiops:aiops@127.0.0.1:5432/aiops";
  },
  get storageDriver(): "local" | "s3" {
    return str("STORAGE_DRIVER") === "s3" ? "s3" : "local";
  },
  get localStorageDir() {
    return str("LOCAL_STORAGE_DIR") ?? "./data/storage";
  },
  get maxUploadBytes() {
    return num("MAX_UPLOAD_MB", 2048) * 1024 * 1024;
  },
  s3: {
    get bucket() { return str("S3_BUCKET"); },
    get region() { return str("S3_REGION") ?? "auto"; },
    get endpoint() { return str("S3_ENDPOINT"); },
    get accessKeyId() { return str("S3_ACCESS_KEY_ID"); },
    get secretAccessKey() { return str("S3_SECRET_ACCESS_KEY"); },
    get forcePathStyle() { return str("S3_FORCE_PATH_STYLE") === "true"; },
  },
  anthropic: {
    // Uygulamaya özel ad önceliklidir; böylece Claude Code oturumunun kendi ANTHROPIC_API_KEY kullanımıyla çakışmaz.
    get apiKey() { return str("AIOPS_ANTHROPIC_API_KEY") ?? str("ANTHROPIC_API_KEY"); },
    get model() { return str("ANTHROPIC_MODEL") ?? "claude-opus-5-5"; },
    get effort() { return (str("ANTHROPIC_EFFORT") ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max"; },
  },
  openaiImages: {
    get apiKey() { return str("OPENAI_API_KEY"); },
    get model() { return str("OPENAI_IMAGE_MODEL") ?? "gpt-image-1"; },
    get costPerImageUsd(): number | null {
      const v = str("OPENAI_IMAGE_COST_USD");
      return v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
    },
  },
  gemini: {
    // Google Gemini Omni Flash (Gemini API, Interactions API) — AI video üretimi. Birim fiyat sahibin belirlediği değerdir; uydurulmaz.
    // Eski VEO_MODEL / VEO_COST_PER_SECOND_USD bilinçli olarak okunmaz: başka bir modelin adı ve fiyatı yeni modelde yanlış olur.
    get apiKey() { return str("GEMINI_API_KEY"); },
    get videoModel() { return str("GEMINI_VIDEO_MODEL") ?? "gemini-omni-1.1-flash"; },
    /** Eski ad (uyumluluk). */
    get veoModel() { return this.videoModel; },
    /**
     * Model adı ve Interactions API video istek biçimi (response_format.duration vb.) resmî belgeyle teyit edilmeden
     * ücretli gönderim yapılmaz. Sahip teyit ettikten sonra "true" olarak ayarlar; varsayılan kapalı.
     */
    get contractVerified() { return str("GEMINI_VIDEO_CONTRACT_VERIFIED") === "true"; },
    get costPerSecondUsd(): number | null {
      const v = str("GEMINI_VIDEO_COST_PER_SECOND_USD");
      return v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
    },
  },
  firecrawl: {
    // Web araştırması (ücretli). Anahtar yalnızca sunucu ortamında tutulur.
    get apiKey() { return str("FIRECRAWL_API_KEY"); },
    get creditUsd(): number | null {
      const v = str("FIRECRAWL_CREDIT_USD");
      return v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
    },
  },
  posthog: {
    // Sunucu tarafı, isteğe bağlı olay/hata telemetrisi. Oturum kaydı ve tarayıcı betiği YOK.
    get apiKey() { return str("POSTHOG_API_KEY"); },
    get host() { return str("POSTHOG_HOST") ?? "https://eu.i.posthog.com"; },
  },
  shopify: {
    get clientId() { return str("SHOPIFY_CLIENT_ID"); },
    get clientSecret() { return str("SHOPIFY_CLIENT_SECRET"); },
    get apiVersion() { return str("SHOPIFY_API_VERSION") ?? "2026-10"; },
  },
  instagram: {
    get appId() { return str("INSTAGRAM_APP_ID"); },
    get appSecret() { return str("INSTAGRAM_APP_SECRET"); },
    get graphVersion() { return str("INSTAGRAM_GRAPH_VERSION") ?? "v24.0"; },
  },
  tiktok: {
    get clientKey() { return str("TIKTOK_CLIENT_KEY"); },
    get clientSecret() { return str("TIKTOK_CLIENT_SECRET"); },
  },
  meta: {
    get appSecret() { return str("META_APP_SECRET"); },
  },
  get publicBaseUrl() {
    // Render web servislerine RENDER_EXTERNAL_URL otomatik verilir.
    return str("PUBLIC_BASE_URL") ?? str("RENDER_EXTERNAL_URL") ?? "http://127.0.0.1:3000";
  },
  backup: {
    get bucket() { return str("BACKUP_S3_BUCKET"); },
    get hourUtc() { return num("BACKUP_HOUR_UTC", 3); },
    get retentionDays() { return num("BACKUP_RETENTION_DAYS", 14); },
    get pgDumpPath() { return str("PG_DUMP_PATH") ?? "pg_dump"; },
  },
  get ffmpegPath() { return str("FFMPEG_PATH") ?? "ffmpeg"; },
  get ffprobePath() { return str("FFPROBE_PATH") ?? "ffprobe"; },
  get adminPassword() { return str("ADMIN_PASSWORD"); },
  get sessionSecret() { return str("SESSION_SECRET"); },
  get encryptionKey() { return str("ENCRYPTION_KEY"); },
  get workerPollMs() { return num("WORKER_POLL_MS", 1500); },
};

/** Üretim modunda zorunlu ayarlar eksikse başlatmayı durdurur. */
export function assertProductionConfig(role: "web" | "worker" = "web"): string[] {
  const problems: string[] = [];
  if (config.appMode !== "production") return problems;
  if (role === "web") {
    if (!config.adminPassword || config.adminPassword.length < 12) problems.push("ADMIN_PASSWORD en az 12 karakter olmalı.");
    if (!config.sessionSecret || config.sessionSecret.length < 32) problems.push("SESSION_SECRET en az 32 karakter olmalı.");
  }
  if (!config.encryptionKey || config.encryptionKey.length < 32) problems.push("ENCRYPTION_KEY en az 32 karakter olmalı.");
  if (config.storageDriver !== "s3") problems.push("Canlı ortamda STORAGE_DRIVER=s3 olmalı (kapsayıcı diski kalıcı değildir).");
  return problems;
}
