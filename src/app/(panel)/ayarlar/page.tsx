import { flash, getCurrentBrand, type SP } from "@/lib/current";
import { getLimits, isPaused } from "@/lib/settings";
import { q } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { textModelMode } from "@/lib/models";
import { loginRequired } from "@/lib/auth";
import { pauseAction, requestBackupAction, saveLimitsAction } from "@/app/actions";
import { backupConfigured, type BackupStatus } from "@/lib/services/backup";
import { getSetting } from "@/lib/settings";
import { Flash, PageHeader, dt } from "@/components/ui";
import { SubmitButton } from "@/components/client";

export default async function Settings({ searchParams }: { searchParams: SP }) {
  const { ok, err, one } = await flash(searchParams);
  const { brand } = await getCurrentBrand();
  const [limits, paused] = await Promise.all([getLimits(), isPaused()]);
  const scope = one("scope") === "all" ? "all" : "brand";
  const logs = await q<{ id: number; actor: string; action: string; message: string; created_at: string; brand_id: string | null }>(
    scope === "all" || !brand ? `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200` : `SELECT * FROM audit_log WHERE brand_id = $1 OR brand_id IS NULL ORDER BY created_at DESC LIMIT 200`,
    scope === "all" || !brand ? [] : [brand.id],
  );
  const backupCfg = backupConfigured();
  const [backupLast, backupOk] = await Promise.all([getSetting<BackupStatus | null>("backup_status", null), getSetting<BackupStatus | null>("backup_last_ok", null)]);
  const workers = await q<{ worker_id: string; last_seen: string; info: any }>(`SELECT * FROM worker_heartbeats ORDER BY last_seen DESC`);
  const num = (name: string, label: string, value: number, hint?: string) => (
    <label className="block"><span className="label">{label}</span><input name={name} type="number" defaultValue={value} className="input" />{hint && <span className="text-xs text-muted">{hint}</span>}</label>
  );
  return (
    <div>
      <PageHeader title="Ayarlar ve işlem geçmişi" />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card lg:col-span-2">
          <h2 className="h2 mb-3">Sınırlar (sonsuz döngü ve harcama koruması)</h2>
          <form action={saveLimitsAction} className="grid gap-3 sm:grid-cols-2">
            {num("maxConcurrentTasks", "Eşzamanlı görev", limits.maxConcurrentTasks)}
            {num("maxTasksPerProject", "Proje başına en fazla görev", limits.maxTasksPerProject)}
            {num("maxModelCallsPerProject", "Proje başına model çağrısı", limits.maxModelCallsPerProject)}
            {num("taskTimeoutMs", "Görev süre sınırı (ms)", limits.taskTimeoutMs)}
            {num("maxAttempts", "Geçici hatada en fazla deneme", limits.maxAttempts)}
            {num("maxRegenerations", "Çıktı başına yeniden üretim", limits.maxRegenerations)}
            <label className="block"><span className="label">Görev başına bütçe (USD, boş = sınırsız)</span><input name="perTaskBudgetUsd" defaultValue={limits.perTaskBudgetUsd ?? ""} className="input" /></label>
            <label className="block"><span className="label">Günlük AI bütçesi (USD, boş = sınırsız)</span><input name="dailyBudgetUsd" defaultValue={limits.dailyBudgetUsd ?? ""} className="input" /></label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="blockUnknownCost" defaultChecked={limits.blockUnknownCost} /> Maliyeti tahmin edilemeyen ücretli işlemleri engelle (bütçe sınırı varken)</label>
            <div className="sm:col-span-2"><SubmitButton>Kaydet</SubmitButton></div>
          </form>
        </section>
        <section className="card space-y-3 text-sm">
          <h2 className="h2">Sistem</h2>
          <ul className="space-y-1 text-xs">
            <li>Model modu: <strong>{textModelMode().label}</strong></li>
            <li>Uygulama modu: <strong>{config.appMode}</strong> · giriş {loginRequired() ? "zorunlu" : "kapalı (yerel demo)"}</li>
            <li>Depolama: {config.storageDriver}{config.storageDriver === "s3" ? ` (${config.s3.bucket})` : ""}</li>
            <li>DEMO üretici: {config.demoAllowed ? "açık (yerel)" : "kapalı (canlı)"}</li>
          </ul>
          <form action={pauseAction}><input type="hidden" name="paused" value={paused ? "false" : "true"} /><input type="hidden" name="back" value="/ayarlar" /><SubmitButton className={paused ? "btn" : "btn-danger"} confirm={paused ? undefined : "Tüm işlemler durdurulsun mu?"}>{paused ? "İşlemleri devam ettir" : "Tüm işlemleri durdur"}</SubmitButton></form>
          <div><div className="label">Yedekleme</div>
            {backupCfg.ok ? (
              <ul className="text-xs">
                <li>Günlük, UTC {config.backup.hourUtc}:00 sonrası · {config.backup.retentionDays} gün saklama · kova: {config.backup.bucket}</li>
                <li>Son başarılı: {backupOk ? `${dt(backupOk.at)} (${((backupOk.dbBytes ?? 0) / 1024).toFixed(0)} KB, ${backupOk.mediaCopied ?? 0} dosya)` : "henüz yok"}</li>
                {backupLast && !backupLast.ok && <li className="text-red-700">Son deneme başarısız ({dt(backupLast.at)}): {backupLast.error}</li>}
              </ul>
            ) : <p className="text-xs text-amber-800">Kapalı — {backupCfg.reason}</p>}
            <form action={requestBackupAction} className="mt-1"><SubmitButton className="btn px-2 py-1 text-xs" disabled={!backupCfg.ok}>Şimdi yedekle</SubmitButton></form>
          </div>
          <div><div className="label">İşleyiciler</div>
            <ul className="text-xs">{workers.map((w) => <li key={w.worker_id}>{w.worker_id} · son sinyal {dt(w.last_seen)} · aktif {w.info?.active ?? 0}</li>)}{workers.length === 0 && <li className="text-amber-700">Çalışan işleyici yok.</li>}</ul></div>
        </section>
        <section className="card lg:col-span-3">
          <div className="mb-2 flex items-center justify-between"><h2 className="h2">İşlem geçmişi</h2>
            <div className="flex gap-2 text-xs"><a href="/ayarlar" className={scope === "brand" ? "font-semibold" : "text-brand"}>Bu marka</a><a href="/ayarlar?scope=all" className={scope === "all" ? "font-semibold" : "text-brand"}>Tümü</a></div></div>
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto text-sm">
            {logs.map((l) => <li key={l.id}><span className="text-xs text-muted">{dt(l.created_at)} · {l.actor} · {l.action}</span> — {l.message}</li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
