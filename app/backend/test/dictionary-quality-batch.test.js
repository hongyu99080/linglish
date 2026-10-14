const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');

function curationModule() {
  try {
    return require('../services/dictionary/curation');
  } catch (_) {
    return {};
  }
}

function cliModule() {
  try {
    return require('../scripts/dictionary-quality');
  } catch (_) {
    return {};
  }
}

function fakeRepository(seed) {
  const records = new Map(seed.map((record) => [record.word_lowercase, structuredClone(record)]));
  const batches = new Map();
  const revisions = [];
  let writes = 0;

  return {
    records,
    batches,
    revisions,
    get writes() { return writes; },
    async listQualityRecords({ scope }) {
      return (scope || [...records.keys()]).map((word) => records.get(word)).filter(Boolean).map((record) => structuredClone(record));
    },
    async withTransaction(work) { return work(this); },
    async createQualityBatch(batch) { writes++; batches.set(batch.id, structuredClone(batch)); return batch; },
    async getWordsForQualityUpdate(words) {
      return words.map((word) => records.get(word)).filter(Boolean).map((row) => structuredClone(row));
    },
    async getWordForQualityUpdate(word) { const row = records.get(word); return row ? structuredClone(row) : null; },
    async updateCuratedWord({ word, expectedRevision, changes }) {
      const current = records.get(word);
      if (!current || current.content_revision !== expectedRevision) return null;
      const updated = { ...current, ...structuredClone(changes), content_revision: current.content_revision + 1 };
      records.set(word, updated);
      writes++;
      return structuredClone(updated);
    },
    async saveQualityDecision({ word, expectedRevision, decision }) {
      const current = records.get(word);
      if (!current || current.content_revision !== expectedRevision) return null;
      const updated = { ...current, ...structuredClone(decision) };
      records.set(word, updated);
      writes++;
      return structuredClone(updated);
    },
    async appendQualityRevision(revision) { writes++; revisions.push(structuredClone(revision)); return revision; },
    async listBatchRevisions(batchId) { return revisions.filter((revision) => revision.batch_id === batchId).map((revision) => structuredClone(revision)); },
    async restoreQualityRevision({ word, expectedRevision, before }) {
      const current = records.get(word);
      if (!current || current.content_revision !== expectedRevision) return null;
      const restored = {
        ...current,
        word: before.word,
        word_lowercase: before.word_lowercase,
        phonetic: before.phonetic,
        definitions: structuredClone(before.definitions),
        part_of_speech: before.part_of_speech,
        example_sentences: structuredClone(before.example_sentences),
        synonyms: structuredClone(before.synonyms),
        content_revision: current.content_revision + 1,
        quality_status: 'review',
        quality_score: null,
        quality_reasons: ['batch_rolled_back'],
        quality_meta: {},
        quality_checked_revision: null,
        quality_checked_at: null,
        seo_indexable: false,
      };
      records.set(word, restored);
      writes++;
      return structuredClone(restored);
    },
    async markRevisionRolledBack(id) { writes++; const revision = revisions.find((item) => item.id === id); if (revision) revision.rolled_back_at = 'now'; return true; },
    async markBatchRolledBack(id) { writes++; const batch = batches.get(id); if (batch) batch.status = 'rolled_back'; return true; },
  };
}

function seedRecords() {
  return ['meeting', 'the', 'and', 'have'].map((word, index) => ({
    id: index + 1,
    word,
    word_lowercase: word,
    phonetic: word === 'meeting' ? 'mɛtɪŋ' : '',
    definitions: [{ definition: `old ${word}` }],
    part_of_speech: null,
    content_revision: index + 3,
    quality_status: 'review',
    seo_indexable: false,
  }));
}

function adminResponse() {
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    body: null,
    writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    end(payload) { this.body = payload ? JSON.parse(String(payload)) : null; this.writableEnded = true; },
  };
}

function adminRequest(method, body = null) {
  const request = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.headers = {};
  return request;
}

function loadAdminRoute({ user, service }) {
  let routePath;
  try {
    routePath = require.resolve('../routes/admin/dictionary-quality');
  } catch (_) {
    return { route: {}, restore() {} };
  }
  const authPath = require.resolve('../middleware/auth');
  const curationPath = require.resolve('../services/dictionary/curation');
  const saved = new Map([routePath, authPath, curationPath].map((key) => [key, require.cache[key]]));
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { authenticate: async () => user } };
  require.cache[curationPath] = {
    id: curationPath,
    filename: curationPath,
    loaded: true,
    exports: {
      createCurationService: () => service,
      normalizeExpectedRevisions: (scope, revisions) => Object.fromEntries(scope.map((word) => [word, Number(revisions[word])])),
      normalizeScope: (scope) => scope,
    },
  };
  delete require.cache[routePath];
  const route = require(routePath);
  return {
    route,
    restore() {
      for (const [key, entry] of saved) {
        if (entry) require.cache[key] = entry;
        else delete require.cache[key];
      }
    },
  };
}

test('audit and plan are read-only and include current revisions plus known suggestions', async () => {
  const { createCurationService } = curationModule();
  assert.equal(typeof createCurationService, 'function');
  const repository = fakeRepository(seedRecords());
  const service = createCurationService({ repository, now: () => new Date('2026-08-22T00:00:00Z'), randomUUID: () => 'batch-readonly' });

  const audit = await service.audit({ scope: ['meeting', 'the', 'and', 'have'] });
  const plan = await service.preview({ scope: ['meeting', 'the', 'and', 'have'] });

  assert.equal(repository.writes, 0);
  assert.equal(audit.items.length, 4);
  assert.equal(plan.items.length, 4);
  assert.deepEqual(plan.items.map((item) => item.expected_revision), [5, 6, 3, 4]);
  assert.equal(plan.items.find((item) => item.word === 'meeting').after.phonetic, 'ˈmiːtɪŋ');
  const meetingAudit = audit.items.find((item) => item.word === 'meeting');
  assert.deepEqual(meetingAudit.current, {
    phonetic: 'mɛtɪŋ',
    definitions: [{ definition: 'old meeting' }],
    part_of_speech: null,
    example_sentences: [],
    synonyms: [],
  });
  assert.equal(meetingAudit.suggested_source, 'curated');
});

test('audit bounds wide current values and scope normalization is canonical', async () => {
  const { createCurationService, normalizeScope } = curationModule();
  assert.deepEqual(normalizeScope(['the', 'meeting', 'the', 'and']), ['and', 'meeting', 'the']);
  const [record] = seedRecords();
  record.phonetic = 'a'.repeat(500);
  record.definitions = [{ definition: 'x'.repeat(2_000), zh: '中'.repeat(2_000) }];
  record.example_sentences = Array.from({ length: 50 }, (_, index) => ({ text: `${index}:${'e'.repeat(500)}` }));
  record.synonyms = Array.from({ length: 100 }, (_, index) => `synonym-${index}-${'s'.repeat(100)}`);
  const service = createCurationService({ repository: fakeRepository([record]) });
  const audit = await service.audit({ scope: ['meeting'] });
  const serialized = JSON.stringify(audit.items[0].current);
  assert.ok(serialized.length < 10_000, serialized.length);
  assert.ok(audit.items[0].current.phonetic.length <= 100);
  assert.ok(audit.items[0].current.example_sentences.length <= 5);
  assert.ok(audit.items[0].current.synonyms.length <= 20);
});

test('apply requires optimistic expected revisions and writes a reversible verified batch', async () => {
  const { createCurationService } = curationModule();
  assert.equal(typeof createCurationService, 'function');
  const repository = fakeRepository(seedRecords());
  const service = createCurationService({ repository, now: () => new Date('2026-08-22T00:00:00Z'), randomUUID: () => 'batch-apply' });
  const expectedRevisions = Object.fromEntries(seedRecords().map((row) => [row.word_lowercase, row.content_revision]));

  await assert.rejects(
    () => service.apply({ scope: ['meeting', 'the', 'and', 'have'], expectedRevisions: { ...expectedRevisions, meeting: 99 }, actor: { type: 'test', id: '9' } }),
    /REVISION_CONFLICT:meeting/,
  );
  assert.equal(repository.writes, 0, 'conflict preflight must happen before the batch is created');

  const result = await service.apply({ scope: ['meeting', 'the', 'and', 'have'], expectedRevisions, actor: { type: 'test', id: '9' } });
  assert.equal(result.batch_id, 'batch-apply');
  assert.equal(result.applied, 4);
  assert.equal(repository.revisions.length, 4);
  const meeting = repository.records.get('meeting');
  assert.equal(meeting.phonetic, 'ˈmiːtɪŋ');
  assert.equal(meeting.content_revision, 4);
  assert.equal(meeting.quality_checked_revision, 4);
  assert.equal(meeting.quality_status, 'verified');
  assert.equal(meeting.seo_indexable, true);
});

test('rollback refuses superseded revisions and otherwise restores content while forcing review', async () => {
  const { createCurationService } = curationModule();
  assert.equal(typeof createCurationService, 'function');
  const repository = fakeRepository(seedRecords());
  const service = createCurationService({ repository, now: () => new Date('2026-08-22T00:00:00Z'), randomUUID: () => 'batch-rollback' });
  const expectedRevisions = Object.fromEntries(seedRecords().map((row) => [row.word_lowercase, row.content_revision]));
  await service.apply({ scope: ['meeting', 'the', 'and', 'have'], expectedRevisions, actor: { type: 'test', id: '9' } });

  repository.records.get('have').content_revision++;
  await assert.rejects(() => service.rollback({ batchId: 'batch-rollback', actor: { type: 'test', id: '9' } }), /ROLLBACK_SUPERSEDED:have/);
  assert.equal(repository.records.get('meeting').phonetic, 'ˈmiːtɪŋ', 'rollback preflight must prevent partial restoration');

  repository.records.get('have').content_revision--;
  const result = await service.rollback({ batchId: 'batch-rollback', actor: { type: 'test', id: '9' } });
  assert.equal(result.rolled_back, 4);
  const meeting = repository.records.get('meeting');
  assert.equal(meeting.phonetic, 'mɛtɪŋ');
  assert.equal(meeting.quality_status, 'review');
  assert.equal(meeting.quality_checked_revision, null);
  assert.equal(meeting.seo_indexable, false);
});

test('rollback collapses repeated writes to one word and restores the earliest snapshot atomically', async () => {
  const { createCurationService } = curationModule();
  const revisions = [
    {
      id: 201, batch_id: 'batch-repeated-word', word_lowercase: 'alpha',
      from_revision: 2, to_revision: 3, action: 'apply',
      before_record: {
        id: 7, word: 'Alpha', word_lowercase: 'alpha', content_revision: 2,
        definitions: [{ definition: 'Original.' }], user_vocabulary_records: [],
      },
    },
    {
      id: 202, batch_id: 'batch-repeated-word', word_lowercase: 'alpha',
      from_revision: 3, to_revision: 4, action: 'delete',
      before_record: {
        id: 7, word: 'Alpha', word_lowercase: 'alpha', content_revision: 3,
        definitions: [{ definition: 'Updated.' }],
        user_vocabulary_records: [{ id: 88, user_id: 9, word_id: 7, word: 'Alpha' }],
      },
    },
  ];
  const state = { restoreCalls: [], marked: [], invalidations: 0 };
  const repository = {
    async withTransaction(work) { return work(this); },
    async listBatchRevisions() { return structuredClone(revisions); },
    async getWordsForQualityUpdate() {
      return [{ id: 7, word: 'Alpha', word_lowercase: 'alpha', content_revision: 4 }];
    },
    async restoreLegacyRevision(options) {
      state.restoreCalls.push(structuredClone(options));
      return { id: 7, word: 'Alpha', word_lowercase: 'alpha', content_revision: 5 };
    },
    async markRevisionRolledBack(id) { state.marked.push(id); return true; },
    async markBatchRolledBack() { return true; },
    async invalidateWordCaches() { state.invalidations++; },
  };
  const service = createCurationService({ repository });

  const result = await service.rollback({ batchId: 'batch-repeated-word', actor: { type: 'admin', id: '9' } });

  assert.equal(result.rolled_back, 2);
  assert.equal(result.words_rolled_back, 1);
  assert.equal(state.restoreCalls.length, 1);
  assert.equal(state.restoreCalls[0].expectedRevision, 4);
  assert.equal(state.restoreCalls[0].before.definitions[0].definition, 'Original.');
  assert.deepEqual(state.restoreCalls[0].before.user_vocabulary_records, [
    { id: 88, user_id: 9, word_id: 7, word: 'Alpha' },
  ]);
  assert.deepEqual(state.marked, [201, 202]);
  assert.equal(state.invalidations, 1);
});

test('rollback attempts cache invalidation for every restored word before reporting failures', async () => {
  const { createCurationService } = curationModule();
  const revisions = ['alpha', 'bravo'].map((word, index) => ({
    id: 301 + index,
    batch_id: 'batch-cache-rollback',
    word_lowercase: word,
    from_revision: 2,
    to_revision: 3,
    action: 'apply',
    before_record: { id: 31 + index, word, word_lowercase: word, content_revision: 2 },
  }));
  const attempts = [];
  const repository = {
    async withTransaction(work) { return work(this); },
    async listBatchRevisions() { return structuredClone(revisions); },
    async getWordsForQualityUpdate(words) {
      return words.map((word, index) => ({ id: 31 + index, word, word_lowercase: word, content_revision: 3 }));
    },
    async restoreLegacyRevision({ word }) { return { word, word_lowercase: word, content_revision: 4 }; },
    async markRevisionRolledBack() { return true; },
    async markBatchRolledBack() { return true; },
    async invalidateWordCaches({ word }) {
      attempts.push(word);
      if (word === 'alpha') throw new Error('CACHE_INVALIDATION_FAILED:alpha');
    },
  };
  const service = createCurationService({ repository });

  await assert.rejects(
    () => service.rollback({ batchId: 'batch-cache-rollback', actor: { type: 'admin', id: '9' } }),
    /CACHE_INVALIDATION_FAILED/,
  );
  assert.deepEqual(attempts, ['alpha', 'bravo']);
});

test('rollback snapshots restore the complete publicly rendered content surface', async () => {
  const { createCurationService } = curationModule();
  const records = seedRecords();
  records[0].example_sentences = [{ text: 'Original public example.' }];
  records[0].synonyms = ['gathering', 'conference'];
  const repository = fakeRepository(records);
  const service = createCurationService({ repository, randomUUID: () => 'batch-surface' });
  const expectedRevisions = Object.fromEntries(records.map((row) => [row.word_lowercase, row.content_revision]));
  await service.apply({ scope: ['meeting', 'the', 'and', 'have'], expectedRevisions });
  repository.records.get('meeting').example_sentences = [{ text: 'Changed by apply path.' }];
  repository.records.get('meeting').synonyms = ['changed'];
  await service.rollback({ batchId: 'batch-surface' });
  assert.deepEqual(repository.records.get('meeting').example_sentences, [{ text: 'Original public example.' }]);
  assert.deepEqual(repository.records.get('meeting').synonyms, ['gathering', 'conference']);
});

test('apply ledger snapshots encode SQL null state without coercing empty or JSON-null values', async () => {
  const { createCurationService } = curationModule();
  const records = [
    {
      id: 41,
      word: 'and',
      word_lowercase: 'and',
      phonetic: null,
      definitions: null,
      part_of_speech: null,
      example_sentences: null,
      synonyms: null,
      phonetic_is_sql_null: true,
      definitions_is_sql_null: true,
      part_of_speech_is_sql_null: true,
      example_sentences_is_sql_null: true,
      synonyms_is_sql_null: true,
      content_revision: 1,
      quality_status: 'review',
      seo_indexable: false,
    },
    {
      id: 42,
      word: 'have',
      word_lowercase: 'have',
      phonetic: '',
      definitions: null,
      part_of_speech: '',
      example_sentences: null,
      synonyms: [],
      phonetic_is_sql_null: false,
      definitions_is_sql_null: false,
      part_of_speech_is_sql_null: false,
      example_sentences_is_sql_null: false,
      synonyms_is_sql_null: false,
      content_revision: 1,
      quality_status: 'review',
      seo_indexable: false,
    },
  ];
  const repository = fakeRepository(records);
  const service = createCurationService({ repository, randomUUID: () => 'batch-null-state' });
  await service.apply({ scope: ['and', 'have'], expectedRevisions: { and: 1, have: 1 } });

  const byWord = new Map(repository.revisions.map((revision) => [revision.word_lowercase, revision.before_record]));
  assert.deepEqual(byWord.get('and').sql_nulls, {
    word: false,
    word_lowercase: false,
    phonetic: true,
    definitions: true,
    part_of_speech: true,
    example_sentences: true,
    synonyms: true,
  });
  assert.equal(byWord.get('and').phonetic, null);
  assert.equal(byWord.get('and').example_sentences, null);
  assert.equal(byWord.get('and').synonyms, null);
  assert.deepEqual(byWord.get('have').sql_nulls, {
    word: false,
    word_lowercase: false,
    phonetic: false,
    definitions: false,
    part_of_speech: false,
    example_sentences: false,
    synonyms: false,
  });
  assert.equal(byWord.get('have').phonetic, '');
  assert.equal(byWord.get('have').definitions, null);
  assert.equal(byWord.get('have').part_of_speech, '');
  assert.equal(byWord.get('have').example_sentences, null);
  assert.deepEqual(byWord.get('have').synonyms, []);
});

test('CLI supports only exact commands and requires explicit scope plus confirmation for mutation', () => {
  const { parseArgs } = cliModule();
  assert.equal(typeof parseArgs, 'function');
  assert.equal(parseArgs(['audit']).command, 'audit');
  assert.equal(parseArgs(['plan']).readOnly, true);
  assert.throws(() => parseArgs(['audit', '--confirm', 'anything']), /OPTION_NOT_ALLOWED/);
  assert.throws(() => parseArgs(['apply']), /scope/i);
  assert.throws(() => parseArgs(['rollback', '--batch', 'batch-1']), /confirm/i);

  const apply = parseArgs([
    'apply',
    '--scope', 'meeting,the,and,have',
    '--expected-revisions', 'meeting=3,the=4,and=5,have=6',
    '--confirm', 'APPLY_DICTIONARY_QUALITY',
  ]);
  assert.deepEqual(apply.scope, ['and', 'have', 'meeting', 'the']);
  assert.deepEqual(apply.expectedRevisions, { meeting: 3, the: 4, and: 5, have: 6 });
  assert.equal(apply.readOnly, false);
});

test('admin quality API denies non-admins and keeps mutation behind explicit confirmation', async (t) => {
  const calls = [];
  const service = {
    async preview() { calls.push('preview'); return { mode: 'plan', read_only: true, items: [] }; },
    async apply(input) { calls.push(['apply', input]); return { batch_id: '00000000-0000-4000-8000-000000000001', applied: 4 }; },
  };

  const denied = loadAdminRoute({ user: { id: 7, is_admin: false }, service });
  assert.equal(typeof denied.route.registerDictionaryQualityRoutes, 'function');
  const deniedResponse = adminResponse();
  await denied.route.registerDictionaryQualityRoutes(
    '/admin/dictionary-quality/plan',
    adminRequest('GET'),
    deniedResponse,
    new URL('http://test/admin/dictionary-quality/plan'),
  );
  denied.restore();
  assert.equal(deniedResponse.statusCode, 403);
  assert.deepEqual(calls, []);

  const allowed = loadAdminRoute({ user: { id: 9, is_admin: true }, service });
  t.after(allowed.restore);
  const planResponse = adminResponse();
  await allowed.route.registerDictionaryQualityRoutes(
    '/admin/dictionary-quality/plan',
    adminRequest('GET'),
    planResponse,
    new URL('http://test/admin/dictionary-quality/plan'),
  );
  assert.equal(planResponse.statusCode, 200);
  assert.deepEqual(calls, ['preview']);

  const unsafeResponse = adminResponse();
  await allowed.route.registerDictionaryQualityRoutes(
    '/admin/dictionary-quality/apply',
    adminRequest('POST', { scope: ['meeting'], expected_revisions: { meeting: 3 } }),
    unsafeResponse,
    new URL('http://test/admin/dictionary-quality/apply'),
  );
  assert.equal(unsafeResponse.statusCode, 400);
  assert.deepEqual(calls, ['preview']);

  const applyResponse = adminResponse();
  await allowed.route.registerDictionaryQualityRoutes(
    '/admin/dictionary-quality/apply',
    adminRequest('POST', {
      scope: ['meeting'],
      expected_revisions: { meeting: 3 },
      confirm: 'APPLY_DICTIONARY_QUALITY',
    }),
    applyResponse,
    new URL('http://test/admin/dictionary-quality/apply'),
  );
  assert.equal(applyResponse.statusCode, 200);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === 'apply').length, 1);
});

test('V33 repeats safely, invalidates direct writes, and fails duplicate word_lowercase before schema mutation', { timeout: 60_000 }, async (t) => {
  const migrationPath = path.resolve(__dirname, '../../../docs/db/migrations/V33__dictionary_quality_gate.sql');
  assert.equal(fs.existsSync(migrationPath), true, 'V33 migration must exist');

  const docker = spawnSync('docker', ['info'], { encoding: 'utf8' });
  if (docker.status !== 0) {
    t.skip('Docker is unavailable for the ephemeral PostgreSQL migration test');
    return;
  }

  const name = `linglish-dictionary-v33-${process.pid}-${Date.now()}`;
  const run = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('run', '--detach', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=test', '-v', `${migrationPath}:/migration.sql:ro`, 'postgres:16-alpine');
  t.after(() => spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' }));

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const probe = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
    if (probe.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'temporary PostgreSQL should become ready');
  await new Promise((resolve) => setTimeout(resolve, 750));
  const stableProbe = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { encoding: 'utf8' });
  assert.equal(stableProbe.status, 0, 'temporary PostgreSQL should remain ready after initialization restart');

  const psql = (database, sqlOrFile, { file = false, allowFailure = false } = {}) => {
    const args = ['exec', name, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'];
    args.push(file ? '-f' : '-c', sqlOrFile);
    const result = spawnSync('docker', args, { encoding: 'utf8' });
    if (!allowFailure && result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result;
  };

  const createWords = `CREATE TABLE words (
    id BIGSERIAL PRIMARY KEY,
    word VARCHAR(100) NOT NULL,
    word_lowercase VARCHAR(100) NOT NULL,
    phonetic VARCHAR(100),
    definitions JSONB,
    part_of_speech VARCHAR(20),
    example_sentences JSONB,
    synonyms TEXT[],
    frequency_rank INTEGER,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`;
  psql('postgres', createWords);
  psql('postgres', '/migration.sql', { file: true });
  psql('postgres', '/migration.sql', { file: true });

  psql('postgres', `INSERT INTO words (word, word_lowercase, phonetic, definitions, part_of_speech)
    VALUES ('meeting', 'meeting', 'ˈmiːtɪŋ', '[{"definition":"A gathering."}]', 'noun');
    UPDATE words SET phonetic_source='batch_verified', definitions_source='batch_verified',
      part_of_speech_source='batch_verified', quality_status='verified', quality_score=100,
      quality_reasons='[]'::jsonb, quality_checked_revision=content_revision,
      quality_checked_at=NOW(), seo_indexable=TRUE WHERE word_lowercase='meeting';
    UPDATE words SET phonetic='mɛtɪŋ' WHERE word_lowercase='meeting';`);
  const invalidated = psql('postgres', "SELECT content_revision || ':' || quality_status || ':' || seo_indexable || ':' || COALESCE(quality_checked_revision::text, 'null') FROM words WHERE word_lowercase='meeting';");
  assert.match(invalidated.stdout, /2:review:false:null/);

  psql('postgres', `UPDATE words SET phonetic='ˈmiːtɪŋ' WHERE word_lowercase='meeting';
    UPDATE words SET phonetic_source='batch_verified', definitions_source='batch_verified',
      part_of_speech_source='batch_verified', quality_status='verified', quality_score=100,
      quality_reasons='[]'::jsonb, quality_checked_revision=content_revision,
      quality_checked_at=NOW(), seo_indexable=TRUE WHERE word_lowercase='meeting';
    UPDATE words SET phonetic=phonetic WHERE word_lowercase='meeting';`);
  const noOpInvalidated = psql('postgres', "SELECT content_revision || ':' || quality_status || ':' || seo_indexable || ':' || COALESCE(quality_checked_revision::text, 'null') FROM words WHERE word_lowercase='meeting';");
  assert.match(noOpInvalidated.stdout, /4:review:false:null/);

  psql('postgres', 'CREATE DATABASE duplicate_case');
  psql('duplicate_case', createWords);
  psql('duplicate_case', "INSERT INTO words(word,word_lowercase) VALUES ('Meeting','meeting'),('meeting-duplicate','meeting');");
  const duplicateRun = psql('duplicate_case', '/migration.sql', { file: true, allowFailure: true });
  assert.notEqual(duplicateRun.status, 0);
  assert.match(`${duplicateRun.stdout}\n${duplicateRun.stderr}`, /duplicate word_lowercase/i);
  const absent = psql('duplicate_case', "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='words' AND column_name='content_revision';");
  assert.match(absent.stdout, /\n\s*0\s*\n/);
});
