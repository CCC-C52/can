import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CopyObjectCommand, HeadObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "@/lib/config";

// Dosya depolama adaptörü. Yerelde ./data/storage, üretimde S3 uyumlu servis.

export interface StorageAdapter {
  readonly driver: "local" | "s3";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Belleğe almadan okuma akışı; isteğe bağlı bayt aralığı (her iki uç dahil). */
  stream(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
  /** Büyük dosyaları belleğe almadan yerel dosyaya akıtır. */
  downloadToFile(key: string, file: string): Promise<number>;
  /** Yerel dosyayı belleğe almadan yükler. */
  putFile(key: string, file: string, contentType: string): Promise<void>;
  copy(src: string, dst: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  // Parçalı yükleme
  multipartStart(key: string, contentType: string): Promise<string>;
  multipartPut(key: string, uploadId: string, part: number, data: Buffer): Promise<void>;
  multipartList(key: string, uploadId: string): Promise<{ part: number; size: number; etag: string }[]>;
  multipartComplete(key: string, uploadId: string): Promise<void>;
  multipartAbort(key: string, uploadId: string): Promise<void>;
  /** Doğrudan tarayıcı yüklemesi için imzalı parça adresi (yalnızca S3). */
  multipartPartUrl?(key: string, uploadId: string, part: number, expiresIn: number): Promise<string>;
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
  async stream(key: string, range?: { start: number; end: number }) {
    const f = this.file(key);
    await fs.access(f);
    return Readable.toWeb(createReadStream(f, range ? { start: range.start, end: range.end } : {})) as ReadableStream<Uint8Array>;
  }
  async downloadToFile(key: string, file: string) {
    await fs.copyFile(this.file(key), file);
    return (await fs.stat(file)).size;
  }
  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }
  async putFile(key: string, file: string) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.copyFile(file, f);
  }
  async copy(src: string, dst: string) {
    const d = this.file(dst);
    await fs.mkdir(path.dirname(d), { recursive: true });
    await fs.copyFile(this.file(src), d);
  }
  async exists(key: string) {
    return fs.stat(this.file(key)).then(() => true, () => false);
  }
  private partsDir(key: string, uploadId: string) {
    return this.file(`${key}.parts/${safeKey(uploadId)}`);
  }
  async multipartStart(key: string) {
    const id = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await fs.mkdir(this.partsDir(key, id), { recursive: true });
    return id;
  }
  async multipartPut(key: string, uploadId: string, part: number, data: Buffer) {
    const dir = this.partsDir(key, uploadId);
    const tmp = path.join(dir, `.p${part}.${process.pid}.tmp`);
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path.join(dir, `p${String(part).padStart(5, "0")}`)); // atomik: yarım parça görünmez
  }
  async multipartList(key: string, uploadId: string) {
    const dir = this.partsDir(key, uploadId);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const out = [];
    for (const n of names.filter((x) => /^p\d{5}$/.test(x))) {
      const st = await fs.stat(path.join(dir, n));
      out.push({ part: Number(n.slice(1)), size: st.size, etag: `${st.size}-${st.mtimeMs}` });
    }
    return out.sort((a, b) => a.part - b.part);
  }
  async multipartComplete(key: string, uploadId: string) {
    const dir = this.partsDir(key, uploadId);
    const parts = await this.multipartList(key, uploadId);
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    const handle = await fs.open(f, "w");
    try {
      for (const p of parts) await handle.write(await fs.readFile(path.join(dir, `p${String(p.part).padStart(5, "0")}`)));
    } finally {
      await handle.close();
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
  async multipartAbort(key: string, uploadId: string) {
    await fs.rm(this.partsDir(key, uploadId), { recursive: true, force: true });
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
  async stream(key: string, range?: { start: number; end: number }) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
    return res.Body!.transformToWebStream() as ReadableStream<Uint8Array>;
  }
  async downloadToFile(key: string, file: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    const { createWriteStream } = await import("node:fs");
    const { pipeline } = await import("node:stream/promises");
    await pipeline(res.Body as NodeJS.ReadableStream, createWriteStream(file));
    return (await fs.stat(file)).size;
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
  }
  async putFile(key: string, file: string, contentType: string) {
    const st = await fs.stat(file);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: createReadStream(file), ContentLength: st.size, ContentType: contentType }));
  }
  async copy(src: string, dst: string) {
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: safeKey(dst), CopySource: `${this.bucket}/${encodeURI(safeKey(src))}` }));
  }
  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
      return true;
    } catch (err) {
      if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 || (err as Error).name === "NotFound") return false;
      throw err;
    }
  }
  async multipartStart(key: string, contentType: string) {
    const r = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: safeKey(key), ContentType: contentType }));
    if (!r.UploadId) throw new Error("Depolama parçalı yükleme kimliği döndürmedi.");
    return r.UploadId;
  }
  async multipartPut(key: string, uploadId: string, part: number, data: Buffer) {
    await this.client.send(new UploadPartCommand({ Bucket: this.bucket, Key: safeKey(key), UploadId: uploadId, PartNumber: part, Body: data, ContentLength: data.length }));
  }
  async multipartList(key: string, uploadId: string) {
    const out: { part: number; size: number; etag: string }[] = [];
    let marker: string | undefined;
    do {
      const r = await this.client.send(new ListPartsCommand({ Bucket: this.bucket, Key: safeKey(key), UploadId: uploadId, PartNumberMarker: marker }));
      for (const p of r.Parts ?? []) out.push({ part: p.PartNumber!, size: p.Size ?? 0, etag: p.ETag! });
      marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
    } while (marker);
    return out.sort((a, b) => a.part - b.part);
  }
  async multipartComplete(key: string, uploadId: string) {
    // ETag'ler istemciden değil, depolamanın kendi listesinden alınır
    const parts = await this.multipartList(key, uploadId);
    await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: safeKey(key), UploadId: uploadId, MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.part, ETag: p.etag })) } }));
  }
  async multipartAbort(key: string, uploadId: string) {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: safeKey(key), UploadId: uploadId })).catch(() => {});
  }
  async multipartPartUrl(key: string, uploadId: string, part: number, expiresIn: number) {
    return getSignedUrl(this.client, new UploadPartCommand({ Bucket: this.bucket, Key: safeKey(key), UploadId: uploadId, PartNumber: part }), { expiresIn });
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
/** Yalnızca testler: depolama sürücüsünü değiştirmek için. */
export function __setStorageForTests(s: StorageAdapter | null) {
  cached = s;
}
export function getStorage(): StorageAdapter {
  if (!cached) cached = config.storageDriver === "s3" ? new S3Storage() : new LocalStorage();
  return cached;
}
