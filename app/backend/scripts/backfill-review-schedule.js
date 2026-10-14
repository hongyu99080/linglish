// app/backend/scripts/backfill-review-schedule.js
// 用法: node scripts/backfill-review-schedule.js [--dry-run]
'use strict';
require('dotenv').config();
const { pool, init } = require('../data-store/core');

const DRY_RUN = process.argv.includes('--dry-run');

// 与 spaced-repetition.js 的掌握判定保持一致:
//   newInterval > 180 && newEaseFactor >= 2.5 && newRepetitions >= 8 → STATE.MASTERED
// 已掌握的词必须用同一套阈值回填,否则:
//   1) state 非 'mastered' 时不会被 getDueQueue 排除,到期日一到全部涌入队列;
//   2) repetitions=0 时第一次"记得"会落到 newRepetitions===1 分支,间隔被压回 1 天。
const MASTERED_INTERVAL_DAYS = 181;   // 刚好越过 >180 的阈值
const MASTERED_REPETITIONS = 8;       // 阈值下限
const LEARNING_INTERVAL_DAYS = 1;
const NEW_INTERVAL_DAYS = 0;

async function main() {
  await init();

  const pending = await pool.query(
    `SELECT uv.id, uv.user_id, uv.word, uv.status, uv.ease_factor
       FROM user_vocabulary uv
      WHERE NOT EXISTS (
        SELECT 1 FROM review_schedule rs
         WHERE rs.user_id = uv.user_id
           AND rs.item_type = 'vocabulary' AND rs.item_id = uv.id)`
  );
  console.log(`待回填: ${pending.rows.length} 条${DRY_RUN ? ' (dry-run,不写入)' : ''}`);

  if (DRY_RUN) {
    const byStatus = {};
    for (const r of pending.rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    console.log('按状态分布:', byStatus);
    await pool.end();
    return;
  }

  let inserted = 0;
  for (const r of pending.rows) {
    // 状态映射:
    //   mastered → state='mastered' + 181天/8次重复(SM-2 掌握阈值),既不进队列,
    //              再次复习时也走 round(interval * ease) 分支而非被压回 1 天;
    //   learning/reviewing → 1天/learning;其余(新词) → 0天立即到期
    const isMastered = r.status === 'mastered';
    const isLearning = r.status === 'learning' || r.status === 'reviewing';
    const interval = isMastered
      ? MASTERED_INTERVAL_DAYS
      : (isLearning ? LEARNING_INTERVAL_DAYS : NEW_INTERVAL_DAYS);
    const repetitions = isMastered ? MASTERED_REPETITIONS : 0;
    const state = isMastered ? 'mastered' : (isLearning ? 'learning' : 'new');
    const ease = Math.min(9.99, Math.max(1.3, parseFloat(r.ease_factor) || 2.5));
    const res = await pool.query(
      `INSERT INTO review_schedule
         (user_id, item_type, item_id, lemma, ease_factor, interval_days,
          repetitions, state, next_review_at, due_date)
       VALUES ($1, 'vocabulary', $2, $3, $4, $5, $6, $7,
               NOW() + ($8 || ' days')::interval,
               (NOW() + ($8 || ' days')::interval)::date)
       ON CONFLICT (user_id, item_type, item_id) DO NOTHING`,
      [r.user_id, r.id, r.word, ease, interval, repetitions, state, String(interval)]
    );
    inserted += res.rowCount;
  }
  console.log(`已插入: ${inserted} 条`);
  await pool.end();
}

main().catch(err => { console.error('回填失败:', err); process.exit(1); });
