const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./fixtures/dictionary-quality-cases.json');

function qualityModule() {
  try {
    return require('../services/dictionary/quality');
  } catch (_) {
    return {};
  }
}

function curatedModule() {
  try {
    return require('../services/dictionary/curated-entries');
  } catch (_) {
    return {};
  }
}

test('normalizes stored IPA to NFC bare form and formats API IPA with slashes', () => {
  const { normalizePhonetic, formatPhoneticForApi } = qualityModule();
  assert.equal(typeof normalizePhonetic, 'function');
  assert.equal(typeof formatPhoneticForApi, 'function');

  const bare = normalizePhonetic(` /${fixtures.meeting.expectedBarePhonetic}/ `);
  assert.equal(bare, fixtures.meeting.expectedBarePhonetic);
  assert.equal(bare, bare.normalize('NFC'));
  assert.equal(formatPhoneticForApi(bare), fixtures.meeting.expectedApiPhonetic);
  assert.equal(normalizePhonetic('/miːtɪŋ2/'), '');
  assert.equal(normalizePhonetic('/miːtɪŋ'), '');
});

test('rejects non-IPA scripts, controls, and malformed optional pronunciation structure', () => {
  const { normalizePhonetic } = qualityModule();
  const rejected = [
    '会议',
    'встреча',
    'mi\nːtɪŋ',
    'mi\tːtɪŋ',
    'mi\u0000tɪŋ',
    '(miːtɪŋ',
    'miːtɪŋ)',
    'mi((t))ɪŋ',
    'mi()tɪŋ',
    '/miː[tɪŋ/',
  ];
  for (const value of rejected) {
    assert.equal(normalizePhonetic(value), '', JSON.stringify(value));
  }

  for (const value of ['ˈmiːtɪŋ', 'ðə', 'kənˈtrækt', 'ˈwɔːtə(r)', 'tʃaɪld', 'n̩']) {
    assert.equal(normalizePhonetic(value), value.normalize('NFC'), value);
  }
});

test('uses the shared validator corpus for exact IPA and definition acceptance boundaries', () => {
  const { normalizeDefinitions, normalizePhonetic } = qualityModule();
  for (const item of fixtures.validatorEquivalence.phonetics) {
    assert.equal(Boolean(normalizePhonetic(item.value)), item.accept, `phonetic: ${item.name}`);
  }
  for (const item of fixtures.validatorEquivalence.definitions) {
    assert.equal(normalizeDefinitions(item.value).length > 0, item.accept, `definitions: ${item.name}`);
  }
});

test('normalizes all legacy definition shapes without losing translations', () => {
  const { normalizeDefinitions } = qualityModule();
  assert.equal(typeof normalizeDefinitions, 'function');

  const array = normalizeDefinitions(fixtures.legacyDefinitions.array);
  assert.equal(array[0].definitions[0].definition, 'A planned gathering.');
  assert.equal(array[0].definitions[0].zh, '会议');
  assert.equal(array[0].definitions[1].definition, 'An encounter between people.');

  const enZh = normalizeDefinitions(fixtures.legacyDefinitions.enZh);
  assert.equal(enZh[0].definitions[0].definition, 'A planned gathering.');
  assert.equal(enZh[0].definitions[0].zh, '会议');
  assert.equal(enZh[0].definitions[1].zh, '会面');

  const meanings = normalizeDefinitions(fixtures.legacyDefinitions.meanings);
  assert.equal(meanings[0].partOfSpeech, 'noun');
  assert.equal(meanings[0].definitions[0].zh, '会议');
});

test('resolves every field by provenance so unverified DB IPA never beats valid external IPA', () => {
  const { resolveEntry } = qualityModule();
  assert.equal(typeof resolveEntry, 'function');

  const resolved = resolveEntry({
    word: 'meeting',
    dbRecord: fixtures.meeting.dbRecord,
    externalEntry: fixtures.meeting.externalEntry,
    curatedEntry: null,
  });

  assert.equal(resolved.storage.phonetic, fixtures.meeting.expectedBarePhonetic);
  assert.equal(resolved.entry.phonetic, fixtures.meeting.expectedApiPhonetic);
  assert.deepEqual(resolved.entry.phonetics, [{ text: fixtures.meeting.expectedApiPhonetic }]);
  assert.equal(resolved.quality.fields.phonetic.source, 'external');
  assert.notEqual(resolved.quality.fields.definitions.source, undefined);
});

test('manual or batch verified fields outrank curated and external candidates independently', () => {
  const { resolveEntry } = qualityModule();
  assert.equal(typeof resolveEntry, 'function');
  const resolved = resolveEntry({
    word: 'meeting',
    dbRecord: {
      ...fixtures.meeting.dbRecord,
      phonetic: 'ˈmiːtɪŋ',
      phonetic_source: 'manual_verified',
      definitions_source: 'legacy',
      part_of_speech: 'noun',
      part_of_speech_source: 'batch_verified',
    },
    externalEntry: fixtures.meeting.externalEntry,
    curatedEntry: {
      word: 'meeting',
      phonetic: 'ˈmiːtɪŋ',
      meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A meeting arranged in advance.' }] }],
    },
  });

  assert.equal(resolved.quality.fields.phonetic.source, 'manual_verified');
  assert.equal(resolved.quality.fields.definitions.source, 'curated');
  assert.equal(resolved.quality.fields.part_of_speech.source, 'batch_verified');
});

test('trusted word phonetics reject conflicts before ranking for every source tier', () => {
  const { getCuratedEntry } = curatedModule();
  const { resolveEntry } = qualityModule();
  const trusted = getCuratedEntry('meeting');

  for (const source of ['manual_verified', 'batch_verified']) {
    const resolved = resolveEntry({
      word: 'meeting',
      dbRecord: {
        word: 'meeting',
        word_lowercase: 'meeting',
        phonetic: 'mɛtɪŋ',
        phonetic_source: source,
      },
      curatedEntry: trusted,
    });
    assert.equal(resolved.storage.phonetic, 'ˈmiːtɪŋ', source);
    assert.equal(resolved.quality.fields.phonetic.source, 'curated', source);
    assert.ok(resolved.quality.fields.phonetic.meta.rejected.some((item) => (
      item.source === source && item.reason === 'phonetic_conflicts_trusted'
    )), source);
  }

  for (const [name, input] of [
    ['external', { externalEntry: { word: 'meeting', phonetic: 'mɛtɪŋ' } }],
    ['legacy', { legacyEntry: { word: 'meeting', phonetic: 'mɛtɪŋ' } }],
  ]) {
    const resolved = resolveEntry({ word: 'meeting', curatedEntry: trusted, ...input });
    assert.equal(resolved.storage.phonetic, 'ˈmiːtɪŋ', name);
    assert.equal(resolved.quality.fields.phonetic.source, 'curated', name);
    assert.ok(resolved.quality.fields.phonetic.meta.rejected.some((item) => item.source === name), name);
  }

  const malformedCurated = resolveEntry({
    word: 'meeting',
    curatedEntry: { word: 'meeting', phonetic: 'mɛtɪŋ', meanings: trusted.meanings },
  });
  assert.equal(malformedCurated.storage.phonetic, '');
  assert.equal(malformedCurated.quality.fields.phonetic.status, 'review');
});

test('preserves compatibility metadata and only audio owned by the winning phonetic candidate', () => {
  const { resolveEntry } = qualityModule();
  const externalEntry = {
    word: 'sample',
    phonetic: '/ˈsæmpəl/',
    phonetics: [{ text: '/ˈsæmpəl/', audio: 'https://audio.example/sample.mp3' }],
    meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A small representative part.' }] }],
    origin: 'dictionary-api',
    license: { name: 'Example license', url: 'https://license.example/' },
    sourceUrls: ['https://source.example/sample'],
  };
  const externalWins = resolveEntry({ word: 'sample', externalEntry });
  assert.equal(externalWins.entry.origin, externalEntry.origin);
  assert.deepEqual(externalWins.entry.license, externalEntry.license);
  assert.deepEqual(externalWins.entry.sourceUrls, externalEntry.sourceUrls);
  assert.deepEqual(externalWins.entry.phonetics, [{
    text: '/ˈsæmpəl/',
    audio: 'https://audio.example/sample.mp3',
  }]);

  const dbWins = resolveEntry({
    word: 'sample',
    dbRecord: {
      word: 'sample',
      word_lowercase: 'sample',
      phonetic: 'sɑːmpəl',
      phonetic_source: 'manual_verified',
    },
    externalEntry,
  });
  assert.equal(dbWins.entry.phonetic, '/sɑːmpəl/');
  assert.deepEqual(dbWins.entry.phonetics, [{ text: '/sɑːmpəl/' }]);
  assert.equal(dbWins.entry.origin, externalEntry.origin);

  const dbDefinitionsWin = resolveEntry({
    word: 'sample',
    dbRecord: {
      word: 'sample',
      word_lowercase: 'sample',
      definitions: [{ definition: 'A manually reviewed sample.' }],
      definitions_source: 'manual_verified',
    },
    externalEntry,
  });
  assert.equal(dbDefinitionsWin.quality.fields.definitions.source, 'manual_verified');
  assert.equal(dbDefinitionsWin.entry.origin, externalEntry.origin);
  assert.deepEqual(dbDefinitionsWin.entry.license, externalEntry.license);
  assert.deepEqual(dbDefinitionsWin.entry.sourceUrls, externalEntry.sourceUrls);
});

test('curated function words put the common learner meaning before archaic, domain, or rhythmic senses', () => {
  const { getCuratedEntry } = curatedModule();
  const { resolveEntry } = qualityModule();
  assert.equal(typeof getCuratedEntry, 'function');

  for (const [word, fixture] of Object.entries(fixtures.functionWords)) {
    const externalEntry = {
      word,
      phonetic: word === 'the' ? '/ðə/' : word === 'and' ? '/ænd/' : '/hæv/',
      meanings: [{
        partOfSpeech: 'unknown',
        definitions: fixture.noisyDefinitions.map((definition) => ({ definition })),
      }],
    };
    const resolved = resolveEntry({ word, externalEntry, curatedEntry: getCuratedEntry(word) });
    assert.equal(resolved.entry.meanings[0].definitions[0].definition, fixture.expectedFirst, word);
    assert.equal(resolved.quality.fields.definitions.source, 'curated', word);
  }
});

test('assesses SEO eligibility from provenance, current revision, status, and stored IPA', () => {
  const { assessWordRecord } = qualityModule();
  assert.equal(typeof assessWordRecord, 'function');

  const eligible = {
    id: 7,
    word: 'meeting',
    word_lowercase: 'meeting',
    phonetic: 'ˈmiːtɪŋ',
    definitions: fixtures.meeting.externalEntry.meanings,
    part_of_speech: 'noun',
    content_revision: 5,
    phonetic_source: 'batch_verified',
    definitions_source: 'batch_verified',
    part_of_speech_source: 'batch_verified',
    quality_status: 'verified',
    quality_score: 100,
    quality_reasons: [],
    quality_checked_revision: 5,
    quality_checked_at: '2026-08-22T00:00:00.000Z',
    seo_indexable: true,
  };
  assert.equal(assessWordRecord(eligible).seo_indexable, true);

  const cases = [
    [{ ...eligible, definitions_source: null }, 'missing_definitions_provenance'],
    [{ ...eligible, quality_checked_revision: 4 }, 'stale_quality_revision'],
    [{ ...eligible, phonetic: '/ˈmiːtɪŋ/' }, 'phonetic_not_bare'],
    [{ ...eligible, phonetic: 'mɛtɪŋ' }, 'phonetic_conflicts_curated'],
    [{ ...eligible, quality_status: 'review' }, 'quality_review'],
    [{ ...eligible, phonetic_source: 'garbage' }, 'unsupported_phonetic_source'],
    [{ ...eligible, quality_score: 79 }, 'quality_score_below_minimum'],
    [{ ...eligible, quality_reasons: ['failed_review'] }, 'persisted_rejection_reason'],
    [{ ...eligible, phonetic: '会议' }, 'invalid_phonetic'],
    [{ ...eligible, phonetic: 'ˈmiːtɪŋ\n' }, 'invalid_phonetic'],
    [{ ...eligible, definitions: [] }, 'missing_definitions'],
  ];
  for (const [record, reason] of cases) {
    const assessment = assessWordRecord(record);
    assert.equal(assessment.seo_indexable, false, reason);
    assert.ok(assessment.reasons.includes(reason), `${reason}: ${assessment.reasons.join(',')}`);
  }
});

test('translation provenance covers every accepted definition container and example alias', () => {
  const { assessWordRecord, normalizeDefinitions } = qualityModule();
  const base = {
    word: 'provenance-shape',
    word_lowercase: 'provenance-shape',
    phonetic: 'prəˈvenəns',
    definitions_source: 'batch_verified',
    phonetic_source: 'batch_verified',
    quality_status: 'verified',
    quality_score: 100,
    quality_reasons: [],
    content_revision: 7,
    quality_checked_revision: 7,
    quality_checked_at: '2026-08-22T00:00:00.000Z',
    seo_indexable: true,
  };
  const cases = [
    {
      name: 'flat definition array with exampleZh',
      definitions: [{ definition: 'A flat definition.', example: 'A flat example.', exampleZh: '一个扁平例句。' }],
      zh_source: null,
      reason: 'missing_zh_provenance',
    },
    {
      name: 'en/zh container',
      definitions: { en: 'An en/zh definition.', zh: '一个中英文释义。' },
      zh_source: 'legacy',
      reason: 'untrusted_zh_source',
    },
    {
      name: 'meanings container with example_zh',
      definitions: { meanings: [{ definitions: [{ definition: 'A meanings definition.', example: 'A meanings example.', example_zh: '一个 meanings 例句。' }] }] },
      zh_source: null,
      reason: 'missing_zh_provenance',
    },
    {
      name: 'definitions container with examplesZh',
      definitions: { definitions: [{ definition: 'A definitions definition.', example: 'A definitions example.', examplesZh: ['一个 definitions 例句。'] }] },
      zh_source: 'legacy',
      reason: 'untrusted_zh_source',
    },
    {
      name: 'one-level serialized JSON',
      definitions: JSON.stringify({ en: 'A serialized definition.', zh: '一个序列化释义。' }),
      zh_source: null,
      reason: 'missing_zh_provenance',
    },
    {
      name: 'embedded en item with zh',
      definitions: { en: [{ definition: 'An embedded definition.', zh: '一个嵌入式释义。' }] },
      zh_source: null,
      reason: 'missing_zh_provenance',
    },
    {
      name: 'embedded en item with exampleZh',
      definitions: { en: [{ definition: 'An embedded example.', exampleZh: '一个嵌入式例句。' }] },
      zh_source: 'legacy',
      reason: 'untrusted_zh_source',
    },
  ];

  for (const item of cases) {
    assert.ok(normalizeDefinitions(item.definitions).length > 0, item.name);
    const assessment = assessWordRecord({ ...base, definitions: item.definitions, zh_source: item.zh_source });
    assert.equal(assessment.fields.zh.valid, true, item.name);
    assert.equal(assessment.seo_indexable, false, item.name);
    assert.ok(assessment.reasons.includes(item.reason), `${item.name}: ${assessment.reasons.join(',')}`);
  }
});
