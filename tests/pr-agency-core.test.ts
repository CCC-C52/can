import { describe, it, expect } from "vitest";
import { observancesForYear, observedFor, rollingCalendar, thanksgiving, nthWeekday, lastWeekday, UNVERIFIED_CANDIDATES } from "@/lib/pr-agency/observances";
import { buildEventPlan, scoreThemeFit, EMPTY_KNOWLEDGE, type BrandKnowledge } from "@/lib/pr-agency/event-plan";
import {
  SOURCE_CATALOG, canonicalUrl, cleanText, clusterItems, feedHealth, fetchBlockedReason, parseFeed, scoreCluster, toTrendItem, velocity,
  type FeedState, type SourceDefinition, type TrendItem,
} from "@/lib/pr-agency/trends";
import { buildBriefing, dataStatus } from "@/lib/pr-agency/briefings";
import { PR_ROLES, dueReports, isoWeekKey, periodKey } from "@/lib/pr-agency/roles";
import { buildRoadmap } from "@/lib/pr-agency/roadmap";

// PR ajansı çekirdeği: saf modüller (ağ ve veritabanı yok).

const byId = (year: number) => Object.fromEntries(observancesForYear(year).map((o) => [o.id.replace(`-${year}`, ""), o]));

describe("ABD takvimi: federal tatil tarihleri (5 U.S.C. 6103)", () => {
  it("2026 tarihleri doğru", () => {
    const o = byId(2026);
    expect(o["new-years-day"].date).toBe("2026-01-01");
    expect(o["mlk-day"].date).toBe("2026-01-19");
    expect(o["washingtons-birthday"].date).toBe("2026-02-16");
    expect(o["memorial-day"].date).toBe("2026-05-25");
    expect(o["juneteenth"].date).toBe("2026-06-19");
    expect(o["independence-day"].date).toBe("2026-07-04");
    expect(o["labor-day"].date).toBe("2026-09-07");
    expect(o["columbus-day"].date).toBe("2026-10-12");
    expect(o["veterans-day"].date).toBe("2026-11-11");
    expect(o["thanksgiving"].date).toBe("2026-11-26");
    expect(o["christmas"].date).toBe("2026-12-25");
    expect(observancesForYear(2026).filter((x) => x.kind === "federal_holiday")).toHaveLength(11);
  });

  it("hafta sonuna denk gelen tatilin gözlemlenen günü (OPM): Cumartesi → Cuma, Pazar → Pazartesi; yıl sınırı", () => {
    expect(byId(2026)["independence-day"].observedDate).toBe("2026-07-03"); // Cumartesi
    expect(byId(2027)["independence-day"].observedDate).toBe("2027-07-05"); // Pazar
    expect(byId(2027)["christmas"].observedDate).toBe("2027-12-24");
    expect(byId(2027)["juneteenth"].observedDate).toBe("2027-06-18");
    expect(byId(2022)["new-years-day"].observedDate).toBe("2021-12-31");
    expect(byId(2026)["thanksgiving"].observedDate).toBeUndefined();
    expect(observedFor("2026-12-25")).toBe("2026-12-25");
  });

  it("kural yardımcıları ve ticari günler Şükran Günü'ne göre", () => {
    expect(thanksgiving(2027)).toBe("2027-11-25");
    expect(thanksgiving(2025)).toBe("2025-11-27");
    expect(nthWeekday(2026, 5, 0, 2)).toBe("2026-05-10"); // Anneler Günü
    expect(lastWeekday(2027, 5, 1)).toBe("2027-05-31");
    const o = byId(2026);
    expect(o["black-friday"].date).toBe("2026-11-27");
    expect(o["cyber-monday"].date).toBe("2026-11-30");
    expect(o["mothers-day"].date).toBe("2026-05-10");
    expect(o["fathers-day"].date).toBe("2026-06-21");
    expect(o["world-bee-day"].date).toBe("2026-05-20");
    expect(o["earth-day"].date).toBe("2026-04-22");
    expect(o["pride-month"]).toMatchObject({ date: "2026-06-01", endDate: "2026-06-30" });
  });

  it("resmî tarih ile ticari fırsat ayrımı; ticari günler resmî değil", () => {
    const o = byId(2026);
    expect(o["black-friday"]).toMatchObject({ kind: "commercial", dateIsOfficial: false });
    expect(o["back-to-school"]).toMatchObject({ kind: "commercial", dateIsOfficial: false });
    expect(o["world-bee-day"]).toMatchObject({ kind: "observance", dateIsOfficial: true, causeRelated: true });
    expect(o["thanksgiving"]).toMatchObject({ kind: "federal_holiday", dateIsOfficial: true });
    for (const e of observancesForYear(2026)) expect(e.sourceUrl).toMatch(/^https:\/\//);
  });

  it("organizatör tarihli etkinlikler tahmin edilmez; sahip doğrulayınca takvime girer", () => {
    const r = rollingCalendar("2026-10-26");
    expect(r.unverified.map((u) => u.id)).toEqual(UNVERIFIED_CANDIDATES.map((u) => u.id));
    expect(r.events.some((e) => e.id.startsWith("anime-expo"))).toBe(false);
    const v = rollingCalendar("2026-10-26", { "anime-expo": { date: "2027-07-02", endDate: "2027-07-05", sourceUrl: "https://www.anime-expo.org/" } });
    expect(v.events.find((e) => e.id === "anime-expo-2027")).toMatchObject({ date: "2027-07-02", requiresVerification: false });
    expect(v.unverified.some((u) => u.id === "anime-expo")).toBe(false);
    // Kaynaksız "doğrulama" kabul edilmez
    const bad = rollingCalendar("2026-10-26", { coachella: { date: "2027-04-10", sourceUrl: "not-a-url" } });
    expect(bad.unverified.some((u) => u.id === "coachella")).toBe(true);
  });

  it("yuvarlanan 12 ay: aralık sınırları ve sıralama", () => {
    const { events } = rollingCalendar("2026-10-26");
    expect(events[0].date! >= "2026-10-26" || (events[0].endDate ?? "") >= "2026-10-26").toBe(true);
    expect(events.every((e) => e.date! < "2027-10-26")).toBe(true);
    const dates = events.map((e) => e.date!);
    expect([...dates].sort()).toEqual(dates);
    const ids = events.map((e) => e.id);
    expect(ids).toContain("halloween-2026");
    expect(ids).toContain("black-friday-2026");
    expect(ids).toContain("world-bee-day-2027");
    expect(ids).not.toContain("halloween-2027");
    expect(ids).not.toContain("hispanic-heritage-month-2026"); // 15 Eki'de bitti
  });
});

const KNOWLEDGE: BrandKnowledge = {
  brandName: "FriBee",
  voice: ["Playful, optimistic, bee-positive"],
  collections: [{ name: "Hive Hoodies", keywords: ["bee", "pollinators", "streetwear"], sourceRef: "brand_fact:1" }],
  verifiedCommitments: [],
};

describe("Etkinlik planı", () => {
  const bee = observancesForYear(2027).find((e) => e.id === "world-bee-day-2027")!;

  it("tema uyumu: marka bilgisi yoksa 'unknown', varsa eşleşen koleksiyon", () => {
    expect(scoreThemeFit(bee, EMPTY_KNOWLEDGE).level).toBe("unknown");
    const fit = scoreThemeFit(bee, KNOWLEDGE);
    expect(fit.matchedCollections).toEqual(["Hive Hoodies"]);
    expect(["strong", "possible"]).toContain(fit.level);
  });

  it("hazırlık süreleri, onay son tarihi, taslak durumları, bütçe önerisi ve bilinmeyen KPI başlangıçları", () => {
    const p = buildEventPlan(bee, KNOWLEDGE);
    expect(p.leadTimeDays).toBe(90);
    expect(p.milestones[0]).toMatchObject({ key: "kickoff", date: "2027-02-19" });
    expect(p.approvalDeadline).toBe("2027-04-20");
    expect(p.approvalDeadline < p.eventDate).toBe(true);
    expect(p.milestones.map((m) => m.date)).toEqual([...p.milestones.map((m) => m.date)].sort());
    expect(p.outreachDrafts.every((d) => d.status === "draft" && d.requiresOwnerApproval)).toBe(true);
    expect(p.channelPlan.every((c) => c.requiresApproval)).toBe(true);
    expect(p.budgetProposal.status).toBe("proposal_not_committed");
    expect(p.kpis.every((k) => k.baseline === "unknown")).toBe(true);
    expect(p.postmortem.dueDate).toBe("2027-06-03");
  });

  it("sosyal amaçlı etkinlikte doğrulanmış taahhüt yoksa bağış/ortaklık iddiası yasak; ortaklık varsayılmaz", () => {
    const p = buildEventPlan(bee, KNOWLEDGE);
    const g = p.outreachDrafts[0].guardrails.join(" ");
    expect(g).toMatch(/do not mention donations/i);
    expect(g).toMatch(/Do not imply an existing partnership/);
    const all = p.outreachDrafts.map((d) => d.body).join(" ").toLowerCase();
    expect(all).not.toMatch(/donat|proceeds|partner with us|our partner/);
    const withCommit = buildEventPlan(bee, { ...KNOWLEDGE, verifiedCommitments: [{ title: "Hive restoration pledge 2027", sourceRef: "doc:9" }] });
    expect(withCommit.outreachDrafts[0].guardrails.join(" ")).toMatch(/Hive restoration pledge 2027/);
  });

  it("tarihi doğrulanmamış etkinlik planlanamaz", () => {
    const c = UNVERIFIED_CANDIDATES[0];
    expect(() => buildEventPlan({ ...c, date: null, endDate: null })).toThrow(/not verified/);
  });
});

const NOW = new Date("2026-10-26T15:00:00Z");
const def = (over: Partial<SourceDefinition> = {}): SourceDefinition => ({ ...SOURCE_CATALOG.find((s) => s.id === "hypebeast")!, ...over });
const state = (over: Partial<FeedState> = {}): FeedState => ({ sourceId: "hypebeast", enabled: true, lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, requestsToday: 0, requestsDay: null, ...over });

describe("Kaynaklar: bağlantı, sağlık, tazelik, kota", () => {
  it("katalogdaki hiçbir kaynak varsayılan olarak bağlı değil; durum 'unconnected'", () => {
    for (const s of SOURCE_CATALOG) {
      expect(feedHealth(s, undefined, NOW).status).toBe("unconnected");
      expect(fetchBlockedReason(s, undefined, NOW)).toMatch(/not connected/);
      expect(["publisher_feed", "official_api"]).toContain(s.compliance);
    }
  });

  it("eksik kimlik bilgisi, hiç çekilmemiş, sağlıklı, bayat, hatalı", () => {
    const api = SOURCE_CATALOG.find((s) => s.id === "youtube-data-api")!;
    expect(feedHealth(api, state({ sourceId: api.id }), NOW, {}).status).toBe("missing_credentials");
    expect(feedHealth(def(), state(), NOW).status).toBe("never_fetched");
    expect(feedHealth(def(), state({ lastSuccessAt: "2026-10-26T13:00:00Z" }), NOW)).toMatchObject({ status: "healthy", freshnessHours: 2 });
    expect(feedHealth(def(), state({ lastSuccessAt: "2026-10-24T13:00:00Z" }), NOW).status).toBe("stale");
    expect(feedHealth(def(), state({ lastSuccessAt: "2026-10-26T13:00:00Z", consecutiveFailures: 3, lastError: "HTTP 500" }), NOW).status).toBe("failing");
    expect(feedHealth(def(), state({ consecutiveFailures: 1 }), NOW).status).toBe("failing");
  });

  it("kota kapısı: en kısa aralık ve günlük istek bütçesi; API adaptörü yoksa engel", () => {
    expect(fetchBlockedReason(def(), state(), NOW)).toBeNull();
    expect(fetchBlockedReason(def(), state({ lastAttemptAt: "2026-10-26T14:30:00Z" }), NOW)).toMatch(/interval/);
    expect(fetchBlockedReason(def(), state({ requestsDay: "2026-10-26", requestsToday: 12 }), NOW)).toMatch(/budget/);
    expect(fetchBlockedReason(def(), state({ requestsDay: "2026-10-25", requestsToday: 12 }), NOW)).toBeNull();
    const api = SOURCE_CATALOG.find((s) => s.id === "youtube-data-api")!;
    expect(fetchBlockedReason(api, state({ sourceId: api.id }), NOW, { YOUTUBE_API_KEY: "k" })).toMatch(/not implemented/);
  });
});

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title><![CDATA[Bee-print hoodies are the streetwear drop of fall]]></title><link>https://example.com/a?utm_source=rss</link><pubDate>Mon, 26 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Pollinator graphics &amp; more&lt;/p&gt;&lt;script&gt;x&lt;/script&gt;</description></item>
<item><title>No link item</title></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
<item><title>Undated story</title><link>https://example.com/b</link></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom entry</title><link rel="alternate" href="https://example.org/x"/><published>2026-10-25T08:00:00Z</published><summary>Hello</summary></entry></feed>`;

describe("Besleme ayrıştırma ve köken", () => {
  it("RSS: CDATA/HTML temizlenir, http(s) olmayan veya bağlantısız kayıt atılır", () => {
    const items = parseFeed(RSS);
    expect(items.map((i) => i.link)).toEqual(["https://example.com/a?utm_source=rss", "https://example.com/b"]);
    expect(items[0].title).toBe("Bee-print hoodies are the streetwear drop of fall");
    expect(items[0].summary).toBe("Pollinator graphics & more x");
    expect(items[0].summary).not.toMatch(/[<>]/);
    expect(items[0].publishedAt).toBe("2026-10-26T10:00:00.000Z");
    expect(items[1].publishedAt).toBeNull();
  });

  it("Atom ayrıştırılır", () => {
    expect(parseFeed(ATOM)).toEqual([{ title: "Atom entry", link: "https://example.org/x", publishedAt: "2026-10-25T08:00:00.000Z", summary: "Hello" }]);
  });

  it("kanonik URL izleme parametrelerini atar; yön kontrol karakterleri temizlenir", () => {
    expect(canonicalUrl("https://WWW.Example.com/a/?utm_source=x&id=1#top")).toBe("https://example.com/a?id=1");
    expect(cleanText("A‮ title")).toBe("A title");
  });

  it("köken: kaynak, URL, yayın/çekim zamanı, bölge, güven; tarihsiz kayıtta güven düşük", () => {
    const [dated, undated] = parseFeed(RSS).map((r) => toTrendItem(r, def(), NOW));
    expect(dated).toMatchObject({ sourceId: "hypebeast", region: "GLOBAL", fetchedAt: NOW.toISOString(), publishedAt: "2026-10-26T10:00:00.000Z", canonicalUrl: "https://example.com/a" });
    expect(undated.confidence).toBeLessThan(dated.confidence);
  });
});

function item(over: Partial<TrendItem>): TrendItem {
  return { sourceId: "s1", url: "https://a.com/1", canonicalUrl: "https://a.com/1", title: "t", summary: "", publishedAt: NOW.toISOString(), fetchedAt: NOW.toISOString(), region: "US", category: "fashion_streetwear", confidence: 0.7, ...over };
}

describe("Tekilleştirme, hız, ilgi ve koşullu bayraklar", () => {
  const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
  const items = [
    item({ sourceId: "hypebeast", url: "https://a.com/1", canonicalUrl: "https://a.com/1", title: "Bee print hoodies dominate streetwear drop season", publishedAt: h(2) }),
    item({ sourceId: "highsnobiety", url: "https://b.com/9", canonicalUrl: "https://b.com/9", title: "Streetwear drop season: bee print hoodies dominate", publishedAt: h(5) }),
    item({ sourceId: "hypebeast", url: "https://a.com/1?utm_source=x", canonicalUrl: "https://a.com/1", title: "Bee print hoodies dominate streetwear drop season", publishedAt: h(2) }),
    item({ sourceId: "prdaily", url: "https://c.com/2", canonicalUrl: "https://c.com/2", title: "Crisis comms lessons from airline outage", publishedAt: h(30) }),
  ];

  it("aynı haber farklı kaynaklarda tek kümede; birebir tekrar sayılmaz; sıra bağımsız", () => {
    const c = clusterItems(items);
    expect(c).toHaveLength(2);
    const bee = c.find((x) => x.label.includes("Bee") || x.label.includes("bee"))!;
    expect(bee.items).toHaveLength(2);
    expect(bee.sources).toEqual(["highsnobiety", "hypebeast"]);
    expect(clusterItems([...items].reverse()).map((x) => x.items.length).sort()).toEqual([1, 2]);
  });

  it("hız: yeni / yükselen / soğuyan", () => {
    const [bee] = clusterItems(items.slice(0, 2));
    expect(velocity(bee, NOW).label).toBe("new");
    const older = clusterItems([item({ title: "x y z", publishedAt: h(48) }), item({ url: "https://a.com/2", canonicalUrl: "https://a.com/2", title: "x y z", publishedAt: h(72) })]);
    expect(velocity(older[0], NOW).label).toBe("cooling");
  });

  it("ilgi ve fırsat bayrağı yalnızca koşullar sağlanınca; kriz bayrağı yalnızca marka adı + kriz terimi", () => {
    const [bee] = clusterItems(items.slice(0, 2));
    const s = scoreCluster(bee, { now: NOW, brandName: "FriBee", collections: KNOWLEDGE.collections });
    expect(s.relevance.matchedCollections).toEqual(["Hive Hoodies"]);
    expect(s.flags).toContain("major_opportunity");
    expect(s.flags).not.toContain("crisis_watch");
    const single = scoreCluster(clusterItems([items[0]])[0], { now: NOW, brandName: "FriBee", collections: KNOWLEDGE.collections });
    expect(single.flags).not.toContain("major_opportunity"); // tek kaynak yetmez
    const generic = scoreCluster(clusterItems([item({ title: "Retailer faces boycott over recall" })])[0], { now: NOW, brandName: "FriBee", collections: [] });
    expect(generic.flags).toEqual([]);
    const crisis = scoreCluster(clusterItems([item({ title: "FriBee faces backlash over counterfeit claims" })])[0], { now: NOW, brandName: "FriBee", collections: [] });
    expect(crisis.flags).toContain("crisis_watch");
  });
});

describe("Raporlar: veri durumu, bayat veri, kaynak bağlantıları", () => {
  const healthy = feedHealth(def(), state({ lastSuccessAt: "2026-10-26T13:00:00Z" }), NOW);
  const stale = feedHealth(def(), state({ lastSuccessAt: "2026-10-20T13:00:00Z" }), NOW);
  const unconnected = feedHealth(def(), undefined, NOW);
  const cluster = scoreCluster(clusterItems([
    item({ sourceId: "hypebeast", title: "Bee print hoodies dominate streetwear drop season" }),
    item({ sourceId: "highsnobiety", url: "https://b.com/9", canonicalUrl: "https://b.com/9", title: "Streetwear drop season: bee print hoodies dominate" }),
  ])[0], { now: NOW, brandName: "FriBee", collections: KNOWLEDGE.collections });
  const upcoming = rollingCalendar("2026-10-26").events.slice(0, 6).map((event) => ({ event, approvalDeadline: buildEventPlan(event).approvalDeadline }));
  const base = { kind: "daily_brief" as const, periodKey: "2026-10-26", now: NOW, brandName: "FriBee", upcoming, pendingApprovals: 2 };

  it("bağlı kaynak yoksa canlı kapsama üretilmez; yalnızca takvim önerileri", () => {
    const b = buildBriefing({ ...base, feeds: [unconnected], clusters: [cluster] });
    expect(b.dataStatus).toBe("no_connected_sources");
    expect(b.insights.every((i) => i.role !== "trend_analyst")).toBe(true);
    expect(b.flags).toEqual([]);
    expect(b.dataStatusNote).toMatch(/no live coverage/i);
  });

  it("bayat veride trend içgörüsü saklanır ve risk olarak raporlanır", () => {
    const b = buildBriefing({ ...base, feeds: [stale], clusters: [cluster] });
    expect(b.dataStatus).toBe("stale");
    expect(b.insights.some((i) => i.role === "trend_analyst")).toBe(false);
    expect(b.risks.join(" ")).toMatch(/none has fresh data/);
  });

  it("taze veride her içgörünün kaynak bağlantısı, güveni, efor ve maliyet aralığı var; tümü onay gerektirir", () => {
    const b = buildBriefing({ ...base, feeds: [healthy, unconnected], clusters: [cluster] });
    expect(dataStatus([healthy, unconnected]).status).toBe("fresh");
    const trend = b.insights.filter((i) => i.role === "trend_analyst");
    expect(trend).toHaveLength(1);
    for (const i of b.insights) {
      expect(i.sourceLinks.length).toBeGreaterThan(0);
      for (const l of i.sourceLinks) expect(l.url).toMatch(/^https?:\/\//);
      expect(i.confidence).toBeGreaterThan(0);
      expect(i.costRangeUsd[0]).toBeLessThanOrEqual(i.costRangeUsd[1]);
      expect(i.requiresApproval).toBe(true);
    }
    expect(b.flags.map((f) => f.type)).toEqual(["major_opportunity"]);
    expect(b.risks.join(" ")).toMatch(/2 item\(s\) waiting/);
  });

  it("aylık sunum slaytları; OKR başlangıcı ölçülmediyse 'unknown'", () => {
    const b = buildBriefing({ ...base, kind: "monthly_presentation", periodKey: "2026-10", feeds: [unconnected], clusters: [], roadmap: buildRoadmap("2026-10-01") });
    expect(b.slides?.map((s) => s.title)).toContain("Roadmap & OKRs");
    expect(b.slides!.find((s) => s.title === "Roadmap & OKRs")!.bullets.join(" ")).toMatch(/baseline unknown/);
  });
});

describe("Roller, zamanlama ve yol haritası", () => {
  it("roller dış gönderim/harcama yapamaz; zamanlanmış işler sahiplenilmiş", () => {
    expect(PR_ROLES.map((r) => r.id)).toEqual(["strategy_director", "trend_analyst", "social_listening_analyst", "media_relations", "creator_relations", "campaign_planner", "reputation_crisis", "performance_analyst"]);
    for (const r of PR_ROLES) {
      expect(r.canSendExternally).toBe(false);
      expect(r.canSpend).toBe(false);
    }
    const owned = PR_ROLES.flatMap((r) => r.ownsJobs);
    for (const k of ["daily_brief", "weekly_report", "monthly_presentation", "feed_poll", "trend_cluster", "calendar_refresh"]) expect(owned).toContain(k);
  });

  it("dönem anahtarları ve vadesi gelen raporlar (idempotent, telafi eder)", () => {
    expect(isoWeekKey(new Date("2026-10-26T00:00:00Z"))).toBe("2026-W44");
    expect(isoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(periodKey("monthly_presentation", NOW)).toBe("2026-10");
    // Pazartesi 15:00 UTC: günlük + haftalık vadeli; aylık bu ay için (1'inden sonra) telafi
    expect(dueReports(NOW, new Set()).map((d) => d.kind).sort()).toEqual(["daily_brief", "monthly_presentation", "weekly_report"]);
    expect(dueReports(NOW, new Set(["daily_brief:2026-10-26", "weekly_report:2026-W44", "monthly_presentation:2026-10"]))).toEqual([]);
    // Saatten önce günlük özet yok; Pazartesi saatinden önce haftalık yok
    expect(dueReports(new Date("2026-10-26T08:00:00Z"), new Set(["monthly_presentation:2026-10"]))).toEqual([]);
    expect(dueReports(new Date("2026-10-27T08:00:00Z"), new Set(["monthly_presentation:2026-10"])).map((d) => d.kind)).toEqual(["weekly_report"]);
  });

  it("24 ay, 8 çeyrek; ölçülmüş metrik kaynakla başlangıç olur, diğerleri 'unknown'", () => {
    const r = buildRoadmap("2026-11-15", [{ key: "instagram_followers", value: 1200, measuredAt: "2026-10-20", source: "Instagram insights export" }]);
    expect(r.quarters).toHaveLength(8);
    expect(r.start).toBe("2026-11-01");
    expect(r.end).toBe("2028-10-31");
    const kr = r.quarters[0].keyResults;
    expect(kr.find((k) => k.metric === "instagram_followers")!.baseline).toMatchObject({ value: 1200, source: "Instagram insights export" });
    expect(kr.find((k) => k.metric === "earned_mentions")!.baseline).toBe("unknown");
    expect(r.dataGaps).toHaveLength(4);
  });
});
