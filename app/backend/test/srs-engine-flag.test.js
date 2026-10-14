const test = require('node:test');
const assert = require('node:assert/strict');
const { isSm2Enabled } = require('../routes/vocabulary');

test('isSm2Enabled: 默认(未设置)为 true', () => {
  delete process.env.SRS_ENGINE;
  assert.equal(isSm2Enabled(), true);
});

test('isSm2Enabled: sm2 为 true', () => {
  process.env.SRS_ENGINE = 'sm2';
  assert.equal(isSm2Enabled(), true);
});

test('isSm2Enabled: legacy 为 false', () => {
  process.env.SRS_ENGINE = 'legacy';
  assert.equal(isSm2Enabled(), false);
  delete process.env.SRS_ENGINE;
});
