import { requireBrand } from "@/lib/current";
import { costSummary, todaysAiSpend } from "@/lib/services/costs";
import { getLimits } from "@/lib/settings";
import { q } from "@/lib/db/pool";
import { Empty, PageHeader, Stat, usd } from "@/components/ui";
import { effectiveStatus } from "@/lib/services/connections";
import { CONNECTION_STATUS_LABEL } from "@/lib/labels";

function CostTable({ title, rows }: { title: string; rows: { key: string; estimated: number | null; actual: number | null; unknown_count: number; entries: number }[] }) {
  return (
    <section className="card">
      <h2 className="h2 mb-2">{title}</h2>
      {rows.length === 0 ? <p className="muted">Kayıt yok.</p> : (
        <div className="overflow-x-auto"><table className="table">
          <thead><tr><th>Kalem</th><th>Tahmini (üst sınır)</th><th>Gerçekleşen</th><th>Bilinmeyen</th><th>Kayıt</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.key}><td className="max-w-xs truncate">{r.key}</td><td>{usd(r.estimated)}</td><td>{r.actual === null && r.unknown_count ? "Bilinmiyor" : usd(r.actual)}</td><td>{r.unknown_count || "—"}</td><td>{r.entries}</td></tr>)}</tbody>
        </table></div>
      )}
    </section>
  );
}

export default async function Reports() {
  const brand = await requireBrand();
  const [byService, byTask, byDay, byBrand, ads, today, limits, quality, shopify, perf] = await Promise.all([
    costSummary(brand.id, "service"), costSummary(brand.id, "task"), costSummary(brand.id, "day"), costSummary(null, "brand"), costSummary(brand.id, "service", "ad_spend"),
    todaysAiSpend(), getLimits(),
    q<{ verdict: string; n: number }>(`SELECT v.qa_report->>'verdict' AS verdict, COUNT(*)::int AS n FROM output_versions v WHERE v.brand_id = $1 AND v.qa_report IS NOT NULL GROUP BY 1`, [brand.id]),
    effectiveStatus("shopify", brand.id),
    q<{ source: string; metric: string; value: number }>(`SELECT source, metric, value FROM performance_metrics WHERE brand_id = $1 ORDER BY fetched_at DESC LIMIT 50`, [brand.id]),
  ]);
  const demoCalls = byService.find((r) => r.key === "demo");
  return (
    <div>
      <PageHeader title="Maliyet ve performans raporları" subtitle="Tahmini (çağrı öncesi üst sınır) ve gerçekleşen (sağlayıcının bildirdiği kullanıma göre) maliyetler ayrı gösterilir. Bilinmeyen maliyet sıfır olarak gösterilmez." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Bugün gerçekleşen AI harcaması (tüm markalar)" value={usd(today.actual)} hint={today.unknownCount ? `${today.unknownCount} bilinmeyen kayıt` : undefined} />
        <Stat label="Günlük sınır" value={limits.dailyBudgetUsd === null ? "Yok" : usd(limits.dailyBudgetUsd, 2)} />
        <Stat label="Görev başına sınır" value={limits.perTaskBudgetUsd === null ? "Yok" : usd(limits.perTaskBudgetUsd, 2)} />
        <Stat label="DEMO çağrıları (ücretsiz)" value={demoCalls?.entries ? Math.round(demoCalls.entries / 2) : 0} hint="Kural tabanlı; gerçek AI maliyeti yok" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CostTable title="Servis bazında AI üretim maliyeti" rows={byService} />
        <CostTable title="Gün bazında" rows={byDay} />
        <CostTable title="Görev bazında" rows={byTask} />
        <CostTable title="Marka bazında (tüm markalar)" rows={byBrand} />
        <section className="card">
          <h2 className="h2 mb-2">Reklam harcaması</h2>
          {ads.length ? <CostTable title="" rows={ads} /> : <Empty>Reklam hesabı bağlı değil. Reklam harcaması AI üretim maliyetinden ayrı izlenir; örnek veri gösterilmez.</Empty>}
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Kalite</h2>
          <ul className="text-sm">{quality.map((r) => <li key={r.verdict}>{r.verdict === "pass" ? "Geçen" : r.verdict === "needs_changes" ? "Değişiklik gereken" : "Başarısız"} sürüm: {r.n}</li>)}{quality.length === 0 && <li className="muted">Henüz kontrol yok.</li>}</ul>
        </section>
        <section className="card lg:col-span-2">
          <h2 className="h2 mb-2">Satış ve performans</h2>
          {perf.length === 0 ? (
            <Empty>Gerçek performans bağlantısı yok (Shopify: {CONNECTION_STATUS_LABEL[shopify.status]}, Meta reklam: Desteklenmiyor). Satış veya reklam sonuçları gösterilmez; örnek veri üretilmez.</Empty>
          ) : (
            <ul className="text-sm">{perf.map((p, i) => <li key={i}>{p.source} · {p.metric}: {p.value}</li>)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}
