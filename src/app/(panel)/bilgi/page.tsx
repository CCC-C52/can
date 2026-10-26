import { requireBrand } from "@/lib/current";
import { seedFribeeGraph } from "@/lib/knowledge/graph";
import { ROLE_ACCESS, ROLE_LABELS } from "@/lib/knowledge/access";
import { buildPrRoadmap } from "@/lib/knowledge/pr-roadmap";
import { KNOWLEDGE_ROLES, SENSITIVITIES } from "@/lib/knowledge/types";
import { Badge, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

// Salt okunur pano: Drive bağlantısı ve kalıcı depolama sahip onayı bekliyor; bu sayfa hiçbir şey yazmaz veya yayınlamaz.

const SENS: Record<string, string> = { public: "Herkese açık", internal: "İç", vendor: "Tedarikçi", finance: "Finans", private: "Özel" };

export default async function KnowledgePage() {
  const brand = await requireBrand();
  const isFribee = /fribee/i.test(brand.name);
  const graph = seedFribeeGraph(brand.id);
  const roadmap = buildPrRoadmap(graph, null);
  return (
    <div>
      <PageHeader
        title="Marka Bilgisi ve PR Planı"
        subtitle={<>Kaynaklı marka bilgi grafiği, rol bazlı erişim ve 24 aylık PR yol haritası. Yalnızca <strong>onaylı</strong> bilgiler ajanlara gerçek olarak verilir.</>}
      />
      {!isFribee && <p className="mb-3 text-sm text-amber-800">Bu pano şu an FriBee başlangıç verisini gösteriyor; seçili marka: {brand.name}.</p>}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card">
          <h2 className="h2 mb-2">FriBee Master Archive</h2>
          <Badge tone="warn">Bağlı değil</Badge>
          <p className="muted mt-2 text-xs">Salt okunur Google Drive OAuth, marka kök klasörü ve sahip onayı gerekli. Bağlanınca dosyalar orijinal Drive kimliği, bağlantı ve revizyonla artımlı olarak dizinlenir.</p>
          <p className="mt-2 text-xs">Eksik kaynak kategorileri: {roadmap.missingSources.join(", ")}</p>
        </section>
        <section className="card">
          <h2 className="h2 mb-2">Onaylı temalar</h2>
          <ul className="space-y-1 text-sm">
            {graph.list(brand.id, "collection").map((c) => (
              <li key={c.id}>{c.name} — {graph.canonicalFacts(brand.id, c.id)[0]?.value}</li>
            ))}
            <li>Mandala → Music</li>
          </ul>
          <p className="muted mt-2 text-xs">Kaynak: sahip beyanı (issue #22). Ürün adları ve hikâyeler arşivden çıkarılıp incelemeden geçmeden eklenmez.</p>
        </section>
        <section className="card overflow-x-auto">
          <h2 className="h2 mb-2">Rol erişimi</h2>
          <table className="w-full text-xs">
            <thead><tr><th scope="col" className="text-left">Rol</th>{SENSITIVITIES.map((s) => <th scope="col" key={s}>{SENS[s]}</th>)}</tr></thead>
            <tbody>
              {KNOWLEDGE_ROLES.map((r) => (
                <tr key={r}><td>{ROLE_LABELS[r]}</td>{SENSITIVITIES.map((s) => <td key={s} className="text-center">{ROLE_ACCESS[r].includes(s) ? "✓" : "—"}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      <section className="card mt-4">
        <h2 className="h2 mb-1">24 aylık ABD bilinirlik planı (Kasım 2026 – Ekim 2028)</h2>
        <Badge tone="warn">Öneri — gerçek değil</Badge>
        <p className="muted mt-2 text-xs">{roadmap.disclaimer}</p>
        <ol className="mt-3 grid gap-3 md:grid-cols-2">
          {roadmap.quarters.map((q) => (
            <li key={q.n} className="rounded-lg border border-line p-3">
              <strong className="text-sm">{q.label}</strong> <span className="text-xs text-muted">{q.start} → {q.end}</span>
              <p className="mt-1 text-sm">{q.focus}</p>
              <ul className="mt-1 list-disc pl-5 text-xs">{q.actions.map((a) => <li key={a}>{a}</li>)}</ul>
              <p className="mt-1 text-xs text-muted">Sahip onayı: {q.ownerApprovals.join(", ")}</p>
            </li>
          ))}
        </ol>
        <h3 className="mt-3 text-sm font-medium">Ölçütler (temel değer Q1&apos;de ölçülür, hedefi sahip belirler)</h3>
        <ul className="list-disc pl-5 text-xs">{roadmap.metrics.map((m) => <li key={m.name}><strong>{m.name}:</strong> {m.definition}</li>)}</ul>
        <h3 className="mt-3 text-sm font-medium">Kurallar</h3>
        <ul className="list-disc pl-5 text-xs">{roadmap.guardrails.map((g) => <li key={g}>{g}</li>)}</ul>
        <p className="mt-2 text-xs text-muted">Aylık inceleme: {roadmap.monthlyReviews.length} ay ({roadmap.monthlyReviews[0]} – {roadmap.monthlyReviews[roadmap.monthlyReviews.length - 1]}).</p>
      </section>
    </div>
  );
}
