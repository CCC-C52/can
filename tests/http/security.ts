/**
 * HTTP düzeyi güvenlik testleri — gerçek üretim derlemesine (next start, APP_MODE=production) karşı çalışır.
 *
 *   npm run build && TEST_S3_ENDPOINT=http://127.0.0.1:5055 npm run test:http
 *
 * Gereken: yerel PostgreSQL (aiops kullanıcısı veritabanı oluşturabilmeli), S3 uyumlu test sunucusu (ör. moto), Chromium (Playwright).
 * Ayrı bir veritabanı (aiops_httptest) ve kova (aiops-httptest) kullanır; her çalıştırmada SIFIRLANIR. Üretim verisine dokunmaz.
 * Gizli değerler süreç içinde rastgele üretilir ve hiçbir yere yazılmaz.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const PORT = Number(process.env.HTTP_TEST_PORT ?? 3300);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "postgres://aiops:aiops@127.0.0.1:5432/aiops";
const DB = "postgres://aiops:aiops@127.0.0.1:5432/aiops_httptest";
const S3 = process.env.TEST_S3_ENDPOINT;
if (!S3) {
  console.error("TEST_S3_ENDPOINT gerekli (ör. http://127.0.0.1:5055)");
  process.exit(2);
}
const secrets = {
  ADMIN_PASSWORD: crypto.randomBytes(18).toString("base64url"),
  SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
  S3_SECRET_ACCESS_KEY: crypto.randomBytes(20).toString("hex"),
  RELEASE_STATUS_TOKEN: crypto.randomBytes(32).toString("base64url"),
};
const env: Record<string, string> = {
  APP_MODE: "production",
  // Boş test veritabanı: sahip onayı gerektiren geçiş bu yalıtılmış ortam için onaylı (canlıda Render ortam değişkeni)
  AIOPS_AUTHORIZED_MIGRATIONS: "003_brand_memory_research.sql",
  DATABASE_URL: DB,
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "aiops-httptest",
  S3_REGION: "us-east-1",
  S3_ENDPOINT: S3,
  S3_ACCESS_KEY_ID: "test",
  S3_FORCE_PATH_STYLE: "true",
  PORT: String(PORT),
  AIOPS_RELEASE_COMMIT: "c0ffee0000000000000000000000000000000001",
  LOG_SILENT: "1",
  ...secrets,
};

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];
async function check(name: string, fn: () => Promise<void | string>) {
  try {
    const d = await fn();
    results.push({ name, ok: true, detail: d || undefined });
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message });
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function resetDb() {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'aiops_httptest'`);
  await c.query(`DROP DATABASE IF EXISTS aiops_httptest`);
  await c.query(`CREATE DATABASE aiops_httptest`);
  await c.end();
}

async function seed() {
  Object.assign(process.env, env, { LOG_SILENT: "1" });
  const { S3Client, CreateBucketCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: "us-east-1", endpoint: S3, forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: secrets.S3_SECRET_ACCESS_KEY } });
  await s3.send(new CreateBucketCommand({ Bucket: "aiops-httptest" })).catch(() => {});
  const { runMigrations } = await import("@/lib/db/migrate");
  await runMigrations();
  const { createBrand } = await import("@/lib/services/brands");
  const { uploadMedia } = await import("@/lib/services/media");
  const { createOutput, addVersion } = await import("@/lib/services/outputs");
  const { submitInstruction } = await import("@/lib/orchestrator/projects");
  const { initUpload } = await import("@/lib/uploads");
  const { q1 } = await import("@/lib/db/pool");
  const sharp = (await import("sharp")).default;
  const img = (c: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: c } }).png().toBuffer();

  const A = await createBrand({ name: "HTTP Brand A", content_language: "en" });
  const B = await createBrand({ name: "HTTP Brand B", content_language: "en" });
  const mediaA = (await uploadMedia(A.id, { buffer: await img("#ff0000"), filename: "a.png" })).asset;
  const mediaB = (await uploadMedia(B.id, { buffer: await img("#0000ff"), filename: "b.png" })).asset;
  const { project: projectB } = await submitInstruction({ brandId: B.id, instruction: "B projesi", idempotencyKey: crypto.randomUUID() });
  const taskB = (await q1<{ id: string }>(`SELECT id FROM tasks WHERE project_id = $1 LIMIT 1`, [projectB.id]))!;
  const outB = await createOutput({ brandId: B.id, projectId: projectB.id, taskId: taskB.id, agent: "marketing", kind: "strategy", title: "B çıktısı" });
  await addVersion({ brandId: B.id, outputId: outB.id, content: { summary: "B gizli strateji" }, createdBy: "user", generator: "user", isDemo: false });
  const outA = await createOutput({ brandId: A.id, projectId: null, taskId: null, agent: "marketing", kind: "strategy", title: "A çıktısı" });
  await addVersion({ brandId: A.id, outputId: outA.id, content: { summary: "A strateji" }, createdBy: "user", generator: "user", isDemo: false });
  const { addMemory } = await import("@/lib/services/brand-memory");
  const memB = await addMemory(B.id, { kind: "guideline", title: "B gizli hafıza", body: "B markasının özel yönergesi" });
  const runB = (await q1<{ id: string }>(`INSERT INTO research_runs (brand_id, mode, query, provider, status) VALUES ($1,'search','B gizli sorgu','firecrawl','completed') RETURNING id`, [B.id]))!;
  const srcB = (await q1<{ id: string }>(`INSERT INTO research_sources (run_id, brand_id, url, title) VALUES ($1,$2,'https://b-secret.example/x','B gizli kaynak') RETURNING id`, [runB.id, B.id]))!;
  const upB = (await initUpload(B.id, { filename: "b.mp4", size: 1024, clientKey: "b-key" })).session;
  const zipKey = `brands/${B.id}/exports/x.zip`;
  await s3.send(new PutObjectCommand({ Bucket: "aiops-httptest", Key: zipKey, Body: Buffer.from("PK\x03\x04") }));
  const exportB = (await q1<{ id: string }>(
    `INSERT INTO external_actions (brand_id, output_version_id, action_type, provider, idempotency_key, status, request, response)
     SELECT $1, v.id, 'publish', 'tiktok', $2, 'manual_export', '{}'::jsonb, $3 FROM outputs o JOIN output_versions v ON v.output_id = o.id WHERE o.id = $4 RETURNING id`,
    [B.id, crypto.randomUUID(), JSON.stringify({ storage_key: zipKey }), outB.id],
  ))!;
  const { closePool } = await import("@/lib/db/pool");
  await closePool();
  return { A, B, mediaA, mediaB, projectB, taskB, outA, outB, upB, exportB, memB, srcB };
}

async function startServer(): Promise<ChildProcess> {
  // Önceki bir çalıştırmadan kalan sunucu (farklı gizli değerlerle) varsa testler ona bağlanırdı: başlamadan önce port boş olmalı
  if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) throw new Error(`Port ${PORT} zaten kullanımda; önceki test sunucusunu kapatın.`);
  // Ayrı süreç grubu: kapatırken npx ile birlikte asıl next-server süreci de sonlandırılır
  const proc = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(PORT)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const ok = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
    if (ok) return proc;
  }
  proc.kill();
  throw new Error("Sunucu başlamadı:\n" + log.slice(-2000));
}

async function main() {
  await fs.access(path.resolve(".next/BUILD_ID")).catch(() => {
    throw new Error("Üretim derlemesi yok: önce `npm run build` çalıştırın.");
  });
  await resetDb();
  const s = await seed();
  const server = await startServer();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }).catch(() => chromium.launch());
  try {
    // ------------------------------------------------ Oturum olmadan
    await check("oturumsuz: panel sayfası giriş ekranına yönlendirir", async () => {
      const r = await fetch(`${BASE}/taslaklar/${s.outB.id}`, { redirect: "manual" });
      expect(r.status === 307 || r.status === 302, `durum ${r.status}`);
      expect((r.headers.get("location") ?? "").includes("/login"), "login'e gitmedi");
    });
    await check("oturumsuz: yeni bölümler (hafıza, araştırma, maliyet, stüdyolar, kampanyalar, PR ajansı) giriş ister", async () => {
      for (const u of ["/hafiza", "/arastirma", "/maliyet", "/studyo/video", "/studyo/gorsel", "/projeler", "/pr-ajansi"]) {
        const r = await fetch(BASE + u, { redirect: "manual" });
        expect((r.status === 307 || r.status === 302) && (r.headers.get("location") ?? "").includes("/login"), `${u} durum ${r.status}`);
      }
    });
    for (const [name, url, method] of [
      ["medya dosyası", `/api/media/${s.mediaA.id}/file`, "GET"],
      ["tanılama", `/api/diagnostics`, "GET"],
      ["yükleme başlatma", `/api/uploads`, "POST"],
      ["yükleme durumu", `/api/uploads/${s.upB.id}`, "GET"],
      ["dışa aktarma", `/api/exports/${s.exportB.id}`, "GET"],
    ] as const) {
      await check(`oturumsuz: ${name} → 401`, async () => {
        const r = await fetch(BASE + url, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
        expect(r.status === 401, `durum ${r.status}`);
      });
    }
    await check("oturumsuz: sahte oturum çerezi reddedilir", async () => {
      const forged = `${Math.floor(Date.now() / 1000) + 3600}.abcd.${"A".repeat(43)}`;
      const r = await fetch(`${BASE}/api/diagnostics`, { headers: { cookie: `__Host-aiops_session=${forged}` } });
      expect(r.status === 401, `durum ${r.status}`);
    });
    await check("sürüm durum ucu: belirteçsiz/yanlış belirteç 401; doğru belirteçle commit, geçişler ve işleyici; gizli değer yok", async () => {
      const url = `${BASE}/api/release/status`;
      expect((await fetch(url)).status === 401, "belirteçsiz");
      expect((await fetch(url, { headers: { authorization: "Bearer wrong-token-wrong-token-wrong-token-xx" } })).status === 401, "yanlış belirteç");
      const r = await fetch(url, { headers: { authorization: `Bearer ${secrets.RELEASE_STATUS_TOKEN}` } });
      expect(r.status === 200, `durum ${r.status}`);
      const txt = await r.text();
      const body = JSON.parse(txt);
      expect(body.commit === env.AIOPS_RELEASE_COMMIT, `commit ${body.commit}`);
      expect(body.migrations.applied.includes("003_brand_memory_research.sql") && body.migrations.pending.length === 0, JSON.stringify(body.migrations));
      for (const [k, v] of Object.entries(secrets)) expect(!txt.includes(v), `${k} yanıtta`);
      expect(!txt.includes("postgres://"), "bağlantı adresi yanıtta");
      const ev = await fetch(`${BASE}/api/release/events`, { method: "POST", headers: { authorization: `Bearer ${secrets.RELEASE_STATUS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ releaseId: "http-test-1", sha: "c".repeat(40), phase: "started" }) });
      expect(ev.status === 200, `olay ${ev.status}`);
      const noAuth = await fetch(`${BASE}/api/release/events`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(noAuth.status === 401, `belirteçsiz olay ${noAuth.status}`);
      const bad = await fetch(`${BASE}/api/release/events`, { method: "POST", headers: { authorization: `Bearer ${secrets.RELEASE_STATUS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ releaseId: "x", sha: "zz", phase: "started" }) });
      expect(bad.status === 400, `geçersiz olay ${bad.status}`);
    });
    await check("sağlık kontrolü yalnızca {ok} döndürür", async () => {
      const r = await fetch(`${BASE}/api/health`);
      const body = await r.json();
      expect(JSON.stringify(body) === '{"ok":true}', JSON.stringify(body));
    });
    await check("güvenlik başlıkları (HSTS, frame, nosniff, request id)", async () => {
      const r = await fetch(`${BASE}/login`);
      for (const h of ["strict-transport-security", "x-frame-options", "x-content-type-options", "x-request-id", "referrer-policy"]) expect(r.headers.get(h), `${h} yok`);
      const rid = await fetch(`${BASE}/api/health`, { headers: { "x-request-id": "bad id with spaces" } });
      expect(/^[0-9a-f-]{36}$/.test(rid.headers.get("x-request-id") ?? ""), "geçersiz istek kimliği yansıtıldı");
    });

    // ------------------------------------------------ Giriş
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await check("hatalı parola reddedilir", async () => {
      await page.goto(`${BASE}/login`);
      await page.fill("input[name=password]", "wrong-password-123");
      await page.click("form button");
      await page.waitForURL(/err=/);
      expect((await ctx.cookies()).every((c) => c.name !== "__Host-aiops_session"), "oturum çerezi verildi");
    });
    await check("giriş: oturum çerezi HttpOnly + Secure + __Host- öneki", async () => {
      await page.goto(`${BASE}/login?next=${encodeURIComponent("/\\evil.example")}`);
      await page.fill("input[name=password]", secrets.ADMIN_PASSWORD);
      await page.click("form button");
      await page.waitForLoadState("networkidle");
      const c = (await ctx.cookies()).find((x) => x.name === "__Host-aiops_session");
      expect(c, "çerez yok");
      expect(c.httpOnly && c.secure && c.path === "/" && c.sameSite === "Lax", JSON.stringify({ ...c, value: "***" }));
      expect(new URL(page.url()).host === `127.0.0.1:${PORT}`, `site dışına yönlendirdi: ${page.url()}`);
    });

    // ------------------------------------------------ Markalar arası erişim (seçili marka A)
    await ctx.addCookies([{ name: "brand_id", value: s.A.id, url: BASE }]);
    const api = ctx.request;
    await check("A seçiliyken A'nın dosyası okunur (kontrol)", async () => {
      const r = await api.get(`${BASE}/api/media/${s.mediaA.id}/file`);
      expect(r.status() === 200, `durum ${r.status()}`);
      expect(r.headers()["content-security-policy"]?.includes("sandbox"), "CSP sandbox yok");
      const part = await api.get(`${BASE}/api/media/${s.mediaA.id}/file`, { headers: { range: "bytes=0-9" } });
      expect(part.status() === 206 && (await part.body()).length === 10, `aralık ${part.status()}`);
      const bad = await api.get(`${BASE}/api/media/${s.mediaA.id}/file`, { headers: { range: "bytes=999999-" } });
      expect(bad.status() === 416, `geçersiz aralık ${bad.status()}`);
    });
    await check("indirme bağlantısı: kendi dosyası 'attachment', başka markanınki 404", async () => {
      const own = await api.get(`${BASE}/api/media/${s.mediaA.id}/file?download=1`);
      expect(own.status() === 200 && (own.headers()["content-disposition"] ?? "").startsWith("attachment"), `durum ${own.status()} ${own.headers()["content-disposition"]}`);
      const foreign = await api.get(`${BASE}/api/media/${s.mediaB.id}/file?download=1`);
      expect(foreign.status() === 404, `durum ${foreign.status()}`);
    });
    for (const [name, method, url, body] of [
      ["B'nin medya dosyası", "GET", `/api/media/${s.mediaB.id}/file`, undefined],
      ["B'nin analiz karesi", "GET", `/api/media/${s.mediaB.id}/analysis-frame/0`, undefined],
      ["B'nin yükleme oturumu", "GET", `/api/uploads/${s.upB.id}`, undefined],
      ["B'nin yükleme parça adresi", "POST", `/api/uploads/${s.upB.id}/targets`, { parts: [1] }],
      ["B'nin yükleme parçası", "PUT", `/api/uploads/${s.upB.id}/parts/1`, "x".repeat(1024)],
      ["B'nin yükleme tamamlama", "POST", `/api/uploads/${s.upB.id}/complete`, undefined],
      ["B'nin yükleme iptali", "POST", `/api/uploads/${s.upB.id}/abort`, undefined],
      ["B'nin dışa aktarma paketi", "GET", `/api/exports/${s.exportB.id}`, undefined],
      ["geçersiz kimlik (yol geçişi)", "GET", `/api/media/..%2F..%2Fetc%2Fpasswd/file`, undefined],
      ["geçersiz kimlik (SQL)", "GET", `/api/exports/1'%20OR%20'1'='1`, undefined],
    ] as const) {
      await check(`A seçiliyken ${name} → 404`, async () => {
        const r = await api.fetch(BASE + url, { method, data: typeof body === "string" ? body : body ? body : undefined, headers: { origin: BASE } });
        expect(r.status() === 404, `durum ${r.status()} ${(await r.text()).slice(0, 120)}`);
      });
    }
    for (const [name, url] of [
      ["çıktı", `/taslaklar/${s.outB.id}`], ["görev", `/gorevler/${s.taskB.id}`], ["proje", `/projeler/${s.projectB.id}`], ["medya", `/medya/${s.mediaB.id}`],
      ["geçersiz kimlikli çıktı", `/taslaklar/not-a-uuid`],
    ]) {
      await check(`A seçiliyken B'nin ${name} sayfası 404`, async () => {
        const r = await page.goto(BASE + url);
        expect(r!.status() === 404, `durum ${r!.status()}`);
        expect(!(await page.content()).includes("B gizli strateji"), "B içeriği sızdı");
      });
    }
    await check("A'nın Marka Hafızası, Araştırma Merkezi ve PR Ajansı'nda B kaydı görünmez", async () => {
      for (const url of ["/hafiza", "/arastirma", "/pr-ajansi"]) {
        await page.goto(BASE + url);
        const html = await page.content();
        for (const needle of ["B gizli hafıza", "B gizli sorgu", "B gizli kaynak", "b-secret.example", s.memB.id, s.srcB.id]) expect(!html.includes(needle), `${url} ${needle} içeriyor`);
      }
    });
    await check("sunucu eylemi: A'dan B'nin hafıza kaydı ve araştırma kaynağı değiştirilemez", async () => {
      await page.goto(`${BASE}/hafiza`);
      const { q1 } = await import("@/lib/db/pool");
      // Yeni bir A kaydı oluşturup formdaki kimliği B'ninkiyle değiştir
      await page.fill("#mem-title", "A kaydı");
      await page.fill("#mem-body", "A yönergesi");
      await page.locator('form:has(#mem-title) button[type=submit]').click();
      await page.waitForURL(/ok=/);
      const swapped = await page.evaluate((id) => {
        const input = document.querySelector<HTMLInputElement>('form input[name="status"][value="archived"]')?.form?.querySelector<HTMLInputElement>('input[name="id"]');
        if (!input) return false;
        input.value = id;
        return true;
      }, s.memB.id);
      expect(swapped, "arşivle formu bulunamadı");
      await page.locator('form:has(input[name="status"][value="archived"]) button').first().click();
      await page.waitForLoadState("networkidle");
      expect((await q1<{ status: string }>(`SELECT status FROM brand_memory WHERE id = $1`, [s.memB.id]))!.status === "active", "B'nin hafıza kaydı değişti");
      expect(decodeURIComponent(page.url()).includes("bulunamadı"), `hata mesajı yok: ${page.url()}`);
    });
    await check("Araştırma Merkezi: anahtar yokken 'gerekli' durumu, düğme pasif, entegrasyonlarda 'Etkin' değil", async () => {
      await page.goto(`${BASE}/arastirma`);
      const html = await page.content();
      expect(html.includes("FIRECRAWL_API_KEY") && html.includes("Kullanılamıyor"), "engelli durum gösterilmedi");
      expect(await page.locator('form:has(textarea[name="query"]) button[type=submit]').isDisabled(), "Araştır düğmesi aktif");
      await page.goto(`${BASE}/entegrasyonlar`);
      for (const t of ["firecrawl", "posthog", "composio", "remotion", "omniroute"]) {
        const st = await page.locator(`tr[data-tool="${t}"]`).getAttribute("data-state");
        expect(st && st !== "active", `${t} durumu ${st}`);
      }
    });
    await check("A'nın listelerinde B kaydı görünmez", async () => {
      for (const url of ["/taslaklar", "/medya", "/gorevler", "/projeler", "/studyo/video", "/studyo/gorsel"]) {
        await page.goto(BASE + url);
        const html = await page.content();
        expect(!html.includes(s.outB.id) && !html.includes(s.mediaB.id) && !html.includes(s.projectB.id), `${url} B kimliği içeriyor`);
      }
    });
    await check("sunucu eylemi: A'nın onay formuna B'nin sürüm kimliği konursa reddedilir", async () => {
      await page.goto(`${BASE}/taslaklar/${s.outA.id}`);
      const { q1 } = await import("@/lib/db/pool");
      const vB = (await q1<{ id: string }>(`SELECT id FROM output_versions WHERE output_id = $1`, [s.outB.id]))!;
      const changed = await page.evaluate((vid) => {
        const input = document.querySelector<HTMLInputElement>('form input[name="versionId"]');
        if (!input) return false;
        input.value = vid;
        return true;
      }, vB.id);
      expect(changed, "onay formu bulunamadı");
      await page.locator('form:has(input[name="versionId"]) button').first().click();
      await page.waitForLoadState("networkidle");
      const ap = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM approvals WHERE output_version_id = $1`, [vB.id]);
      expect(ap!.n === 0, "B sürümü A üzerinden onaylandı");
    });
    await check("CSRF: başka kökenden durum değiştiren istek reddedilir", async () => {
      const r = await api.post(`${BASE}/api/uploads`, { data: { filename: "x.mp4", size: 10, clientKey: "k" }, headers: { origin: "https://evil.example" } });
      expect(r.status() === 403, `durum ${r.status()}`);
    });
    await check("tanılama gizli değer içermez", async () => {
      const r = await api.get(`${BASE}/api/diagnostics`);
      expect(r.status() === 200 || r.status() === 503, `durum ${r.status()}`);
      const txt = await r.text();
      for (const [k, v] of Object.entries(secrets)) expect(!txt.includes(v), `${k} yanıtta`);
      return `genel durum: ${JSON.parse(txt).overall}`;
    });
    await check("üretim modunda DEMO kapalı (sahte çıktı üretilmez)", async () => {
      await page.goto(`${BASE}/`);
      const html = await page.content();
      expect(!html.includes("DEMO modu:"), "DEMO şeridi görünüyor");
    });
    await ctx.close();

    // ------------------------------------------------ Tarayıcı paketlerinde gizli değer yok
    await check("istemci paketlerinde gizli değer veya sunucu anahtar adı yok", async () => {
      const files: string[] = [];
      const walk = async (d: string) => {
        for (const e of await fs.readdir(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p);
          else if (/\.(js|css|html|json)$/.test(e.name)) files.push(p);
        }
      };
      await walk(path.resolve(".next/static"));
      const needles = [/sk-ant-[A-Za-z0-9]/, /AIza[0-9A-Za-z_-]{20}/, /S3_SECRET_ACCESS_KEY/, /SESSION_SECRET/, /ENCRYPTION_KEY/, /ADMIN_PASSWORD/, /AIOPS_ANTHROPIC_API_KEY/, /GEMINI_API_KEY/, /OPENAI_API_KEY/, /FIRECRAWL_API_KEY/, /POSTHOG_API_KEY/, /phc_[A-Za-z0-9]{10}/, /RELEASE_STATUS_TOKEN/, /RENDER_API_KEY/];
      for (const f of files) {
        const txt = await fs.readFile(f, "utf8");
        for (const n of needles) expect(!n.test(txt), `${path.relative(".", f)} içinde ${n}`);
      }
      return `${files.length} dosya tarandı`;
    });

    // ------------------------------------------------ Kaba kuvvet kilidi (en sonda: sonraki girişleri kilitler)
    await check("5 hatalı denemeden sonra doğru parola da kilitlenir", async () => {
      const c2 = await browser.newContext();
      const p2 = await c2.newPage();
      for (let i = 0; i < 5; i++) {
        await p2.goto(`${BASE}/login`);
        await p2.fill("input[name=password]", `wrong-${i}-xxxxxxxx`);
        await p2.click("form button");
        await p2.waitForURL(/err=/);
      }
      await p2.goto(`${BASE}/login`);
      await p2.fill("input[name=password]", secrets.ADMIN_PASSWORD);
      await p2.click("form button");
      await p2.waitForURL(/err=/);
      expect(decodeURIComponent(p2.url()).includes("15 dakika"), p2.url());
      expect((await c2.cookies()).every((c) => c.name !== "__Host-aiops_session"), "kilitliyken oturum verildi");
      await c2.close();
    });
  } finally {
    await browser.close();
    try { process.kill(-server.pid!, "SIGTERM"); } catch { server.kill("SIGTERM"); }
    for (let i = 0; i < 20 && (await fetch(`${BASE}/api/health`).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 250));
    const { closePool } = await import("@/lib/db/pool");
    await closePool().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\n${results.length - failed.length}/${results.length} geçti`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
