/**
 * Audio Manager Module
 * Handles audio recording, playback, VAD (Voice Activity Detection), and audio mode switching
 */

import { MEDIA_READY_THRESHOLD, SILENT_AUDIO_DATA_URL, isLikelyMobileDevice } from './state.js';
import { setProtectedMediaSource } from './api-client.js';

// Audio fading constants
export const DUCK_FADE_MS = 180;
export const DIALOG_FADE_IN_MS = 140;

/**
 * Smooth mute video with fade effect
 * @param {HTMLVideoElement} videoEl - Video element
 * @param {number} durationMs - Fade duration in milliseconds
 * @param {number} targetVolume - Target volume (default 0)
 */
export function smoothMute(videoEl, durationMs = DUCK_FADE_MS, targetVolume = 0) {
  if (!videoEl) return;
  const startVolume = videoEl.volume;
  const startTime = performance.now();

  function fade() {
    const elapsed = performance.now() - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    const currentVolume = startVolume * (1 - progress) + targetVolume * progress;
    videoEl.volume = Math.max(0, Math.min(1, currentVolume));

    if (progress < 1) {
      requestAnimationFrame(fade);
    } else {
      videoEl.muted = true;
      videoEl.volume = targetVolume;
    }
  }

  requestAnimationFrame(fade);
}

/**
 * Smooth unmute video with fade effect
 * @param {HTMLVideoElement} videoEl - Video element
 * @param {number} targetVolume - Target volume
 * @param {number} durationMs - Fade duration in milliseconds
 */
export function smoothUnmute(videoEl, targetVolume = 1, durationMs = DIALOG_FADE_IN_MS) {
  if (!videoEl) return;
  videoEl.muted = false;
  const startVolume = videoEl.volume || 0;
  const startTime = performance.now();

  function fade() {
    const elapsed = performance.now() - startTime;
    const progress = Math.min(elapsed / durationMs, 1);
    const currentVolume = startVolume * (1 - progress) + targetVolume * progress;
    videoEl.volume = Math.max(0, Math.min(1, currentVolume));

    if (progress < 1) {
      requestAnimationFrame(fade);
    }
  }

  requestAnimationFrame(fade);
}

/**
 * Audio Mode Manager Class
 * Manages user recordings and audio playback modes (original, my-voice, mixed)
 */
export class AudioModeManager {
  constructor() {
    this.mode = 'original'; // original | my-voice | mixed
    this.userRecordings = {}; // { segmentIndex: HTMLAudioElement }
    this.currentVideoId = null;
    this.overlayAudio = null;
    this.selectedSpeaker = null;
    this.originalVolume = null;
    this.baseVolume = 1;
    this.lastPlaybackSegment = null;
    this.lastPlaybackKey = null;
    this.lastPlaybackTimestamp = 0;
    this.decisionCache = new Map();
    this.lastRoleLog = new Map();
    this.overlayPlaybackState = null;
    this.missingRecordingRetries = new Map();
    this.segmentPlaybackLog = new Map();
    this.isMobileEnvironment = isLikelyMobileDevice;
    this.pendingPlaybackRequests = new Map();
    this.maxDeferredPlaybackWaitMs = this.isMobileEnvironment ? 6000 : 3500;
    this.playbackWindow = this.isMobileEnvironment
      ? { startOffset: -0.35, endOffset: 2.1 }
      : { startOffset: -0.2, endOffset: 1.5 };
    this.minimumPlaybackCooldownMs = this.isMobileEnvironment ? 2000 : 1400;
    this.isAudioUnlocked = !this.isMobileEnvironment;
    this.unlockHandlersBound = false;
    this.boundUnlockHandler = null;
    this.playbackAudioContext = null;
    this.playbackAnalyserCache = new WeakMap();
    this.activeAnalyserAudios = new Set();
    this.leadingSilenceCache = new Map();
    this.pendingSilenceAnalysis = new Map();
    this.silenceTrimThreshold = 0.012;
    this.maxSilenceTrimSeconds = 2.5;
    this.emptyRecordingCache = new Map();
    this.pendingEmptyDetection = new Map();
    this.activeUserAudios = new Set();
    this.playedGuard = new Map(); // key -> untilVideoTime (seconds)
    this.notReadyThrottle = new Map();
    this.notReadyMinMs = 300;
  }

  /**
   * Stop all user recordings except the specified one
   * @param {HTMLAudioElement} exclude - Audio element to exclude
   */
  stopAllUserRecordingsExcept(exclude) {
    try {
      const list = this.userRecordings ? Object.values(this.userRecordings) : [];
      list.forEach((a) => {
        if (!a || a === exclude) return;
        try {
          a.pause();
        } catch (_) {}
      });
    } catch (_) {}
  }

  /**
   * Prepare audio element with event listeners
   * @param {string} key - Segment key
   * @param {HTMLAudioElement} audio - Audio element
   * @param {string} sourceType - Source type (remote/local)
   */
  prepareAudioElement(key, audio, sourceType) {
    if (!audio) return;

    const handleReady = () => {
      audio.removeEventListener('loadeddata', handleReady);
      audio.removeEventListener('canplay', handleReady);
      console.log(`[音频加载成功] 片段: ${key}, 来源: ${sourceType}, 就绪状态: ${audio.readyState}, 时长: ${audio.duration && audio.duration.toFixed(2)}s`);
      this.scheduleLeadingSilenceAnalysis(key, audio);
      this.scheduleEmptyRecordingDetection(key, audio);
    };

    const handleError = (event) => {
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('loadeddata', handleReady);
      audio.removeEventListener('canplay', handleReady);
      if (this.userRecordings && this.userRecordings[key] === audio) {
        delete this.userRecordings[key];
      }
      console.error(`[音频加载失败] 片段: ${key}, 来源: ${sourceType}, 错误: ${(event && event.message) || (audio && audio.error && audio.error.code) || 'unknown'}`);
      this.updateRecordingIndicator();
    };

    audio.addEventListener('loadeddata', handleReady);
    audio.addEventListener('canplay', handleReady);
    audio.addEventListener('error', handleError);
  }

  /**
   * Load user recordings from server and local storage
   * @param {string} videoId - Video ID
   * @param {Array} remoteRecordings - Remote recordings array
   */
  loadUserRecordings(videoId, remoteRecordings = []) {
    this.currentVideoId = videoId;
    this.userRecordings = {};
    this.decisionCache.clear();
    if (this.lastRoleLog) this.lastRoleLog.clear();
    this.overlayPlaybackState = null;
    this.missingRecordingRetries.clear();
    this.segmentPlaybackLog.clear();
    this.clearAllPendingPlayback();
    if (this.emptyRecordingCache) this.emptyRecordingCache.clear();
    if (this.pendingEmptyDetection) this.pendingEmptyDetection.clear();
    this.bindMobileUnlockHooks();

    if (!videoId) {
      this.updateRecordingIndicator(0);
      console.warn('loadUserRecordings: missing videoId');
      return;
    }

    let count = 0;
    const seenSegments = new Set();
    const remoteKeys = [];
    const localKeys = [];

    // Load remote recordings
    if (Array.isArray(remoteRecordings) && remoteRecordings.length) {
      remoteRecordings.forEach((recording) => {
        const segmentIndex = (recording && recording.segment_index !== null && recording.segment_index !== undefined) ? recording.segment_index : (recording && recording.segmentIndex);
        if (!segmentIndex) return;

        const recordingSpeaker = (recording && recording.speaker) || null;
        if (this.selectedSpeaker && recordingSpeaker && recordingSpeaker !== this.selectedSpeaker) {
          return;
        }

        const rawUrl = (recording && recording.audio_url) || (recording && recording.audioPath) || (recording && recording.audioData);
        if (!rawUrl) return;

        try {
          const audio = new Audio();
          audio.preload = 'auto';
          this.prepareAudioElement(segmentIndex, audio, 'remote');
          this.userRecordings[segmentIndex] = audio;
          setProtectedMediaSource(audio, rawUrl).then(() => {
            if (typeof audio.load === 'function') {
              audio.load();
            }
          }).catch(() => {
            if (this.userRecordings[segmentIndex] === audio) delete this.userRecordings[segmentIndex];
            this.updateRecordingIndicator();
          });
          seenSegments.add(segmentIndex);
          count += 1;
          remoteKeys.push(segmentIndex);
          if (recording && recording.speaker && !this.selectedSpeaker) {
            this.selectedSpeaker = recording.speaker;
          }
        } catch (err) {
          console.warn('[音频模式] 无法加载服务器录音:', err);
        }
      });
    }

    // Load local recordings from localStorage
    try {
      const storageKey = `user_recordings_${videoId}`;
      const data = localStorage.getItem(storageKey);
      if (data && data !== 'undefined' && data !== 'null') {
        const recordings = JSON.parse(data);
        if (!this.selectedSpeaker && recordings && recordings.selectedSpeaker) {
          this.selectedSpeaker = recordings.selectedSpeaker;
        }
        for (const [segmentIndex, recording] of Object.entries(recordings.recordings || {})) {
          if (seenSegments.has(segmentIndex)) continue;
          const recordingSpeaker = (recording && recording.speaker) || (recordings && recordings.selectedSpeaker) || null;
          if (this.selectedSpeaker && recordingSpeaker && recordingSpeaker !== this.selectedSpeaker) {
            continue;
          }
          if (recording && recording.audioData) {
            try {
              const audio = new Audio(recording.audioData);
              audio.preload = 'auto';
              // Store silence trim offsets (for mobile virtual trimming)
              if (recording.startOffset !== undefined) {
                audio.dataset.startOffset = String(recording.startOffset);
              }
              if (recording.endOffset !== undefined) {
                audio.dataset.endOffset = String(recording.endOffset);
              }
              this.prepareAudioElement(segmentIndex, audio, 'local');
              this.userRecordings[segmentIndex] = audio;
              if (typeof audio.load === 'function') {
                try {
                  audio.load();
                } catch (loadErr) {
                  console.warn('[音频模式] 预加载本地录音失败:', loadErr);
                }
              }
              count += 1;
              seenSegments.add(segmentIndex);
              localKeys.push(segmentIndex);
            } catch (err) {
              console.warn('[音频模式] 无法加载本地录音:', err);
            }
          }
        }
      }
    } catch (err) {
      console.error('[音频模式] 加载录音失败:', err);
    }

    console.log(`[音频模式] 加载完成: ${count} 个录音 (远程: ${remoteKeys.length}, 本地: ${localKeys.length})`);
    this.updateRecordingIndicator(count);
  }

  /**
   * Update recording indicator UI
   * @param {number} count - Number of recordings
   */
  updateRecordingIndicator(count = Object.keys(this.userRecordings || {}).length) {
    // This method should be implemented by the UI manager
    // For now, it's a placeholder
    console.log(`[录音指示器] 更新: ${count} 个录音`);
  }

  /**
   * Bind mobile audio unlock hooks
   */
  bindMobileUnlockHooks() {
    if (!this.isMobileEnvironment || this.isAudioUnlocked || this.unlockHandlersBound) {
      return;
    }
    if (typeof document === 'undefined') return;

    const handler = () => this.unlockAudioPlayback();
    this.boundUnlockHandler = handler;
    const options = { once: true, passive: true };
    document.addEventListener('touchend', handler, options);
    document.addEventListener('touchstart', handler, options);
    document.addEventListener('click', handler, options);
    this.unlockHandlersBound = true;
    console.log('[移动端] 等待用户交互以解锁音频');
  }

  /**
   * Unlock audio playback on mobile
   */
  unlockAudioPlayback() {
    if (!this.isMobileEnvironment || this.isAudioUnlocked) {
      return;
    }

    if (typeof document !== 'undefined' && this.boundUnlockHandler) {
      document.removeEventListener('touchend', this.boundUnlockHandler);
      document.removeEventListener('touchstart', this.boundUnlockHandler);
      document.removeEventListener('click', this.boundUnlockHandler);
    }
    this.unlockHandlersBound = false;
    this.boundUnlockHandler = null;

    const finalize = (success) => {
      if (success) {
        this.isAudioUnlocked = true;
        console.log('[移动端] 音频权限已解锁');
        this.flushPendingPlaybackRequests();
      } else {
        console.log('[移动端] 音频解锁失败，等待下一次用户交互');
        this.isAudioUnlocked = false;
        this.bindMobileUnlockHooks();
      }
    };

    try {
      if (typeof window === 'undefined' || !window.Audio) {
        finalize(false);
        return;
      }
      const silentAudio = new Audio(SILENT_AUDIO_DATA_URL);
      silentAudio.muted = true;
      const playPromise = silentAudio.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            try {
              silentAudio.pause();
              silentAudio.currentTime = 0;
            } catch (_err) {
              // ignore
            }
            finalize(true);
          })
          .catch((err) => {
            console.warn('[移动端] 音频解锁失败:', err && err.message);
            finalize(false);
          });
      } else {
        finalize(true);
      }
    } catch (err) {
      console.warn('[移动端] 音频解锁异常:', err && err.message);
      finalize(false);
    }
  }

  /**
   * Check if AudioContext is supported
   * @returns {boolean} - True if supported
   */
  audioContextSupported() {
    if (typeof window === 'undefined') return false;
    return typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function';
  }

  /**
   * Clear pending playback for a segment
   * @param {string} key - Segment key
   */
  clearPendingPlayback(key) {
    if (!key || !(this.pendingPlaybackRequests && this.pendingPlaybackRequests.size)) return;
    const pending = this.pendingPlaybackRequests.get(key);
    if (!pending) return;
    try {
      pending.cleanup && pending.cleanup();
    } catch (err) {
      console.warn('[音频模式] 无法清理延迟播放:', err);
    }
    this.pendingPlaybackRequests.delete(key);
  }

  /**
   * Clear all pending playback requests
   */
  clearAllPendingPlayback() {
    if (!(this.pendingPlaybackRequests && this.pendingPlaybackRequests.size)) return;
    Array.from(this.pendingPlaybackRequests.keys()).forEach((key) => {
      this.clearPendingPlayback(key);
    });
  }

  /**
   * Flush pending playback requests after audio unlock
   */
  flushPendingPlaybackRequests() {
    if (!(this.pendingPlaybackRequests && this.pendingPlaybackRequests.size)) return;
    const entries = Array.from(this.pendingPlaybackRequests.entries());
    this.pendingPlaybackRequests.clear();

    entries.forEach(([key, payload]) => {
      try {
        payload.cleanup && payload.cleanup();
      } catch (_err) {
        // ignore cleanup errors
      }

      const { segmentIndex, segment, videoEl, videoTime } = payload || {};
      if (segmentIndex == null || !videoEl) {
        console.warn(`[延迟播放] 恢复时缺少必要参数, key: ${key}`);
        return;
      }

      // Check if video time is still in segment range
      const currentVideoTime = videoEl.currentTime;
      const segmentStart = Number(segment && segment.start);
      const segmentEnd = Number(segment && segment.end);

      if (Number.isFinite(segmentStart) && Number.isFinite(segmentEnd)) {
        const tolerance = 0.5;
        if (currentVideoTime < segmentStart - tolerance || currentVideoTime > segmentEnd + tolerance) {
          console.log(`[延迟播放] 跳过过期的录音播放请求, key: ${key}`);
          return;
        }
      }

      // Playback logic would be implemented here
      console.log(`[延迟播放] 恢复播放, key: ${key}`);
    });
  }

  /**
   * Schedule leading silence analysis for a recording
   * @param {string} segmentKey - Segment key
   * @param {HTMLAudioElement} audioEl - Audio element
   * @returns {Promise} - Analysis promise
   */
  scheduleLeadingSilenceAnalysis(segmentKey, audioEl) {
    // Placeholder for silence analysis
    // Implementation would analyze audio buffer for leading silence
    return Promise.resolve(0);
  }

  /**
   * Schedule empty recording detection
   * @param {string} segmentKey - Segment key
   * @param {HTMLAudioElement} audioEl - Audio element
   * @returns {Promise} - Detection promise
   */
  scheduleEmptyRecordingDetection(segmentKey, audioEl) {
    // Placeholder for empty recording detection
    // Implementation would analyze audio buffer for complete silence
    return Promise.resolve(false);
  }

  /**
   * Set audio mode
   * @param {string} newMode - Mode (original/my-voice/mixed)
   */
  setMode(newMode) {
    this.mode = newMode || 'original';
    this.clearAllPendingPlayback();

    if (this.mode !== 'original') {
      this.bindMobileUnlockHooks();
    }

    if (this.mode === 'original') {
      this.cleanup();
      this.segmentPlaybackLog.clear();
    }

    // Preload all recordings when switching to mixed or my-voice mode
    if (this.mode === 'mixed' || this.mode === 'my-voice') {
      this.preloadAllRecordings();
    }
  }

  /**
   * Preload all recordings
   */
  preloadAllRecordings() {
    if (!this.userRecordings) return;

    let loadedCount = 0;
    let totalCount = 0;

    Object.entries(this.userRecordings).forEach(([key, audio]) => {
      if (!audio) return;
      totalCount++;

      // Force load if not already loaded
      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        if (typeof audio.load === 'function') {
          try {
            audio.load();
            loadedCount++;
          } catch (err) {
            console.warn(`[预加载] 无法加载录音 ${key}:`, err);
          }
        }
      }
    });

    if (loadedCount > 0) {
      console.log(`[预加载] 批量预加载录音: ${loadedCount}/${totalCount}`);
    }
  }

  /**
   * Get recording count
   * @returns {number} - Number of recordings
   */
  getRecordingCount() {
    return Object.keys(this.userRecordings || {}).length;
  }

  /**
   * Add or update a recording
   * @param {Object} recording - Recording object
   */
  addOrUpdateRecording(recording) {
    if (!recording) return;
    const segmentIndex = (recording.segment_index !== null && recording.segment_index !== undefined) ? recording.segment_index : recording.segmentIndex;
    if (!segmentIndex) return;

    const rawUrl = recording.audio_url || recording.audioPath || recording.audioData;
    if (!rawUrl) return;

    try {
      const audio = new Audio();
      audio.preload = 'auto';
      this.prepareAudioElement(segmentIndex, audio, 'remote');
      this.userRecordings[segmentIndex] = audio;
      setProtectedMediaSource(audio, rawUrl).then(() => {
        if (typeof audio.load === 'function') {
          audio.load();
        }
      }).catch(() => {
        if (this.userRecordings[segmentIndex] === audio) delete this.userRecordings[segmentIndex];
        this.updateRecordingIndicator();
      });
      if (recording.speaker) {
        this.selectedSpeaker = recording.speaker;
      }
      this.updateRecordingIndicator();
      console.log(`[音频模式] 更新录音缓存: ${segmentIndex}`);
    } catch (err) {
      console.warn('[音频模式] 无法更新录音:', err);
    }
  }

  /**
   * Cleanup audio resources
   */
  cleanup() {
    if (this.overlayAudio) {
      try {
        this.overlayAudio.pause();
        this.overlayAudio = null;
      } catch (_) {}
    }
    this.overlayPlaybackState = null;
  }
}

/**
 * VAD (Voice Activity Detection) Functions
 */

/**
 * Initialize audio analyser for VAD
 * @param {Object} state - Application state
 * @returns {Promise} - Promise that resolves when analyser is ready
 */
export async function initializeAudioAnalyser(state) {
  if (!state.mediaStream) {
    throw new Error('No media stream available');
  }

  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (!state.audioAnalyser) {
    state.audioAnalyser = state.audioContext.createAnalyser();
    state.audioAnalyser.fftSize = 256;
    const source = state.audioContext.createMediaStreamSource(state.mediaStream);
    source.connect(state.audioAnalyser);
  }
}

/**
 * Get current audio level from analyser
 * @param {Object} state - Application state
 * @returns {number} - Audio level (0-1)
 */
export function getAudioLevel(state) {
  if (!state.audioAnalyser) return 0;

  const dataArray = new Uint8Array(state.audioAnalyser.frequencyBinCount);
  state.audioAnalyser.getByteFrequencyData(dataArray);

  // Calculate RMS (Root Mean Square)
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const normalized = dataArray[i] / 255;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / dataArray.length);

  // Adaptive VAD: track a smoothed noise floor and threshold
  if (!state.vadNoiseFloor) state.vadNoiseFloor = rms;
  if (!state.vadSignalHistory) state.vadSignalHistory = [];

  // Update noise floor estimate (slowly)
  state.vadNoiseFloor = state.vadNoiseFloor * 0.98 + rms * 0.02;

  return rms;
}

/**
 * Start VAD monitoring
 * @param {Object} state - Application state
 * @param {Function} onSilenceDetected - Callback when silence is detected
 */
export function startVADMonitoring(state, onSilenceDetected) {
  if (state.vadCheckInterval) return;

  const checkInterval = 100; // Check every 100ms
  let consecutiveSilenceChecks = 0;
  const requiredSilenceChecks = Math.ceil(state.silenceDuration / checkInterval);

  state.vadCheckInterval = setInterval(() => {
    const level = getAudioLevel(state);
    const now = Date.now();

    // Ignore initial period after recording starts
    const elapsed = now - state.recordingStartAt;
    if (elapsed < state.vadInitialIgnoreMs) {
      return;
    }

    // Check if we have enough voiced content
    if (!state.firstVoiceAt && level > state.silenceThreshold) {
      state.firstVoiceAt = now;
    }

    const voicedDuration = state.firstVoiceAt ? (now - state.firstVoiceAt) : 0;

    // Detect silence
    if (level <= state.silenceThreshold) {
      consecutiveSilenceChecks++;

      // Only stop if we have enough voiced content
      if (consecutiveSilenceChecks >= requiredSilenceChecks && voicedDuration >= state.vadMinSpeakMs) {
        console.log('[VAD] 检测到静音，停止录音');
        stopVADMonitoring(state);
        if (onSilenceDetected) onSilenceDetected();
      }
    } else {
      consecutiveSilenceChecks = 0;
    }

    // Max recording duration fallback
    if (elapsed >= state.vadMaxRecordingMs) {
      console.log('[VAD] 达到最大录音时长，停止录音');
      stopVADMonitoring(state);
      if (onSilenceDetected) onSilenceDetected();
    }
  }, checkInterval);
}

/**
 * Stop VAD monitoring
 * @param {Object} state - Application state
 */
export function stopVADMonitoring(state) {
  if (state.vadCheckInterval) {
    clearInterval(state.vadCheckInterval);
    state.vadCheckInterval = null;
  }
}

/**
 * Request microphone permission
 * @returns {Promise<MediaStream>} - Promise that resolves with media stream
 */
export async function requestMicPermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    return stream;
  } catch (error) {
    console.error('[麦克风] 请求权限失败:', error);
    throw error;
  }
}
