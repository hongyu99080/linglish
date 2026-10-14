const https = require('https');
const dataStore = require('../data-store');
const { getCuratedEntry } = require('./dictionary/curated-entries');
const {
  formatPhoneticForApi,
  normalizeDefinitions,
  resolveEntry,
} = require('./dictionary/quality');

const CACHE = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 60 minutes (increased from 30)

// Rate limiting to prevent 429 errors
const REQUEST_QUEUE = [];
const MIN_REQUEST_INTERVAL_MS = 200; // Minimum 200ms between requests (优化响应速度)
let lastRequestTime = 0;
let isProcessingQueue = false;

// Common words that don't need dictionary lookup
const SKIP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'as', 'at', 'by', 'for', 'in',
  'of', 'on', 'to', 'up', 'it', 'is', 'be', 'am', 'are', 'was', 'were',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her', 'its',
  'our', 'their', 'this', 'that', 'these', 'those', 'from', 'with', 'into',
]);

const FALLBACK_SLANG = {
  // Common demonstrative pronouns (often not in dictionary API)
  my: {
    phonetic: '/maɪ/',
    partOfSpeech: 'determiner',
    definition: 'Belonging to or associated with the speaker.',
    example: 'This is my book.'
  },
  your: {
    phonetic: '/jʊr/',
    partOfSpeech: 'determiner',
    definition: 'Belonging to or associated with the person being addressed.',
    example: 'Is this your bag?'
  },
  his: {
    phonetic: '/hɪz/',
    partOfSpeech: 'determiner',
    definition: 'Belonging to or associated with a male person previously mentioned or easily identified.',
    example: 'His car is parked outside.'
  },
  her: {
    phonetic: '/hɜːr/',
    partOfSpeech: 'determiner',
    definition: 'Belonging to or associated with a female person previously mentioned or easily identified.',
    example: 'Her phone is ringing.'
  },
  its: {
    phonetic: '/ɪts/',
    partOfSpeech: 'determiner',
    definition: 'Belonging to or associated with a thing previously mentioned or easily identified.',
    example: 'The dog wagged its tail.'
  },
  our: {
    phonetic: '/aʊər/',
    partOfSpeech: 'determiner',
    definition: 'Belonging to or associated with the speaker and one or more other people.',
    example: 'Our team won the match.'
  },
  their: {
    phonetic: '/ðer/',
    partOfSpeech: 'determiner',
    definition: 'Belonging to or associated with people or things previously mentioned or easily identified.',
    example: 'Their house is on the corner.'
  },
  from: {
    phonetic: '/frʌm/',
    partOfSpeech: 'preposition',
    definition: 'Indicating the point in space at which a journey, motion, or action starts.',
    example: 'She walked from the station.'
  },
  this: {
    phonetic: '/ðɪs/',
    partOfSpeech: 'pronoun/determiner',
    definition: 'Used to identify a specific person or thing close at hand or being indicated or experienced.',
    example: 'This is my book.'
  },
  that: {
    phonetic: '/ðæt/',
    partOfSpeech: 'pronoun/determiner',
    definition: 'Used to identify a specific person or thing observed or heard by the speaker.',
    example: 'That was a great movie.'
  },
  these: {
    phonetic: '/ðiːz/',
    partOfSpeech: 'pronoun/determiner',
    definition: 'Plural of "this". Used to identify specific people or things close at hand.',
    example: 'These are my friends.'
  },
  those: {
    phonetic: '/ðoʊz/',
    partOfSpeech: 'pronoun/determiner',
    definition: 'Plural of "that". Used to identify specific people or things observed by the speaker.',
    example: 'Those were the days.'
  },
  wanna: {
    partOfSpeech: 'informal verb',
    definition: 'Informal contraction of "want to".',
    example: 'I wanna go home.'
  },
  gonna: {
    partOfSpeech: 'informal verb',
    definition: 'Informal contraction of "going to".',
    example: "It's gonna rain soon."
  },
  gotta: {
    partOfSpeech: 'informal verb',
    definition: 'Informal way to say "have got to" (must).',
    example: 'I gotta run.'
  },
  gotcha: {
    partOfSpeech: 'informal interjection',
    definition: 'Casual pronunciation of "got you" meaning "understood".',
    example: 'Gotcha, thanks for explaining.'
  },
  lemme: {
    partOfSpeech: 'informal verb',
    definition: 'Informal contraction of "let me".',
    example: 'Lemme take a look.'
  },
  gimme: {
    partOfSpeech: 'informal verb',
    definition: 'Informal contraction of "give me".',
    example: 'Gimme a minute.'
  },
  dunno: {
    partOfSpeech: 'informal verb',
    definition: 'Informal contraction of "do not know".',
    example: 'I dunno what happened.'
  },
  kinda: {
    partOfSpeech: 'informal adverb',
    definition: 'Casual way to say "kind of" (somewhat).',
    example: "I'm kinda tired."
  },
  sorta: {
    partOfSpeech: 'informal adverb',
    definition: 'Casual way to say "sort of" (roughly).',
    example: 'It sorta looks like a bird.'
  },
  outta: {
    partOfSpeech: 'informal preposition',
    definition: 'Informal contraction of "out of".',
    example: 'We ran outta time.'
  },
  lotta: {
    partOfSpeech: 'informal quantifier',
    definition: 'Informal contraction of "a lot of".',
    example: 'There were a lotta people there.'
  },
  coulda: {
    partOfSpeech: 'informal verb',
    definition: 'Informal spelling of "could have".',
    example: 'We coulda won the game.'
  },
  shoulda: {
    partOfSpeech: 'informal verb',
    definition: 'Informal spelling of "should have".',
    example: 'I shoulda studied more.'
  },
  woulda: {
    partOfSpeech: 'informal verb',
    definition: 'Informal spelling of "would have".',
    example: 'I woulda called you.'
  },
  musta: {
    partOfSpeech: 'informal verb',
    definition: 'Informal spelling of "must have".',
    example: 'You musta seen it happen.'
  },
  yeah: {
    partOfSpeech: 'informal interjection',
    definition: 'Casual pronunciation of "yes".',
    example: 'Yeah, I agree.'
  },
  yep: {
    partOfSpeech: 'informal interjection',
    definition: 'Informal way to say "yes".',
    example: 'Yep, that works.'
  },
  yup: {
    partOfSpeech: 'informal interjection',
    definition: 'Informal way to say "yes".',
    example: 'Yup, I saw it.'
  },
  nope: {
    partOfSpeech: 'informal interjection',
    definition: 'Casual way to say "no".',
    example: 'Nope, not today.'
  },
  nah: {
    partOfSpeech: 'informal interjection',
    definition: 'Casual way to say "no".',
    example: 'Nah, I am good.'
  },
  bout: {
    partOfSpeech: 'informal preposition',
    definition: 'Casual spelling of "about".',
    example: "Let's talk bout it later."
  },
  til: {
    partOfSpeech: 'informal preposition',
    definition: 'Short form of "until".',
    example: 'Wait til I call you.'
  },
  em: {
    partOfSpeech: 'informal pronoun',
    definition: 'Casual pronunciation of "them".',
    example: 'Tell em the news.'
  }
};

// Words where the API returns incomplete definitions (e.g., only "(of people)" instead of full definition)
// These will be used when we detect the API returned incomplete data
const INCOMPLETE_API_FALLBACK = {
  good: {
    phonetic: '/ɡʊd/',
    partOfSpeech: 'adjective',
    definitions: [
      { definition: 'Of a high quality, standard, or level.', example: 'This is a good book.' },
      { definition: 'Morally right; virtuous.', example: 'He is a good person.' },
      { definition: 'Skilled at doing something.', example: 'She is good at math.' },
      { definition: 'Enjoyable or satisfying.', example: 'We had a good time.' },
      { definition: 'Appropriate or suitable.', example: 'Is this a good time to talk?' }
    ]
  },
  bad: {
    phonetic: '/bæd/',
    partOfSpeech: 'adjective',
    definitions: [
      { definition: 'Of poor quality or low standard.', example: 'This is a bad idea.' },
      { definition: 'Not morally acceptable.', example: 'Lying is bad.' },
      { definition: 'Serious or severe.', example: 'The accident was bad.' },
      { definition: 'Unwell or in pain.', example: 'I feel bad today.' }
    ]
  }
};

const CONTRACTION_EXCEPTIONS = {
  "let's": {
    expansions: ['let us'],
    example: "Let's go for a walk."
  },
  "ain't": {
    expansions: ['am not', 'is not', 'are not', 'has not', 'have not'],
    example: "This ain't over yet."
  },
  "can't": {
    expansions: ['can not'],
    example: "I can't swim."
  },
  "shan't": {
    expansions: ['shall not'],
    example: "I shan't forget this."
  },
  "won't": {
    expansions: ['will not'],
    example: "He won't join us."
  }
};

const CONTRACTION_SUFFIX_RULES = [
  {
    suffix: "n't",
    build(base) {
      if (!base) return null;
      return [`${base} not`];
    }
  },
  {
    suffix: "'re",
    build(base) {
      if (!base) return null;
      return [`${base} are`];
    }
  },
  {
    suffix: "'ve",
    build(base) {
      if (!base) return null;
      return [`${base} have`];
    }
  },
  {
    suffix: "'ll",
    build(base) {
      if (!base) return null;
      return [`${base} will`];
    }
  },
  {
    suffix: "'d",
    build(base) {
      if (!base) return null;
      return [`${base} would`, `${base} had`];
    }
  },
  {
    suffix: "'m",
    build(base) {
      if (!base) return null;
      return [`${base} am`];
    }
  },
  {
    suffix: "'s",
    build(base) {
      if (!base) return null;
      if (base === 'let') {
        return ['let us'];
      }
      return [`${base} is`, `${base} has`];
    }
  }
];

/**
 * Process request queue with rate limiting
 */
async function processQueue() {
  if (isProcessingQueue || REQUEST_QUEUE.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (REQUEST_QUEUE.length > 0) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
      const waitTime = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    const { word, resolve, reject } = REQUEST_QUEUE.shift();
    lastRequestTime = Date.now();

    try {
      const result = await fetchFromApiDirect(word);
      resolve(result);
    } catch (err) {
      reject(err);
    }
  }

  isProcessingQueue = false;
}

/**
 * Add request to queue with rate limiting
 */
function fetchFromApi(word) {
  return new Promise((resolve, reject) => {
    REQUEST_QUEUE.push({ word, resolve, reject });
    processQueue();
  });
}

/**
 * Direct API call without rate limiting
 */
function fetchFromApiDirect(word, retryCount = 0) {
  const apiUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const url = require('url');
  const parsedUrl = url.parse(apiUrl);

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.path,
    method: 'GET',
    family: 4, // Force IPv4
    timeout: 10000, // 10 second timeout
  };

  return new Promise((resolve, reject) => {
    const req = https
      .get(options, (res) => {
        const { statusCode } = res;

        if (statusCode !== 200) {
          res.resume(); // Drain response to free memory

          // Handle 429 (rate limit) with exponential backoff
          if (statusCode === 429 && retryCount < 3) {
            const retryDelay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
            console.log(`[Dictionary] Rate limited (429), retrying in ${retryDelay}ms (attempt ${retryCount + 1}/3)`);
            setTimeout(() => {
              fetchFromApiDirect(word, retryCount + 1)
                .then(resolve)
                .catch(reject);
            }, retryDelay);
            return;
          }

          const err = new Error(statusCode === 404 ? 'WORD_NOT_FOUND' : 'DICTIONARY_ERROR');
          err.statusCode = statusCode;
          return reject(err);
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const payload = JSON.parse(body);
            resolve(payload);
          } catch (parseErr) {
            reject(parseErr);
          }
        });
      })
      .on('error', (err) => reject(err))
      .on('timeout', () => {
        req.destroy();
        reject(new Error('DICTIONARY_TIMEOUT'));
      });
  });
}

async function lookup(wordRaw, options = {}) {
  if (!wordRaw) {
    const err = new Error('INVALID_WORD');
    err.statusCode = 400;
    throw err;
  }

  const word = wordRaw.toLowerCase();
  const allowCommon = !!options.allowCommon;
  const persist = options.persist !== false;
  const cacheEntry = (entry) => {
    if (persist) CACHE.set(word, { entry, expiresAt: Date.now() + CACHE_TTL_MS });
  };

  const curated = getCuratedEntry(word);
  if (curated) {
    const entry = {
      word,
      phonetic: formatPhoneticForApi(curated.phonetic),
      phonetics: [{ text: formatPhoneticForApi(curated.phonetic) }],
      partOfSpeech: curated.partOfSpeech,
      meanings: normalizeDefinitions(curated.meanings),
      origin: 'linglish-curated',
      license: { name: 'Linglish curated learner dictionary' },
      sourceUrls: ['https://www.example.com/learn/words'],
    };
    cacheEntry(entry);
    return { fromCache: false, entry };
  }

  // Skip common words to reduce API load
  if (!allowCommon && SKIP_WORDS.has(word)) {
    console.log(`[Dictionary] Skipping common word: ${word}`);
    const fallbackEntry = buildFallbackEntry(word);
    if (fallbackEntry) {
      cacheEntry(fallbackEntry);
      return { fromCache: false, entry: fallbackEntry };
    }
    const err = new Error('WORD_NOT_FOUND');
    err.statusCode = 404;
    throw err;
  }

  // 1) In-memory cache
  const cached = CACHE.get(word);
  if (cached && cached.expiresAt > Date.now()) {
    // Check if cached entry has incomplete definitions and we have a fallback
    const fallbackData = INCOMPLETE_API_FALLBACK[word];
    if (fallbackData && hasIncompleteDefinitions(cached.entry)) {
      console.log(`[Dictionary] Cached entry for "${word}" has incomplete definitions, using fallback`);
      const fallbackEntry = createFallbackEntry(word, fallbackData);
      cacheEntry(fallbackEntry);
      return { fromCache: false, entry: fallbackEntry };
    }
    return { fromCache: true, entry: cached.entry };
  }

  // 2) Database cache
  try {
    if (dataStore && dataStore.isDatabaseAvailable && dataStore.isDatabaseAvailable()) {
      const row = await dataStore.getDictionaryCache(word);
      if (row && row.entry) {
        // Check if DB cached entry has incomplete definitions and we have a fallback
        const fallbackData = INCOMPLETE_API_FALLBACK[word];
        if (fallbackData && hasIncompleteDefinitions(row.entry)) {
          console.log(`[Dictionary] DB cached entry for "${word}" has incomplete definitions, using fallback`);
          const fallbackEntry = createFallbackEntry(word, fallbackData);
          cacheEntry(fallbackEntry);
          return { fromCache: false, entry: fallbackEntry };
        }
        // Refresh in-memory cache for faster subsequent hits
        cacheEntry(row.entry);
        return { fromCache: true, entry: row.entry };
      }
    }
  } catch(_) {}

  let payload;
  try {
    payload = await fetchFromApi(word);
  } catch (err) {
    if (err.message === 'WORD_NOT_FOUND') {
      const fallbackEntry = buildFallbackEntry(word);
      if (fallbackEntry) {
        cacheEntry(fallbackEntry);
        return { fromCache: false, entry: fallbackEntry };
      }
    }
    // If rate limited after retries, try to return a fallback
    if (err.statusCode === 429) {
      console.log(`[Dictionary] Rate limit exceeded for "${word}", trying fallback`);
      const fallbackEntry = buildFallbackEntry(word);
      if (fallbackEntry) {
        cacheEntry(fallbackEntry);
        return { fromCache: false, entry: fallbackEntry };
      }
    }
    throw err;
  }

  // Merge all entries from the API response
  // Some words (like "made") return multiple entries with different meanings
  // We need to combine them all for a complete definition
  let entry = mergeApiEntries(payload);
  if (!entry) {
    const err = new Error('WORD_NOT_FOUND');
    err.statusCode = 404;
    throw err;
  }

  // Check if API returned incomplete definitions (e.g., only "(of people)" instead of real definition)
  // If so, use fallback definitions
  const fallbackData = INCOMPLETE_API_FALLBACK[word];
  if (fallbackData && hasIncompleteDefinitions(entry)) {
    console.log(`[Dictionary] API returned incomplete definitions for "${word}", using fallback`);
    entry = createFallbackEntry(word, fallbackData);
    cacheEntry(entry);
    return { fromCache: false, entry };
  }

  cacheEntry(entry);
  // Persist to DB cache (best-effort)
  try {
    if (persist && dataStore && dataStore.isDatabaseAvailable && dataStore.isDatabaseAvailable()) {
      await dataStore.upsertDictionaryCache(word, entry);
    }
  } catch (_) {}

  return { fromCache: false, entry };
}

module.exports = {
  lookup,
  resolveEntry,
};

function buildFallbackEntry(word) {
  if (!word) {
    return null;
  }

  const normalized = word.toLowerCase();
  if (FALLBACK_SLANG[normalized]) {
    return createFallbackEntry(normalized, FALLBACK_SLANG[normalized]);
  }

  if (!normalized.includes("'")) {
    return null;
  }

  const contractionData = buildContractionEntry(normalized);
  if (!contractionData) {
    return null;
  }

  return createFallbackEntry(normalized, contractionData);
}

function buildContractionEntry(word) {
  const exception = CONTRACTION_EXCEPTIONS[word];
  if (exception) {
    const definition = formatContractionDefinition(word, exception.expansions);
    if (!definition) {
      return null;
    }
    return {
      partOfSpeech: 'contraction',
      definition,
      example: exception.example,
    };
  }

  for (const rule of CONTRACTION_SUFFIX_RULES) {
    if (!word.endsWith(rule.suffix)) {
      continue;
    }
    const base = word.slice(0, word.length - rule.suffix.length);
    if (!base) {
      continue;
    }
    const expansions = rule.build(base, word);
    if (!expansions || !expansions.length) {
      continue;
    }
    const definition = formatContractionDefinition(word, expansions);
    if (!definition) {
      continue;
    }
    return {
      partOfSpeech: 'contraction',
      definition,
    };
  }

  return null;
}

function formatContractionDefinition(word, expansions) {
  if (!Array.isArray(expansions) || !expansions.length) {
    return null;
  }
  const unique = Array.from(new Set(expansions.filter(Boolean)));
  if (!unique.length) {
    return null;
  }
  const expansionText = unique.map((exp) => `"${exp}"`).join(' or ');
  return `The contraction "${word}" stands for ${expansionText}.`;
}

/**
 * Merge multiple API entries into a single entry
 * The dictionary API sometimes returns multiple entries for the same word
 * (e.g., "made" returns one entry with noun meaning and another with verb meanings)
 * We need to combine all meanings for a complete definition
 *
 * Also prioritizes common meanings over rare/archaic ones
 */
function mergeApiEntries(payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  // If only one entry, return it directly
  if (payload.length === 1) {
    return sortMeaningsByRelevance(payload[0]);
  }

  // Use first entry as base
  const merged = { ...payload[0] };

  // Collect all meanings from all entries
  const allMeanings = [];
  for (const entry of payload) {
    if (entry.meanings && Array.isArray(entry.meanings)) {
      allMeanings.push(...entry.meanings);
    }

    // Also merge phonetics if current entry has better phonetic info
    if (!merged.phonetic && entry.phonetic) {
      merged.phonetic = entry.phonetic;
    }
    if ((!merged.phonetics || merged.phonetics.length === 0) && entry.phonetics && entry.phonetics.length > 0) {
      merged.phonetics = entry.phonetics;
    }
  }

  // Deduplicate and merge meanings by partOfSpeech
  const meaningsByPos = new Map();
  for (const meaning of allMeanings) {
    const pos = meaning.partOfSpeech || 'unknown';
    if (!meaningsByPos.has(pos)) {
      meaningsByPos.set(pos, {
        partOfSpeech: pos,
        definitions: [],
        synonyms: meaning.synonyms || [],
        antonyms: meaning.antonyms || []
      });
    }

    const existing = meaningsByPos.get(pos);

    // Add definitions, avoiding duplicates
    if (meaning.definitions && Array.isArray(meaning.definitions)) {
      for (const def of meaning.definitions) {
        const defText = def.definition || '';
        const isDuplicate = existing.definitions.some(d =>
          (d.definition || '').toLowerCase() === defText.toLowerCase()
        );
        if (!isDuplicate && defText) {
          existing.definitions.push(def);
        }
      }
    }

    // Merge synonyms and antonyms
    if (meaning.synonyms) {
      existing.synonyms = [...new Set([...existing.synonyms, ...meaning.synonyms])];
    }
    if (meaning.antonyms) {
      existing.antonyms = [...new Set([...existing.antonyms, ...meaning.antonyms])];
    }
  }

  merged.meanings = Array.from(meaningsByPos.values());

  // Sort meanings by relevance (common parts of speech first)
  return sortMeaningsByRelevance(merged);
}

/**
 * Sort meanings to prioritize common/useful definitions over rare ones
 * Also filters out extremely rare definitions that might confuse learners
 */
function sortMeaningsByRelevance(entry) {
  if (!entry || !entry.meanings) return entry;
  // Keep provider meaning/POS order. The shared parser only moves definitions
  // explicitly marked archaic, specialist, collective, or rhythmic later.
  entry.meanings = normalizeDefinitions(entry.meanings);
  return entry;
}

function createFallbackEntry(word, data) {
  if (!data) {
    return null;
  }

  const definitionsSource = Array.isArray(data.definitions) && data.definitions.length
    ? data.definitions
    : [{ definition: data.definition, example: data.example }];

  const definitions = definitionsSource
    .filter((item) => item && item.definition)
    .map((item) => {
      if (item.example) {
        return { definition: item.definition, example: item.example };
      }
      return { definition: item.definition };
    });

  if (!definitions.length) {
    return null;
  }

  return {
    word,
    phonetic: data.phonetic || '',
    phonetics: data.phonetics || [],
    origin: 'linglish-fallback',
    license: data.license || { name: 'linglish Fallback' },
    sourceUrls: data.sourceUrls || ['https://linglish.local/fallback'],
    meanings: [
      {
        partOfSpeech: data.partOfSpeech || 'expression',
        definitions,
      },
    ],
  };
}

/**
 * Check if the API returned incomplete definitions
 * Some words like "good" return definitions that are just category labels like "(of people)"
 * instead of actual definitions
 */
function hasIncompleteDefinitions(entry) {
  if (!entry || !entry.meanings || !Array.isArray(entry.meanings)) {
    return false;
  }

  // Check the first few definitions to see if they're incomplete
  let incompleteCount = 0;
  let totalCount = 0;

  for (const meaning of entry.meanings.slice(0, 2)) {
    if (!meaning.definitions || !Array.isArray(meaning.definitions)) continue;

    for (const def of meaning.definitions.slice(0, 4)) {
      totalCount++;
      const defText = (def.definition || '').trim();

      // Check for incomplete definition patterns:
      // 1. Starts with "(" and is short (like "(of people)")
      // 2. Only contains parenthetical content
      // 3. Very short definition (less than 20 chars) that looks like a category label
      if (
        (defText.startsWith('(') && defText.length < 50) ||
        /^\([^)]+\)$/.test(defText) ||
        (defText.length < 20 && /^\(/.test(defText))
      ) {
        incompleteCount++;
      }
    }
  }

  // If more than half of the checked definitions are incomplete, consider the entry incomplete
  return totalCount > 0 && incompleteCount / totalCount > 0.5;
}
