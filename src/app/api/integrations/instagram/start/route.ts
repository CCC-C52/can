import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireBrand } from "@/lib/current";
import { q } from "@/lib/db/pool";
import { instagramAuthUrl } from "@/lib/adapters/instagram";

export const runtime = "nodejs";

/** Resmi Instagram OAuth akışını başlatır (CSRF için tek kullanımlık state). */
export async function GET(req: Request) {
  const brand = await requireBrand().catch(() => null);
  if (!brand) return NextResponse.redirect(new URL("/entegrasyonlar?err=Marka%20se%C3%A7ili%20de%C4%9Fil", req.url));
  try {
    const state = crypto.randomBytes(24).toString("base64url");
    await q(`INSERT INTO oauth_states (state, brand_id, provider, expires_at) VALUES ($1,$2,'instagram', now() + interval '10 minutes')`, [state, brand.id]);
    return NextResponse.redirect(instagramAuthUrl(state));
  } catch (err) {
    return NextResponse.redirect(new URL(`/entegrasyonlar?err=${encodeURIComponent((err as Error).message)}`, req.url));
  }
}
