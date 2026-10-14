/**
 * Smart Import API Client
 *
 * Provides frontend interface for smart vocabulary import during video watching.
 * Handles session management, event recording, and import confirmation.
 */

const SmartImportAPI = (function() {
  'use strict';

  const API_BASE = '';

  // ============================================================================
  // Client-side Lemmatization (quick preview, server is authoritative)
  // ============================================================================

  // Common irregular verbs
  const IRREGULAR_VERBS = {
    'am': 'be', 'is': 'be', 'are': 'be', 'was': 'be', 'were': 'be', 'been': 'be', 'being': 'be',
    'has': 'have', 'had': 'have', 'having': 'have',
    'does': 'do', 'did': 'do', 'done': 'do', 'doing': 'do',
    'goes': 'go', 'went': 'go', 'gone': 'go', 'going': 'go',
    'says': 'say', 'said': 'say', 'saying': 'say',
    'makes': 'make', 'made': 'make', 'making': 'make',
    'knows': 'know', 'knew': 'know', 'known': 'know', 'knowing': 'know',
    'thinks': 'think', 'thought': 'think', 'thinking': 'think',
    'takes': 'take', 'took': 'take', 'taken': 'take', 'taking': 'take',
    'sees': 'see', 'saw': 'see', 'seen': 'see', 'seeing': 'see',
    'comes': 'come', 'came': 'come', 'coming': 'come',
    'wants': 'want', 'wanted': 'want', 'wanting': 'want',
    'gets': 'get', 'got': 'get', 'gotten': 'get', 'getting': 'get',
    'gives': 'give', 'gave': 'give', 'given': 'give', 'giving': 'give',
    'tells': 'tell', 'told': 'tell', 'telling': 'tell',
    'works': 'work', 'worked': 'work', 'working': 'work',
    'feels': 'feel', 'felt': 'feel', 'feeling': 'feel',
    'leaves': 'leave', 'left': 'leave', 'leaving': 'leave',
    'puts': 'put', 'putting': 'put',
    'means': 'mean', 'meant': 'mean', 'meaning': 'mean',
    'keeps': 'keep', 'kept': 'keep', 'keeping': 'keep',
    'lets': 'let', 'letting': 'let',
    'begins': 'begin', 'began': 'begin', 'begun': 'begin', 'beginning': 'begin',
    'seems': 'seem', 'seemed': 'seem', 'seeming': 'seem',
    'helps': 'help', 'helped': 'help', 'helping': 'help',
    'shows': 'show', 'showed': 'show', 'shown': 'show', 'showing': 'show',
    'hears': 'hear', 'heard': 'hear', 'hearing': 'hear',
    'plays': 'play', 'played': 'play', 'playing': 'play',
    'runs': 'run', 'ran': 'run', 'running': 'run',
    'moves': 'move', 'moved': 'move', 'moving': 'move',
    'lives': 'live', 'lived': 'live', 'living': 'live',
    'believes': 'believe', 'believed': 'believe', 'believing': 'believe',
    'brings': 'bring', 'brought': 'bring', 'bringing': 'bring',
    'writes': 'write', 'wrote': 'write', 'written': 'write', 'writing': 'write',
    'sits': 'sit', 'sat': 'sit', 'sitting': 'sit',
    'stands': 'stand', 'stood': 'stand', 'standing': 'stand',
    'loses': 'lose', 'lost': 'lose', 'losing': 'lose',
    'pays': 'pay', 'paid': 'pay', 'paying': 'pay',
    'meets': 'meet', 'met': 'meet', 'meeting': 'meet',
    'includes': 'include', 'included': 'include', 'including': 'include',
    'continues': 'continue', 'continued': 'continue', 'continuing': 'continue',
    'sets': 'set', 'setting': 'set',
    'learns': 'learn', 'learned': 'learn', 'learnt': 'learn', 'learning': 'learn',
    'changes': 'change', 'changed': 'change', 'changing': 'change',
    'leads': 'lead', 'led': 'lead', 'leading': 'lead',
    'understands': 'understand', 'understood': 'understand', 'understanding': 'understand',
    'watches': 'watch', 'watched': 'watch', 'watching': 'watch',
    'follows': 'follow', 'followed': 'follow', 'following': 'follow',
    'stops': 'stop', 'stopped': 'stop', 'stopping': 'stop',
    'creates': 'create', 'created': 'create', 'creating': 'create',
    'speaks': 'speak', 'spoke': 'speak', 'spoken': 'speak', 'speaking': 'speak',
    'reads': 'read', 'reading': 'read',
    'spends': 'spend', 'spent': 'spend', 'spending': 'spend',
    'grows': 'grow', 'grew': 'grow', 'grown': 'grow', 'growing': 'grow',
    'opens': 'open', 'opened': 'open', 'opening': 'open',
    'walks': 'walk', 'walked': 'walk', 'walking': 'walk',
    'wins': 'win', 'won': 'win', 'winning': 'win',
    'teaches': 'teach', 'taught': 'teach', 'teaching': 'teach',
    'offers': 'offer', 'offered': 'offer', 'offering': 'offer',
    'remembers': 'remember', 'remembered': 'remember', 'remembering': 'remember',
    'considers': 'consider', 'considered': 'consider', 'considering': 'consider',
    'appears': 'appear', 'appeared': 'appear', 'appearing': 'appear',
    'buys': 'buy', 'bought': 'buy', 'buying': 'buy',
    'serves': 'serve', 'served': 'serve', 'serving': 'serve',
    'dies': 'die', 'died': 'die', 'dying': 'die',
    'sends': 'send', 'sent': 'send', 'sending': 'send',
    'builds': 'build', 'built': 'build', 'building': 'build',
    'stays': 'stay', 'stayed': 'stay', 'staying': 'stay',
    'falls': 'fall', 'fell': 'fall', 'fallen': 'fall', 'falling': 'fall',
    'cuts': 'cut', 'cutting': 'cut',
    'reaches': 'reach', 'reached': 'reach', 'reaching': 'reach',
    'kills': 'kill', 'killed': 'kill', 'killing': 'kill',
    'raises': 'raise', 'raised': 'raise', 'raising': 'raise',
    'passes': 'pass', 'passed': 'pass', 'passing': 'pass',
    'sells': 'sell', 'sold': 'sell', 'selling': 'sell',
    'decides': 'decide', 'decided': 'decide', 'deciding': 'decide',
    'returns': 'return', 'returned': 'return', 'returning': 'return',
    'explains': 'explain', 'explained': 'explain', 'explaining': 'explain',
    'hopes': 'hope', 'hoped': 'hope', 'hoping': 'hope',
    'develops': 'develop', 'developed': 'develop', 'developing': 'develop',
    'carries': 'carry', 'carried': 'carry', 'carrying': 'carry',
    'breaks': 'break', 'broke': 'break', 'broken': 'break', 'breaking': 'break',
    'receives': 'receive', 'received': 'receive', 'receiving': 'receive',
    'agrees': 'agree', 'agreed': 'agree', 'agreeing': 'agree',
    'supports': 'support', 'supported': 'support', 'supporting': 'support',
    'hits': 'hit', 'hitting': 'hit',
    'produces': 'produce', 'produced': 'produce', 'producing': 'produce',
    'eats': 'eat', 'ate': 'eat', 'eaten': 'eat', 'eating': 'eat',
    'covers': 'cover', 'covered': 'cover', 'covering': 'cover',
    'catches': 'catch', 'caught': 'catch', 'catching': 'catch',
    'draws': 'draw', 'drew': 'draw', 'drawn': 'draw', 'drawing': 'draw',
    'chooses': 'choose', 'chose': 'choose', 'chosen': 'choose', 'choosing': 'choose',
    'children': 'child',
    'men': 'man',
    'women': 'woman',
    'feet': 'foot',
    'teeth': 'tooth',
    'geese': 'goose',
    'mice': 'mouse',
    'people': 'person',
    'leaves': 'leaf',
    'lives': 'life',
    'knives': 'knife',
    'wives': 'wife',
    'halves': 'half',
    'selves': 'self',
    'shelves': 'shelf',
    'ourselves': 'ourself',
    'themselves': 'themself',
    'yourselves': 'yourself',
    'ourselves': 'ourself'
  };

  /**
   * Simple client-side lemmatization
   * Used for quick previews; server result is authoritative
   */
  function simpleLemma(word) {
    if (!word || typeof word !== 'string') return '';

    const w = word.toLowerCase().trim();
    if (w.length < 2) return w;

    // Check irregular forms first
    if (IRREGULAR_VERBS[w]) {
      return IRREGULAR_VERBS[w];
    }

    // Rule-based suffix stripping
    // Continuous tense: -ing
    if (w.endsWith('ing') && w.length > 4) {
      // doubling consonant: running -> run
      if (w.length > 5 && w[w.length - 4] === w[w.length - 5]) {
        return w.slice(0, -4);
      }
      // -ying stays
      if (w.endsWith('ying')) {
        return w.slice(0, -3) + 'y';
      }
      // -eing: e was dropped
      const base = w.slice(0, -3);
      if (base.length >= 2) {
        return base.endsWith('e') ? base : base + 'e';
      }
      return w.slice(0, -3);
    }

    // Past tense: -ed
    if (w.endsWith('ed') && w.length > 3) {
      // -ied -> -y
      if (w.endsWith('ied')) {
        return w.slice(0, -3) + 'y';
      }
      // doubled consonant: stopped -> stop
      if (w.length > 4 && w[w.length - 3] === w[w.length - 4]) {
        return w.slice(0, -3);
      }
      return w.slice(0, -2);
    }

    // Third person singular: -es, -s
    if (w.endsWith('ies') && w.length > 4) {
      return w.slice(0, -3) + 'y';
    }
    if (w.endsWith('es') && w.length > 3) {
      // -ches, -shes, -sses, -xes, -zes -> drop -es
      if (/(?:ch|sh|ss|x|z)es$/.test(w)) {
        return w.slice(0, -2);
      }
      return w.slice(0, -1);
    }
    if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) {
      return w.slice(0, -1);
    }

    return w;
  }

  // ============================================================================
  // API Functions
  // ============================================================================

  function getAuthToken() {
    // Try multiple storage locations
    const keys = ['linglish_token', 'authToken'];
    for (const key of keys) {
      const token = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (token && token !== 'null' && token !== 'undefined') {
        return token;
      }
    }
    return null;
  }

  async function apiRequest(endpoint, options = {}) {
    const token = getAuthToken();
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || `Request failed: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Start a new learning session for a video
   * @param {number} videoId - Video resource ID
   * @returns {Promise<{sessionId: string, userLevel: string, importBudget: number}>}
   */
  async function startSession(videoId, lifecycleKey) {
    console.log('[SmartImport] Starting session for video:', videoId);
    return apiRequest('/vocabulary/v2/smart-import/start-session', {
      method: 'POST',
      body: JSON.stringify({ videoId, lifecycleKey })
    });
  }

  /**
   * Record word occurrences for a segment (batch)
   * @param {string} sessionId - Session ID
   * @param {Array} words - Array of word occurrence objects
   */
  async function recordOccurrences(sessionId, words) {
    if (!words || words.length === 0) return;

    console.log('[SmartImport] Recording', words.length, 'occurrences for session:', sessionId);
    return apiRequest('/vocabulary/v2/smart-import/record-occurrence', {
      method: 'POST',
      body: JSON.stringify({ sessionId, words })
    });
  }

  /**
   * Record a word click event
   * @param {string} sessionId - Session ID
   * @param {Object} clickData - Click event data
   */
  async function recordClick(sessionId, clickData) {
    console.log('[SmartImport] Recording click:', clickData.originalForm);
    return apiRequest('/vocabulary/v2/smart-import/record-click', {
      method: 'POST',
      body: JSON.stringify({ sessionId, ...clickData })
    });
  }

  /**
   * Finish a session and generate recommendations
   * @param {string} sessionId - Session ID
   * @param {Array<number>} watchedSegments - Array of watched segment indices
   * @param {number} watchDurationSec - Total watch duration in seconds
   * @returns {Promise<{recommendations: Array, session: Object}>}
   */
  async function finishSession(sessionId, watchedSegments, watchDurationSec, lifecycleKey) {
    console.log('[SmartImport] Finishing session:', sessionId, 'segments:', watchedSegments.length);
    return apiRequest('/vocabulary/v2/smart-import/finish', {
      method: 'POST',
      body: JSON.stringify({ sessionId, watchedSegments, watchDurationSec, lifecycleKey })
    });
  }

  /**
   * Get recommendations for a session
   * @param {string} sessionId - Session ID
   * @returns {Promise<{recommendations: Array, session: Object}>}
   */
  async function getRecommendations(sessionId) {
    return apiRequest(`/vocabulary/v2/smart-import/recommendations?sessionId=${sessionId}`);
  }

  /**
   * Confirm word import
   * @param {string} sessionId - Session ID
   * @param {string} mode - Import mode: 'recommended', 'clicked_only', 'custom', 'none'
   * @param {Array<string>} selectedLemmas - Selected lemmas (for 'custom' mode)
   * @returns {Promise<{imported: number, skipped: number, skippedLemmas: Array}>}
   */
  async function confirmImport(sessionId, mode, selectedLemmas = []) {
    console.log('[SmartImport] Confirming import:', mode, 'selected:', selectedLemmas.length);
    return apiRequest('/vocabulary/v2/smart-import/confirm', {
      method: 'POST',
      body: JSON.stringify({ sessionId, mode, selectedLemmas })
    });
  }

  /**
   * Update word selection (toggle)
   * @param {string} sessionId - Session ID
   * @param {string} lemma - Word lemma
   * @param {boolean} selected - Selection state
   */
  async function updateSelection(sessionId, lemma, selected) {
    return apiRequest('/vocabulary/v2/smart-import/selection', {
      method: 'PUT',
      body: JSON.stringify({ sessionId, lemma, selected })
    });
  }

  /**
   * Abandon a session (user left early)
   * @param {string} sessionId - Session ID
   */
  async function abandonSession(sessionId) {
    console.log('[SmartImport] Abandoning session:', sessionId);
    try {
      await apiRequest('/vocabulary/v2/smart-import/abandon', {
        method: 'POST',
        body: JSON.stringify({ sessionId })
      });
    } catch (e) {
      console.warn('[SmartImport] Failed to abandon session:', e);
    }
  }

  /** Close an exact client-generated lifecycle, including a pending start. */
  async function closeLifecycle(videoId, lifecycleKey) {
    console.log('[SmartImport] Closing lifecycle:', lifecycleKey);
    return apiRequest('/vocabulary/v2/smart-import/abandon', {
      method: 'POST',
      body: JSON.stringify({ videoId, lifecycleKey })
    });
  }

  /**
   * Get current session status
   * @param {string} sessionId - Session ID
   */
  async function getSession(sessionId) {
    return apiRequest(`/vocabulary/v2/smart-import/session?sessionId=${sessionId}`);
  }

  // ============================================================================
  // Export
  // ============================================================================

  return {
    simpleLemma,
    startSession,
    recordOccurrences,
    recordClick,
    finishSession,
    getRecommendations,
    confirmImport,
    updateSelection,
    abandonSession,
    closeLifecycle,
    getSession
  };
})();

// Also expose as window global
window.SmartImportAPI = SmartImportAPI;
