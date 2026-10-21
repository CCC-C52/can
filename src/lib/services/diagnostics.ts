import fs from "node:fs/promises";
import path from "node:path";
import { q, q1 } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { loginRequired } from "@/lib/auth";
import { getStorage } from "@/lib/storage";
import { getSetting, getLimits, isPaused } from "@/lib/settings";
import { textModelMode } from "@/lib/models";
import { PROVIDERS, effectiveStatus, ffmpegAvailable } from "@/lib/services/connections";
import { backupConfigured } from "@/lib/services/backup";
import { checkIntegrity } from "@/lib/db/check";

// Sistem tanılaması (yalnızca oturum açmış sahip). Gizli değer, müşteri içeriği veya dosya adı döndürmez.
// Her bileşen: ok | degraded | down | off (bilerek kapalı / yapılandırılmamış).

export type Health = "ok" | "degraded" | "down" | "off";
export type Component = { id: string; name: string; status: Health; detail: string; ms?: number };

const WORKER_STALE_MS = 60_000;

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string; ms: number }> {
  const t = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - t };
  } catch (err) {
    return { error: (err as Error).name + ": " + (err as Error).message.slice(0, 160), ms: Date.now() - t };
  }
}

export async function collectDiagnostics() {
  const components: Component[] = [];

  // Veritabanı ve geçişler
  const db = await timed(() => q1<{ v: string }>(`SELECT current_setting('server_version') AS v`));
  const migDir = path.resolve(process.cwd(), "migrations");
  const files = (await fs.readdir(migDir).catch(() => [] as string[])).filter((f) => f.endsWith(".sql")).sort();
  const applied = db.error ? [] : (await q<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`)).map((r) => r.name);
  const pending = files.filter((f) => !applied.includes(f));
  components.push({
    id: "database", name: "Veritabanı",
    status: db.error ? "down" : pending.length ? "degraded" : "ok",
    detail: db.error ? db.error : `PostgreSQL ${db.value?.v} · geçişler ${applied.length}/${files.length}${pending.length ? ` · bekleyen: ${pending.join(", ")}` : ""}`,
    ms: db.ms,
  });
  if (db.error) return { generatedAt: new Date().toISOString(), overall: "down" as Health, components, queues: null, durations: [], failures: [], integrity: null, config: configSummary() };

  // Depolama: okuma/yazma denemesi yapılmaz (orijinaller korunur); bağlantı kontrolü
  const st = await timed(() => getStorage().check());
  components.push({ id: "storage", name: `Depolama (${config.storageDriver})`, status: st.error || !st.value?.ok ? "down" : "ok", detail: st.error ?? st.value!.detail, ms: st.ms });

  // İşleyici kalp atışı
  const hb = await q<{ worker_id: string; last_seen: string; info: { active?: number } | null }>(`SELECT worker_id, last_seen, info FROM worker_heartbeats ORDER BY last_seen DESC`);
  const live = hb.filter((h) => Date.now() - new Date(h.last_seen).getTime() < WORKER_STALE_MS);
  const paused = await isPaused();
  components.push({
    id: "worker", name: "Görev işleyicisi",
    status: live.length ? (paused ? "degraded" : "ok") : "down",
    detail: live.length
      ? `${live.length} işleyici canlı · son sinyal ${Math.round((Date.now() - new Date(live[0].last_seen).getTime()) / 1000)} sn önce · aktif görev ${live.reduce((a, h) => a + (h.info?.active ?? 0), 0)}${paused ? " · İŞLEMLER DURAKLATILDI" : ""}`
      : hb.length ? `Son sinyal ${new Date(hb[0].last_seen).toISOString()} — işleyici çalışmıyor` : "Hiç sinyal yok — işleyici başlatılmamış",
  });

  // Metin modeli
  const mode = textModelMode();
  components.push({ id: "text_model", name: "Metin modeli", status: mode.mode === "real" ? "ok" : mode.mode === "demo" ? "degraded" : "off", detail: mode.label });

  // ffmpeg
  const ff = await ffmpegAvailable();
  components.push({ id: "ffmpeg", name: "ffmpeg (video kurgu/analiz)", status: ff.ok ? "ok" : "down", detail: ff.ok ? ff.version ?? "kullanılabilir" : "bulunamadı" });

  // Dış sağlayıcılar (marka kapsamlı olanlar marka ekranında gösterilir)
  for (const p of PROVIDERS.filter((x) => x.scope === "global" && !["ffmpeg", "storage", "anthropic"].includes(x.id))) {
    const s = await effectiveStatus(p.id, null);
    components.push({
      id: `provider:${p.id}`, name: p.name,
      status: s.status === "connected" ? "ok" : s.status === "error" ? "degraded" : "off",
      detail: `${s.status}${s.detail ? ` — ${s.detail.slice(0, 160)}` : ""}`,
    });
  }

  // Yedekleme
  const b = backupConfigured();
  const lastOk = await getSetting<{ at: string } | null>("backup_last_ok", null);
  const ageH = lastOk ? (Date.now() - new Date(lastOk.at).getTime()) / 3_600_000 : null;
  components.push({
    id: "backup", name: "Günlük yedekleme",
    status: !b.ok ? (config.appMode === "production" ? "degraded" : "off") : ageH === null || ageH > 30 ? "degraded" : "ok",
    detail: !b.ok ? b.reason ?? "kapalı" : lastOk ? `son başarılı yedek ${Math.round(ageH!)} saat önce` : "henüz başarılı yedek yok",
  });

  // Kuyruklar
  const [tasks, uploads, analyses, jobs] = await Promise.all([
    q<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM tasks WHERE status IN ('planned','ready','running','review_pending','waiting_connection','approval_pending','failed') GROUP BY status`),
    q<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM upload_sessions WHERE status NOT IN ('completed','aborted') GROUP BY status`),
    q<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM media_analyses WHERE status IN ('queued','running','failed') GROUP BY status`),
    q<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM provider_jobs WHERE status NOT IN ('succeeded','cancelled') GROUP BY status`),
  ]);
  const obj = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const oldestReady = await q1<{ s: number | null }>(`SELECT EXTRACT(EPOCH FROM now() - MIN(updated_at))::int AS s FROM tasks WHERE status = 'ready' AND (next_attempt_at IS NULL OR next_attempt_at <= now())`);
  const queues = { tasks: obj(tasks), uploads: obj(uploads), analyses: obj(analyses), provider_jobs: obj(jobs), oldest_ready_task_s: oldestReady?.s ?? null };
  if ((queues.provider_jobs.unknown ?? 0) > 0) {
    components.push({ id: "provider_jobs", name: "Ücretli üretim işleri", status: "degraded", detail: `${queues.provider_jobs.unknown} işin sonucu bilinmiyor — sahip kararı gerekli` });
  }

  // Son 24 saat görev süreleri (deneme bazında)
  const durations = await q<{ kind: string; agent: string; n: number; p50_s: number; p95_s: number; failed: number }>(
    `SELECT t.kind, t.agent, COUNT(*)::int AS n,
       ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM a.finished_at - a.started_at))::numeric, 1)::float AS p50_s,
       ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM a.finished_at - a.started_at))::numeric, 1)::float AS p95_s,
       COUNT(*) FILTER (WHERE a.outcome = 'failed')::int AS failed
     FROM task_attempts a JOIN tasks t ON t.id = a.task_id
     WHERE a.finished_at IS NOT NULL AND a.started_at > now() - interval '24 hours'
     GROUP BY t.kind, t.agent ORDER BY t.kind, t.agent`,
  );
  const failures = await q<{ id: string; title: string; agent: string; failure_class: string | null; error: string | null; updated_at: string; brand_name: string }>(
    `SELECT t.id, t.title, t.agent, t.failure_class, LEFT(t.error, 240) AS error, t.updated_at, b.name AS brand_name
     FROM tasks t JOIN brands b ON b.id = t.brand_id WHERE t.status = 'failed' ORDER BY t.updated_at DESC LIMIT 10`,
  );
  const integrity = await timed(() => checkIntegrity());
  const integrityIssues = integrity.value ?? null;
  components.push({
    id: "integrity", name: "Veri bütünlüğü",
    status: integrity.error ? "degraded" : integrityIssues!.length ? "degraded" : "ok",
    detail: integrity.error ?? (integrityIssues!.length ? integrityIssues!.map((c) => `${c.description}: ${c.count}`).join("; ") : "tüm kontroller temiz"),
    ms: integrity.ms,
  });

  const rank: Record<Health, number> = { ok: 0, off: 0, degraded: 1, down: 2 };
  const critical = new Set(["database", "storage", "worker"]);
  const worst = components.reduce((a, c) => Math.max(a, critical.has(c.id) ? rank[c.status] : Math.min(1, rank[c.status])), 0);
  const overall: Health = worst === 2 ? "down" : worst === 1 ? "degraded" : "ok";
  return { generatedAt: new Date().toISOString(), overall, components, queues, durations, failures, integrity: integrity.value ?? null, config: { ...configSummary(), limits: await getLimits() } };
}

function configSummary() {
  return {
    appMode: config.appMode,
    loginRequired: loginRequired(),
    demoAllowed: config.demoAllowed,
    storageDriver: config.storageDriver,
    uploadDirect: process.env.UPLOAD_DIRECT === "true",
    maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
    nodeVersion: process.version,
  };
}
