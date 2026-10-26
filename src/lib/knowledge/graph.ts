import { looksSecret } from "@/lib/services/brand-memory";
import {
  BrandIsolationError,
  KnowledgeError,
  type ClaimStatus,
  type Provenance,
  type Sensitivity,
} from "./types";

// FriBee bilgi grafiği: varlıklar, kaynaklı olgular ve ilişkiler.
// Kural: "confirmed" olgu yalnızca sahip/inceleme kararıyla oluşur; çıkarılan veya önerilen olgu gerçek gibi sunulmaz.
// Ürün hikâyesi uydurulmaz: hikâye metni yalnızca arşiv kaynağıyla "extracted" ya da sahip kararıyla "confirmed" olabilir.

export const ENTITY_TYPES = [
  "brand", "collection", "product", "colorway", "design", "print", "asset",
  "story", "campaign", "supplier", "inventory", "pr_coverage", "decision",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATIONS = [
  "has_collection", "has_product", "has_colorway", "uses_design", "print_front", "print_back",
  "depicts", "tells_story_of", "features", "supplied_by", "stock_of", "covers", "decides", "belongs_to",
] as const;
export type Relation = (typeof RELATIONS)[number];

export type Decision = { by: string; at: string; note?: string };

export type Fact = {
  attribute: string;
  value: string;
  status: ClaimStatus;
  sensitivity: Sensitivity;
  provenance: Provenance[];
  decision: Decision | null;
};

export type Entity = {
  id: string;
  brandId: string;
  type: EntityType;
  name: string;
  aliases: string[];
  sensitivity: Sensitivity;
  facts: Fact[];
};

export type Edge = { brandId: string; from: string; rel: Relation; to: string; status: ClaimStatus; provenance: Provenance[] };

/** Varlık türüne göre varsayılan hassasiyet. */
export function defaultSensitivity(type: EntityType): Sensitivity {
  if (type === "supplier") return "vendor";
  if (type === "pr_coverage") return "public";
  return "internal";
}

export function normalizeName(s: string) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export class KnowledgeGraph {
  private entities = new Map<string, Entity>();
  private edges: Edge[] = [];
  private seq = 0;

  constructor(readonly brandId: string) {}

  private own(brandId: string) {
    if (brandId !== this.brandId) throw new BrandIsolationError("Başka markanın bilgi grafiğine erişilemez.");
  }

  addEntity(brandId: string, input: { type: EntityType; name: string; aliases?: string[]; sensitivity?: Sensitivity; id?: string }): Entity {
    this.own(brandId);
    const name = input.name.trim();
    if (!name) throw new KnowledgeError("Varlık adı boş olamaz.");
    if (looksSecret(name)) throw new KnowledgeError("Varlık adı gizli bilgi içeriyor gibi görünüyor.");
    const id = input.id ?? `${input.type}_${++this.seq}`;
    if (this.entities.has(id)) throw new KnowledgeError(`Varlık zaten var: ${id}`);
    const e: Entity = { id, brandId, type: input.type, name, aliases: input.aliases ?? [], sensitivity: input.sensitivity ?? defaultSensitivity(input.type), facts: [] };
    this.entities.set(id, e);
    return e;
  }

  /**
   * Olgu ekler. Kurallar:
   * - "confirmed" olgu için karar (kim/ne zaman) ve en az bir kaynak zorunludur.
   * - "extracted" olgu arşiv kaynağı (Drive dosyası) gerektirir; kaynaksız çıkarım olmaz.
   * - "story" varlığına kaynaksız metin yalnızca "suggested" olarak eklenebilir (uydurma hikâye gerçek sayılmaz).
   */
  addFact(brandId: string, entityId: string, f: { attribute: string; value: string; status: ClaimStatus; provenance?: Provenance[]; decision?: Decision | null; sensitivity?: Sensitivity }): Fact {
    this.own(brandId);
    const e = this.entities.get(entityId);
    if (!e) throw new KnowledgeError(`Varlık bulunamadı: ${entityId}`);
    const provenance = f.provenance ?? [];
    if (looksSecret(`${f.attribute}\n${f.value}`)) throw new KnowledgeError("Olgu gizli bilgi içeriyor gibi görünüyor; kaydedilmedi.");
    if (f.status === "confirmed" && (!f.decision || !provenance.length)) throw new KnowledgeError("Onaylı olgu için karar ve kaynak gerekli.");
    if (f.status === "extracted" && !provenance.some((p) => p.driveFileId)) throw new KnowledgeError("Çıkarılan olgu bir arşiv dosyasına bağlanmalı.");
    const fact: Fact = { attribute: f.attribute, value: f.value, status: f.status, sensitivity: f.sensitivity ?? e.sensitivity, provenance, decision: f.decision ?? null };
    // Aynı öznitelik için yeni onaylı değer eskisini geçersiz kılar (tek kanonik doğru).
    if (fact.status === "confirmed") e.facts = e.facts.filter((x) => !(x.attribute === fact.attribute && x.status === "confirmed"));
    e.facts.push(fact);
    return fact;
  }

  link(brandId: string, from: string, rel: Relation, to: string, opts: { status?: ClaimStatus; provenance?: Provenance[] } = {}) {
    this.own(brandId);
    if (!this.entities.has(from) || !this.entities.has(to)) throw new KnowledgeError("İlişki için iki varlık da mevcut olmalı.");
    this.edges.push({ brandId, from, rel, to, status: opts.status ?? "confirmed", provenance: opts.provenance ?? [] });
  }

  get(brandId: string, id: string) { this.own(brandId); return this.entities.get(id); }

  list(brandId: string, type?: EntityType): Entity[] {
    this.own(brandId);
    return [...this.entities.values()].filter((e) => !type || e.type === type);
  }

  neighbors(brandId: string, id: string, rel?: Relation): Entity[] {
    this.own(brandId);
    return this.edges.filter((x) => x.from === id && (!rel || x.rel === rel)).map((x) => this.entities.get(x.to)!).filter(Boolean);
  }

  parents(brandId: string, id: string, rel?: Relation): Entity[] {
    this.own(brandId);
    return this.edges.filter((x) => x.to === id && (!rel || x.rel === rel)).map((x) => this.entities.get(x.from)!).filter(Boolean);
  }

  /** Ad veya takma adla eşleşen varlıklar (normalize edilmiş). Birden fazla sonuç belirsizlik demektir. */
  findByName(brandId: string, name: string, type?: EntityType): Entity[] {
    const n = normalizeName(name);
    return this.list(brandId, type).filter((e) => [e.name, ...e.aliases].some((a) => normalizeName(a) === n));
  }

  /** Yalnızca onaylı olgular: yayınlanabilir kanonik ürün doğrusu. */
  canonicalFacts(brandId: string, entityId: string): Fact[] {
    return (this.get(brandId, entityId)?.facts ?? []).filter((f) => f.status === "confirmed");
  }
}

/** Yayın öncesi koruma: onaylanmamış hiçbir olgu dışarı verilmez. */
export function assertPublishable(facts: Fact[]) {
  const bad = facts.filter((f) => f.status !== "confirmed");
  if (bad.length) throw new KnowledgeError(`İncelenmemiş ${bad.length} olgu yayınlanamaz: ${bad.map((f) => f.attribute).join(", ")}`);
}

/** Sahibin issue #22'de verdiği tema bilgisi. Drive arşivi bağlanınca dosya kaynaklarıyla desteklenmelidir. */
export const FRIBEE_OWNER_SOURCE: Provenance = {
  driveFileId: null,
  revisionId: null,
  sourceUrl: "https://github.com/CCC-C52/can/issues/22",
  modifiedTime: "2026-10-26T00:00:00.000Z",
  indexedAt: "2026-10-26T00:00:00.000Z",
  method: "owner",
};

export const FRIBEE_THEMES = [
  { id: "collection_space_alien", name: "Space Alien", color: "black" },
  { id: "collection_music", name: "Music", color: "white" },
  { id: "collection_anime", name: "Anime", color: "orange" },
  { id: "collection_save_the_bee", name: "Save the Bee", color: "light blue" },
] as const;

/**
 * FriBee için bilinen dört temayı ve sahibin doğruladığı ilişkileri (mandala → Music) içeren başlangıç grafiği.
 * Ürün adı, hikâye, SKU gibi bilgiler EKLENMEZ; bunlar arşivden çıkarılıp incelemeden geçmelidir.
 */
export function seedFribeeGraph(brandId: string): KnowledgeGraph {
  const g = new KnowledgeGraph(brandId);
  const decision: Decision = { by: "owner", at: FRIBEE_OWNER_SOURCE.indexedAt, note: "Issue #22" };
  g.addEntity(brandId, { id: "brand_fribee", type: "brand", name: "FriBee" });
  for (const t of FRIBEE_THEMES) {
    g.addEntity(brandId, { id: t.id, type: "collection", name: t.name });
    g.addFact(brandId, t.id, { attribute: "theme_color", value: t.color, status: "confirmed", provenance: [FRIBEE_OWNER_SOURCE], decision });
    g.link(brandId, "brand_fribee", "has_collection", t.id, { provenance: [FRIBEE_OWNER_SOURCE] });
  }
  g.addEntity(brandId, { id: "design_mandala", type: "design", name: "Mandala" });
  g.addFact(brandId, "design_mandala", { attribute: "collection", value: "Music", status: "confirmed", provenance: [FRIBEE_OWNER_SOURCE], decision });
  g.link(brandId, "design_mandala", "belongs_to", "collection_music", { provenance: [FRIBEE_OWNER_SOURCE] });
  return g;
}

/** Bir varlığın bağlı olduğu koleksiyonun onaylı tema rengi. */
export function themeColorOf(g: KnowledgeGraph, brandId: string, entityId: string): string | null {
  const seen = new Set<string>();
  const stack = [entityId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const e = g.get(brandId, id);
    if (e?.type === "collection") return g.canonicalFacts(brandId, id).find((f) => f.attribute === "theme_color")?.value ?? null;
    for (const p of g.parents(brandId, id)) stack.push(p.id);
    for (const n of g.neighbors(brandId, id, "belongs_to")) stack.push(n.id);
  }
  return null;
}
