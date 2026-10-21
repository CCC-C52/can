/**
 * CANLI entegrasyon testleri (isteğe bağlı, ÜCRETLİ). Olağan test paketinde ÇALIŞMAZ.
 *
 *   LIVE_TESTS=1 LIVE_BILLABLE_AUTHORIZED=yes LIVE_DATABASE_URL=postgres://…/aiops_live_test \
 *   LIVE_MAX_USD=2 npm run test:live -- [text] [image] [video]
 *
 * Çalışma koşulları (hepsi zorunlu):
 *  - LIVE_TESTS=1 ve LIVE_BILLABLE_AUTHORIZED=yes (sahibin açık ücretli test izni)
 *  - Yalıtılmış veritabanı: LIVE_DATABASE_URL adı "live" veya "test" içermeli; APP_MODE=production olamaz
 *  - İlgili sağlayıcı anahtarı (AIOPS_ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) ve birim fiyatı
 *    (OPENAI_IMAGE_COST_USD / VEO_COST_PER_SECOND_USD) tanımlı olmalı; tahmini toplam LIVE_MAX_USD'yi aşamaz
 * Her sağlayıcı için tek kontrollü çağrı yapılır. Sonuç: data/live-results/<zaman>.json (gizli değer içermez).
 * Temizlik: test markası "Canlı Test <zaman>" adıyla oluşturulur; dosyalar o markanın depolama önekindedir ve
 * `--cleanup` ile marka ve dosyaları silinir. Sahte (mock) sonuç asla "canlı başarı" olarak yazılmaz.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type LiveResult = {
  provider: string; model: string; requested_at: string; job_id: string | null; response_status: string;
  output_id: string | null; cost_estimate_usd: number | null; cost_reported_usd: number | null; verification: string; ok: boolean;
};

function fail(msg: string): never {
  console.error(`CANLI TEST ÇALIŞTIRILMADI: ${msg}`);
  process.exit(2);
}

async function main() {
  if (process.env.LIVE_TESTS !== "1") fail("LIVE_TESTS=1 değil.");
  if (process.env.LIVE_BILLABLE_AUTHORIZED !== "yes") fail("Ücretli test izni yok (LIVE_BILLABLE_AUTHORIZED=yes).");
  const db = process.env.LIVE_DATABASE_URL;
  if (!db || !/(live|test)/.test(new URL(db).pathname)) fail("LIVE_DATABASE_URL yalıtılmış bir veritabanı olmalı (adı 'live' veya 'test' içermeli).");
  if (process.env.APP_MODE === "production") fail("APP_MODE=production iken canlı test çalıştırılmaz.");
  const maxUsd = Number(process.env.LIVE_MAX_USD ?? "0");
  if (!(maxUsd > 0)) fail("LIVE_MAX_USD (bütçe üst sınırı) tanımlı değil.");
  process.env.DATABASE_URL_OVERRIDE = db;
  const which = new Set(process.argv.slice(2).filter((a) => !a.startsWith("--")));
  if (!which.size) ["text", "image", "video"].forEach((x) => which.add(x));

  const { config } = await import("@/lib/config");
  const { runMigrations } = await import("@/lib/db/migrate");
  const { createBrand } = await import("@/lib/services/brands");
  const { saveDerivedAsset } = await import("@/lib/services/media");
  const { getStorage } = await import("@/lib/storage");
  const { q, closePool } = await import("@/lib/db/pool");
  await runMigrations();

  if (process.argv.includes("--cleanup")) {
    const brands = await q<{ id: string }>(`SELECT id FROM brands WHERE name LIKE 'Canlı Test %'`);
    for (const b of brands) {
      const keys = await q<{ storage_key: string }>(`SELECT storage_key FROM media_assets WHERE brand_id = $1`, [b.id]);
      for (const k of keys) await getStorage().delete(k.storage_key).catch(() => {});
      await q(`DELETE FROM brands WHERE id = $1`, [b.id]);
    }
    console.log(`${brands.length} canlı test markası ve dosyaları silindi.`);
    await closePool();
    return;
  }

  // Bütçe ön kontrolü (çağrıdan ÖNCE)
  const est = {
    text: 0.05,
    image: config.openaiImages.costPerImageUsd,
    video: config.gemini.costPerSecondUsd === null ? null : config.gemini.costPerSecondUsd * 4,
  };
  let planned = 0;
  for (const k of which) {
    const v = est[k as keyof typeof est];
    if (v === null || v === undefined) fail(`${k}: birim fiyat tanımlı değil; maliyet bilinmeden ücretli çağrı yapılmaz.`);
    planned += v;
  }
  if (planned > maxUsd) fail(`Tahmini toplam $${planned.toFixed(2)} > LIVE_MAX_USD $${maxUsd}.`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const brand = await createBrand({ name: `Canlı Test ${stamp}`, content_language: "en" });
  const results: LiveResult[] = [];
  const now = () => new Date().toISOString();

  if (which.has("text")) {
    const r: LiveResult = { provider: "anthropic", model: config.anthropic.model, requested_at: now(), job_id: null, response_status: "", output_id: null, cost_estimate_usd: est.text, cost_reported_usd: null, verification: "", ok: false };
    try {
      if (!config.anthropic.apiKey) throw new Error("AIOPS_ANTHROPIC_API_KEY yok");
      const { getTextModel } = await import("@/lib/models");
      const { z } = await import("zod");
      const m = getTextModel();
      const res = await m.generate<{ tagline: string }>({ agent: "marketing", purpose: "live-test", system: "Reply with JSON.", user: "Give one short English tagline for a plain white t-shirt.", schema: z.object({ tagline: z.string() }), demoInput: null, maxTokens: 400 } as any);
      r.response_status = "ok";
      r.cost_reported_usd = res.actualCostUsd ?? null;
      r.ok = !res.isDemo && typeof res.data.tagline === "string" && res.data.tagline.length > 0;
      r.verification = r.ok ? `yanıt şemaya uygun (${res.model})` : "DEMO yanıt — canlı sayılmaz";
    } catch (e) { r.response_status = "error"; r.verification = (e as Error).message.slice(0, 300); }
    results.push(r);
  }

  if (which.has("image")) {
    const { OpenAIImageGenerator, validateGeneratedImage } = await import("@/lib/adapters/images");
    const g = new OpenAIImageGenerator();
    const r: LiveResult = { provider: "openai_images", model: g.model, requested_at: now(), job_id: null, response_status: "", output_id: null, cost_estimate_usd: est.image, cost_reported_usd: null, verification: "", ok: false };
    try {
      const buf = await g.generate("A studio product photo of a plain white t-shirt on a light grey background, no text.", "1024x1024");
      const v = await validateGeneratedImage(buf);
      const asset = await saveDerivedAsset(brand.id, { buffer: buf, filename: "live-image.png", origin: "ai_generated", generationMethod: `ai_image:${g.service}`, sourceAssetIds: [] });
      const back = await getStorage().get(asset.storage_key);
      r.response_status = "ok"; r.output_id = asset.id;
      r.ok = back.length === buf.length;
      r.verification = `${v.width}x${v.height} ${v.format}, ${buf.length} bayt, depoya yazıldı ve geri okundu`;
    } catch (e) { r.response_status = "error"; r.verification = (e as Error).message.slice(0, 300); }
    results.push(r);
  }

  if (which.has("video")) {
    const { VeoGenerator } = await import("@/lib/adapters/video-generation");
    const { probeVideo } = await import("@/lib/media-analysis/video");
    const g = new VeoGenerator(config.gemini.apiKey ?? "", config.gemini.veoModel, config.gemini.costPerSecondUsd);
    const r: LiveResult = { provider: "google_veo", model: g.model, requested_at: now(), job_id: null, response_status: "", output_id: null, cost_estimate_usd: est.video, cost_reported_usd: null, verification: "", ok: false };
    try {
      if (!config.gemini.apiKey) throw new Error("GEMINI_API_KEY yok");
      const sub = await g.submit({ prompt: "Slow camera pan across a plain white t-shirt on a hanger, soft daylight.", durationS: 4, aspectRatio: "9:16" });
      r.job_id = sub.externalId;
      let p = await g.poll(sub.externalId);
      for (let i = 0; p.state === "running" && i < 60; i++) { await new Promise((x) => setTimeout(x, 10_000)); p = await g.poll(sub.externalId); }
      r.response_status = p.state;
      if (p.state !== "succeeded") throw new Error(p.state === "failed" ? p.error : "süre sınırında tamamlanmadı");
      const buf = await g.download(p.videoUri, 300 * 1024 * 1024);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-"));
      const f = path.join(dir, "v.mp4");
      await fs.writeFile(f, buf);
      const pr = await probeVideo(f);
      await fs.rm(dir, { recursive: true, force: true });
      const asset = await saveDerivedAsset(brand.id, { buffer: buf, filename: "live-video.mp4", origin: "ai_generated", generationMethod: `ai_video:${g.model}`, sourceAssetIds: [] });
      r.output_id = asset.id;
      r.ok = pr.duration > 0.5 && !!pr.width;
      r.verification = `${pr.width}x${pr.height}, ${pr.duration} sn, ${pr.video_codec}, depoya yazıldı`;
    } catch (e) { r.verification = (e as Error).message.slice(0, 300); if (!r.response_status) r.response_status = "error"; }
    results.push(r);
  }

  const out = path.resolve("data/live-results");
  await fs.mkdir(out, { recursive: true });
  const file = path.join(out, `${stamp}.json`);
  await fs.writeFile(file, JSON.stringify({ kind: "LIVE", brand_id: brand.id, results }, null, 2));
  for (const r of results) console.log(`${r.ok ? "LIVE PASS" : "LIVE FAIL"}  ${r.provider} ${r.model} — ${r.verification}`);
  console.log(`Sonuç: ${path.relative(process.cwd(), file)}`);
  await closePool();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
