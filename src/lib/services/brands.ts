import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";

export type Brand = {
  id: string;
  slug: string;
  name: string;
  is_sample: boolean;
  story: string | null;
  target_audience: string | null;
  tone: string | null;
  content_language: string;
  colors: { name: string; hex: string }[];
  fonts: { role: string; family: string }[];
  logo_asset_id: string | null;
  shipping_info: string | null;
  return_policy: string | null;
  campaign_rules: string | null;
  price_source: string;
  inventory_source: string;
  created_at: string;
  updated_at: string;
};

export type Product = {
  id: string;
  brand_id: string;
  title: string;
  description: string | null;
  product_type: string | null;
  status: string;
  price: number | null;
  compare_at_price: number | null;
  currency: string | null;
  shopify_product_id: string | null;
  is_sample: boolean;
};

export type Variant = {
  id: string;
  product_id: string;
  title: string;
  sku: string | null;
  color: string | null;
  size: string | null;
  price: number | null;
  inventory_quantity: number | null;
};

export type ProductFact = { id: string; product_id: string; attribute: string; value: string; status: string; source: string | null };
export type BrandFact = { id: string; kind: string; statement: string; status: string; source: string | null; created_at: string };

export async function listBrands(db: Queryable = getPool()) {
  return q<Brand>(`SELECT * FROM brands ORDER BY is_sample, name`, [], db);
}

export async function getBrand(id: string, db: Queryable = getPool()) {
  return q1<Brand>(`SELECT * FROM brands WHERE id = $1`, [id], db);
}

function slugify(s: string) {
  return (
    s
      .toLocaleLowerCase("tr")
      .replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ç/g, "c")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "marka"
  );
}

const EDITABLE = [
  "name", "story", "target_audience", "tone", "content_language", "colors", "fonts", "logo_asset_id",
  "shipping_info", "return_policy", "campaign_rules", "price_source", "inventory_source",
] as const;
export type BrandInput = Partial<Pick<Brand, (typeof EDITABLE)[number]>> & { name?: string };

function clean(v: unknown) {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return v;
}

export async function createBrand(input: BrandInput & { name: string; is_sample?: boolean }, db: Queryable = getPool()) {
  let slug = slugify(input.name);
  const exists = await q1(`SELECT 1 FROM brands WHERE slug = $1`, [slug], db);
  if (exists) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  const brand = await q1<Brand>(
    `INSERT INTO brands (slug, name, is_sample, story, target_audience, tone, content_language, colors, fonts,
       shipping_info, return_policy, campaign_rules, price_source, inventory_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      slug, input.name.trim(), input.is_sample ?? false, clean(input.story), clean(input.target_audience), clean(input.tone),
      input.content_language ?? "en", JSON.stringify(input.colors ?? []), JSON.stringify(input.fonts ?? []),
      clean(input.shipping_info), clean(input.return_policy), clean(input.campaign_rules),
      input.price_source ?? "unknown", input.inventory_source ?? "unknown",
    ],
    db,
  );
  await audit({ brandId: brand!.id, actor: "user", action: "brand.create", message: `Marka oluşturuldu: ${brand!.name}` }, db);
  return brand!;
}

export async function updateBrand(id: string, input: BrandInput, db: Queryable = getPool()) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of EDITABLE) {
    if (!(key in input)) continue;
    let v: unknown = (input as Record<string, unknown>)[key];
    if (key === "colors" || key === "fonts") v = JSON.stringify(v ?? []);
    else v = clean(v);
    if (key === "name" && !v) continue;
    if (key === "content_language" && !v) v = "en";
    params.push(v);
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) return getBrand(id, db);
  params.push(id);
  const brand = await q1<Brand>(`UPDATE brands SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING *`, params, db);
  await audit({ brandId: id, actor: "user", action: "brand.update", message: `Marka bilgileri güncellendi`, data: { fields: Object.keys(input) } }, db);
  return brand;
}

export async function listBrandFacts(brandId: string, db: Queryable = getPool()) {
  return q<BrandFact>(`SELECT * FROM brand_facts WHERE brand_id = $1 ORDER BY created_at`, [brandId], db);
}

export async function addBrandFact(brandId: string, f: { kind: string; statement: string; status?: string; source?: string }, db: Queryable = getPool()) {
  await q(`INSERT INTO brand_facts (brand_id, kind, statement, status, source) VALUES ($1,$2,$3,$4,$5)`,
    [brandId, f.kind, f.statement.trim(), f.status ?? "verified", f.source ?? "kullanıcı"], db);
  await audit({ brandId, actor: "user", action: "brand.fact", message: `Marka kaydı eklendi (${f.kind}): ${f.statement.slice(0, 80)}` }, db);
}

export async function deleteBrandFact(brandId: string, id: string, db: Queryable = getPool()) {
  await q(`DELETE FROM brand_facts WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
}

// ---------------------------------------------------------------- Ürünler

export async function listProducts(brandId: string, db: Queryable = getPool()) {
  return q<Product>(`SELECT * FROM products WHERE brand_id = $1 ORDER BY created_at`, [brandId], db);
}

export async function getProduct(brandId: string, id: string, db: Queryable = getPool()) {
  return q1<Product>(`SELECT * FROM products WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
}

export async function listVariants(brandId: string, productId?: string, db: Queryable = getPool()) {
  return productId
    ? q<Variant>(`SELECT * FROM product_variants WHERE brand_id = $1 AND product_id = $2 ORDER BY created_at`, [brandId, productId], db)
    : q<Variant>(`SELECT * FROM product_variants WHERE brand_id = $1 ORDER BY created_at`, [brandId], db);
}

export async function listProductFacts(brandId: string, productId?: string, db: Queryable = getPool()) {
  return productId
    ? q<ProductFact>(`SELECT * FROM product_facts WHERE brand_id = $1 AND product_id = $2 ORDER BY created_at`, [brandId, productId], db)
    : q<ProductFact>(`SELECT * FROM product_facts WHERE brand_id = $1 ORDER BY created_at`, [brandId], db);
}

function money(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export async function createProduct(
  brandId: string,
  p: { title: string; description?: string; product_type?: string; price?: unknown; compare_at_price?: unknown; currency?: string; status?: string; is_sample?: boolean },
  db: Queryable = getPool(),
) {
  const row = await q1<Product>(
    `INSERT INTO products (brand_id, title, description, product_type, price, compare_at_price, currency, status, is_sample)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [brandId, p.title.trim(), clean(p.description), clean(p.product_type), money(p.price), money(p.compare_at_price), clean(p.currency), p.status ?? "draft", p.is_sample ?? false],
    db,
  );
  await audit({ brandId, actor: "user", action: "product.create", message: `Ürün eklendi: ${row!.title}` }, db);
  return row!;
}

export async function updateProduct(
  brandId: string,
  id: string,
  p: { title?: string; description?: string; product_type?: string; price?: unknown; compare_at_price?: unknown; currency?: string; status?: string },
  db: Queryable = getPool(),
) {
  const row = await q1<Product>(
    `UPDATE products SET title = COALESCE($3, title), description = $4, product_type = $5, price = $6, compare_at_price = $7,
       currency = $8, status = COALESCE($9, status), updated_at = now()
     WHERE id = $1 AND brand_id = $2 RETURNING *`,
    [id, brandId, clean(p.title), clean(p.description), clean(p.product_type), money(p.price), money(p.compare_at_price), clean(p.currency), clean(p.status)],
    db,
  );
  if (row) await audit({ brandId, actor: "user", action: "product.update", message: `Ürün güncellendi: ${row.title}` }, db);
  return row;
}

export async function addVariant(
  brandId: string,
  productId: string,
  v: { title: string; sku?: string; color?: string; size?: string; price?: unknown; inventory_quantity?: unknown },
  db: Queryable = getPool(),
) {
  const product = await getProduct(brandId, productId, db);
  if (!product) throw new Error("Ürün bu markaya ait değil.");
  const inv = v.inventory_quantity === "" || v.inventory_quantity === undefined || v.inventory_quantity === null ? null : Number(v.inventory_quantity);
  await q(
    `INSERT INTO product_variants (brand_id, product_id, title, sku, color, size, price, inventory_quantity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [brandId, productId, v.title.trim(), clean(v.sku), clean(v.color), clean(v.size), money(v.price), Number.isFinite(inv) ? inv : null],
    db,
  );
}

export async function addProductFact(
  brandId: string,
  productId: string,
  f: { attribute: string; value: string; status?: string; source?: string },
  db: Queryable = getPool(),
) {
  const product = await getProduct(brandId, productId, db);
  if (!product) throw new Error("Ürün bu markaya ait değil.");
  await q(`INSERT INTO product_facts (brand_id, product_id, attribute, value, status, source) VALUES ($1,$2,$3,$4,$5,$6)`,
    [brandId, productId, f.attribute.trim(), f.value.trim(), f.status ?? "verified", clean(f.source) ?? "kullanıcı"], db);
  await audit({ brandId, actor: "user", action: "product.fact", message: `Ürün özelliği eklendi (${f.status ?? "verified"}): ${f.attribute} = ${f.value}` }, db);
}

export async function deleteProductFact(brandId: string, id: string, db: Queryable = getPool()) {
  await q(`DELETE FROM product_facts WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
}

export async function deleteVariant(brandId: string, id: string, db: Queryable = getPool()) {
  await q(`DELETE FROM product_variants WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
}
