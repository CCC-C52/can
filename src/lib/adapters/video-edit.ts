import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "@/lib/config";

const execFileAsync = promisify(execFile);

// Mevcut çekimleri yerel ffmpeg ile düzenler (AI değildir): kırpma, birleştirme, hedef formata ölçekleme,
// altyazı yakma. Orijinal dosyalar değiştirilmez; çıktı yeni dosyadır. Ses kaldırılır (müzik lisansı manuel).

const SIZES: Record<string, [number, number]> = { "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350], "16:9": [1920, 1080] };

export function toSrt(subs: { start: number; end: number; text: string }[]): string {
  const ts = (s: number) => {
    const ms = Math.max(0, Math.round(s * 1000));
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), sec = Math.floor((ms % 60000) / 1000), r = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(r).padStart(3, "0")}`;
  };
  return subs.filter((s) => s.text.trim()).map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.text.trim()}\n`).join("\n");
}

export async function renderEdit(args: {
  clips: { buffer: Buffer; ext: string; duration: number; sourceDuration: number | null }[];
  format: string;
  subtitles: { start: number; end: number; text: string }[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ video: Buffer; srt: string }> {
  const [W, H] = SIZES[args.format] ?? SIZES["9:16"];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "render-"));
  try {
    const inputs: string[] = [];
    const filters: string[] = [];
    for (let i = 0; i < args.clips.length; i++) {
      const c = args.clips[i];
      const f = path.join(dir, `in${i}.${c.ext}`);
      await fs.writeFile(f, c.buffer);
      const dur = Math.max(0.5, c.sourceDuration ? Math.min(c.duration, c.sourceDuration) : c.duration);
      inputs.push("-t", dur.toFixed(2), "-i", f);
      filters.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${i}]`);
    }
    const srt = toSrt(args.subtitles);
    const srtPath = path.join(dir, "subs.srt");
    await fs.writeFile(srtPath, srt, "utf8");
    const concat = `${args.clips.map((_, i) => `[v${i}]`).join("")}concat=n=${args.clips.length}:v=1:a=0[cat]`;
    const subFilter = srt.trim()
      ? `;[cat]subtitles=filename=${srtPath.replace(/:/g, "\\:")}:force_style='FontName=Inter,FontSize=14,Outline=1,MarginV=60'[out]`
      : `;[cat]null[out]`;
    const out = path.join(dir, `out-${crypto.randomUUID()}.mp4`);
    await execFileAsync(
      config.ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filters.join(";") + ";" + concat + subFilter, "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", out],
      { timeout: args.timeoutMs ?? 300_000, signal: args.signal, maxBuffer: 10 * 1024 * 1024 },
    );
    return { video: await fs.readFile(out), srt };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
