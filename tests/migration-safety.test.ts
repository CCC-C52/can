import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { checkPolicy, classifySql, evaluatePending, sha256 } from "@/lib/db/migration-safety";
import { authorizedMigrationsFromEnv, runMigrations } from "@/lib/db/migrate";

const REPO = path.resolve(process.cwd(), "migrations");

/** Depodaki geçişlerin ve politikanın kopyası üzerinde senaryo kurar. */
function tempMigrations(mutate?: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  for (const f of fs.readdirSync(REPO)) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  mutate?.(dir);
  return dir;
}
const policyOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "policy.json"), "utf8"));

describe("Geçiş sınıflandırıcı", () => {
  it.each([
    ["DROP TABLE brands;"],
    ["ALTER TABLE media_assets DROP COLUMN alt_text;"],
    ["ALTER TABLE media_assets DROP IF EXISTS alt_text;"],
    ["TRUNCATE audit_log;"],
    ["DELETE FROM media_assets WHERE kind = 'video';"],
    ["ALTER TABLE tasks ALTER COLUMN status TYPE integer USING 0;"],
    ["ALTER TABLE tasks RENAME COLUMN status TO state;"],
    ["ALTER TABLE tasks RENAME TO jobs;"],
  ])("yıkıcı: %s", (sql) => {
    expect(classifySql(sql).class).toBe("destructive");
  });

  it.each([
    ["UPDATE media_assets SET origin = 'composed';"],
    ["INSERT INTO settings (key, value) VALUES ('x', '1');"],
    ["DO $$ BEGIN PERFORM 1; END $$;"],
    ["CREATE OR REPLACE FUNCTION f() RETURNS int AS $body$ SELECT 1 $body$ LANGUAGE sql;"],
    ["ALTER TABLE tasks ALTER COLUMN error SET NOT NULL;"],
    ["ALTER TABLE tasks ADD COLUMN IF NOT EXISTS x text NOT NULL;"],
    ["ALTER TABLE tasks ADD CONSTRAINT u UNIQUE (key);"],
    ["ALTER TABLE tasks ADD CONSTRAINT c CHECK (attempts >= 0);"],
    ["CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON tasks (key);"],
    ["CREATE TABLE no_guard (id int);"],
    ["ALTER TABLE tasks DROP CONSTRAINT c;"],
  ])("inceleme gerekir: %s", (sql) => {
    expect(classifySql(sql).class).toBe("review");
  });

  it("ekleme: 003 geçişi ve güvenli kalıplar otomatik onaylanabilir", () => {
    expect(classifySql(fs.readFileSync(path.join(REPO, "003_brand_memory_research.sql"), "utf8"))).toEqual({ class: "additive", findings: [] });
    const sql = `
      -- DROP TABLE brands;  (yorum: ifade sayılmaz)
      /* TRUNCATE x; */
      CREATE TABLE IF NOT EXISTS notes (id uuid PRIMARY KEY, body text DEFAULT 'DELETE FROM brands; DROP TABLE x');
      CREATE INDEX IF NOT EXISTS notes_body ON notes (body);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS note text;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS flag boolean NOT NULL DEFAULT false;
      ALTER TABLE tasks ADD CONSTRAINT tasks_attempts_nonneg CHECK (attempts >= 0) NOT VALID;
      COMMENT ON TABLE notes IS 'drop table brands';`;
    expect(classifySql(sql)).toEqual({ class: "additive", findings: [] });
  });
});

describe("Geçiş politikası (depo denetimi)", () => {
  it("depodaki geçişler politikaya uygun; 003 additive ve ilk canlı uygulaması onay gerektirir", () => {
    const r = checkPolicy(REPO);
    expect(r.errors).toEqual([]);
    const m003 = r.migrations.find((m) => m.name === "003_brand_memory_research.sql")!;
    expect(m003).toMatchObject({ class: "additive", policy: "additive", requiresAuthorization: true, autoApprovable: false });
  });

  it("uygulanmış geçişin içeriği değişirse veya dosya silinirse hata", () => {
    const changed = tempMigrations((d) => fs.appendFileSync(path.join(d, "002_media_jobs_integrity.sql"), "\n-- değişiklik\n"));
    expect(checkPolicy(changed).errors.join(" ")).toMatch(/002_media_jobs_integrity\.sql: içerik politika kaydıyla eşleşmiyor/);
    const removed = tempMigrations((d) => fs.rmSync(path.join(d, "001_init.sql")));
    expect(checkPolicy(removed).errors.join(" ")).toMatch(/001_init\.sql: politikada var ama dosya yok/);
  });

  it("kayıtsız yeni geçiş: additive ise kabul, yıkıcı/inceleme gerektiren ise ret", () => {
    const ok = tempMigrations((d) => fs.writeFileSync(path.join(d, "004_add_notes.sql"), "CREATE TABLE IF NOT EXISTS notes (id uuid PRIMARY KEY);\n"));
    const r = checkPolicy(ok);
    expect(r.ok).toBe(true);
    expect(r.migrations.find((m) => m.name === "004_add_notes.sql")).toMatchObject({ class: "additive", policy: "none", autoApprovable: true });
    const bad = tempMigrations((d) => fs.writeFileSync(path.join(d, "004_cleanup.sql"), "DELETE FROM audit_log;\n"));
    expect(checkPolicy(bad).errors.join(" ")).toMatch(/004_cleanup\.sql: politikada kaydı yok ve sınıflandırma 'destructive'/);
    const dup = tempMigrations((d) => fs.writeFileSync(path.join(d, "003_other.sql"), "CREATE TABLE IF NOT EXISTS z (id int);\n"));
    expect(checkPolicy(dup).errors.join(" ")).toMatch(/aynı numaralı/);
  });
});

describe("Dağıtım kapısı: canlıda bekleyen geçişler", () => {
  const base = ["001_init.sql", "002_media_jobs_integrity.sql"];
  it("003 sahip onayı olmadan engellenir; adıyla onay verilince izin", () => {
    const blocked = evaluatePending(REPO, base, []);
    expect(blocked.allowed).toBe(false);
    expect(blocked.pending).toEqual(["003_brand_memory_research.sql"]);
    expect(blocked.blocked[0].reason).toMatch(/bir kerelik açık onayını/);
    const ok = evaluatePending(REPO, base, ["003_brand_memory_research.sql"]);
    expect(ok).toMatchObject({ allowed: true, authorizedUsed: ["003_brand_memory_research.sql"] });
  });

  it("bekleyen geçiş yoksa izin; canlı şema sürümden yeniyse engel", () => {
    const all = [...base, "003_brand_memory_research.sql"];
    expect(evaluatePending(REPO, all, [])).toMatchObject({ allowed: true, pending: [] });
    const ahead = evaluatePending(REPO, [...all, "004_future.sql"], []);
    expect(ahead.allowed).toBe(false);
    expect(ahead.blocked[0].reason).toMatch(/canlıda uygulanmış ama bu sürümde yok/);
  });

  it("gelecekteki additive geçiş onaysız otomatik ilerler; yıkıcı olan engellenir", () => {
    const all = [...base, "003_brand_memory_research.sql"];
    const add = tempMigrations((d) => fs.writeFileSync(path.join(d, "004_add_notes.sql"), "CREATE TABLE IF NOT EXISTS notes (id uuid PRIMARY KEY);\n"));
    expect(evaluatePending(add, all, [])).toMatchObject({ allowed: true, pending: ["004_add_notes.sql"] });
    const drop = tempMigrations((d) => fs.writeFileSync(path.join(d, "004_drop.sql"), "DROP TABLE brand_memory;\n"));
    const r = evaluatePending(drop, all, ["004_drop.sql"]);
    expect(r.allowed).toBe(false);
  });
});

describe("Üretimde geçiş uygulama koruması (runMigrations)", () => {
  const baseUrl = process.env.DATABASE_URL_OVERRIDE!;
  const url = baseUrl.replace(/\/[^/]+$/, "/aiops_mig_guard");
  let admin: pg.Client;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS aiops_mig_guard`).catch(() => {});
    await admin.end();
  });
  async function fresh() {
    await admin.query(`DROP DATABASE IF EXISTS aiops_mig_guard`);
    await admin.query(`CREATE DATABASE aiops_mig_guard`);
    return new pg.Pool({ connectionString: url });
  }

  it("yıkıcı kayıtsız geçiş uygulanmaz; önceki geçişler uygulanmış kalır", async () => {
    const dir = tempMigrations((d) => fs.writeFileSync(path.join(d, "004_drop.sql"), "DROP TABLE brand_memory;\n"));
    const pool = await fresh();
    await expect(runMigrations(dir, { pool, enforcePolicy: true, authorizedMigrations: ["003_brand_memory_research.sql"] })).rejects.toThrow(/004_drop\.sql 'destructive'/);
    const applied = (await pool.query(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((r) => r.name);
    expect(applied).toEqual(["001_init.sql", "002_media_jobs_integrity.sql", "003_brand_memory_research.sql"]);
    expect((await pool.query(`SELECT to_regclass('brand_memory') AS t`)).rows[0].t).toBe("brand_memory");
    await pool.end();
  });

  it("içeriği değiştirilmiş kayıtlı geçiş uygulanmaz", async () => {
    const dir = tempMigrations((d) => fs.appendFileSync(path.join(d, "003_brand_memory_research.sql"), "\nCREATE TABLE IF NOT EXISTS extra (id int);\n"));
    expect(policyOf(dir).migrations["003_brand_memory_research.sql"].sha256).not.toBe(sha256(fs.readFileSync(path.join(dir, "003_brand_memory_research.sql"))));
    const pool = await fresh();
    await expect(runMigrations(dir, { pool, enforcePolicy: true, authorizedMigrations: ["003_brand_memory_research.sql"] })).rejects.toThrow(/003_brand_memory_research\.sql içeriği onaylı kayıtla eşleşmiyor/);
    expect((await pool.query(`SELECT to_regclass('extra') AS t`)).rows[0].t).toBeNull();
    await pool.end();
  });

  it("sahip onayı gerektiren geçiş (003) onaysız uygulanmaz; elle Render dağıtımı da canlıya 003 uygulayamaz", async () => {
    const pool = await fresh();
    await expect(runMigrations(REPO, { pool, enforcePolicy: true, authorizedMigrations: [] })).rejects.toThrow(/003_brand_memory_research\.sql canlıya ilk uygulama için sahip onayı gerektirir/);
    const applied = (await pool.query(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((r) => r.name);
    expect(applied).toEqual(["001_init.sql", "002_media_jobs_integrity.sql"]);
    expect((await pool.query(`SELECT to_regclass('brand_memory') AS t`)).rows[0].t).toBeNull();
    // Başka bir geçişin onayı 003'ü açmaz
    await expect(runMigrations(REPO, { pool, enforcePolicy: true, authorizedMigrations: ["004_other.sql"] })).rejects.toThrow(/sahip onayı gerektirir/);
    await pool.end();
  });

  it("onay ortam değişkeninden okunur (virgülle, boşluklar yok sayılır)", () => {
    expect(authorizedMigrationsFromEnv(undefined)).toEqual([]);
    expect(authorizedMigrationsFromEnv(" 003_brand_memory_research.sql , ,004_x.sql")).toEqual(["003_brand_memory_research.sql", "004_x.sql"]);
  });

  it("onaylı geçişler koruma açıkken uygulanır ve ikinci çalıştırma bir şey yapmaz (idempotent)", async () => {
    const pool = await fresh();
    expect(await runMigrations(REPO, { pool, enforcePolicy: true, authorizedMigrations: ["003_brand_memory_research.sql"] })).toEqual(["001_init.sql", "002_media_jobs_integrity.sql", "003_brand_memory_research.sql"]);
    // 003 uygulandıktan sonra onay kaldırılsa da sonraki dağıtımlar takılmaz
    expect(await runMigrations(REPO, { pool, enforcePolicy: true, authorizedMigrations: [] })).toEqual([]);
    await pool.end();
  });
});
