import { describe, it, expect } from "vitest";
import { canonicalTheme, looksLikeMp4, planShots, premiumStage, verifyMp4, verifyReferences, type RefCandidate } from "@/lib/video/premium";
import type { VideoProbe } from "@/lib/media-analysis/video";

// Premium AI video kapıları — saf birim testleri (ağ, veritabanı veya ücretli çağrı yok).

const photo = (o: Partial<RefCandidate> & { id: string }): RefCandidate => ({
  kind: "photo", mime_type: "image/jpeg", origin: "real_photo", product_id: "p1", themes: [], tags: [], rights_status: "owned", ...o,
});
const map = (...xs: RefCandidate[]) => new Map<string, RefCandidate | null>(xs.map((x) => [x.id, x]));

describe("verifyReferences", () => {
  it("sıfır referansla metinden uydurma ürün videosuna izin vermez", () => {
    const r = verifyReferences([], new Map(), { productId: null, theme: "Space Alien" });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual([{ id: "(none)", reason: expect.stringMatching(/en az bir.*ürün fotoğrafı/) }]);
  });

  it("aynı ürüne ait gerçek fotoğrafları kabul eder", () => {
    const r = verifyReferences(["a", "b"], map(photo({ id: "a" }), photo({ id: "b", mime_type: "image/png" })), { productId: "p1" });
    expect(r).toEqual({ accepted: ["a", "b"], rejected: [] });
  });

  it("bulunamayan, video, AI üretimi, kurgu, başka ürün ve kısıtlı fotoğrafları reddeder", () => {
    const found = map(
      photo({ id: "v", kind: "video", mime_type: "video/mp4" }),
      photo({ id: "ai", origin: "ai_generated" }),
      photo({ id: "c", origin: "composed" }),
      photo({ id: "o", product_id: "p2" }),
      photo({ id: "r", rights_status: "restricted" }),
      photo({ id: "g", mime_type: "image/gif" }),
    );
    const r = verifyReferences(["missing", "v", "ai", "c", "o", "r", "g"], found, { productId: "p1" });
    expect(r.accepted).toEqual([]);
    expect(Object.fromEntries(r.rejected.map((x) => [x.id, x.reason]))).toMatchObject({
      missing: expect.stringMatching(/bulunamadı/), v: expect.stringMatching(/fotoğraf değil/), ai: expect.stringMatching(/ai_generated/),
      c: expect.stringMatching(/composed/), o: expect.stringMatching(/başka ürün/), r: expect.stringMatching(/kısıtlı/), g: expect.stringMatching(/biçim/),
    });
  });

  it("ürün belirsizse (ürünsüz/karışık) referans kabul edilmez", () => {
    const r = verifyReferences(["a"], map(photo({ id: "a", product_id: null })), { productId: null });
    expect(r.rejected[0].reason).toMatch(/ürünü belirsiz/);
  });

  it("Space Alien ile mandala (Music) karıştırılmaz; tema yoksa doğrulanmamış sayılır", () => {
    const found = map(
      photo({ id: "alien", themes: ["Space Alien"] }),
      photo({ id: "mandala", themes: ["mandala"] }),
      photo({ id: "none" }),
      photo({ id: "both", themes: ["alien", "music"] }),
      photo({ id: "tagged", tags: [{ tag: "tema: uzaylı", source: "owner" }] }),
      photo({ id: "systag", tags: [{ tag: "tema: uzaylı", source: "system" }] }),
    );
    const r = verifyReferences(["alien", "mandala", "none", "both", "tagged", "systag"], found, { productId: "p1", theme: "space alien" });
    expect(r.accepted).toEqual(["alien", "tagged"]);
    const why = Object.fromEntries(r.rejected.map((x) => [x.id, x.reason]));
    expect(why.mandala).toMatch(/music ≠ space_alien/);
    expect(why.none).toMatch(/doğrulanmamış/);
    expect(why.both).toMatch(/birden çok tema/);
    expect(why.systag).toMatch(/doğrulanmamış/); // sistem etiketi tema kanıtı sayılmaz
  });

  it("tema eş anlamlıları", () => {
    expect(canonicalTheme("Mandala")).toBe("music");
    expect(canonicalTheme("Müzik")).toBe("music");
    expect(canonicalTheme(" Space Alien ")).toBe("space_alien");
    expect(canonicalTheme("Retro")).toBe("retro");
  });
});

describe("premiumStage / planShots", () => {
  it("6–8 sn pilot tek çekimdir", () => {
    expect(premiumStage(6, 10, null)).toEqual({ ok: true, stage: "pilot", shots: [6] });
    expect(premiumStage(8, 10, null)).toEqual({ ok: true, stage: "pilot", shots: [8] });
  });

  it("15 sn master: pilot yoksa, doğrulanmamışsa veya onaysızsa reddedilir; aksi halde çok çekim", () => {
    expect(premiumStage(15, 10, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/pilot/) });
    expect(premiumStage(15, 10, { approved: true, verified: false })).toMatchObject({ ok: false, reason: expect.stringMatching(/doğrulamasından/) });
    expect(premiumStage(15, 10, { approved: false, verified: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/onaylanmadı/) });
    expect(premiumStage(15, 10, { approved: true, verified: true })).toEqual({ ok: true, stage: "master", shots: [8, 7] });
  });

  it("desteklenmeyen süreler kırpılmaz, reddedilir", () => {
    for (const d of [3, 5, 9, 10, 12, 16, NaN]) expect(premiumStage(d, 10, null).ok).toBe(false);
    expect(premiumStage(8, 6, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/tek çekim sınırını/) });
  });

  it("planShots süreyi sınır içinde eşit böler", () => {
    expect(planShots(15, 10)).toEqual([8, 7]);
    expect(planShots(15, 8)).toEqual([8, 7]);
    expect(planShots(15, 4)).toEqual([4, 4, 4, 3]);
    expect(planShots(6, 10)).toEqual([6]);
    expect(() => planShots(2, 10)).toThrow();
  });
});

describe("verifyMp4", () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(64)]);
  const probe = (o: Partial<VideoProbe> = {}): VideoProbe => ({
    duration: 6.02, width: 720, height: 1280, display_width: 720, display_height: 1280, rotation: 0, orientation: "portrait",
    fps: 24, video_codec: "h264", bitrate: 2_000_000, has_audio: true, audio_codec: "aac", ...o,
  });

  it("geçerli dikey MP4 ve indirme/önizleme meta verisi", () => {
    const r = verifyMp4(mp4, probe(), { durationS: 6, aspectRatio: "9:16" });
    expect(r.ok).toBe(true);
    expect(r.metadata).toMatchObject({ container: "mp4", mime_type: "video/mp4", bytes: mp4.length, codec: "h264", width: 720, height: 1280, has_audio: true, audio_codec: "aac" });
  });

  it("MP4 olmayan dosya, yanlış kodek, süre, oran ve istenen ses eksikliği yakalanır", () => {
    expect(looksLikeMp4(Buffer.from("RIFF0000WEBPVP8 "))).toBe(false);
    const r = verifyMp4(Buffer.from("RIFF0000WEBPVP8 "), probe({ video_codec: "gif", duration: 2, display_width: 1280, display_height: 720, has_audio: false }),
      { durationS: 6, aspectRatio: "9:16", requireAudio: true });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" | ")).toMatch(/ftyp.*kodeki.*en-boy.*süre.*ses izi/);
  });

  it("yalnızca dikeylik değil, doğru 9:16 oranı gerekir", () => {
    const r = verifyMp4(mp4, probe({ display_width: 900, display_height: 1280 }), { durationS: 6, aspectRatio: "9:16" });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" | ")).toMatch(/en-boy oranı/);
  });

  it("premium videoda ses izi yoksa reddedilir", () => {
    const r = verifyMp4(mp4, probe({ has_audio: false, audio_codec: null }), { durationS: 6, aspectRatio: "9:16", requireAudio: true });
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("ses izi yok");
  });

  it("ses istenmiyorsa sessiz video kabul edilir ama meta veride raporlanır", () => {
    const r = verifyMp4(mp4, probe({ has_audio: false, audio_codec: null }), { durationS: 6, aspectRatio: "9:16" });
    expect(r.ok).toBe(true);
    expect(r.metadata.has_audio).toBe(false);
  });
});
