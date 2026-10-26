import { getPrConfig, listFeedHealth, listPrOutputs, prCalendar, PR_KINDS } from "@/lib/services/pr-agency";
import { SOURCE_CATALOG } from "@/lib/pr-agency/trends";
import { PR_ROLES, SCHEDULE } from "@/lib/pr-agency/roles";
import { buildRoadmap } from "@/lib/pr-agency/roadmap";
import { buildEventPlan } from "@/lib/pr-agency/event-plan";
import { brandKnowledge } from "@/lib/services/pr-agency";
import { buildPrRoadmap } from "@/lib/knowledge/pr-roadmap";
import { loadKnowledge } from "@/lib/knowledge/store";
import { prConfigAction, prRunNowAction, prVerifyDateAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Empty, dt } from "@/components/ui";

const FEED_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  unconnected: { label: "Bağlı değil", tone: "neutral" },
  missing_credentials: { label: "Kimlik bilgisi yok", tone: "warn" },
  never_fetched: { label: "Henüz çekilmedi", tone: "neutral" },
  healthy: { label: "Sağlıklı", tone: "ok" },
  stale: { label: "Eski", tone: "warn" },
  failing: { label: "Hata", tone: "bad" },
};
const KIND_LABEL: Record<string, string> = {
  [PR_KINDS.daily_brief]: "Günlük trend özeti",
  [PR_KINDS.weekly_report]: "Haftalık PR raporu",
  [PR_KINDS.monthly_presentation]: "Aylık yönetici sunumu",
  [PR_KINDS.alert]: "Uyarı (kriz/fırsat)",
  [PR_KINDS.event_plan]: "Etkinlik planı",
};
const EVENT_KIND: Record<string, string> = { federal_holiday: "Federal tatil", observance: "Özel gün", heritage_month: "Miras ayı", commercial: "Ticari dönem", culture_event: "Kültür etkinliği" };

export async function Automation({ brandId }: { brandId: string }) {
  const [cfg, feeds, outputs] = await Promise.all([getPrConfig(brandId), listFeedHealth(brandId), listPrOutputs(brandId, 50)]);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="card h-fit space-y-3">
        <h2 className="h2">Zamanlanmış iş akışları</h2>
        <ul className="text-sm">
          <li>Günlük trend özeti: her gün {SCHEDULE.daily_brief.hourUtc}:00 UTC</li>
          <li>Haftalık PR raporu: Pazartesi {SCHEDULE.weekly_report.hourUtc}:00 UTC</li>
          <li>Aylık yönetici sunumu: ayın 1&apos;i {SCHEDULE.monthly_presentation.hourUtc}:00 UTC</li>
          <li>Etkinlik planları: hazırlık penceresi açılınca (90/45/21 gün önce)</li>
        </ul>
        <form action={prConfigAction} className="space-y-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" name="enabled" value="1" defaultChecked={cfg.enabled} /> Zamanlanmış üretim açık (işleyici komut beklemeden çalışır)</label>
          <fieldset className="space-y-1">
            <legend className="text-xs text-muted">Etkin kaynaklar (yalnızca yayıncının RSS/Atom beslemesi; kazıma yok)</legend>
            {SOURCE_CATALOG.map((s) => (
              <label key={s.id} className="flex items-start gap-2 text-xs">
                <input type="checkbox" name="sources" value={s.id} defaultChecked={cfg.enabledSources.includes(s.id)} disabled={s.kind === "api"} />
                <span>{s.name} <span className="text-muted">({s.kind === "api" ? `resmî API — ${s.credentialEnv} ve bağdaştırıcı gerekli` : s.region})</span>{s.notes ? <span className="block text-muted">{s.notes}</span> : null}</span>
              </label>
            ))}
          </fieldset>
          <label className="block text-xs">24 aylık plan başlangıcı (YYYY-AA)<input name="roadmapStart" className="input" defaultValue={cfg.roadmapStart?.slice(0, 7) ?? ""} placeholder="2026-11" /></label>
          <SubmitButton className="btn-primary">Kaydet</SubmitButton>
        </form>
        <form action={prRunNowAction}><SubmitButton className="btn" pendingText="Çalışıyor…">Şimdi çalıştır (besleme + vadesi gelen raporlar)</SubmitButton></form>
        <p className="text-xs text-muted">Ücretli servis çağrılmaz. Üretilen her şey taslaktır ve Onay Merkezi&apos;ne düşer; e-posta, DM veya yayın yapılmaz.</p>
      </section>
      <div className="space-y-4 lg:col-span-2">
        <section className="card">
          <h2 className="h2 mb-2">Kaynak sağlığı</h2>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Besleme sağlığı">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted"><th className="py-1">Kaynak</th><th>Durum</th><th>Son başarılı</th><th>Kota (bugün)</th><th>Hata</th></tr></thead>
              <tbody>{feeds.map((f) => (
                <tr key={f.sourceId} className="border-t border-line"><td className="py-1 pr-2">{f.name}</td><td className="pr-2"><Badge tone={FEED_STATUS[f.status].tone}>{FEED_STATUS[f.status].label}</Badge></td><td className="pr-2">{dt(f.lastSuccessAt)}</td><td className="pr-2">{f.budget.used}/{f.budget.limit}</td><td className="text-red-700">{f.lastError ?? ""}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Üretilen taslaklar</h2>
          {outputs.length === 0 ? <Empty>Henüz rapor üretilmedi. Zamanlamayı açın veya “Şimdi çalıştır”ı kullanın.</Empty> : (
            <ul className="space-y-2 text-sm">
              {outputs.map((o) => (
                <li key={o.id} className="rounded-lg border border-line p-2">
                  <div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{KIND_LABEL[o.kind] ?? o.kind}</Badge><strong>{o.title}</strong><span className="text-xs text-muted">{dt(o.created_at)}</span><Badge tone={o.approval === "approved" ? "ok" : o.approval ? "warn" : "neutral"}>{o.approval ?? "onay bekliyor"}</Badge></div>
                  {o.content?.dataStatusNote && <p className="mt-1 text-xs text-muted">{o.content.dataStatusNote}</p>}
                  {Array.isArray(o.content?.insights) && o.content.insights.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs">{o.content.insights.slice(0, 5).map((i: any, k: number) => <li key={k}>{i.title ?? i.label ?? JSON.stringify(i).slice(0, 120)}</li>)}</ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">Onay ve ret: <a href="/onaylar" className="text-brand underline">Onay Merkezi</a>.</p>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Ajans rolleri</h2>
          <ul className="grid gap-2 text-xs sm:grid-cols-2">{PR_ROLES.map((r) => <li key={r.id} className="rounded border border-line p-2"><strong>{r.title}</strong><div className="text-muted">{r.responsibilities.join(" · ")}</div></li>)}</ul>
        </section>
      </div>
    </div>
  );
}

export async function Calendar({ brandId }: { brandId: string }) {
  const [{ events, unverified }, knowledge] = await Promise.all([prCalendar(brandId), brandKnowledge(brandId)]);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="card lg:col-span-2">
        <h2 className="h2 mb-2">ABD 12 aylık kampanya takvimi</h2>
        <p className="mb-2 text-xs text-muted">Tarihler yasa/kural ile hesaplanır (resmî) veya sahibin kaynakla doğruladığı organizatör tarihidir. Ticari dönemler yaklaşık olarak işaretlenir.</p>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="12 aylık takvim">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted"><th className="py-1">Tarih</th><th>Etkinlik</th><th>Tür</th><th>Koleksiyon uyumu</th><th>Onay son günü</th></tr></thead>
            <tbody>{events.map((e) => {
              const plan = buildEventPlan(e, knowledge);
              return (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">{e.date}{e.endDate && e.endDate !== e.date ? ` → ${e.endDate}` : ""}{e.observedDate ? <div className="text-muted">gözlenen {e.observedDate}</div> : null}</td>
                  <td className="pr-2"><a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-brand">{e.name}</a><div className="text-muted">{e.dateBasis}</div></td>
                  <td className="pr-2">{EVENT_KIND[e.kind] ?? e.kind}{e.dateIsOfficial ? "" : " (yaklaşık)"}</td>
                  <td className="pr-2">{plan.themeFit.matchedCollections.length ? plan.themeFit.matchedCollections.join(", ") : "—"}</td>
                  <td className="whitespace-nowrap">{plan.approvalDeadline}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </section>
      <section className="card h-fit">
        <h2 className="h2 mb-2">Tarihi doğrulanacak etkinlikler</h2>
        <p className="mb-2 text-xs text-muted">Organizatörün her yıl açıkladığı etkinlikler; tarih ve resmî kaynak girilmeden takvime girmez.</p>
        <ul className="space-y-3">{unverified.map((u) => (
          <li key={u.id} className="text-xs">
            <a href={u.sourceUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-brand">{u.name}</a>
            <form action={prVerifyDateAction} className="mt-1 grid grid-cols-2 gap-1">
              <input type="hidden" name="id" value={u.id} />
              <input name="date" className="input py-1" placeholder="YYYY-AA-GG" required pattern="\d{4}-\d{2}-\d{2}" aria-label={`${u.name} başlangıç`} />
              <input name="endDate" className="input py-1" placeholder="bitiş (isteğe bağlı)" pattern="\d{4}-\d{2}-\d{2}" aria-label={`${u.name} bitiş`} />
              <input name="sourceUrl" className="input col-span-2 py-1" placeholder="Resmî kaynak adresi (https://…)" required aria-label={`${u.name} kaynak`} />
              <SubmitButton className="btn col-span-2 py-1">Tarihi kaydet</SubmitButton>
            </form>
          </li>
        ))}</ul>
      </section>
    </div>
  );
}

export async function Strategy({ brandId }: { brandId: string }) {
  const [cfg, { graph, index }] = await Promise.all([getPrConfig(brandId), loadKnowledge(brandId)]);
  const plan = buildPrRoadmap(graph, index);
  const okr = buildRoadmap(cfg.roadmapStart ?? new Date().toISOString().slice(0, 10), cfg.measuredMetrics);
  return (
    <div className="space-y-4">
      <section className="card">
        <h2 className="h2 mb-1">24 aylık marka bilinirliği stratejisi ({plan.period.start} → {plan.period.end})</h2>
        <Badge tone="warn">Öneri — gerçek değil</Badge> {plan.sourceBacked ? <Badge tone="ok">Arşiv kaynaklı</Badge> : <Badge tone="warn">Arşiv kaynakları eksik</Badge>}
        <p className="mt-2 text-xs text-muted">{plan.disclaimer}</p>
        {plan.missingSources.length > 0 && <p className="mt-1 text-xs text-amber-800">Eksik arşiv kategorileri: {plan.missingSources.join(", ")}</p>}
        <ol className="mt-3 grid gap-3 md:grid-cols-2">
          {plan.quarters.map((q) => (
            <li key={q.n} className="rounded-lg border border-line p-3">
              <strong className="text-sm">{q.label}</strong> <span className="text-xs text-muted">{q.start} → {q.end}</span>
              <p className="mt-1 text-sm">{q.focus}</p>
              <ul className="mt-1 list-disc pl-5 text-xs">{q.actions.map((a) => <li key={a}>{a}</li>)}</ul>
              <p className="mt-1 text-xs text-muted">Sahip onayı: {q.ownerApprovals.join(", ")}</p>
            </li>
          ))}
        </ol>
        <h3 className="mt-3 text-sm font-medium">Kurallar</h3>
        <ul className="list-disc pl-5 text-xs">{plan.guardrails.map((g) => <li key={g}>{g}</li>)}</ul>
      </section>
      <section className="card">
        <h2 className="h2 mb-2">Çeyreklik hedefler (OKR) — {okr.start} → {okr.end}</h2>
        <p className="mb-2 text-xs text-muted">Başlangıç değerleri yalnızca ölçülmüş veriden gelir; ölçüm yoksa hedef “başlangıç ölçüldükten sonra” belirlenir.</p>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="OKR tablosu">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted"><th className="py-1">Çeyrek</th><th>Aşama</th><th>Hedef</th><th>Ölçütler</th></tr></thead>
            <tbody>{okr.quarters.map((q) => (
              <tr key={q.index} className="border-t border-line align-top"><td className="py-1 pr-2 whitespace-nowrap">{q.label}</td><td className="pr-2">{q.phase}</td><td className="pr-2">{q.objective}</td><td>{q.keyResults.map((k) => `${k.label}: ${k.baseline === "unknown" ? "başlangıç bilinmiyor" : k.baseline.value} → ${k.target}`).join(" · ")}</td></tr>
            ))}</tbody>
          </table>
        </div>
        {okr.dataGaps.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-amber-800">{okr.dataGaps.map((g) => <li key={g}>{g}</li>)}</ul>}
      </section>
    </div>
  );
}
