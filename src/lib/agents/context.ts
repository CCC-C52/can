import { isUuid } from "@/lib/ids";
import { q, type Queryable, getPool } from "@/lib/db/pool";
import { getBrand, listBrandFacts, listProductFacts, listProducts, listVariants } from "@/lib/services/brands";
import { langLabel } from "@/lib/labels";
import { AGENTS } from "./registry";
import { activeMemoryFor } from "@/lib/services/brand-memory";
import { verifiedResearchFor } from "@/lib/services/research";
import { compactAnalysis, type MediaAnalysis } from "@/lib/media-analysis";
import type { AgentId } from "./schemas";

export const UNKNOWN = "UNKNOWN";

export type MediaSummary = {
  id: string;
  kind: string;
  origin: string;
  filename: string;
  product_id: string | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  format: string | null;
  shot_type: string | null;
  colors: string[];
  themes: string[];
  rights_status: string;
  tags: { tag: string; source: string }[];
  alt_text?: string | null;
  /** Tamamlanmış gerçek içerik analizi (piksel/kare ölçümleri ve varsa vision özeti). Yoksa null. */
  analysis?: ReturnType<typeof compactAnalysis>;
  /** En son analiz kaydının durumu (none = hiç analiz edilmemiş). Analizi tamamlanmamış video kurguda kullanılamaz. */
  analysis_status?: "none" | "pending" | "processing" | "completed" | "failed";
  /** Talimatta açıkça istenen dosya. */
  requested?: boolean;
};

export type BrandContext = {
  brand: {
    id: string;
    name: string;
    is_sample: boolean;
    story: string;
    target_audience: string;
    tone: string;
    content_language: string;
    content_language_label: string;
    colors: { name: string; hex: string }[];
    fonts: { role: string; family: string }[];
    shipping_info: string;
    return_policy: string;
    campaign_rules: string;
    price_source: string;
    inventory_source: string;
    approved_decisions: string[];
    verified_facts: string[];
    forbidden_claims: string[];
    /** Sahibin etkinleştirdiği marka hafızası (yönergeler, dersler, ajan talimatları). Önerilen kayıtlar girmez. */
    memory: { kind: string; scope: string; title: string; body: string }[];
  };
  products: {
    id: string;
    title: string;
    description: string;
    product_type: string;
    status: string;
    price: string;
    compare_at_price: string;
    currency: string;
    variants: { id: string; title: string; color: string; size: string; sku: string; price: string; inventory: string }[];
    verified_facts: { attribute: string; value: string }[];
    unverified_facts: { attribute: string; value: string }[];
  }[];
  media: MediaSummary[];
  /** Sahibin doğruladığı web araştırması kaynakları (üçüncü taraf, güvenilmeyen içerik). research.read izni gerekir. */
  research: { url: string; title: string; excerpt: string }[];
};

const u = (v: unknown) => (v === null || v === undefined || v === "" ? UNKNOWN : String(v));

/**
 * Bir markanın ajanlara verilecek bağlamı. Yalnızca o markanın verileri okunur.
 * `agent` verilirse bağlam o ajanın izinlerine göre daraltılır (en az yetki): products.read yoksa ürünler,
 * media.read yoksa medya listesi bağlama girmez.
 */
export async function buildBrandContext(brandId: string, db: Queryable = getPool(), opts: { agent?: AgentId; includeAssetIds?: string[] } = {}): Promise<BrandContext> {
  const brand = await getBrand(brandId, db);
  if (!brand) throw new Error("Marka bulunamadı");
  const [facts, products, variants, pfacts, media, memory, research] = await Promise.all([
    listBrandFacts(brandId, db),
    listProducts(brandId, db),
    listVariants(brandId, undefined, db),
    listProductFacts(brandId, undefined, db),
    // Son 80 dosya + talimatta açıkça istenen dosyalar (sınırdan bağımsız; yalnızca bu markaya ait olanlar)
    q<MediaSummary & { a: MediaAnalysis | null; last_status: string | null; requested: boolean }>(
      `SELECT m.id, m.kind, m.origin, m.filename, m.product_id, m.duration_s, m.width, m.height, m.format, m.shot_type, m.colors, m.themes,
              m.rights_status, m.tags, m.alt_text, row_to_json(a.*) AS a,
              (SELECT x.status FROM media_analyses x WHERE x.asset_id = m.id AND x.brand_id = m.brand_id ORDER BY x.created_at DESC LIMIT 1) AS last_status,
              (m.id = ANY($2::uuid[])) AS requested
       FROM media_assets m
       LEFT JOIN LATERAL (SELECT * FROM media_analyses x WHERE x.asset_id = m.id AND x.brand_id = m.brand_id AND x.status = 'completed'
                          ORDER BY (x.level = 'vision') DESC, x.created_at DESC LIMIT 1) a ON true
       WHERE m.brand_id = $1 AND (m.id = ANY($2::uuid[]) OR m.id IN (SELECT id FROM media_assets WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 80))
       ORDER BY (m.id = ANY($2::uuid[])) DESC, m.created_at DESC`,
      [brandId, (opts.includeAssetIds ?? []).filter(isUuid)],
      db,
    ),
    activeMemoryFor(brandId, opts.agent, db),
    !opts.agent || AGENTS[opts.agent].tools.includes("research.read") ? verifiedResearchFor(brandId, db) : Promise.resolve([]),
  ]);
  const can = (tool: "products.read" | "media.read") => !opts.agent || AGENTS[opts.agent].tools.includes(tool);
  return {
    brand: {
      id: brand.id,
      name: brand.name,
      is_sample: brand.is_sample,
      story: u(brand.story),
      target_audience: u(brand.target_audience),
      tone: u(brand.tone),
      content_language: brand.content_language,
      content_language_label: langLabel(brand.content_language),
      colors: brand.colors,
      fonts: brand.fonts,
      shipping_info: u(brand.shipping_info),
      return_policy: u(brand.return_policy),
      campaign_rules: u(brand.campaign_rules),
      price_source: brand.price_source,
      inventory_source: brand.inventory_source,
      approved_decisions: facts.filter((f) => f.kind === "decision" && f.status === "verified").map((f) => f.statement),
      verified_facts: facts.filter((f) => f.kind === "fact" && f.status === "verified").map((f) => f.statement),
      forbidden_claims: facts.filter((f) => f.kind === "forbidden_claim").map((f) => f.statement),
      memory,
    },
    products: (can("products.read") ? products : []).map((p) => ({
      id: p.id,
      title: p.title,
      description: u(p.description),
      product_type: u(p.product_type),
      status: p.status,
      price: u(p.price),
      compare_at_price: u(p.compare_at_price),
      currency: u(p.currency),
      variants: variants
        .filter((v) => v.product_id === p.id)
        .map((v) => ({ id: v.id, title: v.title, color: u(v.color), size: u(v.size), sku: u(v.sku), price: u(v.price), inventory: u(v.inventory_quantity) })),
      verified_facts: pfacts.filter((f) => f.product_id === p.id && f.status === "verified").map((f) => ({ attribute: f.attribute, value: f.value })),
      unverified_facts: pfacts.filter((f) => f.product_id === p.id && f.status !== "verified").map((f) => ({ attribute: f.attribute, value: f.value })),
    })),
    media: can("media.read")
      ? media.map(({ a, last_status, requested, ...m }) => ({
          ...m,
          analysis: compactAnalysis(a),
          analysis_status: a ? "completed" : ((last_status ?? "none") as MediaSummary["analysis_status"]),
          ...(requested ? { requested: true } : {}),
        }))
      : [],
    research,
  };
}
