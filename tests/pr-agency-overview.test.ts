import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { listPrEvidence, prAgencyOverview } from "@/lib/services/pr-agency";
import { NAV } from "@/lib/nav";
import {
  FRIBEE_COLLECTIONS, PR_EXTERNAL_ACTIONS, PhantomMetricError, WORKSTREAMS, attributedMetric, classifyFreshness, classifySignal,
  collectionsFor, dedupeEvidence, findUnattributedMetrics, normalizeUrl, prActionAllowed, scoreRelevance, workstreamAvailability,
  type Evidence,
} from "@/lib/pr-agency/model";

// PR Ajansı salt okunur iskeleti. Dış çağrı yapılmaz; yalnızca mevcut, marka kapsamlı tablolar okunur.

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  id: over.id ?? Math.random().toString(36).slice(2), url: "https://example.com/a", title: null, excerpt: null,
  retrievedAt: "2026-10-20T00:00:00.000Z", connector: "research_firecrawl", verification: "verified", ...over,
});

describe("PR ajansı — tekilleştirme ve kaynak gösterimi", () => {
  it("izleme parametreleri, www, parça ve sondaki / tekilleştirme anahtarına girmez", () => {
    expect(normalizeUrl("https://WWW.Example.com/Post/?utm_source=x&b=2&a=1&fbclid=z#top")).toBe("https://example.com/Post?a=1&b=2");
    expect(normalizeUrl("http://example.com/post/")).toBe(normalizeUrl("https://example.com/post"));
    expect(normalizeUrl("not a url")).toBe("not a url");
  });

  it("aynı adresin kopyaları tek kayda iner; doğrulanmış olan tercih edilir ve sayı raporlanır", () => {
    const items = [
      ev({ id: "1", url: "https://example.com/p?utm_medium=a", verification: "unverified", retrievedAt: "2026-10-22T00:00:00Z" }),
      ev({ id: "2", url: "https://www.example.com/p", verification: "verified", retrievedAt: "2026-10-21T00:00:00Z" }),
      ev({ id: "3", url: "https://other.example/x" }),
    ];
    const r = dedupeEvidence(items);
    expect(r.items.map((i) => i.id)).toEqual(["2", "3"]);
    expect(r.duplicates).toBe(1);
  });
});

describe("PR ajansı — tazelik ve başarısız veri", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  it("hiç veri yoksa 'never', 7 günden eskiyse 'stale', yeniyse 'fresh'", () => {
    expect(classifyFreshness(null, { now })).toBe("never");
    expect(classifyFreshness("2026-10-24T00:00:00Z", { now })).toBe("fresh");
    expect(classifyFreshness("2026-10-10T00:00:00Z", { now })).toBe("stale");
  });
  it("son çalıştırma başarısızsa eski veri 'güncel' gösterilmez", () => {
    expect(classifyFreshness("2026-10-24T23:00:00Z", { now, lastRunStatus: "failed" })).toBe("failed");
  });
});

describe("PR ajansı — sinyal / spekülasyon ve ilgi puanı", () => {
  it("doğrulanmamış kaynaklar kanıt sayılmaz; doğrulanmış kanıt yoksa puan null (uydurulmaz)", () => {
    const r = scoreRelevance([ev({ verification: "unverified", title: "Anime merch boom" }), ev({ verification: "rejected", title: "anime" })], FRIBEE_COLLECTIONS);
    expect(r.score).toBeNull();
    expect(r.signal).toBe("speculation");
    expect(r.matched).toEqual([]);
  });

  it("tek alan adı 'zayıf sinyal', iki bağımsız alan adı 'sinyal'", () => {
    expect(classifySignal([ev({ url: "https://a.example/1" }), ev({ url: "https://www.a.example/2" })]).class).toBe("weak_signal");
    expect(classifySignal([ev({ url: "https://a.example/1" }), ev({ url: "https://b.example/2" })]).class).toBe("signal");
  });

  it("puan yalnızca doğrulanmış metindeki tam kelime eşleşmelerinden ve teyitten gelir; gerekçe ve kanıt kimliği döner", () => {
    const r = scoreRelevance([
      ev({ id: "e1", url: "https://a.example/1", title: "Save the bees campaign", excerpt: "pollinator week" }),
      ev({ id: "e2", url: "https://b.example/2", title: "Beef prices" }),
    ], FRIBEE_COLLECTIONS);
    expect(r.signal).toBe("signal");
    expect(r.matched).toEqual([{ collection: "Save the Bee", term: "bees", evidenceId: "e1" }]);
    expect(r.score).toBe(10 + 40);
    expect(r.basis.join(" ")).toMatch(/2 doğrulanmış kaynak/);
  });
});

describe("PR ajansı — kaynaksız metrik yok", () => {
  it("kaynak ve zaman olmadan metrik oluşturulamaz", () => {
    expect(() => attributedMetric(1000, null)).toThrow(PhantomMetricError);
    expect(() => attributedMetric(1000, { connector: "news_monitoring", observedAt: "dün" })).toThrow(PhantomMetricError);
    expect(attributedMetric(5, { connector: "news_monitoring", observedAt: "2026-10-25T00:00:00Z" }).value).toBe(5);
  });

  it("kaynaksız erişim/etkileşim/duygu/iletişim alanları yakalanır", () => {
    expect(findUnattributedMetrics({ a: { reach: 12000 }, list: [{ sentiment: "positive" }, { email: "x@y.z" }] })).toEqual(["$.a.reach", "$.list[0].sentiment", "$.list[1].email"]);
    expect(findUnattributedMetrics({ reach: { value: 1, source: { connector: "rss_feeds", observedAt: "2026-10-25T00:00:00Z" } }, followers: null })).toEqual([]);
  });
});

describe("PR ajansı — onay kapısı (taslak modu)", () => {
  it("hiçbir dış işlem yürütülemez; onay olsa bile yürütücü yok", () => {
    for (const a of PR_EXTERNAL_ACTIONS) {
      expect(prActionAllowed(a).allowed).toBe(false);
      expect(prActionAllowed(a).reason).toMatch(/ayrı onayı/);
      const withApproval = prActionAllowed(a, { approvalId: "x", scopes: [a] });
      expect(withApproval.allowed).toBe(false);
      expect(withApproval.reason).toMatch(/yürütücüsü yok/);
    }
    expect(prActionAllowed("transfer_money").allowed).toBe(false);
  });

  it("modül kodu e-posta, DM, yayın, mağaza, reklam veya ağ çağrısı yapan modülleri içe aktarmaz", () => {
    for (const f of ["src/lib/pr-agency/model.ts", "src/lib/services/pr-agency.ts", "src/app/(panel)/pr-ajansi/page.tsx"]) {
      const src = fs.readFileSync(path.resolve(f), "utf8");
      expect(src).not.toMatch(/adapters\/(instagram|shopify|images|video-generation|http)|services\/(gateway|media|provider-jobs)|runResearch|"use server"/);
    }
    // Tek ağ çağrısı: sahibin etkinleştirdiği halka açık RSS/Atom beslemesi (assertPublicUrl ile doğrulanmış adres)
    const svc = fs.readFileSync(path.resolve("src/lib/services/pr-agency.ts"), "utf8");
    expect(svc.match(/fetch\(/g)).toHaveLength(1);
    expect(svc).toMatch(/const url = assertPublicUrl\(def\.url\);\s+const res = await f\(url,/);
    for (const f of ["src/lib/pr-agency/model.ts", "src/app/(panel)/pr-ajansi/page.tsx"]) expect(fs.readFileSync(path.resolve(f), "utf8")).not.toMatch(/fetch\(/);
  });
});

describe("PR ajansı — çalışma alanları, koleksiyonlar ve gezinme", () => {
  it("altı çalışma alanı; bağlayıcı yoksa 'veri kaynağı yok', eksikler listelenir", () => {
    expect(WORKSTREAMS.map((w) => w.name)).toEqual(["Trend Intelligence", "Media Relations", "Influencer Relations", "Reputation / Crisis", "Campaign Strategy", "PR Analytics"]);
    const none = { research_firecrawl: "needs_credentials", rss_feeds: "not_built", news_monitoring: "not_built", social_listening: "not_built", influencer_discovery: "not_built", shopify_catalog: "needs_credentials" } as const;
    const trend = workstreamAvailability(WORKSTREAMS[0], none);
    expect(trend).toEqual({ level: "no_source", available: [], gaps: ["research_firecrawl", "rss_feeds"] });
    expect(workstreamAvailability(WORKSTREAMS[0], { ...none, research_firecrawl: "available" }).level).toBe("partial");
  });

  it("dört koleksiyon yalnızca FriBee markasına uygulanır (yazım: FriBee)", () => {
    expect(collectionsFor({ name: "FriBee", slug: "fribee" }).map((c) => `${c.name}:${c.color}`)).toEqual(["Space Alien:siyah", "Music:beyaz", "Anime:turuncu", "Save the Bee:açık mavi"]);
    expect(collectionsFor({ name: "Başka Marka", slug: "baska-marka" })).toEqual([]);
    for (const f of ["src/lib/pr-agency/model.ts", "src/app/(panel)/pr-ajansi/page.tsx", "docs/PR_AGENCY.md"]) {
      expect(fs.readFileSync(path.resolve(f), "utf8")).not.toMatch(/Fribee|FRIBee|Fri Bee|FriBEE/);
    }
  });

  it("gezinmede /pr-ajansi bağlantısı var; sayfa mobilde taşmayı önleyen duyarlı düzen kullanır", () => {
    // Menü verisi src/lib/nav.ts'te (istemci bileşeni bunu kullanır)
    expect(NAV.some((n) => n.href === "/pr-ajansi" && n.label === "PR Ajansı")).toBe(true);
    const page = fs.readFileSync(path.resolve("src/app/(panel)/pr-ajansi/page.tsx"), "utf8");
    expect(page).toMatch(/overflow-x-auto/);
    expect(page).toMatch(/grid-cols-2 gap-3 lg:grid-cols-4/);
    expect(page).toMatch(/break-all/);
    expect(fs.readFileSync(path.resolve("tests/http/a11y.ts"), "utf8")).toContain(`"/pr-ajansi"`);
  });
});

describe("PR ajansı — marka yalıtımı, kaynak gösterimi ve sayfalama (veritabanı)", () => {
  let A: { id: string; name: string; slug: string };
  let B: { id: string; name: string; slug: string };
  let F: { id: string; name: string; slug: string };

  async function source(brandId: string, url: string, verification: string, opts: { title?: string; at?: string; runStatus?: string } = {}) {
    const run = (await q1<{ id: string }>(`INSERT INTO research_runs (brand_id, mode, query, provider, status, created_at) VALUES ($1,'search','q','firecrawl',$2, COALESCE($3::timestamptz, now())) RETURNING id`, [brandId, opts.runStatus ?? "completed", opts.at ?? null]))!;
    return (await q1<{ id: string }>(
      `INSERT INTO research_sources (run_id, brand_id, url, title, verification, created_at) VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now())) RETURNING id`,
      [run.id, brandId, url, opts.title ?? null, verification, opts.at ?? null],
    ))!.id;
  }

  beforeAll(async () => {
    A = await createBrand({ name: `PR A ${Date.now()}` });
    B = await createBrand({ name: `PR B ${Date.now()}` });
    F = await createBrand({ name: `FriBee PR ${Date.now()}` });
    await source(B.id, "https://b-secret.example/x", "verified", { title: "B gizli kaynak" });
    for (let i = 0; i < 25; i++) await source(A.id, `https://a.example/post-${i}`, i % 5 === 0 ? "verified" : "unverified", { at: new Date(Date.UTC(2026, 9, 1, i)).toISOString() });
    await source(A.id, "https://a.example/post-24?utm_source=newsletter", "unverified", { at: new Date(Date.UTC(2026, 9, 1, 23, 30)).toISOString() });
  });

  it("A'nın genel bakışı ve kanıt listesi B kaydı içermez", async () => {
    const o = await prAgencyOverview(A, { now: new Date("2026-10-02T12:00:00Z") });
    const list = await listPrEvidence(A.id, { pageSize: 50 });
    const text = JSON.stringify([o, list]);
    expect(text).not.toContain("b-secret.example");
    expect(text).not.toContain("B gizli kaynak");
    expect(o.evidence.total).toBe(26);
    expect((await listPrEvidence(B.id)).items.map((i) => i.url)).toEqual(["https://b-secret.example/x"]);
  });

  it("her kanıt kaynak adresi, bağlayıcı, alım zamanı ve doğrulama durumu taşır", async () => {
    const { items } = await listPrEvidence(A.id, { pageSize: 5 });
    for (const e of items) {
      expect(e.url).toMatch(/^https:\/\/a\.example\//);
      expect(e.connector).toBe("research_firecrawl");
      expect(Number.isNaN(Date.parse(e.retrievedAt))).toBe(false);
      expect(["verified", "unverified", "rejected"]).toContain(e.verification);
    }
  });

  it("sayfalama: sınırlı sayfa boyutu, kararlı sıralama, filtre; aynı sayfadaki tekrarlar gizlenir ve raporlanır", async () => {
    const p1 = await listPrEvidence(A.id, { page: 1, pageSize: 10 });
    expect(p1).toMatchObject({ page: 1, pageSize: 10, total: 26, hasMore: true });
    // post-24 ve izleme parametreli kopyası ilk sayfada: biri gizlenir
    expect(p1.duplicatesHidden).toBe(1);
    expect(p1.items).toHaveLength(9);
    const p3 = await listPrEvidence(A.id, { page: 3, pageSize: 10 });
    expect(p3).toMatchObject({ hasMore: false });
    expect(p3.items).toHaveLength(6);
    expect((await listPrEvidence(A.id, { pageSize: 1000 })).pageSize).toBe(50);
    const verified = await listPrEvidence(A.id, { verification: "verified", pageSize: 50 });
    expect(verified.total).toBe(5);
    expect(verified.items.every((i) => i.verification === "verified")).toBe(true);
    expect((await listPrEvidence(A.id, { verification: "bogus" as any })).total).toBe(26);
  });

  it("tazelik: eski kanıt 'stale'; son çalıştırma başarısızsa 'failed'; hiç veri yoksa 'never'", async () => {
    expect((await prAgencyOverview(A, { now: new Date("2026-10-25T00:00:00Z") })).evidence.freshness).toBe("stale");
    expect((await prAgencyOverview(A, { now: new Date("2026-10-02T00:00:00Z") })).evidence.freshness).toBe("fresh");
    const empty = await createBrand({ name: `PR Boş ${Date.now()}` });
    const e = await prAgencyOverview(empty);
    expect(e.evidence).toMatchObject({ total: 0, freshness: "never", lastVerifiedAt: null });
    expect(e.relevance.score).toBeNull();
    await q(`INSERT INTO research_runs (brand_id, mode, query, provider, status, error, finished_at) VALUES ($1,'search','q','firecrawl','failed','Firecrawl 503', now())`, [A.id]);
    const failed = await prAgencyOverview(A, { now: new Date("2026-10-02T00:00:00Z") });
    expect(failed.evidence.freshness).toBe("failed");
    expect(failed.lastRun).toMatchObject({ status: "failed", error: "Firecrawl 503" });
  });

  it("bağlayıcı yokken durum açıkça 'kimlik bilgisi gerekli' / 'bu sürümde yok'; sahte 'canlı' kaynak yok", async () => {
    delete process.env.FIRECRAWL_API_KEY;
    const o = await prAgencyOverview(A);
    const st = Object.fromEntries(o.connectors.map((c) => [c.id, c.availability]));
    expect(st).toEqual({ research_firecrawl: "needs_credentials", rss_feeds: "not_built", news_monitoring: "not_built", social_listening: "not_built", influencer_discovery: "not_built", shopify_catalog: "needs_credentials" });
    expect(o.workstreams.every((w) => w.level === "no_source")).toBe(true);
    expect(JSON.stringify(o)).not.toMatch(/gerçek zamanlı|real-?time|live feed/i);
  });

  it("genel bakışta kaynaksız metrik ve gizli değer yok", async () => {
    process.env.FIRECRAWL_API_KEY = "fc-secret-should-not-appear";
    const o = await prAgencyOverview(F);
    expect(findUnattributedMetrics(o)).toEqual([]);
    expect(JSON.stringify(o)).not.toContain("fc-secret-should-not-appear");
    expect(o.collections).toHaveLength(4);
    expect((await prAgencyOverview(A)).collections).toEqual([]);
  });

  it("servis salt okunurdur: genel bakış ve liste hiçbir satırı değiştirmez", async () => {
    const snap = async () => (await q<{ n: string }>(`SELECT (SELECT COUNT(*) FROM research_sources)::text || '/' || (SELECT COUNT(*) FROM research_runs)::text || '/' || (SELECT COUNT(*) FROM audit_log)::text || '/' || (SELECT COUNT(*) FROM cost_entries)::text AS n`))[0].n;
    const before = await snap();
    await prAgencyOverview(A);
    await listPrEvidence(A.id, { page: 2 });
    expect(await snap()).toBe(before);
  });
});
