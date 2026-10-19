// İstemci ve sunucuda ortak kullanılan durum etiketleri (Türkçe panel).

export const TASK_STATUSES = [
  "planned",
  "ready",
  "running",
  "review_pending",
  "approval_pending",
  "completed",
  "failed",
  "cancelled",
  "waiting_connection",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  planned: "Planlandı",
  ready: "Hazır",
  running: "Çalışıyor",
  review_pending: "Kontrol bekliyor",
  approval_pending: "Onay bekliyor",
  completed: "Tamamlandı",
  failed: "Başarısız",
  cancelled: "İptal edildi",
  waiting_connection: "Bağlantı bekliyor",
};

export const TASK_STATUS_TONE: Record<TaskStatus, Tone> = {
  planned: "neutral",
  ready: "info",
  running: "info",
  review_pending: "warn",
  approval_pending: "warn",
  completed: "ok",
  failed: "bad",
  cancelled: "neutral",
  waiting_connection: "warn",
};

export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];

export type Tone = "ok" | "bad" | "warn" | "info" | "neutral" | "demo";

export const CONNECTION_STATUSES = ["not_connected", "testing", "connected", "reauth_required", "error", "unsupported"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  not_connected: "Bağlı değil",
  testing: "Test ediliyor",
  connected: "Bağlı",
  reauth_required: "Yetki yenilemesi gerekiyor",
  error: "Hata",
  unsupported: "Desteklenmiyor",
};

export const CONNECTION_STATUS_TONE: Record<ConnectionStatus, Tone> = {
  not_connected: "neutral",
  testing: "info",
  connected: "ok",
  reauth_required: "warn",
  error: "bad",
  unsupported: "neutral",
};

export const PROJECT_STATUS_LABEL: Record<string, string> = {
  planning: "Planlanıyor",
  running: "Yürütülüyor",
  needs_attention: "İlgi bekliyor",
  completed: "Tamamlandı",
  failed: "Başarısız",
  cancelled: "İptal edildi",
};

export const APPROVAL_SCOPE_LABEL: Record<string, string> = {
  content: "İçerik onayı",
  publish: "Dış platformda yayınlama",
  store_update: "Canlı mağaza güncellemesi",
  price_change: "Fiyat / indirim değişikliği",
  ad_launch: "Reklam başlatma / bütçe değişikliği",
};

export const EXTERNAL_ACTION_STATUS_LABEL: Record<string, string> = {
  blocked: "Engellendi",
  pending: "Bekliyor",
  executing: "Gönderiliyor",
  succeeded: "Başarılı",
  failed: "Başarısız",
  unknown: "Sonuç belirsiz — kontrol gerekli",
  manual_export: "Manuel yayın paketi hazır",
};

export const MEDIA_ORIGIN_LABEL: Record<string, string> = {
  real_photo: "Gerçek ürün fotoğrafı",
  real_video: "Gerçek çekim",
  ai_generated: "AI ile üretildi",
  edited: "Düzenlenmiş sürüm",
  design_file: "Tasarım dosyası",
  export: "Dışa aktarma",
};

export const RIGHTS_LABEL: Record<string, string> = {
  unknown: "Bilinmiyor",
  owned: "Marka sahibi",
  licensed: "Lisanslı",
  restricted: "Kısıtlı",
};

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "İngilizce" },
  { code: "tr", label: "Türkçe" },
  { code: "de", label: "Almanca" },
  { code: "fr", label: "Fransızca" },
  { code: "es", label: "İspanyolca" },
  { code: "ar", label: "Arapça" },
];

export function langLabel(code: string) {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
