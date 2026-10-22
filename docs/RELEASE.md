# Otomatik sürüm hattı (GitHub Actions → Render)

Bu belge, kodun canlıya nasıl alındığını, hattın hangi koşullarda durduğunu ve sorun anında ne yapılacağını anlatır.
Durum etiketleri: **UYGULANDI** (kod var) · **TEST EDİLDİ** (yerel/CI kanıtı) · **CANLIDA DOĞRULANMADI** (gerçek bir yetkili dağıtım henüz yapılmadı).

> Hat, gerçek ve yetkili bir uçtan uca dağıtımı başarıyla tamamlayana kadar **canlıda doğrulanmış sayılmaz**.

---

## 1. Mimari

```
geliştirme commit'i ──push──▶ GitHub
                               │
          ┌────────────────────┴─────────────────────┐
   PR / diğer dallar                          üretim dalı (claude/amazing-goodall-qkxupd)
   CI iş akışı (ci.yml)                       Release iş akışı (release.yml)
   └─ _checks.yml (gizli değer YOK)           ├─ _checks.yml (aynı denetimler)
                                              ├─ gate: üretim dalı mı? otomatik dağıtım etkin mi?
                                              └─ deploy  [environment: production, tek seferde bir dağıtım]
                                                  1 CI sonucu
                                                  2 commit = dal başı
                                                  3 Render servisleri: doğru dal, askıda değil, Render otomatik dağıtımı KAPALI
                                                  4 canlı durum: /api/health, /api/release/status
                                                  5 daha önce başarısız olmuş commit → dur
                                                  6 geçiş güvenlik kapısı (migrations/policy.json)
                                                  7 bekleyen geçiş varsa: kurtarma noktası kanıtı (Render PITR veya R2 yedeği)
                                                  8 aiops-web dağıtımı (Render API) → durum izleme (live olana kadar)
                                                  9 web doğrulaması: sağlık 200, DB, commit = sürüm, bekleyen geçiş yok
                                                 10 aiops-worker dağıtımı (AYNI commit) → durum izleme
                                                 11 işleyici kalp atışı bu commit ile canlı
                                                 12 son operasyonel kontrol → rapor (iş özeti, release-report.json, panel)
                                              └─ alert: başarısızlıkta GitHub sorun kaydı
```

- Render dağıtımı resmi Render REST API ile yapılır (`POST /v1/services/{id}/deploys` + `commitId`, durum izleme `GET …/deploys/{deployId}`, geri alma `POST …/rollback`, PITR durumu `GET /v1/postgres/{id}/recovery`). Uçlar Render'ın resmi CLI'sinin OpenAPI'den üretilmiş istemcisiyle doğrulandı.
- Render'ın kendi otomatik dağıtımı (Auto-Deploy, Blueprint Auto Sync) **kapalı kalır**. Hat bunu her sürümde denetler; açık bulursa durur. Böylece iki ayrı dağıtım mekanizması olmaz.
- Geçişler, web dağıtımının ön dağıtım komutunda (`preDeployCommand: npm run db:migrate`) uygulanır. Hat geçişleri **dağıtımdan önce** politikaya göre değerlendirir. Uygulama da üretimde geçiş uygulamadan önce aynı politikayı ayrıca denetler (ikinci savunma hattı; elle yapılan dağıtımlarda da geçerli).

### Dosyalar

| Dosya | Görev |
|---|---|
| `.github/workflows/_checks.yml` | Ortak denetimler: tip, geçiş politikası, gitleaks (tüm geçmiş), actionlint; vitest (PostgreSQL 17 + S3 taklidi + ffmpeg); üretim derlemesi + HTTP güvenlik + axe + uçtan uca (Google Chrome ile H.264 oynatma); Docker imajı + imaj içinde ffmpeg ile gerçek MP4 kurgusu |
| `.github/workflows/ci.yml` | PR ve geliştirme dalları; gizli değer kullanmaz, dağıtım yapmaz |
| `.github/workflows/release.yml` | Üretim dalı: denetimler → karar → dağıtım → bildirim |
| `scripts/release/render-api.ts` | Render API ve uygulama sürüm uçları istemcisi (yeniden deneme, zaman aşımı, çift dağıtım koruması) |
| `scripts/release/orchestrate.ts` | Sıralı dağıtım, doğrulama, geri alma politikası, rapor |
| `scripts/release/deploy.ts` | İş akışı giriş noktası |
| `scripts/release/smoke-media.ts` | Üretim imajında gerçek MP4 kurgusu ve doğrulaması |
| `src/lib/db/migration-safety.ts`, `migrations/policy.json`, `scripts/check-migrations.ts` | Geçiş sınıflandırma ve politika |
| `src/lib/release.ts`, `src/app/api/release/{status,events}` | Belirteçli sürüm durum/olay uçları; Sistem Durumu'nda sürüm geçmişi |
| `.gitleaksignore` | Yalnızca bilinçli sahte test değerinin tam parmak izi |

---

## 2. Gerekli yapılandırma (sahip yapar; değerler sohbete veya koda yazılmaz)

### GitHub → Settings → Environments → `production`

- **Deployment branches:** yalnızca `claude/amazing-goodall-qkxupd` (Selected branches).
- (Önerilir) **Required reviewers:** ilk etkinleştirme için sahip. Sonra kaldırılabilir veya tutulabilir.
- **Environment secrets:**

| Ad | Nereden | Not |
|---|---|---|
| `RENDER_API_KEY` | Render → Account Settings → API Keys | Render API anahtarları hesap genelidir (servis bazlı kısıtlanamaz); yalnızca bu ortamda tutulur |
| `RENDER_WEB_SERVICE_ID` | Render → aiops-web → Settings (`srv-…`) | |
| `RENDER_WORKER_SERVICE_ID` | Render → aiops-worker → Settings (`srv-…`) | |
| `RENDER_POSTGRES_ID` | Render → aiops-db → Info (`dpg-…`) | PITR kurtarma noktası kanıtı için |
| `PROD_BASE_URL` | aiops-web genel adresi (`https://…onrender.com`) | Günlüğe yazılmaz |
| `RELEASE_STATUS_TOKEN` | Rastgele, en az 32 karakter (ör. `openssl rand -base64 48`) | **Aynı değer** Render → aiops-web → Environment'a da girilir |

### GitHub → Settings → Secrets and variables → Actions → **Variables**

| Ad | Değer |
|---|---|
| `PRODUCTION_BRANCH` | `claude/amazing-goodall-qkxupd` |
| `AUTO_DEPLOY_ENABLED` | İlk etkinleştirme başarıyla doğrulanana kadar **boş/false**; sonra `true` |
| `AUTO_ROLLBACK` | `false` (varsayılan). `true` ise başarısız doğrulamada uygulama önceki Render dağıtımına geri alınır; veritabanı asla geri alınmaz |

### GitHub → Settings → Actions → General

- Actions etkin. Workflow permissions: **Read repository contents** (iş akışları gereken izinleri kendileri ister).

### Render

- aiops-web → Environment: `RELEASE_STATUS_TOKEN` (GitHub'dakiyle aynı).
- aiops-web ve aiops-worker → Settings → Auto-Deploy: **Off** (değişmez). Blueprint → Auto Sync: **Off** (değişmez).
- Servislerin bağlı dalı: `claude/amazing-goodall-qkxupd` (mevcut durum).

---

## 3. Geçiş güvenliği

- `migrations/policy.json`: her geçişin sha256 özeti ve sınıfı. Uygulanmış bir geçiş dosyası değiştirilemez veya silinemez (CI ve üretim kodu reddeder).
- Sınıflandırıcı (`src/lib/db/migration-safety.ts`):
  - **destructive**: DROP TABLE/COLUMN, TRUNCATE, DELETE, sütun türü değişikliği, yeniden adlandırma → **asla otomatik uygulanmaz**;
  - **review**: UPDATE/INSERT, DO bloğu, fonksiyon/tetikleyici, NOT NULL ekleme, mevcut satırları doğrulayan kısıt, CONCURRENTLY, tanınmayan ifade → insan incelemesi ve politika kaydı gerekir;
  - **additive**: `CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` (NOT NULL ise varsayılanlı), `NOT VALID` kısıt, `COMMENT` → politika uygunsa **otomatik**.
- `003_brand_memory_research.sql`: sınıflandırma **additive**. Yalnızca üç yeni tablo ve indeksler ekler (`brand_memory`, `research_runs`, `research_sources`); mevcut tablo veya veri değişmez. `IF NOT EXISTS` ile tekrar çalıştırılabilir, tek işlem (transaction) içinde uygulanır. Eski sürüm (9cb052e) bu tabloları bilmez ve etkilenmez, yani dağıtım sırasında eski ve yeni kod aynı şemayla çalışabilir.
- **003'ün ilk canlı uygulaması** politikada `requires_owner_authorization` olarak işaretli. İş akışı ancak `authorize_migrations=003_brand_memory_research.sql` girdisi **ve** doğrulanmış kurtarma noktası varsa ilerler.
- Sonraki **additive** geçişler: sahip onayı gerekmeden, yalnızca kurtarma noktası kanıtıyla otomatik ilerler. Diğer sınıflar engellenir.
- Geri alma sınırı: geçişler geri alınmaz (aşağı geçiş yok). Ekleme yapan geçişlerde uygulama geri alınsa bile şema yerinde kalır ve eski kod çalışır. Yıkıcı değişiklik otomatik hatta hiç yer almaz.

## 4. Yedek ve kurtarma

| Mekanizma | Konum | Hat nasıl doğrular | Durum |
|---|---|---|---|
| Render Postgres PITR | Render (aiops-db) | `GET /v1/postgres/{id}/recovery` → `AVAILABLE` | **Doğrulanmadı** (bu ortamdan Render'a erişim yok; hat ilk çalıştırmada okur) |
| Uygulama yedeği (pg_dump + medya) | `BACKUP_S3_BUCKET` (R2), işleyici günlük UTC 02:00, 14 gün saklama | Durum ucunda `backup.lastOk` ≤ 26 saat | **Doğrulanmadı** (canlı veritabanı okunmadı); yeni sürümde durum ucuyla görünür |

- Bekleyen geçiş varken iki kanıttan biri yoksa sürüm **engellenir** ve eksik gereksinim raporlanır.
- Hat veritabanını **hiçbir zaman otomatik geri yüklemez**.
- Elle kurtarma:
  - **Render PITR:** aiops-db → Recovery → zaman seç → yeni veritabanı oluşur. Doğrulayıp servislerin `DATABASE_URL` değerini çevirin.
  - **R2 dökümü:** `RESTORE_CONFIRM=evet npm run db:restore -- latest` (yetkili, ayrı bir ortamda).
- Kurtarma provası (gerçek geri yükleme denemesi) bu çalışmada **yapılmadı**.

## 5. Hata durumları

| Durum | Hat ne yapar | Canlıdaki etki |
|---|---|---|
| Testler başarısız | Dağıtım başlamaz | Yok |
| Yanlış dal / eski commit / Render otomatik dağıtımı açık | Engellenir | Yok |
| Daha önce başarısız olmuş commit | Engellenir (`allow_redeploy_of_failed` ile bilinçli tekrar) | Yok |
| Yıkıcı veya onaysız geçiş | Engellenir | Yok |
| Kurtarma noktası yok (bekleyen geçiş varken) | Engellenir | Yok |
| Web derleme/ön dağıtım (geçiş) başarısız | Durur, işleyici dağıtılmaz | Render önceki web sürümünü korur |
| Web canlı ama doğrulanamadı | Durur, işleyici dağıtılmaz; `AUTO_ROLLBACK=true` ise web önceki dağıtıma geri alınır | Geri alma kapalıysa yeni web canlı kalır (rapor açıkça söyler) |
| İşleyici dağıtımı başarısız | Durur | Render önceki işleyiciyi korur; web yeni sürümde (karışık sürüm raporlanır) |
| İşleyici kalp atışı gelmedi | Durur; `AUTO_ROLLBACK=true` ise işleyici geri alınır | Karışık sürüm raporlanır |
| Süre aşımı | Dağıtım iptal edilir | Önceki sürüm canlı kalır |
| Render API geçici hata | Sınırlı yeniden deneme. POST tekrarında önce aynı commit için oluşmuş dağıtım aranır (çift dağıtım yok) | — |

- Sonsuz yeniden deneme yoktur. Başarısız sürüm için GitHub'da sorun kaydı açılır. Rapor iş özetinde ve `release-report.json` yapıtında (90 gün) saklanır.
- **Elle kurtarma (istisnai durum):**
  1. Panel → Ayarlar → **Tüm işlemleri durdur**.
  2. Render → servis → Events → son başarılı dağıtım → **Rollback**: önce web, sonra işleyici, aynı commit.
  3. `/api/health` ve Sistem Durumu'nu kontrol et.
  4. **İşlemleri devam ettir.**
  5. Veritabanı yalnızca veri bozulduysa ve sahip kararıyla PITR ile kurtarılır.

## 6. Gözlemlenebilirlik

- **GitHub:** her çalıştırmanın özetinde adım tablosu, commit, dağıtım kimlikleri, geçiş ve kurtarma noktası kanıtı, geri alma durumu.
- **Panel → Sistem Durumu → "Sürüm ve dağıtım":**
  - web ve işleyici commit'i (Render'ın `RENDER_GIT_COMMIT` değeri);
  - farklı commit uyarısı;
  - hattın bildirdiği sürüm geçmişi (başarılı/başarısız/engellendi/geri alındı).
- Hat bir olay bildirmediyse panel başarı göstermez.

## 7. İlk etkinleştirme (bir kerelik, sahip onayıyla)

1. Bölüm 2'deki GitHub ortamı, gizli değerler ve değişkenler (`AUTO_DEPLOY_ENABLED` boş), Render'da `RELEASE_STATUS_TOKEN`.
2. Yetkili push: `bcba507` + Premium commit'leri + bu hat (force yok). Release iş akışı çalışır; testler koşar; karar adımı "otomatik dağıtım etkin değil" der ve **dağıtmaz**.
3. **Kuru çalıştırma:** Actions → Release → Run workflow:
   - `dry_run=true`
   - `legacy_applied_migrations=001_init.sql,002_media_jobs_integrity.sql`
   - `authorize_migrations=003_brand_memory_research.sql`

   Bu çalıştırma servis yapılandırmasını, geçiş kapısını ve kurtarma noktasını gerçek Render verisiyle denetler; dağıtım yapmaz.
4. **Gerçek ilk sürüm:** aynı girdilerle `dry_run=false`. Hat sırasıyla:
   - web'i dağıtır (ön dağıtımda 003 uygulanır);
   - web'i doğrular;
   - işleyiciyi dağıtır ve doğrular;
   - raporlar.
5. Başarıdan sonra `AUTO_DEPLOY_ENABLED=true`. Hat bundan sonra **canlıda doğrulanmış** sayılır.

## 8. Sonraki sürümler (tam otomatik)

Yetkili commit → üretim dalına push → testler → karar → web → doğrulama → işleyici → doğrulama → rapor. Render'da veya GitHub'da elle işlem gerekmez.

Hat yine de durur ve bildirir:
- testler başarısızsa;
- yıkıcı veya onaysız bir geçiş varsa;
- kurtarma noktası yoksa (bekleyen geçiş varken);
- aynı bozuk commit tekrar geliyorsa;
- bir servis doğrulanamazsa.

Hat yalnızca yazılım sürümünü otomatikleştirir. Sosyal yayın, reklam harcaması, satın alma veya ücretli API kullanımı için hiçbir yetki vermez; bunlar uygulamanın kendi onay kapılarına tabidir.

## 9. Maliyet

- **GitHub Actions:**
  - herkese açık depolarda standart çalıştırıcılar ücretsizdir;
  - özel depolarda aylık ücretsiz dakika kotası vardır;
  - bir Release çalıştırması kabaca 25–40 çalıştırıcı dakikası tüketir (4 paralel iş + dağıtım). Bu bir tahmindir, ölçülmedi.
- **Render:** her sürüm iki Docker derlemesidir (web + işleyici), ek ücret yoktur. Plan değişikliği yapılmadı.
- **Yeni ücretli servis yoktur.**
