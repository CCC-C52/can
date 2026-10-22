import { isUuid } from "@/lib/ids";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { q, q1, getPool, type Queryable } from "@/lib/db/pool";
import { getStorage } from "@/lib/storage";
import { getTextModel } from "@/lib/models";
import { TransientError, type TextModelAdapter } from "@/lib/models/types";
import { assertBudget, recordCost } from "@/lib/services/costs";
import { getSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { sha256 } from "@/lib/security/crypto";
import { redact } from "@/lib/security/crypto";
import type { MediaAsset } from "@/lib/services/media";
import { analyzeImagePixels, visionImage } from "./pixels";
import { analyzeVideoLocal } from "./video";
import { withFfmpegSlot } from "@/lib/adapters/ffmpeg";

// Medya anlama hattı.
//  Katman 1 (yerel, her zaman): gerçek piksel/kare ölçümleri — ücretsiz, deterministik.
//  Katman 2 (vision, model bağlıysa): Claude'a GERÇEK pikseller gönderilir (görsel veya örneklenmiş video kareleri).
//    Dosya adı gönderilmez; model yalnızca gördüğünü yazar, emin olmadıklarını "uncertain" alanına koyar.
// Sonuçlar media_analyses tablosunda saklanır; aynı varlık + analiz sürümü + katman/model için tekrar işlenmez.

export const ANALYSIS_VERSION = 1;

export const ImageVisionSchema = z.object({
  summary: z.string().describe("Görselin 1-2 cümlelik Türkçe tarafsız açıklaması (alt metin olarak da kullanılır)"),
  products: z.array(z.object({
    category: z.string().describe("Görünen ürün kategorisi (ör. tişört, kapüşonlu sweatshirt, şapka); emin değilsen 'belirsiz'"),
    colors: z.array(z.string()),
    graphics_or_print: z.string().describe("Baskı/grafik tarifi; yoksa 'yok'"),
    visible_text: z.string().describe("Ürün üzerinde okunabilen metin; okunamıyorsa 'okunamıyor', yoksa 'yok'"),
    branding: z.string().describe("Görünen logo/marka işareti; yoksa 'yok'"),
    matched_catalog_product: z.string().describe("Yalnızca görsel olarak kesin eşleşiyorsa katalog ürün adı; aksi halde 'eşleşme yok'"),
    design_details: z.array(z.string()),
  })),
  apparel_category: z.string(),
  model_present: z.boolean(),
  pose: z.string().describe("Model varsa pozu; yoksa 'model yok'"),
  background: z.string(),
  lighting: z.string(),
  composition: z.string(),
  product_visibility: z.enum(["tam", "kısmi", "zayıf", "ürün yok"]),
  marketing_suitability: z.object({ score: z.number().describe("1-5"), reason: z.string() }),
  usage_scenarios: z.array(z.string()),
  quality_issues: z.array(z.string()),
  uncertain: z.array(z.string()).describe("Görselden kesin olarak anlaşılamayan noktalar"),
});

export const VideoVisionSchema = z.object({
  summary: z.string(),
  scenes: z.array(z.object({ frame_numbers: z.array(z.number()), summary: z.string(), products: z.array(z.string()), camera: z.string() })),
  products_seen: z.array(z.object({ description: z.string(), colors: z.array(z.string()), graphics_or_print: z.string(), matched_catalog_product: z.string() })),
  people: z.string(),
  setting: z.string(),
  usability: z.object({ score: z.number().describe("1-5"), issues: z.array(z.string()) }),
  marketing_uses: z.array(z.string()),
  uncertain: z.array(z.string()),
});

export type MediaAnalysis = {
  id: string;
  brand_id: string;
  asset_id: string;
  kind: "image" | "video";
  analysis_version: number;
  input_hash: string;
  status: "pending" | "processing" | "completed" | "failed";
  level: "local" | "vision";
  provider: string | null;
  model: string | null;
  result: any;
  error: string | null;
  attempts: number;
  max_attempts: number;
  cost_usd: number | null;
  cost_unknown: boolean;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

function analyzable(a: Pick<MediaAsset, "kind" | "mime_type">): "image" | "video" | null {
  if (a.kind === "video" && a.mime_type.startsWith("video/")) return "video";
  if (["photo", "logo", "design"].includes(a.kind) && /^image\/(jpeg|png|webp|gif)$/.test(a.mime_type)) return "image";
  return null;
}

/** Vision için kullanılabilir gerçek model (DEMO ve bağlantısız adaptörler hariç). */
export function visionModel(): TextModelAdapter | null {
  const m = getTextModel();
  return m.isDemo || m.unavailableReason ? null : m;
}

function hashFor(asset: Pick<MediaAsset, "sha256">, level: "local" | "vision", modelId: string) {
  return sha256(`${asset.sha256}:${ANALYSIS_VERSION}:${level}:${level === "vision" ? modelId : "local"}`);
}

/**
 * Varlık için analiz kaydı oluşturur (yoksa). Aynı içerik + sürüm + katman için ikinci kez kayıt açılmaz.
 * `vision`: false ise yalnızca yerel analiz; varsayılan ayar ve model durumuna göre belirlenir.
 */
export async function enqueueAnalysis(asset: Pick<MediaAsset, "id" | "brand_id" | "kind" | "mime_type" | "sha256">, opts: { vision?: boolean } = {}, db: Queryable = getPool()) {
  const kind = analyzable(asset);
  if (!kind) return null;
  const model = visionModel();
  const visionOn = opts.vision ?? (await getSetting<boolean>("vision_on_upload", true, db));
  const level: "local" | "vision" = model && visionOn ? "vision" : "local";
  const inputHash = hashFor(asset, level, model?.id ?? "none");
  const row = await q1<MediaAnalysis>(
    `INSERT INTO media_analyses (brand_id, asset_id, kind, analysis_version, input_hash, level, provider, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (asset_id, input_hash) DO UPDATE SET updated_at = media_analyses.updated_at RETURNING *`,
    [asset.brand_id, asset.id, kind, ANALYSIS_VERSION, inputHash, level, level === "vision" ? model!.service : "local", level === "vision" ? model!.id : null],
    db,
  );
  return row;
}

/** Bir varlığın en güncel tamamlanmış (tercihen vision) analizi. Marka kontrolü yapılır. */
export async function latestAnalysis(brandId: string, assetId: string, db: Queryable = getPool()) {
  if (!isUuid(assetId)) return null;
  return q1<MediaAnalysis>(
    `SELECT * FROM media_analyses WHERE brand_id = $1 AND asset_id = $2
     ORDER BY (status = 'completed') DESC, (level = 'vision') DESC, created_at DESC LIMIT 1`,
    [brandId, assetId],
    db,
  );
}

export async function listAnalyses(brandId: string, assetId: string, db: Queryable = getPool()) {
  return q<MediaAnalysis>(`SELECT * FROM media_analyses WHERE brand_id = $1 AND asset_id = $2 ORDER BY created_at DESC`, [brandId, assetId], db);
}

/** Ajan bağlamı için kısa özet (yalnızca tamamlanmış analizlerden; uydurma yok). */
export function compactAnalysis(a: MediaAnalysis | null) {
  if (!a || a.status !== "completed" || !a.result) return null;
  const r = a.result;
  const local = r.local ?? {};
  const v = r.vision ?? null;
  // Görsel model analizi yoksa içerik anlama ENGELLİDİR: yalnızca piksel/sahne ölçümleri vardır.
  const visual_understanding = v ? ("vision_model" as const) : ("blocked_no_vision_model" as const);
  if (a.kind === "image") {
    return {
      level: a.level,
      visual_understanding,
      orientation: local.orientation,
      aspect: local.aspect,
      dominant_colors: (local.dominant_colors ?? []).slice(0, 4).map((c: any) => c.name),
      quality_flags: local.quality_flags ?? [],
      ...(v ? { summary: v.summary, products: v.products, model_present: v.model_present, background: v.background, suitability: v.marketing_suitability, usage: v.usage_scenarios, uncertain: v.uncertain } : {}),
    };
  }
  return {
    level: a.level,
    visual_understanding,
    duration_s: local.probe?.duration,
    orientation: local.probe?.orientation,
    resolution: local.probe ? `${local.probe.display_width}x${local.probe.display_height}` : undefined,
    // Doğrulanmış sahneler: sınırlar ffmpeg sahne tespitinden, kare zamanı gerçekten çıkarılan kareden
    scenes: (local.scenes ?? []).map((s: any) => ({ index: s.index, start: s.start, end: s.end, frame_t: local.frames?.[s.frame_index]?.t ?? null, colors: s.dominant_colors, brightness: s.brightness })),
    frame_count: (r.frame_keys ?? []).length,
    motion: local.motion?.level,
    audio: local.audio?.present ? (local.audio.silent ? "sessiz" : "ses var") : "ses yok",
    usability_issues: local.usability?.issues,
    ...(v ? { summary: v.summary, scene_summaries: v.scenes, products_seen: v.products_seen, marketing_uses: v.marketing_uses, uncertain: v.uncertain } : {}),
  };
}

// ---------------------------------------------------------------- Kuyruk

export async function recoverAnalysisLeases(db: Queryable = getPool()) {
  await q(
    `UPDATE media_analyses SET status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
       error = CASE WHEN attempts < max_attempts THEN error ELSE 'İşleyici yanıt vermedi; deneme sınırı doldu.' END,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE status = 'processing' AND lease_expires_at < now()`,
    [],
    db,
  );
}

export async function claimAnalysis(workerId: string, db: Queryable = getPool()): Promise<MediaAnalysis | null> {
  return q1<MediaAnalysis>(
    `UPDATE media_analyses SET status = 'processing', lease_owner = $1, lease_expires_at = now() + interval '15 minutes',
       attempts = attempts + 1, started_at = now(), updated_at = now()
     WHERE id = (SELECT id FROM media_analyses WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING *`,
    [workerId],
    db,
  );
}

const IMAGE_SYSTEM = `You analyse a single brand media image for a marketing archive.
Describe ONLY what is visible in the pixels. Never guess materials, prices, sizes, brand claims or product names that are not visibly certain.
Do not assume the product matches any catalog item unless it is visually unambiguous; otherwise answer "eşleşme yok".
Put anything you cannot verify in "uncertain". All text fields in Turkish.`;

const VIDEO_SYSTEM = `You analyse sampled keyframes from one brand video. Each image is labelled with its frame number and timestamp.
Describe ONLY what is visible in these frames; do not infer events between frames. Group frames into scenes.
Do not assume products match catalog items unless visually unambiguous. Put anything you cannot verify in "uncertain". All text in Turkish.`;

async function catalogHint(brandId: string, db: Queryable) {
  const rows = await q<{ title: string }>(`SELECT title FROM products WHERE brand_id = $1 ORDER BY created_at LIMIT 50`, [brandId], db);
  return rows.length ? `Katalog ürün adları (yalnızca kesin görsel eşleşmede kullan): ${rows.map((r) => r.title).join("; ")}` : "Katalog ürünü kayıtlı değil.";
}

async function callVision<T>(model: TextModelAdapter, a: MediaAnalysis, schema: z.ZodType<T>, system: string, user: string, images: { mediaType: "image/jpeg"; base64: string; label?: string }[]) {
  const estimate = (model as { estimateCostUsd: TextModelAdapter["estimateCostUsd"] }).estimateCostUsd({ system, user, maxTokens: 4000, imageCount: images.length });
  await assertBudget({ taskId: null, estimateUsd: estimate, service: model.service });
  await recordCost({ brandId: a.brand_id, service: model.service, kind: "estimated", amountUsd: estimate, analysisId: a.id, note: "Medya analizi (üst sınır tahmini)" });
  const res = await model.generate({ agent: "quality", purpose: "vision", system, user, schema, maxTokens: 4000, demoInput: null, images });
  await recordCost({ brandId: a.brand_id, service: model.service, kind: "actual", amountUsd: res.actualCostUsd, units: res.usage ?? {}, analysisId: a.id, note: "Medya analizi" });
  await q(`UPDATE media_analyses SET cost_usd = $2, cost_unknown = $3 WHERE id = $1`, [a.id, res.actualCostUsd, res.actualCostUsd === null]);
  return res;
}

/** Bir analiz kaydını işler. Varlığın markası analiz kaydının markasıyla eşleşmek zorundadır (işleyici yetki kontrolü). */
export async function processAnalysis(a: MediaAnalysis, db: Queryable = getPool()): Promise<MediaAnalysis> {
  const asset = await q1<MediaAsset>(`SELECT * FROM media_assets WHERE id = $1 AND brand_id = $2`, [a.asset_id, a.brand_id], db);
  if (!asset) {
    return (await q1<MediaAnalysis>(`UPDATE media_analyses SET status = 'failed', error = 'Varlık bulunamadı veya başka markaya ait.', lease_owner = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [a.id], db))!;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-"));
  try {
    const file = path.join(dir, `input.${asset.filename.split(".").pop() || "bin"}`);
    await getStorage().downloadToFile(asset.storage_key, file);
    const model = a.level === "vision" ? visionModel() : null;
    if (a.level === "vision" && !model) throw new TransientError("Vision modeli artık kullanılamıyor (anahtar kaldırılmış olabilir).");
    let result: Record<string, unknown>;
    let alt: string | null = null;

    if (a.kind === "image") {
      const buf = await fs.readFile(file);
      const local = await analyzeImagePixels(buf);
      result = { local };
      if (model) {
        const jpeg = await visionImage(buf);
        const res = await callVision(model, a, ImageVisionSchema, IMAGE_SYSTEM, `Bu görseli analiz et.\n${await catalogHint(a.brand_id, db)}`, [{ mediaType: "image/jpeg", base64: jpeg.toString("base64") }]);
        result.vision = res.data;
        result.vision_model = res.model;
        alt = res.data.summary;
      } else {
        alt = `${local.orientation === "portrait" ? "Dikey" : local.orientation === "landscape" ? "Yatay" : "Kare"} görsel; baskın renkler: ${local.dominant_colors.slice(0, 3).map((c) => c.name).join(", ")}`;
      }
    } else {
      // ffmpeg işi süreç genelindeki sınır içinde (kurgu ile aynı anda çalışmaz)
      const { analysis, frames } = await withFfmpegSlot(() => analyzeVideoLocal(file));
      // Anahtar kareleri sakla (panelde "modelin gördüğü kareler" olarak gösterilir)
      const keys: string[] = [];
      for (const f of frames) {
        const key = `brands/${a.brand_id}/analysis/${a.id}/frame-${f.index}.jpg`;
        await getStorage().put(key, f.jpeg, "image/jpeg");
        keys.push(key);
      }
      result = { local: analysis, frame_keys: keys };
      if (model && frames.length) {
        const res = await callVision(model, a, VideoVisionSchema, VIDEO_SYSTEM, `Bu ${analysis.probe.duration} saniyelik videodan alınmış ${frames.length} kareyi analiz et.\n${await catalogHint(a.brand_id, db)}`,
          frames.map((f) => ({ mediaType: "image/jpeg" as const, base64: f.jpeg.toString("base64"), label: `Kare ${f.index + 1} · ${f.t} sn` })));
        result.vision = res.data;
        result.vision_model = res.model;
        alt = res.data.summary;
      } else {
        alt = `${analysis.probe.duration} sn ${analysis.probe.orientation === "portrait" ? "dikey" : "yatay"} video, ${analysis.scenes.length} sahne`;
      }
    }
    const done = await q1<MediaAnalysis>(
      `UPDATE media_analyses SET status = 'completed', result = $2, error = NULL, lease_owner = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [a.id, JSON.stringify(result)],
      db,
    );
    if (alt) await q(`UPDATE media_assets SET alt_text = $3 WHERE id = $1 AND brand_id = $2 AND (alt_text IS NULL OR $4)`, [asset.id, asset.brand_id, alt.slice(0, 500), a.level === "vision"], db);
    // Vision sonucundan "ai" kaynaklı etiketler (kullanıcı medya ekranında düzeltebilir); kullanıcı etiketlerine dokunulmaz
    const v = result.vision as any;
    if (v) {
      const raw: string[] = a.kind === "image"
        ? [...v.products.map((p: any) => p.category), ...v.products.flatMap((p: any) => p.colors), ...(v.model_present ? ["model üzerinde"] : []), ...v.usage_scenarios]
        : [...v.products_seen.map((p: any) => p.description), ...v.marketing_uses];
      const tags = [...new Set(raw.map((t) => String(t).trim().toLocaleLowerCase("tr")).filter((t) => t && t !== "belirsiz"))].slice(0, 10).map((tag) => ({ tag, source: "ai" }));
      await q(
        `UPDATE media_assets SET tags = (SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM jsonb_array_elements(tags) t WHERE t->>'source' <> 'ai') || $3::jsonb
         WHERE id = $1 AND brand_id = $2`,
        [asset.id, asset.brand_id, JSON.stringify(tags)],
        db,
      );
    }
    await audit({ brandId: a.brand_id, actor: "worker", action: "media.analysis", message: `${asset.filename} analiz edildi (${a.level === "vision" ? "piksel + vision" : "yalnızca yerel piksel"})` }, db);
    return done!;
  } catch (err) {
    const transient = err instanceof TransientError;
    const msg = redact((err as Error).message).slice(0, 500);
    const row = await q1<MediaAnalysis>(
      `UPDATE media_analyses SET status = CASE WHEN $3 AND attempts < max_attempts THEN 'pending' ELSE 'failed' END, error = $2,
         next_attempt_at = CASE WHEN $3 THEN now() + (power(2, attempts) * interval '20 seconds') ELSE NULL END,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [a.id, msg, transient],
      db,
    );
    return row!;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** İşleyici döngüsü: bekleyen bir analizi alıp işler. İşlenen kayıt yoksa null. */
export async function runAnalysisQueueOnce(workerId: string): Promise<MediaAnalysis | null> {
  await recoverAnalysisLeases();
  const a = await claimAnalysis(workerId);
  if (!a) return null;
  return processAnalysis(a);
}

export type AnalysisGate =
  | { state: "completed"; analysis: MediaAnalysis }
  | { state: "pending"; analysis: MediaAnalysis | null; reason: string }
  | { state: "failed"; analysis: MediaAnalysis | null; error: string };

/** Görev içinde beklemeden işlenebilecek en büyük dosya (daha büyükleri analiz kuyruğunda işlenir, görev bekler). */
export const INLINE_ANALYSIS_MAX_BYTES = 100 * 1024 * 1024;
export const INLINE_ANALYSIS_MAX_SECONDS = 90;

/**
 * Video kurgu görevinden ÖNCE çağrılır: dosyanın tamamlanmış gerçek analizi yoksa mevcut analiz hattını başlatır.
 *  - tamamlanmış analiz varsa onu döndürür;
 *  - hiç yoksa kuyruğa ekler (ücretli vision yalnızca sahibin "yüklemede AI görsel analizi" ayarı açık ve gerçek model bağlıysa);
 *  - bekleyen kayıt küçük bir dosyaya aitse ve başka işleyici almamışsa burada (aynı işleyicide) işler;
 *  - aksi halde "pending" döner: çağıran görev bekletilir, sahne UYDURULMAZ;
 *  - kalıcı hata "failed" döner.
 * Daha önce yüklenmiş dosyalar için de çalışır (yeniden yükleme gerekmez).
 */
export async function ensureAnalysis(asset: MediaAsset, opts: { inline?: boolean; workerId?: string } = {}, db: Queryable = getPool()): Promise<AnalysisGate> {
  const kind = analyzable(asset);
  if (!kind) return { state: "failed", analysis: null, error: `${asset.filename}: bu dosya türü analiz edilemiyor.` };
  const done = await q1<MediaAnalysis>(
    `SELECT * FROM media_analyses WHERE brand_id = $1 AND asset_id = $2 AND status = 'completed' AND analysis_version = $3
     ORDER BY (level = 'vision') DESC, created_at DESC LIMIT 1`,
    [asset.brand_id, asset.id, ANALYSIS_VERSION],
    db,
  );
  if (done) return { state: "completed", analysis: done };
  let row = await q1<MediaAnalysis>(
    `SELECT * FROM media_analyses WHERE brand_id = $1 AND asset_id = $2 AND analysis_version = $3 ORDER BY created_at DESC LIMIT 1`,
    [asset.brand_id, asset.id, ANALYSIS_VERSION],
    db,
  );
  if (!row) row = await enqueueAnalysis(asset, {}, db);
  if (!row) return { state: "failed", analysis: null, error: `${asset.filename}: analiz kaydı oluşturulamadı.` };
  if (row.status === "failed") return { state: "failed", analysis: row, error: row.error ?? "Analiz başarısız." };
  // Kısa/küçük dosyalar görev içinde işlenir; uzun videolar işleyicinin analiz kuyruğunda işlenir (görev süre sınırı aşılmasın)
  const canInline = opts.inline !== false && Number(asset.size_bytes) <= INLINE_ANALYSIS_MAX_BYTES
    && (asset.duration_s === null || Number(asset.duration_s) <= INLINE_ANALYSIS_MAX_SECONDS);
  if (row.status === "pending" && canInline) {
    const claimed = await q1<MediaAnalysis>(
      `UPDATE media_analyses SET status = 'processing', lease_owner = $2, lease_expires_at = now() + interval '15 minutes',
         attempts = attempts + 1, started_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now()) RETURNING *`,
      [row.id, opts.workerId ?? "task-inline"],
      db,
    );
    if (claimed) {
      const r = await processAnalysis(claimed, db);
      if (r.status === "completed") return { state: "completed", analysis: r };
      if (r.status === "failed") return { state: "failed", analysis: r, error: r.error ?? "Analiz başarısız." };
      return { state: "pending", analysis: r, reason: `geçici hata, yeniden denenecek: ${r.error ?? ""}` };
    }
  }
  return { state: "pending", analysis: row, reason: row.status === "processing" ? "analiz işleniyor" : "analiz kuyrukta" };
}

/** Analizde saklanan gerçek kareler (S3 anahtarları ve zamanları). */
export function analysisFrames(a: MediaAnalysis | null): { key: string; t: number; scene: number | null }[] {
  if (!a?.result?.frame_keys) return [];
  const frames = a.result.local?.frames ?? [];
  const scenes = a.result.local?.scenes ?? [];
  return (a.result.frame_keys as string[]).map((key, i) => ({
    key,
    t: frames[i]?.t ?? 0,
    scene: scenes.find((s: any) => s.frame_index === i)?.index ?? null,
  }));
}

/** Panelden "yeniden analiz": başarısız kaydı yeniden kuyruğa alır veya (model değiştiyse) yeni kayıt açar. */
export async function requestAnalysis(brandId: string, assetId: string) {
  const asset = await q1<MediaAsset>(`SELECT * FROM media_assets WHERE id = $1 AND brand_id = $2`, [assetId, brandId]);
  if (!asset) throw new Error("Dosya bulunamadı.");
  const row = await enqueueAnalysis(asset);
  if (!row) throw new Error("Bu dosya türü analiz edilemiyor.");
  if (row.status === "failed") {
    await q(`UPDATE media_analyses SET status = 'pending', attempts = 0, error = NULL, next_attempt_at = NULL, updated_at = now() WHERE id = $1`, [row.id]);
  }
  return row;
}

/** Analizi olmayan (veya eski sürümlü) varlıkları kuyruğa ekler. Sahip panelden başlatır; ücretli olabilir. */
export async function backfillAnalyses(brandId: string, opts: { vision?: boolean; limit?: number } = {}) {
  const assets = await q<MediaAsset>(
    `SELECT * FROM media_assets m WHERE m.brand_id = $1 AND m.origin IN ('real_photo','real_video','design_file','ai_generated')
       AND NOT EXISTS (SELECT 1 FROM media_analyses a WHERE a.asset_id = m.id AND a.analysis_version = $2 AND a.status IN ('pending','processing','completed') AND ($3::boolean IS NOT TRUE OR a.level = 'vision'))
     ORDER BY m.created_at LIMIT $4`,
    [brandId, ANALYSIS_VERSION, opts.vision ?? null, opts.limit ?? 500],
  );
  let n = 0;
  for (const a of assets) if (await enqueueAnalysis(a, { vision: opts.vision })) n++;
  return n;
}
