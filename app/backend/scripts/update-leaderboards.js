#!/usr/bin/env node

/**
 * Update Leaderboards Cron Job
 * 更新排行榜定时任务
 *
 * 使用方法:
 * node scripts/update-leaderboards.js
 *
 * Crontab配置:
 * 0 * * * * cd /path/to/linglish/app/backend && node scripts/update-leaderboards.js >> logs/cron.log 2>&1
 */

require('dotenv').config();
const path = require('path');

// 修改工作目录到backend
process.chdir(path.join(__dirname, '..'));

const dataStore = require('../data-store');
const leaderboard = require('../services/leaderboard');

async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting leaderboard update...`);

  try {
    // 初始化数据库连接
    await dataStore.init();
    console.log('Database connected');

    // 更新所有排行榜
    const success = await leaderboard.updateGlobalLeaderboards();

    if (success) {
      const duration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] Leaderboards updated successfully (${duration}ms)`);
      process.exit(0);
    } else {
      console.error(`[${new Date().toISOString()}] Failed to update leaderboards`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error updating leaderboards:`, error);
    process.exit(1);
  }
}

// 执行
main();
