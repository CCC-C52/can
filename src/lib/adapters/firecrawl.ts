import { config } from "@/lib/config";
import { PermanentError, TransientError } from "@/lib/models/types";

// Firecrawl v2 (https://api.firecrawl.dev/v2) — web araması ve sayfa okuma. Yalnızca sunucuda çalışır; anahtar
// tarayıcıya gönderilmez. Dönen içerik GÜVENİLMEYEN üçüncü taraf verisidir: kısaltılır, kontrol karakterleri
// temizlenir ve çağıran taraf "doğrulanmamış" olarak saklar.

export const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";
export const MAX_SEARCH_RESULTS = 10;
export const MAX_EXCERPT_CHARS = 4000;

export type ResearchHit = { url: string; title: string | null; excerpt: string | null };
export type ResearchResult = { hits: ResearchHit[]; creditsUsed: number | null };

type Fetch = typeof fetch;

export function firecrawlConfigured() {
  return !!config.firecrawl.apiKey;
}

/** Çağrı öncesi kredi tahmini (üst sınır). Firecrawl fiyatı değişebilir; birim fiyat sahibin tanımladığı değerdir. */
export function estimateCredits(mode: "search" | "scrape", limit = MAX_SEARCH_RESULTS) {
  return mode === "scrape" ? 1 : Math.max(2, Math.ceil(limit / 10) * 2);
}

export function creditsToUsd(credits: number | null): number | null {
  const unit = config.firecrawl.creditUsd;
  return credits === null || unit === null ? null : credits * unit;
}

/** Güvenilmeyen metni temizler: kontrol karakterleri, aşırı boşluk, uzunluk. */
export function sanitizeExternalText(s: unknown, max = MAX_EXCERPT_CHARS): string | null {
  if (typeof s !== "string") return null;
  const clean = s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/<\/?data>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean ? clean.slice(0, max) : null;
}

/** Yalnızca herkese açık http(s) adresleri. Yerel ağ, IP ve kimlik bilgisi içeren adresler reddedilir. */
export function assertPublicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new PermanentError("Geçersiz adres.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new PermanentError("Yalnızca http(s) adresleri okunabilir.");
  if (u.username || u.password) throw new PermanentError("Kimlik bilgisi içeren adresler kabul edilmez.");
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") throw new PermanentError("Yerel ağ adresleri okunamaz.");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) throw new PermanentError("IP adresleri okunamaz; alan adı kullanın.");
  return u.toString();
}

async function call(path: string, body: unknown, opts: { fetchImpl?: Fetch; signal?: AbortSignal; apiKey?: string }): Promise<any> {
  const apiKey = opts.apiKey ?? config.firecrawl.apiKey;
  if (!apiKey) throw new PermanentError("FIRECRAWL_API_KEY tanımlı değil; araştırma devre dışı.");
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${FIRECRAWL_BASE}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(45_000),
      redirect: "error",
    });
  } catch (err) {
    throw new TransientError(`Firecrawl'a ulaşılamadı: ${(err as Error).message}`, err);
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* gövde JSON değil */
  }
  if (res.status === 401 || res.status === 403) throw new PermanentError(`Firecrawl kimlik doğrulama hatası (${res.status}).`);
  if (res.status === 402) throw new PermanentError("Firecrawl kredisi yetersiz (402). Hesap yöneticisi kredi eklemeden araştırma yapılamaz.");
  if (res.status === 429 || res.status >= 500) throw new TransientError(`Firecrawl geçici hata (${res.status}).`);
  if (!res.ok || !json?.success) throw new PermanentError(`Firecrawl isteği reddetti (${res.status}): ${sanitizeExternalText(json?.error, 200) ?? "ayrıntı yok"}`);
  return json;
}

export async function firecrawlSearch(query: string, opts: { limit?: number; fetchImpl?: Fetch; signal?: AbortSignal; apiKey?: string } = {}): Promise<ResearchResult> {
  const q = query.trim().slice(0, 500);
  if (!q) throw new PermanentError("Arama metni boş.");
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, opts.limit ?? 5));
  const json = await call("/search", { query: q, limit, timeout: 30_000 }, opts);
  const web: any[] = Array.isArray(json.data?.web) ? json.data.web : Array.isArray(json.data) ? json.data : [];
  const hits: ResearchHit[] = [];
  for (const r of web.slice(0, limit)) {
    if (typeof r?.url !== "string") continue;
    let url: string;
    try { url = assertPublicUrl(r.url); } catch { continue; }
    hits.push({ url, title: sanitizeExternalText(r.title, 300), excerpt: sanitizeExternalText(r.markdown ?? r.description) });
  }
  return { hits, creditsUsed: Number.isFinite(json.creditsUsed) ? Number(json.creditsUsed) : null };
}

export async function firecrawlScrape(rawUrl: string, opts: { fetchImpl?: Fetch; signal?: AbortSignal; apiKey?: string } = {}): Promise<ResearchResult> {
  const url = assertPublicUrl(rawUrl);
  const json = await call("/scrape", { url, formats: ["markdown"], onlyMainContent: true, timeout: 30_000 }, opts);
  const d = json.data ?? {};
  return {
    hits: [{ url, title: sanitizeExternalText(d.metadata?.title, 300), excerpt: sanitizeExternalText(d.markdown) }],
    creditsUsed: Number.isFinite(json.creditsUsed) ? Number(json.creditsUsed) : null,
  };
}
