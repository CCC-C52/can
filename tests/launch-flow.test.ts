import { describe, it, expect, beforeAll } from "vitest";
import { q, q1 } from "@/lib/db/pool";
import { Engine } from "@/lib/orchestrator/engine";
import { submitInstruction, listTasks, getProject } from "@/lib/orchestrator/projects";
import { seedSampleBrand } from "@/lib/services/sample";
import { decide, editOutput, findValidApproval, getCurrentVersion, listOutputs } from "@/lib/services/outputs";
import { executeExternalAction, ApprovalRequiredError, ConnectionMissingError } from "@/lib/services/gateway";
import { runUntilIdle, key } from "./helpers";

let brandId: string;

beforeAll(async () => {
  brandId = (await seedSampleBrand()).brandId;
});

describe("Örnek ürün lansmanı (demo modu, uçtan uca)", () => {
  let projectId: string;

  it("kullanıcı talimatı → yönetici görevleri oluşturur → uzmanlar doğru sırada çalışır", async () => {
    const { project } = await submitInstruction({ brandId, instruction: "Sample Linen Shirt için ürün lansmanı hazırla: strateji, ürün sayfası, görseller, video ve sosyal medya paketi.", idempotencyKey: key() });
    projectId = project.id;
    const engine = new Engine("test-worker-1");
    await runUntilIdle(engine);

    const tasks = await listTasks(brandId, { projectId });
    const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
    expect(Object.keys(byKey).sort()).toEqual(expect.arrayContaining(["plan", "strategy", "store", "visuals", "video", "social", "report", "visuals-render", "video-render"]));

    // Sıra: strateji, bağımlılarından önce bitmiş olmalı; sosyal, tasarım ve videodan sonra
    const t = (k: string) => new Date(byKey[k].finished_at ?? byKey[k].updated_at).getTime();
    const s = (k: string) => new Date(byKey[k].started_at!).getTime();
    expect(t("strategy")).toBeLessThanOrEqual(s("store"));
    expect(t("strategy")).toBeLessThanOrEqual(s("visuals"));
    expect(t("visuals")).toBeLessThanOrEqual(s("social"));
    expect(t("video")).toBeLessThanOrEqual(s("social"));

    expect(byKey.strategy.status).toBe("completed");
    expect(byKey.store.status).toBe("approval_pending"); // canlı mağaza önerisi → onay bekler
    expect(byKey.social.status).toBe("approval_pending"); // yayın paketi → onay bekler
    expect(byKey["visuals-render"].status).toBe("waiting_connection"); // kapak için AI görsel servisi yok
    expect(byKey["video-render"].status).toBe("completed"); // yerel ffmpeg ile gerçek kurgu
    expect(byKey.report.status).toBe("completed");
  });

  it("çıktılar kaydedilir, kalite kontrolü yapılır ve DEMO olarak etiketlenir", async () => {
    const outputs = await listOutputs(brandId, { projectId });
    expect(outputs.length).toBeGreaterThanOrEqual(6);
    const strategy = outputs.find((o) => o.kind === "strategy")!;
    const v = await getCurrentVersion(brandId, strategy.id);
    expect(v!.is_demo).toBe(true);
    expect(v!.generator).toBe("demo");
    expect(v!.qa_report.verdict).toBe("pass");
    expect(v!.qa_report.checks.some((c: any) => c.name === "Üretim kaynağı" && c.status === "warn")).toBe(true);

    // Render edilmiş dosyalar kaynakla ilişkili
    const derived = await q<{ origin: string; n: number }>(`SELECT origin, COUNT(*)::int AS n FROM media_assets WHERE brand_id = $1 AND source_task_id IS NOT NULL GROUP BY origin`, [brandId]);
    expect(derived.find((d) => d.origin === "edited")?.n).toBeGreaterThanOrEqual(2); // derlenmiş post + ffmpeg video
    const lineage = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM media_lineage l JOIN media_assets m ON m.id = l.derived_asset_id WHERE m.brand_id = $1`, [brandId]);
    expect(lineage!.n).toBeGreaterThanOrEqual(2);
    expect(await q1(`SELECT 1 FROM media_assets WHERE brand_id = $1 AND origin = 'ai_generated'`, [brandId])).toBeNull(); // sahte AI görseli yok
  });

  it("kullanıcı çıktıyı düzenleyip onaylar; onay doğru sürümle eşleşir", async () => {
    const out = (await listOutputs(brandId, { projectId })).find((o) => o.kind === "shopify_proposal")!;
    const v1 = (await getCurrentVersion(brandId, out.id))!;
    const edited = structuredClone(v1.content);
    edited.product_changes[0].proposed_value = "<p>Sample Linen Shirt.</p><ul><li>Fabric: 100% linen</li><li>Fit: Relaxed fit</li></ul>";
    edited.summary = "Edited by operator";
    const v2 = await editOutput(brandId, out.id, edited);
    expect(v2.version).toBe(v1.version + 1);
    expect(v2.is_demo).toBe(false);

    await expect(decide(brandId, v1.id, "approved")).rejects.toThrow(/en güncel/); // eski sürüm onaylanamaz
    const approval = await decide(brandId, v2.id, "approved");
    expect(approval.output_version_id).toBe(v2.id);
    expect(approval.content_hash).toBe(v2.content_hash);
    expect(approval.scopes).toEqual(expect.arrayContaining(["content", "store_update"]));
    const task = await q1<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [out.task_id]);
    expect(task!.status).toBe("completed");

    // Onaydan sonra içerik değişirse eski onay geçersiz
    const v3 = await editOutput(brandId, out.id, { ...edited, summary: "changed after approval" });
    const check = await findValidApproval(brandId, v3.id, "store_update");
    expect(check.ok).toBe(false);
    const oldCheck = await findValidApproval(brandId, v2.id, "store_update");
    expect(oldCheck.ok).toBe(false); // v2 artık güncel değil
    await expect(executeExternalAction({ brandId, outputVersionId: v2.id, actionType: "store_update", idempotencyKey: key() })).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(executeExternalAction({ brandId, outputVersionId: v3.id, actionType: "store_update", idempotencyKey: key() })).rejects.toBeInstanceOf(ApprovalRequiredError);

    // v3 onaylanınca: Shopify bağlı değil → sahte başarı yok
    await decide(brandId, v3.id, "approved");
    await expect(executeExternalAction({ brandId, outputVersionId: v3.id, actionType: "store_update", idempotencyKey: key() })).rejects.toBeInstanceOf(ConnectionMissingError);
    const succeeded = await q1(`SELECT 1 FROM external_actions WHERE brand_id = $1 AND status = 'succeeded'`, [brandId]);
    expect(succeeded).toBeNull();
  });

  it("uygulama yeniden açıldığında kayıtlar korunur (yeni bağlantı havuzu)", async () => {
    const { closePool } = await import("@/lib/db/pool");
    await closePool();
    const p = await getProject(brandId, projectId);
    expect(p!.status).toBe("needs_attention"); // onay/bağlantı bekleyen işler var
    expect(p!.report.headline).toMatch(/görev/);
    const chat = await q<{ role: string }>(`SELECT role FROM chat_messages WHERE project_id = $1 ORDER BY created_at`, [projectId]);
    expect(chat.map((c) => c.role)).toEqual(["user", "manager", "manager"]);
    const versions = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM output_versions WHERE brand_id = $1`, [brandId]);
    expect(versions!.n).toBeGreaterThan(6);
  });
});
