// FriBee AI PR Ajansı — uzman kadrosu.
// Yeni, paralel bir ajan sistemi DEĞİLDİR: her uzman, mevcut görev motoru ajanlarına (registry.ts) ve PR ajansının
// zamanlanmış rollerine (roles.ts) eşlenir. Koordinasyon mevcut görev motoru ve onay akışı üzerinden yürür.
// Hiçbir uzman dış iletişim gönderemez, yayın yapamaz, ücretli üretim başlatamaz veya bütçe değiştiremez.

import type { AgentId } from "@/lib/agents/schemas";

export type IntegrationId = "brandwatch" | "muck_rack" | "metricool" | "runway" | "adobe" | "shopify";

export type Specialist = {
  id: string;
  title: string;
  titleTr: string;
  mission: string;
  /** Görev motorunda bu uzmanın işini yapan mevcut ajanlar. */
  engineAgents: AgentId[];
  /** PR ajansı zamanlanmış rolleri (roles.ts). */
  prRoles: string[];
  /** Sahibi olduğu zamanlanmış operasyonlar (operations.ts). */
  operations: string[];
  /** Tam kapasite için gereken dış platformlar; bağlı değilse uzman yalnızca iç verilerle çalışır. */
  integrations: IntegrationId[];
  /** Başarı için gereken kanıt türü. */
  evidence: string;
};

export const SPECIALISTS: Specialist[] = [
  { id: "pr_director", title: "AI PR Director", titleTr: "AI PR Direktörü", mission: "Ajansı görev motoru üzerinden koordine eder, onay kuyruğunu önceliklendirir ve sekiz yıllık stratejinin sahibidir.",
    engineAgents: ["manager"], prRoles: ["strategy_director", "reputation_crisis"], operations: ["weekly_report", "annual_review"], integrations: [], evidence: "Kaydedilmiş raporlar ve onaylı planlar" },
  { id: "brand_strategy", title: "Brand Strategy Specialist", titleTr: "Marka Strateji Uzmanı", mission: "Konumlandırmayı (STP, CBBE), yıllık hedefleri ve çeyreklik OKR'leri yönetir; ölçülmüş sonuçlardan stratejik ayarlama önerir.",
    engineAgents: ["marketing"], prRoles: [], operations: ["quarterly_review"], integrations: [], evidence: "Gerekçeli kayıtlı strateji değişiklikleri" },
  { id: "market_intelligence", title: "Market Intelligence Specialist", titleTr: "Pazar İstihbaratı Uzmanı", mission: "Moda trendlerini, rakipleri ve kültürel gelişmeleri bağlı ve uyumlu kaynaklardan izler.",
    engineAgents: [], prRoles: ["trend_analyst", "social_listening_analyst"], operations: ["daily_brief"], integrations: ["brandwatch"], evidence: "Adres ve alım zamanıyla kaynaklı bulgular" },
  { id: "media_relations", title: "Media Relations Specialist", titleTr: "Medya İlişkileri Uzmanı", mission: "Gazeteci ve yayın araştırır, basın taslakları hazırlar, kapsamı doğrulanabilir bağlantılarla izler.",
    engineAgents: ["pr"], prRoles: ["media_relations"], operations: [], integrations: ["muck_rack"], evidence: "Kapsam adresleri; ulaşım yalnızca yetkili gönderim kanıtıyla" },
  { id: "influencer_relations", title: "Influencer Relations Specialist", titleTr: "Influencer İlişkileri Uzmanı", mission: "İçerik oluşturucu fırsatlarını belirler ve beyanlı iş birliği önerileri hazırlar; var olmayan ortaklık varsaymaz.",
    engineAgents: ["pr"], prRoles: ["creator_relations"], operations: ["weekly_report"], integrations: ["brandwatch"], evidence: "Sahip onaylı öneriler; her ulaşım için gönderim kanıtı" },
  { id: "creative_director", title: "Creative Director", titleTr: "Kreatif Direktör", mission: "Görsel ve video üretimini doğrulanmış ürün görselleriyle yönetir; baskı, renk ve koleksiyon adlarını korur.",
    engineAgents: ["design", "video"], prRoles: [], operations: [], integrations: ["runway", "adobe"], evidence: "Oynatılabilir medya dosyaları ve doğrulanmış görseller" },
  { id: "social_media", title: "Social Media Specialist", titleTr: "Sosyal Medya Uzmanı", mission: "İçerik takvimini planlar, yayın paketlerini hazırlar; analitik bağlanınca etkileşimi okur.",
    engineAgents: ["social"], prRoles: ["campaign_planner"], operations: ["weekly_report"], integrations: ["metricool"], evidence: "Platformdan yayın onayı" },
  { id: "ecommerce_intelligence", title: "E-commerce Intelligence Specialist", titleTr: "E-ticaret İstihbarat Uzmanı", mission: "Kampanya atfı ve planlama için ürün kataloğunu, satış ve müşteri sinyallerini okur.",
    engineAgents: ["shopify", "finance"], prRoles: [], operations: ["monthly_presentation"], integrations: ["shopify"], evidence: "Bağlı mağazadan okunan veri" },
  { id: "pr_measurement", title: "PR Measurement Specialist", titleTr: "PR Ölçüm Uzmanı", mission: "Çıktı, algı, sonuç ve etkiyi ölçer (AMEC IEF, Barcelona Principles 4.0); KPI başlangıç değerlerini tutar.",
    engineAgents: ["quality"], prRoles: ["performance_analyst"], operations: ["monthly_presentation", "quarterly_review"], integrations: ["metricool", "brandwatch", "shopify"], evidence: "Kaynak ve tarihli ölçülmüş değerler" },
];

export type SpecialistReadiness = "ready" | "partial" | "internal_only";

/** Uzmanın hazır olma durumu: gereken platformların kaçının doğrulandığına göre. Platform gerektirmeyen uzman "ready". */
export function specialistReadiness(s: Specialist, verified: Set<string>): { state: SpecialistReadiness; missing: IntegrationId[] } {
  const missing = s.integrations.filter((i) => !verified.has(i));
  if (!s.integrations.length || !missing.length) return { state: "ready", missing };
  return { state: missing.length < s.integrations.length ? "partial" : "internal_only", missing };
}

export function specialistById(id: string) {
  return SPECIALISTS.find((s) => s.id === id);
}
