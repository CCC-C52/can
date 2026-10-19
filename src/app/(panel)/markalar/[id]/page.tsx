import Link from "next/link";
import { notFound } from "next/navigation";
import { flash, getCurrentBrand, type SP } from "@/lib/current";
import { getBrand, listBrandFacts, listProducts } from "@/lib/services/brands";
import { listMedia } from "@/lib/services/media";
import { PROVIDERS, effectiveStatus } from "@/lib/services/connections";
import { addBrandFactAction, deleteBrandFactAction, selectBrandAction, updateBrandAction } from "@/app/actions";
import { Badge, Flash, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { BrandFields } from "@/components/brand-form";
import { CONNECTION_STATUS_LABEL, CONNECTION_STATUS_TONE } from "@/lib/labels";

const KIND: Record<string, string> = { decision: "Onaylanmış karar", fact: "Doğrulanmış bilgi", forbidden_claim: "Yasaklı ifade" };

export default async function BrandPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const { ok, err } = await flash(searchParams);
  const { brand: current } = await getCurrentBrand();
  const b = await getBrand(id);
  if (!b) notFound();
  if (current?.id !== b.id) {
    return (
      <div className="card">
        <p className="text-sm">Bu markayı düzenlemek için önce seçin (markalar arası veri karışmasını önlemek için işlemler yalnızca seçili markada yapılır).</p>
        <form action={selectBrandAction} className="mt-3"><input type="hidden" name="brandId" value={b.id} /><input type="hidden" name="back" value={`/markalar/${b.id}`} /><button className="btn-primary">{b.name} markasını seç</button></form>
      </div>
    );
  }
  const [facts, products, logos, conns] = await Promise.all([
    listBrandFacts(b.id), listProducts(b.id), listMedia(b.id, { kind: "logo" }),
    Promise.all(PROVIDERS.filter((p) => p.scope === "brand").map(async (p) => ({ p, s: await effectiveStatus(p.id, b.id) }))),
  ]);
  return (
    <div>
      <PageHeader title={b.name} subtitle={<>{b.is_sample && <Badge tone="demo">ÖRNEK MARKA — kurgusal veri</Badge>} Boş alanlar ajanlara “BİLİNMİYOR” olarak iletilir.</>} />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 xl:grid-cols-3">
        <section className="card xl:col-span-2">
          <form action={updateBrandAction} className="space-y-3">
            <BrandFields b={b} />
            <label className="block"><span className="label">Logo (medya arşivinden)</span>
              <select name="logo_asset_id" defaultValue={b.logo_asset_id ?? ""} className="input"><option value="">Yok / bilinmiyor</option>{logos.map((l) => <option key={l.id} value={l.id}>{l.filename}</option>)}</select>
              {logos.length === 0 && <span className="text-xs text-muted">Logo yüklemek için Medya arşivinde türü “Logo” seçin.</span>}
            </label>
            <SubmitButton>Kaydet</SubmitButton>
          </form>
        </section>
        <div className="space-y-4">
          <section className="card">
            <h2 className="h2 mb-2">Kararlar ve doğrulanmış bilgiler</h2>
            <ul className="space-y-2 text-sm">
              {facts.map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-2">
                  <div><Badge tone={f.kind === "forbidden_claim" ? "bad" : f.kind === "decision" ? "info" : "ok"}>{KIND[f.kind] ?? f.kind}</Badge> <span>{f.statement}</span></div>
                  <form action={deleteBrandFactAction}><input type="hidden" name="id" value={f.id} /><button className="text-xs text-red-700">Sil</button></form>
                </li>
              ))}
              {facts.length === 0 && <li className="muted">Kayıt yok.</li>}
            </ul>
            <form action={addBrandFactAction} className="mt-3 space-y-2">
              <select name="kind" className="input"><option value="decision">Onaylanmış karar</option><option value="fact">Doğrulanmış marka bilgisi</option><option value="forbidden_claim">Yasaklı ifade (asla kullanılmaz)</option></select>
              <textarea name="statement" rows={2} className="input" required placeholder="Örn: İndirimler yalnızca Kasım'da yapılır." />
              <SubmitButton className="btn">Ekle</SubmitButton>
            </form>
          </section>
          <section className="card">
            <h2 className="h2 mb-2">Ürünler ({products.length})</h2>
            <ul className="text-sm">{products.slice(0, 8).map((p) => <li key={p.id}><Link href={`/urunler/${p.id}`} className="text-brand">{p.title}</Link></li>)}</ul>
            <Link href="/urunler" className="btn mt-2">Ürünleri yönet</Link>
          </section>
          <section className="card">
            <h2 className="h2 mb-2">Bağlı hesaplar</h2>
            <ul className="space-y-1 text-sm">{conns.map(({ p, s }) => <li key={p.id} className="flex justify-between gap-2"><span>{p.name}</span><Badge tone={CONNECTION_STATUS_TONE[s.status]}>{CONNECTION_STATUS_LABEL[s.status]}</Badge></li>)}</ul>
            <Link href="/entegrasyonlar" className="btn mt-2">Entegrasyonlar</Link>
          </section>
        </div>
      </div>
    </div>
  );
}
