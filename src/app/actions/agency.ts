"use server";

import { act, str } from "./util";
import { requireBrand } from "@/lib/current";
import { rateLimit } from "@/lib/security/rate-limit";
import { addStrategyItem, recordMeasurement, seedStrategy, updateStrategyItem } from "@/lib/services/strategy";
import { addLibraryEntry, seedLibrary, setLibraryVerification, type LibraryKind } from "@/lib/services/library";
import { removeIntegration, saveCredentials, startSetup, testIntegration } from "@/lib/integrations/service";
import { integrationDef, type IntegrationId } from "@/lib/integrations/registry";
import { setHeroAsset } from "@/lib/services/hq";
import type { StrategyLevel, StrategyStatus } from "@/lib/pr-agency/strategy";

// FriBee HQ, PR Ajansı stratejisi, bilgi kütüphanesi ve Entegrasyon Merkezi eylemleri.
// Marka kimliği her zaman oturumdaki seçili markadan alınır (form alanından alınmaz).

const STRATEGY = "/pr-ajansi/strateji";
const LIBRARY = "/pr-ajansi/kutuphane";
const INTEGRATIONS = "/entegrasyonlar";

export async function strategySeedAction() {
  const brand = await requireBrand();
  await act(STRATEGY, async () => {
    const r = await seedStrategy(brand.id);
    return r.created ? `${r.created} öneri kalemi oluşturuldu. Hepsi "öneri" durumunda; onayladıklarınız resmî strateji olur.` : "Çerçeve zaten mevcut; değişiklik yapılmadı.";
  });
}

export async function strategyUpdateAction(fd: FormData) {
  const brand = await requireBrand();
  await act(STRATEGY, async () => {
    const patch: Parameters<typeof updateStrategyItem>[2] = {};
    if (fd.has("title")) patch.title = str(fd, "title");
    if (fd.has("body")) patch.body = str(fd, "body");
    if (str(fd, "status")) patch.status = str(fd, "status") as StrategyStatus;
    await updateStrategyItem(brand.id, str(fd, "id"), patch, { reason: str(fd, "reason") || null });
    return "Strateji kalemi güncellendi; değişiklik geçmişe kaydedildi.";
  });
}

export async function strategyMeasureAction(fd: FormData) {
  const brand = await requireBrand();
  await act(STRATEGY, async () => {
    const value = Number(str(fd, "value").replace(",", "."));
    await recordMeasurement(brand.id, str(fd, "id"), Number(str(fd, "index")), str(fd, "which") === "baseline" ? "baseline" : "current", { value, measuredAt: str(fd, "measuredAt"), source: str(fd, "source") });
    return "Ölçüm kaynağıyla kaydedildi.";
  });
}

export async function strategyAddAction(fd: FormData) {
  const brand = await requireBrand();
  await act(STRATEGY, async () => {
    const krLabel = str(fd, "krLabel").trim();
    const item = await addStrategyItem(brand.id, {
      level: str(fd, "level") as StrategyLevel,
      parentId: str(fd, "parentId") || null,
      periodKey: str(fd, "periodKey"),
      title: str(fd, "title"),
      body: str(fd, "body") || null,
      ownerRole: str(fd, "ownerRole") || null,
      keyResults: krLabel ? [{ label: krLabel, metric: krLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40) || "kr", target: str(fd, "krTarget").trim() || "Set after baseline is measured", baseline: null, current: null }] : [],
    });
    return `Eklendi: ${item.title} (${item.period_key}).`;
  });
}

export async function librarySeedAction() {
  const brand = await requireBrand();
  await act(LIBRARY, async () => {
    const r = await seedLibrary(brand.id);
    return r.created ? `${r.created} profesyonel çerçeve kütüphaneye eklendi.` : "Çerçeveler zaten mevcut.";
  });
}

export async function libraryAddAction(fd: FormData) {
  const brand = await requireBrand();
  await act(LIBRARY, async () => {
    const year = Number(str(fd, "publishedYear"));
    const e = await addLibraryEntry(brand.id, {
      kind: str(fd, "kind") as LibraryKind, category: str(fd, "category"), title: str(fd, "title"), summary: str(fd, "summary"),
      application: str(fd, "application") || null, sourceTitle: str(fd, "sourceTitle") || null, sourceUrl: str(fd, "sourceUrl") || null,
      publisher: str(fd, "publisher") || null, publishedYear: Number.isInteger(year) && year > 1900 ? year : null,
    });
    return `Kütüphaneye eklendi: ${e.title} (doğrulama bekliyor).`;
  });
}

export async function libraryVerifyAction(fd: FormData) {
  const brand = await requireBrand();
  await act(LIBRARY, async () => {
    await setLibraryVerification(brand.id, str(fd, "id"), str(fd, "verification") as "verified" | "partially_verified" | "needs_review", str(fd, "note"));
    return "Doğrulama durumu güncellendi.";
  });
}

function integrationId(fd: FormData): IntegrationId {
  const id = str(fd, "integration");
  if (!integrationDef(id)) throw new Error("Bilinmeyen entegrasyon.");
  return id as IntegrationId;
}

export async function integrationStartAction(fd: FormData) {
  const brand = await requireBrand();
  await act(INTEGRATIONS, async () => {
    const id = integrationId(fd);
    await startSetup(brand.id, id);
    return `${integrationDef(id)!.name}: kurulum başlatıldı. Kimlik bilgileri girildiğinde test edilebilir.`;
  });
}

export async function integrationSaveAction(fd: FormData) {
  const brand = await requireBrand();
  await act(INTEGRATIONS, async () => {
    const id = integrationId(fd);
    const rl = rateLimit(`integration-save:${brand.id}:${id}`, 10, 60_000);
    if (!rl.ok) throw new Error(`Çok fazla deneme. ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const input: Record<string, string> = {};
    for (const f of integrationDef(id)!.fields) input[f.name] = str(fd, f.name);
    const r = await saveCredentials(brand.id, id, input);
    if ("ok" in r && r.ok === false) throw new Error(r.detail);
    return r.detail;
  });
}

export async function integrationTestAction(fd: FormData) {
  const brand = await requireBrand();
  await act(INTEGRATIONS, async () => {
    const id = integrationId(fd);
    const rl = rateLimit(`integration-test:${brand.id}:${id}`, 10, 60_000);
    if (!rl.ok) throw new Error(`Çok fazla deneme. ${rl.retryAfterS} sn sonra tekrar deneyin.`);
    const r = await testIntegration(brand.id, id, { shop: str(fd, "shop") || undefined });
    if (!r.ok) throw new Error(r.detail);
    return r.detail;
  });
}

export async function integrationRemoveAction(fd: FormData) {
  const brand = await requireBrand();
  await act(INTEGRATIONS, async () => {
    const id = integrationId(fd);
    await removeIntegration(brand.id, id);
    return `${integrationDef(id)!.name}: kimlik bilgileri silindi.`;
  });
}

export async function heroSelectAction(fd: FormData) {
  const brand = await requireBrand();
  await act("/medya", async () => {
    const id = str(fd, "mediaId");
    await setHeroAsset(brand.id, id || null);
    return id ? "Ana ekran kapak görseli ayarlandı." : "Kapak görseli otomatik seçime alındı.";
  });
}
