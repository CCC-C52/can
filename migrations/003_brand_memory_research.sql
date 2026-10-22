-- 003: Marka hafızası ve araştırma kayıtları. Yalnızca ekleme yapar (mevcut tablo/veri değişmez).

-- ---------------------------------------------------------------- Marka hafızası
-- Sahibin onayladığı kalıcı bilgiler: yönergeler, dersler, tercihler, ajan talimatları, strateji notları.
-- "proposed" kayıtlar (ör. ret notundan önerilen ders) ajan bağlamına GİRMEZ; yalnızca "active" kayıtlar girer.
CREATE TABLE IF NOT EXISTS brand_memory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('guideline','lesson','preference','agent_instruction','strategy','campaign_note')),
  agent         text,                                  -- NULL = tüm ajanlar
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  status        text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','archived')),
  source        text NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','rejection','research')),
  source_ref    uuid,                                  -- ör. ret kaydı (approvals.id) veya araştırma çalıştırması
  created_by    text NOT NULL DEFAULT 'user',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz
);
CREATE INDEX IF NOT EXISTS brand_memory_brand_status ON brand_memory (brand_id, status);

-- ---------------------------------------------------------------- Araştırma
CREATE TABLE IF NOT EXISTS research_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  project_id         uuid REFERENCES projects(id) ON DELETE SET NULL,
  mode               text NOT NULL CHECK (mode IN ('search','scrape')),
  query              text NOT NULL CHECK (length(query) BETWEEN 1 AND 2000),
  provider           text NOT NULL,                    -- firecrawl
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','blocked')),
  credits_estimated  integer,
  credits_used       integer,
  error              text,
  idempotency_key    text,
  created_by         text NOT NULL DEFAULT 'user',
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  UNIQUE (id, brand_id)
);
CREATE INDEX IF NOT EXISTS research_runs_brand ON research_runs (brand_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS research_runs_idem ON research_runs (brand_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Kaynaklar her zaman "doğrulanmamış" başlar; sahip doğrulamadıkça ajanlar bunları gerçek bilgi olarak kullanamaz.
CREATE TABLE IF NOT EXISTS research_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL,
  brand_id      uuid NOT NULL,
  url           text NOT NULL CHECK (url ~ '^https?://'),
  title         text,
  excerpt       text,                                  -- en fazla ~4000 karakter, güvenilmeyen içerik
  content_hash  text,
  verification  text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','verified','rejected')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, brand_id) REFERENCES research_runs (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS research_sources_run ON research_sources (run_id);
CREATE INDEX IF NOT EXISTS research_sources_brand ON research_sources (brand_id, verification);
