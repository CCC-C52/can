import sharp, { type Sharp } from "sharp";

// AI üretimine giden gerçek ürün fotoğrafı (referans). Amaç: orijinaldeki netliği ve rengi korumak.
//  - Orijinal dosya sağlayıcı sınırına sığıyorsa BAYT BAYT AYNEN gönderilir (yeniden kodlama yok).
//  - Sığmıyorsa aynı piksel boyutunda kalite 95, renk alt örneklemesiz (4:4:4) JPEG'e çevrilir (baskı kenarları
//    bulanıklaşmaz); hâlâ sığmıyorsa uzun kenar 4096 piksele (lanczos3) indirilir. Her dönüşüm kayda yazılır.
//  - Kısa kenarı REFERENCE_MIN_SHORT_SIDE altındaki fotoğraf ürün referansı olarak kullanılmaz (düşük netlik).

export const REFERENCE_MAX_BYTES = 6 * 1024 * 1024;
export const REFERENCE_MIN_SHORT_SIDE = 1024;
export const REFERENCE_MAX_LONG_SIDE = 4096;
const PASSTHROUGH = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ReferenceFidelity = {
  original_px: [number, number];
  sent_px: [number, number];
  original_bytes: number;
  sent_bytes: number;
  transformed: "none" | "reencoded" | "downscaled";
  /** Yeniden kodlandıysa JPEG kalitesi (renk alt örneklemesi yok). */
  quality?: number;
};

export class ReferenceQualityError extends Error {}

export function referenceTooSmall(width: number | null | undefined, height: number | null | undefined) {
  return !width || !height || Math.min(width, height) < REFERENCE_MIN_SHORT_SIDE;
}

export async function prepareReference(buf: Buffer, mimeType: string, label = "fotoğraf"): Promise<{ base64: string; mimeType: string; fidelity: ReferenceFidelity }> {
  const meta = await sharp(buf).metadata();
  // EXIF yönü 5-8 ise genişlik/yükseklik yer değiştirir
  const swap = (meta.orientation ?? 1) >= 5;
  const w = (swap ? meta.height : meta.width) ?? 0, h = (swap ? meta.width : meta.height) ?? 0;
  if (referenceTooSmall(w, h)) {
    throw new ReferenceQualityError(`${label}: çözünürlük ${w}x${h}; ürün referansı için kısa kenar en az ${REFERENCE_MIN_SHORT_SIDE} piksel olmalı (baskı detayı korunamaz).`);
  }
  if (PASSTHROUGH.has(mimeType) && buf.length <= REFERENCE_MAX_BYTES) {
    return { base64: buf.toString("base64"), mimeType, fidelity: { original_px: [w, h], sent_px: [w, h], original_bytes: buf.length, sent_bytes: buf.length, transformed: "none" } };
  }
  // EXIF yönü uygulanır; renk profili sRGB'ye dönüştürülür (P3/Adobe RGB fotoğraf sağlayıcıda soluk görünmez).
  // Saydam PNG beyaz zemine oturtulur (JPEG saydamlık taşımaz).
  // Kademeler: önce tam çözünürlük, en az kayıpla başlanır; sığana kadar sırayla denenir.
  const ladder: { long: number | null; quality: number }[] = [
    { long: Math.max(w, h) > REFERENCE_MAX_LONG_SIDE * 2 ? REFERENCE_MAX_LONG_SIDE : null, quality: 95 },
    { long: REFERENCE_MAX_LONG_SIDE, quality: 95 },
    { long: REFERENCE_MAX_LONG_SIDE, quality: 90 },
    { long: 3072, quality: 90 },
    { long: 2560, quality: 88 },
  ];
  for (const step of ladder) {
    let img: Sharp = sharp(buf).rotate().flatten({ background: "#ffffff" }).toColourspace("srgb");
    if (step.long && Math.max(w, h) > step.long) img = img.resize(step.long, step.long, { fit: "inside", kernel: "lanczos3", withoutEnlargement: true });
    const out = await img.jpeg({ quality: step.quality, chromaSubsampling: "4:4:4", mozjpeg: false }).toBuffer({ resolveWithObject: true });
    if (out.data.length <= REFERENCE_MAX_BYTES) {
      return {
        base64: out.data.toString("base64"), mimeType: "image/jpeg",
        fidelity: {
          original_px: [w, h], sent_px: [out.info.width, out.info.height], original_bytes: buf.length, sent_bytes: out.data.length,
          transformed: out.info.width === w && out.info.height === h ? "reencoded" : "downscaled", quality: step.quality,
        },
      };
    }
  }
  throw new ReferenceQualityError(`${label}: sağlayıcı sınırına (${REFERENCE_MAX_BYTES / 1048576} MB) sığdırılamadı.`);
}
