import type { FeedHealth, ScoredCluster } from "./trends";
import type { Observance } from "./observances";
import type { Roadmap } from "./roadmap";
import type { ReportKind } from "./roles";

// Günlük özet, haftalık strateji raporu ve aylık sunum üreticileri. Saf ve deterministik (model çağrısı yok).
// Bağlı ve taze kaynak yoksa canlı kapsama/metrik UYDURULMAZ: rapor bunu açıkça söyler ve yalnızca
// doğrulanabilir takvim verisinden öneri üretir.

export type Insight = {
  title: string;
  detail: string;
  role: string;
  sourceLinks: { url: string; title: string; publishedAt: string | null; sourceId: string }[];
  confidence: number;
  effort: "low" | "medium" | "high";
  costRangeUsd: [number, number];
  /** Önerinin uygulanması dış iletişim/ücretli işlem içeriyorsa sahibin onayı gerekir. */
  requiresApproval: boolean;
};

export type Briefing = {
  kind: ReportKind;
  periodKey: string;
  generatedAt: string;
  title: string;
  dataStatus: "no_connected_sources" | "stale" | "partial" | "fresh";
  dataStatusNote: string;
  insights: Insight[];
  risks: string[];
  flags: { type: "crisis_watch" | "major_opportunity"; clusterLabel: string; sourceLinks: string[] }[];
  calendar: { id: string; name: string; date: string; kind: string; approvalDeadline: string; daysToApprovalDeadline: number }[];
  feedHealth: FeedHealth[];
  slides?: { title: string; bullets: string[] }[];
  /** Operasyon bölümleri (haftalık kampanya incelemesi, çeyreklik OKR değerlendirmesi vb.). Yalnızca kayıtlı veriden. */
  sections?: { title: string; bullets: string[] }[];
};

/** Strateji ve iç operasyon verisi (yalnızca veritabanındaki kayıtlı/ölçülmüş bilgiler). */
export type StrategyContext = {
  phase: { title: string; label: string; focus: string[] } | null;
  annual: { periodKey: string; title: string; status: string; keyResults: { label: string; target: string; state: "unmeasured" | "baseline_only" | "tracking"; baseline: number | null; current: number | null; source: string | null }[] }[];
  quarter: { periodKey: string; title: string; status: string; keyResults: { label: string; target: string; state: "unmeasured" | "baseline_only" | "tracking"; baseline: number | null; current: number | null; source: string | null }[] }[];
  nextAnnual: { periodKey: string; title: string }[];
  budget: { spent30dUsd: number | null; dailyLimitUsd: number | null; unknownCostEntries: number };
  activeCampaigns: { title: string; status: string }[];
  drafts: { social: number; outreach: number; creative: number };
  measuredKpis: number;
};

export type BriefingInput = {
  kind: ReportKind;
  periodKey: string;
  now: Date;
  brandName: string;
  feeds: FeedHealth[];
  clusters: ScoredCluster[];
  /** Yaklaşan etkinlikler ve onay son tarihleri (event-plan'dan). */
  upcoming: { event: Observance; approvalDeadline: string }[];
  pendingApprovals: number;
  roadmap?: Roadmap;
  strategy?: StrategyContext;
};

const WINDOW_DAYS: Record<ReportKind, number> = { daily_brief: 14, weekly_report: 45, monthly_presentation: 120, quarterly_review: 180, annual_review: 365 };

export function dataStatus(feeds: FeedHealth[]): { status: Briefing["dataStatus"]; note: string } {
  const connected = feeds.filter((f) => f.connected);
  if (!connected.length) return { status: "no_connected_sources", note: "No trend sources are connected. This report contains no live coverage, social metrics or press data — only verifiable calendar-based recommendations." };
  const healthy = connected.filter((f) => f.status === "healthy");
  if (!healthy.length) return { status: "stale", note: `${connected.length} source(s) connected but none has fresh data (stale/failing/never fetched). Trend insights are withheld.` };
  if (healthy.length < connected.length) return { status: "partial", note: `${healthy.length}/${connected.length} connected sources are fresh. Coverage is partial.` };
  return { status: "fresh", note: `All ${healthy.length} connected sources are fresh.` };
}

function days(from: Date, to: string) {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / 86_400_000);
}

export function buildBriefing(input: BriefingInput): Briefing {
  const { now, kind } = input;
  const ds = dataStatus(input.feeds);
  const windowDays = WINDOW_DAYS[kind];
  // Bayat/bağlantısız veriden trend içgörüsü çıkarılmaz
  const usableClusters = ds.status === "fresh" || ds.status === "partial" ? input.clusters : [];

  const insights: Insight[] = [];
  const ranked = [...usableClusters].filter((c) => c.opportunity).sort((a, b) => b.relevance.score * b.confidence - a.relevance.score * a.confidence);
  for (const c of ranked.slice(0, kind === "daily_brief" ? 5 : 10)) {
    insights.push({
      title: c.label,
      detail: `${c.opportunity} Velocity: ${c.velocity.label} (${c.velocity.last24h} in 24h vs ${c.velocity.prior7dDailyAvg}/day prior week); ${c.sources.length} source(s).`,
      role: "trend_analyst",
      sourceLinks: c.items.slice(0, 5).map((i) => ({ url: i.url, title: i.title, publishedAt: i.publishedAt, sourceId: i.sourceId })),
      confidence: c.confidence,
      effort: c.relevance.score >= 0.6 ? "medium" : "low",
      costRangeUsd: c.relevance.score >= 0.6 ? [0, 500] : [0, 150],
      requiresApproval: true,
    });
  }

  // Pencere içindeki etkinlikler + onay son tarihi 14 gün içinde olan daha uzak etkinlikler (proaktif hazırlık)
  const calendar = input.upcoming
    .filter((u) => u.event.date && days(now, u.event.date) >= 0 && (days(now, u.event.date) <= windowDays || (days(now, u.approvalDeadline) >= 0 && days(now, u.approvalDeadline) <= 14)))
    .map((u) => ({ id: u.event.id, name: u.event.name, date: u.event.date!, kind: u.event.kind, approvalDeadline: u.approvalDeadline, daysToApprovalDeadline: days(now, u.approvalDeadline) }));
  for (const c of calendar.filter((x) => x.daysToApprovalDeadline >= 0 && x.daysToApprovalDeadline <= 14)) {
    const ev = input.upcoming.find((u) => u.event.id === c.id)!.event;
    insights.push({
      title: `Prepare: ${c.name} (${c.date})`,
      detail: `Owner approval deadline in ${c.daysToApprovalDeadline} day(s) (${c.approvalDeadline}). ${ev.kind === "commercial" ? "Commercial opportunity, not an official date." : `Official date basis: ${ev.dateBasis}.`}`,
      role: "campaign_planner",
      sourceLinks: [{ url: ev.sourceUrl, title: ev.dateBasis, publishedAt: null, sourceId: "calendar" }],
      confidence: ev.dateIsOfficial ? 0.95 : 0.7,
      effort: ev.tier === "major" ? "high" : ev.tier === "standard" ? "medium" : "low",
      costRangeUsd: ev.tier === "major" ? [1500, 6000] : ev.tier === "standard" ? [500, 2000] : [0, 500],
      requiresApproval: true,
    });
  }

  const risks: string[] = [];
  if (ds.status !== "fresh") risks.push(ds.note);
  for (const f of input.feeds.filter((x) => x.status === "failing" || x.status === "missing_credentials")) risks.push(`Feed ${f.name}: ${f.status}${f.lastError ? ` — ${f.lastError}` : ""}`);
  for (const c of calendar.filter((x) => x.daysToApprovalDeadline < 0)) risks.push(`${c.name}: approval deadline passed (${c.approvalDeadline}); scope down or skip.`);
  if (input.pendingApprovals > 0) risks.push(`${input.pendingApprovals} item(s) waiting in the approval queue.`);

  const flags = usableClusters.flatMap((c) => c.flags.map((type) => ({ type, clusterLabel: c.label, sourceLinks: c.items.slice(0, 5).map((i) => i.url) })));

  const titles: Record<ReportKind, string> = {
    daily_brief: `Daily PR intelligence brief — ${input.periodKey}`,
    weekly_report: `Weekly strategic PR report — ${input.periodKey}`,
    monthly_presentation: `Monthly PR presentation — ${input.periodKey}`,
    quarterly_review: `Quarterly strategic review — ${input.periodKey}`,
    annual_review: `Annual roadmap evaluation — ${input.periodKey}`,
  };

  const b: Briefing = {
    kind, periodKey: input.periodKey, generatedAt: now.toISOString(), title: `${input.brandName}: ${titles[kind]}`,
    dataStatus: ds.status, dataStatusNote: ds.note, insights, risks, flags, calendar, feedHealth: input.feeds,
  };

  if (kind === "monthly_presentation") {
    const q = input.roadmap?.quarters.find((x) => x.start <= now.toISOString().slice(0, 10) && x.end >= now.toISOString().slice(0, 10));
    b.slides = [
      { title: "Data status", bullets: [ds.note, ...input.feeds.map((f) => `${f.name}: ${f.status}`)] },
      { title: "Top opportunities", bullets: insights.filter((i) => i.role === "trend_analyst").map((i) => `${i.title} (confidence ${i.confidence})`).slice(0, 5).concat(ranked.length ? [] : ["No source-backed trend opportunities this month."]) },
      { title: "Upcoming calendar (next 120 days)", bullets: calendar.map((c) => `${c.date} ${c.name} — approve by ${c.approvalDeadline}`) },
      { title: "Roadmap & OKRs", bullets: q ? [`${q.label} · ${q.phase}: ${q.objective}`, ...q.keyResults.map((k) => `${k.label}: baseline ${k.baseline === "unknown" ? "unknown" : k.baseline.value} → ${k.target}`)] : ["Roadmap not configured."] },
      { title: "Risks", bullets: risks.length ? risks : ["None identified from available data."] },
      { title: "Decisions needed from owner", bullets: [`${input.pendingApprovals} item(s) in approval queue`, "All outbound messages, paid media and budgets remain drafts until approved."] },
    ];
  }
  if (input.strategy) b.sections = strategySections(kind, input, insights, calendar, risks);
  return b;
}

const fmtKr = (k: StrategyContext["quarter"][number]["keyResults"][number]) =>
  k.state === "unmeasured" ? `${k.label}: not measured yet — target "${k.target}" cannot be evaluated`
    : k.state === "baseline_only" ? `${k.label}: baseline ${k.baseline} (${k.source}); no current measurement yet — target "${k.target}"`
      : `${k.label}: ${k.baseline ?? "no baseline"} → ${k.current} (${k.source}) — target "${k.target}"`;

/** Rapor türüne göre operasyon bölümleri. Ölçülmemiş hiçbir şey sayı olarak yazılmaz. */
export function strategySections(kind: ReportKind, input: BriefingInput, insights: Insight[], calendar: Briefing["calendar"], risks: string[]): { title: string; bullets: string[] }[] {
  const st = input.strategy!;
  const kpiNote = st.measuredKpis ? `${st.measuredKpis} measured KPI value(s) on record (see Brand Strategy → key results).` : "No measured KPI values on record — performance cannot be evaluated until baselines are measured with a source.";
  const campaigns = st.activeCampaigns.length ? st.activeCampaigns.map((c) => `${c.title} — ${c.status}`) : ["No active campaign projects."];
  const budget = [
    st.budget.spent30dUsd === null ? "AI spend (30 days): no recorded actual cost." : `AI spend (30 days, recorded actuals): $${st.budget.spent30dUsd.toFixed(2)}.`,
    st.budget.dailyLimitUsd === null ? "Daily AI budget limit: not set." : `Daily AI budget limit: $${st.budget.dailyLimitUsd.toFixed(2)}.`,
    ...(st.budget.unknownCostEntries ? [`${st.budget.unknownCostEntries} cost entr(y/ies) with unknown amount — review in Cost Management.`] : []),
    "Paid media spend is not connected and is not reported.",
  ];
  const creator = insights.filter((i) => /creator|influenc|collab/i.test(`${i.title} ${i.detail}`));
  if (kind === "weekly_report") {
    return [
      { title: "Campaign review", bullets: campaigns },
      { title: "Social content planning (next 14 days)", bullets: calendar.filter((c) => c.daysToApprovalDeadline >= 0 && c.daysToApprovalDeadline <= 14).map((c) => `${c.date} ${c.name} — approve by ${c.approvalDeadline}`).concat(`${st.drafts.social} social publishing draft(s) awaiting review.`) },
      { title: "Influencer opportunities", bullets: creator.length ? creator.map((i) => i.title) : ["No source-backed creator opportunities this week (creator data source not connected or no matching signals)."] },
      { title: "Performance summary", bullets: [kpiNote] },
    ];
  }
  if (kind === "monthly_presentation") {
    return [
      { title: "PR performance", bullets: [kpiNote, `${st.drafts.outreach} outreach draft(s) prepared; nothing was sent without approval.`] },
      { title: "Brand positioning review", bullets: st.phase ? [`Current phase: ${st.phase.title} (${st.phase.label})`, ...st.phase.focus.map((f) => `Focus: ${f}`)] : ["Strategy framework not created yet."] },
      { title: "Campaign recommendations", bullets: insights.slice(0, 5).map((i) => i.title).concat(insights.length ? [] : ["No source-backed recommendations this month."]) },
      { title: "Content production planning", bullets: calendar.slice(0, 6).map((c) => `${c.name} (${c.date}): plan content from verified product imagery; approve by ${c.approvalDeadline}`).concat(`${st.drafts.creative} creative draft(s) in progress.`) },
    ];
  }
  if (kind === "quarterly_review") {
    return [
      { title: "Strategic review", bullets: st.phase ? [`Phase: ${st.phase.title} (${st.phase.label})`, ...st.annual.map((a) => `${a.periodKey} objective: ${a.title} — ${a.status}`)] : ["Strategy framework not created yet."] },
      { title: "OKR evaluation", bullets: st.quarter.length ? st.quarter.flatMap((q) => [`${q.periodKey}: ${q.title} — ${q.status}`, ...q.keyResults.map(fmtKr)]) : ["No OKRs recorded for this quarter."] },
      { title: "Budget assessment", bullets: budget },
      { title: "Brand growth analysis", bullets: [kpiNote] },
      { title: "Risks", bullets: risks.length ? risks : ["None identified from available data."] },
    ];
  }
  if (kind === "annual_review") {
    return [
      { title: "Eight-year roadmap evaluation", bullets: st.phase ? [`Current phase: ${st.phase.title} (${st.phase.label})`, ...st.annual.flatMap((a) => [`${a.periodKey}: ${a.title} — ${a.status}`, ...a.keyResults.map(fmtKr)])] : ["Strategy framework not created yet."] },
      { title: "Market positioning review", bullets: [kpiNote, "Positioning changes are proposals until the owner approves them."] },
      { title: "Strategic priorities", bullets: st.nextAnnual.length ? st.nextAnnual.map((a) => `${a.periodKey}: ${a.title}`) : ["No next-year objective recorded."] },
      { title: "Budget assessment", bullets: budget },
    ];
  }
  return [];
}
