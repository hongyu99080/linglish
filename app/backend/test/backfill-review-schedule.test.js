const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateNextReview, STATE } = require('../services/spaced-repetition');
const { QUALITY_TO_RATING } = require('../services/srs-bridge');

const scriptPath = path.resolve(__dirname, '../scripts/backfill-review-schedule.js');
const src = fs.readFileSync(scriptPath, 'utf8');

// 从脚本里读回实际使用的种子值,避免测试与实现各写一份常量
function readConst(name) {
  const m = src.match(new RegExp(`const ${name} = (\\d+)`));
  assert.ok(m, `脚本应定义 ${name}`);
  return Number(m[1]);
}

test('I-1: 已掌握的词回填为 mastered 态,不会涌入到期队列', () => {
  assert.match(src, /const state = isMastered \? 'mastered'/);
  // getDueQueue / getDueCount 用 state != 'mastered' 排除
  const bridge = fs.readFileSync(path.resolve(__dirname, '../services/srs-bridge.js'), 'utf8');
  assert.match(bridge, /state != 'mastered'/);
});

test('I-1: 已掌握的词回填种子让下次成功复习拉长而非压回 1 天', () => {
  const interval = readConst('MASTERED_INTERVAL_DAYS');
  const repetitions = readConst('MASTERED_REPETITIONS');

  const good = calculateNextReview(interval, 2.5, repetitions, QUALITY_TO_RATING.good);
  assert.ok(good.interval > interval, `复习后间隔必须增长,实际 ${good.interval} <= ${interval}`);
  assert.notEqual(good.interval, 1, '不得回落到 1 天');
  assert.ok(
    good.state === STATE.REVIEWING || good.state === STATE.MASTERED,
    `不得跌回学习态,实际 ${good.state}`
  );

  // "很简单"保持 EF 不降,掌握态得以保留
  const easy = calculateNextReview(interval, 2.5, repetitions, QUALITY_TO_RATING.easy);
  assert.equal(easy.state, STATE.MASTERED);
});

test('I-1: 种子值满足 spaced-repetition.js 的掌握阈值', () => {
  assert.ok(readConst('MASTERED_INTERVAL_DAYS') > 180);
  assert.ok(readConst('MASTERED_REPETITIONS') >= 8);
});

test('I-1: 保持幂等,且数值/字符串占位符不复用', () => {
  assert.match(src, /ON CONFLICT \(user_id, item_type, item_id\) DO NOTHING/);
  // interval_days 用数值 $5,天数区间用字符串 $8,不得再次共用同一个占位符
  assert.match(src, /VALUES \(\$1, 'vocabulary', \$2, \$3, \$4, \$5, \$6, \$7,/);
  assert.match(src, /\(\$8 \|\| ' days'\)::interval/);
  assert.match(src, /\[r\.user_id, r\.id, r\.word, ease, interval, repetitions, state, String\(interval\)\]/);
});
