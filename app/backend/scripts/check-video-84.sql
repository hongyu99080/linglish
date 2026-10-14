-- Check Video ID 84 and other recent YouTube videos

-- Check Video 84
SELECT
  id,
  title,
  video_path,
  youtube_video_id,
  has_subtitles,
  transcript IS NOT NULL as has_transcript,
  LENGTH(transcript::text) as transcript_length,
  CASE
    WHEN transcript_segments IS NULL THEN 'NULL'
    WHEN transcript_segments::text = '[]' THEN 'EMPTY_ARRAY'
    WHEN jsonb_array_length(transcript_segments) = 0 THEN 'ZERO_LENGTH'
    ELSE 'HAS_DATA (' || jsonb_array_length(transcript_segments)::text || ' segments)'
  END as segments_status,
  word_count,
  unique_word_count,
  created_at,
  updated_at
FROM video_resources
WHERE id = 84;

-- Check all recent YouTube videos
SELECT
  id,
  SUBSTRING(title, 1, 50) as title,
  youtube_video_id,
  has_subtitles,
  CASE
    WHEN transcript_segments IS NULL THEN 'NULL'
    WHEN transcript_segments::text = '[]' THEN 'EMPTY_ARRAY'
    WHEN jsonb_array_length(transcript_segments) = 0 THEN 'ZERO_LENGTH'
    ELSE jsonb_array_length(transcript_segments)::text || ' segments'
  END as segments_status,
  created_at
FROM video_resources
WHERE youtube_video_id IS NOT NULL
ORDER BY id DESC
LIMIT 10;

-- Check video_sentences table for video 84
SELECT COUNT(*) as sentence_count
FROM video_sentences
WHERE video_id = 84;

-- Show first few sentences if any exist
SELECT sentence_index, SUBSTRING(text, 1, 50) as text_preview, start_time_sec, end_time_sec
FROM video_sentences
WHERE video_id = 84
ORDER BY sentence_index
LIMIT 5;
