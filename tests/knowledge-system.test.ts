import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { uploadMedia } from "@/lib/services/media";
import { buildBrandContext, type BrandContext } from "@/lib/agents/context";
import { AGENTS } from "@/lib/agents/registry";
import { runRuleChecks } from "@/lib/agents/qa-rules";
import { Engine } from "@/lib/orchestrator/engine";
import { submitInstruction } from "@/lib/orchestrator/projects";
import { listOutputs, getCurrentVersion } from "@/lib/services/outputs";
import { searchKnowledge } from "@/lib/knowledge/retrieval";
import {
  addKnowledgeFact, confirmFribeeCollections, decideKnowledgeFact, knowledgeForRole, listKnowledgeFacts, loadKnowledge, themeMentioned,
} from "@/lib/knowledge/store";
import { verifiedCatalogPhotos, verifiedThemesOf } from "@/lib/drive/references";
import { brandKnowledge } from "@/lib/services/pr-agency";
import { buildStudioInstruction, parseStudioRequest } from "@/lib/video/studio";
import { runUntilIdle, key } from "./helpers";

let brandId: string;
let sourceId: string;
const items: Record<string, string> = {};
const assets: Record<string, string> = {};

async function driveItem(name: string, path: string, mime: string, extra: { w?: number; h?: number } = {}) {
  const r = await q1<{ id: string }>(
    `INSERT INTO drive_items (brand_id, source_id, file_id, name, mime_type, path, depth, image_width, image_height, size_bytes, md5_checksum)
     VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,1000,$9) RETURNING id`,
    [brandId, sourceId, `f${Math.random().toString(36).slice(2, 14)}`, name, mime, `FriBee Master Archive/${path}`, extra.w ?? null, extra.h ?? null, "a".repeat(32)],
  );
  return r!.id;
}

async function verifiedPrint(name: string, theme: string, view: string, color: string) {
  const buf = await sharp({ create: { width: 1600, height: 2000, channels: 3, background: color } }).jpeg({ quality: 92 }).toBuffer();
  const { asset } = await uploadMedia(brandId, { buffer: buf, filename: name }, { kind: "photo", origin: "real_photo", vision: false });
  const itemId = await driveItem(name, `Collections/${theme}/${name}`, "image/jpeg", { w: 1600, h: 2000 });
  await q(
    `INSERT INTO drive_references (brand_id, item_id, theme, view, status, artwork_confirmed, media_asset_id, verified_by, verified_at)
     VALUES ($1,$2,$3,$4,'verified',true,$5,'user',now())`,
    [brandId, itemId, theme, view, asset.id],
  );
  return asset.id;
}

beforeAll(async () => {
  brandId = (await createBrand({ name: `FriBee KS ${Date.now()}`, content_language: "en" })).id;
  sourceId = (await q1<{ id: string }>(
    `INSERT INTO drive_sources (brand_id, status, folder_id, folder_name, last_success_at, full_scan_completed_at) VALUES ($1,'active','rootFolderKS0001','FriBee Master Archive', now(), now()) RETURNING id`,
    [brandId],
  ))!.id;
  items.story = await driveItem("Anime story", "Stories/Anime story", "application/vnd.google-apps.document");
  items.budget = await driveItem("Q3 budget.xlsx", "Finance/Q3 budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  items.contract = await driveItem("Supplier agreement.pdf", "Legal/Supplier agreement.pdf", "application/pdf");
  items.techpack = await driveItem("Tee tech pack.pdf", "Production/Tee tech pack.pdf", "application/pdf");
  items.sheet = await driveItem("numbers.xlsx", "Misc/numbers.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  items.lookbook = await driveItem("SS26 lookbook.pdf", "Lookbook/SS26 lookbook.pdf", "application/pdf");
  assets.animeFront = await verifiedPrint("anime-front.jpg", "anime", "front", "#f97316");
  assets.animeBack = await verifiedPrint("anime-back.jpg", "anime", "back", "#f97417");
  assets.musicFront = await verifiedPrint("music-front.jpg", "music", "front", "#ffffff");
});

describe("Marka bilgi sistemi — kaynaklı olgular", () => {
  it("dört koleksiyon sahip eylemiyle bir kez onaylanır; renkler ajan bağlamında", async () => {
    expect((await confirmFribeeCollections(brandId)).added).toBe(5);
    expect((await confirmFribeeCollections(brandId)).added).toBe(0);
    const k = await knowledgeForRole(brandId, "marketing");
    const byName = Object.fromEntries(k.collections.map((c) => [c.name, c]));
    expect(byName["Space Alien"].color).toBe("black");
    expect(byName["Music"].color).toBe("white");
    expect(byName["Anime"].color).toBe("orange");
    expect(byName["Save the Bee"].color).toBe("light blue");
    expect(byName["Anime"].verified_prints.map((p) => p.view).sort()).toEqual(["Arka", "Ön"]);
    expect(k.facts.find((f) => f.entity === "Mandala")?.value).toBe("Music");
  });

  it("kaynaksız onay, dosyasız çıkarım ve gizli bilgi reddedilir; inceleme → onay kanonik değeri değiştirir", async () => {
    await expect(addKnowledgeFact(brandId, { entityType: "product", entityName: "Anime Tee", attribute: "product_name", value: "Anime Tee", status: "confirmed", method: "manual" })).rejects.toThrow(/kaynak gerekli/);
    await expect(addKnowledgeFact(brandId, { entityType: "story", entityName: "Anime", attribute: "story", value: "x", status: "extracted", method: "document" })).rejects.toThrow(/arşiv dosyasına/);
    await expect(addKnowledgeFact(brandId, { entityType: "product", entityName: "X", attribute: "note", value: "api_key=sk-abcdefghijklmnopqrstuv", status: "suggested", method: "manual" })).rejects.toThrow(/gizli/);
    const story = await addKnowledgeFact(brandId, { entityType: "collection", entityKey: "collection_anime", entityName: "Anime", attribute: "story_document", value: "Anime story", status: "extracted", driveItemId: items.story, method: "document" });
    expect(story.source_note).toBe("Drive: FriBee Master Archive/Stories/Anime story");
    expect((await listKnowledgeFacts(brandId, { status: "pending" })).map((f) => f.id)).toContain(story.id);
    // İncelemedeki bilgi ajana gerçek olarak verilmez
    expect((await knowledgeForRole(brandId, "pr")).collections.find((c) => c.name === "Anime")!.facts).toEqual([]);
    await decideKnowledgeFact(brandId, story.id, "confirm");
    const pr = await knowledgeForRole(brandId, "pr");
    expect(pr.collections.find((c) => c.name === "Anime")!.facts).toEqual([{ attribute: "story_document", value: "Anime story", source: "Drive: Anime story" }]);
    // Yeni onaylı değer eskisinin yerini alır (tek kanonik doğru)
    const n = await addKnowledgeFact(brandId, { entityType: "product", entityName: "Anime Tee", attribute: "product_name", value: "Anime Tee", status: "confirmed", sourceNote: "Sahip", method: "manual" });
    await addKnowledgeFact(brandId, { entityType: "product", entityName: "Anime Tee", attribute: "product_name", value: "FriBee Anime Tee", status: "confirmed", sourceNote: "Sahip", method: "manual" });
    const rows = await q<{ id: string; status: string }>(`SELECT id, status FROM knowledge_facts WHERE brand_id = $1 AND entity_key = 'anime_tee' AND attribute = 'product_name'`, [brandId]);
    expect(rows.find((r) => r.id === n.id)!.status).toBe("rejected");
    expect(rows.filter((r) => r.status === "confirmed")).toHaveLength(1);
  });

  it("başka markanın dosyası kaynak olarak kullanılamaz", async () => {
    const other = (await createBrand({ name: `KS other ${Date.now()}` })).id;
    await expect(addKnowledgeFact(other, { entityType: "story", entityName: "x", attribute: "story", value: "x", status: "extracted", driveItemId: items.story, method: "document" })).rejects.toThrow(/arşivinde yok/);
    await expect(decideKnowledgeFact(other, (await listKnowledgeFacts(brandId))[0].id, "confirm")).rejects.toThrow(/bulunamadı/);
  });
});

describe("Rol bazlı erişim — gizli ticari ve finansal veriler", () => {
  it("finans kaydı yalnızca Finans'a; özel sözleşme hiçbir ajana; tedarikçi verisi yalnızca Yönetici ve Finans'a", async () => {
    await addKnowledgeFact(brandId, { entityType: "supplier", entityName: "Tee Factory", attribute: "unit_cost", value: "USD 7.10", status: "confirmed", sensitivity: "finance", driveItemId: items.budget, method: "manual" });
    await addKnowledgeFact(brandId, { entityType: "supplier", entityName: "Tee Factory", attribute: "contract_terms", value: "Exclusive 2 years", status: "confirmed", sensitivity: "private", driveItemId: items.contract, method: "manual" });
    const json = async (role: Parameters<typeof knowledgeForRole>[1]) => JSON.stringify(await knowledgeForRole(brandId, role));
    for (const role of ["marketing", "video_design", "pr", "manager"] as const) {
      const s = await json(role);
      expect(s, role).not.toContain("USD 7.10");
      expect(s, role).not.toContain("Q3 budget");
      expect(s, role).not.toContain("numbers.xlsx"); // sınıflandırılamayan tablo temkinli olarak finans
      expect(s, role).not.toContain("Exclusive 2 years");
    }
    const fin = await json("finance");
    expect(fin).toContain("USD 7.10");
    expect(fin).toContain("Q3 budget.xlsx");
    expect(fin).toContain("Tee tech pack.pdf");
    expect(fin).not.toContain("Exclusive 2 years");
    expect(fin).not.toContain("Supplier agreement");
    expect((await knowledgeForRole(brandId, "marketing")).withheld).toBeGreaterThanOrEqual(5);
    expect(await json("manager")).not.toContain("Tee tech pack"); // tedarikçi dosyası yöneticide sayılır ama ilgili dosya listesinde değil
  });

  it("ajan bağlamı rolü izler: yalnızca Finans finance.read taşır; diğer ajanların bağlamında finans verisi yok", async () => {
    expect(Object.values(AGENTS).filter((a) => a.tools.includes("finance.read" as never)).map((a) => a.id)).toEqual(["finance"]);
    for (const agent of ["manager", "marketing", "shopify", "design", "video", "social", "quality", "pr"] as const) {
      const ctx = await buildBrandContext(brandId, undefined, { agent });
      expect(ctx.knowledge, agent).not.toBeNull();
      expect(JSON.stringify(ctx), agent).not.toContain("USD 7.10");
      expect(JSON.stringify(ctx), agent).not.toContain("Q3 budget");
    }
    const fin = await buildBrandContext(brandId, undefined, { agent: "finance" });
    expect(fin.knowledge!.role).toBe("finance");
    expect(JSON.stringify(fin)).toContain("USD 7.10");
    expect((await buildBrandContext(brandId, undefined, { agent: "video" })).knowledge!.archive.relevant_files.map((f) => f.category)).not.toContain("financial_record");
  });

  it("kalıcı veriden arama: rol izni sonuçları kısıtlar ve gizlenen sayı raporlanır", async () => {
    const { graph, index } = await loadKnowledge(brandId);
    const m = searchKnowledge({ graph, index, brandId, role: "marketing", query: "tee factory" });
    expect(m.entities).toEqual([]);
    expect(m.withheld).toBeGreaterThan(0);
    const f = searchKnowledge({ graph, index, brandId, role: "finance", query: "tee factory" });
    expect(f.entities[0].facts.map((x) => x.value)).toEqual(["USD 7.10"]);
    const files = searchKnowledge({ graph, index, brandId, role: "video_design", query: "anime front" }).files;
    expect(files[0]).toMatchObject({ name: "anime-front.jpg", width: 1600 });
    expect(files[0].sourceUrl).toMatch(/^https:\/\/drive\.google\.com\/file\/d\//);
  });
});

describe("PR ve Finans departmanları (demo modeli, ücretsiz)", () => {
  it("PR planı onaylı koleksiyonlara dayanır; Finans değerlendirmesi tutar uydurmaz; ikisi de kalite kontrolünden geçer", async () => {
    const { project } = await submitInstruction({ brandId, instruction: "PR basın planı ve finans bütçe değerlendirmesi hazırla", idempotencyKey: key() });
    await runUntilIdle(new Engine("ks-worker"));
    const outs = await listOutputs(brandId, { projectId: project.id });
    const pr = outs.find((o) => o.kind === "pr_plan")!;
    const fin = outs.find((o) => o.kind === "finance_review")!;
    expect(pr.verdict).toBe("pass");
    expect(fin.verdict).toBe("pass");
    const prContent = (await getCurrentVersion(brandId, pr.id))!.content as any;
    expect(prContent.story_angles.map((a: any) => a.collection).sort()).toEqual(["Anime", "Music", "Save the Bee", "Space Alien"]);
    expect(JSON.stringify(prContent)).not.toContain("USD 7.10");
    const finContent = (await getCurrentVersion(brandId, fin.id))!.content as any;
    expect(finContent.spend.every((s: any) => s.amount_usd === null || s.source)).toBe(true);
  });

  it("PR ajansı koleksiyonları Bilgi Merkezi'nden kaynaklı alır", async () => {
    const k = await brandKnowledge(brandId);
    expect(k.collections.map((c) => c.name).sort()).toEqual(["Anime", "Music", "Save the Bee", "Space Alien"]);
    expect(k.collections.every((c) => c.sourceRef?.startsWith("knowledge_fact:"))).toBe(true);
    expect(k.collections.find((c) => c.name === "Save the Bee")!.keywords).toContain("bee");
  });

  it("PR kalite kuralları: uydurma iletişim bilgisi, erişim rakamı ve onaysız koleksiyon reddedilir", async () => {
    const ctx = await buildBrandContext(brandId, undefined, { agent: "pr" });
    const base = { summary: "s", story_angles: [{ id: "a", collection: "Anime", angle: "x", proof_points: [], sources: [] }], calendar_hooks: [], media_targets: [], pitch_drafts: [], risks: [], kpis: [], unknowns: [] };
    expect(runRuleChecks("pr", base, ctx, { isDemo: true }).checks.filter((c) => c.status === "fail")).toEqual([]);
    const bad = { ...base, pitch_drafts: [{ id: "p", audience: "press", subject: "Hi", body: "Write to jane@hype.example or DM @janedoe — 2M followers love it" }], story_angles: [{ ...base.story_angles[0], collection: "Neon Dragon" }] };
    const names = runRuleChecks("pr", bad, ctx, { isDemo: true }).checks.filter((c) => c.status === "fail").map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Uydurma iletişim bilgisi", "Uydurma erişim rakamı", "Koleksiyon eşleşmesi"]));
    const fin = runRuleChecks("finance", { summary: "s", spend: [{ item: "Ads", amount_usd: 1200, source: "" }], budget_recommendations: [], risks: [], sources: [], unknowns: [] }, ctx, { isDemo: true });
    expect(fin.checks.find((c) => c.name === "Kaynaksız tutar")?.status).toBe("fail");
  });
});

describe("Gemini Video Studio — doğrulanmış katalog fotoğrafları ve koleksiyon eşleşmesi", () => {
  it("koleksiyonun doğrulanmış katalog fotoğrafları otomatik bulunur (ön, arka); başka koleksiyon karışmaz", async () => {
    const anime = await verifiedCatalogPhotos(brandId, "anime");
    expect(anime.map((p) => p.media_asset_id)).toEqual([assets.animeFront, assets.animeBack]);
    expect(await verifiedCatalogPhotos(brandId, "save_the_bee")).toEqual([]);
    const themes = await verifiedThemesOf(brandId, [assets.animeFront, assets.musicFront]);
    expect(themes.get(assets.animeFront)).toBe("anime");
    expect(themes.get(assets.musicFront)).toBe("music");
    // Geri alınan referans artık otomatik seçilmez
    await q(`UPDATE drive_references SET status = 'uncertain', artwork_confirmed = false WHERE media_asset_id = $1`, [assets.animeBack]);
    expect((await verifiedCatalogPhotos(brandId, "anime")).map((p) => p.media_asset_id)).toEqual([assets.animeFront]);
    await q(`UPDATE drive_references SET status = 'verified', artwork_confirmed = true WHERE media_asset_id = $1`, [assets.animeBack]);
  });

  it("stüdyo talebi koleksiyonu taşır", () => {
    const text = buildStudioInstruction({ mode: "ai", videos: [], photos: [{ id: assets.animeFront, filename: "anime-front.jpg" }], minSeconds: 8, maxSeconds: 12, platform: "Reels", transition: "fade", aiScenes: 1, sceneSeconds: 8, goal: "", collection: "anime" });
    expect(parseStudioRequest(text)).toMatchObject({ mode: "ai", collection: "anime", photoIds: [assets.animeFront] });
    expect(themeMentioned("Anime collection launch")).toBe("anime");
    expect(themeMentioned("Anime and Music")).toBeNull();
  });

  it("yanlış koleksiyon, yanlış ürün rengi, karışık referans veya logo değişikliği kalite kontrolünden geçmez", async () => {
    const ctx: BrandContext = await buildBrandContext(brandId, undefined, { agent: "video", includeAssetIds: [assets.animeFront, assets.animeBack, assets.musicFront] });
    const studio = { mode: "ai" as const, aiScenes: 1, sceneSeconds: 8, photoIds: [assets.animeFront], collection: "anime" };
    const plan = (prompt: string, ids: string[]) => ({
      summary: "s", unknowns: [],
      videos: [
        { id: "scene-1", mode: "generate_new", format: "9:16", duration_s: 8, selected_asset_ids: ids, generation_prompt: prompt, script: [], subtitles: [], segments: [], parts: [], title: "t", music_note: "" },
        { id: "ad", mode: "compose", format: "9:16", duration_s: 12, selected_asset_ids: [], generation_prompt: "", script: [], subtitles: [], segments: [], title: "ad", music_note: "", transition: "fade", framing: "fill", outro_text: "FriBee",
          parts: [{ kind: "ai_scene", ref: "scene-1", duration_s: 8, on_screen_text: "" }, { kind: "product_photo", ref: ids[0], duration_s: 2.5, motion: "zoom_in", on_screen_text: "" }] },
      ],
    });
    const fails = (prompt: string, ids: string[]) => runRuleChecks("video", plan(prompt, ids), ctx, { isDemo: true, studio }).checks.filter((c) => c.name === "Koleksiyon ve baskı eşleşmesi" && c.status === "fail").map((c) => c.detail);
    expect(fails("A model walks through neon Tokyo at night wearing the orange tee, slow dolly in.", [assets.animeFront, assets.animeBack])).toEqual([]);
    expect(fails("Model wearing a black t-shirt in Tokyo.", [assets.animeFront]).join(" ")).toMatch(/yanlış renkte/);
    expect(fails("Space Alien UFO scene with the shirt.", [assets.animeFront]).join(" ")).toMatch(/başka koleksiyon/);
    expect(fails("City walk, add a new logo on the chest.", [assets.animeFront]).join(" ")).toMatch(/logo/);
    expect(fails("City walk at dusk.", [assets.animeFront, assets.musicFront]).join(" ")).toMatch(/farklı koleksiyon/);
    expect(fails("City walk at dusk.", [assets.musicFront]).join(" ")).toMatch(/seçilen koleksiyon anime/);
  });
});

describe("Drive dizini silinince bilgiler kaynağını kaybetmez", () => {
  it("yerel dizin silindiğinde olgular kalır, kaynak notu korunur; arşivden çıkarılmış ama dosyası olmayan bilgi grafiğe girmez", async () => {
    const pending = await addKnowledgeFact(brandId, { entityType: "story", entityName: "Music story", attribute: "story", value: "draft", status: "extracted", driveItemId: items.lookbook, method: "document" });
    await q(`DELETE FROM drive_sources WHERE brand_id = $1`, [brandId]);
    const rows = await q<{ id: string; drive_item_id: string | null; source_note: string; status: string }>(`SELECT id, drive_item_id, source_note, status FROM knowledge_facts WHERE brand_id = $1 AND attribute IN ('unit_cost','story')`, [brandId]);
    expect(rows.every((r) => r.drive_item_id === null && r.source_note.startsWith("Drive: "))).toBe(true);
    const { graph, index } = await loadKnowledge(brandId);
    expect(index).toBeNull();
    expect(graph.get(brandId, pending.entity_key)).toBeUndefined();
    expect((await knowledgeForRole(brandId, "marketing")).archive.connected).toBe(false);
  });
});
