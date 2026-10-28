# FriBee HQ — Premium arayüz, AI PR Ajansı 2026–2034 ve Entegrasyon Merkezi

Bu belge "Master Development Directive V2" kapsamında yapılan geliştirmeyi, dağıtım ve geri alma adımlarını,
yarın gereken kimlik bilgilerini ve bilinen sınırlamaları özetler. Geliştirme dalı: `claude/premium-hq-pr-agency`.
**Canlıya alınmadı** — dağıtım sahibin ayrı onayıyla yapılır.

## 1. Ne yapıldı

### Öncelik 1 — Premium arayüz
- **Tasarım sistemi** (`src/app/globals.css`): koyu katmanlı yüzeyler, altın vurgu, kontrollü mor/mavi/turuncu/yeşil;
  anlamsal durum renkleri (başarı/uyarı/hata/bilgi/demo), kart/düğme/girdi/çip bileşenleri, hareket azaltma tercihine saygı.
  Arayüz vurgu renkleri markanın resmî renkleri **değildir**; ürün görsellerine uygulanmaz.
- **Yazı tipleri**: Inter (arayüz) + Playfair Display (editoryal başlıklar), yerelde barındırılır (SIL OFL 1.1,
  `public/fonts/*-OFL.txt`); çalışma anında dış istek yok, Türkçe karakter kapsamı (latin-ext) dahil.
- **Simge seti** (`src/components/icons.tsx`): bağımlılıksız, tek renkli çizgi simgeler.
- **Uygulama kabuğu**: sabit sol menü (Genel bakış · PR Ajansı · Yaratıcı · Marka · İş · Sistem), cam efektli üst çubuk,
  bölüm arama (Ctrl/⌘+K), onay rozeti, marka seçici; tablet/telefonda soldan açılan menü ve alt hızlı erişim çubuğu.
  Ölü bağlantı yok; verisi bağlanmamış bölümler "Kurulum bekliyor" noktasıyla işaretlenir.
- **Ana ekran (FriBee HQ)**: doğrulanmış marka görselli kapak (yoksa dürüst boş durum), "FriBee — Beyond Fashion"
  (önerilen konumlandırma, resmî slogan değil), günlük operasyon özeti, 6 metrik kartı, son kampanyalar, içerik takvimi,
  AI PR ekibi, 8 yıllık yol haritası, pazar istihbaratı, platform entegrasyonları, son etkinlikler, koleksiyonlar.
  **Hiçbir sahte metrik yok**: veri kaynağı bağlı değilse "—" ve bağlantı gereksinimi gösterilir.
- **Kapak görseli kuralı**: sahibin seçtiği (Medya → "Ana ekran kapağı yap") → doğrulanmış ürün referansı →
  marka sahibi/lisanslı gerçek fotoğraf. AI üretimi ve hak durumu bilinmeyen görsel kullanılmaz.
- **PWA**: `manifest.webmanifest`, marka logosundan üretilen uygulama simgesi (`/app-icon/{180,192,512}`; logo yoksa nötr
  simge), iOS ana ekran meta etiketleri, güvenli alanlar. Service worker yalnızca içerik karmalı derleme dosyalarını,
  yazı tiplerini ve çevrimdışı sayfasını önbelleğe alır; **sayfa, API, medya ve iş verisi cihazda saklanmaz**.
  Yeni sürümde eski önbellek silinir (sürüm = commit).
- Var olan tüm sayfalar yeni tasarım sistemine geçirildi (işlev, rota, izin ve veritabanı bağlantıları değişmedi).

### Öncelik 2 — AI PR Ajansı
- **Uzman kadrosu** (`src/lib/pr-agency/specialists.ts`): AI PR Direktörü, Marka Strateji, Pazar İstihbaratı,
  Medya İlişkileri, Influencer İlişkileri, Kreatif Direktör, Sosyal Medya, E-ticaret İstihbaratı, PR Ölçüm.
  Yeni/paralel ajan sistemi değildir: her uzman mevcut görev motoru ajanlarına ve PR zamanlanmış rollerine eşlenir.
- **Marka Stratejisi 2026–2034** (`/pr-ajansi/strateji`, geçiş 006 `strategy_items`): vizyon, 5 aşama, 9 yıllık hedef,
  çeyreklik OKR'ler, aylık kampanya planı, haftalık uygulama, günlük izleme, performans incelemeleri ve stratejik
  ayarlama geçmişi. Her şey düzenlenebilir; her değişiklik gerekçesiyle `strategy_item_revisions`'a yazılır.
  Başlangıç kalemleri yalnızca sahip "oluştur" deyince eklenir ve **öneri** olarak işaretlidir. "Comeback/relaunch"
  anlatımı reddedilir; anahtar sonuçlar ölçülmüş, kaynaklı başlangıç değeri olmadan sayıya bağlanmaz.
- **Bilgi kütüphanesi** (`/pr-ajansi/kutuphane`): AMEC IEF, Barcelona Principles 4.0, STP, Keller CBBE, IMC, tüketici
  davranışı, moda pazarlaması, kültürel markalaşma, itibar yönetimi, SCCT kriz iletişimi, konumlandırma, medya ilişkileri
  ölçümü. Kaynak, sürüm, yıl ve doğrulama durumu (doğrulandı / kısmen / inceleme gerekli) ile; özetler kendi sözlerimizle.
  Çerçeve, dış araştırma ve AI önerisi ayrı türlerdir; AI önerisi doğrulanmış işaretlenemez. Arama ve değişiklik geçmişi var.
- Yeni sayfalar: Pazar İstihbaratı, Medya İlişkileri, Influencer Ağı, İçerik Takvimi, Koleksiyonlar, İş (E-ticaret,
  Müşteriler, Satış Analitiği), Otomasyon.

### Öncelik 3 — Entegrasyon Merkezi (`/entegrasyonlar`, `src/lib/integrations/`)
Her kartta: amaç, durum, kimlik doğrulama gereksinimi, hazır yetenekler, son başarılı test/senkron, son hata,
senkron durumu, kullanım/maliyet, bağlantı testi ve resmî belgeler. Durumlar: Yapılandırılmadı · Kimlik bilgisi bekleniyor ·
Bağlı (test edilmedi) · Doğrulandı · Kısıtlı çalışıyor · Engelli/erişim bekliyor · Hata. **"Doğrulandı" yalnızca gerçek bir
resmî testten sonra.** Gizli değerler AES-256-GCM ile şifrelenir; ekrana, günlüğe ve denetim kaydına yazılmaz.

| Sağlayıcı | Bağlantı testi (ücretsiz, salt okunur) | Bu sürümde uygulanan |
|---|---|---|
| Brandwatch | `POST https://api.brandwatch.com/oauth/token` (grant_type=api-password) — parola saklanmaz, yalnızca belirteç | Kimlik + belirteç süresi |
| Muck Rack | Yok — resmî başvuru belgesi yalnızca erişimi olan müşteriye verilir; uç nokta uydurulmadı | Şifreli anahtar saklama; durum "Engelli / erişim bekliyor" |
| Metricool | `GET https://app.metricool.com/api/admin/simpleProfiles?userId=…` (X-Mc-Auth) + blogId eşleşmesi | Kimlik + marka profili |
| Runway | `GET https://api.dev.runwayml.com/v1/organization` (X-Runway-Version: 2024-11-06) | Kimlik + kredi bakiyesi |
| Adobe | `POST https://ims-na1.adobelogin.com/ims/token/v3` (client_credentials) | OAuth Server-to-Server kimliği |
| Shopify | Mevcut: client credentials + `{ shop { name } }` | Kimlik, ürün senkronu, onaylı mağaza değişiklikleri |

### Öncelik 4 — Otomasyon ve gerçek yürütme doğrulaması
- Mevcut zamanlayıcıya **çeyreklik stratejik inceleme** ve **yıllık yol haritası değerlendirmesi** eklendi (günlük, haftalık,
  aylık zaten vardı). Raporlar model çağrısı yapmadan kayıtlı veriden üretilir (gereksiz AI çağrısı yok), onay kuyruğuna düşer.
  Haftalık: kampanya incelemesi, sosyal içerik planı, influencer fırsatları, performans özeti. Aylık: PR performansı,
  konumlandırma, kampanya önerileri, içerik üretim planı. Çeyreklik: stratejik inceleme, OKR değerlendirmesi, bütçe, büyüme.
  Yıllık: 8 yıllık yol haritası, konumlandırma, stratejik öncelikler.
- **Operasyon kaydı** (`pr_operation_runs`): dönem başına tek kayıt (idempotent); rapor kaydedilip sürümü ve dönemi
  doğrulanmadan "tamamlandı" sayılmaz; hata + artan bekleme (5 dk, 15 dk, 45 dk … en fazla 6 sa), dönem başına 5 deneme.
- **Yürütme aşamaları** (`src/lib/orchestrator/verification.ts`): Plan oluşturuldu → Görev zamanlandı → Yürütme başladı →
  Dış servis çağrıldı → Çıktı üretildi → Çıktı doğrulandı → Tamamlandı / Başarısız. Gereken kanıt türe göre: oynatılabilir
  medya, platform yayın onayı (dış kimlik), kaynaklı bulgular, yetkili gönderim kanıtı, kayıtlı rapor. Görev ayrıntı
  sayfasında gösterilir; kanıtsız "tamamlandı" kaydı açıkça işaretlenir. Mevcut video MP4 koruması ve dış işlem kapısı
  değiştirilmedi.

## 2. Testler (bu ortamda çalıştırıldı)
- Birim + entegrasyon (gerçek PostgreSQL 16, S3 taklidi, ffmpeg): `npm test` — sonuç teslim raporunda.
- Yeni: `tests/hq-agency.test.ts` (strateji, kütüphane, uzmanlar, 6 entegrasyon **sahte sağlayıcıyla**, gizli değer sızıntısı,
  yürütme aşamaları, operasyon kaydı/yeniden deneme, kapak görseli kuralları, menü). Sahte sağlayıcı başarısı **canlı
  entegrasyon başarısı değildir**; hiçbir platform gerçek hesapla test edilmedi.
- HTTP güvenlik: 43/43 (yeni: önizleme marka yalıtımı, oturumsuz erişim, PWA dosyalarında özel veri yok).
- Erişilebilirlik (axe WCAG 2.1 A/AA, masaüstü 1360 px + telefon 390 px, yeni sayfalar dahil 42 sayfa): 0 sorun, yatay taşma yok.
- Uçtan uca (Video Stüdyosu → işleyici → MP4 → onay): 11/12 geçti; tarayıcıda H.264 oynatma bu Chromium'da test edilemedi
  (CI Google Chrome ile çalıştırır).
- Üretim derlemesi, tip denetimi ve geçiş politikası (006 = yalnızca ekleme) temiz.

## 3. Dağıtım (sahip onayından sonra)
1. `claude/premium-hq-pr-agency` dalını üretim dalına (`claude/amazing-goodall-qkxupd`) birleştirin (fast-forward veya PR).
2. GitHub → Actions → **Release** → `workflow_dispatch` (üretim dalı). Hat: CI → dağıtım kararı → yedek/PITR kontrolü →
   web → doğrulama → işleyici → doğrulama.
3. Geçiş 006 yalnızca yeni tablo/indeks ekler; işleyici ve web başlangıçta otomatik uygular. Mevcut veri değişmez.
4. Dağıtım sonrası: Marka Stratejisi → "Strateji çerçevesini oluştur", Kütüphane → "Profesyonel çerçeveleri ekle",
   PR Ajansı → Otomasyon → zamanlamayı açın (açıksa işleyici kendisi üretir).

## 4. Geri alma
- Render → servis → Events → önceki başarılı dağıtım → **Rollback**: önce web, sonra işleyici (aynı commit).
- Veritabanı geri alınmaz ve gerekmez: 006 yalnızca yeni tablolar ekler; eski kod bu tabloları görmez.
- PWA önbelleği yalnızca derleme dosyalarını tutar; geri almada service worker sürümü değişir ve eski önbellek silinir.

## 5. Yarın gereken kimlik bilgileri ve izinler
Hepsi **Entegrasyonlar** sayfasındaki forma girilir (Shopify hariç: sunucu ortam değişkeni). Sohbete veya koda yazmayın.

| Platform | Gerekli | Nereden |
|---|---|---|
| Brandwatch | Consumer Research aboneliği + **API kullanıcısı** e-postası ve parolası (parola yalnızca belirteç almak için kullanılır, saklanmaz). Birden çok müşteri hesabı varsa platform client ID (Brandwatch destek). | Brandwatch hesap yöneticisi / destek |
| Muck Rack | Premier plan + **API eklentisi**; yönetici tarafından üretilmiş kuruluş API anahtarı; müşteriye verilen **API başvuru belgesi** (uç noktalar bu belgeyle bağlanacak) | Muck Rack → Organization Settings → API Keys; hesap yöneticisi |
| Metricool | API erişimi olan plan; **API belirteci** (X-Mc-Auth), **userId**, FriBee markasının **blogId**'si | Metricool → Hesap ayarları → API; marka açıkken adres çubuğu |
| Runway | Geliştirici portalında organizasyon + **API anahtarı**; üretim için kredi (bu sürüm üretim yapmaz) | dev.runwayml.com |
| Adobe | Adobe Developer Console projesi, **OAuth Server-to-Server** kimliği: Client ID, Client secret, **kapsam listesi**; kullanılacak ürün (Firefly Services / Photoshop API) için kurumsal yetki | developer.adobe.com/console |
| Shopify | Render ortamına `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`; mağaza alan adı (fribee.myshopify.com); satış için `read_orders`, müşteri için `read_customers` + korumalı müşteri verisi onayı | Shopify Dev Dashboard |

## 6. Bilinen sınırlamalar ve tamamlanmayanlar
- **Tasarım referans görseli bu oturuma ulaşmadı**; arayüz yönergedeki yazılı tarife göre yapıldı. Görsel paylaşılırsa
  birebir hizalama yapılabilir.
- Bu geliştirme ortamının ağ izinlerinde `developers.brandwatch.com`, `docs.dev.runwayml.com` ve `help.muckrack.com` kapalıydı;
  uç noktalar resmî kaynakları dizinleyen aramalarla doğrulandı. Brandwatch veri uç noktaları, Runway üretim uç noktaları,
  Metricool analitik uç noktaları ve Muck Rack'in tamamı resmî belge incelenmeden **uygulanmadı** (uydurma uç nokta yok).
- Sosyal medya performansı, etkileşim, satış ve müşteri metrikleri ana ekranda "—" gösterir: ilgili veri senkronları henüz yok.
- Runway ve Adobe ile ücretli üretim bu sürümde yok (yalnızca kimlik testi). Video üretimi mevcut Gemini hattıyla devam eder.
- Yerel native iOS özelliği yok; uygulama ana ekrana eklenebilir web uygulamasıdır (PWA).
- Tek yönetici oturumu vardır; rol bazlı kullanıcı hesapları bu sürümde yok (ajan araç izinleri ve bilgi hassasiyet rolleri mevcut).
