import { config } from "@/lib/config";
import { upsertConnection } from "@/lib/services/connections";
import { PermanentError } from "@/lib/models/types";
import { fetchJson } from "./http";

// Görsel üretim adaptörü arayüzü + OpenAI Images API uygulaması.
// NOT: Bu ortamda API anahtarı olmadığı için gerçek üretim test edilmedi.

export interface ImageGenerator {
  readonly service: string;
  estimateCostUsd(): number | null;
  generate(prompt: string, size: "1024x1024" | "1024x1536" | "1536x1024"): Promise<Buffer>;
}

export class OpenAIImageGenerator implements ImageGenerator {
  readonly service = "openai_images";
  estimateCostUsd() {
    return config.openaiImages.costPerImageUsd;
  }
  async generate(prompt: string, size: "1024x1024" | "1024x1536" | "1536x1024") {
    if (!config.openaiImages.apiKey) throw new PermanentError("OPENAI_API_KEY tanımlı değil.");
    const body = await fetchJson("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiImages.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.openaiImages.model, prompt, size, n: 1 }),
      timeoutMs: 120_000,
    });
    const b64 = body?.data?.[0]?.b64_json;
    if (!b64) throw new PermanentError("Görsel servisi beklenen veriyi döndürmedi.");
    return Buffer.from(b64, "base64");
  }
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

export function formatToSize(format: string): "1024x1024" | "1024x1536" | "1536x1024" {
  if (format === "16:9") return "1536x1024";
  if (format === "9:16" || format === "4:5") return "1024x1536";
  return "1024x1024";
}
