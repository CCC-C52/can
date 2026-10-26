// FriBee tema kuralları. Sistem yalnızca ÖNERİ üretir; doğrulama her zaman sahibe aittir.
// Kaynaklar ücretsiz ve yereldir: dosya/klasör adı ve (isteğe bağlı) Drive önizlemesinin baskın rengi (sharp).
// Hiçbir LLM veya ücretli görsel analiz servisi çağrılmaz.
//
// Renk tek başına baskıyı kanıtlamaz: düz turuncu bir tişört Anime baskılı ürün DEĞİLDİR. Renk ipucu bu yüzden
// en düşük güvenle ve "baskı kontrolü gerekli" notuyla verilir; doğrulamada basılı tasarımın görünür ve doğru olduğu
// sahip tarafından ayrıca onaylanır (artwork_confirmed).

export const FRIBEE_THEMES = ["space_alien", "music", "anime", "save_the_bee"] as const;
export type FribeeTheme = (typeof FRIBEE_THEMES)[number];
export const REFERENCE_VIEWS = ["front", "back", "detail", "other"] as const;
export type ReferenceView = (typeof REFERENCE_VIEWS)[number] | "unknown";
export type GarmentColour = "black" | "white" | "orange" | "light_blue";

export const THEME_INFO: Record<FribeeTheme, { label: string; garment: GarmentColour; garmentLabel: string; note: string }> = {
  space_alien: { label: "Space Alien", garment: "black", garmentLabel: "siyah", note: "Siyah ürün üzerinde Space Alien baskısı." },
  music: { label: "Music", garment: "white", garmentLabel: "beyaz", note: "Beyaz ürün. Mandala tasarımı Music temasına aittir." },
  anime: { label: "Anime", garment: "orange", garmentLabel: "turuncu", note: "Turuncu ürün üzerinde basılı Anime tasarımı. Düz/baskısız turuncu tişört Anime sayılmaz." },
  save_the_bee: { label: "Save the Bee", garment: "light_blue", garmentLabel: "açık mavi", note: "Açık mavi ürün üzerinde Save the Bee baskısı." },
};

export const VIEW_LABEL: Record<ReferenceView, string> = { front: "Ön", back: "Arka", detail: "Detay", other: "Diğer", unknown: "Bilinmiyor" };

const COLOUR_THEME: Record<GarmentColour, FribeeTheme> = { black: "space_alien", white: "music", orange: "anime", light_blue: "save_the_bee" };

function fold(text: string) {
  return text
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ö/g, "o").replace(/ç/g, "c")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

const THEME_WORDS: Record<FribeeTheme, string[]> = {
  space_alien: ["alien", "aliens", "spacealien", "uzayli", "uzaylilar", "ufo", "space", "uzay"],
  music: ["music", "muzik", "musik", "mandala", "mandalas"],
  anime: ["anime"],
  save_the_bee: ["savethebee", "bee", "bees", "honeybee", "ari", "arilar"],
};
const VIEW_WORDS: Record<Exclude<ReferenceView, "unknown" | "other">, string[]> = {
  front: ["front", "onyuz", "onden", "frontal"],
  back: ["back", "arka", "arkadan", "arkayuz", "rear"],
  detail: ["detail", "detay", "detayi", "closeup", "close", "macro", "makro", "yakin", "yakinplan", "zoom"],
};

/** Ad/yol metninden tema ve görünüm ipuçları. Birden çok tema eşleşirse tema belirsizdir (null). */
export function suggestFromText(text: string): { theme: FribeeTheme | null; themeHits: FribeeTheme[]; view: ReferenceView | null } {
  const raw = text.toLocaleLowerCase("tr");
  const folded = fold(text);
  const tokens = new Set(folded.split(/[^a-z0-9]+/).filter(Boolean));
  const joined = folded.replace(/[^a-z0-9]+/g, "");
  const themeHits = FRIBEE_THEMES.filter((t) => THEME_WORDS[t].some((w) => tokens.has(w)) || (t === "save_the_bee" && joined.includes("savethebee")) || (t === "space_alien" && joined.includes("spacealien")));
  const views = (Object.keys(VIEW_WORDS) as (keyof typeof VIEW_WORDS)[]).filter((v) => VIEW_WORDS[v].some((w) => tokens.has(w)));
  // "ön" katlanınca İngilizce "on" ile karışır; yalnızca özgün metinde "ön" bir kelime olarak geçiyorsa sayılır.
  if (/(^|[^\p{L}])ön([^\p{L}]|$)/u.test(raw) && !views.includes("front")) views.push("front");
  return { theme: themeHits.length === 1 ? themeHits[0] : null, themeHits, view: views.length === 1 ? views[0] : null };
}

/** Baskın renkten ürün rengi sınıfı (yalnızca ipucu; arka plan da baskın olabilir). */
export function classifyGarmentColour(rgb: { r: number; g: number; b: number }): GarmentColour | null {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  if (l < 0.16) return "black";
  if (l > 0.86 && s < 0.35) return "white";
  if (h >= 12 && h <= 45 && s > 0.45 && l >= 0.3 && l <= 0.75) return "orange";
  if (h >= 180 && h <= 215 && s > 0.25 && l >= 0.55) return "light_blue";
  return null;
}

export type Suggestion = {
  theme: FribeeTheme | null;
  view: ReferenceView;
  confidence: number;
  detail: { text_themes: FribeeTheme[]; text_view: ReferenceView | null; colour: GarmentColour | null; colour_theme: FribeeTheme | null; reasons: string[] };
};

/** Ad ve renk ipuçlarını birleştirir. Güven hiçbir zaman otomatik doğrulama için yeterli sayılmaz (< 1). */
export function combineSuggestion(text: string, colour: GarmentColour | null): Suggestion {
  const t = suggestFromText(text);
  const colourTheme = colour ? COLOUR_THEME[colour] : null;
  const reasons: string[] = [];
  let theme: FribeeTheme | null = null;
  let confidence = 0;
  if (t.themeHits.length > 1) reasons.push("Adda birden çok tema geçiyor.");
  if (t.theme && colourTheme) {
    if (t.theme === colourTheme) {
      theme = t.theme;
      confidence = 0.7;
      reasons.push("Ad ve ürün rengi aynı temayı gösteriyor.");
    } else {
      confidence = 0.2;
      reasons.push(`Ad '${THEME_INFO[t.theme].label}', renk '${THEME_INFO[colourTheme].label}' gösteriyor: çelişki.`);
    }
  } else if (t.theme) {
    theme = t.theme;
    confidence = 0.45;
    reasons.push("Yalnızca dosya/klasör adına dayanıyor.");
  } else if (colourTheme) {
    theme = colourTheme;
    confidence = colourTheme === "anime" ? 0.15 : 0.3;
    reasons.push("Yalnızca baskın renge dayanıyor; baskı görünür olmalı.");
  } else {
    reasons.push("Tema ipucu bulunamadı.");
  }
  if (theme === "anime" || colourTheme === "anime") reasons.push("Turuncu renk Anime baskısını kanıtlamaz: basılı tasarımı görselde kontrol edin.");
  if (t.view === null) reasons.push("Ön/arka/detay adda belirtilmemiş.");
  return { theme, view: t.view ?? "unknown", confidence, detail: { text_themes: t.themeHits, text_view: t.view, colour, colour_theme: colourTheme, reasons } };
}

export const isTheme = (v: unknown): v is FribeeTheme => typeof v === "string" && (FRIBEE_THEMES as readonly string[]).includes(v);
export const isView = (v: unknown): v is (typeof REFERENCE_VIEWS)[number] => typeof v === "string" && (REFERENCE_VIEWS as readonly string[]).includes(v);
