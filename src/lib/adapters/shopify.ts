import crypto from "node:crypto";
import { config } from "@/lib/config";
import { q, q1, getPool } from "@/lib/db/pool";
import { connectionCredentials, getConnection, upsertConnection } from "@/lib/services/connections";
import { PermanentError } from "@/lib/models/types";
import { fetchJson } from "./http";

// Shopify Admin GraphQL API adaptörü.
// Kimlik doğrulama: Dev Dashboard uygulaması + client credentials grant (kendi organizasyonunuzdaki mağaza için).
//   POST https://{shop}.myshopify.com/admin/oauth/access_token  (grant_type=client_credentials) → 24 saatlik belirteç
// NOT: Bu ortamda gerçek bir mağazayla test edilmedi.

export function normalizeShop(input: string): string {
  const s = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const domain = s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) throw new PermanentError("Geçersiz mağaza alan adı (ör. magazam.myshopify.com).");
  return domain;
}

type Creds = { access_token: string; expires_at: number };

async function getToken(brandId: string): Promise<{ shop: string; token: string }> {
  const conn = await getConnection("shopify", brandId);
  const shop = conn?.config?.shop as string | undefined;
  if (!conn || !shop) throw new PermanentError("Shopify mağaza alan adı tanımlı değil.");
  const creds = connectionCredentials<Creds>(conn);
  if (creds && creds.expires_at - 300_000 > Date.now()) return { shop, token: creds.access_token };
  if (!config.shopify.clientId || !config.shopify.clientSecret) throw new PermanentError("SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET tanımlı değil.");
  const body = await fetchJson(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret }).toString(),
  });
  if (!body?.access_token) throw new PermanentError("Shopify belirteç yanıtı beklenmedik biçimde.");
  const expiresIn = Number(body.expires_in ?? 86399);
  await upsertConnection("shopify", brandId, { credentials: { access_token: body.access_token, expires_at: Date.now() + expiresIn * 1000 }, scopes: String(body.scope ?? "").split(",").filter(Boolean) });
  return { shop, token: body.access_token };
}

export async function shopifyGraphql<T = any>(brandId: string, query: string, variables: Record<string, unknown> = {}, opts: { mutation?: boolean } = {}): Promise<T> {
  const { shop, token } = await getToken(brandId);
  const body = await fetchJson(`https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
    idempotent: !opts.mutation,
  });
  if (body?.errors?.length) throw new PermanentError(`Shopify GraphQL hatası: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data as T;
}

export async function testShopify(brandId: string, shopInput: string) {
  const shop = normalizeShop(shopInput);
  await upsertConnection("shopify", brandId, { status: "testing", config: { shop }, credentials: null, lastError: null });
  try {
    const data = await shopifyGraphql<{ shop: { name: string; currencyCode: string } }>(brandId, `{ shop { name currencyCode } }`);
    await upsertConnection("shopify", brandId, { status: "connected", config: { shop, shopName: data.shop.name, currency: data.shop.currencyCode }, lastError: null });
    return { ok: true, detail: `Bağlandı: ${data.shop.name}` };
  } catch (err) {
    const msg = (err as Error).message;
    await upsertConnection("shopify", brandId, { status: msg.includes("Yetki") ? "reauth_required" : "error", lastError: msg });
    return { ok: false, detail: msg };
  }
}

/** Shopify ürünlerini yerel ürün kayıtlarına aktarır (mevcut değerler karşılaştırması için). */
export async function syncShopifyProducts(brandId: string) {
  const data = await shopifyGraphql<any>(brandId, `{
    products(first: 50) { nodes { id title descriptionHtml productType status
      variants(first: 50) { nodes { id title sku price compareAtPrice inventoryQuantity selectedOptions { name value } } } } } }`);
  let created = 0, updated = 0;
  for (const p of data.products.nodes) {
    const first = p.variants.nodes[0];
    const existing = await q1<{ id: string }>(`SELECT id FROM products WHERE brand_id = $1 AND shopify_product_id = $2`, [brandId, p.id]);
    let productId: string;
    if (existing) {
      await q(`UPDATE products SET title=$3, description=$4, product_type=$5, status=$6, price=$7, compare_at_price=$8, updated_at=now() WHERE id=$1 AND brand_id=$2`,
        [existing.id, brandId, p.title, p.descriptionHtml, p.productType || null, String(p.status).toLowerCase(), first?.price ?? null, first?.compareAtPrice ?? null]);
      productId = existing.id; updated++;
    } else {
      const row = await q1<{ id: string }>(`INSERT INTO products (brand_id, title, description, product_type, status, price, compare_at_price, shopify_product_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [brandId, p.title, p.descriptionHtml, p.productType || null, String(p.status).toLowerCase(), first?.price ?? null, first?.compareAtPrice ?? null, p.id]);
      productId = row!.id; created++;
    }
    for (const v of p.variants.nodes) {
      const opt = (n: string) => v.selectedOptions.find((o: any) => o.name.toLowerCase() === n)?.value ?? null;
      const ev = await q1<{ id: string }>(`SELECT id FROM product_variants WHERE brand_id=$1 AND shopify_variant_id=$2`, [brandId, v.id]);
      if (ev) await q(`UPDATE product_variants SET title=$2, sku=$3, price=$4, inventory_quantity=$5 WHERE id=$1`, [ev.id, v.title, v.sku, v.price, v.inventoryQuantity]);
      else await q(`INSERT INTO product_variants (brand_id, product_id, title, sku, color, size, price, inventory_quantity, shopify_variant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [brandId, productId, v.title, v.sku, opt("color") ?? opt("renk"), opt("size") ?? opt("beden"), v.price, v.inventoryQuantity, v.id]);
    }
  }
  await q(`UPDATE brands SET price_source = 'shopify', inventory_source = 'shopify', updated_at = now() WHERE id = $1`, [brandId]);
  return { created, updated };
}

type Change = { product_id: string; field: string; current_value: string; proposed_value: string };

/** Onaylı Shopify önerisini canlı mağazaya uygular. Yalnızca dış işlem kapısı (gateway) tarafından çağrılır. */
export async function applyShopifyProposal(brandId: string, content: { product_changes: Change[]; collections: { title: string; description: string; product_ids: string[] }[] }) {
  const results: any[] = [];
  const db = getPool();
  const byProduct = new Map<string, Change[]>();
  for (const c of content.product_changes) byProduct.set(c.product_id, [...(byProduct.get(c.product_id) ?? []), c]);
  for (const [productId, changes] of byProduct) {
    const p = await q1<{ shopify_product_id: string | null; title: string }>(`SELECT shopify_product_id, title FROM products WHERE id = $1 AND brand_id = $2`, [productId, brandId], db);
    if (!p?.shopify_product_id) {
      results.push({ productId, ok: false, error: "Ürün Shopify ile eşleştirilmemiş (önce ürünleri senkronize edin)." });
      continue;
    }
    const productInput: Record<string, unknown> = { id: p.shopify_product_id };
    for (const c of changes) {
      if (c.field === "title") productInput.title = c.proposed_value;
      if (c.field === "description") productInput.descriptionHtml = c.proposed_value;
      if (c.field === "product_type") productInput.productType = c.proposed_value;
      if (c.field === "tags") productInput.tags = c.proposed_value.split(",").map((t) => t.trim()).filter(Boolean);
    }
    if (Object.keys(productInput).length > 1) {
      const r = await shopifyGraphql<any>(brandId, `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`, { product: productInput }, { mutation: true });
      const errs = r.productUpdate.userErrors;
      results.push({ productId, kind: "productUpdate", ok: errs.length === 0, errors: errs });
    }
    const priceChanges = changes.filter((c) => c.field === "price" || c.field === "compare_at_price");
    if (priceChanges.length) {
      const variants = await q<{ shopify_variant_id: string }>(`SELECT shopify_variant_id FROM product_variants WHERE product_id = $1 AND brand_id = $2 AND shopify_variant_id IS NOT NULL`, [productId, brandId], db);
      const input = variants.map((v) => {
        const x: Record<string, unknown> = { id: v.shopify_variant_id };
        for (const c of priceChanges) x[c.field === "price" ? "price" : "compareAtPrice"] = c.proposed_value;
        return x;
      });
      const r = await shopifyGraphql<any>(brandId, `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`, { productId: p.shopify_product_id, variants: input }, { mutation: true });
      const errs = r.productVariantsBulkUpdate.userErrors;
      results.push({ productId, kind: "productVariantsBulkUpdate", ok: errs.length === 0, errors: errs });
    }
  }
  for (const col of content.collections ?? []) {
    const r = await shopifyGraphql<any>(brandId, `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { field message } } }`, { input: { title: col.title, descriptionHtml: col.description } }, { mutation: true });
    const id = r.collectionCreate.collection?.id;
    const ids = (await q<{ shopify_product_id: string }>(`SELECT shopify_product_id FROM products WHERE brand_id = $1 AND id = ANY($2::uuid[]) AND shopify_product_id IS NOT NULL`, [brandId, col.product_ids], db)).map((x) => x.shopify_product_id);
    if (id && ids.length) {
      await shopifyGraphql<any>(brandId, `mutation($id: ID!, $productIds: [ID!]!) { collectionAddProducts(id: $id, productIds: $productIds) { userErrors { field message } } }`, { id, productIds: ids }, { mutation: true });
    }
    results.push({ collection: col.title, ok: !!id, errors: r.collectionCreate.userErrors });
  }
  return { results, allOk: results.every((r) => r.ok) };
}

/** Shopify webhook imzası: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(client_secret, ham gövde)). */
export function verifyShopifyWebhook(rawBody: string | Buffer, hmacHeader: string | null, secret = config.shopify.clientSecret): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(hmacHeader, "base64");
  return given.length === digest.length && crypto.timingSafeEqual(given, digest);
}
