import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { q, q1 } from "@/lib/db/pool";
import { createBrand, createProduct } from "@/lib/services/brands";
import { createOutput, addVersion, decide } from "@/lib/services/outputs";
import { executeExternalAction, reconcileAction } from "@/lib/services/gateway";
import { upsertConnection } from "@/lib/services/connections";
import { verifyShopifyWebhook } from "@/lib/adapters/shopify";
import { verifyMetaSignature } from "@/lib/adapters/instagram";
import { runRuleChecks } from "@/lib/agents/qa-rules";
import { buildBrandContext } from "@/lib/agents/context";
import { addProductFact } from "@/lib/services/brands";
import { key } from "./helpers";

// Gerçek servis ÇAĞRILMAZ: fetch sahte yanıtlarla değiştirilir. Bu testler adaptör mantığını doğrular,
// gerçek Shopify/Instagram uyumluluğunu kanıtlamaz.

let brandId: string;
let productId: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.SHOPIFY_CLIENT_ID = "test-client";
  process.env.SHOPIFY_CLIENT_SECRET = "test-secret";
  const b = await createBrand({ name: "Integration Brand", content_language: "en" });
  brandId = b.id;
  const p = await createProduct(brandId, { title: "Test Tee", description: "Old copy", price: "20", currency: "USD" });
  productId = p.id;
  await q(`UPDATE products SET shopify_product_id = 'gid://shopify/Product/1' WHERE id = $1`, [productId]);
  await upsertConnection("shopify", brandId, { status: "connected", config: { shop: "test-store.myshopify.com" } });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function approvedProposal(description: string) {
  const out = await createOutput({ brandId, projectId: null, taskId: null, agent: "shopify", kind: "shopify_proposal", title: "Test proposal" });
  const v = await addVersion({
    brandId, outputId: out.id, createdBy: "user", generator: "user", isDemo: false,
    content: { summary: "s", product_changes: [{ product_id: productId, field: "description", current_value: "Old copy", proposed_value: description, reason: "r" }], collections: [], pages: [], bundles: [], unknowns: [] },
  });
  await decide(brandId, v.id, "approved");
  return v;
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = vi.fn(async (url: any, init: any = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? "") });
    return handler(String(url), init);
  }) as any;
  return calls;
}

describe("Shopify adaptörü (sahte HTTP)", () => {
  it("onaylı öneriyi client credentials belirteci ve productUpdate ile uygular", async () => {
    const v = await approvedProposal("<p>New copy</p>");
    const calls = mockFetch((url) => {
      if (url.endsWith("/admin/oauth/access_token")) return Response.json({ access_token: "shpat_test", scope: "write_products", expires_in: 86399 });
      return Response.json({ data: { productUpdate: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } } });
    });
    const a = await executeExternalAction({ brandId, outputVersionId: v.id, actionType: "store_update", idempotencyKey: key() });
    expect(a.status).toBe("succeeded");
    expect(calls[0].url).toBe("https://test-store.myshopify.com/admin/oauth/access_token");
    expect(calls[0].body).toContain("grant_type=client_credentials");
    const gql = calls.find((c) => c.url.includes("/graphql.json"))!;
    expect(gql.url).toMatch(/\/admin\/api\/\d{4}-\d{2}\/graphql\.json$/);
    const body = JSON.parse(gql.body);
    expect(body.query).toContain("productUpdate(product: $product)");
    expect(body.variables.product).toEqual({ id: "gid://shopify/Product/1", descriptionHtml: "<p>New copy</p>" });
    // Belirteç şifreli saklanır, düz metin değil
    const conn = await q1<{ credentials_encrypted: string }>(`SELECT credentials_encrypted FROM connections WHERE brand_id = $1 AND provider = 'shopify'`, [brandId]);
    expect(conn!.credentials_encrypted).not.toContain("shpat_test");

    // Aynı sürüm için yeni anahtarla tekrar: ikinci mağaza yazımı yok
    const before = calls.length;
    const again = await executeExternalAction({ brandId, outputVersionId: v.id, actionType: "store_update", idempotencyKey: key() });
    expect(again.id).toBe(a.id);
    expect(calls.length).toBe(before);
  });

  it("sonucu belirsiz yazma tekrar gönderilmez; kullanıcı kontrolünden sonra yeniden denenebilir", async () => {
    const v = await approvedProposal("<p>Another copy</p>");
    let mutationCalls = 0;
    mockFetch((url) => {
      if (url.endsWith("/access_token")) return Response.json({ access_token: "shpat_x", expires_in: 86399 });
      mutationCalls++;
      throw new TypeError("fetch failed: socket hang up");
    });
    const a = await executeExternalAction({ brandId, outputVersionId: v.id, actionType: "store_update", idempotencyKey: key() });
    expect(a.status).toBe("unknown");
    expect(mutationCalls).toBe(1);
    const b = await executeExternalAction({ brandId, outputVersionId: v.id, actionType: "store_update", idempotencyKey: key() });
    expect(b.id).toBe(a.id);
    expect(mutationCalls).toBe(1); // tekrar gönderilmedi

    await reconcileAction(brandId, a.id, "failed");
    mockFetch(() => Response.json({ data: { productUpdate: { product: { id: "x" }, userErrors: [] } } }));
    const c = await executeExternalAction({ brandId, outputVersionId: v.id, actionType: "store_update", idempotencyKey: key() });
    expect(c.id).not.toBe(a.id);
    expect(c.status).toBe("succeeded");
  });

  it("fiyat değişikliği ayrı 'price_change' onayı olmadan uygulanmaz", async () => {
    const out = await createOutput({ brandId, projectId: null, taskId: null, agent: "shopify", kind: "shopify_proposal", title: "Price" });
    const v = await addVersion({ brandId, outputId: out.id, createdBy: "user", generator: "user", isDemo: false,
      content: { summary: "s", product_changes: [{ product_id: productId, field: "price", current_value: "20", proposed_value: "15", reason: "r" }], collections: [], pages: [], bundles: [], unknowns: [] } });
    await decide(brandId, v.id, "approved", { scopes: ["content", "store_update"] });
    const calls = mockFetch(() => Response.json({}));
    await expect(executeExternalAction({ brandId, outputVersionId: v.id, actionType: "store_update", idempotencyKey: key() })).rejects.toThrow(/price_change/);
    expect(calls.length).toBe(0);
  });
});

describe("Webhook imzaları", () => {
  it("Shopify HMAC doğrulanır", () => {
    const body = JSON.stringify({ id: 1 });
    const good = crypto.createHmac("sha256", "s3cret").update(body).digest("base64");
    expect(verifyShopifyWebhook(body, good, "s3cret")).toBe(true);
    expect(verifyShopifyWebhook(body + " ", good, "s3cret")).toBe(false);
    expect(verifyShopifyWebhook(body, null, "s3cret")).toBe(false);
  });
  it("Meta X-Hub-Signature-256 doğrulanır", () => {
    const body = '{"object":"instagram"}';
    const sig = "sha256=" + crypto.createHmac("sha256", "appsecret").update(body).digest("hex");
    expect(verifyMetaSignature(body, sig, "appsecret")).toBe(true);
    expect(verifyMetaSignature(body, sig.replace(/.$/, "0"), "appsecret")).toBe(false);
  });
});

describe("Kural tabanlı kalite kontrolü", () => {
  it("uydurma iddiaları, yanlış fiyatı, doğrulanmamış özelliği ve yanlış dili işaretler", async () => {
    await addProductFact(brandId, productId, { attribute: "Fabric", value: "100% cotton", status: "verified" });
    await addProductFact(brandId, productId, { attribute: "Origin", value: "Made in Italy", status: "unverified" });
    const ctx = await buildBrandContext(brandId);
    const bad = {
      summary: "x", posts: [{ id: "p1", platform: "instagram", format: "feed", caption: "Free shipping! Rated 5 stars by 1000 customers. Only $9.99. Made in Italy. 10% of sales donated.", hashtags: [], cta: "Shop", suggested_datetime: "2026-11-01T10:00:00Z", media_refs: [], cover_text: "" }], unknowns: [],
    };
    const r = runRuleChecks("social", bad, ctx, { isDemo: false });
    expect(r.verdict).toBe("needs_changes");
    const names = r.checks.filter((c) => c.status === "fail").map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Doğrulanmamış iddia", "Fiyat doğruluğu", "Doğrulanmamış ürün özelliği"]));

    const good = { ...bad, posts: [{ ...bad.posts[0], caption: "New in: Test Tee. Fabric: 100% cotton. Now $20 with our new collection for you." }] };
    expect(runRuleChecks("social", good, ctx, { isDemo: false }).verdict).toBe("pass");

    const turkish = { ...bad, posts: [{ ...bad.posts[0], caption: "Yeni ürünümüz çok güzel, hemen incele ve bu fırsatı kaçırma için tıkla" }] };
    expect(runRuleChecks("social", turkish, ctx, { isDemo: false }).checks.find((c) => c.name === "İçerik dili")!.status).toBe("fail");
  });
});
