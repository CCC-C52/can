import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { q, q1 } from "@/lib/db/pool";
import { Engine } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks, getProject } from "@/lib/orchestrator/projects";
import { isShortConfirmation, contradictsCatalog, pendingProposal } from "@/lib/orchestrator/conversation";
import { createBrand, createProduct } from "@/lib/services/brands";
import { addMemory } from "@/lib/services/brand-memory";
import { setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import type { GenerateRequest, GenerateResult, TextModelAdapter } from "@/lib/models/types";
import { key, runUntilIdle } from "./helpers";

/** Demo modeli; yöneticinin planlama istemlerini kaydeder. */
class Recording implements TextModelAdapter {
  readonly id = "recording";
  readonly isDemo = true;
  readonly service = "recording";
  planPrompts: string[] = [];
  private demo = new DemoAdapter();
  estimateCostUsd() { return 0; }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    if (req.agent === "manager" && req.purpose === "plan") this.planPrompts.push(`${req.userPrefix ?? ""}\n${req.user}`);
    return this.demo.generate(req);
  }
}

const model = new Recording();
let brandId: string;
const TEE = "Orange Anime Oversized T-Shirt";

beforeAll(async () => {
  setTextModelOverride(model);
  brandId = (await createBrand({ name: "Konuşma Testi (Free Bee benzeri)", content_language: "en" })).id;
  // Ürün kaydında fiyat yok; fiyat ve hedef kitle yalnızca marka hafızasında
  await createProduct(brandId, { title: TEE, product_type: "T-Shirt", status: "active" });
  await addMemory(brandId, { kind: "guideline", title: "Ürün ve fiyat bilgisi", body: `${TEE}: price 899 TL. 100% cotton, oversized, unisex.` });
  await addMemory(brandId, { kind: "strategy", title: "Hedef kitle", body: "Hedef kitle: 18-30 yaş anime ve sokak modası takipçileri." });
});
afterAll(() => setTextModelOverride(null));

const projectCount = async () => (await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM projects WHERE brand_id = $1`, [brandId]))!.n;

describe("Ana yönetici — onay ve konuşma bağlamı", () => {
  let proposalId: string;

  it("1. video planı önerilir: görevler başlamaz, onay bekler; hafızadaki fiyat ve hedef kitle sorulmaz", async () => {
    const { project } = await submitInstruction({ brandId, instruction: `${TEE} için 15 saniyelik Reels video planı öner.`, idempotencyKey: key() });
    proposalId = project.id;
    await runUntilIdle(new Engine("conv-1"));

    const p = (await getProject(brandId, proposalId))!;
    expect(p.status).toBe("needs_input");
    expect(p.questions).toEqual(["Bu planı onaylıyor musunuz? Başlatmak için “onaylıyorum” yazmanız yeterli."]);
    const tasks = await listTasks(brandId, { projectId: proposalId });
    expect(tasks.map((t) => t.key)).toEqual(["plan"]); // öneri: iş görevi yok
    const pending = (await pendingProposal(brandId))!;
    expect(pending.projectId).toBe(proposalId);
    expect(pending.tasks.some((t) => t.agent === "video")).toBe(true);
    const msg = await q1<{ content: string }>(`SELECT content FROM chat_messages WHERE project_id = $1 AND role = 'manager'`, [proposalId]);
    expect(msg!.content).toMatch(/Önerilen görevler \(onayınızı bekliyor\)/);
    expect(msg!.content).not.toMatch(/fiyatı nedir|Hedef kitleniz kim/);
    // Yöneticiye kayıt sayımı verilir (ürün var)
    expect(model.planPrompts.at(-1)).toContain('"product_count":1');
  });

  it("2-3. kullanıcı yalnızca “onay veriyorum” der: aynı plan bulunur, görevler başlatılır, yeni proje veya yeniden planlama olmaz", async () => {
    const before = await projectCount();
    const planCalls = model.planPrompts.length;
    const k = key();
    const r = await submitInstruction({ brandId, instruction: "onay veriyorum", idempotencyKey: k });
    expect(r.confirmedProposal).toBe(true);
    expect(r.project.id).toBe(proposalId);
    expect(r.project.status).toBe("running");
    expect(await projectCount()).toBe(before);

    // Çift gönderim ikinci kez görev açmaz
    const again = await submitInstruction({ brandId, instruction: "onay veriyorum", idempotencyKey: k });
    expect(again.duplicate).toBe(true);
    const created = await listTasks(brandId, { projectId: proposalId });
    expect(created.filter((t) => t.agent === "video" && t.kind === "work")).toHaveLength(1);

    await runUntilIdle(new Engine("conv-2"));
    const tasks = await listTasks(brandId, { projectId: proposalId });
    const video = tasks.find((t) => t.agent === "video" && t.kind === "work")!;
    expect(video.started_at).not.toBeNull(); // görev gerçekten çalıştı
    expect(tasks.filter((t) => t.kind === "plan")).toHaveLength(1);
    expect(model.planPrompts.length).toBe(planCalls); // yönetici "neyi onayladınız" diye yeniden planlamadı
    expect(await pendingProposal(brandId)).toBeNull();

    const chat = await q<{ role: string; content: string }>(`SELECT role, content FROM chat_messages WHERE project_id = $1 ORDER BY created_at`, [proposalId]);
    expect(chat.map((m) => m.role)).toEqual(expect.arrayContaining(["user", "manager"]));
    expect(chat.find((m) => m.content.startsWith("Onayınızı"))!.content).toContain(`planına uyguladım`);
    expect(chat.some((m) => /neyi onayladığınız/i.test(m.content))).toBe(false);
    const audit = await q1(`SELECT 1 FROM audit_log WHERE project_id = $1 AND action = 'project.plan_approved'`, [proposalId]);
    expect(audit).not.toBeNull();
  });

  it("4. sonraki talimatta önceki konuşma ve bekleyen öneri yöneticiye verilir", async () => {
    const { project } = await submitInstruction({ brandId, instruction: `${TEE} için ikinci bir video planı öner.`, idempotencyKey: key() });
    await runUntilIdle(new Engine("conv-3"));
    const p = (await getProject(brandId, project.id))!;
    expect(p.status).toBe("needs_input");

    // Onay değil, yeni içerik → bağlanmaz; yönetici konuşmayı ve bekleyen öneriyi görür
    const { project: follow } = await submitInstruction({ brandId, instruction: "Ekran yazılarını İngilizce yap.", idempotencyKey: key() });
    expect(follow.id).not.toBe(project.id);
    await runUntilIdle(new Engine("conv-4"));
    const prompt = model.planPrompts.at(-1)!;
    expect(prompt).toContain("<conversation>");
    expect(prompt).toContain("ikinci bir video planı öner");
    expect(prompt).toContain("<pending_proposal>");
    expect(prompt).toContain("899 TL"); // hafıza bağlamda
  });

  it("öneri yoksa kısa onay yeni proje olarak yöneticiye gider (sessizce yutulmaz)", async () => {
    const other = (await createBrand({ name: "Konuşma Testi — öneri yok", content_language: "en" })).id;
    const r = await submitInstruction({ brandId: other, instruction: "tamam", idempotencyKey: key() });
    expect(r.confirmedProposal).toBeUndefined();
    expect(r.project.instruction).toBe("tamam");
  });
});

describe("Kısa onay ve katalog denetimi", () => {
  it.each([
    ["onay veriyorum", true], ["Onaylıyorum.", true], ["tamam, devam et", true], ["evet bunu yap", true], ["OK", true],
    ["hayır", false], ["tamam ama müzik ekle", false], ["neyi onayladım?", false], ["onaylamıyorum", false], ["bekle", false], ["video yap", false],
  ])("%s → %s", (text, expected) => {
    expect(isShortConfirmation(text)).toBe(expected);
  });

  it("ürün kaydı varken 'katalogda ürün yok' cümlesi yakalanır", () => {
    expect(contradictsCatalog("Katalogda kayıtlı ürün yok, ürün bilgilerini paylaşır mısınız?", 3)).toBe(true);
    expect(contradictsCatalog("Katalogda kayıtlı ürün yok.", 0)).toBe(false);
    expect(contradictsCatalog("Orange Anime tişört için plan hazırladım.", 3)).toBe(false);
  });
});
