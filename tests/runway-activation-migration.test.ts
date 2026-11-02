import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { getPool, q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { getLimits, getSetting, setSetting } from "@/lib/settings";
import { RunwayVideoGenerator } from "@/lib/adapters/runway-video";
import { classifySql } from "@/lib/db/migration-safety";

// 008: sahibin Runway aktivasyon ayarları. Yalnızca belirtilen anahtarlar birleştirilir; ücretli üretim izni ve diğer
// ayarlar korunur; kayıtlı günlük bütçe korunur; önceki/yeni değerler denetim kaydına yazılır.

let sql: string;
const run = () => getPool().query(sql);
const audits = () => q<{ message: string; data: any }>(`SELECT message, data FROM audit_log WHERE action = 'settings.video_activation' ORDER BY id`);

beforeAll(async () => {
  sql = await fs.readFile(path.resolve("migrations/008_runway_activation_settings.sql"), "utf8");
});

describe("008 Runway aktivasyon ayarları", () => {
  it("gerçek marka yokken (yeni/boş veritabanı) hiçbir şey yapmaz", async () => {
    await q(`DELETE FROM settings WHERE key = 'limits'`);
    await run();
    expect(await q1(`SELECT 1 FROM settings WHERE key = 'limits'`)).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it("mevcut ayarlar korunur, yalnızca Runway fiyatı/sağlayıcı/60 sn uygulanır; kayıtlı 20 $ bütçe ve kapalı ücretli üretim izni değişmez", async () => {
    await createBrand({ name: "FriBee Aktivasyon" });
    await setSetting("limits", { paidMediaGeneration: false, dailyBudgetUsd: 20, perTaskBudgetUsd: 1, maxVideoGenSeconds: 16, renderTimeoutMs: 3_600_000, providerMonthlyUsd: { anthropic: 50 } });
    await run();
    const v = await getSetting<any>("limits", null);
    expect(v).toEqual({
      paidMediaGeneration: false, dailyBudgetUsd: 20, perTaskBudgetUsd: 1, renderTimeoutMs: 3_600_000, providerMonthlyUsd: { anthropic: 50 },
      maxVideoGenSeconds: 60, videoPrimaryProvider: "runway", runwayModel: "gen4.5", runwayCreditsPerSecond: 12, runwayUsdPerCredit: 0.01,
    });
    const lim = await getLimits();
    expect(new RunwayVideoGenerator("k", lim.runwayModel, { creditsPerSecond: lim.runwayCreditsPerSecond, usdPerCredit: lim.runwayUsdPerCredit }).estimateCostUsd(5)).toBe(0.6);
    const [a] = await audits();
    expect(a.message).toMatch(/günlük bütçe 20 \$ \(kayıtlı değer korundu\).*ücretli medya üretimi izni değiştirilmedi \(false\)/);
    expect(a.data).toMatchObject({ before: { maxVideoGenSeconds: 16, runwayCreditsPerSecond: null, dailyBudgetUsd: 20, paidMediaGeneration: false }, after: { maxVideoGenSeconds: 60, runwayCreditsPerSecond: 12, runwayUsdPerCredit: 0.01, dailyBudgetUsd: 20, paidMediaGeneration: false } });
  });

  it("kayıtta farklı bir günlük bütçe varsa değiştirilmez; kayıt hiç yoksa 20 $ yazılır", async () => {
    await setSetting("limits", { dailyBudgetUsd: 15 });
    await run();
    expect((await getSetting<any>("limits", null)).dailyBudgetUsd).toBe(15);
    await q(`DELETE FROM settings WHERE key = 'limits'`);
    await run();
    const v = await getSetting<any>("limits", null);
    expect(v).toEqual({ dailyBudgetUsd: 20, maxVideoGenSeconds: 60, videoPrimaryProvider: "runway", runwayModel: "gen4.5", runwayCreditsPerSecond: 12, runwayUsdPerCredit: 0.01 });
    expect((await getLimits()).paidMediaGeneration).toBe(false); // varsayılan kapalı; geçiş açmaz
    expect((await audits()).at(-1)!.message).toMatch(/kayıt yoktu, 20 yazıldı/);
  });

  it("geçiş 'review' sınıfında (veri günceller): politika kaydı ve sahip onayıyla dağıtılır", () => {
    expect(classifySql(sql).class).toBe("review");
  });
});
