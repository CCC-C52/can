import { requireBrand } from "@/lib/current";
import { q } from "@/lib/db/pool";
import type { MediaAsset } from "@/lib/services/media";
import { Empty, PageHeader } from "@/components/ui";
import { MediaThumb } from "@/components/previews";
import Link from "next/link";

export default async function Previews() {
  const brand = await requireBrand();
  const assets = await q<MediaAsset & { output_id: string | null; output_title: string | null }>(
    `SELECT m.*, o.id AS output_id, o.title AS output_title FROM media_assets m
     LEFT JOIN output_versions v ON v.id = m.source_output_version_id LEFT JOIN outputs o ON o.id = v.output_id
     WHERE m.brand_id = $1 AND m.origin IN ('edited','ai_generated') ORDER BY m.created_at DESC LIMIT 100`,
    [brand.id],
  );
  return (
    <div>
      <PageHeader title="Görsel ve video önizlemeleri" subtitle="Ajanların ürettiği/derlediği dosyalar. Gerçek ürün fotoğrafından derlenenler ile AI görselleri ayrı etiketlenir." />
      {assets.length === 0 ? <Empty>Henüz üretilmiş görsel veya video yok. Görsel üretimi için bağlı servis veya arşivde gerçek ürün fotoğrafı gerekir.</Empty> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {assets.map((a) => (
            <div key={a.id}>
              <MediaThumb m={a} />
              {a.output_id && <Link href={`/taslaklar/${a.output_id}`} className="mt-1 block text-xs text-brand">Kaynak çıktı: {a.output_title}</Link>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
