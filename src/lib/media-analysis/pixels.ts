import sharp from "sharp";

// Yerel piksel analizi (model gerektirmez, ücretsizdir, deterministiktir).
// Görselin GERÇEK piksellerinden renk, parlaklık, kontrast, netlik, yön ve arka plan tekdüzeliği çıkarır.
// Anlamsal içerik (ürün türü, baskı, poz vb.) bu katmanda TAHMİN EDİLMEZ; o iş vision katmanınındır.

export type ColorShare = { hex: string; name: string; share: number };

export type PixelAnalysis = {
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  aspect: string;
  brightness: number;     // 0-255 ortalama parlaklık
  contrast: number;       // parlaklık standart sapması
  sharpness: number;      // Laplace varyansı (yüksek = net)
  colorfulness: number;   // Hasler-Süsstrunk ölçüsü
  dominant_colors: ColorShare[];
  background: { hex: string; name: string; uniform: boolean; variation: number };
  has_alpha: boolean;
  quality_flags: string[];
};

const NAMED: { name: string; rgb: [number, number, number] }[] = [
  { name: "siyah", rgb: [15, 15, 15] }, { name: "beyaz", rgb: [245, 245, 245] }, { name: "gri", rgb: [128, 128, 128] },
  { name: "açık gri", rgb: [200, 200, 200] }, { name: "koyu gri", rgb: [64, 64, 64] }, { name: "kırmızı", rgb: [220, 30, 30] },
  { name: "bordo", rgb: [128, 20, 35] }, { name: "turuncu", rgb: [240, 130, 30] }, { name: "sarı", rgb: [240, 220, 40] },
  { name: "yeşil", rgb: [40, 170, 60] }, { name: "koyu yeşil", rgb: [20, 90, 40] }, { name: "turkuaz", rgb: [30, 180, 180] },
  { name: "mavi", rgb: [40, 90, 220] }, { name: "lacivert", rgb: [20, 35, 90] }, { name: "açık mavi", rgb: [140, 190, 240] },
  { name: "mor", rgb: [130, 50, 170] }, { name: "pembe", rgb: [240, 130, 180] }, { name: "kahverengi", rgb: [120, 75, 40] },
  { name: "bej", rgb: [225, 205, 170] }, { name: "krem", rgb: [245, 235, 210] },
];

/** sRGB → CIE Lab (renk adlandırmada algısal uzaklık için). */
function lab([r, g, b]: [number, number, number]): [number, number, number] {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [f(r), f(g), f(b)];
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const t = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))];
}

const NAMED_LAB = NAMED.map((n) => ({ ...n, lab: lab(n.rgb) }));

export function colorName(rgb: [number, number, number]): string {
  const l = lab(rgb);
  let best = NAMED_LAB[0], bd = Infinity;
  for (const n of NAMED_LAB) {
    const d = (n.lab[0] - l[0]) ** 2 + (n.lab[1] - l[1]) ** 2 + (n.lab[2] - l[2]) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best.name;
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

function aspect(w: number, h: number) {
  const known: [string, number][] = [["9:16", 9 / 16], ["4:5", 4 / 5], ["1:1", 1], ["16:9", 16 / 9], ["3:4", 3 / 4], ["4:3", 4 / 3], ["2:3", 2 / 3], ["3:2", 3 / 2]];
  const r = w / h;
  const best = known.reduce((a, b) => (Math.abs(b[1] - r) < Math.abs(a[1] - r) ? b : a));
  return Math.abs(best[1] - r) < 0.03 ? best[0] : `${w}x${h}`;
}

/** Ham RGB piksellerinden baskın renkler (renk kovalama + kova ortalaması). */
function dominant(raw: Buffer, channels: number, take = 5): ColorShare[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const total = raw.length / channels;
  for (let i = 0; i < raw.length; i += channels) {
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5); // kanal başına 8 kova
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(key, e);
  }
  const merged = new Map<string, ColorShare & { n: number; sr: number; sg: number; sb: number }>();
  for (const e of [...buckets.values()].sort((a, b) => b.n - a.n)) {
    const rgb: [number, number, number] = [e.r / e.n, e.g / e.n, e.b / e.n];
    const name = colorName(rgb);
    const m = merged.get(name) ?? { hex: "", name, share: 0, n: 0, sr: 0, sg: 0, sb: 0 };
    m.n += e.n; m.sr += e.r; m.sg += e.g; m.sb += e.b;
    merged.set(name, m);
  }
  return [...merged.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, take)
    .filter((m) => m.n / total >= 0.02)
    .map((m) => ({ hex: hex(m.sr / m.n, m.sg / m.n, m.sb / m.n), name: m.name, share: Math.round((m.n / total) * 1000) / 1000 }));
}

export async function analyzeImagePixels(input: Buffer): Promise<PixelAnalysis> {
  const img = sharp(input, { failOn: "error" }).rotate(); // EXIF yönünü uygula
  const meta = await img.metadata();
  const oriented = (meta.orientation ?? 1) >= 5;
  const width = (oriented ? meta.height : meta.width) ?? 0;
  const height = (oriented ? meta.width : meta.height) ?? 0;
  if (!width || !height) throw new Error("Görsel boyutları okunamadı.");

  // Renk ve arka plan: 96 px'e küçültülmüş RGB
  const small = await img.clone().resize(96, 96, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = small;
  const colors = dominant(data, info.channels);

  // Kenar pikselleri → arka plan tahmini
  const border: number[][] = [];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (x > 1 && y > 1 && x < info.width - 2 && y < info.height - 2) continue;
      const i = (y * info.width + x) * info.channels;
      border.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  const avg = [0, 1, 2].map((c) => border.reduce((s, p) => s + p[c], 0) / border.length) as [number, number, number];
  const variation = Math.sqrt(border.reduce((s, p) => s + (p[0] - avg[0]) ** 2 + (p[1] - avg[1]) ** 2 + (p[2] - avg[2]) ** 2, 0) / border.length);

  // Parlaklık, kontrast, renklilik
  let sumL = 0, sumL2 = 0, sumRG = 0, sumRG2 = 0, sumYB = 0, sumYB2 = 0;
  const n = data.length / info.channels;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    sumL += L; sumL2 += L * L;
    const rg = r - g, yb = 0.5 * (r + g) - b;
    sumRG += rg; sumRG2 += rg * rg; sumYB += yb; sumYB2 += yb * yb;
  }
  const brightness = sumL / n;
  const contrast = Math.sqrt(Math.max(0, sumL2 / n - brightness ** 2));
  const sdRG = Math.sqrt(Math.max(0, sumRG2 / n - (sumRG / n) ** 2));
  const sdYB = Math.sqrt(Math.max(0, sumYB2 / n - (sumYB / n) ** 2));
  const colorfulness = Math.sqrt(sdRG ** 2 + sdYB ** 2) + 0.3 * Math.sqrt((sumRG / n) ** 2 + (sumYB / n) ** 2);

  // Netlik: 512 px gri tonlamada Laplace çekirdeği → varyans
  const grey = await img.clone().resize(512, 512, { fit: "inside" }).greyscale()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
    .raw().toBuffer();
  let s = 0, s2 = 0;
  for (const v of grey) { s += v; s2 += v * v; }
  const sharpness = Math.max(0, s2 / grey.length - (s / grey.length) ** 2);

  const flags: string[] = [];
  if (Math.max(width, height) < 1080) flags.push("düşük çözünürlük (uzun kenar < 1080 px)");
  if (brightness < 50) flags.push("çok karanlık");
  if (brightness > 225) flags.push("aşırı parlak");
  if (sharpness < 25 && contrast > 10) flags.push("bulanık olabilir");
  if (contrast < 12) flags.push("düşük kontrast");

  return {
    width,
    height,
    orientation: width === height ? "square" : height > width ? "portrait" : "landscape",
    aspect: aspect(width, height),
    brightness: Math.round(brightness),
    contrast: Math.round(contrast * 10) / 10,
    sharpness: Math.round(sharpness * 10) / 10,
    colorfulness: Math.round(colorfulness * 10) / 10,
    dominant_colors: colors,
    background: { hex: hex(...avg), name: colorName(avg), uniform: variation < 18, variation: Math.round(variation * 10) / 10 },
    has_alpha: !!meta.hasAlpha,
    quality_flags: flags,
  };
}

/** Vision sağlayıcısına gönderilecek küçültülmüş JPEG (uzun kenar ≤ 1568 px, EXIF yönü uygulanmış). */
export async function visionImage(input: Buffer, maxEdge = 1568): Promise<Buffer> {
  return sharp(input).rotate().resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
}

/** İki karenin (aynı boyutta küçültülmüş) ortalama mutlak farkı: 0 (aynı) – 255. */
export async function frameDifference(a: Buffer, b: Buffer): Promise<number> {
  const prep = (x: Buffer) => sharp(x).resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer();
  const [pa, pb] = await Promise.all([prep(a), prep(b)]);
  let d = 0;
  for (let i = 0; i < pa.length; i++) d += Math.abs(pa[i] - pb[i]);
  return d / pa.length;
}
