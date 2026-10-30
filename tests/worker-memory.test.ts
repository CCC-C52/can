import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { q, q1 } from "@/lib/db/pool";
import { createBrand } from "@/lib/services/brands";
import { claimTasks } from "@/lib/orchestrator/engine";
import { DEFAULT_LIMITS } from "@/lib/settings";
import { REFERENCE_MAX_PX, fitReference } from "@/lib/adapters/images";

// Canlı (30 Ekim 2026): film render'ı ile 8 görsellik OpenAI üretimi 512 MB işleyicide aynı anda çalıştı; görsel
// üretimi tam çözünürlüklü Drive orijinallerini referans olarak belleğe alıyordu. İşleyici iki kez düştü, iki ücretli
// görsel gönderimi "sonucu belirsiz" kaldı.

let brandId: string;
let projectId: string;

beforeAll(async () => {
  brandId = (await createBrand({ name: "İşleyici Belleği" })).id;
  projectId = (await q1<{ id: string }>(`INSERT INTO projects (brand_id, title, instruction, status, idempotency_key) VALUES ($1,'p','i','running','worker-memory') RETURNING id`, [brandId]))!.id;
});

const addTask = (key: string, kind: string) =>
  q(`INSERT INTO tasks (brand_id, project_id, key, agent, kind, title, instruction, status) VALUES ($1,$2,$3,'design',$4,$3,'i','ready')`, [brandId, projectId, key, kind]);

describe("İşleyici belleği", () => {
  it("render görevleri aynı anda en fazla bir tane çalışır; metin görevleri beklemez", async () => {
    await addTask("render-a", "render");
    await addTask("render-b", "render");
    await addTask("work-a", "work");
    await addTask("work-b", "work");
    const limits = { ...DEFAULT_LIMITS, maxConcurrentTasks: 3 };
    const first = await claimTasks("w1", limits);
    expect(first.map((t) => t.kind).sort()).toEqual(["render", "work", "work"]);
    expect(first.find((t) => t.kind === "render")!.key).toBe("render-a");
    // Bir yer açılsa da ikinci render, ilki sürerken alınmaz
    await q(`UPDATE tasks SET status = 'completed' WHERE project_id = $1 AND kind = 'work'`, [projectId]);
    expect(await claimTasks("w1", limits)).toEqual([]);
    await q(`UPDATE tasks SET status = 'completed' WHERE project_id = $1 AND key = 'render-a'`, [projectId]);
    expect((await claimTasks("w1", limits)).map((t) => t.key)).toEqual(["render-b"]);
  });

  it("OpenAI referansı gönderim boyutuna indirilir; küçük fotoğraf olduğu gibi gider; şeffaflık korunur", async () => {
    const big = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: { r: 170, g: 214, b: 232 } } }).jpeg({ quality: 90 }).toBuffer();
    const r = await fitReference({ buffer: big, mime: "image/jpeg", filename: "ref-1.jpeg" });
    const m = await sharp(r.buffer).metadata();
    expect([m.width, m.height, m.format, r.mime, r.filename, r.resized]).toEqual([REFERENCE_MAX_PX, 1365, "jpeg", "image/jpeg", "ref-1.jpg", true]);

    const small = await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 18, g: 18, b: 18 } } }).jpeg().toBuffer();
    const s = await fitReference({ buffer: small, mime: "image/jpeg", filename: "ref-2.jpeg" });
    expect(s.buffer).toBe(small);
    expect(s.resized).toBe(false);

    const alpha = await sharp({ create: { width: 3000, height: 3000, channels: 4, background: { r: 245, g: 130, b: 20, alpha: 0.5 } } }).png().toBuffer();
    const a = await fitReference({ buffer: alpha, mime: "image/png", filename: "ref-3.png" });
    const am = await sharp(a.buffer).metadata();
    expect([am.width, am.height, am.format, am.hasAlpha, a.mime]).toEqual([REFERENCE_MAX_PX, REFERENCE_MAX_PX, "png", true, "image/png"]);
  });
});
