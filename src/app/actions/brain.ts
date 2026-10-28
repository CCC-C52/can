"use server";

import { act, str } from "./util";
import { requireBrand } from "@/lib/current";
import { rateLimit } from "@/lib/security/rate-limit";
import { decideKnowledgeFact } from "@/lib/knowledge/store";
import { isUuid } from "@/lib/ids";
import { reindexDocuments, retryDocuments } from "@/lib/brain/ingest";
import { getBrainConfig, setBrainConfig, setBrainPaused, type BrainBudgets } from "@/lib/brain/settings";
import { embeddingBacklog } from "@/lib/brain/worker";

// Brand Brain eylemleri (sahip). Marka kimliği oturumdaki seçili markadan alınır. Ücretli işlem yalnızca sahibin açık
// onayıyla başlar: gömmeyi açmak ve büyük toplu işlem için tutar onaylamak ayrı adımlardır.

const PAGE = "/bilgi/beyin";

export async function brainPauseAction(fd: FormData) {
  const brand = await requireBrand();
  await act(PAGE, async () => {
    const paused = str(fd, "paused") === "1";
    await setBrainPaused(brand.id, paused);
    return paused ? "İçerik işleme duraklatıldı. Drive dizini (üst veri) etkilenmez." : "İçerik işleme devam ediyor.";
  });
}

export async function brainRetryAction(fd: FormData) {
  const brand = await requireBrand();
  await act(PAGE, async () => {
    const id = str(fd, "id");
    const n = await retryDocuments(brand.id, id && isUuid(id) ? [id] : "all_failed");
    return n ? `${n} dosya yeniden kuyruğa alındı.` : "Yeniden denenecek başarısız dosya yok.";
  });
}

export async function brainReindexAction(fd: FormData) {
  const brand = await requireBrand();
  await act(PAGE, async () => {
    const scope = str(fd, "scope") === "all" ? "all" : "changed";
    const n = await reindexDocuments(brand.id, scope);
    return `${n} dosya yeniden işlenecek (${scope === "all" ? "tüm arşiv" : "değişen/başarısız/eski ayrıştırıcı"}). Ücretsiz: yalnızca indirme ve yerel ayrıştırma.`;
  });
}

export async function brainEmbeddingsAction(fd: FormData) {
  const brand = await requireBrand();
  await act(PAGE, async () => {
    const enabled = str(fd, "enabled") === "1";
    await setBrainConfig({ embeddingsEnabled: enabled });
    if (!enabled) return "Anlamsal arama gömmesi kapatıldı. Tam metin araması çalışmaya devam eder.";
    const b = await embeddingBacklog(brand.id);
    return `Gömme açıldı. Bekleyen ${b.chunks} parça, tahmini ${b.estimateUsd === null ? "bilinmiyor (fiyat yok → engellenir)" : `$${b.estimateUsd.toFixed(4)}`}. Günlük artımlı sınırı aşan toplu işlem ayrıca onay ister.`;
  });
}

export async function brainApproveBatchAction(fd: FormData) {
  const brand = await requireBrand();
  await act(PAGE, async () => {
    if (!rateLimit(`brain-approve:${brand.id}`, 5, 60_000).ok) throw new Error("Çok sık deneme; bir dakika sonra tekrar deneyin.");
    const usd = Number(str(fd, "usd").replace(",", "."));
    if (!Number.isFinite(usd) || usd <= 0 || usd > 100) throw new Error("Onay tutarı 0 ile 100 $ arasında olmalı.");
    const cur = await getBrainConfig();
    await setBrainConfig({ budgets: { initialIngestionUsd: Math.round((cur.budgets.initialIngestionUsd + usd) * 10000) / 10000 } });
    return `İlk toplu gömme için $${usd.toFixed(2)} onaylandı (toplam onay $${(cur.budgets.initialIngestionUsd + usd).toFixed(2)}). İşleyici günlük sınır içinde ilerler.`;
  });
}

export async function brainBudgetsAction(fd: FormData) {
  await requireBrand();
  await act(PAGE, async () => {
    const keys: (keyof BrainBudgets)[] = ["dailyIncrementalUsd", "embeddingsDailyUsd", "retrievalDailyUsd"];
    const budgets: Partial<BrainBudgets> = {};
    for (const k of keys) {
      const v = str(fd, k).replace(",", ".").trim();
      if (v) budgets[k] = Number(v);
    }
    await setBrainConfig({ budgets });
    return "Brand Brain bütçeleri güncellendi.";
  });
}

export async function brainFactDecisionAction(fd: FormData) {
  const brand = await requireBrand();
  await act(PAGE, async () => {
    const ids = fd.getAll("id").map(String).filter((x) => isUuid(x)).slice(0, 100);
    const decision = str(fd, "decision") === "confirm" ? "confirm" : "reject";
    if (!ids.length) throw new Error("Önce en az bir iddia seçin.");
    for (const id of ids) await decideKnowledgeFact(brand.id, id, decision);
    return `${ids.length} iddia ${decision === "confirm" ? "onaylandı (kanonik bilgi oldu)" : "reddedildi"}.`;
  });
}
