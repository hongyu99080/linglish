#!/usr/bin/env node
const path = require('path');
const pdfImportService = require('../services/pdf-import');

async function main() {
  const pdfPath = path.join(__dirname, '../HipHipHooray5StudentBook-2ndEdition.pdf');

  console.log('Testing PDF extraction...');
  const result = await pdfImportService.extractTextFromPDF(pdfPath);

  console.log('\n=== PDF Info ===');
  console.log('Pages:', result.pages);
  console.log('Text length:', result.text.length);
  console.log('\n=== First 1000 characters ===');
  console.log(result.text.substring(0, 1000));
  console.log('\n=== Last 500 characters ===');
  console.log(result.text.substring(result.text.length - 500));

  const sections = pdfImportService.splitIntoSections(result.text);
  console.log('\n=== Sections ===');
  console.log('Total sections:', sections.length);
  sections.slice(0, 3).forEach((section, i) => {
    console.log(`\n--- Section ${i + 1} (${section.length} chars) ---`);
    console.log(section.substring(0, 200));
  });
}

main().catch(console.error);
