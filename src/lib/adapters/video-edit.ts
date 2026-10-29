import fs from "node:fs/promises";
import sharp from "sharp";
import os from "node:os";
import path from "node:path";
import { probeVideo, extractFrame, type VideoProbe } from "@/lib/media-analysis/video";
import { composeDesign } from "./compose";
import { FfmpegError, runFfmpeg, withFfmpegSlot } from "./ffmpeg";
import { verifyVideoFile, type VideoEvidence } from "@/lib/video/verify";


// Mevcut çekimleri yerel ffmpeg ile düzenler (AI değildir): bölüm seçme, hedef formata sığdırma/doldurma,
// kesme veya geçiş (xfade), giriş/kapanış kartı, altyazı ve ekran metni, kapak karesi. Orijinal dosyalar değiştirilmez.
// Kaynak sesler (lisansı bilinmeyen) her zaman kaldırılır. Sahip lisanslı bir müzik dosyası verirse tek ses izi olarak
// eklenir (giriş/çıkış geçişi, yayın ses seviyesi); vermezse platform uyumluluğu için SESSİZ bir AAC izi eklenir.
// Çıktı ffprobe (H.264, yuv420p, boyut, süre, AAC) ve tam çözme ile doğrulanmadan başarılı sayılmaz.

export const EDIT_SIZES: Record<string, [number, number]> = { "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350], "16:9": [1920, 1080] };
// Her girdi için: yalnızca yerel dosya protokolü ve tek iş parçacıklı çözücü (çok girdili kurguda bellek tasarrufu)
const SAFE_INPUT = ["-protocol_whitelist", "file,pipe", "-threads", "1"];
const FPS = 30;
export const TRANSITION_S = 0.5;
export const CARD_S = 2;
export const MAX_SEGMENTS = 24;
/** Hareketli kapanış kartı süresi (logo yakınlaşarak belirir). */
export const OUTRO_ANIMATED_S = 3;
const FFMPEG_THREADS = Math.max(1, Math.min(8, Number(process.env.FFMPEG_THREADS ?? 2) || 2));
/**
 * Renk doğruluğu: HD video oynatıcılar (Instagram, Chrome, Safari) etiketsiz dosyayı BT.709 kabul eder. Görüntüler
 * (fotoğraf, kart) BT.709 matrisiyle YUV'a çevrilir ve her çıktı BT.709 olarak etiketlenir; aksi halde marka renkleri
 * oynatıcıda kayar (ölçüm: etiketsiz BT.601 dönüşümünde turuncu ΔE 4,2, açık mavi ΔE 6,2).
 */
export const BT709_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
const RGB_TO_BT709 = "scale=out_color_matrix=bt709:out_range=tv";

export type Cue = { start: number; end: number; text: string };
/** Kaynak bölüm: `start`/`duration` KAYNAK dosyadaki zamandır. `text` bölüm boyunca ekranda görünür (çıktı konumu otomatik). */
export type EditClip = { file: string; start: number; duration: number; sourceDuration: number | null; text?: string };
export type EditArgs = {
  clips: EditClip[];
  format: string;
  /** fit: kenar boşluğu; fill: kırpma; blur: kaynak bulanık arka planla kadrajı doldurur, ürün kırpılmaz (farklı en-boy oranı için). */
  framing?: "fit" | "fill" | "blur";
  transition?: "cut" | "fade";
  subtitles?: Cue[];            // alt bölgede
  onScreenText?: Cue[];         // üst bölgede
  intro?: { text: string; bg: string; accent: string; font?: string; logo?: Buffer };
  outro?: { text: string; bg: string; accent: string; font?: string; logo?: Buffer; animated?: boolean };
  /** Sahibin lisanslı müziği (yerel dosya). Video boyunca çalar; kısaysa döngüye alınır. Yoksa sessiz AAC izi eklenir. */
  music?: { file: string; startS?: number };
  /** Kapak karesi: kaynak dosyadaki zaman (sn). Verilmezse çıktının ilk bölümünden otomatik seçilir. */
  cover?: { file: string; t: number };
  timeoutMs?: number;
  signal?: AbortSignal;
};
export type EditResult = {
  video: Buffer; thumbnail: Buffer; srt: string; probe: VideoProbe; expectedDuration: number; overlays: Cue[]; audio: "music" | "silent";
  /** Deterministik doğrulama kanıtı (ffprobe + tam çözme). */
  evidence: VideoEvidence;
  /** Kapak karesinin kaynaktaki zamanı; otomatik seçildiyse null. */
  coverSourceS: number | null;
};

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
    "-x264-params", "rc-lookahead=10:sync-lookahead=0", "-pix_fmt", "yuv420p", "-r", String(FPS), "-video_track_timescale", "15360", ...BT709_TAGS];
  // fit: ürün kırpılmaz (kenar boşluğu); fill: kadraj doldurulur (kenarlar kırpılabilir). Renk/ton işlemi yapılmaz.
  const norm = framing === "fill"
    ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
    : framing === "blur"
      ? `split=2[bg][fg];[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.08[b];[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[f];[b][f]overlay=(W-w)/2:(H-h)/2`
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
      const animated = name === "outro" && (card as EditArgs["outro"])?.animated;
      const secs = animated ? OUTRO_ANIMATED_S : CARD_S;
      const frames = Math.round(secs * FPS);
      // Hareketli kapanış: kart (logo + marka adı) kararmadan belirir ve yavaşça yakınlaşır (1.00 → 1.08)
      const vf = animated
        ? `scale=${W * 2}:${H * 2},zoompan=z='1+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},fade=t=in:st=0:d=0.6,scale=out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p`
        : `scale=${W}:${H}:out_color_matrix=bt709:out_range=tv,setsar=1,format=yuv420p`;
      await run([...SAFE_INPUT, "-loop", "1", "-framerate", String(FPS), "-t", secs.toFixed(3), "-i", png,
        "-vf", vf, "-an", ...enc(18), "-t", secs.toFixed(3), out], `${name} kartı`);
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
        ...(framing === "blur" ? ["-filter_complex", `[0:v]${norm},setsar=1,fps=${FPS},format=yuv420p[v]`, "-map", "[v]"] : ["-vf", `${norm},setsar=1,fps=${FPS},format=yuv420p`]),
        "-an", ...enc(18), "-t", c.duration.toFixed(3), out], `bölüm ${i + 1}`);
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
    // Kaynak ses kullanılmaz. Müzik yoksa video süresince sessiz AAC izi (48 kHz stereo) eklenir.
    const base = path.join(dir, args.music ? "video-only.mp4" : "out.mp4");
    const silentAudio = args.music ? [] : ["-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
    const audioOut = args.music ? ["-an"] : ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-shortest"];
    await run([...SAFE_INPUT, "-i", joined, ...silentAudio, "-vf", vf.join(","), ...audioOut, ...enc(23), "-movflags", "+faststart", base], "son kodlama");
    let out = base;
    if (args.music) {
      // Müzik: video süresine kesilir (kısaysa döngü), 0,5 sn giriş ve 1,5 sn çıkış geçişi, yayın ses seviyesi (-14 LUFS)
      out = path.join(dir, "out.mp4");
      const fadeOut = Math.max(0, total - 1.5);
      await run([...SAFE_INPUT, "-i", base, "-stream_loop", "-1", "-ss", String(Math.max(0, args.music.startS ?? 0)), ...SAFE_INPUT, "-i", args.music.file,
        "-filter_complex", `[1:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOut.toFixed(3)}:d=1.5,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`,
        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-t", total.toFixed(3), "-movflags", "+faststart", out], "müzik");
    }

    // 4) Doğrulama: H.264 + yuv420p + boyut + süre + AAC ses izi, ardından baştan sona hatasız çözme
    const evidence = await verifyVideoFile(out, { width: W, height: H, duration: total, audio: "aac" }, left());
    const probe = await probeVideo(out);
    let thumbnail: Buffer;
    let coverSourceS: number | null = null;
    if (args.cover) {
      // Kapak: kaynak dosyanın istenen anı, çıktıyla aynı kadrajda (fit/fill)
      const t = Math.max(0, args.cover.t);
      const jpg = path.join(dir, "cover.jpg");
      const coverNorm = framing === "fill" ? norm : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
      await run(["-ss", t.toFixed(3), ...SAFE_INPUT, "-i", args.cover.file, "-frames:v", "1", "-vf", `${coverNorm},setsar=1`, "-q:v", "3", jpg], "kapak karesi");
      thumbnail = await fs.readFile(jpg);
      if (!thumbnail.length) throw new FfmpegError(`Kapak karesi kaynağın ${t} sn anından çıkarılamadı.`);
      coverSourceS = Math.round(t * 1000) / 1000;
    } else {
      const firstClip = parts.findIndex((p) => p.clip !== null);
      thumbnail = await extractFrame(out, Math.min(total - 0.1, tl.starts[firstClip] + Math.min(1, parts[firstClip].dur / 2)), W);
    }
    return {
      video: await fs.readFile(out), thumbnail, srt: srt + (topSrt.trim() ? `\n${topSrt}` : ""), probe, expectedDuration: Math.round(total * 100) / 100,
      overlays: top, audio: args.music ? "music" : "silent", evidence, coverSourceS,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export type PhotoMotion = "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "none";

/**
 * Gerçek ürün fotoğrafından kamera hareketli kısa klip (Ken Burns). Fotoğraf KIRPILMAZ ve renk değiştirilmez:
 * hedef formata marka arka plan rengiyle sığdırılır, ardından hafif yakınlaşma/kaydırma uygulanır (en fazla %10).
 * Çıktı sessiz H.264 klip; kurguya bir bölüm olarak girer.
 */
export async function photoMotionClip(args: { photo: string; out: string; format: string; seconds: number; motion: PhotoMotion; bg: string; timeoutMs?: number; signal?: AbortSignal }) {
  const [W, H] = EDIT_SIZES[args.format] ?? EDIT_SIZES["9:16"];
  const secs = Math.min(8, Math.max(1, Number(args.seconds) || 2.5));
  const n = Math.max(2, Math.round(secs * FPS));
  // Yumuşak hareket için 1,5 kat çözünürlükte çalışılır (zoompan titremesini azaltır, bellek sınırlı kalır)
  const SW = Math.round((W * 3) / 4) * 2, SH = Math.round((H * 3) / 4) * 2;
  const bg = /^#[0-9a-f]{6}$/i.test(args.bg) ? args.bg.replace("#", "0x") : "0x111111";
  const p = `on/${n - 1}`;
  const zx: Record<PhotoMotion, [string, string, string]> = {
    zoom_in: [`1+0.10*${p}`, "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"],
    zoom_out: [`1.10-0.10*${p}`, "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"],
    pan_left: ["1.10", `(iw-iw/zoom)*(1-${p})`, "ih/2-(ih/zoom/2)"],
    pan_right: ["1.10", `(iw-iw/zoom)*${p}`, "ih/2-(ih/zoom/2)"],
    none: ["1", "0", "0"],
  };
  const [z, x, y] = zx[args.motion] ?? zx.zoom_in;
  const photo = await fitStill(args.photo, SW, SH);
  const vf = `scale=${SW}:${SH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${SW}:${SH}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1,` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${FPS},${RGB_TO_BT709},format=yuv420p`;
  await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", ...SAFE_INPUT, "-loop", "1", "-framerate", String(FPS), "-i", photo,
    "-vf", vf, "-frames:v", String(n), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", String(FFMPEG_THREADS), "-pix_fmt", "yuv420p", "-r", String(FPS), ...BT709_TAGS, args.out],
    { step: "ürün fotoğrafı hareketi", timeoutMs: args.timeoutMs ?? 120_000, signal: args.signal });
  return { duration: await partDuration(args.out), width: W, height: H };
}

/**
 * Döngülü görsel girdisinde ffmpeg fotoğrafı HER KAREDE yeniden çözer ve küçültür; tam çözünürlüklü bir orijinal
 * (ör. 6000x4000) küçük sunucuda render'ı dakikalarca uzatıyordu. Fotoğraf bir kez, ffmpeg'in zaten kullanacağı
 * çalışma boyutuna (w x h içine, oran korunur, büyütme yok) lanczos ile indirilir; JPEG q95 4:4:4 (saydamlık varsa PNG).
 * Çıktı karesi değişmez: ffmpeg aynı boyuta ölçekleyecekti. EXIF yönü uygulanır. Orijinal dosyaya dokunulmaz.
 */
export async function fitStill(file: string, w: number, h: number) {
  const meta = await sharp(file).metadata();
  const [mw, mh] = (meta.orientation ?? 1) >= 5 ? [meta.height ?? 0, meta.width ?? 0] : [meta.width ?? 0, meta.height ?? 0];
  if (mw <= w && mh <= h && (meta.orientation ?? 1) === 1) return file;
  const alpha = !!meta.hasAlpha;
  const out = `${file}.fit.${alpha ? "png" : "jpg"}`;
  const img = sharp(file).rotate().resize(w, h, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" });
  await (alpha ? img.png() : img.jpeg({ quality: 95, chromaSubsampling: "4:4:4" })).toFile(out);
  return out;
}

async function partDuration(file: string) {
  return Math.round((await probeVideo(file)).duration * 1000) / 1000;
}
