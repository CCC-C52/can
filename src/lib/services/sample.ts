import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { q1 } from "@/lib/db/pool";
import { addBrandFact, addProductFact, addVariant, createBrand, createProduct } from "./brands";
import { uploadMedia } from "./media";
import { config } from "@/lib/config";

const execFileAsync = promisify(execFile);

// AÇIKÇA ÖRNEK olarak işaretlenmiş demo marka. Gerçek bir markayı (ör. FriBee) temsil ETMEZ.
// Görseller ve videolar sentetik yer tutuculardır (düz renk + "SAMPLE" yazısı / ffmpeg test deseni).

export const SAMPLE_SLUG = "ornek-marka-demo";

async function placeholderPhoto(label: string, color: string) {
  const svg = `<svg width="1200" height="1500" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${color}"/>
    <rect x="300" y="350" width="600" height="700" rx="40" fill="#ffffff" opacity="0.85"/>
    <text x="600" y="700" font-family="Inter, DejaVu Sans" font-size="64" text-anchor="middle" fill="#333">SAMPLE</text>
    <text x="600" y="790" font-family="Inter, DejaVu Sans" font-size="40" text-anchor="middle" fill="#555">${label}</text>
    <text x="600" y="1400" font-family="Inter, DejaVu Sans" font-size="30" text-anchor="middle" fill="#fff">ÖRNEK YER TUTUCU — GERÇEK ÜRÜN DEĞİL</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

async function placeholderVideo(pattern: string, seconds: number): Promise<Buffer | null> {
  const out = path.join(os.tmpdir(), `sample-${pattern}-${Date.now()}.mp4`);
  try {
    await execFileAsync(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `${pattern}=size=720x1280:rate=30:duration=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", out], { timeout: 60_000 });
    return await fs.readFile(out);
  } catch {
    return null; // ffmpeg yoksa örnek video oluşturulmaz
  } finally {
    await fs.rm(out, { force: true });
  }
}

export async function seedSampleBrand() {
  const existing = await q1<{ id: string }>(`SELECT id FROM brands WHERE slug = $1`, [SAMPLE_SLUG]);
  if (existing) return { brandId: existing.id, created: false };
  const brand = await createBrand({
    name: "Örnek Marka (DEMO)",
    is_sample: true,
    story: "SAMPLE brand for testing the studio. All data is fictional and marked as sample.",
    target_audience: "Sample audience: urban adults 25-40 interested in casual wear (fictional).",
    tone: "Warm, concise, no exaggeration.",
    content_language: "en",
    colors: [{ name: "Ink", hex: "#1f3a5f" }, { name: "Sand", hex: "#efe8dc" }, { name: "Coral", hex: "#e4572e" }],
    fonts: [{ role: "Başlık", family: "Inter" }],
    shipping_info: null,
    return_policy: null,
    campaign_rules: "No discounts without explicit approval. Do not mention sustainability claims.",
  });
  await q1(`UPDATE brands SET slug = $2 WHERE id = $1 RETURNING id`, [brand.id, SAMPLE_SLUG]);
  await addBrandFact(brand.id, { kind: "decision", statement: "Launch content is published only after manual approval.", source: "örnek" });
  await addBrandFact(brand.id, { kind: "forbidden_claim", statement: "eco-friendly", source: "örnek" });

  const tee = await createProduct(brand.id, { title: "Sample Linen Shirt", description: "", product_type: "Shirt", price: "49.00", currency: "USD", status: "draft", is_sample: true });
  await addVariant(brand.id, tee.id, { title: "S / Sand", size: "S", color: "Sand", price: "49.00" });
  await addVariant(brand.id, tee.id, { title: "M / Sand", size: "M", color: "Sand", price: "49.00" });
  await addProductFact(brand.id, tee.id, { attribute: "Fabric", value: "100% linen", status: "verified", source: "örnek" });
  await addProductFact(brand.id, tee.id, { attribute: "Fit", value: "Relaxed fit", status: "verified", source: "örnek" });
  await addProductFact(brand.id, tee.id, { attribute: "Origin", value: "Handmade in Portugal", status: "unverified", source: "örnek — doğrulanmadı" });

  const cap = await createProduct(brand.id, { title: "Sample Canvas Cap", product_type: "Hat", price: null, currency: "USD", status: "draft", is_sample: true });
  await addVariant(brand.id, cap.id, { title: "One size / Ink", color: "Ink" });
  await addProductFact(brand.id, cap.id, { attribute: "Material", value: "Cotton canvas", status: "verified", source: "örnek" });

  await uploadMedia(brand.id, { buffer: await placeholderPhoto("Linen Shirt", "#c9b79c"), filename: "SAMPLE-linen-shirt-front.jpg" },
    { productId: tee.id, origin: "real_photo", themes: ["ürün", "stüdyo"], shotType: "Ürün önden", rightsStatus: "owned", tags: ["ÖRNEK yer tutucu"] });
  await uploadMedia(brand.id, { buffer: await placeholderPhoto("Canvas Cap", "#1f3a5f"), filename: "SAMPLE-canvas-cap.jpg" },
    { productId: cap.id, origin: "real_photo", themes: ["ürün"], shotType: "Ürün yakın", rightsStatus: "owned", tags: ["ÖRNEK yer tutucu"] });
  for (const [pattern, name] of [["testsrc2", "SAMPLE-clip-a.mp4"], ["smptebars", "SAMPLE-clip-b.mp4"]] as const) {
    const vid = await placeholderVideo(pattern, 4);
    if (vid) await uploadMedia(brand.id, { buffer: vid, filename: name }, { productId: tee.id, origin: "real_video", themes: ["lansman"], shotType: "Test deseni", rightsStatus: "owned", tags: ["ÖRNEK test deseni"] });
  }
  return { brandId: brand.id, created: true };
}
