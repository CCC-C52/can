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

// İstem önbelleği (5 dk TTL): yazma = 1,25 × giriş fiyatı; okuma = modele göre (Opus 5.5: 0,20 $/1M = 0,05 ×,
// Fable 5.1: 0,25 $/1M; diğerleri ~0,1 ×). Önbelleğe alınabilir en kısa önek bu modellerde 512 token'dır; daha
// kısa önekler hata vermeden önbelleğe alınmaz (cache_creation_input_tokens = 0).
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_PRICE: Record<string, number> = {
  "claude-fable-5-1": 0.25,
  "claude-opus-5-5": 0.2,
  "claude-opus-5": 0.5,
  "claude-sonnet-5-5": 0.2,
  "claude-haiku-5-5": 0.01,
};

export function anthropicPrice(model: string) {
  const p = PRICES[model];
  if (!p) return null;
  return { ...p, cacheWrite: p.input * CACHE_WRITE_MULT, cacheRead: CACHE_READ_PRICE[model] ?? p.input * 0.1 };
}

export type AnthropicUsage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };

/** Gerçekleşen maliyet: önbelleksiz giriş + önbellek yazma + önbellek okuma + çıktı. */
export function anthropicCostUsd(model: string, u: AnthropicUsage): number | null {
  const price = anthropicPrice(model);
  if (!price) return null;
  return (
    u.input_tokens * price.input +
    (u.cache_creation_input_tokens ?? 0) * price.cacheWrite +
    (u.cache_read_input_tokens ?? 0) * price.cacheRead +
    u.output_tokens * price.output
  ) / 1_000_000;
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
    if (n.type === "object") {
      n.additionalProperties = false;
      // Varsayılanlı alanlar da üretimde zorunlu tutulur (eski kayıtların düzenlenmesi için varsayılan yalnızca ayrıştırmada kullanılır)
      if (n.properties && typeof n.properties === "object") n.required = Object.keys(n.properties as object);
    }
    delete n.default;
    Object.values(n).forEach(walk);
  };
  walk(js);
  return js;
}

function userContent(req: GenerateRequest<unknown>) {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (req.userPrefix) blocks.push({ type: "text", text: req.userPrefix, cache_control: { type: "ephemeral" } });
  for (const img of req.images ?? []) {
    if (img.label) blocks.push({ type: "text", text: img.label });
    blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
  }
  blocks.push({ type: "text", text: req.user });
  return blocks;
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

  estimateCostUsd(req: { system: string; user: string; userPrefix?: string; maxTokens: number; imageCount?: number }): number | null {
    const price = anthropicPrice(this.model);
    if (!price) return null;
    // Üst sınır: önbelleğe alınabilir önek (sistem + marka bağlamı) yazma fiyatıyla (1,25 ×) sayılır — önbellek
    // isabeti varsa gerçek maliyet bundan düşük olur. Görsel başına üst sınır ~1.600 token (uzun kenar ≤ 1568 px).
    const cacheable = approxTokens(req.system) + approxTokens(req.userPrefix ?? "");
    const input = approxTokens(req.user) + (req.imageCount ?? 0) * 1600;
    return (cacheable * price.cacheWrite + input * price.input + req.maxTokens * price.output) / 1_000_000;
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
          // Önbellek: sabit önek (sistem istemi, ardından marka bağlamı) önce gelir ve işaretlenir; değişen içerik
          // (görseller, talimat) son işaretten sonradır. Sistem istemi tek başına 512 token'dan kısaysa yalnızca
          // ikinci işaret (sistem + marka bağlamı) etkili olur.
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: userContent(req) }],
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

    const usage: AnthropicUsage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const servedModel = response.model ?? this.model;
    const actualCostUsd = anthropicCostUsd(servedModel, usage);

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
