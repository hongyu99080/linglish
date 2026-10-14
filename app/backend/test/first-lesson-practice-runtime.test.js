const test = require('node:test');
const assert = require('node:assert/strict');

let runtime = {};
try {
  runtime = require('../../frontend/js/video-reader/first-lesson-practice');
} catch (_) {
  // RED: assertions name the missing runtime behavior.
}
const focus = require('../../frontend/js/video-reader/first-lesson-focus');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeRecorderFactory(log, options = {}) {
  const instances = [];
  class FakeMediaRecorder {
    constructor(stream) {
      this.stream = stream;
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
      this.listeners = new Map();
      instances.push(this);
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    start() { this.state = 'recording'; log.push('recorder.start'); }
    stop() {
      if (this.state === 'inactive') return;
      log.push('recorder.stop');
      this.state = 'inactive';
      if (!options.asyncStop) this.emitStop();
    }
    data(value = { size: 4 }) {
      const listener = this.listeners.get('dataavailable');
      if (listener) listener({ data: value });
    }
    emitStop() {
      const listener = this.listeners.get('stop');
      if (listener) listener();
    }
    emitError(error = new Error('recorder-failed')) {
      const listener = this.listeners.get('error');
      if (listener) listener({ error });
    }
  }
  return { FakeMediaRecorder, instances };
}

function recordingHarness(overrides = {}) {
  const log = overrides.log || [];
  const tracks = [1, 2].map((id) => ({
    stopped: false,
    stop() { this.stopped = true; log.push(`track.${id}.stop`); },
  }));
  const stream = { getTracks: () => tracks };
  const timers = [];
  const recorder = fakeRecorderFactory(log, overrides.recorderOptions);
  const context = Object.freeze({
    subject: 'user:7', videoId: '374', stableSegmentId: 'stable-1',
    sourceIndices: [0, 1], selectionGeneration: 3,
  });
  let current = context;
  const controller = runtime.createDesktopRecorderController({
    MediaRecorder: recorder.FakeMediaRecorder,
    getUserMedia: overrides.getUserMedia || (async () => stream),
    createBlob: (chunks) => ({ size: chunks.length, chunks }),
    maxDurationMs: 12_000,
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
    isActive: () => true,
    isContextCurrent: (captured) => runtime.assessmentContextMatches(captured, current),
    pausePlayback() { log.push('playback.pause'); },
    lockPlayback(locked) { log.push(`playback.lock:${locked}`); },
    setButtonState(state) { log.push(`button.${state}`); },
    assess: overrides.assess || (async () => ({ success: true, similarity: 0.9 })),
    accept: overrides.accept || (async () => ({
      accepted: true,
      feedback: '90',
      snapshot: { complete: false, practicedCount: 1, total: 2 },
    })),
    renderFeedback(feedback) { log.push(`feedback.${feedback}`); },
    advance() { log.push('advance'); },
    complete() { log.push('complete'); },
    onError(error) { log.push(`error.${error.message}`); },
  });
  return {
    log, tracks, stream, timers, recorder, controller, context,
    setCurrent(next) { current = next; },
  };
}

function trackedStream(log, label) {
  const tracks = [1, 2].map((id) => ({
    stopped: false,
    stop() { this.stopped = true; log.push(`${label}.track.${id}.stop`); },
  }));
  return { stream: { getTracks: () => tracks }, tracks };
}

test('focus teardown stops recorder and every track and restores controls before focus is hidden', async () => {
  assert.equal(typeof runtime.createDesktopRecorderController, 'function');
  const harness = recordingHarness();
  const dataset = new Proxy({}, {
    deleteProperty(target, property) {
      if (property === 'learningFocus') harness.log.push('focus.hidden');
      return Reflect.deleteProperty(target, property);
    },
  });
  const session = focus.createSession({
    search: '?focus=first_lesson',
    document: { documentElement: { dataset } },
  });
  session.addTeardown(() => harness.controller.teardown('focus-exit'));
  await harness.controller.start(harness.context);
  harness.recorder.instances[0].data();

  session.deactivate('library-open');

  assert.equal(harness.recorder.instances[0].state, 'inactive');
  assert.equal(harness.tracks.every((track) => track.stopped), true);
  assert.ok(harness.log.indexOf('recorder.stop') < harness.log.indexOf('focus.hidden'));
  assert.ok(harness.log.indexOf('track.1.stop') < harness.log.indexOf('focus.hidden'));
  assert.ok(harness.log.indexOf('track.2.stop') < harness.log.indexOf('focus.hidden'));
  assert.ok(harness.log.indexOf('button.idle') < harness.log.indexOf('focus.hidden'));
});

test('desktop recording pauses and locks source audio before microphone access and hard-stops at the bound', async () => {
  assert.equal(typeof runtime.createDesktopRecorderController, 'function');
  const harness = recordingHarness();

  await harness.controller.start(harness.context);
  harness.recorder.instances[0].data();

  assert.deepEqual(harness.log.slice(0, 3), ['playback.pause', 'playback.lock:true', 'button.requesting']);
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 12_000);

  harness.timers[0].callback();
  await harness.controller.whenIdle();

  assert.equal(harness.recorder.instances[0].state, 'inactive');
  assert.equal(harness.tracks.every((track) => track.stopped), true);
  assert.equal(harness.log.includes('advance'), true);
});

test('desktop recorder errors tear down all live tracks and restore the control', async () => {
  const harness = recordingHarness();
  await harness.controller.start(harness.context);

  const onError = harness.recorder.instances[0].listeners.get('error');
  assert.equal(typeof onError, 'function');
  onError({ error: new Error('recorder-failed') });

  assert.equal(harness.recorder.instances[0].state, 'inactive');
  assert.equal(harness.tracks.every((track) => track.stopped), true);
  assert.equal(harness.log.includes('button.idle'), true);
  assert.equal(harness.log.includes('error.recorder-failed'), true);
});

test('pagehide teardown invalidates pending permission and stops a late stream without creating a recorder', async () => {
  const permission = deferred();
  const harness = recordingHarness({
    recorderOptions: { asyncStop: true },
    getUserMedia: () => permission.promise,
  });

  const started = harness.controller.start(harness.context);
  await Promise.resolve();
  harness.controller.teardown('pagehide');
  const logAfterTeardown = harness.log.slice();

  permission.resolve(harness.stream);

  assert.equal(await started, false);
  assert.equal(harness.recorder.instances.length, 0);
  assert.equal(harness.tracks.every((track) => track.stopped), true);
  assert.deepEqual(harness.log.slice(0, logAfterTeardown.length), logAfterTeardown);
  assert.equal(harness.log.includes('recorder.start'), false);
  assert.equal(harness.log.at(-1), 'track.2.stop');
});

test('pagehide teardown during deferred evaluation prevents acceptance, feedback, progress, and navigation', async () => {
  const evaluation = deferred();
  const harness = recordingHarness({
    recorderOptions: { asyncStop: true },
    assess: async () => evaluation.promise,
    accept: async () => {
      harness.log.push('accept');
      return {
        accepted: true,
        feedback: 'late-feedback',
        snapshot: { complete: true, practicedCount: 2, total: 2 },
      };
    },
  });
  await harness.controller.start(harness.context);
  harness.recorder.instances[0].data();
  harness.controller.stop('manual');
  harness.recorder.instances[0].emitStop();
  await Promise.resolve();

  harness.controller.teardown('pagehide');
  const logAfterTeardown = harness.log.slice();
  evaluation.resolve({ success: true, similarity: 1 });
  await harness.controller.whenIdle();

  assert.deepEqual(harness.log, logAfterTeardown);
  assert.equal(harness.log.includes('accept'), false);
  assert.equal(harness.log.some((entry) => entry.startsWith('feedback.')), false);
  assert.equal(harness.log.includes('advance'), false);
  assert.equal(harness.log.includes('complete'), false);
});

test('delayed stop and error callbacks from an old cycle cannot alter a newer recording', async () => {
  const log = [];
  const oldStream = trackedStream(log, 'old');
  const newStream = trackedStream(log, 'new');
  const streams = [oldStream.stream, newStream.stream];
  const harness = recordingHarness({
    log,
    recorderOptions: { asyncStop: true },
    getUserMedia: async () => streams.shift(),
  });

  await harness.controller.start(harness.context);
  const oldRecorder = harness.recorder.instances[0];
  oldRecorder.data();
  harness.controller.stop('manual');

  const nextContext = Object.freeze({
    ...harness.context,
    stableSegmentId: 'stable-2',
    selectionGeneration: 4,
  });
  harness.setCurrent(nextContext);
  await harness.controller.start(nextContext);
  const newRecorder = harness.recorder.instances[1];
  const logAfterNewStart = log.slice();

  oldRecorder.emitStop();
  oldRecorder.emitError(new Error('late-old-error'));
  await Promise.resolve();

  assert.deepEqual(log, logAfterNewStart);
  assert.equal(newRecorder.state, 'recording');
  assert.equal(harness.controller.isRecording(), true);
  assert.equal(newStream.tracks.every((track) => !track.stopped), true);
  assert.equal(log.includes('error.late-old-error'), false);

  harness.controller.teardown('test-cleanup');
  assert.equal(newStream.tracks.every((track) => track.stopped), true);
});

test('desktop accepted feedback advances with the accepted snapshot and final feedback completes instead', async () => {
  assert.equal(typeof runtime.createDesktopRecorderController, 'function');
  const nextHarness = recordingHarness();
  await nextHarness.controller.start(nextHarness.context);
  nextHarness.recorder.instances[0].data();
  nextHarness.controller.stop('manual');
  await nextHarness.controller.whenIdle();
  assert.ok(nextHarness.log.indexOf('feedback.90') < nextHarness.log.indexOf('advance'));
  assert.ok(nextHarness.log.indexOf('playback.lock:false') < nextHarness.log.indexOf('advance'));
  assert.equal(nextHarness.log.includes('complete'), false);

  const finalHarness = recordingHarness({
    accept: async () => ({
      accepted: true,
      feedback: '100',
      snapshot: { complete: true, practicedCount: 2, total: 2 },
    }),
  });
  await finalHarness.controller.start(finalHarness.context);
  finalHarness.recorder.instances[0].data();
  finalHarness.controller.stop('manual');
  await finalHarness.controller.whenIdle();
  assert.ok(finalHarness.log.indexOf('feedback.100') < finalHarness.log.indexOf('complete'));
  assert.equal(finalHarness.log.includes('advance'), false);
});

test('desktop rejected assessment renders feedback without advancing or completing', async () => {
  const harness = recordingHarness({
    accept: async () => ({
      accepted: false,
      feedback: 'try-again',
      snapshot: { complete: false, practicedCount: 0, total: 2 },
    }),
  });
  await harness.controller.start(harness.context);
  harness.recorder.instances[0].data();
  harness.controller.stop('manual');
  await harness.controller.whenIdle();

  assert.equal(harness.log.includes('feedback.try-again'), true);
  assert.equal(harness.log.includes('advance'), false);
  assert.equal(harness.log.includes('complete'), false);
});

test('desktop and mobile assessment uploads carry exact identity and discard stale async responses', async () => {
  assert.equal(typeof runtime.submitAssessment, 'function');
  for (const reader of ['desktop', 'mobile']) {
    const pending = deferred();
    const fields = [];
    let current = {
      subject: 'user:7', videoId: '374', stableSegmentId: `${reader}-stable`,
      sourceIndices: [0, 1], selectionGeneration: 4,
    };
    const request = runtime.submitAssessment({
      fetch: async () => pending.promise,
      url: '/practice/evaluate',
      token: 'account-token',
      blob: { size: 8 },
      context: current,
      FormData: class FakeFormData { append(name, value) { fields.push([name, value]); } },
      isContextCurrent: (captured) => runtime.assessmentContextMatches(captured, current),
    });

    current = { ...current, selectionGeneration: 5 };
    pending.resolve({
      ok: true,
      headers: { get: () => 'request-1' },
      json: async () => ({ success: true, stableSegmentId: `${reader}-stable` }),
    });

    assert.equal(await request, null, `${reader} must discard stale assessment responses`);
    assert.deepEqual(fields.filter(([name]) => ['videoId', 'stableSegmentId', 'sourceIndices'].includes(name)), [
      ['videoId', '374'],
      ['stableSegmentId', `${reader}-stable`],
      ['sourceIndices', '[0,1]'],
    ]);
  }
});

test('assessment fencing rejects changes to subject, video, stable segment, or selection generation', () => {
  assert.equal(typeof runtime.assessmentContextMatches, 'function');
  const captured = {
    subject: 'user:7', videoId: '374', stableSegmentId: 'stable-1',
    sourceIndices: [0, 1], selectionGeneration: 9,
  };
  assert.equal(runtime.assessmentContextMatches(captured, { ...captured }), true);
  for (const changed of [
    { subject: 'user:8' }, { videoId: '375' }, { stableSegmentId: 'stable-2' }, { selectionGeneration: 10 },
  ]) {
    assert.equal(runtime.assessmentContextMatches(captured, { ...captured, ...changed }), false);
  }
});
