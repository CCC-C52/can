import { randomUUID } from "node:crypto";
import Link from "next/link";
import { cinematicVideoAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Empty } from "@/components/ui";

type Photo = { id: string; filename: string };
export function CinematicCampaignForm({ photos }: { photos: Photo[] }) {
  return (
    <section className="card mb-4 space-y-3">
      <h2 className="h2">FriBee Cinematic AI Reklam</h2>
      <p className="text-sm text-muted">Gerçek ürün fotoğraflarıyla sinematik reklam talebi. Ücretli üretim mevcut sahip izni ve bütçe sınırlarına bağlıdır; otomatik yayın yapılmaz.</p>
      <form action={cinematicVideoAction} className="space-y-3">
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        <fieldset>
          <legend className="label">Ürün fotoğrafları</legend>
          {photos.length === 0 ? <Empty>Gerçek ürün fotoğrafı bulunamadı. <Link href="/medya" className="text-brand underline">Medya arşivine</Link> yükleyin.</Empty> : (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {photos.map(p => <li key={p.id}><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="assetIds" value={p.id} /><span className="truncate">{p.filename}</span></label></li>)}
            </ul>
          )}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm"><span className="label">Koleksiyon</span><select name="collection" className="input"><option>Space Alien</option><option>Music</option><option>Anime</option><option>Save the Bee</option></select></label>
          <label className="block text-sm"><span className="label">Stil</span><select name="style" className="input"><option value="cinematic">Cinematic Fashion</option><option value="futuristic">Futuristic</option><option value="anime">Anime Inspired</option><option value="luxury">Luxury Editorial</option></select></label>
          <label className="block text-sm"><span className="label">Süre</span><select name="durationSeconds" className="input"><option value="15">15 saniye</option><option value="30">30 saniye</option></select></label>
          <label className="block text-sm"><span className="label">Format</span><select name="aspectRatio" className="input"><option value="9:16">9:16 Reels / TikTok</option><option value="16:9">16:9 Yatay</option></select></label>
        </div>
        <p className="text-xs text-muted">Ürün baskısı, logo, renk ve kalıp için insan kontrolü zorunludur. Lisansı doğrulanmamış müzik eklenmez.</p>
        <SubmitButton className="btn-primary" disabled={!photos.length}>Cinematic reklam talebi oluştur</SubmitButton>
      </form>
    </section>
  );
}
