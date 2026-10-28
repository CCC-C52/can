import { visionModel } from "@/lib/media-analysis";
import { getSetting } from "@/lib/settings";
import { Badge } from "@/components/ui";

/** AI görsel anlama durumu: model yoksa açıkça "engelli" gösterilir. */
export async function VisionStatus() {
  const model = visionModel();
  const visionOn = await getSetting<boolean>("vision_on_upload", true);
  if (!model) {
    return (
      <div className="mb-4 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning ring-1 ring-warning-line">
        <Badge tone="warn">AI görsel anlama engelli</Badge>{" "}
        Gerçek görsel model bağlı değil. Dosyalar yalnızca yerel olarak ölçülür (çözünürlük, renk, parlaklık, sahne sınırları). Ajanlar
        görüntüde ne olduğunu bilmez ve tarif etmez; çıktıda bunu “bilinmeyen” olarak belirtir.
      </div>
    );
  }
  return (
    <div className="mb-4 text-sm">
      <Badge tone={visionOn ? "ok" : "warn"}>{visionOn ? "AI görsel anlama açık" : "AI görsel anlama yüklemede kapalı"}</Badge>{" "}
      <span className="muted">{visionOn ? "Yeni yüklemeler görsel modelle de analiz edilir (ücretli)." : "Ayarlar'dan açılabilir; dosya sayfasından tek tek analiz edilebilir."}</span>
    </div>
  );
}
