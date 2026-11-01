import { describe, it, expect, beforeAll, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { Engine } from "@/lib/orchestrator/engine";
import { retryTask, submitInstruction } from "@/lib/orchestrator/projects";
import { createBrand } from "@/lib/services/brands";
import { listMedia, uploadMedia } from "@/lib/services/media";
import { upsertConnection } from "@/lib/services/connections";
import { addVersion, createOutput } from "@/lib/services/outputs";
import { releaseJob } from "@/lib/services/provider-jobs";
import { DEFAULT_LIMITS, getLimits, setSetting } from "@/lib/settings";
import { setVideoGeneratorOverride, type VideoGenerator, type VideoGenRequest, type VideoGenPoll } from "@/lib/adapters/video-generation";
import { UncertainOutcomeError } from "@/lib/adapters/http";
import { selectVideoProvider, setRunwayGeneratorOverride, videoProviderStatus } from "@/lib/video/providers";
import { approveProduction, estimatePlanCost, PRODUCTION_DIRECTIVE } from "@/lib/video/production";
import { buildStudioInstruction } from "@/lib/video/studio";
import { listTasks } from "@/lib/orchestrator/projects";
import { probeVideo } from "@/lib/media-analysis/video";
import { getStorage } from "@/lib/storage";
import { colorScenesVideo } from "./fixtures";
import { key } from "./helpers";

// Runway birincil, Gemini ikincil AI video hattı — gerçek render motoru, gerçek ffmpeg/ffprobe, gerçek veritabanı ve
// depolama; yalnızca sağlayıcılar sahtedir (ağ ve ücret yok). Fiyatlar TEST DEĞERİDİR.

class FakeProvider implements VideoGenerator {
  submits: VideoGenRequest[] = [];
  polls = 0;
  constructor(
    readonly service: "runway" | "video_generation",
    private clip: Buffer,
    private opts: { usdPerSecond?: number | null; runningPolls?: number; outcome?: "succeeded" | "failed"; submitError?: Error; providerEstimateUsd?: number | null; costUsd?: number } = {},
  ) {}
  get model() { return this.service === "runway" ? "gen4.5" : "gemini-omni-fake"; }
  estimateCostUsd(s: number) { return this.opts.usdPerSecond === null ? null : Math.round((this.opts.usdPerSecond ?? 0.1) * s * 1e6) / 1e6; }
  async submit(req: VideoGenRequest) {
    this.submits.push(req);
    if (this.opts.submitError) throw this.opts.submitError;
    return { externalId: `${this.service}_${this.submits.length}_${crypto.randomBytes(3).toString("hex")}`, request: { provider_estimate_usd: this.opts.providerEstimateUsd ?? null } };
  }
  async poll(id: string): Promise<VideoGenPoll> {
    this.polls++;
    if (this.polls <= (this.opts.runningPolls ?? 1)) return { state: "running", progress: 0.5 };
    if (this.opts.outcome === "failed") return { state: "failed", error: "Runway üretimi başarısız (SAFETY.INPUT.IMAGE): rejected", filtered: true, ...(this.service === "runway" ? { costUsd: 0, credits: 0 } : {}) };
    return { state: "succeeded", videoUri: `${this.service}:${id}`, ...(this.service === "runway" ? { costUsd: this.opts.costUsd ?? 0.48, credits: 48 } : {}) };
  }
  async download() { return this.clip; }
}

let brandId: string;
let photoId: string;
let clips: Buffer[] = [];
let clipIndex = 0;
/** Her sahne farklı bayt (sha256 ile arşivde yeniden kullanılmasın). */
const nextClip = () => clips[clipIndex++ % clips.length];

const scene = (id: string, over: Record<string, unknown> = {}) => ({
  id, mode: "generate_new", format: "9:16", duration_s: 6, selected_asset_ids: [photoId], script: [], subtitles: [],
  generation_prompt: "Slow dolly-in on a model wearing the black FRIBEE oversized tee, neon rim light, smoke.", music_note: "", transition: "cut",
  framing: "fill", intro_text: "", outro_text: "", segments: [], parts: [], ...over,
});

/** Proje + video planı sürümü + render görevi (planlama/QA atlanır; render motoru gerçek). */
async function renderTask(content: any, opts: { instruction?: string; productionApproval?: boolean } = {}) {
  const { project } = await submitInstruction({ brandId, instruction: opts.instruction ?? `Runway testi ${key()}`, idempotencyKey: key() });
  await q(`UPDATE tasks SET status = 'cancelled' WHERE project_id = $1`, [project.id]);
  const out = await createOutput({ brandId, projectId: project.id, taskId: null, agent: "video", kind: "video_plan", title: "Runway planı" });
  const ver = await addVersion({ brandId, outputId: out.id, content: { summary: "s", unknowns: [], ...content }, createdBy: "agent:video", generator: "scripted", isDemo: false });
  const refs = { version_id: ver.id, ...(opts.productionApproval ? { production_approval: { required: true } } : {}) };
  const t = (await q1<{ id: string }>(
    `INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status, input_refs, output_id, max_attempts)
     VALUES ($1,$2,$3,'video','render','Videoyu render et','r','ready',$4,$5,3) RETURNING id`,
    [brandId, project.id, `render-${key()}`, JSON.stringify(refs), out.id],
  ))!;
  return { projectId: project.id, taskId: t.id, versionId: ver.id };
}

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
const taskRow = (id: string) => q1<{ status: string; error: string | null; input_refs: any }>(`SELECT status, error, input_refs FROM tasks WHERE id = $1`, [id]).then((r) => r!);
const jobsOf = (projectId: string) => q<any>(`SELECT * FROM provider_jobs WHERE project_id = $1 ORDER BY created_at`, [projectId]);

beforeAll(async () => {
  brandId = (await createBrand({ name: `Runway Hattı ${Date.now()}`, content_language: "en" })).id;
  const photo = await sharp({ create: { width: 1600, height: 2000, channels: 3, background: "#151515" } }).jpeg({ quality: 92 }).toBuffer();
  photoId = (await uploadMedia(brandId, { buffer: photo, filename: "black-tee-front.jpg" }, { kind: "photo", origin: "real_photo", rightsStatus: "owned", vision: false })).asset.id;
  clips = await Promise.all(["purple", "navy", "maroon", "teal", "olive", "gray"].map((c) => colorScenesVideo([{ color: c, seconds: 6 }], { size: "720x1280", audio: true })));
}, 120_000);

afterEach(async () => {
  setRunwayGeneratorOverride(undefined);
  setVideoGeneratorOverride(undefined);
  delete process.env.GEMINI_API_KEY;
  delete process.env.RUNWAYML_API_SECRET;
  await setSetting("limits", {});
});

async function allowPaid(extra: Record<string, unknown> = {}) {
  await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true, maxVideoGenSeconds: 60, dailyBudgetUsd: 20, perTaskBudgetUsd: 20, ...extra });
}
async function geminiReady(gen: VideoGenerator | null) {
  process.env.GEMINI_API_KEY = "test-key";
  await upsertConnection("video_generation", null, { status: "connected" });
  setVideoGeneratorOverride(gen);
}

describe("Sağlayıcı seçimi", () => {
  it("gerçek yapılandırma: anahtar yok → Runway hazır değil; Entegrasyon anahtarı test edilmemişse hazır değil; fiyat yoksa hazır değil; hepsi tamamsa hazır", async () => {
    const lim = { ...DEFAULT_LIMITS };
    let [rw] = await videoProviderStatus(brandId, lim);
    expect(rw).toMatchObject({ id: "runway", role: "primary", ready: false, keyConfigured: false, reason: expect.stringMatching(/anahtarı yok/) });

    await upsertConnection("runway", brandId, { status: "not_connected", credentials: { apiKey: "rw-key" } });
    [rw] = await videoProviderStatus(brandId, lim);
    expect(rw).toMatchObject({ keyConfigured: true, connected: false, ready: false, reason: expect.stringMatching(/test et/) });

    await upsertConnection("runway", brandId, { status: "connected" });
    [rw] = await videoProviderStatus(brandId, lim);
    expect(rw).toMatchObject({ connected: true, priced: false, ready: false, keySource: "integration", reason: expect.stringMatching(/fiyatı girilmedi/) });
    expect(rw.gen!.estimateCostUsd(5)).toBeNull();

    [rw] = await videoProviderStatus(brandId, { ...lim, runwayCreditsPerSecond: 12, runwayUsdPerCredit: 0.01 });
    expect(rw).toMatchObject({ ready: true, priced: true, model: "gen4.5", usdPerSecond: 0.12 });
    expect(JSON.stringify({ ...rw, gen: undefined })).not.toMatch(/rw-key/);
    await upsertConnection("runway", brandId, { status: "not_connected", credentials: null });

    process.env.RUNWAYML_API_SECRET = "env-key";
    [rw] = await videoProviderStatus(brandId, { ...lim, runwayCreditsPerSecond: 12, runwayUsdPerCredit: 0.01 });
    expect(rw).toMatchObject({ ready: true, keySource: "env" });
  });

  it("birincil Runway hazırsa seçilir; değilse gönderimden önce Gemini (yedek gerekçesi kaydedilir); Ayarlar'da birincil Gemini yapılabilir", async () => {
    await geminiReady(new FakeProvider("video_generation", nextClip()));
    setRunwayGeneratorOverride(new FakeProvider("runway", nextClip()));
    let pick = await selectVideoProvider(brandId, DEFAULT_LIMITS, { seconds: 6 });
    expect(pick).toMatchObject({ ok: true, choice: { selected: "runway", primary: "runway" } });

    setRunwayGeneratorOverride(new FakeProvider("runway", nextClip(), { usdPerSecond: null }));
    pick = await selectVideoProvider(brandId, DEFAULT_LIMITS, { seconds: 6 });
    expect(pick).toMatchObject({ ok: true, choice: { selected: "gemini", primary: "runway", fallback_from: { id: "runway", reason: expect.stringMatching(/fiyat/) } } });

    setRunwayGeneratorOverride(new FakeProvider("runway", nextClip()));
    pick = await selectVideoProvider(brandId, { ...DEFAULT_LIMITS, videoPrimaryProvider: "gemini" }, { seconds: 6 });
    expect(pick).toMatchObject({ ok: true, choice: { selected: "gemini", primary: "gemini" } });

    // Sahibin seçtiği sağlayıcı hazır değilse başka sağlayıcıya geçilmez
    setVideoGeneratorOverride(null);
    pick = await selectVideoProvider(brandId, DEFAULT_LIMITS, { seconds: 6, ownerChoice: "gemini" });
    expect(pick).toMatchObject({ ok: false, reason: expect.stringMatching(/sahibin seçtiği/i) });
  });
});

describe("Runway birincil AI video hattı", () => {
  it("sahne Runway'e gider (Gemini'ye istek yok); sorgu → indirme → MP4 doğrulama → medya arşivi; gerçek kredi ücreti ayrı 'runway' kaydı", async () => {
    await allowPaid();
    const runway = new FakeProvider("runway", nextClip(), { runningPolls: 2, costUsd: 0.48 });
    const gemini = new FakeProvider("video_generation", nextClip());
    setRunwayGeneratorOverride(runway);
    await geminiReady(gemini);
    const { projectId, taskId } = await renderTask({ videos: [scene("s1")] });
    await drive(new Engine("rw-main"));

    expect((await taskRow(taskId)).status).toBe("completed");
    expect(runway.submits).toHaveLength(1);
    expect(gemini.submits).toHaveLength(0);
    expect(runway.submits[0]).toMatchObject({ durationS: 6, aspectRatio: "9:16" });
    expect(runway.submits[0].images).toHaveLength(1); // Runway: gerçek ürün fotoğrafı ilk kare
    const [job] = await jobsOf(projectId);
    expect(job).toMatchObject({ provider: "runway", status: "succeeded", request: { provider: "runway", model: "gen4.5", provider_choice: { selected: "runway", primary: "runway" }, parameters: { durationSeconds: 6 } } });
    expect(Number(job.cost_estimated_usd)).toBeCloseTo(0.6);
    expect(Number(job.cost_actual_usd)).toBeCloseTo(0.48); // sağlayıcının bildirdiği gerçek ücret
    const costs = await q<{ service: string; kind: string; amount_usd: string }>(`SELECT service, kind, amount_usd FROM cost_entries WHERE provider_job_id = $1 ORDER BY created_at`, [job.id]);
    expect(costs.map((c) => [c.service, c.kind, Number(c.amount_usd)])).toEqual([["runway", "estimated", 0.6], ["runway", "actual", 0.48]]);

    // Medya arşivi: oynatılabilir MP4 + kapak karesi; sağlayıcı etiketi
    const asset = (await q1<any>(`SELECT * FROM media_assets WHERE id = $1`, [job.result_asset_id]))!;
    expect(asset).toMatchObject({ kind: "video", mime_type: "video/mp4", origin: "ai_generated", generation_method: "ai_video:gen4.5" });
    expect(asset.tags.map((t: any) => t.tag)).toEqual(expect.arrayContaining(["ref:s1", "sağlayıcı:Runway"]));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rw-"));
    const f = path.join(dir, "a.mp4");
    await fs.writeFile(f, await getStorage().get(asset.storage_key));
    const pr = await probeVideo(f);
    expect([pr.video_codec, pr.width, pr.height]).toEqual(["h264", 720, 1280]);
    await fs.rm(dir, { recursive: true, force: true });
    const library = await listMedia(brandId, { kind: "video" });
    expect(library.map((m) => m.id)).toContain(asset.id);
    // Önizleme: AI sahnesinin kapak karesi (oynatıcı posteri) arşivde ve sahneye bağlı
    expect(await q1(`SELECT 1 FROM media_lineage l JOIN media_assets m ON m.id = l.derived_asset_id WHERE l.source_asset_id = $1 AND m.kind = 'photo'`, [asset.id])).toBeTruthy();
  }, 120_000);

  it("Runway başarısız → Gemini'ye OTOMATİK gönderim yok; sahip 'Gemini ile yeniden gönder' derse yalnızca o sahne Gemini'ye gider", async () => {
    await allowPaid();
    const runway = new FakeProvider("runway", nextClip(), { outcome: "failed" });
    const gemini = new FakeProvider("video_generation", nextClip());
    setRunwayGeneratorOverride(runway);
    await geminiReady(gemini);
    const { projectId, taskId } = await renderTask({ videos: [scene("s1")] });
    await drive(new Engine("rw-fail"));
    let t = await taskRow(taskId);
    expect(t.status).toBe("failed");
    expect(t.error).toMatch(/SAFETY\.INPUT\.IMAGE/);
    expect(runway.submits).toHaveLength(1);
    expect(gemini.submits).toHaveLength(0);
    let [job] = await jobsOf(projectId);
    expect(job).toMatchObject({ provider: "runway", status: "failed" });
    expect(Number(job.cost_actual_usd)).toBe(0); // Runway'in bildirdiği ücret (iade) kaydedildi

    // Tekrar denemek (sahip kararı olmadan) ikinci ücretli gönderim yapmaz
    await retryTask(brandId, taskId);
    await drive(new Engine("rw-fail-2"));
    expect(runway.submits).toHaveLength(1);
    expect(gemini.submits).toHaveLength(0);

    // Sahip kararı: Gemini ile yeniden gönder
    expect(await releaseJob(brandId, job.id, { retryProvider: "gemini" })).toBeTruthy();
    await retryTask(brandId, taskId);
    await drive(new Engine("rw-fail-3"));
    t = await taskRow(taskId);
    expect(t.status).toBe("completed");
    expect(gemini.submits).toHaveLength(1);
    expect(runway.submits).toHaveLength(1);
    const jobs = await jobsOf(projectId);
    expect(jobs.map((j: any) => [j.provider, j.status])).toEqual([["runway", "failed"], ["video_generation", "succeeded"]]);
    expect(jobs[1].request.provider_choice).toMatchObject({ selected: "gemini", owner_choice: "gemini" });
    [job] = jobs;
    expect(job.response.owner_retry_provider).toBe("gemini");
  }, 120_000);

  it("Runway gönderimi belirsiz (ağ/5xx) → iş 'unknown'; Runway'e de Gemini'ye de ikinci gönderim yapılmaz", async () => {
    await allowPaid();
    const runway = new FakeProvider("runway", nextClip(), { submitError: new UncertainOutcomeError("İstek sonucu belirsiz: AbortError") });
    const gemini = new FakeProvider("video_generation", nextClip());
    setRunwayGeneratorOverride(runway);
    await geminiReady(gemini);
    const { projectId, taskId } = await renderTask({ videos: [scene("s1")] });
    await drive(new Engine("rw-unc"));
    expect((await taskRow(taskId))).toMatchObject({ status: "failed", error: expect.stringMatching(/Sonucu belirsiz ücretli işlem/) });
    await retryTask(brandId, taskId);
    await drive(new Engine("rw-unc-2"));
    expect(runway.submits).toHaveLength(1);
    expect(gemini.submits).toHaveLength(0);
    const jobs = await jobsOf(projectId);
    expect(jobs.map((j: any) => [j.provider, j.status])).toEqual([["runway", "unknown"]]);
    const c = await q1<{ amount_usd: string | null }>(`SELECT amount_usd FROM cost_entries WHERE provider_job_id = $1 AND kind = 'actual'`, [jobs[0].id]);
    expect(c!.amount_usd).toBeNull(); // ücret bilinmiyor olarak kayıtlı
  }, 120_000);

  it("işleyici yeniden başlarsa gönderilmiş Runway işi yalnızca sorgulanır (ikinci gönderim yok)", async () => {
    await allowPaid();
    const runway = new FakeProvider("runway", nextClip(), { runningPolls: 3 });
    setRunwayGeneratorOverride(runway);
    await geminiReady(null);
    const { projectId, taskId } = await renderTask({ videos: [scene("s1")] });
    const first = new Engine("rw-before-restart");
    await first.tick();
    await first.waitInflight();
    expect((await jobsOf(projectId))[0]).toMatchObject({ provider: "runway", status: "submitted" });
    // "Yeni süreç": farklı işleyici, aynı veritabanı
    await drive(new Engine("rw-after-restart"));
    expect((await taskRow(taskId)).status).toBe("completed");
    expect(runway.submits).toHaveLength(1);
    expect(runway.polls).toBeGreaterThanOrEqual(4);
  }, 120_000);

  it("bütçe: Runway tahmini günlük bütçeyi aşarsa gönderim yapılmaz; iki sağlayıcının da fiyatı yoksa hiçbir istek gitmez", async () => {
    await allowPaid({ dailyBudgetUsd: 0.1 });
    const runway = new FakeProvider("runway", nextClip());
    setRunwayGeneratorOverride(runway);
    await geminiReady(null);
    const a = await renderTask({ videos: [scene("s1")] });
    await drive(new Engine("rw-budget"));
    expect((await taskRow(a.taskId))).toMatchObject({ status: "failed", error: expect.stringMatching(/Bütçe sınırı: Günlük bütçe aşılacak/) });
    expect(runway.submits).toHaveLength(0);
    expect(await jobsOf(a.projectId)).toEqual([]);

    await allowPaid();
    const unpricedRunway = new FakeProvider("runway", nextClip(), { usdPerSecond: null });
    const unpricedGemini = new FakeProvider("video_generation", nextClip(), { usdPerSecond: null });
    setRunwayGeneratorOverride(unpricedRunway);
    await geminiReady(unpricedGemini);
    const b = await renderTask({ videos: [scene("s1")] });
    await drive(new Engine("rw-unpriced"));
    expect((await taskRow(b.taskId))).toMatchObject({ status: "waiting_connection", error: expect.stringMatching(/fiyat/) });
    expect(unpricedRunway.submits.length + unpricedGemini.submits.length).toBe(0);
  }, 120_000);

  it("Runway'in kendi üst sınır tahmini bizimkinden yüksekse taahhüt edilen harcama büyütülür (bütçe hesabı doğru kalır)", async () => {
    await allowPaid();
    const runway = new FakeProvider("runway", nextClip(), { providerEstimateUsd: 1.5, runningPolls: 50 });
    setRunwayGeneratorOverride(runway);
    await geminiReady(null);
    const { projectId } = await renderTask({ videos: [scene("s1")] });
    const e = new Engine("rw-estimate");
    await e.tick();
    await e.waitInflight();
    const [job] = await jobsOf(projectId);
    expect(Number(job.cost_estimated_usd)).toBeCloseTo(1.5);
    expect(job.response.submit.provider_estimate_usd).toBe(1.5);
    await q(`UPDATE tasks SET status = 'cancelled' WHERE project_id = $1`, [projectId]);
  }, 60_000);
});

describe("Sahip üretim onayı (PR Ajansı kampanyası)", () => {
  it("onaysız hiçbir ücretli istek gitmez; tahmin sahne başına gösterilir; onaydan sonra Runway'e gider; onay plan sürümüne bağlıdır", async () => {
    await allowPaid();
    const runway = new FakeProvider("runway", nextClip());
    setRunwayGeneratorOverride(runway);
    await geminiReady(null);
    const content = { videos: [scene("s1"), scene("s2", { duration_s: 5 })] };
    const { taskId, versionId } = await renderTask(content, { instruction: `PR kampanyası\n${PRODUCTION_DIRECTIVE}`, productionApproval: true });
    await drive(new Engine("rw-gate"));
    expect((await taskRow(taskId))).toMatchObject({ status: "waiting_connection", error: expect.stringMatching(/Sahip üretim onayı bekleniyor/) });
    expect(runway.submits).toHaveLength(0);

    const est = await estimatePlanCost(brandId, content, await getLimits());
    expect(est.scenes.map((s) => [s.ref, s.provider, s.seconds, s.usd])).toEqual([["s1", "runway", 6, 0.6], ["s2", "runway", 5, 0.5]]);
    expect(est.totalUsd).toBeCloseTo(1.1);

    const appr = await approveProduction(brandId, taskId, "user");
    expect(appr).toMatchObject({ version_id: versionId, estimate_usd: 1.1 });
    expect(await q1(`SELECT 1 FROM audit_log WHERE brand_id = $1 AND action = 'video.production_approved'`, [brandId])).toBeTruthy();
    await drive(new Engine("rw-gate-2"));
    expect((await taskRow(taskId)).status).toBe("completed");
    expect(runway.submits).toHaveLength(2);
  }, 120_000);

  it("uçtan uca PR kampanyası: talimattaki 'Üretim onayı: gerekli' → plan + kalite kontrolü, render ücretli istek göndermeden bekler; onay → Runway sahneleri → MP4", async () => {
    await allowPaid();
    const runway = new FakeProvider("runway", nextClip());
    setRunwayGeneratorOverride(runway);
    await geminiReady(null);
    const studio = buildStudioInstruction({ mode: "hybrid", videos: [], photos: [{ id: photoId, filename: "black-tee-front.jpg" }], minSeconds: 12, maxSeconds: 18, platform: "Instagram Reels (9:16)", transition: "fade", aiScenes: 2, sceneSeconds: 5, goal: "Rebirth PR kampanyası" });
    const { project } = await submitInstruction({ brandId, instruction: `PR Ajansı video kampanyası önerisi: Rebirth\n${studio}\n${PRODUCTION_DIRECTIVE}`, idempotencyKey: key() });
    await drive(new Engine("rw-pr-1"));
    let render = (await listTasks(brandId, { projectId: project.id })).find((t) => t.agent === "video" && t.kind === "render")!;
    expect(render).toBeTruthy();
    expect(render.input_refs.production_approval).toMatchObject({ required: true });
    expect(render.status).toBe("waiting_connection");
    expect(render.error).toMatch(/Sahip üretim onayı bekleniyor/);
    expect(runway.submits).toHaveLength(0);

    await approveProduction(brandId, render.id);
    await drive(new Engine("rw-pr-2"));
    render = (await listTasks(brandId, { projectId: project.id })).find((t) => t.id === render.id)!;
    expect(render.status).toBe("completed");
    expect(runway.submits).toHaveLength(2);
    const ad = await q1<{ id: string }>(`SELECT id FROM media_assets WHERE source_task_id = $1 AND kind = 'video' AND generation_method = 'ffmpeg_edit'`, [render.id]);
    expect(ad).toBeTruthy();
  }, 400_000);

  it("fiyatı bilinmeyen üretim onaylanamaz", async () => {
    await allowPaid();
    setRunwayGeneratorOverride(new FakeProvider("runway", nextClip(), { usdPerSecond: null }));
    await geminiReady(null);
    const { taskId } = await renderTask({ videos: [scene("s1")] }, { productionApproval: true });
    await expect(approveProduction(brandId, taskId)).rejects.toThrow(/fiyat|hazır değil/i);
    await q(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [taskId]);
  });
});

describe("Teslim doğruluğu", () => {
  it("yalnızca fotoğraflardan oluşan 'reklam' (slayt gösterisi) video olarak teslim edilmez", async () => {
    await allowPaid();
    setRunwayGeneratorOverride(new FakeProvider("runway", nextClip()));
    await geminiReady(null);
    const { taskId } = await renderTask({ videos: [{ ...scene("ad"), mode: "compose", duration_s: 12, selected_asset_ids: [], generation_prompt: "", parts: [
      { kind: "product_photo", ref: photoId, duration_s: 4, motion: "zoom_in", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "Rebirth" },
      { kind: "product_photo", ref: photoId, duration_s: 4, motion: "pan_left", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "" },
    ] }] });
    await drive(new Engine("rw-slideshow"));
    expect((await taskRow(taskId))).toMatchObject({ status: "failed", error: expect.stringMatching(/slayt gösterisi video olarak teslim edilmez/) });
  }, 60_000);

  it("Runway sahneleri + gerçek ürün fotoğrafı → tek, doğrulanmış H.264 MP4 reklam (ffmpeg kurgusu)", async () => {
    await allowPaid();
    const runway = new FakeProvider("runway", nextClip());
    setRunwayGeneratorOverride(runway);
    await geminiReady(null);
    const { taskId } = await renderTask({ videos: [
      scene("a1"), scene("a2"),
      { ...scene("ad"), mode: "compose", duration_s: 16, selected_asset_ids: [], generation_prompt: "", transition: "fade", outro_text: "FriBee", parts: [
        { kind: "ai_scene", ref: "a1", duration_s: 6, motion: "none", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "Rebirth" },
        { kind: "product_photo", ref: photoId, duration_s: 2.5, motion: "zoom_in", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "" },
        { kind: "ai_scene", ref: "a2", duration_s: 6, motion: "none", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "" },
      ] },
    ] });
    await drive(new Engine("rw-compose"));
    const t = await taskRow(taskId);
    expect(t.status).toBe("completed");
    expect(runway.submits).toHaveLength(2);
    const ad = t.input_refs.result.artifacts.find((a: any) => a.ref === "ad");
    expect(ad).toMatchObject({ codec: "h264", storage_verified: true, ai_scenes: 2, product_photos: 1 });
    expect(ad.duration_s).toBeGreaterThan(12);
  }, 300_000);
});
