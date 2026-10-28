import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { THEME_INFO, type FribeeTheme } from "@/lib/drive/themes";
import { collectionKey } from "@/lib/knowledge/store";
import { collectionsIn } from "./classify";

// Kaynak belgelerden DETERMİNİSTİK iddia çıkarımı (AI yok). Çıkarılan her iddia knowledge_facts'e "extracted" olarak
// yazılır: kaynak dosyaya bağlıdır, doğrulanmamış etiketi taşır ve sahip onaylamadan hiçbir zaman "confirmed" olmaz.
// Aynı belge yeniden işlendiğinde, o belgeden gelen ve henüz incelenmemiş iddialar silinip yeniden çıkarılır
// (onaylanmış/reddedilmiş kararlar korunur). Çakışan değerler incelemede görünür.

const COLOUR_WORDS: { re: RegExp; value: string }[] = [
  { re: /\b(light[\s-]?blue|baby[\s-]?blue|sky[\s-]?blue|a[çc][ıi]k mavi)\b/i, value: "light blue" },
  { re: /\b(black|siyah)\b/i, value: "black" },
  { re: /\b(white|beyaz)\b/i, value: "white" },
  { re: /\b(orange|turuncu)\b/i, value: "orange" },
];
const MAX_EXCERPTS_PER_COLLECTION = 3;
export const BRAIN_ACTOR = "brain";

function sentences(text: string) {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+|\s*[•·]\s+/).map((s) => s.trim()).filter((s) => s.length >= 12 && s.length <= 600);
}

export type ExtractedClaim = { theme: FribeeTheme; attribute: "story_excerpt" | "theme_color" | "artwork"; value: string };

/** Bir belgenin parçalarından koleksiyon iddiaları: hikâye alıntısı, garment rengi, çizim (artwork) ataması. */
export function extractClaims(chunks: { text: string }[]): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  const excerpts = new Map<FribeeTheme, number>();
  const seen = new Set<string>();
  const push = (c: ExtractedClaim) => {
    const k = `${c.theme}|${c.attribute}|${c.value.toLowerCase()}`;
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  };
  for (const ch of chunks) {
    for (const s of sentences(ch.text)) {
      const cols = collectionsIn(s);
      const nonMusic = cols.filter((c) => c !== "music");
      // "mandala" Music'e aittir; başka bir koleksiyonla aynı cümlede geçerse bu bir ATAMA iddiasıdır (doğrulanmamış, çakışma)
      if (/\bmandala\b/i.test(s) && nonMusic.length === 1 && !/\bmusic|m[üu]zik\b/i.test(s)) {
        push({ theme: nonMusic[0], attribute: "artwork", value: "mandala" });
        continue;
      }
      if (cols.length !== 1) continue;
      const theme = cols[0];
      const colour = COLOUR_WORDS.find((c) => c.re.test(s));
      if (colour && /\b(tee|t-?shirt|ti[şs]ört|garment|[üu]r[üu]n|product|hoodie|sweat)/i.test(s)) push({ theme, attribute: "theme_color", value: colour.value });
      const n = excerpts.get(theme) ?? 0;
      if (n < MAX_EXCERPTS_PER_COLLECTION && s.length >= 40) {
        excerpts.set(theme, n + 1);
        push({ theme, attribute: "story_excerpt", value: s.slice(0, 500) });
      }
    }
  }
  return out;
}

/** Belgenin iddialarını kaydeder (önce aynı belgeden gelen incelenmemiş iddiaları kaldırır). */
export async function storeClaims(brandId: string, driveItemId: string, sourceNote: string, sensitivity: string, claims: ExtractedClaim[], db: Queryable = getPool()) {
  await q(`DELETE FROM knowledge_facts WHERE brand_id = $1 AND drive_item_id = $2 AND status IN ('extracted','suggested') AND created_by = $3`, [brandId, driveItemId, BRAIN_ACTOR], db);
  let added = 0;
  for (const c of claims) {
    const key = collectionKey(c.theme);
    // Onaylı değerle aynıysa veya sahip bu dosyadan gelen aynı değeri reddettiyse iddia olarak eklenmez (gereksiz inceleme yok)
    const decided = await q1(
      `SELECT 1 FROM knowledge_facts WHERE brand_id = $1 AND entity_key = $2 AND attribute = $3 AND lower(value) = lower($4)
         AND (status = 'confirmed' OR (status = 'rejected' AND drive_item_id IS NOT DISTINCT FROM $5))`,
      [brandId, key, c.attribute, c.value, driveItemId], db);
    if (decided) continue;
    await q(
      `INSERT INTO knowledge_facts (brand_id, entity_key, entity_type, entity_name, attribute, value, status, sensitivity, drive_item_id, source_note, method, created_by)
       VALUES ($1,$2,'collection',$3,$4,$5,'extracted',$6,$7,$8,'document',$9)`,
      [brandId, key, THEME_INFO[c.theme].label, c.attribute, c.value, sensitivity === "public" ? "public" : "internal", driveItemId, sourceNote.slice(0, 500), BRAIN_ACTOR],
      db,
    );
    added++;
  }
  return added;
}

export type Conflict = {
  entity_key: string; entity_name: string; attribute: string;
  values: { value: string; status: string; source: string; fact_id: string }[];
  reason: string;
};

/**
 * Çakışan bilgiler: aynı varlık + öznitelik için birden çok farklı değer (onaylı ve çıkarılmış dahil, reddedilenler hariç)
 * ve Music'e ait mandala çiziminin başka bir koleksiyona atanması. Sahip incelemesi için görünür kalır.
 */
export async function listConflicts(brandId: string, db: Queryable = getPool()): Promise<Conflict[]> {
  const rows = await q<{ id: string; entity_key: string; entity_name: string; attribute: string; value: string; status: string; source: string }>(
    `SELECT f.id, f.entity_key, f.entity_name, f.attribute, f.value, f.status, COALESCE(i.path, i.name, f.source_note, 'kaynak notu yok') AS source
     FROM knowledge_facts f LEFT JOIN drive_items i ON i.id = f.drive_item_id AND i.brand_id = f.brand_id
     WHERE f.brand_id = $1 AND f.status <> 'rejected' AND f.attribute IN ('theme_color','artwork','product_name','price','launch_date','story')
     ORDER BY f.entity_key, f.attribute, f.status`,
    [brandId],
    db,
  );
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(`${r.entity_key}|${r.attribute}`, [...(groups.get(`${r.entity_key}|${r.attribute}`) ?? []), r]);
  const out: Conflict[] = [];
  for (const g of groups.values()) {
    const distinct = new Set(g.map((r) => r.value.trim().toLowerCase()));
    const mandala = g[0].attribute === "artwork" && g[0].entity_key !== collectionKey("music") && g.some((r) => /mandala/i.test(r.value));
    if (distinct.size < 2 && !mandala) continue;
    out.push({
      entity_key: g[0].entity_key, entity_name: g[0].entity_name, attribute: g[0].attribute,
      values: g.map((r) => ({ value: r.value, status: r.status, source: r.source, fact_id: r.id })),
      reason: mandala ? "Mandala çizimi Music koleksiyonuna aittir; başka koleksiyona atanması doğrulanmış kanıt gerektirir." : "Aynı bilgi için farklı değerler var.",
    });
  }
  return out;
}
