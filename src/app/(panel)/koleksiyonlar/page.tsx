import Link from "next/link";
import { requireBrand } from "@/lib/current";
import { q } from "@/lib/db/pool";
import { AwaitingSetup, Badge, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";
import { collectionsOverview } from "@/lib/services/hq";
import { VIEW_LABEL, type ReferenceView } from "@/lib/drive/themes";

export const metadata = { title: "Koleksiyonlar" };
export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  const brand = await requireBrand();
  const [overview, refs] = await Promise.all([
    collectionsOverview(brand.id),
    q<{ theme: string; view: ReferenceView; media_asset_id: string | null; name: string; verified_at: string }>(
      `SELECT r.theme, r.view, r.media_asset_id, i.name, r.verified_at FROM drive_references r JOIN drive_items i ON i.id = r.item_id AND i.brand_id = r.brand_id
       WHERE r.brand_id = $1 AND r.status = 'verified' ORDER BY r.theme, (r.view = 'front') DESC, r.verified_at DESC`, [brand.id]),
  ]);
  return (
    <div>
      <PageHeader eyebrow="Marka" title="Koleksiyonlar"
        subtitle="Yalnızca sahibin doğruladığı gerçek ürün görselleri. Baskı, kalıp, renk ve koleksiyon adı hiçbir üretimde değiştirilmez; doğrulanmamış görsel kullanılmaz."
        actions={<><Link href="/drive-arsivi?tab=review" className="btn"><Icon name="check" />Görsel onayla</Link><Link href="/studyo/video" className="btn-primary"><Icon name="film" />Koleksiyon videosu</Link></>} />
      {!overview.anyVerified && (
        <div className="mb-6"><AwaitingSetup title="Doğrulanmış ürün görseli yok" href="/drive-arsivi?tab=review" linkLabel="Drive Arşivi → İnceleme">Drive arşivindeki ürün fotoğraflarını onayladığınızda koleksiyonlar burada görünür.</AwaitingSetup></div>
      )}
      <div className="space-y-6">
        {overview.themes.map((t) => {
          const items = refs.filter((r) => r.theme === t.theme);
          return (
            <section key={t.theme} id={t.theme} className="card scroll-mt-24" aria-labelledby={`col-${t.theme}`}>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="eyebrow mb-1">{t.garment} ürün</div>
                  <h2 id={`col-${t.theme}`} className="font-display text-3xl leading-tight">{t.label}</h2>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={t.verified ? "ok" : "neutral"}>{t.verified} doğrulanmış görsel</Badge>
                  <Badge tone={t.imported === t.verified ? "ok" : "warn"}>{t.imported} orijinal arşivde</Badge>
                  {t.confirmedColor ? <Badge tone="info">Onaylı renk: {t.confirmedColor}</Badge> : <Badge>Renk bilgisi onaylanmadı</Badge>}
                </div>
              </div>
              {items.length === 0 ? <p className="mt-4 text-sm text-muted">Bu koleksiyon için doğrulanmış görsel yok.</p> : (
                <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
                  {items.slice(0, 18).map((r) => (
                    <li key={`${r.name}-${r.verified_at}`} className="overflow-hidden rounded-2xl border border-line bg-surface-2">
                      <div className="aspect-[4/5] bg-surface-3">
                        {r.media_asset_id ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`/api/media/${r.media_asset_id}/preview?w=640`} alt={`${t.label} — ${VIEW_LABEL[r.view]} görünüm`} loading="lazy" className="h-full w-full object-cover" />
                        ) : <div className="grid h-full place-items-center p-3 text-center text-xs text-muted">Orijinal içe alınıyor…</div>}
                      </div>
                      <div className="flex items-center justify-between gap-2 p-2 text-xs"><span className="truncate text-ink-soft" title={r.name}>{r.name}</span><span className="shrink-0 text-muted">{VIEW_LABEL[r.view]}</span></div>
                    </li>
                  ))}
                </ul>
              )}
              {items.length > 18 && <p className="mt-3 text-xs text-muted">+{items.length - 18} görsel daha — <Link href="/drive-arsivi?tab=hub" className="link">tümü</Link></p>}
            </section>
          );
        })}
      </div>
      <p className="mt-6 text-xs text-muted">{overview.products} aktif ürün kaydı · <Link href="/urunler" className="link">Ürünler</Link> · <Link href="/bilgi" className="link">Marka Bilgi Merkezi</Link></p>
    </div>
  );
}
