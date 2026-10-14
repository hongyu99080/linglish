'use strict';

const { pool } = require('../data-store/core');

// 成就目录:check 接收 totals = { totalMinutes, totalWords, totalSessions, streak }
const ACHIEVEMENTS = [
  { type: 'first_session', name: '初次见面', description: '完成第一次学习', icon: '🌱', rarity: 'common', xpReward: 10, check: t => t.totalSessions >= 1 || t.totalMinutes >= 1 },
  { type: 'words_10', name: '词汇新手', description: '累计学习 10 个单词', icon: '📖', rarity: 'common', xpReward: 20, check: t => t.totalWords >= 10 },
  { type: 'words_50', name: '词汇行家', description: '累计学习 50 个单词', icon: '📚', rarity: 'rare', xpReward: 50, check: t => t.totalWords >= 50 },
  { type: 'words_200', name: '词汇大师', description: '累计学习 200 个单词', icon: '🎓', rarity: 'epic', xpReward: 200, check: t => t.totalWords >= 200 },
  { type: 'streak_3', name: '小试牛刀', description: '连续学习 3 天', icon: '🔥', rarity: 'common', xpReward: 30, check: t => t.streak >= 3 },
  { type: 'streak_7', name: '一周坚持', description: '连续学习 7 天', icon: '⚡', rarity: 'rare', xpReward: 70, check: t => t.streak >= 7 },
  { type: 'streak_30', name: '习惯养成', description: '连续学习 30 天', icon: '👑', rarity: 'legendary', xpReward: 300, check: t => t.streak >= 30 },
  { type: 'minutes_60', name: '一小时里程', description: '累计学习 60 分钟', icon: '⏱️', rarity: 'common', xpReward: 20, check: t => t.totalMinutes >= 60 },
  { type: 'minutes_600', name: '十小时深耕', description: '累计学习 600 分钟', icon: '🏆', rarity: 'epic', xpReward: 150, check: t => t.totalMinutes >= 600 },
];

function evaluateUnlocks(totals, unlockedTypes) {
  const unlockedSet = new Set(unlockedTypes || []);
  return ACHIEVEMENTS.filter(a => !unlockedSet.has(a.type) && a.check(totals));
}

async function listUnlocked(userId) {
  const r = await pool.query(
    `SELECT achievement_type, achievement_name, achievement_description, rarity, xp_reward, unlocked_at
       FROM achievement_unlocks
      WHERE user_id = $1
      ORDER BY unlocked_at DESC`,
    [userId]
  );
  return r.rows;
}

async function checkAndUnlock(userId, totals) {
  const existing = await pool.query(
    'SELECT achievement_type FROM achievement_unlocks WHERE user_id = $1',
    [userId]
  );
  const fresh = evaluateUnlocks(totals, existing.rows.map(r => r.achievement_type));
  const unlocked = [];
  for (const a of fresh) {
    // achievement_unlocks 无唯一约束,用 WHERE NOT EXISTS 防并发重复
    const ins = await pool.query(
      `INSERT INTO achievement_unlocks
         (user_id, achievement_type, achievement_name, achievement_description, rarity, xp_reward)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (
          SELECT 1 FROM achievement_unlocks WHERE user_id = $1 AND achievement_type = $2)
       RETURNING achievement_type`,
      [userId, a.type, a.name, a.description, a.rarity, a.xpReward]
    );
    if (ins.rowCount > 0) {
      unlocked.push({ type: a.type, name: a.name, description: a.description, icon: a.icon, rarity: a.rarity, xp_reward: a.xpReward });
    }
  }
  return unlocked;
}

module.exports = { ACHIEVEMENTS, evaluateUnlocks, listUnlocked, checkAndUnlock };
