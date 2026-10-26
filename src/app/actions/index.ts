"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { act, str } from "./util";
import { BRAND_COOKIE, requireBrand } from "@/lib/current";
import { checkPassword, clearLoginFailures, loginLocked, recordLoginFailure, sessionCookieName, signSession } from "@/lib/auth";
import { headers } from "next/headers";
import { config } from "@/lib/config";
import {
  addBrandFact, addProductFact, addVariant, createBrand, createProduct, deleteBrandFact, deleteProductFact, deleteVariant, getBrand, updateBrand, updateProduct,
} from "@/lib/services/brands";
import { submitInstruction, cancelTask, cancelProject, retryTask, requestRegeneration, setPaused, retryWaitingConnections, getTask } from "@/lib/orchestrator/projects";
import { decide, editOutput, revokeApproval } from "@/lib/services/outputs";
import { executeExternalAction, reconcileAction, type ActionType } from "@/lib/services/gateway";
import { updateMediaMeta, getMedia } from "@/lib/services/media";
import { setSetting, getLimits, type Limits } from "@/lib/settings";
import { seedSampleBrand } from "@/lib/services/sample";
import { disconnect, type ProviderId, upsertConnection } from "@/lib/services/connections";
import { testShopify, syncShopifyProducts } from "@/lib/adapters/shopify";
import { testInstagram } from "@/lib/adapters/instagram";
import { testOpenAIImages } from "@/lib/adapters/images";
import { testGeminiOmniVideo } from "@/lib/adapters/video-generation";
import { STUDIO_MAX_AI_SCENES, STUDIO_MAX_PHOTOS, STUDIO_MODES, buildStudioInstruction, type StudioMode } from "@/lib/video/studio";
import { releaseJob } from "@/lib/services/provider-jobs";
import { testAnthropic } from "@/lib/models/test";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/security/rate-limit";
import { runResearch, setSourceVerification } from "@/lib/services/research";
import { COST_PROVIDERS } from "@/lib/services/costs";
import { addMemory, setMemoryStatus, type MemoryKind, type MemoryStatus } from "@/lib/services/brand-memory";
import type { AgentId } from "@/lib/agents/schemas";

// ---------------------------------------------------------------- Oturum

export async function loginAction(fd: FormData) {
  const next = str(fd, "next") || "/";
  const h = await headers();
  // Barındırıcının vekil sunucusu gerçek istemci IP'sini X-Forwarded-For listesinin SONUNA ekler;
  // istemcinin kendi gönderdiği (sahte olabilecek) değerler solda kalır.
  const ip = (h.get("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean).pop() || h.get("x-real-ip") || "local";
  const back = (msg: string) => redirect(`/login?err=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`);
  if (loginLocked(ip)) {
    await audit({ actor: "system", action: "auth.locked", message: "Çok fazla hatalı giriş denemesi; giriş geçici olarak kilitli" });
    back("Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.");
  }
  const ok = await checkPassword(str(fd, "password"));
  if (!ok) {
    recordLoginFailure(ip);
    await audit({ actor: "system", action: "auth.failed", message: "Hatalı giriş denemesi" });
    back("Parola hatalı.");
  }
  clearLoginFailures(ip);
  const s = signSession();
  (await cookies()).set(sessionCookieName(), s.value, { httpOnly: true, sameSite: "lax", secure: config.appMode === "production", maxAge: s.maxAge, path: "/" });
  await audit({ actor: "user", action: "auth.login", message: "Panele giriş yapıldı" });
  // Yalnızca site içi yol: "//evil", "/\\evil" ve kontrol karakterleri başka siteye yönlendirmeye çevrilemez
  redirect(/^\/(?![\/\\])[^\s\\]*$/.test(next) ? next : "/");
}

export async function logoutAction() {
  (await cookies()).delete(sessionCookieName());
  redirect("/login");
}

// ---------------------------------------------------------------- Marka

export async function selectBrandAction(fd: FormData) {
  const id = str(fd, "brandId");
  const b = await getBrand(id);
  if (b) (await cookies()).set(BRAND_COOKIE, b.id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect(str(fd, "back") || "/");
}

export async function seedSampleAction() {
  await act("/markalar", async () => {
    const r = await seedSampleBrand();
    (await cookies()).set(BRAND_COOKIE, r.brandId, { httpOnly: true, sameSite: "lax", path: "/" });
    return r.created ? "Örnek (DEMO) marka oluşturuldu ve seçildi." : "Örnek marka zaten vardı; seçildi.";
  });
}

function brandFields(fd: FormData) {
  const colors = str(fd, "colors").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, hex] = l.split(/[,;]\s*/);
    return { name: name ?? "", hex: (hex ?? name ?? "").trim() };
  }).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c.hex));
  const fonts = str(fd, "fonts").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [role, family] = l.split(/[:;]\s*/);
    return family ? { role, family } : { role: "Genel", family: role };
  });
  return {
    name: str(fd, "name"), story: str(fd, "story"), target_audience: str(fd, "target_audience"), tone: str(fd, "tone"),
    content_language: str(fd, "content_language") || "en", colors, fonts, shipping_info: str(fd, "shipping_info"), return_policy: str(fd, "return_policy"),
    campaign_rules: str(fd, "campaign_rules"), price_source: str(fd, "price_source") || "unknown", inventory_source: str(fd, "inventory_source") || "unknown",
  };
}

export async function createBrandAction(fd: FormData) {
  await act("/markalar", async () => {
    const f = brandFields(fd);
    if (!f.name.trim()) throw new Error("Marka adı gerekli.");
    const b = await createBrand(f);
    (await cookies()).set(BRAND_COOKIE, b.id, { httpOnly: true, sameSite: "lax", path: "/" });
    return { ok: `${b.name} oluşturuldu ve seçildi.`, to: `/markalar/${b.id}` };
  });
}

export async function updateBrandAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`/markalar/${brand.id}`, async () => {
    const f = brandFields(fd);
    const logo = str(fd, "logo_asset_id");
    if (logo && !(await getMedia(brand.id, logo))) throw new Error("Logo bu markanın arşivinde değil.");
    await updateBrand(brand.id, { ...f, logo_asset_id: logo || null });
    return "Marka bilgileri kaydedildi.";
  });
}

export async function addBrandFactAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`/markalar/${brand.id}`, async () => {
    const statement = str(fd, "statement").trim();
    if (!statement) throw new Error("Metin gerekli.");
    await addBrandFact(brand.id, { kind: str(fd, "kind") || "decision", statement });
    return "Kayıt eklendi.";
  });
}

export async function deleteBrandFactAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`/markalar/${brand.id}`, async () => {
    await deleteBrandFact(brand.id, str(fd, "id"));
    return "Kayıt silindi.";
  });
}

// ---------------------------------------------------------------- Ürün

export async function createProductAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/urunler", async () => {
    if (!str(fd, "title").trim()) throw new Error("Ürün adı gerekli.");
    const p = await createProduct(brand.id, { title: str(fd, "title"), description: str(fd, "description"), product_type: str(fd, "product_type"), price: str(fd, "price"), compare_at_price: str(fd, "compare_at_price"), currency: str(fd, "currency"), status: str(fd, "status") || "draft" });
    return { ok: "Ürün eklendi.", to: `/urunler/${p.id}` };
  });
}

export async function updateProductAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "id");
  await act(`/urunler/${id}`, async () => {
    const r = await updateProduct(brand.id, id, { title: str(fd, "title"), description: str(fd, "description"), product_type: str(fd, "product_type"), price: str(fd, "price"), compare_at_price: str(fd, "compare_at_price"), currency: str(fd, "currency"), status: str(fd, "status") });
    if (!r) throw new Error("Ürün bulunamadı.");
    return "Ürün kaydedildi.";
  });
}

export async function addVariantAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "productId");
  await act(`/urunler/${id}`, async () => {
    if (!str(fd, "title").trim()) throw new Error("Varyant adı gerekli.");
    await addVariant(brand.id, id, { title: str(fd, "title"), sku: str(fd, "sku"), color: str(fd, "color"), size: str(fd, "size"), price: str(fd, "price"), inventory_quantity: str(fd, "inventory_quantity") });
    return "Varyant eklendi.";
  });
}

export async function deleteVariantAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`/urunler/${str(fd, "productId")}`, async () => {
    await deleteVariant(brand.id, str(fd, "id"));
    return "Varyant silindi.";
  });
}

export async function addProductFactAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "productId");
  await act(`/urunler/${id}`, async () => {
    if (!str(fd, "attribute").trim() || !str(fd, "value").trim()) throw new Error("Özellik ve değer gerekli.");
    await addProductFact(brand.id, id, { attribute: str(fd, "attribute"), value: str(fd, "value"), status: str(fd, "status") || "verified", source: str(fd, "source") });
    return "Özellik eklendi.";
  });
}

export async function deleteProductFactAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`/urunler/${str(fd, "productId")}`, async () => {
    await deleteProductFact(brand.id, str(fd, "id"));
    return "Özellik silindi.";
  });
}

// ---------------------------------------------------------------- Sohbet ve görevler

export async function sendInstructionAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/sohbet", async () => {
    const r = await submitInstruction({ brandId: brand.id, instruction: str(fd, "instruction"), idempotencyKey: str(fd, "idempotencyKey") });
    if (r.duplicate) return "Bu talimat zaten alınmıştı (çift gönderim engellendi).";
    return r.confirmedProposal ? `Onayınız “${r.project.title}” planına uygulandı; görevler başlatıldı.` : "Talimat ana yöneticiye iletildi.";
  });
}

export async function cancelTaskAction(fd: FormData) {
  const brand = await requireBrand();
  await act(str(fd, "back") || "/gorevler", async () => {
    const r = await cancelTask(brand.id, str(fd, "taskId"));
    return r ? "Görev iptal edildi." : "Görev zaten bitmiş.";
  });
}

export async function retryTaskAction(fd: FormData) {
  const brand = await requireBrand();
  await act(str(fd, "back") || "/gorevler", async () => {
    await retryTask(brand.id, str(fd, "taskId"));
    return "Görev tekrar kuyruğa alındı.";
  });
}

export async function cancelProjectAction(fd: FormData) {
  const brand = await requireBrand();
  await act(str(fd, "back") || "/gorevler", async () => {
    await cancelProject(brand.id, str(fd, "projectId"));
    return "Proje iptal edildi.";
  });
}

export async function pauseAction(fd: FormData) {
  await act(str(fd, "back") || "/", async () => {
    const paused = str(fd, "paused") === "true";
    await setPaused(paused);
    return paused ? "Tüm işlemler durduruldu. Çalışan görevler kuyruğa geri alınır." : "İşlemler devam ediyor.";
  });
}

export async function retryWaitingAction(fd: FormData) {
  const brand = await requireBrand();
  await act(str(fd, "back") || "/entegrasyonlar", async () => {
    const n = await retryWaitingConnections(brand.id);
    return `${n} görev tekrar planlandı.`;
  });
}

// ---------------------------------------------------------------- Çıktılar ve onaylar

export async function editOutputAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "outputId");
  await act(`/taslaklar/${id}`, async () => {
    let content: unknown;
    try {
      content = JSON.parse(str(fd, "content"));
    } catch {
      throw new Error("İçerik geçerli JSON değil.");
    }
    const v = await editOutput(brand.id, id, content);
    return `Yeni sürüm kaydedildi (v${v.version}). Önceki onaylar bu sürüm için geçerli değildir.`;
  });
}

export async function decideAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "outputId");
  await act(str(fd, "back") || `/taslaklar/${id}`, async () => {
    const decision = str(fd, "decision") === "approved" ? "approved" : "rejected";
    const scopes = fd.getAll("scopes").map(String);
    const note = str(fd, "note");
    await decide(brand.id, str(fd, "versionId"), decision, { note, scopes });
    // Ret + revizyon: ret notu, uzmana geri bildirim olarak verilir ve yeni sürüm üretilir (eski sürüm ve ret kaydı korunur)
    if (decision === "rejected" && str(fd, "revise") === "on") {
      try {
        await requestRegeneration(brand.id, id, note || "Sahip bu sürümü reddetti; daha iyi bir sürüm hazırlayın.");
      } catch (err) {
        return `Sürüm reddedildi. Yeni sürüm başlatılamadı: ${(err as Error).message}`;
      }
      return "Sürüm reddedildi; geri bildirimle yeni sürüm kuyruğa alındı.";
    }
    return decision === "approved" ? "Sürüm onaylandı." : "Sürüm reddedildi.";
  });
}

export async function revokeApprovalAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`/taslaklar/${str(fd, "outputId")}`, async () => {
    await revokeApproval(brand.id, str(fd, "approvalId"));
    return "Onay geri alındı.";
  });
}

export async function regenerateAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "outputId");
  await act(`/taslaklar/${id}`, async () => {
    await requestRegeneration(brand.id, id, str(fd, "feedback"));
    return "Yeniden üretim kuyruğa alındı.";
  });
}

export async function externalAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "outputId");
  await act(`/taslaklar/${id}`, async () => {
    const r = await executeExternalAction({
      brandId: brand.id,
      outputVersionId: str(fd, "versionId"),
      actionType: str(fd, "actionType") as ActionType,
      idempotencyKey: str(fd, "idempotencyKey"),
      target: str(fd, "postId") ? { postId: str(fd, "postId"), manual: str(fd, "manual") === "1" } : undefined,
    });
    const msg: Record<string, string> = {
      succeeded: "İşlem başarıyla gerçekleşti.",
      failed: `İşlem başarısız: ${r.error ?? ""}`,
      unknown: "Sonuç belirsiz — platformda kontrol edip işaretleyin. Otomatik tekrar gönderilmeyecek.",
      manual_export: "Otomatik yayın desteklenmiyor; manuel yayın paketi hazırlandı.",
    };
    if (r.status === "failed") throw new Error(msg.failed);
    return msg[r.status] ?? `Durum: ${r.status}`;
  });
}

export async function reconcileAction_(fd: FormData) {
  const brand = await requireBrand();
  await act(str(fd, "back") || "/onaylar", async () => {
    await reconcileAction(brand.id, str(fd, "actionId"), str(fd, "outcome") === "succeeded" ? "succeeded" : "failed");
    return "İşlem durumu güncellendi.";
  });
}

/** Sahip kararı: başarısız/sonucu belirsiz AI üretim işini yeniden gönderime açar ve render görevini tekrar planlar. */
export async function releaseProviderJobAction(fd: FormData) {
  const brand = await requireBrand();
  await act(str(fd, "back") || "/projeler", async () => {
    const job = await releaseJob(brand.id, str(fd, "jobId"));
    if (!job) throw new Error("İş bulunamadı veya yeniden gönderilebilir durumda değil.");
    await audit({ brandId: brand.id, projectId: job.project_id, taskId: job.task_id, actor: "user", action: "provider_job.release", message: `AI üretim işi yeniden gönderime açıldı (${job.item_ref}, önceki durum: ${job.status}). Yeni ücret oluşabilir.` });
    if (job.task_id) {
      const t = await getTask(brand.id, job.task_id);
      if (t && ["failed", "cancelled", "waiting_connection"].includes(t.status)) await retryTask(brand.id, t.id);
    }
    return "İş yeniden gönderime açıldı; render görevi tekrar planlandı.";
  });
}

// ---------------------------------------------------------------- Medya

export async function updateMediaAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "id");
  await act(`/medya/${id}`, async () => {
    const list = (k: string) => str(fd, k).split(",").map((s) => s.trim()).filter(Boolean);
    const userTags = list("userTags").map((tag) => ({ tag, source: "user" }));
    const keptAi = fd.getAll("keepTag").map(String).map((t) => JSON.parse(t) as { tag: string; source: string });
    await updateMediaMeta(brand.id, id, {
      productId: str(fd, "productId") || null, themes: list("themes"), colors: list("colors"), shotType: str(fd, "shotType") || null,
      rightsStatus: str(fd, "rightsStatus"), rightsNote: str(fd, "rightsNote") || null, tags: [...keptAi, ...userTags], origin: str(fd, "origin") || undefined,
    });
    return "Medya bilgileri kaydedildi.";
  });
}

export async function analyzeMediaAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "id");
  await act(`/medya/${id}`, async () => {
    const { requestAnalysis } = await import("@/lib/media-analysis");
    const a = await requestAnalysis(brand.id, id);
    return a.status === "completed" ? "Bu dosya bu analiz sürümüyle zaten analiz edilmiş (önbellekten)." : "Analiz kuyruğa alındı; işleyici birkaç saniye içinde başlatır.";
  });
}

export async function backfillAnalysesAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/medya", async () => {
    const { backfillAnalyses } = await import("@/lib/media-analysis");
    const n = await backfillAnalyses(brand.id, { vision: str(fd, "vision") === "1" ? true : undefined });
    return `${n} dosya analiz kuyruğuna alındı.`;
  });
}

// ---------------------------------------------------------------- Entegrasyonlar

export async function testConnectionAction(fd: FormData) {
  const brand = await requireBrand();
  const provider = str(fd, "provider") as ProviderId;
  await act("/entegrasyonlar", async () => {
    let r: { ok: boolean; detail: string };
    if (provider === "anthropic") r = await testAnthropic();
    else if (provider === "openai_images") r = await testOpenAIImages();
    else if (provider === "video_generation") r = await testGeminiOmniVideo();
    else if (provider === "shopify") r = await testShopify(brand.id, str(fd, "shop"));
    else if (provider === "instagram") r = await testInstagram(brand.id);
    else throw new Error("Bu sağlayıcı için test yok.");
    if (!r.ok) throw new Error(r.detail);
    return r.detail;
  });
}

export async function disconnectAction(fd: FormData) {
  const brand = await requireBrand();
  const provider = str(fd, "provider") as ProviderId;
  await act("/entegrasyonlar", async () => {
    await disconnect(provider, ["shopify", "instagram"].includes(provider) ? brand.id : null);
    return "Bağlantı kaldırıldı.";
  });
}

export async function shopifySyncAction() {
  const brand = await requireBrand();
  await act("/urunler", async () => {
    const r = await syncShopifyProducts(brand.id);
    return `Shopify'dan aktarıldı: ${r.created} yeni, ${r.updated} güncellenen ürün.`;
  });
}

// ---------------------------------------------------------------- Ayarlar

export async function requestBackupAction() {
  await act("/ayarlar", async () => {
    const { backupConfigured } = await import("@/lib/services/backup");
    const b = backupConfigured();
    if (!b.ok) throw new Error(`Yedekleme yapılandırılmadı: ${b.reason}`);
    await setSetting("backup_requested", true);
    await audit({ actor: "user", action: "backup.requested", message: "Elle yedekleme istendi" });
    return "Yedekleme istendi; işleyici en geç 30 saniye içinde başlatır.";
  });
}

export async function saveAnalysisSettingsAction(fd: FormData) {
  await act("/ayarlar", async () => {
    const on = str(fd, "visionOnUpload") === "on";
    const frames = str(fd, "videoAgentFrames") === "on";
    await setSetting("vision_on_upload", on);
    await setSetting("video_agent_frames", frames);
    await audit({ actor: "user", action: "settings.vision_on_upload", message: `Yüklemede AI görsel analizi ${on ? "açıldı" : "kapatıldı"}; video uzmanına gerçek kareler ${frames ? "gönderilir" : "gönderilmez"}` });
    return "Analiz ayarı kaydedildi.";
  });
}

export async function saveLimitsAction(fd: FormData) {
  await act("/ayarlar", async () => {
    const cur = await getLimits();
    const n = (k: keyof Limits, min: number, max: number) => {
      const raw = str(fd, k);
      const v = Number(raw);
      if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k}: ${min}–${max} arası olmalı.`);
      return v;
    };
    const money = (k: keyof Limits) => {
      const raw = str(fd, k).trim();
      if (raw === "") return null;
      const v = Number(raw.replace(",", "."));
      if (!Number.isFinite(v) || v < 0) throw new Error(`${k}: geçersiz tutar.`);
      return v;
    };
    const next: Limits = {
      ...cur,
      maxConcurrentTasks: n("maxConcurrentTasks", 1, 10),
      maxTasksPerProject: n("maxTasksPerProject", 2, 30),
      maxModelCallsPerProject: n("maxModelCallsPerProject", 1, 200),
      taskTimeoutMs: n("taskTimeoutMs", 10_000, 1_800_000),
      renderTimeoutMs: n("renderTimeoutMs", 60_000, 3_600_000),
      maxAttempts: n("maxAttempts", 1, 5),
      maxRegenerations: n("maxRegenerations", 0, 10),
      perTaskBudgetUsd: money("perTaskBudgetUsd"),
      dailyBudgetUsd: money("dailyBudgetUsd"),
      blockUnknownCost: str(fd, "blockUnknownCost") === "on",
      paidMediaGeneration: str(fd, "paidMediaGeneration") === "on",
      maxVideoGenSeconds: n("maxVideoGenSeconds", 0, 120),
    };
    await setSetting("limits", next);
    await audit({ actor: "user", action: "settings.limits", message: "Sınırlar güncellendi", data: next });
    return "Sınırlar kaydedildi.";
  });
}

export async function saveShopifyDomainAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/entegrasyonlar", async () => {
    await upsertConnection("shopify", brand.id, { config: { shop: str(fd, "shop") } });
    revalidatePath("/entegrasyonlar");
    return "Mağaza alan adı kaydedildi.";
  });
}

// ---------------------------------------------------------------- Marka hafızası

export async function addMemoryAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/hafiza", async () => {
    const rl = rateLimit(`memory:${brand.id}`, 30, 60_000);
    if (!rl.ok) throw new Error(`Çok fazla istek; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const m = await addMemory(brand.id, {
      kind: (str(fd, "kind") || "guideline") as MemoryKind,
      agent: (str(fd, "agent") || null) as AgentId | null,
      title: str(fd, "title"),
      body: str(fd, "body"),
      status: "active",
      source: "owner",
    });
    await audit({ brandId: brand.id, actor: "user", action: "memory.add", message: `Marka hafızasına eklendi: ${m.title}` });
    return "Marka hafızasına eklendi; ajanlar bir sonraki görevden itibaren kullanır.";
  });
}

export async function setMemoryStatusAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/hafiza", async () => {
    const status = str(fd, "status");
    if (!["active", "archived", "proposed"].includes(status)) throw new Error("Geçersiz durum.");
    const m = await setMemoryStatus(brand.id, str(fd, "id"), status as MemoryStatus);
    await audit({ brandId: brand.id, actor: "user", action: `memory.${status}`, message: `Marka hafızası kaydı ${status === "active" ? "etkinleştirildi" : status === "archived" ? "arşivlendi" : "öneriye alındı"}: ${m.title}` });
    return status === "active" ? "Kayıt etkinleştirildi." : status === "archived" ? "Kayıt arşivlendi; ajanlara verilmez." : "Kayıt güncellendi.";
  });
}

// ---------------------------------------------------------------- Araştırma Merkezi

export async function runResearchAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/arastirma", async () => {
    const rl = rateLimit(`research:${brand.id}`, 5, 60_000);
    if (!rl.ok) throw new Error(`Çok fazla araştırma isteği; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const { run, sources, reused } = await runResearch(brand.id, {
      mode: str(fd, "mode") === "scrape" ? "scrape" : "search",
      query: str(fd, "query"),
      limit: Number(str(fd, "limit")) || 5,
      idempotencyKey: str(fd, "idem") || null,
    });
    if (reused) return "Bu istek zaten işlendi; yeni çağrı yapılmadı.";
    if (run.status === "blocked") throw new Error(`Araştırma yapılmadı: ${run.error}`);
    if (run.status === "failed") throw new Error(`Araştırma başarısız: ${run.error}`);
    return `${sources.length} kaynak bulundu. Kaynaklar doğrulanmamış; ajanlar yalnızca sizin doğruladıklarınızı görür.`;
  });
}

export async function verifySourceAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/arastirma", async () => {
    const v = str(fd, "verification");
    if (!["verified", "rejected", "unverified"].includes(v)) throw new Error("Geçersiz durum.");
    const s = await setSourceVerification(brand.id, str(fd, "id"), v as "verified" | "rejected" | "unverified");
    await audit({ brandId: brand.id, actor: "user", action: `research.source.${v}`, message: `Araştırma kaynağı ${v === "verified" ? "ajan bağlamına alındı" : v === "rejected" ? "reddedildi" : "doğrulanmamışa döndü"}: ${s.url}` });
    return v === "verified" ? "Kaynak doğrulandı; ajanlar bunu üçüncü taraf bağlamı olarak görebilir." : "Kaynak güncellendi.";
  });
}

// ---------------------------------------------------------------- Maliyet Yönetimi

export async function saveCostControlsAction(fd: FormData) {
  await act("/maliyet", async () => {
    const cur = await getLimits();
    const providerMonthlyUsd: Record<string, number> = {};
    for (const p of COST_PROVIDERS) {
      const raw = str(fd, `monthly_${p}`).trim();
      if (raw === "") continue;
      const v = Number(raw.replace(",", "."));
      if (!Number.isFinite(v) || v < 0 || v > 100_000) throw new Error(`${p}: geçersiz aylık sınır.`);
      providerMonthlyUsd[p] = v;
    }
    const credits = Number(str(fd, "researchMonthlyCredits"));
    if (!Number.isInteger(credits) || credits < 0 || credits > 100_000) throw new Error("Aylık araştırma kredisi 0–100000 arası tam sayı olmalı.");
    const next: Limits = { ...cur, providerMonthlyUsd, webResearch: str(fd, "webResearch") === "on", researchMonthlyCredits: credits };
    await setSetting("limits", next);
    await audit({ actor: "user", action: "settings.cost_controls", message: "Maliyet kontrolleri güncellendi", data: { providerMonthlyUsd, webResearch: next.webResearch, researchMonthlyCredits: credits } });
    return "Maliyet kontrolleri kaydedildi.";
  });
}

// ---------------------------------------------------------------- Görsel / Video Stüdyosu
// Stüdyolar yeni bir yol açmaz: seçimleri Ana Yönetici'ye net bir talimat olarak gönderir. Planlama, kalite kontrolü,
// render doğrulaması ve insan onayı aynen uygulanır. Dosya kimlikleri yalnızca seçili markada aranır.

async function brandAssets(brandId: string, ids: string[], kind: "video" | "photo") {
  const out = [];
  for (const id of [...new Set(ids)].slice(0, 12)) {
    const m = await getMedia(brandId, id);
    if (!m) throw new Error("Seçilen dosya bu markanın arşivinde değil.");
    if (kind === "video" ? m.kind !== "video" : !["photo", "logo"].includes(m.kind)) throw new Error(`${m.filename}: ${kind === "video" ? "video" : "fotoğraf"} değil.`);
    out.push(m);
  }
  return out;
}

export async function videoStudioAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/studyo/video", async () => {
    const rl = rateLimit(`studio:${brand.id}`, 10, 60_000);
    if (!rl.ok) throw new Error(`Çok fazla istek; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const mode = (STUDIO_MODES as readonly string[]).includes(str(fd, "mode")) ? (str(fd, "mode") as StudioMode) : "archive";
    const videos = await brandAssets(brand.id, fd.getAll("assetIds").map(String), "video");
    const photos = (await brandAssets(brand.id, fd.getAll("photoIds").map(String), "photo")).filter((p) => p.kind === "photo").slice(0, STUDIO_MAX_PHOTOS);
    if (mode === "archive" && !videos.length) throw new Error("Arşiv kurgusu için en az bir video seçin.");
    if (mode === "hybrid" && !videos.length && !photos.length) throw new Error("Karma reklam için en az bir ürün fotoğrafı veya arşiv videosu seçin.");
    const min = Number(str(fd, "minSeconds")), max = Number(str(fd, "maxSeconds"));
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 3 || max > 90 || min > max) throw new Error("Süre 3–90 sn arasında olmalı ve en az ≤ en çok.");
    const aiScenes = Math.round(Number(str(fd, "aiScenes")) || 2), sceneSeconds = Math.round(Number(str(fd, "sceneSeconds")) || 6);
    if (mode !== "archive") {
      if (aiScenes < 1 || aiScenes > STUDIO_MAX_AI_SCENES) throw new Error(`AI sahne sayısı 1–${STUDIO_MAX_AI_SCENES} olmalı.`);
      if (sceneSeconds < 3 || sceneSeconds > 10) throw new Error("AI sahne süresi 3–10 sn olmalı (Gemini Omni sınırı).");
      const limits = await getLimits();
      if (aiScenes * sceneSeconds > limits.maxVideoGenSeconds) {
        throw new Error(`Toplam AI süresi ${aiScenes * sceneSeconds} sn; proje sınırı ${limits.maxVideoGenSeconds} sn. Sahne sayısını/süresini azaltın veya Ayarlar'dan sınırı artırın.`);
      }
    }
    const instruction = buildStudioInstruction({
      mode, videos, photos, minSeconds: min, maxSeconds: max,
      platform: str(fd, "platform") === "tiktok" ? "TikTok (9:16)" : "Instagram Reels (9:16)",
      transition: str(fd, "transition") === "fade" ? "fade" : "cut",
      aiScenes, sceneSeconds, goal: str(fd, "goal").trim().slice(0, 1500),
    });
    const r = await submitInstruction({ brandId: brand.id, instruction, idempotencyKey: str(fd, "idempotencyKey") });
    return { ok: r.duplicate ? "Bu talep zaten gönderildi." : mode === "archive" ? "Video talebi Ana Yönetici'ye gönderildi." : "AI reklam talebi Ana Yönetici'ye gönderildi (Gemini Omni sahneleri ücretli; izin ve bütçe kontrolünden geçer).", to: `/projeler/${r.project.id}` };
  });
}

export async function imageStudioAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/studyo/gorsel", async () => {
    const rl = rateLimit(`studio:${brand.id}`, 10, 60_000);
    if (!rl.ok) throw new Error(`Çok fazla istek; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const photos = await brandAssets(brand.id, fd.getAll("assetIds").map(String), "photo");
    const format = ({ post: "Instagram gönderisi (1:1)", portrait: "Instagram dikey gönderi (4:5)", story: "Story (9:16)" } as Record<string, string>)[str(fd, "format")] ?? "Instagram gönderisi (1:1)";
    const count = Math.max(1, Math.min(6, Number(str(fd, "count")) || 1));
    const goal = str(fd, "goal").trim().slice(0, 1500);
    const instruction = [
      `Görsel Stüdyosu talebi: ${count} adet ${format} görseli hazırla.`,
      photos.length ? `Gerçek ürün fotoğrafları olarak yalnızca şunları kullan: ${photos.map((p) => p.filename).join(", ")}. Ürünün rengini ve görünümünü değiştirme.` : "Arşivdeki gerçek ürün fotoğraflarından uygun olanları seç.",
      goal ? `Amaç ve notlar: ${goal}` : "",
      "Metinler marka içerik dilinde olsun. Yayınlama; onay için hazırla.",
    ].filter(Boolean).join("\n");
    const r = await submitInstruction({ brandId: brand.id, instruction, idempotencyKey: str(fd, "idempotencyKey") });
    return { ok: r.duplicate ? "Bu talep zaten gönderildi." : "Görsel talebi Ana Yönetici'ye gönderildi.", to: `/projeler/${r.project.id}` };
  });
}
