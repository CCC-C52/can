# İşletim kılavuzu

Bu belge kurulum, yapılandırma, test, dağıtım, geri alma ve günlük işletimi tek yerde toplar.
Canlı kurulumun adım adım anlatımı: [`DEPLOY.md`](DEPLOY.md) · mühendislik raporu ve özellik durumları: [`ENGINEERING_REPORT.md`](ENGINEERING_REPORT.md).

---

## 1. Yerel kurulum

Gereksinimler: Node.js 22+, PostgreSQL 14+ (16 ve 17 ile çalışır), ffmpeg + ffprobe (6.x ile test edildi), DejaVu yazı tipleri (görsel derleme ve altyazı).

```bash
npm install
cp .env.example .env                       # değerleri doldurun; .env git'e eklenmez
sudo -u postgres psql -c "create user aiops with password 'aiops' createdb;"
sudo -u postgres psql -c "create database aiops owner aiops;"
sudo -u postgres psql -c "create database aiops_test owner aiops;"
npm run db:migrate
npm run dev        # panel  http://127.0.0.1:3000
npm run worker     # görev işleyicisi (ayrı terminal) — görevler, yükleme doğrulama, medya analizi, yedekleme
```

## 2. Ortam değişkenleri

Tam liste ve açıklamalar `.env.example` içindedir. Gizli değerler yalnızca sunucu ortamında tutulur; tarayıcı paketine girmez (HTTP güvenlik testi istemci paketlerini tarar).

| Grup | Değişkenler | Zorunluluk |
|---|---|---|
| Mod | `APP_MODE` (`local`/`production`), `LOCAL_REQUIRE_LOGIN` | production'da giriş zorunlu, DEMO kapalı |
| Güvenlik | `ADMIN_PASSWORD` (≥12), `SESSION_SECRET` (≥32), `ENCRYPTION_KEY` (≥32) | production'da zorunlu; eksikse süreç başlamaz |
| Veritabanı | `DATABASE_URL`, `TEST_DATABASE_URL` (adı `test` içermeli) | zorunlu |
| Depolama | `STORAGE_DRIVER` (`local`/`s3`), `LOCAL_STORAGE_DIR`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | production'da `s3` zorunlu |
| Yükleme | `MAX_UPLOAD_MB` (vars. 2048), `UPLOAD_DIRECT` (`true` = tarayıcıdan doğrudan S3/R2'ye imzalı parça; kovada CORS gerekir) | — |
| Metin modeli | `AIOPS_ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (vars. `claude-opus-5-5`), `ANTHROPIC_EFFORT` | yoksa yerelde DEMO, canlıda "Bağlantı bekliyor" |
| AI görsel | `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL` (vars. `gpt-image-1`), `OPENAI_IMAGE_COST_USD` | isteğe bağlı |
| AI video | `GEMINI_API_KEY`, `VEO_MODEL` (vars. `veo-3.1-fast-generate-preview`), `VEO_COST_PER_SECOND_USD` | isteğe bağlı |
| Mağaza/sosyal | `SHOPIFY_CLIENT_ID/SECRET`, `SHOPIFY_API_VERSION`, `INSTAGRAM_APP_ID/SECRET`, `INSTAGRAM_GRAPH_VERSION`, `PUBLIC_BASE_URL` | isteğe bağlı |
| Web araştırması | `FIRECRAWL_API_KEY`, `FIRECRAWL_CREDIT_USD` | isteğe bağlı, ücretli; ayrıca Maliyet Yönetimi'nde açılmalı |
| Telemetri | `POSTHOG_API_KEY`, `POSTHOG_HOST` (vars. `https://eu.i.posthog.com`) | isteğe bağlı; boşsa hiçbir veri gönderilmez |
| Yedekleme | `BACKUP_S3_BUCKET`, `BACKUP_HOUR_UTC`, `BACKUP_RETENTION_DAYS` | canlıda önerilir |
| İşletim | `FFMPEG_PATH`, `FFPROBE_PATH`, `FFMPEG_THREADS` (vars. 2), `WORKER_POLL_MS`, `LOG_LEVEL` (`debug`) | — |

## 3. Sağlayıcı kimlik bilgileri

Anahtarlar sohbete, koda veya panele yazılmaz; sağlayıcının konsolunda üretilip barındırıcının ortam değişkeni ekranına girilir. Ardından **Entegrasyonlar → Test et** (ücretsiz uçlar: model bilgisi okuma).

| Sağlayıcı | Nereden | Not |
|---|---|---|
| Anthropic | console.anthropic.com → API Keys | Konsolda aylık harcama sınırı koyun |
| OpenAI Images | platform.openai.com → API keys | Görsel başına güncel fiyatı `OPENAI_IMAGE_COST_USD` olarak girin |
| Google Veo | aistudio.google.com → API keys (Gemini API, faturalandırma açık proje) | Saniye fiyatını `VEO_COST_PER_SECOND_USD` olarak girin; üretilen video sağlayıcıda kısa süre tutulur, uygulama hemen indirir |
| Cloudflare R2 | R2 → Manage API tokens (yalnızca ilgili kovalar, Object Read & Write) | |

Birim fiyat girilmeyen ücretli servis, bütçe sınırı etkinken **çalıştırılmaz** (maliyet bilinmiyor ≠ 0).

## 4. Veritabanı ve geçişler

- Geçişler: `migrations/*.sql`, `npm run db:migrate`. `schema_migrations` tablosu ve danışma kilidiyle tek seferde uygulanır; işleyici de başlarken eksikleri uygular.
- `002_media_jobs_integrity.sql` yalnızca **ekleme** yapar (tablo, sütun, indeks, `NOT VALID` kısıtlar, tetikleyiciler) ve türetilmiş medya için köken/yöntem/proje sütunlarını doldurur. Mevcut satır silinmez. Temiz ve 001 fikstürlü veritabanında test edilir (`tests/migrations.test.ts`).
- `003_brand_memory_research.sql` yalnızca **ekleme** yapar: `brand_memory`, `research_runs`, `research_sources` tabloları (araştırma kaynağı bileşik yabancı anahtarla yalnızca kendi markasının çalıştırmasına bağlanır). Mevcut tablo ve veri değişmez.
- **Dikkat:** Render'da `preDeployCommand: npm run db:migrate` ve işleyicinin başlangıcı eksik geçişleri **otomatik uygular**. Üretimde uygulama önce `migrations/policy.json` politikasını denetler. 003 gibi sahip onayı gerektiren bir geçiş yalnızca aiops-web ortamında `AIOPS_AUTHORIZED_MIGRATIONS` bu adı içeriyorsa uygulanır; aksi halde ön dağıtım başarısız olur ve Render önceki sürümü canlı tutar (ayrıntı: [`RELEASE.md`](RELEASE.md#3-geçiş-güvenliği)). Web servisi geçiş uygulanmadan çalışırsa Marka Hafızası, Araştırma Merkezi ve Maliyet Yönetimi sayfaları hata verir. Render'da ortam değişkeni eklerken yalnızca **"Save only"** seçin; diğer seçenekler hemen dağıtım başlatır.
- Bütünlük denetimi (salt okunur): `npm run db:check` — markalar arası ilişki, sahipsiz kayıt, takılı kiralama vb.
- Onay kayıtları değiştirilemez (tetikleyici): yalnızca `revoked_at` bir kez doldurulabilir.

## 5. İşleyici ve kuyruklar

Tek süreç (`npm run worker`) dört kuyruğu işler; hepsi PostgreSQL'dedir (ayrı kuyruk servisi yok):

| Kuyruk | Tablo | Kurtarma |
|---|---|---|
| Görevler | `tasks`, `task_attempts` | Kiralama 60 sn, 10 sn'de yenilenir; süresi dolan görev yeniden kuyruğa alınır. Kiralaması elinden alınan işleyici sonuç **yazamaz** (aynı işlemde sahiplik kontrolü) |
| Yükleme doğrulama | `upload_sessions` | Durum `_sha256` ile kaldığı yerden; 24 saat tamamlanmayan oturum iptal edilir |
| Medya analizi | `media_analyses` | Kiralamalı; aynı dosya + sürüm + model için tekrar işlenmez |
| AI üretim işleri | `provider_jobs` | Öğe başına tek kayıt; yeniden başlatmada sağlayıcıdan durum sorgulanır, gönderim sırasında yarıda kalan iş "sonuç bilinmiyor" olur ve otomatik tekrar gönderilmez |

Sınırlar **Ayarlar** ekranındadır: eşzamanlı görev, proje başına görev ve model çağrısı, görev süresi, deneme sayısı, yeniden üretim, görev/günlük bütçe, bilinmeyen maliyet engeli, **ücretli AI medya üretimi izni** (varsayılan kapalı), proje başına AI video saniyesi.

Hata sınıfları ve önerilen eylem her görevde gösterilir: geçici, süre aşımı, kalıcı, yetki, bütçe, bağlantı, kalite, bağımlılık, iptal, sonuç belirsiz. Kalıcı/yetki/bütçe/belirsiz sınıfları projeyi "Engellendi" yapar.

## 6. ffmpeg

- Video analizi (sahne, kare, hareket, ses) ve kurgu (bölüm seçme, fit/fill, kesme/xfade geçiş, giriş/kapanış kartı, alt altyazı ve üst ekran metni, kapak karesi) yerel ffmpeg ile yapılır; AI değildir.
- Tüm çağrılar argüman dizisiyle (`execFile`, kabuk yok) ve `-protocol_whitelist file,pipe` ile yapılır.
- Bellek: 1080x1920, 5 bölüm + geçiş kurgusunda ffmpeg tepe ~440 MB ölçüldü (`FFMPEG_THREADS=2`). 512 MB'lık işleyicide video kurgusu bellek yetersizliğiyle sonlanabilir; 2 GB önerilir.
- Ses kurguda kaldırılır (müzik/ses lisansı manuel karar).

## 7. Nesne depolama

- Yüklenen orijinaller `brands/<marka>/originals/<sha256>.<uzantı>`; türetilmiş dosyalar `brands/<marka>/derived/…`; analiz kareleri `brands/<marka>/analysis/<analiz>/frame-N.jpg`. Orijinallerin üzerine yazılmaz.
- Kovalar özel olmalıdır; dosyalar yalnızca oturum açmış kullanıcıya uygulama üzerinden, marka kontrolüyle ve bayt aralığı destekli akışla sunulur.
- Kapsayıcı diski kalıcı değildir: canlıda `STORAGE_DRIVER=s3` zorunludur. Geçici dosyalar (`os.tmpdir()`) iş bitince silinir; 2 GB'lık bir videonun doğrulaması dosya boyutu kadar geçici disk kullanır.

## 8. Medya yükleme sınırları ve desteklenen biçimler

| | |
|---|---|
| En büyük dosya | `MAX_UPLOAD_MB` (vars. 2048 MB); parça boyutu 8 MiB, 3 paralel parça, parça başına 4 deneme |
| Sürdürme | Aynı dosya tekrar seçilirse yalnızca eksik parçalar gönderilir |
| Doğrulama | Tür **baytlardan** belirlenir (uzantıya güvenilmez), SHA-256 ile tekrar algılanır |
| Görsel | JPEG, PNG, WebP, GIF; SVG ve PSD yalnızca tasarım dosyası olarak (indirme, önizleme yok) |
| Video | MP4, MOV (QuickTime), WebM |
| Belge | PDF |
| Eski uç | `/api/media/upload` tek parça, 20 MB |

## 9. Testler

| Komut | Ne yapar | Gereken |
|---|---|---|
| `npm test` | Birim + entegrasyon (izinler, geçişler, analiz, yükleme, derleme, video hattı + gerçek MP4, sağlayıcı sahteleri, istem önbelleği, marka hafızası, araştırma, telemetri, kabul akışı, güvenlik) | PostgreSQL `aiops_test`; S3 testleri için `TEST_S3_ENDPOINT` (ör. moto/MinIO) |
| `npm run test:http` | Üretim derlemesine karşı HTTP güvenlik kontrolleri (oturum, markalar arası erişim, sunucu eylemi kurcalama, istemci paketinde gizli değer) | `npm run build`, PostgreSQL, `TEST_S3_ENDPOINT`, Chromium |
| `npm run test:a11y` | axe-core WCAG 2.1 A/AA taraması, masaüstü + telefon, yatay taşma | Çalışan panel (`A11Y_BASE`), Chromium |
| `npm run test:e2e` | Tarayıcıdan uçtan uca: menü, Marka Hafızası, Araştırma durumu, Video Stüdyosu → işleyici → ffmpeg MP4 → indirme + ffprobe → onay | Çalışan panel (`E2E_BASE`), **yerel** veritabanı, ffmpeg; işleyiciyi betik başlatır. Model anahtarı yoksa DEMO üretici |
| `npm run acceptance -- --brand <slug>` | 24 adımlık kabul akışı gerçek marka verisinde | Yalnızca yetkili **kopya** veritabanı; `ACCEPTANCE_CONFIRM_COPY=yes`; `APP_MODE≠production` |
| `npm run test:live` | Sağlayıcı başına tek ücretli canlı çağrı | Aşağıya bakın |
| `npm run typecheck` | TypeScript | — |

Sahte (mock) sağlayıcı testleri hiçbir zaman "canlı başarı" olarak raporlanmaz.

## 10. Canlı entegrasyon testleri (ücretli, isteğe bağlı)

```bash
LIVE_TESTS=1 LIVE_BILLABLE_AUTHORIZED=yes \
LIVE_DATABASE_URL=postgres://…/aiops_live_test LIVE_MAX_USD=2 \
npm run test:live -- image video        # veya text / image / video
npm run test:live -- --cleanup          # test markalarını ve dosyalarını siler
```

Koşullar: sahibin açık ücretli test izni, yalıtılmış veritabanı (adı `live`/`test` içerir), tanımlı birim fiyatlar ve bütçe üst sınırı; `APP_MODE=production` iken çalışmaz. Sonuç `data/live-results/<zaman>.json` dosyasına `LIVE` etiketiyle yazılır (sağlayıcı, model, istek zamanı, iş kimliği, durum, çıktı kimliği, maliyet, doğrulama).

## 11. Dağıtım

**Otomatik sürüm hattı:** canlıya alma GitHub Actions "Release" iş akışıyla yapılır — mimari, gerekli gizli değerler, geçiş/yedek kapıları, ilk etkinleştirme ve elle kurtarma: [`RELEASE.md`](RELEASE.md). Hat etkinleştirilene kadar (veya istisnai durumda) aşağıdaki elle süreç geçerlidir.

Ayrıntılı ilk kurulum: `DEPLOY.md`. Elle güncelleme kontrol listesi:

1. **Otomatik dağıtım kapalı mı?** Render → `aiops-web` ve `aiops-worker` → Settings → Auto-Deploy = **Off**; Blueprint → Auto Sync = **Off**. (`render.yaml`'da `autoDeployTrigger: off` vardır; Render'ın bilinen bir sorunu nedeniyle panel ayarı da kapatılmalıdır.)
2. Yerelde: `npm run typecheck && npm test && npm run build && npm run test:http`.
3. Render → `aiops-db` → **Recovery** ekranında son PITR zamanını not edin; panelde **Ayarlar → Şimdi yedekle** (R2 dökümü).
4. Panelde **Tüm işlemleri durdur** (çalışan görevler kuyruğa döner).
5. Render → `aiops-web` → **Manual Deploy → Deploy latest commit** (ön dağıtım komutu geçişleri uygular), ardından `aiops-worker` için aynısı. Web ve işleyici aynı commit'te olmalıdır.
6. Dağıtım sonrası doğrulama (aşağıdaki 14 madde) → **İşlemleri devam ettir**.

**Dağıtım sonrası doğrulama:** (1) `/api/health` 200; (2) Sistem durumu → Veritabanı "Çalışıyor", geçişler n/n; (3) İşleyici canlı; (4) Depolama erişilebilir; (5) çıkış yapıp giriş; (6) FriBee markası ve ürünleri görünüyor; (7) küçük bir görsel yükle; (8) görsel analizi tamamlanıyor; (9) kısa bir video yükle, analiz kareleri görünüyor; (10) "yalnızca kısa strateji" görevi tamamlanıyor; (11) çıktı sayfası ve sürümleri açılıyor; (12) bir sürümü reddet → revizyon → onayla; (13) bilerek hatalı bir işlem (ör. bağlı olmayan Shopify'a uygula) açık hata mesajı ve istek kimliği veriyor; (14) ikinci bir test markası seçiliyken FriBee dosya adresi 404 dönüyor.

## 12. Geri alma

| Durum | İşlem |
|---|---|
| Yeni kod hatalı, şema sorunsuz | Render → servis → **Events** → önceki başarılı dağıtım → **Rollback** (web ve işleyici ikisi de). 002 geçişi yalnızca ekleme yaptığından önceki kod yeni şemayla çalışır. |
| Veri bozuldu | Önce **Tüm işlemleri durdur**. Render Postgres **Recovery** (PITR, yeni veritabanı oluşturur) → doğrula → servislerin `DATABASE_URL` değerini yeni veritabanına çevir. Alternatif: `RESTORE_CONFIRM=evet npm run db:restore -- latest` (R2 dökümü). |
| Medya kaybı | `RESTORE_CONFIRM=evet npm run db:restore -- media` (R2 yedek kovasından) |
| Ücretli üretim istenmeden açıldı | Ayarlar → "Ücretli AI medya üretimi" kapat; sağlayıcı konsolunda anahtarı iptal et |

Geçişler geri alınmaz (aşağı geçiş yok); 002 ekleme yaptığı için geri almaya gerek duyulmaz.

## 13. Maliyet kontrolleri

- Her ücretli çağrıdan **önce** tahmini maliyet görev ve günlük bütçeyle karşılaştırılır; aşılacaksa çağrı yapılmaz ("Bütçe/sınır", proje engellenir).
- Tahmini ve gerçekleşen tutarlar ayrı kaydedilir; bilinmeyen tutar "bilinmiyor" gösterilir, 0 sayılmaz. Çıktı sayfasında servis başına maliyet tablosu vardır.
- AI görsel/video üretimi ayrıca sahip iznine bağlıdır (varsayılan kapalı) ve proje başına video saniyesi sınırlıdır.
- Sonucu belirsiz ücretli gönderim otomatik tekrarlanmaz; sahip "Yeniden gönder" demeden yeni ücret oluşmaz.
- **Maliyet Yönetimi** (`/maliyet`): sağlayıcı başına aylık (UTC takvim ayı) USD sınırı (`anthropic`, `openai_images`, `video_generation`, `firecrawl`); aşılacaksa çağrı yapılmaz. Web araştırması izni ve aylık kredi sınırı da buradadır.
- Anthropic istem önbelleği: sistem istemi + marka bağlamı önbellekten okunduğunda giriş maliyeti düşer; `cost_entries.units` içinde `cache_read_input_tokens` / `cache_creation_input_tokens` kaydedilir ve Maliyet Yönetimi'nde isabet oranı gösterilir.
- Gerçekleşen tutarlar sağlayıcı faturasıyla doğrulanmaz (sağlayıcının bildirdiği kullanım × fiyat tablosu veya girilen birim fiyat).

## 14. Marka ekleme

README'deki "FriBee'yi sisteme ekleme" bölümüne bakın. Özet: yalnızca doğrulanmış bilgiler, ürün özellikleri kaynağıyla "Doğrulandı", gerçek fotoğraf/çekimler doğru kökenle, logo "Logo" türüyle (PNG/JPEG/WebP; derlemelerde otomatik kullanılır). Boş alanlar ajanlara "BİLİNMİYOR" olarak gider.

## 15. Sağlayıcı sınırlamaları

- **Anthropic:** model ve fiyat `src/lib/models/anthropic.ts`; görüntü girdisi en uzun kenar 1568 px'e küçültülür.
- **OpenAI Images:** referanslı üretim `/v1/images/edits` (en fazla 4 referans; `input_fidelity=high`). Ürünün birebir korunması garanti edilmez; AI görseli "gerçek ürün fotoğrafı değil" etiketiyle kaydedilir.
- **Google Veo:** video başına 4–8 sn, 720p, 9:16 veya 16:9; uzun süren işlem (dakikalar). İçerik filtresi reddi kesin başarısızlıktır. Sağlayıcıdaki dosya kısa süre tutulur.
- **OpenAI Sora/Videos API** kapatıldığı için kullanılmadı.
- **TikTok:** otomatik yayın yok (manuel paket). **Meta reklam/performans:** yok.

## 16. Sorun giderme

| Belirti | Bakılacak yer |
|---|---|
| Panelde hata ve "istek kimliği" | Render günlüğünde `requestId` ile arayın (JSON günlük satırları) |
| Görev "Sürüyor: AI video…" uzun süre | Çıktı sayfası → AI üretim işleri (sorgu sayısı); 30 dk sonra iş başarısız sayılır |
| Görev "Sonuç belirsiz" | Sağlayıcı konsolunda işin ücretlendirilip ücretlendirilmediğini kontrol edin → çıktı sayfasında "Yeniden gönder" veya bırakın |
| "Ücretli AI medya üretimi Ayarlar'da kapalı" | Bilinçli koruma; Ayarlar'dan açın |
| Video render bellek hatası | İşleyiciyi 2 GB plana alın veya `FFMPEG_THREADS=1` |
| Yükleme "Doğrulanıyor"da kalıyor | İşleyici çalışıyor mu (Sistem durumu) |
| Sistem durumu "Veri bütünlüğü: Dikkat" | `npm run db:check` çıktısı; sorunlu satır kimlikleri listelenir |

## 17. Güvenlik varsayımları

- Tek sahip hesabı; çok kullanıcılı rol sistemi yoktur. Marka seçimi çerezle yapılır; tüm veri erişimi sunucuda marka kimliğiyle filtrelenir (istemciden gelen marka/kayıt kimliklerine güvenilmez).
- HTTPS'yi barındırıcı sağlar; uygulama HSTS ve `__Host-` önekli `Secure` çerez kullanır.
- Webhook'lar imzayla doğrulanır; diğer tüm uçlar oturum ister.
- Ajan çıktıları ve dış içerik veridir, talimat değildir; dış platform işlemleri sunucudaki onay kapısından geçer.
- Sağlayıcı API anahtarları yalnızca sunucu ortam değişkenlerindedir; OAuth belirteçleri veritabanında AES-256-GCM ile şifrelidir.

## 18. Veri saklama

| Veri | Süre |
|---|---|
| Orijinal medya ve türetilmiş dosyalar | Silinmez (elle silinene kadar) |
| Analiz kareleri | Silinmez |
| Yarım yükleme oturumları | 24 saat sonra iptal, parçalar silinir |
| Çıktı sürümleri, onay/ret kayıtları, denetim günlüğü | Silinmez (onaylar değiştirilemez) |
| AI üretim işi kayıtları | Silinmez (maliyet ve denetim için) |
| Veritabanı dökümleri (R2) | `BACKUP_RETENTION_DAYS` (vars. 14 gün) |
| Render PITR | Çalışma alanı planına göre (Hobby: 3 gün) |
| Canlı test sonuçları | `data/live-results/` (yerel, git dışı) |
