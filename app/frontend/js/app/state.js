/**
 * Global State Management
 * Centralized state object for the application
 */

// API base URL
// For local development, point to localhost:4000
// For production, use empty string '' to use relative paths
export const API_BASE = (function() {
  const hostname = window.location.hostname;
  console.log('[API_BASE] Detecting hostname:', hostname);

  // Local development: localhost, 127.0.0.1, or any .local domain
  if (hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.local') ||
      window.location.port === '4000') {
    console.log('[API_BASE] Using local development API: http://localhost:4000');
    return 'http://localhost:4000';
  }

  // Production: use relative paths
  console.log('[API_BASE] Using relative paths (production mode)');
  return '';
})();

// Authentication storage keys
export const AUTH_KEYS = {
  token: ['authToken', 'linglish_token'],
  email: ['userEmail'],
  misc: ['isGuest', 'returnUrl']
};

// 4-3-2 Timer stages configuration
export const STAGES_432 = [
  { label: 'Round 1 — 4 minutes', seconds: 4 * 60 },
  { label: 'Round 2 — 3 minutes', seconds: 3 * 60 },
  { label: 'Round 3 — 2 minutes', seconds: 2 * 60 },
];

// Global state object
export const state = {
  token: null,
  userEmail: null,
  user: null,
  shadow: {
    sessionId: null,
    timer: null,
    startedAt: null,
    elapsed: 0,
    lastLoop: 0,
  },
  dictogloss: {
    sessionId: null,
    timer: null,
    startedAt: null,
    elapsed: 0,
  },
  timer432: {
    sessionId: null,
    timer: null,
    stageIndex: -1,
    remaining: 0,
    startedAt: null,
    paused: true,
    completedStages: [],
  },
  media: [],
  segments: [],
};

// Optional debug logging. Enable via:
// localStorage.setItem('linglish_debug', '1')
export function debugLog(...args) {
  try {
    if (localStorage.getItem('linglish_debug') === '1') {
      console.log(...args);
    }
  } catch (_) {}
}
