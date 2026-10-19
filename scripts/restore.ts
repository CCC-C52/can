// Yedekten geri yükleme. Render'da işleyici servisinin "Shell" sekmesinden çalıştırılır.
//
//   npm run db:restore -- list                 → yedek kovasındaki veritabanı dökümlerini listeler
//   RESTORE_CONFIRM=evet npm run db:restore -- latest            → en son dökümü DATABASE_URL veritabanına yükler
//   RESTORE_CONFIRM=evet npm run db:restore -- db/aiops-....dump → belirli dökümü yükler
//   RESTORE_CONFIRM=evet npm run db:restore -- media             → yedekteki medya dosyalarını ana kovaya geri kopyalar (eksik olanlar)
//
// UYARI: Veritabanı geri yüklemesi mevcut tabloları siler ve yedekteki hâliyle değiştirir.
// Önce panelden "Tüm işlemleri durdur" deyin.
import "./load-env";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { config } from "@/lib/config";
import { s3Client } from "@/lib/storage";

const execFileAsync = promisify(execFile);
const arg = process.argv[2] ?? "list";
const bucket = config.backup.bucket;
if (!bucket) {
  console.error("BACKUP_S3_BUCKET tanımlı değil.");
  process.exit(1);
}
const client = s3Client();

async function listAll(prefix: string) {
  const out: { Key: string; LastModified?: Date; Size?: number }[] = [];
  let token: string | undefined;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) out.push({ Key: o.Key, LastModified: o.LastModified, Size: o.Size });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => (a.LastModified?.getTime() ?? 0) - (b.LastModified?.getTime() ?? 0));
}

function confirm() {
  if (process.env.RESTORE_CONFIRM !== "evet") {
    console.error("Güvenlik için RESTORE_CONFIRM=evet ile çalıştırın.");
    process.exit(1);
  }
}

if (arg === "list") {
  for (const o of await listAll("db/")) console.log(`${o.LastModified?.toISOString()}  ${((o.Size ?? 0) / 1024).toFixed(0)} KB  ${o.Key}`);
} else if (arg === "media") {
  confirm();
  let copied = 0;
  for (const o of await listAll("media/")) {
    const key = o.Key.slice("media/".length);
    try {
      await client.send(new HeadObjectCommand({ Bucket: config.s3.bucket!, Key: key }));
      continue;
    } catch {
      /* ana kovada yok → geri kopyala */
    }
    await client.send(new CopyObjectCommand({ Bucket: config.s3.bucket!, Key: key, CopySource: `${bucket}/${encodeURI(o.Key)}` }));
    copied++;
  }
  console.log(`${copied} medya dosyası ana kovaya geri kopyalandı.`);
} else {
  confirm();
  const all = await listAll("db/");
  const key = arg === "latest" ? all.at(-1)?.Key : arg;
  if (!key) throw new Error("Döküm bulunamadı.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "restore-"));
  const file = path.join(dir, "restore.dump");
  const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await fs.writeFile(file, Buffer.from(await obj.Body!.transformToByteArray()));
  const u = new URL(config.databaseUrl);
  const env = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)) };
  console.log(`Geri yükleniyor: ${key}`);
  await execFileAsync(process.env.PG_RESTORE_PATH ?? "pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--single-transaction", "--dbname", env.PGDATABASE!, file], { env, timeout: 30 * 60_000, maxBuffer: 20 * 1024 * 1024 });
  await fs.rm(dir, { recursive: true, force: true });
  console.log("Geri yükleme tamamlandı. Servisleri yeniden başlatın ve panelden kontrol edin.");
}
