import { randomUUID } from "node:crypto";
import { flash, requireBrand, type SP } from "@/lib/current";
import { getLimits } from "@/lib/settings";
import { listRuns, listSources, monthlyResearchCredits, researchBlockedReason } from "@/lib/services/research";
import { creditsToUsd } from "@/lib/adapters/firecrawl";
import { runResearchAction, verifySourceAction } from "@/app/actions";
import { Badge, Empty, Flash, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/client";

export const dynamic = "force-dynamic";

const RUN_STATUS: Record<string, { label: string; tone: "ok" | "bad" | "warn" | "neutral" }> = {
  completed: { label: "Tamamlandı", tone: "ok" },
  failed: { label: "Başarısız", tone: "bad" },
  blocked: { label: "Engellendi", tone: "warn" },
  pending: { label: "Çalışıyor", tone: "neutral" },
};

export default async function ResearchPage({ searchParams }: { searchParams: SP }) {
  const brand = await requireBrand();
  const { ok, err } = await flash(searchParams);
  const [blocked, limits, used, runs, sources] = await Promise.all([researchBlockedReason(), getLimits(), monthlyResearchCredits(), listRuns(brand.id), listSources(brand.id)]);
  const unitPrice = creditsToUsd(1);
  return (
    <div>
      <PageHeader
        title="Araştırma Merkezi"
        subtitle="Rakip, pazar ve trend araştırması (Firecrawl). Yalnızca siz başlatırsınız; ajanlar web çağrısı yapamaz. Bulunan kaynaklar doğrulanmamış üçüncü taraf içeriğidir."
      />
      <Flash ok={ok} err={err} />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {blocked ? <Badge tone="warn">Kullanılamıyor</Badge> : <Badge tone="ok">Etkin</Badge>}
        <span className="muted">{blocked ?? "Firecrawl anahtarı tanımlı ve web araştırması açık."}</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card h-fit">
          <h2 className="h2 mb-2">Yeni araştırma</h2>
          <form action={runResearchAction} className="space-y-2">
            <input type="hidden" name="idem" value={randomUUID()} />
            <label className="block text-sm" htmlFor="r-mode">Tür</label>
            <select id="r-mode" name="mode" className="input">
              <option value="search">Web araması</option>
              <option value="scrape">Tek sayfayı oku (adres)</option>
            </select>
            <label className="block text-sm" htmlFor="r-query">Arama metni veya adres</label>
            <textarea id="r-query" name="query" rows={3} className="input" required maxLength={2000} placeholder="Örn: sustainable linen shirt brands Instagram reels 2026" />
            <label className="block text-sm" htmlFor="r-limit">En fazla sonuç</label>
            <input id="r-limit" name="limit" type="number" min={1} max={10} defaultValue={5} className="input" />
            <p className="text-xs text-muted">
              Bu ay kullanılan: {used} / {limits.researchMonthlyCredits} kredi.{" "}
              {unitPrice === null ? "Kredi birim fiyatı tanımlı değil (FIRECRAWL_CREDIT_USD); bütçe sınırı etkinse araştırma engellenir." : `Kredi birim fiyatı $${unitPrice}.`}
            </p>
            <SubmitButton className="btn-primary" disabled={!!blocked}>Araştır</SubmitButton>
          </form>
        </section>
        <div className="space-y-4 lg:col-span-2">
          <section className="card">
            <h2 className="h2 mb-2">Kaynaklar</h2>
            {sources.length === 0 ? <Empty>Henüz kaynak yok.</Empty> : (
              <ul className="space-y-2">
                {sources.map((s) => (
                  <li key={s.id} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-sm font-medium text-brand break-all">{s.title || s.url}</a>
                      <Badge tone={s.verification === "verified" ? "ok" : s.verification === "rejected" ? "bad" : "warn"}>
                        {s.verification === "verified" ? "Doğrulandı — ajanlar görür" : s.verification === "rejected" ? "Reddedildi" : "Doğrulanmamış"}
                      </Badge>
                    </div>
                    <div className="mt-1 break-all text-xs text-muted">{s.url}</div>
                    {s.excerpt && <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs">{s.excerpt.slice(0, 600)}</p>}
                    <div className="mt-2 flex gap-2">
                      {s.verification !== "verified" && <form action={verifySourceAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="verification" value="verified" /><SubmitButton className="btn py-1">Doğrula</SubmitButton></form>}
                      {s.verification !== "rejected" && <form action={verifySourceAction}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="verification" value="rejected" /><SubmitButton className="btn py-1">Reddet</SubmitButton></form>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card">
            <h2 className="h2 mb-2">Geçmiş</h2>
            {runs.length === 0 ? <Empty>Henüz araştırma yapılmadı.</Empty> : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1">Tarih</th><th>Tür</th><th>Sorgu</th><th>Durum</th><th>Kredi</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-t border-line align-top">
                      <td className="py-1 pr-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString("tr-TR")}</td>
                      <td className="pr-2">{r.mode === "scrape" ? "Sayfa" : "Arama"}</td>
                      <td className="pr-2 break-all">{r.query}{r.error && <div className="text-xs text-red-700">{r.error}</div>}</td>
                      <td className="pr-2"><Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge></td>
                      <td>{r.credits_used ?? (r.credits_estimated !== null ? `~${r.credits_estimated}` : "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
