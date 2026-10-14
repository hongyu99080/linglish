const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveQuality, isExplicitMastery,
  QUALITY_TO_RATING, STATE_TO_STATUS,
} = require('../services/srs-bridge');
const { RATING, STATE, calculateNextReview } = require('../services/spaced-repetition');

test('QUALITY_TO_RATING: 四档映射对齐 SM-2 的 RATING 常量', () => {
  assert.equal(QUALITY_TO_RATING.again, RATING.AGAIN);
  assert.equal(QUALITY_TO_RATING.hard, RATING.HARD);
  assert.equal(QUALITY_TO_RATING.good, RATING.GOOD);
  assert.equal(QUALITY_TO_RATING.easy, RATING.EASY);
  assert.deepEqual(QUALITY_TO_RATING, { again: 1, hard: 2, good: 3, easy: 4 });
});

test('QUALITY_TO_RATING: "太难了"进入减半分支而不是拉长间隔', () => {
  const before = { interval: 6, ease: 2.5, reps: 2 };
  const hard = calculateNextReview(before.interval, before.ease, before.reps, QUALITY_TO_RATING.hard);
  assert.ok(hard.interval < before.interval, '评为 hard 后间隔必须缩短');
  assert.ok(hard.easeFactor < before.ease, '评为 hard 后 EF 必须下降');

  const good = calculateNextReview(before.interval, before.ease, before.reps, QUALITY_TO_RATING.good);
  assert.ok(good.interval > before.interval, '评为 good 后间隔才增长');
});

test('QUALITY_TO_RATING: 正确/失误切分仍与 rating>=3 一致', () => {
  // srs-bridge 内 isCorrect = rating >= 3、isLapse = rating <= 2
  assert.ok(QUALITY_TO_RATING.good >= 3 && QUALITY_TO_RATING.easy >= 3);
  assert.ok(QUALITY_TO_RATING.again <= 2 && QUALITY_TO_RATING.hard <= 2);
});

test('resolveQuality: quality 优先', () => {
  assert.equal(resolveQuality({ quality: 'hard', outcome: 'fail' }), 'hard');
});

test('resolveQuality: legacy outcome 回退映射', () => {
  assert.equal(resolveQuality({ outcome: 'fail' }), 'again');
  assert.equal(resolveQuality({ outcome: 'pass' }), 'good');
  assert.equal(resolveQuality({ outcome: 'mastered' }), 'easy');
  assert.equal(resolveQuality({ outcome: 'easy' }), 'easy');
});

test('resolveQuality: 未知值返回 null', () => {
  assert.equal(resolveQuality({ quality: 'meh' }), null);
  assert.equal(resolveQuality({}), null);
});

test('STATE_TO_STATUS: SM-2 状态投影到 user_vocabulary.status', () => {
  assert.equal(STATE_TO_STATUS.new, 'learning');
  assert.equal(STATE_TO_STATUS.relearning, 'learning');
  assert.equal(STATE_TO_STATUS.reviewing, 'reviewing');
  assert.equal(STATE_TO_STATUS.mastered, 'mastered');
});

test('isExplicitMastery: 只认 outcome,不由 quality 反推', () => {
  assert.equal(isExplicitMastery({ outcome: 'mastered' }), true);
  assert.equal(isExplicitMastery({ outcome: 'master' }), true);
  // 四档 UI 直接发的 quality:'easy' 不是显式掌握声明
  assert.equal(isExplicitMastery({ quality: 'easy' }), false);
  assert.equal(isExplicitMastery({ quality: 'easy', outcome: 'pass' }), false);
  assert.equal(isExplicitMastery({ outcome: 'easy' }), false);
  assert.equal(isExplicitMastery({}), false);
  assert.equal(isExplicitMastery(), false);
});

test('显式"完全掌握"必须覆盖 SM-2 阈值,而算法路径不得提前掌握', () => {
  // 新词点"完全掌握":SM-2 自身只会给出 learning
  const algorithmic = calculateNextReview(1, 2.5, 0, QUALITY_TO_RATING.easy);
  assert.notEqual(algorithmic.state, STATE.MASTERED);
  assert.equal(STATE_TO_STATUS[algorithmic.state], 'learning');

  // 显式 outcome 走覆盖分支 → mastered,并正确投影到 user_vocabulary
  const forced = isExplicitMastery({ outcome: 'mastered' }) ? 'mastered' : algorithmic.state;
  assert.equal(forced, STATE.MASTERED);
  assert.equal(STATE_TO_STATUS[forced], 'mastered');
});

test('srs-bridge: 显式掌握只覆盖 state,间隔/EF/重复次数仍由 SM-2 计算', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/srs-bridge.js'), 'utf8');
  assert.match(src, /const nextState = explicitMastery \? 'mastered' : next\.state;/);
  assert.match(src, /ease_factor = \$3, interval_days = \$4, repetitions = \$5, state = \$6/);
  assert.match(src, /next\.easeFactor, next\.interval, next\.repetitions, nextState/);
  assert.match(src, /STATE_TO_STATUS\[nextState\]/);
});

test('vocab/review 路由把显式掌握标记透传给 srs-bridge', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/vocabulary.js'), 'utf8');
  assert.match(src, /explicitMastery: srsBridge\.isExplicitMastery\(body\)/);
});
