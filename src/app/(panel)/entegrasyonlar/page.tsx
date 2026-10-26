import { requireBrand, flash, type SP } from "@/lib/current";
import { PROVIDERS, effectiveStatus, envConfigured } from "@/lib/services/connections";
import { CONNECTION_STATUS_LABEL, CONNECTION_STATUS_TONE } from "@/lib/labels";
import { Badge, Flash, PageHeader, dt } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { disconnectAction, retryWaitingAction, testConnectionAction } from "@/app/actions";
import { q1 } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { instagramRedirectUri } from "@/lib/adapters/instagram";
import { driveRedirectUri } from "@/lib/drive/google";
import { INTEGRATION_STATE_LABEL, INTEGRATION_STATE_TONE, stateFromConnection, toolCatalog } from "@/lib/services/tool-catalog";

export default async function Integrations({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const rows = await Promise.all(PROVIDERS.map(async (p) => ({ p, s: await effectiveStatus(p.id, brand.id), env: envConfigured(p.id) })));
  const waiting = await q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE brand_id = $1 AND status = 'waiting_connection'`, [brand.id]);
  const testable = new Set(["anthropic", "openai_images", "video_generation", "shopify", "instagram"]);
  const tools = await toolCatalog();
  return (
    <div>
      <PageHeader title="Entegrasyonlar" subtitle="Bağlantılar resmi yetkilendirme yöntemleriyle kurulur. Hesap şifreleri istenmez; gizli anahtarlar yalnızca sunucu ortam değişkenlerinde veya şifreli olarak veritabanında tutulur."
        actions={(waiting?.n ?? 0) > 0 ? <form action={retryWaitingAction}><SubmitButton className="btn-primary">Bağlantı bekleyen {waiting!.n} görevi tekrar dene</SubmitButton></form> : undefined} />
      <Flash ok={ok} err={err} />
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map(({ p, s, env }) => (
          <section key={p.id} className="card space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div><h2 className="h2">{p.name}</h2><div className="text-xs text-muted">{p.category} · {p.scope === "brand" ? `marka bazında (${brand.name})` : "genel"}</div></div>
              <div className="flex flex-col items-end gap-1">
                <Badge tone={INTEGRATION_STATE_TONE[stateFromConnection(p.id, s.status)]}>{INTEGRATION_STATE_LABEL[stateFromConnection(p.id, s.status)]}</Badge>
                <span className="text-[11px] text-muted">Bağlantı: {CONNECTION_STATUS_LABEL[s.status]}</span>
              </div>
            </div>
            <p className="text-sm">{p.description}</p>
            {s.detail && <p className={`text-xs ${s.status === "error" || s.status === "reauth_required" ? "text-red-700" : "text-muted"}`}>{s.detail}</p>}
            {s.connection?.last_checked_at && <p className="text-xs text-muted">Son kontrol: {dt(s.connection.last_checked_at)}</p>}
            <details className="text-xs"><summary className="cursor-pointer text-brand">Nasıl bağlanır?</summary><p className="mt-1">{p.howToConnect}</p>{p.docs && <p className="mt-1 break-all text-muted">Resmi belge: {p.docs}</p>}
              {p.id === "instagram" && <p className="mt-1 text-muted">OAuth yönlendirme adresi: <code>{instagramRedirectUri()}</code></p>}
              {p.id === "google_drive" && <p className="mt-1 text-muted">OAuth yönlendirme adresi: <code>{driveRedirectUri()}</code></p>}
            </details>
            <div className="flex flex-wrap gap-2">
              {p.id === "shopify" && (
                <form action={testConnectionAction} className="flex w-full flex-wrap gap-2">
                  <input type="hidden" name="provider" value="shopify" />
                  <input name="shop" defaultValue={s.connection?.config?.shop ?? ""} placeholder="magazam.myshopify.com" className="input max-w-xs" disabled={!env} />
                  <SubmitButton className="btn" disabled={!env} pendingText="Test ediliyor…">{env ? "Bağlan ve test et" : "Bağlantı bekliyor (ortam değişkenleri yok)"}</SubmitButton>
                </form>
              )}
              {p.id === "google_drive" && <a href="/drive-arsivi" className="btn">Drive Arşivi'ni aç</a>}
              {p.id === "instagram" && (env ? <a href="/api/integrations/instagram/start" className="btn">Instagram ile bağlan</a> : <button disabled className="btn">Instagram ile bağlan (uygulama bilgileri yok)</button>)}
              {testable.has(p.id) && p.id !== "shopify" && (
                <form action={testConnectionAction}><input type="hidden" name="provider" value={p.id} /><SubmitButton className="btn" disabled={!env} pendingText="Test ediliyor…">{env ? "Test et" : "Test et (yapılandırılmadı)"}</SubmitButton></form>
              )}
              {s.connection && ["shopify", "instagram"].includes(p.id) && s.status !== "not_connected" && (
                <form action={disconnectAction}><input type="hidden" name="provider" value={p.id} /><SubmitButton className="btn-danger" confirm="Bağlantı kaldırılsın mı?">Bağlantıyı kaldır</SubmitButton></form>
              )}
            </div>
          </section>
        ))}
      </div>
      <section className="card mt-4">
        <h2 className="h2 mb-1">Değerlendirilen araçlar</h2>
        <p className="muted mb-3 text-xs">Durumlar sunucudaki gerçek yapılandırmadan hesaplanır. Yapılandırılmamış araç “Etkin” gösterilmez.</p>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Değerlendirilen araçlar tablosu">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted"><th className="py-1 pr-2">Araç</th><th className="pr-2">Durum</th><th className="pr-2">Kapsam</th><th>Karar</th></tr></thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.id} className="border-t border-line align-top" data-tool={t.id} data-state={t.state}>
                  <td className="py-2 pr-2"><div className="font-medium">{t.name}</div><div className="text-xs text-muted">{t.purpose}</div></td>
                  <td className="pr-2"><Badge tone={INTEGRATION_STATE_TONE[t.state]}>{INTEGRATION_STATE_LABEL[t.state]}</Badge></td>
                  <td className="pr-2 text-xs">{t.scope === "runtime" ? "Uygulama" : "Yalnızca geliştirme"}</td>
                  <td className="text-xs">{t.decision}<div className="mt-1 text-muted">{t.detail}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card mt-4 text-sm">
        <h2 className="h2 mb-2">Ortam bilgisi</h2>
        <ul className="space-y-1 text-xs">
          <li>Uygulama modu: <strong>{config.appMode}</strong></li>
          <li>Depolama: <strong>{config.storageDriver}</strong>{config.storageDriver === "local" ? " (Instagram yayını için herkese açık URL sağlayamaz)" : ""}</li>
          <li>Shopify API sürümü: {config.shopify.apiVersion} · Instagram Graph sürümü: {config.instagram.graphVersion}</li>
          <li>Hiçbir entegrasyon bu geliştirme ortamında gerçek hesapla test edilmedi.</li>
        </ul>
      </section>
    </div>
  );
}
