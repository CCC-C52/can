# Video kurgu hattı

Gerçek, yüklenmiş video baytlarından Instagram Reels uyumlu MP4 üretimi. Ücretli servis gerektirmez (yerel ffmpeg).

## Akış

```
Video seçimi → Analiz kapısı → Doğrulanmış sahneler → Kurgu planı (segments) → Kalite kontrolü
            → MP4 render → Çıktı doğrulaması → İnsan onayı (ret → revizyon → yeni render)
```

1. **Video seçimi.** Talimatta adı geçen dosya (adıyla, uzantısız adıyla veya kimliğiyle) bulunur. Yalnızca o markanın dosyaları eşleşir (`resolveVideoTargets`, `src/lib/orchestrator/engine.ts`). Hiçbiri anılmazsa en yeni 3 gerçek çekim aday olur.
2. **Analiz kapısı.** Video uzmanı çalışmadan önce her hedef videonun tamamlanmış analizi aranır (`ensureAnalysis`, `src/lib/media-analysis/index.ts`).
   - **Analiz yok** (ör. yeni kod öncesinde yüklenmiş dosya): mevcut analiz hattı başlatılır; yeniden yükleme gerekmez.
     - Kısa/küçük dosyalar (≤ 90 sn ve ≤ 100 MB) görev içinde işlenir.
     - Daha büyükleri işleyicinin analiz kuyruğunda işlenir. Görev "Hazır" durumunda bekler (deneme hakkı tüketmez, en fazla 30 dk).
   - **Analiz başarısız** (açıkça istenen dosya için): görev "Video analizi başarısız … Sahne uydurulmadı" hatasıyla başarısız olur ve proje "Engellendi" görünür.
3. **Gerçek kareler.** ffmpeg sahne tespiti yapılır; her sahnenin ortasından en fazla 6 kare çıkarılıp `brands/<marka>/analysis/<analiz>/frame-N.jpg` olarak saklanır.
   - Ücretli görsel model analizi yalnızca "Yüklemede AI görsel analizi" açıksa ve gerçek model bağlıysa yapılır.
4. **Video uzmanına giden kanıt.**
   - Her zaman: doğrulanmış sahneler (indeks, başlangıç/bitiş, kare zamanı, renk, parlaklık), varsa görsel model sahne özetleri ve analiz durumu.
   - İsteğe bağlı: gerçek kareler, görüntü olarak (Ayarlar → "Video uzmanına gerçek kareleri de göster", ücretli, varsayılan kapalı, en fazla 12 kare).
   - İstenen dosyalar 80 kayıtlık bağlam sınırından bağımsız olarak bağlama eklenir.
5. **Plan (`segments`).** Her bölüm şunları içerir: `asset_id`, `scene_index`, `source_start`, `source_end` (KAYNAK zamanı), `on_screen_text`.
   - Çıktı zaman çizelgesi bölümlerin sırasından hesaplanır.
   - `subtitles` alanı çıktı zamanını kullanır. Kaynak ve çıktı zamanı ayrı tutulur.
6. **Kalite kontrolü** (`qa-rules.ts`). Şunlar reddedilir:
   - bölüm yok;
   - dosya arşivde yok veya video değil;
   - görsel analiz yok;
   - analizde olmayan (uydurma) sahne;
   - sahne sınırı dışı (tolerans ±0,15 sn);
   - kaynak süresini aşan veya 0,5 sn'den kısa bölüm;
   - doğrulanmamış ürün iddiaları (mevcut kurallar).
   - Yönetici planındaki ayrı "video analizi" metin görevleri, başka bir video görevi varsa plandan çıkarılır.
7. **Render** (`src/lib/orchestrator/render.ts`, `src/lib/adapters/video-edit.ts`).
   - Bölümler tekrar doğrulanır: kaynak süresi ffprobe ile ölçülür; sahne sınırları analizden alınır.
   - Aynı dosyadan birden çok bölüm kesilebilir (dosya bir kez indirilir).
   - Aşamalı, düşük bellekli hat:
     1. her bölüm ayrı ffmpeg süreciyle 1080x1920 (9:16) yuv420p ara dosyaya;
     2. kesme: akış kopyasıyla birleştirme / geçiş: ikişer ikişer xfade;
     3. son geçiş: ekran metni (üst güvenli alan), altyazı (alt güvenli alan), H.264 High, 30 fps, `+faststart`.
   - Ürünün görünümü değiştirilmez: varsayılan çerçeveleme `fit` (kırpma yok), renk/ton filtresi yok.
   - **Ses bilinçli olarak kaldırılır** (müzik/ses lisansı manuel karar).
8. **Çıktı doğrulaması.**
   - ffprobe: codec h264, hedef boyut, beklenen süre (±0,5 sn).
   - Baştan sona hatasız çözme: `ffmpeg -v error -f null`.
   - Depoda varlık ve boyut eşleşmesi.
   - Medya kaydı (`origin=edited`, `generation_method=ffmpeg_edit`, proje ve köken bağı) ve çıktı sürümüne bağlanma.
   - Render sonucu (codec, çözünürlük, süre, bayt, bölüm sayısı) görev kaydında tutulur ve çıktı sayfasında gösterilir.
9. **Onay.**
   - Video planı MP4 doğrulanana kadar "tamamlandı" sayılmaz; sunucu, doğrulanmış bir MP4'ü olmayan sürümün onaylanmasını reddeder.
   - Ret → revizyon (not, uzmana geri bildirim olur) → yeni sürüm → yeni render → onay. Geçmiş değiştirilemez.
   - Otomatik yayın yoktur.

## AI video üretimi (Gemini, `generate_new`)

`src/lib/adapters/video-generation.ts` → `generateVideo`/`pollVideo` (`src/lib/orchestrator/render.ts`).

1. **Gönderim öncesi kapılar** (hiçbiri geçmezse sağlayıcıya istek gitmez):
   - Ayarlar'da ücretli AI medya üretimi açık (sahip izni) ve bağlantı hazır;
   - proje AI video saniye sınırı (`maxVideoGenSeconds`);
   - **birim fiyat tanımlı** (`GEMINI_VIDEO_COST_PER_SECOND_USD`); bilinmiyorsa bütçe sınırı kapalı olsa bile gönderilmez;
   - görev/günlük/sağlayıcı bütçesi (`assertBudget`).
2. **İdempotentlik.** `provider_jobs.idempotency_key = vid:<sürüm>:<video>`; tekrar işleme, işleyici değişimi ve yeniden deneme yeni gönderim yapmaz. Ağ hatasıyla belirsiz kalan gönderim `unknown` olur, otomatik tekrar edilmez.
3. **Kalite kapısı** (indirilen dosya, `generatedVideoIssues`):
   - ffprobe: video akışı, süre (istenen ±1 sn), yön (9:16 dikey), kısa kenar ≥ 720 px;
   - baştan sona hatasız çözme (`assertDecodes`);
   - **duyulabilir ses**: ses akışı var ve ortalama seviye ≥ −50 dB (`volumedetect`).
   - Kapıdan geçmeyen dosya arşive kaydedilir (ücreti ödenmiş olabilir) ama sürüme bağlanmaz; onay "MP4 yok" hatasıyla reddedilir. Tekrar işlemede de bağlanmaz ve yeniden gönderilmez.
4. **Köken.** Referans ürün fotoğrafları `media_lineage` ile, ürün kimliği `product_id` ile kaydedilir.

### Sağlayıcı sözleşmesi: doğrulanmamış noktalar

Bu depoda ve CI'da gerçek Gemini çağrısı yapılmadı. Bu nedenle aşağıdakiler **doğrulanmamış varsayımdır**. İlk ücretli pilotta (sahip onayıyla) kontrol edilmelidir:

- `GEMINI_VIDEO_MODEL` (varsayılan `gemini-omni-1.1-flash`) modelinin Interactions API üzerinden video üretip üretmediği. Ücretsiz kontrol: `GET /v1beta/models/<model>` (Entegrasyonlar → test). Bu yalnızca erişimi gösterir, video yeteneğini göstermez.
- `response_format.duration` biçimi (`"6s"`), izin verilen süreler (adaptör 3–10 sn varsayar), `resolution: "720p"`.
- Görsel girdi biçimi (`{ type: "image", data, mime_type }`) ve 1 / 2–3 fotoğrafın ilk kare / referans olarak yorumlanması.
- Çıktıda ses olup olmadığı. Ses yoksa kalite kapısı videoyu reddeder.
- Saniye fiyatı: sahip resmî fiyat sayfasından doğrulayıp tanımlamalıdır.

### FriBee pilot ve final

- **6–8 sn pilot:** tek üretim isteğiyle yapılabilir (sağlayıcı sınırı varsayımı 3–10 sn).
- **15 sn final:** tek istekle yapılamaz (`omniDuration(15) = 10`). İki üretim ve ffmpeg birleştirme gerekir. Bu birleştirme henüz yok. Mevcut kurgu hattı sesi bilinçli olarak kaldırır; sesli final için ses korunarak birleştirme eklenmelidir.
- **Ürün sınıflandırması:** bu depoda baskı/koleksiyon sınıflandırması yoktur ("Music mandala", "Space Alien" geçmez). Referans fotoğraflar yalnızca planda açıkça seçilen `selected_asset_ids` ile gönderilir. Doğru baskı sahip tarafından seçilmelidir; sistem baskı adı tahmin etmez.

## Ayarlar

| Ayar | Varsayılan | Not |
|---|---|---|
| Video/görsel render süre sınırı (`renderTimeoutMs`) | 20 dk | Küçük CPU'da kurgu uzun sürer; diğer görevlerin 3 dk sınırından ayrıdır |
| Video uzmanına gerçek kareleri göster (`video_agent_frames`) | Kapalı | Ücretli; görev başına en fazla 12 kare |
| Yüklemede AI görsel analizi (`vision_on_upload`) | Açık | Gerçek model bağlıysa ücretli; kapalıyken yalnızca yerel analiz |
| `FFMPEG_THREADS` (ortam) | 2 | x264 iş parçacığı |
| `FFMPEG_CONCURRENCY` (ortam) | 1 | Süreç başına aynı anda bir ffmpeg işi (analiz + kurgu çakışmaz) |

## Ölçümler (bu geliştirme ortamı: 4 vCPU, ffmpeg 6.1)

| İş | ffmpeg tepe RSS | Node RSS | Süre |
|---|---|---|---|
| 14,68 sn 1080x1920 video analizi (3 sahne, 3 kare) | 116 MB | — | 5,5 sn |
| Aynı kaynaktan 3 bölüm, kesme, 2 ekran metni → 9 sn 1080x1920 | 263 MB | 118 MB | 18,7 sn |
| 5 bölüm + giriş/kapanış kartı, geçiş (xfade), altyazı → 13,5 sn | 322 MB | 144 MB | 100 sn |
| Aynısı, `FFMPEG_THREADS=1` | 298 MB | 145 MB | 135 sn |

Karşılaştırma: önceki tek aşamalı hatta 5 bölümlük geçişli kurgu ffmpeg için yaklaşık 715 MB gerektiriyordu.

**512 MB'lık işleyici için sonuç.**
- Kesmeli kurgular rahatça sığar (~380 MB).
- Geçişli, çok bölümlü kurgular sınıra yakındır (~470 MB). Bellek baskısında `FFMPEG_THREADS=1` (~445 MB) veya `transition: cut` kullanılmalıdır.
- Süre daha büyük kısıttır: Render Starter 0,5 CPU'dur. Ölçülen süreler kabaca 8 kat uzar; 5 bölümlü geçişli kurgu ~10–15 dk sürebilir. Render süre sınırı bu yüzden 20 dk'dır.
- Güvenilir ve hızlı 1080x1920 üretim için işleyicinin Standard (2 GB, 1 CPU) planına alınması önerilir; bu bir maliyet kararıdır ve bu çalışmada değiştirilmedi.

## Bilinen sınırlamalar

- ffmpeg sahne skoru ağırlıklı olarak parlaklık farkına dayanır. Parlaklığı benzer iki farklı renkli sahne arasındaki kesme kaçırılabilir; iki sahne tek sahne sayılır. Plan yine o sahnenin içinde kalır, uydurma sahne üretilmez.
- ffmpeg kurgusunda ses korunmaz (bilinçli sessiz çıktı); müzik ve seslendirme eklenmez. AI üretiminde ses korunur ve zorunludur.
- En fazla 12 bölüm.
- Docker imajındaki ffmpeg 5.1'dir; testler ffmpeg 6.1 ile yapıldı. Kullanılan filtre ve seçenekler (xfade, subtitles, concat demuxer, `-filter_complex_threads`, `-x264-params`) 5.1'de mevcuttur, ancak 5.1 ile çalıştırılmadı.
- Gerçek FriBee videosu bu ortamda test edilmedi (erişim ve yetki yok). Kabul testi aynı özelliklerde (14,68 sn, 1080x1920, sesli) sentetik bir MP4 kullanır.

## Doğrulama

```bash
npm test -- tests/video-pipeline.test.ts   # gerçek MP4 uçtan uca kabul testi + birimler
npm test -- tests/render.test.ts           # kurgu, geçiş, kart, altyazı, eski plan reddi
```
