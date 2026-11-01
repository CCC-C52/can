import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { getLimits, type Limits } from "@/lib/settings";
import { omniDuration } from "@/lib/adapters/video-generation";
import { runwayDuration } from "@/lib/adapters/runway-video";
import { InputError, retryTask, type Task } from "@/lib/orchestrator/projects";
import { VIDEO_PROVIDER_NAME, selectVideoProvider, type VideoProviderId } from "./providers";

// Ücretli video üretimine SAHİP ONAYI (üretim onayı). PR Ajansı kampanyaları talimata "Üretim onayı: gerekli" satırı
// koyar: video planı hazırlanır ve kalite kontrolünden geçer, ancak render görevi sahip tahmini maliyeti görüp
// "Üretimi onayla" diyene kadar Runway/Gemini'ye hiçbir ücretli istek göndermez. Onay plan sürümüne bağlıdır: plan
// yeniden üretilirse yeni sürüm için yeniden onay gerekir.

export const PRODUCTION_DIRECTIVE = "Üretim onayı: gerekli";
export const productionRequired = (instruction: string | null | undefined) => /Üretim onayı:\s*gerekli/i.test(instruction ?? "");

export type ProductionApproval = {
  required: boolean;
  approved_at?: string;
  approved_by?: string;
  version_id?: string;
  estimate_usd?: number | null;
  scenes?: SceneEstimate[];
};

/** Render başlamadan önce: üretim onayı gerekiyorsa ve bu plan sürümü onaylanmadıysa bekleme gerekçesi. */
export function productionGate(task: Pick<Task, "input_refs">, versionId: string): string | null {
  const pa = task.input_refs?.production_approval as ProductionApproval | undefined;
  if (!pa?.required) return null;
  if (pa.approved_at && pa.version_id === versionId) return null;
  return "Sahip üretim onayı bekleniyor: proje sayfasında veya Video Stüdyosu'nda tahmini maliyeti görüp “Üretimi onayla” deyin (ücretli istek gönderilmedi)";
}

export type SceneEstimate = { ref: string; seconds: number; provider: VideoProviderId | null; provider_name: string | null; usd: number | null; blocked?: string };

/** Planın AI sahneleri için sahne başına ve toplam tahmini maliyet (seçilecek sağlayıcının fiyatıyla). */
export async function estimatePlanCost(brandId: string, content: any, limits?: Limits) {
  const lim = limits ?? (await getLimits());
  const scenes: SceneEstimate[] = [];
  for (const v of (content?.videos ?? []).filter((x: any) => x?.mode === "generate_new")) {
    const pick = await selectVideoProvider(brandId, lim, { seconds: omniDuration(v.duration_s) });
    if (!pick.ok) { scenes.push({ ref: String(v.id), seconds: omniDuration(v.duration_s), provider: null, provider_name: null, usd: null, blocked: pick.reason }); continue; }
    const seconds = pick.status.id === "runway" ? runwayDuration(v.duration_s) : omniDuration(v.duration_s);
    scenes.push({ ref: String(v.id), seconds, provider: pick.status.id, provider_name: VIDEO_PROVIDER_NAME[pick.status.id], usd: pick.status.gen!.estimateCostUsd(seconds) });
  }
  const known = scenes.length > 0 && scenes.every((s) => s.usd !== null);
  const totalUsd = known ? Math.round(scenes.reduce((a, s) => a + (s.usd ?? 0), 0) * 1e4) / 1e4 : scenes.length ? null : 0;
  return { scenes, totalUsd, seconds: scenes.reduce((a, s) => a + s.seconds, 0) };
}

/** Onay bekleyen render görevleri (Video Stüdyosu / PR Ajansı listesi). */
export async function pendingProductionApprovals(brandId: string, db: Queryable = getPool()) {
  return q<{ id: string; project_id: string; title: string; status: string; input_refs: any; project_title: string; created_at: string }>(
    `SELECT t.id, t.project_id, t.title, t.status, t.input_refs, p.title AS project_title, t.created_at FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.brand_id = $1 AND t.kind = 'render' AND t.agent = 'video' AND (t.input_refs->'production_approval'->>'required')::boolean
       AND (t.input_refs->'production_approval'->>'approved_at') IS NULL AND t.status NOT IN ('cancelled','completed')
     ORDER BY t.created_at DESC LIMIT 20`,
    [brandId],
    db,
  );
}

/**
 * Sahip ücretli üretimi onaylar: tahmini maliyet kaydedilir ve render görevi kuyruğa döner. Tahmin bilinmiyorsa
 * (sağlayıcı fiyatı girilmemiş) onay verilmez: fiyatı bilinmeyen üretim başlatılamaz.
 */
export async function approveProduction(brandId: string, taskId: string, actor = "user") {
  const t = await q1<Task>(`SELECT * FROM tasks WHERE id = $1 AND brand_id = $2`, [taskId, brandId]);
  if (!t || t.kind !== "render" || t.agent !== "video") throw new InputError("Video render görevi bulunamadı.");
  const pa = t.input_refs?.production_approval as ProductionApproval | undefined;
  if (!pa?.required) throw new InputError("Bu görev için üretim onayı gerekmiyor.");
  const versionId = t.input_refs?.version_id as string | undefined;
  const v = versionId ? await q1<{ content: any }>(`SELECT content FROM output_versions WHERE id = $1 AND brand_id = $2`, [versionId, brandId]) : null;
  if (!v) throw new InputError("Onaylanacak video planı sürümü bulunamadı.");
  const est = await estimatePlanCost(brandId, v.content);
  const blocked = est.scenes.find((s) => s.blocked);
  if (blocked) throw new InputError(`Üretim onaylanamadı: ${blocked.ref} — ${blocked.blocked}`);
  if (est.totalUsd === null) throw new InputError("Tahmini maliyet hesaplanamadı (sağlayıcı fiyatı girilmemiş); fiyatı bilinmeyen üretim başlatılamaz.");
  const approval: ProductionApproval = { required: true, approved_at: new Date().toISOString(), approved_by: actor, version_id: versionId, estimate_usd: est.totalUsd, scenes: est.scenes };
  await q(`UPDATE tasks SET input_refs = input_refs || jsonb_build_object('production_approval', $2::jsonb), updated_at = now() WHERE id = $1`, [taskId, JSON.stringify(approval)]);
  await audit({ brandId, projectId: t.project_id, taskId, actor, action: "video.production_approved", message: `Ücretli video üretimi onaylandı: ${est.scenes.length} AI sahnesi, ${est.seconds} sn, tahmini $${est.totalUsd.toFixed(2)} (${[...new Set(est.scenes.map((s) => s.provider_name))].join(", ")})` });
  if (["waiting_connection", "failed", "cancelled"].includes(t.status)) await retryTask(brandId, taskId);
  return approval;
}
