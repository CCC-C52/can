import crypto from "node:crypto";
import { z } from "zod";
import { isUuid } from "@/lib/ids";
import { q, q1, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { isPaused } from "@/lib/settings";
import { rateLimit } from "@/lib/security/rate-limit";
import { redact } from "@/lib/security/crypto";
import { getProject, listTasks, submitInstruction, InputError } from "@/lib/orchestrator/projects";
import { isShortConfirmation } from "@/lib/orchestrator/conversation";

// ChatGPT (veya başka bir bağlayıcı) → AI Manager köprüsü. Oturum çerezi yerine servisler arası belirteçle korunur.
// Belirteçler kaynakta, veritabanında veya günlüklerde düz metin olarak TUTULMAZ; ortam değişkeninde yalnızca SHA-256 özeti bulunur.
//
// AI_MANAGER_BRIDGE_CREDENTIALS = "<id>|<sha256-hex>|<brand-uuid>|<scope,scope>;<id2>|..."
//   Belirteç biçimi: "fbb_<id>_<rastgele>" (en az 32 karakter rastgele kısım). Rotasyon: yeni girdi ekle → bağlayıcıyı güncelle → eskiyi sil.
//   Kapsamlar: "status:read" (proje/görev durumu okuma), "instructions:submit" (talimat gönderme; ücretli işe yol açabilir).
// Değişken tanımlı değilse köprü tamamen kapalıdır (404).

export const BRIDGE_SCOPES = ["status:read", "instructions:submit"] as const;
export type BridgeScope = (typeof BRIDGE_SCOPES)[number];
export type BridgeCredential = { id: string; hash: string; brandId: string; scopes: BridgeScope[] };

const ID_RE = /^[a-z0-9]{3,32}$/;
const TOKEN_RE = /^fbb_([a-z0-9]{3,32})_([A-Za-z0-9_-]{32,128})$/;
const ACTOR = (c: BridgeCredential) => `bridge:${c.id}`;

/** Ortamdaki kimlik bilgisi listesini ayrıştırır; hatalı girdiler sessizce yok sayılır (köprü açık kalmaz, girdi geçersizdir). */
export function bridgeCredentials(raw = process.env.AI_MANAGER_BRIDGE_CREDENTIALS): BridgeCredential[] {
  if (!raw) return [];
  const out: BridgeCredential[] = [];
  for (const entry of raw.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [id, hash, brandId, scopeList] = entry.split("|").map((s) => s?.trim() ?? "");
    if (!ID_RE.test(id) || !/^[0-9a-f]{64}$/.test(hash) || !isUuid(brandId)) continue;
    const scopes = (scopeList ?? "").split(",").map((s) => s.trim()).filter((s): s is BridgeScope => (BRIDGE_SCOPES as readonly string[]).includes(s));
    if (!scopes.length || out.some((c) => c.id === id)) continue;
    out.push({ id, hash, brandId, scopes });
  }
  return out;
}

export function bridgeEnabled() {
  return bridgeCredentials().length > 0;
}

/** "Bearer fbb_<id>_<gizli>" → eşleşen kimlik bilgisi (sabit süreli karşılaştırma) veya null. */
export function authenticateBridge(authorization: string | null): BridgeCredential | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  const m = TOKEN_RE.exec(token);
  const creds = bridgeCredentials();
  // Kimlik bulunamasa bile karşılaştırma yapılır: yanıt süresi belirteç kimliğinin varlığını sızdırmaz.
  const cred = (m && creds.find((c) => c.id === m[1])) || null;
  const a = crypto.createHash("sha256").update(token).digest();
  const b = Buffer.from(cred?.hash ?? "0".repeat(64), "hex");
  const ok = crypto.timingSafeEqual(a, b);
  return ok && cred ? cred : null;
}

export class BridgeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Kimlik doğrulama + kapsam + hız sınırı. Her başarısız deneme ayrıca IP başına sınırlanır. */
export function authorizeBridge(req: Request, scope: BridgeScope): BridgeCredential {
  if (!bridgeEnabled()) throw new BridgeError(404, "not_found", "Not found");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`bridge-ip:${ip}`, 60, 60_000).ok) throw new BridgeError(429, "rate_limited", "Too many requests");
  const cred = authenticateBridge(req.headers.get("authorization"));
  if (!cred) throw new BridgeError(401, "unauthorized", "Invalid or missing bridge credential");
  if (!cred.scopes.includes(scope)) throw new BridgeError(403, "forbidden", `Credential lacks scope ${scope}`);
  const [max, win] = scope === "instructions:submit" ? [10, 60 * 60_000] : [120, 60_000];
  if (!rateLimit(`bridge-cred:${cred.id}:${scope}`, max, win).ok) throw new BridgeError(429, "rate_limited", "Too many requests");
  return cred;
}

// ---------------------------------------------------------------- Talimat gönderme

const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,100}$/;
/** Yeniden oynatma penceresi: istemci zaman damgası bu kadar eski/ileri olamaz. Aynı anahtar ise her zaman aynı projeye çözülür. */
export const REPLAY_WINDOW_MS = 5 * 60_000;

export const BridgeInstructionSchema = z.object({
  instruction: z.string().trim().min(1).max(8000),
  /** Ücretli yapay zekâ işini başlatabileceğini açıkça kabul eder. false/eksik ise hiçbir kayıt yazılmaz (yalnızca önizleme). */
  confirm_cost: z.boolean().optional(),
}).strict();

export type SubmitResult =
  | { status: "preview"; billable: true; message: string }
  | { status: "accepted" | "duplicate"; project_id: string; project_status: string; title: string };

export async function bridgeSubmit(cred: BridgeCredential, input: { body: unknown; idempotencyKey: string | null; timestamp: string | null }): Promise<SubmitResult> {
  if (!input.idempotencyKey || !IDEMPOTENCY_RE.test(input.idempotencyKey)) throw new BridgeError(400, "invalid_idempotency_key", "Idempotency-Key header required (16-100 chars, [A-Za-z0-9_-])");
  const ts = Number(input.timestamp);
  if (!input.timestamp || !Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > REPLAY_WINDOW_MS) {
    throw new BridgeError(400, "stale_request", "X-Bridge-Timestamp (unix seconds) missing or outside the 5 minute window");
  }
  const parsed = BridgeInstructionSchema.safeParse(input.body);
  if (!parsed.success) throw new BridgeError(400, "invalid_body", "Body must be {instruction: string(1-8000), confirm_cost?: boolean}");
  const instruction = parsed.data.instruction.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!instruction.trim()) throw new BridgeError(400, "invalid_body", "Instruction is empty");
  // Kısa onaylar ("onaylıyorum", "devam et") bekleyen planı başlatır → ücretli iş. Plan onayı yalnızca panelden verilir.
  if (isShortConfirmation(instruction)) throw new BridgeError(409, "approval_requires_panel", "Plan approvals must be given by the owner in the FriBee panel (/sohbet), not through the bridge");
  // Köprü anahtarları panel anahtarlarıyla ve diğer kimlik bilgileriyle çakışamaz
  const idempotencyKey = `bridge:${cred.id}:${input.idempotencyKey}`;
  const existing = await q1<{ id: string; brand_id: string; status: string; title: string }>(`SELECT id, brand_id, status, title FROM projects WHERE idempotency_key = $1`, [idempotencyKey]);
  if (existing) {
    if (existing.brand_id !== cred.brandId) throw new BridgeError(409, "idempotency_conflict", "Idempotency key conflict");
    return { status: "duplicate", project_id: existing.id, project_status: existing.status, title: existing.title };
  }
  if (parsed.data.confirm_cost !== true) {
    return { status: "preview", billable: true, message: "Submitting starts AI Manager planning, which calls a paid model. Resend with confirm_cost=true after the owner approves the cost. Nothing was stored." };
  }
  if (await isPaused()) throw new BridgeError(409, "paused", "FriBee work is paused by the owner; no instruction was stored");
  try {
    // Panel (/sohbet) ile aynı gönderim yolu: aynı doğrulama, idempotency, bütçe denetimleri işleyicide uygulanır.
    const r = await submitInstruction({ brandId: cred.brandId, instruction, idempotencyKey });
    await audit({ brandId: cred.brandId, projectId: r.project.id, actor: ACTOR(cred), action: r.duplicate ? "bridge.instruction_duplicate" : "bridge.instruction_submit", message: `Köprü talimatı: ${redact(r.project.title)}`, data: { credential: cred.id, confirm_cost: true } });
    return { status: r.duplicate ? "duplicate" : "accepted", project_id: r.project.id, project_status: r.project.status, title: r.project.title };
  } catch (err) {
    if (err instanceof InputError) throw new BridgeError(400, "invalid_body", err.message);
    throw err;
  }
}

// ---------------------------------------------------------------- Durum okuma

const PUBLIC_TASK_FIELDS = ["id", "key", "agent", "kind", "title", "status", "requires_approval", "attempts", "error", "created_at", "finished_at"] as const;

export async function bridgeProjectStatus(cred: BridgeCredential, projectId: string) {
  // Başka markanın projesi "bulunamadı" ile aynı yanıtı alır (varlık sızdırılmaz)
  const project = isUuid(projectId) ? await getProject(cred.brandId, projectId) : null;
  if (!project) throw new BridgeError(404, "not_found", "Project not found");
  const tasks = await listTasks(cred.brandId, { projectId: project.id });
  const messages = await q<{ role: string; content: string; created_at: string }>(
    `SELECT role, content, created_at FROM chat_messages WHERE brand_id = $1 AND project_id = $2 AND role <> 'user' ORDER BY created_at DESC LIMIT 5`,
    [cred.brandId, project.id],
    getPool(),
  );
  return {
    project: { id: project.id, title: project.title, status: project.status, questions: project.questions ?? [], created_at: project.created_at, updated_at: project.updated_at },
    tasks: tasks.map((t) => Object.fromEntries(PUBLIC_TASK_FIELDS.map((k) => [k, k === "error" && t.error ? redact(t.error).slice(0, 500) : t[k]]))),
    manager_messages: messages.reverse().map((m) => ({ role: m.role, text: redact(m.content).slice(0, 4000), at: m.created_at })),
    pending_approvals_in_panel: tasks.some((t) => t.status === "approval_pending") || project.status === "needs_input",
  };
}

/** Hata → JSON yanıt. Beklenmeyen hataların ayrıntısı istemciye sızdırılmaz. */
export function bridgeErrorResponse(err: unknown) {
  const headers = { "Cache-Control": "no-store" };
  if (err instanceof BridgeError) {
    if (err.status === 404 && err.code === "not_found" && err.message === "Not found") return new Response(null, { status: 404, headers });
    return Response.json({ error: err.code, message: err.message }, { status: err.status, headers });
  }
  return Response.json({ error: "internal_error" }, { status: 500, headers });
}
