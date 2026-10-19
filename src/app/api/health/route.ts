import { q1 } from "@/lib/db/pool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Barındırıcının sağlık kontrolü. Oturum gerektirmez; hiçbir veri döndürmez. */
export async function GET() {
  try {
    await q1(`SELECT 1`);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
