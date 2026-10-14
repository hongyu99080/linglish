const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');

const {
  createVisitorContext,
} = require('../../frontend/js/visitor-context');

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test('visitor context reuses one valid id and decorates both payload levels', () => {
  const storage = memoryStorage();
  const visitor = createVisitorContext({ storage, createRandomPart: () => 'abcdefghijklmnopqrstuvwx' });
  assert.equal(visitor.getId(), 'llv_abcdefghijklmnopqrstuvwx');
  assert.equal(visitor.getId(), 'llv_abcdefghijklmnopqrstuvwx');
  assert.deepEqual(visitor.decorateEvent({ event_name: 'click', properties: { page: 'today' } }), {
    event_name: 'click',
    visitor_id: 'llv_abcdefghijklmnopqrstuvwx',
    properties: { page: 'today', visitor_id: 'llv_abcdefghijklmnopqrstuvwx' },
  });
});

test('visitor context safely returns null when storage is unavailable', () => {
  const visitor = createVisitorContext({ storage: { getItem() { throw new Error('blocked'); } } });
  assert.equal(visitor.getId(), null);
  assert.deepEqual(visitor.decorateEvent({ event_name: 'click', properties: {} }), {
    event_name: 'click', properties: {},
  });
});

test('browser bootstrap safely degrades when the localStorage property getter throws', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/js/visitor-context.js'),
    'utf8',
  );
  const browserWindow = {};
  Object.defineProperty(browserWindow, 'localStorage', {
    get() {
      const error = new Error('blocked');
      error.name = 'SecurityError';
      throw error;
    },
  });

  assert.doesNotThrow(() => vm.runInNewContext(source, { window: browserWindow }));
  assert.equal(browserWindow.LinglishVisitor.getId(), null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(browserWindow.LinglishVisitor.decorateEvent({ event_name: 'click' }))),
    { event_name: 'click', properties: {} },
  );
});

test('visitor context reuses a persisted 12-character visitor suffix', () => {
  const storage = memoryStorage();
  storage.setItem('linglish_visitor_id', 'llv_abcdefghijkl');
  const visitor = createVisitorContext({ storage, createRandomPart: () => 'abcdefghijklmnopqrstuvwx' });

  assert.equal(visitor.getId(), 'llv_abcdefghijkl');
});

test('fallback creates a visitor id when crypto is unavailable and Math.random returns zero', () => {
  const visitorContextPath = path.resolve(__dirname, '../../frontend/js/visitor-context.js');
  const result = spawnSync(process.execPath, ['-e', `
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    Math.random = () => 0;
    const { createVisitorContext } = require(process.argv[1]);
    const visitor = createVisitorContext({
      storage: { getItem: () => null, setItem: () => {} },
    });
    if (!/^llv_[A-Za-z0-9_-]{24}$/.test(visitor.getId())) process.exit(1);
  `, visitorContextPath], { timeout: 1000 });

  assert.equal(result.status, 0, result.error?.message || result.stderr.toString());
});
