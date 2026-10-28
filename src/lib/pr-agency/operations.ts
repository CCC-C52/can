// Sürekli PR operasyonları — hangi zamanlanmış işin neyi kapsadığı (saf veri).
// Her operasyon mevcut zamanlayıcıdaki (roles.ts SCHEDULE) bir rapor türüne bağlıdır; ayrı bir zamanlayıcı yoktur.
// Raporlar model çağrısı yapmadan, yalnızca kayıtlı veriden üretilir (gereksiz AI çağrısı yok) ve onay kuyruğuna düşer.

import { SCHEDULE, type ReportKind } from "./roles";

export type Operation = { kind: ReportKind; cadence: string; owner: string; covers: string[] };

export const OPERATIONS: Operation[] = [
  { kind: "daily_brief", cadence: "Günlük", owner: "market_intelligence", covers: ["Marka istihbaratı", "Moda trendleri", "Rakip izleme", "İlgili kültürel gelişmeler"] },
  { kind: "weekly_report", cadence: "Haftalık", owner: "pr_director", covers: ["Kampanya incelemesi", "Sosyal içerik planlaması", "Influencer fırsatları", "Performans özeti"] },
  { kind: "monthly_presentation", cadence: "Aylık", owner: "pr_measurement", covers: ["PR performans raporu", "Marka konumlandırma incelemesi", "Kampanya önerileri", "İçerik üretim planlaması"] },
  { kind: "quarterly_review", cadence: "Çeyreklik", owner: "brand_strategy", covers: ["Stratejik inceleme", "OKR değerlendirmesi", "Bütçe değerlendirmesi", "Marka büyüme analizi"] },
  { kind: "annual_review", cadence: "Yıllık", owner: "pr_director", covers: ["Sekiz yıllık yol haritası değerlendirmesi", "Pazar konumlandırma incelemesi", "Stratejik öncelikler"] },
];

const WEEKDAY = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
const MONTH = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

/** Zamanlamanın okunur açıklaması (UTC ve New York saati). */
export function scheduleLabel(kind: ReportKind, ref = new Date()): string {
  const s = SCHEDULE[kind];
  const utc = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), s.hourUtc));
  const ny = utc.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
  const time = `${String(s.hourUtc).padStart(2, "0")}:00 UTC (New York ${ny})`;
  if (s.weekdayUtc !== undefined) return `Her ${WEEKDAY[s.weekdayUtc]} ${time}`;
  if (s.months?.length === 1) return `Her yıl ${s.dayOfMonth} ${MONTH[s.months[0]]} ${time}`;
  if (s.months) return `Çeyrek başı (${s.months.map((m) => MONTH[m]).join(", ")} ${s.dayOfMonth}) ${time}`;
  if (s.dayOfMonth !== undefined) return `Her ayın ${s.dayOfMonth}'i ${time}`;
  return `Her gün ${time}`;
}
