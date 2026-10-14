/**
 * Friend Challenge Service
 * 好友挑战服务
 *
 * 功能：
 * 1. 创建挑战
 * 2. 接受/拒绝挑战
 * 3. 更新进度
 * 4. 结算挑战
 * 5. 历史记录
 */

const dataStore = require('../data-store');

class FriendChallengeService {

  /**
   * 挑战类型配置
   */
  challengeTypes = {
    'weekly_xp': {
      name: '周XP挑战',
      nameEn: 'Weekly XP Challenge',
      description: '比较一周内获得的XP',
      defaultDuration: 7,
      scoreField: 'xp_gained',
      statsTable: 'user_learning_stats'
    },
    'daily_xp': {
      name: '日XP挑战',
      nameEn: 'Daily XP Challenge',
      description: '比较一天内获得的XP',
      defaultDuration: 1,
      scoreField: 'xp_gained',
      statsTable: 'user_learning_stats'
    },
    'weekly_time': {
      name: '周学习时长挑战',
      nameEn: 'Weekly Study Time Challenge',
      description: '比较一周内的学习时长',
      defaultDuration: 7,
      scoreField: 'total_study_minutes',
      statsTable: 'user_learning_stats'
    },
    'vocab_count': {
      name: '词汇量挑战',
      nameEn: 'Vocabulary Challenge',
      description: '比较学习的单词数量',
      defaultDuration: 7,
      scoreField: 'words_learned',
      statsTable: 'user_learning_stats'
    }
  };

  /**
   * 创建挑战
   * @param {number} challengerId - 发起者ID
   * @param {number} challengedId - 被挑战者ID
   * @param {string} challengeType - 挑战类型
   * @param {number} durationDays - 持续天数
   * @param {string} message - 挑战消息
   * @returns {Promise<Object>}
   */
  async createChallenge(challengerId, challengedId, challengeType, durationDays = 7, message = '') {
    try {
      // 验证挑战类型
      if (!this.challengeTypes[challengeType]) {
        throw new Error('INVALID_CHALLENGE_TYPE');
      }

      // 不能挑战自己
      if (challengerId === challengedId) {
        throw new Error('CANNOT_CHALLENGE_SELF');
      }

      // 检查是否已有进行中的挑战
      const existingQuery = `
        SELECT id FROM friend_challenges
        WHERE ((challenger_id = $1 AND challenged_id = $2)
           OR (challenger_id = $2 AND challenged_id = $1))
          AND status IN ('pending', 'active')
      `;
      const existing = await dataStore.query(existingQuery, [challengerId, challengedId]);

      if (existing.rows.length > 0) {
        throw new Error('CHALLENGE_ALREADY_EXISTS');
      }

      // 创建挑战
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + durationDays);

      const insertQuery = `
        INSERT INTO friend_challenges (
          challenger_id, challenged_id, challenge_type,
          duration_days, end_date, message, reward_xp, reward_coins
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `;
      const result = await dataStore.query(insertQuery, [
        challengerId,
        challengedId,
        challengeType,
        durationDays,
        endDate,
        message,
        100, // 默认奖励XP
        50   // 默认奖励金币
      ]);

      return this.formatChallenge(result.rows[0]);
    } catch (error) {
      console.error('Error creating challenge:', error);
      throw error;
    }
  }

  /**
   * 接受挑战
   * @param {number} challengeId
   * @param {number} userId
   * @returns {Promise<Object>}
   */
  async acceptChallenge(challengeId, userId) {
    try {
      const query = `
        UPDATE friend_challenges
        SET status = 'active',
            start_date = NOW(),
            end_date = NOW() + (duration_days || ' days')::INTERVAL,
            updated_at = NOW()
        WHERE id = $1
          AND challenged_id = $2
          AND status = 'pending'
        RETURNING *
      `;
      const result = await dataStore.query(query, [challengeId, userId]);

      if (result.rows.length === 0) {
        throw new Error('CHALLENGE_NOT_FOUND_OR_CANNOT_ACCEPT');
      }

      return this.formatChallenge(result.rows[0]);
    } catch (error) {
      console.error('Error accepting challenge:', error);
      throw error;
    }
  }

  /**
   * 拒绝挑战
   * @param {number} challengeId
   * @param {number} userId
   * @returns {Promise<boolean>}
   */
  async declineChallenge(challengeId, userId) {
    try {
      const query = `
        UPDATE friend_challenges
        SET status = 'declined', updated_at = NOW()
        WHERE id = $1
          AND challenged_id = $2
          AND status = 'pending'
        RETURNING id
      `;
      const result = await dataStore.query(query, [challengeId, userId]);
      return result.rows.length > 0;
    } catch (error) {
      console.error('Error declining challenge:', error);
      throw error;
    }
  }

  /**
   * 取消挑战
   * @param {number} challengeId
   * @param {number} userId
   * @returns {Promise<boolean>}
   */
  async cancelChallenge(challengeId, userId) {
    try {
      const query = `
        UPDATE friend_challenges
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1
          AND challenger_id = $2
          AND status IN ('pending', 'active')
        RETURNING id
      `;
      const result = await dataStore.query(query, [challengeId, userId]);
      return result.rows.length > 0;
    } catch (error) {
      console.error('Error cancelling challenge:', error);
      throw error;
    }
  }

  /**
   * 更新挑战进度
   * @param {number} challengeId
   * @returns {Promise<Object>}
   */
  async updateChallengeProgress(challengeId) {
    try {
      // 获取挑战详情
      const challengeQuery = `
        SELECT * FROM friend_challenges WHERE id = $1 AND status = 'active'
      `;
      const challengeResult = await dataStore.query(challengeQuery, [challengeId]);

      if (challengeResult.rows.length === 0) {
        throw new Error('CHALLENGE_NOT_FOUND');
      }

      const challenge = challengeResult.rows[0];
      const config = this.challengeTypes[challenge.challenge_type];

      if (!config) {
        throw new Error('INVALID_CHALLENGE_TYPE');
      }

      // 计算双方得分
      const scoreQuery = `
        SELECT COALESCE(SUM(${config.scoreField}), 0) as score
        FROM ${config.statsTable}
        WHERE user_id = $1
          AND stat_date >= $2::date
          AND stat_date <= CURRENT_DATE
      `;

      const challengerScore = await dataStore.query(scoreQuery, [
        challenge.challenger_id,
        challenge.start_date
      ]);

      const challengedScore = await dataStore.query(scoreQuery, [
        challenge.challenged_id,
        challenge.start_date
      ]);

      // 更新得分
      const updateQuery = `
        UPDATE friend_challenges
        SET challenger_score = $1,
            challenged_score = $2,
            updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `;
      const result = await dataStore.query(updateQuery, [
        parseInt(challengerScore.rows[0].score),
        parseInt(challengedScore.rows[0].score),
        challengeId
      ]);

      return this.formatChallenge(result.rows[0]);
    } catch (error) {
      console.error('Error updating challenge progress:', error);
      throw error;
    }
  }

  /**
   * 完成挑战（定时任务调用）
   * @param {number} challengeId
   * @returns {Promise<Object>}
   */
  async completeChallenge(challengeId) {
    try {
      // 先更新最终得分
      const challenge = await this.updateChallengeProgress(challengeId);

      // 确定赢家
      let winnerId = null;
      if (challenge.challengerScore > challenge.challengedScore) {
        winnerId = challenge.challengerId;
      } else if (challenge.challengedScore > challenge.challengerScore) {
        winnerId = challenge.challengedId;
      }
      // 平局时 winnerId 保持 null

      // 更新挑战状态
      const updateQuery = `
        UPDATE friend_challenges
        SET status = 'completed',
            winner_id = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `;
      const result = await dataStore.query(updateQuery, [winnerId, challengeId]);

      // 发放奖励给赢家
      if (winnerId) {
        await dataStore.query(`
          UPDATE users
          SET xp = xp + $1, coins = coins + $2
          WHERE id = $3
        `, [challenge.rewardXp, challenge.rewardCoins, winnerId]);
      }

      return this.formatChallenge(result.rows[0]);
    } catch (error) {
      console.error('Error completing challenge:', error);
      throw error;
    }
  }

  /**
   * 获取用户的活跃挑战
   * @param {number} userId
   * @returns {Promise<Array>}
   */
  async getActiveChallenges(userId) {
    const query = `
      SELECT
        fc.*,
        u1.username AS challenger_username,
        u2.username AS challenged_username
      FROM friend_challenges fc
      JOIN users u1 ON fc.challenger_id = u1.id
      JOIN users u2 ON fc.challenged_id = u2.id
      WHERE (fc.challenger_id = $1 OR fc.challenged_id = $1)
        AND fc.status IN ('pending', 'active')
      ORDER BY fc.created_at DESC
    `;
    const result = await dataStore.query(query, [userId]);
    return result.rows.map(row => this.formatChallenge(row));
  }

  /**
   * 获取挑战历史
   * @param {number} userId
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async getChallengeHistory(userId, limit = 20) {
    const query = `
      SELECT
        fc.*,
        u1.username AS challenger_username,
        u2.username AS challenged_username,
        uw.username AS winner_username
      FROM friend_challenges fc
      JOIN users u1 ON fc.challenger_id = u1.id
      JOIN users u2 ON fc.challenged_id = u2.id
      LEFT JOIN users uw ON fc.winner_id = uw.id
      WHERE (fc.challenger_id = $1 OR fc.challenged_id = $1)
        AND fc.status = 'completed'
      ORDER BY fc.updated_at DESC
      LIMIT $2
    `;
    const result = await dataStore.query(query, [userId, limit]);
    return result.rows.map(row => this.formatChallenge(row));
  }

  /**
   * 获取挑战详情
   * @param {number} challengeId
   * @param {number} userId
   * @returns {Promise<Object>}
   */
  async getChallengeDetail(challengeId, userId) {
    const query = `
      SELECT
        fc.*,
        u1.username AS challenger_username,
        u1.level AS challenger_level,
        u2.username AS challenged_username,
        u2.level AS challenged_level
      FROM friend_challenges fc
      JOIN users u1 ON fc.challenger_id = u1.id
      JOIN users u2 ON fc.challenged_id = u2.id
      WHERE fc.id = $1
        AND (fc.challenger_id = $2 OR fc.challenged_id = $2)
    `;
    const result = await dataStore.query(query, [challengeId, userId]);

    if (result.rows.length === 0) {
      throw new Error('CHALLENGE_NOT_FOUND');
    }

    return this.formatChallenge(result.rows[0]);
  }

  /**
   * 获取待处理的挑战请求
   * @param {number} userId
   * @returns {Promise<Array>}
   */
  async getPendingChallenges(userId) {
    const query = `
      SELECT
        fc.*,
        u.username AS challenger_username,
        u.level AS challenger_level
      FROM friend_challenges fc
      JOIN users u ON fc.challenger_id = u.id
      WHERE fc.challenged_id = $1
        AND fc.status = 'pending'
      ORDER BY fc.created_at DESC
    `;
    const result = await dataStore.query(query, [userId]);
    return result.rows.map(row => this.formatChallenge(row));
  }

  /**
   * 获取需要结算的挑战（定时任务用）
   * @returns {Promise<Array>}
   */
  async getChallengesNeedingCompletion() {
    const query = `
      SELECT id
      FROM friend_challenges
      WHERE status = 'active'
        AND end_date <= NOW()
    `;
    const result = await dataStore.query(query);
    return result.rows.map(row => row.id);
  }

  /**
   * 处理所有到期挑战
   * @returns {Promise<number>}
   */
  async processExpiredChallenges() {
    const challengeIds = await this.getChallengesNeedingCompletion();
    let processed = 0;

    for (const id of challengeIds) {
      try {
        await this.completeChallenge(id);
        processed++;
      } catch (error) {
        console.error(`Error completing challenge ${id}:`, error);
      }
    }

    return processed;
  }

  /**
   * 格式化挑战数据
   */
  formatChallenge(row) {
    const config = this.challengeTypes[row.challenge_type] || {};

    return {
      id: row.id,
      challengerId: row.challenger_id,
      challengerUsername: row.challenger_username,
      challengerLevel: row.challenger_level,
      challengerScore: row.challenger_score,
      challengedId: row.challenged_id,
      challengedUsername: row.challenged_username,
      challengedLevel: row.challenged_level,
      challengedScore: row.challenged_score,
      challengeType: row.challenge_type,
      challengeTypeName: config.name,
      challengeTypeNameEn: config.nameEn,
      targetValue: row.target_value,
      durationDays: row.duration_days,
      startDate: row.start_date,
      endDate: row.end_date,
      winnerId: row.winner_id,
      winnerUsername: row.winner_username,
      status: row.status,
      rewardXp: row.reward_xp,
      rewardCoins: row.reward_coins,
      message: row.message,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

module.exports = new FriendChallengeService();
