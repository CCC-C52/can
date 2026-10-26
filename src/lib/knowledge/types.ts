// FriBee marka bilgi sistemi — ortak türler.
// Bu modül saf TypeScript'tir: veritabanı, ağ veya ücretli yapay zekâ çağrısı yapmaz.
// Kalıcı depolama ve Google Drive OAuth bağlantısı sahip onayı sonrasında eklenecektir (docs/BRAND_KNOWLEDGE.md).

/** Bir bilginin güvenilirlik durumu. Ajanlar yalnızca "confirmed" bilgiyi gerçek olarak kullanır. */
export const CLAIM_STATUSES = ["extracted", "confirmed", "suggested", "unknown"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Kaydın hassasiyeti; rol bazlı erişimde kullanılır. */
export const SENSITIVITIES = ["public", "internal", "vendor", "finance", "private"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/** Rol bazlı erişim için bilgi tüketen ajan rolleri. */
export const KNOWLEDGE_ROLES = ["manager", "video_design", "marketing", "pr", "finance"] as const;
export type KnowledgeRole = (typeof KNOWLEDGE_ROLES)[number];

/** Drive arşivindeki dosya kategorileri. */
export const ARCHIVE_CATEGORIES = [
  "product_names",
  "product_story",
  "collection_history",
  "design_source",
  "lookbook",
  "catalog_photo",
  "catalog_video",
  "production_spec",
  "logistics",
  "business_record",
  "financial_record",
  "pr_coverage",
  "other",
] as const;
export type ArchiveCategory = (typeof ARCHIVE_CATEGORIES)[number];

/** Kaynak izi: her bilgi orijinal Drive dosyasına ve revizyonuna bağlanır. */
export type Provenance = {
  /** Sahip beyanında (method "owner") Drive dosyası olmayabilir; o durumda null. */
  driveFileId: string | null;
  revisionId: string | null;
  sourceUrl: string;
  /** Dosyanın Drive'daki son değişiklik zamanı (ISO). */
  modifiedTime: string;
  /** Sistemin dosyayı okuduğu zaman (ISO). */
  indexedAt: string;
  /** Çıkarım yöntemi: dosya meta verisi, OCR, görsel analiz veya sahip girişi. */
  method: "metadata" | "ocr" | "vision" | "owner" | "manual";
};

export class KnowledgeError extends Error {}
export class BrandIsolationError extends KnowledgeError {}
export class PermissionDeniedError extends KnowledgeError {}
