import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { log } from "@/lib/log";
import { recordCost } from "@/lib/services/costs";
import { ROLE_ACCESS } from "@/lib/knowledge/access";
import type { KnowledgeRole } from "@/lib/knowledge/types";
import type { FribeeTheme } from "@/lib/drive/themes";
import { getEmbedder, embeddingCostUsd, estimateTokens, EMBEDDING_DIMS } from "./embeddings";
import { BRAIN_SERVICES, brainSpend, getBrainConfig } from "./settings";
import { driveFileUrl } from "@/lib/knowledge/store";

// Brand Brain karma erişimi. ERİŞİM DENETİMİ SQL'DE uygulanır (arayüzde değil): rolün göremediği hassasiyetteki parça
// sorgudan hiç dönmez; yalnızca sayısı ("withheld") bildirilir. "private" hiçbir role verilmez.
//  - Sözcüksel: PostgreSQL tam metin araması ('simple'), önek eşleşmeli OR sorgusu, ts_rank_cd.
//  - Anlamsal: gömme benzerliği. pgvector kuruluysa vector operatörü (<=>) kullanılır; değilse aynı sonucu veren tam
//    taramalı kosinüs (normalize vektörlerde iç çarpım). Gömme yoksa/kapalıysa kip "lexical" olur ve nedeni yazılır.
//  - Birleştirme: karşılıklı sıra füzyonu (RRF, k=60) + koleksiyon eşleşmesi; belge başına en çok 3 parça.

export type BrainHit = {
  label: string; chunk_id: string; document_id: string; file_id: string; name: string; path: string | null; section: string | null;
  text: string; sensitivity: string; collections: string[]; revision_key: string; verification: string; url: string; score: number;
  duplicates: string[]; flags: string[];
};
export type BrainSearch = { mode: "hybrid" | "lexical"; semantic_note: string | null; hits: BrainHit[]; withheld: number; latency_ms: number; retrieval_id: string | null; query: string };

const STOP = new Set(("ve veya ile için bir bu şu o da de mi mı mu mü ne çok daha en gibi kadar olarak olan olan ise ama fakat ki her hangi hazırla hazirla yap oluştur olustur yaz " +
  "the and or for with from this that these those into onto about over under a an of to in on at by is are be as it its our your their please make create write draft prepare").split(" "));

/** Sorgu sözcükleri: yalnızca harf/rakam (tsquery enjeksiyonu yok), durak sözcükler çıkarılır. */
export function queryTokens(query: string): string[] {
  const norm = query.replace(/İ/g, "i").toLowerCase();
  const toks = norm.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && t.length <= 40 && !STOP.has(t));
  return [...new Set(toks)].slice(0, 24);
}

let vectorExt: { at: number; ok: boolean } | null = null;
export async function pgvectorInstalled(db: Queryable = getPool()) {
  if (vectorExt && Date.now() - vectorExt.at < 5 * 60_000) return vectorExt.ok;
  const r = await q1(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`, [], db).catch(() => null);
  vectorExt = { at: Date.now(), ok: !!r };
  return vectorExt.ok;
}

async function queryEmbedding(brandId: string, query: string): Promise<{ vector: number[] | null; note: string | null }> {
  const cfg = await getBrainConfig();
  if (!cfg.embeddingsEnabled) return { vector: null, note: "Anlamsal arama kapalı: gömme sahip tarafından etkinleştirilmedi (Brand Brain → Ayarlar)." };
  const { embedder, reason } = getEmbedder();
  if (!embedder) return { vector: null, note: `Anlamsal arama kapalı: ${reason}` };
  const any = await q1(`SELECT 1 FROM kb_chunks WHERE brand_id = $1 AND embedding IS NOT NULL LIMIT 1`, [brandId]);
  if (!any) return { vector: null, note: "Anlamsal arama henüz hazır değil: hiçbir parça gömülmedi (gömme kuyruğu ve bütçeyi kontrol edin)." };
  const est = embeddingCostUsd(embedder, estimateTokens(query));
  if (est === null) return { vector: null, note: `Anlamsal arama kapalı: ${embedder.model} birim fiyatı bilinmiyor (ücretli işlem engellendi).` };
  if ((await brainSpend(BRAIN_SERVICES.query, "today")) + est > cfg.budgets.retrievalDailyUsd) return { vector: null, note: "Anlamsal arama bugün kapalı: erişim bütçesi doldu." };
  try {
    const r = await embedder.embed([query], "query");
    await recordCost({ brandId, service: BRAIN_SERVICES.query, kind: "actual", amountUsd: embeddingCostUsd(embedder, r.tokens || estimateTokens(query)), units: { tokens: r.tokens, model: embedder.model }, note: "Brand Brain sorgu gömmesi (yayımlanmış birim fiyat)" });
    return { vector: r.vectors[0], note: null };
  } catch (err) {
    log("warn", "brain.query_embedding_failed", { brandId, error: err });
    return { vector: null, note: `Anlamsal arama bu sorguda kullanılamadı (sağlayıcı hatası): ${(err as Error).message.slice(0, 120)}` };
  }
}

/**
 * Rol filtreli karma arama. `record` ile her arama kb_retrievals'a yazılır (hangi ajan hangi parçaları aldı).
 * `excludeFlagged`: komut enjeksiyonu şüphesi taşıyan parçalar ajan bağlamına girmez (panel aramasında görünür).
 */
export async function searchBrain(args: {
  brandId: string; role: KnowledgeRole; query: string; limit?: number; collection?: FribeeTheme | null;
  record?: { purpose: "agent" | "dashboard" | "test"; taskId?: string | null; projectId?: string | null; agent?: string | null } | null; excludeFlagged?: boolean;
}): Promise<BrainSearch> {
  const started = Date.now();
  const allowed = [...ROLE_ACCESS[args.role]];
  const limit = Math.max(1, Math.min(20, args.limit ?? 8));
  const tokens = queryTokens(args.query);
  const flagged = args.excludeFlagged !== false;
  const coll = args.collection ?? null;
  const base = `c.brand_id = $1 AND d.status IN ('indexed','metadata_only','unsupported') AND d.duplicate_of IS NULL
    AND ($3::text IS NULL OR $3 = ANY(c.collection_keys)) AND (NOT $4 OR NOT ('possible_prompt_injection' = ANY(c.flags)))`;

  const lexical = tokens.length
    ? await q<{ id: string }>(
        `SELECT c.id FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id AND d.brand_id = c.brand_id, to_tsquery('simple', $5) tq
         WHERE ${base} AND c.sensitivity = ANY($2::text[]) AND c.tsv @@ tq
         ORDER BY ts_rank_cd(c.tsv, tq, 32) DESC, c.chunk_index LIMIT 50`,
        [args.brandId, allowed, coll, flagged, tokens.map((t) => `${t}:*`).join(" | ")],
      )
    : [];
  const withheldRow = tokens.length
    ? await q1<{ n: number }>(
        `SELECT count(*)::int AS n FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id AND d.brand_id = c.brand_id, to_tsquery('simple', $5) tq
         WHERE ${base} AND NOT (c.sensitivity = ANY($2::text[])) AND c.tsv @@ tq`,
        [args.brandId, allowed, coll, flagged, tokens.map((t) => `${t}:*`).join(" | ")],
      )
    : null;

  const { vector, note } = await queryEmbedding(args.brandId, args.query);
  let semantic: { id: string }[] = [];
  if (vector) {
    const vec = vector.length === EMBEDDING_DIMS ? vector : null;
    if (vec) {
      semantic = (await pgvectorInstalled())
        ? await q<{ id: string }>(
            `SELECT c.id FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id AND d.brand_id = c.brand_id
             WHERE ${base} AND c.sensitivity = ANY($2::text[]) AND c.embedding IS NOT NULL AND c.embedding_dims = ${EMBEDDING_DIMS}
             ORDER BY (c.embedding::vector(${EMBEDDING_DIMS})) <=> ($5::real[]::vector(${EMBEDDING_DIMS})) LIMIT 50`,
            [args.brandId, allowed, coll, flagged, vec],
          )
        : await q<{ id: string }>(
            `SELECT c.id FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id AND d.brand_id = c.brand_id
             WHERE ${base} AND c.sensitivity = ANY($2::text[]) AND c.embedding IS NOT NULL AND c.embedding_dims = ${EMBEDDING_DIMS}
             ORDER BY (SELECT sum(a * b) FROM unnest(c.embedding, $5::real[]) AS t(a, b)) DESC LIMIT 50`,
            [args.brandId, allowed, coll, flagged, vec],
          );
    }
  }

  // RRF füzyonu
  const score = new Map<string, number>();
  lexical.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (60 + i + 1)));
  semantic.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (60 + i + 1)));
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 60);
  const rows = ranked.length
    ? await q<{ id: string; document_id: string; section: string | null; text: string; sensitivity: string; collection_keys: string[]; flags: string[]; file_id: string; name: string; path: string | null;
        revision_key: string; status: string; meta: Record<string, unknown>; duplicates: string[] | null }>(
        `SELECT c.id, c.document_id, c.section, c.text, c.sensitivity, c.collection_keys, c.flags, d.file_id, d.name, d.path, d.revision_key, d.status, d.meta,
                (SELECT array_agg(x.name ORDER BY x.name) FROM kb_documents x WHERE x.duplicate_of = d.id AND x.status = 'indexed') AS duplicates
         FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id AND d.brand_id = c.brand_id
         WHERE c.brand_id = $1 AND c.id = ANY($2::uuid[]) AND c.sensitivity = ANY($3::text[])`,
        [args.brandId, ranked, allowed],
      )
    : [];
  // Bilgi sorularında içerik belgeleri önce gelir: yalnızca üst veri taşıyan parçalar (görsel/video/desteklenmeyen) sorgu açıkça
  // medya istemiyorsa düşük ağırlık alır (yolunda koleksiyon adı geçen bir fotoğraf hikâye belgesinin önüne geçmesin).
  const mediaIntent = /\b(foto|photo|görsel|gorsel|image|resim|video|teaser|reel|klip|clip|jpe?g|png|webp|mp4|mov|psd|artboard|kapak|cover)/i.test(args.query);
  const weight = (r: { status: string }) => (r.status === "indexed" || mediaIntent ? 1 : 0.6);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) score.set(r.id, (score.get(r.id) ?? 0) * weight(r));
  ranked.sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
  const perDoc = new Map<string, number>();
  const hits: BrainHit[] = [];
  for (const id of ranked) {
    const r = byId.get(id);
    if (!r) continue;
    const n = perDoc.get(r.document_id) ?? 0;
    if (n >= 3) continue;
    perDoc.set(r.document_id, n + 1);
    const refStatus = String(r.meta?.reference_status ?? "");
    const verification = r.status === "indexed"
      ? "kaynak belge alıntısı — doğrulanmamış iddia (onaylı marka gerçeği değildir)"
      : refStatus === "verified" ? "doğrulanmış ürün referansı (sahip onayı)" : refStatus ? "yalnızca üst veri — ürün kimliği doğrulanmadı" : "yalnızca üst veri (içerik okunmadı)";
    hits.push({
      label: `S${hits.length + 1}`, chunk_id: r.id, document_id: r.document_id, file_id: r.file_id, name: r.name, path: r.path, section: r.section, text: r.text,
      sensitivity: r.sensitivity, collections: r.collection_keys, revision_key: r.revision_key, verification, url: driveFileUrl(r.file_id),
      score: Math.round((score.get(id) ?? 0) * 10000) / 10000, duplicates: r.duplicates ?? [], flags: r.flags,
    });
    if (hits.length >= limit) break;
  }
  const latency = Date.now() - started;
  const mode: BrainSearch["mode"] = vector ? "hybrid" : "lexical";
  let retrievalId: string | null = null;
  if (args.record) {
    const row = await q1<{ id: string }>(
      `INSERT INTO kb_retrievals (brand_id, task_id, project_id, agent, role, purpose, query, mode, semantic_note, hits, withheld, latency_ms, chunk_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [args.brandId, args.record.taskId ?? null, args.record.projectId ?? null, args.record.agent ?? null, args.role, args.record.purpose, args.query.slice(0, 2000), mode, note,
        hits.length, withheldRow?.n ?? 0, latency, hits.map((h) => h.chunk_id)],
    );
    retrievalId = row?.id ?? null;
  }
  return { mode, semantic_note: note, hits, withheld: withheldRow?.n ?? 0, latency_ms: latency, retrieval_id: retrievalId, query: args.query };
}
