import Link from "next/link";
import { notFound } from "next/navigation";
import { requireBrand, flash, type SP } from "@/lib/current";
import { getMedia, mediaLineage } from "@/lib/services/media";
import { listProducts } from "@/lib/services/brands";
import { aiTagAction, updateMediaAction } from "@/app/actions";
import { Badge, Flash, PageHeader, dt } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { MediaThumb } from "@/components/previews";
import { MEDIA_ORIGIN_LABEL, RIGHTS_LABEL } from "@/lib/labels";
import { config } from "@/lib/config";

export default async function MediaDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  const m = await getMedia(brand.id, id);
  if (!m) notFound();
  const [lineage, products] = await Promise.all([mediaLineage(brand.id, id), listProducts(brand.id)]);
  const systemTags = m.tags.filter((t) => t.source === "system" || t.source === "auto" || t.source === "ai");
  const userTags = m.tags.filter((t) => t.source === "user").map((t) => t.tag).join(", ");
  return (
    <div>
      <PageHeader title={m.filename} subtitle={<span className="flex flex-wrap gap-1"><Badge tone={m.origin === "ai_generated" ? "warn" : "neutral"}>{MEDIA_ORIGIN_LABEL[m.origin] ?? m.origin}</Badge><Badge>{m.kind}</Badge><Badge>v{m.version}</Badge><Badge tone={m.rights_status === "restricted" ? "bad" : m.rights_status === "unknown" ? "warn" : "ok"}>Hak: {RIGHTS_LABEL[m.rights_status]}</Badge></span>} />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <MediaThumb m={m} big />
          <section className="card text-sm">
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div><dt className="label">Boyut</dt><dd>{(m.size_bytes / 1024 / 1024).toFixed(2)} MB</dd></div>
              <div><dt className="label">Çözünürlük</dt><dd>{m.width && m.height ? `${m.width}×${m.height}` : "—"}</dd></div>
              <div><dt className="label">Format</dt><dd>{m.format ?? "—"}</dd></div>
              <div><dt className="label">Süre</dt><dd>{m.duration_s ? `${m.duration_s} sn` : "—"}</dd></div>
              <div><dt className="label">Tür</dt><dd>{m.mime_type}</dd></div>
              <div><dt className="label">Yüklenme</dt><dd>{dt(m.created_at)}</dd></div>
              <div className="col-span-2"><dt className="label">SHA-256</dt><dd className="break-all text-xs">{m.sha256}</dd></div>
            </dl>
            <div className="label mt-3">Önceki kullanım</div>
            {m.usage_history.length ? <ul className="text-xs">{m.usage_history.map((u, i) => <li key={i}>{dt(u.date)} · {u.channel} {u.note ?? ""}</li>)}</ul> : <p className="text-xs text-muted">Kayıt yok</p>}
          </section>
          {(lineage.sources.length > 0 || lineage.derived.length > 0) && (
            <section className="card">
              <h2 className="h2 mb-2">Kaynak ve türevler</h2>
              {lineage.sources.length > 0 && <><div className="label">Bu dosyanın kaynakları (orijinaller korunur)</div><div className="grid grid-cols-3 gap-2">{lineage.sources.map((s) => <MediaThumb key={s.id} m={s} />)}</div></>}
              {lineage.derived.length > 0 && <><div className="label mt-3">Bu dosyadan üretilenler</div><div className="grid grid-cols-3 gap-2">{lineage.derived.map((s) => <MediaThumb key={s.id} m={s} />)}</div></>}
            </section>
          )}
        </div>
        <section className="card h-fit">
          <h2 className="h2 mb-2">Bilgiler ve etiketler</h2>
          <form action={updateMediaAction} className="space-y-2">
            <input type="hidden" name="id" value={m.id} />
            <label className="block"><span className="label">Ürün</span><select name="productId" defaultValue={m.product_id ?? ""} className="input"><option value="">Yok</option>{products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
            <label className="block"><span className="label">Köken</span><select name="origin" defaultValue={m.origin} className="input">{Object.entries(MEDIA_ORIGIN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="block"><span className="label">Renkler (virgülle)</span><input name="colors" defaultValue={m.colors.join(", ")} className="input" /></label>
            <label className="block"><span className="label">Temalar (virgülle)</span><input name="themes" defaultValue={m.themes.join(", ")} className="input" /></label>
            <label className="block"><span className="label">Çekim tipi</span><input name="shotType" defaultValue={m.shot_type ?? ""} className="input" /></label>
            <label className="block"><span className="label">Kullanım hakkı</span><select name="rightsStatus" defaultValue={m.rights_status} className="input">{Object.entries(RIGHTS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="block"><span className="label">Hak notu</span><input name="rightsNote" defaultValue={m.rights_note ?? ""} className="input" /></label>
            {systemTags.length > 0 && (
              <fieldset><legend className="label">Otomatik / AI etiketleri (işareti kaldırarak düzeltin)</legend>
                {systemTags.map((t, i) => <label key={i} className="flex items-center gap-2 text-xs"><input type="checkbox" name="keepTag" value={JSON.stringify(t)} defaultChecked /> {t.tag} <Badge tone={t.source === "ai" ? "warn" : "neutral"}>{t.source}</Badge></label>)}
              </fieldset>
            )}
            <label className="block"><span className="label">Kullanıcı etiketleri (virgülle)</span><input name="userTags" defaultValue={userTags} className="input" /></label>
            <SubmitButton>Kaydet</SubmitButton>
          </form>
          {m.kind === "photo" || m.kind === "logo" ? (
            <form action={aiTagAction} className="mt-3">
              <input type="hidden" name="id" value={m.id} />
              {config.anthropic.apiKey ? <SubmitButton className="btn w-full" pendingText="Etiketleniyor…">AI ile etiketle</SubmitButton> : <>
                <button type="button" disabled className="btn w-full">AI ile etiketle (bağlantı bekliyor)</button>
                <p className="mt-1 text-xs text-muted">Anthropic API anahtarı (AIOPS_ANTHROPIC_API_KEY) yok: AI etiketleme kullanılamaz; sahte etiket üretilmez.</p></>}
            </form>
          ) : null}
          {m.source_task_id && <Link href={`/gorevler/${m.source_task_id}`} className="mt-3 block text-xs text-brand">Üreten görev</Link>}
        </section>
      </div>
    </div>
  );
}
