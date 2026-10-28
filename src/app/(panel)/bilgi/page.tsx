import Link from "next/link";
import { flash, requireBrand, type SP } from "@/lib/current";
import { ROLE_ACCESS, ROLE_LABELS } from "@/lib/knowledge/access";
import { ENTITY_TYPES } from "@/lib/knowledge/graph";
import { searchKnowledge } from "@/lib/knowledge/retrieval";
import { knowledgeForRole, listKnowledgeFacts, loadKnowledge } from "@/lib/knowledge/store";
import { KNOWLEDGE_ROLES, SENSITIVITIES, type KnowledgeRole } from "@/lib/knowledge/types";
import { FRIBEE_THEMES, THEME_INFO } from "@/lib/drive/themes";
import { knowledgeAddFactAction, knowledgeConfirmCollectionsAction, knowledgeDecideAction } from "@/app/actions";
import { SubmitButton } from "@/components/client";
import { Badge, Empty, Flash, PageHeader, dt } from "@/components/ui";

export const dynamic = "force-dynamic";

const SENS: Record<string, string> = { public: "Herkese açık", internal: "İç", vendor: "Tedarikçi", finance: "Finans", private: "Özel" };
const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  confirmed: { label: "Onaylı", tone: "ok" },
  extracted: { label: "Arşivden çıkarıldı — inceleme", tone: "warn" },
  suggested: { label: "Öneri — inceleme", tone: "warn" },
  rejected: { label: "Reddedildi", tone: "bad" },
};
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function KnowledgePage({ searchParams }: { searchParams: SP }) {
  const brand = await requireBrand();
  const sp = await searchParams;
  const { ok, err } = await flash(searchParams);
  const role = ((KNOWLEDGE_ROLES as readonly string[]).includes(one(sp.role)) ? one(sp.role) : "manager") as KnowledgeRole;
  const query = one(sp.q).trim().slice(0, 100);
  const [view, pending, confirmed] = await Promise.all([
    knowledgeForRole(brand.id, "manager"),
    listKnowledgeFacts(brand.id, { status: "pending", limit: 100 }),
    listKnowledgeFacts(brand.id, { status: "confirmed", limit: 200 }),
  ]);
  const search = query ? searchKnowledge({ ...(await loadKnowledge(brand.id)), brandId: brand.id, role, query }) : null;
  const roleViews = await Promise.all(KNOWLEDGE_ROLES.map(async (r) => ({ role: r, v: await knowledgeForRole(brand.id, r) })));
  const hasCollections = view.collections.some((c) => c.color);

  return (
    <div>
      <PageHeader
        title="Marka Bilgi Merkezi"
        subtitle={<>FriBee Master Archive (Google Drive) dizini, sahibin doğruladığı baskılar ve kaynaklı bilgiler. Ajanlara yalnızca <strong>onaylı</strong> bilgiler, yalnızca kendi rollerinin görebildiği hassasiyette verilir.</>}
        actions={<Link href="/pr-ajansi" className="btn">PR Ajansı ve 24 aylık plan</Link>}
      />
      <Flash ok={ok} err={err} />

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card space-y-2">
          <h2 className="h2">Arşiv</h2>
          {view.archive.connected ? <Badge tone="ok">Drive bağlı</Badge> : <Badge tone="warn">Drive bağlı değil</Badge>}
          <p className="text-xs text-muted">Son eşitleme: {dt(view.archive.last_synced_at)} · <Link href="/drive-arsivi" className="text-brand underline">Drive Arşivi</Link></p>
          <ul className="text-xs">
            {Object.entries(view.archive.files_by_category).map(([k, n]) => <li key={k}>{k}: {n}</li>)}
          </ul>
          {!view.archive.connected && <p className="text-xs text-muted">Bağlanınca dosyalar orijinal Drive kimliği, yol ve sürümüyle dizinlenir; kategori ve hassasiyet otomatik atanır.</p>}
        </section>

        <section className="card space-y-2 lg:col-span-2">
          <h2 className="h2">Koleksiyonlar</h2>
          {!hasCollections && (
            <form action={knowledgeConfirmCollectionsAction} className="space-y-1">
              <p className="text-sm">Sahibin bildirdiği dört koleksiyon henüz onaylı bilgi değil: Space Alien (siyah), Music (beyaz, mandala), Anime (turuncu), Save the Bee (açık mavi).</p>
              <SubmitButton className="btn-primary" confirm="Dört koleksiyon ve renkleri onaylı bilgi olarak kaydedilsin mi?">Koleksiyonları onayla</SubmitButton>
            </form>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {view.collections.map((c) => (
              <div key={c.key} className="rounded-lg border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><strong>{c.name}</strong>{c.color ? <Badge tone="ok">{c.color}</Badge> : <Badge tone="warn">renk onaylı değil</Badge>}</div>
                <div className="mt-1 text-xs">Doğrulanmış baskı görseli: {c.verified_prints.length} ({c.verified_prints.map((p) => p.view).join(", ") || "—"}) · arşive alınmış: {c.verified_prints.filter((p) => p.media_asset_id).length}</div>
                {c.facts.map((f, i) => <div key={i} className="text-xs text-muted">{f.attribute}: {f.value.slice(0, 120)} — {f.source}</div>)}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card mt-4">
        <h2 className="h2 mb-2">İnceleme kuyruğu ({pending.length})</h2>
        {pending.length === 0 ? <Empty>İnceleme bekleyen bilgi yok.</Empty> : (
          <ul className="space-y-2">
            {pending.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-sm">
                <Badge tone={STATUS[f.status].tone}>{STATUS[f.status].label}</Badge>
                <strong>{f.entity_name}</strong><span>· {f.attribute}:</span><span className="break-all">{f.value.slice(0, 200)}</span>
                <span className="text-xs text-muted">({SENS[f.sensitivity]}; kaynak: {f.item_name ? `Drive: ${f.item_name}` : f.source_note ?? "yok"})</span>
                <form action={knowledgeDecideAction}><input type="hidden" name="id" value={f.id} /><input type="hidden" name="decision" value="confirm" /><SubmitButton className="btn py-1">Onayla</SubmitButton></form>
                <form action={knowledgeDecideAction}><input type="hidden" name="id" value={f.id} /><input type="hidden" name="decision" value="reject" /><SubmitButton className="btn py-1">Reddet</SubmitButton></form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section className="card h-fit">
          <h2 className="h2 mb-2">Bilgi ekle</h2>
          <form action={knowledgeAddFactAction} className="space-y-2 text-sm">
            <label className="block text-xs">Koleksiyon (varsa)
              <select name="collection" className="input" defaultValue="">
                <option value="">— Koleksiyon dışı varlık —</option>
                {FRIBEE_THEMES.map((t) => <option key={t} value={t}>{THEME_INFO[t].label}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs">Varlık türü
                <select name="entityType" className="input" defaultValue="product">{ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
              </label>
              <label className="block text-xs">Varlık adı<input name="entityName" className="input" maxLength={200} placeholder="ör. Anime Tee" /></label>
            </div>
            <label className="block text-xs">Öznitelik<input name="attribute" className="input" required maxLength={60} placeholder="ör. product_name, story, print_front, supplier" /></label>
            <label className="block text-xs">Değer<textarea name="value" className="input" required maxLength={4000} rows={3} /></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs">Hassasiyet
                <select name="sensitivity" className="input" defaultValue="internal">{SENSITIVITIES.map((s) => <option key={s} value={s}>{SENS[s]}</option>)}</select>
              </label>
              <label className="block text-xs">Durum
                <select name="status" className="input" defaultValue="suggested"><option value="suggested">Öneri (inceleme)</option><option value="confirmed">Onaylı (kaynak gerekli)</option></select>
              </label>
            </div>
            <label className="block text-xs">Kaynak notu<input name="sourceNote" className="input" maxLength={500} placeholder="ör. 2025 lookbook s.4 veya sahip kararı" /></label>
            <SubmitButton className="btn-primary">Kaydet</SubmitButton>
          </form>
        </section>

        <section className="card lg:col-span-2">
          <h2 className="h2 mb-2">Rol bazlı arama</h2>
          <form className="flex flex-wrap gap-2" action="/bilgi">
            <input name="q" defaultValue={query} className="input max-w-sm" placeholder="ör. anime back print, story, lookbook" maxLength={100} />
            <select name="role" defaultValue={role} className="input max-w-[14rem]" aria-label="Rol">{KNOWLEDGE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
            <button className="btn">Ara</button>
          </form>
          {search && (
            <div className="mt-3 space-y-2 text-sm">
              {search.warnings.map((w) => <p key={w} className="text-xs text-warning">{w}</p>)}
              {search.entities.map((e) => (
                <div key={e.id}><strong>{e.name}</strong> <span className="text-xs text-muted">({e.type})</span>
                  <ul className="list-disc pl-5 text-xs">{e.facts.map((f, i) => <li key={i}>{f.attribute}: {f.value.slice(0, 160)} <Badge tone={STATUS[f.status]?.tone ?? "neutral"}>{STATUS[f.status]?.label ?? f.status}</Badge>{f.flags.length ? ` ⚠ ${f.flags.join(", ")}` : ""}</li>)}</ul>
                </div>
              ))}
              {search.files.length > 0 && (
                <ul className="text-xs">{search.files.map((f) => <li key={f.driveFileId}><a href={f.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-brand">{f.name}</a> <span className="text-muted">{f.path} · {f.category}{f.width ? ` · ${f.width}x${f.height}` : ""}</span></li>)}</ul>
              )}
              {!search.entities.length && !search.files.length && <Empty>Bu rol için sonuç yok.</Empty>}
            </div>
          )}
          <h3 className="mt-4 text-sm font-medium">Rollerin gördüğü</h3>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Rol erişim tablosu">
            <table className="w-full text-xs">
              <thead><tr><th scope="col" className="text-left">Rol</th>{SENSITIVITIES.map((s) => <th scope="col" key={s}>{SENS[s]}</th>)}<th scope="col">Görülen dosya</th><th scope="col">Gizlenen kayıt</th></tr></thead>
              <tbody>
                {roleViews.map(({ role: r, v }) => (
                  <tr key={r} className="border-t border-line"><td>{ROLE_LABELS[r]}</td>{SENSITIVITIES.map((s) => <td key={s} className="text-center">{ROLE_ACCESS[r].includes(s) ? "✓" : "—"}</td>)}<td className="text-center">{Object.values(v.archive.files_by_category).reduce((a, b) => a + (b ?? 0), 0)}</td><td className="text-center">{v.withheld}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-muted">“Özel” kayıtlar (sözleşme, ortaklık) hiçbir ajana verilmez. Finans kayıtları yalnızca Finans ajanına verilir. AI Yönetici: Ana Yönetici ve Kalite; Video/Tasarım; Shopify/Pazarlama/Sosyal; PR; Finans.</p>
        </section>
      </div>

      <section className="card mt-4">
        <h2 className="h2 mb-2">Onaylı bilgiler ({confirmed.length})</h2>
        {confirmed.length === 0 ? <Empty>Henüz onaylı bilgi yok.</Empty> : (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Onaylı bilgiler">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted"><th className="py-1">Varlık</th><th>Öznitelik</th><th>Değer</th><th>Hassasiyet</th><th>Kaynak</th><th>Karar</th></tr></thead>
              <tbody>{confirmed.map((f) => (
                <tr key={f.id} className="border-t border-line align-top"><td className="py-1 pr-2">{f.entity_name} <span className="text-muted">({f.entity_type})</span></td><td className="pr-2">{f.attribute}</td><td className="pr-2 break-all">{f.value.slice(0, 200)}</td><td className="pr-2">{SENS[f.sensitivity]}</td><td className="pr-2">{f.item_name ? `Drive: ${f.item_name}` : f.source_note}</td><td>{f.decided_by} · {dt(f.decided_at)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
