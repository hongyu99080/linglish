const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('desktop auth waits for OAuth session exchange before returning to the requested learning page', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/desktop-auth.html'), 'utf8');
  const destinations = [];
  let finishExchange;
  let token = null;
  const ready = new Promise(resolve => { finishExchange = () => { token = 'test-account'; resolve({ access_token: token }); }; });
  const context = {
    window: { LinglishOAuthBootstrap: { ready }, AuthManager: { getToken: () => token } },
    location: { search: '?next=%2Ftoday.html', replace: destination => destinations.push(destination) },
    URLSearchParams, isGuestCachedSession: () => false,
    getDefaultAuthNext: () => '/today.html', getSafeNext: () => '/today.html',
  };
  context.AuthManager = context.window.AuthManager;
  const start = source.lastIndexOf('    (async function () {');
  const end = source.indexOf('  </script>', start);
  const finished = vm.runInNewContext(source.slice(start, end), context);
  assert.deepEqual(destinations, []);
  finishExchange();
  await finished;
  assert.deepEqual(destinations, ['/today.html']);
});
