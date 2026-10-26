import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { prepareReference, ReferenceQualityError, REFERENCE_MAX_BYTES } from "@/lib/video/reference";
import { parseBrandColors, createBrand } from "@/lib/services/brands";
import { uploadMedia } from "@/lib/services/media";
import { runRuleChecks } from "@/lib/agents/qa-rules";
import { buildBrandContext } from "@/lib/agents/context";
import { systemPrompt } from "@/lib/agents/prompts";
import { productPhoto } from "./fixtures";

describe("Referans netliği (AI'ye giden ürün fotoğrafı)", () => {
  it("sınıra sığan orijinal bayt bayt aynen gönderilir", async () => {
    const jpg = await productPhoto("#f97316", { width: 2000, height: 2500 });
    const r = await prepareReference(jpg, "image/jpeg");
    expect(Buffer.from(r.base64, "base64").equals(jpg)).toBe(true);
    expect(r.mimeType).toBe("image/jpeg");
    expect(r.fidelity).toMatchObject({ transformed: "none", original_px: [2000, 2500], sent_px: [2000, 2500] });
  });

  it("sınırı aşan büyük dosya aynı piksel boyutunda yüksek kalite (4:4:4) JPEG'e çevrilir; gerekirse 4096'ya iner", async () => {
    // Gürültülü büyük PNG (sıkışmaz) → sınırdan büyük
    const w = 3000, h = 3600;
    const noise = Buffer.alloc(w * h * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const png = await sharp(noise, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    expect(png.length).toBeGreaterThan(REFERENCE_MAX_BYTES);
    const r = await prepareReference(png, "image/png");
    const sent = Buffer.from(r.base64, "base64");
    expect(sent.length).toBeLessThanOrEqual(REFERENCE_MAX_BYTES);
    const meta = await sharp(sent).metadata();
    expect(meta.format).toBe("jpeg");
    expect(r.fidelity.original_px).toEqual([w, h]);
    expect([meta.width, meta.height]).toEqual(r.fidelity.sent_px);
    expect(["reencoded", "downscaled"]).toContain(r.fidelity.transformed);
    if (r.fidelity.transformed === "reencoded") expect(r.fidelity.sent_px).toEqual([w, h]); // piksel kaybı yok
    expect(r.fidelity.quality).toBeGreaterThanOrEqual(88);
  });

  it("gerçekçi büyük ürün fotoğrafı (6000x7500 PNG) tam çözünürlükte, kalite 95 ile gönderilir", async () => {
    const big = await sharp(await productPhoto("#f97316", { width: 6000, height: 7500 })).png({ compressionLevel: 0 }).toBuffer();
    expect(big.length).toBeGreaterThan(REFERENCE_MAX_BYTES);
    const r = await prepareReference(big, "image/png");
    expect(r.fidelity).toMatchObject({ transformed: "reencoded", quality: 95, original_px: [6000, 7500], sent_px: [6000, 7500] });
  });

  it("kısa kenarı 1024 pikselin altındaki fotoğraf referans olamaz", async () => {
    await expect(prepareReference(await productPhoto("#f97316", { width: 800, height: 1000 }), "image/jpeg", "kucuk.jpg")).rejects.toBeInstanceOf(ReferenceQualityError);
  });
});

describe("Marka paleti (Pantone) ve tasarım sadakati", () => {
  it("renk satırları Pantone koduyla ayrıştırılır; Pantone isteğe bağlı", () => {
    expect(parseBrandColors("Anime turuncu, #f97316, PANTONE 1585 C\nSiyah; #111827; Black 6 C\nBeyaz, #ffffff\nhatalı, mavi")).toEqual([
      { name: "Anime turuncu", hex: "#f97316", pantone: "PANTONE 1585 C" },
      { name: "Siyah", hex: "#111827", pantone: "PANTONE Black 6 C" },
      { name: "Beyaz", hex: "#ffffff" },
    ]);
  });

  it("tüm ajanların istemi paleti ve tasarımı değiştirilemez sayar", () => {
    for (const a of ["manager", "video", "design", "marketing", "social", "shopify", "quality"] as const) {
      expect(systemPrompt(a, a === "manager" ? "plan" : "work")).toMatch(/LOCKED brand palette.*Pantone.*never redesign, recolour/s);
    }
  });

  let brandId: string;
  let hiRes: string;
  let lowRes: string;
  beforeAll(async () => {
    brandId = (await createBrand({ name: "Fidelity Brand", content_language: "en" })).id;
    hiRes = (await uploadMedia(brandId, { buffer: await productPhoto("#f97316"), filename: "tee-front.jpg" })).asset.id;
    lowRes = (await uploadMedia(brandId, { buffer: await productPhoto("#f97316", { width: 600, height: 750 }), filename: "tee-small.jpg" })).asset.id;
  });

  it("kalite kontrolü: rengi/tasarımı değiştiren istem ve düşük çözünürlüklü referans reddedilir", async () => {
    const ctx = await buildBrandContext(brandId, undefined, { agent: "quality", includeAssetIds: [hiRes, lowRes] });
    const scene = (prompt: string, refs: string[]) => ({ summary: "s", unknowns: [], videos: [{
      id: "scene-1", mode: "generate_new", format: "9:16", duration_s: 8, selected_asset_ids: refs, script: [], subtitles: [], generation_prompt: prompt,
      music_note: "", transition: "cut", framing: "fill", intro_text: "", outro_text: "", segments: [], parts: [],
    }] });
    const ok = runRuleChecks("video", scene("Slow dolly-in on the model wearing the T-shirt in a neon street.", [hiRes]), ctx, { isDemo: false });
    expect(ok.checks.find((c) => c.name === "Tasarım sadakati")).toBeUndefined();
    expect(ok.checks.find((c) => c.name === "Referans netliği")).toBeUndefined();
    const recolor = runRuleChecks("video", scene("Same shirt but change the colour to purple and redesign the print.", [hiRes]), ctx, { isDemo: false });
    expect(recolor.verdict).toBe("needs_changes");
    expect(recolor.checks.find((c) => c.name === "Tasarım sadakati")?.status).toBe("fail");
    const small = runRuleChecks("video", scene("Slow orbit around the T-shirt.", [lowRes]), ctx, { isDemo: false });
    expect(small.checks.find((c) => c.name === "Referans netliği")?.status).toBe("fail");
  });
});
