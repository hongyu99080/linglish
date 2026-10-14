/**
 * Streak Service
 * 连胜增强服务
 *
 * 功能：
 * 1. 连胜状态查询
 * 2. 冻结卡购买和使用
 * 3. 里程碑检查和奖励
 * 4. 召回通知管理
 * 5. 自动保护逻辑
 */

const dataStore = require('../data-store');

class StreakService {

  /**
   * 获取用户连胜状态
   * @param {number} userId
   * @returns {Promise<Object>}
   */
  async getStreakStatus(userId) {
    try {
      // Get basic streak info from users table
      const userQuery = `
        SELECT
          streak_days,
          longest_streak,
          streak_protected_today,
          current_streak_started_at,
          streak_breaks_count,
          last_streak_break_at,
          coins,
          gems
        FROM users
        WHERE id = $1
      `;
      const userResult = await dataStore.query(userQuery, [userId]);

      if (userResult.rows.length === 0) {
        throw new Error('USER_NOT_FOUND');
      }

      const user = userResult.rows[0];

      // Get last activity date
      const activityQuery = `
        SELECT MAX(activity_date) as last_activity_date
        FROM user_daily_activity
        WHERE user_id = $1
      `;
      const activityResult = await dataStore.query(activityQuery, [userId]);
      const lastActivityDate = activityResult.rows[0]?.last_activity_date;

      // Calculate days since last activity
      let daysSinceActivity = 0;
      if (lastActivityDate) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const lastDate = new Date(lastActivityDate);
        lastDate.setHours(0, 0, 0, 0);
        daysSinceActivity = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));
      }

      // Check if in danger (after 9 PM and no activity today)
      const currentHour = new Date().getHours();
      const isInDanger = currentHour >= 21 && daysSinceActivity > 0;

      // Get next milestone
      const milestoneQuery = `
        SELECT id, days_required, milestone_name, milestone_name_en, xp_reward, coins_reward, gems_reward
        FROM streak_milestones
        WHERE days_required > $1 AND is_active = TRUE
        ORDER BY days_required ASC
        LIMIT 1
      `;
      const milestoneResult = await dataStore.query(milestoneQuery, [user.streak_days || 0]);
      const nextMilestone = milestoneResult.rows[0] || null;

      // Get available freezes
      const freezeQuery = `
        SELECT usfi.freeze_type, usfi.quantity, sfc.cost_coins, sfc.cost_gems, sfc.description, sfc.description_en
        FROM user_streak_freeze_inventory usfi
        JOIN streak_freeze_config sfc ON usfi.freeze_type = sfc.freeze_type
        WHERE usfi.user_id = $1 AND usfi.quantity > 0
      `;
      const freezeResult = await dataStore.query(freezeQuery, [userId]);

      // Get uncelebrated milestones
      const uncelebratedQuery = `
        SELECT usm.id, usm.milestone_id, sm.milestone_name, sm.milestone_name_en,
               sm.xp_reward, sm.coins_reward, sm.gems_reward, sm.celebration_type, sm.badge_icon
        FROM user_streak_milestones usm
        JOIN streak_milestones sm ON usm.milestone_id = sm.id
        WHERE usm.user_id = $1 AND usm.celebrated = FALSE
        ORDER BY sm.days_required ASC
      `;
      const uncelebratedResult = await dataStore.query(uncelebratedQuery, [userId]);

      return {
        currentStreak: user.streak_days || 0,
        longestStreak: user.longest_streak || 0,
        streakProtectedToday: user.streak_protected_today || false,
        currentStreakStartedAt: user.current_streak_started_at,
        lastActivityDate: lastActivityDate,
        daysSinceActivity: daysSinceActivity,
        isInDanger: isInDanger,
        streakBreaksCount: user.streak_breaks_count || 0,
        nextMilestone: nextMilestone ? {
          id: nextMilestone.id,
          daysRequired: nextMilestone.days_required,
          daysRemaining: nextMilestone.days_required - (user.streak_days || 0),
          name: nextMilestone.milestone_name,
          nameEn: nextMilestone.milestone_name_en,
          rewards: {
            xp: nextMilestone.xp_reward,
            coins: nextMilestone.coins_reward,
            gems: nextMilestone.gems_reward
          }
        } : null,
        availableFreezes: freezeResult.rows.map(f => ({
          freezeType: f.freeze_type,
          quantity: f.quantity,
          costCoins: f.cost_coins,
          costGems: f.cost_gems,
          description: f.description,
          descriptionEn: f.description_en
        })),
        uncelebratedMilestones: uncelebratedResult.rows.map(m => ({
          id: m.id,
          milestoneId: m.milestone_id,
          name: m.milestone_name,
          nameEn: m.milestone_name_en,
          celebrationType: m.celebration_type,
          badgeIcon: m.badge_icon,
          rewards: {
            xp: m.xp_reward,
            coins: m.coins_reward,
            gems: m.gems_reward
          }
        })),
        userBalance: {
          coins: user.coins || 0,
          gems: user.gems || 0
        }
      };
    } catch (error) {
      console.error('Error getting streak status:', error);
      throw error;
    }
  }

  /**
   * 获取所有冻结卡配置
   * @returns {Promise<Array>}
   */
  async getFreezeConfigs() {
    const query = `
      SELECT
        freeze_type,
        cost_coins,
        cost_gems,
        duration_days,
        cooldown_days,
        max_per_month,
        is_premium_only,
        description,
        description_en,
        icon_url
      FROM streak_freeze_config
      ORDER BY cost_coins ASC
    `;
    const result = await dataStore.query(query);
    return result.rows;
  }

  /**
   * 购买冻结卡
   * @param {number} userId
   * @param {string} freezeType
   * @returns {Promise<Object>}
   */
  async purchaseFreeze(userId, freezeType) {
    try {
      // Use the database function
      const query = `SELECT purchase_streak_freeze($1, $2) as result`;
      const result = await dataStore.query(query, [userId, freezeType]);

      const purchaseResult = result.rows[0].result;

      if (!purchaseResult.success) {
        const errorMessages = {
          'INVALID_FREEZE_TYPE': '无效的冻结卡类型',
          'INSUFFICIENT_COINS': '金币不足',
          'INSUFFICIENT_GEMS': '钻石不足',
          'MONTHLY_LIMIT_REACHED': '本月购买次数已达上限'
        };
        throw new Error(errorMessages[purchaseResult.error] || purchaseResult.error);
      }

      return {
        success: true,
        freezeType: purchaseResult.freeze_type,
        newQuantity: purchaseResult.new_quantity
      };
    } catch (error) {
      console.error('Error purchasing freeze:', error);
      throw error;
    }
  }

  /**
   * 使用冻结卡
   * @param {number} userId
   * @param {string} freezeType
   * @param {Date} protectedDate
   * @returns {Promise<Object>}
   */
  async useFreeze(userId, freezeType = 'daily', protectedDate = null) {
    try {
      const dateToProtect = protectedDate || new Date().toISOString().split('T')[0];

      // Check if already protected today
      const checkQuery = `SELECT streak_protected_today FROM users WHERE id = $1`;
      const checkResult = await dataStore.query(checkQuery, [userId]);

      if (checkResult.rows[0]?.streak_protected_today) {
        return {
          success: false,
          error: 'ALREADY_PROTECTED',
          message: '今天已经被保护了'
        };
      }

      // Use the database function
      const query = `SELECT use_streak_freeze($1, $2, $3) as success`;
      const result = await dataStore.query(query, [userId, freezeType, dateToProtect]);

      if (!result.rows[0].success) {
        return {
          success: false,
          error: 'NO_FREEZE_AVAILABLE',
          message: '没有可用的冻结卡'
        };
      }

      return {
        success: true,
        freezeType: freezeType,
        protectedDate: dateToProtect
      };
    } catch (error) {
      console.error('Error using freeze:', error);
      throw error;
    }
  }

  /**
   * 检查并应用自动冻结（午夜任务）
   * @param {number} userId
   * @returns {Promise<Object>}
   */
  async checkAndApplyAutoFreeze(userId) {
    try {
      // Check if user has any activity today
      const activityQuery = `
        SELECT COUNT(*) as count
        FROM user_daily_activity
        WHERE user_id = $1 AND activity_date = CURRENT_DATE
      `;
      const activityResult = await dataStore.query(activityQuery, [userId]);

      if (activityResult.rows[0].count > 0) {
        return { applied: false, reason: 'HAS_ACTIVITY_TODAY' };
      }

      // Check if already protected
      const userQuery = `SELECT streak_protected_today, streak_days FROM users WHERE id = $1`;
      const userResult = await dataStore.query(userQuery, [userId]);

      if (userResult.rows[0]?.streak_protected_today) {
        return { applied: false, reason: 'ALREADY_PROTECTED' };
      }

      // Check for available freeze
      const freezeQuery = `
        SELECT freeze_type, quantity
        FROM user_streak_freeze_inventory
        WHERE user_id = $1 AND quantity > 0
        ORDER BY
          CASE freeze_type WHEN 'daily' THEN 1 WHEN 'weekend' THEN 2 ELSE 3 END
        LIMIT 1
      `;
      const freezeResult = await dataStore.query(freezeQuery, [userId]);

      if (freezeResult.rows.length === 0) {
        // No freeze available, streak will break
        return { applied: false, reason: 'NO_FREEZE_AVAILABLE' };
      }

      const freeze = freezeResult.rows[0];

      // Apply the freeze automatically
      const useResult = await this.useFreeze(userId, freeze.freeze_type);

      if (useResult.success) {
        // Log auto-application
        await dataStore.query(`
          UPDATE user_streak_freeze_history
          SET was_auto_applied = TRUE, notes = 'Auto-applied at midnight'
          WHERE user_id = $1
            AND action = 'use'
            AND created_at >= CURRENT_DATE
          ORDER BY created_at DESC
          LIMIT 1
        `, [userId]);

        return {
          applied: true,
          freezeType: freeze.freeze_type,
          streakPreserved: userResult.rows[0].streak_days
        };
      }

      return { applied: false, reason: 'USE_FAILED' };
    } catch (error) {
      console.error('Error in auto-freeze check:', error);
      throw error;
    }
  }

  /**
   * 获取所有里程碑
   * @returns {Promise<Array>}
   */
  async getAllMilestones() {
    const query = `
      SELECT
        id,
        days_required,
        milestone_name,
        milestone_name_en,
        description,
        description_en,
        xp_reward,
        coins_reward,
        gems_reward,
        badge_icon,
        celebration_type
      FROM streak_milestones
      WHERE is_active = TRUE
      ORDER BY days_required ASC
    `;
    const result = await dataStore.query(query);
    return result.rows;
  }

  /**
   * 获取用户已达成的里程碑
   * @param {number} userId
   * @returns {Promise<Array>}
   */
  async getUserMilestones(userId) {
    const query = `
      SELECT
        usm.id,
        usm.milestone_id,
        usm.achieved_at,
        usm.celebrated,
        usm.rewards_claimed,
        usm.streak_at_achievement,
        sm.days_required,
        sm.milestone_name,
        sm.milestone_name_en,
        sm.xp_reward,
        sm.coins_reward,
        sm.gems_reward,
        sm.badge_icon,
        sm.celebration_type
      FROM user_streak_milestones usm
      JOIN streak_milestones sm ON usm.milestone_id = sm.id
      WHERE usm.user_id = $1
      ORDER BY sm.days_required DESC
    `;
    const result = await dataStore.query(query, [userId]);
    return result.rows;
  }

  /**
   * 检查用户新达成的里程碑
   * @param {number} userId
   * @returns {Promise<Array>}
   */
  async checkNewMilestones(userId) {
    try {
      // Use the database function
      const query = `SELECT * FROM check_streak_milestones($1)`;
      const result = await dataStore.query(query, [userId]);

      const newMilestones = result.rows;

      // Record newly achieved milestones
      for (const milestone of newMilestones) {
        await dataStore.query(`
          INSERT INTO user_streak_milestones (user_id, milestone_id, streak_at_achievement)
          VALUES ($1, $2, (SELECT streak_days FROM users WHERE id = $1))
          ON CONFLICT (user_id, milestone_id) DO NOTHING
        `, [userId, milestone.milestone_id]);
      }

      return newMilestones;
    } catch (error) {
      console.error('Error checking milestones:', error);
      throw error;
    }
  }

  /**
   * 领取里程碑奖励
   * @param {number} userId
   * @param {number} milestoneId
   * @returns {Promise<Object>}
   */
  async claimMilestoneReward(userId, milestoneId) {
    try {
      const query = `SELECT claim_streak_milestone($1, $2) as result`;
      const result = await dataStore.query(query, [userId, milestoneId]);

      const claimResult = result.rows[0].result;

      if (!claimResult.success) {
        const errorMessages = {
          'MILESTONE_NOT_FOUND': '里程碑不存在',
          'STREAK_INSUFFICIENT': '连胜天数不足',
          'ALREADY_CLAIMED': '奖励已领取'
        };
        throw new Error(errorMessages[claimResult.error] || claimResult.error);
      }

      return {
        success: true,
        milestoneName: claimResult.milestone_name,
        rewards: {
          xp: claimResult.xp_awarded,
          coins: claimResult.coins_awarded,
          gems: claimResult.gems_awarded
        },
        celebrationType: claimResult.celebration_type
      };
    } catch (error) {
      console.error('Error claiming milestone:', error);
      throw error;
    }
  }

  /**
   * 标记里程碑已庆祝
   * @param {number} userId
   * @param {number} milestoneId
   * @returns {Promise<boolean>}
   */
  async markMilestoneCelebrated(userId, milestoneId) {
    try {
      const query = `
        UPDATE user_streak_milestones
        SET celebrated = TRUE, celebrated_at = NOW()
        WHERE user_id = $1 AND milestone_id = $2
        RETURNING id
      `;
      const result = await dataStore.query(query, [userId, milestoneId]);
      return result.rows.length > 0;
    } catch (error) {
      console.error('Error marking milestone celebrated:', error);
      throw error;
    }
  }

  /**
   * 获取冻结卡使用历史
   * @param {number} userId
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getFreezeHistory(userId, limit = 20) {
    const query = `
      SELECT
        id,
        freeze_type,
        action,
        protected_date,
        cost_type,
        cost_amount,
        was_auto_applied,
        streak_at_time,
        notes,
        created_at
      FROM user_streak_freeze_history
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const result = await dataStore.query(query, [userId, limit]);
    return result.rows;
  }

  /**
   * 发送连胜危险警告
   * @param {number} userId
   * @returns {Promise<Object>}
   */
  async sendDangerNotification(userId) {
    try {
      // Get user's current streak
      const userQuery = `SELECT streak_days, username FROM users WHERE id = $1`;
      const userResult = await dataStore.query(userQuery, [userId]);

      if (userResult.rows.length === 0) {
        return { sent: false, reason: 'USER_NOT_FOUND' };
      }

      const user = userResult.rows[0];

      // Check if already sent today
      const checkQuery = `
        SELECT id FROM streak_recall_notifications
        WHERE user_id = $1
          AND notification_type = 'danger_warning'
          AND DATE(sent_at) = CURRENT_DATE
      `;
      const checkResult = await dataStore.query(checkQuery, [userId]);

      if (checkResult.rows.length > 0) {
        return { sent: false, reason: 'ALREADY_SENT_TODAY' };
      }

      // Record notification
      const insertQuery = `
        INSERT INTO streak_recall_notifications (
          user_id, notification_type, streak_before_break, days_since_activity, channel, message_template
        )
        VALUES ($1, 'danger_warning', $2, 0, 'in_app', 'streak_danger')
        RETURNING id
      `;
      await dataStore.query(insertQuery, [userId, user.streak_days]);

      return {
        sent: true,
        streakDays: user.streak_days,
        username: user.username
      };
    } catch (error) {
      console.error('Error sending danger notification:', error);
      throw error;
    }
  }

  /**
   * 发送连胜断连通知
   * @param {number} userId
   * @param {number} streakBefore
   * @returns {Promise<Object>}
   */
  async sendBrokenNotification(userId, streakBefore) {
    try {
      const insertQuery = `
        INSERT INTO streak_recall_notifications (
          user_id, notification_type, streak_before_break, days_since_activity, channel, message_template
        )
        VALUES ($1, 'broken', $2, 1, 'in_app', 'streak_broken')
        RETURNING id
      `;
      await dataStore.query(insertQuery, [userId, streakBefore]);

      return { sent: true };
    } catch (error) {
      console.error('Error sending broken notification:', error);
      throw error;
    }
  }

  /**
   * 发送召回通知
   * @param {number} userId
   * @param {number} daysSinceActivity
   * @returns {Promise<Object>}
   */
  async sendComebackNotification(userId, daysSinceActivity) {
    try {
      const notificationType = `comeback_${daysSinceActivity}d`;

      // Check if already sent this type
      const checkQuery = `
        SELECT id FROM streak_recall_notifications
        WHERE user_id = $1 AND notification_type = $2
      `;
      const checkResult = await dataStore.query(checkQuery, [userId, notificationType]);

      if (checkResult.rows.length > 0) {
        return { sent: false, reason: 'ALREADY_SENT' };
      }

      // Get streak before break
      const userQuery = `SELECT streak_days FROM users WHERE id = $1`;
      const userResult = await dataStore.query(userQuery, [userId]);

      const insertQuery = `
        INSERT INTO streak_recall_notifications (
          user_id, notification_type, streak_before_break, days_since_activity, channel, message_template
        )
        VALUES ($1, $2, $3, $4, 'in_app', 'streak_comeback')
        RETURNING id
      `;
      await dataStore.query(insertQuery, [
        userId,
        notificationType,
        userResult.rows[0]?.streak_days || 0,
        daysSinceActivity
      ]);

      return { sent: true, notificationType };
    } catch (error) {
      console.error('Error sending comeback notification:', error);
      throw error;
    }
  }

  /**
   * 标记通知已打开
   * @param {number} notificationId
   * @returns {Promise<boolean>}
   */
  async markNotificationOpened(notificationId) {
    try {
      const query = `
        UPDATE streak_recall_notifications
        SET was_opened = TRUE, opened_at = NOW()
        WHERE id = $1
        RETURNING id
      `;
      const result = await dataStore.query(query, [notificationId]);
      return result.rows.length > 0;
    } catch (error) {
      console.error('Error marking notification opened:', error);
      throw error;
    }
  }

  /**
   * 记录通知导致的活动
   * @param {number} userId
   * @returns {Promise<boolean>}
   */
  async recordNotificationActivity(userId) {
    try {
      // Find recent unopened notifications and mark them as resulted in activity
      const query = `
        UPDATE streak_recall_notifications
        SET resulted_in_activity = TRUE, activity_recorded_at = NOW()
        WHERE user_id = $1
          AND sent_at >= NOW() - INTERVAL '7 days'
          AND resulted_in_activity = FALSE
        RETURNING id
      `;
      const result = await dataStore.query(query, [userId]);
      return result.rows.length > 0;
    } catch (error) {
      console.error('Error recording notification activity:', error);
      throw error;
    }
  }

  /**
   * 获取用户待处理的通知
   * @param {number} userId
   * @returns {Promise<Array>}
   */
  async getPendingNotifications(userId) {
    const query = `
      SELECT
        id,
        notification_type,
        streak_before_break,
        days_since_activity,
        message_template,
        sent_at
      FROM streak_recall_notifications
      WHERE user_id = $1
        AND was_opened = FALSE
        AND sent_at >= NOW() - INTERVAL '7 days'
      ORDER BY sent_at DESC
    `;
    const result = await dataStore.query(query, [userId]);
    return result.rows;
  }

  /**
   * 获取需要发送危险警告的用户（晚9点任务）
   * @returns {Promise<Array>}
   */
  async getUsersForDangerWarning() {
    const query = `
      SELECT u.id, u.streak_days, u.username
      FROM users u
      WHERE u.status = 'active'
        AND u.streak_days > 0
        AND NOT EXISTS (
          SELECT 1 FROM user_daily_activity uda
          WHERE uda.user_id = u.id AND uda.activity_date = CURRENT_DATE
        )
        AND NOT EXISTS (
          SELECT 1 FROM streak_recall_notifications srn
          WHERE srn.user_id = u.id
            AND srn.notification_type = 'danger_warning'
            AND DATE(srn.sent_at) = CURRENT_DATE
        )
    `;
    const result = await dataStore.query(query);
    return result.rows;
  }

  /**
   * 获取需要处理连胜断连的用户（午夜任务）
   * @returns {Promise<Array>}
   */
  async getUsersWithBrokenStreak() {
    const query = `
      SELECT u.id, u.streak_days, u.username, u.streak_protected_today
      FROM users u
      WHERE u.status = 'active'
        AND u.streak_days > 0
        AND u.streak_protected_today = FALSE
        AND NOT EXISTS (
          SELECT 1 FROM user_daily_activity uda
          WHERE uda.user_id = u.id AND uda.activity_date = CURRENT_DATE - INTERVAL '1 day'
        )
    `;
    const result = await dataStore.query(query);
    return result.rows;
  }

  /**
   * 重置用户连胜（连胜断连时调用）
   * @param {number} userId
   * @param {number} previousStreak
   * @returns {Promise<Object>}
   */
  async breakStreak(userId, previousStreak) {
    try {
      // Update user record
      const query = `
        UPDATE users
        SET
          streak_days = 0,
          last_streak_break_at = NOW(),
          streak_breaks_count = streak_breaks_count + 1,
          streak_protected_today = FALSE,
          current_streak_started_at = NULL,
          longest_streak = GREATEST(longest_streak, $2)
        WHERE id = $1
        RETURNING id, longest_streak
      `;
      const result = await dataStore.query(query, [userId, previousStreak]);

      // Send broken notification
      await this.sendBrokenNotification(userId, previousStreak);

      return {
        broken: true,
        previousStreak: previousStreak,
        newLongestStreak: result.rows[0]?.longest_streak || previousStreak
      };
    } catch (error) {
      console.error('Error breaking streak:', error);
      throw error;
    }
  }

  /**
   * 重置每日保护状态（午夜任务）
   * @returns {Promise<number>} 更新的用户数
   */
  async resetDailyProtection() {
    try {
      const query = `
        UPDATE users
        SET streak_protected_today = FALSE
        WHERE streak_protected_today = TRUE
        RETURNING id
      `;
      const result = await dataStore.query(query);
      return result.rows.length;
    } catch (error) {
      console.error('Error resetting daily protection:', error);
      throw error;
    }
  }
}

module.exports = new StreakService();
