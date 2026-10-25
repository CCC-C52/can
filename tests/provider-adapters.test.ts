import { describe, it, expect, afterEach, vi } from "vitest";
import { GeminiOmniVideoGenerator, OMNI_MAX_SECONDS, VeoGenerator, generatedVideoIssues, getVideoGenerator, omniAspect, omniDuration, testGeminiOmniVideo, testVeo, veoDuration } from "@/lib/adapters/video-generation";
import { config } from "@/lib/config";
import { OpenAIImageGenerator } from "@/lib/adapters/images";
import { UncertainOutcomeError } from "@/lib/adapters/http";

type Call = { url: string; init: RequestInit };
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  return calls;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GEMINI_VIDEO_MODEL", "GEMINI_VIDEO_COST_PER_SECOND_USD", "VEO_MODEL", "VEO_COST_PER_SECOND_USD"]) delete process.env[k];
});

describe("AI video kalite kapısı (generatedVideoIssues)", () => {
  const ok = { probe: { duration: 6.02, display_width: 720, display_height: 1280, video_codec: "h264", has_audio: true }, decoded: true, audioMeanDb: -21 };
  const pilot = { durationS: 6, aspectRatio: "9:16" as const, requireAudio: true };

  it("6 sn 720p dikey, çözülebilir, duyulabilir sesli pilot geçer", () => {
    expect(generatedVideoIssues(ok, pilot)).toEqual([]);
  });

  it("çözülemeyen, kısa, yanlış yönlü, düşük çözünürlüklü, sessiz video reddedilir", () => {
    expect(generatedVideoIssues({ ...ok, decoded: false }, pilot)).toEqual([expect.stringMatching(/çözülemedi/)]);
    expect(generatedVideoIssues({ ...ok, probe: { ...ok.probe, duration: 2 } }, pilot)).toEqual([expect.stringMatching(/süre 2 sn, istenen 6/)]);
    expect(generatedVideoIssues({ ...ok, probe: { ...ok.probe, display_width: 1280, display_height: 720 } }, pilot)).toEqual([expect.stringMatching(/yön uyuşmuyor/)]);
    expect(generatedVideoIssues({ ...ok, probe: { ...ok.probe, display_width: 480, display_height: 854 } }, pilot)).toEqual([expect.stringMatching(/çözünürlük düşük/)]);
    expect(generatedVideoIssues({ ...ok, probe: { ...ok.probe, has_audio: false }, audioMeanDb: null }, pilot)).toEqual(["ses akışı yok"]);
    expect(generatedVideoIssues({ ...ok, audioMeanDb: -91 }, pilot)).toEqual([expect.stringMatching(/ses duyulmuyor/)]);
    expect(generatedVideoIssues({ ...ok, probe: { ...ok.probe, has_audio: false } }, { ...pilot, requireAudio: false })).toEqual([]);
  });

  it("15 sn final tek üretimle istenemez: süre sağlayıcı sınırına (10 sn) kırpılır", () => {
    expect(omniDuration(15)).toBe(OMNI_MAX_SECONDS);
    expect([6, 7, 8].map(omniDuration)).toEqual([6, 7, 8]);
  });
});

describe("Gemini Omni Flash video adaptörü — Interactions API (sahte sunucu)", () => {
  const omni = new GeminiOmniVideoGenerator("secret-key", "gemini-omni-1.1-flash", 0.1);
  const img = (b: string) => ({ base64: b, mimeType: "image/jpeg" });

  it("model yapılandırması: varsayılan gemini-omni-1.1-flash, GEMINI_VIDEO_MODEL ile değişir, eski VEO_* okunmaz", () => {
    process.env.VEO_MODEL = "veo-3.1-fast-generate-preview";
    process.env.VEO_COST_PER_SECOND_USD = "0.15";
    expect(config.gemini.videoModel).toBe("gemini-omni-1.1-flash");
    expect(config.gemini.veoModel).toBe("gemini-omni-1.1-flash"); // eski ad (uyumluluk)
    expect(config.gemini.costPerSecondUsd).toBeNull(); // eski fiyat yeni modele uygulanmaz → üretim engellenir
    process.env.GEMINI_VIDEO_MODEL = "gemini-omni-1.2-flash";
    process.env.GEMINI_VIDEO_COST_PER_SECOND_USD = "0.12";
    expect(config.gemini.videoModel).toBe("gemini-omni-1.2-flash");
    expect(config.gemini.costPerSecondUsd).toBe(0.12);
    process.env.GEMINI_VIDEO_COST_PER_SECOND_USD = "abc";
    expect(config.gemini.costPerSecondUsd).toBeNull();
    process.env.GEMINI_API_KEY = "k";
    delete process.env.GEMINI_VIDEO_MODEL;
    expect(getVideoGenerator()).toBeInstanceOf(GeminiOmniVideoGenerator);
    expect(getVideoGenerator()!.model).toBe("gemini-omni-1.1-flash");
    expect(getVideoGenerator()!.service).toBe("video_generation"); // sağlayıcı adı değişmedi (maliyet kayıtları uyumlu)
    expect(VeoGenerator).toBe(GeminiOmniVideoGenerator); // eski içe aktarmalar kırılmaz
  });

  it("maliyet tahmini: süre 3-10 sn aralığına yuvarlanır; fiyat yoksa bilinmiyor", () => {
    expect(omniDuration(1)).toBe(3);
    expect(omniDuration(6.4)).toBe(6);
    expect(omniDuration(15)).toBe(10);
    expect(veoDuration).toBe(omniDuration);
    expect(omni.estimateCostUsd(6)).toBeCloseTo(0.6);
    expect(omni.estimateCostUsd(30)).toBeCloseTo(1.0);
    expect(omni.estimateCostUsd(1)).toBeCloseTo(0.3);
    expect(new GeminiOmniVideoGenerator("k", "m", null).estimateCostUsd(6)).toBeNull();
    expect(omniAspect("16:9")).toBe("16:9");
    expect(omniAspect("4:5")).toBe("9:16");
  });

  it("text_to_video: POST /v1beta/interactions, arka planda, 720p, anahtar başlıkta; predictLongRunning kullanılmaz", async () => {
    const calls = stubFetch(() => json({ id: "v1_abc", status: "in_progress" }));
    const r = await omni.submit({ prompt: "Neon city at night", durationS: 12, aspectRatio: "16:9" });
    expect(r.externalId).toBe("v1_abc");
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(calls[0].url).not.toContain("predictLongRunning");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
    expect(calls[0].url).not.toContain("secret-key");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      model: "gemini-omni-1.1-flash", input: "Neon city at night", background: true, store: true,
      response_format: { type: "video", aspect_ratio: "16:9", duration: "10s", resolution: "720p" },
    });
    expect(r.request).toMatchObject({ mode: "text_to_video", reference_images: 0, parameters: { durationSeconds: 10, aspectRatio: "16:9", resolution: "720p" } });
  });

  it("image_to_video ve reference_to_video: ürün fotoğrafları gönderilir, baskı/renk/logo/oran korunması istenir; bayt kayda yazılmaz", async () => {
    const calls = stubFetch(() => json({ id: "v1_img", status: "queued" }));
    const one = await omni.submit({ prompt: "Slow orbit", durationS: 6, aspectRatio: "9:16", image: img("AAAA") });
    const b1 = JSON.parse(String(calls[0].init.body));
    expect(b1.input).toEqual([
      { type: "text", text: expect.stringContaining("first frame") },
      { type: "image", data: "AAAA", mime_type: "image/jpeg" },
    ]);
    expect(b1.input[0].text).toMatch(/FRIBEE/);
    expect(b1.input[0].text).toMatch(/print/);
    expect(b1.input[0].text).toMatch(/colours/);
    expect(b1.input[0].text).toMatch(/logo/);
    expect(b1.input[0].text).toMatch(/proportions/);
    expect(b1.input[0].text).toContain("Slow orbit");
    expect(one.request).toMatchObject({ mode: "image_to_video", reference_image: true, reference_images: 1 });

    const many = await omni.submit({ prompt: "Street style", durationS: 8, aspectRatio: "9:16", images: [img("B1"), img("B2"), img("B3"), img("B4")] });
    const b2 = JSON.parse(String(calls[1].init.body));
    expect(b2.input.filter((c: any) => c.type === "image").map((c: any) => c.data)).toEqual(["B1", "B2", "B3"]); // en fazla 3 referans
    expect(b2.input[0].text).toMatch(/reference images of the same product/);
    expect(many.request).toMatchObject({ mode: "reference_to_video", reference_images: 3 });
    for (const r of [one, many]) {
      expect(JSON.stringify(r.request)).not.toMatch(/AAAA|B1|B2|secret-key/);
    }
  });

  it("gönderimde 5xx veya ağ hatası sonucu belirsizdir (otomatik tekrar yok); kimliksiz yanıt reddedilir", async () => {
    stubFetch(() => json({ error: "boom" }, 503));
    await expect(omni.submit({ prompt: "p", durationS: 4, aspectRatio: "16:9" })).rejects.toBeInstanceOf(UncertainOutcomeError);
    vi.unstubAllGlobals();
    stubFetch(() => { throw new TypeError("socket hang up"); });
    await expect(omni.submit({ prompt: "p", durationS: 4, aspectRatio: "16:9" })).rejects.toBeInstanceOf(UncertainOutcomeError);
    vi.unstubAllGlobals();
    stubFetch(() => json({ status: "in_progress" }));
    await expect(omni.submit({ prompt: "p", durationS: 4, aspectRatio: "16:9" })).rejects.toThrow(/kimliği döndürmedi/);
  });

  it("sorgu: sıradaki/süren, tamamlandı (satır içi veya dosya adresi), başarısız sağlayıcı yanıtları", async () => {
    const responses = [
      { id: "v1_x", status: "queued" },
      { id: "v1_x", status: "in_progress" },
      { id: "v1_x", status: "completed", steps: [{ type: "user_input", content: [{ type: "text", text: "p" }] }, { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: "AAAA" }] }] },
      { id: "v1_x", status: "completed", steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", uri: "files/abc:download?alt=media" }] }] },
      { id: "v1_x", status: "failed", errors: [{ message: "Request blocked by safety policy" }] },
      { id: "v1_x", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "I cannot" }] }] },
      { id: "v1_x", status: "budget_exceeded" },
    ];
    let n = 0;
    const calls = stubFetch(() => json(responses[n++]));
    expect(await omni.poll("v1_x")).toEqual({ state: "running" });
    expect(await omni.poll("v1_x")).toEqual({ state: "running" });
    expect(await omni.poll("v1_x")).toEqual({ state: "succeeded", videoUri: "interaction:v1_x" }); // bayt kayda yazılmaz
    expect(await omni.poll("v1_x")).toEqual({ state: "succeeded", videoUri: "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media" });
    expect(await omni.poll("v1_x")).toMatchObject({ state: "failed", filtered: true, error: expect.stringMatching(/safety policy/) });
    expect(await omni.poll("v1_x")).toMatchObject({ state: "failed", error: "İşlem tamamlandı ama video döndürmedi." });
    expect(await omni.poll("v1_x")).toMatchObject({ state: "failed", error: expect.stringMatching(/budget_exceeded/) });
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions/v1_x");
    expect(calls[0].init.method ?? "GET").toBe("GET");
    await expect(omni.poll("../../evil?x")).rejects.toThrow(/Geçersiz/);
  });

  it("başarılı MP4: satır içi veri çözülür ve boyut sınırı uygulanır", async () => {
    const mp4 = Buffer.from("fake-mp4-bytes");
    stubFetch(() => json({ id: "v1_ok", status: "completed", steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: mp4.toString("base64") }] }] }));
    expect((await omni.download("interaction:v1_ok", 1000)).equals(mp4)).toBe(true);
    await expect(omni.download("interaction:v1_ok", 4)).rejects.toThrow(/boyuttan büyük/);
    vi.unstubAllGlobals();
    stubFetch(() => json({ id: "v1_gone", status: "completed", steps: [] }));
    await expect(omni.download("interaction:v1_gone", 1000)).rejects.toThrow(/video bulunamadı/);
  });

  it("dosya adresinden indirme: anahtar yalnızca Google API alan adına gider; yönlendirilen depolama adresine gönderilmez", async () => {
    const calls = stubFetch((url) => {
      if (url.startsWith("https://generativelanguage.googleapis.com/")) return new Response(null, { status: 302, headers: { location: "https://storage.example.com/video.mp4?sig=1" } });
      return new Response(Buffer.from("videodata"), { status: 200 });
    });
    const buf = await omni.download("https://generativelanguage.googleapis.com/v1beta/files/f:download?alt=media", 1000);
    expect(buf.toString()).toBe("videodata");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
    expect((calls[1].init.headers as Record<string, string>)["x-goog-api-key"]).toBeUndefined();
    await expect(omni.download("https://generativelanguage.googleapis.com/v1beta/files/f", 3)).rejects.toThrow(/boyuttan büyük/);
    await expect(omni.download("http://insecure.example.com/x", 1000)).rejects.toThrow(/HTTPS/);
  });

  it("bağlantı testi yalnızca model erişimini okur; video üretmez", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const calls = stubFetch(() => json({ name: "models/gemini-omni-1.1-flash" }));
    const r = await testGeminiOmniVideo();
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/gemini-omni-1.1-flash/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-omni-1.1-flash");
    expect(calls[0].init.method ?? "GET").toBe("GET");
    expect(calls.some((c) => c.url.includes("/interactions"))).toBe(false);
    expect(testVeo).toBe(testGeminiOmniVideo);
    delete process.env.GEMINI_API_KEY;
    expect(await testGeminiOmniVideo()).toMatchObject({ ok: false, detail: expect.stringMatching(/GEMINI_API_KEY/) });
  });
});

describe("OpenAI Images adaptörü — istek biçimi (sahte sunucu)", () => {
  it("referans fotoğrafla /images/edits (multipart, input_fidelity=high); referanssız /images/generations", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const png = Buffer.from("iVBORw0KGgo=", "base64");
    const calls = stubFetch(() => json({ data: [{ b64_json: png.toString("base64") }] }));
    const g = new OpenAIImageGenerator();
    await g.generate("prompt", "1024x1536", [{ buffer: Buffer.from("jpeg"), mime: "image/jpeg", filename: "ref.jpg" }]);
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/edits");
    const form = calls[0].init.body as FormData;
    expect(form.get("input_fidelity")).toBe("high");
    expect(form.get("size")).toBe("1024x1536");
    expect((form.getAll("image[]")[0] as File).name).toBe("ref.jpg");
    await g.generate("prompt", "1024x1024");
    expect(calls[1].url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ prompt: "prompt", size: "1024x1024", n: 1 });
  });
});
