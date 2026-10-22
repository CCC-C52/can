import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { q } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { assertBudget, BudgetExceededError, monthlyServiceSpend, recordCost } from "@/lib/services/costs";
import { getLimits, setSetting } from "@/lib/settings";
import { compactAnalysis, type MediaAnalysis } from "@/lib/media-analysis";

let brandId: string;
let saved: unknown;

beforeAll(async () => {
  brandId = (await createBrand({ name: `Cost ${Date.now()}` })).id;
  saved = (await q<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'limits'`))[0]?.value ?? null;
});
afterAll(async () => {
  if (saved === null) await q(`DELETE FROM settings WHERE key = 'limits'`);
  else await setSetting("limits", saved);
});

describe("Sağlayıcı başına aylık sınır", () => {
  it("bu ayki harcama + tahmin sınırı aşarsa çağrıdan önce engeller; diğer sağlayıcıları etkilemez", async () => {
    const svc = `test_provider_${Date.now()}`;
    const cur = await getLimits();
    await setSetting("limits", { ...cur, perTaskBudgetUsd: null, dailyBudgetUsd: null, providerMonthlyUsd: { [svc]: 1 } });
    await recordCost({ brandId, service: svc, kind: "actual", amountUsd: 0.9 });
    expect(await monthlyServiceSpend(svc)).toBeCloseTo(0.9, 6);
    await expect(assertBudget({ taskId: null, estimateUsd: 0.05, service: svc })).resolves.toBeUndefined();
    await expect(assertBudget({ taskId: null, estimateUsd: 0.2, service: svc })).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(assertBudget({ taskId: null, estimateUsd: 0.2, service: "other_service" })).resolves.toBeUndefined();
  });

  it("sağlayıcı sınırı varken maliyeti bilinmeyen çağrı engellenir (bilinmeyen ≠ 0)", async () => {
    const cur = await getLimits();
    await setSetting("limits", { ...cur, perTaskBudgetUsd: null, dailyBudgetUsd: null, blockUnknownCost: true, providerMonthlyUsd: { svc_unknown: 5 } });
    await expect(assertBudget({ taskId: null, estimateUsd: null, service: "svc_unknown" })).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe("Görsel anlama durumu", () => {
  const base = { id: "a", brand_id: "b", asset_id: "x", status: "completed", level: "local" } as unknown as MediaAnalysis;
  it("yalnızca yerel ölçüm varsa 'blocked_no_vision_model' işaretlenir", () => {
    const img = compactAnalysis({ ...base, kind: "image", result: { local: { orientation: "portrait" } } } as MediaAnalysis);
    const vid = compactAnalysis({ ...base, kind: "video", result: { local: { probe: { duration: 3 } } } } as MediaAnalysis);
    expect(img?.visual_understanding).toBe("blocked_no_vision_model");
    expect(vid?.visual_understanding).toBe("blocked_no_vision_model");
  });
  it("görsel model özeti varsa 'vision_model'", () => {
    const img = compactAnalysis({ ...base, level: "vision", kind: "image", result: { local: {}, vision: { summary: "s" } } } as MediaAnalysis);
    expect(img?.visual_understanding).toBe("vision_model");
  });
});
