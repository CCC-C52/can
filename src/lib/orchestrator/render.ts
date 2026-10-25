import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { q1 } from "@/lib/db/pool";
import { composeDesign } from "@/lib/adapters/compose";
import { renderEdit, type EditClip } from "@/lib/adapters/video-edit";
import { assertDecodes, FfmpegError } from "@/lib/adapters/ffmpeg";
import { latestAnalysis } from "@/lib/media-analysis";
import { formatToSize, getImageGenerator, validateGeneratedImage, type ReferenceImage } from "@/lib/adapters/images";
import { CONTRACT_UNVERIFIED, getVideoGenerator, MAX_REFERENCE_IMAGES, OMNI_MAX_SECONDS, omniAspect, videoGenMode } from "@/lib/adapters/video-generation";
import { premiumStage, verifyMp4, verifyReferences } from "@/lib/video/premium";
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
  artifacts: { ref: string; asset_id: string; codec: string | null; width: number; height: number; duration_s: number; bytes: number; segments: number; sources: number; decoded: boolean; audio: string }[];
};

const VIDEO_POLL_MS = 15_000;
const VIDEO_MAX_POLLS = 120;          // ~30 dk
const MAX_GENERATED_VIDEO_BYTES = 300 * 1024 * 1024;
const RASTER = new Set(["image/png", "image/jpeg", "image/webp"]);

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
        const m = await getMedia(task.brand_id, id); // marka kapsamı: başka markanın kimliği bulunamaz
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
    const m = await getMedia(task.brand_id, id);
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
  for (const vid of ctx.content.videos ?? []) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (vid.mode === "edit_existing") await editVideo(ctx, vid, o);
    else await generateVideo(ctx, vid, o);
  }
  return o;
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
          const m = await getMedia(task.brand_id, String(sg.asset_id)); // marka kapsamı: başka markanın dosyası bulunamaz
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
        const m = await getMedia(task.brand_id, vid.selected_asset_ids[i]);
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
    // Sözleşme doğrulanmamışsa (gerçek model/istek biçimi sahipçe teyit edilmedi) ücretli gönderim yapılmaz
    if (gen.contractVerified === false) { o.waiting.push(`${vid.id}: AI video — ${CONTRACT_UNVERIFIED}`); return; }
    // Süre sessizce kırpılmaz: 6–8 sn pilot tek çekim; 15 sn master çok çekim + onaylı pilot gerektirir
    const stage = premiumStage(vid.duration_s, OMNI_MAX_SECONDS, null);
    // (Master için pilot onayı ve çok çekim birleştirme henüz bağlanmadı: pilot=null ile 15 sn her zaman reddedilir.)
    if (!stage.ok) { o.failed.push(`${vid.id}: ${stage.reason}`); return; }
    const seconds = stage.shots[0];
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
    // Doğrulanamayan referans sessizce düşürülmez: öğe reddedilir (aksi halde metinden video ürünü uydurabilir).
    const requested: string[] = (vid.selected_asset_ids ?? []).map(String);
    if (requested.length > MAX_REFERENCE_IMAGES) { o.failed.push(`${vid.id}: en fazla ${MAX_REFERENCE_IMAGES} referans fotoğraf gönderilebilir (${requested.length} seçildi)`); return; }
    if (!clean(vid.product_theme).trim()) { o.failed.push(`${vid.id}: premium ürün videosu için sahipçe doğrulanmış ürün teması gerekli`); return; }
    const found = new Map<string, MediaAsset | null>();
    for (const id of requested) found.set(id, await getMedia(task.brand_id, id)); // marka kapsamı
    const productIds = new Set([...found.values()].map((m) => m?.product_id ?? null));
    const productId = productIds.size === 1 ? [...productIds][0] : null; // tüm referanslar aynı ürüne ait olmalı
    const refs = verifyReferences(requested, found, { productId, theme: clean(vid.product_theme).trim() || null });
    if (refs.rejected.length) {
      o.failed.push(`${vid.id}: doğrulanmamış ürün referansı — ${refs.rejected.map((r) => `${r.id}: ${r.reason}`).join("; ")}`.slice(0, 600));
      return;
    }
    const images: { base64: string; mimeType: string }[] = [];
    for (const id of refs.accepted) {
      const m = found.get(id)!;
      images.push({ base64: (await readMediaFile(m)).toString("base64"), mimeType: m.mime_type }); // özgün dosya yalnızca okunur
    }
    const est = gen.estimateCostUsd(seconds);
    const prompt = clean(vid.generation_prompt);
    const { job, created } = await claimJob({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, provider: gen.service, kind: "video_generation", itemRef: vid.id, key, estimateUsd: est,
      request: { model: gen.model, mode: videoGenMode(images.length), prompt, parameters: { aspectRatio: omniAspect(vid.format), durationSeconds: seconds, resolution: "720p" }, reference_image: images.length > 0, reference_images: images.length, reference_asset_ids: refs.accepted, product_id: productId, stage: stage.stage } });
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
    } catch (err) {
      throw new PermanentError(`İndirilen dosya geçerli bir video değil: ${(err as Error).message}`);
    }
    const est = job.cost_estimated_usd === null ? null : Number(job.cost_estimated_usd);
    // Premium MP4 kalite kapısı: kapsayıcı, kodek, süre, tam en-boy oranı ve ses izi zorunlu.
    // Audio track presence is necessary but not proof of non-silent playback; owner approval remains required.
    const params = job.request?.parameters ?? {};
    const check = verifyMp4(buf, probe, { durationS: Number(params.durationSeconds ?? vid.duration_s), aspectRatio: params.aspectRatio === "16:9" ? "16:9" : "9:16", requireAudio: true });
    if (check.ok) {
      // Tam çözme: başlık doğru olsa da bozuk kareler oynatmada hata verir
      try { await assertDecodes(file); } catch (err) { if (!(err instanceof FfmpegError)) throw err; check.ok = false; check.problems.push(`tam çözme başarısız: ${err.message}`); }
    }
    if (!check.ok) {
      // Sağlayıcı ücret almış olabilir: kayıt korunur, otomatik tekrar gönderilmez
      await updateJob(job.id, { status: "failed", error: `MP4 doğrulaması başarısız: ${check.problems.join("; ")}`, cost_actual_usd: est, response: { video_uri: uri, mp4: check.metadata, verified: false } });
      await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: gen.service, kind: "actual", amountUsd: est, providerJobId: job.id, note: "Video üretildi ancak doğrulamadan geçmedi; ücret alınmış olabilir" });
      o.failed.push(`${vid.id}: MP4 doğrulaması başarısız — ${check.problems.join("; ")}`);
      return;
    }
    const refIds: string[] = Array.isArray(job.request?.reference_asset_ids) ? job.request.reference_asset_ids.map(String) : [];
    const asset = await saveDerivedAsset(task.brand_id, {
      buffer: buf, filename: `${vid.id}-ai.mp4`, origin: "ai_generated", generationMethod: `ai_video:${gen.model}`, sourceAssetIds: refIds,
      productId: job.request?.product_id ?? null, taskId: task.id, projectId: task.project_id, outputVersionId: ctx.versionId,
      tags: [{ tag: `ref:${vid.id}`, source: "system" }, { tag: "AI video — gerçek çekim değil", source: "system" },
        ...(refIds.length ? [{ tag: "gerçek ürün fotoğrafı referanslı", source: "system" }] : []),
        ...(job.request?.stage ? [{ tag: `aşama:${job.request.stage}`, source: "system" }] : [])],
    });
    const thumb = await saveDerivedAsset(task.brand_id, {
      buffer: await extractFrame(file, Math.min(1, probe.duration / 2), probe.display_width), filename: `${vid.id}-ai-kapak.jpg`, origin: "ai_generated",
      generationMethod: "ffmpeg_thumbnail", sourceAssetIds: [asset.id], taskId: task.id, projectId: task.project_id, outputVersionId: ctx.versionId,
      tags: [{ tag: `ref:${vid.id}`, source: "system" }, { tag: "AI video kapak karesi", source: "system" }],
    });
    // Ses varsa korunur (dosya olduğu gibi saklanır); kayıtta yalnızca var/yok bilgisi tutulur
    await updateJob(job.id, { status: "succeeded", result_asset_id: asset.id, cost_actual_usd: est, response: { video_uri: uri, duration: probe.duration, width: probe.width, height: probe.height, has_audio: probe.has_audio, mp4: check.metadata, verified: true } });
    await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: gen.service, kind: "actual", amountUsd: est, providerJobId: job.id, note: "Yapılandırılmış saniye fiyatı; sağlayıcı faturasıyla doğrulanmadı" });
    o.produced.push(asset.id, thumb.id);
    o.artifacts.push({
      ref: vid.id, asset_id: asset.id, codec: check.metadata.codec, width: check.metadata.width, height: check.metadata.height, duration_s: check.metadata.duration_s,
      bytes: buf.length, segments: 1, sources: refIds.length, decoded: true, audio: probe.has_audio ? `var (${probe.audio_codec ?? "?"})` : "yok (sağlayıcı ses üretmedi)",
    });
  } catch (err) {
    if (err instanceof TransientError) { o.inProgress.push(`${vid.id}: indirme geçici hata verdi, tekrar denenecek`); return; }
    await updateJob(job.id, { status: "failed", error: (err as Error).message });
    o.failed.push(`${vid.id}: ${(err as Error).message}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export const RENDER_POLL_MS = VIDEO_POLL_MS;
