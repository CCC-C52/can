import type { z } from "zod";
import type { AgentId } from "@/lib/agents/schemas";

export type GenerateRequest<T> = {
  agent: AgentId;
  purpose: string;               // plan | work | review | report
  system: string;
  user: string;
  /** İsteğe bağlı sabit önek (marka bağlamı). Gerçek modelde `user`dan önce, önbellek işaretiyle gönderilir. */
  userPrefix?: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  signal?: AbortSignal;
  /** Demo üretici için yapılandırılmış girdi (gerçek modelde kullanılmaz). */
  demoInput: unknown;
  /** Görüntü girdileri (gerçek pikseller). Her biri isteğe bağlı bir etiketle (ör. "kare 2 · 3,5 sn") gönderilir. */
  images?: { mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string; label?: string }[];
};

export type GenerateResult<T> = {
  data: T;
  generator: string;      // "demo" | "anthropic:<model>"
  isDemo: boolean;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null;
  /** Gerçekleşen maliyet. null = bilinmiyor. Demo = 0 (ücret yok). */
  actualCostUsd: number | null;
};

export interface TextModelAdapter {
  readonly id: string;
  readonly isDemo: boolean;
  readonly service: string;
  /** Doluysa model kullanılamaz; nedeni burada yazar. */
  readonly unavailableReason?: string;
  /** Çağrıdan önce üst sınır maliyet tahmini; null = tahmin edilemiyor. */
  estimateCostUsd(req: { system: string; user: string; userPrefix?: string; maxTokens: number; imageCount?: number }): number | null;
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

/** Geçici (yeniden denenebilir) hata. */
export class TransientError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** Model bağlı değil (canlı ortamda anahtar yok, demo kapalı). Görev "Bağlantı bekliyor" olur. */
export class ModelUnavailableError extends Error {}

/** Kalıcı hata — tekrar denemek sonucu değiştirmez. */
export class PermanentError extends Error {}
