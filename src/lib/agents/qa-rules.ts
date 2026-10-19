import type { BrandContext } from "./context";
import { UNKNOWN } from "./context";
import type { QaReview } from "./schemas";

// Kural tabanlı (deterministik) kalite kontrolleri. Demo ve gerçek modda HER ZAMAN çalışır.
// Model incelemesinden bağımsızdır; sonuçlar birleştirilir ve en kötü sonuç geçerli olur.

type Check = QaReview["checks"][number];

const RISKY: { name: string; re: RegExp }[] = [
  { name: "Yüzde/oran iddiası", re: /%\s?\d+|\d+\s?%/g },
  { name: "Ücretsiz kargo/teslimat vaadi", re: /free (shipping|delivery|returns)|ücretsiz (kargo|teslimat|iade)/gi },
  { name: "Teslimat süresi vaadi", re: /\b\d+\s?(-\s?\d+\s?)?(business )?(days?|hours?|gün|saat|iş günü)\b|next[- ]day|same[- ]day|aynı gün/gi },
  { name: "Bağış iddiası", re: /donat\w*|bağış\w*|charity|hayır kurumu/gi },
  { name: "Müşteri yorumu/puan iddiası", re: /\breviews?\b|\brated\b|\brating\b|★|⭐|yorum\w*|puan\w*|testimonial/gi },
  { name: "Satış rakamı / popülerlik iddiası", re: /best[- ]?sell\w*|sold out|\bsold\b|en çok satan|tükendi|satıldı|\b\d[\d.,]*\s?(customers|müşteri)/gi },
  { name: "Garanti / sertifika iddiası", re: /guarantee\w*|garanti\w*|certified|sertifika\w*|organic|organik|sustainable|sürdürülebilir|eco[- ]friendly|çevre dostu/gi },
  { name: "İndirim iddiası", re: /\bsale\b|discount\w*|indirim\w*|\boff\b/gi },
];

const PRICE_RE = /(?:[$€£₺]\s?\d[\d.,]*|\d[\d.,]*\s?(?:TL|TRY|USD|EUR|GBP|₺|\$|€|£))/g;

const TR_MARKERS = /[çğışöüÇĞİŞÖÜ]|\b(ve|bir|için|ile|yeni|hemen|ürün|bu|çok)\b/g;
const EN_MARKERS = /\b(the|and|for|with|new|now|shop|your|this|our)\b/gi;

function customerStrings(agent: string, c: Record<string, any>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => typeof v === "string" && v.trim() && out.push(v.replace(/\[DEMO\]/g, "").replace(/<[^>]+>/g, " "));
  switch (agent) {
    case "marketing":
      c.key_messages?.forEach(push);
      c.ad_ideas?.forEach((a: any) => push(a.hook));
      break;
    case "shopify":
      c.product_changes?.forEach((p: any) => push(p.proposed_value));
      c.collections?.forEach((x: any) => { push(x.title); push(x.description); });
      c.pages?.forEach((x: any) => push(x.body));
      c.bundles?.forEach((x: any) => push(x.name));
      break;
    case "design":
      c.briefs?.forEach((b: any) => { push(b.headline); push(b.body_text); });
      break;
    case "video":
      c.videos?.forEach((v: any) => {
        v.script?.forEach((s: any) => { push(s.on_screen_text); push(s.voiceover); });
        v.subtitles?.forEach((s: any) => push(s.text));
      });
      break;
    case "social":
      c.posts?.forEach((p: any) => { push(p.caption); push(p.cta); push(p.cover_text); });
      break;
  }
  return out;
}

function verifiedCorpus(ctx: BrandContext): string {
  const b = ctx.brand;
  const parts = [b.name, b.story, b.shipping_info, b.return_policy, b.campaign_rules, ...b.verified_facts, ...b.approved_decisions];
  for (const p of ctx.products) {
    parts.push(p.title, p.price, p.compare_at_price, p.currency);
    p.verified_facts.forEach((f) => parts.push(`${f.attribute} ${f.value}`));
    p.variants.forEach((v) => parts.push(v.title, v.color, v.size, v.price));
  }
  return parts.filter((x) => x && x !== UNKNOWN).join(" \n ").toLocaleLowerCase("tr");
}

function normNum(s: string) {
  return s.replace(/[^\d.,]/g, "").replace(/,/g, ".").replace(/\.0+$/, "").replace(/\.(\d)0$/, ".$1");
}

export function detectLanguage(text: string): "tr" | "en" | "unknown" {
  const tr = (text.match(TR_MARKERS) ?? []).length;
  const en = (text.match(EN_MARKERS) ?? []).length;
  if (tr + en < 3) return "unknown";
  if (tr > en * 1.5) return "tr";
  if (en > tr * 1.5) return "en";
  return "unknown";
}

export function runRuleChecks(agent: string, content: Record<string, any>, ctx: BrandContext, opts: { isDemo: boolean }): QaReview {
  const checks: Check[] = [];
  const required: string[] = [];
  const texts = customerStrings(agent, content);
  const joined = texts.join("\n");
  const corpus = verifiedCorpus(ctx);

  // 1) Uydurma iddia taraması
  const claimHits: string[] = [];
  for (const r of RISKY) {
    for (const m of joined.matchAll(r.re)) {
      const phrase = m[0].toLocaleLowerCase("tr").trim();
      if (!corpus.includes(phrase)) claimHits.push(`${r.name}: "${m[0]}"`);
    }
  }
  if (claimHits.length) {
    checks.push({ name: "Doğrulanmamış iddia", status: "fail", detail: [...new Set(claimHits)].slice(0, 8).join("; ") });
    required.push("Marka/ürün kaydında doğrulanmamış iddiaları kaldırın veya önce doğrulanmış bilgi olarak ekleyin.");
  } else if (texts.length) {
    checks.push({ name: "Doğrulanmamış iddia", status: "pass", detail: "Riskli iddia kalıbı bulunmadı." });
  }

  // 2) Fiyat tutarlılığı
  const knownPrices = new Set<string>();
  ctx.products.forEach((p) => {
    [p.price, p.compare_at_price, ...p.variants.map((v) => v.price)].forEach((x) => x !== UNKNOWN && knownPrices.add(normNum(x)));
  });
  const badPrices = [...joined.matchAll(PRICE_RE)].map((m) => m[0]).filter((p) => !knownPrices.has(normNum(p)));
  if (badPrices.length) {
    checks.push({ name: "Fiyat doğruluğu", status: "fail", detail: `Kayıtta olmayan fiyat: ${[...new Set(badPrices)].join(", ")}` });
    required.push("Metindeki fiyatları ürün kaydındaki fiyatlarla eşleştirin.");
  }

  // 3) Doğrulanmamış ürün özellikleri ve yasaklı ifadeler
  const lowJoined = joined.toLocaleLowerCase("tr");
  const unverifiedUsed = ctx.products.flatMap((p) => p.unverified_facts).filter((f) => f.value.length > 2 && lowJoined.includes(f.value.toLocaleLowerCase("tr")));
  if (unverifiedUsed.length) {
    checks.push({ name: "Doğrulanmamış ürün özelliği", status: "fail", detail: unverifiedUsed.map((f) => `${f.attribute}: ${f.value}`).join("; ") });
    required.push("Doğrulanmamış ürün özelliklerini müşteri metninden çıkarın.");
  }
  const forbidden = ctx.brand.forbidden_claims.filter((f) => f.length > 2 && lowJoined.includes(f.toLocaleLowerCase("tr")));
  if (forbidden.length) {
    checks.push({ name: "Yasaklı ifade", status: "fail", detail: forbidden.join("; ") });
    required.push("Yasaklı ifadeleri kaldırın.");
  }

  // 4) İçerik dili
  if (texts.length && (ctx.brand.content_language === "en" || ctx.brand.content_language === "tr")) {
    const lang = detectLanguage(joined);
    if (lang !== "unknown" && lang !== ctx.brand.content_language) {
      checks.push({ name: "İçerik dili", status: "fail", detail: `Müşteri metinleri '${lang}' görünüyor; marka içerik dili '${ctx.brand.content_language}'.` });
      required.push(`Müşteriye yönelik metinleri '${ctx.brand.content_language}' diline çevirin.`);
    } else {
      checks.push({ name: "İçerik dili", status: lang === "unknown" ? "warn" : "pass", detail: lang === "unknown" ? "Dil otomatik belirlenemedi." : `Dil uyumlu (${lang}).` });
    }
  }

  // 5) Ajana özel kontroller
  const productIds = new Set(ctx.products.map((p) => p.id));
  const mediaById = new Map(ctx.media.map((m) => [m.id, m]));
  if (agent === "shopify") {
    for (const ch of content.product_changes ?? []) {
      const p = ctx.products.find((x) => x.id === ch.product_id);
      if (!p) {
        checks.push({ name: "Ürün kimliği", status: "fail", detail: `Bu markada olmayan ürün: ${ch.product_id}` });
        required.push("Yalnızca bu markanın ürünlerini kullanın.");
        continue;
      }
      const current = ch.field === "description" ? p.description : ch.field === "title" ? p.title : ch.field === "product_type" ? p.product_type : ch.field === "price" ? p.price : ch.field === "compare_at_price" ? p.compare_at_price : null;
      const cur = current === UNKNOWN ? "" : current ?? "";
      if (current !== null && String(ch.current_value ?? "").trim() !== String(cur).trim()) {
        checks.push({ name: "Mevcut değer karşılaştırması", status: "fail", detail: `"${p.title}" ${ch.field} için mevcut değer kayıtla uyuşmuyor.` });
        required.push("current_value alanını ürün kaydındaki gerçek değerle doldurun.");
      }
      if (ch.field === "price" || ch.field === "compare_at_price") {
        checks.push({ name: "Fiyat değişikliği", status: "warn", detail: `"${p.title}" için fiyat değişikliği önerildi — ayrı fiyat onayı gerekir.` });
      }
    }
    for (const col of [...(content.collections ?? []), ...(content.bundles ?? [])]) {
      const bad = (col.product_ids ?? []).filter((id: string) => !productIds.has(id));
      if (bad.length) {
        checks.push({ name: "Koleksiyon/bundle ürünleri", status: "fail", detail: `Bilinmeyen ürün kimliği: ${bad.join(", ")}` });
        required.push("Koleksiyon ve bundle'larda yalnızca mevcut ürünleri kullanın.");
      }
    }
  }
  if (agent === "design") {
    for (const b of content.briefs ?? []) {
      for (const id of b.source_asset_ids ?? []) {
        const m = mediaById.get(id);
        if (!m) {
          checks.push({ name: "Kaynak görsel", status: "fail", detail: `Brief ${b.id}: arşivde olmayan dosya ${id}` });
          required.push("Yalnızca arşivdeki dosyaları kaynak gösterin.");
        } else if (m.origin === "ai_generated" && b.use_real_product_photo) {
          checks.push({ name: "Gerçek / AI ayrımı", status: "fail", detail: `Brief ${b.id}: AI görseli gerçek ürün fotoğrafı olarak işaretlenmiş.` });
          required.push("AI ile üretilmiş görseli gerçek ürün fotoğrafı olarak sunmayın.");
        } else if (m.rights_status === "restricted") {
          checks.push({ name: "Kullanım hakkı", status: "fail", detail: `Brief ${b.id}: ${m.filename} kullanım hakkı kısıtlı.` });
          required.push("Kullanım hakkı kısıtlı dosyaları çıkarın.");
        } else if (m.rights_status === "unknown") {
          checks.push({ name: "Kullanım hakkı", status: "warn", detail: `${m.filename}: kullanım hakkı bilinmiyor.` });
        }
      }
      if (!b.use_real_product_photo && b.product_ids?.length) {
        checks.push({ name: "Ürün sadakati", status: "warn", detail: `Brief ${b.id}: AI görseli ürünü içerirse baskı, renk ve kalıp değişebilir — insan kontrolü gerekli.` });
      }
    }
  }
  if (agent === "video") {
    for (const v of content.videos ?? []) {
      if (v.mode === "edit_existing") {
        for (const id of v.selected_asset_ids ?? []) {
          const m = mediaById.get(id);
          if (!m || m.kind !== "video") {
            checks.push({ name: "Çekim seçimi", status: "fail", detail: `${v.id}: arşivde olmayan veya video olmayan dosya ${id}` });
            required.push("edit_existing için yalnızca arşivdeki video dosyalarını seçin.");
          }
        }
      } else {
        checks.push({ name: "AI video", status: "warn", detail: `${v.id}: yeni AI görüntüsü üretimi planlandı; gerçek ürün görüntüsü yerine geçmez.` });
      }
      const late = (v.subtitles ?? []).filter((s: any) => s.end > v.duration_s + 0.01 || s.start >= s.end);
      if (late.length) {
        checks.push({ name: "Altyazı zamanlaması", status: "fail", detail: `${v.id}: ${late.length} altyazı süre dışında veya hatalı.` });
        required.push("Altyazı zamanlarını video süresi içinde tutun.");
      }
    }
  }
  if (agent === "social") {
    for (const p of content.posts ?? []) {
      const tags = (p.hashtags ?? []).length + ((p.caption ?? "").match(/#\w+/g) ?? []).length;
      if ((p.caption ?? "").length > 2200) {
        checks.push({ name: "Açıklama uzunluğu", status: "fail", detail: `${p.id}: ${p.caption.length} karakter (sınır 2.200).` });
        required.push("Açıklamaları 2.200 karakterin altında tutun.");
      }
      if (p.platform === "instagram" && tags > 30) {
        checks.push({ name: "Hashtag sayısı", status: "fail", detail: `${p.id}: ${tags} hashtag (Instagram sınırı 30).` });
        required.push("Instagram gönderilerinde en fazla 30 hashtag kullanın.");
      }
      if (Number.isNaN(Date.parse(p.suggested_datetime))) {
        checks.push({ name: "Yayın zamanı", status: "fail", detail: `${p.id}: geçersiz tarih.` });
        required.push("suggested_datetime alanını ISO 8601 biçiminde verin.");
      }
    }
  }

  // 6) Bilinmeyenlerin raporlanması
  const unknownFields = [ctx.brand.target_audience, ctx.brand.shipping_info, ctx.brand.return_policy].filter((v) => v === UNKNOWN).length;
  if (unknownFields && Array.isArray(content.unknowns) && content.unknowns.length === 0) {
    checks.push({ name: "Bilinmeyenler", status: "warn", detail: "Marka kaydında eksik alanlar var ama çıktı bunları listelemiyor." });
  }

  if (opts.isDemo) checks.push({ name: "Üretim kaynağı", status: "warn", detail: "DEMO: Bu çıktı kural tabanlı şablonla üretildi, gerçek AI üretimi değildir." });

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  return {
    verdict: fails ? "needs_changes" : "pass",
    score: Math.max(0, 100 - fails * 25 - warns * 5),
    checks,
    required_changes: [...new Set(required)],
  };
}

/** Kural ve model incelemelerini birleştirir; en kötü karar geçerli olur. */
export function mergeReviews(rule: QaReview, model: QaReview | null, modelSource: string): QaReview & { sources: string[] } {
  if (!model) return { ...rule, sources: ["rules"] };
  const order = { pass: 0, needs_changes: 1, fail: 2 } as const;
  const verdict = order[model.verdict] > order[rule.verdict] ? model.verdict : rule.verdict;
  return {
    verdict,
    score: Math.round(Math.min(rule.score, model.score || rule.score)),
    checks: [...rule.checks, ...model.checks.map((c) => ({ ...c, name: `${c.name} (${modelSource})` }))],
    required_changes: [...new Set([...rule.required_changes, ...model.required_changes])],
    sources: ["rules", modelSource],
  };
}
