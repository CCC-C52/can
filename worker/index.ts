// Kalıcı görev işleyicisi — web uygulamasından AYRI süreç olarak çalışır: npm run worker
import "../scripts/load-env";
import crypto from "node:crypto";
import os from "node:os";
import { Engine } from "@/lib/orchestrator/engine";
import { runMigrations } from "@/lib/db/migrate";
import { closePool } from "@/lib/db/pool";
import { assertProductionConfig, config } from "@/lib/config";
import { textModelMode } from "@/lib/models";
import { log } from "@/lib/log";
import { backupConfigured, maybeRunScheduledBackup } from "@/lib/services/backup";
import { runAnalysisQueueOnce } from "@/lib/media-analysis";
import { runUploadQueueOnce } from "@/lib/uploads";
import { reconcileStaleSubmissions } from "@/lib/services/provider-jobs";
import { runDriveScanOnce } from "@/lib/drive/indexer";
import { runReferenceImportOnce } from "@/lib/drive/references";
import { runPrAgencyTick } from "@/lib/services/pr-agency";
import { runBrainTick } from "@/lib/brain/worker";

const problems = assertProductionConfig("worker");
if (problems.length) {
  log("error", "worker.config_invalid", { problems });
  process.exit(1);
}

const workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const engine = new Engine(workerId);
let stopping = false;

async function main() {
  const applied = await runMigrations();
  if (applied.length) log("info", "worker.migrations_applied", { migrations: applied });
  log("info", "worker.started", { workerId, mode: textModelMode().mode, pollMs: config.workerPollMs });
  const b = backupConfigured();
  log(b.ok ? "info" : "warn", b.ok ? "backup.enabled" : "backup.disabled", b.ok ? { hourUtc: config.backup.hourUtc } : { reason: b.reason });
  let backupRunning = false;
  let analysisRunning = false;
  let driveRunning = false;
  let lastBackupCheck = 0;
  let lastDriveCheck = 0;
  let prRunning = false;
  let lastPrCheck = 0;
  let brainRunning = false;
  let lastBrainCheck = 0;
  while (!stopping) {
    try {
      const n = await engine.tick();
      if (n) log("info", "tasks.claimed", { count: n, active: engine.activeCount });
      // Medya analizi: görev döngüsünü bloklamadan, aynı anda tek analiz (bellek sınırı)
      if (!analysisRunning) {
        analysisRunning = true;
        (async () => {
          // Önce yükleme doğrulamaları (kullanıcı bekliyor), sonra analizler
          for (let i = 0; i < 5; i++) {
            const u = await runUploadQueueOnce(workerId);
            if (!u) break;
            log(u.status === "failed" ? "warn" : "info", "upload.processed", { uploadId: u.id, status: u.status, error: u.error ?? undefined });
          }
          for (let i = 0; i < 5; i++) {
            const a = await runAnalysisQueueOnce(workerId);
            if (!a) break;
            log(a.status === "failed" ? "warn" : "info", "analysis.processed", { analysisId: a.id, status: a.status, error: a.error ?? undefined });
          }
        })()
          .catch((e) => log("error", "analysis.loop_error", { error: e }))
          .finally(() => { analysisRunning = false; });
      }
      // Google Drive arşiv dizini: görev döngüsünü bloklamadan, en fazla 10 sn'de bir; tek seferde tek kaynak ve sınırlı sayfa
      if (!driveRunning && Date.now() - lastDriveCheck > 10_000) {
        lastDriveCheck = Date.now();
        driveRunning = true;
        runDriveScanOnce(workerId)
          .then((r) => r && log(r.status === "failed" ? "warn" : "info", "drive.scan", { brandId: r.brandId, status: r.status, pages: r.stats.pages, upserted: r.stats.upserted, removed: r.stats.removed, error: r.error }))
          // Doğrulanmış referansların orijinalleri arka planda medya arşivine alınır
          .then(() => runReferenceImportOnce())
          .then((r) => r.forEach((x) => log(x.ok ? "info" : "warn", "drive.reference_import", x)))
          .catch((e) => log("error", "drive.scan_error", { error: e }))
          .finally(() => { driveRunning = false; });
      }
      // Brand Brain: Drive içeriğinin artımlı alımı (indir → ayrıştır → parçala → dizinle; izinliyse bütçeli gömme).
      // Ayrı bayrak: görev, video ve analiz döngülerini bloklamaz; tur başına en fazla 8 belge / 25 sn.
      if (!brainRunning && Date.now() - lastBrainCheck > 15_000) {
        lastBrainCheck = Date.now();
        brainRunning = true;
        runBrainTick(workerId)
          .then((ticks) => ticks.forEach((t) => (t.processed.length || t.sync.added || t.sync.changed || t.sync.removed || t.embedded || t.recovered) && log("info", "brain.tick", {
            brandId: t.brandId, sync: t.sync, processed: t.processed.length, failed: t.processed.filter((p) => p.status === "failed" || p.status === "dead").length,
            embedded: t.embedded, embedNote: t.embedNote ?? undefined, recovered: t.recovered || undefined,
          })))
          .catch((e) => log("error", "brain.error", { error: e }))
          .finally(() => { brainRunning = false; });
      }
      // Yedekleme görev döngüsünü bloklamadan, en fazla 30 sn'de bir kontrol edilir
      if (!backupRunning && Date.now() - lastBackupCheck > 30_000) {
        lastBackupCheck = Date.now();
        // Ücretli gönderim sırasında yarıda kalan işler (gönderim zaman aşımı 3 dk'dan uzun süredir "submitting"): sonucu bilinmiyor
        reconcileStaleSubmissions(10 * 60_000)
          .then((n) => n && log("warn", "provider_jobs.marked_unknown", { count: n }))
          .catch((e) => log("error", "provider_jobs.reconcile_error", { error: e }));
        backupRunning = true;
        maybeRunScheduledBackup()
          .then((s) => s && log(s.ok ? "info" : "error", s.ok ? "backup.completed" : "backup.failed", { error: s.error ?? undefined }))
          .catch((e) => log("error", "backup.error", { error: e }))
          .finally(() => { backupRunning = false; });
      }
      // PR ajansı: zamanlaması açık markalar için besleme çekimi + vadesi gelen taslaklar (5 dk'da bir; dış gönderim yok)
      if (!prRunning && Date.now() - lastPrCheck > 5 * 60_000) {
        lastPrCheck = Date.now();
        prRunning = true;
        runPrAgencyTick()
          .then((r) => r.forEach((x) => (x.created || x.polled || x.error) && log(x.error ? "warn" : "info", "pr_agency.tick", x)))
          .catch((e) => log("error", "pr_agency.error", { error: e }))
          .finally(() => { prRunning = false; });
      }
    } catch (err) {
      log("error", "worker.loop_error", { error: err });
    }
    await new Promise((r) => setTimeout(r, config.workerPollMs));
  }
}

async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log("info", "worker.stopping", { signal });
  await engine.shutdown().catch(() => {});
  await closePool();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

main().catch(async (err) => {
  log("error", "worker.start_failed", { error: err });
  await closePool();
  process.exit(1);
});
