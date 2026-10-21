import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "@/lib/config";
import { analyzeImagePixels, frameDifference, type ColorShare } from "./pixels";

const execFileAsync = promisify(execFile);

// Yerel video analizi: ffprobe/ffmpeg ile GERÇEK karelerden ölçüm. Komutlar argüman dizisiyle çalıştırılır (kabuk yok),
// girdi yalnızca yerel dosya protokolüyle okunur (-protocol_whitelist file): yüklenen bir dosya ağ/çalma listesi
// referansı içerse bile ffmpeg dışarıya bağlanamaz.

const SAFE_INPUT = ["-protocol_whitelist", "file,pipe"];

export type VideoProbe = {
  duration: number;
  width: number;
  height: number;
  display_width: number;
  display_height: number;
  rotation: number;
  orientation: "portrait" | "landscape" | "square";
  fps: number | null;
  video_codec: string | null;
  bitrate: number | null;
  has_audio: boolean;
  audio_codec: string | null;
};

export type VideoFrame = { index: number; t: number; jpeg: Buffer; dominant_colors: ColorShare[]; brightness: number; sharpness: number };

export type LocalVideoAnalysis = {
  probe: VideoProbe;
  scenes: { index: number; start: number; end: number; frame_index: number; dominant_colors: string[]; brightness: number }[];
  frames: { index: number; t: number; dominant_colors: ColorShare[]; brightness: number; sharpness: number }[];
  motion: { average_difference: number; level: "statik" | "hafif" | "yoğun"; note: string };
  audio: { present: boolean; mean_db: number | null; max_db: number | null; silent: boolean | null };
  usability: { score: number; issues: string[] };
  recommendations: string[];
};

function parseFps(s: string | undefined): number | null {
  if (!s) return null;
  const [a, b] = s.split("/").map(Number);
  if (!a || !b) return null;
  return Math.round((a / b) * 100) / 100;
}

export async function probeVideo(file: string, timeoutMs = 60_000): Promise<VideoProbe> {
  const { stdout } = await execFileAsync(config.ffprobePath, [...SAFE_INPUT, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  const v = (info.streams ?? []).find((s: any) => s.codec_type === "video");
  if (!v) throw new Error("Dosyada video akışı yok.");
  const a = (info.streams ?? []).find((s: any) => s.codec_type === "audio");
  const sideRot = (v.side_data_list ?? []).find((d: any) => typeof d.rotation === "number")?.rotation;
  const rotation = Math.abs(Number(sideRot ?? v.tags?.rotate ?? 0)) % 360;
  const swap = rotation === 90 || rotation === 270;
  const dw = swap ? v.height : v.width, dh = swap ? v.width : v.height;
  const duration = Number(info.format?.duration ?? v.duration ?? 0);
  return {
    duration: Math.round(duration * 100) / 100,
    width: v.width, height: v.height, display_width: dw, display_height: dh, rotation,
    orientation: dw === dh ? "square" : dh > dw ? "portrait" : "landscape",
    fps: parseFps(v.avg_frame_rate) ?? parseFps(v.r_frame_rate),
    video_codec: v.codec_name ?? null,
    bitrate: info.format?.bit_rate ? Number(info.format.bit_rate) : null,
    has_audio: !!a,
    audio_codec: a?.codec_name ?? null,
  };
}

/** Sahne değişimleri (ffmpeg scene skoru). Hızlı olması için 320 px'e küçültülmüş akışta çalışır. */
export async function detectSceneCuts(file: string, duration: number, threshold = 0.3, timeoutMs = 120_000): Promise<number[]> {
  const { stderr } = await execFileAsync(config.ffmpegPath, ["-hide_banner", "-nostats", ...SAFE_INPUT, "-i", file, "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const cuts = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.3 && t < duration - 0.3);
  const out: number[] = [];
  for (const t of cuts) if (!out.length || t - out[out.length - 1] > 0.5) out.push(Math.round(t * 100) / 100);
  return out;
}

export async function extractFrame(file: string, t: number, width = 768, timeoutMs = 30_000): Promise<Buffer> {
  const { stdout } = await execFileAsync(config.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-ss", t.toFixed(3), ...SAFE_INPUT, "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "-"], { timeout: timeoutMs, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
  if (!stdout.length) throw new Error(`${t} sn'de kare çıkarılamadı.`);
  return stdout;
}

async function audioLevels(file: string, timeoutMs = 120_000) {
  const { stderr } = await execFileAsync(config.ffmpegPath, ["-hide_banner", "-nostats", ...SAFE_INPUT, "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const max = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  return { mean_db: mean ? Number(mean[1]) : null, max_db: max ? Number(max[1]) : null };
}

/** Kare planı: her sahnenin ortası; tek uzun sahnede eşit aralıklı örnekler. Toplam en fazla `max` kare. */
export function planKeyframes(duration: number, cuts: number[], max = 6): { scenes: { start: number; end: number }[]; times: number[]; sceneOf: number[] } {
  const bounds = [0, ...cuts, duration];
  let scenes = bounds.slice(0, -1).map((s, i) => ({ start: s, end: bounds[i + 1] }));
  if (scenes.length > max) {
    // En uzun sahneleri koru, sırayı bozma
    const keep = new Set([...scenes].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, max));
    scenes = scenes.filter((s) => keep.has(s));
  }
  const times: number[] = [];
  const sceneOf: number[] = [];
  scenes.forEach((s, i) => {
    const len = s.end - s.start;
    const n = scenes.length === 1 ? Math.min(max, len > 6 ? 3 : 1) : 1;
    for (let k = 0; k < n; k++) {
      times.push(Math.round((s.start + (len * (k + 0.5)) / n) * 100) / 100);
      sceneOf.push(i);
    }
  });
  return { scenes, times, sceneOf };
}

export async function analyzeVideoLocal(file: string, opts: { maxFrames?: number; timeoutMs?: number } = {}): Promise<{ analysis: LocalVideoAnalysis; frames: VideoFrame[] }> {
  const probe = await probeVideo(file);
  if (probe.duration <= 0) throw new Error("Video süresi okunamadı.");
  const cuts = await detectSceneCuts(file, probe.duration, 0.3, opts.timeoutMs);
  const plan = planKeyframes(probe.duration, cuts, opts.maxFrames ?? 6);

  const frames: VideoFrame[] = [];
  for (let i = 0; i < plan.times.length; i++) {
    const jpeg = await extractFrame(file, Math.min(plan.times[i], Math.max(0, probe.duration - 0.05)));
    const px = await analyzeImagePixels(jpeg);
    frames.push({ index: i, t: plan.times[i], jpeg, dominant_colors: px.dominant_colors, brightness: px.brightness, sharpness: px.sharpness });
  }

  // Hareket: birkaç noktada 0,4 sn arayla iki kare farkı
  const diffs: number[] = [];
  // Sahne kesmesini kapsayan çiftler hareket sayılmaz
  const probes = [0.15, 0.35, 0.55, 0.75].map((f) => f * probe.duration)
    .filter((t) => t + 0.4 < probe.duration && !cuts.some((c) => c >= t - 0.05 && c <= t + 0.45));
  for (const t of probes) {
    const [a, b] = await Promise.all([extractFrame(file, t, 256), extractFrame(file, t + 0.4, 256)]);
    diffs.push(await frameDifference(a, b));
  }
  const avgDiff = diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : 0;
  const level = avgDiff < 3 ? "statik" : avgDiff < 15 ? "hafif" : "yoğun";

  const audio = probe.has_audio ? await audioLevels(file).catch(() => ({ mean_db: null, max_db: null })) : { mean_db: null, max_db: null };
  const silent = probe.has_audio && audio.mean_db !== null ? audio.mean_db < -50 : null;

  const issues: string[] = [];
  if (probe.duration < 1.5) issues.push("çok kısa (< 1,5 sn)");
  if (Math.min(probe.display_width, probe.display_height) < 720) issues.push("düşük çözünürlük (kısa kenar < 720 px)");
  if (frames.some((f) => f.brightness < 45)) issues.push("karanlık kareler var");
  if (frames.length && frames.every((f) => f.sharpness < 20)) issues.push("kareler bulanık olabilir");
  if (probe.fps !== null && probe.fps < 20) issues.push(`düşük kare hızı (${probe.fps} fps)`);
  if (level === "yoğun") issues.push("yoğun hareket / titreme olabilir — insan kontrolü önerilir");

  const recs: string[] = [];
  if (probe.orientation === "portrait") recs.push("Dikey çekim: Reels, TikTok ve Stories için doğrudan uygun.");
  else recs.push("Yatay/kare çekim: dikey formatta kırpma veya kenar boşluğu gerekir.");
  if (plan.scenes.length > 1) recs.push(`${plan.scenes.length} ayrı sahne bulundu; kurguda ayrı klipler olarak kullanılabilir.`);
  if (probe.duration >= 3 && probe.duration <= 15) recs.push("Süre kısa video formatına uygun.");
  if (silent) recs.push("Ses yok veya çok sessiz; müzik/altyazı ile desteklenmeli.");

  return {
    analysis: {
      probe,
      scenes: plan.scenes.map((s, i) => {
        const fi = plan.sceneOf.indexOf(i);
        return { index: i, start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100, frame_index: fi, dominant_colors: (frames[fi]?.dominant_colors ?? []).slice(0, 3).map((c) => c.name), brightness: frames[fi]?.brightness ?? 0 };
      }),
      frames: frames.map(({ jpeg: _j, ...f }) => f),
      motion: { average_difference: Math.round(avgDiff * 10) / 10, level, note: "Ardışık kareler arasındaki piksel farkına dayanır; kamera hareketi ile nesne hareketini ayırt etmez." },
      audio: { present: probe.has_audio, mean_db: audio.mean_db, max_db: audio.max_db, silent },
      usability: { score: Math.max(0, 100 - issues.length * 15), issues },
      recommendations: recs,
    },
    frames,
  };
}
