import { authorizeBridge, bridgeErrorResponse, bridgeSubmit, BridgeError } from "@/lib/bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Köprü: AI Manager'a talimat gönderir (kapsam: instructions:submit). confirm_cost=true olmadan hiçbir şey kaydedilmez. */
export async function POST(req: Request) {
  try {
    const cred = authorizeBridge(req, "instructions:submit");
    if (!req.headers.get("content-type")?.includes("application/json")) throw new BridgeError(415, "unsupported_media_type", "Content-Type must be application/json");
    const text = await req.text();
    if (text.length > 20_000) throw new BridgeError(413, "too_large", "Body too large");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new BridgeError(400, "invalid_body", "Malformed JSON"); }
    const r = await bridgeSubmit(cred, { body, idempotencyKey: req.headers.get("idempotency-key"), timestamp: req.headers.get("x-bridge-timestamp") });
    return Response.json(r, { status: r.status === "accepted" ? 202 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return bridgeErrorResponse(err);
  }
}
