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
  addBrandFact, addProductFact, addVariant, createBrand, createProduct, deleteBrandFact, deleteProductFact, deleteVariant, getBrand, parseBrandColors, updateBrand, updateProduct,
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
import { REFERENCE_MIN_SHORT_SIDE, referenceTooSmall } from "@/lib/video/reference";
import { releaseJob } from "@/lib/services/provider-jobs";
import { testAnthropic } from "@/lib/models/test";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/security/rate-limit";
import { runResearch, setSourceVerification } from "@/lib/services/research";
import { COST_PROVIDERS } from "@/lib/services/costs";
import { addMemory, setMemoryStatus, type MemoryKind, type MemoryStatus } from "@/lib/services/brand-memory";
import type { AgentId } from "@/lib/agents/schemas";
import { disconnectDrive, requestDriveScan, selectArchiveFolder, setDrivePaused } from "@/lib/drive/source";
import { generateDue, getPrConfig, pollFeeds, updatePrConfig } from "@/lib/services/pr-agency";
import { addKnowledgeFact, collectionKey, confirmFribeeCollections, decideKnowledgeFact } from "@/lib/knowledge/store";
import type { EntityType } from "@/lib/knowledge/graph";
import type { Sensitivity } from "@/lib/knowledge/types";
import { THEME_INFO, isTheme, type FribeeTheme } from "@/lib/drive/themes";
import { autoQueueReferences, bulkReview, getDriveItem, verifiedCatalogPhotos, verifiedThemesOf, importReferenceOriginal, proposeMemoryFromDocument, reviewReference, suggestReferences, unverifiedDriveAssetIds, type ReviewInput } from "@/lib/drive/references";

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
  const colors = parseBrandColors(str(fd, "colors"));
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
    if (provider === "google_drive") {
      const r = await disconnectDrive(brand.id);
      return r.revoked ? "Google Drive bağlantısı kaldırıldı ve izin Google'da iptal edildi." : "Google Drive bağlantısı kaldırıldı (Google'da iptal doğrulanamadı).";
    }
    await disconnect(provider, ["shopify", "instagram"].includes(provider) ? brand.id : null);
    return "Bağlantı kaldırıldı.";
  });
}

// ---------------------------------------------------------------- Google Drive arşivi
// Marka kimliği her zaman çerezdeki seçili markadan alınır; form alanlarındaki kimlikler o markada aranır.

const DRIVE_PAGE = "/drive-arsivi";

export async function driveSelectFolderAction(fd: FormData) {
  const brand = await requireBrand();
  await act(DRIVE_PAGE, async () => {
    const s = await selectArchiveFolder(brand.id, str(fd, "folderId"));
    return `Klasör seçildi: ${s.folder_name}. İlk tarama işleyicide arka planda başlar.`;
  });
}

export async function driveScanNowAction() {
  const brand = await requireBrand();
  await act(DRIVE_PAGE, async () => {
    const rl = rateLimit(`drive-scan:${brand.id}`, 3, 60_000);
    if (!rl.ok) throw new Error(`Çok sık istendi; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    await requestDriveScan(brand.id);
    return "Tarama sıraya alındı; işleyici kaldığı yerden sürdürecek.";
  });
}

export async function drivePauseAction(fd: FormData) {
  const brand = await requireBrand();
  await act(DRIVE_PAGE, async () => {
    const pause = str(fd, "pause") === "1";
    await setDrivePaused(brand.id, pause);
    return pause ? "Tarama duraklatıldı." : "Tarama sürdürülüyor.";
  });
}

export async function driveDisconnectAction(fd: FormData) {
  const brand = await requireBrand();
  await act(DRIVE_PAGE, async () => {
    const purge = str(fd, "purge") === "1";
    if (purge && str(fd, "confirm") !== "SIL") throw new Error("Yerel dizini silmek için onay kutusuna SIL yazın. (Drive'daki dosyalar hiçbir durumda silinmez.)");
    const r = await disconnectDrive(brand.id, { purgeIndex: purge });
    return `Google Drive bağlantısı kaldırıldı${r.revoked ? " ve izin Google'da iptal edildi" : ""}${purge ? "; yerel dizin silindi" : ""}.`;
  });
}

export async function driveSuggestAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`${DRIVE_PAGE}?tab=review`, async () => {
    const rl = rateLimit(`drive-suggest:${brand.id}`, 10, 60_000);
    if (!rl.ok) throw new Error(`Çok sık istendi; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const r = await suggestReferences(brand.id, fd.getAll("itemIds").map(String), { useThumbnails: str(fd, "useThumbnails") === "1" });
    return `${r.references.length} görsel inceleme kuyruğuna eklendi (öneriler belirsiz kabul edilir; doğrulama sizde).`;
  });
}

export async function driveReviewAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`${DRIVE_PAGE}?tab=review`, async () => {
    const action = str(fd, "action");
    if (!["verify", "reject", "reset"].includes(action)) throw new Error("Geçersiz işlem.");
    await reviewReference(brand.id, str(fd, "referenceId"), {
      action: action as ReviewInput["action"], theme: str(fd, "theme") || null, view: str(fd, "view") || null,
      artworkConfirmed: str(fd, "artworkConfirmed") === "1", notes: str(fd, "notes") || null,
    });
    return action === "verify" ? "Referans doğrulandı; Bilgi Merkezi ve stüdyolar artık kullanabilir." : action === "reject" ? "Referans reddedildi; hiçbir AI isteğinde kullanılmaz." : "Referans incelemeye geri alındı.";
  });
}

export async function driveAutoQueueAction() {
  const brand = await requireBrand();
  await act(`${DRIVE_PAGE}?tab=review`, async () => {
    const r = await autoQueueReferences(brand.id, { limit: 2000 });
    return `${r.queued} ürün fotoğrafı inceleme kuyruğuna eklendi${r.skipped ? `; ${r.skipped} dosya (logo/grafik veya düşük çözünürlük) alınmadı` : ""}.`;
  });
}

export async function driveBulkReviewAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`${DRIVE_PAGE}?tab=review`, async () => {
    const action = str(fd, "action") === "reject" ? "reject" : "verify";
    const ids = fd.getAll("sel").map(String);
    const r = await bulkReview(brand.id, ids.map((id) => ({ referenceId: id, theme: str(fd, `theme:${id}`) || null, view: str(fd, `view:${id}`) || null })), action, { artworkConfirmed: str(fd, "artworkConfirmed") === "1" });
    const head = action === "verify" ? `${r.done} görsel onaylandı; orijinaller arka planda arşive alınıyor.` : `${r.done} görsel reddedildi.`;
    if (r.errors.length) throw new Error(`${head} ${r.errors.length} görsel işlenemedi: ${[...new Set(r.errors)].slice(0, 3).join(" · ")}`);
    return head;
  });
}

export async function driveImportAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`${DRIVE_PAGE}?tab=hub`, async () => {
    const rl = rateLimit(`drive-import:${brand.id}`, 20, 60_000);
    if (!rl.ok) throw new Error(`Çok sık istendi; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const r = await importReferenceOriginal(brand.id, str(fd, "referenceId"));
    return r.duplicate ? "Bu referans zaten medya arşivinde." : "Orijinal dosya (tam çözünürlük, bayt bayt) medya arşivine alındı; Video ve Görsel Stüdyosu'nda ürün referansı olarak seçilebilir.";
  });
}

export async function driveProposeMemoryAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`${DRIVE_PAGE}?tab=files`, async () => {
    const rl = rateLimit(`drive-doc:${brand.id}`, 20, 60_000);
    if (!rl.ok) throw new Error(`Çok sık istendi; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const r = await proposeMemoryFromDocument(brand.id, str(fd, "itemId"), (str(fd, "kind") || "guideline") as MemoryKind);
    const theme = str(fd, "collection");
    if (isTheme(theme)) {
      // Belge koleksiyon hikâyesi olarak Bilgi Merkezi inceleme kuyruğuna da girer (onaylanınca ajanlar kaynaklı olarak görür)
      const it = await getDriveItem(brand.id, str(fd, "itemId"));
      if (it) await addKnowledgeFact(brand.id, { entityType: "collection", entityKey: collectionKey(theme), entityName: THEME_INFO[theme].label, attribute: "story_document", value: it.name, status: "extracted", driveItemId: it.id, method: "document", sensitivity: "internal" });
    }
    return `${r.added} bölüm Marka Hafızası'na öneri olarak eklendi${r.skipped ? ` (${r.skipped} bölüm gizli bilgi şüphesiyle atlandı)` : ""}${r.truncated ? "; belge uzun, ilk bölümler alındı" : ""}. Marka Hafızası sayfasında etkinleştirince ajanlar kullanır.`;
  });
}

// ---------------------------------------------------------------- PR Ajansı (otomasyon)

const PR_PAGE = "/pr-ajansi";

export async function prConfigAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`${PR_PAGE}?tab=automation`, async () => {
    const start = str(fd, "roadmapStart");
    if (start && !/^\d{4}-\d{2}$/.test(start)) throw new Error("Plan başlangıcı YYYY-AA olmalı.");
    const cfg = await updatePrConfig(brand.id, {
      enabled: str(fd, "enabled") === "1",
      enabledSources: fd.getAll("sources").map(String),
      ...(start ? { roadmapStart: `${start}-01` } : {}),
    });
    return `PR ajansı ayarları kaydedildi: zamanlanmış üretim ${cfg.enabled ? "açık" : "kapalı"}, ${cfg.enabledSources.length} kaynak etkin.`;
  });
}

export async function prVerifyDateAction(fd: FormData) {
  const brand = await requireBrand();
  await act(`${PR_PAGE}?tab=calendar`, async () => {
    const id = str(fd, "id");
    const cfg = await getPrConfig(brand.id);
    const date = str(fd, "date"), endDate = str(fd, "endDate"), sourceUrl = str(fd, "sourceUrl");
    await updatePrConfig(brand.id, { verifiedDates: { ...cfg.verifiedDates, [id]: { date, ...(endDate ? { endDate } : {}), sourceUrl } } });
    return "Etkinlik tarihi kaynağıyla kaydedildi; takvime eklendi.";
  });
}

export async function prRunNowAction() {
  const brand = await requireBrand();
  await act(`${PR_PAGE}?tab=automation`, async () => {
    const rl = rateLimit(`pr-run:${brand.id}`, 3, 10 * 60_000);
    if (!rl.ok) throw new Error(`Çok sık istendi; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const polled = await pollFeeds(brand.id);
    const created = await generateDue(brand.id);
    const fetched = polled.filter((p) => p.status === "fetched").length, failed = polled.filter((p) => p.status === "failed").length;
    return `Beslemeler: ${fetched} başarılı, ${failed} başarısız. ${created.length} yeni taslak üretildi (onay kuyruğunda). Ücretli servis çağrılmadı.`;
  });
}

// ---------------------------------------------------------------- Marka bilgi sistemi

const KNOWLEDGE_PAGE = "/bilgi";

export async function knowledgeConfirmCollectionsAction() {
  const brand = await requireBrand();
  await act(KNOWLEDGE_PAGE, async () => {
    const r = await confirmFribeeCollections(brand.id);
    return r.added ? `Dört koleksiyon ve renkleri onaylı bilgi olarak kaydedildi (${r.added} olgu).` : "Koleksiyonlar zaten kayıtlı.";
  });
}

export async function knowledgeAddFactAction(fd: FormData) {
  const brand = await requireBrand();
  await act(KNOWLEDGE_PAGE, async () => {
    const rl = rateLimit(`knowledge:${brand.id}`, 30, 60_000);
    if (!rl.ok) throw new Error(`Çok sık istendi; ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const status = str(fd, "status") === "confirmed" ? "confirmed" : "suggested";
    const theme = str(fd, "collection");
    await addKnowledgeFact(brand.id, {
      entityType: (isTheme(theme) ? "collection" : str(fd, "entityType")) as EntityType,
      entityKey: isTheme(theme) ? collectionKey(theme) : undefined,
      entityName: isTheme(theme) ? THEME_INFO[theme].label : str(fd, "entityName"),
      attribute: str(fd, "attribute"), value: str(fd, "value"), status,
      sensitivity: (str(fd, "sensitivity") || "internal") as Sensitivity,
      driveItemId: str(fd, "driveItemId") || null, sourceNote: str(fd, "sourceNote") || null, method: "manual",
    });
    return status === "confirmed" ? "Bilgi onaylı olarak kaydedildi." : "Bilgi öneri olarak inceleme kuyruğuna eklendi.";
  });
}

export async function knowledgeDecideAction(fd: FormData) {
  const brand = await requireBrand();
  await act(KNOWLEDGE_PAGE, async () => {
    const decision = str(fd, "decision") === "confirm" ? "confirm" : "reject";
    await decideKnowledgeFact(brand.id, str(fd, "id"), decision);
    return decision === "confirm" ? "Bilgi onaylandı; yetkili ajanlar artık kullanır." : "Bilgi reddedildi; hiçbir yerde kullanılmaz.";
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
    let photos = (await brandAssets(brand.id, fd.getAll("photoIds").map(String), "photo")).filter((p) => p.kind === "photo").slice(0, STUDIO_MAX_PHOTOS);
    const collection = isTheme(str(fd, "collection")) ? (str(fd, "collection") as FribeeTheme) : null;
    if (collection && mode !== "archive" && !photos.length) {
      // Koleksiyon seçildi, fotoğraf seçilmedi: doğrulanmış katalog fotoğrafları (ön, arka, detay) otomatik referans olur
      const picked = await verifiedCatalogPhotos(brand.id, collection, STUDIO_MAX_PHOTOS);
      if (!picked.length) throw new Error(`${THEME_INFO[collection].label} için doğrulanmış ve orijinali arşive alınmış katalog fotoğrafı yok. Drive Arşivi'nde doğrulayıp “Orijinali arşive al” deyin veya fotoğraf seçin.`);
      photos = await brandAssets(brand.id, picked.map((p) => p.media_asset_id), "photo");
    }
    if (collection && photos.length) {
      // Koleksiyon seçiliyken yalnızca o koleksiyonun sahip tarafından doğrulanmış katalog fotoğrafları referans olabilir
      const themes = await verifiedThemesOf(brand.id, photos.map((p) => p.id));
      const wrong = photos.filter((p) => themes.has(p.id) && themes.get(p.id) !== collection);
      if (wrong.length) throw new Error(`Koleksiyon eşleşmiyor: ${wrong.map((p) => `${p.filename} (${THEME_INFO[themes.get(p.id)!].label})`).join(", ")} seçilen ${THEME_INFO[collection].label} koleksiyonuna ait değil.`);
      const unverifiedRefs = photos.filter((p) => !themes.has(p.id));
      if (unverifiedRefs.length) throw new Error(`Doğrulanmamış ürün görseli: ${unverifiedRefs.map((p) => p.filename).join(", ")}. Drive Arşivi'nde doğrulayıp orijinali arşive alın veya fotoğraf seçmeyin (doğrulanmış katalog fotoğrafları otomatik seçilir).`);
    }
    const aiOnly = mode !== "archive" && str(fd, "aiOnly") === "1";
    if (aiOnly && !photos.length) throw new Error("Yalnızca AI video modu için gerçek ürün referansı gerekli: koleksiyon seçin (doğrulanmış katalog fotoğrafları) veya fotoğraf seçin.");
    let musicId: string | null = null;
    if (str(fd, "musicId")) {
      const m = await getMedia(brand.id, str(fd, "musicId"));
      if (!m || m.kind !== "audio") throw new Error("Seçilen müzik bu markanın arşivinde değil.");
      if (!["owned", "licensed"].includes(String(m.rights_status))) throw new Error(`${m.filename}: kullanım hakkı (lisans) kayıtlı değil; reklamda kullanılamaz.`);
      musicId = m.id;
    }
    const extraFormat = str(fd, "extraFormat") === "16:9" ? ("16:9" as const) : null;
    const lowRes = photos.filter((p) => referenceTooSmall(p.width, p.height));
    if (lowRes.length) throw new Error(`Düşük çözünürlüklü referans: ${lowRes.map((p) => `${p.filename} (${p.width}x${p.height})`).join(", ")}. Kısa kenarı en az ${REFERENCE_MIN_SHORT_SIDE} piksel olan orijinal fotoğraf seçin.`);
    const unverified = await unverifiedDriveAssetIds(brand.id, photos.map((p) => p.id));
    if (unverified.length) throw new Error("Seçilen Drive referanslarından biri doğrulanmamış veya reddedilmiş; Drive Arşivi'nde inceleyin.");
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
      aiScenes, sceneSeconds, goal: str(fd, "goal").trim().slice(0, 1500), collection, musicId, extraFormat, aiOnly,
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
