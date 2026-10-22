/**
 * Uçtan uca tarayıcı akışı (Playwright) — çalışan panele ve YEREL veritabanına karşı.
 *   npm run build && npx next start -p 3000      (ayrı terminal)
 *   E2E_BASE=http://127.0.0.1:3000 npm run test:e2e
 * İşleyiciyi bu betik başlatır (npm run worker) ve sonunda kapatır. Ücretli çağrı yapmaz: model anahtarı yoksa
 * DEMO üretici, video için yerel ffmpeg kullanılır. Giriş zorunluysa E2E_PASSWORD verilir (değer yazdırılmaz).
 *
 * Akış: Video Stüdyosu'nda gerçek arşiv videosu seç → Ana Yönetici'ye gönder → işleyici planlar, analiz eder,
 * kurgu planı üretir, QA'dan geçirir, MP4 render eder → çıktı sayfasında MP4'ü tarayıcıda oynat/çöz →
 * indirilen dosyayı ffprobe ile doğrula → onayla. Ayrıca Marka Hafızası ve Araştırma Merkezi durumları.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3000";
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 15 * 60_000);

type Result = { name: string; ok: boolean; skipped?: boolean; detail?: string };
class Skip extends Error {}
const results: Result[] = [];
async function step(name: string, fn: () => Promise<void | string>) {
  try {
    const d = await fn();
    results.push({ name, ok: true, detail: d || undefined });
    return true;
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ name, ok: true, skipped: true, detail: err.message });
      return true;
    }
    results.push({ name, ok: false, detail: (err as Error).message.slice(0, 600) });
    return false;
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function startWorker(): ChildProcess {
  const w = spawn("npm", ["run", "worker"], { env: { ...process.env, LOG_LEVEL: "info" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  w.stdout!.on("data", () => {});
  w.stderr!.on("data", () => {});
  return w;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, label: string): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Zaman aşımı: ${label}`);
}

async function main() {
  expect(await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false), `${BASE} çalışmıyor`);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page: Page = await ctx.newPage();
  const worker = startWorker();
  let projectUrl = "";
  let outputUrl = "";
  try {
    if (process.env.E2E_PASSWORD) {
      await page.goto(`${BASE}/login`);
      await page.fill("input[name=password]", process.env.E2E_PASSWORD);
      await page.click("form button");
      await page.waitForLoadState("networkidle");
    }

    await step("Gezinme: tüm bölümler menüde ve açılıyor", async () => {
      await page.goto(`${BASE}/`);
      const labels = ["AI Yönetici", "AI Ekibi", "Marka Yönetimi", "Araştırma Merkezi", "Görsel Stüdyosu", "Video Stüdyosu", "Kampanya Yönetimi", "Sosyal Medya", "Analitik", "Entegrasyonlar", "Marka Hafızası", "Onay Merkezi", "Sistem Durumu", "Maliyet Yönetimi"];
      const nav = page.getByRole("navigation", { name: "Ana menü" });
      for (const l of labels) {
        const link = nav.getByRole("link", { name: l, exact: true });
        expect(await link.count(), `menüde yok: ${l}`);
        const href = await link.first().getAttribute("href");
        const r = await page.request.get(BASE + href!);
        expect(r.status() === 200, `${l} (${href}) durum ${r.status()}`);
      }
      return `${labels.length} bölüm`;
    });

    await step("Araştırma Merkezi: anahtar yokken dürüst 'kullanılamıyor' durumu", async () => {
      await page.goto(`${BASE}/arastirma`);
      const html = await page.content();
      if (html.includes("Kullanılamıyor")) {
        expect(await page.locator('form:has(textarea[name="query"]) button[type=submit]').isDisabled(), "düğme aktif");
        return "Firecrawl yapılandırılmamış → engelli";
      }
      return "Firecrawl yapılandırılmış (bu ortamda beklenmiyordu)";
    });

    await step("Marka Hafızası: kayıt ekle → etkin listede görünür", async () => {
      await page.goto(`${BASE}/hafiza`);
      const title = `E2E yönergesi ${Date.now()}`;
      await page.fill("#mem-title", title);
      await page.fill("#mem-body", "Ürün renklerini değiştirme; ekran yazıları kısa olsun.");
      await page.locator('form:has(#mem-title) button[type=submit]').click();
      await page.waitForURL(/ok=/);
      expect((await page.content()).includes(title), "kayıt listede yok");
    });

    const submitted = await step("Video Stüdyosu: gerçek arşiv videosu seç ve gönder", async () => {
      await page.goto(`${BASE}/studyo/video`);
      const boxes = page.locator('input[name="assetIds"]');
      expect(await boxes.count(), "arşivde gerçek video yok");
      await boxes.first().check();
      await page.fill('input[name="minSeconds"]', "6");
      await page.fill('input[name="maxSeconds"]', "9");
      await page.selectOption('select[name="transition"]', "cut");
      await page.fill('textarea[name="goal"]', "E2E testi: kısa ürün tanıtımı.");
      await page.locator('form:has(input[name="assetIds"]) button[type=submit]').click();
      await page.waitForURL(/\/projeler\/[0-9a-f-]{36}/, { timeout: 30_000 });
      projectUrl = page.url();
      return new URL(projectUrl).pathname;
    });

    const planned = submitted && (await step("İşleyici: video planı çıktısı oluştu", async () => {
      outputUrl = await waitFor(async () => {
        await page.goto(projectUrl);
        const hrefs = await page.locator('a[href^="/taslaklar/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
        for (const h of hrefs) {
          const r = await page.request.get(BASE + h!);
          const html = await r.text();
          if (html.includes("Üretilen MP4") || html.includes("doğrulanmış MP4 henüz yok")) return BASE + h;
        }
        return null;
      }, TIMEOUT_MS, "video planı");
      return new URL(outputUrl).pathname;
    }));

    const rendered = planned && (await step("Render: MP4 üretildi ve doğrulandı (çıktı sayfasında)", async () => {
      await waitFor(async () => {
        await page.goto(outputUrl);
        const html = await page.content();
        if (/render: Başarısız|render: Hata/.test(html)) throw new Error("render başarısız");
        return html.includes("Üretilen MP4") && (await page.locator("video").count()) > 0;
      }, TIMEOUT_MS, "MP4 render");
    }));

    let mp4Url = "";
    if (rendered) {
      await step("Tarayıcıda oynatma: <video> meta verisi yüklenir ve kare çözülür", async () => {
        await page.goto(outputUrl);
        const v = page.locator("video").first();
        mp4Url = new URL((await v.getAttribute("src"))!, BASE).toString();
        const info = await v.evaluate(async (el: HTMLVideoElement) => {
          const can = el.canPlayType('video/mp4; codecs="avc1.640028"');
          el.muted = true;
          el.preload = "auto";
          el.load();
          const ready = await new Promise<string>((res) => {
            const t = setTimeout(() => res("timeout"), 20_000);
            el.addEventListener("loadeddata", () => { clearTimeout(t); res("loadeddata"); }, { once: true });
            el.addEventListener("error", () => { clearTimeout(t); res(`error:${el.error?.code}`); }, { once: true });
          });
          return { can, ready, w: el.videoWidth, h: el.videoHeight, d: el.duration };
        });
        if (info.can === "" || info.ready.startsWith("error")) {
          // Playwright'ın açık kaynak Chromium'u H.264 çözücüsü içermeyebilir; bu tarayıcı kısıtıdır, dosya hatası değildir.
          throw new Skip(`TEST EDİLMEDİ: bu Chromium derlemesi H.264 çözücüsü içermiyor (canPlayType="${info.can}", ${info.ready}). Dosyanın çözülebilirliği bir sonraki adımda ffprobe/ffmpeg ile doğrulanır; gerçek tarayıcıda (Chrome/Safari) elle kontrol edilmeli.`);
        }
        expect(info.ready === "loadeddata" && info.w > 0 && info.h > 0, JSON.stringify(info));
        return `${info.w}x${info.h}, ${info.d.toFixed(2)} sn, ${info.ready}`;
      });

      await step("İndirme: MP4 baytları ffprobe ile h264 ve hatasız çözülür", async () => {
        const r = await page.request.get(`${mp4Url}${mp4Url.includes("?") ? "&" : "?"}download=1`);
        expect(r.status() === 200, `durum ${r.status()}`);
        expect((r.headers()["content-disposition"] ?? "").startsWith("attachment"), "attachment değil");
        const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "e2e-")), "out.mp4");
        await fs.writeFile(file, await r.body());
        const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", file]).toString());
        const s = probe.streams[0];
        expect(s.codec_name === "h264", `codec ${s.codec_name}`);
        const errs = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
        expect(!errs.trim(), errs.slice(0, 200));
        const dur = Number(probe.format.duration);
        return `${s.codec_name} ${s.width}x${s.height}, ${dur.toFixed(2)} sn`;
      });

      await step("Onay: MP4 doğrulandıktan sonra sürüm onaylanır", async () => {
        await page.goto(outputUrl);
        const approve = page.getByRole("button", { name: "Bu sürümü onayla" });
        expect(await approve.count(), "onay düğmesi yok (zaten onaylı olabilir)");
        await approve.click();
        await page.waitForURL(/ok=|err=/);
        const u = decodeURIComponent(page.url());
        expect(u.includes("ok="), u);
        await page.goto(outputUrl);
        expect((await page.content()).includes("Onaylandı"), "onay görünmüyor");
      });
    }
  } finally {
    await browser.close();
    try { process.kill(-worker.pid!, "SIGTERM"); } catch { worker.kill("SIGTERM"); }
  }
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  for (const r of results) console.log(`${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length} geçti, ${skipped.length} test edilemedi, ${failed.length} başarısız`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
