import { describe, it, expect, afterEach } from "vitest";
import { q } from "@/lib/db/pool";
import { Engine } from "@/lib/orchestrator/engine";
import { recordReleaseEvent, releaseApiEnabled, releaseCommit, releaseHistory, releaseStatus, releaseTokenValid, ReleaseEventSchema } from "@/lib/release";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
const SHA = "a".repeat(40);
const TOKEN = "t".repeat(40);

describe("Sürüm durum ucu — belirteç", () => {
  it("belirteç yoksa veya kısaysa uç kapalı; yalnızca tam eşleşen Bearer kabul edilir", () => {
    delete process.env.RELEASE_STATUS_TOKEN;
    expect(releaseApiEnabled()).toBe(false);
    expect(releaseTokenValid(`Bearer ${TOKEN}`)).toBe(false);
    process.env.RELEASE_STATUS_TOKEN = "short";
    expect(releaseApiEnabled()).toBe(false);
    process.env.RELEASE_STATUS_TOKEN = TOKEN;
    expect(releaseApiEnabled()).toBe(true);
    expect(releaseTokenValid(`Bearer ${TOKEN}`)).toBe(true);
    expect(releaseTokenValid(`Bearer ${TOKEN}x`)).toBe(false);
    expect(releaseTokenValid(TOKEN)).toBe(false);
    expect(releaseTokenValid(null)).toBe(false);
  });

  it("commit yalnızca geçerli SHA biçimindeyse raporlanır", () => {
    process.env.RENDER_GIT_COMMIT = "ABCDEF1234567";
    expect(releaseCommit()).toBe("abcdef1234567");
    process.env.RENDER_GIT_COMMIT = "not a sha; rm -rf";
    delete process.env.AIOPS_RELEASE_COMMIT;
    expect(releaseCommit()).toBeNull();
  });
});

describe("Sürüm olayları", () => {
  it("olaylar tek sürüm kaydında birleşir; sonuç yalnızca bildirilen aşamadan gelir; gizli değer maskelenir", async () => {
    const id = `run-${Date.now()}`;
    await recordReleaseEvent({ releaseId: id, sha: SHA, phase: "started", ciUrl: "https://github.com/CCC-C52/can/actions/runs/1", migrations: ["003_brand_memory_research.sql"] });
    let rec = await recordReleaseEvent({ releaseId: id, sha: SHA, phase: "web_live", webDeployId: "dep-abc123" });
    expect(rec.outcome).toBe("in_progress");
    rec = await recordReleaseEvent({ releaseId: id, sha: SHA, phase: "failed", detail: "worker unhealthy key=sk-ant-abcdefghijklmnopqrstu" });
    expect(rec.outcome).toBe("failed");
    expect(rec.steps.map((s) => s.phase)).toEqual(["started", "web_live", "failed"]);
    expect(JSON.stringify(rec)).not.toContain("abcdefghijklmnop");
    expect(rec.webDeployId).toBe("dep-abc123");
    expect((await releaseHistory(1))[0].releaseId).toBe(id);
  });

  it("aynı sürüm kimliği başka commit ile kullanılamaz; geçersiz olay şemadan geçmez", async () => {
    const id = `run-x-${Date.now()}`;
    await recordReleaseEvent({ releaseId: id, sha: SHA, phase: "started" });
    await expect(recordReleaseEvent({ releaseId: id, sha: "b".repeat(40), phase: "succeeded" })).rejects.toThrow(/farklı commit/);
    expect(ReleaseEventSchema.safeParse({ releaseId: "x", sha: "short", phase: "started" }).success).toBe(false);
    expect(ReleaseEventSchema.safeParse({ releaseId: "x", sha: SHA, phase: "deployed_everything" }).success).toBe(false);
    expect(ReleaseEventSchema.safeParse({ releaseId: "x", sha: SHA, phase: "started", ciUrl: "https://evil.example/x" }).success).toBe(false);
  });

  it("kayıt sayısı sınırlıdır (en fazla 30 sürüm)", async () => {
    for (let i = 0; i < 35; i++) await recordReleaseEvent({ releaseId: `cap-${i}`, sha: SHA, phase: "started" });
    const all = await releaseHistory(100);
    expect(all.length).toBe(30);
    expect(all[0].releaseId).toBe("cap-34");
  });
});

describe("Sürüm durumu", () => {
  it("veritabanı, uygulanan/bekleyen geçişler, işleyici commit'i ve yedek durumu raporlanır", async () => {
    process.env.AIOPS_RELEASE_COMMIT = SHA;
    delete process.env.RENDER_GIT_COMMIT;
    await q(`DELETE FROM worker_heartbeats`);
    const engine = new Engine(`w-release-${Date.now()}`);
    await engine.heartbeat();
    const s = await releaseStatus();
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.commit).toBe(SHA);
    expect(s.db.ok).toBe(true);
    expect(s.migrations.pending).toEqual([]);
    expect(s.migrations.applied).toContain("003_brand_memory_research.sql");
    expect(s.workers[0]).toMatchObject({ commit: SHA, live: true });
    expect(Object.keys(s)).not.toContain("env");
    const text = JSON.stringify(s);
    for (const k of ["DATABASE_URL", "password", "secret", "postgres://"]) expect(text.toLowerCase()).not.toContain(k.toLowerCase());
    await engine.shutdown();
  });
});
