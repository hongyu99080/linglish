const fs = require('fs/promises');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const dataStore = require('../data-store');

/**
 * Extract text content from PDF file
 * @param {string} pdfPath - Path to PDF file
 * @returns {Promise<{text: string, pages: number, info: object}>}
 */
async function extractTextFromPDF(pdfPath) {
  // Convert file path to file:// URL
  const fileUrl = `file://${pdfPath}`;
  const parser = new PDFParse({ url: fileUrl });
  const result = await parser.getText();

  return {
    text: result.text,
    pages: result.numPages,
    info: result.info,
  };
}

/**
 * Split text into paragraphs or sections
 * @param {string} text - Full text content
 * @returns {Array<string>}
 */
function splitIntoSections(text) {
  // Split by double newlines or major breaks
  const sections = text
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 50); // Filter out very short sections

  return sections;
}

/**
 * Calculate basic difficulty score based on text characteristics
 * @param {string} text - Text content
 * @returns {number} Score between 0-100
 */
function calculateDifficulty(text) {
  const words = text.split(/\s+/);
  const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  const sentenceCount = (text.match(/[.!?]+/g) || []).length;
  const avgSentenceLength = words.length / Math.max(sentenceCount, 1);

  // Simple heuristic: longer words and sentences = harder
  const wordScore = Math.min(avgWordLength * 8, 50);
  const sentenceScore = Math.min(avgSentenceLength * 2, 50);

  return Math.round(wordScore + sentenceScore);
}

/**
 * Map difficulty score to CEFR level
 * @param {number} score - Difficulty score (0-100)
 * @returns {string} CEFR level
 */
function mapToCEFRLevel(score) {
  if (score < 20) return 'A1';
  if (score < 35) return 'A2';
  if (score < 50) return 'B1';
  if (score < 65) return 'B2';
  if (score < 80) return 'C1';
  return 'C2';
}

/**
 * Import PDF as articles into database
 * @param {string} pdfPath - Path to PDF file
 * @param {object} options - Import options
 * @returns {Promise<{success: boolean, articlesCreated: number}>}
 */
async function importPDFAsArticles(pdfPath, options = {}) {
  const {
    title = 'Imported PDF Content',
    tags = ['imported', 'pdf'],
    splitBySections = true,
    createSingleArticle = false,
    originalFilename = 'imported.pdf',
  } = options;

  try {
    // Copy PDF file to pdfs directory for later viewing
    const pdfsDir = path.join(__dirname, '..', 'pdfs');
    const sanitizedFilename = originalFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = Date.now();
    const savedFilename = `${timestamp}-${sanitizedFilename}`;
    const savedPath = path.join(pdfsDir, savedFilename);

    await fs.copyFile(pdfPath, savedPath);
    const relativePdfPath = `/pdfs/${savedFilename}`;
    console.log(`PDF saved to: ${relativePdfPath}`);

    // Extract PDF content
    const { text, pages, info } = await extractTextFromPDF(pdfPath);

    if (!text || text.trim().length === 0) {
      throw new Error('No text content found in PDF');
    }

    console.log(`PDF extracted: ${pages} pages, ${text.length} characters`);

    const articlesCreated = [];

    if (createSingleArticle) {
      // Create single article from entire PDF
      const article = await createArticleFromText(text, {
        title: `${title} (Complete)`,
        tags,
        metadata: { source: 'pdf', pages, pdfInfo: info },
        pdfPath: relativePdfPath,
      });
      articlesCreated.push(article);
    } else if (splitBySections) {
      // Split into multiple articles
      const sections = splitIntoSections(text);
      console.log(`Split into ${sections.length} sections`);

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const article = await createArticleFromText(section, {
          title: `${title} - Part ${i + 1}`,
          tags: [...tags, `part-${i + 1}`],
          metadata: { source: 'pdf', section: i + 1, totalSections: sections.length },
          pdfPath: relativePdfPath,
        });
        articlesCreated.push(article);
      }
    }

    return {
      success: true,
      articlesCreated: articlesCreated.length,
      articles: articlesCreated,
    };
  } catch (error) {
    console.error('PDF import error:', error);
    throw error;
  }
}

/**
 * Create article from text content
 * @param {string} text - Article text
 * @param {object} options - Article options
 * @returns {Promise<object>}
 */
async function createArticleFromText(text, options = {}) {
  const { title, tags = [], metadata = {}, pdfPath = null } = options;

  const wordCount = text.split(/\s+/).length;
  const difficultyScore = calculateDifficulty(text);
  const level = mapToCEFRLevel(difficultyScore);

  const pool = await dataStore.init();

  const { rows } = await pool.query(
    `INSERT INTO articles
     (title, content, level, tags, word_count, difficulty_score, status, source_type, pdf_path, created_at, updated_at, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'published', 'pdf', $7, NOW(), NOW(), NOW())
     RETURNING *`,
    [
      title,
      text,
      level,
      tags,
      wordCount,
      difficultyScore / 100, // Convert to decimal (0.0 to 1.0)
      pdfPath,
    ]
  );

  console.log(`Created article: ${title} (${wordCount} words, ${level})`);
  return rows[0];
}

module.exports = {
  extractTextFromPDF,
  importPDFAsArticles,
  createArticleFromText,
  splitIntoSections,
  calculateDifficulty,
  mapToCEFRLevel,
};
