import type { ArchiveIndex } from "./archive";
import { FRIBEE_THEMES, type KnowledgeGraph } from "./graph";
import type { ArchiveCategory } from "./types";

// PR Ajansı: 24 aylık ABD marka bilinirliği yol haritası (Kasım 2026 – Ekim 2028), 8 çeyrek.
// Bu bir ÖNERİDİR, gerçek değildir. Geçmiş sonuç, pazar verisi veya mevcut ortaklık uydurulmaz;
// hedef değerler ilk çeyrekte ölçülen temel değere göre sahip tarafından belirlenir.
// Tam sürüm, Drive arşivi bağlanıp ürün doğrusu onaylandıktan sonra kaynaklarla güncellenir.

export type Workstream = "launch_foundation" | "editorial" | "microcreators" | "ugc_community" | "partnerships" | "reputation";

export type RoadmapQuarter = {
  n: number;
  label: string;
  start: string; // YYYY-MM
  end: string;
  focus: string;
  workstreams: Workstream[];
  actions: string[];
  /** Bu çeyreği kaynaklı hale getirmek için gereken arşiv kategorileri. */
  requiredSources: ArchiveCategory[];
  /** Yürütmeden önce sahip onayı gereken kararlar. */
  ownerApprovals: string[];
};

export type RoadmapMetric = { name: string; definition: string; baseline: "to_be_measured"; target: "owner_to_set_after_baseline" };

export type PrRoadmap = {
  status: "proposal";
  disclaimer: string;
  period: { start: string; end: string };
  sourceBacked: boolean;
  citations: { claim: string; sourceUrl: string }[];
  missingSources: ArchiveCategory[];
  quarters: RoadmapQuarter[];
  metrics: RoadmapMetric[];
  monthlyReviews: string[];
  guardrails: string[];
};

export const ROADMAP_DISCLAIMER =
  "Proposal only — not a statement of fact. No historic results, market data or existing partnerships are assumed. " +
  "Targets are set by the owner after Q1 baselines; every external action needs owner approval.";

const QUARTERS: RoadmapQuarter[] = [
  {
    n: 1, label: "Q1 · Launch foundation", start: "2026-11", end: "2027-01",
    focus: "Verified brand truth, US positioning draft, owned-channel and monitoring baseline.",
    workstreams: ["launch_foundation", "reputation"],
    actions: [
      "Connect FriBee Master Archive read-only and clear the review queue for product names, stories and theme art.",
      "Draft a US press kit using only approved facts (four themes: Space Alien, Music, Anime, Save the Bee).",
      "Define brand voice and message house per theme; owner approves before any use.",
      "Set up brand-mention and review monitoring; record baselines for every metric.",
    ],
    requiredSources: ["product_names", "product_story", "collection_history", "lookbook", "catalog_photo"],
    ownerApprovals: ["US positioning statement", "Press kit facts", "Monitoring keywords"],
  },
  {
    n: 2, label: "Q2 · Editorial storytelling", start: "2027-02", end: "2027-04",
    focus: "Source-backed theme stories and an editorial pitch list built from research, not assumptions.",
    workstreams: ["editorial", "reputation"],
    actions: [
      "Publish theme stories on owned channels only from approved archive material.",
      "Research relevant US editorial outlets and writers; list is a candidate set, not existing relationships.",
      "Evaluate a Save the Bee awareness angle; verify any cause claim and partner before mentioning it.",
    ],
    requiredSources: ["product_story", "design_source", "lookbook"],
    ownerApprovals: ["Pitch list", "Each pitch text before sending"],
  },
  {
    n: 3, label: "Q3 · Microcreator pilot", start: "2027-05", end: "2027-07",
    focus: "Small, gifted-product microcreator pilot with clear disclosure and product-accurate visuals.",
    workstreams: ["microcreators", "reputation"],
    actions: [
      "Shortlist microcreators per theme with brand-safety screening.",
      "Provide original-resolution product files; product art in AI visuals uses verified compositing.",
      "Require FTC-compliant disclosure on every creator post.",
    ],
    requiredSources: ["catalog_photo", "catalog_video", "design_source"],
    ownerApprovals: ["Creator shortlist", "Gifting budget", "Creator brief"],
  },
  {
    n: 4, label: "Q4 · UGC & community", start: "2027-08", end: "2027-10",
    focus: "Customer content and community programs with explicit rights and consent.",
    workstreams: ["ugc_community", "reputation"],
    actions: [
      "Launch opt-in UGC sharing with written usage rights.",
      "Create theme communities (e.g. Anime, Music) moderated with documented rules.",
      "Year-1 review against Q1 baselines; owner sets year-2 targets.",
    ],
    requiredSources: ["catalog_photo", "pr_coverage"],
    ownerApprovals: ["UGC rights terms", "Community guidelines", "Year-2 targets"],
  },
  {
    n: 5, label: "Q5 · Selective partnerships", start: "2027-11", end: "2028-01",
    focus: "Evaluate a small number of aligned partnerships; none are assumed to exist today.",
    workstreams: ["partnerships", "editorial", "reputation"],
    actions: [
      "Score candidate partners on brand fit, values and risk; shortlist only.",
      "Holiday editorial stories using approved collection history.",
    ],
    requiredSources: ["collection_history", "business_record"],
    ownerApprovals: ["Partner shortlist", "Any agreement (legal review)"],
  },
  {
    n: 6, label: "Q6 · Scale what worked", start: "2028-02", end: "2028-04",
    focus: "Expand only the channels whose measured results beat baseline.",
    workstreams: ["editorial", "microcreators", "reputation"],
    actions: [
      "Repeat the strongest theme story formats; retire underperformers.",
      "Second microcreator cohort if pilot met owner targets.",
    ],
    requiredSources: ["pr_coverage", "product_story"],
    ownerApprovals: ["Channel scale-up decision"],
  },
  {
    n: 7, label: "Q7 · Community & partner depth", start: "2028-05", end: "2028-07",
    focus: "Deepen community programs and any approved partnership.",
    workstreams: ["ugc_community", "partnerships", "reputation"],
    actions: [
      "Co-created content with approved partners and community members.",
      "Refresh press kit with newly approved facts and coverage.",
    ],
    requiredSources: ["pr_coverage", "lookbook"],
    ownerApprovals: ["Co-created content", "Press kit refresh"],
  },
  {
    n: 8, label: "Q8 · Consolidate & plan next", start: "2028-08", end: "2028-10",
    focus: "24-month review and next-cycle plan grounded in measured data.",
    workstreams: ["editorial", "reputation"],
    actions: [
      "Full 24-month report: metrics vs baselines, coverage list with links, lessons.",
      "Propose next 24-month plan for owner review.",
    ],
    requiredSources: ["pr_coverage"],
    ownerApprovals: ["24-month report", "Next-cycle plan"],
  },
];

const METRICS: RoadmapMetric[] = [
  { name: "Earned media mentions", definition: "Verified US articles/podcasts mentioning FriBee, each with a source link.", baseline: "to_be_measured", target: "owner_to_set_after_baseline" },
  { name: "Branded search interest", definition: "US search interest for 'FriBee' from a named analytics source.", baseline: "to_be_measured", target: "owner_to_set_after_baseline" },
  { name: "Creator posts with disclosure", definition: "Creator posts published with compliant disclosure.", baseline: "to_be_measured", target: "owner_to_set_after_baseline" },
  { name: "UGC submissions with rights", definition: "Customer content received with written usage rights.", baseline: "to_be_measured", target: "owner_to_set_after_baseline" },
  { name: "Sentiment & issues", definition: "Share of negative mentions and open reputation issues from monitoring.", baseline: "to_be_measured", target: "owner_to_set_after_baseline" },
  { name: "Owned-channel reach", definition: "Reach/followers on connected owned channels.", baseline: "to_be_measured", target: "owner_to_set_after_baseline" },
];

const GUARDRAILS = [
  "No paid media without a separate owner-approved budget.",
  "No external posting, pitching or creator outreach without owner approval of the exact text.",
  "Only approved (confirmed) facts may appear in public materials.",
  "Product visuals: original files or verified compositing; generative references alone are not trusted for product fidelity.",
  "Reputation/crisis: monitoring alerts go to the owner; no automated public replies.",
];

/** Kasım 2026'dan Ekim 2028'e 24 aylık inceleme ayı listesi (YYYY-MM). */
export function monthlyReviewSchedule(start = "2026-11", months = 24): string[] {
  const [y, m] = start.split("-").map(Number);
  return Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

/**
 * Yol haritasını üretir. Kaynak atıfları yalnızca grafikteki onaylı olgulardan gelir;
 * arşivde hiç dosyası olmayan gerekli kategoriler "missingSources" olarak raporlanır.
 */
export function buildPrRoadmap(graph: KnowledgeGraph, index: ArchiveIndex | null): PrRoadmap {
  const brandId = graph.brandId;
  const citations: PrRoadmap["citations"] = [];
  for (const t of FRIBEE_THEMES) {
    const color = graph.canonicalFacts(brandId, t.id).find((f) => f.attribute === "theme_color");
    for (const p of color?.provenance ?? []) citations.push({ claim: `${t.name} theme color is ${color!.value}`, sourceUrl: p.sourceUrl });
  }
  const summary = index?.summary() ?? ({} as Record<ArchiveCategory, number>);
  const required = [...new Set(QUARTERS.flatMap((q) => q.requiredSources))];
  const missingSources = required.filter((c) => !summary[c]);
  return {
    status: "proposal",
    disclaimer: ROADMAP_DISCLAIMER,
    period: { start: "2026-11", end: "2028-10" },
    sourceBacked: !!index && missingSources.length === 0,
    citations,
    missingSources,
    quarters: QUARTERS,
    metrics: METRICS,
    monthlyReviews: monthlyReviewSchedule(),
    guardrails: GUARDRAILS,
  };
}
