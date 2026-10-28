import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import path from "node:path";
import { AddressInfo } from "node:net";
import { AppApi, RenderApi } from "../scripts/release/render-api";
import { reportMarkdown, runRelease, type ReleaseInput } from "../scripts/release/orchestrate";

// Gerçek Render çağrısı yapılmaz: Render API ve canlı uygulama, yerel HTTP sunucularıyla taklit edilir.
// Dağıtım durumları her sorguda bir adım ilerler; saat simüledir (bekleme süresi kadar ileri alınır).

const SHA = "1".repeat(40);
const OLD = "9cb052e0000000000000000000000000000000aa";
const API_KEY = "rnd_test_key_should_never_appear";
const TOKEN = "release-token-should-never-appear-xxxxxxxx";
/** Bu sürümün imajındaki tüm geçişler (yeni sürüm canlıya çıkınca hepsi uygulanmış olur). */
const ALL_MIGRATIONS = ["001_init.sql", "002_media_jobs_integrity.sql", "003_brand_memory_research.sql", "004_drive_archive.sql", "005_brand_knowledge.sql", "006_pr_strategy_operations.sql"];

type Svc = { id: string; name: string; branch: string; autoDeployTrigger: string; suspended: string; repo: string };
type Dep = { id: string; status: string; commit: { id: string }; createdAt: string; script: string[] };

let render: http.Server, app: http.Server, renderUrl = "", appUrl = "";
let clock = 0;
const S: {
  services: Record<string, Svc>;
  deploys: Record<string, Dep[]>;
  scripts: Record<string, string[][]>;
  requests: string[];
  failNext: Record<string, number>;
  recovery: { recoveryStatus: string; startsAt?: string } | null;
  createdButFail: boolean;
  app: { legacy: false | "session401" | "missing404"; healthy: boolean; webCommit: string; applied: string[]; workerCommit: string | null; workerStuck: boolean; webCommitStuck: boolean; backupAt: string | null; releases: { releaseId: string; sha: string; outcome: string }[]; events: any[] };
} = {} as any;

function reset() {
  clock = 0;
  const svc = (id: string, name: string): Svc => ({ id, name, branch: "claude/amazing-goodall-qkxupd", autoDeployTrigger: "off", suspended: "not_suspended", repo: "https://github.com/CCC-C52/can" });
  Object.assign(S, {
    services: { "srv-web": svc("srv-web", "aiops-web"), "srv-worker": svc("srv-worker", "aiops-worker") },
    deploys: {
      "srv-web": [{ id: "dep-webold", status: "live", commit: { id: OLD }, createdAt: new Date(0).toISOString(), script: [] }],
      "srv-worker": [{ id: "dep-wrkold", status: "live", commit: { id: OLD }, createdAt: new Date(0).toISOString(), script: [] }],
    },
    scripts: { "srv-web": [["build_in_progress", "pre_deploy_in_progress", "update_in_progress", "live"]], "srv-worker": [["build_in_progress", "update_in_progress", "live"]] },
    requests: [],
    failNext: {},
    recovery: { recoveryStatus: "AVAILABLE", startsAt: "2026-10-15T00:00:00Z" },
    createdButFail: false,
    // Canlıdaki 9cb052e: /api/release/* yok; oturumsuz /api/* isteğine ara katman 401 {"error":"Oturum gerekli"} döner
    app: { legacy: "session401", healthy: true, webCommit: OLD, applied: ["001_init.sql", "002_media_jobs_integrity.sql"], workerCommit: OLD, workerStuck: false, webCommitStuck: false, backupAt: null, releases: [], events: [] },
  });
}

function onLive(serviceId: string, d: Dep) {
  for (const o of S.deploys[serviceId]) if (o !== d && o.status === "live") o.status = "deactivated";
  if (serviceId === "srv-web") {
    if (!S.app.webCommitStuck) S.app.webCommit = d.commit.id;
    if (d.commit.id === SHA) { S.app.legacy = false; S.app.applied = [...ALL_MIGRATIONS]; }
  } else if (!S.app.workerStuck) S.app.workerCommit = d.commit.id;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
const readBody = (req: http.IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

beforeAll(async () => {
  render = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url!, "http://x");
    const key = `${req.method} ${url.pathname}`;
    S.requests.push(key);
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return json(res, 401, { message: "unauthorized" });
    const pattern = key.replace(/srv-[a-z]+/, ":svc").replace(/dep-[a-z0-9]+/, ":dep");
    if (S.failNext[pattern]) { S.failNext[pattern]--; return json(res, 503, { message: "unavailable" }); }
    let m: RegExpMatchArray | null;
    if ((m = url.pathname.match(/^\/v1\/services\/(srv-[a-z]+)$/))) return json(res, 200, S.services[m[1]]);
    if ((m = url.pathname.match(/^\/v1\/services\/(srv-[a-z]+)\/deploys$/))) {
      const svc = m[1];
      if (req.method === "GET") return json(res, 200, S.deploys[svc].map((d) => ({ deploy: { id: d.id, status: d.status, commit: d.commit, createdAt: d.createdAt }, cursor: "c" })));
      const { commitId } = JSON.parse(body);
      const script = S.scripts[svc].shift() ?? ["build_in_progress", "live"];
      const d: Dep = { id: `dep-${svc.slice(4)}${S.deploys[svc].length}`, status: "created", commit: { id: commitId }, createdAt: new Date(Date.UTC(2026, 9, 22) + clock).toISOString(), script };
      S.deploys[svc].unshift(d);
      if (S.createdButFail) { S.createdButFail = false; return json(res, 502, { message: "bad gateway" }); }
      return json(res, 201, { id: d.id, status: d.status, commit: d.commit, createdAt: d.createdAt });
    }
    if ((m = url.pathname.match(/^\/v1\/services\/(srv-[a-z]+)\/deploys\/(dep-[a-z0-9]+)$/))) {
      const d = S.deploys[m[1]].find((x) => x.id === m![2])!;
      if (d.script.length) { d.status = d.script.shift()!; if (d.status === "live") onLive(m[1], d); }
      return json(res, 200, { id: d.id, status: d.status, commit: d.commit });
    }
    if ((m = url.pathname.match(/^\/v1\/services\/(srv-[a-z]+)\/deploys\/(dep-[a-z0-9]+)\/cancel$/))) {
      const d = S.deploys[m[1]].find((x) => x.id === m![2])!;
      d.status = "canceled"; d.script = [];
      return json(res, 200, { id: d.id, status: d.status });
    }
    if ((m = url.pathname.match(/^\/v1\/services\/(srv-[a-z]+)\/rollback$/))) {
      const target = S.deploys[m[1]].find((x) => x.id === JSON.parse(body).deployId)!;
      const d: Dep = { id: `dep-rb${S.deploys[m[1]].length}`, status: "created", commit: { id: target.commit.id }, createdAt: new Date().toISOString(), script: ["update_in_progress", "live"] };
      S.deploys[m[1]].unshift(d);
      return json(res, 201, { id: d.id, status: d.status, commit: d.commit });
    }
    if (url.pathname === "/v1/postgres/dpg-db/recovery") return S.recovery ? json(res, 200, S.recovery) : json(res, 404, { message: "not found" });
    json(res, 404, { message: "no route" });
  });
  app = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === "/api/health") return S.app.healthy ? json(res, 200, { ok: true }) : json(res, 503, { ok: false });
    if (S.app.legacy === "session401") return json(res, 401, { error: "Oturum gerekli" });
    if (S.app.legacy === "missing404") return json(res, 404, undefined);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
    if (req.url === "/api/release/status") {
      const all = ALL_MIGRATIONS;
      return json(res, 200, {
        ok: true, commit: S.app.webCommit, db: { ok: true },
        migrations: { applied: S.app.applied, inImage: all, pending: all.filter((f) => !S.app.applied.includes(f)) },
        workers: S.app.workerCommit ? [{ commit: S.app.workerCommit, ageSeconds: 3, live: true }] : [],
        paused: false,
        backup: { lastOk: S.app.backupAt ? { at: S.app.backupAt, dbBytes: 1000 } : null, last: null },
        releases: S.app.releases,
      });
    }
    if (req.url === "/api/release/events") { S.app.events.push(JSON.parse(body)); return json(res, 200, { ok: true }); }
    json(res, 404, undefined);
  });
  await new Promise<void>((r) => render.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  renderUrl = `http://127.0.0.1:${(render.address() as AddressInfo).port}/v1`;
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => render.close(r));
  await new Promise((r) => app.close(r));
});
beforeEach(reset);

function input(over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    sha: SHA, branch: "claude/amazing-goodall-qkxupd", productionBranch: "claude/amazing-goodall-qkxupd", branchHeadSha: SHA,
    releaseId: "run-1", ciUrl: "https://github.com/CCC-C52/can/actions/runs/1", ciResult: "success",
    webServiceId: "srv-web", workerServiceId: "srv-worker", postgresId: "dpg-db", expectedRepo: "https://github.com/CCC-C52/can",
    migrationsDir: path.resolve(process.cwd(), "migrations"),
    authorizeMigrations: ["003_brand_memory_research.sql"], legacyAppliedMigrations: ["001_init.sql", "002_media_jobs_integrity.sql"],
    allowRedeployFailed: false, autoRollback: false, dryRun: false, backupMaxAgeHours: 26,
    timeouts: { deployMs: 30 * 60_000, webHealthMs: 5 * 60_000, workerHealthMs: 8 * 60_000, pollMs: 15_000 },
    ...over,
  };
}
const run = (over: Partial<ReleaseInput> = {}) =>
  runRelease(input(over), {
    render: new RenderApi({ apiKey: API_KEY, baseUrl: renderUrl, sleep: async () => {} }),
    app: new AppApi({ baseUrl: appUrl, token: TOKEN }),
    sleep: async (ms) => { clock += ms; },
    now: () => Date.UTC(2026, 9, 22) + clock,
    log: () => {},
  });
const posts = () => S.requests.filter((r) => r.startsWith("POST /v1/services/") && r.endsWith("/deploys"));

describe("Sürüm hattı — ilk etkinleştirme (canlıda durum ucu yok, 003 bekliyor)", () => {
  it("web → doğrulama → işleyici sırasıyla dağıtır; aynı commit; geçiş ve kurtarma noktası kapıları geçer", async () => {
    const r = await run();
    expect(r.outcome).toBe("succeeded");
    expect(posts()).toEqual(["POST /v1/services/srv-web/deploys", "POST /v1/services/srv-worker/deploys"]);
    expect(r.web).toMatchObject({ status: "live", previousCommit: OLD });
    expect(r.worker).toMatchObject({ status: "live", previousCommit: OLD });
    expect(r.migrations).toMatchObject({ source: "legacy_input", pending: ["003_brand_memory_research.sql", "004_drive_archive.sql", "005_brand_knowledge.sql", "006_pr_strategy_operations.sql"], authorizedUsed: ["003_brand_memory_research.sql"] });
    expect(r.backup.evidence).toMatch(/Render PITR kullanılabilir/);
    expect(S.deploys["srv-web"][0].commit.id).toBe(SHA);
    expect(S.deploys["srv-worker"][0].commit.id).toBe(SHA);
    // Durum ucu yeni sürümle geldi: kayıt "started" ile başlar, "succeeded" ile biter
    expect(S.app.events.map((e) => e.phase)).toEqual(["started", "web_live", "web_verified", "worker_deploying", "worker_live", "worker_verified", "succeeded"]);
    expect(S.app.events.every((e) => e.sha === SHA)).toBe(true);
  });

  it("003 için sahip onayı yoksa hiçbir dağıtım başlamaz", async () => {
    const r = await run({ authorizeMigrations: [] });
    expect(r).toMatchObject({ outcome: "blocked", failedStep: "migrations" });
    expect(r.error).toMatch(/bir kerelik açık onayını/);
    expect(posts()).toEqual([]);
  });

  it("bekleyen geçiş varken kurtarma noktası doğrulanamazsa engellenir", async () => {
    S.recovery = { recoveryStatus: "NOT_AVAILABLE" };
    const r = await run();
    expect(r).toMatchObject({ outcome: "blocked", failedStep: "backup" });
    expect(posts()).toEqual([]);
    const r2 = await run({ postgresId: null });
    expect(r2.failedStep).toBe("backup");
  });

  it("durum ucu yok ve uygulanmış geçiş girdisi verilmemişse engellenir", async () => {
    const r = await run({ legacyAppliedMigrations: null });
    expect(r).toMatchObject({ outcome: "blocked", failedStep: "prod_status" });
    expect(r.error).toMatch(/legacy_applied_migrations/);
  });

  it("durum ucu 404 dönen eski sürümde de ilk etkinleştirme yapılır", async () => {
    S.app.legacy = "missing404";
    const r = await run();
    expect(r.outcome).toBe("succeeded");
    expect(r.migrations.source).toBe("legacy_input");
  });

  it("yeni sürümde belirteç reddedilirse (gövde 'unauthorized') engellenir; eski sürüm sayılmaz", async () => {
    S.app.legacy = false;
    const r = await runRelease(input(), {
      render: new RenderApi({ apiKey: API_KEY, baseUrl: renderUrl, sleep: async () => {} }),
      app: new AppApi({ baseUrl: appUrl, token: "wrong-token-wrong-token-wrong-token-xx" }),
      sleep: async (ms) => { clock += ms; },
      now: () => Date.UTC(2026, 9, 22) + clock,
      log: () => {},
    });
    expect(r).toMatchObject({ outcome: "blocked", failedStep: "prod_status" });
    expect(r.error).toMatch(/belirteci reddetti/);
    expect(posts()).toEqual([]);
  });
});

describe("Sürüm hattı — engeller", () => {
  it.each([
    [{ ciResult: "failure" }, "ci"],
    [{ branch: "feature/x" }, "commit"],
    [{ branchHeadSha: "2".repeat(40) }, "commit"],
    [{ productionBranch: "" }, "commit"],
  ] as [Partial<ReleaseInput>, string][])("%o → %s adımında engel, dağıtım yok", async (over, step) => {
    const r = await run(over);
    expect(r).toMatchObject({ outcome: "blocked", failedStep: step });
    expect(posts()).toEqual([]);
  });

  it("Render otomatik dağıtımı açıksa (ikinci mekanizma) veya servis başka dalı izliyorsa engellenir", async () => {
    S.services["srv-worker"].autoDeployTrigger = "commit";
    expect((await run()).failedStep).toBe("render_service");
    reset();
    S.services["srv-web"].branch = "main";
    expect((await run()).failedStep).toBe("render_service");
    expect(posts()).toEqual([]);
  });

  it("daha önce başarısız olmuş commit, açık izin olmadan tekrar dağıtılmaz", async () => {
    Object.assign(S.app, { legacy: false, webCommit: OLD, applied: [...ALL_MIGRATIONS], backupAt: new Date(Date.UTC(2026, 9, 22) - 3_600_000).toISOString(), releases: [{ releaseId: "run-0", sha: SHA, outcome: "failed" }] });
    const r = await run({ authorizeMigrations: [], legacyAppliedMigrations: null });
    expect(r).toMatchObject({ outcome: "blocked", failedStep: "redeploy_guard" });
    expect(posts()).toEqual([]);
    const again = await run({ authorizeMigrations: [], legacyAppliedMigrations: null, allowRedeployFailed: true });
    expect(again.outcome).toBe("succeeded");
  });

  it("kuru çalıştırma: tüm kapılar geçer, dağıtım başlatılmaz", async () => {
    const r = await run({ dryRun: true });
    expect(r.outcome).toBe("dry_run_ready");
    expect(posts()).toEqual([]);
  });

  it("servisler zaten bu commit'teyse dağıtım yapılmaz (noop)", async () => {
    S.deploys["srv-web"][0].commit.id = SHA;
    S.deploys["srv-worker"][0].commit.id = SHA;
    Object.assign(S.app, { legacy: false, webCommit: SHA, workerCommit: SHA, applied: [...ALL_MIGRATIONS] });
    const r = await run({ legacyAppliedMigrations: null });
    expect(r.outcome).toBe("noop");
    expect(posts()).toEqual([]);
  });
});

describe("Sürüm hattı — dağıtım hataları", () => {
  it("web derlemesi başarısızsa işleyici dağıtılmaz; önceki sürüm canlı kalır", async () => {
    S.scripts["srv-web"] = [["build_in_progress", "build_failed"]];
    const r = await run();
    expect(r).toMatchObject({ outcome: "failed", failedStep: "web_deploy" });
    expect(posts()).toEqual(["POST /v1/services/srv-web/deploys"]);
    expect(S.deploys["srv-web"].find((d) => d.status === "live")!.commit.id).toBe(OLD);
    expect(r.rollback.attempted).toBe(false);
  });

  it("ön dağıtım (geçiş) başarısızsa açıkça raporlanır ve işleyici dağıtılmaz", async () => {
    S.scripts["srv-web"] = [["build_in_progress", "pre_deploy_in_progress", "pre_deploy_failed"]];
    const r = await run();
    expect(r.error).toMatch(/pre_deploy_failed.*geçiş/);
    expect(posts()).toHaveLength(1);
  });

  it("web canlı ama commit doğrulanamıyorsa: geri alma kapalıysa yalnızca rapor, açıksa önceki sürüme döner", async () => {
    S.app.webCommitStuck = true;
    const r = await run();
    expect(r).toMatchObject({ outcome: "failed", failedStep: "web_verify" });
    expect(r.checks.find((c) => c.name === "rollback")?.status).toBe("skip");
    expect(posts()).toHaveLength(1);
    reset();
    S.app.webCommitStuck = true;
    const rb = await run({ autoRollback: true });
    expect(rb.outcome).toBe("rolled_back");
    expect(S.requests).toContain("POST /v1/services/srv-web/rollback");
    expect(S.deploys["srv-web"].find((d) => d.status === "live")!.commit.id).toBe(OLD);
    expect(posts()).toHaveLength(1);
  });

  it("işleyici yeni commit ile kalp atışı vermezse başarısız; karışık sürüm raporlanır", async () => {
    S.app.workerStuck = true;
    const r = await run();
    expect(r).toMatchObject({ outcome: "failed", failedStep: "worker_verify", mixedVersions: true });
    expect(r.error).toMatch(/İşleyici 8 dk içinde doğrulanamadı/);
  });

  it("dağıtım süre sınırını aşarsa iptal edilir", async () => {
    S.scripts["srv-web"] = [Array(500).fill("build_in_progress")];
    const r = await run({ timeouts: { deployMs: 60_000, webHealthMs: 60_000, workerHealthMs: 60_000, pollMs: 15_000 } });
    expect(r).toMatchObject({ outcome: "failed", failedStep: "web_deploy" });
    expect(S.requests.some((x) => /\/deploys\/dep-[a-z0-9]+\/cancel$/.test(x))).toBe(true);
  });

  it("geçici Render hataları yeniden denenir; POST başarılı olup yanıt kaybolursa çift dağıtım açılmaz", async () => {
    S.failNext["GET /v1/services/:svc/deploys/:dep"] = 2;
    S.createdButFail = true;
    const r = await run();
    expect(r.outcome).toBe("succeeded");
    expect(posts()).toEqual(["POST /v1/services/srv-web/deploys", "POST /v1/services/srv-worker/deploys"]);
    expect(S.deploys["srv-web"].filter((d) => d.commit.id === SHA)).toHaveLength(1);
  });
});

describe("Sürüm raporu", () => {
  it("rapor ve özet API anahtarı, belirteç veya canlı adres içermez", async () => {
    const r = await run();
    const md = reportMarkdown(r);
    for (const text of [JSON.stringify(r), md]) {
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(appUrl);
    }
    expect(md).toMatch(/Sürüm BAŞARILI/);
  });
});
