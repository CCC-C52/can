/**
 * Erişilebilirlik taraması (axe-core, WCAG 2.1 A/AA kuralları) — çalışan panele karşı.
 *   npm run dev   (veya next start)   ve   A11Y_BASE=http://127.0.0.1:3000 npm run test:a11y
 * Giriş zorunluysa A11Y_PASSWORD ortam değişkeni verilir (değer yazdırılmaz).
 * Masaüstü ve telefon genişliğinde tarar; ihlalleri kural/sayfa bazında listeler.
 */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const BASE = process.env.A11Y_BASE ?? "http://127.0.0.1:3000";
const PAGES = ["/", "/sohbet", "/gorevler", "/taslaklar", "/onizlemeler", "/onaylar", "/takvim", "/markalar", "/urunler", "/medya", "/entegrasyonlar", "/raporlar", "/ajanlar", "/tanilama", "/ayarlar", "/login", "/projeler", "/studyo/video", "/studyo/gorsel", "/hafiza", "/arastirma", "/maliyet"];
const require = createRequire(import.meta.url);

async function main() {
  const axe = await fs.readFile(require.resolve("axe-core/axe.min.js"), "utf8");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (process.env.A11Y_PASSWORD) {
    await page.goto(`${BASE}/login`);
    await page.fill("input[name=password]", process.env.A11Y_PASSWORD);
    await page.click("form button");
    await page.waitForLoadState("networkidle");
  }
  // Ayrıntı sayfaları: listelerin ilk bağlantıları
  const extra: string[] = [];
  for (const [list, prefix] of [["/taslaklar", "/taslaklar/"], ["/medya", "/medya/"], ["/gorevler", "/gorevler/"], ["/projeler", "/projeler/"]] as const) {
    await page.goto(BASE + list);
    const href = await page.locator(`a[href^="${prefix}"]`).first().getAttribute("href").catch(() => null);
    if (href) extra.push(href);
  }
  let total = 0;
  for (const viewport of [{ width: 1360, height: 900, name: "masaüstü" }, { width: 390, height: 844, name: "telefon" }]) {
    await page.setViewportSize(viewport);
    for (const p of [...PAGES, ...extra]) {
      await page.goto(BASE + p, { waitUntil: "networkidle" });
      await page.addScriptTag({ content: axe });
      const res = await page.evaluate(async () => {
        // @ts-expect-error axe sayfaya eklendi
        const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
        return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(" ") }));
      });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (res.length || overflow) {
        console.log(`\n[${viewport.name}] ${p}`);
        for (const v of res) console.log(`  ${v.impact} ${v.id} ×${v.nodes} — ${v.help} (${v.sample})`);
        if (overflow) console.log("  yatay taşma (sayfa ekran genişliğinden geniş)");
      }
      total += res.length + (overflow ? 1 : 0);
    }
  }
  await browser.close();
  console.log(`\nToplam sorun türü: ${total}`);
  process.exit(total ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
