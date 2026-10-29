import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { Engine } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks, retryProjectFailures } from "@/lib/orchestrator/projects";
import { createBrand, createProduct } from "@/lib/services/brands";
import { uploadMedia } from "@/lib/services/media";
import { upsertConnection } from "@/lib/services/connections";
import { setSetting, DEFAULT_LIMITS } from "@/lib/settings";
import { setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import { setVideoGeneratorOverride, type VideoGenerator, type VideoGenRequest } from "@/lib/adapters/video-generation";
import { setImageGeneratorOverride, type ImageGenerator } from "@/lib/adapters/images";
import { probeVideo } from "@/lib/media-analysis/video";
import { getStorage } from "@/lib/storage";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "@/lib/models/types";
import { productPhoto, colorScenesVideo } from "./fixtures";
import { key } from "./helpers";

// UÇTAN UCA (29 Ekim 2026 sahip senaryosu): sahibin AI Yönetici'ye gönderdiği Rebirth paketi mesajı → plan → strateji,
// film, görseller, sosyal medya → kalite kontrolü → Gemini AI sahneleri → gerçek ffmpeg ile 9:16 + 16:9 MP4.
// Canlıda görülen engeller bilerek kurulur: her incelemede yeni itiraz bulan kalite kontrolü, varsayılan 1 $ görev bütçesi,
// 1 $'ı aşan AI video maliyeti. Gemini, OpenAI Images ve dil modeli SAHTEDİR (ağ ve ücret yok); ffmpeg ve veritabanı gerçek.

const MESSAGE = `FriBee Rebirth — premium lansman paketi. Tüm seçimleri sen yap, bana soru sorma; eksik bilgi varsa güvenli varsayım yap ve raporda belirt.

Bu projede yalnızca şu 4 görev olsun:
1. Pazarlama: kısa kampanya konsepti — ana fikir, 3 mesaj, dört koleksiyonun kısa hikâyesi. Arşiv bilgilerini [S#] ile kaynağına bağla.
2. Video (TEK video görevi): Rebirth ana filmi. Karanlıktan ışığa açılış; dört koleksiyon sırayla kendi tişört rengiyle (Space Alien siyah, Music beyaz, Anime turuncu, Save the Bee bebe mavisi); hepsinin bir araya geldiği final; hareketli logo kapanışı. Gemini AI sahneleri yalnızca atmosfer için (ışık, duman, uzay, parçacık); ürün yalnızca doğrulanmış gerçek fotoğraflardan ve analiz edilmiş gerçek çekimlerden görünür. Dikey 9:16 ve aynı sahnelerden yatay 16:9 sürüm.
3. Tasarım: 8 premium kampanya görseli — her koleksiyon için 1 adet 4:5 gönderi ve 1 adet 9:16 story. OpenAI Images ile doğrulanmış gerçek ürün fotoğrafını referans al; ürünün rengi, baskısı ve logosu değişmez. Koyu premium zemin, güçlü tipografi, kısa başlık.
4. Sosyal medya: film ve görseller için Instagram/TikTok açıklamaları, hashtag, CTA ve 14 günlük yayın takvimi.

Kurallar: Fiyat, tarih, indirim, bağış veya doğrulanmamış iddia yazma. Hiçbir şey onayım olmadan yayınlanmaz. Bütçe sınırları içinde kal.

Stüdyo modu: hybrid (AI sahne: 3 × 5 sn)
Ek format: 16:9
Reklam süresi: 20-30 sn`;

/** Sahte Gemini Omni: saniyesi 0,25 $ (3 × 5 sn = 3,75 $: varsayılan 1 $ görev bütçesini aşar). */
class FakeOmni implements VideoGenerator {
  readonly service = "video_generation";
  readonly model = "gemini-omni-fake";
  submits: VideoGenRequest[] = [];
  constructor(private clip: Buffer) {}
  estimateCostUsd(s: number) { return 0.25 * s; }
  async submit(req: VideoGenRequest) { this.submits.push(req); return { externalId: `v1_scene${this.submits.length}`, request: {} }; }
  async poll(id: string) { return { state: "succeeded" as const, videoUri: `interaction:${id}` }; }
  async download() { return this.clip; }
}

class FakeImages implements ImageGenerator {
  readonly service = "openai_images";
  readonly model = "fake-image";
  calls = 0;
  estimateCostUsd() { return 0.2; }
  async generate() { this.calls++; return sharp(await productPhoto("#f97316", { width: 1024, height: 1024 })).png().toBuffer(); }
}

/** Demo üretim; kalite incelemesi her seferinde yeni bir itiraz bulur (canlıdaki strateji/tasarım döngüsü). */
class NitpickingModel implements TextModelAdapter {
  readonly id = "nitpicking";
  readonly isDemo = true;
  readonly service = "nitpicking";
  calls: { agent: string; purpose: string }[] = [];
  private demo = new DemoAdapter();
  estimateCostUsd() { return 0; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.calls.push({ agent: req.agent, purpose: req.purpose });
    if (req.purpose === "review") {
      const n = this.calls.length;
      return { data: { verdict: "needs_changes", score: 62, checks: [{ name: "İç notlar", status: "fail", detail: `ayrıntı ${n}` }], required_changes: [`brand_analysis.gaps içindeki ${n}. ifadeyi düzeltin.`] } as T, generator: this.id, isDemo: true, model: this.id, usage: null, actualCostUsd: 0 };
    }
    return this.demo.generate(req);
  }
}

async function drive(engine: Engine, maxTicks = 200) {
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
const model = new NitpickingModel();
const images = new FakeImages();

beforeAll(async () => {
  brandId = (await createBrand({ name: "FriBee Uçtan Uca", content_language: "en" })).id;
  await q(`UPDATE brands SET colors = $2 WHERE id = $1`, [brandId, JSON.stringify([{ name: "orange", hex: "#f97316" }, { name: "bg", hex: "#111827" }])]);
  const p = await createProduct(brandId, { title: "Orange Anime Oversized T-Shirt", status: "active" });
  // Drive'dan alınmış gibi tam çözünürlüklü ürün fotoğrafı (6000x4000)
  const big = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: "#111827" } })
    .composite([{ input: await productPhoto("#f97316", { width: 1600, height: 2000 }), left: 2200, top: 1000 }]).jpeg({ quality: 90 }).toBuffer();
  await uploadMedia(brandId, { buffer: big, filename: "IMG_7766.jpg" }, { productId: p.id });
  const logo = await sharp({ create: { width: 300, height: 100, channels: 4, background: "#f97316" } }).png().toBuffer();
  await uploadMedia(brandId, { buffer: logo, filename: "Artboard 1.png" }, { kind: "logo" });
  process.env.GEMINI_API_KEY = "test-key";
  process.env.OPENAI_API_KEY = "test-key";
  await upsertConnection("video_generation", null, { status: "connected" });
  await upsertConnection("openai_images", null, { status: "connected" });
  process.env.OPENAI_IMAGE_COST_USD = "0.2";
  // Canlıdaki gibi: görev başı bütçe varsayılanı (1 $), günlük 20 $, ücretli üretim izni açık, proje AI video sınırı 16 sn
  await setSetting("limits", { ...DEFAULT_LIMITS, paidMediaGeneration: true, dailyBudgetUsd: 20 });
  setTextModelOverride(model);
  setVideoGeneratorOverride(new FakeOmni(await colorScenesVideo([{ color: "orange", seconds: 5 }], { audio: true })));
  setImageGeneratorOverride(images);
});
afterAll(async () => {
  setTextModelOverride(null);
  setVideoGeneratorOverride(undefined);
  setImageGeneratorOverride(undefined);
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_IMAGE_COST_USD;
  await setSetting("limits", {});
});

describe("Sahip mesajından videoya (uçtan uca)", () => {
  it("Rebirth paketi: hiçbir görev başarısız olmaz; film 9:16 + 16:9 MP4 olarak üretilir ve onaya gelir", async () => {
    const { project } = await submitInstruction({ brandId, instruction: MESSAGE, idempotencyKey: key() });
    await drive(new Engine("launch-e2e"));
    let tasks = await listTasks(brandId, { projectId: project.id });
    const failed = tasks.filter((t) => t.status === "failed" || t.status === "cancelled").map((t) => `${t.title}: ${t.error}`);
    if (failed.length) {
      // Teşhis için başarısız görevleri ve hataları test çıktısına yaz
      console.error(JSON.stringify(failed, null, 2));
      expect(await retryProjectFailures(brandId, project.id)).toBeGreaterThan(0);
    }
    expect(failed).toEqual([]);

    // Hiçbir model görevi 1'den fazla yeniden üretilmedi (itiraz eden inceleme döngüsü yok)
    for (const t of tasks.filter((x) => x.kind === "work")) expect(t.regen_count).toBeLessThanOrEqual(1);

    // Film: 3 Gemini sahnesi (16:9 için ek istek yok) ve iki doğrulanmış MP4
    const render = tasks.find((t) => t.kind === "render" && t.agent === "video")!;
    expect(render?.status).toBe("completed");
    const jobs = await q<{ status: string; request: any }>(`SELECT status, request FROM provider_jobs WHERE project_id = $1 AND kind = 'video_generation'`, [project.id]);
    expect(jobs.map((j) => j.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    const spent = await q1<{ s: number }>(`SELECT COALESCE(SUM(amount_usd), 0)::float AS s FROM cost_entries WHERE task_id = $1 AND kind = 'estimated'`, [render.id]);
    expect(spent!.s).toBeGreaterThan(1); // 1 $ görev bütçesi render'ı kesmedi

    const ads = await q<any>(`SELECT * FROM media_assets WHERE source_task_id = $1 AND kind = 'video' AND generation_method = 'ffmpeg_edit' ORDER BY filename`, [render.id]);
    expect(ads).toHaveLength(2);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "launch-e2e-"));
    const probes: (string | number)[][] = [];
    for (const ad of ads) {
      const f = path.join(dir, ad.filename);
      await fs.writeFile(f, await getStorage().get(ad.storage_key));
      const pr = await probeVideo(f);
      probes.push([pr.width, pr.height, String(pr.video_codec), String(pr.audio_codec ?? "none")]);
      expect(pr.duration).toBeGreaterThan(15);
    }
    await fs.rm(dir, { recursive: true, force: true });
    expect(probes).toEqual(expect.arrayContaining([[1080, 1920, "h264", "aac"], [1920, 1080, "h264", "aac"]]));

    // Strateji ve diğer model görevleri: itirazlar danışma notu olarak onaya geldi
    tasks = await listTasks(brandId, { projectId: project.id });
    const marketing = tasks.find((t) => t.agent === "marketing" && t.kind === "work")!;
    expect(marketing.status).toBe("approval_pending");
  }, 600_000);
});
