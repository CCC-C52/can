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
  { id: "pr_director", title: "AI PR Director", titleTr: "AI PR Direktörü", mission: "Coordinates the agency through the task engine, prioritises the approval queue and owns the eight-year strategy.",
    engineAgents: ["manager"], prRoles: ["strategy_director", "reputation_crisis"], operations: ["weekly_report", "annual_review"], integrations: [], evidence: "Saved reports and approved plans" },
  { id: "brand_strategy", title: "Brand Strategy Specialist", titleTr: "Marka Strateji Uzmanı", mission: "Maintains positioning (STP, CBBE), annual objectives and quarterly OKRs; proposes strategic adjustments from measured results.",
    engineAgents: ["marketing"], prRoles: [], operations: ["quarterly_review"], integrations: [], evidence: "Saved strategy revisions with reasons" },
  { id: "market_intelligence", title: "Market Intelligence Specialist", titleTr: "Pazar İstihbaratı Uzmanı", mission: "Monitors fashion trends, competitors and cultural developments from connected, compliant sources.",
    engineAgents: [], prRoles: ["trend_analyst", "social_listening_analyst"], operations: ["daily_brief"], integrations: ["brandwatch"], evidence: "Source-backed findings with URLs and retrieval time" },
  { id: "media_relations", title: "Media Relations Specialist", titleTr: "Medya İlişkileri Uzmanı", mission: "Researches journalists and outlets, drafts pitches and tracks coverage with verifiable links.",
    engineAgents: ["pr"], prRoles: ["media_relations"], operations: [], integrations: ["muck_rack"], evidence: "Coverage URLs; outreach only with authorised delivery evidence" },
  { id: "influencer_relations", title: "Influencer Relations Specialist", titleTr: "Influencer İlişkileri Uzmanı", mission: "Identifies creator opportunities and drafts disclosed partnership proposals; never assumes existing partnerships.",
    engineAgents: ["pr"], prRoles: ["creator_relations"], operations: ["weekly_report"], integrations: ["brandwatch"], evidence: "Owner-approved proposals; delivery evidence for any outreach" },
  { id: "creative_director", title: "Creative Director", titleTr: "Kreatif Direktör", mission: "Directs image and video production from verified product imagery; protects artwork, colours and collection names.",
    engineAgents: ["design", "video"], prRoles: [], operations: [], integrations: ["runway", "adobe"], evidence: "Playable media files and verified image assets" },
  { id: "social_media", title: "Social Media Specialist", titleTr: "Sosyal Medya Uzmanı", mission: "Plans the content calendar, prepares publishing packages and reads engagement once analytics are connected.",
    engineAgents: ["social"], prRoles: ["campaign_planner"], operations: ["weekly_report"], integrations: ["metricool"], evidence: "Publishing confirmation from the platform" },
  { id: "ecommerce_intelligence", title: "E-commerce Intelligence Specialist", titleTr: "E-ticaret İstihbarat Uzmanı", mission: "Reads the product catalogue, sales and customer signals for campaign attribution and planning.",
    engineAgents: ["shopify", "finance"], prRoles: [], operations: ["monthly_presentation"], integrations: ["shopify"], evidence: "Data read from the connected store" },
  { id: "pr_measurement", title: "PR Measurement Specialist", titleTr: "PR Ölçüm Uzmanı", mission: "Measures outputs, out-takes, outcomes and impact (AMEC IEF, Barcelona Principles 4.0); maintains KPI baselines.",
    engineAgents: ["quality"], prRoles: ["performance_analyst"], operations: ["monthly_presentation", "quarterly_review"], integrations: ["metricool", "brandwatch", "shopify"], evidence: "Measured values with source and date" },
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
