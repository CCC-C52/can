import Link from "next/link";
import { requireBrand } from "@/lib/current";
import { AwaitingSetup, Badge, Empty, PageHeader, Section, dt } from "@/components/ui";
import { Icon } from "@/components/icons";
import { EvidenceRule, SpecialistCard } from "@/components/agency";
import { specialistById } from "@/lib/pr-agency/specialists";
import { listIntegrations } from "@/lib/integrations/service";
import { listFeedHealth, listPrEvidence, listPrOutputs, scoredClusters } from "@/lib/services/pr-agency";
import { dataStatus } from "@/lib/pr-agency/briefings";

export const metadata = { title: "Pazar İstihbaratı" };
export const dynamic = "force-dynamic";

const FEED: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  unconnected: { label: "Bağlı değil", tone: "neutral" }, missing_credentials: { label: "Kimlik yok", tone: "warn" }, never_fetched: { label: "Henüz çekilmedi", tone: "neutral" },
  healthy: { label: "Güncel", tone: "ok" }, stale: { label: "Eski", tone: "warn" }, failing: { label: "Hata", tone: "bad" },
};

export default async function IntelligencePage() {
  const brand = await requireBrand();
  const now = new Date();
  const [cards, feeds, clusters, evidence, outputs] = await Promise.all([
    listIntegrations(brand.id), listFeedHealth(brand.id), scoredClusters(brand.id, now), listPrEvidence(brand.id, { pageSize: 8, verification: "verified" }), listPrOutputs(brand.id, 30),
  ]);
  const states = new Map(cards.map((c) => [c.def.id, c.state]));
  const ds = dataStatus(feeds);
  const usable = ds.status === "fresh" || ds.status === "partial";
  const top = usable ? [...clusters].sort((a, b) => b.relevance.score * b.confidence - a.relevance.score * a.confidence).slice(0, 8) : [];
  const briefs = outputs.filter((o) => o.kind === "pr_daily_brief").slice(0, 5);
  const bw = states.get("brandwatch");
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="PR Ajansı" title="Pazar İstihbaratı" subtitle="Moda trendleri, rakipler ve kültürel gelişmeler — yalnızca bağlı ve uyumlu kaynaklardan, her bulgu kaynak adresi ve alım zamanıyla. Kaynağı olmayan erişim, duygu veya etkileşim verisi gösterilmez."
        actions={<><Link href="/arastirma" className="btn"><Icon name="search" />Araştırma Merkezi</Link><Link href="/pr-ajansi?tab=automation" className="btn"><Icon name="bolt" />Kaynakları yönet</Link></>} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2"><SpecialistCard s={specialistById("market_intelligence")!} states={states} /></div>
        <Section id="bw" title="Sosyal dinleme (Brandwatch)" eyebrow="Rakip, duygu ve tüketici araştırması">
          {bw === "verified" || bw === "degraded" ? (
            <p className="text-sm text-ink-soft">Brandwatch kimliği doğrulandı. Bahsetme ve duygu verisi senkronu, resmî v2 belgesi incelendikten sonra eklenecek; o zamana kadar bu sayfada Brandwatch verisi gösterilmez.</p>
          ) : (
            <AwaitingSetup href="/entegrasyonlar" linkLabel="Brandwatch'ı bağla">Rakip izleme ve marka duygusu için Brandwatch Consumer Research API kullanıcısı gerekir. Şu an yalnızca açık RSS kaynakları ve Araştırma Merkezi kullanılıyor.</AwaitingSetup>
          )}
          <div className="mt-4"><EvidenceRule kind="source_backed_results" /></div>
        </Section>
      </div>

      <div role="note" className={`rounded-2xl px-4 py-3 text-sm ring-1 ${usable ? "bg-success-soft text-success ring-success-line" : "bg-warning-soft text-warning ring-warning-line"}`}>{ds.note}</div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Section id="clusters" title="Trend kümeleri" eyebrow="Hız · ilgi · güven" className="xl:col-span-2">
          {top.length === 0 ? <Empty icon="trend">{usable ? "Koleksiyonlarla ilgili trend kümesi yok." : "Taze kaynak verisi olmadığı için trend içgörüsü gösterilmiyor."}</Empty> : (
            <ul className="space-y-3">
              {top.map((c) => (
                <li key={c.key} className="rounded-2xl border border-line bg-surface-2/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="font-medium">{c.label}</h3>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={c.velocity.label === "rising" || c.velocity.label === "new" ? "info" : "neutral"}>{c.velocity.label}</Badge>
                      <Badge>ilgi {Math.round(c.relevance.score * 100)}%</Badge>
                      <Badge>güven {Math.round(c.confidence * 100)}%</Badge>
                      {c.flags.includes("crisis_watch") && <Badge tone="bad">Kriz izleme</Badge>}
                      {c.flags.includes("major_opportunity") && <Badge tone="ok">Büyük fırsat</Badge>}
                    </div>
                  </div>
                  {c.opportunity && <p className="mt-1 text-sm text-ink-soft">{c.opportunity}</p>}
                  <ul className="mt-2 space-y-0.5 text-xs">{c.items.slice(0, 3).map((i) => <li key={i.canonicalUrl}><a href={i.url} target="_blank" rel="noopener noreferrer nofollow" className="link">{i.title}</a> <span className="text-muted">· {i.sourceId} · {dt(i.publishedAt ?? i.fetchedAt)}</span></li>)}</ul>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <div className="space-y-4">
          <Section id="feeds" title="Kaynak sağlığı" href="/pr-ajansi?tab=automation" linkLabel="Yönet">
            <ul className="space-y-2 text-sm">{feeds.map((f) => <li key={f.sourceId} className="flex items-center justify-between gap-2"><span className="truncate">{f.name}</span><Badge tone={FEED[f.status].tone}>{FEED[f.status].label}</Badge></li>)}</ul>
          </Section>
          <Section id="briefs" title="Günlük özetler" eyebrow="Onay kuyruğuna düşer">
            {briefs.length === 0 ? <p className="text-sm text-muted">Henüz yok.</p> : <ul className="space-y-2 text-sm">{briefs.map((b) => <li key={b.id}><Link href={`/taslaklar/${b.id}`} className="hover:text-brand">{b.title}</Link><div className="text-xs text-muted">{dt(b.created_at)}</div></li>)}</ul>}
          </Section>
        </div>
      </div>

      <Section id="evidence" title="Doğrulanmış araştırma kaynakları" eyebrow="Araştırma Merkezi" href="/arastirma">
        {evidence.items.length === 0 ? <Empty icon="search">Doğrulanmış kaynak yok.</Empty> : (
          <ul className="grid gap-2 md:grid-cols-2">{evidence.items.map((e) => <li key={e.id} className="rounded-xl border border-line p-3 text-sm"><a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="link font-medium break-all">{e.title || e.url}</a><div className="mt-1 text-xs text-muted">Alındı: {dt(e.retrievedAt)}</div></li>)}</ul>
        )}
      </Section>
    </div>
  );
}
