import { isUuid } from "@/lib/ids";
import { requireBrand } from "@/lib/current";
import { latestAnalysis } from "@/lib/media-analysis";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

/** Video analizinde modele gönderilen/ölçülen gerçek kareler. Yalnızca seçili markanın varlığı için. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  if (!isUuid(id) || !/^\d{1,2}$/.test(n)) return new Response("Bulunamadı", { status: 404 });
  const brand = await requireBrand().catch(() => null);
  if (!brand) return new Response("Marka seçili değil", { status: 400 });
  const a = await latestAnalysis(brand.id, id);
  const idx = Number(n);
  const key: string | undefined = Number.isInteger(idx) ? a?.result?.frame_keys?.[idx] : undefined;
  if (!key || !key.startsWith(`brands/${brand.id}/analysis/`)) return new Response("Bulunamadı", { status: 404 });
  const buf = await getStorage().get(key);
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "default-src 'none'; sandbox" } });
}
