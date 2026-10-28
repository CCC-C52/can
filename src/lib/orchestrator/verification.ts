// Gerçek yürütme ve doğrulama aşamaları.
// Bir metin yanıtı, JSON belgesi veya render planı, dış bir işlemin gerçekleştiğinin kanıtı DEĞİLDİR.
// Bu modül her görevin/operasyonun hangi aşamada olduğunu ve "tamamlandı" sayılması için hangi kanıtın gerektiğini
// tek yerde tanımlar. Saf modül: kanıtlar çağıran tarafından veritabanından okunur.

export const STAGES = ["plan_created", "task_scheduled", "execution_started", "external_service_called", "output_produced", "output_verified", "completed", "failed"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  plan_created: "Plan oluşturuldu",
  task_scheduled: "Görev zamanlandı",
  execution_started: "Yürütme başladı",
  external_service_called: "Dış servis çağrıldı",
  output_produced: "Çıktı üretildi",
  output_verified: "Çıktı doğrulandı",
  completed: "Tamamlandı",
  failed: "Başarısız",
};

/** Görev/operasyon türüne göre gereken kanıt. */
export type EvidenceKind = "playable_media" | "publish_confirmation" | "source_backed_results" | "delivery_evidence" | "saved_report" | "saved_output";

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  playable_media: "Erişilebilir ve oynatılabilir medya dosyası",
  publish_confirmation: "Platformdan gelen yayın onayı (dış kimlik)",
  source_backed_results: "Doğrulanmış kaynaklara dayalı bulgular",
  delivery_evidence: "Yetkili gönderim kanıtı",
  saved_report: "Kaydedilmiş ve erişilebilir rapor",
  saved_output: "Kaydedilmiş çıktı sürümü",
};

export type Evidence = {
  /** Kaydedilmiş çıktı sürümü sayısı. */
  savedVersions: number;
  /** Doğrulanmış (ffprobe ile okunmuş) video dosyaları ve eksik video teslimatları. */
  verifiedVideos: number;
  missingVideoDeliverables: string[];
  /** Ücretli/dış sağlayıcı işleri (ör. video üretimi) — gönderilmiş/sonuçlanmış. */
  providerJobs: { status: string }[];
  /** Dış işlemler (yayın, mağaza güncellemesi). */
  externalActions: { status: string; externalId: string | null }[];
  /** Doğrulanmış araştırma kaynakları. */
  verifiedSources: number;
};

export const NO_EVIDENCE: Evidence = { savedVersions: 0, verifiedVideos: 0, missingVideoDeliverables: [], providerJobs: [], externalActions: [], verifiedSources: 0 };

/** Görevin gerektirdiği kanıt (görev türü, ajan ve yetenekten). */
export function requiredEvidence(t: { kind: string; agent: string; requires_capability?: string | null }): EvidenceKind {
  if (t.kind === "render" || t.agent === "video" || t.requires_capability === "video_generation" || t.requires_capability === "video_edit") return "playable_media";
  if (t.requires_capability?.startsWith("social_publish") || t.requires_capability === "store_write") return "publish_confirmation";
  if (t.agent === "research" || t.requires_capability === "web_research") return "source_backed_results";
  if (t.requires_capability === "outreach_send") return "delivery_evidence";
  if (t.kind === "report") return "saved_report";
  return "saved_output";
}

export function evidenceSatisfied(kind: EvidenceKind, e: Evidence): boolean {
  switch (kind) {
    case "playable_media": return e.verifiedVideos > 0 && e.missingVideoDeliverables.length === 0;
    case "publish_confirmation": return e.externalActions.some((a) => a.status === "succeeded" && !!a.externalId);
    case "source_backed_results": return e.verifiedSources > 0;
    case "delivery_evidence": return e.externalActions.some((a) => a.status === "succeeded" && !!a.externalId);
    case "saved_report":
    case "saved_output": return e.savedVersions > 0;
  }
}

/**
 * Görev durumu + kanıttan aşama. Kanıt yoksa görev "tamamlandı" GÖSTERİLMEZ; durum alanı "completed" olsa bile
 * aşama "output_produced" (veya altı) kalır ve evidenceMissing işaretlenir.
 */
export function deriveStage(t: { status: string; kind: string; agent: string; requires_capability?: string | null; started_at?: string | null }, e: Evidence): { stage: Stage; required: EvidenceKind; satisfied: boolean; evidenceMissing: boolean; reached: Stage[] } {
  const required = requiredEvidence(t);
  const satisfied = evidenceSatisfied(required, e);
  const called = e.providerJobs.length > 0 || e.externalActions.some((a) => a.status !== "blocked" && a.status !== "pending");
  const produced = e.savedVersions > 0 || e.verifiedVideos > 0;
  let stage: Stage;
  if (t.status === "failed" || t.status === "cancelled") stage = "failed";
  else if (t.status === "completed" && satisfied) stage = "completed";
  else if (satisfied) stage = "output_verified";
  else if (produced) stage = "output_produced";
  else if (called) stage = "external_service_called";
  else if (t.status === "running" || t.status === "review_pending" || t.status === "approval_pending" || t.started_at) stage = "execution_started";
  else if (t.status === "ready" || t.status === "waiting_connection") stage = "task_scheduled";
  else stage = "plan_created";
  const order = STAGES.indexOf(stage === "failed" ? "plan_created" : stage);
  const reached = STAGES.filter((s, i) => s !== "failed" && i <= order && (s !== "external_service_called" || called));
  return { stage, required, satisfied, evidenceMissing: t.status === "completed" && !satisfied, reached };
}

/** Operasyon çalıştırmasının "completed" sayılabilmesi için kanıt kontrolü: kaydedilmiş rapor sürümü zorunlu. */
export function operationEvidence(o: { outputId: string | null; savedVersions: number; periodKey: string; contentPeriodKey: string | null }): { ok: boolean; reason: string | null } {
  if (!o.outputId) return { ok: false, reason: "Kaydedilmiş rapor yok." };
  if (o.savedVersions < 1) return { ok: false, reason: "Rapor sürümü kaydedilmemiş." };
  if (o.contentPeriodKey !== o.periodKey) return { ok: false, reason: `Rapor dönemi eşleşmiyor (${o.contentPeriodKey ?? "yok"} ≠ ${o.periodKey}).` };
  return { ok: true, reason: null };
}
