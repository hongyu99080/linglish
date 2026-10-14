/**
 * Learning Activity Tracker
 * 学习活动追踪模块
 *
 * 用于在各个学习功能中自动记录用户活动
 */

class LearningTracker {
  constructor() {
    this.apiBase = '/api/retention';
  }

  /**
   * 获取Token
   */
  getToken() {
    return localStorage.getItem('linglish_token');
  }

  /**
   * 记录学习活动
   * @param {Object} activity - 活动数据
   * @param {string} activity.activityType - 活动类型 (shadowing/dictogloss/timer_432/reading/video/vocabulary)
   * @param {number} activity.durationMinutes - 学习时长（分钟）
   * @param {Object} activity.metadata - 额外元数据
   */
  async trackActivity(activity) {
    const token = this.getToken();
    if (!token) {
      console.log('Not logged in, skipping activity tracking');
      return null;
    }

    try {
      const response = await fetch(`${this.apiBase}/activity`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(activity)
      });

      if (!response.ok) {
        console.warn('Failed to track activity:', response.statusText);
        return null;
      }

      const result = await response.json();

      // 如果解锁了新里程碑，显示通知
      if (result.milestones_unlocked && result.milestones_unlocked.length > 0) {
        this.showMilestoneNotification(result.milestones_unlocked);
      }

      return result;
    } catch (error) {
      console.error('Error tracking activity:', error);
      return null;
    }
  }

  /**
   * 记录跟读练习
   */
  async trackShadowing(duration, sentenceCount, aiScore = null) {
    return await this.trackActivity({
      activityType: 'shadowing',
      durationMinutes: Math.round(duration / 60),
      metadata: {
        sentences_practiced: sentenceCount,
        ai_score: aiScore,
        duration_minutes: Math.round(duration / 60)
      }
    });
  }

  /**
   * 记录听写练习
   */
  async trackDictogloss(duration, sentenceCount, accuracy = null) {
    return await this.trackActivity({
      activityType: 'dictogloss',
      durationMinutes: Math.round(duration / 60),
      metadata: {
        sentences_practiced: sentenceCount,
        accuracy: accuracy,
        duration_minutes: Math.round(duration / 60)
      }
    });
  }

  /**
   * 记录4-3-2计时练习
   */
  async trackTimer432(duration, rounds = 3) {
    return await this.trackActivity({
      activityType: 'timer_432',
      durationMinutes: Math.round(duration / 60),
      metadata: {
        rounds_completed: rounds,
        duration_minutes: Math.round(duration / 60)
      }
    });
  }

  /**
   * 记录发音练习
   */
  async trackPronunciation(duration, wordCount, score = null) {
    return await this.trackActivity({
      activityType: 'pronunciation',
      durationMinutes: Math.round(duration / 60),
      metadata: {
        words_practiced: wordCount,
        pronunciation_score: score,
        duration_minutes: Math.round(duration / 60)
      }
    });
  }

  /**
   * 记录阅读活动
   */
  async trackReading(duration, articlesRead = 1) {
    return await this.trackActivity({
      activityType: 'reading',
      durationMinutes: Math.round(duration / 60),
      metadata: {
        articles_read: articlesRead,
        duration_minutes: Math.round(duration / 60)
      }
    });
  }

  /**
   * 记录视频学习
   */
  async trackVideo(duration, videosWatched = 1) {
    return await this.trackActivity({
      activityType: 'video',
      durationMinutes: Math.round(duration / 60),
      metadata: {
        videos_watched: videosWatched,
        duration_minutes: Math.round(duration / 60)
      }
    });
  }

  /**
   * 记录词汇学习
   */
  async trackVocabulary(wordsLearned = 0, wordsReviewed = 0, accuracy = null) {
    return await this.trackActivity({
      activityType: 'vocabulary',
      durationMinutes: Math.round((wordsLearned + wordsReviewed) * 0.5), // 估算：每个词30秒
      metadata: {
        words_learned: wordsLearned,
        words_reviewed: wordsReviewed,
        review_accuracy: accuracy
      }
    });
  }

  /**
   * 显示里程碑通知
   */
  showMilestoneNotification(milestones) {
    milestones.forEach(milestone => {
      this.showNotification({
        title: '🎉 解锁新成就！',
        message: `${milestone.milestone_name}`,
        type: 'success',
        duration: 5000
      });
    });
  }

  /**
   * 显示通知（简单实现）
   */
  showNotification(options) {
    const { title, message, type = 'info', duration = 3000 } = options;

    // 创建通知元素
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${type === 'success' ? '#10b981' : '#667eea'};
      color: white;
      padding: 15px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000;
      animation: slideIn 0.3s ease-out;
      max-width: 300px;
    `;

    notification.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 5px;">${title}</div>
      <div style="font-size: 14px;">${message}</div>
    `;

    // 添加动画
    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideIn {
        from {
          transform: translateX(400px);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
    `;
    document.head.appendChild(style);

    document.body.appendChild(notification);

    // 自动移除
    setTimeout(() => {
      notification.style.animation = 'slideIn 0.3s ease-out reverse';
      setTimeout(() => notification.remove(), 300);
    }, duration);
  }

  /**
   * 获取用户当前统计数据
   */
  async getCurrentStats() {
    const token = this.getToken();
    if (!token) return null;

    try {
      const response = await fetch(`${this.apiBase}/stats?type=daily`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.error('Error fetching stats:', error);
      return null;
    }
  }

  /**
   * 获取技能进度
   */
  async getSkillProgress() {
    const token = this.getToken();
    if (!token) return null;

    try {
      const response = await fetch(`${this.apiBase}/skills`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.error('Error fetching skills:', error);
      return null;
    }
  }
}

// 创建全局实例
window.learningTracker = new LearningTracker();

// 导出供模块使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LearningTracker;
}
