import { config } from "@/lib/config";
import { fetchJson } from "@/lib/adapters/http";
import { PermanentError } from "@/lib/models/types";

// Gömme (embedding) sağlayıcıları — anlamsal arama için. Ekonomik modeller kullanılır; Claude Opus KULLANILMAZ.
// Yayımlanmış birim fiyatlar (yalnızca giriş belirteci; çıkış ücreti yok), 28 Ekim 2026'da resmî sayfalardan kontrol edildi:
//   OpenAI text-embedding-3-small  $0.02 / 1M belirteç  (https://developers.openai.com/api/docs/models/text-embedding-3-small)
//   Voyage AI voyage-3.5-lite      $0.02 / 1M belirteç  (https://docs.voyageai.com/pricing)
// Fiyat sağlayıcı faturasıyla doğrulanmadı; EMBEDDINGS_PRICE_PER_MTOK_USD ile geçersiz kılınabilir.
// Fiyatı bilinmeyen model ücretli işlem yapamaz (null → engellenir).

export const EMBEDDING_DIMS = 512;
export const EMBEDDING_PRICES_PER_MTOK: Record<string, number> = { "text-embedding-3-small": 0.02, "voyage-3.5-lite": 0.02 };
const BATCH = 64;

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  readonly dims: number;
  /** $ / 1M giriş belirteci; null = bilinmiyor (ücretli işlem engellenir). */
  readonly pricePerMTokUsd: number | null;
  embed(texts: string[], kind: "document" | "query"): Promise<{ vectors: number[][]; tokens: number }>;
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v;
}

/** Yaklaşık belirteç sayısı (maliyet tahmini için; gerçek sayım sağlayıcı yanıtından alınır). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function price(model: string): number | null {
  const o = process.env.EMBEDDINGS_PRICE_PER_MTOK_USD;
  if (o !== undefined && o !== "") return Number.isFinite(Number(o)) && Number(o) >= 0 ? Number(o) : null;
  return EMBEDDING_PRICES_PER_MTOK[model] ?? null;
}

class OpenAIEmbedder implements Embedder {
  readonly provider = "openai";
  readonly dims = EMBEDDING_DIMS;
  readonly pricePerMTokUsd: number | null;
  constructor(readonly model: string, private key: string) { this.pricePerMTokUsd = price(model); }
  async embed(texts: string[]) {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += BATCH) {
      const body = await fetchJson("https://api.openai.com/v1/embeddings", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + BATCH), dimensions: this.dims }), timeoutMs: 60_000,
      });
      const data = Array.isArray(body?.data) ? [...body.data].sort((a: any, b: any) => a.index - b.index) : [];
      if (data.length !== Math.min(BATCH, texts.length - i)) throw new PermanentError("Gömme yanıtı eksik.");
      vectors.push(...data.map((d: any) => normalize(d.embedding as number[])));
      tokens += Number(body?.usage?.total_tokens ?? 0);
    }
    return { vectors, tokens };
  }
}

class VoyageEmbedder implements Embedder {
  readonly provider = "voyage";
  readonly dims = EMBEDDING_DIMS;
  readonly pricePerMTokUsd: number | null;
  constructor(readonly model: string, private key: string) { this.pricePerMTokUsd = price(model); }
  async embed(texts: string[], kind: "document" | "query") {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += BATCH) {
      const body = await fetchJson("https://api.voyageai.com/v1/embeddings", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + BATCH), input_type: kind, output_dimension: this.dims }), timeoutMs: 60_000,
      });
      const data = Array.isArray(body?.data) ? [...body.data].sort((a: any, b: any) => a.index - b.index) : [];
      if (data.length !== Math.min(BATCH, texts.length - i)) throw new PermanentError("Gömme yanıtı eksik.");
      vectors.push(...data.map((d: any) => normalize(d.embedding as number[])));
      tokens += Number(body?.usage?.total_tokens ?? 0);
    }
    return { vectors, tokens };
  }
}

let override: Embedder | null | undefined;
/** Yalnızca testler: sahte gömme sağlayıcısı (ağ ve ücret yok). */
export function setEmbedderOverride(e: Embedder | null | undefined) { override = e; }

/** Yapılandırılmış sağlayıcı; yoksa null ve nedeni. Anahtarlar yalnızca ortam değişkeninden okunur, kaydedilmez. */
export function getEmbedder(): { embedder: Embedder | null; reason: string | null } {
  if (override !== undefined) return { embedder: override, reason: override ? null : "test: sağlayıcı yok" };
  const provider = (process.env.EMBEDDINGS_PROVIDER ?? "").toLowerCase();
  if (provider === "openai") {
    const key = process.env.EMBEDDINGS_API_KEY || config.openaiImages.apiKey;
    if (!key) return { embedder: null, reason: "EMBEDDINGS_PROVIDER=openai ama API anahtarı yok (EMBEDDINGS_API_KEY veya OPENAI_API_KEY)." };
    return { embedder: new OpenAIEmbedder(process.env.EMBEDDINGS_MODEL || "text-embedding-3-small", key), reason: null };
  }
  if (provider === "voyage") {
    const key = process.env.EMBEDDINGS_API_KEY || process.env.VOYAGE_API_KEY;
    if (!key) return { embedder: null, reason: "EMBEDDINGS_PROVIDER=voyage ama API anahtarı yok (EMBEDDINGS_API_KEY veya VOYAGE_API_KEY)." };
    return { embedder: new VoyageEmbedder(process.env.EMBEDDINGS_MODEL || "voyage-3.5-lite", key), reason: null };
  }
  return { embedder: null, reason: "Gömme sağlayıcısı yapılandırılmadı (EMBEDDINGS_PROVIDER=openai|voyage). Anlamsal arama kapalı; tam metin araması çalışır." };
}

/** Tahmini maliyet ($); fiyat bilinmiyorsa null. */
export function embeddingCostUsd(e: Embedder, tokens: number): number | null {
  return e.pricePerMTokUsd === null ? null : (tokens / 1_000_000) * e.pricePerMTokUsd;
}
