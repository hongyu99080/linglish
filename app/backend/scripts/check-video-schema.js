#!/usr/bin/env node
/**
 * Check if video_resources table has the transcript_segments column
 * and apply V11 migration if needed
 */

const { Pool } = require('pg');
require('dotenv').config();

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    console.log('🔍 Checking video_resources table schema...\n');

    // Check if transcript_segments column exists
    const checkColumn = await pool.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'video_resources'
        AND column_name IN ('transcript_segments', 'transcript', 'has_subtitles', 'youtube_video_id')
      ORDER BY column_name;
    `);

    if (checkColumn.rows.length === 0) {
      console.log('❌ No YouTube integration columns found!');
      console.log('📋 V11 migration needs to be applied.\n');

      console.log('Applying V11 migration...');
      const fs = require('fs');
      const path = require('path');
      const migrationPath = path.join(__dirname, '../../../docs/db/migrations/V11__youtube_integration.sql');
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

      await pool.query(migrationSQL);
      console.log('✅ V11 migration applied successfully!\n');
    } else {
      console.log('✅ YouTube integration columns found:');
      checkColumn.rows.forEach(row => {
        console.log(`   - ${row.column_name}: ${row.data_type}${row.column_default ? ` (default: ${row.column_default})` : ''}`);
      });
      console.log();
    }

    // Check current data
    console.log('📊 Checking current video data...\n');
    const videoCheck = await pool.query(`
      SELECT id, title,
             youtube_video_id,
             has_subtitles,
             CASE
               WHEN transcript_segments IS NULL THEN 'NULL'
               WHEN jsonb_array_length(transcript_segments) = 0 THEN 'EMPTY_ARRAY'
               ELSE 'HAS_DATA (' || jsonb_array_length(transcript_segments)::text || ' segments)'
             END as segments_status
      FROM video_resources
      WHERE youtube_video_id IS NOT NULL
      ORDER BY id DESC
      LIMIT 10;
    `);

    if (videoCheck.rows.length > 0) {
      console.log('YouTube videos in database:');
      videoCheck.rows.forEach(row => {
        console.log(`   Video ${row.id}: ${row.title}`);
        console.log(`      YouTube ID: ${row.youtube_video_id}`);
        console.log(`      has_subtitles: ${row.has_subtitles}`);
        console.log(`      transcript_segments: ${row.segments_status}`);
        console.log();
      });
    } else {
      console.log('No YouTube videos found in database.');
    }

    pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    pool.end();
    process.exit(1);
  }
}

main();
