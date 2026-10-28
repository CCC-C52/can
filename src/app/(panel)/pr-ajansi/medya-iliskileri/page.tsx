import Link from "next/link";
import { requireBrand } from "@/lib/current";
import { q } from "@/lib/db/pool";
import { AwaitingSetup, Badge, Empty, PageHeader, Section, dt } from "@/components/ui";
import { Icon } from "@/components/icons";
import { EvidenceRule, SpecialistCard } from "@/components/agency";
import { specialistById } from "@/lib/pr-agency/specialists";
import { listIntegrations } from "@/lib/integrations/service";

export const metadata = { title: "Medya İlişkileri" };
export const dynamic = "force-dynamic";

export default async function MediaRelationsPage() {
  const brand = await requireBrand();
  const [cards, drafts, actions] = await Promise.all([
    listIntegrations(brand.id),
    q<{ id: string; title: string; kind: string; created_at: string }>(`SELECT id, title, kind, created_at FROM outputs WHERE brand_id = $1 AND kind IN ('pr_plan','pr_event_plan','pr_alert') ORDER BY created_at DESC LIMIT 12`, [brand.id]),
    q<{ id: string; action_type: string; status: string; external_id: string | null; created_at: string }>(`SELECT id, action_type, status, COALESCE(response->>'mediaId', response->>'id') AS external_id, created_at FROM external_actions WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 5`, [brand.id]),
  ]);
  const states = new Map(cards.map((c) => [c.def.id, c.state]));
  const mr = states.get("muck_rack") ?? "not_configured";
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="PR Ajansı" title="Medya İlişkileri" subtitle="Gazeteci ve yayın araştırması, basın bülteni ve pitch taslakları, basın kapsamı takibi. Hiçbir e-posta veya mesaj sahip onayı ve yetkili gönderim kanıtı olmadan gönderilmez; kapsam yalnızca doğrulanabilir bağlantıyla raporlanır."
        actions={<Link href="/sohbet" className="btn-primary"><Icon name="spark" />Pitch taslağı iste</Link>} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2"><SpecialistCard s={specialistById("media_relations")!} states={states} /></div>
        <Section id="mr" title="Muck Rack" eyebrow="Gazeteci veritabanı ve kapsam izleme">
          <AwaitingSetup title={mr === "blocked" ? "Erişim bekliyor" : "Kurulum bekliyor"} href="/entegrasyonlar" linkLabel="Entegrasyon Merkezi">
            Muck Rack API, Premier planda ücretli bir eklentidir ve başvuru belgesi yalnızca erişimi olan müşterilere verilir. Anahtar ve resmî belge sağlandığında kapsam izleme bağlanacak; o zamana kadar gazeteci veya kapsam verisi gösterilmez.
          </AwaitingSetup>
          <div className="mt-4"><EvidenceRule kind="delivery_evidence" /></div>
        </Section>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section id="drafts" title="PR taslakları" eyebrow="Onay kuyruğunda" href="/taslaklar">
          {drafts.length === 0 ? <Empty icon="mic">Henüz PR taslağı yok. AI Yönetici'den bir basın açısı veya etkinlik planı isteyin.</Empty> : (
            <ul className="divide-y divide-line text-sm">{drafts.map((d) => <li key={d.id} className="flex items-center justify-between gap-2 py-2"><Link href={`/taslaklar/${d.id}`} className="min-w-0 truncate hover:text-brand">{d.title}</Link><span className="shrink-0 text-xs text-muted">{dt(d.created_at)}</span></li>)}</ul>
          )}
        </Section>
        <Section id="sent" title="Dış işlemler" eyebrow="Gönderim kanıtı" href="/onaylar">
          {actions.length === 0 ? <Empty icon="shield">Gönderilmiş dış işlem yok. Bu sürümde e-posta/DM gönderimi bulunmuyor; yalnızca taslak hazırlanır.</Empty> : (
            <ul className="space-y-2 text-sm">{actions.map((a) => <li key={a.id} className="flex items-center justify-between gap-2"><span>{a.action_type}</span><span className="flex items-center gap-2"><Badge tone={a.status === "succeeded" && a.external_id ? "ok" : a.status === "failed" ? "bad" : "warn"}>{a.status}</Badge><span className="text-xs text-muted">{dt(a.created_at)}</span></span></li>)}</ul>
          )}
        </Section>
      </div>
    </div>
  );
}
