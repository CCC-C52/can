-- 002: Medya anlama, parçalı yükleme, sağlayıcı işleri, hata sınıfları, bütünlük kısıtları.
-- Yıkıcı değildir: yalnızca tablo/sütun/indeks/tetikleyici ekler. Mevcut satırları silmez.
-- Tek veri düzeltmesi: yerel derleme ile üretilmiş görsellerin kökeni 'edited' → 'composed' (etiket düzeltmesi;
-- dosyalar ve ilişkiler değişmez). Canlı veritabanında çalıştırmak için sahip onayı gerekir.

-- ---------------------------------------------------------------- Görev / proje ekleri
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS failure_class text;
   -- transient | permanent | permission | budget | connection | quality | timeout | dependency | cancelled
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS questions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------- Medya ekleri
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS generation_method text NOT NULL DEFAULT 'upload';
   -- upload | sharp_compose | ffmpeg_edit | ai_image:<sağlayıcı> | ai_video:<sağlayıcı> | export
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS alt_text text;

UPDATE media_assets SET generation_method = 'sharp_compose', origin = 'composed'
 WHERE origin = 'edited' AND kind = 'photo' AND source_task_id IS NOT NULL AND generation_method = 'upload';
UPDATE media_assets SET generation_method = 'ffmpeg_edit'
 WHERE origin = 'edited' AND kind = 'video' AND generation_method = 'upload';
UPDATE media_assets SET generation_method = 'ai_image:openai_images'
 WHERE origin = 'ai_generated' AND kind = 'photo' AND source_task_id IS NOT NULL AND generation_method = 'upload';
UPDATE media_assets m SET project_id = t.project_id FROM tasks t
 WHERE m.source_task_id = t.id AND m.project_id IS NULL;

-- ---------------------------------------------------------------- Medya analizleri
CREATE TABLE IF NOT EXISTS media_analyses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  asset_id         uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  kind             text NOT NULL,           -- image | video
  analysis_version integer NOT NULL,        -- analiz kodu/istem sürümü
  input_hash       text NOT NULL,           -- varlık sha256 + sürüm + sağlayıcı; değişmeyen varlık yeniden işlenmez
  status           text NOT NULL DEFAULT 'pending',
     -- pending | processing | completed | failed | connection_required
  level            text NOT NULL DEFAULT 'local', -- local (piksel/ffmpeg) | vision (model)
  provider         text,
  model            text,
  result           jsonb,
  error            text,
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 3,
  lease_owner      text,
  lease_expires_at timestamptz,
  next_attempt_at  timestamptz,
  cost_usd         numeric(12,6),
  cost_unknown     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, input_hash)
);
CREATE INDEX IF NOT EXISTS media_analyses_queue ON media_analyses (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS media_analyses_brand_asset ON media_analyses (brand_id, asset_id);

-- ---------------------------------------------------------------- Parçalı yükleme oturumları
CREATE TABLE IF NOT EXISTS upload_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  client_key      text NOT NULL,            -- tarayıcı tarafı dosya parmak izi (ad+boyut+tarih); sürdürme için
  filename        text NOT NULL,
  declared_mime   text,
  size_bytes      bigint NOT NULL,
  part_size       integer NOT NULL,
  part_count      integer NOT NULL,
  storage_driver  text NOT NULL,
  temp_key        text NOT NULL,
  s3_upload_id    text,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'preparing',
     -- preparing | uploading | verifying | processing | completed | failed | aborted
  asset_id        uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  duplicate       boolean NOT NULL DEFAULT false,
  error           text,
  verify_attempts integer NOT NULL DEFAULT 0,
  lease_owner      text,
  lease_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_active_client
  ON upload_sessions (brand_id, client_key) WHERE status IN ('preparing','uploading');
CREATE INDEX IF NOT EXISTS upload_sessions_status ON upload_sessions (status, updated_at);

-- ---------------------------------------------------------------- Harici sağlayıcı işleri (AI görsel/video)
CREATE TABLE IF NOT EXISTS provider_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id           uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  project_id         uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id            uuid REFERENCES tasks(id) ON DELETE SET NULL,
  provider           text NOT NULL,
  kind               text NOT NULL,          -- image_generation | video_generation
  item_ref           text NOT NULL,          -- brief/video kimliği
  idempotency_key    text NOT NULL UNIQUE,
  external_id        text,
  status             text NOT NULL,
     -- submitting | submitted | running | downloading | succeeded | failed | unknown | cancelled
  request            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- gizli değer içermez
  response           jsonb,
  result_asset_id    uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  error              text,
  poll_count         integer NOT NULL DEFAULT 0,
  next_poll_at       timestamptz,
  cost_estimated_usd numeric(12,6),
  cost_actual_usd    numeric(12,6),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS provider_jobs_task ON provider_jobs (task_id);
CREATE INDEX IF NOT EXISTS provider_jobs_status ON provider_jobs (status, next_poll_at);

ALTER TABLE cost_entries ADD COLUMN IF NOT EXISTS provider_job_id uuid REFERENCES provider_jobs(id) ON DELETE SET NULL;
ALTER TABLE cost_entries ADD COLUMN IF NOT EXISTS analysis_id uuid REFERENCES media_analyses(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- Eksik yabancı anahtar indeksleri
CREATE INDEX IF NOT EXISTS outputs_task ON outputs (task_id);
CREATE INDEX IF NOT EXISTS outputs_project ON outputs (project_id);
CREATE INDEX IF NOT EXISTS output_versions_brand ON output_versions (brand_id);
CREATE INDEX IF NOT EXISTS approvals_version ON approvals (output_version_id);
CREATE INDEX IF NOT EXISTS media_assets_source_task ON media_assets (source_task_id);
CREATE INDEX IF NOT EXISTS media_assets_product ON media_assets (product_id);
CREATE INDEX IF NOT EXISTS media_assets_project ON media_assets (project_id);
CREATE INDEX IF NOT EXISTS cost_entries_project ON cost_entries (project_id);
CREATE INDEX IF NOT EXISTS calendar_entries_output ON calendar_entries (output_id);
CREATE INDEX IF NOT EXISTS external_actions_version ON external_actions (output_version_id);
CREATE INDEX IF NOT EXISTS task_dependencies_upstream ON task_dependencies (depends_on_task_id);
CREATE INDEX IF NOT EXISTS chat_messages_project ON chat_messages (project_id);

-- ---------------------------------------------------------------- Durum kısıtları (yalnızca yeni/değişen satırlar; NOT VALID)
DO $$ BEGIN
  ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN
    ('planned','ready','running','review_pending','approval_pending','completed','failed','cancelled','waiting_connection')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE approvals ADD CONSTRAINT approvals_decision_check CHECK (decision IN ('approved','rejected')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE media_assets ADD CONSTRAINT media_assets_origin_check CHECK (origin IN
    ('real_photo','real_video','ai_generated','edited','composed','design_file','export')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- Onay geçmişi değişmez
-- Onaylar yalnızca eklenir. Tek izin verilen güncelleme: revoked_at bir kez doldurulabilir.
CREATE OR REPLACE FUNCTION approvals_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approvals are append-only';
  END IF;
  IF NEW.brand_id IS DISTINCT FROM OLD.brand_id OR NEW.output_id IS DISTINCT FROM OLD.output_id
     OR NEW.output_version_id IS DISTINCT FROM OLD.output_version_id OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.decision IS DISTINCT FROM OLD.decision OR NEW.scopes IS DISTINCT FROM OLD.scopes OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'approval records are immutable (only revoked_at may be set once)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS approvals_append_only ON approvals;
CREATE TRIGGER approvals_append_only BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_append_only();

-- Çıktı sürümlerinin içeriği değişmez (QA raporu ve bağlı dosya listesi güncellenebilir).
CREATE OR REPLACE FUNCTION output_versions_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.output_id IS DISTINCT FROM OLD.output_id
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'output version content is immutable; create a new version instead';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS output_versions_immutable ON output_versions;
CREATE TRIGGER output_versions_immutable BEFORE UPDATE ON output_versions
  FOR EACH ROW EXECUTE FUNCTION output_versions_immutable();
