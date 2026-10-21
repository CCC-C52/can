import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { initUpload, putPart, completeUpload, abortUpload, uploadedParts, runUploadQueueOnce, partTargets, PART_SIZE, UploadError } from "@/lib/uploads";
import { getStorage } from "@/lib/storage";
import { latestAnalysis } from "@/lib/media-analysis";
import { productPhoto, colorScenesVideo } from "./fixtures";
import sharp from "sharp";

function stream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (let i = 0; i < buf.length; i += 65536) c.enqueue(buf.subarray(i, i + 65536)); c.close(); } });
}
const slice = (buf: Buffer, n: number) => buf.subarray((n - 1) * PART_SIZE, n * PART_SIZE);

async function uploadAll(brandId: string, buf: Buffer, name: string, key = `${name}|${buf.length}|1`, skip: number[] = []) {
  const init = await initUpload(brandId, { filename: name, size: buf.length, clientKey: key });
  for (let n = 1; n <= init.session.part_count; n++) {
    if (init.uploadedParts.includes(n) || skip.includes(n)) continue;
    await putPart(brandId, init.session.id, n, stream(slice(buf, n)));
  }
  return init;
}
async function drainUploads() {
  for (let i = 0; i < 10; i++) if (!(await runUploadQueueOnce("up-w"))) break;
}

/** 8 MB'tan büyük, sıkıştırılmamış rastgele baytlar içeren video kabı (çok parçalı akışı denemek için). */
async function bigVideo(fill = 7) {
  const v = await colorScenesVideo([{ color: "green", seconds: 2 }]);
  // MP4 kabının sonuna sıfır olmayan veri eklemek oynatmayı bozmaz; ffprobe yine okur ve dosya çok parçalı olur.
  return Buffer.concat([v, Buffer.alloc(PART_SIZE * 2 + 12345, fill)]);
}

let brandId: string;
beforeAll(async () => { brandId = (await createBrand({ name: "Upload Brand" })).id; });

describe("Parçalı yükleme (yerel depolama)", () => {
  it("fotoğraf: hazırlama → yükleme → doğrulama → tamamlandı; analiz kuyruğa girer", async () => {
    const buf = await productPhoto("#d01c1c");
    const init = await uploadAll(brandId, buf, "foto.jpg");
    expect(init.session.status).toBe("uploading");
    const c = await completeUpload(brandId, init.session.id);
    expect(c.status).toBe("verifying");
    await drainUploads();
    const s = await q1<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [init.session.id]);
    expect(s.status).toBe("completed");
    const asset = await q1<any>(`SELECT * FROM media_assets WHERE id = $1`, [s.asset_id]);
    expect(asset.brand_id).toBe(brandId);
    expect(asset.mime_type).toBe("image/jpeg");
    expect(Number(asset.size_bytes)).toBe(buf.length);
    expect((await sharp(await getStorage().get(asset.storage_key)).metadata()).width).toBe(1200);
    expect(await getStorage().exists(init.session.temp_key)).toBe(false); // geçici dosya temizlendi
    expect(await latestAnalysis(brandId, asset.id)).not.toBeNull();
  });

  it("büyük video çok parçalı yüklenir; kesinti sonrası yalnızca eksik parçalar gönderilir", async () => {
    const buf = await bigVideo();
    const first = await uploadAll(brandId, buf, "big.mp4", "big|1", [2, 3]); // 2. ve 3. parça "kesildi"
    expect(first.session.part_count).toBe(3);
    await expect(completeUpload(brandId, first.session.id)).rejects.toThrow(/Eksik parçalar: 2, 3/);
    // Aynı dosya tekrar seçilir → aynı oturum, yüklü parçalar bildirilir
    const resumed = await initUpload(brandId, { filename: "big.mp4", size: buf.length, clientKey: "big|1" });
    expect(resumed.resumed).toBe(true);
    expect(resumed.session.id).toBe(first.session.id);
    expect(resumed.uploadedParts).toEqual([1]);
    for (const n of [2, 3]) await putPart(brandId, first.session.id, n, stream(slice(buf, n)));
    expect((await uploadedParts(brandId, first.session.id)).parts).toEqual([1, 2, 3]);
    await completeUpload(brandId, first.session.id);
    await completeUpload(brandId, first.session.id); // çift tamamlama zararsız
    await drainUploads();
    const s = await q1<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [first.session.id]);
    expect(s.status).toBe("completed");
    const asset = await q1<any>(`SELECT * FROM media_assets WHERE id = $1`, [s.asset_id]);
    expect(asset.kind).toBe("video");
    expect(Number(asset.size_bytes)).toBe(buf.length);
    const stored = await getStorage().get(asset.storage_key);
    expect(stored.equals(buf)).toBe(true);
  });

  it("aynı dosya ikinci kez yüklenince yeni kayıt oluşmaz", async () => {
    const buf = await productPhoto("#123456");
    const a = await uploadAll(brandId, buf, "dup.jpg", "dup-1");
    await completeUpload(brandId, a.session.id); await drainUploads();
    const b = await uploadAll(brandId, buf, "dup-copy.jpg", "dup-2");
    await completeUpload(brandId, b.session.id); await drainUploads();
    const sa = await q1<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [a.session.id]);
    const sb = await q1<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [b.session.id]);
    expect(sb.duplicate).toBe(true);
    expect(sb.asset_id).toBe(sa.asset_id);
  });

  it("uzantısı uygun ama içeriği sahte dosya doğrulamada reddedilir ve geçici veri silinir", async () => {
    const buf = Buffer.from("#!/bin/sh\necho not an image\n".repeat(10));
    const a = await uploadAll(brandId, buf, "evil.jpg", "evil-1");
    await completeUpload(brandId, a.session.id);
    await drainUploads();
    const s = await q1<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [a.session.id]);
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/Desteklenmeyen/);
    expect(s.asset_id).toBeNull();
    expect(await getStorage().exists(a.session.temp_key)).toBe(false);
  });

  it("sınır kontrolleri: boyut, tür, büyük/eksik parça, iptal, başka marka", async () => {
    await expect(initUpload(brandId, { filename: "x.exe", size: 10, clientKey: "k-exe" })).rejects.toThrow(UploadError);
    await expect(initUpload(brandId, { filename: "x.jpg", size: 10 ** 13, clientKey: "k-big" })).rejects.toThrow(/çok büyük/);
    const buf = await productPhoto("#00ff00");
    const s = (await initUpload(brandId, { filename: "p.jpg", size: buf.length, clientKey: "k-p" })).session;
    await expect(putPart(brandId, s.id, 1, stream(Buffer.concat([buf, Buffer.from("extra")])))).rejects.toThrow(/büyük/);
    await expect(putPart(brandId, s.id, 1, stream(buf.subarray(0, 10)))).rejects.toThrow(/eksik/);
    await expect(putPart(brandId, s.id, 2, stream(buf))).rejects.toThrow(/Geçersiz parça/);
    const other = await createBrand({ name: "Upload Other" });
    await expect(putPart(other.id, s.id, 1, stream(buf))).rejects.toThrow(/bulunamadı/);
    await expect(partTargets(other.id, s.id, [1])).rejects.toThrow(/bulunamadı/);
    const ab = await abortUpload(brandId, s.id);
    expect(ab.status).toBe("aborted");
    await expect(putPart(brandId, s.id, 1, stream(buf))).rejects.toThrow(/kapandı/);
  });
});

// S3 uyumlu sunucuyla (moto/MinIO) aynı akış: TEST_S3_ENDPOINT=http://127.0.0.1:5055
const S3 = process.env.TEST_S3_ENDPOINT;
describe.skipIf(!S3)("Parçalı yükleme (S3 uyumlu depolama)", () => {
  const saved = { ...process.env };
  afterEach(() => { for (const k of ["STORAGE_DRIVER", "S3_BUCKET", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  it("çok parçalı video S3 multipart ile birleştirilir, doğrulanır, kalıcı anahtara kopyalanır", async () => {
    const { S3Client, CreateBucketCommand } = await import("@aws-sdk/client-s3");
    const bucket = `up-${Math.random().toString(36).slice(2, 8)}`;
    await new S3Client({ region: "us-east-1", endpoint: S3, forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } }).send(new CreateBucketCommand({ Bucket: bucket }));
    Object.assign(process.env, { STORAGE_DRIVER: "s3", S3_BUCKET: bucket, S3_ENDPOINT: S3, S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test", S3_FORCE_PATH_STYLE: "true" });
    const storage = await import("@/lib/storage");
    const s3 = new storage.S3Storage();
    // getStorage önbelleğini bu test için S3'e çevir
    (storage as any).__setStorageForTests?.(s3);
    const buf = await bigVideo(9);
    const init = await uploadAll(brandId, buf, "s3big.mp4", "s3big|1", [3]);
    const resumed = await initUpload(brandId, { filename: "s3big.mp4", size: buf.length, clientKey: "s3big|1" });
    expect(resumed.uploadedParts).toEqual([1, 2]);
    await putPart(brandId, init.session.id, 3, stream(slice(buf, 3)));
    await completeUpload(brandId, init.session.id);
    await drainUploads();
    const s = await q1<any>(`SELECT * FROM upload_sessions WHERE id = $1`, [init.session.id]);
    expect(s.status).toBe("completed");
    const asset = await q1<any>(`SELECT * FROM media_assets WHERE id = $1`, [s.asset_id]);
    expect((await s3.get(asset.storage_key)).equals(buf)).toBe(true);
    expect(await s3.exists(init.session.temp_key)).toBe(false);
    (storage as any).__setStorageForTests?.(null);
  });
});
