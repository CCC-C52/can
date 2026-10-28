import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { Engine, VIDEO_PLAN_MAX_REGENERATIONS } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks, type Task } from "@/lib/orchestrator/projects";
import { createBrand } from "@/lib/services/brands";
import { uploadMedia } from "@/lib/services/media";
import { upsertConnection } from "@/lib/services/connections";
import { getCurrentVersion, listOutputs } from "@/lib/services/outputs";
import { setSetting, DEFAULT_LIMITS } from "@/lib/settings";
import { setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import { latestAnalysis } from "@/lib/media-analysis";
import { getStorage, __setStorageForTests, type StorageAdapter } from "@/lib/storage";
import { parseVideoSpec } from "@/lib/video/spec";
import { validateVideoPlan } from "@/lib/video/plan-validation";
import { setVideoGeneratorOverride, type VideoGenerator, type VideoGenRequest } from "@/lib/adapters/video-generation";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "@/lib/models/types";
import { colorScenesVideo } from "./fixtures";
import { key } from "./helpers";

// P0 (28 Ekim 2026): "black_oversized_tee.mp4"den 12–15 sn Rebirth teaser defalarca MP4 üretmeden bitti.
// Yeniden üretilen kök neden: video planındaki TEKNİK hatalar (sahne sınırı, dosya adı yerine kimlik, süre) ve model
// incelemesinin itirazları AI planlayıcıya "yaratıcı revizyon" olarak geri gönderiliyordu → 4 plan + 4 Opus incelemesi →
// görev başarısız, render hiç başlamıyordu. Ayrıca ideal plan bile 17 sn (kartlar dahil), ses izsiz ve kapak 1,5 sn'den değildi.
// Bu testler GERÇEK ffmpeg/ffprobe ile sentetik çekim üzerinde çalışır; ücretli servis yoktur (model ve Gemini sahtedir).

const execFileAsync = promisify(execFile);

let brandId: string;
let srcId: string;
const cookieBrand = vi.hoisted(() => ({ id: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (k: string) => (k === "brand_id" && cookieBrand.id ? { value: cookieBrand.id } : undefined) }) }));

const REBIRTH = "black_oversized_tee.mp4 dosyasından 12-15 saniyelik Rebirth teaser videosu hazırla (9:16, kapak 1.5. saniyeden, orijinal ses kaldırılsın)";
// Sahneler parlaklıkla ayrılır (ffmpeg sahne skoru): 0–4 kırmızı (kapak anı 1,5 sn burada), 4–10 gri, 10–15 beyaz, 15–20 siyah
const SOURCE_SCENES = [{ color: "0xb00000", seconds: 4 }, { color: "gray", seconds: 6 }, { color: "white", seconds: 5 }, { color: "black", seconds: 5 }];

type Src = { id: string; scenes: { index: number; start: number; end: number }[]; duration: number };
async function source(): Promise<Src> {
  const a = await latestAnalysis(brandId, srcId);
  return { id: srcId, scenes: (a?.result?.local?.scenes ?? []).map((s: any) => ({ index: s.index, start: s.start, end: s.end })), duration: a?.result?.local?.probe?.duration ?? 0 };
}

/** Claude benzeri sahte model: video planını verilen fonksiyondan üretir, inceleme kararını ayarlanabilir verir. Ücretsiz. */
class ClaudeLike implements TextModelAdapter {
  readonly id = "claude-like";
  readonly isDemo = true;
  readonly service = "claude-like";
  calls = { plan: 0, review: 0 };
  private demo = new DemoAdapter();
  constructor(private plan: (s: Src) => any, private review: "pass" | "needs_changes" = "pass") {}
  estimateCostUsd() { return 0; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    if (req.agent === "video" && req.purpose === "work") {
      this.calls.plan++;
      return { data: req.schema.parse(this.plan(await source())), generator: "claude-like", isDemo: true, model: "claude-like", usage: null, actualCostUsd: 0 };
    }
    if (req.agent === "quality" && req.purpose === "review" && (req.demoInput as any)?.target?.agent === "video") {
      this.calls.review++;
      const data = this.review === "pass"
        ? { verdict: "pass", score: 92, checks: [], required_changes: [] }
        : { verdict: "needs_changes", score: 60, checks: [{ name: "Marka iddiası", status: "fail", detail: "'Rebirth' doğrulanmış bilgide yok" }], required_changes: ["'Rebirth' ifadesini doğrulanmış bir koleksiyon adıyla değiştirin."] };
      return { data: req.schema.parse(data), generator: "claude-like", isDemo: true, model: "claude-like", usage: null, actualCostUsd: 0 };
    }
    return this.demo.generate(req);
  }
}

const teaser = (over: Record<string, unknown>) => ({
  id: "rebirth_teaser", mode: "edit_existing", format: "9:16", duration_s: 14, selected_asset_ids: [srcId], script: [], subtitles: [],
  generation_prompt: "", music_note: "Orijinal ses kaldırıldı.", transition: "cut", framing: "fill", intro_text: "REBIRTH", outro_text: "FriBee", parts: [], ...over,
});
/**
 * İdeal görünen ama kartlarla 17 sn tutan plan (Claude kart sürelerini bilmez); ilk bölüm gri sahneden başlar.
 * `label` ekran metnini değiştirir: aynı bayt'larda MP4 arşivde yeniden kullanılır (sha256), testler birbirini etkilemesin.
 */
const idealPlan = (s: Src, label = "REBIRTH") => ({ summary: "Rebirth teaser", unknowns: [], videos: [teaser({
  subtitles: [{ start: 0.5, end: 16.5, text: "Rebirth" }],
  segments: [
    { asset_id: s.id, scene_index: s.scenes[1].index, source_start: s.scenes[1].start + 0.5, source_end: s.scenes[1].start + 5.5, on_screen_text: label, purpose: "ürün" },
    { asset_id: s.id, scene_index: s.scenes[2].index, source_start: s.scenes[2].start + 0.2, source_end: s.scenes[2].start + 4.7, on_screen_text: "", purpose: "detay" },
    { asset_id: s.id, scene_index: s.scenes[3].index, source_start: s.scenes[3].start + 0.5, source_end: s.scenes[3].start + 4.0, on_screen_text: "", purpose: "kapanış" },
  ],
})] });

async function step(engine: Engine) {
  await q(`UPDATE tasks SET next_attempt_at = now() WHERE status = 'ready' AND next_attempt_at > now()`);
  const n = await engine.tick();
  await engine.waitInflight();
  return n;
}
async function drive(engine: Engine, until?: () => Promise<boolean>, maxTicks = 200) {
  for (let i = 0; i < maxTicks; i++) {
    if (until && (await until())) return;
    const n = await step(engine);
    const active = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE status IN ('planned','ready','review_pending','running')`);
    if (!until && n === 0 && active!.n === 0) return;
  }
  if (until) throw new Error("Koşul gerçekleşmedi");
  throw new Error("Kuyruk boşalmadı");
}
const videoTasks = async (projectId: string) => {
  const tasks = await listTasks(brandId, { projectId });
  return { work: tasks.find((t) => t.agent === "video" && t.kind === "work")!, render: tasks.find((t) => t.agent === "video" && t.kind === "render") as Task | undefined };
};
const renderSpawned = (projectId: string) => async () => !!(await videoTasks(projectId)).render;
const projectVideos = (projectId: string) =>
  q<{ id: string; storage_key: string; size_bytes: string; sha256: string; filename: string; mime_type: string; origin: string; tags: { tag: string }[] }>(
    `SELECT id, storage_key, size_bytes, sha256, filename, mime_type, origin, tags FROM media_assets WHERE brand_id = $1 AND project_id = $2 AND kind = 'video'`, [brandId, projectId]);

async function storedFile(storageKey: string, name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p0-"));
  const file = path.join(dir, name);
  await getStorage().downloadToFile(storageKey, file);
  return file;
}
/** Gerçek ffprobe çıktısı (JSON) — test kanıtı olarak yazdırılır. */
async function ffprobe(file: string) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,profile,pix_fmt,width,height,sample_rate,channels:format=duration,size", "-of", "json", file]);
  return JSON.parse(stdout);
}
async function decodeErrors(file: string) {
  const { stderr } = await execFileAsync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
  return stderr.trim();
}
async function maxVolumeDb(file: string) {
  const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
  const m = stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  return m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : null;
}
const meanRgb = async (jpeg: Buffer) => {
  const { data, info } = await sharp(jpeg).resize(64, 64, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const acc = [0, 0, 0];
  for (let i = 0; i < data.length; i += info.channels) for (let c = 0; c < 3; c++) acc[c] += data[i + c];
  return acc.map((x) => x / (data.length / info.channels));
};

beforeAll(async () => {
  brandId = (await createBrand({ name: `FriBee P0 Video ${Date.now()}`, content_language: "en" })).id;
  cookieBrand.id = brandId;
  // Lisansı bilinmeyen kaynak ses (440 Hz) içeren 1080x1920 H.264 + AAC kaynak: çıktıda bu ses OLMAMALI
  const buf = await colorScenesVideo(SOURCE_SCENES, { size: "1080x1920", audio: true });
  srcId = (await uploadMedia(brandId, { buffer: buf, filename: "black_oversized_tee.mp4" }, { origin: "real_video", rightsStatus: "owned" })).asset.id;
}, 120_000);

afterEach(async () => {
  setTextModelOverride(null);
  setVideoGeneratorOverride(undefined);
  delete process.env.GEMINI_API_KEY;
  delete process.env.FFMPEG_PATH;
  await setSetting("limits", {});
});

describe("Teslim şartı ayrıştırma ve deterministik plan doğrulaması (AI yok)", () => {
  it("talimattan süre aralığı ve kapak anı", () => {
    expect(parseVideoSpec(REBIRTH)).toEqual({ minSeconds: 12, maxSeconds: 15, coverSourceS: 1.5 });
    expect(parseVideoSpec("Stüdyo modu: hybrid (AI sahne: 2 × 6 sn)\nReklam süresi: 20-40 sn")).toEqual({ minSeconds: 20, maxSeconds: 40, coverSourceS: null });
    expect(parseVideoSpec("12 to 15 seconds teaser, cover frame at 1.5 s")).toEqual({ minSeconds: 12, maxSeconds: 15, coverSourceS: 1.5 });
    expect(parseVideoSpec("15 saniyelik Reels")).toEqual({ minSeconds: null, maxSeconds: 15.5, coverSourceS: null });
    expect(parseVideoSpec("2026 lansmanı, 1080x1920, 9:16")).toEqual({ minSeconds: null, maxSeconds: null, coverSourceS: null });
  });

  it("kaynak kimliği veritabanında yoksa onarılamaz hata; dosya adı yazıldıysa kimliğe çevrilir", async () => {
    // Analiz yoksa kaynak kullanılamaz: önce analizi tamamla (ilk uçtan uca test de yapar; burada doğrudan)
    const { ensureAnalysis } = await import("@/lib/media-analysis");
    const { getMedia } = await import("@/lib/services/media");
    expect((await ensureAnalysis((await getMedia(brandId, srcId))!)).state).toBe("completed");
    const spec = parseVideoSpec(REBIRTH);
    const bad = await validateVideoPlan(brandId, { videos: [teaser({ selected_asset_ids: [crypto.randomUUID()], segments: [{ asset_id: crypto.randomUUID(), scene_index: 0, source_start: 0, source_end: 5, on_screen_text: "", purpose: "" }] })] }, { spec });
    expect(bad.errors.join()).toMatch(/kullanılabilir kaynak video yok/);
    const byName = await validateVideoPlan(brandId, { videos: [teaser({ selected_asset_ids: ["black_oversized_tee.mp4"], segments: [{ asset_id: "black_oversized_tee.mp4", scene_index: 0, source_start: 0, source_end: 30, on_screen_text: "", purpose: "" }] })] }, { spec });
    expect(byName.errors).toEqual([]);
    const v = byName.content.videos[0];
    expect(new Set(v.segments.map((s: any) => s.asset_id))).toEqual(new Set([srcId]));
    expect(byName.expected.rebirth_teaser).toBeGreaterThanOrEqual(12);
    expect(byName.expected.rebirth_teaser).toBeLessThanOrEqual(15);
    // İdempotent: düzeltilmiş plan tekrar doğrulanınca değişmez (gereksiz sürüm/ücretli inceleme yok)
    const again = await validateVideoPlan(brandId, JSON.parse(JSON.stringify(byName.content)), { spec });
    expect([again.changed, again.repairs, again.errors]).toEqual([false, [], []]);
    const scenes = (await source()).scenes;
    for (const s of v.segments) {
      const sc = scenes.find((x) => x.index === s.scene_index)!;
      expect(s.source_start).toBeGreaterThanOrEqual(sc.start);
      expect(s.source_end).toBeLessThanOrEqual(sc.end);
    }
  }, 120_000);
});

describe("Rebirth teaser — gerçek render hattı (AI Yöneticisi → Video Uzmanı → plan → doğrulama → render → ffmpeg → depo → medya arşivi)", () => {
  let projectId: string;
  let mp4Id: string;

  it("kabul: kaynak kabul edilir, ffmpeg gerçek MP4 üretir, ffprobe + tam çözme geçer, depoda doğrulanır, medya kaydı oluşur", async () => {
    const model = new ClaudeLike(idealPlan);
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: REBIRTH, idempotencyKey: key() });
    projectId = project.id;
    await drive(new Engine("p0-accept"));

    const { work, render } = await videoTasks(projectId);
    expect(model.calls).toEqual({ plan: 1, review: 1 }); // döngü yok
    expect(work.status).toBe("approval_pending");
    expect(render!.status).toBe("completed");

    // Plan deterministik olarak düzeltildi (17 sn → 12–15 sn) ve yeni sürüm olarak kaydedildi; AI'ya geri gönderilmedi
    const v = (await getCurrentVersion(brandId, work.output_id!))!;
    expect(v.created_by).toBe("system:plan-validator");
    expect(v.qa_report.validated).toBe(true);
    expect(v.qa_report.checks.find((c: any) => c.name === "Plan doğrulaması (deterministik)").detail).toMatch(/17\.00 sn →/);
    expect(work.regen_count).toBe(0);

    const vids = await projectVideos(projectId);
    expect(vids).toHaveLength(1);
    const mp4 = vids[0];
    mp4Id = mp4.id;
    expect(mp4).toMatchObject({ mime_type: "video/mp4", origin: "edited" });
    expect(v.asset_ids).toContain(mp4.id);
    const art = render!.input_refs.result.artifacts[0];
    expect(art).toMatchObject({ asset_id: mp4.id, codec: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920, audio_codec: "aac", decoded: true, storage_verified: true, sha256: mp4.sha256, cover_source_s: 1.5 });

    // Bağımsız doğrulama: depodan geri okunan dosyada gerçek ffprobe ve tam çözme
    const file = await storedFile(mp4.storage_key, "out.mp4");
    const probe = await ffprobe(file);
    console.log("ffprobe (Rebirth teaser):", JSON.stringify(probe));
    const vs = probe.streams.find((s: any) => s.codec_type === "video");
    const as = probe.streams.find((s: any) => s.codec_type === "audio");
    expect([vs.codec_name, vs.pix_fmt, vs.width, vs.height]).toEqual(["h264", "yuv420p", 1080, 1920]);
    expect(as.codec_name).toBe("aac");
    const dur = Number(probe.format.duration);
    expect(dur).toBeGreaterThanOrEqual(12);
    expect(dur).toBeLessThanOrEqual(15);
    const errs = await decodeErrors(file);
    console.log(`ffmpeg -v error -i out.mp4 -f null - → stderr: ${JSON.stringify(errs)}`);
    expect(errs).toBe("");
    // Kaynağın lisanssız sesi (440 Hz) kaldırıldı: AAC izi sessiz
    const maxDb = await maxVolumeDb(file);
    console.log(`volumedetect max_volume: ${maxDb} dB`);
    expect(maxDb === null || maxDb <= -80).toBe(true);
    const sha = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
    expect(sha).toBe(mp4.sha256);
    await fs.rm(path.dirname(file), { recursive: true, force: true });

    // Kapak karesi: kaynağın 1,5. saniyesi (kırmızı sahne) — planın ilk bölümü gri sahneden başlasa da
    const thumb = (await q1<{ storage_key: string; tags: { tag: string }[] }>(`SELECT storage_key, tags FROM media_assets WHERE brand_id = $1 AND project_id = $2 AND kind = 'photo' AND generation_method = 'ffmpeg_thumbnail'`, [brandId, projectId]))!;
    expect(thumb.tags.map((t) => t.tag)).toContain("kapak:kaynak 1.5 sn");
    const [r, g, b] = await meanRgb(await getStorage().get(thumb.storage_key));
    expect(r).toBeGreaterThan(130);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  }, 300_000);

  it("medya arşivi: /api/media/:id/file oynatılabilir MP4 sunar (Range 206 + tam dosya, aynı sha256)", async () => {
    const { GET } = await import("@/app/api/media/[id]/file/route");
    const params = Promise.resolve({ id: mp4Id });
    const head = await GET(new Request(`http://local/api/media/${mp4Id}/file`, { headers: { range: "bytes=0-15" } }), { params });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await head.arrayBuffer()).subarray(4, 8).toString()).toBe("ftyp");
    const full = await GET(new Request(`http://local/api/media/${mp4Id}/file`), { params });
    expect(full.status).toBe(200);
    const body = Buffer.from(await full.arrayBuffer());
    const rec = (await q1<{ sha256: string; size_bytes: string }>(`SELECT sha256, size_bytes FROM media_assets WHERE id = $1`, [mp4Id]))!;
    expect(body.length).toBe(Number(rec.size_bytes));
    expect(crypto.createHash("sha256").update(body).digest("hex")).toBe(rec.sha256);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p0-http-"));
    const f = path.join(dir, "served.mp4");
    await fs.writeFile(f, body);
    expect(await decodeErrors(f)).toBe("");
    await fs.rm(dir, { recursive: true, force: true });
  }, 120_000);
});

describe("Kök neden gerilemeleri: teknik sorunlar AI döngüsüne girmez", () => {
  it("bölüm sahne sınırını aşıyor (her denemede aynı hata) → deterministik düzeltme, tek plan çağrısı, MP4", async () => {
    const model = new ClaudeLike((s) => ({ summary: "t", unknowns: [], videos: [teaser({
      segments: [
        { asset_id: s.id, scene_index: s.scenes[0].index, source_start: 0, source_end: s.scenes[0].end + 0.6, on_screen_text: "", purpose: "açılış" },
        { asset_id: s.id, scene_index: s.scenes[1].index, source_start: s.scenes[1].start, source_end: s.scenes[1].end, on_screen_text: "REBIRTH", purpose: "ürün" },
      ],
    })] }));
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: REBIRTH, idempotencyKey: key() });
    await drive(new Engine("p0-scene"));
    const { work, render } = await videoTasks(project.id);
    expect(model.calls).toEqual({ plan: 1, review: 1 });
    expect(work.regen_count).toBe(0);
    expect(render!.status).toBe("completed");
    expect(await projectVideos(project.id)).toHaveLength(1);
  }, 300_000);

  it("model incelemesi sürekli itiraz ediyor → en fazla bir yaratıcı revizyon, sonra danışma notuyla render (insan onayı şart)", async () => {
    const model = new ClaudeLike((s) => idealPlan(s, "REBIRTH · inceleme"), "needs_changes");
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: `${REBIRTH} (inceleme testi)`, idempotencyKey: key() });
    await drive(new Engine("p0-review"));
    const { work, render } = await videoTasks(project.id);
    expect(VIDEO_PLAN_MAX_REGENERATIONS).toBe(1);
    expect(model.calls).toEqual({ plan: 2, review: 2 }); // önce: 4 plan + 4 inceleme, MP4 yok
    expect(work.status).toBe("approval_pending");
    const v = (await getCurrentVersion(brandId, work.output_id!))!;
    expect(v.qa_report.advisory.join()).toMatch(/Rebirth/);
    expect(render!.status).toBe("completed");
  }, 300_000);

  it("eksik kaynak (veritabanında olmayan kimlik, dosya adı anılmadı) → açık hata, model incelemesi ve yeniden üretim yok, render açılmaz", async () => {
    const model = new ClaudeLike(() => ({ summary: "t", unknowns: [], videos: [teaser({
      selected_asset_ids: [crypto.randomUUID()],
      segments: [{ asset_id: crypto.randomUUID(), scene_index: 0, source_start: 0, source_end: 6, on_screen_text: "", purpose: "" }],
    })] }));
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: "Arşivdeki çekimden 12-15 saniyelik teaser videosu hazırla", idempotencyKey: key() });
    await drive(new Engine("p0-missing"));
    const { work, render } = await videoTasks(project.id);
    expect(work.status).toBe("failed");
    expect(work.failure_class).toBe("permanent");
    expect(work.error).toMatch(/teknik doğrulamadan geçemedi.*kullanılabilir kaynak video yok/);
    expect(model.calls).toEqual({ plan: 1, review: 0 });
    expect(render).toBeUndefined();
  }, 120_000);

  it("render sırasında kaynak dosya depodan silinmiş → açık hata ('kaynak dosya depoda bulunamadı'), görev başarısız", async () => {
    const buf = await colorScenesVideo([{ color: "white", seconds: 7 }, { color: "black", seconds: 7 }], { size: "720x1280" });
    const tmp = (await uploadMedia(brandId, { buffer: buf, filename: "silinecek_kaynak.mp4" }, { origin: "real_video", rightsStatus: "owned" })).asset;
    const model = new ClaudeLike(() => ({ summary: "t", unknowns: [], videos: [teaser({ selected_asset_ids: [tmp.id], intro_text: "", outro_text: "", segments: [] })] }));
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: "silinecek_kaynak.mp4 dosyasından 12-15 saniyelik teaser videosu hazırla", idempotencyKey: key() });
    const engine = new Engine("p0-gone");
    await drive(engine, renderSpawned(project.id));
    await getStorage().delete(tmp.storage_key);
    await drive(engine);
    const { render } = await videoTasks(project.id);
    expect(render!.status).toBe("failed");
    expect(render!.error).toMatch(/kaynak dosya depoda bulunamadı: silinecek_kaynak\.mp4/);
    expect(await projectVideos(project.id)).toHaveLength(0);
  }, 300_000);

  it("ffmpeg hatası → render görevi başarısız, MP4 kaydı yok, plan yeniden üretilmez; aynı talep tekrarında doğrulanmış plan önbellekten kullanılır", async () => {
    const model = new ClaudeLike((s) => idealPlan(s, "REBIRTH · ffmpeg"));
    setTextModelOverride(model);
    const instruction = `${REBIRTH} [ffmpeg testi]`;
    const { project } = await submitInstruction({ brandId, instruction, idempotencyKey: key() });
    const engine = new Engine("p0-ffmpeg");
    await drive(engine, renderSpawned(project.id));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "badffmpeg-"));
    const bad = path.join(dir, "ffmpeg");
    await fs.writeFile(bad, "#!/bin/sh\necho 'Invalid data found when processing input' >&2\nexit 1\n", { mode: 0o755 });
    process.env.FFMPEG_PATH = bad;
    try {
      await drive(engine);
    } finally {
      delete process.env.FFMPEG_PATH;
      await fs.rm(dir, { recursive: true, force: true });
    }
    const { work, render } = await videoTasks(project.id);
    expect(render!.status).toBe("failed");
    expect(render!.failure_class).toBe("permanent");
    expect(render!.error).toMatch(/ffmpeg \(.+\) başarısız.*Invalid data found/);
    expect(await projectVideos(project.id)).toHaveLength(0);
    // Teknik hata planlayıcıya gönderilmedi
    expect(work.status).toBe("approval_pending");
    expect(work.regen_count).toBe(0);
    expect(model.calls).toEqual({ plan: 1, review: 1 });

    // Sahip aynı talebi tekrar gönderir: doğrulanmış plan yeniden kullanılır (ücretli planlama çağrısı yok), MP4 üretilir
    const again = await submitInstruction({ brandId, instruction, idempotencyKey: key() });
    await drive(new Engine("p0-ffmpeg-2"));
    const t2 = await videoTasks(again.project.id);
    expect(model.calls).toEqual({ plan: 1, review: 1 }); // ne plan ne inceleme tekrarlandı
    expect(t2.render!.status).toBe("completed");
    expect((await getCurrentVersion(brandId, t2.work.output_id!))!.generator).toMatch(/^cache:/);
    expect(await projectVideos(again.project.id)).toHaveLength(1);
  }, 300_000);

  it("depolama yazma hatası → geçici hata olarak sınırlı yeniden deneme, sonra başarısız; yarım medya kaydı kalmaz", async () => {
    const model = new ClaudeLike((s) => idealPlan(s, "REBIRTH · depo"));
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: `${REBIRTH} [depo yazma]`, idempotencyKey: key() });
    const engine = new Engine("p0-store");
    await drive(engine, renderSpawned(project.id));
    const real = getStorage();
    const failing = new Proxy(real, {
      get(t, p) {
        if (p === "put") return async (k: string, d: Buffer, ct: string) => { if (k.includes("/derived/")) throw new Error("S3 PutObject 503 Service Unavailable (test)"); return t.put(k, d, ct); };
        const val = Reflect.get(t, p);
        return typeof val === "function" ? val.bind(t) : val;
      },
    }) as StorageAdapter;
    __setStorageForTests(failing);
    try {
      await drive(engine);
    } finally {
      __setStorageForTests(real);
    }
    const { work, render } = await videoTasks(project.id);
    expect(render!.status).toBe("failed");
    expect(render!.error).toMatch(/Deneme sınırı doldu \(3\): Depolama hatası/);
    expect(await projectVideos(project.id)).toHaveLength(0);
    expect(work.regen_count).toBe(0);
    expect(model.calls).toEqual({ plan: 1, review: 1 });
  }, 600_000);

  it("depodan geri okunan kopya bozuk → doğrulama başarısız, kayıt geri alınır, görev başarısız (asla 'tamamlandı' değil)", async () => {
    const model = new ClaudeLike((s) => idealPlan(s, "REBIRTH · bozuk"));
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: `${REBIRTH} [depo bozuk]`, idempotencyKey: key() });
    const engine = new Engine("p0-corrupt");
    await drive(engine, renderSpawned(project.id));
    const real = getStorage();
    const corrupt = new Proxy(real, {
      get(t, p) {
        if (p === "downloadToFile") return async (k: string, f: string) => {
          const n = await t.downloadToFile(k, f);
          if (k.includes("/derived/")) { const b = await fs.readFile(f); b[Math.floor(b.length / 2)] ^= 0xff; await fs.writeFile(f, b); }
          return n;
        };
        const val = Reflect.get(t, p);
        return typeof val === "function" ? val.bind(t) : val;
      },
    }) as StorageAdapter;
    __setStorageForTests(corrupt);
    try {
      await drive(engine);
    } finally {
      __setStorageForTests(real);
    }
    const { render } = await videoTasks(project.id);
    expect(render!.status).toBe("failed");
    expect(render!.error).toMatch(/sha256 uyuşmuyor/);
    expect(await projectVideos(project.id)).toHaveLength(0);
  }, 300_000);

  it("çıktı yoksa render asla 'tamamlandı' olmaz (kaynaksız eski plan)", async () => {
    const { project } = await submitInstruction({ brandId, instruction: "Kayıt testi (çıktısız render)", idempotencyKey: key() });
    await q(`UPDATE tasks SET status = 'cancelled' WHERE project_id = $1`, [project.id]);
    const { createOutput, addVersion } = await import("@/lib/services/outputs");
    const out = await createOutput({ brandId, projectId: project.id, taskId: null, agent: "video", kind: "video_plan", title: "eski plan" });
    const ver = await addVersion({ brandId, outputId: out.id, content: { summary: "s", unknowns: [], videos: [teaser({ selected_asset_ids: [], segments: [] })] }, createdBy: "agent:video", generator: "scripted", isDemo: true });
    const task = (await q1<{ id: string }>(
      `INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status, input_refs, output_id, max_attempts)
       VALUES ($1,$2,'legacy-render','video','render','Videoyu render et','eski','ready',$3,$4,3) RETURNING id`,
      [brandId, project.id, JSON.stringify({ version_id: ver.id }), out.id],
    ))!;
    await drive(new Engine("p0-empty"));
    const t = (await q1<{ status: string; error: string }>(`SELECT status, error FROM tasks WHERE id = $1`, [task.id]))!;
    expect(t.status).toBe("failed");
    expect(t.error).toMatch(/kullanılabilir çekim yok|MP4 üretilmedi/);
  }, 120_000);
});

/** Sahte Gemini: gönder → sorgula → indir. Ağ ve ücret yok. */
class FakeGemini implements VideoGenerator {
  readonly service = "video_generation";
  readonly model = "gemini-omni-fake";
  submits: VideoGenRequest[] = [];
  polls = 0;
  constructor(private clip: Buffer) {}
  estimateCostUsd(s: number) { return 0.05 * s; }
  async submit(req: VideoGenRequest) { this.submits.push(req); return { externalId: `op_${this.submits.length}`, request: {} }; }
  async poll(id: string): ReturnType<VideoGenerator["poll"]> { this.polls++; return this.polls % 2 ? { state: "running" } : { state: "succeeded", videoUri: `interaction:${id}` }; }
  async download() { return this.clip; }
}

describe("compose ve Gemini hattı (sahte sağlayıcı; ücretli üretim varsayılan olarak kapalı)", () => {
  const composePlan = (photoId: string) => (s: Src) => ({ summary: "Rebirth reklamı", unknowns: [], videos: [
    { id: "s1", mode: "generate_new", format: "9:16", duration_s: 6, selected_asset_ids: [], script: [], subtitles: [], generation_prompt: "Slow dolly-in on a model in a black oversized tee under soft studio light.", music_note: "", transition: "cut", framing: "fill", intro_text: "", outro_text: "", segments: [], parts: [] },
    { id: "ad", mode: "compose", format: "9:16", duration_s: 14, selected_asset_ids: [], script: [], subtitles: [], generation_prompt: "", music_note: "", transition: "fade", framing: "fill", intro_text: "", outro_text: "FriBee", segments: [], parts: [
      { kind: "ai_scene", ref: "s1", duration_s: 6, motion: "none", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "Rebirth" },
      { kind: "product_photo", ref: photoId, duration_s: 2.5, motion: "zoom_in", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "" },
      { kind: "archive_clip", ref: s.id, duration_s: 3, motion: "none", scene_index: s.scenes[1].index, source_start: s.scenes[1].start + 0.5, source_end: s.scenes[1].start + 3.5, on_screen_text: "Shop now" },
    ] },
  ] });
  let photoId: string;
  beforeAll(async () => {
    const photo = await sharp({ create: { width: 1600, height: 2000, channels: 3, background: "#151515" } }).jpeg({ quality: 92 }).toBuffer();
    photoId = (await uploadMedia(brandId, { buffer: photo, filename: "black-tee-front.jpg" }, { kind: "photo", origin: "real_photo", rightsStatus: "owned", vision: false })).asset.id;
  });

  it("ücretli üretim kapalı → Gemini'ye hiçbir istek gitmez, render 'bağlantı/izin bekliyor', plan yeniden üretilmez", async () => {
    const gemini = new FakeGemini(await colorScenesVideo([{ color: "purple", seconds: 6 }]));
    setVideoGeneratorOverride(gemini);
    const model = new ClaudeLike(composePlan(photoId));
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: "black_oversized_tee.mp4 ve ürün fotoğrafıyla kısa Rebirth video reklamı hazırla", idempotencyKey: key() });
    await drive(new Engine("p0-gem-off"));
    const { work, render } = await videoTasks(project.id);
    expect(gemini.submits).toHaveLength(0);
    expect(render!.status).toBe("waiting_connection");
    expect(render!.error).toMatch(/Ücretli AI medya üretimi Ayarlar'da kapalı/);
    expect(work.regen_count).toBe(0);
    expect(model.calls).toEqual({ plan: 1, review: 1 });
  }, 120_000);

  it("izinli (sahte) Gemini: gönder → sorgula → indir → depola; compose gerçek MP4 (H.264, yuv420p, AAC) ve doğrulanmış kayıt", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    await upsertConnection("video_generation", null, { status: "connected" });
    await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true, maxVideoGenSeconds: 40, dailyBudgetUsd: 20, perTaskBudgetUsd: 20 });
    const gemini = new FakeGemini(await colorScenesVideo([{ color: "purple", seconds: 6 }], { size: "720x1280", audio: true }));
    setVideoGeneratorOverride(gemini);
    setTextModelOverride(new ClaudeLike(composePlan(photoId)));
    const { project } = await submitInstruction({ brandId, instruction: "black_oversized_tee.mp4 ve ürün fotoğrafıyla kısa Rebirth video reklamı hazırla (izinli)", idempotencyKey: key() });
    await drive(new Engine("p0-gem-on"));
    expect(gemini.submits).toHaveLength(1);
    expect(gemini.polls).toBeGreaterThanOrEqual(2);
    const job = (await q1<{ status: string; result_asset_id: string }>(`SELECT status, result_asset_id FROM provider_jobs WHERE project_id = $1`, [project.id]))!;
    expect(job.status).toBe("succeeded");
    const scene = (await q1<{ storage_key: string; sha256: string }>(`SELECT storage_key, sha256 FROM media_assets WHERE id = $1`, [job.result_asset_id]))!;
    expect(crypto.createHash("sha256").update(await getStorage().get(scene.storage_key)).digest("hex")).toBe(scene.sha256);

    const { render } = await videoTasks(project.id);
    expect(render!.status).toBe("completed");
    const ad = (await q1<{ id: string; storage_key: string }>(`SELECT id, storage_key FROM media_assets WHERE source_task_id = $1 AND generation_method = 'ffmpeg_edit' AND kind = 'video'`, [render!.id]))!;
    const art = render!.input_refs.result.artifacts.find((a: any) => a.asset_id === ad.id);
    expect(art).toMatchObject({ codec: "h264", pix_fmt: "yuv420p", audio_codec: "aac", storage_verified: true, ai_scenes: 1, product_photos: 1 });
    const file = await storedFile(ad.storage_key, "ad.mp4");
    const probe = await ffprobe(file);
    console.log("ffprobe (compose):", JSON.stringify(probe));
    expect(probe.streams.find((s: any) => s.codec_type === "video")).toMatchObject({ codec_name: "h264", pix_fmt: "yuv420p", width: 1080, height: 1920 });
    expect(probe.streams.find((s: any) => s.codec_type === "audio")?.codec_name).toBe("aac");
    expect(await decodeErrors(file)).toBe("");
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  }, 300_000);
});
