import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { Engine, MODEL_REVIEW_MAX_REGENERATIONS } from "@/lib/orchestrator/engine";
import { submitInstruction } from "@/lib/orchestrator/projects";
import { getReviewModel, setTextModelOverride } from "@/lib/models";
import { AnthropicAdapter } from "@/lib/models/anthropic";
import { DemoAdapter } from "@/lib/models/demo";
import { runBrainTick } from "@/lib/brain/worker";
import { MAX_CONTENT_BYTES, MAX_SHEET_BYTES } from "@/lib/brain/ingest";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "@/lib/models/types";
import { key, runUntilIdle } from "./helpers";

// Maliyet korumaları (29 Ekim 2026): her turda yeni ayrıntıya itiraz eden model incelemesi yeniden üretimi yakınsamayan
// ve pahalı bir döngüye sokuyordu (strateji ve tasarım 4'er kez üretildi, sonunda başarısız). Kural denetimi geçen
// çıktıda yalnızca model itirazı kalırsa en çok 1 yeniden üretim yapılır; sonra itirazlar insan onayına danışma notudur.

/** Demo üretim; kalite incelemesi HER ZAMAN yeni bir itiraz bulur. Çağrılar sayılır. */
class NitpickingReviewer implements TextModelAdapter {
  readonly id = "nitpicking";
  readonly isDemo = true;
  readonly service = "nitpicking";
  calls: { agent: string; purpose: string }[] = [];
  private demo = new DemoAdapter();
  estimateCostUsd() { return 0; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.calls.push({ agent: req.agent, purpose: req.purpose });
    if (req.purpose === "review") {
      const n = this.calls.filter((c) => c.purpose === "review").length;
      return { data: { verdict: "needs_changes", score: 60, checks: [{ name: "İç notlar", status: "fail", detail: `ayrıntı ${n}` }], required_changes: [`İç nottaki ${n}. ayrıntıyı düzeltin.`] } as T, generator: this.id, isDemo: true, model: this.id, usage: null, actualCostUsd: 0 };
    }
    return this.demo.generate(req);
  }
}

const model = new NitpickingReviewer();
let brandId: string;

beforeAll(async () => {
  setTextModelOverride(model);
  brandId = (await createBrand({ name: "Maliyet Koruması", content_language: "tr" })).id;
});
afterAll(() => setTextModelOverride(null));

describe("Maliyet korumaları", () => {
  it("yalnızca model incelemesi itiraz ediyorsa en çok 1 yeniden üretim; sonra çıktı danışma notlarıyla onaya gider, başarısız sayılmaz", async () => {
    const { project } = await submitInstruction({ brandId, instruction: "Yeni koleksiyon için kampanya stratejisi hazırla", idempotencyKey: key() });
    await runUntilIdle(new Engine("cost-guard"));
    const tasks = await q<{ id: string; agent: string; kind: string; status: string; regen_count: number; failure_class: string | null }>(
      `SELECT id, agent, kind, status, regen_count, failure_class FROM tasks WHERE project_id = $1`, [project.id]);
    const work = tasks.filter((t) => t.kind === "work");
    expect(work.length).toBeGreaterThan(0);
    // Hiçbir görev model itirazı yüzünden başarısız olmadı; bağlı görevler iptal edilmedi
    expect(tasks.filter((t) => t.failure_class === "quality" || t.failure_class === "dependency")).toEqual([]);
    for (const t of work) expect(t.regen_count).toBeLessThanOrEqual(MODEL_REVIEW_MAX_REGENERATIONS);

    const marketing = work.find((t) => t.agent === "marketing")!;
    expect(marketing.status).toBe("approval_pending");
    const gens = model.calls.filter((c) => c.agent === "marketing" && c.purpose !== "review").length;
    expect(gens).toBe(1 + MODEL_REVIEW_MAX_REGENERATIONS);
    const qa = (await q1<{ qa: any }>(
      `SELECT v.qa_report AS qa FROM tasks t JOIN outputs o ON o.id = t.output_id JOIN output_versions v ON v.output_id = o.id AND v.version = o.current_version WHERE t.id = $1`, [marketing.id]))!.qa;
    expect(qa.verdict).toBe("pass");
    expect(qa.advisory.join(" ")).toMatch(/ayrıntıyı düzeltin/);
  });

  it("kalite incelemesi ucuz modelde yapılır (gerçek modda); test/demo adaptöründe ana adaptör kalır", () => {
    expect(getReviewModel(model)).toBe(model);
    setTextModelOverride(null);
    const prev = process.env.AIOPS_ANTHROPIC_API_KEY;
    process.env.AIOPS_ANTHROPIC_API_KEY = "test-key-not-used";
    try {
      const main = new AnthropicAdapter("claude-opus-5-5");
      expect(getReviewModel(main).id).toBe("anthropic:claude-sonnet-5-5");
    } finally {
      if (prev === undefined) delete process.env.AIOPS_ANTHROPIC_API_KEY; else process.env.AIOPS_ANTHROPIC_API_KEY = prev;
      setTextModelOverride(model);
    }
  });

  it("video render'ı sürerken arşiv okuma (Brand Brain) durur; büyük dosyalar belleğe alınmaz", async () => {
    const p = (await q1<{ id: string }>(`SELECT id FROM projects WHERE brand_id = $1 LIMIT 1`, [brandId]))!;
    const t = (await q1<{ id: string }>(
      `INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status) VALUES ($1,$2,'render-x','video','render','Render','r','running') RETURNING id`, [brandId, p.id]))!;
    expect(await runBrainTick("cost-guard")).toEqual([]);
    await q(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [t.id]);
    expect(MAX_CONTENT_BYTES).toBeLessThanOrEqual(15 * 1024 * 1024);
    expect(MAX_SHEET_BYTES).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});
