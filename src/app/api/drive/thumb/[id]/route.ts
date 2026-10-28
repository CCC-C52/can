import { requireBrand } from "@/lib/current";
import { isUuid } from "@/lib/ids";
import { q1 } from "@/lib/db/pool";
import { driveGet, fetchThumbnail } from "@/lib/drive/google";
import { tokenProvider } from "@/lib/drive/source";
import { rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

/**
 * İnceleme ekranı için Drive önizlemesi (küçük resim; yalnızca göz atmak için, ürün referansı DEĞİL).
 * Oturum + seçili marka zorunlu; dosya bu markanın dizininde olmalı. Belirteç tarayıcıya hiç gitmez.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const brand = await requireBrand().catch(() => null);
  if (!brand || !isUuid(id)) return new Response(null, { status: 404 });
  const rl = rateLimit(`drive-thumb:${brand.id}`, 600, 60_000);
  if (!rl.ok) return new Response(null, { status: 429, headers: { "Retry-After": String(rl.retryAfterS) } });
  const item = await q1<{ file_id: string; has_thumbnail: boolean }>(
    `SELECT file_id, has_thumbnail FROM drive_items WHERE id = $1 AND brand_id = $2 AND NOT is_folder AND state <> 'removed'`,
    [id, brand.id],
  );
  if (!item?.has_thumbnail) return new Response(null, { status: 404 });
  try {
    const token = tokenProvider(brand.id);
    const f = await driveGet<{ thumbnailLink?: string }>(`/files/${item.file_id}`, { fields: "thumbnailLink", supportsAllDrives: true }, token);
    if (!f.thumbnailLink) return new Response(null, { status: 404 });
    const buf = await fetchThumbnail(f.thumbnailLink, token, 480);
    const type = buf[0] === 0x89 ? "image/png" : buf[0] === 0x52 ? "image/webp" : "image/jpeg";
    return new Response(new Uint8Array(buf), { status: 200, headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response(null, { status: 502 });
  }
}
