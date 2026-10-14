/**
 * Lemmatizer Service
 *
 * Provides word root extraction (lemmatization) for English words.
 * Uses a combination of:
 * 1. Irregular verb/noun lookup table
 * 2. Rule-based suffix stripping
 * 3. Fallback to lowercase original form
 *
 * Returns lemma with source and confidence:
 * - source: 'dictionary' (irregular lookup), 'rules' (suffix rules), 'fallback' (no change)
 * - confidence: 0.5-1.0 indicating reliability of lemmatization
 */

// Common irregular verbs: past tense/past participle -> base form
const IRREGULAR_VERBS = {
  // be
  'am': 'be', 'is': 'be', 'are': 'be', 'was': 'be', 'were': 'be', 'been': 'be', 'being': 'be',
  // have
  'has': 'have', 'had': 'have', 'having': 'have',
  // do
  'does': 'do', 'did': 'do', 'done': 'do', 'doing': 'do',
  // go
  'goes': 'go', 'went': 'go', 'gone': 'go', 'going': 'go',
  // say
  'says': 'say', 'said': 'say', 'saying': 'say',
  // make
  'makes': 'make', 'made': 'make', 'making': 'make',
  // get
  'gets': 'get', 'got': 'get', 'gotten': 'get', 'getting': 'get',
  // know
  'knows': 'know', 'knew': 'know', 'known': 'know', 'knowing': 'know',
  // think
  'thinks': 'think', 'thought': 'think', 'thinking': 'think',
  // take
  'takes': 'take', 'took': 'take', 'taken': 'take', 'taking': 'take',
  // see
  'sees': 'see', 'saw': 'see', 'seen': 'see', 'seeing': 'see',
  // come
  'comes': 'come', 'came': 'come', 'coming': 'come',
  // give
  'gives': 'give', 'gave': 'give', 'given': 'give', 'giving': 'give',
  // find
  'finds': 'find', 'found': 'find', 'finding': 'find',
  // tell
  'tells': 'tell', 'told': 'tell', 'telling': 'tell',
  // become
  'becomes': 'become', 'became': 'become', 'becoming': 'become',
  // leave
  'leaves': 'leave', 'left': 'leave', 'leaving': 'leave',
  // put
  'puts': 'put', 'putting': 'put',
  // keep
  'keeps': 'keep', 'kept': 'keep', 'keeping': 'keep',
  // let
  'lets': 'let', 'letting': 'let',
  // begin
  'begins': 'begin', 'began': 'begin', 'begun': 'begin', 'beginning': 'begin',
  // seem
  'seems': 'seem', 'seemed': 'seem', 'seeming': 'seem',
  // hold
  'holds': 'hold', 'held': 'hold', 'holding': 'hold',
  // bring
  'brings': 'bring', 'brought': 'bring', 'bringing': 'bring',
  // write
  'writes': 'write', 'wrote': 'write', 'written': 'write', 'writing': 'write',
  // sit
  'sits': 'sit', 'sat': 'sit', 'sitting': 'sit',
  // stand
  'stands': 'stand', 'stood': 'stand', 'standing': 'stand',
  // hear
  'hears': 'hear', 'heard': 'hear', 'hearing': 'hear',
  // lose
  'loses': 'lose', 'lost': 'lose', 'losing': 'lose',
  // meet
  'meets': 'meet', 'met': 'meet', 'meeting': 'meet',
  // run
  'runs': 'run', 'ran': 'run', 'running': 'run',
  // pay
  'pays': 'pay', 'paid': 'pay', 'paying': 'pay',
  // feel
  'feels': 'feel', 'felt': 'feel', 'feeling': 'feel',
  // read
  'reads': 'read', 'reading': 'read', // 'read' past tense same spelling
  // spend
  'spends': 'spend', 'spent': 'spend', 'spending': 'spend',
  // grow
  'grows': 'grow', 'grew': 'grow', 'grown': 'grow', 'growing': 'grow',
  // win
  'wins': 'win', 'won': 'win', 'winning': 'win',
  // teach
  'teaches': 'teach', 'taught': 'teach', 'teaching': 'teach',
  // buy
  'buys': 'buy', 'bought': 'buy', 'buying': 'buy',
  // send
  'sends': 'send', 'sent': 'send', 'sending': 'send',
  // build
  'builds': 'build', 'built': 'build', 'building': 'build',
  // fall
  'falls': 'fall', 'fell': 'fall', 'fallen': 'fall', 'falling': 'fall',
  // cut
  'cuts': 'cut', 'cutting': 'cut',
  // sell
  'sells': 'sell', 'sold': 'sell', 'selling': 'sell',
  // speak
  'speaks': 'speak', 'spoke': 'speak', 'spoken': 'speak', 'speaking': 'speak',
  // break
  'breaks': 'break', 'broke': 'break', 'broken': 'break', 'breaking': 'break',
  // drive
  'drives': 'drive', 'drove': 'drive', 'driven': 'drive', 'driving': 'drive',
  // eat
  'eats': 'eat', 'ate': 'eat', 'eaten': 'eat', 'eating': 'eat',
  // drink
  'drinks': 'drink', 'drank': 'drink', 'drunk': 'drink', 'drinking': 'drink',
  // draw
  'draws': 'draw', 'drew': 'draw', 'drawn': 'draw', 'drawing': 'draw',
  // fly
  'flies': 'fly', 'flew': 'fly', 'flown': 'fly', 'flying': 'fly',
  // rise
  'rises': 'rise', 'rose': 'rise', 'risen': 'rise', 'rising': 'rise',
  // sing
  'sings': 'sing', 'sang': 'sing', 'sung': 'sing', 'singing': 'sing',
  // swim
  'swims': 'swim', 'swam': 'swim', 'swum': 'swim', 'swimming': 'swim',
  // throw
  'throws': 'throw', 'threw': 'throw', 'thrown': 'throw', 'throwing': 'throw',
  // catch
  'catches': 'catch', 'caught': 'catch', 'catching': 'catch',
  // choose
  'chooses': 'choose', 'chose': 'choose', 'chosen': 'choose', 'choosing': 'choose',
  // wear
  'wears': 'wear', 'wore': 'wear', 'worn': 'wear', 'wearing': 'wear',
  // forget
  'forgets': 'forget', 'forgot': 'forget', 'forgotten': 'forget', 'forgetting': 'forget',
  // hide
  'hides': 'hide', 'hid': 'hide', 'hidden': 'hide', 'hiding': 'hide',
  // bite
  'bites': 'bite', 'bit': 'bite', 'bitten': 'bite', 'biting': 'bite',
  // beat
  'beats': 'beat', 'beaten': 'beat', 'beating': 'beat',
  // blow
  'blows': 'blow', 'blew': 'blow', 'blown': 'blow', 'blowing': 'blow',
  // lead
  'leads': 'lead', 'led': 'lead', 'leading': 'lead',
  // lie
  'lies': 'lie', 'lay': 'lie', 'lain': 'lie', 'lying': 'lie', // lie down
  // lay
  'lays': 'lay', 'laid': 'lay', 'laying': 'lay', // lay something
  // set
  'sets': 'set', 'setting': 'set',
  // shut
  'shuts': 'shut', 'shutting': 'shut',
  // hurt
  'hurts': 'hurt', 'hurting': 'hurt',
  // cost
  'costs': 'cost', 'costing': 'cost',
  // shake
  'shakes': 'shake', 'shook': 'shake', 'shaken': 'shake', 'shaking': 'shake',
  // wake
  'wakes': 'wake', 'woke': 'wake', 'woken': 'wake', 'waking': 'wake',
  // ride
  'rides': 'ride', 'rode': 'ride', 'ridden': 'ride', 'riding': 'ride',
  // fight
  'fights': 'fight', 'fought': 'fight', 'fighting': 'fight',
  // light
  'lights': 'light', 'lit': 'light', 'lighting': 'light',
  // mean
  'means': 'mean', 'meant': 'mean', 'meaning': 'mean',
  // show
  'shows': 'show', 'showed': 'show', 'shown': 'show', 'showing': 'show',
  // understand
  'understands': 'understand', 'understood': 'understand', 'understanding': 'understand',
  // sleep
  'sleeps': 'sleep', 'slept': 'sleep', 'sleeping': 'sleep',
  // seek
  'seeks': 'seek', 'sought': 'seek', 'seeking': 'seek',
  // deal
  'deals': 'deal', 'dealt': 'deal', 'dealing': 'deal',
  // learn
  'learns': 'learn', 'learnt': 'learn', 'learned': 'learn', 'learning': 'learn',
  // dream
  'dreams': 'dream', 'dreamt': 'dream', 'dreamed': 'dream', 'dreaming': 'dream',
  // burn
  'burns': 'burn', 'burnt': 'burn', 'burned': 'burn', 'burning': 'burn',
  // smell
  'smells': 'smell', 'smelt': 'smell', 'smelled': 'smell', 'smelling': 'smell',
  // spell
  'spells': 'spell', 'spelt': 'spell', 'spelled': 'spell', 'spelling': 'spell',
  // spoil
  'spoils': 'spoil', 'spoilt': 'spoil', 'spoiled': 'spoil', 'spoiling': 'spoil',
};

// Common irregular nouns: plural -> singular
const IRREGULAR_NOUNS = {
  'children': 'child',
  'men': 'man',
  'women': 'woman',
  'feet': 'foot',
  'teeth': 'tooth',
  'geese': 'goose',
  'mice': 'mouse',
  'lice': 'louse',
  'people': 'person',
  'oxen': 'ox',
  'cacti': 'cactus',
  'foci': 'focus',
  'fungi': 'fungus',
  'nuclei': 'nucleus',
  'syllabi': 'syllabus',
  'analyses': 'analysis',
  'diagnoses': 'diagnosis',
  'theses': 'thesis',
  'crises': 'crisis',
  'phenomena': 'phenomenon',
  'criteria': 'criterion',
  'data': 'datum',
  'media': 'medium',
  'bacteria': 'bacterium',
  'curricula': 'curriculum',
  'memoranda': 'memorandum',
  'strata': 'stratum',
  'alumni': 'alumnus',
  'stimuli': 'stimulus',
  'indices': 'index',
  'appendices': 'appendix',
  'matrices': 'matrix',
  'vertices': 'vertex',
  'axes': 'axis',
  'basis': 'basis', // same singular/plural in common usage
  'series': 'series',
  'species': 'species',
  'news': 'news',
  'mathematics': 'mathematics',
  'physics': 'physics',
  'economics': 'economics',
  'politics': 'politics',
  'athletics': 'athletics',
};

// Words that should not be lemmatized (keep as-is)
const EXCEPTIONS = new Set([
  // Common words that look like they have suffixes but don't
  'this', 'that', 'was', 'his', 'has', 'does', 'goes', 'is', 'us', 'as', 'yes', 'bus', 'gas',
  'plus', 'thus', 'virus', 'bonus', 'campus', 'census', 'circus', 'citrus', 'focus', 'genus',
  'minus', 'nexus', 'radius', 'status', 'versus', 'walrus', 'cactus', 'fungus', 'genius',
  // -ing words that are nouns, not verbs
  'thing', 'king', 'ring', 'spring', 'string', 'sing', 'bring', 'wing', 'swing', 'sting',
  'morning', 'evening', 'feeling', 'building', 'meeting', 'ceiling', 'meaning', 'beginning',
  'nothing', 'something', 'everything', 'anything', 'during', 'being',
  // -ed words that are adjectives, not past tense
  'red', 'bed', 'fed', 'led', 'wed', 'shed', 'hundred', 'wicked', 'naked', 'sacred',
  // -ly words that are adjectives, not adverbs
  'only', 'early', 'likely', 'lonely', 'lovely', 'friendly', 'elderly', 'weekly', 'daily',
  'monthly', 'yearly', 'deadly', 'ugly', 'silly', 'holy', 'costly', 'ghostly', 'manly',
  // -er words that are nouns, not comparatives
  'water', 'matter', 'letter', 'better', 'center', 'winter', 'sister', 'brother', 'mother',
  'father', 'other', 'another', 'together', 'whether', 'either', 'neither', 'rather',
  'teacher', 'officer', 'computer', 'manager', 'customer', 'member', 'number', 'player',
  'power', 'answer', 'order', 'paper', 'river', 'cover', 'corner', 'finger', 'dinner',
  'summer', 'never', 'ever', 'over', 'under', 'after', 'later', 'quarter', 'chapter',
  // -est words that are not superlatives
  'west', 'best', 'test', 'rest', 'nest', 'forest', 'interest', 'protest', 'contest',
  'request', 'suggest', 'invest', 'harvest', 'honest', 'modest',
]);

// Vowels for phonetic rules
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/**
 * Check if a character is a vowel
 */
function isVowel(char) {
  return VOWELS.has(char.toLowerCase());
}

/**
 * Check if word ends with consonant-vowel-consonant pattern
 * Used for doubling consonant rules (run -> running, stop -> stopped)
 */
function endsCVC(word) {
  if (word.length < 3) return false;
  const last3 = word.slice(-3).toLowerCase();
  return !isVowel(last3[0]) && isVowel(last3[1]) && !isVowel(last3[2]) && last3[2] !== 'w' && last3[2] !== 'x' && last3[2] !== 'y';
}

/**
 * Rule-based lemmatization with suffix stripping
 */
function applyRules(word) {
  const w = word.toLowerCase();

  // -ing removal
  if (w.endsWith('ing') && w.length > 4) {
    // doubling: running -> run
    if (w.length > 5 && w[w.length - 4] === w[w.length - 5]) {
      return w.slice(0, -4);
    }
    // -ying -> -y: studying -> study
    if (w.endsWith('ying')) {
      return w.slice(0, -4) + 'y';
    }
    // -eing: seeing -> see, being -> be
    if (w.endsWith('eing')) {
      return w.slice(0, -3);
    }
    // -ving: having -> have, giving -> give
    if (w.endsWith('ving')) {
      return w.slice(0, -3) + 'e';
    }
    // -ing -> -e: making -> make, taking -> take
    // Check if base + e forms a valid pattern
    const baseWithE = w.slice(0, -3) + 'e';
    if (baseWithE.length >= 3) {
      return baseWithE;
    }
    // Default: just remove -ing
    return w.slice(0, -3);
  }

  // -ed removal
  if (w.endsWith('ed') && w.length > 3) {
    // -ied -> -y: studied -> study
    if (w.endsWith('ied')) {
      return w.slice(0, -3) + 'y';
    }
    // doubling: stopped -> stop
    if (w.length > 4 && w[w.length - 3] === w[w.length - 4]) {
      return w.slice(0, -3);
    }
    // -ed after consonant: walked -> walk, asked -> ask
    if (!isVowel(w[w.length - 3])) {
      return w.slice(0, -2);
    }
    // -ed -> -e: liked -> like, moved -> move
    return w.slice(0, -1);
  }

  // -s/-es removal (plural nouns and 3rd person verbs)
  if (w.endsWith('s') && w.length > 2) {
    // -ies -> -y: studies -> study
    if (w.endsWith('ies') && w.length > 4) {
      return w.slice(0, -3) + 'y';
    }
    // -es after s, x, z, ch, sh: watches -> watch
    if (w.endsWith('es') && w.length > 3) {
      const beforeEs = w.slice(-3, -2);
      if (['s', 'x', 'z'].includes(beforeEs) || w.endsWith('ches') || w.endsWith('shes')) {
        return w.slice(0, -2);
      }
      // -oes: goes -> go, does -> do (handled by irregular)
      if (w.endsWith('oes')) {
        return w.slice(0, -2);
      }
      // -ves -> -f/-fe: leaves -> leaf, knives -> knife
      if (w.endsWith('ves') && w.length > 4) {
        const base = w.slice(0, -3);
        // Try -f first
        return base + 'f';
      }
    }
    // -ss: don't remove (class, boss, miss)
    if (w.endsWith('ss')) {
      return w;
    }
    // Default: remove -s
    return w.slice(0, -1);
  }

  // -er removal (comparative)
  if (w.endsWith('er') && w.length > 3) {
    // -ier -> -y: happier -> happy
    if (w.endsWith('ier') && w.length > 4) {
      return w.slice(0, -3) + 'y';
    }
    // doubling: bigger -> big
    if (w.length > 4 && w[w.length - 3] === w[w.length - 4]) {
      return w.slice(0, -3);
    }
    // Skip common -er nouns (handled in EXCEPTIONS)
  }

  // -est removal (superlative)
  if (w.endsWith('est') && w.length > 4) {
    // -iest -> -y: happiest -> happy
    if (w.endsWith('iest') && w.length > 5) {
      return w.slice(0, -4) + 'y';
    }
    // doubling: biggest -> big
    if (w.length > 5 && w[w.length - 4] === w[w.length - 5]) {
      return w.slice(0, -4);
    }
  }

  // -ly removal (adverb to adjective)
  if (w.endsWith('ly') && w.length > 3) {
    // -ily -> -y: happily -> happy
    if (w.endsWith('ily') && w.length > 4) {
      return w.slice(0, -3) + 'y';
    }
    // -ally -> -al: basically -> basic (but keep -al for adjectives)
    if (w.endsWith('ally') && w.length > 5) {
      return w.slice(0, -2);
    }
    // Default: remove -ly
    if (w.length > 4) {
      return w.slice(0, -2);
    }
  }

  // No rule matched
  return null;
}

/**
 * Main lemmatization function
 *
 * @param {string} word - The word to lemmatize
 * @param {string} clientLemma - Optional client-side guess (used as fallback)
 * @returns {{lemma: string, source: string, confidence: number}}
 */
function lemmatize(word, clientLemma = null) {
  if (!word || typeof word !== 'string') {
    return {
      lemma: '',
      source: 'fallback',
      confidence: 0
    };
  }

  // Clean and normalize
  const cleaned = word.trim();
  if (!cleaned) {
    return {
      lemma: '',
      source: 'fallback',
      confidence: 0
    };
  }

  const lower = cleaned.toLowerCase();

  // 1. Check exceptions (return as-is)
  if (EXCEPTIONS.has(lower)) {
    return {
      lemma: lower,
      source: 'dictionary',
      confidence: 1.0
    };
  }

  // 2. Check irregular verbs
  if (IRREGULAR_VERBS[lower]) {
    return {
      lemma: IRREGULAR_VERBS[lower],
      source: 'dictionary',
      confidence: 1.0
    };
  }

  // 3. Check irregular nouns
  if (IRREGULAR_NOUNS[lower]) {
    return {
      lemma: IRREGULAR_NOUNS[lower],
      source: 'dictionary',
      confidence: 1.0
    };
  }

  // 4. Apply rule-based lemmatization
  const ruleResult = applyRules(lower);
  if (ruleResult && ruleResult !== lower && ruleResult.length >= 2) {
    return {
      lemma: ruleResult,
      source: 'rules',
      confidence: 0.85
    };
  }

  // 5. Fallback: use client guess or lowercase original
  if (clientLemma && typeof clientLemma === 'string' && clientLemma.trim()) {
    return {
      lemma: clientLemma.toLowerCase().trim(),
      source: 'fallback',
      confidence: 0.5
    };
  }

  return {
    lemma: lower,
    source: 'fallback',
    confidence: 0.5
  };
}

/**
 * Batch lemmatization for multiple words
 *
 * @param {string[]} words - Array of words to lemmatize
 * @returns {Array<{original: string, lemma: string, source: string, confidence: number}>}
 */
function lemmatizeBatch(words) {
  if (!Array.isArray(words)) {
    return [];
  }

  return words.map(word => {
    const result = lemmatize(word);
    return {
      original: word,
      ...result
    };
  });
}

/**
 * Simple client-side lemmatization (for frontend use)
 * Covers ~80% of common cases with minimal logic
 */
function simpleLemma(word) {
  if (!word || typeof word !== 'string') return '';

  const w = word.toLowerCase().trim();
  if (w.length < 3) return w;

  // Quick irregular checks
  if (IRREGULAR_VERBS[w]) return IRREGULAR_VERBS[w];
  if (IRREGULAR_NOUNS[w]) return IRREGULAR_NOUNS[w];

  // Simple suffix rules
  if (w.endsWith('ing') && w.length > 4) {
    if (w[w.length - 4] === w[w.length - 5]) return w.slice(0, -4);
    return w.slice(0, -3);
  }
  if (w.endsWith('ed') && w.length > 3) {
    if (w.endsWith('ied')) return w.slice(0, -3) + 'y';
    return w.slice(0, -2);
  }
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 2) {
    if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
    if (w.endsWith('es') && w.length > 3) return w.slice(0, -2);
    return w.slice(0, -1);
  }

  return w;
}

module.exports = {
  lemmatize,
  lemmatizeBatch,
  simpleLemma,
  IRREGULAR_VERBS,
  IRREGULAR_NOUNS,
  EXCEPTIONS
};
