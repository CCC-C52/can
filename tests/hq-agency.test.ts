import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { uploadMedia, updateMediaMeta } from "@/lib/services/media";
import { productPhoto } from "./fixtures";
import {
  StrategyError, addStrategyItem, listStrategy, recordMeasurement, seedStrategy, strategyContext, strategySnapshot, updateStrategyItem,
} from "@/lib/services/strategy";
import { PHASES, ANNUAL, keyResultState, phaseAt, quarterOf, seedPlan, timelineProgress, weekOf } from "@/lib/pr-agency/strategy";
import { LibraryError, addLibraryEntry, libraryCounts, searchLibrary, seedLibrary, setLibraryVerification } from "@/lib/services/library";
import { LIBRARY_SEED } from "@/lib/pr-agency/library";
import { SPECIALISTS, specialistReadiness } from "@/lib/pr-agency/specialists";
import { AGENTS } from "@/lib/agents/registry";
import { PR_ROLES } from "@/lib/pr-agency/roles";
import { INTEGRATIONS, computeState, integrationDef } from "@/lib/integrations/registry";
import { ENDPOINTS, RUNWAY_API_VERSION, outcomeFor } from "@/lib/integrations/adapters";
import { IntegrationError, integrationCard, listIntegrations, navAwaiting, removeIntegration, saveCredentials, startSetup, testIntegration } from "@/lib/integrations/service";
import { NO_EVIDENCE, deriveStage, operationEvidence, requiredEvidence } from "@/lib/orchestrator/verification";
import { PR_KINDS, generateDue, listOperationRuns, recordOperationFailure, OP_MAX_ATTEMPTS, opBackoffMs } from "@/lib/services/pr-agency";
import { heroAsset, setHeroAsset, collectionsOverview, dashboardData } from "@/lib/services/hq";
import { NAV, NAV_GROUPS } from "@/lib/nav";

// FriBee HQ, PR ajansı stratejisi, bilgi kütüphanesi, Entegrasyon Merkezi ve yürütme doğrulaması.
// Gerçek PostgreSQL; ağ çağrısı YOK — sağlayıcılar sahte fetch ile taklit edilir (canlı entegrasyon başarısı değildir).

let brand: string;
let other: string;
const SECRET = "sk-live-SUPER-SECRET-value-123456";

beforeAll(async () => {
  brand = (await createBrand({ name: `FriBee HQ ${Date.now().toString(36)}` })).id;
  other = (await createBrand({ name: `Other HQ ${Date.now().toString(36)}` })).id;
});

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  });
  return { f, calls };
}

async function secretsLeaked(id: string) {
  const conn = await q1<{ config: unknown; last_error: string | null; credentials_encrypted: string | null }>(`SELECT config, last_error, credentials_encrypted FROM connections WHERE provider = $1 AND brand_id = $2`, [id, brand]);
  const audits = await q<{ message: string; data: unknown }>(`SELECT message, data FROM audit_log WHERE brand_id = $1`, [brand]);
  const hay = JSON.stringify(conn?.config ?? {}) + (conn?.last_error ?? "") + (conn?.credentials_encrypted ?? "") + JSON.stringify(audits);
  return hay.includes(SECRET);
}

describe("Strateji 2026–2034 (saf)", () => {
  it("beş aşama kesintisiz 2026–2034'ü kapsar; her yılın bir hedefi var", () => {
    expect(PHASES.map((p) => p.label)).toEqual(["2026–2027", "2027–2028", "2028–2030", "2030–2032", "2032–2034"]);
    for (let i = 1; i < PHASES.length; i++) {
      const prevEnd = new Date(`${PHASES[i - 1].end}T00:00:00Z`).getTime();
      expect(new Date(`${PHASES[i].start}T00:00:00Z`).getTime() - prevEnd).toBe(86_400_000);
    }
    expect(PHASES[0].start).toBe("2026-01-01");
    expect(PHASES.at(-1)!.end).toBe("2034-12-31");
    expect(ANNUAL.map((a) => a.year)).toEqual([2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034]);
    expect(phaseAt("2026-10-28")!.key).toBe("foundation_launch");
    expect(phaseAt("2031-03-01")!.key).toBe("national_growth");
    expect(phaseAt("2035-01-01")).toBeNull();
    expect(quarterOf("2026-10-28")).toMatchObject({ key: "2026-Q4", start: "2026-10-01", end: "2026-12-31" });
    expect(weekOf("2026-10-28")).toMatchObject({ key: "2026-W44", start: "2026-10-26", end: "2026-11-01" });
    expect(timelineProgress("2026-01-01")).toBe(0);
    expect(timelineProgress("2034-12-31")).toBe(1);
  });

  it("öneriler uydurma sayı veya geri dönüş anlatımı içermez; hedefler ölçüm olmadan sayıya bağlanmaz", () => {
    const text = JSON.stringify(seedPlan());
    expect(text).not.toMatch(/\b(comeback|relaunch|re-launch|rebirth|is back)\b/i);
    // Dolar tutarı, büyüme yüzdesi (+15% gibi) veya takipçi sayısı gibi uydurma rakam yok
    expect(text).not.toMatch(/\$\s?\d|\+\s?\d+(\.\d+)?%|\b\d+(k|m)? (followers|sales|customers)\b/i);
    for (const s of seedPlan()) for (const kr of s.keyResults) {
      expect(kr.baseline).toBeNull();
      expect(kr.current).toBeNull();
      expect(keyResultState(kr)).toBe("unmeasured");
    }
  });
});

describe("Strateji servisi (veritabanı)", () => {
  it("çerçeve yalnızca istenince ve bir kez oluşur; tümü öneri", async () => {
    expect((await strategySnapshot(brand)).created).toBe(false);
    const r = await seedStrategy(brand);
    expect(r.created).toBe(seedPlan().length);
    expect((await seedStrategy(brand)).created).toBe(0);
    const items = await listStrategy(brand);
    expect(items).toHaveLength(seedPlan().length);
    expect(items.every((i) => i.status === "proposed" && i.provenance === "ai_recommendation")).toBe(true);
    const annual2027 = items.find((i) => i.level === "annual" && i.period_key === "2027")!;
    expect(items.find((i) => i.id === annual2027.parent_id)!.title).toBe("Foundation and Launch");
    expect(await listStrategy(other)).toHaveLength(0);
  });

  it("düzenleme: geçmiş + gerekçe; içerik değişince kaynak 'sahip'; geri dönüş anlatımı reddedilir; marka yalıtımı", async () => {
    const it2026 = (await listStrategy(brand)).find((i) => i.seed_key === "annual:2026")!;
    const up = await updateStrategyItem(brand, it2026.id, { status: "approved" }, { reason: "Owner approved in planning call" });
    expect(up.status).toBe("approved");
    expect(up.provenance).toBe("ai_recommendation");
    const ed = await updateStrategyItem(brand, it2026.id, { title: "Build the launch foundation (owner edit)" });
    expect(ed.provenance).toBe("owner");
    const rev = await q<{ reason: string | null }>(`SELECT reason FROM strategy_item_revisions WHERE item_id = $1 ORDER BY created_at`, [it2026.id]);
    expect(rev.map((r) => r.reason)).toEqual(["Owner approved in planning call", null]);
    await expect(updateStrategyItem(brand, it2026.id, { body: "FriBee's big comeback year" })).rejects.toThrow(StrategyError);
    await expect(updateStrategyItem(other, it2026.id, { status: "done" })).rejects.toThrow(/bulunamadı/);
  });

  it("ölçüm kaynak ve tarih olmadan kaydedilmez; kaydedilince bağlama girer", async () => {
    const it2026 = (await listStrategy(brand)).find((i) => i.seed_key === "annual:2026")!;
    await expect(recordMeasurement(brand, it2026.id, 0, "baseline", { value: 3, measuredAt: "2026-10-20", source: "" })).rejects.toThrow(StrategyError);
    await expect(recordMeasurement(brand, it2026.id, 0, "baseline", { value: Number.NaN, measuredAt: "2026-10-20", source: "Metricool export" })).rejects.toThrow(StrategyError);
    const r = await recordMeasurement(brand, it2026.id, 0, "baseline", { value: 3, measuredAt: "2026-10-20", source: "Owner KPI sheet" });
    expect(r.key_results[0].baseline).toMatchObject({ value: 3, source: "Owner KPI sheet" });
    const ctx = await strategyContext(brand, new Date("2026-10-28T12:00:00Z"));
    expect(ctx.phase?.title).toBe("Foundation and Launch");
    expect(ctx.annual[0].keyResults[0]).toMatchObject({ state: "baseline_only", baseline: 3 });
    expect(ctx.measuredKpis).toBe(1);
    expect(ctx.nextAnnual[0].periodKey).toBe("2027");
  });

  it("yeni kalem dönem tarihlerini anahtardan hesaplar; aralık dışı ve geçersiz dönem reddedilir", async () => {
    const w = await addStrategyItem(brand, { level: "weekly", parentId: null, periodKey: "2026-10-28", title: "Approve holiday content plan" });
    expect(w).toMatchObject({ period_key: "2026-W44", period_start: "2026-10-26", period_end: "2026-11-01", provenance: "owner", status: "proposed" });
    const qk = await addStrategyItem(brand, { level: "quarterly", parentId: null, periodKey: "2028-Q3", title: "Community rituals" });
    expect(qk).toMatchObject({ period_start: "2028-07-01", period_end: "2028-09-30" });
    await expect(addStrategyItem(brand, { level: "quarterly", parentId: null, periodKey: "2035-Q1", title: "x" })).rejects.toThrow(StrategyError);
    await expect(addStrategyItem(brand, { level: "monthly", parentId: null, periodKey: "2026-13", title: "x" })).rejects.toThrow(StrategyError);
    await expect(addStrategyItem(brand, { level: "phase", parentId: null, periodKey: "2026", title: "x" })).rejects.toThrow(StrategyError);
    await expect(addStrategyItem(brand, { level: "annual", parentId: null, periodKey: "2027", title: "Our relaunch" })).rejects.toThrow(StrategyError);
  });
});

describe("Bilgi kütüphanesi", () => {
  it("çerçeveler kaynaklı ve bir kez eklenir; özetler kısa; DOI'li kaynaklar doğrulandı olarak işaretli", async () => {
    const r = await seedLibrary(brand);
    expect(r.created).toBe(LIBRARY_SEED.length);
    expect((await seedLibrary(brand)).created).toBe(0);
    expect((await libraryCounts(brand)).framework).toBe(LIBRARY_SEED.length);
    for (const e of LIBRARY_SEED) {
      expect(e.summary.length).toBeLessThan(500);
      expect(e.sourceUrl || e.sourceRef || e.sourceTitle).toBeTruthy();
      if (e.verification === "verified") expect(e.sourceUrl).toMatch(/^https:\/\/doi\.org\//);
    }
    const titles = LIBRARY_SEED.map((e) => e.title).join(" | ");
    for (const t of ["AMEC Integrated Evaluation Framework", "Barcelona Principles 4.0", "STP", "Keller", "Integrated Marketing Communications", "Consumer behaviour", "Fashion marketing", "Cultural branding", "reputation", "Situational Crisis Communication", "positioning", "Media relations measurement"]) {
      expect(titles.toLowerCase()).toContain(t.toLowerCase());
    }
  });

  it("arama, tür ayrımı ve doğrulama kuralları (AI önerisi doğrulanamaz)", async () => {
    expect((await searchLibrary(brand, { q: "crisis" })).map((e) => e.slug)).toContain("scct-crisis-communication");
    expect(await searchLibrary(brand, { q: "100%_" })).toEqual([]);
    expect(await searchLibrary(other, { q: "crisis" })).toEqual([]);
    await expect(addLibraryEntry(brand, { kind: "external_research", category: "Trends", title: "Gorpcore report", summary: "A report about outdoor fashion trends." })).rejects.toThrow(LibraryError);
    const ai = await addLibraryEntry(brand, { kind: "ai_recommendation", category: "Campaign idea", title: "Bee day pop-up", summary: "Idea: a pop-up on World Bee Day (proposal)." });
    expect(ai.verification).toBe("needs_review");
    await expect(setLibraryVerification(brand, ai.id, "verified", "looks right")).rejects.toThrow(/AI önerisi/);
    const ext = await addLibraryEntry(brand, { kind: "external_research", category: "Trends", title: "Streetwear survey", summary: "Survey of streetwear purchase drivers.", sourceUrl: "https://example.org/survey" });
    await expect(setLibraryVerification(brand, ext.id, "verified", "")).rejects.toThrow(LibraryError);
    await setLibraryVerification(brand, ext.id, "verified", "Checked publisher page 2026-10-28");
    const rev = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pr_library_revisions WHERE entry_id = $1`, [ext.id]);
    expect(rev[0].n).toBe(2);
  });
});

describe("AI PR uzman kadrosu", () => {
  it("dokuz uzman mevcut ajanlara/rollere eşlenir; paralel ajan yok", () => {
    expect(SPECIALISTS.map((s) => s.id)).toEqual(["pr_director", "brand_strategy", "market_intelligence", "media_relations", "influencer_relations", "creative_director", "social_media", "ecommerce_intelligence", "pr_measurement"]);
    const roleIds = new Set(PR_ROLES.map((r) => r.id));
    for (const s of SPECIALISTS) {
      for (const a of s.engineAgents) expect(AGENTS[a]).toBeDefined();
      for (const r of s.prRoles) expect(roleIds.has(r)).toBe(true);
      for (const i of s.integrations) expect(integrationDef(i)).toBeDefined();
    }
    const md = SPECIALISTS.find((s) => s.id === "media_relations")!;
    expect(specialistReadiness(md, new Set()).state).toBe("internal_only");
    expect(specialistReadiness(SPECIALISTS.find((s) => s.id === "pr_measurement")!, new Set(["metricool"])).state).toBe("partial");
    expect(specialistReadiness(SPECIALISTS[0], new Set()).state).toBe("ready");
  });
});

describe("Entegrasyon Merkezi (sahte sağlayıcı)", () => {
  it("altı sağlayıcı; resmî test yoksa (Muck Rack) uydurma uç nokta yok", () => {
    expect(INTEGRATIONS.map((i) => i.id)).toEqual(["brandwatch", "muck_rack", "metricool", "runway", "adobe", "shopify"]);
    expect(integrationDef("muck_rack")!.test).toBeNull();
    for (const d of INTEGRATIONS) expect(d.docs.length).toBeGreaterThan(0);
    expect(Object.values(ENDPOINTS).every((u) => u.startsWith("https://"))).toBe(true);
    expect(outcomeFor(200)).toBe("success");
    expect(outcomeFor(401)).toBe("auth_error");
    expect(outcomeFor(403)).toBe("forbidden");
    expect(outcomeFor(429)).toBe("transient");
    expect(outcomeFor(503)).toBe("transient");
    expect(outcomeFor(404)).toBe("error");
  });

  it("durum hesabı: doğrulandı ancak başarılı gerçek testten sonra", () => {
    const d = integrationDef("runway")!;
    expect(computeState(d, { hasRecord: false, hasCredentials: false, meta: {} })).toBe("not_configured");
    expect(computeState(d, { hasRecord: true, hasCredentials: false, meta: { setupStartedAt: "2026-10-28" } })).toBe("awaiting_credentials");
    expect(computeState(d, { hasRecord: true, hasCredentials: true, meta: {} })).toBe("connected");
    expect(computeState(d, { hasRecord: true, hasCredentials: true, meta: { lastOutcome: "success" } })).toBe("connected");
    expect(computeState(d, { hasRecord: true, hasCredentials: true, meta: { lastOutcome: "success", verifiedAt: "2026-10-28" } })).toBe("verified");
    expect(computeState(d, { hasRecord: true, hasCredentials: true, meta: { lastOutcome: "transient", verifiedAt: "2026-10-28" } })).toBe("degraded");
    expect(computeState(d, { hasRecord: true, hasCredentials: true, meta: { lastOutcome: "transient" } })).toBe("error");
    expect(computeState(d, { hasRecord: true, hasCredentials: true, meta: { lastOutcome: "forbidden" } })).toBe("blocked");
    expect(computeState(d, { hasRecord: true, hasCredentials: true, meta: { lastOutcome: "success", verifiedAt: "x", tokenExpiresAt: "2020-01-01T00:00:00Z" } })).toBe("error");
    expect(computeState(integrationDef("muck_rack")!, { hasRecord: true, hasCredentials: true, meta: {} })).toBe("blocked");
  });

  it("başlangıç: yapılandırılmadı → kurulum başlatılınca kimlik bekleniyor; Shopify ortam değişkeni yoksa yapılandırılmadı", async () => {
    expect((await integrationCard(brand, "runway")).state).toBe("not_configured");
    await startSetup(brand, "runway");
    expect((await integrationCard(brand, "runway")).state).toBe("awaiting_credentials");
    expect((await integrationCard(brand, "shopify")).state).toBe("not_configured");
    expect((await integrationCard(other, "runway")).state).toBe("not_configured");
    expect(await navAwaiting(brand)).toEqual(expect.arrayContaining(["/is/e-ticaret", "/pr-ajansi/medya-iliskileri"]));
  });

  it("Runway: şifreli saklanır, resmî salt okunur uç nokta + sürüm başlığı; 401 hata; 429 doğrulanmışsa kısıtlı", async () => {
    await saveCredentials(brand, "runway", { apiKey: SECRET });
    expect((await integrationCard(brand, "runway")).state).toBe("connected");
    let status = 200;
    const { f, calls } = fakeFetch(() => (status === 200 ? { status, body: { creditBalance: 5000, tier: { maxMonthlyCreditSpend: 1 } } } : { status, body: { error: "nope" } }));
    const ok = await testIntegration(brand, "runway", { fetchImpl: f });
    expect(ok.ok).toBe(true);
    expect(ok.state).toBe("verified");
    expect(calls[0].url).toBe("https://api.dev.runwayml.com/v1/organization");
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>)["X-Runway-Version"]).toBe(RUNWAY_API_VERSION);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect((await integrationCard(brand, "runway")).meta.usage).toEqual({ creditBalance: 5000 });
    status = 429;
    expect((await testIntegration(brand, "runway", { fetchImpl: f })).state).toBe("degraded");
    status = 401;
    const bad = await testIntegration(brand, "runway", { fetchImpl: f });
    expect(bad.ok).toBe(false);
    expect(bad.state).toBe("error");
    expect(await secretsLeaked("runway")).toBe(false);
  });

  it("Metricool: X-Mc-Auth + userId; blogId listede değilse hata, varsa doğrulandı", async () => {
    await saveCredentials(brand, "metricool", { userToken: SECRET, userId: "123", blogId: "456" });
    let list: unknown[] = [{ id: 999, label: "Someone else" }];
    const { f, calls } = fakeFetch(() => ({ status: 200, body: list }));
    expect((await testIntegration(brand, "metricool", { fetchImpl: f })).state).toBe("error");
    expect(calls[0].url).toBe("https://app.metricool.com/api/admin/simpleProfiles?userId=123");
    expect((calls[0].init.headers as Record<string, string>)["X-Mc-Auth"]).toBe(SECRET);
    list = [{ id: 456, label: "FriBee" }];
    const r = await testIntegration(brand, "metricool", { fetchImpl: f });
    expect(r.state).toBe("verified");
    expect((await integrationCard(brand, "metricool")).meta.account).toMatchObject({ blogId: "456", brand: "FriBee" });
    await expect(saveCredentials(brand, "metricool", { userToken: "x", userId: "abc", blogId: "1" })).rejects.toThrow(IntegrationError);
    expect(await secretsLeaked("metricool")).toBe(false);
  });

  it("Brandwatch: parola saklanmaz, yalnızca belirteç; resmî belirteç isteği biçimi; süre takibi", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 200, body: { access_token: "bw-token-abcdefghijklmnop", expires_in: 31536000 } }));
    const r = await saveCredentials(brand, "brandwatch", { username: "api@fribee.example", password: SECRET }, { fetchImpl: f });
    expect(r.state).toBe("verified");
    const u = new URL(calls[0].url);
    expect(`${u.origin}${u.pathname}`).toBe(ENDPOINTS.brandwatchToken);
    expect(u.searchParams.get("grant_type")).toBe("api-password");
    expect(u.searchParams.get("client_id")).toBe("brandwatch-api-client");
    expect(String(calls[0].init.body)).toBe(new URLSearchParams({ password: SECRET }).toString());
    const card = await integrationCard(brand, "brandwatch");
    expect(card.meta.tokenExpiresAt).toBeTruthy();
    expect(card.config.username).toBe("api@fribee.example");
    expect(await secretsLeaked("brandwatch")).toBe(false);
    const { connectionCredentials, getConnection } = await import("@/lib/services/connections");
    const creds = connectionCredentials<Record<string, string>>(await getConnection("brandwatch", brand));
    expect(creds).toEqual({ accessToken: "bw-token-abcdefghijklmnop" });
  });

  it("Adobe: client_credentials ile IMS; 403 engelli; Muck Rack test edilemez ve engelli kalır", async () => {
    await saveCredentials(brand, "adobe", { clientId: "client-123", clientSecret: SECRET, scopes: "openid,AdobeID,read_organizations" });
    let status = 403;
    const { f, calls } = fakeFetch(() => (status === 200 ? { status, body: { access_token: "x".repeat(20), expires_in: 86399 } } : { status, body: { error: "forbidden" } }));
    expect((await testIntegration(brand, "adobe", { fetchImpl: f })).state).toBe("blocked");
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(calls[0].url).toBe(ENDPOINTS.adobeImsToken);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("openid,AdobeID,read_organizations");
    status = 200;
    expect((await testIntegration(brand, "adobe", { fetchImpl: f })).state).toBe("verified");
    expect(await secretsLeaked("adobe")).toBe(false);

    await saveCredentials(brand, "muck_rack", { apiKey: SECRET });
    expect((await integrationCard(brand, "muck_rack")).state).toBe("blocked");
    const noNet = vi.fn();
    await expect(testIntegration(brand, "muck_rack", { fetchImpl: noNet as never })).rejects.toThrow(IntegrationError);
    expect(noNet).not.toHaveBeenCalled();
    await removeIntegration(brand, "muck_rack");
    expect((await integrationCard(brand, "muck_rack")).hasCredentials).toBe(false);
    expect(await secretsLeaked("muck_rack")).toBe(false);
  });

  it("liste ve doğrulanmış küme; ağ hatası geçici sayılır", async () => {
    const cards = await listIntegrations(brand);
    expect(cards.map((c) => c.def.id)).toHaveLength(6);
    const down = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const r = await testIntegration(brand, "adobe", { fetchImpl: down as never });
    expect(r.ok).toBe(false);
    expect(r.state).toBe("degraded");
  });
});

describe("Gerçek yürütme ve doğrulama", () => {
  const ev = (o: Partial<typeof NO_EVIDENCE>) => ({ ...NO_EVIDENCE, ...o });
  it("gereken kanıt türü", () => {
    expect(requiredEvidence({ kind: "render", agent: "video" })).toBe("playable_media");
    expect(requiredEvidence({ kind: "work", agent: "social", requires_capability: "social_publish_instagram" })).toBe("publish_confirmation");
    expect(requiredEvidence({ kind: "report", agent: "manager" })).toBe("saved_report");
    expect(requiredEvidence({ kind: "work", agent: "marketing" })).toBe("saved_output");
  });

  it("metin/JSON/plan kanıt değildir: video görevi MP4 olmadan tamamlanmış sayılmaz", () => {
    const planOnly = deriveStage({ status: "completed", kind: "render", agent: "video" }, ev({ savedVersions: 1 }));
    expect(planOnly.stage).toBe("output_produced");
    expect(planOnly.evidenceMissing).toBe(true);
    const real = deriveStage({ status: "completed", kind: "render", agent: "video" }, ev({ savedVersions: 1, verifiedVideos: 2 }));
    expect(real.stage).toBe("completed");
    expect(real.reached).toEqual(["plan_created", "task_scheduled", "execution_started", "output_produced", "output_verified", "completed"]);
    const called = deriveStage({ status: "running", kind: "work", agent: "video", requires_capability: "video_generation" }, ev({ providerJobs: [{ status: "running" }] }));
    expect(called.stage).toBe("external_service_called");
  });

  it("yayın görevi platform onayı (dış kimlik) olmadan başarılı değildir", () => {
    const t = { status: "completed", kind: "work", agent: "social", requires_capability: "social_publish_instagram" };
    expect(deriveStage(t, ev({ savedVersions: 1, externalActions: [{ status: "succeeded", externalId: null }] })).evidenceMissing).toBe(true);
    expect(deriveStage(t, ev({ savedVersions: 1, externalActions: [{ status: "succeeded", externalId: "17890" }] })).stage).toBe("completed");
    expect(deriveStage({ ...t, status: "failed" }, ev({})).stage).toBe("failed");
    expect(deriveStage({ status: "planned", kind: "work", agent: "marketing" }, ev({})).stage).toBe("plan_created");
    expect(deriveStage({ status: "ready", kind: "work", agent: "marketing" }, ev({})).stage).toBe("task_scheduled");
  });

  it("operasyon kanıtı: kayıtlı rapor, sürüm ve dönem eşleşmesi", () => {
    expect(operationEvidence({ outputId: null, savedVersions: 0, periodKey: "2026-Q4", contentPeriodKey: null }).ok).toBe(false);
    expect(operationEvidence({ outputId: "x", savedVersions: 0, periodKey: "2026-Q4", contentPeriodKey: "2026-Q4" }).ok).toBe(false);
    expect(operationEvidence({ outputId: "x", savedVersions: 1, periodKey: "2026-Q4", contentPeriodKey: "2026-Q3" }).ok).toBe(false);
    expect(operationEvidence({ outputId: "x", savedVersions: 1, periodKey: "2026-Q4", contentPeriodKey: "2026-Q4" }).ok).toBe(true);
  });
});

describe("Sürekli PR operasyonları (işleyici)", () => {
  const NOW = new Date("2026-10-28T17:00:00Z"); // Çarşamba
  it("çeyreklik ve yıllık inceleme strateji verisiyle üretilir; her çalıştırma kanıtla 'tamamlandı'; ikinci tur üretmez", async () => {
    const created = await generateDue(brand, { now: NOW, env: {} });
    const kinds = created.map((c) => c.kind);
    for (const k of [PR_KINDS.daily_brief, PR_KINDS.weekly_report, PR_KINDS.monthly_presentation, PR_KINDS.quarterly_review, PR_KINDS.annual_review]) expect(kinds).toContain(k);
    const runs = await listOperationRuns(brand);
    for (const op of ["daily_brief", "weekly_report", "monthly_presentation", "quarterly_review", "annual_review"]) {
      const r = runs.find((x) => x.operation === op)!;
      expect(r.stage).toBe("completed");
      expect(r.output_id).toBeTruthy();
      expect(r.evidence).toMatchObject({ kind: "saved_report", savedVersions: 1 });
    }
    const qr = await q1<{ content: any }>(`SELECT v.content FROM outputs o JOIN output_versions v ON v.output_id = o.id WHERE o.brand_id = $1 AND o.kind = $2`, [brand, PR_KINDS.quarterly_review]);
    expect(qr!.content.periodKey).toBe("2026-Q4");
    const titles = qr!.content.sections.map((s: any) => s.title);
    expect(titles).toEqual(expect.arrayContaining(["Strategic review", "OKR evaluation", "Budget assessment", "Brand growth analysis"]));
    const okr = qr!.content.sections.find((s: any) => s.title === "OKR evaluation").bullets.join(" ");
    expect(okr).toMatch(/not measured yet/);
    const wk = await q1<{ content: any }>(`SELECT v.content FROM outputs o JOIN output_versions v ON v.output_id = o.id WHERE o.brand_id = $1 AND o.kind = $2`, [brand, PR_KINDS.weekly_report]);
    expect(wk!.content.sections.map((s: any) => s.title)).toEqual(["Campaign review", "Social content planning (next 14 days)", "Influencer opportunities", "Performance summary"]);
    expect(await generateDue(brand, { now: NOW, env: {} })).toEqual([]);
  });

  it("başarısız operasyon: hata ve artan bekleme; bekleme dolmadan yeniden üretilmez", async () => {
    expect(opBackoffMs(1)).toBe(5 * 60_000);
    expect(opBackoffMs(2)).toBe(15 * 60_000);
    expect(opBackoffMs(10)).toBe(6 * 3_600_000);
    const t = new Date("2026-10-29T13:00:00Z");
    await recordOperationFailure(other, "daily_brief", "2026-10-29", `boom ${SECRET}`, t);
    const r1 = (await listOperationRuns(other)).find((x) => x.operation === "daily_brief")!;
    expect(r1).toMatchObject({ stage: "failed", attempts: 1 });
    expect(r1.error).not.toContain(SECRET.slice(8));
    expect(new Date(r1.next_attempt_at!).getTime() - t.getTime()).toBe(5 * 60_000);
    const during = await generateDue(other, { now: new Date(t.getTime() + 60_000), env: {} });
    expect(during.map((c) => c.kind)).not.toContain(PR_KINDS.daily_brief);
    const after = await generateDue(other, { now: new Date(t.getTime() + 10 * 60_000), env: {} });
    expect(after.map((c) => c.kind)).toContain(PR_KINDS.daily_brief);
    expect((await listOperationRuns(other)).find((x) => x.operation === "daily_brief" && x.period_key === "2026-10-29")!.stage).toBe("completed");
    expect(OP_MAX_ATTEMPTS).toBe(5);
  });
});

describe("FriBee HQ ana ekran verileri", () => {
  it("kapak: doğrulanmış görsel yoksa yok; AI görseli kapak olamaz; sahip seçimi geçerli", async () => {
    expect(await heroAsset(brand)).toBeNull();
    const ai = await uploadMedia(brand, { buffer: await productPhoto("#222222"), filename: "ai.jpg" }, { origin: "ai_generated", vision: false });
    await expect(setHeroAsset(brand, ai.asset.id)).rejects.toThrow(/AI/);
    const real = await uploadMedia(brand, { buffer: await productPhoto("#111111", { bg: "#eeeeee" }), filename: "tee-front.jpg" }, { origin: "real_photo", vision: false });
    expect(await heroAsset(brand)).toBeNull(); // hak durumu bilinmiyor → otomatik seçilmez
    await updateMediaMeta(brand, real.asset.id, { rightsStatus: "owned" });
    expect((await heroAsset(brand))?.source).toBe("owned_photo");
    await setHeroAsset(brand, real.asset.id);
    expect(await heroAsset(brand)).toMatchObject({ id: real.asset.id, source: "owner" });
    await expect(setHeroAsset(other, real.asset.id)).rejects.toThrow();
  });

  it("koleksiyonlar ve gösterge verileri yalnızca kayıtlı veriden", async () => {
    const c = await collectionsOverview(brand);
    expect(c.themes.map((t) => t.label)).toEqual(["Space Alien", "Music", "Anime", "Save the Bee"]);
    expect(c.anyVerified).toBe(false);
    const d = await dashboardData(brand);
    expect(d.ops.completed).toBeGreaterThanOrEqual(5);
    expect(d.media.photos).toBeGreaterThanOrEqual(2);
    expect(d.budget.today).toBeNull();
  });
});

describe("Gezinme", () => {
  it("menü grupları yönergeye göre; bağlantılar benzersiz ve test edilen etiketler korunur", () => {
    expect(NAV_GROUPS.map((g) => g.title)).toEqual(["Genel bakış", "PR Ajansı", "Yaratıcı", "Marka", "İş", "Sistem"]);
    const hrefs = NAV.map((n) => n.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const l of ["AI Yönetici", "AI Ekibi", "Marka Yönetimi", "Araştırma Merkezi", "Görsel Stüdyosu", "Video Stüdyosu", "Kampanya Yönetimi", "Sosyal Medya", "Analitik", "Entegrasyonlar", "Marka Hafızası", "Onay Merkezi", "Sistem Durumu", "Maliyet Yönetimi", "Marka Bilgi Merkezi", "Drive Arşivi", "PR Ajansı"]) {
      expect(NAV.some((n) => n.label === l)).toBe(true);
    }
  });
});
