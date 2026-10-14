const test = require('node:test');
const assert = require('node:assert/strict');
const { types: pgTypes } = require('pg');

const profileUI = require('../../frontend/js/practice/pronunciation-profile-ui');

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
    this.listeners = {};
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, beforeNode) {
    child.parentNode = this;
    const index = this.children.indexOf(beforeNode);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }

  querySelector(selector) {
    if (selector === '[data-pronunciation-profile-host]') {
      for (const child of this.children) {
        if (child.getAttribute('data-pronunciation-profile-host') === 'true') return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
    }
    return null;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

function readyProfile(overrides = {}) {
  return {
    status: 'ready',
    sample_count: 4,
    dimensions: [
      { key: 'clarity', label: '词级清晰', score: 84, confidence: 0.72, evidence: 'transcript_alignment' },
      { key: 'completeness', label: '完整表达', score: 76, confidence: 0.72, evidence: 'transcript_alignment' },
      { key: 'pace', label: '短语节奏', score: 100, confidence: 0.75, evidence: 'recording_signal' },
      { key: 'phoneme', label: '音素证据', score: null, confidence: 0, evidence: 'provider_phoneme' },
    ],
    focus_items: [{
      skill_type: 'missing_word',
      target_key: 'school',
      display_target: 'school',
      evidence_level: 'transcript_alignment',
      status: 'focus',
      video_resource_id: 8,
      assessment_id: 17,
      sample_text: 'The school bus is here',
    }],
    trend: { direction: 'up', delta: 12 },
    disclaimer: '画像会随练习更新。',
    ...overrides,
  };
}

const parsePgInt8 = pgTypes.getTypeParser(20);

test('collecting markup says exactly how many of three samples remain without percentage bars', () => {
  const html = profileUI.buildMarkup(readyProfile({
    status: 'collecting',
    sample_count: 1,
    dimensions: readyProfile().dimensions.map((dimension) => ({ ...dimension, score: null })),
  }));

  assert.match(html, /还差 2 次可信练习/);
  assert.doesNotMatch(html, /profile-lane-fill|%/);
});

test('ready markup makes missing phoneme evidence explicit', () => {
  const html = profileUI.buildMarkup(readyProfile());

  assert.match(html, /暂无音素级证据/);
  assert.match(html, /词级清晰/);
  assert.match(html, /84/);
});

test('markup escapes malicious labels and sample text', () => {
  const html = profileUI.buildMarkup(readyProfile({
    dimensions: [{ key: 'clarity', label: '<img src=x onerror=alert(1)>', score: 80, confidence: 1, evidence: 'transcript_alignment' }],
    focus_items: [{
      skill_type: 'missing_word',
      target_key: 'school',
      display_target: '<svg onload=alert(1)>',
      evidence_level: 'transcript_alignment',
      status: 'focus',
      video_resource_id: 8,
      assessment_id: 17,
      sample_text: '<script>alert(1)</script>',
    }],
  }));

  assert.doesNotMatch(html, /<img|<svg|<script/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test('focus href uses page-specific ID locators without transcript or target text', () => {
  const item = readyProfile().focus_items[0];
  const desktop = profileUI.buildFocusHref(item, { mobile: false, from: 'pronunciation_map' });
  const mobile = profileUI.buildFocusHref(item, { mobile: true, from: 'pronunciation_map' });

  assert.match(desktop, /^practice-session-desktop\.html\?/);
  assert.match(mobile, /^video-reader\.html\?/);
  for (const href of [desktop, mobile]) {
    assert.match(href, /videoId=8/);
    assert.match(href, /focusAssessment=17/);
    assert.match(href, /from=pronunciation_map/);
    assert.doesNotMatch(href, /from=pronunciation_profile/);
    assert.doesNotMatch(href, /school|sample_text|The%20school/i);
  }
});

test('real pg int8 strings survive profile normalization, mount, and href construction without Number coercion', () => {
  const videoId = parsePgInt8('9007199254740993');
  const assessmentId = parsePgInt8('9223372036854775807');
  const value = readyProfile({
    focus_items: [{
      ...readyProfile().focus_items[0],
      video_resource_id: videoId,
      assessment_id: assessmentId,
    }],
  });
  const normalized = profileUI.normalizeProfile(value);
  const document = new FakeDocument();
  const container = document.createElement('section');

  assert.equal(typeof videoId, 'string');
  assert.equal(normalized.focus_items[0].video_resource_id, '9007199254740993');
  assert.equal(normalized.focus_items[0].assessment_id, '9223372036854775807');
  assert.equal(profileUI.mount(container, value), true);
  assert.match(container.children[0].innerHTML, /videoId=9007199254740993&amp;focusAssessment=9223372036854775807/);
  assert.equal(profileUI.buildFocusHref({
    video_resource_id: '0009007199254740993',
    assessment_id: '0009223372036854775807',
  }), 'practice-session-desktop.html?videoId=9007199254740993&focusAssessment=9223372036854775807&from=pronunciation_map');
});

test('mobile pronunciation request payload carries the current pg-shaped video id', () => {
  const payload = profileUI.buildPronunciationAssessmentPayload({
    text: 'School bus',
    audioData: 'data:audio/webm;base64,AAAA',
    durationSeconds: 1.25,
    videoId: parsePgInt8('9007199254740993'),
  });

  assert.deepEqual(payload, {
    text: 'School bus',
    lemma: 'school bus',
    audio_data: 'data:audio/webm;base64,AAAA',
    duration_seconds: 1.25,
    video_id: '9007199254740993',
  });
});

test('a focus item without video context is filtered without invalidating the profile and gets a generic practice CTA', () => {
  for (const mobile of [false, true]) {
    const value = readyProfile({
      focus_items: [{
        ...readyProfile().focus_items[0],
        video_resource_id: null,
        assessment_id: parsePgInt8('9007199254740993'),
      }],
    });
    const normalized = profileUI.normalizeProfile(value);
    const html = profileUI.buildMarkup(value, { mobile });

    assert.equal(normalized.status, 'ready');
    assert.deepEqual(normalized.focus_items, []);
    assert.match(html, mobile
      ? /href="video-reader\.html\?from=pronunciation_map"/
      : /href="practice-session-desktop\.html\?from=pronunciation_map"/);
    assert.doesNotMatch(html, /videoId|focusAssessment|school|The school bus/);
  }
});

test('skill update adapter renders a bounded escaped summary and emits once per improved assessment', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const requests = [];
  const emit = profileUI.createPronunciationEventTransport({
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true };
    },
    getToken: () => 'private-token',
    endpoint: '/events',
    source: 'mobile_web',
  });
  const update = {
    improved: [{
      type: 'missing_word',
      evidence: 'transcript_alignment',
      status: 'improving',
      display_target: '<img src=x onerror=alert(1)>school',
      target_key: 'must-not-render',
      assessment_id: '9223372036854775807',
    }],
    needs_focus: [{
      type: 'pace',
      evidence: 'recording_signal',
      status: 'focus',
      display_target: '短语节奏',
    }],
    sample_count: 4,
  };

  assert.equal(profileUI.consumeSkillUpdate(container, update, { emit, eventKey: 'assessment-a' }), true);
  assert.equal(profileUI.consumeSkillUpdate(container, update, { emit, eventKey: 'assessment-a' }), true);
  assert.equal(profileUI.consumeSkillUpdate(container, update, { emit, eventKey: 'assessment-b' }), true);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].textContent, '本次已改善：<img src=x onerror=alert(1)>school · 继续关注：短语节奏');
  assert.equal(container.children[0].innerHTML, '');
  const expectedEvent = {
    event_name: 'pronunciation_skill_improved',
    properties: {
      improvement_count: 1,
      skill_types: ['missing_word'],
      evidence_levels: ['transcript_alignment'],
    },
    source: 'mobile_web',
  };
  assert.deepEqual(requests, [expectedEvent, expectedEvent]);
  assert.doesNotMatch(JSON.stringify(requests), /school|target|user|video|assessment|922337/);
});

test('skill update adapter clears only its direct stale host and keeps improved events once-only across an empty update', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const legacySibling = document.createElement('p');
  legacySibling.className = 'skill-update legacy-score-copy';
  legacySibling.textContent = 'Legacy score detail';
  container.appendChild(legacySibling);
  const events = [];
  const update = {
    improved: [{
      type: 'pace', evidence: 'recording_signal', status: 'improving', display_target: '短语节奏',
    }],
    needs_focus: [],
  };

  assert.equal(profileUI.consumeSkillUpdate(container, update, {
    eventKey: 'assessment-stale-host',
    emit: (...args) => events.push(args),
  }), true);
  assert.equal(container.children.length, 2);
  assert.equal(container.children[1].getAttribute('data-pronunciation-skill-update'), 'true');

  assert.equal(profileUI.consumeSkillUpdate(container, { improved: [], needs_focus: [] }, {
    eventKey: 'assessment-stale-host',
    emit: (...args) => events.push(args),
  }), false);
  assert.deepEqual(container.children, [legacySibling]);

  assert.equal(profileUI.consumeSkillUpdate(container, update, {
    eventKey: 'assessment-stale-host',
    emit: (...args) => events.push(args),
  }), true);
  assert.equal(events.length, 1);
  assert.equal(container.children[0], legacySibling);
  assert.equal(container.children[1].getAttribute('data-pronunciation-skill-update'), 'true');
});

test('skill update adapter uses continue-focus copy without an improved event', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const events = [];

  assert.equal(profileUI.consumeSkillUpdate(container, {
    improved: [],
    needs_focus: [{
      type: 'missing_word', evidence: 'transcript_alignment', status: 'focus', display_target: 'school',
    }],
  }, { emit: (...args) => events.push(args) }), true);
  assert.equal(container.children[0].textContent, '继续关注：school');
  assert.deepEqual(events, []);
});

test('mobile coach briefing uses the first valid focus and preserves fallback when none can deep-link', () => {
  assert.equal(profileUI.buildCoachSpeechFocus(readyProfile({
    focus_items: [
      { ...readyProfile().focus_items[0], display_target: 'ignored', video_resource_id: null },
      { ...readyProfile().focus_items[0], display_target: 'school' },
    ],
  }), '跟读 5 句，先追求完整清楚'), '今日重点：先把 “school” 说清楚');
  assert.equal(profileUI.buildCoachSpeechFocus(readyProfile({
    focus_items: [{ ...readyProfile().focus_items[0], video_resource_id: null }],
  }), '跟读 5 句，先追求完整清楚'), '跟读 5 句，先追求完整清楚');
});

test('event properties contain only allowlisted anonymous profile fields', () => {
  const properties = profileUI.buildEventProperties(readyProfile());

  assert.deepEqual(properties, {
    profile_status: 'ready',
    sample_bucket: '3_plus',
    trend_direction: 'up',
    focus_types: ['missing_word'],
    focus_count: 1,
  });
  assert.deepEqual(Object.keys(properties).sort(), [
    'focus_count', 'focus_types', 'profile_status', 'sample_bucket', 'trend_direction',
  ]);
});

test('ready extra-word focus normalizes, mounts, and keeps links and events anonymous', () => {
  const profile = readyProfile({
    focus_items: [{
      skill_type: 'extra_word',
      target_key: 'flow_control',
      display_target: '减少额外词或重复',
      evidence_level: 'transcript_alignment',
      status: 'focus',
      video_resource_id: 8,
      assessment_id: 17,
      sample_text: 'I, I mean, the bus is here',
    }],
  });
  const normalized = profileUI.normalizeProfile(profile);
  const html = profileUI.buildMarkup(profile);
  const href = profileUI.buildFocusHref(profile.focus_items[0], { from: 'pronunciation_map' });
  const document = new FakeDocument();
  const container = document.createElement('section');

  assert.equal(normalized.focus_items[0].skill_type, 'extra_word');
  assert.match(html, /减少多余词和重复/);
  assert.match(html, /词级测量/);
  assert.match(html, /优先练习/);
  assert.equal(profileUI.mount(container, profile), true);
  assert.equal(container.children[0].getAttribute('data-pronunciation-profile-host'), 'true');
  assert.match(href, /videoId=8/);
  assert.match(href, /focusAssessment=17/);
  assert.doesNotMatch(href, /flow_control|extra_word|减少|I%2C/i);
  assert.deepEqual(profileUI.buildEventProperties(profile), {
    profile_status: 'ready',
    sample_bucket: '3_plus',
    trend_direction: 'up',
    focus_types: ['extra_word'],
    focus_count: 1,
  });
});

test('mount replaces only its previous host, preserves legacy siblings, and emits once per fingerprint', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const legacyHeading = document.createElement('h2');
  const legacyActions = document.createElement('div');
  container.appendChild(legacyHeading);
  container.appendChild(legacyActions);
  const events = [];

  assert.equal(profileUI.mount(container, readyProfile(), {
    beforeNode: legacyActions,
    emit: (name, properties) => events.push({ name, properties }),
  }), true);
  assert.equal(container.children.length, 3);
  assert.equal(container.children[0], legacyHeading);
  assert.equal(container.children[2], legacyActions);
  assert.equal(container.children[1].getAttribute('data-pronunciation-profile-host'), 'true');
  const firstHost = container.children[1];

  assert.equal(profileUI.mount(container, readyProfile({
    focus_items: [{ ...readyProfile().focus_items[0], display_target: 'bus', target_key: 'bus', sample_text: 'A new sentence' }],
  }), {
    beforeNode: legacyActions,
    emit: (name, properties) => events.push({ name, properties }),
  }), true);
  assert.equal(container.children.length, 3);
  assert.equal(container.children[0], legacyHeading);
  assert.equal(container.children[2], legacyActions);
  assert.notEqual(container.children[1], firstHost);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    name: 'pronunciation_profile_view',
    properties: profileUI.buildEventProperties(readyProfile()),
  });
});

test('malformed profile fails open and preserves legacy siblings', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const legacy = document.createElement('button');
  container.appendChild(legacy);

  assert.equal(profileUI.mount(container, { status: 'ready', dimensions: 'bad' }), false);
  assert.deepEqual(container.children, [legacy]);
});

test('normalization rejects coerced scalars and inconsistent status sample counts before mounting', () => {
  const invalidProfiles = [
    readyProfile({ dimensions: [{ ...readyProfile().dimensions[0], score: false }] }),
    readyProfile({ dimensions: [{ ...readyProfile().dimensions[0], score: ' ' }] }),
    readyProfile({ focus_items: [{ ...readyProfile().focus_items[0], video_resource_id: true }] }),
    readyProfile({ focus_items: [{ ...readyProfile().focus_items[0], assessment_id: true }] }),
    readyProfile({ sample_count: ' ' }),
    readyProfile({ status: 'collecting', sample_count: 3 }),
    readyProfile({ status: 'ready', sample_count: 2 }),
  ];

  for (const profile of invalidProfiles) {
    const document = new FakeDocument();
    const container = document.createElement('section');
    const legacy = document.createElement('p');
    container.appendChild(legacy);

    assert.equal(profileUI.normalizeProfile(profile), null);
    assert.equal(profileUI.mount(container, profile), false);
    assert.deepEqual(container.children, [legacy]);
  }
});

test('mount and clear never claim a nested legacy marker as their own host', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const legacy = document.createElement('div');
  const nestedMarker = document.createElement('div');
  nestedMarker.setAttribute('data-pronunciation-profile-host', 'true');
  legacy.appendChild(nestedMarker);
  container.appendChild(legacy);

  assert.equal(profileUI.mount(container, readyProfile()), true);
  assert.deepEqual(legacy.children, [nestedMarker]);
  assert.equal(container.children.length, 2);
  assert.equal(profileUI.clear(container), true);
  assert.deepEqual(container.children, [legacy]);
  assert.deepEqual(legacy.children, [nestedMarker]);
  assert.equal(profileUI.clear(container), false);
});

test('mount remains available when optional analytics callbacks fail', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const legacy = document.createElement('p');
  container.appendChild(legacy);

  assert.equal(profileUI.mount(container, readyProfile(), {
    emit: () => { throw new Error('analytics unavailable'); },
  }), true);
  assert.equal(container.children.length, 2);
  assert.equal(container.children[0], legacy);
  assert.equal(container.children[1].getAttribute('data-pronunciation-profile-host'), 'true');
});

test('focus locator chooses maximum target overlap and rejects a weak coincidence', () => {
  assert.deepEqual(profileUI.locateFocusSegment([
    { index: 0, text: 'Good morning' },
    { index: 1, text: 'The school bus is here' },
  ], 'School bus is here'), { index: 1, score: 1 });
  assert.equal(profileUI.locateFocusSegment([{ index: 0, text: 'A bus' }], 'School is closed today'), null);
  assert.deepEqual(profileUI.locateFocusSegment([
    { index: 0, text: 'School bus stop' },
  ], 'School bus'), { index: 0, score: 1 });
  const nearTieTarget = Array.from({ length: 201 }, (_, index) => String.fromCodePoint(0x4e00 + index));
  assert.deepEqual(profileUI.locateFocusSegment([
    { index: 0, text: nearTieTarget.slice(0, 190).join(' ') },
    { index: 1, text: nearTieTarget.slice(0, 191).join(' ') },
  ], nearTieTarget.join(' ')), {
    index: 1,
    score: 0.95,
  });
});
