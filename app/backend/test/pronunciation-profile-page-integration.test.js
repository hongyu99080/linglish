const test = require('node:test');
const assert = require('node:assert/strict');
const { types: pgTypes } = require('pg');

const profile = require('../../frontend/js/practice/pronunciation-profile-ui');
const parsePgInt8 = pgTypes.getTypeParser(20);

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.innerHTML = '';
    this.hidden = false;
    this.listeners = {};
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() { this.parentNode?.removeChild(this); }
  addEventListener(name, listener) { this.listeners[name] = listener; }

  querySelector(selector) {
    if (selector === '[data-pronunciation-focus-cta]' && this.innerHTML.includes('data-pronunciation-focus-cta')) {
      if (this.focusAnchor) return this.focusAnchor;
      const href = this.innerHTML.match(/data-pronunciation-focus-cta="true" href="([^"]+)"/)?.[1] || '';
      const anchor = new FakeElement('a', this.ownerDocument);
      anchor.setAttribute('href', href);
      this.focusAnchor = anchor;
      return this.focusAnchor;
    }
    return null;
  }
}

class FakeDocument {
  createElement(tagName) { return new FakeElement(tagName, this); }
}

function readyProfile() {
  return {
    status: 'ready',
    sample_count: 3,
    dimensions: [
      { key: 'clarity', label: '词级清晰', score: 82, evidence: 'transcript_alignment' },
      { key: 'pace', label: '短语节奏', score: 74, evidence: 'recording_signal' },
    ],
    focus_items: [{
      skill_type: 'missing_word',
      display_target: 'school',
      sample_text: 'The school bus is here',
      evidence_level: 'transcript_alignment',
      status: 'focus',
      video_resource_id: 8,
      assessment_id: 17,
    }],
    trend: { direction: 'up' },
    disclaimer: '画像会随练习更新。',
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('focus locator chooses the matching transcript and rejects a weak coincidence', () => {
  assert.deepEqual(profile.locateFocusSegment([
    { index: 0, text: 'Good morning' },
    { index: 1, text: 'The school bus is here' },
  ], 'School bus is here'), { index: 1, score: 1 });
  assert.equal(profile.locateFocusSegment([
    { index: 0, text: 'A bus' },
  ], 'School is closed today'), null);
  assert.deepEqual(profile.locateFocusSegment([
    { text: 'Good morning' },
    { text: 'The school bus is here' },
  ], 'School bus'), { index: 1, score: 1 });
});

test('Today profile integration preserves page content and renders page-specific focus links', async () => {
  for (const mobile of [false, true]) {
    const document = new FakeDocument();
    const page = document.createElement('main');
    const legacy = document.createElement('section');
    const section = document.createElement('section');
    const mountPoint = document.createElement('div');
    const loading = document.createElement('div');
    loading.setAttribute('data-pronunciation-profile-loading', 'true');
    page.appendChild(legacy);
    page.appendChild(section);
    section.appendChild(mountPoint);
    mountPoint.appendChild(loading);
    const events = [];

    const loaded = await profile.loadProfileSection({
      authenticated: true,
      section,
      container: mountPoint,
      mobile,
      request: async () => readyProfile(),
      emit: (name, properties) => events.push({ name, properties }),
    });

    assert.equal(loaded.status, 'ready');
    assert.deepEqual(page.children, [legacy, section]);
    assert.equal(section.hidden, false);
    assert.equal(mountPoint.children.length, 1);
    assert.notEqual(mountPoint.children[0], loading);
    const html = mountPoint.children[0].innerHTML;
    assert.match(html, mobile ? /href="video-reader\.html\?/ : /href="practice-session-desktop\.html\?/);
    assert.match(html, /videoId=8&amp;focusAssessment=17/);
    assert.doesNotMatch(html, /href="[^"]*(?:school|The%20school)/i);
    assert.deepEqual(events.map((event) => event.name), ['pronunciation_profile_view']);
  }
});

test('Today profile failures hide only the new section', async () => {
  for (const scenario of [
    { authenticated: false, request: async () => readyProfile() },
    { authenticated: true, request: async () => ({ status: 'ready', dimensions: 'bad' }) },
    { authenticated: true, request: async () => { throw new Error('offline'); } },
  ]) {
    const document = new FakeDocument();
    const page = document.createElement('main');
    const legacy = document.createElement('section');
    const section = document.createElement('section');
    const mountPoint = document.createElement('div');
    page.appendChild(legacy);
    page.appendChild(section);
    section.appendChild(mountPoint);

    const loaded = await profile.loadProfileSection({
      ...scenario,
      section,
      container: mountPoint,
    });

    assert.equal(loaded, null);
    assert.equal(section.hidden, true);
    assert.equal(legacy.hidden, false);
    assert.deepEqual(page.children, [legacy, section]);
  }
});

test('production Today controller skips profile and analytics requests for guest and temporary users', async () => {
  const users = [
    null,
    { id: 8, email: 'guest_8@temp.linglish.local' },
    { id: 9, email: 'learner@example.com', is_guest: true },
  ];

  for (const user of users) {
    const document = new FakeDocument();
    const section = document.createElement('section');
    const container = document.createElement('div');
    section.appendChild(container);
    let profileRequests = 0;
    let analyticsRequests = 0;
    const emit = profile.createPronunciationEventTransport({
      fetch: async () => { analyticsRequests += 1; return { ok: true }; },
      getToken: () => 'private-token',
      endpoint: '/events',
      source: 'web',
    });
    const controller = profile.createTodayProfileController({
      section,
      container,
      requestProfile: async () => { profileRequests += 1; return readyProfile(); },
      emit,
    });

    const value = await controller.load(user);

    assert.equal(value, null);
    assert.equal(profileRequests, 0);
    assert.equal(analyticsRequests, 0);
    assert.equal(section.hidden, true);
  }
});

test('production Today controller sends exact anonymous final payloads and canonical focus hrefs', async () => {
  for (const device of [
    { mobile: false, source: 'web', page: 'practice-session-desktop.html' },
    { mobile: true, source: 'mobile_web', page: 'video-reader.html' },
  ]) {
    const document = new FakeDocument();
    const section = document.createElement('section');
    const container = document.createElement('div');
    section.appendChild(container);
    const requests = [];
    const emit = profile.createPronunciationEventTransport({
      fetch: async (url, options) => {
        requests.push({ url, options, body: JSON.parse(options.body) });
        return { ok: true };
      },
      getToken: () => 'private-token',
      endpoint: (token) => token ? '/events' : '/track/event',
      source: device.source,
    });
    const controller = profile.createTodayProfileController({
      section,
      container,
      mobile: device.mobile,
      requestProfile: async () => readyProfile(),
      emit,
    });

    const value = await controller.load({ id: 42, email: 'learner@example.com' });
    assert.equal(value.status, 'ready');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/events');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer private-token');
    assert.deepEqual(requests[0].body, {
      event_name: 'pronunciation_profile_view',
      properties: {
        profile_status: 'ready',
        sample_bucket: '3_plus',
        trend_direction: 'up',
        focus_types: ['missing_word'],
        focus_count: 1,
      },
      source: device.source,
    });

    const host = container.children[0];
    assert.match(host.innerHTML, new RegExp(`href="${device.page.replace('.', '\\.')}\\?`));
    assert.match(host.innerHTML, /from=pronunciation_map/);
    assert.doesNotMatch(host.innerHTML, /from=pronunciation_profile/);
    host.focusAnchor.listeners.click();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body, {
      event_name: 'pronunciation_focus_start',
      properties: {
        profile_status: 'ready',
        sample_bucket: '3_plus',
        trend_direction: 'up',
        focus_types: ['missing_word'],
        focus_count: 1,
        focus_type: 'missing_word',
      },
      source: device.source,
    });
    const serialized = JSON.stringify(requests.map((request) => request.body));
    assert.doesNotMatch(serialized, /url|referrer|learning_goal|visitor_id|user_id|assessment_id|video_resource_id|school|learner@example/i);
  }
});

test('focus controller fetches only after transcript and player readiness, then seeks and highlights', async () => {
  const calls = [];
  const segments = [
    { index: 4, start: 0.1, text: 'Good morning' },
    { index: 9, start: 3, text: 'The school bus is here' },
  ];
  const controller = profile.createFocusController({
    assessmentId: '17',
    getLoadedVideoId: () => 8,
    getSegments: () => segments,
    fetchFocus: async (assessmentId) => {
      calls.push(['fetch', assessmentId]);
      return { id: 17, video_resource_id: 8, text: 'School bus is here' };
    },
    apply: (position) => calls.push(['apply', position]),
    feedback: (message, kind) => calls.push(['feedback', message, kind]),
  });

  await controller.markTranscriptReady();
  assert.deepEqual(calls, []);
  const result = await controller.markPlayerReady();

  assert.equal(result.status, 'applied');
  assert.deepEqual(calls[0], ['fetch', 17]);
  assert.deepEqual(calls[1], ['apply', {
    arrayIndex: 1,
    segmentIndex: 9,
    score: 1,
    seekTime: 2.8,
    segment: segments[1],
  }]);
  assert.deepEqual(calls[2], ['feedback', '已定位到你的发音重点', 'success']);
  await controller.markPlayerReady();
  assert.equal(calls.filter(([name]) => name === 'fetch').length, 1);
});

test('focus controller compares real pg int8 video ids as canonical strings', async () => {
  const videoId = parsePgInt8('9007199254740993');
  const assessmentId = parsePgInt8('9223372036854775807');
  let applied = false;
  const controller = profile.createFocusController({
    assessmentId,
    getLoadedVideoId: () => videoId,
    getSegments: () => [{ index: 0, start: 2, text: 'School bus' }],
    fetchFocus: async (receivedId) => {
      assert.equal(receivedId, assessmentId);
      return { id: assessmentId, video_resource_id: videoId, text: 'School bus' };
    },
    apply: () => { applied = true; },
  });

  await controller.markTranscriptReady();
  assert.equal((await controller.markPlayerReady()).status, 'applied');
  assert.equal(applied, true);
});

test('focus failure or video mismatch leaves normal playback state untouched with non-blocking feedback', async () => {
  for (const fetchFocus of [
    async () => { throw new Error('offline'); },
    async () => ({ id: 17, video_resource_id: 99, text: 'School bus' }),
  ]) {
    const playback = { selectedVideoId: 8, currentTime: 11, recordingStarted: false };
    const feedback = [];
    const controller = profile.createFocusController({
      assessmentId: '17',
      getLoadedVideoId: () => playback.selectedVideoId,
      getSegments: () => [{ index: 0, start: 3, text: 'School bus' }],
      fetchFocus,
      apply: () => { throw new Error('must not position mismatched or failed focus'); },
      feedback: (message, kind) => feedback.push({ message, kind }),
    });

    await controller.markPlayerReady();
    const result = await controller.markTranscriptReady();

    assert.equal(result.status, 'unavailable');
    assert.deepEqual(playback, { selectedVideoId: 8, currentTime: 11, recordingStarted: false });
    assert.deepEqual(feedback, [{
      message: '暂时无法定位发音重点，你仍可正常练习',
      kind: 'info',
    }]);
  }
});

test('focus controller ignores non-positive or non-numeric assessment parameters', async () => {
  for (const assessmentId of [null, '', '0', '-1', '17x', 0, -1]) {
    let fetched = false;
    const controller = profile.createFocusController({
      assessmentId,
      getLoadedVideoId: () => 8,
      getSegments: () => [{ index: 0, start: 0, text: 'School bus' }],
      fetchFocus: async () => { fetched = true; return {}; },
    });
    await controller.markTranscriptReady();
    const result = await controller.markPlayerReady();
    assert.equal(result.status, 'ignored');
    assert.equal(fetched, false);
  }
});

test('focus controller rejects a coerced returned video ID', async () => {
  let applied = false;
  const controller = profile.createFocusController({
    assessmentId: '17',
    getLoadedVideoId: () => 1,
    getSegments: () => [{ index: 0, start: 0, text: 'School bus' }],
    fetchFocus: async () => ({ id: 17, video_resource_id: true, text: 'School bus' }),
    apply: () => { applied = true; },
  });

  await controller.markTranscriptReady();
  const result = await controller.markPlayerReady();

  assert.equal(result.status, 'unavailable');
  assert.equal(applied, false);
});

test('production mobile focus controller cancels an in-flight target when video generation changes', async () => {
  const response = deferred();
  let currentVideoId = 8;
  let segments = [{ index: 0, start: 3, text: 'School bus' }];
  let fetches = 0;
  const effects = [];
  const controller = profile.createVideoFocusController({
    assessmentId: '17',
    targetVideoId: 8,
    getCurrentVideoId: () => currentVideoId,
    getSegments: () => segments,
    fetchFocus: async () => { fetches += 1; return response.promise; },
    seek: (time) => effects.push(['seek', time]),
    highlight: (position) => effects.push(['highlight', position]),
    feedback: (message, kind) => effects.push(['feedback', message, kind]),
  });

  const targetGeneration = controller.selectVideo(8);
  await controller.markTranscriptReady({ videoId: 8, generation: targetGeneration });
  const pending = controller.markPlayerReady({ videoId: 8, generation: targetGeneration });
  assert.equal(fetches, 1);

  currentVideoId = 9;
  const otherGeneration = controller.selectVideo(9);
  segments = [{ index: 0, start: 20, text: 'School bus' }];
  await controller.markTranscriptReady({ videoId: 9, generation: otherGeneration });
  await controller.markPlayerReady({ videoId: 9, generation: otherGeneration });
  response.resolve({ id: 17, video_resource_id: 8, text: 'School bus' });

  assert.equal((await pending).status, 'cancelled');
  assert.equal(fetches, 1);
  assert.deepEqual(effects, []);
  await controller.markTranscriptReady({ videoId: 8, generation: targetGeneration });
  await controller.markPlayerReady({ videoId: 8, generation: targetGeneration });
  assert.equal(fetches, 1);
});

test('production mobile focus controller ignores stale same-video readiness from an older generation', async () => {
  let currentVideoId = 8;
  let fetches = 0;
  const controller = profile.createVideoFocusController({
    assessmentId: '17',
    targetVideoId: 8,
    getCurrentVideoId: () => currentVideoId,
    getSegments: () => [{ index: 0, start: 1, text: 'School bus' }],
    fetchFocus: async () => {
      fetches += 1;
      return { id: 17, video_resource_id: 8, text: 'School bus' };
    },
    seek: () => {},
    highlight: () => {},
  });

  const oldGeneration = controller.selectVideo(8);
  const currentGeneration = controller.selectVideo(8);
  await controller.markTranscriptReady({ videoId: 8, generation: oldGeneration });
  await controller.markPlayerReady({ videoId: 8, generation: oldGeneration });
  assert.equal(fetches, 0);
  await controller.markTranscriptReady({ videoId: 8, generation: currentGeneration });
  await controller.markPlayerReady({ videoId: 8, generation: currentGeneration });
  assert.equal(fetches, 1);
  assert.equal(currentVideoId, 8);
});

test('production mobile focus controller re-reads replaced subtitles and never starts media capture or playback', async () => {
  const response = deferred();
  let currentVideoId = 8;
  let segments = [{ index: 4, start: 2, text: 'The school bus is here' }];
  const calls = { seek: [], highlight: [], play: 0, record: 0, getUserMedia: 0 };
  const media = {
    seek: (time) => calls.seek.push(time),
    play: () => { calls.play += 1; },
    record: () => { calls.record += 1; },
    getUserMedia: () => { calls.getUserMedia += 1; },
  };
  const controller = profile.createVideoFocusController({
    assessmentId: '17',
    targetVideoId: 8,
    getCurrentVideoId: () => currentVideoId,
    getSegments: () => segments,
    fetchFocus: async () => response.promise,
    seek: media.seek,
    highlight: (position) => calls.highlight.push(position),
  });

  const generation = controller.selectVideo(8);
  await controller.markTranscriptReady({ videoId: 8, generation });
  const pending = controller.markPlayerReady({ videoId: 8, generation });
  segments = [
    { index: 7, start: 1, text: 'Good morning' },
    { index: 12, start: 10, text: 'The school bus is here' },
  ];
  response.resolve({ id: 17, video_resource_id: 8, text: 'School bus is here' });

  const result = await pending;
  assert.equal(result.status, 'applied');
  assert.deepEqual(calls.seek, [9.8]);
  assert.deepEqual(calls.highlight, [{
    arrayIndex: 1,
    segmentIndex: 12,
    score: 1,
    segment: segments[1],
  }]);
  assert.equal(calls.play, 0);
  assert.equal(calls.record, 0);
  assert.equal(calls.getUserMedia, 0);
  assert.equal(currentVideoId, 8);
});

test('production mobile focus controller waits for transcript preparation before fetching focus', async () => {
  const preparation = deferred();
  let fetches = 0;
  const controller = profile.createVideoFocusController({
    assessmentId: '17',
    targetVideoId: 8,
    getCurrentVideoId: () => 8,
    getSegments: () => [{ index: 0, start: 1, text: 'School bus' }],
    fetchFocus: async () => {
      fetches += 1;
      return { id: 17, video_resource_id: 8, text: 'School bus' };
    },
    seek: () => {},
    highlight: () => {},
  });

  const generation = controller.selectVideo(8);
  const transcriptReady = controller.markTranscriptReady({
    videoId: 8,
    generation,
    prepare: preparation.promise,
  });
  const playerResult = await controller.markPlayerReady({ videoId: 8, generation });

  assert.equal(playerResult.status, 'waiting');
  assert.equal(fetches, 0);
  preparation.resolve();
  assert.equal((await transcriptReady).status, 'applied');
  assert.equal(fetches, 1);
});

test('production video reader selection adapter rejects stale same-video async completions and routes only current readiness', async () => {
  const state = {
    selectedVideoId: null,
    selectionGeneration: 0,
    detail: null,
    segments: [],
    speakers: [],
    dom: [],
  };
  const focusFetches = [];
  const focusReadiness = [];
  const focusController = profile.createVideoFocusController({
    assessmentId: '17',
    targetVideoId: 8,
    getCurrentVideoId: () => state.selectedVideoId,
    getSegments: () => state.segments,
    fetchFocus: async (_assessmentId, signal) => {
      focusFetches.push(signal);
      return { id: 17, video_resource_id: 8, text: 'Latest transcript' };
    },
    seek: () => {},
    highlight: () => {},
  });
  const adapter = profile.createVideoReaderSelectionAdapter({
    onSelect(selection) {
      state.selectedVideoId = selection.videoId;
      state.selectionGeneration = selection.generation;
      focusController.selectVideo(selection.videoId, selection.generation);
    },
  });

  const first = adapter.select(8);
  const staleDetail = deferred();
  const staleTranscript = deferred();
  const staleSpeaker = deferred();
  const staleWaveform = deferred();
  const staleCompletions = [
    staleDetail.promise.then((value) => adapter.commit(first, () => {
      state.detail = value;
      state.dom.push('first-detail');
    })),
    staleTranscript.promise.then((value) => adapter.commit(first, () => {
      state.segments = value;
      state.dom.push('first-transcript');
    })),
    staleSpeaker.promise.then((value) => adapter.commit(first, () => {
      state.speakers = value;
      state.dom.push('first-speaker');
    })),
    staleWaveform.promise.then((value) => adapter.commit(first, () => {
      state.segments = value;
      state.dom.push('first-waveform');
    })),
  ];

  const second = adapter.select(8);
  staleSpeaker.resolve(['stale speaker']);
  staleDetail.resolve({ title: 'stale detail' });
  staleWaveform.resolve([{ index: 4, start: 4, text: 'Stale waveform' }]);
  staleTranscript.resolve([{ index: 3, start: 3, text: 'Stale transcript' }]);
  assert.deepEqual(await Promise.all(staleCompletions), [false, false, false, false]);
  assert.deepEqual(state, {
    selectedVideoId: 8,
    selectionGeneration: second.generation,
    detail: null,
    segments: [],
    speakers: [],
    dom: [],
  });

  assert.equal(adapter.commit(first, () => focusReadiness.push('stale-transcript')), false);
  const latestDetail = { title: 'latest detail' };
  const latestSegments = [{ index: 9, start: 5, text: 'Latest transcript' }];
  const latestSpeakers = ['latest speaker'];
  assert.equal(adapter.commit(second, () => {
    state.detail = latestDetail;
    state.dom.push('latest-detail');
  }), true);
  assert.equal(adapter.commit(second, () => {
    state.segments = latestSegments;
    state.dom.push('latest-transcript');
  }), true);
  assert.equal(adapter.commit(second, () => {
    state.speakers = latestSpeakers;
    state.dom.push('latest-speaker');
  }), true);
  assert.equal(adapter.commit(second, () => {
    state.segments = latestSegments;
    state.dom.push('latest-waveform');
  }), true);
  const transcriptReady = adapter.commit(second, () => {
    focusReadiness.push(`transcript:${second.generation}`);
    return focusController.markTranscriptReady(second);
  });
  const playerReady = adapter.commit(second, () => {
    focusReadiness.push(`player:${second.generation}`);
    return focusController.markPlayerReady(second);
  });

  await transcriptReady;
  assert.equal((await playerReady).status, 'applied');
  assert.deepEqual(state.dom, ['latest-detail', 'latest-transcript', 'latest-speaker', 'latest-waveform']);
  assert.deepEqual(state.segments, latestSegments);
  assert.deepEqual(state.speakers, latestSpeakers);
  assert.deepEqual(focusReadiness, [`transcript:${second.generation}`, `player:${second.generation}`]);
  assert.equal(focusFetches.length, 1);
});

test('production video reader selection adapter destroys stale YouTube initialization before listener registration', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const first = adapter.select(8);
  const staleInit = deferred();
  const registrations = [];
  const stalePlayer = {
    destroyed: 0,
    destroy() {
      this.destroyed += 1;
      adapter.commit(first, () => registrations.push('stale-destroy-callback'));
    },
  };
  assert.equal(adapter.trackDisposable(first, stalePlayer), true);
  const staleCompletion = staleInit.promise.then(() => adapter.activateDisposable(first, stalePlayer, () => {
    registrations.push('stale-listeners');
  }));

  const second = adapter.select(8);
  assert.equal(stalePlayer.destroyed, 1);
  staleInit.resolve();
  assert.equal(await staleCompletion, false);
  assert.deepEqual(registrations, []);
  assert.equal(stalePlayer.destroyed, 1);

  const currentPlayer = {
    destroyed: 0,
    destroy() { this.destroyed += 1; },
  };
  assert.equal(adapter.trackDisposable(second, currentPlayer), true);
  assert.equal(adapter.activateDisposable(second, currentPlayer, () => {
    registrations.push(`current:${second.generation}`);
  }), true);
  assert.deepEqual(registrations, [`current:${second.generation}`]);
  assert.equal(currentPlayer.destroyed, 0);
});

test('production SmartImport coordinator abandons a stale pending session and gives the same-video successor a finishable session', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const starts = [];
  const abandoned = [];
  const finished = [];
  const activated = [];
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    startSession(videoId) {
      const response = deferred();
      starts.push({ videoId, response });
      return response.promise;
    },
    async abandonSession(sessionId) {
      abandoned.push(sessionId);
    },
    async finishSession(sessionId, watchedSegments, watchDurationSec) {
      finished.push({ sessionId, watchedSegments, watchDurationSec });
      return { recommendations: ['successor'] };
    },
    onSession(result, selection) {
      activated.push({ sessionId: result.sessionId, generation: selection.generation });
    },
  });

  const first = adapter.select(8);
  const firstStart = coordinator.start(first);
  const second = adapter.select(8);
  const secondStart = coordinator.start(second);
  assert.deepEqual(starts.map(({ videoId }) => videoId), [8, 8]);

  starts[0].response.resolve({ sessionId: 'stale-session' });
  assert.equal((await firstStart).status, 'discarded');
  assert.deepEqual(abandoned, ['stale-session']);
  assert.deepEqual(activated, []);

  starts[1].response.resolve({ sessionId: 'successor-session', userLevel: 'advanced', importBudget: 9 });
  assert.equal((await secondStart).status, 'active');
  assert.deepEqual(activated, [{ sessionId: 'successor-session', generation: second.generation }]);

  const finishResult = await coordinator.finish(second, [2, 5], 31);
  assert.equal(finishResult.status, 'finished');
  assert.deepEqual(finished, [{
    sessionId: 'successor-session',
    watchedSegments: [2, 5],
    watchDurationSec: 31,
  }]);
});

test('production SmartImport transition abandons ready session before processing selection and resets page state', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const abandoned = [];
  const starts = [];
  const resets = [];
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    startSession: async (videoId) => {
      starts.push(videoId);
      return { sessionId: `session-${videoId}` };
    },
    abandonSession: async (sessionId) => abandoned.push(sessionId),
    onReset: (selection) => resets.push(selection.videoId),
  });

  const ready = adapter.select(8);
  assert.equal((await coordinator.transition(ready, { ready: true })).status, 'active');
  const processing = adapter.select(9);
  assert.equal((await coordinator.transition(processing, { ready: false })).status, 'inactive');

  assert.deepEqual(starts, [8]);
  assert.deepEqual(abandoned, ['session-8']);
  assert.deepEqual(resets, [8, 9]);
  assert.equal(coordinator.getActiveSessionId(), null);
});

test('production SmartImport transition abandons ready session on clear without touching a later session', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const abandoned = [];
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    startSession: async (videoId) => ({ sessionId: `session-${videoId}` }),
    abandonSession: async (sessionId) => abandoned.push(sessionId),
  });

  const first = adapter.select(8);
  await coordinator.transition(first, { ready: true });
  const cleared = adapter.select(null);
  await coordinator.transition(cleared, { ready: false });
  const second = adapter.select(10);
  await coordinator.transition(second, { ready: true });

  assert.deepEqual(abandoned, ['session-8']);
  assert.equal(coordinator.getActiveSessionId(), 'session-10');
});

test('production SmartImport dispose abandons the active session once on unload', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const abandoned = [];
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    startSession: async () => ({ sessionId: 'session-unload' }),
    abandonSession: async (sessionId) => abandoned.push(sessionId),
  });
  const selection = adapter.select(8);
  await coordinator.transition(selection, { ready: true });

  assert.equal((await coordinator.dispose()).status, 'abandoned');
  assert.equal((await coordinator.dispose()).status, 'inactive');
  assert.deepEqual(abandoned, ['session-unload']);
  assert.equal(coordinator.getActiveSessionId(), null);
});

test('production SmartImport unload closes a pending lifecycle before its start response arrives', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const response = deferred();
  const starts = [];
  const closed = [];
  const abandoned = [];
  const lifecycleKey = '11111111-1111-4111-8111-111111111111';
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    createLifecycleKey: () => lifecycleKey,
    startSession(videoId, key) {
      starts.push({ videoId, lifecycleKey: key });
      return response.promise;
    },
    closeLifecycle: async (lifecycle) => closed.push(lifecycle),
    abandonSession: async (sessionId) => abandoned.push(sessionId),
  });

  const selection = adapter.select(8);
  const starting = coordinator.transition(selection, { ready: true });
  await Promise.resolve();
  assert.deepEqual(starts, [{ videoId: 8, lifecycleKey }]);

  const disposing = coordinator.dispose();
  assert.deepEqual(closed, [{ lifecycleKey, videoId: 8, sessionId: null }]);
  response.resolve({ sessionId: 'server-created-before-unload', status: 'active' });

  assert.equal((await disposing).status, 'abandoned');
  assert.equal((await starting).status, 'discarded');
  assert.deepEqual(abandoned, []);
  assert.equal(coordinator.getActiveSessionId(), null);
});

test('production SmartImport lifecycle close is generation-specific before and after start response ordering', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const keys = [
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];
  const starts = [];
  const closed = [];
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    createLifecycleKey: () => keys.shift(),
    async startSession(videoId, lifecycleKey) {
      starts.push({ videoId, lifecycleKey });
      return { sessionId: `session-${lifecycleKey.slice(0, 1)}`, status: 'active' };
    },
    closeLifecycle: async (lifecycle) => closed.push(lifecycle),
  });

  const first = adapter.select(8);
  assert.equal((await coordinator.transition(first, { ready: true })).status, 'active');
  const second = adapter.select(8);
  assert.equal((await coordinator.transition(second, { ready: true })).status, 'active');

  assert.deepEqual(closed, [{
    lifecycleKey: '22222222-2222-4222-8222-222222222222',
    videoId: 8,
    sessionId: 'session-2',
  }]);
  assert.deepEqual(starts.map(({ lifecycleKey }) => lifecycleKey), [
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ]);
  assert.equal(coordinator.getActiveSessionId(), 'session-3');
});

test('production SmartImport keeps a rejected start lifecycle so unload can tombstone the same key', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const lifecycleKey = '44444444-4444-4444-8444-444444444444';
  const starts = [];
  const closed = [];
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    createLifecycleKey: () => lifecycleKey,
    async startSession(videoId, key) {
      starts.push({ videoId, lifecycleKey: key });
      throw new Error('response lost after commit');
    },
    async closeLifecycle(lifecycle) {
      closed.push(lifecycle);
      return true;
    },
  });
  const selection = adapter.select(8);

  assert.equal((await coordinator.transition(selection, { ready: true })).status, 'failed');
  assert.equal((await coordinator.dispose()).status, 'abandoned');
  assert.deepEqual(starts, [{ videoId: 8, lifecycleKey }]);
  assert.deepEqual(closed, [{ lifecycleKey, videoId: 8, sessionId: null }]);
});

test('production SmartImport retries a failed same-generation start with its original lifecycle key', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const lifecycleKey = '55555555-5555-4555-8555-555555555555';
  const serverSessions = new Map();
  const keys = [];
  let attempt = 0;
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    createLifecycleKey: () => {
      assert.equal(keys.length, 0, 'same generation must not request a second key');
      return lifecycleKey;
    },
    async startSession(_videoId, key) {
      keys.push(key);
      if (!serverSessions.has(key)) serverSessions.set(key, 'server-session-stable');
      attempt += 1;
      if (attempt === 1) throw new Error('network response lost');
      return { sessionId: serverSessions.get(key), status: 'active' };
    },
  });
  const selection = adapter.select(8);

  assert.equal((await coordinator.start(selection)).status, 'failed');
  const retried = await coordinator.start(selection);

  assert.equal(retried.status, 'active');
  assert.equal(retried.result.sessionId, 'server-session-stable');
  assert.deepEqual(keys, [lifecycleKey, lifecycleKey]);
});

test('production SmartImport deduplicates concurrent close and retains ownership after failure for retry', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const closeResponse = deferred();
  const lifecycleKey = '66666666-6666-4666-8666-666666666666';
  const closes = [];
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    createLifecycleKey: () => lifecycleKey,
    async startSession() {
      return { sessionId: 'session-close-retry', status: 'active' };
    },
    closeLifecycle(lifecycle) {
      closes.push(lifecycle);
      if (closes.length === 1) return closeResponse.promise;
      return true;
    },
  });
  const selection = adapter.select(8);
  await coordinator.start(selection);

  const firstDispose = coordinator.dispose();
  const concurrentDispose = coordinator.dispose();
  assert.equal(closes.length, 1);
  closeResponse.resolve(false);
  assert.equal((await firstDispose).status, 'failed');
  assert.equal((await concurrentDispose).status, 'failed');

  assert.equal((await coordinator.dispose()).status, 'abandoned');
  assert.equal(closes.length, 2);
  assert.deepEqual(closes.map(({ lifecycleKey: key }) => key), [lifecycleKey, lifecycleKey]);
});

test('production SmartImport retains lifecycle ownership when close throws and retries it later', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const lifecycleKey = '77777777-7777-4777-8777-777777777777';
  const closes = [];
  const coordinator = profile.createSmartImportSessionCoordinator({
    selectionAdapter: adapter,
    createLifecycleKey: () => lifecycleKey,
    async startSession() {
      return { sessionId: 'session-close-throw', status: 'active' };
    },
    async closeLifecycle(lifecycle) {
      closes.push(lifecycle);
      if (closes.length === 1) throw new Error('close response lost');
      return true;
    },
  });
  const selection = adapter.select(8);
  await coordinator.start(selection);

  assert.equal((await coordinator.dispose()).status, 'failed');
  assert.equal((await coordinator.dispose()).status, 'abandoned');
  assert.deepEqual(closes.map(({ lifecycleKey: key }) => key), [lifecycleKey, lifecycleKey]);
});

test('production speaker write coordinator refreshes the current same-video generation after an older write succeeds', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const write = deferred();
  const refreshes = [];
  let backendSpeaker = 'old speaker';
  let renderedSpeaker = null;
  const coordinator = profile.createVideoReaderSpeakerCoordinator({
    selectionAdapter: adapter,
    getCurrentSelection: () => adapter.currentSelection(),
    async refresh(videoId, selection) {
      const value = backendSpeaker;
      refreshes.push({ videoId, generation: selection.generation, value });
      if (adapter.isCurrent(selection)) renderedSpeaker = value;
    },
  });

  const first = adapter.select(8);
  const pendingWrite = coordinator.writeThenRefresh(8, async () => {
    await write.promise;
    backendSpeaker = 'new speaker';
  });

  const second = adapter.select(8);
  assert.equal((await coordinator.refreshCurrent(8)).status, 'refreshed');
  assert.equal(renderedSpeaker, 'old speaker');
  write.resolve();

  assert.equal((await pendingWrite).status, 'refreshed');
  assert.equal(renderedSpeaker, 'new speaker');
  assert.deepEqual(refreshes, [
    { videoId: 8, generation: second.generation, value: 'old speaker' },
    { videoId: 8, generation: second.generation, value: 'new speaker' },
  ]);
  assert.equal(adapter.isCurrent(first), false);
});

test('production YouTube init failure handler discards a non-cancelled candidate exactly once', () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const selection = adapter.select(8);
  const candidate = {
    destroyed: 0,
    destroy() { this.destroyed += 1; },
  };

  assert.equal(adapter.trackDisposable(selection, candidate), true);
  assert.equal(profile.discardVideoReaderInitFailure({
    selectionAdapter: adapter,
    selection,
    disposable: candidate,
    error: new Error('iframe init failed'),
  }), true);
  assert.equal(candidate.destroyed, 1);

  adapter.select(9);
  assert.equal(candidate.destroyed, 1);
  assert.equal(adapter.discardDisposable(selection, candidate), false);
  assert.equal(candidate.destroyed, 1);
});

test('production transcript request tracker clears generation keys on reselection and settle', () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const store = new Set();
  const tracker = profile.createVideoReaderRequestTracker({
    selectionAdapter: adapter,
    store,
  });

  const first = adapter.select(8);
  const staleRequest = tracker.begin(first, 'transcript');
  assert.ok(staleRequest);
  assert.equal(store.size, 1);

  const second = adapter.select(8);
  assert.equal(store.size, 0);
  const currentRequest = tracker.begin(second, 'transcript');
  assert.ok(currentRequest);
  assert.equal(store.size, 1);
  assert.equal(tracker.begin(second, 'transcript'), null);

  assert.equal(tracker.settle(currentRequest), true);
  assert.equal(store.size, 0);
  assert.equal(tracker.settle(currentRequest), false);
});

test('production transcript request tracker runs only one GET while the same generation is pending', async () => {
  const adapter = profile.createVideoReaderSelectionAdapter();
  const tracker = profile.createVideoReaderRequestTracker({ selectionAdapter: adapter });
  const response = deferred();
  let gets = 0;
  const selection = adapter.select(8);
  const request = () => {
    gets += 1;
    return response.promise;
  };

  const first = tracker.run(selection, 'transcript', request);
  const duplicate = tracker.run(selection, 'transcript', request);
  assert.ok(first);
  assert.equal(duplicate, null);
  assert.equal(gets, 1);

  response.resolve({ segments: [] });
  assert.deepEqual(await first, { segments: [] });
  assert.equal(tracker.size(), 0);
});

test('production mobile focus controller aborts the old GET silently and lets the new generation finish', async () => {
  const requests = [];
  const feedback = [];
  const effects = [];
  let currentVideoId = 8;
  const controller = profile.createVideoFocusController({
    assessmentId: '17',
    targetVideoId: 8,
    getCurrentVideoId: () => currentVideoId,
    getSegments: () => [{ index: 0, start: 2, text: 'School bus' }],
    fetchFocus: async (assessmentId, signal) => {
      const response = deferred();
      requests.push({ assessmentId, signal, response });
      if (signal) {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          response.reject(error);
        }, { once: true });
      }
      return response.promise;
    },
    seek: (time) => effects.push(['seek', time]),
    highlight: (position) => effects.push(['highlight', position.segmentIndex]),
    feedback: (_message, kind) => feedback.push(kind),
  });

  const firstGeneration = controller.selectVideo(8, 41);
  await controller.markTranscriptReady({ videoId: 8, generation: firstGeneration });
  const staleAttempt = controller.markPlayerReady({ videoId: 8, generation: firstGeneration });
  assert.equal(requests.length, 1);

  const secondGeneration = controller.selectVideo(8, 42);
  assert.equal(requests[0].signal?.aborted, true);
  assert.equal((await staleAttempt).status, 'cancelled');
  assert.deepEqual(feedback, []);

  await controller.markTranscriptReady({ videoId: 8, generation: secondGeneration });
  const latestAttempt = controller.markPlayerReady({ videoId: 8, generation: secondGeneration });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].signal?.aborted, false);
  requests[1].response.resolve({ id: 17, video_resource_id: 8, text: 'School bus' });

  assert.equal((await latestAttempt).status, 'applied');
  assert.deepEqual(effects, [['seek', 1.8], ['highlight', 0]]);
  assert.deepEqual(feedback, ['success']);
  assert.equal(currentVideoId, 8);
});
