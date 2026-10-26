import crypto from "node:crypto";
import { config } from "@/lib/config";

/** JSON içeriğini anahtar sırasından bağımsız, kararlı biçimde serileştirir. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function contentHash(content: unknown): string {
  return sha256(canonicalJson(content));
}

function encryptionKey(): Buffer {
  const raw = config.encryptionKey;
  if (raw) {
    // 32 baytlık base64 değer doğrudan kullanılır; başka biçimdeki uzun rastgele değerler (ör. barındırıcının
    // ürettiği gizli değer) SHA-256 ile 32 bayta indirgenir.
    const key = Buffer.from(raw, "base64");
    if (key.length === 32 && /^[A-Za-z0-9+/]+=*$/.test(raw)) return key;
    if (raw.length < 32) throw new Error("ENCRYPTION_KEY en az 32 karakter olmalı.");
    return crypto.createHash("sha256").update(raw).digest();
  }
  if (config.appMode === "production") throw new Error("ENCRYPTION_KEY tanımlı değil.");
  // Yerel geliştirme: makineye özel olmayan sabit anahtar yerine veritabanı adresinden türetilir.
  // Üretimde mutlaka ENCRYPTION_KEY kullanılmalıdır.
  return crypto.createHash("sha256").update(`local-dev:${config.databaseUrl}`).digest();
}

/** AES-256-GCM. Bağlantı kimlik bilgilerini veritabanında şifreli saklamak için. */
export function encryptSecret(plain: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret<T = Record<string, string>>(blob: string): T {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1") throw new Error("Bilinmeyen şifreleme sürümü");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
  return JSON.parse(dec.toString("utf8")) as T;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Günlük kayıtlarına yazılmadan önce olası gizli değerleri maskeler. */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_\-]+/g, "sk-ant-***")
    .replace(/sk-[A-Za-z0-9_\-]{16,}/g, "sk-***")
    .replace(/shpat_[A-Za-z0-9]+/g, "shpat_***")
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, "AIza***")
    .replace(/ya29\.[A-Za-z0-9._\-]+/g, "ya29.***")
    .replace(/\b1\/\/[A-Za-z0-9._\-]{16,}/g, "1//***")
    .replace(/GOCSPX-[A-Za-z0-9_\-]+/g, "GOCSPX-***")
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/g, "Bearer ***")
    .replace(/(access_token|refresh_token|id_token|client_secret|api_key|password|key|sig|signature|X-Amz-Signature|X-Amz-Credential)=([^&\s]+)/gi, "$1=***")
    .replace(/("?(?:access_token|refresh_token|id_token|client_secret|api_key|password|authorization|x-goog-api-key)"?\s*[:=]\s*")([^"]+)"/gi, '$1***"');
}
