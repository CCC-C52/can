import { requireBrand, flash, type SP } from "@/lib/current";
import { PROVIDERS, effectiveStatus, envConfigured } from "@/lib/services/connections";
import { CONNECTION_STATUS_LABEL } from "@/lib/labels";
import { Badge, Flash, PageHeader, StatusDot, dt } from "@/components/ui";
import { Icon } from "@/components/icons";
import { SubmitButton } from "@/components/client";
import { disconnectAction, retryWaitingAction, testConnectionAction } from "@/app/actions";
import { integrationRemoveAction, integrationSaveAction, integrationStartAction, integrationTestAction } from "@/app/actions/agency";
import { q1 } from "@/lib/db/pool";
import { config } from "@/lib/config";
import { instagramRedirectUri } from "@/lib/adapters/instagram";
import { driveRedirectUri } from "@/lib/drive/google";
import { INTEGRATION_STATE_LABEL, INTEGRATION_STATE_TONE, stateFromConnection, toolCatalog } from "@/lib/services/tool-catalog";
import { listIntegrations, type IntegrationCard } from "@/lib/integrations/service";
import { STATE_LABEL, STATE_ORDER, STATE_TONE } from "@/lib/integrations/registry";

export const metadata = { title: "Entegrasyonlar" };

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-[11px] text-muted">{label}</dt><dd className="mt-0.5 text-sm break-words text-ink-soft">{children}</dd></div>;
}

function PlatformCard({ c, brandName }: { c: IntegrationCard; brandName: string }) {
  const d = c.def;
  const usage = c.meta.usage ? Object.entries(c.meta.usage).filter(([, v]) => v !== null) : [];
  const account = c.meta.account ? Object.entries(c.meta.account).filter(([, v]) => v !== null && v !== "") : [];
  return (
    <section className="card flex flex-col gap-4" aria-labelledby={`int-${d.id}`} data-integration={d.id} data-state={c.state}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`int-${d.id}`} className="text-base font-semibold">{d.name}</h3>
          <p className="mt-1 text-sm text-muted">{d.purpose}</p>
        </div>
        <Badge tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-3 rounded-2xl bg-surface-2/70 p-3">
        <Meta label="Son başarılı test / senkron">{c.meta.lastSuccessAt ? dt(c.meta.lastSuccessAt) : "—"}</Meta>
        <Meta label="Senkron durumu">{c.meta.syncStatus ?? (c.state === "verified" ? "Kimlik doğrulandı" : "—")}</Meta>
        <Meta label="Son hata">{c.lastError ? <span className="text-danger">{c.lastError}</span> : "—"}</Meta>
        <Meta label="Kullanım / tahmini maliyet">{usage.length ? usage.map(([k, v]) => `${k === "creditBalance" ? "Kredi bakiyesi" : k}: ${v}`).join(" · ") : <span className="text-muted">{d.cost}</span>}</Meta>
        {account.length > 0 && <div className="col-span-2"><Meta label="Hesap">{account.map(([k, v]) => `${k}: ${v}`).join(" · ")}</Meta></div>}
        {c.meta.tokenExpiresAt && <div className="col-span-2"><Meta label="Belirteç geçerlilik sonu">{dt(c.meta.tokenExpiresAt)}</Meta></div>}
      </dl>

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div><div className="label">Kullanıldığı yerler</div><div className="flex flex-wrap gap-1.5">{d.uses.map((u) => <Badge key={u}>{u}</Badge>)}</div></div>
        <div><div className="label">Hazır yetenekler</div><ul className="space-y-0.5 text-xs text-ink-soft">{d.implemented.map((x) => <li key={x} className="flex gap-1.5"><Icon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />{x}</li>)}</ul></div>
      </div>

      <details className="text-xs">
        <summary className="text-brand">Kimlik doğrulama, erişim koşulu ve resmî belgeler</summary>
        <div className="mt-2 space-y-2 text-ink-soft">
          <p><strong className="text-ink">Kimlik doğrulama:</strong> {d.auth}</p>
          <p><strong className="text-ink">Erişim:</strong> {d.access}</p>
          {d.test && <p><strong className="text-ink">Bağlantı testi:</strong> {d.test}</p>}
          {d.planned.length > 0 && <p><strong className="text-ink">Sonraki adımlar:</strong> {d.planned.join(" · ")}</p>}
          {d.caveats.map((x) => <p key={x} className="text-warning">{x}</p>)}
          <ul className="space-y-0.5">{d.docs.map((x) => <li key={x.url}><a href={x.url} target="_blank" rel="noopener noreferrer" className="link break-all">{x.label}</a></li>)}</ul>
        </div>
      </details>

      <div className="mt-auto border-t border-line pt-4">
        {d.id === "shopify" ? (
          <div className="space-y-2">
            <form action={integrationTestAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="integration" value="shopify" />
              <label className="sr-only" htmlFor="shop-domain">Shopify mağaza alan adı</label>
              <input id="shop-domain" name="shop" defaultValue={c.config.shop ?? ""} placeholder="fribee.myshopify.com" className="input max-w-xs" disabled={!c.envReady} />
              <SubmitButton className="btn" disabled={!c.envReady} pendingText="Test ediliyor…">{c.envReady ? "Bağlan ve test et" : "SHOPIFY_CLIENT_ID/SECRET bekleniyor"}</SubmitButton>
            </form>
            {c.hasCredentials && (
              <form action={disconnectAction}><input type="hidden" name="provider" value="shopify" /><SubmitButton className="btn-danger" confirm="Shopify bağlantısı kaldırılsın mı?">Bağlantıyı kaldır</SubmitButton></form>
            )}
            <p className="text-xs text-muted">Marka: {brandName}. Uygulama kimliği yalnızca sunucu ortam değişkenlerinde tutulur.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <form action={integrationSaveAction} className="grid gap-2 sm:grid-cols-2" autoComplete="off">
              <input type="hidden" name="integration" value={d.id} />
              {d.fields.map((f) => (
                <label key={f.name} className={`block text-xs ${d.fields.length === 1 ? "sm:col-span-2" : ""}`}>
                  <span className="label">{f.label}{f.secret && c.hasCredentials ? " (kayıtlı — değiştirmek için yeniden girin)" : ""}</span>
                  <input
                    name={f.name}
                    type={f.secret ? "password" : "text"}
                    autoComplete={f.secret ? "new-password" : "off"}
                    spellCheck={false}
                    required={f.required}
                    pattern={f.pattern}
                    placeholder={f.secret && c.hasCredentials ? "••••••••" : f.placeholder}
                    defaultValue={f.secret ? undefined : (c.config[f.name] ?? "")}
                    className="input"
                  />
                  {f.help && <span className="mt-1 block text-[11px] text-muted">{f.help}</span>}
                </label>
              ))}
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <SubmitButton className="btn-primary" pendingText={d.id === "brandwatch" ? "Doğrulanıyor…" : "Kaydediliyor…"}>{d.id === "brandwatch" ? "Belirteç al ve doğrula" : "Şifreli kaydet"}</SubmitButton>
              </div>
            </form>
            <div className="flex flex-wrap gap-2">
              {c.state === "not_configured" && (
                <form action={integrationStartAction}><input type="hidden" name="integration" value={d.id} /><SubmitButton className="btn">Kurulumu başlat (kimlik bekleniyor)</SubmitButton></form>
              )}
              {d.test && c.hasCredentials && d.id !== "brandwatch" && (
                <form action={integrationTestAction}><input type="hidden" name="integration" value={d.id} /><SubmitButton className="btn" pendingText="Test ediliyor…">Bağlantıyı test et</SubmitButton></form>
              )}
              {c.hasCredentials && (
                <form action={integrationRemoveAction}><input type="hidden" name="integration" value={d.id} /><SubmitButton className="btn-danger" confirm="Kimlik bilgileri silinsin mi?">Kimlik bilgilerini sil</SubmitButton></form>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default async function Integrations({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const [platforms, rows, waiting, tools] = await Promise.all([
    listIntegrations(brand.id),
    Promise.all(PROVIDERS.filter((p) => p.id !== "shopify").map(async (p) => ({ p, s: await effectiveStatus(p.id, brand.id), env: envConfigured(p.id) }))),
    q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM tasks WHERE brand_id = $1 AND status = 'waiting_connection'`, [brand.id]),
    toolCatalog(),
  ]);
  const testable = new Set(["anthropic", "openai_images", "video_generation", "instagram"]);
  const counts = STATE_ORDER.map((s) => ({ s, n: platforms.filter((p) => p.state === s).length })).filter((x) => x.n > 0);
  return (
    <div>
      <PageHeader
        eyebrow="Sistem"
        title="Entegrasyon Merkezi"
        subtitle="Bağlantılar yalnızca resmî API'ler ve yetkili yöntemlerle kurulur. Hesap şifresi istenmez; gizli anahtarlar şifreli saklanır ve ekranda gösterilmez. “Doğrulandı” durumu yalnızca gerçek bir bağlantı testinden sonra verilir."
        actions={(waiting?.n ?? 0) > 0 ? <form action={retryWaitingAction}><SubmitButton className="btn-primary">Bağlantı bekleyen {waiting!.n} görevi tekrar dene</SubmitButton></form> : undefined}
      />
      <Flash ok={ok} err={err} />

      <div className="mb-4 flex flex-wrap gap-2" aria-label="Durum özeti">
        {counts.map(({ s, n }) => <span key={s} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 text-xs"><StatusDot tone={STATE_TONE[s]} />{STATE_LABEL[s]}: <strong>{n}</strong></span>)}
      </div>
      <div role="note" className="mb-5 rounded-2xl border border-line bg-surface-2/70 px-4 py-3 text-xs leading-relaxed text-ink-soft">
        Başka bir üründeki bağlantı (ör. bir ChatGPT eklentisi) bu uygulamaya erişim vermez; her platformun kimlik bilgisi burada ayrıca girilir. Bağlantı testleri ücretsiz ve salt okunurdur: video üretmez, yayın yapmaz, mesaj göndermez.
      </div>

      <h2 className="eyebrow mb-3">Stratejik platformlar</h2>
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {platforms.map((c) => <PlatformCard key={c.def.id} c={c} brandName={brand.name} />)}
      </div>

      <h2 className="eyebrow mt-8 mb-3">Altyapı servisleri</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map(({ p, s, env }) => (
          <section key={p.id} className="card space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><h3 className="h2">{p.name}</h3><div className="text-xs text-muted">{p.category} · {p.scope === "brand" ? `marka bazında (${brand.name})` : "genel"}</div></div>
              <div className="flex flex-col items-end gap-1">
                <Badge tone={INTEGRATION_STATE_TONE[stateFromConnection(p.id, s.status)]}>{INTEGRATION_STATE_LABEL[stateFromConnection(p.id, s.status)]}</Badge>
                <span className="text-[11px] text-muted">Bağlantı: {CONNECTION_STATUS_LABEL[s.status]}</span>
              </div>
            </div>
            <p className="text-sm text-ink-soft">{p.description}</p>
            {s.detail && <p className={`text-xs ${s.status === "error" || s.status === "reauth_required" ? "text-danger" : "text-muted"}`}>{s.detail}</p>}
            {s.connection?.last_checked_at && <p className="text-xs text-muted">Son kontrol: {dt(s.connection.last_checked_at)}</p>}
            <details className="text-xs"><summary className="text-brand">Nasıl bağlanır?</summary><p className="mt-1">{p.howToConnect}</p>{p.docs && <p className="mt-1 break-all text-muted">Resmî belge: {p.docs}</p>}
              {p.id === "instagram" && <p className="mt-1 text-muted">OAuth yönlendirme adresi: <code>{instagramRedirectUri()}</code></p>}
              {p.id === "google_drive" && <p className="mt-1 text-muted">OAuth yönlendirme adresi: <code>{driveRedirectUri()}</code></p>}
            </details>
            <div className="flex flex-wrap gap-2">
              {p.id === "google_drive" && <a href="/drive-arsivi" className="btn">Drive Arşivi'ni aç</a>}
              {p.id === "instagram" && (env ? <a href="/api/integrations/instagram/start" className="btn">Instagram ile bağlan</a> : <button disabled className="btn">Instagram ile bağlan (uygulama bilgileri yok)</button>)}
              {testable.has(p.id) && (
                <form action={testConnectionAction}><input type="hidden" name="provider" value={p.id} /><SubmitButton className="btn" disabled={!env} pendingText="Test ediliyor…">{env ? "Test et" : "Test et (yapılandırılmadı)"}</SubmitButton></form>
              )}
              {s.connection && p.id === "instagram" && s.status !== "not_connected" && (
                <form action={disconnectAction}><input type="hidden" name="provider" value={p.id} /><SubmitButton className="btn-danger" confirm="Bağlantı kaldırılsın mı?">Bağlantıyı kaldır</SubmitButton></form>
              )}
            </div>
          </section>
        ))}
      </div>

      <section className="card mt-6">
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
        <ul className="space-y-1 text-xs text-ink-soft">
          <li>Uygulama modu: <strong>{config.appMode}</strong></li>
          <li>Depolama: <strong>{config.storageDriver}</strong>{config.storageDriver === "local" ? " (Instagram yayını için herkese açık URL sağlayamaz)" : ""}</li>
          <li>Shopify API sürümü: {config.shopify.apiVersion} · Instagram Graph sürümü: {config.instagram.graphVersion}</li>
          <li>Stratejik platformların hiçbiri bu geliştirme ortamında gerçek hesapla test edilmedi; testler sahte sağlayıcıyla yapıldı.</li>
        </ul>
      </section>
    </div>
  );
}
