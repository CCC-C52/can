import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "@/lib/config";
import { probeVideo, extractFrame, type VideoProbe } from "@/lib/media-analysis/video";
import { composeDesign } from "./compose";

const execFileAsync = promisify(execFile);

// Mevcut çekimleri yerel ffmpeg ile düzenler (AI değildir): bölüm seçme, hedef formata sığdırma/doldurma,
// kesme veya geçiş (xfade), giriş/kapanış kartı, altyazı ve ekran metni, kapak karesi. Orijinal dosyalar değiştirilmez.
// Ses kaldırılır (müzik/ses lisansı manuel karardır). Çıktı ffprobe ile doğrulanmadan başarılı sayılmaz.

export const EDIT_SIZES: Record<string, [number, number]> = { "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350], "16:9": [1920, 1080] };
const SAFE_INPUT = ["-protocol_whitelist", "file,pipe"];
const FPS = 30;
export const TRANSITION_S = 0.5;
export const CARD_S = 2;

export type Cue = { start: number; end: number; text: string };
export type EditClip = { file: string; start: number; duration: number; sourceDuration: number | null };
export type EditArgs = {
  clips: EditClip[];
  format: string;
  framing?: "fit" | "fill";
  transition?: "cut" | "fade";
  subtitles?: Cue[];            // alt bölgede
  onScreenText?: Cue[];         // üst bölgede
  intro?: { text: string; bg: string; accent: string; font?: string; logo?: Buffer };
  outro?: { text: string; bg: string; accent: string; font?: string; logo?: Buffer };
  timeoutMs?: number;
  signal?: AbortSignal;
};
export type EditResult = { video: Buffer; thumbnail: Buffer; srt: string; probe: VideoProbe; expectedDuration: number };

export function toSrt(subs: Cue[]): string {
  const ts = (s: number) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), r = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(r).padStart(3, "0")}`;
  };
  return subs.filter((s) => s.text.trim() && s.end > s.start).map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.text.replace(/\r?\n/g, " ").trim()}\n`).join("\n");
}

/** Bölüm süreleri ve geçişlere göre toplam süre ile her bölümün çıktıdaki başlangıcı. */
export function timeline(durations: number[], transition: "cut" | "fade") {
  const td = transition === "fade" && durations.length > 1 ? Math.min(TRANSITION_S, ...durations.map((d) => d / 3)) : 0;
  const starts: number[] = [];
  let t = 0;
  for (let i = 0; i < durations.length; i++) {
    starts.push(t);
    t += durations[i] - (i < durations.length - 1 ? td : 0);
  }
  return { starts, total: t, td };
}

function shift(cues: Cue[] | undefined, by: number, max: number): Cue[] {
  return (cues ?? []).map((c) => ({ start: c.start + by, end: Math.min(max, c.end + by), text: c.text })).filter((c) => c.end > c.start);
}

function escFilterPath(p: string) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export async function renderEdit(args: EditArgs): Promise<EditResult> {
  const [W, H] = EDIT_SIZES[args.format] ?? EDIT_SIZES["9:16"];
  const framing = args.framing ?? "fit";
  const transition = args.transition ?? "cut";
  if (!args.clips.length) throw new Error("Kurgu için en az bir çekim gerekir.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "render-"));
  try {
    const inputs: string[] = [];
    const segs: { label: string; dur: number }[] = [];
    const filters: string[] = [];
    // fit: ürün kırpılmaz (kenar boşluğu); fill: kadraj doldurulur (kenarlar kırpılabilir)
    const norm = framing === "fill"
      ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
    let idx = 0;

    const addCard = async (card: NonNullable<EditArgs["intro"]>, name: string) => {
      const img = await composeDesign({ mode: "typography", purpose: "reel_cover", format: args.format, headline: card.text, bg: card.bg, accent: card.accent, font: card.font, logo: card.logo });
      const f = path.join(dir, `${name}.png`);
      await fs.writeFile(f, img.buffer);
      inputs.push(...SAFE_INPUT, "-loop", "1", "-framerate", String(FPS), "-t", CARD_S.toFixed(2), "-i", f);
      filters.push(`[${idx}:v]scale=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,trim=duration=${CARD_S},setpts=PTS-STARTPTS[s${idx}]`);
      segs.push({ label: `s${idx}`, dur: CARD_S });
      idx++;
    };

    if (args.intro?.text.trim()) await addCard(args.intro, "intro");
    const introDur = segs.length ? CARD_S : 0;
    for (const c of args.clips) {
      const start = Math.max(0, c.sourceDuration ? Math.min(c.start, Math.max(0, c.sourceDuration - 0.5)) : c.start);
      const avail = c.sourceDuration ? c.sourceDuration - start : c.duration;
      const dur = Math.max(0.5, Math.min(c.duration, avail));
      inputs.push(...SAFE_INPUT, "-ss", start.toFixed(2), "-t", dur.toFixed(2), "-i", c.file);
      filters.push(`[${idx}:v]${norm},setsar=1,fps=${FPS},format=yuv420p,trim=duration=${dur.toFixed(2)},setpts=PTS-STARTPTS[s${idx}]`);
      segs.push({ label: `s${idx}`, dur });
      idx++;
    }
    if (args.outro?.text.trim()) await addCard(args.outro, "outro");

    // Birleştirme: kesme → concat; geçiş → zincirleme xfade
    const tl = timeline(segs.map((s) => s.dur), transition);
    if (segs.length === 1) filters.push(`[${segs[0].label}]null[cat]`);
    else if (tl.td > 0) {
      let prev = segs[0].label;
      for (let i = 1; i < segs.length; i++) {
        const out = i === segs.length - 1 ? "cat" : `x${i}`;
        filters.push(`[${prev}][${segs[i].label}]xfade=transition=fade:duration=${tl.td.toFixed(3)}:offset=${tl.starts[i].toFixed(3)}[${out}]`);
        prev = out;
      }
    } else filters.push(`${segs.map((s) => `[${s.label}]`).join("")}concat=n=${segs.length}:v=1:a=0[cat]`);

    // Altyazılar video zaman çizelgesine göre yazılır; giriş kartı kadar kaydırılır
    const total = tl.total;
    const subs = shift(args.subtitles, introDur, total);
    const top = shift(args.onScreenText, introDur, total);
    const srt = toSrt(subs);
    let last = "cat";
    // libass boyutları 288 piksel yüksekliğe göre ölçeklenir (PlayResY=288): değerler video yüksekliğinden bağımsızdır.
    // Altyazı alt güvenli alanın (arayüz) üstünde, ekran metni üst güvenli alanın altında durur.
    const tall = H / W > 1.5;
    if (srt.trim()) {
      const p = path.join(dir, "subs.srt");
      await fs.writeFile(p, srt, "utf8");
      filters.push(`[${last}]subtitles=filename='${escFilterPath(p)}':force_style='FontName=DejaVu Sans,FontSize=${tall ? 9 : 11},Outline=1,Shadow=0,Alignment=2,MarginV=${tall ? 60 : 18},MarginL=16,MarginR=16'[sub]`);
      last = "sub";
    }
    const topSrt = toSrt(top);
    if (topSrt.trim()) {
      const p = path.join(dir, "top.srt");
      await fs.writeFile(p, topSrt, "utf8");
      filters.push(`[${last}]subtitles=filename='${escFilterPath(p)}':force_style='FontName=DejaVu Sans,FontSize=${tall ? 12 : 14},Bold=1,Outline=1.5,Shadow=0,Alignment=6,MarginV=${tall ? 40 : 16},MarginL=16,MarginR=16'[ost]`);
      last = "ost";
    }
    filters.push(`[${last}]format=yuv420p[out]`);

    const out = path.join(dir, "out.mp4");
    await execFileAsync(
      config.ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[out]", "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart", out],
      { timeout: args.timeoutMs ?? 300_000, signal: args.signal, maxBuffer: 10 * 1024 * 1024 },
    );
    const probe = await validateRender(out, { width: W, height: H, duration: total });
    const thumbnail = await extractFrame(out, Math.min(total - 0.1, introDur + Math.min(1, segs[introDur ? 1 : 0].dur / 2)), W);
    return { video: await fs.readFile(out), thumbnail, srt, probe, expectedDuration: Math.round(total * 100) / 100 };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Çıktı doğrulaması: H.264, hedef boyut, beklenen süre (±0,5 sn). Uymayan dosya başarı sayılmaz. */
export async function validateRender(file: string, expect: { width: number; height: number; duration: number }) {
  const probe = await probeVideo(file);
  const problems: string[] = [];
  if (probe.video_codec !== "h264") problems.push(`codec ${probe.video_codec}`);
  if (probe.width !== expect.width || probe.height !== expect.height) problems.push(`boyut ${probe.width}x${probe.height} (beklenen ${expect.width}x${expect.height})`);
  if (Math.abs(probe.duration - expect.duration) > 0.5) problems.push(`süre ${probe.duration} sn (beklenen ${expect.duration.toFixed(2)})`);
  if (problems.length) throw new Error(`Render doğrulaması başarısız: ${problems.join(", ")}`);
  return probe;
}
