import { describe, it, expect } from "vitest";
import { StrategySchema, ShopifyProposalSchema, DesignBriefSchema, VideoPlanSchema, SocialPackageSchema } from "@/lib/agents/schemas";
import { toStrictJsonSchema } from "@/lib/models/anthropic";

// Önceki sürümde kaydedilmiş çıktılar (yeni alanlar olmadan) düzenlenebilir kalmalı: yeni alanlar varsayılanla dolar.
describe("Şema geriye uyumluluğu", () => {
  it("eski biçimli çıktılar yeni şemalarla doğrulanır", () => {
    const s = StrategySchema.parse({
      summary: "s", audience_segments: [], positioning: "p", key_messages: [], content_themes: [], ad_ideas: [], unknowns: [],
      campaign: { name: "c", objective: "o", phases: [] },
    });
    expect(s.brand_analysis).toEqual({ strengths: [], gaps: [] });
    expect(s.assumptions).toEqual([]);

    expect(ShopifyProposalSchema.parse({ summary: "s", product_changes: [], collections: [], pages: [], bundles: [], unknowns: [] }).pdp_drafts).toEqual([]);

    const d = DesignBriefSchema.parse({ summary: "s", unknowns: [], briefs: [{
      id: "b", purpose: "post", format: "1:1", headline: "h", body_text: "", visual_direction: "", product_ids: [], source_asset_ids: [],
      use_real_product_photo: true, generation_prompt: "", notes: "",
    }] });
    expect(d.briefs[0].render_mode).toBe("photo_composition");
    expect(d.briefs[0].slides).toEqual([]);

    const v = VideoPlanSchema.parse({ summary: "s", unknowns: [], videos: [{
      id: "v", mode: "edit_existing", format: "9:16", duration_s: 10, selected_asset_ids: [], script: [], subtitles: [], generation_prompt: "", music_note: "",
    }] });
    expect(v.videos[0]).toMatchObject({ transition: "cut", framing: "fit", intro_text: "", outro_text: "" });

    const so = SocialPackageSchema.parse({ summary: "s", posts: [], unknowns: [] });
    expect(so).toMatchObject({ reels_ideas: [], tiktok_concepts: [], calendar_7d: [] });
  });

  it("modele gönderilen katı JSON şeması tüm alanları zorunlu tutar ve varsayılan içermez", () => {
    const js = toStrictJsonSchema(StrategySchema) as any;
    expect(js.required).toEqual(expect.arrayContaining(["brand_analysis", "assumptions", "unknowns"]));
    expect(JSON.stringify(js)).not.toMatch(/"default"/);
  });
});
