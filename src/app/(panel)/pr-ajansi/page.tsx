import Link from "next/link";
import { flash, requireBrand, type SP } from "@/lib/current";
import { listPrEvidence, prAgencyOverview } from "@/lib/services/pr-agency";
import { FRIBEE_COLLECTIONS_SOURCE, PR_AGENCY_PATH, PR_EXTERNAL_ACTIONS, STALE_AFTER_HOURS, type Availability, type Freshness, type Verification } from "@/lib/pr-agency/model";
import { Badge, Empty, Flash, PageHeader, Stat, dt } from "@/components/ui";
import type { Tone } from "@/lib/labels";

export const dynamic = "force-dynamic";

const AVAILABILITY: Record<Availability, { label: string; tone: Tone }> = {
  available: { label: "Kullanılabilir", tone: "ok" },
  blocked: { label: "Engelli", tone: "warn" },
  needs_credentials: { label: "Kimlik bilgisi gerekli", tone: "warn" },
  not_built: { label: "Bu sürümde yok", tone: "neutral" },
};
const FRESHNESS: Record<Freshness, { label: string; tone: Tone }> = {
  fresh: { label: "Güncel", tone: "ok" },
  stale: { label: "Eski", tone: "warn" },
  never: { label: "Veri yok", tone: "neutral" },
  failed: { label: "Son çalıştırma başarısız", tone: "bad" },
};
const LEVEL: Record<"ready" | "partial" | "no_source", { label: string; tone: Tone }> = {
  ready: { label: "Hazır", tone: "ok" },
  partial: { label: "Kısmi", tone: "info" },
  no_source: { label: "Veri kaynağı yok", tone: "neutral" },
};
const VERIFICATION: Record<Verification, { label: string; tone: Tone }> = {
  verified: { label: "Doğrulandı", tone: "ok" },
  unverified: { label: "Doğrulanmamış", tone: "warn" },
  rejected: { label: "Reddedildi", tone: "bad" },
};
const SIGNAL = { signal: "Sinyal (≥2 bağımsız doğrulanmış kaynak)", weak_signal: "Zayıf sinyal (tek doğrulanmış kaynak)", speculation: "Spekülasyon (doğrulanmış kanıt yok)" } as const;
const ACTION_LABELS: Record<(typeof PR_EXTERNAL_ACTIONS)[number], string> = {
  send_email: "E-posta gönderme", send_dm: "DM gönderme", publish: "Yayınlama", shopify_update: "Shopify değişikliği", ad_spend: "Reklam harcaması", deploy: "Dağıtım",
};

export default async function PrAgencyPage({ searchParams }: { searchParams: SP }) {
  const brand = await requireBrand();
  const { ok, err, one } = await flash(searchParams);
  const filter = (["verified", "unverified", "rejected"] as const).find((v) => v === one("durum")) ?? null;
  const page = Number(one("sayfa")) || 1;
  const [o, ev] = await Promise.all([prAgencyOverview(brand), listPrEvidence(brand.id, { page, pageSize: 20, verification: filter })]);
  const link = (p: { durum?: string | null; sayfa?: number }) => {
    const sp = new URLSearchParams();
    if (p.durum) sp.set("durum", p.durum);
    if (p.sayfa && p.sayfa > 1) sp.set("sayfa", String(p.sayfa));
    const s = sp.toString();
    return s ? `${PR_AGENCY_PATH}?${s}` : PR_AGENCY_PATH;
  };
  return (
    <div>
      <PageHeader
        title="PR Ajansı"
        subtitle={`${o.brand.name} için PR komuta merkezi (salt okunur iskelet). Gösterilen her bilgi kaynağı ve alım zamanıyla birlikte gelir; kaynağı olmayan erişim, etkileşim veya duygu verisi gösterilmez.`}
      />
      <Flash ok={ok} err={err} />

      <div role="note" className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
        Taslak modu: bu modül e-posta/DM göndermez, yayın yapmaz, Shopify&apos;ı değiştirmez, reklam bütçesi harcamaz ve dağıtım yapmaz.
        Her dış işlem sahibin ayrı onayını gerektirir. Gerçek zamanlı akış yoktur; veri yalnızca aşağıda &quot;Kullanılabilir&quot; görünen kaynaklardan gelir.
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Doğrulanmış kaynak" value={o.evidence.verified} hint={`${o.evidence.unverified} doğrulanmamış · ${o.evidence.rejected} reddedildi`} href={link({ durum: "verified" })} />
        <Stat label="Kanıt tazeliği" value={<Badge tone={FRESHNESS[o.evidence.freshness].tone}>{FRESHNESS[o.evidence.freshness].label}</Badge>} hint={`Son doğrulanmış alım: ${dt(o.evidence.lastVerifiedAt)} · ${STALE_AFTER_HOURS / 24} günden eskisi "eski"`} />
        <Stat label="Etkin kampanya projesi" value={o.work.activeProjects} hint="Kampanya Yönetimi" href="/projeler" />
        <Stat label="Ajan çıktısı" value={o.work.outputs} hint="İçerik taslakları" href="/taslaklar" />
      </div>

      {o.lastRun && (
        <p className="mb-4 text-xs text-muted">
          Son araştırma çalıştırması: {dt(o.lastRun.createdAt)} — {o.lastRun.status}
          {o.lastRun.error ? <span className="text-red-700"> · {o.lastRun.error}</span> : null}
        </p>
      )}

      <section className="mb-4" aria-labelledby="ws-title">
        <h2 id="ws-title" className="h2 mb-2">Çalışma alanları</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {o.workstreams.map((ws) => (
            <li key={ws.id} className="card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">{ws.name}</h3>
                <Badge tone={LEVEL[ws.level].tone}>{LEVEL[ws.level].label}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted">{ws.summary}</p>
              <p className="mt-2 text-xs"><span className="font-medium">Planlanan taslaklar:</span> {ws.drafts.join(" · ")}</p>
              {ws.gaps.length > 0 && (
                <p className="mt-1 text-xs text-amber-800">
                  <span className="font-medium">Eksik kaynak:</span> {ws.gaps.map((g) => o.connectors.find((c) => c.id === g)?.name ?? g).join(", ")}
                </p>
              )}
              {ws.internal.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {ws.internal.map((l) => <Link key={l.href} href={l.href} className="text-brand underline">{l.label}</Link>)}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="card" aria-labelledby="src-title">
            <h2 id="src-title" className="h2 mb-2">Veri kaynakları ve sıklık</h2>
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="PR veri kaynakları tablosu">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1 pr-2">Kaynak</th><th className="pr-2">Durum</th><th className="pr-2">Sıklık</th><th>Ayrıntı</th></tr></thead>
                <tbody>
                  {o.connectors.map((c) => (
                    <tr key={c.id} className="border-t border-line align-top">
                      <td className="py-1 pr-2 font-medium">{c.name}</td>
                      <td className="pr-2"><Badge tone={AVAILABILITY[c.availability].tone}>{AVAILABILITY[c.availability].label}</Badge></td>
                      <td className="pr-2 text-xs">{c.cadence}</td>
                      <td className="text-xs text-muted">{c.detail}<div className="mt-1">{c.policy}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" aria-labelledby="ev-title">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 id="ev-title" className="h2">Kanıt kaynakları</h2>
              <nav aria-label="Doğrulama filtresi" className="flex flex-wrap gap-2 text-xs">
                <Link href={link({})} aria-current={filter === null ? "page" : undefined} className={filter === null ? "font-medium text-brand" : "text-gray-700"}>Tümü ({o.evidence.total})</Link>
                {(["verified", "unverified", "rejected"] as const).map((v) => (
                  <Link key={v} href={link({ durum: v })} aria-current={filter === v ? "page" : undefined} className={filter === v ? "font-medium text-brand" : "text-gray-700"}>{VERIFICATION[v].label}</Link>
                ))}
              </nav>
            </div>
            {ev.items.length === 0 ? (
              <Empty>Kaynak yok. Kaynaklar Araştırma Merkezi&apos;nde elle başlatılan araştırmalardan gelir ve doğrulanana kadar kanıt sayılmaz.</Empty>
            ) : (
              <ul className="space-y-2">
                {ev.items.map((e) => (
                  <li key={e.id} className="rounded-lg border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-sm font-medium text-brand">{e.title || e.url}</a>
                      <Badge tone={VERIFICATION[e.verification].tone}>{VERIFICATION[e.verification].label}</Badge>
                    </div>
                    <div className="mt-1 break-all text-xs text-muted">Kaynak: {e.url} · Alındı: {dt(e.retrievedAt)} · Araştırma Merkezi</div>
                    {e.excerpt && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs">{e.excerpt.slice(0, 400)}</p>}
                  </li>
                ))}
              </ul>
            )}
            {ev.duplicatesHidden > 0 && <p className="mt-2 text-xs text-muted">Bu sayfada {ev.duplicatesHidden} tekrar eden adres gizlendi.</p>}
            <div className="mt-3 flex items-center justify-between text-sm">
              {ev.page > 1 ? <Link href={link({ durum: filter, sayfa: ev.page - 1 })} className="btn py-1">Önceki</Link> : <span />}
              <span className="text-xs text-muted">Sayfa {ev.page} · toplam {ev.total}</span>
              {ev.hasMore ? <Link href={link({ durum: filter, sayfa: ev.page + 1 })} className="btn py-1">Sonraki</Link> : <span />}
            </div>
          </section>
        </div>

        <div className="space-y-4">
          <section className="card" aria-labelledby="rel-title">
            <h2 id="rel-title" className="h2 mb-2">Trend ilgisi</h2>
            <p className="text-2xl font-semibold">{o.relevance.score === null ? "—" : `${o.relevance.score}/100`}</p>
            <p className="mt-1 text-xs">{SIGNAL[o.relevance.signal]}</p>
            <ul className="mt-2 list-disc pl-4 text-xs text-muted">
              {o.relevance.basis.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </section>

          <section className="card" aria-labelledby="col-title">
            <h2 id="col-title" className="h2 mb-2">Koleksiyonlar</h2>
            {o.collections.length === 0 ? (
              <Empty>Bu marka için koleksiyon tanımı yok.</Empty>
            ) : (
              <>
                <ul className="space-y-1 text-sm">
                  {o.collections.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-xs text-muted">{c.color}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted">{FRIBEE_COLLECTIONS_SOURCE}</p>
              </>
            )}
          </section>

          <section className="card" aria-labelledby="ap-title">
            <h2 id="ap-title" className="h2 mb-2">Onay kuralları</h2>
            <ul className="space-y-1 text-sm">
              {PR_EXTERNAL_ACTIONS.map((a) => (
                <li key={a} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{ACTION_LABELS[a]}</span>
                  <Badge tone="warn">Ayrı sahip onayı</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">PR ajansı bu işlemleri yürütmez; onaylı işlemler mevcut <Link href="/onaylar" className="text-brand underline">Onay Merkezi</Link> akışından geçer.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
