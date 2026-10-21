import { withBrand } from "../../_shared";
import { partTargets } from "@/lib/uploads";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parts = Array.isArray(body.parts) ? body.parts.slice(0, 200).map(Number) : [];
  return withBrand("upload-targets", 300, async (brandId) => ({ targets: await partTargets(brandId, id, parts) }));
}
