import { q, q1, tx, type Queryable, getPool } from "@/lib/db/pool";
import { getSetting, setSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { redact } from "@/lib/security/crypto";
import { assertPublicUrl } from "@/lib/adapters/firecrawl";
import { getBrand } from "@/lib/services/brands";
import { addVersion, createOutput } from "@/lib/services/outputs";
import { rollingCalendar } from "@/lib/pr-agency/observances";
import { buildEventPlan, type BrandKnowledge } from "@/lib/pr-agency/event-plan";
import {
  SOURCE_CATALOG, clusterItems, feedHealth, fetchBlockedReason, parseFeed, scoreCluster, toTrendItem,
  type FeedHealth, type FeedState, type ScoredCluster, type TrendItem,
} from "@/lib/pr-agency/trends";
import { buildBriefing } from "@/lib/pr-agency/briefings";
import { dueReports, type ReportKind } from "@/lib/pr-agency/roles";
import { buildRoadmap, type MeasuredMetric } from "@/lib/pr-agency/roadmap";
import { operationEvidence } from "@/lib/orchestrator/verification";
import { strategyContext } from "@/lib/services/strategy";

import { firecrawlConfigured } from "@/lib/adapters/firecrawl";
import { researchBlockedReason } from "@/lib/services/research";
import { effectiveStatus } from "@/lib/services/connections";
import {
  CONNECTORS, WORKSTREAMS, classifyFreshness, collectionsFor, dedupeEvidence, scoreRelevance, workstreamAvailability,
  type Availability, type ConnectorId, type Evidence, type Freshness, type Verification,
} from "@/lib/pr-agency/model";

// PR AJANSI servisi: zamanlanmış işler (işleyici çağırır) + sahibin yapılandırması.
// Güvenlik:
//  - Dış iletişim, reklam, sosyal gönderi ve bütçe değişikliği YOK. Üretilen her şey "outputs" tablosuna taslak olarak
//    yazılır ve mevcut onay kuyruğunda (/onaylar) görünür. Onay yalnızca "content" kapsamı verir; dış işlem kapısı
//    (gateway.ts) pr_* türlerini hiçbir dış işleme bağlamaz.
//  - Ücretli sağlayıcı çağrısı yok (yalnızca sahibin etkinleştirdiği halka açık RSS/Atom beslemeleri, kota ile).
//  - Tüm okumalar/yazmalar brand_id ile sınırlıdır.
// Kalıcılık: yeni geçiş (migration) eklememek için durum "settings" tablosunda marka başına anahtarlarla tutulur.

export const PR_AGENT = "pr_agency";
export const PR_KINDS = {
  daily_brief: "pr_daily_brief",
  weekly_report: "pr_weekly_report",
  monthly_presentation: "pr_monthly_presentation",
  quarterly_review: "pr_quarterly_review",
  annual_review: "pr_annual_review",
  alert: "pr_alert",
  event_plan: "pr_event_plan",
} as const;

export type PrConfig = {
  /** Zamanlanmış üretim açık mı (sahip bir kez açar; sonra komut beklemeden çalışır). */
  enabled: boolean;
  /** Sahibin etkinleştirdiği katalog kaynakları. */
  enabledSources: string[];
  /** Organizatör tarihli etkinlikler için sahibin doğruladığı tarihler. */
  verifiedDates: Record<string, { date: string; endDate?: string; sourceUrl: string }>;
  /** Marka bilgi merkezinden (veya sahipten) koleksiyonlar ve anahtar kelimeler. */
  collections: { name: string; keywords: string[]; sourceRef: string | null }[];
  /** Ölçülmüş metrikler (OKR başlangıçları). */
  measuredMetrics: MeasuredMetric[];
  roadmapStart: string | null;
};

export const DEFAULT_PR_CONFIG: PrConfig = { enabled: false, enabledSources: [], verifiedDates: {}, collections: [], measuredMetrics: [], roadmapStart: null };

const configKey = (brandId: string) => `pr_agency:config:${brandId}`;
const feedsKey = (brandId: string) => `pr_agency:feeds:${brandId}`;
const itemsKey = (brandId: string) => `pr_agency:items:${brandId}`;

/** Saklanan trend penceresi: 8 gün, en fazla 600 kayıt (hız hesabı için yeterli). */
export const ITEM_WINDOW_MS = 8 * 24 * 3_600_000;
export const ITEM_WINDOW_MAX = 600;

export class PrConfigError extends Error {}

export async function getPrConfig(brandId: string, db: Queryable = getPool()): Promise<PrConfig> {
  return { ...DEFAULT_PR_CONFIG, ...(await getSetting<Partial<PrConfig>>(configKey(brandId), {}, db)) };
}

export async function updatePrConfig(brandId: string, patch: Partial<PrConfig>, db: Queryable = getPool()): Promise<PrConfig> {
  if (!(await getBrand(brandId, db))) throw new PrConfigError("Marka bulunamadı.");
  const next = { ...(await getPrConfig(brandId, db)), ...patch };
  next.enabledSources = [...new Set(next.enabledSources)];
  for (const id of next.enabledSources) {
    const def = SOURCE_CATALOG.find((s) => s.id === id);
    if (!def) throw new PrConfigError(`Bilinmeyen kaynak: ${id}`);
    assertPublicUrl(def.url);
  }
  for (const [id, v] of Object.entries(next.verifiedDates)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date) || (v.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(v.endDate))) throw new PrConfigError(`${id}: tarih YYYY-AA-GG olmalı.`);
    if (!/^https?:\/\//.test(v.sourceUrl)) throw new PrConfigError(`${id}: doğrulanmış tarih için kaynak adresi gerekli.`);
  }
  for (const m of next.measuredMetrics) {
    if (!Number.isFinite(m.value) || !m.source?.trim() || !/^\d{4}-\d{2}-\d{2}/.test(m.measuredAt)) throw new PrConfigError(`${m.key}: ölçülmüş değer, tarih ve kaynak gerekli.`);
  }
  next.collections = next.collections
    .map((c) => ({ name: c.name.trim().slice(0, 100), keywords: c.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 20), sourceRef: c.sourceRef ?? null }))
    .filter((c) => c.name && c.keywords.length);
  await setSetting(configKey(brandId), next, db);
  await audit({ brandId, actor: "user", action: "pr_agency.config", message: `PR ajansı ayarları güncellendi (zamanlama ${next.enabled ? "açık" : "kapalı"}, ${next.enabledSources.length} kaynak)` }, db);
  return next;
}

async function getFeedStates(brandId: string, db: Queryable): Promise<Record<string, FeedState>> {
  return getSetting<Record<string, FeedState>>(feedsKey(brandId), {}, db);
}

export async function getTrendItems(brandId: string, db: Queryable = getPool()): Promise<TrendItem[]> {
  return getSetting<TrendItem[]>(itemsKey(brandId), [], db);
}

function statesWithEnabled(cfg: PrConfig, states: Record<string, FeedState>): Record<string, FeedState> {
  const out: Record<string, FeedState> = {};
  for (const def of SOURCE_CATALOG) {
    const s: Partial<FeedState> | undefined = states[def.id];
    out[def.id] = {
      sourceId: def.id, lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, requestsToday: 0, requestsDay: null,
      ...s,
      enabled: cfg.enabledSources.includes(def.id),
    };
  }
  return out;
}

export async function listFeedHealth(brandId: string, now = new Date(), env: Record<string, string | undefined> = process.env, db: Queryable = getPool()): Promise<FeedHealth[]> {
  const states = statesWithEnabled(await getPrConfig(brandId, db), await getFeedStates(brandId, db));
  return SOURCE_CATALOG.map((def) => feedHealth(def, states[def.id], now, env));
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const MAX_FEED_BYTES = 2_000_000;

/**
 * Etkinleştirilmiş, kota/aralık kapısını geçen beslemeleri çeker. Bağlı olmayan kaynak için istek yapılmaz.
 * Dönen değer: kaynak başına sonuç (atlanan kaynaklar nedeniyle birlikte).
 */
export async function pollFeeds(
  brandId: string,
  opts: { now?: Date; fetchImpl?: FetchLike; env?: Record<string, string | undefined>; db?: Queryable } = {},
): Promise<{ sourceId: string; status: "fetched" | "skipped" | "failed"; reason?: string; items?: number }[]> {
  const db = opts.db ?? getPool();
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const f = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const cfg = await getPrConfig(brandId, db);
  const states = statesWithEnabled(cfg, await getFeedStates(brandId, db));
  const results: { sourceId: string; status: "fetched" | "skipped" | "failed"; reason?: string; items?: number }[] = [];
  const fresh: TrendItem[] = [];
  const today = now.toISOString().slice(0, 10);

  for (const def of SOURCE_CATALOG) {
    const st = states[def.id];
    const blocked = fetchBlockedReason(def, st, now, env);
    if (blocked) {
      if (st.enabled) results.push({ sourceId: def.id, status: "skipped", reason: blocked });
      continue;
    }
    st.lastAttemptAt = now.toISOString();
    st.requestsToday = st.requestsDay === today ? st.requestsToday + 1 : 1;
    st.requestsDay = today;
    try {
      const url = assertPublicUrl(def.url);
      const res = await f(url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_FEED_BYTES) throw new Error("Feed too large");
      const items = parseFeed(text).map((r) => toTrendItem(r, def, now));
      fresh.push(...items);
      st.lastSuccessAt = now.toISOString();
      st.lastError = null;
      st.consecutiveFailures = 0;
      results.push({ sourceId: def.id, status: "fetched", items: items.length });
    } catch (err) {
      st.lastError = redact((err as Error).message).slice(0, 300);
      st.consecutiveFailures += 1;
      results.push({ sourceId: def.id, status: "failed", reason: st.lastError });
    }
  }

  // Yalnızca durum alanları saklanır ("enabled" yapılandırmadan türetilir)
  const toStore: Record<string, FeedState> = {};
  for (const [id, s] of Object.entries(states)) if (s.lastAttemptAt) toStore[id] = s;
  await setSetting(feedsKey(brandId), toStore, db);
  if (fresh.length) await mergeItems(brandId, fresh, now, db);
  const fetched = results.filter((r) => r.status === "fetched").length;
  const failed = results.filter((r) => r.status === "failed").length;
  if (fetched || failed) await audit({ brandId, actor: "system", action: "pr_agency.poll", message: `PR beslemeleri: ${fetched} başarılı, ${failed} başarısız, ${fresh.length} kayıt` }, db);
  return results;
}

/** Aynı kaynak + kanonik URL tekrar eklenmez; pencere dışı kayıtlar ve fazlası atılır. */
export async function mergeItems(brandId: string, incoming: TrendItem[], now: Date, db: Queryable = getPool()) {
  const existing = await getTrendItems(brandId, db);
  const seen = new Map<string, TrendItem>();
  for (const i of [...existing, ...incoming]) {
    const k = `${i.sourceId}\n${i.canonicalUrl}`;
    if (!seen.has(k)) seen.set(k, i);
  }
  const cutoff = now.getTime() - ITEM_WINDOW_MS;
  const kept = [...seen.values()]
    .filter((i) => new Date(i.publishedAt ?? i.fetchedAt).getTime() >= cutoff)
    .sort((a, b) => (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt))
    .slice(0, ITEM_WINDOW_MAX);
  await setSetting(itemsKey(brandId), kept, db);
  return kept;
}

/** Marka bilgisi: yalnızca doğrulanmış kaynaklar (marka tonu, sahip koleksiyonları, ürün türleri, doğrulanmış taahhütler). */
export async function brandKnowledge(brandId: string, db: Queryable = getPool()): Promise<BrandKnowledge> {
  const brand = await getBrand(brandId, db);
  if (!brand) throw new PrConfigError("Marka bulunamadı.");
  const cfg = await getPrConfig(brandId, db);
  const types = await q<{ product_type: string }>(
    `SELECT DISTINCT product_type FROM products WHERE brand_id = $1 AND is_sample = false AND status <> 'archived' AND product_type IS NOT NULL AND product_type <> '' ORDER BY product_type LIMIT 30`,
    [brandId],
    db,
  );
  const commitments = await q<{ id: string; statement: string }>(
    `SELECT id, statement FROM brand_facts WHERE brand_id = $1 AND status = 'verified' AND kind <> 'forbidden_claim' AND statement ~* '(donat|pledge|partner)' ORDER BY created_at LIMIT 10`,
    [brandId],
    db,
  );
  // Öncelik: Marka Bilgi Merkezi'nde onaylı koleksiyonlar (kaynaklı); sonra sahibin PR ayarı; en son ürün türleri
  const confirmed = await q<{ entity_key: string; entity_name: string; value: string; id: string }>(
    `SELECT id, entity_key, entity_name, value FROM knowledge_facts WHERE brand_id = $1 AND entity_type = 'collection' AND attribute = 'theme_color' AND status = 'confirmed' ORDER BY entity_name`,
    [brandId],
    db,
  );
  const collections = confirmed.length
    ? confirmed.map((c) => ({ name: c.entity_name, keywords: [...new Set([c.entity_name.toLowerCase(), ...c.entity_name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && w !== "the"), c.value.toLowerCase()])], sourceRef: `knowledge_fact:${c.id}` }))
    : cfg.collections.length
      ? cfg.collections
      : types.map((t) => ({ name: t.product_type, keywords: [t.product_type.toLowerCase()], sourceRef: `product_type:${t.product_type}` }));
  return {
    brandName: brand.name,
    voice: (brand.tone ?? "").split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 8),
    collections,
    verifiedCommitments: commitments.map((c) => ({ title: c.statement.slice(0, 200), sourceRef: `brand_fact:${c.id}` })),
  };
}

export async function scoredClusters(brandId: string, now: Date, db: Queryable = getPool()): Promise<ScoredCluster[]> {
  const knowledge = await brandKnowledge(brandId, db);
  const items = await getTrendItems(brandId, db);
  return clusterItems(items).map((c) => scoreCluster(c, { now, brandName: knowledge.brandName, collections: knowledge.collections }));
}

export async function prCalendar(brandId: string, now = new Date(), db: Queryable = getPool()) {
  const cfg = await getPrConfig(brandId, db);
  return rollingCalendar(now.toISOString().slice(0, 10), cfg.verifiedDates);
}

const REPORT_KIND_TO_OUTPUT: Record<ReportKind, string> = {
  daily_brief: PR_KINDS.daily_brief,
  weekly_report: PR_KINDS.weekly_report,
  monthly_presentation: PR_KINDS.monthly_presentation,
  quarterly_review: PR_KINDS.quarterly_review,
  annual_review: PR_KINDS.annual_review,
};

/** Başarısız operasyon yeniden denemesi: üstel bekleme (5 dk, 15 dk, 45 dk, …), dönem başına en fazla 5 deneme. */
export const OP_MAX_ATTEMPTS = 5;
export function opBackoffMs(attempts: number) {
  return Math.min(6 * 3_600_000, 5 * 60_000 * 3 ** Math.max(0, attempts - 1));
}

/** Operasyon kaydı: rapor kaydedildikten sonra kanıt doğrulanır; ancak doğrulanınca "completed". */
async function recordOperation(brandId: string, operation: string, periodKey: string, outputId: string, c: Queryable) {
  const ev = await q1<{ versions: number; period: string | null }>(
    `SELECT COUNT(*)::int AS versions, MAX(content->>'periodKey') AS period FROM output_versions WHERE output_id = $1`,
    [outputId],
    c,
  );
  const check = operationEvidence({ outputId, savedVersions: ev?.versions ?? 0, periodKey, contentPeriodKey: ev?.period ?? null });
  await q(
    `INSERT INTO pr_operation_runs (brand_id, operation, period_key, stage, output_id, evidence, error, attempts, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1, now(), now())
     ON CONFLICT (brand_id, operation, period_key) DO UPDATE SET stage = EXCLUDED.stage, output_id = EXCLUDED.output_id, evidence = EXCLUDED.evidence,
       error = EXCLUDED.error, attempts = pr_operation_runs.attempts + 1, next_attempt_at = NULL, finished_at = now(), updated_at = now()`,
    [brandId, operation, periodKey, check.ok ? "completed" : "output_produced", outputId, JSON.stringify({ kind: "saved_report", outputId, savedVersions: ev?.versions ?? 0, periodKey: ev?.period ?? null, verifiedAt: check.ok ? new Date().toISOString() : null }), check.reason],
    c,
  );
  return check.ok;
}

/** Başarısız çalıştırma: hata ve bir sonraki deneme zamanı kaydedilir (rapor üretimi geri alınmıştır). */
export async function recordOperationFailure(brandId: string, operation: string, periodKey: string, error: string, now = new Date(), db: Queryable = getPool()) {
  const row = await q1<{ attempts: number }>(
    `INSERT INTO pr_operation_runs (brand_id, operation, period_key, stage, error, attempts, started_at, finished_at)
     VALUES ($1,$2,$3,'failed',$4,1,$5,$5)
     ON CONFLICT (brand_id, operation, period_key) DO UPDATE SET stage = 'failed', error = EXCLUDED.error, attempts = pr_operation_runs.attempts + 1, finished_at = EXCLUDED.finished_at, updated_at = now()
     WHERE pr_operation_runs.stage <> 'completed'
     RETURNING attempts`,
    [brandId, operation, periodKey, redact(error).slice(0, 2000), now.toISOString()],
    db,
  );
  if (row) await q(`UPDATE pr_operation_runs SET next_attempt_at = $4 WHERE brand_id = $1 AND operation = $2 AND period_key = $3`, [brandId, operation, periodKey, new Date(now.getTime() + opBackoffMs(row.attempts)).toISOString()], db);
}

export async function listOperationRuns(brandId: string, limit = 30, db: Queryable = getPool()) {
  return q<{ id: string; operation: string; period_key: string; stage: string; output_id: string | null; evidence: any; error: string | null; attempts: number; next_attempt_at: string | null; finished_at: string | null; created_at: string }>(
    `SELECT id, operation, period_key, stage, output_id, evidence, error, attempts, next_attempt_at, finished_at, created_at FROM pr_operation_runs WHERE brand_id = $1 ORDER BY COALESCE(finished_at, created_at) DESC LIMIT $2`,
    [brandId, limit],
    db,
  );
}

async function createDraft(brandId: string, kind: string, title: string, content: unknown, db: Queryable) {
  const out = await createOutput({ brandId, projectId: null, taskId: null, agent: PR_AGENT, kind, title: title.slice(0, 200) }, db);
  await addVersion({ brandId, outputId: out.id, content, createdBy: `agent:${PR_AGENT}`, generator: "local", isDemo: false }, db);
  return out;
}

async function existingKeys(brandId: string, db: Queryable): Promise<Set<string>> {
  const rows = await q<{ kind: string; key: string | null }>(
    `SELECT o.kind, COALESCE(v.content->>'periodKey', v.content->>'eventId', v.content->>'dedupeKey') AS key
     FROM outputs o JOIN output_versions v ON v.output_id = o.id AND v.version = 1
     WHERE o.brand_id = $1 AND o.agent = $2`,
    [brandId, PR_AGENT],
    db,
  );
  const out = new Set<string>();
  for (const r of rows) if (r.key) out.add(`${r.kind}:${r.key}`);
  return out;
}

/**
 * Vadesi gelen raporları, kriz/fırsat uyarılarını ve hazırlık penceresine giren etkinlik planlarını üretir.
 * Aynı dönem/etkinlik/uyarı için ikinci kez üretmez (marka başına danışma kilidi + içerik anahtarı).
 */
export async function generateDue(brandId: string, opts: { now?: Date; env?: Record<string, string | undefined> } = {}) {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`pr_agency:${brandId}`]);
    const keys = await existingKeys(brandId, c);
    const created: { kind: string; id: string; title: string }[] = [];
    const knowledge = await brandKnowledge(brandId, c);
    const cfg = await getPrConfig(brandId, c);
    const feeds = await listFeedHealth(brandId, now, env, c);
    const clusters = await scoredClusters(brandId, now, c);
    const { events } = rollingCalendar(now.toISOString().slice(0, 10), cfg.verifiedDates);
    const plans = events.map((e) => ({ event: e, plan: buildEventPlan(e, knowledge) }));
    const upcoming = plans.map((p) => ({ event: p.event, approvalDeadline: p.plan.approvalDeadline }));
    const today = now.toISOString().slice(0, 10);

    // 1) Etkinlik planları: hazırlık penceresi açıldığında (bugün ≥ başlangıç) bir kez
    for (const { event, plan } of plans) {
      const kickoff = plan.milestones.find((m) => m.key === "kickoff")!.date;
      if (today < kickoff || today > (event.endDate ?? event.date!)) continue;
      if (keys.has(`${PR_KINDS.event_plan}:${event.id}`)) continue;
      const out = await createDraft(brandId, PR_KINDS.event_plan, `PR plan: ${event.name} (${event.date})`, { ...plan, eventKind: event.kind, dateBasis: event.dateBasis, sourceUrl: event.sourceUrl }, c);
      keys.add(`${PR_KINDS.event_plan}:${event.id}`);
      created.push({ kind: PR_KINDS.event_plan, id: out.id, title: out.title });
    }

    // 2) Raporlar
    const pendingRow = await q1<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM outputs o JOIN output_versions v ON v.output_id = o.id AND v.version = o.current_version
       WHERE o.brand_id = $1 AND o.agent = $2 AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.output_version_id = v.id AND a.revoked_at IS NULL)`,
      [brandId, PR_AGENT],
      c,
    );
    const roadmap = buildRoadmap(cfg.roadmapStart ?? today, cfg.measuredMetrics);
    const strategy = await strategyContext(brandId, now, c);
    // Başarısız olup bekleme süresi dolmamış veya deneme hakkı bitmiş operasyonlar bu turda atlanır
    const blocked = new Set((await q<{ operation: string; period_key: string }>(
      `SELECT operation, period_key FROM pr_operation_runs WHERE brand_id = $1 AND stage = 'failed' AND (attempts >= $2 OR next_attempt_at > $3)`,
      [brandId, OP_MAX_ATTEMPTS, now.toISOString()],
      c,
    )).map((r) => `${r.operation}:${r.period_key}`));
    for (const due of dueReports(now, new Set([...keys].map((k) => k.replace(/^pr_(daily_brief|weekly_report|monthly_presentation|quarterly_review|annual_review):/, "$1:"))))) {
      if (blocked.has(`${due.kind}:${due.periodKey}`)) continue;
      const briefing = buildBriefing({ kind: due.kind, periodKey: due.periodKey, now, brandName: knowledge.brandName, feeds, clusters, upcoming, pendingApprovals: pendingRow?.n ?? 0, roadmap, strategy });
      const out = await createDraft(brandId, REPORT_KIND_TO_OUTPUT[due.kind], briefing.title, briefing, c);
      keys.add(`${REPORT_KIND_TO_OUTPUT[due.kind]}:${due.periodKey}`);
      created.push({ kind: REPORT_KIND_TO_OUTPUT[due.kind], id: out.id, title: out.title });
      await recordOperation(brandId, due.kind, due.periodKey, out.id, c);

      // 3) Koşullu uyarılar (yalnızca taze/kısmi veride bayrak oluşur; aynı küme için bir kez)
      for (const flag of briefing.flags) {
        const cluster = clusters.find((x) => x.label === flag.clusterLabel);
        const dedupeKey = `${flag.type}:${cluster?.key ?? flag.clusterLabel}`;
        if (keys.has(`${PR_KINDS.alert}:${dedupeKey}`)) continue;
        const alert = {
          dedupeKey,
          type: flag.type,
          severity: flag.type === "crisis_watch" ? "critical" : "important",
          title: flag.clusterLabel,
          role: flag.type === "crisis_watch" ? "reputation_crisis" : "strategy_director",
          sourceLinks: flag.sourceLinks,
          confidence: cluster?.confidence ?? null,
          velocity: cluster?.velocity ?? null,
          recommendation: flag.type === "crisis_watch"
            ? "Review sources, verify facts, and prepare a holding statement draft. Do not respond publicly without owner approval."
            : cluster?.opportunity ?? "Evaluate a timely content response.",
          generatedAt: now.toISOString(),
          requiresApproval: true,
        };
        const a = await createDraft(brandId, PR_KINDS.alert, `${flag.type === "crisis_watch" ? "Crisis watch" : "Major opportunity"}: ${flag.clusterLabel}`, alert, c);
        keys.add(`${PR_KINDS.alert}:${dedupeKey}`);
        created.push({ kind: PR_KINDS.alert, id: a.id, title: a.title });
      }
    }
    if (created.length) await audit({ brandId, actor: "system", action: "pr_agency.generated", message: `PR ajansı ${created.length} taslak üretti (onay kuyruğunda)`, data: { created } }, c);
    return created;
  });
}

/** İşleyici adımı: zamanlaması açık markalar için besleme çekimi + vadesi gelen üretim. */
export async function runPrAgencyTick(opts: { now?: Date; fetchImpl?: FetchLike; env?: Record<string, string | undefined> } = {}) {
  const rows = await q<{ key: string }>(`SELECT key FROM settings WHERE key LIKE 'pr_agency:config:%' AND (value->>'enabled')::boolean IS TRUE`);
  const out: { brandId: string; polled: number; created: number; error?: string }[] = [];
  for (const r of rows) {
    const brandId = r.key.slice("pr_agency:config:".length);
    if (!(await getBrand(brandId))) continue;
    let polled: Awaited<ReturnType<typeof pollFeeds>> = [];
    try {
      polled = await pollFeeds(brandId, opts);
      const created = await generateDue(brandId, opts);
      out.push({ brandId, polled: polled.filter((p) => p.status === "fetched").length, created: created.length });
    } catch (err) {
      const msg = redact((err as Error).message);
      // Üretim işlemi geri alındı: vadesi gelen her operasyon için hata + yeniden deneme zamanı kaydedilir
      const now = opts.now ?? new Date();
      const keys = await existingKeys(brandId, getPool()).catch(() => new Set<string>());
      for (const due of dueReports(now, new Set([...keys].map((k) => k.replace(/^pr_(daily_brief|weekly_report|monthly_presentation|quarterly_review|annual_review):/, "$1:"))))) {
        await recordOperationFailure(brandId, due.kind, due.periodKey, msg, now).catch(() => {});
      }
      out.push({ brandId, polled: polled.filter((p) => p.status === "fetched").length, created: 0, error: msg });
    }
  }
  return out;
}

export async function listPrOutputs(brandId: string, limit = 100, db: Queryable = getPool()) {
  return q<{ id: string; kind: string; title: string; created_at: string; version_id: string; content: any; approval: string | null }>(
    `SELECT o.id, o.kind, o.title, o.created_at, v.id AS version_id, v.content,
       (SELECT a.decision FROM approvals a WHERE a.output_version_id = v.id AND a.revoked_at IS NULL ORDER BY a.created_at DESC LIMIT 1) AS approval
     FROM outputs o JOIN output_versions v ON v.output_id = o.id AND v.version = o.current_version
     WHERE o.brand_id = $1 AND o.agent = $2
     ORDER BY o.created_at DESC LIMIT $3`,
    [brandId, PR_AGENT, limit],
    db,
  );
}

// ---------------------------------------------------------------- Genel bakış ve kanıt (PR #14)
// FriBee PR Ajansı — salt okunur genel bakış ve kanıt listesi.
// Yalnızca mevcut, marka kapsamlı tablolar okunur (research_runs, research_sources, projects, outputs).
// Bu servis dış çağrı yapmaz, ücretli işlem başlatmaz ve hiçbir kaydı değiştirmez.

export type ConnectorStatus = { id: ConnectorId; name: string; availability: Availability; detail: string; cadence: string; policy: string };

export async function connectorStatuses(brandId: string, db: Queryable = getPool()): Promise<ConnectorStatus[]> {
  const research = await researchBlockedReason(db);
  const shopify = await effectiveStatus("shopify", brandId);
  return CONNECTORS.map((c) => {
    let availability: Availability = "not_built";
    let detail = "Bu sürümde bağlayıcı yok.";
    if (c.id === "research_firecrawl") {
      availability = research === null ? "available" : firecrawlConfigured() ? "blocked" : "needs_credentials";
      detail = research ?? "Anahtar tanımlı ve web araştırması açık (elle başlatılır).";
    } else if (c.id === "shopify_catalog") {
      availability = shopify.status === "connected" ? "available" : shopify.status === "not_connected" ? "needs_credentials" : "blocked";
      detail = shopify.status === "connected" ? "Bağlı (yalnızca okuma kullanılır)." : (shopify.detail ?? shopify.status);
    }
    return { id: c.id, name: c.name, availability, detail, cadence: c.cadence, policy: c.policy };
  });
}

type SourceRow = { id: string; url: string; title: string | null; excerpt: string | null; verification: Verification; created_at: string | Date };
const toEvidence = (r: SourceRow): Evidence => ({
  id: r.id, url: r.url, title: r.title, excerpt: r.excerpt, verification: r.verification,
  retrievedAt: new Date(r.created_at).toISOString(), connector: "research_firecrawl",
});

export type PrOverview = Awaited<ReturnType<typeof prAgencyOverview>>;

export async function prAgencyOverview(brand: { id: string; name: string; slug: string }, opts: { db?: Queryable; now?: Date } = {}) {
  const db = opts.db ?? getPool();
  const now = opts.now ?? new Date();
  const [connectors, stats, lastRun, work, verifiedRows] = await Promise.all([
    connectorStatuses(brand.id, db),
    q1<{ total: number; verified: number; unverified: number; rejected: number; last_verified_at: string | null; last_retrieved_at: string | null }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE verification = 'verified')::int AS verified,
              COUNT(*) FILTER (WHERE verification = 'unverified')::int AS unverified,
              COUNT(*) FILTER (WHERE verification = 'rejected')::int AS rejected,
              MAX(created_at) FILTER (WHERE verification = 'verified') AS last_verified_at,
              MAX(created_at) AS last_retrieved_at
       FROM research_sources WHERE brand_id = $1`,
      [brand.id],
      db,
    ),
    q1<{ status: string; created_at: string; finished_at: string | null; error: string | null }>(
      `SELECT status, created_at, finished_at, error FROM research_runs WHERE brand_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [brand.id],
      db,
    ),
    q1<{ active_projects: number; outputs: number }>(
      `SELECT (SELECT COUNT(*)::int FROM projects WHERE brand_id = $1 AND status IN ('planning','running','needs_attention')) AS active_projects,
              (SELECT COUNT(*)::int FROM outputs WHERE brand_id = $1) AS outputs`,
      [brand.id],
      db,
    ),
    q<SourceRow>(
      `SELECT id, url, title, excerpt, verification, created_at FROM research_sources
       WHERE brand_id = $1 AND verification = 'verified' ORDER BY created_at DESC, id DESC LIMIT 50`,
      [brand.id],
      db,
    ),
  ]);
  const byId = Object.fromEntries(connectors.map((c) => [c.id, c.availability])) as Record<ConnectorId, Availability>;
  const collections = collectionsFor(brand);
  const verified = dedupeEvidence(verifiedRows.map(toEvidence));
  const toIso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);
  const freshness: Freshness = classifyFreshness(stats?.last_verified_at ?? null, { now, lastRunStatus: lastRun?.status ?? null });
  return {
    brand: { id: brand.id, name: brand.name },
    generatedAt: now.toISOString(),
    collections,
    connectors,
    evidence: {
      total: stats?.total ?? 0,
      verified: stats?.verified ?? 0,
      unverified: stats?.unverified ?? 0,
      rejected: stats?.rejected ?? 0,
      lastVerifiedAt: toIso(stats?.last_verified_at),
      lastRetrievedAt: toIso(stats?.last_retrieved_at),
      freshness,
    },
    lastRun: lastRun ? { status: lastRun.status, createdAt: toIso(lastRun.created_at)!, finishedAt: toIso(lastRun.finished_at), error: lastRun.error ? lastRun.error.slice(0, 200) : null } : null,
    work: { activeProjects: work?.active_projects ?? 0, outputs: work?.outputs ?? 0 },
    relevance: scoreRelevance(verified.items, collections),
    workstreams: WORKSTREAMS.map((ws) => ({ ...ws, ...workstreamAvailability(ws, byId) })),
  };
}

export const EVIDENCE_PAGE_MAX = 50;

/** Marka kapsamlı, sayfalı kanıt listesi. Aynı sayfadaki tekrar eden adresler tek kayda indirilir ve sayısı raporlanır. */
export async function listPrEvidence(
  brandId: string,
  opts: { page?: number; pageSize?: number; verification?: Verification | null } = {},
  db: Queryable = getPool(),
) {
  const pageSize = Math.max(1, Math.min(EVIDENCE_PAGE_MAX, Math.trunc(opts.pageSize ?? 20) || 20));
  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const verification = opts.verification && ["verified", "unverified", "rejected"].includes(opts.verification) ? opts.verification : null;
  const [rows, count] = await Promise.all([
    q<SourceRow>(
      `SELECT id, url, title, excerpt, verification, created_at FROM research_sources
       WHERE brand_id = $1 AND ($2::text IS NULL OR verification = $2)
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [brandId, verification, pageSize, (page - 1) * pageSize],
      db,
    ),
    q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM research_sources WHERE brand_id = $1 AND ($2::text IS NULL OR verification = $2)`, [brandId, verification], db),
  ]);
  const { items, duplicates } = dedupeEvidence(rows.map(toEvidence));
  const total = count?.n ?? 0;
  return { items, duplicatesHidden: duplicates, page, pageSize, total, hasMore: page * pageSize < total };
}
