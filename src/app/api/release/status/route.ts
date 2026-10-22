import { headers } from "next/headers";
import { releaseApiEnabled, releaseStatus, releaseTokenValid } from "@/lib/release";
import { rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Dağıtım hattının doğrulama ucu (RELEASE_STATUS_TOKEN). Belirteç tanımlı değilse uç yoktur (404). */
export async function GET(req: Request) {
  if (!releaseApiEnabled()) return new Response(null, { status: 404, headers: NO_STORE });
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(`release-status:${ip}`, 60, 60_000).ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: NO_STORE });
  if (!releaseTokenValid(req.headers.get("authorization"))) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const s = await releaseStatus();
  return Response.json(s, { status: s.ok ? 200 : 503, headers: NO_STORE });
}
