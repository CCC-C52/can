import Link from "next/link";
import { flash, requireBrand, type SP } from "@/lib/current";
import { config } from "@/lib/config";
import { envConfigured, getConnection } from "@/lib/services/connections";
import { MEMORY_KINDS } from "@/lib/services/brand-memory";
import { findArchiveFolders, safeError, type FolderCandidate } from "@/lib/drive/source";
import { DOC_MIME, driveDashboard, searchDriveItems, verifiedReferences } from "@/lib/drive/references";
import { FRIBEE_THEMES, REFERENCE_VIEWS, THEME_INFO, VIEW_LABEL } from "@/lib/drive/themes";
import { REFERENCE_MIN_SHORT_SIDE, referenceTooSmall } from "@/lib/video/reference";
import {
  driveDisconnectAction, driveImportAction, drivePauseAction, driveProposeMemoryAction, driveReviewAction, driveScanNowAction, driveSelectFolderAction, driveSuggestAction,
} from "@/app/actions";
import { AutoRefresh, SubmitButton } from "@/components/client";
import { Badge, Empty, Flash, PageHeader, Stat, dt } from "@/components/ui";

export const dynamic = "force-dynamic";

const TABS = [
  { id: "overview", label: "Bağlantı ve tarama" },
  { id: "files", label: "Dosyalar" },
  { id: "review", label: "İnceleme kuyruğu" },
  { id: "hub", label: "Doğrulanmış referanslar" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const FILTERS = { images: "Görseller", all: "Tümü", pending: "Yükleme sürüyor", duplicates: "Kopyalar", malformed: "Bozuk", removed: "Kaldırılanlar" } as const;
type Filter = keyof typeof FILTERS;

const SOURCE_STATUS: Record<string, { label: string; tone: "ok" | "bad" | "warn" | "neutral" }> = {
  awaiting_folder: { label: "Klasör seçimi bekliyor", tone: "warn" },
  active: { label: "Etkin", tone: "ok" },
  paused: { label: "Duraklatıldı", tone: "warn" },
  reauth_required: { label: "Yeniden bağlanın", tone: "bad" },
  disconnected: { label: "Bağlantı kaldırıldı", tone: "neutral" },
};

const MEMORY_KIND_LABEL: Record<string, string> = {
  guideline: "Marka kuralı / hikâye", lesson: "Ders", preference: "Tercih", agent_instruction: "Ajan talimatı", strategy: "Strateji", campaign_note: "Kampanya notu",
};

const driveLink = (fileId: string) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function DriveArchivePage({ searchParams }: { searchParams: SP }) {
  const brand = await requireBrand();
  const sp = await searchParams;
  const { ok, err } = await flash(searchParams);
  const tab: Tab = (TABS.some((t) => t.id === one(sp.tab)) ? one(sp.tab) : "overview") as Tab;
  const env = envConfigured("google_drive");
  const [conn, dash] = await Promise.all([getConnection("google_drive", brand.id), driveDashboard(brand.id)]);
  const connected = !!conn && conn.status === "connected";
  const src = dash?.source ?? null;
  const scanning = !!src && src.status === "active" && dash!.phase !== "incremental";

  return (
    <div>
      <PageHeader
        title="Drive Arşivi"
        subtitle={`Google Drive'daki '${config.googleDrive.folderName}' klasörü salt okunur dizinlenir. Görseller siz doğrulamadan hiçbir ajana veya AI üretimine girmez; doğruladığınız görsel orijinal dosya olarak (tam çözünürlük, bayt bayt) medya arşivine alınır. Drive'da hiçbir şey değiştirilmez.`}
      />
      <Flash ok={ok} err={err} />
      <AutoRefresh active={scanning} intervalMs={10_000} />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Drive Arşivi bölümleri">
        {TABS.map((t) => (
          <Link key={t.id} href={`/drive-arsivi?tab=${t.id}`} className={t.id === tab ? "btn-primary" : "btn"} aria-current={t.id === tab ? "page" : undefined}>
            {t.label}
            {t.id === "review" && dash ? ` (${dash.references.uncertain})` : ""}
            {t.id === "hub" && dash ? ` (${dash.references.verified})` : ""}
          </Link>
        ))}
      </nav>
      {tab === "overview" && <Overview env={env} connected={connected} connStatus={conn?.status ?? "not_connected"} connError={conn?.last_error ?? null} dash={dash} brandId={brand.id} />}
      {tab === "files" && (src?.folder_id ? <Files brandId={brand.id} search={one(sp.q)} filter={(one(sp.filter) in FILTERS ? one(sp.filter) : "images") as Filter} page={Math.max(0, Number(one(sp.page)) || 0)} /> : <Empty>Önce Google Drive'ı bağlayıp arşiv klasörünü seçin.</Empty>)}
      {tab === "review" && <Review brandId={brand.id} />}
      {tab === "hub" && <Hub brandId={brand.id} />}
    </div>
  );
}

type Dash = NonNullable<Awaited<ReturnType<typeof driveDashboard>>>;

async function Overview({ env, connected, connStatus, connError, dash, brandId }: { env: boolean; connected: boolean; connStatus: string; connError: string | null; dash: Dash | null; brandId: string }) {
  const src = dash?.source ?? null;
  let candidates: FolderCandidate[] = [];
  let candidateError: string | null = null;
  if (connected && src && !src.folder_id && src.status === "awaiting_folder") {
    try {
      candidates = await findArchiveFolders(brandId);
    } catch (e) {
      candidateError = safeError(e);
    }
  }
  const st = src ? SOURCE_STATUS[src.status] : null;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <section className="card h-fit space-y-3">
        <h2 className="h2">Bağlantı</h2>
        {!env && (
          <p className="text-sm text-red-700">
            Google OAuth istemcisi tanımlı değil. Render ortamına GOOGLE_DRIVE_CLIENT_ID ve GOOGLE_DRIVE_CLIENT_SECRET ekleyin (adımlar: docs/GOOGLE_DRIVE.md).
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={connected ? "ok" : connStatus === "reauth_required" || connStatus === "error" ? "bad" : "neutral"}>
            {connected ? "Bağlı" : connStatus === "reauth_required" ? "Yeniden yetki gerekli" : connStatus === "error" ? "Hata" : "Bağlı değil"}
          </Badge>
          {src?.account_email && <span className="muted">{src.account_email}</span>}
        </div>
        {connError && <p className="text-xs text-red-700">{connError}</p>}
        {env ? (
          <a href="/api/integrations/google-drive/start" className={connected ? "btn" : "btn-primary"}>{connected ? "Yeniden bağlan" : "Google Drive ile bağlan"}</a>
        ) : (
          <button disabled className="btn">Google Drive ile bağlan (istemci bilgileri yok)</button>
        )}
        <p className="text-xs text-muted">İzin: Drive dosyalarını görüntüleme (salt okuma). Uygulama Drive'da dosya oluşturamaz, değiştiremez, silemez veya paylaşamaz.</p>
        {src && src.status !== "disconnected" && (
          <details className="text-sm">
            <summary className="cursor-pointer text-red-700">Bağlantıyı kaldır</summary>
            <form action={driveDisconnectAction} className="mt-2 space-y-2">
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="purge" value="1" /> Bu uygulamadaki dizini de sil (Drive'daki dosyalar silinmez)</label>
              <input name="confirm" className="input" placeholder="Dizini silmek için SIL yazın" maxLength={10} />
              <SubmitButton className="btn-danger" confirm="Google Drive bağlantısı kaldırılsın ve izin Google'da iptal edilsin mi?">Bağlantıyı kaldır</SubmitButton>
            </form>
          </details>
        )}
      </section>

      <div className="space-y-4 lg:col-span-2">
        {connected && src && !src.folder_id && (
          <section className="card space-y-2">
            <h2 className="h2">Arşiv klasörünü seçin</h2>
            <p className="text-sm muted">Hesapta adı tam olarak “{config.googleDrive.folderName}” olan klasörler. Doğru klasörü siz seçersiniz; sistem tahmin etmez.</p>
            {candidateError && <p className="text-sm text-red-700">{candidateError}</p>}
            {!candidateError && candidates.length === 0 && <Empty>Bu adla klasör bulunamadı. Klasörün adını kontrol edin veya bu hesapla paylaşıldığından emin olun.</Empty>}
            <ul className="space-y-2">
              {candidates.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-muted">{c.owner ?? "—"} · {c.driveId ? "Ortak Drive" : "Drive'ım"} · son değişiklik {dt(c.modifiedTime)}</div>
                  </div>
                  <form action={driveSelectFolderAction}><input type="hidden" name="folderId" value={c.id} /><SubmitButton className="btn-primary">Bu klasörü kullan</SubmitButton></form>
                </li>
              ))}
            </ul>
          </section>
        )}
        {src?.folder_id && dash && (
          <section className="card space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="h2">{src.folder_name}</h2>
              {st && <Badge tone={st.tone}>{st.label}</Badge>}
              <Badge tone={dash.phase === "incremental" ? "ok" : "warn"}>{dash.phase === "incremental" ? "Güncel (yalnız değişiklikler izleniyor)" : dash.phase === "initial_scan" ? `İlk tarama sürüyor (${dash.queueLength} klasör sırada)` : `Alt klasörler taranıyor (${dash.queueLength})`}</Badge>
              {dash.freshness.stale && src.status === "active" && <Badge tone="warn">Son başarılı tarama eski</Badge>}
            </div>
            {src.last_error && <p className="text-sm text-red-700">{src.last_error}</p>}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Klasör" value={dash.counts.folders} />
              <Stat label="Dosya" value={dash.counts.files} />
              <Stat label="Görsel" value={dash.counts.images} />
              <Stat label="Toplam boyut" value={dash.counts.bytes ? `${(Number(dash.counts.bytes) / 1e9).toFixed(2)} GB` : "—"} />
              <Stat label="Yükleme sürüyor" value={dash.counts.pending} tone={dash.counts.pending ? "warn" : undefined} />
              <Stat label="Kopya grubu" value={dash.duplicates.groups} hint={dash.duplicates.extra ? `${dash.duplicates.extra} fazla kopya` : undefined} />
              <Stat label="İnceleme bekleyen" value={dash.references.uncertain} href="/drive-arsivi?tab=review" />
              <Stat label="Doğrulanmış" value={dash.references.verified} hint={`${dash.references.imported} tanesi medya arşivinde`} href="/drive-arsivi?tab=hub" />
            </div>
            <p className="text-xs text-muted">
              Son başarılı tarama: {dt(src.last_success_at)} · Sonraki: {dt(src.next_scan_at)} · Artımlı tarama aralığı {config.googleDrive.scanIntervalMinutes} dk.
            </p>
            <div className="flex flex-wrap gap-2">
              {src.status === "active" && <form action={driveScanNowAction}><SubmitButton className="btn">Şimdi tara</SubmitButton></form>}
              {src.status === "active" && <form action={drivePauseAction}><input type="hidden" name="pause" value="1" /><SubmitButton className="btn">Duraklat</SubmitButton></form>}
              {src.status === "paused" && <form action={drivePauseAction}><input type="hidden" name="pause" value="0" /><SubmitButton className="btn-primary">Sürdür</SubmitButton></form>}
            </div>
          </section>
        )}
        {dash && dash.runs.length > 0 && (
          <section className="card">
            <h2 className="h2 mb-2">Son taramalar</h2>
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Tarama geçmişi">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1">Başlangıç</th><th>Tür</th><th>Durum</th><th>Sayfa</th><th>Görülen</th><th>Güncellenen</th><th>Kaldırılan</th></tr></thead>
                <tbody>
                  {dash.runs.map((r) => (
                    <tr key={r.id} className="border-t border-line align-top">
                      <td className="py-1 pr-2 whitespace-nowrap">{dt(r.started_at)}</td>
                      <td className="pr-2">{r.kind === "full" ? "Tam" : "Artımlı"}</td>
                      <td className="pr-2"><Badge tone={r.status === "completed" ? "ok" : r.status === "failed" ? "bad" : "neutral"}>{r.status === "completed" ? "Tamam" : r.status === "failed" ? "Hata" : r.status === "partial" ? "Sürüyor" : "Çalışıyor"}</Badge>{r.error && <div className="text-xs text-red-700">{r.error}</div>}</td>
                      <td className="pr-2">{r.pages}</td><td className="pr-2">{r.items_seen}</td><td className="pr-2">{r.items_upserted}</td><td>{r.items_removed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

async function Files({ brandId, search, filter, page }: { brandId: string; search: string; filter: Filter; page: number }) {
  const PAGE = 50;
  const items = await searchDriveItems(brandId, { search, filter, limit: PAGE + 1, offset: page * PAGE });
  const more = items.length > PAGE;
  const rows = items.slice(0, PAGE);
  const qs = (p: number) => `/drive-arsivi?tab=files&filter=${filter}&q=${encodeURIComponent(search)}&page=${p}`;
  return (
    <section className="card space-y-3">
      <form className="flex flex-wrap gap-2" action="/drive-arsivi">
        <input type="hidden" name="tab" value="files" />
        <input name="q" defaultValue={search} placeholder="Ad veya klasör yolu ara (ör. anime, back, karakter)" className="input max-w-sm" maxLength={100} />
        <select name="filter" defaultValue={filter} className="input max-w-[12rem]" aria-label="Filtre">
          {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn">Ara</button>
      </form>
      <form id="suggest-form" action={driveSuggestAction} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-2 text-sm">
        <span>Seçili görselleri inceleme kuyruğuna ekle (en çok 50):</span>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="useThumbnails" value="1" defaultChecked /> Ürün rengini önizlemeden tahmin et (ücretsiz)</label>
        <SubmitButton className="btn-primary">Kuyruğa ekle</SubmitButton>
      </form>
      {rows.length === 0 ? <Empty>Bu filtrede dosya yok.</Empty> : (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Drive dosyaları">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-muted"><th className="py-1 w-6"><span className="sr-only">Seç</span></th><th>Dosya</th><th>Tür / çözünürlük</th><th>Durum</th><th>İşlem</th></tr></thead>
            <tbody>
              {rows.map((i) => {
                const image = !i.is_folder && i.mime_type.startsWith("image/");
                const lowRes = image && i.image_width && i.image_height ? referenceTooSmall(i.image_width, i.image_height) : false;
                return (
                  <tr key={i.id} className="border-t border-line align-top">
                    <td className="py-1">{image && i.state !== "removed" && i.ref_status !== "verified" && <input type="checkbox" name="itemIds" value={i.id} form="suggest-form" aria-label={`${i.name} seç`} />}</td>
                    <td className="pr-2">
                      <a href={driveLink(i.file_id)} target="_blank" rel="noopener noreferrer" className="font-medium text-brand break-all">{i.is_folder ? "📁 " : ""}{i.name}</a>
                      <div className="text-xs text-muted break-all">{i.path}</div>
                    </td>
                    <td className="pr-2 text-xs">
                      {i.mime_type}
                      {i.image_width && i.image_height ? <div className={lowRes ? "text-red-700" : ""}>{i.image_width}x{i.image_height}{lowRes ? ` — düşük (< ${REFERENCE_MIN_SHORT_SIDE})` : ""}</div> : null}
                    </td>
                    <td className="pr-2 text-xs">
                      {i.state === "removed" ? <Badge tone="neutral">Kaldırıldı</Badge> : i.state === "malformed" ? <Badge tone="bad">Bozuk</Badge> : i.state === "pending_checksum" ? <Badge tone="warn">Yükleme sürüyor</Badge> : null}
                      {i.ref_status && <Badge tone={i.ref_status === "verified" ? "ok" : i.ref_status === "rejected" ? "bad" : "warn"}>{i.ref_status === "verified" ? "Doğrulandı" : i.ref_status === "rejected" ? "Reddedildi" : "İncelemede"}</Badge>}
                      {i.state_detail && <div className="text-muted">{i.state_detail}</div>}
                    </td>
                    <td className="text-xs">
                      {DOC_MIME.has(i.mime_type) && i.state !== "removed" && (
                        <form action={driveProposeMemoryAction} className="flex flex-wrap gap-1">
                          <input type="hidden" name="itemId" value={i.id} />
                          <select name="kind" className="input py-1 text-xs" defaultValue="guideline" aria-label="Hafıza türü">
                            {MEMORY_KINDS.map((k) => <option key={k} value={k}>{MEMORY_KIND_LABEL[k] ?? k}</option>)}
                          </select>
                          <SubmitButton className="btn py-1">Marka hafızasına öner</SubmitButton>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2">
        {page > 0 && <Link href={qs(page - 1)} className="btn">← Önceki</Link>}
        {more && <Link href={qs(page + 1)} className="btn">Sonraki →</Link>}
      </div>
      <p className="text-xs text-muted">Metin belgeleri (Google Dokümanı, .txt, .md: hikâye, karakterler, marka kuralları) Marka Hafızası'na öneri olarak eklenir; siz etkinleştirmeden hiçbir ajan görmez.</p>
    </section>
  );
}

async function Review({ brandId }: { brandId: string }) {
  const items = await searchDriveItems(brandId, { filter: "uncertain", limit: 100 });
  if (!items.length) return <Empty>İnceleme bekleyen görsel yok. Dosyalar sekmesinden görsel seçip kuyruğa ekleyin.</Empty>;
  return (
    <ul className="space-y-3">
      {items.map((i) => {
        const lowRes = i.image_width && i.image_height ? referenceTooSmall(i.image_width, i.image_height) : false;
        return (
          <li key={i.id} className="card space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <a href={driveLink(i.file_id)} target="_blank" rel="noopener noreferrer" className="font-medium text-brand break-all">{i.name}</a>
              <span className="text-xs text-muted break-all">{i.path}</span>
              {i.image_width && i.image_height && <Badge tone={lowRes ? "bad" : "neutral"}>{i.image_width}x{i.image_height}{lowRes ? " — düşük çözünürlük" : ""}</Badge>}
              {i.ref_confidence !== null && <Badge tone="warn">Öneri güveni %{Math.round((i.ref_confidence ?? 0) * 100)}</Badge>}
            </div>
            {i.ref_reasons && i.ref_reasons.length > 0 && <ul className="list-disc pl-5 text-xs text-muted">{i.ref_reasons.map((r, k) => <li key={k}>{r}</li>)}</ul>}
            <form action={driveReviewAction} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <input type="hidden" name="referenceId" value={i.ref_id!} />
              <label className="text-xs">Tema
                <select name="theme" className="input" defaultValue={i.ref_theme ?? ""}>
                  <option value="">Seçin…</option>
                  {FRIBEE_THEMES.map((t) => <option key={t} value={t}>{THEME_INFO[t].label} ({THEME_INFO[t].garmentLabel})</option>)}
                </select>
              </label>
              <label className="text-xs">Görünüm
                <select name="view" className="input" defaultValue={i.ref_view && i.ref_view !== "unknown" ? i.ref_view : ""}>
                  <option value="">Seçin…</option>
                  {REFERENCE_VIEWS.map((v) => <option key={v} value={v}>{VIEW_LABEL[v]}</option>)}
                </select>
              </label>
              <label className="text-xs sm:col-span-2">Not (isteğe bağlı)
                <input name="notes" className="input" maxLength={1000} placeholder="ör. arka baskı, 2025 koleksiyonu" />
              </label>
              <label className="flex items-center gap-2 text-xs sm:col-span-2 lg:col-span-4">
                <input type="checkbox" name="artworkConfirmed" value="1" /> Görseli Drive'da açtım; basılı tasarım, kalıp ve renk birebir doğru.
              </label>
              <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-4">
                <button name="action" value="verify" className="btn-primary">Doğrula</button>
                <button name="action" value="reject" className="btn-danger">Reddet</button>
              </div>
            </form>
          </li>
        );
      })}
    </ul>
  );
}

async function Hub({ brandId }: { brandId: string }) {
  const refs = await verifiedReferences(brandId, { limit: 200 });
  if (!refs.length) return <Empty>Henüz doğrulanmış referans yok.</Empty>;
  return (
    <section className="card">
      <p className="mb-3 text-sm muted">
        Doğrulanmış referanslar tüm ajanların bağlamına (yalnızca etiket olarak) girer. Video/Görsel Stüdyosu'nda ürün referansı olarak kullanmak için orijinal dosyayı medya arşivine alın: dosya
        Drive'daki MD5 özetiyle doğrulanır ve hiçbir şekilde küçültülmez, sıkıştırılmaz veya renk dönüşümüne uğramaz.
      </p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Doğrulanmış referanslar">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="py-1">Tema</th><th>Görünüm</th><th>Dosya</th><th>Medya arşivi</th><th></th></tr></thead>
          <tbody>
            {refs.map((r) => (
              <tr key={r.reference_id} className="border-t border-line align-top">
                <td className="py-1 pr-2">{r.theme_label}</td>
                <td className="pr-2">{VIEW_LABEL[r.view]}</td>
                <td className="pr-2 break-all">{r.name}<div className="text-xs text-muted">{r.path}</div>{r.notes && <div className="text-xs">{r.notes}</div>}</td>
                <td className="pr-2">{r.media_asset_id ? <Link href={`/medya/${r.media_asset_id}`} className="text-brand">Arşivde (orijinal)</Link> : <span className="text-xs text-muted">Alınmadı</span>}</td>
                <td className="whitespace-nowrap">
                  {!r.media_asset_id && <form action={driveImportAction}><input type="hidden" name="referenceId" value={r.reference_id} /><SubmitButton className="btn py-1" pendingText="İndiriliyor…">Orijinali arşive al</SubmitButton></form>}
                  <form action={driveReviewAction} className="mt-1"><input type="hidden" name="referenceId" value={r.reference_id} /><input type="hidden" name="action" value="reset" /><SubmitButton className="btn py-1" confirm="Referans incelemeye geri alınsın mı? Geri alınınca hiçbir AI isteğinde kullanılmaz.">İncelemeye geri al</SubmitButton></form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
