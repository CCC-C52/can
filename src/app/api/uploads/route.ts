import { withBrand } from "./_shared";
import { initUpload } from "@/lib/uploads";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return withBrand("upload-init", 60, async (brandId) => {
    const r = await initUpload(brandId, { filename: String(body.filename ?? ""), size: Number(body.size), mime: body.mime ? String(body.mime) : undefined, clientKey: String(body.clientKey ?? ""), meta: sanitizeMeta(body.meta) });
    return { id: r.session.id, partSize: r.session.part_size, partCount: r.session.part_count, uploadedParts: r.uploadedParts, resumed: r.resumed, status: r.session.status };
  });
}

function sanitizeMeta(m: any) {
  if (!m || typeof m !== "object") return {};
  const list = (v: unknown) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20) : []);
  return {
    productId: typeof m.productId === "string" && m.productId ? m.productId : null,
    kind: ["logo", "design"].includes(m.kind) ? m.kind : undefined,
    origin: ["real_photo", "real_video", "ai_generated", "design_file"].includes(m.origin) ? m.origin : undefined,
    rightsStatus: ["unknown", "owned", "licensed", "restricted"].includes(m.rightsStatus) ? m.rightsStatus : "unknown",
    themes: list(m.themes),
    tags: list(m.tags),
    shotType: typeof m.shotType === "string" ? m.shotType.slice(0, 100) || null : null,
  };
}
