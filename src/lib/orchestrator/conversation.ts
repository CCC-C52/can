import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import type { BrandContext } from "@/lib/agents/context";
import type { SpecialistId } from "@/lib/agents/schemas";

// Ana yöneticinin konuşma durumu: önceki mesajlar, onay bekleyen plan önerisi ve kısa onayların eşleştirilmesi.
// Her talimat ayrı bir proje olarak kaydedilir; bu modül projeler arasında konuşmanın sürekliliğini sağlar.

export type PlanTask = { key: string; agent: SpecialistId; title: string; instruction: string; depends_on: string[] };

export type PendingProposal = {
  projectId: string;
  title: string;
  instruction: string;
  reply: string;
  goals: string[];
  tasks: PlanTask[];
  createdAt: string;
};

/** Onay bekleyen öneri bu süreden eskiyse kısa bir onayla otomatik başlatılmaz. */
export const PROPOSAL_MAX_AGE_HOURS = 72;
const HISTORY_MESSAGES = 12;
const HISTORY_MESSAGE_CHARS = 1500;

const CONFIRM_PHRASES = [
  "onaylıyorum", "onaylıyoruz", "onay veriyorum", "onay veriyoruz", "onaylandı", "onaylı", "onay", "onayladım",
  "tamam", "tamamdır", "olur", "uygun", "uygundur", "kabul", "kabul ediyorum", "evet",
  "devam", "devam et", "devam edin", "devam edebilirsin", "devam edebilirsiniz",
  "bunu yap", "bunu yapın", "yap", "yapalım", "başla", "başlat", "başlayalım", "başlayabilirsin", "başlayabilirsiniz",
  "ok", "okey", "okay", "yes", "approved", "approve", "go", "go ahead", "proceed",
];
const FILLER = new Set(["ve", "lütfen", "hadi", "o", "zaman", "planı", "plan", "öneriyi", "bunu", "and", "please", "sure", "it"]);
const NEGATION = new Set(["değil", "hayır", "yapma", "yapmayın", "durdur", "iptal", "bekle", "vazgeç", "olmaz", "no", "not", "dont", "stop", "cancel"]);

/**
 * Mesaj yalnızca kısa bir onay mı ("onaylıyorum", "tamam, devam et", "evet bunu yap")?
 * Ek içerik (yeni istek, değişiklik, soru) veya olumsuzluk içeren mesajlar onay sayılmaz.
 */
export function isShortConfirmation(text: string): boolean {
  if (text.length > 60 || text.includes("?")) return false;
  const words = text.toLocaleLowerCase("tr").replace(/[\p{P}\p{S}]+/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length || words.some((w) => NEGATION.has(w))) return false;
  const phrases = CONFIRM_PHRASES.map((p) => p.split(" ")).sort((a, b) => b.length - a.length);
  let matched = false;
  for (let i = 0; i < words.length; ) {
    const hit = phrases.find((p) => p.every((w, j) => words[i + j] === w));
    if (hit) { matched = true; i += hit.length; continue; }
    if (FILLER.has(words[i])) { i++; continue; }
    return false;
  }
  return matched;
}

/**
 * Markanın onay bekleyen en son plan önerisi. Öneri; yöneticinin "awaiting_approval" ile döndürdüğü, görevleri
 * henüz oluşturulmamış ve bilgi bekleyen (needs_input) projedir. Daha yeni bir proje iş görevi başlattıysa
 * veya öneri süresi geçtiyse bekleyen öneri yoktur (yanlış plana onay bağlanmaz).
 */
export async function pendingProposal(brandId: string, db: Queryable = getPool(), opts: { forUpdate?: boolean } = {}): Promise<PendingProposal | null> {
  const row = await q1<{ id: string; title: string; instruction: string; created_at: string; content: any }>(
    `SELECT p.id, p.title, p.instruction, p.created_at, v.content
     FROM projects p
     JOIN tasks t ON t.project_id = p.id AND t.kind = 'plan' AND t.status = 'completed'
     JOIN outputs o ON o.id = t.output_id AND o.brand_id = p.brand_id
     JOIN output_versions v ON v.output_id = o.id AND v.version = (SELECT MAX(version) FROM output_versions WHERE output_id = o.id)
     WHERE p.brand_id = $1 AND p.status = 'needs_input' AND (v.content->>'awaiting_approval')::boolean IS TRUE
       AND p.created_at > now() - make_interval(hours => $2)
       AND NOT EXISTS (SELECT 1 FROM tasks w WHERE w.project_id = p.id AND w.kind <> 'plan')
       AND NOT EXISTS (
         SELECT 1 FROM projects n JOIN tasks nt ON nt.project_id = n.id AND nt.kind <> 'plan'
         WHERE n.brand_id = p.brand_id AND n.created_at > p.created_at)
     ORDER BY p.created_at DESC LIMIT 1
     ${opts.forUpdate ? "FOR UPDATE OF p" : ""}`,
    [brandId, PROPOSAL_MAX_AGE_HOURS],
    db,
  );
  const tasks: PlanTask[] = Array.isArray(row?.content?.sanitized_tasks) ? row!.content.sanitized_tasks : [];
  if (!row || tasks.length === 0) return null;
  return {
    projectId: row.id,
    title: row.title,
    instruction: row.instruction,
    reply: String(row.content.reply ?? ""),
    goals: Array.isArray(row.content.goals) ? row.content.goals.map(String) : [],
    tasks,
    createdAt: row.created_at,
  };
}

/** Bu projeden önceki son sohbet mesajları (eski → yeni). Yöneticiye konuşmanın devamı olarak verilir. */
export async function recentConversation(brandId: string, projectId: string, db: Queryable = getPool()) {
  const rows = await q<{ role: string; content: string; created_at: string }>(
    `SELECT role, content, created_at FROM (
       SELECT m.role, m.content, m.created_at FROM chat_messages m
       WHERE m.brand_id = $1 AND m.created_at < (SELECT created_at FROM projects WHERE id = $2 AND brand_id = $1)
       ORDER BY m.created_at DESC LIMIT $3) x
     ORDER BY created_at`,
    [brandId, projectId, HISTORY_MESSAGES],
    db,
  );
  return rows.map((r) => ({ role: r.role === "user" ? "owner" : r.role, at: r.created_at, text: r.content.slice(0, HISTORY_MESSAGE_CHARS) }));
}

/**
 * Marka bağlamındaki kayıtların sayımı. Yönetici "katalogda ürün yok" gibi bir ifadeyi ancak bu sayım sıfırsa
 * kullanabilir; ürün bilgisi hafızada veya arşivde de olabilir.
 */
export function catalogCheck(ctx: BrandContext) {
  return {
    product_count: ctx.products.length,
    product_titles: ctx.products.map((p) => p.title).slice(0, 50),
    variant_count: ctx.products.reduce((n, p) => n + p.variants.length, 0),
    active_memory_count: ctx.brand.memory.length,
    verified_brand_fact_count: ctx.brand.verified_facts.length,
    media_count: ctx.media.length,
    media_themes: [...new Set(ctx.media.flatMap((m) => m.themes ?? []))].slice(0, 30),
  };
}

const NO_PRODUCT_CLAIM = /(katalog\w*|mağaza\w*|kayıtlı|catalog\w*)[^.\n]{0,40}(ürün\w*|product\w*)?[^.\n]{0,20}(yok|bulunm\w*|bulunamad\w*|kayıtlı değil|no products|empty)/iu;

/** Ürün kaydı varken "katalogda ürün yok" diyen bir cümle içeriyor mu? */
export function contradictsCatalog(text: string, productCount: number) {
  return productCount > 0 && NO_PRODUCT_CLAIM.test(text);
}
