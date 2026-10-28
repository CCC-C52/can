import Link from "next/link";
import { flash, requireBrand, type SP } from "@/lib/current";
import { listPrEvidence, prAgencyOverview } from "@/lib/services/pr-agency";
import { FRIBEE_COLLECTIONS_SOURCE, PR_AGENCY_PATH, PR_EXTERNAL_ACTIONS, STALE_AFTER_HOURS, type Availability, type Freshness, type Verification } from "@/lib/pr-agency/model";
import { Badge, Empty, Flash, PageHeader, Stat, dt } from "@/components/ui";
import type { Tone } from "@/lib/labels";
import { Automation, Calendar, Strategy } from "./tabs";
import { Icon, type IconName } from "@/components/icons";
import { SPECIALISTS, specialistReadiness } from "@/lib/pr-agency/specialists";
import { listIntegrations } from "@/lib/integrations/service";
import { agentName } from "@/lib/agents/registry";

const HUB: { href: string; title: string; text: string; icon: IconName }[] = [
  { href: "/pr-ajansi/strateji", title: "Marka Stratejisi 2026–2034", text: "Vizyon, aşamalar, yıllık hedefler, OKR'ler", icon: "strategy" },
  { href: "/pr-ajansi/istihbarat", title: "Pazar İstihbaratı", text: "Trendler, rakipler, kültür", icon: "radar" },
  { href: "/pr-ajansi/medya-iliskileri", title: "Medya İlişkileri", text: "Basın taslakları ve kapsam", icon: "mic" },
  { href: "/pr-ajansi/influencer", title: "Influencer Ağı", text: "Beyanlı iş birliği önerileri", icon: "users" },
  { href: "/pr-ajansi/takvim", title: "İçerik Takvimi", text: "ABD 12 aylık takvim", icon: "calendar" },
  { href: "/pr-ajansi/kutuphane", title: "Bilgi Kütüphanesi", text: "AMEC, Barcelona 4.0, CBBE, SCCT…", icon: "library" },
];

const TABS = [
  { id: "overview", label: "Genel bakış" },
  { id: "automation", label: "Otomasyon ve raporlar" },
  { id: "calendar", label: "ABD 12 aylık takvim" },
  { id: "strategy", label: "24 aylık bilinirlik planı" },
] as const;

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
  const tab = TABS.find((t) => t.id === one("tab"))?.id ?? "overview";
  const page = Number(one("sayfa")) || 1;
  const [o, ev, integrations] = await Promise.all([prAgencyOverview(brand), listPrEvidence(brand.id, { page, pageSize: 20, verification: filter }), listIntegrations(brand.id)]);
  const verified = new Set(integrations.filter((i) => i.state === "verified" || i.state === "degraded").map((i) => i.def.id));
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
        eyebrow="AI PR Ajansı"
        title="PR Ajansı"
        subtitle={`${o.brand.name} için kalıcı marka yönetimi ve halkla ilişkiler departmanı: araştırma, yürütme, koordinasyon, doğrulama, ölçüm ve raporlama. Gösterilen her bilgi kaynağı ve alım zamanıyla gelir; kaynağı olmayan erişim, etkileşim veya duygu verisi gösterilmez.`}
        actions={<><Link href="/pr-ajansi/strateji" className="btn-primary"><Icon name="strategy" />Marka Stratejisi</Link><Link href="/otomasyon" className="btn"><Icon name="bolt" />Otomasyon</Link></>}
      />
      {tab === "overview" && (
        <>
          <ul className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {HUB.map((h) => (
              <li key={h.href}>
                <Link href={h.href} className="card card-interactive flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/25 ring-inset"><Icon name={h.icon} className="h-5 w-5" /></span>
                  <span className="min-w-0"><span className="block font-medium text-ink">{h.title}</span><span className="block text-xs text-muted">{h.text}</span></span>
                </Link>
              </li>
            ))}
          </ul>
          <section className="mb-6" aria-labelledby="team-title">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div><div className="eyebrow mb-1">Uzman kadrosu</div><h2 id="team-title" className="h2">AI PR Direktörü ve ekibi</h2></div>
              <p className="max-w-xl text-xs text-muted">Uzmanlar mevcut görev motoru ajanlarına ve zamanlanmış rollere eşlenir; paralel bir sistem yoktur. Koordinasyon görev motoru ve Onay Merkezi üzerinden yürür.</p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {SPECIALISTS.map((s) => {
                const r = specialistReadiness(s, verified);
                return (
                  <li key={s.id} className="card">
                    <div className="flex items-start justify-between gap-2"><h3 className="font-medium">{s.titleTr}</h3><Badge tone={r.state === "ready" ? "ok" : r.state === "partial" ? "info" : "warn"}>{r.state === "ready" ? "Hazır" : r.state === "partial" ? "Kısmi veri" : "İç verilerle"}</Badge></div>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{s.mission}</p>
                    <p className="mt-2 text-[11px] text-ink-soft">{s.engineAgents.length ? `Ajan: ${s.engineAgents.map((a) => agentName(a)).join(", ")}` : "Zamanlanmış işler"}{s.integrations.length ? ` · Platform: ${s.integrations.join(", ")}` : ""}</p>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
      <Flash ok={ok} err={err} />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="PR Ajansı bölümleri">
        {TABS.map((t) => <Link key={t.id} href={`${PR_AGENCY_PATH}?tab=${t.id}`} className={t.id === tab ? "chip-active" : "chip"} aria-current={t.id === tab ? "page" : undefined}>{t.label}</Link>)}
      </nav>
      {tab === "automation" && <Automation brandId={brand.id} />}
      {tab === "calendar" && <Calendar brandId={brand.id} />}
      {tab === "strategy" && <Strategy brandId={brand.id} />}
      {tab === "overview" && (<>

      <div role="note" className="mb-4 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning ring-1 ring-warning-line">
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
          {o.lastRun.error ? <span className="text-danger"> · {o.lastRun.error}</span> : null}
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
                <p className="mt-1 text-xs text-warning">
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
                <Link href={link({})} aria-current={filter === null ? "page" : undefined} className={filter === null ? "font-medium text-brand" : "text-ink-soft"}>Tümü ({o.evidence.total})</Link>
                {(["verified", "unverified", "rejected"] as const).map((v) => (
                  <Link key={v} href={link({ durum: v })} aria-current={filter === v ? "page" : undefined} className={filter === v ? "font-medium text-brand" : "text-ink-soft"}>{VERIFICATION[v].label}</Link>
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
      </>)}
    </div>
  );
}
