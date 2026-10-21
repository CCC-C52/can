# Depo denetimi — 2026-10-21

Kapsam: `claude/amazing-goodall-qkxupd` dalı, commit `a6b009d` (Render'daki canlı sürümle aynı kod).
Yöntem: kaynak kodun satır satır incelenmesi, mevcut test paketinin çalıştırılması (33 test), bildirilen canlı hatanın kod üzerinde izlenmesi.
Durum etiketleri: **Çalışıyor** (testle doğrulanmış) · **Kısmi** · **Bozuk** · **Eksik** · **Doğrulanmamış** (kod var, gerçek servisle denenmedi).

## 1. Bildirilen canlı hata: `Pazarlama Uzmanı 'outputs.read' aracını kullanma iznine sahip değil`

- **Kök neden:** `src/lib/orchestrator/engine.ts` → `runGenerate()` bir görevin bağımlılığı (upstream çıktısı) varsa `assertTool(agent, "outputs.read")` çağırıyor. `src/lib/agents/registry.ts` içinde Pazarlama uzmanının izinleri `brand.read, products.read, performance.read` — `outputs.read` yok.
- **Neden testlerde görülmedi:** DEMO planlayıcı pazarlama görevine hiçbir zaman bağımlılık vermiyor. Gerçek (Claude) yönetici ise pazarlamayı örneğin bir analiz görevine bağlayabiliyor; o anda izin hatası oluşuyor.
- **Etkisi:** Görev "Başarısız" olur, ona bağlı tüm görevler "Bağımlılık başarısız" ile iptal edilir. Proje "İlgi bekliyor" olur (yanlışlıkla başarılı gösterilmiyor), ancak hata sınıfı (izin) yöneticiye/raporlara yapılandırılmış olarak yansımıyor.
- **İkincil bulgu (en az yetki ihlali):** `buildBrandContext()` her ajana ürün ve medya listesini veriyor; `products.read` / `media.read` izinleri bağlam üretiminde uygulanmıyor. İzin kontrolü yalnızca birkaç noktada, elle yazılmış `assertTool` çağrılarıyla yapılıyor; ajan ↔ gerçek kullanım uyumu otomatik test edilmiyor.

## 2. Alt sistem durumu ve doğrulama yöntemi

| Alt sistem | Başlangıç durumu | Bulgular | Doğrulama yöntemi |
|---|---|---|---|
| Ön yüz ve yönlendirme | Çalışıyor | 14 ekran; mobil taşma düzeltilmiş. Yükleme ilerlemesi yok, analiz/üretim durumları yok, "composed" kökeni yok, tanılama ekranı yok | Playwright ile ekran turu + erişilebilirlik kontrolleri |
| Kimlik doğrulama | Çalışıyor | İmzalı çerez, kilit, HSTS. Tek yönetici hesabı (tasarım gereği) | Üretim modu entegrasyon testleri, HTTP uçtan uca |
| Marka ayrımı | Kısmi | Servis sorguları `brand_id` ile kapsamlı; seçili marka çerezden. Ajan bağlamında izin filtresi yok. Rota düzeyi çapraz marka testi yok | Servis + HTTP + işleyici düzeyinde çapraz marka testleri |
| Marka/ürün yönetimi | Çalışıyor | — | Mevcut testler |
| Medya arşivi | Kısmi | Bayt düzeyinde tür kontrolü, SHA-256 tekrar algılama çalışıyor. "Düzenlenmiş" ile "derlenmiş" ayrılmıyor; proje/üretim yöntemi bağlantısı yok | Birim + entegrasyon |
| Yükleme API'leri | Bozuk (performans) | Tüm dosya web sürecinin belleğine alınıyor (`formData` + `arrayBuffer`); 512 MB'lık Render örneğinde büyük videolar yavaş/başarısız. İlerleme yok, sürdürme yok, durumlar yok | Parçalı yükleme testleri (yerel + S3 uyumlu), kesinti/sürdürme benzetimi |
| Nesne depolama | Çalışıyor | S3/R2 adaptörü; yedek kovası | S3 uyumlu yerel sunucuyla testler |
| Ana yönetici | Kısmi | Plan + rapor var. Eksik bilgi soruları, yapılandırılmış hata sınıflandırması, "engellendi" proje durumu yok | Plan/hata senaryosu testleri |
| Uzman kayıt defteri / araç izinleri | **Bozuk** | Bölüm 1 | Gerileme testi + izin matrisi testi |
| Ajan bağlam derleme | Kısmi | Medya içeriği (görsel analizi) bağlamda yok; izinler uygulanmıyor | Birim testleri |
| Görev planlama/orkestrasyon | Çalışıyor | Bağımlılık, paralellik, sınırlar | Mevcut + yeni testler |
| Arka plan işleyici | Çalışıyor | Kiralama/kurtarma doğrulanmış. Medya işleri ve sağlayıcı işleri için kuyruk yok | Kesinti, zaman aşımı, çift teslim, kalıcı hata testleri |
| Bağımlılık/yeniden deneme | Çalışıyor | Üstel bekleme var; hata sınıfları (izin/bütçe/bağlantı/kalıcı) ayrı raporlanmıyor | Testler |
| Çıktı oluşturma/okuma | Çalışıyor | — | Mevcut testler |
| Onay ve revizyon | Kısmi | Onay/ret/yeniden üretim var. Ret sonrası revizyon isteği ayrı adım değil; çıktı sayfasında maliyet ve bağımlılık görünmüyor; onay geçmişi veritabanında değiştirilebilir (değişmezlik zorlanmıyor) | Durum geçişi testleri + DB tetikleyici testi |
| Görsel işleme (derleme) | Kısmi | Yalnızca tek 4:5/9:16 gönderi derlemesi; carousel/story/banner/kapak yok | Çözülebilir dosya testleri |
| Video işleme (kurgu) | Kısmi | Kırpma, birleştirme, altyazı var. Geçiş, giriş/çıkış kartı, küçük resim, çıktı doğrulaması yok | ffprobe ile süre/boyut/kodek doğrulaması |
| AI model entegrasyonu (metin) | Doğrulanmamış | Anthropic adaptörü sahte SSE ile test edildi; canlıda kullanıcı bildirimine göre çalışıyor (izin hatasına kadar ilerlemiş) | Sahte + isteğe bağlı canlı test |
| Görsel anlama | **Eksik** | Yalnızca dosya adı, boyut ve baskın renk. Pikseller analiz edilmiyor | Bilinen içerikli test görselleri |
| Video anlama | **Eksik** | Yalnızca ffprobe meta verisi | Bilinen içerikli test videoları (sahne/renk) |
| AI görsel üretimi | Doğrulanmamış / Kısmi | OpenAI üretim adaptörü var; referans görselli düzenleme yok; ücretli işlem için açık sahip yetkisi yok | Sahte sağlayıcı + isteğe bağlı canlı |
| AI video üretimi | **Eksik** | Arayüz var, sağlayıcı yok. Not: OpenAI Videos API (Sora) 24 Eylül 2026'da kapatıldı | Sahte sağlayıcıyla iş/kurtarma testleri |
| Maliyet muhasebesi | Çalışıyor | Tahmini/gerçekleşen ayrı; görev/gün sınırı | Mevcut testler |
| Veritabanı şeması | Kısmi | FK'ler var; bazı FK sütunlarında indeks yok; onay değişmezliği yok; sağlayıcı işi/analiz/yükleme tabloları yok | Temiz + mevcut-veri fikstürü üzerinde geçiş testi |
| Geçişler | Çalışıyor | Danışma kilidi, tek seferlik | Geçiş testleri |
| Güvenlik kontrolleri | Kısmi | Oturum, CSRF köken, imzalı webhook, tür kontrolü. ffmpeg/ffprobe protokol beyaz listesi yok; API hız sınırı yalnızca girişte; istek kimliği yok | Güvenlik testleri |
| Render altyapısı | Doğrulanmamış | Blueprint + Dockerfile. Render erişimim yok; canlı ortamın gerçek ayarları görülemedi | Yerel kapsayıcı benzetimi; canlı doğrulama sahip onayından sonra |
| Otomatik testler | Kısmi | 33 test; rota düzeyi HTTP testi yok, medya anlama yok | Bu çalışmada genişletilecek |
| İzleme ve tanılama | Eksik | Yalnızca `/api/health` (DB). İşleyici/depolama/sağlayıcı durumu tek ekranda değil, yapılandırılmış günlük yok | Bağımlılık hatası benzetimi |

## 3. Öncelik sırası

1. İzin hatası ve en az yetki (canlıda iş akışını durduruyor).
2. Şema ekleri (sonraki her şeyin temeli; geriye uyumlu, yıkıcı olmayan).
3. Gerçek görsel/video anlama.
4. Yükleme performansı ve güvenilirliği.
5. Pazarlama çıktıları ve yönetici açıklama soruları.
6. Görsel derleme ve video kurgu tamamlama.
7. AI görsel/video üretimi (sağlayıcı işleri, kurtarma, harcama yetkisi).
8. Onay/maliyet arayüzü, tanılama, güvenlik sertleştirme.
9. FriBee kabul akışı (izole fikstür), canlı test paketi (isteğe bağlı), belgeler.

## 4. Kısıtlar

- Render, canlı veritabanı ve gerçek FriBee kayıtları bu geliştirme ortamından **erişilebilir değil**. FriBee kabul testleri izole bir fikstür üzerinde yapılacak; gerçek FriBee verisiyle doğrulama sahip onayı ve erişim gerektirir.
- Bu ortamda Anthropic, OpenAI, Google (Veo) veya R2 kimlik bilgisi yok. Ücretli canlı testler yapılmayacak; sahte sağlayıcılarla doğrulanacak ve "canlı test edilmedi" olarak raporlanacak.
- render.com, ai.google.dev, developers.openai.com ve cloudflare.com belge sayfaları ağ politikası nedeniyle doğrudan açılamıyor; API ayrıntıları web aramasıyla resmi kaynaklara dayanarak doğrulandı.
