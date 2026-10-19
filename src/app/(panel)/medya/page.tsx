import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { listMedia } from "@/lib/services/media";
import { listProducts } from "@/lib/services/brands";
import { Empty, Flash, PageHeader } from "@/components/ui";
import { MediaThumb } from "@/components/previews";
import { Uploader } from "@/components/uploader";
import { MEDIA_ORIGIN_LABEL } from "@/lib/labels";

export default async function MediaPage({ searchParams }: { searchParams: SP }) {
  const { ok, err, one } = await flash(searchParams);
  const brand = await requireBrand();
  const filters = { kind: one("kind"), origin: one("origin"), productId: one("productId"), search: one("q") };
  const [media, products] = await Promise.all([listMedia(brand.id, filters), listProducts(brand.id)]);
  return (
    <div>
      <PageHeader title="Medya arşivi" subtitle={`${media.length} dosya · yalnızca ${brand.name} markasına ait`} />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <form className="card mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            <input name="q" defaultValue={filters.search} placeholder="Ara (ad, etiket, tema)" className="input md:col-span-2" />
            <select name="kind" defaultValue={filters.kind ?? ""} className="input"><option value="">Tüm türler</option><option value="photo">Fotoğraf</option><option value="video">Video</option><option value="logo">Logo</option><option value="design">Tasarım</option><option value="document">Belge</option></select>
            <select name="origin" defaultValue={filters.origin ?? ""} className="input"><option value="">Tüm kökenler</option>{Object.entries(MEDIA_ORIGIN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <select name="productId" defaultValue={filters.productId ?? ""} className="input"><option value="">Tüm ürünler</option>{products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
            <div className="col-span-2 flex gap-2 md:col-span-5"><button className="btn">Filtrele</button><Link href="/medya" className="btn">Temizle</Link></div>
          </form>
          {media.length === 0 ? <Empty>Dosya yok.</Empty> : <div className="grid grid-cols-2 gap-3 md:grid-cols-3">{media.map((m) => <MediaThumb key={m.id} m={m} />)}</div>}
        </div>
        <section className="card h-fit">
          <h2 className="h2 mb-2">Dosya yükle</h2>
          <Uploader products={products.map((p) => ({ id: p.id, title: p.title }))} />
        </section>
      </div>
    </div>
  );
}
