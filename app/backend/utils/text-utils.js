/**
 * Text processing utilities
 */

/**
 * Normalize word to lowercase trimmed format
 */
function normalizeLemma(word) {
  return (word || '').trim().toLowerCase();
}

/**
 * Check if sentence contains a complete word (using word boundaries)
 * Avoids substring matches, e.g., searching "neighbor" won't match "neighborhood"
 */
function containsWord(sentence, word) {
  if (!sentence || !word) return false;
  const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return regex.test(sentence);
}

/**
 * Decode HTML entities in text
 * Handles both named entities (&amp;, &lt;, etc.) and numeric entities (&#39;, &#x27;)
 * Also handles double-encoded entities (e.g., &amp;#39; -> ')
 * @param {string} text - Text with HTML entities
 * @returns {string} Decoded text
 */
function decodeHtmlEntities(text) {
  if (!text || typeof text !== 'string') return text;

  // Common HTML entities map
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&#x27;': "'",
    '&nbsp;': ' ',
    '&ndash;': '–',
    '&mdash;': '—',
    '&hellip;': '…',
  };

  let decoded = text;

  // Decode multiple times to handle double-encoding (e.g., &amp;#39; -> &#39; -> ')
  // Limit to 3 iterations to prevent infinite loops on malformed input
  for (let i = 0; i < 3; i++) {
    const before = decoded;

    // Replace named entities
    for (const [entity, char] of Object.entries(entities)) {
      decoded = decoded.replace(new RegExp(entity, 'g'), char);
    }

    // Replace numeric entities (decimal): &#NNN;
    decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
      return String.fromCharCode(parseInt(dec, 10));
    });

    // Replace numeric entities (hexadecimal): &#xHHH;
    decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });

    // If no changes were made, we're done
    if (decoded === before) break;
  }

  return decoded;
}

/**
 * Extract words from text (deduplicated and normalized)
 * @param {string} text - Input text
 * @returns {string[]} List of unique extracted words
 */
function extractWordsFromText(text) {
  if (!text || typeof text !== 'string') return [];

  const words = text
    .toLowerCase()
    .replace(/['']/g, "'") // Normalize quotes
    .split(/[\s\-—–]+/) // Split by whitespace and hyphens
    .map(word => {
      // Remove all non-letter, non-hyphen, non-apostrophe characters
      const cleaned = word.replace(/[^a-z'-]/gi, '');
      // Remove leading/trailing hyphens and apostrophes
      return cleaned.replace(/^['\-]+|['\-]+$/g, '');
    })
    .filter(word => {
      // Filter criteria:
      // 1. At least 2 characters
      // 2. Contains at least one letter
      // 3. Not pure digits
      // 4. No consecutive apostrophes
      return word.length >= 2 &&
             /[a-z]/i.test(word) &&
             !/^\d+$/.test(word) &&
             !/[']{2,}/.test(word);
    });

  // Deduplicate and return
  return [...new Set(words)];
}

module.exports = {
  normalizeLemma,
  containsWord,
  extractWordsFromText,
  decodeHtmlEntities,
};
