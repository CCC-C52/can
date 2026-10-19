import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { config } from "@/lib/config";
import { getPool, q } from "@/lib/db/pool";
import { getSetting, setSetting } from "@/lib/settings";
import { s3Client } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { redact } from "@/lib/security/crypto";

const execFileAsync = promisify(execFile);

// Yedekleme: GitHub'daki kod veritabanını ve yüklenen medyayı YEDEKLEMEZ.
// İşleyici her gün BACKUP_HOUR_UTC saatinden sonra bir kez:
//  1) pg_dump (özel biçim) ile veritabanı dökümünü yedek kovasına "db/" altında yükler,
//  2) son yedekten bu yana eklenen medya/dışa aktarma dosyalarını ana kovadan yedek kovasına kopyalar,
//  3) saklama süresinden eski veritabanı dökümlerini siler (medya kopyaları silinmez).

export type BackupStatus = {
  at: string;
  ok: boolean;
  dbKey?: string;
  dbBytes?: number;
  mediaCopied?: number;
  pruned?: number;
  error?: string;
};

export function backupConfigured(): { ok: boolean; reason?: string } {
  if (config.storageDriver !== "s3") return { ok: false, reason: "STORAGE_DRIVER=s3 değil (yerel depolama yedeklenmez)." };
  if (!config.backup.bucket) return { ok: false, reason: "BACKUP_S3_BUCKET tanımlı değil." };
  if (config.backup.bucket === config.s3.bucket) return { ok: false, reason: "Yedek kovası ana kovayla aynı olamaz." };
  return { ok: true };
}

/** Bağlantı bilgisini libpq ortam değişkenlerine çevirir (parola komut satırında görünmez). */
function pgEnv(): NodeJS.ProcessEnv {
  const u = new URL(process.env.DATABASE_URL_OVERRIDE ?? config.databaseUrl);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
  const ssl = u.searchParams.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  return env;
}

async function exists(bucket: string, key: string) {
  try {
    await s3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (err as Error).name === "NotFound") return false;
    throw err;
  }
}

export async function runBackup(trigger: "schedule" | "manual" = "schedule"): Promise<BackupStatus> {
  const cfg = backupConfigured();
  if (!cfg.ok) throw new Error(`Yedekleme yapılandırılmadı: ${cfg.reason}`);
  const client = s3Client();
  const backupBucket = config.backup.bucket!;
  const mainBucket = config.s3.bucket!;
  const started = new Date();
  const previous = await getSetting<BackupStatus | null>("backup_status", null);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-"));
  const status: BackupStatus = { at: started.toISOString(), ok: false };
  try {
    // 1) Veritabanı dökümü (parola komut satırında görünmesin diye bağlantı bilgisi ortam değişkenleriyle verilir)
    const file = path.join(dir, "aiops.dump");
    await execFileAsync(config.backup.pgDumpPath, ["--format=custom", "--no-owner", "--no-privileges", "--file", file], {
      env: pgEnv(),
      timeout: 15 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const body = await fs.readFile(file);
    const stamp = started.toISOString().replace(/[:.]/g, "-");
    const dbKey = `db/aiops-${stamp}.dump`;
    await client.send(new PutObjectCommand({ Bucket: backupBucket, Key: dbKey, Body: body, ContentType: "application/octet-stream" }));
    status.dbKey = dbKey;
    status.dbBytes = body.length;

    // 2) Yeni medya ve dışa aktarma dosyaları (son başarılı yedekten 1 gün öncesine kadar; ilk seferde tümü)
    const since = previous?.ok ? new Date(new Date(previous.at).getTime() - 86_400_000) : new Date(0);
    const keys = await q<{ key: string }>(
      `SELECT storage_key AS key FROM media_assets WHERE created_at >= $1
       UNION SELECT response->>'storage_key' FROM external_actions WHERE status = 'manual_export' AND response->>'storage_key' IS NOT NULL AND created_at >= $1`,
      [since],
    );
    let copied = 0;
    for (const { key } of keys) {
      const target = `media/${key}`;
      if (await exists(backupBucket, target)) continue;
      await client.send(new CopyObjectCommand({ Bucket: backupBucket, Key: target, CopySource: `${mainBucket}/${encodeURI(key)}` }));
      copied++;
    }
    status.mediaCopied = copied;

    // 3) Eski veritabanı dökümlerini sil
    const cutoff = Date.now() - config.backup.retentionDays * 86_400_000;
    let pruned = 0;
    let token: string | undefined;
    do {
      const list = await client.send(new ListObjectsV2Command({ Bucket: backupBucket, Prefix: "db/", ContinuationToken: token }));
      for (const o of list.Contents ?? []) {
        if (o.Key && o.LastModified && o.LastModified.getTime() < cutoff && o.Key !== dbKey) {
          await client.send(new DeleteObjectCommand({ Bucket: backupBucket, Key: o.Key }));
          pruned++;
        }
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    status.pruned = pruned;
    status.ok = true;
    await audit({ actor: "worker", action: "backup.ok", message: `Yedekleme tamamlandı (${trigger}): veritabanı ${(body.length / 1024).toFixed(0)} KB, ${copied} yeni dosya kopyalandı, ${pruned} eski döküm silindi` });
  } catch (err) {
    status.error = redact((err as Error).message).slice(0, 500);
    await audit({ actor: "worker", action: "backup.failed", message: `Yedekleme başarısız (${trigger}): ${status.error}` });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await setSetting("backup_status", status);
    if (status.ok) await setSetting("backup_last_ok", status);
  }
  return status;
}

/** İşleyici döngüsünden çağrılır: günde bir kez (veya panelden istenince) yedek alır. Aynı anda tek çalışma. */
export async function maybeRunScheduledBackup(now = new Date()): Promise<BackupStatus | null> {
  if (!backupConfigured().ok) return null;
  const requested = await getSetting<boolean>("backup_requested", false);
  const last = await getSetting<BackupStatus | null>("backup_status", null);
  const lastOk = await getSetting<BackupStatus | null>("backup_last_ok", null);
  const today = now.toISOString().slice(0, 10);
  const dueToday = now.getUTCHours() >= config.backup.hourUtc && lastOk?.at.slice(0, 10) !== today;
  // Başarısız denemeden sonra en az 1 saat bekle (sonsuz tekrar yok)
  const recentFail = last && !last.ok && now.getTime() - new Date(last.at).getTime() < 3_600_000;
  if (!requested && (!dueToday || recentFail)) return null;
  const client = await getPool().connect();
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock(777002) AS ok`);
    if (!lock.rows[0].ok) return null;
    try {
      await setSetting("backup_requested", false);
      return await runBackup(requested ? "manual" : "schedule");
    } finally {
      await client.query(`SELECT pg_advisory_unlock(777002)`);
    }
  } finally {
    client.release();
  }
}
