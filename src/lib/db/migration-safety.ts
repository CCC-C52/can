import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Geçiş güvenlik politikası. Hem CI/dağıtım kapısı hem de üretimde geçiş uygulayan kod (runMigrations) kullanır.
//
// Sınıflar:
//  - additive    : yalnızca yeni nesne ekler (IF NOT EXISTS ile tablo/indeks, boş bırakılabilir sütun, NOT VALID kısıt).
//                  Mevcut veri ve eski uygulama sürümü etkilenmez. Politika uygunsa otomatik dağıtılabilir.
//  - review      : veriyi değiştirebilen veya davranışı değiştiren ama yıkıcı olmayan ifadeler (UPDATE, DO bloğu,
//                  fonksiyon/tetikleyici değişikliği, INSERT, NOT NULL ekleme…). İnsan incelemesi ve politika kaydı gerekir.
//  - destructive : veri veya yapı kaybı ya da eski sürümü bozan değişiklik (DROP TABLE/COLUMN, TRUNCATE, DELETE,
//                  sütun türü değişikliği, yeniden adlandırma). Otomatik dağıtımda HİÇBİR ZAMAN uygulanmaz.

export type MigrationClass = "additive" | "review" | "destructive";
export type Finding = { severity: "review" | "destructive"; rule: string; statement: string };

export type PolicyEntry = {
  sha256: string;
  /** baseline: ilk şema; reviewed: insan incelemesinden geçmiş (canlıda uygulanmış); additive: sınıflandırıcıyla doğrulanmış. */
  class: "baseline" | "reviewed" | "additive";
  /** Canlıya ilk kez uygulanırken sahibin bir kerelik açık onayı gerekir (onay dağıtım iş akışına girdi olarak verilir). */
  firstProductionRollout?: "requires_owner_authorization";
  note?: string;
};
export type MigrationPolicy = { version: 1; migrations: Record<string, PolicyEntry> };

export const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

export function sha256(text: string | Buffer) {
  return createHash("sha256").update(text).digest("hex");
}

/** Yorumları kaldırır; metin sabitlerini ve $$ gövdelerini maskeler (içlerindeki kelimeler ifade sayılmasın). */
export function maskSql(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += "''";
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        // Gövde içeriği ayrıca işaretlenir: dolar gövdeli kod (fonksiyon/DO) her zaman insan incelemesi ister
        out += " $BODY$ ";
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

export function splitStatements(masked: string): string[] {
  return masked.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const RULES: { re: RegExp; severity: Finding["severity"]; rule: string }[] = [
  { re: /^DROP\s+(TABLE|SCHEMA|DATABASE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|DOMAIN|EXTENSION)\b/i, severity: "destructive", rule: "drop_object" },
  // ALTER TABLE … DROP [COLUMN] [IF EXISTS] x  (DROP CONSTRAINT / DEFAULT / NOT NULL ayrı değerlendirilir)
  { re: /^ALTER\s+TABLE\b.*\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b)/i, severity: "destructive", rule: "drop_column" },
  { re: /^TRUNCATE\b/i, severity: "destructive", rule: "truncate" },
  { re: /^DELETE\s+FROM\b/i, severity: "destructive", rule: "delete_rows" },
  { re: /^ALTER\s+TABLE\b.*\bALTER\s+(COLUMN\s+)?\w+\s+(SET\s+DATA\s+)?TYPE\b/i, severity: "destructive", rule: "change_column_type" },
  { re: /^ALTER\s+(TABLE|INDEX|SEQUENCE|VIEW|TYPE|SCHEMA)\b.*\bRENAME\b/i, severity: "destructive", rule: "rename" },
  { re: /^(WITH\b.*\b)?UPDATE\b/i, severity: "review", rule: "update_rows" },
  { re: /^INSERT\s+INTO\b/i, severity: "review", rule: "insert_rows" },
  { re: /^DO\b/i, severity: "review", rule: "anonymous_code_block" },
  { re: /^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|TRIGGER|RULE|VIEW)\b/i, severity: "review", rule: "code_or_view" },
  { re: /^DROP\s+(INDEX|TRIGGER|FUNCTION|PROCEDURE|RULE|POLICY)\b/i, severity: "review", rule: "drop_non_data_object" },
  { re: /^ALTER\s+TABLE\b.*\bDROP\s+CONSTRAINT\b/i, severity: "review", rule: "drop_constraint" },
  { re: /^ALTER\s+TABLE\b.*\bSET\s+NOT\s+NULL\b/i, severity: "review", rule: "set_not_null" },
  { re: /^ALTER\s+TABLE\b.*\bVALIDATE\s+CONSTRAINT\b/i, severity: "review", rule: "validate_constraint_full_scan" },
  { re: /^(GRANT|REVOKE|CREATE\s+ROLE|ALTER\s+ROLE|DROP\s+ROLE|CREATE\s+EXTENSION|ALTER\s+SYSTEM|VACUUM|CLUSTER|REINDEX|LOCK)\b/i, severity: "review", rule: "privileged_or_maintenance" },
  { re: /^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i, severity: "review", rule: "concurrent_index_in_transaction" },
];

/** İzin verilen ekleme ifadeleri (ilk eşleşen kural yoksa bu kalıplardan birine uymalı). */
const ADDITIVE: { re: RegExp; check?: (s: string) => string | null }[] = [
  { re: /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i },
  { re: /^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i },
  { re: /^CREATE\s+SEQUENCE\s+IF\s+NOT\s+EXISTS\b/i },
  { re: /^COMMENT\s+ON\b/i },
  {
    re: /^ALTER\s+TABLE\b.*\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i,
    // Varsayılansız NOT NULL sütun mevcut satırlarda başarısız olur
    check: (s) => (/\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s) ? "not_null_column_without_default" : null),
  },
  {
    re: /^ALTER\s+TABLE\b.*\bADD\s+CONSTRAINT\b/i,
    // Mevcut satırları doğrulayan kısıt (NOT VALID olmadan) eski veride başarısız olabilir ve tabloyu kilitler
    check: (s) => (/\b(UNIQUE|PRIMARY\s+KEY|EXCLUDE)\b/i.test(s) || (/\b(CHECK|FOREIGN\s+KEY)\b/i.test(s) && !/\bNOT\s+VALID\b/i.test(s)) ? "constraint_validates_existing_rows" : null),
  },
];

export function classifySql(sql: string): { class: MigrationClass; findings: Finding[] } {
  const findings: Finding[] = [];
  for (const stmt of splitStatements(maskSql(sql))) {
    const short = stmt.slice(0, 160);
    const hit = RULES.find((r) => r.re.test(stmt));
    if (hit) {
      findings.push({ severity: hit.severity, rule: hit.rule, statement: short });
      continue;
    }
    const add = ADDITIVE.find((a) => a.re.test(stmt));
    if (!add) {
      findings.push({ severity: "review", rule: "unrecognised_statement", statement: short });
      continue;
    }
    const problem = add.check?.(stmt);
    if (problem) findings.push({ severity: "review", rule: problem, statement: short });
  }
  const cls: MigrationClass = findings.some((f) => f.severity === "destructive") ? "destructive" : findings.length ? "review" : "additive";
  return { class: cls, findings };
}

export function loadPolicy(dir: string): MigrationPolicy {
  const file = path.join(dir, "policy.json");
  if (!fs.existsSync(file)) throw new Error("migrations/policy.json bulunamadı.");
  const p = JSON.parse(fs.readFileSync(file, "utf8")) as MigrationPolicy;
  if (p.version !== 1 || typeof p.migrations !== "object") throw new Error("migrations/policy.json biçimi geçersiz.");
  return p;
}

export type MigrationFile = { name: string; sha256: string; sql: string };

export function readMigrations(dir: string): MigrationFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), "utf8");
      return { name, sha256: sha256(sql), sql };
    });
}

export type PolicyCheck = {
  ok: boolean;
  errors: string[];
  migrations: { name: string; class: MigrationClass; policy: PolicyEntry["class"] | "none"; autoApprovable: boolean; requiresAuthorization: boolean; findings: Finding[] }[];
};

/**
 * Depo düzeyi denetim (CI): geçiş geçmişi değişmemiş mi, her dosya politikaya uygun mu.
 *  - Politikadaki dosyanın içeriği değişmişse (sha256) → hata (uygulanmış geçişler değiştirilemez).
 *  - Politikadaki dosya silinmişse → hata (geçmiş korunur).
 *  - Politikada olmayan yeni dosya yalnızca "additive" ise kabul edilir (otomatik onaylanabilir);
 *    değilse insan incelemesi ve politika kaydı gerekir.
 *  - "additive" olarak kayıtlı dosyanın sınıflandırması gerçekten additive olmalı.
 */
export function checkPolicy(dir: string): PolicyCheck {
  const policy = loadPolicy(dir);
  const files = readMigrations(dir);
  const errors: string[] = [];
  const seenNumbers = new Set<string>();
  const out: PolicyCheck["migrations"] = [];
  for (const f of files) {
    if (!MIGRATION_NAME.test(f.name)) errors.push(`${f.name}: ad biçimi NNN_ad.sql olmalı.`);
    const num = f.name.slice(0, 3);
    if (seenNumbers.has(num)) errors.push(`${f.name}: aynı numaralı ikinci geçiş.`);
    seenNumbers.add(num);
    const entry = policy.migrations[f.name];
    const c = classifySql(f.sql);
    if (entry) {
      if (entry.sha256 !== f.sha256) errors.push(`${f.name}: içerik politika kaydıyla eşleşmiyor (uygulanmış geçişler değiştirilemez; yeni bir geçiş dosyası ekleyin).`);
      if (entry.class === "additive" && c.class !== "additive") errors.push(`${f.name}: politikada 'additive' ama sınıflandırma '${c.class}'.`);
    } else if (c.class !== "additive") {
      errors.push(`${f.name}: politikada kaydı yok ve sınıflandırma '${c.class}' — otomatik dağıtılamaz; inceleme ve migrations/policy.json kaydı gerekir.`);
    }
    out.push({
      name: f.name,
      class: c.class,
      policy: entry?.class ?? "none",
      autoApprovable: (entry ? entry.sha256 === f.sha256 : true) && (entry?.class === "baseline" || entry?.class === "reviewed" || c.class === "additive") && !entry?.firstProductionRollout,
      requiresAuthorization: entry?.firstProductionRollout === "requires_owner_authorization",
      findings: c.findings,
    });
  }
  for (const name of Object.keys(policy.migrations)) {
    if (!files.some((f) => f.name === name)) errors.push(`${name}: politikada var ama dosya yok (geçiş geçmişi silinemez).`);
  }
  return { ok: errors.length === 0, errors, migrations: out };
}

export type PendingDecision = {
  allowed: boolean;
  pending: string[];
  blocked: { name: string; reason: string }[];
  authorizedUsed: string[];
};

/**
 * Dağıtım kapısı: canlıda bekleyen geçişler uygulanabilir mi?
 *  - yıkıcı veya politikaya aykırı → engel
 *  - ilk canlı uygulaması sahip onayı gerektiren geçiş → `authorized` listesinde adıyla yer almıyorsa engel
 *  - canlıda uygulanmış ama depoda olmayan geçiş → engel (eski kodu yeni şemaya dağıtma riski)
 */
export function evaluatePending(dir: string, appliedInProduction: string[], authorized: string[]): PendingDecision {
  const check = checkPolicy(dir);
  const repo = check.migrations.map((m) => m.name);
  const blocked: PendingDecision["blocked"] = check.errors.map((e) => ({ name: e.split(":")[0], reason: e }));
  for (const a of appliedInProduction) {
    if (!repo.includes(a)) blocked.push({ name: a, reason: `${a}: canlıda uygulanmış ama bu sürümde yok (sürüm canlı şemadan eski).` });
  }
  const pending = repo.filter((n) => !appliedInProduction.includes(n));
  const authorizedUsed: string[] = [];
  for (const name of pending) {
    const m = check.migrations.find((x) => x.name === name)!;
    if (m.class === "destructive" && m.policy !== "baseline" && m.policy !== "reviewed") {
      blocked.push({ name, reason: `${name}: yıkıcı geçiş otomatik uygulanmaz.` });
      continue;
    }
    if (m.requiresAuthorization || m.policy === "reviewed" || m.policy === "baseline") {
      if (authorized.includes(name)) authorizedUsed.push(name);
      else blocked.push({ name, reason: `${name}: canlıya ilk uygulaması sahibin bir kerelik açık onayını gerektirir (authorize_migrations).` });
      continue;
    }
    if (!m.autoApprovable) blocked.push({ name, reason: `${name}: otomatik onay politikasına uymuyor.` });
  }
  return { allowed: blocked.length === 0, pending, blocked, authorizedUsed };
}
