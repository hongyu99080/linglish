const { pool, dbUnavailable } = require('../core');

async function getTranslationCache(word) {
  if (dbUnavailable()) return null;
  if (!word) return null;
  const res = await pool.query('SELECT translation, source, updated_at FROM translation_cache WHERE word = $1', [word.toLowerCase()]);
  return res.rows && res.rows[0] ? res.rows[0] : null;
}

async function upsertTranslationCache(word, translation, source = 'unknown') {
  if (dbUnavailable()) return null;
  if (!word || !translation) return null;
  await pool.query(
    `INSERT INTO translation_cache(word, translation, source, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (word) DO UPDATE SET translation = EXCLUDED.translation, source = EXCLUDED.source, updated_at = NOW()`,
    [word.toLowerCase(), translation, source]
  );
  return true;
}

module.exports = { getTranslationCache, upsertTranslationCache };

