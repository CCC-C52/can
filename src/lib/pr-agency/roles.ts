// PR ajansı organizasyonu. Roller "her zaman açık bağımsız ajanlar" DEĞİLDİR: her rol, işleyicinin (worker)
// zamanlanmış olarak çalıştırdığı deterministik işlerin sahibidir. Çıktılar Strateji Direktörü'nün özetine
// ve sahibin onay kuyruğuna akar. Hiçbir rol dış iletişim gönderemez, ücretli sağlayıcı çağıramaz veya bütçe değiştiremez.

export type PrJobKind = "feed_poll" | "trend_cluster" | "daily_brief" | "weekly_report" | "monthly_presentation" | "quarterly_review" | "annual_review" | "calendar_refresh";

export type PrRole = {
  id: string;
  title: string;
  responsibilities: string[];
  /** Bu rolün sahibi olduğu zamanlanmış işler (sürekli çalışan ajan yok). */
  ownsJobs: PrJobKind[];
  reportsTo: string | null;
  /** Rolün üretebileceği şeyler — hepsi TASLAK, onay kuyruğuna düşer. */
  produces: string[];
  canSendExternally: false;
  canSpend: false;
};

export const PR_ROLES: PrRole[] = [
  { id: "strategy_director", title: "PR Strategy Director", reportsTo: null, ownsJobs: ["weekly_report", "monthly_presentation", "annual_review"], responsibilities: ["Synthesises all role outputs into weekly/monthly reports", "Maintains the 2026–2034 strategy, annual objectives and quarterly OKRs", "Prioritises the approval queue"], produces: ["weekly strategic report", "monthly presentation", "OKR proposals"], canSendExternally: false, canSpend: false },
  { id: "trend_analyst", title: "Trend Analyst", reportsTo: "strategy_director", ownsJobs: ["trend_cluster"], responsibilities: ["Clusters connected-feed items", "Scores velocity and relevance to FriBee collections"], produces: ["trend clusters", "opportunity notes"], canSendExternally: false, canSpend: false },
  { id: "social_listening_analyst", title: "Social Listening Analyst", reportsTo: "strategy_director", ownsJobs: ["feed_poll"], responsibilities: ["Polls only owner-enabled, compliant feeds/APIs within quota", "Reports feed health and data freshness"], produces: ["feed health report"], canSendExternally: false, canSpend: false },
  { id: "media_relations", title: "Media Relations Manager", reportsTo: "strategy_director", ownsJobs: [], responsibilities: ["Drafts press pitches for calendar events and opportunities"], produces: ["media outreach drafts"], canSendExternally: false, canSpend: false },
  { id: "creator_relations", title: "Creator Relations Manager", reportsTo: "strategy_director", ownsJobs: [], responsibilities: ["Drafts creator outreach; never assumes existing partnerships"], produces: ["creator outreach drafts"], canSendExternally: false, canSpend: false },
  { id: "campaign_planner", title: "Campaign Planner", reportsTo: "strategy_director", ownsJobs: ["calendar_refresh"], responsibilities: ["Maintains rolling 12-month US calendar", "Builds per-event plans, lead times, budgets and approval deadlines"], produces: ["event plans", "budget proposals"], canSendExternally: false, canSpend: false },
  { id: "reputation_crisis", title: "Reputation & Crisis Lead", reportsTo: "strategy_director", ownsJobs: [], responsibilities: ["Reviews crisis_watch flags raised during clustering", "Drafts holding statements for owner review"], produces: ["crisis alerts", "holding statement drafts"], canSendExternally: false, canSpend: false },
  { id: "performance_analyst", title: "Performance Analyst", reportsTo: "strategy_director", ownsJobs: ["daily_brief", "quarterly_review"], responsibilities: ["Compiles daily brief", "Tracks KPI baselines (unknown until measured)", "Evaluates quarterly OKRs against measured values"], produces: ["daily intelligence brief", "KPI baseline status"], canSendExternally: false, canSpend: false },
];

/**
 * Zamanlama (UTC). Günlük özet 12:00 UTC (ABD Doğu sabahı), haftalık Pazartesi, aylık ayın 1'i,
 * çeyreklik inceleme çeyreğin ilk günü (Oca/Nis/Tem/Eki), yıllık değerlendirme 1 Ocak.
 */
export const SCHEDULE: Record<Exclude<PrJobKind, "feed_poll" | "trend_cluster" | "calendar_refresh">, { hourUtc: number; weekdayUtc?: number; dayOfMonth?: number; months?: number[] }> = {
  daily_brief: { hourUtc: 12 },
  weekly_report: { hourUtc: 13, weekdayUtc: 1 },
  monthly_presentation: { hourUtc: 14, dayOfMonth: 1 },
  quarterly_review: { hourUtc: 15, dayOfMonth: 1, months: [0, 3, 6, 9] },
  annual_review: { hourUtc: 16, dayOfMonth: 1, months: [0] },
};

export type ReportKind = keyof typeof SCHEDULE;

/** ISO 8601 hafta anahtarı (ör. 2026-W44). */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Dönem anahtarı: aynı dönem için ikinci kez üretim yapılmaz (idempotency). */
export function periodKey(kind: ReportKind, now: Date): string {
  if (kind === "daily_brief") return now.toISOString().slice(0, 10);
  if (kind === "weekly_report") return isoWeekKey(now);
  if (kind === "quarterly_review") return `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
  if (kind === "annual_review") return String(now.getUTCFullYear());
  return now.toISOString().slice(0, 7);
}

/**
 * Şu anda vadesi gelmiş raporlar (bu dönem için henüz üretilmemiş olanlar).
 * İşleyici kapalı kaldıysa dönem içinde telafi edilir: haftalık rapor Pazartesi saatinden sonra haftanın herhangi bir
 * gününde, aylık sunum ayın 1'i saatinden sonra ayın herhangi bir gününde; çeyreklik ve yıllık inceleme de dönem içinde üretilir.
 */
export function dueReports(now: Date, alreadyGenerated: Set<string>): { kind: ReportKind; periodKey: string }[] {
  const out: { kind: ReportKind; periodKey: string }[] = [];
  for (const kind of Object.keys(SCHEDULE) as ReportKind[]) {
    const s = SCHEDULE[kind];
    const beforeHour = now.getUTCHours() < s.hourUtc;
    if (s.weekdayUtc !== undefined) {
      if (now.getUTCDay() === s.weekdayUtc && beforeHour) continue;
    } else if (s.dayOfMonth !== undefined) {
      // Dönemin ilk günü, saatinden önce: henüz vadesi gelmedi (çeyreklik/yıllık için dönemin ilk ayı)
      const firstMonth = s.months ? s.months.includes(now.getUTCMonth()) : true;
      if (firstMonth && now.getUTCDate() === s.dayOfMonth && beforeHour) continue;
    } else if (beforeHour) continue;
    const key = periodKey(kind, now);
    if (!alreadyGenerated.has(`${kind}:${key}`)) out.push({ kind, periodKey: key });
  }
  return out;
}
