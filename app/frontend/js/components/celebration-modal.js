/**
 * Celebration Modal System
 * 庆祝弹窗系统
 *
 * 弹窗类型：
 * 1. TaskCompleteCelebration - 每日任务完成
 * 2. AchievementUnlockCelebration - 成就解锁
 * 3. LevelUpCelebration - 升级庆祝
 * 4. StreakMilestoneCelebration - 连胜里程碑
 * 5. LeaguePromotionCelebration - 联赛晋级
 */

class CelebrationSystem {
  constructor() {
    this.queue = [];
    this.isShowingModal = false;
    this.sounds = null;
  }

  /**
   * 初始化音效系统
   */
  initSounds() {
    if (window.celebrationSounds) {
      this.sounds = window.celebrationSounds;
    }
  }

  /**
   * 播放音效
   */
  playSound(soundName) {
    if (this.sounds) {
      this.sounds.play(soundName);
    }
  }

  /**
   * 添加到队列并显示
   */
  showCelebration(celebration) {
    this.queue.push(celebration);
    this.processQueue();
  }

  /**
   * 处理队列
   */
  processQueue() {
    if (this.isShowingModal || this.queue.length === 0) return;

    const celebration = this.queue.shift();
    this.isShowingModal = true;

    switch (celebration.type) {
      case 'task_complete':
        this.showTaskComplete(celebration.data);
        break;
      case 'all_tasks_complete':
        this.showAllTasksComplete(celebration.data);
        break;
      case 'achievement':
        this.showAchievementUnlock(celebration.data);
        break;
      case 'level_up':
        this.showLevelUp(celebration.data);
        break;
      case 'milestone':
        this.showMilestoneCelebration(celebration.data);
        break;
      case 'league_promotion':
        this.showLeaguePromotion(celebration.data);
        break;
      default:
        this.isShowingModal = false;
        this.processQueue();
    }
  }

  /**
   * 关闭当前弹窗
   */
  closeCurrent() {
    const modal = document.querySelector('.celebration-modal-overlay');
    if (modal) {
      modal.classList.add('fade-out');
      setTimeout(() => {
        modal.remove();
        this.isShowingModal = false;
        this.processQueue();
      }, 300);
    } else {
      this.isShowingModal = false;
      this.processQueue();
    }
  }

  // ============================================================================
  // 任务完成庆祝
  // ============================================================================

  /**
   * 单项任务完成（小型特效）
   */
  showTaskComplete(data) {
    this.playSound('task_complete');

    // 只播放特效，不显示弹窗
    if (window.celebrationEffects) {
      window.celebrationEffects.playTaskComplete();
    }

    // XP浮动提示
    this.showFloatingXP(data.xp || 10);

    // 直接处理下一个
    setTimeout(() => {
      this.isShowingModal = false;
      this.processQueue();
    }, 500);
  }

  /**
   * 全部任务完成（全屏烟花）
   */
  showAllTasksComplete(data) {
    this.playSound('all_tasks_done');

    // 播放全屏特效
    if (window.celebrationEffects) {
      window.celebrationEffects.playDailyGoalComplete();
    }

    const modal = this.createModal(`
      <div class="celebration-content all-tasks">
        <div class="celebration-icon">
          <span class="icon-main">🎉</span>
          <span class="icon-secondary">✨</span>
        </div>
        <h2>太棒了！</h2>
        <p class="celebration-subtitle">今日任务全部完成</p>

        <div class="celebration-stats">
          <div class="stat-item">
            <span class="stat-value">+${data.totalXp || 100}</span>
            <span class="stat-label">XP</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">+${data.coins || 50}</span>
            <span class="stat-label">金币</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${data.streak || 1}</span>
            <span class="stat-label">连胜</span>
          </div>
        </div>

        ${data.consecutiveDays && data.consecutiveDays >= 7 ? `
          <div class="bonus-badge">
            <span class="badge-icon">🌈</span>
            <span class="badge-text">连续7天完成！额外奖励</span>
          </div>
        ` : ''}

        <button class="btn-celebration-continue" id="celebration-continue">继续</button>
      </div>
    `, 'all-tasks-modal');

    modal.querySelector('#celebration-continue').onclick = () => this.closeCurrent();

    setTimeout(() => {
      modal.classList.add('visible');
    }, 100);
  }

  // ============================================================================
  // 成就解锁庆祝
  // ============================================================================

  /**
   * 成就解锁
   */
  showAchievementUnlock(data) {
    this.playSound('achievement_unlock');

    if (window.celebrationEffects) {
      window.celebrationEffects.playStarBurst(null, null, 25);
      window.celebrationEffects.playGlowPulse('#8B5CF6', 1000);
    }

    const modal = this.createModal(`
      <div class="celebration-content achievement">
        <div class="achievement-banner">
          <span class="banner-text">成就解锁</span>
        </div>

        <div class="achievement-icon-container">
          <div class="achievement-glow"></div>
          <span class="achievement-icon">${data.icon || '🏆'}</span>
        </div>

        <h2 class="achievement-name">${data.name}</h2>
        <p class="achievement-description">${data.description}</p>

        <div class="achievement-rewards">
          ${data.xp ? `<span class="reward-item xp">+${data.xp} XP</span>` : ''}
          ${data.coins ? `<span class="reward-item coins">+${data.coins} 💰</span>` : ''}
          ${data.gems ? `<span class="reward-item gems">+${data.gems} 💎</span>` : ''}
        </div>

        <div class="achievement-progress">
          <span class="progress-text">${data.unlockedCount || 1} / ${data.totalCount || 10} 成就已解锁</span>
        </div>

        <button class="btn-celebration-continue" id="achievement-continue">太棒了！</button>
      </div>
    `, 'achievement-modal');

    modal.querySelector('#achievement-continue').onclick = () => this.closeCurrent();

    setTimeout(() => {
      modal.classList.add('visible');
    }, 100);
  }

  // ============================================================================
  // 升级庆祝
  // ============================================================================

  /**
   * 升级庆祝
   */
  showLevelUp(data) {
    this.playSound('level_up');

    if (window.celebrationEffects) {
      window.celebrationEffects.playLevelUp();
    }

    const modal = this.createModal(`
      <div class="celebration-content level-up">
        <div class="level-up-rays"></div>

        <div class="level-badge">
          <div class="level-badge-inner">
            <span class="level-number">${data.newLevel}</span>
          </div>
        </div>

        <h2>升级了！</h2>
        <p class="level-subtitle">达到等级 ${data.newLevel}</p>

        <div class="level-rewards">
          <div class="reward-card">
            <span class="reward-icon">💰</span>
            <span class="reward-amount">+${data.coinsReward || data.newLevel * 10}</span>
            <span class="reward-label">金币奖励</span>
          </div>
          ${data.unlockedFeature ? `
            <div class="reward-card feature">
              <span class="reward-icon">🔓</span>
              <span class="reward-text">${data.unlockedFeature}</span>
              <span class="reward-label">新功能解锁</span>
            </div>
          ` : ''}
        </div>

        <button class="btn-celebration-continue" id="level-continue">继续学习</button>
      </div>
    `, 'level-up-modal');

    modal.querySelector('#level-continue').onclick = () => this.closeCurrent();

    setTimeout(() => {
      modal.classList.add('visible');
    }, 100);
  }

  // ============================================================================
  // 连胜里程碑庆祝
  // ============================================================================

  /**
   * 连胜里程碑
   */
  showMilestoneCelebration(data) {
    this.playSound('streak_milestone');

    // 根据庆祝类型播放不同特效
    if (window.celebrationEffects) {
      window.celebrationEffects.playMilestoneEffect(data.celebrationType || 'standard');
    }

    const celebrationClass = data.celebrationType === 'legendary' ? 'legendary' :
                             data.celebrationType === 'epic' ? 'epic' : 'standard';

    const modal = this.createModal(`
      <div class="celebration-content milestone ${celebrationClass}">
        <div class="milestone-badge-container">
          <div class="milestone-flame">🔥</div>
          <div class="milestone-days">${data.days || data.daysRequired || 7}</div>
          <div class="milestone-badge-ring ${celebrationClass}"></div>
        </div>

        <div class="milestone-title-container">
          <span class="milestone-label">连胜里程碑</span>
          <h2 class="milestone-name">${data.name || data.milestoneName}</h2>
        </div>

        <p class="milestone-description">
          连续学习 <strong>${data.days || data.daysRequired}</strong> 天！
        </p>

        <div class="milestone-rewards">
          ${data.rewards?.xp || data.xpReward ? `
            <div class="reward-item">
              <span class="reward-value">+${data.rewards?.xp || data.xpReward}</span>
              <span class="reward-type">XP</span>
            </div>
          ` : ''}
          ${data.rewards?.coins || data.coinsReward ? `
            <div class="reward-item">
              <span class="reward-value">+${data.rewards?.coins || data.coinsReward}</span>
              <span class="reward-type">💰</span>
            </div>
          ` : ''}
          ${data.rewards?.gems || data.gemsReward ? `
            <div class="reward-item">
              <span class="reward-value">+${data.rewards?.gems || data.gemsReward}</span>
              <span class="reward-type">💎</span>
            </div>
          ` : ''}
        </div>

        ${data.nextMilestone ? `
          <div class="next-milestone-hint">
            <span>下一个里程碑：${data.nextMilestone.name} (${data.nextMilestone.days}天)</span>
          </div>
        ` : ''}

        <button class="btn-celebration-continue ${celebrationClass}" id="milestone-continue">
          继续保持！
        </button>
      </div>
    `, `milestone-modal ${celebrationClass}`);

    modal.querySelector('#milestone-continue').onclick = () => this.closeCurrent();

    setTimeout(() => {
      modal.classList.add('visible');
    }, 100);
  }

  // ============================================================================
  // 联赛晋级庆祝
  // ============================================================================

  /**
   * 联赛晋级
   */
  showLeaguePromotion(data) {
    this.playSound('league_promote');

    if (window.celebrationEffects) {
      window.celebrationEffects.playLeaguePromotion();
    }

    const tierColors = {
      bronze: '#CD7F32',
      silver: '#C0C0C0',
      gold: '#FFD700',
      diamond: '#B9F2FF',
      master: '#9B30FF'
    };

    const tierColor = tierColors[data.newTier?.toLowerCase()] || '#0f766e';

    const modal = this.createModal(`
      <div class="celebration-content league-promotion">
        <div class="promotion-banner" style="background: linear-gradient(135deg, ${tierColor}, ${tierColor}88)">
          <span class="banner-text">🎊 晋级成功！</span>
        </div>

        <div class="league-badges">
          <div class="old-tier">
            <span class="tier-icon">${data.oldTierIcon || '🥉'}</span>
            <span class="tier-name">${data.oldTier || '青铜'}</span>
          </div>
          <div class="promotion-arrow">→</div>
          <div class="new-tier">
            <span class="tier-icon">${data.newTierIcon || '🥈'}</span>
            <span class="tier-name">${data.newTier || '白银'}</span>
          </div>
        </div>

        <h2>欢迎来到${data.newTier || '白银'}联赛！</h2>

        <div class="promotion-stats">
          <div class="stat-item">
            <span class="stat-label">本周XP</span>
            <span class="stat-value">${data.weeklyXp || 0}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">最终排名</span>
            <span class="stat-value">#${data.finalRank || 1}</span>
          </div>
        </div>

        <div class="promotion-rewards">
          ${data.xpReward ? `<span class="reward">+${data.xpReward} XP</span>` : ''}
          ${data.coinsReward ? `<span class="reward">+${data.coinsReward} 💰</span>` : ''}
          ${data.gemsReward ? `<span class="reward">+${data.gemsReward} 💎</span>` : ''}
        </div>

        <button class="btn-celebration-continue" id="league-continue">
          开始新赛季！
        </button>
      </div>
    `, 'league-promotion-modal');

    modal.querySelector('#league-continue').onclick = () => this.closeCurrent();

    setTimeout(() => {
      modal.classList.add('visible');
    }, 100);
  }

  // ============================================================================
  // 辅助方法
  // ============================================================================

  /**
   * 创建模态框
   */
  createModal(content, className = '') {
    const modal = document.createElement('div');
    modal.className = `celebration-modal-overlay ${className}`;
    modal.innerHTML = `
      <div class="celebration-modal">
        ${content}
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  /**
   * 显示浮动XP
   */
  showFloatingXP(amount) {
    const floater = document.createElement('div');
    floater.className = 'xp-floater';
    floater.textContent = `+${amount} XP`;

    // 随机位置在屏幕中央附近
    floater.style.left = `${50 + (Math.random() - 0.5) * 20}%`;
    floater.style.top = '40%';

    document.body.appendChild(floater);

    requestAnimationFrame(() => {
      floater.classList.add('animate');
    });

    setTimeout(() => floater.remove(), 1500);
  }

  /**
   * 显示浮动金币
   */
  showFloatingCoins(amount) {
    const floater = document.createElement('div');
    floater.className = 'coins-floater';
    floater.textContent = `+${amount} 💰`;

    floater.style.left = `${50 + (Math.random() - 0.5) * 20}%`;
    floater.style.top = '45%';

    document.body.appendChild(floater);

    requestAnimationFrame(() => {
      floater.classList.add('animate');
    });

    setTimeout(() => floater.remove(), 1500);
  }

  // ============================================================================
  // 便捷方法
  // ============================================================================

  /**
   * 触发单项任务完成
   */
  triggerTaskComplete(xp = 10) {
    this.showCelebration({
      type: 'task_complete',
      data: { xp }
    });
  }

  /**
   * 触发全部任务完成
   */
  triggerAllTasksComplete(data = {}) {
    this.showCelebration({
      type: 'all_tasks_complete',
      data
    });
  }

  /**
   * 触发成就解锁
   */
  triggerAchievementUnlock(achievement) {
    this.showCelebration({
      type: 'achievement',
      data: achievement
    });
  }

  /**
   * 触发升级
   */
  triggerLevelUp(newLevel, coinsReward = null, unlockedFeature = null) {
    this.showCelebration({
      type: 'level_up',
      data: { newLevel, coinsReward, unlockedFeature }
    });
  }

  /**
   * 触发里程碑
   */
  triggerMilestone(milestone) {
    this.showCelebration({
      type: 'milestone',
      data: milestone
    });
  }

  /**
   * 触发联赛晋级
   */
  triggerLeaguePromotion(data) {
    this.showCelebration({
      type: 'league_promotion',
      data
    });
  }
}

// 创建全局实例
if (typeof window !== 'undefined') {
  window.celebrationSystem = new CelebrationSystem();

  // 页面加载后初始化音效
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.celebrationSystem.initSounds();
    });
  } else {
    window.celebrationSystem.initSounds();
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CelebrationSystem;
}
