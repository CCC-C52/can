import crypto from "node:crypto";
import { config } from "@/lib/config";

// Basit yönetici oturumu: imzalı, süreli çerez. İnternete açık sürümde (APP_MODE=production) zorunludur.

const MAX_AGE_S = 60 * 60 * 12;

/** Canlıda "__Host-" önekli çerez: yalnızca HTTPS, alt alan adlarına sızamaz. */
export function sessionCookieName() {
  return config.appMode === "production" ? "__Host-aiops_session" : "aiops_session";
}

/** İmza anahtarı parolaya da bağlıdır: ADMIN_PASSWORD değişince tüm eski oturumlar geçersiz olur. */
function secret() {
  const pw = crypto.createHash("sha256").update(config.adminPassword ?? "").digest("hex");
  if (config.sessionSecret) return `${config.sessionSecret}:${pw}`;
  if (config.appMode === "production") throw new Error("SESSION_SECRET tanımlı değil");
  return crypto.createHash("sha256").update(`local-session:${config.databaseUrl}:${pw}`).digest("hex");
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

// ---------------------------------------------------------------- Kaba kuvvet koruması
// IP başına 15 dakikada 5, tüm IP'ler için 15 dakikada 50 hatalı denemeden sonra giriş geçici olarak kilitlenir.
const WINDOW_MS = 15 * 60_000;
const PER_IP = 5;
const GLOBAL = 50;
const g = globalThis as unknown as { __loginFails?: Map<string, number[]> };
const fails = (g.__loginFails ??= new Map<string, number[]>());

function recent(key: string) {
  const now = Date.now();
  const list = (fails.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  fails.set(key, list);
  return list;
}

export function loginLocked(ip: string): boolean {
  return recent(`ip:${ip}`).length >= PER_IP || recent("global").length >= GLOBAL;
}

export function recordLoginFailure(ip: string) {
  recent(`ip:${ip}`).push(Date.now());
  recent("global").push(Date.now());
}

export function clearLoginFailures(ip: string) {
  fails.delete(`ip:${ip}`);
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
