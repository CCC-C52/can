# FriBee Brand Brain — Drive arşivinden kaynaklı, aranabilir marka bilgisi

Dal: `claude/brand-brain` (video P0 dalı `claude/video-engine-p0` üzerine kurulu) · Geçiş: `007_brand_brain.sql` (yalnızca ekleme)
Durum etiketleri: **UYGULANDI** (kod var) · **TEST EDİLDİ** (yerel, gerçek ayrıştırıcılar + sahte Drive) · **CANLIDA DOĞRULANMADI** (gerçek arşivle ölçüm yapılmadı; aşağıda engel)

## 1. Kök neden analizi (kod üzerinden)

| Halka | Önce | Bilginin kaybolduğu nokta |
|---|---|---|
| OAuth → klasör → tarama | `drive.readonly`, kaldığı yerden devam eden tam tarama + Changes API (`src/lib/drive/indexer.ts`) | Sağlam; ama **yalnızca üst veri** (ad, yol, boyut, özet) okunuyordu |
| İçerik çıkarma | Yok. Tek yol `proposeMemoryFromDocument`: sahip tek tek tıklıyordu, yalnızca GDoc/TXT/MD, en çok 8 × 3.800 karakter, 2 MB | PDF, DOCX, XLSX, PPTX, Google E-Tablo/Slayt **hiç okunmuyordu** |
| Bilgi depolama | `knowledge_facts` (onaylı/çıkarılmış olgular), `brand_memory` (elle etkinleştirilen notlar) | Belge içeriği için arama yapılabilir depo yoktu |
| Erişim | `knowledge/retrieval.ts` bellek içi ad/yol eşleşmesi | Tam metin veya anlamsal arama yoktu |
| Ajan bağlamı | `knowledgeForRole`: onaylı olgular + **en çok 30 dosyanın adı/yolu** | Uzman belgenin **içeriğini** hiç görmüyordu |
| Atıf | Yok | Hangi dosyanın kullanıldığı kaydedilmiyordu; "Drive'ı kullandım" iddiası doğrulanamıyordu |

**Başlangıç ölçümü (aynı kodla, sentetik arşiv, `tests/brand-brain.test.ts` ilk test):**
- 18 dosya dizinde;
- Brand Brain belge sayısı 0, içerik çıkarılan 0;
- "Space Alien story" aramasında 0 sonuç;
- PR bağlamında hikâye metni yok.

**Canlı arşivin başlangıç ölçümü bu oturumda yapılamadı:** Üretim veritabanına ve sahibin Drive'ına erişim yok. Ölçüm için salt okunur betik hazır, bkz. bölüm 8.

## 2. Mimari

```
Drive (salt okunur)                    işleyici (Render Worker, ayrı döngü, 15 sn'de bir, tur başı ≤8 belge / 25 sn)
  └ indexer (üst veri, mevcut) ──▶ drive_items ──sync──▶ kb_documents (revizyon anahtarı, durum, kira, deneme)
                                                          │ indir / Google dışa aktarımı (yalnızca okuma)
                                                          ▼
                     ayrıştırıcılar (deterministik): pdftotext · OOXML (DOCX/XLSX/PPTX) · TXT/MD/CSV · üst veri
                                                          ▼
          sınıflandırma: koleksiyon · hassasiyet (dosya kategorisi + içerik) · gizli bilgi · komut enjeksiyonu
                                                          ▼
          kb_chunks (tsvector + isteğe bağlı gömme) ──▶ knowledge_facts "extracted" (doğrulanmamış iddia)
                                                          ▼
   searchBrain (SQL'de rol filtresi) ──▶ <brand_brain_sources> GÜVENİLMEYEN VERİ ──▶ uzman / AI Yöneticisi
                                                          ▼
                       kb_retrievals (kim neyi aldı) · kb_output_sources (çıktı sürümü ↔ kaynak, atıf)
```

### Alma hattı (`src/lib/brain/ingest.ts`, `parsers.ts`)

**Okunan biçimler:**
- Google Dokümanı ve Slaytlar: düz metin dışa aktarımı.
- Google E-Tablo: XLSX dışa aktarımı.
- PDF: poppler `pdftotext`, sayfa sınırları korunur.
- DOCX (başlıklar bölüm olur), XLSX (sayfa/hücre), PPTX (slayt + notlar).
- TXT, Markdown (başlıklar), CSV.

**Yalnızca üst veri dizinlenenler:**
- Görsel: ürün referansı durumu yazılır.
- Video: süre, çözünürlük; medya arşivinde analiz edilmişse sahneler. Video baytları indirilmez.
- Ses: transkripsiyon kapalı.
- Desteklenmeyen biçimler: neden kaydedilir.

**Uydurma yok:**
- Parolalı/bozuk PDF → `unsupported`.
- Metin katmanı olmayan PDF → `metadata_only` (OCR kapalı).

**Artımlı eşitleme:**
- Revizyon anahtarı Drive sürümü + md5/sha256 + değişiklik zamanından oluşur. Değişmeyen dosya yeniden işlenmez.
- Yalnızca yolu/adı değişen içerik belgesi yeniden indirilmez.
- Silinen, çöpe atılan, klasör dışına taşınan veya erişimi kalkan dosya `removed` olur. Parçaları ve incelenmemiş iddiaları silinir. Çıktılardaki kaynak izi (ad/yol/revizyon) korunur.

**Dayanıklılık:**
- Kiralama (`FOR UPDATE SKIP LOCKED` + 10 dk); işleyici çökerse kira kurtarılır.
- Geçici hata (ağ, 429, 5xx) → üstel geri çekilme (30 sn × 2ⁿ, en çok 6 sa); 5 denemede `dead` (ölü mektup kuyruğu).
- Kalıcı hata → `failed` + dosya başına neden. Panelden "tekrar dene".
- 401 → kaynak "yeniden yetkilendirme" durumuna alınır.

**Yinelenenler:**
- Aynı Drive md5'i → dosya indirilmez.
- Aynı metin → `duplicate_of`.
- Aramada asıl belge döner ve kopyaların adları gösterilir.

### Erişim (`src/lib/brain/retrieval.ts`)

**Karma arama:**
- PostgreSQL tam metin araması (`simple`, önek eşleşmeli OR, `ts_rank_cd`) ve gömme benzerliği karşılıklı sıra füzyonuyla (RRF) birleştirilir.
- Belge başına en çok 3 parça döner.
- Bilgi sorularında içerik belgeleri, yalnızca üst veri taşıyan parçaların önüne geçer.

**pgvector:**
- Render Postgres pgvector'ü destekler (PostgreSQL 13+, `CREATE EXTENSION vector;`). Bu oturumda canlı veritabanında doğrulanmadı.
- Geçiş eklentiyi kurmaz: `CREATE EXTENSION` politika gereği "inceleme gerektirir" sınıfındadır ve CI'daki postgres:17 imajında yoktur.
- Uygulama çalışma anında `pg_extension`'a bakar. Eklenti kuruluysa `real[]::vector` ile `<=>` operatörünü kullanır.
- Kurulu değilse aynı sonucu veren tam taramalı kosinüs hesaplanır. Panel hangisinin kullanıldığını gösterir. Yani anlamsal arama sessizce kapatılmaz.

**Erişim denetimi SQL'de uygulanır:**
- Rolün göremediği hassasiyetteki parça sorgudan hiç dönmez; yalnızca sayısı bildirilir.
- `private` (sözleşme, gizli bilgi) hiçbir role verilmez.
- `finance` yalnızca Finans rolüne verilir.
- Marka yalıtımı `brand_id` ile sağlanır.

### Uzman bağlamı (`src/lib/brain/context.ts`, `engine.ts`)

- AI Yöneticisi (`runPlan`) ve bütün uzmanlar (`runGenerate`) üretimden önce kendi rolleriyle arama yapar:
  - PR Direktörü ve Marka Stratejisti → `pr`
  - Pazarlama, Shopify ve Sosyal → `marketing`
  - Video ve Tasarım → `video_design`
  - Finans → `finance`
  - Yönetici → `manager`
- Talimat tek bir koleksiyon anıyorsa önce o koleksiyonun parçaları gelir.
- Parçalar `<brand_brain_sources>` içinde **güvenilmeyen veri** olarak verilir:
  - `<` ve `>` kaçışlanır, etiket kırılamaz;
  - içindeki talimatların yok sayılacağı açıkça yazılır;
  - her parça `[S#]` ile atıf yapılabilir.
- Hiçbir şey bulunamazsa bu açıkça yazılır: ajan "Drive'ı kullandım" diyemez.
- Çıktı sürümüne verilen her parça kaydedilir (`kb_output_sources`): `[S#]` veya dosya adı geçenler "atıf yapıldı" olur.
- Taslak sayfasında "Kullanılan arşiv kaynakları" bölümü görünür. AI Yöneticisi yanıtının sonuna "Kaynaklar (Drive arşivi): [S#] yol" eklenir.

### Bilgi grafiği (mevcut `knowledge_facts` kullanılır; kopya kanonik olgu yok)

**Deterministik iddia çıkarımı (AI yok):**
- Koleksiyon başına en çok 3 hikâye alıntısı, garment rengi ve çizim ataması çıkarılır.
- Hepsi `extracted` durumunda, kaynak dosyaya bağlı ve "doğrulanmamış" olarak işaretlidir.
- Onaylı değerle aynı olan iddia kuyruğa eklenmez; tekrarlayan elle onay azalır.

**Çakışmalar** panelde görünür. Örnekler:
- Music için "black" iddiası (onaylı değer: white).
- Mandala çiziminin başka bir koleksiyona atanması. Mandala Music'e aittir; atama için doğrulanmış kanıt gerekir.

**Ürün referansı koruması değişmedi:**
- Dosya adı veya AI tahmini ürünü doğrulamaz.
- `Artboard 1.png` → "Ürün fotoğrafı değil".
- Yalnızca sahip doğrulaması (`drive_references.status = verified`, tema + görünüm + baskı onayı) "doğrulanmış ürün referansı" etiketini üretir.

## 3. Maliyet

| Kalem | Model / fiyat | Durum |
|---|---|---|
| İndirme, ayrıştırma, parçalama, tam metin dizini | Yerel, deterministik | **Ücretsiz**, otomatik |
| Gömme (anlamsal arama) | OpenAI `text-embedding-3-small` veya Voyage `voyage-3.5-lite`, **$0.02 / 1M belirteç** (yayımlanmış fiyat; 28 Ekim 2026'da resmî sayfalardan kontrol edildi, faturayla doğrulanmadı) | **Varsayılan KAPALI.** Sahip açar. Kuyruk günlük artımlı sınırı aşıyorsa "büyük toplu işlem" olur ve sahibin onayladığı tutar kadar harcanır. Fiyat bilinmiyorsa engellenir. Ayrıca günlük $20 genel bütçe uygulanır |
| Sorgu gömmesi | Aynı model, sorgu başına ~20 belirteç | Günlük sorgu bütçesi (varsayılan $0.05) |
| OCR, transkripsiyon, AI sınıflandırma | — | **Uygulanmadı**; bütçe $0, sağlayıcı yok |
| Uzman yanıtı | Mevcut model (Opus); bağlama en çok ~9.000 karakter (~2.300 belirteç) eklenir | Opus 5.5 giriş fiyatıyla ($4/1M) **çağrı başına ≈ $0.009** ek maliyet |

**Ölçek tahmini (300–500 GB):**
- Arşivin büyük kısmı görsel ve video; bunlar yalnızca üst veri olarak işlenir (gömme yok, indirme yok).
- Metin belgeleri: örneğin 2.000 belge × ortalama 20.000 karakter ≈ 10M belirteç → gömme ≈ **$0.20**. 100M belirteçte bile ≈ $2.
- Gerçek belge sayısı canlı ölçümle belirlenecek; panel kuyruk tahminini işlemden önce gösterir.

## 4. Panel — Marka Bilgi Merkezi → **Brand Brain** (`/bilgi/beyin`)

**Göstergeler** (hepsi veritabanı veya sağlayıcı durumundan okunur):
- Drive bağlantısı
- Erişilebilir arşiv boyutu ve dosya sayısı
- İçerik çıkarılan dosya sayısı ve kapsama yüzdesi
- Anlamsal arama kapsamı
- Bekleyen incelemeler ve çakışmalar
- Hatalar ve desteklenmeyen biçimler
- İşleyici kuyruğu
- Kaynak erişim başarısı (30 gün) ve ortalama gecikme
- Harcama
- pgvector durumu

**Eylemler:**
- Arşivde arama (işaretliler dahil)
- "Uzman testi": rol seçilir, ajanın göreceği bağlam birebir gösterilir
- Çıkarılan içeriği ve kaynak bağlantısını inceleme
- Toplu iddia onayı/reddi
- Hatalı dosyayı veya tümünü tekrar deneme
- Değişenleri yeniden işleme
- Duraklatma/sürdürme
- Gömmeyi açma/kapatma
- Toplu tutar onayı ve bütçe ayarları

## 5. Değişen dosyalar

**Yeni dosyalar:**
- Geçiş: `migrations/007_brand_brain.sql`
- Brand Brain modülleri: `src/lib/brain/{parsers,classify,ingest,claims,retrieval,context,embeddings,settings,worker,status}.ts`
- Eylemler ve panel: `src/app/actions/brain.ts`, `src/app/(panel)/bilgi/beyin/page.tsx`
- Betikler: `scripts/brain-baseline.ts`, `scripts/brain-live-check.ts`
- Testler: `tests/brand-brain.test.ts`, `tests/fake-drive.ts`, `tests/brain-fixtures.ts`

**Değişen dosyalar:**
- `src/lib/orchestrator/engine.ts`: erişim öncelikli bağlam + kaynak kaydı
- `worker/index.ts`: Brand Brain döngüsü
- `src/lib/drive/indexer.ts`: video süresi
- Taslak sayfası: kaynaklar bölümü
- `src/app/(panel)/bilgi/page.tsx`, `src/lib/nav.ts`: bağlantılar
- `Dockerfile` ve CI: `poppler-utils`
- `scripts/release/smoke-media.ts`: üretim imajında PDF/DOCX ayrıştırma kontrolü
- Geçiş listesi testleri ve a11y sayfa listesi

**Dokunulmayanlar:** PR Ajansı, ana ekran, ürün doğrulama kuralları ve Video Stüdyosu mantığı değişmedi. PR uzmanları, mevcut görev motoru üzerinden yeni bağlamı alır.

## 6. Testler (gerçek komut çıktısı rapordadır)

`tests/brand-brain.test.ts`: gerçek ayrıştırıcılar, gerçek PostgreSQL tam metin araması ve gerçek görev motoru. **Drive, gömme sağlayıcısı ve dil modeli sahtedir.**

Kapsanan durumlar:
- üst verinin aranabilir hâle gelmesi
- Google Dokümanı, PDF, DOCX, PPTX, Markdown, XLSX ve Google E-Tablo
- yinelenen dosya
- değişen belgenin yeniden işlenmesi (yalnızca o dosya indirilir)
- silinen belgenin geçersiz kılınması
- işleyici çökmesinden kurtarma
- desteklenmeyen/bozuk/taranmış dosyalar
- rol ve marka yalıtımı
- komut enjeksiyonu
- çakışan iddialar
- doğrulanmamış ürün referansı ve sahip doğrulaması
- atıflar ve ajan bağlamına ekleme
- bütçe: kapalı, fiyat bilinmiyor, büyük toplu işlem onayı, sorgu bütçesi
- sağlayıcı hatası ve ölü mektup kuyruğu
- duraklatma
- sentetik erişim ölçümü

**Bu testler canlı Drive entegrasyonunun başarılı olduğunu göstermez.**

## 7. Bilinen sınırlamalar

- OCR, ses transkripsiyonu ve AI sınıflandırma uygulanmadı. Bunlar ücretlidir; sahip kararı ve sağlayıcı gerekir. Taranmış PDF'ler "metin katmanı yok" olarak işaretlenir.
- Eski `.doc`, `.ppt` ve `.xls` biçimleri yalnızca üst veri olarak işlenir; kaydedilen sınırlama, dosyanın DOCX veya Google Dokümanı olarak kaydedilmesini önerir.
- Tek dosya için içerik sınırı 60 MB'tır. Google dışa aktarımlarında Drive'ın kendi sınırı (10 MB) geçerlidir.
- Sayfa başına en çok 2.000 satır okunur, belge başına en çok 400 parça saklanır.
- Görsel ürün kimliği yalnızca sahip doğrulamasıyla belirlenir. Fotoğraflar için AI görsel analizi bu sürümde yok.
- Tam metin araması `simple` yapılandırmasını kullanır: dil bağımsızdır, kök bulma yapmaz.
- pgvector kurulu değilse anlamsal arama tam tarama yapar. Bu, yaklaşık 100 bin parçaya kadar uygundur; daha büyük arşivde eklenti önerilir.

## 8. Canlı doğrulama — **ENGELLENDİ** (bu oturum)

**Eksikler:**
- üretim veritabanı erişimi;
- sahibin Google Drive OAuth onayı;
- canlı doğrulama için onaylanmış küçük bir alt klasör.

**Hazırlanan adımlar** (dağıtımdan sonra Render Worker kabuğunda):
1. Başlangıç ölçümü (salt okunur): `npx tsx --tsconfig tsconfig.json scripts/brain-baseline.ts`
2. İşleyicinin ilk alımı bitirmesini bekleyin (Brand Brain panelinde kuyruk 0 olmalı).
3. `BRAIN_LIVE_BRAND="<marka adı>" npx tsx --tsconfig tsconfig.json scripts/brain-live-check.ts` çalıştırın. Çıktı:
   - dört koleksiyon için bulunan dosyalar
   - doğrulama etiketleri ve eksikler
   - çakışmalar
   - gecikme ve kapsama
4. AI Yöneticisi'ne "Rebirth için dört koleksiyonu anlatan PR kampanya taslağı hazırla" yazın. Taslak sayfasında "Kullanılan arşiv kaynakları" bölümünü kontrol edin. Bu adım gerçek modeli çağırır (mevcut Opus maliyeti).

## 9. Dağıtım ve geri alma (yalnızca sahip onayıyla)

1. `claude/video-engine-p0` ve ardından `claude/brand-brain` dalları üretim dalına (`claude/amazing-goodall-qkxupd`) birleştirilir.
2. Geçiş `007_brand_brain.sql` yalnızca ekleme yapar. Politika denetimi "additive" ve otomatik onaylanabilir sonucunu verir.
3. GitHub → Actions → **Release** → *Run workflow* çalıştırılır (önce `dry_run: true` önerilir).
4. İmaj `poppler-utils` içerir. CI duman testi imaj içinde PDF/DOCX ayrıştırmasını doğrular.
5. İşleyici Brand Brain döngüsünü kendiliğinden başlatır. İçerik alımı ücretsizdir, gömme kapalıdır.
6. İsteğe bağlı: anlamsal arama için Render ortamına `EMBEDDINGS_PROVIDER=openai|voyage` ve `EMBEDDINGS_API_KEY` eklenir (anahtar koda veya sohbete yazılmaz). Panelden gömme açılır ve tutar onaylanır.
7. İsteğe bağlı pgvector: Render PSQL'de `CREATE EXTENSION vector;` çalıştırılır. Büyük arşivde dizin de eklenir:
   `CREATE INDEX CONCURRENTLY kb_chunks_embedding_hnsw ON kb_chunks USING hnsw ((embedding::vector(512)) vector_cosine_ops) WHERE embedding_dims = 512;`

**Geri alma:**
- Önceki dağıtıma dönülür.
- Geçiş yalnızca ekleme yaptığından eski sürüm yeni tabloları yok sayar; veri kaybı olmaz.
- İçerik işlemeyi durdurmak için panelden "İşlemeyi duraklat" kullanılır.
