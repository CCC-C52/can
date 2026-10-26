import type { ArchiveFile } from "./archive";
import { themeColorOf, type KnowledgeGraph } from "./graph";
import { BrandIsolationError, KnowledgeError, type Provenance } from "./types";

// İnceleme kuyruğu: OCR/görsel çıkarımları, belirsiz adlar, tema ile uyuşmayan ürün görselleri ve sınıflandırılamayan dosyalar.
// Onaylanan öğe grafiğe "confirmed" olgu olarak kaynaklarıyla yazılır; onaylanmayan hiçbir şey kanonik doğruya girmez.

export const REVIEW_KINDS = ["ocr_extraction", "vision_extraction", "ambiguous_name", "art_mismatch", "unclassified_file"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ReviewItem = {
  id: string;
  brandId: string;
  kind: ReviewKind;
  entityId: string | null;
  attribute: string | null;
  proposedValue: string;
  candidates: string[];
  reason: string;
  provenance: Provenance[];
  status: "pending" | "approved" | "rejected";
  reviewer: string | null;
  decidedAt: string | null;
  note: string | null;
};

export class ReviewQueue {
  private items = new Map<string, ReviewItem>();
  private seq = 0;
  constructor(readonly brandId: string, private now: () => Date = () => new Date()) {}

  private own(brandId: string) {
    if (brandId !== this.brandId) throw new BrandIsolationError("Başka markanın inceleme kuyruğuna erişilemez.");
  }

  enqueue(brandId: string, input: Omit<ReviewItem, "id" | "brandId" | "status" | "reviewer" | "decidedAt" | "note" | "candidates"> & { candidates?: string[] }): ReviewItem {
    this.own(brandId);
    if ((input.kind === "ocr_extraction" || input.kind === "vision_extraction") && !input.provenance.some((p) => p.driveFileId)) {
      throw new KnowledgeError("Çıkarım öğesi kaynak arşiv dosyasına bağlanmalı.");
    }
    const item: ReviewItem = { ...input, candidates: input.candidates ?? [], id: `rev_${++this.seq}`, brandId, status: "pending", reviewer: null, decidedAt: null, note: null };
    this.items.set(item.id, item);
    return item;
  }

  list(brandId: string, status?: ReviewItem["status"]): ReviewItem[] {
    this.own(brandId);
    return [...this.items.values()].filter((i) => !status || i.status === status);
  }

  /** Sahip/yetkili inceleyici onayı: olgu grafiğe kaynaklı ve kararlı olarak yazılır. */
  approve(brandId: string, id: string, graph: KnowledgeGraph, by: { reviewer: string; value?: string; entityId?: string; note?: string }) {
    this.own(brandId);
    if (graph.brandId !== brandId) throw new BrandIsolationError("İnceleme ve grafik aynı markaya ait olmalı.");
    const item = this.items.get(id);
    if (!item) throw new KnowledgeError("İnceleme öğesi bulunamadı.");
    if (item.status !== "pending") throw new KnowledgeError("Öğe zaten karara bağlanmış.");
    if (!by.reviewer.trim()) throw new KnowledgeError("İnceleyici belirtilmeli.");
    if (item.kind === "ambiguous_name" && (!by.entityId || !item.candidates.includes(by.entityId))) {
      throw new KnowledgeError("Belirsiz ad için aday ürünlerden biri seçilmeli.");
    }
    const entityId = by.entityId ?? item.entityId;
    const at = this.now().toISOString();
    if (entityId && item.attribute) {
      graph.addFact(brandId, entityId, {
        attribute: item.attribute,
        value: by.value ?? item.proposedValue,
        status: "confirmed",
        provenance: item.provenance,
        decision: { by: by.reviewer, at, note: by.note },
      });
    }
    Object.assign(item, { status: "approved", reviewer: by.reviewer, decidedAt: at, note: by.note ?? null });
    return item;
  }

  reject(brandId: string, id: string, by: { reviewer: string; note?: string }) {
    this.own(brandId);
    const item = this.items.get(id);
    if (!item) throw new KnowledgeError("İnceleme öğesi bulunamadı.");
    if (item.status !== "pending") throw new KnowledgeError("Öğe zaten karara bağlanmış.");
    Object.assign(item, { status: "rejected", reviewer: by.reviewer, decidedAt: this.now().toISOString(), note: by.note ?? null });
    return item;
  }
}

/**
 * OCR/görsel çıkarımından gelen ürün adını kuyruğa alır. Ad grafikte birden fazla varlıkla eşleşirse
 * "ambiguous_name", hiç eşleşmezse yeni ad önerisi olarak "ocr_extraction" kaydı oluşur. Hiçbiri doğrudan onaylanmaz.
 */
export function queueExtractedName(queue: ReviewQueue, graph: KnowledgeGraph, brandId: string, name: string, provenance: Provenance) {
  const found = graph.findByName(brandId, name, "product");
  if (found.length > 1) {
    return queue.enqueue(brandId, { kind: "ambiguous_name", entityId: null, attribute: "name", proposedValue: name, candidates: found.map((e) => e.id), reason: `"${name}" birden fazla ürünle eşleşiyor.`, provenance: [provenance] });
  }
  return queue.enqueue(brandId, {
    kind: provenance.method === "vision" ? "vision_extraction" : "ocr_extraction",
    entityId: found[0]?.id ?? null,
    attribute: "name",
    proposedValue: name,
    reason: found.length ? "Çıkarılan ad mevcut ürünle eşleşti; onay bekliyor." : "Çıkarılan ad bilinen bir ürünle eşleşmiyor.",
    provenance: [provenance],
  });
}

/** Görsel analizinin bulduğu baskın renk, ürünün koleksiyon tema rengiyle uyuşmuyorsa inceleme açar. */
export function checkArtTheme(queue: ReviewQueue, graph: KnowledgeGraph, brandId: string, entityId: string, detectedColor: string, provenance: Provenance): ReviewItem | null {
  const expected = themeColorOf(graph, brandId, entityId);
  if (!expected || expected.toLowerCase() === detectedColor.trim().toLowerCase()) return null;
  return queue.enqueue(brandId, {
    kind: "art_mismatch", entityId, attribute: null, proposedValue: detectedColor, candidates: [expected],
    reason: `Görsel rengi (${detectedColor}) koleksiyon tema rengiyle (${expected}) uyuşmuyor.`, provenance: [provenance],
  });
}

/** Sınıflandırılamayan arşiv dosyalarını kuyruğa alır (aynı dosya için tekrar açmaz). */
export function queueUnclassified(queue: ReviewQueue, brandId: string, files: ArchiveFile[]) {
  const open = new Set(queue.list(brandId).filter((i) => i.kind === "unclassified_file").map((i) => i.provenance[0]?.driveFileId));
  return files.filter((f) => f.category === "other" && !open.has(f.driveFileId)).map((f) => queue.enqueue(brandId, {
    kind: "unclassified_file", entityId: null, attribute: null, proposedValue: f.name, reason: `Kategori belirlenemedi: ${f.path}`,
    provenance: [{ driveFileId: f.driveFileId, revisionId: f.revisionId, sourceUrl: f.sourceUrl, modifiedTime: f.modifiedTime, indexedAt: f.lastIndexedAt, method: "metadata" }],
  }));
}
