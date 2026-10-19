-- AI Operations Studio — ilk şema
-- Not: Tüm marka verileri brand_id ile ayrılır. Uygulama katmanı her sorguda brand_id filtresi uygular.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- Markalar
CREATE TABLE brands (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  is_sample        boolean NOT NULL DEFAULT false,      -- açıkça "örnek" marka
  story            text,                                -- NULL = bilinmiyor
  target_audience  text,
  tone             text,
  content_language text NOT NULL DEFAULT 'en',          -- müşteriye yönelik içerik dili
  colors           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{name, hex}]
  fonts            jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{role, family}]
  logo_asset_id    uuid,
  shipping_info    text,
  return_policy    text,
  campaign_rules   text,
  price_source     text NOT NULL DEFAULT 'unknown',     -- manual | shopify | unknown
  inventory_source text NOT NULL DEFAULT 'unknown',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Kullanıcının onayladığı kararlar ve doğrulanmış marka bilgileri
CREATE TABLE brand_facts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind        text NOT NULL,                 -- decision | fact | forbidden_claim
  statement   text NOT NULL,
  status      text NOT NULL DEFAULT 'verified', -- verified | unverified
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON brand_facts (brand_id);

-- ---------------------------------------------------------------- Ürünler
CREATE TABLE products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  title              text NOT NULL,
  description        text,
  product_type       text,
  status             text NOT NULL DEFAULT 'draft',  -- draft | active | archived
  price              numeric(12,2),                  -- NULL = bilinmiyor
  compare_at_price   numeric(12,2),
  currency           text,
  shopify_product_id text,                           -- gid://shopify/Product/...
  is_sample          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON products (brand_id);

CREATE TABLE product_variants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title              text NOT NULL,
  sku                text,
  color              text,
  size               text,
  price              numeric(12,2),
  inventory_quantity integer,                         -- NULL = bilinmiyor
  shopify_variant_id text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON product_variants (product_id);

CREATE TABLE product_facts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attribute   text NOT NULL,                  -- ör. "Kumaş"
  value       text NOT NULL,                  -- ör. "%100 pamuk"
  status      text NOT NULL DEFAULT 'verified', -- verified | unverified
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON product_facts (product_id);

-- ---------------------------------------------------------------- Medya arşivi
CREATE TABLE media_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  product_id      uuid REFERENCES products(id) ON DELETE SET NULL,
  kind            text NOT NULL,           -- photo | video | logo | design | audio | document
  origin          text NOT NULL,           -- real_photo | real_video | ai_generated | edited | design_file | export
  filename        text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  storage_key     text NOT NULL,
  width           integer,
  height          integer,
  duration_s      numeric(10,2),
  colors          text[] NOT NULL DEFAULT '{}',
  themes          text[] NOT NULL DEFAULT '{}',
  shot_type       text,
  format          text,                    -- ör. 9:16, 1:1, 4:5
  rights_status   text NOT NULL DEFAULT 'unknown', -- unknown | owned | licensed | restricted
  rights_note     text,
  usage_history   jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{date, channel, note}]
  tags            jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{tag, source: ai|user}]
  parent_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL, -- sürüm/türev kaynağı
  version         integer NOT NULL DEFAULT 1,
  source_task_id  uuid,
  source_output_version_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, sha256)
);
CREATE INDEX ON media_assets (brand_id, kind);

-- Türetilen dosyaların hangi kaynaklardan üretildiği (çoktan çoğa)
CREATE TABLE media_lineage (
  derived_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  source_asset_id  uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  relation         text NOT NULL DEFAULT 'derived_from',
  PRIMARY KEY (derived_asset_id, source_asset_id)
);

-- ---------------------------------------------------------------- Bağlantılar
CREATE TABLE connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id              uuid REFERENCES brands(id) ON DELETE CASCADE, -- NULL = genel servis
  provider              text NOT NULL,
  status                text NOT NULL DEFAULT 'not_connected',
     -- not_connected | testing | connected | reauth_required | error | unsupported
  config                jsonb NOT NULL DEFAULT '{}'::jsonb,   -- gizli olmayan ayarlar (ör. mağaza alan adı)
  credentials_encrypted text,                                 -- AES-256-GCM ile şifreli
  scopes                text[] NOT NULL DEFAULT '{}',
  last_checked_at       timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connections_brand_provider ON connections (COALESCE(brand_id, '00000000-0000-0000-0000-000000000000'::uuid), provider);

CREATE TABLE oauth_states (
  state       text PRIMARY KEY,
  brand_id    uuid REFERENCES brands(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at  timestamptz NOT NULL
);

-- ---------------------------------------------------------------- Projeler, sohbet
CREATE TABLE projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  title           text NOT NULL,
  instruction     text NOT NULL,
  status          text NOT NULL DEFAULT 'planning', -- planning | running | needs_attention | completed | failed | cancelled
  idempotency_key text NOT NULL UNIQUE,
  model_calls     integer NOT NULL DEFAULT 0,
  report          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON projects (brand_id, created_at DESC);

CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  role        text NOT NULL,           -- user | manager
  content     text NOT NULL,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON chat_messages (brand_id, created_at);

-- ---------------------------------------------------------------- Görevler
CREATE TABLE tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key                text NOT NULL,             -- plan içindeki kısa anahtar
  agent              text NOT NULL,             -- manager | marketing | shopify | design | video | social | quality
  kind               text NOT NULL DEFAULT 'work', -- plan | work | render | report
  title              text NOT NULL,
  instruction        text NOT NULL,
  status             text NOT NULL DEFAULT 'planned',
     -- planned | ready | running | review_pending | approval_pending | completed | failed | cancelled | waiting_connection
  phase              text NOT NULL DEFAULT 'generate', -- generate | review
  dep_mode           text NOT NULL DEFAULT 'completed', -- completed | settled
  requires_approval  boolean NOT NULL DEFAULT false,
  requires_capability text,                      -- image_generation | video_generation | ...
  input_refs         jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_id          uuid,
  model              text,
  service            text,
  attempts           integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 3,
  regen_count        integer NOT NULL DEFAULT 0,
  feedback           text,                       -- kalite kontrol / kullanıcı geri bildirimi
  error              text,
  lease_owner        text,
  lease_expires_at   timestamptz,
  next_attempt_at    timestamptz,
  cost_estimated_usd numeric(12,6),
  cost_actual_usd    numeric(12,6),
  cost_unknown       boolean NOT NULL DEFAULT false,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
CREATE INDEX ON tasks (status, next_attempt_at);
CREATE INDEX ON tasks (brand_id, project_id);

CREATE TABLE task_dependencies (
  task_id            uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE task_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt     integer NOT NULL,
  phase       text NOT NULL,
  worker_id   text,
  outcome     text,                       -- succeeded | failed | timeout | lease_expired | budget_blocked
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ON task_attempts (task_id);

-- ---------------------------------------------------------------- Çıktılar ve sürümler
CREATE TABLE outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
  agent           text NOT NULL,
  kind            text NOT NULL,          -- strategy | shopify_proposal | design_brief | video_plan | social_package | qa_report | project_report | plan
  title           text NOT NULL,
  current_version integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outputs (brand_id, created_at DESC);

CREATE TABLE output_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id     uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  output_id    uuid NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  content      jsonb NOT NULL,
  content_hash text NOT NULL,
  created_by   text NOT NULL,             -- agent:<id> | user
  generator    text NOT NULL,             -- demo | anthropic:<model> | user | local
  is_demo      boolean NOT NULL DEFAULT false,
  qa_report    jsonb,
  asset_ids    uuid[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (output_id, version)
);

-- ---------------------------------------------------------------- Onaylar
CREATE TABLE approvals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  output_id         uuid NOT NULL REFERENCES outputs(id) ON DELETE CASCADE,
  output_version_id uuid NOT NULL REFERENCES output_versions(id) ON DELETE CASCADE,
  content_hash      text NOT NULL,
  decision          text NOT NULL,        -- approved | rejected
  scopes            text[] NOT NULL DEFAULT '{content}', -- content | publish | store_update | price_change | ad_launch
  note              text,
  decided_by        text NOT NULL DEFAULT 'user',
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON approvals (output_id);

-- ---------------------------------------------------------------- Dış işlemler (yayın, mağaza, reklam)
CREATE TABLE external_actions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id          uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  action_type       text NOT NULL,        -- publish | store_update | price_change | ad_launch
  provider          text NOT NULL,
  output_version_id uuid REFERENCES output_versions(id) ON DELETE SET NULL,
  approval_id       uuid REFERENCES approvals(id) ON DELETE SET NULL,
  idempotency_key   text NOT NULL UNIQUE,
  status            text NOT NULL,        -- blocked | pending | executing | succeeded | failed | unknown | manual_export
  request           jsonb NOT NULL DEFAULT '{}'::jsonb,
  response          jsonb,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON external_actions (brand_id, created_at DESC);

-- ---------------------------------------------------------------- Yayın takvimi
CREATE TABLE calendar_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  output_id          uuid REFERENCES outputs(id) ON DELETE SET NULL,
  platform           text NOT NULL,       -- instagram | tiktok | facebook | other
  title              text NOT NULL,
  caption            text,
  scheduled_at       timestamptz,
  status             text NOT NULL DEFAULT 'draft', -- draft | awaiting_approval | approved | published | manual_export | failed
  external_action_id uuid REFERENCES external_actions(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON calendar_entries (brand_id, scheduled_at);

-- ---------------------------------------------------------------- Maliyet
CREATE TABLE cost_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid REFERENCES brands(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id     uuid REFERENCES tasks(id) ON DELETE SET NULL,
  service     text NOT NULL,           -- anthropic | openai_images | demo | meta_ads ...
  category    text NOT NULL,           -- ai_generation | ad_spend
  kind        text NOT NULL,           -- estimated | actual
  amount_usd  numeric(12,6),           -- NULL = bilinmiyor
  units       jsonb NOT NULL DEFAULT '{}'::jsonb,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cost_entries (brand_id, created_at);
CREATE INDEX ON cost_entries (task_id);

-- ---------------------------------------------------------------- Performans verileri (yalnızca gerçek bağlantıdan)
CREATE TABLE performance_metrics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  source      text NOT NULL,           -- shopify | meta_ads | instagram
  metric      text NOT NULL,
  value       numeric,
  period_start date,
  period_end   date,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Webhook olayları
CREATE TABLE webhook_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL,
  event_id    text NOT NULL,
  topic       text,
  brand_id    uuid REFERENCES brands(id) ON DELETE CASCADE,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ---------------------------------------------------------------- Ayarlar ve işlem geçmişi
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  brand_id    uuid REFERENCES brands(id) ON DELETE CASCADE,
  project_id  uuid,
  task_id     uuid,
  actor       text NOT NULL,           -- user | system | worker | agent:<id>
  action      text NOT NULL,
  message     text NOT NULL,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (brand_id, created_at DESC);
CREATE INDEX ON audit_log (task_id);

CREATE TABLE worker_heartbeats (
  worker_id   text PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL,
  info        jsonb
);
