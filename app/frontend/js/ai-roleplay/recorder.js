(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishRoleplayRecorder = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const PREFERRED_MIME = 'audio/webm;codecs=opus';
  const DEFAULT_MAX_DURATION_MS = 45_000;

  function recorderError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function blobToDataUrl(blob, FileReaderCtor) {
    const Reader = FileReaderCtor || globalThis.FileReader;
    if (typeof Reader !== 'function') return Promise.reject(recorderError('FILE_READER_UNAVAILABLE'));
    return new Promise((resolve, reject) => {
      const reader = new Reader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(recorderError('AUDIO_ENCODE_FAILED'));
      reader.readAsDataURL(blob);
    });
  }

  function createCaptureEpoch(options = {}) {
    const getGeneration = options.getGeneration || (() => 0);
    let epoch = 0;

    function begin(generation = getGeneration()) {
      epoch += 1;
      return Object.freeze({ epoch, generation });
    }

    function invalidate() {
      epoch += 1;
      return epoch;
    }

    function isCurrent(token) {
      return Boolean(
        token
        && token.epoch === epoch
        && token.generation === getGeneration(),
      );
    }

    async function process(token, steps = {}) {
      if (!isCurrent(token)) return { stale: true, value: null };
      const encoded = await steps.encode();
      if (!isCurrent(token)) return { stale: true, value: null };
      const value = await steps.submit(encoded);
      if (!isCurrent(token)) return { stale: true, value: null };
      return { stale: false, value };
    }

    return { begin, invalidate, isCurrent, process };
  }

  function createRoleplayRecorder(options = {}) {
    const mediaDevices = options.mediaDevices || globalThis.navigator?.mediaDevices;
    const MediaRecorderCtor = options.MediaRecorder || globalThis.MediaRecorder;
    const now = options.now || Date.now;
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const maxDurationMs = Math.min(
      DEFAULT_MAX_DURATION_MS,
      Math.max(1_000, Number(options.maxDurationMs) || DEFAULT_MAX_DURATION_MS),
    );
    let active = null;

    function createCapture() {
      const capture = {
        phase: 'acquiring',
        stream: null,
        mediaRecorder: null,
        mimeType: '',
        chunks: [],
        startedAt: 0,
        timer: null,
        tracksStopped: false,
        cancelled: false,
        settled: false,
        resolve: null,
        reject: null,
      };
      capture.done = new Promise((resolve, reject) => {
        capture.resolve = resolve;
        capture.reject = reject;
      });
      return capture;
    }

    function stopStream(stream) {
      const tracks = stream?.getTracks?.() || [];
      tracks.forEach((track) => {
        try { track.stop(); } catch (_) { /* terminal cleanup */ }
      });
    }

    function stopTracks(capture) {
      if (!capture || capture.tracksStopped || !capture.stream) return;
      capture.tracksStopped = true;
      stopStream(capture.stream);
    }

    function clearCaptureTimer(capture) {
      if (!capture?.timer) return;
      clearTimer(capture.timer);
      capture.timer = null;
    }

    function settleCapture(capture, kind, error) {
      if (!capture || capture.settled) return;
      capture.settled = true;
      capture.phase = 'settled';
      clearCaptureTimer(capture);
      stopTracks(capture);
      if (active === capture) active = null;
      if (kind === 'error') {
        capture.reject(error || recorderError('RECORDING_FAILED'));
        return;
      }
      const durationSeconds = capture.startedAt
        ? Math.max(0, (now() - capture.startedAt) / 1_000)
        : 0;
      const blob = new Blob(capture.chunks, { type: capture.mimeType || 'audio/webm' });
      capture.resolve(capture.cancelled ? null : {
        blob,
        durationSeconds,
        mimeType: capture.mimeType || 'audio/webm',
      });
    }

    function requestStop(capture, cancelled = false) {
      if (!capture) return Promise.resolve(null);
      if (cancelled || capture.phase === 'acquiring') capture.cancelled = true;
      if (capture.settled) return capture.done;
      if (capture.phase === 'acquiring') {
        settleCapture(capture, 'stopped');
        return capture.done;
      }

      let stopFailure = null;
      try {
        if (capture.mediaRecorder?.state !== 'inactive') {
          capture.mediaRecorder.stop();
        } else {
          settleCapture(capture, 'stopped');
        }
      } catch (_) {
        stopFailure = recorderError('RECORDING_FAILED');
      } finally {
        if (stopFailure) settleCapture(capture, 'error', stopFailure);
      }
      return capture.done;
    }

    async function start() {
      if (active) throw recorderError('RECORDING_IN_PROGRESS');
      if (!mediaDevices?.getUserMedia || typeof MediaRecorderCtor !== 'function') {
        throw recorderError('RECORDING_UNAVAILABLE');
      }

      const capture = createCapture();
      active = capture;
      let streamRequest;
      try {
        streamRequest = Promise.resolve(mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        }));
      } catch (_) {
        settleCapture(capture, 'stopped');
        throw recorderError('MICROPHONE_DENIED');
      }

      const acquisition = streamRequest.then(
        (stream) => ({ stream, error: null }),
        (error) => ({ stream: null, error }),
      );
      const acquired = await Promise.race([
        acquisition,
        capture.done.then(() => ({ cancelled: true })),
      ]);

      if (acquired.cancelled) {
        acquisition.then((late) => {
          if (!late.stream) return;
          capture.stream = late.stream;
          stopTracks(capture);
        });
        return null;
      }
      if (acquired.error) {
        settleCapture(capture, 'stopped');
        throw recorderError('MICROPHONE_DENIED');
      }

      const stream = acquired.stream;
      capture.stream = stream;
      if (capture.cancelled || active !== capture) {
        stopTracks(capture);
        settleCapture(capture, 'stopped');
        return null;
      }

      const mimeType = typeof MediaRecorderCtor.isTypeSupported === 'function'
        && MediaRecorderCtor.isTypeSupported(PREFERRED_MIME)
        ? PREFERRED_MIME
        : '';
      let mediaRecorder;
      try {
        mediaRecorder = mimeType
          ? new MediaRecorderCtor(stream, { mimeType })
          : new MediaRecorderCtor(stream);
      } catch (_) {
        settleCapture(capture, 'stopped');
        throw recorderError('RECORDING_UNAVAILABLE');
      }

      capture.mediaRecorder = mediaRecorder;
      capture.mimeType = mimeType || mediaRecorder.mimeType || 'audio/webm';
      capture.startedAt = now();
      capture.phase = 'recording';

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) capture.chunks.push(event.data);
      };
      mediaRecorder.onstop = () => settleCapture(capture, 'stopped');
      mediaRecorder.onerror = () => settleCapture(capture, 'error', recorderError('RECORDING_FAILED'));

      try {
        mediaRecorder.start();
      } catch (_) {
        settleCapture(capture, 'stopped');
        throw recorderError('RECORDING_FAILED');
      }
      capture.timer = setTimer(() => {
        requestStop(capture).catch(() => {});
      }, maxDurationMs);

      return { mimeType: capture.mimeType, startedAt: capture.startedAt };
    }

    function waitForStop() {
      return active ? active.done : Promise.resolve(null);
    }

    function stop() {
      if (!active) return Promise.reject(recorderError('RECORDING_NOT_ACTIVE'));
      return requestStop(active);
    }

    function cancel() {
      if (!active) return Promise.resolve(null);
      return requestStop(active, true);
    }

    function isRecording() {
      return Boolean(active && active.phase === 'recording' && active.mediaRecorder?.state === 'recording');
    }

    return { start, stop, cancel, waitForStop, isRecording };
  }

  return { blobToDataUrl, createCaptureEpoch, createRoleplayRecorder };
});
