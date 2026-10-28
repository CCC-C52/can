import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { listOutputs } from "@/lib/services/outputs";
import { agentName } from "@/lib/agents/registry";
import { Badge, DemoBadge, Empty, Flash, PageHeader, dt } from "@/components/ui";

const KIND: Record<string, string> = { strategy: "Strateji", shopify_proposal: "Shopify önerisi", design_brief: "Tasarım briefi", video_plan: "Video planı", social_package: "Yayın paketi", qa_report: "Analiz raporu", project_report: "Proje raporu" };

export default async function Drafts({ searchParams }: { searchParams: SP }) {
  const { ok, err, one } = await flash(searchParams);
  const brand = await requireBrand();
  const kind = one("kind");
  const all = await listOutputs(brand.id);
  const outputs = kind ? all.filter((o) => o.kind === kind) : all;
  return (
    <div>
      <PageHeader title="İçerik taslakları" subtitle="Ajanların ürettiği tüm çıktılar ve sürümleri." />
      <Flash ok={ok} err={err} />
      <div className="mb-3 flex flex-wrap gap-1 text-sm">
        <Link href="/taslaklar" className={`rounded-full px-3 py-1 ${!kind ? "bg-brand text-on-brand" : "bg-panel ring-1 ring-line"}`}>Tümü ({all.length})</Link>
        {Object.entries(KIND).map(([k, l]) => <Link key={k} href={`/taslaklar?kind=${k}`} className={`rounded-full px-3 py-1 ${kind === k ? "bg-brand text-on-brand" : "bg-panel ring-1 ring-line"}`}>{l} ({all.filter((o) => o.kind === k).length})</Link>)}
      </div>
      {outputs.length === 0 ? <Empty>Henüz çıktı yok.</Empty> : (
        <div tabIndex={0} className="card overflow-x-auto p-0">
          <table className="table">
            <thead><tr><th className="pl-4">Başlık</th><th>Tür</th><th>Uzman</th><th>Sürüm</th><th>Durum</th><th>Güncelleme</th></tr></thead>
            <tbody>
              {outputs.map((o) => (
                <tr key={o.id}>
                  <td className="pl-4"><Link href={`/taslaklar/${o.id}`} className="font-medium text-brand">{o.title}</Link></td>
                  <td>{KIND[o.kind] ?? o.kind}</td>
                  <td className="whitespace-nowrap">{agentName(o.agent)}</td>
                  <td>v{o.current_version}</td>
                  <td><span className="flex flex-wrap gap-1">{o.is_demo && <DemoBadge />}{o.verdict && <Badge tone={o.verdict === "pass" ? "ok" : "bad"}>QA {o.verdict === "pass" ? "geçti" : "sorunlu"}</Badge>}{o.approval && <Badge tone={o.approval === "approved" ? "ok" : "bad"}>{o.approval === "approved" ? "Onaylı" : "Reddedildi"}</Badge>}</span></td>
                  <td className="whitespace-nowrap text-xs">{dt(o.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
