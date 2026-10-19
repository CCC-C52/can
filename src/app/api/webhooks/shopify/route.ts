import { NextResponse } from "next/server";
import { q, q1 } from "@/lib/db/pool";
import { verifyShopifyWebhook } from "@/lib/adapters/shopify";

export const runtime = "nodejs";

/** Shopify webhook alıcısı. İmza doğrulanmadan hiçbir veri işlenmez; aynı olay iki kez kaydedilmez. */
export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifyShopifyWebhook(raw, req.headers.get("x-shopify-hmac-sha256"))) return NextResponse.json({ error: "İmza geçersiz" }, { status: 401 });
  const shop = req.headers.get("x-shopify-shop-domain") ?? "";
  const eventId = req.headers.get("x-shopify-event-id") ?? req.headers.get("x-shopify-webhook-id") ?? "";
  const topic = req.headers.get("x-shopify-topic") ?? "";
  if (!eventId) return NextResponse.json({ error: "Olay kimliği yok" }, { status: 400 });
  const conn = await q1<{ brand_id: string }>(`SELECT brand_id FROM connections WHERE provider = 'shopify' AND config->>'shop' = $1`, [shop]);
  let payload: unknown;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return NextResponse.json({ error: "Geçersiz gövde" }, { status: 400 }); }
  await q(`INSERT INTO webhook_events (provider, event_id, topic, brand_id, payload) VALUES ('shopify',$1,$2,$3,$4) ON CONFLICT (provider, event_id) DO NOTHING`, [eventId, topic, conn?.brand_id ?? null, JSON.stringify(payload)]);
  return NextResponse.json({ ok: true });
}
