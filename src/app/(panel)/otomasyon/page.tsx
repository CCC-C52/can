import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { AwaitingSetup, Badge, Empty, Flash, PageHeader, Section, dt } from "@/components/ui";
import { Icon } from "@/components/icons";
import { SubmitButton } from "@/components/client";
import { prRunNowAction } from "@/app/actions";
import { getPrConfig, listOperationRuns, OP_MAX_ATTEMPTS } from "@/lib/services/pr-agency";
import { OPERATIONS, scheduleLabel } from "@/lib/pr-agency/operations";
import { specialistById } from "@/lib/pr-agency/specialists";
import { STAGE_LABEL } from "@/lib/orchestrator/verification";

export const metadata = { title: "Otomasyon" };
export const dynamic = "force-dynamic";

const STAGE_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "neutral"> = { completed: "ok", verified: "ok", output_produced: "warn", running: "info", scheduled: "neutral", failed: "bad", skipped: "neutral" };
const STAGE_TR: Record<string, string> = { completed: STAGE_LABEL.completed, verified: STAGE_LABEL.output_verified, output_produced: `${STAGE_LABEL.output_produced} (kanıt bekliyor)`, running: STAGE_LABEL.execution_started, scheduled: STAGE_LABEL.task_scheduled, failed: STAGE_LABEL.failed, skipped: "Atlandı" };

export default async function AutomationPage({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const [cfg, runs] = await Promise.all([getPrConfig(brand.id), listOperationRuns(brand.id, 40)]);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Sistem" title="Otomasyon" subtitle="Görev işleyicisi (Render worker) zamanlanmış PR operasyonlarını dönem başına bir kez yürütür. Her çalıştırma kanıtla kaydedilir: rapor kaydedilip doğrulanmadan “tamamlandı” sayılmaz. Başarısız işler artan bekleme süresiyle yeniden denenir. Dış yayın, mesaj, satın alma ve ücretli üretim yapılmaz."
        actions={<><Link href="/pr-ajansi?tab=automation" className="btn"><Icon name="cog" />Zamanlama ve kaynaklar</Link><form action={prRunNowAction}><SubmitButton className="btn-primary" pendingText="Çalışıyor…">Vadesi gelenleri şimdi çalıştır</SubmitButton></form></>} />
      <Flash ok={ok} err={err} />
      {!cfg.enabled && (
        <AwaitingSetup title="Zamanlanmış üretim kapalı" href="/pr-ajansi?tab=automation" linkLabel="Zamanlamayı aç">İşleyici komut beklemeden çalışsın diye PR Ajansı → Otomasyon bölümünden bir kez açın. Kapalıyken yalnızca “şimdi çalıştır” ile üretim yapılır.</AwaitingSetup>
      )}

      <Section id="ops" title="Sürekli PR operasyonları" eyebrow={cfg.enabled ? "Zamanlama açık" : "Zamanlama kapalı"}>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Operasyon takvimi">
          <table className="w-full min-w-[44rem] text-sm">
            <thead><tr className="text-left text-xs text-muted"><th className="py-2 pr-3">Sıklık</th><th className="pr-3">Kapsam</th><th className="pr-3">Sorumlu</th><th className="pr-3">Zamanlama</th><th>Son çalıştırma</th></tr></thead>
            <tbody>
              {OPERATIONS.map((o) => {
                const last = runs.find((r) => r.operation === o.kind);
                return (
                  <tr key={o.kind} className="border-t border-line align-top">
                    <td className="py-3 pr-3 font-medium">{o.cadence}</td>
                    <td className="pr-3 text-ink-soft">{o.covers.join(" · ")}</td>
                    <td className="pr-3 text-ink-soft">{specialistById(o.owner)?.titleTr}</td>
                    <td className="pr-3 text-xs text-muted">{scheduleLabel(o.kind)}</td>
                    <td className="text-xs">{last ? <><Badge tone={STAGE_TONE[last.stage] ?? "neutral"}>{STAGE_TR[last.stage] ?? last.stage}</Badge><div className="mt-1 text-muted">{last.period_key} · {dt(last.finished_at ?? last.created_at)}</div></> : <span className="text-muted">Henüz yok</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="ledger" title="Çalıştırma kaydı ve kanıtlar" eyebrow="Dönem başına tek kayıt (idempotent)">
        {runs.length === 0 ? <Empty icon="bolt">Henüz zamanlanmış çalıştırma yok.</Empty> : (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Çalıştırma kaydı">
            <table className="w-full min-w-[44rem] text-sm">
              <thead><tr className="text-left text-xs text-muted"><th className="py-2 pr-3">Operasyon</th><th className="pr-3">Dönem</th><th className="pr-3">Aşama</th><th className="pr-3">Kanıt</th><th className="pr-3">Deneme</th><th>Hata / sonraki deneme</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">{OPERATIONS.find((o) => o.kind === r.operation)?.cadence ?? r.operation}</td>
                    <td className="pr-3 text-xs">{r.period_key}</td>
                    <td className="pr-3"><Badge tone={STAGE_TONE[r.stage] ?? "neutral"}>{STAGE_TR[r.stage] ?? r.stage}</Badge></td>
                    <td className="pr-3 text-xs">{r.output_id ? <Link href={`/taslaklar/${r.output_id}`} className="link">Kaydedilmiş rapor{r.evidence?.savedVersions ? ` (v${r.evidence.savedVersions})` : ""}</Link> : "—"}</td>
                    <td className="pr-3 text-xs">{r.attempts}/{OP_MAX_ATTEMPTS}</td>
                    <td className="text-xs">{r.error ? <span className="text-danger">{r.error}</span> : "—"}{r.next_attempt_at ? <div className="text-muted">Sonraki deneme: {dt(r.next_attempt_at)}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="system" title="Diğer arka plan işleri" eyebrow="Görev işleyicisi">
        <ul className="grid gap-3 text-sm md:grid-cols-2">
          <li className="rounded-xl bg-surface-2 p-3"><div className="font-medium">Görev motoru</div><p className="text-xs text-muted">Plan → iş → kalite kontrol → render → rapor; kiralama, yeniden deneme ve zaman aşımı ile. <Link href="/gorevler" className="link">Görev panosu</Link></p></li>
          <li className="rounded-xl bg-surface-2 p-3"><div className="font-medium">Drive arşivi taraması ve orijinal içe alma</div><p className="text-xs text-muted">Salt okunur tarama; onaylı ürün görsellerinin orijinalleri arka planda alınır. <Link href="/drive-arsivi" className="link">Drive Arşivi</Link></p></li>
          <li className="rounded-xl bg-surface-2 p-3"><div className="font-medium">Medya doğrulama ve analiz</div><p className="text-xs text-muted">Yüklenen dosyalar içerikten doğrulanır; video teslimatları gerçek, oynatılabilir MP4 olmadan tamamlanmaz.</p></li>
          <li className="rounded-xl bg-surface-2 p-3"><div className="font-medium">Yedekleme ve sağlayıcı iş mutabakatı</div><p className="text-xs text-muted">Zamanlanmış yedek; sonucu belirsiz kalan ücretli işler “bilinmiyor” olarak işaretlenir. <Link href="/tanilama" className="link">Sistem Durumu</Link></p></li>
        </ul>
      </Section>
    </div>
  );
}
