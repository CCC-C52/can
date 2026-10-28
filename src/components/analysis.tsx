import type { MediaAnalysis } from "@/lib/media-analysis";
import { Badge, dt, usd } from "@/components/ui";

const STATUS: Record<string, { l: string; t: "ok" | "warn" | "bad" | "info" | "neutral" }> = {
  pending: { l: "Sırada", t: "neutral" }, processing: { l: "Analiz ediliyor", t: "info" }, completed: { l: "Tamamlandı", t: "ok" }, failed: { l: "Başarısız", t: "bad" },
};

function Colors({ colors }: { colors: { hex: string; name: string; share: number }[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {colors.map((c) => (
        <li key={c.hex + c.name} className="flex items-center gap-1 text-xs"><span aria-hidden className="inline-block h-4 w-4 rounded border border-line" style={{ background: c.hex }} />{c.name} {Math.round(c.share * 100)}%</li>
      ))}
    </ul>
  );
}

export function AnalysisPanel({ a, assetId }: { a: MediaAnalysis | null; assetId: string }) {
  if (!a) return <p className="muted">Bu dosya için analiz yok. (Desteklenen türler: JPEG, PNG, WebP, GIF görseller ve videolar.)</p>;
  const st = STATUS[a.status] ?? { l: a.status, t: "neutral" as const };
  const local = a.result?.local;
  const v = a.result?.vision;
  return (
    <div className="space-y-3 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={st.t}>{st.l}</Badge>
        <Badge tone={a.level === "vision" ? "info" : "neutral"}>{a.level === "vision" ? `Piksel + görsel model (${a.model ?? a.provider})` : "Yalnızca yerel piksel analizi"}</Badge>
        <span className="text-xs text-muted">sürüm {a.analysis_version} · deneme {a.attempts}/{a.max_attempts} · {dt(a.completed_at ?? a.created_at)}{a.cost_usd !== null ? ` · maliyet ${usd(a.cost_usd)}` : a.cost_unknown ? " · maliyet bilinmiyor" : ""}</span>
      </div>
      {a.error && <p className="text-xs text-danger">{a.error}</p>}
      {a.level === "local" && a.status === "completed" && <p className="text-xs text-muted">Ürün türü, baskı, poz gibi anlamsal bilgiler için görsel model (AIOPS_ANTHROPIC_API_KEY) gerekir; tahmin üretilmez.</p>}
      {local && a.kind === "image" && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div><dt className="label">Yön / oran</dt><dd>{local.orientation} · {local.aspect}</dd></div>
          <div><dt className="label">Parlaklık / kontrast</dt><dd>{local.brightness} / {local.contrast}</dd></div>
          <div><dt className="label">Netlik</dt><dd>{local.sharpness}</dd></div>
          <div><dt className="label">Arka plan</dt><dd>{local.background.name}{local.background.uniform ? " (düz)" : ""}</dd></div>
          <div className="col-span-2 sm:col-span-4"><dt className="label">Baskın renkler</dt><dd><Colors colors={local.dominant_colors} /></dd></div>
          {local.quality_flags.length > 0 && <div className="col-span-2 sm:col-span-4"><dt className="label">Kalite uyarıları</dt><dd>{local.quality_flags.join(", ")}</dd></div>}
        </dl>
      )}
      {local && a.kind === "video" && (
        <div className="space-y-2">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div><dt className="label">Süre</dt><dd>{local.probe.duration} sn</dd></div>
            <div><dt className="label">Çözünürlük</dt><dd>{local.probe.display_width}×{local.probe.display_height} ({local.probe.orientation})</dd></div>
            <div><dt className="label">Kare hızı</dt><dd>{local.probe.fps ?? "?"} fps</dd></div>
            <div><dt className="label">Ses</dt><dd>{local.audio.present ? (local.audio.silent ? "var (sessiz)" : `var (${local.audio.mean_db} dB)`) : "yok"}</dd></div>
            <div><dt className="label">Hareket</dt><dd>{local.motion.level}</dd></div>
            <div><dt className="label">Kullanılabilirlik</dt><dd>{local.usability.score}/100</dd></div>
          </dl>
          {local.usability.issues.length > 0 && <p className="text-xs text-warning">Sorunlar: {local.usability.issues.join(", ")}</p>}
          <div className="label">Sahneler ve incelenen kareler</div>
          <ul className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {local.frames.map((f: any) => (
              <li key={f.index} className="rounded border border-line p-1 text-xs">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/media/${assetId}/analysis-frame/${f.index}`} alt={`Kare ${f.index + 1}, ${f.t} saniye`} className="w-full rounded" loading="lazy" />
                <div className="mt-1">Kare {f.index + 1} · {f.t} sn · {f.dominant_colors.slice(0, 2).map((c: any) => c.name).join(", ")}</div>
              </li>
            ))}
          </ul>
          <ul className="text-xs">{local.scenes.map((s: any) => <li key={s.index}>Sahne {s.index + 1}: {s.start}–{s.end} sn · {s.dominant_colors.join(", ")}</li>)}</ul>
          {local.recommendations.length > 0 && <ul className="list-disc pl-5 text-xs">{local.recommendations.map((r: string) => <li key={r}>{r}</li>)}</ul>}
        </div>
      )}
      {v && (
        <div className="rounded-lg bg-info-soft/50 p-3">
          <div className="label">Görsel model analizi</div>
          <p>{v.summary}</p>
          {a.kind === "image" ? (
            <ul className="mt-2 space-y-1 text-xs">
              {v.products.map((p: any, i: number) => <li key={i}><strong>{p.category}</strong> · renkler: {p.colors.join(", ")} · baskı: {p.graphics_or_print} · metin: {p.visible_text} · katalog: {p.matched_catalog_product}</li>)}
              <li>Model: {v.model_present ? `var (${v.pose})` : "yok"} · Arka plan: {v.background} · Işık: {v.lighting} · Kompozisyon: {v.composition}</li>
              <li>Ürün görünürlüğü: {v.product_visibility} · Pazarlama uygunluğu: {v.marketing_suitability.score}/5 — {v.marketing_suitability.reason}</li>
              {v.usage_scenarios.length > 0 && <li>Kullanım: {v.usage_scenarios.join(", ")}</li>}
            </ul>
          ) : (
            <ul className="mt-2 space-y-1 text-xs">
              {v.scenes.map((s: any, i: number) => <li key={i}>Kareler {s.frame_numbers.join(", ")}: {s.summary} · kamera: {s.camera}</li>)}
              {v.marketing_uses.length > 0 && <li>Pazarlama kullanımı: {v.marketing_uses.join(", ")}</li>}
            </ul>
          )}
          {v.uncertain?.length > 0 && <p className="mt-2 text-xs text-warning">Belirsiz: {v.uncertain.join("; ")}</p>}
        </div>
      )}
    </div>
  );
}
