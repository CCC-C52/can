import { q, q1, type Queryable, getPool } from "@/lib/db/pool";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/ids";
import { looksSecret } from "@/lib/services/brand-memory";
import { THEME_INFO, VIEW_LABEL, isTheme, type FribeeTheme, type ReferenceView } from "@/lib/drive/themes";
import { canRead, ROLE_LABELS } from "./access";
import { ArchiveIndex, classifyFile, sensitivityForFile, type ArchiveFile } from "./archive";
import { ENTITY_TYPES, KnowledgeGraph, normalizeName, type EntityType } from "./graph";
import { KnowledgeError, SENSITIVITIES, type ArchiveCategory, type ClaimStatus, type KnowledgeRole, type Sensitivity } from "./types";

// Kalıcı marka bilgi sistemi. Mevcut parçaları birleştirir, yeni bir veri kopyası oluşturmaz:
//  - Arşiv dizini: Google Drive dizini (drive_items) — kategori ve hassasiyet ad/yol/türden hesaplanır.
//  - Doğrulanmış baskılar: sahibin doğruladığı Drive referansları (drive_references: tema + ön/arka/detay).
//  - Kaynaklı olgular: knowledge_facts (koleksiyon rengi, hikâye belgesi, ürün adı, tedarikçi …).
// Ajanlara yalnızca "confirmed" olgular gerçek olarak verilir ve her rol yalnızca izin verilen hassasiyeti görür.

export type KnowledgeFactRow = {
  id: string;
  brand_id: string;
  entity_key: string;
  entity_type: EntityType;
  entity_name: string;
  attribute: string;
  value: string;
  status: ClaimStatus | "rejected";
  sensitivity: Sensitivity;
  drive_item_id: string | null;
  source_note: string | null;
  method: "metadata" | "ocr" | "vision" | "owner" | "manual" | "document";
  decided_by: string | null;
  decided_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export const collectionKey = (theme: FribeeTheme) => `collection_${theme}`;
const THEME_COLOR: Record<FribeeTheme, string> = { space_alien: "black", music: "white", anime: "orange", save_the_bee: "light blue" };
export const OWNER_COLLECTIONS_NOTE = "Sahip talimatı (2026-10-26): Space Alien siyah, Music beyaz (mandala Music'e aittir), Anime turuncu, Save the Bee açık mavi.";

const entityKeyOf = (name: string) => normalizeName(name).replace(/ /g, "_").slice(0, 80) || "entity";

/**
 * Sahibin açıkça bildirdiği dört FriBee koleksiyonunu ve renklerini onaylı olgu olarak kaydeder (bir kez).
 * Sahip eylemiyle çalışır; ürün adı, hikâye veya SKU eklemez (bunlar arşivden gelip incelemeden geçer).
 */
export async function confirmFribeeCollections(brandId: string, actor = "user", db: Queryable = getPool()) {
  let added = 0;
  const now = new Date().toISOString();
  const rows: [string, string, string, string, string][] = [
    ...(Object.keys(THEME_INFO) as FribeeTheme[]).map((t) => [collectionKey(t), "collection", THEME_INFO[t].label, "theme_color", THEME_COLOR[t]] as [string, string, string, string, string]),
    ["design_mandala", "design", "Mandala", "collection", "Music"],
  ];
  for (const [key, type, name, attribute, value] of rows) {
    const r = await q1<{ id: string }>(
      `INSERT INTO knowledge_facts (brand_id, entity_key, entity_type, entity_name, attribute, value, status, sensitivity, source_note, method, decided_by, decided_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'confirmed','public',$7,'owner',$8,$9,$8)
       ON CONFLICT (brand_id, entity_key, attribute) WHERE status = 'confirmed' DO NOTHING RETURNING id`,
      [brandId, key, type, name, attribute, value, OWNER_COLLECTIONS_NOTE, actor, now],
      db,
    );
    if (r) added++;
  }
  if (added) await audit({ brandId, actor, action: "knowledge.collections_confirmed", message: `FriBee koleksiyonları onaylı bilgi olarak kaydedildi (${added} olgu).` }, db);
  return { added };
}

export type NewFact = {
  entityType: EntityType;
  entityName: string;
  entityKey?: string;
  attribute: string;
  value: string;
  status: "confirmed" | "extracted" | "suggested";
  sensitivity?: Sensitivity;
  driveItemId?: string | null;
  sourceNote?: string | null;
  method: KnowledgeFactRow["method"];
  actor?: string;
};

/** Olgu ekler. Onaylı olgu kaynak (Drive dosyası veya açık kaynak notu) ister; çıkarılan olgu arşiv dosyası ister. */
export async function addKnowledgeFact(brandId: string, f: NewFact, db: Queryable = getPool()): Promise<KnowledgeFactRow> {
  if (!(ENTITY_TYPES as readonly string[]).includes(f.entityType)) throw new KnowledgeError("Geçersiz varlık türü.");
  const name = f.entityName.trim().slice(0, 200);
  const value = f.value.trim();
  const attribute = f.attribute.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60);
  if (!name || !value || !attribute) throw new KnowledgeError("Varlık adı, öznitelik ve değer gerekli.");
  if (value.length > 4000) throw new KnowledgeError("Değer en çok 4000 karakter olabilir.");
  if (looksSecret(`${name}\n${attribute}\n${value}`)) throw new KnowledgeError("Bilgi gizli değer içeriyor gibi görünüyor; kaydedilmedi.");
  const sensitivity = f.sensitivity ?? "internal";
  if (!(SENSITIVITIES as readonly string[]).includes(sensitivity)) throw new KnowledgeError("Geçersiz hassasiyet.");
  let driveItemId: string | null = null;
  let itemNote: string | null = null;
  if (f.driveItemId) {
    if (!isUuid(f.driveItemId)) throw new KnowledgeError("Kaynak dosya bulunamadı.");
    const it = await q1<{ id: string; path: string | null; name: string }>(`SELECT id, path, name FROM drive_items WHERE id = $1 AND brand_id = $2`, [f.driveItemId, brandId], db);
    if (!it) throw new KnowledgeError("Kaynak dosya bu markanın arşivinde yok.");
    driveItemId = it.id;
    itemNote = `Drive: ${it.path ?? it.name}`;
  }
  // Kaynak notu her zaman yazılır: Drive dizini silinse bile bilginin nereden geldiği kaybolmaz.
  const sourceNote = (f.sourceNote?.trim() || itemNote)?.slice(0, 500) || null;
  if (f.status === "confirmed" && !driveItemId && !sourceNote) throw new KnowledgeError("Onaylı bilgi için kaynak gerekli (arşiv dosyası veya kaynak notu).");
  if (f.status === "extracted" && !driveItemId) throw new KnowledgeError("Çıkarılan bilgi bir arşiv dosyasına bağlanmalı.");
  const actor = f.actor ?? "user";
  const key = f.entityKey ?? entityKeyOf(`${f.entityType === "collection" ? "collection " : ""}${name}`);
  if (f.status === "confirmed") {
    await q(`UPDATE knowledge_facts SET status = 'rejected', updated_at = now() WHERE brand_id = $1 AND entity_key = $2 AND attribute = $3 AND status = 'confirmed'`, [brandId, key, attribute], db);
  }
  const row = (await q1<KnowledgeFactRow>(
    `INSERT INTO knowledge_facts (brand_id, entity_key, entity_type, entity_name, attribute, value, status, sensitivity, drive_item_id, source_note, method, decided_by, decided_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $7 = 'confirmed' THEN $12 END, CASE WHEN $7 = 'confirmed' THEN now() END, $12) RETURNING *`,
    [brandId, key, f.entityType, name, attribute, value, f.status, sensitivity, driveItemId, sourceNote, f.method, actor],
    db,
  ))!;
  await audit({ brandId, actor, action: "knowledge.fact_added", message: `Bilgi eklendi (${f.status}): ${name} · ${attribute}`, data: { factId: row.id } }, db);
  return row;
}

/** Sahip incelemesi: onaylanan olgu kanonik olur (aynı öznitelikteki eski onaylı değerin yerini alır); reddedilen hiçbir yerde kullanılmaz. */
export async function decideKnowledgeFact(brandId: string, id: string, decision: "confirm" | "reject", actor = "user", db: Queryable = getPool()) {
  if (!isUuid(id)) throw new KnowledgeError("Bilgi bulunamadı.");
  const f = await q1<KnowledgeFactRow>(`SELECT * FROM knowledge_facts WHERE id = $1 AND brand_id = $2`, [id, brandId], db);
  if (!f) throw new KnowledgeError("Bilgi bulunamadı.");
  if (decision === "reject") {
    await q(`UPDATE knowledge_facts SET status = 'rejected', decided_by = $3, decided_at = now(), updated_at = now() WHERE id = $1 AND brand_id = $2`, [id, brandId, actor], db);
  } else {
    if (!f.drive_item_id && !f.source_note) throw new KnowledgeError("Kaynağı olmayan bilgi onaylanamaz; önce kaynak ekleyin.");
    await q(`UPDATE knowledge_facts SET status = 'rejected', updated_at = now() WHERE brand_id = $1 AND entity_key = $2 AND attribute = $3 AND status = 'confirmed' AND id <> $4`, [brandId, f.entity_key, f.attribute, id], db);
    await q(`UPDATE knowledge_facts SET status = 'confirmed', decided_by = $3, decided_at = now(), updated_at = now() WHERE id = $1 AND brand_id = $2`, [id, brandId, actor], db);
  }
  await audit({ brandId, actor, action: `knowledge.fact_${decision}`, message: `Bilgi ${decision === "confirm" ? "onaylandı" : "reddedildi"}: ${f.entity_name} · ${f.attribute}`, data: { factId: id } }, db);
}

export async function listKnowledgeFacts(brandId: string, opts: { status?: KnowledgeFactRow["status"] | "pending"; limit?: number } = {}, db: Queryable = getPool()) {
  const status = opts.status === "pending" ? ["extracted", "suggested"] : opts.status ? [opts.status] : ["confirmed", "extracted", "suggested", "rejected"];
  return q<KnowledgeFactRow & { item_name: string | null; item_file_id: string | null; item_state: string | null }>(
    `SELECT f.*, i.name AS item_name, i.file_id AS item_file_id, i.state AS item_state
     FROM knowledge_facts f LEFT JOIN drive_items i ON i.id = f.drive_item_id AND i.brand_id = f.brand_id
     WHERE f.brand_id = $1 AND f.status = ANY($2::text[])
     ORDER BY f.entity_type, f.entity_name, f.attribute, f.created_at DESC LIMIT $3`,
    [brandId, status, Math.min(500, opts.limit ?? 200)],
    db,
  );
}

// ---------------------------------------------------------------- Arşiv (Drive dizini) → sınıflandırılmış dosyalar

export const driveFileUrl = (fileId: string) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;

/** Drive dizinindeki (kaldırılmamış, klasör olmayan) dosyalar; kategori ve hassasiyetle. */
export async function loadArchiveFiles(brandId: string, db: Queryable = getPool()): Promise<{ files: ArchiveFile[]; folderId: string | null; lastSyncedAt: string | null }> {
  const src = await q1<{ folder_id: string | null; last_success_at: string | null }>(`SELECT folder_id, last_success_at FROM drive_sources WHERE brand_id = $1`, [brandId], db);
  if (!src?.folder_id) return { files: [], folderId: null, lastSyncedAt: null };
  const rows = await q<{ file_id: string; name: string; mime_type: string; path: string | null; size_bytes: string | null; modified_time: string | null; version: string | null; image_width: number | null; image_height: number | null; first_seen_at: string; last_seen_at: string; md5_checksum: string | null }>(
    `SELECT file_id, name, mime_type, path, size_bytes, modified_time, version, image_width, image_height, first_seen_at, last_seen_at, md5_checksum
     FROM drive_items WHERE brand_id = $1 AND NOT is_folder AND state IN ('indexed','pending_checksum') ORDER BY path LIMIT 20000`,
    [brandId],
    db,
  );
  const files = rows.map((r): ArchiveFile => {
    const path = r.path ?? r.name;
    const category = classifyFile({ name: r.name, path, mimeType: r.mime_type });
    const modified = r.modified_time ? new Date(r.modified_time).toISOString() : new Date(r.last_seen_at).toISOString();
    return {
      brandId, driveFileId: r.file_id, name: r.name, mimeType: r.mime_type, path, sourceUrl: driveFileUrl(r.file_id),
      category, sensitivity: sensitivityForFile(category, r.mime_type), modifiedTime: modified, revisionId: r.version,
      size: r.size_bytes ? Number(r.size_bytes) : null, width: r.image_width, height: r.image_height,
      firstIndexedAt: new Date(r.first_seen_at).toISOString(), lastIndexedAt: new Date(r.last_seen_at).toISOString(),
      revisions: [{ revisionId: r.version, modifiedTime: modified, md5: r.md5_checksum, indexedAt: new Date(r.last_seen_at).toISOString() }],
      removed: false,
    };
  });
  return { files, folderId: src.folder_id, lastSyncedAt: src.last_success_at ? new Date(src.last_success_at).toISOString() : null };
}

/** Kalıcı veriden bilgi grafiği ve arşiv dizini (retrieval.searchKnowledge ile aranabilir). */
export async function loadKnowledge(brandId: string, db: Queryable = getPool()) {
  const graph = new KnowledgeGraph(brandId);
  const facts = await listKnowledgeFacts(brandId, { limit: 500 }, db);
  const decision = (f: KnowledgeFactRow) => (f.decided_by && f.decided_at ? { by: f.decided_by, at: new Date(f.decided_at).toISOString() } : null);
  for (const f of facts.filter((x) => x.status !== "rejected")) {
    // Kaynak dosyası dizinden silinmiş çıkarım gerçek sayılamaz; grafiğe alınmaz (incelemede görünür).
    if (f.status === "extracted" && !f.item_file_id) continue;
    if (!graph.get(brandId, f.entity_key)) graph.addEntity(brandId, { id: f.entity_key, type: f.entity_type, name: f.entity_name });
    graph.addFact(brandId, f.entity_key, {
      attribute: f.attribute, value: f.value, status: f.status as ClaimStatus, sensitivity: f.sensitivity, decision: decision(f),
      provenance: [{
        driveFileId: f.item_file_id, revisionId: null, sourceUrl: f.item_file_id ? driveFileUrl(f.item_file_id) : `note:${f.source_note ?? ""}`.slice(0, 300),
        modifiedTime: new Date(f.updated_at).toISOString(), indexedAt: new Date(f.created_at).toISOString(), method: f.method === "document" ? "manual" : f.method,
      }],
    });
  }
  const { files, folderId, lastSyncedAt } = await loadArchiveFiles(brandId, db);
  const index = folderId ? ArchiveIndex.fromFiles(brandId, folderId, files, lastSyncedAt) : null;
  return { graph, index };
}

// ---------------------------------------------------------------- Ajan bağlamı (rol bazlı)

const ROLE_CATEGORIES: Record<KnowledgeRole, ArchiveCategory[]> = {
  manager: ["product_names", "product_story", "collection_history", "lookbook"],
  video_design: ["catalog_photo", "catalog_video", "design_source", "lookbook"],
  marketing: ["product_names", "product_story", "collection_history", "lookbook", "catalog_photo"],
  pr: ["pr_coverage", "product_story", "collection_history", "lookbook"],
  finance: ["financial_record", "production_spec", "logistics"],
};

export type KnowledgeContext = {
  role: KnowledgeRole;
  role_label: string;
  /** Koleksiyonlar: onaylı renk, sahibin doğruladığı ön/arka/detay baskı görselleri ve onaylı hikâye kaynakları. */
  collections: {
    key: string;
    name: string;
    color: string | null;
    facts: { attribute: string; value: string; source: string }[];
    verified_prints: { view: string; file: string; media_asset_id: string | null }[];
  }[];
  /** Diğer onaylı bilgiler (rolün görebildiği hassasiyette). */
  facts: { entity: string; type: string; attribute: string; value: string; source: string }[];
  archive: {
    connected: boolean;
    last_synced_at: string | null;
    files_by_category: Partial<Record<ArchiveCategory, number>>;
    /** Rolün işine yarayan dosyalar (yalnızca üst veri; içerik değil). */
    relevant_files: { name: string; path: string; category: ArchiveCategory; url: string; width: number | null; height: number | null }[];
  };
  pending_review: number;
  /** Rol izni nedeniyle verilmeyen kayıt sayısı (içerik verilmez). */
  withheld: number;
};

/** Ajan bağlamı için rol filtreli bilgi özeti. "private" hiçbir role verilmez; finans yalnızca Finans rolüne. */
export async function knowledgeForRole(brandId: string, role: KnowledgeRole, db: Queryable = getPool()): Promise<KnowledgeContext> {
  const [facts, refs, archive, pending] = await Promise.all([
    listKnowledgeFacts(brandId, { status: "confirmed", limit: 500 }, db),
    q<{ theme: FribeeTheme; view: ReferenceView; name: string; media_asset_id: string | null }>(
      `SELECT r.theme, r.view, i.name, r.media_asset_id FROM drive_references r JOIN drive_items i ON i.id = r.item_id AND i.brand_id = r.brand_id
       WHERE r.brand_id = $1 AND r.status = 'verified' AND i.state <> 'removed' ORDER BY r.theme, r.view, r.verified_at DESC LIMIT 120`,
      [brandId],
      db,
    ),
    loadArchiveFiles(brandId, db),
    q1<{ n: number }>(`SELECT count(*)::int AS n FROM knowledge_facts WHERE brand_id = $1 AND status IN ('extracted','suggested')`, [brandId], db),
  ]);
  let withheld = 0;
  const source = (f: KnowledgeFactRow & { item_name: string | null }) => (f.item_name ? `Drive: ${f.item_name}` : f.source_note ?? "kaynak notu yok");
  const visible = facts.filter((f) => {
    if (canRead(role, f.sensitivity)) return true;
    withheld++;
    return false;
  });
  const collections = new Map<string, KnowledgeContext["collections"][number]>();
  for (const f of visible.filter((x) => x.entity_type === "collection")) {
    const c = collections.get(f.entity_key) ?? { key: f.entity_key, name: f.entity_name, color: null, facts: [], verified_prints: [] };
    if (f.attribute === "theme_color") c.color = f.value;
    else c.facts.push({ attribute: f.attribute, value: f.value.slice(0, 1500), source: source(f) });
    collections.set(f.entity_key, c);
  }
  for (const r of refs) {
    if (!isTheme(r.theme)) continue;
    const key = collectionKey(r.theme);
    const c = collections.get(key) ?? { key, name: THEME_INFO[r.theme].label, color: null, facts: [], verified_prints: [] };
    c.verified_prints.push({ view: VIEW_LABEL[r.view], file: r.name, media_asset_id: r.media_asset_id });
    collections.set(key, c);
  }
  const byCat: Partial<Record<ArchiveCategory, number>> = {};
  const relevant: KnowledgeContext["archive"]["relevant_files"] = [];
  const wanted = new Set(ROLE_CATEGORIES[role]);
  for (const f of archive.files) {
    if (!canRead(role, f.sensitivity)) { withheld++; continue; }
    byCat[f.category] = (byCat[f.category] ?? 0) + 1;
    if (wanted.has(f.category) && relevant.length < 30) relevant.push({ name: f.name, path: f.path, category: f.category, url: f.sourceUrl, width: f.width, height: f.height });
  }
  return {
    role,
    role_label: ROLE_LABELS[role],
    collections: [...collections.values()],
    facts: visible.filter((f) => f.entity_type !== "collection").slice(0, 60).map((f) => ({ entity: f.entity_name, type: f.entity_type, attribute: f.attribute, value: f.value.slice(0, 1500), source: source(f) })),
    archive: { connected: !!archive.folderId, last_synced_at: archive.lastSyncedAt, files_by_category: byCat, relevant_files: relevant },
    pending_review: pending?.n ?? 0,
    withheld,
  };
}

/** Koleksiyon adı/anahtar kelimesi → tema (metinde birden çok koleksiyon geçerse null). */
export function themeMentioned(text: string): FribeeTheme | null {
  const t = normalizeName(text);
  const hits = (Object.keys(THEME_INFO) as FribeeTheme[]).filter((k) => {
    const words: Record<FribeeTheme, RegExp> = {
      space_alien: /\b(space alien|alien|uzayli|uzayl)\b/,
      music: /\b(music|muzik|mandala)\b/,
      anime: /\banime\b/,
      save_the_bee: /\b(save the bee|savethebee)\b/,
    };
    return words[k].test(t);
  });
  return hits.length === 1 ? hits[0] : null;
}
