import Link from "next/link";
import { q } from "@/lib/db/pool";
import type { Limits } from "@/lib/settings";
import { PROVIDER_JOB_STATUS_LABEL } from "@/lib/labels";
import { VIDEO_PROVIDER_NAME, providerOfService, type VideoProviderStatus } from "@/lib/video/providers";
import { estimatePlanCost, pendingProductionApprovals } from "@/lib/video/production";
import { approveProductionAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, dt, usd } from "@/components/ui";

// Video üretimi panelleri (Video Stüdyosu, proje sayfası, PR Ajansı): sağlayıcı durumu, üretim onayı, sahne ilerlemesi ve
// oynatılabilir son MP4. Anahtar değerleri hiçbir yerde gösterilmez.

export function ProviderCards({ statuses, limits }: { statuses: VideoProviderStatus[]; limits: Limits }) {
  return (
    <section className="card h-fit" aria-labelledby="providers-h">
      <h2 id="providers-h" className="h2 mb-2">AI video sağlayıcıları</h2>
      <ul className="space-y-3 text-sm">
        {statuses.map((s) => (
          <li key={s.id} className="rounded-lg bg-surface-2 p-2">
            <div className="flex flex-wrap items-center gap-1">
              <Badge tone={s.role === "primary" ? "info" : "neutral"}>{s.role === "primary" ? "Birincil" : "İkincil"}</Badge>
              <strong>{s.name}</strong>
              <Badge tone={s.ready ? "ok" : "bad"}>{s.ready ? "Hazır" : "Hazır değil"}</Badge>
            </div>
            <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-2 text-xs">
              <dt className="text-muted">Model</dt><dd>{s.model ?? "—"}</dd>
              <dt className="text-muted">Bağlantı</dt><dd>{s.connected ? `Bağlı${s.keySource === "integration" ? " (Entegrasyon Merkezi)" : s.keySource === "env" ? " (sunucu ortamı)" : ""}` : s.keyConfigured ? "Anahtar var, doğrulanmadı" : "Anahtar yok"}</dd>
              <dt className="text-muted">Fiyat</dt><dd>{s.usdPerSecond !== null ? `${usd(s.usdPerSecond)} / sn · 5 sn sahne ≈ ${usd(s.usdPerSecond * 5, 2)}` : "Girilmedi (ücretli üretim engelli)"}</dd>
            </dl>
            {!s.ready && <p className="mt-1 text-xs text-warning">{s.reason}</p>}
          </li>
        ))}
      </ul>
      {!limits.paidMediaGeneration && <p className="mt-2 text-xs text-warning">Ücretli AI medya üretimi Ayarlar&apos;da kapalı: hiçbir sağlayıcıya istek gönderilmez.</p>}
      <p className="mt-2 text-xs text-muted">
        Birincil kullanılamıyorsa sahne gönderilmeden önce ikincil seçilir. Gönderilmiş, başarısız veya sonucu belirsiz bir sahne diğer sağlayıcıya kendiliğinden gitmez: ek ücret doğurabileceği için çıktı sayfasındaki &quot;Yeniden gönder&quot; kararınızla gider.
        {" "}<Link href="/ayarlar" className="text-brand underline">Ayarlar</Link> · <Link href="/entegrasyonlar" className="text-brand underline">Entegrasyonlar</Link>
      </p>
    </section>
  );
}

/** Sahip üretim onayı bekleyen video render görevleri: sahne başına tahmin ve onay düğmesi. */
export async function ProductionApprovals({ brandId, limits, back, projectId }: { brandId: string; limits: Limits; back: string; projectId?: string }) {
  const pending = (await pendingProductionApprovals(brandId)).filter((t) => !projectId || t.project_id === projectId);
  if (!pending.length) return null;
  const rows = await Promise.all(pending.map(async (t) => {
    const v = await q<{ content: any }>(`SELECT content FROM output_versions WHERE id = $1 AND brand_id = $2`, [t.input_refs?.version_id, brandId]);
    return { t, est: v[0] ? await estimatePlanCost(brandId, v[0].content, limits) : null };
  }));
  return (
    <section className="card mb-4 border border-warning-line" aria-labelledby="prod-approval-h">
      <h2 id="prod-approval-h" className="h2 mb-1">Üretim onayı bekleyen video kampanyaları</h2>
      <p className="mb-2 text-xs text-muted">Video planı hazır ve kalite kontrolünden geçti. Onay vermeden hiçbir ücretli AI video isteği gönderilmez. Onay bu plan sürümü içindir.</p>
      <ul className="space-y-3 text-sm">
        {rows.map(({ t, est }) => (
          <li key={t.id} className="rounded-lg bg-surface-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Link href={`/projeler/${t.project_id}`} className="font-medium text-brand">{t.project_title}</Link>
              <span className="text-xs text-muted">{dt(t.created_at)}</span>
            </div>
            {est && est.scenes.length > 0 ? (
              <table className="table mt-2 text-xs">
                <thead><tr><th>Sahne</th><th>Sağlayıcı</th><th>Süre</th><th>Tahmini</th></tr></thead>
                <tbody>{est.scenes.map((s) => <tr key={s.ref}><td>{s.ref}</td><td>{s.provider_name ?? <span className="text-danger">{s.blocked}</span>}</td><td>{s.seconds} sn</td><td>{s.usd === null ? "bilinmiyor" : usd(s.usd, 2)}</td></tr>)}</tbody>
              </table>
            ) : <p className="mt-1 text-xs text-muted">Planda AI sahnesi yok (yalnızca kurgu).</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm">Toplam tahmini: <strong>{est?.totalUsd === null || !est ? "bilinmiyor" : usd(est.totalUsd, 2)}</strong>{est ? ` · ${est.seconds} sn AI video` : ""}</span>
              <form action={approveProductionAction}>
                <input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="back" value={back} />
                <SubmitButton className="btn-primary" disabled={!est || est.totalUsd === null} confirm={`Ücretli AI video üretimi başlasın mı? Tahmini ${est?.totalUsd != null ? usd(est.totalUsd, 2) : "?"} (günlük bütçe sınırı uygulanır).`}>Üretimi onayla</SubmitButton>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

type JobRow = { id: string; project_id: string | null; task_id: string | null; provider: string; item_ref: string; status: string; error: string | null; response: any; request: any;
  cost_estimated_usd: string | null; cost_actual_usd: string | null; result_asset_id: string | null; poll_count: number; created_at: string; idempotency_key: string; output_id: string | null };

/** Sahne üretim durumu (sağlayıcı, ilerleme, maliyet, hata) ve son reklam MP4'leri. */
export async function ProductionProgress({ brandId, projectId, limit = 12 }: { brandId: string; projectId?: string; limit?: number }) {
  const jobs = await q<JobRow>(
    `SELECT j.id, j.project_id, j.task_id, j.provider, j.item_ref, j.status, j.error, j.response, j.request, j.cost_estimated_usd, j.cost_actual_usd, j.result_asset_id,
            j.poll_count, j.created_at, j.idempotency_key, t.output_id
     FROM provider_jobs j LEFT JOIN tasks t ON t.id = j.task_id
     WHERE j.brand_id = $1 AND j.kind = 'video_generation' AND ($2::uuid IS NULL OR j.project_id = $2) ORDER BY j.created_at DESC LIMIT $3`,
    [brandId, projectId ?? null, limit],
  );
  const ads = await q<{ id: string; filename: string; duration_s: string | null; width: number | null; height: number | null; created_at: string; project_id: string | null }>(
    `SELECT id, filename, duration_s, width, height, created_at, project_id FROM media_assets
     WHERE brand_id = $1 AND kind = 'video' AND generation_method = 'ffmpeg_edit' AND ($2::uuid IS NULL OR project_id = $2) ORDER BY created_at DESC LIMIT 4`,
    [brandId, projectId ?? null],
  );
  const total = jobs.reduce((a, j) => a + (j.cost_actual_usd !== null ? Number(j.cost_actual_usd) : 0), 0);
  return (
    <section className="card" aria-labelledby="prod-progress-h">
      <h2 id="prod-progress-h" className="h2 mb-2">Üretim durumu</h2>
      {ads.length > 0 && (
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          {ads.map((a) => (
            <figure key={a.id} className="rounded-lg bg-surface-2 p-2">
              <video controls preload="metadata" playsInline className="max-h-96 w-full rounded bg-black" src={`/api/media/${a.id}/file`} aria-label={`Reklam videosu ${a.filename}`} />
              <figcaption className="mt-1 text-xs text-muted"><Link href={`/medya/${a.id}`} className="text-brand">{a.filename}</Link> · {a.width}x{a.height} · {a.duration_s ? `${Number(a.duration_s).toFixed(1)} sn` : ""} · {dt(a.created_at)}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {jobs.length === 0 ? <p className="muted text-sm">Henüz AI video sahnesi gönderilmedi.</p> : (
        <div tabIndex={0} className="overflow-x-auto">
          <table className="table text-xs">
            <thead><tr><th>Sahne</th><th>Sağlayıcı</th><th>Durum</th><th>Tahmini</th><th>Gerçekleşen</th><th>Dosya</th></tr></thead>
            <tbody>
              {jobs.map((j) => {
                const p = providerOfService(j.provider);
                const progress = typeof j.response?.progress === "number" ? ` %${j.response.progress}` : "";
                return (
                  <tr key={j.id}>
                    <td>{j.item_ref}{j.request?.provider_choice?.fallback_from ? <div className="text-muted">yedek: {VIDEO_PROVIDER_NAME[j.request.provider_choice.fallback_from.id as "runway" | "gemini"] ?? ""} kullanılamadı</div> : null}{j.request?.provider_choice?.owner_choice ? <div className="text-muted">sahip seçimi</div> : null}</td>
                    <td>{p ? VIDEO_PROVIDER_NAME[p] : j.provider}</td>
                    <td><Badge tone={j.status === "succeeded" ? "ok" : j.status === "failed" ? "bad" : "warn"}>{PROVIDER_JOB_STATUS_LABEL[j.status] ?? j.status}{j.status === "running" ? progress : ""}</Badge>
                      {j.idempotency_key.includes(":released:") && <div className="text-muted">yeniden gönderime açıldı</div>}
                      {j.error && <div className="max-w-xs text-danger">{j.error}</div>}
                      {(j.status === "failed" || j.status === "unknown") && j.output_id && !j.idempotency_key.includes(":released:") && <Link href={`/taslaklar/${j.output_id}`} className="text-brand underline">Yeniden gönder…</Link>}
                    </td>
                    <td>{j.cost_estimated_usd === null ? "bilinmiyor" : usd(Number(j.cost_estimated_usd), 3)}</td>
                    <td>{j.cost_actual_usd === null ? (j.status === "succeeded" || j.status === "unknown" ? "bilinmiyor" : "—") : usd(Number(j.cost_actual_usd), 3)}</td>
                    <td>{j.result_asset_id ? <Link href={`/medya/${j.result_asset_id}`} className="text-brand">MP4</Link> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {jobs.length > 0 && <p className="mt-2 text-xs text-muted">Listelenen sahnelerin gerçekleşen toplamı: {usd(total, 3)}. Runway ve Gemini ayrı maliyet kayıtlarıdır (Maliyet Yönetimi).</p>}
    </section>
  );
}
