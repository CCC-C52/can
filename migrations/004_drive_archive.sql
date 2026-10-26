-- 004: Google Drive arşiv dizini (FriBee Master Archive) ve doğrulanmış marka referansları.
-- Yalnızca ekleme yapar (mevcut tablo/veri değişmez). Drive dosyalarının kendisi kopyalanmaz; yalnızca üst veri saklanır.

-- ---------------------------------------------------------------- Kaynak (marka başına tek seçili klasör)
-- Klasör kimliği kullanıcı OAuth ile yetki verdikten sonra panelde açıkça seçilir; kodda sabit değildir.
-- full_scan_state: kaldığı yerden devam eden tarama kuyruğu {"queue":[{"id","path","depth"}],"pageToken":...}
CREATE TABLE IF NOT EXISTS drive_sources (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id                uuid NOT NULL UNIQUE REFERENCES brands(id) ON DELETE CASCADE,
  status                  text NOT NULL DEFAULT 'awaiting_folder'
                          CHECK (status IN ('awaiting_folder','active','paused','reauth_required','disconnected')),
  folder_id               text CHECK (folder_id IS NULL OR folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  folder_name             text,
  drive_id                text,
  account_email           text,
  full_scan_state         jsonb NOT NULL DEFAULT '{}'::jsonb,
  full_scan_started_at    timestamptz,
  full_scan_completed_at  timestamptz,
  changes_page_token      text,
  last_scan_started_at    timestamptz,
  last_scan_finished_at   timestamptz,
  last_success_at         timestamptz,
  next_scan_at            timestamptz,
  consecutive_failures    integer NOT NULL DEFAULT 0,
  last_error              text,
  lock_owner              text,
  lock_expires_at         timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, brand_id)
);
CREATE INDEX IF NOT EXISTS drive_sources_due ON drive_sources (status, next_scan_at);

-- ---------------------------------------------------------------- Dizinlenmiş öğeler (yalnızca üst veri)
-- state: indexed | pending_checksum (yükleme sürüyor / Drive özeti henüz yok) | malformed | removed (çöp, silindi, klasör dışına taşındı)
CREATE TABLE IF NOT EXISTS drive_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         uuid NOT NULL,
  source_id        uuid NOT NULL,
  file_id          text NOT NULL CHECK (file_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  name             text NOT NULL,
  mime_type        text NOT NULL,
  is_folder        boolean NOT NULL DEFAULT false,
  parent_ids       text[] NOT NULL DEFAULT '{}',
  path             text,
  depth            integer,
  size_bytes       bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  md5_checksum     text,
  sha1_checksum    text,
  sha256_checksum  text,
  created_time     timestamptz,
  modified_time    timestamptz,
  version          bigint,
  has_thumbnail    boolean NOT NULL DEFAULT false,
  image_width      integer,
  image_height     integer,
  state            text NOT NULL DEFAULT 'indexed' CHECK (state IN ('indexed','pending_checksum','malformed','removed')),
  state_detail     text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, file_id),
  UNIQUE (id, brand_id),
  FOREIGN KEY (source_id, brand_id) REFERENCES drive_sources (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS drive_items_brand_state ON drive_items (brand_id, state);
CREATE INDEX IF NOT EXISTS drive_items_source_folder ON drive_items (source_id, is_folder);
CREATE INDEX IF NOT EXISTS drive_items_checksum ON drive_items (source_id, md5_checksum, size_bytes) WHERE md5_checksum IS NOT NULL;
CREATE INDEX IF NOT EXISTS drive_items_name ON drive_items (brand_id, lower(name));

-- ---------------------------------------------------------------- Tarama çalıştırmaları
CREATE TABLE IF NOT EXISTS drive_scan_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL,
  source_id       uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('full','incremental')),
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','partial','failed')),
  pages           integer NOT NULL DEFAULT 0,
  items_seen      integer NOT NULL DEFAULT 0,
  items_upserted  integer NOT NULL DEFAULT 0,
  items_removed   integer NOT NULL DEFAULT 0,
  malformed       integer NOT NULL DEFAULT 0,
  api_calls       integer NOT NULL DEFAULT 0,
  retries         integer NOT NULL DEFAULT 0,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  FOREIGN KEY (source_id, brand_id) REFERENCES drive_sources (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS drive_scan_runs_source ON drive_scan_runs (source_id, started_at DESC);

-- ---------------------------------------------------------------- Tema referansları (inceleme kuyruğu)
-- Sistem yalnızca öneri üretir ("uncertain"). Video/tasarım referansı olarak yalnızca sahibin doğruladığı ("verified")
-- kayıtlar kullanılır. Doğrulanmış kayıtta tema ve görünüm (ön/arka/detay) zorunludur.
CREATE TABLE IF NOT EXISTS drive_references (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id               uuid NOT NULL,
  item_id                uuid NOT NULL UNIQUE,
  theme                  text CHECK (theme IS NULL OR theme IN ('space_alien','music','anime','save_the_bee')),
  view                   text NOT NULL DEFAULT 'unknown' CHECK (view IN ('front','back','detail','other','unknown')),
  status                 text NOT NULL DEFAULT 'uncertain' CHECK (status IN ('uncertain','verified','rejected')),
  suggested_theme        text,
  suggested_view         text,
  suggestion_confidence  real,
  suggestion_detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes                  text CHECK (notes IS NULL OR length(notes) <= 1000),
  artwork_confirmed      boolean NOT NULL DEFAULT false,
  media_asset_id         uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  verified_by            text,
  verified_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'verified' OR (theme IS NOT NULL AND view <> 'unknown' AND artwork_confirmed)),
  FOREIGN KEY (item_id, brand_id) REFERENCES drive_items (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS drive_references_brand_status ON drive_references (brand_id, status);
CREATE INDEX IF NOT EXISTS drive_references_asset ON drive_references (media_asset_id) WHERE media_asset_id IS NOT NULL;
