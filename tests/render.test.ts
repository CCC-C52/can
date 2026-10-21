import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { Engine } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks } from "@/lib/orchestrator/projects";
import { createBrand, createProduct } from "@/lib/services/brands";
import { uploadMedia } from "@/lib/services/media";
import { upsertConnection } from "@/lib/services/connections";
import { setSetting, DEFAULT_LIMITS } from "@/lib/settings";
import { setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import { composeDesign, SIZES } from "@/lib/adapters/compose";
import { renderEdit, timeline } from "@/lib/adapters/video-edit";
import { setImageGeneratorOverride, type ImageGenerator } from "@/lib/adapters/images";
import { setVideoGeneratorOverride, type VideoGenerator, type VideoGenRequest } from "@/lib/adapters/video-generation";
import { UncertainOutcomeError } from "@/lib/adapters/http";
import { reconcileStaleSubmissions } from "@/lib/services/provider-jobs";
import { probeVideo } from "@/lib/media-analysis/video";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "@/lib/models/types";
import type { Plan } from "@/lib/agents/schemas";
import { productPhoto, colorScenesVideo } from "./fixtures";
import { key } from "./helpers";

/** Plan + uzman çıktısını testte belirleyen model; kalite kontrol vb. DEMO'ya devredilir. */
class ScriptedModel implements TextModelAdapter {
  readonly id = "scripted";
  readonly isDemo = true;
  readonly service = "scripted";
  private demo = new DemoAdapter();
  constructor(private plan: Plan, private outputs: Record<string, unknown>) {}
  estimateCostUsd() { return 0; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const scripted = req.agent === "manager" && req.purpose === "plan" ? this.plan : req.purpose === "work" ? this.outputs[req.agent] : undefined;
    if (scripted) return { data: req.schema.parse(scripted), generator: "scripted", isDemo: true, model: "scripted", usage: null, actualCostUsd: 0 };
    return this.demo.generate(req);
  }
}

/** İşleyiciyi sürer; "sonra tekrar sorgula" diye kuyruğa dönen görevlerde zamanı ileri alır. */
async function drive(engine: Engine, maxTicks = 80) {
  for (let i = 0; i < maxTicks; i++) {
    await q(`UPDATE tasks SET next_attempt_at = now() WHERE status = 'ready' AND next_attempt_at > now()`);
    const n = await engine.tick();
    await engine.waitInflight();
    const active = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE status IN ('planned','ready','review_pending','running')`);
    if (n === 0 && active!.n === 0) return;
  }
  throw new Error("Kuyruk boşalmadı");
}

const brief = (o: Record<string, unknown>) => ({
  id: "b", purpose: "post", render_mode: "photo_composition", slides: [], format: "1:1", headline: "Headline", body_text: "Body",
  visual_direction: "", product_ids: [], source_asset_ids: [], use_real_product_photo: true, generation_prompt: "A product on a table", notes: "", ...o,
});
const designPlan = (title: string): Plan => ({ reply: "plan", goals: ["g"], questions_for_owner: [], tasks: [{ key: "visuals", agent: "design", title, instruction: "Tasarla", depends_on: [] }] } as Plan);
const videoPlan: Plan = { reply: "plan", goals: ["g"], questions_for_owner: [], tasks: [{ key: "video", agent: "video", title: "Video", instruction: "Video", depends_on: [] }] } as Plan;

let brandId: string;
let photoId: string;
let otherBrandPhotoId: string;
let clipIds: string[];

beforeAll(async () => {
  const b = await createBrand({ name: "Render Test Brand", content_language: "en" });
  brandId = b.id;
  await q(`UPDATE brands SET colors = $2 WHERE id = $1`, [brandId, JSON.stringify([{ name: "primary", hex: "#7c2d12" }, { name: "bg", hex: "#f5efe6" }])]);
  const p = await createProduct(brandId, { title: "Render Shirt", price: "50", currency: "USD" });
  photoId = (await uploadMedia(brandId, { buffer: await productPhoto("#2563eb"), filename: "shirt.jpg" }, { productId: p.id })).asset.id;
  const logo = await sharp({ create: { width: 300, height: 100, channels: 4, background: "#111111" } }).png().toBuffer();
  await uploadMedia(brandId, { buffer: logo, filename: "logo.png" }, { kind: "logo" });
  clipIds = [
    (await uploadMedia(brandId, { buffer: await colorScenesVideo([{ color: "red", seconds: 3 }]), filename: "a.mp4" })).asset.id,
    (await uploadMedia(brandId, { buffer: await colorScenesVideo([{ color: "blue", seconds: 3 }]), filename: "b.mp4" })).asset.id,
  ];
  const other = await createBrand({ name: "Other Render Brand", content_language: "en" });
  otherBrandPhotoId = (await uploadMedia(other.id, { buffer: await productPhoto("#16a34a"), filename: "other.jpg" })).asset.id;
});
afterEach(async () => {
  setTextModelOverride(null);
  setImageGeneratorOverride(undefined);
  setVideoGeneratorOverride(undefined);
  await setSetting("limits", {});
});
afterAll(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

describe("Yerel tasarım derleme", () => {
  it("her format için çözülebilir, doğru boyutlu görsel üretir; ürün fotoğrafı kırpılmaz/renk değişmez", async () => {
    const photo = await productPhoto("#2563eb");
    for (const format of ["1:1", "4:5", "9:16", "16:9"]) {
      for (const mode of ["photo_composition", "typography"] as const) {
        const r = await composeDesign({ mode, purpose: format === "16:9" ? "banner" : format === "9:16" ? "story" : "post", format, headline: "A long headline that must wrap onto more than one line", body: "Body", photo, bg: "#f5efe6", accent: "#7c2d12" });
        const m = await sharp(r.buffer).metadata();
        expect([m.width, m.height]).toEqual(SIZES[format]);
        expect(m.format).toBe(mode === "typography" ? "png" : "jpeg");
        if (mode === "photo_composition") {
          // Ürün rengi (#2563eb) birebir korunmuş olmalı
          const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
          let found = 0;
          for (let i = 0; i < data.length; i += info.channels * 7) if (Math.abs(data[i] - 0x25) < 10 && Math.abs(data[i + 1] - 0x63) < 10 && Math.abs(data[i + 2] - 0xeb) < 10) found++;
          expect(found).toBeGreaterThan(500);
        }
      }
    }
  });

  it("carousel, story, banner, reel kapağı: en az 3 gerçek dosya; 'composed' kökeni, proje bağı ve köken zinciri", async () => {
    setTextModelOverride(new ScriptedModel(designPlan("Kampanya görselleri"), {
      design: { summary: "s", unknowns: [], briefs: [
        brief({ id: "car", purpose: "carousel", format: "1:1", source_asset_ids: [photoId], slides: [{ headline: "Slide 2", body_text: "b" }, { headline: "Slide 3", body_text: "c" }] }),
        brief({ id: "story", purpose: "story", format: "9:16", source_asset_ids: [photoId] }),
        brief({ id: "banner", purpose: "banner", format: "16:9", source_asset_ids: [photoId] }),
        brief({ id: "reel", purpose: "reel_cover", format: "9:16", render_mode: "typography", use_real_product_photo: false }),
        // Kayıtlı ama silinmiş/fotoğraf olmayan kaynak: tipografiye düşer, not düşülür
        brief({ id: "nophoto", purpose: "post", format: "4:5", source_asset_ids: [clipIds[0]] }),
      ] },
    }));
    const { project } = await submitInstruction({ brandId, instruction: "Görseller", idempotencyKey: key() });
    await drive(new Engine("render-w1"));
    const render = (await listTasks(brandId, { projectId: project.id })).find((t) => t.kind === "render")!;
    expect(render.status).toBe("completed");
    expect(render.error).toMatch(/nophoto: kaynak ürün fotoğrafı bulunamadı/);
    const assets = await q<{ id: string; format: string; origin: string; generation_method: string; project_id: string; storage_key: string; filename: string }>(
      `SELECT * FROM media_assets WHERE brand_id = $1 AND source_task_id = $2 ORDER BY filename`, [brandId, render.id]);
    expect(assets.length).toBe(3 + 1 + 1 + 1 + 1); // carousel 3 kare + story + banner + reel + nophoto
    expect(assets.every((a) => a.origin === "composed" && a.generation_method === "sharp_compose" && a.project_id === project.id)).toBe(true);
    expect(new Set(assets.map((a) => a.format))).toEqual(new Set(["1:1", "9:16", "16:9", "4:5"]));
    expect(assets.filter((a) => a.filename.startsWith("car-")).map((a) => a.filename)).toEqual(["car-1of3-1x1.jpg", "car-2of3-1x1.jpg", "car-3of3-1x1.jpg"]);
    const { getStorage } = await import("@/lib/storage");
    for (const a of assets) {
      const m = await sharp(await getStorage().get(a.storage_key)).metadata();
      expect(m.width).toBeGreaterThan(1000);
    }
    const lineage = await q<{ source_asset_id: string }>(`SELECT l.source_asset_id FROM media_lineage l JOIN media_assets m ON m.id = l.derived_asset_id WHERE m.source_task_id = $1`, [render.id]);
    expect(lineage.some((l) => l.source_asset_id === photoId)).toBe(true);
  });

  it("başka markanın medya kimliği tasarımda kaynak gösterilemez (kalite kontrolü reddeder, dosya üretilmez)", async () => {
    setTextModelOverride(new ScriptedModel(designPlan("Yabancı kaynak"), {
      design: { summary: "s", unknowns: [], briefs: [brief({ id: "foreign", source_asset_ids: [otherBrandPhotoId] })] },
    }));
    const { project } = await submitInstruction({ brandId, instruction: "Yabancı kaynak", idempotencyKey: key() });
    await drive(new Engine("render-w2"));
    const tasks = await listTasks(brandId, { projectId: project.id });
    expect(tasks.find((t) => t.key === "visuals")!.status).toBe("failed");
    expect(tasks.some((t) => t.kind === "render")).toBe(false);
    expect(await q1(`SELECT 1 FROM media_lineage WHERE source_asset_id = $1`, [otherBrandPhotoId])).toBeNull();
  });
});

describe("AI görsel üretimi (sahte sağlayıcı)", () => {
  class FakeImages implements ImageGenerator {
    readonly service = "openai_images";
    readonly model = "fake-image";
    calls: { prompt: string; refs: number }[] = [];
    constructor(private mode: "ok" | "blank" | "uncertain" = "ok") {}
    estimateCostUsd() { return 0.05; }
    async generate(prompt: string, _size: string, refs: unknown[] = []) {
      this.calls.push({ prompt, refs: refs.length });
      if (this.mode === "uncertain") throw new UncertainOutcomeError("Sunucu hatası 502; işlem gerçekleşmiş olabilir.");
      if (this.mode === "blank") return sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ffffff" } }).png().toBuffer();
      return productPhoto("#9333ea", { width: 1024, height: 1024 }).then((b) => sharp(b).png().toBuffer());
    }
  }

  async function runAi(gen: FakeImages) {
    setImageGeneratorOverride(gen);
    setTextModelOverride(new ScriptedModel(designPlan("AI görsel"), { design: { summary: "s", unknowns: [], briefs: [brief({ id: "ai", render_mode: "ai_image", source_asset_ids: [photoId] })] } }));
    const { project } = await submitInstruction({ brandId, instruction: "AI görsel", idempotencyKey: key() });
    await drive(new Engine("render-ai"));
    return { project, render: (await listTasks(brandId, { projectId: project.id })).find((t) => t.kind === "render")! };
  }

  it("sahip izni yokken ücretli üretim yapılmaz (bağlantı/izin bekler)", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    await upsertConnection("openai_images", null, { status: "connected" });
    const gen = new FakeImages();
    const { render } = await runAi(gen);
    expect(gen.calls.length).toBe(0);
    expect(render.status).toBe("waiting_connection");
    expect(render.error).toMatch(/Ayarlar'da kapalı/);
  });

  it("izin + bağlantı varken gerçek ürün fotoğrafı referansıyla üretir; tekrar çalıştırma ikinci ücret doğurmaz", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    await upsertConnection("openai_images", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true });
    const gen = new FakeImages();
    const { render, project } = await runAi(gen);
    expect(render.status).toBe("completed");
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0].refs).toBe(1);
    expect(gen.calls[0].prompt).toMatch(/Keep the product exactly/);
    const job = await q1<any>(`SELECT * FROM provider_jobs WHERE task_id = $1`, [render.id]);
    expect(job.status).toBe("succeeded");
    const asset = await q1<any>(`SELECT * FROM media_assets WHERE id = $1`, [job.result_asset_id]);
    expect(asset.origin).toBe("ai_generated");
    expect(asset.generation_method).toBe("ai_image:openai_images");
    const costs = await q<{ kind: string; amount_usd: string }>(`SELECT kind, amount_usd FROM cost_entries WHERE provider_job_id = $1 ORDER BY kind`, [job.id]);
    expect(costs.map((c) => [c.kind, Number(c.amount_usd)])).toEqual([["actual", 0.05], ["estimated", 0.05]]);

    // Aynı görevin tekrar teslimi (ör. kiralama kaybı sonrası): sağlayıcı yeniden çağrılmaz
    await q(`UPDATE tasks SET status = 'ready', finished_at = NULL WHERE id = $1`, [render.id]);
    await drive(new Engine("render-ai-2"));
    expect(gen.calls).toHaveLength(1);
    expect((await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM provider_jobs WHERE project_id = $1`, [project.id]))!.n).toBe(1);
  });

  it("tek renk (yer tutucu) dosya başarılı üretim sayılmaz", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    await upsertConnection("openai_images", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true });
    const { render } = await runAi(new FakeImages("blank"));
    expect(render.status).toBe("failed");
    expect(render.error).toMatch(/tek renk/);
    expect(await q1(`SELECT 1 FROM media_assets WHERE source_task_id = $1`, [render.id])).toBeNull();
  });

  it("sonucu belirsiz gönderim otomatik tekrar edilmez ve proje engellenir", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    await upsertConnection("openai_images", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true });
    const gen = new FakeImages("uncertain");
    const { render, project } = await runAi(gen);
    expect(render.status).toBe("failed");
    expect(render.failure_class).toBe("uncertain");
    expect(gen.calls).toHaveLength(1);
    expect((await q1<any>(`SELECT status FROM provider_jobs WHERE task_id = $1`, [render.id])).status).toBe("unknown");
    expect((await q1<any>(`SELECT status FROM projects WHERE id = $1`, [project.id])).status).toBe("blocked");
    const unknownCost = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM cost_entries WHERE task_id = $1 AND kind = 'actual' AND amount_usd IS NULL`, [render.id]);
    expect(unknownCost!.n).toBe(1);
  });
});

describe("AI video üretimi (sahte Veo)", () => {
  class FakeVeo implements VideoGenerator {
    readonly service = "video_generation";
    readonly model = "veo-fake";
    submits: VideoGenRequest[] = [];
    polls = 0;
    constructor(private video: Buffer, private runningPolls = 2, private fail = false) {}
    estimateCostUsd(s: number) { return 0.1 * s; }
    async submit(req: VideoGenRequest) {
      this.submits.push(req);
      return { externalId: `models/veo-fake/operations/op${this.submits.length}`, request: {} };
    }
    async poll() {
      this.polls++;
      if (this.polls <= this.runningPolls) return { state: "running" as const };
      return this.fail ? { state: "failed" as const, error: "content filtered" } : { state: "succeeded" as const, videoUri: "https://generativelanguage.googleapis.com/v1beta/files/x:download" };
    }
    async download() { return this.video; }
  }
  const genVideo = () => ({ summary: "s", unknowns: [], videos: [{
    id: "gv", mode: "generate_new", format: "9:16", duration_s: 6, selected_asset_ids: [photoId], script: [], subtitles: [], generation_prompt: "Slow pan over the shirt", music_note: "",
  }] });

  it("gönder → sorgula (görev kuyruğa döner) → indir → doğrula → arşive kaydet; işleyici değişse de tek gönderim", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    await upsertConnection("video_generation", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true });
    const veo = new FakeVeo(await colorScenesVideo([{ color: "green", seconds: 2 }]));
    setVideoGeneratorOverride(veo);
    setTextModelOverride(new ScriptedModel(videoPlan, { video: genVideo() }));
    const { project } = await submitInstruction({ brandId, instruction: "AI video", idempotencyKey: key() });

    // İlk işleyici yalnızca gönderimi yapıp "kapanır"
    const w1 = new Engine("veo-w1");
    for (let i = 0; i < 20; i++) {
      await w1.tick();
      await w1.waitInflight();
      if (veo.submits.length) break;
    }
    expect(veo.submits).toHaveLength(1);
    expect(veo.submits[0]).toMatchObject({ aspectRatio: "9:16", durationS: 6 });
    expect(veo.submits[0].image?.mimeType).toBe("image/jpeg"); // gerçek ürün fotoğrafı ilk kare
    const mid = (await listTasks(brandId, { projectId: project.id })).find((t) => t.kind === "render")!;
    expect(mid.status).toBe("ready");
    expect(mid.error).toMatch(/Sürüyor/);
    await w1.shutdown();

    // Yeni işleyici (yeniden başlatma) işi kaldığı yerden sorgular
    await drive(new Engine("veo-w2"));
    expect(veo.submits).toHaveLength(1);
    expect(veo.polls).toBe(3);
    const render = (await listTasks(brandId, { projectId: project.id })).find((t) => t.kind === "render")!;
    expect(render.status).toBe("completed");
    const job = await q1<any>(`SELECT * FROM provider_jobs WHERE task_id = $1`, [render.id]);
    expect(job.status).toBe("succeeded");
    expect(job.poll_count).toBe(3);
    const assets = await q<any>(`SELECT * FROM media_assets WHERE source_task_id = $1 ORDER BY kind`, [render.id]);
    expect(assets.map((a) => [a.kind, a.origin])).toEqual([["photo", "ai_generated"], ["video", "ai_generated"]]);
    expect(Number(job.cost_actual_usd)).toBeCloseTo(0.6);
  });

  it("sağlayıcı reddi kesin başarısızlıktır; yeniden gönderilmez", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    await upsertConnection("video_generation", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true });
    const veo = new FakeVeo(Buffer.alloc(0), 0, true);
    setVideoGeneratorOverride(veo);
    setTextModelOverride(new ScriptedModel(videoPlan, { video: genVideo() }));
    const { project } = await submitInstruction({ brandId, instruction: "AI video red", idempotencyKey: key() });
    await drive(new Engine("veo-w3"));
    const render = (await listTasks(brandId, { projectId: project.id })).find((t) => t.kind === "render")!;
    expect(render.status).toBe("failed");
    expect(render.error).toMatch(/content filtered/);
    expect(veo.submits).toHaveLength(1);
  });

  it("proje saniye sınırı aşılacaksa gönderim yapılmaz", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    await upsertConnection("video_generation", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true, maxVideoGenSeconds: 4 });
    const veo = new FakeVeo(Buffer.alloc(0));
    setVideoGeneratorOverride(veo);
    setTextModelOverride(new ScriptedModel(videoPlan, { video: genVideo() }));
    const { project } = await submitInstruction({ brandId, instruction: "AI video sınır", idempotencyKey: key() });
    await drive(new Engine("veo-w4"));
    const render = (await listTasks(brandId, { projectId: project.id })).find((t) => t.kind === "render")!;
    expect(render.status).toBe("waiting_connection");
    expect(render.error).toMatch(/AI video sınırı/);
    expect(veo.submits).toHaveLength(0);
  });

  it("gönderim sırasında yarıda kalan iş 'bilinmiyor' olur", async () => {
    const t = await q1<{ id: string; project_id: string }>(`SELECT id, project_id FROM tasks WHERE brand_id = $1 LIMIT 1`, [brandId]);
    await q(`INSERT INTO provider_jobs (brand_id, project_id, task_id, provider, kind, item_ref, idempotency_key, status, updated_at)
             VALUES ($1,$2,$3,'video_generation','video_generation','x',$4,'submitting', now() - interval '10 minutes')`, [brandId, t!.project_id, t!.id, key()]);
    expect(await reconcileStaleSubmissions()).toBeGreaterThanOrEqual(1);
    expect(await q1(`SELECT 1 FROM provider_jobs WHERE status = 'submitting' AND updated_at < now() - interval '5 minutes'`)).toBeNull();
  });
});

describe("ffmpeg kurgu", () => {
  it("geçiş, giriş/kapanış kartı, doldurma, altyazı ve kapak karesi; süre ve boyut doğrulanır", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-test-"));
    const a = path.join(dir, "a.mp4"), b = path.join(dir, "b.mp4");
    await fs.writeFile(a, await colorScenesVideo([{ color: "red", seconds: 3 }], { size: "1280x720" }));
    await fs.writeFile(b, await colorScenesVideo([{ color: "blue", seconds: 3 }], { size: "1280x720" }));
    const card = { bg: "#f5efe6", accent: "#7c2d12" };
    const r = await renderEdit({
      clips: [{ file: a, start: 0.5, duration: 2, sourceDuration: 3 }, { file: b, start: 0, duration: 2, sourceDuration: 3 }],
      format: "9:16", framing: "fill", transition: "fade",
      subtitles: [{ start: 0, end: 1.5, text: "Linen, made for summer" }], onScreenText: [{ start: 0.5, end: 2, text: "NEW" }],
      intro: { text: "New collection", ...card }, outro: { text: "Shop now", ...card },
    });
    const expected = timeline([2, 2, 2, 2], "fade").total; // kart + 2 çekim + kart, 3 geçiş
    expect(r.expectedDuration).toBeCloseTo(expected, 1);
    expect(r.probe.width).toBe(1080);
    expect(r.probe.height).toBe(1920);
    expect(r.probe.video_codec).toBe("h264");
    expect(Math.abs(r.probe.duration - expected)).toBeLessThan(0.5);
    const tf = path.join(dir, "out.mp4");
    await fs.writeFile(tf, r.video);
    expect((await probeVideo(tf)).has_audio).toBe(false);
    const thumb = await sharp(r.thumbnail).metadata();
    expect(thumb.format).toBe("jpeg");
    // fill: kenarlarda siyah bant yok (kırmızı çekim kareyi doldurur)
    const { data } = await sharp(r.thumbnail).extract({ left: 0, top: (thumb.height! >> 1), width: 4, height: 4 }).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(150);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("kesme (cut) ve sığdırma (fit) ile mevcut çekimlerden kurgu; platformda dosya + kapak oluşur", async () => {
    setTextModelOverride(new ScriptedModel(videoPlan, { video: { summary: "s", unknowns: [], videos: [{
      id: "ev", mode: "edit_existing", format: "4:5", duration_s: 4, selected_asset_ids: clipIds,
      script: [{ t_start: 0, t_end: 2, visual: "", voiceover: "", on_screen_text: "Red" }, { t_start: 1, t_end: 3, visual: "", voiceover: "", on_screen_text: "" }],
      subtitles: [{ start: 0, end: 2, text: "Hello" }], generation_prompt: "", music_note: "", transition: "cut", framing: "fit", intro_text: "", outro_text: "Thanks",
    }] } }));
    const { project } = await submitInstruction({ brandId, instruction: "Kurgu", idempotencyKey: key() });
    await drive(new Engine("edit-w1"));
    const render = (await listTasks(brandId, { projectId: project.id })).find((t) => t.kind === "render")!;
    expect(render.status).toBe("completed");
    const assets = await q<any>(`SELECT * FROM media_assets WHERE source_task_id = $1 ORDER BY kind`, [render.id]);
    expect(assets.map((x) => [x.kind, x.generation_method])).toEqual([["photo", "ffmpeg_thumbnail"], ["video", "ffmpeg_edit"]]);
    const video = assets.find((x) => x.kind === "video");
    expect([video.width, video.height]).toEqual([1080, 1350]);
    expect(Number(video.duration_s)).toBeCloseTo(6, 0); // 2 + 2 + 2 sn kapanış kartı
  });
});
