// Kalıcı görev işleyicisi — web uygulamasından AYRI süreç olarak çalışır: npm run worker
import "../scripts/load-env";
import crypto from "node:crypto";
import os from "node:os";
import { Engine } from "@/lib/orchestrator/engine";
import { runMigrations } from "@/lib/db/migrate";
import { closePool } from "@/lib/db/pool";
import { assertProductionConfig, config } from "@/lib/config";
import { textModelMode } from "@/lib/models";
import { redact } from "@/lib/security/crypto";
import { backupConfigured, maybeRunScheduledBackup } from "@/lib/services/backup";
import { runAnalysisQueueOnce } from "@/lib/media-analysis";
import { runUploadQueueOnce } from "@/lib/uploads";
import { reconcileStaleSubmissions } from "@/lib/services/provider-jobs";

const problems = assertProductionConfig("worker");
if (problems.length) {
  console.error("[worker] Üretim yapılandırması eksik:\n - " + problems.join("\n - "));
  process.exit(1);
}

const workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
const engine = new Engine(workerId);
let stopping = false;

async function main() {
  const applied = await runMigrations();
  if (applied.length) console.log(`[worker] Geçişler uygulandı: ${applied.join(", ")}`);
  console.log(`[worker] Başladı: ${workerId} · ${textModelMode().label} · yoklama ${config.workerPollMs} ms`);
  const b = backupConfigured();
  console.log(b.ok ? `[worker] Günlük yedekleme etkin (UTC ${config.backup.hourUtc}:00 sonrası)` : `[worker] UYARI: yedekleme kapalı — ${b.reason}`);
  let backupRunning = false;
  let analysisRunning = false;
  let lastBackupCheck = 0;
  while (!stopping) {
    try {
      const n = await engine.tick();
      if (n) console.log(`[worker] ${n} görev alındı (aktif: ${engine.activeCount})`);
      // Medya analizi: görev döngüsünü bloklamadan, aynı anda tek analiz (bellek sınırı)
      if (!analysisRunning) {
        analysisRunning = true;
        (async () => {
          // Önce yükleme doğrulamaları (kullanıcı bekliyor), sonra analizler
          for (let i = 0; i < 5; i++) {
            const u = await runUploadQueueOnce(workerId);
            if (!u) break;
            console.log(`[worker] yükleme ${u.id.slice(0, 8)} (${u.filename}): ${u.status}${u.error ? ` — ${u.error}` : ""}`);
          }
          for (let i = 0; i < 5; i++) {
            const a = await runAnalysisQueueOnce(workerId);
            if (!a) break;
            console.log(`[worker] medya analizi ${a.id.slice(0, 8)}: ${a.status}${a.error ? ` — ${a.error}` : ""}`);
          }
        })()
          .catch((e) => console.error("[worker] analiz hatası:", redact((e as Error).message)))
          .finally(() => { analysisRunning = false; });
      }
      // Yedekleme görev döngüsünü bloklamadan, en fazla 30 sn'de bir kontrol edilir
      if (!backupRunning && Date.now() - lastBackupCheck > 30_000) {
        lastBackupCheck = Date.now();
        // Ücretli gönderim sırasında yarıda kalan işler (gönderim zaman aşımı 3 dk'dan uzun süredir "submitting"): sonucu bilinmiyor
        reconcileStaleSubmissions(10 * 60_000)
          .then((n) => n && console.log(`[worker] ${n} sağlayıcı işi 'sonuç bilinmiyor' olarak işaretlendi (otomatik tekrar gönderilmedi)`))
          .catch((e) => console.error("[worker] uzlaştırma hatası:", redact((e as Error).message)));
        backupRunning = true;
        maybeRunScheduledBackup()
          .then((s) => s && console.log(`[worker] Yedekleme ${s.ok ? "tamamlandı" : `başarısız: ${s.error}`}`))
          .catch((e) => console.error("[worker] yedekleme hatası:", redact((e as Error).message)))
          .finally(() => { backupRunning = false; });
      }
    } catch (err) {
      console.error("[worker] döngü hatası:", redact((err as Error).message));
    }
    await new Promise((r) => setTimeout(r, config.workerPollMs));
  }
}

async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} alındı, çalışan görevler kuyruğa geri bırakılıyor...`);
  await engine.shutdown().catch(() => {});
  await closePool();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

main().catch(async (err) => {
  console.error("[worker] başlatılamadı:", redact((err as Error).message));
  await closePool();
  process.exit(1);
});
