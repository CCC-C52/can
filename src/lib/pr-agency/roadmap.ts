// 24 aylık marka bilinirliği yol haritası ve çeyreklik OKR'ler.
// Başlangıç değerleri (baseline) yalnızca ölçülmüş veriden gelir; ölçüm yoksa "unknown" ve hedef "baseline ölçüldükten sonra".
// Saf modül.

export type MeasuredMetric = { key: string; value: number; measuredAt: string; source: string };

export type KeyResult = {
  metric: string;
  label: string;
  baseline: { value: number; measuredAt: string; source: string } | "unknown";
  target: string;
};

export type Quarter = { index: number; label: string; start: string; end: string; phase: string; objective: string; keyResults: KeyResult[] };

export type Roadmap = { start: string; end: string; phases: { name: string; months: [number, number]; focus: string[] }[]; quarters: Quarter[]; dataGaps: string[] };

const PHASES: Roadmap["phases"] = [
  { name: "Foundation", months: [1, 6], focus: ["Measure baselines (social, site, earned media)", "Finalise brand voice & visual system in Brand Knowledge Hub", "Connect compliant data sources", "Own World Bee Day / Earth Day narrative"] },
  { name: "Momentum", months: [7, 12], focus: ["Creator seeding programme (owner-approved)", "Earned media in US streetwear press", "Back-to-school & holiday tentpoles"] },
  { name: "Scale", months: [13, 18], focus: ["Repeatable campaign calendar", "Community/UGC programme", "Selective paid amplification of proven content (owner-approved budgets)"] },
  { name: "Category voice", months: [19, 24], focus: ["Thought leadership on bee/pollinator culture in streetwear", "Signature annual moment", "Evaluate retail/collab partnerships (only if verified)"] },
];

const METRICS: { key: string; label: string; growth: string }[] = [
  { key: "instagram_followers", label: "Instagram followers", growth: "+15% vs baseline per quarter" },
  { key: "engagement_rate", label: "Avg. engagement rate (owned social)", growth: "≥ baseline, +0.5pt per half-year" },
  { key: "earned_mentions", label: "Earned media mentions / quarter", growth: "2× baseline by month 12" },
  { key: "branded_search", label: "Branded search interest", growth: "+20% vs baseline per half-year" },
  { key: "site_sessions", label: "Site sessions / month", growth: "+10% vs baseline per quarter" },
];

function addMonths(ymd: string, n: number) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
}

/** start: yol haritasının başladığı ay (herhangi bir gün; ayın 1'ine yuvarlanır). */
export function buildRoadmap(start: string, measured: MeasuredMetric[] = []): Roadmap {
  const s = `${start.slice(0, 7)}-01`;
  const byKey = new Map<string, MeasuredMetric>();
  for (const m of measured) {
    const prev = byKey.get(m.key);
    if (Number.isFinite(m.value) && m.source && (!prev || prev.measuredAt < m.measuredAt)) byKey.set(m.key, m);
  }
  const quarters: Quarter[] = [];
  for (let i = 0; i < 8; i++) {
    const qs = addMonths(s, i * 3);
    const qe = new Date(new Date(`${addMonths(s, i * 3 + 3)}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
    const phase = PHASES.find((p) => i * 3 + 1 >= p.months[0] && i * 3 + 1 <= p.months[1])!;
    quarters.push({
      index: i + 1,
      label: `Q${i + 1} (${qs.slice(0, 7)} → ${qe.slice(0, 7)})`,
      start: qs,
      end: qe,
      phase: phase.name,
      objective: i === 0 ? "Establish measured baselines and a verified brand foundation" : `${phase.name}: grow US awareness of FriBee`,
      keyResults: METRICS.map((m) => {
        const b = byKey.get(m.key);
        return {
          metric: m.key,
          label: m.label,
          baseline: b ? { value: b.value, measuredAt: b.measuredAt, source: b.source } : "unknown",
          target: b ? m.growth : i === 0 ? "Measure baseline this quarter" : "Set after baseline is measured",
        };
      }),
    });
  }
  const dataGaps = METRICS.filter((m) => !byKey.has(m.key)).map((m) => `${m.label}: baseline unknown — connect a data source or enter a measured value with source.`);
  return { start: s, end: quarters[7].end, phases: PHASES, quarters, dataGaps };
}
