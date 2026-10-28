// Stratejik platform entegrasyonları: Brandwatch, Muck Rack, Metricool, Runway, Adobe, Shopify.
// Kurallar:
//  - Yalnızca resmî, desteklenen API'ler veya yetkili bağlantı yöntemleri. Uç nokta uydurulmaz.
//  - Bağlantı testi gerçek bir resmî çağrıdır; ücretli işlem (üretim, yayın, mesaj) TETİKLEMEZ.
//  - Resmî belgesi bu sürümde doğrulanamayan işlemler uygulanmaz; sağlayıcı "Engelli / erişim bekliyor" gösterilir.
//  - ChatGPT eklentisi gibi başka bir üründeki bağlantı bu uygulamaya erişim vermez; kimlik bilgisi burada ayrıca girilir.
//  - Gizli değerler AES-256-GCM ile şifrelenir (connections.credentials_encrypted); ekranda veya günlükte gösterilmez.

export type IntegrationId = "brandwatch" | "muck_rack" | "metricool" | "runway" | "adobe" | "shopify";

export type CredentialField = { name: string; label: string; secret: boolean; required: boolean; placeholder?: string; help?: string; pattern?: string };

export type IntegrationDef = {
  id: IntegrationId;
  name: string;
  purpose: string;
  uses: string[];
  /** Kimlik doğrulama yöntemi (resmî belgeye göre). */
  auth: string;
  /** Erişim koşulu (plan, eklenti, onay). */
  access: string;
  fields: CredentialField[];
  /** Bağlantı testinin ne yaptığı (gerçek, ücretsiz çağrı) — test yoksa null. */
  test: string | null;
  /** Şu an uygulanmış yetenekler (gerçek kod) ve sonraki adımlar. */
  implemented: string[];
  planned: string[];
  cost: string;
  docs: { label: string; url: string }[];
  /** Bu sürümde doğrulanamayan bilgiler. */
  caveats: string[];
};

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: "brandwatch",
    name: "Brandwatch Consumer Research",
    purpose: "Trend izleme, sosyal dinleme, rakip istihbaratı, marka duygusu ve tüketici araştırması.",
    uses: ["Pazar İstihbaratı", "Influencer fırsatları", "PR ölçümü"],
    auth: "API kullanıcısı ile belirteç: POST https://api.brandwatch.com/oauth/token (grant_type=api-password, client_id=brandwatch-api-client). Dönen erişim belirteci sonraki isteklerde kullanılır; API kullanıcısı için varsayılan süre 1 yıl.",
    access: "Brandwatch Consumer Research aboneliği ve API erişimi açık bir API kullanıcısı gerekir. Birden fazla müşteri hesabı varsa Brandwatch destekten platform client ID istenir.",
    fields: [
      { name: "username", label: "API kullanıcı e-postası", secret: false, required: true, placeholder: "api-user@fribee.com" },
      { name: "password", label: "API kullanıcı parolası", secret: true, required: true, help: "Yalnızca belirteç almak için kullanılır ve SAKLANMAZ; saklanan tek şey şifreli erişim belirtecidir." },
    ],
    test: "Resmî belirteç uç noktasından erişim belirteci alır (veri okumaz, ücret doğurmaz).",
    implemented: ["Kimlik doğrulama ve şifreli belirteç saklama", "Belirteç süresi takibi"],
    planned: ["Proje/sorgu listesi ve bahsetme verisi (v2 API başvuru belgesi incelendikten sonra)"],
    cost: "Abonelik planına bağlı. Bu uygulama Brandwatch'ta çağrı başına ücret doğurmaz; yalnızca kimlik testi yapılır.",
    docs: [{ label: "Brandwatch geliştirici belgeleri — kimlik doğrulama", url: "https://developers.brandwatch.com/docs/authenticate" }],
    caveats: ["developers.brandwatch.com bu geliştirme ortamının ağ izinlerinde kapalıydı; veri uç noktaları (projeler, sorgular) resmî v2 belgesi incelenmeden uygulanmadı."],
  },
  {
    id: "muck_rack",
    name: "Muck Rack",
    purpose: "Medya ilişkileri, gazeteci araştırması, basın kapsamı izleme ve PR performansı.",
    uses: ["Medya İlişkileri", "PR ölçümü"],
    auth: "Kuruluş API anahtarı: Muck Rack'te bir yönetici Organization Settings → API Keys bölümünden üretir.",
    access: "Muck Rack API, Premier müşterileri için ücretli bir eklentidir (yıllık; ücret veri isteme sıklığına göre). Tam API başvuru belgesi yalnızca erişimi olan müşterilere verilir.",
    fields: [{ name: "apiKey", label: "Kuruluş API anahtarı", secret: true, required: true }],
    test: null,
    implemented: ["Şifreli anahtar saklama"],
    planned: ["Tracker (kayıtlı arama) makale/yayın verisi — müşteriye verilen resmî başvuru belgesiyle uygulanacak"],
    cost: "Premier plan + API eklentisi (yıllık). Bu uygulama Muck Rack'e çağrı yapmaz.",
    docs: [
      { label: "Muck Rack API (yardım merkezi)", url: "https://help.muckrack.com/en/articles/10175260-muck-rack-api" },
      { label: "Muck Rack API ürün sayfası", url: "https://muckrack.com/pr-software/api" },
    ],
    caveats: ["Kimlik doğrulama başlığı ve uç noktalar herkese açık belgelenmemiş; doğrulanmadan bağlantı testi yazılmadı (uydurma uç nokta yok)."],
  },
  {
    id: "metricool",
    name: "Metricool",
    purpose: "Sosyal medya analitiği, içerik zamanlama, yayın akışları ve etkileşim ölçümü.",
    uses: ["Sosyal Medya", "İçerik Takvimi", "PR ölçümü"],
    auth: "Hesap API belirteci X-Mc-Auth başlığında; her istekte userId (hesap) ve blogId (marka) parametreleri.",
    access: "API erişimi olan bir Metricool planı gerekir. Belirteç Metricool → Hesap ayarları → API bölümündedir; userId ve blogId, uygulamada marka açıkken adres çubuğunda görünür.",
    fields: [
      { name: "userToken", label: "API belirteci (X-Mc-Auth)", secret: true, required: true },
      { name: "userId", label: "userId", secret: false, required: true, pattern: "^[0-9]{1,20}$" },
      { name: "blogId", label: "blogId (FriBee markası)", secret: false, required: true, pattern: "^[0-9]{1,20}$" },
    ],
    test: "Resmî uç nokta GET https://app.metricool.com/api/admin/simpleProfiles?userId=… ile yönetilen markaları okur ve blogId'nin listede olduğunu doğrular (yayın yapmaz).",
    implemented: ["Kimlik doğrulama ve marka eşleşmesi doğrulaması", "Marka profili senkronu (ad, kimlik)"],
    planned: ["Analitik ve zamanlama uç noktaları (resmî API belgesi app.metricool.com/resources/apidocs incelendikten sonra)", "Gönderi zamanlama: yalnızca sahip onayıyla"],
    cost: "Plan bazlı abonelik. Doğrulama çağrısı ücret doğurmaz.",
    docs: [
      { label: "Metricool API temel entegrasyon rehberi", url: "https://help.metricool.com/en/article/zr6lmy" },
      { label: "Metricool API sık sorulanlar", url: "https://help.metricool.com/common-questions-and-errors-when-using-the-api-8x9nq" },
    ],
    caveats: ["Analitik uç noktalarının tam listesi bu ortamdan okunamadı; yalnızca belgelenmiş profil listeleme çağrısı uygulandı."],
  },
  {
    id: "runway",
    name: "Runway API",
    purpose: "AI video üretimi, yaratıcı video prodüksiyonu ve kampanya medyası geliştirme.",
    uses: ["Video Stüdyosu", "Kreatif Direktör"],
    auth: "Bearer API anahtarı + X-Runway-Version başlığı; temel adres https://api.dev.runwayml.com.",
    access: "Runway geliştirici portalında organizasyon ve API anahtarı; üretim için kredi satın alınmış olmalı.",
    fields: [{ name: "apiKey", label: "API anahtarı", secret: true, required: true }],
    test: "GET /v1/organization ile organizasyonun katmanını ve kredi bakiyesini okur (video ÜRETMEZ, kredi harcamaz).",
    implemented: ["Kimlik doğrulama", "Kredi bakiyesi ve katman okuma"],
    planned: ["Video üretim görevleri: mevcut Video Stüdyosu bütçe kapısı, sağlayıcı iş kaydı ve MP4 doğrulamasıyla — ayrıca sahip onayı"],
    cost: "Üretim kredi bazlıdır (ücretli). Bu sürüm yalnızca bakiye okur; üretim çağrısı yoktur.",
    docs: [{ label: "Runway API belgeleri", url: "https://docs.dev.runwayml.com/" }],
    caveats: ["docs.dev.runwayml.com bu ortamın ağ izinlerinde kapalıydı; organizasyon uç noktası ve sürüm başlığı Runway'in resmî araç depolarındaki örneklerden doğrulandı. Üretim uç noktaları bu sürümde uygulanmadı."],
  },
  {
    id: "adobe",
    name: "Adobe (Firefly Services / Creative Cloud API)",
    purpose: "Profesyonel kreatif üretim, görsel ve video düzenleme, marka varlığı yönetimi ve kreatif kalite kontrol.",
    uses: ["Görsel Stüdyosu", "Kreatif Direktör"],
    auth: "Adobe Developer Console'da OAuth Server-to-Server kimliği: POST https://ims-na1.adobelogin.com/ims/token/v3 (grant_type=client_credentials, client_id, client_secret, scope). Yenileme belirteci yoktur; belirteç ~24 saat geçerlidir.",
    access: "Adobe Developer Console projesi ve ilgili API ürününe (ör. Firefly Services, Photoshop API) kurumsal yetki gerekir. Kapsamlar ürüne göre değişir.",
    fields: [
      { name: "clientId", label: "Client ID", secret: false, required: true },
      { name: "clientSecret", label: "Client secret", secret: true, required: true },
      { name: "scopes", label: "Kapsamlar (Developer Console'daki liste)", secret: false, required: true, placeholder: "openid,AdobeID,read_organizations" },
    ],
    test: "IMS belirteç uç noktasından erişim belirteci alır (üretim veya düzenleme çağrısı yapmaz, ücret doğurmaz).",
    implemented: ["OAuth Server-to-Server kimlik doğrulaması"],
    planned: ["Ürüne özel işlemler (Firefly/Photoshop) — yalnızca doğrulanmış ürün görselleri ve sahip onayıyla; ürün çizimleri ve renkleri değiştirilmez"],
    cost: "Kurumsal sözleşmeye bağlı. Bu sürüm yalnızca kimlik testi yapar.",
    docs: [
      { label: "OAuth Server-to-Server kimliği", url: "https://developer.adobe.com/developer-console/docs/guides/authentication/ServerToServerAuthentication/IMS" },
      { label: "Firefly Services kimlik doğrulama", url: "https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/authentication" },
    ],
    caveats: ["Kapsam listesi kullanılacak Adobe ürününe göre seçilmelidir."],
  },
  {
    id: "shopify",
    name: "Shopify Admin API",
    purpose: "Ürün kataloğu, satış analitiği, müşteri içgörüleri, e-ticaret raporlaması ve kampanya atfı.",
    uses: ["E-ticaret", "Ürünler", "Satış Analitiği", "Müşteriler"],
    auth: "Shopify Dev Dashboard uygulaması + client credentials grant: POST https://{mağaza}.myshopify.com/admin/oauth/access_token. Uygulama kimliği sunucu ortam değişkenlerinde (SHOPIFY_CLIENT_ID/SECRET).",
    access: "Kendi organizasyonunuzdaki mağazaya kurulmuş uygulama. Siparişler için read_orders, müşteri verisi için read_customers kapsamı ve Shopify'ın korumalı müşteri verisi onayı gerekir.",
    fields: [{ name: "shop", label: "Mağaza alan adı", secret: false, required: true, placeholder: "fribee.myshopify.com" }],
    test: "GraphQL { shop { name currencyCode } } sorgusuyla mağazayı okur (yazma yapmaz).",
    implemented: ["Kimlik doğrulama ve mağaza okuma", "Ürün senkronu", "Onaylı ürün değişikliklerini uygulama (dış işlem kapısıyla)"],
    planned: ["Sipariş ve müşteri analitiği (read_orders / read_customers kapsamları verildikten sonra)"],
    cost: "Shopify planına dahil; API çağrıları ücret doğurmaz (hız sınırlarına tabidir).",
    docs: [
      { label: "Client credentials grant", url: "https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant" },
      { label: "Korumalı müşteri verisi", url: "https://shopify.dev/docs/apps/launch/protected-customer-data" },
    ],
    caveats: [],
  },
];

export function integrationDef(id: string) {
  return INTEGRATIONS.find((i) => i.id === id);
}

export const STATE_ORDER = ["not_configured", "awaiting_credentials", "connected", "verified", "degraded", "blocked", "error"] as const;
export type IntegrationState = (typeof STATE_ORDER)[number];

export const STATE_LABEL: Record<IntegrationState, string> = {
  not_configured: "Yapılandırılmadı",
  awaiting_credentials: "Kimlik bilgisi bekleniyor",
  connected: "Bağlı (test edilmedi)",
  verified: "Doğrulandı",
  degraded: "Kısıtlı çalışıyor",
  blocked: "Engelli / erişim bekliyor",
  error: "Hata",
};

export const STATE_TONE: Record<IntegrationState, "ok" | "warn" | "bad" | "neutral" | "info"> = {
  not_configured: "neutral",
  awaiting_credentials: "warn",
  connected: "info",
  verified: "ok",
  degraded: "warn",
  blocked: "warn",
  error: "bad",
};

/** Son gerçek testin sonucu. */
export type TestOutcome = "success" | "auth_error" | "forbidden" | "transient" | "error";

/** Saklanan (gizli olmayan) durum bilgisi: connections.config.integration */
export type IntegrationMeta = {
  setupStartedAt?: string | null;
  credentialsSavedAt?: string | null;
  verifiedAt?: string | null;
  lastTestAt?: string | null;
  lastOutcome?: TestOutcome | null;
  lastSuccessAt?: string | null;
  lastSyncAt?: string | null;
  syncStatus?: string | null;
  lastErrorAt?: string | null;
  usage?: Record<string, string | number | null>;
  account?: Record<string, string | number | null>;
  tokenExpiresAt?: string | null;
};

/**
 * Durum hesabı (saf). "Doğrulandı" yalnızca son gerçek test başarılıysa.
 *  - kayıt yok → not_configured; kurulum başlatıldı ama kimlik yok → awaiting_credentials
 *  - resmî test yöntemi yok (Muck Rack) → blocked
 *  - belirteç süresi dolmuş → error
 *  - son test: success → verified · forbidden (403: plan/izin) → blocked · auth_error/error → error
 *    transient (429/5xx/ağ) → daha önce doğrulanmışsa degraded, değilse error
 *  - hiç test edilmedi → connected
 */
export function computeState(def: IntegrationDef, input: { hasRecord: boolean; hasCredentials: boolean; meta: IntegrationMeta; now?: Date }): IntegrationState {
  const m = input.meta;
  const now = input.now ?? new Date();
  if (!input.hasRecord) return "not_configured";
  if (!input.hasCredentials) return m.setupStartedAt ? "awaiting_credentials" : "not_configured";
  if (!def.test) return "blocked";
  if (m.tokenExpiresAt && new Date(m.tokenExpiresAt).getTime() < now.getTime()) return "error";
  switch (m.lastOutcome) {
    case "success": return m.verifiedAt ? "verified" : "connected";
    case "forbidden": return "blocked";
    case "transient": return m.verifiedAt ? "degraded" : "error";
    case "auth_error":
    case "error": return "error";
    default: return "connected";
  }
}
