import { withBrand } from "../../../_shared";
import { putPart } from "@/lib/uploads";

export const runtime = "nodejs";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  return withBrand("upload-part", 1200, async (brandId) => putPart(brandId, id, Number(n), req.body));
}
