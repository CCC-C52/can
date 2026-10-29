import { describe, it, expect } from "vitest";
import { createBrand } from "@/lib/services/brands";
import { buildBrandContext } from "@/lib/agents/context";
import { runRuleChecks } from "@/lib/agents/qa-rules";

const post = (caption: string) => ({ summary: "s", unknowns: [], reels_ideas: [], tiktok_concepts: [], calendar_7d: [], posts: [{ id: "p1", platform: "instagram", format: "feed", caption, hashtags: [], cta: "Shop now", suggested_datetime: "2026-11-01T10:00:00Z", media_refs: [], cover_text: "" }] });

describe("İçerik dili kontrolü", () => {
  it("Türkçe marka adı İngilizce metni yanlış işaretlemez; gerçek Türkçe metin yine yakalanır", async () => {
    const b = await createBrand({ name: "Güneşli Çarşı Atölyesi", content_language: "en" });
    const ctx = await buildBrandContext(b.id);
    const lang = (c: any) => runRuleChecks("social", c, ctx, { isDemo: false }).checks.find((x) => x.name === "İçerik dili")!;
    expect(lang(post("Güneşli Çarşı Atölyesi: new season essentials are here, made for everyday comfort and easy styling.")).status).toBe("pass");
    expect(lang(post("Yeni sezon ürünlerimiz geldi, hemen keşfedin ve size en uygun olanı seçin, bu fırsatı kaçırmayın.")).status).toBe("fail");
  });

  it("çevrilecek metinler açıkça yazılır; iç strateji belgesi dil yüzünden durdurulmaz", async () => {
    const b = await createBrand({ name: "Dil Testi", content_language: "en" });
    const ctx = await buildBrandContext(b.id);
    const tr = "Yeni sezon ürünlerimiz geldi, hemen keşfedin ve size en uygun olanı seçin.";
    const r = runRuleChecks("social", post(tr), ctx, { isDemo: false });
    expect(r.required_changes.join(" ")).toMatch(/'en' diline çevirin \(1 metin\): “Yeni sezon ürünlerimiz geldi/);

    const strategy = {
      summary: "Özet", audience_segments: [], positioning: "Konum", content_themes: [], assumptions: [], unknowns: [],
      key_messages: ["Dört koleksiyon tek bir hikâyede yeniden doğuyor ve bu çok güçlü bir mesaj.", "Her tişört bir evrenin kapısı, bu yüzden hemen keşfet."],
      ad_ideas: [{ platform: "instagram", format: "reels", hook: "Karanlıktan ışığa: yeni bir başlangıç için hazır ol.", audience: "x", budget_note: "x" }],
      campaign: { name: "Rebirth", objective: "x", phases: [] },
    };
    const m = runRuleChecks("marketing", strategy, ctx, { isDemo: false });
    expect(m.checks.find((x) => x.name === "İçerik dili")).toMatchObject({ status: "warn" });
    expect(m.required_changes.join(" ")).not.toMatch(/diline çevirin/);
  });
});
