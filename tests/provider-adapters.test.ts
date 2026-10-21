import { describe, it, expect, afterEach, vi } from "vitest";
import { VeoGenerator, veoDuration } from "@/lib/adapters/video-generation";
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
  delete process.env.OPENAI_API_KEY;
});

describe("Veo (Gemini API) adaptörü — istek biçimi (sahte sunucu)", () => {
  const veo = new VeoGenerator("secret-key", "veo-3.1-fast-generate-preview", 0.15);

  it("predictLongRunning gövdesi, anahtar başlıkta, süre 4-8 sn aralığına yuvarlanır", async () => {
    const calls = stubFetch(() => json({ name: "models/veo-3.1-fast-generate-preview/operations/abc123" }));
    const r = await veo.submit({ prompt: "pan", durationS: 12, aspectRatio: "9:16", image: { base64: "AAAA", mimeType: "image/jpeg" } });
    expect(r.externalId).toBe("models/veo-3.1-fast-generate-preview/operations/abc123");
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
    expect(calls[0].url).not.toContain("secret-key");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ instances: [{ prompt: "pan", image: { bytesBase64Encoded: "AAAA", mimeType: "image/jpeg" } }], parameters: { aspectRatio: "9:16", durationSeconds: 8, resolution: "720p" } });
    expect(JSON.stringify(r.request)).not.toContain("secret-key");
    expect(JSON.stringify(r.request)).not.toContain("AAAA"); // fotoğraf baytı kayda yazılmaz
    expect(veoDuration(1)).toBe(4);
    expect(veo.estimateCostUsd(6)).toBeCloseTo(0.9);
  });

  it("gönderimde 5xx sonucu belirsizdir (otomatik tekrar yok)", async () => {
    stubFetch(() => json({ error: "boom" }, 503));
    await expect(veo.submit({ prompt: "p", durationS: 4, aspectRatio: "16:9" })).rejects.toBeInstanceOf(UncertainOutcomeError);
  });

  it("sorgu: sürüyor / tamamlandı / filtrelendi / hata", async () => {
    let n = 0;
    stubFetch(() => {
      n++;
      if (n === 1) return json({ name: "op", done: false });
      if (n === 2) return json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/f:download?alt=media" } }] } } });
      if (n === 3) return json({ done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["policy"] } } });
      return json({ done: true, error: { code: 400, message: "bad prompt" } });
    });
    expect(await veo.poll("models/x/operations/1")).toEqual({ state: "running" });
    expect(await veo.poll("models/x/operations/1")).toMatchObject({ state: "succeeded" });
    expect(await veo.poll("models/x/operations/1")).toMatchObject({ state: "failed", filtered: true });
    expect(await veo.poll("models/x/operations/1")).toMatchObject({ state: "failed", error: "400 bad prompt" });
    await expect(veo.poll("../../evil?x")).rejects.toThrow(/Geçersiz/);
  });

  it("indirme: anahtar yalnızca Google API alan adına gider; yönlendirilen depolama adresine gönderilmez; boyut sınırı", async () => {
    const calls = stubFetch((url) => {
      if (url.startsWith("https://generativelanguage.googleapis.com/")) return new Response(null, { status: 302, headers: { location: "https://storage.example.com/video.mp4?sig=1" } });
      return new Response(Buffer.from("videodata"), { status: 200 });
    });
    const buf = await veo.download("https://generativelanguage.googleapis.com/v1beta/files/f:download?alt=media", 1000);
    expect(buf.toString()).toBe("videodata");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
    expect((calls[1].init.headers as Record<string, string>)["x-goog-api-key"]).toBeUndefined();
    await expect(veo.download("https://generativelanguage.googleapis.com/v1beta/files/f", 3)).rejects.toThrow(/boyuttan büyük/);
    await expect(veo.download("http://insecure.example.com/x", 1000)).rejects.toThrow(/HTTPS/);
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
