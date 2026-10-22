import Link from "next/link";
import { requireBrand } from "@/lib/current";
import { listProjects } from "@/lib/orchestrator/projects";
import { PROJECT_STATUS_LABEL } from "@/lib/labels";
import { Badge, Empty, PageHeader, dt } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Campaigns() {
  const brand = await requireBrand();
  const projects = await listProjects(brand.id, 100);
  return (
    <div>
      <PageHeader title="Kampanya Yönetimi" subtitle={`${brand.name} için tüm talimatlar ve kampanyalar. Yeni talimat için Ana Yönetici, Görsel veya Video Stüdyosu.`}
        actions={<><Link href="/sohbet" className="btn-primary">Yeni talimat</Link><Link href="/takvim" className="btn">Yayın takvimi</Link></>} />
      {projects.length === 0 ? <Empty>Henüz kampanya yok.</Empty> : (
        <div className="card overflow-x-auto" tabIndex={0} role="region" aria-label="Kampanyalar tablosu">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted"><th className="py-1 pr-2">Kampanya / talimat</th><th className="pr-2">Durum</th><th className="pr-2">Görev</th><th>Oluşturulma</th></tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="py-2 pr-2"><Link href={`/projeler/${p.id}`} className="text-brand">{p.title}</Link></td>
                  <td className="pr-2"><Badge>{PROJECT_STATUS_LABEL[p.status] ?? p.status}</Badge></td>
                  <td className="pr-2">{p.done_count}/{p.task_count}</td>
                  <td className="whitespace-nowrap">{dt(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
