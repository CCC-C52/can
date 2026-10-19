import { requireBrand } from "@/lib/current";
import { getMedia, readMediaFile } from "@/lib/services/media";

export const runtime = "nodejs";

/** Dosyayı yalnızca seçili markaya aitse sunar. SVG/PSD indirme olarak verilir (betik çalıştırılamaz). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const brand = await requireBrand().catch(() => null);
  if (!brand) return new Response("Marka seçili değil", { status: 400 });
  const m = await getMedia(brand.id, id);
  if (!m) return new Response("Bulunamadı", { status: 404 });
  const buf = await readMediaFile(m);
  const inline = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime)|application\/pdf)$/.test(m.mime_type);
  const headers: Record<string, string> = {
    "Content-Type": m.mime_type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(m.filename)}"`,
    "Cache-Control": "private, max-age=3600",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Accept-Ranges": "bytes",
  };
  const range = req.headers.get("range");
  if (range && m.mime_type.startsWith("video/")) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), buf.length - 1) : buf.length - 1;
    if (start >= buf.length || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${buf.length}` } });
    return new Response(new Uint8Array(buf.subarray(start, end + 1)), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${buf.length}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(new Uint8Array(buf), { headers: { ...headers, "Content-Length": String(buf.length) } });
}
