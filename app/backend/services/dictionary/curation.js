const { randomUUID } = require('node:crypto');
const { createDictionaryQualityRepository } = require('../../data-store/queries/dictionary');
const { analyzeWordQuality } = require('../../utils/word-quality');
const { CURATED_WORDS, getCuratedEntry } = require('./curated-entries');
const {
  SOURCE_PRIORITY,
  assessWordRecord,
  normalizeDefinitions,
  normalizePhonetic,
  resolveEntry,
} = require('./quality');

const CURATED_SCOPE = new Set(CURATED_WORDS);

function normalizeScope(scope, { required = false, curatedOnly = true } = {}) {
  if (scope == null || (Array.isArray(scope) && scope.length === 0)) {
    if (required) throw new Error('SCOPE_REQUIRED');
    return curatedOnly ? [...CURATED_WORDS] : null;
  }
  if (!Array.isArray(scope)) throw new Error('INVALID_SCOPE');
  const normalized = [...new Set(scope.map((word) => String(word || '').trim().toLowerCase()).filter(Boolean))].sort();
  if (!normalized.length) throw new Error(required ? 'SCOPE_REQUIRED' : 'INVALID_SCOPE');
  if (normalized.length > 100) throw new Error('SCOPE_TOO_LARGE');
  if (curatedOnly && normalized.some((word) => !CURATED_SCOPE.has(word))) throw new Error('INVALID_SCOPE');
  if (normalized.some((word) => !/^[a-z][a-z'-]{0,99}$/.test(word))) throw new Error('INVALID_SCOPE');
  return normalized;
}

function normalizeExpectedRevisions(scope, expectedRevisions) {
  if (!expectedRevisions || typeof expectedRevisions !== 'object' || Array.isArray(expectedRevisions)) {
    throw new Error('EXPECTED_REVISIONS_REQUIRED');
  }
  const normalized = {};
  for (const word of scope) {
    const value = Number(expectedRevisions[word]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`EXPECTED_REVISION_REQUIRED:${word}`);
    normalized[word] = value;
  }
  return normalized;
}

function actorFields(actor = {}) {
  return {
    actor_type: String(actor.type || 'system').slice(0, 32),
    actor_id: actor.id == null ? null : String(actor.id).slice(0, 128),
  };
}

const SNAPSHOT_CONTENT_FIELDS = [
  'word',
  'word_lowercase',
  'phonetic',
  'definitions',
  'part_of_speech',
  'example_sentences',
  'synonyms',
];

function fieldIsSqlNull(record, field) {
  const marker = `${field}_is_sql_null`;
  if (typeof record?.[marker] === 'boolean') return record[marker];
  if (typeof record?.sql_nulls?.[field] === 'boolean') return record.sql_nulls[field];
  return record?.[field] == null;
}

function sqlNullState(record) {
  return Object.fromEntries(SNAPSHOT_CONTENT_FIELDS.map((field) => [field, fieldIsSqlNull(record, field)]));
}

function snapshotRecord(record) {
  return {
    id: record.id,
    word: record.word,
    word_lowercase: record.word_lowercase,
    phonetic: record.phonetic,
    definitions: structuredClone(record.definitions),
    part_of_speech: record.part_of_speech,
    example_sentences: structuredClone(record.example_sentences),
    synonyms: structuredClone(record.synonyms),
    sql_nulls: sqlNullState(record),
    content_revision: Number(record.content_revision),
    phonetic_source: record.phonetic_source || null,
    definitions_source: record.definitions_source || null,
    zh_source: record.zh_source || null,
    part_of_speech_source: record.part_of_speech_source || null,
    quality_status: record.quality_status || 'review',
    quality_score: record.quality_score == null ? null : Number(record.quality_score),
    quality_reasons: structuredClone(record.quality_reasons || []),
    quality_meta: structuredClone(record.quality_meta || {}),
    quality_checked_revision: record.quality_checked_revision == null ? null : Number(record.quality_checked_revision),
    quality_checked_at: record.quality_checked_at || null,
    seo_indexable: record.seo_indexable === true,
    ...(Object.hasOwn(record || {}, 'is_blacklisted') ? {
      is_blacklisted: record.is_blacklisted === true,
      blacklisted_at: record.blacklisted_at || null,
      blacklist_reason: record.blacklist_reason || null,
    } : {}),
  };
}

function proposalFor(record) {
  const word = String(record.word_lowercase || record.word || '').toLowerCase();
  const curatedEntry = getCuratedEntry(word);
  if (!curatedEntry) return null;
  const resolved = resolveEntry({ word, curatedEntry });
  return {
    word,
    expected_revision: Number(record.content_revision),
    before: snapshotRecord(record),
    after: {
      word: curatedEntry.word,
      word_lowercase: word,
      phonetic: resolved.storage.phonetic,
      definitions: resolved.storage.definitions,
      part_of_speech: resolved.storage.part_of_speech,
      example_sentences: structuredClone(record.example_sentences),
      synonyms: structuredClone(record.synonyms),
      sql_nulls: {
        word: false,
        word_lowercase: false,
        phonetic: false,
        definitions: false,
        part_of_speech: resolved.storage.part_of_speech == null,
        example_sentences: fieldIsSqlNull(record, 'example_sentences'),
        synonyms: fieldIsSqlNull(record, 'synonyms'),
      },
    },
    quality: resolved.quality,
  };
}

function boundedText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function boundedDefinitions(value) {
  const definitions = Array.isArray(value) ? value : (Array.isArray(value?.meanings) ? value.meanings : []);
  return definitions.slice(0, 3).map((meaning) => {
    if (typeof meaning === 'string') return boundedText(meaning, 300);
    if (!meaning || typeof meaning !== 'object') return null;
    if (!Array.isArray(meaning.definitions)) {
      return {
        definition: boundedText(meaning.definition || meaning.meaning || meaning.text, 300),
        ...(meaning.zh ? { zh: boundedText(meaning.zh, 300) } : {}),
      };
    }
    return {
      partOfSpeech: boundedText(meaning.partOfSpeech || meaning.part_of_speech, 40),
      definitions: meaning.definitions.slice(0, 3).map((definition) => ({
        definition: boundedText(definition?.definition || definition?.meaning || definition?.text, 300),
        ...(definition?.zh ? { zh: boundedText(definition.zh, 300) } : {}),
        ...(definition?.example ? { example: boundedText(definition.example, 300) } : {}),
        ...(definition?.exampleZh ? { exampleZh: boundedText(definition.exampleZh, 300) } : {}),
      })),
    };
  }).filter(Boolean);
}

function boundedCurrent(record) {
  const examples = Array.isArray(record.example_sentences) ? record.example_sentences : [];
  const synonyms = Array.isArray(record.synonyms) ? record.synonyms : [];
  return {
    phonetic: boundedText(record.phonetic, 100),
    definitions: boundedDefinitions(record.definitions),
    part_of_speech: record.part_of_speech == null ? null : boundedText(record.part_of_speech, 40),
    example_sentences: examples.slice(0, 5).map((example) => (
      typeof example === 'string'
        ? boundedText(example, 300)
        : { text: boundedText(example?.text || example?.sentence, 300) }
    )),
    synonyms: synonyms.slice(0, 20).map((synonym) => boundedText(synonym, 100)),
  };
}

function verifiedDecision(record, batchId, checkedAt) {
  const definitions = record.definitions || [];
  const hasZh = definitions.some((meaning) => (meaning.definitions || []).some((definition) => definition.zh));
  const decision = {
    phonetic_source: 'batch_verified',
    definitions_source: 'batch_verified',
    zh_source: hasZh ? 'batch_verified' : null,
    part_of_speech_source: record.part_of_speech ? 'batch_verified' : null,
    quality_status: 'verified',
    quality_score: 100,
    quality_reasons: [],
    quality_meta: {
      batch_id: batchId,
      fields: {
        phonetic: { source: 'batch_verified' },
        definitions: { source: 'batch_verified' },
        zh: { source: hasZh ? 'batch_verified' : null },
        part_of_speech: { source: record.part_of_speech ? 'batch_verified' : null },
      },
    },
    quality_checked_revision: Number(record.content_revision),
    quality_checked_at: checkedAt,
    seo_indexable: true,
  };
  const assessment = assessWordRecord({ ...record, ...decision });
  if (!assessment.seo_indexable) {
    const error = new Error(`CURATED_QUALITY_FAILED:${record.word_lowercase}:${assessment.reasons.join(',')}`);
    error.reasons = assessment.reasons;
    throw error;
  }
  return decision;
}

function normalizeLegacySource(source, reviewed) {
  if (reviewed === true) {
    if (source === 'batch' || source === 'batch_verified') return 'batch_verified';
    return 'manual_verified';
  }
  return 'legacy';
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function writeLookup(write = {}) {
  const word = String(write.word || write.candidate?.word_lowercase || write.candidate?.word || '').trim().toLowerCase();
  if (!word && write.id == null) throw new Error('WORD_OR_ID_REQUIRED');
  return { id: write.id == null ? null : Number(write.id), word };
}

function candidateWithTranslation(current, candidate = {}) {
  const result = structuredClone(candidate || {});
  if (!Object.hasOwn(result, 'definitions') && Object.hasOwn(result, 'zh')) {
    const definitions = normalizeDefinitions(current?.definitions, { partOfSpeech: current?.part_of_speech });
    if (result.zh == null) {
      for (const meaning of definitions) {
        for (const definition of meaning.definitions || []) delete definition.zh;
      }
      result.definitions = definitions;
    } else {
      const translation = String(result.zh).trim();
      if (definitions[0]?.definitions?.[0]) definitions[0].definitions[0].zh = translation;
      result.definitions = definitions.length ? definitions : { zh: translation };
    }
  }
  return result;
}

function planLegacyWrite(write, current, checkedAt, actor = {}) {
  const action = write.action || 'upsert';
  const lookup = writeLookup(write);
  const requestedSource = String(write.source || '').trim().toLowerCase() || null;
  const reviewed = write.reviewed === true && actor?.type === 'admin';
  const source = normalizeLegacySource(requestedSource, reviewed);
  if (action === 'upsert' && write.create_only === true && current) {
    return {
      mode: 'preview', read_only: true, dry_run: true, action, source, requested_source: requestedSource,
      reviewed, status: 'exists', before: structuredClone(current), after: structuredClone(current),
      expected_revision: Number(current.content_revision), quality_status: current.quality_status || 'review',
      seo_indexable: current.seo_indexable === true, reasons: ['word_already_exists'], conflicts: [],
      changes: {}, content_changed: false, review_only: false, metadata: structuredClone(write.metadata || {}),
    };
  }
  if (action === 'delete' || action === 'blacklist' || action === 'unblacklist') {
    return {
      mode: 'preview', read_only: true, dry_run: true, action, source, requested_source: requestedSource,
      reviewed, status: current ? 'ready' : 'missing', before: current ? structuredClone(current) : null,
      after: current ? { ...structuredClone(current), ...(action === 'blacklist' ? { is_blacklisted: true } : {}), ...(action === 'unblacklist' ? { is_blacklisted: false } : {}) } : null,
      expected_revision: current?.content_revision == null ? null : Number(current.content_revision),
      quality_status: current?.quality_status || 'review', seo_indexable: current?.seo_indexable === true,
      reasons: current ? [] : ['word_not_found'], conflicts: [], metadata: structuredClone(write.metadata || {}),
    };
  }

  const rawCandidate = structuredClone(write.candidate || {});
  const identitySupplied = Object.hasOwn(rawCandidate, 'word') || Object.hasOwn(rawCandidate, 'word_lowercase');
  if (!current || identitySupplied) {
    const requestedWord = String(rawCandidate.word || rawCandidate.word_lowercase || lookup.word || '').trim();
    const quality = analyzeWordQuality(requestedWord);
    if (!quality.ok) throw new Error(`LOW_QUALITY_WORD:${quality.reasons.join(',')}`);
    if (Object.hasOwn(rawCandidate, 'word_lowercase')) {
      const suppliedLower = String(rawCandidate.word_lowercase || '').trim().toLowerCase();
      if (suppliedLower !== quality.lower) throw new Error(`WORD_IDENTITY_MISMATCH:${quality.lower}:${suppliedLower}`);
    }
    if (!current && lookup.word && lookup.word !== quality.lower) {
      throw new Error(`WORD_IDENTITY_MISMATCH:${quality.lower}:${lookup.word}`);
    }
    rawCandidate.word = quality.word;
    rawCandidate.word_lowercase = quality.lower;
  }
  const explicitTranslationRemoval = Object.hasOwn(rawCandidate, 'zh') && rawCandidate.zh == null;
  const translationOnlyWithoutDefinition = Object.hasOwn(rawCandidate, 'zh')
    && rawCandidate.zh != null
    && !Object.hasOwn(rawCandidate, 'definitions')
    && normalizeDefinitions(current?.definitions, { partOfSpeech: current?.part_of_speech }).length === 0;
  const candidate = candidateWithTranslation(current, rawCandidate);
  const word = lookup.word || String(current?.word_lowercase || current?.word || '').toLowerCase();
  const resolved = resolveEntry({ word, dbRecord: current, writeEntry: candidate, writeSource: source });
  const supplied = {
    phonetic: Object.hasOwn(candidate, 'phonetic'),
    definitions: Object.hasOwn(candidate, 'definitions') || Object.hasOwn(candidate, 'zh'),
    part_of_speech: Object.hasOwn(candidate, 'part_of_speech') || Object.hasOwn(candidate, 'partOfSpeech'),
  };
  const proposed = {
    phonetic: resolved.storage.phonetic,
    definitions: resolved.storage.definitions,
    part_of_speech: resolved.storage.part_of_speech,
  };
  const currentNormalized = {
    phonetic: normalizePhonetic(current?.phonetic),
    definitions: normalizeDefinitions(current?.definitions, { partOfSpeech: current?.part_of_speech }),
    part_of_speech: current?.part_of_speech || null,
  };
  const candidateNormalized = {
    phonetic: normalizePhonetic(candidate.phonetic),
    definitions: normalizeDefinitions(candidate.definitions, { partOfSpeech: candidate.part_of_speech || candidate.partOfSpeech }),
    part_of_speech: candidate.part_of_speech || candidate.partOfSpeech || null,
  };
  const existingTranslationSource = current?.zh_source || current?.definitions_source || 'legacy';
  const translationRemovalAllowed = explicitTranslationRemoval
    && (SOURCE_PRIORITY[source] || 0) >= (SOURCE_PRIORITY[existingTranslationSource] || SOURCE_PRIORITY.legacy);
  if (translationRemovalAllowed) proposed.definitions = candidateNormalized.definitions;
  const sourceColumns = {
    phonetic: 'phonetic_source', definitions: 'definitions_source', part_of_speech: 'part_of_speech_source',
  };
  const conflicts = [];
  const changes = {};
  for (const field of Object.keys(supplied)) {
    if (!supplied[field]) continue;
    const existingSource = current?.[sourceColumns[field]] || 'legacy';
    const rejected = !sameValue(proposed[field], candidateNormalized[field]);
    if (rejected) {
      conflicts.push({ field, reason: 'verified_field_protected', existing_source: existingSource, requested_source: requestedSource });
      continue;
    }
    if (!sameValue(currentNormalized[field], proposed[field])) changes[field] = proposed[field];
  }
  if (!current) {
    changes.word = candidate.word;
    changes.word_lowercase = candidate.word_lowercase;
    for (const field of Object.keys(supplied)) if (supplied[field]) changes[field] = proposed[field];
  }
  if (translationOnlyWithoutDefinition) changes.definitions = { zh: String(rawCandidate.zh || '').trim() };
  if (current && (Object.hasOwn(rawCandidate, 'word') || Object.hasOwn(rawCandidate, 'word_lowercase'))) {
    const nextWord = rawCandidate.word;
    const nextLower = rawCandidate.word_lowercase;
    if (nextWord && nextLower && (nextWord !== current.word || nextLower !== current.word_lowercase)) {
      changes.word = nextWord;
      changes.word_lowercase = nextLower;
    }
  }
  const contentChanged = Object.keys(changes).length > 0;
  const reviewOnly = reviewed && Boolean(current) && conflicts.length === 0 && !contentChanged;
  const nextRevision = current ? Number(current.content_revision) + (contentChanged || reviewOnly ? 1 : 0) : 1;
  const resolvedSource = (field, fallback) => {
    const value = resolved.quality.fields[field]?.source;
    return Object.hasOwn(SOURCE_PRIORITY, value) ? value : fallback;
  };
  const qualityStatus = reviewed && resolved.quality.status === 'verified' ? 'verified' : 'review';
  const reasons = reviewed
    ? [...new Set(resolved.quality.reasons || [])]
    : ['unreviewed_source'];
  const decision = {
    phonetic_source: resolvedSource('phonetic', current?.phonetic_source || null),
    definitions_source: resolvedSource('definitions', current?.definitions_source || null),
    zh_source: translationRemovalAllowed ? null : (translationOnlyWithoutDefinition ? source : resolvedSource('zh', current?.zh_source || null)),
    part_of_speech_source: resolvedSource('part_of_speech', current?.part_of_speech_source || null),
    quality_status: qualityStatus,
    quality_score: qualityStatus === 'verified' ? resolved.quality.score : Math.min(55, resolved.quality.score),
    quality_reasons: reasons,
    quality_meta: { ...(write.metadata || {}), source, requested_source: requestedSource, reviewed, conflicts },
    quality_checked_revision: nextRevision,
    quality_checked_at: checkedAt,
    seo_indexable: qualityStatus === 'verified',
  };
  const after = {
    ...(current ? structuredClone(current) : {}),
    ...changes,
    ...decision,
    content_revision: nextRevision,
  };
  return {
    mode: 'preview', read_only: true, dry_run: true, action, source, requested_source: requestedSource,
    reviewed, status: 'ready', before: current ? structuredClone(current) : null, after,
    expected_revision: current?.content_revision == null ? null : Number(current.content_revision),
    quality_status: qualityStatus, seo_indexable: decision.seo_indexable, reasons, conflicts, changes, decision,
    content_changed: contentChanged, review_only: reviewOnly, metadata: structuredClone(write.metadata || {}),
  };
}

function createCurationService({
  repository = createDictionaryQualityRepository(),
  now = () => new Date(),
  randomUUID: makeUuid = randomUUID,
} = {}) {
  const pendingInvalidations = new Set();

  async function previewWrite(write, actor = {}, targetRepository = repository) {
    const lookup = writeLookup(write);
    const current = await targetRepository.getLegacyWriteRecord(lookup);
    return planLegacyWrite(write, current, now(), actor);
  }

  async function applyWriteInTransaction(write, actor, tx, context) {
    const lookup = writeLookup(write);
    const actorInfo = actorFields(actor);
    let current = await tx.getLegacyWriteRecord({ ...lookup, forUpdate: true });
    let plan = planLegacyWrite(write, current, context.checkedAt, actor);
    if (write.expected_revision != null && Number(write.expected_revision) !== Number(plan.expected_revision)) {
      throw new Error(`REVISION_CONFLICT:${lookup.word || lookup.id}`);
    }
    if (plan.status === 'exists') {
      return { ...plan, mode: 'apply', read_only: false, dry_run: false, applied: 0, batch_id: null };
    }
    if (plan.status === 'missing' && plan.action !== 'upsert') {
      return { ...plan, mode: 'apply', read_only: false, dry_run: false, applied: 0, batch_id: null };
    }
    if (!plan.content_changed && !plan.review_only && plan.action === 'upsert') {
      return { ...plan, mode: 'apply', read_only: false, dry_run: false, applied: 0, batch_id: null };
    }
    if (plan.action !== 'upsert') {
      const stateResult = await tx.applyLegacyStateAction({ action: plan.action, id: lookup.id, word: lookup.word });
      const affected = stateResult?.affected || stateResult?.deleted || stateResult?.blacklisted || stateResult?.unblacklisted || 0;
      if (!affected) {
        return { ...plan, ...stateResult, mode: 'apply', read_only: false, dry_run: false, applied: 0, batch_id: null };
      }
      if (!context.created) {
        await tx.createQualityBatch({
          id: context.batchId,
          operation: 'apply',
          status: 'applied',
          scope: context.scope,
          ...actorInfo,
          created_at: context.checkedAt,
        });
        context.created = true;
      }
      const complete = stateResult.after || await tx.getLegacyWriteRecord({ id: current.id });
      const beforeRecord = snapshotRecord(current);
      beforeRecord.user_vocabulary_records = structuredClone(stateResult.deleted_user_vocabulary_records || []);
      const revision = await tx.appendQualityRevision({
        batch_id: context.batchId,
        word_id: complete.id,
        word_lowercase: complete.word_lowercase,
        from_revision: Number(current.content_revision),
        to_revision: Number(complete.content_revision),
        before_record: beforeRecord,
        after_record: snapshotRecord(complete),
        action: plan.action,
        ...actorInfo,
        created_at: context.checkedAt,
      });
      return {
        ...plan,
        ...stateResult,
        mode: 'apply', read_only: false, dry_run: false,
        applied: affected,
        batch_id: context.batchId,
        revision_id: revision?.id || null,
      };
    }

    if (current && plan.changes.word_lowercase && plan.changes.word_lowercase !== current.word_lowercase) {
      const conflict = await tx.getLegacyWriteRecord({ word: plan.changes.word_lowercase, forUpdate: true });
      if (conflict && Number(conflict.id) !== Number(current.id)) {
        throw new Error(`CONFLICT_WORD_LOWERCASE:${plan.changes.word_lowercase}`);
      }
    }
    let updated = current
      ? plan.review_only
        ? await tx.bumpLegacyReviewRevision({
            id: current.id,
            word: current.word_lowercase,
            expectedRevision: Number(current.content_revision),
          })
        : await tx.updateLegacyWord({
          id: current.id,
          word: current.word_lowercase,
          expectedRevision: Number(current.content_revision),
          changes: plan.changes,
        })
      : await tx.insertLegacyWord({ changes: plan.changes });
    if (!updated && !current) {
      const winner = await tx.getLegacyWriteRecord({ word: plan.changes.word_lowercase, forUpdate: true });
      if (winner) {
        current = winner;
        plan = planLegacyWrite(write, current, context.checkedAt, actor);
        if (!plan.content_changed) {
          return {
            ...plan,
            mode: 'apply', read_only: false, dry_run: false, applied: 0, batch_id: null,
            after: structuredClone(current), reconciled: true,
          };
        }
        updated = await tx.updateLegacyWord({
          id: current.id,
          word: current.word_lowercase,
          expectedRevision: Number(current.content_revision),
          changes: plan.changes,
        });
      }
    }
    if (!updated) throw new Error(`REVISION_CONFLICT:${lookup.word || lookup.id}`);
    if (!context.created) {
      await tx.createQualityBatch({
        id: context.batchId,
        operation: 'apply',
        status: 'applied',
        scope: context.scope,
        ...actorInfo,
        created_at: context.checkedAt,
      });
      context.created = true;
    }
    const userVocabularyUpdated = current && updated.word !== current.word
      ? await tx.syncLegacyWordReferences({ id: updated.id, word: updated.word })
      : 0;
    const decision = { ...plan.decision, quality_checked_revision: Number(updated.content_revision) };
    const verified = await tx.saveQualityDecision({
      word: updated.word_lowercase,
      expectedRevision: Number(updated.content_revision),
      decision,
    });
    if (!verified) throw new Error(`REVISION_CONFLICT:${lookup.word || lookup.id}`);
    const complete = await tx.getLegacyWriteRecord({ id: verified.id });
    const revision = await tx.appendQualityRevision({
      batch_id: context.batchId,
      word_id: complete.id,
      word_lowercase: complete.word_lowercase,
      from_revision: current ? Number(current.content_revision) : 0,
      to_revision: Number(complete.content_revision),
      before_record: current ? snapshotRecord(current) : { word: complete.word_lowercase, content_revision: 0 },
      after_record: snapshotRecord(complete),
      action: current ? 'apply' : 'insert',
      ...actorInfo,
      created_at: context.checkedAt,
    });
    return {
      ...plan,
      mode: 'apply', read_only: false, dry_run: false, applied: 1, batch_id: context.batchId,
      revision_id: revision?.id || null, after: structuredClone(complete),
      user_vocabulary_updated: userVocabularyUpdated,
    };
  }

  async function invalidateAppliedResults(results) {
    if (typeof repository.invalidateWordCaches !== 'function') return;
    const targets = new Map();
    for (const result of results) {
      const wasApplied = Number(result.applied || result.affected || result.deleted || result.blacklisted || result.unblacklisted || 0) > 0;
      const currentWord = result.after?.word_lowercase || result.before?.word_lowercase;
      if (currentWord && wasApplied) {
        pendingInvalidations.add(currentWord);
        targets.set(currentWord, { id: result.after?.id, word: currentWord });
      }
      const previousWord = result.before?.word_lowercase;
      if (previousWord && previousWord !== currentWord && wasApplied) {
        pendingInvalidations.add(previousWord);
        targets.set(previousWord, { word: previousWord });
      }
    }
    for (const word of pendingInvalidations) {
      if (!targets.has(word)) targets.set(word, { word });
    }

    const failures = [];
    for (const [word, target] of targets) {
      try {
        await repository.invalidateWordCaches(target);
        pendingInvalidations.delete(word);
      } catch (error) {
        pendingInvalidations.add(word);
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        `CACHE_INVALIDATION_FAILED:${failures.map((error) => error.message).join('|')}`,
      );
    }
  }

  async function applyWrite(write, actor) {
    const lookup = writeLookup(write);
    const context = {
      batchId: makeUuid(),
      checkedAt: now(),
      created: false,
      scope: [lookup.word || `id:${lookup.id}`],
    };
    const result = await repository.withTransaction((tx) => applyWriteInTransaction(write, actor, tx, context));
    await invalidateAppliedResults([result]);
    return result;
  }

  async function applyLegacyBatch(writes, actor) {
    if (!Array.isArray(writes) || !writes.length) throw new Error('WRITES_REQUIRED');
    const normalized = writes.map((write, index) => ({ write, index, lookup: writeLookup(write) }));
    const context = {
      batchId: makeUuid(),
      checkedAt: now(),
      created: false,
      scope: normalized.map(({ lookup }) => lookup.word || `id:${lookup.id}`),
    };
    const results = await repository.withTransaction(async (tx) => {
      const items = new Array(normalized.length);
      const ordered = [...normalized].sort((left, right) => {
        const leftKey = left.lookup.word || `id:${String(left.lookup.id).padStart(20, '0')}`;
        const rightKey = right.lookup.word || `id:${String(right.lookup.id).padStart(20, '0')}`;
        return leftKey.localeCompare(rightKey) || left.index - right.index;
      });
      for (const { write, index } of ordered) items[index] = await applyWriteInTransaction(write, actor, tx, context);
      return items;
    });
    await invalidateAppliedResults(results);
    return {
      batch_id: context.created ? context.batchId : null,
      applied: results.reduce((sum, result) => sum + Number(result.applied || 0), 0),
      results,
    };
  }

  return {
    async audit({ scope = null, limit = 500 } = {}) {
      const normalizedScope = scope == null ? null : normalizeScope(scope, { curatedOnly: false });
      const records = await repository.listQualityRecords({ scope: normalizedScope, limit });
      return {
        mode: 'audit',
        read_only: true,
        items: records.map((record) => ({
          id: record.id,
          word: record.word_lowercase || record.word,
          current_revision: Number(record.content_revision),
          current: boundedCurrent(record),
          assessment: assessWordRecord(record),
          suggestion: getCuratedEntry(record.word_lowercase || record.word) ? proposalFor(record)?.after : null,
          suggested_source: getCuratedEntry(record.word_lowercase || record.word) ? 'curated' : null,
        })),
      };
    },

    async preview({ scope = CURATED_WORDS, write = null, actor = null } = {}) {
      if (write) return previewWrite(write, actor || {});
      const normalizedScope = normalizeScope(scope);
      const records = await repository.listQualityRecords({ scope: normalizedScope, limit: normalizedScope.length });
      const byWord = new Map(records.map((record) => [record.word_lowercase, record]));
      return {
        mode: 'plan',
        read_only: true,
        items: normalizedScope.map((word) => {
          const record = byWord.get(word);
          if (!record) return { word, status: 'missing', expected_revision: null, before: null, after: proposalFor({ word, word_lowercase: word, content_revision: 0, definitions: null })?.after };
          return { ...proposalFor(record), status: 'ready' };
        }),
      };
    },

    async apply({ scope, expectedRevisions, actor, write = null } = {}) {
      if (write) return applyWrite(write, actor);
      const normalizedScope = normalizeScope(scope, { required: true });
      const revisions = normalizeExpectedRevisions(normalizedScope, expectedRevisions);
      const checkedAt = now();
      const batchId = makeUuid();
      const actorInfo = actorFields(actor);

      return repository.withTransaction(async (tx) => {
        const lockedRecords = await tx.getWordsForQualityUpdate(normalizedScope);
        const locked = new Map(lockedRecords.map((record) => [record.word_lowercase, record]));
        for (const word of normalizedScope) {
          const record = locked.get(word);
          if (!record) throw new Error(`WORD_NOT_FOUND:${word}`);
          if (Number(record.content_revision) !== revisions[word]) throw new Error(`REVISION_CONFLICT:${word}`);
        }

        await tx.createQualityBatch({
          id: batchId,
          operation: 'apply',
          status: 'applied',
          scope: normalizedScope,
          ...actorInfo,
          created_at: checkedAt,
        });

        const items = [];
        for (const word of normalizedScope) {
          const before = locked.get(word);
          const proposal = proposalFor(before);
          const updated = await tx.updateCuratedWord({ word, expectedRevision: revisions[word], changes: proposal.after });
          if (!updated) throw new Error(`REVISION_CONFLICT:${word}`);
          const decision = verifiedDecision(updated, batchId, checkedAt);
          const verified = await tx.saveQualityDecision({ word, expectedRevision: Number(updated.content_revision), decision });
          if (!verified) throw new Error(`REVISION_CONFLICT:${word}`);
          const revision = await tx.appendQualityRevision({
            batch_id: batchId,
            word_id: verified.id,
            word_lowercase: word,
            from_revision: revisions[word],
            to_revision: Number(verified.content_revision),
            before_record: snapshotRecord(before),
            after_record: snapshotRecord(verified),
            action: 'apply',
            ...actorInfo,
            created_at: checkedAt,
          });
          items.push({ word, revision_id: revision?.id || null, content_revision: Number(verified.content_revision) });
        }
        return { batch_id: batchId, applied: items.length, items };
      });
    },

    async applyBatch({ writes, actor } = {}) {
      return applyLegacyBatch(writes, actor);
    },

    async rollback({ batchId, actor } = {}) {
      if (typeof batchId !== 'string' || !batchId.trim() || batchId.length > 128) throw new Error('INVALID_BATCH_ID');
      const actorInfo = actorFields(actor);
      const result = await repository.withTransaction(async (tx) => {
        const revisions = await tx.listBatchRevisions(batchId);
        if (!revisions.length) throw new Error('BATCH_NOT_FOUND');
        const orderedRevisions = [...revisions].sort((a, b) => (
          a.word_lowercase.localeCompare(b.word_lowercase)
          || Number(a.from_revision) - Number(b.from_revision)
          || Number(a.to_revision) - Number(b.to_revision)
          || Number(a.id) - Number(b.id)
        ));
        const revisionsByWord = new Map();
        for (const revision of orderedRevisions) {
          const group = revisionsByWord.get(revision.word_lowercase) || [];
          group.push(revision);
          revisionsByWord.set(revision.word_lowercase, group);
        }
        for (const [word, group] of revisionsByWord) {
          for (let index = 1; index < group.length; index++) {
            if (Number(group[index].from_revision) !== Number(group[index - 1].to_revision)) {
              throw new Error(`INVALID_BATCH_REVISIONS:${word}`);
            }
          }
        }
        const rollbackWords = [...revisionsByWord.keys()].sort();
        const lockedRecords = await tx.getWordsForQualityUpdate(rollbackWords);
        const currentByWord = new Map(lockedRecords.map((record) => [record.word_lowercase, record]));
        for (const [word, group] of revisionsByWord) {
          const current = currentByWord.get(word);
          const latest = group[group.length - 1];
          if (!current) throw new Error(`WORD_NOT_FOUND:${word}`);
          if (Number(current.content_revision) !== Number(latest.to_revision)) {
            throw new Error(`ROLLBACK_SUPERSEDED:${word}`);
          }
        }

        const rolledBackAt = now();
        const items = [];
        for (const word of rollbackWords) {
          const group = revisionsByWord.get(word);
          const earliest = group[0];
          const latest = group[group.length - 1];
          const before = structuredClone(earliest.before_record);
          const vocabularyRecords = [];
          const seenVocabularyIds = new Set();
          for (const revision of group) {
            for (const record of revision.before_record?.user_vocabulary_records || []) {
              const key = record?.id == null ? JSON.stringify(record) : `id:${record.id}`;
              if (seenVocabularyIds.has(key)) continue;
              seenVocabularyIds.add(key);
              vocabularyRecords.push(structuredClone(record));
            }
          }
          if (vocabularyRecords.length) before.user_vocabulary_records = vocabularyRecords;
          const restore = typeof tx.restoreLegacyRevision === 'function'
            ? tx.restoreLegacyRevision.bind(tx)
            : tx.restoreQualityRevision.bind(tx);
          const restored = await restore({
            word,
            expectedRevision: Number(latest.to_revision),
            before,
            action: earliest.action,
          });
          if (!restored) throw new Error(`ROLLBACK_SUPERSEDED:${word}`);
          for (const revision of group) {
            if (!await tx.markRevisionRolledBack(revision.id, rolledBackAt)) throw new Error(`ROLLBACK_SUPERSEDED:${word}`);
          }
          items.push({ word, content_revision: Number(restored.content_revision), revisions_rolled_back: group.length });
        }
        if (!await tx.markBatchRolledBack(batchId, { ...actorInfo, rolled_back_at: rolledBackAt })) throw new Error('ROLLBACK_SUPERSEDED:BATCH');
        return { batch_id: batchId, rolled_back: orderedRevisions.length, words_rolled_back: items.length, items };
      });
      await invalidateAppliedResults(result.items.map((item) => ({
        applied: 1,
        after: { word_lowercase: item.word },
      })));
      return result;
    },
  };
}

module.exports = {
  createCurationService,
  normalizeExpectedRevisions,
  normalizeScope,
};
