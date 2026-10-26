import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { q } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { setPaused } from "@/lib/orchestrator/projects";
import { authenticateBridge, bridgeCredentials } from "@/lib/bridge";
import { POST } from "@/app/api/bridge/v1/instructions/route";
import { GET } from "@/app/api/bridge/v1/projects/[id]/route";

// Testlerde yalnızca sentetik, test sırasında üretilen belirteçler kullanılır; gerçek kimlik bilgisi yoktur.
const secret = () => crypto.randomBytes(32).toString("base64url");
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const env = { ...process.env };

let brandA: string, brandB: string;
let fullA: string, readA: string, fullB: string, idA: string;

// Her test yeni kimlik numaraları kullanır: kimlik başına hız sınırı testler arasında birikmez.
let seq = 0;
function configure() {
  const n = ++seq;
  idA = `fulla${n}`;
  fullA = `fbb_${idA}_${secret()}`;
  readA = `fbb_reada${n}_${secret()}`;
  fullB = `fbb_fullb${n}_${secret()}`;
  process.env.AI_MANAGER_BRIDGE_CREDENTIALS = [
    `${idA}|${sha(fullA)}|${brandA}|status:read,instructions:submit`,
    `reada${n}|${sha(readA)}|${brandA}|status:read`,
    `fullb${n}|${sha(fullB)}|${brandB}|status:read,instructions:submit`,
  ].join(";");
}

let ipSeq = 0;
function post(token: string | null, body: unknown, opts: { key?: string; ts?: number; raw?: string } = {}) {
  const h: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ipSeq % 250}` };
  if (token) h.authorization = `Bearer ${token}`;
  if (opts.key !== "") h["idempotency-key"] = opts.key ?? crypto.randomBytes(12).toString("hex");
  h["x-bridge-timestamp"] = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return POST(new Request("http://localhost/api/bridge/v1/instructions", { method: "POST", headers: h, body: opts.raw ?? JSON.stringify(body) }));
}
function status(token: string | null, id: string) {
  const h: Record<string, string> = { "x-forwarded-for": `10.1.0.${++ipSeq % 250}` };
  if (token) h.authorization = `Bearer ${token}`;
  return GET(new Request(`http://localhost/api/bridge/v1/projects/${id}`, { headers: h }), { params: Promise.resolve({ id }) });
}
const count = async (sql: string, p: unknown[] = []) => (await q<{ n: number }>(sql, p))[0].n;

beforeAll(async () => {
  brandA = (await createBrand({ name: "Köprü Test A (sentetik)" })).id;
  brandB = (await createBrand({ name: "Köprü Test B (sentetik)" })).id;
});
afterEach(async () => {
  process.env = { ...env };
  await setPaused(false);
});

describe("Köprü — yapılandırma", () => {
  it("değişken yoksa köprü kapalıdır (404); hatalı girdiler yok sayılır", async () => {
    delete process.env.AI_MANAGER_BRIDGE_CREDENTIALS;
    expect((await post("fbb_x_y", { instruction: "hi" })).status).toBe(404);
    expect(bridgeCredentials("bad|entry;x|" + "0".repeat(64) + "|not-a-uuid|status:read")).toEqual([]);
    expect(bridgeCredentials(`okid|${"a".repeat(64)}|${crypto.randomUUID()}|admin:all`)).toEqual([]);
  });
});

describe("Köprü — kimlik doğrulama ve yetki", () => {
  it("belirteç yok / geçersiz / yanlış biçim → 401", async () => {
    configure();
    expect((await post(null, { instruction: "x" })).status).toBe(401);
    expect((await post(`fbb_${idA}_${secret()}`, { instruction: "x" })).status).toBe(401);
    expect((await post(fullA + "x", { instruction: "x" })).status).toBe(401);
    expect((await post("not-a-bridge-token", { instruction: "x" })).status).toBe(401);
    expect((await status(null, crypto.randomUUID())).status).toBe(401);
    expect(authenticateBridge(`Bearer ${fullA}`)?.id).toBe(idA);
    expect(authenticateBridge(fullA)).toBeNull();
  });

  it("rotasyon: listeden çıkarılan belirteç hemen geçersiz olur", async () => {
    configure();
    const old = fullA;
    process.env.AI_MANAGER_BRIDGE_CREDENTIALS = process.env.AI_MANAGER_BRIDGE_CREDENTIALS!.split(";").filter((e) => !e.startsWith(`${idA}|`)).join(";");
    expect(authenticateBridge(`Bearer ${old}`)).toBeNull();
  });

  it("yalnızca status:read kapsamlı belirteç talimat gönderemez (403)", async () => {
    configure();
    const r = await post(readA, { instruction: "Yeni kampanya", confirm_cost: true });
    expect(r.status).toBe(403);
  });
});

describe("Köprü — maliyet onayı ve ücretli iş", () => {
  it("confirm_cost olmadan hiçbir kayıt yazılmaz (önizleme)", async () => {
    configure();
    const before = await count(`SELECT COUNT(*)::int AS n FROM projects`);
    const tasksBefore = await count(`SELECT COUNT(*)::int AS n FROM tasks`);
    const r = await post(fullA, { instruction: "FriBee için yaz kampanyası planla" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.status).toBe("preview");
    expect(j.billable).toBe(true);
    expect(await count(`SELECT COUNT(*)::int AS n FROM projects`)).toBe(before);
    expect(await count(`SELECT COUNT(*)::int AS n FROM tasks`)).toBe(tasksBefore);
  });

  it("kısa onaylar (bekleyen planı başlatabilecek) köprüden kabul edilmez; plan onayı panelde verilir", async () => {
    configure();
    const r = await post(fullA, { instruction: "onaylıyorum", confirm_cost: true });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("approval_requires_panel");
  });

  it("çalışma duraklatılmışsa talimat kaydedilmez", async () => {
    configure();
    await setPaused(true);
    const r = await post(fullA, { instruction: "Duraklatılmışken görev", confirm_cost: true });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("paused");
  });

  it("onaylı gönderim panelle aynı yolu kullanır; testte sağlayıcı maliyeti oluşmaz (işleyici çalışmaz)", async () => {
    configure();
    const costsBefore = await count(`SELECT COUNT(*)::int AS n FROM cost_entries`);
    const r = await post(fullA, { instruction: "FriBee ürün açıklamalarını güncelle", confirm_cost: true });
    expect(r.status).toBe(202);
    const j = await r.json();
    expect(j.status).toBe("accepted");
    const tasks = await q<{ kind: string; status: string; brand_id: string }>(`SELECT kind, status, brand_id FROM tasks WHERE project_id = $1`, [j.project_id]);
    expect(tasks).toEqual([{ kind: "plan", status: "ready", brand_id: brandA }]);
    expect(await count(`SELECT COUNT(*)::int AS n FROM task_attempts ta JOIN tasks t ON t.id = ta.task_id WHERE t.project_id = $1`, [j.project_id])).toBe(0);
    expect(await count(`SELECT COUNT(*)::int AS n FROM cost_entries`)).toBe(costsBefore);
    const log = await q<{ actor: string }>(`SELECT actor FROM audit_log WHERE project_id = $1 AND action = 'bridge.instruction_submit'`, [j.project_id]);
    expect(log[0].actor).toBe(`bridge:${idA}`);
  });
});

describe("Köprü — idempotency ve yeniden oynatma", () => {
  it("aynı anahtar tekrar gönderilirse yeni proje oluşturulmaz", async () => {
    configure();
    const key = crypto.randomBytes(12).toString("hex");
    const a = await (await post(fullA, { instruction: "Tek sefer çalışacak talimat", confirm_cost: true }, { key })).json();
    const b = await (await post(fullA, { instruction: "Tek sefer çalışacak talimat", confirm_cost: true }, { key })).json();
    expect(b.status).toBe("duplicate");
    expect(b.project_id).toBe(a.project_id);
    expect(await count(`SELECT COUNT(*)::int AS n FROM projects WHERE idempotency_key = $1`, [`bridge:${idA}:${key}`])).toBe(1);
  });

  it("anahtar eksik/kısa veya zaman damgası pencere dışında → 400", async () => {
    configure();
    expect((await post(fullA, { instruction: "x", confirm_cost: true }, { key: "" })).status).toBe(400);
    expect((await post(fullA, { instruction: "x", confirm_cost: true }, { key: "short" })).status).toBe(400);
    const stale = await post(fullA, { instruction: "x", confirm_cost: true }, { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.status).toBe(400);
    expect((await stale.json()).error).toBe("stale_request");
  });

  it("farklı markaya bağlı belirteç aynı anahtarla diğer markanın projesine ulaşamaz", async () => {
    configure();
    const key = crypto.randomBytes(12).toString("hex");
    const a = await (await post(fullA, { instruction: "A markası talimatı", confirm_cost: true }, { key })).json();
    const b = await (await post(fullB, { instruction: "B markası talimatı", confirm_cost: true }, { key })).json();
    expect(b.project_id).not.toBe(a.project_id);
  });
});

describe("Köprü — markalar arası yalıtım ve durum okuma", () => {
  it("durum yalnızca belirtecin markasındaki proje için döner; diğer marka 404 alır", async () => {
    configure();
    const a = await (await post(fullA, { instruction: "Durum okunacak talimat", confirm_cost: true })).json();
    const ok = await status(readA, a.project_id);
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.project.id).toBe(a.project_id);
    expect(j.tasks[0]).toMatchObject({ kind: "plan", status: "ready" });
    expect(Object.keys(j.tasks[0])).not.toContain("instruction");
    expect((await status(fullB, a.project_id)).status).toBe(404);
    expect((await status(readA, "not-a-uuid")).status).toBe(404);
    expect((await status(readA, crypto.randomUUID())).status).toBe(404);
  });
});

describe("Köprü — kötü niyetli girdi", () => {
  it("geçersiz JSON, ek alanlar, marka kimliği enjeksiyonu, aşırı uzunluk reddedilir", async () => {
    configure();
    expect((await post(fullA, null, { raw: "{not json" })).status).toBe(400);
    // brandId gövdeden ALINMAZ: ek alan şemayı geçmez
    expect((await post(fullA, { instruction: "x", confirm_cost: true, brandId: brandB })).status).toBe(400);
    expect((await post(fullA, { instruction: "a".repeat(8001), confirm_cost: true })).status).toBe(400);
    expect((await post(fullA, { instruction: 42, confirm_cost: true })).status).toBe(400);
    expect((await post(fullA, { instruction: "\u0000\u0001", confirm_cost: true })).status).toBe(400);
    expect((await post(fullA, null, { raw: JSON.stringify({ instruction: "x".repeat(25_000) }) })).status).toBe(413);
  });

  it("SQL/HTML içeren talimat düz metin olarak saklanır, tablo bozulmaz", async () => {
    configure();
    const evil = "'); DROP TABLE projects; -- <script>alert(1)</script>";
    const r = await (await post(fullA, { instruction: evil, confirm_cost: true })).json();
    const row = await q<{ instruction: string; brand_id: string }>(`SELECT instruction, brand_id FROM projects WHERE id = $1`, [r.project_id]);
    expect(row[0]).toEqual({ instruction: evil, brand_id: brandA });
  });
});
