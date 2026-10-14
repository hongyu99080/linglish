(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishOriginalAudioReplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createSegmentPlaybackGuard({ start, end, requiresSeek = true }) {
    const lower = Math.max(0, Number(start) - 0.2);
    const upper = Number(start) + Math.min(1, Math.max(0, (Number(end) - Number(start)) / 2));
    let entered = !requiresSeek;
    return {
      acceptTime(value) {
        const time = Number(value);
        if (!Number.isFinite(time)) return false;
        if (!entered && time >= lower && time <= upper) entered = true;
        return entered;
      },
      allowCurrentPosition() { entered = true; },
    };
  }

  function createOriginalAudioReplayController(options) {
    const deps = {
      getTime: options.getTime,
      setTime: options.setTime,
      play: options.play,
      pause: options.pause,
      unmute: options.unmute || (() => {}),
      setVolume: options.setVolume || (() => {}),
      requestFrame: options.requestFrame || ((fn) => requestAnimationFrame(fn)),
      cancelFrame: options.cancelFrame || ((id) => cancelAnimationFrame(id)),
      setTimer: options.setTimer || ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer || ((id) => clearTimeout(id)),
      onStateChange: options.onStateChange || (() => {}),
      onError: options.onError || (() => {}),
      now: options.now || (() => Date.now()),
    };

    let generation = 0;
    let frameId = null;
    let timerId = null;
    let playing = false;

    function clearScheduled() {
      if (frameId != null) deps.cancelFrame(frameId);
      if (timerId != null) deps.clearTimer(timerId);
      frameId = null;
      timerId = null;
    }

    function setPlaying(value) {
      playing = value;
      deps.onStateChange(value);
    }

    function stop(config) {
      const settings = { pause: true, ...config };
      generation += 1;
      clearScheduled();
      if (settings.pause && playing) deps.pause();
      setPlaying(false);
    }

    async function replay(segment) {
      const start = Number(segment && segment.start);
      const end = Number(segment && segment.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error('INVALID_SEGMENT_RANGE');
      }

      stop({ pause: true });
      const token = generation;
      const leadIn = Number.isFinite(Number(segment.leadIn)) ? Number(segment.leadIn) : 0.15;
      const rawBuffer = (end - start) * 0.12;
      const tailBuffer = Number.isFinite(Number(segment.tailBuffer))
        ? Number(segment.tailBuffer)
        : Math.min(0.6, Math.max(0.25, rawBuffer));
      const nextStart = Number(segment.nextStart);
      const targetEnd = Number.isFinite(nextStart)
        ? Math.min(end + tailBuffer, Math.max(end, nextStart + 0.3))
        : end + tailBuffer;

      const seekTime = Math.max(0, start - leadIn);
      const positionGuard = createSegmentPlaybackGuard({ start: seekTime, end: targetEnd });
      deps.setTime(seekTime);
      deps.unmute();
      deps.setVolume(1);
      setPlaying(true);

      let playResult;
      try {
        playResult = await deps.play();
      } catch (error) {
        if (token === generation) stop({ pause: false });
        throw error;
      }
      if (playResult === false) {
        if (token === generation) stop({ pause: false });
        throw new Error('PLAYBACK_REJECTED');
      }
      if (token !== generation) return false;

      const finish = () => {
        if (token !== generation) return;
        stop();
      };

      let lastMediaTime = null;
      let lastProgressAt = deps.now();
      const readPosition = () => {
        const current = Number(deps.getTime());
        // A seek can be asynchronous: the preceding position must not finish this replay.
        if (!positionGuard.acceptTime(current)) return;
        if (current >= targetEnd) {
          finish();
          return;
        }
        if (lastMediaTime === null || Math.abs(current - lastMediaTime) > 0.01) {
          lastMediaTime = current;
          lastProgressAt = deps.now();
        }
      };

      const watch = () => {
        if (token !== generation || !playing) return;
        readPosition();
        if (token === generation && playing) frameId = deps.requestFrame(watch);
      };

      const checkStall = () => {
        if (token !== generation || !playing) return;
        readPosition();
        if (token !== generation || !playing) return;
        const idleMs = deps.now() - lastProgressAt;
        if (idleMs >= 8000) {
          finish();
          deps.onError(new Error('PLAYBACK_STALLED'));
          return;
        }
        timerId = deps.setTimer(checkStall, Math.max(1, 8000 - idleMs));
      };

      frameId = deps.requestFrame(watch);
      // Only inactivity times out; slower playback still gets the whole sentence.
      timerId = deps.setTimer(checkStall, 8000);
      return true;
    }

    return {
      replay,
      stop,
      isPlaying: () => playing,
    };
  }

  return { createOriginalAudioReplayController, createSegmentPlaybackGuard };
});
