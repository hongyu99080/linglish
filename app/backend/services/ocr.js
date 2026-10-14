const Tesseract = require('tesseract.js');
const { PDFParse } = require('pdf-parse');
const fs = require('fs/promises');
const fsStream = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

// OCR Service Configuration
const USE_LOCAL_OCR = process.env.USE_LOCAL_OCR === 'true';
const OCR_SERVICE_URL = process.env.OCR_SERVICE_URL || 'http://localhost:8000';
const OCR_UPLOAD_ENDPOINT = process.env.OCR_UPLOAD_ENDPOINT || '/ocr/upload';
const OCR_BASE64_ENDPOINT = process.env.OCR_BASE64_ENDPOINT || '/ocr/base64';
const OCR_ENABLE_FALLBACK = process.env.OCR_ENABLE_FALLBACK !== 'false';

// Create a reusable worker for better performance (Tesseract fallback)
let worker = null;

async function getWorker() {
  if (!worker) {
    worker = await Tesseract.createWorker('eng');
  }
  return worker;
}

/**
 * Extract images from PDF and perform OCR
 * @param {string} pdfPath - Path to PDF file
 * @param {object} options - OCR options
 * @returns {Promise<Array>} Array of page results with OCR text
 */
async function extractTextFromScannedPDF(pdfPath, options = {}) {
  const {
    lang = 'eng',  // Language: 'eng', 'chi_sim', 'chi_tra'
    pages = null,   // null = all pages, or array of page numbers [1, 2, 3]
    confidence = 60, // Minimum confidence threshold
  } = options;

  console.log(`Starting OCR extraction from: ${pdfPath}`);

  const fileUrl = `file://${pdfPath}`;
  const parser = new PDFParse({ url: fileUrl });
  const pdfInfo = await parser.getInfo();

  const totalPages = pdfInfo.total || 1;
  const pagesToProcess = pages || Array.from({ length: totalPages }, (_, i) => i + 1);

  console.log(`PDF has ${totalPages} pages. Processing: ${pagesToProcess.length} pages`);

  const results = [];

  for (const pageNum of pagesToProcess) {
    try {
      console.log(`Processing page ${pageNum}/${totalPages}...`);

      // Get screenshot of the page
      const screenshot = await parser.getScreenshot({
        pageNumber: pageNum,
        format: 'png',
        scale: 2.0  // Higher resolution for better OCR
      });

      if (!screenshot || !screenshot.images || screenshot.images.length === 0) {
        console.warn(`No image found for page ${pageNum}`);
        continue;
      }

      // Perform OCR on the page image
      const imageBuffer = screenshot.images[0].buffer;
      const ocrResult = await Tesseract.recognize(imageBuffer, lang, {
        logger: m => {
          if (m.status === 'recognizing text') {
            console.log(`  OCR progress: ${Math.round(m.progress * 100)}%`);
          }
        }
      });

      // Filter by confidence
      const words = ocrResult.data.words.filter(w => w.confidence >= confidence);
      const text = ocrResult.data.text;

      results.push({
        page: pageNum,
        text: text.trim(),
        confidence: ocrResult.data.confidence,
        wordCount: words.length,
        bbox: ocrResult.data.bbox,
      });

      console.log(`  Page ${pageNum} completed. Confidence: ${Math.round(ocrResult.data.confidence)}%`);

    } catch (err) {
      console.error(`Error processing page ${pageNum}:`, err.message);
      results.push({
        page: pageNum,
        text: '',
        error: err.message,
        confidence: 0
      });
    }
  }

  return results;
}

/**
 * Extract text from specific page range
 * @param {string} pdfPath - Path to PDF
 * @param {number} startPage - Start page number
 * @param {number} endPage - End page number
 * @param {string} lang - OCR language
 * @returns {Promise<string>} Combined text from pages
 */
async function extractPageRange(pdfPath, startPage, endPage, lang = 'eng') {
  const pages = Array.from(
    { length: endPage - startPage + 1 },
    (_, i) => startPage + i
  );

  const results = await extractTextFromScannedPDF(pdfPath, { lang, pages });

  return results
    .map(r => r.text)
    .filter(t => t.length > 0)
    .join('\n\n');
}

/**
 * Detect if PDF is text-based or scanned (image-based)
 * @param {string} pdfPath - Path to PDF
 * @returns {Promise<boolean>} True if scanned/image-based
 */
async function isScannedPDF(pdfPath) {
  const fileUrl = `file://${pdfPath}`;
  const parser = new PDFParse({ url: fileUrl });

  // Try to extract text from first page
  const textResult = await parser.getText({ pageNumber: 1 });
  const text = textResult.text.trim();

  // If text is very short or only contains page markers, it's likely scanned
  const meaningfulText = text.replace(/--\s*\d+\s+of\s+\d+\s+--/g, '').trim();

  return meaningfulText.length < 50;
}

/**
 * Call local PaddleOCR service via HTTP
 * @param {string} imagePath - Path to image file
 * @param {boolean} includeWordPositions - Whether to include word positions
 * @returns {Promise<Object>} Extracted text and metadata
 */
async function extractTextFromImageLocal(imagePath, includeWordPositions = false) {
  console.log(`Starting local OCR on image: ${imagePath}`);

  let fileStream;
  try {
    fileStream = fsStream.createReadStream(imagePath);

    // Create form data for file upload
    const formData = new FormData();
    formData.append('file', fileStream, path.basename(imagePath));

    // Call local OCR service
    const url = `${OCR_SERVICE_URL}${OCR_UPLOAD_ENDPOINT}`;
    console.log(`Calling OCR service at: ${url}`);

    const response = await axios.post(url, formData, {
      headers: formData.getHeaders(),
      timeout: 3600000, // 1 hour timeout
      proxy: false, // Disable proxy for localhost
      httpsAgent: false, // Disable HTTPS agent for localhost
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: function (status) {
        return status >= 200 && status < 300;
      }
    });

    const data = response.data;
    const preview = Array.isArray(data.results) ? data.results.slice(0, 5) : [];
    console.log(
      'PaddleOCR response preview:',
      JSON.stringify(
        {
          success: data.success,
          count: data.count,
          preview
        },
        null,
        2
      )
    );
    console.log(`OCR completed. Found ${data.count} text blocks`);

    // Convert PaddleOCR response to our format
    const result = {
      text: '',
      confidence: 0,
      source: 'paddleocr'
    };

    if (data.results && data.results.length > 0) {
      // Combine all text blocks
      result.text = data.results.map(item => item.text).join(' ').trim();

      // Calculate average confidence
      const totalConfidence = data.results.reduce((sum, item) => sum + item.confidence, 0);
      result.confidence = (totalConfidence / data.results.length) * 100;

      console.log(`OCR completed. Confidence: ${Math.round(result.confidence)}%, Text length: ${result.text.length}`);

      // Include word positions if requested
      if (includeWordPositions) {
        result.words = data.results.map(item => ({
          text: item.text,
          confidence: item.confidence * 100, // Convert to percentage
          bbox: {
            x0: item.bbox.x1,
            y0: item.bbox.y1,
            x1: item.bbox.x2,
            y1: item.bbox.y2
          }
        }));
        console.log(`Extracted ${result.words.length} words`);
      }
    } else {
      console.warn('No text detected by OCR service');
    }

    return result;
  } catch (err) {
    if (fileStream) {
      fileStream.destroy();
    }
    if (err.response) {
      console.error('Local OCR error: service responded with status', err.response.status);
    } else if (err.request) {
      console.error('Local OCR error: no response received, reason:', err.code || err.message);
    } else {
      console.error('Local OCR error:', err.message);
    }
    throw err;
  }
}

/**
 * Extract text from image file using Tesseract.js (fallback)
 * @param {string} imagePath - Path to image file
 * @param {string} lang - OCR language (default: 'eng')
 * @param {boolean} includeWordPositions - Whether to include word positions
 * @returns {Promise<Object>} Extracted text and metadata
 */
async function extractTextFromImageTesseract(imagePath, lang = 'eng', includeWordPositions = false) {
  console.log(`Starting Tesseract OCR on image: ${imagePath}`);

  try {
    const imageBuffer = await fs.readFile(imagePath);
    const worker = await getWorker();

    // Use worker.recognize with blocks enabled in v6
    const ocrResult = await worker.recognize(
      imageBuffer,
      {}, // Empty options (logger causes DataCloneError in Node.js worker)
      { blocks: true } // Enable blocks output in v6
    );

    const text = ocrResult.data.text.trim();
    const confidence = ocrResult.data.confidence;

    console.log(`OCR completed. Confidence: ${Math.round(confidence)}%, Text length: ${text.length}`);

    const result = {
      text,
      confidence,
      source: 'tesseract'
    };

    // Include word positions if requested
    if (includeWordPositions) {
      // Extract words from blocks structure
      const words = [];

      if (ocrResult.data.blocks && ocrResult.data.blocks.length > 0) {
        console.log(`Found ${ocrResult.data.blocks.length} blocks`);

        for (const block of ocrResult.data.blocks) {
          if (block.paragraphs) {
            for (const paragraph of block.paragraphs) {
              if (paragraph.lines) {
                for (const line of paragraph.lines) {
                  if (line.words) {
                    for (const word of line.words) {
                      if (word.text && word.text.trim().length > 0) {
                        words.push({
                          text: word.text,
                          confidence: word.confidence || 0,
                          bbox: word.bbox  // {x0, y0, x1, y1}
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      console.log(`Extracted ${words.length} words from blocks structure`);
      result.words = words;
    }

    return result;
  } catch (err) {
    console.error('Tesseract OCR error:', err);
    throw err;
  }
}

/**
 * Extract text from image file
 * @param {string} imagePath - Path to image file
 * @param {string} lang - OCR language (default: 'eng')
 * @param {boolean} includeWordPositions - Whether to include word positions
 * @returns {Promise<Object>} Extracted text and metadata
 */
async function extractTextFromImage(imagePath, lang = 'eng', includeWordPositions = false) {
  if (USE_LOCAL_OCR) {
    console.log('Using local PaddleOCR service');
    try {
      return await extractTextFromImageLocal(imagePath, includeWordPositions);
    } catch (err) {
      console.error('Local OCR service failed:', err.message);

      if (!OCR_ENABLE_FALLBACK) {
        throw err;
      }

      console.warn('Falling back to Tesseract.js OCR');
      try {
        const fallbackResult = await extractTextFromImageTesseract(imagePath, lang, includeWordPositions);
        return fallbackResult;
      } catch (fallbackErr) {
        fallbackErr.message = `Local OCR failed (${err.message}). Tesseract fallback also failed: ${fallbackErr.message}`;
        throw fallbackErr;
      }
    }
  }

  console.log('Using Tesseract.js');
  return extractTextFromImageTesseract(imagePath, lang, includeWordPositions);
}

module.exports = {
  extractTextFromScannedPDF,
  extractPageRange,
  isScannedPDF,
  extractTextFromImage,
};
