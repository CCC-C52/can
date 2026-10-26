# FriBee PR Ajansı (`/pr-ajansi`)

Proaktif çalışan, kaynak gösteren ve hiçbir şeyi dışarı göndermeyen PR ajansı. Mevcut mimarinin içinde çalışır:
işleyici (worker) zamanlaması, çıktı/onay kuyruğu (`outputs`, `/onaylar`), ayarlar tablosu ve Marka Bilgi Merkezi.

## Sekmeler

| Sekme | İçerik |
|---|---|
| Genel bakış | Altı çalışma alanı, veri kaynağı durumu, doğrulanmış araştırma kanıtları, trend ilgisi |
| Otomasyon ve raporlar | Zamanlama aç/kapa, besleme seçimi, kaynak sağlığı ve kota, “Şimdi çalıştır”, üretilen taslaklar, ajans rolleri |
| ABD 12 aylık takvim | Federal tatiller ve kurala bağlı özel günler (yasa/kural ile hesaplanır), ticari dönemler (yaklaşık), koleksiyon uyumu, onay son günü. Organizatör tarihli etkinlikler (Anime Expo, ComplexCon, Pollinator Week …) sahip tarih + resmî kaynak girene kadar takvime girmez |
| 24 aylık strateji | 8 çeyrek, aşamalar, eylemler, sahip onayı gereken kararlar, kurallar; çeyreklik OKR'ler (başlangıç değeri yalnızca ölçülmüş veriden) |

## Zamanlanmış iş akışları (işleyici her 5 dakikada denetler)

- **Günlük trend özeti**: her gün 12:00 UTC.
- **Haftalık PR raporu**: Pazartesi 13:00 UTC.
- **Aylık yönetici sunumu**: ayın 1'i 14:00 UTC.
- **Etkinlik planları**: hazırlık penceresi açılınca (büyük 90, standart 45, küçük 21 gün önce).
- **Kriz/fırsat uyarıları**: taze veride koşullu.
- Aynı dönem için ikinci kez üretilmez. İşleyici kapalı kaldıysa dönem içinde telafi edilir.
- Her şey taslaktır ve Onay Merkezi'ne düşer.

## Kaynaklar

- Yalnızca yayıncıların RSS/Atom beslemeleri (PRWeek, PR Daily, Hypebeast, Highsnobiety, Complex Style, BoF).
  Sahip etkinleştirmeden hiçbir istek yapılmaz.
- Kaynak başına en kısa aralık ve günlük kota uygulanır. Kazıma (scraping) yapılmaz.
- Resmî API'ler (YouTube Data, Instagram Graph, TikTok Research) katalogda listelidir. Kimlik bilgisi ve bağdaştırıcı
  olmadan bağlanmaz; bu sürümde bağdaştırıcıları yok.
- Bağlı olmayan kaynak için veri, kapsama veya metrik üretilmez.

## AI departmanı: PR Uzmanı

Ana Yönetici PR işini `pr` uzmanına verir. Uzman şunları görür ve kullanır:
- onaylı koleksiyon bilgileri;
- ABD takvimi;
- doğrulanmış araştırma.

Çıktısı:
- hikâye açıları;
- takvim fırsatları;
- hedef TÜRLERİ;
- basın/creator taslakları;
- riskler;
- ölçütler.

Kalite kontrol şunları reddeder:
- gazeteci/creator e-postası veya hesap adı;
- ölçülmemiş takipçi/erişim rakamı;
- onaylı olmayan koleksiyon.

## Güvenlik

- E-posta, DM, yayın, Shopify değişikliği, reklam harcaması veya dağıtım yapılmaz.
- Ücretli servis çağrılmaz.
- Tüm okumalar ve yazmalar marka kapsamlıdır.

## Testler

`tests/pr-agency.test.ts`, `tests/pr-agency-core.test.ts`, `tests/pr-agency-overview.test.ts`,
`tests/knowledge-system.test.ts` (PR/Finans departmanları), `tests/http/a11y.ts`, `tests/e2e/studio-flow.ts`.
