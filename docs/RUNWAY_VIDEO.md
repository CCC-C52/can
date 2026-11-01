# Runway (birincil) ve Google Gemini (ikincil) AI video üretimi

Video Stüdyosu ve PR Ajansı kampanyalarındaki AI sahneleri artık önce **Runway** ile üretilir. Runway kullanılamıyorsa
sahne gönderilmeden önce **Google Gemini Omni**'ye geçilir. Sahneler, gerçek ürün fotoğrafları, arşiv çekimleri ve
hareketli logo kapanışı **ffmpeg** ile tek bir MP4 reklamda birleştirilir.

## Doğrulanmış Runway API yüzeyi

`docs.dev.runwayml.com` ve `api.dev.runwayml.com` bu geliştirme ortamının ağında kapalıydı. Aşağıdaki her şey Runway'in
resmî Node SDK'sının (`@runwayml/sdk` 4.24.0, 23 Ekim 2026) tip tanımlarından ve istemci kodundan birebir alındı.

| Amaç | Çağrı |
|---|---|
| Kimlik | `Authorization: Bearer <anahtar>`, `X-Runway-Version: 2024-11-06`, temel adres `https://api.dev.runwayml.com` |
| Ürün fotoğrafından video | `POST /v1/image_to_video` — `model: "gen4.5"`, `promptImage` (HTTPS, Runway upload URI veya ≤5 MB base64 data URI; ilk kare), `promptText` (≤1000 UTF-16), `ratio` (`720:1280` / `1280:720`), `duration` (2–10 tamsayı) |
| Metinden video | `POST /v1/text_to_video` — `model: "gen4.5"`, `promptText`, `ratio` (`720:1280` / `1280:720`), `duration` |
| Gönderim yanıtı | `{ id, estimatedCost: { credits } }` (görevin en fazla kredisi) |
| Sorgu | `GET /v1/tasks/{id}` → `PENDING`, `THROTTLED`, `RUNNING` (`progress`), `SUCCEEDED` (`output[]`, `cost.credits`), `FAILED` (`failure`, `failureCode`, `cost.credits`), `CANCELLED` |
| Çıktı | `output[]` adresleri 24–48 saatte geçersizleşir; indirmede görev yeniden sorgulanır (taze adres) |
| Bağlantı testi | `GET /v1/organization` (kredi bakiyesi; video üretmez) |

Runway, istemci tarafı tekrar-gönderim (idempotency) anahtarı belgelemez. Bu yüzden ağ hatası veya 5xx alan gönderim
**sonucu belirsiz** sayılır ve **otomatik tekrarlanmaz**. 429 kabul edilmemiş istektir; güvenle tekrar denenir. 400/401/422
kalıcı hatadır ve ücret doğurmaz.

## Kurulum (sahip)

1. **Anahtar** (birini seçin):
   - **Önerilen:** Entegrasyonlar → Runway → API anahtarını girin → **Bağlantıyı test et**. Anahtar AES-256-GCM ile
     şifrelenip marka bazında saklanır. Sunucu yeniden başlatılmaz.
   - Alternatif: Render'da web ve işleyici servislerine `RUNWAYML_API_SECRET` ekleyin (resmî SDK'nın değişken adı).
2. **Fiyat:** Ayarlar → *AI video sağlayıcısı* → **Runway kredi/saniye** (seçili model için) ve **Runway USD/kredi**.
   Değerleri Runway geliştirici portalının fiyat sayfasından alın. Bu uygulama fiyat uydurmaz: alanlar boşken Runway
   ile ücretli üretim **yapılmaz** ve sahne (Gemini hazırsa) Gemini'ye, değilse "fiyat girilmedi" uyarısıyla bekler.
3. **İzin ve sınırlar:**
   - Ayarlar → *Ücretli AI medya üretimi* açık olmalı.
   - 30–60 sn reklam için *Proje başına AI video sınırı* 30–60 sn olmalı (varsayılan 16).
   - Günlük AI bütçesi (planlanan 20 $) Runway ve Gemini'nin toplamına uygulanır.
4. **Gemini (ikincil):** `GEMINI_API_KEY`, `GEMINI_VIDEO_MODEL`, `GEMINI_VIDEO_COST_PER_SECOND_USD` ve Entegrasyonlar →
   "Test et". Bu ayarlar değişmedi.

## Sağlayıcı seçimi ve ücret güvenliği

- Her AI sahnesi için sağlayıcı **gönderimden önce** seçilir: Ayarlar'daki birincil (varsayılan Runway), hazır değilse
  ikincil. Hazır olmak için anahtar, doğrulanmış bağlantı ve bilinen fiyat gerekir. Seçim ve varsa yedek gerekçesi iş
  kaydına (`provider_jobs.request.provider_choice`) yazılır.
- Gönderilmiş sahne (başarılı, başarısız veya belirsiz) **başka sağlayıcıya kendiliğinden gitmez**. Çıktı sayfasındaki
  "AI üretim işleri" bölümünde sahip şunlardan birini seçer:
  - **"Yeniden gönder (Runway)"**,
  - **"Gemini ile yeniden gönder"**.
  Bu, ek ücretin sahip onayıdır ve denetim kaydına yazılır.
- Her sahne tek bir iş kaydıdır (`idempotency_key`). İşleyici yeniden başlarsa gönderilmiş iş yalnızca sorgulanır.
  Gönderim sırasında yarıda kalan iş 10 dakika sonra "sonucu bilinmiyor" olur.
- Runway'in gönderimde döndürdüğü üst sınır tahmini, girilen fiyattan yüksekse taahhüt edilen harcama o değere
  büyütülür. Böylece günlük bütçe hesabı doğru kalır.

## Maliyet kayıtları

| Kayıt | Runway | Gemini |
|---|---|---|
| Servis adı | `runway` | `video_generation` |
| Tahmini (gönderimden önce) | kredi/saniye × saniye × USD/kredi | saniye × USD/saniye |
| Gerçekleşen | görevdeki `cost.credits` × USD/kredi (başarısız ve iade edilen görevler dahil) | yapılandırılmış saniye fiyatı |

Sahne başına tahmini ve gerçekleşen tutar şuralarda görünür: Video Stüdyosu → *Üretim durumu*, proje sayfası ve Maliyet
Yönetimi. Kampanya toplamı proje sayfasında görünür.

## PR Ajansı → Video Stüdyosu

PR Ajansı → *Video kampanyası*: amaç, koleksiyon, süre (30–45 / 45–60 sn) ve sahne sayısı girilir. Ana Yönetici iki görev
açar:

1. **Pazarlama:** konsept, kreatif brif, sahne ve stil önerileri.
2. **Video:** plan, kalite kontrolü.

Talimattaki `Üretim onayı: gerekli` satırı nedeniyle render görevi **ücretli hiçbir istek göndermeden** bekler. Sahip,
proje sayfasında, Video Stüdyosu'nda veya PR Ajansı'nda sahne başına sağlayıcı ve tahmini maliyeti görür ve
**Üretimi onayla** der. Fiyatı bilinmeyen üretim onaylanamaz. Onay plan sürümüne bağlıdır; plan yeniden üretilirse yeniden
onay gerekir. Son MP4 Onay Merkezi'ne gelir. Yayın her zaman ayrı onaydır.

## Teslim doğruluğu

- Gerçek, depoda doğrulanmış MP4 olmadan video görevi "tamamlandı" sayılmaz.
- Yalnızca fotoğraf/logo parçalarından oluşan "reklam" (slayt gösterisi) video olarak teslim edilmez.
- AI sahneleri medya arşivine `ai_generated`, `ai_video:gen4.5` ve `sağlayıcı:Runway` etiketiyle, kapak karesiyle birlikte
  kaydedilir. Reklam MP4'ü Video Stüdyosu'nda oynatılabilir.

## Sınırlar

- Yalnızca `gen4.5` uygulandı. Diğer Runway modelleri farklı parametreler ister ve eklenmedi.
- gen4.5 görselden videoda tek ilk kare alır. Ürün fotoğraflarından yalnızca ilki Runway'e gider; Gemini en çok 3
  referans alır.
- Bu ortamda Runway anahtarı ve ağ erişimi olmadığı için gerçek Runway çağrısı yapılmadı. Davranış sahte sunucuyla
  test edildi. İlk gerçek üretim canlı ortamda kısa bir sahneyle doğrulanmalıdır.
- Fiyat bilgisi SDK'da yoktur. Kredi/saniye ve USD/kredi değerlerini sahip girer.

## Dağıtım ve geri alma

- Geçiş (migration) yoktur. Yeni ayarlar mevcut `limits` kaydına varsayılan değerlerle eklenir (Runway fiyatı boş, yani
  Runway kapalı). Mevcut veritabanı ve medya kayıtları değişmez.
- **Dağıtım:** PR birleştirilip üretim dalına alındıktan sonra `Release` iş akışı (dry_run=false).
- **Geri alma:** önceki üretim commit'ine `Release` ya da Render → servis → **Rollback**. Runway iş kayıtları
  (`provider = 'runway'`) eski sürümde sorgulanmaz. Geri almadan önce süren Runway işlerinin bitmesini bekleyin.
