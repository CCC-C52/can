import { isUuid } from "@/lib/ids";
import { requireBrand } from "@/lib/current";
import { getMedia } from "@/lib/services/media";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Dosyayı yalnızca seçili markaya aitse sunar. Belleğe almadan akıtır; videolarda bayt aralığı (Range) desteklenir.
 * SVG/PSD indirme olarak verilir; sandbox CSP ile betik çalıştırılamaz.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return new Response("Bulunamadı", { status: 404 });
  const brand = await requireBrand().catch(() => null);
  if (!brand) return new Response("Marka seçili değil", { status: 400 });
  const m = await getMedia(brand.id, id);
  if (!m) return new Response("Bulunamadı", { status: 404 });
  const size = Number(m.size_bytes);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const inline = !download && /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime)|application\/pdf)$/.test(m.mime_type);
  const headers: Record<string, string> = {
    "Content-Type": m.mime_type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(m.filename)}`,
    "Cache-Control": "private, max-age=3600",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
  const range = req.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start: number, end: number;
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    if (!match[1]) { start = Math.max(0, size - Number(match[2])); end = size - 1; } // son N bayt
    else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const body = await getStorage().stream(m.storage_key, { start, end });
    return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  const body = await getStorage().stream(m.storage_key);
  return new Response(body, { headers: { ...headers, "Content-Length": String(size) } });
}
