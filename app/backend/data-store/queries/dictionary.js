const { pool, dbUnavailable } = require('../core');

const QUALITY_WORD_COLUMNS = `id, word, word_lowercase, phonetic, definitions,
  part_of_speech, example_sentences, synonyms, content_revision,
  phonetic_source, definitions_source, zh_source, part_of_speech_source,
  quality_status, quality_score, quality_reasons, quality_meta,
  quality_checked_revision, quality_checked_at, seo_indexable,
  word IS NULL AS word_is_sql_null,
  word_lowercase IS NULL AS word_lowercase_is_sql_null,
  phonetic IS NULL AS phonetic_is_sql_null,
  definitions IS NULL AS definitions_is_sql_null,
  part_of_speech IS NULL AS part_of_speech_is_sql_null,
  example_sentences IS NULL AS example_sentences_is_sql_null,
  synonyms IS NULL AS synonyms_is_sql_null`;

const LEGACY_WRITE_WORD_COLUMNS = `id, word, word_lowercase, part_of_speech, frequency_rank,
  difficulty_level, definitions, phonetic, audio_url, example_sentences, synonyms, antonyms,
  related_words, lookup_count, learned_by_count, is_blacklisted, blacklisted_at, blacklist_reason,
  created_at, updated_at, content_revision, phonetic_source, definitions_source, zh_source,
  part_of_speech_source, quality_status, quality_score, quality_reasons, quality_meta,
  quality_checked_revision, quality_checked_at, seo_indexable`;

function jsonbParameter(value, isSqlNull) {
  return isSqlNull ? null : JSON.stringify(value);
}

async function getDictionaryCache(word) {
  if (dbUnavailable()) return null;
  if (!word) return null;
  const res = await pool.query('SELECT entry, updated_at FROM dictionary_cache WHERE word = $1', [word.toLowerCase()]);
  return res.rows && res.rows[0] ? res.rows[0] : null;
}

async function upsertDictionaryCache(word, entry) {
  if (dbUnavailable()) return null;
  if (!word || !entry) return null;
  await pool.query(
    `INSERT INTO dictionary_cache(word, entry, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (word) DO UPDATE SET entry = EXCLUDED.entry, updated_at = NOW()`,
    [word.toLowerCase(), entry]
  );
  return true;
}

async function listQualityRecords({ scope = null, limit = 500 } = {}, executor = pool) {
  const safeLimit = Math.max(1, Math.min(5000, Number.parseInt(limit, 10) || 500));
  if (Array.isArray(scope) && scope.length) {
    const result = await executor.query(
      `SELECT ${QUALITY_WORD_COLUMNS} FROM words
       WHERE word_lowercase = ANY($1::text[])
       ORDER BY word_lowercase ASC
       LIMIT $2`,
      [scope, safeLimit]
    );
    return result.rows || [];
  }
  const result = await executor.query(
    `SELECT ${QUALITY_WORD_COLUMNS} FROM words ORDER BY word_lowercase ASC LIMIT $1`,
    [safeLimit]
  );
  return result.rows || [];
}

async function withDictionaryTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(createDictionaryQualityRepository(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    throw error;
  } finally {
    client.release();
  }
}

async function createQualityBatch(batch, executor = pool) {
  const result = await executor.query(
    `INSERT INTO dictionary_quality_batches
      (id, operation, status, scope, actor_type, actor_id, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING id, operation, status, scope, actor_type, actor_id, created_at, rolled_back_at`,
    [batch.id, batch.operation, batch.status, JSON.stringify(batch.scope), batch.actor_type, batch.actor_id, batch.created_at]
  );
  return result.rows[0];
}

async function getWordForQualityUpdate(word, executor = pool) {
  const result = await executor.query(
    `SELECT ${QUALITY_WORD_COLUMNS} FROM words WHERE word_lowercase = $1 FOR UPDATE`,
    [word]
  );
  return result.rows[0] || null;
}

async function getWordsForQualityUpdate(words, executor = pool) {
  const result = await executor.query(
    `SELECT ${QUALITY_WORD_COLUMNS} FROM words
     WHERE word_lowercase = ANY($1::text[])
     ORDER BY word_lowercase ASC
     FOR UPDATE`,
    [words]
  );
  return result.rows || [];
}

async function getLegacyWriteRecord({ id = null, word = '', forUpdate = false } = {}, executor = pool) {
  const suffix = forUpdate ? ' FOR UPDATE' : '';
  const result = id != null
    ? await executor.query(`SELECT ${LEGACY_WRITE_WORD_COLUMNS} FROM words WHERE id = $1${suffix}`, [id])
    : await executor.query(`SELECT ${LEGACY_WRITE_WORD_COLUMNS} FROM words WHERE word_lowercase = $1${suffix}`, [String(word).toLowerCase()]);
  return result.rows[0] || null;
}

async function updateLegacyWord({ id, word, expectedRevision, changes = {} }, executor = pool) {
  const result = await executor.query(
    `UPDATE words
     SET word = COALESCE($1, word),
         word_lowercase = COALESCE($2, word_lowercase),
         phonetic = CASE WHEN $3::boolean THEN $4 ELSE phonetic END,
         definitions = CASE WHEN $5::boolean THEN $6::jsonb ELSE definitions END,
         part_of_speech = CASE WHEN $7::boolean THEN $8 ELSE part_of_speech END,
         updated_at = NOW()
     WHERE ($9::bigint IS NOT NULL AND id = $9 OR $9::bigint IS NULL AND word_lowercase = $10)
       AND content_revision = $11
     RETURNING ${QUALITY_WORD_COLUMNS}`,
    [
      changes.word || null,
      changes.word_lowercase || null,
      Object.hasOwn(changes, 'phonetic'), changes.phonetic ?? null,
      Object.hasOwn(changes, 'definitions'), Object.hasOwn(changes, 'definitions') ? JSON.stringify(changes.definitions) : null,
      Object.hasOwn(changes, 'part_of_speech'), changes.part_of_speech ?? null,
      id == null ? null : id,
      word,
      expectedRevision,
    ]
  );
  return result.rows[0] || null;
}

async function bumpLegacyReviewRevision({ id, word, expectedRevision }, executor = pool) {
  const result = await executor.query(
    `UPDATE words
     SET content_revision = content_revision + 1,
         quality_status = 'review',
         quality_score = NULL,
         quality_reasons = '["review_confirmation_pending"]'::jsonb,
         quality_meta = jsonb_build_object('previous_revision', content_revision),
         quality_checked_revision = NULL,
         quality_checked_at = NULL,
         seo_indexable = FALSE,
         updated_at = NOW()
     WHERE ($1::bigint IS NOT NULL AND id = $1 OR $1::bigint IS NULL AND word_lowercase = $2)
       AND content_revision = $3
     RETURNING ${QUALITY_WORD_COLUMNS}`,
    [id == null ? null : id, word, expectedRevision]
  );
  return result.rows[0] || null;
}

async function insertLegacyWord({ changes = {} }, executor = pool) {
  const result = await executor.query(
    `INSERT INTO words (word, word_lowercase, phonetic, definitions, part_of_speech, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     ON CONFLICT (word_lowercase) DO NOTHING
     RETURNING ${QUALITY_WORD_COLUMNS}`,
    [
      changes.word,
      changes.word_lowercase,
      changes.phonetic ?? null,
      JSON.stringify(changes.definitions || []),
      changes.part_of_speech ?? null,
    ]
  );
  return result.rows[0] || null;
}

async function syncLegacyWordReferences({ id, word }, executor = pool) {
  const result = await executor.query(
    'UPDATE user_vocabulary SET word = $2, updated_at = NOW() WHERE word_id = $1',
    [id, word]
  );
  return result.rowCount || 0;
}

async function applyLegacyStateAction({ action, id = null, word = '' }, executor = pool) {
  const current = await getLegacyWriteRecord({ id, word, forUpdate: true }, executor);
  if (!current) return { affected: 0, deleted: 0, blacklisted: 0, unblacklisted: 0, user_vocabulary_deleted: 0, after: null };
  if (action === 'unblacklist') {
    const result = await executor.query(
      `UPDATE words
       SET word = word, is_blacklisted = FALSE, blacklisted_at = NULL, blacklist_reason = NULL, updated_at = NOW()
       WHERE id = $1 AND is_blacklisted = TRUE RETURNING ${LEGACY_WRITE_WORD_COLUMNS}`,
      [current.id]
    );
    return { affected: result.rowCount, unblacklisted: result.rowCount, after: result.rows[0] || current };
  }
  const userRows = await executor.query('DELETE FROM user_vocabulary WHERE word_id = $1 RETURNING *', [current.id]);
  if (action === 'blacklist') {
    const result = await executor.query(
      `UPDATE words
       SET word = word, is_blacklisted = TRUE, blacklisted_at = NOW(), blacklist_reason = '运营清理', updated_at = NOW()
       WHERE id = $1 RETURNING ${LEGACY_WRITE_WORD_COLUMNS}`,
      [current.id]
    );
    return {
      affected: result.rowCount,
      blacklisted: result.rowCount,
      user_vocabulary_deleted: userRows.rowCount || 0,
      deleted_user_vocabulary_records: userRows.rows || [],
      after: result.rows[0] || { ...current, is_blacklisted: true },
    };
  }
  if (action !== 'delete') throw new Error(`INVALID_WRITE_ACTION:${action}`);
  const result = await executor.query(
    `UPDATE words
     SET word = word, is_blacklisted = TRUE, blacklisted_at = NOW(), blacklist_reason = '管理员删除', updated_at = NOW()
     WHERE id = $1 RETURNING ${LEGACY_WRITE_WORD_COLUMNS}`,
    [current.id]
  );
  return {
    affected: result.rowCount,
    deleted: result.rowCount,
    user_vocabulary_deleted: userRows.rowCount || 0,
    deleted_user_vocabulary_records: userRows.rows || [],
    after: result.rows[0] || current,
  };
}

async function invalidateWordCaches({ word = '' } = {}, executor = pool) {
  const normalized = String(word || '').trim().toLowerCase();
  if (!normalized) return;
  const failures = [];
  for (const [sql, params] of [
    ['DELETE FROM dictionary_cache WHERE word = $1', [normalized]],
    ['DELETE FROM translation_cache WHERE word = $1', [normalized]],
  ]) {
    try {
      await executor.query(sql, params);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const error = new Error(`CACHE_INVALIDATION_FAILED:${normalized}`);
    error.cause = failures[0];
    throw error;
  }
}

async function updateCuratedWord({ word, expectedRevision, changes }, executor = pool) {
  const result = await executor.query(
    `UPDATE words
     SET word = $1,
         word_lowercase = $2,
         phonetic = $3,
         definitions = $4::jsonb,
         part_of_speech = $5,
         example_sentences = $6::jsonb,
         synonyms = $7::text[],
         updated_at = NOW()
     WHERE word_lowercase = $2 AND content_revision = $8
     RETURNING ${QUALITY_WORD_COLUMNS}`,
    [
      changes.word,
      word,
      changes.phonetic,
      jsonbParameter(changes.definitions, changes.sql_nulls?.definitions),
      changes.part_of_speech,
      jsonbParameter(changes.example_sentences, changes.sql_nulls?.example_sentences),
      changes.sql_nulls?.synonyms ? null : changes.synonyms,
      expectedRevision,
    ]
  );
  return result.rows[0] || null;
}

async function saveQualityDecision({ word, expectedRevision, decision }, executor = pool) {
  const result = await executor.query(
    `UPDATE words
     SET phonetic_source = $1,
         definitions_source = $2,
         zh_source = $3,
         part_of_speech_source = $4,
         quality_status = $5,
         quality_score = $6,
         quality_reasons = $7::jsonb,
         quality_meta = $8::jsonb,
         quality_checked_revision = $9,
         quality_checked_at = $10,
         seo_indexable = $11
     WHERE word_lowercase = $12 AND content_revision = $13
     RETURNING ${QUALITY_WORD_COLUMNS}`,
    [
      decision.phonetic_source,
      decision.definitions_source,
      decision.zh_source,
      decision.part_of_speech_source,
      decision.quality_status,
      decision.quality_score,
      JSON.stringify(decision.quality_reasons || []),
      JSON.stringify(decision.quality_meta || {}),
      decision.quality_checked_revision,
      decision.quality_checked_at,
      decision.seo_indexable,
      word,
      expectedRevision,
    ]
  );
  return result.rows[0] || null;
}

async function appendQualityRevision(revision, executor = pool) {
  const result = await executor.query(
    `INSERT INTO dictionary_quality_revisions
      (batch_id, word_id, word_lowercase, from_revision, to_revision,
       before_record, after_record, action, actor_type, actor_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
     RETURNING *`,
    [
      revision.batch_id,
      revision.word_id,
      revision.word_lowercase,
      revision.from_revision,
      revision.to_revision,
      JSON.stringify(revision.before_record),
      JSON.stringify(revision.after_record),
      revision.action,
      revision.actor_type,
      revision.actor_id,
      revision.created_at,
    ]
  );
  return result.rows[0];
}

async function listBatchRevisions(batchId, executor = pool) {
  const result = await executor.query(
    `SELECT id, batch_id, word_id, word_lowercase, from_revision, to_revision,
            before_record, after_record, action, actor_type, actor_id, created_at, rolled_back_at
     FROM dictionary_quality_revisions
     WHERE batch_id = $1 AND rolled_back_at IS NULL
     ORDER BY word_lowercase ASC, id ASC`,
    [batchId]
  );
  return result.rows || [];
}

async function restoreQualityRevision({ word, expectedRevision, before }, executor = pool) {
  const content = await executor.query(
    `UPDATE words
     SET word = $1,
         word_lowercase = $2,
         phonetic = $3,
         definitions = $4::jsonb,
         part_of_speech = $5,
         example_sentences = $6::jsonb,
         synonyms = $7::text[],
         updated_at = NOW()
     WHERE word_lowercase = $8 AND content_revision = $9
     RETURNING id, content_revision`,
    [
      before.word,
      before.word_lowercase,
      before.sql_nulls?.phonetic ? null : before.phonetic,
      jsonbParameter(before.definitions, before.sql_nulls?.definitions),
      before.sql_nulls?.part_of_speech ? null : before.part_of_speech,
      jsonbParameter(before.example_sentences, before.sql_nulls?.example_sentences),
      before.sql_nulls?.synonyms ? null : before.synonyms,
      word,
      expectedRevision,
    ]
  );
  const restored = content.rows[0];
  if (!restored) return null;
  if (Object.hasOwn(before || {}, 'is_blacklisted')) {
    await executor.query(
      `UPDATE words
       SET is_blacklisted = $2, blacklisted_at = $3, blacklist_reason = $4
       WHERE id = $1`,
      [restored.id, before.is_blacklisted === true, before.blacklisted_at || null, before.blacklist_reason || null]
    );
  }
  const review = await executor.query(
    `UPDATE words
     SET phonetic_source = NULL,
         definitions_source = NULL,
         zh_source = NULL,
         part_of_speech_source = NULL,
         quality_status = 'review',
         quality_score = NULL,
         quality_reasons = '["batch_rolled_back"]'::jsonb,
         quality_meta = '{}'::jsonb,
         quality_checked_revision = NULL,
         quality_checked_at = NULL,
         seo_indexable = FALSE
     WHERE id = $1 AND content_revision = $2
     RETURNING ${QUALITY_WORD_COLUMNS}`,
    [restored.id, restored.content_revision]
  );
  return review.rows[0] || null;
}

async function restoreLegacyRevision({ word, expectedRevision, before, action }, executor = pool) {
  if (action === 'insert') {
    const removed = await executor.query(
      `UPDATE words
       SET word = word,
           is_blacklisted = TRUE,
           blacklisted_at = NOW(),
           blacklist_reason = 'batch_rolled_back',
           updated_at = NOW()
       WHERE word_lowercase = $1 AND content_revision = $2
       RETURNING ${QUALITY_WORD_COLUMNS}`,
      [word, expectedRevision]
    );
    return removed.rows[0] ? { ...removed.rows[0], removed: true } : null;
  }

  const restored = await restoreQualityRevision({ word, expectedRevision, before }, executor);
  if (!restored) return null;
  const userVocabulary = Array.isArray(before?.user_vocabulary_records) ? before.user_vocabulary_records : [];
  if (userVocabulary.length) {
    await executor.query(
      `INSERT INTO user_vocabulary
       SELECT * FROM jsonb_populate_recordset(NULL::user_vocabulary, $1::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(userVocabulary)]
    );
    await executor.query(`DO $sequence_repair$
      DECLARE
        sequence_name TEXT := pg_get_serial_sequence('user_vocabulary', 'id');
        target_value BIGINT;
        current_value BIGINT;
      BEGIN
        IF sequence_name IS NULL THEN RETURN; END IF;
        SELECT COALESCE(MAX(id), 0) INTO target_value FROM user_vocabulary;
        LOOP
          EXECUTE format('SELECT nextval(%L::regclass)', sequence_name) INTO current_value;
          EXIT WHEN current_value >= target_value;
        END LOOP;
      END
    $sequence_repair$`);
  }
  return restored;
}

async function markRevisionRolledBack(id, rolledBackAt = new Date(), executor = pool) {
  const result = await executor.query(
    'UPDATE dictionary_quality_revisions SET rolled_back_at = $2 WHERE id = $1 AND rolled_back_at IS NULL',
    [id, rolledBackAt]
  );
  return result.rowCount === 1;
}

async function markBatchRolledBack(id, metadata = {}, executor = pool) {
  const result = await executor.query(
    `UPDATE dictionary_quality_batches
     SET status = 'rolled_back', rolled_back_at = $2
     WHERE id = $1 AND status = 'applied'`,
    [id, metadata.rolled_back_at || new Date()]
  );
  return result.rowCount === 1;
}

function createDictionaryQualityRepository(executor = pool) {
  return {
    listQualityRecords: (options) => listQualityRecords(options, executor),
    withTransaction: executor === pool ? withDictionaryTransaction : async (work) => work(createDictionaryQualityRepository(executor)),
    createQualityBatch: (batch) => createQualityBatch(batch, executor),
    getWordForQualityUpdate: (word) => getWordForQualityUpdate(word, executor),
    getWordsForQualityUpdate: (words) => getWordsForQualityUpdate(words, executor),
    getLegacyWriteRecord: (options) => getLegacyWriteRecord(options, executor),
    updateLegacyWord: (options) => updateLegacyWord(options, executor),
    bumpLegacyReviewRevision: (options) => bumpLegacyReviewRevision(options, executor),
    insertLegacyWord: (options) => insertLegacyWord(options, executor),
    syncLegacyWordReferences: (options) => syncLegacyWordReferences(options, executor),
    applyLegacyStateAction: (options) => applyLegacyStateAction(options, executor),
    invalidateWordCaches: (options) => invalidateWordCaches(options, executor),
    updateCuratedWord: (options) => updateCuratedWord(options, executor),
    saveQualityDecision: (options) => saveQualityDecision(options, executor),
    appendQualityRevision: (revision) => appendQualityRevision(revision, executor),
    listBatchRevisions: (batchId) => listBatchRevisions(batchId, executor),
    restoreQualityRevision: (options) => restoreQualityRevision(options, executor),
    restoreLegacyRevision: (options) => restoreLegacyRevision(options, executor),
    markRevisionRolledBack: (id, rolledBackAt) => markRevisionRolledBack(id, rolledBackAt, executor),
    markBatchRolledBack: (id, metadata) => markBatchRolledBack(id, metadata, executor),
  };
}

module.exports = {
  appendQualityRevision,
  createDictionaryQualityRepository,
  createQualityBatch,
  getDictionaryCache,
  getLegacyWriteRecord,
  getWordsForQualityUpdate,
  getWordForQualityUpdate,
  listBatchRevisions,
  listQualityRecords,
  insertLegacyWord,
  invalidateWordCaches,
  markBatchRolledBack,
  markRevisionRolledBack,
  restoreQualityRevision,
  restoreLegacyRevision,
  saveQualityDecision,
  updateCuratedWord,
  updateLegacyWord,
  bumpLegacyReviewRevision,
  syncLegacyWordReferences,
  applyLegacyStateAction,
  upsertDictionaryCache,
  withDictionaryTransaction,
};
