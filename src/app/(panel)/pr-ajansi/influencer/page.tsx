import Link from "next/link";
import { requireBrand } from "@/lib/current";
import { AwaitingSetup, Empty, PageHeader, Section, dt } from "@/components/ui";
import { Icon } from "@/components/icons";
import { EvidenceRule, SpecialistCard } from "@/components/agency";
import { specialistById } from "@/lib/pr-agency/specialists";
import { listIntegrations } from "@/lib/integrations/service";
import { listPrOutputs } from "@/lib/services/pr-agency";

export const metadata = { title: "Influencer Ağı" };
export const dynamic = "force-dynamic";

const RULES = [
  "Var olmayan bir iş birliği veya ortaklık varsayılmaz; her öneri taslaktır.",
  "Ücretli veya hediyeli her iş birliği açıkça beyan edilir (ör. #ad / Paid partnership).",
  "İçerik oluşturucuya ulaşım, ürün gönderimi ve ödeme yalnızca sahip onayıyla yapılır.",
  "Ürün görselleri ve baskılar değiştirilmeden kullanılır; yalnızca doğrulanmış görseller paylaşılır.",
];

export default async function InfluencerPage() {
  const brand = await requireBrand();
  const [cards, outputs] = await Promise.all([listIntegrations(brand.id), listPrOutputs(brand.id, 30)]);
  const states = new Map(cards.map((c) => [c.def.id, c.state]));
  const weekly = outputs.find((o) => o.kind === "pr_weekly_report");
  const section = Array.isArray(weekly?.content?.sections) ? weekly!.content.sections.find((s: any) => s.title === "Influencer opportunities") : null;
  const bw = states.get("brandwatch");
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="PR Ajansı" title="Influencer Ağı" subtitle="İçerik oluşturucu fırsatları ve beyanlı iş birliği önerileri. Haftalık raporda kaynaklı fırsatlar listelenir; ulaşım ve gönderim sahip onayı olmadan yapılmaz."
        actions={<Link href="/sohbet" className="btn-primary"><Icon name="spark" />İş birliği önerisi iste</Link>} />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2"><SpecialistCard s={specialistById("influencer_relations")!} states={states} /></div>
        <Section id="rules" title="İş birliği kuralları">
          <ul className="space-y-2 text-sm text-ink-soft">{RULES.map((r) => <li key={r} className="flex gap-2"><Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-success" />{r}</li>)}</ul>
          <div className="mt-4"><EvidenceRule kind="delivery_evidence" /></div>
        </Section>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section id="opps" title="Bu haftanın fırsatları" eyebrow={weekly ? `Haftalık rapor · ${dt(weekly.created_at)}` : "Haftalık rapor"} href={weekly ? `/taslaklar/${weekly.id}` : undefined} linkLabel="Raporu aç">
          {section ? <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">{section.bullets.map((b: string) => <li key={b}>{b}</li>)}</ul> : <Empty icon="users">Henüz haftalık rapor yok. Zamanlama açıkken her Pazartesi hazırlanır.</Empty>}
        </Section>
        <Section id="data" title="İçerik oluşturucu verisi">
          {bw === "verified" || bw === "degraded" ? (
            <p className="text-sm text-ink-soft">Brandwatch kimliği doğrulandı; içerik oluşturucu verisi senkronu resmî belge incelendikten sonra eklenecek.</p>
          ) : (
            <AwaitingSetup href="/entegrasyonlar" linkLabel="Brandwatch'ı bağla">Kitle ve içerik oluşturucu verisi için Brandwatch bağlantısı bekleniyor. Takipçi veya erişim sayısı tahmin edilmez.</AwaitingSetup>
          )}
        </Section>
      </div>
    </div>
  );
}
