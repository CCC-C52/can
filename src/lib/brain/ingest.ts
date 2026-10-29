import { q, q1, tx, type Queryable, getPool } from "@/lib/db/pool";
import { log } from "@/lib/log";
import { sha256 } from "@/lib/security/crypto";
import { PermanentError, TransientError } from "@/lib/models/types";
import { DriveAuthError, DriveNotFoundError, DriveQuotaError, driveDownload, type TokenProvider } from "@/lib/drive/google";
import { markReauth, tokenProvider } from "@/lib/drive/source";
import { isNonProductImage } from "@/lib/drive/references";
import { THEME_INFO, VIEW_LABEL, isTheme } from "@/lib/drive/themes";
import { classifyFile, sensitivityForFile } from "@/lib/knowledge/archive";
import { driveFileUrl } from "@/lib/knowledge/store";
import type { Sensitivity } from "@/lib/knowledge/types";
import { compactAnalysis, type MediaAnalysis } from "@/lib/media-analysis";
import { PARSER_VERSION, chunkSections, cleanText, parseContent, readPlanFor, type Section } from "./parsers";
import { collectionsIn, contentSensitivity, injectionFlags, maxSensitivity } from "./classify";
import { extractClaims, storeClaims } from "./claims";
import { estimateTokens } from "./embeddings";

// Brand Brain içerik alma hattı. Drive yalnızca OKUNUR (indirme/dışa aktarma); hiçbir dosya değiştirilmez.
//  1) syncDocuments: drive_items (üst veri dizini) ↔ kb_documents eşitlemesi. Revizyon anahtarı (sürüm + özet + değişiklik
//     zamanı) değişmeyen dosya yeniden işlenmez. Silinen/taşınan/erişimi kalkan dosyanın parçaları geçersiz kılınır.
//  2) processNextDocument: kuyruktan tek belge kiralanır (FOR UPDATE SKIP LOCKED + süre), indirilir, ayrıştırılır,
//     parçalanır ve tek işlemde yazılır. Bozuk bir dosya yalnızca kendini etkiler; arşivin geri kalanı sürer.
//  3) Hata sınıfları: geçici (ağ, 429, 5xx) → üstel geri çekilme; deneme sınırı → "dead" (ölü mektup kuyruğu);
//     kalıcı (bozuk/korumalı) → "failed" + nedeni; yetki (401) → kaynak "yeniden yetkilendirme" durumuna alınır.
//  4) recoverBrainLeases: işleyici çökerse süresi dolan kiralar kuyruğa geri döner.

export const BRAIN_LEASE_MS = 10 * 60_000;
/**
 * Belleğe alınıp ayrıştırılan en büyük dosya. İşleyici küçük bir sunucuda (Render starter, 512 MB) video render'ıyla aynı
 * süreçte çalışır; 60 MB'lık bir dosyanın ayrıştırılması belleği taşırıp çalışan render'ı da düşürebiliyordu.
 * E-tablolar sıkıştırılmış XML'dir (açılınca ~10 kat): ayrı, daha küçük sınır. BRAIN_MAX_CONTENT_MB ile değiştirilebilir.
 */
export const MAX_CONTENT_BYTES = Math.max(1, Number(process.env.BRAIN_MAX_CONTENT_MB) || 15) * 1024 * 1024;
export const MAX_SHEET_BYTES = Math.min(MAX_CONTENT_BYTES, 5 * 1024 * 1024);
const MAX_CHUNKS_PER_DOC = 400;
const SYNC_BATCH = 2000;

export type KbDocument = {
  id: string; brand_id: string; drive_item_id: string; file_id: string; name: string; path: string | null; mime_type: string;
  revision_key: string; content_hash: string | null; parser: string | null; status: string; limitation: string | null; error: string | null;
  attempts: number; max_attempts: number; next_attempt_at: string | null; category: string | null; sensitivity: Sensitivity;
  collection_keys: string[]; duplicate_of: string | null; flags: string[]; meta: Record<string, unknown>; page_count: number | null;
  char_count: number | null; chunk_count: number; indexed_at: string | null; updated_at: string;
};

type ItemRow = { id: string; file_id: string; name: string; path: string | null; mime_type: string; state: string; size_bytes: string | null;
  md5_checksum: string | null; sha256_checksum: string | null; version: string | null; modified_time: string | null; image_width: number | null;
  image_height: number | null; video_duration_ms: string | null };

const revisionKey = (i: Pick<ItemRow, "version" | "md5_checksum" | "sha256_checksum" | "modified_time">) =>
  [i.version ?? "", i.md5_checksum ?? i.sha256_checksum ?? "", i.modified_time ? new Date(i.modified_time).toISOString() : ""].join(":");


// ---------------------------------------------------------------- 1) Eşitleme

/**
 * Üst veri dizinini belge kuyruğuna yansıtır. Yeni ve revizyonu değişen dosyalar "pending" olur; yalnızca yolu/adı değişen
 * içerik belgesi yeniden indirilmez (üst veri güncellenir). Kaldırılan dosyaların parçaları ve incelenmemiş iddiaları silinir.
 */
export async function syncDocuments(brandId: string, db: Queryable = getPool()) {
  const res = { added: 0, changed: 0, moved: 0, removed: 0 };
  for (let round = 0; round < 50; round++) {
    const rows = await q<ItemRow & { doc_id: string | null; doc_rev: string | null; doc_name: string | null; doc_path: string | null; doc_status: string | null; doc_category: string | null }>(
      `SELECT i.id, i.file_id, i.name, i.path, i.mime_type, i.state, i.size_bytes, i.md5_checksum, i.sha256_checksum, i.version, i.modified_time,
              i.image_width, i.image_height, i.video_duration_ms,
              d.id AS doc_id, d.revision_key AS doc_rev, d.name AS doc_name, d.path AS doc_path, d.status AS doc_status, d.category AS doc_category
       FROM drive_items i LEFT JOIN kb_documents d ON d.drive_item_id = i.id AND d.brand_id = i.brand_id
       WHERE i.brand_id = $1 AND NOT i.is_folder AND i.state = 'indexed'
         AND (d.id IS NULL OR d.status = 'removed'
              OR d.revision_key <> concat_ws(':', COALESCE(i.version::text, ''), COALESCE(i.md5_checksum, i.sha256_checksum, ''),
                                             COALESCE(to_char(i.modified_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''))
              OR d.name <> i.name OR d.path IS DISTINCT FROM i.path)
       ORDER BY i.id LIMIT $2`,
      [brandId, SYNC_BATCH],
      db,
    );
    if (!rows.length) break;
    for (const r of rows) {
      const category = classifyFile({ name: r.name, path: r.path ?? "", mimeType: r.mime_type });
      const sensitivity = sensitivityForFile(category, r.mime_type);
      const rk = revisionKey(r);
      if (!r.doc_id) {
        await q(
          `INSERT INTO kb_documents (brand_id, drive_item_id, file_id, name, path, mime_type, revision_key, category, sensitivity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (brand_id, drive_item_id) DO NOTHING`,
          [brandId, r.id, r.file_id, r.name, r.path, r.mime_type, rk, category, sensitivity],
          db,
        );
        res.added++;
        continue;
      }
      const contentChanged = r.doc_rev !== rk || r.doc_status === "removed";
      // Yol/ad değişince kategori (ve hassasiyet) değişebilir; üst veri belgeleri metinlerinde yolu taşır → yeniden üretilir
      const metaDoc = r.doc_status === "metadata_only" || r.doc_status === "unsupported";
      const reprocess = contentChanged || category !== r.doc_category || metaDoc;
      await q(
        `UPDATE kb_documents SET name = $3, path = $4, mime_type = $5, revision_key = $6, category = $7, sensitivity = $8,
           status = CASE WHEN $9 THEN 'pending' ELSE status END, attempts = CASE WHEN $9 THEN 0 ELSE attempts END,
           next_attempt_at = CASE WHEN $9 THEN NULL ELSE next_attempt_at END, error = CASE WHEN $9 THEN NULL ELSE error END, updated_at = now()
         WHERE id = $1 AND brand_id = $2`,
        [r.doc_id, brandId, r.name, r.path, r.mime_type, rk, category, sensitivity, reprocess],
        db,
      );
      if (contentChanged) res.changed++;
      else res.moved++;
    }
    if (rows.length < SYNC_BATCH) break;
  }
  // Kaldırılan dosyalar: Drive'da silindi/çöpe taşındı/klasör dışına taşındı veya erişim kalktı
  const gone = await q<{ id: string; drive_item_id: string }>(
    `UPDATE kb_documents d SET status = 'removed', chunk_count = 0, lease_owner = NULL, lease_expires_at = NULL, updated_at = now(),
       limitation = 'Kaynak dosya Drive arşivinde artık yok (silindi, taşındı veya erişim kalktı); içerik geçersiz kılındı.'
     FROM drive_items i WHERE i.id = d.drive_item_id AND i.brand_id = d.brand_id AND d.brand_id = $1 AND i.state = 'removed' AND d.status <> 'removed'
     RETURNING d.id, d.drive_item_id`,
    [brandId],
    db,
  );
  if (gone.length) await invalidate(brandId, gone, db);
  res.removed = gone.length;
  return res;
}

async function invalidate(brandId: string, docs: { id: string; drive_item_id: string }[], db: Queryable) {
  await q(`DELETE FROM kb_chunks WHERE brand_id = $1 AND document_id = ANY($2::uuid[])`, [brandId, docs.map((d) => d.id)], db);
  await q(`DELETE FROM knowledge_facts WHERE brand_id = $1 AND drive_item_id = ANY($2::uuid[]) AND status IN ('extracted','suggested') AND created_by = 'brain'`, [brandId, docs.map((d) => d.drive_item_id)], db);
}

// ---------------------------------------------------------------- 2) İşleme

export async function recoverBrainLeases(db: Queryable = getPool()) {
  const r = await q<{ id: string }>(
    `UPDATE kb_documents SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = now(),
       error = 'İşleyici yanıt vermedi (yeniden başlatma); kuyruğa geri alındı.'
     WHERE status = 'processing' AND lease_expires_at < now() RETURNING id`,
  );
  return r.length;
}

async function claimNext(brandId: string, workerId: string): Promise<KbDocument | null> {
  return q1<KbDocument>(
    `UPDATE kb_documents SET status = 'processing', lease_owner = $2, lease_expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
     WHERE id = (SELECT id FROM kb_documents WHERE brand_id = $1 AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                 ORDER BY attempts, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [brandId, workerId, String(BRAIN_LEASE_MS)],
  );
}

type Chunk = { section: string; text: string; sensitivity: Sensitivity; flags: string[]; collections: string[] };

/** Gizli bilgi (anahtar, parola, kart) şüphesi taşıyan parçanın metni dizine HİÇ yazılmaz; yalnızca yer tutucu saklanır. */
export const SECRET_PLACEHOLDER = "[Gizli bilgi şüphesi: bu bölümün metni dizine alınmadı ve hiçbir ajana verilmez. Kaynak dosyayı Drive'da inceleyin.]";

function buildChunks(sections: Section[], base: Sensitivity, path: string): Chunk[] {
  return chunkSections(sections).slice(0, MAX_CHUNKS_PER_DOC).map((c) => {
    const s = contentSensitivity(base, c.text);
    const secret = s.flags.includes("secret_withheld");
    return { section: c.section, text: secret ? SECRET_PLACEHOLDER : c.text, sensitivity: s.sensitivity, flags: [...s.flags, ...(secret ? [] : injectionFlags(c.text))], collections: secret ? [] : collectionsIn(`${path} ${c.section} ${c.text}`) };
  });
}

/** Görsel/video/ses/desteklenmeyen dosyalar için aranabilir üst veri metni. Ürün kimliği yalnızca sahip doğrulamasından gelir. */
async function metadataSection(doc: KbDocument, item: ItemRow, media: "image" | "video" | "audio" | "other"): Promise<{ section: Section; meta: Record<string, unknown> }> {
  const lines = [`Dosya: ${item.name}`, `Yol: ${item.path ?? item.name}`, `Tür: ${item.mime_type}`];
  if (item.size_bytes) lines.push(`Boyut: ${(Number(item.size_bytes) / 1e6).toFixed(1)} MB`);
  const meta: Record<string, unknown> = { media };
  if (media === "image") {
    if (item.image_width) lines.push(`Çözünürlük: ${item.image_width}x${item.image_height}`);
    const ref = await q1<{ status: string; theme: string | null; view: string; artwork_confirmed: boolean; suggested_theme: string | null }>(
      `SELECT status, theme, view, artwork_confirmed, suggested_theme FROM drive_references WHERE brand_id = $1 AND item_id = $2`, [doc.brand_id, item.id]);
    const nonProduct = isNonProductImage(item.name, item.path, item.mime_type);
    let verification: string;
    if (ref?.status === "verified" && ref.theme && isTheme(ref.theme)) verification = `DOĞRULANMIŞ ürün referansı (sahip onayı): ${THEME_INFO[ref.theme].label} · ${VIEW_LABEL[ref.view as keyof typeof VIEW_LABEL] ?? ref.view}`;
    else if (ref?.status === "rejected") verification = "Sahip tarafından ürün referansı olarak REDDEDİLDİ";
    else if (nonProduct) verification = "Ürün fotoğrafı değil (logo/artboard/ikon gibi); ürün referansı olarak kullanılamaz";
    else verification = `DOĞRULANMAMIŞ: ürün kimliği ve baskı sadakati sahip onayı bekliyor${ref?.suggested_theme ? ` (öneri: ${ref.suggested_theme}, yalnızca dosya adı/yolundan)` : ""}`;
    lines.push(`Ürün referansı durumu: ${verification}`);
    meta.reference_status = ref?.status ?? (nonProduct ? "non_product" : "none");
  }
  if (media === "video") {
    if (item.video_duration_ms) lines.push(`Süre: ${(Number(item.video_duration_ms) / 1000).toFixed(1)} sn`);
    if (item.image_width) lines.push(`Çözünürlük: ${item.image_width}x${item.image_height}`);
    // Aynı dosya medya arşivine yüklenip analiz edildiyse (ad + boyut eşleşmesi) doğrulanmış sahneler eklenir
    const m = item.size_bytes ? await q1<{ id: string }>(`SELECT id FROM media_assets WHERE brand_id = $1 AND kind = 'video' AND lower(filename) = lower($2) AND size_bytes = $3 ORDER BY created_at DESC LIMIT 1`,
      [doc.brand_id, item.name, item.size_bytes]) : null;
    if (m) {
      const a = await q1<MediaAnalysis>(`SELECT * FROM media_analyses WHERE brand_id = $1 AND asset_id = $2 AND status = 'completed' ORDER BY (level = 'vision') DESC, created_at DESC LIMIT 1`, [doc.brand_id, m.id]);
      const c = compactAnalysis(a) as { scenes?: { index: number; start: number; end: number; colors?: string[] }[]; summary?: string } | null;
      if (c?.scenes?.length) {
        lines.push(`Medya arşivi kaydı: ${m.id} (analiz edilmiş)`);
        for (const s of c.scenes.slice(0, 12)) lines.push(`Sahne ${s.index}: ${s.start}–${s.end} sn${s.colors?.length ? ` · renkler: ${s.colors.join(", ")}` : ""}`);
        if (c.summary) lines.push(`Görsel özet: ${c.summary}`);
        meta.media_asset_id = m.id;
      }
    }
  }
  lines.push(`Kaynak: ${driveFileUrl(item.file_id)}`);
  return { section: { label: "Üst veri", text: lines.join("\n") }, meta };
}

async function finishDoc(doc: KbDocument, patch: { status: string; parser?: string | null; limitation?: string | null; error?: string | null; contentHash?: string | null; duplicateOf?: string | null;
  pageCount?: number | null; chunks?: Chunk[]; meta?: Record<string, unknown> }, item: ItemRow | null) {
  await tx(async (c) => {
    const chunks = patch.chunks ?? [];
    await q(`DELETE FROM kb_chunks WHERE document_id = $1`, [doc.id], c);
    for (const [i, ch] of chunks.entries()) {
      await q(
        `INSERT INTO kb_chunks (brand_id, document_id, chunk_index, section, text, content_hash, sensitivity, collection_keys, flags, token_estimate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [doc.brand_id, doc.id, i, ch.section.slice(0, 200), ch.text.slice(0, 8000), sha256(ch.text), ch.sensitivity, ch.collections, ch.flags, estimateTokens(ch.text)],
        c,
      );
    }
    const sens = chunks.reduce<Sensitivity>((s, ch) => maxSensitivity(s, ch.sensitivity), doc.sensitivity);
    await q(
      `UPDATE kb_documents SET status = $3, parser = $4, parser_version = $5, limitation = $6, error = $7, content_hash = $8, duplicate_of = $9,
         page_count = $10, char_count = $11, chunk_count = $12, collection_keys = $13, flags = $14, meta = $15, sensitivity = $16,
         indexed_at = CASE WHEN $3 IN ('indexed','metadata_only','unsupported') THEN now() ELSE indexed_at END,
         lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = now()
       WHERE id = $1 AND brand_id = $2`,
      [doc.id, doc.brand_id, patch.status, patch.parser ?? null, PARSER_VERSION, patch.limitation ?? null, patch.error ?? null, patch.contentHash ?? null, patch.duplicateOf ?? null,
        patch.pageCount ?? null, chunks.reduce((a, ch) => a + ch.text.length, 0) || null, chunks.length,
        [...new Set(chunks.flatMap((ch) => ch.collections))], [...new Set(chunks.flatMap((ch) => ch.flags))], JSON.stringify(patch.meta ?? {}), sens],
      c,
    );
    // Deterministik iddialar (yalnızca içerik belgelerinden; görsel dosya adı iddia sayılmaz)
    if (item && patch.status === "indexed" && chunks.length) {
      await storeClaims(doc.brand_id, item.id, `Drive: ${item.path ?? item.name}`, sens, extractClaims(chunks.filter((ch) => ch.sensitivity !== "private" && !ch.flags.includes("possible_prompt_injection"))), c);
    }
  });
}

async function failDoc(doc: KbDocument, err: unknown) {
  const msg = (err as Error).message?.slice(0, 500) || "Bilinmeyen hata";
  if (err instanceof TransientError) {
    const attempts = doc.attempts + 1;
    const dead = attempts >= doc.max_attempts;
    const backoffMs = Math.min(6 * 3_600_000, 30_000 * 2 ** (attempts - 1));
    await q(
      `UPDATE kb_documents SET status = $2, attempts = $3, error = $4, next_attempt_at = CASE WHEN $2 = 'pending' THEN now() + ($5 || ' milliseconds')::interval END,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
      [doc.id, dead ? "dead" : "pending", attempts, dead ? `Deneme sınırı doldu (${attempts}): ${msg}` : `Geçici hata (deneme ${attempts}/${doc.max_attempts}): ${msg}`, String(backoffMs)],
    );
    return dead ? "dead" : "retry";
  }
  await q(`UPDATE kb_documents SET status = 'failed', attempts = attempts + 1, error = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1`, [doc.id, msg]);
  return "failed";
}

export type ProcessOutcome = { docId: string; name: string; status: string; error?: string; stopBrand?: boolean };

/** Kuyruktaki bir sonraki belgeyi işler; kuyruk boşsa null. */
export async function processNextDocument(brandId: string, workerId: string, opts: { token?: TokenProvider } = {}): Promise<ProcessOutcome | null> {
  const doc = await claimNext(brandId, workerId);
  if (!doc) return null;
  const item = await q1<ItemRow>(
    `SELECT id, file_id, name, path, mime_type, state, size_bytes, md5_checksum, sha256_checksum, version, modified_time, image_width, image_height, video_duration_ms
     FROM drive_items WHERE id = $1 AND brand_id = $2`, [doc.drive_item_id, brandId]);
  try {
    if (!item || item.state === "removed") {
      await finishDoc(doc, { status: "removed", limitation: "Kaynak dosya Drive arşivinde artık yok." }, null);
      await invalidate(brandId, [{ id: doc.id, drive_item_id: doc.drive_item_id }], getPool());
      return { docId: doc.id, name: doc.name, status: "removed" };
    }
    const plan = readPlanFor(item.mime_type, item.name);
    const base = doc.sensitivity;
    if (plan.kind === "metadata") {
      const { section, meta } = await metadataSection(doc, item, plan.media);
      await finishDoc(doc, { status: plan.media === "other" ? "unsupported" : "metadata_only", parser: `metadata:${plan.media}`, limitation: plan.limitation, chunks: buildChunks([section], base, item.path ?? ""), meta }, item);
      return { docId: doc.id, name: doc.name, status: plan.media === "other" ? "unsupported" : "metadata_only" };
    }
    const sizeLimit = /xlsx|sheet/i.test(plan.parser) ? MAX_SHEET_BYTES : MAX_CONTENT_BYTES;
    if (item.size_bytes && Number(item.size_bytes) > sizeLimit) {
      const { section } = await metadataSection(doc, item, "other");
      await finishDoc(doc, { status: "metadata_only", parser: plan.parser, limitation: `Dosya çok büyük (${(Number(item.size_bytes) / 1e6).toFixed(1)} MB > ${(sizeLimit / 1e6).toFixed(0)} MB); yalnızca üst veri dizinlendi.`, chunks: buildChunks([section], base, item.path ?? "") }, item);
      return { docId: doc.id, name: doc.name, status: "metadata_only" };
    }
    // Aynı Drive özeti (md5) zaten işlendiyse indirme yapılmaz: içerik kopyası olarak bağlanır (kaynak izi korunur)
    if (item.md5_checksum) {
      const twin = await q1<{ id: string; content_hash: string | null }>(
        `SELECT d.id, d.content_hash FROM kb_documents d JOIN drive_items i ON i.id = d.drive_item_id AND i.brand_id = d.brand_id
         WHERE d.brand_id = $1 AND d.id <> $2 AND d.status = 'indexed' AND d.duplicate_of IS NULL AND d.chunk_count > 0 AND i.md5_checksum = $3 LIMIT 1`,
        [brandId, doc.id, item.md5_checksum]);
      if (twin) {
        await finishDoc(doc, { status: "indexed", parser: plan.parser, contentHash: twin.content_hash, duplicateOf: twin.id, limitation: "Aynı içerik başka bir dosyada zaten dizinli (kopya); aramada asıl belge döner." }, item);
        return { docId: doc.id, name: doc.name, status: "duplicate" };
      }
    }
    const buf = await driveDownload(item.file_id, opts.token ?? tokenProvider(brandId), { maxBytes: sizeLimit, ...(plan.exportMime ? { exportMime: plan.exportMime } : {}) });
    const parsed = await parseContent(plan, buf);
    if (!parsed.ok) {
      const { section } = await metadataSection(doc, item, "other");
      await finishDoc(doc, { status: parsed.status, parser: parsed.parser, limitation: parsed.limitation, chunks: buildChunks([section], base, item.path ?? "") }, item);
      return { docId: doc.id, name: doc.name, status: parsed.status };
    }
    const fullText = cleanText(parsed.sections.map((s) => s.text).join("\n\n"));
    const contentHash = sha256(fullText);
    const twin = await q1<{ id: string }>(
      `SELECT id FROM kb_documents WHERE brand_id = $1 AND id <> $2 AND content_hash = $3 AND status = 'indexed' AND duplicate_of IS NULL AND chunk_count > 0 LIMIT 1`,
      [brandId, doc.id, contentHash]);
    if (twin) {
      await finishDoc(doc, { status: "indexed", parser: parsed.parser, contentHash, duplicateOf: twin.id, pageCount: parsed.pages ?? null, limitation: "Aynı metin başka bir dosyada zaten dizinli (kopya); aramada asıl belge döner." }, item);
      return { docId: doc.id, name: doc.name, status: "duplicate" };
    }
    const chunks = buildChunks(parsed.sections, base, item.path ?? "");
    await finishDoc(doc, { status: "indexed", parser: parsed.parser, contentHash, pageCount: parsed.pages ?? null, chunks, meta: parsed.meta ?? {} }, item);
    return { docId: doc.id, name: doc.name, status: "indexed" };
  } catch (err) {
    if (err instanceof DriveAuthError) {
      await q(`UPDATE kb_documents SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, error = $2, updated_at = now() WHERE id = $1`, [doc.id, err.message]);
      await markReauth(brandId, err.message).catch(() => {});
      return { docId: doc.id, name: doc.name, status: "auth_required", error: err.message, stopBrand: true };
    }
    if (err instanceof DriveNotFoundError) {
      await finishDoc(doc, { status: "removed", limitation: "Drive dosyası bulunamadı veya erişim kalktı; içerik geçersiz kılındı." }, null);
      await invalidate(brandId, [{ id: doc.id, drive_item_id: doc.drive_item_id }], getPool());
      return { docId: doc.id, name: doc.name, status: "removed" };
    }
    const outcome = await failDoc(doc, err instanceof PermanentError || err instanceof TransientError ? err : new PermanentError((err as Error).message ?? String(err)));
    log(outcome === "failed" ? "warn" : "info", "brain.document_error", { brandId, documentId: doc.id, outcome, error: (err as Error).message?.slice(0, 200) });
    return { docId: doc.id, name: doc.name, status: outcome, error: (err as Error).message, stopBrand: err instanceof DriveQuotaError };
  }
}

/** Ölü mektup / başarısız belgeleri yeniden kuyruğa alır (sahip eylemi). */
export async function retryDocuments(brandId: string, ids: string[] | "all_failed") {
  const r = await q<{ id: string }>(
    `UPDATE kb_documents SET status = 'pending', attempts = 0, next_attempt_at = NULL, error = NULL, updated_at = now()
     WHERE brand_id = $1 AND status IN ('failed','dead') AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[])) RETURNING id`,
    [brandId, ids === "all_failed" ? null : ids],
  );
  return r.length;
}

/** Değişen veya tüm belgeleri yeniden işler (ayrıştırıcı sürümü değiştiğinde veya sahip istediğinde). */
export async function reindexDocuments(brandId: string, scope: "changed" | "all") {
  const r = await q<{ id: string }>(
    `UPDATE kb_documents SET status = 'pending', attempts = 0, next_attempt_at = NULL, error = NULL, updated_at = now()
     WHERE brand_id = $1 AND status NOT IN ('removed','processing') AND ($2 = 'all' OR parser_version IS DISTINCT FROM $3 OR status IN ('failed','dead')) RETURNING id`,
    [brandId, scope, PARSER_VERSION],
  );
  return r.length;
}
