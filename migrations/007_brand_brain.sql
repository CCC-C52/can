-- 007: FriBee Brand Brain — Drive arşivinin içerik dizini (belgeler, parçalar), erişim kayıtları ve çıktı kaynakları.
-- Yalnızca ekleme yapar: yeni tablolar/indeksler ve drive_items'a boş bırakılabilir bir sütun. Mevcut veri değişmez.
-- Drive'a yazılmaz; dosyaların kendisi kopyalanmaz (yalnızca çıkarılan metin, üst veri ve kaynak izi saklanır).

-- Drive video süresi (Drive videoMediaMetadata.durationMillis); video baytları indirilmez.
ALTER TABLE drive_items ADD COLUMN IF NOT EXISTS video_duration_ms bigint;

-- ---------------------------------------------------------------- Belgeler (Drive öğesi başına içerik durumu)
-- status:
--   pending        işlenmeyi bekliyor (yeni veya revizyonu değişmiş)
--   processing     bir işleyici kiraladı (lease); süresi dolarsa kurtarılır
--   indexed        içerik çıkarıldı ve parçalandı (veya aynı içeriğin kopyası: duplicate_of)
--   metadata_only  içerik okunamadı/okunmadı; yalnızca üst veri aranabilir (limitation nedeni yazar)
--   unsupported    biçim desteklenmiyor veya korumalı (limitation nedeni yazar); yalnızca üst veri aranabilir
--   failed         kalıcı hata (dosya bozuk vb.); elle "tekrar dene"
--   dead           geçici hatalar deneme sınırını aştı (ölü mektup kuyruğu); elle "tekrar dene"
--   removed        Drive'da silindi/taşındı/erişim kalktı: parçalar silinir, kaynak izi denetim için kalır
CREATE TABLE IF NOT EXISTS kb_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  drive_item_id    uuid NOT NULL,
  file_id          text NOT NULL,
  name             text NOT NULL,
  path             text,
  mime_type        text NOT NULL,
  revision_key     text NOT NULL,
  content_hash     text,
  parser           text,
  parser_version   integer,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','processing','indexed','metadata_only','unsupported','failed','dead','removed')),
  limitation       text,
  error            text,
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 5,
  next_attempt_at  timestamptz,
  lease_owner      text,
  lease_expires_at timestamptz,
  category         text,
  sensitivity      text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public','internal','vendor','finance','private')),
  collection_keys  text[] NOT NULL DEFAULT '{}',
  duplicate_of     uuid,
  flags            text[] NOT NULL DEFAULT '{}',
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  page_count       integer,
  char_count       integer,
  chunk_count      integer NOT NULL DEFAULT 0,
  indexed_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_id, drive_item_id),
  UNIQUE (id, brand_id),
  FOREIGN KEY (drive_item_id, brand_id) REFERENCES drive_items (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS kb_documents_brand_status ON kb_documents (brand_id, status);
CREATE INDEX IF NOT EXISTS kb_documents_queue ON kb_documents (status, next_attempt_at) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS kb_documents_hash ON kb_documents (brand_id, content_hash) WHERE content_hash IS NOT NULL;

-- ---------------------------------------------------------------- Parçalar (aranabilir metin + isteğe bağlı gömme)
-- tsv: tam metin arama ('simple' yapılandırması: dil bağımsız, Türkçe/İngilizce karışık metin için).
-- embedding: normalize edilmiş gömme vektörü (real[]). pgvector kuruluysa sorguda vector'e dönüştürülür; kurulu değilse
-- tam tarama ile kosinüs benzerliği hesaplanır (belgelenmiş yedek; anlamsal arama sessizce kapatılmaz).
CREATE TABLE IF NOT EXISTS kb_chunks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         uuid NOT NULL,
  document_id      uuid NOT NULL,
  chunk_index      integer NOT NULL,
  section          text,
  text             text NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
  tsv              tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(section, '') || ' ' || text)) STORED,
  content_hash     text NOT NULL,
  sensitivity      text NOT NULL CHECK (sensitivity IN ('public','internal','vendor','finance','private')),
  collection_keys  text[] NOT NULL DEFAULT '{}',
  flags            text[] NOT NULL DEFAULT '{}',
  token_estimate   integer NOT NULL,
  embedding        real[],
  embedding_model  text,
  embedding_dims   integer,
  embedded_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index),
  FOREIGN KEY (document_id, brand_id) REFERENCES kb_documents (id, brand_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS kb_chunks_tsv ON kb_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS kb_chunks_brand ON kb_chunks (brand_id, sensitivity);
CREATE INDEX IF NOT EXISTS kb_chunks_embed_queue ON kb_chunks (brand_id, created_at) WHERE embedding IS NULL;

-- ---------------------------------------------------------------- Erişim kayıtları (hangi ajan neyi aldı)
CREATE TABLE IF NOT EXISTS kb_retrievals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id      uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  task_id       uuid,
  project_id    uuid,
  agent         text,
  role          text NOT NULL,
  purpose       text NOT NULL DEFAULT 'agent',
  query         text NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('hybrid','lexical')),
  semantic_note text,
  hits          integer NOT NULL DEFAULT 0,
  withheld      integer NOT NULL DEFAULT 0,
  latency_ms    integer NOT NULL DEFAULT 0,
  chunk_ids     uuid[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_retrievals_brand ON kb_retrievals (brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kb_retrievals_task ON kb_retrievals (task_id) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------- Çıktı kaynakları (bir çıktı sürümünü etkileyen arşiv parçaları)
-- Kaynak izi, belge sonradan silinse/değişse bile korunur (dosya kimliği, ad, yol, revizyon anlık görüntüsü).
CREATE TABLE IF NOT EXISTS kb_output_sources (
  output_version_id uuid NOT NULL REFERENCES output_versions(id) ON DELETE CASCADE,
  label             text NOT NULL CHECK (label ~ '^S[0-9]{1,3}$'),
  brand_id          uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  retrieval_id      uuid,
  chunk_id          uuid,
  document_id       uuid,
  file_id           text NOT NULL,
  name              text NOT NULL,
  path              text,
  section           text,
  revision_key      text,
  verification      text NOT NULL,
  cited             boolean NOT NULL DEFAULT false,
  rank              integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (output_version_id, label)
);
CREATE INDEX IF NOT EXISTS kb_output_sources_doc ON kb_output_sources (brand_id, document_id);
