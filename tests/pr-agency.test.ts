import { describe, it, expect, beforeAll, vi } from "vitest";
import { q } from "@/lib/db/pool";
import { createBrand, addBrandFact } from "@/lib/services/brands";
import { decide, pendingApprovals } from "@/lib/services/outputs";
import { executeExternalAction, ApprovalRequiredError } from "@/lib/services/gateway";
import {
  PR_AGENT, PR_KINDS, PrConfigError, brandKnowledge, generateDue, getTrendItems, listFeedHealth, listPrOutputs, mergeItems, pollFeeds, runPrAgencyTick, updatePrConfig,
} from "@/lib/services/pr-agency";

// PR ajansı servisi (gerçek PostgreSQL). Ağ çağrısı yok: besleme çekimi sahte fetch ile test edilir.

const NOW = new Date("2026-10-26T15:00:00Z"); // Pazartesi
const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toUTCString();
const noFetch = vi.fn(async () => {
  throw new Error("network must not be called");
});

let a: string;
let aName: string;
let b: string;

beforeAll(async () => {
  aName = `Beeline${Date.now().toString(36)}`;
  a = (await createBrand({ name: aName })).id;
  b = (await createBrand({ name: `PR Other ${Date.now()}` })).id;
});

function rss(items: { title: string; link: string; pub?: string; desc?: string }[]) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link>${i.pub ? `<pubDate>${i.pub}</pubDate>` : ""}<description>${i.desc ?? ""}</description></item>`)
    .join("")}</channel></rss>`;
}

describe("PR ajansı: yapılandırma ve marka yalıtımı", () => {
  it("bilinmeyen kaynak, kaynaksız doğrulanmış tarih ve kaynaksız ölçüm reddedilir", async () => {
    await expect(updatePrConfig(a, { enabledSources: ["scraper-x"] })).rejects.toThrow(PrConfigError);
    await expect(updatePrConfig(a, { verifiedDates: { "anime-expo": { date: "2027-07-02", sourceUrl: "" } } })).rejects.toThrow(/kaynak adresi/);
    await expect(updatePrConfig(a, { measuredMetrics: [{ key: "instagram_followers", value: 10, measuredAt: "2026-10-01", source: "" }] })).rejects.toThrow(/kaynak gerekli/);
    await expect(updatePrConfig("00000000-0000-0000-0000-000000000000", { enabled: true })).rejects.toThrow(/Marka bulunamadı/);
  });

  it("marka bilgisi yalnızca doğrulanmış kaynaklardan; taahhüt yalnızca doğrulanmış kayıttan", async () => {
    await addBrandFact(a, { kind: "fact", statement: "We pledge 1% to a pollinator charity (signed 2026)", status: "unverified" });
    let k = await brandKnowledge(a);
    expect(k.verifiedCommitments).toEqual([]);
    await addBrandFact(a, { kind: "fact", statement: "Signed pledge with Hive Trust for 2027", status: "verified", source: "contract" });
    k = await brandKnowledge(a);
    expect(k.verifiedCommitments.map((c) => c.title)).toEqual(["Signed pledge with Hive Trust for 2027"]);
    expect((await brandKnowledge(b)).verifiedCommitments).toEqual([]);
  });
});

describe("PR ajansı: eksik besleme ve zamanlanmış üretim", () => {
  it("kaynak bağlı değilse ağ çağrısı yok; sağlık 'unconnected'", async () => {
    await updatePrConfig(a, { enabled: true, collections: [{ name: "Hive Hoodies", keywords: ["bee", "hoodies", "streetwear"], sourceRef: "owner" }] });
    const r = await pollFeeds(a, { now: NOW, fetchImpl: noFetch });
    expect(r).toEqual([]);
    expect(noFetch).not.toHaveBeenCalled();
    expect((await listFeedHealth(a, NOW, {})).every((f) => f.status === "unconnected")).toBe(true);
  });

  it("vadesi gelen raporlar ve hazırlık penceresindeki etkinlik planları üretilir; tekrar çalıştırmak çoğaltmaz", async () => {
    const created = await generateDue(a, { now: NOW, env: {} });
    const kinds = created.map((c) => c.kind);
    expect(kinds).toContain(PR_KINDS.daily_brief);
    expect(kinds).toContain(PR_KINDS.weekly_report);
    expect(kinds).toContain(PR_KINDS.monthly_presentation);
    expect(kinds).toContain(PR_KINDS.event_plan);
    expect(kinds).not.toContain(PR_KINDS.alert); // canlı veri yok → bayrak yok
    expect(await generateDue(a, { now: NOW, env: {} })).toEqual([]);
    expect(await generateDue(a, { now: new Date("2026-10-26T18:00:00Z"), env: {} })).toEqual([]);

    const outs = await listPrOutputs(a);
    const daily = outs.find((o) => o.kind === PR_KINDS.daily_brief)!;
    expect(daily.content).toMatchObject({ periodKey: "2026-10-26", dataStatus: "no_connected_sources" });
    expect(daily.content.insights.every((i: any) => i.role !== "trend_analyst")).toBe(true);
    const plan = outs.find((o) => o.kind === PR_KINDS.event_plan && o.content.eventId === "black-friday-2026")!;
    expect(plan.content.outreachDrafts.every((d: any) => d.status === "draft" && d.requiresOwnerApproval)).toBe(true);
    expect(plan.content.budgetProposal.status).toBe("proposal_not_committed");

    // Ertesi gün yalnızca yeni günlük özet
    const next = await generateDue(a, { now: new Date("2026-10-27T12:30:00Z"), env: {} });
    expect(next.filter((c) => c.kind !== PR_KINDS.event_plan).map((c) => c.kind)).toEqual([PR_KINDS.daily_brief]);
  });

  it("taslaklar mevcut onay kuyruğunda; başka marka göremez", async () => {
    const pending = await pendingApprovals(a);
    expect(pending.some((p) => p.agent === PR_AGENT)).toBe(true);
    expect((await pendingApprovals(b)).some((p) => p.agent === PR_AGENT)).toBe(false);
    expect(await listPrOutputs(b)).toEqual([]);
  });
});

describe("PR ajansı: onay kapısı", () => {
  it("onaylanan PR taslağı yalnızca 'content' kapsamı alır; yayın/reklam dış işlemi yine engellenir", async () => {
    const plan = (await listPrOutputs(a)).find((o) => o.kind === PR_KINDS.event_plan)!;
    const approval = await decide(a, plan.version_id, "approved", { scopes: ["publish", "ad_launch"] });
    expect(approval.scopes).toEqual(["content"]);
    for (const actionType of ["publish", "ad_launch"] as const) {
      await expect(executeExternalAction({ brandId: a, outputVersionId: plan.version_id, actionType, idempotencyKey: `pr-test-${actionType}-${Date.now()}` })).rejects.toThrow(ApprovalRequiredError);
    }
    const ext = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM external_actions WHERE brand_id = $1`, [a]);
    expect(ext[0].n).toBe(0);
  });

  it("başka markanın sürümü onaylanamaz", async () => {
    const plan = (await listPrOutputs(a)).find((o) => o.kind === PR_KINDS.event_plan && !o.approval)!;
    await expect(decide(b, plan.version_id, "approved")).rejects.toThrow(/Sürüm bulunamadı/);
  });
});

describe("PR ajansı: besleme köken, kota, hata ve bayat veri", () => {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("hypebeast")) return new Response(rss([
      { title: `${aName} faces backlash over counterfeit hoodies`, link: "https://hypebeast.com/x1?utm_source=rss", pub: h(1) },
      { title: "Bee print hoodies dominate streetwear drop season", link: "https://hypebeast.com/x2", pub: h(2) },
    ]), { status: 200 });
    return new Response(rss([
      { title: `Counterfeit ${aName} hoodies spark backlash online`, link: "https://highsnobiety.com/y1", pub: h(3) },
      { title: "Streetwear drop season: bee print hoodies dominate", link: "https://highsnobiety.com/y2", pub: h(4) },
    ]), { status: 200 });
  });

  it("etkin kaynak çekilir; kayıtlar kaynak/URL/zaman ile saklanır; aralık dolmadan tekrar çekilmez", async () => {
    await updatePrConfig(a, { enabledSources: ["hypebeast", "highsnobiety"] });
    const r = await pollFeeds(a, { now: NOW, fetchImpl, env: {} });
    expect(r.map((x) => [x.sourceId, x.status, x.items])).toEqual([["hypebeast", "fetched", 2], ["highsnobiety", "fetched", 2]]);
    const items = await getTrendItems(a);
    expect(items).toHaveLength(4);
    const first = items.find((i) => i.url.startsWith("https://hypebeast.com/x1"))!;
    expect(first).toMatchObject({ sourceId: "hypebeast", canonicalUrl: "https://hypebeast.com/x1", fetchedAt: NOW.toISOString(), region: "GLOBAL" });
    expect(first.publishedAt).not.toBeNull();
    expect(await getTrendItems(b)).toEqual([]);

    const again = await pollFeeds(a, { now: new Date(NOW.getTime() + 60_000), fetchImpl, env: {} });
    expect(again.every((x) => x.status === "skipped" && /interval/.test(x.reason!))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await listFeedHealth(a, NOW, {})).filter((f) => f.connected).map((f) => f.status)).toEqual(["healthy", "healthy"]);
  });

  it("taze veride kriz ve fırsat uyarıları koşullu olarak bir kez üretilir, kaynak bağlantılarıyla", async () => {
    const created = await generateDue(a, { now: new Date("2026-10-27T13:30:00Z"), env: {} });
    // 27 Ekim'in günlük özeti önceki testte üretildi → yeni rapor yok, uyarı da yok (uyarılar raporla birlikte oluşur)
    expect(created.filter((c) => c.kind === PR_KINDS.alert)).toEqual([]);
    // Taze veri: yeniden çekim (aynı haberler → pencereye tekrar eklenmez)
    await pollFeeds(a, { now: new Date("2026-10-28T12:00:00Z"), fetchImpl, env: {} });
    expect(await getTrendItems(a)).toHaveLength(4);
    const later = await generateDue(a, { now: new Date("2026-10-28T12:30:00Z"), env: {} });
    const alerts = later.filter((c) => c.kind === PR_KINDS.alert);
    expect(alerts.some((x) => x.title.startsWith("Crisis watch"))).toBe(true);
    const outs = await listPrOutputs(a);
    const crisis = outs.find((o) => o.kind === PR_KINDS.alert && o.content.type === "crisis_watch")!;
    expect(crisis.content.severity).toBe("critical");
    expect(crisis.content.sourceLinks.length).toBeGreaterThan(0);
    expect(crisis.content.recommendation).toMatch(/without owner approval/);
    const brief = outs.find((o) => o.kind === PR_KINDS.daily_brief && o.content.periodKey === "2026-10-28")!;
    expect(brief.content.dataStatus).toBe("fresh");
    expect(brief.content.flags.some((f: any) => f.type === "crisis_watch")).toBe(true);
    // Ertesi gün (taze veriyle) aynı küme için yeni uyarı yok
    await pollFeeds(a, { now: new Date("2026-10-29T12:00:00Z"), fetchImpl, env: {} });
    const dayAfter = await generateDue(a, { now: new Date("2026-10-29T12:30:00Z"), env: {} });
    expect(dayAfter.filter((c) => c.kind === PR_KINDS.alert && c.title.startsWith("Crisis watch"))).toEqual([]);
  });

  it("çekim hatası: art arda hata sayılır, hata metni saklanır, sağlık 'failing'; bayat veride trend içgörüsü yok", async () => {
    const failing = vi.fn(async () => new Response("nope", { status: 503 }));
    const t0 = new Date("2026-11-02T12:00:00Z");
    for (let i = 0; i < 3; i++) await pollFeeds(a, { now: new Date(t0.getTime() + i * 4 * 3_600_000), fetchImpl: failing, env: {} });
    const health = (await listFeedHealth(a, new Date(t0.getTime() + 9 * 3_600_000), {})).filter((f) => f.connected);
    expect(health.every((f) => f.status === "failing" && f.lastError === "HTTP 503")).toBe(true);
    const created = await generateDue(a, { now: new Date("2026-11-03T12:30:00Z"), env: {} });
    const daily = (await listPrOutputs(a)).find((o) => o.id === created.find((c) => c.kind === PR_KINDS.daily_brief)!.id)!;
    expect(daily.content.dataStatus).toBe("stale");
    expect(daily.content.insights.some((i: any) => i.role === "trend_analyst")).toBe(false);
  });

  it("trend penceresi: aynı kaynak+URL tekrar eklenmez, 8 günden eski kayıt atılır", async () => {
    const base = { sourceId: "hypebeast", title: "t", summary: "", region: "GLOBAL" as const, category: "fashion_streetwear" as const, confidence: 0.7 };
    const now = new Date("2026-12-01T00:00:00Z");
    const kept = await mergeItems(b, [
      { ...base, url: "https://x.com/1", canonicalUrl: "https://x.com/1", publishedAt: "2026-11-30T00:00:00Z", fetchedAt: now.toISOString() },
      { ...base, url: "https://x.com/1?utm_source=a", canonicalUrl: "https://x.com/1", publishedAt: "2026-11-30T00:00:00Z", fetchedAt: now.toISOString() },
      { ...base, url: "https://x.com/old", canonicalUrl: "https://x.com/old", publishedAt: "2026-11-01T00:00:00Z", fetchedAt: now.toISOString() },
    ], now);
    expect(kept.map((i) => i.canonicalUrl)).toEqual(["https://x.com/1"]);
  });

  it("işleyici adımı yalnızca zamanlaması açık markaları işler", async () => {
    const unavailable = vi.fn(async () => new Response("", { status: 503 }));
    const r = await runPrAgencyTick({ now: new Date("2026-11-03T13:00:00Z"), fetchImpl: unavailable, env: {} });
    expect(r.map((x) => x.brandId)).toContain(a);
    expect(r.map((x) => x.brandId)).not.toContain(b);
    expect(r.find((x) => x.brandId === a)!.error).toBeUndefined();
  });
});
