import Link from "next/link";
import type { MediaAsset } from "@/lib/services/media";
import { Badge, Val } from "@/components/ui";
import { MEDIA_ORIGIN_LABEL } from "@/lib/labels";

// Çıktı türüne göre okunabilir önizlemeler.

export function MediaThumb({ m, big = false }: { m: MediaAsset; big?: boolean }) {
  const src = `/api/media/${m.id}/file`;
  return (
    <figure className="overflow-hidden rounded-lg border border-line bg-white">
      {m.kind === "video" ? (
        <video src={src} controls preload="metadata" className={`w-full bg-black ${big ? "max-h-[70vh]" : "max-h-72"}`} />
      ) : m.mime_type.startsWith("image/") && m.mime_type !== "image/vnd.adobe.photoshop" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={m.alt_text ?? m.filename} className={`w-full object-contain ${big ? "max-h-[70vh]" : "max-h-72"} bg-gray-50`} loading="lazy" />
      ) : (
        <div className="flex h-40 items-center justify-center bg-gray-50 text-xs text-muted">{m.mime_type}</div>
      )}
      <figcaption className="flex flex-wrap items-center gap-1 p-2 text-xs">
        <Link href={`/medya/${m.id}`} className="truncate font-medium text-brand">{m.filename}</Link>
        <Badge tone={m.origin === "ai_generated" ? "warn" : m.origin === "edited" || m.origin === "composed" ? "info" : "neutral"}>{MEDIA_ORIGIN_LABEL[m.origin] ?? m.origin}</Badge>
      </figcaption>
    </figure>
  );
}

function List({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return <div><div className="label">{title}</div><ul className="list-disc space-y-1 pl-5 text-sm">{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>;
}

export function OutputPreview({ kind, content, assets, products }: { kind: string; content: any; assets: MediaAsset[]; products: Map<string, string> }) {
  const assetsFor = (ref: string) => assets.filter((a) => a.tags.some((t) => t.tag === `ref:${ref}`));
  const pname = (id: string) => products.get(id) ?? `Bilinmeyen ürün (${id.slice(0, 8)})`;
  switch (kind) {
    case "strategy":
      return (
        <div className="space-y-4 text-sm">
          <p>{content.summary}</p>
          <div><div className="label">Hedef kitle</div>
            <ul className="space-y-1">{content.audience_segments?.map((s: any, i: number) => <li key={i}><strong>{s.segment}</strong> — {s.needs} <Badge tone={s.basis === "assumption" ? "warn" : "ok"}>{s.basis === "assumption" ? "Varsayım" : "Marka verisi"}</Badge></li>)}</ul></div>
          <div><div className="label">Konumlandırma</div><p>{content.positioning}</p></div>
          <List title="Ana mesajlar" items={content.key_messages} />
          <div><div className="label">Kampanya: {content.campaign?.name}</div><p className="text-muted">{content.campaign?.objective}</p>
            <ol className="mt-1 space-y-1">{content.campaign?.phases?.map((p: any, i: number) => <li key={i}><strong>{p.name}</strong> ({p.timing}): {p.actions.join(", ")}</li>)}</ol></div>
          <List title="İçerik temaları" items={content.content_themes} />
          <div><div className="label">Reklam önerileri</div><ul className="space-y-1">{content.ad_ideas?.map((a: any, i: number) => <li key={i}>{a.platform} · {a.format}: “{a.hook}” — {a.audience}. <span className="text-muted">{a.budget_note}</span></li>)}</ul></div>
          {content.brand_analysis && (content.brand_analysis.strengths?.length > 0 || content.brand_analysis.gaps?.length > 0) && (
            <div><div className="label">Marka analizi</div>
              <ul className="space-y-1">{content.brand_analysis.strengths.map((x: any, i: number) => <li key={i}>{x.point} <Badge tone={x.basis === "assumption" ? "warn" : "ok"}>{x.basis === "assumption" ? "Varsayım" : "Marka verisi"}</Badge></li>)}</ul>
              <List title="Eksikler" items={content.brand_analysis.gaps} /></div>
          )}
          {content.competitor_framework && content.competitor_framework.criteria?.length > 0 && (
            <div><div className="label">Rakip analizi çerçevesi</div>
              <p>Kriterler: {content.competitor_framework.criteria.join(", ")}</p>
              <p className="text-muted">İncelenecek rakipler: {content.competitor_framework.competitors_to_research.length ? content.competitor_framework.competitors_to_research.join(", ") : "sizden bekleniyor (uydurulmadı)"}</p>
              <List title="Sorular" items={content.competitor_framework.questions} /></div>
          )}
          {content.organic_strategy && content.organic_strategy.pillars?.length > 0 && (
            <div><div className="label">Organik sosyal medya stratejisi</div>
              <p>İçerik sütunları: {content.organic_strategy.pillars.join(", ")}</p>
              <p>Sıklık: {content.organic_strategy.posting_frequency}</p>
              <ul>{content.organic_strategy.channels.map((c: any, i: number) => <li key={i}>{c.platform}: {c.role}</li>)}</ul></div>
          )}
          {content.performance_recommendations?.length > 0 && (
            <div><div className="label">Performans ölçümü önerileri</div><ul className="space-y-1">{content.performance_recommendations.map((r: any, i: number) => <li key={i}><strong>{r.metric}</strong> — {r.how_to_measure}. <span className="text-muted">{r.note}</span></li>)}</ul></div>
          )}
          <List title="Varsayımlar (doğrulanmış veri değil)" items={content.assumptions} />
          <List title="Bilinmeyenler" items={content.unknowns} />
        </div>
      );
    case "shopify_proposal":
      return (
        <div className="space-y-4 text-sm">
          <p>{content.summary}</p>
          <div className="label">Mevcut ve önerilen değerler</div>
          <div tabIndex={0} className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Ürün</th><th>Alan</th><th>Mevcut</th><th>Önerilen</th><th>Gerekçe</th></tr></thead>
              <tbody>{content.product_changes?.map((c: any, i: number) => (
                <tr key={i} className={c.field === "price" || c.field === "compare_at_price" ? "bg-amber-50" : ""}>
                  <td className="whitespace-nowrap">{pname(c.product_id)}</td>
                  <td>{c.field}{(c.field === "price" || c.field === "compare_at_price") && <div><Badge tone="warn">Fiyat değişikliği</Badge></div>}</td>
                  <td className="max-w-xs text-xs text-muted">{c.current_value ? <pre className="whitespace-pre-wrap font-sans">{c.current_value}</pre> : <Val v={null} />}</td>
                  <td className="max-w-xs text-xs"><pre className="whitespace-pre-wrap font-sans">{c.proposed_value}</pre></td>
                  <td className="text-xs">{c.reason}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {content.collections?.length > 0 && <div><div className="label">Koleksiyonlar</div><ul>{content.collections.map((c: any, i: number) => <li key={i}><strong>{c.title}</strong> — {c.description} ({c.product_ids.map(pname).join(", ")})</li>)}</ul></div>}
          {content.pages?.length > 0 && <div><div className="label">Sayfalar</div>{content.pages.map((p: any, i: number) => <div key={i} className="rounded bg-gray-50 p-2"><strong>{p.title}</strong> <span className="text-muted">({p.purpose})</span><p className="whitespace-pre-wrap">{p.body}</p></div>)}<p className="mt-1 text-xs text-muted">Sayfalar bu sürümde canlıya otomatik yazılmaz; Shopify yönetim panelinden eklenir.</p></div>}
          {content.pdp_drafts?.length > 0 && (
            <div><div className="label">Ürün sayfası taslakları</div>
              {content.pdp_drafts.map((d: any, i: number) => (
                <div key={i} className="mb-2 rounded bg-gray-50 p-2">
                  <strong>{d.headline}</strong> <span className="text-xs text-muted">({pname(d.product_id)})</span>
                  <p className="whitespace-pre-wrap">{d.body}</p>
                  {d.bullet_points.length > 0 && <ul className="list-disc pl-5">{d.bullet_points.map((b: string) => <li key={b}>{b}</li>)}</ul>}
                  <p className="mt-1 text-xs text-muted">SEO: {d.seo_title} — {d.seo_description}</p>
                </div>
              ))}
            </div>
          )}
          {content.bundles?.length > 0 && <div><div className="label">Bundle önerileri</div><ul>{content.bundles.map((b: any, i: number) => <li key={i}><strong>{b.name}</strong>: {b.product_ids.map(pname).join(" + ")} — {b.rationale}. <span className="text-muted">{b.pricing_note}</span></li>)}</ul><p className="mt-1 text-xs text-muted">Bundle'lar Shopify'da bir bundle uygulaması gerektirir; otomatik oluşturulmaz.</p></div>}
          <List title="Bilinmeyenler" items={content.unknowns} />
        </div>
      );
    case "design_brief":
      return (
        <div className="space-y-4 text-sm">
          <p>{content.summary}</p>
          <div className="grid gap-3 md:grid-cols-2">
            {content.briefs?.map((b: any) => (
              <div key={b.id} className="rounded-lg border border-line p-3">
                <div className="flex flex-wrap items-center gap-1"><strong>{b.id}</strong><Badge>{b.purpose}</Badge><Badge>{b.format}</Badge>{(b.render_mode ?? (b.use_real_product_photo ? "photo_composition" : "ai_image")) === "photo_composition" ? <Badge tone="ok">Gerçek ürün fotoğrafı + metin</Badge> : b.render_mode === "typography" ? <Badge tone="info">Tipografik tasarım</Badge> : <Badge tone="warn">AI görseli gerekir</Badge>}</div>
                <p className="mt-2 font-medium">{b.headline}</p>
                <p className="text-muted">{b.body_text}</p>
                <p className="mt-1 text-xs">{b.visual_direction}</p>
                {b.slides?.length > 0 && <ol className="mt-1 list-decimal pl-5 text-xs">{b.slides.map((x: any, i: number) => <li key={i}><strong>{x.headline}</strong> — {x.body_text}</li>)}</ol>}
                {b.render_mode === "ai_image" && <p className="mt-1 text-xs text-muted">İstem: {b.generation_prompt}</p>}
                <div className="mt-2 grid gap-2">{assetsFor(b.id).map((a) => <MediaThumb key={a.id} m={a} />)}</div>
                {assetsFor(b.id).length === 0 && <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800">Henüz görsel üretilmedi{b.use_real_product_photo ? " (render görevi bekleniyor)" : " — görsel üretim servisi bağlı değilse yalnızca brief mevcuttur"}.</p>}
              </div>
            ))}
          </div>
          <List title="Bilinmeyenler" items={content.unknowns} />
        </div>
      );
    case "video_plan":
      return (
        <div className="space-y-4 text-sm">
          <p>{content.summary}</p>
          {content.videos?.map((v: any) => (
            <div key={v.id} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-1"><strong>{v.id}</strong><Badge tone={v.mode === "edit_existing" ? "info" : "warn"}>{v.mode === "edit_existing" ? "Mevcut çekimden kurgu" : "Yeni AI video"}</Badge><Badge>{v.format}</Badge><Badge>{v.duration_s} sn</Badge></div>
              <table className="table mt-2"><thead><tr><th>Zaman</th><th>Görüntü</th><th>Ekran metni</th></tr></thead>
                <tbody>{v.script?.map((s: any, i: number) => <tr key={i}><td className="whitespace-nowrap">{s.t_start}–{s.t_end} sn</td><td>{s.visual}</td><td>{s.on_screen_text}</td></tr>)}</tbody></table>
              <div className="label mt-2">Altyazılar</div>
              <ul className="text-xs">{v.subtitles?.map((s: any, i: number) => <li key={i}>{s.start}–{s.end} sn: {s.text}</li>)}</ul>
              <p className="mt-1 text-xs text-muted">Müzik: {v.music_note}</p>
              <div className="mt-2 grid gap-2 md:grid-cols-2">{assetsFor(v.id).map((a) => <MediaThumb key={a.id} m={a} />)}</div>
              {assetsFor(v.id).length === 0 && <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-800">{v.mode === "generate_new" ? "AI video üretim servisi bağlı değil; video üretilmedi (yalnızca senaryo)." : "Render henüz yapılmadı."}</p>}
            </div>
          ))}
          <List title="Bilinmeyenler" items={content.unknowns} />
        </div>
      );
    case "social_package":
      return (
        <div className="space-y-3 text-sm">
          <p>{content.summary}</p>
          <div className="grid gap-3 md:grid-cols-2">
            {content.posts?.map((p: any) => {
              const media = (p.media_refs ?? []).flatMap((r: string) => assetsFor(r));
              return (
                <div key={p.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center gap-1"><strong>{p.id}</strong><Badge tone="info">{p.platform}</Badge><Badge>{p.format}</Badge></div>
                  <p className="mt-1 text-xs text-muted">Önerilen: {new Date(p.suggested_datetime).toLocaleString("tr-TR")}</p>
                  <p className="mt-2 whitespace-pre-wrap">{p.caption}</p>
                  <p className="mt-1 text-xs text-brand">{p.hashtags?.join(" ")}</p>
                  <p className="mt-1 text-xs">CTA: {p.cta} · Kapak: {p.cover_text}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">{media.map((a: MediaAsset) => <MediaThumb key={a.id} m={a} />)}</div>
                  {media.length === 0 && <p className="mt-2 text-xs text-amber-800">Bu gönderi için render edilmiş medya yok.</p>}
                </div>
              );
            })}
          </div>
          {content.reels_ideas?.length > 0 && (
            <div><div className="label">Reels fikirleri</div>
              <ul className="space-y-2">{content.reels_ideas.map((r: any) => <li key={r.id} className="rounded bg-gray-50 p-2"><strong>{r.title}</strong> — kanca: “{r.hook}”<br /><span className="text-xs">Çekimler: {r.shots.join(" → ")} · Ekran metni: {r.on_screen_text}</span></li>)}</ul></div>
          )}
          {content.tiktok_concepts?.length > 0 && (
            <div><div className="label">TikTok konseptleri</div>
              <ul className="space-y-1">{content.tiktok_concepts.map((r: any) => <li key={r.id}><strong>{r.title}</strong> ({r.format}) — “{r.hook}”. <span className="text-muted">{r.notes}</span></li>)}</ul></div>
          )}
          {content.calendar_7d?.length > 0 && (
            <div><div className="label">7 günlük organik plan</div>
              <div tabIndex={0} className="overflow-x-auto"><table className="table"><thead><tr><th>Gün</th><th>Tarih</th><th>Platform</th><th>Biçim</th><th>Tema</th><th>Gönderi</th></tr></thead>
                <tbody>{content.calendar_7d.map((d: any) => <tr key={d.day}><td>{d.day}</td><td className="whitespace-nowrap">{d.date}</td><td>{d.platform}</td><td>{d.format}</td><td>{d.theme}</td><td>{d.post_ref || "—"}</td></tr>)}</tbody></table></div></div>
          )}
          <List title="Bilinmeyenler" items={content.unknowns} />
        </div>
      );
    case "qa_report":
      return (
        <div className="space-y-2 text-sm">
          <ul>{content.checks?.map((c: any, i: number) => <li key={i}><Badge tone={c.status === "pass" ? "ok" : c.status === "warn" ? "warn" : "bad"}>{c.status}</Badge> <strong>{c.name}</strong>: {c.detail}</li>)}</ul>
          <List title="Gerekli değişiklikler" items={content.required_changes} />
        </div>
      );
    default:
      return <pre tabIndex={0} className="overflow-x-auto rounded bg-gray-50 p-3 text-xs">{JSON.stringify(content, null, 2)}</pre>;
  }
}

export function QaPanel({ qa }: { qa: any }) {
  if (!qa) return <p className="muted">Kalite kontrolü henüz yapılmadı.</p>;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2"><Badge tone={qa.verdict === "pass" ? "ok" : "bad"}>{qa.verdict === "pass" ? "Geçti" : qa.verdict === "needs_changes" ? "Değişiklik gerekli" : "Başarısız"}</Badge><span className="text-muted">Puan {qa.score} · kaynak: {(qa.sources ?? []).join(" + ")}{qa.reviewed_version ? ` · sürüm ${qa.reviewed_version}` : ""}</span></div>
      {qa.note && <p className="text-xs text-muted">{qa.note}</p>}
      <ul className="space-y-1">{qa.checks?.map((c: any, i: number) => <li key={i} className="text-xs"><Badge tone={c.status === "pass" ? "ok" : c.status === "warn" ? "warn" : "bad"}>{c.status}</Badge> <strong>{c.name}</strong>: {c.detail}</li>)}</ul>
      <List title="Gerekli değişiklikler" items={qa.required_changes} />
    </div>
  );
}
