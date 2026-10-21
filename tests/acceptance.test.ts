import { describe, it, expect, beforeAll } from "vitest";
import { createBrand, createProduct, addProductFact } from "@/lib/services/brands";
import { uploadMedia } from "@/lib/services/media";
import { runAcceptance, type StepResult } from "../scripts/acceptance/workflow";
import { productPhoto, colorScenesVideo } from "./fixtures";

// FriBee kabul iş akışı (24 adım) — YALITILMIŞ FİKSTÜR markası üzerinde. Gerçek FriBee verisi kullanılmaz ve uydurulmaz;
// marka adı bunun bir test fikstürü olduğunu açıkça belirtir. Aynı adımlar yetkili bir kopya veritabanında
// `npm run acceptance -- --brand <slug>` ile gerçek marka verisine karşı çalıştırılabilir.

let brandId: string;
let otherId: string;
beforeAll(async () => {
  const b = await createBrand({ name: "Kabul Fikstürü (FriBee iş akışı, sentetik test markası)", content_language: "en" });
  brandId = b.id;
  const p = await createProduct(brandId, { title: "Fixture Oversized Hoodie", price: "79", currency: "EUR", status: "active" });
  await addProductFact(brandId, p.id, { attribute: "Fabric", value: "100% cotton fleece" });
  await addProductFact(brandId, p.id, { attribute: "Fit", value: "Oversized" });
  await uploadMedia(brandId, { buffer: await productPhoto("#111827", { bg: "#e5e7eb" }), filename: "hoodie-front.jpg" }, { productId: p.id, origin: "real_photo", rightsStatus: "owned" });
  await uploadMedia(brandId, { buffer: await colorScenesVideo([{ color: "0x1f2937", seconds: 2 }, { color: "0xd1d5db", seconds: 3 }], { audio: true }), filename: "hoodie-lookbook.mp4" }, { productId: p.id, origin: "real_video", rightsStatus: "owned" });
  otherId = (await createBrand({ name: "Kabul Fikstürü — ikinci marka", content_language: "en" })).id;
  await uploadMedia(otherId, { buffer: await productPhoto("#16a34a"), filename: "other.jpg" });
});

describe("FriBee kabul iş akışı (yalıtılmış fikstür)", () => {
  it("24 adımın tamamı gerçek dosyalarla geçer", async () => {
    const results: StepResult[] = await runAcceptance({ brandId, otherBrandId: otherId, workerId: "acceptance-test" });
    const failed = results.filter((r) => r.status !== "PASS");
    if (failed.length) console.error(failed);
    expect(results).toHaveLength(24);
    expect(failed).toEqual([]);
  }, 180_000);
});
