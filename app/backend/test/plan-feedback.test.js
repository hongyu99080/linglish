// app/backend/test/plan-feedback.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFeedback, computeAdjustments } = require('../services/plan-feedback');

test('validateFeedback: 合法 itemAction', () => {
  const r = validateFeedback({ itemType: 'watch', action: 'too_hard' });
  assert.deepEqual(r, { itemType: 'watch', action: 'too_hard', rating: null, clientId: null });
});

test('validateFeedback: rating 需 1-5', () => {
  assert.equal(validateFeedback({ itemType: 'overall', action: 'rating', rating: 6 }), null);
  assert.equal(validateFeedback({ itemType: 'overall', action: 'rating' }), null);
  const ok = validateFeedback({ itemType: 'overall', action: 'rating', rating: 4 });
  assert.deepEqual(ok, { itemType: 'overall', action: 'rating', rating: 4, clientId: null });
});

test('validateFeedback: 非法值拒绝', () => {
  assert.equal(validateFeedback({ itemType: 'hack', action: 'completed' }), null);
  assert.equal(validateFeedback({ itemType: 'watch', action: 'meh' }), null);
  assert.equal(validateFeedback(null), null);
});

test('computeAdjustments: too_hard≥2 → 难度下调', () => {
  const a = computeAdjustments([
    { item_type: 'watch', action: 'too_hard' },
    { item_type: 'watch', action: 'too_hard' },
  ]);
  assert.equal(a.difficultyShift, -1);
  assert.equal(a.hasFeedback, true);
});

test('computeAdjustments: too_easy≥2 → 难度上调', () => {
  const a = computeAdjustments([
    { item_type: 'shadowing', action: 'too_easy' },
    { item_type: 'watch', action: 'too_easy' },
  ]);
  assert.equal(a.difficultyShift, 1);
});

test('computeAdjustments: 两者都≥2 → 抵消为 0(封顶保护)', () => {
  const a = computeAdjustments([
    { item_type: 'watch', action: 'too_hard' }, { item_type: 'watch', action: 'too_hard' },
    { item_type: 'watch', action: 'too_easy' }, { item_type: 'watch', action: 'too_easy' },
  ]);
  assert.equal(a.difficultyShift, 0);
});

test('computeAdjustments: boring/skipped≥3 → 该类型降权(封顶0.5)', () => {
  const a = computeAdjustments([
    { item_type: 'watch', action: 'boring' },
    { item_type: 'watch', action: 'skipped' },
    { item_type: 'watch', action: 'boring' },
  ]);
  assert.equal(a.typePenalty.watch, 0.5);
  assert.equal(a.typePenalty.shadowing, 1);
});

test('computeAdjustments: 平均 rating<3 → 多样性', () => {
  const a = computeAdjustments([
    { item_type: 'overall', action: 'rating', rating: 2 },
    { item_type: 'overall', action: 'rating', rating: 3 },
  ]);
  assert.equal(a.wantDiversity, true);
});

test('computeAdjustments: 空反馈无调整', () => {
  const a = computeAdjustments([]);
  assert.deepEqual(a, {
    difficultyShift: 0,
    typePenalty: { watch: 1, shadowing: 1, review: 1 },
    wantDiversity: false,
    hasFeedback: false,
  });
});
