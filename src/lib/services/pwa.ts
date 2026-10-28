import sharp from "sharp";
import { q1 } from "@/lib/db/pool";
import { getStorage } from "@/lib/storage";

// Ana ekrana eklenebilir uygulama (PWA) için marka kimliği. Uygulama simgesi markanın Marka Yönetimi'nde seçili
// GERÇEK logosundan üretilir; logo yoksa marka içermeyen nötr bir simge kullanılır (logo uydurulmaz).

export const APP_BG = "#09090b";
export const APP_ACCENT = "#d8b26a";

export async function primaryBrand(): Promise<{ id: string; name: string; logo_asset_id: string | null } | null> {
  return q1<{ id: string; name: string; logo_asset_id: string | null }>(`SELECT id, name, logo_asset_id FROM brands WHERE is_sample = false ORDER BY created_at LIMIT 1`).catch(() => null);
}

/** Nötr simge: koyu zemin üzerinde altın halka (marka logosu değildir). */
function neutralSvg(size: number) {
  const r = size * 0.24, w = Math.max(2, size * 0.045);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="${APP_BG}"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${APP_ACCENT}" stroke-width="${w}"/><circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.06}" fill="${APP_ACCENT}"/></svg>`);
}

/**
 * Kare uygulama simgesi (PNG). Logo, maskelenebilir simge güvenli alanında kalacak şekilde ortalanır (%62).
 * Logo dosyasının renkleri ve biçimi değiştirilmez; yalnızca ölçeklenir.
 */
export async function appIconPng(size: number): Promise<{ png: Buffer; fromLogo: boolean }> {
  const brand = await primaryBrand();
  if (brand?.logo_asset_id) {
    const m = await q1<{ storage_key: string; mime_type: string; size_bytes: number }>(
      `SELECT storage_key, mime_type, size_bytes FROM media_assets WHERE id = $1 AND brand_id = $2 AND mime_type IN ('image/png','image/jpeg','image/webp')`,
      [brand.logo_asset_id, brand.id],
    ).catch(() => null);
    if (m && Number(m.size_bytes) < 30 * 1024 * 1024) {
      try {
        const src = await getStorage().get(m.storage_key);
        const inner = Math.round(size * 0.62);
        const logo = await sharp(src, { limitInputPixels: 80_000_000 }).resize({ width: inner, height: inner, fit: "inside", withoutEnlargement: false }).png().toBuffer();
        const png = await sharp({ create: { width: size, height: size, channels: 4, background: APP_BG } }).composite([{ input: logo, gravity: "center" }]).png().toBuffer();
        return { png, fromLogo: true };
      } catch {
        // Logo okunamazsa nötr simgeye düşülür
      }
    }
  }
  return { png: await sharp(neutralSvg(size)).png().toBuffer(), fromLogo: false };
}
