import type { AgentId, SpecialistId } from "./schemas";

// Uygulamanın ÇALIŞMA ZAMANI ajanları. (Geliştirme sırasında kullanılan kodlama ajanlarıyla ilgisi yoktur.)
// Araç izinleri burada tanımlanır ve ToolGateway tarafından sunucu kodunda zorunlu kılınır.

export const TOOLS = {
  "brand.read": "Doğrulanmış marka bilgilerini okuma",
  "products.read": "Ürün, varyant ve doğrulanmış ürün özelliklerini okuma",
  "media.read": "Medya arşivini okuma",
  "outputs.read": "Aynı projedeki önceki çıktıları okuma",
  "tasks.manage": "Görev oluşturma ve sıralama",
  "performance.read": "Bağlı performans verilerini okuma",
  "costs.read": "Maliyet kayıtlarını okuma",
  "image.generate": "Bağlı görsel üretim servisini çağırma",
  "video.edit": "Mevcut videoları yerel ffmpeg ile düzenleme/render",
  "video.generate": "Bağlı AI video üretim servisini çağırma",
  "calendar.write": "Yayın takvimine taslak giriş ekleme",
  "shopify.propose": "Shopify değişiklik önerisi hazırlama (canlı yazma yok)",
  "social.propose": "Yayın paketi hazırlama (canlı yayın yok)",
} as const;
export type ToolId = keyof typeof TOOLS;

export type AgentDefinition = {
  id: AgentId;
  name: string;
  role: string;
  responsibilities: string[];
  requiredInputs: string[];
  outputDescription: string;
  tools: ToolId[];
  acceptanceCriteria: string[];
  /** Bu uzmanın çıktısı onay bekleyen bir dış işleme yol açar mı (Shopify/sosyal yayın)? */
  producesExternalProposal: boolean;
};

export const AGENTS: Record<AgentId, AgentDefinition> = {
  manager: {
    id: "manager",
    name: "Ana Yönetici",
    role: "Talimatı hedef ve görevlere ayırır, uzmanları seçer, sırayı belirler, kalite kontrole gönderir ve sonucu raporlar.",
    responsibilities: [
      "Talimatı hedeflere ve görevlere ayırmak",
      "Markanın doğrulanmış bilgilerini okumak",
      "Gerekli uzmanları seçmek, bağımlılıkları ve sırayı belirlemek",
      "Bağımsız görevleri sınırlar içinde paralel yürütmek",
      "Çıktıları kalite kontrolüne göndermek, başarısız işleri takip etmek",
      "Sonuçları dosya, önizleme ve kısa raporla sunmak",
    ],
    requiredInputs: ["Kullanıcı talimatı", "Seçili marka", "Marka profili"],
    outputDescription: "Görev planı (hedefler + bağımlılıklı görev listesi) ve proje raporu",
    // media.read: hangi gerçek medyanın (ve analizlerinin) mevcut olduğunu bilerek plan yapmak için
    tools: ["brand.read", "products.read", "media.read", "tasks.manage", "outputs.read", "costs.read"],
    acceptanceCriteria: [
      "Her görev mevcut bir uzmana atanmış olmalı",
      "Bağımlılıklar döngüsüz olmalı",
      "Görev sayısı proje sınırını aşmamalı",
    ],
    producesExternalProposal: false,
  },
  marketing: {
    id: "marketing",
    name: "Pazarlama Uzmanı",
    role: "Hedef kitle, konumlandırma, kampanya stratejisi, içerik temaları ve reklam önerileri hazırlar.",
    responsibilities: ["Hedef kitle segmentleri", "Konumlandırma ve ana mesajlar", "Kampanya aşamaları", "İçerik temaları", "Reklam önerileri"],
    requiredInputs: ["Marka profili", "Ürünler ve doğrulanmış özellikler", "Kampanya kuralları"],
    outputDescription: "Kampanya stratejisi (StrategySchema)",
    // outputs.read: yöneticinin bağımlılık olarak verdiği diğer uzman çıktılarını (ör. analiz) okumak için.
    // media.read: kampanya fikirlerini arşivdeki gerçek görsel/video analizlerine dayandırmak için.
    tools: ["brand.read", "products.read", "media.read", "outputs.read", "performance.read"],
    acceptanceCriteria: [
      "Varsayımlar 'assumption' olarak işaretlenmeli",
      "Doğrulanmamış ürün özelliği, satış rakamı, yorum veya bağış oranı içermemeli",
      "Müşteriye yönelik metinler marka içerik dilinde olmalı",
    ],
    producesExternalProposal: false,
  },
  shopify: {
    id: "shopify",
    name: "Shopify Uzmanı",
    role: "Ürün açıklamaları, koleksiyonlar, mağaza sayfaları ve bundle önerileri hazırlar; canlı değişiklikler için mevcut/önerilen karşılaştırması sunar.",
    responsibilities: ["Ürün açıklamaları", "Koleksiyon önerileri", "Mağaza sayfaları", "Bundle önerileri", "Mevcut ve önerilen değer karşılaştırması"],
    requiredInputs: ["Ürün kayıtları (mevcut değerler)", "Doğrulanmış ürün özellikleri", "Gönderim/iade bilgileri"],
    outputDescription: "Shopify değişiklik önerisi (ShopifyProposalSchema)",
    tools: ["brand.read", "products.read", "media.read", "outputs.read", "shopify.propose"],
    acceptanceCriteria: [
      "Her değişiklikte mevcut değer kayıttaki değerle aynı olmalı",
      "Fiyat değişikliği ayrıca işaretlenir ve ayrı onay gerektirir",
      "Doğrulanmamış özellik, kargo süresi veya iade vaadi eklenmemeli",
    ],
    producesExternalProposal: true,
  },
  design: {
    id: "design",
    name: "Tasarım Uzmanı",
    role: "Görsel briefleri, gönderi tasarımları, kapaklar ve reklam görselleri hazırlar; gerçek görsel üretimini bağlı araçlarla yapar.",
    responsibilities: ["Görsel briefler", "Gönderi/kapak/reklam görseli tanımları", "Bağlı servis varsa görsel üretimi"],
    requiredInputs: ["Marka renk/yazı tipi", "Ürün fotoğrafları (arşiv)", "Kampanya stratejisi"],
    outputDescription: "Tasarım briefleri (DesignBriefSchema) + bağlantı varsa üretilmiş görseller",
    tools: ["brand.read", "products.read", "media.read", "outputs.read", "image.generate"],
    acceptanceCriteria: [
      "Gerçek ürün fotoğrafı ile AI kampanya görseli ayrılmalı",
      "Ürünün baskı, renk ve kalıbını değiştirecek talimat içermemeli",
      "Görsel servisi bağlı değilse görsel üretilmiş gibi gösterilmemeli",
    ],
    producesExternalProposal: false,
  },
  video: {
    id: "video",
    name: "Video Uzmanı",
    role: "Senaryo, çekim seçimi, kurgu, altyazı ve video çıktıları hazırlar; mevcut çekim düzenleme ile AI video üretimini ayrı ele alır.",
    responsibilities: ["Senaryo", "Arşivden çekim seçimi", "Kurgu planı ve altyazı", "Mevcut çekimlerden yerel render", "Bağlı servis varsa AI video"],
    requiredInputs: ["Arşivdeki video çekimleri", "Kampanya stratejisi", "Marka tonu"],
    outputDescription: "Video planı (VideoPlanSchema) + render edilmiş video (yalnızca gerçek çekim varsa)",
    tools: ["brand.read", "products.read", "media.read", "outputs.read", "video.edit", "video.generate"],
    acceptanceCriteria: [
      "edit_existing yalnızca arşivde bulunan video kimliklerini kullanmalı",
      "Altyazı zamanları video süresini aşmamalı",
      "AI video servisi bağlı değilse video üretilmiş gibi gösterilmemeli",
    ],
    producesExternalProposal: false,
  },
  social: {
    id: "social",
    name: "Sosyal Medya Uzmanı",
    role: "Platforma uygun açıklamalar, içerik takvimi, yayın paketleri ve yayın durumu takibi yapar.",
    responsibilities: ["Platforma özel açıklamalar", "İçerik takvimi", "Yayın paketi", "Yayın durumu takibi"],
    requiredInputs: ["Strateji", "Tasarım briefleri / videolar", "Marka içerik dili"],
    outputDescription: "Sosyal medya yayın paketi (SocialPackageSchema)",
    tools: ["brand.read", "products.read", "media.read", "outputs.read", "calendar.write", "social.propose"],
    acceptanceCriteria: [
      "Instagram açıklaması 2.200 karakteri, en fazla 30 hashtag'i aşmamalı",
      "TikTok için otomatik yayın yoksa manuel paket hazırlanmalı",
      "Yayın yalnızca onaydan sonra yapılabilir",
    ],
    producesExternalProposal: true,
  },
  quality: {
    id: "quality",
    name: "Analiz ve Kalite Uzmanı",
    role: "Marka tutarlılığını, ürün bilgisi doğruluğunu, çıktı kalitesini, maliyetleri ve performansı kontrol eder.",
    responsibilities: ["Marka tutarlılığı", "Ürün bilgisi doğruluğu", "Uydurma iddia taraması", "Dil kontrolü", "Maliyet ve performans kontrolü"],
    requiredInputs: ["Kontrol edilecek çıktı sürümü", "Doğrulanmış marka ve ürün bilgileri"],
    outputDescription: "Kalite raporu (QaReviewSchema)",
    tools: ["brand.read", "products.read", "outputs.read", "costs.read", "media.read"],
    acceptanceCriteria: ["Her kontrol pass/warn/fail ile raporlanmalı", "Başarısız kontrol gerekçesi açık olmalı"],
    producesExternalProposal: false,
  },
};

export function agentName(id: string) {
  return (AGENTS as Record<string, AgentDefinition>)[id]?.name ?? id;
}

export class ToolPermissionError extends Error {}

/** Sunucu tarafı araç izni kontrolü. */
export function assertTool(agent: AgentId, tool: ToolId) {
  if (!AGENTS[agent].tools.includes(tool)) {
    throw new ToolPermissionError(`${AGENTS[agent].name} '${tool}' aracını kullanma iznine sahip değil.`);
  }
}

export function isSpecialist(id: string): id is SpecialistId {
  return ["marketing", "shopify", "design", "video", "social", "quality"].includes(id);
}
