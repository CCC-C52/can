import sharp from "sharp";

// Yerel tasarım derleyici (AI değildir): gerçek ürün fotoğrafını KIRPMADAN ve RENGİNİ DEĞİŞTİRMEDEN
// marka renginde zemine yerleştirir ve başlık bandı ekler. Çıktı "edited" kökenli yeni sürüm olarak kaydedilir.

const SIZES: Record<string, [number, number]> = { "1:1": [1080, 1080], "4:5": [1080, 1350], "9:16": [1080, 1920], "16:9": [1920, 1080] };

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) {
      if (cur) lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

function contrastText(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
}

export async function composePost(args: { photo: Buffer; format: string; headline: string; subline?: string; bg: string; accent: string; font?: string }): Promise<Buffer> {
  const [W, H] = SIZES[args.format] ?? SIZES["4:5"];
  const band = Math.round(H * 0.2);
  const photoArea = H - band;
  const photo = await sharp(args.photo).rotate().resize(W - 80, photoArea - 80, { fit: "inside", withoutEnlargement: false }).toBuffer();
  const meta = await sharp(photo).metadata();
  const left = Math.round((W - (meta.width ?? W)) / 2);
  const top = Math.round((photoArea - (meta.height ?? photoArea)) / 2);
  const font = args.font ?? "Inter, DejaVu Sans, sans-serif";
  const fg = contrastText(args.accent);
  const lines = wrap(args.headline, W > 1500 ? 48 : 26);
  const fs = Math.round(band / (lines.length + 1.6));
  const text = lines.map((l, i) => `<text x="60" y="${photoArea + fs * (i + 1.2)}" font-family="${esc(font)}" font-size="${fs}" font-weight="700" fill="${fg}">${esc(l)}</text>`).join("");
  const sub = args.subline ? `<text x="60" y="${H - 36}" font-family="${esc(font)}" font-size="${Math.round(fs * 0.5)}" fill="${fg}" opacity="0.85">${esc(args.subline.slice(0, 90))}</text>` : "";
  const svg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="${photoArea}" width="${W}" height="${band}" fill="${esc(args.accent)}"/>${text}${sub}</svg>`);
  return sharp({ create: { width: W, height: H, channels: 3, background: args.bg } })
    .composite([{ input: photo, left, top }, { input: svg, left: 0, top: 0 }])
    .png()
    .toBuffer();
}
