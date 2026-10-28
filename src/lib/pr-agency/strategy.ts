// FriBee Brand Intelligence & PR Strategy 2026–2034 — çerçeve (saf modül, veritabanı yok).
// Buradaki her şey ÖNERİDİR (provenance: ai_recommendation / framework). Sahip onaylayana kadar resmî strateji sayılmaz.
// Kurallar:
//  - FriBee, büyük bir pazar lansmanına hazırlanan yeni nesil bir Amerikan streetwear markası olarak konumlanır.
//    Strateji bir "geri dönüş" veya "yeniden lansman" olarak anlatılmaz; şirket geçmişi veya kuruluş tarihi uydurulmaz.
//  - Satış rakamı, büyüme istatistiği veya basın kapsamı uydurulmaz. Hedefler, başlangıç değeri ölçülmeden sayıya bağlanmaz.

export type StrategyLevel = "vision" | "phase" | "annual" | "quarterly" | "monthly" | "weekly";
export type StrategyStatus = "proposed" | "approved" | "active" | "at_risk" | "done" | "dropped";
export type Provenance = "owner" | "ai_recommendation" | "framework";

export type Measurement = { value: number; measuredAt: string; source: string };
export type KeyResult = { label: string; metric: string; target: string; baseline: Measurement | null; current: Measurement | null };

export type SeedItem = {
  seedKey: string;
  level: StrategyLevel;
  parentSeedKey: string | null;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  title: string;
  body: string;
  ownerRole: string;
  provenance: Provenance;
  keyResults: KeyResult[];
  sort: number;
};

export const STRATEGY_TITLE = "FriBee Brand Intelligence & PR Strategy 2026–2034";
export const STRATEGY_START = "2026-01-01";
export const STRATEGY_END = "2034-12-31";

/** Önerilen konumlandırma satırı — resmî slogan DEĞİLDİR; sahip onaylamadan müşteriye gösterilmez. */
export const PROPOSED_POSITIONING_LINE = "FriBee — Beyond Fashion";

export const VISION = {
  title: STRATEGY_TITLE,
  body: [
    "Vision (proposed): build FriBee into a recognised new-generation American streetwear brand — distinctive collections, a loyal community and a credible cultural voice — through a disciplined, evidence-led brand and PR programme.",
    `Positioning line (proposed, not an official slogan): "${PROPOSED_POSITIONING_LINE}".`,
    "Operating principles: verified product imagery only; no invented history, figures or coverage; every external action (publishing, outreach, spend) requires owner approval; measurement follows the AMEC Integrated Evaluation Framework and the Barcelona Principles.",
  ].join("\n\n"),
};

export type Phase = { key: string; label: string; title: string; start: string; end: string; focus: string[]; ownerRole: string };

export const PHASES: Phase[] = [
  { key: "foundation_launch", label: "2026–2027", title: "Foundation and Launch", start: "2026-01-01", end: "2027-06-30", ownerRole: "pr_director",
    focus: ["Approve the brand platform (positioning, voice, visual system) in Brand Knowledge", "Measure baselines on every owned channel before setting numeric targets", "Verified product imagery for every active collection", "Connect the measurement stack (Shopify, Metricool, Brandwatch)", "Execute the market launch campaign with owner-approved budgets"] },
  { key: "community_recognition", label: "2027–2028", title: "Community and Recognition", start: "2027-07-01", end: "2028-06-30", ownerRole: "brand_strategy",
    focus: ["Grow an owned community around the collections", "Earn first-tier coverage in US streetwear and fashion media", "Creator seeding programme (owner-approved, disclosed partnerships only)", "Recurring signature brand moments"] },
  { key: "cultural_expansion", label: "2028–2030", title: "Cultural Expansion", start: "2028-07-01", end: "2030-06-30", ownerRole: "brand_strategy",
    focus: ["Collaborations and cultural partnerships only where verified and approved", "Expand the storytelling universe of each collection", "Build cultural relevance measured by earned share of voice, not impressions"] },
  { key: "national_growth", label: "2030–2032", title: "National Growth", start: "2030-07-01", end: "2032-06-30", ownerRole: "ecommerce_intelligence",
    focus: ["Scale awareness across US regions using proven content", "Retail and distribution partnerships evaluated on evidence", "Customer lifetime value and retention programmes"] },
  { key: "international_development", label: "2032–2034", title: "International Development", start: "2032-07-01", end: "2034-12-31", ownerRole: "pr_director",
    focus: ["Select pilot international markets on research evidence", "Localise voice and campaigns without changing product artwork", "2034 strategy evaluation and next-horizon plan"] },
];

const unmeasured = (label: string, metric: string, target = "Set after baseline is measured"): KeyResult => ({ label, metric, target, baseline: null, current: null });

/** Yıllık hedefler (öneri). Sayısal hedef, başlangıç ölçülmeden verilmez. */
export const ANNUAL: { year: number; phaseKey: string; title: string; body: string; ownerRole: string; keyResults: KeyResult[] }[] = [
  { year: 2026, phaseKey: "foundation_launch", ownerRole: "pr_director", title: "Build the launch foundation",
    body: "Approve the brand platform, measure baselines and prepare verified assets so the launch rests on facts, not assumptions.",
    keyResults: [
      unmeasured("Core KPI baselines measured with source", "baselines_measured", "5 of 5 core KPIs measured (social reach, engagement rate, site sessions, branded search, earned mentions)"),
      unmeasured("Active collections with verified product references", "verified_collections", "100% of active collections"),
      unmeasured("Brand platform approved by owner", "brand_platform_approved", "Approved in Brand Knowledge"),
    ] },
  { year: 2027, phaseKey: "foundation_launch", ownerRole: "pr_director", title: "Launch FriBee in the US market",
    body: "Deliver the market launch on an approved plan and budget; earn first coverage; start the creator seeding programme.",
    keyResults: [unmeasured("Launch campaign delivered on approved plan", "launch_delivered", "Delivered"), unmeasured("Earned media placements in target outlets", "earned_mentions"), unmeasured("Owned community size", "community_size")] },
  { year: 2028, phaseKey: "community_recognition", ownerRole: "brand_strategy", title: "Grow community and recognition",
    body: "Turn launch awareness into an engaged community and recurring recognition in streetwear media.",
    keyResults: [unmeasured("Engagement rate on owned social", "engagement_rate"), unmeasured("Share of voice in streetwear media", "share_of_voice"), unmeasured("Returning customer rate", "returning_customer_rate")] },
  { year: 2029, phaseKey: "cultural_expansion", ownerRole: "brand_strategy", title: "Expand cultural relevance",
    body: "Deepen the collections' storytelling and pursue verified cultural partnerships.",
    keyResults: [unmeasured("Approved cultural partnerships delivered", "partnerships_delivered"), unmeasured("Earned share of voice", "share_of_voice"), unmeasured("Brand association strength (survey)", "brand_association")] },
  { year: 2030, phaseKey: "cultural_expansion", ownerRole: "brand_strategy", title: "Establish a credible cultural voice",
    body: "Make FriBee a recognised voice in its cultural territories and prepare for national scale.",
    keyResults: [unmeasured("Aided brand awareness in target segment (survey)", "aided_awareness"), unmeasured("Signature annual moment reach (measured)", "signature_moment_reach")] },
  { year: 2031, phaseKey: "national_growth", ownerRole: "ecommerce_intelligence", title: "Scale national awareness",
    body: "Extend proven content and partnerships across US regions with measured efficiency.",
    keyResults: [unmeasured("Regional awareness coverage", "regional_awareness"), unmeasured("Customer acquisition cost trend", "cac_trend")] },
  { year: 2032, phaseKey: "national_growth", ownerRole: "ecommerce_intelligence", title: "Consolidate national growth",
    body: "Strengthen retention and distribution; prepare evidence for international pilots.",
    keyResults: [unmeasured("Customer lifetime value", "clv"), unmeasured("Retail / distribution partners on evidence", "distribution_partners")] },
  { year: 2033, phaseKey: "international_development", ownerRole: "pr_director", title: "Pilot international markets",
    body: "Enter pilot markets chosen on research evidence; localise voice without altering product artwork.",
    keyResults: [unmeasured("Pilot markets launched on approved plan", "pilot_markets"), unmeasured("International earned coverage", "intl_earned_mentions")] },
  { year: 2034, phaseKey: "international_development", ownerRole: "pr_director", title: "International development and 2034 review",
    body: "Scale what worked internationally and evaluate the full eight-year programme against its measured baselines.",
    keyResults: [unmeasured("Eight-year evaluation completed", "strategy_evaluation", "Completed and approved"), unmeasured("International revenue share", "intl_revenue_share")] },
];

export function quarterOf(date: string): { key: string; start: string; end: string; year: number; q: number } {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  const start = new Date(Date.UTC(year, (q - 1) * 3, 1));
  const end = new Date(Date.UTC(year, q * 3, 0));
  return { key: `${year}-Q${q}`, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), year, q };
}

export function monthOf(date: string): { key: string; start: string; end: string } {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { key: start.toISOString().slice(0, 7), start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** ISO hafta (Pazartesi başlangıçlı). */
export function weekOf(date: string): { key: string; start: string; end: string } {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  const monday = new Date(d.getTime() - (day - 1) * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const t = new Date(d.getTime() + (4 - day) * 86_400_000);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { key: `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

export function phaseAt(date: string): Phase | null {
  const d = date.slice(0, 10);
  return PHASES.find((p) => p.start <= d && d <= p.end) ?? null;
}

/** Strateji içinde ilerleme (0..1) — yalnızca takvim; performans değildir. */
export function timelineProgress(date: string): number {
  const t = new Date(`${date.slice(0, 10)}T00:00:00Z`).getTime();
  const s = new Date(`${STRATEGY_START}T00:00:00Z`).getTime();
  const e = new Date(`${STRATEGY_END}T00:00:00Z`).getTime();
  return Math.max(0, Math.min(1, (t - s) / (e - s)));
}

/** Yakın dönem çeyreklik OKR önerileri (lansman dönemi). Sahip düzenler/onaylar; sonraki çeyrekleri çeyreklik inceleme önerir. */
const QUARTERLY: { key: string; title: string; body: string; ownerRole: string; keyResults: KeyResult[] }[] = [
  { key: "2026-Q4", ownerRole: "pr_measurement", title: "Measure before we market",
    body: "Connect data sources and record first baselines so every later target is grounded in measured data.",
    keyResults: [unmeasured("Measurement integrations verified", "integrations_verified", "Shopify, Metricool and Brandwatch verified"), unmeasured("Baselines recorded with source", "baselines_measured", "At least 3 of 5 core KPIs"), unmeasured("Holiday season plan approved", "holiday_plan_approved", "Approved by the owner before the approval deadline")] },
  { key: "2027-Q1", ownerRole: "brand_strategy", title: "Finalise the launch platform",
    body: "Approve the launch narrative, creative system and media plan.",
    keyResults: [unmeasured("Launch narrative approved", "launch_narrative_approved", "Approved"), unmeasured("Launch creative produced from verified imagery", "launch_creative_ready", "Complete set approved"), unmeasured("Target media list researched (source-backed)", "media_list_ready", "List with sources")] },
  { key: "2027-Q2", ownerRole: "pr_director", title: "Launch",
    body: "Execute the approved launch plan and measure against the recorded baselines.",
    keyResults: [unmeasured("Launch milestones delivered on time", "launch_milestones"), unmeasured("Earned media placements", "earned_mentions"), unmeasured("Launch-period site sessions vs baseline", "site_sessions")] },
  { key: "2027-Q3", ownerRole: "influencer_relations", title: "Seed the community",
    body: "Start the disclosed creator seeding programme and community rituals.",
    keyResults: [unmeasured("Approved creator partnerships active", "creator_partnerships"), unmeasured("Engagement rate vs baseline", "engagement_rate")] },
  { key: "2027-Q4", ownerRole: "pr_measurement", title: "First-year evaluation",
    body: "Evaluate launch outcomes with AMEC IEF and set 2028 targets from measured results.",
    keyResults: [unmeasured("Launch evaluation report approved", "launch_evaluation", "Approved"), unmeasured("2028 targets set from measured data", "targets_2028", "Set")] },
];

/** Yaklaşan ayların kampanya planı önerileri (takvimdeki doğrulanmış tarihlerle birlikte kullanılır). */
const MONTHLY: { key: string; title: string; body: string; ownerRole: string }[] = [
  { key: "2026-11", ownerRole: "social_media", title: "Holiday season content plan (proposal)", body: "Plan owned-channel content around verified US holiday dates using only verified product imagery. Any paid promotion requires a separate approved budget." },
  { key: "2026-12", ownerRole: "creative_director", title: "Collections storytelling series (proposal)", body: "A short-form series introducing each collection's story from Brand Knowledge facts; no invented history." },
  { key: "2027-01", ownerRole: "brand_strategy", title: "Launch platform workshop outputs (proposal)", body: "Consolidate positioning, voice and creative system for owner approval." },
];

export function seedPlan(): SeedItem[] {
  const out: SeedItem[] = [];
  out.push({ seedKey: "vision", level: "vision", parentSeedKey: null, periodKey: "2026-2034", periodStart: STRATEGY_START, periodEnd: STRATEGY_END, title: VISION.title, body: VISION.body, ownerRole: "pr_director", provenance: "ai_recommendation", keyResults: [], sort: 0 });
  PHASES.forEach((p, i) => out.push({ seedKey: `phase:${p.key}`, level: "phase", parentSeedKey: "vision", periodKey: p.label.replace("–", "-"), periodStart: p.start, periodEnd: p.end, title: p.title, body: p.focus.map((f) => `• ${f}`).join("\n"), ownerRole: p.ownerRole, provenance: "ai_recommendation", keyResults: [], sort: i }));
  for (const a of ANNUAL) out.push({ seedKey: `annual:${a.year}`, level: "annual", parentSeedKey: `phase:${a.phaseKey}`, periodKey: String(a.year), periodStart: `${a.year}-01-01`, periodEnd: `${a.year}-12-31`, title: a.title, body: a.body, ownerRole: a.ownerRole, provenance: "ai_recommendation", keyResults: a.keyResults, sort: a.year });
  for (const q of QUARTERLY) {
    const [y, n] = q.key.split("-Q").map(Number);
    const qi = quarterOf(`${y}-${String((n - 1) * 3 + 1).padStart(2, "0")}-01`);
    out.push({ seedKey: `quarterly:${q.key}`, level: "quarterly", parentSeedKey: `annual:${y}`, periodKey: q.key, periodStart: qi.start, periodEnd: qi.end, title: q.title, body: q.body, ownerRole: q.ownerRole, provenance: "ai_recommendation", keyResults: q.keyResults, sort: n });
  }
  for (const m of MONTHLY) {
    const mi = monthOf(`${m.key}-01`);
    const qk = quarterOf(mi.start).key;
    out.push({ seedKey: `monthly:${m.key}`, level: "monthly", parentSeedKey: `quarterly:${qk}`, periodKey: m.key, periodStart: mi.start, periodEnd: mi.end, title: m.title, body: m.body, ownerRole: m.ownerRole, provenance: "ai_recommendation", keyResults: [], sort: Number(m.key.slice(5)) });
  }
  return out;
}

/** Anahtar sonucun durumu: ölçülmemiş hedef "başarıldı" sayılmaz. */
export function keyResultState(kr: KeyResult): "unmeasured" | "baseline_only" | "tracking" {
  if (!kr.baseline && !kr.current) return "unmeasured";
  if (kr.baseline && !kr.current) return "baseline_only";
  return "tracking";
}

/** Ölçüm doğrulaması: sayı, tarih ve kaynak zorunlu. */
export function validMeasurement(m: unknown): m is Measurement {
  const x = m as Measurement;
  return !!x && Number.isFinite(x.value) && typeof x.source === "string" && x.source.trim().length >= 3 && /^\d{4}-\d{2}-\d{2}/.test(x.measuredAt ?? "");
}

/** Güvenli metin kontrolleri: stratejide "comeback/relaunch" anlatımı kullanılmaz. */
export const FORBIDDEN_FRAMING = /\b(come\s*back|comeback|re-?launch|rebirth|is back|returns)\b/i;
