import { canRead } from "./access";
import type { ArchiveFile, ArchiveIndex } from "./archive";
import { normalizeName, type Entity, type Fact, type KnowledgeGraph } from "./graph";
import { BrandIsolationError, type ClaimStatus, type KnowledgeRole, type Provenance } from "./types";

// Kaynaklı, rol bazlı arama. Her sonuç kaynak bağlantısıyla döner; izin verilmeyen kayıtlar sayılır ama içerikleri verilmez.
// Kaynağı silinmiş, değişmiş veya eşitlemesi eskimiş bilgiler işaretlenir; ajan bunları kesin gerçek olarak kullanmamalıdır.

export type FactFlag = "source_missing" | "source_changed" | "index_stale" | "no_source";

export type CitedFact = {
  attribute: string;
  value: string;
  status: ClaimStatus;
  citations: { sourceUrl: string; driveFileId: string | null; revisionId: string | null; method: Provenance["method"] }[];
  flags: FactFlag[];
};

export type FileHit = {
  driveFileId: string;
  name: string;
  path: string;
  category: ArchiveFile["category"];
  mimeType: string;
  /** Orijinal çözünürlüklü dosyanın Drive bağlantısı (önizleme değil). */
  sourceUrl: string;
  width: number | null;
  height: number | null;
  revisionId: string | null;
  modifiedTime: string;
  /** Ürün görselleri için: üretken model referansı ürün sadakatini garanti etmez. */
  fidelityNote: string | null;
};

export type SearchResult = {
  role: KnowledgeRole;
  entities: { id: string; type: Entity["type"]; name: string; facts: CitedFact[] }[];
  files: FileHit[];
  /** Rol izni nedeniyle gizlenen kayıt sayısı (içerik verilmez). */
  withheld: number;
  warnings: string[];
};

export const DEFAULT_STALE_AFTER_DAYS = 7;
export const FIDELITY_NOTE = "Referans görsel, Gemini/üretken modelde ürün sadakatini garanti etmez; ürün baskısı için doğrulanmış kompozit (orijinal dosya üst üste bindirme) kullanın.";

function tokens(s: string) {
  return normalizeName(s).split(" ").filter((t) => t.length > 1);
}

function matches(qt: string[], hay: string) {
  if (!qt.length) return false;
  const h = normalizeName(hay);
  return qt.every((t) => h.includes(t));
}

export function flagsFor(fact: Fact, index: ArchiveIndex | null, now: Date, staleAfterDays: number): FactFlag[] {
  const flags = new Set<FactFlag>();
  if (!fact.provenance.length) flags.add("no_source");
  for (const p of fact.provenance) {
    if (!p.driveFileId) continue;
    const file = index ? index.get(index.brandId, p.driveFileId) : undefined;
    if (!index || !file || file.removed) { flags.add("source_missing"); continue; }
    if (file.modifiedTime > p.modifiedTime || (p.revisionId && file.revisionId !== p.revisionId)) flags.add("source_changed");
    const synced = index.lastSyncedAt ? Date.parse(index.lastSyncedAt) : 0;
    if (now.getTime() - synced > staleAfterDays * 86_400_000) flags.add("index_stale");
  }
  return [...flags];
}

export function searchKnowledge(
  args: { graph: KnowledgeGraph; index: ArchiveIndex | null; brandId: string; role: KnowledgeRole; query: string },
  opts: { now?: Date; staleAfterDays?: number; limit?: number } = {},
): SearchResult {
  const { graph, index, brandId, role } = args;
  if (graph.brandId !== brandId || (index && index.brandId !== brandId)) throw new BrandIsolationError("Arama yalnızca seçili markanın verisinde yapılabilir.");
  const now = opts.now ?? new Date();
  const staleAfterDays = opts.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const limit = opts.limit ?? 25;
  const qt = tokens(args.query);
  const out: SearchResult = { role, entities: [], files: [], withheld: 0, warnings: [] };
  const fileIds = new Set<string>();

  for (const e of graph.list(brandId)) {
    const hit = matches(qt, [e.name, ...e.aliases].join(" ")) || e.facts.some((f) => matches(qt, f.value));
    if (!hit) continue;
    if (!canRead(role, e.sensitivity)) { out.withheld++; continue; }
    const facts: CitedFact[] = [];
    for (const f of e.facts) {
      if (!canRead(role, f.sensitivity)) { out.withheld++; continue; }
      facts.push({
        attribute: f.attribute,
        value: f.value,
        status: f.status,
        citations: f.provenance.map((p) => ({ sourceUrl: p.sourceUrl, driveFileId: p.driveFileId, revisionId: p.revisionId, method: p.method })),
        flags: flagsFor(f, index, now, staleAfterDays),
      });
      for (const p of f.provenance) if (p.driveFileId) fileIds.add(p.driveFileId);
    }
    out.entities.push({ id: e.id, type: e.type, name: e.name, facts });
  }

  if (index) {
    for (const f of index.list(brandId)) {
      if (!fileIds.has(f.driveFileId) && !matches(qt, `${f.path} ${f.name}`)) continue;
      if (!canRead(role, f.sensitivity)) { out.withheld++; continue; }
      const visual = f.mimeType.startsWith("image/") || f.category === "design_source";
      out.files.push({
        driveFileId: f.driveFileId, name: f.name, path: f.path, category: f.category, mimeType: f.mimeType,
        sourceUrl: f.sourceUrl, width: f.width, height: f.height, revisionId: f.revisionId, modifiedTime: f.modifiedTime,
        fidelityNote: visual && role === "video_design" ? FIDELITY_NOTE : null,
      });
    }
    // En yüksek çözünürlüklü orijinaller önce.
    out.files.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
    out.files = out.files.slice(0, limit);
  } else {
    out.warnings.push("Drive arşivi bağlı değil: sonuçlar yalnızca sahip beyanlarına dayanıyor.");
  }
  if (out.entities.some((e) => e.facts.some((f) => f.flags.includes("source_missing")))) out.warnings.push("Bazı bilgilerin kaynak dosyası artık arşivde yok; yeniden incelenmeli.");
  if (out.entities.some((e) => e.facts.some((f) => f.flags.includes("source_changed")))) out.warnings.push("Bazı kaynak dosyalar bilgi çıkarıldıktan sonra değişti; yeniden incelenmeli.");
  if (out.withheld) out.warnings.push(`${out.withheld} kayıt rol izni nedeniyle gösterilmedi.`);
  return out;
}
