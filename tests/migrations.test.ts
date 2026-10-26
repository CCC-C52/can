import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { runMigrations } from "@/lib/db/migrate";

// Geçişler: (1) temiz veritabanı, (2) yalnızca 001 uygulanmış ve gerçekçi verilerle doldurulmuş "mevcut" veritabanı fikstürü.
const base = process.env.DATABASE_URL_OVERRIDE!;
const url = (db: string) => base.replace(/\/[^/]+$/, `/${db}`);
let admin: pg.Client;

async function freshDb(name: string) {
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  return new pg.Pool({ connectionString: url(name) });
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: base });
  await admin.connect();
});
afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS aiops_mig_clean`).catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS aiops_mig_fixture`).catch(() => {});
  await admin.end();
});

describe("Veritabanı geçişleri", () => {
  it("temiz veritabanında uygulanır ve tekrar çalıştırmak bir şey değiştirmez", async () => {
    const pool = await freshDb("aiops_mig_clean");
    const first = await runMigrations(undefined, { pool });
    expect(first).toEqual(["001_init.sql", "002_media_jobs_integrity.sql", "003_brand_memory_research.sql", "004_drive_archive.sql", "005_brand_knowledge.sql"]);
    expect(await runMigrations(undefined, { pool })).toEqual([]);
    const t = await pool.query(`SELECT to_regclass('media_analyses') AS a, to_regclass('upload_sessions') AS u, to_regclass('provider_jobs') AS p`);
    expect(t.rows[0]).toEqual({ a: "media_analyses", u: "upload_sessions", p: "provider_jobs" });
    await pool.end();
  });

  it("mevcut veriler korunur, ilişkiler geçerli kalır, onay geçmişi değiştirilemez olur", async () => {
    const pool = await freshDb("aiops_mig_fixture");
    await runMigrations(undefined, { pool, until: "001_init.sql" });
    const q = (s: string, p: unknown[] = []) => pool.query(s, p);
    // 001 şemasıyla gerçekçi (canlıya benzer) kayıtlar
    const b = (await q(`INSERT INTO brands (slug, name, content_language) VALUES ('fribee-fixture','FriBee (fixture)','en') RETURNING id`)).rows[0].id;
    const pr = (await q(`INSERT INTO projects (brand_id, title, instruction, idempotency_key, status) VALUES ($1,'p','i','k1','needs_attention') RETURNING id`, [b])).rows[0].id;
    const t = (await q(`INSERT INTO tasks (brand_id, project_id, key, agent, title, instruction, status, error) VALUES ($1,$2,'strategy','marketing','t','i','failed','Pazarlama Uzmanı ''outputs.read'' aracını kullanma iznine sahip değil.') RETURNING id`, [b, pr])).rows[0].id;
    const photo = (await q(`INSERT INTO media_assets (brand_id, kind, origin, filename, mime_type, size_bytes, sha256, storage_key) VALUES ($1,'photo','real_photo','a.jpg','image/jpeg',10,'s1','k/a') RETURNING id`, [b])).rows[0].id;
    await q(`INSERT INTO media_assets (brand_id, kind, origin, filename, mime_type, size_bytes, sha256, storage_key, source_task_id, parent_asset_id) VALUES ($1,'photo','edited','c.png','image/png',10,'s2','k/c',$2,$3)`, [b, t, photo]);
    await q(`INSERT INTO media_assets (brand_id, kind, origin, filename, mime_type, size_bytes, sha256, storage_key, source_task_id) VALUES ($1,'video','edited','v.mp4','video/mp4',10,'s3','k/v',$2)`, [b, t]);
    const o = (await q(`INSERT INTO outputs (brand_id, project_id, task_id, agent, kind, title, current_version) VALUES ($1,$2,$3,'marketing','strategy','o',1) RETURNING id`, [b, pr, t])).rows[0].id;
    const v = (await q(`INSERT INTO output_versions (brand_id, output_id, version, content, content_hash, created_by, generator) VALUES ($1,$2,1,'{"a":1}','h','agent:marketing','anthropic:x') RETURNING id`, [b, o])).rows[0].id;
    await q(`INSERT INTO approvals (brand_id, output_id, output_version_id, content_hash, decision) VALUES ($1,$2,$3,'h','approved')`, [b, o, v]);
    const counts = async () => (await q(`SELECT (SELECT count(*) FROM brands) b, (SELECT count(*) FROM tasks) t, (SELECT count(*) FROM media_assets) m, (SELECT count(*) FROM outputs) o, (SELECT count(*) FROM output_versions) v, (SELECT count(*) FROM approvals) a`)).rows[0];
    const before = await counts();

    expect(await runMigrations(undefined, { pool })).toEqual(["002_media_jobs_integrity.sql", "003_brand_memory_research.sql", "004_drive_archive.sql", "005_brand_knowledge.sql"]);
    expect(await counts()).toEqual(before);
    // Etiket düzeltmesi ve proje ilişkisi
    const media = (await q(`SELECT filename, origin, generation_method, project_id FROM media_assets ORDER BY filename`)).rows;
    expect(media).toEqual([
      { filename: "a.jpg", origin: "real_photo", generation_method: "upload", project_id: null },
      { filename: "c.png", origin: "composed", generation_method: "sharp_compose", project_id: pr },
      { filename: "v.mp4", origin: "edited", generation_method: "ffmpeg_edit", project_id: pr },
    ]);
    // Tarihsel hata metni korunur
    expect((await q(`SELECT error FROM tasks WHERE id = $1`, [t])).rows[0].error).toMatch(/outputs\.read/);
    // Onaylar değiştirilemez / silinemez; yalnızca geri alma bir kez yapılabilir
    await expect(q(`UPDATE approvals SET decision = 'rejected'`)).rejects.toThrow(/immutable/);
    await expect(q(`DELETE FROM approvals`)).rejects.toThrow(/append-only/);
    await q(`UPDATE approvals SET revoked_at = now()`);
    await expect(q(`UPDATE approvals SET revoked_at = now() + interval '1 day'`)).rejects.toThrow(/immutable/);
    // Sürüm içeriği değiştirilemez, QA raporu güncellenebilir
    await expect(q(`UPDATE output_versions SET content = '{"a":2}'`)).rejects.toThrow(/immutable/);
    await q(`UPDATE output_versions SET qa_report = '{"verdict":"pass"}'`);
    // Yeni kısıtlar yeni satırlarda geçerli
    await expect(q(`INSERT INTO approvals (brand_id, output_id, output_version_id, content_hash, decision) VALUES ($1,$2,$3,'h','maybe')`, [b, o, v])).rejects.toThrow(/approvals_decision_check/);
    // 003: araştırma kaynağı başka markanın çalıştırmasına bağlanamaz (bileşik yabancı anahtar)
    const b2 = (await q(`INSERT INTO brands (slug, name) VALUES ('other-fixture','Other') RETURNING id`)).rows[0].id;
    const run = (await q(`INSERT INTO research_runs (brand_id, mode, query, provider) VALUES ($1,'search','q','firecrawl') RETURNING id`, [b])).rows[0].id;
    await q(`INSERT INTO research_sources (run_id, brand_id, url) VALUES ($1,$2,'https://example.com')`, [run, b]);
    await expect(q(`INSERT INTO research_sources (run_id, brand_id, url) VALUES ($1,$2,'https://example.com')`, [run, b2])).rejects.toThrow(/foreign key/);
    await expect(q(`INSERT INTO research_sources (run_id, brand_id, url) VALUES ($1,$2,'javascript:alert(1)')`, [run, b])).rejects.toThrow(/check/);
    await expect(q(`INSERT INTO brand_memory (brand_id, kind, title, body) VALUES ($1,'secret','t','b')`, [b])).rejects.toThrow(/check/);
    await pool.end();
  });
});

describe("Bütünlük denetimi", () => {
  it("tutarsızlığı bulur ama hiçbir şeyi değiştirmez", async () => {
    const { checkIntegrity } = await import("@/lib/db/check");
    const { q } = await import("@/lib/db/pool");
    const { createBrand } = await import("@/lib/services/brands");
    const a = await createBrand({ name: "Check A" });
    const b = await createBrand({ name: "Check B" });
    const pa = (await q<{ id: string }>(`INSERT INTO media_assets (brand_id, kind, origin, filename, mime_type, size_bytes, sha256, storage_key) VALUES ($1,'photo','real_photo','p.jpg','image/jpeg',1,'chk1','k1') RETURNING id`, [a.id]))[0].id;
    await q(`INSERT INTO media_assets (brand_id, kind, origin, filename, mime_type, size_bytes, sha256, storage_key, parent_asset_id) VALUES ($1,'photo','composed','d.png','image/png',1,'chk2','k2',$2)`, [b.id, pa]);
    const before = await q<{ n: number }>(`SELECT count(*)::int AS n FROM media_assets`);
    const issues = await checkIntegrity();
    expect(issues.find((i) => i.check === "media_parent_cross_brand")?.count).toBe(1);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM media_assets`))[0].n).toBe(before[0].n);
    await q(`DELETE FROM media_assets WHERE sha256 = 'chk2'`);
  });
});
