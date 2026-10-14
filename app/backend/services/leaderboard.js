/**
 * Leaderboard Service
 * 排行榜服务
 *
 * 功能：
 * 1. 更新排行榜数据
 * 2. 获取全球排行榜
 * 3. 获取好友排行榜
 * 4. 获取小组排行榜
 * 5. 计算用户排名
 */

const dataStore = require('../data-store');

class LeaderboardService {

  /**
   * 更新全局排行榜（定时任务调用）
   */
  async updateGlobalLeaderboards() {
    try {
      // 获取所有激活的排行榜配置
      const query = `SELECT * FROM leaderboards WHERE is_active = TRUE`;
      const result = await dataStore.query(query);

      for (const leaderboard of result.rows) {
        await this.updateLeaderboard(leaderboard);
      }

      console.log(`Updated ${result.rows.length} leaderboards`);
      return true;
    } catch (error) {
      console.error('Error updating leaderboards:', error);
      return false;
    }
  }

  /**
   * 更新单个排行榜
   */
  async updateLeaderboard(leaderboard) {
    const { id, name, metric, time_range, max_entries } = leaderboard;

    // 构建查询SQL
    let dataQuery = '';

    switch (metric) {
      case 'total_xp':
        dataQuery = this.buildXPQuery(time_range);
        break;
      case 'study_minutes':
        dataQuery = this.buildStudyMinutesQuery(time_range);
        break;
      case 'words_learned':
        dataQuery = this.buildWordsLearnedQuery(time_range);
        break;
      case 'streak_days':
        dataQuery = this.buildStreakQuery(time_range);
        break;
      case 'accuracy':
        dataQuery = this.buildAccuracyQuery(time_range);
        break;
      default:
        console.warn(`Unknown metric: ${metric}`);
        return;
    }

    if (!dataQuery) return;

    // 执行查询获取排行数据
    const result = await dataStore.query(dataQuery, [max_entries]);
    const rankings = result.rows;

    // 获取之前的排名用于计算变化
    const prevRankingsQuery = `
      SELECT user_id, rank
      FROM leaderboard_entries
      WHERE leaderboard_id = $1
        AND valid_to IS NULL
    `;
    const prevResult = await dataStore.query(prevRankingsQuery, [id]);
    const prevRankMap = new Map(prevResult.rows.map(r => [r.user_id, r.rank]));

    // 结束旧的排行榜条目
    await dataStore.query(`
      UPDATE leaderboard_entries
      SET valid_to = CURRENT_TIMESTAMP
      WHERE leaderboard_id = $1 AND valid_to IS NULL
    `, [id]);

    // 插入新的排行榜条目
    for (let i = 0; i < rankings.length; i++) {
      const ranking = rankings[i];
      const currentRank = i + 1;
      const prevRank = prevRankMap.get(ranking.user_id);
      const rankChange = prevRank ? prevRank - currentRank : 0;

      await dataStore.query(`
        INSERT INTO leaderboard_entries (
          leaderboard_id, user_id, rank, score, rank_change, display_data
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        id,
        ranking.user_id,
        currentRank,
        ranking.score,
        rankChange,
        JSON.stringify({
          username: ranking.username,
          level: ranking.level,
          avatar_url: ranking.avatar_url
        })
      ]);
    }
  }

  /**
   * 构建XP查询
   */
  buildXPQuery(timeRange) {
    const whereClause = this.getTimeRangeWhereClause(timeRange);
    return `
      SELECT
        uls.user_id,
        u.username,
        u.level,
        NULL AS avatar_url,
        SUM(uls.xp_gained) AS score
      FROM user_learning_stats uls
      JOIN users u ON uls.user_id = u.id
      WHERE u.status = 'active' ${whereClause}
      GROUP BY uls.user_id, u.username, u.level
      HAVING SUM(uls.xp_gained) > 0
      ORDER BY score DESC
      LIMIT $1
    `;
  }

  /**
   * 构建学习时长查询
   */
  buildStudyMinutesQuery(timeRange) {
    const whereClause = this.getTimeRangeWhereClause(timeRange);
    return `
      SELECT
        uls.user_id,
        u.username,
        u.level,
        NULL AS avatar_url,
        SUM(uls.total_study_minutes) AS score
      FROM user_learning_stats uls
      JOIN users u ON uls.user_id = u.id
      WHERE u.status = 'active' ${whereClause}
      GROUP BY uls.user_id, u.username, u.level
      HAVING SUM(uls.total_study_minutes) > 0
      ORDER BY score DESC
      LIMIT $1
    `;
  }

  /**
   * 构建词汇量查询
   */
  buildWordsLearnedQuery(timeRange) {
    const whereClause = this.getTimeRangeWhereClause(timeRange);
    return `
      SELECT
        uls.user_id,
        u.username,
        u.level,
        NULL AS avatar_url,
        SUM(uls.words_learned) AS score
      FROM user_learning_stats uls
      JOIN users u ON uls.user_id = u.id
      WHERE u.status = 'active' ${whereClause}
      GROUP BY uls.user_id, u.username, u.level
      HAVING SUM(uls.words_learned) > 0
      ORDER BY score DESC
      LIMIT $1
    `;
  }

  /**
   * 构建连胜查询
   */
  buildStreakQuery(timeRange) {
    // 连胜一般是all_time
    return `
      SELECT
        uls.user_id,
        u.username,
        u.level,
        NULL AS avatar_url,
        MAX(uls.streak_days) AS score
      FROM user_learning_stats uls
      JOIN users u ON uls.user_id = u.id
      WHERE u.status = 'active'
      GROUP BY uls.user_id, u.username, u.level
      HAVING MAX(uls.streak_days) > 0
      ORDER BY score DESC
      LIMIT $1
    `;
  }

  /**
   * 构建发音准确度查询
   * @param {string} timeRange - 时间范围
   * @returns {string} SQL查询
   */
  buildAccuracyQuery(timeRange) {
    const whereClause = this.getAccuracyTimeRangeWhereClause(timeRange);
    return `
      SELECT
        p.user_id,
        u.username,
        u.level,
        NULL AS avatar_url,
        ROUND(AVG(p.accuracy)::numeric, 1) AS score,
        COUNT(p.id) AS practice_count
      FROM user_pronunciation_assessments p
      JOIN users u ON p.user_id = u.id
      WHERE u.status = 'active' ${whereClause}
      GROUP BY p.user_id, u.username, u.level
      HAVING COUNT(p.id) >= 5
      ORDER BY score DESC, practice_count DESC
      LIMIT $1
    `;
  }

  /**
   * 获取准确度时间范围WHERE子句
   * @param {string} timeRange - 时间范围
   * @returns {string} WHERE子句
   */
  getAccuracyTimeRangeWhereClause(timeRange) {
    switch (timeRange) {
      case 'daily':
        return `AND p.created_at >= CURRENT_DATE`;
      case 'weekly':
        return `AND p.created_at >= date_trunc('week', CURRENT_DATE)`;
      case 'monthly':
        return `AND p.created_at >= date_trunc('month', CURRENT_DATE)`;
      case 'all_time':
      default:
        return '';
    }
  }

  /**
   * 获取时间范围WHERE子句
   */
  getTimeRangeWhereClause(timeRange) {
    switch (timeRange) {
      case 'daily':
        return `AND uls.stat_date = CURRENT_DATE`;
      case 'weekly':
        return `AND uls.stat_date >= CURRENT_DATE - INTERVAL '7 days'`;
      case 'monthly':
        return `AND uls.stat_date >= CURRENT_DATE - INTERVAL '30 days'`;
      case 'all_time':
      default:
        return '';
    }
  }

  /**
   * 获取排行榜
   */
  async getLeaderboard(leaderboardName, limit = 50) {
    const query = `
      SELECT
        le.rank,
        le.score,
        le.rank_change,
        le.display_data,
        u.username,
        u.level
      FROM leaderboard_entries le
      JOIN leaderboards lb ON le.leaderboard_id = lb.id
      JOIN users u ON le.user_id = u.id
      WHERE lb.name = $1
        AND le.valid_to IS NULL
      ORDER BY le.rank ASC
      LIMIT $2
    `;

    const result = await dataStore.query(query, [leaderboardName, limit]);
    return result.rows.map(row => ({
      rank: row.rank,
      username: row.username,
      level: row.level,
      score: parseFloat(row.score),
      rank_change: row.rank_change,
      ...JSON.parse(row.display_data || '{}')
    }));
  }

  /**
   * 获取用户在排行榜中的排名
   */
  async getUserRank(userId, leaderboardName) {
    const query = `
      SELECT
        le.rank,
        le.score,
        le.rank_change,
        (SELECT COUNT(*) FROM leaderboard_entries le2
         WHERE le2.leaderboard_id = le.leaderboard_id
           AND le2.valid_to IS NULL) AS total_users
      FROM leaderboard_entries le
      JOIN leaderboards lb ON le.leaderboard_id = lb.id
      WHERE lb.name = $1
        AND le.user_id = $2
        AND le.valid_to IS NULL
    `;

    const result = await dataStore.query(query, [leaderboardName, userId]);
    return result.rows[0] || null;
  }

  /**
   * 获取好友排行榜
   */
  async getFriendsLeaderboard(userId, metric = 'total_xp', limit = 20) {
    // 获取用户的好友列表
    const friendsQuery = `
      SELECT friend_id
      FROM user_friendships
      WHERE user_id = $1 AND status = 'accepted'
      UNION
      SELECT user_id
      FROM user_friendships
      WHERE friend_id = $1 AND status = 'accepted'
    `;
    const friendsResult = await dataStore.query(friendsQuery, [userId]);
    const friendIds = friendsResult.rows.map(r => r.friend_id);

    // 包含自己
    friendIds.push(userId);

    if (friendIds.length === 0) {
      return [];
    }

    // 构建排行查询
    let scoreColumn = '';
    let orderBy = 'score DESC';

    switch (metric) {
      case 'total_xp':
        scoreColumn = 'SUM(uls.xp_gained)';
        break;
      case 'study_minutes':
        scoreColumn = 'SUM(uls.total_study_minutes)';
        break;
      case 'words_learned':
        scoreColumn = 'SUM(uls.words_learned)';
        break;
      case 'streak_days':
        scoreColumn = 'MAX(uls.streak_days)';
        break;
      default:
        scoreColumn = 'SUM(uls.xp_gained)';
    }

    const query = `
      SELECT
        u.id AS user_id,
        u.username,
        u.level,
        ${scoreColumn} AS score,
        ROW_NUMBER() OVER (ORDER BY ${scoreColumn} DESC) AS rank
      FROM users u
      LEFT JOIN user_learning_stats uls ON u.id = uls.user_id
      WHERE u.id = ANY($1::bigint[])
        AND u.status = 'active'
      GROUP BY u.id, u.username, u.level
      ORDER BY ${orderBy}
      LIMIT $2
    `;

    const result = await dataStore.query(query, [friendIds, limit]);
    return result.rows.map(row => ({
      ...row,
      is_current_user: row.user_id === userId,
      score: parseFloat(row.score || 0)
    }));
  }

  /**
   * 获取小组排行榜
   */
  async getGroupLeaderboard(groupId, metric = 'contribution_xp', limit = 50) {
    let scoreColumn = 'sgm.contribution_xp';
    let orderBy = 'score DESC';

    switch (metric) {
      case 'contribution_xp':
        scoreColumn = 'sgm.contribution_xp';
        break;
      case 'study_minutes':
        scoreColumn = 'sgm.study_minutes';
        break;
      case 'active_days':
        scoreColumn = 'sgm.active_days';
        break;
    }

    const query = `
      SELECT
        sgm.user_id,
        u.username,
        u.level,
        ${scoreColumn} AS score,
        sgm.role,
        sgm.joined_at,
        ROW_NUMBER() OVER (ORDER BY ${scoreColumn} DESC) AS rank
      FROM study_group_members sgm
      JOIN users u ON sgm.user_id = u.id
      WHERE sgm.group_id = $1
        AND sgm.status = 'active'
      ORDER BY ${orderBy}
      LIMIT $2
    `;

    const result = await dataStore.query(query, [groupId, limit]);
    return result.rows.map(row => ({
      ...row,
      score: parseFloat(row.score || 0)
    }));
  }

  /**
   * 获取用户的所有排名
   */
  async getUserAllRankings(userId) {
    const query = `
      SELECT
        lb.name,
        lb.display_name,
        le.rank,
        le.score,
        le.rank_change,
        lb.metric,
        lb.time_range
      FROM leaderboard_entries le
      JOIN leaderboards lb ON le.leaderboard_id = lb.id
      WHERE le.user_id = $1
        AND le.valid_to IS NULL
        AND lb.is_active = TRUE
      ORDER BY le.rank ASC
    `;

    const result = await dataStore.query(query, [userId]);
    return result.rows.map(row => ({
      leaderboard_name: row.name,
      leaderboard_title: row.display_name,
      rank: row.rank,
      score: parseFloat(row.score),
      rank_change: row.rank_change,
      metric: row.metric,
      time_range: row.time_range
    }));
  }

  /**
   * 获取排名周围的用户（显示自己和前后N名）
   */
  async getLeaderboardContext(leaderboardName, userId, contextSize = 3) {
    // 先获取用户当前排名
    const userRank = await this.getUserRank(userId, leaderboardName);

    if (!userRank) {
      return { user_rank: null, context: [] };
    }

    const startRank = Math.max(1, userRank.rank - contextSize);
    const endRank = userRank.rank + contextSize;

    const query = `
      SELECT
        le.rank,
        le.score,
        le.rank_change,
        le.display_data,
        u.id AS user_id,
        u.username,
        u.level
      FROM leaderboard_entries le
      JOIN leaderboards lb ON le.leaderboard_id = lb.id
      JOIN users u ON le.user_id = u.id
      WHERE lb.name = $1
        AND le.valid_to IS NULL
        AND le.rank >= $2
        AND le.rank <= $3
      ORDER BY le.rank ASC
    `;

    const result = await dataStore.query(query, [leaderboardName, startRank, endRank]);

    return {
      user_rank: userRank,
      context: result.rows.map(row => ({
        ...row,
        is_current_user: row.user_id === userId,
        score: parseFloat(row.score),
        ...JSON.parse(row.display_data || '{}')
      }))
    };
  }
}

module.exports = new LeaderboardService();
