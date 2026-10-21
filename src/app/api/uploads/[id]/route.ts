import { withBrand } from "../_shared";
import { uploadedParts } from "@/lib/uploads";

export const runtime = "nodejs";

/** Oturum durumu (sürdürme ve "doğrulanıyor/işleniyor" takibi için). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withBrand("upload-status", 600, async (brandId) => {
    const { session: s, parts } = await uploadedParts(brandId, id);
    return { id: s.id, status: s.status, uploadedParts: parts, partCount: s.part_count, assetId: s.asset_id, duplicate: s.duplicate, error: s.error };
  });
}
