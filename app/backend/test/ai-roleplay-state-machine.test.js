'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoleplayStateMachine,
} = require('../../frontend/js/ai-roleplay/state-machine');
const {
  createRoleplayApi,
  createSpeechTurnRunner,
  createTurnDraftStore,
  canonicalSessionId,
} = require('../../frontend/js/ai-roleplay/api');
const {
  createCaptureEpoch,
  createRoleplayRecorder,
} = require('../../frontend/js/ai-roleplay/recorder');

function makeSession(overrides = {}) {
  return {
    id: '101',
    status: 'active',
    turn_count: 0,
    turn_limit: 6,
    scenario: {
      id: 'hotel-checkin-a2',
      title_zh: '酒店入住',
      goals: [{ id: 'provide_name', label_zh: '说明预订姓名' }],
    },
    ...overrides,
  };
}

test('starts in catalog and follows the spoken-turn happy path', () => {
  const machine = createRoleplayStateMachine({ now: () => 1_000 });

  assert.deepEqual(machine.snapshot(), {
    status: 'catalog',
    generation: 0,
    session: null,
    transcript: '',
    turn: null,
    error: null,
    retryStatus: null,
    exited: false,
    updatedAt: 1_000,
  });

  assert.equal(machine.dispatch({ type: 'SESSION_START' }), true);
  assert.equal(machine.snapshot().status, 'starting');
  assert.equal(machine.dispatch({ type: 'SESSION_READY', session: makeSession() }), true);
  assert.equal(machine.snapshot().status, 'ready');

  const generation = machine.snapshot().generation;
  assert.equal(machine.dispatch({ type: 'RECORDING_STARTED' }), true);
  assert.equal(machine.snapshot().status, 'recording');
  assert.equal(machine.dispatch({ type: 'RECORDING_STOPPED' }), true);
  assert.equal(machine.snapshot().status, 'recognizing');
  assert.equal(machine.dispatch({
    type: 'RECOGNITION_DONE',
    generation,
    transcript: 'I have a reservation under Chen.',
  }), true);
  assert.equal(machine.snapshot().status, 'evaluating');
  assert.equal(machine.dispatch({
    type: 'AI_DONE',
    generation,
    turn: { assistant: { text: 'May I see your passport, please?' } },
  }), true);
  assert.equal(machine.snapshot().status, 'ai_speaking');
  assert.equal(machine.dispatch({ type: 'AI_PLAY_ENDED', generation }), true);
  assert.equal(machine.snapshot().status, 'ready');
});

test('rejects invalid transitions and prevents a second active recording', () => {
  const machine = createRoleplayStateMachine();

  assert.equal(machine.dispatch({ type: 'RECORDING_STARTED' }), false);
  machine.dispatch({ type: 'SESSION_READY', session: makeSession() });
  assert.equal(machine.dispatch({ type: 'RECORDING_STARTED' }), true);
  assert.equal(machine.dispatch({ type: 'RECORDING_STARTED' }), false);
  assert.equal(machine.snapshot().status, 'recording');
});

test('rejects stale recognition and AI responses without mutating state', () => {
  const machine = createRoleplayStateMachine();
  machine.dispatch({ type: 'SESSION_READY', session: makeSession() });
  const generation = machine.snapshot().generation;
  machine.dispatch({ type: 'RECORDING_STARTED' });

  const beforeRecognition = machine.snapshot();
  assert.equal(machine.dispatch({
    type: 'RECOGNITION_DONE',
    generation: generation - 1,
    transcript: 'stale',
  }), false);
  assert.deepEqual(machine.snapshot(), beforeRecognition);

  machine.dispatch({ type: 'RECOGNITION_DONE', generation, transcript: 'Hello' });
  const beforeAI = machine.snapshot();
  assert.equal(machine.dispatch({
    type: 'AI_DONE',
    generation: generation - 1,
    turn: { assistant: { text: 'stale' } },
  }), false);
  assert.deepEqual(machine.snapshot(), beforeAI);
});

test('page exit invalidates in-flight work and returns to catalog', () => {
  const machine = createRoleplayStateMachine();
  machine.dispatch({ type: 'SESSION_READY', session: makeSession() });
  const generation = machine.snapshot().generation;
  machine.dispatch({ type: 'RECORDING_STARTED' });

  assert.equal(machine.dispatch({ type: 'PAGE_EXIT' }), true);
  assert.equal(machine.snapshot().status, 'catalog');
  assert.equal(machine.snapshot().generation, generation + 1);
  assert.equal(machine.snapshot().session, null);
  assert.equal(machine.snapshot().exited, true);
  assert.equal(machine.dispatch({
    type: 'RECOGNITION_DONE',
    generation,
    transcript: 'late response',
  }), false);
});

test('recovers to the interrupted stable state with a fresh generation', () => {
  const machine = createRoleplayStateMachine();
  machine.dispatch({ type: 'SESSION_READY', session: makeSession() });
  const generation = machine.snapshot().generation;
  machine.dispatch({ type: 'RECORDING_STARTED' });
  machine.dispatch({ type: 'RECOVERABLE_ERROR', code: 'MICROPHONE_DENIED' });

  assert.equal(machine.snapshot().status, 'recoverable_error');
  assert.equal(machine.snapshot().retryStatus, 'ready');
  assert.deepEqual(machine.snapshot().error, { code: 'MICROPHONE_DENIED' });
  assert.equal(machine.dispatch({ type: 'RETRY' }), true);
  assert.equal(machine.snapshot().status, 'ready');
  assert.equal(machine.snapshot().generation, generation + 1);
  assert.equal(machine.snapshot().error, null);
});

test('retry after a failed turn submission preserves the editable transcript', () => {
  const machine = createRoleplayStateMachine();
  machine.dispatch({ type: 'SESSION_READY', session: makeSession() });
  const generation = machine.snapshot().generation;
  machine.dispatch({ type: 'RECORDING_STARTED' });
  machine.dispatch({ type: 'RECOGNITION_DONE', generation, transcript: 'I need a room.' });
  machine.dispatch({ type: 'RECOVERABLE_ERROR', code: 'AI_ROLEPLAY_UNAVAILABLE' });

  assert.equal(machine.snapshot().retryStatus, 'evaluating');
  machine.dispatch({ type: 'RETRY' });
  assert.equal(machine.snapshot().status, 'evaluating');
  assert.equal(machine.snapshot().transcript, 'I need a room.');
  assert.equal(machine.snapshot().generation, generation + 1);
});

test('catalog load errors can return to the catalog for retry', () => {
  const machine = createRoleplayStateMachine();

  assert.equal(machine.dispatch({ type: 'RECOVERABLE_ERROR', code: 'AI_ROLEPLAY_UNAVAILABLE' }), true);
  assert.equal(machine.snapshot().status, 'recoverable_error');
  assert.equal(machine.snapshot().retryStatus, 'catalog');
  assert.equal(machine.dispatch({ type: 'RETRY' }), true);
  assert.equal(machine.snapshot().status, 'catalog');
  assert.equal(machine.snapshot().generation, 1);
});

test('moves to review only from a current completed response', () => {
  const machine = createRoleplayStateMachine();
  machine.dispatch({ type: 'SESSION_READY', session: makeSession() });
  const generation = machine.snapshot().generation;
  machine.dispatch({ type: 'RECORDING_STARTED' });
  machine.dispatch({ type: 'RECOGNITION_DONE', generation, transcript: 'Thank you.' });

  assert.equal(machine.dispatch({
    type: 'AI_DONE',
    generation,
    reviewReady: true,
    turn: { assistant: { text: 'Your room is ready.' } },
  }), true);
  assert.equal(machine.snapshot().status, 'review');
  assert.equal(machine.snapshot().turn.assistant.text, 'Your room is ready.');
});

test('discarding an editable transcript returns to a fresh recording generation', () => {
  const machine = createRoleplayStateMachine();
  machine.dispatch({ type: 'SESSION_READY', session: makeSession() });
  const generation = machine.snapshot().generation;
  machine.dispatch({ type: 'RECORDING_STARTED' });
  machine.dispatch({ type: 'RECOGNITION_DONE', generation, transcript: 'Wrong words' });

  assert.equal(machine.dispatch({ type: 'REDO_RECORDING' }), true);
  assert.equal(machine.snapshot().status, 'ready');
  assert.equal(machine.snapshot().transcript, '');
  assert.equal(machine.snapshot().generation, generation + 1);
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('API preserves canonical string IDs and reuses one turn key while pending', async () => {
  const calls = [];
  const responses = [
    jsonResponse(409, { code: 'TURN_IN_PROGRESS', retry_after_ms: 1 }),
    jsonResponse(201, { session: { id: '9007199254740993' }, turn: { turn_index: 1 } }),
  ];
  const api = createRoleplayApi({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    getToken: () => 'token-value',
    randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sleep: async () => {},
  });

  const result = await api.submitTurn('9007199254740993', { transcript: 'Hello.' });

  assert.equal(result.session.id, '9007199254740993');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/ai-roleplay/sessions/9007199254740993/turns');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-value');
  assert.equal(JSON.parse(calls[0].options.body).turn_key, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(JSON.parse(calls[1].options.body).turn_key, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(canonicalSessionId('001'), null);
  assert.equal(canonicalSessionId(42), '42');
});

test('API never retries authentication failures', async () => {
  let calls = 0;
  const api = createRoleplayApi({
    fetch: async () => {
      calls += 1;
      return jsonResponse(401, { code: 'UNAUTHORIZED' });
    },
    getToken: () => 'expired-token',
    randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sleep: async () => {},
  });

  await assert.rejects(
    api.submitTurn('12', { transcript: 'Hello.' }),
    (error) => error.code === 'UNAUTHORIZED' && error.status === 401,
  );
  assert.equal(calls, 1);
});

test('manual retry reuses the learner response turn key until resolution or discard', () => {
  let sequence = 0;
  const drafts = createTurnDraftStore({
    randomUUID: () => `00000000-0000-4000-8000-00000000000${++sequence}`,
  });

  const first = drafts.begin('I need a room.');
  const retry = drafts.begin('edited after submit');
  assert.deepEqual(retry, first);
  assert.equal(retry.transcript, 'I need a room.');
  assert.equal(sequence, 1);

  drafts.resolve(first.turnKey);
  const next = drafts.begin('Do you have breakfast?');
  assert.notEqual(next.turnKey, first.turnKey);
  assert.equal(sequence, 2);

  drafts.discard();
  const rerecorded = drafts.begin('Where is the lift?');
  assert.notEqual(rerecorded.turnKey, next.turnKey);
  assert.equal(sequence, 3);
});

function hangingPromise() {
  return new Promise(() => {});
}

test('server TTS timeout falls back and always finalizes the current speaking turn', async () => {
  const finished = [];
  const runner = createSpeechTurnRunner({
    serverTimeoutMs: 5,
    audioTimeoutMs: 5,
    synthesisTimeoutMs: 5,
  });

  const played = await runner.play({
    generation: 3,
    signal: new AbortController().signal,
    isCurrent: (generation) => generation === 3,
    generate: () => hangingPromise(),
    playAudio: () => hangingPromise(),
    synthesize: async () => false,
    finish: (generation) => finished.push(generation),
  });

  assert.equal(played, false);
  assert.deepEqual(finished, [3]);
});

test('audio playback timeout aborts the audio stage before speech fallback', async () => {
  let audioSignal = null;
  let synthesisCalls = 0;
  const finished = [];
  const runner = createSpeechTurnRunner({
    serverTimeoutMs: 5,
    audioTimeoutMs: 5,
    synthesisTimeoutMs: 5,
  });

  const played = await runner.play({
    generation: 7,
    signal: new AbortController().signal,
    isCurrent: (generation) => generation === 7,
    generate: async () => ({ audioUrl: '/audio/test.mp3' }),
    playAudio: (_url, _rate, signal) => {
      audioSignal = signal;
      return hangingPromise();
    },
    synthesize: async () => { synthesisCalls += 1; return false; },
    finish: (generation) => finished.push(generation),
  });

  assert.equal(played, false);
  assert.equal(audioSignal.aborted, true);
  assert.equal(synthesisCalls, 1);
  assert.deepEqual(finished, [7]);
});

test('speech synthesis timeout still releases the state machine for recording', async () => {
  let synthesisSignal = null;
  const finished = [];
  const runner = createSpeechTurnRunner({ synthesisTimeoutMs: 5 });

  const played = await runner.play({
    generation: 11,
    signal: new AbortController().signal,
    isCurrent: (generation) => generation === 11,
    generate: async () => { throw new Error('tts offline'); },
    playAudio: () => hangingPromise(),
    synthesize: (_text, _rate, signal) => {
      synthesisSignal = signal;
      return hangingPromise();
    },
    finish: (generation) => finished.push(generation),
  });

  assert.equal(played, false);
  assert.equal(synthesisSignal.aborted, true);
  assert.deepEqual(finished, [11]);
});

test('page exit aborts stale TTS work without finalizing an old generation', async () => {
  let serverSignal = null;
  let synthesisCalls = 0;
  let current = true;
  const finished = [];
  const controller = new AbortController();
  const runner = createSpeechTurnRunner({ serverTimeoutMs: 100 });
  const playback = runner.play({
    generation: 15,
    signal: controller.signal,
    isCurrent: () => current,
    generate: (signal) => {
      serverSignal = signal;
      return hangingPromise();
    },
    playAudio: () => hangingPromise(),
    synthesize: async () => { synthesisCalls += 1; return false; },
    finish: (generation) => finished.push(generation),
  });

  await Promise.resolve();
  current = false;
  controller.abort();
  const played = await playback;

  assert.equal(played, false);
  assert.equal(serverSignal.aborted, true);
  assert.equal(synthesisCalls, 0);
  assert.deepEqual(finished, []);
});

class FakeMediaRecorder {
  static isTypeSupported(type) {
    return type === 'audio/webm;codecs=opus';
  }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'audio/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(['voice'], { type: this.mimeType }) });
    }
    if (this.onstop) this.onstop();
  }
}

function makeRecorderHarness(MediaRecorder = FakeMediaRecorder) {
  const tracks = [
    { stopped: 0, stop() { this.stopped += 1; } },
    { stopped: 0, stop() { this.stopped += 1; } },
  ];
  const stream = { getTracks: () => tracks };
  let timeout = null;
  const recorder = createRoleplayRecorder({
    mediaDevices: { getUserMedia: async () => stream },
    MediaRecorder,
    now: (() => {
      let value = 1_000;
      return () => (value += 600);
    })(),
    setTimeout: (fn, delay) => {
      timeout = { fn, delay };
      return timeout;
    },
    clearTimeout: (handle) => {
      if (handle === timeout) timeout = null;
    },
  });
  return { recorder, tracks, getTimeout: () => timeout };
}

test('recorder allows one active capture, prefers Opus, and stops every track', async () => {
  const { recorder, tracks, getTimeout } = makeRecorderHarness();

  const started = await recorder.start();
  assert.equal(started.mimeType, 'audio/webm;codecs=opus');
  assert.equal(getTimeout().delay, 45_000);
  await assert.rejects(recorder.start(), /RECORDING_IN_PROGRESS/);

  const result = await recorder.stop();
  assert.equal(result.blob.type, 'audio/webm;codecs=opus');
  assert.equal(result.durationSeconds, 0.6);
  assert.deepEqual(tracks.map((track) => track.stopped), [1, 1]);
  assert.equal(recorder.isRecording(), false);
});

test('recorder auto-stops at 45 seconds and cancel releases tracks', async () => {
  const first = makeRecorderHarness();
  await first.recorder.start();
  const stopped = first.recorder.waitForStop();
  first.getTimeout().fn();
  await stopped;
  assert.deepEqual(first.tracks.map((track) => track.stopped), [1, 1]);

  const second = makeRecorderHarness();
  await second.recorder.start();
  await second.recorder.cancel();
  assert.deepEqual(second.tracks.map((track) => track.stopped), [1, 1]);
  assert.equal(second.recorder.isRecording(), false);
});

test('recorder releases tracks when MediaRecorder cannot start', async () => {
  class StartFailureRecorder extends FakeMediaRecorder {
    start() {
      throw new Error('device failed');
    }
  }
  const { recorder, tracks } = makeRecorderHarness(StartFailureRecorder);

  await assert.rejects(recorder.start(), /RECORDING_FAILED/);
  assert.deepEqual(tracks.map((track) => track.stopped), [1, 1]);
  assert.equal(recorder.isRecording(), false);
});

test('page exit invalidates a queued capture before encoding or network submission', async () => {
  let generation = 4;
  let encoded = 0;
  let submitted = 0;
  const captures = createCaptureEpoch({ getGeneration: () => generation });
  const token = captures.begin(generation);

  captures.invalidate();
  generation += 1;
  const result = await captures.process(token, {
    encode: async () => { encoded += 1; return 'audio-data'; },
    submit: async () => { submitted += 1; return { transcript: 'stale' }; },
  });

  assert.deepEqual(result, { stale: true, value: null });
  assert.equal(encoded, 0);
  assert.equal(submitted, 0);
});

test('page exit during encoding prevents a transcription request', async () => {
  let generation = 9;
  let releaseEncoding;
  let submitted = 0;
  const captures = createCaptureEpoch({ getGeneration: () => generation });
  const token = captures.begin(generation);
  const processing = captures.process(token, {
    encode: () => new Promise((resolve) => { releaseEncoding = resolve; }),
    submit: async () => { submitted += 1; return { transcript: 'must not run' }; },
  });

  captures.invalidate();
  generation += 1;
  releaseEncoding('audio-data');
  const result = await processing;

  assert.deepEqual(result, { stale: true, value: null });
  assert.equal(submitted, 0);
});

test('cancel during microphone acquisition stops a late stream before recorder construction', async () => {
  let releaseStream;
  let recorderConstructions = 0;
  const tracks = [{ stopped: 0, stop() { this.stopped += 1; } }];
  const stream = { getTracks: () => tracks };
  class CountingMediaRecorder extends FakeMediaRecorder {
    constructor(...args) {
      super(...args);
      recorderConstructions += 1;
    }
  }
  const recorder = createRoleplayRecorder({
    mediaDevices: {
      getUserMedia: () => new Promise((resolve) => { releaseStream = resolve; }),
    },
    MediaRecorder: CountingMediaRecorder,
  });

  const starting = recorder.start();
  const cancelling = recorder.cancel();
  releaseStream(stream);
  const [started, cancelled] = await Promise.all([starting, cancelling]);
  if (recorder.isRecording()) await recorder.cancel();

  assert.equal(started, null);
  assert.equal(cancelled, null);
  assert.equal(recorderConstructions, 0);
  assert.deepEqual(tracks.map((track) => track.stopped), [1]);
  assert.equal(recorder.isRecording(), false);
});

test('stop during microphone acquisition cancels the late stream and settles both capture promises', async () => {
  let releaseFirstStream;
  let acquisitionCount = 0;
  let recorderConstructions = 0;
  let recorderStarts = 0;
  const firstTracks = [
    { stopped: 0, stop() { this.stopped += 1; } },
    { stopped: 0, stop() { this.stopped += 1; } },
  ];
  const secondTracks = [{ stopped: 0, stop() { this.stopped += 1; } }];
  const firstStream = { getTracks: () => firstTracks };
  const secondStream = { getTracks: () => secondTracks };
  class CountingMediaRecorder extends FakeMediaRecorder {
    constructor(...args) {
      super(...args);
      recorderConstructions += 1;
    }

    start() {
      recorderStarts += 1;
      super.start();
    }
  }
  const recorder = createRoleplayRecorder({
    mediaDevices: {
      getUserMedia: () => {
        acquisitionCount += 1;
        if (acquisitionCount === 1) {
          return new Promise((resolve) => { releaseFirstStream = resolve; });
        }
        return Promise.resolve(secondStream);
      },
    },
    MediaRecorder: CountingMediaRecorder,
  });

  const starting = recorder.start();
  const stopping = recorder.stop();
  const outcome = await Promise.race([
    Promise.all([starting, stopping]),
    new Promise((resolve) => setImmediate(() => resolve('still-pending'))),
  ]);
  if (outcome === 'still-pending') {
    releaseFirstStream(firstStream);
    await recorder.cancel();
    await Promise.allSettled([starting, stopping]);
  }

  assert.deepEqual(outcome, [null, null]);
  assert.equal(recorderConstructions, 0);
  assert.equal(recorderStarts, 0);
  assert.equal(recorder.isRecording(), false);

  const next = await recorder.start();
  assert.equal(next.mimeType, 'audio/webm;codecs=opus');
  await recorder.cancel();
  releaseFirstStream(firstStream);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recorderConstructions, 1);
  assert.equal(recorderStarts, 1);
  assert.deepEqual(firstTracks.map((track) => track.stopped), [1, 1]);
  assert.deepEqual(secondTracks.map((track) => track.stopped), [1]);
});

test('client stop during pending acquisition returns to ready without transcription', async () => {
  let releaseStream;
  let recorderConstructions = 0;
  let encoded = 0;
  let submitted = 0;
  const tracks = [{ stopped: 0, stop() { this.stopped += 1; } }];
  const stream = { getTracks: () => tracks };
  class CountingMediaRecorder extends FakeMediaRecorder {
    constructor(...args) {
      super(...args);
      recorderConstructions += 1;
    }
  }
  const recorder = createRoleplayRecorder({
    mediaDevices: {
      getUserMedia: () => new Promise((resolve) => { releaseStream = resolve; }),
    },
    MediaRecorder: CountingMediaRecorder,
  });
  const machine = createRoleplayStateMachine();
  machine.dispatch({ type: 'SESSION_READY', session: makeSession() });
  const generation = machine.snapshot().generation;
  const captures = createCaptureEpoch({
    getGeneration: () => machine.snapshot().generation,
  });

  machine.dispatch({ type: 'RECORDING_STARTED' });
  const captureToken = captures.begin(generation);
  const starting = recorder.start();
  machine.dispatch({ type: 'RECORDING_STOPPED' });
  const stopping = recorder.stop();
  releaseStream(stream);
  const [started, stopped] = await Promise.all([starting, stopping]);
  if (!stopped) {
    captures.invalidate();
    machine.dispatch({ type: 'RECORDING_CANCELLED', generation });
  }
  const staleCapture = await captures.process(captureToken, {
    encode: async () => { encoded += 1; return 'audio-data'; },
    submit: async () => { submitted += 1; return { transcript: 'must not run' }; },
  });

  assert.equal(started, null);
  assert.equal(stopped, null);
  assert.equal(machine.snapshot().status, 'ready');
  assert.equal(machine.snapshot().generation, generation + 1);
  assert.deepEqual(staleCapture, { stale: true, value: null });
  assert.equal(encoded, 0);
  assert.equal(submitted, 0);
  assert.equal(recorderConstructions, 0);
  assert.deepEqual(tracks.map((track) => track.stopped), [1]);
  assert.equal(recorder.isRecording(), false);
});

test('immediate microphone resolution stopped concurrently closes tracks without transcription', async () => {
  let acquisitionCount = 0;
  let recorderConstructions = 0;
  let recorderStarts = 0;
  let encoded = 0;
  let submitted = 0;
  const firstTracks = [
    { stopped: 0, stop() { this.stopped += 1; } },
    { stopped: 0, stop() { this.stopped += 1; } },
  ];
  const secondTracks = [{ stopped: 0, stop() { this.stopped += 1; } }];
  const streams = [
    { getTracks: () => firstTracks },
    { getTracks: () => secondTracks },
  ];
  class CountingMediaRecorder extends FakeMediaRecorder {
    constructor(...args) {
      super(...args);
      recorderConstructions += 1;
    }

    start() {
      recorderStarts += 1;
      super.start();
    }
  }
  const recorder = createRoleplayRecorder({
    mediaDevices: {
      getUserMedia: () => Promise.resolve(streams[acquisitionCount++]),
    },
    MediaRecorder: CountingMediaRecorder,
  });
  const machine = createRoleplayStateMachine();
  machine.dispatch({ type: 'SESSION_READY', session: makeSession() });
  const generation = machine.snapshot().generation;
  const captures = createCaptureEpoch({
    getGeneration: () => machine.snapshot().generation,
  });

  machine.dispatch({ type: 'RECORDING_STARTED' });
  const captureToken = captures.begin(generation);
  const starting = recorder.start();
  machine.dispatch({ type: 'RECORDING_STOPPED' });
  const stopping = recorder.stop();
  const [started, stopped] = await Promise.all([starting, stopping]);
  if (!stopped) {
    captures.invalidate();
    machine.dispatch({ type: 'RECORDING_CANCELLED', generation });
  }
  const staleCapture = await captures.process(captureToken, {
    encode: async () => { encoded += 1; return 'audio-data'; },
    submit: async () => { submitted += 1; return { transcript: 'must not run' }; },
  });

  assert.equal(started, null);
  assert.equal(stopped, null);
  assert.equal(recorderConstructions, 0);
  assert.equal(recorderStarts, 0);
  assert.deepEqual(firstTracks.map((track) => track.stopped), [1, 1]);
  assert.equal(machine.snapshot().status, 'ready');
  assert.equal(machine.snapshot().generation, generation + 1);
  assert.deepEqual(staleCapture, { stale: true, value: null });
  assert.equal(encoded, 0);
  assert.equal(submitted, 0);
  assert.equal(recorder.isRecording(), false);

  const next = await recorder.start();
  assert.equal(next.mimeType, 'audio/webm;codecs=opus');
  await recorder.cancel();
  assert.equal(recorderConstructions, 1);
  assert.equal(recorderStarts, 1);
  assert.deepEqual(secondTracks.map((track) => track.stopped), [1]);
});

test('a thrown recorder stop still rejects cleanly and releases every track', async () => {
  class StopFailureRecorder extends FakeMediaRecorder {
    stop() {
      throw new Error('device stop failed');
    }
  }
  const { recorder, tracks } = makeRecorderHarness(StopFailureRecorder);
  await recorder.start();

  await assert.rejects(
    recorder.stop(),
    (error) => error.code === 'RECORDING_FAILED',
  );
  assert.deepEqual(tracks.map((track) => track.stopped), [1, 1]);
  assert.equal(recorder.isRecording(), false);
  assert.equal(await recorder.cancel(), null);
});

test('the 45-second timer contains stop failures and settles the capture', async () => {
  class StopFailureRecorder extends FakeMediaRecorder {
    stop() {
      throw new Error('timer stop failed');
    }
  }
  const { recorder, tracks, getTimeout } = makeRecorderHarness(StopFailureRecorder);
  await recorder.start();
  const stopped = recorder.waitForStop();

  assert.doesNotThrow(() => getTimeout().fn());
  await assert.rejects(stopped, (error) => error.code === 'RECORDING_FAILED');
  assert.deepEqual(tracks.map((track) => track.stopped), [1, 1]);
  assert.equal(recorder.isRecording(), false);
});
