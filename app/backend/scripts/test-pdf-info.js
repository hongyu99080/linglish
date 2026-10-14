#!/usr/bin/env node
const { PDFParse } = require('pdf-parse');
const path = require('path');

async function main() {
  const pdfPath = path.join(__dirname, '../HipHipHooray5StudentBook-2ndEdition.pdf');
  const fileUrl = `file://${pdfPath}`;

  console.log('Testing PDF info extraction...');
  const parser = new PDFParse({ url: fileUrl });

  // Get basic info
  const info = await parser.getInfo();
  console.log('\n=== PDF Info ===');
  console.log(JSON.stringify(info, null, 2));

  // Try to get text from first few pages
  console.log('\n=== Text from pages ===');
  for (let i = 1; i <= Math.min(3, info.numPages || 3); i++) {
    const textResult = await parser.getText({ pageNumber: i });
    console.log(`\nPage ${i} (${textResult.text.length} chars):`);
    console.log(textResult.text.substring(0, 300));
  }

  // Check if there are images
  console.log('\n=== Checking for images ===');
  try {
    const imagesResult = await parser.getImage({ pageNumber: 1 });
    console.log('Images on page 1:', imagesResult.images.length);
  } catch (err) {
    console.log('Image extraction error:', err.message);
  }
}

main().catch(console.error);
