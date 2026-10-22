import { config } from "@/lib/config";
import { getLimits } from "@/lib/settings";
import { firecrawlConfigured } from "@/lib/adapters/firecrawl";
import { telemetryEnabled } from "@/lib/telemetry";
import { envConfigured, type ProviderId } from "./connections";
import type { ConnectionStatus, Tone } from "@/lib/labels";

// Entegrasyon durumları tek bir ortak ölçekle gösterilir. Yapılandırılmamış hiçbir şey "Etkin" görünmez.

export type IntegrationState = "active" | "not_configured" | "requires_key" | "requires_license" | "disabled_security" | "unsupported";

export const INTEGRATION_STATE_LABEL: Record<IntegrationState, string> = {
  active: "Etkin",
  not_configured: "Kullanılabilir, yapılandırılmadı",
  requires_key: "Hesap veya API anahtarı gerekli",
  requires_license: "Ücretli lisans gerekli",
  disabled_security: "Güvenlik nedeniyle kapalı",
  unsupported: "Desteklenmiyor",
};

export const INTEGRATION_STATE_TONE: Record<IntegrationState, Tone> = {
  active: "ok",
  not_configured: "warn",
  requires_key: "neutral",
  requires_license: "neutral",
  disabled_security: "bad",
  unsupported: "neutral",
};

/** Mevcut bağlantı durumunu ortak ölçeğe çevirir. */
export function stateFromConnection(provider: ProviderId, status: ConnectionStatus): IntegrationState {
  if (status === "unsupported") return "unsupported";
  if (status === "connected") return "active";
  return envConfigured(provider) ? "not_configured" : "requires_key";
}

export type ToolEntry = {
  id: string;
  name: string;
  /** Uygulamada ne işe yarar / neden değerlendirildi. */
  purpose: string;
  /** Verilen karar (kısa). */
  decision: string;
  scope: "runtime" | "developer";
  state: IntegrationState;
  detail: string;
};

/** Değerlendirilen 10 araç ve yerine geçen yerel çözümler. Durum, çalışma zamanındaki gerçek yapılandırmadan hesaplanır. */
export async function toolCatalog(): Promise<ToolEntry[]> {
  const limits = await getLimits();
  const fc = firecrawlConfigured();
  const anthropic = !!config.anthropic.apiKey;
  return [
    {
      id: "anthropic_cache", name: "Anthropic istem önbelleği (Headroom yerine)", scope: "runtime",
      purpose: "Sistem istemi + marka bağlamı önbelleğe alınır; tekrar eden girdi maliyeti düşer.",
      decision: "Uygulandı. Headroom (ek vekil sunucu) kurulmadı: yerel önbellek yeterli, ek servis kanıtlanmış fayda olmadan eklenmez.",
      state: anthropic ? "active" : "requires_key",
      detail: anthropic ? "Gerçek çağrılarda cache_read/cache_creation token'ları maliyet kayıtlarına yazılır." : "AIOPS_ANTHROPIC_API_KEY tanımlı değil; önbellek ancak gerçek modelle çalışır.",
    },
    {
      id: "firecrawl", name: "Firecrawl", scope: "runtime",
      purpose: "Araştırma Merkezi: web araması ve sayfa okuma (kaynaklı, doğrulanmamış).",
      decision: "Uygulandı, varsayılan kapalı. Yalnızca sahip başlatır; ajanlar yalnızca sahibin doğruladığı kaynakları görür.",
      state: !fc ? "requires_key" : limits.webResearch ? "active" : "not_configured",
      detail: !fc ? "Firecrawl hesabı ve FIRECRAWL_API_KEY gerekli." : limits.webResearch ? `Aylık kredi sınırı ${limits.researchMonthlyCredits}.` : "Anahtar tanımlı; Ayarlar → Maliyet Yönetimi'nde web araştırması kapalı.",
    },
    {
      id: "posthog", name: "PostHog", scope: "runtime",
      purpose: "Sunucu tarafı hata ve görev başarısızlığı telemetrisi.",
      decision: "Uygulandı, isteğe bağlı. Tarayıcı betiği ve oturum kaydı yok; içerik ve kişi verisi gönderilmez.",
      state: telemetryEnabled() ? "active" : "requires_key",
      detail: telemetryEnabled() ? `Sunucu: ${config.posthog.host}` : "POSTHOG_API_KEY tanımlı değil; hiçbir veri gönderilmiyor.",
    },
    {
      id: "playwright", name: "Playwright", scope: "developer",
      purpose: "Uçtan uca tarayıcı testleri ve erişilebilirlik denetimi.",
      decision: "Geliştirme bağımlılığı olarak kullanılıyor; üretim imajına girmez.",
      state: "active",
      detail: "Yalnızca test ortamında (npm run test:e2e / test:a11y). Canlı kullanıcı akışında çalışmaz.",
    },
    {
      id: "remotion", name: "Remotion", scope: "runtime",
      purpose: "React tabanlı programatik video şablonları.",
      decision: "Kurulmadı. Şirket kullanımı için ücretli lisans gerekebilir ve Chromium tabanlı render 512 MB işleyiciye sığmaz; ayrı servis ve sahip onayı gerekir. Mevcut kurgu yerel ffmpeg ile yapılır.",
      state: "requires_license",
      detail: "Lisans durumu ve ayrı render servisi sahip kararıdır; etkinleştirilmedi.",
    },
    {
      id: "composio", name: "Composio", scope: "runtime",
      purpose: "Üçüncü taraf uygulamalara toplu araç bağlantısı.",
      decision: "Kapalı. Ajanlara dış hesaplarda işlem yaptırma riski taşır ve uygulama içi onay kapısını atlayabilir; mevcut resmi bağlantılar (Shopify, Instagram) onay kapısından geçer.",
      state: "disabled_security",
      detail: "Etkinleştirilmesi için ayrı güvenlik incelemesi ve onay kapısı entegrasyonu gerekir.",
    },
    {
      id: "omniroute", name: "OmniRoute", scope: "runtime",
      purpose: "Birden çok model sağlayıcısına yönlendiren vekil.",
      decision: "Önerilmez, kurulmadı. Ek vekil; anahtarları ve müşteri verisini üçüncü bir katmandan geçirir, maliyet takibini bozar.",
      state: "unsupported",
      detail: "Model çağrıları resmi Anthropic SDK ile doğrudan yapılır.",
    },
    {
      id: "ruflo", name: "Ruflo", scope: "developer",
      purpose: "Kodlama ajanı orkestrasyonu (geliştirici aracı).",
      decision: "Uygulamaya eklenmedi. Geliştirici makinesinde isteğe bağlı; çalışma zamanı ajanlarıyla ilgisi yok.",
      state: "unsupported",
      detail: "Uygulama içinde desteklenmez.",
    },
    {
      id: "claude_mem", name: "claude-mem", scope: "developer",
      purpose: "Kodlama oturumları için kalıcı hafıza (geliştirici aracı).",
      decision: "Uygulamaya eklenmedi. Ürün içi ihtiyaç Marka Hafızası ile (marka bazında, sahip onaylı) karşılandı.",
      state: "unsupported",
      detail: "Uygulama içinde desteklenmez.",
    },
    {
      id: "task_observer", name: "Task Observer", scope: "developer",
      purpose: "Kodlama ajanı görev gözlemi (geliştirici aracı).",
      decision: "Uygulamaya eklenmedi. Ürün içi gözlem: görev panosu, denetim kaydı, sistem durumu ve isteğe bağlı PostHog.",
      state: "unsupported",
      detail: "Uygulama içinde desteklenmez.",
    },
  ];
}
