import type { z } from "zod";
import type { AgentId } from "@/lib/agents/schemas";

export type GenerateRequest<T> = {
  agent: AgentId;
  purpose: string;               // plan | work | review | report
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  signal?: AbortSignal;
  /** Demo üretici için yapılandırılmış girdi (gerçek modelde kullanılmaz). */
  demoInput: unknown;
};

export type GenerateResult<T> = {
  data: T;
  generator: string;      // "demo" | "anthropic:<model>"
  isDemo: boolean;
  model: string;
  usage: { input_tokens: number; output_tokens: number } | null;
  /** Gerçekleşen maliyet. null = bilinmiyor. Demo = 0 (ücret yok). */
  actualCostUsd: number | null;
};

export interface TextModelAdapter {
  readonly id: string;
  readonly isDemo: boolean;
  readonly service: string;
  /** Çağrıdan önce üst sınır maliyet tahmini; null = tahmin edilemiyor. */
  estimateCostUsd(req: { system: string; user: string; maxTokens: number }): number | null;
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

/** Geçici (yeniden denenebilir) hata. */
export class TransientError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** Kalıcı hata — tekrar denemek sonucu değiştirmez. */
export class PermanentError extends Error {}
