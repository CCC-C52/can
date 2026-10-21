import { collectDiagnostics, type Health } from "@/lib/services/diagnostics";
import { Badge, PageHeader, dt } from "@/components/ui";
import { AutoRefresh } from "@/components/client";
import { agentName } from "@/lib/agents/registry";
import { TASK_STATUS_LABEL } from "@/lib/labels";
import Link from "next/link";

export const dynamic = "force-dynamic";

const LABEL: Record<Health, string> = { ok: "Çalışıyor", degraded: "Dikkat", down: "Çalışmıyor", off: "Kapalı / bağlı değil" };
const TONE: Record<Health, "ok" | "warn" | "bad" | "neutral"> = { ok: "ok", degraded: "warn", down: "bad", off: "neutral" };

export default async function Diagnostics() {
  const d = await collectDiagnostics();
  const q = d.queues;
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
          {q ? (
            <dl className="space-y-2 text-xs">
              <div><dt className="label">Görevler</dt><dd>{Object.entries(q.tasks).map(([k, n]) => `${(TASK_STATUS_LABEL as Record<string, string>)[k] ?? k}: ${n}`).join(" · ") || "boş"}</dd></div>
              <div><dt className="label">En eski bekleyen görev</dt><dd>{q.oldest_ready_task_s === null ? "yok" : `${q.oldest_ready_task_s} sn`}</dd></div>
              <div><dt className="label">Yüklemeler</dt><dd>{Object.entries(q.uploads).map(([k, n]) => `${k}: ${n}`).join(" · ") || "boş"}</dd></div>
              <div><dt className="label">Medya analizleri</dt><dd>{Object.entries(q.analyses).map(([k, n]) => `${k}: ${n}`).join(" · ") || "boş"}</dd></div>
              <div><dt className="label">AI üretim işleri</dt><dd>{Object.entries(q.provider_jobs).map(([k, n]) => `${k}: ${n}`).join(" · ") || "boş"}</dd></div>
            </dl>
          ) : <p className="text-muted">Veritabanına ulaşılamadı.</p>}
          <h2 className="h2 pt-2">Yapılandırma</h2>
          <ul className="space-y-1 text-xs">
            <li>Mod: <strong>{d.config.appMode}</strong> · giriş {d.config.loginRequired ? "zorunlu" : "kapalı"} · DEMO {d.config.demoAllowed ? "açık" : "kapalı"}</li>
            <li>Depolama: {d.config.storageDriver} · doğrudan yükleme {d.config.uploadDirect ? "açık" : "kapalı"} · en fazla {d.config.maxUploadMb} MB</li>
            <li>Node {d.config.nodeVersion}</li>
          </ul>
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
