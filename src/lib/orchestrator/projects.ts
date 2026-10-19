import { q, q1, tx, type Queryable, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { getLimits, setSetting } from "@/lib/settings";
import type { TaskStatus } from "@/lib/labels";

export type Project = {
  id: string;
  brand_id: string;
  title: string;
  instruction: string;
  status: string;
  idempotency_key: string;
  model_calls: number;
  report: any;
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: string;
  brand_id: string;
  project_id: string;
  key: string;
  agent: string;
  kind: string;
  title: string;
  instruction: string;
  status: TaskStatus;
  phase: "generate" | "review";
  dep_mode: "completed" | "settled";
  requires_approval: boolean;
  requires_capability: string | null;
  input_refs: any;
  output_id: string | null;
  model: string | null;
  service: string | null;
  attempts: number;
  max_attempts: number;
  regen_count: number;
  feedback: string | null;
  error: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  cost_estimated_usd: number | null;
  cost_actual_usd: number | null;
  cost_unknown: boolean;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export class InputError extends Error {}

/**
 * Kullanıcı talimatı → proje + yönetici planlama görevi.
 * Aynı idempotency anahtarıyla tekrar gönderilirse yeni proje oluşturulmaz.
 */
export async function submitInstruction(args: { brandId: string; instruction: string; idempotencyKey: string }) {
  const instruction = args.instruction.trim();
  if (!instruction) throw new InputError("Talimat boş olamaz.");
  if (instruction.length > 8000) throw new InputError("Talimat çok uzun (en fazla 8000 karakter).");
  if (!args.idempotencyKey || args.idempotencyKey.length < 8) throw new InputError("Geçersiz istek anahtarı.");
  return tx(async (c) => {
    const brand = await q1(`SELECT 1 FROM brands WHERE id = $1`, [args.brandId], c);
    if (!brand) throw new InputError("Marka bulunamadı.");
    const title = instruction.split("\n")[0].slice(0, 90);
    const inserted = await q1<Project>(
      `INSERT INTO projects (brand_id, title, instruction, idempotency_key) VALUES ($1,$2,$3,$4)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [args.brandId, title, instruction, args.idempotencyKey],
      c,
    );
    if (!inserted) {
      const existing = await q1<Project>(`SELECT * FROM projects WHERE idempotency_key = $1`, [args.idempotencyKey], c);
      if (!existing || existing.brand_id !== args.brandId) throw new InputError("İstek anahtarı çakışması.");
      return { project: existing, duplicate: true };
    }
    await q(`INSERT INTO chat_messages (brand_id, project_id, role, content) VALUES ($1,$2,'user',$3)`, [args.brandId, inserted.id, instruction], c);
    const limits = await getLimits(c);
    await q(
      `INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status, max_attempts)
       VALUES ($1,$2,'plan','manager','plan','Talimatı planla',$3,'ready',$4)`,
      [args.brandId, inserted.id, instruction, limits.maxAttempts],
      c,
    );
    await audit({ brandId: args.brandId, projectId: inserted.id, actor: "user", action: "project.create", message: `Yeni talimat: ${title}` }, c);
    return { project: inserted, duplicate: false };
  });
}

export async function getProject(brandId: string, id: string, db: Queryable = getPool()) {
  return q1<Project>(`SELECT * FROM projects WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
}

export async function listProjects(brandId: string, limit = 50, db: Queryable = getPool()) {
  return q<Project & { task_count: number; done_count: number }>(
    `SELECT p.*, (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id) AS task_count,
       (SELECT COUNT(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed') AS done_count
     FROM projects p WHERE p.brand_id = $1 ORDER BY p.created_at DESC LIMIT $2`,
    [brandId, limit],
    db,
  );
}

export async function listTasks(brandId: string, f: { projectId?: string; status?: string } = {}, db: Queryable = getPool()) {
  return q<Task & { project_title: string; depends_on: string[] }>(
    `SELECT t.*, p.title AS project_title,
       COALESCE((SELECT array_agg(d.depends_on_task_id) FROM task_dependencies d WHERE d.task_id = t.id), '{}') AS depends_on
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.brand_id = $1 AND ($2::uuid IS NULL OR t.project_id = $2) AND ($3::text IS NULL OR t.status = $3)
     ORDER BY t.created_at DESC LIMIT 300`,
    [brandId, f.projectId ?? null, f.status ?? null],
    db,
  );
}

export async function getTask(brandId: string, id: string, db: Queryable = getPool()) {
  return q1<Task>(`SELECT * FROM tasks WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
}

export async function taskAttempts(taskId: string) {
  return q<{ attempt: number; phase: string; outcome: string | null; error: string | null; started_at: string; finished_at: string | null; worker_id: string | null }>(
    `SELECT attempt, phase, outcome, error, started_at, finished_at, worker_id FROM task_attempts WHERE task_id = $1 ORDER BY started_at DESC`,
    [taskId],
  );
}

export async function cancelTask(brandId: string, taskId: string, reason = "Kullanıcı iptal etti") {
  const row = await q1<Task>(
    `UPDATE tasks SET status = 'cancelled', error = $3, lease_owner = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now()
     WHERE id = $1 AND brand_id = $2 AND status NOT IN ('completed','cancelled') RETURNING *`,
    [taskId, brandId, reason],
  );
  if (row) await audit({ brandId, projectId: row.project_id, taskId, actor: "user", action: "task.cancel", message: `Görev iptal edildi: ${row.title}` });
  return row;
}

export async function cancelProject(brandId: string, projectId: string) {
  const rows = await q<Task>(
    `UPDATE tasks SET status = 'cancelled', error = 'Proje iptal edildi', lease_owner = NULL, finished_at = now(), updated_at = now()
     WHERE project_id = $1 AND brand_id = $2 AND status NOT IN ('completed','cancelled','failed') RETURNING *`,
    [projectId, brandId],
  );
  await q(`UPDATE projects SET status = 'cancelled', updated_at = now() WHERE id = $1 AND brand_id = $2`, [projectId, brandId]);
  await audit({ brandId, projectId, actor: "user", action: "project.cancel", message: `Proje iptal edildi (${rows.length} görev durduruldu)` });
}

/** Başarısız/iptal/bağlantı bekleyen görevi tekrar kuyruğa alır; bağımlı iptal edilmiş görevleri de geri planlar. */
export async function retryTask(brandId: string, taskId: string) {
  return tx(async (c) => {
    const t = await q1<Task>(`SELECT * FROM tasks WHERE id = $1 AND brand_id = $2 FOR UPDATE`, [taskId, brandId], c);
    if (!t) throw new InputError("Görev bulunamadı.");
    if (!["failed", "cancelled", "waiting_connection"].includes(t.status)) throw new InputError("Yalnızca başarısız, iptal edilmiş veya bağlantı bekleyen görevler tekrar denenebilir.");
    await q(
      `UPDATE tasks SET status = 'planned', phase = CASE WHEN output_id IS NULL THEN 'generate' ELSE phase END, attempts = 0, error = NULL,
         next_attempt_at = NULL, finished_at = NULL, updated_at = now() WHERE id = $1`,
      [taskId],
      c,
    );
    // Bu görev yüzünden iptal edilen bağımlıları da geri al
    await q(
      `WITH RECURSIVE downstream AS (
         SELECT d.task_id FROM task_dependencies d WHERE d.depends_on_task_id = $1
         UNION SELECT d.task_id FROM task_dependencies d JOIN downstream x ON d.depends_on_task_id = x.task_id)
       UPDATE tasks SET status = 'planned', error = NULL, finished_at = NULL, updated_at = now()
       WHERE id IN (SELECT task_id FROM downstream) AND status = 'cancelled' AND error LIKE 'Bağımlılık%'`,
      [taskId],
      c,
    );
    await q(`UPDATE projects SET status = 'running', updated_at = now() WHERE id = $1 AND status IN ('failed','needs_attention','completed','cancelled')`, [t.project_id], c);
    await audit({ brandId, projectId: t.project_id, taskId, actor: "user", action: "task.retry", message: `Görev tekrar kuyruğa alındı: ${t.title}` }, c);
  });
}

/** Kullanıcının bir çıktı için yeniden üretim istemesi (sınırlı). */
export async function requestRegeneration(brandId: string, outputId: string, feedback: string) {
  return tx(async (c) => {
    const o = await q1<{ task_id: string | null; title: string }>(`SELECT task_id, title FROM outputs WHERE id = $1 AND brand_id = $2`, [outputId, brandId], c);
    if (!o?.task_id) throw new InputError("Bu çıktı bir görevden üretilmedi; yeniden üretilemez.");
    const t = await q1<Task>(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [o.task_id], c);
    if (!t) throw new InputError("Görev bulunamadı.");
    if (["running", "ready", "review_pending"].includes(t.status)) throw new InputError("Görev zaten çalışıyor.");
    const limits = await getLimits(c);
    if (t.regen_count >= limits.maxRegenerations) throw new InputError(`Yeniden üretim sınırına ulaşıldı (${limits.maxRegenerations}).`);
    await q(
      `UPDATE tasks SET status = 'ready', phase = 'generate', regen_count = regen_count + 1, attempts = 0, feedback = $2, error = NULL,
         finished_at = NULL, updated_at = now() WHERE id = $1`,
      [t.id, feedback.trim() || "Kullanıcı yeniden üretim istedi."],
      c,
    );
    await q(`UPDATE projects SET status = 'running', updated_at = now() WHERE id = $1`, [t.project_id], c);
    await audit({ brandId, projectId: t.project_id, taskId: t.id, actor: "user", action: "task.regenerate", message: `Yeniden üretim istendi: ${o.title}${feedback ? ` — ${feedback.slice(0, 120)}` : ""}` }, c);
  });
}

/** Tüm işlemleri durdur / devam ettir. İşleyici çalışan görevleri iptal sinyaliyle durdurur ve kuyruğa geri alır. */
export async function setPaused(paused: boolean) {
  await setSetting("paused", paused);
  await audit({ actor: "user", action: paused ? "system.pause" : "system.resume", message: paused ? "Tüm işlemler durduruldu" : "İşlemler devam ettirildi" });
}

export async function retryWaitingConnections(brandId: string) {
  const rows = await q<Task>(
    `UPDATE tasks SET status = 'planned', error = NULL, updated_at = now() WHERE brand_id = $1 AND status = 'waiting_connection' RETURNING *`,
    [brandId],
  );
  if (rows.length) await audit({ brandId, actor: "user", action: "task.retry_waiting", message: `${rows.length} bağlantı bekleyen görev tekrar planlandı` });
  return rows.length;
}

export async function chatHistory(brandId: string, limit = 100) {
  return q<{ id: string; role: string; content: string; project_id: string | null; data: any; created_at: string }>(
    `SELECT * FROM (SELECT * FROM chat_messages WHERE brand_id = $1 ORDER BY created_at DESC LIMIT $2) x ORDER BY created_at`,
    [brandId, limit],
  );
}
