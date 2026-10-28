import { q } from "@/lib/db/pool";
import { isUuid } from "@/lib/ids";
import { latestAnalysis } from "@/lib/media-analysis";
import { CARD_S, timeline } from "@/lib/adapters/video-edit";
import type { VideoSpec } from "./spec";

// Video planının DETERMİNİSTİK doğrulaması ve onarımı (AI çağrısı yok). AI yapılandırılmış bir plan üretir; bu modül
// planı veritabanındaki gerçek kayıtlara göre denetler ve render'ın birebir uygulayacağı biçime getirir:
//  - kaynak kimlikleri markanın analizi tamamlanmış videolarına çözülür (dosya adı yazıldıysa kimliğe çevrilir),
//  - bölümler kaynak süresine kırpılır ve analizdeki sahne sınırlarında bölünür (sahne uydurulmaz),
//  - çıktı süresi (giriş/kapanış kartları dahil) sahibin istediği aralığa getirilir,
//  - altyazılar çıktı süresine kırpılır.
// Teknik sorunlar AI'ya "yaratıcı revizyon" olarak geri gönderilmez: onarılabiliyorsa burada onarılır, onarılamıyorsa
// açık bir hatayla raporlanır (errors).

export type SceneBox = { index: number; start: number; end: number };
export type VideoSource = { id: string; filename: string; duration: number; scenes: SceneBox[] };
export type PlanValidation = {
  content: any;
  changed: boolean;
  /** Yapılan otomatik onarımlar (insan okuyabilir). */
  repairs: string[];
  /** Onarılamayan teknik sorunlar: plan render edilemez. */
  errors: string[];
  /** Video kimliği → hesaplanan çıktı süresi (sn). */
  expected: Record<string, number>;
};

const MIN_SEG = 0.5;
const MIN_TRIM_SEG = 1.0;
const FALLBACK_SCENE_CAP = 4;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Plandaki video başvurularını çözer: kimlik veya (AI dosya adı yazdıysa) dosya adı. Yalnızca bu markanın, Drive referansı
 * reddedilmemiş, analizi tamamlanmış videoları kullanılabilir. Değer: kaynak veya kullanılamama nedeni.
 */
export async function resolveVideoSources(brandId: string, refs: string[]): Promise<Map<string, VideoSource | string>> {
  const wanted = [...new Set(refs.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim()))];
  const out = new Map<string, VideoSource | string>();
  if (!wanted.length) return out;
  const ids: string[] = [], names: string[] = [];
  for (const x of wanted) (isUuid(x) ? ids : names).push(x.toLowerCase());
  const rows = await q<{ id: string; filename: string; kind: string; blocked: boolean }>(
    `SELECT m.id, m.filename, m.kind,
            EXISTS (SELECT 1 FROM drive_references r WHERE r.brand_id = m.brand_id AND r.media_asset_id = m.id AND r.status <> 'verified') AS blocked
     FROM media_assets m WHERE m.brand_id = $1 AND (m.id = ANY($2::uuid[]) OR lower(m.filename) = ANY($3::text[]))
     ORDER BY m.created_at DESC`,
    [brandId, ids, names],
  );
  for (const ref of wanted) {
    const key = ref.toLowerCase();
    const m = rows.find((x) => x.id === key) ?? rows.find((x) => x.filename.toLowerCase() === key && x.kind === "video");
    if (!m) { out.set(ref, "bu markanın arşivinde yok"); continue; }
    if (m.kind !== "video") { out.set(ref, `${m.filename} bir video değil`); continue; }
    if (m.blocked) { out.set(ref, `${m.filename}: Drive referansı doğrulanmamış`); continue; }
    const a = await latestAnalysis(brandId, m.id);
    if (!a || a.status !== "completed") { out.set(ref, `${m.filename}: tamamlanmış görsel analiz yok`); continue; }
    const duration = Number(a.result?.local?.probe?.duration ?? 0);
    if (!(duration > 0)) { out.set(ref, `${m.filename}: analizde süre yok`); continue; }
    const raw: SceneBox[] = (a.result?.local?.scenes ?? []).map((s: any) => ({ index: Number(s.index), start: Number(s.start), end: Number(s.end) }))
      .filter((s: SceneBox) => Number.isFinite(s.start) && s.end > s.start);
    // Sahne kesmesi bulunmayan tek çekim: tüm dosya tek sahnedir
    const scenes = raw.length ? raw.sort((x, y) => x.start - y.start) : [{ index: 0, start: 0, end: duration }];
    out.set(ref, { id: m.id, filename: m.filename, duration, scenes });
  }
  return out;
}

type Seg = { asset_id: string; scene_index: number; source_start: number; source_end: number; on_screen_text: string; purpose: string };

/** Bir kaynak aralığını analiz sahnelerine böler; her parça tek bir doğrulanmış sahnenin içinde kalır. */
function splitByScenes(src: VideoSource, start: number, end: number, base: Omit<Seg, "asset_id" | "scene_index" | "source_start" | "source_end">): Seg[] {
  const out: Seg[] = [];
  for (const sc of src.scenes) {
    const s = Math.max(start, sc.start), e = Math.min(end, sc.end, src.duration);
    if (e - s >= MIN_SEG) out.push({ asset_id: src.id, scene_index: sc.index, source_start: r3(s), source_end: r3(e), ...base, on_screen_text: out.length ? "" : base.on_screen_text });
  }
  return out;
}

function outputTotal(v: any, segs: Seg[]) {
  const cards = [v.intro_text, v.outro_text].filter((x) => String(x ?? "").trim()).length;
  const durs = [...Array(cards).fill(CARD_S), ...segs.map((s) => s.source_end - s.source_start)];
  return durs.length ? timeline(durs, v.transition === "fade" ? "fade" : "cut").total : 0;
}

/** Kaynaklardan sahne sırasıyla bölüm üretir (AI planı kullanılabilir bölüm içermediğinde). */
function autoSegments(sources: VideoSource[], target: number): Seg[] {
  const segs: Seg[] = [];
  let total = 0;
  for (const src of sources) {
    for (const sc of src.scenes) {
      if (total >= target) return segs;
      const len = Math.min(sc.end, src.duration) - sc.start;
      const take = Math.min(len, FALLBACK_SCENE_CAP, Math.max(MIN_SEG, target - total));
      if (take < MIN_SEG) continue;
      segs.push({ asset_id: src.id, scene_index: sc.index, source_start: r3(sc.start), source_end: r3(sc.start + take), on_screen_text: "", purpose: "otomatik (doğrulanmış sahne)" });
      total += take;
    }
  }
  return segs;
}

/** Süreyi hedef aralığa getirir: uzunsa en uzun bölümler kısaltılır/sondan bölüm ve kart çıkarılır; kısaysa sahne içinde uzatılır/yeni sahne eklenir. */
function fitDuration(v: any, segs: Seg[], sources: Map<string, VideoSource>, spec: VideoSpec, repairs: string[]): string | null {
  const before = outputTotal(v, segs);
  if (spec.maxSeconds !== null && before > spec.maxSeconds) {
    const target = Math.max(spec.minSeconds ?? 0, spec.maxSeconds - 0.25);
    const len = (x: Seg) => x.source_end - x.source_start;
    for (let guard = 0; guard < 200; guard++) {
      const excess = outputTotal(v, segs) - target;
      if (excess <= 0.001) break;
      // Fazlalık bölümlere orantılı dağıtılır (her bölüm en az 1 sn kalır); yetmezse sondan bölüm, sonra kartlar çıkarılır
      const trimmable = segs.filter((x) => len(x) > MIN_TRIM_SEG + 0.001);
      const room = trimmable.reduce((a, x) => a + len(x) - MIN_TRIM_SEG, 0);
      if (trimmable.length && room > 0.001) {
        const k = Math.min(1, excess / room);
        for (const x of trimmable) x.source_end = r3(x.source_end - (len(x) - MIN_TRIM_SEG) * k);
      } else if (segs.length > 1) segs.pop();
      else if (String(v.intro_text ?? "").trim()) { v.intro_text = ""; repairs.push(`${v.id}: süre sınırı için giriş kartı çıkarıldı`); }
      else if (String(v.outro_text ?? "").trim()) { v.outro_text = ""; repairs.push(`${v.id}: süre sınırı için kapanış kartı çıkarıldı`); }
      else break;
    }
    const after = outputTotal(v, segs);
    if (after > spec.maxSeconds + 0.01) return `${v.id}: çıktı ${after.toFixed(2)} sn, en fazla ${spec.maxSeconds} sn olmalı; kısaltılamadı`;
    repairs.push(`${v.id}: çıktı süresi ${before.toFixed(2)} sn → ${after.toFixed(2)} sn (istenen en fazla ${spec.maxSeconds} sn; kartlar dahil)`);
  }
  const now = outputTotal(v, segs);
  if (spec.minSeconds !== null && now < spec.minSeconds) {
    const ceiling = spec.maxSeconds ?? spec.minSeconds + 1;
    const target = Math.min(ceiling - 0.1, spec.minSeconds + Math.min(0.5, (ceiling - spec.minSeconds) / 2));
    // 1) mevcut bölümleri kendi sahneleri içinde sona doğru uzat
    for (const sg of segs) {
      const need = target - outputTotal(v, segs);
      if (need <= 0) break;
      const src = sources.get(sg.asset_id)!;
      const sc = src.scenes.find((x) => x.index === sg.scene_index)!;
      const room = Math.min(sc.end, src.duration) - sg.source_end;
      if (room > 0.01) sg.source_end = r3(sg.source_end + Math.min(room, need));
    }
    // 2) kullanılan kaynakların henüz kullanılmamış sahnelerini ekle
    for (const src of new Set([...segs.map((s) => sources.get(s.asset_id)!), ...sources.values()])) {
      for (const sc of src.scenes) {
        const need = target - outputTotal(v, segs);
        if (need <= 0) break;
        if (segs.some((s) => s.asset_id === src.id && s.source_start < sc.end && s.source_end > sc.start)) continue;
        const len = Math.min(sc.end, src.duration) - sc.start;
        const take = Math.min(len, Math.max(MIN_SEG, need));
        if (take >= MIN_SEG) segs.push({ asset_id: src.id, scene_index: sc.index, source_start: r3(sc.start), source_end: r3(sc.start + take), on_screen_text: "", purpose: "süre tamamlama (doğrulanmış sahne)" });
      }
    }
    const after = outputTotal(v, segs);
    if (after < spec.minSeconds - 0.01) return `${v.id}: kaynak çekim ${after.toFixed(2)} sn'lik kurguya yetiyor; en az ${spec.minSeconds} sn istendi (sahne tekrarlanmadı, çekim uydurulmadı)`;
    repairs.push(`${v.id}: çıktı süresi ${now.toFixed(2)} sn → ${after.toFixed(2)} sn (istenen en az ${spec.minSeconds} sn)`);
  }
  return null;
}

function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(x) ?? "null";
}

const EMPTY_EDIT = { mode: "edit_existing", format: "9:16", duration_s: 0, selected_asset_ids: [], script: [], subtitles: [], generation_prompt: "", music_note: "", transition: "cut", framing: "fit", intro_text: "", outro_text: "", segments: [], parts: [] };

/**
 * Video planını doğrular/onarır. `fallbackSourceIds`: sahibin talimatta açıkça istediği, analizi tamamlanmış videolar;
 * AI planı kullanılabilir bölüm vermezse kurgu bu videoların doğrulanmış sahnelerinden kurulur.
 */
export async function validateVideoPlan(brandId: string, content: any, opts: { spec: VideoSpec; fallbackSourceIds?: string[] }): Promise<PlanValidation> {
  const plan = JSON.parse(JSON.stringify(content ?? {}));
  const repairs: string[] = [];
  const errors: string[] = [];
  const expected: Record<string, number> = {};
  if (!Array.isArray(plan.videos)) plan.videos = [];
  const videos: any[] = plan.videos;

  // Video kimlikleri benzersiz olmalı (render çıktıları kimlikle eşleştirilir)
  const seen = new Set<string>();
  videos.forEach((v, i) => {
    let id = String(v.id ?? "").trim() || `video_${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    if (id !== v.id) repairs.push(`video ${i + 1}: kimlik "${v.id ?? ""}" → "${id}"`);
    v.id = id;
    seen.add(id);
  });

  const edits = videos.filter((v) => v.mode === "edit_existing");
  const refs = [
    ...edits.flatMap((v) => [...(v.selected_asset_ids ?? []), ...(Array.isArray(v.segments) ? v.segments.map((s: any) => String(s?.asset_id ?? "")) : [])]),
    ...videos.filter((v) => v.mode === "compose").flatMap((v) => (v.parts ?? []).filter((p: any) => p?.kind === "archive_clip").map((p: any) => String(p.ref ?? ""))),
    ...(opts.fallbackSourceIds ?? []),
  ];
  const resolved = await resolveVideoSources(brandId, refs);
  const usable = (ref: string) => { const x = resolved.get(String(ref ?? "").trim()); return typeof x === "object" ? x : null; };
  const fallback = (opts.fallbackSourceIds ?? []).map(usable).filter((x): x is VideoSource => !!x);

  // AI yalnızca senaryo verdiyse ama sahip belirli bir videoyu istediyse: kurgu doğrulanmış sahnelerden kurulur
  if (!videos.some((v) => ["edit_existing", "generate_new", "compose"].includes(v.mode)) && fallback.length) {
    let id = "edit_1";
    while (seen.has(id)) id = `${id}x`;
    videos.push({ ...JSON.parse(JSON.stringify(EMPTY_EDIT)), id });
    repairs.push(`Planda üretilecek video yoktu; istenen ${fallback.map((f) => f.filename).join(", ")} için kurgu doğrulanmış sahnelerden kuruldu`);
  }

  for (const v of videos.filter((x) => x.mode === "edit_existing")) {
    if (!["9:16", "1:1", "16:9", "4:5"].includes(v.format)) { repairs.push(`${v.id}: format "${v.format}" → 9:16`); v.format = "9:16"; }
    const sources = new Map<string, VideoSource>();
    const segs: Seg[] = [];
    const rawSegs: any[] = Array.isArray(v.segments) ? v.segments : [];
    rawSegs.forEach((sg, i) => {
      const ref = String(sg?.asset_id ?? "");
      const src = usable(ref);
      if (!src) { repairs.push(`${v.id}: bölüm ${i + 1} çıkarıldı — kaynak "${ref}" ${typeof resolved.get(ref.trim()) === "string" ? resolved.get(ref.trim()) : "geçersiz"}`); return; }
      if (src.id !== ref) repairs.push(`${v.id}: bölüm ${i + 1} kaynağı "${ref}" → ${src.id} (${src.filename})`);
      sources.set(src.id, src);
      let start = Number(sg.source_start), end = Number(sg.source_end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { repairs.push(`${v.id}: bölüm ${i + 1} çıkarıldı — geçersiz zaman aralığı (${sg.source_start}–${sg.source_end})`); return; }
      const cs = Math.max(0, start), ce = Math.min(end, src.duration);
      if (cs !== start || ce !== end) repairs.push(`${v.id}: bölüm ${i + 1} kaynak süresine (${src.duration} sn) kırpıldı: ${start}–${end} → ${r3(cs)}–${r3(ce)} sn`);
      start = cs; end = ce;
      const pieces = splitByScenes(src, start, end, { on_screen_text: String(sg.on_screen_text ?? ""), purpose: String(sg.purpose ?? "") });
      const same = pieces.length === 1 && pieces[0].scene_index === Number(sg.scene_index) && pieces[0].source_start === r3(start) && pieces[0].source_end === r3(end);
      if (!pieces.length) repairs.push(`${v.id}: bölüm ${i + 1} çıkarıldı — doğrulanmış sahnelerde 0,5 sn'lik görüntü yok`);
      else if (!same) repairs.push(`${v.id}: bölüm ${i + 1} (${start}–${end} sn, sahne ${sg.scene_index}) doğrulanmış sahne sınırlarına göre ${pieces.map((p) => `sahne ${p.scene_index} ${p.source_start}–${p.source_end}`).join(", ")} olarak düzeltildi`);
      segs.push(...pieces);
    });
    for (const id of v.selected_asset_ids ?? []) { const s = usable(id); if (s) sources.set(s.id, s); }
    if (!segs.length) {
      const pool = sources.size ? [...sources.values()] : fallback;
      if (!pool.length) {
        const why = [...new Set([...rawSegs.map((s) => String(s?.asset_id ?? "")), ...(v.selected_asset_ids ?? [])])].map((r) => `${r}: ${typeof resolved.get(r) === "string" ? resolved.get(r) : "geçersiz"}`);
        errors.push(`${v.id}: kurgu için kullanılabilir kaynak video yok${why.length ? ` (${why.join("; ")})` : ""}`);
        continue;
      }
      for (const s of pool) sources.set(s.id, s);
      const target = opts.spec.maxSeconds !== null ? Math.max(opts.spec.minSeconds ?? 0, opts.spec.maxSeconds - 0.5) : Number(v.duration_s) >= 3 && Number(v.duration_s) <= 60 ? Number(v.duration_s) : 15;
      segs.push(...autoSegments(pool, Math.max(1, target - outputTotal(v, []))));
      repairs.push(`${v.id}: planda kullanılabilir bölüm yoktu; ${pool.map((p) => p.filename).join(", ")} doğrulanmış sahnelerinden ${segs.length} bölüm kuruldu`);
    }
    const fitErr = fitDuration(v, segs, sources, opts.spec, repairs);
    if (fitErr) { errors.push(fitErr); continue; }
    const total = r3(outputTotal(v, segs));
    // Altyazılar çıktı zamanındadır: çıktı süresine kırpılır, geçersizler çıkarılır
    const subs: any[] = Array.isArray(v.subtitles) ? v.subtitles : [];
    const fixedSubs = subs.map((c) => ({ ...c, start: Math.max(0, Number(c.start)), end: Math.min(total, Number(c.end)) }))
      .filter((c) => String(c.text ?? "").trim() && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end - c.start >= 0.2);
    if (fixedSubs.length !== subs.length || fixedSubs.some((c, i) => c.start !== subs[i]?.start || c.end !== subs[i]?.end)) repairs.push(`${v.id}: altyazılar çıktı süresine (${total} sn) göre düzeltildi`);
    v.subtitles = fixedSubs;
    v.segments = segs;
    v.selected_asset_ids = [...new Set(segs.map((s) => s.asset_id))];
    if (Math.abs(Number(v.duration_s) - total) > 0.01) v.duration_s = total;
    expected[v.id] = total;
  }

  // compose: arşiv parçaları da doğrulanmış sahnelere oturtulur (AI sahneleri ve ürün fotoğrafları kurallarla denetlenir)
  for (const v of videos.filter((x) => x.mode === "compose")) {
    for (const [i, p] of (Array.isArray(v.parts) ? v.parts : []).entries()) {
      if (p?.kind !== "archive_clip") continue;
      const src = usable(String(p.ref ?? ""));
      if (!src) continue; // kural denetimi raporlar
      if (src.id !== p.ref) { repairs.push(`${v.id}: parça ${i + 1} kaynağı "${p.ref}" → ${src.id}`); p.ref = src.id; }
      const start = Math.max(0, Number(p.source_start)), end = Math.min(Number(p.source_end), src.duration);
      const mid = (start + end) / 2;
      const sc = src.scenes.find((x) => mid >= x.start && mid <= x.end) ?? src.scenes.find((x) => x.index === Number(p.scene_index));
      if (!sc) continue;
      const s = r3(Math.max(start, sc.start)), e = r3(Math.min(end, sc.end, src.duration));
      if (e - s >= MIN_SEG && (s !== p.source_start || e !== p.source_end || sc.index !== p.scene_index)) {
        repairs.push(`${v.id}: parça ${i + 1} sahne ${sc.index} sınırlarına göre ${s}–${e} sn olarak düzeltildi`);
        Object.assign(p, { scene_index: sc.index, source_start: s, source_end: e, duration_s: r3(e - s) });
      }
    }
  }

  // Anahtar sırası karşılaştırmaya girmez (jsonb anahtarları yeniden sıralar): yalnızca içerik değiştiyse yeni sürüm
  const changed = canonical(plan) !== canonical(content ?? {});
  return { content: plan, changed, repairs, errors, expected };
}
