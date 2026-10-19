import crypto from "node:crypto";
import { config } from "@/lib/config";

// Basit yönetici oturumu: imzalı, süreli çerez. İnternete açık sürümde (APP_MODE=production) zorunludur.

export const SESSION_COOKIE = "aiops_session";
const MAX_AGE_S = 60 * 60 * 12;

function secret() {
  if (config.sessionSecret) return config.sessionSecret;
  if (config.appMode === "production") throw new Error("SESSION_SECRET tanımlı değil");
  return crypto.createHash("sha256").update(`local-session:${config.databaseUrl}`).digest("hex");
}

export function loginRequired() {
  return config.appMode === "production" || config.localRequireLogin;
}

export function signSession(): { value: string; maxAge: number } {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = `${exp}.${nonce}`;
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return { value: `${payload}.${sig}`, maxAge: MAX_AGE_S };
}

export function verifySession(value: string | undefined | null): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const expected = crypto.createHmac("sha256", secret()).update(`${exp}.${nonce}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Parola kontrolü (sabit zamanlı). Yanlış denemelerde basit gecikme uygulanır. */
export async function checkPassword(input: string): Promise<boolean> {
  const pw = config.adminPassword;
  if (!pw) return false;
  const a = crypto.createHash("sha256").update(input).digest();
  const b = crypto.createHash("sha256").update(pw).digest();
  const ok = crypto.timingSafeEqual(a, b);
  if (!ok) await new Promise((r) => setTimeout(r, 800));
  return ok;
}
