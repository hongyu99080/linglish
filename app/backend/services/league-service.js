/**
 * League Service
 * 联赛段位服务
 *
 * 功能：
 * 1. 赛季管理
 * 2. 段位查询
 * 3. 排行榜
 * 4. 晋级/降级处理
 * 5. 奖励发放
 */

const dataStore = require('../data-store');
const cacheService = require('./cache');

class LeagueService {

  /**
   * 获取当前赛季
   * @returns {Promise<Object>}
   */
  async getCurrentSeason() {
    try {
      const query = `SELECT * FROM get_or_create_current_season()`;
      const result = await dataStore.query(query);
      return result.rows[0];
    } catch (error) {
      console.error('Error getting current season:', error);
      throw error;
    }
  }

  /**
   * 获取所有段位
   * @returns {Promise<Array>}
   */
  async getAllTiers() {
    const cacheKey = 'league:tiers:all';
    const cached = await cacheService.get(cacheKey);
    if (cached) return cached;

    const query = `
      SELECT
        id,
        tier_key,
        tier_name,
        tier_name_en,
        tier_order,
        min_xp_to_stay,
        icon_url,
        color_code,
        promotion_slots,
        demotion_slots,
        safe_zone_slots,
        users_per_group,
        description,
        description_en
      FROM league_tiers
      WHERE is_active = TRUE
      ORDER BY tier_order ASC
    `;
    const result = await dataStore.query(query);
    await cacheService.set(cacheKey, result.rows, 3600);
    return result.rows;
  }

  /**
   * 获取用户联赛状态
   * @param {number} userId
   * @returns {Promise<Object>}
   */
  async getUserLeagueStatus(userId) {
    try {
      const season = await this.getCurrentSeason();

      // Check if user has joined
      let statusQuery = `
        SELECT
          uls.*,
          lt.tier_key,
          lt.tier_name,
          lt.tier_name_en,
          lt.color_code,
          lt.icon_url,
          lt.promotion_slots,
          lt.demotion_slots,
          lg.current_users AS group_size
        FROM user_league_status uls
        JOIN league_tiers lt ON uls.tier_id = lt.id
        JOIN league_groups lg ON uls.group_id = lg.id
        WHERE uls.user_id = $1 AND uls.season_id = $2
      `;
      let result = await dataStore.query(statusQuery, [userId, season.id]);

      // Auto-join if not in league
      if (result.rows.length === 0) {
        const joinQuery = `SELECT * FROM join_league($1)`;
        await dataStore.query(joinQuery, [userId]);

        result = await dataStore.query(statusQuery, [userId, season.id]);
      }

      if (result.rows.length === 0) {
        return null;
      }

      const status = result.rows[0];

      // Calculate time remaining in season
      const now = new Date();
      const endDate = new Date(season.end_date);
      const timeRemaining = Math.max(0, endDate - now);

      // Get next tier info if applicable
      let nextTier = null;
      if (status.tier_order < 5) {
        const nextTierQuery = `
          SELECT tier_key, tier_name, tier_name_en, color_code
          FROM league_tiers
          WHERE tier_order = $1
        `;
        const nextResult = await dataStore.query(nextTierQuery, [status.tier_order + 1]);
        if (nextResult.rows.length > 0) {
          nextTier = nextResult.rows[0];
        }
      }

      return {
        seasonId: season.id,
        seasonName: season.season_name,
        seasonEndsAt: season.end_date,
        timeRemaining: timeRemaining,
        tier: {
          id: status.tier_id,
          key: status.tier_key,
          name: status.tier_name,
          nameEn: status.tier_name_en,
          colorCode: status.color_code,
          iconUrl: status.icon_url
        },
        nextTier: nextTier,
        groupId: status.group_id,
        groupSize: status.group_size,
        weeklyXp: status.weekly_xp,
        currentRank: status.current_rank,
        bestRank: status.best_rank,
        zone: status.zone,
        promotionSlots: status.promotion_slots,
        demotionSlots: status.demotion_slots,
        joinedAt: status.joined_at
      };
    } catch (error) {
      console.error('Error getting user league status:', error);
      throw error;
    }
  }

  /**
   * 获取用户组内排行榜
   * @param {number} userId
   * @param {number} limit
   * @returns {Promise<Object>}
   */
  async getGroupLeaderboard(userId, limit = 50) {
    try {
      const status = await this.getUserLeagueStatus(userId);
      if (!status) {
        throw new Error('USER_NOT_IN_LEAGUE');
      }

      const query = `
        SELECT
          uls.user_id,
          u.username,
          u.level,
          uls.weekly_xp,
          uls.current_rank,
          uls.zone,
          uls.last_xp_update
        FROM user_league_status uls
        JOIN users u ON uls.user_id = u.id
        WHERE uls.group_id = $1
        ORDER BY uls.weekly_xp DESC, uls.last_xp_update ASC
        LIMIT $2
      `;
      const result = await dataStore.query(query, [status.groupId, limit]);

      // Find user's position
      const userIndex = result.rows.findIndex(r => r.user_id === userId);

      return {
        tier: status.tier,
        groupId: status.groupId,
        totalUsers: status.groupSize,
        leaderboard: result.rows.map((row, index) => ({
          rank: index + 1,
          userId: row.user_id,
          username: row.username,
          level: row.level,
          weeklyXp: row.weekly_xp,
          zone: row.zone,
          isCurrentUser: row.user_id === userId
        })),
        userPosition: userIndex >= 0 ? userIndex + 1 : null,
        promotionLine: status.promotionSlots,
        demotionLine: status.groupSize - status.demotionSlots
      };
    } catch (error) {
      console.error('Error getting group leaderboard:', error);
      throw error;
    }
  }

  /**
   * 添加周XP
   * @param {number} userId
   * @param {number} xp
   * @returns {Promise<Object>}
   */
  async addWeeklyXP(userId, xp) {
    try {
      const query = `SELECT * FROM add_league_xp($1, $2)`;
      const result = await dataStore.query(query, [userId, xp]);

      if (result.rows.length === 0) {
        return null;
      }

      const status = result.rows[0];

      // Recalculate rankings for the group
      await this.calculateRankings(status.group_id);

      return {
        newWeeklyXp: status.weekly_xp,
        groupId: status.group_id
      };
    } catch (error) {
      console.error('Error adding weekly XP:', error);
      throw error;
    }
  }

  /**
   * 计算组内排名
   * @param {number} groupId
   * @returns {Promise<void>}
   */
  async calculateRankings(groupId) {
    try {
      await dataStore.query(`SELECT calculate_group_rankings($1)`, [groupId]);
    } catch (error) {
      console.error('Error calculating rankings:', error);
      throw error;
    }
  }

  /**
   * 处理赛季结束
   * @param {number} seasonId
   * @returns {Promise<number>}
   */
  async processSeasonEnd(seasonId) {
    try {
      const query = `SELECT process_season_end($1) as processed`;
      const result = await dataStore.query(query, [seasonId]);
      return result.rows[0].processed;
    } catch (error) {
      console.error('Error processing season end:', error);
      throw error;
    }
  }

  /**
   * 领取赛季奖励
   * @param {number} userId
   * @param {number} seasonId
   * @returns {Promise<Object>}
   */
  async claimSeasonRewards(userId, seasonId) {
    try {
      const query = `SELECT claim_league_rewards($1, $2) as result`;
      const result = await dataStore.query(query, [userId, seasonId]);

      const claimResult = result.rows[0].result;

      if (!claimResult.success) {
        const errorMessages = {
          'HISTORY_NOT_FOUND': '未找到赛季记录',
          'ALREADY_CLAIMED': '奖励已领取'
        };
        throw new Error(errorMessages[claimResult.error] || claimResult.error);
      }

      return {
        success: true,
        rewards: {
          xp: claimResult.xp,
          coins: claimResult.coins,
          gems: claimResult.gems,
          badge: claimResult.badge
        }
      };
    } catch (error) {
      console.error('Error claiming rewards:', error);
      throw error;
    }
  }

  /**
   * 获取用户联赛历史
   * @param {number} userId
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getUserLeagueHistory(userId, limit = 10) {
    const query = `
      SELECT
        lh.*,
        lt.tier_key,
        lt.tier_name,
        lt.tier_name_en,
        lt.color_code,
        ls.season_name,
        ls.season_year,
        ls.season_week
      FROM league_history lh
      JOIN league_tiers lt ON lh.tier_id = lt.id
      JOIN league_seasons ls ON lh.season_id = ls.id
      WHERE lh.user_id = $1
      ORDER BY lh.finished_at DESC
      LIMIT $2
    `;
    const result = await dataStore.query(query, [userId, limit]);

    return result.rows.map(row => ({
      seasonId: row.season_id,
      seasonName: row.season_name,
      seasonYear: row.season_year,
      seasonWeek: row.season_week,
      tier: {
        key: row.tier_key,
        name: row.tier_name,
        nameEn: row.tier_name_en,
        colorCode: row.color_code
      },
      finalRank: row.final_rank,
      finalXp: row.final_xp,
      participantsCount: row.participants_count,
      wasPromoted: row.was_promoted,
      wasDemoted: row.was_demoted,
      rewards: {
        xp: row.xp_reward,
        coins: row.coins_reward,
        gems: row.gems_reward,
        badge: row.badge_earned
      },
      rewardsClaimed: row.rewards_claimed,
      finishedAt: row.finished_at
    }));
  }

  /**
   * 获取未领取的奖励
   * @param {number} userId
   * @returns {Promise<Array>}
   */
  async getUnclaimedRewards(userId) {
    const query = `
      SELECT
        lh.*,
        lt.tier_name,
        ls.season_name
      FROM league_history lh
      JOIN league_tiers lt ON lh.tier_id = lt.id
      JOIN league_seasons ls ON lh.season_id = ls.id
      WHERE lh.user_id = $1
        AND lh.rewards_claimed = FALSE
        AND (lh.xp_reward > 0 OR lh.coins_reward > 0 OR lh.gems_reward > 0)
      ORDER BY lh.finished_at DESC
    `;
    const result = await dataStore.query(query, [userId]);
    return result.rows;
  }

  /**
   * 获取段位奖励配置
   * @param {number} tierId
   * @returns {Promise<Array>}
   */
  async getTierRewards(tierId) {
    const query = `
      SELECT *
      FROM league_tier_rewards
      WHERE tier_id = $1 AND is_active = TRUE
      ORDER BY rank_start ASC
    `;
    const result = await dataStore.query(query, [tierId]);
    return result.rows;
  }

  /**
   * 获取全服段位分布
   * @returns {Promise<Object>}
   */
  async getTierDistribution() {
    const query = `
      SELECT
        lt.tier_key,
        lt.tier_name,
        lt.color_code,
        COUNT(u.id) as user_count
      FROM league_tiers lt
      LEFT JOIN users u ON u.current_tier_id = lt.id AND u.status = 'active'
      WHERE lt.is_active = TRUE
      GROUP BY lt.id, lt.tier_key, lt.tier_name, lt.color_code, lt.tier_order
      ORDER BY lt.tier_order ASC
    `;
    const result = await dataStore.query(query);

    const total = result.rows.reduce((sum, row) => sum + parseInt(row.user_count || 0), 0);

    return {
      total: total,
      distribution: result.rows.map(row => ({
        tierKey: row.tier_key,
        tierName: row.tier_name,
        colorCode: row.color_code,
        userCount: parseInt(row.user_count || 0),
        percentage: total > 0 ? ((parseInt(row.user_count || 0) / total) * 100).toFixed(1) : 0
      }))
    };
  }

  /**
   * 计算所有活跃组的排名（定时任务使用）
   * @returns {Promise<number>}
   */
  async calculateAllRankings() {
    try {
      const season = await this.getCurrentSeason();

      const groupsQuery = `
        SELECT id FROM league_groups WHERE season_id = $1
      `;
      const groups = await dataStore.query(groupsQuery, [season.id]);

      let processed = 0;
      for (const group of groups.rows) {
        await this.calculateRankings(group.id);
        processed++;
      }

      return processed;
    } catch (error) {
      console.error('Error calculating all rankings:', error);
      throw error;
    }
  }

  /**
   * 检查是否需要创建新赛季
   * @returns {Promise<boolean>}
   */
  async checkAndCreateNewSeason() {
    try {
      const currentQuery = `
        SELECT * FROM league_seasons
        WHERE is_active = TRUE
        LIMIT 1
      `;
      const current = await dataStore.query(currentQuery);

      if (current.rows.length > 0) {
        const season = current.rows[0];
        const endDate = new Date(season.end_date);

        if (new Date() >= endDate) {
          // End current season
          await this.processSeasonEnd(season.id);
          // Create new season
          await this.getCurrentSeason();
          return true;
        }
      } else {
        // No active season, create one
        await this.getCurrentSeason();
        return true;
      }

      return false;
    } catch (error) {
      console.error('Error checking season:', error);
      throw error;
    }
  }
}

module.exports = new LeagueService();
