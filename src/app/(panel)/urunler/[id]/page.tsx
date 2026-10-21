import { notFound } from "next/navigation";
import { requireBrand, flash, type SP } from "@/lib/current";
import { getProduct, listVariants, listProductFacts } from "@/lib/services/brands";
import { listMedia } from "@/lib/services/media";
import { addProductFactAction, addVariantAction, deleteProductFactAction, deleteVariantAction, updateProductAction } from "@/app/actions";
import { Badge, Flash, PageHeader, Val } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { MediaThumb } from "@/components/previews";

export default async function ProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const p = await getProduct(brand.id, id);
  if (!p) notFound();
  const [variants, facts, media] = await Promise.all([listVariants(brand.id, id), listProductFacts(brand.id, id), listMedia(brand.id, { productId: id })]);
  return (
    <div>
      <PageHeader title={p.title} subtitle={<>{p.is_sample && <Badge tone="demo">ÖRNEK</Badge>} {p.shopify_product_id ? `Shopify: ${p.shopify_product_id}` : "Shopify ile eşleşmemiş"}</>} />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 xl:grid-cols-3">
        <section className="card xl:col-span-2">
          <form action={updateProductAction} className="grid gap-2 md:grid-cols-2">
            <input type="hidden" name="id" value={p.id} />
            <label className="md:col-span-2"><span className="label">Ad</span><input name="title" defaultValue={p.title} className="input" /></label>
            <label className="md:col-span-2"><span className="label">Mevcut açıklama</span><textarea name="description" rows={4} defaultValue={p.description ?? ""} className="input" /></label>
            <label><span className="label">Tip</span><input name="product_type" defaultValue={p.product_type ?? ""} className="input" /></label>
            <label><span className="label">Durum</span><select name="status" defaultValue={p.status} className="input"><option value="draft">Taslak</option><option value="active">Aktif</option><option value="archived">Arşiv</option></select></label>
            <label><span className="label">Fiyat (boş = bilinmiyor)</span><input name="price" defaultValue={p.price ?? ""} className="input" /></label>
            <label><span className="label">Eski fiyat</span><input name="compare_at_price" defaultValue={p.compare_at_price ?? ""} className="input" /></label>
            <label><span className="label">Para birimi</span><input name="currency" defaultValue={p.currency ?? ""} className="input" /></label>
            <div className="flex items-end"><SubmitButton>Kaydet</SubmitButton></div>
          </form>
          <p className="mt-2 text-xs text-muted">Bu kayıt yerel referanstır. Canlı mağazadaki değişiklik yalnızca onaylı Shopify önerisiyle yapılır.</p>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Doğrulanmış özellikler</h2>
          <p className="mb-2 text-xs text-muted">Ajanlar müşteri metinlerinde yalnızca “doğrulanmış” özellikleri kullanır; kalite kontrolü doğrulanmamış özellikleri işaretler.</p>
          <ul className="space-y-1 text-sm">
            {facts.map((f) => (
              <li key={f.id} className="flex items-start justify-between gap-2"><span><Badge tone={f.status === "verified" ? "ok" : "warn"}>{f.status === "verified" ? "Doğrulandı" : "Doğrulanmadı"}</Badge> <strong>{f.attribute}:</strong> {f.value} <span className="text-xs text-muted">({f.source ?? "kaynak yok"})</span></span>
                <form action={deleteProductFactAction}><input type="hidden" name="id" value={f.id} /><input type="hidden" name="productId" value={p.id} /><button className="text-xs text-red-700">Sil</button></form></li>
            ))}
          </ul>
          <form action={addProductFactAction} className="mt-3 space-y-2">
            <input type="hidden" name="productId" value={p.id} />
            <div className="grid grid-cols-2 gap-2"><input name="attribute" required className="input" placeholder="Özellik (ör. Kumaş)" /><input name="value" required className="input" placeholder="Değer (ör. %100 pamuk)" /></div>
            <div className="grid grid-cols-2 gap-2"><select name="status" className="input" aria-label="Doğrulama durumu"><option value="verified">Doğrulandı</option><option value="unverified">Doğrulanmadı</option></select><input name="source" className="input" placeholder="Kaynak (ör. tedarikçi belgesi)" /></div>
            <SubmitButton className="btn">Özellik ekle</SubmitButton>
          </form>
        </section>
        <section className="card xl:col-span-2">
          <h2 className="h2 mb-2">Varyantlar</h2>
          <div tabIndex={0} className="overflow-x-auto"><table className="table"><thead><tr><th>Ad</th><th>SKU</th><th>Renk</th><th>Beden</th><th>Fiyat</th><th>Stok</th><th></th></tr></thead>
            <tbody>{variants.map((v) => (
              <tr key={v.id}><td>{v.title}</td><td><Val v={v.sku} /></td><td><Val v={v.color} /></td><td><Val v={v.size} /></td><td><Val v={v.price} /></td><td><Val v={v.inventory_quantity} /></td>
                <td><form action={deleteVariantAction}><input type="hidden" name="id" value={v.id} /><input type="hidden" name="productId" value={p.id} /><button className="text-xs text-red-700">Sil</button></form></td></tr>
            ))}</tbody></table></div>
          <form action={addVariantAction} className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
            <input type="hidden" name="productId" value={p.id} />
            <input name="title" required className="input lg:col-span-2" placeholder="Varyant adı *" /><input name="sku" className="input" placeholder="SKU" /><input name="color" className="input" placeholder="Renk" /><input name="size" className="input" placeholder="Beden" /><input name="price" className="input" placeholder="Fiyat" /><input name="inventory_quantity" className="input" placeholder="Stok" />
            <div className="sm:col-span-3 lg:col-span-7"><SubmitButton className="btn">Varyant ekle</SubmitButton></div>
          </form>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Ürün medyası ({media.length})</h2>
          <div className="grid grid-cols-2 gap-2">{media.slice(0, 6).map((m) => <MediaThumb key={m.id} m={m} />)}</div>
        </section>
      </div>
    </div>
  );
}
