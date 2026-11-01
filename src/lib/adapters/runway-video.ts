import sharp from "sharp";
import { PermanentError, TransientError } from "@/lib/models/types";
import { fetchJson } from "./http";
import type { VideoGenerator, VideoGenImage, VideoGenPoll, VideoGenRequest } from "./video-generation";
import { requestImages, videoGenMode } from "./video-generation";

// Runway API — birincil AI video sağlayıcısı.
// Kaynak: Runway'in resmî Node SDK'sı @runwayml/sdk 4.24.0 (23 Ekim 2026) tip tanımları ve istemci kodu
// (docs.dev.runwayml.com bu ortamın ağında kapalıydı; uç nokta, alan ve değerler SDK'dan birebir alındı):
//   temel adres https://api.dev.runwayml.com · Authorization: Bearer <anahtar> · X-Runway-Version: 2024-11-06
//   POST /v1/text_to_video  { model: "gen4.5", promptText (≤1000 UTF-16), ratio "1280:720"|"720:1280", duration 2–10 tamsayı }
//   POST /v1/image_to_video { model: "gen4.5", promptImage (HTTPS, Runway upload URI veya ≤5 MB base64 data URI; ilk kare),
//                              promptText, ratio, duration }  → { id, estimatedCost: { credits } } (görevin en fazla kredisi)
//   GET  /v1/tasks/{id} → PENDING | THROTTLED | RUNNING (progress) | SUCCEEDED (output[]: 24-48 saatte süresi dolan
//        adresler; yeniden sorgu taze adres verir) | FAILED (failure, failureCode) | CANCELLED; terminal durumda cost.credits
// Runway'de istemci tarafı tekrar-gönderim anahtarı (idempotency) belgelenmemiştir: gönderim belirsiz kalırsa
// (ağ hatası, 5xx) sonuç bilinmez kabul edilir ve OTOMATİK TEKRAR GÖNDERİLMEZ.
// NOT: Bu ortamda Runway anahtarı yoktur ve Runway alan adlarına ağ erişimi kapalıdır; davranış sahte sunucuyla test edildi.

export const RUNWAY_API = "https://api.dev.runwayml.com";
export const RUNWAY_VERSION = "2024-11-06";
const API_HOST = new URL(RUNWAY_API).host;

/** Uygulanan ve SDK ile doğrulanan modeller. Diğer Runway modelleri farklı parametre kümeleri ister; eklenmedi. */
export const RUNWAY_MODELS = ["gen4.5"] as const;
export type RunwayModel = (typeof RUNWAY_MODELS)[number];
export const RUNWAY_MIN_SECONDS = 2;
export const RUNWAY_MAX_SECONDS = 10;
export const RUNWAY_PROMPT_MAX = 1000;
/** Base64 data URI üst sınırı (SDK: "up to 5MB"); karakter olarak, güvenli tarafta. */
export const RUNWAY_DATA_URI_MAX = 5_000_000;

export type RunwayPricing = { creditsPerSecond: number | null; usdPerCredit: number | null };

export function runwayDuration(seconds: number) {
  return Math.min(RUNWAY_MAX_SECONDS, Math.max(RUNWAY_MIN_SECONDS, Math.round(Number(seconds) || RUNWAY_MIN_SECONDS)));
}
export function runwayRatio(aspect: "9:16" | "16:9") {
  return aspect === "16:9" ? "1280:720" : "720:1280";
}

// Ürün korunur: baskı, renk, logo ve kesim değişmez (Runway istemi 1000 karakterle sınırlı; kısa tutulur).
const PRESERVE = "The first frame is a real FRIBEE product photo. Keep the product exactly as photographed: same print and artwork, same colours, same logo and lettering, same cut. Do not redraw, recolour or add text or logos.";

/** Runway istemi: koruma cümlesi + sahne istemi, en çok 1000 UTF-16 birimi (kelime sınırında kısaltılır). */
export function runwayPrompt(prompt: string, withImage: boolean) {
  const base = String(prompt ?? "").replace(/\s+/g, " ").trim();
  const head = withImage ? `${PRESERVE} ` : "";
  const room = RUNWAY_PROMPT_MAX - head.length;
  let body = base;
  if (body.length > room) {
    body = body.slice(0, room);
    const cut = body.lastIndexOf(" ");
    if (cut > room * 0.8) body = body.slice(0, cut);
  }
  const out = `${head}${body}`.trim();
  if (!out) throw new PermanentError("Runway istemi boş olamaz.");
  return out;
}

/**
 * Ürün fotoğrafını Runway'in data URI sınırına sığdırır. Sığıyorsa bayt bayt aynen gider; sığmıyorsa aynı boyutta
 * JPEG q95 4:4:4, sonra kademeli küçültme (lanczos3). Dönüşüm kayda yazılır.
 */
export async function runwayImageUri(img: VideoGenImage): Promise<{ uri: string; transformed: "none" | "reencoded" | "downscaled"; bytes: number }> {
  const direct = `data:${img.mimeType};base64,${img.base64}`;
  if (direct.length <= RUNWAY_DATA_URI_MAX && ["image/jpeg", "image/png", "image/webp"].includes(img.mimeType)) {
    return { uri: direct, transformed: "none", bytes: Math.floor((img.base64.length * 3) / 4) };
  }
  const buf = Buffer.from(img.base64, "base64");
  const meta = await sharp(buf).metadata();
  const long = Math.max(meta.width ?? 0, meta.height ?? 0);
  for (const step of [{ long: null as number | null, q: 95 }, { long: 3072, q: 95 }, { long: 2560, q: 92 }, { long: 2048, q: 92 }]) {
    let s = sharp(buf).rotate().flatten({ background: "#ffffff" }).toColourspace("srgb");
    if (step.long && long > step.long) s = s.resize(step.long, step.long, { fit: "inside", kernel: "lanczos3", withoutEnlargement: true });
    const out = await s.jpeg({ quality: step.q, chromaSubsampling: "4:4:4" }).toBuffer();
    const uri = `data:image/jpeg;base64,${out.toString("base64")}`;
    if (uri.length <= RUNWAY_DATA_URI_MAX) return { uri, transformed: step.long && long > step.long ? "downscaled" : "reencoded", bytes: out.length };
  }
  throw new PermanentError("Ürün fotoğrafı Runway sınırına (5 MB) sığdırılamadı.");
}

const ID = /^[\w-]{1,128}$/;
const RUNNING = new Set(["PENDING", "THROTTLED", "RUNNING"]);

export class RunwayVideoGenerator implements VideoGenerator {
  readonly service = "runway";
  constructor(private apiKey: string, readonly model: RunwayModel, private pricing: RunwayPricing, private fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  private headers(json = false): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "X-Runway-Version": RUNWAY_VERSION, Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : {}) };
  }

  /** Kredi → USD (sahibin girdiği kredi fiyatı); fiyat yoksa null (ücretli üretim engellenir). */
  creditsToUsd(credits: number | null | undefined) {
    if (credits === null || credits === undefined || !Number.isFinite(credits) || this.pricing.usdPerCredit === null) return null;
    return Math.round(credits * this.pricing.usdPerCredit * 1e6) / 1e6;
  }

  estimateCostUsd(durationS: number) {
    if (this.pricing.creditsPerSecond === null) return null;
    return this.creditsToUsd(this.pricing.creditsPerSecond * runwayDuration(durationS));
  }

  async submit(req: VideoGenRequest) {
    const images = requestImages(req);
    const seconds = runwayDuration(req.durationS);
    const ratio = runwayRatio(req.aspectRatio);
    // gen4.5 görselden videoda tek ilk kare alır: ürün fotoğrafının ilki gönderilir (diğerleri Runway'e gitmez)
    const first = images[0];
    const image = first ? await runwayImageUri(first) : null;
    const promptText = runwayPrompt(req.prompt, !!image);
    const endpoint = image ? "/v1/image_to_video" : "/v1/text_to_video";
    const body = image
      ? { model: this.model, promptImage: image.uri, promptText, ratio, duration: seconds }
      : { model: this.model, promptText, ratio, duration: seconds };
    // Gönderim idempotent değildir: ağ hatası ve 5xx belirsiz sonuçtur (fetchJson → UncertainOutcomeError); 429 kabul edilmemiştir.
    const res = await fetchJson(`${RUNWAY_API}${endpoint}`, { method: "POST", headers: this.headers(true), body: JSON.stringify(body), timeoutMs: 60_000, idempotent: false, fetchImpl: this.fetchImpl });
    const id = res?.id;
    if (typeof id !== "string" || !ID.test(id)) throw new PermanentError("Runway görev kimliği döndürmedi.");
    const credits = Number(res?.estimatedCost?.credits);
    // Kayıtta gizli değer veya fotoğraf baytı tutulmaz. "parameters.durationSeconds" proje saniye sınırı için korunur.
    return {
      externalId: id,
      request: {
        model: this.model, api: endpoint.slice(4), mode: videoGenMode(image ? 1 : 0), prompt: promptText,
        parameters: { aspectRatio: req.aspectRatio, ratio, durationSeconds: seconds },
        reference_image: !!image, reference_images: image ? 1 : 0, reference_transform: image?.transformed ?? null, reference_bytes: image?.bytes ?? null,
        provider_estimate_credits: Number.isFinite(credits) ? credits : null,
        provider_estimate_usd: Number.isFinite(credits) ? this.creditsToUsd(credits) : null,
      },
    };
  }

  private async task(id: string) {
    if (!ID.test(id)) throw new PermanentError("Geçersiz Runway görev kimliği.");
    return fetchJson(`${RUNWAY_API}/v1/tasks/${encodeURIComponent(id)}`, { headers: this.headers(), timeoutMs: 60_000, fetchImpl: this.fetchImpl });
  }

  async poll(externalId: string): Promise<VideoGenPoll> {
    let body: any;
    try {
      body = await this.task(externalId);
    } catch (err) {
      // Silinmiş/iptal edilmiş görev tekrar sorgulanamaz (Runway): ücret bilinmez, iş başarısızdır
      if (err instanceof PermanentError && /\b404\b/.test(err.message)) return { state: "failed", error: "Runway görevi bulunamadı (silinmiş veya iptal edilmiş).", costUsd: null };
      throw err;
    }
    const status = String(body?.status ?? "");
    const credits = Number(body?.cost?.credits);
    const cost = Number.isFinite(credits) ? { credits, costUsd: this.creditsToUsd(credits) } : { costUsd: null };
    if (RUNNING.has(status)) {
      const p = Number(body?.progress);
      return { state: "running", ...(Number.isFinite(p) ? { progress: Math.max(0, Math.min(1, p)) } : {}) };
    }
    if (status === "SUCCEEDED") {
      const out = Array.isArray(body?.output) ? body.output.find((u: unknown) => typeof u === "string") : null;
      if (!out) return { state: "failed", error: "Runway görevi tamamlandı ama çıktı adresi döndürmedi.", ...cost };
      // Adres 24-48 saatte geçersizleşir: indirmede görev yeniden sorgulanır (taze adres)
      return { state: "succeeded", videoUri: `runway-task:${externalId}`, ...cost };
    }
    if (status === "FAILED") {
      const why = String(body?.failure ?? "neden belirtilmedi").slice(0, 300);
      const code = typeof body?.failureCode === "string" ? body.failureCode.slice(0, 80) : null;
      return { state: "failed", filtered: /safety|moderation|content|policy/i.test(`${code ?? ""} ${why}`), error: `Runway üretimi başarısız${code ? ` (${code})` : ""}: ${why}`, ...cost };
    }
    if (status === "CANCELLED") return { state: "failed", error: "Runway görevi iptal edildi veya silindi.", ...cost };
    throw new TransientError(`Runway görev durumu tanınmadı: ${status.slice(0, 40) || "boş"}`);
  }

  async download(uri: string, maxBytes: number): Promise<Buffer> {
    let target = uri;
    if (uri.startsWith("runway-task:")) {
      const body = await this.task(uri.slice("runway-task:".length));
      const out = body?.status === "SUCCEEDED" && Array.isArray(body.output) ? body.output.find((u: unknown) => typeof u === "string") : null;
      if (!out) throw new PermanentError("Runway görevinde indirilecek video yok (çıktı süresi dolmuş veya görev silinmiş olabilir).");
      target = out;
    }
    let url = new URL(target);
    for (let hop = 0; hop < 5; hop++) {
      if (url.protocol !== "https:") throw new PermanentError("Video adresi HTTPS değil.");
      // API anahtarı yalnızca Runway API alan adına gider; imzalı çıktı adresine (CDN) gönderilmez.
      const headers: Record<string, string> = url.host === API_HOST ? this.headers() : {};
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers, redirect: "manual", signal: ctrl.signal });
      } catch (err) {
        clearTimeout(timer);
        throw new TransientError(`Runway videosu indirilemedi: ${(err as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        clearTimeout(timer);
        const loc = res.headers.get("location");
        if (!loc) throw new PermanentError("Yönlendirme adresi yok.");
        url = new URL(loc, url);
        continue;
      }
      try {
        if (res.status === 429 || res.status >= 500) throw new TransientError(`Runway video indirme geçici hatası ${res.status}`);
        if (!res.ok) throw new PermanentError(`Runway videosu indirilemedi: ${res.status}`);
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > maxBytes) throw new PermanentError("Video dosyası izin verilen boyuttan büyük.");
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
          total += c.length;
          if (total > maxBytes) throw new PermanentError("Video dosyası izin verilen boyuttan büyük.");
          chunks.push(Buffer.from(c));
        }
        if (!total) throw new PermanentError("Runway boş video döndürdü.");
        return Buffer.concat(chunks);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new PermanentError("Çok fazla yönlendirme.");
  }
}

/** Bağlantı testi: GET /v1/organization (kredi bakiyesi; video üretmez, kredi harcamaz). */
export async function runwayOrganization(apiKey: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
  const body = await fetchJson(`${RUNWAY_API}/v1/organization`, { headers: { Authorization: `Bearer ${apiKey}`, "X-Runway-Version": RUNWAY_VERSION, Accept: "application/json" }, timeoutMs: 30_000, fetchImpl });
  return { creditBalance: Number.isFinite(Number(body?.creditBalance)) ? Number(body.creditBalance) : null };
}
