import { z } from "zod";

// Yapılandırılmış çıktı şemaları. Model çıktısı bu şemalarla doğrulanmadan kaydedilmez.
// Anthropic structured outputs ile uyum için şemalar sade tutulur (nesne/dizi/metin/sayı/enum).

export const SPECIALISTS = ["marketing", "shopify", "design", "video", "social", "quality", "pr", "finance"] as const;
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
  awaiting_approval: z
    .boolean()
    .optional()
    .describe("true: sahip planı önce görmek/onaylamak istedi. Görevler öneri olarak saklanır; sahip onaylayınca başlar. Aksi halde false."),
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
  brand_analysis: z.object({
    strengths: z.array(z.object({ point: z.string(), basis: z.enum(["brand_data", "assumption"]) })),
    gaps: z.array(z.string()).describe("Marka kaydındaki eksikler veya zayıf noktalar"),
  }).default({ strengths: [], gaps: [] }),
  competitor_framework: z.object({
    criteria: z.array(z.string()).describe("Rakip karşılaştırma kriterleri"),
    competitors_to_research: z.array(z.string()).describe("YALNIZCA sahibin verdiği veya kayıttaki rakip adları; yoksa boş"),
    questions: z.array(z.string()),
  }).default({ criteria: [], competitors_to_research: [], questions: [] }),
  organic_strategy: z.object({
    pillars: z.array(z.string()),
    posting_frequency: z.string().describe("Öneri; kesin performans vaadi değil"),
    channels: z.array(z.object({ platform: z.string(), role: z.string() })),
  }).default({ pillars: [], posting_frequency: "", channels: [] }),
  performance_recommendations: z.array(z.object({ metric: z.string(), how_to_measure: z.string(), note: z.string().describe("Uydurma hedef rakam yazma") })).default([]),
  assumptions: z.array(z.string()).describe("Doğrulanmış veriden ayrı tutulan varsayımlar").default([]),
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
  pdp_drafts: z.array(z.object({
    product_id: z.string(),
    headline: z.string(),
    body: z.string(),
    bullet_points: z.array(z.string()).describe("Yalnızca doğrulanmış özellikler"),
    seo_title: z.string(),
    seo_description: z.string(),
  })).default([]),
  unknowns: Unknowns,
});

export const DesignBriefSchema = z.object({
  summary: z.string(),
  briefs: z.array(
    z.object({
      id: z.string(),
      purpose: z.enum(["post", "cover", "ad", "story", "banner", "carousel", "reel_cover", "launch"]),
      render_mode: z.enum(["photo_composition", "typography", "ai_image"]).describe("photo_composition: arşivdeki gerçek ürün fotoğrafı + metin; typography: yalnızca marka renkleri ve metin; ai_image: AI görsel servisi (ürünü değiştirmez)").default("photo_composition"),
      slides: z.array(z.object({ headline: z.string(), body_text: z.string() })).describe("Yalnızca carousel için; ilk slayt dışındaki slaytlar").default([]),
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
      mode: z.enum(["edit_existing", "generate_new", "compose"]).describe("edit_existing: arşiv çekiminden kurgu; generate_new: tek bir AI video sahnesi (Gemini Omni, 3-10 sn); compose: AI sahnelerini, gerçek ürün fotoğraflarını ve arşiv sahnelerini tek reklamda birleştiren son kurgu"),
      format: z.enum(["9:16", "1:1", "16:9", "4:5"]),
      duration_s: z.number(),
      selected_asset_ids: z.array(z.string()),
      script: z.array(
        z.object({ t_start: z.number(), t_end: z.number(), visual: z.string(), voiceover: z.string(), on_screen_text: z.string() }),
      ),
      subtitles: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
      generation_prompt: z.string().describe("Yalnızca generate_new için; aksi halde boş"),
      music_note: z.string(),
      transition: z.enum(["cut", "fade"]).default("cut"),
      framing: z.enum(["fit", "fill"]).describe("fit: ürün kırpılmaz (kenar boşluklu); fill: kadrajı doldurur (kenarlar kırpılabilir)").default("fit"),
      intro_text: z.string().describe("Giriş kartı metni; yoksa boş").default(""),
      outro_text: z.string().describe("Kapanış kartı metni; yoksa boş").default(""),
      segments: z.array(z.object({
        asset_id: z.string().describe("Kaynak video kimliği (yalnızca analizi tamamlanmış videolar)"),
        scene_index: z.number().describe("Kaynak videonun analizindeki sahne numarası (scenes[].index)"),
        source_start: z.number().describe("KAYNAK videodaki başlangıç (sn); seçilen sahnenin sınırları içinde"),
        source_end: z.number().describe("KAYNAK videodaki bitiş (sn); seçilen sahnenin sınırları içinde"),
        on_screen_text: z.string().describe("Bu bölüm boyunca ekranda görünecek kısa metin; yoksa boş"),
        purpose: z.string().describe("Bu bölümün kurgudaki amacı (ör. açılış, ürün detayı)"),
      })).describe("edit_existing için kurgu bölümleri, çıktı sırasıyla. Çıktı zaman çizelgesi bu sıradan hesaplanır; kaynak zamanları ile karıştırılmaz.").default([]),
      parts: z.array(z.object({
        kind: z.enum(["ai_scene", "product_photo", "archive_clip"]).describe("ai_scene: bu plandaki bir generate_new videosu; product_photo: gerçek ürün fotoğrafı (hareketlendirilir); archive_clip: analizi tamamlanmış arşiv videosundan sahne"),
        ref: z.string().describe("ai_scene: generate_new video id; product_photo: fotoğraf kimliği; archive_clip: video kimliği"),
        duration_s: z.number().describe("Bu parçanın çıktıdaki süresi (sn). ai_scene için en fazla sahnenin süresi; product_photo için 1.5-6"),
        motion: z.enum(["zoom_in", "zoom_out", "pan_left", "pan_right", "none"]).describe("Yalnızca product_photo: kamera hareketi"),
        scene_index: z.number().describe("Yalnızca archive_clip: analizdeki sahne numarası; diğerlerinde 0"),
        source_start: z.number().describe("Yalnızca archive_clip: KAYNAK başlangıç (sn); diğerlerinde 0"),
        source_end: z.number().describe("Yalnızca archive_clip: KAYNAK bitiş (sn); diğerlerinde 0"),
        on_screen_text: z.string().describe("Bu parça boyunca ekranda görünecek kısa metin; yoksa boş"),
      })).describe("Yalnızca compose: çıktı sırasıyla reklam parçaları; diğer modlarda boş dizi").default([]),
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
  reels_ideas: z.array(z.object({
    id: z.string(), title: z.string(), hook: z.string(), shots: z.array(z.string()), on_screen_text: z.string(), media_refs: z.array(z.string()),
  })).default([]),
  tiktok_concepts: z.array(z.object({ id: z.string(), title: z.string(), hook: z.string(), format: z.string(), notes: z.string() })).default([]),
  calendar_7d: z.array(z.object({
    day: z.number().describe("1-7"), date: z.string().describe("YYYY-MM-DD"), platform: z.string(), format: z.string(), post_ref: z.string(), theme: z.string(),
  })).describe("Yedi günlük organik plan").default([]),
  unknowns: Unknowns,
});

const SourceRefs = z.array(z.string()).describe("Dayanılan kaynaklar: knowledge fact id, Drive dosya bağlantısı, doğrulanmış araştırma URL'si veya takvim etkinliği kimliği");

export const PrPlanSchema = z.object({
  summary: z.string(),
  story_angles: z.array(z.object({
    id: z.string(),
    collection: z.string().describe("Koleksiyon adı (ör. Space Alien) veya 'brand'"),
    angle: z.string().describe("Basın/creator hikâye açısı"),
    proof_points: z.array(z.string()).describe("YALNIZCA onaylı bilgiler; yoksa boş"),
    sources: SourceRefs,
  })),
  calendar_hooks: z.array(z.object({ date: z.string().describe("YYYY-MM-DD"), occasion: z.string(), idea: z.string(), lead_time_days: z.number() })).default([]),
  media_targets: z.array(z.object({ type: z.string().describe("Yayın/creator TÜRÜ (ör. US streetwear press); kişi adı veya iletişim bilgisi uydurma"), why: z.string() })).default([]),
  pitch_drafts: z.array(z.object({ id: z.string(), audience: z.string(), subject: z.string(), body: z.string().describe("Marka içerik dilinde taslak; gönderilmez") })).default([]),
  risks: z.array(z.object({ risk: z.string(), mitigation: z.string() })).default([]),
  kpis: z.array(z.object({ metric: z.string(), baseline: z.string().describe("Ölçülmüş değer veya 'unknown'"), how_to_measure: z.string() })).default([]),
  unknowns: Unknowns,
});

export const FinanceReviewSchema = z.object({
  summary: z.string(),
  spend: z.array(z.object({ item: z.string(), amount_usd: z.number().nullable().describe("Yalnızca kayıttaki/kaynaktaki tutar; bilinmiyorsa null"), source: z.string() })).default([]),
  budget_recommendations: z.array(z.object({ area: z.string(), recommendation: z.string(), basis: z.enum(["recorded_data", "assumption"]) })).default([]),
  risks: z.array(z.string()).default([]),
  sources: SourceRefs,
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
  pr: PrPlanSchema,
  finance: FinanceReviewSchema,
} as const;

export const OUTPUT_KIND: Record<SpecialistId, string> = {
  marketing: "strategy",
  shopify: "shopify_proposal",
  design: "design_brief",
  video: "video_plan",
  social: "social_package",
  quality: "qa_report",
  pr: "pr_plan",
  finance: "finance_review",
};

export type StrategyOutput = z.infer<typeof StrategySchema>;
export type ShopifyProposal = z.infer<typeof ShopifyProposalSchema>;
export type DesignBriefOutput = z.infer<typeof DesignBriefSchema>;
export type VideoPlanOutput = z.infer<typeof VideoPlanSchema>;
export type SocialPackage = z.infer<typeof SocialPackageSchema>;
export type ProjectReport = z.infer<typeof ReportSchema>;
export type PrPlan = z.infer<typeof PrPlanSchema>;
export type FinanceReview = z.infer<typeof FinanceReviewSchema>;
