-- Clean up invalid translations from the words table
-- This SQL script finds words with invalid Chinese translations and clears them for re-translation
--
-- What this script considers as invalid:
-- 1. zh field contains only English text (no Chinese characters)
-- 2. zh field is identical to the English definition
-- 3. zh field is a placeholder like '[待翻译]' or '翻译中...'
--
-- Usage:
--   psql linglish < clean-fake-translations.sql
--
-- WARNING: This script directly modifies the database
-- Make a backup before running: pg_dump linglish > backup.sql

BEGIN;

-- First, let's see what we're going to clean (preview)
-- Uncomment these lines to see a preview before making changes:
-- SELECT 
--   word,
--   word_lowercase,
--   jsonb_pretty(definitions) as definitions_preview
-- FROM words 
-- WHERE definitions IS NOT NULL
--   AND definitions::jsonb->'meanings' IS NOT NULL
-- LIMIT 5;

-- Function to detect if a text contains Chinese characters
CREATE OR REPLACE FUNCTION has_chinese_characters(text_val TEXT) RETURNS BOOLEAN AS $$
BEGIN
  RETURN text_val ~ '[\u4e00-\u9fa5]';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Update words with invalid translations
-- This query will:
-- 1. Find all words with definitions
-- 2. Check each definition's zh field
-- 3. Clear zh if it doesn't contain Chinese characters

UPDATE words
SET 
  definitions = (
    SELECT jsonb_build_object(
      'zh', definitions->'zh',
      'en', definitions->'en',
      'meanings', (
        SELECT jsonb_agg(
          jsonb_build_object(
            'partOfSpeech', meaning->'partOfSpeech',
            'definitions', (
              SELECT jsonb_agg(
                CASE 
                  -- Clear zh if it doesn't contain Chinese characters
                  WHEN def->>'zh' IS NOT NULL 
                    AND NOT has_chinese_characters(def->>'zh')
                  THEN def - 'zh'
                  
                  -- Clear zh if it's a placeholder
                  WHEN def->>'zh' IN ('[待翻译]', '翻译中...')
                  THEN def - 'zh'
                  
                  -- Keep zh if it's valid (contains Chinese)
                  ELSE def
                END
              )
              FROM jsonb_array_elements(meaning->'definitions') AS def
            )
          )
        )
        FROM jsonb_array_elements(definitions->'meanings') AS meaning
      )
    )
  ),
  updated_at = NOW()
WHERE definitions IS NOT NULL
  AND definitions::jsonb->'meanings' IS NOT NULL
  AND EXISTS (
    -- Only update if there are invalid translations
    SELECT 1
    FROM jsonb_array_elements(definitions::jsonb->'meanings') AS meaning,
         jsonb_array_elements(meaning->'definitions') AS def
    WHERE def->>'zh' IS NOT NULL
      AND (
        NOT has_chinese_characters(def->>'zh')
        OR def->>'zh' IN ('[待翻译]', '翻译中...')
      )
  );

-- Clean up the function
DROP FUNCTION IF EXISTS has_chinese_characters(TEXT);

-- Show summary
SELECT 
  'Cleanup completed!' as status,
  COUNT(*) as total_words_with_definitions,
  COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '1 minute') as words_updated
FROM words 
WHERE definitions IS NOT NULL;

COMMIT;

-- After running this script:
-- 1. Invalid translations have been cleared
-- 2. Next time a word is looked up, the translation will be re-attempted
-- 3. Check the application logs to see if re-translation is working
