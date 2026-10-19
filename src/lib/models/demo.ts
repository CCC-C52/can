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
  if (has("video")) tasks.push({ key: "video", agent: "video", title: "Video senaryosu ve kurgu planı", instruction: `Arşivdeki çekimlerden kısa dikey video kurgusu ve altyazı hazırla; çekim yoksa AI üretimini ayrı işlem olarak planla.`, depends_on: stratDep });
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
    tasks,
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
    generation_prompt: `Minimal vertical cover background, palette ${palette}, space for headline text.`,
    notes: DEMO_TAG,
  });
  return { summary: `${DEMO_TAG} ${briefs.length} görsel brief hazırlandı.`, briefs, unknowns: brandUnknowns(ctx) };
}

export function demoVideo(input: DemoInput): VideoPlanOutput {
  const { ctx } = input;
  const t = T[L(ctx.brand.content_language)];
  const products = focusProducts(ctx, input.instruction);
  const clips = ctx.media.filter((m) => m.kind === "video" && (m.origin === "real_video" || m.origin === "edited")).slice(0, 3);
  const name = products.map((p) => p.title).join(" & ") || ctx.brand.name;
  if (clips.length) {
    const per = 4;
    const duration = per * clips.length;
    return {
      summary: `${DEMO_TAG} Arşivdeki ${clips.length} çekimden ${duration} sn'lik dikey kurgu planı.`,
      videos: [
        {
          id: "reel-1",
          mode: "edit_existing",
          format: "9:16",
          duration_s: duration,
          selected_asset_ids: clips.map((c) => c.id),
          script: clips.map((c, i) => ({ t_start: i * per, t_end: (i + 1) * per, visual: c.filename, voiceover: "", on_screen_text: i === 0 ? `${t.newIn}: ${name}` : i === clips.length - 1 ? t.cta : "" })),
          subtitles: clips.map((_, i) => ({ start: i * per, end: (i + 1) * per - 0.2, text: i === 0 ? `${t.newIn}: ${name}` : i === clips.length - 1 ? t.cta : ctx.brand.name })),
          generation_prompt: "",
          music_note: "Lisanslı müzik seçilmedi; müzik ekleme manuel.",
        },
      ],
      unknowns: brandUnknowns(ctx),
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
  return { summary: `${DEMO_TAG} ${posts.length} gönderilik yayın paketi taslağı. Yayın yalnızca onaydan sonra yapılabilir.`, posts, unknowns: brandUnknowns(ctx) };
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
