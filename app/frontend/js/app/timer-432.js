/**
 * 4-3-2 Timer Module
 * Handles the 4-3-2 compression timer for speaking practice
 */

import { state, STAGES_432, debugLog } from './state.js';
import { apiFetch, recordEvent } from './api.js';
import { showToast, formatClock } from './ui-manager.js';
import { refreshStats, refreshSessions } from './stats-refresh.js';

/**
 * Wire up 4-3-2 timer UI elements and event listeners
 */
export function wire432Timer() {
  const stageLabel = document.getElementById('timer432-stage');
  const countdownLabel = document.getElementById('timer432-countdown');
  const progressBar = document.getElementById('timer432-progress-bar');
  const startBtn = document.getElementById('timer432-start');
  const pauseBtn = document.getElementById('timer432-pause');

  // Check if elements exist
  if (!stageLabel || !countdownLabel || !progressBar || !startBtn || !pauseBtn) {
    debugLog('[wire432Timer] Elements not found, skipping');
    return;
  }

  const resetBtn = document.getElementById('timer432-reset');

  const updateDisplay = () => {
    if (state.timer432.stageIndex < 0) {
      stageLabel.textContent = 'Ready';
      countdownLabel.textContent = formatClock(STAGES_432[0].seconds);
      progressBar.style.width = '0%';
      return;
    }
    const stage = STAGES_432[state.timer432.stageIndex];
    stageLabel.textContent = stage.label;
    countdownLabel.textContent = formatClock(state.timer432.remaining);
    const elapsedStage = stage.seconds - state.timer432.remaining;
    const stageProgress = Math.min(100, (elapsedStage / stage.seconds) * 100);
    const totalSeconds = STAGES_432.reduce((sum, s, idx) => {
      if (idx < state.timer432.stageIndex) return sum + s.seconds;
      if (idx === state.timer432.stageIndex) return sum + elapsedStage;
      return sum;
    }, 0);
    const totalDuration = STAGES_432.reduce((sum, s) => sum + s.seconds, 0);
    progressBar.style.width = `${(totalSeconds / totalDuration) * 100}%`;
  };

  const stepTimer = () => {
    if (state.timer432.paused) return;
    state.timer432.remaining -= 1;
    if (state.timer432.remaining <= 0) {
      state.timer432.completedStages.push({
        stage: state.timer432.stageIndex,
        completed_at: new Date().toISOString(),
      });
      if (state.timer432.stageIndex >= STAGES_432.length - 1) {
        clearInterval(state.timer432.timer);
        finalize432();
        return;
      }
      state.timer432.stageIndex += 1;
      state.timer432.remaining = STAGES_432[state.timer432.stageIndex].seconds;
    }
    updateDisplay();
  };

  const startStages = async () => {
    if (!state.token) {
      showToast('Log in to start the timer.');
      return;
    }
    if (state.timer432.sessionId) {
      showToast('Timer already running.');
      return;
    }
    try {
      const session = await apiFetch('/training/sessions', {
        method: 'POST',
        body: JSON.stringify({ type: '432' }),
      });
      state.timer432.sessionId = session.id;
      state.timer432.stageIndex = 0;
      state.timer432.remaining = STAGES_432[0].seconds;
      state.timer432.startedAt = Date.now();
      state.timer432.paused = false;
      state.timer432.completedStages = [];
      updateDisplay();
      state.timer432.timer = setInterval(stepTimer, 1000);
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      resetBtn.disabled = false;
      showToast('4-3-2 flow started. Go for it!');
    } catch (err) {
      showToast(`Cannot start timer: ${err.message}`);
    }
  };

  const togglePause = () => {
    if (!state.timer432.sessionId) return;
    state.timer432.paused = !state.timer432.paused;
    pauseBtn.textContent = state.timer432.paused ? 'Resume' : 'Pause';
  };

  const resetTimer = () => {
    clearInterval(state.timer432.timer);
    state.timer432.sessionId = null;
    state.timer432.timer = null;
    state.timer432.stageIndex = -1;
    state.timer432.remaining = 0;
    state.timer432.completedStages = [];
    state.timer432.paused = true;
    pauseBtn.textContent = 'Pause';
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    resetBtn.disabled = true;
    updateDisplay();
  };

  startBtn.addEventListener('click', startStages);
  pauseBtn.addEventListener('click', togglePause);
  resetBtn.addEventListener('click', resetTimer);

  function finalize432() {
    const totalDuration = STAGES_432.reduce((sum, s) => sum + s.seconds, 0);
    apiFetch(`/training/sessions/${state.timer432.sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        duration_sec: totalDuration,
        output_blob: JSON.stringify({ stages: state.timer432.completedStages }),
      }),
    })
      .then(() =>
        recordEvent('432_finish', {
          total_duration_sec: totalDuration,
          stages_completed: state.timer432.completedStages.length,
        }),
      )
      .then(() => Promise.all([refreshStats(), refreshSessions()]))
      .then(() => showToast('Great compression! 4-3-2 logged.'))
      .catch((err) => showToast(`Error logging 4-3-2: ${err.message}`))
      .finally(() => resetTimer());
  }

  updateDisplay();
}
