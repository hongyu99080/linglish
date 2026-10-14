const CACHE = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

/**
 * Get translation from cache
 * @param {string} word - Normalized word to look up
 * @returns {object|null} - Cached translation object or null if not found/expired
 */
function getFromCache(word) {
  const cached = CACHE.get(word);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  // Remove expired cache entry
  if (cached) {
    CACHE.delete(word);
  }

  return null;
}

/**
 * Store translation in cache
 * @param {string} word - Normalized word
 * @param {string} translation - Translation text
 * @param {string} source - Source of translation (e.g., 'dictionary', 'libretranslate', 'mymemory')
 */
function setInCache(word, translation, source = 'unknown') {
  CACHE.set(word, {
    translation,
    expiresAt: Date.now() + CACHE_TTL_MS,
    source,
  });
}

/**
 * Delete a word from cache
 * @param {string} word - Normalized word to remove
 */
function deleteFromCache(word) {
  CACHE.delete(word);
}

/**
 * Clear all cache entries
 */
function clearCache() {
  CACHE.clear();
}

/**
 * Get cache statistics
 * @returns {object} - Cache statistics
 */
function getCacheStats() {
  return {
    size: CACHE.size,
    ttlMs: CACHE_TTL_MS,
  };
}

module.exports = {
  getFromCache,
  setInCache,
  deleteFromCache,
  clearCache,
  getCacheStats,
};
