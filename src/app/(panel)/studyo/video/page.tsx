import { randomUUID } from "node:crypto";
import Link from "next/link";
import { flash, requireBrand, type SP } from "@/lib/current";
import { listMedia } from "@/lib/services/media";
import { latestAnalysis } from "@/lib/media-analysis";
import { listOutputs } from "@/lib/services/outputs";
import { videoStudioAction } from "@/app/actions";
import { Badge, Empty, Flash, PageHeader, dt } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { VisionStatus } from "../vision-status";
import { getLimits } from "@/lib/settings";
import { config } from "@/lib/config";
import { capabilityReady } from "@/lib/services/connections";
import { STUDIO_MAX_AI_SCENES, STUDIO_MODE_LABEL } from "@/lib/video/studio";
import { REFERENCE_MIN_SHORT_SIDE, referenceTooSmall } from "@/lib/video/reference";
import { FRIBEE_THEMES, THEME_INFO } from "@/lib/drive/themes";
import { verifiedCatalogPhotos } from "@/lib/drive/references";

export const dynamic = "force-dynamic";

export default async function VideoStudio({ searchParams }: { searchParams: SP }) {
  const brand = await requireBrand();
  const { ok, err } = await flash(searchParams);
  const videos = (await listMedia(brand.id, { kind: "video" })).filter((m) => m.origin === "real_video").slice(0, 60);
  const analyses = await Promise.all(videos.map((v) => latestAnalysis(brand.id, v.id)));
  const outputs = (await listOutputs(brand.id, { limit: 50 })).filter((o) => o.kind === "video_plan").slice(0, 10);
  const photos = (await listMedia(brand.id, { kind: "photo" })).filter((m) => ["image/jpeg", "image/png", "image/webp"].includes(m.mime_type)).slice(0, 60);
  const limits = await getLimits();
  const music = (await listMedia(brand.id, { kind: "audio" })).filter((m) => ["owned", "licensed"].includes(String(m.rights_status))).slice(0, 40);
  const catalog = await Promise.all(FRIBEE_THEMES.map(async (t) => ({ theme: t, photos: await verifiedCatalogPhotos(brand.id, t, 3) })));
  const gen = await capabilityReady("video_generation", brand.id);
  const price = config.gemini.costPerSecondUsd;
  const geminiChecks = [
    { ok: !!config.gemini.apiKey, label: "GEMINI_API_KEY tanımlı", fix: "Render ortamına ekleyin" },
    { ok: gen.ready, label: "Google Gemini Omni Video bağlı", fix: gen.reason ?? "Entegrasyonlar → Test et" },
    { ok: price !== null, label: price !== null ? `Saniye fiyatı ${price} $` : "GEMINI_VIDEO_COST_PER_SECOND_USD tanımlı", fix: "Tanımlı değilse maliyet bilinmediği için üretim engellenir" },
    { ok: limits.paidMediaGeneration, label: "Ücretli AI medya üretimi izni", fix: "Ayarlar → Ücretli AI medya üretimi" },
  ];
  const geminiReady = geminiChecks.every((c) => c.ok);
  return (
    <div>
      <PageHeader title="Video Stüdyosu" subtitle="Gemini Omni AI sahneleri, gerçek ürün fotoğrafları ve arşiv çekimleriyle Reels/TikTok reklamı. Talep Ana Yönetici'ye gider; kalite kontrolü, MP4 doğrulaması ve onayınız olmadan hiçbir şey yayınlanmaz." />
      <Flash ok={ok} err={err} />
      <VisionStatus />
      <div className="grid gap-4 lg:grid-cols-3">
        <form action={videoStudioAction} className="card space-y-3 lg:col-span-2">
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <fieldset>
            <legend className="h2 mb-2">Mod</legend>
            <div className="space-y-1">
              {(["hybrid", "ai", "archive"] as const).map((m) => (
                <label key={m} className="flex items-start gap-2 text-sm"><input type="radio" name="mode" value={m} defaultChecked={m === (geminiReady ? "hybrid" : "archive")} className="mt-1" /> <span>{STUDIO_MODE_LABEL[m]}</span></label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="h2 mb-2">Koleksiyon</legend>
            <select name="collection" className="input" defaultValue="" aria-label="Koleksiyon">
              <option value="">Seçilmedi</option>
              {catalog.map((c) => <option key={c.theme} value={c.theme}>{THEME_INFO[c.theme].label} ({THEME_INFO[c.theme].garmentLabel}) — {c.photos.length} doğrulanmış katalog fotoğrafı</option>)}
            </select>
            <p className="mt-1 text-xs text-muted">Koleksiyon seçip fotoğraf seçmezseniz, Drive Arşivi&apos;nde doğrulanmış ön/arka/detay katalog fotoğrafları otomatik referans olur. Başka koleksiyondan fotoğraf seçilirse talep reddedilir.</p>
          </fieldset>
          <fieldset>
            <legend className="h2 mb-2">Gerçek ürün fotoğrafları <span className="text-xs font-normal text-muted">(AI sahnelerine orijinal netlikte referans, en fazla 3; kısa kenar en az {REFERENCE_MIN_SHORT_SIDE} piksel; tasarım ve renk değişmez)</span></legend>
            {photos.length === 0 ? <Empty>Arşivde ürün fotoğrafı yok. <Link href="/medya" className="text-brand underline">Medya arşivi</Link>nden yükleyin.</Empty> : (
              <ul className="max-h-60 space-y-1 overflow-y-auto">
                {photos.map((p) => {
                  const low = referenceTooSmall(p.width, p.height);
                  return (
                    <li key={p.id}><label className={`flex items-center gap-2 rounded-lg px-2 py-1 text-sm ${low ? "opacity-60" : "hover:bg-surface-2"}`}><input type="checkbox" name="photoIds" value={p.id} disabled={low} /><span className="min-w-0 flex-1 truncate">{p.filename}</span>{p.width && p.height ? <span className="text-xs text-muted">{p.width}x{p.height}</span> : null}{low && <Badge tone="warn">Düşük çözünürlük</Badge>}</label></li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm"><span className="label">AI sahne sayısı</span><input name="aiScenes" type="number" min={1} max={STUDIO_MAX_AI_SCENES} defaultValue={2} className="input" /></label>
            <label className="block text-sm"><span className="label">AI sahne süresi (sn, 3–10)</span><input name="sceneSeconds" type="number" min={3} max={10} defaultValue={6} className="input" /></label>
          </div>
          <fieldset>
            <legend className="h2 mb-2">Arşiv videoları <span className="text-xs font-normal text-muted">(arşiv ve karma modda)</span></legend>
            {videos.length === 0 ? <Empty>Arşivde gerçek video yok. <Link href="/medya" className="text-brand underline">Medya arşivi</Link>nden yükleyin.</Empty> : (
              <ul className="max-h-96 space-y-1 overflow-y-auto">
                {videos.map((v, i) => {
                  const a = analyses[i];
                  return (
                    <li key={v.id}>
                      <label className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-surface-2">
                        <input type="checkbox" name="assetIds" value={v.id} />
                        <span className="min-w-0 flex-1 basis-40 truncate">{v.filename}</span>
                        <span className="text-xs text-muted">{v.duration_s ? `${Number(v.duration_s).toFixed(1)} sn` : "süre ?"}{v.width && v.height ? ` · ${v.width}x${v.height}` : ""}</span>
                        <Badge tone={a?.status === "completed" ? "ok" : a?.status === "failed" ? "bad" : "neutral"}>
                          {a?.status === "completed" ? (a.level === "vision" ? "Analiz: görsel model" : "Analiz: yerel") : a?.status === "failed" ? "Analiz başarısız" : a ? "Analiz sürüyor" : "Analiz yok (otomatik başlar)"}
                        </Badge>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm"><span className="label">Müzik (lisanslı)</span>
              <select name="musicId" className="input" defaultValue="">
                <option value="">Sessiz</option>
                {music.map((m) => <option key={m.id} value={m.id}>{m.filename}{m.duration_s ? ` (${Number(m.duration_s).toFixed(0)} sn)` : ""}</option>)}
              </select>
              <span className="mt-1 block text-xs text-muted">{music.length ? "Video boyunca çalar; giriş/çıkış yumuşatılır, ses seviyesi yayın standardına (-14 LUFS) getirilir." : "Medya arşivine MP3/WAV/M4A yükleyin ve kullanım hakkını “Lisanslı” veya “Marka sahibi” seçin."}</span>
            </label>
            <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" name="aiOnly" value="1" className="mt-1" /><span>Yalnızca gerçek AI video sahneleri (fotoğraf yakınlaştırma/kaydırma veya slayt yok). Ürün fotoğrafları yalnızca Gemini&apos;ye referans olarak gider.</span></label>
            <label className="block text-sm"><span className="label">Ek format</span>
              <select name="extraFormat" className="input" defaultValue="16:9"><option value="16:9">Yatay 16:9 sürüm de üret (ek AI maliyeti yok)</option><option value="">Yalnızca dikey 9:16</option></select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block text-sm"><span className="label">En az (sn)</span><input name="minSeconds" type="number" min={3} max={90} defaultValue={10} className="input" /></label>
            <label className="block text-sm"><span className="label">En çok (sn)</span><input name="maxSeconds" type="number" min={3} max={90} defaultValue={15} className="input" /></label>
            <label className="block text-sm"><span className="label">Platform</span><select name="platform" className="input"><option value="reels">Instagram Reels</option><option value="tiktok">TikTok</option></select></label>
            <label className="block text-sm"><span className="label">Geçiş</span><select name="transition" className="input"><option value="cut">Kesme (daha az bellek)</option><option value="fade">Yumuşak geçiş</option></select></label>
          </div>
          <label className="block text-sm"><span className="label">Amaç ve notlar</span><textarea name="goal" rows={3} maxLength={1500} className="input" placeholder="Örn: Yeni sezon lansmanı; ilk 2 saniyede ürün görünsün; ekran yazısı kısa olsun." /></label>
          <p className="text-xs text-muted">AI sahneleri Google Gemini Omni ile üretilir (720p, 3–10 sn, ücretli). Tahmini maliyet: {price !== null ? `2 × 6 sn ≈ ${(price * 12).toFixed(2)} $ (sahne sayısı × süre × ${price} $)` : "saniye fiyatı tanımlı değil"}; proje sınırı {limits.maxVideoGenSeconds} sn (uzun reklam için Ayarlar&apos;dan artırın). En fazla {STUDIO_MAX_AI_SCENES} AI sahnesi. Kapanışta hareketli logo kartı. Ürün rengi değiştirilmez.</p>
          <SubmitButton className="btn-primary" disabled={!videos.length && !photos.length && !geminiReady}>Ana Yönetici&apos;ye gönder</SubmitButton>
        </form>
        <div className="space-y-4">
        <section className="card h-fit">
          <h2 className="h2 mb-2">Gemini Omni hazırlığı</h2>
          <ul className="space-y-1 text-sm">
            {geminiChecks.map((c) => <li key={c.label} className="flex items-start gap-2"><Badge tone={c.ok ? "ok" : "bad"}>{c.ok ? "Tamam" : "Eksik"}</Badge><span>{c.label}{c.ok ? "" : <span className="block text-xs text-muted">{c.fix}</span>}</span></li>)}
          </ul>
          {!geminiReady && <p className="mt-2 text-xs text-muted">Eksikler giderilene kadar AI sahneleri &quot;izin/bağlantı bekliyor&quot; olarak kalır; hiçbir ücretli istek gönderilmez.</p>}
        </section>
        <section className="card h-fit">
          <h2 className="h2 mb-2">Son video planları</h2>
          {outputs.length === 0 ? <p className="muted text-sm">Henüz yok.</p> : (
            <ul className="space-y-1 text-sm">{outputs.map((o) => <li key={o.id}><Link href={`/taslaklar/${o.id}`} className="text-brand">{o.title}</Link> <span className="text-xs text-muted">{dt(o.created_at)}</span></li>)}</ul>
          )}
        </section>
        </div>
      </div>
    </div>
  );
}
