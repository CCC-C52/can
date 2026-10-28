import sharp from "sharp";
import { isUuid } from "@/lib/ids";
import { requireBrand } from "@/lib/current";
import { getMedia } from "@/lib/services/media";
import { getStorage } from "@/lib/storage";
import { rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

/** İzin verilen genişlikler: önbellek dostu, tahmin edilebilir boyutlar. */
const WIDTHS = [160, 320, 640, 960, 1280, 1920] as const;
const MAX_SOURCE_BYTES = 60 * 1024 * 1024;

/**
 * Arayüz için küçültülmüş görsel (WebP). Yalnızca seçili markanın görselleri; orijinal dosya değişmez.
 * Ürün referansı veya üretim girdisi olarak KULLANILMAZ — yalnızca ekranda göstermek içindir.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return new Response(null, { status: 404 });
  const brand = await requireBrand().catch(() => null);
  if (!brand) return new Response(null, { status: 404 });
  const rl = rateLimit(`media-preview:${brand.id}`, 300, 60_000);
  if (!rl.ok) return new Response(null, { status: 429, headers: { "Retry-After": String(rl.retryAfterS) } });
  const m = await getMedia(brand.id, id);
  if (!m || !/^image\/(jpeg|png|webp|gif)$/.test(m.mime_type) || Number(m.size_bytes) > MAX_SOURCE_BYTES) return new Response(null, { status: 404 });
  const asked = Number(new URL(req.url).searchParams.get("w")) || 640;
  const width = WIDTHS.find((w) => w >= asked) ?? WIDTHS[WIDTHS.length - 1];
  try {
    const src = await getStorage().get(m.storage_key);
    const out = await sharp(src, { limitInputPixels: 80_000_000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    return new Response(new Uint8Array(out), {
      headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}
