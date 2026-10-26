# ChatGPT → FriBee AI Manager köprüsü (Issue #10)

> **Durum: yalnızca kod hazır.** Bu dalda köprü kodu, testleri ve bağlayıcı spesifikasyonu var. **Köprü canlıda etkin
> DEĞİL** ve bu ChatGPT hesabında hiçbir bağlayıcı kurulmadı veya yetkilendirilmedi. Aşağıdaki "Etkinleştirme" adımları
> sahip tarafından tamamlanana kadar ChatGPT'den AI Manager'a doğrudan mesaj gönderilemez.

## Ne yapar

| Uç | Kapsam | Davranış |
|---|---|---|
| `POST /api/bridge/v1/instructions` | `instructions:submit` | `/sohbet` paneliyle **aynı** `submitInstruction` yolunu kullanır. `confirm_cost: true` yoksa hiçbir şey kaydetmez (önizleme). |
| `GET /api/bridge/v1/projects/{id}` | `status:read` | Proje, görev durumları ve son yönetici mesajları (yalnızca belirtecin markası). |

Spesifikasyon: [`docs/connector/ai-manager-bridge.openapi.yaml`](connector/ai-manager-bridge.openapi.yaml) (OpenAPI 3.1, ChatGPT Actions uyumlu).

Read-only yönetim API'si (PR #7) ayrı tutulmuştur; bu köprü onun koduna ve denetimlerine dokunmaz.

## Güvenlik denetimi (mevcut `/sohbet` akışı → köprü)

| Konu | Panel (`sendInstructionAction`) | Köprü |
|---|---|---|
| Kimlik | İmzalı oturum çerezi (`src/proxy.ts`) | `Authorization: Bearer fbb_<id>_<gizli>`; sunucuda yalnızca SHA-256 özeti, sabit süreli karşılaştırma. `/api/bridge/` oturum muafiyeti yalnızca bu belirteç kontrolüyle geçerlidir. |
| Yetki | Tek yönetici | Belirteç başına kapsam listesi (`status:read`, `instructions:submit`); en az yetki için okuma ve gönderme ayrı belirteç olabilir. |
| Marka yalıtımı | Marka çerezden, formdan alınmaz | Marka **belirtece bağlı**; gövdede marka alanı kabul edilmez (ek alan → 400). Başka markanın projesi 404 alır. |
| CSRF | Next server action + proxy köken kontrolü | Çerez kullanılmaz (CSRF uygulanamaz); proxy köken kontrolü yine geçerli. |
| Idempotency | Formdaki anahtar | Zorunlu `Idempotency-Key` başlığı, `bridge:<kimlik-id>:` ile ad alanlı (panel ve diğer belirteçlerle çakışmaz). Tekrar → aynı proje (`duplicate`). |
| Yeniden oynatma | — | `X-Bridge-Timestamp` ±5 dk penceresi + idempotency. |
| Maliyet onayı | Sahip panelde gönderir; işleyici bütçe sınırlarını uygular | `confirm_cost: true` zorunlu; yoksa önizleme. Kısa onaylar ("onaylıyorum", "devam et") **reddedilir** → plan onayı yalnızca panelde. Çalışma duraklatılmışsa 409. İşleyicideki bütçe/limit denetimleri aynen geçerli. |
| Hız sınırı | Giriş denemeleri | IP başına 60/dk; belirteç başına gönderim 10/saat, okuma 120/dk (bellek içi, tek web örneği varsayımı). |
| Denetim günlüğü | `project.create` (actor `user`) | Ek olarak `bridge.instruction_submit` (actor `bridge:<id>`); belirteç günlüğe yazılmaz, mesajlar `redact` edilir. |
| Girdi | 8000 karakter | Aynı sınır + katı şema, kontrol karakterleri temizlenir, gövde 20 KB, yalnızca JSON. |
| Durum çıktısı | — | Görev talimatları/çıktı içerikleri döndürülmez; hata ve mesajlar `redact` edilir. |

## Etkinleştirme (sahip, bu PR birleştirildikten SONRA — henüz yapılmadı)

1. Belirteç üret (yerel makinede; hiçbir yere yapıştırma):
   `node -e 'const c=require("crypto");const id="chatgpt1";const t="fbb_"+id+"_"+c.randomBytes(32).toString("base64url");console.log(t);console.error(id+"|"+c.createHash("sha256").update(t).digest("hex"))'`
   Stdout: belirteç (yalnızca ChatGPT'ye girilecek). Stderr: `<id>|<özet>`.
2. FriBee marka kimliğini (UUID) panelden al (Markalar → FriBee).
3. Render → aiops-web → Environment: `AI_MANAGER_BRIDGE_CREDENTIALS` = `chatgpt1|<özet>|<marka-uuid>|status:read,instructions:submit` — **"Save only"** (bkz. `docs/RELEASE.md`), sonra normal sürüm hattıyla dağıt.
4. ChatGPT → GPT oluştur → Configure → Actions → spesifikasyonu içe aktar, `servers.url` değerini canlı adresle değiştir. Authentication: **API Key → Bearer**, değeri 1. adımdaki belirteç.
5. GPT talimatına şunu ekle: "Önce `confirm_cost` olmadan gönder, önizlemeyi sahibe göster, sahip açıkça onaylarsa aynı Idempotency-Key ile `confirm_cost: true` gönder. Plan onaylarını panelde vermesini söyle."
6. Doğrulama: önce yalnızca `status:read` kapsamlı ayrı bir belirteçle `getManagerProjectStatus` dene.

**Rotasyon:** yeni `id` ile girdi ekle (`;` ile), ChatGPT'deki belirteci değiştir, eski girdiyi sil. Silinen girdi anında geçersizdir.
**İptal:** girdiyi sil veya değişkeni boşalt → köprü 404.

## Bilinen eksikler / açık konular

- **ChatGPT Actions ve başlıklar:** GPT Actions başlık parametrelerini modelin doldurmasına bırakır; model geçerli Unix zamanını güvenilir şekilde bilemeyebilir → `stale_request` hataları olası. Seçenekler: (a) sahip onayıyla zaman damgasını isteğe bağlı yapmak (yeniden oynatmaya karşı yalnızca idempotency kalır), (b) MCP sunucusu / ince bir aktarıcı. Karar sahibin.
- **OAuth/MCP yetkilendirmesi** uygulanmadı; şimdilik dönen (rotatable), kapsamlı statik Bearer belirteç.
- **Hız sınırı bellek içi**: birden fazla web örneğinde sınır örnek başına uygulanır.
- **Gönderim sonrası maliyet:** `confirm_cost: true` ile kabul edilen talimat, işleyici çalışınca yönetici modelini (ücretli) çağırır. Bütçe/limit denetimleri işleyicide geçerli; köprü bunları atlamaz ama gönderim anında tahmini tutar göstermez.
- Testler (`tests/bridge.test.ts`) bu çalıştırmada yerelde koşturulamadı; CI'a bırakıldı.
