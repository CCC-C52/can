import { q, type Queryable, getPool } from "@/lib/db/pool";
import { redact } from "@/lib/security/crypto";

export async function audit(
  entry: { brandId?: string | null; projectId?: string | null; taskId?: string | null; actor: string; action: string; message: string; data?: unknown },
  db: Queryable = getPool(),
) {
  await q(
    `INSERT INTO audit_log (brand_id, project_id, task_id, actor, action, message, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [entry.brandId ?? null, entry.projectId ?? null, entry.taskId ?? null, entry.actor, entry.action, redact(entry.message), entry.data === undefined ? null : JSON.stringify(entry.data)],
    db,
  );
}
