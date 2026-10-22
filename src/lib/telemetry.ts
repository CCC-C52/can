import { config } from "@/lib/config";
import { redact } from "@/lib/security/crypto";

// İsteğe bağlı sunucu tarafı telemetri (PostHog). POSTHOG_API_KEY yoksa hiçbir şey gönderilmez.
// Gizlilik:
//  - Tarayıcı betiği, çerez, oturum kaydı (session recording) YOK.
//  - Kişi profili oluşturulmaz ($process_person_profile: false); distinct_id yalnızca servis rolüdür.
//  - Yalnızca izinli alanlar gönderilir; metinler maskelenir ve kısaltılır. Müşteri içeriği, istem, dosya adı,
//    e-posta veya IP gönderilmez.
//  - Gönderim hatası uygulamayı etkilemez (3 sn zaman aşımı, sessiz).

const ALLOWED_FIELDS = new Set(["requestId", "route", "durationMs", "status", "agent", "purpose", "kind", "service", "provider", "attempt", "code", "step"]);

export function telemetryEnabled() {
  return !!config.posthog.apiKey;
}

function role() {
  return process.env.AIOPS_ROLE ?? (process.argv.some((a) => a.includes("worker")) ? "worker" : "web");
}

function sanitize(fields: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = redact(v).slice(0, 200);
  }
  return out;
}

/** Olay gövdesi (test edilebilir, ağ çağrısı yok). */
export function buildEvent(event: string, fields: Record<string, unknown>, error?: unknown) {
  const properties: Record<string, unknown> = {
    ...sanitize(fields),
    $process_person_profile: false,
    app_mode: config.appMode,
    service_role: role(),
  };
  if (error !== undefined) {
    const e = error instanceof Error ? error : new Error(String(error));
    const value = redact(e.message).slice(0, 500);
    properties.$exception_list = [{ type: e.name || "Error", value, mechanism: { handled: true, synthetic: false } }];
    properties.$exception_message = value;
    properties.$exception_type = e.name || "Error";
  }
  return {
    api_key: config.posthog.apiKey,
    event: error !== undefined ? "$exception" : `aiops.${event}`.slice(0, 120),
    distinct_id: `aiops-server-${role()}`,
    properties: error !== undefined ? { ...properties, aiops_event: event.slice(0, 120) } : properties,
    timestamp: new Date().toISOString(),
  };
}

let inFlight = 0;

/** Olayı gönderir (beklenmez). Yapılandırılmamışsa hiçbir şey yapmaz. */
export function capture(event: string, fields: Record<string, unknown> = {}, opts: { error?: unknown; fetchImpl?: typeof fetch } = {}) {
  if (!telemetryEnabled()) return;
  if (inFlight > 20) return; // geri basınç: telemetri asla birikmesin
  let body: string;
  try {
    body = JSON.stringify(buildEvent(event, fields, opts.error));
  } catch {
    return;
  }
  inFlight++;
  const host = config.posthog.host.replace(/\/+$/, "");
  (opts.fetchImpl ?? fetch)(`${host}/i/v0/e/`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(3000) })
    .catch(() => {})
    .finally(() => { inFlight--; });
}
