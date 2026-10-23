# Canlı kurulum: Render + Cloudflare R2

Bu belge, AI Operations Studio'yu **yalnızca sizin giriş yapabileceğiniz**, HTTPS'li ve kalıcı bir bulut ortamına kurmayı adım adım anlatır. Tüm adımlar bir tarayıcıdan (Chromebook veya telefon) yapılabilir; komut satırı gerekmez.

> Bu belgedeki fiyatlar Ekim 2026'da kontrol edildi (kaynaklar en altta). Ücretli kaynak oluşturmadan önce Render'ın Blueprint önizleme ekranındaki toplamı mutlaka kontrol edin.

> **Önemli — dağıtım denetimi:** Servisler `claude/amazing-goodall-qkxupd` dalını izler ve geliştirme commit'leri bu dala gönderilir. `render.yaml`'da otomatik dağıtım kapalıdır (`autoDeployTrigger: off`) ancak bu ayar Blueprint'e ancak bir sonraki eşitlemede yansır ve Render'ın bilinen bir sorunu nedeniyle Blueprint değişikliği yine dağıtım tetikleyebilir. Bu nedenle Render panelinde **`aiops-web` ve `aiops-worker` → Settings → Auto-Deploy = Off** ve **Blueprint → Auto Sync = Off** ayarlarını yapın. Canlıya alma yalnızca sizin **Manual Deploy** kararınızla olur. Güncelleme kontrol listesi ve geri alma: [`OPERATIONS.md` §11–12](OPERATIONS.md#11-dağıtım).

---

## 1. Seçilen kurulum ve neden

| Parça | Nerede | Plan |
|---|---|---|
| Web paneli (Next.js) | Render **Web Service** (Docker) | Starter — 0.5 CPU, 512 MB |
| Görev işleyicisi | Render **Background Worker** (Docker, aynı imaj) | Starter — 0.5 CPU, 512 MB |
| Veritabanı | Render **Postgres 17** | Basic-256mb, 5 GB disk, yalnızca iç ağ |
| Dosyalar (medya, dışa aktarma) | Cloudflare **R2** kovası `aiops-media` | Kullandıkça öde, 10 GB'a kadar ücretsiz |
| Yedekler | Cloudflare **R2** kovası `aiops-backup` | Aynı |
| HTTPS | Render'ın otomatik sertifikası (`https://<ad>.onrender.com`) | Ücretsiz |

Neden bu seçenek:
- **Tarayıcıdan yönetilir:** sunucuya SSH, güncelleme, güvenlik duvarı gibi işler yok. Gizli değerler Render'ın şifreli ortam değişkeni ekranına girilir.
- **Ayrı işleyici:** web ve işleyici aynı Docker imajından iki ayrı servis olarak çalışır (ffmpeg, yazı tipleri ve `pg_dump` imajın içinde).
- **Kalıcı depolama:** Render kapsayıcılarının diski her dağıtımda sıfırlanır; bu yüzden dosyalar R2'de, veriler Postgres'te tutulur.
- **İki katmanlı yedek:** Render Postgres'in otomatik zaman noktasına geri dönüşü (Hobby çalışma alanında 3 gün) **ve** uygulamanın her gece R2'ye aldığı veritabanı dökümü + medya kopyası (14 gün saklama).
- **GitHub kod içindir:** kodun GitHub'da olması veritabanını ve yüklenen medyayı yedeklemez. Yedekleri yukarıdaki iki katman sağlar.

## 2. Tahmini aylık maliyet

| Kalem | Aylık |
|---|---|
| Render çalışma alanı (Hobby) | $0 |
| Web servisi — Starter | $7 |
| Arka plan işleyicisi — Starter | $7 |
| Postgres — Basic-256mb | $6 |
| Postgres diski — 5 GB × $0,30 | $1,50 |
| Cloudflare R2 — ilk 10 GB ve işlem kotaları | $0 |
| R2 — 10 GB üstü, GB başına | $0,015 |
| **Toplam (başlangıç)** | **≈ $21,50** |

**$40 hedefi yeterli** ve yaklaşık $18 pay bırakır. Bu pay şunlar için kullanılabilir:
- İşleyici uzun videolarda bellek yetersizliği yaşarsa Standard plana (2 GB) geçmek: +$18 → toplam ≈ $39,50.
- Postgres diskini büyütmek ($0,30/GB) veya R2 kullanımının 10 GB'ı aşması (100 GB ≈ $1,35 ek).

Bu tabloya **dahil olmayanlar:** Anthropic API kullanımı (uygulamadaki görev ve günlük bütçe sınırlarıyla kontrol edilir), isteğe bağlı OpenAI görsel üretimi, kendi alan adınız. Render web servislerinde trafik kotası aşılırsa GB başına ek ücret alınır; tek kullanıcılı bir panel için beklenmez.

**Bilinen riskler (ölçüldü):** 512 MB bellek web paneli için yeterlidir. 1080x1920, 5 bölüm + geçişli bir video kurgusunda ffmpeg tepe belleği ~440 MB, işleyicinin Node süreci ~150 MB ölçüldü; toplam Starter'ın 512 MB'ını aşar. **Video kurgusu kullanılacaksa işleyiciyi Standard'a (2 GB, $25/ay) yükseltmeniz önerilir → toplam ≈ $39,50/ay** (hedef $40 içinde). Yalnızca metin ve görsel işleri için Starter yeterlidir. Bu bir maliyet kararıdır; `render.yaml` planı kendiliğinden değiştirmez — Render → `aiops-worker` → Settings → Instance Type.

---

## 3. Sizin yapacağınız adımlar

Toplam süre yaklaşık 30–45 dakika. Hiçbir adımda bana anahtar veya parola göndermeyin; hepsi ilgili sağlayıcının ekranına girilir.

### Adım A — Cloudflare R2 (dosya depolama ve yedek)

1. https://dash.cloudflare.com adresinde hesap açın veya giriş yapın.
2. Sol menü **R2 Object Storage**. R2'yi ilk kez açıyorsanız Cloudflare ödeme bilgisi isteyebilir (ücretsiz kota içinde ücret alınmaz).
3. **Create bucket** → ad: `aiops-media` → konum: *Automatic* (veya Avrupa) → oluşturun.
4. Tekrar **Create bucket** → ad: `aiops-backup` → oluşturun. İki kovada da **Public access kapalı** kalmalıdır (varsayılan).
5. R2 ana sayfasında **API → Manage API tokens → Create API token**:
   - İzin: **Object Read & Write**
   - Kapsam: **Apply to specific buckets only** → `aiops-media` ve `aiops-backup`
   - Oluşturunca görünen **Access Key ID**, **Secret Access Key** ve **S3 endpoint** (`https://<hesap-kimliği>.r2.cloudflarestorage.com`) değerlerini bu sekmeyi kapatmadan bir sonraki adımda kullanacaksınız. Secret yalnızca bir kez gösterilir; kaybederseniz yeni belirteç oluşturun.

### Adım B — Render hesabı ve GitHub erişimi

1. https://dashboard.render.com adresinde GitHub hesabınızla giriş yapın.
2. Render'ın GitHub uygulamasına **CCC-C52/can** deposu için erişim verin (yalnızca bu depo seçilebilir).
3. Çalışma alanı planı **Hobby** kalabilir. Ödeme yöntemi ekleyin (Starter servisler ücretlidir).

### Adım C — Blueprint ile kurulum (maliyeti burada görürsünüz)

1. Render Dashboard → **New** → **Blueprint**.
2. Depo: **CCC-C52/can**, dal: **`claude/amazing-goodall-qkxupd`**. Render kökteki `render.yaml` dosyasını okur.
3. Önizleme ekranında şunları görmelisiniz: `aiops-web` (web, Starter), `aiops-worker` (worker, Starter), `aiops-db` (Postgres, Basic-256mb), `aiops-shared` (ortam grubu). **Toplamı kontrol edin**; beklenen ≈ $21,50/ay.
4. Render, `sync: false` olarak işaretli gizli değerleri bu ekranda sorar. Web ve işleyici için ayrı alanlar görünür; aynı değerleri ikisine de girin:

| Değişken | Değer |
|---|---|
| `ADMIN_PASSWORD` (yalnızca web) | Panel parolanız: en az 12 karakter. Tarayıcınızın parola yöneticisine güçlü parola ürettirip kaydedin. |
| `AIOPS_ANTHROPIC_API_KEY` | https://console.anthropic.com → API Keys'ten oluşturduğunuz anahtar. Henüz yoksa boş bırakabilirsiniz; panel açılır ama görevler "Bağlantı bekliyor" olur. Konsolda aylık harcama sınırı koymanızı öneririm. |
| `S3_BUCKET` | `aiops-media` |
| `S3_ENDPOINT` | R2'nin verdiği S3 endpoint (`https://...r2.cloudflarestorage.com`) |
| `S3_ACCESS_KEY_ID` | R2 Access Key ID |
| `S3_SECRET_ACCESS_KEY` | R2 Secret Access Key |
| `BACKUP_S3_BUCKET` (yalnızca işleyici) | `aiops-backup` |

`SESSION_SECRET` ve `ENCRYPTION_KEY` değerlerini Render otomatik üretir; sizin bir şey girmeniz gerekmez.

5. **Apply / Deploy Blueprint**. İlk derleme 5–10 dakika sürer. Bu adımdan sonra ücretlendirme başlar.

### Adım D — İlk giriş ve doğrulama (hedef akış)

1. Render'da `aiops-web` servisini açın; üstteki `https://aiops-web-xxxx.onrender.com` adresine tıklayın. Telefonunuzda ve Chromebook'unuzda bu adresi yer imlerine ekleyin.
2. **Giriş:** `ADMIN_PASSWORD` ile giriş yapın. Yanlış parolada 5 denemeden sonra giriş 15 dakika kilitlenir.
3. **Panel:** İlk açılışta marka yoktur (canlıda örnek DEMO marka yüklenemez). **Marka yönetimi → Yeni marka** ile bir marka oluşturun (yalnızca doğruladığınız bilgileri girin).
4. **Tek görev:** **Ana yönetici** ekranına örneğin şunu yazın: *"Yalnızca kısa bir kampanya stratejisi hazırla. Sosyal medya, yayın veya reklam görevi oluşturma."* İlk denemeden önce **Ayarlar** ekranında görev başına bütçeyi $0,50, günlük bütçeyi $2 yapmanızı öneririm.
5. **Sonuç:** 1–2 dakika içinde sohbete plan ve rapor düşer; **İçerik taslakları** ekranında strateji ve kalite raporu görünür. Hiçbir dış paylaşım yapılmaz.
   - Anthropic anahtarı girilmediyse görev **Bağlantı bekliyor** kalır. Anahtarı sonradan eklemek için: Render → `aiops-web` ve `aiops-worker` → **Environment** → `AIOPS_ANTHROPIC_API_KEY` → kaydedin (servisler yeniden başlar) → panelde **Entegrasyonlar → Bağlantı bekleyen görevleri tekrar dene**.
6. **Yedekleme kontrolü:** **Ayarlar** ekranında "Yedekleme" bölümü görünür. **Şimdi yedekle**'ye basın; 1 dakika içinde "Son başarılı" satırı dolmalı ve R2'de `aiops-backup/db/` altında bir dosya görünmelidir.

---

## 4. Güvenlik özeti

- Tüm panel sayfaları, API uçları ve dosya indirmeleri giriş ister. Medya dosyaları R2'de **özel** kovada durur ve yalnızca oturum açmış kullanıcıya uygulama üzerinden sunulur.
- Oturum çerezi `__Host-` önekli, `HttpOnly`, `Secure`; 12 saat geçerli. `ADMIN_PASSWORD` değiştirildiğinde tüm açık oturumlar geçersiz olur.
- HTTPS zorunlu (Render + HSTS başlığı). Sayfalar arama motorlarına kapalı (`noindex`).
- Kaba kuvvet koruması: IP başına 15 dakikada 5, toplamda 50 hatalı deneme.
- Veritabanı dış bağlantılara kapalı (`ipAllowList: []`); yalnızca Render iç ağından erişilir.
- Canlı ortamda **DEMO kapalıdır:** örnek marka yüklenemez, model anahtarı yoksa şablon içerik üretilmez.
- Eksik güvenlik ayarıyla (parola, oturum sırrı, şifreleme anahtarı, S3 depolama) uygulama **başlamaz**.
- Herkese açık uçlar yalnızca `/login`, imza doğrulamalı webhook'lar ve hiçbir veri döndürmeyen `/api/health`.

## 5. Güncelleme

Otomatik dağıtım kapalıdır (yukarıdaki uyarı). Güncelleme: Render → `aiops-web` → **Manual Deploy → Deploy latest commit**, ardından `aiops-worker` için aynısı. Veritabanı geçişleri web dağıtımından önce (`preDeployCommand`) uygulanır. Dağıtım başarısız olursa Render önceki sürümü çalıştırmaya devam eder. Adım adım kontrol listesi, dağıtım sonrası 14 doğrulama maddesi ve geri alma: [`OPERATIONS.md`](OPERATIONS.md#11-dağıtım).

**İsteğe bağlı sağlayıcı anahtarları** (Blueprint'te sorulmaz; ihtiyaç olunca `aiops-shared` ortam grubuna veya her iki servise eklenir):

| Değişken | Ne için |
|---|---|
| `OPENAI_API_KEY`, `OPENAI_IMAGE_COST_USD` | AI kampanya görseli (OpenAI Images) |
| `GEMINI_API_KEY`, `GEMINI_VIDEO_MODEL`, `GEMINI_VIDEO_COST_PER_SECOND_USD` | AI video (Google Gemini Omni Video) |
| `FFMPEG_THREADS` | ffmpeg iş parçacığı sınırı (vars. 2) |

Anahtarı ekledikten sonra panelde **Entegrasyonlar → Test et** ve **Ayarlar → Ücretli AI medya üretimi** iznini (varsayılan kapalı) bilinçli olarak açın.

## 6. Yedekleme ve geri yükleme

**Ne yedekleniyor:**
1. Render Postgres zaman noktasına geri dönüş (PITR): Hobby çalışma alanında son 3 gün.
2. Uygulamanın günlük yedeği (her gün UTC 02:00 sonrası, işleyici tarafından):
   - `aiops-backup/db/aiops-<tarih>.dump` — veritabanı dökümü, 14 gün saklanır.
   - `aiops-backup/media/...` — yüklenen ve üretilen tüm dosyaların kopyası (silinmez).
   - Durum ve hatalar **Ayarlar** ekranında ve işlem geçmişinde görünür.

**Geri yükleme:**
- *Son 3 gün içindeki bir an:* Render → `aiops-db` → **Recovery** → zaman seçin. Render yeni bir veritabanı oluşturur; doğruladıktan sonra servislerin `DATABASE_URL` değerini yeni veritabanına çevirin.
- *Günlük dökümden:* Önce panelde **Tüm işlemleri durdur**. Sonra Render → `aiops-worker` → **Shell**:
  ```
  npm run db:restore -- list
  RESTORE_CONFIRM=evet npm run db:restore -- latest
  ```
  Medya kaybı olduysa: `RESTORE_CONFIRM=evet npm run db:restore -- media`. Sonra servisleri yeniden başlatın.
- Yedeğin çalıştığını ayda bir kez kontrol etmeniz önerilir (Ayarlar → Yedekleme → Son başarılı).

## 7. Sorun giderme

| Belirti | Neden / çözüm |
|---|---|
| Servis başlamıyor, günlükte "Üretim yapılandırması eksik" | Belirtilen ortam değişkenini Render'da ekleyin. |
| Görevler "Bağlantı bekliyor" | `AIOPS_ANTHROPIC_API_KEY` eksik veya geçersiz. Entegrasyonlar → Anthropic → Test et. |
| Panelde "Görev işleyicisi çalışmıyor" uyarısı | Render → `aiops-worker` günlüklerine bakın; gerekirse **Restart**. |
| Yedekleme başarısız | Ayarlar'daki hata mesajı; genellikle R2 belirtecinin `aiops-backup` kovasına yetkisi eksiktir. |
| Video render'ında bellek hatası | `aiops-worker` planını Standard'a yükseltin veya `FFMPEG_THREADS=1`. |
| Hata mesajında "istek kimliği" | Render günlüğünde bu kimlikle arayın (günlükler JSON satırlarıdır). |
| Ayrıntılı durum | Panel → **Sistem durumu** (veritabanı, geçişler, işleyici, depolama, sağlayıcılar, kuyruklar, yedek). |

## Kaynaklar (fiyat ve özellik doğrulaması, Ekim 2026)

- Render fiyatları ve planları: https://render.com/pricing · https://render.com/docs/compute-plans
- Render Postgres yedekleme/PITR: https://render.com/docs/postgresql-backups
- Render Blueprint (`render.yaml`) başvurusu: https://render.com/docs/blueprint-spec
- Render çalışma alanı planları: https://render.com/docs/new-workspace-plans
- Cloudflare R2 fiyatları: https://developers.cloudflare.com/r2/pricing/

Not: Bu geliştirme ortamının ağ politikası render.com ve cloudflare.com sayfalarının doğrudan açılmasına izin vermedi; fiyatlar bu sayfalara ve bağımsız fiyat karşılaştırma kaynaklarına dayanan web aramasıyla doğrulandı. Kesin tutar Render'ın Blueprint önizlemesinde gösterilir.
