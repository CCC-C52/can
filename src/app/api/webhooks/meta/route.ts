import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { q } from "@/lib/db/pool";
import { verifyMetaSignature } from "@/lib/adapters/instagram";
import { config } from "@/lib/config";

export const runtime = "nodejs";

/** Meta webhook doğrulama (hub.challenge) — doğrulama belirteci uygulama sırrından türetilir. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const secret = config.instagram.appSecret ?? config.meta.appSecret;
  if (!secret) return new Response("Yapılandırılmadı", { status: 404 });
  const expected = crypto.createHash("sha256").update(`verify:${secret}`).digest("hex").slice(0, 32);
  if (u.searchParams.get("hub.mode") === "subscribe" && u.searchParams.get("hub.verify_token") === expected) return new Response(u.searchParams.get("hub.challenge") ?? "");
  return new Response("Yetkisiz", { status: 403 });
}

export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"))) return NextResponse.json({ error: "İmza geçersiz" }, { status: 401 });
  const id = crypto.createHash("sha256").update(raw).digest("hex");
  let payload: unknown;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return NextResponse.json({ error: "Geçersiz gövde" }, { status: 400 }); }
  await q(`INSERT INTO webhook_events (provider, event_id, topic, payload) VALUES ('meta',$1,$2,$3) ON CONFLICT (provider, event_id) DO NOTHING`, [id, (payload as any)?.object ?? null, JSON.stringify(payload)]);
  return NextResponse.json({ ok: true });
}
