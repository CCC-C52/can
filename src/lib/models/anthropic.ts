import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "@/lib/config";
import { PermanentError, TransientError, type GenerateRequest, type GenerateResult, type TextModelAdapter } from "./types";

// USD / 1M token (Anthropic birinci taraf API fiyatları; değişirse burayı güncelleyin)
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function anthropicPrice(model: string) {
  return PRICES[model] ?? null;
}

/** Kaba token tahmini (karakter / 3). Yalnızca bütçe ön kontrolü için kullanılır. */
function approxTokens(text: string) {
  return Math.ceil(text.length / 3);
}

/** Zod şemasını structured outputs için katı JSON şemasına çevirir (tüm nesnelerde additionalProperties: false). */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete js.$schema;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as Record<string, unknown>;
    if (n.type === "object") n.additionalProperties = false;
    Object.values(n).forEach(walk);
  };
  walk(js);
  return js;
}

export class AnthropicAdapter implements TextModelAdapter {
  readonly isDemo = false;
  readonly service = "anthropic";
  private client: Anthropic;

  constructor(private model = config.anthropic.model, apiKey = config.anthropic.apiKey) {
    if (!apiKey) throw new PermanentError("AIOPS_ANTHROPIC_API_KEY tanımlı değil");
    this.client = new Anthropic({ apiKey, maxRetries: 0 }); // tekrar denemeyi görev işleyicisi yönetir
  }

  get id() {
    return `anthropic:${this.model}`;
  }

  estimateCostUsd(req: { system: string; user: string; maxTokens: number; imageCount?: number }): number | null {
    const price = anthropicPrice(this.model);
    if (!price) return null;
    // Görsel başına üst sınır ~1.600 token (uzun kenar ≤ 1568 px)
    const input = approxTokens(req.system) + approxTokens(req.user) + (req.imageCount ?? 0) * 1600;
    return (input * price.input + req.maxTokens * price.output) / 1_000_000;
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const jsonSchema = toStrictJsonSchema(req.schema);
    let response;
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: config.anthropic.effort, format: { type: "json_schema", schema: jsonSchema } },
          system: req.system,
          messages: [
            {
              role: "user",
              content: req.images?.length
                ? [
                    ...req.images.flatMap((img) => [
                      ...(img.label ? [{ type: "text" as const, text: img.label }] : []),
                      { type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: img.base64 } },
                    ]),
                    { type: "text" as const, text: req.user },
                  ]
                : req.user,
            },
          ],
        },
        { signal: req.signal },
      );
      response = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new PermanentError(`Anthropic kimlik doğrulama hatası (${err.status}). API anahtarını kontrol edin.`);
      }
      if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
        throw new PermanentError(`Anthropic isteği reddetti (${err.status}): ${err.message}`);
      }
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
        throw new TransientError(`Anthropic geçici hata: ${(err as Error).message}`, err);
      }
      if (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500) {
        throw new TransientError(`Anthropic geçici hata (${err.status})`, err);
      }
      throw err;
    }

    const usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
    const servedModel = response.model ?? this.model;
    const price = anthropicPrice(servedModel);
    const actualCostUsd = price ? (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000 : null;

    if (response.stop_reason === "refusal") {
      throw new PermanentError("Model isteği reddetti (refusal). Talimatı gözden geçirin.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new TransientError("Model çıktısı token sınırında kesildi.");
    }
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TransientError("Model geçerli JSON döndürmedi.");
    }
    const result = req.schema.safeParse(parsed);
    if (!result.success) throw new TransientError(`Model çıktısı şemaya uymuyor: ${result.error.message.slice(0, 300)}`);
    return { data: result.data, generator: `anthropic:${servedModel}`, isDemo: false, model: servedModel, usage, actualCostUsd };
  }
}
