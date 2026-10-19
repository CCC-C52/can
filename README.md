# AI Operations Studio

Markadan bağımsız bir **dijital AI ekibi**. Ana yöneticiyle konuşursunuz; yönetici talimatınızı hedeflere ve görevlere ayırır, uzman ajanlara dağıtır, işleri takip eder, çıktıları kalite kontrolüne gönderir ve sonuçları dosyalar, önizlemeler ve kısa bir raporla sunar. Dış platformlara dokunan her işlem (yayın, canlı mağaza, fiyat, reklam) **sunucu kodunda zorunlu onaya** bağlıdır.

> Durum (ilk sürüm): Uygulama yerel ortamda **DEMO modunda** baştan sona çalışır ve test edilmiştir. Gerçek AI (Anthropic), Shopify, Instagram ve görsel üretim adaptörleri yazılmıştır ancak bu geliştirme ortamında **gerçek hesap/anahtar olmadığı için gerçek servislerle test edilmemiştir** (yalnızca sahte HTTP yanıtlarıyla test edildi). Ayrıntılar aşağıda.

---

## İçindekiler
1. [Mimari](#mimari)
2. [Kurulum ve başlatma](#kurulum-ve-başlatma)
3. [Ortam değişkenleri](#ortam-değişkenleri)
4. [Veritabanı](#veritabanı)
5. [Görev işleyicisi](#görev-işleyicisi)
6. [Ajanlar](#ajanlar)
7. [Demo akışını deneme](#demo-akışını-deneme)
8. [Gerçek servisleri bağlama](#gerçek-servisleri-bağlama)
9. [Ne gerçekten çalışıyor / ne demo / ne bağlantı bekliyor](#özellik-durumu)
10. [Güvenlik ve güvenilirlik](#güvenlik-ve-güvenilirlik)
11. [Test sonuçları](#test-sonuçları)
12. [Bilinen sınırlamalar](#bilinen-sınırlamalar)
13. [FriBee'yi sisteme ekleme](#fribeeyi-sisteme-ekleme)

---

## Mimari

| Katman | Teknoloji | Not |
|---|---|---|
| Panel + API | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4 | Türkçe, mobil uyumlu. Sunucu eylemleri + birkaç route handler |
| Veritabanı | PostgreSQL 16 | `migrations/*.sql`, `npm run db:migrate` |
| Görev işleyicisi | Ayrı Node süreci (`worker/index.ts`) | Kiralama (lease) + kalp atışı ile kalıcı kuyruk, `FOR UPDATE SKIP LOCKED` |
| Dosya depolama | Yerel klasör veya S3 uyumlu (AWS S3, R2, MinIO) | `src/lib/storage` |
| Metin/planlama modeli | Anthropic Claude API adaptörü + DEMO adaptörü | `src/lib/models` |
| Görsel | Yerel `sharp` derleyici (AI değil) + OpenAI Images adaptörü | `src/lib/adapters/compose.ts`, `images.ts` |
| Video | Yerel `ffmpeg` kurgu/render (AI değil) + AI video arayüzü | `video-edit.ts`, `video-generation.ts` |
| Mağaza / sosyal | Shopify Admin GraphQL, Instagram Graph API, TikTok manuel paket | `src/lib/adapters` |

Mikroservis yok: web uygulaması ve işleyici aynı kod tabanını (`src/lib`) paylaşan iki süreçtir.

```
src/
  app/                 Panel sayfaları, sunucu eylemleri (actions/), API uçları (api/)
  components/          Arayüz bileşenleri (önizleme, yapılandırılmış düzenleyici, yükleyici)
  lib/
    agents/            Ajan tanımları (registry), çıktı şemaları, istemler, kural tabanlı QA
    models/            Anthropic adaptörü, DEMO üretici
    orchestrator/      Proje/görev işlemleri ve görev motoru (engine.ts)
    services/          Marka, ürün, medya, çıktı/onay, dış işlem kapısı (gateway.ts), maliyet, bağlantılar
    adapters/          Shopify, Instagram, OpenAI Images, sharp derleyici, ffmpeg
    storage/           Yerel / S3 depolama
  proxy.ts             Kimlik doğrulama + güvenlik başlıkları (Next 16'da middleware'in yeni adı)
worker/index.ts        Görev işleyicisi
migrations/            SQL şema geçişleri
tests/                 Kabul ve güvenlik testleri (vitest, gerçek PostgreSQL)
```

**Geliştirme ajanları ile uygulama ajanları ayrıdır.** Bu depoyu geliştirirken kullanılan kodlama ajanlarının uygulamayla bağı yoktur. Uygulamanın çalışma zamanı ajanları `src/lib/agents/registry.ts` içinde tanımlıdır, görevleri veritabanından alır ve çıktı üretir.

---

## Kurulum ve başlatma

Gereksinimler: Node.js 22+, PostgreSQL 14+ (16 ile test edildi), ffmpeg/ffprobe (video kurgu için; yoksa yalnızca video render devre dışı kalır).

```bash
npm install
cp .env.example .env            # değerleri düzenleyin (gizli değerleri depoya eklemeyin)

# PostgreSQL kullanıcısı ve veritabanı (örnek)
sudo -u postgres psql -c "create user aiops with password 'aiops' createdb;"
sudo -u postgres psql -c "create database aiops owner aiops;"
sudo -u postgres psql -c "create database aiops_test owner aiops;"   # testler için

npm run db:migrate              # şemayı kurar
npm run db:seed-demo            # (isteğe bağlı) açıkça ÖRNEK işaretli demo marka

# İki ayrı terminalde:
npm run dev                     # panel: http://127.0.0.1:3000 (yalnızca yerel arayüz)
npm run worker                  # görev işleyicisi
```

Üretim derlemesi: `npm run build && npm run start` (+ ayrı süreç olarak `npm run worker`).

---

## Ortam değişkenleri

Tamamı açıklamalı olarak `.env.example` içindedir. Özet:

| Değişken | Gerekli mi | Açıklama |
|---|---|---|
| `APP_MODE` | — | `local` (varsayılan, yerel demo) / `production` (internete açık; giriş zorunlu) |
| `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY` | production'da zorunlu | Eksikse web ve işleyici **başlamaz** |
| `LOCAL_REQUIRE_LOGIN` | — | Yerel modda da giriş istensin mi |
| `DATABASE_URL`, `TEST_DATABASE_URL` | evet | Test veritabanı adı `test` içermeli (testler onu sıfırlar) |
| `STORAGE_DRIVER`, `LOCAL_STORAGE_DIR`, `S3_*` | — | Depolama |
| `AIOPS_ANTHROPIC_API_KEY` (veya `ANTHROPIC_API_KEY`), `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` | gerçek AI için | Boşsa DEMO modu. Uygulamaya özel ad önceliklidir (Claude Code'un kendi anahtar kullanımıyla çakışmaz). Varsayılan model `claude-opus-5-5` |
| `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_COST_USD` | AI görsel için | Birim fiyat girilmezse maliyet "bilinmiyor" sayılır ve bütçe sınırı varken üretim engellenir |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_API_VERSION` | Shopify için | Dev Dashboard uygulaması |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_GRAPH_VERSION` | Instagram için | Meta uygulaması |
| `PUBLIC_BASE_URL` | OAuth için | Geri dönüş adresi kökü |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `WORKER_POLL_MS`, `MAX_UPLOAD_MB` | — | |

**Önemli:** Claude Code aboneliği bu uygulamanın model kullanımını karşılamaz. Gerçek AI modu için https://console.anthropic.com üzerinden ayrı bir API anahtarı oluşturup `AIOPS_ANTHROPIC_API_KEY` olarak sunucu ortamına eklemeniz gerekir. Claude Code bulut ortamında çalıştırıyorsanız anahtarı ortam ayarlarına (bulut ortam menüsü → Edit → ortam değişkeni) ekleyin; yeni oturumda geçerli olur.

API anahtarları kaynak koda, tarayıcıya veya günlüklere yazılmaz. OAuth/erişim belirteçleri veritabanında AES-256-GCM ile şifreli saklanır; günlük mesajları gizli değer kalıplarına karşı maskelenir.

---

## Veritabanı

- Şema: `migrations/001_init.sql`. Geçişler `schema_migrations` tablosunda izlenir, danışma kilidiyle (advisory lock) tek seferde uygulanır. İşleyici başlarken de eksik geçişleri uygular.
- Başlıca tablolar: `brands`, `brand_facts`, `products`, `product_variants`, `product_facts`, `media_assets`, `media_lineage`, `connections`, `projects`, `chat_messages`, `tasks`, `task_dependencies`, `task_attempts`, `outputs`, `output_versions`, `approvals`, `external_actions`, `calendar_entries`, `cost_entries`, `performance_metrics`, `webhook_events`, `settings`, `audit_log`, `worker_heartbeats`.
- Her marka verisi `brand_id` ile ayrılır; servis katmanındaki tüm sorgular marka filtresi uygular. Panelde marka, sunucu çerezinden okunur — form alanlarından gelen marka kimliğine güvenilmez.

---

## Görev işleyicisi

`npm run worker` ayrı bir süreç olarak çalışır (web uygulaması kapalı olsa bile görevleri işler).

- **Kalıcılık:** Görevler, denemeler (`task_attempts`), çıktı sürümleri ve olaylar veritabanındadır. Tarayıcı kapansa veya işleyici yeniden başlasa kayıtlar korunur.
- **Kiralama:** Görev alındığında 60 sn'lik kiralama verilir ve 10 sn'de bir yenilenir. İşleyici çökerse (kalp atışı 30 sn kesilirse veya kiralama dolarsa) görev otomatik olarak kuyruğa geri alınır ve kaldığı aşamadan (üretim / kalite kontrol) devam eder.
- **Görev durumları:** Planlandı · Hazır · Çalışıyor · Kontrol bekliyor · Onay bekliyor · Tamamlandı · Başarısız · İptal edildi · Bağlantı bekliyor.
- **Sınırlar** (Ayarlar ekranından): eşzamanlı görev, proje başına görev sayısı, proje başına model çağrısı, görev süre sınırı, geçici hatada deneme sayısı (üstel bekleme), çıktı başına yeniden üretim, görev başına ve günlük bütçe. Sonsuz döngü oluşamaz: plan bağımlılıkları yalnızca önceki görevlere işaret edebilir (döngüsüz), kalite kontrol en fazla N kez yeniden üretime gönderir.
- **Durdurma:** "Tüm işlemleri durdur" yeni görev alınmasını keser ve çalışan görevleri iptal sinyaliyle kuyruğa geri bırakır. Görev/proje iptali ve tekrar deneme panelden yapılır.
- `SIGTERM/SIGINT` ile kapanırken çalışan görevler kuyruğa geri bırakılır.

---

## Ajanlar

| Ajan | Görev | Çıktı şeması | Araç izinleri (sunucuda zorunlu) |
|---|---|---|---|
| Ana Yönetici | Talimatı hedef/görevlere ayırır, uzman seçer, bağımlılık/sıra belirler, rapor yazar | `PlanSchema`, proje raporu | brand.read, products.read, tasks.manage, outputs.read, costs.read |
| Pazarlama | Hedef kitle, konumlandırma, kampanya, içerik temaları, reklam önerileri | `StrategySchema` | brand.read, products.read, performance.read |
| Shopify | Ürün açıklaması, koleksiyon, sayfa, bundle; **mevcut ↔ önerilen** karşılaştırma | `ShopifyProposalSchema` | brand.read, products.read, outputs.read, shopify.propose |
| Tasarım | Görsel brief, gönderi/kapak/reklam görseli; bağlı araçla üretim | `DesignBriefSchema` | brand.read, products.read, media.read, outputs.read, image.generate |
| Video | Senaryo, çekim seçimi, kurgu, altyazı; mevcut çekim kurgusu ≠ AI video | `VideoPlanSchema` | brand.read, products.read, media.read, outputs.read, video.edit, video.generate |
| Sosyal medya | Platform açıklamaları, içerik takvimi, yayın paketi, yayın durumu | `SocialPackageSchema` | brand.read, products.read, outputs.read, calendar.write, social.propose |
| Analiz ve kalite | Marka tutarlılığı, ürün bilgisi doğruluğu, kalite, maliyet, performans | `QaReviewSchema` | brand.read, products.read, outputs.read, costs.read, media.read |

Her ajanın görev tanımı, gerekli girdileri, şeması, araç izinleri ve teslim ölçütleri panelde **Ajanlar** ekranında görünür. Hiçbir ajan doğrudan yayın yapamaz veya canlı mağazayı değiştiremez; yalnızca öneri üretir.

**Akış:** talimat → yönetici planı → bağımsız görevler paralel (sınır dahilinde) → her çıktı yeni sürüm olarak kaydedilir → kalite kontrol (her zaman kural tabanlı kontroller + gerçek modda model incelemesi; en kötü sonuç geçerli) → geçemezse geri bildirimle sınırlı yeniden üretim → tasarım/video için render görevleri → Shopify/sosyal çıktılar "Onay bekliyor" → yönetici raporu sohbete yazılır.

**Kural tabanlı kalite kontrolleri** (`src/lib/agents/qa-rules.ts`, her modda gerçek kod): doğrulanmamış iddialar (yüzde, ücretsiz kargo, teslimat süresi, bağış, yorum/puan, satış/popülerlik, garanti/sertifika/sürdürülebilirlik, indirim), kayıtta olmayan fiyat, doğrulanmamış ürün özelliği, yasaklı ifade, içerik dili (en/tr), Shopify "mevcut değer" doğruluğu ve fiyat değişikliği işareti, arşivde olmayan/kullanım hakkı kısıtlı medya, AI görselinin gerçek ürün fotoğrafı gibi sunulması, AI görselinde ürün baskı/renk/kalıp değişimi riski, altyazı zamanlaması, Instagram 2.200 karakter / 30 hashtag sınırı.

Dışarıdan okunan içerik (ürün açıklamaları, medya etiketleri, önceki çıktılar, geri bildirimler) modele `<data>` etiketleri içinde **veri** olarak verilir; sistem istemi bunların talimat olarak izlenmemesini söyler.

---

## Demo akışını deneme

1. `npm run db:migrate && npm run db:seed-demo`, ardından `npm run dev` ve `npm run worker`.
2. http://127.0.0.1:3000 → üst bantta **DEMO modu** etiketi görünür. Marka seçicide "Örnek Marka (DEMO)" seçilidir.
3. **Ana yönetici** ekranına şunu yazın: *"Sample Linen Shirt için lansman hazırla: strateji, ürün sayfası, görseller, kısa video ve sosyal medya paketi."*
4. Birkaç saniye içinde: yönetici planı (DEMO plan etiketiyle) → görev panosunda uzmanlar sırayla/paralel çalışır → rapor sohbete düşer.
5. **İçerik taslakları**: her çıktıda önizleme, kalite raporu, sürümler. Tasarım briefinde gerçek (örnek) fotoğraftan yerelde derlenen görseller; video planında ffmpeg ile render edilmiş dikey video; kapak için AI görseli "Bağlantı bekliyor".
6. Shopify önerisini açın → **Düzenle** → `[DEMO]` işaretlerini kaldırıp kaydedin (yeni sürüm) → **Bu sürümü onayla** → **Shopify'a uygula**: Shopify bağlı olmadığı için işlem yapılmaz ve açık hata gösterilir (sahte başarı yok).
7. Sosyal pakette aynı şekilde düzenle/onayla → **Manuel paket**: medya + açıklama + kapak metni içeren zip indirilir. Onaydan sonra içeriği değiştirirseniz eski onay geçersiz olur.

Örnek marka ve verileri kurgusaldır; görseller "SAMPLE" yazılı yer tutucular, videolar ffmpeg test desenleridir.

---

## Gerçek servisleri bağlama

Tüm bağlantılar **Entegrasyonlar** ekranından yönetilir; durumlar açıkça gösterilir: *Bağlı değil · Test ediliyor · Bağlı · Yetki yenilemesi gerekiyor · Hata · Desteklenmiyor*. Hesap şifresi hiçbir yerde istenmez.

- **Anthropic (gerçek AI):** `.env` içine (veya bulut ortam ayarlarına) `AIOPS_ANTHROPIC_API_KEY` ekleyin, web ve işleyiciyi yeniden başlatın, Entegrasyonlar → *Test et* (ücretsiz model bilgisi okuma). İstekler: structured outputs (JSON şeması), adaptive thinking, `effort`, akış (streaming), reddetmeye karşı sunucu tarafı `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). Maliyet, yanıttaki token kullanımı × fiyat tablosuyla hesaplanır (`src/lib/models/anthropic.ts`).
- **Shopify:** Shopify Dev Dashboard'da kendi organizasyonunuzda bir uygulama oluşturup mağazanıza kurun (gerekli kapsamlar: en az `read_products`, `write_products`). `SHOPIFY_CLIENT_ID/SECRET` tanımlayın, Entegrasyonlar'da mağaza alanını (`magaza.myshopify.com`) girip *Bağlan ve test et*. Belirteç **client credentials grant** ile alınır (24 saat geçerli, otomatik yenilenir). Ardından Ürünler → *Shopify'dan aktar*. Canlıya yazma: `productUpdate`, fiyatlar için `productVariantsBulkUpdate`, koleksiyonlar için `collectionCreate` + `collectionAddProducts`. Webhook adresi: `/api/webhooks/shopify` (HMAC doğrulamalı).
  - Not: client credentials yalnızca uygulama ile mağaza aynı Shopify organizasyonundaysa çalışır. Başka mağazalar için yetkilendirme kodu (OAuth) akışı eklenmelidir.
- **Instagram:** Meta'da uygulama oluşturun, *Instagram API with Instagram Login* ürününü ekleyin, geri dönüş adresi olarak `PUBLIC_BASE_URL/api/integrations/instagram/callback` girin, `INSTAGRAM_APP_ID/SECRET` tanımlayın, *Instagram ile bağlan*. Gerekli izinler `instagram_business_basic`, `instagram_business_content_publish`; hesap Business/Creator olmalı ve canlı kullanım için uygulama incelemesi gerekebilir. Instagram medyayı herkese açık URL'den çektiği için `STORAGE_DRIVER=s3` gerekir (imzalı URL üretilir). Yayın: konteyner → `status_code` FINISHED → `media_publish`.
- **TikTok:** Doğrudan yayın, TikTok uygulama denetimi gerektirir (denetimsiz istemciler yalnızca gizli yayın yapabilir). Bu sürümde "Desteklenmiyor"; bunun yerine **manuel yayın paketi** (video + açıklama + kapak metni, zip) üretilir.
- **AI görsel (OpenAI Images):** `OPENAI_API_KEY` ve görsel başına birim fiyat `OPENAI_IMAGE_COST_USD`; *Test et* → Bağlı. Ardından "Bağlantı bekleyen görevleri tekrar dene".
- **AI video üretimi / Meta reklam ve performans:** Adaptör arayüzü var, somut sağlayıcı yok → "Desteklenmiyor".
- **S3:** `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, gerekirse `S3_ENDPOINT` (R2/MinIO), erişim anahtarları.

Entegrasyon kodu yazılırken resmi belge siteleri (shopify.dev, developers.facebook.com, developers.tiktok.com) bu geliştirme ortamının ağ politikası nedeniyle doğrudan açılamadı; uç noktalar resmi sayfalara yönlendiren web aramasıyla kontrol edildi. Canlıya almadan önce güncel resmi belgelerle bir kez daha doğrulayın (özellikle `SHOPIFY_API_VERSION` ve `INSTAGRAM_GRAPH_VERSION`).

---

## Özellik durumu

### Gerçekten çalışan (bu ortamda test edildi)
- PostgreSQL şeması/geçişleri, çoklu marka, marka/ürün/varyant/doğrulanmış özellik/karar kayıtları, bilinmeyen alanların "Bilinmiyor" gösterimi
- Ayrı süreçte kalıcı görev işleyicisi: bağımlılıklar, paralellik sınırı, kiralama kurtarma (gerçek `kill -9` ile denendi), duraklatma, iptal, tekrar deneme, sınırlı yeniden üretim, model çağrısı/süre/bütçe sınırları
- Çıktı sürümleri, yapılandırılmış düzenleyici, sürüm + içerik hash'ine bağlı onay, onay geri alma, ret, yeniden üretim isteği
- Sunucu tarafı dış işlem kapısı: onay/kapsam/sürüm kontrolü, DEMO içerik engeli, idempotency anahtarı + aynı sürüm/hedef tekilleştirme, bağlantı yoksa hata, belirsiz sonuçta tekrar göndermeme ve kullanıcı ile mutabakat
- Medya arşivi: içerik baytından tür tespiti, boyut sınırı, SHA-256 ile tekrar algılama, meta veriler, kullanım hakkı, kullanım geçmişi, kullanıcı etiket düzeltme, gerçek/AI/düzenlenmiş köken ayrımı, kaynak→türev ilişkisi, orijinallerin korunması
- Yerel görsel derleme (sharp): gerçek ürün fotoğrafı kırpılmadan ve rengi değiştirilmeden marka zeminine yerleştirilir
- Yerel video kurgu (ffmpeg): arşiv çekimlerinden kırpma, birleştirme, 9:16'ya ölçekleme, SRT altyazı yakma
- Kural tabanlı kalite kontrolleri, maliyet kayıtları (tahmini ve gerçekleşen ayrı; bilinmeyen ≠ 0; AI ↔ reklam ayrımı), raporlar, işlem geçmişi
- Manuel yayın paketi (zip), yayın takvimi
- Türkçe mobil uyumlu panel; production modunda zorunlu giriş, eksik güvenlik ayarlarında başlamama, CSRF köken kontrolü, güvenlik başlıkları

### Demo olan
- Model anahtarı yokken **tüm ajan metin çıktıları** kural tabanlı şablonlardır (`src/lib/models/demo.ts`). `DEMO` etiketiyle gösterilir, `is_demo=true` kaydedilir ve **dış platforma gönderilemez**. Demo planlayıcı talimattaki anahtar kelimelere göre görev seçer; demo kalite incelemesi model incelemesi yapmaz (kural tabanlı kontroller yine çalışır).
- Örnek marka, ürünler ve medya kurgusaldır.

### Bağlantı bekleyen (kod hazır, gerçek servisle test edilmedi)
- Anthropic gerçek AI modu ve AI medya etiketleme (sahte SSE yanıtlarıyla test edildi)
- Shopify okuma/yazma (sahte HTTP ile test edildi), Shopify webhook
- Instagram OAuth ve yayın, Meta webhook
- OpenAI Images ile AI kampanya görseli
- S3 depolama

### Desteklenmiyor (bu sürümde)
- TikTok otomatik yayını (manuel paket var), AI video üretimi sağlayıcısı, Meta reklam başlatma/bütçe ve performans verisi okuma, Shopify sayfa ve bundle oluşturma (öneri olarak sunulur), zamanlanmış otomatik yayın

---

## Güvenlik ve güvenilirlik

- **Onay sunucuda zorunlu:** `src/lib/services/gateway.ts` — yayın, canlı mağaza, fiyat değişikliği (ayrı `price_change` kapsamı), reklam. Ajan talimatlarına güvenilmez; gerekli kapsamlar içerikten sunucu tarafından hesaplanır.
- **Onay sürüme bağlı:** onay, sürüm kimliği ve kanonik JSON'un SHA-256 hash'iyle saklanır. Düzenleme yeni sürüm oluşturur; eski onay yeni sürümü kapsamaz, eski sürüm artık güncel olmadığı için onunla da işlem yapılamaz.
- **Çift işlem yok:** talimat gönderimleri ve dış işlemler idempotency anahtarı taşır (form başına benzersiz); ayrıca aynı sürüm + hedef için ikinci işlem oluşturulmaz.
- **Belirsiz sonuç:** yazma isteğinde ağ hatası/5xx olursa işlem "Sonuç belirsiz" olarak kalır; kullanıcı platformda kontrol edip işaretleyene kadar tekrar gönderilmez.
- **Geçici hatalar:** sınırlı sayıda, üstel beklemeyle tekrar denenir; kalıcı hatalar (401/400, reddetme) tekrar denenmez.
- **Marka ayrımı:** tüm servis fonksiyonları `brandId` ister; dosya sunumu, dışa aktarma ve onaylar marka kontrolü yapar. Testlerle doğrulandı.
- **Ajan araç izinleri:** `assertTool()` ile sunucu kodunda kontrol edilir.
- **Dosyalar:** SVG/PSD indirme olarak ve `sandbox` CSP ile sunulur; tür baytlardan tespit edilir.
- **Kimlik doğrulama:** `APP_MODE=production` iken tüm panel ve API (webhook'lar hariç; onlar imzayla doğrulanır) imzalı, `httpOnly`, `secure` oturum çerezi ister. Yerel mod yalnızca `127.0.0.1`'e bağlanır. **Uygulama hiçbir yere yayınlanmadı.**
- **Gizli bilgiler:** `.env` git'e eklenmez; `.env.example` boş alanlar içerir.

---

## Test sonuçları

`npm test` (vitest, gerçek PostgreSQL `aiops_test` veritabanı, gerçek ffmpeg/sharp, harici servis yok):

```
tests/launch-flow.test.ts       4 test   Örnek ürün lansmanı uçtan uca
tests/safety.test.ts           15 test   Onay, tekrar, bütçe, sınırlar, bağlantı, marka ayrımı, medya, işleyici yeniden başlatma
tests/integrations.test.ts      6 test   Shopify (sahte HTTP), belirsiz sonuç, fiyat onayı, webhook imzaları, QA kuralları
tests/anthropic-adapter.test.ts 3 test   Anthropic istek biçimi, akış, maliyet, hata sınıflandırma (sahte SSE)
Toplam: 28/28 geçti
```

Kabul ölçütleri → test:

| Ölçüt | Sonuç |
|---|---|
| Kullanıcı talimat verir, yönetici görev oluşturur | ✅ `launch-flow` |
| Uzmanlar doğru sırada çalışır (strateji → içerik → sosyal) | ✅ zaman damgalarıyla doğrulandı |
| Çıktılar kaydedilir, kalite kontrolü yapılır | ✅ |
| Kullanıcı düzenleyip onaylar, onay doğru sürümle eşleşir | ✅ |
| Uygulama yeniden açıldığında kayıtlar korunur | ✅ yeni bağlantı havuzuyla okundu |
| Onaysız dış işlemler engelleniyor mu | ✅ engelleniyor, denetim kaydına yazılıyor |
| Değiştirilen içerik eski onayla yayınlanabiliyor mu | ✅ hayır |
| Tekrarlanan istek çift işlem oluşturuyor mu | ✅ hayır (aynı anahtar eşzamanlı dahil) |
| Bütçe sınırı uygulanıyor mu | ✅ görev başına, günlük ve bilinmeyen maliyet |
| Bağlantısı olmayan servis sahte başarı veriyor mu | ✅ hayır |
| Marka verileri ayrılmış mı | ✅ |
| İşleyici yeniden başladığında görevler devam ediyor mu | ✅ test + gerçek `kill -9` denemesi |

Ek olarak tarayıcıda (Playwright, masaüstü ve 390 px mobil) tüm ekranlar açıldı, demo akışı panelden yürütüldü ve mobil yatay taşma kontrol edildi. Üretim modu: eksik `ADMIN_PASSWORD` ile sunucu başlamadı; oturumsuz panel `/login`'e yönlendi, API 401, imzasız webhook 401 döndü; giriş sonrası çerez `httpOnly` + `secure`.

**Gerçek servis testi yapılmadı:** Anthropic, Shopify, Instagram, OpenAI Images ve S3 bu ortamda gerçek anahtar/hesap olmadan yalnızca sahte yanıtlarla test edildi.

---

## Bilinen sınırlamalar

- DEMO çıktıları şablondur; içerik kalitesi gerçek AI modunu temsil etmez.
- İçerik dili otomatik kontrolü yalnızca İngilizce ve Türkçe için yapılır; diğer dillerde "belirlenemedi" uyarısı verilir.
- Kural tabanlı iddia taraması kalıp tabanlıdır; yanlış pozitif/negatif olabilir. Gerçek modda model incelemesiyle birleştirilir; son karar kullanıcı onayıdır.
- AI görsellerinde ürünün baskı/renk/kalıp değişimi otomatik görsel karşılaştırmayla tespit edilmez; risk işaretlenir ve insan kontrolü istenir.
- Instagram yayını S3 depolama gerektirir; carousel ve hikâye dışı formatlar sınırlıdır. TikTok için yalnızca manuel paket vardır.
- Shopify için yalnızca client credentials (aynı organizasyon) desteklenir; sayfa/bundle canlıya yazılmaz.
- Takvim bir plandır; gönderiler otomatik zamanlanmaz.
- Panelde tek yönetici hesabı vardır (çok kullanıcılı rol sistemi yok).
- Render görevi ortasında kesilirse yeniden çalıştırılır; yerel derleme/ffmpeg çıktıları SHA-256 ile tekilleşir, ancak AI görsel üretimi yeniden ücret doğurabilir.
- Görsel önizlemede küçük resim (thumbnail) üretilmez; orijinal dosya sunulur.

---

## FriBee'yi sisteme ekleme

FriBee için bu depoda hiçbir bilgi uydurulmadı. Adımlar:

1. **Marka yönetimi → Yeni marka:** adı "FriBee" girin. Yalnızca **doğruladığınız** bilgileri doldurun (hikâye, hedef kitle, ton, renkler `Ad, #hex`, yazı tipleri, gönderim, iade, kampanya kuralları). Boş bırakılan her alan ajanlara "BİLİNMİYOR" olarak gider ve uydurulmaz. Müşteriye yönelik içerik dilini seçin (varsayılan İngilizce).
2. **Kararlar ve yasaklı ifadeler:** marka sayfasında onayladığınız kararları (ör. "İndirimler yalnızca onayla") ve asla kullanılmayacak ifadeleri ekleyin.
3. **Ürünler:** Shopify bağlıysa *Shopify'dan aktar*; değilse manuel ekleyin. Her ürün için kumaş, kalıp, baskı tekniği gibi özellikleri kaynağıyla **Doğrulandı** olarak girin; emin olmadıklarınızı **Doğrulanmadı** işaretleyin (müşteri metninde kullanılmaz).
4. **Medya arşivi:** gerçek ürün fotoğraflarını "Gerçek ürün fotoğrafı", çekimleri "Gerçek çekim", logoyu tür "Logo" olarak yükleyin; ürün, tema, çekim tipi ve kullanım hakkını işaretleyin. Ardından marka sayfasında logoyu seçin.
5. **Entegrasyonlar:** sunucu ortamına `AIOPS_ANTHROPIC_API_KEY` (gerçek AI), `SHOPIFY_CLIENT_ID/SECRET` (FriBee mağazası ile aynı Shopify organizasyonunda oluşturulmuş uygulama), isteğe bağlı Instagram ve S3 ayarlarını ekleyin; panelden test edin.
6. **Ayarlar:** görev başına ve günlük bütçeyi belirleyin.
7. İnternete açacaksanız `APP_MODE=production`, güçlü `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY` ve HTTPS arkasında çalıştırın. (Bu depo uygulamayı hiçbir yerde yayınlamaz.)
8. **Ana yöneticiye** ilk talimatı verin ve çıktıları onay merkezinden inceleyin.
