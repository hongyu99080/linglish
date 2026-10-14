/**
 * Learning Reports Service
 * 学习报告生成服务
 *
 * 功能：
 * 1. 生成周报/月报
 * 2. 计算进步数据
 * 3. 生成AI建议
 * 4. 创建能力雷达图数据
 */

const dataStore = require('../data-store');
const learningStats = require('./learning-stats');

class LearningReportsService {

  /**
   * 生成周报
   */
  async generateWeeklyReport(userId) {
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 7);

    return await this.generateReport(userId, 'weekly', startDate, endDate);
  }

  /**
   * 生成月报
   */
  async generateMonthlyReport(userId) {
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setMonth(startDate.getMonth() - 1);

    return await this.generateReport(userId, 'monthly', startDate, endDate);
  }

  /**
   * 生成报告核心方法
   */
  async generateReport(userId, reportType, startDate, endDate) {
    try {
      // 1. 收集统计数据
      const stats = await this.collectStats(userId, startDate, endDate);

      // 2. 计算进步数据
      const progress = await this.calculateProgress(userId, startDate, endDate, reportType);

      // 3. 收集成就
      const achievements = await this.collectAchievements(userId, startDate, endDate);

      // 4. 生成推荐建议
      const recommendations = await this.generateRecommendations(stats, progress);

      // 5. 创建报告摘要
      const summary = this.createSummary(stats, progress, achievements);

      // 6. 保存报告
      const report = await this.saveReport(userId, reportType, startDate, endDate, {
        summary,
        achievements,
        progress,
        recommendations
      });

      return report;
    } catch (error) {
      console.error('Error generating report:', error);
      throw error;
    }
  }

  /**
   * 收集统计数据
   */
  async collectStats(userId, startDate, endDate) {
    const query = `
      SELECT
        SUM(total_study_minutes) AS total_study_minutes,
        SUM(training_minutes) AS training_minutes,
        SUM(reading_minutes) AS reading_minutes,
        SUM(video_minutes) AS video_minutes,
        SUM(shadowing_count) AS shadowing_count,
        SUM(dictogloss_count) AS dictogloss_count,
        SUM(timer_432_count) AS timer_432_count,
        SUM(pronunciation_count) AS pronunciation_count,
        SUM(words_learned) AS words_learned,
        SUM(words_reviewed) AS words_reviewed,
        AVG(vocab_accuracy) AS vocab_accuracy,
        SUM(articles_read) AS articles_read,
        SUM(videos_watched) AS videos_watched,
        SUM(sentences_practiced) AS sentences_practiced,
        SUM(xp_gained) AS xp_gained,
        SUM(coins_earned) AS coins_earned,
        MAX(streak_days) AS max_streak,
        COUNT(*) AS active_days
      FROM user_learning_stats
      WHERE user_id = $1
        AND stat_type = 'daily'
        AND stat_date >= $2
        AND stat_date <= $3
    `;

    const result = await dataStore.query(query, [
      userId,
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    ]);

    return result.rows[0] || {};
  }

  /**
   * 计算进步数据（与上期对比）
   */
  async calculateProgress(userId, startDate, endDate, reportType) {
    const currentStats = await this.collectStats(userId, startDate, endDate);

    // 计算上一期的时间范围
    const periodDays = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
    const prevEndDate = new Date(startDate);
    prevEndDate.setDate(prevEndDate.getDate() - 1);
    const prevStartDate = new Date(prevEndDate);
    prevStartDate.setDate(prevStartDate.getDate() - periodDays);

    const previousStats = await this.collectStats(userId, prevStartDate, prevEndDate);

    // 计算百分比变化
    const calculateChange = (current, previous) => {
      if (!previous || previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    return {
      study_time_change: calculateChange(
        currentStats.total_study_minutes || 0,
        previousStats.total_study_minutes || 0
      ),
      words_learned_change: calculateChange(
        currentStats.words_learned || 0,
        previousStats.words_learned || 0
      ),
      training_count_change: calculateChange(
        (currentStats.shadowing_count || 0) + (currentStats.dictogloss_count || 0),
        (previousStats.shadowing_count || 0) + (previousStats.dictogloss_count || 0)
      ),
      streak_change: calculateChange(
        currentStats.max_streak || 0,
        previousStats.max_streak || 0
      ),
      active_days_change: calculateChange(
        currentStats.active_days || 0,
        previousStats.active_days || 0
      ),
      current_stats: currentStats,
      previous_stats: previousStats
    };
  }

  /**
   * 收集成就
   */
  async collectAchievements(userId, startDate, endDate) {
    const query = `
      SELECT
        milestone_type,
        milestone_name,
        milestone_description,
        value,
        threshold,
        xp_reward,
        achieved_at
      FROM user_milestones
      WHERE user_id = $1
        AND achieved_at >= $2
        AND achieved_at <= $3
      ORDER BY achieved_at DESC
    `;

    const result = await dataStore.query(query, [
      userId,
      startDate.toISOString(),
      endDate.toISOString()
    ]);

    return result.rows;
  }

  /**
   * 生成推荐建议
   */
  async generateRecommendations(stats, progress) {
    const recommendations = [];

    // 基于数据生成智能建议
    if ((stats.total_study_minutes || 0) < 60) {
      recommendations.push({
        type: 'study_time',
        priority: 'high',
        title: '增加学习时间',
        description: '建议每天至少学习30分钟，本周可尝试达到3小时总时长',
        action: '查看推荐内容'
      });
    }

    if ((stats.words_learned || 0) < 10) {
      recommendations.push({
        type: 'vocabulary',
        priority: 'medium',
        title: '扩充词汇量',
        description: '词汇是语言学习的基础，建议每周学习至少20个新单词',
        action: '开始词汇学习'
      });
    }

    if ((stats.shadowing_count || 0) + (stats.dictogloss_count || 0) < 5) {
      recommendations.push({
        type: 'training',
        priority: 'high',
        title: '加强口语训练',
        description: '跟读和听写练习能有效提升口语和听力，建议每周至少练习5次',
        action: '开始训练'
      });
    }

    if ((stats.max_streak || 0) < 3) {
      recommendations.push({
        type: 'consistency',
        priority: 'high',
        title: '保持学习连贯性',
        description: '连续学习能提升记忆效果，尝试建立每日学习习惯',
        action: '查看每日计划'
      });
    }

    // 基于进步趋势的建议
    if (progress.study_time_change > 50) {
      recommendations.push({
        type: 'praise',
        priority: 'low',
        title: '学习时间大幅提升！',
        description: `相比上期增长${progress.study_time_change}%，继续保持这个势头！`,
        action: null
      });
    }

    return recommendations;
  }

  /**
   * 创建报告摘要
   */
  createSummary(stats, progress, achievements) {
    const summary = {
      total_study_hours: Math.round((stats.total_study_minutes || 0) / 60 * 10) / 10,
      total_words_learned: stats.words_learned || 0,
      total_training_sessions: (stats.shadowing_count || 0) +
                                (stats.dictogloss_count || 0) +
                                (stats.timer_432_count || 0),
      active_days: stats.active_days || 0,
      max_streak: stats.max_streak || 0,
      achievements_unlocked: achievements.length,
      xp_earned: stats.xp_gained || 0,

      // 学习分布
      time_distribution: {
        training: Math.round((stats.training_minutes || 0) / (stats.total_study_minutes || 1) * 100),
        reading: Math.round((stats.reading_minutes || 0) / (stats.total_study_minutes || 1) * 100),
        video: Math.round((stats.video_minutes || 0) / (stats.total_study_minutes || 1) * 100)
      },

      // 进步情况
      progress_summary: {
        study_time: progress.study_time_change,
        vocabulary: progress.words_learned_change,
        training: progress.training_count_change,
        consistency: progress.active_days_change
      }
    };

    return summary;
  }

  /**
   * 保存报告
   */
  async saveReport(userId, reportType, startDate, endDate, data) {
    const query = `
      INSERT INTO learning_reports (
        user_id, report_type, start_date, end_date,
        summary, achievements, progress, recommendations
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;

    const result = await dataStore.query(query, [
      userId,
      reportType,
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0],
      JSON.stringify(data.summary),
      JSON.stringify(data.achievements),
      JSON.stringify(data.progress),
      JSON.stringify(data.recommendations)
    ]);

    return result.rows[0];
  }

  /**
   * 获取用户报告
   */
  async getUserReports(userId, reportType = null, limit = 10) {
    let query = `
      SELECT * FROM learning_reports
      WHERE user_id = $1
    `;
    const params = [userId];

    if (reportType) {
      query += ` AND report_type = $2`;
      params.push(reportType);
    }

    query += ` ORDER BY start_date DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await dataStore.query(query, params);
    return result.rows;
  }

  /**
   * 标记报告为已查看
   */
  async markReportViewed(reportId, userId) {
    const query = `
      UPDATE learning_reports
      SET viewed_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;

    const result = await dataStore.query(query, [reportId, userId]);
    return result.rows[0];
  }

  /**
   * 获取能力雷达图数据
   */
  async getSkillRadarData(userId) {
    const skills = await learningStats.getSkillProgress(userId);

    const radarData = {
      labels: [],
      scores: [],
      max_scores: []
    };

    const skillNameMap = {
      'listening': '听力',
      'speaking': '口语',
      'reading': '阅读',
      'vocabulary': '词汇',
      'grammar': '语法'
    };

    for (const skill of skills) {
      radarData.labels.push(skillNameMap[skill.skill_type] || skill.skill_type);
      radarData.scores.push(skill.current_score || 0);
      radarData.max_scores.push(100);
    }

    return radarData;
  }

  /**
   * 生成分享海报数据
   */
  async generateSharePosterData(reportId, userId) {
    const query = `
      SELECT * FROM learning_reports
      WHERE id = $1 AND user_id = $2
    `;
    const result = await dataStore.query(query, [reportId, userId]);

    if (result.rows.length === 0) {
      throw new Error('Report not found');
    }

    const report = result.rows[0];
    const summary = JSON.parse(report.summary);

    // 获取用户信息
    const userQuery = `SELECT username, level FROM users WHERE id = $1`;
    const userResult = await dataStore.query(userQuery, [userId]);
    const user = userResult.rows[0];

    // 获取能力雷达图数据
    const radarData = await this.getSkillRadarData(userId);

    return {
      user: {
        username: user.username,
        level: user.level
      },
      report_type: report.report_type,
      period: `${report.start_date} 至 ${report.end_date}`,
      highlights: [
        { label: '学习时长', value: `${summary.total_study_hours}小时`, unit: '' },
        { label: '学习词汇', value: summary.total_words_learned, unit: '个' },
        { label: '训练次数', value: summary.total_training_sessions, unit: '次' },
        { label: '连续天数', value: summary.max_streak, unit: '天' }
      ],
      radar_data: radarData,
      achievements: JSON.parse(report.achievements).slice(0, 3), // 最多3个成就
      qr_code_url: `/share/${reportId}` // 分享链接二维码
    };
  }
}

module.exports = new LearningReportsService();
