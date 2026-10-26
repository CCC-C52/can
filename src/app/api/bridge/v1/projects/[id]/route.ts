import { authorizeBridge, bridgeErrorResponse, bridgeProjectStatus } from "@/lib/bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Köprü: projenin ve görevlerinin durumu (kapsam: status:read). Yalnızca belirtecin bağlı olduğu markanın projeleri. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const cred = authorizeBridge(req, "status:read");
    const { id } = await ctx.params;
    return Response.json(await bridgeProjectStatus(cred, id), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return bridgeErrorResponse(err);
  }
}
