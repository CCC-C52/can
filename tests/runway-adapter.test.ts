import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { RUNWAY_DATA_URI_MAX, RUNWAY_PROMPT_MAX, RUNWAY_VERSION, RunwayVideoGenerator, runwayImageUri, runwayOrganization, runwayPrompt } from "@/lib/adapters/runway-video";
import { UncertainOutcomeError } from "@/lib/adapters/http";
import { PermanentError, TransientError } from "@/lib/models/types";

// Runway adaptörü — gerçek API çağrılmaz (bu ortamda Runway alan adları kapalı ve anahtar yok). İstek biçimi Runway'in
// resmî SDK'sındaki (@runwayml/sdk 4.24.0) tiplerle aynıdır; sahte sunucu bu biçimi doğrular.
// Fiyatlar TEST DEĞERİDİR (12 kredi/sn, 0,01 $/kredi): Runway'in güncel fiyatı değildir, sahip Ayarlar'dan girer.

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    const c: Call = { url: String(input), method: init.method ?? "GET", headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PRICING = { creditsPerSecond: 12, usdPerCredit: 0.01 };
const photo = async (w = 1200, h = 1500) => (await sharp({ create: { width: w, height: h, channels: 3, background: { r: 18, g: 18, b: 18 } } }).jpeg({ quality: 92 }).toBuffer()).toString("base64");

describe("Runway adaptörü (sahte sunucu)", () => {
  it("ürün fotoğrafıyla image_to_video: resmî alanlar, başlıklar, ilk kare data URI, 9:16 → 720:1280, tamsayı süre; tahmini kredi kaydedilir", async () => {
    const { f, calls } = fakeFetch(() => json(200, { id: "task_abc-123", estimatedCost: { credits: 72 } }));
    const gen = new RunwayVideoGenerator("rw-secret", "gen4.5", PRICING, f);
    const b64 = await photo();
    const r = await gen.submit({ prompt: "Slow dolly-in on a model wearing the black FRIBEE tee, neon rim light.", durationS: 6.4, aspectRatio: "9:16", images: [{ base64: b64, mimeType: "image/jpeg" }, { base64: b64, mimeType: "image/jpeg" }] });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect([c.method, c.url]).toEqual(["POST", "https://api.dev.runwayml.com/v1/image_to_video"]);
    expect(c.headers).toMatchObject({ authorization: "Bearer rw-secret", "x-runway-version": RUNWAY_VERSION, "content-type": "application/json" });
    expect(Object.keys(c.body).sort()).toEqual(["duration", "model", "promptImage", "promptText", "ratio"]);
    expect(c.body).toMatchObject({ model: "gen4.5", ratio: "720:1280", duration: 6 });
    expect(c.body.promptImage).toBe(`data:image/jpeg;base64,${b64}`); // sığan fotoğraf bayt bayt aynen gider
    expect(c.body.promptText).toMatch(/^The first frame is a real FRIBEE product photo\. Keep the product exactly/);
    expect(c.body.promptText).toMatch(/black FRIBEE tee/);
    expect(r).toMatchObject({ externalId: "task_abc-123", request: { model: "gen4.5", api: "image_to_video", mode: "image_to_video", reference_images: 1, reference_transform: "none", provider_estimate_credits: 72, provider_estimate_usd: 0.72, parameters: { ratio: "720:1280", durationSeconds: 6 } } });
    expect(JSON.stringify(r.request)).not.toMatch(/rw-secret|base64,/);
  });

  it("fotoğrafsız sahne text_to_video; 16:9 → 1280:720; süre 2–10'a sıkıştırılır; istem 1000 birimi aşmaz", async () => {
    const { f, calls } = fakeFetch(() => json(200, { id: "t2", estimatedCost: { credits: 120 } }));
    const gen = new RunwayVideoGenerator("k", "gen4.5", PRICING, f);
    await gen.submit({ prompt: "Smoke and light. ".repeat(200), durationS: 14, aspectRatio: "16:9" });
    expect(calls[0].url).toBe("https://api.dev.runwayml.com/v1/text_to_video");
    expect(calls[0].body).toMatchObject({ model: "gen4.5", ratio: "1280:720", duration: 10 });
    expect(calls[0].body.promptImage).toBeUndefined();
    expect(calls[0].body.promptText.length).toBeLessThanOrEqual(RUNWAY_PROMPT_MAX);
    expect(runwayPrompt("x", true).length).toBeLessThanOrEqual(RUNWAY_PROMPT_MAX);
    await gen.submit({ prompt: "a", durationS: 1, aspectRatio: "9:16" });
    expect(calls[1].body.duration).toBe(2);
  });

  it("5 MB data URI sınırını aşan fotoğraf yeniden kodlanır (gerekirse küçültülür); sınıra sığan aynen gider", async () => {
    const noisy = await sharp(Buffer.from(Array.from({ length: 4000 * 3000 * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: 4000, height: 3000, channels: 3 } }).png().toBuffer();
    expect(noisy.toString("base64").length).toBeGreaterThan(RUNWAY_DATA_URI_MAX);
    const r = await runwayImageUri({ base64: noisy.toString("base64"), mimeType: "image/png" });
    expect(r.uri.length).toBeLessThanOrEqual(RUNWAY_DATA_URI_MAX);
    expect(r.uri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(["reencoded", "downscaled"]).toContain(r.transformed);
    const small = await photo();
    expect((await runwayImageUri({ base64: small, mimeType: "image/jpeg" })).transformed).toBe("none");
  });

  it("görev durumları: bekliyor/kısıtlı/çalışıyor → sürüyor (ilerleme), başarılı → gerçek kredi ücreti, başarısız → neden + ücret, iptal/404", async () => {
    const tasks: Record<string, unknown> = {
      p: { id: "p", status: "PENDING", createdAt: "x", estimatedCost: { credits: 72 } },
      th: { id: "th", status: "THROTTLED", createdAt: "x", estimatedCost: { credits: 72 } },
      r: { id: "r", status: "RUNNING", createdAt: "x", estimatedCost: { credits: 72 }, progress: 0.42 },
      s: { id: "s", status: "SUCCEEDED", createdAt: "x", cost: { credits: 60 }, output: ["https://cdn.example-runway-output.com/s.mp4?sig=1"] },
      f: { id: "f", status: "FAILED", createdAt: "x", cost: { credits: 0 }, failure: "Prompt rejected by moderation", failureCode: "SAFETY.INPUT.TEXT" },
      c: { id: "c", status: "CANCELLED", createdAt: "x", cost: { credits: 0 } },
      w: { id: "w", status: "WEIRD", createdAt: "x" },
    };
    const { f, calls } = fakeFetch((c) => {
      const id = c.url.split("/").pop()!;
      return tasks[id] ? json(200, tasks[id]) : json(404, { error: "Task not found" });
    });
    const gen = new RunwayVideoGenerator("k", "gen4.5", PRICING, f);
    expect(await gen.poll("p")).toEqual({ state: "running" });
    expect(await gen.poll("th")).toEqual({ state: "running" });
    expect(await gen.poll("r")).toEqual({ state: "running", progress: 0.42 });
    expect(await gen.poll("s")).toEqual({ state: "succeeded", videoUri: "runway-task:s", credits: 60, costUsd: 0.6 });
    expect(await gen.poll("f")).toMatchObject({ state: "failed", filtered: true, credits: 0, costUsd: 0, error: expect.stringMatching(/SAFETY\.INPUT\.TEXT.*moderation/) });
    expect(await gen.poll("c")).toMatchObject({ state: "failed", error: expect.stringMatching(/iptal/) });
    expect(await gen.poll("gone")).toMatchObject({ state: "failed", costUsd: null, error: expect.stringMatching(/bulunamadı/) });
    await expect(gen.poll("w")).rejects.toBeInstanceOf(TransientError);
    expect(calls.every((c) => c.method === "GET" && c.url.startsWith("https://api.dev.runwayml.com/v1/tasks/") && c.headers.authorization === "Bearer k")).toBe(true);
    await expect(gen.poll("../organization")).rejects.toBeInstanceOf(PermanentError);
  });

  it("indirme: görev yeniden sorgulanır (taze adres); imzalı adrese API anahtarı GÖNDERİLMEZ; HTTPS ve boyut sınırı", async () => {
    const mp4 = Buffer.from("fake-mp4-bytes-0123456789");
    const { f, calls } = fakeFetch((c) => {
      if (c.url.startsWith("https://api.dev.runwayml.com/v1/tasks/")) return json(200, { id: "s", status: "SUCCEEDED", cost: { credits: 60 }, output: ["https://cdn.example-runway-output.com/fresh.mp4?sig=2"] });
      if (c.url.startsWith("https://cdn.example-runway-output.com/")) return new Response(mp4, { status: 200, headers: { "content-length": String(mp4.length) } });
      return json(404, {});
    });
    const gen = new RunwayVideoGenerator("rw-secret", "gen4.5", PRICING, f);
    expect((await gen.download("runway-task:s", 1024)).equals(mp4)).toBe(true);
    const cdn = calls.find((c) => c.url.includes("cdn.example-runway-output.com"))!;
    expect(cdn.headers.authorization).toBeUndefined();
    expect(cdn.headers["x-runway-version"]).toBeUndefined();
    await expect(gen.download("runway-task:s", 10)).rejects.toThrow(/izin verilen boyuttan büyük/);
    await expect(gen.download("http://cdn.example-runway-output.com/x.mp4", 1024)).rejects.toThrow(/HTTPS/);
  });

  it("hata sınıfları: 400/401 kalıcı (ücret yok), 429 kabul edilmedi (geçici), 5xx ve ağ hatası BELİRSİZ (otomatik tekrar gönderilmez)", async () => {
    const send = (status: number) => new RunwayVideoGenerator("k", "gen4.5", PRICING, fakeFetch(() => json(status, { error: "x" })).f).submit({ prompt: "p", durationS: 5, aspectRatio: "9:16" });
    await expect(send(400)).rejects.toBeInstanceOf(PermanentError);
    await expect(send(401)).rejects.toBeInstanceOf(PermanentError);
    await expect(send(429)).rejects.toBeInstanceOf(TransientError);
    await expect(send(500)).rejects.toBeInstanceOf(UncertainOutcomeError);
    const down = new RunwayVideoGenerator("k", "gen4.5", PRICING, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
    await expect(down.submit({ prompt: "p", durationS: 5, aspectRatio: "9:16" })).rejects.toBeInstanceOf(UncertainOutcomeError);
    // Sorgu (GET) idempotenttir: 5xx geçici hatadır
    const poll500 = new RunwayVideoGenerator("k", "gen4.5", PRICING, fakeFetch(() => json(503, {})).f);
    await expect(poll500.poll("abc")).rejects.toBeInstanceOf(TransientError);
  });

  it("maliyet: kredi/saniye × süre × USD/kredi; fiyatın biri eksikse tahmin yok (ücretli üretim engellenir)", () => {
    expect(new RunwayVideoGenerator("k", "gen4.5", PRICING).estimateCostUsd(6)).toBeCloseTo(0.72);
    expect(new RunwayVideoGenerator("k", "gen4.5", PRICING).estimateCostUsd(30)).toBeCloseTo(1.2); // 10 sn'ye sıkıştırılır
    expect(new RunwayVideoGenerator("k", "gen4.5", { creditsPerSecond: null, usdPerCredit: 0.01 }).estimateCostUsd(6)).toBeNull();
    expect(new RunwayVideoGenerator("k", "gen4.5", { creditsPerSecond: 12, usdPerCredit: null }).estimateCostUsd(6)).toBeNull();
    expect(new RunwayVideoGenerator("k", "gen4.5", { creditsPerSecond: 12, usdPerCredit: null }).creditsToUsd(60)).toBeNull();
  });

  it("bağlantı testi yalnızca organizasyonu okur (video üretmez)", async () => {
    const { f, calls } = fakeFetch(() => json(200, { creditBalance: 1250, tier: { maxMonthlyCreditSpend: 0, models: {} }, usage: { models: {} } }));
    expect(await runwayOrganization("k", f)).toEqual({ creditBalance: 1250 });
    expect([calls[0].method, calls[0].url]).toEqual(["GET", "https://api.dev.runwayml.com/v1/organization"]);
  });
});
