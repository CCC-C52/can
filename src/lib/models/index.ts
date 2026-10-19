import { config } from "@/lib/config";
import { AnthropicAdapter } from "./anthropic";
import { DemoAdapter } from "./demo";
import { ModelUnavailableError, type GenerateRequest, type GenerateResult, type TextModelAdapter } from "./types";

const g = globalThis as unknown as { __textModelOverride?: TextModelAdapter | null };

/** Testlerde farklı adaptör (ör. ücretli sahte model) enjekte etmek için. */
export function setTextModelOverride(adapter: TextModelAdapter | null) {
  g.__textModelOverride = adapter;
}

const OFF_REASON = "AI modeli bağlı değil: canlı ortamda DEMO kapalıdır. Sunucu ortamına AIOPS_ANTHROPIC_API_KEY ekleyip servisleri yeniden başlatın.";

/** Canlı ortamda anahtar yoksa kullanılan adaptör: hiçbir içerik üretmez. */
class UnavailableAdapter implements TextModelAdapter {
  readonly id = "unavailable";
  readonly isDemo = false;
  readonly service = "none";
  readonly unavailableReason = OFF_REASON;
  estimateCostUsd() {
    return 0;
  }
  async generate<T>(_req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    throw new ModelUnavailableError(OFF_REASON);
  }
}

export function getTextModel(): TextModelAdapter {
  if (g.__textModelOverride) return g.__textModelOverride;
  if (config.anthropic.apiKey) return new AnthropicAdapter();
  if (config.demoAllowed) return new DemoAdapter();
  return new UnavailableAdapter();
}

export function textModelMode(): { mode: "real" | "demo" | "off"; label: string } {
  if (config.anthropic.apiKey) return { mode: "real", label: `Gerçek AI modu (${config.anthropic.model})` };
  if (config.demoAllowed) return { mode: "demo", label: "DEMO modu — model anahtarı yok, çıktılar kural tabanlı şablonlardır" };
  return { mode: "off", label: "AI modeli bağlı değil — canlı ortamda DEMO kapalı" };
}
