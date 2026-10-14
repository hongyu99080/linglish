#!/usr/bin/env node
/**
 * OCR processing script for Hip Hip Hooray 5 Student Book
 * This script will:
 * 1. Extract images from each PDF page
 * 2. Perform OCR to extract text
 * 3. Structure content by units
 * 4. Store in database
 */

const path = require('path');
const ocrService = require('../services/ocr');
const dataStore = require('../data-store');

const PDF_PATH = path.join(__dirname, '../HipHipHooray5StudentBook-2ndEdition.pdf');

// Hip Hip Hooray 5 typically has 8 units, each about 14 pages
// Approximate page ranges for each unit
const UNIT_STRUCTURE = [
  { unit: 1, title: 'Unit 1 - Friends and Family', startPage: 5, endPage: 18 },
  { unit: 2, title: 'Unit 2 - School Life', startPage: 19, endPage: 32 },
  { unit: 3, title: 'Unit 3 - Hobbies and Free Time', startPage: 33, endPage: 46 },
  { unit: 4, title: 'Unit 4 - Food and Health', startPage: 47, endPage: 60 },
  { unit: 5, title: 'Unit 5 - Travel and Places', startPage: 61, endPage: 74 },
  { unit: 6, title: 'Unit 6 - Nature and Environment', startPage: 75, endPage: 88 },
  { unit: 7, title: 'Unit 7 - Technology and Media', startPage: 89, endPage: 102 },
  { unit: 8, title: 'Unit 8 - Future Plans', startPage: 103, endPage: 115 },
];

async function processBook() {
  console.log('======================================');
  console.log('Hip Hip Hooray 5 OCR Processing');
  console.log('======================================\n');

  console.log(`PDF: ${PDF_PATH}`);
  console.log(`Units to process: ${UNIT_STRUCTURE.length}\n`);

  // Check if PDF is scanned
  const isScanned = await ocrService.isScannedPDF(PDF_PATH);
  console.log(`PDF type: ${isScanned ? 'Scanned (Image-based)' : 'Text-based'}\n`);

  if (!isScanned) {
    console.log('⚠️  PDF contains text layer. OCR may not be necessary.');
    console.log('Consider using regular text extraction instead.\n');
  }

  const pool = await dataStore.init();

  // Process each unit
  for (const unitInfo of UNIT_STRUCTURE) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing ${unitInfo.title}`);
    console.log(`Pages: ${unitInfo.startPage}-${unitInfo.endPage}`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      // Extract text using OCR
      console.log('Starting OCR extraction...');
      const text = await ocrService.extractPageRange(
        PDF_PATH,
        unitInfo.startPage,
        unitInfo.endPage,
        'eng' // English OCR
      );

      if (!text || text.trim().length < 100) {
        console.warn(`⚠️  Very little text extracted (${text.length} chars)`);
        console.warn('Skipping this unit. May need manual review.\n');
        continue;
      }

      console.log(`✓ Extracted ${text.length} characters`);

      // Store in database
      const wordCount = text.split(/\s+/).length;

      const { rows } = await pool.query(
        `INSERT INTO articles
         (title, content, level, tags, word_count, difficulty_score, status, source_type, source_url, created_at, updated_at, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'published', 'ocr_import', $7, NOW(), NOW(), NOW())
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          `Hip Hip Hooray 5 - ${unitInfo.title}`,
          text,
          'A2',
          ['textbook', 'hip-hip-hooray', 'level-5', 'ocr', 'children'],
          wordCount,
          0.40,
          `HipHipHooray5StudentBook-2ndEdition.pdf (pages ${unitInfo.startPage}-${unitInfo.endPage})`
        ]
      );

      if (rows && rows.length > 0) {
        console.log(`✓ Saved to database (ID: ${rows[0].id}, ${wordCount} words)\n`);
      } else {
        console.log(`⚠️  Article may already exist in database\n`);
      }

    } catch (err) {
      console.error(`✗ Error processing ${unitInfo.title}:`, err.message);
      console.error(err);
    }
  }

  console.log('\n======================================');
  console.log('OCR Processing Complete!');
  console.log('======================================\n');

  console.log('Next steps:');
  console.log('1. Review extracted content in database');
  console.log('2. Generate TTS audio for reading');
  console.log('3. Create audio segments for each section');

  process.exit(0);
}

// Run if called directly
if (require.main === module) {
  processBook().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { processBook, UNIT_STRUCTURE };
