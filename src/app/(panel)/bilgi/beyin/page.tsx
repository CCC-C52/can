import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { brainStatus } from "@/lib/brain/status";
import { searchBrain } from "@/lib/brain/retrieval";
import { listKnowledgeFacts } from "@/lib/knowledge/store";
import { KNOWLEDGE_ROLES, type KnowledgeRole } from "@/lib/knowledge/types";
import { ROLE_LABELS } from "@/lib/knowledge/access";
import { Badge, Empty, Flash, PageHeader, Stat, dt, usd } from "@/components/ui";
import { SubmitButton } from "@/components/client";
import { brainApproveBatchAction, brainBudgetsAction, brainEmbeddingsAction, brainFactDecisionAction, brainPauseAction, brainReindexAction, brainRetryAction } from "@/app/actions/brain";

export const dynamic = "force-dynamic";

// FriBee Brand Brain — Marka Bilgi Merkezi içinde bir bölüm (ayrı uygulama değil). Her değer veritabanından veya
// sağlayıcı durumundan okunur; ölçülemeyen değer "ölçülmedi" olarak gösterilir.

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const STATUS_LABEL: Record<string, string> = {
  indexed: "içerik çıkarıldı", metadata_only: "yalnızca üst veri", unsupported: "desteklenmiyor", pending: "kuyrukta", processing: "işleniyor",
  failed: "başarısız", dead: "ölü mektup (deneme sınırı)", removed: "kaldırıldı",
};

export default async function BrandBrainPage({ searchParams }: { searchParams: SP }) {
  const brand = await requireBrand();
  const sp = await searchParams;
  const { ok, err } = await flash(searchParams);
  const role = ((KNOWLEDGE_ROLES as readonly string[]).includes(one(sp.role)) ? one(sp.role) : "manager") as KnowledgeRole;
  const query = one(sp.q).trim().slice(0, 200);
  const mode = one(sp.mode) === "test" ? "test" : "search";
  const [st, claims] = await Promise.all([brainStatus(brand.id), listKnowledgeFacts(brand.id, { status: "pending", limit: 200 })]);
  const brainClaims = claims.filter((c) => c.created_by === "brain");
  // Arama: panel aramasında işaretli (enjeksiyon şüpheli) parçalar da görünür; "uzman testi" ajanın göreceğini birebir gösterir
  const search = query ? await searchBrain({ brandId: brand.id, role, query, limit: 12, excludeFlagged: mode === "test", record: { purpose: mode === "test" ? "test" : "dashboard" } }) : null;
  const d = st.documents;

  return (
    <div>
      <PageHeader
        eyebrow="Marka Bilgi Merkezi"
        title="Brand Brain"
        subtitle={<>Google Drive arşivinin içerik dizini: belgeler okunur, parçalanır, aranır ve uzmanlara <strong>rollerinin izin verdiği</strong> kaynaklarla verilir. Drive salt okunur kullanılır; hiçbir dosya değiştirilmez.</>}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/bilgi" className="btn">Bilgi Merkezi</Link>
            <form action={brainPauseAction}>
              <input type="hidden" name="paused" value={st.paused ? "0" : "1"} />
              <SubmitButton className="btn">{st.paused ? "İşlemeyi sürdür" : "İşlemeyi duraklat"}</SubmitButton>
            </form>
          </div>
        }
      />
      <Flash ok={ok} err={err} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Drive bağlantısı" icon="drive" value={st.drive ? (st.drive.connected ? "Bağlı" : st.drive.status === "reauth_required" ? "Yeniden yetki" : st.drive.status) : "Bağlı değil"}
          tone={st.drive?.connected ? "ok" : "warn"} hint={st.drive ? `Son eşitleme: ${dt(st.drive.last_success_at)}` : <Link className="link" href="/drive-arsivi">Drive Arşivi'nden bağlayın</Link>} />
        <Stat label="Erişilebilir arşiv" icon="archive" value={`${st.archive.files.toLocaleString("tr-TR")} dosya`} hint={`${gb(st.archive.bytes)} · ${st.archive.folders} klasör (Drive'ın bildirdiği boyut)`} />
        <Stat label="İçerik çıkarılan" icon="draft" value={d.contentExtracted.toLocaleString("tr-TR")} hint={`${d.metadataOnly} yalnızca üst veri · ${d.duplicates} kopya · kapsama ${d.coverage === null ? "ölçülmedi" : `%${d.coverage}`}`} />
        <Stat label="Anlamsal arama kapsamı" icon="search" value={st.chunks.semanticCoverage === null ? "—" : `%${st.chunks.semanticCoverage}`}
          hint={st.semantic.enabled ? `${st.chunks.embedded}/${st.chunks.eligible} parça gömüldü` : "Kapalı: tam metin araması çalışır"} />
        <Stat label="Bekleyen inceleme" icon="check" value={st.reviews.extracted + st.reviews.suggested + st.reviews.referencesUncertain}
          hint={`${st.reviews.extracted} çıkarılan iddia · ${st.reviews.referencesUncertain} ürün referansı · ${st.reviews.conflicts} çakışma`} tone={st.reviews.conflicts ? "warn" : undefined} />
        <Stat label="İşleme hataları" icon="alert" value={d.failed + d.dead} hint={`${d.unsupported} desteklenmeyen biçim`} tone={d.failed + d.dead ? "bad" : undefined} />
        <Stat label="İşleyici kuyruğu" icon="clock" value={st.queue.due + st.queue.processing} hint={`${st.queue.waiting} geri çekilmede${st.queue.next_retry ? ` · sonraki deneme ${dt(st.queue.next_retry)}` : ""}${st.paused ? " · DURAKLATILDI" : ""}`} />
        <Stat label="Kaynak erişim başarısı (30 gün)" icon="pulse" value={st.retrieval.successRate === null ? "ölçülmedi" : `%${st.retrieval.successRate}`}
          hint={`${st.retrieval.withHits}/${st.retrieval.last30d} uzman görevi kaynak buldu${st.retrieval.avgLatencyMs !== null ? ` · ort. ${st.retrieval.avgLatencyMs} ms` : ""}`} />
      </div>

      <section className="card mt-4 space-y-3" aria-labelledby="search-h">
        <h2 id="search-h" className="h2">Arşivde ara · uzman bilgisini test et</h2>
        <form className="flex flex-wrap items-end gap-2" method="get">
          <label className="flex-1 text-xs">Sorgu<input name="q" defaultValue={query} className="input mt-1 w-full" placeholder="ör. Space Alien hikâyesi, mandala, kampanya bütçesi" maxLength={200} /></label>
          <label className="text-xs">Rol
            <select name="role" defaultValue={role} className="input mt-1">{KNOWLEDGE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
          </label>
          <label className="text-xs">Kip
            <select name="mode" defaultValue={mode} className="input mt-1"><option value="search">Arşiv araması (işaretliler dahil)</option><option value="test">Uzman testi (ajanın göreceği)</option></select>
          </label>
          <button className="btn-primary" type="submit">Ara</button>
        </form>
        {search && (
          <div className="space-y-2">
            <p className="text-xs text-muted">
              Kip: <strong>{search.mode === "hybrid" ? "karma (tam metin + anlamsal)" : "tam metin"}</strong>{search.semantic_note ? ` — ${search.semantic_note}` : ""} · {search.hits.length} sonuç · {search.latency_ms} ms
              {search.withheld ? ` · ${search.withheld} eşleşme "${ROLE_LABELS[role]}" rolüne verilmedi (içerik gösterilmez)` : ""}
            </p>
            {search.hits.length ? (
              <ol className="space-y-2">
                {search.hits.map((h) => (
                  <li key={h.chunk_id} className="rounded-lg border border-line p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="font-mono">[{h.label}]</span>
                      <a className="link" href={h.url} target="_blank" rel="noopener noreferrer">{h.path ?? h.name}</a>
                      {h.section && <span className="text-muted">· {h.section}</span>}
                      <Badge tone={h.verification.startsWith("doğrulanmış") ? "ok" : "neutral"}>{h.verification}</Badge>
                      {h.flags.includes("possible_prompt_injection") && <Badge tone="bad">komut enjeksiyonu şüphesi — ajanlara verilmez</Badge>}
                      {h.collections.map((c) => <Badge key={c} tone="info">{c}</Badge>)}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-muted">{h.text.slice(0, 700)}{h.text.length > 700 ? "…" : ""}</p>
                    {h.duplicates.length > 0 && <p className="text-muted">Aynı içerik: {h.duplicates.join(", ")}</p>}
                  </li>
                ))}
              </ol>
            ) : <Empty icon="search">Eşleşme yok. Uzman bu sorgu için arşiv içeriği alamaz ve kaynak kullandığını iddia edemez.</Empty>}
          </div>
        )}
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card space-y-2" aria-labelledby="claims-h">
          <h2 id="claims-h" className="h2">Kaynak iddiaları (inceleme)</h2>
          <p className="text-xs text-muted">Belgelerden otomatik çıkarılan, <strong>doğrulanmamış</strong> iddialar. Onaylanan iddia kanonik marka bilgisi olur; AI yorumları kendiliğinden onaylanmaz.</p>
          {brainClaims.length ? (
            <form action={brainFactDecisionAction} className="space-y-2">
              <ul className="max-h-96 space-y-1 overflow-auto text-xs">
                {brainClaims.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    <input type="checkbox" name="id" value={c.id} aria-label={`${c.entity_name} ${c.attribute} seç`} />
                    <span><strong>{c.entity_name}</strong> · {c.attribute}: {c.value.slice(0, 220)} <span className="block text-muted">{c.source_note}</span></span>
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <button className="btn" name="decision" value="confirm" type="submit">Seçilenleri onayla</button>
                <button className="btn" name="decision" value="reject" type="submit">Seçilenleri reddet</button>
              </div>
            </form>
          ) : <Empty icon="check">İncelenecek çıkarılmış iddia yok.</Empty>}
        </section>

        <section className="card space-y-2" aria-labelledby="conflicts-h">
          <h2 id="conflicts-h" className="h2">Çakışan bilgiler</h2>
          {st.conflicts.length ? (
            <ul className="space-y-2 text-xs">
              {st.conflicts.map((c) => (
                <li key={`${c.entity_key}-${c.attribute}`} className="rounded-lg border border-line p-2">
                  <strong>{c.entity_name}</strong> · {c.attribute} <span className="block text-warning">{c.reason}</span>
                  <ul>{c.values.map((v) => <li key={v.fact_id}>{v.value} <Badge tone={v.status === "confirmed" ? "ok" : "neutral"}>{v.status === "confirmed" ? "onaylı" : v.status === "extracted" ? "kaynak iddiası" : v.status}</Badge> <span className="text-muted">{v.source}</span></li>)}</ul>
                </li>
              ))}
            </ul>
          ) : <Empty icon="shield">Çakışma bulunmadı.</Empty>}
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card space-y-2" aria-labelledby="errors-h">
          <div className="flex items-center justify-between">
            <h2 id="errors-h" className="h2">İşleme hataları</h2>
            <div className="flex gap-2">
              <form action={brainRetryAction}><SubmitButton className="btn">Tümünü tekrar dene</SubmitButton></form>
              <form action={brainReindexAction}><input type="hidden" name="scope" value="changed" /><SubmitButton className="btn">Değişenleri yeniden işle</SubmitButton></form>
            </div>
          </div>
          {st.errors.length ? (
            <ul className="space-y-1 text-xs">
              {st.errors.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-2">
                  <span><strong>{e.path ?? e.name}</strong> · {STATUS_LABEL[e.status] ?? e.status} · {e.attempts} deneme<span className="block text-muted">{e.error}</span></span>
                  <form action={brainRetryAction}><input type="hidden" name="id" value={e.id} /><SubmitButton className="btn">Tekrar dene</SubmitButton></form>
                </li>
              ))}
            </ul>
          ) : <Empty icon="check">Başarısız dosya yok.</Empty>}
        </section>

        <section className="card space-y-2" aria-labelledby="unsup-h">
          <h2 id="unsup-h" className="h2">Desteklenmeyen / yalnızca üst veri</h2>
          {st.unsupported.length ? (
            <table className="w-full text-left text-xs">
              <thead><tr className="text-muted"><th className="py-1">Tür</th><th>Durum</th><th>Adet</th><th>Neden</th></tr></thead>
              <tbody>{st.unsupported.map((u) => <tr key={`${u.mime_type}-${u.status}`}><td className="py-1">{u.mime_type}</td><td>{STATUS_LABEL[u.status]}</td><td>{u.n}</td><td className="text-muted">{u.limitation}</td></tr>)}</tbody>
            </table>
          ) : <Empty icon="layers">Kayıt yok.</Empty>}
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card space-y-2" aria-labelledby="coverage-h">
          <h2 id="coverage-h" className="h2">Arşiv kapsamı</h2>
          <table className="w-full text-left text-xs">
            <thead><tr className="text-muted"><th className="py-1">Tür</th><th>Dosya</th><th>Boyut</th></tr></thead>
            <tbody>{st.archive.families.map((f) => <tr key={f.family}><td className="py-1">{f.family}</td><td>{f.files}</td><td>{gb(Number(f.bytes ?? 0))}</td></tr>)}</tbody>
          </table>
          <p className="text-xs text-muted">Belge durumları: {Object.entries(d.byStatus).map(([k, n]) => `${STATUS_LABEL[k] ?? k} ${n}`).join(" · ") || "henüz işlenmedi"}. Drive'da {st.archive.pendingChecksum} dosya yükleme/işleme bekliyor, {st.archive.malformed} bozuk üst veri.</p>
        </section>

        <section className="card space-y-2" aria-labelledby="semantic-h">
          <h2 id="semantic-h" className="h2">Anlamsal arama ve maliyet</h2>
          <ul className="space-y-1 text-xs">
            <li>Gömme: {st.semantic.enabled ? <Badge tone="ok">açık</Badge> : <Badge tone="neutral">kapalı</Badge>} · sağlayıcı: {st.semantic.provider ?? <span className="text-muted">{st.semantic.providerReason}</span>}{st.semantic.pricePerMTok !== null ? ` · $${st.semantic.pricePerMTok}/1M belirteç (yayımlanmış fiyat)` : ""}</li>
            <li>pgvector: {st.semantic.pgvector.installed ? <Badge tone="ok">kurulu (vektör operatörü kullanılır)</Badge> : st.semantic.pgvector.available ? <Badge tone="warn">kurulabilir, kurulu değil (tam taramalı kosinüs kullanılır)</Badge> : <Badge tone="neutral">bu sunucuda yok (tam taramalı kosinüs kullanılır)</Badge>}</li>
            <li>Bekleyen gömme: {st.semantic.backlog.chunks} parça · ~{st.semantic.backlog.tokens.toLocaleString("tr-TR")} belirteç · tahmini {st.semantic.backlog.estimateUsd === null ? "bilinmiyor (fiyat yok → engellenir)" : usd(st.semantic.backlog.estimateUsd)}</li>
            <li>Harcama: gömme bugün {usd(st.costs.brain_embeddings?.today ?? 0)} / 30 gün {usd(st.costs.brain_embeddings?.month ?? 0)} · sorgu gömmesi 30 gün {usd(st.costs.brain_query_embedding?.month ?? 0)}</li>
            <li>Onaylı ilk toplu tutar: {usd(st.semantic.budgets.initialIngestionUsd, 2)} · OCR, transkripsiyon, AI sınıflandırma: kapalı (sağlayıcı yok, bütçe $0)</li>
          </ul>
          <form action={brainEmbeddingsAction} className="flex items-center gap-2">
            <input type="hidden" name="enabled" value={st.semantic.enabled ? "0" : "1"} />
            <SubmitButton className="btn" confirm={st.semantic.enabled ? undefined : "Gömme ücretli bir işlemdir (birim fiyatla sınırlı). Açılsın mı?"}>{st.semantic.enabled ? "Gömmeyi kapat" : "Gömmeyi aç"}</SubmitButton>
          </form>
          <form action={brainApproveBatchAction} className="flex flex-wrap items-end gap-2">
            <label className="text-xs">Büyük toplu gömme onayı ($)<input name="usd" inputMode="decimal" className="input mt-1 w-28" placeholder={st.semantic.backlog.estimateUsd ? st.semantic.backlog.estimateUsd.toFixed(2) : "0.50"} /></label>
            <SubmitButton className="btn" confirm="Bu tutara kadar ücretli gömme yapılmasını onaylıyor musunuz?">Tutarı onayla</SubmitButton>
          </form>
          <form action={brainBudgetsAction} className="grid grid-cols-3 gap-2 text-xs">
            <label>Günlük artımlı ($)<input name="dailyIncrementalUsd" defaultValue={st.semantic.budgets.dailyIncrementalUsd} className="input mt-1 w-full" /></label>
            <label>Günlük gömme üst sınırı ($)<input name="embeddingsDailyUsd" defaultValue={st.semantic.budgets.embeddingsDailyUsd} className="input mt-1 w-full" /></label>
            <label>Günlük sorgu ($)<input name="retrievalDailyUsd" defaultValue={st.semantic.budgets.retrievalDailyUsd} className="input mt-1 w-full" /></label>
            <div className="col-span-3"><SubmitButton className="btn">Bütçeleri kaydet</SubmitButton></div>
          </form>
        </section>
      </div>
    </div>
  );
}
