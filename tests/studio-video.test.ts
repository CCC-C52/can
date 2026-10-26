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
import { setVideoGeneratorOverride, type VideoGenerator, type VideoGenRequest } from "@/lib/adapters/video-generation";
import { photoMotionClip } from "@/lib/adapters/video-edit";
import { buildStudioInstruction, parseStudioRequest } from "@/lib/video/studio";
import { runRuleChecks } from "@/lib/agents/qa-rules";
import { buildBrandContext } from "@/lib/agents/context";
import { decide, getCurrentVersion, listOutputs } from "@/lib/services/outputs";
import { probeVideo } from "@/lib/media-analysis/video";
import { getStorage } from "@/lib/storage";
import { productPhoto, colorScenesVideo } from "./fixtures";
import { key } from "./helpers";

/** Sahte Gemini Omni: gönderimleri kaydeder; her sahne için 720x1280 sesli bir klip döndürür. */
class FakeOmni implements VideoGenerator {
  readonly service = "video_generation";
  readonly model = "gemini-omni-fake";
  submits: VideoGenRequest[] = [];
  constructor(private clip: Buffer, private runningPolls = 1) {}
  private polls = new Map<string, number>();
  estimateCostUsd(s: number) { return 0.05 * s; }
  async submit(req: VideoGenRequest) {
    this.submits.push(req);
    return { externalId: `v1_scene${this.submits.length}`, request: {} };
  }
  async poll(id: string) {
    const n = (this.polls.get(id) ?? 0) + 1;
    this.polls.set(id, n);
    return n <= this.runningPolls ? { state: "running" as const } : { state: "succeeded" as const, videoUri: `interaction:${id}` };
  }
  async download() { return this.clip; }
}

async function drive(engine: Engine, maxTicks = 120) {
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
let photoId: string;
let photoName: string;
let otherPhotoId: string;

beforeAll(async () => {
  const b = await createBrand({ name: "Studio Test (FriBee benzeri)", content_language: "en" });
  brandId = b.id;
  await q(`UPDATE brands SET colors = $2 WHERE id = $1`, [brandId, JSON.stringify([{ name: "orange", hex: "#f97316" }, { name: "bg", hex: "#111827" }])]);
  const p = await createProduct(brandId, { title: "Orange Anime Oversized T-Shirt", status: "active" });
  const up = await uploadMedia(brandId, { buffer: await productPhoto("#f97316"), filename: "orange-anime-tee.jpg" }, { productId: p.id });
  photoId = up.asset.id;
  photoName = up.asset.filename;
  const logo = await sharp({ create: { width: 300, height: 100, channels: 4, background: "#f97316" } }).png().toBuffer();
  await uploadMedia(brandId, { buffer: logo, filename: "Artboard 1.png" }, { kind: "logo" });
  const other = await createBrand({ name: "Studio Other Brand", content_language: "en" });
  otherPhotoId = (await uploadMedia(other.id, { buffer: await productPhoto("#16a34a"), filename: "other.jpg" })).asset.id;
});
afterEach(async () => {
  setTextModelOverride(null);
  setVideoGeneratorOverride(undefined);
  await setSetting("limits", {});
});
afterAll(() => { delete process.env.GEMINI_API_KEY; });

const studioInstruction = (mode: "ai" | "hybrid" | "archive", photos = [{ id: "", filename: "" }]) =>
  buildStudioInstruction({ mode, videos: [], photos, minSeconds: 12, maxSeconds: 15, platform: "Instagram Reels (9:16)", transition: "fade", aiScenes: 2, sceneSeconds: 6, goal: "Orange anime tee launch" });

describe("Video Stüdyosu talebi", () => {
  it("talimat → stüdyo talebi (mod, sahne sayısı/süresi, ürün fotoğrafı kimlikleri) geri okunur; arşiv modu Gemini istemez", () => {
    const text = studioInstruction("hybrid", [{ id: "11111111-2222-4333-8444-555555555555", filename: "tee [front].jpg" }]);
    expect(text).toMatch(/Gemini Omni ile 2 adet 6 saniyelik/);
    expect(text).not.toMatch(/Yalnızca bu gerçek çekimleri/);
    expect(parseStudioRequest(text)).toEqual({ mode: "hybrid", aiScenes: 2, sceneSeconds: 6, photoIds: ["11111111-2222-4333-8444-555555555555"], collection: null });
    const archive = buildStudioInstruction({ mode: "archive", videos: [{ id: "x", filename: "a.mp4" }], photos: [], minSeconds: 10, maxSeconds: 15, platform: "Reels", transition: "cut", aiScenes: 2, sceneSeconds: 6, goal: "" });
    expect(archive).toMatch(/Yalnızca bu gerçek çekimleri/);
    expect(parseStudioRequest(archive)).toMatchObject({ mode: "archive", aiScenes: 0 });
    expect(parseStudioRequest("Normal talimat")).toBeNull();
  });

  it("kalite kontrolü: AI modu seçildiği hâlde yalnızca arşiv kurgusu planlanırsa geçmez; uydurma AI sahnesine bağlanan parça reddedilir", async () => {
    const ctx = await buildBrandContext(brandId, undefined, { agent: "quality", includeAssetIds: [photoId] });
    const studio = { mode: "ai" as const, aiScenes: 2, sceneSeconds: 6, photoIds: [photoId] };
    const archiveOnly = { summary: "s", unknowns: [], videos: [] };
    const r1 = runRuleChecks("video", archiveOnly, ctx, { isDemo: false, studio });
    expect(r1.verdict).toBe("needs_changes");
    expect(r1.checks.find((c) => c.name === "Stüdyo talebi")?.status).toBe("fail");
    const base = { format: "9:16", script: [], subtitles: [], music_note: "", transition: "fade", framing: "fill", intro_text: "", segments: [], selected_asset_ids: [photoId] };
    const bad = { summary: "s", unknowns: [], videos: [
      { ...base, id: "scene-1", mode: "generate_new", duration_s: 6, generation_prompt: "Cinematic street shot", outro_text: "", parts: [] },
      { ...base, id: "ad", mode: "compose", duration_s: 9, generation_prompt: "", outro_text: "FriBee", parts: [
        { kind: "ai_scene", ref: "scene-9", duration_s: 6, motion: "none", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "" },
        { kind: "product_photo", ref: otherPhotoId, duration_s: 3, motion: "zoom_in", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "" },
      ] },
    ] };
    const r2 = runRuleChecks("video", bad, ctx, { isDemo: false, studio });
    expect(r2.verdict).toBe("needs_changes");
    expect(r2.checks.find((c) => c.name === "Reklam parçaları")?.detail).toMatch(/scene-9.*generate_new sahnesi değil.*parça 2: arşivde olmayan/s);
    const empty = { ...bad, videos: [{ ...bad.videos[0], generation_prompt: " " }, bad.videos[1]] };
    expect(runRuleChecks("video", empty, ctx, { isDemo: false, studio }).checks.find((c) => c.name === "AI sahne istemi")?.status).toBe("fail");
  });

  it("ürün fotoğrafı hareket klibi: hedef boyut, istenen süre, fotoğraf kırpılmaz", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-"));
    const photo = path.join(dir, "p.jpg");
    await fs.writeFile(photo, await productPhoto("#f97316"));
    for (const motion of ["zoom_in", "pan_left"] as const) {
      const out = path.join(dir, `${motion}.mp4`);
      const r = await photoMotionClip({ photo, out, format: "9:16", seconds: 2.5, motion, bg: "#111827" });
      expect(r.duration).toBeGreaterThan(2.3);
      expect(r.duration).toBeLessThan(2.7);
      const pr = await probeVideo(out);
      expect([pr.width, pr.height, pr.video_codec]).toEqual([1080, 1920, "h264"]);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("Video Stüdyosu → Gemini Omni → karma reklam MP4 (sahte sağlayıcı, gerçek ffmpeg)", () => {
  it("karma mod: 2 AI sahnesi ürün fotoğrafı referansıyla gönderilir; sahneler + hareketli ürün fotoğrafı + logo kapanışı tek MP4; onaylanabilir", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    await upsertConnection("video_generation", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true });
    const omni = new FakeOmni(await colorScenesVideo([{ color: "orange", seconds: 6 }], { audio: true }));
    setVideoGeneratorOverride(omni);
    const { project } = await submitInstruction({ brandId, instruction: studioInstruction("hybrid", [{ id: photoId, filename: photoName }]), idempotencyKey: key() });
    await drive(new Engine("studio-1"));

    // Plan: 2 AI sahnesi + 1 reklam kurgusu; kalite kontrolü stüdyo talebini doğruladı
    const tasks = await listTasks(brandId, { projectId: project.id });
    const videoTask = tasks.find((t) => t.agent === "video" && t.kind === "work")!;
    expect(videoTask).toBeTruthy();
    const plan = (await getCurrentVersion(brandId, videoTask.output_id!))!;
    const modes = plan.content.videos.map((v: any) => v.mode);
    expect(modes.filter((m: string) => m === "generate_new")).toHaveLength(2);
    expect(modes.filter((m: string) => m === "compose")).toHaveLength(1);
    expect(plan.qa_report.checks.find((c: any) => c.name === "Stüdyo talebi")?.status).toBe("pass");
    expect(plan.qa_report.verdict).toBe("pass");

    // Gemini'ye 2 gönderim; her biri gerçek ürün fotoğrafını referans alır (image_to_video)
    expect(omni.submits).toHaveLength(2);
    for (const s of omni.submits) {
      expect(s.durationS).toBe(6);
      expect(s.aspectRatio).toBe("9:16");
      expect(s.images?.map((i) => i.mimeType)).toEqual(["image/jpeg"]);
      expect(s.prompt.length).toBeGreaterThan(30);
    }

    const render = tasks.find((t) => t.kind === "render" && t.agent === "video")!;
    expect(render).toBeTruthy();
    const after = (await listTasks(brandId, { projectId: project.id })).find((t) => t.id === render.id)!;
    expect(after.status).toBe("completed");
    const ad = await q1<any>(`SELECT * FROM media_assets WHERE source_task_id = $1 AND kind = 'video' AND generation_method = 'ffmpeg_edit'`, [render.id]);
    expect(ad).toBeTruthy();
    expect(ad.tags.map((t: any) => t.tag)).toEqual(expect.arrayContaining(["AI sahne:2", "ürün fotoğrafı:1"]));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-"));
    const f = path.join(dir, "ad.mp4");
    await fs.writeFile(f, await getStorage().get(ad.storage_key));
    const pr = await probeVideo(f);
    await fs.rm(dir, { recursive: true, force: true });
    expect([pr.width, pr.height, pr.video_codec]).toEqual([1080, 1920, "h264"]);
    // 6 + 2,5 + 6 sn sahne/fotoğraf + 2 sn logo kapanışı − 3 geçiş × 0,5 sn ≈ 15 sn
    expect(pr.duration).toBeGreaterThan(13.5);
    expect(pr.duration).toBeLessThan(16.5);
    const job = await q<any>(`SELECT request, status FROM provider_jobs WHERE task_id = $1 ORDER BY created_at`, [render.id]);
    expect(job.map((j) => [j.status, j.request.mode])).toEqual([["succeeded", "image_to_video"], ["succeeded", "image_to_video"]]);
    // Referans orijinal netlikte gitti (yeniden kodlama yok); bayt kayda yazılmadı
    expect(job[0].request.reference_fidelity).toEqual([expect.objectContaining({ asset_id: photoId, transformed: "none", original_px: [1200, 1500], sent_px: [1200, 1500] })]);
    expect(JSON.stringify(job[0].request)).not.toMatch(/base64|\/9j\//);

    // MP4 doğrulandığı için plan onaylanabilir
    const out = (await listOutputs(brandId, { projectId: project.id })).find((o) => o.kind === "video_plan")!;
    const v = (await getCurrentVersion(brandId, out.id))!;
    expect((await decide(brandId, v.id, "approved")).decision).toBe("approved");
  });

  it("ücretli üretim izni yokken Gemini'ye hiçbir istek gitmez; reklam 'izin bekliyor' olarak kalır", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    await upsertConnection("video_generation", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: false });
    const omni = new FakeOmni(Buffer.alloc(0));
    setVideoGeneratorOverride(omni);
    const { project } = await submitInstruction({ brandId, instruction: studioInstruction("ai", [{ id: photoId, filename: photoName }]), idempotencyKey: key() });
    await drive(new Engine("studio-2"));
    const render = (await listTasks(brandId, { projectId: project.id })).find((t) => t.kind === "render" && t.agent === "video")!;
    expect(render.status).toBe("waiting_connection");
    expect(render.error).toMatch(/AI sahnesi "scene-1" henüz gönderilmedi/);
    expect(omni.submits).toHaveLength(0);
    expect(await q1(`SELECT 1 FROM provider_jobs WHERE task_id = $1`, [render.id])).toBeNull();
  });

  it("başka markanın fotoğraf kimliği stüdyo talebine konsa da referans olarak kullanılmaz", async () => {
    const { studioForProject } = await import("@/lib/orchestrator/engine");
    const { project } = await submitInstruction({ brandId, instruction: studioInstruction("ai", [{ id: otherPhotoId, filename: "other.jpg" }, { id: photoId, filename: photoName }]), idempotencyKey: key() });
    expect((await studioForProject(brandId, project.id))!.photoIds).toEqual([photoId]);
  });
});
