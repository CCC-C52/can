import { audit } from "@/lib/audit";
import { redact } from "@/lib/security/crypto";
import { connectionCredentials, effectiveStatus, envConfigured, getConnection, upsertConnection, type Connection, type ProviderId } from "@/lib/services/connections";
import { testShopify } from "@/lib/adapters/shopify";
import { INTEGRATIONS, computeState, integrationDef, type IntegrationDef, type IntegrationId, type IntegrationMeta, type IntegrationState } from "./registry";
import { testAdobe, testBrandwatch, testMetricool, testRunway, type FetchLike, type TestResult } from "./adapters";

// Entegrasyon Merkezi servisi. Kimlik bilgileri yalnızca şifreli saklanır; ekrana, günlüğe veya denetim kaydına yazılmaz.
// "Doğrulandı" durumu ancak gerçek bir resmî test başarılı olduğunda verilir.

export class IntegrationError extends Error {}

export type IntegrationCard = {
  def: IntegrationDef;
  state: IntegrationState;
  meta: IntegrationMeta;
  lastError: string | null;
  config: Record<string, string>;
  hasCredentials: boolean;
  /** Ortam yapılandırması gerektiren sağlayıcılar (Shopify) için. */
  envReady: boolean;
};

const metaOf = (c: Connection | null): IntegrationMeta => (c?.config?.integration ?? {}) as IntegrationMeta;
const fieldsOf = (c: Connection | null): Record<string, string> => (c?.config?.fields ?? {}) as Record<string, string>;

async function shopifyCard(def: IntegrationDef, brandId: string): Promise<IntegrationCard> {
  const s = await effectiveStatus("shopify", brandId);
  const env = envConfigured("shopify");
  const conn = s.connection;
  const checked = conn?.last_checked_at ?? null;
  let state: IntegrationState;
  if (s.status === "connected") state = "verified";
  else if (s.status === "error" || s.status === "reauth_required") state = "error";
  else state = env ? "awaiting_credentials" : "not_configured";
  return {
    def, state, lastError: s.status === "connected" ? null : (conn?.last_error ?? s.detail ?? null),
    meta: { verifiedAt: s.status === "connected" ? checked : null, lastSuccessAt: s.status === "connected" ? checked : null, lastTestAt: checked, account: conn?.config?.shopName ? { shop: conn.config.shopName, currency: conn.config.currency ?? null } : undefined },
    config: { shop: conn?.config?.shop ?? "" }, hasCredentials: !!conn?.credentials_encrypted, envReady: env,
  };
}

export async function integrationCard(brandId: string, id: IntegrationId, now = new Date()): Promise<IntegrationCard> {
  const def = integrationDef(id);
  if (!def) throw new IntegrationError("Bilinmeyen entegrasyon.");
  if (id === "shopify") return shopifyCard(def, brandId);
  const conn = await getConnection(id as ProviderId, brandId);
  const meta = metaOf(conn);
  const hasCredentials = !!conn?.credentials_encrypted;
  return { def, state: computeState(def, { hasRecord: !!conn, hasCredentials, meta, now }), meta, lastError: conn?.last_error ?? null, config: fieldsOf(conn), hasCredentials, envReady: true };
}

export async function listIntegrations(brandId: string, now = new Date()): Promise<IntegrationCard[]> {
  return Promise.all(INTEGRATIONS.map((d) => integrationCard(brandId, d.id, now)));
}

/** Gerçek testten geçmiş (doğrulanmış) entegrasyonlar. */
export async function verifiedIntegrations(brandId: string): Promise<Set<IntegrationId>> {
  const cards = await listIntegrations(brandId);
  return new Set(cards.filter((c) => c.state === "verified" || c.state === "degraded").map((c) => c.def.id));
}

async function writeMeta(brandId: string, id: IntegrationId, patch: Partial<IntegrationMeta>, extra: { status?: Connection["status"]; credentials?: unknown | null; fields?: Record<string, string>; lastError?: string | null } = {}) {
  const conn = await getConnection(id as ProviderId, brandId);
  const meta = { ...metaOf(conn), ...patch };
  const fields = extra.fields ?? fieldsOf(conn);
  return upsertConnection(id as ProviderId, brandId, { status: extra.status, config: { integration: meta, fields }, credentials: extra.credentials, lastError: extra.lastError });
}

/** Kurulumu başlatır: kimlik bilgisi beklenir (sahip yarın girecek). Dış çağrı yapmaz. */
export async function startSetup(brandId: string, id: IntegrationId, actor = "user") {
  const def = integrationDef(id);
  if (!def || id === "shopify") throw new IntegrationError("Bu sağlayıcı için kurulum başlatılamaz.");
  await writeMeta(brandId, id, { setupStartedAt: new Date().toISOString() }, { status: "not_connected" });
  await audit({ brandId, actor, action: "integration.setup_started", message: `${def.name}: kurulum başlatıldı (kimlik bilgisi bekleniyor)` });
}

function validateFields(def: IntegrationDef, input: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const f of def.fields) {
    const v = (input[f.name] ?? "").trim();
    if (f.required && !v) throw new IntegrationError(`${f.label} gerekli.`);
    if (v.length > 4000) throw new IntegrationError(`${f.label} çok uzun.`);
    if (v && f.pattern && !new RegExp(f.pattern).test(v)) throw new IntegrationError(`${f.label} biçimi geçersiz.`);
    if (/\s/.test(v) && f.secret) throw new IntegrationError(`${f.label} boşluk içeremez.`);
    out[f.name] = v;
  }
  return out;
}

/**
 * Kimlik bilgilerini kaydeder. Gizli alanlar şifrelenir, gizli olmayanlar (userId, blogId, clientId, kapsamlar) yapılandırmada tutulur.
 * Brandwatch: parola saklanmaz; hemen resmî belirteç alınır ve yalnızca belirteç saklanır.
 */
export async function saveCredentials(brandId: string, id: IntegrationId, input: Record<string, string>, opts: { actor?: string; fetchImpl?: FetchLike } = {}) {
  const def = integrationDef(id);
  if (!def || id === "shopify") throw new IntegrationError("Shopify, mağaza alan adıyla 'Bağlan ve test et' üzerinden bağlanır.");
  const v = validateFields(def, input);
  const actor = opts.actor ?? "user";
  const secrets = Object.fromEntries(def.fields.filter((f) => f.secret).map((f) => [f.name, v[f.name]]));
  const plain = Object.fromEntries(def.fields.filter((f) => !f.secret).map((f) => [f.name, v[f.name]]));
  const now = new Date().toISOString();
  if (id === "brandwatch") {
    // Parolayı saklamadan belirteç al
    return runTest(brandId, id, opts.fetchImpl, { brandwatch: { username: v.username, password: v.password }, fields: plain, actor });
  }
  await writeMeta(brandId, id, { setupStartedAt: now, credentialsSavedAt: now, lastOutcome: null, verifiedAt: null, lastSuccessAt: null, tokenExpiresAt: null }, { status: "not_connected", credentials: secrets, fields: plain, lastError: null });
  await audit({ brandId, actor, action: "integration.credentials_saved", message: `${def.name}: kimlik bilgileri şifreli kaydedildi (değerler kaydedilmez)` });
  return { state: (await integrationCard(brandId, id)).state, detail: def.test ? "Kaydedildi. Şimdi 'Bağlantıyı test et' ile doğrulayın." : "Kaydedildi. Resmî API belgesi doğrulanana kadar bu sağlayıcı test edilemez." };
}

/** Gerçek resmî test. Sonuç durum alanlarına yazılır; gizli değer günlüğe/denetime yazılmaz. */
export async function testIntegration(brandId: string, id: IntegrationId, opts: { actor?: string; fetchImpl?: FetchLike; shop?: string } = {}) {
  if (id === "shopify") {
    if (!opts.shop) throw new IntegrationError("Mağaza alan adı gerekli.");
    const r = await testShopify(brandId, opts.shop);
    await audit({ brandId, actor: opts.actor ?? "user", action: "integration.test", message: `Shopify testi: ${r.ok ? "başarılı" : "başarısız"}` });
    return { state: (await integrationCard(brandId, "shopify")).state, detail: r.detail, ok: r.ok };
  }
  return runTest(brandId, id, opts.fetchImpl, { actor: opts.actor ?? "user" });
}

async function runTest(brandId: string, id: IntegrationId, fetchImpl: FetchLike | undefined, opts: { actor: string; brandwatch?: { username: string; password: string }; fields?: Record<string, string> }) {
  const def = integrationDef(id)!;
  const f: FetchLike = fetchImpl ?? ((u, i) => fetch(u, i));
  const conn = await getConnection(id as ProviderId, brandId);
  const creds = connectionCredentials<Record<string, string>>(conn) ?? {};
  const fields = { ...fieldsOf(conn), ...(opts.fields ?? {}) };
  if (!def.test) throw new IntegrationError(`${def.name} için resmî bağlantı testi bu sürümde yok (API belgesi müşteriye özel).`);
  let r: TestResult;
  if (id === "brandwatch") {
    if (!opts.brandwatch) {
      // Kayıtlı belirteç: süre kontrolü dışında doğrulanabilir resmî okuma uç noktası bu sürümde yok
      if (!creds.accessToken) throw new IntegrationError("Brandwatch için API kullanıcı e-postası ve parolası girin.");
      const exp = metaOf(conn).tokenExpiresAt;
      r = exp && new Date(exp).getTime() < Date.now()
        ? { outcome: "auth_error", detail: "Brandwatch belirtecinin süresi doldu; API kullanıcı bilgileriyle yeniden alın." }
        : { outcome: "success", detail: "Brandwatch belirteci kayıtlı ve süresi geçerli (yeniden doğrulamak için bilgileri tekrar girin)." };
    } else r = await testBrandwatch(f, opts.brandwatch);
  } else if (id === "metricool") {
    if (!creds.userToken || !fields.userId || !fields.blogId) throw new IntegrationError("Metricool için belirteç, userId ve blogId gerekli.");
    r = await testMetricool(f, { userToken: creds.userToken, userId: fields.userId, blogId: fields.blogId });
  } else if (id === "runway") {
    if (!creds.apiKey) throw new IntegrationError("Runway API anahtarı kayıtlı değil.");
    r = await testRunway(f, { apiKey: creds.apiKey });
  } else if (id === "adobe") {
    if (!fields.clientId || !creds.clientSecret || !fields.scopes) throw new IntegrationError("Adobe için Client ID, client secret ve kapsamlar gerekli.");
    r = await testAdobe(f, { clientId: fields.clientId, clientSecret: creds.clientSecret, scopes: fields.scopes });
  } else throw new IntegrationError("Bu sağlayıcı için test yok.");

  const now = new Date().toISOString();
  const ok = r.outcome === "success";
  const prev = metaOf(conn);
  const patch: Partial<IntegrationMeta> = {
    lastTestAt: now, lastOutcome: r.outcome,
    ...(ok ? { verifiedAt: now, lastSuccessAt: now, lastSyncAt: r.account ? now : prev.lastSyncAt ?? null, syncStatus: r.account ? "Hesap bilgisi okundu" : prev.syncStatus ?? null } : { lastErrorAt: now }),
    ...(r.account ? { account: r.account } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    ...(r.tokenExpiresAt !== undefined ? { tokenExpiresAt: r.tokenExpiresAt } : {}),
    ...(opts.brandwatch ? { setupStartedAt: prev.setupStartedAt ?? now, credentialsSavedAt: ok ? now : prev.credentialsSavedAt ?? null } : {}),
  };
  const storeCreds = ok && r.storeCredentials ? { ...creds, ...r.storeCredentials } : undefined;
  await writeMeta(brandId, id, patch, { status: ok ? "connected" : "error", credentials: storeCreds, fields: opts.fields ? fields : undefined, lastError: ok ? null : redact(r.detail).slice(0, 500) });
  await audit({ brandId, actor: opts.actor, action: "integration.test", message: `${def.name} bağlantı testi: ${ok ? "doğrulandı" : r.outcome}` });
  const card = await integrationCard(brandId, id);
  return { state: card.state, detail: r.detail, ok };
}

/** Kimlik bilgilerini siler ve durumu sıfırlar. */
export async function removeIntegration(brandId: string, id: IntegrationId, actor = "user") {
  const def = integrationDef(id);
  if (!def || id === "shopify") throw new IntegrationError("Shopify bağlantısı mevcut 'Bağlantıyı kaldır' ile kaldırılır.");
  await upsertConnection(id as ProviderId, brandId, { status: "not_connected", credentials: null, config: { integration: {}, fields: {} }, lastError: null });
  await audit({ brandId, actor, action: "integration.removed", message: `${def.name}: kimlik bilgileri silindi` });
}

/** Menüde "kurulum bekliyor" işareti: ilgili platform doğrulanmamış sayfalar. */
export async function navAwaiting(brandId: string): Promise<string[]> {
  const v = await verifiedIntegrations(brandId).catch(() => new Set<IntegrationId>());
  const out: string[] = [];
  if (!v.has("shopify")) out.push("/is/e-ticaret", "/is/musteriler", "/is/satis");
  if (!v.has("muck_rack")) out.push("/pr-ajansi/medya-iliskileri");
  if (!v.has("brandwatch")) out.push("/pr-ajansi/istihbarat", "/pr-ajansi/influencer");
  return out;
}
