import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { listProducts, listVariants, listProductFacts } from "@/lib/services/brands";
import { effectiveStatus } from "@/lib/services/connections";
import { createProductAction, shopifySyncAction } from "@/app/actions";
import { Badge, Empty, Flash, PageHeader, Val } from "@/components/ui";
import { SubmitButton } from "@/components/client";

export default async function Products({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const [products, variants, facts, shop] = await Promise.all([listProducts(brand.id), listVariants(brand.id), listProductFacts(brand.id), effectiveStatus("shopify", brand.id)]);
  return (
    <div>
      <PageHeader title="Ürünler" subtitle={`Fiyat kaynağı: ${brand.price_source === "unknown" ? "bilinmiyor" : brand.price_source} · Stok kaynağı: ${brand.inventory_source === "unknown" ? "bilinmiyor" : brand.inventory_source}`}
        actions={shop.status === "connected" ? <form action={shopifySyncAction}><SubmitButton className="btn">Shopify'dan aktar</SubmitButton></form> : <span className="text-xs text-muted">Shopify bağlı değil — ürünler manuel girilir.</span>} />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="lg:col-span-2">
          {products.length === 0 ? <Empty>Ürün yok.</Empty> : (
            <div tabIndex={0} className="card overflow-x-auto p-0">
              <table className="table">
                <thead><tr><th className="pl-4">Ürün</th><th>Fiyat</th><th>Varyant</th><th>Doğrulanmış özellik</th><th>Durum</th></tr></thead>
                <tbody>{products.map((p) => (
                  <tr key={p.id}>
                    <td className="pl-4"><Link className="font-medium text-brand" href={`/urunler/${p.id}`}>{p.title}</Link> {p.is_sample && <Badge tone="demo">ÖRNEK</Badge>}{p.shopify_product_id && <Badge tone="info">Shopify</Badge>}</td>
                    <td className="whitespace-nowrap">{p.price === null ? <Val v={null} /> : `${p.price} ${p.currency ?? ""}`}</td>
                    <td>{variants.filter((v) => v.product_id === p.id).length}</td>
                    <td>{facts.filter((f) => f.product_id === p.id && f.status === "verified").length}{facts.some((f) => f.product_id === p.id && f.status !== "verified") && <span className="ml-1 text-xs text-amber-700">(+doğrulanmamış)</span>}</td>
                    <td>{p.status}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Ürün ekle</h2>
          <form action={createProductAction} className="space-y-2">
            <input name="title" required className="input" placeholder="Ürün adı *" />
            <input name="product_type" className="input" placeholder="Ürün tipi (ör. Tişört)" />
            <textarea name="description" rows={3} className="input" placeholder="Mevcut açıklama (bilinmiyorsa boş)" />
            <div className="grid grid-cols-3 gap-2">
              <input name="price" inputMode="decimal" className="input" placeholder="Fiyat" />
              <input name="compare_at_price" inputMode="decimal" className="input" placeholder="Eski fiyat" />
              <input name="currency" className="input" placeholder="USD" />
            </div>
            <select name="status" className="input" aria-label="Ürün durumu"><option value="draft">Taslak</option><option value="active">Aktif</option><option value="archived">Arşiv</option></select>
            <SubmitButton>Ekle</SubmitButton>
          </form>
        </section>
      </div>
    </div>
  );
}
