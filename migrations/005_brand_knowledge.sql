-- 005: FriBee marka bilgi sistemi — kaynaklı olgular (bilgi grafiği) ve inceleme durumu.
-- Yalnızca ekleme yapar (yeni tablo; mevcut tablo/veri değişmez).
--
-- Her satır bir varlığın (koleksiyon, ürün, tasarım/baskı, hikâye, kampanya, tedarikçi …) bir özniteliğidir.
-- status:
--   confirmed — sahip kararı ve kaynakla onaylı; ajanlara gerçek olarak verilir
--   extracted — arşiv dosyasından çıkarıldı (drive_item_id zorunlu); inceleme bekler, gerçek sayılmaz
--   suggested — sistem/ajan önerisi; inceleme bekler, gerçek sayılmaz
--   rejected  — sahip reddetti; hiçbir yerde kullanılmaz
-- sensitivity: rol bazlı erişim (public, internal, vendor, finance, private). "private" hiçbir ajana verilmez.
CREATE TABLE IF NOT EXISTS knowledge_facts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  entity_key     text NOT NULL CHECK (entity_key ~ '^[a-z0-9_]{1,80}$'),
  entity_type    text NOT NULL CHECK (entity_type IN ('brand','collection','product','colorway','design','print','asset','story','campaign','supplier','inventory','pr_coverage','decision')),
  entity_name    text NOT NULL CHECK (length(entity_name) BETWEEN 1 AND 200),
  attribute      text NOT NULL CHECK (attribute ~ '^[a-z0-9_]{1,60}$'),
  value          text NOT NULL CHECK (length(value) BETWEEN 1 AND 4000),
  status         text NOT NULL CHECK (status IN ('confirmed','extracted','suggested','rejected')),
  sensitivity    text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public','internal','vendor','finance','private')),
  -- Kaynak: Drive dosyası (dizindeki öğe) ve/veya açık kaynak açıklaması (ör. "Sahip talimatı 2026-10-26")
  drive_item_id  uuid,
  source_note    text CHECK (source_note IS NULL OR length(source_note) <= 500),
  method         text NOT NULL CHECK (method IN ('metadata','ocr','vision','owner','manual','document')),
  decided_by     text,
  decided_at     timestamptz,
  created_by     text NOT NULL DEFAULT 'user',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (drive_item_id, brand_id) REFERENCES drive_items (id, brand_id) ON DELETE SET NULL (drive_item_id),
  -- Onaylı olgu: karar ve kaynak zorunlu. Çıkarılan olgu: arşiv dosyası zorunlu.
  CHECK (status <> 'confirmed' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND (drive_item_id IS NOT NULL OR source_note IS NOT NULL))),
  CHECK (status <> 'extracted' OR drive_item_id IS NOT NULL OR source_note IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS knowledge_facts_brand_status ON knowledge_facts (brand_id, status);
CREATE INDEX IF NOT EXISTS knowledge_facts_entity ON knowledge_facts (brand_id, entity_key);
-- Aynı varlık + öznitelik için tek onaylı (kanonik) değer
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_facts_canonical ON knowledge_facts (brand_id, entity_key, attribute) WHERE status = 'confirmed';
