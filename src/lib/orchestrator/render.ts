import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { q1 } from "@/lib/db/pool";
import { composeDesign } from "@/lib/adapters/compose";
import { photoMotionClip, renderEdit, type EditClip, type PhotoMotion } from "@/lib/adapters/video-edit";
import { prepareReference, ReferenceQualityError, type ReferenceFidelity } from "@/lib/video/reference";
import { FfmpegError } from "@/lib/adapters/ffmpeg";
import { latestAnalysis } from "@/lib/media-analysis";
import { formatToSize, getImageGenerator, validateGeneratedImage, type ReferenceImage } from "@/lib/adapters/images";
import { getVideoGenerator, MAX_REFERENCE_IMAGES, omniAspect, omniDuration, videoGenMode } from "@/lib/adapters/video-generation";
import { UncertainOutcomeError } from "@/lib/adapters/http";
import { assertTool } from "@/lib/agents/registry";
import { PermanentError, TransientError } from "@/lib/models/types";
import { capabilityReady } from "@/lib/services/connections";
import { assertBudget, recordCost } from "@/lib/services/costs";
import { getMedia, readMediaFile, saveDerivedAsset, type MediaAsset } from "@/lib/services/media";
import { claimJob, discardJob, updateJob, type ProviderJob } from "@/lib/services/provider-jobs";
import { probeVideo, extractFrame } from "@/lib/media-analysis/video";
import { getStorage } from "@/lib/storage";
import type { Limits } from "@/lib/settings";
import type { Task } from "./projects";

// Render adımı: onaylanmış/üretilmiş brief'lerden gerçek dosyalar üretir.
//   tasarım: yerel derleme (sharp) veya — sahip izin verdiyse — AI görsel servisi
//   video:   yerel ffmpeg kurgu veya — sahip izin verdiyse — AI video servisi (uzun süren iş; durum veritabanında)
// Her öğenin sonucu ayrı raporlanır; hiçbir yer tutucu "üretildi" sayılmaz.

export type RenderCtx = { task: Task; signal: AbortSignal; limits: Limits; versionId: string; isDemo: boolean; content: any };
export type RenderOutcome = {
  produced: string[];     // üretilen medya kimlikleri
  waiting: string[];      // bağlantı/izin bekleyen öğeler
  inProgress: string[];   // sağlayıcıda süren işler (görev daha sonra tekrar sorgular)
  failed: string[];       // kesin başarısız öğeler
  uncertain: string[];    // sonucu bilinmeyen ücretli gönderimler
  notes: string[];
  artifacts: { ref: string; asset_id: string; codec: string | null; width: number; height: number; duration_s: number; bytes: number; segments: number; sources: number; decoded: boolean; audio: string; ai_scenes?: number; product_photos?: number; outro?: boolean }[];
};

const VIDEO_POLL_MS = 15_000;
const VIDEO_MAX_POLLS = 120;          // ~30 dk
const MAX_GENERATED_VIDEO_BYTES = 300 * 1024 * 1024;
const RASTER = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Marka kapsamlı medya. Google Drive arşivinden alınmış bir dosyanın referansı sonradan doğrulanmamış/reddedilmiş
 * duruma geçtiyse dosya hiçbir derlemeye veya AI isteğine giremez (yokmuş gibi davranılır).
 */
async function usableMedia(brandId: string, id: string) {
  const m = await getMedia(brandId, id);
  if (!m) return null;
  const blocked = await q1(`SELECT 1 FROM drive_references WHERE brand_id = $1 AND media_asset_id = $2 AND status <> 'verified'`, [brandId, m.id]);
  return blocked ? null : m;
}

const clean = (s: string | undefined | null) => String(s ?? "").replace(/\[DEMO\]\s*/g, "");

type Brand = { colors: { name: string; hex: string }[]; fonts: { role: string; family: string }[] };

async function brandStyle(brandId: string) {
  const brand = await q1<Brand>(`SELECT colors, fonts FROM brands WHERE id = $1`, [brandId]);
  const logoAsset = await q1<MediaAsset>(
    `SELECT * FROM media_assets WHERE brand_id = $1 AND kind = 'logo' AND mime_type = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
    [brandId, [...RASTER]],
  );
  return {
    bg: brand?.colors?.[1]?.hex ?? "#f4f4f2",
    accent: brand?.colors?.[0]?.hex ?? "#1f2937",
    font: brand?.fonts?.[0]?.family,
    logo: logoAsset ? await readMediaFile(logoAsset) : undefined,
    logoId: logoAsset?.id ?? null,
  };
}

async function paidAllowed(ctx: RenderCtx, capability: "image_generation" | "video_generation"): Promise<string | null> {
  if (!ctx.limits.paidMediaGeneration) return "Ücretli AI medya üretimi Ayarlar'da kapalı (sahip izni gerekli)";
  const ready = await capabilityReady(capability, ctx.task.brand_id);
  if (!ready.ready) return ready.reason;
  return null;
}

// ---------------------------------------------------------------- Tasarım

export async function renderDesign(ctx: RenderCtx): Promise<RenderOutcome> {
  assertTool("design", "media.read");
  const { task } = ctx;
  const style = await brandStyle(task.brand_id);
  const o: RenderOutcome = { produced: [], waiting: [], inProgress: [], failed: [], uncertain: [], notes: [], artifacts: [] };
  for (const b of ctx.content.briefs ?? []) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const mode: string = b.render_mode ?? (b.use_real_product_photo ? "photo_composition" : "ai_image");
    const frames: { headline: string; body: string }[] = [{ headline: clean(b.headline), body: clean(b.body_text) }];
    if (b.purpose === "carousel") for (const s of b.slides ?? []) frames.push({ headline: clean(s.headline), body: clean(s.body_text) });

    if (mode === "ai_image") {
      await generateImage(ctx, b, o);
      continue;
    }
    const photos: MediaAsset[] = [];
    if (mode === "photo_composition") {
      for (const id of b.source_asset_ids ?? []) {
        const m = await usableMedia(task.brand_id, id); // marka kapsamı: başka markanın kimliği bulunamaz
        if (m && m.kind === "photo") photos.push(m);
      }
      if (!photos.length) o.notes.push(`${b.id}: kaynak ürün fotoğrafı bulunamadı; yalnızca metinli (tipografik) tasarım üretildi.`);
    }
    for (let i = 0; i < frames.length; i++) {
      const photo = photos.length ? photos[i % photos.length] : null;
      const img = await composeDesign({
        mode: photo ? "photo_composition" : "typography", purpose: b.purpose, format: b.format,
        headline: frames[i].headline, body: frames[i].body, photo: photo ? await readMediaFile(photo) : undefined,
        logo: style.logo, bg: style.bg, accent: style.accent, font: style.font,
        page: frames.length > 1 ? { index: i + 1, count: frames.length } : undefined,
      });
      const suffix = frames.length > 1 ? `-${i + 1}of${frames.length}` : "";
      const asset = await saveDerivedAsset(task.brand_id, {
        buffer: img.buffer, filename: `${b.id}${suffix}-${b.format.replace(":", "x")}.${img.ext}`, origin: "composed", generationMethod: "sharp_compose",
        sourceAssetIds: [...(photo ? [photo.id] : []), ...(style.logoId ? [style.logoId] : [])], productId: photo?.product_id ?? b.product_ids?.[0] ?? null,
        taskId: task.id, projectId: task.project_id, outputVersionId: ctx.versionId,
        tags: [{ tag: `ref:${b.id}`, source: "system" }, { tag: `tür:${b.purpose}`, source: "system" }, { tag: "yerel derleme (AI değil)", source: "system" }, ...(ctx.isDemo ? [{ tag: "DEMO metni", source: "system" }] : [])],
      });
      o.produced.push(asset.id);
    }
  }
  return o;
}

async function generateImage(ctx: RenderCtx, b: any, o: RenderOutcome) {
  const { task } = ctx;
  const blocked = await paidAllowed(ctx, "image_generation");
  const gen = getImageGenerator();
  if (blocked || !gen) { o.waiting.push(`${b.id}: AI görsel üretimi — ${blocked ?? "sağlayıcı yapılandırılmamış"}`); return; }
  assertTool("design", "image.generate");
  // Referans: arşivdeki gerçek ürün fotoğrafı (ürün görünümü değiştirilmemeli)
  const refs: ReferenceImage[] = [];
  for (const id of (b.source_asset_ids ?? []).slice(0, 2)) {
    const m = await usableMedia(task.brand_id, id);
    if (m && m.kind === "photo" && RASTER.has(m.mime_type)) refs.push({ buffer: await readMediaFile(m), mime: m.mime_type, filename: `ref-${m.id}.${m.mime_type.split("/")[1]}` });
  }
  const prompt = refs.length
    ? `${clean(b.generation_prompt)}\nKeep the product exactly as shown in the reference photo: same shape, colours, materials, logo and proportions. Do not add text.`
    : clean(b.generation_prompt);
  const est = gen.estimateCostUsd();
  const key = `img:${ctx.versionId}:${b.id}`;
  const existing = await claimJob({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, provider: gen.service, kind: "image_generation", itemRef: b.id, key, estimateUsd: est, request: { model: gen.model, prompt, size: formatToSize(b.format), references: refs.length } });
  if (!existing.created) { reportExisting(existing.job, b.id, o); return; }
  const job = existing.job;
  try {
    await assertBudget({ taskId: task.id, estimateUsd: est, service: gen.service });
  } catch (err) {
    await discardJob(job.id);
    throw err;
  }
  await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: gen.service, kind: "estimated", amountUsd: est, providerJobId: job.id });
  let buf: Buffer;
  try {
    buf = await gen.generate(prompt, formatToSize(b.format), refs);
  } catch (err) {
    await providerError(ctx, job, gen.service, b.id, err, o);
    return;
  }
  try {
    await validateGeneratedImage(buf);
  } catch (err) {
    await updateJob(job.id, { status: "failed", error: (err as Error).message });
    await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: gen.service, kind: "actual", amountUsd: est, providerJobId: job.id, note: "Sağlayıcı yanıt verdi ancak dosya geçersizdi; ücret alınmış olabilir" });
    o.failed.push(`${b.id}: ${(err as Error).message}`);
    return;
  }
  const asset = await saveDerivedAsset(task.brand_id, {
    buffer: buf, filename: `${b.id}-ai.png`, origin: "ai_generated", generationMethod: `ai_image:${gen.service}`,
    sourceAssetIds: [], productId: b.product_ids?.[0] ?? null, taskId: task.id, projectId: task.project_id, outputVersionId: ctx.versionId,
    tags: [{ tag: `ref:${b.id}`, source: "system" }, { tag: "AI kampanya görseli — gerçek ürün fotoğrafı değil", source: "system" }, ...(refs.length ? [{ tag: "gerçek ürün fotoğrafı referanslı", source: "system" }] : [])],
  });
  await updateJob(job.id, { status: "succeeded", result_asset_id: asset.id, cost_actual_usd: est, response: { width: asset.width, height: asset.height } });
  await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: gen.service, kind: "actual", amountUsd: est, providerJobId: job.id, note: "Yapılandırılmış birim fiyat; sağlayıcı faturasıyla doğrulanmadı" });
  o.produced.push(asset.id);
}

function reportExisting(job: ProviderJob, ref: string, o: RenderOutcome) {
  if (job.status === "succeeded" && job.result_asset_id) o.produced.push(job.result_asset_id);
  else if (job.status === "failed") o.failed.push(`${ref}: önceki gönderim başarısız oldu (${job.error ?? "neden yok"}); yeniden göndermek sahibin kararıdır`);
  else if (job.status === "unknown") o.uncertain.push(`${ref}: önceki ücretli gönderimin sonucu bilinmiyor; otomatik tekrar gönderilmedi`);
  else if (job.status === "submitting") o.uncertain.push(`${ref}: gönderim yarıda kalmış görünüyor; çift ücret riskine karşı tekrar gönderilmedi`);
  else o.inProgress.push(`${ref}: sağlayıcı işi sürüyor`);
}

async function providerError(ctx: RenderCtx, job: ProviderJob, service: string, ref: string, err: unknown, o: RenderOutcome) {
  const { task } = ctx;
  if (err instanceof UncertainOutcomeError) {
    await updateJob(job.id, { status: "unknown", error: err.message });
    await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service, kind: "actual", amountUsd: null, providerJobId: job.id, note: "Sonuç belirsiz; ücret bilinmiyor" });
    o.uncertain.push(`${ref}: ${err.message}`);
    return;
  }
  if (err instanceof TransientError) {
    // İstek kabul edilmedi (ör. 429): kayıt silinir, görev geri çekilip tekrar dener
    await discardJob(job.id);
    throw err;
  }
  await updateJob(job.id, { status: "failed", error: (err as Error).message });
  o.failed.push(`${ref}: ${(err as Error).message}`);
}

// ---------------------------------------------------------------- Video

export async function renderVideo(ctx: RenderCtx): Promise<RenderOutcome> {
  assertTool("video", "media.read");
  const o: RenderOutcome = { produced: [], waiting: [], inProgress: [], failed: [], uncertain: [], notes: [], artifacts: [] };
  // Önce AI sahneleri (gönder/sorgula/indir), sonra arşiv kurguları, en son bunları birleştiren reklam (compose)
  const rank = (v: any) => (v.mode === "generate_new" ? 0 : v.mode === "compose" ? 2 : 1);
  for (const vid of [...(ctx.content.videos ?? [])].sort((a, b) => rank(a) - rank(b))) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (vid.mode === "edit_existing") await editVideo(ctx, vid, o);
    else if (vid.mode === "compose") await composeVideo(ctx, vid, o);
    else await generateVideo(ctx, vid, o);
  }
  return o;
}

const PHOTO_MOTIONS = new Set<PhotoMotion>(["zoom_in", "zoom_out", "pan_left", "pan_right", "none"]);

/**
 * Karma reklam: bu plandaki AI sahneleri (Gemini Omni), hareketlendirilmiş gerçek ürün fotoğrafları ve doğrulanmış
 * arşiv sahneleri tek kurguda birleştirilir; marka kapanışı (logo) eklenir. AI sahneleri hazır olana kadar bekler;
 * bir AI sahnesi başarısızsa reklam üretilmez (eksik reklam başarı sayılmaz).
 */
async function composeVideo(ctx: RenderCtx, vid: any, o: RenderOutcome) {
  const { task } = ctx;
  const parts: any[] = Array.isArray(vid.parts) ? vid.parts : [];
  if (!parts.length) { o.failed.push(`${vid.id}: birleştirilecek parça yok`); return; }
  const ready = await capabilityReady("video_edit", task.brand_id);
  if (!ready.ready) { o.waiting.push(`${vid.id}: video düzenleme — ${ready.reason}`); return; }
  // AI sahnelerinin durumu (gönderim generateVideo'da yapılır; burada yalnızca sonuç okunur)
  const scenes = new Map<string, ProviderJob>();
  for (const p of parts.filter((x) => x.kind === "ai_scene")) {
    const job = await q1<ProviderJob>(`SELECT * FROM provider_jobs WHERE idempotency_key = $1 AND brand_id = $2`, [`vid:${ctx.versionId}:${p.ref}`, task.brand_id]);
    if (!job) { o.waiting.push(`${vid.id}: AI sahnesi "${p.ref}" henüz gönderilmedi (ücretli üretim izni, bağlantı veya bütçe bekleniyor)`); return; }
    if (job.status === "failed" || job.status === "unknown" || job.status === "cancelled") { o.failed.push(`${vid.id}: AI sahnesi "${p.ref}" üretilemedi; reklam eksik sahneyle oluşturulmadı`); return; }
    if (job.status !== "succeeded" || !job.result_asset_id) { o.inProgress.push(`${vid.id}: AI sahneleri bekleniyor ("${p.ref}" ${job.status})`); return; }
    scenes.set(p.ref, job);
  }
  assertTool("video", "video.edit");
  const style = await brandStyle(task.brand_id);
  const brand = await q1<{ name: string }>(`SELECT name FROM brands WHERE id = $1`, [task.brand_id]);
  const format = vid.format ?? "9:16";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compose-"));
  try {
    const clips: EditClip[] = [];
    const sources: MediaAsset[] = [];
    const fileOf = async (m: MediaAsset, name: string) => {
      const f = path.join(dir, `${name}.${m.filename.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "bin"}`);
      await getStorage().downloadToFile(m.storage_key, f);
      return f;
    };
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const text = clean(p.on_screen_text);
      if (p.kind === "ai_scene") {
        const m = await usableMedia(task.brand_id, scenes.get(p.ref)!.result_asset_id!);
        if (!m || m.kind !== "video") { o.failed.push(`${vid.id}: parça ${i + 1} — AI sahnesi dosyası bulunamadı`); return; }
        const file = await fileOf(m, `ai${i}`);
        const dur = (await probeVideo(file)).duration;
        const want = Number(p.duration_s) > 0 ? Math.min(Number(p.duration_s), dur) : dur;
        clips.push({ file, start: 0, duration: Math.round(Math.max(0.5, want) * 1000) / 1000, sourceDuration: dur, text });
        sources.push(m);
      } else if (p.kind === "product_photo") {
        const m = await usableMedia(task.brand_id, String(p.ref)); // marka kapsamı
        if (!m || m.kind !== "photo" || !RASTER.has(m.mime_type)) { o.failed.push(`${vid.id}: parça ${i + 1} — ürün fotoğrafı bulunamadı`); return; }
        const out = path.join(dir, `photo${i}.mp4`);
        const motion: PhotoMotion = PHOTO_MOTIONS.has(p.motion) ? p.motion : "zoom_in";
        const r = await photoMotionClip({ photo: await fileOf(m, `p${i}`), out, format, seconds: Number(p.duration_s) || 2.5, motion, bg: style.bg, signal: ctx.signal });
        clips.push({ file: out, start: 0, duration: r.duration, sourceDuration: r.duration, text });
        sources.push(m);
      } else if (p.kind === "archive_clip") {
        const m = await usableMedia(task.brand_id, String(p.ref));
        if (!m || m.kind !== "video") { o.failed.push(`${vid.id}: parça ${i + 1} — arşiv videosu bulunamadı`); return; }
        const analysis = await latestAnalysis(task.brand_id, m.id);
        const scene = (analysis?.status === "completed" ? analysis.result?.local?.scenes ?? [] : []).find((x: any) => x.index === Number(p.scene_index));
        const start = Number(p.source_start), end = Number(p.source_end);
        if (!scene || !(end - start >= 0.5) || start < scene.start - SCENE_TOLERANCE_S || end > scene.end + SCENE_TOLERANCE_S) {
          o.failed.push(`${vid.id}: parça ${i + 1} — arşiv sahnesi doğrulanamadı (sahne ${p.scene_index}, ${start}–${end} sn)`);
          return;
        }
        const file = await fileOf(m, `clip${i}`);
        const dur = (await probeVideo(file)).duration;
        clips.push({ file, start, duration: Math.round((Math.min(end, dur) - start) * 1000) / 1000, sourceDuration: dur, text });
        sources.push(m);
      } else { o.failed.push(`${vid.id}: parça ${i + 1} — bilinmeyen tür ${p.kind}`); return; }
    }
    const outro = clean(vid.outro_text).trim() || brand?.name || "";
    let r;
    try {
      r = await renderEdit({
        clips, format, framing: vid.framing ?? "fill", transition: vid.transition ?? "fade",
        subtitles: (vid.subtitles ?? []).map((x: any) => ({ start: x.start, end: x.end, text: clean(x.text) })),
        intro: clean(vid.intro_text).trim() ? { text: clean(vid.intro_text), bg: style.bg, accent: style.accent, font: style.font, logo: style.logo } : undefined,
        outro: outro ? { text: outro, bg: style.bg, accent: style.accent, font: style.font, logo: style.logo } : undefined,
        signal: ctx.signal, timeoutMs: Math.max(ctx.limits.taskTimeoutMs, ctx.limits.renderTimeoutMs ?? 0) - 15_000,
      });
    } catch (err) {
      if (err instanceof FfmpegError) { o.failed.push(`${vid.id}: ${err.message}`); return; }
      throw err;
    }
    const aiCount = parts.filter((x) => x.kind === "ai_scene").length;
    const photoCount = parts.filter((x) => x.kind === "product_photo").length;
    const common = { taskId: task.id, projectId: task.project_id, outputVersionId: ctx.versionId, productId: sources.find((x) => x.product_id)?.product_id ?? null, sourceAssetIds: [...new Set(sources.map((x) => x.id))] };
    const video = await saveDerivedAsset(task.brand_id, {
      ...common, buffer: r.video, filename: `${vid.id}-${format.replace(":", "x")}.mp4`, origin: "edited", generationMethod: "ffmpeg_edit",
      tags: [{ tag: `ref:${vid.id}`, source: "system" }, { tag: `AI sahne:${aiCount}`, source: "system" }, { tag: `ürün fotoğrafı:${photoCount}`, source: "system" }, { tag: "karma reklam kurgusu", source: "system" }],
    });
    const thumb = await saveDerivedAsset(task.brand_id, {
      ...common, sourceAssetIds: [video.id], buffer: r.thumbnail, filename: `${vid.id}-kapak.jpg`, origin: "edited", generationMethod: "ffmpeg_thumbnail",
      tags: [{ tag: `ref:${vid.id}`, source: "system" }, { tag: "video kapak karesi", source: "system" }],
    });
    if (!(await getStorage().exists(video.storage_key)) || Number(video.size_bytes) !== r.video.length) { o.failed.push(`${vid.id}: üretilen MP4 depoda doğrulanamadı`); return; }
    o.produced.push(video.id, thumb.id);
    o.artifacts.push({
      ref: vid.id, asset_id: video.id, codec: r.probe.video_codec, width: r.probe.width, height: r.probe.height, duration_s: r.probe.duration,
      bytes: r.video.length, segments: clips.length, ai_scenes: aiCount, product_photos: photoCount, sources: sources.length, decoded: true, outro: !!outro,
      audio: "kaldırıldı (müzik katmanı sonraki aşama)",
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Sahne sınırı toleransı (sn): analizdeki sahne sınırları kare zamanlarına yuvarlanmıştır. */
const SCENE_TOLERANCE_S = 0.15;

async function editVideo(ctx: RenderCtx, vid: any, o: RenderOutcome) {
  const { task } = ctx;
  const ready = await capabilityReady("video_edit", task.brand_id);
  if (!ready.ready) { o.waiting.push(`${vid.id}: video düzenleme — ${ready.reason}`); return; }
  assertTool("video", "video.edit");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-src-"));
  try {
    const clips: EditClip[] = [];
    const sources: MediaAsset[] = [];
    const segments: any[] = Array.isArray(vid.segments) ? vid.segments : [];
    if (segments.length) {
      // Kaynak bölümleri: her dosya bir kez indirilir; aynı dosyadan birden çok bölüm kesilebilir.
      const files = new Map<string, { file: string; duration: number; scenes: { index: number; start: number; end: number }[] }>();
      for (let i = 0; i < segments.length; i++) {
        const sg = segments[i];
        let src = files.get(sg.asset_id);
        if (!src) {
          const m = await usableMedia(task.brand_id, String(sg.asset_id)); // marka kapsamı: başka markanın dosyası bulunamaz
          if (!m || m.kind !== "video") { o.failed.push(`${vid.id}: bölüm ${i + 1} — kaynak video bulunamadı (${sg.asset_id})`); return; }
          const analysis = await latestAnalysis(task.brand_id, m.id);
          if (!analysis || analysis.status !== "completed") { o.failed.push(`${vid.id}: bölüm ${i + 1} — ${m.filename} için tamamlanmış görsel analiz yok; sahne kullanılamaz`); return; }
          const file = path.join(dir, `src-${sources.length}.${m.filename.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "mp4"}`);
          await getStorage().downloadToFile(m.storage_key, file);
          const probe = await probeVideo(file); // gerçek süre: veritabanındaki meta veriye güvenilmez
          src = { file, duration: probe.duration, scenes: analysis.result?.local?.scenes ?? [] };
          files.set(m.id, src);
          sources.push(m);
        }
        const start = Number(sg.source_start), end = Number(sg.source_end);
        const scene = src.scenes.find((x) => x.index === Number(sg.scene_index));
        const problem = !(end > start) ? "bitiş başlangıçtan önce"
          : end - start < 0.5 ? "bölüm 0,5 sn'den kısa"
          : start < 0 || end > src.duration + 0.05 ? `kaynak süresi (${src.duration.toFixed(2)} sn) dışında`
          : !scene ? `analizde ${sg.scene_index} numaralı sahne yok`
          : start < scene.start - SCENE_TOLERANCE_S || end > scene.end + SCENE_TOLERANCE_S ? `sahne ${scene.index} sınırları (${scene.start}–${scene.end} sn) dışında`
          : null;
        if (problem) { o.failed.push(`${vid.id}: bölüm ${i + 1} (${start}–${end} sn) — ${problem}`); return; }
        clips.push({ file: src.file, start, duration: Math.round((Math.min(end, src.duration) - start) * 1000) / 1000, sourceDuration: src.duration, text: clean(sg.on_screen_text) });
      }
    } else {
      // Eski biçim (sahne bölümü olmayan planlar): dosya başına tek bölüm
      for (let i = 0; i < (vid.selected_asset_ids ?? []).length; i++) {
        const m = await usableMedia(task.brand_id, vid.selected_asset_ids[i]);
        if (!m || m.kind !== "video") continue;
        const seg = vid.script?.[i];
        const file = path.join(dir, `src${i}.${m.filename.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "mp4"}`);
        await getStorage().downloadToFile(m.storage_key, file);
        const actual = (await probeVideo(file)).duration;
        const dur = Math.min(actual, seg ? Math.max(0.5, seg.t_end - seg.t_start) : 3);
        const start = seg && seg.t_start + dur <= actual ? seg.t_start : 0;
        clips.push({ file, start, duration: dur, sourceDuration: actual, text: clean(seg?.on_screen_text) });
        sources.push(m);
      }
      if (clips.length) o.notes.push(`${vid.id}: eski plan biçimi (sahne bölümü yok); dosya başına tek bölüm kullanıldı.`);
    }
    if (!clips.length) { o.notes.push(`${vid.id}: kullanılabilir çekim yok.`); return; }
    const style = await brandStyle(task.brand_id);
    const card = (text: string) => (clean(text).trim() ? { text: clean(text), bg: style.bg, accent: style.accent, font: style.font, logo: style.logo } : undefined);
    let r;
    try {
      r = await renderEdit({
        clips, format: vid.format, framing: vid.framing ?? "fit", transition: vid.transition ?? "cut",
        subtitles: (vid.subtitles ?? []).map((s: any) => ({ start: s.start, end: s.end, text: clean(s.text) })),
        intro: card(vid.intro_text), outro: card(vid.outro_text),
        signal: ctx.signal, timeoutMs: Math.max(ctx.limits.taskTimeoutMs, ctx.limits.renderTimeoutMs ?? 0) - 15_000,
      });
    } catch (err) {
      if (err instanceof FfmpegError) { o.failed.push(`${vid.id}: ${err.message}`); return; }
      throw err; // zaman aşımı/iptal: görev motoru sınıflandırır
    }
    const common = { taskId: task.id, projectId: task.project_id, outputVersionId: ctx.versionId, productId: sources[0].product_id, sourceAssetIds: sources.map((s) => s.id) };
    const video = await saveDerivedAsset(task.brand_id, {
      ...common, buffer: r.video, filename: `${vid.id}-${vid.format.replace(":", "x")}.mp4`, origin: "edited", generationMethod: "ffmpeg_edit",
      tags: [{ tag: `ref:${vid.id}`, source: "system" }, { tag: "ffmpeg kurgu (AI değil)", source: "system" }, { tag: `geçiş:${vid.transition ?? "cut"}`, source: "system" }, { tag: `bölüm:${clips.length}`, source: "system" }],
    });
    const thumb = await saveDerivedAsset(task.brand_id, {
      ...common, sourceAssetIds: [video.id], buffer: r.thumbnail, filename: `${vid.id}-kapak.jpg`, origin: "edited", generationMethod: "ffmpeg_thumbnail",
      tags: [{ tag: `ref:${vid.id}`, source: "system" }, { tag: "video kapak karesi", source: "system" }],
    });
    // Dosyanın depoda gerçekten bulunduğu ve boyutunun eşleştiği doğrulanır (kayıt + depo tutarlılığı)
    if (!(await getStorage().exists(video.storage_key)) || Number(video.size_bytes) !== r.video.length) {
      o.failed.push(`${vid.id}: üretilen MP4 depoda doğrulanamadı`);
      return;
    }
    o.produced.push(video.id, thumb.id);
    o.artifacts.push({
      ref: vid.id, asset_id: video.id, codec: r.probe.video_codec, width: r.probe.width, height: r.probe.height, duration_s: r.probe.duration,
      bytes: r.video.length, segments: clips.length, sources: sources.length, decoded: true, audio: "kaldırıldı (bilinçli sessiz çıktı)",
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function generateVideo(ctx: RenderCtx, vid: any, o: RenderOutcome) {
  const { task } = ctx;
  const key = `vid:${ctx.versionId}:${vid.id}`;
  const gen = getVideoGenerator();
  const existing = await q1<ProviderJob>(`SELECT * FROM provider_jobs WHERE idempotency_key = $1`, [key]);
  if (!existing) {
    const blocked = await paidAllowed(ctx, "video_generation");
    if (blocked || !gen) { o.waiting.push(`${vid.id}: AI video üretimi — ${blocked ?? "sağlayıcı yapılandırılmamış"}`); return; }
    assertTool("video", "video.generate");
    const seconds = omniDuration(vid.duration_s);
    const used = await q1<{ s: number }>(
      `SELECT COALESCE(SUM((request->'parameters'->>'durationSeconds')::numeric), 0)::float AS s FROM provider_jobs
       WHERE project_id = $1 AND kind = 'video_generation' AND status NOT IN ('failed','cancelled')`,
      [task.project_id],
    );
    if ((used?.s ?? 0) + seconds > ctx.limits.maxVideoGenSeconds) {
      o.waiting.push(`${vid.id}: proje AI video sınırı (${ctx.limits.maxVideoGenSeconds} sn) aşılacak; Ayarlar'dan sahip artırabilir`);
      return;
    }
    // Gerçek ürün fotoğrafları referans olarak gönderilir (1: ilk kare, 2-3: ürün referansı; baskı/renk/logo korunur).
    // Orijinal netlik: sınıra sığan dosya aynen gider; düşük çözünürlüklü fotoğraf referans olamaz (ücretli istek yapılmaz).
    const images: { base64: string; mimeType: string }[] = [];
    const fidelity: (ReferenceFidelity & { asset_id: string })[] = [];
    for (const id of vid.selected_asset_ids ?? []) {
      if (images.length >= MAX_REFERENCE_IMAGES) break;
      const m = await usableMedia(task.brand_id, id);
      if (!m || m.kind !== "photo" || !RASTER.has(m.mime_type)) continue;
      try {
        const ref = await prepareReference(await readMediaFile(m), m.mime_type, m.filename);
        images.push({ base64: ref.base64, mimeType: ref.mimeType });
        fidelity.push({ asset_id: m.id, ...ref.fidelity });
      } catch (err) {
        if (err instanceof ReferenceQualityError) { o.failed.push(`${vid.id}: ${err.message}`); return; }
        throw err;
      }
    }
    const est = gen.estimateCostUsd(seconds);
    const prompt = clean(vid.generation_prompt);
    const { job, created } = await claimJob({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, provider: gen.service, kind: "video_generation", itemRef: vid.id, key, estimateUsd: est,
      request: { model: gen.model, mode: videoGenMode(images.length), prompt, parameters: { aspectRatio: omniAspect(vid.format), durationSeconds: seconds, resolution: "720p" }, reference_image: images.length > 0, reference_images: images.length, reference_fidelity: fidelity } });
    if (!created) { reportExisting(job, vid.id, o); return; }
    try {
      await assertBudget({ taskId: task.id, estimateUsd: est, service: gen.service });
    } catch (err) {
      await discardJob(job.id);
      throw err;
    }
    await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: gen.service, kind: "estimated", amountUsd: est, units: { seconds }, providerJobId: job.id });
    try {
      const sub = await gen.submit({ prompt, durationS: seconds, aspectRatio: omniAspect(vid.format), images });
      await updateJob(job.id, { status: "submitted", external_id: sub.externalId, next_poll_ms: VIDEO_POLL_MS });
      o.inProgress.push(`${vid.id}: AI video sağlayıcıya gönderildi`);
    } catch (err) {
      await providerError(ctx, job, gen.service, vid.id, err, o);
    }
    return;
  }
  // Mevcut iş: uzlaştırma (yeniden başlatma, tekrar teslim veya sorgu turu)
  if (!["submitted", "running", "downloading"].includes(existing.status)) { reportExisting(existing, vid.id, o); return; }
  if (!gen) { o.waiting.push(`${vid.id}: AI video işi sürüyor ancak sağlayıcı yapılandırması kaldırılmış`); return; }
  await pollVideo(ctx, vid, existing, gen, o);
}

async function pollVideo(ctx: RenderCtx, vid: any, job: ProviderJob, gen: NonNullable<ReturnType<typeof getVideoGenerator>>, o: RenderOutcome) {
  const { task } = ctx;
  let uri: string | undefined = job.response?.video_uri;
  if (job.status !== "downloading") {
    let p;
    try {
      p = await gen.poll(job.external_id!);
    } catch (err) {
      if (err instanceof TransientError) { await updateJob(job.id, { poll_inc: true, next_poll_ms: VIDEO_POLL_MS }); o.inProgress.push(`${vid.id}: durum sorgusu geçici hata verdi, tekrar denenecek`); return; }
      throw err;
    }
    if (p.state === "running") {
      if (job.poll_count + 1 >= VIDEO_MAX_POLLS) {
        await updateJob(job.id, { status: "failed", poll_inc: true, error: "Sağlayıcı işi süre sınırında tamamlanmadı." });
        o.failed.push(`${vid.id}: AI video süre sınırında tamamlanmadı`);
        return;
      }
      await updateJob(job.id, { status: "running", poll_inc: true, next_poll_ms: VIDEO_POLL_MS });
      o.inProgress.push(`${vid.id}: AI video üretiliyor (sorgu ${job.poll_count + 1})`);
      return;
    }
    if (p.state === "failed") {
      await updateJob(job.id, { status: "failed", poll_inc: true, error: p.error });
      o.failed.push(`${vid.id}: ${p.error}`);
      return;
    }
    uri = p.videoUri;
    await updateJob(job.id, { status: "downloading", poll_inc: true, response: { video_uri: uri } });
  }
  // İndir → doğrula → arşive kaydet (sağlayıcı dosyayı kısa süre saklar)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gen-"));
  try {
    const buf = await gen.download(uri!, MAX_GENERATED_VIDEO_BYTES);
    const file = path.join(dir, "gen.mp4");
    await fs.writeFile(file, buf);
    let probe;
    try {
      probe = await probeVideo(file);
      if (!(probe.duration > 0.5) || !probe.width || !probe.height) throw new Error("süre/boyut geçersiz");
    } catch (err) {
      throw new PermanentError(`İndirilen dosya geçerli bir video değil: ${(err as Error).message}`);
    }
    const est = job.cost_estimated_usd === null ? null : Number(job.cost_estimated_usd);
    const asset = await saveDerivedAsset(task.brand_id, {
      buffer: buf, filename: `${vid.id}-ai.mp4`, origin: "ai_generated", generationMethod: `ai_video:${gen.model}`, sourceAssetIds: [],
      productId: null, taskId: task.id, projectId: task.project_id, outputVersionId: ctx.versionId,
      tags: [{ tag: `ref:${vid.id}`, source: "system" }, { tag: "AI video — gerçek çekim değil", source: "system" }],
    });
    const thumb = await saveDerivedAsset(task.brand_id, {
      buffer: await extractFrame(file, Math.min(1, probe.duration / 2), probe.display_width), filename: `${vid.id}-ai-kapak.jpg`, origin: "ai_generated",
      generationMethod: "ffmpeg_thumbnail", sourceAssetIds: [asset.id], taskId: task.id, projectId: task.project_id, outputVersionId: ctx.versionId,
      tags: [{ tag: `ref:${vid.id}`, source: "system" }, { tag: "AI video kapak karesi", source: "system" }],
    });
    // Ses varsa korunur (dosya olduğu gibi saklanır); kayıtta yalnızca var/yok bilgisi tutulur
    await updateJob(job.id, { status: "succeeded", result_asset_id: asset.id, cost_actual_usd: est, response: { video_uri: uri, duration: probe.duration, width: probe.width, height: probe.height, has_audio: probe.has_audio } });
    await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: gen.service, kind: "actual", amountUsd: est, providerJobId: job.id, note: "Yapılandırılmış saniye fiyatı; sağlayıcı faturasıyla doğrulanmadı" });
    o.produced.push(asset.id, thumb.id);
  } catch (err) {
    if (err instanceof TransientError) { o.inProgress.push(`${vid.id}: indirme geçici hata verdi, tekrar denenecek`); return; }
    await updateJob(job.id, { status: "failed", error: (err as Error).message });
    o.failed.push(`${vid.id}: ${(err as Error).message}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export const RENDER_POLL_MS = VIDEO_POLL_MS;
