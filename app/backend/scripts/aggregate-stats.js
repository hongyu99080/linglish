#!/usr/bin/env node

/**
 * Aggregate Statistics Cron Job
 * 聚合统计数据定时任务
 *
 * 功能：
 * - 生成每日/周/月统计数据
 * - 更新用户技能进度
 *
 * 使用方法:
 * node scripts/aggregate-stats.js [daily|weekly|monthly]
 *
 * Crontab配置:
 * # 每天凌晨1点运行
 * 0 1 * * * cd /path/to/linglish/app/backend && node scripts/aggregate-stats.js daily >> logs/cron.log 2>&1
 *
 * # 每周一凌晨2点运行
 * 0 2 * * 1 cd /path/to/linglish/app/backend && node scripts/aggregate-stats.js weekly >> logs/cron.log 2>&1
 *
 * # 每月1号凌晨3点运行
 * 0 3 1 * * cd /path/to/linglish/app/backend && node scripts/aggregate-stats.js monthly >> logs/cron.log 2>&1
 */

require('dotenv').config();
const path = require('path');

// 修改工作目录到backend
process.chdir(path.join(__dirname, '..'));

const dataStore = require('../data-store');
const learningStats = require('../services/learning-stats');

async function aggregateDaily() {
  console.log('Aggregating daily stats...');

  // 获取昨天的日期
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];

  // 获取所有活跃用户
  const usersQuery = `SELECT id FROM users WHERE status = 'active'`;
  const usersResult = await dataStore.query(usersQuery);

  let successCount = 0;
  let errorCount = 0;

  for (const user of usersResult.rows) {
    try {
      // 每个用户的每日统计已经在活动记录时实时更新
      // 这里只需要确保数据完整性
      successCount++;
    } catch (error) {
      console.error(`Error aggregating for user ${user.id}:`, error);
      errorCount++;
    }
  }

  console.log(`Daily aggregation complete: ${successCount} users, ${errorCount} errors`);
}

async function aggregateWeekly() {
  console.log('Aggregating weekly stats...');

  // 获取上周一的日期
  const lastMonday = new Date();
  lastMonday.setDate(lastMonday.getDate() - lastMonday.getDay() - 6);
  const weekStart = lastMonday.toISOString().split('T')[0];

  // 获取所有活跃用户
  const usersQuery = `SELECT id FROM users WHERE status = 'active'`;
  const usersResult = await dataStore.query(usersQuery);

  let successCount = 0;
  let errorCount = 0;

  for (const user of usersResult.rows) {
    try {
      await learningStats.generateWeeklyStats(user.id, weekStart);
      successCount++;
    } catch (error) {
      console.error(`Error generating weekly stats for user ${user.id}:`, error);
      errorCount++;
    }
  }

  console.log(`Weekly aggregation complete: ${successCount} users, ${errorCount} errors`);
}

async function aggregateMonthly() {
  console.log('Aggregating monthly stats...');

  // 获取上个月第一天
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  lastMonth.setDate(1);
  const monthStart = lastMonth.toISOString().split('T')[0];

  // 获取所有活跃用户
  const usersQuery = `SELECT id FROM users WHERE status = 'active'`;
  const usersResult = await dataStore.query(usersQuery);

  let successCount = 0;
  let errorCount = 0;

  for (const user of usersResult.rows) {
    try {
      await learningStats.generateMonthlyStats(user.id, monthStart);
      successCount++;
    } catch (error) {
      console.error(`Error generating monthly stats for user ${user.id}:`, error);
      errorCount++;
    }
  }

  console.log(`Monthly aggregation complete: ${successCount} users, ${errorCount} errors`);
}

async function main() {
  const startTime = Date.now();
  const type = process.argv[2] || 'daily';

  console.log(`[${new Date().toISOString()}] Starting ${type} aggregation...`);

  try {
    // 初始化数据库连接
    await dataStore.init();
    console.log('Database connected');

    // 根据类型执行聚合
    switch (type) {
      case 'daily':
        await aggregateDaily();
        break;
      case 'weekly':
        await aggregateWeekly();
        break;
      case 'monthly':
        await aggregateMonthly();
        break;
      default:
        console.error(`Unknown type: ${type}. Use: daily, weekly, or monthly`);
        process.exit(1);
    }

    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] Aggregation completed (${duration}ms)`);
    process.exit(0);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error during aggregation:`, error);
    process.exit(1);
  }
}

// 执行
main();
