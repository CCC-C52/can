import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "@/lib/config";
import { assertDecodes } from "@/lib/adapters/ffmpeg";
import { PermanentError } from "@/lib/models/types";
import { sha256File } from "@/lib/services/media";
import { getStorage } from "@/lib/storage";

const execFileAsync = promisify(execFile);

// Teslim edilen MP4'ün deterministik doğrulaması (AI kullanılmaz): ffprobe ile codec, piksel biçimi, boyut, süre ve ses izi;
// ffmpeg ile baştan sona hatasız çözme ("ffmpeg -v error -i out.mp4 -f null -"). Depoya yazılan dosya geri okunup
// bayt bayt (sha256) karşılaştırılır. Bu kontrollerden geçmeyen dosya hiçbir zaman "üretildi" sayılmaz.

export class VideoVerificationError extends PermanentError {}

export type VideoEvidence = {
  video_codec: string | null; profile: string | null; pix_fmt: string | null; width: number; height: number; fps: number | null;
  duration_s: number; audio_codec: string | null; audio_sample_rate: number | null; audio_channels: number | null;
  bytes: number; decoded: boolean;
};

export type VideoExpectation = {
  width: number;
  height: number;
  /** Beklenen süre (±0,5 sn) veya kabul aralığı. */
  duration?: number;
  minDuration?: number | null;
  maxDuration?: number | null;
  /** aac: AAC ses izi zorunlu; any: varsa kabul. */
  audio: "aac" | "any";
};

/** ffprobe ile akış bilgileri (yalnızca yerel dosya protokolü). */
export async function inspectVideo(file: string, timeoutMs = 60_000): Promise<Omit<VideoEvidence, "decoded">> {
  const { stdout } = await execFileAsync(config.ffprobePath, ["-protocol_whitelist", "file", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  const v = (info.streams ?? []).find((s: any) => s.codec_type === "video");
  if (!v) throw new VideoVerificationError("Dosyada video akışı yok.");
  const a = (info.streams ?? []).find((s: any) => s.codec_type === "audio");
  const [n, d] = String(v.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    video_codec: v.codec_name ?? null, profile: v.profile ?? null, pix_fmt: v.pix_fmt ?? null, width: v.width, height: v.height,
    fps: d ? Math.round((n / d) * 100) / 100 : null, duration_s: Math.round(Number(info.format?.duration ?? v.duration ?? 0) * 100) / 100,
    audio_codec: a?.codec_name ?? null, audio_sample_rate: a?.sample_rate ? Number(a.sample_rate) : null, audio_channels: a?.channels ?? null,
    bytes: (await fs.stat(file)).size,
  };
}

/** Teslim şartları: H.264, yuv420p, hedef boyut, süre, (gerekirse) AAC ses; ardından tam çözme. Uymazsa VideoVerificationError. */
export async function verifyVideoFile(file: string, expect: VideoExpectation, timeoutMs = 120_000): Promise<VideoEvidence> {
  const e = await inspectVideo(file);
  const problems: string[] = [];
  if (!(e.bytes > 0)) problems.push("dosya boş");
  if (e.video_codec !== "h264") problems.push(`codec ${e.video_codec} (beklenen h264)`);
  if (e.pix_fmt !== "yuv420p") problems.push(`piksel biçimi ${e.pix_fmt} (beklenen yuv420p)`);
  if (e.width !== expect.width || e.height !== expect.height) problems.push(`boyut ${e.width}x${e.height} (beklenen ${expect.width}x${expect.height})`);
  if (expect.duration !== undefined && Math.abs(e.duration_s - expect.duration) > 0.5) problems.push(`süre ${e.duration_s} sn (beklenen ${expect.duration.toFixed(2)})`);
  if (expect.minDuration != null && e.duration_s < expect.minDuration - 0.05) problems.push(`süre ${e.duration_s} sn, en az ${expect.minDuration} sn olmalı`);
  if (expect.maxDuration != null && e.duration_s > expect.maxDuration + 0.05) problems.push(`süre ${e.duration_s} sn, en fazla ${expect.maxDuration} sn olmalı`);
  if (expect.audio === "aac" && e.audio_codec !== "aac") problems.push(`ses izi ${e.audio_codec ?? "yok"} (beklenen AAC)`);
  if (problems.length) throw new VideoVerificationError(`MP4 doğrulaması başarısız: ${problems.join(", ")}`);
  try {
    await assertDecodes(file, timeoutMs);
  } catch (err) {
    throw new VideoVerificationError(`MP4 hatasız çözülemedi: ${(err as Error).message}`);
  }
  return { ...e, decoded: true };
}

/** Depodaki kopya üretilen dosyayla aynı mı: dosya depodan GERİ okunur, boyut ve sha256 karşılaştırılır. */
export async function verifyStoredBytes(asset: { storage_key: string; size_bytes: number | string; sha256: string }, file: string) {
  const storage = getStorage();
  if (!(await storage.exists(asset.storage_key))) throw new VideoVerificationError("MP4 depoda bulunamadı.");
  const size = await storage.downloadToFile(asset.storage_key, file);
  if (size !== Number(asset.size_bytes)) throw new VideoVerificationError(`Depodaki dosya boyutu farklı (${size} / ${asset.size_bytes} bayt).`);
  const hash = await sha256File(file);
  if (hash !== asset.sha256) throw new VideoVerificationError("Depodaki dosya üretilen dosyayla bayt bayt aynı değil (sha256 uyuşmuyor).");
  return hash;
}

/**
 * Depodaki kopyanın tam doğrulaması: bayt eşliği (verifyStoredBytes) + okunan kopyanın teslim şartları ve tam çözme
 * (arşivden açılan dosya oynatılabilir). Başarısızsa VideoVerificationError.
 */
export async function verifyStoredVideo(asset: { storage_key: string; size_bytes: number | string; sha256: string }, expect: VideoExpectation): Promise<VideoEvidence & { sha256: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-"));
  try {
    const file = path.join(dir, "stored.mp4");
    const hash = await verifyStoredBytes(asset, file);
    return { ...(await verifyVideoFile(file, expect)), sha256: hash };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
