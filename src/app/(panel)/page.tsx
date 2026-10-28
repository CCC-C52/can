import Link from "next/link";
import { getCurrentBrand, flash, type SP } from "@/lib/current";
import { q1 } from "@/lib/db/pool";
import { PROJECT_STATUS_LABEL } from "@/lib/labels";
import { AwaitingSetup, Badge, Empty, Flash, Progress, Section, Stat, StatusDot, dt, usd } from "@/components/ui";
import { Icon } from "@/components/icons";
import { AutoRefresh, SubmitButton } from "@/components/client";
import { todaysAiSpend } from "@/lib/services/costs";
import { isPaused } from "@/lib/settings";
import { agentName } from "@/lib/agents/registry";
import { pauseAction } from "@/app/actions";
import { collectionsOverview, dashboardData, heroAsset } from "@/lib/services/hq";
import { listIntegrations } from "@/lib/integrations/service";
import { STATE_LABEL, STATE_TONE } from "@/lib/integrations/registry";
import { strategySnapshot } from "@/lib/services/strategy";
import { PHASES, PROPOSED_POSITIONING_LINE, timelineProgress } from "@/lib/pr-agency/strategy";
import { SPECIALISTS, specialistReadiness } from "@/lib/pr-agency/specialists";
import { brandKnowledge, listFeedHealth, listPrOutputs, prCalendar } from "@/lib/services/pr-agency";
import { buildEventPlan } from "@/lib/pr-agency/event-plan";

export const metadata = { title: "Ana ekran" };

const isFribee = (b: { name: string; slug: string }) => /^fribee/i.test(b.slug) || /^fribee/i.test(b.name);
const ACTION_ICON: Record<string, "spark" | "drive" | "check" | "plug" | "film" | "strategy" | "megaphone" | "archive"> = {
  drive: "drive", approval: "check", connection: "plug", integration: "plug", render: "film", strategy: "strategy", pr_agency: "megaphone", media: "archive",
};

export default async function Dashboard({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const { brand } = await getCurrentBrand();
  if (!brand) return null;
  const today = new Date().toISOString().slice(0, 10);
  const [d, hero, integrations, strategy, collections, feeds, prOutputs, calendar, knowledge, spend, paused, unknownActions] = await Promise.all([
    dashboardData(brand.id),
    heroAsset(brand.id),
    listIntegrations(brand.id),
    strategySnapshot(brand.id),
    collectionsOverview(brand.id),
    listFeedHealth(brand.id),
    listPrOutputs(brand.id, 20),
    prCalendar(brand.id),
    brandKnowledge(brand.id).catch(() => undefined),
    todaysAiSpend(),
    isPaused(),
    q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM external_actions WHERE brand_id = $1 AND status = 'unknown'`, [brand.id]),
  ]);
  const verified = new Set(integrations.filter((i) => i.state === "verified" || i.state === "degraded").map((i) => i.def.id));
  const metricool = integrations.find((i) => i.def.id === "metricool")!;
  const shopify = integrations.find((i) => i.def.id === "shopify")!;
  const activeAgents = d.agents.filter((a) => a.active > 0);
  const lastBrief = prOutputs.find((o) => o.kind === "pr_daily_brief");
  const upcoming = calendar.events
    .filter((e) => e.date && e.date >= today)
    .slice(0, 5)
    .map((e) => { try { return { e, deadline: buildEventPlan(e, knowledge).approvalDeadline }; } catch { return { e, deadline: null as string | null }; } });
  const healthyFeeds = feeds.filter((f) => f.status === "healthy").length;
  const connectedFeeds = feeds.filter((f) => f.connected).length;
  const limit = d.budget.dailyLimit;
  const spentToday = spend.actual ?? 0;
  const progress = timelineProgress(today);
  const headline = isFribee(brand) ? PROPOSED_POSITIONING_LINE : brand.name;
  const vision = strategy.created ? (strategy.annual[0]?.title ? `${strategy.annual[0].period_key}: ${strategy.annual[0].title}` : null) : null;

  return (
    <div className="space-y-6">
      <Flash ok={ok} err={err} />
      {!d.workerAlive && (
        <div role="status" className="flex items-start gap-2 rounded-2xl bg-warning-soft px-4 py-3 text-sm text-warning ring-1 ring-warning-line">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Görev işleyicisi çalışmıyor görünüyor{d.workerLastSeen ? ` (son sinyal: ${dt(d.workerLastSeen)})` : ""}. Görevler kayıtlı kalır ancak işlenmez. Başlatmak için: <code>npm run worker</code></span>
        </div>
      )}

      {/* ---------------------------------------------------------------- Kapak */}
      <div className="grid gap-4 xl:grid-cols-12">
        <section aria-labelledby="hero-title" className="relative isolate min-h-[22rem] overflow-hidden rounded-[1.5rem] border border-line bg-panel xl:col-span-8">
          {hero ? (
            // Doğrulanmış marka görseli (yalnızca küçültülür; renk ve baskı değiştirilmez)
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/media/${hero.id}/preview?w=1920`} alt="" className="absolute inset-0 -z-10 h-full w-full object-cover object-center opacity-80" />
          ) : (
            <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(80%_120%_at_80%_0%,rgb(216_178_106/0.22),transparent_60%),radial-gradient(60%_80%_at_0%_100%,rgb(169_155_247/0.16),transparent_60%)]" />
          )}
          <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-canvas via-canvas/80 to-canvas/10" />
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 -z-10 h-1/2 bg-gradient-to-t from-canvas/90 to-transparent" />
          <div className="flex h-full min-h-[22rem] flex-col justify-between gap-8 p-6 sm:p-8">
            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow">{brand.name} HQ</span>
              <span className="text-xs text-muted">· {new Date().toLocaleDateString("tr-TR", { dateStyle: "long" })}</span>
              {brand.is_sample && <Badge tone="demo">ÖRNEK MARKA</Badge>}
            </div>
            <div className="max-w-xl">
              <h1 id="hero-title" className="font-display text-4xl leading-[1.05] font-semibold tracking-tight text-ink sm:text-5xl">{headline}</h1>
              {isFribee(brand) && <p className="mt-2 text-xs text-muted">Önerilen konumlandırma satırı — sahip onaylayana kadar resmî slogan değildir.</p>}
              <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-ink-soft">
                {vision ?? "Yeni nesil Amerikan streetwear markası için 2026–2034 marka ve PR programı: doğrulanmış görseller, ölçülmüş hedefler ve her dış işlemde sahip onayı."}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <Link href="/pr-ajansi/strateji" className="btn-primary"><Icon name="strategy" />Marka Stratejisi</Link>
                <Link href="/sohbet" className="btn"><Icon name="spark" />Yöneticiye talimat ver</Link>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              {hero ? (
                <><Icon name="shield" className="h-3.5 w-3.5 text-success" />{hero.source === "owner" ? "Kapak: sahibin seçtiği marka görseli" : hero.source === "verified_reference" ? `Kapak: doğrulanmış ürün görseli${hero.theme ? ` · ${hero.theme.replace(/_/g, " ")}` : ""}` : "Kapak: marka sahibi gerçek fotoğraf"}</>
              ) : (
                <><Icon name="image" className="h-3.5 w-3.5" />Doğrulanmış görsel yok — <Link href="/drive-arsivi?tab=review" className="link">Drive Arşivi'nde ürün fotoğraflarını onaylayın</Link></>
              )}
            </div>
          </div>
        </section>

        <section aria-labelledby="today-title" className="card flex flex-col gap-5 xl:col-span-4">
          <div className="flex items-start justify-between gap-2">
            <div><div className="eyebrow mb-1">Bugün</div><h2 id="today-title" className="h2">Operasyon özeti</h2></div>
            <AutoRefresh active={d.tasks.running > 0} />
          </div>
          <ul className="space-y-3 text-sm">
            <li className="flex items-center justify-between gap-2"><Link href="/onaylar" className="flex items-center gap-2 text-ink-soft hover:text-ink"><Icon name="check" className="h-4 w-4 text-brand" />Bekleyen onaylar</Link><span className="text-lg font-semibold">{d.approvals}</span></li>
            <li className="flex items-center justify-between gap-2"><Link href="/gorevler" className="flex items-center gap-2 text-ink-soft hover:text-ink"><Icon name="team" className="h-4 w-4 text-violet" />Çalışan AI işleri</Link><span className="text-lg font-semibold">{d.tasks.running}<span className="ml-1 text-xs font-normal text-muted">+{d.tasks.queued} sırada</span></span></li>
            <li className="flex items-center justify-between gap-2"><Link href="/gorevler?status=waiting_connection" className="flex items-center gap-2 text-ink-soft hover:text-ink"><Icon name="plug" className="h-4 w-4 text-ember" />Bağlantı bekleyen</Link><span className="text-lg font-semibold">{d.tasks.waiting}</span></li>
            <li className="flex items-center justify-between gap-2"><Link href="/otomasyon" className="flex items-center gap-2 text-ink-soft hover:text-ink"><Icon name="bolt" className="h-4 w-4 text-mint" />Zamanlanmış PR işleri (30 gün)</Link><span className="text-sm"><span className="font-semibold">{d.ops.completed}</span> <span className="text-muted">kanıtlı</span>{d.ops.failed ? <span className="text-danger"> · {d.ops.failed} hata</span> : null}</span></li>
          </ul>
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs"><span className="text-muted">Bugünkü AI harcaması (tüm markalar)</span><span className="font-medium">{usd(spend.actual, 2)}{limit !== null ? <span className="text-muted"> / {usd(limit, 2)}</span> : null}</span></div>
            {limit !== null ? <Progress value={spentToday} max={limit} label="Günlük AI bütçesi kullanımı" tone={spentToday >= limit ? "danger" : spentToday >= limit * 0.8 ? "warn" : "gold"} /> : <p className="text-xs text-warning">Günlük bütçe sınırı tanımlı değil.</p>}
            {spend.unknownCount ? <p className="mt-1 text-xs text-warning">{spend.unknownCount} kayıt bilinmeyen tutarlı.</p> : null}
          </div>
          <div className="mt-auto flex flex-wrap gap-2">
            <form action={pauseAction}>
              <input type="hidden" name="paused" value={paused ? "false" : "true"} />
              <SubmitButton className={paused ? "btn" : "btn-danger"} confirm={paused ? undefined : "Tüm işlemler durdurulsun mu?"}>{paused ? "Devam ettir" : "Tüm işlemleri durdur"}</SubmitButton>
            </form>
            <Link href="/maliyet" className="btn">Maliyet</Link>
          </div>
          {(d.tasks.failed7 > 0 || (unknownActions?.n ?? 0) > 0) && (
            <div className="space-y-1 text-xs">
              {d.tasks.failed7 > 0 && <p className="text-danger">Son 7 günde {d.tasks.failed7} görev başarısız oldu. <Link className="underline" href="/gorevler?status=failed">İncele</Link></p>}
              {(unknownActions?.n ?? 0) > 0 && <p className="text-warning">{unknownActions!.n} dış işlemin sonucu belirsiz — <Link className="underline" href="/onaylar">kontrol edin</Link>.</p>}
            </div>
          )}
        </section>
      </div>

      {/* ---------------------------------------------------------------- Metrikler */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Sosyal medya performansı" icon="share" accent="violet" value="—" href="/takvim"
          hint={metricool.state === "verified" ? "Metricool doğrulandı; analitik senkronu sonraki adımda." : "Veri yok — Metricool bağlantısı bekleniyor."} />
        <Stat label="Etkileşim oranı" icon="pulse" accent="sky" value="—" href="/entegrasyonlar"
          hint={strategy.measured ? `${strategy.measured} ölçülmüş KPI değeri stratejide kayıtlı.` : "Ölçülmüş değer yok; tahmin gösterilmez."} />
        <Stat label="Satış" icon="cart" accent="mint" value="—" href="/is/satis"
          hint={shopify.state === "verified" ? "Mağaza bağlı; sipariş verisi için read_orders kapsamı gerekli." : "Shopify bağlantısı bekleniyor."} />
        <Stat label="Kampanyalar" icon="flag" accent="gold" value={d.campaigns.filter((c) => ["planning", "running", "needs_attention", "needs_input"].includes(c.status)).length} href="/projeler" hint={`${d.campaigns.length} son proje`} />
        <Stat label="İçerik üretimi (30 gün)" icon="draft" accent="ember" value={d.outputs30.total} href="/taslaklar" hint={`${d.outputs30.pr} PR raporu · ${d.outputs30.video} video planı`} />
        <Stat label="Medya etkinliği (30 gün)" icon="archive" accent="sky" value={d.media.new30} href="/medya" hint={`${d.media.refs} doğrulanmış ürün görseli · ${d.media.pending_refs} incelemede`} />
      </div>

      {/* ---------------------------------------------------------------- Kampanyalar · Takvim · Ekip */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Section id="campaigns" title="Son kampanyalar" eyebrow="Kampanya Yönetimi" href="/projeler">
          {d.campaigns.length === 0 ? <Empty icon="flag">Henüz kampanya yok. AI Yönetici'ye bir hedef verin.</Empty> : (
            <ul className="space-y-4">
              {d.campaigns.map((c) => (
                <li key={c.id}>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <Link href={`/projeler/${c.id}`} className="truncate font-medium hover:text-brand">{c.title}</Link>
                    <span className="shrink-0 text-xs text-muted">{PROJECT_STATUS_LABEL[c.status] ?? c.status}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Progress value={c.done} max={Math.max(1, c.tasks)} label={`${c.title} görev ilerlemesi`} tone={c.status === "failed" ? "danger" : c.status === "completed" ? "ok" : "gold"} />
                    <span className="shrink-0 text-[11px] text-muted">{c.done}/{c.tasks}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="calendar" title="İçerik takvimi" eyebrow="ABD takvimi · doğrulanmış tarihler" href="/pr-ajansi/takvim">
          {upcoming.length === 0 ? <Empty icon="calendar">Yaklaşan doğrulanmış tarih yok.</Empty> : (
            <ul className="space-y-3">
              {upcoming.map(({ e, deadline }) => (
                <li key={e.id} className="flex items-start gap-3">
                  <div className="grid w-12 shrink-0 place-items-center rounded-xl border border-line bg-surface-2 py-1.5 text-center">
                    <span className="text-[10px] tracking-wide text-muted uppercase">{new Date(`${e.date}T00:00:00Z`).toLocaleDateString("tr-TR", { month: "short", timeZone: "UTC" })}</span>
                    <span className="text-base leading-none font-semibold">{e.date!.slice(8, 10)}</span>
                  </div>
                  <div className="min-w-0 text-sm">
                    <div className="truncate font-medium">{e.name}</div>
                    <div className="text-xs text-muted">{e.dateIsOfficial ? "Resmî tarih" : "Yaklaşık ticari dönem"}{deadline ? ` · onay son günü ${deadline}` : ""}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="team" title="AI PR ekibi" eyebrow={`${activeAgents.length} ajan şu an çalışıyor`} href="/pr-ajansi">
          <ul className="space-y-2.5">
            {SPECIALISTS.map((s) => {
              const r = specialistReadiness(s, verified);
              const busy = d.agents.filter((a) => s.engineAgents.includes(a.agent as never)).reduce((n, a) => n + a.active, 0);
              return (
                <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2"><StatusDot tone={busy ? "info" : r.state === "ready" ? "ok" : r.state === "partial" ? "warn" : "neutral"} pulse={busy > 0} /><span className="truncate">{s.titleTr}</span></span>
                  <span className="shrink-0 text-xs text-muted">{busy ? `${busy} iş` : r.state === "ready" ? "Hazır" : r.state === "partial" ? "Kısmi veri" : "İç verilerle"}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      </div>

      {/* ---------------------------------------------------------------- 8 yıllık yol haritası */}
      <Section id="roadmap" title="Sekiz yıllık yol haritası 2026–2034" eyebrow={strategy.created ? `${strategy.approved} onaylı · ${strategy.proposed} öneri kalemi` : "Çerçeve henüz oluşturulmadı"} href="/pr-ajansi/strateji" linkLabel="Stratejiyi aç">
        <div className="mb-4 flex items-center gap-3">
          <Progress value={progress * 100} max={100} label="Strateji takvim ilerlemesi" />
          <span className="shrink-0 text-xs text-muted">Takvim: %{Math.round(progress * 100)} (performans değil)</span>
        </div>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {PHASES.map((p) => {
            const current = strategy.phase?.key === p.key;
            const item = strategy.phases.find((x) => x.key === p.key)?.item;
            return (
              <li key={p.key} className={`rounded-2xl border p-4 ${current ? "border-brand/60 bg-brand/[0.07]" : "border-line bg-surface-2/60"}`} aria-current={current ? "step" : undefined}>
                <div className="flex items-center justify-between gap-2"><span className={`text-xs font-semibold ${current ? "text-brand" : "text-muted"}`}>{p.label}</span>{current && <Badge tone="info">Şimdi</Badge>}</div>
                <div className="mt-1.5 font-display text-lg leading-snug">{p.title}</div>
                <div className="mt-2 text-xs text-muted">{item ? (item.status === "proposed" ? "Öneri — onay bekliyor" : `Durum: ${item.status}`) : "Kayıt yok"}</div>
              </li>
            );
          })}
        </ol>
      </Section>

      {/* ---------------------------------------------------------------- İstihbarat · Entegrasyonlar · Etkinlik */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Section id="intel" title="Pazar istihbaratı" eyebrow="Günlük izleme" href="/pr-ajansi/istihbarat">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">Taze kaynak</dt><dd className="mt-1 text-xl font-semibold">{healthyFeeds}<span className="text-sm font-normal text-muted">/{connectedFeeds}</span></dd></div>
            <div className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">Brandwatch</dt><dd className="mt-1"><Badge tone={STATE_TONE[integrations.find((i) => i.def.id === "brandwatch")!.state]}>{STATE_LABEL[integrations.find((i) => i.def.id === "brandwatch")!.state]}</Badge></dd></div>
          </dl>
          <div className="mt-4 text-sm">
            {lastBrief ? (
              <><div className="text-xs text-muted">Son günlük özet · {dt(lastBrief.created_at)}</div><Link href={`/taslaklar/${lastBrief.id}`} className="mt-1 line-clamp-2 block font-medium hover:text-brand">{lastBrief.title}</Link>{lastBrief.content?.dataStatusNote ? <p className="mt-1 line-clamp-2 text-xs text-muted">{lastBrief.content.dataStatusNote}</p> : null}</>
            ) : connectedFeeds === 0 ? (
              <AwaitingSetup title="Kaynak bağlı değil" href="/pr-ajansi?tab=automation" linkLabel="Kaynakları seç">Trend, rakip ve kültür izleme için RSS kaynaklarını açın veya Brandwatch'ı bağlayın.</AwaitingSetup>
            ) : <p className="text-xs text-muted">Henüz günlük özet üretilmedi.</p>}
          </div>
        </Section>

        <Section id="integrations" title="Platform entegrasyonları" eyebrow={`${verified.size}/6 doğrulandı`} href="/entegrasyonlar" linkLabel="Yönet">
          <ul className="space-y-2.5">
            {integrations.map((i) => (
              <li key={i.def.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-2"><StatusDot tone={STATE_TONE[i.state]} /><span className="truncate">{i.def.name.split(" (")[0]}</span></span>
                <span className="shrink-0 text-xs text-muted">{STATE_LABEL[i.state]}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="activity" title="Son etkinlikler" eyebrow="Denetim kaydı" href="/ayarlar" linkLabel="Geçmiş">
          {d.activity.length === 0 ? <Empty icon="clock">Henüz kayıt yok.</Empty> : (
            <ol className="space-y-3">
              {d.activity.map((a) => (
                <li key={a.id} className="flex gap-3 text-sm">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-surface-3 text-muted"><Icon name={ACTION_ICON[a.action.split(".")[0]] ?? "spark"} className="h-3.5 w-3.5" /></span>
                  <div className="min-w-0"><div className="line-clamp-2 text-ink-soft">{a.message}</div><div className="text-[11px] text-muted">{dt(a.created_at)} · {a.actor.startsWith("agent:") ? agentName(a.actor.slice(6) as never) : a.actor === "user" ? "Sahip" : "Sistem"}</div></div>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>

      {/* ---------------------------------------------------------------- Koleksiyonlar */}
      <Section id="collections" title="Marka koleksiyonları" eyebrow={`${collections.products} ürün · ${collections.confirmedCount} onaylı koleksiyon bilgisi`} href="/koleksiyonlar">
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {collections.themes.map((c) => (
            <li key={c.theme}>
              <Link href={`/koleksiyonlar#${c.theme}`} className="group block overflow-hidden rounded-2xl border border-line bg-surface-2 transition-colors hover:border-line-strong">
                <div className="relative aspect-[4/5] bg-surface-3">
                  {c.sampleId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/media/${c.sampleId}/preview?w=640`} alt={`${c.label} koleksiyonu — doğrulanmış ürün görseli`} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03]" />
                  ) : (
                    <div className="grid h-full place-items-center p-4 text-center text-xs text-muted"><span><Icon name="image" className="mx-auto mb-2 h-5 w-5" />Doğrulanmış görsel yok</span></div>
                  )}
                  <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-canvas/90 to-transparent" />
                </div>
                <div className="p-3">
                  <div className="font-display text-lg leading-tight">{c.label}</div>
                  <div className="mt-0.5 text-xs text-muted">{c.verified} doğrulanmış görsel · {c.garment}</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
