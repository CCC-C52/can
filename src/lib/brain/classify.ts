import { looksSecret } from "@/lib/services/brand-memory";
import { FRIBEE_THEMES, type FribeeTheme } from "@/lib/drive/themes";
import type { Sensitivity } from "@/lib/knowledge/types";

// Brand Brain için deterministik sınıflandırma (AI yok): koleksiyon anılması, içerikten hassasiyet yükseltme,
// gizli bilgi ve komut enjeksiyonu (prompt injection) işaretleri. Sonuçlar ÖNERİDİR: koleksiyon tespiti bir ürünün
// o koleksiyona ait olduğunu doğrulamaz (ürün kimliği yalnızca sahip doğrulamasıyla belirlenir).

const COLLECTION_RE: Record<FribeeTheme, RegExp> = {
  space_alien: /\b(space[\s_-]?alien|uzayl[ıi]|ufo)\b/i,
  music: /\b(music|m[üu]zik|mandala)\b/i,
  anime: /\banime\b/i,
  save_the_bee: /\b(save[\s_-]?the[\s_-]?bee|savethebee|ar[ıi]lar[ıi]? kurtar)\b/i,
};

/** Metinde anılan FriBee koleksiyonları (tema anahtarları). "mandala" yalnızca Music koleksiyonuna işaret eder. */
export function collectionsIn(text: string): FribeeTheme[] {
  return FRIBEE_THEMES.filter((t) => COLLECTION_RE[t].test(text));
}

const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, vendor: 2, finance: 3, private: 4 };
export const maxSensitivity = (a: Sensitivity, b: Sensitivity): Sensitivity => (RANK[a] >= RANK[b] ? a : b);

const FINANCE_RE = /\b(iban|swift|fatura|invoice|maa[şs]|salary|payroll|bilan[çc]o|gelir tablosu|income statement|profit and loss|p&l|vergi no|tax id|banka hesab|bank account|kar marj|profit margin|ciro|revenue)\b/i;
const PRIVATE_RE = /\b(gizlilik s[öo]zle[şs]mesi|nda|non-disclosure|tc kimlik|t\.c\. kimlik|passport|pasaport|ki[şs]isel veri|personal data)\b/i;

/**
 * Dosya kategorisinden gelen hassasiyeti içerikle YÜKSELTİR (asla düşürmez). Gizli bilgi (anahtar, parola, kart) içeren
 * parça "private" olur ve hiçbir ajana verilmez; finansal terimler "finance" (yalnızca Finans rolü).
 */
export function contentSensitivity(base: Sensitivity, text: string): { sensitivity: Sensitivity; flags: string[] } {
  const flags: string[] = [];
  let s = base;
  if (looksSecret(text)) { s = "private"; flags.push("secret_withheld"); }
  else if (PRIVATE_RE.test(text)) s = maxSensitivity(s, "private");
  else if (FINANCE_RE.test(text)) s = maxSensitivity(s, "finance");
  return { sensitivity: s, flags };
}

const INJECTION_RE = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|all|earlier|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|messages?)\b/i,
  /\b(önceki|yukar[ıi]daki|t[üu]m)\b[^.\n]{0,30}\b(talimat|kural|komut)\w*\b[^.\n]{0,30}\b(yok say|unut|g[öo]rmezden gel|ge[çc]ersiz)/i,
  /\b(you are now|act as|new instructions|system prompt|developer mode|jailbreak)\b/i,
  /\b(reveal|print|show|send|exfiltrate|leak)\b[^.\n]{0,40}\b(api[ _-]?keys?|secrets?|tokens?|passwords?|credentials?|system prompt)\b/i,
  /\b(approve|publish|post|send|delete|transfer|pay)\b[^.\n]{0,40}\b(without|no)\b[^.\n]{0,20}\b(approval|review|confirmation|onay)\b/i,
  /<\/?(data|system|instructions?|brand_context|brand_brain_sources|operator_instruction)>|<\|im_(start|end)\|>|\[\/?INST\]/i,
];

/** Belge metninde ajan talimatı gibi görünen ifadeler. İşaretli parçalar ajan bağlamına girmez (panelde görünür). */
export function injectionFlags(text: string): string[] {
  return INJECTION_RE.some((r) => r.test(text)) ? ["possible_prompt_injection"] : [];
}

/** Model istemine konacak belge metni: veri etiketlerini kıramaz, kontrol karakteri içermez. */
export function neutralizeForPrompt(text: string) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/</g, "‹").replace(/>/g, "›");
}
