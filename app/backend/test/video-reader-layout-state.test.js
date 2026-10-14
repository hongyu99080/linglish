const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const stateModulePath = path.join(frontend, 'js/video-reader/reader-layout-state.js');
const pagePath = path.join(frontend, 'video-reader-desktop.html');

test('a selected video opens in the simple layout while the library and saved choices remain accessible', () => {
  const { shouldStartFocused } = require(stateModulePath);
  assert.equal(shouldStartFocused({ savedPreference: null, hasVideo: true }), true);
  assert.equal(shouldStartFocused({ savedPreference: null, hasVideo: false }), false);
  assert.equal(shouldStartFocused({ savedPreference: 'false', hasVideo: true }), false);
  assert.equal(shouldStartFocused({ savedPreference: 'true', hasVideo: true }), true);
  assert.equal(shouldStartFocused({ savedPreference: 'false', hasVideo: true, firstLesson: true }), true);
});

test('opening the video library exits focus mode and expands the sidebar', () => {
  assert.equal(fs.existsSync(stateModulePath), true, 'reader layout state module should exist');
  const { toggleVideoLibrary } = require(stateModulePath);

  assert.deepEqual(
    toggleVideoLibrary({ focusMode: true, sidebarCollapsed: true }),
    { focusMode: false, sidebarCollapsed: false }
  );
});

test('video library button still toggles the sidebar outside focus mode', () => {
  assert.equal(fs.existsSync(stateModulePath), true, 'reader layout state module should exist');
  const { toggleVideoLibrary } = require(stateModulePath);

  assert.deepEqual(
    toggleVideoLibrary({ focusMode: false, sidebarCollapsed: false }),
    { focusMode: false, sidebarCollapsed: true }
  );
  assert.deepEqual(
    toggleVideoLibrary({ focusMode: false, sidebarCollapsed: true }),
    { focusMode: false, sidebarCollapsed: false }
  );
});

test('desktop reader wires the hamburger button to the shared layout transition', () => {
  const html = fs.readFileSync(pagePath, 'utf8');

  assert.match(html, /js\/video-reader\/reader-layout-state\.js/);
  assert.match(html, /LinglishReaderLayoutState\.toggleVideoLibrary/);
  assert.match(html, /toggleSidebarBtn\.setAttribute\('aria-expanded'/);
});
