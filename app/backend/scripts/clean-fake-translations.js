#!/usr/bin/env node

/**
 * Clean up invalid translations from the words table
 *
 * This script identifies and cleans up definitions in the words table where:
 * - The Chinese translation (zh) field contains English text instead of Chinese
 * - The zh field is identical to the English definition
 * - The zh field is empty or just whitespace
 *
 * Usage:
 *   node clean-fake-translations.js [--dry-run] [--limit=100]
 *
 * Options:
 *   --dry-run    Show what would be cleaned without making changes
 *   --limit=N    Process only N words (default: all)
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const limitArg = args.find(arg => arg.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

// Helper function to validate Chinese translation
function isValidChineseTranslation(zhText, enText) {
  if (!zhText || zhText === '[待翻译]' || zhText === '翻译中...') return false;
  // Must contain Chinese characters
  const hasChinese = /[\u4e00-\u9fa5]/.test(zhText);
  if (!hasChinese) return false;
  // Should not be identical to English text (case-insensitive)
  if (enText && zhText.toLowerCase().trim() === enText.toLowerCase().trim()) return false;
  return true;
}

async function cleanFakeTranslations() {
  console.log('=== Starting cleanup of invalid translations ===');
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (will update database)'}`);
  if (limit) console.log(`Limit: Processing first ${limit} words`);
  console.log('');

  try {
    // Get all words with definitions
    const query = limit
      ? 'SELECT id, word, word_lowercase, definitions FROM words WHERE definitions IS NOT NULL LIMIT $1'
      : 'SELECT id, word, word_lowercase, definitions FROM words WHERE definitions IS NOT NULL';
    const params = limit ? [limit] : [];

    const { rows } = await pool.query(query, params);
    console.log(`Found ${rows.length} words with definitions`);
    console.log('');

    let totalWordsProcessed = 0;
    let totalWordsWithInvalidTranslations = 0;
    let totalInvalidDefinitions = 0;
    let totalInvalidExamples = 0;

    for (const row of rows) {
      const { id, word, word_lowercase, definitions } = row;
      totalWordsProcessed++;

      if (!definitions || !definitions.meanings) continue;

      let hasInvalidTranslations = false;
      let invalidDefCount = 0;
      let invalidExCount = 0;

      // Check each meaning and definition
      for (let mIdx = 0; mIdx < definitions.meanings.length; mIdx++) {
        const meaning = definitions.meanings[mIdx];
        if (!meaning.definitions) continue;

        for (let dIdx = 0; dIdx < meaning.definitions.length; dIdx++) {
          const def = meaning.definitions[dIdx];

          // Check definition translation
          if (def.zh && !isValidChineseTranslation(def.zh, def.definition)) {
            hasInvalidTranslations = true;
            invalidDefCount++;
            console.log(`❌ [${word}] [${mIdx},${dIdx}] Invalid definition translation:`);
            console.log(`   EN: ${def.definition.substring(0, 80)}`);
            console.log(`   ZH: ${def.zh.substring(0, 80)}`);

            if (!isDryRun) {
              // Clear invalid translation
              def.zh = '';
            }
          }

          // Check example translation
          if (def.exampleZh && def.example && !isValidChineseTranslation(def.exampleZh, def.example)) {
            hasInvalidTranslations = true;
            invalidExCount++;
            console.log(`❌ [${word}] [${mIdx},${dIdx}] Invalid example translation:`);
            console.log(`   EN: ${def.example.substring(0, 80)}`);
            console.log(`   ZH: ${def.exampleZh.substring(0, 80)}`);

            if (!isDryRun) {
              // Clear invalid example translation
              def.exampleZh = '';
            }
          }

          // Check examplesZh array
          if (def.examplesZh && Array.isArray(def.examplesZh) && def.example) {
            const validExamples = def.examplesZh.filter(exZh =>
              isValidChineseTranslation(exZh, def.example)
            );

            if (validExamples.length !== def.examplesZh.length) {
              hasInvalidTranslations = true;
              const invalidCount = def.examplesZh.length - validExamples.length;
              invalidExCount += invalidCount;
              console.log(`❌ [${word}] [${mIdx},${dIdx}] Found ${invalidCount} invalid example(s) in array`);

              if (!isDryRun) {
                // Keep only valid examples
                def.examplesZh = validExamples.length > 0 ? validExamples : [];
              }
            }
          }
        }
      }

      if (hasInvalidTranslations) {
        totalWordsWithInvalidTranslations++;
        totalInvalidDefinitions += invalidDefCount;
        totalInvalidExamples += invalidExCount;

        if (!isDryRun) {
          // Update the word in database
          await pool.query(
            'UPDATE words SET definitions = $1, updated_at = NOW() WHERE id = $2',
            [JSON.stringify(definitions), id]
          );
          console.log(`✅ Updated word "${word}" (cleared ${invalidDefCount} def(s), ${invalidExCount} example(s))`);
        } else {
          console.log(`   (would clear ${invalidDefCount} def(s), ${invalidExCount} example(s) in live mode)`);
        }
        console.log('');
      }
    }

    console.log('=== Cleanup Summary ===');
    console.log(`Total words processed: ${totalWordsProcessed}`);
    console.log(`Words with invalid translations: ${totalWordsWithInvalidTranslations}`);
    console.log(`Invalid definition translations: ${totalInvalidDefinitions}`);
    console.log(`Invalid example translations: ${totalInvalidExamples}`);
    console.log('');

    if (isDryRun) {
      console.log('ℹ️  This was a dry run. No changes were made to the database.');
      console.log('   Run without --dry-run to apply changes.');
    } else {
      console.log('✅ Database updated successfully!');
      console.log('   Invalid translations have been cleared and will be re-translated on next lookup.');
    }

  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Run the cleanup
cleanFakeTranslations().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
