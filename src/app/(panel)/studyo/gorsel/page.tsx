import { randomUUID } from "node:crypto";
import Link from "next/link";
import { flash, requireBrand, type SP } from "@/lib/current";
import { listMedia } from "@/lib/services/media";
import { getLimits } from "@/lib/settings";
import { listOutputs } from "@/lib/services/outputs";
import { imageStudioAction } from "@/app/actions";
import { Badge, Empty, Flash, PageHeader, dt } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { VisionStatus } from "../vision-status";

export const dynamic = "force-dynamic";

export default async function ImageStudio({ searchParams }: { searchParams: SP }) {
  const brand = await requireBrand();
  const { ok, err } = await flash(searchParams);
  const [photos, limits, outputs] = await Promise.all([
    listMedia(brand.id, { kind: "photo" }),
    getLimits(),
    listOutputs(brand.id, { limit: 50 }),
  ]);
  const real = photos.filter((p) => p.origin === "real_photo").slice(0, 60);
  const designs = outputs.filter((o) => o.agent === "design").slice(0, 10);
  return (
    <div>
      <PageHeader title="Görsel Stüdyosu" subtitle="Gerçek ürün fotoğraflarından gönderi ve story görselleri. Talep Ana Yönetici'ye gider; kalite kontrolü ve onayınız olmadan yayınlanmaz." />
      <Flash ok={ok} err={err} />
      <VisionStatus />
      <p className="mb-4 text-sm">
        AI görsel üretimi: <Badge tone={limits.paidMediaGeneration ? "ok" : "neutral"}>{limits.paidMediaGeneration ? "Ücretli üretim izinli" : "Kapalı — yalnızca gerçek fotoğraflardan kompozisyon"}</Badge>
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        <form action={imageStudioAction} className="card space-y-3 lg:col-span-2">
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <fieldset>
            <legend className="h2 mb-2">Ürün fotoğrafları (isteğe bağlı)</legend>
            {real.length === 0 ? <Empty>Arşivde gerçek ürün fotoğrafı yok. <Link href="/medya" className="text-brand underline">Medya arşivi</Link>nden yükleyin.</Empty> : (
              <ul className="grid max-h-96 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {real.map((p) => (
                  <li key={p.id}>
                    <label className="flex cursor-pointer flex-col gap-1 rounded-lg border border-line p-2 text-xs hover:bg-gray-50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/media/${p.id}/file`} alt={p.alt_text ?? p.filename} className="h-24 w-full rounded object-cover" loading="lazy" />
                      <span className="flex items-center gap-1"><input type="checkbox" name="assetIds" value={p.id} /> <span className="truncate">{p.filename}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm"><span className="label">Biçim</span><select name="format" className="input"><option value="post">Gönderi 1:1</option><option value="portrait">Dikey gönderi 4:5</option><option value="story">Story 9:16</option></select></label>
            <label className="block text-sm"><span className="label">Adet</span><input name="count" type="number" min={1} max={6} defaultValue={3} className="input" /></label>
          </div>
          <label className="block text-sm"><span className="label">Amaç ve notlar</span><textarea name="goal" rows={3} maxLength={1500} className="input" placeholder="Örn: Hafta sonu kampanyası; sade arka plan; marka renkleri." /></label>
          <SubmitButton className="btn-primary">Ana Yönetici&apos;ye gönder</SubmitButton>
        </form>
        <section className="card h-fit">
          <h2 className="h2 mb-2">Son tasarım çıktıları</h2>
          {designs.length === 0 ? <p className="muted text-sm">Henüz yok.</p> : (
            <ul className="space-y-1 text-sm">{designs.map((o) => <li key={o.id}><Link href={`/taslaklar/${o.id}`} className="text-brand">{o.title}</Link> <span className="text-xs text-muted">{dt(o.created_at)}</span></li>)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}
