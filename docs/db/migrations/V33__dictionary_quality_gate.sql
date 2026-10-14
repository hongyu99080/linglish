-- V33 is an expand-first, psql-compatible migration. It intentionally has no
-- file-wide transaction: concurrent indexes must run at top level, and every
-- preceding phase is idempotent so an interrupted run can be resumed safely.
-- Apply V33 before rolling out application code that reads quality columns.
\set ON_ERROR_STOP on

SET lock_timeout = '2s';
SET statement_timeout = '30min';

-- Phase 0: fail before any schema change when lowercase identities conflict.
DO $$
DECLARE
  duplicate_sample TEXT;
BEGIN
  SELECT word_lowercase
  INTO duplicate_sample
  FROM words
  GROUP BY word_lowercase
  HAVING COUNT(*) > 1
  ORDER BY word_lowercase
  LIMIT 1;

  IF duplicate_sample IS NOT NULL THEN
    RAISE EXCEPTION 'V33 duplicate word_lowercase preflight failed: %', duplicate_sample;
  END IF;
END $$;

-- Phase 1: metadata-only additions on supported PostgreSQL versions. The lock
-- timeout keeps this short and safe to retry behind an unexpected blocker.
ALTER TABLE words
  ADD COLUMN IF NOT EXISTS content_revision BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS phonetic_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS definitions_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS zh_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS part_of_speech_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS quality_status VARCHAR(16) NOT NULL DEFAULT 'review',
  ADD COLUMN IF NOT EXISTS quality_score NUMERIC(5, 2),
  ADD COLUMN IF NOT EXISTS quality_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS quality_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS quality_checked_revision BIGINT,
  ADD COLUMN IF NOT EXISTS quality_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seo_indexable BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS dictionary_quality_batches (
  id UUID PRIMARY KEY,
  operation VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  scope JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_type VARCHAR(32) NOT NULL,
  actor_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back_at TIMESTAMPTZ,
  CONSTRAINT dictionary_quality_batches_operation_check CHECK (operation IN ('apply')),
  CONSTRAINT dictionary_quality_batches_status_check CHECK (status IN ('applied', 'rolled_back'))
);

CREATE TABLE IF NOT EXISTS dictionary_quality_revisions (
  id BIGSERIAL PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES dictionary_quality_batches(id) ON DELETE RESTRICT,
  word_id BIGINT NOT NULL REFERENCES words(id) ON DELETE RESTRICT,
  word_lowercase VARCHAR(100) NOT NULL,
  from_revision BIGINT NOT NULL,
  to_revision BIGINT NOT NULL,
  before_record JSONB NOT NULL,
  after_record JSONB NOT NULL,
  action VARCHAR(16) NOT NULL DEFAULT 'apply',
  actor_type VARCHAR(32) NOT NULL,
  actor_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back_at TIMESTAMPTZ,
  CONSTRAINT dictionary_quality_revisions_revision_check CHECK (to_revision > from_revision),
  CONSTRAINT dictionary_quality_revisions_action_check CHECK (action IN ('apply','insert','blacklist','unblacklist','delete')),
  UNIQUE (batch_id, word_id, to_revision)
);

ALTER TABLE dictionary_quality_revisions
  DROP CONSTRAINT IF EXISTS dictionary_quality_revisions_action_check;
ALTER TABLE dictionary_quality_revisions
  ADD CONSTRAINT dictionary_quality_revisions_action_check
  CHECK (action IN ('apply','insert','blacklist','unblacklist','delete')) NOT VALID;
ALTER TABLE dictionary_quality_revisions
  VALIDATE CONSTRAINT dictionary_quality_revisions_action_check;

-- Phase 2: one server-side semantic used by CHECK constraints and all public
-- word SQL. Review/noindex legacy rows are allowed; only forged indexable rows
-- must satisfy the complete implication.
CREATE OR REPLACE FUNCTION dictionary_phonetic_is_valid(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  position INTEGER;
  character TEXT;
  previous_character TEXT;
  next_character TEXT;
  is_base BOOLEAN;
  is_combining BOOLEAN;
  is_tie BOOLEAN;
  optional_depth INTEGER := 0;
  optional_has_base BOOLEAN := FALSE;
  combining_base_seen BOOLEAN := FALSE;
BEGIN
  IF value IS NULL OR value = '' OR value <> BTRIM(value) OR CHAR_LENGTH(value) > 100 THEN
    RETURN FALSE;
  END IF;
  IF value <> normalize(value, NFC) THEN
    RETURN FALSE;
  END IF;
  IF value !~ '[A-Za-zÀ-ɏɐ-ʯᴀ-ᶿ]' THEN
    RETURN FALSE;
  END IF;
  FOR position IN 1..CHAR_LENGTH(value) LOOP
    character := SUBSTRING(value FROM position FOR 1);
    previous_character := CASE WHEN position > 1 THEN SUBSTRING(value FROM position - 1 FOR 1) ELSE '' END;
    next_character := CASE WHEN position < CHAR_LENGTH(value) THEN SUBSTRING(value FROM position + 1 FOR 1) ELSE '' END;
    is_base := character ~ '^[A-Za-zÀ-ɏɐ-ʯᴀ-ᶿ]$';
    is_combining := character = ANY (ARRAY[
      U&'\0300', U&'\0301', U&'\0302', U&'\0303', U&'\0304', U&'\0306', U&'\0308', U&'\030A', U&'\030B', U&'\030C', U&'\030F',
      U&'\0318', U&'\0319', U&'\031A', U&'\031C', U&'\031D', U&'\031E', U&'\031F', U&'\0320', U&'\0324', U&'\0325', U&'\0329',
      U&'\032A', U&'\032C', U&'\032F', U&'\0330', U&'\0334', U&'\0339', U&'\033A', U&'\033B', U&'\033C', U&'\033D', U&'\0346',
      U&'\0347', U&'\0348', U&'\0349', U&'\034A', U&'\034B', U&'\034C', U&'\0350', U&'\0351', U&'\0352', U&'\0354', U&'\0355',
      U&'\0356', U&'\0357', U&'\0358', U&'\0359', U&'\035A'
    ]);
    is_tie := character = ANY (ARRAY[U&'\035C', U&'\0361']);
    IF NOT (character ~ '^[A-Za-zÀ-ɏɐ-˿ᴀ-ᶿ]$'
      OR character = ANY (ARRAY[' ', '.', '''', '’', '(', ')', '-', '‿'])
      OR is_combining OR is_tie) THEN
      RETURN FALSE;
    END IF;
    IF character = '(' THEN
      IF optional_depth <> 0 THEN RETURN FALSE; END IF;
      optional_depth := 1;
      optional_has_base := FALSE;
    ELSIF character = ')' THEN
      IF optional_depth <> 1 OR NOT optional_has_base THEN RETURN FALSE; END IF;
      optional_depth := 0;
    ELSIF optional_depth = 1 AND is_base THEN
      optional_has_base := TRUE;
    END IF;
    IF is_base THEN
      combining_base_seen := TRUE;
    ELSIF is_combining THEN
      IF NOT combining_base_seen THEN RETURN FALSE; END IF;
    ELSE
      combining_base_seen := FALSE;
    END IF;
    IF character = ANY (ARRAY['ˈ', 'ˌ']) AND next_character !~ '^[A-Za-zÀ-ɏɐ-ʯᴀ-ᶿ]$' THEN
      RETURN FALSE;
    END IF;
    IF is_tie AND (previous_character !~ '^[A-Za-zÀ-ɏɐ-ʯᴀ-ᶿ]$' OR next_character !~ '^[A-Za-zÀ-ɏɐ-ʯᴀ-ᶿ]$') THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN optional_depth = 0;
END $$;

CREATE OR REPLACE FUNCTION dictionary_text_is_nonblank(value TEXT)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT value IS NOT NULL AND BTRIM(value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
$$;

CREATE OR REPLACE FUNCTION dictionary_jsonb_is_js_truthy(value JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'null' THEN FALSE
    WHEN 'boolean' THEN (value #>> '{}')::boolean
    WHEN 'number' THEN (value #>> '{}')::numeric <> 0
    WHEN 'string' THEN (value #>> '{}') <> ''
    WHEN 'array' THEN TRUE
    WHEN 'object' THEN TRUE
    ELSE FALSE
  END
$$;

CREATE OR REPLACE FUNCTION dictionary_definition_item_is_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  key TEXT;
  field_value JSONB;
BEGIN
  IF jsonb_typeof(value) = 'string' THEN
    RETURN dictionary_text_is_nonblank(value #>> '{}');
  END IF;
  IF jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;
  FOREACH key IN ARRAY ARRAY['definition', 'meaning', 'text', 'en'] LOOP
    field_value := value->key;
    IF dictionary_jsonb_is_js_truthy(field_value) THEN
      RETURN jsonb_typeof(field_value) = 'string'
        AND dictionary_text_is_nonblank(field_value #>> '{}');
    END IF;
  END LOOP;
  RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION dictionary_meaning_is_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  item JSONB;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;
  IF jsonb_typeof(value->'definitions') = 'array' THEN
    FOR item IN SELECT element FROM jsonb_array_elements(value->'definitions') AS element LOOP
      IF dictionary_definition_item_is_valid(item) THEN RETURN TRUE; END IF;
    END LOOP;
    RETURN FALSE;
  END IF;
  IF dictionary_jsonb_is_js_truthy(value->'definition')
    OR dictionary_jsonb_is_js_truthy(value->'meaning')
    OR dictionary_jsonb_is_js_truthy(value->'text') THEN
    RETURN dictionary_definition_item_is_valid(value);
  END IF;
  RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION dictionary_definitions_are_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  item JSONB;
  looks_like_meanings BOOLEAN := FALSE;
  parsed_string JSONB;
  string_value TEXT;
BEGIN
  IF value IS NULL OR value = 'null'::jsonb THEN RETURN FALSE; END IF;
  IF jsonb_typeof(value) = 'string' THEN
    string_value := value #>> '{}';
    BEGIN
      parsed_string := string_value::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN dictionary_text_is_nonblank(string_value);
    END;
    IF jsonb_typeof(parsed_string) = 'string' THEN
      RETURN dictionary_text_is_nonblank(parsed_string #>> '{}');
    END IF;
    RETURN dictionary_definitions_are_valid(parsed_string);
  END IF;
  IF jsonb_typeof(value) = 'array' THEN
    FOR item IN SELECT element FROM jsonb_array_elements(value) AS element LOOP
      IF jsonb_typeof(item) = 'object' AND (
        jsonb_typeof(item->'definitions') = 'array'
        OR dictionary_jsonb_is_js_truthy(item->'partOfSpeech')
        OR dictionary_jsonb_is_js_truthy(item->'part_of_speech')
        OR dictionary_jsonb_is_js_truthy(item->'pos')
      ) THEN
        looks_like_meanings := TRUE;
        EXIT;
      END IF;
    END LOOP;
    FOR item IN SELECT element FROM jsonb_array_elements(value) AS element LOOP
      IF (looks_like_meanings AND dictionary_meaning_is_valid(item))
        OR (NOT looks_like_meanings AND dictionary_definition_item_is_valid(item)) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;
  IF jsonb_typeof(value->'meanings') = 'array' THEN
    FOR item IN SELECT element FROM jsonb_array_elements(value->'meanings') AS element LOOP
      IF dictionary_meaning_is_valid(item) THEN RETURN TRUE; END IF;
    END LOOP;
    RETURN FALSE;
  END IF;
  IF value ? 'en' THEN
    IF jsonb_typeof(value->'en') = 'array' THEN
      FOR item IN SELECT element FROM jsonb_array_elements(value->'en') AS element LOOP
        IF dictionary_definition_item_is_valid(item) THEN RETURN TRUE; END IF;
      END LOOP;
      RETURN FALSE;
    END IF;
    RETURN dictionary_definition_item_is_valid(value->'en');
  END IF;
  IF jsonb_typeof(value->'definitions') = 'array' THEN
    RETURN dictionary_meaning_is_valid(value);
  END IF;
  RETURN dictionary_definition_item_is_valid(value);
END $$;

CREATE OR REPLACE FUNCTION dictionary_definition_item_has_translation(value JSONB, fallback_zh JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  key TEXT;
  candidate JSONB;
  alias_resolved BOOLEAN := FALSE;
BEGIN
  IF NOT dictionary_definition_item_is_valid(value) THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(value) = 'string' THEN
    RETURN jsonb_typeof(fallback_zh) = 'string'
      AND dictionary_text_is_nonblank(fallback_zh #>> '{}');
  END IF;
  IF jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;

  FOREACH key IN ARRAY ARRAY['zh', 'cn', 'translation'] LOOP
    candidate := value->key;
    IF dictionary_jsonb_is_js_truthy(candidate) THEN
      alias_resolved := TRUE;
      IF jsonb_typeof(candidate) = 'string' AND dictionary_text_is_nonblank(candidate #>> '{}') THEN
        RETURN TRUE;
      END IF;
      EXIT;
    END IF;
  END LOOP;
  IF NOT alias_resolved AND dictionary_jsonb_is_js_truthy(fallback_zh)
    AND jsonb_typeof(fallback_zh) = 'string'
    AND dictionary_text_is_nonblank(fallback_zh #>> '{}') THEN
    RETURN TRUE;
  END IF;

  alias_resolved := FALSE;
  FOREACH key IN ARRAY ARRAY['exampleZh', 'example_zh'] LOOP
    candidate := value->key;
    IF dictionary_jsonb_is_js_truthy(candidate) THEN
      alias_resolved := TRUE;
      IF jsonb_typeof(candidate) = 'string' AND dictionary_text_is_nonblank(candidate #>> '{}') THEN
        RETURN TRUE;
      END IF;
      EXIT;
    END IF;
  END LOOP;
  IF NOT alias_resolved AND jsonb_typeof(value->'examplesZh') = 'array' THEN
    candidate := value->'examplesZh'->0;
    IF jsonb_typeof(candidate) = 'string' AND dictionary_text_is_nonblank(candidate #>> '{}') THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION dictionary_meaning_has_translation(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  item JSONB;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;
  IF jsonb_typeof(value->'definitions') = 'array' THEN
    FOR item IN SELECT element FROM jsonb_array_elements(value->'definitions') AS element LOOP
      IF dictionary_definition_item_has_translation(item, NULL::jsonb) THEN RETURN TRUE; END IF;
    END LOOP;
    RETURN FALSE;
  END IF;
  IF dictionary_jsonb_is_js_truthy(value->'definition')
    OR dictionary_jsonb_is_js_truthy(value->'meaning')
    OR dictionary_jsonb_is_js_truthy(value->'text') THEN
    RETURN dictionary_definition_item_has_translation(value, NULL::jsonb);
  END IF;
  RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION dictionary_definitions_have_translation(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  item JSONB;
  item_index BIGINT;
  looks_like_meanings BOOLEAN := FALSE;
  parsed_string JSONB;
  string_value TEXT;
  fallback_zh JSONB;
BEGIN
  IF value IS NULL OR value = 'null'::jsonb THEN RETURN FALSE; END IF;
  IF jsonb_typeof(value) = 'string' THEN
    string_value := value #>> '{}';
    BEGIN
      parsed_string := string_value::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN FALSE;
    END;
    IF jsonb_typeof(parsed_string) NOT IN ('array', 'object') THEN RETURN FALSE; END IF;
    RETURN dictionary_definitions_have_translation(parsed_string);
  END IF;
  IF jsonb_typeof(value) = 'array' THEN
    FOR item IN SELECT element FROM jsonb_array_elements(value) AS element LOOP
      IF jsonb_typeof(item) = 'object' AND (
        jsonb_typeof(item->'definitions') = 'array'
        OR dictionary_jsonb_is_js_truthy(item->'partOfSpeech')
        OR dictionary_jsonb_is_js_truthy(item->'part_of_speech')
        OR dictionary_jsonb_is_js_truthy(item->'pos')
      ) THEN
        looks_like_meanings := TRUE;
        EXIT;
      END IF;
    END LOOP;
    FOR item IN SELECT element FROM jsonb_array_elements(value) AS element LOOP
      IF (looks_like_meanings AND dictionary_meaning_has_translation(item))
        OR (NOT looks_like_meanings AND dictionary_definition_item_has_translation(item, NULL::jsonb)) THEN
        RETURN TRUE;
      END IF;
    END LOOP;
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;
  IF jsonb_typeof(value->'meanings') = 'array' THEN
    FOR item IN SELECT element FROM jsonb_array_elements(value->'meanings') AS element LOOP
      IF dictionary_meaning_has_translation(item) THEN RETURN TRUE; END IF;
    END LOOP;
    RETURN FALSE;
  END IF;
  IF value ? 'en' THEN
    IF jsonb_typeof(value->'en') = 'array' THEN
      FOR item, item_index IN
        SELECT element, ordinality
        FROM jsonb_array_elements(value->'en') WITH ORDINALITY AS elements(element, ordinality)
      LOOP
        IF jsonb_typeof(value->'zh') = 'array' THEN
          fallback_zh := (value->'zh')->((item_index - 1)::integer);
          IF fallback_zh IS NULL OR fallback_zh = 'null'::jsonb THEN
            fallback_zh := value->'zh'->0;
          END IF;
        ELSE
          fallback_zh := value->'zh';
        END IF;
        IF dictionary_definition_item_has_translation(item, fallback_zh) THEN RETURN TRUE; END IF;
      END LOOP;
      RETURN FALSE;
    END IF;
    fallback_zh := CASE
      WHEN jsonb_typeof(value->'zh') = 'array' THEN value->'zh'->0
      ELSE value->'zh'
    END;
    RETURN dictionary_definition_item_has_translation(value->'en', fallback_zh);
  END IF;
  IF jsonb_typeof(value->'definitions') = 'array' THEN
    RETURN dictionary_meaning_has_translation(value);
  END IF;
  RETURN dictionary_definition_item_has_translation(value, NULL::jsonb);
END $$;

CREATE OR REPLACE FUNCTION dictionary_word_is_seo_eligible(value words)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE((value.quality_status = 'verified'
    AND value.quality_score >= 80
    AND jsonb_typeof(value.quality_reasons) = 'array'
    AND jsonb_array_length(value.quality_reasons) = 0
    AND value.quality_checked_revision = value.content_revision
    AND value.quality_checked_at IS NOT NULL
    AND value.phonetic_source = ANY (ARRAY['manual_verified','batch_verified','curated','external'])
    AND value.definitions_source = ANY (ARRAY['manual_verified','batch_verified','curated','external'])
    AND (NULLIF(BTRIM(value.part_of_speech), '') IS NULL
      OR value.part_of_speech_source = ANY (ARRAY['manual_verified','batch_verified','curated','external']))
    AND (NOT dictionary_definitions_have_translation(value.definitions)
      OR value.zh_source = ANY (ARRAY['manual_verified','batch_verified','curated','external']))
    AND dictionary_phonetic_is_valid(value.phonetic)
    AND dictionary_definitions_are_valid(value.definitions)
    AND CASE LOWER(value.word_lowercase)
      WHEN 'meeting' THEN value.phonetic = 'ˈmiːtɪŋ'
      WHEN 'the' THEN value.phonetic = 'ðə'
      WHEN 'and' THEN value.phonetic = 'ænd'
      WHEN 'have' THEN value.phonetic = 'hæv'
      ELSE TRUE
    END), FALSE)
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='words'::regclass AND conname='words_quality_status_check') THEN
    ALTER TABLE words ADD CONSTRAINT words_quality_status_check
      CHECK (quality_status IN ('review', 'verified', 'rejected')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='words'::regclass AND conname='words_quality_score_check') THEN
    ALTER TABLE words ADD CONSTRAINT words_quality_score_check
      CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 100)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='words'::regclass AND conname='words_quality_sources_check') THEN
    ALTER TABLE words ADD CONSTRAINT words_quality_sources_check CHECK (
      (phonetic_source IS NULL OR phonetic_source = ANY (ARRAY['manual_verified','batch_verified','curated','external','legacy'])) AND
      (definitions_source IS NULL OR definitions_source = ANY (ARRAY['manual_verified','batch_verified','curated','external','legacy'])) AND
      (zh_source IS NULL OR zh_source = ANY (ARRAY['manual_verified','batch_verified','curated','external','legacy'])) AND
      (part_of_speech_source IS NULL OR part_of_speech_source = ANY (ARRAY['manual_verified','batch_verified','curated','external','legacy']))
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='words'::regclass AND conname='words_quality_json_shape_check') THEN
    ALTER TABLE words ADD CONSTRAINT words_quality_json_shape_check CHECK (
      jsonb_typeof(quality_reasons) = 'array' AND jsonb_typeof(quality_meta) = 'object'
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='words'::regclass AND conname='words_seo_indexable_implies_quality_check') THEN
    ALTER TABLE words ADD CONSTRAINT words_seo_indexable_implies_quality_check CHECK (
      NOT seo_indexable OR dictionary_word_is_seo_eligible(words)
    ) NOT VALID;
  END IF;
END $$;

ALTER TABLE words VALIDATE CONSTRAINT words_quality_status_check;
ALTER TABLE words VALIDATE CONSTRAINT words_quality_score_check;
ALTER TABLE words VALIDATE CONSTRAINT words_quality_sources_check;
ALTER TABLE words VALIDATE CONSTRAINT words_quality_json_shape_check;
ALTER TABLE words VALIDATE CONSTRAINT words_seo_indexable_implies_quality_check;

-- Phase 3: remove artifacts left by interrupted CREATE INDEX CONCURRENTLY.
-- psql \gexec runs each generated DROP at top level, outside a transaction.
SELECT format('DROP INDEX CONCURRENTLY IF EXISTS %I.%I', namespace.nspname, index_class.relname)
FROM pg_index index_state
JOIN pg_class index_class ON index_class.oid = index_state.indexrelid
JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
WHERE index_class.relname = ANY (ARRAY[
  'uq_words_word_lowercase',
  'idx_words_dictionary_quality_review',
  'idx_words_dictionary_seo_eligible',
  'idx_words_dictionary_stale_quality',
  'idx_dictionary_quality_revisions_batch_active',
  'idx_dictionary_quality_revisions_word'
]) AND NOT index_state.indisvalid
\gexec

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_words_word_lowercase
  ON words (word_lowercase);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_words_dictionary_quality_review
  ON words (updated_at DESC, id) WHERE quality_status = 'review';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_words_dictionary_seo_eligible
  ON words (frequency_rank ASC NULLS LAST, id) WHERE seo_indexable = TRUE AND quality_status = 'verified';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_words_dictionary_stale_quality
  ON words (content_revision, id) WHERE quality_checked_revision IS DISTINCT FROM content_revision;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dictionary_quality_revisions_batch_active
  ON dictionary_quality_revisions (batch_id, id) WHERE rolled_back_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dictionary_quality_revisions_word
  ON dictionary_quality_revisions (word_id, id);

-- The unique valid index fully replaces the old non-unique single-column copy.
SELECT 'DROP INDEX CONCURRENTLY IF EXISTS idx_words_lower'
WHERE EXISTS (
  SELECT 1 FROM pg_index WHERE indexrelid='uq_words_word_lowercase'::regclass AND indisvalid AND indisunique
)
\gexec

-- Phase 4: short trigger swap. Every publicly rendered/restored content field
-- invalidates review even when an UPDATE writes the same value.
CREATE OR REPLACE FUNCTION invalidate_dictionary_quality_on_legacy_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.content_revision := OLD.content_revision + 1;
  NEW.quality_status := 'review';
  NEW.quality_score := NULL;
  NEW.quality_reasons := '["legacy_direct_write"]'::jsonb;
  NEW.quality_meta := jsonb_build_object('invalidated_at', CURRENT_TIMESTAMP, 'previous_revision', OLD.content_revision);
  NEW.quality_checked_revision := NULL;
  NEW.quality_checked_at := NULL;
  NEW.seo_indexable := FALSE;

  IF NEW.phonetic IS DISTINCT FROM OLD.phonetic THEN NEW.phonetic_source := NULL; END IF;
  IF NEW.definitions IS DISTINCT FROM OLD.definitions
     OR NEW.example_sentences IS DISTINCT FROM OLD.example_sentences
     OR NEW.synonyms IS DISTINCT FROM OLD.synonyms THEN
    NEW.definitions_source := NULL;
    NEW.zh_source := NULL;
  END IF;
  IF NEW.part_of_speech IS DISTINCT FROM OLD.part_of_speech THEN NEW.part_of_speech_source := NULL; END IF;
  IF NEW.word IS DISTINCT FROM OLD.word OR NEW.word_lowercase IS DISTINCT FROM OLD.word_lowercase THEN
    NEW.phonetic_source := NULL;
    NEW.definitions_source := NULL;
    NEW.zh_source := NULL;
    NEW.part_of_speech_source := NULL;
  END IF;
  RETURN NEW;
END $$;

BEGIN;
SET LOCAL lock_timeout = '2s';
DROP TRIGGER IF EXISTS trg_words_invalidate_dictionary_quality ON words;
CREATE TRIGGER trg_words_invalidate_dictionary_quality
BEFORE UPDATE OF word, word_lowercase, phonetic, definitions, part_of_speech, example_sentences, synonyms
ON words
FOR EACH ROW
EXECUTE FUNCTION invalidate_dictionary_quality_on_legacy_write();
COMMIT;
