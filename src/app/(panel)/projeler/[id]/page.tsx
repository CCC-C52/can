import { FAILURE_ACTION, type FailureClass } from "@/lib/orchestrator/engine";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireBrand, flash, type SP } from "@/lib/current";
import { getProject, listTasks } from "@/lib/orchestrator/projects";
import { listOutputs } from "@/lib/services/outputs";
import { q } from "@/lib/db/pool";
import { Badge, DemoBadge, Flash, PageHeader, dt, usd } from "@/components/ui";
import { AutoRefresh, SubmitButton } from "@/components/client";
import { PROJECT_STATUS_LABEL, TASK_STATUS_LABEL, TASK_STATUS_TONE } from "@/lib/labels";
import { agentName } from "@/lib/agents/registry";
import { cancelProjectAction } from "@/app/actions";

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const project = await getProject(brand.id, id);
  if (!project) notFound();
  const [tasks, outputs, costs] = await Promise.all([
    listTasks(brand.id, { projectId: id }),
    listOutputs(brand.id, { projectId: id }),
    q<{ kind: string; total: number | null; unknown: number }>(`SELECT kind, SUM(amount_usd) AS total, COUNT(*) FILTER (WHERE amount_usd IS NULL)::int AS unknown FROM cost_entries WHERE project_id = $1 GROUP BY kind`, [id]),
  ]);
  const ordered = [...tasks].reverse();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const running = tasks.some((t) => ["planned", "ready", "running", "review_pending"].includes(t.status));
  const report = project.report;
  const cost = (k: string) => costs.find((c) => c.kind === k);
  return (
    <div>
      <PageHeader
        title={project.title}
        subtitle={<>Durum: {PROJECT_STATUS_LABEL[project.status] ?? project.status} · {dt(project.created_at)} · model çağrısı: {project.model_calls}</>}
        actions={<>
          <AutoRefresh active={running} />
          {running && (
            <form action={cancelProjectAction}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="back" value={`/projeler/${id}`} /><SubmitButton className="btn-danger" confirm="Projedeki tüm açık görevler iptal edilsin mi?">Projeyi iptal et</SubmitButton></form>
          )}
        </>}
      />
      <Flash ok={ok} err={err} />
      <div className="card mb-4"><div className="label">Talimat</div><p className="whitespace-pre-wrap text-sm">{project.instruction}</p></div>

      {report && (
        <section className="card mb-4">
          <h2 className="h2">Yönetici raporu {report.mode === "demo" && <DemoBadge />}</h2>
          <p className="mt-1 text-sm font-medium">{report.headline}</p>
          <p className="muted mt-1">{report.summary}</p>
          <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
            {[["Tamamlanan", report.completed], ["Onay bekleyen", report.pending_approvals], ["Bağlantı bekleyen", report.missing_connections], ["Sorunlar", report.problems], ["Sonraki adımlar", report.next_steps]].map(([label, items]) => (
              (items as string[]).length ? <div key={label as string}><div className="label">{label as string}</div><ul className="list-disc space-y-1 pl-5">{(items as string[]).map((x) => <li key={x}>{x}</li>)}</ul></div> : null
            ))}
          </div>
        </section>
      )}

      <section className="card mb-4">
        <h2 className="h2 mb-2">Görevler ve bağımlılıklar</h2>
        <div tabIndex={0} className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Görev</th><th>Uzman</th><th>Durum</th><th>Önce</th><th>Maliyet (gerçekleşen)</th></tr></thead>
            <tbody>
              {ordered.map((t) => (
                <tr key={t.id}>
                  <td><Link className="text-brand" href={`/gorevler/${t.id}`}>{t.title}</Link>{t.error && <div className={`mt-1 max-w-md text-xs ${t.status === "ready" ? "text-muted" : "text-red-700"}`}>{t.error}</div>}{t.failure_class && FAILURE_ACTION[t.failure_class as FailureClass] && <div className="mt-1 max-w-md text-xs text-amber-800">{FAILURE_ACTION[t.failure_class as FailureClass].label}: {FAILURE_ACTION[t.failure_class as FailureClass].action}</div>}</td>
                  <td className="whitespace-nowrap">{agentName(t.agent)}</td>
                  <td><Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABEL[t.status]}</Badge></td>
                  <td className="text-xs text-muted">{t.depends_on.map((d) => byId.get(d)?.key).filter(Boolean).join(", ") || "—"}</td>
                  <td className="whitespace-nowrap">{t.cost_unknown ? "Bilinmiyor" : usd(t.cost_actual_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">Proje maliyeti — tahmini: {usd(cost("estimated")?.total)} · gerçekleşen: {usd(cost("actual")?.total)}{(cost("actual")?.unknown ?? 0) > 0 ? ` · ${cost("actual")!.unknown} bilinmeyen kayıt` : ""}</p>
      </section>

      <section className="card">
        <h2 className="h2 mb-2">Çıktılar</h2>
        <ul className="divide-y divide-line">
          {outputs.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <Link className="font-medium text-brand" href={`/taslaklar/${o.id}`}>{o.title}</Link>
              <span className="flex gap-1">
                {o.is_demo && <DemoBadge />}
                <Badge>{agentName(o.agent)}</Badge>
                {o.verdict && <Badge tone={o.verdict === "pass" ? "ok" : "bad"}>QA: {o.verdict}</Badge>}
                {o.approval && <Badge tone={o.approval === "approved" ? "ok" : "bad"}>{o.approval === "approved" ? "Onaylı" : "Reddedildi"}</Badge>}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
