# Araç kararları (10 araç)

Her araç için: uygulamada gerçek bir ihtiyacı karşılıyor mu, güvenlik/maliyet/bellek (512 MB işleyici) etkisi ne, ve sonuç.
Panelde **Entegrasyonlar → Değerlendirilen araçlar** tablosu aynı kararları, sunucudaki gerçek yapılandırmaya göre hesaplanan durumla gösterir. Yapılandırılmamış hiçbir araç “Etkin” gösterilmez.

Durum ölçeği: Etkin · Kullanılabilir, yapılandırılmadı · Hesap veya API anahtarı gerekli · Ücretli lisans gerekli · Güvenlik nedeniyle kapalı · Desteklenmiyor.

| Araç | Karar | Uygulamadaki karşılığı | Varsayılan durum |
|---|---|---|---|
| Headroom | Kurulmadı | Yerel Anthropic istem önbelleği (`cache_control`) uygulandı | Anahtar yoksa “anahtar gerekli” |
| Firecrawl | Uygulandı (kapılı) | Araştırma Merkezi (`/arastirma`), `src/lib/adapters/firecrawl.ts`, `src/lib/services/research.ts` | Anahtar gerekli |
| PostHog | Uygulandı (isteğe bağlı) | Sunucu tarafı hata/başarısızlık olayları, `src/lib/telemetry.ts` | Anahtar gerekli |
| Playwright | Mevcut, genişletildi | Uçtan uca ve erişilebilirlik testleri (yalnızca geliştirme) | Etkin (test) |
| Remotion | Kurulmadı | Kurgu yerel ffmpeg ile | Ücretli lisans gerekli |
| Composio | Kapalı | Resmi Shopify/Instagram bağlantıları + onay kapısı | Güvenlik nedeniyle kapalı |
| OmniRoute | Önerilmez | Resmi Anthropic SDK ile doğrudan çağrı | Desteklenmiyor |
| Ruflo | Geliştirici aracı | — | Desteklenmiyor (uygulamada) |
| claude-mem | Geliştirici aracı | Ürün içi: Marka Hafızası | Desteklenmiyor (uygulamada) |
| Task Observer | Geliştirici aracı | Ürün içi: görev panosu, denetim kaydı, sistem durumu, PostHog | Desteklenmiyor (uygulamada) |

## Headroom → yerel istem önbelleği

- Yönerge: önce yerel önbellek, ek vekil ancak kanıtlanmış fayda varsa.
- Uygulama: sistem istemi ve marka bağlamı (`<brand_context>`) önbellek işaretli bloklar olarak gönderilir. Marka bağlamı, değişen talimattan önceye alındı.
- Ölçüm (yerel, model çağrısı yok — `node --env-file=.env --import tsx scripts/dev/measure-prompts.ts`), örnek marka:
  - önbelleğe alınabilir önek ≈ 4.200–4.600 token (sistem 450–900 + marka bağlamı ≈ 3.700);
  - değişen kısım ≈ 20 token + önceki çıktılar.
- Fiyat (Opus 5.5): yazma 1,25 × giriş ($5/1M), okuma $0,20/1M (giriş $4/1M). Aynı ajan + aynı marka için 5 dk içindeki ikinci çağrıda önek maliyeti ~%95 düşer.
- Sınır: önbellek ajan başına ayrıdır (sistem istemi ajana göre değişir). En büyük kazanç kalite incelemelerinde, revizyonlarda ve aynı ajanın ardışık görevlerinde olur. Gerçek isabet oranı canlı ortamda `cost_entries.units.cache_read_input_tokens` ile ölçülmelidir. Bu çalışmada ücretli çağrı yapılmadığı için **ölçülmedi**.
- Headroom gibi ek bir vekil, anahtarları ve müşteri verisini ek bir katmandan geçirir ve 512 MB işleyiciye yük getirir; kurulmadı.

## Firecrawl

- Yalnızca sahip başlatır. Ajanların web çağrısı yetkisi yoktur; yalnızca `research.read` izniyle sahibin **doğruladığı** kaynakları görürler.
- Kapılar: sunucuda `FIRECRAWL_API_KEY`, Ayarlar'da “Web araştırması” (varsayılan kapalı), aylık kredi sınırı (varsayılan 100), bütçe kontrolü (günlük, sağlayıcı aylık; `FIRECRAWL_CREDIT_USD` tanımlı değilse ve bütçe sınırı etkinse engellenir), tekrarlanan istek koruması (idempotency).
- Güvenilmeyen içerik: kontrol ve yön değiştirme karakterleri ile `<data>` etiketleri temizlenir, 4.000 karakterle sınırlanır, “doğrulanmamış” saklanır; bağlamda `<data>` içinde ve “marka bilgisi değildir” kuralıyla verilir.
- Adresler: yalnızca herkese açık http(s) alan adları; IP, localhost, kimlik bilgili adresler reddedilir.
- Uç noktalar resmi OpenAPI v2 belgesinden alındı: `POST https://api.firecrawl.dev/v2/search`, `POST /v2/scrape`. Gerçek hesapla **test edilmedi** (anahtar yok, ücretli).

## PostHog

- Yalnızca sunucu tarafı; tarayıcı betiği, çerez ve oturum kaydı yok. Varsayılan sunucu AB (`https://eu.i.posthog.com`).
- Gönderilen: `log("error")` olayları (`$exception`, maskelenmiş mesaj) ve görev başarısızlıkları (`aiops.task_failed`: ajan, tür, deneme, sonuç). Müşteri metni, istem, dosya adı, e-posta, IP gönderilmez; kişi profili oluşturulmaz.
- `POSTHOG_API_KEY` yoksa hiçbir şey gönderilmez. Gerçek PostHog projesiyle **test edilmedi**.

## Remotion

- Programatik video şablonları için güçlü; ancak render başsız Chromium ile yapılır (512 MB işleyiciye sığmaz) ve belirli büyüklükteki şirketler için ücretli şirket lisansı gerekir. Lisans durumu sahip tarafından doğrulanmalıdır.
- Etkinleştirmek için: lisans kararı, ayrı render servisi (en az 2 GB), maliyet onayı. Bu çalışmada kurulmadı.

## Composio

- Ajanlara çok sayıda dış hesapta işlem yetkisi verir; uygulamadaki “önce insan onayı” kapısının dışında işlem yapılabilir. Güvenlik nedeniyle kapalı.

## OmniRoute

- Model çağrılarını üçüncü bir yönlendiriciden geçirir; anahtar ve veri yüzeyini büyütür, sağlayıcı bazlı maliyet kaydını bozar. Önerilmez.

## Ruflo, claude-mem, Task Observer

- Kodlama ajanları için geliştirici araçlarıdır; uygulamanın çalışma zamanı ajanlarıyla ilgisi yoktur ve üretim imajına eklenmedi. Geliştirici makinesinde isteğe bağlı kullanılabilir.
