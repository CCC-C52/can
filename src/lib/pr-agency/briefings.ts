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
};

const WINDOW_DAYS: Record<ReportKind, number> = { daily_brief: 14, weekly_report: 45, monthly_presentation: 120 };

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
  return b;
}
