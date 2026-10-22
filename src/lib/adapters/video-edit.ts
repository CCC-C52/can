import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeVideo, extractFrame, type VideoProbe } from "@/lib/media-analysis/video";
import { composeDesign } from "./compose";
import { FfmpegError, assertDecodes, runFfmpeg, withFfmpegSlot } from "./ffmpeg";


// Mevcut çekimleri yerel ffmpeg ile düzenler (AI değildir): bölüm seçme, hedef formata sığdırma/doldurma,
// kesme veya geçiş (xfade), giriş/kapanış kartı, altyazı ve ekran metni, kapak karesi. Orijinal dosyalar değiştirilmez.
// Ses kaldırılır (müzik/ses lisansı manuel karardır). Çıktı ffprobe ile doğrulanmadan başarılı sayılmaz.

export const EDIT_SIZES: Record<string, [number, number]> = { "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350], "16:9": [1920, 1080] };
// Her girdi için: yalnızca yerel dosya protokolü ve tek iş parçacıklı çözücü (çok girdili kurguda bellek tasarrufu)
const SAFE_INPUT = ["-protocol_whitelist", "file,pipe", "-threads", "1"];
const FPS = 30;
export const TRANSITION_S = 0.5;
export const CARD_S = 2;
export const MAX_SEGMENTS = 12;
const FFMPEG_THREADS = Math.max(1, Math.min(8, Number(process.env.FFMPEG_THREADS ?? 2) || 2));

export type Cue = { start: number; end: number; text: string };
/** Kaynak bölüm: `start`/`duration` KAYNAK dosyadaki zamandır. `text` bölüm boyunca ekranda görünür (çıktı konumu otomatik). */
export type EditClip = { file: string; start: number; duration: number; sourceDuration: number | null; text?: string };
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
export type EditResult = { video: Buffer; thumbnail: Buffer; srt: string; probe: VideoProbe; expectedDuration: number; overlays: Cue[] };

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

/**
 * Kurgu: düşük bellekli, aşamalı ffmpeg hattı (512 MB'lık işleyici için).
 *  1) Her bölüm/kart AYRI bir ffmpeg süreciyle hedef boyuta getirilir (aynı anda tek çözücü).
 *  2) Kesme: aynı parametreli ara dosyalar akış kopyasıyla birleştirilir (çözme yok).
 *     Geçiş: ara dosyalar ikişer ikişer xfade ile birleştirilir (aynı anda iki çözücü).
 *  3) Son geçiş: altyazı + ekran metni + H.264 (yuv420p, faststart) — Instagram Reels uyumlu.
 *  4) Doğrulama: ffprobe (codec, boyut, süre) + baştan sona hatasız çözme.
 * Kaynak zamanları (EditClip.start/duration) ile çıktı zaman çizelgesi ayrı tutulur; çıktı konumları ara
 * dosyaların GERÇEK sürelerinden hesaplanır.
 */
export async function renderEdit(args: EditArgs): Promise<EditResult> {
  return withFfmpegSlot(() => renderStaged(args));
}

async function renderStaged(args: EditArgs): Promise<EditResult> {
  const [W, H] = EDIT_SIZES[args.format] ?? EDIT_SIZES["9:16"];
  const framing = args.framing ?? "fit";
  const transition = args.transition ?? "cut";
  if (!args.clips.length) throw new FfmpegError("Kurgu için en az bir çekim gerekir.");
  if (args.clips.length > MAX_SEGMENTS) throw new FfmpegError(`En fazla ${MAX_SEGMENTS} bölüm desteklenir (istenen ${args.clips.length}).`);
  const deadline = Date.now() + (args.timeoutMs ?? 300_000);
  const left = () => Math.max(1000, deadline - Date.now());
  const run = (a: string[], step: string) => runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", ...a], { step, timeoutMs: left(), signal: args.signal });
  const enc = (crf: number) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-threads", String(FFMPEG_THREADS),
    "-x264-params", "rc-lookahead=10:sync-lookahead=0", "-pix_fmt", "yuv420p", "-r", String(FPS), "-video_track_timescale", "15360"];
  // fit: ürün kırpılmaz (kenar boşluğu); fill: kadraj doldurulur (kenarlar kırpılabilir). Renk/ton işlemi yapılmaz.
  const norm = framing === "fill"
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
    : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "render-"));
  try {
    // 1) Ara dosyalar
    const parts: { file: string; dur: number; clip: number | null }[] = [];
    const addCard = async (card: NonNullable<EditArgs["intro"]>, name: string) => {
      const img = await composeDesign({ mode: "typography", purpose: "reel_cover", format: args.format, headline: card.text, bg: card.bg, accent: card.accent, font: card.font, logo: card.logo });
      const png = path.join(dir, `${name}.png`);
      await fs.writeFile(png, img.buffer);
      const out = path.join(dir, `${name}.mp4`);
      await run([...SAFE_INPUT, "-loop", "1", "-framerate", String(FPS), "-t", CARD_S.toFixed(3), "-i", png,
        "-vf", `scale=${W}:${H},setsar=1,format=yuv420p`, "-an", ...enc(18), "-t", CARD_S.toFixed(3), out], `${name} kartı`);
      parts.push({ file: out, dur: await partDuration(out), clip: null });
    };
    if (args.intro?.text.trim()) await addCard(args.intro, "intro");
    for (let i = 0; i < args.clips.length; i++) {
      const c = args.clips[i];
      if (!(c.duration > 0) || c.start < 0) throw new FfmpegError(`Bölüm ${i + 1}: geçersiz kaynak zamanı (başlangıç ${c.start}, süre ${c.duration}).`);
      if (c.sourceDuration !== null && c.start + c.duration > c.sourceDuration + 0.05) {
        throw new FfmpegError(`Bölüm ${i + 1}: kaynak aralığı ${c.start.toFixed(2)}–${(c.start + c.duration).toFixed(2)} sn, kaynak süresini (${c.sourceDuration.toFixed(2)} sn) aşıyor.`);
      }
      const out = path.join(dir, `part${i}.mp4`);
      await run([...SAFE_INPUT, "-ss", c.start.toFixed(3), "-t", c.duration.toFixed(3), "-i", c.file,
        "-vf", `${norm},setsar=1,fps=${FPS},format=yuv420p`, "-an", ...enc(18), "-t", c.duration.toFixed(3), out], `bölüm ${i + 1}`);
      const d = await partDuration(out);
      if (d < 0.2) throw new FfmpegError(`Bölüm ${i + 1}: kaynaktan görüntü alınamadı (${d} sn).`);
      parts.push({ file: out, dur: d, clip: i });
    }
    if (args.outro?.text.trim()) await addCard(args.outro, "outro");

    // 2) Birleştirme
    const tl = timeline(parts.map((p) => p.dur), transition);
    let joined = parts[0].file;
    if (parts.length > 1 && tl.td === 0) {
      const list = path.join(dir, "list.txt");
      await fs.writeFile(list, parts.map((p) => `file '${path.basename(p.file)}'`).join("\n"), "utf8");
      joined = path.join(dir, "joined.mp4");
      await run(["-protocol_whitelist", "file", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined], "birleştirme");
    } else if (parts.length > 1) {
      let accDur = parts[0].dur;
      for (let i = 1; i < parts.length; i++) {
        const out = path.join(dir, `x${i}.mp4`);
        await run([...SAFE_INPUT, "-i", joined, ...SAFE_INPUT, "-i", parts[i].file, "-filter_complex_threads", "1", "-filter_complex",
          `[0:v][1:v]xfade=transition=fade:duration=${tl.td.toFixed(3)}:offset=${(accDur - tl.td).toFixed(3)},format=yuv420p[v]`,
          "-map", "[v]", "-an", ...enc(18), out], `geçiş ${i}`);
        accDur = accDur + parts[i].dur - tl.td;
        joined = out;
      }
    }

    // 3) Metinler (çıktı zaman çizelgesinde) + son kodlama
    const total = tl.total;
    const introDur = parts[0].clip === null && args.intro?.text.trim() ? parts[0].dur : 0;
    const subs = shift(args.subtitles, introDur, total);
    const top = [
      ...shift(args.onScreenText, introDur, total),
      // Bölüm metinleri: bölümün çıktıdaki gerçek konumuna yerleşir (kaynak zamanı kullanılmaz)
      ...parts.flatMap((p, i) => {
        const text = p.clip === null ? "" : (args.clips[p.clip].text ?? "").trim();
        if (!text) return [];
        const start = tl.starts[i] + (i > 0 ? tl.td / 2 : 0);
        const end = tl.starts[i] + p.dur - (i < parts.length - 1 ? tl.td / 2 : 0);
        return end > start ? [{ start, end, text }] : [];
      }),
    ];
    const srt = toSrt(subs);
    const vf: string[] = [];
    // libass boyutları 288 piksel yüksekliğe göre ölçeklenir (PlayResY=288): değerler video yüksekliğinden bağımsızdır.
    // Altyazı alt güvenli alanın (arayüz) üstünde, ekran metni üst güvenli alanın altında durur.
    const tall = H / W > 1.5;
    if (srt.trim()) {
      const p = path.join(dir, "subs.srt");
      await fs.writeFile(p, srt, "utf8");
      vf.push(`subtitles=filename='${escFilterPath(p)}':force_style='FontName=DejaVu Sans,FontSize=${tall ? 9 : 11},Outline=1,Shadow=0,Alignment=2,MarginV=${tall ? 60 : 18},MarginL=16,MarginR=16'`);
    }
    const topSrt = toSrt(top);
    if (topSrt.trim()) {
      const p = path.join(dir, "top.srt");
      await fs.writeFile(p, topSrt, "utf8");
      vf.push(`subtitles=filename='${escFilterPath(p)}':force_style='FontName=DejaVu Sans,FontSize=${tall ? 12 : 14},Bold=1,Outline=1.5,Shadow=0,Alignment=6,MarginV=${tall ? 40 : 16},MarginL=16,MarginR=16'`);
    }
    vf.push("format=yuv420p");
    const out = path.join(dir, "out.mp4");
    await run([...SAFE_INPUT, "-i", joined, "-vf", vf.join(","), "-an", ...enc(23), "-movflags", "+faststart", out], "son kodlama");

    // 4) Doğrulama
    const probe = await validateRender(out, { width: W, height: H, duration: total });
    await assertDecodes(out, left());
    const firstClip = parts.findIndex((p) => p.clip !== null);
    const thumbnail = await extractFrame(out, Math.min(total - 0.1, tl.starts[firstClip] + Math.min(1, parts[firstClip].dur / 2)), W);
    return { video: await fs.readFile(out), thumbnail, srt: srt + (topSrt.trim() ? `\n${topSrt}` : ""), probe, expectedDuration: Math.round(total * 100) / 100, overlays: top };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function partDuration(file: string) {
  return Math.round((await probeVideo(file)).duration * 1000) / 1000;
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
