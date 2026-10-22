import { headers } from "next/headers";
import { recordReleaseEvent, releaseApiEnabled, releaseTokenValid, ReleaseEventSchema } from "@/lib/release";
import { rateLimit } from "@/lib/security/rate-limit";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Dağıtım hattı sürüm olaylarını bildirir (RELEASE_STATUS_TOKEN). Yalnızca kayıt tutar; hiçbir işlem başlatmaz. */
export async function POST(req: Request) {
  if (!releaseApiEnabled()) return new Response(null, { status: 404, headers: NO_STORE });
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(`release-events:${ip}`, 60, 60_000).ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
  if (!releaseTokenValid(req.headers.get("authorization"))) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const raw = await req.text();
  if (raw.length > 8_000) return Response.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  const parsed = ReleaseEventSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "invalid_event" }, { status: 400, headers: NO_STORE });
  try {
    const rec = await recordReleaseEvent(parsed.data);
    if (["succeeded", "failed", "blocked", "rolled_back", "rollback_failed"].includes(parsed.data.phase)) {
      await audit({ actor: "release-pipeline", action: `release.${parsed.data.phase}`, message: `Sürüm ${parsed.data.sha.slice(0, 7)}: ${parsed.data.phase}${parsed.data.detail ? ` — ${parsed.data.detail.slice(0, 300)}` : ""}` });
    }
    return Response.json({ ok: true, outcome: rec.outcome }, { headers: NO_STORE });
  } catch (err) {
    return Response.json({ error: (err as Error).message.slice(0, 200) }, { status: 409, headers: NO_STORE });
  }
}
