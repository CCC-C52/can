import { config } from "@/lib/config";
import { upsertConnection } from "@/lib/services/connections";
import { PermanentError, TransientError } from "@/lib/models/types";
import { fetchJson } from "./http";

// AI video üretimi: Google Veo (Gemini API, uzun süren işlem).
//   gönder: POST /v1beta/models/{model}:predictLongRunning → { name: "models/.../operations/..." }
//   sorgula: GET /v1beta/{name} → { done, response.generateVideoResponse.generatedSamples[0].video.uri } | { done, error }
//   indir: GET {uri} (API anahtarı yalnızca Google API alan adına gönderilir; yönlendirmeler elle izlenir)
// Üretilen dosyalar sağlayıcıda kısa süre tutulur; bu yüzden sonuç hemen indirilip arşive kaydedilir.
// NOT: Bu ortamda GEMINI_API_KEY yoktur; gerçek çağrı yapılmadı, davranış sahte sunucu ile test edildi.

export const VEO_API = "https://generativelanguage.googleapis.com";
const API_HOST = new URL(VEO_API).host;

export type VideoGenRequest = {
  prompt: string;
  durationS: number;                      // sağlayıcı sınırına (4-8 sn) yuvarlanır
  aspectRatio: "9:16" | "16:9";
  image?: { base64: string; mimeType: string }; // ilk kare olarak gerçek ürün fotoğrafı (isteğe bağlı)
};
export type VideoGenPoll =
  | { state: "running" }
  | { state: "succeeded"; videoUri: string }
  | { state: "failed"; error: string; filtered?: boolean };

export interface VideoGenerator {
  readonly service: string;
  readonly model: string;
  estimateCostUsd(durationS: number): number | null;
  submit(req: VideoGenRequest): Promise<{ externalId: string; request: Record<string, unknown> }>;
  poll(externalId: string): Promise<VideoGenPoll>;
  download(uri: string, maxBytes: number): Promise<Buffer>;
}

export function veoDuration(seconds: number) {
  return Math.min(8, Math.max(4, Math.round(seconds)));
}
export function veoAspect(format: string): "9:16" | "16:9" {
  return format === "16:9" ? "16:9" : "9:16";
}

export class VeoGenerator implements VideoGenerator {
  readonly service = "video_generation";
  constructor(private apiKey: string, readonly model: string, private costPerSecond: number | null) {}

  estimateCostUsd(durationS: number) {
    return this.costPerSecond === null ? null : Math.round(this.costPerSecond * veoDuration(durationS) * 1e6) / 1e6;
  }

  async submit(req: VideoGenRequest) {
    const instance: Record<string, unknown> = { prompt: req.prompt };
    if (req.image) instance.image = { bytesBase64Encoded: req.image.base64, mimeType: req.image.mimeType };
    const parameters = { aspectRatio: req.aspectRatio, durationSeconds: veoDuration(req.durationS), resolution: "720p" };
    // Gönderim idempotent değildir: ağ hatasında sonuç belirsiz kabul edilir ve OTOMATİK TEKRAR GÖNDERİLMEZ.
    const body = await fetchJson(`${VEO_API}/v1beta/models/${encodeURIComponent(this.model)}:predictLongRunning`, {
      method: "POST",
      headers: { "x-goog-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [instance], parameters }),
      timeoutMs: 60_000,
      idempotent: false,
    });
    const name = body?.name;
    if (typeof name !== "string" || !/^[\w./-]+$/.test(name)) throw new PermanentError("Video servisi işlem kimliği döndürmedi.");
    // Kayıtta gizli değer veya fotoğraf baytı tutulmaz
    return { externalId: name, request: { model: this.model, prompt: req.prompt, parameters, reference_image: !!req.image } };
  }

  async poll(externalId: string): Promise<VideoGenPoll> {
    if (!/^[\w./-]+$/.test(externalId)) throw new PermanentError("Geçersiz işlem kimliği.");
    const body = await fetchJson(`${VEO_API}/v1beta/${externalId}`, { headers: { "x-goog-api-key": this.apiKey }, timeoutMs: 30_000 });
    if (!body?.done) return { state: "running" };
    if (body.error) return { state: "failed", error: `${body.error.code ?? ""} ${body.error.message ?? "bilinmeyen hata"}`.trim() };
    const resp = body.response?.generateVideoResponse;
    const uri = resp?.generatedSamples?.[0]?.video?.uri;
    if (typeof uri === "string") return { state: "succeeded", videoUri: uri };
    const filtered = resp?.raiMediaFilteredCount > 0;
    return { state: "failed", filtered, error: filtered ? `Sağlayıcı içerik filtresi: ${(resp.raiMediaFilteredReasons ?? []).join("; ") || "neden belirtilmedi"}` : "İşlem tamamlandı ama video döndürmedi." };
  }

  async download(uri: string, maxBytes: number): Promise<Buffer> {
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

let override: VideoGenerator | null | undefined;
/** Testler için sağlayıcıyı değiştirir (sahte sunucu). */
export function setVideoGeneratorOverride(g: VideoGenerator | null | undefined) {
  override = g;
}

export function getVideoGenerator(): VideoGenerator | null {
  if (override !== undefined) return override;
  if (!config.gemini.apiKey) return null;
  return new VeoGenerator(config.gemini.apiKey, config.gemini.veoModel, config.gemini.costPerSecondUsd);
}

export async function testVeo() {
  if (!config.gemini.apiKey) return { ok: false, detail: "GEMINI_API_KEY tanımlı değil." };
  await upsertConnection("video_generation", null, { status: "testing" });
  try {
    // Ücretsiz uç nokta: model bilgisini okur, video üretmez.
    await fetchJson(`${VEO_API}/v1beta/models/${encodeURIComponent(config.gemini.veoModel)}`, { headers: { "x-goog-api-key": config.gemini.apiKey } });
    await upsertConnection("video_generation", null, { status: "connected", lastError: null });
    return { ok: true, detail: `Model erişilebilir: ${config.gemini.veoModel}${config.gemini.costPerSecondUsd === null ? " (VEO_COST_PER_SECOND_USD tanımlı değil: maliyet bilinmediği için üretim engellenir)" : ""}` };
  } catch (err) {
    await upsertConnection("video_generation", null, { status: "error", lastError: (err as Error).message });
    return { ok: false, detail: (err as Error).message };
  }
}
