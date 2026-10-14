const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');

function extractCssBlock(css, selector) {
  const selectorIndex = css.indexOf(selector);
  assert.notEqual(selectorIndex, -1, `missing CSS selector: ${selector}`);
  const openIndex = css.indexOf('{', selectorIndex);
  assert.notEqual(openIndex, -1, `missing opening brace for: ${selector}`);

  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(openIndex + 1, index);
  }
  assert.fail(`missing closing brace for: ${selector}`);
}

test('desktop video reader keeps transcript and sticky core controls in focus mode', () => {
  const html = fs.readFileSync(path.join(frontend, 'video-reader-desktop.html'), 'utf8');
  const css = fs.readFileSync(path.join(frontend, 'styles/video-reader-pro.css'), 'utf8');
  const controls = fs.readFileSync(path.join(frontend, 'js/video-reader/pro-controls.js'), 'utf8');

  assert.match(html, /js\/video-reader\/sentence-segments\.js/);
  assert.match(html, /body\.focus-mode \.transcript\s*\{[^}]*opacity:\s*1/s);
  assert.match(html, /body\.focus-mode \.shell\s*\{[^}]*minmax\(360px/s);
  assert.match(html, /body\.focus-mode #video-meta\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.vrp-control-dock\s*\{[^}]*position:\s*sticky/s);
  assert.match(controls, /className = 'vrp-control-dock'/);
});

test('desktop player preserves 16:9 when viewport height limits its size', () => {
  const html = fs.readFileSync(path.join(frontend, 'video-reader-desktop.html'), 'utf8');
  const workspaceCss = html.match(
    /\/\* ={10,}\s*Desktop learning workspace[\s\S]*?<\/style>/
  );

  assert.ok(workspaceCss, 'desktop learning workspace CSS should exist');
  const desktopMedia = extractCssBlock(workspaceCss[0], '@media (min-width: 1180px)');
  assert.match(html, /\.player\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
  assert.match(
    html,
    /id="player"[^>]*style="[^"]*width:100%;\s*height:100%[^"]*"/
  );
  assert.match(
    html,
    /id="youtube-player"[^>]*style="[^"]*width:100%;\s*height:100%[^"]*"/
  );
  assert.match(
    desktopMedia,
    /\.player\s*\{[^}]*width:\s*min\(100%,\s*calc\(min\(60vh,\s*620px\)\s*\*\s*16\s*\/\s*9\)\)[^}]*width:\s*min\(100%,\s*calc\(min\(60dvh,\s*620px\)\s*\*\s*16\s*\/\s*9\)\)[^}]*max-height:\s*none[^}]*margin-inline:\s*auto/s
  );
  assert.match(
    desktopMedia,
    /body\.focus-mode \.player\s*\{[^}]*width:\s*min\(100%,\s*calc\(min\(62vh,\s*700px\)\s*\*\s*16\s*\/\s*9\)\)[^}]*width:\s*min\(100%,\s*calc\(min\(62dvh,\s*700px\)\s*\*\s*16\s*\/\s*9\)\)[^}]*max-height:\s*none/s
  );
  assert.doesNotMatch(workspaceCss[0], /\.player\s*\{[^}]*max-height:\s*min\(38dvh/s);

  const expectedPlayer = ({ viewportHeight, availableWidth, heightRatio, heightCap }) => {
    const heightLimitedWidth = Math.min(viewportHeight * heightRatio, heightCap) * 16 / 9;
    const width = Math.min(availableWidth, heightLimitedWidth);
    return { width, height: width * 9 / 16 };
  };

  for (const scenario of [
    { viewportHeight: 787, availableWidth: 1432, heightRatio: 0.60, heightCap: 620 },
    { viewportHeight: 900, availableWidth: 680, heightRatio: 0.60, heightCap: 620 },
    { viewportHeight: 1080, availableWidth: 1152, heightRatio: 0.60, heightCap: 620 },
    { viewportHeight: 900, availableWidth: 1000, heightRatio: 0.62, heightCap: 700 }
  ]) {
    const size = expectedPlayer(scenario);
    assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.02);
    assert.ok(size.width <= scenario.availableWidth);
  }
});

test('desktop practice keeps a compact top mode bar and shared replay controller', () => {
  const html = fs.readFileSync(path.join(frontend, 'practice-session-desktop.html'), 'utf8');
  const css = fs.readFileSync(path.join(frontend, 'styles/practice-session-desktop.css'), 'utf8');

  assert.match(html, /js\/practice\/original-audio-replay\.js/);
  assert.match(html, /class="mode-top-bar"[^>]*data-workspace-position="top"/);
  assert.match(css, /body\.dialogue-focus-layout \.mode-top-bar\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /body\.dialogue-focus-layout #desktop-controls-container\s*\{[^}]*display:\s*block/s);
  assert.doesNotMatch(css, /body\.dialogue-focus-layout #desktop-controls-container\s*\{\s*display:\s*none\s*!important/s);
});

test('desktop video reader exposes one canonical playback progress rail', () => {
  const html = fs.readFileSync(path.join(frontend, 'video-reader-desktop.html'), 'utf8');
  const controls = fs.readFileSync(path.join(frontend, 'js/video-reader/pro-controls.js'), 'utf8');

  assert.match(controls, /scrub\.className = 'vrp-scrub'/);
  assert.doesNotMatch(html, /class="video-progress-row"/);
  assert.doesNotMatch(html, /id="video-progress-fill"/);
  assert.doesNotMatch(html, /id="video-progress-time"/);
  assert.match(html, /id="video-progress-label"/);
  assert.match(html, /id="extract-words-cta"/);
  assert.match(
    html,
    /function updateVideoProgress\(currentTime, duration\)[\s\S]*videoProgressLabelEl\.textContent = `已完成 \$\{percent\}%`[\s\S]*recordVideoProgress/
  );
});
