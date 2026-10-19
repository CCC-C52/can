import Link from "next/link";
import { flash, getCurrentBrand, type SP } from "@/lib/current";
import { createBrandAction, seedSampleAction } from "@/app/actions";
import { Badge, Flash, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { BrandFields } from "@/components/brand-form";
import { langLabel } from "@/lib/labels";
import { config } from "@/lib/config";

export default async function Brands({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const { brand: current, brands } = await getCurrentBrand();
  return (
    <div>
      <PageHeader title="Marka yönetimi" subtitle="Her markanın verileri, medyası ve bağlantıları ayrı tutulur." />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card lg:col-span-1">
          <h2 className="h2 mb-2">Markalar</h2>
          <ul className="divide-y divide-line">
            {brands.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <Link href={`/markalar/${b.id}`} className="font-medium text-brand">{b.name}</Link>
                <span className="flex gap-1">{b.is_sample && <Badge tone="demo">ÖRNEK</Badge>}{current?.id === b.id && <Badge tone="info">Seçili</Badge>}<Badge>{langLabel(b.content_language)}</Badge></span>
              </li>
            ))}
            {brands.length === 0 && <li className="muted py-2">Marka yok.</li>}
          </ul>
          {config.demoAllowed && (
            <form action={seedSampleAction} className="mt-4">
              <SubmitButton className="btn w-full">Örnek DEMO markayı yükle</SubmitButton>
              <p className="mt-1 text-xs text-muted">Kurgusal verilerle, açıkça “ÖRNEK” işaretli test markası. Gerçek marka bilgisi içermez.</p>
            </form>
          )}
        </section>
        <section className="card lg:col-span-2">
          <h2 className="h2 mb-3">Yeni marka</h2>
          <form action={createBrandAction} className="space-y-3">
            <BrandFields />
            <SubmitButton>Markayı oluştur</SubmitButton>
          </form>
        </section>
      </div>
    </div>
  );
}
