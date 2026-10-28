import { appIconPng } from "@/lib/services/pwa";
import { rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIZES = new Set([180, 192, 512]);

/** PWA / iOS ana ekran simgesi. Oturum gerektirmez (tarayıcı kurulumda kimliksiz ister); yalnızca marka logosunu içerir. */
export async function GET(req: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return new Response(null, { status: 404 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(`app-icon:${ip}`, 60, 60_000).ok) return new Response(null, { status: 429 });
  const { png } = await appIconPng(size);
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}
