import { redact } from "@/lib/security/crypto";
import type { IntegrationId, TestOutcome } from "./registry";

// Sağlayıcı bağlantı testleri — her biri RESMÎ, ücretsiz ve salt okunur bir çağrıdır.
// Hiçbiri üretim, yayın, mesaj veya ücretli işlem tetiklemez. Ağ çağrısı enjekte edilebilir (testlerde sahte sağlayıcı).

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type TestResult = {
  outcome: TestOutcome;
  detail: string;
  /** Saklanacak gizli değerler (şifrelenir). undefined: mevcutlar korunur. */
  storeCredentials?: Record<string, string>;
  account?: Record<string, string | number | null>;
  usage?: Record<string, string | number | null>;
  tokenExpiresAt?: string | null;
  httpStatus?: number;
};

export const ENDPOINTS = {
  brandwatchToken: "https://api.brandwatch.com/oauth/token",
  metricoolProfiles: "https://app.metricool.com/api/admin/simpleProfiles",
  runwayOrganization: "https://api.dev.runwayml.com/v1/organization",
  adobeImsToken: "https://ims-na1.adobelogin.com/ims/token/v3",
} as const;

export const RUNWAY_API_VERSION = "2024-11-06";
const TIMEOUT_MS = 15_000;

export function outcomeFor(status: number): TestOutcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 401) return "auth_error";
  if (status === 403) return "forbidden";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return "error";
}

const STATUS_HINT: Record<TestOutcome, string> = {
  success: "",
  auth_error: "Kimlik bilgileri reddedildi (401). Anahtarı/parolayı kontrol edin.",
  forbidden: "Erişim yok (403): plan, eklenti veya izin bu API'yi kapsamıyor olabilir.",
  transient: "Sağlayıcı geçici olarak yanıt vermedi (hız sınırı veya sunucu hatası). Daha sonra tekrar deneyin.",
  error: "İstek reddedildi.",
};

async function call(f: FetchLike, url: string, init: RequestInit): Promise<{ status: number; body: any } | { networkError: string }> {
  try {
    const res = await f(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
  } catch (err) {
    return { networkError: redact((err as Error).name === "TimeoutError" ? "Zaman aşımı" : (err as Error).message).slice(0, 200) };
  }
}

function failure(r: { status: number; body: any } | { networkError: string }, provider: string): TestResult {
  if ("networkError" in r) return { outcome: "transient", detail: `${provider}: ağ hatası — ${r.networkError}` };
  const outcome = outcomeFor(r.status);
  // Sağlayıcı hata gövdesi gizli değer içermez, yine de kısaltılır ve maskelenir
  const msg = r.body && typeof r.body === "object" ? redact(String(r.body.error_description ?? r.body.error ?? r.body.message ?? "")).slice(0, 160) : "";
  return { outcome, detail: `${provider}: HTTP ${r.status}. ${STATUS_HINT[outcome]}${msg ? ` (${msg})` : ""}`, httpStatus: r.status };
}

/** Brandwatch: API kullanıcısıyla erişim belirteci alır. Parola saklanmaz; yalnızca belirteç döner. */
export async function testBrandwatch(f: FetchLike, input: { username: string; password: string }, now = new Date()): Promise<TestResult> {
  const url = `${ENDPOINTS.brandwatchToken}?${new URLSearchParams({ username: input.username, grant_type: "api-password", client_id: "brandwatch-api-client" })}`;
  const r = await call(f, url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ password: input.password }).toString() });
  if ("networkError" in r || r.status >= 300) return failure(r, "Brandwatch");
  const token = r.body?.access_token;
  if (typeof token !== "string" || token.length < 10) return { outcome: "error", detail: "Brandwatch: belirteç yanıtı beklenen biçimde değil." };
  const expiresIn = Number(r.body?.expires_in);
  return {
    outcome: "success",
    detail: "Brandwatch API kullanıcısı doğrulandı; erişim belirteci alındı.",
    storeCredentials: { accessToken: token },
    tokenExpiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000).toISOString() : null,
    account: { username: input.username },
  };
}

/** Metricool: yönetilen marka profillerini okur ve blogId'nin listede olduğunu doğrular. */
export async function testMetricool(f: FetchLike, input: { userToken: string; userId: string; blogId: string }): Promise<TestResult> {
  const url = `${ENDPOINTS.metricoolProfiles}?${new URLSearchParams({ userId: input.userId })}`;
  const r = await call(f, url, { method: "GET", headers: { "X-Mc-Auth": input.userToken, Accept: "application/json" } });
  if ("networkError" in r || r.status >= 300) return failure(r, "Metricool");
  const list: any[] = Array.isArray(r.body) ? r.body : Array.isArray(r.body?.data) ? r.body.data : [];
  const match = list.find((p) => String(p?.id ?? p?.blogId ?? "") === input.blogId);
  if (!match) return { outcome: "error", detail: `Metricool: kimlik doğrulandı ancak blogId ${input.blogId} bu hesabın marka listesinde yok (${list.length} marka bulundu).` };
  const name = match.label ?? match.title ?? match.name ?? null;
  return { outcome: "success", detail: `Metricool doğrulandı: ${name ?? `blogId ${input.blogId}`} (${list.length} marka).`, account: { blogId: input.blogId, brand: name, profiles: list.length } };
}

/** Runway: organizasyon bilgisi ve kredi bakiyesi (video üretmez, kredi harcamaz). */
export async function testRunway(f: FetchLike, input: { apiKey: string }): Promise<TestResult> {
  const r = await call(f, ENDPOINTS.runwayOrganization, { method: "GET", headers: { Authorization: `Bearer ${input.apiKey}`, "X-Runway-Version": RUNWAY_API_VERSION, Accept: "application/json" } });
  if ("networkError" in r || r.status >= 300) return failure(r, "Runway");
  const credits = Number(r.body?.creditBalance);
  return {
    outcome: "success",
    detail: `Runway doğrulandı${Number.isFinite(credits) ? `: kredi bakiyesi ${credits}` : ""}.`,
    usage: { creditBalance: Number.isFinite(credits) ? credits : null },
    account: { tier: typeof r.body?.tier === "object" ? (r.body.tier?.name ?? null) : (r.body?.tier ?? null) },
  };
}

/** Adobe IMS: OAuth Server-to-Server ile erişim belirteci alır (belirteç saklanmaz; gerektiğinde yeniden alınır). */
export async function testAdobe(f: FetchLike, input: { clientId: string; clientSecret: string; scopes: string }): Promise<TestResult> {
  const r = await call(f, ENDPOINTS.adobeImsToken, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: input.clientId, client_secret: input.clientSecret, scope: input.scopes }).toString(),
  });
  if ("networkError" in r || r.status >= 300) return failure(r, "Adobe IMS");
  if (typeof r.body?.access_token !== "string") return { outcome: "error", detail: "Adobe IMS: belirteç yanıtı beklenen biçimde değil." };
  return { outcome: "success", detail: `Adobe OAuth Server-to-Server kimliği doğrulandı (kapsamlar: ${input.scopes}).`, account: { clientId: `${input.clientId.slice(0, 6)}…` } };
}

export const TESTABLE: IntegrationId[] = ["brandwatch", "metricool", "runway", "adobe", "shopify"];
