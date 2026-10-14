/**
 * Shadow Practice Module
 * Handles shadow practice sessions, timer, and loop functionality
 */

import { state, debugLog } from './state.js';
import { apiFetch, recordEvent } from './api.js';
import { showToast } from './ui-manager.js';
import { refreshStats, refreshSessions } from './stats-refresh.js';

const PRELOAD_LIMIT = 3;
const audioPreloads = new Map();

function preloadAudio(url) {
  if (!url) return;
  if (audioPreloads.has(url)) return;
  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = url;
  audio.load();
  audioPreloads.set(url, audio);
  if (audioPreloads.size > PRELOAD_LIMIT) {
    const oldestKey = audioPreloads.keys().next().value;
    audioPreloads.delete(oldestKey);
  }
}

function seekAudio(audioEl, time) {
  if (!audioEl) return;
  if (typeof audioEl.fastSeek === 'function') {
    try {
      audioEl.fastSeek(time);
      return;
    } catch (_) {}
  }
  audioEl.currentTime = time;
}

/**
 * Wire up shadow practice UI elements and event listeners
 */
export function wireShadowing() {
  const mediaSelect = document.getElementById('shadowing-media');
  const audioEl = document.getElementById('shadowing-audio');

  // Check if elements exist
  if (!mediaSelect || !audioEl) {
    debugLog('[wireShadowing] Elements not found, skipping');
    return;
  }

  const startInput = document.getElementById('shadow-start');
  const endInput = document.getElementById('shadow-end');
  const speedInput = document.getElementById('shadow-speed');
  const loopCheckbox = document.getElementById('shadow-loop');
  const setStartBtn = document.getElementById('set-start-btn');
  const setEndBtn = document.getElementById('set-end-btn');
  const startSessionBtn = document.getElementById('shadow-start-session');
  const stopSessionBtn = document.getElementById('shadow-stop-session');
  const elapsedLabel = document.getElementById('shadow-elapsed');

  mediaSelect.addEventListener('change', () => {
    const media = state.media.find((m) => m.id === Number(mediaSelect.value));
    if (!media) return;
    preloadAudio(media.url);
    audioEl.preload = 'auto';
    audioEl.src = media.url;
    audioEl.load();
    audioEl.currentTime = 0;
    startInput.value = 0;
    endInput.value = media.duration_sec || 10;
  });

  audioEl.addEventListener('loadedmetadata', () => {
    if (!Number(endInput.value)) {
      endInput.value = audioEl.duration;
    }
  });

  speedInput.addEventListener('input', () => {
    const speed = Number(speedInput.value) || 1;
    audioEl.playbackRate = Math.min(2.0, Math.max(0.5, speed));
  });

  setStartBtn.addEventListener('click', () => {
    startInput.value = audioEl.currentTime.toFixed(2);
  });

  setEndBtn.addEventListener('click', () => {
    endInput.value = audioEl.currentTime.toFixed(2);
  });

  audioEl.addEventListener('timeupdate', () => {
    const start = Number(startInput.value) || 0;
    const end = Number(endInput.value) || audioEl.duration || 5;
    if (audioEl.currentTime < start) {
      seekAudio(audioEl, start);
    }
    if (loopCheckbox.checked && audioEl.currentTime >= end) {
      seekAudio(audioEl, start);
      if (state.shadow.sessionId) {
        const now = Date.now();
        if (now - state.shadow.lastLoop > 1500) {
          recordEvent('segment_loop', {
            media_id: Number(mediaSelect.value),
            span_ms: (end - start) * 1000,
          });
          state.shadow.lastLoop = now;
        }
      }
    }
  });

  startSessionBtn.addEventListener('click', async () => {
    if (!state.token) {
      showToast('Please log in first.');
      return;
    }
    try {
      const session = await apiFetch('/training/sessions', {
        method: 'POST',
        body: JSON.stringify({
          type: 'shadowing',
          media_id: Number(mediaSelect.value),
        }),
      });
      state.shadow.sessionId = session.id;
      state.shadow.startedAt = Date.now();
      state.shadow.elapsed = 0;
      elapsedLabel.textContent = '0s';
      startSessionBtn.disabled = true;
      stopSessionBtn.disabled = false;
      audioEl.play().catch(() => {
        showToast('Click play on the audio element to begin.');
      });
      state.shadow.timer = setInterval(() => {
        state.shadow.elapsed = Math.floor((Date.now() - state.shadow.startedAt) / 1000);
        elapsedLabel.textContent = `${state.shadow.elapsed}s`;
      }, 1000);
      showToast('Shadowing session started.');
    } catch (err) {
      showToast(`Unable to start session: ${err.message}`);
    }
  });

  stopSessionBtn.addEventListener('click', async () => {
    if (!state.shadow.sessionId) return;
    clearInterval(state.shadow.timer);
    const duration = Math.floor((Date.now() - state.shadow.startedAt) / 1000);
    try {
      await apiFetch(`/training/sessions/${state.shadow.sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          duration_sec: duration,
        }),
      });
      await refreshStats();
      await refreshSessions();
      showToast('Shadowing session logged.');
    } catch (err) {
      showToast(`Failed to stop session: ${err.message}`);
    } finally {
      startSessionBtn.disabled = false;
      stopSessionBtn.disabled = true;
      state.shadow.sessionId = null;
      state.shadow.timer = null;
      audioEl.pause();
    }
  });
}
