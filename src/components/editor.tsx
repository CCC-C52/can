"use client";
import { useState } from "react";

// Yapılandırılmış çıktılar için genel düzenleyici. İçeriği JSON olarak gizli alana yazar;
// doğrulama sunucuda şema ile yapılır (geçersiz içerik yeni sürüm oluşturmaz).

type J = string | number | boolean | null | J[] | { [k: string]: J };

const LABELS: Record<string, string> = {
  summary: "Özet", caption: "Açıklama", hashtags: "Hashtag'ler", cta: "Harekete çağrı", headline: "Başlık", body_text: "Metin",
  proposed_value: "Önerilen değer", current_value: "Mevcut değer", reason: "Gerekçe", title: "Başlık", description: "Açıklama",
  key_messages: "Ana mesajlar", positioning: "Konumlandırma", content_themes: "İçerik temaları", unknowns: "Bilinmeyenler",
  subtitles: "Altyazılar", script: "Senaryo", on_screen_text: "Ekran metni", voiceover: "Seslendirme", posts: "Gönderiler",
  briefs: "Briefler", videos: "Videolar", product_changes: "Ürün değişiklikleri", collections: "Koleksiyonlar", pages: "Sayfalar", bundles: "Bundle'lar",
  suggested_datetime: "Önerilen zaman", id: "Kimlik", notes: "Notlar", format: "Format", purpose: "Amaç", product_ids: "Ürün kimlikleri",
  source_asset_ids: "Kaynak medya kimlikleri", use_real_product_photo: "Gerçek ürün fotoğrafı kullan", platform: "Platform", media_refs: "Medya referansları",
  field: "Alan", product_id: "Ürün kimliği", mode: "Mod", duration_s: "Süre (sn)", selected_asset_ids: "Seçilen çekimler", music_note: "Müzik notu",
  t_start: "Başlangıç (sn)", t_end: "Bitiş (sn)", start: "Başlangıç (sn)", end: "Bitiş (sn)", visual: "Görüntü", text: "Metin", rule_summary: "Kural",
  rationale: "Gerekçe", pricing_note: "Fiyat notu", name: "Ad", segment: "Segment", needs: "İhtiyaç", basis: "Dayanak", objective: "Amaç", phases: "Aşamalar",
  timing: "Zamanlama", actions: "Eylemler", ad_ideas: "Reklam önerileri", hook: "Kanca", audience: "Kitle", budget_note: "Bütçe notu", campaign: "Kampanya",
  audience_segments: "Hedef kitle segmentleri", body: "Metin",  cover_text: "Kapak metni", visual_direction: "Görsel yön", generation_prompt: "Üretim istemi",
};

function Field({ name, value, onChange, depth }: { name: string; value: J; onChange: (v: J) => void; depth: number }) {
  const label = LABELS[name] ?? name;
  if (typeof value === "string") {
    const long = value.length > 60 || /caption|body|description|proposed|summary|positioning|prompt|direction|text/.test(name);
    return (
      <label className="block">
        <span className="label">{label}</span>
        {long ? <textarea className="input" rows={Math.min(8, Math.max(2, Math.ceil(value.length / 70)))} value={value} onChange={(e) => onChange(e.target.value)} /> : <input className="input" value={value} onChange={(e) => onChange(e.target.value)} />}
      </label>
    );
  }
  if (typeof value === "number") return <label className="block"><span className="label">{label}</span><input type="number" step="any" className="input" value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>;
  if (typeof value === "boolean") return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
  if (value === null) return null;
  if (Array.isArray(value)) {
    const primitive = value.every((v) => typeof v === "string");
    if (primitive) {
      return (
        <label className="block">
          <span className="label">{label} (her satır bir öğe)</span>
          <textarea className="input" rows={Math.max(2, value.length + 1)} value={(value as string[]).join("\n")} onChange={(e) => onChange(e.target.value.split("\n"))} onBlur={(e) => onChange(e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} />
        </label>
      );
    }
    return (
      <fieldset className="rounded-lg border border-line p-2">
        <legend className="px-1 text-xs font-medium text-muted">{label} ({value.length})</legend>
        <div className="space-y-3">
          {value.map((item, i) => (
            <div key={i} className="rounded-lg bg-gray-50 p-2">
              <div className="mb-1 flex justify-between text-xs text-muted"><span>#{i + 1}</span>
                <button type="button" className="text-red-700" onClick={() => onChange(value.filter((_, j) => j !== i))}>Kaldır</button></div>
              <Field name={name} value={item} depth={depth + 1} onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)))} />
            </div>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <div className={depth > 0 ? "space-y-2" : "space-y-3"}>
      {Object.entries(value).map(([k, v]) => (
        <Field key={k} name={k} value={v} depth={depth + 1} onChange={(nv) => onChange({ ...(value as Record<string, J>), [k]: nv })} />
      ))}
    </div>
  );
}

export function StructuredEditor({ initial }: { initial: J }) {
  const [value, setValue] = useState<J>(initial);
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button type="button" className="text-xs text-brand" onClick={() => { if (!raw) setText(JSON.stringify(value, null, 2)); else { try { setValue(JSON.parse(text)); } catch { /* geçersiz JSON: sunucu reddeder */ } } setRaw(!raw); }}>
          {raw ? "Form görünümü" : "JSON görünümü"}
        </button>
      </div>
      {raw ? <textarea className="input font-mono text-xs" rows={20} value={text} onChange={(e) => setText(e.target.value)} /> : <Field name="" value={value} onChange={setValue} depth={0} />}
      <input type="hidden" name="content" value={raw ? text : JSON.stringify(value)} />
    </div>
  );
}
