import sharp from "sharp";
import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";
import { getSetting, setSetting } from "@/lib/settings";
import { referenceTooSmall } from "@/lib/video/reference";
import { confirmFribeeCollections } from "@/lib/knowledge/store";
import { DriveAuthError, driveGet, fetchThumbnail } from "./google";
import { safeError, tokenProvider } from "./source";
import { COLOUR_THEME, THEME_INFO, classifyGarmentColour, suggestFromText, type FribeeTheme, type GarmentColour, type ReferenceView } from "./themes";
import { autoQueueReferences, isNonProductImage } from "./references";

// SAHİP RENK KURALI (29 Ekim 2026 talimatı): "Turuncu tişört Anime, beyaz Music, siyah Space Alien, bebe mavisi
// (arkasında arı) Save the Bee. Fotoğraflar buna göre gruplansın; ilgili departmanlar benim onayım olmadan alsın."
// Kural açıkken işleyici inceleme kuyruğundaki ürün fotoğraflarının rengini Drive önizlemesinden (ücretsiz, salt
// okunur) ölçer ve kurala uyanları sahip adına doğrular; orijinaller mevcut içe aktarma adımıyla medya arşivine alınır.
// Korunanlar: logo/grafik ve düşük çözünürlüklü dosyalar alınmaz; ad başka koleksiyonu söylüyorsa veya renk
// belirlenemiyorsa fotoğraf incelemede kalır; sahibin geri aldığı veya reddettiği fotoğrafa kural bir daha dokunmaz.

export const COLOUR_RULE_ACTOR = "kural:renk";
/** Ortadaki giysi bölgesinde kural renginin en az payı (arka plan ve baskı payı düşülür). */
export const COLOUR_MIN_SHARE = 0.35;
const UNIFORM_SHARE = 0.95;
const PER_TICK = 12;

type RuleSetting = { enabled: boolean; changed_by?: string; changed_at?: string };
const key = (brandId: string) => `drive:colour_rule:${brandId}`;

/** Kural varsayılan olarak AÇIK (sahibin 29 Ekim talimatı); sahip Drive Arşivi'nden kapatabilir. */
export async function colourRuleEnabled(brandId: string, db: Queryable = getPool()) {
  return (await getSetting<RuleSetting>(key(brandId), { enabled: true }, db)).enabled !== false;
}

export async function setColourRule(brandId: string, enabled: boolean, actor = "user") {
  await setSetting(key(brandId), { enabled, changed_by: actor, changed_at: new Date().toISOString() } satisfies RuleSetting);
  await audit({ brandId, actor, action: "drive.colour_rule", message: `Sahip renk kuralı ${enabled ? "açıldı" : "kapatıldı"} (turuncu=Anime, beyaz=Music, siyah=Space Alien, bebe mavisi=Save the Bee).` });
}

/**
 * Giysi rengi: görselin ortasındaki bölgede (genişliğin %50'si, yüksekliğin %60'ı) her pikselin renk sınıfı sayılır.
 * Kural rengi orta bölgenin en az %35'ini kaplamalı. Görselin tamamı tek renkse (boş zemin, düz görsel) renk
 * belirsiz sayılır.
 */
export async function garmentColourOf(buf: Buffer): Promise<{ colour: GarmentColour | null; share: number; note?: string }> {
  const N = 60;
  const { data, info } = await sharp(buf).rotate().resize(N, N, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const centre = new Map<GarmentColour, number>();
  const border = new Map<GarmentColour, number>();
  let centreTotal = 0, borderTotal = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * info.width + x) * info.channels;
      const c = classifyGarmentColour({ r: data[i], g: data[i + 1], b: data[i + 2] });
      const inCentre = x >= 15 && x < 45 && y >= 12 && y < 48;
      const inBorder = x < 4 || x >= N - 4 || y < 4 || y >= N - 4;
      if (inCentre) { centreTotal++; if (c) centre.set(c, (centre.get(c) ?? 0) + 1); }
      else if (inBorder) { borderTotal++; if (c) border.set(c, (border.get(c) ?? 0) + 1); }
    }
  }
  const top = [...centre.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return { colour: null, share: 0 };
  const share = Math.round((top[1] / centreTotal) * 100) / 100;
  if (share < COLOUR_MIN_SHARE) return { colour: null, share };
  if (share >= UNIFORM_SHARE && (border.get(top[0]) ?? 0) / borderTotal >= UNIFORM_SHARE) return { colour: null, share, note: "Görselin tamamı tek renk (giysi ayırt edilemedi)." };
  return { colour: top[0], share };
}

/** Kural kararı: renk koleksiyonu belirler; ad başka bir koleksiyonu söylüyorsa çelişki (incelemede kalır). */
export function decideByColour(name: string, path: string | null, colour: GarmentColour | null): { theme: FribeeTheme | null; view: ReferenceView; reason: string } {
  const t = suggestFromText(`${path ?? ""} ${name}`);
  const view: ReferenceView = t.view && t.view !== "unknown" ? t.view : "other";
  if (!colour) return { theme: null, view, reason: "Ürün rengi turuncu, beyaz, siyah veya bebe mavisi olarak belirlenemedi." };
  const theme = COLOUR_THEME[colour];
  const others = t.themeHits.filter((h) => h !== theme);
  if (others.length) return { theme: null, view, reason: `Renk ${THEME_INFO[theme].garmentLabel} (${THEME_INFO[theme].label}) ama dosya adı ${others.map((o) => THEME_INFO[o].label).join(", ")} diyor: çelişki.` };
  return { theme, view, reason: `Sahip renk kuralı: ${THEME_INFO[theme].garmentLabel} tişört = ${THEME_INFO[theme].label}.` };
}

type Candidate = { id: string; brand_id: string; name: string; path: string | null; mime_type: string; file_id: string; has_thumbnail: boolean; image_width: number | null; image_height: number | null };

/**
 * İşleyici adımı: kuralın açık olduğu markalarda inceleme kuyruğundaki (hiç kurala girmemiş) ürün fotoğraflarını
 * renk kuralıyla doğrular. Tur başına en çok 12 fotoğraf; her fotoğraf bir kez değerlendirilir (sonuç kayda yazılır).
 */
export async function runColourRuleOnce(limit = PER_TICK, opts: { colourOf?: (c: Candidate) => Promise<Buffer> } = {}) {
  const brands = await q<{ brand_id: string }>(
    `SELECT s.brand_id FROM drive_sources s JOIN brands b ON b.id = s.brand_id
     WHERE b.is_sample = false AND s.status IN ('active', 'reauth_required') AND s.folder_id IS NOT NULL`,
  );
  const out: { referenceId: string; theme: FribeeTheme | null; reason: string }[] = [];
  for (const { brand_id: brandId } of brands) {
    if (!(await colourRuleEnabled(brandId))) continue;
    await confirmFribeeCollections(brandId, COLOUR_RULE_ACTOR);
    await autoQueueReferences(brandId, { limit: 200 });
    const rows = await q<Candidate & { ref_id: string }>(
      `SELECT r.id AS ref_id, i.id, i.brand_id, i.name, i.path, i.mime_type, i.file_id, i.has_thumbnail, i.image_width, i.image_height
       FROM drive_references r JOIN drive_items i ON i.id = r.item_id AND i.brand_id = r.brand_id
       WHERE r.brand_id = $1 AND r.status = 'uncertain' AND NOT (r.suggestion_detail ? 'colour_rule')
         AND i.state = 'indexed' AND NOT i.is_folder
       ORDER BY r.created_at LIMIT $2`,
      [brandId, limit],
    );
    let verified = 0;
    for (const it of rows) {
      let decision: { theme: FribeeTheme | null; view: ReferenceView; reason: string };
      let measured: { colour: GarmentColour | null; share: number; note?: string } = { colour: null, share: 0 };
      if (isNonProductImage(it.name, it.path, it.mime_type)) decision = { theme: null, view: "other", reason: "Logo/grafik dosyası; ürün fotoğrafı değil." };
      else if (it.image_width && it.image_height && referenceTooSmall(it.image_width, it.image_height)) decision = { theme: null, view: "other", reason: "Çözünürlük ürün referansı için düşük." };
      else if (!it.has_thumbnail && !opts.colourOf) decision = { theme: null, view: "other", reason: "Drive bu dosya için önizleme sunmuyor; renk ölçülemedi." };
      else {
        try {
          const buf = opts.colourOf ? await opts.colourOf(it) : await thumbnailOf(brandId, it.file_id);
          measured = await garmentColourOf(buf);
          decision = decideByColour(it.name, it.path, measured.colour);
          if (measured.note) decision.reason = `${decision.reason} ${measured.note}`;
        } catch (err) {
          if (err instanceof DriveAuthError) { log("warn", "drive.colour_rule_auth", { brandId }); break; } // yeniden bağlanınca devam eder
          decision = { theme: null, view: "other", reason: `Önizleme okunamadı: ${safeError(err)}` };
        }
      }
      const detail = { colour_rule: { at: new Date().toISOString(), colour: measured.colour, share: measured.share, theme: decision.theme, reason: decision.reason } };
      if (decision.theme) {
        await q(
          `UPDATE drive_references SET status = 'verified', theme = $3, view = $4, artwork_confirmed = true, verified_by = $5, verified_at = now(),
             notes = COALESCE(notes, $6), suggestion_detail = suggestion_detail || $7::jsonb, updated_at = now()
           WHERE id = $1 AND brand_id = $2 AND status = 'uncertain'`,
          [it.ref_id, brandId, decision.theme, decision.view, COLOUR_RULE_ACTOR, decision.reason, JSON.stringify(detail)],
        );
        verified++;
      } else {
        await q(`UPDATE drive_references SET suggestion_detail = suggestion_detail || $3::jsonb, updated_at = now() WHERE id = $1 AND brand_id = $2`, [it.ref_id, brandId, JSON.stringify(detail)]);
      }
      out.push({ referenceId: it.ref_id, theme: decision.theme, reason: decision.reason });
    }
    if (verified) await audit({ brandId, actor: COLOUR_RULE_ACTOR, action: "drive.colour_rule_verified", message: `Sahip renk kuralıyla ${verified} ürün fotoğrafı doğrulandı ve koleksiyonuna ayrıldı; orijinaller medya arşivine alınıyor.` });
  }
  return out;
}

async function thumbnailOf(brandId: string, fileId: string) {
  const f = await driveGet<{ thumbnailLink?: string }>(`/files/${fileId}`, { fields: "thumbnailLink", supportsAllDrives: true }, tokenProvider(brandId));
  if (!f.thumbnailLink) throw new Error("Drive bu dosya için önizleme sunmuyor.");
  return fetchThumbnail(f.thumbnailLink, tokenProvider(brandId), 320);
}

/** Panel özeti: kuralla doğrulanan, kuralın incelemede bıraktığı ve henüz değerlendirilmemiş fotoğraflar. */
export async function colourRuleSummary(brandId: string, db: Queryable = getPool()) {
  const r = await q1<{ verified: number; kept: number; waiting: number }>(
    `SELECT count(*) FILTER (WHERE status = 'verified' AND verified_by = $2)::int AS verified,
            count(*) FILTER (WHERE status = 'uncertain' AND suggestion_detail ? 'colour_rule')::int AS kept,
            count(*) FILTER (WHERE status = 'uncertain' AND NOT (suggestion_detail ? 'colour_rule'))::int AS waiting
     FROM drive_references WHERE brand_id = $1`,
    [brandId, COLOUR_RULE_ACTOR],
    db,
  );
  return { enabled: await colourRuleEnabled(brandId, db), verified: r?.verified ?? 0, kept: r?.kept ?? 0, waiting: r?.waiting ?? 0 };
}
