import { collectDiagnostics, type Health } from "@/lib/services/diagnostics";
import { Badge, PageHeader, dt } from "@/components/ui";
import { AutoRefresh } from "@/components/client";
import { agentName } from "@/lib/agents/registry";
import { TASK_STATUS_LABEL } from "@/lib/labels";
import Link from "next/link";
import { q } from "@/lib/db/pool";
import { releaseCommit, releaseHistory, releaseApiEnabled, WORKER_LIVE_MS, type ReleaseRecord } from "@/lib/release";

const OUTCOME_LABEL: Record<ReleaseRecord["outcome"], string> = { in_progress: "Sürüyor", succeeded: "Başarılı", failed: "Başarısız", blocked: "Engellendi", rolled_back: "Geri alındı" };
const OUTCOME_TONE: Record<ReleaseRecord["outcome"], "ok" | "warn" | "bad" | "neutral"> = { in_progress: "neutral", succeeded: "ok", failed: "bad", blocked: "warn", rolled_back: "warn" };
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "bilinmiyor");

export const dynamic = "force-dynamic";

const LABEL: Record<Health, string> = { ok: "Çalışıyor", degraded: "Dikkat", down: "Çalışmıyor", off: "Kapalı / bağlı değil" };
const TONE: Record<Health, "ok" | "warn" | "bad" | "neutral"> = { ok: "ok", degraded: "warn", down: "bad", off: "neutral" };

export default async function Diagnostics() {
  const d = await collectDiagnostics();
  const queues = d.queues;
  const webCommit = releaseCommit();
  const [releases, workerCommits] = await Promise.all([
    releaseHistory(10).catch(() => [] as ReleaseRecord[]),
    q<{ last_seen: string; info: { commit?: string | null } | null }>(`SELECT last_seen, info FROM worker_heartbeats ORDER BY last_seen DESC LIMIT 5`).catch(() => []),
  ]);
  return (
    <div>
      <PageHeader
        title="Sistem durumu"
        subtitle={<span className="flex flex-wrap items-center gap-2">Genel: <Badge tone={TONE[d.overall]}>{LABEL[d.overall]}</Badge> · {dt(d.generatedAt)} · <a className="underline" href="/api/diagnostics">JSON</a></span>}
        actions={<AutoRefresh active />}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card lg:col-span-2" aria-labelledby="comp-h">
          <h2 id="comp-h" className="h2 mb-2">Bileşenler</h2>
          <ul className="divide-y divide-line text-sm">
            {d.components.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="font-medium">{c.name}</div>
                  <div className="break-words text-xs text-muted">{c.detail}{c.ms !== undefined ? ` · ${c.ms} ms` : ""}</div>
                </div>
                <Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
        <section className="card space-y-3 text-sm" aria-labelledby="q-h">
          <h2 id="q-h" className="h2">Kuyruklar</h2>
          {queues ? (
            <dl className="space-y-2 text-xs">
              <div><dt className="label">Görevler</dt><dd>{Object.entries(queues.tasks).map(([k, n]) => `${(TASK_STATUS_LABEL as Record<string, string>)[k] ?? k}: ${n}`).join(" · ") || "boş"}</dd></div>
              <div><dt className="label">En eski bekleyen görev</dt><dd>{queues.oldest_ready_task_s === null ? "yok" : `${queues.oldest_ready_task_s} sn`}</dd></div>
              <div><dt className="label">Yüklemeler</dt><dd>{Object.entries(queues.uploads).map(([k, n]) => `${k}: ${n}`).join(" · ") || "boş"}</dd></div>
              <div><dt className="label">Medya analizleri</dt><dd>{Object.entries(queues.analyses).map(([k, n]) => `${k}: ${n}`).join(" · ") || "boş"}</dd></div>
              <div><dt className="label">AI üretim işleri</dt><dd>{Object.entries(queues.provider_jobs).map(([k, n]) => `${k}: ${n}`).join(" · ") || "boş"}</dd></div>
            </dl>
          ) : <p className="text-muted">Veritabanına ulaşılamadı.</p>}
          <h2 className="h2 pt-2">Yapılandırma</h2>
          <ul className="space-y-1 text-xs">
            <li>Mod: <strong>{d.config.appMode}</strong> · giriş {d.config.loginRequired ? "zorunlu" : "kapalı"} · DEMO {d.config.demoAllowed ? "açık" : "kapalı"}</li>
            <li>Depolama: {d.config.storageDriver} · doğrudan yükleme {d.config.uploadDirect ? "açık" : "kapalı"} · en fazla {d.config.maxUploadMb} MB</li>
            <li>Node {d.config.nodeVersion}</li>
          </ul>
        </section>
        <section className="card lg:col-span-3" aria-labelledby="rel-h">
          <h2 id="rel-h" className="h2 mb-2">Sürüm ve dağıtım</h2>
          <ul className="mb-3 space-y-1 text-xs">
            <li>Web paneli commit: <code>{short(webCommit)}</code>{!webCommit && " (RENDER_GIT_COMMIT yok — yerel ortam veya bilinmiyor)"}</li>
            <li>İşleyiciler: {workerCommits.length === 0 ? "sinyal yok" : workerCommits.map((w, i) => (
              <span key={i} className="mr-2"><code>{short(w.info?.commit)}</code> {Date.now() - new Date(w.last_seen).getTime() < WORKER_LIVE_MS ? "canlı" : "eski sinyal"}</span>
            ))}</li>
            {webCommit && workerCommits[0]?.info?.commit && workerCommits[0].info.commit !== webCommit && <li className="text-amber-800">Web ve işleyici farklı commit&apos;lerde çalışıyor.</li>}
            <li>Dağıtım hattı durum ucu: {releaseApiEnabled() ? "açık (belirteçli)" : "kapalı (RELEASE_STATUS_TOKEN tanımlı değil)"}</li>
          </ul>
          {releases.length === 0 ? (
            <p className="text-xs text-muted">Otomatik dağıtım hattından henüz kayıt gelmedi. Bu sayfadaki sürüm geçmişi yalnızca hattın gerçekten bildirdiği olaylardan oluşur.</p>
          ) : (
            <div tabIndex={0} role="region" aria-label="Sürüm geçmişi" className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead><tr className="text-muted"><th className="py-1 pr-2">Başlangıç</th><th className="pr-2">Commit</th><th className="pr-2">Sonuç</th><th className="pr-2">Son adım</th><th>CI</th></tr></thead>
                <tbody>
                  {releases.map((r) => {
                    const last = r.steps[r.steps.length - 1];
                    return (
                      <tr key={r.releaseId} className="border-t border-line align-top">
                        <td className="py-1 pr-2 whitespace-nowrap">{dt(r.startedAt)}</td>
                        <td className="pr-2"><code>{short(r.sha)}</code></td>
                        <td className="pr-2"><Badge tone={OUTCOME_TONE[r.outcome]}>{OUTCOME_LABEL[r.outcome]}</Badge></td>
                        <td className="pr-2">{last ? `${last.phase}${last.detail ? ` — ${last.detail.slice(0, 160)}` : ""}` : "—"}</td>
                        <td>{r.ciUrl ? <a className="underline" href={r.ciUrl} rel="noopener noreferrer" target="_blank">çalıştırma</a> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card lg:col-span-2" aria-labelledby="dur-h">
          <h2 id="dur-h" className="h2 mb-2">Son 24 saat görev süreleri</h2>
          {d.durations.length ? (
            <div tabIndex={0} className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead><tr className="text-muted"><th className="py-1">Tür</th><th>Ajan</th><th>Deneme</th><th>Medyan</th><th>p95</th><th>Başarısız</th></tr></thead>
                <tbody>{d.durations.map((r) => <tr key={`${r.kind}-${r.agent}`} className="border-t border-line"><td className="py-1">{r.kind}</td><td>{agentName(r.agent)}</td><td>{r.n}</td><td>{r.p50_s} sn</td><td>{r.p95_s} sn</td><td>{r.failed}</td></tr>)}</tbody>
              </table>
            </div>
          ) : <p className="text-sm text-muted">Son 24 saatte tamamlanan görev denemesi yok.</p>}
        </section>
        <section className="card" aria-labelledby="fail-h">
          <h2 id="fail-h" className="h2 mb-2">Son başarısız görevler</h2>
          {d.failures.length ? (
            <ul className="space-y-2 text-xs">
              {d.failures.map((f) => (
                <li key={f.id}>
                  <Link className="font-medium text-brand underline" href={`/gorevler/${f.id}`}>{f.title}</Link> <span className="text-muted">· {f.brand_name} · {agentName(f.agent)}{f.failure_class ? ` · ${f.failure_class}` : ""}</span>
                  {f.error && <div className="break-words text-red-700">{f.error}</div>}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Başarısız görev yok.</p>}
        </section>
      </div>
    </div>
  );
}
