# P0 — Video üretim motoru: MP4 teslim edilmeden biten video görevleri

Tarih: 28 Ekim 2026 · Dal: `claude/video-engine-p0` · Etki: Video Uzmanı, kalite kontrolü, render, medya arşivi
Kapsam dışı (dokunulmadı): PR Ajansı, ana ekran, entegrasyonlar.

## 1. Belirti

- `black_oversized_tee.mp4` dosyasından istenen 12–15 sn'lik "Rebirth" teaser defalarca başarısız oldu.
- Video Uzmanı üretim ve inceleme aşamalarını tekrar tekrar tamamladı, ama doğrulanmış bir MP4 çıkmadı.
- Daha önce bir render görevi 12 ms'de, videosuz "başarılı" görünmüştü. Bu olay 28 Ekim sabahı düzeltilmişti (`video-truth.test.ts`). Bu P0 o düzeltmenin üzerine kuruludur.

## 2. Yol izleme (kod üzerinden)

```
Kullanıcı talebi → submitInstruction (projects.ts)
  → plan görevi: AI Yöneticisi (engine.runPlan) → video görevi
  → video analizi kapısı (engine.videoAnalysisGate → ensureAnalysis: ffprobe + sahne tespiti + kareler)
  → Video Uzmanı (engine.runGenerate) → VideoPlan (schemas.VideoPlanSchema)
  → kalite kontrolü (engine.runReview: kurallar + model incelemesi)
       ✗ ÇALIŞMA BURADA DURUYORDU
  → render görevi (engine.spawnFollowUps → engine.runRender → render.renderVideo)
  → ffmpeg (video-edit.renderEdit) → depo (saveDerivedAsset) → medya arşivi (/api/media/:id/file)
```

## 3. Yeniden üretim (düzeltmeden ÖNCE, gerçek motor + gerçek ffmpeg)

Sentetik `black_oversized_tee.mp4` kullanıldı: 1080x1920, 4 sahne, 440 Hz kaynak ses. Ücretsiz, Claude benzeri sahte bir model plan üretti. Ölçülen sonuçlar:

| Senaryo | Plan çağrısı | İnceleme çağrısı | Sonuç |
|---|---|---|---|
| R1: ideal plan (bölümler + REBIRTH giriş kartı + FriBee kapanış kartı) | 1 | 1 | MP4 üretildi, ama **17 sn** (12–15 isteniyordu), **ses izi yok**, kapak 1,5 sn'den değil |
| R2: bölüm, sahne sınırını 0,6 sn aşıyor | **4** | **4** | `failed: Kalite kontrolünden geçemedi (yeniden üretim sınırı doldu)` — **MP4 yok** |
| R3: teknik olarak geçerli plan, model incelemesi itiraz ediyor | **4** | **4** | `failed` — **MP4 yok** |
| R4: kimlik yerine dosya adı (`black_oversized_tee.mp4`) | **4** | **4** | `failed` — **MP4 yok** |

**Kök neden.** `runReview`, deterministik olarak düzeltilebilecek teknik plan hatalarını AI planlayıcıya "yaratıcı revizyon" olarak geri gönderiyordu: sahne sınırı, kaynak kimliği, altyazı zamanı. Model incelemesinin itirazlarını da aynı şekilde gönderiyordu. Bu döngü en fazla 3 kez tekrarlanıyordu. Her tur bir Opus plan çağrısı ve bir Opus inceleme çağrısı demekti. Sonunda görev başarısız oluyor, render görevi hiç açılmıyordu. Ayrıca istenen süre, kapak karesi ve ses izi hiçbir yerde ölçülüp zorlanmıyordu.

## 4. Düzeltme (deterministik kod; prompt değiştirilmedi)

**Plan doğrulaması** — `src/lib/video/plan-validation.ts`, yeni, AI kullanmaz:
- Kaynak kimlikleri veritabanından çözülür. Dosya adı yazılmışsa kimliğe çevrilir. Yalnızca bu markanın, analizi tamamlanmış videoları kabul edilir.
- Bölümler kaynak süresine kırpılır. Sahne sınırını aşan bölümler analizdeki sahnelerde bölünür (sahne uydurulmaz).
- Çıktı süresi giriş/kapanış kartları dahil hesaplanır ve sahibin istediği aralığa getirilir:
  - uzunsa bölümler orantılı kısaltılır;
  - kısaysa sahne içinde uzatılır veya yeni doğrulanmış sahne eklenir.
- Altyazılar çıktı süresine kırpılır.
- Plan bölüm vermediyse ama sahip belirli bir videoyu istediyse, kurgu doğrulanmış sahnelerden kurulur.
- Düzeltilmiş plan yeni sürüm olarak kaydedilir (`system:plan-validator`). Render tam olarak bu sürümü uygular.
- Onarılamayan teknik sorun görevi açık bir hatayla durdurur. Örneğin: "kurgu için kullanılabilir kaynak video yok". Bu durumda AI'ya yeniden üretim **gönderilmez** ve ücretli inceleme **yapılmaz**.

**Teslim şartları** — `src/lib/video/spec.ts`, yeni:
- Süre aralığı talimattan okunur: "12-15 saniyelik", "12–15 sn", "12 to 15 seconds" veya Stüdyo'nun "Reklam süresi" satırı.
- Kapak anı da talimattan okunur: "kapak 1.5. saniyeden", "cover frame at 1.5 s".

**Kalite kontrolünün ayrılması** — `engine.runReview`:
1. Deterministik plan doğrulaması
2. Kural denetimi
3. Model incelemesi (yalnızca kurallar geçerse; önbellekten gelen planda tekrarlanmaz)
4. Render
5. MP4 doğrulaması
6. İnsan onayı

Ek kurallar:
- Video planında yaratıcı revizyon hakkı en fazla **1**'dir (`VIDEO_PLAN_MAX_REGENERATIONS`).
- Hak bittiğinde model itirazları "danışma" olarak insan onayına taşınır. MP4 insan onayı olmadan kullanılmaz.

**Render ve doğrulama** — `video-edit.ts`, `render.ts`, `src/lib/video/verify.ts`:
- Kaynak ses (lisansı bilinmeyen) her zaman kaldırılır. Müzik yoksa **sessiz AAC** izi eklenir (48 kHz stereo).
- Kapak karesi, istenen saniyede kaynak videodan alınır.
- Her MP4 depoya yazıldıktan sonra **depodan geri okunur** ve şunlar kontrol edilir:
  - boyut ve sha256;
  - `ffprobe` ile H.264, yuv420p, 1080x1920, istenen süre aralığı ve AAC;
  - tam çözme: `ffmpeg -v error -i out.mp4 -f null -`.
  - Geçmeyen yeni kayıt geri alınır, böylece arşivde açılamayan "hayalet" video kalmaz.
- Hata türleri ayrı ele alınır:
  - depo yazma/okuma hatası geçicidir: görev sınırlı sayıda yeniden dener;
  - ffmpeg hatası ve doğrulama hatası kalıcıdır: görev başarısız olur, plan yeniden üretilmez;
  - kaynak dosya depoda yoksa açık bir hata verilir.

**Gemini hattı:**
- İndirilen AI sahnesi tam çözme ve depo bayt kontrolünden geçer.
- Geçici indirme/depo hatasında sağlayıcıya yeniden ücretli gönderim yapılmaz; yalnızca indirme (sınırlı) tekrarlanır.
- Ücretli üretim varsayılan olarak kapalıdır.

**Maliyet:**
- Teknik hata AI döngüsüne girmez.
- Kurallar geçmeden model incelemesi yapılmaz.
- ffmpeg çıktısını hiçbir model denetlemez.
- Doğrulanmış plan önbellekte tutulur: aynı talep, render teknik nedenle başarısız olduktan sonra tekrar gönderilirse ne plan ne inceleme çağrısı yapılır.
- Model kullanımı mevcut `cost_entries` kaydına yazılır.

## 5. Kanıt (yerel, gerçek ffmpeg 6.1.1, PostgreSQL 16, S3 taklidi)

`tests/video-engine-p0.test.ts` (14 test). Rebirth teaser'ın **depodan geri okunan** dosyası üzerinde:

```
ffprobe: {"streams":[{"codec_name":"h264","profile":"High","codec_type":"video","width":1080,"height":1920,"pix_fmt":"yuv420p"},
          {"codec_name":"aac","profile":"LC","codec_type":"audio","sample_rate":"48000","channels":2}],
          "format":{"duration":"14.730000","size":"68504"}}
ffmpeg -v error -i out.mp4 -f null - → stderr: ""
volumedetect max_volume: -91 dB   (kaynaktaki 440 Hz ses kaldırıldı)
```

Düzeltmeden sonra aynı senaryolar:
- R1–R4 tek plan + tek inceleme ile 12–15 sn MP4 üretiyor.
- R3 en fazla 2 + 2 çağrı yapıyor.

Testler şunları kapsar:
- edit_existing → MP4;
- compose → MP4;
- eksik kaynak → açık hata;
- ffmpeg hatası → başarısız;
- depo hatası → başarısız;
- bozuk depo kopyası → başarısız ve kayıt geri alınır;
- başarı → doğrulanmış medya kaydı;
- `/api/media/:id/file` → 206 ve aynı sha256;
- çıktı yok → asla "tamamlandı" değil;
- teknik hata → AI yeniden üretim döngüsü yok;
- Gemini sahte akışı (gönder → sorgula → indir → depola) ve ücretli üretim kapalıyken sıfır gönderim.

## 6. Canlıya alma (yalnızca sahip onayıyla)

Yeni geçiş (migration) yoktur. Veri modeli değişmedi.

1. `claude/video-engine-p0` dalını üretim dalına (`claude/amazing-goodall-qkxupd`) birleştirin (fast-forward).
2. GitHub → Actions → **Release** → *Run workflow* → dal: `claude/amazing-goodall-qkxupd`. Girdiler boş kalır; `dry_run` önce `true` ile denenebilir.
3. Hat şunları kendi yapar:
   - denetimler: tip, vitest, derleme, HTTP, a11y, e2e, imaj içinde `smoke-media` (artık AAC ve tam çözmeyi de doğrular);
   - web ve işleyici dağıtımı;
   - sağlık ve sürüm doğrulaması.
4. Dağıtım sonrası doğrulama:
   - Sistem Durumu'nda web ve işleyici commit'i yeni sürümü göstermeli.
   - AI Yöneticisi'ne şunu yazın: "black_oversized_tee.mp4 dosyasından 12-15 saniyelik Rebirth teaser videosu hazırla (9:16, kapak 1.5. saniyeden, orijinal ses kaldırılsın)".
   - Render görevinin sonucunda şunlar görünmeli: `codec h264`, `pix_fmt yuv420p`, `1080x1920`, `audio_codec aac`, `storage_verified true`, `sha256`, `cover_source_s 1.5`.
   - Video Medya Arşivi'nde açılmalı.

**Geri alma:** Release hattının geri alma politikası geçerlidir. Alternatif olarak Render panelinden önceki dağıtıma (b0c702a) dönülebilir. Veri geçişi olmadığı için geri alma güvenlidir.
