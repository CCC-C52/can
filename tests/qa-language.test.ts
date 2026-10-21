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
});
