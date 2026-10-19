"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function Uploader({ products }: { products: { id: string; title: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ filename: string; ok: boolean; duplicate?: boolean; error?: string }[]>([]);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setResults([]);
    try {
      const res = await fetch("/api/media/upload", { method: "POST", body: new FormData(e.currentTarget) });
      const body = await res.json();
      setResults(body.results ?? [{ filename: "—", ok: false, error: body.error ?? `Hata ${res.status}` }]);
      router.refresh();
    } catch {
      setResults([{ filename: "—", ok: false, error: "Ağ hatası" }]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <input type="file" name="files" multiple required accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/pdf,image/svg+xml,.psd" className="block w-full text-sm" />
      <div className="grid grid-cols-2 gap-2">
        <select name="kind" className="input"><option value="">Tür: otomatik</option><option value="logo">Logo</option><option value="design">Tasarım dosyası</option></select>
        <select name="origin" className="input"><option value="">Köken: otomatik (gerçek çekim)</option><option value="real_photo">Gerçek ürün fotoğrafı</option><option value="real_video">Gerçek çekim (video)</option><option value="ai_generated">AI ile üretilmiş</option><option value="design_file">Tasarım dosyası</option></select>
        <select name="productId" className="input"><option value="">Ürün: yok</option>{products.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
        <select name="rightsStatus" className="input"><option value="unknown">Kullanım hakkı: bilinmiyor</option><option value="owned">Marka sahibi</option><option value="licensed">Lisanslı</option><option value="restricted">Kısıtlı</option></select>
        <input name="themes" className="input" placeholder="Temalar (virgülle)" />
        <input name="shotType" className="input" placeholder="Çekim tipi" />
        <input name="tags" className="input col-span-2" placeholder="Etiketler (virgülle)" />
      </div>
      <button className="btn-primary" disabled={busy}>{busy ? "Yükleniyor…" : "Yükle"}</button>
      {results.length > 0 && (
        <ul className="space-y-1 text-xs">
          {results.map((r, i) => <li key={i} className={r.ok ? (r.duplicate ? "text-amber-700" : "text-emerald-700") : "text-red-700"}>{r.filename}: {r.ok ? (r.duplicate ? "zaten arşivde (tekrar yüklenmedi)" : "yüklendi") : r.error}</li>)}
        </ul>
      )}
      <p className="text-xs text-muted">Türler içerik baytlarından doğrulanır. Aynı dosya ikinci kez kaydedilmez. Orijinal dosyalar değiştirilmez; düzenlemeler yeni sürüm olarak kaydedilir.</p>
    </form>
  );
}
