import { withBrand } from "../../_shared";
import { completeUpload } from "@/lib/uploads";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withBrand("upload-complete", 120, async (brandId) => {
    const s = await completeUpload(brandId, id);
    return { id: s.id, status: s.status };
  });
}
