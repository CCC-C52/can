import { q, q1, tx, type Queryable, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { getBrand } from "@/lib/services/brands";
import { getLimits } from "@/lib/settings";
import {
  FORBIDDEN_FRAMING, PHASES, keyResultState, monthOf, phaseAt, quarterOf, seedPlan, validMeasurement, weekOf,
  type KeyResult, type Measurement, type Provenance, type StrategyLevel, type StrategyStatus,
} from "@/lib/pr-agency/strategy";
import type { StrategyContext } from "@/lib/pr-agency/briefings";

// 2026–2034 marka stratejisi: düzenlenebilir, veriye dayalı kalemler. Her değişiklik gerekçesiyle geçmişe yazılır.
// Başlangıç önerileri yalnızca sahibin açık isteğiyle eklenir ve "öneri" olarak işaretlenir.

export type StrategyItem = {
  id: string;
  brand_id: string;
  level: StrategyLevel;
  parent_id: string | null;
  period_key: string;
  period_start: string;
  period_end: string;
  title: string;
  body: string | null;
  owner_role: string | null;
  status: StrategyStatus;
  provenance: Provenance;
  key_results: KeyResult[];
  sort: number;
  seed_key: string | null;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export class StrategyError extends Error {}

const LEVELS: StrategyLevel[] = ["vision", "phase", "annual", "quarterly", "monthly", "weekly"];
const STATUSES: StrategyStatus[] = ["proposed", "approved", "active", "at_risk", "done", "dropped"];
const ymd = (v: string | Date) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const norm = (r: StrategyItem): StrategyItem => ({ ...r, period_start: ymd(r.period_start), period_end: ymd(r.period_end) });

function assertFraming(text: string) {
  if (FORBIDDEN_FRAMING.test(text)) throw new StrategyError("Strateji bir geri dönüş/yeniden lansman olarak anlatılmaz (comeback, relaunch, rebirth gibi ifadeler kullanılamaz).");
}

/** Çerçeve önerilerini bir kez ekler (seed_key ile tekrar etmez). Var olan kayıtlar değiştirilmez. */
export async function seedStrategy(brandId: string, actor = "user", db: Queryable = getPool()) {
  if (!(await getBrand(brandId, db))) throw new StrategyError("Marka bulunamadı.");
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`strategy_seed:${brandId}`]);
    const ids = new Map<string, string>();
    for (const r of await q<{ id: string; seed_key: string }>(`SELECT id, seed_key FROM strategy_items WHERE brand_id = $1 AND seed_key IS NOT NULL`, [brandId], c)) ids.set(r.seed_key, r.id);
    let created = 0;
    for (const s of seedPlan()) {
      if (ids.has(s.seedKey)) continue;
      const parent = s.parentSeedKey ? ids.get(s.parentSeedKey) ?? null : null;
      const row = await q1<{ id: string }>(
        `INSERT INTO strategy_items (brand_id, level, parent_id, period_key, period_start, period_end, title, body, owner_role, status, provenance, key_results, sort, seed_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'proposed',$10,$11,$12,$13,$14)
         ON CONFLICT (brand_id, seed_key) WHERE seed_key IS NOT NULL DO NOTHING RETURNING id`,
        [brandId, s.level, parent, s.periodKey, s.periodStart, s.periodEnd, s.title, s.body, s.ownerRole, s.provenance, JSON.stringify(s.keyResults), s.sort, s.seedKey, `seed:${actor}`],
        c,
      );
      if (row) { ids.set(s.seedKey, row.id); created++; }
    }
    if (created) await audit({ brandId, actor, action: "strategy.seed", message: `2026–2034 strateji çerçevesi oluşturuldu (${created} öneri kalemi; onay bekliyor)` }, c);
    return { created };
  });
}

export async function listStrategy(brandId: string, db: Queryable = getPool()): Promise<StrategyItem[]> {
  const rows = await q<StrategyItem>(
    `SELECT * FROM strategy_items WHERE brand_id = $1
     ORDER BY array_position(ARRAY['vision','phase','annual','quarterly','monthly','weekly']::text[], level), period_start, sort, created_at`,
    [brandId],
    db,
  );
  return rows.map(norm);
}

export async function getStrategyItem(brandId: string, id: string, db: Queryable = getPool()) {
  const r = await q1<StrategyItem>(`SELECT * FROM strategy_items WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
  return r ? norm(r) : null;
}

export async function strategyRevisions(brandId: string, itemId: string, db: Queryable = getPool()) {
  return q<{ id: string; changed_by: string; reason: string | null; before: any; after: any; created_at: string }>(
    `SELECT id, changed_by, reason, before, after, created_at FROM strategy_item_revisions WHERE brand_id = $1 AND item_id = $2 ORDER BY created_at DESC LIMIT 50`,
    [brandId, itemId],
    db,
  );
}

export type StrategyPatch = { title?: string; body?: string | null; status?: StrategyStatus; ownerRole?: string | null; keyResults?: KeyResult[] };

/** Kalemi günceller; değişiklik ve gerekçe geçmişe yazılır (stratejik ayarlama izi). */
export async function updateStrategyItem(brandId: string, id: string, patch: StrategyPatch, opts: { actor?: string; reason?: string | null } = {}) {
  const actor = opts.actor ?? "user";
  return tx(async (c) => {
    const cur = await q1<StrategyItem>(`SELECT * FROM strategy_items WHERE id = $1 AND brand_id = $2 FOR UPDATE`, [id, brandId], c);
    if (!cur) throw new StrategyError("Strateji kalemi bulunamadı.");
    const next = {
      title: patch.title !== undefined ? patch.title.trim().slice(0, 300) : cur.title,
      body: patch.body !== undefined ? (patch.body?.trim().slice(0, 8000) || null) : cur.body,
      status: patch.status ?? cur.status,
      owner_role: patch.ownerRole !== undefined ? patch.ownerRole : cur.owner_role,
      key_results: patch.keyResults ?? cur.key_results,
    };
    if (!next.title) throw new StrategyError("Başlık boş olamaz.");
    if (!STATUSES.includes(next.status)) throw new StrategyError("Geçersiz durum.");
    if (next.owner_role && !/^[a-z_]{2,40}$/.test(next.owner_role)) throw new StrategyError("Geçersiz sorumlu rol.");
    assertFraming(`${next.title}\n${next.body ?? ""}`);
    for (const kr of next.key_results) {
      if (!kr.label?.trim() || !kr.target?.trim()) throw new StrategyError("Her anahtar sonuç için ad ve hedef gerekli.");
      if (kr.baseline && !validMeasurement(kr.baseline)) throw new StrategyError(`${kr.label}: başlangıç değeri için sayı, tarih ve kaynak gerekli.`);
      if (kr.current && !validMeasurement(kr.current)) throw new StrategyError(`${kr.label}: güncel değer için sayı, tarih ve kaynak gerekli.`);
    }
    // Sahip düzenlediğinde kaynak "sahip" olur; yalnızca durum değişikliği önerinin kaynağını değiştirmez
    const contentChanged = next.title !== cur.title || next.body !== cur.body;
    const provenance: Provenance = contentChanged && actor === "user" ? "owner" : cur.provenance;
    await q(
      `UPDATE strategy_items SET title = $3, body = $4, status = $5, owner_role = $6, key_results = $7, provenance = $8, updated_by = $9, updated_at = now() WHERE id = $1 AND brand_id = $2`,
      [id, brandId, next.title, next.body, next.status, next.owner_role, JSON.stringify(next.key_results), provenance, actor],
      c,
    );
    const before = { title: cur.title, body: cur.body, status: cur.status, owner_role: cur.owner_role, key_results: cur.key_results, provenance: cur.provenance };
    const after = { ...next, provenance };
    await q(`INSERT INTO strategy_item_revisions (item_id, brand_id, changed_by, reason, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, brandId, actor, opts.reason?.trim().slice(0, 1000) || null, JSON.stringify(before), JSON.stringify(after)], c);
    await audit({ brandId, actor, action: "strategy.update", message: `Strateji kalemi güncellendi: ${next.title} (${cur.status} → ${next.status})` }, c);
    return norm({ ...cur, ...next, provenance } as StrategyItem);
  });
}

/** Ölçüm kaydı: anahtar sonucun başlangıç veya güncel değeri (kaynak zorunlu). */
export async function recordMeasurement(brandId: string, id: string, index: number, which: "baseline" | "current", m: Measurement, actor = "user") {
  if (!validMeasurement(m)) throw new StrategyError("Ölçüm için sayı, tarih (YYYY-AA-GG) ve kaynak gerekli.");
  const cur = await getStrategyItem(brandId, id);
  if (!cur) throw new StrategyError("Strateji kalemi bulunamadı.");
  const krs = [...cur.key_results];
  if (!krs[index]) throw new StrategyError("Anahtar sonuç bulunamadı.");
  krs[index] = { ...krs[index], [which]: { value: m.value, measuredAt: m.measuredAt.slice(0, 10), source: m.source.trim().slice(0, 300) } };
  return updateStrategyItem(brandId, id, { keyResults: krs }, { actor, reason: `${krs[index].label}: ${which === "baseline" ? "başlangıç" : "güncel"} ölçüm ${m.value} (${m.source})` });
}

export type NewStrategyItem = { level: StrategyLevel; parentId: string | null; periodKey: string; title: string; body?: string | null; ownerRole?: string | null; keyResults?: KeyResult[] };

/** Yeni kalem (çeyreklik OKR, aylık kampanya planı, haftalık uygulama). Dönem tarihleri anahtardan hesaplanır. */
export async function addStrategyItem(brandId: string, input: NewStrategyItem, actor = "user") {
  if (!LEVELS.includes(input.level) || input.level === "vision" || input.level === "phase") throw new StrategyError("Bu düzeyde yeni kalem eklenemez.");
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new StrategyError("Başlık gerekli.");
  assertFraming(`${title}\n${input.body ?? ""}`);
  const pk = input.periodKey.trim();
  let period: { key: string; start: string; end: string };
  if (input.level === "annual") {
    if (!/^20(2[6-9]|3[0-4])$/.test(pk)) throw new StrategyError("Yıl 2026–2034 arasında olmalı.");
    period = { key: pk, start: `${pk}-01-01`, end: `${pk}-12-31` };
  } else if (input.level === "quarterly") {
    const m = /^(\d{4})-Q([1-4])$/.exec(pk);
    if (!m) throw new StrategyError("Çeyrek YYYY-Q1..Q4 biçiminde olmalı.");
    period = quarterOf(`${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, "0")}-01`);
  } else if (input.level === "monthly") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(pk)) throw new StrategyError("Ay YYYY-AA biçiminde olmalı.");
    period = monthOf(`${pk}-01`);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pk)) throw new StrategyError("Hafta için o haftadan bir tarih (YYYY-AA-GG) girin.");
    period = weekOf(pk);
  }
  if (period.start < "2026-01-01" || period.end > "2034-12-31") throw new StrategyError("Dönem 2026–2034 aralığında olmalı.");
  if (input.parentId && !(await getStrategyItem(brandId, input.parentId))) throw new StrategyError("Üst kalem bulunamadı.");
  const row = await q1<StrategyItem>(
    `INSERT INTO strategy_items (brand_id, level, parent_id, period_key, period_start, period_end, title, body, owner_role, status, provenance, key_results, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'proposed',$10,$11,$12) RETURNING *`,
    [brandId, input.level, input.parentId, period.key, period.start, period.end, title, input.body?.trim().slice(0, 8000) || null, input.ownerRole ?? null, actor === "user" ? "owner" : "ai_recommendation", JSON.stringify(input.keyResults ?? []), actor],
  );
  await audit({ brandId, actor, action: "strategy.add", message: `Strateji kalemi eklendi (${input.level} ${period.key}): ${title}` });
  return norm(row!);
}

/** Ana ekran ve ajans merkezi için özet: güncel aşama, bu yılın hedefi, bu çeyreğin OKR'leri. */
export async function strategySnapshot(brandId: string, now = new Date(), db: Queryable = getPool()) {
  const today = now.toISOString().slice(0, 10);
  const items = await listStrategy(brandId, db);
  const phase = phaseAt(today);
  const at = (lvl: StrategyLevel) => items.filter((i) => i.level === lvl && i.period_start <= today && today <= i.period_end && i.status !== "dropped");
  const krs = items.flatMap((i) => i.key_results);
  return {
    created: items.length > 0,
    total: items.length,
    approved: items.filter((i) => ["approved", "active", "done"].includes(i.status)).length,
    proposed: items.filter((i) => i.status === "proposed").length,
    phase,
    phaseItem: items.find((i) => i.level === "phase" && phase && i.seed_key === `phase:${phase.key}`) ?? null,
    annual: at("annual"),
    quarterly: at("quarterly"),
    monthly: at("monthly"),
    weekly: at("weekly"),
    measured: krs.filter((k) => keyResultState(k) !== "unmeasured").length,
    keyResults: krs.length,
    phases: PHASES.map((p) => ({ ...p, item: items.find((i) => i.seed_key === `phase:${p.key}`) ?? null })),
  };
}

const krView = (k: KeyResult) => ({ label: k.label, target: k.target, state: keyResultState(k), baseline: k.baseline?.value ?? null, current: k.current?.value ?? null, source: k.current?.source ?? k.baseline?.source ?? null });

/** Raporlar için strateji bağlamı (yalnızca kayıtlı veri). */
export async function strategyContext(brandId: string, now = new Date(), db: Queryable = getPool()): Promise<StrategyContext> {
  const snap = await strategySnapshot(brandId, now, db);
  const year = now.getUTCFullYear();
  const items = await listStrategy(brandId, db);
  const [cost, limit, campaigns, drafts] = await Promise.all([
    q1<{ act: string | null; unknown: number }>(`SELECT SUM(amount_usd) FILTER (WHERE kind = 'actual') AS act, COUNT(*) FILTER (WHERE amount_usd IS NULL)::int AS unknown FROM cost_entries WHERE brand_id = $1 AND created_at > now() - interval '30 days'`, [brandId], db),
    getLimits(db),
    q<{ title: string; status: string }>(`SELECT title, status FROM projects WHERE brand_id = $1 AND status IN ('planning','running','needs_attention','needs_input') ORDER BY created_at DESC LIMIT 10`, [brandId], db),
    q1<{ social: number; outreach: number; creative: number }>(
      `SELECT COUNT(*) FILTER (WHERE kind = 'social_package')::int AS social,
              COUNT(*) FILTER (WHERE kind IN ('pr_plan','pr_event_plan'))::int AS outreach,
              COUNT(*) FILTER (WHERE kind IN ('design_brief','video_plan'))::int AS creative
       FROM outputs WHERE brand_id = $1 AND created_at > now() - interval '30 days'`, [brandId], db),
  ]);
  return {
    phase: snap.phase ? { title: snap.phase.title, label: snap.phase.label, focus: snap.phase.focus } : null,
    annual: snap.annual.map((a) => ({ periodKey: a.period_key, title: a.title, status: a.status, keyResults: a.key_results.map(krView) })),
    quarter: snap.quarterly.map((a) => ({ periodKey: a.period_key, title: a.title, status: a.status, keyResults: a.key_results.map(krView) })),
    nextAnnual: items.filter((i) => i.level === "annual" && i.period_key === String(year + 1)).map((i) => ({ periodKey: i.period_key, title: i.title })),
    budget: { spent30dUsd: cost?.act === null || cost?.act === undefined ? null : Number(cost.act), dailyLimitUsd: limit.dailyBudgetUsd, unknownCostEntries: cost?.unknown ?? 0 },
    activeCampaigns: campaigns,
    drafts: drafts ?? { social: 0, outreach: 0, creative: 0 },
    measuredKpis: snap.measured,
  };
}
