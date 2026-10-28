import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { Engine, resolveVideoTargets, sanitizePlan, isVideoAnalysisOnlyTask } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks, requestRegeneration } from "@/lib/orchestrator/projects";
import { createBrand } from "@/lib/services/brands";
import { uploadMedia, getMedia } from "@/lib/services/media";
import { decide, listOutputs, listVersions, getCurrentVersion, createOutput, addVersion, listApprovals } from "@/lib/services/outputs";
import { buildBrandContext } from "@/lib/agents/context";
import { runRuleChecks } from "@/lib/agents/qa-rules";
import { setSetting } from "@/lib/settings";
import { setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import { getStorage } from "@/lib/storage";
import { probeVideo, extractFrame } from "@/lib/media-analysis/video";
import { assertDecodes } from "@/lib/adapters/ffmpeg";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "@/lib/models/types";
import type { Plan } from "@/lib/agents/schemas";
import { colorScenesVideo, productPhoto } from "./fixtures";
import { key } from "./helpers";

// GERÇEK video bayt'larıyla uçtan uca kurgu hattı: yükleme → (analizsiz eski kayıt) → analiz kapısı → gerçek kareler/sahneler
// → doğrulanmış sahne bölümleri → aynı kaynaktan çok bölüm + ekran metni → 1080x1920 H.264 MP4 → ffprobe + tam çözme →
// medya kaydı + önizleme bağlantısı → onay/ret/revizyon. Ücretli servis kullanılmaz (DEMO model + yerel ffmpeg).

const FIXTURE = "unisex_short_sleeve_tee_fixture.mp4";
// Sahneler belirgin parlaklık farkıyla ayrılır: ffmpeg sahne skoru ağırlıklı olarak parlaklık farkına dayanır
// (benzer parlaklıktaki farklı renkler arasındaki kesme kaçırılabilir — bilinen sınırlama, belgelendi).
const SCENES = [{ color: "red", seconds: 5 }, { color: "yellow", seconds: 5 }, { color: "blue", seconds: 4.68 }]; // 14,68 sn
const RGB: Record<string, [number, number, number]> = { red: [255, 0, 0], yellow: [255, 255, 0], blue: [0, 0, 255] };

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

async function storedToFile(storageKey: string, name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-test-"));
  const file = path.join(dir, name);
  await getStorage().downloadToFile(storageKey, file);
  return file;
}

/** Karenin bir bölgesindeki ortalama renk ve "beyaz yazı" piksel oranı. */
async function region(jpeg: Buffer, top: number, height: number) {
  const img = sharp(jpeg);
  const m = await img.metadata();
  const { data, info } = await img.extract({ left: 0, top: Math.round(m.height! * top), width: m.width!, height: Math.round(m.height! * height) }).raw().toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, white = 0;
  const px = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    r += data[i]; g += data[i + 1]; b += data[i + 2];
    if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) white++;
  }
  return { rgb: [r / px, g / px, b / px], whiteRatio: white / px };
}
const near = (a: number[], b: number[], tol = 45) => a.every((x, i) => Math.abs(x - b[i]) <= tol);

let brandId: string;
let otherBrandId: string;
let fixtureId: string;

beforeAll(async () => {
  brandId = (await createBrand({ name: "Video Hattı Test Markası", content_language: "en" })).id;
  otherBrandId = (await createBrand({ name: "Başka Marka", content_language: "en" })).id;
  const buf = await colorScenesVideo(SCENES, { size: "1080x1920", audio: true });
  const up = await uploadMedia(brandId, { buffer: buf, filename: FIXTURE }, { origin: "real_video", rightsStatus: "owned" });
  fixtureId = up.asset.id;
  // Eski kayıt benzetimi: yeni kod öncesinde yüklenmiş, hiç analiz edilmemiş video (yeniden yükleme yapılmaz)
  await q(`DELETE FROM media_analyses WHERE asset_id = $1`, [fixtureId]);
});
afterEach(async () => {
  setTextModelOverride(null);
  await setSetting("video_agent_frames", false);
});

describe("Video kurgu hattı — gerçek MP4 kabul testi", () => {
  let projectId: string;

  it("analizsiz eski video: kapı analizi başlatır, gerçek kareler/sahneler çıkarılır; plan doğrulanmış sahnelerden kurulur", async () => {
    expect(await q1(`SELECT 1 FROM media_analyses WHERE asset_id = $1`, [fixtureId])).toBeNull();
    const { project } = await submitInstruction({ brandId, instruction: `${FIXTURE} videosundan 10-15 saniyelik Instagram Reels kurgusu hazırla.`, idempotencyKey: key() });
    projectId = project.id;
    await drive(new Engine("vp-1"));

    // Gerçek analiz: ffmpeg sahne tespiti + kareler depoda
    const a = await q1<any>(`SELECT * FROM media_analyses WHERE asset_id = $1 AND status = 'completed'`, [fixtureId]);
    expect(a).toBeTruthy();
    const scenes = a.result.local.scenes;
    expect(scenes).toHaveLength(3);
    expect(scenes[1].start).toBeCloseTo(5, 0);
    expect(scenes[2].start).toBeCloseTo(10, 0);
    expect(a.result.frame_keys.length).toBeGreaterThanOrEqual(3);
    for (const [i, k] of a.result.frame_keys.entries()) {
      const jpeg = await getStorage().get(k);
      const meta = await sharp(jpeg).metadata();
      expect(meta.format).toBe("jpeg");
      // Kare, ait olduğu sahnenin gerçek rengini taşır (dosya adından değil, piksellerden)
      const sceneIdx = scenes.find((s: any) => s.frame_index === i)?.index;
      if (sceneIdx !== undefined) expect(near((await region(jpeg, 0.4, 0.2)).rgb, RGB[SCENES[sceneIdx].color])).toBe(true);
    }

    // Plan: aynı kaynaktan birden çok bölüm; her bölüm doğrulanmış sahne sınırları içinde
    const tasks = await listTasks(brandId, { projectId });
    const videoTask = tasks.find((t) => t.agent === "video" && t.kind === "work")!;
    const out = (await listOutputs(brandId, { projectId })).find((o) => o.kind === "video_plan")!;
    const v = (await getCurrentVersion(brandId, out.id))!;
    const segs = v.content.videos[0].segments;
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(segs.map((s: any) => s.asset_id))).toEqual(new Set([fixtureId]));
    const planned = segs.reduce((acc: number, s: any) => acc + (s.source_end - s.source_start), 0);
    expect(planned).toBeGreaterThanOrEqual(10); // talimat: 10-15 saniye
    expect(planned).toBeLessThanOrEqual(15);
    for (const s of segs) {
      const sc = scenes.find((x: any) => x.index === s.scene_index);
      expect(sc).toBeTruthy();
      expect(s.source_start).toBeGreaterThanOrEqual(sc.start - 0.15);
      expect(s.source_end).toBeLessThanOrEqual(sc.end + 0.15);
    }
    expect(v.qa_report.checks.find((c: any) => c.name === "Sahne doğrulaması")?.status).toBe("pass");
    expect(videoTask.status).toBe("approval_pending"); // MP4 doğrulandı → insan onayı bekliyor
  });

  it("render: 1080x1920 H.264 MP4, doğru süre, tam çözülebilir, doğru kaynak anları, ekran metni; medya kaydı ve önizleme bağı", async () => {
    const render = (await listTasks(brandId, { projectId })).find((t) => t.kind === "render" && t.agent === "video")!;
    expect(render.status).toBe("completed");
    const out = (await listOutputs(brandId, { projectId })).find((o) => o.kind === "video_plan")!;
    const v = (await getCurrentVersion(brandId, out.id))!;
    const segs = v.content.videos[0].segments as { source_start: number; source_end: number; scene_index: number; on_screen_text: string }[];
    const art = render.input_refs.result.artifacts[0];
    expect(art).toMatchObject({ codec: "h264", width: 1080, height: 1920, decoded: true, segments: segs.length, sources: 1 });

    const mp4 = (await getMedia(brandId, art.asset_id))!;
    expect(mp4).toMatchObject({ kind: "video", mime_type: "video/mp4", origin: "edited", generation_method: "ffmpeg_edit", project_id: projectId });
    expect(Number(mp4.size_bytes)).toBeGreaterThan(10_000);
    expect(v.asset_ids).toContain(mp4.id); // çıktı sürümüne bağlı → önizleme (taslak sayfası, /api/media/:id/file)
    const lineage = await q<{ source_asset_id: string }>(`SELECT source_asset_id FROM media_lineage WHERE derived_asset_id = $1`, [mp4.id]);
    expect(lineage.map((l) => l.source_asset_id)).toEqual([fixtureId]);
    // Akışla bayt aralığı okuma (indirme/önizleme yolu)
    const head = Buffer.from(await new Response(await getStorage().stream(mp4.storage_key, { start: 0, end: 15 })).arrayBuffer());
    expect(head.subarray(4, 8).toString()).toBe("ftyp");

    const file = await storedToFile(mp4.storage_key, "out.mp4");
    const p = await probeVideo(file);
    const expected = segs.reduce((acc, s) => acc + (s.source_end - s.source_start), 0);
    expect(p.video_codec).toBe("h264");
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(Math.abs(p.duration - expected)).toBeLessThan(0.2);
    expect(p.audio_codec).toBe("aac"); // kaynak ses kaldırıldı; sessiz AAC izi (platform uyumluluğu)
    await assertDecodes(file);

    // Her bölümün ortasındaki kare, KAYNAK videonun o sahnesinin rengini taşır; ekran metni yalnızca metinli bölümlerde
    let at = 0;
    for (const s of segs) {
      const d = s.source_end - s.source_start;
      const jpeg = await extractFrame(file, at + d / 2, 540);
      expect(near((await region(jpeg, 0.45, 0.1)).rgb, RGB[SCENES[s.scene_index].color])).toBe(true);
      const topWhite = (await region(jpeg, 0.08, 0.12)).whiteRatio;
      if (s.on_screen_text) expect(topWhite).toBeGreaterThan(0.002);
      else expect(topWhite).toBeLessThan(0.0005);
      at += d;
    }
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  });

  it("onay: MP4'ü olmayan sürüm onaylanamaz; ret → revizyon → yeni sürüm render → onay; geçmiş korunur", async () => {
    // MP4'süz sürüm (ör. render başarısız) onaylanamaz
    const bare = await createOutput({ brandId, projectId: null, taskId: null, agent: "video", kind: "video_plan", title: "MP4'süz plan" });
    const bv = await addVersion({ brandId, outputId: bare.id, content: { summary: "s", unknowns: [], videos: [{ id: "x", mode: "edit_existing", segments: [] }] }, createdBy: "user", generator: "user", isDemo: false });
    await expect(decide(brandId, bv.id, "approved")).rejects.toThrow(/MP4/);

    const out = (await listOutputs(brandId, { projectId })).find((o) => o.kind === "video_plan")!;
    const [v1] = await listVersions(brandId, out.id);
    await decide(brandId, v1.id, "rejected", { note: "Daha kısa açılış", scopes: [] });
    await requestRegeneration(brandId, out.id, "Daha kısa açılış");
    await drive(new Engine("vp-2"));
    const v2 = (await getCurrentVersion(brandId, out.id))!;
    expect(v2.version).toBe(v1.version + 1);
    const mp4 = await q1<{ id: string }>(`SELECT id FROM media_assets WHERE id = ANY($1::uuid[]) AND kind = 'video' AND generation_method = 'ffmpeg_edit'`, [v2.asset_ids]);
    expect(mp4).toBeTruthy();
    const ap = await decide(brandId, v2.id, "approved");
    expect(ap.content_hash).toBe(v2.content_hash);
    const hist = await listApprovals(brandId, out.id);
    expect(hist.map((h) => h.decision).sort()).toEqual(["approved", "rejected"]);
    expect(await q1(`SELECT 1 FROM external_actions WHERE brand_id = $1`, [brandId])).toBeNull(); // otomatik yayın yok
  });

  it("analiz başarısızsa görev başarısız olur ve sahne uydurulmaz", async () => {
    const buf = await colorScenesVideo([{ color: "yellow", seconds: 3 }], { size: "720x1280" });
    const broken = (await uploadMedia(brandId, { buffer: buf, filename: "kayip_dosya_klip.mp4" }, { origin: "real_video" })).asset;
    await q(`DELETE FROM media_analyses WHERE asset_id = $1`, [broken.id]);
    await getStorage().delete(broken.storage_key); // depoda dosya kaybı
    const { project } = await submitInstruction({ brandId, instruction: "kayip_dosya_klip.mp4 videosundan Reels kurgusu hazırla.", idempotencyKey: key() });
    await drive(new Engine("vp-3"));
    const tasks = await listTasks(brandId, { projectId: project.id });
    const vt = tasks.find((t) => t.agent === "video" && t.kind === "work")!;
    expect(vt.status).toBe("failed");
    expect(vt.error).toMatch(/Video analizi başarısız: kayip_dosya_klip\.mp4/);
    expect(vt.error).toMatch(/Sahne uydurulmadı/);
    expect(tasks.some((t) => t.kind === "render")).toBe(false);
    expect((await listOutputs(brandId, { projectId: project.id })).some((o) => o.kind === "video_plan")).toBe(false);
    expect((await q1<{ status: string }>(`SELECT status FROM projects WHERE id = $1`, [project.id]))!.status).toBe("blocked");
  });
});

describe("Video hattı — birimler", () => {
  it("istenen dosya adı/kimliği yalnızca bu markada eşleşir; uzantısız ad da bulunur", async () => {
    const r1 = await resolveVideoTargets(brandId, `Lütfen ${FIXTURE} kullan`);
    expect(r1.explicit).toBe(true);
    expect(r1.assets.map((a) => a.id)).toContain(fixtureId);
    const r2 = await resolveVideoTargets(brandId, "unisex_short_sleeve_tee_fixture videosu");
    expect(r2.assets.map((a) => a.id)).toContain(fixtureId);
    const other = await resolveVideoTargets(otherBrandId, `${FIXTURE} ${fixtureId}`);
    expect(other.assets.map((a) => a.id)).not.toContain(fixtureId);
  });

  it("açıkça istenen dosya, 80 kayıtlık bağlam sınırının dışında olsa da ajan bağlamına girer", async () => {
    const b = (await createBrand({ name: "Kalabalık Arşiv", content_language: "en" })).id;
    const old = (await uploadMedia(b, { buffer: await colorScenesVideo([{ color: "white", seconds: 1 }], { size: "320x568" }), filename: "eski_video.mp4" })).asset;
    await q(`UPDATE media_assets SET created_at = now() - interval '1 year' WHERE id = $1`, [old.id]);
    for (let i = 0; i < 85; i++) await uploadMedia(b, { buffer: await productPhoto(`#${(0x100000 + i * 997).toString(16).slice(-6)}`, { width: 64, height: 64 }), filename: `p${i}.jpg` });
    const plain = await buildBrandContext(b, undefined, { agent: "video" });
    expect(plain.media.some((m) => m.id === old.id)).toBe(false);
    const withReq = await buildBrandContext(b, undefined, { agent: "video", includeAssetIds: [old.id, fixtureId] });
    const m = withReq.media.find((x) => x.id === old.id)!;
    expect(m.requested).toBe(true);
    expect(withReq.media.some((x) => x.id === fixtureId)).toBe(false); // başka markanın kimliği eklenmez
  });

  it("yönetici planındaki ayrı 'video analizi' metin görevi çıkarılır; bağımlılar yeniden bağlanır", () => {
    const plan = { reply: "r", goals: [], questions_for_owner: [], tasks: [
      { key: "strategy", agent: "marketing", title: "Strateji", instruction: "s", depends_on: [] },
      { key: "analysis", agent: "video", title: "Gerçek video analizi ve sahne seçimi", instruction: "Videoyu analiz et, sahneleri seç", depends_on: ["strategy"] },
      { key: "edit", agent: "video", title: "Kurgu planı ve MP4 üretimi", instruction: "Reels kurgusu, ekran yazıları ve render", depends_on: ["analysis"] },
    ] } as Plan;
    expect(isVideoAnalysisOnlyTask(plan.tasks[1])).toBe(true);
    expect(isVideoAnalysisOnlyTask(plan.tasks[2])).toBe(false);
    const { tasks, dropped } = sanitizePlan(plan, 10);
    expect(tasks.map((t) => t.key)).toEqual(["strategy", "edit"]);
    expect(tasks[1].depends_on).toEqual(["strategy"]);
    expect(dropped[0]).toMatch(/otomatik/);
  });

  it("kalite kuralları: analizsiz video, uydurma sahne ve kaynak süresini aşan bölüm reddedilir", async () => {
    const ctx = await buildBrandContext(brandId, undefined, { includeAssetIds: [fixtureId] });
    const plan = (segments: any[]) => ({ summary: "s", unknowns: [], videos: [{ id: "r", mode: "edit_existing", format: "9:16", duration_s: 5, selected_asset_ids: [fixtureId], script: [], subtitles: [], generation_prompt: "", music_note: "", transition: "cut", framing: "fit", intro_text: "", outro_text: "", segments }] });
    const check = (segs: any[]) => runRuleChecks("video", plan(segs), ctx, { isDemo: false }).checks.find((c) => c.name.startsWith("Sahne"))!;
    expect(check([{ asset_id: fixtureId, scene_index: 0, source_start: 1, source_end: 3, on_screen_text: "", purpose: "" }]).status).toBe("pass");
    expect(check([{ asset_id: fixtureId, scene_index: 7, source_start: 1, source_end: 3, on_screen_text: "", purpose: "" }]).detail).toMatch(/uydurma sahne/);
    expect(check([{ asset_id: fixtureId, scene_index: 2, source_start: 12, source_end: 16, on_screen_text: "", purpose: "" }]).detail).toMatch(/aşıyor/);
    expect(check([{ asset_id: fixtureId, scene_index: 0, source_start: 4, source_end: 7, on_screen_text: "", purpose: "" }]).detail).toMatch(/sınırları/);
    expect(check([]).status).toBe("fail");
    const fresh = (await uploadMedia(brandId, { buffer: await colorScenesVideo([{ color: "gray", seconds: 2 }], { size: "320x568" }), filename: "analizsiz.mp4" })).asset;
    await q(`DELETE FROM media_analyses WHERE asset_id = $1`, [fresh.id]);
    const ctx2 = await buildBrandContext(brandId, undefined, { includeAssetIds: [fresh.id] });
    const r = runRuleChecks("video", { ...plan([{ asset_id: fresh.id, scene_index: 0, source_start: 0, source_end: 1, on_screen_text: "", purpose: "" }]) }, ctx2, { isDemo: false });
    expect(r.checks.find((c) => c.name === "Sahne doğrulaması")!.detail).toMatch(/görsel analizi yok/);
    expect(ctx2.media.find((m) => m.id === fresh.id)!.analysis_status).toBe("none");
  });

  it("gerçek kareler modele yalnızca sahip ayarı açıksa gönderilir (varsayılan kapalı)", async () => {
    class Capture implements TextModelAdapter {
      readonly id = "capture"; readonly isDemo = false; readonly service = "capture";
      images: number[] = []; labels: string[] = [];
      private demo = new DemoAdapter();
      estimateCostUsd() { return 0; }
      async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
        if (req.agent === "video" && req.purpose === "work") { this.images.push(req.images?.length ?? 0); this.labels.push(...(req.images ?? []).map((i) => i.label ?? "")); }
        if (req.purpose === "vision") throw new Error("bu testte vision çağrısı beklenmiyor");
        const r = await this.demo.generate(req);
        return { ...r, isDemo: false, generator: "capture" };
      }
    }
    await setSetting("vision_on_upload", false);
    for (const frames of [false, true]) {
      await setSetting("video_agent_frames", frames);
      const m = new Capture();
      setTextModelOverride(m);
      const { project } = await submitInstruction({ brandId, instruction: `${FIXTURE} ile Reels kurgusu (kare ${frames})`, idempotencyKey: key() });
      await drive(new Engine(`vp-frames-${frames}`));
      expect(m.images.length).toBeGreaterThan(0);
      if (frames) {
        expect(m.images[0]).toBeGreaterThanOrEqual(3);
        expect(m.labels[0]).toMatch(new RegExp(`${FIXTURE.replace(/\./g, "\\.")} · sahne \\d · `));
      } else expect(m.images.every((n) => n === 0)).toBe(true);
      expect((await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE project_id = $1`, [project.id]))!.n).toBeGreaterThan(0);
    }
    await setSetting("vision_on_upload", true);
  });
});
