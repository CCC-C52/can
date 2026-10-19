import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { S3Client, CreateBucketCommand, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { submitInstruction, listTasks, retryWaitingConnections } from "@/lib/orchestrator/projects";
import { Engine } from "@/lib/orchestrator/engine";
import { seedSampleBrand } from "@/lib/services/sample";
import { textModelMode, setTextModelOverride } from "@/lib/models";
import { DemoAdapter } from "@/lib/models/demo";
import { assertProductionConfig } from "@/lib/config";
import { encryptSecret, decryptSecret } from "@/lib/security/crypto";
import { loginLocked, recordLoginFailure, clearLoginFailures, signSession, verifySession } from "@/lib/auth";
import { runUntilIdle, key } from "./helpers";

// Canlı (production) mod davranışları. Ortam değişkenleri her test sonunda geri alınır.
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["APP_MODE", "ADMIN_PASSWORD", "SESSION_SECRET", "ENCRYPTION_KEY", "STORAGE_DRIVER", "S3_BUCKET", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE", "BACKUP_S3_BUCKET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setTextModelOverride(null);
});

function production() {
  process.env.APP_MODE = "production";
  process.env.ADMIN_PASSWORD = "a-strong-test-password";
  process.env.SESSION_SECRET = "s".repeat(40);
  process.env.ENCRYPTION_KEY = "render-generated-value-that-is-not-base64-32-bytes!!";
  process.env.STORAGE_DRIVER = "s3";
}

describe("Canlı ortam", () => {
  it("eksik güvenlik ayarlarını raporlar", () => {
    process.env.APP_MODE = "production";
    delete process.env.ADMIN_PASSWORD;
    process.env.STORAGE_DRIVER = "local";
    const problems = assertProductionConfig();
    expect(problems.join(" ")).toMatch(/ADMIN_PASSWORD/);
    expect(problems.join(" ")).toMatch(/STORAGE_DRIVER=s3/);
    production();
    expect(assertProductionConfig()).toEqual([]);
  });

  it("DEMO kapalıdır: anahtar yoksa görev içerik üretmez, 'Bağlantı bekliyor' olur; örnek marka yüklenemez", async () => {
    production();
    expect(textModelMode().mode).toBe("off");
    await expect(seedSampleBrand()).rejects.toThrow(/Canlı ortamda/);
    const brand = await createBrand({ name: "Prod Brand" });
    const { project } = await submitInstruction({ brandId: brand.id, instruction: "Kısa bir kampanya stratejisi hazırla", idempotencyKey: key() });
    await runUntilIdle(new Engine("prod-w"));
    const plan = (await listTasks(brand.id, { projectId: project.id })).find((t) => t.key === "plan")!;
    expect(plan.status).toBe("waiting_connection");
    expect(plan.error).toMatch(/AI modeli bağlı değil/);
    const demo = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM output_versions WHERE brand_id = $1`, [brand.id]);
    expect(demo!.n).toBe(0);
    const calls = await q1<{ model_calls: number }>(`SELECT model_calls FROM projects WHERE id = $1`, [project.id]);
    expect(calls!.model_calls).toBe(0);

    // Anahtar eklenince (burada test adaptörüyle) "tekrar dene" görevi tamamlar
    setTextModelOverride(new DemoAdapter());
    expect(await retryWaitingConnections(brand.id)).toBe(1);
    await runUntilIdle(new Engine("prod-w2"));
    const after = (await listTasks(brand.id, { projectId: project.id })).find((t) => t.key === "plan")!;
    expect(after.status).toBe("completed");
  });

  it("barındırıcının ürettiği gizli değerle şifreleme çalışır", () => {
    production();
    const blob = encryptSecret({ token: "abc" });
    expect(decryptSecret<{ token: string }>(blob).token).toBe("abc");
  });

  it("oturum parola değişince geçersiz olur; hatalı girişler kilitlenir", () => {
    production();
    const s = signSession();
    expect(verifySession(s.value)).toBe(true);
    process.env.ADMIN_PASSWORD = "another-strong-password";
    expect(verifySession(s.value)).toBe(false);
    const ip = `test-${key()}`;
    for (let i = 0; i < 5; i++) recordLoginFailure(ip);
    expect(loginLocked(ip)).toBe(true);
    clearLoginFailures(ip);
    expect(loginLocked(ip)).toBe(false);
  });
});

// S3 uyumlu yerel sunucu (ör. moto/MinIO) varsa yedekleme uçtan uca denenir: TEST_S3_ENDPOINT=http://127.0.0.1:5055
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
describe.skipIf(!S3_ENDPOINT)("Yedekleme (S3 uyumlu yerel sunucu)", () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const main = `test-media-${suffix}`, backup = `test-backup-${suffix}`;
  const s3env = () => {
    process.env.STORAGE_DRIVER = "s3";
    process.env.S3_BUCKET = main;
    process.env.S3_ENDPOINT = S3_ENDPOINT!;
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "test";
    process.env.S3_SECRET_ACCESS_KEY = "test";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.BACKUP_S3_BUCKET = backup;
  };
  const client = () => new S3Client({ region: "us-east-1", endpoint: S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });

  beforeAll(async () => {
    for (const b of [main, backup]) await client().send(new CreateBucketCommand({ Bucket: b }));
  });
  it("veritabanı dökümünü ve medyayı yedek kovasına koyar", async () => {
    s3env();
    const { S3Storage } = await import("@/lib/storage");
    const brand = await createBrand({ name: "Backup Brand" });
    const store = new S3Storage();
    const k = `brands/${brand.id}/originals/abc.txt`;
    await store.put(k, Buffer.from("hello"), "text/plain");
    expect((await store.get(k)).toString()).toBe("hello");
    await q(`INSERT INTO media_assets (brand_id, kind, origin, filename, mime_type, size_bytes, sha256, storage_key) VALUES ($1,'document','design_file','abc.txt','text/plain',5,'abc',$2)`, [brand.id, k]);

    const { runBackup } = await import("@/lib/services/backup");
    const st = await runBackup("manual");
    expect(st.error).toBeUndefined();
    expect(st.ok).toBe(true);
    expect(st.mediaCopied).toBeGreaterThanOrEqual(1);
    const list = await client().send(new ListObjectsV2Command({ Bucket: backup }));
    const keys = (list.Contents ?? []).map((o) => o.Key);
    expect(keys).toContain(st.dbKey);
    expect(keys).toContain(`media/${k}`);
    const dump = await client().send(new GetObjectCommand({ Bucket: backup, Key: st.dbKey! }));
    const bytes = Buffer.from(await dump.Body!.transformToByteArray());
    expect(bytes.subarray(0, 5).toString()).toBe("PGDMP"); // pg_dump özel biçimi
  });
});
