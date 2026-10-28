import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { q } from "@/lib/db/pool";
import { AwaitingSetup, Badge, Empty, Flash, PageHeader, Progress, Section, dt } from "@/components/ui";
import { Icon } from "@/components/icons";
import { SubmitButton } from "@/components/client";
import { listStrategy, strategySnapshot, type StrategyItem } from "@/lib/services/strategy";
import { listOperationRuns, listPrOutputs } from "@/lib/services/pr-agency";
import { PHASES, PROPOSED_POSITIONING_LINE, STRATEGY_TITLE, keyResultState, quarterOf, timelineProgress, weekOf } from "@/lib/pr-agency/strategy";
import { SPECIALISTS } from "@/lib/pr-agency/specialists";
import { TASK_STATUS_LABEL, TASK_STATUS_TONE, type TaskStatus, type Tone } from "@/lib/labels";
import { agentName } from "@/lib/agents/registry";
import { strategyAddAction, strategyMeasureAction, strategySeedAction, strategyUpdateAction } from "@/app/actions/agency";

export const metadata = { title: "Marka Stratejisi" };
export const dynamic = "force-dynamic";

const STATUS: Record<StrategyItem["status"], { label: string; tone: Tone }> = {
  proposed: { label: "Öneri — onay bekliyor", tone: "warn" },
  approved: { label: "Onaylandı", tone: "ok" },
  active: { label: "Yürütülüyor", tone: "info" },
  at_risk: { label: "Risk altında", tone: "bad" },
  done: { label: "Tamamlandı", tone: "ok" },
  dropped: { label: "Bırakıldı", tone: "neutral" },
};
const PROVENANCE: Record<StrategyItem["provenance"], string> = { owner: "Sahip yazdı", ai_recommendation: "AI önerisi", framework: "Çerçeveden" };
const roleName = (id: string | null) => SPECIALISTS.find((s) => s.id === id)?.titleTr ?? id ?? "—";

function ItemCard({ item, compact = false }: { item: StrategyItem; compact?: boolean }) {
  const st = STATUS[item.status];
  return (
    <article id={item.id} className="scroll-mt-24 rounded-2xl border border-line bg-surface-2/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-brand">{item.period_key}</div>
          <h3 className={`mt-0.5 font-display ${compact ? "text-base" : "text-lg"} leading-snug`}>{item.title}</h3>
        </div>
        <div className="flex flex-wrap gap-1.5"><Badge tone={st.tone}>{st.label}</Badge><Badge>{PROVENANCE[item.provenance]}</Badge></div>
      </div>
      {item.body && <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-ink-soft">{item.body}</p>}
      <div className="mt-2 text-xs text-muted">Sorumlu: {roleName(item.owner_role)}</div>
      {item.key_results.length > 0 && (
        <ul className="mt-3 space-y-2">
          {item.key_results.map((k, i) => {
            const state = keyResultState(k);
            return (
              <li key={i} className="rounded-xl border border-line bg-panel/70 p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="font-medium">{k.label}</span>
                  <Badge tone={state === "unmeasured" ? "neutral" : state === "baseline_only" ? "info" : "ok"}>{state === "unmeasured" ? "Ölçülmedi" : state === "baseline_only" ? "Başlangıç ölçüldü" : "İzleniyor"}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted">Hedef: {k.target}</div>
                {(k.baseline || k.current) && (
                  <div className="mt-1 text-xs text-ink-soft">
                    {k.baseline && <>Başlangıç: <strong>{k.baseline.value}</strong> ({k.baseline.measuredAt}, {k.baseline.source}) </>}
                    {k.current && <> · Güncel: <strong>{k.current.value}</strong> ({k.current.measuredAt}, {k.current.source})</>}
                  </div>
                )}
                <details className="mt-2 text-xs">
                  <summary className="text-brand">Ölçüm ekle (kaynak zorunlu)</summary>
                  <form action={strategyMeasureAction} className="mt-2 grid gap-2 sm:grid-cols-4">
                    <input type="hidden" name="id" value={item.id} /><input type="hidden" name="index" value={i} />
                    <label className="text-xs"><span className="label">Tür</span><select name="which" className="input py-1.5"><option value="baseline">Başlangıç</option><option value="current">Güncel</option></select></label>
                    <label className="text-xs"><span className="label">Değer</span><input name="value" inputMode="decimal" required className="input py-1.5" /></label>
                    <label className="text-xs"><span className="label">Ölçüm tarihi</span><input name="measuredAt" type="date" required className="input py-1.5" /></label>
                    <label className="text-xs"><span className="label">Kaynak</span><input name="source" required minLength={3} placeholder="ör. Metricool rapor, 2026-11" className="input py-1.5" /></label>
                    <div className="sm:col-span-4"><SubmitButton className="btn py-1.5">Ölçümü kaydet</SubmitButton></div>
                  </form>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <details className="mt-3 text-xs">
        <summary className="text-brand">Durumu değiştir veya düzenle</summary>
        <form action={strategyUpdateAction} className="mt-2 grid gap-2">
          <input type="hidden" name="id" value={item.id} />
          <label><span className="label">Başlık</span><input name="title" defaultValue={item.title} required maxLength={300} className="input" /></label>
          <label><span className="label">Açıklama</span><textarea name="body" defaultValue={item.body ?? ""} rows={3} maxLength={8000} className="input" /></label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label><span className="label">Durum</span><select name="status" defaultValue={item.status} className="input">{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
            <label><span className="label">Gerekçe (stratejik ayarlama kaydı)</span><input name="reason" maxLength={1000} placeholder="ör. Q4 ölçümleri hedefin altında" className="input" /></label>
          </div>
          <div><SubmitButton className="btn-primary">Kaydet</SubmitButton></div>
        </form>
      </details>
    </article>
  );
}

function AddForm({ level, label, periodHint, placeholder, parents }: { level: "annual" | "quarterly" | "monthly" | "weekly"; label: string; periodHint: string; placeholder: string; parents: StrategyItem[] }) {
  return (
    <details className="mt-4 rounded-2xl border border-dashed border-line p-3 text-sm">
      <summary className="text-brand">{label}</summary>
      <form action={strategyAddAction} className="mt-3 grid gap-2 sm:grid-cols-2">
        <input type="hidden" name="level" value={level} />
        <label className="text-xs"><span className="label">Dönem ({periodHint})</span><input name="periodKey" required placeholder={placeholder} className="input" /></label>
        <label className="text-xs"><span className="label">Üst kalem</span><select name="parentId" className="input"><option value="">—</option>{parents.map((p) => <option key={p.id} value={p.id}>{p.period_key} · {p.title}</option>)}</select></label>
        <label className="text-xs sm:col-span-2"><span className="label">Başlık</span><input name="title" required maxLength={300} className="input" /></label>
        <label className="text-xs sm:col-span-2"><span className="label">Açıklama</span><textarea name="body" rows={2} maxLength={8000} className="input" /></label>
        <label className="text-xs"><span className="label">Sorumlu uzman</span><select name="ownerRole" className="input"><option value="">—</option>{SPECIALISTS.map((s) => <option key={s.id} value={s.id}>{s.titleTr}</option>)}</select></label>
        <label className="text-xs"><span className="label">Anahtar sonuç (isteğe bağlı)</span><input name="krLabel" maxLength={200} className="input" /></label>
        <label className="text-xs sm:col-span-2"><span className="label">Hedef (ölçüm yoksa boş bırakın: “başlangıç ölçüldükten sonra”)</span><input name="krTarget" maxLength={300} className="input" /></label>
        <div className="sm:col-span-2"><SubmitButton className="btn-primary">Ekle (öneri olarak)</SubmitButton></div>
      </form>
    </details>
  );
}

export default async function StrategyPage({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const week = weekOf(today);
  const [items, snap, runs, outputs, weekTasks, revisions] = await Promise.all([
    listStrategy(brand.id),
    strategySnapshot(brand.id, now),
    listOperationRuns(brand.id, 10),
    listPrOutputs(brand.id, 40),
    q<{ id: string; title: string; agent: string; status: TaskStatus }>(
      `SELECT id, title, agent, status FROM tasks WHERE brand_id = $1 AND updated_at >= $2::date ORDER BY updated_at DESC LIMIT 8`, [brand.id, week.start]),
    q<{ id: string; item_id: string; title: string; reason: string | null; changed_by: string; created_at: string }>(
      `SELECT r.id, r.item_id, s.title, r.reason, r.changed_by, r.created_at FROM strategy_item_revisions r JOIN strategy_items s ON s.id = r.item_id WHERE r.brand_id = $1 ORDER BY r.created_at DESC LIMIT 8`, [brand.id]),
  ]);
  const by = (lvl: StrategyItem["level"]) => items.filter((i) => i.level === lvl);
  const vision = by("vision")[0];
  const annual = by("annual");
  const quarterly = by("quarterly");
  const monthly = by("monthly");
  const weekly = by("weekly").filter((w) => w.period_end >= week.start).slice(0, 10);
  const reviews = outputs.filter((o) => o.kind === "pr_quarterly_review" || o.kind === "pr_annual_review").slice(0, 4);
  const dailyBrief = outputs.find((o) => o.kind === "pr_daily_brief");
  const quarter = quarterOf(today);

  return (
    <div>
      <PageHeader
        eyebrow="PR Ajansı · 2026–2034"
        title="Marka Stratejisi"
        subtitle={<>{STRATEGY_TITLE}. FriBee'yi büyük bir pazar lansmanına hazırlanan yeni nesil bir Amerikan streetwear markası olarak konumlar. Tüm kalemler sahip onaylayana kadar <strong>öneridir</strong>; satış, büyüme veya basın verisi uydurulmaz ve sayısal hedefler ölçülmüş başlangıç değerine bağlanır.</>}
        actions={<><Link href="/pr-ajansi/kutuphane" className="btn"><Icon name="library" />Bilgi kütüphanesi</Link><Link href="/pr-ajansi" className="btn"><Icon name="megaphone" />Ajans merkezi</Link></>}
      />
      <Flash ok={ok} err={err} />

      {!snap.created ? (
        <section className="card">
          <AwaitingSetup title="Strateji çerçevesi henüz oluşturulmadı" >
            Vizyon, beş aşama (2026–2034), dokuz yıllık hedef, yakın dönem çeyreklik OKR önerileri ve önümüzdeki ayların kampanya planı öneri olarak oluşturulur. Hiçbiri sizin onayınız olmadan resmî sayılmaz; hepsini düzenleyebilirsiniz.
          </AwaitingSetup>
          <form action={strategySeedAction} className="mt-4"><SubmitButton className="btn-primary" pendingText="Oluşturuluyor…">Strateji çerçevesini oluştur (öneri olarak)</SubmitButton></form>
        </section>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 xl:grid-cols-3">
            <section className="card xl:col-span-2" aria-labelledby="vision-title">
              <div className="eyebrow mb-1">Sekiz yıllık vizyon</div>
              <h2 id="vision-title" className="font-display text-2xl leading-tight">{vision?.title ?? STRATEGY_TITLE}</h2>
              <p className="mt-1 text-xs text-muted">Önerilen konumlandırma satırı: “{PROPOSED_POSITIONING_LINE}” — resmî slogan değildir.</p>
              {vision && <div className="mt-4"><ItemCard item={vision} compact /></div>}
            </section>
            <section className="card space-y-4" aria-labelledby="now-title">
              <div><div className="eyebrow mb-1">Şu an</div><h2 id="now-title" className="h2">{snap.phase ? `${snap.phase.title} (${snap.phase.label})` : "Strateji dönemi dışında"}</h2></div>
              <div>
                <div className="mb-1.5 flex justify-between text-xs text-muted"><span>2026</span><span>Takvim ilerlemesi %{Math.round(timelineProgress(today) * 100)}</span><span>2034</span></div>
                <Progress value={timelineProgress(today) * 100} label="Strateji takvim ilerlemesi" />
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">Onaylı kalem</dt><dd className="text-xl font-semibold">{snap.approved}<span className="text-sm font-normal text-muted">/{snap.total}</span></dd></div>
                <div className="rounded-xl bg-surface-2 p-3"><dt className="text-xs text-muted">Ölçülmüş anahtar sonuç</dt><dd className="text-xl font-semibold">{snap.measured}<span className="text-sm font-normal text-muted">/{snap.keyResults}</span></dd></div>
              </dl>
              <p className="text-xs text-muted">Bu çeyrek: {quarter.key} · bu hafta: {week.key}</p>
            </section>
          </div>

          <Section id="phases" title="Stratejik aşamalar" eyebrow="2026–2034">
            <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              {PHASES.map((p) => {
                const item = by("phase").find((i) => i.seed_key === `phase:${p.key}`);
                const current = snap.phase?.key === p.key;
                return (
                  <li key={p.key} className={`rounded-2xl border p-4 ${current ? "border-brand/60 bg-brand/[0.07]" : "border-line bg-surface-2/60"}`} aria-current={current ? "step" : undefined}>
                    <div className="flex items-center justify-between gap-2"><span className={`text-xs font-semibold ${current ? "text-brand" : "text-muted"}`}>{p.label}</span>{item && <Badge tone={STATUS[item.status].tone}>{STATUS[item.status].label.split(" —")[0]}</Badge>}</div>
                    <h3 className="mt-1.5 font-display text-lg leading-snug">{item?.title ?? p.title}</h3>
                    <ul className="mt-2 space-y-1 text-xs text-ink-soft">{p.focus.map((f) => <li key={f} className="flex gap-1.5"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand" />{f}</li>)}</ul>
                    {item && (
                      <form action={strategyUpdateAction} className="mt-3 flex gap-1.5">
                        <input type="hidden" name="id" value={item.id} />
                        <label className="sr-only" htmlFor={`ps-${item.id}`}>{p.title} durumu</label>
                        <select id={`ps-${item.id}`} name="status" defaultValue={item.status} className="input py-1 text-xs">{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                        <SubmitButton className="btn px-2 py-1 text-xs">Kaydet</SubmitButton>
                      </form>
                    )}
                  </li>
                );
              })}
            </ol>
          </Section>

          <Section id="annual" title="Yıllık hedefler" eyebrow="2026–2034 · yıl başına bir hedef">
            <div className="grid gap-3 lg:grid-cols-2">{annual.map((a) => <ItemCard key={a.id} item={a} />)}</div>
            <AddForm level="annual" label="Yıllık hedef ekle" periodHint="YYYY" placeholder="2027" parents={by("phase")} />
          </Section>

          <div className="grid gap-4 xl:grid-cols-2">
            <Section id="okr" title="Çeyreklik OKR'ler" eyebrow={`Bu çeyrek: ${quarter.key}`}>
              {quarterly.length === 0 ? <Empty icon="strategy">Çeyreklik OKR yok.</Empty> : <div className="space-y-3">{quarterly.map((x) => <ItemCard key={x.id} item={x} compact />)}</div>}
              <AddForm level="quarterly" label="Çeyreklik OKR ekle" periodHint="YYYY-Q1..Q4" placeholder="2027-Q2" parents={annual} />
            </Section>
            <Section id="monthly" title="Aylık kampanya planı" eyebrow="Doğrulanmış takvim tarihleriyle">
              {monthly.length === 0 ? <Empty icon="calendar">Aylık plan yok.</Empty> : <div className="space-y-3">{monthly.map((x) => <ItemCard key={x.id} item={x} compact />)}</div>}
              <AddForm level="monthly" label="Aylık kampanya planı ekle" periodHint="YYYY-AA" placeholder="2027-02" parents={quarterly} />
            </Section>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Section id="weekly" title="Haftalık uygulama" eyebrow={`${week.key} · ${week.start} → ${week.end}`} href="/gorevler" linkLabel="Görev panosu">
              {weekly.length > 0 && <div className="mb-4 space-y-3">{weekly.map((x) => <ItemCard key={x.id} item={x} compact />)}</div>}
              <div className="label">Bu hafta güncellenen görevler (görev motoru)</div>
              {weekTasks.length === 0 ? <p className="text-sm text-muted">Bu hafta görev hareketi yok.</p> : (
                <ul className="divide-y divide-line text-sm">{weekTasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-2"><Link href={`/gorevler/${t.id}`} className="min-w-0 truncate hover:text-brand">{t.title}<span className="block text-xs text-muted">{agentName(t.agent as never)}</span></Link><Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABEL[t.status]}</Badge></li>
                ))}</ul>
              )}
              <AddForm level="weekly" label="Haftalık uygulama kalemi ekle" periodHint="o haftadan bir tarih" placeholder={today} parents={monthly} />
            </Section>

            <Section id="daily" title="Günlük istihbarat izleme" eyebrow="Pazar İstihbaratı Uzmanı" href="/pr-ajansi/istihbarat">
              {dailyBrief ? (
                <div className="text-sm"><div className="text-xs text-muted">{dt(dailyBrief.created_at)}</div><Link href={`/taslaklar/${dailyBrief.id}`} className="mt-1 block font-medium hover:text-brand">{dailyBrief.title}</Link>{dailyBrief.content?.dataStatusNote && <p className="mt-1 text-xs text-muted">{dailyBrief.content.dataStatusNote}</p>}</div>
              ) : <Empty icon="radar">Henüz günlük özet yok. Zamanlamayı Otomasyon sayfasından açın.</Empty>}
              <div className="label mt-4">Son zamanlanmış operasyonlar</div>
              {runs.length === 0 ? <p className="text-sm text-muted">Kayıt yok.</p> : (
                <ul className="space-y-1.5 text-xs">{runs.slice(0, 6).map((r) => <li key={r.id} className="flex items-center justify-between gap-2"><span className="truncate">{r.operation} · {r.period_key}</span><Badge tone={r.stage === "completed" ? "ok" : r.stage === "failed" ? "bad" : "warn"}>{r.stage === "completed" ? "Kanıtlı" : r.stage === "failed" ? "Hata" : r.stage}</Badge></li>)}</ul>
              )}
            </Section>

            <Section id="reviews" title="Performans incelemeleri ve ayarlamalar" eyebrow="Çeyreklik · yıllık">
              {reviews.length === 0 ? <p className="text-sm text-muted">Henüz inceleme raporu yok. Çeyreklik ve yıllık incelemeler zamanlama açıkken otomatik hazırlanır (onay kuyruğuna düşer).</p> : (
                <ul className="space-y-2 text-sm">{reviews.map((r) => <li key={r.id}><Link href={`/taslaklar/${r.id}`} className="font-medium hover:text-brand">{r.title}</Link><div className="text-xs text-muted">{dt(r.created_at)} · {r.approval ?? "onay bekliyor"}</div></li>)}</ul>
              )}
              <div className="label mt-4">Stratejik ayarlama geçmişi</div>
              {revisions.length === 0 ? <p className="text-sm text-muted">Değişiklik yok.</p> : (
                <ul className="space-y-2 text-xs">{revisions.map((r) => <li key={r.id}><a href={`#${r.item_id}`} className="font-medium text-ink-soft hover:text-brand">{r.title}</a><div className="text-muted">{dt(r.created_at)} · {r.changed_by === "user" ? "Sahip" : r.changed_by}{r.reason ? ` — ${r.reason}` : ""}</div></li>)}</ul>
              )}
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}
