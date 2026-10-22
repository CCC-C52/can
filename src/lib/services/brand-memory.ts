import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { SPECIALISTS, type AgentId } from "@/lib/agents/schemas";
import { redact } from "@/lib/security/crypto";

// Marka hafızası: sahibin onayladığı kalıcı bilgiler. Her sorgu marka kimliğiyle sınırlıdır.
// - Yalnızca "active" kayıtlar ajan bağlamına girer.
// - Sistemin önerdiği kayıtlar (ör. ret notundan ders) "proposed" olarak oluşturulur; sahip etkinleştirmeden kullanılmaz.
// - Gizli bilgi (anahtar, parola, kart numarası) içeren metin kaydedilmez.

export const MEMORY_KINDS = ["guideline", "lesson", "preference", "agent_instruction", "strategy", "campaign_note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryStatus = "proposed" | "active" | "archived";

export type BrandMemory = {
  id: string;
  brand_id: string;
  kind: MemoryKind;
  agent: AgentId | null;
  title: string;
  body: string;
  status: MemoryStatus;
  source: "owner" | "rejection" | "research";
  source_ref: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
};

export class MemoryValidationError extends Error {}

const AGENTS_ALLOWED: string[] = ["manager", ...SPECIALISTS];
/** Bağlama girecek etkin hafıza üst sınırları (istem boyutu ve önbellek kararlılığı için). */
export const MEMORY_CONTEXT_MAX_ITEMS = 40;
export const MEMORY_CONTEXT_MAX_CHARS = 12_000;

/** Gizli bilgi gibi görünen metni tespit eder (anahtar, token, parola, kart numarası). */
export function looksSecret(text: string): boolean {
  if (redact(text) !== text) return true;
  if (/(?<![\p{L}\p{N}_])(?:parola|şifre|password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S{4,}/iu.test(text)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  // 13-19 haneli kart numarası (boşluk/tire ile)
  if (/\b(?:\d[ -]?){13,19}\b/.test(text) && luhnAny(text)) return true;
  return false;
}

function luhnAny(text: string) {
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

function validate(input: { kind: string; agent?: string | null; title: string; body: string }) {
  if (!(MEMORY_KINDS as readonly string[]).includes(input.kind)) throw new MemoryValidationError("Geçersiz hafıza türü.");
  if (input.agent && !AGENTS_ALLOWED.includes(input.agent)) throw new MemoryValidationError("Geçersiz ajan.");
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || title.length > 200) throw new MemoryValidationError("Başlık 1-200 karakter olmalı.");
  if (!body || body.length > 4000) throw new MemoryValidationError("Metin 1-4000 karakter olmalı.");
  if (looksSecret(`${title}\n${body}`)) throw new MemoryValidationError("Metin gizli bilgi (anahtar, parola, kart numarası) içeriyor gibi görünüyor; marka hafızasına kaydedilmedi.");
  return { title, body };
}

export async function listMemory(brandId: string, opts: { status?: MemoryStatus } = {}, db: Queryable = getPool()) {
  return q<BrandMemory>(
    `SELECT * FROM brand_memory WHERE brand_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY (status = 'proposed') DESC, (status = 'active') DESC, created_at DESC LIMIT 500`,
    [brandId, opts.status ?? null],
    db,
  );
}

export async function addMemory(
  brandId: string,
  input: { kind: MemoryKind; agent?: AgentId | null; title: string; body: string; status?: MemoryStatus; source?: BrandMemory["source"]; sourceRef?: string | null; createdBy?: string },
  db: Queryable = getPool(),
) {
  const { title, body } = validate(input);
  const status = input.status ?? "active";
  return (await q1<BrandMemory>(
    `INSERT INTO brand_memory (brand_id, kind, agent, title, body, status, source, source_ref, created_by, activated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $6 = 'active' THEN now() END) RETURNING *`,
    [brandId, input.kind, input.agent || null, title, body, status, input.source ?? "owner", input.sourceRef ?? null, input.createdBy ?? "user"],
    db,
  ))!;
}

/** Durum değişikliği. Başka markanın kaydı bulunamaz (marka kimliği zorunlu). */
export async function setMemoryStatus(brandId: string, id: string, status: MemoryStatus, db: Queryable = getPool()) {
  const row = await q1<BrandMemory>(
    `UPDATE brand_memory SET status = $3, updated_at = now(), activated_at = CASE WHEN $3 = 'active' THEN now() ELSE activated_at END
     WHERE id = $1 AND brand_id = $2 RETURNING *`,
    [id, brandId, status],
    db,
  );
  if (!row) throw new MemoryValidationError("Hafıza kaydı bulunamadı.");
  return row;
}

export async function updateMemory(brandId: string, id: string, input: { title: string; body: string; kind: MemoryKind; agent?: AgentId | null }, db: Queryable = getPool()) {
  const { title, body } = validate(input);
  const row = await q1<BrandMemory>(
    `UPDATE brand_memory SET title = $3, body = $4, kind = $5, agent = $6, updated_at = now() WHERE id = $1 AND brand_id = $2 RETURNING *`,
    [id, brandId, title, body, input.kind, input.agent || null],
    db,
  );
  if (!row) throw new MemoryValidationError("Hafıza kaydı bulunamadı.");
  return row;
}

/** Ajan bağlamı için etkin kayıtlar: tüm ajanlara açık olanlar + bu ajana özel olanlar. Boyut sınırlıdır. */
export async function activeMemoryFor(brandId: string, agent: AgentId | undefined, db: Queryable = getPool()) {
  const rows = await q<Pick<BrandMemory, "kind" | "agent" | "title" | "body">>(
    `SELECT kind, agent, title, body FROM brand_memory
     WHERE brand_id = $1 AND status = 'active' AND (agent IS NULL OR $2::text IS NULL OR agent = $2)
     ORDER BY activated_at ASC NULLS LAST, id ASC LIMIT $3`,
    [brandId, agent ?? null, MEMORY_CONTEXT_MAX_ITEMS],
    db,
  );
  const out: { kind: string; scope: string; title: string; body: string }[] = [];
  let used = 0;
  for (const r of rows) {
    const size = r.title.length + r.body.length;
    if (used + size > MEMORY_CONTEXT_MAX_CHARS) break;
    used += size;
    out.push({ kind: r.kind, scope: r.agent ?? "all_agents", title: r.title, body: r.body });
  }
  return out;
}

/**
 * Ret notundan ders önerisi. Not boşsa, çok kısaysa veya gizli bilgi içeriyorsa öneri oluşturulmaz.
 * Öneri "proposed" durumundadır: sahip Marka Hafızası sayfasında etkinleştirmeden ajanlara verilmez.
 */
export async function proposeLessonFromRejection(
  brandId: string,
  args: { approvalId: string; note: string | null | undefined; agent: string; outputTitle: string },
  db: Queryable = getPool(),
) {
  const note = (args.note ?? "").trim();
  if (note.length < 10) return null;
  if (looksSecret(note)) return null;
  const agent = AGENTS_ALLOWED.includes(args.agent) ? (args.agent as AgentId) : null;
  return addMemory(
    brandId,
    { kind: "lesson", agent, title: `Ret notu: ${args.outputTitle}`.slice(0, 200), body: note.slice(0, 4000), status: "proposed", source: "rejection", sourceRef: args.approvalId, createdBy: "system" },
    db,
  );
}
