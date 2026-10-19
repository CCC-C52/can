import Link from "next/link";
import { notFound } from "next/navigation";
import { requireBrand, flash, type SP } from "@/lib/current";
import { getTask, taskAttempts } from "@/lib/orchestrator/projects";
import { q } from "@/lib/db/pool";
import { TASK_STATUS_LABEL, TASK_STATUS_TONE } from "@/lib/labels";
import { AGENTS, TOOLS, agentName } from "@/lib/agents/registry";
import { Badge, Flash, PageHeader, dt, usd } from "@/components/ui";
import { AutoRefresh, SubmitButton } from "@/components/client";
import { cancelTaskAction, retryTaskAction } from "@/app/actions";
import type { AgentId } from "@/lib/agents/schemas";

export default async function TaskDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const t = await getTask(brand.id, id);
  if (!t) notFound();
  const [attempts, deps, events, costs] = await Promise.all([
    taskAttempts(t.id),
    q<{ id: string; title: string; status: string; key: string }>(`SELECT u.id, u.title, u.status, u.key FROM task_dependencies d JOIN tasks u ON u.id = d.depends_on_task_id WHERE d.task_id = $1`, [t.id]),
    q<{ id: number; actor: string; message: string; created_at: string }>(`SELECT id, actor, message, created_at FROM audit_log WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50`, [t.id]),
    q<{ service: string; kind: string; amount_usd: number | null; note: string | null; created_at: string; units: any }>(`SELECT service, kind, amount_usd, note, created_at, units FROM cost_entries WHERE task_id = $1 ORDER BY created_at`, [t.id]),
  ]);
  const def = AGENTS[t.agent as AgentId];
  const back = `/gorevler/${t.id}`;
  return (
    <div>
      <PageHeader
        title={t.title}
        subtitle={<><Link className="underline" href={`/projeler/${t.project_id}`}>Projeye dön</Link> · {agentName(t.agent)} · {t.kind}</>}
        actions={<>
          <AutoRefresh active={["planned", "ready", "running", "review_pending"].includes(t.status)} />
          <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABEL[t.status]}</Badge>
          {["failed", "cancelled", "waiting_connection"].includes(t.status) && <form action={retryTaskAction}><input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="back" value={back} /><SubmitButton className="btn">Tekrar dene</SubmitButton></form>}
          {!["completed", "cancelled"].includes(t.status) && <form action={cancelTaskAction}><input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="back" value={back} /><SubmitButton className="btn-danger" confirm="İptal edilsin mi?">İptal et</SubmitButton></form>}
        </>}
      />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card lg:col-span-2">
          <div className="label">Talimat</div>
          <p className="whitespace-pre-wrap text-sm">{t.instruction}</p>
          {t.feedback && <><div className="label mt-3">Geri bildirim (yeniden üretim)</div><p className="whitespace-pre-wrap text-sm">{t.feedback}</p></>}
          {t.error && <><div className="label mt-3">Hata / not</div><p className="whitespace-pre-wrap text-sm text-red-700">{t.error}</p></>}
          {t.output_id && <Link href={`/taslaklar/${t.output_id}`} className="btn-primary mt-4">Çıktıyı aç</Link>}
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <div><dt className="label">Kimlik</dt><dd className="break-all text-xs">{t.id}</dd></div>
            <div><dt className="label">Model / servis</dt><dd>{t.model ?? "—"} {t.service ? `(${t.service})` : ""}</dd></div>
            <div><dt className="label">Denemeler</dt><dd>{t.attempts}/{t.max_attempts} · yeniden üretim {t.regen_count}</dd></div>
            <div><dt className="label">Tahmini maliyet</dt><dd>{usd(t.cost_estimated_usd)}</dd></div>
            <div><dt className="label">Gerçekleşen maliyet</dt><dd>{t.cost_unknown ? "Bilinmiyor (en az bir kayıt)" : usd(t.cost_actual_usd)}</dd></div>
            <div><dt className="label">Onay gerekli mi</dt><dd>{t.requires_approval ? "Evet (dış işlem önerisi)" : "Hayır"}</dd></div>
            <div><dt className="label">Oluşturma</dt><dd>{dt(t.created_at)}</dd></div>
            <div><dt className="label">Başlama</dt><dd>{dt(t.started_at)}</dd></div>
            <div><dt className="label">Bitiş</dt><dd>{dt(t.finished_at)}</dd></div>
          </dl>
          <div className="label mt-4">Bağımlılıklar</div>
          {deps.length ? <ul className="text-sm">{deps.map((d) => <li key={d.id}><Link className="text-brand" href={`/gorevler/${d.id}`}>{d.title}</Link> — {TASK_STATUS_LABEL[d.status as keyof typeof TASK_STATUS_LABEL]}</li>)}</ul> : <p className="muted">Yok</p>}
          {t.input_refs && Object.keys(t.input_refs).length > 0 && (<><div className="label mt-4">Girdi/çıktı referansları</div><pre className="overflow-x-auto rounded bg-gray-50 p-2 text-xs">{JSON.stringify(t.input_refs, null, 2)}</pre></>)}
        </section>
        <section className="card">
          <h2 className="h2">{def?.name ?? t.agent}</h2>
          <p className="muted mt-1">{def?.role}</p>
          <div className="label mt-3">Araç izinleri</div>
          <ul className="text-xs">{def?.tools.map((x) => <li key={x}>• {TOOLS[x]}</li>)}</ul>
          <div className="label mt-3">Teslim ölçütleri</div>
          <ul className="text-xs">{def?.acceptanceCriteria.map((x) => <li key={x}>• {x}</li>)}</ul>
        </section>
        <section className="card lg:col-span-2">
          <h2 className="h2 mb-2">Deneme ve hata kaydı</h2>
          <table className="table"><thead><tr><th>#</th><th>Aşama</th><th>Sonuç</th><th>Hata</th><th>Zaman</th></tr></thead>
            <tbody>{attempts.map((a, i) => <tr key={i}><td>{a.attempt}</td><td>{a.phase}</td><td>{a.outcome ?? "sürüyor"}</td><td className="max-w-xs text-xs text-red-700">{a.error}</td><td className="text-xs">{dt(a.started_at)}</td></tr>)}</tbody>
          </table>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Maliyet kayıtları</h2>
          <ul className="space-y-1 text-xs">{costs.map((c, i) => <li key={i}>{c.kind === "estimated" ? "Tahmini" : "Gerçekleşen"} · {c.service}: <strong>{usd(c.amount_usd)}</strong> {c.note && <span className="text-muted">({c.note})</span>}</li>)}{!costs.length && <li className="text-muted">Kayıt yok</li>}</ul>
        </section>
        <section className="card lg:col-span-3">
          <h2 className="h2 mb-2">İşlem geçmişi</h2>
          <ul className="space-y-1 text-sm">{events.map((e) => <li key={e.id}><span className="text-xs text-muted">{dt(e.created_at)} · {e.actor}</span> — {e.message}</li>)}</ul>
        </section>
      </div>
    </div>
  );
}
