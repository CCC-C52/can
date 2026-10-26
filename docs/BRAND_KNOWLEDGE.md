# FriBee Marka Bilgi Sistemi (`/bilgi`)

Google Drive'daki **FriBee Master Archive** klasörü sistemin merkezi marka hafızasıdır. Bilgi sistemi yeni bir veri
kopyası oluşturmaz; mevcut parçaları birleştirir:

| Kaynak | Ne sağlar | Tablo |
|---|---|---|
| Drive dizini (salt okunur, artımlı) | Tüm dosyalar: ad, klasör yolu, tür, boyut, çözünürlük, MD5, sürüm | `drive_items` (004) |
| Doğrulanmış baskılar | Sahibin doğruladığı ön/arka/detay ürün görselleri, koleksiyon (tema), orijinal dosya medya arşivinde | `drive_references` (004) |
| Kaynaklı olgular (bilgi grafiği) | Koleksiyon rengi, hikâye belgesi, ürün adı, tedarikçi, karar … | `knowledge_facts` (005) |
| Marka Hafızası | Drive metin belgelerinden öneri olarak eklenen kurallar/hikâyeler | `brand_memory` (003) |

## Koleksiyonlar

Sahip “Koleksiyonları onayla” dediğinde dört koleksiyon kaynaklı ve onaylı olgu olur (kaynak: sahip talimatı):
**Space Alien — siyah**, **Music — beyaz** (mandala Music'e aittir), **Anime — turuncu**, **Save the Bee — açık mavi**.
Baskılar (ön/arka/detay) Drive Arşivi'nde sahip doğrulamasıyla, hikâyeler belge → koleksiyon bağlantısı ve inceleme
onayıyla koleksiyona bağlanır.

## Olgu durumu

- `confirmed`: sahip kararı + kaynak (Drive dosyası veya kaynak notu). Ajanlara yalnızca bunlar gerçek olarak verilir.
- `extracted` (arşiv dosyasından) ve `suggested`: İnceleme kuyruğunda bekler; ajanlara verilmez.
- `rejected`: hiçbir yerde kullanılmaz. Aynı öznitelikte yeni onaylı değer eskisinin yerini alır.
- Gizli bilgi (anahtar, parola, kart numarası) içeren olgu kaydedilmez.

## Rol bazlı erişim (ajan bağlamı: `brand_context.knowledge`)

| Rol | Ajanlar | Görebildiği hassasiyet | İlgili arşiv dosyaları |
|---|---|---|---|
| AI Yönetici | Ana Yönetici, Kalite | public, internal, vendor | ürün adları, hikâye, koleksiyon geçmişi, lookbook |
| Video / Tasarım | Video, Tasarım | public, internal | katalog fotoğraf/video, tasarım kaynakları, lookbook |
| Shopify / Pazarlama | Pazarlama, Shopify, Sosyal | public, internal | ürün adları, hikâye, lookbook, katalog fotoğrafı |
| PR | PR Uzmanı | public, internal | basın, hikâye, koleksiyon geçmişi, lookbook |
| Finans | Finans Uzmanı | public, internal, vendor, finance | finans, üretim, lojistik |

- `private` (sözleşme, ortaklık, hukuk) **hiçbir ajana** verilmez.
- Finans kayıtları (bütçe, fatura, muhasebe) ve sınıflandırılamayan tablo dosyaları (xlsx, csv, Google E-Tablo)
  yalnızca Finans'a verilir. Yalnızca Finans ajanında `finance.read` izni ve maliyet kayıtları vardır.
- Ajanlar dosya **içeriğini** değil, yalnızca adını/yolunu/bağlantısını görür; gizlenen kayıt sayısı (`withheld`)
  bildirilir, içeriği verilmez.

## Video ve tasarım sadakati

- Video Stüdyosu'nda koleksiyon seçilip fotoğraf seçilmezse, o koleksiyonun doğrulanmış ve orijinali arşive alınmış
  katalog fotoğrafları (ön → arka → detay) Gemini'ye referans olarak otomatik gider.
- Başka koleksiyonun fotoğrafı seçilirse talep reddedilir.
- Kalite kontrol şu durumlarda planı geçirmez:
  - referanslar farklı koleksiyonlardan;
  - seçilen koleksiyonla uyuşmayan referans;
  - istemde başka koleksiyon veya yanlış ürün rengi (ör. Anime için "black t-shirt");
  - istem logo ekliyor, değiştiriyor veya kaldırıyor;
  - reklamda koleksiyonlar karışık.
- Üretilen videonun piksel düzeyinde baskı denetimi görsel model (ücretli) gerektirir; şu an son kontrol sahip onayıdır.

## Testler

`tests/knowledge-system.test.ts`, `tests/brand-knowledge.test.ts`, `tests/drive.test.ts`.
