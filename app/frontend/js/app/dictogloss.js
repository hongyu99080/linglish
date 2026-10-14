/**
 * Dictogloss Practice Module
 * Handles dictogloss practice sessions and submissions
 */

import { state, debugLog } from './state.js';
import { apiFetch, recordEvent } from './api.js';
import { showToast, formatClock } from './ui-manager.js';
import { refreshStats, refreshSessions } from './stats-refresh.js';

/**
 * Wire up dictogloss UI elements and event listeners
 */
export function wireDictogloss() {
  const mediaSelect = document.getElementById('dictogloss-media');
  const audioEl = document.getElementById('dictogloss-audio');
  const snippetEl = document.getElementById('dictogloss-snippet');
  const keywordsEl = document.getElementById('dictogloss-keywords');
  const reconstructionEl = document.getElementById('dictogloss-reconstruction');

  // Check if elements exist
  if (!mediaSelect || !audioEl || !snippetEl || !keywordsEl || !reconstructionEl) {
    debugLog('[wireDictogloss] Elements not found, skipping');
    return;
  }

  const startBtn = document.getElementById('dictogloss-start');
  const submitBtn = document.getElementById('dictogloss-submit');
  const timerLabel = document.getElementById('dictogloss-timer');

  mediaSelect.addEventListener('change', () => {
    const media = state.media.find((m) => m.id === Number(mediaSelect.value));
    audioEl.src = media ? media.url : '';
    const segments = state.segments.filter((seg) => seg.media_id === Number(mediaSelect.value));
    snippetEl.textContent = segments.length
      ? segments.map((seg) => seg.text).join(' ')
      : 'No transcript snippet available.';
  });

  startBtn.addEventListener('click', async () => {
    if (!state.token) {
      showToast('Log in to start a session.');
      return;
    }
    try {
      const session = await apiFetch('/training/sessions', {
        method: 'POST',
        body: JSON.stringify({
          type: 'dictogloss',
          media_id: Number(mediaSelect.value),
        }),
      });
      state.dictogloss.sessionId = session.id;
      state.dictogloss.startedAt = Date.now();
      state.dictogloss.elapsed = 0;
      timerLabel.textContent = '00:00';
      keywordsEl.value = '';
      reconstructionEl.value = '';
      startBtn.disabled = true;
      submitBtn.disabled = false;
      state.dictogloss.timer = setInterval(() => {
        state.dictogloss.elapsed = Math.floor((Date.now() - state.dictogloss.startedAt) / 1000);
        timerLabel.textContent = formatClock(state.dictogloss.elapsed);
      }, 1000);
      showToast('Dictogloss session started.');
    } catch (err) {
      showToast(`Unable to start dictogloss: ${err.message}`);
    }
  });

  submitBtn.addEventListener('click', async () => {
    if (!state.dictogloss.sessionId) return;
    const payloadText = reconstructionEl.value.trim();
    if (!payloadText) {
      showToast('Please add your reconstruction before submitting.');
      return;
    }
    clearInterval(state.dictogloss.timer);
    const duration = Math.floor((Date.now() - state.dictogloss.startedAt) / 1000);
    const output = {
      keywords: keywordsEl.value.trim(),
      reconstruction: payloadText,
    };
    const wordCount = payloadText.split(/\s+/).filter(Boolean).length;
    try {
      await apiFetch(`/training/sessions/${state.dictogloss.sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          duration_sec: duration,
          output_blob: JSON.stringify(output),
        }),
      });
      await recordEvent('dictogloss_submit', {
        media_id: Number(mediaSelect.value),
        duration_sec: duration,
        word_count: wordCount,
      });
      await refreshStats();
      await refreshSessions();
      showToast('Dictogloss submitted. Great work!');
    } catch (err) {
      showToast(`Submit failed: ${err.message}`);
    } finally {
      startBtn.disabled = false;
      submitBtn.disabled = true;
      timerLabel.textContent = '00:00';
      state.dictogloss.sessionId = null;
    }
  });
}
