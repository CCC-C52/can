import { requireBrand } from "@/lib/current";
import { q1 } from "@/lib/db/pool";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const brand = await requireBrand().catch(() => null);
  if (!brand) return new Response("Marka seçili değil", { status: 400 });
  const a = await q1<{ response: { storage_key?: string } | null }>(`SELECT response FROM external_actions WHERE id = $1 AND brand_id = $2 AND status = 'manual_export'`, [id, brand.id]);
  const key = a?.response?.storage_key;
  if (!key || !key.startsWith(`brands/${brand.id}/`)) return new Response("Bulunamadı", { status: 404 });
  const buf = await getStorage().get(key);
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="yayin-paketi-${id.slice(0, 8)}.zip"` } });
}
