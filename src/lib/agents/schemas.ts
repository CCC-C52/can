import { z } from "zod";

// Yapılandırılmış çıktı şemaları. Model çıktısı bu şemalarla doğrulanmadan kaydedilmez.
// Anthropic structured outputs ile uyum için şemalar sade tutulur (nesne/dizi/metin/sayı/enum).

export const SPECIALISTS = ["marketing", "shopify", "design", "video", "social", "quality"] as const;
export type SpecialistId = (typeof SPECIALISTS)[number];
export type AgentId = "manager" | SpecialistId;

export const PlanSchema = z.object({
  reply: z.string().describe("Kullanıcıya Türkçe kısa yanıt: ne anladın, ne yapacaksın"),
  goals: z.array(z.string()).describe("Talimattan çıkarılan hedefler (Türkçe)"),
  questions_for_owner: z
    .array(z.string())
    .describe("İşi doğru yapmak için sahipten öğrenilmesi gereken eksik bilgiler (Türkçe). Yoksa boş dizi."),
  tasks: z
    .array(
      z.object({
        key: z.string().describe("Kısa, benzersiz anahtar, ör. strategy, pdp, visuals"),
        agent: z.enum(SPECIALISTS),
        title: z.string().describe("Görev başlığı (Türkçe)"),
        instruction: z.string().describe("Uzmana net görev talimatı"),
        depends_on: z.array(z.string()).describe("Önce bitmesi gereken görev anahtarları"),
      }),
    )
    .describe("Görevler; bağımsız olanlar paralel çalışır"),
});
export type Plan = z.infer<typeof PlanSchema>;

const Unknowns = z.array(z.string()).describe("Eksik/bilinmeyen bilgiler; uydurmak yerine buraya yaz");

export const StrategySchema = z.object({
  summary: z.string(),
  audience_segments: z.array(
    z.object({
      segment: z.string(),
      needs: z.string(),
      basis: z.enum(["brand_data", "assumption"]).describe("brand_data: marka kaydına dayanır; assumption: varsayım"),
    }),
  ),
  positioning: z.string(),
  key_messages: z.array(z.string()),
  campaign: z.object({
    name: z.string(),
    objective: z.string(),
    phases: z.array(z.object({ name: z.string(), timing: z.string(), actions: z.array(z.string()) })),
  }),
  content_themes: z.array(z.string()),
  ad_ideas: z.array(
    z.object({ platform: z.string(), format: z.string(), hook: z.string(), audience: z.string(), budget_note: z.string() }),
  ),
  unknowns: Unknowns,
});

export const SHOPIFY_FIELDS = ["title", "description", "product_type", "tags", "price", "compare_at_price"] as const;

export const ShopifyProposalSchema = z.object({
  summary: z.string(),
  product_changes: z.array(
    z.object({
      product_id: z.string(),
      field: z.enum(SHOPIFY_FIELDS),
      current_value: z.string().describe("Kayıttaki mevcut değer; yoksa boş"),
      proposed_value: z.string(),
      reason: z.string(),
    }),
  ),
  collections: z.array(
    z.object({ title: z.string(), description: z.string(), rule_summary: z.string(), product_ids: z.array(z.string()) }),
  ),
  pages: z.array(z.object({ title: z.string(), purpose: z.string(), body: z.string() })),
  bundles: z.array(
    z.object({ name: z.string(), product_ids: z.array(z.string()), rationale: z.string(), pricing_note: z.string() }),
  ),
  unknowns: Unknowns,
});

export const DesignBriefSchema = z.object({
  summary: z.string(),
  briefs: z.array(
    z.object({
      id: z.string(),
      purpose: z.enum(["post", "cover", "ad", "story", "banner"]),
      format: z.enum(["1:1", "4:5", "9:16", "16:9"]),
      headline: z.string(),
      body_text: z.string(),
      visual_direction: z.string(),
      product_ids: z.array(z.string()),
      source_asset_ids: z.array(z.string()).describe("Arşivdeki gerçek ürün fotoğrafları"),
      use_real_product_photo: z.boolean(),
      generation_prompt: z.string().describe("Görsel üretim aracı için İngilizce istem"),
      notes: z.string(),
    }),
  ),
  unknowns: Unknowns,
});

export const VideoPlanSchema = z.object({
  summary: z.string(),
  videos: z.array(
    z.object({
      id: z.string(),
      mode: z.enum(["edit_existing", "generate_new"]).describe("Mevcut çekimi düzenleme ile yeni AI görüntüsü ayrı işlemlerdir"),
      format: z.enum(["9:16", "1:1", "16:9", "4:5"]),
      duration_s: z.number(),
      selected_asset_ids: z.array(z.string()),
      script: z.array(
        z.object({ t_start: z.number(), t_end: z.number(), visual: z.string(), voiceover: z.string(), on_screen_text: z.string() }),
      ),
      subtitles: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
      generation_prompt: z.string().describe("Yalnızca generate_new için; aksi halde boş"),
      music_note: z.string(),
    }),
  ),
  unknowns: Unknowns,
});

export const SocialPackageSchema = z.object({
  summary: z.string(),
  posts: z.array(
    z.object({
      id: z.string(),
      platform: z.enum(["instagram", "tiktok", "facebook"]),
      format: z.enum(["feed", "reel", "story", "carousel", "video"]),
      caption: z.string(),
      hashtags: z.array(z.string()),
      cta: z.string(),
      suggested_datetime: z.string().describe("ISO 8601"),
      media_refs: z.array(z.string()).describe("Tasarım brief kimlikleri, video kimlikleri veya medya kimlikleri"),
      cover_text: z.string(),
    }),
  ),
  unknowns: Unknowns,
});

export const QaReviewSchema = z.object({
  verdict: z.enum(["pass", "needs_changes", "fail"]),
  score: z.number().describe("0-100"),
  checks: z.array(z.object({ name: z.string(), status: z.enum(["pass", "warn", "fail"]), detail: z.string() })),
  required_changes: z.array(z.string()),
});
export type QaReview = z.infer<typeof QaReviewSchema>;

export const ReportSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  completed: z.array(z.string()),
  pending_approvals: z.array(z.string()),
  problems: z.array(z.string()),
  missing_connections: z.array(z.string()),
  next_steps: z.array(z.string()),
});

export const OUTPUT_SCHEMAS = {
  marketing: StrategySchema,
  shopify: ShopifyProposalSchema,
  design: DesignBriefSchema,
  video: VideoPlanSchema,
  social: SocialPackageSchema,
  quality: QaReviewSchema,
} as const;

export const OUTPUT_KIND: Record<SpecialistId, string> = {
  marketing: "strategy",
  shopify: "shopify_proposal",
  design: "design_brief",
  video: "video_plan",
  social: "social_package",
  quality: "qa_report",
};

export type StrategyOutput = z.infer<typeof StrategySchema>;
export type ShopifyProposal = z.infer<typeof ShopifyProposalSchema>;
export type DesignBriefOutput = z.infer<typeof DesignBriefSchema>;
export type VideoPlanOutput = z.infer<typeof VideoPlanSchema>;
export type SocialPackage = z.infer<typeof SocialPackageSchema>;
export type ProjectReport = z.infer<typeof ReportSchema>;
