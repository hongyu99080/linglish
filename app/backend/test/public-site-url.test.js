const test = require('node:test');
const assert = require('node:assert/strict');
const { getPublicSiteUrl } = require('../utils/public-site-url');

function withSiteUrl(value, check) {
  const previous = process.env.SITE_URL;
  if (value === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = value;
  try {
    check();
  } finally {
    if (previous === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previous;
  }
}

test('unconfigured public URLs point to the local app', () => {
  withSiteUrl(undefined, () => assert.equal(getPublicSiteUrl(), 'http://localhost:4000'));
});

test('configured public URL retains the operator origin', () => {
  withSiteUrl(' https://learn.example.test/ ', () => {
    assert.equal(getPublicSiteUrl(), 'https://learn.example.test');
  });
});

test('public URL rejects credential-bearing, malformed and non-web addresses', () => {
  for (const value of [
    'not-a-url', 'javascript:alert(1)', 'ftp://example.test',
    'https://user:password@example.test', 'https://example.test/?secret=test',
    'https://example.test/#fragment', 'https://example.test/english',
    'https://example.test/english$&/', "https://example.test/english'/", "https://quote'.example.test",
    "https://example$&.test",
  ]) {
    withSiteUrl(value, () => assert.throws(getPublicSiteUrl, /SITE_URL/));
  }
});
