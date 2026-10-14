/**
 * Fix invalid thumbnail_path values in database
 *
 * This script finds and fixes video resources that have invalid thumbnail_path
 * values containing template literal syntax like '${thumbnail || ''}'
 *
 * Usage: node scripts/fix-invalid-thumbnail-paths.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const dataStore = require('../data-store');

async function fixInvalidThumbnailPaths() {
  console.log('[Fix] Checking for invalid thumbnail_path values...');

  try {
    // Find all videos with invalid thumbnail_path containing '${'
    const result = await dataStore.query(`
      SELECT id, title, thumbnail_path
      FROM video_resources
      WHERE thumbnail_path LIKE '%\${%'
    `);

    if (!result.rows || result.rows.length === 0) {
      console.log('[Fix] No invalid thumbnail_path values found.');
      return;
    }

    console.log(`[Fix] Found ${result.rows.length} video(s) with invalid thumbnail_path:`);

    for (const video of result.rows) {
      console.log(`  - ID: ${video.id}, Title: ${video.title}`);
      console.log(`    Invalid value: ${video.thumbnail_path}`);
    }

    // Fix them by setting thumbnail_path to NULL
    const updateResult = await dataStore.query(`
      UPDATE video_resources
      SET thumbnail_path = NULL, updated_at = NOW()
      WHERE thumbnail_path LIKE '%\${%'
      RETURNING id
    `);

    console.log(`[Fix] Fixed ${updateResult.rows.length} video(s) by setting thumbnail_path to NULL.`);
    console.log('[Fix] Done.');

  } catch (err) {
    console.error('[Fix] Error:', err.message);
    process.exit(1);
  }

  process.exit(0);
}

fixInvalidThumbnailPaths();
