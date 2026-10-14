/**
 * Learning Statistics Service
 * 学习统计数据收集和计算服务
 *
 * 功能：
 * 1. 实时收集用户学习数据
 * 2. 更新每日/周/月统计
 * 3. 计算技能进度分数
 * 4. 追踪学习连胜
 */

const dataStore = require('../data-store');

class LearningStatsService {

  /**
   * 记录学习活动
   * @param {number} userId - 用户ID
   * @param {Object} activity - 活动数据
   * @returns {Promise<boolean>}
   */
  async recordActivity(userId, activity) {
    const {
      activityType,  // 'training', 'reading', 'video', 'vocabulary'
      durationMinutes = 0,
      metadata = {}
    } = activity;

    try {
      const today = new Date().toISOString().split('T')[0];

      // 1. 更新每日活跃记录
      await this.updateDailyActivity(userId, today, durationMinutes);

      // 2. 更新每日统计
      await this.updateDailyStats(userId, today, activityType, durationMinutes, metadata);

      // 3. 更新技能进度
      await this.updateSkillProgress(userId, activityType, metadata);

      // 4. 检查并更新连胜
      await this.updateStreak(userId, today);

      return true;
    } catch (error) {
      console.error('Error recording activity:', error);
      return false;
    }
  }

  /**
   * 更新每日活跃记录
   */
  async updateDailyActivity(userId, date, minutes) {
    const query = `
      INSERT INTO user_daily_activity (user_id, activity_date, study_minutes, first_activity_at, last_activity_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, activity_date)
      DO UPDATE SET
        study_minutes = user_daily_activity.study_minutes + $3,
        last_activity_at = CURRENT_TIMESTAMP
    `;
    await dataStore.query(query, [userId, date, minutes]);
  }

  /**
   * 更新每日统计
   */
  async updateDailyStats(userId, date, activityType, minutes, metadata) {
    // 构建更新字段
    const updates = {
      total_study_minutes: minutes
    };

    switch (activityType) {
      case 'shadowing':
      case 'dictogloss':
      case 'timer_432':
      case 'pronunciation':
        updates.training_minutes = minutes;
        updates[`${activityType}_count`] = 1;
        if (metadata.sentences_practiced) {
          updates.sentences_practiced = metadata.sentences_practiced;
        }
        break;

      case 'reading':
        updates.reading_minutes = minutes;
        if (metadata.articles_read) {
          updates.articles_read = metadata.articles_read;
        }
        break;

      case 'video':
        updates.video_minutes = minutes;
        if (metadata.videos_watched) {
          updates.videos_watched = metadata.videos_watched;
        }
        break;

      case 'vocabulary':
        if (metadata.words_learned) {
          updates.words_learned = metadata.words_learned;
        }
        if (metadata.words_reviewed) {
          updates.words_reviewed = metadata.words_reviewed;
        }
        if (metadata.review_accuracy) {
          updates.vocab_accuracy = metadata.review_accuracy;
        }
        break;
    }

    // 构建SQL语句
    const setClause = Object.keys(updates).map((key, idx) => {
      if (key === 'vocab_accuracy') {
        // 对于准确率，计算平均值
        return `${key} = COALESCE(${key}, 0) + $${idx + 4}`;
      }
      return `${key} = COALESCE(${key}, 0) + $${idx + 4}`;
    }).join(', ');

    const values = [userId, date, 'daily', ...Object.values(updates)];

    const query = `
      INSERT INTO user_learning_stats (user_id, stat_date, stat_type, ${Object.keys(updates).join(', ')})
      VALUES ($1, $2, $3, ${Object.keys(updates).map((_, idx) => `$${idx + 4}`).join(', ')})
      ON CONFLICT (user_id, stat_date, stat_type)
      DO UPDATE SET ${setClause}
    `;

    await dataStore.query(query, values);
  }

  /**
   * 更新技能进度
   */
  async updateSkillProgress(userId, activityType, metadata) {
    const skillMapping = {
      'shadowing': 'speaking',
      'dictogloss': 'listening',
      'pronunciation': 'speaking',
      'reading': 'reading',
      'vocabulary': 'vocabulary',
      'video': 'listening'
    };

    const skillType = skillMapping[activityType];
    if (!skillType) return;

    // 计算技能分数增长（简化版，后续可以接入AI评分）
    let scoreIncrease = 0.5; // 基础增长
    if (metadata.ai_score) {
      // 如果有AI评分，根据评分调整增长
      const gradeMap = { 'A': 2, 'B': 1.5, 'C': 1, 'D': 0.5 };
      scoreIncrease = gradeMap[metadata.ai_score] || 0.5;
    }

    const query = `
      INSERT INTO skill_progress (user_id, skill_type, current_score, practice_count, total_practice_time, last_practiced_at)
      VALUES ($1, $2, $3, 1, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, skill_type)
      DO UPDATE SET
        current_score = LEAST(skill_progress.current_score + $3, 100),
        practice_count = skill_progress.practice_count + 1,
        total_practice_time = skill_progress.total_practice_time + $4,
        last_practiced_at = CURRENT_TIMESTAMP,
        best_score = GREATEST(skill_progress.best_score, LEAST(skill_progress.current_score + $3, 100)),
        best_score_date = CASE
          WHEN GREATEST(skill_progress.best_score, LEAST(skill_progress.current_score + $3, 100)) > skill_progress.best_score
          THEN CURRENT_DATE
          ELSE skill_progress.best_score_date
        END
    `;

    await dataStore.query(query, [userId, skillType, scoreIncrease, metadata.duration_minutes || 0]);
  }

  /**
   * 更新学习连胜
   */
  async updateStreak(userId, today) {
    // 获取用户最近的活跃记录
    const query = `
      SELECT activity_date
      FROM user_daily_activity
      WHERE user_id = $1 AND activity_date >= (CURRENT_DATE - INTERVAL '7 days')
      ORDER BY activity_date DESC
    `;
    const result = await dataStore.query(query, [userId]);

    if (result.rows.length === 0) {
      return; // 没有活动记录
    }

    // 计算连续天数
    let streak = 1;
    const dates = result.rows.map(r => new Date(r.activity_date));

    for (let i = 0; i < dates.length - 1; i++) {
      const daysDiff = Math.floor((dates[i] - dates[i + 1]) / (1000 * 60 * 60 * 24));
      if (daysDiff === 1) {
        streak++;
      } else {
        break;
      }
    }

    // 更新今日统计中的连胜天数
    const updateQuery = `
      UPDATE user_learning_stats
      SET streak_days = $1
      WHERE user_id = $2 AND stat_date = $3 AND stat_type = 'daily'
    `;
    await dataStore.query(updateQuery, [streak, userId, today]);
  }

  /**
   * 生成周统计（聚合本周每日数据）
   */
  async generateWeeklyStats(userId, weekStartDate) {
    const query = `
      INSERT INTO user_learning_stats (
        user_id, stat_date, stat_type,
        total_study_minutes, training_minutes, reading_minutes, video_minutes,
        shadowing_count, dictogloss_count, timer_432_count, pronunciation_count,
        words_learned, words_reviewed, vocab_accuracy,
        articles_read, videos_watched, sentences_practiced,
        xp_gained, coins_earned, streak_days
      )
      SELECT
        user_id,
        $2 AS stat_date,
        'weekly' AS stat_type,
        SUM(total_study_minutes),
        SUM(training_minutes),
        SUM(reading_minutes),
        SUM(video_minutes),
        SUM(shadowing_count),
        SUM(dictogloss_count),
        SUM(timer_432_count),
        SUM(pronunciation_count),
        SUM(words_learned),
        SUM(words_reviewed),
        AVG(vocab_accuracy),
        SUM(articles_read),
        SUM(videos_watched),
        SUM(sentences_practiced),
        SUM(xp_gained),
        SUM(coins_earned),
        MAX(streak_days)
      FROM user_learning_stats
      WHERE user_id = $1
        AND stat_type = 'daily'
        AND stat_date >= $2
        AND stat_date < $2 + INTERVAL '7 days'
      GROUP BY user_id
      ON CONFLICT (user_id, stat_date, stat_type)
      DO UPDATE SET
        total_study_minutes = EXCLUDED.total_study_minutes,
        training_minutes = EXCLUDED.training_minutes,
        reading_minutes = EXCLUDED.reading_minutes,
        video_minutes = EXCLUDED.video_minutes,
        shadowing_count = EXCLUDED.shadowing_count,
        dictogloss_count = EXCLUDED.dictogloss_count,
        timer_432_count = EXCLUDED.timer_432_count,
        pronunciation_count = EXCLUDED.pronunciation_count,
        words_learned = EXCLUDED.words_learned,
        words_reviewed = EXCLUDED.words_reviewed,
        vocab_accuracy = EXCLUDED.vocab_accuracy,
        articles_read = EXCLUDED.articles_read,
        videos_watched = EXCLUDED.videos_watched,
        sentences_practiced = EXCLUDED.sentences_practiced,
        xp_gained = EXCLUDED.xp_gained,
        coins_earned = EXCLUDED.coins_earned,
        streak_days = EXCLUDED.streak_days,
        updated_at = CURRENT_TIMESTAMP
    `;

    await dataStore.query(query, [userId, weekStartDate]);
  }

  /**
   * 生成月统计
   */
  async generateMonthlyStats(userId, monthStartDate) {
    const query = `
      INSERT INTO user_learning_stats (
        user_id, stat_date, stat_type,
        total_study_minutes, training_minutes, reading_minutes, video_minutes,
        shadowing_count, dictogloss_count, timer_432_count, pronunciation_count,
        words_learned, words_reviewed, vocab_accuracy,
        articles_read, videos_watched, sentences_practiced,
        xp_gained, coins_earned, streak_days
      )
      SELECT
        user_id,
        $2 AS stat_date,
        'monthly' AS stat_type,
        SUM(total_study_minutes),
        SUM(training_minutes),
        SUM(reading_minutes),
        SUM(video_minutes),
        SUM(shadowing_count),
        SUM(dictogloss_count),
        SUM(timer_432_count),
        SUM(pronunciation_count),
        SUM(words_learned),
        SUM(words_reviewed),
        AVG(vocab_accuracy),
        SUM(articles_read),
        SUM(videos_watched),
        SUM(sentences_practiced),
        SUM(xp_gained),
        SUM(coins_earned),
        MAX(streak_days)
      FROM user_learning_stats
      WHERE user_id = $1
        AND stat_type = 'daily'
        AND stat_date >= $2
        AND stat_date < $2 + INTERVAL '1 month'
      GROUP BY user_id
      ON CONFLICT (user_id, stat_date, stat_type)
      DO UPDATE SET
        total_study_minutes = EXCLUDED.total_study_minutes,
        training_minutes = EXCLUDED.training_minutes,
        reading_minutes = EXCLUDED.reading_minutes,
        video_minutes = EXCLUDED.video_minutes,
        shadowing_count = EXCLUDED.shadowing_count,
        dictogloss_count = EXCLUDED.dictogloss_count,
        timer_432_count = EXCLUDED.timer_432_count,
        pronunciation_count = EXCLUDED.pronunciation_count,
        words_learned = EXCLUDED.words_learned,
        words_reviewed = EXCLUDED.words_reviewed,
        vocab_accuracy = EXCLUDED.vocab_accuracy,
        articles_read = EXCLUDED.articles_read,
        videos_watched = EXCLUDED.videos_watched,
        sentences_practiced = EXCLUDED.sentences_practiced,
        xp_gained = EXCLUDED.xp_gained,
        coins_earned = EXCLUDED.coins_earned,
        streak_days = EXCLUDED.streak_days,
        updated_at = CURRENT_TIMESTAMP
    `;

    await dataStore.query(query, [userId, monthStartDate]);
  }

  /**
   * 获取用户统计数据
   */
  async getUserStats(userId, statType = 'daily', date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];

    const query = `
      SELECT * FROM user_learning_stats
      WHERE user_id = $1 AND stat_type = $2 AND stat_date = $3
    `;

    const result = await dataStore.query(query, [userId, statType, targetDate]);
    return result.rows[0] || null;
  }

  /**
   * 获取用户技能进度
   */
  async getSkillProgress(userId) {
    const query = `
      SELECT
        skill_type,
        current_level,
        current_score,
        total_practice_time,
        practice_count,
        best_score,
        best_score_date,
        last_practiced_at
      FROM skill_progress
      WHERE user_id = $1
      ORDER BY skill_type
    `;

    const result = await dataStore.query(query, [userId]);
    return result.rows;
  }

  /**
   * 获取学习趋势（最近N天）
   */
  async getLearningTrend(userId, days = 30) {
    const query = `
      SELECT
        stat_date,
        total_study_minutes,
        words_learned,
        xp_gained,
        streak_days
      FROM user_learning_stats
      WHERE user_id = $1
        AND stat_type = 'daily'
        AND stat_date >= CURRENT_DATE - INTERVAL '${days} days'
      ORDER BY stat_date ASC
    `;

    const result = await dataStore.query(query, [userId]);
    return result.rows;
  }

  /**
   * 检查并解锁里程碑
   */
  async checkMilestones(userId) {
    // 获取用户总体数据
    const statsQuery = `
      SELECT
        SUM(total_study_minutes) AS total_minutes,
        SUM(words_learned) AS total_words,
        MAX(streak_days) AS max_streak
      FROM user_learning_stats
      WHERE user_id = $1 AND stat_type = 'daily'
    `;
    const stats = await dataStore.query(statsQuery, [userId]);
    const data = stats.rows[0];

    const milestones = [];

    // 定义里程碑规则
    const rules = [
      { type: 'first_hour', name: '初学者', threshold: 60, value: data.total_minutes, reward_xp: 50 },
      { type: '10_hours', name: '10小时达人', threshold: 600, value: data.total_minutes, reward_xp: 200 },
      { type: '100_hours', name: '百小时大师', threshold: 6000, value: data.total_minutes, reward_xp: 1000 },
      { type: '100_words', name: '词汇新手', threshold: 100, value: data.total_words, reward_xp: 100 },
      { type: '500_words', name: '词汇进阶', threshold: 500, value: data.total_words, reward_xp: 300 },
      { type: '1000_words', name: '词汇达人', threshold: 1000, value: data.total_words, reward_xp: 500 },
      { type: '7_day_streak', name: '7天连胜', threshold: 7, value: data.max_streak, reward_xp: 300 },
      { type: '30_day_streak', name: '30天连胜', threshold: 30, value: data.max_streak, reward_xp: 1500 }
    ];

    for (const rule of rules) {
      if (rule.value >= rule.threshold) {
        // 检查是否已解锁
        const checkQuery = `
          SELECT id FROM user_milestones
          WHERE user_id = $1 AND milestone_type = $2
        `;
        const existing = await dataStore.query(checkQuery, [userId, rule.type]);

        if (existing.rows.length === 0) {
          // 解锁新里程碑
          const insertQuery = `
            INSERT INTO user_milestones (
              user_id, milestone_type, milestone_name,
              value, threshold, xp_reward
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `;
          const result = await dataStore.query(insertQuery, [
            userId, rule.type, rule.name,
            rule.value, rule.threshold, rule.reward_xp
          ]);
          milestones.push(result.rows[0]);
        }
      }
    }

    return milestones;
  }
}

module.exports = new LearningStatsService();
