"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { act, str } from "./util";
import { BRAND_COOKIE, requireBrand } from "@/lib/current";
import { SESSION_COOKIE, checkPassword, signSession } from "@/lib/auth";
import { config } from "@/lib/config";
import {
  addBrandFact, addProductFact, addVariant, createBrand, createProduct, deleteBrandFact, deleteProductFact, deleteVariant, getBrand, updateBrand, updateProduct,
} from "@/lib/services/brands";
import { submitInstruction, cancelTask, cancelProject, retryTask, requestRegeneration, setPaused, retryWaitingConnections } from "@/lib/orchestrator/projects";
import { decide, editOutput, revokeApproval } from "@/lib/services/outputs";
import { executeExternalAction, reconcileAction, type ActionType } from "@/lib/services/gateway";
import { updateMediaMeta, getMedia } from "@/lib/services/media";
import { setSetting, getLimits, type Limits } from "@/lib/settings";
import { seedSampleBrand } from "@/lib/services/sample";
import { disconnect, type ProviderId, upsertConnection } from "@/lib/services/connections";
import { testShopify, syncShopifyProducts } from "@/lib/adapters/shopify";
import { testInstagram } from "@/lib/adapters/instagram";
import { testOpenAIImages } from "@/lib/adapters/images";
import { testAnthropic } from "@/lib/models/test";
import { tagWithAI } from "@/lib/services/tagging";
import { audit } from "@/lib/audit";

// ---------------------------------------------------------------- Oturum

export async function loginAction(fd: FormData) {
  const next = str(fd, "next") || "/";
  const ok = await checkPassword(str(fd, "password"));
  if (!ok) redirect(`/login?err=${encodeURIComponent("Parola hatalı.")}&next=${encodeURIComponent(next)}`);
  const s = signSession();
  (await cookies()).set(SESSION_COOKIE, s.value, { httpOnly: true, sameSite: "lax", secure: config.appMode === "production", maxAge: s.maxAge, path: "/" });
  await audit({ actor: "user", action: "auth.login", message: "Panele giriş yapıldı" });
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logoutAction() {
  (await cookies()).delete(SESSION_COOKIE);
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
    return r.duplicate ? "Bu talimat zaten alınmıştı (çift gönderim engellendi)." : "Talimat ana yöneticiye iletildi.";
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
    await decide(brand.id, str(fd, "versionId"), decision, { note: str(fd, "note"), scopes });
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

export async function aiTagAction(fd: FormData) {
  const brand = await requireBrand();
  const id = str(fd, "id");
  await act(`/medya/${id}`, async () => {
    const n = await tagWithAI(brand.id, id);
    return `${n} AI etiketi eklendi. Etiketleri düzeltebilirsiniz.`;
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
      maxAttempts: n("maxAttempts", 1, 5),
      maxRegenerations: n("maxRegenerations", 0, 10),
      perTaskBudgetUsd: money("perTaskBudgetUsd"),
      dailyBudgetUsd: money("dailyBudgetUsd"),
      blockUnknownCost: str(fd, "blockUnknownCost") === "on",
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
