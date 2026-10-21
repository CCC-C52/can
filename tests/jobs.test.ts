import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { q, q1 } from "@/lib/db/pool";
import { Engine } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks } from "@/lib/orchestrator/projects";
import { createBrand } from "@/lib/services/brands";
import { setSetting, DEFAULT_LIMITS } from "@/lib/settings";
import { setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import { PermanentError, type GenerateRequest, type GenerateResult, type TextModelAdapter } from "@/lib/models/types";
import type { Plan } from "@/lib/agents/schemas";
import { key, runUntilIdle } from "./helpers";

const plan: Plan = { reply: "plan", goals: ["g"], questions_for_owner: [], tasks: [{ key: "strategy", agent: "marketing", title: "Strateji", instruction: "Strateji", depends_on: [] }] } as Plan;

/** Uzman çağrısında davranışı testten belirlenen model. */
class Behaviour implements TextModelAdapter {
  readonly id = "behaviour";
  readonly isDemo = true;
  readonly service = "behaviour";
  calls = 0;
  private demo = new DemoAdapter();
  constructor(private work: (req: GenerateRequest<any>, n: number) => Promise<void>) {}
  estimateCostUsd() { return 0; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    if (req.agent === "manager" && req.purpose === "plan") return { data: req.schema.parse(plan), generator: "scripted", isDemo: true, model: "scripted", usage: null, actualCostUsd: 0 };
    if (req.purpose === "work") await this.work(req, ++this.calls);
    return this.demo.generate(req);
  }
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

let brandId: string;
beforeAll(async () => { brandId = (await createBrand({ name: "Jobs Brand", content_language: "en" })).id; });
afterEach(async () => { setTextModelOverride(null); await setSetting("limits", {}); });

async function start(model: Behaviour) {
  setTextModelOverride(model);
  const { project } = await submitInstruction({ brandId, instruction: `iş ${key()}`, idempotencyKey: key() });
  return project.id;
}
const strategyOf = async (projectId: string) => (await listTasks(brandId, { projectId })).find((t) => t.key === "strategy")!;

describe("Görev yeniden deneme ve kurtarma", () => {
  it("süre aşımı: sınırlı sayıda yeniden denenir, sonra 'Süre aşımı' sınıfıyla başarısız olur", async () => {
    await setSetting("limits", { ...DEFAULT_LIMITS, taskTimeoutMs: 300, maxAttempts: 2 });
    const model = new Behaviour((req) => sleep(5_000, req.signal));
    const projectId = await start(model);
    const engine = new Engine("jobs-timeout");
    for (let i = 0; i < 30; i++) {
      await q(`UPDATE tasks SET next_attempt_at = now() WHERE project_id = $1 AND next_attempt_at > now()`, [projectId]);
      await engine.tick();
      await engine.waitInflight();
      if ((await strategyOf(projectId)).status === "failed") break;
    }
    const t = await strategyOf(projectId);
    expect(t.status).toBe("failed");
    expect(t.failure_class).toBe("timeout");
    expect(model.calls).toBe(2);
    const attempts = await q<{ outcome: string }>(`SELECT outcome FROM task_attempts WHERE task_id = $1 ORDER BY started_at`, [t.id]);
    expect(attempts.map((a) => a.outcome)).toEqual(["retry", "failed"]);
  });

  it("kalıcı hata yeniden denenmez", async () => {
    const model = new Behaviour(async () => { throw new PermanentError("şema reddedildi"); });
    const projectId = await start(model);
    await runUntilIdle(new Engine("jobs-perm"));
    const t = await strategyOf(projectId);
    expect(t.status).toBe("failed");
    expect(t.failure_class).toBe("permanent");
    expect(model.calls).toBe(1);
  });

  it("aynı görev iki işleyiciye aynı anda verilmez", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = new Behaviour(() => gate);
    const projectId = await start(model);
    const e0 = new Engine("jobs-plan");
    await e0.tick(); await e0.waitInflight(); // yalnızca plan (strateji görevi bir sonraki tick'te hazırlanıp alınır)
    const [a, b] = [new Engine("jobs-dup-a"), new Engine("jobs-dup-b")];
    const claimed = await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    release();
    await Promise.all([a.waitInflight(), b.waitInflight()]);
    expect(claimed.reduce((x, y) => x + y, 0)).toBe(1);
    expect(model.calls).toBe(1);
    await runUntilIdle(a);
    expect((await strategyOf(projectId)).status).toBe("completed");
  });

  it("kiralaması elinden alınan (yavaş) işleyici sonucu yazamaz: tek çıktı sürümü", async () => {
    let first = true;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const model = new Behaviour(async () => { if (first) { first = false; await firstGate; } });
    const projectId = await start(model);
    const e0 = new Engine("jobs-plan2");
    await e0.tick(); await e0.waitInflight();
    const slow = new Engine("jobs-slow");
    await slow.tick(); // strateji görevi alındı, model çağrısında bekliyor
    const t = await strategyOf(projectId);
    expect(t.lease_owner).toBe("jobs-slow");
    // İşleyici "yanıt vermiyor": kiralama süresi doldu, başka işleyici devralıp bitirir
    await q(`UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [t.id]);
    const fast = new Engine("jobs-fast");
    await runUntilIdle(fast);
    expect((await strategyOf(projectId)).status).toBe("completed");
    // Yavaş işleyici şimdi dönüyor
    releaseFirst();
    await slow.waitInflight();
    const after = await strategyOf(projectId);
    expect(after.status).toBe("completed");
    expect(after.lease_owner).toBeNull();
    const versions = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM output_versions v JOIN outputs o ON o.id = v.output_id WHERE o.task_id = $1`, [t.id]);
    expect(versions!.n).toBe(1);
  });
});
