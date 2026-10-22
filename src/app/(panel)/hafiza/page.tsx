import { flash, requireBrand, type SP } from "@/lib/current";
import { listMemory, MEMORY_CONTEXT_MAX_ITEMS, type BrandMemory } from "@/lib/services/brand-memory";
import { AGENTS, agentName } from "@/lib/agents/registry";
import { addMemoryAction, setMemoryStatusAction } from "@/app/actions";
import { Badge, Empty, Flash, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/client";

export const dynamic = "force-dynamic";

const KIND: Record<string, string> = {
  guideline: "Marka yönergesi",
  lesson: "Ders (geçmiş geri bildirim)",
  preference: "Tercih",
  agent_instruction: "Ajan talimatı",
  strategy: "Strateji notu",
  campaign_note: "Kampanya notu",
};
const SOURCE: Record<string, string> = { owner: "Sahip", rejection: "Ret notundan öneri", research: "Araştırmadan öneri" };

function Item({ m }: { m: BrandMemory }) {
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{m.title}</strong>
        <Badge>{KIND[m.kind] ?? m.kind}</Badge>
        <Badge tone="info">{m.agent ? agentName(m.agent) : "Tüm ajanlar"}</Badge>
        <Badge tone={m.status === "active" ? "ok" : m.status === "proposed" ? "warn" : "neutral"}>
          {m.status === "active" ? "Etkin" : m.status === "proposed" ? "Öneri — etkin değil" : "Arşiv"}
        </Badge>
        <span className="text-xs text-muted">{SOURCE[m.source]} · {new Date(m.created_at).toLocaleString("tr-TR")}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{m.body}</p>
      <div className="mt-2 flex gap-2">
        {m.status !== "active" && (
          <form action={setMemoryStatusAction}><input type="hidden" name="id" value={m.id} /><input type="hidden" name="status" value="active" /><SubmitButton className="btn py-1">Etkinleştir</SubmitButton></form>
        )}
        {m.status !== "archived" && (
          <form action={setMemoryStatusAction}><input type="hidden" name="id" value={m.id} /><input type="hidden" name="status" value="archived" /><SubmitButton className="btn py-1">Arşivle</SubmitButton></form>
        )}
      </div>
    </li>
  );
}

export default async function MemoryPage({ searchParams }: { searchParams: SP }) {
  const brand = await requireBrand();
  const { ok, err } = await flash(searchParams);
  const items = await listMemory(brand.id);
  const proposed = items.filter((m) => m.status === "proposed");
  const active = items.filter((m) => m.status === "active");
  const archived = items.filter((m) => m.status === "archived");
  return (
    <div>
      <PageHeader
        title="Marka Hafızası"
        subtitle={<>{brand.name} için ajanların her görevde uyduğu yönergeler, dersler ve talimatlar. Yalnızca <strong>etkin</strong> kayıtlar ajanlara verilir (en fazla {MEMORY_CONTEXT_MAX_ITEMS}). Kayıtlar yalnızca bu markaya aittir; diğer markaların ajanları göremez.</>}
      />
      <Flash ok={ok} err={err} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="card">
            <h2 className="h2 mb-2">Onay bekleyen öneriler ({proposed.length})</h2>
            <p className="muted mb-2 text-xs">Ret notlarından otomatik önerilir. Siz etkinleştirmedikçe ajanlar bunları kullanmaz.</p>
            {proposed.length ? <ul className="space-y-2">{proposed.map((m) => <Item key={m.id} m={m} />)}</ul> : <Empty>Öneri yok.</Empty>}
          </section>
          <section className="card">
            <h2 className="h2 mb-2">Etkin kayıtlar ({active.length})</h2>
            {active.length ? <ul className="space-y-2">{active.map((m) => <Item key={m.id} m={m} />)}</ul> : <Empty>Henüz etkin kayıt yok.</Empty>}
          </section>
          {archived.length > 0 && (
            <details className="card">
              <summary className="cursor-pointer text-sm font-medium">Arşiv ({archived.length})</summary>
              <ul className="mt-2 space-y-2">{archived.map((m) => <Item key={m.id} m={m} />)}</ul>
            </details>
          )}
        </div>
        <section className="card h-fit">
          <h2 className="h2 mb-2">Yeni kayıt</h2>
          <form action={addMemoryAction} className="space-y-2">
            <label className="block text-sm" htmlFor="mem-kind">Tür</label>
            <select id="mem-kind" name="kind" className="input">
              {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label className="block text-sm" htmlFor="mem-agent">Hangi ajan</label>
            <select id="mem-agent" name="agent" className="input">
              <option value="">Tüm ajanlar</option>
              {Object.values(AGENTS).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <label className="block text-sm" htmlFor="mem-title">Başlık</label>
            <input id="mem-title" name="title" className="input" required maxLength={200} placeholder="Örn: Ürün fotoğraflarında renk düzeltmesi yok" />
            <label className="block text-sm" htmlFor="mem-body">Metin</label>
            <textarea id="mem-body" name="body" rows={4} className="input" required maxLength={4000} placeholder="Ajanların uyacağı kural veya ders." />
            <p className="text-xs text-muted">Parola, API anahtarı veya kart bilgisi yazmayın; böyle görünen metin kaydedilmez.</p>
            <SubmitButton className="btn-primary">Ekle (hemen etkin)</SubmitButton>
          </form>
        </section>
      </div>
    </div>
  );
}
