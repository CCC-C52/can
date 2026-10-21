import { NextResponse } from "next/server";
import { requireBrand } from "@/lib/current";
import { UploadError } from "@/lib/uploads";
import { rateLimit } from "@/lib/security/rate-limit";
import { headers } from "next/headers";
import { log } from "@/lib/log";

/** Yükleme API'leri için ortak sarmalayıcı: seçili marka, hız sınırı, güvenli hata mesajı. */
export async function withBrand(limitKey: string, max: number, fn: (brandId: string) => Promise<unknown>) {
  const brand = await requireBrand().catch(() => null);
  if (!brand) return NextResponse.json({ error: "Marka seçili değil" }, { status: 400 });
  const rl = rateLimit(`${limitKey}:${brand.id}`, max, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Çok fazla istek; biraz bekleyin." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterS) } });
  try {
    return NextResponse.json(await fn(brand.id));
  } catch (err) {
    if (err instanceof UploadError) return NextResponse.json({ error: err.message }, { status: err.status });
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    log("error", "api.uploads_error", { requestId, brandId: brand.id, route: limitKey, error: err });
    return NextResponse.json({ error: "Beklenmeyen hata", requestId }, { status: 500 });
  }
}
