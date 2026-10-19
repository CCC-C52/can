import { q, type Queryable, getPool } from "@/lib/db/pool";
import { getBrand, listBrandFacts, listProductFacts, listProducts, listVariants } from "@/lib/services/brands";
import { langLabel } from "@/lib/labels";

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
};

const u = (v: unknown) => (v === null || v === undefined || v === "" ? UNKNOWN : String(v));

/** Bir markanın ajanlara verilecek bağlamı. Yalnızca o markanın verileri okunur. */
export async function buildBrandContext(brandId: string, db: Queryable = getPool()): Promise<BrandContext> {
  const brand = await getBrand(brandId, db);
  if (!brand) throw new Error("Marka bulunamadı");
  const [facts, products, variants, pfacts, media] = await Promise.all([
    listBrandFacts(brandId, db),
    listProducts(brandId, db),
    listVariants(brandId, undefined, db),
    listProductFacts(brandId, undefined, db),
    q<MediaSummary>(
      `SELECT id, kind, origin, filename, product_id, duration_s, width, height, format, shot_type, colors, themes, rights_status, tags
       FROM media_assets WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [brandId],
      db,
    ),
  ]);
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
    },
    products: products.map((p) => ({
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
    media,
  };
}
