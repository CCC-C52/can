// Sahibin talimatındaki ölçülebilir video teslim şartları (süre aralığı, kapak karesi zamanı).
// Kurallar deterministiktir: AI'nın tahminine bırakılmaz, render ve doğrulama aynı değeri kullanır.

export type VideoSpec = {
  /** Çıktının en kısa/en uzun süresi (sn); talimatta yoksa null. */
  minSeconds: number | null;
  maxSeconds: number | null;
  /** Kapak karesi: ilk kaynak videodaki zaman (sn); talimatta yoksa null (çıktıdan otomatik seçilir). */
  coverSourceS: number | null;
};

const num = (s: string) => Number(s.replace(",", "."));
const UNIT = String.raw`(?:sn\b|saniye\w*|sec\w*|seconds?\b|s\b)`;
const VALUE = String.raw`(\d{1,3}(?:[.,]\d+)?)`;
const COVER_RE = new RegExp(String.raw`(?:kapak|cover)[^\n.,;]{0,40}?${VALUE}\s*\.?\s*(?:'?\s*(?:inci|ıncı|uncu|üncü|nci|ncı|ncu|ncü)\s*)?${UNIT}`, "i");
const STUDIO_RANGE_RE = /Reklam süresi:\s*(\d{1,3})-(\d{1,3})\s*sn/i;
const RANGE_RE = new RegExp(String.raw`${VALUE}\s*(?:-|–|—|ile|to)\s*${VALUE}\s*-?\s*${UNIT}`, "i");
const SINGLE_RE = new RegExp(String.raw`(?<![\d.,:x×])${VALUE}\s*-?\s*${UNIT}`, "i");

/**
 * Talimatlardan teslim şartları. Önce sahibin Video Stüdyosu satırı ("Reklam süresi: 12-15 sn"), sonra serbest metindeki
 * aralık ("12-15 saniyelik", "12–15 sn", "12 to 15 seconds"). Tek değer ("15 saniyelik") yalnızca üst sınırdır (+0,5 sn).
 * Kapak: "kapak 1.5. saniyeden", "cover frame at 1.5 s". İlk metin önceliklidir (sahibin talimatı, sonra görev talimatı).
 */
export function parseVideoSpec(...texts: (string | null | undefined)[]): VideoSpec {
  const spec: VideoSpec = { minSeconds: null, maxSeconds: null, coverSourceS: null };
  for (const raw of texts) {
    if (!raw) continue;
    let text = raw;
    if (spec.coverSourceS === null) {
      const c = COVER_RE.exec(text);
      if (c && num(c[1]) >= 0 && num(c[1]) < 3600) spec.coverSourceS = num(c[1]);
    }
    // Kapak zamanı ve stüdyonun AI sahne süresi ("2 × 6 sn") reklam süresi sanılmasın
    text = text.replace(COVER_RE, " ").replace(/\(AI sahne:[^)]*\)/gi, " ");
    if (spec.maxSeconds === null) {
      const studio = STUDIO_RANGE_RE.exec(text);
      const range = studio ?? RANGE_RE.exec(text);
      if (range) {
        const a = num(range[1]), b = num(range[2]);
        if (a > 0 && b >= a && b <= 600) { spec.minSeconds = a; spec.maxSeconds = b; }
      } else {
        const single = SINGLE_RE.exec(text);
        if (single && num(single[1]) >= 3 && num(single[1]) <= 600) spec.maxSeconds = num(single[1]) + 0.5;
      }
    }
  }
  return spec;
}

export function describeSpec(s: VideoSpec) {
  const parts: string[] = [];
  if (s.maxSeconds !== null) parts.push(s.minSeconds !== null ? `süre ${s.minSeconds}–${s.maxSeconds} sn` : `süre en fazla ${s.maxSeconds} sn`);
  if (s.coverSourceS !== null) parts.push(`kapak karesi kaynağın ${s.coverSourceS}. saniyesi`);
  return parts.join(", ");
}
