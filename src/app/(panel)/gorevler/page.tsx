import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { listTasks } from "@/lib/orchestrator/projects";
import { TASK_STATUSES, TASK_STATUS_LABEL, TASK_STATUS_TONE, type TaskStatus } from "@/lib/labels";
import { agentName } from "@/lib/agents/registry";
import { Badge, Empty, Flash, PageHeader, dt } from "@/components/ui";
import { AutoRefresh, SubmitButton } from "@/components/client";
import { cancelTaskAction, retryTaskAction, pauseAction } from "@/app/actions";
import { isPaused } from "@/lib/settings";

const COLUMNS: TaskStatus[] = ["planned", "ready", "running", "review_pending", "approval_pending", "waiting_connection", "failed", "completed", "cancelled"];

export default async function TaskBoard({ searchParams }: { searchParams: SP }) {
  const { ok, err, one } = await flash(searchParams);
  const brand = await requireBrand();
  const status = one("status");
  const tasks = await listTasks(brand.id, { status: status && (TASK_STATUSES as readonly string[]).includes(status) ? status : undefined });
  const paused = await isPaused();
  const active = tasks.some((t) => ["planned", "ready", "running", "review_pending"].includes(t.status));
  const cols = status ? [status as TaskStatus] : COLUMNS;
  return (
    <div>
      <PageHeader
        title="Görev panosu"
        subtitle="Görevler veritabanında saklanır; tarayıcı kapansa veya işleyici yeniden başlasa korunur."
        actions={<>
          <AutoRefresh active={active} />
          <form action={pauseAction}><input type="hidden" name="paused" value={paused ? "false" : "true"} /><input type="hidden" name="back" value="/gorevler" /><SubmitButton className={paused ? "btn" : "btn-danger"} confirm={paused ? undefined : "Tüm işlemler durdurulsun mu?"}>{paused ? "Devam ettir" : "Tüm işlemleri durdur"}</SubmitButton></form>
        </>}
      />
      <Flash ok={ok} err={err} />
      <div className="mb-3 flex flex-wrap gap-1 text-sm">
        <Link href="/gorevler" className={`rounded-full px-3 py-1 ${!status ? "bg-ink text-white" : "bg-white ring-1 ring-line"}`}>Tümü</Link>
        {COLUMNS.map((c) => (
          <Link key={c} href={`/gorevler?status=${c}`} className={`rounded-full px-3 py-1 ${status === c ? "bg-ink text-white" : "bg-white ring-1 ring-line"}`}>{TASK_STATUS_LABEL[c]} ({tasks.filter((t) => t.status === c).length})</Link>
        ))}
      </div>
      {tasks.length === 0 ? <Empty>Görev yok. <Link className="text-brand" href="/sohbet">Ana yöneticiye talimat verin.</Link></Empty> : (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {cols.map((c) => {
            const list = tasks.filter((t) => t.status === c);
            if (!status && list.length === 0) return null;
            return (
              <div key={c} className="w-72 shrink-0">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Badge tone={TASK_STATUS_TONE[c]}>{TASK_STATUS_LABEL[c]}</Badge><span className="text-muted">{list.length}</span></div>
                <div className="space-y-2">
                  {list.map((t) => (
                    <div key={t.id} className="card p-3">
                      <Link href={`/gorevler/${t.id}`} className="block text-sm font-medium hover:text-brand">{t.title}</Link>
                      <div className="mt-1 text-xs text-muted">{agentName(t.agent)} · {t.kind === "render" ? "dosya üretimi" : t.kind === "plan" ? "planlama" : t.kind === "report" ? "rapor" : t.phase === "review" ? "kalite kontrol" : "üretim"}</div>
                      <Link href={`/projeler/${t.project_id}`} className="mt-1 block truncate text-xs text-muted hover:underline">{t.project_title}</Link>
                      {t.error && <p className="mt-1 line-clamp-3 text-xs text-red-700">{t.error}</p>}
                      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted">
                        <span>{dt(t.updated_at)} · deneme {t.attempts}/{t.max_attempts}{t.regen_count ? ` · yeniden üretim ${t.regen_count}` : ""}</span>
                      </div>
                      <div className="mt-2 flex gap-2">
                        {["failed", "cancelled", "waiting_connection"].includes(t.status) && (
                          <form action={retryTaskAction}><input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="back" value="/gorevler" /><SubmitButton className="btn px-2 py-1 text-xs">Tekrar dene</SubmitButton></form>
                        )}
                        {!["completed", "cancelled"].includes(t.status) && (
                          <form action={cancelTaskAction}><input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="back" value="/gorevler" /><SubmitButton className="btn-danger px-2 py-1 text-xs" confirm="Görev iptal edilsin mi?">İptal</SubmitButton></form>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
