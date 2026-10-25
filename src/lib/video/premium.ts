import type { MediaAsset } from "@/lib/services/media";
import type { VideoProbe } from "@/lib/media-analysis/video";

// Premium AI video (generate_new) kapıları — saf fonksiyonlar, ağ/veritabanı/ücretli çağrı yok.
//   1) Referans doğrulama: yalnızca bu ürüne ait, gerçek (AI/kurgu olmayan) ve teması doğrulanmış fotoğraflar.
//      Doğrulanamayan referans sessizce düşürülmez: tüm öğe reddedilir (metinden videoya "uydurma ürün" riski).
//   2) Süre planı: pilot 6–8 sn tek çekim; 15 sn master yalnızca onaylı pilottan sonra, çok çekimle.
//   3) MP4 doğrulama: ISO-BMFF imzası, kodek, süre/en-boy, ses durumu; indirme/önizleme meta verisi.

export const PILOT_MIN_S = 6;
export const PILOT_MAX_S = 8;
export const MASTER_S = 15;

const RASTER = new Set(["image/png", "image/jpeg", "image/webp"]);
const REAL_ORIGINS = new Set(["real_photo"]);
const BLOCKED_RIGHTS = new Set(["restricted"]);

/**
 * Bilinen FRIBEE tema eş anlamlıları. Mandala baskısı "music" temasına aittir; Space Alien ile karıştırılmaz.
 * Burada olmayan tema adları olduğu gibi (küçük harf) karşılaştırılır.
 */
const THEME_ALIASES: Record<string, string[]> = {
  music: ["music", "müzik", "muzik", "mandala"],
  space_alien: ["space alien", "space_alien", "space-alien", "alien", "uzaylı", "uzayli"],
};

export function canonicalTheme(raw: string): string {
  const t = raw.trim().toLowerCase();
  for (const [key, aliases] of Object.entries(THEME_ALIASES)) if (aliases.includes(t)) return key;
  return t;
}

/** Fotoğrafın temaları: yalnızca kayıtlı "themes" ve sahip/analiz etiketleri (dosya adı tahmine dayalıdır, kullanılmaz). */
function assetThemes(m: Pick<MediaAsset, "themes" | "tags">): Set<string> {
  const out = new Set<string>();
  for (const t of m.themes ?? []) if (t?.trim()) out.add(canonicalTheme(t));
  for (const tag of m.tags ?? []) {
    const match = /^(?:tema|theme):\s*(.+)$/i.exec(tag.tag ?? "");
    if (match && tag.source !== "system") out.add(canonicalTheme(match[1]));
  }
  return out;
}

export type RefCandidate = Pick<MediaAsset, "id" | "kind" | "mime_type" | "origin" | "product_id" | "themes" | "tags" | "rights_status">;
export type RefCheck = { accepted: string[]; rejected: { id: string; reason: string }[] };

/**
 * Referans fotoğrafları doğrular. `expected.productId` zorunludur: ürünü belirsiz bir generate_new isteği
 * gerçek ürün yerine uydurma baskı/logo üretebilir. `expected.theme` verilirse tema eşleşmesi zorunludur.
 */
export function verifyReferences(
  requestedIds: string[],
  found: Map<string, RefCandidate | null>,
  expected: { productId: string | null; theme?: string | null },
): RefCheck {
  const res: RefCheck = { accepted: [], rejected: [] };
  const theme = expected.theme ? canonicalTheme(expected.theme) : null;
  for (const id of requestedIds) {
    const m = found.get(id) ?? null;
    const reason = !m ? "arşivde bulunamadı"
      : m.kind !== "photo" ? `fotoğraf değil (${m.kind})`
      : !RASTER.has(m.mime_type) ? `desteklenmeyen biçim (${m.mime_type})`
      : !REAL_ORIGINS.has(m.origin) ? `gerçek ürün fotoğrafı değil (köken: ${m.origin})`
      : BLOCKED_RIGHTS.has(m.rights_status) ? "kullanım hakkı kısıtlı"
      : !expected.productId ? "referansların ürünü belirsiz (ürünsüz veya farklı ürünler)"
      : m.product_id !== expected.productId ? `başka ürüne ait (${m.product_id ?? "ürünsüz"})`
      : theme ? themeProblem(assetThemes(m), theme)
      : null;
    if (reason) res.rejected.push({ id, reason });
    else res.accepted.push(id);
  }
  return res;
}

function themeProblem(themes: Set<string>, expected: string): string | null {
  if (!themes.size) return "teması doğrulanmamış";
  if (!themes.has(expected)) return `tema uyuşmuyor (${[...themes].join(", ")} ≠ ${expected})`;
  if (themes.size > 1) return `birden çok tema (${[...themes].join(", ")}); hangi baskı olduğu belirsiz`;
  return null;
}

// ---------------------------------------------------------------- Süre planı

export type PremiumStage = "pilot" | "master";

/** Toplam süreyi sağlayıcının tek çekim sınırına göre çekimlere böler (ör. 15 sn, sınır 10 → [8, 7]). */
export function planShots(totalS: number, maxShotS: number, minShotS = 3): number[] {
  const total = Math.round(totalS);
  if (!(total > 0) || !(maxShotS > 0)) throw new Error("Geçersiz süre.");
  const n = Math.ceil(total / maxShotS);
  const base = Math.floor(total / n);
  const shots = Array.from({ length: n }, (_, i) => base + (i < total % n ? 1 : 0));
  if (shots.some((s) => s < minShotS || s > maxShotS)) throw new Error(`${total} sn, ${minShotS}–${maxShotS} sn çekimlere bölünemiyor.`);
  return shots;
}

export type StageDecision = { ok: true; stage: PremiumStage; shots: number[] } | { ok: false; reason: string };

/**
 * Süreye göre aşama: 6–8 sn pilot (tek çekim); 15 sn master yalnızca aynı öğe için onaylı ve doğrulanmış pilot varsa.
 * Diğer süreler sessizce kırpılmaz; reddedilir.
 */
export function premiumStage(durationS: number, maxShotS: number, pilot: { approved: boolean; verified: boolean } | null): StageDecision {
  const d = Number(durationS);
  if (d >= PILOT_MIN_S && d <= PILOT_MAX_S) {
    if (d > maxShotS) return { ok: false, reason: `pilot süresi (${d} sn) sağlayıcının tek çekim sınırını (${maxShotS} sn) aşıyor` };
    return { ok: true, stage: "pilot", shots: [Math.round(d)] };
  }
  if (d === MASTER_S) {
    if (!pilot) return { ok: false, reason: "15 sn master için önce 6–8 sn pilot üretilip doğrulanmalı" };
    if (!pilot.verified) return { ok: false, reason: "pilot MP4 doğrulamasından geçmedi; master üretilmez" };
    if (!pilot.approved) return { ok: false, reason: "pilot henüz sahip tarafından onaylanmadı; master üretilmez" };
    return { ok: true, stage: "master", shots: planShots(MASTER_S, maxShotS) };
  }
  return { ok: false, reason: `desteklenmeyen süre ${d} sn (pilot ${PILOT_MIN_S}–${PILOT_MAX_S} sn, master ${MASTER_S} sn)` };
}

// ---------------------------------------------------------------- MP4 doğrulama

export type Mp4Expect = { durationS: number; aspectRatio: "9:16" | "16:9"; requireAudio?: boolean; toleranceS?: number };
export type Mp4Metadata = {
  container: "mp4"; mime_type: "video/mp4"; bytes: number; codec: string | null; width: number; height: number;
  duration_s: number; fps: number | null; has_audio: boolean; audio_codec: string | null;
};
export type Mp4Check = { ok: boolean; problems: string[]; metadata: Mp4Metadata };

const VIDEO_CODECS = new Set(["h264", "hevc", "av1", "vp9"]);

/** ISO-BMFF (MP4) imzası: 4. bayttan itibaren "ftyp" kutusu. */
export function looksLikeMp4(buf: Buffer) {
  return buf.length >= 12 && buf.toString("latin1", 4, 8) === "ftyp";
}

export function verifyMp4(buf: Buffer, probe: VideoProbe, expect: Mp4Expect): Mp4Check {
  const problems: string[] = [];
  const w = probe.display_width || probe.width, h = probe.display_height || probe.height;
  if (!looksLikeMp4(buf)) problems.push("dosya MP4 (ISO-BMFF ftyp) değil");
  if (!probe.video_codec || !VIDEO_CODECS.has(probe.video_codec)) problems.push(`video kodeki desteklenmiyor (${probe.video_codec ?? "yok"})`);
  if (!(w > 0 && h > 0)) problems.push("görüntü boyutu yok");
  else if ((expect.aspectRatio === "9:16") !== (h > w)) problems.push(`en-boy oranı beklenen ${expect.aspectRatio} değil (${w}x${h})`);
  const tol = expect.toleranceS ?? 1;
  if (!(probe.duration > 0.5)) problems.push("süre geçersiz");
  else if (Math.abs(probe.duration - expect.durationS) > tol) problems.push(`süre ${probe.duration.toFixed(2)} sn, beklenen ${expect.durationS} sn`);
  if (expect.requireAudio && !probe.has_audio) problems.push("ses izi yok");
  return {
    ok: problems.length === 0,
    problems,
    metadata: {
      container: "mp4", mime_type: "video/mp4", bytes: buf.length, codec: probe.video_codec, width: w, height: h,
      duration_s: probe.duration, fps: probe.fps, has_audio: probe.has_audio, audio_codec: probe.audio_codec,
    },
  };
}
