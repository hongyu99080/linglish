/**
 * State Management Module
 * Centralized state for practice session
 */

/**
 * Create initial practice session state
 * @param {boolean} debugMode - Whether debug mode is enabled
 * @returns {Object} - Initial state object
 */
export function createInitialState(debugMode = false) {
  return {
    videoId: null,
    videoData: null,
    currentSegments: [],
    speakers: [],
    selectedSpeaker: '',
    practiceLines: [],
    practiceIndex: 0,
    practiceAttempts: 0,
    practiceLineResults: {},
    practiceLineWordResults: {},
    practiceLineIndexMap: new Map(),
    segmentSpeakerMap: new Map(),
    practiceArmed: false,
    waitingForPractice: false,
    practicePlaybackLock: false,
    segmentPlaybackEnd: null,
    segmentPlaybackCallback: null,
    currentSegmentIndex: null,
    autoSegmentCursor: 0,
    recorder: null,
    recordingChunks: [],
    lastRecordingBlob: null,
    recorderMimeType: null,
    mediaStream: null,
    recordingMonitor: null,

    // Auto mode state
    autoMode: false,               // Whether auto mode is enabled
    isPaused: false,               // Whether paused
    currentRetry: 0,               // Current retry count (0-2)
    maxRetries: 3,                 // Max retry count
    isRecording: false,            // Whether currently recording
    audioContext: null,            // Audio context
    audioAnalyser: null,           // Audio analyser
    silenceStart: null,            // Silence start time
    silenceThreshold: 0.01,        // Silence threshold
    // Shorter, more responsive VAD defaults for a snappier dialog feel
    silenceDuration: 1100,         // Silence duration (milliseconds)
    vadCheckInterval: null,        // VAD check timer

    // More robust recording control
    recordingStartAt: null,        // Recording start timestamp (ms)
    firstVoiceAt: null,            // First voice detection timestamp (ms)
    voicedMs: 0,                   // Accumulated voiced duration estimate (ms)
    vadInitialIgnoreMs: 750,       // Silence ignore period after recording starts
    vadMinSpeakMs: 650,            // Minimum speaking time required before silence stop
    vadMaxRecordingMs: 9000,       // Max recording duration per sentence (fallback)

    serverRecordings: [],
    debugMode,
    practiceSummary: [],
    remoteRecordingKeys: [],
    localRecordingKeys: [],
    segmentRoleMap: new Map(),
    autoplayNudgeAt: 0,
    studentGuard: null,            // { key, start, setAt, fallbackAt }
    hasServerSpeakers: false,
    roleCount: 'auto',             // 'auto' | 2..5
    roleRotation: 0,               // Rotation offset for inferred roles
    roleNames: [],                 // Optional custom names
    roleProfile: null,             // Loaded/saved server profile snapshot
    strictAlternate: false,        // Whether strict alternation is enabled (2 people)
  };
}

/**
 * Media ready threshold constant
 */
export const MEDIA_READY_THRESHOLD = typeof HTMLMediaElement !== 'undefined'
  ? HTMLMediaElement.HAVE_METADATA
  : 1;

/**
 * Silent audio data URL for mobile audio unlock
 */
export const SILENT_AUDIO_DATA_URL = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAACJWAAACABAAZGF0YQAAAAA=';

/**
 * Detect if running on mobile device
 * @returns {boolean} - True if mobile device
 */
export const isLikelyMobileDevice = (() => {
  if (typeof navigator === 'undefined' || !navigator) return false;
  const ua = navigator.userAgent || '';
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|Windows Phone|Mobi/i.test(ua);
})();
