"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Parçalı, sürdürülebilir yükleyici. Durumlar: Hazırlanıyor → Yükleniyor (gerçek bayt ilerlemesi) → Doğrulanıyor →
// İşleniyor → Tamamlandı / Başarısız. Aynı dosya yeniden seçilirse yalnızca eksik parçalar gönderilir.

type Phase = "preparing" | "uploading" | "verifying" | "processing" | "completed" | "failed" | "aborted";
const LABEL: Record<Phase, string> = {
  preparing: "Hazırlanıyor", uploading: "Yükleniyor", verifying: "Doğrulanıyor", processing: "İşleniyor",
  completed: "Tamamlandı", failed: "Başarısız", aborted: "İptal edildi",
};
type Item = { key: string; name: string; size: number; phase: Phase; sent: number; note?: string; error?: string; assetId?: string; sessionId?: string };

const CONCURRENCY = 3;

async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Hata ${res.status}`), { status: res.status });
  return body;
}

function putWithProgress(url: string, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Object.assign(new Error(parseErr(xhr.responseText) ?? `Parça hatası ${xhr.status}`), { status: xhr.status })));
    xhr.onerror = () => reject(new Error("Ağ hatası"));
    xhr.ontimeout = () => reject(new Error("Zaman aşımı"));
    xhr.timeout = 5 * 60_000;
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}
function parseErr(t: string) {
  try { return JSON.parse(t).error as string; } catch { return null; }
}

export function Uploader({ products }: { products: { id: string; title: string }[] }) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  const update = (key: string, patch: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function uploadOne(file: File, meta: Record<string, string>) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    const ctrl = new AbortController();
    controllers.current.set(key, ctrl);
    try {
      const init = await json("/api/uploads", { method: "POST", body: JSON.stringify({ filename: file.name, size: file.size, mime: file.type || undefined, clientKey: key, meta }) });
      const partSize: number = init.partSize;
      const done = new Set<number>(init.uploadedParts);
      const alreadySent = [...done].reduce((a, n) => a + Math.min(partSize, file.size - (n - 1) * partSize), 0);
      update(key, { phase: "uploading", sessionId: init.id, sent: alreadySent, note: init.resumed && done.size ? `Kaldığı yerden devam: ${done.size}/${init.partCount} parça zaten yüklü` : undefined });
      const todo = Array.from({ length: init.partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
      const inflight = new Map<number, number>();
      let confirmed = alreadySent;
      const report = () => update(key, { sent: confirmed + [...inflight.values()].reduce((a, b) => a + b, 0) });
      const queue = [...todo];
      const worker = async () => {
        while (queue.length) {
          if (ctrl.signal.aborted) throw new Error("İptal edildi");
          const n = queue.shift()!;
          const [target] = (await json(`/api/uploads/${init.id}/targets`, { method: "POST", body: JSON.stringify({ parts: [n] }), signal: ctrl.signal })).targets;
          const blob = file.slice((n - 1) * partSize, n * partSize);
          for (let attempt = 1; ; attempt++) {
            try {
              await putWithProgress(target.url, blob, (l) => { inflight.set(n, l); report(); }, ctrl.signal);
              break;
            } catch (err) {
              inflight.delete(n);
              const status = (err as { status?: number }).status ?? 0;
              if (ctrl.signal.aborted || attempt >= 4 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) throw err;
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            }
          }
          inflight.delete(n);
          confirmed += blob.size;
          report();
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker));
      update(key, { phase: "verifying", sent: file.size, note: undefined });
      await json(`/api/uploads/${init.id}/complete`, { method: "POST" });
      // Doğrulama ve kayıt işleyicide yapılır; durumu izle
      for (let i = 0; i < 600; i++) {
        const st = await json(`/api/uploads/${init.id}`);
        if (st.status === "completed") {
          update(key, { phase: "completed", assetId: st.assetId, note: st.duplicate ? "Bu dosya arşivde zaten vardı; mevcut kayıt kullanıldı." : "İçerik analizi arka planda sürüyor." });
          return;
        }
        if (st.status === "failed" || st.status === "aborted") throw new Error(st.error ?? "Doğrulama başarısız");
        update(key, { phase: st.status === "processing" ? "processing" : "verifying" });
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error("Doğrulama uzun sürdü; görev işleyicisi çalışıyor mu? Sayfayı yenileyip aynı dosyayı tekrar seçebilirsiniz.");
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      update(key, { phase: aborted ? "aborted" : "failed", error: aborted ? undefined : (err as Error).message, note: aborted ? undefined : "Aynı dosyayı tekrar seçerseniz yüklenen parçalar korunur." });
    } finally {
      controllers.current.delete(key);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) return;
    const meta: Record<string, string> = {};
    for (const k of ["kind", "origin", "productId", "rightsStatus", "themes", "shotType", "tags"]) meta[k] = String(fd.get(k) ?? "");
    setItems((xs) => [...files.map((f) => ({ key: `${f.name}|${f.size}|${f.lastModified}`, name: f.name, size: f.size, phase: "preparing" as Phase, sent: 0 })), ...xs.filter((x) => !files.some((f) => x.key === `${f.name}|${f.size}|${f.lastModified}`))]);
    setBusy(true);
    // Dosyalar sırayla, her dosyanın parçaları paralel
    for (const f of files) await uploadOne(f, meta);
    setBusy(false);
    router.refresh();
  }

  async function cancel(item: Item) {
    controllers.current.get(item.key)?.abort();
    if (item.sessionId) await fetch(`/api/uploads/${item.sessionId}/abort`, { method: "POST" }).catch(() => {});
    update(item.key, { phase: "aborted" });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label className="label" htmlFor="up-files">Dosyalar</label>
      <input id="up-files" type="file" name="files" multiple required accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/pdf,image/svg+xml,.psd" className="block w-full text-sm" />
      <div className="grid grid-cols-2 gap-2">
        <select name="kind" className="input" aria-label="Tür"><option value="">Tür: otomatik</option><option value="logo">Logo</option><option value="design">Tasarım dosyası</option></select>
        <select name="origin" className="input" aria-label="Köken"><option value="">Köken: otomatik (gerçek çekim)</option><option value="real_photo">Gerçek ürün fotoğrafı</option><option value="real_video">Gerçek çekim (video)</option><option value="ai_generated">AI ile üretilmiş</option><option value="design_file">Tasarım dosyası</option></select>
        <select name="productId" className="input" aria-label="Ürün"><option value="">Ürün: yok</option>{products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <select name="rightsStatus" className="input" aria-label="Kullanım hakkı"><option value="unknown">Kullanım hakkı: bilinmiyor</option><option value="owned">Marka sahibi</option><option value="licensed">Lisanslı</option><option value="restricted">Kısıtlı</option></select>
        <input name="themes" className="input" placeholder="Temalar (virgülle)" aria-label="Temalar" />
        <input name="shotType" className="input" placeholder="Çekim tipi" aria-label="Çekim tipi" />
        <input name="tags" className="input col-span-2" placeholder="Etiketler (virgülle)" aria-label="Etiketler" />
      </div>
      <button className="btn-primary" disabled={busy}>{busy ? "Yükleniyor…" : "Yükle"}</button>
      {items.length > 0 && (
        <ul className="space-y-2" aria-live="polite">
          {items.map((it) => {
            const pct = it.size ? Math.min(100, Math.round((it.sent / it.size) * 100)) : 0;
            const active = ["preparing", "uploading", "verifying", "processing"].includes(it.phase);
            return (
              <li key={it.key} className="rounded-lg border border-line p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{it.name}</span>
                  <span className={it.phase === "failed" ? "text-red-700" : it.phase === "completed" ? "text-emerald-700" : "text-muted"}>{LABEL[it.phase]}{it.phase === "uploading" ? ` · %${pct}` : ""}</span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-gray-100" role="progressbar" aria-label={`${it.name} yükleme ilerlemesi`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                  <div className={`h-full ${it.phase === "failed" ? "bg-red-500" : "bg-brand"}`} style={{ width: `${it.phase === "uploading" || it.phase === "preparing" ? pct : it.phase === "aborted" ? 0 : 100}%` }} />
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-muted">
                  <span>{(it.sent / 1e6).toFixed(1)} / {(it.size / 1e6).toFixed(1)} MB{it.note ? ` · ${it.note}` : ""}</span>
                  {active && it.phase !== "verifying" && it.phase !== "processing" && <button type="button" className="text-red-700 underline" onClick={() => cancel(it)}>İptal</button>}
                  {it.assetId && <a className="text-brand underline" href={`/medya/${it.assetId}`}>Dosyayı aç</a>}
                </div>
                {it.error && <p className="mt-1 text-red-700">{it.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted">Dosyalar 8 MB'lık parçalarla gönderilir; kesilirse aynı dosyayı tekrar seçin, yalnızca eksik parçalar yüklenir. Türler içerik baytlarından doğrulanır, aynı dosya ikinci kez kaydedilmez, orijinaller değiştirilmez.</p>
    </form>
  );
}
