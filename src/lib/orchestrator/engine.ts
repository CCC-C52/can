import { q, q1, tx, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { getLimits, isPaused, type Limits } from "@/lib/settings";
import { getTextModel } from "@/lib/models";
import { ModelUnavailableError, PermanentError, TransientError, type TextModelAdapter } from "@/lib/models/types";
import { buildBrandContext, type BrandContext } from "@/lib/agents/context";
import { AGENTS, agentName, assertTool, isSpecialist, ToolPermissionError } from "@/lib/agents/registry";
import { OUTPUT_KIND, OUTPUT_SCHEMAS, PlanSchema, QaReviewSchema, type AgentId, type Plan, type ProjectReport, type QaReview, type SpecialistId } from "@/lib/agents/schemas";
import { systemPrompt, userPrompt } from "@/lib/agents/prompts";
import { mergeReviews, runRuleChecks } from "@/lib/agents/qa-rules";
import { addVersion, attachAssetsToVersion, createOutput, getCurrentVersion, setVersionQa, type OutputVersion } from "@/lib/services/outputs";
import { assertBudget, BudgetExceededError, costSummary, recordCost } from "@/lib/services/costs";
import { effectiveStatus, PROVIDERS } from "@/lib/services/connections";
import { renderDesign, renderVideo, RENDER_POLL_MS, type RenderCtx } from "./render";
import { textModelMode } from "@/lib/models";
import type { Task } from "./projects";

const LEASE_MS = 60_000;

class PausedError extends Error {}
class CancelledError extends Error {}
class TimeoutError extends TransientError {}

/** Yöneticinin karar verebilmesi için hata sınıfı. */
export type FailureClass = "transient" | "timeout" | "permanent" | "permission" | "budget" | "connection" | "quality" | "dependency" | "cancelled" | "uncertain";

export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof ToolPermissionError) return "permission";
  if (err instanceof BudgetExceededError || err instanceof ModelCallLimitError) return "budget";
  if (err instanceof ModelUnavailableError) return "connection";
  if (err instanceof TimeoutError) return "timeout";
  if (err instanceof TransientError) return "transient";
  return "permanent";
}

/** Hata sınıfına göre yöneticinin önerdiği eylem (rapor ve panelde gösterilir). */
export const FAILURE_ACTION: Record<FailureClass, { label: string; action: string; blocks: boolean }> = {
  transient: { label: "Geçici hata", action: "Güvenle tekrar denenebilir.", blocks: false },
  timeout: { label: "Süre aşımı", action: "Görev süre sınırını artırıp tekrar deneyin veya işi küçültün.", blocks: false },
  permanent: { label: "Kalıcı hata", action: "Hata kaydını inceleyin; talimatı veya verileri düzeltip tekrar deneyin.", blocks: true },
  permission: { label: "Yetki hatası", action: "Ajan izin yapılandırması hatalı; geliştiriciye bildirin. Tekrar denemek sonucu değiştirmez.", blocks: true },
  budget: { label: "Bütçe/sınır", action: "Ayarlar'dan bütçe veya model çağrısı sınırını sahip olarak artırın, sonra tekrar deneyin.", blocks: true },
  connection: { label: "Bağlantı gerekli", action: "Entegrasyonlar ekranından servisi bağlayıp 'Bağlantı bekleyenleri tekrar dene' deyin.", blocks: false },
  quality: { label: "Kalite kontrolü", action: "Çıktıyı düzenleyin veya geri bildirimle yeniden üretim isteyin.", blocks: false },
  dependency: { label: "Bağımlılık", action: "Önce başarısız olan üst görevi düzeltin; bu görev otomatik yeniden planlanır.", blocks: false },
  cancelled: { label: "İptal", action: "Gerekirse tekrar deneyin.", blocks: false },
  uncertain: { label: "Sonuç belirsiz", action: "Sağlayıcı panelinden işin işlenip ücretlendirilmediğini kontrol edin. Yeniden gönderim yeni ücret doğurabilir; karar sizin (Çıktı sayfası → Üretim işleri).", blocks: true },
};
class ModelCallLimitError extends Error {}

type RunCtx = {
  task: Task;
  signal: AbortSignal;
  limits: Limits;
  model: TextModelAdapter;
};

/**
 * Kalıcı görev motoru. Durum yalnızca veritabanında tutulur; süreç yeniden başlarsa
 * süresi dolan kiralamalar kurtarılır ve görevler kaldığı aşamadan devam eder.
 */
export class Engine {
  private inflight = new Map<string, { ctrl: AbortController; promise: Promise<void> }>();

  constructor(readonly workerId: string) {}

  get activeCount() {
    return this.inflight.size;
  }

  async heartbeat() {
    await q(
      `INSERT INTO worker_heartbeats (worker_id, started_at, last_seen, info) VALUES ($1, now(), now(), $2)
       ON CONFLICT (worker_id) DO UPDATE SET last_seen = now(), info = EXCLUDED.info`,
      [this.workerId, JSON.stringify({ active: this.inflight.size, pid: process.pid })],
    );
  }

  /** Bir döngü: kurtarma → (duraklatılmadıysa) hazırlama → görev alma → başlatma. */
  async tick(): Promise<number> {
    await this.heartbeat();
    await recoverExpiredLeases();
    if (await isPaused()) {
      for (const [, f] of this.inflight) f.ctrl.abort(new PausedError("Duraklatıldı"));
      return 0;
    }
    await promotePlanned();
    const limits = await getLimits();
    const claimed = await claimTasks(this.workerId, limits);
    for (const task of claimed) {
      const ctrl = new AbortController();
      const promise = this.run(task, ctrl, limits).finally(() => this.inflight.delete(task.id));
      this.inflight.set(task.id, { ctrl, promise });
    }
    return claimed.length;
  }

  async waitInflight() {
    await Promise.allSettled([...this.inflight.values()].map((f) => f.promise));
  }

  /** Kapatma: çalışan görevleri durdurur ve kiralamaları bırakır (görevler kuyruğa döner). */
  async shutdown() {
    for (const [, f] of this.inflight) f.ctrl.abort(new PausedError("İşleyici kapanıyor"));
    await this.waitInflight();
    await q(`DELETE FROM worker_heartbeats WHERE worker_id = $1`, [this.workerId]);
  }

  private async run(task: Task, ctrl: AbortController, limits: Limits) {
    const attempt = await q1<{ id: string }>(
      `INSERT INTO task_attempts (task_id, attempt, phase, worker_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [task.id, task.attempts, task.phase, this.workerId],
    );
    const timeout = setTimeout(() => ctrl.abort(new TimeoutError(`Görev süre sınırını aştı (${Math.round(limits.taskTimeoutMs / 1000)} sn)`)), limits.taskTimeoutMs);
    const renew = setInterval(async () => {
      try {
        const r = await q1<{ status: string }>(
          `UPDATE tasks SET lease_expires_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1 AND lease_owner = $2 RETURNING status`,
          [task.id, this.workerId, String(LEASE_MS)],
        );
        if (!r || r.status !== "running") ctrl.abort(new CancelledError("Görev iptal edildi"));
      } catch {
        /* bir sonraki denemede */
      }
    }, 10_000);
    let outcome = "succeeded";
    let errMsg: string | null = null;
    try {
      const ctx: RunCtx = { task, signal: ctrl.signal, limits, model: getTextModel() };
      await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: `agent:${task.agent}`, action: "task.start", message: `${agentName(task.agent)} başladı: ${task.title}${task.phase === "review" ? " (kalite kontrol)" : ""}` });
      if (task.kind === "plan") await runPlan(ctx, this.workerId);
      else if (task.kind === "report") await runReport(ctx, this.workerId);
      else if (task.kind === "render") await runRender(ctx, this.workerId);
      else if (task.phase === "review") await runReview(ctx, this.workerId);
      else await runGenerate(ctx, this.workerId);
    } catch (e) {
      const reason = ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason : e;
      const err = reason as Error;
      errMsg = err.message;
      if (err instanceof PausedError) {
        outcome = "paused";
        await q(
          `UPDATE tasks SET status = CASE WHEN phase = 'review' THEN 'review_pending' ELSE 'ready' END, attempts = GREATEST(attempts - 1, 0),
             lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
          [task.id, this.workerId],
        );
      } else if (err instanceof CancelledError) {
        outcome = "cancelled";
      } else if (err instanceof ModelUnavailableError) {
        outcome = "waiting_connection";
        await finish(task, this.workerId, { status: "waiting_connection", error: err.message, failureClass: "connection" }).catch(() => {});
      } else if (err instanceof TransientError && task.attempts < task.max_attempts) {
        outcome = "retry";
        const backoff = Math.min(60_000, 2 ** task.attempts * 2000);
        await q(
          `UPDATE tasks SET status = CASE WHEN phase = 'review' THEN 'review_pending' ELSE 'ready' END, error = $3, next_attempt_at = now() + ($4 || ' milliseconds')::interval,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
          [task.id, this.workerId, `Geçici hata (deneme ${task.attempts}/${task.max_attempts}): ${err.message}`, String(backoff)],
        );
      } else {
        outcome = err instanceof BudgetExceededError ? "budget_blocked" : "failed";
        const prefix = err instanceof BudgetExceededError ? "Bütçe sınırı: " : err instanceof ModelCallLimitError ? "Model çağrısı sınırı: " : err instanceof TransientError ? `Deneme sınırı doldu (${task.max_attempts}): ` : "";
        await finish(task, this.workerId, { status: "failed", error: prefix + err.message, failureClass: classifyFailure(err) });
      }
      await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: "worker", action: `task.${outcome}`, message: `${task.title}: ${outcome} — ${errMsg}` });
    } finally {
      clearTimeout(timeout);
      clearInterval(renew);
      await q(`UPDATE task_attempts SET outcome = $2, error = $3, finished_at = now() WHERE id = $1`, [attempt!.id, outcome, errMsg]);
      await updateProjectStatus(task.project_id);
    }
  }
}

// ---------------------------------------------------------------- Kuyruk yönetimi

export async function recoverExpiredLeases() {
  const rows = await q<Task>(
    `UPDATE tasks SET
       status = CASE WHEN attempts < max_attempts THEN (CASE WHEN phase = 'review' THEN 'review_pending' ELSE 'ready' END) ELSE 'failed' END,
       error = CASE WHEN attempts < max_attempts THEN 'İşleyici yanıt vermedi; görev yeniden kuyruğa alındı.' ELSE 'İşleyici yanıt vermedi; deneme sınırı doldu.' END,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE status = 'running' AND (lease_expires_at < now()
       OR lease_owner IN (SELECT worker_id FROM worker_heartbeats WHERE last_seen < now() - interval '30 seconds'))
     RETURNING *`,
  );
  for (const t of rows) {
    await q(`UPDATE task_attempts SET outcome = 'lease_expired', finished_at = now() WHERE task_id = $1 AND finished_at IS NULL`, [t.id]);
    await audit({ brandId: t.brand_id, projectId: t.project_id, taskId: t.id, actor: "worker", action: "task.recovered", message: `Kiralama süresi doldu, görev kurtarıldı: ${t.title} → ${t.status}` });
  }
  return rows.length;
}

export async function promotePlanned() {
  const cancelled = await q<Task>(
    `UPDATE tasks t SET status = 'cancelled', failure_class = 'dependency', error = 'Bağımlılık başarısız veya iptal edildi', finished_at = now(), updated_at = now()
     WHERE t.status = 'planned' AND t.dep_mode = 'completed' AND EXISTS (
       SELECT 1 FROM task_dependencies d JOIN tasks u ON u.id = d.depends_on_task_id
       WHERE d.task_id = t.id AND u.status IN ('failed','cancelled'))
     RETURNING *`,
  );
  for (const t of cancelled) {
    await audit({ brandId: t.brand_id, projectId: t.project_id, taskId: t.id, actor: "agent:manager", action: "task.cancel_dependency", message: `Bağımlılığı başarısız olduğu için iptal edildi: ${t.title}` });
  }
  await q(
    `UPDATE tasks t SET status = 'ready', updated_at = now()
     WHERE t.status = 'planned' AND NOT EXISTS (
       SELECT 1 FROM task_dependencies d JOIN tasks u ON u.id = d.depends_on_task_id
       WHERE d.task_id = t.id AND NOT (
         CASE WHEN t.dep_mode = 'completed' THEN u.status IN ('completed','approval_pending')
              ELSE u.status IN ('completed','approval_pending','failed','cancelled','waiting_connection') END))`,
  );
}

export async function claimTasks(workerId: string, limits: Limits): Promise<Task[]> {
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(777001)`);
    const running = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'running'`, [], c);
    const free = limits.maxConcurrentTasks - (running?.n ?? 0);
    if (free <= 0) return [];
    return q<Task>(
      `UPDATE tasks SET status = 'running', lease_owner = $1, lease_expires_at = now() + ($3 || ' milliseconds')::interval,
         attempts = attempts + 1, started_at = COALESCE(started_at, now()), next_attempt_at = NULL, updated_at = now()
       WHERE id IN (
         SELECT id FROM tasks WHERE status IN ('ready','review_pending') AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         ORDER BY created_at, key FOR UPDATE SKIP LOCKED LIMIT $2)
       RETURNING *`,
      [workerId, free, String(LEASE_MS)],
      c,
    );
  });
}

/** Görevi yalnızca hâlâ bu işleyiciye aitse ve çalışıyorsa sonlandırır (iptal her zaman kazanır). */
async function finish(task: Task, workerId: string, patch: { status: string; error?: string | null; phase?: string; outputId?: string; model?: string; service?: string; feedback?: string | null; regenInc?: boolean; failureClass?: FailureClass | null; nextAttemptMs?: number }) {
  const terminal = ["completed", "failed", "cancelled", "approval_pending", "waiting_connection"].includes(patch.status);
  const r = await q1<Task>(
    `UPDATE tasks SET status = $3, error = $4, phase = COALESCE($5, phase), output_id = COALESCE($6, output_id), model = COALESCE($7, model),
       service = COALESCE($8, service), feedback = CASE WHEN $9::boolean THEN $10 ELSE feedback END,
       regen_count = regen_count + CASE WHEN $11::boolean THEN 1 ELSE 0 END,
       attempts = CASE WHEN $3 IN ('ready','review_pending') THEN 0 ELSE attempts END,
       lease_owner = NULL, lease_expires_at = NULL, finished_at = CASE WHEN $12::boolean THEN now() ELSE NULL END, updated_at = now(),
       failure_class = $13, next_attempt_at = CASE WHEN $14::int IS NULL THEN NULL ELSE now() + ($14::int || ' milliseconds')::interval END
     WHERE id = $1 AND lease_owner = $2 AND status = 'running' RETURNING *`,
    [task.id, workerId, patch.status, patch.error ?? null, patch.phase ?? null, patch.outputId ?? null, patch.model ?? null, patch.service ?? null,
      patch.feedback !== undefined, patch.feedback ?? null, !!patch.regenInc, terminal, patch.failureClass ?? null, patch.nextAttemptMs ?? null],
  );
  if (!r) throw new CancelledError("Görev başka bir işlem tarafından değiştirildi (iptal edilmiş olabilir).");
  return r;
}

export async function updateProjectStatus(projectId: string) {
  const p = await q1<{ status: string; brand_id: string; questions: string[] }>(`SELECT status, brand_id, questions FROM projects WHERE id = $1`, [projectId]);
  if (!p || p.status === "cancelled") return;
  const counts = await q<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM tasks WHERE project_id = $1 GROUP BY status`, [projectId]);
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const blocking = await q1<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM tasks WHERE project_id = $1 AND status = 'failed' AND failure_class = ANY($2::text[])`,
    [projectId, (Object.keys(FAILURE_ACTION) as FailureClass[]).filter((k) => FAILURE_ACTION[k].blocks)],
  );
  const active = n("planned") + n("ready") + n("running") + n("review_pending");
  const total = counts.reduce((a, c) => a + c.n, 0);
  // Başarısız bir alt görev varken proje asla "tamamlandı" olmaz.
  const status = active
    ? "running"
    : (blocking?.n ?? 0) > 0
      ? "blocked"
      : n("failed") + n("waiting_connection") + n("approval_pending") + n("cancelled") > 0
        ? "needs_attention"
        : (p.questions?.length ?? 0) > 0 && total <= 1
          ? "needs_input"
          : "completed";
  if (status !== p.status) await q(`UPDATE projects SET status = $2, updated_at = now() WHERE id = $1`, [projectId, status]);
}

// ---------------------------------------------------------------- Model çağrısı (sınır + bütçe + maliyet)

async function callModel<T>(ctx: RunCtx, agent: AgentId, purpose: string, schema: import("zod").ZodType<T>, user: string, demoInput: unknown, maxTokens = 16000) {
  const { task, model, limits } = ctx;
  if (ctx.signal.aborted) throw ctx.signal.reason;
  if (model.unavailableReason) throw new ModelUnavailableError(model.unavailableReason);
  const inc = await q1(`UPDATE projects SET model_calls = model_calls + 1 WHERE id = $1 AND model_calls < $2 RETURNING model_calls`, [task.project_id, limits.maxModelCallsPerProject]);
  if (!inc) throw new ModelCallLimitError(`Proje başına ${limits.maxModelCallsPerProject} model çağrısı sınırına ulaşıldı.`);
  const system = systemPrompt(agent, purpose);
  const estimate = model.estimateCostUsd({ system, user, maxTokens });
  await assertBudget({ taskId: task.id, estimateUsd: estimate, service: model.service });
  await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: model.service, kind: "estimated", amountUsd: estimate, note: `${agent}:${purpose} üst sınır tahmini` });
  const res = await model.generate({ agent, purpose, system, user, schema, maxTokens, signal: ctx.signal, demoInput });
  await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: model.service, kind: "actual", amountUsd: res.actualCostUsd, units: res.usage ?? {}, note: res.isDemo ? "DEMO — ücret yok" : `${agent}:${purpose}` });
  return res;
}

async function upstreamOutputs(task: Task) {
  return q<{ agent: string; kind: string; content: unknown }>(
    `SELECT o.agent, o.kind, v.content FROM task_dependencies d
     JOIN tasks u ON u.id = d.depends_on_task_id AND u.brand_id = $2
     JOIN outputs o ON o.id = u.output_id AND o.brand_id = $2
     JOIN output_versions v ON v.output_id = o.id AND v.version = o.current_version
     WHERE d.task_id = $1`,
    [task.id, task.brand_id],
  );
}

// ---------------------------------------------------------------- Planlama

function cleanKey(s: string, used: Set<string>) {
  let k = s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
  if (k === "plan" || k === "report") k = `${k}-x`;
  let n = 2;
  const base = k;
  while (used.has(k)) k = `${base}-${n++}`;
  used.add(k);
  return k;
}

/** Plan doğrulama: geçerli uzman, döngüsüz bağımlılık (yalnızca önceki görevlere), görev sınırı. */
export function sanitizePlan(plan: Plan, maxTasks: number) {
  const used = new Set<string>();
  const keyMap = new Map<string, string>();
  const tasks: { key: string; agent: SpecialistId; title: string; instruction: string; depends_on: string[] }[] = [];
  const dropped: string[] = [];
  for (const t of plan.tasks) {
    if (!isSpecialist(t.agent)) { dropped.push(`${t.title} (geçersiz uzman)`); continue; }
    if (tasks.length >= maxTasks) { dropped.push(`${t.title} (görev sınırı)`); continue; }
    const key = cleanKey(t.key, used);
    keyMap.set(t.key, key);
    const deps = [...new Set(t.depends_on.map((d) => keyMap.get(d)).filter((d): d is string => !!d && d !== key))];
    tasks.push({ key, agent: t.agent, title: t.title.slice(0, 200), instruction: t.instruction.slice(0, 4000), depends_on: deps });
  }
  return { tasks, dropped };
}

async function runPlan(ctx: RunCtx, workerId: string) {
  const { task, limits } = ctx;
  assertTool("manager", "brand.read");
  assertTool("manager", "tasks.manage");
  const brandCtx = await buildBrandContext(task.brand_id, undefined, { agent: "manager" });
  const user = userPrompt({ instruction: task.instruction, ctx: brandCtx, extra: `<limits>At most ${limits.maxTasksPerProject - 1} tasks.</limits>` });
  const res = await callModel(ctx, "manager", "plan", PlanSchema, user, { instruction: task.instruction, ctx: brandCtx, upstream: [] }, 8000);
  const { tasks, dropped } = sanitizePlan(res.data, limits.maxTasksPerProject - 1);

  await tx(async (c) => {
    const ids = new Map<string, string>();
    for (const t of tasks) {
      const row = await q1<{ id: string }>(
        `INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status, requires_approval, max_attempts)
         VALUES ($1,$2,$3,$4,'work',$5,$6,'planned',$7,$8) RETURNING id`,
        [task.brand_id, task.project_id, t.key, t.agent, t.title, t.instruction, AGENTS[t.agent].producesExternalProposal, limits.maxAttempts],
        c,
      );
      ids.set(t.key, row!.id);
      for (const d of t.depends_on) await q(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2)`, [row!.id, ids.get(d)], c);
    }
    if (tasks.length) {
      const rep = await q1<{ id: string }>(
        `INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status, dep_mode, max_attempts)
         VALUES ($1,$2,'report','manager','report','Sonuçları raporla','Proje sonuçlarını özetle','planned','settled',$3) RETURNING id`,
        [task.brand_id, task.project_id, limits.maxAttempts],
        c,
      );
      for (const id of ids.values()) await q(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2)`, [rep!.id, id], c);
    }
  });

  const out = await createOutput({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, agent: "manager", kind: "plan", title: "Görev planı" });
  await addVersion({ brandId: task.brand_id, outputId: out.id, content: { ...res.data, sanitized_tasks: tasks, dropped }, createdBy: "agent:manager", generator: res.generator, isDemo: res.isDemo });
  const lines = tasks.map((t, i) => `${i + 1}. ${agentName(t.agent)} — ${t.title}${t.depends_on.length ? ` (önce: ${t.depends_on.join(", ")})` : ""}`);
  const questions = (res.data.questions_for_owner ?? []).filter((x) => x.trim()).slice(0, 10);
  await q(`UPDATE projects SET questions = $2 WHERE id = $1`, [task.project_id, JSON.stringify(questions)]);
  const msg = [res.data.reply, res.data.goals.length ? `\nHedefler:\n${res.data.goals.map((g) => `• ${g}`).join("\n")}` : "", lines.length ? `\nGörevler:\n${lines.join("\n")}` : "", questions.length ? `\nSizden gereken bilgiler:\n${questions.map((x) => `? ${x}`).join("\n")}` : "", dropped.length ? `\nPlandan çıkarılanlar: ${dropped.join(", ")}` : ""].join("\n");
  await q(`INSERT INTO chat_messages (brand_id, project_id, role, content, data) VALUES ($1,$2,'manager',$3,$4)`, [task.brand_id, task.project_id, msg.trim(), JSON.stringify({ isDemo: res.isDemo, generator: res.generator })]);
  await finish(task, workerId, { status: "completed", outputId: out.id, model: res.model, service: ctx.model.service });
  // Görevsiz plan: soru varsa "bilgi bekliyor", yoksa tamamlandı (updateProjectStatus belirler)
}

// ---------------------------------------------------------------- Uzman üretimi

async function extraForAgent(agent: SpecialistId, brandId: string): Promise<string | undefined> {
  if (agent !== "quality") return undefined;
  const [costs, statuses] = await Promise.all([
    costSummary(brandId, "service"),
    Promise.all(PROVIDERS.map(async (p) => ({ provider: p.name, status: (await effectiveStatus(p.id, brandId)).status }))),
  ]);
  return `<cost_records><data>${JSON.stringify(costs)}</data></cost_records>\n<connections><data>${JSON.stringify(statuses)}</data></connections>\n<performance_data><data>No performance source is connected. Do not invent metrics.</data></performance_data>`;
}

async function runGenerate(ctx: RunCtx, workerId: string) {
  const { task } = ctx;
  if (!isSpecialist(task.agent)) throw new PermanentError(`Bilinmeyen uzman: ${task.agent}`);
  const agent = task.agent;
  assertTool(agent, "brand.read");
  const brandCtx = await buildBrandContext(task.brand_id, undefined, { agent });
  const upstream = await upstreamOutputs(task);
  if (upstream.length) assertTool(agent, "outputs.read");
  const schema = OUTPUT_SCHEMAS[agent] as import("zod").ZodType<any>;
  const user = userPrompt({ instruction: task.instruction, ctx: brandCtx, upstream, feedback: task.feedback, extra: await extraForAgent(agent, task.brand_id) });
  const res = await callModel(ctx, agent, "work", schema, user, { instruction: task.instruction, ctx: brandCtx, upstream, feedback: task.feedback, taskKey: task.key });

  let outputId = task.output_id;
  if (!outputId) {
    const out = await createOutput({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, agent, kind: OUTPUT_KIND[agent], title: task.title });
    outputId = out.id;
  }
  const v = await addVersion({ brandId: task.brand_id, outputId, content: res.data, createdBy: `agent:${agent}`, generator: res.generator, isDemo: res.isDemo });
  await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: `agent:${agent}`, action: "output.version", message: `${agentName(agent)} çıktı üretti: ${task.title} (sürüm ${v.version}${res.isDemo ? ", DEMO" : ""})` });

  if (agent === "quality") {
    // Analiz görevi bir kalite raporudur; ayrıca incelenmez.
    await setVersionQa(v.id, { verdict: "pass", score: 0, checks: [{ name: "Analiz raporu", status: "pass", detail: "Kalite uzmanının kendi raporu; ayrıca incelenmedi." }], required_changes: [], sources: ["self"] });
    await finish(task, workerId, { status: "completed", outputId, model: res.model, service: ctx.model.service });
    return;
  }
  await finish(task, workerId, { status: "review_pending", phase: "review", outputId, model: res.model, service: ctx.model.service });
}

// ---------------------------------------------------------------- Kalite kontrol

async function runReview(ctx: RunCtx, workerId: string) {
  const { task, limits } = ctx;
  if (!task.output_id) throw new PermanentError("İncelenecek çıktı yok.");
  assertTool("quality", "outputs.read");
  const v = await getCurrentVersion(task.brand_id, task.output_id);
  if (!v) throw new PermanentError("Çıktı sürümü bulunamadı.");
  const brandCtx = await buildBrandContext(task.brand_id, undefined, { agent: "quality" });
  const rule = runRuleChecks(task.agent, v.content, brandCtx, { isDemo: v.is_demo });

  const user = userPrompt({ instruction: `Review the ${task.agent} output for task: ${task.instruction}`, ctx: brandCtx, target: { agent: task.agent, content: v.content } });
  const res = await callModel(ctx, "quality", "review", QaReviewSchema, user, { instruction: task.instruction, ctx: brandCtx, upstream: [], target: { agent: task.agent, content: v.content } }, 6000);
  const merged = mergeReviews(rule, res.data as QaReview, res.isDemo ? "demo" : "model");
  await setVersionQa(v.id, { ...merged, reviewed_version: v.version, generator: res.generator });
  await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: "agent:quality", action: "qa.result", message: `Kalite kontrolü (${task.title}, sürüm ${v.version}): ${merged.verdict} — puan ${merged.score}` });

  if (merged.verdict === "pass") {
    // Takip görevleri, görev "tamamlandı" olmadan ÖNCE oluşturulur; böylece rapor görevi render'ı beklemeden başlayamaz.
    await spawnFollowUps(task, v, brandCtx);
    if (task.agent === "social") await createCalendarEntries(task, v);
    await finish(task, workerId, { status: task.requires_approval ? "approval_pending" : "completed" });
    return;
  }
  if (task.regen_count < limits.maxRegenerations) {
    await finish(task, workerId, { status: "ready", phase: "generate", feedback: merged.required_changes.join("\n") || "Kalite kontrolünde sorun bulundu.", regenInc: true });
    await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: "agent:manager", action: "task.regenerate", message: `Kalite kontrolünden geçemedi; yeniden üretime gönderildi (${task.regen_count + 1}/${limits.maxRegenerations})` });
    return;
  }
  await finish(task, workerId, { status: "failed", failureClass: "quality", error: `Kalite kontrolünden geçemedi (yeniden üretim sınırı doldu): ${merged.required_changes.join("; ").slice(0, 500)}` });
}

async function createCalendarEntries(task: Task, v: OutputVersion) {
  await q(`DELETE FROM calendar_entries WHERE brand_id = $1 AND output_id = $2 AND status IN ('draft','awaiting_approval')`, [task.brand_id, v.output_id]);
  for (const p of v.content.posts ?? []) {
    await q(
      `INSERT INTO calendar_entries (brand_id, output_id, platform, title, caption, scheduled_at, status) VALUES ($1,$2,$3,$4,$5,$6,'awaiting_approval')`,
      [task.brand_id, v.output_id, p.platform, `${p.id} · ${p.format}`, p.caption, Number.isNaN(Date.parse(p.suggested_datetime)) ? null : p.suggested_datetime],
    );
  }
}

/** Tasarım/video çıktısından sonra render görevleri (yerel derleme, ffmpeg, AI üretimi) oluşturulur. */
async function spawnFollowUps(task: Task, v: OutputVersion, _ctx: BrandContext) {
  if (task.agent !== "design" && task.agent !== "video") return;
  const key = `${task.key}-render`;
  const existing = await q1<{ id: string; status: string }>(`SELECT id, status FROM tasks WHERE project_id = $1 AND key = $2`, [task.project_id, key]);
  if (existing) {
    if (["completed", "failed", "cancelled", "waiting_connection"].includes(existing.status)) {
      await q(`UPDATE tasks SET status = 'planned', attempts = 0, error = NULL, finished_at = NULL, input_refs = $2, updated_at = now() WHERE id = $1`, [existing.id, JSON.stringify({ version_id: v.id })]);
    }
    return;
  }
  const limits = await getLimits();
  const title = task.agent === "design" ? "Görselleri üret / derle" : "Videoyu render et";
  const row = await q1<{ id: string }>(
    `INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status, input_refs, output_id, max_attempts)
     VALUES ($1,$2,$3,$4,'render',$5,$6,'planned',$7,$8,$9) RETURNING id`,
    [task.brand_id, task.project_id, key, task.agent, title, `${task.title} çıktısının dosyalarını üret`, JSON.stringify({ version_id: v.id }), task.output_id, limits.maxAttempts],
  );
  await q(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2)`, [row!.id, task.id]);
  // Rapor henüz başlamadıysa render görevini de beklesin
  await q(
    `INSERT INTO task_dependencies (task_id, depends_on_task_id)
     SELECT id, $2 FROM tasks WHERE project_id = $1 AND kind = 'report' AND status = 'planned' ON CONFLICT DO NOTHING`,
    [task.project_id, row!.id],
  );
}

// ---------------------------------------------------------------- Render (gerçek dosya üretimi)

async function runRender(ctx: RunCtx, workerId: string) {
  const { task } = ctx;
  const versionId = task.input_refs?.version_id as string | undefined;
  const v = versionId ? await q1<OutputVersion>(`SELECT * FROM output_versions WHERE id = $1 AND brand_id = $2`, [versionId, task.brand_id]) : null;
  if (!v) throw new PermanentError("Render edilecek sürüm bulunamadı.");
  const rctx: RenderCtx = { task, signal: ctx.signal, limits: ctx.limits, versionId: v.id, isDemo: v.is_demo, content: v.content };
  const o = task.agent === "design" ? await renderDesign(rctx) : task.agent === "video" ? await renderVideo(rctx) : null;
  if (!o) throw new PermanentError(`${task.agent} için render adımı yok.`);
  if (o.produced.length) await attachAssetsToVersion(v.id, o.produced);
  const summary = { produced: o.produced.length, waiting: o.waiting, in_progress: o.inProgress, failed: o.failed, uncertain: o.uncertain, notes: o.notes };
  await q(`UPDATE tasks SET input_refs = input_refs || $2::jsonb WHERE id = $1`, [task.id, JSON.stringify({ result: summary })]);
  const service = task.agent === "design" ? "sharp/openai_images" : "ffmpeg/video_generation";
  const made = o.produced.length ? ` (üretilen dosya: ${o.produced.length})` : "";
  if (o.inProgress.length) {
    // Sağlayıcı işi sürüyor: görev kuyruğa döner ve daha sonra durumu sorgular (deneme hakkı tüketmez)
    await finish(task, workerId, { status: "ready", phase: "render", error: `Sürüyor: ${o.inProgress.join(" | ")}${made}`, service, nextAttemptMs: RENDER_POLL_MS });
  } else if (o.uncertain.length) {
    await finish(task, workerId, { status: "failed", error: `Sonucu belirsiz ücretli işlem: ${o.uncertain.join(" | ")}${made}`, service, failureClass: "uncertain" });
  } else if (o.failed.length) {
    await finish(task, workerId, { status: "failed", error: `Başarısız öğeler: ${o.failed.join(" | ")}${made}`, service, failureClass: "permanent" });
  } else if (o.waiting.length) {
    await finish(task, workerId, { status: "waiting_connection", error: `Bağlantı/izin bekleyen öğeler: ${o.waiting.join(" | ")}${made}`, service, failureClass: "connection" });
  } else {
    await finish(task, workerId, { status: "completed", error: o.notes.length ? o.notes.join(" | ") : null, service: task.agent === "design" ? "sharp (yerel)" : "ffmpeg (yerel)" });
  }
}

// ---------------------------------------------------------------- Rapor

async function runReport(ctx: RunCtx, workerId: string) {
  const { task } = ctx;
  assertTool("manager", "outputs.read");
  const tasks = await q<Task>(`SELECT * FROM tasks WHERE project_id = $1 AND brand_id = $2 AND kind <> 'plan' AND id <> $3 ORDER BY created_at`, [task.project_id, task.brand_id, task.id]);
  const costs = await q1<{ est: number | null; act: number | null; unknown: number }>(
    `SELECT SUM(amount_usd) FILTER (WHERE kind='estimated') AS est, SUM(amount_usd) FILTER (WHERE kind='actual') AS act,
       COUNT(*) FILTER (WHERE amount_usd IS NULL)::int AS unknown FROM cost_entries WHERE project_id = $1`,
    [task.project_id],
  );
  const demo = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM output_versions v JOIN outputs o ON o.id = v.output_id WHERE o.project_id = $1 AND v.is_demo`, [task.project_id]);
  const mode = textModelMode();
  const label = (t: Task) => `${agentName(t.agent)}: ${t.title}`;
  const report: ProjectReport & { cost: unknown; mode: string; demo_outputs: number } = {
    headline: `${tasks.filter((t) => t.status === "completed" || t.status === "approval_pending").length}/${tasks.length} görev çıktı üretti`,
    summary: `${mode.label}. ${demo?.n ? `${demo.n} çıktı sürümü DEMO şablonla üretildi (gerçek AI değil). ` : ""}Dış platformlarda hiçbir işlem onayınız olmadan yapılmadı.`,
    completed: tasks.filter((t) => t.status === "completed").map(label),
    pending_approvals: tasks.filter((t) => t.status === "approval_pending").map(label),
    problems: tasks.filter((t) => ["failed", "cancelled"].includes(t.status)).map((t) => {
      const fc = t.failure_class as FailureClass | null;
      const info = fc ? FAILURE_ACTION[fc] : null;
      return `${label(t)} — ${info?.label ?? (t.status === "failed" ? "başarısız" : "iptal")}: ${t.error ?? ""}${info ? ` → Öneri: ${info.action}` : ""}`;
    }),
    missing_connections: tasks.filter((t) => t.status === "waiting_connection").map((t) => `${label(t)} — ${t.error ?? ""}`),
    next_steps: [
      ...(tasks.some((t) => t.status === "approval_pending") ? ["Onay merkezinde bekleyen çıktıları inceleyin, gerekirse düzenleyip onaylayın."] : []),
      ...(tasks.some((t) => t.status === "waiting_connection") ? ["Entegrasyonlar ekranından eksik servisleri bağlayıp 'Bağlantı bekleyenleri tekrar dene' deyin."] : []),
      ...(tasks.some((t) => t.status === "failed") ? ["Başarısız görevlerin hata kaydını inceleyip tekrar deneyin."] : []),
    ],
    cost: { estimated_usd: costs?.est ?? null, actual_usd: costs?.act ?? null, unknown_entries: costs?.unknown ?? 0 },
    mode: mode.mode,
    demo_outputs: demo?.n ?? 0,
  };
  const out = await createOutput({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, agent: "manager", kind: "project_report", title: "Proje raporu" });
  await addVersion({ brandId: task.brand_id, outputId: out.id, content: report, createdBy: "agent:manager", generator: "local", isDemo: false });
  await q(`UPDATE projects SET report = $2, updated_at = now() WHERE id = $1`, [task.project_id, JSON.stringify(report)]);
  const text = [
    `Rapor: ${report.headline}.`,
    report.summary,
    report.completed.length ? `\nTamamlanan:\n${report.completed.map((x) => `• ${x}`).join("\n")}` : "",
    report.pending_approvals.length ? `\nOnay bekleyen:\n${report.pending_approvals.map((x) => `• ${x}`).join("\n")}` : "",
    report.missing_connections.length ? `\nBağlantı bekleyen:\n${report.missing_connections.map((x) => `• ${x}`).join("\n")}` : "",
    report.problems.length ? `\nSorunlar:\n${report.problems.map((x) => `• ${x}`).join("\n")}` : "",
    `\nMaliyet: tahmini ${fmtUsd(costs?.est)}, gerçekleşen ${fmtUsd(costs?.act)}${costs?.unknown ? `, ${costs.unknown} kayıt bilinmiyor` : ""}.`,
  ].filter(Boolean).join("\n");
  await q(`INSERT INTO chat_messages (brand_id, project_id, role, content, data) VALUES ($1,$2,'manager',$3,$4)`, [task.brand_id, task.project_id, text, JSON.stringify({ report: true })]);
  await finish(task, workerId, { status: "completed", outputId: out.id, service: "local" });
}

function fmtUsd(n: number | null | undefined) {
  return n === null || n === undefined ? "bilinmiyor" : `$${Number(n).toFixed(4)}`;
}
