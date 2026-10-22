import Link from "next/link";
import { getCurrentBrand } from "@/lib/current";
import { textModelMode } from "@/lib/models";
import { isPaused } from "@/lib/settings";
import { loginRequired } from "@/lib/auth";
import { config } from "@/lib/config";
import { selectBrandAction, logoutAction, pauseAction } from "@/app/actions";
import { MobileNavToggle } from "@/components/client";
import { NavLinks } from "@/components/nav";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const [{ brand, brands }, paused] = await Promise.all([getCurrentBrand(), isPaused()]);
  const mode = textModelMode();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur">
        <div className="relative mx-auto flex h-14 max-w-7xl items-center gap-2 px-4">
          <Link href="/" className="mr-2 whitespace-nowrap font-semibold tracking-tight">AI Ops Studio</Link>
          {mode.mode === "demo" ? (
            <span className="hidden rounded-full bg-fuchsia-50 px-2 py-0.5 text-xs font-medium text-fuchsia-700 ring-1 ring-fuchsia-200 sm:inline" title={mode.label}>DEMO modu</span>
          ) : mode.mode === "off" ? (
            <span className="hidden rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 sm:inline">AI bağlı değil</span>
          ) : (
            <span className="hidden rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200 sm:inline">Gerçek AI</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {brands.length > 0 && (
              <form action={selectBrandAction} className="flex items-center gap-1">
                <label className="sr-only" htmlFor="brandSel">Marka</label>
                <select id="brandSel" name="brandId" defaultValue={brand?.id} className="input max-w-[11rem] py-1.5">
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <button className="btn py-1.5">Seç</button>
              </form>
            )}
            {loginRequired() && (
              <form action={logoutAction} className="hidden md:block"><button className="btn py-1.5">Çıkış</button></form>
            )}
            <MobileNavToggle><NavLinks /></MobileNavToggle>
          </div>
        </div>
      </header>
      {paused && (
        <div className="border-b border-amber-200 bg-amber-50">
          <form action={pauseAction} className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2 text-sm text-amber-900">
            <strong>Tüm işlemler durduruldu.</strong> Yeni görev başlatılmıyor.
            <input type="hidden" name="paused" value="false" />
            <button className="btn ml-auto py-1">Devam ettir</button>
          </form>
        </div>
      )}
      {mode.mode === "off" && (
        <div className="border-b border-amber-200 bg-amber-50">
          <div className="mx-auto max-w-7xl px-4 py-1.5 text-xs text-amber-900">
            AI modeli bağlı değil. Canlı ortamda DEMO kapalıdır; görevler “Bağlantı bekliyor” durumunda kalır. Barındırma panelinde <strong>AIOPS_ANTHROPIC_API_KEY</strong> ekleyip servisleri yeniden başlatın, ardından Entegrasyonlar → “Bağlantı bekleyenleri tekrar dene”.
          </div>
        </div>
      )}
      {mode.mode === "demo" && (
        <div className="border-b border-fuchsia-100 bg-fuchsia-50/60">
          <div className="mx-auto max-w-7xl px-4 py-1.5 text-xs text-fuchsia-800">
            DEMO modu: model anahtarı yok. Ajan çıktıları kural tabanlı şablonlardır ve <strong>gerçek AI üretimi değildir</strong>. Gerçek mod için sunucu ortamına AIOPS_ANTHROPIC_API_KEY tanımlayın.
          </div>
        </div>
      )}
      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-5">
        <aside className="hidden w-52 shrink-0 md:block">
          <nav aria-label="Ana menü" className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-4"><NavLinks /></nav>
        </aside>
        <main className="min-w-0 flex-1">
          {!brand ? (
            <div className="card">
              <h1 className="h1">Hoş geldiniz</h1>
              <p className="muted mt-2">Henüz marka yok. Başlamak için bir marka oluşturun{config.demoAllowed ? " veya açıkça işaretlenmiş örnek demo markayı yükleyin" : ""}.</p>
              <div className="mt-4"><Link className="btn-primary" href="/markalar">Marka yönetimine git</Link></div>
              <div className="mt-6">{children}</div>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
