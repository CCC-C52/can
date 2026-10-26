# FriBee marka bilgi sistemi ve 24 aylık PR yol haritası (issue #22)

Bu, ilk ve test edilebilir dilim. Kod saf TypeScript (`src/lib/knowledge/`): veritabanı migrasyonu yok, ağ çağrısı yok, ücretli yapay zekâ çağrısı yok, üretime hiçbir değişiklik yok.

## Uygulananlar

| Alan | Dosya | Durum |
| --- | --- | --- |
| Arşiv dizini: kategoriler, hassasiyet, salt okunur kapsam denetimi, marka kök klasörü yetkisi, artımlı eşitleme (changes belirteci), revizyon geçmişi, silinen dosya işareti | `archive.ts` | Bellek içi + sabit veri kaynağı |
| Bilgi grafiği: Brand, Collection, Product/SKU, Colorway, Design, Print, Asset, Story, Campaign, Supplier, Inventory, PR coverage, Decision; olgu durumu `extracted / confirmed / suggested / unknown` | `graph.ts` | Bellek içi |
| Dört tema (Space Alien siyah, Music beyaz, Anime turuncu, Save the Bee açık mavi) ve Mandala → Music; kaynak: sahip beyanı (issue #22) | `graph.ts` | Onaylı başlangıç verisi |
| Rol bazlı erişim (AI Yönetici, Video/Tasarım, Shopify/Pazarlama, PR, Finans); finans/tedarikçi/özel kısıtları | `access.ts` | Uygulandı |
| Kaynaklı arama: atıf, orijinal çözünürlüklü Drive bağlantısı, `source_missing` / `source_changed` / `index_stale` bayrakları, ürün sadakati notu | `retrieval.ts` | Uygulandı |
| İnceleme kuyruğu: OCR/görsel çıkarım, belirsiz ad, tema/görsel uyuşmazlığı, sınıflandırılamayan dosya; onay → kaynaklı kanonik olgu | `review.ts` | Bellek içi |
| PR Ajansı 24 aylık plan (Kasım 2026 – Ekim 2028, 8 çeyrek, 24 aylık inceleme) — **öneri** | `pr-roadmap.ts` | Uygulandı |
| Stüdyo panosu (salt okunur) | `src/app/(panel)/bilgi/page.tsx` | Uygulandı |
| Testler | `tests/brand-knowledge.test.ts` | Güvenlik, marka yalıtımı, artımlı eşitleme, atıf, izin, güncellik, eksik kaynak |

## Kurallar

- Ürün hikâyesi uydurulmaz: kaynaksız metin yalnızca `suggested` olabilir; `extracted` Drive dosyası, `confirmed` karar + kaynak ister.
- Onaylanmamış olgu yayınlanamaz (`assertPublishable`).
- `private` kayıtlar hiçbir ajana otomatik verilmez.
- Üretken model referansı ürün sadakatini garanti etmez; ürün baskısı için doğrulanmış kompozit kullanılır.
- PR planında geçmiş sonuç, pazar verisi, mevcut ortaklık veya sayısal hedef yoktur; hedefleri sahip Q1 temel ölçümünden sonra belirler.

## Sahip onayı / kimlik bilgisi gerektirenler

1. Google Drive OAuth istemcisi (yalnızca `drive.readonly` veya `drive.metadata.readonly`), FriBee kök klasör kimliği ve sahip onayı. `googleDriveSourceNotConfigured()` bilerek hata verir.
2. Kalıcı depolama (arşiv dizini, grafik, inceleme kuyruğu tabloları) için migrasyon — güvenlik incelemesi sonrası ayrı PR.
3. OCR/görsel çıkarım sağlayıcısı (ücretli olabilir; bütçe onayı gerekir).
4. PR ve Finans ajanlarının ajan kayıt defterine eklenmesi ve bağlam oluşturucuya (`buildBrandContext`) rol bazlı aramanın bağlanması.
5. Drive arşivi (#21) ve PR Ajansı (#14) çalışmalarıyla birleştirme; bu dallar bu taban dalda yok.
6. Her dış paylaşım, basın/creator iletişimi ve ücretli medya için sahip onayı.
