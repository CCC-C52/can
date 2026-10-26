// Trend izleme: kaynak kataloğu, besleme ayrıştırma, köken (provenance), tekilleştirme, hız, ilgi ve sağlık.
// Saf modül (çalışma zamanı içe aktarımı yok); ağ çağrısı servis katmanında yapılır.
//
// İlkeler:
//  - Yalnızca yayıncının sunduğu RSS/Atom beslemeleri veya resmî API'ler. Kazıma (scraping) yok.
//  - Katalogdaki kaynaklar varsayılan olarak BAĞLI DEĞİL; sahip etkinleştirmeden hiçbir istek yapılmaz.
//  - Bağlı olmayan kaynak için veri, kapsama veya metrik üretilmez.
//  - Her kayıt: kaynak URL, yayın zamanı (biliniyorsa), çekilme zamanı, bölge ve güven skoru taşır.

export type SourceKind = "rss" | "atom" | "api";
export type SourceCategory = "pr_industry" | "fashion_streetwear" | "culture" | "creators" | "competitors" | "press" | "social_platform";

export type SourceDefinition = {
  id: string;
  name: string;
  kind: SourceKind;
  category: SourceCategory;
  url: string;
  region: "US" | "GLOBAL";
  /** Uyum: yalnızca yayıncının açıkça sunduğu besleme veya kimlik bilgisi gerektiren resmî API. */
  compliance: "publisher_feed" | "official_api";
  /** API kaynakları için gereken ortam değişkeni (yoksa bağlanamaz). */
  credentialEnv?: string;
  /** Kaynağın tipik güvenilirliği (0..1): resmî/basın > sektör yayını > topluluk. */
  baseConfidence: number;
  minIntervalMinutes: number;
  dailyRequestBudget: number;
  /** İstek başına tahmini maliyet (USD); halka açık beslemeler 0. */
  costPerRequestUsd: number;
  notes?: string;
};

/**
 * Aday kaynaklar. URL'ler yayıncıların kendi besleme adresleridir; değişebilir — sahip etkinleştirmeden önce doğrulamalıdır.
 * Hiçbiri varsayılan olarak bağlı değildir.
 */
export const SOURCE_CATALOG: SourceDefinition[] = [
  { id: "prweek-us", name: "PRWeek (US)", kind: "rss", category: "pr_industry", url: "https://www.prweek.com/us/rss", region: "US", compliance: "publisher_feed", baseConfidence: 0.8, minIntervalMinutes: 180, dailyRequestBudget: 8, costPerRequestUsd: 0, notes: "Verify feed URL before enabling." },
  { id: "prdaily", name: "PR Daily", kind: "rss", category: "pr_industry", url: "https://www.prdaily.com/feed/", region: "GLOBAL", compliance: "publisher_feed", baseConfidence: 0.7, minIntervalMinutes: 180, dailyRequestBudget: 8, costPerRequestUsd: 0 },
  { id: "hypebeast", name: "Hypebeast", kind: "rss", category: "fashion_streetwear", url: "https://hypebeast.com/feed", region: "GLOBAL", compliance: "publisher_feed", baseConfidence: 0.7, minIntervalMinutes: 120, dailyRequestBudget: 12, costPerRequestUsd: 0 },
  { id: "highsnobiety", name: "Highsnobiety", kind: "rss", category: "fashion_streetwear", url: "https://www.highsnobiety.com/feed/", region: "GLOBAL", compliance: "publisher_feed", baseConfidence: 0.7, minIntervalMinutes: 120, dailyRequestBudget: 12, costPerRequestUsd: 0 },
  { id: "complex-style", name: "Complex Style", kind: "rss", category: "culture", url: "https://www.complex.com/style/rss", region: "US", compliance: "publisher_feed", baseConfidence: 0.65, minIntervalMinutes: 120, dailyRequestBudget: 12, costPerRequestUsd: 0, notes: "Verify feed URL before enabling." },
  { id: "businessoffashion", name: "The Business of Fashion", kind: "rss", category: "press", url: "https://www.businessoffashion.com/arc/outboundfeeds/rss/", region: "GLOBAL", compliance: "publisher_feed", baseConfidence: 0.85, minIntervalMinutes: 180, dailyRequestBudget: 8, costPerRequestUsd: 0, notes: "Verify feed URL before enabling." },
  { id: "youtube-data-api", name: "YouTube Data API (creator/video trends)", kind: "api", category: "creators", url: "https://www.googleapis.com/youtube/v3/", region: "US", compliance: "official_api", credentialEnv: "YOUTUBE_API_KEY", baseConfidence: 0.8, minIntervalMinutes: 360, dailyRequestBudget: 20, costPerRequestUsd: 0, notes: "Quota-based (10k units/day default). Adapter not implemented in this slice." },
  { id: "instagram-graph", name: "Instagram Graph API (own account insights, hashtag search)", kind: "api", category: "social_platform", url: "https://graph.facebook.com/", region: "GLOBAL", compliance: "official_api", credentialEnv: "INSTAGRAM_APP_ID", baseConfidence: 0.85, minIntervalMinutes: 360, dailyRequestBudget: 20, costPerRequestUsd: 0, notes: "Uses existing Instagram connection; hashtag search requires app review. Adapter not implemented in this slice." },
  { id: "tiktok-research", name: "TikTok Research API", kind: "api", category: "social_platform", url: "https://open.tiktokapis.com/v2/research/", region: "US", compliance: "official_api", credentialEnv: "TIKTOK_RESEARCH_CLIENT_KEY", baseConfidence: 0.8, minIntervalMinutes: 720, dailyRequestBudget: 10, costPerRequestUsd: 0, notes: "Access limited to approved researchers; commercial use restricted. Not implemented." },
];

export type FeedState = {
  sourceId: string;
  enabled: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  requestsToday: number;
  /** requestsToday hangi UTC gününe ait. */
  requestsDay: string | null;
};

export type FeedHealth = {
  sourceId: string;
  name: string;
  status: "unconnected" | "missing_credentials" | "never_fetched" | "healthy" | "stale" | "failing";
  connected: boolean;
  freshnessHours: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  budget: { used: number; limit: number; costPerRequestUsd: number };
};

const HOUR = 3_600_000;

/** Kaynak sağlığı. Eşik: son başarılı çekimden bu yana 3 × minIntervalMinutes (en az 24 saat) geçtiyse "stale". */
export function feedHealth(def: SourceDefinition, state: FeedState | undefined, now: Date, env: Record<string, string | undefined> = {}): FeedHealth {
  const used = state && state.requestsDay === now.toISOString().slice(0, 10) ? state.requestsToday : 0;
  const base = { sourceId: def.id, name: def.name, lastSuccessAt: state?.lastSuccessAt ?? null, lastError: state?.lastError ?? null, budget: { used, limit: def.dailyRequestBudget, costPerRequestUsd: def.costPerRequestUsd } };
  if (!state?.enabled) return { ...base, status: "unconnected", connected: false, freshnessHours: null };
  if (def.credentialEnv && !env[def.credentialEnv]) return { ...base, status: "missing_credentials", connected: false, freshnessHours: null };
  if (!state.lastSuccessAt) return { ...base, status: state.consecutiveFailures > 0 ? "failing" : "never_fetched", connected: true, freshnessHours: null };
  const freshness = (now.getTime() - new Date(state.lastSuccessAt).getTime()) / HOUR;
  const staleAfter = Math.max(24, (3 * def.minIntervalMinutes) / 60);
  const status = state.consecutiveFailures >= 3 ? "failing" : freshness > staleAfter ? "stale" : "healthy";
  return { ...base, status, connected: true, freshnessHours: Math.round(freshness * 10) / 10 };
}

/** Kota/aralık kapısı: çekim yapılabilir mi? (null = evet, aksi halde neden) */
export function fetchBlockedReason(def: SourceDefinition, state: FeedState | undefined, now: Date, env: Record<string, string | undefined> = {}): string | null {
  if (!state?.enabled) return "Source not connected (owner has not enabled it).";
  if (def.kind === "api") {
    if (def.credentialEnv && !env[def.credentialEnv]) return `Missing credential ${def.credentialEnv}.`;
    return "API adapter not implemented in this version.";
  }
  if (state.lastAttemptAt && now.getTime() - new Date(state.lastAttemptAt).getTime() < def.minIntervalMinutes * 60_000) return "Minimum polling interval not reached.";
  const today = now.toISOString().slice(0, 10);
  if (state.requestsDay === today && state.requestsToday >= def.dailyRequestBudget) return "Daily request budget exhausted.";
  return null;
}

// ------------------------------------------------------------------ besleme ayrıştırma

export type RawFeedItem = { title: string; link: string; publishedAt: string | null; summary: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Dış metni düz metne indirger: CDATA, HTML etiketleri, kontrol/yön karakterleri kaldırılır; uzunluk sınırlanır. */
export function cleanText(s: string, max = 1000): string {
  const noCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const noTags = decodeEntities(noCdata.replace(/<[^>]*>/g, " ")).replace(/<[^>]*>/g, " ");
  return noTags.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? m[1] : null;
}

function toIso(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(cleanText(s, 100));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** RSS 2.0 ve Atom beslemelerini ayrıştırır. Yalnızca http(s) bağlantılar kabul edilir; en fazla `limit` kayıt. */
export function parseFeed(xml: string, limit = 50): RawFeedItem[] {
  const out: RawFeedItem[] = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks.slice(0, limit)) {
    let link = "";
    if (isAtom) {
      const alt = /<link\b[^>]*rel=["']alternate["'][^>]*>/i.exec(b)?.[0] ?? /<link\b[^>]*>/i.exec(b)?.[0] ?? "";
      link = /href=["']([^"']+)["']/i.exec(alt)?.[1] ?? "";
    } else {
      link = cleanText(tag(b, "link") ?? tag(b, "guid") ?? "", 2000);
    }
    link = decodeEntities(link.trim());
    if (!/^https?:\/\//i.test(link)) continue;
    const title = cleanText(tag(b, "title") ?? "", 300);
    if (!title) continue;
    out.push({
      title,
      link,
      publishedAt: toIso(isAtom ? tag(b, "published") ?? tag(b, "updated") : tag(b, "pubDate") ?? tag(b, "dc:date")),
      summary: cleanText(tag(b, isAtom ? "summary" : "description") ?? tag(b, "content") ?? "", 600),
    });
  }
  return out;
}

/** Karşılaştırma için kanonik URL: şema/host küçük harf, izleme parametreleri (utm_*, fbclid, gclid) ve parça atılır. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

// ------------------------------------------------------------------ köken ve güven

export type TrendItem = {
  sourceId: string;
  url: string;
  canonicalUrl: string;
  title: string;
  summary: string;
  publishedAt: string | null;
  fetchedAt: string;
  region: "US" | "GLOBAL";
  category: SourceCategory;
  confidence: number;
};

/** Ham kaydı köken bilgisiyle zenginleştirir. Yayın zamanı yoksa veya 7 günden eskiyse güven düşer. */
export function toTrendItem(raw: RawFeedItem, def: SourceDefinition, fetchedAt: Date): TrendItem {
  let confidence = def.baseConfidence;
  if (!raw.publishedAt) confidence -= 0.15;
  else if (fetchedAt.getTime() - new Date(raw.publishedAt).getTime() > 7 * 24 * HOUR) confidence -= 0.1;
  if (raw.publishedAt && new Date(raw.publishedAt).getTime() > fetchedAt.getTime() + HOUR) confidence -= 0.2; // gelecekte tarih: şüpheli
  return {
    sourceId: def.id, url: raw.link, canonicalUrl: canonicalUrl(raw.link), title: raw.title, summary: raw.summary,
    publishedAt: raw.publishedAt, fetchedAt: fetchedAt.toISOString(), region: def.region, category: def.category,
    confidence: Math.max(0.05, Math.round(confidence * 100) / 100),
  };
}

// ------------------------------------------------------------------ tekilleştirme (kümeleme)

const STOP = new Set("a an the and or of to in on for with at by from is are was were be as it its this that these those new how why what who you your our we us vs into about after over more most just than".split(" "));

export function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export type TrendCluster = {
  key: string;
  label: string;
  items: TrendItem[];
  sources: string[];
  firstSeen: string;
  lastSeen: string;
};

/** Aynı kanonik URL veya başlık benzerliği (Jaccard ≥ eşik) olan kayıtlar tek kümede toplanır. Sıra bağımsız ve deterministik. */
export function clusterItems(items: TrendItem[], threshold = 0.5): TrendCluster[] {
  const sorted = [...items].sort((a, b) => itemTime(a).localeCompare(itemTime(b)) || a.canonicalUrl.localeCompare(b.canonicalUrl));
  const clusters: { tok: Set<string>; urls: Set<string>; items: TrendItem[] }[] = [];
  for (const it of sorted) {
    const tok = tokens(it.title);
    let target = clusters.find((c) => c.urls.has(it.canonicalUrl)) ?? clusters.find((c) => jaccard(c.tok, tok) >= threshold);
    if (!target) {
      target = { tok: new Set(tok), urls: new Set(), items: [] };
      clusters.push(target);
    }
    if (target.items.some((x) => x.canonicalUrl === it.canonicalUrl && x.sourceId === it.sourceId)) continue; // birebir tekrar
    target.urls.add(it.canonicalUrl);
    target.items.push(it);
  }
  return clusters.map((c) => {
    const times = c.items.map(itemTime).sort();
    const label = c.items[0].title;
    return {
      key: [...tokens(label)].sort().slice(0, 8).join("-") || c.items[0].canonicalUrl,
      label,
      items: c.items,
      sources: [...new Set(c.items.map((i) => i.sourceId))].sort(),
      firstSeen: times[0],
      lastSeen: times[times.length - 1],
    };
  });
}

function itemTime(i: TrendItem) {
  return i.publishedAt ?? i.fetchedAt;
}

// ------------------------------------------------------------------ hız ve ilgi

export type Velocity = { label: "new" | "rising" | "steady" | "cooling"; last24h: number; prior7dDailyAvg: number };

/** Son 24 saatteki kayıt sayısı ile önceki 7 günün günlük ortalaması karşılaştırılır. */
export function velocity(cluster: TrendCluster, now: Date): Velocity {
  const t = now.getTime();
  let last24 = 0, prior = 0;
  for (const i of cluster.items) {
    const age = t - new Date(itemTime(i)).getTime();
    if (age < 0) continue;
    if (age <= 24 * HOUR) last24++;
    else if (age <= 8 * 24 * HOUR) prior++;
  }
  const avg = Math.round((prior / 7) * 100) / 100;
  const label = prior === 0 ? (last24 > 0 ? "new" : "cooling") : last24 >= 2 * avg && last24 >= 2 ? "rising" : last24 < avg / 2 ? "cooling" : "steady";
  return { label, last24h: last24, prior7dDailyAvg: avg };
}

export type Relevance = { score: number; matchedCollections: string[]; matchedTopics: string[] };

/** Marka koleksiyon anahtar kelimeleri ve odak konularıyla örtüşme. */
export function relevance(cluster: TrendCluster, collections: { name: string; keywords: string[] }[], focusTopics: string[]): Relevance {
  const text = tokens(cluster.items.map((i) => `${i.title} ${i.summary}`).join(" "));
  const has = (k: string) => [...tokens(k)].every((w) => text.has(w));
  const matchedCollections = collections.filter((c) => c.keywords.some(has)).map((c) => c.name);
  const matchedTopics = focusTopics.filter(has);
  const score = Math.min(1, matchedCollections.length * 0.35 + matchedTopics.length * 0.15);
  return { score: Math.round(score * 100) / 100, matchedCollections, matchedTopics };
}

export const DEFAULT_FOCUS_TOPICS = ["streetwear", "sneakers", "graphic tee", "hoodie", "drop", "collab", "sustainability", "bee", "pollinator", "anime", "gen z", "creator", "tiktok", "influencer"];

const CRISIS_TERMS = ["boycott", "recall", "lawsuit", "backlash", "counterfeit", "data breach", "controversy", "scandal", "cancel"];

export type ScoredCluster = TrendCluster & {
  velocity: Velocity;
  relevance: Relevance;
  confidence: number;
  flags: ("crisis_watch" | "major_opportunity")[];
  opportunity: string | null;
};

/**
 * Kümeyi puanlar. Bayraklar KOŞULLUDUR:
 *  - crisis_watch: marka adı geçen ve kriz terimi içeren küme
 *  - major_opportunity: yükselen/yeni, ilgi ≥ 0.5, en az 2 bağımsız kaynak ve güven ≥ 0.6
 */
export function scoreCluster(cluster: TrendCluster, ctx: { now: Date; brandName: string; collections: { name: string; keywords: string[] }[]; focusTopics?: string[] }): ScoredCluster {
  const v = velocity(cluster, ctx.now);
  const r = relevance(cluster, ctx.collections, ctx.focusTopics ?? DEFAULT_FOCUS_TOPICS);
  const confidence = Math.round((cluster.items.reduce((s, i) => s + i.confidence, 0) / cluster.items.length + Math.min(0.15, (cluster.sources.length - 1) * 0.05)) * 100) / 100;
  const text = cluster.items.map((i) => `${i.title} ${i.summary}`).join(" ").toLowerCase();
  const flags: ScoredCluster["flags"] = [];
  if (ctx.brandName && text.includes(ctx.brandName.toLowerCase()) && CRISIS_TERMS.some((t) => text.includes(t))) flags.push("crisis_watch");
  if ((v.label === "rising" || v.label === "new") && r.score >= 0.5 && cluster.sources.length >= 2 && confidence >= 0.6) flags.push("major_opportunity");
  const opportunity = r.score >= 0.3
    ? `Consider ${r.matchedCollections.length ? r.matchedCollections.join(", ") : "relevant products"} content responding to "${cluster.label}" (${v.label}).`
    : null;
  return { ...cluster, velocity: v, relevance: r, confidence: Math.min(1, confidence), flags, opportunity };
}
