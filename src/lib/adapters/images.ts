import { config } from "@/lib/config";
import { upsertConnection } from "@/lib/services/connections";
import { PermanentError } from "@/lib/models/types";
import { fetchJson } from "./http";

import sharp, { type Metadata } from "sharp";

// Görsel üretim adaptörü arayüzü + OpenAI Images API uygulaması.
//   üretim: POST /v1/images/generations (b64_json)
//   referanslı üretim: POST /v1/images/edits (multipart; gerçek ürün fotoğrafı referans olarak, input_fidelity=high)
// NOT: Bu ortamda API anahtarı yoktur; gerçek çağrı yapılmadı, davranış sahte yanıtlarla test edildi.

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";
export type ReferenceImage = { buffer: Buffer; mime: string; filename: string };

export interface ImageGenerator {
  readonly service: string;
  readonly model: string;
  estimateCostUsd(): number | null;
  generate(prompt: string, size: ImageSize, references?: ReferenceImage[]): Promise<Buffer>;
}

export class OpenAIImageGenerator implements ImageGenerator {
  readonly service = "openai_images";
  get model() { return config.openaiImages.model; }
  estimateCostUsd() {
    return config.openaiImages.costPerImageUsd;
  }
  async generate(prompt: string, size: ImageSize, references: ReferenceImage[] = []) {
    const key = config.openaiImages.apiKey;
    if (!key) throw new PermanentError("OPENAI_API_KEY tanımlı değil.");
    // Görsel üretimi idempotent değildir: belirsiz sonuçta otomatik tekrar yapılmaz (ikinci ücret riski).
    let body: any;
    if (references.length) {
      const form = new FormData();
      form.append("model", this.model);
      form.append("prompt", prompt);
      form.append("size", size);
      form.append("n", "1");
      form.append("input_fidelity", "high");
      for (const r of references.slice(0, 4)) form.append("image[]", new Blob([new Uint8Array(r.buffer)], { type: r.mime }), r.filename);
      body = await fetchJson("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, timeoutMs: 180_000, idempotent: false });
    } else {
      body = await fetchJson("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt, size, n: 1 }),
        timeoutMs: 180_000,
        idempotent: false,
      });
    }
    const b64 = body?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64) throw new PermanentError("Görsel servisi beklenen veriyi döndürmedi.");
    return Buffer.from(b64, "base64");
  }
}

/** Referansın uzun kenarı en çok bu kadar gönderilir (çıktı en çok 1536 px; Drive orijinalleri 6000 px'e varabilir). */
export const REFERENCE_MAX_PX = 2048;

/**
 * Referans fotoğrafı gönderim boyutuna indirir (512 MB işleyicide tam çözünürlüklü orijinalin birkaç kopyası bellek
 * taşırıyordu). Küçük ve döndürme gerektirmeyen fotoğraf olduğu gibi gider; şeffaflık varsa PNG, yoksa JPEG q95 4:4:4.
 */
export async function fitReference(r: ReferenceImage): Promise<ReferenceImage & { resized: boolean }> {
  const meta = await sharp(r.buffer).metadata();
  const [w, h] = (meta.orientation ?? 1) >= 5 ? [meta.height ?? 0, meta.width ?? 0] : [meta.width ?? 0, meta.height ?? 0];
  if (Math.max(w, h) <= REFERENCE_MAX_PX && (meta.orientation ?? 1) === 1) return { ...r, resized: false };
  const alpha = !!meta.hasAlpha;
  const img = sharp(r.buffer).rotate().resize(REFERENCE_MAX_PX, REFERENCE_MAX_PX, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" });
  const buffer = await (alpha ? img.png() : img.jpeg({ quality: 95, chromaSubsampling: "4:4:4" })).toBuffer();
  return { buffer, mime: alpha ? "image/png" : "image/jpeg", filename: r.filename.replace(/\.[a-z0-9]+$/i, alpha ? ".png" : ".jpg"), resized: true };
}

/**
 * Üretilen görselin gerçek, çözülebilir bir görsel olduğunu doğrular. Boş/tek renk/çok küçük dosyalar
 * (yer tutucu) başarılı üretim sayılmaz.
 */
export async function validateGeneratedImage(buf: Buffer): Promise<{ width: number; height: number; format: string }> {
  let meta: Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    throw new PermanentError("Üretilen dosya görsel olarak çözülemedi.");
  }
  if (!meta.width || !meta.height || meta.width < 256 || meta.height < 256) throw new PermanentError("Üretilen görsel çok küçük; yer tutucu olabilir.");
  const st = await sharp(buf).stats();
  const spread = Math.max(...st.channels.slice(0, 3).map((c) => c.stdev));
  if (spread < 2) throw new PermanentError("Üretilen görsel tek renk; geçerli üretim sayılmadı.");
  return { width: meta.width, height: meta.height, format: meta.format ?? "unknown" };
}

export async function testOpenAIImages() {
  if (!config.openaiImages.apiKey) return { ok: false, detail: "OPENAI_API_KEY tanımlı değil." };
  await upsertConnection("openai_images", null, { status: "testing" });
  try {
    await fetchJson(`https://api.openai.com/v1/models/${encodeURIComponent(config.openaiImages.model)}`, { headers: { Authorization: `Bearer ${config.openaiImages.apiKey}` } });
    await upsertConnection("openai_images", null, { status: "connected", lastError: null });
    return { ok: true, detail: `Model erişilebilir: ${config.openaiImages.model}` };
  } catch (err) {
    await upsertConnection("openai_images", null, { status: "error", lastError: (err as Error).message });
    return { ok: false, detail: (err as Error).message };
  }
}

export function formatToSize(format: string): ImageSize {
  if (format === "16:9") return "1536x1024";
  if (format === "9:16" || format === "4:5") return "1024x1536";
  return "1024x1024";
}

let override: ImageGenerator | null | undefined;
/** Testler için sağlayıcıyı değiştirir (sahte yanıt). */
export function setImageGeneratorOverride(g: ImageGenerator | null | undefined) {
  override = g;
}
export function getImageGenerator(): ImageGenerator | null {
  if (override !== undefined) return override;
  return config.openaiImages.apiKey ? new OpenAIImageGenerator() : null;
}
