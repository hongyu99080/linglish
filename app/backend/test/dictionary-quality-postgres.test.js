const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { Pool } = require('pg');

const fixtures = require('./fixtures/dictionary-quality-cases.json');
const { createDictionaryQualityRepository } = require('../data-store/queries/dictionary');
const { createCurationService } = require('../services/dictionary/curation');
const {
  SEO_INDEXABLE_SQL,
  normalizeDefinitions,
  normalizePhonetic,
} = require('../services/dictionary/quality');

const definitionTranslationEquivalenceCases = [
  ['en scalar without translation', { en: 'A scalar definition.' }, false],
  ['en scalar with scalar zh fallback', { en: 'A scalar definition.', zh: '标量释义。' }, true],
  ['en scalar with array zh fallback', { en: 'A scalar definition.', zh: ['数组释义。'] }, true],
  ['en object with zh', { en: { definition: 'An object definition.', zh: '对象释义。' } }, true],
  ['en object with cn', { en: { meaning: 'An object meaning.', cn: '对象释义。' } }, true],
  ['en object with translation', { en: { text: 'An object text.', translation: '对象释义。' } }, true],
  ['en object with exampleZh', { en: { en: 'An object en.', exampleZh: '对象例句。' } }, true],
  ['en object with example_zh', { en: { definition: 'An object definition.', example_zh: '对象例句。' } }, true],
  ['en object with examplesZh first item', { en: { definition: 'An object definition.', examplesZh: ['对象例句。'] } }, true],
  ['false en-item zh falls through to cn', { en: { definition: 'Alias fallback.', zh: false, cn: '回退释义。' } }, true],
  ['en array with nested object translation', { en: ['A scalar definition.', { definition: 'An array object.', zh: '数组对象释义。' }] }, true],
  ['en array with positional zh fallback', { en: ['First definition.', 'Second definition.'], zh: ['', '第二条释义。'] }, true],
  ['en array reuses first zh fallback', { en: ['First definition.', 'Second definition.'], zh: ['共用释义。'] }, true],
  ['serialized en array with nested example translation', JSON.stringify({ en: [{ definition: 'Serialized object.', exampleZh: '序列化例句。' }] }), true],
  ['truthy blank zh blocks cn alias', { en: { definition: 'Alias precedence.', zh: ' ', cn: '不得渲染。' } }, false],
  ['truthy non-string zh blocks translation alias', { en: { definition: 'Alias precedence.', zh: [], translation: '不得渲染。' } }, false],
  ['truthy blank exampleZh blocks example_zh alias', { en: { definition: 'Example precedence.', exampleZh: ' ', example_zh: '不得渲染。' } }, false],
  ['examplesZh only renders its first item', { en: { definition: 'First example only.', examplesZh: ['', '不得渲染。'] } }, false],
  ['top-level en only uses zh as its translation fallback', { en: 'Rendered definition.', cn: '不得渲染。', translation: '不得渲染。', exampleZh: '不得渲染。' }, false],
  ['truthy blank top-level zh fallback blocks rendering', { en: 'Rendered definition.', zh: ' ' }, false],
  ['zh paired with rejected en item is not rendered', { en: ['', 'Rendered definition.'], zh: ['不得渲染。', ''] }, false],
  ['en item discarded by meanings-array branch is not rendered', [
    { en: { definition: 'Discarded definition.', zh: '不得渲染。' } },
    { partOfSpeech: 'noun', definitions: [{ definition: 'Rendered definition.' }] },
  ], false],
];

function normalizedDefinitionsRenderTranslation(value) {
  return normalizeDefinitions(value).some((meaning) => (meaning.definitions || []).some((definition) => (
    Boolean(String(definition.zh || '').trim()) || Boolean(String(definition.exampleZh || '').trim())
  )));
}

const MIGRATION_PATH = path.resolve(__dirname, '../../../docs/db/migrations/V33__dictionary_quality_gate.sql');
const BASE_WORDS_SQL = `
  CREATE TABLE words (
    id BIGSERIAL PRIMARY KEY,
    word VARCHAR(100) UNIQUE NOT NULL,
    word_lowercase VARCHAR(100) NOT NULL,
    part_of_speech VARCHAR(20),
    frequency_rank INTEGER,
    difficulty_level VARCHAR(20),
    definitions JSONB,
    phonetic VARCHAR(100),
    audio_url VARCHAR(500),
    example_sentences JSONB,
    synonyms TEXT[],
    antonyms TEXT[],
    related_words TEXT[],
    lookup_count INTEGER DEFAULT 0,
    learned_by_count INTEGER DEFAULT 0,
    private_blob TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX idx_words_lower ON words(word_lowercase);
  CREATE TABLE dictionary_cache (
    word TEXT PRIMARY KEY,
    entry JSONB NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE translation_cache (
    word TEXT PRIMARY KEY,
    translation TEXT NOT NULL,
    source TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

let dockerAvailable = false;
let containerName = '';
let port = 0;
let adminPool;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function psql(database, sqlOrFile, { file = false, allowFailure = false } = {}) {
  const args = ['exec', containerName, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'];
  args.push(file ? '-f' : '-c', sqlOrFile);
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result;
}

function psqlAsync(database, sqlOrFile, { file = false } = {}) {
  const args = ['exec', containerName, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'];
  args.push(file ? '-f' : '-c', sqlOrFile);
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    done: new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }))),
  };
}

function poolFor(database, max = 8) {
  return new Pool({
    connectionString: `postgres://postgres:test@127.0.0.1:${port}/${database}`,
    max,
    connectionTimeoutMillis: 5_000,
  });
}

async function createDatabase(name) {
  await adminPool.query(`CREATE DATABASE ${name}`);
  const pool = poolFor(name);
  await pool.query(BASE_WORDS_SQL);
  return pool;
}

async function applyMigration(database) {
  const result = psql(database, '/migration.sql', { file: true, allowFailure: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function planNodes(plan) {
  return [plan, ...(plan.Plans || []).flatMap(planNodes)];
}

async function explainJson(pool, sql, params = []) {
  const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  return result.rows[0]['QUERY PLAN'][0].Plan;
}

function transactionalRepository(pool, { bulkLockBarrier = null } = {}) {
  const base = createDictionaryQualityRepository(pool);
  return {
    ...base,
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = createDictionaryQualityRepository(client);
        if (bulkLockBarrier) {
          const original = tx.getWordsForQualityUpdate;
          tx.getWordsForQualityUpdate = async (words) => {
            await bulkLockBarrier(words);
            return original(words);
          };
        }
        const result = await work(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function seedCuratedScope(pool, words = ['meeting', 'the', 'and', 'have']) {
  const values = words.map((word, index) => ({
    word,
    phonetic: word === 'meeting' ? 'mɛtɪŋ' : `wɜːd${index}`,
    definitions: [{ partOfSpeech: 'noun', definitions: [{ definition: `Old ${word} definition.` }] }],
    examples: [{ text: `Old ${word} public example.` }],
    synonyms: [`old-${word}`],
  }));
  for (const value of values) {
    await pool.query(
      `INSERT INTO words
        (word, word_lowercase, phonetic, definitions, part_of_speech, example_sentences, synonyms, private_blob)
       VALUES ($1, $1, $2, $3::jsonb, 'noun', $4::jsonb, $5::text[], $6)`,
      [value.word, value.phonetic, JSON.stringify(value.definitions), JSON.stringify(value.examples), value.synonyms, 'x'.repeat(10_000)],
    );
  }
  return values;
}

test.before(async () => {
  const info = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (info.status !== 0) return;
  dockerAvailable = true;
  containerName = `linglish-task4-fix-pg-${process.pid}-${Date.now()}`;
  docker(
    'run', '--detach', '--rm', '--name', containerName,
    '-e', 'POSTGRES_PASSWORD=test',
    '-p', '127.0.0.1::5432',
    '-v', `${MIGRATION_PATH}:/migration.sql:ro`,
    'postgres:16-alpine',
  );
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const probe = spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'temporary PostgreSQL should become ready');
  await new Promise((resolve) => setTimeout(resolve, 750));
  const stableProbe = spawnSync('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
  assert.equal(stableProbe.status, 0, 'temporary PostgreSQL should remain ready after initialization restart');
  const mapping = docker('port', containerName, '5432/tcp').trim();
  port = Number(mapping.match(/:(\d+)$/)?.[1]);
  assert.ok(port > 0, mapping);
  adminPool = poolFor('postgres');
  await adminPool.query('SELECT 1');
});

test.after(async () => {
  await adminPool?.end().catch(() => {});
  if (containerName) spawnSync('docker', ['rm', '-f', containerName], { encoding: 'utf8' });
});

test('V33 is expand-first, timeout-bounded, resumable, and keeps old/new code live during concurrent indexing', { timeout: 120_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');

  const blocked = await createDatabase('v33_blocked');
  t.after(() => blocked.end().catch(() => {}));
  await blocked.query("INSERT INTO words(word, word_lowercase) VALUES ('legacy', 'legacy')");
  const blocker = await blocked.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT * FROM words');
  const startedAt = Date.now();
  const running = psqlAsync('v33_blocked', '/migration.sql', { file: true });
  const cancelTimer = setTimeout(() => {
    blocked.query("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname='v33_blocked' AND query LIKE 'ALTER TABLE words%' AND pid <> pg_backend_pid()").catch(() => {});
  }, 4_000);
  const blockedResult = await running.done;
  clearTimeout(cancelTimer);
  const elapsed = Date.now() - startedAt;
  const beforeSchema = await blocked.query("SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_name='words' AND column_name='content_revision'");
  await blocker.query('ROLLBACK');
  blocker.release();
  assert.notEqual(blockedResult.status, 0, 'lock timeout must fail this phase for a safe retry');
  assert.ok(elapsed < 3_500, `migration waited ${elapsed}ms instead of honoring lock_timeout`);
  assert.equal(beforeSchema.rows[0].count, 0, 'failed first phase must not partially mutate words');
  await applyMigration('v33_blocked');
  await blocked.end();

  const recovery = await createDatabase('v33_recovery');
  await recovery.query("INSERT INTO words(word,word_lowercase) VALUES ('One','duplicate'),('Two','duplicate')");
  const invalidBuild = psql('v33_recovery', 'CREATE UNIQUE INDEX CONCURRENTLY uq_words_word_lowercase ON words(word_lowercase)', { allowFailure: true });
  assert.notEqual(invalidBuild.status, 0);
  await recovery.query("DELETE FROM words WHERE word='Two'");
  await recovery.query("ALTER TABLE words ADD COLUMN content_revision BIGINT NOT NULL DEFAULT 1");
  await applyMigration('v33_recovery');
  const recovered = await recovery.query("SELECT indisvalid, indisready FROM pg_index WHERE indexrelid='uq_words_word_lowercase'::regclass");
  assert.deepEqual(recovered.rows, [{ indisvalid: true, indisready: true }]);
  await recovery.end();

  const sized = await createDatabase('v33_sized');
  await sized.query(`INSERT INTO words(word, word_lowercase, definitions, phonetic)
    SELECT 'word' || n, 'word' || n, '[{"definition":"Production-sized fixture"}]'::jsonb, 'wɜːd'
    FROM generate_series(1, 60000) AS n`);
  assert.equal((await sized.query("SELECT word, definitions FROM words WHERE word_lowercase='word1'")).rowCount, 1, 'pre-V33 old read');
  let keepRunning = true;
  let reads = 0;
  let writes = 0;
  const reader = (async () => {
    while (keepRunning) {
      await sized.query('SELECT COUNT(*) FROM words WHERE word_lowercase LIKE $1', ['word5%']);
      reads++;
    }
  })();
  const writer = (async () => {
    let n = 0;
    while (keepRunning) {
      n++;
      await sized.query(
        `INSERT INTO words(word, word_lowercase, definitions, phonetic)
         VALUES ($1, $1, '[{"definition":"Legacy writer"}]'::jsonb, 'wɜːd')`,
        [`legacy-live-${n}`],
      );
      writes++;
    }
  })();
  await applyMigration('v33_sized');
  keepRunning = false;
  await Promise.all([reader, writer]);
  assert.ok(reads > 0, reads);
  assert.ok(writes > 0, writes);
  await sized.query("INSERT INTO words(word, word_lowercase) VALUES ('post-v33-old-code', 'post-v33-old-code')");
  const newCode = await sized.query(`SELECT COUNT(*)::int AS count FROM words WHERE ${SEO_INDEXABLE_SQL}`);
  assert.equal(newCode.rows[0].count, 0);
  await applyMigration('v33_sized');
  await sized.end();
});

test('real PostgreSQL apply rollback restores the full surface and later edits reject atomically', { timeout: 60_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('curation_rollback');
  t.after(() => pool.end());
  await applyMigration('curation_rollback');
  const original = await seedCuratedScope(pool, ['and', 'have']);
  const repository = transactionalRepository(pool);
  let uuidCounter = 1;
  const service = createCurationService({
    repository,
    now: () => new Date(`2026-08-22T00:00:0${uuidCounter}.000Z`),
    randomUUID: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, '0')}`,
  });
  const revisions = { and: 1, have: 1 };
  const applied = await service.apply({ scope: ['have', 'and'], expectedRevisions: revisions, actor: { type: 'test', id: 'pg' } });
  const rolledBack = await service.rollback({ batchId: applied.batch_id, actor: { type: 'test', id: 'pg' } });
  assert.equal(rolledBack.rolled_back, 2);
  const rows = (await pool.query(`SELECT word_lowercase, phonetic, definitions, part_of_speech,
      example_sentences, synonyms, content_revision, quality_status, quality_score,
      quality_reasons, quality_checked_revision, quality_checked_at, seo_indexable
    FROM words ORDER BY word_lowercase`)).rows;
  for (const row of rows) {
    const before = original.find((item) => item.word === row.word_lowercase);
    assert.equal(row.phonetic, before.phonetic);
    assert.deepEqual(row.definitions, before.definitions);
    assert.deepEqual(row.example_sentences, before.examples);
    assert.deepEqual(row.synonyms, before.synonyms);
    assert.equal(Number(row.content_revision), 3);
    assert.equal(row.quality_status, 'review');
    assert.equal(row.quality_score, null);
    assert.deepEqual(row.quality_reasons, ['batch_rolled_back']);
    assert.equal(row.quality_checked_revision, null);
    assert.equal(row.quality_checked_at, null);
    assert.equal(row.seo_indexable, false);
  }
  const ledger = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE r.rolled_back_at IS NOT NULL)::int AS revisions_rolled_back,
      COUNT(DISTINCT b.id) FILTER (WHERE b.rolled_back_at IS NOT NULL AND b.status='rolled_back')::int AS batches_rolled_back
    FROM dictionary_quality_revisions r JOIN dictionary_quality_batches b ON b.id=r.batch_id
    WHERE b.id=$1`, [applied.batch_id]);
  assert.deepEqual(ledger.rows[0], { revisions_rolled_back: 2, batches_rolled_back: 1 });

  const second = await service.apply({ scope: ['and', 'have'], expectedRevisions: { and: 3, have: 3 } });
  await pool.query("UPDATE words SET synonyms=ARRAY['later-edit'] WHERE word_lowercase='have'");
  const beforeRejected = await pool.query('SELECT word_lowercase, content_revision, phonetic FROM words ORDER BY word_lowercase');
  await assert.rejects(() => service.rollback({ batchId: second.batch_id }), /ROLLBACK_SUPERSEDED:have/);
  const afterRejected = await pool.query('SELECT word_lowercase, content_revision, phonetic FROM words ORDER BY word_lowercase');
  assert.deepEqual(afterRejected.rows, beforeRejected.rows);
});

test('legacy batch adapter is atomic and destructive/insert revisions roll back on real PostgreSQL', { timeout: 60_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('legacy_adapter_atomic');
  t.after(() => pool.end());
  await pool.query(`ALTER TABLE words
    ADD COLUMN is_blacklisted BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN blacklisted_at TIMESTAMP,
    ADD COLUMN blacklist_reason TEXT`);
  await applyMigration('legacy_adapter_atomic');
  await pool.query(`
    CREATE TABLE user_vocabulary (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      word_id BIGINT NOT NULL REFERENCES words(id),
      word TEXT NOT NULL,
      translation TEXT,
      status TEXT DEFAULT 'learning',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO words (word, word_lowercase, phonetic, definitions)
    VALUES
      ('Alpha', 'alpha', 'ælfə', '[{"definition":"First letter."}]'::jsonb),
      ('Bravo', 'bravo', 'brɑːvəʊ', '[{"definition":"Approval."}]'::jsonb)
  `);
  const repository = transactionalRepository(pool);
  let sequence = 100;
  const service = createCurationService({
    repository,
    randomUUID: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
  });

  await assert.rejects(() => service.applyBatch({
    writes: [
      { word: 'alpha', candidate: { phonetic: 'ˈælfə' }, source: 'manual', reviewed: true },
      { word: 'bravo', candidate: { word: 'aaaa1111' }, source: 'manual', reviewed: true },
    ],
    actor: { type: 'admin', id: '9' },
  }), /LOW_QUALITY_WORD/);
  const atomic = await pool.query(`
    SELECT word_lowercase, phonetic FROM words WHERE word_lowercase IN ('alpha','bravo') ORDER BY word_lowercase
  `);
  assert.deepEqual(atomic.rows, [
    { word_lowercase: 'alpha', phonetic: 'ælfə' },
    { word_lowercase: 'bravo', phonetic: 'brɑːvəʊ' },
  ]);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM dictionary_quality_batches')).rows[0].count, 0);

  const alpha = (await pool.query("SELECT id FROM words WHERE word_lowercase='alpha'")).rows[0];
  await pool.query(
    `INSERT INTO user_vocabulary (id, user_id, word_id, word, translation)
     VALUES (88, 7, $1, 'Alpha', '阿尔法')`,
    [alpha.id]
  );
  const blacklisted = await service.apply({
    write: { id: alpha.id, action: 'blacklist', source: 'manual', reviewed: true },
    actor: { type: 'admin', id: '9' },
  });
  assert.ok(blacklisted.batch_id);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM user_vocabulary WHERE word_id=$1', [alpha.id])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT action FROM dictionary_quality_revisions WHERE batch_id=$1', [blacklisted.batch_id])).rows[0].action, 'blacklist');
  await service.rollback({ batchId: blacklisted.batch_id, actor: { type: 'admin', id: '9' } });
  const restored = (await pool.query('SELECT is_blacklisted, quality_status, seo_indexable FROM words WHERE id=$1', [alpha.id])).rows[0];
  assert.deepEqual(restored, { is_blacklisted: false, quality_status: 'review', seo_indexable: false });
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM user_vocabulary WHERE word_id=$1', [alpha.id])).rows[0].count, 1);

  const repeated = await service.applyBatch({
    writes: [
      {
        id: alpha.id,
        candidate: { phonetic: 'ˈælfə' },
        source: 'manual', reviewed: true,
      },
      { id: alpha.id, action: 'delete', source: 'manual', reviewed: true },
    ],
    actor: { type: 'admin', id: '9' },
  });
  assert.equal(repeated.results.length, 2);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM user_vocabulary WHERE word_id=$1', [alpha.id])).rows[0].count, 0);
  const repeatedRollback = await service.rollback({ batchId: repeated.batch_id, actor: { type: 'admin', id: '9' } });
  assert.equal(repeatedRollback.rolled_back, 2);
  assert.equal(repeatedRollback.words_rolled_back, 1);
  const repeatedRestored = (await pool.query('SELECT phonetic, is_blacklisted FROM words WHERE id=$1', [alpha.id])).rows[0];
  assert.deepEqual(repeatedRestored, { phonetic: 'ælfə', is_blacklisted: false });
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM user_vocabulary WHERE word_id=$1', [alpha.id])).rows[0].count, 1);
  const postRollbackVocabulary = (await pool.query(
    `INSERT INTO user_vocabulary (user_id, word_id, word, translation)
     VALUES (8, $1, 'Alpha', '序列验证') RETURNING id`,
    [alpha.id],
  )).rows[0];
  assert.ok(Number(postRollbackVocabulary.id) > 88, 'restored explicit ids must not leave the identity sequence behind');
  assert.equal((await pool.query(
    'SELECT COUNT(*)::int AS count FROM dictionary_quality_revisions WHERE batch_id=$1 AND rolled_back_at IS NOT NULL',
    [repeated.batch_id],
  )).rows[0].count, 2);

  const inserted = await service.apply({
    write: {
      word: 'novelword',
      candidate: {
        word: 'Novelword', word_lowercase: 'novelword', phonetic: 'nɒvəlwɜːd',
        definitions: [{ definition: 'A newly introduced test word.' }], part_of_speech: 'noun',
      },
      source: 'smart_import', reviewed: false,
    },
    actor: { type: 'system', id: 'import' },
  });
  assert.equal((await pool.query('SELECT action FROM dictionary_quality_revisions WHERE batch_id=$1', [inserted.batch_id])).rows[0].action, 'insert');
  await service.rollback({ batchId: inserted.batch_id, actor: { type: 'admin', id: '9' } });
  const rolledBackInsert = (await pool.query("SELECT is_blacklisted, seo_indexable FROM words WHERE word_lowercase='novelword'")).rows[0];
  assert.deepEqual(rolledBackInsert, { is_blacklisted: true, seo_indexable: false });
});

test('real apply rollback preserves SQL NULL, empty, JSON null, arrays, revisions, review state, and ledger times', { timeout: 60_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('curation_null_state');
  t.after(() => pool.end());
  await applyMigration('curation_null_state');
  await pool.query(`INSERT INTO words
    (word, word_lowercase, phonetic, definitions, part_of_speech, example_sentences, synonyms)
    VALUES
      ('and', 'and', NULL, NULL, NULL, NULL, NULL),
      ('have', 'have', '', 'null'::jsonb, '', 'null'::jsonb, ARRAY[]::text[]),
      ('the', 'the', '', '[]'::jsonb, '', '[]'::jsonb, ARRAY[]::text[])`);

  const applyAt = new Date('2026-08-22T01:02:03.000Z');
  const rollbackAt = new Date('2026-08-22T01:02:04.000Z');
  let nowCalls = 0;
  const service = createCurationService({
    repository: transactionalRepository(pool),
    now: () => [applyAt, rollbackAt][nowCalls++],
    randomUUID: () => '00000000-0000-4000-8000-000000000201',
  });
  const applied = await service.apply({ scope: ['and', 'have', 'the'], expectedRevisions: { and: 1, have: 1, the: 1 } });

  const afterApply = (await pool.query(`SELECT word_lowercase,
      example_sentences IS NULL AS examples_sql_null, jsonb_typeof(example_sentences) AS examples_type,
      synonyms IS NULL AS synonyms_sql_null, cardinality(synonyms) AS synonyms_count
    FROM words ORDER BY word_lowercase`)).rows;
  assert.deepEqual(afterApply, [
    { word_lowercase: 'and', examples_sql_null: true, examples_type: null, synonyms_sql_null: true, synonyms_count: null },
    { word_lowercase: 'have', examples_sql_null: false, examples_type: 'null', synonyms_sql_null: false, synonyms_count: 0 },
    { word_lowercase: 'the', examples_sql_null: false, examples_type: 'array', synonyms_sql_null: false, synonyms_count: 0 },
  ]);

  await service.rollback({ batchId: applied.batch_id });
  const restored = (await pool.query(`SELECT word_lowercase, phonetic, phonetic IS NULL AS phonetic_sql_null,
      definitions IS NULL AS definitions_sql_null, jsonb_typeof(definitions) AS definitions_type,
      part_of_speech, part_of_speech IS NULL AS pos_sql_null,
      example_sentences IS NULL AS examples_sql_null, jsonb_typeof(example_sentences) AS examples_type,
      synonyms IS NULL AS synonyms_sql_null, cardinality(synonyms) AS synonyms_count,
      content_revision, quality_status, quality_score, quality_reasons,
      quality_checked_revision, quality_checked_at, seo_indexable
    FROM words ORDER BY word_lowercase`)).rows;
  assert.deepEqual(restored, [
    {
      word_lowercase: 'and', phonetic: null, phonetic_sql_null: true,
      definitions_sql_null: true, definitions_type: null,
      part_of_speech: null, pos_sql_null: true,
      examples_sql_null: true, examples_type: null,
      synonyms_sql_null: true, synonyms_count: null,
      content_revision: '3', quality_status: 'review', quality_score: null,
      quality_reasons: ['batch_rolled_back'], quality_checked_revision: null,
      quality_checked_at: null, seo_indexable: false,
    },
    {
      word_lowercase: 'have', phonetic: '', phonetic_sql_null: false,
      definitions_sql_null: false, definitions_type: 'null',
      part_of_speech: '', pos_sql_null: false,
      examples_sql_null: false, examples_type: 'null',
      synonyms_sql_null: false, synonyms_count: 0,
      content_revision: '3', quality_status: 'review', quality_score: null,
      quality_reasons: ['batch_rolled_back'], quality_checked_revision: null,
      quality_checked_at: null, seo_indexable: false,
    },
    {
      word_lowercase: 'the', phonetic: '', phonetic_sql_null: false,
      definitions_sql_null: false, definitions_type: 'array',
      part_of_speech: '', pos_sql_null: false,
      examples_sql_null: false, examples_type: 'array',
      synonyms_sql_null: false, synonyms_count: 0,
      content_revision: '3', quality_status: 'review', quality_score: null,
      quality_reasons: ['batch_rolled_back'], quality_checked_revision: null,
      quality_checked_at: null, seo_indexable: false,
    },
  ]);

  const ledgerRows = (await pool.query(`SELECT r.word_lowercase, r.before_record, r.created_at, r.rolled_back_at,
      b.created_at AS batch_created_at, b.rolled_back_at AS batch_rolled_back_at
    FROM dictionary_quality_revisions r
    JOIN dictionary_quality_batches b ON b.id = r.batch_id
    WHERE r.batch_id = $1 ORDER BY r.word_lowercase`, [applied.batch_id])).rows;
  assert.deepEqual(ledgerRows.map((row) => ({
    word: row.word_lowercase,
    sql_nulls: row.before_record.sql_nulls,
    phonetic: row.before_record.phonetic,
    definitions: row.before_record.definitions,
    examples: row.before_record.example_sentences,
    synonyms: row.before_record.synonyms,
    created_at: row.created_at.toISOString(),
    rolled_back_at: row.rolled_back_at.toISOString(),
    batch_created_at: row.batch_created_at.toISOString(),
    batch_rolled_back_at: row.batch_rolled_back_at.toISOString(),
  })), [
    {
      word: 'and',
      sql_nulls: { word: false, word_lowercase: false, phonetic: true, definitions: true, part_of_speech: true, example_sentences: true, synonyms: true },
      phonetic: null, definitions: null, examples: null, synonyms: null,
      created_at: applyAt.toISOString(), rolled_back_at: rollbackAt.toISOString(),
      batch_created_at: applyAt.toISOString(), batch_rolled_back_at: rollbackAt.toISOString(),
    },
    {
      word: 'have',
      sql_nulls: { word: false, word_lowercase: false, phonetic: false, definitions: false, part_of_speech: false, example_sentences: false, synonyms: false },
      phonetic: '', definitions: null, examples: null, synonyms: [],
      created_at: applyAt.toISOString(), rolled_back_at: rollbackAt.toISOString(),
      batch_created_at: applyAt.toISOString(), batch_rolled_back_at: rollbackAt.toISOString(),
    },
    {
      word: 'the',
      sql_nulls: { word: false, word_lowercase: false, phonetic: false, definitions: false, part_of_speech: false, example_sentences: false, synonyms: false },
      phonetic: '', definitions: [], examples: [], synonyms: [],
      created_at: applyAt.toISOString(), rolled_back_at: rollbackAt.toISOString(),
      batch_created_at: applyAt.toISOString(), batch_rolled_back_at: rollbackAt.toISOString(),
    },
  ]);
});

test('ordered bulk locks avoid 40P01 for reversed overlapping apply scopes', { timeout: 30_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('curation_locks');
  t.after(() => pool.end());
  await applyMigration('curation_locks');
  await seedCuratedScope(pool, ['meeting', 'the']);
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const barrier = async () => {
    arrivals++;
    if (arrivals === 2) release();
    await gate;
  };
  const serviceA = createCurationService({
    repository: transactionalRepository(pool, { bulkLockBarrier: barrier }),
    randomUUID: () => '00000000-0000-4000-8000-000000000101',
  });
  const serviceB = createCurationService({
    repository: transactionalRepository(pool, { bulkLockBarrier: barrier }),
    randomUUID: () => '00000000-0000-4000-8000-000000000102',
  });
  const expectedRevisions = { meeting: 1, the: 1 };
  const results = await Promise.allSettled([
    serviceA.apply({ scope: ['meeting', 'the'], expectedRevisions }),
    serviceB.apply({ scope: ['the', 'meeting'], expectedRevisions }),
  ]);
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  assert.equal(arrivals, 2, 'both transactions must reach the production bulk-lock acquisition point');
  assert.equal(failures.some((error) => error?.code === '40P01' || /deadlock/i.test(error?.message)), false, failures.map((error) => error?.message));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(failures[0]?.message || '', /REVISION_CONFLICT/);
});

test('PostgreSQL and JavaScript share the validator corpus and every JS-invalid row stays off all SEO surfaces', { timeout: 60_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('validator_equivalence');
  t.after(() => pool.end());
  await applyMigration('validator_equivalence');

  for (const item of fixtures.validatorEquivalence.phonetics) {
    const jsAccepted = Boolean(normalizePhonetic(item.value));
    const sqlAccepted = (await pool.query('SELECT dictionary_phonetic_is_valid($1) AS accepted', [item.value])).rows[0].accepted;
    assert.equal(jsAccepted, item.accept, `JS phonetic: ${item.name}`);
    assert.equal(sqlAccepted, item.accept, `PostgreSQL phonetic: ${item.name}`);
  }
  for (const item of fixtures.validatorEquivalence.definitions) {
    const jsAccepted = normalizeDefinitions(item.value).length > 0;
    const sqlAccepted = (await pool.query('SELECT dictionary_definitions_are_valid($1::jsonb) AS accepted', [JSON.stringify(item.value)])).rows[0].accepted;
    assert.equal(jsAccepted, item.accept, `JS definitions: ${item.name}`);
    assert.equal(sqlAccepted, item.accept, `PostgreSQL definitions: ${item.name}`);
  }

  await pool.query(`INSERT INTO words
      (word,word_lowercase,phonetic,definitions,part_of_speech,content_revision,
       phonetic_source,definitions_source,part_of_speech_source,quality_status,
       quality_score,quality_reasons,quality_checked_revision,quality_checked_at,seo_indexable)
    VALUES ('validator-control','validator-control','vælɪd','[{"definition":"A valid control."}]'::jsonb,
      'noun',1,'batch_verified','batch_verified','batch_verified','verified',100,'[]'::jsonb,1,NOW(),TRUE)`);

  const invalidRows = [];
  for (const [index, item] of fixtures.validatorEquivalence.phonetics.filter((entry) => !entry.accept).entries()) {
    const word = `invalid-ipa-${item.name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`;
    invalidRows.push(word);
    await pool.query(`INSERT INTO words
        (word,word_lowercase,phonetic,definitions,part_of_speech,content_revision,
         phonetic_source,definitions_source,part_of_speech_source,quality_status,
         quality_score,quality_reasons,quality_checked_revision,quality_checked_at,seo_indexable)
      VALUES ($1,$1,$2,'[{"definition":"Invalid IPA row."}]'::jsonb,'noun',1,
        'batch_verified','batch_verified','batch_verified','verified',100,'[]'::jsonb,1,NOW(),FALSE)`,
    [word, item.value]);
    await assert.rejects(() => pool.query('UPDATE words SET seo_indexable=TRUE WHERE word_lowercase=$1', [word]), /seo|check/i, item.name);
  }
  for (const [index, item] of fixtures.validatorEquivalence.definitions.filter((entry) => !entry.accept).entries()) {
    const word = `invalid-def-${item.name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`;
    invalidRows.push(word);
    await pool.query(`INSERT INTO words
        (word,word_lowercase,phonetic,definitions,part_of_speech,content_revision,
         phonetic_source,definitions_source,part_of_speech_source,quality_status,
         quality_score,quality_reasons,quality_checked_revision,quality_checked_at,seo_indexable)
      VALUES ($1,$1,'ɪnˈvælɪd',$2::jsonb,'noun',1,
        'batch_verified','batch_verified','batch_verified','verified',100,'[]'::jsonb,1,NOW(),FALSE)`,
    [word, JSON.stringify(item.value)]);
    await assert.rejects(() => pool.query('UPDATE words SET seo_indexable=TRUE WHERE word_lowercase=$1', [word]), /seo|check/i, item.name);
  }

  const eligibleCount = await pool.query(`SELECT COUNT(*)::int AS count FROM words WHERE ${SEO_INDEXABLE_SQL}`);
  assert.equal(eligibleCount.rows[0].count, 1);

  const dataStore = require('../data-store');
  const { registerSeoRoutes } = require('../routes/seo');
  const originalQuery = dataStore.query;
  dataStore.query = (sql, params) => pool.query(sql, params);
  t.after(() => { dataStore.query = originalQuery; });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (await registerSeoRoutes(decodeURIComponent(url.pathname), req, res, url)) return;
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error.stack || error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${base}/learn/words`)).text();
  const sitemap = await (await fetch(`${base}/sitemap-words.xml`)).text();
  assert.match(list, /validator-control/);
  assert.match(sitemap, /\/learn\/word\/validator-control/);
  for (const word of invalidRows) {
    assert.doesNotMatch(list, new RegExp(`>${word}<`), `list: ${word}`);
    assert.doesNotMatch(sitemap, new RegExp(`/learn/word/${word}`), `sitemap: ${word}`);
    const detail = await fetch(`${base}/learn/word/${word}`);
    assert.equal(detail.status, 200, word);
    assert.equal(detail.headers.get('x-robots-tag'), 'noindex, follow', word);
  }
});

test('revision trigger covers every rendered field for changed and same-value writes', { timeout: 60_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('revision_surface');
  t.after(() => pool.end());
  await applyMigration('revision_surface');
  const cases = {
    word: {},
    word_lowercase: {},
    phonetic: { same: 'sɜːfɪs', changed: 'sɜːfeɪs' },
    definitions: { same: [{ definition: 'Surface.' }], changed: [{ definition: 'Changed surface.' }] },
    part_of_speech: { same: 'noun', changed: 'verb' },
    example_sentences: { same: [{ text: 'A surface example.' }], changed: [{ text: 'A changed example.' }] },
    synonyms: { same: ['face'], changed: ['changed'] },
  };
  let suffix = 0;
  for (const [column, values] of Object.entries(cases)) {
    for (const mode of ['same', 'changed']) {
      suffix++;
      const key = `surface-${suffix}`;
      const initial = key;
      const lowercase = key;
      const inserted = await pool.query(
        `INSERT INTO words(word, word_lowercase, phonetic, definitions, part_of_speech, example_sentences, synonyms)
         VALUES ($1,$2,'sɜːfɪs',$3::jsonb,'noun',$4::jsonb,$5::text[]) RETURNING id`,
        [initial, lowercase, JSON.stringify([{ definition: 'Surface.' }]), JSON.stringify([{ text: 'A surface example.' }]), ['face']],
      );
      await pool.query(`UPDATE words SET
          phonetic_source='batch_verified', definitions_source='batch_verified',
          part_of_speech_source='batch_verified', quality_status='verified', quality_score=100,
          quality_reasons='[]'::jsonb, quality_checked_revision=content_revision,
          quality_checked_at=NOW(), seo_indexable=TRUE WHERE id=$1`, [inserted.rows[0].id]);
      let value = values[mode];
      if (column === 'word' || column === 'word_lowercase') {
        value = mode === 'same' ? key : `${key}-changed`;
      }
      if (column === 'definitions' || column === 'example_sentences') value = JSON.stringify(value);
      await pool.query(`UPDATE words SET ${column}=$1 WHERE id=$2`, [value, inserted.rows[0].id]);
      const row = (await pool.query('SELECT content_revision, quality_status, quality_checked_revision, seo_indexable FROM words WHERE id=$1', [inserted.rows[0].id])).rows[0];
      assert.equal(Number(row.content_revision), 2, `${column}:${mode}`);
      assert.equal(row.quality_status, 'review', `${column}:${mode}`);
      assert.equal(row.quality_checked_revision, null, `${column}:${mode}`);
      assert.equal(row.seo_indexable, false, `${column}:${mode}`);
    }
  }
});

test('PostgreSQL eligibility, constraints, detail, list, count, and sitemap reject the same adversarial rows', { timeout: 60_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('seo_semantics');
  t.after(() => pool.end());
  await applyMigration('seo_semantics');
  const eligible = {
    word: 'meeting', phonetic: 'ˈmiːtɪŋ', definitions: [{ definition: 'An occasion when people meet.' }], source: 'batch_verified', score: 100,
  };
  await pool.query(`INSERT INTO words
      (word,word_lowercase,phonetic,definitions,part_of_speech,content_revision,
       phonetic_source,definitions_source,part_of_speech_source,quality_status,
       quality_score,quality_reasons,quality_checked_revision,quality_checked_at,seo_indexable)
    VALUES ($1,$1,$2,$3::jsonb,'noun',1,$4,$4,$4,'verified',$5,'[]'::jsonb,1,NOW(),TRUE)`,
  [eligible.word, eligible.phonetic, JSON.stringify(eligible.definitions), eligible.source, eligible.score]);

  const rejectedRows = [
    ['bad-ipa', '会议', [{ definition: 'Bad IPA.' }], 'batch_verified', 100, []],
    ['missing-definitions', 'mɪsɪŋ', [], 'batch_verified', 100, []],
    ['low-score', 'ləʊ', [{ definition: 'Low score.' }], 'batch_verified', 20, []],
    ['rejected-reasons', 'rɪˈdʒektɪd', [{ definition: 'Rejected.' }], 'batch_verified', 100, ['failed_review']],
    ['stale-revision', 'steɪl', [{ definition: 'Stale.' }], 'batch_verified', 100, []],
    ['missing-source', 'mɪsɪŋ', [{ definition: 'Missing source.' }], 'batch_verified', 100, []],
    ['the', 'ðɪ', [{ definition: 'Wrong trusted pronunciation.' }], 'batch_verified', 100, []],
  ];
  for (const [word, phonetic, definitions, source, score, reasons] of rejectedRows) {
    const lower = word;
    await pool.query(`INSERT INTO words
        (word,word_lowercase,phonetic,definitions,part_of_speech,phonetic_source,
         definitions_source,part_of_speech_source,quality_status,quality_score,
         quality_reasons,quality_checked_revision,quality_checked_at,seo_indexable)
      VALUES ($1,$2,$3,$4::jsonb,'noun',$5,$5,$5,'verified',$6,$7::jsonb,1,NOW(),FALSE)`,
    [word, lower, phonetic, JSON.stringify(definitions), source, score, JSON.stringify(reasons)]);
  }
  await pool.query("UPDATE words SET quality_checked_revision=0 WHERE word='stale-revision'");
  await pool.query("UPDATE words SET phonetic_source=NULL WHERE word='missing-source'");
  const forged = [
    ["UPDATE words SET phonetic_source='garbage' WHERE word='low-score'", /source|check/i],
    ["UPDATE words SET seo_indexable=TRUE WHERE word='low-score'", /seo|check/i],
    ["UPDATE words SET seo_indexable=TRUE WHERE word='rejected-reasons'", /seo|check/i],
    ["UPDATE words SET seo_indexable=TRUE WHERE word='bad-ipa'", /seo|check/i],
    ["UPDATE words SET seo_indexable=TRUE WHERE word='missing-definitions'", /seo|check/i],
    ["UPDATE words SET seo_indexable=TRUE WHERE word='stale-revision'", /seo|check/i],
    ["UPDATE words SET seo_indexable=TRUE WHERE word='missing-source'", /seo|check/i],
    ["UPDATE words SET seo_indexable=TRUE WHERE word='the'", /seo|check/i],
  ];
  for (const [sql, pattern] of forged) await assert.rejects(() => pool.query(sql), pattern, sql);

  const eligibleCount = await pool.query(`SELECT COUNT(*)::int AS count FROM words WHERE ${SEO_INDEXABLE_SQL}`);
  assert.equal(eligibleCount.rows[0].count, 1);

  const dataStore = require('../data-store');
  const { registerSeoRoutes } = require('../routes/seo');
  const originalQuery = dataStore.query;
  dataStore.query = (sql, params) => pool.query(sql, params);
  t.after(() => { dataStore.query = originalQuery; });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (await registerSeoRoutes(decodeURIComponent(url.pathname), req, res, url)) return;
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error.stack || error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${base}/learn/words`)).text();
  assert.match(list, /meeting/);
  for (const [word] of rejectedRows) assert.doesNotMatch(list, new RegExp(`>${word}<`));
  const sitemap = await (await fetch(`${base}/sitemap-words.xml`)).text();
  assert.match(sitemap, /\/learn\/word\/meeting/);
  for (const [word] of rejectedRows) assert.doesNotMatch(sitemap, new RegExp(`/learn/word/${word}`));
  const detail = await fetch(`${base}/learn/word/bad-ipa`);
  assert.equal(detail.headers.get('x-robots-tag'), 'noindex, follow');
});

test('translation provenance traverses all accepted containers and excludes forged rows from every SEO surface', { timeout: 60_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('translation_provenance');
  t.after(() => pool.end());
  await applyMigration('translation_provenance');
  const cases = [
    ['flat-example-camel', [{ definition: 'Camel example.', example: 'Camel example text.', exampleZh: '驼峰例句。' }], null],
    ['en-zh-container', { en: 'An en/zh definition.', zh: '中英文释义。' }, 'legacy'],
    ['meanings-example-snake', { meanings: [{ definitions: [{ definition: 'Snake example.', example: 'Snake example text.', example_zh: '下划线例句。' }] }] }, null],
    ['definitions-examples-array', { definitions: [{ definition: 'Array example.', example: 'Array example text.', examplesZh: ['数组例句。'] }] }, 'legacy'],
    ['serialized-en-zh', JSON.stringify({ en: 'A serialized definition.', zh: '序列化释义。' }), null],
    ['embedded-en-zh-missing', { en: [{ definition: 'Embedded definition.', zh: '嵌入式释义。' }] }, null],
    ['embedded-en-example-legacy', { en: [{ definition: 'Embedded example.', exampleZh: '嵌入式例句。' }] }, 'legacy'],
  ];

  for (const [word, definitions, zhSource] of cases) {
    await pool.query(`INSERT INTO words
        (word,word_lowercase,phonetic,definitions,content_revision,
         phonetic_source,definitions_source,zh_source,quality_status,quality_score,
         quality_reasons,quality_checked_revision,quality_checked_at,seo_indexable)
      VALUES ($1,$1,'prəˈvenəns',$2::jsonb,1,
        'batch_verified','batch_verified',$3,'verified',100,'[]'::jsonb,1,NOW(),FALSE)`,
    [word, JSON.stringify(definitions), zhSource]);
    const functions = (await pool.query(`SELECT
        dictionary_definitions_are_valid(definitions) AS valid,
        dictionary_definitions_have_translation(definitions) AS translated,
        dictionary_word_is_seo_eligible(words) AS eligible
      FROM words WHERE word_lowercase=$1`, [word])).rows[0];
    assert.deepEqual(functions, { valid: true, translated: true, eligible: false }, word);
    await assert.rejects(
      () => pool.query('UPDATE words SET seo_indexable=TRUE WHERE word_lowercase=$1', [word]),
      /seo|check/i,
      word,
    );
  }

  const count = await pool.query(`SELECT COUNT(*)::int AS count FROM words WHERE ${SEO_INDEXABLE_SQL}`);
  assert.equal(count.rows[0].count, 0);

  const dataStore = require('../data-store');
  const { registerSeoRoutes } = require('../routes/seo');
  const originalQuery = dataStore.query;
  dataStore.query = (sql, params) => pool.query(sql, params);
  t.after(() => { dataStore.query = originalQuery; });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (await registerSeoRoutes(decodeURIComponent(url.pathname), req, res, url)) return;
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error.stack || error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const list = await (await fetch(`${base}/learn/words`)).text();
  const sitemap = await (await fetch(`${base}/sitemap-words.xml`)).text();
  for (const [word] of cases) {
    assert.doesNotMatch(list, new RegExp(`>${word}<`), `list: ${word}`);
    assert.doesNotMatch(sitemap, new RegExp(`/learn/word/${word}`), `sitemap: ${word}`);
    const detail = await fetch(`${base}/learn/word/${word}`);
    assert.equal(detail.headers.get('x-robots-tag'), 'noindex, follow', `detail: ${word}`);
  }
});

test('JavaScript and PostgreSQL agree whether accepted definitions render a translation', { timeout: 60_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('translation_equivalence');
  t.after(() => pool.end());
  await applyMigration('translation_equivalence');

  const functionProperties = await pool.query(`SELECT proname, provolatile, proparallel
    FROM pg_proc
    WHERE proname IN (
      'dictionary_definition_item_has_translation',
      'dictionary_meaning_has_translation',
      'dictionary_definitions_have_translation'
    )
    ORDER BY proname`);
  assert.deepEqual(functionProperties.rows, [
    { proname: 'dictionary_definition_item_has_translation', provolatile: 'i', proparallel: 's' },
    { proname: 'dictionary_definitions_have_translation', provolatile: 'i', proparallel: 's' },
    { proname: 'dictionary_meaning_has_translation', provolatile: 'i', proparallel: 's' },
  ]);

  for (const [name, definitions, expected] of definitionTranslationEquivalenceCases) {
    const normalized = normalizeDefinitions(definitions);
    assert.ok(normalized.length > 0, `accepted fixture: ${name}`);
    assert.equal(normalizedDefinitionsRenderTranslation(definitions), expected, `JavaScript: ${name}`);
    const sql = await pool.query(`SELECT
      dictionary_definitions_are_valid($1::jsonb) AS valid,
      dictionary_definitions_have_translation($1::jsonb) AS translated`, [JSON.stringify(definitions)]);
    assert.deepEqual(sql.rows[0], { valid: true, translated: expected }, `PostgreSQL: ${name}`);
  }
});

test('production-sized SEO list, sitemap, and count plans stay on the partial-index candidate set', { timeout: 120_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('seo_query_plans');
  t.after(() => pool.end());
  await applyMigration('seo_query_plans');
  await pool.query(`INSERT INTO words
      (word,word_lowercase,frequency_rank,phonetic,definitions,content_revision,
       phonetic_source,definitions_source,quality_status,quality_score,quality_reasons,
       quality_checked_revision,quality_checked_at,seo_indexable)
    SELECT 'plan-word-' || LPAD(g::text, 6, '0'), 'plan-word-' || LPAD(g::text, 6, '0'), g,
      CASE WHEN g <= 10000 THEN 'plæn' ELSE NULL END,
      CASE WHEN g <= 10000 THEN '[{"definition":"An index-eligible plan row."}]'::jsonb ELSE '[]'::jsonb END,
      1,
      CASE WHEN g <= 10000 THEN 'batch_verified' ELSE NULL END,
      CASE WHEN g <= 10000 THEN 'batch_verified' ELSE NULL END,
      CASE WHEN g <= 10000 THEN 'verified' ELSE 'review' END,
      CASE WHEN g <= 10000 THEN 100 ELSE NULL END,
      '[]'::jsonb,
      CASE WHEN g <= 10000 THEN 1 ELSE NULL END,
      CASE WHEN g <= 10000 THEN NOW() ELSE NULL END,
      g <= 10000
    FROM generate_series(1, 100000) AS g`);
  await pool.query('ANALYZE words');

  const queries = {
    list: `SELECT id, word, part_of_speech, frequency_rank, difficulty_level, definitions, phonetic
      FROM words WHERE ${SEO_INDEXABLE_SQL}
      ORDER BY frequency_rank ASC NULLS LAST, id ASC LIMIT 40 OFFSET 0`,
    sitemap: `SELECT word FROM words WHERE ${SEO_INDEXABLE_SQL}
      ORDER BY frequency_rank ASC NULLS LAST LIMIT 2000`,
    count: `SELECT COUNT(*) FROM words WHERE ${SEO_INDEXABLE_SQL}`,
  };
  for (const [name, sql] of Object.entries(queries)) {
    const plan = await explainJson(pool, sql);
    const nodes = planNodes(plan);
    const indexNodes = nodes.filter((node) => node['Index Name'] === 'idx_words_dictionary_seo_eligible');
    assert.ok(indexNodes.length > 0, `${name}: ${JSON.stringify(plan)}`);
    assert.equal(nodes.some((node) => node['Relation Name'] === 'words' && node['Node Type'] === 'Seq Scan'), false, name);
    if (name === 'count') {
      assert.ok(indexNodes.every((node) => Number(node['Actual Rows']) <= 10000), JSON.stringify(indexNodes));
    }
  }
});

test('audit and lock repositories return explicit bounded columns and required indexes exist', { timeout: 30_000 }, async (t) => {
  if (!dockerAvailable) return t.skip('Docker unavailable');
  const pool = await createDatabase('audit_indexes');
  t.after(() => pool.end());
  await applyMigration('audit_indexes');
  await seedCuratedScope(pool, ['meeting']);
  const repository = createDictionaryQualityRepository(pool);
  const listed = await repository.listQualityRecords({ scope: ['meeting'], limit: 1 });
  assert.equal(Object.hasOwn(listed[0], 'private_blob'), false);
  const client = await pool.connect();
  await client.query('BEGIN');
  const locked = await createDictionaryQualityRepository(client).getWordsForQualityUpdate(['meeting']);
  await client.query('ROLLBACK');
  client.release();
  assert.equal(Object.hasOwn(locked[0], 'private_blob'), false);
  const indexes = await pool.query(`SELECT indexname FROM pg_indexes
    WHERE schemaname='public' AND tablename IN ('words','dictionary_quality_revisions')`);
  const names = new Set(indexes.rows.map((row) => row.indexname));
  assert.equal(names.has('idx_dictionary_quality_revisions_word'), true);
  assert.equal(names.has('uq_words_word_lowercase'), true);
  assert.equal(names.has('idx_words_lower'), false);
});
