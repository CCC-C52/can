import { config } from "@/lib/config";
import type { Limits } from "@/lib/settings";
import { capabilityReady, connectionCredentials, getConnection } from "@/lib/services/connections";
import { getVideoGenerator, type VideoGenerator } from "@/lib/adapters/video-generation";
import { RUNWAY_MAX_SECONDS, RUNWAY_MIN_SECONDS, RunwayVideoGenerator } from "@/lib/adapters/runway-video";

// AI video sağlayıcı seçimi: birincil Runway, ikincil Google Gemini (Ayarlar'dan değiştirilebilir).
// Kurallar:
//  - Seçim her sahne için GÖNDERİMDEN ÖNCE yapılır: birincil kullanılamıyorsa (anahtar, bağlantı testi veya fiyat yok,
//    istek desteklenmiyor) ikincil seçilir. Bu ilk ücretli istektir, ikinci bir ücret değildir.
//  - Bir sahne bir sağlayıcıya gönderildikten sonra (başarısız ya da sonucu belirsiz olsa bile) diğer sağlayıcıya OTOMATİK
//    gönderilmez: ek ücret doğurabileceği için sahip "Gemini/Runway ile yeniden gönder" kararını verir (owner_retry_provider).
//  - Fiyatı bilinmeyen sağlayıcı ücretli üretim için hazır sayılmaz.

export type VideoProviderId = "runway" | "gemini";
export const VIDEO_PROVIDER_SERVICE: Record<VideoProviderId, string> = { runway: "runway", gemini: "video_generation" };
export const VIDEO_PROVIDER_NAME: Record<VideoProviderId, string> = { runway: "Runway", gemini: "Google Gemini Omni" };
export const providerOfService = (service: string): VideoProviderId | null =>
  service === "runway" ? "runway" : service === "video_generation" ? "gemini" : null;

export type VideoProviderStatus = {
  id: VideoProviderId;
  name: string;
  service: string;
  role: "primary" | "secondary";
  model: string | null;
  keyConfigured: boolean;
  connected: boolean;
  priced: boolean;
  /** 1 saniyelik tahmini ücret (USD); fiyat yoksa null. */
  usdPerSecond: number | null;
  ready: boolean;
  reason: string;
  /** Runway anahtar kaynağı (ekranda gösterilir; değer gösterilmez). */
  keySource?: "integration" | "env" | null;
  gen: VideoGenerator | null;
};

/** Saniye fiyatı: sağlayıcılar kısa süreyi en az süreye yuvarlar (Runway 2, Gemini 3 sn); ikisinin de kabul ettiği 10 sn'den hesaplanır. */
function perSecond(gen: VideoGenerator | null) {
  const v = gen ? gen.estimateCostUsd(10) : null;
  return v === null ? null : Math.round((v / 10) * 1e6) / 1e6;
}

let runwayOverride: VideoGenerator | null | undefined;
/** Testler için Runway sağlayıcısını değiştirir (sahte sunucu). undefined: gerçek yapılandırma. */
export function setRunwayGeneratorOverride(g: VideoGenerator | null | undefined) {
  runwayOverride = g;
}

async function runwayKey(brandId: string): Promise<{ key: string | null; source: "integration" | "env" | null; connected: boolean; detail: string }> {
  const conn = await getConnection("runway", brandId);
  const stored = connectionCredentials<{ apiKey?: string }>(conn)?.apiKey ?? null;
  if (stored) {
    if (conn?.status === "connected") return { key: stored, source: "integration", connected: true, detail: "Entegrasyon Merkezi'nde doğrulandı" };
    return { key: stored, source: "integration", connected: false, detail: conn?.status === "error" ? `Bağlantı testi başarısız: ${conn.last_error ?? "hata"}` : "Anahtar kayıtlı; Entegrasyonlar → Runway → 'Bağlantıyı test et'" };
  }
  if (config.runway.apiKey) return { key: config.runway.apiKey, source: "env", connected: true, detail: "Sunucu ortamında (RUNWAYML_API_SECRET)" };
  return { key: null, source: null, connected: false, detail: "Runway API anahtarı yok (Entegrasyonlar → Runway)" };
}

function runwayGenerator(key: string, limits: Limits) {
  return new RunwayVideoGenerator(key, limits.runwayModel ?? "gen4.5", { creditsPerSecond: limits.runwayCreditsPerSecond ?? null, usdPerCredit: limits.runwayUsdPerCredit ?? null });
}

async function runwayStatus(brandId: string, limits: Limits, role: VideoProviderStatus["role"]): Promise<VideoProviderStatus> {
  const base = { id: "runway" as const, name: VIDEO_PROVIDER_NAME.runway, service: "runway", role };
  if (runwayOverride !== undefined) {
    const gen = runwayOverride;
    const usd = perSecond(gen);
    return { ...base, model: gen?.model ?? null, keyConfigured: !!gen, connected: !!gen, priced: usd !== null, usdPerSecond: usd, keySource: gen ? "env" : null, gen,
      ready: !!gen && usd !== null, reason: !gen ? "Runway yapılandırılmamış" : usd === null ? "Runway fiyatı girilmedi (Ayarlar)" : "Hazır" };
  }
  const k = await runwayKey(brandId);
  const gen = k.key ? runwayGenerator(k.key, limits) : null;
  const usd = perSecond(gen);
  const priced = limits.runwayCreditsPerSecond != null && limits.runwayUsdPerCredit != null;
  const reason = !k.key ? k.detail : !k.connected ? k.detail : !priced ? "Runway fiyatı girilmedi (Ayarlar → Runway kredi/saniye ve USD/kredi); fiyat bilinmeden ücretli üretim yapılmaz" : "Hazır";
  return { ...base, model: limits.runwayModel ?? "gen4.5", keyConfigured: !!k.key, connected: k.connected, priced, usdPerSecond: priced ? usd : null, keySource: k.source, gen, ready: !!k.key && k.connected && priced, reason };
}

async function geminiStatus(brandId: string, role: VideoProviderStatus["role"]): Promise<VideoProviderStatus> {
  const gen = getVideoGenerator();
  const cap = await capabilityReady("video_generation", brandId);
  const usd = perSecond(gen);
  const reason = !gen ? "GEMINI_API_KEY tanımlı değil" : !cap.ready ? cap.reason : usd === null ? "GEMINI_VIDEO_COST_PER_SECOND_USD tanımlı değil (fiyat bilinmeden ücretli üretim yapılmaz)" : "Hazır";
  return { id: "gemini", name: VIDEO_PROVIDER_NAME.gemini, service: "video_generation", role, model: gen?.model ?? config.gemini.videoModel, keyConfigured: !!gen, connected: cap.ready, priced: usd !== null, usdPerSecond: usd, gen, ready: !!gen && cap.ready && usd !== null, reason };
}

/** Birincil önce olmak üzere iki sağlayıcının durumu (Video Stüdyosu ve seçim için). */
export async function videoProviderStatus(brandId: string, limits: Limits): Promise<VideoProviderStatus[]> {
  const primary: VideoProviderId = limits.videoPrimaryProvider === "gemini" ? "gemini" : "runway";
  const order: VideoProviderId[] = primary === "runway" ? ["runway", "gemini"] : ["gemini", "runway"];
  return Promise.all(order.map((id, i) => (id === "runway" ? runwayStatus(brandId, limits, i === 0 ? "primary" : "secondary") : geminiStatus(brandId, i === 0 ? "primary" : "secondary"))));
}

function supports(id: VideoProviderId, seconds: number) {
  if (id === "runway") return seconds >= RUNWAY_MIN_SECONDS && seconds <= RUNWAY_MAX_SECONDS;
  return seconds >= 3 && seconds <= 10;
}

export type ProviderChoice =
  | { ok: true; status: VideoProviderStatus; choice: { selected: VideoProviderId; primary: VideoProviderId; fallback_from?: { id: VideoProviderId; reason: string }; owner_choice?: VideoProviderId } }
  | { ok: false; reason: string };

/**
 * Bir sahne için sağlayıcı seçer (henüz gönderilmemiş sahne). `ownerChoice`: sahibin yeniden gönderimde seçtiği sağlayıcı;
 * o sağlayıcı hazır değilse başka sağlayıcıya geçilmez.
 */
export async function selectVideoProvider(brandId: string, limits: Limits, opts: { seconds: number; ownerChoice?: VideoProviderId | null }): Promise<ProviderChoice> {
  const all = await videoProviderStatus(brandId, limits);
  const primary = all[0].id;
  if (opts.ownerChoice) {
    const s = all.find((x) => x.id === opts.ownerChoice)!;
    if (!s.ready) return { ok: false, reason: `Sahibin seçtiği ${s.name} hazır değil: ${s.reason}` };
    if (!supports(s.id, opts.seconds)) return { ok: false, reason: `${s.name} ${opts.seconds} sn sahneyi desteklemiyor` };
    return { ok: true, status: s, choice: { selected: s.id, primary, owner_choice: s.id } };
  }
  const skipped: { id: VideoProviderId; reason: string }[] = [];
  for (const s of all) {
    if (!s.ready) { skipped.push({ id: s.id, reason: s.reason }); continue; }
    if (!supports(s.id, opts.seconds)) { skipped.push({ id: s.id, reason: `${opts.seconds} sn desteklenmiyor` }); continue; }
    return { ok: true, status: s, choice: { selected: s.id, primary, ...(skipped.length ? { fallback_from: skipped[0] } : {}) } };
  }
  return { ok: false, reason: all.map((s) => `${s.name}: ${s.reason}`).join("; ") };
}

/** Gönderilmiş bir işin sağlayıcısı (sorgu/indirme için). Fiyat ayarı kaldırılmış olsa da sorgu yapılabilir. */
export async function videoGeneratorForService(service: string, brandId: string, limits: Limits): Promise<VideoGenerator | null> {
  if (service === "runway") {
    if (runwayOverride !== undefined) return runwayOverride;
    const k = await runwayKey(brandId);
    return k.key ? runwayGenerator(k.key, limits) : null;
  }
  if (service === "video_generation") return getVideoGenerator();
  return null;
}
