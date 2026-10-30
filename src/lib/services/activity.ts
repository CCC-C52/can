import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { agentName } from "@/lib/agents/registry";
import { TASK_STATUS_LABEL, type TaskStatus } from "@/lib/labels";

/** Sesli uyarı verilen bitiş durumları (iptal, bağımlılık zinciri gürültüsü olduğu için dahil değil). */
export const ALERT_STATUSES = ["approval_pending", "completed", "failed", "waiting_connection"] as const;
/** Sorgu ile bitişin kaydı arasındaki yarış için örtüşme; istemci tekrarları kimlikle ayıklar. */
const OVERLAP_MS = 5_000;

export type TaskAlert = { id: string; title: string; agent: string; status: string; label: string; ok: boolean; finished_at: string; project_id: string };

/**
 * Panel sesli uyarısı: seçili markada `since` sonrasında biten görevler. `since` yoksa yalnızca sunucu saati döner
 * (ilk açılışta geçmiş görevler için ses çalınmaz).
 */
export async function finishedTasksSince(brandId: string, since: string | null, db: Queryable = getPool()) {
  const now = (await q1<{ now: string }>(`SELECT now() AS now`, [], db))!.now;
  if (!since || Number.isNaN(Date.parse(since))) return { now, events: [] as TaskAlert[] };
  const rows = await q<{ id: string; title: string; agent: string; status: TaskStatus; finished_at: string; project_id: string }>(
    `SELECT id, title, agent, status, finished_at, project_id FROM tasks
     WHERE brand_id = $1 AND status = ANY($2::text[]) AND finished_at > $3::timestamptz - ($4 || ' milliseconds')::interval
     ORDER BY finished_at LIMIT 20`,
    [brandId, [...ALERT_STATUSES], since, String(OVERLAP_MS)],
    db,
  );
  const events = rows.map((r) => ({
    id: r.id, title: r.title, agent: agentName(r.agent), status: r.status, label: TASK_STATUS_LABEL[r.status] ?? r.status,
    ok: r.status === "approval_pending" || r.status === "completed", finished_at: new Date(r.finished_at).toISOString(), project_id: r.project_id,
  }));
  return { now, events };
}
