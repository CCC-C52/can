import { redact } from "@/lib/security/crypto";

// Yapılandırılmış günlük: her satır tek bir JSON nesnesi (Render günlük ekranında aranabilir).
// Gizli değerler yazılmadan önce maskelenir; müşteri içerikleri (metin, dosya) günlüğe yazılmaz.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown> & { requestId?: string; brandId?: string | null; projectId?: string | null; taskId?: string | null; durationMs?: number };

const SECRET_KEYS = /(secret|password|token|api[_-]?key|authorization|cookie|credential)/i;

function clean(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redact(v).slice(0, 2000);
  if (v instanceof Error) return { name: v.name, message: redact(v.message).slice(0, 2000) };
  if (Array.isArray(v)) return depth > 3 ? "[…]" : v.slice(0, 50).map((x) => clean(x, depth + 1));
  if (v && typeof v === "object") {
    if (depth > 3) return "{…}";
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? "***" : clean(x, depth + 1);
    return out;
  }
  return v;
}

export function log(level: LogLevel, event: string, fields: LogFields = {}) {
  if (process.env.LOG_SILENT === "1" || (level === "debug" && process.env.LOG_LEVEL !== "debug")) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(clean(fields) as object) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

/** İstek kimliği: barındırıcının verdiği x-request-id (biçimi geçerliyse) ya da yeni bir kimlik. */
export function requestIdFrom(headers: Headers): string {
  const given = headers.get("x-request-id");
  return given && /^[A-Za-z0-9._-]{8,80}$/.test(given) ? given : crypto.randomUUID();
}
