/**
 * Utility Functions Module
 * Common helper functions for practice session
 */

/**
 * Normalize segment index to a number
 * @param {*} value - Value to normalize
 * @returns {number|null} - Normalized number or null
 */
export function normalizeSegmentIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Build a segment key from a value
 * @param {*} value - Value to convert to key
 * @returns {string|null} - Segment key or null
 */
export function buildSegmentKey(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = normalizeSegmentIndex(value);
  if (normalized !== null) return String(normalized);
  try {
    return String(value);
  } catch (_err) {
    return null;
  }
}

/**
 * Get all possible lookup keys for a segment index
 * @param {*} segmentIndex - Segment index
 * @returns {Array} - Array of possible keys
 */
export function getSegmentLookupKeys(segmentIndex) {
  const keys = [];
  const key = buildSegmentKey(segmentIndex);
  if (key) keys.push(key);

  const normalized = normalizeSegmentIndex(segmentIndex);
  if (normalized !== null) {
    const numericKey = normalized;
    const stringKey = String(normalized);
    if (!keys.includes(stringKey)) keys.push(stringKey);
    if (!keys.includes(numericKey)) keys.push(numericKey);
  }
  return keys;
}

/**
 * Resolve segment speaker from mapping
 * @param {*} segmentIndex - Segment index
 * @param {Map} segmentSpeakerMap - Speaker mapping
 * @returns {string|null} - Speaker name or null
 */
export function resolveSegmentSpeaker(segmentIndex, segmentSpeakerMap) {
  if (!(segmentSpeakerMap instanceof Map) || !segmentSpeakerMap.size) {
    return null;
  }
  const keys = getSegmentLookupKeys(segmentIndex);
  for (const key of keys) {
    if (segmentSpeakerMap.has(key)) {
      return segmentSpeakerMap.get(key);
    }
  }
  return null;
}

/**
 * Mark segment role in a map
 * @param {Map} map - Role map
 * @param {*} segmentIndex - Segment index
 * @param {string} role - Role to assign
 */
export function markSegmentRole(map, segmentIndex, role) {
  const keys = getSegmentLookupKeys(segmentIndex);
  keys.forEach((key) => {
    if (key !== null && key !== undefined) {
      map.set(key, role);
    }
  });
}

/**
 * Rebuild segment role map from segments and practice lines
 * @param {Object} state - Application state
 * @returns {Map} - Updated segment role map
 */
export function rebuildSegmentRoleMap(state) {
  const roleMap = new Map();

  if (Array.isArray(state.currentSegments)) {
    state.currentSegments.forEach((segment, idx) => {
      const indexValue = (segment && segment.index != null) ? segment.index : idx;
      markSegmentRole(roleMap, indexValue, 'original');
    });
  }

  if (Array.isArray(state.practiceLines)) {
    state.practiceLines.forEach((line) => {
      const indexValue = (line && line.index != null) ? line.index : (line && line.segmentIndex);
      if (indexValue != null) {
        markSegmentRole(roleMap, indexValue, 'student');
      }
    });
  }

  state.segmentRoleMap = roleMap;
  return roleMap;
}

/**
 * Determine segment role (student or original)
 * @param {*} segmentIndex - Segment index
 * @param {Object} state - Application state
 * @param {string|null} assignedSpeaker - Assigned speaker name
 * @returns {string} - 'student' or 'original'
 */
export function determineSegmentRole(segmentIndex, state, assignedSpeaker = null) {
  const keys = getSegmentLookupKeys(segmentIndex);

  if (state.segmentRoleMap instanceof Map && state.segmentRoleMap.size) {
    for (const key of keys) {
      if (state.segmentRoleMap.has(key)) {
        return state.segmentRoleMap.get(key) === 'student' ? 'student' : 'original';
      }
    }
  }

  const selectedSpeaker = state.selectedSpeaker || null;
  const resolvedSpeaker = assignedSpeaker || resolveSegmentSpeaker(segmentIndex, state.segmentSpeakerMap);

  if (selectedSpeaker && resolvedSpeaker && resolvedSpeaker === selectedSpeaker) {
    return 'student';
  }

  if (state.practiceLineIndexMap instanceof Map && state.practiceLineIndexMap.size) {
    if (keys.some((key) => state.practiceLineIndexMap.has(key))) {
      return 'student';
    }
  }

  return 'original';
}

/**
 * Check if segment is a student segment
 * @param {*} segmentIndex - Segment index
 * @param {Object} state - Application state
 * @param {string|null} assignedSpeaker - Assigned speaker name
 * @returns {boolean} - True if student segment
 */
export function isStudentSegment(segmentIndex, state, assignedSpeaker = null) {
  return determineSegmentRole(segmentIndex, state, assignedSpeaker) === 'student';
}

/**
 * Collect original segments between start and end times
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {Object} state - Application state
 * @returns {Array} - Array of segment objects
 */
export function collectOriginalSegmentsBetween(startTime, endTime, state) {
  if (!Array.isArray(state.currentSegments) || !state.currentSegments.length) return [];

  const segments = [];
  state.currentSegments.forEach((segment, idx) => {
    const segStart = Number(segment.start) || 0;
    const segEndRaw = Number(segment.end);
    const segEnd = Number.isFinite(segEndRaw) ? segEndRaw : segStart + 4;

    if (segEnd <= startTime + 0.01) return;
    if (segStart >= endTime - 0.01) return;

    const segmentIndex = segment.index != null ? segment.index : idx;
    const role = determineSegmentRole(segmentIndex, state, segment.speaker || null);

    if (role === 'student') return;

    segments.push({
      segment,
      start: segStart,
      end: segEnd,
      index: segmentIndex,
    });
  });

  segments.sort((a, b) => a.start - b.start);
  return segments;
}

/**
 * Get local recording cache from localStorage
 * @param {string} videoId - Video ID
 * @returns {Object|null} - Cached recordings or null
 */
export function getLocalRecordingCache(videoId) {
  if (!videoId) return null;
  try {
    const storageKey = `user_recordings_${videoId}`;
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw === 'undefined' || raw === 'null') return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[录音] 无法读取本地缓存:', err);
    return null;
  }
}

/**
 * Build recording URL with cache busting
 * @param {string} rawUrl - Raw URL or data URL
 * @param {string|number} updatedAt - Updated timestamp
 * @returns {string|null} - Resolved URL or null
 */
export function buildRecordingUrl(rawUrl, updatedAt = null) {
  if (!rawUrl) return null;

  // Data URLs don't need cache busting
  if (rawUrl.startsWith('data:')) return rawUrl;

  // Add cache busting parameter for HTTP URLs
  if (updatedAt) {
    const separator = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${separator}_t=${updatedAt}`;
  }

  return rawUrl;
}

/**
 * Format time in MM:SS format
 * @param {number} seconds - Time in seconds
 * @returns {string} - Formatted time string
 */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Debounce function
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} - Debounced function
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
