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

export const dynamic = "force-dynamic";

export default async function VideoStudio({ searchParams }: { searchParams: SP }) {
  const brand = await requireBrand();
  const { ok, err } = await flash(searchParams);
  const videos = (await listMedia(brand.id, { kind: "video" })).filter((m) => m.origin === "real_video").slice(0, 60);
  const analyses = await Promise.all(videos.map((v) => latestAnalysis(brand.id, v.id)));
  const outputs = (await listOutputs(brand.id, { limit: 50 })).filter((o) => o.kind === "video_plan").slice(0, 10);
  return (
    <div>
      <PageHeader title="Video Stüdyosu" subtitle="Arşivdeki gerçek çekimlerden Reels/TikTok videosu. Talep Ana Yönetici'ye gider; sahne analizi, kalite kontrolü, MP4 doğrulaması ve onayınız olmadan hiçbir şey yayınlanmaz." />
      <Flash ok={ok} err={err} />
      <VisionStatus />
      <div className="grid gap-4 lg:grid-cols-3">
        <form action={videoStudioAction} className="card space-y-3 lg:col-span-2">
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <fieldset>
            <legend className="h2 mb-2">Kaynak videolar</legend>
            {videos.length === 0 ? <Empty>Arşivde gerçek video yok. <Link href="/medya" className="text-brand underline">Medya arşivi</Link>nden yükleyin.</Empty> : (
              <ul className="max-h-96 space-y-1 overflow-y-auto">
                {videos.map((v, i) => {
                  const a = analyses[i];
                  return (
                    <li key={v.id}>
                      <label className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-gray-50">
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block text-sm"><span className="label">En az (sn)</span><input name="minSeconds" type="number" min={3} max={90} defaultValue={10} className="input" /></label>
            <label className="block text-sm"><span className="label">En çok (sn)</span><input name="maxSeconds" type="number" min={3} max={90} defaultValue={15} className="input" /></label>
            <label className="block text-sm"><span className="label">Platform</span><select name="platform" className="input"><option value="reels">Instagram Reels</option><option value="tiktok">TikTok</option></select></label>
            <label className="block text-sm"><span className="label">Geçiş</span><select name="transition" className="input"><option value="cut">Kesme (daha az bellek)</option><option value="fade">Yumuşak geçiş</option></select></label>
          </div>
          <label className="block text-sm"><span className="label">Amaç ve notlar</span><textarea name="goal" rows={3} maxLength={1500} className="input" placeholder="Örn: Yeni sezon lansmanı; ilk 2 saniyede ürün görünsün; ekran yazısı kısa olsun." /></label>
          <p className="text-xs text-muted">Ses kaldırılır (müzik lisansı sizin kararınız). Ürün rengi değiştirilmez. Uzun videolarda analiz ve render birkaç dakika sürebilir.</p>
          <SubmitButton className="btn-primary" disabled={!videos.length}>Ana Yönetici&apos;ye gönder</SubmitButton>
        </form>
        <section className="card h-fit">
          <h2 className="h2 mb-2">Son video planları</h2>
          {outputs.length === 0 ? <p className="muted text-sm">Henüz yok.</p> : (
            <ul className="space-y-1 text-sm">{outputs.map((o) => <li key={o.id}><Link href={`/taslaklar/${o.id}`} className="text-brand">{o.title}</Link> <span className="text-xs text-muted">{dt(o.created_at)}</span></li>)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}
