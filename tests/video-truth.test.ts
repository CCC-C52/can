import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { Engine, missingVideoDeliverables } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks } from "@/lib/orchestrator/projects";
import { createBrand } from "@/lib/services/brands";
import { uploadMedia } from "@/lib/services/media";
import { upsertConnection } from "@/lib/services/connections";
import { setSetting, DEFAULT_LIMITS } from "@/lib/settings";
import { setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "@/lib/models/types";
import { setVideoGeneratorOverride, type VideoGenerator, type VideoGenRequest } from "@/lib/adapters/video-generation";
import { confirmFribeeCollections } from "@/lib/knowledge/store";
import { verifiedCatalogPhotos } from "@/lib/drive/references";
import { buildStudioInstruction, parseStudioRequest } from "@/lib/video/studio";
import { addVersion, createOutput, decide, getCurrentVersion, listOutputs } from "@/lib/services/outputs";
import { probeVideo } from "@/lib/media-analysis/video";
import { getStorage } from "@/lib/storage";
import { colorScenesVideo } from "./fixtures";
import { key } from "./helpers";

// Kök neden (28 Ekim 2026 05:44:57 UTC, render 12 ms'de "başarılı"): video planında üretilecek video öğesi yokken
// (videos: []) render görevi hiçbir şey yapmadan "tamamlandı" sayılıyordu. Bu testler gerçek MP4 olmadan hiçbir video
// görevinin başarılı sayılmadığını ve hedef akışın (Space Alien, 4 × 8 sn gerçek AI sahnesi) gerçek MP4 ürettiğini doğrular.

/** Sahte Gemini: her gönderimi kaydeder; 8 sn'lik 720x1280 klip döndürür. Ücretsiz, ağ yok. */
class FakeGemini implements VideoGenerator {
  readonly service = "video_generation";
  readonly model = "gemini-omni-fake";
  submits: VideoGenRequest[] = [];
  constructor(private clip: Buffer, private perSecond: number | null = 0.05) {}
  estimateCostUsd(s: number) { return this.perSecond === null ? null : this.perSecond * s; }
  async submit(req: VideoGenRequest) {
    this.submits.push(req);
    return { externalId: `v1_${this.submits.length}`, request: {} };
  }
  async poll(id: string): ReturnType<VideoGenerator["poll"]> { return { state: "succeeded", videoUri: `interaction:${id}` }; }
  async download() { return this.clip; }
}

/** Video uzmanı yalnızca senaryo döndürür (videos: []); diğerleri demo. 28 Ekim olayının yeniden üretimi. */
class ScriptOnlyVideo implements TextModelAdapter {
  readonly id = "script-only";
  readonly isDemo = true;
  readonly service = "script-only";
  private demo = new DemoAdapter();
  estimateCostUsd() { return 0; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    if (req.agent === "video" && req.purpose === "work") {
      const data = req.schema.parse({ summary: "Space Alien senaryosu (yalnızca metin)", videos: [], unknowns: [] });
      return { data, generator: "scripted", isDemo: true, model: "scripted", usage: null, actualCostUsd: 0 };
    }
    return this.demo.generate(req);
  }
}

async function drive(engine: Engine, maxTicks = 150) {
  for (let i = 0; i < maxTicks; i++) {
    await q(`UPDATE tasks SET next_attempt_at = now() WHERE status = 'ready' AND next_attempt_at > now()`);
    const n = await engine.tick();
    await engine.waitInflight();
    const active = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE status IN ('planned','ready','review_pending','running')`);
    if (n === 0 && active!.n === 0) return;
  }
  throw new Error("Kuyruk boşalmadı");
}

let brandId: string;
let refFront: string;
let refBack: string;
let unverifiedPhoto: string;

beforeAll(async () => {
  brandId = (await createBrand({ name: `FriBee Video Truth ${Date.now()}`, content_language: "en" })).id;
  await q(`UPDATE brands SET colors = $2 WHERE id = $1`, [brandId, JSON.stringify([{ name: "black", hex: "#111111" }, { name: "accent", hex: "#7c3aed" }])]);
  await confirmFribeeCollections(brandId);
  const logo = await sharp({ create: { width: 300, height: 100, channels: 4, background: "#ffffff" } }).png().toBuffer();
  await uploadMedia(brandId, { buffer: logo, filename: "FriBee logo.png" }, { kind: "logo" });
  // Doğrulanmış Space Alien katalog fotoğrafları (Drive referansı, sahip doğrulaması, orijinal arşivde)
  const src = (await q1<{ id: string }>(`INSERT INTO drive_sources (brand_id, status, folder_id, folder_name) VALUES ($1,'active','rootFolderVT0001','FriBee Master Archive') RETURNING id`, [brandId]))!.id;
  const verified = async (name: string, view: string, shade: string) => {
    const buf = await sharp({ create: { width: 1600, height: 2000, channels: 3, background: shade } }).jpeg({ quality: 92 }).toBuffer();
    const { asset } = await uploadMedia(brandId, { buffer: buf, filename: name }, { kind: "photo", origin: "real_photo", vision: false });
    const item = (await q1<{ id: string }>(
      `INSERT INTO drive_items (brand_id, source_id, file_id, name, mime_type, path, image_width, image_height) VALUES ($1,$2,$3,$4,'image/jpeg',$5,1600,2000) RETURNING id`,
      [brandId, src, `f${Math.random().toString(36).slice(2, 14)}`, name, `FriBee Master Archive/Space Alien/${name}`],
    ))!.id;
    await q(`INSERT INTO drive_references (brand_id, item_id, theme, view, status, artwork_confirmed, media_asset_id, verified_by, verified_at) VALUES ($1,$2,'space_alien',$3,'verified',true,$4,'owner',now())`, [brandId, item, view, asset.id]);
    return asset.id;
  };
  refFront = await verified("space-alien-front.jpg", "front", "#111111");
  refBack = await verified("space-alien-back.jpg", "back", "#121212");
  unverifiedPhoto = (await uploadMedia(brandId, { buffer: await sharp({ create: { width: 1600, height: 2000, channels: 3, background: "#101010" } }).jpeg().toBuffer(), filename: "random-black-tee.jpg" }, { vision: false })).asset.id;
});

afterEach(async () => {
  setTextModelOverride(null);
  setVideoGeneratorOverride(undefined);
  delete process.env.GEMINI_API_KEY;
  await setSetting("limits", {});
});

describe("Kök neden: MP4 olmadan 'başarılı' video görevi", () => {
  it("teslim kontrolü: compose varsa compose, yoksa her AI sahnesi ve her kurgu gerçek MP4 ister", () => {
    const plan = { videos: [{ id: "s1", mode: "generate_new" }, { id: "s2", mode: "generate_new" }, { id: "ad", mode: "compose" }] };
    expect(missingVideoDeliverables(plan, [{ ref: "s1" }, { ref: "s2" }])).toEqual(["ad (compose)"]);
    expect(missingVideoDeliverables(plan, [{ ref: "ad" }])).toEqual([]);
    expect(missingVideoDeliverables({ videos: [{ id: "s1", mode: "generate_new" }] }, [])).toEqual(["s1 (generate_new)"]);
    expect(missingVideoDeliverables({ videos: [{ id: "e1", mode: "edit_existing" }] }, [{ ref: "e1" }])).toEqual([]);
  });

  it("yalnızca senaryo (videos: []) üreten video uzmanı: kalite kontrolünden geçmez, render açılmaz, görev 'başarısız' olur", async () => {
    setTextModelOverride(new ScriptOnlyVideo());
    const { project } = await submitInstruction({ brandId, instruction: "Space Alien siyah oversize tişört için 30 saniyelik video reklam hazırla", idempotencyKey: key() });
    await drive(new Engine("truth-1"));
    const tasks = await listTasks(brandId, { projectId: project.id });
    const video = tasks.find((t) => t.agent === "video" && t.kind === "work")!;
    expect(video.status).toBe("failed");
    expect(video.error).toMatch(/Kalite kontrolünden geçemedi/);
    expect(tasks.some((t) => t.agent === "video" && t.kind === "render")).toBe(false);
    const out = (await listOutputs(brandId, { projectId: project.id })).find((o) => o.kind === "video_plan")!;
    const v = (await getCurrentVersion(brandId, out.id))!;
    expect(v.qa_report.checks.find((c: any) => c.name === "Video dosyası")?.status).toBe("fail");
  });

  it("eski bir render görevi dosya üretmeyen sürüm için çalışırsa 'MP4 üretilmedi' hatasıyla başarısız olur (12 ms başarı yok)", async () => {
    const { project } = await submitInstruction({ brandId, instruction: "Kayıt testi", idempotencyKey: key() });
    await q(`UPDATE tasks SET status = 'cancelled' WHERE project_id = $1`, [project.id]);
    const out = await createOutput({ brandId, projectId: project.id, taskId: null, agent: "video", kind: "video_plan", title: "eski plan" });
    const ver = await addVersion({ brandId, outputId: out.id, content: { summary: "senaryo", videos: [], unknowns: [] }, createdBy: "agent:video", generator: "scripted", isDemo: true });
    const task = (await q1<{ id: string }>(
      `INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status, input_refs, output_id, max_attempts)
       VALUES ($1,$2,'legacy-render','video','render','Videoyu render et','eski','ready',$3,$4,3) RETURNING id`,
      [brandId, project.id, JSON.stringify({ version_id: ver.id }), out.id],
    ))!;
    await drive(new Engine("truth-2"));
    const t = (await q1<{ status: string; error: string }>(`SELECT status, error FROM tasks WHERE id = $1`, [task.id]))!;
    expect(t.status).toBe("failed");
    expect(t.error).toMatch(/MP4 üretilmedi/);
  });
});

describe("Hedef: Space Alien siyah oversize tişört — 4 × 8 sn gerçek Gemini sahnesi, en az 30 sn, fotoğraf hareketi yok", () => {
  const instruction = (photos: { id: string; filename: string }[]) => buildStudioInstruction({
    mode: "ai", videos: [], photos, minSeconds: 30, maxSeconds: 40, platform: "Instagram Reels (9:16)", transition: "fade",
    aiScenes: 4, sceneSeconds: 8, goal: "Cinematic ad for the FriBee Space Alien black oversized T-shirt: space, neon, smoke and particles.", collection: "space_alien", aiOnly: true,
  });

  it("stüdyo talebi: koleksiyon, yalnızca AI ve süre makinece okunur; doğrulanmış katalog fotoğrafları otomatik bulunur", async () => {
    const st = parseStudioRequest(instruction([{ id: refFront, filename: "space-alien-front.jpg" }]))!;
    expect(st).toMatchObject({ mode: "ai", aiScenes: 4, sceneSeconds: 8, collection: "space_alien", aiOnly: true, minSeconds: 30, maxSeconds: 40 });
    expect((await verifiedCatalogPhotos(brandId, "space_alien")).map((p) => p.media_asset_id)).toEqual([refFront, refBack]);
  });

  it("ücretli üretim maliyeti bilinmiyorsa Gemini'ye istek gitmez; günlük 20 $ sınırı süren işleri de sayar", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    await upsertConnection("video_generation", null, { status: "connected" });
    // 1) Birim fiyat yok + harcama sınırı etkin → hiçbir gönderim yok
    const unknown = new FakeGemini(await colorScenesVideo([{ color: "black", seconds: 8 }]), null);
    setVideoGeneratorOverride(unknown);
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true, maxVideoGenSeconds: 40, dailyBudgetUsd: 20, perTaskBudgetUsd: 20, blockUnknownCost: true });
    const a = await submitInstruction({ brandId, instruction: instruction([{ id: refFront, filename: "f" }, { id: refBack, filename: "b" }]), idempotencyKey: key() });
    await drive(new Engine("truth-3"));
    expect(unknown.submits).toHaveLength(0);
    const ra = (await listTasks(brandId, { projectId: a.project.id })).find((t) => t.kind === "render" && t.agent === "video")!;
    expect(ra.status).toBe("failed");
    expect(ra.error).toMatch(/maliyet tahmin edilemiyor/);

    // 2) Sahne başı 6 $ (0,75 $/sn × 8 sn): 20 $ günlük sınırda üç sahne gönderilir, dördüncü süren işler sayıldığı için durur
    const pricey = new FakeGemini(await colorScenesVideo([{ color: "black", seconds: 8 }]), 0.75);
    pricey.poll = async () => ({ state: "running" as const }) as Awaited<ReturnType<VideoGenerator["poll"]>>;
    setVideoGeneratorOverride(pricey);
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true, maxVideoGenSeconds: 40, dailyBudgetUsd: 20, perTaskBudgetUsd: null });
    const b = await submitInstruction({ brandId, instruction: instruction([{ id: refFront, filename: "f" }, { id: refBack, filename: "b" }]), idempotencyKey: key() });
    const engine = new Engine("truth-4");
    for (let i = 0; i < 40 && pricey.submits.length < 4; i++) {
      await q(`UPDATE tasks SET next_attempt_at = now() WHERE status = 'ready' AND next_attempt_at > now()`);
      await engine.tick();
      await engine.waitInflight();
      const rb = (await listTasks(brandId, { projectId: b.project.id })).find((t) => t.kind === "render" && t.agent === "video");
      if (rb && ["failed", "waiting_connection"].includes(rb.status)) break;
    }
    expect(pricey.submits).toHaveLength(3);
    const rb = (await listTasks(brandId, { projectId: b.project.id })).find((t) => t.kind === "render" && t.agent === "video")!;
    expect(rb.error ?? "").toMatch(/Günlük bütçe aşılacak/);
    await q(`UPDATE tasks SET status = 'cancelled' WHERE project_id = $1 AND status NOT IN ('completed','failed')`, [b.project.id]);
    await q(`UPDATE provider_jobs SET status = 'cancelled' WHERE project_id = $1`, [b.project.id]);
  });

  it("doğrulanmamış ürün görseli referans olamaz; ürün görseli olmadan yalnızca AI modu başlatılamaz", async () => {
    // Stüdyo eylemindeki kural, aynı veriyle: koleksiyon seçiliyken her fotoğraf o koleksiyonun doğrulanmış referansı olmalı
    const { verifiedThemesOf } = await import("@/lib/drive/references");
    const themes = await verifiedThemesOf(brandId, [refFront, unverifiedPhoto]);
    expect(themes.get(refFront)).toBe("space_alien");
    expect(themes.has(unverifiedPhoto)).toBe(false);
  });

  it("gerçek akış: 4 Gemini gönderimi (doğrulanmış ön/arka referans, 8 sn, 9:16) → yalnızca AI sahnelerinden ≥30 sn MP4, depoda, oynatılabilir, onaylanabilir", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    await upsertConnection("video_generation", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true, maxVideoGenSeconds: 40, dailyBudgetUsd: 20, perTaskBudgetUsd: 20 });
    const gemini = new FakeGemini(await colorScenesVideo([{ color: "black", seconds: 4 }, { color: "purple", seconds: 4 }], { audio: true }), 0.05);
    setVideoGeneratorOverride(gemini);
    const { project } = await submitInstruction({ brandId, instruction: instruction([{ id: refFront, filename: "space-alien-front.jpg" }, { id: refBack, filename: "space-alien-back.jpg" }]), idempotencyKey: key() });
    await drive(new Engine("truth-5"));

    expect(gemini.submits).toHaveLength(4);
    for (const s of gemini.submits) {
      expect([s.durationS, s.aspectRatio]).toEqual([8, "9:16"]);
      expect(s.images).toHaveLength(2);
    }
    const tasks = await listTasks(brandId, { projectId: project.id });
    const work = tasks.find((t) => t.agent === "video" && t.kind === "work")!;
    const plan = (await getCurrentVersion(brandId, work.output_id!))!;
    const compose = plan.content.videos.find((v: any) => v.mode === "compose");
    expect(compose.parts.map((p: any) => p.kind)).toEqual(["ai_scene", "ai_scene", "ai_scene", "ai_scene"]);
    expect(plan.qa_report.checks.filter((c: any) => c.status === "fail")).toEqual([]);

    const render = tasks.find((t) => t.agent === "video" && t.kind === "render")!;
    expect(render.status).toBe("completed");
    const ad = (await q1<any>(`SELECT * FROM media_assets WHERE source_task_id = $1 AND generation_method = 'ffmpeg_edit' AND kind = 'video'`, [render.id]))!;
    expect(await getStorage().exists(ad.storage_key)).toBe(true);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "truth-"));
    const f = path.join(dir, "ad.mp4");
    await fs.writeFile(f, await getStorage().get(ad.storage_key));
    const pr = await probeVideo(f);
    await fs.rm(dir, { recursive: true, force: true });
    expect([pr.width, pr.height, pr.video_codec]).toEqual([1080, 1920, "h264"]);
    // 4 × 8 sn + 3 sn kapanış − 4 geçiş × 0,5 sn ≈ 33 sn
    expect(pr.duration).toBeGreaterThanOrEqual(30);
    const jobs = await q<{ status: string; request: any }>(`SELECT status, request FROM provider_jobs WHERE project_id = $1 ORDER BY created_at`, [project.id]);
    expect(jobs.map((j) => [j.status, j.request.mode, j.request.parameters.durationSeconds])).toEqual(Array(4).fill(["succeeded", "reference_to_video", 8]));
    const out = (await listOutputs(brandId, { projectId: project.id })).find((o) => o.kind === "video_plan")!;
    const v = (await getCurrentVersion(brandId, out.id))!;
    expect((await decide(brandId, v.id, "approved")).decision).toBe("approved");
  });

  it("plan fotoğraf hareketi veya 30 sn altı süre içerirse kalite kontrolünden geçmez", async () => {
    const { runRuleChecks } = await import("@/lib/agents/qa-rules");
    const { buildBrandContext } = await import("@/lib/agents/context");
    const ctx = await buildBrandContext(brandId, undefined, { agent: "video", includeAssetIds: [refFront] });
    const studio = parseStudioRequest(instruction([{ id: refFront, filename: "f" }]))!;
    const scene = (id: string, d: number) => ({ id, mode: "generate_new", format: "9:16", duration_s: d, selected_asset_ids: [refFront], generation_prompt: "Model in a black tee under neon stars, slow dolly-in.", script: [], subtitles: [], segments: [], parts: [], title: id, music_note: "" });
    const plan = (parts: any[], d = 8) => ({ summary: "s", unknowns: [], videos: [scene("s1", d), scene("s2", d), { id: "ad", mode: "compose", format: "9:16", duration_s: 30, selected_asset_ids: [], generation_prompt: "", script: [], subtitles: [], segments: [], title: "ad", music_note: "", transition: "fade", framing: "fill", outro_text: "FriBee", parts }] });
    const ai = (ref: string, d = 8) => ({ kind: "ai_scene", ref, duration_s: d, on_screen_text: "" });
    const names = (c: any) => runRuleChecks("video", c, ctx, { isDemo: true, studio }).checks.filter((x) => x.status === "fail").map((x) => x.name);
    expect(names(plan([ai("s1"), { kind: "product_photo", ref: refFront, duration_s: 3, motion: "zoom_in", on_screen_text: "" }, ai("s2")]))).toContain("Yalnızca AI video");
    expect(names(plan([ai("s1", 6), ai("s2", 6)], 6))).toContain("Reklam süresi");
  });
});
