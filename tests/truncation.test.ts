import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { Engine, TRUNCATION_RETRY_MAX_TOKENS } from "@/lib/orchestrator/engine";
import { submitInstruction } from "@/lib/orchestrator/projects";
import { setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import { getLimits, setSetting } from "@/lib/settings";
import { OutputTruncatedError, type GenerateRequest, type GenerateResult, type TextModelAdapter } from "@/lib/models/types";
import { key, runUntilIdle } from "./helpers";

// Çıktı sınırı (29 Ekim 2026, canlı): 14 günlük sosyal medya takvimi 16K token sınırında kesildi; görev aynı sınırla
// tekrar denendi (her deneme yine kesilir) ve kesilen çağrıların ücreti maliyet kaydına hiç yazılmadı.

/** Pazarlama üretimi `wideOk` değilse veya 32K'nın altındaki sınırda kesilir. Her çağrı süre sınırını zorlamak için bekler. */
class TruncatingModel implements TextModelAdapter {
  readonly id = "truncating";
  readonly isDemo = true;
  readonly service = "truncating";
  calls: number[] = [];
  private demo = new DemoAdapter();
  constructor(private wideOk: boolean, private delayMs = 0) {}
  // Görev başı 1 $ sınırını sınamak için: geniş sınırlı çağrının tahmini tek başına sınırı aşar
  estimateCostUsd(req: { maxTokens: number }) { return req.maxTokens >= TRUNCATION_RETRY_MAX_TOKENS ? 1.2 : 0.3; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    if (req.agent !== "marketing" || req.purpose !== "work") return this.demo.generate(req);
    this.calls.push(req.maxTokens);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (!this.wideOk || req.maxTokens < TRUNCATION_RETRY_MAX_TOKENS) throw new OutputTruncatedError(req.maxTokens, 0.7, { input_tokens: 1000, output_tokens: req.maxTokens });
    return { ...(await this.demo.generate(req)), actualCostUsd: 0.3 };
  }
}

let brandId: string;
let savedLimits: unknown;

beforeAll(async () => {
  brandId = (await createBrand({ name: "Çıktı Sınırı", content_language: "tr" })).id;
  savedLimits = await getLimits();
});
afterAll(async () => {
  setTextModelOverride(null);
  await setSetting("limits", savedLimits);
});

async function marketingTask(projectId: string) {
  return (await q1<{ id: string; status: string; error: string | null; attempts: number; cost_actual_usd: string }>(
    `SELECT id, status, error, attempts, cost_actual_usd FROM tasks WHERE project_id = $1 AND agent = 'marketing' AND kind = 'work' ORDER BY created_at LIMIT 1`, [projectId]))!;
}

describe("Model çıktısı token sınırında kesilince", () => {
  it("kesilen çağrının ücreti kaydedilir, çağrı bir kez geniş sınırla yapılır ve görev tamamlanır; süre ve görev başı sınır engel olmaz", async () => {
    // Görev süresi 1,5 sn: iki çağrı (2 × 0,9 sn) uzatma olmadan sığmaz
    await setSetting("limits", { ...(await getLimits()), taskTimeoutMs: 1500, perTaskBudgetUsd: 1, dailyBudgetUsd: 20 });
    const model = new TruncatingModel(true, 900);
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: "Yeni koleksiyon için kampanya stratejisi hazırla", idempotencyKey: key() });
    await runUntilIdle(new Engine("truncation-ok"));

    const t = await marketingTask(project.id);
    expect(t.error ?? "").not.toMatch(/kesildi|süre sınırı|bütçe/i);
    expect(["approval_pending", "completed"]).toContain(t.status);
    expect(t.attempts).toBe(1);
    // İlk çağrı 16K'da kesildi, devamı 32K; aynı adımın sonraki çağrıları (yeniden üretim) doğrudan 32K
    expect(model.calls[0]).toBe(16000);
    expect(model.calls.slice(1).length).toBeGreaterThan(0);
    for (const c of model.calls.slice(1)) expect(c).toBe(TRUNCATION_RETRY_MAX_TOKENS);

    const truncated = await q<{ amount_usd: string; units: any; note: string }>(
      `SELECT amount_usd, units, note FROM cost_entries WHERE task_id = $1 AND kind = 'actual' AND units ? 'truncated_step'`, [t.id]);
    expect(truncated).toHaveLength(1);
    expect(Number(truncated[0].amount_usd)).toBeCloseTo(0.7);
    expect(truncated[0].units).toMatchObject({ truncated_step: "marketing:work", output_tokens: 16000 });
    expect(truncated[0].note).toMatch(/16000 token sınırında kesildi/);
    // Görev maliyeti kesilen çağrıyı da gösterir (para gitti, raporda görünür)
    expect(Number(t.cost_actual_usd)).toBeGreaterThanOrEqual(1);
  });

  it("geniş sınırda da kesilirse görev aynı çağrıları tekrarlamadan kalıcı hatayla durur", async () => {
    await setSetting("limits", { ...(await getLimits()), taskTimeoutMs: 180_000 });
    const model = new TruncatingModel(false);
    setTextModelOverride(model);
    const { project } = await submitInstruction({ brandId, instruction: "Yeni koleksiyon için kampanya stratejisi hazırla", idempotencyKey: key() });
    await runUntilIdle(new Engine("truncation-fail"));

    const t = await marketingTask(project.id);
    expect(t.status).toBe("failed");
    expect(t.error).toMatch(/32000 token sınırında da kesildi/);
    expect(t.attempts).toBe(1);
    expect(model.calls).toEqual([16000, TRUNCATION_RETRY_MAX_TOKENS]);
    const n = await q1<{ n: number; s: string }>(
      `SELECT count(*)::int AS n, sum(amount_usd) AS s FROM cost_entries WHERE task_id = $1 AND kind = 'actual' AND units ? 'truncated_step'`, [t.id]);
    expect(n).toMatchObject({ n: 2 });
    expect(Number(n!.s)).toBeCloseTo(1.4);
  });
});
