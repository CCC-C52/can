import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { photoMotionClip, renderEdit } from "@/lib/adapters/video-edit";

// Marka renkleri (ürün fotoğrafı ve kapanış kartı) MP4'te oynatıcının gördüğü hâliyle korunmalı.
// Oynatıcı benzetimi: BT.709 matrisiyle çözme (Instagram/Chrome/Safari'nin HD varsayımı).

function lab([r, g, b]: number[]) {
  const f = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [f(r), f(g), f(b)];
  const t = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const X = t((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), Y = t(R * 0.2126 + G * 0.7152 + B * 0.0722), Z = t((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const deltaE = (a: number[], b: number[]) => { const [x, y] = [lab(a), lab(b)]; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** BT.709 oynatıcı gibi çöz; (x,y) çevresindeki 20x20 bölgenin ortalaması. */
function playerPixel(file: string, t: number, x: number, y: number) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", `crop=20:20:${x}:${y},scale=in_color_matrix=bt709:in_range=tv,format=rgb24`, "-f", "rawvideo", "-"]);
  const sum = [0, 0, 0];
  for (let i = 0; i < raw.length; i += 3) for (let c = 0; c < 3; c++) sum[c] += raw[i + c];
  return sum.map((s) => Math.round(s / (raw.length / 3)));
}

describe("Renk doğruluğu (oynatıcıda marka rengi kaymaz)", () => {
  it("ürün fotoğrafı ve kapanış kartı: BT.709 etiketli, oynatıcıda ΔE < 2", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "color-"));
    try {
      for (const hex of ["#f97316", "#7dd3fc", "#111827", "#1e3a8a"]) {
        const photo = path.join(dir, "p.png");
        await sharp({ create: { width: 1200, height: 1600, channels: 3, background: hex } }).png().toFile(photo);
        const clip = path.join(dir, "m.mp4");
        await photoMotionClip({ photo, out: clip, format: "9:16", seconds: 1.5, motion: "none", bg: "#000000" });
        const r = await renderEdit({ clips: [{ file: clip, start: 0, duration: 1.4, sourceDuration: 1.5 }], format: "9:16", outro: { text: "FriBee", bg: "#ffffff", accent: hex } }); // kart zemini = ana marka rengi (accent)
        const out = path.join(dir, "o.mp4");
        await fs.writeFile(out, r.video);
        const tags = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_space,color_primaries,color_transfer", "-of", "csv=p=0", out]).toString().trim();
        expect(tags).toBe("bt709,bt709,bt709");
        const photoPx = playerPixel(out, 0.7, 520, 950);
        const cardPx = playerPixel(out, 2.6, 40, 1800); // kart arka planı (metin ve logodan uzak)
        expect(deltaE(rgb(hex), photoPx), `${hex} fotoğraf → ${photoPx}`).toBeLessThan(2);
        expect(deltaE(rgb(hex), cardPx), `${hex} kart → ${cardPx}`).toBeLessThan(2);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
