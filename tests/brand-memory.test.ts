import { describe, it, expect, beforeAll } from "vitest";
import { createBrand } from "@/lib/services/brands";
import { addMemory, listMemory, looksSecret, setMemoryStatus, MemoryValidationError } from "@/lib/services/brand-memory";
import { buildBrandContext } from "@/lib/agents/context";
import { userPromptParts } from "@/lib/agents/prompts";
import { addVersion, createOutput, decide } from "@/lib/services/outputs";

let a: string;
let b: string;

beforeAll(async () => {
  a = (await createBrand({ name: `Mem A ${Date.now()}` })).id;
  b = (await createBrand({ name: `Mem B ${Date.now()}` })).id;
});

describe("Marka hafızası", () => {
  it("etkin kayıt yalnızca kendi markasının bağlamına girer (marka yalıtımı)", async () => {
    await addMemory(a, { kind: "guideline", title: "Renk düzeltme yok", body: "Ürün renkleri asla değiştirilmez." });
    const ctxA = await buildBrandContext(a, undefined, { agent: "design" });
    const ctxB = await buildBrandContext(b, undefined, { agent: "design" });
    expect(ctxA.brand.memory.map((m) => m.title)).toContain("Renk düzeltme yok");
    expect(ctxB.brand.memory).toEqual([]);
    // Önbelleğe alınan önek (marka bağlamı) içinde ve <data> etiketiyle verilir
    const { prefix } = userPromptParts({ instruction: "x", ctx: ctxA });
    expect(prefix).toContain("Renk düzeltme yok");
    expect(prefix.startsWith("<brand_context>\n<data>")).toBe(true);
  });

  it("ajana özel kayıt yalnızca o ajana verilir; öneri ve arşiv kayıtları hiç verilmez", async () => {
    await addMemory(a, { kind: "agent_instruction", agent: "video", title: "Videolar 15 sn", body: "Reels en fazla 15 saniye." });
    await addMemory(a, { kind: "lesson", title: "Öneri kaydı", body: "Henüz onaylanmadı.", status: "proposed" });
    const arch = await addMemory(a, { kind: "lesson", title: "Arşiv kaydı", body: "Eski." });
    await setMemoryStatus(a, arch.id, "archived");
    const video = (await buildBrandContext(a, undefined, { agent: "video" })).brand.memory.map((m) => m.title);
    const social = (await buildBrandContext(a, undefined, { agent: "social" })).brand.memory.map((m) => m.title);
    expect(video).toContain("Videolar 15 sn");
    expect(social).not.toContain("Videolar 15 sn");
    for (const t of [video, social]) {
      expect(t).not.toContain("Öneri kaydı");
      expect(t).not.toContain("Arşiv kaydı");
    }
  });

  it("başka markanın kaydı değiştirilemez", async () => {
    const m = await addMemory(a, { kind: "preference", title: "Ton", body: "Samimi." });
    await expect(setMemoryStatus(b, m.id, "archived")).rejects.toBeInstanceOf(MemoryValidationError);
    expect((await listMemory(a)).find((x) => x.id === m.id)?.status).toBe("active");
  });

  it("gizli bilgi içeren metin kaydedilmez", async () => {
    expect(looksSecret("api_key=sk-ant-abcdefghijklmnop")).toBe(true);
    expect(looksSecret("Şifre: Hunter2024!")).toBe(true);
    expect(looksSecret("Kart 4111 1111 1111 1111")).toBe(true);
    expect(looksSecret("Kampanya 1 Kasım - 30 Kasım arası, 2 ürün")).toBe(false);
    await expect(addMemory(a, { kind: "guideline", title: "Anahtar", body: "password: supersecret123" })).rejects.toBeInstanceOf(MemoryValidationError);
  });

  it("ret notu, etkin olmayan bir ders önerisine dönüşür; sahip etkinleştirince bağlama girer", async () => {
    const out = await createOutput({ brandId: a, projectId: null, taskId: null, agent: "social", kind: "social_package", title: "Lansman paketi" });
    const v = await addVersion({ brandId: a, outputId: out.id, content: { posts: [] }, createdBy: "agent:social", generator: "test", isDemo: true });
    const approval = await decide(a, v.id, "rejected", { note: "Emoji kullanma, daha sade ve kısa yaz." });
    const proposal = (await listMemory(a, { status: "proposed" })).find((m) => m.source_ref === approval.id);
    expect(proposal).toBeDefined();
    expect(proposal!.source).toBe("rejection");
    expect(proposal!.agent).toBe("social");
    expect((await buildBrandContext(a, undefined, { agent: "social" })).brand.memory.map((m) => m.body)).not.toContain("Emoji kullanma, daha sade ve kısa yaz.");
    await setMemoryStatus(a, proposal!.id, "active");
    expect((await buildBrandContext(a, undefined, { agent: "social" })).brand.memory.map((m) => m.body)).toContain("Emoji kullanma, daha sade ve kısa yaz.");
  });

  it("kısa veya gizli bilgi içeren ret notundan öneri oluşturulmaz", async () => {
    const out = await createOutput({ brandId: b, projectId: null, taskId: null, agent: "social", kind: "social_package", title: "P" });
    const v1 = await addVersion({ brandId: b, outputId: out.id, content: { posts: [1] }, createdBy: "agent:social", generator: "test", isDemo: true });
    await decide(b, v1.id, "rejected", { note: "kötü" });
    const v2 = await addVersion({ brandId: b, outputId: out.id, content: { posts: [2] }, createdBy: "agent:social", generator: "test", isDemo: true });
    await decide(b, v2.id, "rejected", { note: "Shopify token=shpat_abcdef1234567890 ile güncelle" });
    expect(await listMemory(b)).toEqual([]);
  });
});
