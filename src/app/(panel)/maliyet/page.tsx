import Link from "next/link";
import { flash, type SP } from "@/lib/current";
import { getLimits } from "@/lib/settings";
import { COST_PROVIDERS, COST_PROVIDER_LABEL, monthlyProviderSummary, todaysAiSpend } from "@/lib/services/costs";
import { monthlyResearchCredits } from "@/lib/services/research";
import { firecrawlConfigured } from "@/lib/adapters/firecrawl";
import { saveCostControlsAction } from "@/app/actions";
import { Badge, Flash, PageHeader, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/client";

export const dynamic = "force-dynamic";

const usd = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${Number(v).toFixed(4)}`);

export default async function CostPage({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const [limits, today, month, credits] = await Promise.all([getLimits(), todaysAiSpend(), monthlyProviderSummary(), monthlyResearchCredits()]);
  const byService = Object.fromEntries(month.map((m) => [m.service, m]));
  const anth = byService.anthropic;
  const cacheRead = Number(anth?.cache_read ?? 0);
  const cacheWrite = Number(anth?.cache_write ?? 0);
  const uncached = Number(anth?.input ?? 0);
  const totalIn = cacheRead + cacheWrite + uncached;
  return (
    <div>
      <PageHeader title="Maliyet Yönetimi" subtitle={<>Harcama sınırları ücretli her çağrıdan <strong>önce</strong> sunucuda uygulanır. Ayrıntılı kırılım için <Link href="/raporlar" className="text-brand underline">Analitik</Link>.</>} />
      <Flash ok={ok} err={err} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Bugün (UTC) AI harcaması" value={usd(today.actual)} hint={limits.dailyBudgetUsd === null ? "Günlük sınır yok" : `Günlük sınır $${limits.dailyBudgetUsd}`} tone={limits.dailyBudgetUsd !== null && today.actual >= limits.dailyBudgetUsd ? "bad" : undefined} />
        <Stat label="Görev başına bütçe" value={limits.perTaskBudgetUsd === null ? "Sınırsız" : `$${limits.perTaskBudgetUsd}`} hint="Ayarlar'dan değiştirilir" href="/ayarlar" />
        <Stat label="Araştırma kredisi (bu ay)" value={`${credits} / ${limits.researchMonthlyCredits}`} hint={limits.webResearch ? "Web araştırması açık" : "Web araştırması kapalı"} />
        <Stat label="İstem önbelleği (bu ay, Anthropic)" value={totalIn ? `%${Math.round((cacheRead / totalIn) * 100)}` : "—"} hint={totalIn ? `${cacheRead.toLocaleString("tr-TR")} token önbellekten okundu` : "Gerçek model çağrısı yok"} />
      </div>
      <form action={saveCostControlsAction} className="space-y-4">
        <section className="card">
          <h2 className="h2 mb-2">Sağlayıcı başına aylık sınır</h2>
          <p className="muted mb-3 text-xs">Takvim ayı (UTC). Boş = sağlayıcı sınırı yok (günlük ve görev bütçesi yine geçerli). Sınır aşılacaksa çağrı yapılmaz ve görev “bütçe sınırı” ile durur.</p>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Sağlayıcı sınırları tablosu">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted"><th className="py-1 pr-2">Sağlayıcı</th><th className="pr-2">Bu ay</th><th className="pr-2">Bilinmeyen tutarlı kayıt</th><th>Aylık sınır (USD)</th></tr></thead>
              <tbody>
                {COST_PROVIDERS.map((p) => {
                  const m = byService[p];
                  const limit = limits.providerMonthlyUsd?.[p];
                  const over = limit !== undefined && Number(m?.actual ?? 0) >= limit;
                  return (
                    <tr key={p} className="border-t border-line">
                      <td className="py-2 pr-2">{COST_PROVIDER_LABEL[p]}</td>
                      <td className="pr-2">{usd(m?.actual ?? 0)} {over && <Badge tone="bad">Sınırda</Badge>}</td>
                      <td className="pr-2">{m?.unknown_count ?? 0}</td>
                      <td><label className="sr-only" htmlFor={`monthly_${p}`}>{COST_PROVIDER_LABEL[p]} aylık sınır</label><input id={`monthly_${p}`} name={`monthly_${p}`} defaultValue={limit ?? ""} inputMode="decimal" className="input max-w-[9rem]" placeholder="sınırsız" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Web araştırması (Firecrawl)</h2>
          {!firecrawlConfigured() && <p className="mb-2 text-xs text-warning">FIRECRAWL_API_KEY sunucuda tanımlı değil; açık olsa bile araştırma yapılamaz.</p>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="webResearch" defaultChecked={limits.webResearch} className="mt-1" /> <span>Araştırma Merkezi&apos;nde ücretli web araştırmasına izin ver (yalnızca sahip başlatır; ajanlar web çağrısı yapamaz).</span></label>
          <label className="mt-2 block max-w-xs text-sm"><span className="label">Aylık kredi üst sınırı</span><input name="researchMonthlyCredits" type="number" min={0} max={100000} defaultValue={limits.researchMonthlyCredits} className="input" /></label>
        </section>
        <SubmitButton>Kaydet</SubmitButton>
      </form>
    </div>
  );
}
