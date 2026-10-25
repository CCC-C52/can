import { config } from "@/lib/config";
import { upsertConnection } from "@/lib/services/connections";
import { PermanentError, TransientError } from "@/lib/models/types";
import { fetchJson } from "./http";

// AI video üretimi: Google Gemini Omni Flash (Gemini API, Interactions API).
//   gönder: POST /v1beta/interactions { model, input, response_format: { type: "video", aspect_ratio, duration, resolution }, background: true }
//           → { id, status }
//   sorgula: GET /v1beta/interactions/{id} → { status, steps: [..., { type: "model_output", content: [{ type: "video", data | uri }] }] }
//   indir: satır içi (base64) veri ya da dosya adresi (API anahtarı yalnızca Google API alan adına gönderilir).
// Veo'nun predictLongRunning akışı kullanılmaz. Alan adları @google/genai 2.31 tiplerinden doğrulandı
// (VideoResponseFormat: aspect_ratio "9:16"|"16:9", duration (metin), resolution "720p", delivery "inline"|"uri").
// NOT: Bu ortamda GEMINI_API_KEY yoktur; gerçek çağrı yapılmadı, davranış sahte sunucu ile test edildi.
// "duration" değerinin biçimi ("6s") resmî örnekle doğrulanamadı; ilk gerçek çağrıda kontrol edilmelidir.

export const GEMINI_API = "https://generativelanguage.googleapis.com";
/** Eski içe aktarmalar için. */
export const VEO_API = GEMINI_API;
const API_HOST = new URL(GEMINI_API).host;

export const OMNI_MIN_SECONDS = 3;
export const OMNI_MAX_SECONDS = 10;
/** Sağlayıcıya gönderilen en fazla ürün referans fotoğrafı. */
export const MAX_REFERENCE_IMAGES = 3;

export type VideoGenMode = "text_to_video" | "image_to_video" | "reference_to_video";
export type VideoGenImage = { base64: string; mimeType: string };
export type VideoGenRequest = {
  prompt: string;
  durationS: number;                      // sağlayıcı sınırına (3-10 sn) yuvarlanır
  aspectRatio: "9:16" | "16:9";
  /** Gerçek ürün fotoğrafları (1: ilk kare, 2+: ürün referansı). */
  images?: VideoGenImage[];
  /** Eski alan: tek ürün fotoğrafı (images ile birleştirilir). */
  image?: VideoGenImage;
};
export type VideoGenPoll =
  | { state: "running" }
  | { state: "succeeded"; videoUri: string }
  | { state: "failed"; error: string; filtered?: boolean };

export const CONTRACT_UNVERIFIED =
  "Gemini video model/istek sözleşmesi doğrulanmadı (GEMINI_VIDEO_CONTRACT_VERIFIED=true sahip tarafından, model ve istek biçimi resmî belgeyle teyit edildikten sonra ayarlanmalı); ücretli gönderim yapılmadı";

export interface VideoGenerator {
  readonly service: string;
  readonly model: string;
  /** false: model adı/istek biçimi teyit edilmedi — ücretli gönderim yapılmaz. Tanımsız: test/sahte sağlayıcı. */
  readonly contractVerified?: boolean;
  estimateCostUsd(durationS: number): number | null;
  submit(req: VideoGenRequest): Promise<{ externalId: string; request: Record<string, unknown> }>;
  poll(externalId: string): Promise<VideoGenPoll>;
  download(uri: string, maxBytes: number): Promise<Buffer>;
}

export function omniDuration(seconds: number) {
  return Math.min(OMNI_MAX_SECONDS, Math.max(OMNI_MIN_SECONDS, Math.round(Number(seconds) || OMNI_MIN_SECONDS)));
}
export function omniAspect(format: string): "9:16" | "16:9" {
  return format === "16:9" ? "16:9" : "9:16";
}
/** Eski adlar (uyumluluk). */
export const veoDuration = omniDuration;
export const veoAspect = omniAspect;

export function requestImages(req: Pick<VideoGenRequest, "images" | "image">): VideoGenImage[] {
  return [...(req.images ?? []), ...(req.image ? [req.image] : [])].slice(0, MAX_REFERENCE_IMAGES);
}
export function videoGenMode(imageCount: number): VideoGenMode {
  return imageCount === 0 ? "text_to_video" : imageCount === 1 ? "image_to_video" : "reference_to_video";
}

// Gerçek ürünün görünümü korunur: baskı, renk, logo ve oranlar değiştirilmez.
const PRESERVE =
  "The attached photo(s) show the real FRIBEE product. Keep the product exactly as photographed: the same print and artwork, " +
  "the same colours, the same logo and lettering, and the same cut and proportions. Do not redraw, recolour, mirror, crop out " +
  "or add text, logos or graphics to the product.";

function inputFor(prompt: string, images: VideoGenImage[]) {
  const mode = videoGenMode(images.length);
  if (mode === "text_to_video") return prompt;
  const lead = mode === "image_to_video"
    ? "Use the attached photo as the first frame of the video and animate from it."
    : "Use the attached photos as reference images of the same product; show this product in the video.";
  return [
    { type: "text", text: `${lead} ${PRESERVE}\n\n${prompt}` },
    ...images.map((i) => ({ type: "image", data: i.base64, mime_type: i.mimeType })),
  ];
}

const ID = /^[\w.-]+$/;
const FAILED = new Set(["failed", "cancelled", "incomplete", "budget_exceeded", "requires_action"]);

export class GeminiOmniVideoGenerator implements VideoGenerator {
  readonly service = "video_generation";
  constructor(private apiKey: string, readonly model: string, private costPerSecond: number | null, readonly contractVerified = false) {}

  estimateCostUsd(durationS: number) {
    return this.costPerSecond === null ? null : Math.round(this.costPerSecond * omniDuration(durationS) * 1e6) / 1e6;
  }

  async submit(req: VideoGenRequest) {
    const images = requestImages(req);
    const mode = videoGenMode(images.length);
    const seconds = omniDuration(req.durationS);
    const responseFormat = { type: "video", aspect_ratio: omniAspect(req.aspectRatio), duration: `${seconds}s`, resolution: "720p" };
    // Gönderim idempotent değildir: ağ hatasında sonuç belirsiz kabul edilir ve OTOMATİK TEKRAR GÖNDERİLMEZ.
    const body = await fetchJson(`${GEMINI_API}/v1beta/interactions`, {
      method: "POST",
      headers: { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: inputFor(req.prompt, images), response_format: responseFormat, background: true, store: true }),
      timeoutMs: 60_000,
      idempotent: false,
    });
    const id = body?.id;
    if (typeof id !== "string" || !ID.test(id)) throw new PermanentError("Video servisi etkileşim kimliği döndürmedi.");
    // Kayıtta gizli değer veya fotoğraf baytı tutulmaz. "parameters.durationSeconds" proje saniye sınırı için korunur.
    return {
      externalId: id,
      request: {
        model: this.model, api: "interactions", mode, prompt: req.prompt,
        parameters: { aspectRatio: responseFormat.aspect_ratio, durationSeconds: seconds, resolution: "720p" },
        reference_image: images.length > 0, reference_images: images.length,
      },
    };
  }

  private async getInteraction(id: string) {
    if (!ID.test(id)) throw new PermanentError("Geçersiz işlem kimliği.");
    return fetchJson(`${GEMINI_API}/v1beta/interactions/${encodeURIComponent(id)}`, { headers: { "x-goog-api-key": this.apiKey }, timeoutMs: 60_000 });
  }

  async poll(externalId: string): Promise<VideoGenPoll> {
    const body = await this.getInteraction(externalId);
    const status = String(body?.status ?? "");
    if (status === "completed") {
      const video = outputVideo(body);
      if (video?.data) return { state: "succeeded", videoUri: `interaction:${externalId}` }; // bayt kayda yazılmaz; indirmede tekrar okunur
      if (typeof video?.uri === "string") return { state: "succeeded", videoUri: absoluteUri(video.uri) };
      const why = errorText(body);
      return { state: "failed", filtered: !!why && /safety|block|filter|policy/i.test(why), error: why ? `Sağlayıcı video döndürmedi: ${why}` : "İşlem tamamlandı ama video döndürmedi." };
    }
    if (FAILED.has(status)) {
      const why = errorText(body) ?? status;
      return { state: "failed", filtered: /safety|block|filter|policy/i.test(why), error: `Video üretimi başarısız (${status}): ${why}`.slice(0, 500) };
    }
    return { state: "running" }; // in_progress, queued
  }

  async download(uri: string, maxBytes: number): Promise<Buffer> {
    if (uri.startsWith("interaction:")) {
      const id = uri.slice("interaction:".length);
      const video = outputVideo(await this.getInteraction(id));
      if (video?.data) {
        if (Math.floor((video.data.length * 3) / 4) > maxBytes) throw new PermanentError("Video dosyası izin verilen boyuttan büyük.");
        const buf = Buffer.from(video.data, "base64");
        if (buf.length > maxBytes) throw new PermanentError("Video dosyası izin verilen boyuttan büyük.");
        if (!buf.length) throw new PermanentError("Sağlayıcı boş video döndürdü.");
        return buf;
      }
      if (typeof video?.uri === "string") return this.download(absoluteUri(video.uri), maxBytes);
      throw new PermanentError("Etkileşimde video bulunamadı (sağlayıcı sonucu artık saklamıyor olabilir).");
    }
    let url = new URL(uri);
    for (let hop = 0; hop < 5; hop++) {
      if (url.protocol !== "https:") throw new PermanentError("Video adresi HTTPS değil.");
      // Anahtar yalnızca Google API alan adına gönderilir; yönlendirilen depolama adresine gönderilmez.
      const headers: Record<string, string> = url.host === API_HOST ? { "x-goog-api-key": this.apiKey } : {};
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      let res: Response;
      try {
        res = await fetch(url, { headers, redirect: "manual", signal: ctrl.signal });
      } catch (err) {
        clearTimeout(timer);
        throw new TransientError(`Video indirilemedi: ${(err as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        clearTimeout(timer);
        const loc = res.headers.get("location");
        if (!loc) throw new PermanentError("Yönlendirme adresi yok.");
        url = new URL(loc, url);
        continue;
      }
      try {
        if (res.status === 429 || res.status >= 500) throw new TransientError(`Video indirme geçici hatası ${res.status}`);
        if (!res.ok) throw new PermanentError(`Video indirilemedi: ${res.status}`);
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > maxBytes) throw new PermanentError("Video dosyası izin verilen boyuttan büyük.");
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
          total += c.length;
          if (total > maxBytes) throw new PermanentError("Video dosyası izin verilen boyuttan büyük.");
          chunks.push(Buffer.from(c));
        }
        return Buffer.concat(chunks);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new PermanentError("Çok fazla yönlendirme.");
  }
}

/** Eski ad (uyumluluk): artık Gemini Omni Flash adaptörüdür. */
export const VeoGenerator = GeminiOmniVideoGenerator;

/** Son model çıktısındaki video (SDK'nın output_video ile aynı kural). */
function outputVideo(body: any): { data?: string; uri?: string; mime_type?: string } | null {
  if (body?.output_video?.data || body?.output_video?.uri) return body.output_video;
  const steps: any[] = Array.isArray(body?.steps) ? body.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s?.type === "user_input") break;
    if (s?.type !== "model_output" || !Array.isArray(s.content)) continue;
    for (let j = s.content.length - 1; j >= 0; j--) {
      const c = s.content[j];
      if (c?.type === "video" && (typeof c.data === "string" || typeof c.uri === "string")) return c;
    }
  }
  return null;
}

function errorText(body: any): string | null {
  const msgs: string[] = [];
  for (const e of Array.isArray(body?.errors) ? body.errors : []) if (e?.message) msgs.push(String(e.message));
  if (body?.error?.message) msgs.push(String(body.error.message));
  for (const s of Array.isArray(body?.steps) ? body.steps : []) if (s?.error?.message) msgs.push(String(s.error.message));
  return msgs.length ? msgs.join("; ").slice(0, 400) : null;
}

function absoluteUri(uri: string) {
  return new URL(uri, `${GEMINI_API}/v1beta/`).toString();
}

let override: VideoGenerator | null | undefined;
/** Testler için sağlayıcıyı değiştirir (sahte sunucu). */
export function setVideoGeneratorOverride(g: VideoGenerator | null | undefined) {
  override = g;
}

export function getVideoGenerator(): VideoGenerator | null {
  if (override !== undefined) return override;
  if (!config.gemini.apiKey) return null;
  return new GeminiOmniVideoGenerator(config.gemini.apiKey, config.gemini.videoModel, config.gemini.costPerSecondUsd, config.gemini.contractVerified);
}

/** Bağlantı testi: yalnızca model erişimini okur (ücretsiz uç nokta); video üretmez. */
export async function testGeminiOmniVideo() {
  if (!config.gemini.apiKey) return { ok: false, detail: "GEMINI_API_KEY tanımlı değil." };
  const model = config.gemini.videoModel;
  await upsertConnection("video_generation", null, { status: "testing" });
  try {
    await fetchJson(`${GEMINI_API}/v1beta/models/${encodeURIComponent(model)}`, { headers: { "x-goog-api-key": config.gemini.apiKey } });
    await upsertConnection("video_generation", null, { status: "connected", lastError: null });
    return { ok: true, detail: `Model erişilebilir: ${model}${config.gemini.costPerSecondUsd === null ? " (GEMINI_VIDEO_COST_PER_SECOND_USD tanımlı değil: maliyet bilinmediği için üretim engellenir)" : ""}` };
  } catch (err) {
    await upsertConnection("video_generation", null, { status: "error", lastError: (err as Error).message });
    return { ok: false, detail: (err as Error).message };
  }
}
/** Eski ad (uyumluluk). */
export const testVeo = testGeminiOmniVideo;
