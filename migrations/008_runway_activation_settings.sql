-- Runway aktivasyonu (sahip talimatı, 2 Kasım 2026): FriBee ayarları.
--   Runway gen4.5 fiyatı: 12 kredi/saniye, 0,01 USD/kredi (5 sn sahne = 0,60 USD)
--   Proje başına AI video sınırı: 60 saniye
--   Birincil video sağlayıcısı: Runway (ikincil Gemini)
--   Günlük toplam AI bütçesi: 20 USD korunur — kayıt yoksa 20 yazılır; kayıtta başka bir değer varsa DEĞİŞTİRİLMEZ
-- Ücretli medya üretimi izni (paidMediaGeneration) ve diğer tüm ayarlar DEĞİŞTİRİLMEZ (JSON birleştirme).
-- Yalnızca gerçek (örnek olmayan) bir marka varsa uygulanır: boş/yeni veritabanında (test, yerel) işlem yapmaz.
-- Önceki ve yeni değerler audit_log'a yazılır.

INSERT INTO settings (key, value, updated_at)
SELECT 'limits', '{}'::jsonb, now()
WHERE EXISTS (SELECT 1 FROM brands WHERE is_sample = false)
ON CONFLICT (key) DO NOTHING;

WITH before AS (
  SELECT value FROM settings WHERE key = 'limits' AND EXISTS (SELECT 1 FROM brands WHERE is_sample = false) FOR UPDATE
), patched AS (
  UPDATE settings s SET
    value = s.value
      || jsonb_build_object(
           'videoPrimaryProvider', 'runway',
           'runwayModel', 'gen4.5',
           'runwayCreditsPerSecond', 12,
           'runwayUsdPerCredit', 0.01,
           'maxVideoGenSeconds', 60)
      || CASE WHEN s.value ? 'dailyBudgetUsd' THEN '{}'::jsonb ELSE jsonb_build_object('dailyBudgetUsd', 20) END,
    updated_at = now()
  FROM before
  WHERE s.key = 'limits'
  RETURNING s.value AS after, before.value AS before
)
INSERT INTO audit_log (actor, action, message, data)
SELECT 'migration:008', 'settings.video_activation',
  'Runway aktivasyonu: gen4.5 12 kredi/sn × 0,01 $/kredi (5 sn = 0,60 $), proje AI video sınırı 60 sn, birincil sağlayıcı Runway; günlük bütçe '
    || COALESCE(after->>'dailyBudgetUsd', 'sınırsız') || ' $' || CASE WHEN before ? 'dailyBudgetUsd' THEN ' (kayıtlı değer korundu)' ELSE ' (kayıt yoktu, 20 yazıldı)' END
    || '; ücretli medya üretimi izni değiştirilmedi (' || COALESCE(after->>'paidMediaGeneration', 'kayıt yok = kapalı') || ').',
  jsonb_build_object(
    'before', jsonb_build_object(
      'videoPrimaryProvider', before->'videoPrimaryProvider', 'runwayModel', before->'runwayModel',
      'runwayCreditsPerSecond', before->'runwayCreditsPerSecond', 'runwayUsdPerCredit', before->'runwayUsdPerCredit',
      'maxVideoGenSeconds', before->'maxVideoGenSeconds', 'dailyBudgetUsd', before->'dailyBudgetUsd', 'paidMediaGeneration', before->'paidMediaGeneration'),
    'after', jsonb_build_object(
      'videoPrimaryProvider', after->'videoPrimaryProvider', 'runwayModel', after->'runwayModel',
      'runwayCreditsPerSecond', after->'runwayCreditsPerSecond', 'runwayUsdPerCredit', after->'runwayUsdPerCredit',
      'maxVideoGenSeconds', after->'maxVideoGenSeconds', 'dailyBudgetUsd', after->'dailyBudgetUsd', 'paidMediaGeneration', after->'paidMediaGeneration'))
FROM patched;
