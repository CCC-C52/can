import Link from "next/link";
import { getCurrentBrand, flash, type SP } from "@/lib/current";
import { q, q1 } from "@/lib/db/pool";
import { TASK_STATUS_LABEL, TASK_STATUS_TONE, CONNECTION_STATUS_LABEL, CONNECTION_STATUS_TONE, PROJECT_STATUS_LABEL, type TaskStatus } from "@/lib/labels";
import { Badge, Empty, Flash, PageHeader, Stat, dt, usd } from "@/components/ui";
import { AutoRefresh, SubmitButton } from "@/components/client";
import { PROVIDERS, effectiveStatus } from "@/lib/services/connections";
import { pendingApprovals } from "@/lib/services/outputs";
import { todaysAiSpend } from "@/lib/services/costs";
import { getLimits, isPaused } from "@/lib/settings";
import { agentName } from "@/lib/agents/registry";
import { pauseAction } from "@/app/actions";

export default async function Dashboard({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const { brand } = await getCurrentBrand();
  if (!brand) return null;
  const [active, approvals, statuses, today, limits, paused, brandCost, projects, unknownActions, worker] = await Promise.all([
    q<{ id: string; title: string; agent: string; status: TaskStatus; project_id: string; project_title: string; updated_at: string }>(
      `SELECT t.id, t.title, t.agent, t.status, t.project_id, p.title AS project_title, t.updated_at FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.brand_id = $1 AND t.status IN ('running','ready','review_pending','planned') ORDER BY t.updated_at DESC LIMIT 12`, [brand.id]),
    pendingApprovals(brand.id),
    Promise.all(PROVIDERS.map(async (p) => ({ p, s: await effectiveStatus(p.id, brand.id) }))),
    todaysAiSpend(),
    getLimits(),
    isPaused(),
    q1<{ est: number | null; act: number | null; unknown: number }>(
      `SELECT SUM(amount_usd) FILTER (WHERE kind='estimated') AS est, SUM(amount_usd) FILTER (WHERE kind='actual') AS act, COUNT(*) FILTER (WHERE amount_usd IS NULL)::int AS unknown
       FROM cost_entries WHERE brand_id = $1 AND category = 'ai_generation' AND created_at > now() - interval '30 days'`, [brand.id]),
    q<{ id: string; title: string; status: string; created_at: string }>(`SELECT id, title, status, created_at FROM projects WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 5`, [brand.id]),
    q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM external_actions WHERE brand_id = $1 AND status = 'unknown'`, [brand.id]),
    q1<{ last_seen: string }>(`SELECT last_seen FROM worker_heartbeats ORDER BY last_seen DESC LIMIT 1`),
  ]);
  const problems = statuses.filter((x) => ["error", "reauth_required"].includes(x.s.status));
  const waiting = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE brand_id = $1 AND status = 'waiting_connection'`, [brand.id]);
  const failed = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE brand_id = $1 AND status = 'failed' AND updated_at > now() - interval '7 days'`, [brand.id]);
  const workerAlive = worker && Date.now() - new Date(worker.last_seen).getTime() < 30_000;

  return (
    <div>
      <PageHeader
        title={brand.name}
        subtitle={<>Ana ekran {brand.is_sample && <Badge tone="demo">ÖRNEK MARKA</Badge>}</>}
        actions={
          <>
            <AutoRefresh active={active.length > 0} />
            <Link href="/sohbet" className="btn-primary">Yöneticiye talimat ver</Link>
            <form action={pauseAction}>
              <input type="hidden" name="paused" value={paused ? "false" : "true"} />
              <SubmitButton className={paused ? "btn" : "btn-danger"} confirm={paused ? undefined : "Tüm işlemler durdurulsun mu?"}>{paused ? "Devam ettir" : "Tüm işlemleri durdur"}</SubmitButton>
            </form>
          </>
        }
      />
      <Flash ok={ok} err={err} />
      {!workerAlive && (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
          Görev işleyicisi çalışmıyor görünüyor{worker ? ` (son sinyal: ${dt(worker.last_seen)})` : ""}. Görevler kayıtlı kalır ancak işlenmez. Başlatmak için: <code className="rounded bg-white px-1">npm run worker</code>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Çalışan / bekleyen işler" value={active.length} href="/gorevler" />
        <Stat label="Bekleyen onaylar" value={approvals.length} tone={approvals.length ? "warn" : undefined} href="/onaylar" />
        <Stat label="Bağlantı sorunları" value={problems.length + (waiting?.n ?? 0)} hint={`${problems.length} hata · ${waiting?.n ?? 0} bağlantı bekleyen görev`} tone={problems.length ? "bad" : waiting?.n ? "warn" : undefined} href="/entegrasyonlar" />
        <Stat label="Bugünkü AI harcaması (tüm markalar)" value={usd(today.actual)} hint={`Günlük sınır: ${limits.dailyBudgetUsd === null ? "yok" : usd(limits.dailyBudgetUsd, 2)}${today.unknownCount ? ` · ${today.unknownCount} bilinmeyen kayıt` : ""}`} href="/raporlar" />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section className="card">
          <div className="mb-3 flex items-center justify-between"><h2 className="h2">Çalışan işler</h2><Link href="/gorevler" className="text-sm text-brand">Tümü</Link></div>
          {active.length === 0 ? <Empty>Şu an çalışan iş yok.</Empty> : (
            <ul className="divide-y divide-line">
              {active.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <Link href={`/gorevler/${t.id}`} className="min-w-0"><div className="truncate font-medium">{t.title}</div><div className="truncate text-xs text-muted">{agentName(t.agent)} · {t.project_title}</div></Link>
                  <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABEL[t.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <div className="mb-3 flex items-center justify-between"><h2 className="h2">Bekleyen onaylar</h2><Link href="/onaylar" className="text-sm text-brand">Onay merkezi</Link></div>
          {approvals.length === 0 ? <Empty>Onay bekleyen çıktı yok.</Empty> : (
            <ul className="divide-y divide-line">
              {approvals.slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <Link href={`/taslaklar/${a.id}`} className="truncate font-medium">{a.title} <span className="text-xs text-muted">v{a.version}</span></Link>
                  <span className="flex gap-1">{a.is_demo && <Badge tone="demo">DEMO</Badge>}{a.task_status === "approval_pending" && <Badge tone="warn">Dış işlem önerisi</Badge>}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <div className="mb-3 flex items-center justify-between"><h2 className="h2">Bağlantılar</h2><Link href="/entegrasyonlar" className="text-sm text-brand">Yönet</Link></div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {statuses.map(({ p, s }) => (
              <li key={p.id} className="flex items-center justify-between gap-2 text-sm"><span className="truncate">{p.name}</span><Badge tone={CONNECTION_STATUS_TONE[s.status]}>{CONNECTION_STATUS_LABEL[s.status]}</Badge></li>
            ))}
          </ul>
          {(failed?.n ?? 0) > 0 && <p className="mt-3 text-sm text-red-700">Son 7 günde {failed!.n} görev başarısız oldu. <Link className="underline" href="/gorevler?status=failed">İncele</Link></p>}
          {(unknownActions?.n ?? 0) > 0 && <p className="mt-2 text-sm text-amber-800">{unknownActions!.n} dış işlemin sonucu belirsiz — <Link className="underline" href="/onaylar">kontrol edin</Link>.</p>}
        </section>
        <section className="card">
          <div className="mb-3 flex items-center justify-between"><h2 className="h2">Maliyet özeti (son 30 gün, bu marka)</h2><Link href="/raporlar" className="text-sm text-brand">Raporlar</Link></div>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div><dt className="text-xs text-muted">Tahmini (üst sınır)</dt><dd className="font-semibold">{usd(brandCost?.est)}</dd></div>
            <div><dt className="text-xs text-muted">Gerçekleşen</dt><dd className="font-semibold">{usd(brandCost?.act)}</dd></div>
            <div><dt className="text-xs text-muted">Bilinmeyen kayıt</dt><dd className="font-semibold">{brandCost?.unknown ?? 0}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-muted">Reklam harcaması ayrı izlenir; reklam hesabı bağlı değil.</p>
          <h3 className="mt-4 text-sm font-medium">Son projeler</h3>
          <ul className="mt-1 divide-y divide-line text-sm">
            {projects.map((p) => (
              <li key={p.id} className="flex justify-between gap-2 py-1.5"><Link href={`/projeler/${p.id}`} className="truncate">{p.title}</Link><span className="whitespace-nowrap text-xs text-muted">{PROJECT_STATUS_LABEL[p.status] ?? p.status}</span></li>
            ))}
            {projects.length === 0 && <li className="py-2 text-muted">Henüz proje yok.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
