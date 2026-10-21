import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { listMedia } from "@/lib/services/media";
import { listProducts } from "@/lib/services/brands";
import { Empty, Flash, PageHeader } from "@/components/ui";
import { MediaThumb } from "@/components/previews";
import { Uploader } from "@/components/uploader";
import { MEDIA_ORIGIN_LABEL } from "@/lib/labels";
import { backfillAnalysesAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { visionModel, ANALYSIS_VERSION } from "@/lib/media-analysis";
import { q1 } from "@/lib/db/pool";

export default async function MediaPage({ searchParams }: { searchParams: SP }) {
  const { ok, err, one } = await flash(searchParams);
  const brand = await requireBrand();
  const filters = { kind: one("kind"), origin: one("origin"), productId: one("productId"), search: one("q") };
  const [media, products, miss] = await Promise.all([
    listMedia(brand.id, filters), listProducts(brand.id),
    q1<{ n: number }>(`SELECT COUNT(*)::int AS n FROM media_assets m WHERE m.brand_id = $1 AND m.origin IN ('real_photo','real_video','design_file','ai_generated')
      AND NOT EXISTS (SELECT 1 FROM media_analyses a WHERE a.asset_id = m.id AND a.analysis_version = $2 AND a.status IN ('pending','processing','completed'))`, [brand.id, ANALYSIS_VERSION]),
  ]);
  const missing = miss?.n ?? 0;
  const vision = !!visionModel();
  return (
    <div>
      <PageHeader title="Medya arşivi" subtitle={`${media.length} dosya · yalnızca ${brand.name} markasına ait`} />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <form className="card mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            <input name="q" defaultValue={filters.search} placeholder="Ara (ad, etiket, tema)" className="input md:col-span-2" />
            <select name="kind" defaultValue={filters.kind ?? ""} className="input" aria-label="Tür filtresi"><option value="">Tüm türler</option><option value="photo">Fotoğraf</option><option value="video">Video</option><option value="logo">Logo</option><option value="design">Tasarım</option><option value="document">Belge</option></select>
            <select name="origin" defaultValue={filters.origin ?? ""} className="input" aria-label="Köken filtresi"><option value="">Tüm kökenler</option>{Object.entries(MEDIA_ORIGIN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <select name="productId" defaultValue={filters.productId ?? ""} className="input" aria-label="Ürün filtresi"><option value="">Tüm ürünler</option>{products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
            <div className="col-span-2 flex gap-2 md:col-span-5"><button className="btn">Filtrele</button><Link href="/medya" className="btn">Temizle</Link></div>
          </form>
          {media.length === 0 ? <Empty>Dosya yok.</Empty> : <div className="grid grid-cols-2 gap-3 md:grid-cols-3">{media.map((m) => <MediaThumb key={m.id} m={m} />)}</div>}
        </div>
        <section className="card h-fit">
          <h2 className="h2 mb-2">Dosya yükle</h2>
          <Uploader products={products.map((p) => ({ id: p.id, title: p.title }))} />
        </section>
        <section className="card h-fit lg:col-start-3">
          <h2 className="h2 mb-1">Arşiv analizi</h2>
          <p className="text-xs text-muted">Analizi olmayan dosya: <strong>{missing}</strong>. Yerel piksel analizi ücretsizdir. Görsel model bağlıysa ({vision ? "bağlı" : "bağlı değil"}) her dosya için ücretli bir model çağrısı yapılır (görsel başına yaklaşık {vision ? "0,01–0,05 $" : "—"}) ve bütçe sınırları uygulanır.</p>
          <form action={backfillAnalysesAction} className="mt-2"><SubmitButton className="btn w-full" disabled={missing === 0} confirm={vision ? `${missing} dosya görsel modelle analiz edilecek ve ücretlendirilecek. Devam edilsin mi?` : undefined}>Eksik analizleri başlat</SubmitButton></form>
        </section>
      </div>
    </div>
  );
}
