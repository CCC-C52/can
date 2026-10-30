import { NextResponse } from "next/server";
import { requireBrand } from "@/lib/current";
import { rateLimit } from "@/lib/security/rate-limit";
import { finishedTasksSince } from "@/lib/services/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Panel sesli uyarısı için biten görevler (oturum gerekir; yalnızca seçili marka). */
export async function GET(req: Request) {
  const brand = await requireBrand().catch(() => null);
  if (!brand) return NextResponse.json({ error: "Marka seçili değil" }, { status: 400 });
  const rl = rateLimit(`activity:${brand.id}`, 60, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Çok fazla istek; biraz bekleyin." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterS) } });
  const since = new URL(req.url).searchParams.get("since");
  return NextResponse.json(await finishedTasksSince(brand.id, since), { headers: { "Cache-Control": "no-store" } });
}
