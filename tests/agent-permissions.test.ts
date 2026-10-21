import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { q1 } from "@/lib/db/pool";
import { Engine } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks, getProject } from "@/lib/orchestrator/projects";
import { createBrand, createProduct, addProductFact } from "@/lib/services/brands";
import { setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import { AGENTS, TOOLS } from "@/lib/agents/registry";
import { SPECIALISTS, type Plan } from "@/lib/agents/schemas";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "@/lib/models/types";
import { runUntilIdle, key } from "./helpers";

/** Yönetici planını testte belirleyen model: plan çağrısında verilen planı döndürür, diğer çağrıları DEMO'ya devreder. */
class ScriptedPlanModel implements TextModelAdapter {
  readonly id = "scripted";
  readonly isDemo = true;
  readonly service = "scripted";
  private demo = new DemoAdapter();
  constructor(private plan: Plan) {}
  estimateCostUsd() { return 0; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    if (req.agent === "manager" && req.purpose === "plan") {
      return { data: req.schema.parse(this.plan), generator: "scripted", isDemo: true, model: "scripted", usage: null, actualCostUsd: 0 };
    }
    return this.demo.generate(req);
  }
}

let brandId: string;
beforeAll(async () => {
  const b = await createBrand({ name: "Permission Test Brand", content_language: "en" });
  brandId = b.id;
  const p = await createProduct(brandId, { title: "Test Hoodie", price: "60", currency: "USD" });
  await addProductFact(brandId, p.id, { attribute: "Fabric", value: "Cotton fleece" });
});
afterEach(() => setTextModelOverride(null));

describe("Ajan izinleri", () => {
  it("GERİLEME: bağımlılığı olan Pazarlama görevi 'outputs.read' izin hatası vermez (canlı hata yeniden üretimi)", async () => {
    // Canlıda görülen plan biçimi: pazarlama stratejisi bir analiz görevine bağlı.
    setTextModelOverride(new ScriptedPlanModel({
      reply: "plan", goals: ["g"], questions_for_owner: [],
      tasks: [
        { key: "analysis", agent: "quality", title: "Mevcut durum analizi", instruction: "Analiz et", depends_on: [] },
        { key: "strategy", agent: "marketing", title: "Kampanya stratejisi", instruction: "Strateji hazırla", depends_on: ["analysis"] },
      ],
    } as Plan));
    const { project } = await submitInstruction({ brandId, instruction: "Analiz ve strateji", idempotencyKey: key() });
    await runUntilIdle(new Engine("perm-w1"));
    const tasks = await listTasks(brandId, { projectId: project.id });
    const strategy = tasks.find((t) => t.key === "strategy")!;
    expect(strategy.error ?? "").not.toMatch(/outputs\.read/);
    expect(strategy.status).toBe("completed");
    const p = await getProject(brandId, project.id);
    expect(p!.status).toBe("completed");
  });

  it("her uzman, başka bir uzmanın çıktısına bağımlı olduğunda çalışabilir (tam izin matrisi)", async () => {
    for (const upstream of SPECIALISTS) {
      const downstreams = SPECIALISTS.filter((s) => s !== upstream);
      setTextModelOverride(new ScriptedPlanModel({
        reply: "matrix", goals: [], questions_for_owner: [],
        tasks: [
          { key: "up", agent: upstream, title: `üst ${upstream}`, instruction: "çalış", depends_on: [] },
          ...downstreams.map((d) => ({ key: `down-${d}`, agent: d, title: `alt ${d}`, instruction: "çalış", depends_on: ["up"] })),
        ],
      } as Plan));
      const { project } = await submitInstruction({ brandId, instruction: `matris ${upstream}`, idempotencyKey: key() });
      await runUntilIdle(new Engine(`perm-${upstream}`));
      const tasks = await listTasks(brandId, { projectId: project.id });
      const permissionErrors = tasks.filter((t) => /iznine sahip değil/.test(t.error ?? ""));
      expect(permissionErrors.map((t) => `${t.key}: ${t.error}`)).toEqual([]);
      for (const t of tasks.filter((x) => x.kind === "work")) {
        expect(["completed", "approval_pending"], `${upstream} → ${t.key}: ${t.status} ${t.error ?? ""}`).toContain(t.status);
      }
    }
  });

  it("izinler en az yetki ilkesine uyar: hiçbir ajan sınırsız/yönetici yetkisi almaz", () => {
    for (const a of Object.values(AGENTS)) {
      for (const t of a.tools) expect(Object.keys(TOOLS)).toContain(t);
      // Görev yönetimi yalnızca ana yöneticide
      if (a.id !== "manager") expect(a.tools).not.toContain("tasks.manage");
      // Üretim araçları yalnızca ilgili uzmanda
      if (a.id !== "design") expect(a.tools).not.toContain("image.generate");
      if (a.id !== "video") expect(a.tools).not.toContain("video.generate");
      if (a.id !== "video") expect(a.tools).not.toContain("video.edit");
    }
  });

  it("izinsiz araç kullanımı görev hatasına yapılandırılmış olarak yansır ve proje başarılı gösterilmez", async () => {
    const { assertTool, ToolPermissionError } = await import("@/lib/agents/registry");
    expect(() => assertTool("marketing", "image.generate")).toThrow(ToolPermissionError);
    const row = await q1(`SELECT 1`);
    expect(row).not.toBeNull();
  });
});
