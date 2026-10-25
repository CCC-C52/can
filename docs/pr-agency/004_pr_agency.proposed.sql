-- ÖNERİ — UYGULANMADI. Bu dosya bilerek migrations/ dışında tutulur (bkz. docs/PR_AGENCY.md §4).
-- migrations/ altına alınmadan önce: numara (PR #13 ile çakışma), migrations/policy.json kaydı
-- (class: additive, firstProductionRollout: requires_owner_authorization) ve sahip incelemesi gerekir.
-- Yalnızca ekleme yapar; mevcut tablo/veri değişmez. Tüm tablolar marka kapsamlıdır; alt kayıtlar
-- bileşik yabancı anahtarla yalnızca kendi markasının üst kaydına bağlanabilir (003'teki desen).

-- İzlenen kaynaklar: yalnızca izinli yöntemler (RSS/Atom, mevcut araştırma, lisanslı API). Kazıma yok.
CREATE TABLE IF NOT EXISTS pr_monitored_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('rss','research','news_api','social_api')),
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  url             text CHECK (url IS NULL OR url ~ '^https://'),
  permission_note text NOT NULL CHECK (length(permission_note) BETWEEN 1 AND 1000), -- hangi kural/izinle okunuyor
  min_interval_minutes integer NOT NULL DEFAULT 360 CHECK (min_interval_minutes >= 60),  -- oran sınırı
  enabled         boolean NOT NULL DEFAULT false,                                           -- sahip açar
  last_success_at timestamptz,
  last_error      text,
  etag            text,                                                                     -- koşullu GET önbelleği
  last_modified   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, brand_id),
  UNIQUE (brand_id, kind, url)
);

CREATE TABLE IF NOT EXISTS pr_ingestion_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL,
  source_id     uuid NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','skipped_rate_limit','skipped_unchanged')),
  items_seen    integer NOT NULL DEFAULT 0,
  items_new     integer NOT NULL DEFAULT 0,
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (id, brand_id),
  FOREIGN KEY (source_id, brand_id) REFERENCES pr_monitored_sources (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pr_ingestion_runs_source ON pr_ingestion_runs (source_id, started_at DESC);

-- Bahsetmeler / haberler. Metrikler boş bırakılabilir; doluysa kaynak ve gözlem zamanı ZORUNLU.
CREATE TABLE IF NOT EXISTS pr_coverage_mentions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         uuid NOT NULL,
  run_id           uuid NOT NULL,
  url              text NOT NULL CHECK (url ~ '^https?://'),
  url_normalized   text NOT NULL,
  title            text,
  excerpt          text,
  published_at     timestamptz,
  retrieved_at     timestamptz NOT NULL DEFAULT now(),
  verification     text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','verified','rejected')),
  reach            bigint,
  reach_source     text,
  reach_observed_at timestamptz,
  CHECK (reach IS NULL OR (reach_source IS NOT NULL AND reach_observed_at IS NOT NULL)),
  UNIQUE (brand_id, url_normalized),                                                       -- tekilleştirme
  FOREIGN KEY (run_id, brand_id) REFERENCES pr_ingestion_runs (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pr_coverage_mentions_brand ON pr_coverage_mentions (brand_id, retrieved_at DESC);

-- Trend sinyalleri ve kanıt bağlantıları. signal_class kanıttan türetilir (≥2 doğrulanmış alan adı = signal).
CREATE TABLE IF NOT EXISTS pr_trend_signals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  topic         text NOT NULL CHECK (length(topic) BETWEEN 1 AND 300),
  collection    text,
  signal_class  text NOT NULL CHECK (signal_class IN ('signal','weak_signal','speculation')),
  relevance     integer CHECK (relevance BETWEEN 0 AND 100),
  basis         jsonb NOT NULL DEFAULT '[]',
  CHECK (relevance IS NULL OR signal_class <> 'speculation'),                              -- kanıtsız puan yok
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, brand_id)
);
CREATE TABLE IF NOT EXISTS pr_signal_evidence (
  signal_id     uuid NOT NULL,
  brand_id      uuid NOT NULL,
  mention_id    uuid,
  research_source_id uuid,
  CHECK ((mention_id IS NULL) <> (research_source_id IS NULL)),
  FOREIGN KEY (signal_id, brand_id) REFERENCES pr_trend_signals (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pr_signal_evidence_signal ON pr_signal_evidence (signal_id);

-- Influencer fırsatları: yalnızca izinli API'den gelen herkese açık profil adresi. İletişim bilgisi saklanmaz.
CREATE TABLE IF NOT EXISTS pr_influencer_opportunities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  handle          text NOT NULL CHECK (length(handle) BETWEEN 1 AND 100),
  platform        text NOT NULL,
  profile_url     text NOT NULL CHECK (profile_url ~ '^https://'),
  source          text NOT NULL,
  retrieved_at    timestamptz NOT NULL,
  followers       bigint,
  followers_observed_at timestamptz,
  CHECK (followers IS NULL OR followers_observed_at IS NOT NULL),
  status          text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','shortlisted','dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, platform, handle)
);

-- PR kampanyaları ve öneriler: yalnızca taslak. Dış işlem mevcut approvals/external_actions akışından geçer.
CREATE TABLE IF NOT EXISTS pr_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  collection  text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, brand_id)
);
CREATE TABLE IF NOT EXISTS pr_recommendations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id     uuid NOT NULL,
  campaign_id  uuid,
  kind         text NOT NULL CHECK (kind IN ('brief','opportunity','media_pitch','influencer_shortlist','launch_plan','risk_flag')),
  title        text NOT NULL,
  body         jsonb NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  output_id    uuid REFERENCES outputs(id) ON DELETE SET NULL,                               -- Onay Merkezi bağlantısı
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campaign_id, brand_id) REFERENCES pr_campaigns (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pr_recommendations_brand ON pr_recommendations (brand_id, status, created_at DESC);

-- Tarihsel anlık görüntüler (genel bakışın günlük kopyası; trend karşılaştırması için).
CREATE TABLE IF NOT EXISTS pr_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  taken_at    timestamptz NOT NULL DEFAULT now(),
  overview    jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS pr_snapshots_brand ON pr_snapshots (brand_id, taken_at DESC);
