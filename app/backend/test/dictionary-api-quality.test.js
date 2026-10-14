const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const fixtures = require('./fixtures/dictionary-quality-cases.json');

function responseDouble() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(payload) { this.body = payload ? JSON.parse(String(payload)) : null; },
  };
}

function loadDictionaryRoute({ lookup, records, translations = {} }) {
  const routePath = require.resolve('../routes/dictionary-api');
  const authPath = require.resolve('../middleware/auth');
  const dictionaryPath = require.resolve('../services/dictionary');
  const dataStorePath = require.resolve('../data-store');
  const translationPath = require.resolve('../services/translation');
  const curationPath = require.resolve('../services/dictionary/curation');
  const saved = new Map([authPath, dictionaryPath, dataStorePath, translationPath, curationPath, routePath].map((key) => [key, require.cache[key]]));
  const queries = [];
  const calls = { translate: 0, writes: 0, curations: [] };

  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { authenticate: async () => ({ id: 9, username: 'tester' }) } };
  require.cache[dictionaryPath] = { id: dictionaryPath, filename: dictionaryPath, loaded: true, exports: { lookup } };
  require.cache[dataStorePath] = {
    id: dataStorePath,
    filename: dataStorePath,
    loaded: true,
    exports: {
      pool: {
        async query(sql, params) {
          queries.push(sql);
          if (/FROM words WHERE word_lowercase/.test(sql)) {
            const record = records[String(params[0]).toLowerCase()];
            return { rows: record ? [structuredClone(record)] : [] };
          }
          if (/^(?:INSERT|UPDATE|DELETE)\b/i.test(String(sql).trim())) {
            calls.writes++;
            return { rows: [] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      },
      async getTranslationCache(value) { return translations[String(value).toLowerCase()] || null; },
    },
  };
  require.cache[translationPath] = {
    id: translationPath,
    filename: translationPath,
    loaded: true,
    exports: {
      async translateWord() { calls.translate++; return { translation: '机器译文', source: 'deepl', score: 82, needsReview: true }; },
      postEditZh(_english, chinese) { return chinese; },
    },
  };
  require.cache[curationPath] = {
    id: curationPath,
    filename: curationPath,
    loaded: true,
    exports: {
      createCurationService: () => ({
        async apply({ write, actor }) {
          calls.curations.push({ write: structuredClone(write), actor: structuredClone(actor) });
          const key = String(write.word || '').toLowerCase();
          const before = write.id
            ? Object.values(records).find((record) => Number(record.id) === Number(write.id))
            : records[key];
          return {
            applied: 1,
            batch_id: '00000000-0000-4000-8000-000000000777',
            source: 'legacy',
            reasons: ['unreviewed_source'],
            conflicts: [],
            before: before ? structuredClone(before) : null,
            after: {
              ...(before || {}),
              ...(write.candidate || {}),
              id: before?.id || 777,
              word: write.candidate?.word || before?.word || write.word,
              word_lowercase: write.candidate?.word_lowercase || before?.word_lowercase || key,
              quality_status: 'review',
              seo_indexable: false,
            },
          };
        },
      }),
    },
  };
  delete require.cache[routePath];
  const route = require(routePath);

  return {
    route,
    queries,
    calls,
    restore() {
      for (const [key, entry] of saved) {
        if (entry) require.cache[key] = entry;
        else delete require.cache[key];
      }
    },
  };
}

function loadRealDictionaryRoute(apiPayload) {
  const routePath = require.resolve('../routes/dictionary-api');
  const authPath = require.resolve('../middleware/auth');
  const dictionaryPath = require.resolve('../services/dictionary');
  const dataStorePath = require.resolve('../data-store');
  const translationPath = require.resolve('../services/translation');
  const saved = new Map([authPath, dictionaryPath, dataStorePath, translationPath, routePath].map((key) => [key, require.cache[key]]));
  const originalHttpsGet = https.get;
  const calls = { dictionaryCacheWrites: 0, translate: 0, wordsWrites: 0 };

  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { authenticate: async () => ({ id: 9, username: 'tester' }) } };
  require.cache[dataStorePath] = {
    id: dataStorePath,
    filename: dataStorePath,
    loaded: true,
    exports: {
      isDatabaseAvailable: () => true,
      async getDictionaryCache() { return null; },
      async upsertDictionaryCache() { calls.dictionaryCacheWrites++; },
      async getTranslationCache() { return null; },
      pool: {
        async query(sql) {
          if (/FROM words WHERE word_lowercase/.test(sql)) return { rows: [] };
          if (/^(?:INSERT|UPDATE|DELETE)\b/i.test(String(sql).trim())) {
            calls.wordsWrites++;
            return { rows: [] };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      },
    },
  };
  require.cache[translationPath] = {
    id: translationPath,
    filename: translationPath,
    loaded: true,
    exports: {
      async translateWord() { calls.translate++; return { translation: '不应调用' }; },
      postEditZh(_english, chinese) { return chinese; },
    },
  };
  https.get = (_options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.resume = () => {};
      callback(response);
      process.nextTick(() => {
        response.emit('data', Buffer.from(JSON.stringify(apiPayload)));
        response.emit('end');
      });
    });
    return request;
  };

  delete require.cache[dictionaryPath];
  delete require.cache[routePath];
  const route = require(routePath);
  return {
    calls,
    route,
    restore() {
      https.get = originalHttpsGet;
      for (const [key, entry] of saved) {
        if (entry) require.cache[key] = entry;
        else delete require.cache[key];
      }
    },
  };
}

test('dictionary API preserves entry/zh while rejecting an unproven DB phonetic and adding field quality', async (t) => {
  const meeting = fixtures.meeting;
  const loaded = loadDictionaryRoute({
    lookup: async () => ({ entry: structuredClone(meeting.externalEntry), fromCache: false }),
    records: {
      meeting: {
        ...meeting.dbRecord,
        definitions: {
          meanings: meeting.externalEntry.meanings.map((meaning) => ({
            ...meaning,
            definitions: meaning.definitions.map((definition) => ({ ...definition, zh: '会议' })),
          })),
        },
      },
    },
  });
  t.after(loaded.restore);

  const req = { method: 'GET', headers: {} };
  const res = responseDouble();
  await loaded.route.registerDictionaryRoutes('/dictionary/meeting', req, res, new URL('http://test/dictionary/meeting'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.entry.phonetic, meeting.expectedApiPhonetic);
  assert.deepEqual(res.body.entry.phonetics, [{ text: meeting.expectedApiPhonetic }]);
  assert.equal(res.body.zh, '');
  assert.equal(res.body.quality.fields.phonetic.source, 'external');
  assert.equal(res.body.quality.content_revision, 4);
});

test('legacy translations enter resolution as sourced candidates without post-render mutation', async (t) => {
  const externalEntry = {
    word: 'provenance',
    phonetic: '/ˈprɒvənəns/',
    meanings: [{
      partOfSpeech: 'noun',
      definitions: [{
        definition: 'The origin or history of something.',
        zh: '正确来源',
        example: 'The painting has a documented provenance.',
        exampleZh: '这幅画有记录完整的来源。',
      }],
    }],
    origin: 'dictionary-api',
  };
  const loaded = loadDictionaryRoute({
    lookup: async () => ({ entry: structuredClone(externalEntry), fromCache: false }),
    records: {
      provenance: {
        id: 301,
        word: 'provenance',
        word_lowercase: 'provenance',
        phonetic: 'ˈprɒvənəns',
        definitions: { meanings: [{
          partOfSpeech: 'noun',
          definitions: [{
            definition: 'The origin or history of something.',
            zh: '错误旧译',
            example: 'The painting has a documented provenance.',
            exampleZh: '错误旧例句',
          }],
        }] },
        content_revision: 2,
        quality_status: 'review',
        seo_indexable: false,
      },
    },
  });
  t.after(loaded.restore);

  const res = responseDouble();
  await loaded.route.registerDictionaryRoutes(
    '/dictionary/provenance',
    { method: 'GET', headers: {} },
    res,
    new URL('http://test/dictionary/provenance'),
  );

  assert.equal(res.statusCode, 200);
  const definition = res.body.entry.meanings[0].definitions[0];
  assert.equal(definition.zh, '正确来源');
  assert.equal(definition.exampleZh, '这幅画有记录完整的来源。');
  const itemQuality = res.body.quality.fields.definitions.meta.items[0];
  assert.equal(itemQuality.definition_source, 'external');
  assert.equal(itemQuality.zh_source, 'external');
  assert.equal(itemQuality.example_source, 'external');
  assert.equal(itemQuality.example_zh_source, 'external');
});

test('trusted DB translations can win per definition and example with matching provenance', async (t) => {
  const externalEntry = {
    word: 'trusted',
    phonetic: '/ˈtrʌstɪd/',
    meanings: [{ partOfSpeech: 'adjective', definitions: [{
      definition: 'Regarded as reliable.',
      zh: '外部翻译',
      example: 'She is a trusted adviser.',
      exampleZh: '她是一名外部顾问。',
    }] }],
    origin: 'dictionary-api',
  };
  const loaded = loadDictionaryRoute({
    lookup: async () => ({ entry: structuredClone(externalEntry), fromCache: false }),
    records: {
      trusted: {
        id: 302,
        word: 'trusted',
        word_lowercase: 'trusted',
        phonetic: 'ˈtrʌstɪd',
        definitions: { meanings: [{ partOfSpeech: 'adjective', definitions: [{
          definition: 'Regarded as reliable.',
          zh: '人工可信翻译',
          example: 'She is a trusted adviser.',
          exampleZh: '她是一位可信赖的顾问。',
        }] }] },
        definitions_source: 'external',
        zh_source: 'manual_verified',
        content_revision: 3,
        quality_status: 'review',
        seo_indexable: false,
      },
    },
  });
  t.after(loaded.restore);

  const res = responseDouble();
  await loaded.route.registerDictionaryRoutes('/dictionary/trusted', { method: 'GET', headers: {} }, res, new URL('http://test/dictionary/trusted'));
  const definition = res.body.entry.meanings[0].definitions[0];
  const itemQuality = res.body.quality.fields.definitions.meta.items[0];
  assert.equal(definition.zh, '人工可信翻译');
  assert.equal(definition.exampleZh, '她是一位可信赖的顾问。');
  assert.equal(itemQuality.zh_source, 'manual_verified');
  assert.equal(itemQuality.example_zh_source, 'manual_verified');
});

test('mixed trusted and legacy definition translations downgrade item, field, and overall quality', async (t) => {
  const definitions = [
    { definition: 'The first rendered sense.', zh: '第一条可信释义' },
    { definition: 'The second rendered sense.' },
  ];
  const loaded = loadDictionaryRoute({
    lookup: async () => ({
      fromCache: false,
      entry: {
        word: 'mixed-zh',
        phonetic: '/mɪkst/',
        meanings: [{ partOfSpeech: 'adjective', definitions }],
        origin: 'dictionary-api',
      },
    }),
    records: {
      'mixed-zh': {
        id: 303,
        word: 'mixed-zh',
        word_lowercase: 'mixed-zh',
        phonetic: 'mɪkst',
        definitions: { meanings: [{ partOfSpeech: 'adjective', definitions: [
          { ...definitions[0], zh: '第一条旧译' },
          { ...definitions[1], zh: '第二条旧译' },
        ] }] },
        definitions_source: 'external',
        zh_source: 'legacy',
        content_revision: 1,
        quality_status: 'review',
        seo_indexable: false,
      },
    },
  });
  t.after(loaded.restore);

  const res = responseDouble();
  await loaded.route.registerDictionaryRoutes('/dictionary/mixed-zh', { method: 'GET', headers: {} }, res, new URL('http://test/dictionary/mixed-zh'));

  const rendered = res.body.entry.meanings[0].definitions;
  assert.deepEqual(rendered.map((item) => item.zh), ['第一条可信释义', '第二条旧译']);
  assert.equal(res.body.quality.fields.zh.source, 'mixed');
  assert.equal(res.body.quality.fields.zh.status, 'review');
  assert.equal(res.body.quality.fields.zh.score, 78);
  assert.deepEqual(res.body.quality.fields.zh.reasons, ['unverified_zh_translation']);
  assert.deepEqual(res.body.quality.fields.zh.meta.items, [
    { meaning_index: 0, definition_index: 0, source: 'external', status: 'verified', score: 100, reasons: [] },
    { meaning_index: 0, definition_index: 1, source: 'legacy', status: 'review', score: 55, reasons: ['unverified_zh_translation'] },
  ]);
  assert.equal(res.body.quality.fields.definitions.meta.items[0].zh_status, 'verified');
  assert.equal(res.body.quality.fields.definitions.meta.items[1].zh_status, 'review');
  assert.equal(res.body.quality.status, 'review');
});

test('mixed trusted and legacy example translations downgrade their aggregate and overall quality', async (t) => {
  const definitions = [
    {
      definition: 'The first rendered example sense.',
      zh: '第一条例句释义',
      example: 'This is the first rendered example.',
      exampleZh: '这是第一条可信例句。',
    },
    {
      definition: 'The second rendered example sense.',
      zh: '第二条例句释义',
      example: 'This is the second rendered example.',
    },
  ];
  const loaded = loadDictionaryRoute({
    lookup: async () => ({
      fromCache: false,
      entry: {
        word: 'mixed-example-zh',
        phonetic: '/ɪɡˈzɑːmpəl/',
        meanings: [{ partOfSpeech: 'noun', definitions }],
        origin: 'dictionary-api',
      },
    }),
    records: {
      'mixed-example-zh': {
        id: 304,
        word: 'mixed-example-zh',
        word_lowercase: 'mixed-example-zh',
        phonetic: 'ɪɡˈzɑːmpəl',
        definitions: { meanings: [{ partOfSpeech: 'noun', definitions: [
          { ...definitions[0], exampleZh: '这是第一条旧例句。' },
          { ...definitions[1], exampleZh: '这是第二条旧例句。' },
        ] }] },
        definitions_source: 'external',
        zh_source: 'legacy',
        content_revision: 1,
        quality_status: 'review',
        seo_indexable: false,
      },
    },
  });
  t.after(loaded.restore);

  const res = responseDouble();
  await loaded.route.registerDictionaryRoutes('/dictionary/mixed-example-zh', { method: 'GET', headers: {} }, res, new URL('http://test/dictionary/mixed-example-zh'));

  const rendered = res.body.entry.meanings[0].definitions;
  assert.deepEqual(rendered.map((item) => item.exampleZh), ['这是第一条可信例句。', '这是第二条旧例句。']);
  assert.equal(res.body.quality.fields.example_zh.source, 'mixed');
  assert.equal(res.body.quality.fields.example_zh.status, 'review');
  assert.equal(res.body.quality.fields.example_zh.score, 78);
  assert.deepEqual(res.body.quality.fields.example_zh.reasons, ['unverified_example_zh_translation']);
  assert.deepEqual(res.body.quality.fields.example_zh.meta.items.map((item) => ({ source: item.source, status: item.status })), [
    { source: 'external', status: 'verified' },
    { source: 'legacy', status: 'review' },
  ]);
  assert.equal(res.body.quality.fields.definitions.meta.items[0].example_zh_status, 'verified');
  assert.equal(res.body.quality.fields.definitions.meta.items[1].example_zh_status, 'review');
  assert.equal(res.body.quality.status, 'review');
});

test('controlled fallback and curated reads preserve metadata/audio and make zero translator or DB writes', async (t) => {
  for (const [word, origin] of [['wanna-zero-write', 'linglish-fallback'], ['curated-zero-write', 'linglish-curated']]) {
    const loaded = loadDictionaryRoute({
      lookup: async () => ({
        fromCache: false,
        entry: {
          word,
          phonetic: '/ˈwɒnə/',
          phonetics: [{ text: '/ˈwɒnə/', audio: `https://audio.example/${word}.mp3` }],
          meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'A controlled definition.' }] }],
          origin,
          license: { name: 'Controlled content' },
          sourceUrls: [`https://source.example/${word}`],
        },
      }),
      records: {},
    });
    t.after(loaded.restore);
    const res = responseDouble();
    await loaded.route.registerDictionaryRoutes(`/dictionary/${word}`, { method: 'GET', headers: {} }, res, new URL(`http://test/dictionary/${word}`));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.statusCode, 200, word);
    assert.equal(res.body.entry.origin, origin, word);
    assert.deepEqual(res.body.entry.license, { name: 'Controlled content' }, word);
    assert.deepEqual(res.body.entry.sourceUrls, [`https://source.example/${word}`], word);
    assert.deepEqual(res.body.entry.phonetics, [{ text: '/ˈwɒnə/', audio: `https://audio.example/${word}.mp3` }], word);
    assert.equal(loaded.calls.translate, 0, word);
    assert.equal(loaded.calls.writes, 0, word);
  }
});

test('actual fallback and curated GET paths perform no translator, words, or dictionary-cache writes', async (t) => {
  const loaded = loadRealDictionaryRoute([{
    word: 'good',
    phonetic: '/ɡʊd/',
    meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: '(of people)' }] }],
  }]);
  t.after(loaded.restore);

  for (const [word, origin] of [['good', 'linglish-fallback'], ['meeting', 'linglish-curated']]) {
    const res = responseDouble();
    await loaded.route.registerDictionaryRoutes(`/dictionary/${word}`, { method: 'GET', headers: {} }, res, new URL(`http://test/dictionary/${word}`));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(res.statusCode, 200, word);
    assert.equal(res.body.entry.origin, origin, word);
    assert.deepEqual(loaded.calls, { dictionaryCacheWrites: 0, translate: 0, wordsWrites: 0 }, word);
  }
});

test('API noindexes a current verified record with an untrusted example translation', async (t) => {
  const definitions = [{
    definition: 'A provenance-sensitive example.',
    example: 'This example is shown publicly.',
    exampleZh: '这是未验证的公开例句。',
  }];
  const loaded = loadDictionaryRoute({
    lookup: async () => {
      const error = new Error('WORD_NOT_FOUND');
      error.statusCode = 404;
      throw error;
    },
    records: {
      'example-provenance': {
        id: 305,
        word: 'example-provenance',
        word_lowercase: 'example-provenance',
        phonetic: 'prəˈvenəns',
        definitions,
        phonetic_source: 'batch_verified',
        definitions_source: 'batch_verified',
        zh_source: 'legacy',
        quality_status: 'verified',
        quality_score: 100,
        quality_reasons: [],
        content_revision: 2,
        quality_checked_revision: 2,
        quality_checked_at: '2026-08-22T00:00:00.000Z',
        seo_indexable: true,
      },
    },
  });
  t.after(loaded.restore);

  const res = responseDouble();
  await loaded.route.registerDictionaryRoutes('/dictionary/example-provenance', { method: 'GET', headers: {} }, res, new URL('http://test/dictionary/example-provenance'));
  assert.equal(res.body.entry.meanings[0].definitions[0].exampleZh, '这是未验证的公开例句。');
  assert.equal(res.body.quality.fields.example_zh.status, 'review');
  assert.equal(res.body.quality.seo_indexable, false);
});

test('top-level zh compatibility value carries its own final response provenance', async (t) => {
  const loaded = loadDictionaryRoute({
    lookup: async () => ({
      fromCache: false,
      entry: {
        word: 'response-zh',
        phonetic: '/rɪˈspɒns/',
        meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A response.' }] }],
        origin: 'dictionary-api',
      },
    }),
    records: {},
    translations: {
      'response-zh': { translation: '词级译文', source: 'legacy-provider', updated_at: '2026-08-22T00:00:00.000Z' },
    },
  });
  t.after(loaded.restore);
  const res = responseDouble();
  await loaded.route.registerDictionaryRoutes('/dictionary/response-zh', { method: 'GET', headers: {} }, res, new URL('http://test/dictionary/response-zh'));
  assert.equal(res.body.zh, '词级译文');
  assert.deepEqual(res.body.quality.response.zh, {
    source: 'legacy',
    status: 'review',
    score: 55,
    reasons: ['unverified_legacy'],
    meta: { provider: 'legacy-provider', updated_at: '2026-08-22T00:00:00.000Z' },
  });
});

test('automatic and user-triggered definition translations write only through curation', async (t) => {
  const loaded = loadDictionaryRoute({
    lookup: async () => ({
      fromCache: false,
      entry: {
        word: 'machinewrite',
        phonetic: '/məˈʃiːnraɪt/',
        meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A generated definition.' }] }],
        origin: 'dictionary-api',
      },
    }),
    records: {
      machinewrite: {
        id: 777,
        word: 'machinewrite',
        word_lowercase: 'machinewrite',
        definitions: { meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A generated definition.' }] }] },
        content_revision: 5,
        quality_status: 'review',
        seo_indexable: false,
      },
      manualwrite: {
        id: 778,
        word: 'manualwrite',
        word_lowercase: 'manualwrite',
        definitions: { meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A manual definition.' }] }] },
        content_revision: 2,
        quality_status: 'review',
        seo_indexable: false,
      },
    },
  });
  t.after(loaded.restore);

  const getRes = responseDouble();
  await loaded.route.registerDictionaryRoutes(
    '/dictionary/machinewrite',
    { method: 'GET', headers: {} },
    getRes,
    new URL('http://test/dictionary/machinewrite'),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const postReq = Readable.from([Buffer.from(JSON.stringify({
    meaningIndex: 0,
    definitionIndex: 0,
    text: 'A manual definition.',
    type: 'definition',
  }))]);
  postReq.method = 'POST';
  postReq.headers = {};
  const postRes = responseDouble();
  await loaded.route.registerDictionaryRoutes(
    '/dictionary/manualwrite/translate-definition',
    postReq,
    postRes,
    new URL('http://test/dictionary/manualwrite/translate-definition'),
  );

  assert.equal(getRes.statusCode, 200);
  assert.equal(postRes.statusCode, 200);
  assert.equal(loaded.calls.writes, 0, 'dictionary routes must never mutate words directly');
  assert.equal(loaded.calls.curations.length, 2);
  assert.deepEqual(loaded.calls.curations.map(({ write, actor }) => ({
    source: write.source,
    reviewed: write.reviewed,
    expectedRevision: write.expected_revision,
    actorType: actor.type,
  })), [
    { source: 'deepl', reviewed: false, expectedRevision: 5, actorType: 'system' },
    { source: 'deepl', reviewed: false, expectedRevision: 2, actorType: 'user' },
  ]);
  assert.equal(postRes.body.success, true);
  assert.equal(postRes.body.batch_id, '00000000-0000-4000-8000-000000000777');
});

test('dictionary API builds a compatible review entry from legacy en/zh records', async (t) => {
  const loaded = loadDictionaryRoute({
    lookup: async () => {
      const error = new Error('WORD_NOT_FOUND');
      error.statusCode = 404;
      throw error;
    },
    records: {
      legacy: {
        id: 202,
        word: 'legacy',
        word_lowercase: 'legacy',
        phonetic: 'ˈleɡəsi',
        definitions: { en: 'Something handed down from the past.', zh: '遗产' },
        content_revision: 2,
        quality_status: 'review',
        seo_indexable: false,
      },
    },
  });
  t.after(loaded.restore);

  const req = { method: 'GET', headers: {} };
  const res = responseDouble();
  await loaded.route.registerDictionaryRoutes('/dictionary/legacy', req, res, new URL('http://test/dictionary/legacy'));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.entry.phonetic, '/ˈleɡəsi/');
  assert.equal(res.body.entry.meanings[0].definitions[0].definition, 'Something handed down from the past.');
  assert.equal(res.body.entry.meanings[0].definitions[0].zh, '遗产');
  assert.equal(res.body.quality.status, 'review');
  assert.equal(res.body.quality.seo_indexable, false);
  assert.equal(loaded.queries.some((sql) => /SELECT definitions FROM words WHERE id/.test(sql)), false);
});
