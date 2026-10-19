import { config } from "@/lib/config";
import { AnthropicAdapter } from "./anthropic";
import { DemoAdapter } from "./demo";
import type { TextModelAdapter } from "./types";

const g = globalThis as unknown as { __textModelOverride?: TextModelAdapter | null };

/** Testlerde farklı adaptör (ör. ücretli sahte model) enjekte etmek için. */
export function setTextModelOverride(adapter: TextModelAdapter | null) {
  g.__textModelOverride = adapter;
}

export function getTextModel(): TextModelAdapter {
  if (g.__textModelOverride) return g.__textModelOverride;
  if (config.anthropic.apiKey) return new AnthropicAdapter();
  return new DemoAdapter();
}

export function textModelMode(): { mode: "real" | "demo"; label: string } {
  return config.anthropic.apiKey
    ? { mode: "real", label: `Gerçek AI modu (${config.anthropic.model})` }
    : { mode: "demo", label: "DEMO modu — model anahtarı yok, çıktılar kural tabanlı şablonlardır" };
}
