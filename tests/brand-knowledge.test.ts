import { describe, it, expect } from "vitest";
import {
  ArchiveIndex, FixtureDriveSource, assertReadOnlyScopes, classifyFile, googleDriveSourceNotConfigured, type DriveFileMeta,
} from "@/lib/knowledge/archive";
import { KnowledgeGraph, assertPublishable, seedFribeeGraph, themeColorOf } from "@/lib/knowledge/graph";
import { ROLE_ACCESS, canRead, roleForAgent } from "@/lib/knowledge/access";
import { FIDELITY_NOTE, searchKnowledge } from "@/lib/knowledge/retrieval";
import { ReviewQueue, checkArtTheme, queueExtractedName, queueUnclassified } from "@/lib/knowledge/review";
import { buildPrRoadmap, monthlyReviewSchedule } from "@/lib/knowledge/pr-roadmap";
import { BrandIsolationError, KnowledgeError, type Provenance } from "@/lib/knowledge/types";

const ROOT = "root_fribee";
const BRAND = "brand_fribee_test";
const OTHER = "brand_other_test";

function file(id: string, path: string, name: string, extra: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return {
    id, name, path, mimeType: "image/png", ancestors: ["folder_x", ROOT], modifiedTime: "2026-10-01T00:00:00.000Z",
    headRevisionId: "r1", webViewLink: `https://drive.google.com/file/d/${id}/view`, width: 4000, height: 5000, ...extra,
  };
}

const FILES: DriveFileMeta[] = [
  file("f_alien_look", "Collections/Space Alien/Lookbook", "alien_front.png"),
  file("f_mandala_ai", "Collections/Music/Design", "mandala_print_front.ai", { mimeType: "application/illustrator", width: null, height: null }),
  file("f_names", "Catalog", "Product Names.xlsx", { mimeType: "application/vnd.ms-excel", width: null, height: null }),
  file("f_finance", "Finance", "2026 P&L.xlsx", { mimeType: "application/vnd.ms-excel", width: null, height: null }),
  file("f_supplier", "Production", "Tech Pack Hoodie.pdf", { mimeType: "application/pdf", width: null, height: null }),
  file("f_contract", "Legal", "Contract.pdf", { mimeType: "application/pdf", width: null, height: null }),
  file("f_history", "Brand", "Collection History.docx", { mimeType: "application/msword", width: null, height: null }),
  file("f_misc", "Misc", "notes.txt", { mimeType: "text/plain", width: null, height: null }),
  file("f_outside", "Personal", "alien_private.png", { ancestors: ["someone_else_root"] }),
];

function prov(f: DriveFileMeta, method: Provenance["method"] = "ocr"): Provenance {
  return { driveFileId: f.id, revisionId: f.headRevisionId, sourceUrl: f.webViewLink, modifiedTime: f.modifiedTime, indexedAt: "2026-10-02T00:00:00.000Z", method };
}

async function setup(now = new Date("2026-10-26T00:00:00.000Z")) {
  const source = new FixtureDriveSource(BRAND, ROOT, FILES);
  const index = new ArchiveIndex(BRAND, ROOT, () => now);
  const report = await index.fullSync(source);
  return { source, index, report, graph: seedFribeeGraph(BRAND) };
}

describe("Drive arşiv dizini (güvenlik, yalıtım, artımlı eşitleme)", () => {
  it("yalnızca salt okunur OAuth kapsamlarını kabul eder; Drive bağlantısı yapılandırılmadan çalışmaz", () => {
    expect(() => assertReadOnlyScopes(["https://www.googleapis.com/auth/drive.readonly"])).not.toThrow();
    expect(() => assertReadOnlyScopes(["https://www.googleapis.com/auth/drive"])).toThrow(KnowledgeError);
    expect(() => assertReadOnlyScopes(["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file"])).toThrow(KnowledgeError);
    expect(() => assertReadOnlyScopes([])).toThrow(KnowledgeError);
    expect(() => googleDriveSourceNotConfigured()).toThrow(/OAuth/);
  });

  it("yazma kapsamlı kaynakla eşitleme reddedilir", async () => {
    const idx = new ArchiveIndex(BRAND, ROOT);
    await expect(idx.fullSync(new FixtureDriveSource(BRAND, ROOT, FILES, ["https://www.googleapis.com/auth/drive"]))).rejects.toThrow(KnowledgeError);
  });

  it("dosya kategorilerini sınıflandırır ve hassasiyet atar", async () => {
    const { index } = await setup();
    const cat = (id: string) => index.get(BRAND, id)!;
    expect(cat("f_alien_look").category).toBe("lookbook");
    expect(cat("f_mandala_ai").category).toBe("design_source");
    expect(cat("f_names").category).toBe("product_names");
    expect(cat("f_finance")).toMatchObject({ category: "financial_record", sensitivity: "finance" });
    expect(cat("f_supplier")).toMatchObject({ category: "production_spec", sensitivity: "vendor" });
    expect(cat("f_contract")).toMatchObject({ category: "business_record", sensitivity: "private" });
    expect(cat("f_history").category).toBe("collection_history");
    expect(cat("f_misc").category).toBe("other");
    expect(classifyFile({ name: "storyboard.mp4", path: "Campaigns", mimeType: "video/mp4" })).toBe("product_story");
  });

  it("orijinal Drive kimliği, bağlantı, zaman ve revizyon korunur; kök dışı dosya alınmaz", async () => {
    const { index, report } = await setup();
    expect(report.skippedOutsideRoot).toBe(1);
    expect(index.get(BRAND, "f_outside")).toBeUndefined();
    const f = index.get(BRAND, "f_alien_look")!;
    expect(f).toMatchObject({ driveFileId: "f_alien_look", sourceUrl: "https://drive.google.com/file/d/f_alien_look/view", revisionId: "r1", modifiedTime: "2026-10-01T00:00:00.000Z" });
    expect(f.revisions).toHaveLength(1);
  });

  it("artımlı eşitleme yalnızca değişiklikleri işler, revizyon geçmişini büyütür ve silmeleri işaretler", async () => {
    const { index, source } = await setup();
    const before = index.cursor;
    source.push({ fileId: "f_alien_look", removed: false, file: file("f_alien_look", "Collections/Space Alien/Lookbook", "alien_front.png", { headRevisionId: "r2", modifiedTime: "2026-10-20T00:00:00.000Z" }) });
    source.push({ fileId: "f_misc", removed: true });
    source.push({ fileId: "f_new", removed: false, file: file("f_new", "Collections/Anime/Lookbook", "anime.png") });
    source.push({ fileId: "f_names", removed: false, file: FILES[2] }); // değişmemiş
    const r = await index.incrementalSync(source);
    expect(r).toMatchObject({ added: 1, updated: 1, removed: 1, skippedUnchanged: 1 });
    expect(index.cursor).not.toBe(before);
    expect(index.get(BRAND, "f_alien_look")!.revisions.map((x) => x.revisionId)).toEqual(["r1", "r2"]);
    expect(index.get(BRAND, "f_misc")!.removed).toBe(true);
    expect(index.list(BRAND).some((f) => f.driveFileId === "f_misc")).toBe(false);
    expect(index.list(BRAND, { includeRemoved: true }).some((f) => f.driveFileId === "f_misc")).toBe(true);
  });

  it("tam taramadan önce artımlı eşitleme yapılamaz", async () => {
    const idx = new ArchiveIndex(BRAND, ROOT);
    await expect(idx.incrementalSync(new FixtureDriveSource(BRAND, ROOT, FILES))).rejects.toThrow(KnowledgeError);
  });

  it("gizli bilgi içeren dosya adı dizine alınmaz", async () => {
    const idx = new ArchiveIndex(BRAND, ROOT);
    const r = await idx.fullSync(new FixtureDriveSource(BRAND, ROOT, [file("f_secret", "Ops", "api_key=sk-ant-abcdefghijklmnopqrstu.txt", { mimeType: "text/plain" })]));
    expect(r.rejectedSecretName).toBe(1);
    expect(idx.list(BRAND)).toEqual([]);
  });

  it("marka yalıtımı: başka markanın kaynağı veya kök klasörü reddedilir; başka marka dizini okuyamaz", async () => {
    const { index } = await setup();
    await expect(new ArchiveIndex(BRAND, ROOT).fullSync(new FixtureDriveSource(OTHER, ROOT, FILES))).rejects.toBeInstanceOf(BrandIsolationError);
    await expect(new ArchiveIndex(BRAND, ROOT).fullSync(new FixtureDriveSource(BRAND, "other_root", FILES))).rejects.toBeInstanceOf(BrandIsolationError);
    expect(() => index.list(OTHER)).toThrow(BrandIsolationError);
    expect(() => index.get(OTHER, "f_alien_look")).toThrow(BrandIsolationError);
  });
});

describe("FriBee bilgi grafiği", () => {
  it("dört tema ve mandala → Music sahip kaynağıyla onaylı; ürün/hikâye uydurulmaz", () => {
    const g = seedFribeeGraph(BRAND);
    const colors = Object.fromEntries(g.list(BRAND, "collection").map((c) => [c.name, g.canonicalFacts(BRAND, c.id)[0].value]));
    expect(colors).toEqual({ "Space Alien": "black", Music: "white", Anime: "orange", "Save the Bee": "light blue" });
    expect(g.neighbors(BRAND, "design_mandala", "belongs_to").map((e) => e.name)).toEqual(["Music"]);
    expect(themeColorOf(g, BRAND, "design_mandala")).toBe("white");
    expect(g.list(BRAND, "product")).toEqual([]);
    expect(g.list(BRAND, "story")).toEqual([]);
    for (const c of g.list(BRAND, "collection")) expect(g.canonicalFacts(BRAND, c.id)[0].provenance[0].sourceUrl).toMatch(/issues\/22$/);
  });

  it("onaylı olgu karar + kaynak, çıkarılan olgu arşiv dosyası gerektirir; kaynaksız hikâye yalnızca öneri olur", () => {
    const g = new KnowledgeGraph(BRAND);
    const s = g.addEntity(BRAND, { type: "story", name: "Space Alien origin" });
    expect(() => g.addFact(BRAND, s.id, { attribute: "text", value: "Uydurma", status: "confirmed" })).toThrow(KnowledgeError);
    expect(() => g.addFact(BRAND, s.id, { attribute: "text", value: "Uydurma", status: "extracted" })).toThrow(KnowledgeError);
    const sug = g.addFact(BRAND, s.id, { attribute: "text", value: "AI draft", status: "suggested" });
    expect(sug.status).toBe("suggested");
    expect(g.canonicalFacts(BRAND, s.id)).toEqual([]);
    expect(() => assertPublishable(s.facts)).toThrow(/yayınlanamaz/);
  });

  it("gizli bilgi olarak görünen olgu kaydedilmez; başka marka grafiğe yazamaz", () => {
    const g = seedFribeeGraph(BRAND);
    expect(() => g.addFact(BRAND, "brand_fribee", { attribute: "note", value: "password: hunter2024", status: "suggested" })).toThrow(KnowledgeError);
    expect(() => g.addEntity(OTHER, { type: "product", name: "X" })).toThrow(BrandIsolationError);
    expect(() => g.list(OTHER)).toThrow(BrandIsolationError);
  });
});

describe("Rol bazlı, kaynaklı arama", () => {
  it("rol izinleri: finans/tedarikçi/özel kayıtlar yalnızca yetkili role", () => {
    expect(canRead("finance", "finance")).toBe(true);
    for (const r of ["manager", "video_design", "marketing", "pr"] as const) expect(canRead(r, "finance")).toBe(false);
    expect(canRead("manager", "vendor")).toBe(true);
    expect(canRead("pr", "vendor")).toBe(false);
    for (const r of Object.keys(ROLE_ACCESS) as (keyof typeof ROLE_ACCESS)[]) expect(canRead(r, "private")).toBe(false);
    expect(roleForAgent("video")).toBe("video_design");
    expect(roleForAgent("shopify")).toBe("marketing");
  });

  it("finans dosyası PR rolüne verilmez, finans rolüne verilir", async () => {
    const { index, graph } = await setup();
    const pr = searchKnowledge({ graph, index, brandId: BRAND, role: "pr", query: "finance" });
    expect(pr.files).toEqual([]);
    expect(pr.withheld).toBeGreaterThan(0);
    const fin = searchKnowledge({ graph, index, brandId: BRAND, role: "finance", query: "finance" });
    expect(fin.files.map((f) => f.driveFileId)).toEqual(["f_finance"]);
    const contract = searchKnowledge({ graph, index, brandId: BRAND, role: "finance", query: "contract" });
    expect(contract.files).toEqual([]);
  });

  it("orijinal çözünürlüklü dosya bağlantısı döner; tasarım rolünde ürün sadakati notu eklenir", async () => {
    const { index, graph } = await setup();
    const r = searchKnowledge({ graph, index, brandId: BRAND, role: "video_design", query: "alien" });
    expect(r.files[0]).toMatchObject({ driveFileId: "f_alien_look", width: 4000, height: 5000, sourceUrl: "https://drive.google.com/file/d/f_alien_look/view", fidelityNote: FIDELITY_NOTE });
    expect(r.entities.find((e) => e.name === "Space Alien")!.facts[0].citations[0].sourceUrl).toMatch(/issues\/22$/);
    const m = searchKnowledge({ graph, index, brandId: BRAND, role: "marketing", query: "alien" });
    expect(m.files[0].fidelityNote).toBeNull();
  });

  it("kaynak eksik, değişmiş ve eski dizin bayrakları", async () => {
    const now = new Date("2026-10-26T00:00:00.000Z");
    const { index, source, graph } = await setup(now);
    const p = graph.addEntity(BRAND, { type: "product", name: "Alien Hoodie" });
    graph.addFact(BRAND, p.id, { attribute: "name", value: "Alien Hoodie", status: "extracted", provenance: [prov(FILES[0])] });
    graph.addFact(BRAND, p.id, { attribute: "note", value: "Alien Hoodie misc note", status: "extracted", provenance: [prov(FILES[7])] });
    let r = searchKnowledge({ graph, index, brandId: BRAND, role: "manager", query: "Alien Hoodie" }, { now });
    expect(r.entities[0].facts.every((f) => f.flags.length === 0)).toBe(true);

    source.push({ fileId: "f_alien_look", removed: false, file: file("f_alien_look", "Collections/Space Alien/Lookbook", "alien_front.png", { headRevisionId: "r2", modifiedTime: "2026-10-25T00:00:00.000Z" }) });
    source.push({ fileId: "f_misc", removed: true });
    await index.incrementalSync(source);
    r = searchKnowledge({ graph, index, brandId: BRAND, role: "manager", query: "Alien Hoodie" }, { now });
    const byAttr = Object.fromEntries(r.entities[0].facts.map((f) => [f.attribute, f.flags]));
    expect(byAttr.name).toContain("source_changed");
    expect(byAttr.note).toContain("source_missing");
    expect(r.warnings.join(" ")).toMatch(/kaynak dosyası artık arşivde yok/);

    const later = new Date("2026-11-30T00:00:00.000Z");
    r = searchKnowledge({ graph, index, brandId: BRAND, role: "manager", query: "Alien Hoodie" }, { now: later });
    expect(r.entities[0].facts.find((f) => f.attribute === "name")!.flags).toContain("index_stale");
  });

  it("arşiv bağlı değilken uyarı verir; başka markanın grafiğiyle arama reddedilir", () => {
    const graph = seedFribeeGraph(BRAND);
    const r = searchKnowledge({ graph, index: null, brandId: BRAND, role: "pr", query: "music" });
    expect(r.warnings[0]).toMatch(/Drive arşivi bağlı değil/);
    expect(r.entities.map((e) => e.name)).toContain("Music");
    expect(() => searchKnowledge({ graph, index: null, brandId: OTHER, role: "pr", query: "music" })).toThrow(BrandIsolationError);
  });
});

describe("İnceleme kuyruğu", () => {
  it("OCR adı onaylanana kadar kanonik doğruya girmez; onay kaynak ve kararla yazılır", async () => {
    const { graph } = await setup();
    const q = new ReviewQueue(BRAND);
    const p = graph.addEntity(BRAND, { type: "product", name: "Alien Tee" });
    graph.link(BRAND, "collection_space_alien", "has_product", p.id);
    const item = queueExtractedName(q, graph, BRAND, "Alien Tee", prov(FILES[2]));
    expect(item.kind).toBe("ocr_extraction");
    expect(graph.canonicalFacts(BRAND, p.id)).toEqual([]);
    q.approve(BRAND, item.id, graph, { reviewer: "owner" });
    const canon = graph.canonicalFacts(BRAND, p.id);
    expect(canon[0]).toMatchObject({ attribute: "name", value: "Alien Tee", status: "confirmed", decision: { by: "owner" } });
    expect(canon[0].provenance[0].driveFileId).toBe("f_names");
    expect(() => q.approve(BRAND, item.id, graph, { reviewer: "owner" })).toThrow(/zaten/);
  });

  it("belirsiz ad için aday seçimi zorunlu; tema rengiyle uyuşmayan görsel incelemeye düşer", async () => {
    const { graph } = await setup();
    const q = new ReviewQueue(BRAND);
    const a = graph.addEntity(BRAND, { type: "product", name: "Bee Hoodie" });
    graph.addEntity(BRAND, { type: "product", name: "Bee-Hoodie", aliases: [] });
    graph.link(BRAND, "collection_save_the_bee", "has_product", a.id);
    const amb = queueExtractedName(q, graph, BRAND, "bee hoodie", prov(FILES[2]));
    expect(amb.kind).toBe("ambiguous_name");
    expect(amb.candidates).toHaveLength(2);
    expect(() => q.approve(BRAND, amb.id, graph, { reviewer: "owner" })).toThrow(/aday/);
    q.approve(BRAND, amb.id, graph, { reviewer: "owner", entityId: a.id });

    const mismatch = checkArtTheme(q, graph, BRAND, a.id, "orange", prov(FILES[0], "vision"));
    expect(mismatch?.kind).toBe("art_mismatch");
    expect(mismatch?.candidates).toEqual(["light blue"]);
    expect(checkArtTheme(q, graph, BRAND, a.id, "Light Blue", prov(FILES[0], "vision"))).toBeNull();
    q.reject(BRAND, mismatch!.id, { reviewer: "owner", note: "Yanlış dosya" });
    expect(q.list(BRAND, "rejected")).toHaveLength(1);
  });

  it("sınıflandırılamayan dosyalar bir kez kuyruğa alınır; kaynaksız çıkarım ve başka marka reddedilir", async () => {
    const { index } = await setup();
    const q = new ReviewQueue(BRAND);
    expect(queueUnclassified(q, BRAND, index.list(BRAND))).toHaveLength(1);
    expect(queueUnclassified(q, BRAND, index.list(BRAND))).toHaveLength(0);
    expect(() => q.enqueue(BRAND, { kind: "ocr_extraction", entityId: null, attribute: "name", proposedValue: "X", reason: "r", provenance: [] })).toThrow(KnowledgeError);
    expect(() => q.list(OTHER)).toThrow(BrandIsolationError);
  });
});

describe("PR Ajansı 24 aylık yol haritası", () => {
  it("Kasım 2026 – Ekim 2028, 8 çeyrek, 24 aylık inceleme; öneri olarak işaretli ve uydurma veri yok", () => {
    const r = buildPrRoadmap(seedFribeeGraph(BRAND), null);
    expect(r.status).toBe("proposal");
    expect(r.period).toEqual({ start: "2026-11", end: "2028-10" });
    expect(r.quarters).toHaveLength(8);
    expect(r.quarters[0].start).toBe("2026-11");
    expect(r.quarters[7].end).toBe("2028-10");
    expect(r.monthlyReviews).toHaveLength(24);
    expect(r.monthlyReviews[0]).toBe("2026-11");
    expect(r.monthlyReviews[23]).toBe("2028-10");
    expect(monthlyReviewSchedule("2026-11", 3)).toEqual(["2026-11", "2026-12", "2027-01"]);
    const ws = new Set(r.quarters.flatMap((q) => q.workstreams));
    for (const w of ["launch_foundation", "editorial", "microcreators", "ugc_community", "partnerships", "reputation"]) expect(ws.has(w as never)).toBe(true);
    for (const m of r.metrics) expect([m.baseline, m.target]).toEqual(["to_be_measured", "owner_to_set_after_baseline"]);
    // Uydurma sayısal sonuç/pazar verisi içermez (yüzde veya parasal tutar yok)
    expect(JSON.stringify(r.quarters) + JSON.stringify(r.metrics)).not.toMatch(/\d+\s*%|\$\s*\d/);
    expect(r.sourceBacked).toBe(false);
    expect(r.missingSources.length).toBeGreaterThan(0);
    expect(r.citations).toHaveLength(4);
  });

  it("arşiv bağlandığında eksik kaynak kategorileri azalır", async () => {
    const { index, graph } = await setup();
    const withArchive = buildPrRoadmap(graph, index);
    const without = buildPrRoadmap(graph, null);
    expect(withArchive.missingSources.length).toBeLessThan(without.missingSources.length);
    expect(withArchive.missingSources).toContain("pr_coverage");
  });
});
