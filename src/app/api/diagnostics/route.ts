import { headers } from "next/headers";
import { collectDiagnostics } from "@/lib/services/diagnostics";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ayrıntılı sistem durumu (oturum gerekir; proxy korur). Gizli değer döndürmez. */
export async function GET() {
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  try {
    const d = await collectDiagnostics();
    return Response.json(d, { status: d.overall === "down" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    log("error", "api.diagnostics_error", { requestId, error: err });
    return Response.json({ overall: "down", error: "Tanılama toplanamadı", requestId }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
