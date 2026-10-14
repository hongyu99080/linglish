const test = require('node:test');
const assert = require('node:assert/strict');

let VideoBrowserScopeSync = {};
try {
  VideoBrowserScopeSync = require('../../frontend/js/video-reader/video-browser-scope-sync');
} catch (_) {
  // RED 阶段：模块尚未实现时，让行为断言明确失败。
}

test('scope selection refreshes the modal from the newly shared scope', () => {
  assert.equal(typeof VideoBrowserScopeSync.applyScopeSelection, 'function');

  const sharedState = { scope: 'all' };
  const browserState = { scope: 'all' };
  let renderedScope = 'all';

  const result = VideoBrowserScopeSync.applyScopeSelection('mine', {
    browserState,
    setLibraryFilter(partial) {
      sharedState.scope = partial.scope;
    },
    renderVideoBrowser() {
      renderedScope = sharedState.scope;
    }
  });

  assert.equal(result, 'mine');
  assert.equal(sharedState.scope, 'mine');
  assert.equal(browserState.scope, 'mine');
  assert.equal(renderedScope, 'mine');
});

test('invalid scope normalizes to all before refresh', () => {
  assert.equal(typeof VideoBrowserScopeSync.applyScopeSelection, 'function');

  const sharedState = { scope: 'mine' };
  const browserState = { scope: 'mine' };
  let renderedScope = 'mine';

  const result = VideoBrowserScopeSync.applyScopeSelection('unexpected', {
    browserState,
    setLibraryFilter(partial) {
      sharedState.scope = partial.scope;
    },
    renderVideoBrowser() {
      renderedScope = sharedState.scope;
    }
  });

  assert.equal(result, 'all');
  assert.equal(sharedState.scope, 'all');
  assert.equal(browserState.scope, 'all');
  assert.equal(renderedScope, 'all');
});

test('clear selection resets shared filters and refreshes the modal', () => {
  assert.equal(typeof VideoBrowserScopeSync.clearScopeSelection, 'function');

  const sharedState = {
    difficulty: 'advanced',
    scene: 'work',
    tagId: '12',
    scope: 'mine'
  };
  const browserState = { scope: 'mine', status: 'complete' };
  let renderedScope = 'mine';

  VideoBrowserScopeSync.clearScopeSelection({
    browserState,
    setLibraryFilter(partial) {
      Object.assign(sharedState, partial);
    },
    renderVideoBrowser() {
      renderedScope = sharedState.scope;
    }
  });

  assert.deepEqual(sharedState, {
    difficulty: null,
    scene: null,
    tagId: null,
    scope: 'all'
  });
  assert.equal(browserState.scope, 'all');
  assert.equal(browserState.status, '');
  assert.equal(renderedScope, 'all');
});
