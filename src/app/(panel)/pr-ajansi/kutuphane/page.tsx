import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { AwaitingSetup, Badge, Empty, Flash, PageHeader, Section, dt } from "@/components/ui";
import { Icon } from "@/components/icons";
import { SubmitButton } from "@/components/client";
import { libraryCounts, libraryHistory, searchLibrary, type LibraryEntry, type LibraryKind } from "@/lib/services/library";
import { libraryAddAction, librarySeedAction, libraryVerifyAction } from "@/app/actions/agency";
import type { Tone } from "@/lib/labels";

export const metadata = { title: "PR bilgi kütüphanesi" };
export const dynamic = "force-dynamic";

const KIND: Record<LibraryKind, { label: string; hint: string }> = {
  framework: { label: "Profesyonel çerçeveler", hint: "Yayımlanmış, kaynağı belirtilmiş yöntemler" },
  external_research: { label: "Dış araştırma", hint: "Kaynaklı dış bulgular" },
  ai_recommendation: { label: "AI önerileri", hint: "Öneri — gerçek veya doğrulanmış bilgi değildir" },
};
const VERIFY: Record<LibraryEntry["verification"], { label: string; tone: Tone }> = {
  verified: { label: "Kaynak doğrulandı", tone: "ok" },
  partially_verified: { label: "Kısmen doğrulandı", tone: "info" },
  needs_review: { label: "İnceleme gerekli", tone: "warn" },
};

export default async function LibraryPage({ searchParams }: { searchParams: SP }) {
  const { ok, err, one } = await flash(searchParams);
  const brand = await requireBrand();
  const term = one("q")?.slice(0, 100) ?? "";
  const kind = (Object.keys(KIND) as LibraryKind[]).find((k) => k === one("tur")) ?? null;
  const [entries, counts, history] = await Promise.all([searchLibrary(brand.id, { q: term, kind }), libraryCounts(brand.id), libraryHistory(brand.id, 12)]);
  const total = counts.framework + counts.external_research + counts.ai_recommendation;
  const href = (k: LibraryKind | null) => { const sp = new URLSearchParams(); if (k) sp.set("tur", k); if (term) sp.set("q", term); const s = sp.toString(); return s ? `/pr-ajansi/kutuphane?${s}` : "/pr-ajansi/kutuphane"; };
  return (
    <div>
      <PageHeader
        eyebrow="PR Ajansı"
        title="Profesyonel bilgi kütüphanesi"
        subtitle="Ajansın kullandığı yöntemler kaynaklarıyla birlikte. Yayımlanmış çerçeveler, dış araştırma ve AI önerileri ayrı tutulur; özetler kısa ve kendi sözlerimizledir (telifli metin kopyalanmaz). Her değişiklik geçmişe kaydedilir."
        actions={<Link href="/pr-ajansi/strateji" className="btn"><Icon name="strategy" />Marka Stratejisi</Link>}
      />
      <Flash ok={ok} err={err} />
      {total === 0 && (
        <section className="card mb-6">
          <AwaitingSetup title="Kütüphane boş">AMEC Integrated Evaluation Framework, Barcelona Principles 4.0, STP, Keller CBBE, IMC, tüketici davranışı, moda pazarlaması, kültürel markalaşma, itibar yönetimi, kriz iletişimi (SCCT), konumlandırma ve medya ilişkileri ölçümü kaynaklarıyla eklenir.</AwaitingSetup>
          <form action={librarySeedAction} className="mt-4"><SubmitButton className="btn-primary">Profesyonel çerçeveleri ekle</SubmitButton></form>
        </section>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={href(null)} className={kind === null ? "chip-active" : "chip"} aria-current={kind === null ? "page" : undefined}>Tümü ({total})</Link>
        {(Object.keys(KIND) as LibraryKind[]).map((k) => <Link key={k} href={href(k)} className={kind === k ? "chip-active" : "chip"} aria-current={kind === k ? "page" : undefined}>{KIND[k].label} ({counts[k]})</Link>)}
        <form className="ml-auto flex w-full gap-2 sm:w-auto" role="search">
          {kind && <input type="hidden" name="tur" value={kind} />}
          <label className="sr-only" htmlFor="lib-q">Kütüphanede ara</label>
          <input id="lib-q" name="q" defaultValue={term} placeholder="Ara: kriz, AMEC, konumlandırma…" className="input sm:w-72" />
          <button className="btn">Ara</button>
        </form>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-3 xl:col-span-2">
          {entries.length === 0 ? <Empty icon="library">{term ? "Eşleşen kayıt yok." : "Kayıt yok."}</Empty> : entries.map((e) => (
            <article key={e.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0"><div className="eyebrow mb-1"><span lang="en">{e.category}</span> · {KIND[e.kind].label}</div><h2 className="font-display text-xl leading-snug">{e.title}</h2></div>
                <Badge tone={e.kind === "ai_recommendation" ? "demo" : VERIFY[e.verification].tone}>{e.kind === "ai_recommendation" ? "Öneri" : VERIFY[e.verification].label}</Badge>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">{e.summary}</p>
              {e.application && <p className="mt-2 rounded-xl bg-surface-2 p-3 text-sm text-ink-soft"><strong className="text-ink">FriBee ajansında kullanımı:</strong> {e.application}</p>}
              <div className="mt-3 text-xs text-muted">
                Kaynak: {e.source_url ? <a href={e.source_url} target="_blank" rel="noopener noreferrer" className="link break-all">{e.source_title ?? e.source_url}</a> : (e.source_title ?? "—")}
                {e.source_ref ? ` · ${e.source_ref}` : ""}{e.publisher ? ` · ${e.publisher}` : ""}{e.version ? ` · sürüm ${e.version}` : ""}{e.published_year ? ` · ${e.published_year}` : ""}
              </div>
              {e.verified_note && <div className="mt-1 text-xs text-muted">Doğrulama notu: {e.verified_note}{e.checked_at ? ` (kontrol: ${String(e.checked_at).slice(0, 10)})` : ""}</div>}
              {e.kind !== "ai_recommendation" && (
                <details className="mt-3 text-xs">
                  <summary className="text-brand">Doğrulama durumunu güncelle</summary>
                  <form action={libraryVerifyAction} className="mt-2 grid gap-2 sm:grid-cols-3">
                    <input type="hidden" name="id" value={e.id} />
                    <label><span className="label">Durum</span><select name="verification" defaultValue={e.verification} className="input py-1.5">{Object.entries(VERIFY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
                    <label className="sm:col-span-2"><span className="label">Not (doğrulamak için zorunlu)</span><input name="note" maxLength={1000} className="input py-1.5" placeholder="ör. Yayıncı sayfasında sürüm ve yıl kontrol edildi" /></label>
                    <div><SubmitButton className="btn py-1.5">Kaydet</SubmitButton></div>
                  </form>
                </details>
              )}
            </article>
          ))}
        </div>

        <div className="space-y-4">
          <Section id="lib-add" title="Kayıt ekle" eyebrow="Kaynak zorunlu (AI önerisi hariç)">
            <form action={libraryAddAction} className="grid gap-2 text-xs">
              <label><span className="label">Tür</span><select name="kind" className="input">{(Object.keys(KIND) as LibraryKind[]).map((k) => <option key={k} value={k}>{KIND[k].label} — {KIND[k].hint}</option>)}</select></label>
              <label><span className="label">Kategori</span><input name="category" required minLength={2} maxLength={80} className="input" placeholder="ör. Kriz iletişimi" /></label>
              <label><span className="label">Başlık</span><input name="title" required minLength={2} maxLength={300} className="input" /></label>
              <label><span className="label">Özet (kendi sözlerinizle)</span><textarea name="summary" required minLength={10} maxLength={4000} rows={3} className="input" /></label>
              <label><span className="label">Ajansta kullanımı</span><textarea name="application" maxLength={4000} rows={2} className="input" /></label>
              <label><span className="label">Kaynak başlığı</span><input name="sourceTitle" maxLength={500} className="input" /></label>
              <label><span className="label">Kaynak adresi (https://)</span><input name="sourceUrl" type="url" pattern="https://.*" className="input" /></label>
              <div className="grid grid-cols-2 gap-2">
                <label><span className="label">Yayıncı</span><input name="publisher" maxLength={300} className="input" /></label>
                <label><span className="label">Yıl</span><input name="publishedYear" inputMode="numeric" pattern="[0-9]{4}" className="input" /></label>
              </div>
              <SubmitButton className="btn-primary">Ekle</SubmitButton>
            </form>
          </Section>
          <Section id="lib-history" title="Güncelleme geçmişi">
            {history.length === 0 ? <p className="text-sm text-muted">Kayıt yok.</p> : (
              <ul className="space-y-2 text-xs">{history.map((h) => <li key={h.id}><span className="text-ink-soft">{h.created ? "Eklendi" : "Güncellendi"}: {h.title}</span><div className="text-muted">{dt(h.created_at)} · {h.changed_by.startsWith("seed") ? "Başlangıç kaydı" : h.changed_by === "user" ? "Sahip" : h.changed_by}</div></li>)}</ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
