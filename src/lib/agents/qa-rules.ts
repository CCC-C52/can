import type { StudioRequest } from "@/lib/video/studio";
import { REFERENCE_MIN_SHORT_SIDE, referenceTooSmall } from "@/lib/video/reference";
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
      c.pdp_drafts?.forEach((d: any) => { push(d.headline); push(d.body); d.bullet_points?.forEach(push); push(d.seo_title); push(d.seo_description); });
      break;
    case "design":
      c.briefs?.forEach((b: any) => { push(b.headline); push(b.body_text); b.slides?.forEach((x: any) => { push(x.headline); push(x.body_text); }); });
      break;
    case "video":
      c.videos?.forEach((v: any) => {
        v.script?.forEach((s: any) => { push(s.on_screen_text); push(s.voiceover); });
        v.segments?.forEach((s: any) => push(s.on_screen_text));
        v.subtitles?.forEach((s: any) => push(s.text));
        push(v.intro_text); push(v.outro_text);
      });
      break;
    case "pr":
      c.pitch_drafts?.forEach((p: any) => { push(p.subject); push(p.body); });
      break;
    case "social":
      c.posts?.forEach((p: any) => { push(p.caption); push(p.cta); push(p.cover_text); });
      c.reels_ideas?.forEach((r: any) => { push(r.hook); push(r.on_screen_text); });
      c.tiktok_concepts?.forEach((r: any) => push(r.hook));
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

export function runRuleChecks(agent: string, content: Record<string, any>, ctx: BrandContext, opts: { isDemo: boolean; studio?: StudioRequest | null }): QaReview {
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
    // Özel adlar (marka ve ürün adları) dil tespitinden çıkarılır: Türkçe adlı bir markanın İngilizce metni yanlış işaretlenmez
    const names = [ctx.brand.name, ...ctx.products.map((p) => p.title)].filter((n) => n && n.length > 1).sort((a, b) => b.length - a.length);
    let langText = joined;
    for (const n of names) langText = langText.split(n).join(" ");
    const lang = detectLanguage(langText);
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
    for (const d of content.pdp_drafts ?? []) {
      if (!productIds.has(d.product_id)) {
        checks.push({ name: "Ürün sayfası taslağı", status: "fail", detail: `Bu markada olmayan ürün: ${d.product_id}` });
        required.push("Yalnızca bu markanın ürünlerini kullanın.");
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
    // Video görevi gerçek bir dosya üretmeli: yalnızca senaryo/plan "başarılı video" sayılmaz
    const producing = (content.videos ?? []).filter((v: any) => ["edit_existing", "generate_new", "compose"].includes(v.mode));
    if (!producing.length) {
      checks.push({ name: "Video dosyası", status: "fail", detail: "Planda üretilecek video yok (edit_existing / generate_new / compose). Yalnızca senaryo bir video teslimi değildir." });
      required.push("En az bir gerçek video üretim öğesi planlayın; mümkün değilse nedenini unknowns alanına yazın (görev başarısız sayılır, sahte başarı raporlanmaz).");
    }
    if (opts.studio && opts.studio.mode !== "archive") {
      for (const c of (content.videos ?? []).filter((v: any) => v.mode === "compose")) {
        const parts: any[] = c.parts ?? [];
        if (opts.studio.aiOnly && parts.some((p) => p.kind !== "ai_scene")) {
          checks.push({ name: "Yalnızca AI video", status: "fail", detail: `${c.id}: sahip yalnızca AI video sahneleri istedi; plan fotoğraf hareketi veya arşiv parçası içeriyor.` });
          required.push("compose parçalarını yalnızca generate_new AI sahnelerinden (ai_scene) oluşturun.");
        }
        const gen = new Map<string, any>((content.videos ?? []).filter((v: any) => v.mode === "generate_new").map((v: any) => [v.id, v]));
        const est = parts.reduce((a, p) => a + (p.kind === "ai_scene" ? Math.min(Number(p.duration_s) || 0, Number(gen.get(p.ref)?.duration_s) || Number(p.duration_s) || 0) : Number(p.duration_s) || 0), 0)
          + 3 - Math.max(0, parts.length) * 0.5;
        if (opts.studio.minSeconds && est < opts.studio.minSeconds - 1) {
          checks.push({ name: "Reklam süresi", status: "fail", detail: `${c.id}: tahmini süre ${est.toFixed(1)} sn; sahip en az ${opts.studio.minSeconds} sn istedi.` });
          required.push(`Toplam süreyi en az ${opts.studio.minSeconds} sn yapın (sahne sayısı × süre).`);
        }
      }
    }
    for (const v of content.videos ?? []) {
      if (v.mode === "edit_existing") {
        for (const id of v.selected_asset_ids ?? []) {
          const m = mediaById.get(id);
          if (!m || m.kind !== "video") {
            checks.push({ name: "Çekim seçimi", status: "fail", detail: `${v.id}: arşivde olmayan veya video olmayan dosya ${id}` });
            required.push("edit_existing için yalnızca arşivdeki video dosyalarını seçin.");
          }
        }
        // Sahne bölümleri: yalnızca doğrulanmış analiz sahnelerinden, kaynak süresi içinde
        const segs: any[] = v.segments ?? [];
        if (!segs.length) {
          checks.push({ name: "Sahne bölümleri", status: "fail", detail: `${v.id}: kurgu için doğrulanmış sahne bölümü (segments) yok.` });
          required.push("Kurguyu yalnızca analizi tamamlanmış videoların sahnelerinden segments olarak tanımlayın.");
        }
        const bad: string[] = [];
        segs.forEach((sg, i) => {
          const m = mediaById.get(sg.asset_id);
          const a = m?.analysis as any;
          const scene = a?.scenes?.find((x: any) => x.index === sg.scene_index);
          const dur = Number(a?.duration_s ?? m?.duration_s ?? NaN);
          const why = !m || m.kind !== "video" ? "arşivde olmayan dosya"
            : !a ? "görsel analizi yok (sahne uydurulamaz)"
            : !scene ? `analizde ${sg.scene_index} numaralı sahne yok (uydurma sahne)`
            : !(sg.source_end > sg.source_start) || sg.source_end - sg.source_start < 0.5 ? "geçersiz/0,5 sn'den kısa aralık"
            : sg.source_start < 0 || (Number.isFinite(dur) && sg.source_end > dur + 0.05) ? `kaynak süresini (${dur} sn) aşıyor`
            : sg.source_start < scene.start - 0.15 || sg.source_end > scene.end + 0.15 ? `sahne sınırları (${scene.start}–${scene.end} sn) dışında`
            : null;
          if (why) bad.push(`bölüm ${i + 1}: ${why}`);
        });
        if (bad.length) {
          checks.push({ name: "Sahne doğrulaması", status: "fail", detail: `${v.id}: ${bad.slice(0, 5).join("; ")}` });
          required.push("Bölümleri yalnızca ilgili videonun analizindeki sahne sınırları içinde, kaynak zamanlarıyla tanımlayın.");
        } else if (segs.length) {
          checks.push({ name: "Sahne doğrulaması", status: "pass", detail: `${v.id}: ${segs.length} bölüm doğrulanmış analiz sahneleriyle uyumlu.` });
        }
      } else if (v.mode === "compose") {
        composeChecks(v, content, mediaById, checks, required);
      } else {
        checks.push({ name: "AI video", status: "warn", detail: `${v.id}: yeni AI görüntüsü üretimi planlandı; gerçek ürün görüntüsü yerine geçmez.` });
        if (!String(v.generation_prompt ?? "").trim()) {
          checks.push({ name: "AI sahne istemi", status: "fail", detail: `${v.id}: generation_prompt boş; sahne üretilemez.` });
          required.push("Her generate_new sahnesi için sinematik bir generation_prompt yazın.");
        }
        const photos = (v.selected_asset_ids ?? []).filter((id: string) => mediaById.get(id)?.kind === "photo");
        if (ALTERS_DESIGN.test(String(v.generation_prompt ?? ""))) {
          checks.push({ name: "Tasarım sadakati", status: "fail", detail: `${v.id}: istem ürünün rengini/baskısını/tasarımını değiştirmeyi istiyor; marka tasarımları ve renkleri değiştirilemez.` });
          required.push("AI istemi ürünün tasarımını, baskısını, logosunu veya rengini değiştirmemeli; referans fotoğraftaki gibi korumalı.");
        }
        const lowRes = photos.filter((id: string) => { const m = mediaById.get(id); return referenceTooSmall(m?.width, m?.height); });
        if (lowRes.length) {
          checks.push({ name: "Referans netliği", status: "fail", detail: `${v.id}: ${lowRes.length} referans fotoğrafın kısa kenarı ${REFERENCE_MIN_SHORT_SIDE} pikselden küçük; baskı detayı korunamaz.` });
          required.push(`Yalnızca kısa kenarı en az ${REFERENCE_MIN_SHORT_SIDE} piksel olan orijinal ürün fotoğraflarını referans seçin.`);
        }
        collectionChecks(v, photos, ctx, opts.studio?.collection ?? null, checks, required);
        if (opts.studio?.photoIds.length && !photos.length) {
          checks.push({ name: "Ürün referansı", status: "fail", detail: `${v.id}: sahibin seçtiği ürün fotoğrafları referans olarak verilmedi; ürün baskısı ve rengi korunamaz.` });
          required.push("generate_new sahnelerinde selected_asset_ids olarak stüdyoda seçilen ürün fotoğraflarını verin.");
        }
      }
      const late = (v.subtitles ?? []).filter((s: any) => s.end > v.duration_s + 0.01 || s.start >= s.end);
      if (late.length) {
        checks.push({ name: "Altyazı zamanlaması", status: "fail", detail: `${v.id}: ${late.length} altyazı süre dışında veya hatalı.` });
        required.push("Altyazı zamanlarını video süresi içinde tutun.");
      }
    }
  }
  if (agent === "video") {
    // Birleştirilen reklam tek koleksiyonu göstermeli: AI sahnelerinin referansları ve ürün fotoğrafı parçaları aynı koleksiyondan
    const byAsset = collectionOfAssets(ctx);
    const vids: any[] = content.videos ?? [];
    for (const c of vids.filter((v) => v.mode === "compose")) {
      const ids: string[] = [];
      for (const p of c.parts ?? []) {
        if (p.kind === "product_photo") ids.push(String(p.ref));
        if (p.kind === "ai_scene") ids.push(...(vids.find((v) => v.id === p.ref)?.selected_asset_ids ?? []));
      }
      const cols = [...new Set(ids.map((id) => byAsset.get(id)).filter(Boolean))];
      if (cols.length > 1 || (opts.studio?.collection && cols.some((x) => x !== opts.studio!.collection))) {
        checks.push({ name: "Koleksiyon ve baskı eşleşmesi", status: "fail", detail: `${c.id}: reklam farklı koleksiyonların ürünlerini karıştırıyor (${cols.join(", ")}).` });
        required.push("Bir reklamda yalnızca seçilen koleksiyonun ürün fotoğraflarını ve AI sahnelerini kullanın.");
      }
    }
  }
  if (agent === "video" && opts.studio && opts.studio.mode !== "archive") {
    const vids: any[] = content.videos ?? [];
    const gen = vids.filter((v) => v.mode === "generate_new");
    const comp = vids.filter((v) => v.mode === "compose");
    if (!gen.length || !comp.length) {
      checks.push({ name: "Stüdyo talebi", status: "fail", detail: `Sahip Video Stüdyosu'nda "${opts.studio.mode}" modunu seçti; plan ${gen.length} AI sahnesi ve ${comp.length} birleştirme (compose) içeriyor. Yalnızca arşiv kurgusu kabul edilmez.` });
      required.push(`${opts.studio.aiScenes} adet generate_new AI sahnesi ve bunları birleştiren bir compose videosu planlayın.`);
    } else {
      checks.push({ name: "Stüdyo talebi", status: "pass", detail: `${gen.length} AI sahnesi ve ${comp.length} birleştirme planlandı.` });
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

  if (agent === "pr") {
    // Uydurma iletişim bilgisi veya erişim/etkileşim rakamı yasak; gönderim yok
    const prText = JSON.stringify([content.pitch_drafts ?? [], content.media_targets ?? [], content.story_angles ?? []]);
    const contacts = [...prText.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+|(?<![\w@])@[A-Za-z0-9_.]{3,30}\b/g)].map((m) => m[0]);
    if (contacts.length) {
      checks.push({ name: "Uydurma iletişim bilgisi", status: "fail", detail: `İletişim bilgisi/hesap adı: ${[...new Set(contacts)].slice(0, 5).join(", ")}` });
      required.push("Gazeteci/creator e-postası veya hesap adı yazmayın; yalnızca hedef TÜRÜ belirtin. Gerçek kişiler sahip tarafından doğrulanır.");
    }
    const reach = [...prText.matchAll(/\b\d+(?:[.,]\d+)?\s?(?:k|m|bin|milyon|million)?\s?(?:followers|takipçi|views|görüntülenme|reach|erişim|impressions)\b/gi)].map((m) => m[0]);
    if (reach.length) {
      checks.push({ name: "Uydurma erişim rakamı", status: "fail", detail: [...new Set(reach)].slice(0, 5).join(", ") });
      required.push("Ölçülmemiş takipçi/erişim/görüntülenme rakamı yazmayın.");
    }
    // Koleksiyon eşleşmesi: hikâye açısı onaylı bir koleksiyona bağlanmalı
    const known = new Set((ctx.knowledge?.collections ?? []).map((c) => c.name.toLowerCase()));
    const stray = (content.story_angles ?? []).filter((x: any) => x.collection && x.collection.toLowerCase() !== "brand" && known.size && !known.has(String(x.collection).toLowerCase()));
    if (stray.length) {
      checks.push({ name: "Koleksiyon eşleşmesi", status: "fail", detail: `Onaylı olmayan koleksiyon: ${stray.map((x: any) => x.collection).join(", ")}` });
      required.push("Hikâye açılarını yalnızca onaylı koleksiyonlara bağlayın.");
    }
  }

  if (agent === "finance") {
    const unsourced = (content.spend ?? []).filter((x: any) => x.amount_usd !== null && x.amount_usd !== undefined && !String(x.source ?? "").trim());
    if (unsourced.length) {
      checks.push({ name: "Kaynaksız tutar", status: "fail", detail: unsourced.map((x: any) => x.item).join(", ") });
      required.push("Her tutar kayıtlı bir kaynağa dayanmalı; bilinmeyen tutar null olmalı.");
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

/** Bir çıktının başvurduğu medya kimlikleri (kalite kontrol bağlamına sınırdan bağımsız eklenir). */
export function referencedAssetIds(agent: string, content: any): string[] {
  const ids: string[] = [];
  if (agent === "video") for (const v of content?.videos ?? []) { ids.push(...(v.selected_asset_ids ?? []), ...(v.segments ?? []).map((s: any) => s.asset_id), ...(v.parts ?? []).filter((x: any) => x.kind !== "ai_scene").map((x: any) => x.ref)); }
  if (agent === "design") for (const b of content?.briefs ?? []) ids.push(...(b.source_asset_ids ?? []));
  return [...new Set(ids.filter((x) => typeof x === "string"))];
}

/** compose: parçalar bu plandaki AI sahnelerine, markanın ürün fotoğraflarına veya doğrulanmış arşiv sahnelerine dayanmalı. */
function composeChecks(v: any, content: any, mediaById: Map<string, any>, checks: Check[], required: string[]) {
  const parts: any[] = Array.isArray(v.parts) ? v.parts : [];
  const genIds = new Set((content.videos ?? []).filter((x: any) => x.mode === "generate_new").map((x: any) => x.id));
  if (!parts.length) {
    checks.push({ name: "Reklam parçaları", status: "fail", detail: `${v.id}: compose için parça (parts) yok.` });
    required.push("compose videosunda AI sahnelerini, ürün fotoğraflarını ve arşiv sahnelerini parts olarak sırayla listeleyin.");
    return;
  }
  const bad: string[] = [];
  parts.forEach((p, i) => {
    const d = Number(p.duration_s);
    let why: string | null = null;
    if (p.kind === "ai_scene") why = genIds.has(p.ref) ? null : `"${p.ref}" bu planda bir generate_new sahnesi değil`;
    else if (p.kind === "product_photo") {
      const m = mediaById.get(p.ref);
      why = !m || m.kind !== "photo" ? "arşivde olmayan veya fotoğraf olmayan dosya" : !(d >= 1 && d <= 8) ? "süre 1-8 sn olmalı" : null;
    } else if (p.kind === "archive_clip") {
      const m = mediaById.get(p.ref);
      const a = m?.analysis as any;
      const scene = a?.scenes?.find((x: any) => x.index === p.scene_index);
      why = !m || m.kind !== "video" ? "arşivde olmayan video"
        : !scene ? "analizde bu sahne yok (uydurma sahne)"
        : !(p.source_end > p.source_start) || p.source_end - p.source_start < 0.5 ? "geçersiz/0,5 sn'den kısa aralık"
        : p.source_start < scene.start - 0.15 || p.source_end > scene.end + 0.15 ? `sahne sınırları (${scene.start}–${scene.end} sn) dışında`
        : null;
    } else why = "bilinmeyen parça türü";
    if (why) bad.push(`parça ${i + 1}: ${why}`);
  });
  if (bad.length) {
    checks.push({ name: "Reklam parçaları", status: "fail", detail: `${v.id}: ${bad.slice(0, 5).join("; ")}` });
    required.push("compose parçalarını yalnızca bu plandaki AI sahnelerinden, markanın ürün fotoğraflarından ve doğrulanmış arşiv sahnelerinden oluşturun.");
  } else {
    checks.push({ name: "Reklam parçaları", status: "pass", detail: `${v.id}: ${parts.length} parça (${parts.filter((p) => p.kind === "ai_scene").length} AI sahnesi).` });
  }
  if (!String(v.outro_text ?? "").trim()) {
    checks.push({ name: "Marka kapanışı", status: "warn", detail: `${v.id}: outro_text boş; kapanışta marka adı kullanılacak.` });
  }
}

/** Ürün tasarımını/rengini değiştirmeye yönelik istem ifadeleri (marka tasarımları sabittir). */
// ---------------------------------------------------------------- Koleksiyon, baskı ve logo eşleşmesi (FriBee)

const COLLECTION_WORDS: Record<string, RegExp> = {
  space_alien: /\b(space alien|alien|ufo)\b/i,
  music: /\b(music|mandala)\b/i,
  anime: /\banime\b/i,
  save_the_bee: /\b(save the bee|bee|bees|honeybee)\b/i,
};
const COLLECTION_COLOUR: Record<string, RegExp> = {
  space_alien: /\bblack\b/i,
  music: /\bwhite\b/i,
  anime: /\borange\b/i,
  save_the_bee: /\b(light[- ]?blue|sky[- ]?blue|baby[- ]?blue)\b/i,
};
const GARMENT_COLOUR = /\b(black|white|orange|light[- ]?blue|sky[- ]?blue|baby[- ]?blue|navy|red|green|yellow|pink|purple|grey|gray|beige)\s+(t-?shirts?|tees?|shirts?|hoodies?|sweatshirts?|garments?|apparel)\b/gi;
const LOGO_CHANGE = /\b(add(ing)? (a |the )?logo|(new|different|another|modern|minimal|redesigned|bigger|smaller) logo|logo (redesign|swap|replacement)|replace (the )?logo|remove (the )?logo|without (the |a )?logo)\b/i;

/** Medya kimliği → koleksiyon (sahibin doğruladığı Drive referansları; bilgi bağlamından). */
function collectionOfAssets(ctx: BrandContext): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of ctx.knowledge?.collections ?? []) {
    const theme = c.key.replace(/^collection_/, "");
    for (const p of c.verified_prints) if (p.media_asset_id) out.set(p.media_asset_id, theme);
  }
  return out;
}

/**
 * AI sahnesi koleksiyon kontrolü: referanslar tek koleksiyondan olmalı, sahibin seçtiği koleksiyonla eşleşmeli; istem başka
 * koleksiyonu, başka bir ürün rengini veya logo değişikliğini istememeli. Aksi halde üretim kalite kontrolünden geçmez.
 */
function collectionChecks(v: any, photos: string[], ctx: BrandContext, studioCollection: string | null, checks: Check[], required: string[]) {
  const byAsset = collectionOfAssets(ctx);
  const refCollections = [...new Set(photos.map((id) => byAsset.get(id)).filter((x): x is string => !!x))];
  const prompt = String(v.generation_prompt ?? "");
  const problems: string[] = [];
  if (refCollections.length > 1) problems.push(`referanslar farklı koleksiyonlardan (${refCollections.join(", ")})`);
  const target = studioCollection ?? (refCollections.length === 1 ? refCollections[0] : null);
  if (studioCollection && refCollections.some((c) => c !== studioCollection)) problems.push(`seçilen koleksiyon ${studioCollection}, referans ${refCollections.join(", ")}`);
  if (target) {
    const others = Object.keys(COLLECTION_WORDS).filter((k) => k !== target && COLLECTION_WORDS[k].test(prompt));
    if (others.length) problems.push(`istem başka koleksiyondan söz ediyor (${others.join(", ")})`);
    const colours = [...prompt.matchAll(GARMENT_COLOUR)].map((m) => m[1]);
    const wrong = colours.filter((c) => !COLLECTION_COLOUR[target]?.test(c));
    if (wrong.length) problems.push(`istem ürünü yanlış renkte tarif ediyor (${[...new Set(wrong)].join(", ")}); ${target} koleksiyonunun onaylı rengi korunmalı`);
  }
  if (LOGO_CHANGE.test(prompt)) problems.push("istem logoyu ekliyor/değiştiriyor/kaldırıyor");
  if (problems.length) {
    checks.push({ name: "Koleksiyon ve baskı eşleşmesi", status: "fail", detail: `${v.id}: ${problems.join("; ")}.` });
    required.push("AI sahnesinde yalnızca tek koleksiyonun doğrulanmış katalog fotoğraflarını kullanın; istemde başka koleksiyon, başka ürün rengi veya logo değişikliği olmasın.");
  } else if (target) {
    checks.push({ name: "Koleksiyon ve baskı eşleşmesi", status: "pass", detail: `${v.id}: referanslar ve istem ${target} koleksiyonuyla uyumlu.` });
  }
}

const ALTERS_DESIGN = /\b(recolou?r(ed|ing)?|change (the )?(colou?rs?|print|design|logo|artwork|graphic)|different (colou?rs?|colou?rway|print|design|logo)|new (colou?rway|print|design|logo)|redesign(ed)?|restyle(d)?|alternate colou?rway)\b/i;
