// FriBee PR Ajansı — saf alan kuralları (veritabanı ve ağ erişimi yok; birim testleriyle doğrulanır).
// İlkeler:
//  - Kaynaksız sayı yok: erişim, etkileşim, duygu, takipçi gibi metrikler yalnızca kaynağı ve zamanı olan veriden gösterilir.
//  - Kanıtsız trend yok: doğrulanmış kaynak yoksa ilgi puanı hesaplanmaz (null), "spekülasyon" olarak etiketlenir.
//  - Taslak dışı işlem yok: e-posta/DM gönderme, yayın, Shopify değişikliği, reklam harcaması, dağıtım bu modülde yürütülemez.

export const PR_AGENCY_PATH = "/pr-ajansi";

// ---------------------------------------------------------------- Kaynaklar (bağlayıcılar)

export type ConnectorId = "research_firecrawl" | "rss_feeds" | "news_monitoring" | "social_listening" | "influencer_discovery" | "shopify_catalog";
export type Availability = "available" | "blocked" | "needs_credentials" | "not_built";

export type ConnectorInfo = {
  id: ConnectorId;
  name: string;
  /** Bağlandığında gerçekçi sıklık. "Gerçek zamanlı" iddiası yok. */
  cadence: string;
  /** Kaynak kuralı: hangi yolla, hangi izinle veri alınır. */
  policy: string;
};

export const CONNECTORS: ConnectorInfo[] = [
  { id: "research_firecrawl", name: "Araştırma Merkezi (Firecrawl)", cadence: "Yalnızca sahip başlattığında (elle). Zamanlanmış çalıştırma yok.", policy: "Mevcut entegrasyon; ücretli, bütçe ve aylık kredi sınırına bağlı. Sonuçlar sahip doğrulayana kadar kanıt sayılmaz." },
  { id: "rss_feeds", name: "RSS / herkese açık beslemeler", cadence: "Planlanan: günde en fazla 1–4 kez, kaynak başına.", policy: "Bu sürümde yok. Yalnızca yayıncının sunduğu RSS/Atom beslemeleri; robots ve kullanım koşullarına uyulur, kazıma yapılmaz." },
  { id: "news_monitoring", name: "Haber / basın takibi", cadence: "Bağlı değil.", policy: "Bu sürümde yok. Lisanslı bir haber API'si ve sahip onayı gerekir." },
  { id: "social_listening", name: "Sosyal dinleme", cadence: "Bağlı değil.", policy: "Bu sürümde yok. Mevcut Instagram entegrasyonu yalnızca onaylı yayın içindir; içgörü/bahsetme verisi okumaz. Platform kurallarına aykırı kazıma yapılmaz." },
  { id: "influencer_discovery", name: "Influencer keşfi", cadence: "Bağlı değil.", policy: "Bu sürümde yok. İzinli bir API (ör. Instagram Graph business discovery) gerekir. İletişim bilgisi asla uydurulmaz." },
  { id: "shopify_catalog", name: "Shopify ürün kataloğu (yalnızca okuma)", cadence: "Mevcut ürün senkronu ile.", policy: "Lansman planlarında ürün bağlamı için okunur. PR ajansı mağazaya yazmaz." },
];

// ---------------------------------------------------------------- Çalışma alanları

export type WorkstreamId = "trend" | "media" | "influencer" | "reputation" | "campaign" | "analytics";

export type WorkstreamInfo = {
  id: WorkstreamId;
  name: string;
  summary: string;
  /** Bu çalışma alanının veri için dayandığı bağlayıcılar. */
  connectors: ConnectorId[];
  /** Mevcut stüdyo modülleriyle bağlantı (ör. AI Yönetici, Kampanya Yönetimi). */
  internal: { href: string; label: string }[];
  /** Planlanan, taslak düzeyindeki çıktılar. */
  drafts: string[];
};

export const WORKSTREAMS: WorkstreamInfo[] = [
  { id: "trend", name: "Trend Intelligence", summary: "Koleksiyonlarla ilgili trend sinyalleri; kanıt ve spekülasyon ayrı tutulur.", connectors: ["research_firecrawl", "rss_feeds"], internal: [{ href: "/arastirma", label: "Araştırma Merkezi" }], drafts: ["Kaynaklı günlük/haftalık brif", "Fırsat kuyruğu"] },
  { id: "media", name: "Media Relations", summary: "Basın görünürlüğü takibi ve medya pitch taslakları.", connectors: ["news_monitoring", "rss_feeds"], internal: [{ href: "/sohbet", label: "AI Yönetici" }], drafts: ["Medya pitch taslağı", "Basın bülteni taslağı"] },
  { id: "influencer", name: "Influencer Relations", summary: "İzinli kaynaklardan aday kısa listeleri; iletişim verisi uydurulmaz.", connectors: ["influencer_discovery", "social_listening"], internal: [], drafts: ["Influencer kısa listesi (kaynaklı)"] },
  { id: "reputation", name: "Reputation / Crisis", summary: "Bahsetme takibi ve risk işaretleri.", connectors: ["social_listening", "news_monitoring"], internal: [{ href: "/onaylar", label: "Onay Merkezi" }], drafts: ["Risk işareti", "Yanıt taslağı"] },
  { id: "campaign", name: "Campaign Strategy", summary: "Mevcut AI Yönetici ve kampanya projeleriyle lansman planları.", connectors: ["research_firecrawl", "shopify_catalog"], internal: [{ href: "/projeler", label: "Kampanya Yönetimi" }, { href: "/sohbet", label: "AI Yönetici" }], drafts: ["Lansman planı", "Kampanya brifi"] },
  { id: "analytics", name: "PR Analytics", summary: "Yalnızca kaynağı olan ölçümler; veri yoksa 'Veri yok'.", connectors: ["news_monitoring", "social_listening"], internal: [{ href: "/raporlar", label: "Analitik" }], drafts: ["Kaynaklı dönem raporu"] },
];

/** Bir çalışma alanının durumu: tüm bağlayıcılar kullanılabiliyorsa "hazır", bir kısmı ise "kısmi", hiçbiri yoksa "veri kaynağı yok". */
export function workstreamAvailability(ws: WorkstreamInfo, connectors: Record<ConnectorId, Availability>) {
  const available = ws.connectors.filter((c) => connectors[c] === "available");
  const gaps = ws.connectors.filter((c) => connectors[c] !== "available");
  const level: "ready" | "partial" | "no_source" = gaps.length === 0 ? "ready" : available.length > 0 ? "partial" : "no_source";
  return { level, available, gaps };
}

// ---------------------------------------------------------------- Marka bağlamı

export type Collection = { id: string; name: string; color: string; terms: string[] };

/** FriBee'nin dört koleksiyonu. Kaynak: sahibin issue #9'daki beyanı (marka kaydında henüz yapılandırılmış alan yok). */
export const FRIBEE_COLLECTIONS: Collection[] = [
  { id: "space_alien", name: "Space Alien", color: "siyah", terms: ["space", "alien", "ufo", "cosmic", "sci-fi", "uzay", "uzaylı"] },
  { id: "music", name: "Music", color: "beyaz", terms: ["music", "concert", "festival", "band", "vinyl", "müzik", "konser"] },
  { id: "anime", name: "Anime", color: "turuncu", terms: ["anime", "manga", "cosplay", "otaku"] },
  { id: "save_the_bee", name: "Save the Bee", color: "açık mavi", terms: ["bee", "bees", "pollinator", "beekeeping", "biodiversity", "arı", "arılar"] },
];
export const FRIBEE_COLLECTIONS_SOURCE = "Sahip beyanı (issue #9). Marka kaydında doğrulanmış koleksiyon alanı yok.";

/** Koleksiyonlar yalnızca FriBee markasına uygulanır (marka kapsamı); diğer markalar boş liste alır. */
export function collectionsFor(brand: { name: string; slug: string }): Collection[] {
  const norm = (s: string) => s.toLocaleLowerCase("en").replace(/[^a-z0-9]/g, "");
  return norm(brand.slug).startsWith("fribee") || norm(brand.name).startsWith("fribee") ? FRIBEE_COLLECTIONS : [];
}

// ---------------------------------------------------------------- Kanıt, tazelik, tekilleştirme

export type Verification = "unverified" | "verified" | "rejected";
export type Evidence = {
  id: string;
  url: string;
  title: string | null;
  excerpt: string | null;
  /** Sistemin kaynağı aldığı zaman (yayın tarihi değil). */
  retrievedAt: string;
  connector: ConnectorId;
  verification: Verification;
};

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|igshid|ref|ref_src)$/i;

/** Tekilleştirme anahtarı: küçük harf alan adı, "www." yok, izleme parametreleri ve parça (#) yok, sondaki "/" yok. */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let s = `${u.protocol === "http:" ? "https:" : u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  const qs = u.searchParams.toString();
  if (qs) s += `?${qs}`;
  return s;
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

const VERIFICATION_RANK: Record<Verification, number> = { verified: 2, unverified: 1, rejected: 0 };

/** Aynı adresi tek kayda indirir; doğrulanmış olan, sonra en yeni alınan tercih edilir. Sıra korunur. */
export function dedupeEvidence<T extends Pick<Evidence, "url" | "verification" | "retrievedAt">>(items: T[]): { items: T[]; duplicates: number } {
  const best = new Map<string, T>();
  for (const it of items) {
    const k = normalizeUrl(it.url);
    const cur = best.get(k);
    if (!cur || VERIFICATION_RANK[it.verification] > VERIFICATION_RANK[cur.verification] || (VERIFICATION_RANK[it.verification] === VERIFICATION_RANK[cur.verification] && it.retrievedAt > cur.retrievedAt)) best.set(k, it);
  }
  const kept = new Set(best.values());
  const out = items.filter((it) => kept.has(it));
  return { items: out, duplicates: items.length - out.length };
}

export type Freshness = "fresh" | "stale" | "never" | "failed";
export const STALE_AFTER_HOURS = 24 * 7; // haftalık brif sıklığı: bir haftadan eski kanıt "eski"

/** Tazelik: son doğrulanmış alım zamanı ve son çalıştırmanın durumu. Başarısız son çalıştırma her zaman görünür (eski veri "taze" gösterilmez). */
export function classifyFreshness(lastRetrievedAt: string | Date | null, opts: { now?: Date; staleAfterHours?: number; lastRunStatus?: string | null } = {}): Freshness {
  if (opts.lastRunStatus === "failed") return "failed";
  if (!lastRetrievedAt) return "never";
  const now = opts.now ?? new Date();
  const ageH = (now.getTime() - new Date(lastRetrievedAt).getTime()) / 3_600_000;
  return ageH > (opts.staleAfterHours ?? STALE_AFTER_HOURS) ? "stale" : "fresh";
}

// ---------------------------------------------------------------- Sinyal / spekülasyon ve ilgi puanı

export type SignalClass = "signal" | "weak_signal" | "speculation";

/** Sinyal: en az iki farklı alan adından doğrulanmış kanıt. Zayıf sinyal: tek doğrulanmış kaynak. Aksi hâlde spekülasyon. */
export function classifySignal(evidence: Pick<Evidence, "url" | "verification">[]): { class: SignalClass; verifiedHosts: string[] } {
  const hosts = [...new Set(evidence.filter((e) => e.verification === "verified").map((e) => hostOf(e.url)).filter((h): h is string => !!h))];
  return { class: hosts.length >= 2 ? "signal" : hosts.length === 1 ? "weak_signal" : "speculation", verifiedHosts: hosts };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Tam kelime eşleşmesi (Türkçe harfler dahil; "bee" "beef" içinde eşleşmez). */
function wordMatch(text: string, term: string) {
  return new RegExp(`(^|[^\\p{L}])${escapeRe(term)}([^\\p{L}]|$)`, "u").test(text);
}

/**
 * Kanıta dayalı ilgi puanı (0–100). Doğrulanmış kanıt yoksa null — sayı uydurulmaz.
 * Puan = koleksiyon terim eşleşmesi (en fazla 60) + bağımsız kaynak teyidi (en fazla 40). Gerekçeler açıkça döner.
 */
export function scoreRelevance(evidence: Evidence[], collections: Collection[]): { score: number | null; signal: SignalClass; matched: { collection: string; term: string; evidenceId: string }[]; basis: string[] } {
  const verified = evidence.filter((e) => e.verification === "verified");
  const { class: signal, verifiedHosts } = classifySignal(verified);
  if (verified.length === 0) return { score: null, signal, matched: [], basis: ["Doğrulanmış kanıt yok; puan hesaplanmadı."] };
  const matched: { collection: string; term: string; evidenceId: string }[] = [];
  for (const e of verified) {
    const text = `${e.title ?? ""} ${e.excerpt ?? ""}`.toLocaleLowerCase("en");
    for (const c of collections) {
      const term = c.terms.find((t) => wordMatch(text, t));
      if (term) matched.push({ collection: c.name, term, evidenceId: e.id });
    }
  }
  const collectionsHit = new Set(matched.map((m) => m.collection)).size;
  const termScore = collections.length ? Math.min(60, Math.round((Math.min(matched.length, 6) / 6) * 60)) : 0;
  const corroboration = Math.min(40, verifiedHosts.length * 20);
  return {
    score: termScore + corroboration,
    signal,
    matched,
    basis: [
      `${verified.length} doğrulanmış kaynak, ${verifiedHosts.length} farklı alan adı (+${corroboration}).`,
      collections.length ? `${matched.length} koleksiyon terimi eşleşmesi, ${collectionsHit} koleksiyon (+${termScore}).` : "Marka için koleksiyon tanımı yok; terim eşleşmesi yapılmadı.",
    ],
  };
}

// ---------------------------------------------------------------- Kaynaksız metrik koruması

/** Kaynağı olmadan gösterilmesi yasak metrik adları. */
export const ATTRIBUTION_REQUIRED = /^(reach|impressions|engagement|engagement_rate|sentiment|followers|follower_count|views|audience|share_of_voice|ave|mentions_count|email|phone|contact)$/i;

export type MetricSource = { connector: ConnectorId; url?: string | null; observedAt: string };
export type AttributedMetric = { value: number; source: MetricSource };

export class PhantomMetricError extends Error {}

export function attributedMetric(value: number, source: MetricSource | null | undefined): AttributedMetric {
  if (!source || !source.connector || !source.observedAt || Number.isNaN(Date.parse(source.observedAt))) throw new PhantomMetricError("Metrik kaynak ve zaman olmadan kaydedilemez.");
  if (!Number.isFinite(value)) throw new PhantomMetricError("Metrik değeri sayı olmalı.");
  return { value, source };
}

/** Bir veri yapısını gezerek kaynaksız erişim/etkileşim/duygu/iletişim alanlarını bulur (boş liste = temiz). */
export function findUnattributedMetrics(value: unknown, path = "$"): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findUnattributedMetrics(v, `${path}[${i}]`));
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ATTRIBUTION_REQUIRED.test(k) && v !== null && v !== undefined) {
      const ok = typeof v === "object" && !Array.isArray(v) && "source" in (v as object) && !!(v as { source?: MetricSource }).source?.observedAt;
      if (!ok) out.push(`${path}.${k}`);
      continue;
    }
    out.push(...findUnattributedMetrics(v, `${path}.${k}`));
  }
  return out;
}

// ---------------------------------------------------------------- Taslak dışı işlemler (onay kapısı)

export const PR_EXTERNAL_ACTIONS = ["send_email", "send_dm", "publish", "shopify_update", "ad_spend", "deploy"] as const;
export type PrExternalAction = (typeof PR_EXTERNAL_ACTIONS)[number];

/**
 * PR ajansı dış işlem yürütmez. Sahip onayı olsa bile bu sürümde yürütücü yoktur; her dış işlem ayrı onay ve
 * ayrı, denetlenmiş bir yürütücü gerektirir (mevcut Onay Merkezi / external_actions akışı). Bu fonksiyon her zaman reddeder.
 */
export function prActionAllowed(action: string, approval?: { approvalId: string; scopes: string[] } | null): { allowed: false; reason: string } {
  if (!(PR_EXTERNAL_ACTIONS as readonly string[]).includes(action)) return { allowed: false, reason: `Bilinmeyen işlem: ${action}.` };
  if (!approval) return { allowed: false, reason: "Taslak modu: dış işlem için sahibin ayrı onayı gerekir." };
  return { allowed: false, reason: "Onay kaydedildi ancak PR ajansında dış işlem yürütücüsü yok; işlem Onay Merkezi üzerinden ayrıca yürütülmelidir." };
}
