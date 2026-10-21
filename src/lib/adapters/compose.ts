import sharp, { type OverlayOptions } from "sharp";

// Yerel tasarım derleyici (AI değildir). Gerçek ürün fotoğrafı KIRPILMADAN ve RENGİ DEĞİŞTİRİLMEDEN marka zeminine
// yerleştirilir; metin, logo ve sayfa göstergesi SVG katmanı olarak eklenir. "typography" modunda fotoğraf kullanılmaz.
// Çıktılar "composed" kökenli, generation_method = sharp_compose olarak kaydedilir.

export const SIZES: Record<string, [number, number]> = { "1:1": [1080, 1080], "4:5": [1080, 1350], "9:16": [1080, 1920], "16:9": [1920, 1080] };

export type ComposeMode = "photo_composition" | "typography";
export type ComposeArgs = {
  mode: ComposeMode;
  purpose: string;           // post | cover | ad | story | banner | carousel | reel_cover | launch
  format: string;
  headline: string;
  body?: string;
  photo?: Buffer;
  logo?: Buffer;
  bg: string;                // zemin (açık marka rengi)
  accent: string;            // vurgu (ana marka rengi)
  font?: string;
  page?: { index: number; count: number }; // carousel: 1 tabanlı
};

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Yazı tipi boyutuna göre satır kırma; sığmazsa boyutu küçültür, en sonda üç noktayla keser. */
export function fitText(text: string, boxW: number, maxLines: number, startSize: number, minSize: number): { size: number; lines: string[] } {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  for (let size = startSize; ; size = Math.max(minSize, Math.round(size * 0.9))) {
    const perLine = Math.max(4, Math.floor(boxW / (size * 0.56)));
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (next.length > perLine && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines || size === minSize) {
      if (lines.length > maxLines) {
        lines.length = maxLines;
        lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
      }
      return { size, lines: lines.map((l) => (l.length > perLine ? l.slice(0, perLine - 1) + "…" : l)) };
    }
  }
}

export function contrastText(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
}

function safeHex(hex: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
}

type Box = { x: number; y: number; w: number; h: number };

function textBlock(args: { text: string; box: Box; maxLines: number; size: number; minSize: number; color: string; font: string; weight: number; align?: "start" | "middle"; opacity?: number }) {
  if (!args.text.trim()) return { svg: "", height: 0 };
  const { size, lines } = fitText(args.text, args.box.w, args.maxLines, args.size, args.minSize);
  const lh = Math.round(size * 1.18);
  const x = args.align === "middle" ? args.box.x + args.box.w / 2 : args.box.x;
  const svg = lines.map((l, i) =>
    `<text x="${x}" y="${args.box.y + size + i * lh}" text-anchor="${args.align ?? "start"}" font-family="${esc(args.font)}" font-size="${size}" font-weight="${args.weight}" fill="${args.color}"${args.opacity ? ` opacity="${args.opacity}"` : ""}>${esc(l)}</text>`,
  ).join("");
  return { svg, height: lines.length * lh };
}

async function placePhoto(photo: Buffer, box: Box) {
  // fit: inside → ürün kırpılmaz, oran korunur; renk/ton işlemi yapılmaz
  const img = await sharp(photo).rotate().resize(box.w, box.h, { fit: "inside" }).toBuffer();
  const m = await sharp(img).metadata();
  return { input: img, left: Math.round(box.x + (box.w - (m.width ?? box.w)) / 2), top: Math.round(box.y + (box.h - (m.height ?? box.h)) / 2) };
}

async function placeLogo(logo: Buffer, W: number, corner: { x: number; y: number }, maxH: number) {
  const img = await sharp(logo, { density: 300 }).rotate().resize(Math.round(W * 0.22), maxH, { fit: "inside" }).png().toBuffer();
  return { input: img, left: corner.x, top: corner.y };
}

/** Tek bir tasarım karesi üretir. Fotoğraflı tasarımlar JPEG, tipografik tasarımlar PNG döner. */
export async function composeDesign(a: ComposeArgs): Promise<{ buffer: Buffer; ext: "jpg" | "png"; width: number; height: number }> {
  const [W, H] = SIZES[a.format] ?? SIZES["4:5"];
  const font = a.font ? `${a.font}, DejaVu Sans, sans-serif` : "DejaVu Sans, sans-serif";
  const bg = safeHex(a.bg, "#f4f4f2");
  const accent = safeHex(a.accent, "#1f2937");
  const usePhoto = a.mode === "photo_composition" && !!a.photo;
  const layers: OverlayOptions[] = [];
  let back = ""; // zemin şekilleri (fotoğrafın altında)
  let svg = "";  // metin (fotoğrafın üstünde)
  const M = Math.round(W * 0.055); // kenar boşluğu
  const vertical = H / W > 1.5;    // 9:16 → story / reel kapağı
  const wide = W / H > 1.5;        // 16:9 → banner
  const logoH = Math.round(H * (vertical ? 0.05 : 0.07));
  // Instagram arayüzünün kapattığı alanlar (9:16): üst ~%13, alt ~%20
  const safeTop = vertical ? Math.round(H * 0.13) : M;
  const safeBottom = vertical ? Math.round(H * 0.2) : M;

  if (!usePhoto) {
    // Tipografi: vurgu renginde zemin, büyük başlık, gövde metni; ürün görseli yok
    const fg = contrastText(accent);
    back += `<rect width="${W}" height="${H}" fill="${accent}"/>`;
    back += `<rect x="${M}" y="${(vertical ? Math.round(H * 0.32) - M : safeTop + logoH + M)}" width="${Math.round(W * 0.12)}" height="${Math.max(6, Math.round(H * 0.006))}" fill="${fg}" opacity="0.7"/>`;
    const top = vertical ? Math.round(H * 0.32) : safeTop + logoH + M * 2;
    const avail = H - top - safeBottom;
    const head = textBlock({ text: a.headline, box: { x: M, y: top, w: W - 2 * M, h: avail }, maxLines: wide ? 3 : 5, size: Math.round(Math.min(W, H) * (a.purpose === "reel_cover" ? 0.12 : 0.1)), minSize: 34, color: fg, font, weight: 800 });
    svg += head.svg;
    if (a.body) svg += textBlock({ text: a.body, box: { x: M, y: top + head.height + M * 0.6, w: W - 2 * M, h: avail - head.height }, maxLines: 4, size: Math.round(Math.min(W, H) * 0.042), minSize: 24, color: fg, font, weight: 400, opacity: 0.9 }).svg;
  } else if (wide) {
    // Banner: solda metin, sağda ürün fotoğrafı
    const split = Math.round(W * 0.45);
    back += `<rect width="${W}" height="${H}" fill="${bg}"/><rect width="${split}" height="${H}" fill="${accent}"/>`;
    const fg = contrastText(accent);
    layers.push(await placePhoto(a.photo!, { x: split + M, y: M, w: W - split - 2 * M, h: H - 2 * M }));
    const head = textBlock({ text: a.headline, box: { x: M, y: M + logoH + M, w: split - 2 * M, h: H }, maxLines: 4, size: 76, minSize: 36, color: fg, font, weight: 800 });
    svg += head.svg;
    if (a.body) svg += textBlock({ text: a.body, box: { x: M, y: M + logoH + M + head.height + 24, w: split - 2 * M, h: H }, maxLines: 4, size: 38, minSize: 24, color: fg, font, weight: 400, opacity: 0.9 }).svg;
  } else if (vertical) {
    // Story / reel kapağı: güvenli alan içinde üstte başlık, ortada ürün, altta gövde
    back += `<rect width="${W}" height="${H}" fill="${bg}"/>`;
    const fgBg = contrastText(bg);
    const headSize = a.purpose === "reel_cover" ? 96 : 76;
    const head = textBlock({ text: a.headline, box: { x: M, y: safeTop + logoH + 20, w: W - 2 * M, h: H }, maxLines: 3, size: headSize, minSize: 40, color: fgBg, font, weight: 800, align: "middle" });
    svg += head.svg;
    const bodyH = a.body ? 150 : 0;
    const photoTop = safeTop + logoH + 40 + head.height + 30;
    const photoBottom = H - safeBottom - bodyH;
    layers.push(await placePhoto(a.photo!, { x: M, y: photoTop, w: W - 2 * M, h: Math.max(200, photoBottom - photoTop) }));
    if (a.body) {
      back += `<rect x="${M}" y="${photoBottom + 10}" width="${W - 2 * M}" height="${bodyH - 20}" rx="24" fill="${accent}"/>`;
      svg += textBlock({ text: a.body, box: { x: M + 30, y: photoBottom + 22, w: W - 2 * M - 60, h: bodyH }, maxLines: 2, size: 40, minSize: 26, color: contrastText(accent), font, weight: 500, align: "middle" }).svg;
    }
  } else {
    // Gönderi / carousel karesi (1:1, 4:5): ürün üstte, başlık bandı altta
    const band = Math.round(H * (a.body ? 0.26 : 0.2));
    const photoArea = H - band;
    back += `<rect width="${W}" height="${H}" fill="${bg}"/><rect y="${photoArea}" width="${W}" height="${band}" fill="${accent}"/>`;
    layers.push(await placePhoto(a.photo!, { x: M, y: M + logoH, w: W - 2 * M, h: photoArea - 2 * M - logoH }));
    const fg = contrastText(accent);
    const head = textBlock({ text: a.headline, box: { x: M, y: photoArea + 24, w: W - 2 * M - (a.page ? 120 : 0), h: band }, maxLines: 2, size: 64, minSize: 34, color: fg, font, weight: 800 });
    svg += head.svg;
    if (a.body) svg += textBlock({ text: a.body, box: { x: M, y: photoArea + 24 + head.height + 10, w: W - 2 * M, h: band }, maxLines: 2, size: 34, minSize: 22, color: fg, font, weight: 400, opacity: 0.9 }).svg;
  }

  if (a.page && a.page.count > 1) {
    const fg = usePhoto && !wide && !vertical ? contrastText(accent) : usePhoto ? contrastText(bg) : contrastText(accent);
    svg += `<text x="${W - M}" y="${H - (vertical ? safeBottom : M)}" text-anchor="end" font-family="${esc(font)}" font-size="34" font-weight="700" fill="${fg}" opacity="0.85">${a.page.index}/${a.page.count}</text>`;
  }
  const svgOf = (body: string) => Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
  const ordered: OverlayOptions[] = [{ input: svgOf(back), left: 0, top: 0 }, ...layers, { input: svgOf(svg), left: 0, top: 0 }];
  if (a.logo) {
    try { ordered.push(await placeLogo(a.logo, W, { x: M, y: vertical ? safeTop : M }, logoH)); } catch { /* okunamayan logo: logosuz devam */ }
  }
  const composed = sharp({ create: { width: W, height: H, channels: 3, background: bg } }).composite(ordered);
  const ext = usePhoto ? "jpg" : "png";
  const buffer = ext === "jpg" ? await composed.jpeg({ quality: 90, mozjpeg: true }).toBuffer() : await composed.png().toBuffer();
  return { buffer, ext, width: W, height: H };
}
