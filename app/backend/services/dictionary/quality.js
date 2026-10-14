const { getCuratedEntry } = require('./curated-entries');

const SOURCE_PRIORITY = Object.freeze({
  manual_verified: 500,
  batch_verified: 490,
  curated: 400,
  external: 300,
  legacy: 100,
});

const VERIFIED_SOURCES = new Set(['manual_verified', 'batch_verified', 'curated', 'external']);
const SUPPORTED_SOURCES = Object.freeze(Object.keys(SOURCE_PRIORITY));
const INDEXABLE_SOURCES = new Set(['manual_verified', 'batch_verified', 'curated', 'external']);
const MIN_SEO_QUALITY_SCORE = 80;
const RARE_DEFINITION_PATTERNS = [
  /\barchaic\b/i,
  /\bobsolete\b/i,
  /\bdialect(?:al)?\b/i,
  /\bhistorical\b/i,
  /\bdated\b/i,
  /\brhyth(?:m|mic|mical)\b/i,
  /\bprosod(?:y|ic)\b/i,
  /\btechnical\b/i,
  /\bspeciali[sz](?:ed|t)\b/i,
  /\b(?:legal|medical|computing|mathematics|music) term\b/i,
  /\bgroup of (?:fish|marine|animals?)\b/i,
  /\bcollective noun\b/i,
  /\bshoal\b/i,
];
const IPA_BASE_PATTERN = /^[A-Za-zÀ-ɏɐ-ʯᴀ-ᶿ]$/u;
const IPA_NON_COMBINING_PATTERN = /^[A-Za-zÀ-ɏɐ-˿ᴀ-ᶿ .'’()\-‿]$/u;
const IPA_DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u;
const IPA_STRESS_MARKS = new Set(['ˈ', 'ˌ']);
const IPA_TIE_MARKS = new Set(['\u035c', '\u0361']);
const IPA_COMBINING_MARKS = new Set([
  '\u0300', '\u0301', '\u0302', '\u0303', '\u0304', '\u0306', '\u0308', '\u030a', '\u030b', '\u030c', '\u030f',
  '\u0318', '\u0319', '\u031a', '\u031c', '\u031d', '\u031e', '\u031f', '\u0320', '\u0324', '\u0325', '\u0329', '\u032a',
  '\u032c', '\u032f', '\u0330', '\u0334', '\u0339', '\u033a', '\u033b', '\u033c', '\u033d', '\u0346', '\u0347', '\u0348',
  '\u0349', '\u034a', '\u034b', '\u034c', '\u0350', '\u0351', '\u0352', '\u0354', '\u0355', '\u0356', '\u0357', '\u0358',
  '\u0359', '\u035a',
]);

const SEO_INDEXABLE_SQL = "seo_indexable = TRUE AND quality_status = 'verified' AND dictionary_word_is_seo_eligible(words)";

function normalizeSource(value, fallback = 'legacy') {
  const source = String(value || '').trim().toLowerCase();
  if (source === 'manual' || source === 'verified_manual') return 'manual_verified';
  if (source === 'batch' || source === 'verified_batch') return 'batch_verified';
  return Object.hasOwn(SOURCE_PRIORITY, source) ? source : fallback;
}

function normalizePhonetic(value) {
  if (value == null) return '';
  const raw = String(value);
  if (/[\x00-\x1f\x7f-\x9f]/u.test(raw)) return '';
  let text = raw.trim().normalize('NFC');
  if (!text || Array.from(text).length > 100) return '';

  const slashStart = text.startsWith('/');
  const slashEnd = text.endsWith('/');
  const bracketStart = text.startsWith('[');
  const bracketEnd = text.endsWith(']');
  if (slashStart !== slashEnd || bracketStart !== bracketEnd) return '';
  if ((slashStart || slashEnd) && (bracketStart || bracketEnd)) return '';
  if (slashStart) text = text.slice(1, -1).trim().normalize('NFC');
  if (bracketStart) text = text.slice(1, -1).trim().normalize('NFC');

  if (!text || /[0-9/\[\]{}<>]/u.test(text) || IPA_DEFAULT_IGNORABLE_PATTERN.test(text)) return '';

  const characters = Array.from(text);
  if (!characters.some((character) => IPA_BASE_PATTERN.test(character))) return '';
  if (characters.some((character) => (
    !IPA_NON_COMBINING_PATTERN.test(character)
    && !IPA_COMBINING_MARKS.has(character)
    && !IPA_TIE_MARKS.has(character)
  ))) return '';

  let optionalDepth = 0;
  let optionalHasBase = false;
  let combiningBaseSeen = false;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    const isBase = IPA_BASE_PATTERN.test(character);
    if (character === '(') {
      if (optionalDepth !== 0) return '';
      optionalDepth = 1;
      optionalHasBase = false;
    } else if (character === ')') {
      if (optionalDepth !== 1 || !optionalHasBase) return '';
      optionalDepth = 0;
    } else if (optionalDepth === 1 && isBase) {
      optionalHasBase = true;
    }
    if (isBase) {
      combiningBaseSeen = true;
    } else if (IPA_COMBINING_MARKS.has(character)) {
      if (!combiningBaseSeen) return '';
    } else {
      combiningBaseSeen = false;
    }
    if (IPA_STRESS_MARKS.has(character) && !IPA_BASE_PATTERN.test(characters[index + 1] || '')) return '';
    if (IPA_TIE_MARKS.has(character) && (
      !IPA_BASE_PATTERN.test(characters[index - 1] || '')
      || !IPA_BASE_PATTERN.test(characters[index + 1] || '')
    )) return '';
  }
  if (optionalDepth !== 0) return '';
  return text;
}

function formatPhoneticForApi(value) {
  const bare = normalizePhonetic(value);
  return bare ? `/${bare}/` : '';
}

function textOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDefinitionItem(item, fallbackZh = '') {
  if (typeof item === 'string') {
    const definition = item.trim();
    return definition ? { definition, ...(fallbackZh ? { zh: fallbackZh } : {}) } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const definition = textOrEmpty(item.definition || item.meaning || item.text || item.en);
  if (!definition) return null;
  const normalized = { definition };
  const zh = textOrEmpty(item.zh || item.cn || item.translation || fallbackZh);
  const example = textOrEmpty(item.example || (Array.isArray(item.examples) ? item.examples[0] : ''));
  const exampleZh = textOrEmpty(item.exampleZh || item.example_zh || (Array.isArray(item.examplesZh) ? item.examplesZh[0] : ''));
  if (zh) normalized.zh = zh;
  if (example) normalized.example = example;
  if (exampleZh) normalized.exampleZh = exampleZh;
  if (Array.isArray(item.synonyms) && item.synonyms.length) normalized.synonyms = [...item.synonyms];
  if (Array.isArray(item.antonyms) && item.antonyms.length) normalized.antonyms = [...item.antonyms];
  return normalized;
}

function definitionPenalty(item) {
  const text = String(item?.definition || '');
  return RARE_DEFINITION_PATTERNS.reduce((score, pattern) => score + (pattern.test(text) ? 100 : 0), 0);
}

function stableLearnerOrder(definitions) {
  return definitions
    .map((definition, index) => ({ definition, index, penalty: definitionPenalty(definition) }))
    .sort((a, b) => a.penalty - b.penalty || a.index - b.index)
    .map(({ definition }) => definition);
}

function normalizeMeaning(meaning, fallbackPos = '') {
  if (!meaning || typeof meaning !== 'object') return null;
  const partOfSpeech = textOrEmpty(meaning.partOfSpeech || meaning.part_of_speech || meaning.pos || fallbackPos);
  const rawDefinitions = Array.isArray(meaning.definitions)
    ? meaning.definitions
    : (meaning.definition || meaning.meaning || meaning.text ? [meaning] : []);
  const definitions = stableLearnerOrder(rawDefinitions.map((item) => normalizeDefinitionItem(item)).filter(Boolean));
  if (!definitions.length) return null;
  const normalized = { partOfSpeech, definitions };
  if (Array.isArray(meaning.synonyms) && meaning.synonyms.length) normalized.synonyms = [...meaning.synonyms];
  if (Array.isArray(meaning.antonyms) && meaning.antonyms.length) normalized.antonyms = [...meaning.antonyms];
  return normalized;
}

function normalizeDefinitions(value, options = {}) {
  if (value == null) return [];
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (_) {
      source = [source];
    }
  }

  if (source && !Array.isArray(source) && typeof source === 'object' && Array.isArray(source.meanings)) {
    return source.meanings.map((meaning) => normalizeMeaning(meaning, options.partOfSpeech)).filter(Boolean);
  }

  if (source && !Array.isArray(source) && typeof source === 'object' && Object.hasOwn(source, 'en')) {
    const english = Array.isArray(source.en) ? source.en : [source.en];
    const chinese = Array.isArray(source.zh) ? source.zh : [source.zh];
    const definitions = stableLearnerOrder(english
      .map((item, index) => normalizeDefinitionItem(item, textOrEmpty(chinese[index] ?? chinese[0])))
      .filter(Boolean));
    return definitions.length ? [{ partOfSpeech: textOrEmpty(options.partOfSpeech), definitions }] : [];
  }

  if (source && !Array.isArray(source) && typeof source === 'object' && Array.isArray(source.definitions)) {
    const meaning = normalizeMeaning(source, options.partOfSpeech);
    return meaning ? [meaning] : [];
  }

  if (!Array.isArray(source)) {
    const item = normalizeDefinitionItem(source);
    return item ? [{ partOfSpeech: textOrEmpty(options.partOfSpeech), definitions: [item] }] : [];
  }
  if (!source.length) return [];

  const looksLikeMeanings = source.some((item) => item && typeof item === 'object' && (
    Array.isArray(item.definitions) || item.partOfSpeech || item.part_of_speech || item.pos
  ));
  if (looksLikeMeanings) {
    return source.map((meaning) => normalizeMeaning(meaning, options.partOfSpeech)).filter(Boolean);
  }

  const definitions = stableLearnerOrder(source.map((item) => normalizeDefinitionItem(item)).filter(Boolean));
  return definitions.length ? [{ partOfSpeech: textOrEmpty(options.partOfSpeech), definitions }] : [];
}

function firstPartOfSpeech(entry, definitions) {
  return textOrEmpty(entry?.partOfSpeech || entry?.part_of_speech || definitions?.[0]?.partOfSpeech);
}

function firstZh(definitions, entry) {
  const topLevel = textOrEmpty(entry?.zh || entry?.translation);
  if (topLevel) return topLevel;
  for (const meaning of definitions || []) {
    for (const definition of meaning.definitions || []) {
      if (textOrEmpty(definition.zh)) return definition.zh.trim();
    }
  }
  return '';
}

function compatibilityMetadata(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const metadata = {};
  if (entry.origin != null) metadata.origin = structuredClone(entry.origin);
  if (entry.license != null) metadata.license = structuredClone(entry.license);
  if (entry.sourceUrls != null) metadata.sourceUrls = structuredClone(entry.sourceUrls);
  return metadata;
}

function phoneticAudio(entry, phonetic) {
  if (!phonetic || !Array.isArray(entry?.phonetics)) return '';
  const match = entry.phonetics.find((item) => normalizePhonetic(item?.text) === phonetic);
  return textOrEmpty(match?.audio);
}

function entryFields(entry) {
  if (!entry) return { phonetic: '', definitions: [], part_of_speech: '', zh: '', phonetic_audio: '', compatibility: {} };
  let phonetic = normalizePhonetic(entry.phonetic);
  if (!phonetic && Array.isArray(entry.phonetics)) {
    for (const candidate of entry.phonetics) {
      phonetic = normalizePhonetic(candidate?.text);
      if (phonetic) break;
    }
  }
  const definitions = normalizeDefinitions(entry.meanings || entry.definitions, {
    partOfSpeech: entry.partOfSpeech || entry.part_of_speech,
  });
  return {
    phonetic,
    definitions,
    part_of_speech: firstPartOfSpeech(entry, definitions),
    zh: firstZh(definitions, entry),
    phonetic_audio: phoneticAudio(entry, phonetic),
    compatibility: compatibilityMetadata(entry),
  };
}

function dbFields(record) {
  if (!record) return { phonetic: '', definitions: [], part_of_speech: '', zh: '', phonetic_audio: '', compatibility: {} };
  const definitions = normalizeDefinitions(record.definitions, { partOfSpeech: record.part_of_speech });
  return {
    phonetic: normalizePhonetic(record.phonetic),
    definitions,
    part_of_speech: firstPartOfSpeech(record, definitions),
    zh: firstZh(definitions, record.definitions),
    phonetic_audio: '',
    compatibility: {},
  };
}

function candidate(field, value, source, metadata = {}) {
  const valid = field === 'definitions' ? Array.isArray(value) && value.length > 0 : Boolean(textOrEmpty(value));
  return valid ? { value, source: normalizeSource(source), metadata } : null;
}

function trustedPhonetic(word) {
  return normalizePhonetic(getCuratedEntry(word)?.phonetic);
}

function selectField(field, candidates, { word = '' } = {}) {
  const rejected = [];
  const trusted = field === 'phonetic' ? trustedPhonetic(word) : '';
  const selected = candidates
    .filter((item) => {
      if (!item) return false;
      if (trusted && item.value !== trusted) {
        rejected.push({ source: item.source, value: item.value, reason: 'phonetic_conflicts_trusted' });
        return false;
      }
      return true;
    })
    .map((item, index) => ({ ...item, index, priority: SOURCE_PRIORITY[item.source] || 0 }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)[0];
  if (!selected) {
    return {
      value: field === 'definitions' ? [] : '',
      quality: { source: null, status: 'review', score: 0, reasons: [`missing_${field}`], meta: { rejected } },
      selected: null,
    };
  }
  const verified = VERIFIED_SOURCES.has(selected.source);
  return {
    value: selected.value,
    quality: {
      source: selected.source,
      status: verified ? 'verified' : 'review',
      score: verified ? 100 : 55,
      reasons: verified ? [] : ['unverified_legacy'],
      meta: { ...(selected.metadata || {}), rejected },
    },
    selected,
  };
}

function findMatchingDefinition(definition, meaning, definitions) {
  const targetText = textOrEmpty(definition?.definition).toLowerCase();
  const targetPos = textOrEmpty(meaning?.partOfSpeech).toLowerCase();
  for (const sourceMeaning of definitions || []) {
    const sourcePos = textOrEmpty(sourceMeaning?.partOfSpeech).toLowerCase();
    if (targetPos && sourcePos && targetPos !== sourcePos) continue;
    const match = (sourceMeaning.definitions || []).find((item) => (
      textOrEmpty(item?.definition).toLowerCase() === targetText
    ));
    if (match) return match;
  }
  return null;
}

function selectAttributedValue(items) {
  return items
    .filter((item) => textOrEmpty(item.value))
    .map((item, index) => ({ ...item, index, priority: SOURCE_PRIORITY[item.source] || 0 }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)[0] || null;
}

function renderedTranslationQuality(value, source, field) {
  if (!textOrEmpty(value)) {
    return { source: null, status: 'review', score: 0, reasons: [`missing_${field}_translation`] };
  }
  if (VERIFIED_SOURCES.has(source)) {
    return { source, status: 'verified', score: 100, reasons: [] };
  }
  return { source: source || null, status: 'review', score: 55, reasons: [`unverified_${field}_translation`] };
}

function aggregateTranslationQuality(items, field, priorMeta = {}) {
  if (!items.length) {
    return {
      source: null,
      status: field === 'example_zh' ? 'verified' : 'review',
      score: field === 'example_zh' ? 100 : 0,
      reasons: field === 'example_zh' ? [] : [`missing_${field}_translation`],
      meta: { ...priorMeta, items: [] },
    };
  }
  const sources = [...new Set(items.map((item) => item.source).filter(Boolean))];
  return {
    source: sources.length === 1 ? sources[0] : (sources.length > 1 ? 'mixed' : null),
    status: items.every((item) => item.status === 'verified') ? 'verified' : 'review',
    score: Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length),
    reasons: [...new Set(items.flatMap((item) => item.reasons))],
    meta: { ...priorMeta, items },
  };
}

function enrichDefinitionProvenance(definitions, sources, selectedSource) {
  const rendered = structuredClone(definitions || []);
  const items = [];
  for (let meaningIndex = 0; meaningIndex < rendered.length; meaningIndex++) {
    const meaning = rendered[meaningIndex];
    for (let definitionIndex = 0; definitionIndex < (meaning.definitions || []).length; definitionIndex++) {
      const definition = meaning.definitions[definitionIndex];
      const matches = sources.map((source) => ({ source, item: findMatchingDefinition(definition, meaning, source.definitions) }))
        .filter(({ item }) => item);
      const zh = selectAttributedValue(matches.map(({ source, item }) => ({ value: item.zh, source: source.zhSource })));
      const example = selectAttributedValue(matches.map(({ source, item }) => ({ value: item.example, source: source.source })));
      const exampleZh = selectAttributedValue(matches.map(({ source, item }) => ({ value: item.exampleZh, source: source.zhSource })));
      if (zh) definition.zh = zh.value;
      else delete definition.zh;
      if (example) definition.example = example.value;
      else delete definition.example;
      if (exampleZh) definition.exampleZh = exampleZh.value;
      else delete definition.exampleZh;
      if (exampleZh) definition.examplesZh = [exampleZh.value];
      else delete definition.examplesZh;
      const zhQuality = renderedTranslationQuality(zh?.value, zh?.source, 'zh');
      const exampleZhQuality = example || exampleZh
        ? renderedTranslationQuality(exampleZh?.value, exampleZh?.source, 'example_zh')
        : null;
      items.push({
        meaning_index: meaningIndex,
        definition_index: definitionIndex,
        definition_source: selectedSource,
        zh_source: zh?.source || null,
        zh_status: zhQuality.status,
        zh_score: zhQuality.score,
        zh_reasons: zhQuality.reasons,
        example_source: example?.source || null,
        example_zh_source: exampleZh?.source || null,
        example_zh_status: exampleZhQuality?.status || null,
        example_zh_score: exampleZhQuality?.score ?? null,
        example_zh_reasons: exampleZhQuality?.reasons || [],
      });
    }
  }
  return { definitions: rendered, items };
}

function resolveEntry({
  word,
  dbRecord = null,
  writeEntry = null,
  writeSource = 'legacy',
  curatedEntry = null,
  externalEntry = null,
  legacyEntry = null,
} = {}) {
  const normalizedWord = String(word || writeEntry?.word || dbRecord?.word || curatedEntry?.word || externalEntry?.word || '').trim().toLowerCase();
  const write = entryFields(writeEntry);
  const normalizedWriteSource = normalizeSource(writeSource);
  const db = dbFields(dbRecord);
  const curated = entryFields(curatedEntry);
  const external = entryFields(externalEntry);
  const legacy = entryFields(legacyEntry);

  const fields = {};
  const selected = {};
  const fieldSourceColumn = {
    phonetic: 'phonetic_source',
    definitions: 'definitions_source',
    part_of_speech: 'part_of_speech_source',
    zh: 'zh_source',
  };
  const sourceDefinitions = [
    { definitions: write.definitions, source: normalizedWriteSource, zhSource: normalizedWriteSource },
    { definitions: db.definitions, source: normalizeSource(dbRecord?.definitions_source || 'legacy'), zhSource: normalizeSource(dbRecord?.zh_source || 'legacy') },
    { definitions: curated.definitions, source: 'curated', zhSource: 'curated' },
    { definitions: external.definitions, source: 'external', zhSource: 'external' },
    { definitions: legacy.definitions, source: 'legacy', zhSource: 'legacy' },
  ];
  for (const field of Object.keys(fieldSourceColumn)) {
    const result = selectField(field, [
      candidate(field, write[field], normalizedWriteSource, {
        audio: write.phonetic_audio,
        compatibility: write.compatibility,
      }),
      candidate(field, db[field], dbRecord?.[fieldSourceColumn[field]] || 'legacy', {
        record_id: dbRecord?.id || null,
        audio: db.phonetic_audio,
        compatibility: db.compatibility,
      }),
      candidate(field, curated[field], 'curated', { audio: curated.phonetic_audio, compatibility: curated.compatibility }),
      candidate(field, external[field], 'external', { audio: external.phonetic_audio, compatibility: external.compatibility }),
      candidate(field, legacy[field], 'legacy', { audio: legacy.phonetic_audio, compatibility: legacy.compatibility }),
    ], { word: normalizedWord });
    selected[field] = result.value;
    fields[field] = result.quality;
    fields[field]._selected = result.selected;
  }

  const enriched = enrichDefinitionProvenance(
    selected.definitions,
    sourceDefinitions,
    fields.definitions.source,
  );
  const meanings = enriched.definitions;
  fields.definitions.meta = { ...fields.definitions.meta, items: enriched.items };
  fields.zh = aggregateTranslationQuality(enriched.items.map((item) => ({
    meaning_index: item.meaning_index,
    definition_index: item.definition_index,
    source: item.zh_source,
    status: item.zh_status,
    score: item.zh_score,
    reasons: item.zh_reasons,
  })), 'zh', fields.zh.meta);
  fields.example_zh = aggregateTranslationQuality(enriched.items
    .filter((item) => item.example_zh_status)
    .map((item) => ({
      meaning_index: item.meaning_index,
      definition_index: item.definition_index,
      source: item.example_zh_source,
      status: item.example_zh_status,
      score: item.example_zh_score,
      reasons: item.example_zh_reasons,
    })), 'example_zh');
  const phoneticSelection = fields.phonetic._selected;
  const compatibilitySelection = [write, curated, external, legacy]
    .find((source) => Object.keys(source.compatibility || {}).length > 0)?.compatibility
    || fields.definitions._selected?.metadata?.compatibility
    || phoneticSelection?.metadata?.compatibility
    || {};
  const entry = {
    word: normalizedWord,
    phonetic: formatPhoneticForApi(selected.phonetic),
    phonetics: selected.phonetic ? [{
      text: formatPhoneticForApi(selected.phonetic),
      ...(textOrEmpty(phoneticSelection?.metadata?.audio) ? { audio: phoneticSelection.metadata.audio } : {}),
    }] : [],
    meanings,
  };
  Object.assign(entry, compatibilitySelection);
  if (selected.part_of_speech) entry.partOfSpeech = selected.part_of_speech;
  for (const field of Object.values(fields)) delete field._selected;

  const required = [fields.phonetic, fields.definitions, fields.zh, fields.example_zh];
  const status = required.every((field) => field.status === 'verified') ? 'verified' : 'review';
  const reasons = [...new Set(Object.values(fields).flatMap((field) => field.reasons || []))];
  const score = Math.round(required.reduce((sum, field) => sum + field.score, 0) / required.length);
  const persistedAssessment = dbRecord ? assessWordRecord(dbRecord) : null;
  const quality = {
    status,
    score,
    reasons,
    fields,
    content_revision: Number.isInteger(Number(dbRecord?.content_revision)) ? Number(dbRecord.content_revision) : null,
    checked_revision: dbRecord?.quality_checked_revision == null ? null : Number(dbRecord.quality_checked_revision),
    checked_at: dbRecord?.quality_checked_at || null,
    seo_indexable: Boolean(persistedAssessment?.seo_indexable),
  };

  return {
    entry,
    quality,
    storage: {
      phonetic: selected.phonetic,
      definitions: meanings,
      part_of_speech: selected.part_of_speech || null,
      zh: firstZh(meanings, {}),
    },
  };
}

function hasTranslations(definitions) {
  return definitions.some((meaning) => (meaning.definitions || []).some((definition) => (
    textOrEmpty(definition.zh) || textOrEmpty(definition.exampleZh)
  )));
}

function persistedReasons(value) {
  if (Array.isArray(value)) return value.filter((reason) => textOrEmpty(reason));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((reason) => textOrEmpty(reason)) : [];
    } catch (_) {
      return textOrEmpty(value) ? [value.trim()] : [];
    }
  }
  return [];
}

function requireSupportedSource(reasons, source, field, { required = false } = {}) {
  if (!source) {
    if (required) reasons.push(`missing_${field}_provenance`);
    return;
  }
  if (!SUPPORTED_SOURCES.includes(source)) {
    reasons.push(`unsupported_${field}_source`);
  } else if (required && !INDEXABLE_SOURCES.has(source)) {
    reasons.push(`untrusted_${field}_source`);
  }
}

function assessWordRecord(record = {}) {
  const reasons = [];
  const rawPhonetic = record.phonetic == null ? '' : String(record.phonetic);
  const phonetic = normalizePhonetic(rawPhonetic);
  const definitions = normalizeDefinitions(record.definitions, { partOfSpeech: record.part_of_speech });

  if (rawPhonetic && rawPhonetic !== rawPhonetic.normalize('NFC')) reasons.push('phonetic_not_nfc');
  if (!rawPhonetic || !phonetic) reasons.push('invalid_phonetic');
  else if (rawPhonetic !== phonetic) reasons.push('phonetic_not_bare');
  const curatedPhonetic = normalizePhonetic(getCuratedEntry(record.word_lowercase || record.word)?.phonetic);
  if (phonetic && curatedPhonetic && phonetic !== curatedPhonetic) reasons.push('phonetic_conflicts_curated');
  if (!definitions.length) reasons.push('missing_definitions');
  requireSupportedSource(reasons, record.phonetic_source, 'phonetic', { required: true });
  requireSupportedSource(reasons, record.definitions_source, 'definitions', { required: true });
  requireSupportedSource(reasons, record.part_of_speech_source, 'part_of_speech', { required: Boolean(textOrEmpty(record.part_of_speech)) });
  requireSupportedSource(reasons, record.zh_source, 'zh', { required: hasTranslations(definitions) });

  if (record.quality_status === 'review') reasons.push('quality_review');
  else if (record.quality_status !== 'verified') reasons.push('quality_not_verified');

  const contentRevision = Number(record.content_revision);
  const checkedRevision = Number(record.quality_checked_revision);
  if (!Number.isInteger(contentRevision) || !Number.isInteger(checkedRevision) || checkedRevision !== contentRevision) {
    reasons.push('stale_quality_revision');
  }
  if (!record.quality_checked_at) reasons.push('missing_quality_checked_at');
  const storedReasons = persistedReasons(record.quality_reasons);
  if (storedReasons.length) reasons.push('persisted_rejection_reason');
  const score = Number(record.quality_score);
  if (!Number.isFinite(score) || score < MIN_SEO_QUALITY_SCORE) reasons.push('quality_score_below_minimum');
  if (record.seo_indexable !== true) reasons.push('seo_flag_disabled');

  const uniqueReasons = [...new Set(reasons)];
  const reportedScore = Number.isFinite(score)
    ? score
    : Math.max(0, 100 - uniqueReasons.length * 15);
  return {
    status: uniqueReasons.length ? 'review' : 'verified',
    score: reportedScore,
    reasons: uniqueReasons,
    fields: {
      phonetic: { source: record.phonetic_source || null, valid: Boolean(phonetic && rawPhonetic === phonetic) },
      definitions: { source: record.definitions_source || null, valid: definitions.length > 0 },
      part_of_speech: { source: record.part_of_speech_source || null, valid: Boolean(textOrEmpty(record.part_of_speech)) },
      zh: { source: record.zh_source || null, valid: hasTranslations(definitions) },
    },
    content_revision: Number.isInteger(contentRevision) ? contentRevision : null,
    checked_revision: Number.isInteger(checkedRevision) ? checkedRevision : null,
    checked_at: record.quality_checked_at || null,
    seo_indexable: uniqueReasons.length === 0,
  };
}

module.exports = {
  INDEXABLE_SOURCES,
  MIN_SEO_QUALITY_SCORE,
  SEO_INDEXABLE_SQL,
  SOURCE_PRIORITY,
  SUPPORTED_SOURCES,
  assessWordRecord,
  formatPhoneticForApi,
  normalizeDefinitions,
  normalizePhonetic,
  resolveEntry,
};
