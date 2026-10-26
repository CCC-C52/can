# FriBee PR Ajansı (`/pr-ajansi`) — salt okunur izleme ve kaynak gösterimi iskeleti

Durum: **ilk, dar kapsamlı adım** (issue #9). Bu sürüm bir komuta merkezi iskeletidir; yeni dış bağlayıcı, kimlik bilgisi,
ücretli çağrı, sosyal paylaşım veya veritabanı geçişi içermez. Dağıtılmadı.

## 1. Bu sürümde çalışanlar

| Bileşen | Durum | Kaynak |
|---|---|---|
| Gezinme: Marka → **PR Ajansı** | Çalışır | `src/components/nav.tsx` |
| Genel bakış: altı çalışma alanı (Trend Intelligence, Media Relations, Influencer Relations, Reputation / Crisis, Campaign Strategy, PR Analytics) ve her birinin hazır / kısmi / veri kaynağı yok durumu, eksik kaynak listesi | Çalışır | `src/lib/pr-agency/model.ts` |
| Veri kaynakları tablosu: kullanılabilirlik, gerçekçi sıklık, izin kuralı | Çalışır | `connectorStatuses()` |
| Kanıt listesi: marka kapsamlı, sayfalı (en fazla 50/sayfa), doğrulama filtresi, kaynak adresi + alım zamanı, sayfa içi tekilleştirme | Çalışır (Araştırma Merkezi verisiyle) | `listPrEvidence()` |
| Tazelik: güncel / eski (> 7 gün) / veri yok / son çalıştırma başarısız | Çalışır | `classifyFreshness()` |
| Trend ilgisi: yalnızca **doğrulanmış** kaynaklardan; sinyal (≥ 2 bağımsız alan adı) / zayıf sinyal / spekülasyon; doğrulanmış kanıt yoksa puan **yok** | Çalışır | `scoreRelevance()` |
| Dört koleksiyon (Space Alien siyah, Music beyaz, Anime turuncu, Save the Bee açık mavi) — yalnızca FriBee markasına uygulanır | Çalışır; kaynak: sahip beyanı (issue #9), marka kaydında yapılandırılmış alan yok | `collectionsFor()` |
| Mevcut modüllerle bağlantı: etkin kampanya projesi ve ajan çıktısı sayıları; AI Yönetici, Kampanya Yönetimi, Onay Merkezi bağlantıları | Çalışır (salt okunur) | `prAgencyOverview()` |
| Kaynaksız metrik koruması (erişim, etkileşim, duygu, takipçi, iletişim) | Çalışır (kod düzeyinde + test) | `findUnattributedMetrics()`, `attributedMetric()` |
| Onay kapısı: e-posta, DM, yayın, Shopify, reklam, dağıtım — PR ajansı **hiçbirini yürütmez** | Çalışır (her zaman reddeder) | `prActionAllowed()` |

Servis hiçbir kaydı değiştirmez, dış çağrı yapmaz ve ücretli işlem başlatmaz (testle doğrulanır).

## 2. Çalışmayanlar / dış bağımlılık gerektirenler

| İhtiyaç | Neden yok | Gereken |
|---|---|---|
| RSS / herkese açık besleme alımı ve zamanlanmış çalıştırma | Bu PR kapsamı dışı (sahip: önce iskelet) | Beslemeler listesi + sahip onayı; işleyiciye (`worker/`) oran sınırlı görev; önerilen şema (§4) |
| Haber / basın takibi | Lisanslı API yok | API sözleşmesi, anahtar, maliyet sınırı |
| Sosyal dinleme, bahsetme, duygu | Mevcut Instagram entegrasyonu yalnızca yayın içindir | Instagram Graph API içgörü izinleri (uygulama incelemesi) |
| Influencer keşfi | İzinli kaynak yok | Graph API business discovery veya lisanslı sağlayıcı. İletişim bilgisi asla uydurulmaz |
| Günlük/haftalık brif, fırsat kuyruğu, medya pitch, influencer kısa listesi, lansman planı, risk işaretleri | Kalıcı veri modeli henüz uygulanmadı; AI üretimi ücretli | Şema (§4) + mevcut AI Yönetici/çıktı/onay akışına bağlama |
| PR metrikleri (erişim, SOV vb.) | Ölçüm kaynağı yok | Yukarıdaki bağlayıcılar. O zamana kadar arayüz "Veri yok" gösterir |
| Kanıt kaynağı | Yalnızca Araştırma Merkezi (Firecrawl, elle, ücretli) | `FIRECRAWL_API_KEY` + Ayarlar'da web araştırması + bütçe |

## 3. Gerçekçi sıklık

- Şu an: **elle**. Kanıt yalnızca sahip Araştırma Merkezi'nde araştırma başlattığında ve kaynağı doğruladığında oluşur.
- Planlanan RSS: kaynak başına en az 60 dk aralık (varsayılan 6 saat), koşullu GET (ETag / Last-Modified), günlük üst sınır.
- "Gerçek zamanlı" veya "canlı küresel trend" iddiası yoktur; arayüz her kaynağın durumunu ve son alım zamanını gösterir.

## 4. Önerilen kalıcı veri modeli (uygulanmadı)

`docs/pr-agency/004_pr_agency.proposed.sql`: izlenen kaynaklar, alım çalıştırmaları, bahsetmeler, trend sinyalleri ve
kanıt bağlantıları, influencer fırsatları, PR kampanyaları, öneriler, tarihsel anlık görüntüler. Özellikler: bileşik yabancı
anahtarla marka yalıtımı, normalleştirilmiş adresle tekilleştirme (`UNIQUE (brand_id, url_normalized)`), metrik doluysa kaynak
ve gözlem zamanı zorunlu (`CHECK`), kanıtsız ilgi puanı yasak, iletişim bilgisi sütunu yok.

Neden `migrations/` altında değil: yeni bir geçiş, sürüm hattı ve geçiş güvenliği testlerindeki sabit listeleri ve canlı
dağıtım kapısını etkiler; numarası açık PR #13 ile çakışabilir; ilk canlı uygulaması sahip onayı gerektirir
(`firstProductionRollout: requires_owner_authorization`). Sahip şemayı onaylayınca ayrı bir PR'da `migrations/` altına
alınmalı, `policy.json` kaydı eklenmeli ve ilgili test listeleri güncellenmelidir.

## 5. Testler

- `tests/pr-agency.test.ts` (vitest, test veritabanı): marka yalıtımı, kaynak gösterimi, sayfalama, tekilleştirme,
  eski/başarısız/boş veri, kaynaksız metrik yok, gizli değer sızmaz, bağlayıcı yokken doğru durum, onay kapısı,
  salt okunurluk, koleksiyon kapsamı ve FriBee yazımı, gezinme ve duyarlı düzen işaretleri.
- `tests/http/security.ts`: oturumsuz `/pr-ajansi` girişe yönlenir; A seçiliyken B'nin araştırma kaynağı görünmez.
- `tests/http/a11y.ts`: `/pr-ajansi` masaüstü ve telefon (390 px) genişliğinde axe + yatay taşma taraması.
