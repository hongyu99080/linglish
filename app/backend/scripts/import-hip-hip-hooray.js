#!/usr/bin/env node
/**
 * Script to import HipHipHooray5StudentBook-2ndEdition.pdf
 * Run with: node scripts/import-hip-hip-hooray.js
 */

const path = require('path');
const pdfImportService = require('../services/pdf-import');

async function main() {
  const pdfPath = path.join(__dirname, '../HipHipHooray5StudentBook-2ndEdition.pdf');

  console.log('Starting PDF import...');
  console.log('PDF path:', pdfPath);

  try {
    const result = await pdfImportService.importPDFAsArticles(pdfPath, {
      title: 'Hip Hip Hooray 5 Student Book',
      tags: ['textbook', 'hip-hip-hooray', 'student-book', 'level-5', 'children'],
      splitBySections: true,
      createSingleArticle: false,
    });

    console.log('\n✓ Import completed successfully!');
    console.log(`✓ Created ${result.articlesCreated} articles`);
    console.log('\nArticles created:');

    result.articles.forEach((article, index) => {
      console.log(
        `  ${index + 1}. ${article.title} (${article.word_count} words, ${article.level})`
      );
    });

    process.exit(0);
  } catch (error) {
    console.error('\n✗ Import failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

main();
