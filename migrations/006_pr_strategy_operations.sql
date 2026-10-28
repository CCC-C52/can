-- 006: PR Ajansı — 2026–2034 marka stratejisi, zamanlanmış operasyon kayıtları ve profesyonel bilgi kütüphanesi.
-- Yalnızca ekleme yapar (yeni tablolar ve indeksler; mevcut tablo/veri değişmez). Başlangıç kayıtları uygulama
-- tarafından, sahibin isteğiyle ve "öneri" olarak eklenir; bu geçiş veri eklemez.

-- Strateji kalemleri: vizyon → aşama → yıllık hedef → çeyreklik OKR → aylık kampanya → haftalık uygulama.
-- provenance: owner (sahip yazdı) | ai_recommendation (öneri; gerçek değil) | framework (yayımlanmış çerçeveden türetildi)
-- status: proposed (öneri) | approved | active | at_risk | done | dropped
CREATE TABLE IF NOT EXISTS strategy_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  level         text NOT NULL CHECK (level IN ('vision','phase','annual','quarterly','monthly','weekly')),
  parent_id     uuid REFERENCES strategy_items(id) ON DELETE CASCADE,
  period_key    text NOT NULL CHECK (period_key ~ '^[0-9A-Za-z_-]{4,24}$'),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  body          text CHECK (body IS NULL OR length(body) <= 8000),
  owner_role    text CHECK (owner_role IS NULL OR owner_role ~ '^[a-z_]{2,40}$'),
  status        text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','active','at_risk','done','dropped')),
  provenance    text NOT NULL DEFAULT 'ai_recommendation' CHECK (provenance IN ('owner','ai_recommendation','framework')),
  -- [{ "label", "metric", "target", "baseline": {value, measuredAt, source} | null, "current": {value, measuredAt, source} | null }]
  key_results   jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort          integer NOT NULL DEFAULT 0,
  seed_key      text,
  created_by    text NOT NULL DEFAULT 'user',
  updated_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS strategy_items_brand_level ON strategy_items (brand_id, level, period_start);
CREATE INDEX IF NOT EXISTS strategy_items_parent ON strategy_items (parent_id);
-- Başlangıç önerileri bir kez eklenir (tekrar çalıştırmada çoğalmaz)
CREATE UNIQUE INDEX IF NOT EXISTS strategy_items_seed ON strategy_items (brand_id, seed_key) WHERE seed_key IS NOT NULL;

-- Strateji değişiklik geçmişi (stratejik ayarlamalar ve performans incelemeleri izlenebilir olsun)
CREATE TABLE IF NOT EXISTS strategy_item_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES strategy_items(id) ON DELETE CASCADE,
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  changed_by  text NOT NULL,
  reason      text CHECK (reason IS NULL OR length(reason) <= 1000),
  before      jsonb NOT NULL,
  after       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_item_revisions_item ON strategy_item_revisions (item_id, created_at DESC);

-- Zamanlanmış PR operasyonları: dönem başına tek kayıt (idempotency), aşama ve kanıt.
-- stage: scheduled | running | output_produced | verified | completed | failed | skipped
-- Bir çalıştırma ancak kanıt (kayıtlı rapor/çıktı) doğrulandıktan sonra "completed" olur.
CREATE TABLE IF NOT EXISTS pr_operation_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id     uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  operation    text NOT NULL CHECK (operation ~ '^[a-z_]{3,60}$'),
  period_key   text NOT NULL CHECK (length(period_key) BETWEEN 4 AND 24),
  stage        text NOT NULL CHECK (stage IN ('scheduled','running','output_produced','verified','completed','failed','skipped')),
  output_id    uuid REFERENCES outputs(id) ON DELETE SET NULL,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text CHECK (error IS NULL OR length(error) <= 2000),
  attempts     integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, operation, period_key)
);
CREATE INDEX IF NOT EXISTS pr_operation_runs_brand_created ON pr_operation_runs (brand_id, created_at DESC);

-- Profesyonel bilgi kütüphanesi: yayımlanmış çerçeveler, dış araştırma ve AI önerileri AYRI türlerdir.
-- kind: framework (yayımlanmış çerçeve) | external_research (doğrulanmış dış kaynak) | ai_recommendation (öneri; gerçek değil)
-- verification: verified (kaynak bu sürümde doğrulandı) | partially_verified | needs_review
-- Özetler kendi sözlerimizle ve kısadır; telifli metin kopyalanmaz.
CREATE TABLE IF NOT EXISTS pr_library_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id       uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  slug           text NOT NULL CHECK (slug ~ '^[a-z0-9-]{3,80}$'),
  kind           text NOT NULL CHECK (kind IN ('framework','external_research','ai_recommendation')),
  category       text NOT NULL CHECK (length(category) BETWEEN 2 AND 80),
  title          text NOT NULL CHECK (length(title) BETWEEN 2 AND 300),
  summary        text NOT NULL CHECK (length(summary) BETWEEN 10 AND 4000),
  application    text CHECK (application IS NULL OR length(application) <= 4000),
  source_title   text CHECK (source_title IS NULL OR length(source_title) <= 500),
  source_url     text CHECK (source_url IS NULL OR source_url ~ '^https://'),
  source_ref     text CHECK (source_ref IS NULL OR length(source_ref) <= 300),
  publisher      text CHECK (publisher IS NULL OR length(publisher) <= 300),
  version        text CHECK (version IS NULL OR length(version) <= 60),
  published_year integer CHECK (published_year IS NULL OR published_year BETWEEN 1900 AND 2100),
  verification   text NOT NULL DEFAULT 'needs_review' CHECK (verification IN ('verified','partially_verified','needs_review')),
  verified_note  text CHECK (verified_note IS NULL OR length(verified_note) <= 1000),
  checked_at     date,
  created_by     text NOT NULL DEFAULT 'user',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, slug)
);
CREATE INDEX IF NOT EXISTS pr_library_entries_brand_kind ON pr_library_entries (brand_id, kind, category);

CREATE TABLE IF NOT EXISTS pr_library_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES pr_library_entries(id) ON DELETE CASCADE,
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  changed_by  text NOT NULL,
  before      jsonb,
  after       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pr_library_revisions_entry ON pr_library_revisions (entry_id, created_at DESC);
