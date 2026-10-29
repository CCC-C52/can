import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { reviewReference } from "@/lib/drive/references";
import { COLOUR_RULE_ACTOR, colourRuleSummary, decideByColour, garmentColourOf, runColourRuleOnce, setColourRule } from "@/lib/drive/colour-rule";

// Sahip renk kuralı (29 Ekim 2026): turuncu = Anime, beyaz = Music, siyah = Space Alien, bebe mavisi = Save the Bee.
// GERÇEK piksel ölçümü (sharp) ve gerçek veritabanı; Drive önizlemesi yerine aynı biçimde üretilmiş görseller verilir.

type RGB = { r: number; g: number; b: number };
const WHITE = { r: 250, g: 250, b: 250 }, GREY = { r: 128, g: 128, b: 128 };
const ORANGE = { r: 245, g: 130, b: 20 }, BLACK = { r: 18, g: 18, b: 18 }, TEE_WHITE = { r: 245, g: 245, b: 242 }, BABY_BLUE = { r: 170, g: 214, b: 232 };

/** Zemin üzerinde ortada tişört (gövde dikdörtgeni) ve küçük bir baskı. */
async function teePhoto(tee: RGB, background: RGB, print: RGB = { r: 40, g: 90, b: 160 }) {
  const W = 800, H = 1000;
  const body = await sharp({ create: { width: 440, height: 640, channels: 3, background: tee } }).png().toBuffer();
  const art = await sharp({ create: { width: 120, height: 120, channels: 3, background: print } }).png().toBuffer();
  return sharp({ create: { width: W, height: H, channels: 3, background } })
    .composite([{ input: body, left: 180, top: 200 }, { input: art, left: 340, top: 360 }])
    .jpeg({ quality: 90 }).toBuffer();
}

let brandId: string;
let sourceId: string;
const images = new Map<string, Buffer>();
let n = 0;

async function addPhoto(name: string, img: Buffer | null, opts: { path?: string; width?: number; height?: number; mime?: string } = {}) {
  const fileId = `file${String(++n).padStart(6, "0")}abc`;
  if (img) images.set(fileId, img);
  await q(
    `INSERT INTO drive_items (brand_id, source_id, file_id, name, mime_type, path, has_thumbnail, image_width, image_height, state)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,'indexed')`,
    [brandId, sourceId, fileId, name, opts.mime ?? "image/jpeg", opts.path ?? `FriBee Master Archive/Shoot/${name}`, opts.width ?? 1600, opts.height ?? 2000],
  );
}
const refOf = (name: string) => q1<{ id: string; status: string; theme: string | null; view: string; verified_by: string | null; artwork_confirmed: boolean; detail: any }>(
  `SELECT r.id, r.status, r.theme, r.view, r.verified_by, r.artwork_confirmed, r.suggestion_detail AS detail FROM drive_references r JOIN drive_items i ON i.id = r.item_id WHERE i.brand_id = $1 AND i.name = $2`, [brandId, name]);
const colourOf = async (c: { file_id: string }) => images.get(c.file_id)!;

beforeAll(async () => {
  brandId = (await createBrand({ name: "FriBee Renk Kuralı" })).id;
  sourceId = (await q1<{ id: string }>(`INSERT INTO drive_sources (brand_id, status, folder_id) VALUES ($1,'active','folderABCDEFGH12') RETURNING id`, [brandId]))!.id;
});

describe("Sahip renk kuralı", () => {
  it("giysi rengi görselin ortasından ölçülür (zemin rengi karışmaz); tek renk görsel belirsiz sayılır", async () => {
    expect((await garmentColourOf(await teePhoto(ORANGE, WHITE))).colour).toBe("orange");
    expect((await garmentColourOf(await teePhoto(BLACK, WHITE))).colour).toBe("black"); // beyaz zemin: Music sanılmaz
    expect((await garmentColourOf(await teePhoto(TEE_WHITE, GREY))).colour).toBe("white");
    expect((await garmentColourOf(await teePhoto(BABY_BLUE, WHITE))).colour).toBe("light_blue");
    expect((await garmentColourOf(await teePhoto({ r: 40, g: 150, b: 60 }, WHITE))).colour).toBeNull(); // yeşil: kural rengi değil
    const blank = await sharp({ create: { width: 800, height: 1000, channels: 3, background: WHITE } }).jpeg().toBuffer();
    expect(await garmentColourOf(blank)).toMatchObject({ colour: null, note: expect.stringMatching(/tek renk/) });
  });

  it("renk koleksiyonu belirler; dosya adı başka koleksiyon diyorsa çelişki", () => {
    expect(decideByColour("IMG_2041.jpg", null, "orange")).toMatchObject({ theme: "anime", view: "other" });
    expect(decideByColour("tee-back.jpg", "Archive/Drop 3/tee-back.jpg", "light_blue")).toMatchObject({ theme: "save_the_bee", view: "back" });
    expect(decideByColour("anime-front.jpg", null, "black")).toMatchObject({ theme: null, reason: expect.stringMatching(/çelişki/) });
    expect(decideByColour("x.jpg", null, null).theme).toBeNull();
  });

  it("işleyici: kuyruktaki ürün fotoğrafları sahibin onayı beklenmeden rengine göre doğrulanır; logo, düşük çözünürlük ve belirsizler kalır", async () => {
    await addPhoto("IMG_0001.jpg", await teePhoto(ORANGE, WHITE));
    await addPhoto("IMG_0002.jpg", await teePhoto(TEE_WHITE, GREY));
    await addPhoto("IMG_0003-front.jpg", await teePhoto(BLACK, WHITE));
    await addPhoto("IMG_0004-back.jpg", await teePhoto(BABY_BLUE, WHITE, { r: 240, g: 190, b: 30 }));
    await addPhoto("anime-front.jpg", await teePhoto(BLACK, WHITE)); // ad Anime, renk siyah: çelişki
    await addPhoto("IMG_0006.jpg", await teePhoto({ r: 40, g: 150, b: 60 }, WHITE)); // kural rengi değil
    await addPhoto("fribee-logo.png", await teePhoto(ORANGE, WHITE), { mime: "image/png" });
    await addPhoto("IMG_0008.jpg", await teePhoto(ORANGE, WHITE), { width: 300, height: 300 });

    const r = await runColourRuleOnce(50, { colourOf });
    expect(r).toHaveLength(6); // logo ve düşük çözünürlüklü kuyruğa hiç girmez

    expect(await refOf("IMG_0001.jpg")).toMatchObject({ status: "verified", theme: "anime", view: "other", verified_by: COLOUR_RULE_ACTOR, artwork_confirmed: true });
    expect(await refOf("IMG_0002.jpg")).toMatchObject({ status: "verified", theme: "music" });
    expect(await refOf("IMG_0003-front.jpg")).toMatchObject({ status: "verified", theme: "space_alien", view: "front" });
    expect(await refOf("IMG_0004-back.jpg")).toMatchObject({ status: "verified", theme: "save_the_bee", view: "back" });
    const conflict = (await refOf("anime-front.jpg"))!;
    expect(conflict).toMatchObject({ status: "uncertain" });
    expect(conflict.detail.colour_rule.reason).toMatch(/çelişki/);
    expect((await refOf("IMG_0006.jpg"))!.status).toBe("uncertain");
    expect(await refOf("fribee-logo.png")).toBeNull();
    expect(await refOf("IMG_0008.jpg")).toBeNull();

    // Koleksiyon renkleri tüm sistemin bilgisine onaylı olgu olarak girer
    const facts = await q<{ entity_name: string; value: string }>(
      `SELECT entity_name, value FROM knowledge_facts WHERE brand_id = $1 AND attribute = 'theme_color' AND status = 'confirmed' ORDER BY entity_name`, [brandId]);
    expect(facts.map((f) => `${f.entity_name}=${f.value}`)).toEqual(["Anime=orange", "Music=white", "Save the Bee=light blue", "Space Alien=black"]);
    expect(await colourRuleSummary(brandId)).toMatchObject({ enabled: true, verified: 4, kept: 2, waiting: 0 });

    // Her fotoğraf bir kez değerlendirilir
    expect(await runColourRuleOnce(50, { colourOf })).toEqual([]);
  });

  it("sahibin geri aldığı fotoğrafa kural bir daha dokunmaz; kural kapatılınca yeni fotoğraflar sahibe kalır", async () => {
    const orange = (await refOf("IMG_0001.jpg"))!;
    await reviewReference(brandId, orange.id, { action: "reset" });
    await runColourRuleOnce(50, { colourOf });
    expect((await refOf("IMG_0001.jpg"))!.status).toBe("uncertain");

    await setColourRule(brandId, false, "user");
    await addPhoto("IMG_0009.jpg", await teePhoto(ORANGE, WHITE));
    expect(await runColourRuleOnce(50, { colourOf })).toEqual([]);
    expect(await refOf("IMG_0009.jpg")).toBeNull();
    await setColourRule(brandId, true, "user");
    await runColourRuleOnce(50, { colourOf });
    expect(await refOf("IMG_0009.jpg")).toMatchObject({ status: "verified", theme: "anime" });
  });
});
