import { NextResponse } from "next/server";
import { requireBrand } from "@/lib/current";
import { startDriveOAuth } from "@/lib/drive/source";
import { rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

/** Resmi Google OAuth akışını başlatır (salt okunur üst veri izni, tek kullanımlık state, seçili markaya bağlı). */
export async function GET(req: Request) {
  const brand = await requireBrand().catch(() => null);
  if (!brand) return NextResponse.redirect(new URL("/drive-arsivi?err=Marka%20se%C3%A7ili%20de%C4%9Fil", req.url));
  const rl = rateLimit(`drive-oauth:${brand.id}`, 10, 10 * 60_000);
  if (!rl.ok) return NextResponse.redirect(new URL(`/drive-arsivi?err=${encodeURIComponent(`Çok fazla deneme; ${rl.retryAfterS} sn sonra tekrar deneyin.`)}`, req.url));
  try {
    return NextResponse.redirect(await startDriveOAuth(brand.id));
  } catch (err) {
    return NextResponse.redirect(new URL(`/drive-arsivi?err=${encodeURIComponent((err as Error).message)}`, req.url));
  }
}
