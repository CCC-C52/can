import type { Brand } from "@/lib/services/brands";
import { LANGUAGES } from "@/lib/labels";

export function BrandFields({ b }: { b?: Brand | null }) {
  const colors = (b?.colors ?? []).map((c) => `${c.name}, ${c.hex}${c.pantone ? `, ${c.pantone}` : ""}`).join("\n");
  const fonts = (b?.fonts ?? []).map((f) => `${f.role}: ${f.family}`).join("\n");
  const ph = "Bilinmiyor — boş bırakılırsa ajanlar bu bilgiyi uydurmaz";
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="block md:col-span-2"><span className="label">Marka adı *</span><input name="name" required defaultValue={b?.name} className="input" /></label>
      <label className="block md:col-span-2"><span className="label">Marka hikâyesi</span><textarea name="story" rows={3} defaultValue={b?.story ?? ""} placeholder={ph} className="input" /></label>
      <label className="block"><span className="label">Hedef kitle</span><textarea name="target_audience" rows={2} defaultValue={b?.target_audience ?? ""} placeholder={ph} className="input" /></label>
      <label className="block"><span className="label">İletişim tonu</span><textarea name="tone" rows={2} defaultValue={b?.tone ?? ""} placeholder={ph} className="input" /></label>
      <label className="block"><span className="label">Müşteriye yönelik içerik dili</span>
        <select name="content_language" defaultValue={b?.content_language ?? "en"} className="input">{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label} ({l.code})</option>)}</select>
        <span className="mt-1 block text-xs text-muted">Panel Türkçe kalır; açıklama, başlık ve altyazılar bu dilde üretilir. Dil kontrolü şu an en/tr için otomatik yapılır.</span>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="label">Fiyat kaynağı</span><select name="price_source" defaultValue={b?.price_source ?? "unknown"} className="input"><option value="unknown">Bilinmiyor</option><option value="manual">Manuel</option><option value="shopify">Shopify</option></select></label>
        <label className="block"><span className="label">Stok kaynağı</span><select name="inventory_source" defaultValue={b?.inventory_source ?? "unknown"} className="input"><option value="unknown">Bilinmiyor</option><option value="manual">Manuel</option><option value="shopify">Shopify</option></select></label>
      </div>
      <label className="block"><span className="label">Renkler (her satır: ad, #hex, Pantone kodu — Pantone isteğe bağlı; verilen renkler değiştirilemez)</span><textarea name="colors" rows={4} defaultValue={colors} placeholder={"Anime turuncu, #f97316, PANTONE 1585 C\nSpace Alien siyah, #111827, PANTONE Black 6 C"} className="input font-mono text-xs" /></label>
      <label className="block"><span className="label">Yazı tipleri (her satır: rol: aile)</span><textarea name="fonts" rows={3} defaultValue={fonts} placeholder={"Başlık: Inter"} className="input font-mono text-xs" /></label>
      <label className="block"><span className="label">Gönderim bilgisi</span><textarea name="shipping_info" rows={2} defaultValue={b?.shipping_info ?? ""} placeholder={ph} className="input" /></label>
      <label className="block"><span className="label">İade politikası</span><textarea name="return_policy" rows={2} defaultValue={b?.return_policy ?? ""} placeholder={ph} className="input" /></label>
      <label className="block md:col-span-2"><span className="label">Kampanya kuralları</span><textarea name="campaign_rules" rows={2} defaultValue={b?.campaign_rules ?? ""} placeholder="Örn: Onaysız indirim yok." className="input" /></label>
    </div>
  );
}
