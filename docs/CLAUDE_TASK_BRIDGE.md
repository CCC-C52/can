# FriBee Claude Code görev köprüsü

Amaç: ChatGPT'den gelen, sahip tarafından onaylanmış yazılım görevlerinin GitHub Issue üzerinden Claude Code'a iletilmesi, kodun ayrı bir dalda hazırlanması, Pull Request ve CI ile incelenmesi.

## Durum
Bu dosya ve iş akışı bir geliştirme dalındadır. Varsayılan dala alınmadan GitHub Issue tetikleyicisi çalışmaz. GitHub Actions'a `ANTHROPIC_API_KEY` secret olarak güvenli şekilde eklenmeden Claude Code başlatılamaz. Claude.ai Pro aboneliği API ücretini kapsamak zorunda değildir.

## Akış
1. FriBee sahibi ChatGPT'de görevi onaylar.
2. Yetkili GitHub bağlantısı ile `CCC-C52/can` deposunda bir Issue açılır. Issue açıklaması gereksinimleri, kabul kriterlerini, testleri ve açıkça yasaklı işlemleri belirtir. Gizli anahtarlar Issue'ya yazılmaz.
3. Sahip Issue'ya `claude-task` etiketi ekler (veya bunu açıkça onaylayıp yetkili otomasyona yaptırır).
4. İş akışı yalnızca depo sahibinin açtığı, açık durumdaki ve `claude-task` etiketli Issue için çalışır.
5. Claude Code ayrı dalda değişiklikleri yapar, PR açar. GitHub CI testleri çalıştırır.
6. ChatGPT GitHub PR, test ve commit sonuçlarını inceleyebilir. ChatGPT'nin Claude.ai sohbet oturumuna doğrudan erişimi yoktur. Kesintisiz izleme için ayrıca zamanlanmış kontrol gerekir.
7. Birleştirme, canlı Render deploy'u, ücretli video üretimi ve diğer harici değişiklikler için ayrıca sahip onayı alınır.

## Güvenlik
- `ANTHROPIC_API_KEY` yalnızca GitHub Actions Secrets içinde saklanır. Dosyalara veya ChatGPT sohbetine yazılmaz.
- Bu iş akışı doğrudan Render deploy etmez ve üretim sırlarına erişmez.
- GitHub Issue içeriği talimat enjeksiyonuna karşı risk taşıyabilir. Sahip kontrolü, PR incelemesi ve üretim erişiminin ayrılması gereklidir.
- İlk çalıştırmadan önce kullanılan `anthropics/claude-code-action@v1` sürümü, gerekli GitHub token izinleri, maliyet sınırları ve GitHub Actions güvenlik ayarları doğrulanmalıdır.
- Depo şu an public olduğundan iş akışı ve Issue metinleri herkesçe görülebilir. Gizli ticari bilgileri Issue'ya koymayın.
