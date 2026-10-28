import Link from "next/link";
import { notFound } from "next/navigation";
import { requireBrand } from "@/lib/current";
import { q, q1 } from "@/lib/db/pool";
import { AwaitingSetup, Badge, Empty, PageHeader, Section, Stat, dt } from "@/components/ui";
import { Icon } from "@/components/icons";
import { integrationCard } from "@/lib/integrations/service";
import { STATE_LABEL, STATE_TONE } from "@/lib/integrations/registry";

export const dynamic = "force-dynamic";

const SECTIONS = {
  "e-ticaret": { title: "E-ticaret", subtitle: "Shopify mağaza bağlantısı, ürün kataloğu senkronu ve onaylı mağaza değişiklikleri." },
  musteriler: { title: "Müşteriler", subtitle: "Müşteri içgörüleri yalnızca Shopify'dan, korumalı müşteri verisi izniyle okunur. Kişisel veri uydurulmaz veya dışarı aktarılmaz." },
  satis: { title: "Satış Analitiği", subtitle: "Satış, sipariş ve kampanya atfı yalnızca bağlı mağazanın gerçek sipariş verisinden hesaplanır." },
} as const;
type Key = keyof typeof SECTIONS;

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const s = SECTIONS[(await params).section as Key];
  return { title: s?.title ?? "İş" };
}

export default async function BusinessPage({ params }: { params: Promise<{ section: string }> }) {
  const key = (await params).section as Key;
  const meta = SECTIONS[key];
  if (!meta) notFound();
  const brand = await requireBrand();
  const [shop, products, synced, actions] = await Promise.all([
    integrationCard(brand.id, "shopify"),
    q1<{ total: number; active: number; shopify: number }>(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(*) FILTER (WHERE shopify_product_id IS NOT NULL)::int AS shopify FROM products WHERE brand_id = $1 AND is_sample = false`, [brand.id]),
    q1<{ updated: string | null }>(`SELECT MAX(updated_at) AS updated FROM products WHERE brand_id = $1 AND shopify_product_id IS NOT NULL`, [brand.id]),
    q<{ id: string; action_type: string; status: string; created_at: string }>(`SELECT id, action_type, status, created_at FROM external_actions WHERE brand_id = $1 AND provider = 'shopify' ORDER BY created_at DESC LIMIT 5`, [brand.id]),
  ]);
  const connected = shop.state === "verified";
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="İş" title={meta.title} subtitle={meta.subtitle}
        actions={<><Badge tone={STATE_TONE[shop.state]}>Shopify: {STATE_LABEL[shop.state]}</Badge><Link href="/entegrasyonlar" className="btn"><Icon name="plug" />Entegrasyonlar</Link></>} />
      <nav aria-label="İş bölümleri" className="flex flex-wrap gap-2">
        {(Object.keys(SECTIONS) as Key[]).map((k) => <Link key={k} href={`/is/${k}`} className={k === key ? "chip-active" : "chip"} aria-current={k === key ? "page" : undefined}>{SECTIONS[k].title}</Link>)}
      </nav>

      {key === "e-ticaret" && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Ürün kaydı" icon="tag" value={products?.total ?? 0} href="/urunler" hint={`${products?.active ?? 0} aktif`} />
            <Stat label="Shopify'dan senkron" icon="cart" accent="mint" value={products?.shopify ?? 0} hint={synced?.updated ? `Son senkron: ${dt(synced.updated)}` : "Henüz senkron yok"} />
            <Stat label="Mağaza" icon="globe" accent="sky" value={shop.meta.account?.shop ? String(shop.meta.account.shop) : "—"} hint={shop.config.shop || "Alan adı girilmedi"} />
            <Stat label="Son doğrulama" icon="shield" accent="violet" value={shop.meta.lastSuccessAt ? dt(shop.meta.lastSuccessAt).split(" ")[0] : "—"} hint={shop.lastError ?? "Okuma testi"} />
          </div>
          {!connected && <AwaitingSetup href="/entegrasyonlar" linkLabel="Shopify'ı bağla">Shopify Dev Dashboard uygulamasının kimliği (SHOPIFY_CLIENT_ID/SECRET) sunucu ortamına eklenmeli ve mağaza alan adıyla test edilmelidir.</AwaitingSetup>}
          <Section id="shop-actions" title="Mağaza değişiklikleri" eyebrow="Yalnızca onaylı öneriler uygulanır" href="/onaylar">
            {actions.length === 0 ? <Empty icon="cart">Mağazaya uygulanmış değişiklik yok.</Empty> : (
              <ul className="space-y-2 text-sm">{actions.map((a) => <li key={a.id} className="flex items-center justify-between gap-2"><span>{a.action_type}</span><span className="flex items-center gap-2"><Badge tone={a.status === "succeeded" ? "ok" : a.status === "failed" ? "bad" : "warn"}>{a.status}</Badge><span className="text-xs text-muted">{dt(a.created_at)}</span></span></li>)}</ul>
            )}
          </Section>
        </>
      )}
      {key === "musteriler" && (
        <AwaitingSetup title="Müşteri verisi bağlı değil" href="/entegrasyonlar" linkLabel="Shopify ayarları">
          {connected ? "Mağaza bağlı; müşteri içgörüleri için uygulamaya read_customers kapsamı ve Shopify'ın korumalı müşteri verisi onayı verilmelidir. Bu sürümde müşteri verisi okunmuyor." : "Önce Shopify bağlanmalı. Ardından read_customers kapsamı ve korumalı müşteri verisi onayı gerekir."} Müşteri sayısı, segment veya yaşam boyu değer tahmin edilmez.
        </AwaitingSetup>
      )}
      {key === "satis" && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {["Gelir", "Sipariş", "Ortalama sepet", "Kampanya atfı"].map((l) => <Stat key={l} label={l} value="—" hint="Sipariş verisi bağlı değil" />)}
          </div>
          <AwaitingSetup title="Sipariş verisi bağlı değil" href="/entegrasyonlar" linkLabel="Shopify ayarları">
            {connected ? "Mağaza bağlı; satış analitiği için uygulamaya read_orders kapsamı verilmeli. Kapsam eklendikten sonra sipariş senkronu açılacak." : "Önce Shopify bağlanmalı ve read_orders kapsamı verilmeli."} Satış rakamı tahmin edilmez veya örnek veriyle doldurulmaz.
          </AwaitingSetup>
        </>
      )}
    </div>
  );
}
