const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateUnlocks, ACHIEVEMENTS } = require('../services/achievements');

test('evaluateUnlocks: 空数据不解锁任何成就', () => {
  const r = evaluateUnlocks({ totalMinutes: 0, totalWords: 0, totalSessions: 0, streak: 0 }, []);
  assert.equal(r.length, 0);
});

test('evaluateUnlocks: 满足条件的成就被返回', () => {
  const r = evaluateUnlocks({ totalMinutes: 65, totalWords: 12, totalSessions: 3, streak: 3 }, []);
  const types = r.map(a => a.type);
  assert.ok(types.includes('first_session'));
  assert.ok(types.includes('words_10'));
  assert.ok(types.includes('streak_3'));
  assert.ok(types.includes('minutes_60'));
  assert.ok(!types.includes('words_50'));
});

test('evaluateUnlocks: 已解锁的不重复返回', () => {
  const r = evaluateUnlocks({ totalMinutes: 65, totalWords: 12, totalSessions: 3, streak: 3 }, ['words_10']);
  assert.ok(!r.map(a => a.type).includes('words_10'));
});

test('ACHIEVEMENTS: type 唯一', () => {
  const types = ACHIEVEMENTS.map(a => a.type);
  assert.equal(new Set(types).size, types.length);
});
