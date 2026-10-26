import type { BrandContext } from "@/lib/agents/context";
import { UNKNOWN } from "@/lib/agents/context";
import type {
  AgentId,
  DesignBriefOutput,
  Plan,
  QaReview,
  ShopifyProposal,
  SocialPackage,
  SpecialistId,
  StrategyOutput,
  VideoPlanOutput,
} from "@/lib/agents/schemas";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "./types";

// DEMO ÜRETİCİ — kural tabanlı, deterministik şablonlar. Gerçek AI üretimi DEĞİLDİR.
// Tüm çıktılar is_demo=true ve generator="demo" ile kaydedilir; panelde "DEMO" etiketiyle gösterilir.
// Şablonlar yalnızca marka kaydındaki bilgileri kullanır; bilinmeyen alanları "unknowns" listesine yazar.

export type DemoInput = {
  instruction: string;
  ctx: BrandContext;
  upstream: { agent: string; kind: string; content: unknown }[];
  feedback?: string | null;
  taskKey?: string;
  target?: { agent: string; content: unknown };
  /** Video görevi: analizi doğrulanmış hedef video kimlikleri (öncelik sırası). */
  videoTargets?: string[];
  /** Video Stüdyosu talebi (marka kapsamında doğrulanmış ürün fotoğraflarıyla). */
  studio?: import("@/lib/video/studio").StudioRequest | null;
};

const DEMO_TAG = "[DEMO]";

type Lang = "en" | "tr";
const L = (code: string): Lang => (code === "tr" ? "tr" : "en");

const T = {
  en: {
    discover: "Discovery",
    launch: "Launch",
    sustain: "Sustain",
    week1: "Week 1",
    week2: "Week 2",
    week34: "Weeks 3–4",
    themes: ["Product close-ups", "How to style it", "Behind the brand", "Customer questions (FAQ)"],
    cta: "Shop now",
    learnMore: "Learn more",
    newIn: "New in",
    meet: "Meet",
    collection: "Launch collection",
    collectionDesc: "Products featured in the launch campaign.",
    faqTitle: "Shipping & returns",
    pendingInfo: "[Pending: shipping and return details have not been provided yet.]",
    details: "The details",
    styleIt: "How to wear it",
    behind: "Behind the design",
    swipe: "Swipe for details",
  },
  tr: {
    discover: "Keşif",
    launch: "Lansman",
    sustain: "Sürdürme",
    week1: "1. hafta",
    week2: "2. hafta",
    week34: "3–4. haftalar",
    themes: ["Ürün yakın çekimleri", "Nasıl kombinlenir", "Markanın arkası", "Sık sorulan sorular"],
    cta: "Hemen incele",
    learnMore: "Daha fazla bilgi",
    newIn: "Yeni",
    meet: "Karşınızda",
    collection: "Lansman koleksiyonu",
    collectionDesc: "Lansman kampanyasında yer alan ürünler.",
    faqTitle: "Gönderim ve iade",
    pendingInfo: "[Bekliyor: gönderim ve iade bilgileri henüz girilmedi.]",
    details: "Detaylar",
    styleIt: "Nasıl kombinlenir",
    behind: "Tasarımın hikâyesi",
    swipe: "Detaylar için kaydır",
  },
};

function known(v: string) {
  return v && v !== UNKNOWN;
}

function brandUnknowns(ctx: BrandContext): string[] {
  const out: string[] = [];
  const b = ctx.brand;
  if (!known(b.target_audience)) out.push("Hedef kitle marka kaydında tanımlı değil.");
  if (!known(b.tone)) out.push("İletişim tonu tanımlı değil.");
  if (!known(b.story)) out.push("Marka hikâyesi tanımlı değil.");
  if (!known(b.shipping_info)) out.push("Gönderim bilgisi bilinmiyor — teslimat vaadi verilmedi.");
  if (!known(b.return_policy)) out.push("İade politikası bilinmiyor.");
  for (const p of ctx.products) {
    if (!known(p.price)) out.push(`"${p.title}" fiyatı bilinmiyor.`);
    if (p.verified_facts.length === 0) out.push(`"${p.title}" için doğrulanmış ürün özelliği yok.`);
  }
  return out;
}

function focusProducts(ctx: BrandContext, instruction: string) {
  const low = instruction.toLocaleLowerCase("tr");
  const hit = ctx.products.filter((p) => low.includes(p.title.toLocaleLowerCase("tr")));
  return (hit.length ? hit : ctx.products).slice(0, 3);
}

function factLine(p: BrandContext["products"][number]) {
  return p.verified_facts.map((f) => `${f.attribute}: ${f.value}`).join(" · ");
}

function upstreamOf<T>(input: DemoInput, agent: string): T | null {
  const u = input.upstream.find((x) => x.agent === agent);
  return (u?.content as T) ?? null;
}

// ---------------------------------------------------------------- Yönetici planı

const RULES: { agent: SpecialistId; words: string[] }[] = [
  { agent: "marketing", words: ["strateji", "kampanya", "hedef kitle", "reklam", "konumlandır", "pazarlama", "strategy", "campaign", "audience", "ads"] },
  { agent: "shopify", words: ["shopify", "mağaza", "urun aciklama", "ürün açıklama", "açıklama", "koleksiyon", "bundle", "sayfa", "store", "description", "collection"] },
  { agent: "design", words: ["görsel", "tasarım", "kapak", "banner", "post", "visual", "design", "cover", "image"] },
  { agent: "video", words: ["video", "reels", "reel", "kurgu", "senaryo", "altyazı", "script"] },
  { agent: "social", words: ["sosyal", "instagram", "tiktok", "takvim", "paylaşım", "yayın", "caption", "social", "calendar", "post"] },
  { agent: "quality", words: ["analiz", "performans", "denetle", "kontrol et", "audit", "performance"] },
];
const LAUNCH = ["lansman", "launch", "tanıtım", "yeni ürün", "yeni koleksiyon", "çıkış"];
// Yalnızca planın kendisini önce görmek isteyen ifadeler ("ürün sayfası önerisi" gibi çıktı adları değil)
const PROPOSE = ["planı öner", "plan öner", "planını öner", "planı göster", "önce planı", "onayıma sun", "propose a plan"];

/** Bilgi marka hafızasında, doğrulanmış bilgilerde veya ürün kaydında varsa tekrar sorulmaz. */
function answeredInContext(ctx: BrandContext, words: string[], product?: BrandContext["products"][number]) {
  const texts = [...ctx.brand.memory.map((m) => `${m.title} ${m.body}`), ...ctx.brand.verified_facts].map((t) => t.toLocaleLowerCase("tr"));
  const hit = (t: string) => words.some((w) => t.includes(w)) && (!product || t.includes(product.title.toLocaleLowerCase("tr")));
  return texts.some(hit);
}

function priceKnown(ctx: BrandContext, p: BrandContext["products"][number]) {
  return known(p.price) || p.variants.some((v) => known(v.price)) || p.verified_facts.some((f) => /fiyat|price/i.test(f.attribute)) || answeredInContext(ctx, ["fiyat", "price", "₺", " tl", "try"], p);
}

export function demoPlan(input: DemoInput): Plan {
  const low = input.instruction.toLocaleLowerCase("tr");
  const isLaunch = LAUNCH.some((w) => low.includes(w));
  const picked = new Set<SpecialistId>();
  if (isLaunch) ["marketing", "shopify", "design", "video", "social"].forEach((a) => picked.add(a as SpecialistId));
  for (const r of RULES) if (r.words.some((w) => low.includes(w))) picked.add(r.agent);
  if (picked.size === 0) picked.add("marketing");
  // İçerik üreten uzmanlar stratejiye dayanır
  if ([...picked].some((a) => a !== "quality") && !picked.has("marketing") && (picked.has("social") || picked.size > 1)) picked.add("marketing");

  const products = focusProducts(input.ctx, input.instruction).map((p) => p.title).join(", ") || "markanın ürünleri";
  const tasks: Plan["tasks"] = [];
  const has = (a: SpecialistId) => picked.has(a);
  if (has("marketing")) tasks.push({ key: "strategy", agent: "marketing", title: "Kampanya stratejisi ve hedef kitle", instruction: `${products} için hedef kitle, konumlandırma, kampanya aşamaları ve reklam önerileri hazırla.`, depends_on: [] });
  const stratDep = has("marketing") ? ["strategy"] : [];
  if (has("shopify")) tasks.push({ key: "store", agent: "shopify", title: "Ürün sayfası, koleksiyon ve bundle önerileri", instruction: `${products} için ürün açıklaması, koleksiyon ve bundle önerisi hazırla; mevcut ve önerilen değerleri karşılaştır.`, depends_on: stratDep });
  if (has("design")) tasks.push({ key: "visuals", agent: "design", title: "Görsel briefleri", instruction: `Lansman gönderileri, kapak ve reklam görselleri için brief hazırla. Gerçek ürün fotoğrafı ile AI görselini ayır.`, depends_on: stratDep });
  if (has("video")) tasks.push({ key: "video", agent: "video", title: "Video senaryosu ve kurgu planı", instruction: `Arşivdeki çekimlerden kısa dikey video kurgusu ve altyazı hazırla; çekim yoksa AI üretimini ayrı işlem olarak planla. Sahibin talimatı: ${input.instruction.slice(0, 600)}`, depends_on: stratDep });
  if (has("social")) {
    const deps = [...stratDep, ...(has("design") ? ["visuals"] : []), ...(has("video") ? ["video"] : [])];
    tasks.push({ key: "social", agent: "social", title: "Sosyal medya yayın paketi ve takvim", instruction: `Instagram ve TikTok için açıklamalar, içerik takvimi ve yayın paketi hazırla.`, depends_on: deps });
  }
  if (has("quality")) tasks.push({ key: "analysis", agent: "quality", title: "Performans ve maliyet analizi", instruction: `Mevcut bağlantılar, maliyetler ve performans verileri üzerinden durum analizi yap.`, depends_on: [] });

  return {
    reply: `${DEMO_TAG} Talimatınızı ${tasks.length} göreve ayırdım (kural tabanlı demo planlayıcı). Bağımsız görevler paralel çalışacak; her çıktı kalite kontrolünden geçecek.`,
    goals: [
      isLaunch ? `${products} lansmanını hazırlamak` : `Talimatı yerine getirmek: ${input.instruction.slice(0, 120)}`,
      "Marka bilgileriyle tutarlı, doğrulanmamış iddia içermeyen içerik üretmek",
      "Dış işlemleri yalnızca onaydan sonra yürütmek",
    ],
    questions_for_owner: [
      ...(!known(input.ctx.brand.target_audience) && !answeredInContext(input.ctx, ["hedef kitle", "audience"]) ? ["Hedef kitleniz kim (yaş, şehir, ilgi alanları)?"] : []),
      ...(has("shopify") && !known(input.ctx.brand.shipping_info) && !answeredInContext(input.ctx, ["gönderim", "kargo", "shipping"]) ? ["Gönderim süresi ve ücreti nedir? (bilinmediği için vaat verilmedi)"] : []),
      ...focusProducts(input.ctx, input.instruction).filter((p) => !priceKnown(input.ctx, p)).map((p) => `"${p.title}" ürününün fiyatı nedir?`),
    ],
    tasks,
    awaiting_approval: PROPOSE.some((w) => low.includes(w)),
  };
}

// ---------------------------------------------------------------- Uzmanlar

export function demoStrategy(input: DemoInput): StrategyOutput {
  const { ctx } = input;
  const t = T[L(ctx.brand.content_language)];
  const products = focusProducts(ctx, input.instruction);
  const names = products.map((p) => p.title).join(", ") || ctx.brand.name;
  return {
    summary: `${DEMO_TAG} ${names} için üç aşamalı kampanya taslağı. Hedef kitle ${known(ctx.brand.target_audience) ? "marka kaydına dayanıyor" : "marka kaydında olmadığı için varsayım olarak işaretlendi"}.`,
    audience_segments: known(ctx.brand.target_audience)
      ? [{ segment: ctx.brand.target_audience, needs: "Marka kaydında belirtilen hedef kitle", basis: "brand_data" }]
      : [{ segment: "Tanımlanmamış — kullanıcı onayı gerekli", needs: "Bilinmiyor", basis: "assumption" }],
    positioning: known(ctx.brand.story) ? `${ctx.brand.name}: ${ctx.brand.story.slice(0, 200)}` : `${ctx.brand.name} — konumlandırma için marka hikâyesi gerekli.`,
    key_messages: products.map((p) => `${t.meet} ${p.title}${factLine(p) ? ` — ${factLine(p)}` : ""}`),
    campaign: {
      name: `${names} ${t.launch}`,
      objective: "Lansman farkındalığı ve ürün sayfası ziyareti (hedef rakam belirlenmedi)",
      phases: [
        { name: t.discover, timing: t.week1, actions: ["Teaser gönderileri", "Ürün yakın çekimleri"] },
        { name: t.launch, timing: t.week2, actions: ["Lansman gönderisi ve reel", "Ürün sayfası yayına alınır (onaydan sonra)"] },
        { name: t.sustain, timing: t.week34, actions: ["Kombin önerileri", "SSS içerikleri"] },
      ],
    },
    content_themes: t.themes,
    ad_ideas: [
      { platform: "Instagram", format: "Reel 9:16", hook: `${t.newIn}: ${names}`, audience: known(ctx.brand.target_audience) ? ctx.brand.target_audience : "Bilinmiyor", budget_note: "Bütçe belirlenmedi; reklam başlatmak ayrı onay gerektirir." },
    ],
    brand_analysis: {
      strengths: [
        ...(known(ctx.brand.story) ? [{ point: "Marka hikâyesi tanımlı", basis: "brand_data" as const }] : []),
        ...products.filter((p) => p.verified_facts.length).map((p) => ({ point: `${p.title}: ${p.verified_facts.length} doğrulanmış özellik`, basis: "brand_data" as const })),
      ],
      gaps: brandUnknowns(ctx),
    },
    competitor_framework: {
      criteria: ["Fiyat aralığı", "Ürün çeşitliliği", "Görsel dil", "İçerik sıklığı", "Topluluk etkileşimi"],
      competitors_to_research: [],
      questions: ["Doğrudan rakip olarak gördüğünüz markalar hangileri?"],
    },
    organic_strategy: {
      pillars: t.themes,
      posting_frequency: "Haftada 3-4 gönderi önerilir (performans verisi olmadığından başlangıç önerisidir).",
      channels: [{ platform: "Instagram", role: "Ana vitrin" }, { platform: "TikTok", role: "Keşif / erişim" }],
    },
    performance_recommendations: [
      { metric: "Kaydetme oranı", how_to_measure: "Instagram Insights — kaydetme / erişim", note: "Hedef rakam, ilk 2 haftalık gerçek veriden sonra belirlenmeli." },
      { metric: "Ürün sayfası ziyareti", how_to_measure: "Shopify Analytics — kaynak: sosyal", note: "Bağlantı olmadan ölçülemez." },
    ],
    assumptions: known(ctx.brand.target_audience) ? [] : ["Hedef kitle kayıtta olmadığı için genel bir kitle varsayıldı."],
    unknowns: brandUnknowns(ctx),
  };
}

export function demoShopify(input: DemoInput): ShopifyProposal {
  const { ctx } = input;
  const t = T[L(ctx.brand.content_language)];
  const products = focusProducts(ctx, input.instruction);
  const changes: ShopifyProposal["product_changes"] = [];
  for (const p of products) {
    const facts = p.verified_facts.map((f) => `<li>${f.attribute}: ${f.value}</li>`).join("");
    const proposed = `<p>${DEMO_TAG} ${p.title}.</p>${facts ? `<ul>${facts}</ul>` : ""}`;
    changes.push({ product_id: p.id, field: "description", current_value: known(p.description) ? p.description : "", proposed_value: proposed, reason: "Yalnızca doğrulanmış özelliklerle yapılandırılmış açıklama." });
  }
  return {
    summary: `${DEMO_TAG} ${products.length} ürün için açıklama önerisi, 1 koleksiyon ve ${products.length > 1 ? "1 bundle" : "0 bundle"} önerisi. Fiyat değişikliği önerilmedi.`,
    product_changes: changes,
    collections: products.length ? [{ title: t.collection, description: t.collectionDesc, rule_summary: "Manuel koleksiyon", product_ids: products.map((p) => p.id) }] : [],
    pages: [{ title: t.faqTitle, purpose: "Gönderim/iade bilgisi sayfası", body: known(ctx.brand.shipping_info) || known(ctx.brand.return_policy) ? [ctx.brand.shipping_info, ctx.brand.return_policy].filter(known).join("\n\n") : t.pendingInfo }],
    bundles: products.length > 1 ? [{ name: `${products[0].title} + ${products[1].title}`, product_ids: [products[0].id, products[1].id], rationale: "Lansman ürünlerini birlikte sunmak", pricing_note: "Bundle fiyatı belirlenmedi; fiyat kararı kullanıcıya ait." }] : [],
    pdp_drafts: products.map((p) => ({
      product_id: p.id,
      headline: p.title,
      body: `${DEMO_TAG} ${p.title}.`,
      bullet_points: p.verified_facts.map((f) => `${f.attribute}: ${f.value}`),
      seo_title: `${p.title} | ${ctx.brand.name}`.slice(0, 70),
      seo_description: `${p.title}${factLine(p) ? ` — ${factLine(p)}` : ""}`.slice(0, 160),
    })),
    unknowns: brandUnknowns(ctx),
  };
}

export function demoDesign(input: DemoInput): DesignBriefOutput {
  const { ctx } = input;
  const t = T[L(ctx.brand.content_language)];
  const products = focusProducts(ctx, input.instruction);
  const palette = ctx.brand.colors.map((c) => `${c.name} ${c.hex}`).join(", ") || "marka renkleri tanımlı değil";
  const briefs: DesignBriefOutput["briefs"] = [];
  products.forEach((p, i) => {
    const photos = ctx.media.filter((m) => m.product_id === p.id && m.origin === "real_photo").map((m) => m.id);
    briefs.push({
      id: `post-${i + 1}`,
      purpose: "post",
      format: "4:5",
      headline: `${t.newIn}: ${p.title}`,
      body_text: factLine(p) || p.title,
      visual_direction: `Renk paleti: ${palette}. ${photos.length ? "Gerçek ürün fotoğrafı kullanılacak; ürün baskısı/rengi değiştirilmeyecek." : "Arşivde bu ürünün fotoğrafı yok — çekim gerekli veya AI görseli yalnızca atmosfer için."}`,
      product_ids: [p.id],
      source_asset_ids: photos.slice(0, 3),
      use_real_product_photo: photos.length > 0,
      render_mode: photos.length > 0 ? "photo_composition" : "typography",
      slides: [],
      generation_prompt: `Clean editorial background for a fashion product post, palette ${palette}. Do not depict or alter the product itself.`,
      notes: DEMO_TAG,
    });
  });
  briefs.push({
    id: "cover-1",
    purpose: "cover",
    format: "9:16",
    headline: `${ctx.brand.name} — ${t.launch}`,
    body_text: t.cta,
    visual_direction: `Reel kapağı. Palet: ${palette}.`,
    product_ids: products.map((p) => p.id),
    source_asset_ids: [],
    use_real_product_photo: false,
    render_mode: "typography",
    slides: [],
    generation_prompt: `Minimal vertical cover background, palette ${palette}, space for headline text.`,
    notes: DEMO_TAG,
  });
  const carouselPhoto = ctx.media.find((m) => products.some((p) => p.id === m.product_id) && m.origin === "real_photo");
  if (products[0]) {
    const p0 = products[0];
    briefs.push({
      id: "carousel-1",
      purpose: "carousel",
      format: "4:5",
      headline: `${t.newIn}: ${p0.title}`,
      body_text: t.swipe,
      visual_direction: `Carousel. Palet: ${palette}.`,
      product_ids: [p0.id],
      source_asset_ids: carouselPhoto ? [carouselPhoto.id] : [],
      use_real_product_photo: !!carouselPhoto,
      render_mode: carouselPhoto ? "photo_composition" : "typography",
      slides: [
        { headline: t.details, body_text: factLine(p0) || p0.title },
        { headline: t.styleIt, body_text: t.cta },
      ],
      generation_prompt: "",
      notes: DEMO_TAG,
    });
    briefs.push({
      id: "story-1",
      purpose: "story",
      format: "9:16",
      headline: `${t.newIn}: ${p0.title}`,
      body_text: t.cta,
      visual_direction: `Story. Palet: ${palette}.`,
      product_ids: [p0.id],
      source_asset_ids: carouselPhoto ? [carouselPhoto.id] : [],
      use_real_product_photo: !!carouselPhoto,
      render_mode: carouselPhoto ? "photo_composition" : "typography",
      slides: [],
      generation_prompt: "",
      notes: DEMO_TAG,
    });
  }
  return { summary: `${DEMO_TAG} ${briefs.length} görsel brief hazırlandı.`, briefs, unknowns: brandUnknowns(ctx) };
}

/** Talimattaki hedef süre: "10-15 saniye" → 12,5; "12 sn" → 12. Bulunamazsa null. */
export function requestedDurationS(text: string): number | null {
  const range = /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(?:sn|saniye|s\b|sec|seconds?)/i.exec(text);
  if (range) return Math.min(60, (Number(range[1]) + Number(range[2])) / 2);
  const one = /(\d{1,2})\s*(?:sn|saniye|seconds?)\b/i.exec(text);
  return one ? Math.min(60, Number(one[1])) : null;
}

/**
 * Stüdyo AI/karma modu: Gemini Omni sahneleri (ürün fotoğrafları referans) + gerçek ürün fotoğrafı hareketi +
 * (karma modda) doğrulanmış bir arşiv sahnesi + marka kapanışı, tek "compose" kurgusunda.
 */
function demoStudioVideo(input: DemoInput, studio: import("@/lib/video/studio").StudioRequest): VideoPlanOutput {
  const { ctx } = input;
  const t = T[L(ctx.brand.content_language)];
  const name = focusProducts(ctx, input.instruction).map((p) => p.title).join(" & ") || ctx.brand.name;
  const photos = studio.photoIds.filter((id) => ctx.media.some((m) => m.id === id && m.kind === "photo"));
  const shots = [
    "Slow cinematic dolly-in on the T-shirt worn by a model in a neon-lit city street at night, shallow depth of field, soft rim light.",
    "Handheld tracking shot of the model walking and turning towards camera, fabric moving naturally, warm sunset light, film look.",
    "Low-angle hero shot of the model on a rooftop at golden hour, slow orbit around the T-shirt, gentle wind, premium ad style.",
  ];
  const scenes = Array.from({ length: studio.aiScenes }, (_, i) => ({
    id: `scene-${i + 1}`, mode: "generate_new" as const, format: "9:16" as const, duration_s: studio.sceneSeconds,
    selected_asset_ids: photos, script: [], subtitles: [], generation_prompt: `${shots[i % shots.length]} Vertical 9:16, no on-screen text.`,
    music_note: "", transition: "cut" as const, framing: "fill" as const, intro_text: "", outro_text: "", segments: [], parts: [],
  }));
  const parts: VideoPlanOutput["videos"][number]["parts"] = scenes.map((sc, i) => ({
    kind: "ai_scene" as const, ref: sc.id, duration_s: studio.sceneSeconds, motion: "none" as const, scene_index: 0, source_start: 0, source_end: 0,
    on_screen_text: i === 0 ? `${t.newIn}: ${name}` : "",
  }));
  if (photos[0]) parts.splice(1, 0, { kind: "product_photo", ref: photos[0], duration_s: 2.5, motion: "zoom_in", scene_index: 0, source_start: 0, source_end: 0, on_screen_text: "" });
  if (studio.mode === "hybrid") {
    const clip = ctx.media.find((m) => m.kind === "video" && m.analysis_status === "completed" && (m.analysis as any)?.scenes?.some((sc: any) => sc.end - sc.start >= 1.2));
    const sc = (clip?.analysis as any)?.scenes?.find((x: any) => x.end - x.start >= 1.2);
    if (clip && sc) {
      const start = Math.round((sc.start + 0.01) * 100) / 100, end = Math.round(Math.min(sc.end - 0.01, sc.start + 2) * 100) / 100;
      parts.push({ kind: "archive_clip", ref: clip.id, duration_s: end - start, motion: "none", scene_index: sc.index, source_start: start, source_end: end, on_screen_text: "" });
    }
  }
  if (parts.length > 1) parts[parts.length - 1].on_screen_text = t.cta;
  const total = Math.round(parts.reduce((a, p) => a + p.duration_s, 0) * 100) / 100;
  return {
    summary: `${DEMO_TAG} ${studio.aiScenes} AI sahne (Gemini Omni${photos.length ? `, ${photos.length} ürün fotoğrafı referanslı` : ""}) ve ${parts.length} parçalı karma kurgu; marka kapanışıyla ${total} sn.`,
    videos: [
      ...scenes,
      {
        id: "ad-1", mode: "compose", format: "9:16", duration_s: total,
        selected_asset_ids: [...photos, ...parts.filter((p) => p.kind === "archive_clip").map((p) => p.ref)],
        script: [], subtitles: [], generation_prompt: "", music_note: "Ses kaldırıldı; lisanslı müzik ekleme sonraki aşama.",
        transition: "fade", framing: "fill", intro_text: "", outro_text: `${ctx.brand.name} — ${t.cta}`, segments: [], parts,
      },
    ],
    unknowns: brandUnknowns(ctx),
  };
}

export function demoVideo(input: DemoInput): VideoPlanOutput {
  if (input.studio && input.studio.mode !== "archive") return demoStudioVideo(input, input.studio);
  const { ctx } = input;
  const t = T[L(ctx.brand.content_language)];
  const products = focusProducts(ctx, input.instruction);
  const name = products.map((p) => p.title).join(" & ") || ctx.brand.name;
  const videos = ctx.media.filter((m) => m.kind === "video");
  // Yalnızca analizi tamamlanmış videolar; talimatta istenenler önce. Dosya adına göre sahne UYDURULMAZ.
  const order = input.videoTargets ?? [];
  const analysed = videos
    .filter((m) => m.analysis_status === "completed" && (m.analysis as any)?.scenes?.length)
    .sort((x, y) => (order.indexOf(x.id) + 1 || 99) - (order.indexOf(y.id) + 1 || 99) || Number(!!y.requested) - Number(!!x.requested))
    .slice(0, 2);
  if (analysed.length) {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const target = requestedDurationS(input.instruction) ?? 9;
    const segments: VideoPlanOutput["videos"][number]["segments"] = [];
    for (const m of analysed) {
      const scenes = ((m.analysis as any).scenes as { index: number; start: number; end: number }[]).filter((sc) => sc.end - sc.start >= 0.8);
      const windows = scenes.length >= 2
        ? scenes.map((sc) => ({ sc, from: sc.start, to: sc.end }))
        // Tek uzun sahne: aynı sahnenin farklı zaman aralıkları (aynı dosyadan birden çok bölüm)
        : scenes.flatMap((sc) => { const n = Math.min(3, Math.floor((sc.end - sc.start) / 1.5)); return Array.from({ length: Math.max(1, n) }, (_, i) => ({ sc, from: sc.start + (i * (sc.end - sc.start)) / Math.max(1, n), to: sc.start + ((i + 1) * (sc.end - sc.start)) / Math.max(1, n) })); });
      const per = Math.max(1.5, target / Math.min(4, Math.max(1, windows.length * analysed.length)));
      for (const w of windows) {
        if (segments.length >= 4) break;
        const len = Math.min(per, w.to - w.from);
        const start = r2(Math.max(w.sc.start, w.from + (w.to - w.from - len) / 2) + 0.005);
        const end = r2(Math.min(w.sc.end, start + len) - 0.005);
        if (end - start < 0.5) continue;
        segments.push({ asset_id: m.id, scene_index: w.sc.index, source_start: start, source_end: end, on_screen_text: "", purpose: segments.length === 0 ? "açılış" : "ürün görüntüsü" });
      }
    }
    if (segments.length) {
      segments[0].on_screen_text = `${t.newIn}: ${name}`;
      if (segments.length > 1) segments[segments.length - 1].on_screen_text = t.cta;
      const total = r2(segments.reduce((acc, sg) => acc + (sg.source_end - sg.source_start), 0));
      let at = 0;
      const script = segments.map((sg) => {
        const d = sg.source_end - sg.source_start;
        const row = { t_start: r2(at), t_end: r2(at + d), visual: `Sahne ${sg.scene_index + 1} (${sg.source_start}–${sg.source_end} sn, doğrulanmış analiz)`, voiceover: "", on_screen_text: sg.on_screen_text };
        at += d;
        return row;
      });
      return {
        summary: `${DEMO_TAG} ${analysed.length} analiz edilmiş videodan ${segments.length} doğrulanmış sahne bölümüyle ${total} sn'lik dikey kurgu planı.`,
        videos: [{
          id: "reel-1", mode: "edit_existing", format: "9:16", duration_s: total,
          selected_asset_ids: [...new Set(segments.map((sg) => sg.asset_id))],
          script, subtitles: [], generation_prompt: "", music_note: "Ses kaldırıldı; lisanslı müzik ekleme manuel.",
          transition: "cut", framing: "fit", intro_text: "", outro_text: "", segments, parts: [],
        }],
        unknowns: brandUnknowns(ctx),
      };
    }
  }
  if (videos.length) {
    return {
      summary: `${DEMO_TAG} Arşivde video var ancak analizi tamamlanmış uygun sahne yok; kurgu planı üretilmedi (sahne uydurulmadı).`,
      videos: [],
      unknowns: [...brandUnknowns(ctx), "Video analizi tamamlanmadan kurgu yapılamaz."],
    };
  }
  return {
    summary: `${DEMO_TAG} Arşivde video çekimi yok. Yeni AI video üretimi ayrı işlem olarak planlandı (servis bağlantısı gerekir).`,
    videos: [
      {
        id: "reel-1",
        mode: "generate_new",
        format: "9:16",
        duration_s: 8,
        selected_asset_ids: [],
        script: [
          { t_start: 0, t_end: 4, visual: "Atmosfer çekimi (ürün gösterilmez)", voiceover: "", on_screen_text: `${t.newIn}: ${name}` },
          { t_start: 4, t_end: 8, visual: "Marka logosu", voiceover: "", on_screen_text: t.cta },
        ],
        subtitles: [
          { start: 0, end: 3.8, text: `${t.newIn}: ${name}` },
          { start: 4, end: 7.8, text: t.cta },
        ],
        generation_prompt: "Atmospheric vertical b-roll, soft light, no product shown, no text.",
        music_note: "Müzik seçilmedi.",
        transition: "cut",
        framing: "fit",
        intro_text: "",
        outro_text: "",
        segments: [],
        parts: [],
      },
    ],
    unknowns: [...brandUnknowns(ctx), "Arşivde ürün videosu yok; gerçek ürün görüntüsü için çekim gerekli."],
  };
}

export function demoSocial(input: DemoInput): SocialPackage {
  const { ctx } = input;
  const t = T[L(ctx.brand.content_language)];
  const products = focusProducts(ctx, input.instruction);
  const design = upstreamOf<DesignBriefOutput>(input, "design");
  const video = upstreamOf<VideoPlanOutput>(input, "video");
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 3);
  base.setUTCHours(17, 0, 0, 0);
  const iso = (d: number) => new Date(base.getTime() + d * 86400_000).toISOString();
  const tag = `#${ctx.brand.name.replace(/[^\p{L}\p{N}]/gu, "")}`;
  const posts: SocialPackage["posts"] = [];
  products.forEach((p, i) => {
    posts.push({
      id: `ig-post-${i + 1}`,
      platform: "instagram",
      format: "feed",
      caption: `${DEMO_TAG} ${t.newIn}: ${p.title}.${factLine(p) ? `\n${factLine(p)}` : ""}\n${t.cta} →`,
      hashtags: [tag],
      cta: t.cta,
      suggested_datetime: iso(i),
      media_refs: design?.briefs.filter((b) => b.product_ids.includes(p.id)).map((b) => b.id) ?? [],
      cover_text: p.title,
    });
  });
  if (video?.videos.length) {
    posts.push({ id: "ig-reel-1", platform: "instagram", format: "reel", caption: `${DEMO_TAG} ${ctx.brand.name} — ${t.launch}`, hashtags: [tag], cta: t.learnMore, suggested_datetime: iso(posts.length), media_refs: [video.videos[0].id], cover_text: `${ctx.brand.name}` });
    posts.push({ id: "tt-video-1", platform: "tiktok", format: "video", caption: `${DEMO_TAG} ${ctx.brand.name} ${t.launch}`, hashtags: [tag], cta: t.learnMore, suggested_datetime: iso(posts.length), media_refs: [video.videos[0].id], cover_text: `${ctx.brand.name}` });
  }
  // En az üç Instagram konsepti (ürün sayısı azsa farklı temalarla)
  const themes = [t.details, t.styleIt, t.behind];
  for (let k = 0; posts.filter((x) => x.platform === "instagram" && x.format !== "reel").length < 3 && products.length; k++) {
    const p = products[k % products.length];
    posts.push({
      id: `ig-post-${posts.length + 1}`, platform: "instagram", format: k === 0 && design?.briefs.some((b) => b.purpose === "carousel") ? "carousel" : "feed",
      caption: `${DEMO_TAG} ${themes[k % themes.length]} — ${p.title}.${factLine(p) ? `\n${factLine(p)}` : ""}`, hashtags: [tag], cta: t.cta,
      suggested_datetime: iso(posts.length), media_refs: design?.briefs.filter((b) => b.product_ids.includes(p.id)).map((b) => b.id).slice(0, 1) ?? [], cover_text: p.title,
    });
  }
  const p0 = products[0];
  const reels_ideas: SocialPackage["reels_ideas"] = p0 ? [
    { id: "reel-idea-1", title: `${p0.title} — ${t.details}`, hook: `${t.newIn}: ${p0.title}`, shots: ["Yakın plan ürün detayı", "Tam boy ürün", "Logo / kapanış"], on_screen_text: factLine(p0) || p0.title, media_refs: video?.videos.map((v) => v.id).slice(0, 1) ?? [] },
    { id: "reel-idea-2", title: `${p0.title} — ${t.styleIt}`, hook: t.styleIt, shots: ["Kombin 1", "Kombin 2", "Kapanış"], on_screen_text: t.cta, media_refs: [] },
  ] : [];
  const tiktok_concepts: SocialPackage["tiktok_concepts"] = p0 ? [{ id: "tt-concept-1", title: `${t.behind}: ${p0.title}`, hook: `${t.newIn}: ${p0.title}`, format: "Dikey 9:16, 8-15 sn", notes: "Gerçek çekim kullanılmalı; ürün özellikleri yalnızca doğrulanmış bilgilerden." }] : [];
  const calendar_7d: SocialPackage["calendar_7d"] = Array.from({ length: 7 }, (_, d) => {
    const post = posts[d % Math.max(1, posts.length)];
    return { day: d + 1, date: iso(d).slice(0, 10), platform: post?.platform ?? "instagram", format: post?.format ?? "story", post_ref: d < posts.length ? post.id : "", theme: d < posts.length ? themes[d % themes.length] : "Story / etkileşim (yeni içerik gerekmez)" };
  });
  return { summary: `${DEMO_TAG} ${posts.length} gönderilik yayın paketi, ${reels_ideas.length} Reels fikri, 7 günlük plan. Yayın yalnızca onaydan sonra yapılabilir.`, posts, reels_ideas, tiktok_concepts, calendar_7d, unknowns: brandUnknowns(ctx) };
}

export function demoQualityAnalysis(input: DemoInput): QaReview {
  return {
    verdict: "pass",
    score: 0,
    checks: [
      { name: "Performans verisi", status: "warn", detail: "Bağlı performans kaynağı yok; analiz yapılmadı (örnek veri üretilmez)." },
      { name: "Demo modu", status: "warn", detail: "Bu rapor kural tabanlı demo üreticiyle oluşturuldu." },
    ],
    required_changes: [],
  };
}

export function demoReview(_input: DemoInput): QaReview {
  return {
    verdict: "pass",
    score: 0,
    checks: [{ name: "Model incelemesi", status: "warn", detail: "Demo modunda model tabanlı inceleme yapılmadı; yalnızca kural tabanlı kontroller geçerlidir." }],
    required_changes: [],
  };
}

const GENERATORS: Record<string, (i: DemoInput) => unknown> = {
  "manager:plan": demoPlan,
  "marketing:work": demoStrategy,
  "shopify:work": demoShopify,
  "design:work": demoDesign,
  "video:work": demoVideo,
  "social:work": demoSocial,
  "quality:work": demoQualityAnalysis,
  "quality:review": demoReview,
};

export class DemoAdapter implements TextModelAdapter {
  readonly id = "demo";
  readonly isDemo = true;
  readonly service = "demo";
  estimateCostUsd() {
    return 0;
  }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const gen = GENERATORS[`${req.agent as AgentId}:${req.purpose}`];
    if (!gen) throw new Error(`Demo üretici yok: ${req.agent}:${req.purpose}`);
    // İsteğe bağlı yapay gecikme (canlı ilerlemeyi göstermek / yeniden başlatma testleri için)
    const delay = Number(process.env.DEMO_DELAY_MS ?? 0);
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        req.signal?.addEventListener("abort", () => { clearTimeout(t); reject(req.signal!.reason); }, { once: true });
      });
    }
    const data = req.schema.parse(gen(req.demoInput as DemoInput));
    return { data, generator: "demo", isDemo: true, model: "demo-rules", usage: null, actualCostUsd: 0 };
  }
}
