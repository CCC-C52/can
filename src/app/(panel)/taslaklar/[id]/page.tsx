import Link from "next/link";
import { notFound } from "next/navigation";
import { requireBrand, flash, type SP } from "@/lib/current";
import { getOutput, listApprovals, listVersions, requiredScopes } from "@/lib/services/outputs";
import { getTask } from "@/lib/orchestrator/projects";
import { listProducts } from "@/lib/services/brands";
import { q } from "@/lib/db/pool";
import type { MediaAsset } from "@/lib/services/media";
import type { ExternalAction } from "@/lib/services/gateway";
import type { ProviderJob } from "@/lib/services/provider-jobs";
import { getLimits } from "@/lib/settings";
import { agentName } from "@/lib/agents/registry";
import { APPROVAL_SCOPE_LABEL, EXTERNAL_ACTION_STATUS_LABEL, PROVIDER_JOB_STATUS_LABEL, TASK_STATUS_LABEL } from "@/lib/labels";
import { Badge, DemoBadge, Flash, PageHeader, dt } from "@/components/ui";
import { AutoRefresh, IdempotencyField, SubmitButton } from "@/components/client";
import { StructuredEditor } from "@/components/editor";
import { OutputPreview, QaPanel } from "@/components/previews";
import { decideAction, editOutputAction, externalAction, reconcileAction_, regenerateAction, releaseProviderJobAction, revokeApprovalAction } from "@/app/actions";

export default async function OutputPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const { ok, err, one } = await flash(searchParams);
  const brand = await requireBrand();
  const out = await getOutput(brand.id, id);
  if (!out) notFound();
  const [versions, approvals, task, products, limits] = await Promise.all([
    listVersions(brand.id, id), listApprovals(brand.id, id), out.task_id ? getTask(brand.id, out.task_id) : null, listProducts(brand.id), getLimits(),
  ]);
  const current = versions[0];
  const shownNo = Number(one("v") ?? current?.version);
  const shown = versions.find((v) => v.version === shownNo) ?? current;
  if (!shown) return <p className="muted">Bu çıktının henüz sürümü yok.</p>;
  const isCurrent = shown.version === current.version;
  const assetIds = [...new Set(versions.flatMap((v) => v.asset_ids))];
  const [assets, actions, jobs, costs, renderTask] = await Promise.all([
    assetIds.length ? q<MediaAsset>(`SELECT * FROM media_assets WHERE brand_id = $1 AND id = ANY($2::uuid[]) ORDER BY created_at`, [brand.id, assetIds]) : Promise.resolve([] as MediaAsset[]),
    q<ExternalAction & { version: number }>(`SELECT a.*, v.version FROM external_actions a JOIN output_versions v ON v.id = a.output_version_id WHERE v.output_id = $1 AND a.brand_id = $2 ORDER BY a.created_at DESC`, [id, brand.id]),
    q<ProviderJob>(`SELECT j.* FROM provider_jobs j JOIN tasks t ON t.id = j.task_id WHERE t.output_id = $1 AND j.brand_id = $2 ORDER BY j.created_at DESC`, [id, brand.id]),
    q<{ service: string; est: number | null; act: number | null; unknown: number; n: number }>(
      `SELECT c.service, SUM(c.amount_usd) FILTER (WHERE c.kind = 'estimated')::float AS est, SUM(c.amount_usd) FILTER (WHERE c.kind = 'actual')::float AS act,
         COUNT(*) FILTER (WHERE c.amount_usd IS NULL)::int AS unknown, COUNT(*)::int AS n
       FROM cost_entries c JOIN tasks t ON t.id = c.task_id WHERE t.output_id = $1 AND c.brand_id = $2 GROUP BY c.service ORDER BY c.service`, [id, brand.id]),
    q<{ id: string; status: string; error: string | null; input_refs: any }>(
      `SELECT id, status, error, input_refs FROM tasks WHERE output_id = $1 AND brand_id = $2 AND kind = 'render' ORDER BY created_at DESC LIMIT 1`, [id, brand.id]).then((r) => r[0] ?? null),
  ]);
  const videoArtifacts: any[] = renderTask?.input_refs?.version_id === current.id ? renderTask.input_refs?.result?.artifacts ?? [] : [];
  const needsMp4 = out.kind === "video_plan" && (current.content?.videos ?? []).some((v: any) => v.mode === "edit_existing" || v.mode === "generate_new");
  const hasMp4 = assets.some((a) => current.asset_ids.includes(a.id) && a.kind === "video" && (a.generation_method === "ffmpeg_edit" || a.generation_method?.startsWith("ai_video:")));
  const latestDecision = approvals.find((a) => a.output_version_id === current.id && !a.revoked_at);
  const scopes = requiredScopes(out.kind, current.content);
  const containsDemo = current.is_demo || JSON.stringify(current.content).includes("[DEMO]");
  const busy = task && ["planned", "ready", "running", "review_pending"].includes(task.status);
  const pmap = new Map(products.map((p) => [p.id, p.title]));
  const editable = !["plan", "project_report", "qa_report"].includes(out.kind);

  return (
    <div>
      <PageHeader
        title={out.title}
        subtitle={<span className="flex flex-wrap items-center gap-1">{agentName(out.agent)} · sürüm {shown.version}/{current.version} · {shown.created_by === "user" ? "kullanıcı düzenlemesi" : shown.generator}
          {shown.is_demo && <DemoBadge />}
          {task && <Link href={`/gorevler/${task.id}`} className="underline">Görev: {TASK_STATUS_LABEL[task.status]}</Link>}
          {out.project_id && <Link href={`/projeler/${out.project_id}`} className="underline">Proje</Link>}
        </span>}
        actions={<AutoRefresh active={!!busy} />}
      />
      <Flash ok={ok} err={err} />
      {!isCurrent && <div className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-amber-200">Eski bir sürümü görüntülüyorsunuz. Onay ve dış işlemler yalnızca güncel sürüm (v{current.version}) için yapılabilir. <Link className="underline" href={`/taslaklar/${id}`}>Güncel sürüme git</Link></div>}
      {shown.is_demo && <div className="mb-3 rounded-lg bg-fuchsia-50 p-2 text-sm text-fuchsia-900 ring-1 ring-fuchsia-200">Bu sürüm DEMO şablonla üretildi; gerçek AI üretimi değildir. DEMO içerik dış platforma gönderilemez — düzenleyip kendi sürümünüzü oluşturabilirsiniz.</div>}

      <div className="grid gap-4 xl:grid-cols-3">
        <section className="card xl:col-span-2">
          <h2 className="h2 mb-3">Önizleme</h2>
          <OutputPreview kind={out.kind} content={shown.content} assets={assets} products={pmap} />
        </section>

        <div className="space-y-4">
          <section className="card">
            <h2 className="h2 mb-2">Kalite kontrolü</h2>
            <QaPanel qa={shown.qa_report} />
          </section>

          {editable && isCurrent && (
            <section className="card space-y-3">
              <h2 className="h2">Onay</h2>
              {needsMp4 && !hasMp4 && (
                <p className="rounded bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
                  Bu sürüm için doğrulanmış MP4 henüz yok{renderTask ? ` (render: ${TASK_STATUS_LABEL[renderTask.status as keyof typeof TASK_STATUS_LABEL] ?? renderTask.status}${renderTask.error ? ` — ${renderTask.error.slice(0, 160)}` : ""})` : ""}. Onay MP4 üretilip doğrulandıktan sonra verilebilir; reddedebilir veya revizyon isteyebilirsiniz.
                </p>
              )}
              <p className="text-xs text-muted">Onay bu sürümün içerik özetine (hash) bağlanır: <code className="break-all">{current.content_hash.slice(0, 16)}…</code>. İçerik değişirse onay geçersiz olur.</p>
              {latestDecision ? (
                <div className="text-sm">
                  <Badge tone={latestDecision.decision === "approved" ? "ok" : "bad"}>{latestDecision.decision === "approved" ? "Onaylandı" : "Reddedildi"}</Badge>
                  <span className="ml-2 text-xs text-muted">{dt(latestDecision.created_at)}</span>
                  {latestDecision.decision === "approved" && <ul className="mt-1 text-xs">{latestDecision.scopes.map((s) => <li key={s}>✓ {APPROVAL_SCOPE_LABEL[s] ?? s}</li>)}</ul>}
                  {latestDecision.note && <p className="mt-1 text-xs">Not: {latestDecision.note}</p>}
                  <form action={revokeApprovalAction} className="mt-2"><input type="hidden" name="outputId" value={id} /><input type="hidden" name="approvalId" value={latestDecision.id} /><SubmitButton className="btn px-2 py-1 text-xs">Kararı geri al</SubmitButton></form>
                </div>
              ) : (
                <form action={decideAction} className="space-y-2">
                  <input type="hidden" name="outputId" value={id} />
                  <input type="hidden" name="versionId" value={current.id} />
                  <fieldset className="space-y-1 text-sm">
                    <legend className="label">Onay kapsamı</legend>
                    {scopes.map((s) => (
                      <label key={s} className="flex items-center gap-2"><input type="checkbox" name="scopes" value={s} defaultChecked={s === "content"} disabled={s === "content"} />{APPROVAL_SCOPE_LABEL[s] ?? s}</label>
                    ))}
                    {scopes.includes("price_change") && <p className="text-xs text-amber-800">Bu öneri fiyat değişikliği içeriyor; canlıya uygulamak için “Fiyat / indirim değişikliği” kapsamı da gerekir.</p>}
                  </fieldset>
                  <input name="note" className="input" placeholder="Not / ret gerekçesi (isteğe bağlı)" aria-label="Not" />
                  {task && <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="revise" defaultChecked /> Reddedersem bu notla yeni sürüm üretilsin (yeniden üretim hakkı: {task.regen_count}/{limits.maxRegenerations})</label>}
                  <div className="flex gap-2">
                    <button name="decision" value="approved" className="btn-primary">Bu sürümü onayla</button>
                    <button name="decision" value="rejected" className="btn-danger">Reddet</button>
                  </div>
                </form>
              )}
            </section>
          )}

          {editable && isCurrent && out.kind === "shopify_proposal" && (
            <section className="card space-y-2">
              <h2 className="h2">Canlı mağazaya uygula</h2>
              <p className="text-xs text-muted">Sunucu; onayı, sürümü, içerik özetini ve Shopify bağlantısını kontrol eder. Bağlantı yoksa işlem yapılmaz.</p>
              {containsDemo && <p className="text-xs text-fuchsia-800">DEMO içerik gönderilemez.</p>}
              <form action={externalAction}>
                <IdempotencyField /><input type="hidden" name="outputId" value={id} /><input type="hidden" name="versionId" value={current.id} /><input type="hidden" name="actionType" value="store_update" />
                <SubmitButton className="btn" confirm="Onaylı değişiklikler canlı Shopify mağazasına yazılsın mı?">Shopify'a uygula</SubmitButton>
              </form>
            </section>
          )}

          {editable && isCurrent && out.kind === "social_package" && (
            <section className="card space-y-2">
              <h2 className="h2">Yayın</h2>
              <p className="text-xs text-muted">Instagram: bağlı hesap + S3 depolama gerekir. TikTok: otomatik yayın desteklenmiyor, manuel paket hazırlanır.</p>
              {(current.content.posts ?? []).map((p: any) => (
                <div key={p.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{p.id} <span className="text-xs text-muted">({p.platform})</span></span>
                  <span className="flex gap-1">
                    {p.platform === "instagram" && (
                      <form action={externalAction}>
                        <IdempotencyField /><input type="hidden" name="outputId" value={id} /><input type="hidden" name="versionId" value={current.id} /><input type="hidden" name="actionType" value="publish" /><input type="hidden" name="postId" value={p.id} />
                        <SubmitButton className="btn px-2 py-1 text-xs" confirm="Gönderi Instagram'da yayınlansın mı?">Yayınla</SubmitButton>
                      </form>
                    )}
                    <form action={externalAction}>
                      <IdempotencyField /><input type="hidden" name="outputId" value={id} /><input type="hidden" name="versionId" value={current.id} /><input type="hidden" name="actionType" value="publish" /><input type="hidden" name="postId" value={p.id} /><input type="hidden" name="manual" value="1" />
                      <SubmitButton className="btn px-2 py-1 text-xs">Manuel paket</SubmitButton>
                    </form>
                  </span>
                </div>
              ))}
            </section>
          )}

          {videoArtifacts.length > 0 && (
            <section className="card space-y-2" aria-labelledby="mp4-h">
              <h2 id="mp4-h" className="h2">Üretilen MP4</h2>
              {videoArtifacts.map((a) => (
                <dl key={a.asset_id} className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                  <dt className="text-muted">Dosya</dt><dd><Link className="text-brand underline" href={`/medya/${a.asset_id}`}>Aç</Link> · <a className="text-brand underline" href={`/api/media/${a.asset_id}/file?download=1`} download>İndir</a></dd>
                  <dt className="text-muted">Kodek</dt><dd>{a.codec} (H.264, yuv420p)</dd>
                  <dt className="text-muted">Çözünürlük</dt><dd>{a.width}×{a.height}</dd>
                  <dt className="text-muted">Süre</dt><dd>{Number(a.duration_s).toFixed(2)} sn</dd>
                  <dt className="text-muted">Boyut</dt><dd>{(a.bytes / 1e6).toFixed(1)} MB</dd>
                  <dt className="text-muted">Bölüm / kaynak</dt><dd>{a.segments} bölüm · {a.sources} kaynak video</dd>
                  <dt className="text-muted">Ses</dt><dd>{a.audio}</dd>
                  <dt className="text-muted">Doğrulama</dt><dd>{a.decoded ? "ffprobe + baştan sona çözme başarılı" : "—"}</dd>
                </dl>
              ))}
            </section>
          )}

          <section className="card space-y-2" aria-labelledby="cost-h">
            <h2 id="cost-h" className="h2">Maliyet</h2>
            {costs.length ? (
              <table className="w-full text-left text-xs">
                <thead><tr className="text-muted"><th className="py-1">Servis</th><th>Tahmini</th><th>Gerçekleşen</th></tr></thead>
                <tbody>{costs.map((c) => (
                  <tr key={c.service} className="border-t border-line"><td className="py-1">{c.service}</td><td>{c.est === null ? "—" : `$${c.est.toFixed(4)}`}</td><td>{c.act === null ? "—" : `$${c.act.toFixed(4)}`}{c.unknown ? ` · ${c.unknown} bilinmiyor` : ""}</td></tr>
                ))}</tbody>
              </table>
            ) : <p className="text-xs text-muted">Bu çıktı için ücretli işlem kaydı yok (DEMO ve yerel işlemler ücretsizdir).</p>}
            <p className="text-xs text-muted">Gerçekleşen tutarlar sağlayıcının bildirdiği kullanım veya yapılandırılmış birim fiyattır; fatura ile doğrulanmamıştır.</p>
          </section>

          {jobs.length > 0 && (
            <section className="card space-y-2" aria-labelledby="jobs-h">
              <h2 id="jobs-h" className="h2">AI üretim işleri</h2>
              <p className="text-xs text-muted">Ücretli sağlayıcıya yapılan her gönderim tek kayıttır; yeniden deneme veya işleyici yeniden başlatması ikinci gönderim yapmaz.</p>
              <ul className="space-y-2 text-xs">
                {jobs.map((j) => (
                  <li key={j.id} className="rounded bg-gray-50 p-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={j.status === "succeeded" ? "ok" : j.status === "failed" ? "bad" : "warn"}>{PROVIDER_JOB_STATUS_LABEL[j.status] ?? j.status}</Badge>
                      {j.item_ref} · {j.kind === "video_generation" ? "AI video" : "AI görsel"} · {j.provider}
                    </div>
                    <div className="text-muted">{dt(j.created_at)} · tahmini {j.cost_estimated_usd === null ? "bilinmiyor" : `$${Number(j.cost_estimated_usd).toFixed(3)}`}{j.cost_actual_usd !== null ? ` · gerçekleşen $${Number(j.cost_actual_usd).toFixed(3)}` : ""}{j.poll_count ? ` · ${j.poll_count} sorgu` : ""}</div>
                    {j.error && <div className="text-red-700">{j.error}</div>}
                    {j.result_asset_id && <Link className="text-brand underline" href={`/medya/${j.result_asset_id}`}>Üretilen dosya</Link>}
                    {(j.status === "failed" || j.status === "unknown") && !j.idempotency_key.includes(":released:") && (
                      <form action={releaseProviderJobAction} className="mt-1">
                        <input type="hidden" name="jobId" value={j.id} /><input type="hidden" name="back" value={`/taslaklar/${id}`} />
                        <SubmitButton className="btn px-2 py-0.5 text-xs" confirm={j.status === "unknown" ? "Önceki gönderimin sonucu bilinmiyor; sağlayıcı ücretlendirmiş olabilir. Yine de yeniden gönderilsin mi? (yeni ücret oluşabilir)" : "Yeniden gönderilsin mi? (yeni ücret oluşabilir)"}>Yeniden gönder</SubmitButton>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {task && editable && (
            <section className="card space-y-2">
              <h2 className="h2">Yeniden üretim</h2>
              <p className="text-xs text-muted">Kullanılan: {task.regen_count}/{limits.maxRegenerations}. Yeni sürüm aynı çıktıya eklenir ve kalite kontrolünden geçer.</p>
              <form action={regenerateAction} className="space-y-2">
                <input type="hidden" name="outputId" value={id} />
                <textarea name="feedback" rows={2} className="input" placeholder="Ne değişmeli?" />
                <SubmitButton className="btn" pendingText="Kuyruğa alınıyor…">Yeniden üret</SubmitButton>
              </form>
            </section>
          )}
        </div>

        {editable && isCurrent && (
          <details className="card xl:col-span-2" open={one("edit") === "1"}>
            <summary className="h2 cursor-pointer">Düzenle (yeni sürüm oluşturur)</summary>
            <div className="mt-2">
            <p className="mb-3 text-xs text-muted">Kaydetmek yeni sürüm (v{current.version + 1}) oluşturur; şema ve kural tabanlı kalite kontrolü yeniden çalışır. Mevcut onaylar yeni sürüme taşınmaz.</p>
            <form action={editOutputAction} className="space-y-3">
              <input type="hidden" name="outputId" value={id} />
              <StructuredEditor initial={current.content} />
              <SubmitButton>Yeni sürüm olarak kaydet</SubmitButton>
            </form>
            </div>
          </details>
        )}

        <section className="card">
          <h2 className="h2 mb-2">Sürümler</h2>
          <ul className="space-y-2 text-sm">
            {versions.map((v) => {
              const a = approvals.find((x) => x.output_version_id === v.id && !x.revoked_at);
              return (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-1">
                  <Link href={`/taslaklar/${id}?v=${v.version}`} className={v.version === shown.version ? "font-semibold" : "text-brand"}>v{v.version} · {v.created_by === "user" ? "kullanıcı" : v.generator}</Link>
                  <span className="flex gap-1">{v.is_demo && <DemoBadge />}{v.qa_report && <Badge tone={v.qa_report.verdict === "pass" ? "ok" : "bad"}>QA</Badge>}{a && <Badge tone={a.decision === "approved" ? "ok" : "bad"}>{a.decision === "approved" ? "Onaylı" : "Ret"}</Badge>}</span>
                  <span className="w-full text-xs text-muted">{dt(v.created_at)} · {v.content_hash.slice(0, 10)}</span>
                </li>
              );
            })}
          </ul>
          {actions.length > 0 && (
            <>
              <h3 className="mt-4 text-sm font-medium">Dış işlemler</h3>
              <ul className="mt-1 space-y-2 text-xs">
                {actions.map((a) => (
                  <li key={a.id} className="rounded bg-gray-50 p-2">
                    <div className="flex flex-wrap items-center gap-1"><Badge tone={a.status === "succeeded" ? "ok" : a.status === "failed" ? "bad" : "warn"}>{EXTERNAL_ACTION_STATUS_LABEL[a.status] ?? a.status}</Badge> {a.action_type} → {a.provider} · v{a.version}</div>
                    <div className="text-muted">{dt(a.created_at)}{a.request?.target?.postId ? ` · ${a.request.target.postId}` : ""}</div>
                    {a.error && <div className="text-red-700">{a.error}</div>}
                    {a.status === "manual_export" && <a className="text-brand underline" href={`/api/exports/${a.id}`}>Paketi indir (.zip)</a>}
                    {a.status === "unknown" && (
                      <form action={reconcileAction_} className="mt-1 flex gap-1"><input type="hidden" name="actionId" value={a.id} /><input type="hidden" name="back" value={`/taslaklar/${id}`} />
                        <button name="outcome" value="succeeded" className="btn px-2 py-0.5 text-xs">Gerçekleşti</button><button name="outcome" value="failed" className="btn px-2 py-0.5 text-xs">Gerçekleşmedi</button></form>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
