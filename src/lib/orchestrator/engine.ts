import { q, q1, tx, getPool, type Queryable } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { capture } from "@/lib/telemetry";
import { releaseCommit } from "@/lib/release";
import { log } from "@/lib/log";
import { getLimits, getSetting, isPaused, type Limits } from "@/lib/settings";
import { getTextModel } from "@/lib/models";
import { ModelUnavailableError, PermanentError, TransientError, type GenerateRequest, type TextModelAdapter } from "@/lib/models/types";
import { buildBrandContext, type BrandContext } from "@/lib/agents/context";
import { AGENTS, agentName, assertTool, isSpecialist, ToolPermissionError } from "@/lib/agents/registry";
import { OUTPUT_KIND, OUTPUT_SCHEMAS, PlanSchema, QaReviewSchema, type AgentId, type Plan, type ProjectReport, type QaReview, type SpecialistId } from "@/lib/agents/schemas";
import { systemPrompt, userPromptParts } from "@/lib/agents/prompts";
import { mergeReviews, referencedAssetIds, runRuleChecks } from "@/lib/agents/qa-rules";
import { addVersion, attachAssetsToVersion, createOutput, getCurrentVersion, setVersionQa, type OutputVersion } from "@/lib/services/outputs";
import { assertBudget, BudgetExceededError, costSummary, recordCost } from "@/lib/services/costs";
import { effectiveStatus, PROVIDERS } from "@/lib/services/connections";
import { renderDesign, renderVideo, RENDER_POLL_MS, type RenderCtx } from "./render";
import { analysisFrames, compactAnalysis, ensureAnalysis, type MediaAnalysis } from "@/lib/media-analysis";
import type { MediaAsset } from "@/lib/services/media";
import { getStorage } from "@/lib/storage";
import { getReviewModel, textModelMode } from "@/lib/models";
import { createPlanTasks, type Task } from "./projects";
import { catalogCheck, contradictsCatalog, pendingProposal, recentConversation, recentWork } from "./conversation";
import { parseStudioRequest, type StudioRequest } from "@/lib/video/studio";
import { describeSpec, parseVideoSpec, type VideoSpec } from "@/lib/video/spec";
import { validateVideoPlan, type PlanValidation } from "@/lib/video/plan-validation";
import { brainContextFor, recordOutputSources } from "@/lib/brain/context";

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
      // commit: dağıtım hattı işleyicinin yeni sürümle çalıştığını buradan doğrular
      [this.workerId, JSON.stringify({ active: this.inflight.size, pid: process.pid, commit: releaseCommit(), rss_mb: Math.round(process.memoryUsage().rss / 1048576) })],
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
    const timeoutMs = effectiveTimeoutMs(task, limits);
    const timeout = setTimeout(() => ctrl.abort(new TimeoutError(`Görev süre sınırını aştı (${Math.round(timeoutMs / 1000)} sn)`)), timeoutMs);
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
    const startedAt = Date.now();
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
      log(outcome === "failed" ? "warn" : "info", "task.attempt", {
        taskId: task.id, projectId: task.project_id, brandId: task.brand_id, agent: task.agent, kind: task.kind, phase: task.phase,
        attempt: task.attempts, outcome, durationMs: Date.now() - startedAt, workerId: this.workerId, error: errMsg ?? undefined,
      });
      // Telemetri (yapılandırılmışsa): hata metni ve içerik gönderilmez, yalnızca sınıf bilgisi
      if (outcome === "failed" || outcome === "budget_blocked") capture("task_failed", { agent: task.agent, kind: task.kind, attempt: task.attempts, status: outcome });
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
async function finish(task: Task, workerId: string, patch: { status: string; error?: string | null; phase?: string; outputId?: string; model?: string; service?: string; feedback?: string | null; regenInc?: boolean; failureClass?: FailureClass | null; nextAttemptMs?: number }, db: Queryable = getPool()) {
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
    db,
  );
  if (!r) throw new CancelledError("Görev başka bir işlem tarafından değiştirildi (iptal edilmiş olabilir).");
  return r;
}

/**
 * Sonuç yazımı yalnızca görev hâlâ bu işleyiciye aitken yapılır. Kiralaması dolup başka işleyiciye geçmiş (yavaş/donmuş)
 * bir işleyici dönünce çıktı yazamaz: tekrar teslimde çift sürüm oluşmaz.
 */
async function owned<T>(task: Task, workerId: string, fn: (c: Queryable) => Promise<T>): Promise<T> {
  return tx(async (c) => {
    const r = await q1(`SELECT 1 FROM tasks WHERE id = $1 AND lease_owner = $2 AND status = 'running' FOR UPDATE`, [task.id, workerId], c);
    if (!r) throw new CancelledError("Görev başka bir işleyiciye geçti veya iptal edildi; bu işleyicinin sonucu yazılmadı.");
    return fn(c);
  });
}
async function assertOwned(task: Task, workerId: string) {
  const r = await q1(`SELECT 1 FROM tasks WHERE id = $1 AND lease_owner = $2 AND status = 'running'`, [task.id, workerId]);
  if (!r) throw new CancelledError("Görev başka bir işleyiciye geçti veya iptal edildi; bu işleyicinin sonucu yazılmadı.");
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

async function callModel<T>(ctx: RunCtx, agent: AgentId, purpose: string, schema: import("zod").ZodType<T>, prompt: { prefix: string; rest: string }, demoInput: unknown, maxTokens = 16000, images?: GenerateRequest<T>["images"]) {
  if (purpose === "review") {
    // İnceleme daha ucuz modelde; bu model isteği reddederse (400/404) aynı inceleme bir kez ana modelle yapılır
    const reviewer = getReviewModel(ctx.model);
    if (reviewer !== ctx.model) {
      try {
        return await callModelWith({ ...ctx, model: reviewer }, agent, purpose, schema, prompt, demoInput, maxTokens, images);
      } catch (err) {
        if (!(err instanceof PermanentError) || !/isteği reddetti/.test(err.message)) throw err;
        log("warn", "qa.review_model_rejected", { taskId: ctx.task.id, model: reviewer.id, error: err.message });
      }
    }
  }
  return callModelWith(ctx, agent, purpose, schema, prompt, demoInput, maxTokens, images);
}

async function callModelWith<T>(ctx: RunCtx, agent: AgentId, purpose: string, schema: import("zod").ZodType<T>, prompt: { prefix: string; rest: string }, demoInput: unknown, maxTokens = 16000, images?: GenerateRequest<T>["images"]) {
  const { task, model, limits } = ctx;
  if (ctx.signal.aborted) throw ctx.signal.reason;
  if (model.unavailableReason) throw new ModelUnavailableError(model.unavailableReason);
  const inc = await q1(`UPDATE projects SET model_calls = model_calls + 1 WHERE id = $1 AND model_calls < $2 RETURNING model_calls`, [task.project_id, limits.maxModelCallsPerProject]);
  if (!inc) throw new ModelCallLimitError(`Proje başına ${limits.maxModelCallsPerProject} model çağrısı sınırına ulaşıldı.`);
  const system = systemPrompt(agent, purpose);
  const { prefix: userPrefix, rest: user } = prompt;
  const estimate = model.estimateCostUsd({ system, user, userPrefix, maxTokens, imageCount: images?.length ?? 0 });
  await assertBudget({ taskId: task.id, estimateUsd: estimate, service: model.service });
  await recordCost({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, service: model.service, kind: "estimated", amountUsd: estimate, note: `${agent}:${purpose} üst sınır tahmini` });
  const res = await model.generate({ agent, purpose, system, user, userPrefix, schema, maxTokens, signal: ctx.signal, demoInput, ...(images?.length ? { images } : {}) });
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
/** "Videoyu analiz et / sahne seç" türünde, gerçek medya analizinin yerine geçmeye çalışan metin görevi. */
export function isVideoAnalysisOnlyTask(t: { agent: string; title: string; instruction: string }) {
  if (t.agent !== "video") return false;
  const text = `${t.title} ${t.instruction}`.toLocaleLowerCase("tr");
  const analysis = /(analiz|analysis|analyse|analyze|sahne seç|scene select|kare çıkar|frame)/.test(text);
  const production = /(kurgu|render|mp4|montaj|edit plan|edit the|reels? (üret|hazırla|oluştur)|ekran yaz|on-screen|altyazı|subtitle|senaryo|script)/.test(text);
  return analysis && !production;
}

export function sanitizePlan(plan: Plan, maxTasks: number) {
  const used = new Set<string>();
  const keyMap = new Map<string, string>();
  const tasks: { key: string; agent: SpecialistId; title: string; instruction: string; depends_on: string[] }[] = [];
  const dropped: string[] = [];
  // Gerçek video analizi sistem tarafından yapılır: ayrı "video analizi" metin görevi, başka bir video görevi
  // varsa plandan çıkarılır; ona bağlı görevler onun bağımlılıklarını devralır.
  const hasProductionVideo = plan.tasks.some((t) => t.agent === "video" && !isVideoAnalysisOnlyTask(t));
  const replaced = new Map<string, string[]>();
  for (const t of plan.tasks) {
    if (hasProductionVideo && isVideoAnalysisOnlyTask(t)) {
      replaced.set(t.key, t.depends_on.flatMap((d) => replaced.get(d) ?? [d]));
      dropped.push(`${t.title} (video analizi sistem tarafından otomatik yapılır)`);
      continue;
    }
    t.depends_on = [...new Set(t.depends_on.flatMap((d) => replaced.get(d) ?? [d]))];
    if (!isSpecialist(t.agent)) { dropped.push(`${t.title} (geçersiz uzman)`); continue; }
    if (tasks.length >= maxTasks) { dropped.push(`${t.title} (görev sınırı)`); continue; }
    const key = cleanKey(t.key, used);
    keyMap.set(t.key, key);
    const deps = [...new Set(t.depends_on.map((d) => keyMap.get(d)).filter((d): d is string => !!d && d !== key))];
    tasks.push({ key, agent: t.agent, title: t.title.slice(0, 200), instruction: t.instruction.slice(0, 4000), depends_on: deps });
  }
  return { tasks, dropped };
}

/**
 * Planlama çıktı sınırı. Uyarlanabilir düşünme bu sınırı plan JSON'uyla paylaşır; çok teslimatlı kapsamlı bir talepte
 * 8000 belirteç yetmez (çıktı kesilir, aynı sınırla tekrar denemek yine keser). Uzman üretimiyle aynı sınır.
 */
export const PLAN_MAX_TOKENS = 16000;
/** Kapsamlı planlama tek model çağrısıdır ve 3 dakikayı aşabilir; ayrı süre sınırı. */
export const PLAN_TIMEOUT_MS = 360_000;

async function runPlan(ctx: RunCtx, workerId: string) {
  const { task, limits } = ctx;
  assertTool("manager", "brand.read");
  assertTool("manager", "tasks.manage");
  const brandCtx = await buildBrandContext(task.brand_id, undefined, { agent: "manager" });
  // Konuşmanın devamı: önceki mesajlar, onay bekleyen öneri ve kayıt sayımı (yönetici bilinen bilgiyi tekrar sormasın)
  const [conversation, pending, work] = await Promise.all([recentConversation(task.brand_id, task.project_id), pendingProposal(task.brand_id), recentWork(task.brand_id, task.project_id)]);
  const catalog = catalogCheck(brandCtx);
  // Erişim öncelikli: AI Yöneticisi yanıt/plan üretmeden önce yetkisi dahilindeki arşiv içeriğini alır
  const brain = await brainContextFor({ brandId: task.brand_id, agent: "manager", taskId: task.id, projectId: task.project_id, instruction: task.instruction });
  const extra = [
    `<limits>At most ${limits.maxTasksPerProject - 1} tasks. Keep each task instruction self-contained and concise (about 200 words at most) but carry over every measurable requirement from the owner (durations, formats, counts, cover time, collections).</limits>`,
    brain.block,
    `<catalog_check>\n<data>${JSON.stringify(catalog)}</data>\n</catalog_check>`,
    conversation.length ? `<conversation>\n<data>${JSON.stringify(conversation)}</data>\n</conversation>` : "",
    work.length ? `<recent_work>\n<data>${JSON.stringify(work)}</data>\n</recent_work>` : "",
    pending && pending.projectId !== task.project_id
      ? `<pending_proposal>\n<data>${JSON.stringify({ title: pending.title, instruction: pending.instruction, reply: pending.reply, goals: pending.goals, tasks: pending.tasks })}</data>\n</pending_proposal>`
      : "",
  ].filter(Boolean).join("\n\n");
  const user = userPromptParts({ instruction: task.instruction, ctx: brandCtx, extra });
  const res = await callModel(ctx, "manager", "plan", PlanSchema, user, { instruction: task.instruction, ctx: brandCtx, upstream: [] }, PLAN_MAX_TOKENS);
  const { tasks, dropped } = sanitizePlan(res.data, limits.maxTasksPerProject - 1);
  // Sahip planı önce görmek istediyse görevler öneri olarak saklanır; "onaylıyorum" gibi kısa bir onayla başlar.
  const awaiting = res.data.awaiting_approval === true && tasks.length > 0;
  // Ürün kaydı varken "katalogda ürün yok" denmez; böyle bir soru düşürülür, yanıt düzeltilir.
  const catalogNote = contradictsCatalog(res.data.reply, catalog.product_count)
    ? `\nNot: Katalogda ${catalog.product_count} ürün kaydı var (${catalog.product_titles.slice(0, 5).join(", ")}).`
    : "";

  await owned(task, workerId, async (c) => {
    if (!awaiting) await createPlanTasks(c, { brandId: task.brand_id, projectId: task.project_id, tasks, maxAttempts: limits.maxAttempts });

    const out = await createOutput({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, agent: "manager", kind: "plan", title: awaiting ? "Plan önerisi (onay bekliyor)" : "Görev planı" }, c);
    const planVersion = await addVersion({ brandId: task.brand_id, outputId: out.id, content: { ...res.data, awaiting_approval: awaiting, sanitized_tasks: tasks, dropped }, createdBy: "agent:manager", generator: res.generator, isDemo: res.isDemo }, c);
    const src = await recordOutputSources(task.brand_id, planVersion.id, brain.search, res.data, c);
    const lines = tasks.map((t, i) => `${i + 1}. ${agentName(t.agent)} — ${t.title}${t.depends_on.length ? ` (önce: ${t.depends_on.join(", ")})` : ""}`);
    const questions = (res.data.questions_for_owner ?? []).filter((x) => x.trim() && !contradictsCatalog(x, catalog.product_count)).slice(0, 10);
    if (awaiting) questions.push("Bu planı onaylıyor musunuz? Başlatmak için “onaylıyorum” yazmanız yeterli.");
    await q(`UPDATE projects SET questions = $2 WHERE id = $1`, [task.project_id, JSON.stringify(questions)], c);
    const msg = [res.data.reply + catalogNote, res.data.goals.length ? `\nHedefler:\n${res.data.goals.map((g) => `• ${g}`).join("\n")}` : "", lines.length ? `\n${awaiting ? "Önerilen görevler (onayınızı bekliyor)" : "Görevler"}:\n${lines.join("\n")}` : "", questions.length ? `\nSizden gereken bilgiler:\n${questions.map((x) => `? ${x}`).join("\n")}` : "", dropped.length ? `\nPlandan çıkarılanlar: ${dropped.join(", ")}` : "", sourcesLine(brain.search, res.data, src.cited)].filter(Boolean).join("\n");
    await q(`INSERT INTO chat_messages (brand_id, project_id, role, content, data) VALUES ($1,$2,'manager',$3,$4)`, [task.brand_id, task.project_id, msg.trim(), JSON.stringify({ isDemo: res.isDemo, generator: res.generator })], c);
    await finish(task, workerId, { status: "completed", outputId: out.id, model: res.model, service: ctx.model.service }, c);
  });
  // Görevsiz plan: soru varsa "bilgi bekliyor", yoksa tamamlandı (updateProjectStatus belirler)
}

/** Sohbet yanıtına eklenen kaynak satırı: yalnızca yanıtta atıf yapılan arşiv dosyaları (yoksa hiçbir şey yazılmaz). */
function sourcesLine(search: Awaited<ReturnType<typeof brainContextFor>>["search"], content: unknown, cited: number) {
  if (!search?.hits.length || !cited) return "";
  const text = JSON.stringify(content ?? "");
  const used = search.hits.filter((h) => new RegExp(`\\b${h.label}\\b`).test(text) || (h.name.length >= 6 && text.includes(h.name)));
  return used.length ? `\nKaynaklar (Drive arşivi): ${used.map((h) => `[${h.label}] ${h.path ?? h.name}`).join("; ")}` : "";
}

// ---------------------------------------------------------------- Uzman üretimi

async function extraForAgent(agent: SpecialistId, brandId: string): Promise<string | undefined> {
  if (agent === "pr") {
    // ABD 12 aylık takvim: resmî tatiller ve tarihi kesin günler; organizatör tarihli etkinlikler yalnızca sahip doğruladıysa
    const { prCalendar } = await import("@/lib/services/pr-agency");
    const { events, unverified } = await prCalendar(brandId);
    return `<us_calendar_12m><data>${JSON.stringify({ events: events.map((e) => ({ id: e.id, name: e.name, date: e.date, kind: e.kind, date_basis: e.dateBasis })), unverified_dates: unverified.map((u) => u.name) })}</data></us_calendar_12m>`;
  }
  if (agent === "finance") {
    assertTool("finance", "finance.read");
    const [byService, byDay, limits] = await Promise.all([costSummary(brandId, "service"), costSummary(brandId, "day"), getLimits()]);
    return `<cost_records><data>${JSON.stringify({ by_service: byService, by_day: byDay })}</data></cost_records>\n<budget_limits><data>${JSON.stringify({ daily_ai_budget_usd: limits.dailyBudgetUsd, task_budget_usd: limits.perTaskBudgetUsd, provider_monthly_usd: limits.providerMonthlyUsd })}</data></budget_limits>\n<performance_data><data>No revenue or performance source is connected. Do not invent amounts.</data></performance_data>`;
  }
  if (agent !== "quality") return undefined;
  const [costs, statuses] = await Promise.all([
    costSummary(brandId, "service"),
    Promise.all(PROVIDERS.map(async (p) => ({ provider: p.name, status: (await effectiveStatus(p.id, brandId)).status }))),
  ]);
  return `<cost_records><data>${JSON.stringify(costs)}</data></cost_records>\n<connections><data>${JSON.stringify(statuses)}</data></connections>\n<performance_data><data>No performance source is connected. Do not invent metrics.</data></performance_data>`;
}

/** Render görevleri (ffmpeg) ve planlama için ayrı, daha uzun süre sınırı. */
export function effectiveTimeoutMs(task: Pick<Task, "kind">, limits: Limits) {
  if (task.kind === "render") return Math.max(limits.taskTimeoutMs, limits.renderTimeoutMs ?? 0);
  if (task.kind === "plan") return Math.max(limits.taskTimeoutMs, PLAN_TIMEOUT_MS);
  return limits.taskTimeoutMs;
}

/** Plan dosya üretimi içeriyor mu (kurgu veya AI video)? */
export function videoNeedsArtifact(content: any) {
  return (content?.videos ?? []).some((v: any) => v.mode === "edit_existing" || v.mode === "generate_new" || v.mode === "compose");
}

/**
 * Render sonucunda planın her teslim öğesi için GERÇEK bir MP4 var mı? Teslimler: her edit_existing ve compose kurgusu;
 * planda compose yoksa her generate_new sahnesi (compose varsa AI sahneleri ara üründür, teslim compose'dur).
 * `videoAssets`: bu render'ın ürettiği/teslim ettiği, depoda doğrulanmış video dosyaları (ref etiketiyle).
 */
export function missingVideoDeliverables(content: any, videoAssets: { ref: string | null }[]): string[] {
  const vids: any[] = content?.videos ?? [];
  const hasCompose = vids.some((v) => v.mode === "compose");
  const due = vids.filter((v) => v.mode === "edit_existing" || v.mode === "compose" || (v.mode === "generate_new" && !hasCompose));
  const refs = new Set(videoAssets.map((a) => a.ref));
  return due.filter((v) => !refs.has(String(v.id))).map((v) => `${v.id} (${v.mode})`);
}

/**
 * Projenin Video Stüdyosu talebi (proje talimatından; yönetici talimatı yeniden yazsa da korunur).
 * Ürün fotoğrafı kimlikleri yalnızca bu markanın raster fotoğraflarıysa kabul edilir. Google Drive arşivinden alınmış
 * bir fotoğrafın referansı sonradan doğrulanmamış/reddedilmiş duruma geçtiyse o fotoğraf AI isteğine girmez.
 */
export async function studioForProject(brandId: string, projectId: string): Promise<StudioRequest | null> {
  const project = await q1<{ instruction: string }>(`SELECT instruction FROM projects WHERE id = $1 AND brand_id = $2`, [projectId, brandId]);
  const req = parseStudioRequest(project?.instruction);
  if (!req) return null;
  const ok = req.photoIds.length
    ? await q<{ id: string }>(
        `SELECT m.id FROM media_assets m WHERE m.brand_id = $1 AND m.id = ANY($2::uuid[]) AND m.kind = 'photo' AND m.mime_type = ANY($3::text[])
           AND NOT EXISTS (SELECT 1 FROM drive_references r WHERE r.brand_id = m.brand_id AND r.media_asset_id = m.id AND r.status <> 'verified')`,
        [brandId, req.photoIds, ["image/jpeg", "image/png", "image/webp"]],
      )
    : [];
  const valid = new Set(ok.map((r) => r.id));
  return { ...req, photoIds: req.photoIds.filter((id) => valid.has(id)) };
}

function studioBlock(st: StudioRequest, limits: Limits) {
  const data = {
    mode: st.mode, ai_scenes: st.aiScenes, scene_seconds: st.sceneSeconds, product_photo_ids: st.photoIds, collection: st.collection ?? null,
    licensed_music: !!st.musicId, extra_format: st.extraFormat ?? null, ai_only: !!st.aiOnly, ad_seconds: st.minSeconds ? [st.minSeconds, st.maxSeconds] : null,
    max_ai_video_seconds_per_project: limits.maxVideoGenSeconds, paid_generation_enabled: limits.paidMediaGeneration,
  };
  const rules = st.mode === "archive" ? "Use only analysed archive footage (edit_existing)." : [
    `The owner chose the "${st.mode}" studio mode in Video Studio: a cinematic AI ad, not an archive-only edit.`,
    `Return exactly ${st.aiScenes} "generate_new" videos (one AI scene each, ${st.sceneSeconds} s, format 9:16) and ONE "compose" video that assembles the final ad.`,
    `Every generate_new scene: a vivid cinematic generation_prompt in English (subject, setting, light, camera movement, mood; no on-screen text) and selected_asset_ids = the product_photo_ids, so the real product photos are sent as references and the print, colours, logo and cut stay unchanged.`,
    st.aiOnly
      ? `The compose video lists "parts" in output order and contains ONLY "ai_scene" parts (ref = a generate_new id). The owner forbids photo zoom/pan or slideshow parts: no "product_photo" and no "archive_clip". Real product photos are used only as Gemini references (selected_asset_ids).${st.minSeconds ? ` Total length must be at least ${st.minSeconds} s.` : ""}`
      : `The compose video lists "parts" in output order: every AI scene ("ai_scene", ref = its id)${st.photoIds.length ? ', at least one "product_photo" part (ref = a product_photo_id, 1.5-4 s, a camera motion) so the real product is shown as photographed' : ""}${st.mode === "hybrid" ? ', and analysed archive scenes ("archive_clip", inside verified scene limits) when they fit' : ""}.`,
    ...(st.collection ? [`Collection: "${st.collection}". Every product reference and every description must match this collection's confirmed colour and print (see <brand_context>.knowledge.collections). Never mention another collection, colour or logo.`] : []),
    ...(st.aiScenes > 3 ? [`This is a long cinematic ad: vary the scenes (wide establishing shot, model in motion, macro close-up of the print and fabric texture, back-print reveal, product hero shot, energetic finale), and alternate AI scenes with product_photo parts so the real product is seen regularly.`] : []),
    ...(st.musicId ? ["The owner's licensed music track is added by the system under the whole ad; plan scene lengths with a steady rhythm (cuts every 2-4 s inside parts) and a strong final beat on the closing card."] : []),
    `Give the compose video a short hook as on_screen_text of the first part, a CTA on the last part, outro_text with the brand name (closing card with the logo), transition "fade" and framing "fill". Keep the total within the requested length.`,
  ].join("\n");
  return `<studio_request>\n<data>${JSON.stringify(data)}</data>\n${rules}\n</studio_request>`;
}

// ---------------------------------------------------------------- Video analizi kapısı

const VIDEO_ANALYSIS_MAX_WAIT_MS = 30 * 60_000;
const VIDEO_ANALYSIS_POLL_MS = 5_000;

type VideoTarget = { id: string; filename: string; requested: boolean; analysis: MediaAnalysis };
type VideoGate = { hold: boolean; targets: VideoTarget[]; skipped: string[]; images?: GenerateRequest<unknown>["images"] };

/**
 * Talimatta açıkça istenen videoları bulur (kimlik veya dosya adı; yalnızca bu markanın dosyaları).
 * Hiçbiri anılmadıysa en yeni 3 gerçek çekim aday olur.
 */
export async function resolveVideoTargets(brandId: string, text: string): Promise<{ assets: MediaAsset[]; explicit: boolean }> {
  const ids = [...new Set((text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []).map((x) => x.toLowerCase()))];
  const explicit = await q<MediaAsset>(
    `SELECT * FROM media_assets WHERE brand_id = $1 AND kind = 'video' AND (
       id = ANY($2::uuid[])
       OR strpos(lower($3), lower(filename)) > 0
       OR (length(regexp_replace(filename, '\\.[^.]+$', '')) >= 6 AND strpos(lower($3), lower(regexp_replace(filename, '\\.[^.]+$', ''))) > 0))
     ORDER BY created_at DESC LIMIT 6`,
    [brandId, ids, text],
  );
  if (explicit.length) return { assets: explicit, explicit: true };
  const recent = await q<MediaAsset>(`SELECT * FROM media_assets WHERE brand_id = $1 AND kind = 'video' AND origin = 'real_video' ORDER BY created_at DESC LIMIT 3`, [brandId]);
  return { assets: recent, explicit: false };
}

/**
 * Video uzmanı çalışmadan önce: hedef videoların gerçek analizi tamamlanmış olmalı.
 * Eksikse mevcut analiz hattı başlatılır; küçük dosyalar burada işlenir, büyükler kuyrukta beklenir (görev "Hazır"
 * durumuna dönüp sonra tekrar dener, deneme hakkı tüketmez). Açıkça istenen bir videonun analizi başarısızsa görev
 * başarısız olur — sahne uydurulmaz.
 */
async function videoAnalysisGate(ctx: RunCtx, workerId: string): Promise<VideoGate> {
  const { task } = ctx;
  assertTool("video", "media.read");
  const project = await q1<{ instruction: string }>(`SELECT instruction FROM projects WHERE id = $1 AND brand_id = $2`, [task.project_id, task.brand_id]);
  const { assets, explicit } = await resolveVideoTargets(task.brand_id, `${task.instruction}\n${project?.instruction ?? ""}`);
  const targets: VideoTarget[] = [];
  const pending: string[] = [];
  const skipped: string[] = [];
  for (const a of assets) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const g = await ensureAnalysis(a, { workerId });
    if (g.state === "completed") targets.push({ id: a.id, filename: a.filename, requested: explicit, analysis: g.analysis });
    else if (g.state === "pending") pending.push(`${a.filename} (${g.reason})`);
    else if (explicit) {
      throw new PermanentError(`Video analizi başarısız: ${a.filename} — ${g.error}. Sahne uydurulmadı; dosyayı kontrol edip medya sayfasında "Yeniden analiz et" deyin.`);
    } else skipped.push(`${a.filename}: analiz başarısız (${g.error})`);
  }
  if (pending.length) {
    const since = Date.parse(String(task.input_refs?.analysis_wait_since ?? "")) || Date.now();
    if (Date.now() - since > VIDEO_ANALYSIS_MAX_WAIT_MS) {
      throw new PermanentError(`Video analizi ${Math.round(VIDEO_ANALYSIS_MAX_WAIT_MS / 60_000)} dakikada tamamlanmadı: ${pending.join("; ")}. İşleyiciyi ve medya sayfasındaki analiz durumunu kontrol edin.`);
    }
    await q(`UPDATE tasks SET input_refs = COALESCE(input_refs, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [task.id, JSON.stringify({ analysis_wait_since: new Date(since).toISOString() })]);
    await finish(task, workerId, { status: "ready", error: `Video analizi bekleniyor: ${pending.join("; ")}`, nextAttemptMs: VIDEO_ANALYSIS_POLL_MS });
    return { hold: true, targets, skipped };
  }
  // Gerçek kareleri modele göstermek ücretlidir: yalnızca sahip ayarı açıksa ve gerçek model bağlıysa
  let images: VideoGate["images"];
  if (targets.length && !ctx.model.isDemo && (await getSetting<boolean>("video_agent_frames", false))) {
    images = [];
    for (const t of targets) {
      for (const f of analysisFrames(t.analysis).slice(0, 4)) {
        if (images.length >= 12) break;
        images.push({ mediaType: "image/jpeg", base64: (await getStorage().get(f.key)).toString("base64"), label: `${t.filename} · sahne ${f.scene ?? "?"} · ${f.t} sn` });
      }
    }
  }
  return { hold: false, targets, skipped, images };
}

function videoTargetsBlock(v: VideoGate) {
  const list = v.targets.map((t) => ({ asset_id: t.id, filename: t.filename, requested: t.requested, verified_analysis: compactAnalysis(t.analysis) }));
  return `<video_sources>\n<data>${JSON.stringify({ analysed_videos: list, unusable: v.skipped })}</data>\nOnly these analysed videos may be used for edit_existing segments.\n</video_sources>`;
}

async function runGenerate(ctx: RunCtx, workerId: string) {
  const { task } = ctx;
  if (!isSpecialist(task.agent)) throw new PermanentError(`Bilinmeyen uzman: ${task.agent}`);
  const agent = task.agent;
  assertTool(agent, "brand.read");
  // Video Stüdyosu talebi (AI/karma modunda arşiv analizi beklenmez; yalnızca AI modunda arşiv gerekmez)
  const studio = agent === "video" ? await studioForProject(task.brand_id, task.project_id) : null;
  // Video: kurgu planından ÖNCE gerçek analiz (kareler, sahneler). Analiz yoksa başlatılır; bitene kadar görev bekler.
  const video = agent === "video" ? (studio?.mode === "ai" ? { hold: false, targets: [], skipped: [] } as VideoGate : await videoAnalysisGate(ctx, workerId)) : null;
  if (video?.hold) return;
  const brandCtx = await buildBrandContext(task.brand_id, undefined, { agent, includeAssetIds: [...(video?.targets.map((t) => t.id) ?? []), ...(studio?.photoIds ?? [])] });
  const upstream = await upstreamOutputs(task);
  if (upstream.length) assertTool(agent, "outputs.read");
  const schema = OUTPUT_SCHEMAS[agent] as import("zod").ZodType<any>;
  // Erişim öncelikli: uzman, FriBee'ye özgü bilgi için önce rolünün görebildiği arşiv içeriğini alır (güvenilmeyen veri olarak)
  const projectInstruction = (await q1<{ instruction: string }>(`SELECT instruction FROM projects WHERE id = $1 AND brand_id = $2`, [task.project_id, task.brand_id]))?.instruction ?? null;
  const brain = await brainContextFor({ brandId: task.brand_id, agent, taskId: task.id, projectId: task.project_id, instruction: task.instruction, projectInstruction });
  const extra = [await extraForAgent(agent, task.brand_id), video ? videoTargetsBlock(video) : undefined, studio ? studioBlock(studio, ctx.limits) : undefined, brain.block].filter(Boolean).join("\n") || undefined;
  const user = userPromptParts({ instruction: task.instruction, ctx: brandCtx, upstream, feedback: task.feedback, extra });
  // Aynı talep için daha önce doğrulanmış (render'ı teknik nedenle başarısız olmuş) plan varsa yeniden kullanılır: model çağrısı yok
  const cached = agent === "video" && !task.feedback ? await cachedVideoPlan(task, ctx.model.isDemo) : null;
  if (cached) {
    log("info", "video.plan_cache_hit", { taskId: task.id, projectId: task.project_id, cachedVersionId: cached.id });
    await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: "agent:manager", action: "video.plan_cached", message: `Aynı talep için doğrulanmış önceki plan yeniden kullanıldı (model çağrısı yapılmadı; kaynak sürüm ${cached.version})` });
  }
  const res = cached
    ? { data: cached.content, generator: `cache:${cached.id}`, isDemo: cached.is_demo, model: "cache" }
    : await callModel(ctx, agent, "work", schema, user,
      { instruction: task.instruction, ctx: brandCtx, upstream, feedback: task.feedback, taskKey: task.key, videoTargets: video?.targets.map((t) => t.id) ?? [], studio },
      16000, video?.images);

  await owned(task, workerId, async (c) => {
    let outputId = task.output_id;
    if (!outputId) {
      const out = await createOutput({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, agent, kind: OUTPUT_KIND[agent], title: task.title }, c);
      outputId = out.id;
    }
    const v = await addVersion({ brandId: task.brand_id, outputId, content: res.data, createdBy: `agent:${agent}`, generator: res.generator, isDemo: res.isDemo }, c);
    await recordOutputSources(task.brand_id, v.id, brain.search, res.data, c);
    await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: `agent:${agent}`, action: "output.version", message: `${agentName(agent)} çıktı üretti: ${task.title} (sürüm ${v.version}${res.isDemo ? ", DEMO" : ""})` }, c);

    if (agent === "quality") {
      // Analiz görevi bir kalite raporudur; ayrıca incelenmez.
      await setVersionQa(v.id, { verdict: "pass", score: 0, checks: [{ name: "Analiz raporu", status: "pass", detail: "Kalite uzmanının kendi raporu; ayrıca incelenmedi." }], required_changes: [], sources: ["self"] }, c);
      await finish(task, workerId, { status: "completed", outputId, model: res.model, service: ctx.model.service }, c);
      return;
    }
    await finish(task, workerId, { status: "review_pending", phase: "review", outputId, model: res.model, service: ctx.model.service }, c);
  });
}

// ---------------------------------------------------------------- Kalite kontrol

/** Video planında yeniden üretim (yaratıcı revizyon) sınırı: teknik sorunlar AI'ya hiç gönderilmez, yaratıcı itiraz en fazla bir kez. */
export const VIDEO_PLAN_MAX_REGENERATIONS = 1;
/**
 * Kural denetiminden geçmiş bir çıktıda yalnızca model incelemesi itiraz ediyorsa en çok bu kadar yeniden üretim yapılır;
 * sonra itirazlar insan onayına danışma notu olarak taşınır. Her turda yeni ayrıntılar bulan inceleme (ör. iç notlardaki
 * analiz durumu) yeniden üretimi hiç yakınsamayan, pahalı bir döngüye sokuyordu.
 */
export const MODEL_REVIEW_MAX_REGENERATIONS = 1;
/** Deterministik doğrulayıcının onardığı teknik denetimler: onarımdan sonra hâlâ başarısızsa AI'ya geri gönderilmez, görev başarısız olur. */
const TECHNICAL_VIDEO_CHECKS = new Set(["Çekim seçimi", "Sahne bölümleri", "Sahne doğrulaması", "Altyazı zamanlaması"]);

async function runReview(ctx: RunCtx, workerId: string) {
  const { task, limits } = ctx;
  if (!task.output_id) throw new PermanentError("İncelenecek çıktı yok.");
  assertTool("quality", "outputs.read");
  let v = await getCurrentVersion(task.brand_id, task.output_id);
  if (!v) throw new PermanentError("Çıktı sürümü bulunamadı.");
  const studio = task.agent === "video" ? await studioForProject(task.brand_id, task.project_id) : null;

  // 1) Video planı: DETERMİNİSTİK teknik doğrulama ve onarım (AI çağrısı yok). Onarılamayan teknik sorun → görev başarısız,
  //    planlayıcıya "yaratıcı revizyon" olarak geri gönderilmez.
  let validation: (PlanValidation & { spec: VideoSpec }) | null = null;
  if (task.agent === "video") {
    const r = await validateVideoVersion(task, workerId, v);
    v = r.version;
    validation = r.validation;
    if (validation.errors.length) {
      const checks = validationChecks(validation);
      await assertOwned(task, workerId);
      await setVersionQa(v.id, { verdict: "fail", score: 0, checks, required_changes: [], sources: ["plan-validator"], validated: false, technical: true, reviewed_version: v.version, generator: "local:plan-validator" });
      log("error", "video.plan_invalid", { taskId: task.id, projectId: task.project_id, errors: validation.errors, repairs: validation.repairs });
      await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: "system", action: "qa.result", message: `Video planı teknik doğrulamadan geçemedi (AI'ya geri gönderilmedi): ${validation.errors.join("; ").slice(0, 400)}` });
      await finish(task, workerId, { status: "failed", failureClass: "permanent", error: `Video planı teknik doğrulamadan geçemedi (yeniden üretime gönderilmedi): ${validation.errors.join("; ").slice(0, 600)}` });
      return;
    }
  }

  // 2) Kural denetimi (deterministik)
  const brandCtx = await buildBrandContext(task.brand_id, undefined, { agent: "quality", includeAssetIds: referencedAssetIds(task.agent, v.content) });
  const rule = runRuleChecks(task.agent, v.content, brandCtx, { isDemo: v.is_demo, studio });
  if (validation) rule.checks.unshift(...validationChecks(validation));
  if (task.agent === "video") {
    const technical = rule.checks.filter((c) => c.status === "fail" && TECHNICAL_VIDEO_CHECKS.has(c.name));
    if (technical.length) {
      await assertOwned(task, workerId);
      await setVersionQa(v.id, { ...rule, sources: ["rules", "plan-validator"], validated: false, technical: true, reviewed_version: v.version, generator: "local" });
      log("error", "video.plan_invalid", { taskId: task.id, projectId: task.project_id, checks: technical });
      await finish(task, workerId, { status: "failed", failureClass: "permanent", error: `Video planı teknik doğrulamadan geçemedi (yeniden üretime gönderilmedi): ${technical.map((c) => c.detail).join("; ").slice(0, 600)}` });
      return;
    }
  }

  // 3) Model incelemesi (ücretli). Video planında kurallar geçmeden çağrılmaz: yeniden üretilecek planı incelemek boşa maliyettir.
  // Önbellekten yeniden kullanılan plan önceki çalıştırmada model incelemesinden geçmişti: tekrar ücretli inceleme yapılmaz.
  const cachedPlan = task.agent === "video" && String(v.generator ?? "").startsWith("cache:");
  const skipModel = task.agent === "video" && (rule.verdict !== "pass" || cachedPlan);
  const user = userPromptParts({ instruction: `Review the ${task.agent} output for task: ${task.instruction}`, ctx: brandCtx, target: { agent: task.agent, content: v.content } });
  const res = skipModel ? null : await callModel(ctx, "quality", "review", QaReviewSchema, user, { instruction: task.instruction, ctx: brandCtx, upstream: [], target: { agent: task.agent, content: v.content } }, 6000);
  let merged = mergeReviews(rule, (res?.data as QaReview) ?? null, res ? (res.isDemo ? "demo" : "model") : "rules");
  // Kural denetimi geçti, itiraz yalnızca model incelemesinden: yeniden üretim hakkı kısadır (video planı dahil 1)
  const modelOnly = merged.verdict !== "pass" && rule.verdict === "pass";
  const maxRegen = task.agent === "video" ? Math.min(limits.maxRegenerations, VIDEO_PLAN_MAX_REGENERATIONS)
    : modelOnly ? Math.min(limits.maxRegenerations, MODEL_REVIEW_MAX_REGENERATIONS) : limits.maxRegenerations;
  let advisory: string[] = [];
  if (modelOnly && task.regen_count >= maxRegen) {
    // Çıktı teknik ve marka kurallarından geçti; yalnızca model incelemesinin itirazı kaldı ve yeniden üretim hakkı bitti.
    // İtirazlar insan onayına uyarı olarak taşınır; çıktı insan onayı olmadan hiçbir yerde kullanılmaz.
    advisory = merged.required_changes;
    merged = {
      ...merged, verdict: "pass", required_changes: [],
      checks: merged.checks.map((c) => (c.status === "fail" && !rule.checks.includes(c) ? { ...c, status: "warn" as const, detail: `${c.detail} (danışma: insan onayında değerlendirilecek)` } : c)),
    };
  }
  await assertOwned(task, workerId);
  await setVersionQa(v.id, { ...merged, reviewed_version: v.version, generator: res?.generator ?? "local", ...(validation ? { validated: true, expected_duration: validation.expected, spec: validation.spec } : {}), ...(advisory.length ? { advisory } : {}) });
  await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: "agent:quality", action: "qa.result", message: `Kalite kontrolü (${task.title}, sürüm ${v.version}): ${merged.verdict} — puan ${merged.score}${skipModel ? (cachedPlan && rule.verdict === "pass" ? " (önbellekteki plan; model incelemesi tekrarlanmadı)" : " (model incelemesi atlandı: kural denetimi geçmedi)") : ""}${advisory.length ? " (model itirazları insan onayına danışma olarak taşındı)" : ""}` });

  if (merged.verdict === "pass") {
    // Takip görevleri, görev "tamamlandı" olmadan ÖNCE oluşturulur; böylece rapor görevi render'ı beklemeden başlayamaz.
    await spawnFollowUps(task, v, brandCtx);
    if (task.agent === "social") await createCalendarEntries(task, v);
    // Video planı: render edilen MP4 doğrulanıp insan onayı verilene kadar "tamamlandı" sayılmaz (onay kapısı outputs.decide içinde)
    const needsHuman = task.requires_approval || advisory.length > 0 || (task.agent === "video" && videoNeedsArtifact(v.content));
    await finish(task, workerId, { status: needsHuman ? "approval_pending" : "completed" });
    return;
  }
  if (task.regen_count < maxRegen) {
    await finish(task, workerId, { status: "ready", phase: "generate", feedback: merged.required_changes.join("\n") || "Kalite kontrolünde sorun bulundu.", regenInc: true });
    await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: "agent:manager", action: "task.regenerate", message: `Kalite kontrolünden geçemedi; yeniden üretime gönderildi (${task.regen_count + 1}/${maxRegen})` });
    return;
  }
  await finish(task, workerId, { status: "failed", failureClass: "quality", error: `Kalite kontrolünden geçemedi (yeniden üretim sınırı doldu): ${merged.required_changes.join("; ").slice(0, 500)}` });
}

/**
 * Video planının deterministik doğrulaması: sahibin teslim şartları (süre, kapak) talimattan, kaynaklar veritabanından.
 * Onarım yapıldıysa düzeltilmiş plan yeni sürüm olarak kaydedilir (render tam olarak bu sürümü uygular).
 */
async function validateVideoVersion(task: Task, workerId: string, v: OutputVersion) {
  const project = await q1<{ instruction: string }>(`SELECT instruction FROM projects WHERE id = $1 AND brand_id = $2`, [task.project_id, task.brand_id]);
  const spec = parseVideoSpec(project?.instruction, task.instruction);
  const targets = await resolveVideoTargets(task.brand_id, `${task.instruction}\n${project?.instruction ?? ""}`);
  const validation = { ...(await validateVideoPlan(task.brand_id, v.content, { spec, fallbackSourceIds: targets.explicit ? targets.assets.map((a) => a.id) : [] })), spec };
  let version = v;
  if (validation.changed && !validation.errors.length) {
    await assertOwned(task, workerId);
    version = await addVersion({ brandId: task.brand_id, outputId: v.output_id, content: validation.content, createdBy: "system:plan-validator", generator: "local:plan-validator", isDemo: v.is_demo });
    log("info", "video.plan_repaired", { taskId: task.id, projectId: task.project_id, fromVersion: v.version, toVersion: version.version, repairs: validation.repairs });
    await audit({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, actor: "system", action: "video.plan_repaired", message: `Video planı deterministik olarak düzeltildi (sürüm ${version.version}): ${validation.repairs.slice(0, 4).join("; ").slice(0, 400)}` });
  }
  return { version, validation };
}

function validationChecks(val: PlanValidation & { spec: VideoSpec }) {
  const checks: { name: string; status: "pass" | "warn" | "fail"; detail: string }[] = [];
  if (val.errors.length) checks.push({ name: "Plan doğrulaması (deterministik)", status: "fail", detail: val.errors.join("; ") });
  else checks.push({
    name: "Plan doğrulaması (deterministik)", status: val.repairs.length ? "warn" : "pass",
    detail: val.repairs.length ? `Otomatik düzeltildi (AI'ya geri gönderilmedi): ${val.repairs.slice(0, 8).join("; ")}` : "Kaynak kimlikleri, sahne sınırları ve süre veritabanındaki analizle doğrulandı.",
  });
  const spec = describeSpec(val.spec);
  const durations = Object.entries(val.expected).map(([id, d]) => `${id}: ${d} sn`).join(", ");
  if (spec || durations) checks.push({ name: "Teslim şartı", status: val.errors.length ? "fail" : "pass", detail: [spec && `İstenen: ${spec}`, durations && `Hesaplanan çıktı: ${durations}`].filter(Boolean).join(". ") });
  return checks;
}

/**
 * Önbellekteki doğrulanmış video planı: aynı marka, aynı sahip talimatı, kural+doğrulamadan geçmiş, insan tarafından
 * reddedilmemiş ve render'ı teknik nedenle tamamlanamamış (başarısız/bağlantı bekleyen/iptal) son plan. Tekrar denemede
 * ücretli planlama çağrısı yapılmaz; render başarılı olmuşsa yeni talep yeni plan demektir (önbellek kullanılmaz).
 */
async function cachedVideoPlan(task: Task, isDemo: boolean) {
  return q1<OutputVersion>(
    `SELECT v.* FROM output_versions v
       JOIN outputs o ON o.id = v.output_id AND o.current_version = v.version
       JOIN tasks t ON t.id = o.task_id AND t.agent = 'video' AND t.kind = 'work'
       JOIN projects p ON p.id = t.project_id
       JOIN projects cur ON cur.id = $2
     WHERE o.brand_id = $1 AND t.project_id <> $2 AND v.is_demo = $3
       AND lower(regexp_replace(btrim(p.instruction), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim(cur.instruction), '\\s+', ' ', 'g'))
       AND v.qa_report->>'verdict' = 'pass' AND (v.qa_report->>'validated') = 'true'
       AND v.created_at > now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.output_version_id = v.id AND a.revoked_at IS NULL AND a.decision = 'rejected')
       AND EXISTS (SELECT 1 FROM tasks r WHERE r.project_id = t.project_id AND r.key = t.key || '-render' AND r.status IN ('failed','waiting_connection','cancelled'))
     ORDER BY v.created_at DESC LIMIT 1`,
    [task.brand_id, task.project_id, isDemo],
  );
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
  // Dosya üretmeyen video planı için render görevi açılmaz (boş render "başarılı" görünmesin)
  if (task.agent === "video" && !videoNeedsArtifact(v.content)) return;
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
  await assertOwned(task, workerId);
  if (o.produced.length) await attachAssetsToVersion(v.id, o.produced);
  const summary = { produced: o.produced.length, waiting: o.waiting, in_progress: o.inProgress, failed: o.failed, uncertain: o.uncertain, notes: o.notes, artifacts: o.artifacts };
  await q(`UPDATE tasks SET input_refs = input_refs || $2::jsonb WHERE id = $1`, [task.id, JSON.stringify({ result: summary })]);
  const service = task.agent === "design" ? "sharp/openai_images" : "ffmpeg/video_generation";
  const made = o.produced.length ? ` (üretilen dosya: ${o.produced.length})` : "";
  log(o.failed.length || o.uncertain.length ? "warn" : "info", "render.result", {
    taskId: task.id, projectId: task.project_id, agent: task.agent, produced: o.produced.length, artifacts: o.artifacts.length,
    waiting: o.waiting, inProgress: o.inProgress, failed: o.failed, uncertain: o.uncertain,
  });
  if (o.inProgress.length) {
    // Sağlayıcı işi sürüyor: görev kuyruğa döner ve daha sonra durumu sorgular (deneme hakkı tüketmez)
    await finish(task, workerId, { status: "ready", phase: "render", error: `Sürüyor: ${o.inProgress.join(" | ")}${made}`, service, nextAttemptMs: RENDER_POLL_MS });
  } else if (o.uncertain.length) {
    await finish(task, workerId, { status: "failed", error: `Sonucu belirsiz ücretli işlem: ${o.uncertain.join(" | ")}${made}`, service, failureClass: "uncertain" });
  } else if (o.failed.length) {
    await finish(task, workerId, { status: "failed", error: `Başarısız öğeler: ${o.failed.join(" | ")}${made}`, service, failureClass: "permanent" });
  } else if (o.waiting.length) {
    await finish(task, workerId, { status: "waiting_connection", error: `Bağlantı/izin bekleyen öğeler: ${o.waiting.join(" | ")}${made}`, service, failureClass: "connection" });
  } else if (task.agent === "video" && (await videoDeliverablesMissing(task, v, o)).length) {
    // Gerçek, depoda doğrulanmış MP4 olmadan video görevi asla "tamamlandı" sayılmaz
    const missing = await videoDeliverablesMissing(task, v, o);
    const planned = (v.content?.videos ?? []).map((x: any) => `${x.id}:${x.mode}`).join(", ") || "plan video öğesi içermiyor";
    log("error", "render.no_mp4", { taskId: task.id, projectId: task.project_id, missing, planned });
    await finish(task, workerId, { status: "failed", error: `MP4 üretilmedi: ${missing.join(", ") || "teslim edilecek video yok"} (plan: ${planned})${made}`, service, failureClass: "permanent" });
  } else {
    await finish(task, workerId, { status: "completed", error: o.notes.length ? o.notes.join(" | ") : null, service: task.agent === "design" ? "sharp (yerel)" : "ffmpeg (yerel)" });
  }
}

/** Bu render'ın teslim ettiği, depoda gerçekten bulunan video dosyaları ile planın teslimleri karşılaştırılır. */
async function videoDeliverablesMissing(task: Task, v: OutputVersion, o: { produced: string[] }) {
  const rows = o.produced.length
    ? await q<{ id: string; storage_key: string; size_bytes: string; tags: { tag: string }[] }>(
        `SELECT id, storage_key, size_bytes, tags FROM media_assets WHERE brand_id = $1 AND id = ANY($2::uuid[]) AND kind = 'video'`,
        [task.brand_id, o.produced],
      )
    : [];
  const verified: { ref: string | null }[] = [];
  for (const r of rows) {
    if (!(Number(r.size_bytes) > 0) || !(await getStorage().exists(r.storage_key))) continue;
    const ref = (r.tags ?? []).map((t) => t.tag).find((t) => t.startsWith("ref:"))?.slice(4) ?? null;
    verified.push({ ref });
  }
  if (!videoNeedsArtifact(v.content)) return ["teslim edilecek video öğesi yok"];
  return missingVideoDeliverables(v.content, verified);
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
  const text = [
    `Rapor: ${report.headline}.`,
    report.summary,
    report.completed.length ? `\nTamamlanan:\n${report.completed.map((x) => `• ${x}`).join("\n")}` : "",
    report.pending_approvals.length ? `\nOnay bekleyen:\n${report.pending_approvals.map((x) => `• ${x}`).join("\n")}` : "",
    report.missing_connections.length ? `\nBağlantı bekleyen:\n${report.missing_connections.map((x) => `• ${x}`).join("\n")}` : "",
    report.problems.length ? `\nSorunlar:\n${report.problems.map((x) => `• ${x}`).join("\n")}` : "",
    `\nMaliyet: tahmini ${fmtUsd(costs?.est)}, gerçekleşen ${fmtUsd(costs?.act)}${costs?.unknown ? `, ${costs.unknown} kayıt bilinmiyor` : ""}.`,
  ].filter(Boolean).join("\n");
  await owned(task, workerId, async (c) => {
    const out = await createOutput({ brandId: task.brand_id, projectId: task.project_id, taskId: task.id, agent: "manager", kind: "project_report", title: "Proje raporu" }, c);
    await addVersion({ brandId: task.brand_id, outputId: out.id, content: report, createdBy: "agent:manager", generator: "local", isDemo: false }, c);
    await q(`UPDATE projects SET report = $2, updated_at = now() WHERE id = $1`, [task.project_id, JSON.stringify(report)], c);
    await q(`INSERT INTO chat_messages (brand_id, project_id, role, content, data) VALUES ($1,$2,'manager',$3,$4)`, [task.brand_id, task.project_id, text, JSON.stringify({ report: true })], c);
    await finish(task, workerId, { status: "completed", outputId: out.id, service: "local" }, c);
  });
}

function fmtUsd(n: number | null | undefined) {
  return n === null || n === undefined ? "bilinmiyor" : `$${Number(n).toFixed(4)}`;
}
