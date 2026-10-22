import { evaluatePending } from "@/lib/db/migration-safety";
import { TERMINAL_FAIL, TERMINAL_OK, type AppApi, type AppStatus, type RenderApi, type RenderDeploy, type Sleep } from "./render-api";

// Üretim sürüm orkestrasyonu. Sıra (her adım bir öncekinin kanıtına bağlıdır):
//  1 CI sonucu → 2 commit/dal doğrulaması → 3 Render servis yapılandırması (otomatik dağıtım kapalı, doğru dal)
//  4 canlı durum (sağlık, durum ucu, uygulanmış geçişler) → 5 daha önce başarısız olmuş commit tekrar dağıtılmaz
//  6 geçiş güvenlik kapısı → 7 bekleyen geçiş varsa kurtarma noktası kanıtı
//  8 web dağıtımı + izleme → 9 web sağlık/commit/geçiş doğrulaması → 10 işleyici dağıtımı + izleme
//  11 işleyici kalp atışı aynı commit'te → 12 son operasyonel kontrol → rapor
// Başarısız bir adımdan sonra bağımlı adımlar çalışmaz. Veritabanı hiçbir zaman otomatik geri yüklenmez.
// Uygulama geri alma yalnızca autoRollback açıkken ve önceki canlı dağıtım biliniyorsa yapılır.

export type ReleaseInput = {
  sha: string;
  branch: string;
  productionBranch: string;
  branchHeadSha: string | null;
  releaseId: string;
  ciUrl?: string;
  ciResult: string;
  webServiceId: string;
  workerServiceId: string;
  postgresId?: string | null;
  expectedRepo?: string | null;
  migrationsDir: string;
  authorizeMigrations: string[];
  legacyAppliedMigrations: string[] | null;
  allowRedeployFailed: boolean;
  autoRollback: boolean;
  dryRun: boolean;
  backupMaxAgeHours: number;
  timeouts: { deployMs: number; webHealthMs: number; workerHealthMs: number; pollMs: number };
};

export type Check = { name: string; status: "pass" | "fail" | "warn" | "skip"; detail: string };
export type ServiceResult = { deployId?: string; status?: string; previousDeployId?: string; previousCommit?: string; startedAt?: string; finishedAt?: string };
export type ReleaseReport = {
  releaseId: string;
  sha: string;
  startedAt: string;
  finishedAt?: string;
  outcome: "succeeded" | "failed" | "blocked" | "dry_run_ready" | "rolled_back" | "noop";
  failedStep?: string;
  error?: string;
  ci: string;
  checks: Check[];
  web: ServiceResult;
  worker: ServiceResult;
  migrations: { applied: string[]; pending: string[]; authorizedUsed: string[]; source: "status_endpoint" | "legacy_input" | "unknown" };
  backup: { required: boolean; evidence: string | null };
  rollback: { attempted: boolean; service?: string; result?: string };
  mixedVersions?: boolean;
};

export type Deps = { render: RenderApi; app: AppApi; sleep: Sleep; now: () => number; log: (line: string) => void };

class Stop extends Error {
  constructor(readonly outcome: "blocked" | "failed", readonly step: string, message: string) {
    super(message);
  }
}

export async function runRelease(input: ReleaseInput, deps: Deps): Promise<ReleaseReport> {
  const { render, app, log } = deps;
  const report: ReleaseReport = {
    releaseId: input.releaseId,
    sha: input.sha,
    startedAt: new Date(deps.now()).toISOString(),
    outcome: "failed",
    ci: input.ciResult,
    checks: [],
    web: {},
    worker: {},
    migrations: { applied: [], pending: [], authorizedUsed: [], source: "unknown" },
    backup: { required: false, evidence: null },
    rollback: { attempted: false },
  };
  const check = (name: string, status: Check["status"], detail: string) => {
    report.checks.push({ name, status, detail });
    log(`${status.toUpperCase().padEnd(4)} ${name} — ${detail}`);
  };
  const block = (step: string, msg: string): never => { check(step, "fail", msg); throw new Stop("blocked", step, msg); };
  const fail = (step: string, msg: string): never => { check(step, "fail", msg); throw new Stop("failed", step, msg); };
  let statusEndpoint = false;
  const event = async (phase: string, extra: Record<string, unknown> = {}) => {
    if (!statusEndpoint) return;
    await app.event({ releaseId: input.releaseId, sha: input.sha, phase, ...(input.ciUrl ? { ciUrl: input.ciUrl } : {}), ...extra });
  };

  try {
    // 1 — CI
    if (input.ciResult !== "success") block("ci", `CI sonucu '${input.ciResult}'; testler geçmeden dağıtım başlamaz.`);
    check("ci", "pass", "Tüm CI işleri başarılı.");

    // 2 — commit ve dal
    if (!/^[0-9a-f]{40}$/.test(input.sha)) block("commit", "Geçersiz commit SHA.");
    if (!input.productionBranch) block("commit", "PRODUCTION_BRANCH tanımlı değil.");
    if (input.branch !== input.productionBranch) block("commit", `Yalnızca üretim dalı (${input.productionBranch}) dağıtılır; bu çalıştırma '${input.branch}'.`);
    if (input.branchHeadSha !== input.sha) block("commit", `Dalın başı ${input.branchHeadSha?.slice(0, 7) ?? "bilinmiyor"}; bu çalıştırmanın commit'i ${input.sha.slice(0, 7)}. Eski commit dağıtılmaz (yeni çalıştırma bekleyin).`);
    check("commit", "pass", `${input.sha.slice(0, 7)} üretim dalının başı.`);

    // 3 — Render servisleri
    for (const [label, id] of [["aiops-web", input.webServiceId], ["aiops-worker", input.workerServiceId]] as const) {
      const svc = await render.getService(id);
      if (svc.suspended === "suspended") block("render_service", `${label} askıda.`);
      if (svc.branch && svc.branch !== input.productionBranch) block("render_service", `${label} '${svc.branch}' dalını izliyor; üretim dalı '${input.productionBranch}'.`);
      const autoOn = svc.autoDeployTrigger ? svc.autoDeployTrigger !== "off" : svc.autoDeploy === "yes";
      if (autoOn) block("render_service", `${label} için Render otomatik dağıtımı açık (${svc.autoDeployTrigger ?? svc.autoDeploy}); iki ayrı dağıtım mekanizması olmaması için kapatılmalı.`);
      if (input.expectedRepo && svc.repo && svc.repo.replace(/\.git$/, "").toLowerCase() !== input.expectedRepo.toLowerCase()) block("render_service", `${label} farklı depoya bağlı.`);
    }
    check("render_service", "pass", "Servisler doğru dalda, askıda değil, Render otomatik dağıtımı kapalı.");

    const prevWeb = (await render.listDeploys(input.webServiceId)).find((d) => d.status === "live");
    const prevWorker = (await render.listDeploys(input.workerServiceId)).find((d) => d.status === "live");
    report.web.previousDeployId = prevWeb?.id;
    report.web.previousCommit = prevWeb?.commit?.id;
    report.worker.previousDeployId = prevWorker?.id;
    report.worker.previousCommit = prevWorker?.commit?.id;
    check("current_release", "pass", `Canlı: web ${prevWeb?.commit?.id?.slice(0, 7) ?? "?"}, işleyici ${prevWorker?.commit?.id?.slice(0, 7) ?? "?"}.`);

    // 4 — canlı durum
    const health = await app.health();
    check("prod_health_before", health.ok ? "pass" : "warn", health.ok ? "Canlı web sağlıklı." : `Canlı web sağlık kontrolü başarısız (durum ${health.status ?? "yanıt yok"}); dağıtım yine de bu sorunu düzeltebilir.`);
    const st = await app.status();
    let applied: string[];
    if (st.kind === "ok") {
      statusEndpoint = true;
      if (!st.data.ok || !st.data.db?.ok) fail("prod_status", "Canlı uygulama veritabanına ulaşamıyor; dağıtım başlatılmadı.");
      applied = st.data.migrations?.applied ?? [];
      report.migrations.source = "status_endpoint";
      check("prod_status", "pass", `Durum ucu yanıt verdi; uygulanmış geçiş: ${applied.length}.`);
      // 5 — daha önce başarısız olmuş commit
      const failedBefore = (st.data.releases ?? []).find((r) => r.sha === input.sha && (r.outcome === "failed" || r.outcome === "rolled_back"));
      if (failedBefore && !input.allowRedeployFailed) block("redeploy_guard", `Bu commit daha önce başarısız oldu (${failedBefore.releaseId}). Aynı bozuk commit otomatik tekrar dağıtılmaz; düzeltme commit'i gönderin veya allow_redeploy_of_failed ile bilinçli olarak tekrar deneyin.`);
      check("redeploy_guard", "pass", failedBefore ? "Önceden başarısız commit; sahip açıkça tekrar denemeyi seçti." : "Bu commit için önceki başarısız sürüm yok.");
    } else if (st.kind === "unauthorized") {
      block("prod_status", "Durum ucu belirteci reddetti: GitHub'daki RELEASE_STATUS_TOKEN ile Render'daki değer aynı olmalı.");
      applied = [];
    } else if (st.kind === "disabled") {
      // Canlıdaki sürüm durum ucundan önceki bir sürüm (ilk etkinleştirme; uç yok veya oturum isteyen 401) ya da belirteç Render'da tanımlı değil.
      if (!input.legacyAppliedMigrations) block("prod_status", "Canlı sürümde durum ucu yok (ilk etkinleştirme veya RELEASE_STATUS_TOKEN Render'da tanımlı değil). İlk etkinleştirmede canlıda uygulanmış geçişleri legacy_applied_migrations girdisiyle bildirin.");
      applied = input.legacyAppliedMigrations!;
      report.migrations.source = "legacy_input";
      check("prod_status", "warn", `Durum ucu yok; uygulanmış geçişler sahibin girdisinden alındı (${applied.join(", ")}). Önceki başarısız sürüm kontrolü yapılamadı.`);
    } else {
      fail("prod_status", `Durum ucuna ulaşılamadı (${st.detail}).`);
      applied = [];
    }
    report.migrations.applied = applied;

    // 6 — geçiş kapısı
    const dec = evaluatePending(input.migrationsDir, applied, input.authorizeMigrations);
    report.migrations.pending = dec.pending;
    report.migrations.authorizedUsed = dec.authorizedUsed;
    if (!dec.allowed) block("migrations", dec.blocked.map((b) => b.reason).join(" | "));
    check("migrations", "pass", dec.pending.length ? `Bekleyen geçiş: ${dec.pending.join(", ")} (politika uygun${dec.authorizedUsed.length ? `; sahip onayı: ${dec.authorizedUsed.join(", ")}. Uygulamanın kendi koruması için Render'da aiops-web ortamında AIOPS_AUTHORIZED_MIGRATIONS bu adları içermeli; yoksa ön dağıtım başarısız olur ve önceki sürüm canlı kalır` : ""}).` : "Bekleyen geçiş yok.");

    // 7 — kurtarma noktası
    report.backup.required = dec.pending.length > 0;
    const evidence: string[] = [];
    if (input.postgresId) {
      try {
        const rec = await render.postgresRecovery(input.postgresId);
        if (rec.recoveryStatus === "AVAILABLE") evidence.push(`Render PITR kullanılabilir (en eski nokta ${rec.startsAt ?? "?"})`);
        else check("backup_pitr", "warn", `Render PITR durumu: ${rec.recoveryStatus}.`);
      } catch (err) {
        check("backup_pitr", "warn", `Render PITR durumu okunamadı: ${(err as Error).message}`);
      }
    }
    if (st.kind === "ok" && st.data.backup?.lastOk) {
      const ageH = (deps.now() - new Date(st.data.backup.lastOk.at).getTime()) / 3_600_000;
      if (ageH <= input.backupMaxAgeHours) evidence.push(`Uygulama R2 yedeği ${ageH.toFixed(1)} saat önce başarılı`);
      else check("backup_app", "warn", `Son başarılı R2 yedeği ${ageH.toFixed(1)} saat önce (sınır ${input.backupMaxAgeHours} saat).`);
    }
    report.backup.evidence = evidence.join("; ") || null;
    if (report.backup.required && !evidence.length) {
      block("backup", "Bekleyen geçiş var ama doğrulanmış kurtarma noktası yok. Gerekli: RENDER_POSTGRES_ID ile Render PITR 'AVAILABLE' veya son " + input.backupMaxAgeHours + " saatte başarılı uygulama yedeği.");
    }
    check("backup", evidence.length ? "pass" : "warn", evidence.length ? evidence.join("; ") : "Kurtarma noktası doğrulanamadı (bekleyen geçiş olmadığı için engellenmedi).");

    if (prevWeb?.commit?.id === input.sha && prevWorker?.commit?.id === input.sha) {
      check("noop", "pass", "Web ve işleyici zaten bu commit'te; dağıtım gerekmiyor.");
      report.outcome = "noop";
      return finish();
    }

    await event("started", { migrations: dec.pending });
    if (input.dryRun) {
      check("dry_run", "pass", "Kuru çalıştırma: tüm ön koşullar sağlandı; dağıtım başlatılmadı.");
      report.outcome = "dry_run_ready";
      await event("blocked", { detail: "Kuru çalıştırma — dağıtım yapılmadı." });
      return finish();
    }

    // 8 — web
    const webLive = await deployAndWait("web", input.webServiceId, report.web);
    await event("web_live", { webDeployId: webLive.id });

    // 9 — web doğrulaması
    const webOk = await verifyWeb(webLive);
    if (!webOk.ok) {
      await maybeRollback("aiops-web", input.webServiceId, report.web.previousDeployId);
      fail("web_verify", webOk.detail);
    }
    check("web_verify", "pass", webOk.detail);
    if (!statusEndpoint) {
      // İlk etkinleştirme: durum ucu yeni sürümle geldi; sürüm kaydı buradan başlar
      statusEndpoint = true;
      await event("started", { migrations: dec.pending, detail: "İlk etkinleştirme: önceki sürümde durum ucu yoktu." });
      await event("web_live", { webDeployId: webLive.id });
    }
    await event("web_verified");

    // 10 — işleyici (yalnızca web doğrulandıktan sonra, aynı commit)
    const workerLive = await deployAndWait("worker", input.workerServiceId, report.worker);
    await event("worker_live", { workerDeployId: workerLive.id });

    // 11 — işleyici kalp atışı
    const wk = await verifyWorker();
    if (!wk.ok) {
      report.mixedVersions = true;
      await maybeRollback("aiops-worker", input.workerServiceId, report.worker.previousDeployId);
      fail("worker_verify", `${wk.detail} Web yeni sürümde, işleyici doğrulanamadı.`);
    }
    check("worker_verify", "pass", wk.detail);
    await event("worker_verified");

    // 12 — son operasyonel kontrol
    const final = await app.status();
    if (final.kind !== "ok" || !final.data.ok || (final.data.migrations?.pending.length ?? 0) > 0) fail("final", "Son durum kontrolü başarısız.");
    if (final.kind === "ok" && final.data.paused) check("final_paused", "warn", "İşlemler panelden duraklatılmış durumda (sürüm sağlıklı; görevler sahip devam ettirene kadar bekler).");
    check("final", "pass", "Web ve işleyici aynı commit'te, veritabanı erişilebilir, bekleyen geçiş yok.");
    report.outcome = "succeeded";
    await event("succeeded", { webDeployId: report.web.deployId, workerDeployId: report.worker.deployId });
    return finish();
  } catch (err) {
    if (err instanceof Stop) {
      report.outcome = report.rollback.result === "rolled_back" ? "rolled_back" : err.outcome;
      report.failedStep = err.step;
      report.error = err.message;
      if (err.outcome === "blocked") await event("blocked", { detail: err.message.slice(0, 900) });
      else if (report.rollback.result !== "rolled_back") await event("failed", { detail: `${err.step}: ${err.message}`.slice(0, 900) });
    } else {
      report.outcome = "failed";
      report.failedStep = report.failedStep ?? "unexpected";
      report.error = (err as Error).message;
      check("unexpected", "fail", report.error);
      await event("failed", { detail: report.error.slice(0, 900) });
    }
    return finish();
  }

  function finish() {
    report.finishedAt = new Date(deps.now()).toISOString();
    return report;
  }

  async function deployAndWait(kind: "web" | "worker", serviceId: string, res: ServiceResult): Promise<RenderDeploy> {
    const label = kind === "web" ? "aiops-web" : "aiops-worker";
    await event(kind === "web" ? "web_deploying" : "worker_deploying");
    const started = new Date(deps.now());
    const d = await render.createDeploy(serviceId, input.sha, started);
    res.deployId = d.id;
    res.startedAt = started.toISOString();
    log(`${label}: dağıtım ${d.id} başlatıldı (${input.sha.slice(0, 7)}).`);
    const deadline = deps.now() + input.timeouts.deployMs;
    let cur = d;
    let lastStatus = "";
    while (!TERMINAL_OK.has(cur.status ?? "") && !TERMINAL_FAIL.has(cur.status ?? "")) {
      if (deps.now() > deadline) {
        await render.cancelDeploy(serviceId, d.id).catch(() => null);
        res.status = "timeout";
        fail(`${kind}_deploy`, `${label} dağıtımı ${Math.round(input.timeouts.deployMs / 60000)} dk içinde tamamlanmadı; iptal istendi. Önceki sürüm canlı kalır.`);
      }
      await deps.sleep(input.timeouts.pollMs);
      cur = await render.getDeploy(serviceId, d.id);
      if (cur.status !== lastStatus) log(`${label}: ${cur.status}`);
      lastStatus = cur.status ?? "";
    }
    res.status = cur.status;
    res.finishedAt = new Date(deps.now()).toISOString();
    if (cur.status !== "live") {
      fail(`${kind}_deploy`, `${label} dağıtımı '${cur.status}' ile bitti${cur.status === "pre_deploy_failed" ? " (geçiş/ön dağıtım komutu başarısız)" : ""}. Render önceki canlı sürümü korur.${kind === "web" ? " İşleyici dağıtılmadı." : ""}`);
    }
    if (cur.commit?.id && cur.commit.id !== input.sha) fail(`${kind}_deploy`, `${label} canlı dağıtımı farklı commit (${cur.commit.id.slice(0, 7)}).`);
    check(`${kind}_deploy`, "pass", `${label} canlı (${d.id}).`);
    return cur;
  }

  async function verifyWeb(deploy: RenderDeploy): Promise<{ ok: boolean; detail: string }> {
    const deadline = deps.now() + input.timeouts.webHealthMs;
    let last = "kontrol edilmedi";
    while (deps.now() <= deadline) {
      const h = await app.health();
      if (!h.ok) last = `sağlık kontrolü ${h.status ?? "yanıt yok"}`;
      else {
        const s = await app.status();
        if (s.kind === "disabled") return { ok: false, detail: "Yeni sürümde durum ucu kapalı: RELEASE_STATUS_TOKEN Render'da aiops-web için tanımlanmalı. İşleyici dağıtılmadı." };
        if (s.kind === "unauthorized") return { ok: false, detail: "Durum ucu belirteci eşleşmiyor. İşleyici dağıtılmadı." };
        if (s.kind === "ok") {
          const commit = s.data.commit ?? deploy.commit?.id ?? null;
          if (!s.data.db?.ok) last = "veritabanı bağlantısı yok";
          else if (commit !== input.sha) last = `web commit ${commit?.slice(0, 7) ?? "bilinmiyor"} (beklenen ${input.sha.slice(0, 7)})`;
          else if ((s.data.migrations?.pending.length ?? 0) > 0) last = `bekleyen geçiş: ${s.data.migrations!.pending.join(", ")}`;
          else return { ok: true, detail: `Sağlık 200, veritabanı erişilebilir, commit ${commit.slice(0, 7)}${s.data.commit ? "" : " (Render dağıtım kaydından)"}, tüm geçişler uygulanmış (${s.data.migrations?.applied.length ?? 0}).` };
        } else last = `durum ucu: ${s.detail}`;
      }
      await deps.sleep(input.timeouts.pollMs);
    }
    return { ok: false, detail: `Web doğrulanamadı: ${last}.` };
  }

  async function verifyWorker(): Promise<{ ok: boolean; detail: string }> {
    const deadline = deps.now() + input.timeouts.workerHealthMs;
    let last = "kalp atışı yok";
    while (deps.now() <= deadline) {
      const s = await app.status();
      if (s.kind === "ok") {
        const w = (s.data.workers ?? []).find((x) => x.commit === input.sha && x.live);
        if (w) return { ok: true, detail: `İşleyici ${input.sha.slice(0, 7)} ile çalışıyor (son sinyal ${w.ageSeconds} sn önce).` };
        const other = (s.data.workers ?? []).filter((x) => x.live).map((x) => x.commit?.slice(0, 7) ?? "?");
        last = other.length ? `canlı işleyiciler farklı commit'te: ${other.join(", ")}` : "canlı işleyici yok";
      } else last = `durum ucu: ${s.kind}`;
      await deps.sleep(input.timeouts.pollMs);
    }
    return { ok: false, detail: `İşleyici ${Math.round(input.timeouts.workerHealthMs / 60000)} dk içinde doğrulanamadı (${last}).` };
  }

  async function maybeRollback(label: string, serviceId: string, previousDeployId?: string) {
    if (!input.autoRollback) {
      check("rollback", "skip", `Otomatik uygulama geri alma kapalı (AUTO_ROLLBACK). ${label} için elle geri alma: Render → ${label} → Events → önceki dağıtım → Rollback. Veritabanı geri alınmaz.`);
      return;
    }
    if (!previousDeployId) {
      check("rollback", "skip", `${label}: önceki canlı dağıtım bilinmiyor; geri alma yapılmadı.`);
      return;
    }
    report.rollback = { attempted: true, service: label };
    await event("rollback_started", { detail: `${label} → ${previousDeployId}` });
    try {
      const rb = await render.rollback(serviceId, previousDeployId);
      const deadline = deps.now() + input.timeouts.deployMs;
      let cur = rb;
      while (!TERMINAL_OK.has(cur.status ?? "") && !TERMINAL_FAIL.has(cur.status ?? "") && deps.now() <= deadline) {
        await deps.sleep(input.timeouts.pollMs);
        cur = await render.getDeploy(serviceId, rb.id);
      }
      const healthy = label === "aiops-web" ? (await app.health()).ok : true;
      report.rollback.result = cur.status === "live" && healthy ? "rolled_back" : `rollback_${cur.status ?? "unknown"}`;
      check("rollback", report.rollback.result === "rolled_back" ? "pass" : "fail", `${label} önceki sürüme geri alma: ${report.rollback.result}. Veritabanı değişmedi (geçişler yalnızca ekleme yapar).`);
      await event(report.rollback.result === "rolled_back" ? "rolled_back" : "rollback_failed", { detail: `${label}: ${report.rollback.result}` });
    } catch (err) {
      report.rollback.result = "rollback_error";
      check("rollback", "fail", `${label} geri alma hatası: ${(err as Error).message}`);
      await event("rollback_failed", { detail: `${label}: ${(err as Error).message}`.slice(0, 900) });
    }
  }
}

/** GitHub iş özeti için Markdown. Gizli değer veya özel adres içermez. */
export function reportMarkdown(r: ReleaseReport): string {
  const icon: Record<Check["status"], string> = { pass: "✅", fail: "❌", warn: "⚠️", skip: "⏭️" };
  const title: Record<ReleaseReport["outcome"], string> = {
    succeeded: "✅ Sürüm BAŞARILI — web ve işleyici doğrulandı",
    failed: "❌ Sürüm BAŞARISIZ",
    blocked: "⛔ Sürüm ENGELLENDİ (dağıtım başlatılmadı)",
    dry_run_ready: "🧪 Kuru çalıştırma — İLK SÜRÜME HAZIR (dağıtım yapılmadı)",
    rolled_back: "↩️ Sürüm başarısız, uygulama önceki sürüme GERİ ALINDI",
    noop: "ℹ️ Değişiklik yok — servisler zaten bu commit'te",
  };
  const lines = [
    `## ${title[r.outcome]}`,
    "",
    `- Commit: \`${r.sha.slice(0, 12)}\` · Sürüm: \`${r.releaseId}\``,
    `- Başlangıç: ${r.startedAt} · Bitiş: ${r.finishedAt ?? "-"}`,
    `- CI: ${r.ci}`,
    `- Web: ${r.web.status ?? "dağıtılmadı"}${r.web.deployId ? ` (\`${r.web.deployId}\`)` : ""} · önceki: \`${r.web.previousCommit?.slice(0, 7) ?? "?"}\``,
    `- İşleyici: ${r.worker.status ?? "dağıtılmadı"}${r.worker.deployId ? ` (\`${r.worker.deployId}\`)` : ""} · önceki: \`${r.worker.previousCommit?.slice(0, 7) ?? "?"}\``,
    `- Geçişler: uygulanmış ${r.migrations.applied.length} (${r.migrations.source}) · bekleyen: ${r.migrations.pending.join(", ") || "yok"}${r.migrations.authorizedUsed.length ? ` · sahip onayı: ${r.migrations.authorizedUsed.join(", ")}` : ""}`,
    `- Kurtarma noktası: ${r.backup.evidence ?? (r.backup.required ? "YOK" : "gerekmedi / doğrulanamadı")}`,
    `- Geri alma: ${r.rollback.attempted ? `${r.rollback.service}: ${r.rollback.result}` : "yapılmadı"}`,
    ...(r.mixedVersions ? ["- ⚠️ Web yeni sürümde, işleyici doğrulanamadı (karışık sürüm)."] : []),
    ...(r.error ? ["", `**Hata (${r.failedStep}):** ${r.error}`] : []),
    "",
    "| Adım | Sonuç | Ayrıntı |",
    "|---|---|---|",
    ...r.checks.map((c) => `| ${c.name} | ${icon[c.status]} | ${c.detail.replace(/\|/g, "\\|")} |`),
  ];
  return lines.join("\n");
}
