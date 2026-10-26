# Google Drive marka arşivi

FriBee'nin Google Drive'daki ana arşiv klasörü (varsayılan ad: **FriBee Master Archive**) panele salt okunur bağlanır.
Sistem klasörü dizinler, içeriği uygun birime yönlendirir ve **hiçbir şeyi sahibin onayı olmadan** ajanlara veya AI
üretimine vermez.

## Ne nereye gider?

| Drive içeriği | Nereye | Nasıl |
|---|---|---|
| Tüm dosya ve klasörler | Drive Arşivi → Dosyalar | Otomatik dizin: ad, yol, tür, boyut, çözünürlük, MD5. Dosya içeriği kopyalanmaz. |
| Ürün/tasarım görselleri | İnceleme kuyruğu → Doğrulanmış referanslar → Medya arşivi | Sahip seçer → sistem tema/görünüm önerir → sahip tema, görünüm (ön/arka/detay) ve “tasarım, kalıp, renk birebir doğru” onayı ile doğrular → **orijinal dosya** medya arşivine alınır. |
| Hikâye, karakterler, marka kuralları (Google Dokümanı, .txt, .md) | Marka Hafızası (öneri) | Sahip “Marka hafızasına öner” der → metin bölümlere ayrılıp **öneri** olarak eklenir → sahip Marka Hafızası'nda etkinleştirince ajanlar kullanır. |

## Ultra netlik ve tasarım sadakati

- Doğrulanmış görsel, Drive'daki dosyanın **kendisi** olarak indirilir (`alt=media`). Drive'ın MD5 özeti indirilen dosyayla
  karşılaştırılır; eşleşmezse kaydedilmez. Küçültme, sıkıştırma veya renk dönüşümü yapılmaz.
- Önizleme (küçük kopya) yalnızca renk ipucu için kullanılır, hiçbir zaman ürün referansı olmaz.
- Kısa kenarı 1024 pikselden küçük görsel referans olarak alınmaz. JPEG, PNG, WebP desteklenir; HEIC/TIFF için görseli
  Drive'a JPEG/PNG olarak (orijinal çözünürlükte) yükleyin.
- AI'a gönderim kuralları (6 MB'a kadar aynen; üstü aynı piksel boyutunda q95 4:4:4) `docs/VIDEO_PIPELINE.md` ile aynıdır.
- Referansı “incelemeye geri al” veya “reddet” yapılan görsel, medya arşivinde olsa bile hiçbir ajana, derlemeye veya
  AI isteğine giremez.

## Kurulum (bir kez)

1. **Google Cloud Console** → yeni proje → *APIs & Services* → **Google Drive API**'yi etkinleştirin.
2. *OAuth consent screen*: tür **External**, uygulama adı, destek e-postası. Kapsam: `.../auth/drive.readonly`.
   Yayın durumunu **In production** yapın. *Testing* durumunda Google yenileme belirtecini 7 günde iptal eder ve
   tarama durur. Doğrulanmamış uygulamada Google bir uyarı ekranı gösterir; kendi hesabınız için “Gelişmiş → devam et”
   yeterlidir.
3. *Credentials* → **OAuth client ID** → *Web application*. Yetkili yönlendirme URI'si:
   `https://<PUBLIC_BASE_URL>/api/integrations/google-drive/callback` (Entegrasyonlar sayfası tam adresi gösterir).
4. Render → `aiops-web` **ve** `aiops-worker` ortamına `GOOGLE_DRIVE_CLIENT_ID` ve `GOOGLE_DRIVE_CLIENT_SECRET` ekleyin
   (“Save only” sonra dağıtım). İsteğe bağlı: `DRIVE_ARCHIVE_FOLDER_NAME`, `DRIVE_SCAN_INTERVAL_MINUTES` (vars. 30),
   `DRIVE_SCAN_PAGES_PER_TICK` (vars. 10).
5. Panel → **Drive Arşivi** → *Google Drive ile bağlan* → izin ekranında “Drive dosyalarını görüntüleme” kutusunu
   işaretleyin → dönüşte klasörü seçin. İlk tarama işleyicide arka planda başlar; sayfa ilerlemeyi gösterir.

## Güvenlik

- İzin `drive.readonly`: uygulama Drive'da dosya oluşturamaz, değiştiremez, silemez, paylaşamaz.
- Belirteçler `ENCRYPTION_KEY` ile AES-256-GCM şifreli saklanır; günlüklere ve hata mesajlarına yazılmaz.
- OAuth state tek kullanımlık, 10 dakika geçerli ve markaya bağlıdır.
- Bağlantıyı kaldırmak Google'da izni de iptal eder. “Dizini de sil” yalnızca bu uygulamadaki kayıtları siler.
- Dosya adları ajanlara yalnızca etiket olarak gider; ürün bilgisi veya talimat sayılmaz.

## Tarama

- İlk tarama kaldığı yerden sürer (kuyruk ve sayfa belirteci her sayfada kaydedilir). Sonra yalnızca Drive değişiklik
  akışı okunur: yeni, yeniden adlandırılan, taşınan, çöpe atılan dosyalar yansır.
- Bağlantı kopukken silinen dosyalar, yeniden bağlanınca yapılan tam taramada “kaldırıldı” olur.
- Yetki iptal edilirse (401) kaynak “Yeniden bağlanın” durumuna geçer ve tekrar denenmez. Geçici hatalarda üstel geri
  çekilme uygulanır (en çok 6 saat).
- Ücretli hiçbir servis çağrılmaz; yalnızca Google Drive API kotası kullanılır.
