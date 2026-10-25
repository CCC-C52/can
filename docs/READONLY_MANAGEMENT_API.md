# FriBee Salt Okunur Yönetim API'si

**Durum:** Ayrı geliştirme dalında; canlıya dağıtılmadı.

## Amaç
AI Operations Studio içindeki projeleri, görevleri, video reklam taslaklarını, onayları ve medya analizlerini mevcut oturumla salt okunur incelemek.

## Uç nokta
`GET /api/management?section=projects|tasks|outputs|media`

İsteğe bağlı: `projectId=<uuid>`, `assetId=<uuid>` (media için), `limit=1..50`.

## Güvenlik sınırları
- Canlıda yalnızca geçerli yönetici oturum çereziyle erişim. Yetkisiz istekler 401 alır.
- Marka kimliği istekten değil, sunucu oturumundan alınır. Kayıtlar marka kimliğine göre filtrelenir.
- Yalnızca GET; veritabanında yazma, analiz başlatma, ücretli AI çağrısı veya medya dosyası indirme yoktur.
- Depolama anahtarı, API secret, imzalı URL ve dosya baytları yanıtta bulunmaz.
- Yanıtlar `Cache-Control: no-store, private` ile sunulur.
- Üretim öncesi güvenlik testi: anonim 401, oturumlu 200, marka sınırı, hatalı UUID 400, medya depolama anahtarı sızmaması, yüksek hacimde limit, hata yanıtında iç ayrıntı sızmaması.
- `outputs` içindeki reklam planı metni ticari açıdan hassas olabilir. Bu yüzden bu API'yi internete açık token tabanlı bir uç noktaya dönüştürmeyin.
- **Bu API tek başına ChatGPT'nin canlı verilere erişmesini sağlamaz.** ChatGPT ile doğrudan veri alışverişi için yetkilendirilmiş connector / MCP köprüsü gerekir. Ayrı güvenlik tasarımı ve onay olmadan servis hesabı anahtarı oluşturulmaz.

## İşletim
Mevcut veriler okunur; yeni video üretimi veya mevcut Space Alien görevinin yeniden çalıştırılması bu uç noktanın parçası değildir.
