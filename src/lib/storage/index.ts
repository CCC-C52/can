import fs from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { config } from "@/lib/config";

// Dosya depolama adaptörü. Yerelde ./data/storage, üretimde S3 uyumlu servis.

export interface StorageAdapter {
  readonly driver: "local" | "s3";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  check(): Promise<{ ok: boolean; detail: string }>;
}

function safeKey(key: string) {
  if (!/^[a-zA-Z0-9/_.\-]+$/.test(key) || key.includes("..")) throw new Error("Geçersiz depolama anahtarı");
  return key;
}

export class LocalStorage implements StorageAdapter {
  readonly driver = "local" as const;
  constructor(private root = path.resolve(process.cwd(), config.localStorageDir)) {}
  private file(key: string) {
    return path.join(this.root, safeKey(key));
  }
  async put(key: string, data: Buffer) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    // Orijinaller üzerine yazılmaz: aynı anahtar zaten varsa hata verilir.
    await fs.writeFile(f, data, { flag: "wx" }).catch(async (err) => {
      if (err.code === "EEXIST") {
        const existing = await fs.readFile(f);
        if (existing.equals(data)) return;
        throw new Error("Depolama anahtarı zaten kullanımda (orijinal dosya korunur).");
      }
      throw err;
    });
  }
  async get(key: string) {
    return fs.readFile(this.file(key));
  }
  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }
  async check() {
    await fs.mkdir(this.root, { recursive: true });
    return { ok: true, detail: `Yerel klasör: ${this.root}` };
  }
}

/** S3 uyumlu istemci (AWS S3, Cloudflare R2, MinIO). */
export function s3Client(): S3Client {
  const s = config.s3;
  if (!s.accessKeyId || !s.secretAccessKey) throw new Error("S3 erişim anahtarları eksik (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).");
  return new S3Client({
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
  });
}

export class S3Storage implements StorageAdapter {
  readonly driver = "s3" as const;
  private client: S3Client;
  private bucket: string;
  constructor() {
    const s = config.s3;
    if (!s.bucket || !s.accessKeyId || !s.secretAccessKey) throw new Error("S3 ayarları eksik (S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY).");
    this.bucket = s.bucket;
    this.client = s3Client();
  }
  async put(key: string, data: Buffer, contentType: string) {
    // Anahtarlar içerik özetinden (SHA-256) türetilir; aynı anahtara yazılan veri aynıdır, orijinal değişmez.
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: data, ContentType: contentType }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
  }
  async check() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, detail: `S3 kovası erişilebilir: ${this.bucket}` };
    } catch (err) {
      return { ok: false, detail: `S3 erişim hatası: ${(err as Error).name}` };
    }
  }
}

let cached: StorageAdapter | null = null;
export function getStorage(): StorageAdapter {
  if (!cached) cached = config.storageDriver === "s3" ? new S3Storage() : new LocalStorage();
  return cached;
}
