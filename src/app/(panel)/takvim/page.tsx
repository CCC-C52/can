import Link from "next/link";
import { requireBrand } from "@/lib/current";
import { q } from "@/lib/db/pool";
import { Badge, Empty, PageHeader } from "@/components/ui";

const ST: Record<string, { l: string; t: "ok" | "warn" | "bad" | "neutral" | "info" }> = {
  draft: { l: "Taslak", t: "neutral" }, awaiting_approval: { l: "Onay bekliyor", t: "warn" }, approved: { l: "Onaylı", t: "info" },
  published: { l: "Yayınlandı", t: "ok" }, manual_export: { l: "Manuel paket hazır", t: "info" }, failed: { l: "Başarısız", t: "bad" },
};

export default async function Calendar() {
  const brand = await requireBrand();
  const entries = await q<{ id: string; platform: string; title: string; caption: string | null; scheduled_at: string | null; status: string; output_id: string | null }>(
    `SELECT * FROM calendar_entries WHERE brand_id = $1 ORDER BY scheduled_at NULLS LAST, created_at`, [brand.id]);
  const groups = new Map<string, typeof entries>();
  for (const e of entries) {
    const k = e.scheduled_at ? new Date(e.scheduled_at).toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long" }) : "Tarihsiz";
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return (
    <div>
      <PageHeader title="Yayın takvimi" subtitle="Sosyal medya uzmanının önerdiği yayınlar. Takvim bir plandır; yayın otomatik zamanlanmaz — her gönderi onay ve yayın/manuel paket adımı gerektirir." />
      {entries.length === 0 ? <Empty>Takvimde gönderi yok. Sosyal medya paketi üretildiğinde burada görünür.</Empty> : (
        <div className="space-y-4">
          {[...groups.entries()].map(([day, list]) => (
            <section key={day} className="card">
              <h2 className="h2 mb-2 capitalize">{day}</h2>
              <ul className="divide-y divide-line">
                {list.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><Badge tone="info">{e.platform}</Badge><span className="font-medium">{e.title}</span>{e.scheduled_at && <span className="text-xs text-muted">{new Date(e.scheduled_at).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</span>}</div>
                      {e.caption && <p className="mt-1 line-clamp-2 text-xs text-muted">{e.caption}</p>}
                    </div>
                    <span className="flex items-center gap-2"><Badge tone={ST[e.status]?.t ?? "neutral"}>{ST[e.status]?.l ?? e.status}</Badge>{e.output_id && <Link className="text-xs text-brand" href={`/taslaklar/${e.output_id}`}>Paketi aç</Link>}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
