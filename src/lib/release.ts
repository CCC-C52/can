import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { q, q1, tx } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { redact } from "@/lib/security/crypto";
import { getSetting } from "@/lib/settings";

// Sürüm (release) gözlemlenebilirliği.
//  - Çalışan kodun commit'i: Render her dağıtımda RENDER_GIT_COMMIT ortam değişkenini verir (yerelde AIOPS_RELEASE_COMMIT).
//  - İşleyici kalp atışına kendi commit'ini yazar; dağıtım hattı web ve işleyicinin AYNI commit'te olduğunu buradan doğrular.
//  - Dağıtım hattının olayları (başladı, web canlı, işleyici canlı, başarı/başarısızlık) settings tablosunda saklanır
//    ve Sistem Durumu sayfasında gösterilir. Kayıtlar yalnızca hattın gerçekten bildirdiği olaylardır.
//  - /api/release/* uçları oturum değil RELEASE_STATUS_TOKEN ile korunur; belirteç tanımlı değilse uçlar kapalıdır (404).

const HISTORY_KEY = "release_history";
const MAX_RELEASES = 30;
const MAX_STEPS = 40;

export function releaseCommit(): string | null {
  const v = process.env.RENDER_GIT_COMMIT ?? process.env.AIOPS_RELEASE_COMMIT ?? null;
  return v && /^[0-9a-f]{7,40}$/i.test(v) ? v.toLowerCase() : null;
}

function releaseToken(): string | null {
  const t = process.env.RELEASE_STATUS_TOKEN;
  return t && t.length >= 32 ? t : null;
}

export function releaseApiEnabled() {
  return releaseToken() !== null;
}

/** Sabit süreli karşılaştırma ("Bearer <belirteç>"). */
export function releaseTokenValid(authorization: string | null): boolean {
  const expected = releaseToken();
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const a = crypto.createHash("sha256").update(authorization.slice(7)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export const RELEASE_PHASES = ["started", "blocked", "web_deploying", "web_live", "web_verified", "worker_deploying", "worker_live", "worker_verified", "succeeded", "failed", "rollback_started", "rolled_back", "rollback_failed"] as const;
export const ReleaseEventSchema = z.object({
  releaseId: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  phase: z.enum(RELEASE_PHASES),
  detail: z.string().max(1000).optional(),
  ciUrl: z.string().max(300).regex(/^https:\/\/github\.com\/[A-Za-z0-9._/-]+$/).optional(),
  webDeployId: z.string().regex(/^dep-[a-z0-9]+$/).optional(),
  workerDeployId: z.string().regex(/^dep-[a-z0-9]+$/).optional(),
  migrations: z.array(z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/)).max(50).optional(),
});
export type ReleaseEvent = z.infer<typeof ReleaseEventSchema>;

export type ReleaseRecord = {
  releaseId: string;
  sha: string;
  startedAt: string;
  updatedAt: string;
  outcome: "in_progress" | "succeeded" | "failed" | "blocked" | "rolled_back";
  ciUrl?: string;
  webDeployId?: string;
  workerDeployId?: string;
  migrations?: string[];
  steps: { phase: ReleaseEvent["phase"]; at: string; detail?: string }[];
};

const OUTCOME: Partial<Record<ReleaseEvent["phase"], ReleaseRecord["outcome"]>> = {
  succeeded: "succeeded",
  failed: "failed",
  blocked: "blocked",
  rolled_back: "rolled_back",
  rollback_failed: "failed",
};

export async function recordReleaseEvent(e: ReleaseEvent): Promise<ReleaseRecord> {
  const now = new Date().toISOString();
  return tx(async (c) => {
    await q(`INSERT INTO settings (key, value) VALUES ($1, '[]'::jsonb) ON CONFLICT (key) DO NOTHING`, [HISTORY_KEY], c);
    const row = await q1<{ value: ReleaseRecord[] }>(`SELECT value FROM settings WHERE key = $1 FOR UPDATE`, [HISTORY_KEY], c);
    const list = Array.isArray(row?.value) ? row!.value : [];
    let rec = list.find((r) => r.releaseId === e.releaseId);
    if (rec && rec.sha !== e.sha) throw new Error("Aynı sürüm kimliği farklı commit ile bildirilemez.");
    if (!rec) {
      rec = { releaseId: e.releaseId, sha: e.sha, startedAt: now, updatedAt: now, outcome: "in_progress", steps: [] };
      list.unshift(rec);
    }
    rec.updatedAt = now;
    if (e.ciUrl) rec.ciUrl = e.ciUrl;
    if (e.webDeployId) rec.webDeployId = e.webDeployId;
    if (e.workerDeployId) rec.workerDeployId = e.workerDeployId;
    if (e.migrations) rec.migrations = e.migrations;
    rec.outcome = OUTCOME[e.phase] ?? rec.outcome;
    rec.steps = [...rec.steps, { phase: e.phase, at: now, ...(e.detail ? { detail: redact(e.detail).slice(0, 1000) } : {}) }].slice(-MAX_STEPS);
    await q(`UPDATE settings SET value = $2, updated_at = now() WHERE key = $1`, [HISTORY_KEY, JSON.stringify(list.slice(0, MAX_RELEASES))], c);
    return rec;
  });
}

export async function releaseHistory(limit = 10): Promise<ReleaseRecord[]> {
  const list = await getSetting<ReleaseRecord[]>(HISTORY_KEY, []);
  return Array.isArray(list) ? list.slice(0, limit) : [];
}

export const WORKER_LIVE_MS = 90_000;

/** Dağıtım hattının doğrulama verisi. Gizli değer, kişisel veri veya müşteri içeriği içermez. */
export async function releaseStatus() {
  const started = Date.now();
  const generatedAt = new Date().toISOString();
  const base = { service: "web" as const, commit: releaseCommit(), appMode: config.appMode, generatedAt };
  try {
    await q1(`SELECT 1`);
  } catch {
    return { ...base, ok: false as const, db: { ok: false, ms: Date.now() - started } };
  }
  const dbMs = Date.now() - started;
  const inImage = (await fs.readdir(path.resolve(process.cwd(), "migrations")).catch(() => [] as string[])).filter((f) => f.endsWith(".sql")).sort();
  const applied = (await q<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`).catch(() => [])).map((r) => r.name);
  const workers = await q<{ last_seen: string; started_at: string; info: { active?: number; commit?: string | null } | null }>(
    `SELECT last_seen, started_at, info FROM worker_heartbeats ORDER BY last_seen DESC LIMIT 10`,
  );
  const backupLastOk = await getSetting<{ at: string; dbBytes?: number } | null>("backup_last_ok", null);
  const backupLast = await getSetting<{ at: string; ok: boolean } | null>("backup_status", null);
  const paused = await getSetting<boolean>("paused", false);
  return {
    ...base,
    ok: true as const,
    db: { ok: true, ms: dbMs },
    migrations: { applied, inImage, pending: inImage.filter((f) => !applied.includes(f)) },
    workers: workers.map((w) => ({
      commit: w.info?.commit ?? null,
      ageSeconds: Math.round((Date.now() - new Date(w.last_seen).getTime()) / 1000),
      live: Date.now() - new Date(w.last_seen).getTime() < WORKER_LIVE_MS,
      startedAt: w.started_at,
      active: w.info?.active ?? 0,
    })),
    paused,
    backup: {
      lastOk: backupLastOk ? { at: backupLastOk.at, dbBytes: backupLastOk.dbBytes ?? null } : null,
      last: backupLast ? { at: backupLast.at, ok: backupLast.ok } : null,
    },
    releases: (await releaseHistory(10)).map((r) => ({ releaseId: r.releaseId, sha: r.sha, outcome: r.outcome, startedAt: r.startedAt, updatedAt: r.updatedAt })),
  };
}
