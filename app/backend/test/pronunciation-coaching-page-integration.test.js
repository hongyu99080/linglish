const test = require('node:test');
const assert = require('node:assert/strict');

const coachUI = require('../../frontend/js/practice/pronunciation-coach-ui');

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

  querySelector(selector) {
    if (selector === '[data-pronunciation-coach-host]') {
      return this.children.find((child) => child.getAttribute('data-pronunciation-coach-host') === 'true') || null;
    }
    return null;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

function coachingFixture() {
  return {
    version: 'coach-v1',
    evidence_level: 'transcript_alignment',
    headline: '先把 school 说清楚',
    summary: '下一遍只专注这个词。',
    strengths: ['bus 已经说清楚'],
    issues: [{
      type: 'missing_word',
      target: 'school',
      title: '把 school 说得更清楚',
      reason: '识别结果中没有稳定捕捉到 school。',
      drill: '先慢读 school，再连读 school bus。',
    }],
    next_action: { type: 'retry_focus', label: '重点重读 school', target_text: 'school bus' },
    disclaimer: '证据说明',
  };
}

test('mount inserts one coach card before legacy actions and emits anonymous metadata once', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const score = document.createElement('div');
  score.setAttribute('id', 'legacy-score');
  const actions = document.createElement('div');
  actions.setAttribute('id', 'legacy-actions');
  container.appendChild(score);
  container.appendChild(actions);
  const events = [];
  const dispatched = [];

  const first = coachUI.mount(container, coachingFixture(), {
    beforeNode: actions,
    impressionId: 7,
    emit: (name, properties) => events.push({ name, properties }),
    dispatch: (name, detail) => dispatched.push({ name, detail }),
  });

  assert.equal(first, true);
  assert.equal(container.children.length, 3);
  assert.equal(container.children[0], score);
  assert.equal(container.children[2], actions);
  const host = container.children[1];
  assert.equal(host.getAttribute('data-pronunciation-coach-host'), 'true');
  assert.match(host.innerHTML, /AI 教练诊断/);
  assert.deepEqual(events, [{
    name: 'pronunciation_coaching_shown',
    properties: {
      version: 'coach-v1',
      evidence_level: 'transcript_alignment',
      issue_types: ['missing_word'],
      issue_count: 1,
      next_action_type: 'retry_focus',
    },
  }]);
  assert.equal(dispatched[0].name, 'linglish:ai-feedback');
  assert.equal(Object.hasOwn(dispatched[0].detail, 'headline'), false);

  const second = coachUI.mount(container, coachingFixture(), {
    beforeNode: actions,
    impressionId: 7,
    emit: (name, properties) => events.push({ name, properties }),
    dispatch: (name, detail) => dispatched.push({ name, detail }),
  });

  assert.equal(second, true);
  assert.equal(container.children.length, 3);
  assert.equal(events.length, 1, 'same coaching impression must not be double-counted');
  assert.equal(dispatched.length, 1, 'same coaching impression must not be dispatched twice');

  coachUI.mount(container, coachingFixture(), {
    beforeNode: actions,
    impressionId: 8,
    emit: (name, properties) => events.push({ name, properties }),
    dispatch: (name, detail) => dispatched.push({ name, detail }),
  });
  assert.equal(events.length, 2, 'a new assessment with the same issue type must be counted');
  assert.equal(dispatched.length, 2);
});

test('mount returns false for malformed coaching and preserves all legacy children', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const slowTts = document.createElement('button');
  const minimalPairs = document.createElement('button');
  container.appendChild(slowTts);
  container.appendChild(minimalPairs);

  const mounted = coachUI.mount(container, { headline: 'bad', issues: 'not-an-array' }, {
    beforeNode: slowTts,
  });

  assert.equal(mounted, false);
  assert.deepEqual(container.children, [slowTts, minimalPairs]);
});

test('mount failure is fail-open and does not replace existing score content', () => {
  const container = {
    ownerDocument: { createElement: () => { throw new Error('dom unavailable'); } },
    children: [{ id: 'score' }],
    querySelector: () => null,
    insertBefore: () => { throw new Error('must not reach insert'); },
  };

  assert.equal(coachUI.mount(container, coachingFixture()), false);
  assert.deepEqual(container.children, [{ id: 'score' }]);
});

test('clear removes only the coach host and preserves every legacy control', () => {
  const document = new FakeDocument();
  const container = document.createElement('section');
  const original = document.createElement('button');
  const retry = document.createElement('button');
  container.appendChild(original);
  container.appendChild(retry);
  coachUI.mount(container, coachingFixture(), { beforeNode: retry });

  assert.equal(container.children.length, 3);
  assert.equal(coachUI.clear(container), true);
  assert.deepEqual(container.children, [original, retry]);
  assert.equal(coachUI.clear(container), false);
});
