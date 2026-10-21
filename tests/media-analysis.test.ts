import { describe, it, expect, beforeAll, afterEach } from "vitest";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { createBrand, createProduct } from "@/lib/services/brands";
import { uploadMedia } from "@/lib/services/media";
import { analyzeImagePixels } from "@/lib/media-analysis/pixels";
import { analyzeVideoLocal, planKeyframes } from "@/lib/media-analysis/video";
import { enqueueAnalysis, runAnalysisQueueOnce, latestAnalysis, backfillAnalyses } from "@/lib/media-analysis";
import { buildBrandContext } from "@/lib/agents/context";
import { setTextModelOverride } from "@/lib/models";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "@/lib/models/types";
import { getStorage } from "@/lib/storage";
import { productPhoto, checkerboard, colorScenesVideo, movingVideo } from "./fixtures";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Sahte vision modeli: gelen GERÇEK pikselleri kaydeder ve piksellerden türetilmiş bir yanıt üretir (dosya adına bakmaz). */
class RecordingVisionModel implements TextModelAdapter {
  readonly id = "anthropic:test-vision";
  readonly isDemo = false;
  readonly service = "anthropic";
  calls: GenerateRequest<unknown>[] = [];
  estimateCostUsd() { return 0.01; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.calls.push(req as GenerateRequest<unknown>);
    // Yanıtı yalnızca gönderilen ilk görselin piksellerinden türet
    const px = await analyzeImagePixels(Buffer.from(req.images![0].base64, "base64"));
    const main = px.dominant_colors.find((c) => c.name !== "beyaz")?.name ?? px.dominant_colors[0].name;
    const image = {
      summary: `Beyaz zeminde ${main} renkli ürün`, apparel_category: "belirsiz", model_present: false, pose: "model yok",
      background: px.background.name, lighting: "eşit", composition: "ortalanmış", product_visibility: "tam",
      marketing_suitability: { score: 3, reason: "test" }, usage_scenarios: ["ürün sayfası"], quality_issues: [], uncertain: ["ürün türü"],
      products: [{ category: "belirsiz", colors: [main], graphics_or_print: "yok", visible_text: "yok", branding: "yok", matched_catalog_product: "eşleşme yok", design_details: [] }],
    };
    const video = {
      summary: `${req.images!.length} kare`, scenes: req.images!.map((_, i) => ({ frame_numbers: [i + 1], summary: "düz renk", products: [], camera: "sabit" })),
      products_seen: [], people: "yok", setting: "düz renk", usability: { score: 2, issues: [] }, marketing_uses: [], uncertain: [],
    };
    return { data: req.schema.parse(req.purpose === "vision" && req.system.includes("keyframes") ? video : image), generator: "anthropic:test-vision", isDemo: false, model: "test-vision", usage: { input_tokens: 1000, output_tokens: 200 }, actualCostUsd: 0.008 };
  }
}

let brandId: string;
beforeAll(async () => {
  brandId = (await createBrand({ name: "Analysis Brand" })).id;
  await createProduct(brandId, { title: "Red Hoodie" });
});
afterEach(() => setTextModelOverride(null));

async function drain(worker = "an-w") {
  for (let i = 0; i < 20; i++) if (!(await runAnalysisQueueOnce(worker))) break;
}

describe("Yerel piksel analizi (bilinen içerik)", () => {
  it("renk, yön ve arka planı gerçek piksellerden çıkarır", async () => {
    const a = await analyzeImagePixels(await productPhoto("#d01c1c"));
    expect(a.orientation).toBe("portrait");
    expect(a.aspect).toBe("4:5");
    const names = a.dominant_colors.map((c) => c.name);
    expect(names[0]).toBe("beyaz");
    expect(names).toContain("kırmızı");
    expect(a.background).toMatchObject({ name: "beyaz", uniform: true });
    const blue = await analyzeImagePixels(await productPhoto("#1f3fd0", { bg: "#111111" }));
    expect(blue.dominant_colors.map((c) => c.name)).toContain("mavi");
    expect(blue.background.name).toBe("siyah");
  });

  it("netlik ölçüsü keskin ve bulanık görseli ayırt eder; karanlık görsel işaretlenir", async () => {
    const sharpImg = await analyzeImagePixels(await checkerboard(0));
    const blurry = await analyzeImagePixels(await checkerboard(8));
    expect(sharpImg.sharpness).toBeGreaterThan(blurry.sharpness * 5);
    const dark = await analyzeImagePixels(await productPhoto("#202020", { bg: "#0a0a0a" }));
    expect(dark.quality_flags).toContain("çok karanlık");
  });
});

describe("Yerel video analizi (bilinen içerik)", () => {
  it("süre, çözünürlük, kare hızı, yön, sahne kesmesi, kare renkleri ve ses ölçülür", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "va-"));
    const file = path.join(dir, "v.mp4");
    await fs.writeFile(file, await colorScenesVideo([{ color: "red", seconds: 2 }, { color: "blue", seconds: 2 }], { audio: true }));
    const { analysis, frames } = await analyzeVideoLocal(file);
    expect(analysis.probe.duration).toBeGreaterThan(3.8);
    expect(analysis.probe.duration).toBeLessThan(4.3);
    expect(analysis.probe.display_width).toBe(720);
    expect(analysis.probe.display_height).toBe(1280);
    expect(analysis.probe.orientation).toBe("portrait");
    expect(analysis.probe.fps).toBe(30);
    expect(analysis.audio.present).toBe(true);
    expect(analysis.scenes.length).toBe(2);
    expect(Math.abs(analysis.scenes[0].end - 2)).toBeLessThan(0.2);
    expect(analysis.scenes[0].dominant_colors[0]).toBe("kırmızı");
    expect(analysis.scenes[1].dominant_colors[0]).toBe("mavi");
    expect(analysis.motion.level).toBe("statik");
    expect(frames.every((f) => f.jpeg.length > 100)).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("hareketli görüntüde hareket tespit edilir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "va-"));
    const file = path.join(dir, "m.mp4");
    await fs.writeFile(file, await movingVideo(3));
    const { analysis } = await analyzeVideoLocal(file);
    expect(analysis.motion.level).not.toBe("statik");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("anahtar kare planı sınırlıdır", () => {
    const p = planKeyframes(60, [5, 10, 15, 20, 25, 30, 35, 40], 6);
    expect(p.times.length).toBeLessThanOrEqual(6);
    expect(planKeyframes(20, [], 6).times.length).toBe(3);
  });
});

describe("Analiz kuyruğu ve vision", () => {
  it("vision modeline dosya adı değil gerçek pikseller gönderilir; sonuç saklanır, ajan bağlamına girer, tekrar işlenmez", async () => {
    const model = new RecordingVisionModel();
    setTextModelOverride(model);
    // Dosya adı bilerek yanıltıcı: "blue" diyor, görsel kırmızı
    const { asset } = await uploadMedia(brandId, { buffer: await productPhoto("#d01c1c"), filename: "blue-shirt.jpg" });
    await drain();
    const a = await latestAnalysis(brandId, asset.id);
    expect(a!.status).toBe("completed");
    expect(a!.level).toBe("vision");
    expect(model.calls.length).toBe(1);
    const sent = model.calls[0];
    expect(sent.user).not.toContain("blue-shirt");
    const sentPixels = await analyzeImagePixels(Buffer.from(sent.images![0].base64, "base64"));
    expect(sentPixels.dominant_colors.map((c) => c.name)).toContain("kırmızı");
    expect(a!.result.vision.summary).toContain("kırmızı");
    expect(a!.result.local.dominant_colors.map((c: any) => c.name)).toContain("kırmızı");
    // Maliyet analize bağlı kaydedildi
    const cost = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM cost_entries WHERE analysis_id = $1 AND kind = 'actual'`, [a!.id]);
    expect(cost!.n).toBe(1);
    // Alt metin
    const alt = await q1<{ alt_text: string }>(`SELECT alt_text FROM media_assets WHERE id = $1`, [asset.id]);
    expect(alt!.alt_text).toContain("kırmızı");
    // Ajan bağlamında (media.read olan ajan)
    const ctx = await buildBrandContext(brandId, undefined, { agent: "design" });
    const m = ctx.media.find((x) => x.id === asset.id)!;
    expect((m.analysis as any).summary).toContain("kırmızı");
    // Önbellek: aynı varlık tekrar kuyruğa alınsa da yeni çağrı yok
    await enqueueAnalysis(asset);
    await drain();
    expect(model.calls.length).toBe(1);
    const rows = await q<{ id: string }>(`SELECT id FROM media_analyses WHERE asset_id = $1`, [asset.id]);
    expect(rows.length).toBe(1);
  });

  it("model yokken yalnızca yerel analiz yapılır; uydurma anlamsal sonuç üretilmez", async () => {
    const { asset } = await uploadMedia(brandId, { buffer: await productPhoto("#2a9d3a"), filename: "x.jpg" });
    await drain();
    const a = await latestAnalysis(brandId, asset.id);
    expect(a!.level).toBe("local");
    expect(a!.status).toBe("completed");
    expect(a!.result.vision).toBeUndefined();
    expect(a!.result.local.dominant_colors.map((c: any) => c.name)).toContain("yeşil");
  });

  it("video analizi gerçek kareleri saklar ve vision'a etiketli kareler gönderir", async () => {
    const model = new RecordingVisionModel();
    setTextModelOverride(model);
    const { asset } = await uploadMedia(brandId, { buffer: await colorScenesVideo([{ color: "red", seconds: 2 }, { color: "blue", seconds: 2 }]), filename: "clip.mp4" });
    await drain();
    const a = await latestAnalysis(brandId, asset.id);
    expect(a!.status).toBe("completed");
    expect(a!.result.local.scenes.length).toBe(2);
    expect(model.calls[0].images!.length).toBe(a!.result.frame_keys.length);
    expect(model.calls[0].images![0].label).toMatch(/Kare 1 · [\d.]+ sn/);
    const first = await getStorage().get(a!.result.frame_keys[0]);
    expect((await sharp(first).metadata()).format).toBe("jpeg");
    const firstPx = await analyzeImagePixels(first);
    expect(firstPx.dominant_colors[0].name).toBe("kırmızı");
  });

  it("başka markanın analizi okunamaz; işleyici marka uyuşmazlığında işlemez", async () => {
    const other = await createBrand({ name: "Other Analysis Brand" });
    const { asset } = await uploadMedia(brandId, { buffer: await productPhoto("#d0a01c"), filename: "y.jpg" });
    await drain();
    expect(await latestAnalysis(other.id, asset.id)).toBeNull();
    // Kurcalanmış kayıt: başka marka adına analiz kaydı
    await q(`INSERT INTO media_analyses (brand_id, asset_id, kind, analysis_version, input_hash, level) VALUES ($1,$2,'image',1,'tamper','local')`, [other.id, asset.id]);
    await drain();
    const tampered = await q1<{ status: string; error: string }>(`SELECT status, error FROM media_analyses WHERE input_hash = 'tamper'`);
    expect(tampered).toMatchObject({ status: "failed" });
    expect(tampered!.error).toMatch(/başka markaya ait/);
  });

  it("toplu analiz yalnızca eksik olanları kuyruğa alır", async () => {
    const before = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM media_analyses WHERE brand_id = $1`, [brandId]);
    expect(await backfillAnalyses(brandId)).toBe(0);
    const after = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM media_analyses WHERE brand_id = $1`, [brandId]);
    expect(after!.n).toBe(before!.n);
  });
});
