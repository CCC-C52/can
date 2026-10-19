import crypto from "node:crypto";
import { config } from "@/lib/config";
import { connectionCredentials, getConnection, upsertConnection } from "@/lib/services/connections";
import { PermanentError, TransientError } from "@/lib/models/types";
import { fetchJson, UncertainOutcomeError } from "./http";

// Instagram API with Instagram Login — içerik yayınlama.
// Akış: /<IG_ID>/media (konteyner) → /<IG_CONTAINER_ID>?fields=status_code (FINISHED) → /<IG_ID>/media_publish
// Gereken izinler: instagram_business_basic, instagram_business_content_publish (Business/Creator hesap).
// Medya Instagram tarafından herkese açık bir URL'den çekilir; yerel depolamada yayın yapılamaz.
// NOT: Bu ortamda gerçek hesapla test edilmedi.

const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];
const graph = () => `https://graph.instagram.com/${config.instagram.graphVersion}`;

export function instagramRedirectUri() {
  return `${config.publicBaseUrl}/api/integrations/instagram/callback`;
}

export function instagramAuthUrl(state: string) {
  if (!config.instagram.appId) throw new PermanentError("INSTAGRAM_APP_ID tanımlı değil.");
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", config.instagram.appId);
  u.searchParams.set("redirect_uri", instagramRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(","));
  u.searchParams.set("state", state);
  return u.toString();
}

type Creds = { access_token: string; expires_at: number; user_id: string };

export async function completeInstagramOAuth(brandId: string, code: string) {
  if (!config.instagram.appId || !config.instagram.appSecret) throw new PermanentError("Instagram uygulama bilgileri tanımlı değil.");
  const short = await fetchJson("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.instagram.appId, client_secret: config.instagram.appSecret, grant_type: "authorization_code", redirect_uri: instagramRedirectUri(), code }).toString(),
  });
  const shortToken = short?.access_token ?? short?.data?.[0]?.access_token;
  if (!shortToken) throw new PermanentError("Instagram belirteç yanıtı beklenmedik biçimde.");
  const long = await fetchJson(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: config.instagram.appSecret, access_token: shortToken })}`);
  const me = await fetchJson(`${graph()}/me?${new URLSearchParams({ fields: "user_id,username,account_type", access_token: long.access_token })}`);
  await upsertConnection("instagram", brandId, {
    status: "connected",
    config: { username: me.username, account_type: me.account_type ?? null },
    credentials: { access_token: long.access_token, expires_at: Date.now() + Number(long.expires_in ?? 0) * 1000, user_id: String(me.user_id ?? me.id) },
    scopes: SCOPES,
    lastError: null,
  });
}

async function creds(brandId: string): Promise<Creds> {
  const conn = await getConnection("instagram", brandId);
  const c = connectionCredentials<Creds>(conn);
  if (!conn || conn.status !== "connected" || !c) throw new PermanentError("Instagram bağlı değil.");
  if (c.expires_at && c.expires_at < Date.now()) {
    await upsertConnection("instagram", brandId, { status: "reauth_required", lastError: "Belirteç süresi doldu." });
    throw new PermanentError("Instagram belirtecinin süresi doldu; yeniden bağlanın.");
  }
  return c;
}

export async function testInstagram(brandId: string) {
  try {
    const c = await creds(brandId);
    const me = await fetchJson(`${graph()}/me?${new URLSearchParams({ fields: "user_id,username", access_token: c.access_token })}`);
    await upsertConnection("instagram", brandId, { status: "connected", lastError: null, config: { username: me.username } });
    return { ok: true, detail: `Bağlı: @${me.username}` };
  } catch (err) {
    await upsertConnection("instagram", brandId, { status: "error", lastError: (err as Error).message });
    return { ok: false, detail: (err as Error).message };
  }
}

export type InstagramPost = { mediaUrl: string; isVideo: boolean; format: "feed" | "reel" | "story"; caption: string; coverUrl?: string };

/** Yayın. Konteyner oluşturma tekrarlanabilir; media_publish adımı sonucu belirsizse tekrar gönderilmez. */
export async function publishInstagram(brandId: string, post: InstagramPost, opts: { pollMs?: number; maxPolls?: number } = {}) {
  const c = await creds(brandId);
  const params: Record<string, string> = { caption: post.caption, access_token: c.access_token };
  if (post.isVideo) {
    params.media_type = post.format === "story" ? "STORIES" : "REELS";
    params.video_url = post.mediaUrl;
    if (post.coverUrl) params.cover_url = post.coverUrl;
  } else {
    params.image_url = post.mediaUrl;
    if (post.format === "story") params.media_type = "STORIES";
  }
  const container = await fetchJson(`${graph()}/${c.user_id}/media`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  const containerId = container.id as string;
  for (let i = 0; i < (opts.maxPolls ?? 30); i++) {
    const st = await fetchJson(`${graph()}/${containerId}?${new URLSearchParams({ fields: "status_code", access_token: c.access_token })}`);
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new PermanentError(`Instagram medya işleme hatası: ${st.status_code}`);
    if (i === (opts.maxPolls ?? 30) - 1) throw new TransientError("Instagram medya işlemesi zamanında bitmedi.");
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
  }
  try {
    const pub = await fetchJson(`${graph()}/${c.user_id}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: containerId, access_token: c.access_token }).toString(),
      idempotent: false,
    });
    return { mediaId: pub.id as string, containerId };
  } catch (err) {
    if (err instanceof TransientError) throw new UncertainOutcomeError(`Yayın isteği sonucu belirsiz (konteyner ${containerId}). Hesabı kontrol edin.`);
    throw err;
  }
}

/** Meta webhook imzası: X-Hub-Signature-256 = "sha256=" + hex(HMAC-SHA256(app_secret, ham gövde)). */
export function verifyMetaSignature(rawBody: string | Buffer, header: string | null, secret = config.instagram.appSecret ?? config.meta.appSecret): boolean {
  if (!header || !secret || !header.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
