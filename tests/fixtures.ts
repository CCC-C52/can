import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

// Deterministik test medyası. İçerikleri bilinir; analiz sonuçları bu içeriklere göre doğrulanır.

/** Beyaz zemin üzerinde ortalanmış düz renkli "ürün" dikdörtgeni (dikey 4:5). */
export async function productPhoto(color: string, opts: { width?: number; height?: number; bg?: string } = {}) {
  const w = opts.width ?? 1200, h = opts.height ?? 1500;
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${opts.bg ?? "#ffffff"}"/><rect x="${w * 0.25}" y="${h * 0.2}" width="${w * 0.5}" height="${h * 0.6}" rx="30" fill="${color}"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/** Keskin dama tahtası (netlik testi için) ve bulanık hâli. */
export async function checkerboard(blur = 0) {
  const cells: string[] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x + y) % 2) cells.push(`<rect x="${x * 50}" y="${y * 50}" width="50" height="50" fill="#000"/>`);
  const img = sharp(Buffer.from(`<svg width="800" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#fff"/>${cells.join("")}</svg>`));
  return (blur ? img.blur(blur) : img).png().toBuffer();
}

/** Renk sahnelerinden oluşan dikey MP4 (ör. 2 sn kırmızı + 2 sn mavi), isteğe bağlı sinüs sesi. */
export async function colorScenesVideo(scenes: { color: string; seconds: number }[], opts: { size?: string; audio?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-"));
  const out = path.join(dir, "scenes.mp4");
  const size = opts.size ?? "720x1280";
  const inputs = scenes.flatMap((s) => ["-f", "lavfi", "-i", `color=c=${s.color}:s=${size}:r=30:d=${s.seconds}`]);
  const total = scenes.reduce((a, s) => a + s.seconds, 0);
  const audio = opts.audio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${total}`] : [];
  const filter = `${scenes.map((_, i) => `[${i}:v]`).join("")}concat=n=${scenes.length}:v=1:a=0[v]`;
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, ...audio, "-filter_complex", filter, "-map", "[v]",
    ...(opts.audio ? ["-map", `${scenes.length}:a`, "-c:a", "aac", "-shortest"] : []), "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
  const buf = await fs.readFile(out);
  await fs.rm(dir, { recursive: true, force: true });
  return buf;
}

/** Kamera kaydırması benzetimi: geniş test deseni üzerinde sürekli yatay kayan 720x1280 pencere. */
export async function movingVideo(seconds = 3) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fixture-"));
  const out = path.join(dir, "moving.mp4");
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=s=2400x1280:r=30:d=${seconds}`,
    "-vf", "crop=720:1280:x='t*400':y=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
  const buf = await fs.readFile(out);
  await fs.rm(dir, { recursive: true, force: true });
  return buf;
}
