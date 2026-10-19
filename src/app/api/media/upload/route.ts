import { NextResponse } from "next/server";
import { requireBrand } from "@/lib/current";
import { uploadMedia, MediaValidationError } from "@/lib/services/media";
import { config } from "@/lib/config";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let brandId: string;
  try {
    brandId = (await requireBrand()).id;
  } catch {
    return NextResponse.json({ error: "Marka seçili değil" }, { status: 400 });
  }
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > config.maxUploadBytes * 1.1) return NextResponse.json({ error: "Dosya çok büyük" }, { status: 413 });
  const form = await req.formData();
  const list = (k: string) => String(form.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const meta = {
    productId: String(form.get("productId") ?? "") || null,
    kind: String(form.get("kind") ?? "") || undefined,
    origin: String(form.get("origin") ?? "") || undefined,
    themes: list("themes"),
    shotType: String(form.get("shotType") ?? "") || null,
    rightsStatus: String(form.get("rightsStatus") ?? "unknown"),
    tags: list("tags"),
  };
  const results: { filename: string; ok: boolean; duplicate?: boolean; id?: string; error?: string }[] = [];
  for (const f of form.getAll("files")) {
    if (!(f instanceof File)) continue;
    try {
      const buf = Buffer.from(await f.arrayBuffer());
      const r = await uploadMedia(brandId, { buffer: buf, filename: f.name }, meta);
      results.push({ filename: f.name, ok: true, duplicate: r.duplicate, id: r.asset.id });
    } catch (err) {
      results.push({ filename: f.name, ok: false, error: err instanceof MediaValidationError ? err.message : "Yükleme başarısız" });
    }
  }
  return NextResponse.json({ results });
}
