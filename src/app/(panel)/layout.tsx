import Link from "next/link";
import { getCurrentBrand } from "@/lib/current";
import { textModelMode } from "@/lib/models";
import { isPaused } from "@/lib/settings";
import { loginRequired } from "@/lib/auth";
import { config } from "@/lib/config";
import { q1 } from "@/lib/db/pool";
import { pendingApprovals } from "@/lib/services/outputs";
import { navAwaiting } from "@/lib/integrations/service";
import { selectBrandAction, logoutAction, pauseAction } from "@/app/actions";
import { BottomBar, MobileNav, NavLinks, QuickNav } from "@/components/nav";
import { Icon } from "@/components/icons";
import { StatusDot } from "@/components/ui";
import type { Brand } from "@/lib/services/brands";

export const dynamic = "force-dynamic";

function BrandLockup({ brand, compact = false }: { brand: Brand | null; compact?: boolean }) {
  return (
    <Link href="/" className="flex min-w-0 flex-col items-start gap-1 rounded-xl" aria-label={`${brand?.name ?? "AI Operations Studio"} — ana ekran`}>
      {brand?.logo_asset_id ? (
        // Marka Yönetimi'nde seçili gerçek logo (yalnızca ölçeklenir)
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/media/${brand.logo_asset_id}/preview?w=160`} alt="" className={`${compact ? "h-7" : "h-9"} w-auto max-w-[9rem] shrink-0 object-contain`} />
      ) : (
        <span className={`block max-w-full truncate font-display ${compact ? "max-w-[8rem] text-lg" : "text-[1.35rem]"} leading-tight font-semibold tracking-tight text-ink`}>{brand?.name ?? "AI Ops"}</span>
      )}
      {!compact && <span className="eyebrow text-[9.5px] leading-tight">AI Operations Studio</span>}
    </Link>
  );
}

function SystemStatus({ mode, workerAlive }: { mode: ReturnType<typeof textModelMode>; workerAlive: boolean }) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <StatusDot tone={mode.mode === "real" ? "ok" : mode.mode === "demo" ? "demo" : "warn"} />
        <span className="text-ink-soft">{mode.mode === "real" ? "Gerçek AI bağlı" : mode.mode === "demo" ? "DEMO modu" : "AI bağlı değil"}</span>
      </div>
      <div className="flex items-center gap-2">
        <StatusDot tone={workerAlive ? "ok" : "bad"} pulse={workerAlive} />
        <span className="text-ink-soft">{workerAlive ? "Görev işleyicisi çalışıyor" : "Görev işleyicisi yanıt vermiyor"}</span>
      </div>
      <Link href="/tanilama" className="inline-flex items-center gap-1 text-muted hover:text-ink">Sistem durumu<Icon name="arrow-right" className="h-3 w-3" /></Link>
    </div>
  );
}

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const [{ brand, brands }, paused] = await Promise.all([getCurrentBrand(), isPaused()]);
  const mode = textModelMode();
  const [awaiting, approvals, worker] = await Promise.all([
    brand ? navAwaiting(brand.id) : Promise.resolve([] as string[]),
    brand ? pendingApprovals(brand.id).then((a) => a.length).catch(() => 0) : Promise.resolve(0),
    q1<{ last_seen: string }>(`SELECT last_seen FROM worker_heartbeats ORDER BY last_seen DESC LIMIT 1`).catch(() => null),
  ]);
  const workerAlive = !!worker && Date.now() - new Date(worker.last_seen).getTime() < 60_000;
  return (
    <div className="min-h-screen lg:pl-[17rem]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-xl focus:bg-brand focus:px-3 focus:py-2 focus:text-on-brand">İçeriğe geç</a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[17rem] flex-col border-r border-line bg-panel/85 backdrop-blur-xl lg:flex">
        <div className="px-5 pt-6 pb-5"><BrandLockup brand={brand} /></div>
        <nav aria-label="Ana menü" className="min-h-0 flex-1 overflow-y-auto px-3 pb-6"><NavLinks awaiting={awaiting} /></nav>
        <div className="border-t border-line px-5 py-4"><SystemStatus mode={mode} workerAlive={workerAlive} /></div>
      </aside>

      <header className="safe-top sticky top-0 z-20 border-b border-line bg-canvas/80 backdrop-blur-xl">
        <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
          <MobileNav awaiting={awaiting} footer={<SystemStatus mode={mode} workerAlive={workerAlive} />} />
          <div className="lg:hidden"><BrandLockup brand={brand} compact /></div>
          <div className="hidden min-w-0 flex-1 md:block"><QuickNav /></div>
          <div className="ml-auto flex items-center gap-2">
            {mode.mode === "demo" ? (
              <span className="hidden rounded-full bg-demo-soft px-2.5 py-1 text-xs font-medium text-demo ring-1 ring-demo-line sm:inline" title={mode.label}>DEMO modu</span>
            ) : mode.mode === "off" ? (
              <span className="hidden rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning ring-1 ring-warning-line sm:inline">AI bağlı değil</span>
            ) : (
              <span className="hidden items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success ring-1 ring-success-line xl:inline-flex"><StatusDot tone="ok" />Gerçek AI</span>
            )}
            <Link href="/onaylar" className="btn relative hidden h-9 w-9 px-0 md:inline-flex" aria-label={`Onay Merkezi: ${approvals} bekleyen`}>
              <Icon name="check" />
              {approvals > 0 && <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-brand px-1 text-center text-[10px] leading-4 font-semibold text-on-brand">{approvals > 99 ? "99+" : approvals}</span>}
            </Link>
            {brands.length > 0 && (
              <form action={selectBrandAction} className="flex items-center gap-1">
                <label className="sr-only" htmlFor="brandSel">Marka</label>
                <select id="brandSel" name="brandId" defaultValue={brand?.id} className="input h-9 max-w-[7.5rem] py-1.5 sm:max-w-[9.5rem]">
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <button className="btn h-9 py-1.5">Seç</button>
              </form>
            )}
            {loginRequired() && (
              <form action={logoutAction} className="hidden md:block"><button className="btn h-9 py-1.5">Çıkış</button></form>
            )}
          </div>
        </div>
      </header>

      {paused && (
        <div className="border-b border-warning-line bg-warning-soft">
          <form action={pauseAction} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm text-warning sm:px-6 lg:px-8">
            <Icon name="pause" /><strong>Tüm işlemler durduruldu.</strong> Yeni görev başlatılmıyor.
            <input type="hidden" name="paused" value="false" />
            <button className="btn ml-auto py-1">Devam ettir</button>
          </form>
        </div>
      )}
      {mode.mode === "off" && (
        <div className="border-b border-warning-line bg-warning-soft">
          <div className="px-4 py-1.5 text-xs text-warning sm:px-6 lg:px-8">
            AI modeli bağlı değil. Canlı ortamda DEMO kapalıdır; görevler “Bağlantı bekliyor” durumunda kalır. Barındırma panelinde <strong>AIOPS_ANTHROPIC_API_KEY</strong> ekleyip servisleri yeniden başlatın, ardından Entegrasyonlar → “Bağlantı bekleyenleri tekrar dene”.
          </div>
        </div>
      )}
      {mode.mode === "demo" && (
        <div className="border-b border-demo-line bg-demo-soft/60">
          <div className="px-4 py-1.5 text-xs text-demo sm:px-6 lg:px-8">
            DEMO modu: model anahtarı yok. Ajan çıktıları kural tabanlı şablonlardır ve <strong>gerçek AI üretimi değildir</strong>. Gerçek mod için sunucu ortamına AIOPS_ANTHROPIC_API_KEY tanımlayın.
          </div>
        </div>
      )}

      <main id="main" className="mx-auto w-full max-w-[1440px] px-4 pt-6 pb-28 sm:px-6 md:pb-10 lg:px-8 lg:pt-8">
        {!brand ? (
          <div className="card">
            <h1 className="h1">Hoş geldiniz</h1>
            <p className="muted mt-2">Henüz marka yok. Başlamak için bir marka oluşturun{config.demoAllowed ? " veya açıkça işaretlenmiş örnek demo markayı yükleyin" : ""}.</p>
            <div className="mt-4"><Link className="btn-primary" href="/markalar">Marka yönetimine git</Link></div>
            <div className="mt-6">{children}</div>
          </div>
        ) : (
          <div className="animate-rise">{children}</div>
        )}
      </main>
      <BottomBar approvals={approvals} />
    </div>
  );
}
