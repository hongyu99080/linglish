const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');

function responseDouble() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(payload) {
      this.body = payload ? JSON.parse(String(payload)) : null;
      this.writableEnded = true;
    },
  };
}

function requestDouble(method, url, body = null) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { host: 'test.local' };
  return req;
}

function saveCache(paths) {
  return new Map(paths.map((file) => [file, require.cache[file]]));
}

function restoreCache(saved) {
  for (const [file, entry] of saved) {
    if (entry) require.cache[file] = entry;
    else delete require.cache[file];
  }
}

function cacheModule(file, exports) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

function makeBoundaryCuration(seed = []) {
  const records = new Map(seed.map((record) => [String(record.word_lowercase || record.word).toLowerCase(), structuredClone(record)]));
  const state = { previews: [], applies: [], batchApplies: [], cacheInvalidations: 0, sequence: 0 };

  function plan(write, dryRun) {
    const key = String(write.word || write.candidate?.word_lowercase || write.candidate?.word || '').toLowerCase();
    const before = records.get(key) || (write.id
      ? [...records.values()].find((record) => Number(record.id) === Number(write.id))
      : null);
    const action = write.action || 'upsert';
    const source = write.reviewed === true ? 'manual_verified' : 'legacy';
    const after = action === 'delete' || action === 'blacklist'
      ? before
      : {
          ...(before || {}),
          ...(write.candidate || {}),
          id: before?.id || write.id || 100 + state.sequence,
          word: write.candidate?.word || before?.word || write.word,
          word_lowercase: write.candidate?.word_lowercase || before?.word_lowercase || key,
          quality_status: write.reviewed === true ? 'verified' : 'review',
          quality_reasons: write.reviewed === true ? [] : ['unreviewed_source'],
          seo_indexable: write.reviewed === true,
        };
    return {
      mode: dryRun ? 'preview' : 'apply',
      read_only: dryRun,
      dry_run: dryRun,
      action,
      source,
      requested_source: write.source || null,
      reviewed: write.reviewed === true,
      status: 'ready',
      quality_status: after?.quality_status || 'review',
      seo_indexable: after?.seo_indexable === true,
      reasons: after?.quality_reasons || [],
      conflicts: [],
      before: before ? structuredClone(before) : null,
      after: after ? structuredClone(after) : null,
      expected_revision: before?.content_revision || null,
    };
  }

  function applyOne(write) {
    state.sequence++;
    const result = plan(write, false);
    state.applies.push(structuredClone(write));
    if (write.action === 'delete') {
      const beforeKey = String(result.before?.word_lowercase || result.before?.word || '').toLowerCase();
      records.delete(beforeKey);
      result.deleted = result.before ? 1 : 0;
      result.user_vocabulary_deleted = result.before ? 2 : 0;
    } else if (write.action === 'blacklist') {
      if (result.before) {
        result.after = { ...result.before, is_blacklisted: true };
        records.set(String(result.before.word_lowercase).toLowerCase(), structuredClone(result.after));
      }
      result.blacklisted = result.before ? 1 : 0;
      result.user_vocabulary_deleted = result.before ? 2 : 0;
    } else {
      records.set(String(result.after.word_lowercase).toLowerCase(), structuredClone(result.after));
      result.applied = 1;
    }
    result.batch_id = `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
    state.cacheInvalidations++;
    return result;
  }

  const service = {
    async preview({ write }) {
      const result = plan(write, true);
      state.previews.push(structuredClone(write));
      return result;
    },
    async apply({ write }) {
      return applyOne(write);
    },
    async applyBatch({ writes, actor }) {
      state.batchApplies.push({ writes: structuredClone(writes), actor: structuredClone(actor) });
      const results = writes.map(applyOne);
      const batchId = `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`;
      for (const result of results) result.batch_id = batchId;
      return { batch_id: batchId, applied: results.reduce((sum, item) => sum + Number(item.applied || 0), 0), results };
    },
  };
  return { service, state, records };
}

function directWordMutation(sql) {
  return /^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+words\b/i.test(String(sql).trim().replace(/\s+/g, ' '));
}

function loadAdminRoutes({ curation, rows = [] } = {}) {
  const routePath = require.resolve('../routes/admin/translations');
  const dataStorePath = require.resolve('../data-store');
  const authPath = require.resolve('../middleware/auth');
  const dictionaryPath = require.resolve('../services/dictionary');
  const translationPath = require.resolve('../services/translation');
  const curationPath = require.resolve('../services/dictionary/curation');
  const saved = saveCache([routePath, dataStorePath, authPath, dictionaryPath, translationPath, curationPath]);
  const databaseState = { directWordWrites: 0, cacheWrites: 0, userVocabularyWrites: 0, translationOptions: [] };
  const defaultRow = rows[0] || {
    id: 7,
    word: 'alpha',
    word_lowercase: 'alpha',
    phonetic: '',
    part_of_speech: 'noun',
    definitions: { en: 'The first letter.', zh: '' },
    lookup_count: 4,
    learned_by_count: 0,
    content_revision: 2,
  };
  const pool = {
    async query(sql, params = []) {
      const normalized = String(sql).trim().replace(/\s+/g, ' ');
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return { rows: [], rowCount: 0 };
      if (directWordMutation(normalized)) {
        databaseState.directWordWrites++;
        throw new Error('DIRECT_WORD_MUTATION_BYPASSED_CURATION');
      }
      if (/UPDATE user_vocabulary/i.test(normalized)) {
        databaseState.userVocabularyWrites++;
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM user_vocabulary/i.test(normalized)) return { rows: [], rowCount: 2 };
      if (/SELECT .* FROM words WHERE id = \$1/i.test(normalized)) {
        return { rows: [structuredClone(rows.find((row) => Number(row.id) === Number(params[0])) || defaultRow)], rowCount: 1 };
      }
      if (/SELECT id FROM words WHERE word_lowercase/i.test(normalized)) {
        const found = rows.find((row) => row.word_lowercase === params[0]) || defaultRow;
        return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
      }
      if (/SELECT .*word_lowercase.*FROM words/i.test(normalized) || /FROM words/i.test(normalized)) {
        return { rows: [structuredClone(defaultRow)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  cacheModule(dataStorePath, {
    pool,
    async upsertTranslationCache() { databaseState.cacheWrites++; },
  });
  cacheModule(authPath, { authenticate: async () => ({ id: 9, username: 'admin', is_admin: true }) });
  cacheModule(dictionaryPath, {
    lookup: async (word) => ({
      entry: {
        word,
        phonetic: '/ˈælfə/',
        meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'The first letter.' }] }],
      },
    }),
  });
  cacheModule(translationPath, {
    translateWord: async (_word, options = {}) => {
      databaseState.translationOptions.push(structuredClone(options));
      return { translation: '阿尔法', source: 'deepl', score: 92, needsReview: true, fromCache: false };
    },
  });
  cacheModule(curationPath, { createCurationService: () => curation.service });
  delete require.cache[routePath];
  const routes = require(routePath);
  return { routes, databaseState, restore: () => restoreCache(saved) };
}

test('curation preview/apply protects verified fields, defaults unknown writes to review/noindex, and invalidates cache only after commit', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  const current = {
    id: 11,
    word: 'verified',
    word_lowercase: 'verified',
    phonetic: 'ˈverɪfaɪd',
    definitions: [{ definition: 'Checked content.', zh: '已核验' }],
    part_of_speech: 'adjective',
    audio_url: '/audio/verified.mp3',
    metadata: { owner: 'legacy' },
    content_revision: 4,
    phonetic_source: 'manual_verified',
    definitions_source: 'manual_verified',
    zh_source: 'manual_verified',
    part_of_speech_source: 'manual_verified',
    quality_status: 'verified',
    quality_score: 100,
    quality_reasons: [],
    quality_checked_revision: 4,
    quality_checked_at: '2026-08-22T00:00:00.000Z',
    seo_indexable: true,
  };
  const state = { record: structuredClone(current), writes: 0, invalidations: 0, failApply: false };
  const repository = {
    async getLegacyWriteRecord() { return structuredClone(state.record); },
    async withTransaction(work) { return work(this); },
    async createQualityBatch(batch) { state.writes++; return batch; },
    async updateLegacyWord({ changes }) {
      if (state.failApply) throw new Error('APPLY_FAILED');
      state.writes++;
      state.record = { ...state.record, ...structuredClone(changes), content_revision: state.record.content_revision + 1 };
      return structuredClone(state.record);
    },
    async saveQualityDecision({ decision }) {
      state.writes++;
      state.record = { ...state.record, ...structuredClone(decision) };
      return structuredClone(state.record);
    },
    async appendQualityRevision(revision) { state.writes++; return { id: 81, ...revision }; },
    async invalidateWordCaches() { state.invalidations++; },
  };
  const service = createCurationService({
    repository,
    now: () => new Date('2026-08-22T01:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000081',
  });

  const untrusted = {
    id: 11,
    word: 'verified',
    candidate: {
      word: 'verified',
      word_lowercase: 'verified',
      phonetic: 'bad',
      definitions: [{ definition: 'AI replacement.', zh: '机器覆盖' }],
      part_of_speech: 'noun',
    },
    source: 'unknown-ai-provider',
  };
  const preview = await service.preview({ write: untrusted });
  assert.equal(state.writes, 0);
  assert.equal(state.invalidations, 0);
  assert.equal(preview.quality_status, 'review');
  assert.equal(preview.seo_indexable, false);
  assert.equal(preview.after.phonetic, current.phonetic);
  assert.deepEqual(preview.after.definitions, current.definitions);
  assert.ok(preview.conflicts.some((item) => item.field === 'phonetic'));
  assert.equal(preview.after.audio_url, current.audio_url);
  assert.deepEqual(preview.after.metadata, current.metadata);

  const protectedApply = await service.apply({ write: untrusted, actor: { type: 'ai', id: 'worker' } });
  assert.equal(protectedApply.applied, 0);
  assert.equal(state.writes, 0);
  assert.equal(state.invalidations, 0);

  const reviewed = {
    ...untrusted,
    source: 'manual',
    reviewed: true,
    candidate: { ...untrusted.candidate, phonetic: 'ˈverɪfaɪd' },
  };
  const forgedPreview = await service.preview({ write: reviewed, actor: { type: 'ai', id: 'worker' } });
  assert.equal(forgedPreview.reviewed, false, 'non-admin preview cannot claim human review');
  assert.equal(forgedPreview.source, 'legacy');
  assert.equal(forgedPreview.quality_status, 'review');
  assert.equal(forgedPreview.seo_indexable, false);

  for (const forgedSource of ['curated', 'external']) {
    const adminPreview = await service.preview({
      write: { ...reviewed, source: forgedSource },
      actor: { type: 'admin', id: '9' },
    });
    assert.equal(adminPreview.source, 'manual_verified', `legacy admin writes cannot mint ${forgedSource} provenance`);
    assert.equal(adminPreview.requested_source, forgedSource);
  }

  const applied = await service.apply({ write: reviewed, actor: { type: 'admin', id: '9' } });
  assert.equal(applied.applied, 1);
  assert.equal(applied.source, 'manual_verified');
  assert.equal(state.invalidations, 1);
  assert.equal(state.record.audio_url, current.audio_url);
  assert.deepEqual(state.record.metadata, current.metadata);

  state.failApply = true;
  await assert.rejects(() => service.apply({
    write: { ...reviewed, candidate: { ...reviewed.candidate, definitions: [{ definition: 'A later edit.' }] } },
    actor: { type: 'admin', id: '9' },
  }), /APPLY_FAILED/);
  assert.equal(state.invalidations, 1, 'failed apply must not invalidate caches');
});

test('unblacklist no-op creates no quality batch and only updates blacklisted rows', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  const { createDictionaryQualityRepository } = require('../data-store/queries/dictionary');
  const state = { batches: 0, actions: 0 };
  const current = {
    id: 11, word: 'alpha', word_lowercase: 'alpha', definitions: [{ definition: 'First.' }],
    content_revision: 3, is_blacklisted: false, quality_status: 'review', seo_indexable: false,
  };
  const repository = {
    async withTransaction(work) { return work(this); },
    async getLegacyWriteRecord() { return structuredClone(current); },
    async createQualityBatch() { state.batches++; },
    async applyLegacyStateAction() {
      state.actions++;
      return { affected: 0, unblacklisted: 0, after: structuredClone(current) };
    },
    async invalidateWordCaches() { throw new Error('no-op must not invalidate caches'); },
  };
  const service = createCurationService({ repository });

  const result = await service.apply({
    write: { id: 11, action: 'unblacklist', source: 'manual', reviewed: true },
    actor: { type: 'admin', id: '9' },
  });

  assert.equal(result.applied, 0);
  assert.equal(result.batch_id, null);
  assert.equal(state.actions, 1);
  assert.equal(state.batches, 0);

  let updateSql = '';
  const sqlRepository = createDictionaryQualityRepository({
    async query(sql) {
      const statement = String(sql);
      if (/SELECT[\s\S]*FROM words/i.test(statement)) return { rows: [structuredClone(current)], rowCount: 1 };
      if (/UPDATE words/i.test(statement)) updateSql = statement;
      return { rows: [], rowCount: 0 };
    },
  });
  await sqlRepository.applyLegacyStateAction({ action: 'unblacklist', id: 11 });
  assert.match(updateSql, /AND is_blacklisted = TRUE/i);
});

test('legacy curation rejects mismatched canonical identity and low-quality renames before SQL', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  const current = {
    id: 11, word: 'alpha', word_lowercase: 'alpha', phonetic: 'ˈælfə',
    definitions: [{ definition: 'The first letter.' }], content_revision: 3,
    quality_status: 'review', quality_reasons: [], seo_indexable: false,
  };
  const repository = { async getLegacyWriteRecord() { return structuredClone(current); } };
  const service = createCurationService({ repository });

  await assert.rejects(() => service.preview({
    write: { id: 11, candidate: { word: 'Bravo', word_lowercase: 'charlie' }, source: 'manual', reviewed: true },
    actor: { type: 'admin', id: '9' },
  }), /WORD_IDENTITY_MISMATCH/);
  await assert.rejects(() => service.preview({
    write: { id: 11, candidate: { word: 'aaaa1111' }, source: 'manual', reviewed: true },
    actor: { type: 'admin', id: '9' },
  }), /LOW_QUALITY_WORD/);
});

test('create-only curation never updates an existing word or an insert-race winner', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  const existing = {
    id: 11, word: 'Alpha', word_lowercase: 'alpha', definitions: [{ definition: 'First.' }],
    content_revision: 3, quality_status: 'review', seo_indexable: false,
  };
  const state = { lookups: 0, inserts: 0, updates: 0, batches: 0 };
  const repository = {
    async withTransaction(work) { return work(this); },
    async getLegacyWriteRecord() { state.lookups++; return structuredClone(existing); },
    async insertLegacyWord() { state.inserts++; return null; },
    async updateLegacyWord() { state.updates++; return structuredClone(existing); },
    async createQualityBatch() { state.batches++; },
    async invalidateWordCaches() { throw new Error('duplicate create must not invalidate'); },
  };
  const service = createCurationService({ repository });
  const write = {
    word: 'alpha', create_only: true,
    candidate: { word: 'Alpha', word_lowercase: 'alpha', definitions: [{ definition: 'Replacement.' }] },
    source: 'manual', reviewed: true,
  };

  const duplicate = await service.apply({ write, actor: { type: 'admin', id: '9' } });
  assert.equal(duplicate.status, 'exists');
  assert.equal(duplicate.applied, 0);
  assert.equal(duplicate.after.id, 11);
  assert.equal(state.inserts, 0);
  assert.equal(state.updates, 0);
  assert.equal(state.batches, 0);

  state.lookups = 0;
  repository.getLegacyWriteRecord = async () => {
    state.lookups++;
    return state.lookups === 1 ? null : structuredClone(existing);
  };
  const raced = await service.apply({ write, actor: { type: 'admin', id: '9' } });
  assert.equal(raced.status, 'exists');
  assert.equal(raced.applied, 0);
  assert.equal(raced.reconciled, true);
  assert.equal(state.inserts, 1);
  assert.equal(state.updates, 0);
  assert.equal(state.batches, 0);
});

test('explicit zh null removes existing translations without creating empty definition content', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  let current = {
    id: 21, word: 'alpha', word_lowercase: 'alpha', phonetic: 'ælfə',
    definitions: { en: 'The first letter.', zh: '第一个字母。' }, part_of_speech: 'noun',
    content_revision: 3, quality_status: 'review', seo_indexable: false,
  };
  const service = createCurationService({
    repository: { async getLegacyWriteRecord() { return structuredClone(current); } },
  });

  const removal = await service.preview({
    write: { id: 21, candidate: { zh: null }, source: 'manual', reviewed: true },
    actor: { type: 'admin', id: '9' },
  });
  assert.equal(removal.content_changed, true);
  assert.equal(JSON.stringify(removal.after.definitions).includes('第一个字母'), false);
  assert.equal(JSON.stringify(removal.after.definitions).includes('"zh"'), false);

  current = { ...current, definitions: null, content_revision: 4 };
  const emptyRemoval = await service.preview({
    write: { id: 21, candidate: { zh: null }, source: 'manual', reviewed: true },
    actor: { type: 'admin', id: '9' },
  });
  assert.equal(emptyRemoval.content_changed, false);
  assert.equal(emptyRemoval.after.definitions, null);
});

test('untrusted zh null cannot remove a verified translation', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  const current = {
    id: 22, word: 'verified', word_lowercase: 'verified', phonetic: 'verɪfaɪd',
    definitions: [{ definition: 'Checked content.', zh: '已核验' }], part_of_speech: 'adjective',
    content_revision: 4, definitions_source: 'manual_verified', zh_source: 'manual_verified',
    quality_status: 'verified', quality_score: 100, quality_reasons: [],
    quality_checked_revision: 4, seo_indexable: true,
  };
  const service = createCurationService({
    repository: { async getLegacyWriteRecord() { return structuredClone(current); } },
  });

  const preview = await service.preview({
    write: { id: 22, candidate: { zh: null }, source: 'ai_vocab', reviewed: false },
    actor: { type: 'ai', id: 'worker' },
  });

  assert.equal(JSON.stringify(preview.after.definitions).includes('已核验'), true);
  assert.equal(preview.content_changed, false);
  assert.ok(preview.conflicts.some((item) => item.field === 'definitions'));
});

test('admin words add keeps duplicate-create semantics through curation', async (t) => {
  const existing = { id: 7, word: 'Alpha', word_lowercase: 'alpha', content_revision: 2 };
  const curation = makeBoundaryCuration([existing]);
  curation.service.apply = async ({ write }) => {
    curation.state.applies.push(structuredClone(write));
    return { status: 'exists', applied: 0, batch_id: null, after: structuredClone(existing) };
  };
  const loaded = loadAdminRoutes({ curation, rows: [existing] });
  t.after(loaded.restore);
  const response = responseDouble();

  await loaded.routes.registerAdminWordsRoutes(
    '/admin/words/add',
    requestDouble('POST', '/admin/words/add', { word: 'Alpha' }),
    response,
    new URL('http://test/admin/words/add'),
  );

  assert.equal(curation.state.applies[0].create_only, true);
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /已存在/);
});

test('legacy insert race reconciles with the canonical winner instead of failing or creating an empty batch', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  const winner = {
    id: 22, word: 'Novel', word_lowercase: 'novel', phonetic: 'nɒvəl',
    definitions: [{ definition: 'New and unusual.' }], part_of_speech: 'adjective',
    content_revision: 1, quality_status: 'review', quality_reasons: ['unreviewed_source'], seo_indexable: false,
  };
  let reads = 0;
  let batches = 0;
  const repository = {
    async withTransaction(work) { return work(this); },
    async getLegacyWriteRecord() { reads++; return reads === 1 ? null : structuredClone(winner); },
    async insertLegacyWord() { return null; },
    async createQualityBatch() { batches++; },
    async invalidateWordCaches() {},
  };
  const service = createCurationService({ repository, randomUUID: () => '00000000-0000-4000-8000-000000000022' });

  const result = await service.apply({
    write: {
      word: 'novel',
      candidate: { word: 'Novel', word_lowercase: 'novel', phonetic: 'nɒvəl', definitions: [{ definition: 'New and unusual.' }], part_of_speech: 'adjective' },
      source: 'smart_import',
      reviewed: false,
    },
    actor: { type: 'system', id: 'import' },
  });

  assert.equal(result.applied, 0);
  assert.equal(result.after.id, 22);
  assert.equal(batches, 0);
});

test('destructive legacy actions append an action-specific rollback revision', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  const before = {
    id: 31, word: 'obsolete', word_lowercase: 'obsolete', phonetic: 'ˈɒbsəliːt',
    definitions: [{ definition: 'No longer used.' }], content_revision: 4,
    is_blacklisted: false, blacklisted_at: null, blacklist_reason: null,
    quality_status: 'verified', quality_score: 100, quality_reasons: [], quality_meta: {},
    quality_checked_revision: 4, quality_checked_at: '2026-08-22T00:00:00.000Z', seo_indexable: true,
  };
  const state = { batches: [], revisions: [], invalidations: 0 };
  const repository = {
    async withTransaction(work) { return work(this); },
    async getLegacyWriteRecord() { return structuredClone(before); },
    async createQualityBatch(batch) { state.batches.push(batch); return batch; },
    async applyLegacyStateAction() {
      return { affected: 1, blacklisted: 1, user_vocabulary_deleted: 0, deleted_user_vocabulary_records: [], after: { ...before, content_revision: 5, is_blacklisted: true } };
    },
    async appendQualityRevision(revision) { state.revisions.push(revision); return { id: 1, ...revision }; },
    async invalidateWordCaches() { state.invalidations++; },
  };
  const service = createCurationService({ repository, randomUUID: () => '00000000-0000-4000-8000-000000000031' });

  const result = await service.apply({
    write: { id: 31, action: 'blacklist', source: 'manual', reviewed: true },
    actor: { type: 'admin', id: '9' },
  });

  assert.equal(result.batch_id, '00000000-0000-4000-8000-000000000031');
  assert.equal(state.batches.length, 1);
  assert.equal(state.revisions.length, 1);
  assert.equal(state.revisions[0].action, 'blacklist');
  assert.equal(state.invalidations, 1);
});

test('post-commit cache invalidation failures are visible and a no-op retry invalidates the committed word', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  const state = {
    record: {
      id: 41, word: 'durable', word_lowercase: 'durable', phonetic: 'ˈdjʊərəbəl',
      definitions: [{ definition: 'Able to withstand wear.' }], part_of_speech: 'adjective',
      content_revision: 2, quality_status: 'review', quality_reasons: ['unreviewed_source'], seo_indexable: false,
    },
    invalidations: 0,
  };
  const repository = {
    async withTransaction(work) { return work(this); },
    async getLegacyWriteRecord() { return structuredClone(state.record); },
    async createQualityBatch(batch) { return batch; },
    async updateLegacyWord({ changes }) {
      state.record = { ...state.record, ...structuredClone(changes), content_revision: state.record.content_revision + 1 };
      return structuredClone(state.record);
    },
    async bumpLegacyReviewRevision() {
      state.record = { ...state.record, content_revision: state.record.content_revision + 1 };
      return structuredClone(state.record);
    },
    async saveQualityDecision({ decision }) {
      state.record = { ...state.record, ...structuredClone(decision) };
      return structuredClone(state.record);
    },
    async appendQualityRevision(revision) { return { id: 91, ...revision }; },
    async invalidateWordCaches() {
      state.invalidations++;
      if (state.invalidations === 1) throw new Error('CACHE_INVALIDATION_FAILED:durable');
    },
  };
  const service = createCurationService({
    repository,
    now: () => new Date('2026-08-22T02:00:00.000Z'),
    randomUUID: () => '00000000-0000-4000-8000-000000000041',
  });
  const request = {
    word: 'durable',
    candidate: {
      word: 'durable', word_lowercase: 'durable', phonetic: 'ˈdjʊərəbəl',
      definitions: [{ definition: 'Able to withstand repeated wear.' }], part_of_speech: 'adjective',
    },
    source: 'smart_import', reviewed: false,
  };

  await assert.rejects(
    () => service.apply({ write: request, actor: { type: 'admin', id: '9' } }),
    /CACHE_INVALIDATION_FAILED:durable/,
  );
  assert.equal(state.record.content_revision, 3, 'database commit remains durable after cache failure');

  const retry = await service.apply({ write: request, actor: { type: 'admin', id: '9' } });
  assert.equal(retry.applied, 0);
  assert.equal(state.invalidations, 2, 'no-op retry must clear stale caches from the committed write');
});

test('batch cache invalidation attempts every committed word before reporting failures', async () => {
  const { createCurationService } = require('../services/dictionary/curation');
  const records = new Map([
    ['alpha', { id: 51, word: 'alpha', word_lowercase: 'alpha', phonetic: 'ælfə', definitions: [{ definition: 'Old alpha.' }], content_revision: 2, quality_status: 'review', seo_indexable: false }],
    ['bravo', { id: 52, word: 'bravo', word_lowercase: 'bravo', phonetic: 'brɑːvəʊ', definitions: [{ definition: 'Old bravo.' }], content_revision: 2, quality_status: 'review', seo_indexable: false }],
  ]);
  const attempts = [];
  const repository = {
    async withTransaction(work) { return work(this); },
    async getLegacyWriteRecord({ word, id }) {
      const record = word ? records.get(word) : [...records.values()].find((item) => Number(item.id) === Number(id));
      return record ? structuredClone(record) : null;
    },
    async createQualityBatch(batch) { return batch; },
    async updateLegacyWord({ word, changes }) {
      const current = records.get(word);
      const updated = { ...current, ...structuredClone(changes), content_revision: current.content_revision + 1 };
      records.set(updated.word_lowercase, updated);
      return structuredClone(updated);
    },
    async saveQualityDecision({ word, decision }) {
      const updated = { ...records.get(word), ...structuredClone(decision) };
      records.set(word, updated);
      return structuredClone(updated);
    },
    async appendQualityRevision(revision) { return { id: attempts.length + 1, ...revision }; },
    async invalidateWordCaches({ word }) {
      attempts.push(word);
      if (word === 'alpha') throw new Error('CACHE_INVALIDATION_FAILED:alpha');
    },
  };
  const service = createCurationService({ repository, randomUUID: () => '00000000-0000-4000-8000-000000000052' });

  await assert.rejects(() => service.applyBatch({
    writes: [
      { word: 'alpha', candidate: { definitions: [{ definition: 'New alpha.' }] }, source: 'smart_import' },
      { word: 'bravo', candidate: { definitions: [{ definition: 'New bravo.' }] }, source: 'smart_import' },
    ],
    actor: { type: 'system', id: 'batch-test' },
  }), /CACHE_INVALIDATION_FAILED/);

  assert.deepEqual(attempts, ['alpha', 'bravo']);
});

test('all three admin CSV/import modes preserve legacy result fields and support zero-write dry runs through curation', async (t) => {
  const cases = [
    {
      path: '/admin/translations/import-words-csv',
      csvData: 'word,phonetic,zh\nalpha,/ˈælfə/,阿尔法',
      expectedTotal: 1,
    },
    {
      path: '/admin/translations/import',
      csvData: 'word,translation\nalpha,阿尔法',
      expectedTotal: 1,
    },
    {
      path: '/admin/translations/import-csv',
      csvData: 'type,word_or_sentence,phonetic,en_text,zh_text,pos,meaning_index,def_index,example_index\nword_def,alpha,/ˈælfə/,The first letter.,阿尔法,noun,0,0,0',
      expectedTotal: 1,
    },
  ];

  for (const item of cases) {
    const curation = makeBoundaryCuration([{ id: 7, word: 'alpha', word_lowercase: 'alpha', content_revision: 2 }]);
    const loaded = loadAdminRoutes({ curation, rows: [...curation.records.values()] });
    t.after(loaded.restore);

    const dryResponse = responseDouble();
    await loaded.routes.registerAdminTranslationsRoutes(
      item.path,
      requestDouble('POST', item.path, { csvData: item.csvData, dry_run: true }),
      dryResponse,
      new URL(`http://test${item.path}`),
    );
    assert.equal(dryResponse.statusCode, 200, `${item.path}: dry-run status`);
    assert.equal(dryResponse.body.success, true, item.path);
    assert.equal(dryResponse.body.dry_run, true, item.path);
    assert.equal(dryResponse.body.results.total, item.expectedTotal, item.path);
    assert.equal(curation.state.applies.length, 0, item.path);
    assert.equal(loaded.databaseState.directWordWrites, 0, item.path);
    assert.equal(loaded.databaseState.cacheWrites, 0, item.path);

    const applyResponse = responseDouble();
    await loaded.routes.registerAdminTranslationsRoutes(
      item.path,
      requestDouble('POST', item.path, { csvData: item.csvData, source: 'admin_import', reviewed: false }),
      applyResponse,
      new URL(`http://test${item.path}`),
    );
    assert.equal(applyResponse.statusCode, 200, `${item.path}: apply status`);
    assert.equal(applyResponse.body.success, true, item.path);
    assert.equal(applyResponse.body.results.failed, 0, item.path);
    assert.ok(applyResponse.body.results.updated + (applyResponse.body.results.inserted || 0) >= 1, item.path);
    assert.ok(applyResponse.body.batch_ids?.length >= 1, item.path);
    assert.equal(applyResponse.body.source, 'legacy', `${item.path}: aggregate source`);
    assert.deepEqual(applyResponse.body.reasons, ['unreviewed_source'], `${item.path}: aggregate reasons`);
    assert.deepEqual(applyResponse.body.conflicts, [], `${item.path}: aggregate conflicts`);
    assert.equal(curation.state.applies.at(-1).source, 'admin_import', item.path);
    assert.equal(curation.state.applies.at(-1).reviewed, false, item.path);
    assert.equal(loaded.databaseState.directWordWrites, 0, item.path);
  }
});

test('lightweight CSV import restores translation-cache and user-vocabulary synchronization after curation', async (t) => {
  const curation = makeBoundaryCuration([{ id: 7, word: 'alpha', word_lowercase: 'alpha', content_revision: 2 }]);
  const loaded = loadAdminRoutes({ curation, rows: [...curation.records.values()] });
  t.after(loaded.restore);
  const response = responseDouble();

  await loaded.routes.registerAdminTranslationsRoutes(
    '/admin/translations/import-words-csv',
    requestDouble('POST', '/admin/translations/import-words-csv', {
      csvData: 'word,phonetic,zh\nalpha,/\u02c8ælfə/,阿尔法',
      source: 'admin_import',
    }),
    response,
    new URL('http://test/admin/translations/import-words-csv'),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.results.updatedWordCache, 1);
  assert.equal(response.body.results.updatedUserVocab, 1);
  assert.equal(loaded.databaseState.cacheWrites, 1);
  assert.equal(loaded.databaseState.userVocabularyWrites, 1);
});

test('admin retranslate single/batch, manual translation, and words add/update/batch keep old status fields while using curation', async (t) => {
  const curation = makeBoundaryCuration([{
    id: 7,
    word: 'alpha',
    word_lowercase: 'alpha',
    phonetic: '',
    part_of_speech: 'noun',
    definitions: { en: 'The first letter.', zh: '' },
    content_revision: 2,
  }]);
  const loaded = loadAdminRoutes({ curation, rows: [...curation.records.values()] });
  t.after(loaded.restore);
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback) => { callback(); return 0; };
  t.after(() => { global.setTimeout = originalSetTimeout; });

  const calls = [
    [loaded.routes.registerAdminTranslationsRoutes, '/admin/translations/retranslate', { lemma: 'alpha' }],
    [loaded.routes.registerAdminTranslationsRoutes, '/admin/translations/retranslate-batch', { limit: 1 }],
    [loaded.routes.registerAdminTranslationsRoutes, '/admin/translations/update', { lemma: 'alpha', translation: '阿尔法', reviewed: true, source: 'manual' }],
    [loaded.routes.registerAdminWordsRoutes, '/admin/words/add', { word: 'beta', phonetic: '/ˈbiːtə/', zh: '贝塔', part_of_speech: 'noun' }],
    [loaded.routes.registerAdminWordsRoutes, '/admin/words/update', { id: 7, phonetic: '/ˈælfə/', zh: '阿尔法', reviewed: true, source: 'manual' }],
    [loaded.routes.registerAdminWordsRoutes, '/admin/words/batch-apply', { dry_run: false, operations: [{ id: 7, action: 'update', zh: '阿尔法' }] }],
  ];

  for (const [handler, pathname, body] of calls) {
    const res = responseDouble();
    await handler(pathname, requestDouble('POST', pathname, body), res, new URL(`http://test${pathname}`));
    assert.equal(res.statusCode, 200, pathname);
    assert.equal(res.body.success, true, pathname);
  }

  for (const [pathname, body] of [
    ['/admin/words/batch-delete', { ids: [7] }],
    ['/admin/words/unblacklist', { ids: [7] }],
  ]) {
    const res = responseDouble();
    await loaded.routes.registerAdminWordsRoutes(
      pathname,
      requestDouble('POST', pathname, body),
      res,
      new URL(`http://test${pathname}`),
    );
    assert.equal(res.statusCode, 200, pathname);
    assert.equal(res.body.success, true, pathname);
  }

  const dryRetranslate = responseDouble();
  await loaded.routes.registerAdminTranslationsRoutes(
    '/admin/translations/retranslate',
    requestDouble('POST', '/admin/translations/retranslate', { lemma: 'alpha', dry_run: true }),
    dryRetranslate,
    new URL('http://test/admin/translations/retranslate'),
  );
  assert.equal(dryRetranslate.statusCode, 200);
  assert.equal(loaded.databaseState.translationOptions.at(-1).persist, false, 'dry-run must disable translation cache writes');

  assert.equal(loaded.databaseState.directWordWrites, 0);
  assert.ok(curation.state.applies.length >= calls.length);
  const retranslateWrite = curation.state.applies.find((write) => write.metadata?.path === '/admin/translations/retranslate');
  assert.equal(retranslateWrite.source, 'deepl');
  assert.equal(retranslateWrite.reviewed, false);
  const manualWrite = curation.state.applies.find((write) => write.metadata?.path === '/admin/translations/update');
  assert.equal(manualWrite.source, 'manual');
  assert.equal(manualWrite.reviewed, true);
  assert.equal(curation.state.batchApplies.length, 3, 'all admin batch state changes must use one atomic curation transaction each');
});

test('admin batch apply preserves request order and legacy delete fields', async (t) => {
  const curation = makeBoundaryCuration([
    { id: 7, word: 'alpha', word_lowercase: 'alpha', definitions: { en: 'First.' }, content_revision: 2 },
    { id: 8, word: 'bravo', word_lowercase: 'bravo', definitions: { en: 'Second.' }, content_revision: 3 },
  ]);
  const loaded = loadAdminRoutes({ curation, rows: [...curation.records.values()] });
  t.after(loaded.restore);
  const operations = [
    { id: 8, action: 'update', zh: '第二' },
    { id: 'bad', action: 'update' },
    { id: 7, action: 'delete' },
  ];

  const dry = responseDouble();
  await loaded.routes.registerAdminWordsRoutes(
    '/admin/words/batch-apply',
    requestDouble('POST', '/admin/words/batch-apply', { dry_run: true, operations }),
    dry,
    new URL('http://test/admin/words/batch-apply'),
  );
  assert.deepEqual(dry.body.results.map((item) => item.success), [true, false, true]);
  assert.equal(dry.body.results[2].wouldDeleteUserVocab, true);

  const apply = responseDouble();
  await loaded.routes.registerAdminWordsRoutes(
    '/admin/words/batch-apply',
    requestDouble('POST', '/admin/words/batch-apply', { operations }),
    apply,
    new URL('http://test/admin/words/batch-apply'),
  );
  assert.deepEqual(apply.body.results.map((item) => item.success), [true, false, true]);
  assert.equal(apply.body.results[2].deleted, 1);
  assert.equal(apply.body.results[2].userVocabDeleted, 2);
  assert.equal(new Set(apply.body.batch_ids).size, apply.body.batch_ids.length, 'batch ids must be unique');
});

test('admin batch apply reports per-item curation validation errors and applies the valid subset atomically', async (t) => {
  const curation = makeBoundaryCuration([
    { id: 7, word: 'alpha', word_lowercase: 'alpha', definitions: { en: 'First.' }, content_revision: 2 },
    { id: 8, word: 'bravo', word_lowercase: 'bravo', definitions: { en: 'Second.' }, content_revision: 3 },
  ]);
  const originalPreview = curation.service.preview;
  curation.service.preview = async (request) => {
    if (Number(request.write.id) === 999) return { status: 'missing', before: null, after: null };
    if (request.write.candidate?.word === 'aaaa1111') throw new Error('LOW_QUALITY_WORD:contains_digits');
    return originalPreview(request);
  };
  const loaded = loadAdminRoutes({ curation, rows: [...curation.records.values()] });
  t.after(loaded.restore);
  const response = responseDouble();

  await loaded.routes.registerAdminWordsRoutes(
    '/admin/words/batch-apply',
    requestDouble('POST', '/admin/words/batch-apply', {
      operations: [
        { id: 8, action: 'update', zh: '第二' },
        { id: 999, action: 'delete' },
        { id: 7, action: 'update', word: 'aaaa1111' },
        { id: 7, action: 'update', definitions: 'invalid-shape' },
      ],
    }),
    response,
    new URL('http://test/admin/words/batch-apply'),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.results.map((item) => item.success), [true, false, false, false]);
  assert.match(response.body.results[1].error, /Word not found/);
  assert.match(response.body.results[2].error, /LOW_QUALITY_WORD/);
  assert.match(response.body.results[3].error, /definitions must be an object or null/);
  assert.equal(curation.state.batchApplies.length, 1);
  assert.equal(curation.state.batchApplies[0].writes.length, 1);
});

test('admin delete responses identify reversible soft deletion without losing legacy counts', async (t) => {
  const curation = makeBoundaryCuration([
    { id: 7, word: 'alpha', word_lowercase: 'alpha', definitions: { en: 'First.' }, content_revision: 2 },
  ]);
  const loaded = loadAdminRoutes({ curation, rows: [...curation.records.values()] });
  t.after(loaded.restore);

  const single = responseDouble();
  await loaded.routes.registerAdminWordsRoutes(
    '/admin/words/delete',
    requestDouble('POST', '/admin/words/delete', { id: 7 }),
    single,
    new URL('http://test/admin/words/delete'),
  );
  assert.equal(single.body.blacklisted, 1);
  assert.equal(single.body.userVocabDeleted, 2);
  assert.equal(single.body.soft_deleted, true);
  assert.match(single.body.note, /可回滚恢复/);

  const batch = responseDouble();
  await loaded.routes.registerAdminWordsRoutes(
    '/admin/words/batch-delete',
    requestDouble('POST', '/admin/words/batch-delete', { ids: [7] }),
    batch,
    new URL('http://test/admin/words/batch-delete'),
  );
  assert.equal(batch.body.deleted, 1);
  assert.equal(batch.body.userVocabDeleted, 2);
  assert.equal(batch.body.soft_deleted, true);
  assert.match(batch.body.note, /可回滚恢复/);
});

function loadAiRoute(curation) {
  const routePath = require.resolve('../routes/ai-vocab');
  const dataStorePath = require.resolve('../data-store');
  const authPath = require.resolve('../middleware/ai-auth');
  const curationPath = require.resolve('../services/dictionary/curation');
  const saved = saveCache([routePath, dataStorePath, authPath, curationPath]);
  const state = { directWordWrites: 0, userWrites: 0 };
  cacheModule(dataStorePath, {
    pool: {
      async query(sql, params = []) {
        const normalized = String(sql).trim().replace(/\s+/g, ' ');
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(normalized)) return { rows: [], rowCount: 0 };
        if (directWordMutation(normalized)) {
          state.directWordWrites++;
          throw new Error('DIRECT_WORD_MUTATION_BYPASSED_CURATION');
        }
        if (/user_vocabulary/i.test(normalized)) { state.userWrites++; return { rows: [], rowCount: 2 }; }
        if (/SELECT id FROM words WHERE word_lowercase/i.test(normalized)) return { rows: [{ id: 7 }], rowCount: 1 };
        if (/FROM words WHERE id/i.test(normalized)) return { rows: [structuredClone(curation.records.get('alpha'))], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    },
  });
  cacheModule(authPath, { requireAiVocabToken: () => ({ id: 'ai-worker' }) });
  cacheModule(curationPath, { createCurationService: () => curation.service });
  delete require.cache[routePath];
  const route = require(routePath);
  return { route, state, restore: () => restoreCache(saved) };
}

test('AI vocab update/delete and alias preserve response fields, and dry-run performs no mutations', async (t) => {
  const curation = makeBoundaryCuration([{
    id: 7, word: 'alpha', word_lowercase: 'alpha', definitions: { en: 'First.', zh: '' }, content_revision: 2,
  }]);
  const loaded = loadAiRoute(curation);
  t.after(loaded.restore);
  const operations = [
    { id: 7, action: 'update', zh: '阿尔法' },
    { id: 7, action: 'delete' },
  ];

  const dry = responseDouble();
  await loaded.route.registerAiVocabRoutes(
    '/ai/vocab/apply',
    requestDouble('POST', '/ai/vocab/apply', { dry_run: true, operations }),
    dry,
    new URL('http://test/ai/vocab/apply'),
  );
  assert.equal(dry.statusCode, 200);
  assert.equal(dry.body.success, true);
  assert.equal(dry.body.dry_run, true);
  assert.deepEqual(dry.body.summary, { updated: 0, deleted: 0, userVocabUpdated: 0, userVocabDeleted: 0 });
  assert.equal(curation.state.applies.length, 0);
  assert.equal(loaded.state.directWordWrites, 0);
  assert.equal(loaded.state.userWrites, 0);

  const apply = responseDouble();
  await loaded.route.registerAiVocabRoutes(
    '/ai/vocab/batch-apply',
    requestDouble('POST', '/ai/vocab/batch-apply', { operations, source: 'manual', reviewed: true }),
    apply,
    new URL('http://test/ai/vocab/batch-apply'),
  );
  assert.equal(apply.statusCode, 200);
  assert.equal(apply.body.success, true);
  assert.equal(apply.body.dry_run, false);
  assert.equal(apply.body.summary.updated, 1);
  assert.equal(apply.body.summary.deleted, 1);
  assert.equal(apply.body.summary.userVocabDeleted, 2);
  assert.equal(apply.body.results.length, 2);
  assert.ok(apply.body.batch_ids.length >= 1);
  assert.equal(loaded.state.directWordWrites, 0);
  assert.equal(curation.state.applies[0].source, 'ai_vocab');
  assert.equal(curation.state.applies[0].reviewed, false, 'AI token cannot forge reviewed provenance');
  assert.equal(curation.state.applies[1].action, 'blacklist');
  assert.equal(curation.state.batchApplies.length, 1, 'AI batch must use one atomic curation transaction');
});

test('AI vocab batch preserves request order and exposes the legacy response contract only', async (t) => {
  const curation = makeBoundaryCuration([
    { id: 7, word: 'alpha', word_lowercase: 'alpha', definitions: { en: 'First.' }, content_revision: 2 },
    { id: 8, word: 'bravo', word_lowercase: 'bravo', definitions: { en: 'Second.' }, content_revision: 3 },
  ]);
  const loaded = loadAiRoute(curation);
  t.after(loaded.restore);
  const operations = [
    { id: 8, action: 'update', zh: '第二' },
    { action: 'invalid' },
    { id: 7, action: 'delete' },
  ];

  const dry = responseDouble();
  await loaded.route.registerAiVocabRoutes(
    '/ai/vocab/apply',
    requestDouble('POST', '/ai/vocab/apply', { dry_run: true, operations }),
    dry,
    new URL('http://test/ai/vocab/apply'),
  );
  assert.deepEqual(dry.body.results.map((item) => item.success), [true, false, true]);
  assert.equal(dry.body.results[2].wouldBlacklist, true);
  assert.equal(dry.body.results[2].wouldDeleteUserVocab, true);

  const apply = responseDouble();
  await loaded.route.registerAiVocabRoutes(
    '/ai/vocab/apply',
    requestDouble('POST', '/ai/vocab/apply', { operations }),
    apply,
    new URL('http://test/ai/vocab/apply'),
  );
  assert.deepEqual(apply.body.results.map((item) => item.success), [true, false, true]);
  assert.equal(apply.body.results[2].blacklisted, 1);
  assert.equal(apply.body.results[2].userVocabDeleted, 2);
  assert.match(apply.body.results[2].note, /停用|黑名单/);
  assert.equal(Object.hasOwn(apply.body.results[0], 'mode'), false, 'internal curation fields must not leak');
  assert.equal(new Set(apply.body.batch_ids).size, apply.body.batch_ids.length, 'batch ids must be unique');
});

test('AI vocab batch reports per-item curation validation errors and applies the valid subset atomically', async (t) => {
  const curation = makeBoundaryCuration([
    { id: 7, word: 'alpha', word_lowercase: 'alpha', definitions: { en: 'First.' }, content_revision: 2 },
    { id: 8, word: 'bravo', word_lowercase: 'bravo', definitions: { en: 'Second.' }, content_revision: 3 },
  ]);
  const originalPreview = curation.service.preview;
  curation.service.preview = async (request) => {
    if (Number(request.write.id) === 999) return { status: 'missing', before: null, after: null };
    if (request.write.candidate?.word === 'aaaa1111') throw new Error('LOW_QUALITY_WORD:contains_digits');
    return originalPreview(request);
  };
  const loaded = loadAiRoute(curation);
  t.after(loaded.restore);
  const response = responseDouble();

  await loaded.route.registerAiVocabRoutes(
    '/ai/vocab/apply',
    requestDouble('POST', '/ai/vocab/apply', {
      operations: [
        { id: 8, action: 'update', zh: '第二' },
        { id: 999, action: 'delete' },
        { id: 7, action: 'update', word_new: 'aaaa1111' },
        { id: 7, action: 'update', definitions: 'invalid-shape' },
      ],
    }),
    response,
    new URL('http://test/ai/vocab/apply'),
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.results.map((item) => item.success), [true, false, false, false]);
  assert.match(response.body.results[1].error, /Word not found/);
  assert.match(response.body.results[2].error, /LOW_QUALITY_WORD/);
  assert.match(response.body.results[3].error, /definitions must be an object or null/);
  assert.equal(curation.state.batchApplies.length, 1);
  assert.equal(curation.state.batchApplies[0].writes.length, 1);
});

function loadWordCreationModule(moduleRelativePath, exportName, { dictionaryEntry = null } = {}) {
  const modulePath = require.resolve(moduleRelativePath);
  const corePath = require.resolve('../data-store/core');
  const dictionaryPath = require.resolve('../services/dictionary');
  const curationPath = require.resolve('../services/dictionary/curation');
  const pgPath = require.resolve('pg');
  const saved = saveCache([modulePath, corePath, dictionaryPath, curationPath, pgPath]);
  const curation = makeBoundaryCuration();
  const state = { directWordWrites: 0 };
  const fakePool = {
    async query(sql) {
      const normalized = String(sql).trim().replace(/\s+/g, ' ');
      if (directWordMutation(normalized)) {
        state.directWordWrites++;
        throw new Error('DIRECT_WORD_MUTATION_BYPASSED_CURATION');
      }
      if (/FROM words/i.test(normalized)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  cacheModule(corePath, {
    init: async () => {},
    dbUnavailable: () => false,
    assertDbAvailable: () => {},
    pool: fakePool,
  });
  cacheModule(pgPath, {
    ...require('pg'),
    Pool: class FakePool {
      query(sql, params) { return fakePool.query(sql, params); }
    },
  });
  cacheModule(dictionaryPath, {
    lookup: async (word) => ({
      entry: dictionaryEntry || {
        word,
        phonetic: '/nəʊvəl/',
        meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: 'New or unusual.' }] }],
      },
    }),
  });
  cacheModule(curationPath, { createCurationService: () => curation.service });
  delete require.cache[modulePath];
  const loaded = require(modulePath);
  return { fn: loaded[exportName], curation, state, restore: () => restoreCache(saved) };
}

test('Vocabulary V2 and SmartImport create review/noindex global words through curation', async (t) => {
  const vocabulary = loadWordCreationModule('../services/vocabulary-v2', 'getOrCreateWord');
  t.after(vocabulary.restore);
  const vocabWord = await vocabulary.fn('Novel');
  assert.equal(vocabWord.word_lowercase, 'novel');
  assert.equal(vocabWord.quality_status, 'review');
  assert.equal(vocabulary.state.directWordWrites, 0);
  assert.equal(vocabulary.curation.state.applies[0].source, 'dictionary_external');
  assert.equal(vocabulary.curation.state.applies[0].reviewed, false);

  const smart = loadWordCreationModule('../services/smart-import', 'ensureWordInGlobalVocabulary');
  t.after(smart.restore);
  const smartWord = await smart.fn('Contextual');
  assert.equal(smartWord.word_lowercase, 'contextual');
  assert.equal(smartWord.quality_status, 'review');
  assert.equal(smart.state.directWordWrites, 0);
  assert.equal(smart.curation.state.applies[0].source, 'smart_import');
});

test('legacy word creation resolves canonical lowercase conflicts through the V33 identity', async () => {
  const { createDictionaryQualityRepository } = require('../data-store/queries/dictionary');
  let statement = '';
  const repository = createDictionaryQualityRepository({
    async query(sql) {
      statement = String(sql);
      return { rows: [], rowCount: 0 };
    },
  });

  await repository.insertLegacyWord({
    changes: {
      word: 'Novel',
      word_lowercase: 'novel',
      phonetic: null,
      definitions: [],
      part_of_speech: null,
    },
  });

  assert.match(statement, /ON CONFLICT \(word_lowercase\) DO NOTHING/i);
});

test('restoring deleted user vocabulary advances its identity sequence', async () => {
  const { createDictionaryQualityRepository } = require('../data-store/queries/dictionary');
  const statements = [];
  const repository = createDictionaryQualityRepository({
    async query(sql) {
      const statement = String(sql);
      statements.push(statement);
      if (/UPDATE words[\s\S]*RETURNING id, content_revision/i.test(statement)) {
        return { rows: [{ id: 7, content_revision: 5 }], rowCount: 1 };
      }
      if (/quality_status = 'review'/i.test(statement)) {
        return { rows: [{ id: 7, word: 'Alpha', word_lowercase: 'alpha', content_revision: 5 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  });

  await repository.restoreLegacyRevision({
    word: 'alpha',
    expectedRevision: 4,
    action: 'delete',
    before: {
      id: 7, word: 'Alpha', word_lowercase: 'alpha', content_revision: 3,
      user_vocabulary_records: [{ id: 88, user_id: 9, word_id: 7, word: 'Alpha' }],
    },
  });

  const insertIndex = statements.findIndex((sql) => /INSERT INTO user_vocabulary/i.test(sql));
  const sequenceIndex = statements.findIndex((sql) => /pg_get_serial_sequence\('user_vocabulary',\s*'id'\)/i.test(sql));
  assert.ok(insertIndex >= 0, 'rollback must restore deleted user vocabulary rows');
  assert.ok(sequenceIndex > insertIndex, 'identity sequence must advance after restoring explicit ids');
  assert.match(statements[sequenceIndex], /MAX\(id\)/i);
  assert.match(statements[sequenceIndex], /nextval/i);
  assert.equal(
    statements.some((sql) => /LOCK TABLE user_vocabulary/i.test(sql)),
    false,
    'sequence repair must not introduce a table-lock inversion with normal vocabulary inserts',
  );
});

test('legacy vocabulary upsert creates the global word through curation without losing user-vocabulary response fields', async (t) => {
  const modulePath = require.resolve('../data-store/queries/vocabulary');
  const corePath = require.resolve('../data-store/core');
  const curationPath = require.resolve('../services/dictionary/curation');
  const saved = saveCache([modulePath, corePath, curationPath]);
  t.after(() => restoreCache(saved));
  const curation = makeBoundaryCuration();
  const state = { directWordWrites: 0 };
  cacheModule(corePath, {
    init: async () => {},
    dbUnavailable: () => false,
    assertDbAvailable: () => {},
    pool: {
      async query(sql) {
        const normalized = String(sql).trim().replace(/\s+/g, ' ');
        if (directWordMutation(normalized)) {
          state.directWordWrites++;
          throw new Error('DIRECT_WORD_MUTATION_BYPASSED_CURATION');
        }
        if (/FROM user_vocabulary/i.test(normalized)) return { rows: [], rowCount: 0 };
        if (/SELECT id, is_blacklisted FROM words/i.test(normalized)) return { rows: [], rowCount: 0 };
        if (/INSERT INTO user_vocabulary/i.test(normalized)) {
          return { rows: [{ id: 91, user_id: 5, word_id: 101, word: 'legacyword', status: 'learning' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
  });
  cacheModule(curationPath, { createCurationService: () => curation.service });
  delete require.cache[modulePath];
  const { upsertVocabItem } = require(modulePath);

  const result = await upsertVocabItem(5, 'LegacyWord', { state: 'learning' });
  assert.equal(result.user_id, 5);
  assert.equal(result.word, 'legacyword');
  assert.equal(state.directWordWrites, 0);
  assert.equal(curation.state.applies[0].source, 'legacy_vocabulary');
  assert.equal(curation.state.applies[0].reviewed, false);
});

function loadFixDefinitions({ user }) {
  const routePath = require.resolve('../routes/admin/fix-definitions');
  const corePath = require.resolve('../data-store/core');
  const authPath = require.resolve('../middleware/auth');
  const dictionaryPath = require.resolve('../services/dictionary');
  const curationPath = require.resolve('../services/dictionary/curation');
  const saved = saveCache([routePath, corePath, authPath, dictionaryPath, curationPath]);
  const curation = makeBoundaryCuration([{
    id: 7, word: 'alpha', word_lowercase: 'alpha', definitions: null, phonetic: null, content_revision: 2,
  }]);
  const state = { queries: 0, directWordWrites: 0, dictionaryOptions: [] };
  cacheModule(corePath, {
    pool: {
      async query(sql) {
        state.queries++;
        const normalized = String(sql).trim().replace(/\s+/g, ' ');
        if (directWordMutation(normalized)) {
          state.directWordWrites++;
          throw new Error('DIRECT_WORD_MUTATION_BYPASSED_CURATION');
        }
        if (/COUNT\(\*\)/i.test(normalized)) return { rows: [{ count: '0' }], rowCount: 1 };
        if (/FROM words/i.test(normalized)) return { rows: [...curation.records.values()].map((record) => structuredClone(record)), rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    },
  });
  cacheModule(authPath, { authenticate: async () => user });
  cacheModule(dictionaryPath, {
    lookup: async (_word, options = {}) => {
      state.dictionaryOptions.push(structuredClone(options));
      return ({
      entry: {
        word: 'alpha',
        phonetic: '/ˈælfə/',
        meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'The first letter.' }] }],
      },
      });
    },
  });
  cacheModule(curationPath, { createCurationService: () => curation.service });
  delete require.cache[routePath];
  const route = require(routePath);
  return { route, curation, state, restore: () => restoreCache(saved) };
}

test('fix-definitions requires existing admin auth and supports curation dry-run/apply responses', async (t) => {
  const denied = loadFixDefinitions({ user: { id: 3, is_admin: false } });
  const deniedRes = responseDouble();
  await denied.route.handleFixDefinitions(requestDouble('POST', '/admin/fix-definitions'), deniedRes);
  denied.restore();
  assert.equal(deniedRes.statusCode, 403);
  assert.equal(denied.state.queries, 0);

  const allowed = loadFixDefinitions({ user: { id: 9, is_admin: true } });
  t.after(allowed.restore);
  const dryRes = responseDouble();
  await allowed.route.handleFixDefinitions(requestDouble('POST', '/admin/fix-definitions?limit=1&dry_run=1'), dryRes);
  assert.equal(dryRes.statusCode, 200);
  assert.equal(dryRes.body.success, true);
  assert.equal(dryRes.body.dry_run, true);
  assert.equal(dryRes.body.results.fixed, 0);
  assert.equal(allowed.curation.state.applies.length, 0);
  assert.equal(allowed.state.directWordWrites, 0);
  assert.equal(allowed.state.dictionaryOptions[0].persist, false);

  const applyRes = responseDouble();
  await allowed.route.handleFixDefinitions(requestDouble('POST', '/admin/fix-definitions?limit=1'), applyRes);
  assert.equal(applyRes.statusCode, 200);
  assert.equal(applyRes.body.results.fixed, 1);
  assert.ok(applyRes.body.batch_ids.length >= 1);
  assert.equal(allowed.curation.state.applies[0].source, 'dictionary_external');
  assert.equal(allowed.state.directWordWrites, 0);
  assert.equal(allowed.state.dictionaryOptions[1].persist, true);
});

function loadTranslation({ dbCache = null, deepLResult = '测试译文' } = {}) {
  const translationPath = require.resolve('../services/translation');
  const dataStorePath = require.resolve('../data-store');
  const cachePath = require.resolve('../services/translation/cache');
  const rateLimiterPath = require.resolve('../services/translation/rate-limiter');
  const providerPaths = [
    require.resolve('../services/translation/providers/openai'),
    require.resolve('../services/translation/providers/deepl'),
    require.resolve('../services/translation/providers/google'),
    require.resolve('../services/translation/providers/libretranslate'),
    require.resolve('../services/translation/providers/mymemory'),
  ];
  const saved = saveCache([translationPath, dataStorePath, cachePath, rateLimiterPath, ...providerPaths]);
  const state = { cacheWrites: 0, cacheDeletes: 0 };
  cacheModule(dataStorePath, {
    isDatabaseAvailable: () => true,
    getTranslationCache: async () => dbCache,
    upsertTranslationCache: async () => { state.cacheWrites++; },
    query: async () => { state.cacheDeletes++; return { rows: [], rowCount: 0 }; },
  });
  cacheModule(cachePath, {
    getFromCache: () => null,
    setInCache: () => { state.cacheWrites++; },
    deleteFromCache: () => { state.cacheDeletes++; },
  });
  cacheModule(rateLimiterPath, { isDisabled: () => false, recordSuccess() {}, recordFailure() {} });
  cacheModule(providerPaths[0], { translateWithOpenAI: async () => 'OpenAI译文' });
  cacheModule(providerPaths[1], { translateWithDeepL: async () => deepLResult });
  cacheModule(providerPaths[2], { translateWithGoogle: async () => null });
  cacheModule(providerPaths[3], { translateWithLibreTranslate: async () => null });
  cacheModule(providerPaths[4], { translateWithMyMemory: async () => null });
  delete require.cache[translationPath];
  const service = require(translationPath);
  return { service, state, restore: () => restoreCache(saved) };
}

function loadDictionary({ dbCache = null } = {}) {
  const dictionaryPath = require.resolve('../services/dictionary');
  const dataStorePath = require.resolve('../data-store');
  const saved = saveCache([dictionaryPath, dataStorePath]);
  const state = { dbCache, cacheWrites: 0 };
  cacheModule(dataStorePath, {
    isDatabaseAvailable: () => true,
    getDictionaryCache: async () => state.dbCache,
    upsertDictionaryCache: async () => { state.cacheWrites++; },
  });
  delete require.cache[dictionaryPath];
  const service = require(dictionaryPath);
  return { service, state, restore: () => restoreCache(saved) };
}

test('translation returns source/score and marks DeepL plus unknown cache content for review', async (t) => {
  const unknownCache = loadTranslation({ dbCache: { translation: '缓存译文', source: null } });
  const cached = await unknownCache.service.translateWord('quizzaciously');
  unknownCache.restore();
  assert.equal(cached.translation, '缓存译文');
  assert.equal(cached.source, 'legacy');
  assert.equal(cached.fromCache, true);
  assert.equal(cached.needsReview, true);
  assert.ok(Number.isFinite(cached.score));
  assert.ok(cached.score < 80);

  const deepl = loadTranslation({ dbCache: null, deepLResult: '深度翻译' });
  t.after(deepl.restore);
  const translated = await deepl.service.translateWord('quizzaciously');
  assert.equal(translated.translation, '深度翻译');
  assert.equal(translated.source, 'deepl');
  assert.equal(translated.fromCache, false);
  assert.equal(translated.needsReview, true);
  assert.ok(Number.isFinite(translated.score));
});

test('translation persist=false remains read-only across memory and database caches', async (t) => {
  const loaded = loadTranslation({ dbCache: null, deepLResult: '只读译文' });
  t.after(loaded.restore);

  const translated = await loaded.service.translateWord('quizzaciously', { persist: false, userLabel: 'dry-run' });

  assert.equal(translated.translation, '只读译文');
  assert.equal(loaded.state.cacheWrites, 0);
  assert.equal(loaded.state.cacheDeletes, 0);
});

test('dictionary persist=false does not populate memory or database caches', async (t) => {
  const loaded = loadDictionary({
    dbCache: {
      entry: {
        word: 'good',
        meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: '(of people)' }] }],
      },
    },
  });
  t.after(loaded.restore);

  const dryRun = await loaded.service.lookup('good', { persist: false });
  assert.equal(dryRun.fromCache, false);
  assert.equal(loaded.state.cacheWrites, 0);

  loaded.state.dbCache = {
    entry: {
      word: 'good',
      origin: 'second-database-read',
      meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: 'Of high quality.' }] }],
    },
  };
  const nextLookup = await loaded.service.lookup('good');
  assert.equal(nextLookup.entry.origin, 'second-database-read', 'read-only lookup must not leave a memory-cache entry');
  assert.equal(loaded.state.cacheWrites, 0, 'database cache hits do not rewrite the database cache');
});

test('admin UI renders curation source, reasons, batch, dry-run, and conflicts through its existing page', () => {
  const htmlPath = path.resolve(__dirname, '../../frontend/admin-translations.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  for (const id of ['quality-source', 'quality-reasons', 'quality-batch-id', 'quality-dry-run', 'quality-conflicts']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }
  const scriptMatch = html.match(/<script[^>]+id=["']dictionary-quality-ui["'][^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(scriptMatch, 'dictionary quality UI behavior script must exist');
  const context = { window: {} };
  vm.runInNewContext(scriptMatch[1], context, { filename: 'dictionary-quality-ui.inline.js' });
  const summary = context.window.DictionaryQualityUI.summarize({
    source: 'legacy',
    reasons: ['unreviewed_source'],
    batch_id: 'batch-4b',
    dry_run: true,
    conflicts: [{ field: 'phonetic', reason: 'verified_field_protected' }],
  });
  assert.deepEqual({ ...summary }, {
    source: 'legacy',
    reasons: ['unreviewed_source'],
    batchId: 'batch-4b',
    dryRun: true,
    conflicts: [{ field: 'phonetic', reason: 'verified_field_protected' }],
  });
});
