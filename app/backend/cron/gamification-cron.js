/**
 * Gamification Cron Jobs
 * 游戏化定时任务
 *
 * 任务:
 * 1. 每天 21:00 - 发送连胜危险警告
 * 2. 每天 00:05 - 处理连胜断连、自动应用冻结
 * 3. 每天 00:10 - 发送召回通知 (断连用户)
 * 4. 每周日 23:55 - 处理联赛周结算
 * 5. 每周一 00:00 - 新赛季开始、发放奖励
 * 6. 每小时 - 更新联赛排名、处理到期挑战
 */

const dataStore = require('../data-store');

class GamificationCron {

  constructor() {
    this.isRunning = false;
    this.timers = [];
    this.lastRun = {};
  }

  /**
   * 启动所有定时任务
   */
  start() {
    if (this.isRunning) {
      console.log('[GamificationCron] Already running');
      return;
    }

    this.isRunning = true;
    console.log('[GamificationCron] Starting gamification cron jobs...');

    // 每分钟检查是否需要执行任务
    const checkInterval = setInterval(() => this.checkAndRunTasks(), 60000);
    this.timers.push(checkInterval);

    // 立即执行一次检查
    this.checkAndRunTasks();

    console.log('[GamificationCron] Cron jobs started');
  }

  /**
   * 停止所有定时任务
   */
  stop() {
    this.timers.forEach(timer => clearInterval(timer));
    this.timers = [];
    this.isRunning = false;
    console.log('[GamificationCron] Cron jobs stopped');
  }

  /**
   * 检查并执行到期的任务
   */
  async checkAndRunTasks() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const dateKey = now.toISOString().split('T')[0];

    try {
      // 每天 21:00 - 发送连胜危险警告
      if (hour === 21 && minute === 0) {
        await this.runIfNotRun('streak_danger', dateKey, () => this.sendStreakDangerWarnings());
      }

      // 每天 00:05 - 处理连胜断连、自动应用冻结
      if (hour === 0 && minute === 5) {
        await this.runIfNotRun('streak_process', dateKey, () => this.processStreakBreaks());
      }

      // 每天 00:10 - 发送召回通知
      if (hour === 0 && minute === 10) {
        await this.runIfNotRun('streak_recall', dateKey, () => this.sendRecallNotifications());
      }

      // 每周日 23:55 - 处理联赛周结算
      if (dayOfWeek === 0 && hour === 23 && minute === 55) {
        const weekKey = `${dateKey}_week`;
        await this.runIfNotRun('league_settle', weekKey, () => this.processLeagueSettlement());
      }

      // 每周一 00:00 - 新赛季开始
      if (dayOfWeek === 1 && hour === 0 && minute === 0) {
        const weekKey = `${dateKey}_week`;
        await this.runIfNotRun('league_new_season', weekKey, () => this.startNewLeagueSeason());
      }

      // 每小时整点 - 更新联赛排名
      if (minute === 0) {
        const hourKey = `${dateKey}_${hour}`;
        await this.runIfNotRun('league_rankings', hourKey, () => this.updateLeagueRankings());
      }

      // 每小时整点 - 处理到期的好友挑战
      if (minute === 0) {
        const hourKey = `${dateKey}_${hour}`;
        await this.runIfNotRun('challenges', hourKey, () => this.processExpiredChallenges());
      }

    } catch (error) {
      console.error('[GamificationCron] Error in checkAndRunTasks:', error);
    }
  }

  /**
   * 如果未运行过则执行任务
   */
  async runIfNotRun(taskName, key, task) {
    const fullKey = `${taskName}_${key}`;
    if (this.lastRun[fullKey]) {
      return;
    }

    console.log(`[GamificationCron] Running task: ${taskName}`);
    this.lastRun[fullKey] = new Date();

    try {
      await task();
      console.log(`[GamificationCron] Task ${taskName} completed`);
    } catch (error) {
      console.error(`[GamificationCron] Task ${taskName} failed:`, error);
    }
  }

  // ============================================================================
  // Streak Tasks
  // ============================================================================

  /**
   * 发送连胜危险警告
   * 每天21:00执行，提醒今天还没学习的用户
   */
  async sendStreakDangerWarnings() {
    try {
      // 找到有连胜但今天还没学习的用户
      const query = `
        SELECT u.id, u.username, u.email, u.current_streak
        FROM users u
        WHERE u.current_streak > 0
          AND u.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM user_learning_stats uls
            WHERE uls.user_id = u.id
              AND uls.stat_date = CURRENT_DATE
              AND uls.xp_gained > 0
          )
          AND NOT EXISTS (
            SELECT 1 FROM streak_recall_notifications srn
            WHERE srn.user_id = u.id
              AND srn.notification_type = 'danger'
              AND srn.sent_at::date = CURRENT_DATE
          )
      `;
      const result = await dataStore.query(query);
      const users = result.rows;

      console.log(`[GamificationCron] Found ${users.length} users with streak danger`);

      for (const user of users) {
        await this.recordNotification(user.id, 'danger');
        // TODO: 实际发送推送通知
        console.log(`[GamificationCron] Streak danger warning sent to user ${user.id} (streak: ${user.current_streak})`);
      }

      return users.length;
    } catch (error) {
      console.error('[GamificationCron] Error sending streak danger warnings:', error);
      throw error;
    }
  }

  /**
   * 处理连胜断连
   * 每天00:05执行，检查昨天没学习的用户
   */
  async processStreakBreaks() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      // 找到昨天没学习且有连胜的用户
      const query = `
        SELECT u.id, u.username, u.current_streak
        FROM users u
        WHERE u.current_streak > 0
          AND u.status = 'active'
          AND u.streak_protected_today = FALSE
          AND NOT EXISTS (
            SELECT 1 FROM user_learning_stats uls
            WHERE uls.user_id = u.id
              AND uls.stat_date = $1
              AND uls.xp_gained > 0
          )
      `;
      const result = await dataStore.query(query, [yesterdayStr]);
      const users = result.rows;

      console.log(`[GamificationCron] Found ${users.length} users who may lose streak`);

      let freezeApplied = 0;
      let streakBroken = 0;

      for (const user of users) {
        // 尝试自动应用冻结卡
        const freezeResult = await this.tryAutoApplyFreeze(user.id, yesterdayStr);

        if (freezeResult) {
          freezeApplied++;
          console.log(`[GamificationCron] Auto freeze applied for user ${user.id}`);
        } else {
          // 断连
          await this.breakStreak(user.id, user.current_streak);
          streakBroken++;
          console.log(`[GamificationCron] Streak broken for user ${user.id} (was: ${user.current_streak})`);
        }
      }

      // 重置所有用户的 streak_protected_today
      await dataStore.query(`UPDATE users SET streak_protected_today = FALSE WHERE status = 'active'`);

      console.log(`[GamificationCron] Streak processing complete: ${freezeApplied} freezes applied, ${streakBroken} streaks broken`);

      return { freezeApplied, streakBroken };
    } catch (error) {
      console.error('[GamificationCron] Error processing streak breaks:', error);
      throw error;
    }
  }

  /**
   * 尝试自动应用冻结卡
   */
  async tryAutoApplyFreeze(userId, protectedDate) {
    try {
      // 检查用户是否有可用的冻结卡
      const inventoryQuery = `
        SELECT id, freeze_type, quantity
        FROM user_streak_freeze_inventory
        WHERE user_id = $1 AND quantity > 0
        ORDER BY
          CASE freeze_type
            WHEN 'premium' THEN 1
            WHEN 'weekend' THEN 2
            WHEN 'daily' THEN 3
          END
        LIMIT 1
      `;
      const inventory = await dataStore.query(inventoryQuery, [userId]);

      if (inventory.rows.length === 0) {
        return false;
      }

      const freeze = inventory.rows[0];

      // 使用冻结卡
      await dataStore.query(`
        UPDATE user_streak_freeze_inventory
        SET quantity = quantity - 1
        WHERE id = $1
      `, [freeze.id]);

      // 记录使用历史
      await dataStore.query(`
        INSERT INTO streak_freeze_history (user_id, freeze_type, protected_date, was_auto_applied)
        VALUES ($1, $2, $3, TRUE)
      `, [userId, freeze.freeze_type, protectedDate]);

      // 标记今天受保护
      await dataStore.query(`
        UPDATE users SET streak_protected_today = TRUE WHERE id = $1
      `, [userId]);

      return true;
    } catch (error) {
      console.error('[GamificationCron] Error auto applying freeze:', error);
      return false;
    }
  }

  /**
   * 断连处理
   */
  async breakStreak(userId, previousStreak) {
    try {
      // 更新最长连胜记录
      await dataStore.query(`
        UPDATE users
        SET longest_streak = GREATEST(longest_streak, $1),
            current_streak = 0,
            last_activity_date = NULL
        WHERE id = $2
      `, [previousStreak, userId]);

      return true;
    } catch (error) {
      console.error('[GamificationCron] Error breaking streak:', error);
      throw error;
    }
  }

  /**
   * 发送召回通知
   * 每天00:10执行，给昨天断连的用户发送通知
   */
  async sendRecallNotifications() {
    try {
      // 找到最近断连的用户（连胜从>0变成0）
      const query = `
        SELECT u.id, u.username, u.email, u.longest_streak
        FROM users u
        WHERE u.current_streak = 0
          AND u.longest_streak > 3
          AND u.status = 'active'
          AND u.last_activity_date IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM streak_recall_notifications srn
            WHERE srn.user_id = u.id
              AND srn.notification_type = 'broken'
              AND srn.sent_at > NOW() - INTERVAL '24 hours'
          )
        LIMIT 100
      `;
      const result = await dataStore.query(query);
      const users = result.rows;

      console.log(`[GamificationCron] Found ${users.length} users for recall notification`);

      for (const user of users) {
        await this.recordNotification(user.id, 'broken');
        // TODO: 实际发送推送/邮件通知
        console.log(`[GamificationCron] Recall notification sent to user ${user.id}`);
      }

      return users.length;
    } catch (error) {
      console.error('[GamificationCron] Error sending recall notifications:', error);
      throw error;
    }
  }

  /**
   * 记录通知
   */
  async recordNotification(userId, notificationType) {
    try {
      await dataStore.query(`
        INSERT INTO streak_recall_notifications (user_id, notification_type, channel)
        VALUES ($1, $2, 'push')
      `, [userId, notificationType]);
    } catch (error) {
      console.error('[GamificationCron] Error recording notification:', error);
    }
  }

  // ============================================================================
  // League Tasks
  // ============================================================================

  /**
   * 处理联赛周结算
   * 每周日23:55执行
   */
  async processLeagueSettlement() {
    try {
      // 获取当前赛季
      const seasonQuery = `
        SELECT id, season_name FROM league_seasons WHERE is_active = TRUE LIMIT 1
      `;
      const seasonResult = await dataStore.query(seasonQuery);

      if (seasonResult.rows.length === 0) {
        console.log('[GamificationCron] No active season found');
        return 0;
      }

      const season = seasonResult.rows[0];
      console.log(`[GamificationCron] Processing settlement for season: ${season.season_name}`);

      // 调用结算函数
      const processQuery = `SELECT process_season_end($1) as processed`;
      const result = await dataStore.query(processQuery, [season.id]);

      const processed = result.rows[0]?.processed || 0;
      console.log(`[GamificationCron] League settlement complete: ${processed} users processed`);

      return processed;
    } catch (error) {
      console.error('[GamificationCron] Error processing league settlement:', error);
      throw error;
    }
  }

  /**
   * 开始新赛季
   * 每周一00:00执行
   */
  async startNewLeagueSeason() {
    try {
      // 调用创建新赛季函数
      const query = `SELECT * FROM get_or_create_current_season()`;
      const result = await dataStore.query(query);

      if (result.rows.length > 0) {
        const season = result.rows[0];
        console.log(`[GamificationCron] New season started: ${season.season_name}`);
        return season;
      }

      return null;
    } catch (error) {
      console.error('[GamificationCron] Error starting new league season:', error);
      throw error;
    }
  }

  /**
   * 更新联赛排名
   * 每小时执行
   */
  async updateLeagueRankings() {
    try {
      // 获取当前赛季的所有组
      const groupsQuery = `
        SELECT lg.id
        FROM league_groups lg
        JOIN league_seasons ls ON lg.season_id = ls.id
        WHERE ls.is_active = TRUE
      `;
      const groupsResult = await dataStore.query(groupsQuery);
      const groups = groupsResult.rows;

      console.log(`[GamificationCron] Updating rankings for ${groups.length} groups`);

      for (const group of groups) {
        await dataStore.query(`SELECT calculate_group_rankings($1)`, [group.id]);
      }

      console.log('[GamificationCron] League rankings updated');
      return groups.length;
    } catch (error) {
      console.error('[GamificationCron] Error updating league rankings:', error);
      throw error;
    }
  }

  // ============================================================================
  // Challenge Tasks
  // ============================================================================

  /**
   * 处理到期的好友挑战
   * 每小时执行
   */
  async processExpiredChallenges() {
    try {
      // 找到已到期的挑战
      const query = `
        SELECT id FROM friend_challenges
        WHERE status = 'active' AND end_date <= NOW()
      `;
      const result = await dataStore.query(query);
      const challenges = result.rows;

      console.log(`[GamificationCron] Found ${challenges.length} expired challenges`);

      for (const challenge of challenges) {
        await this.completeChallenge(challenge.id);
      }

      return challenges.length;
    } catch (error) {
      console.error('[GamificationCron] Error processing expired challenges:', error);
      throw error;
    }
  }

  /**
   * 完成挑战
   */
  async completeChallenge(challengeId) {
    try {
      // 获取挑战详情
      const challengeQuery = `
        SELECT * FROM friend_challenges WHERE id = $1
      `;
      const challengeResult = await dataStore.query(challengeQuery, [challengeId]);

      if (challengeResult.rows.length === 0) {
        return;
      }

      const challenge = challengeResult.rows[0];

      // 确定赢家
      let winnerId = null;
      if (challenge.challenger_score > challenge.challenged_score) {
        winnerId = challenge.challenger_id;
      } else if (challenge.challenged_score > challenge.challenger_score) {
        winnerId = challenge.challenged_id;
      }

      // 更新挑战状态
      await dataStore.query(`
        UPDATE friend_challenges
        SET status = 'completed', winner_id = $1, updated_at = NOW()
        WHERE id = $2
      `, [winnerId, challengeId]);

      // 发放奖励
      if (winnerId) {
        await dataStore.query(`
          UPDATE users
          SET xp = xp + $1, coins = coins + $2
          WHERE id = $3
        `, [challenge.reward_xp || 100, challenge.reward_coins || 50, winnerId]);

        console.log(`[GamificationCron] Challenge ${challengeId} completed. Winner: ${winnerId}`);
      } else {
        console.log(`[GamificationCron] Challenge ${challengeId} completed. Result: Draw`);
      }

    } catch (error) {
      console.error(`[GamificationCron] Error completing challenge ${challengeId}:`, error);
    }
  }

  // ============================================================================
  // Manual Triggers (for admin use)
  // ============================================================================

  /**
   * 手动触发任务 (管理员用)
   */
  async manualTrigger(taskName) {
    console.log(`[GamificationCron] Manual trigger: ${taskName}`);

    switch (taskName) {
      case 'streak_danger':
        return await this.sendStreakDangerWarnings();
      case 'streak_process':
        return await this.processStreakBreaks();
      case 'streak_recall':
        return await this.sendRecallNotifications();
      case 'league_settle':
        return await this.processLeagueSettlement();
      case 'league_new_season':
        return await this.startNewLeagueSeason();
      case 'league_rankings':
        return await this.updateLeagueRankings();
      case 'challenges':
        return await this.processExpiredChallenges();
      default:
        throw new Error(`Unknown task: ${taskName}`);
    }
  }

  /**
   * 获取任务状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      timersCount: this.timers.length
    };
  }
}

// 创建单例
const gamificationCron = new GamificationCron();

module.exports = gamificationCron;
