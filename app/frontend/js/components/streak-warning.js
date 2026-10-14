/**
 * Streak Warning Component
 * 连胜警告和冻结卡组件
 *
 * 功能：
 * 1. 连胜危险警告弹窗（晚9点后未完成任务）
 * 2. 冻结卡购买/使用界面
 * 3. 连胜断连通知
 * 4. 里程碑庆祝触发
 */

class StreakWarningSystem {
  constructor() {
    this.API_BASE = window.API_BASE || '';
    this.token = localStorage.getItem('linglish_token');
    this.streakStatus = null;
    this.checkInterval = null;
    this.initialized = false;
  }

  /**
   * 初始化系统
   */
  async init() {
    if (this.initialized) return;
    this.initialized = true;

    // 初始检查
    await this.checkStreakStatus();

    // 每5分钟检查一次
    this.checkInterval = setInterval(() => {
      this.checkStreakStatus();
    }, 5 * 60 * 1000);

    // 监听用户活动，更新状态
    document.addEventListener('linglish:activity', () => {
      this.checkStreakStatus();
    });
  }

  /**
   * 获取认证头
   */
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`
    };
  }

  /**
   * 检查连胜状态
   */
  async checkStreakStatus() {
    if (!this.token) return;

    try {
      const response = await fetch(`${this.API_BASE}/api/streak/status`, {
        headers: this.getHeaders()
      });

      if (!response.ok) return;

      this.streakStatus = await response.json();

      // 检查是否处于危险状态
      if (this.streakStatus.isInDanger && !this.streakStatus.streakProtectedToday) {
        this.showDangerWarning();
      }

      // 检查是否有未庆祝的里程碑
      if (this.streakStatus.uncelebratedMilestones?.length > 0) {
        this.triggerMilestoneCelebration(this.streakStatus.uncelebratedMilestones[0]);
      }

      // 通知其他组件
      document.dispatchEvent(new CustomEvent('streak:updated', {
        detail: this.streakStatus
      }));

    } catch (error) {
      console.error('Failed to check streak status:', error);
    }
  }

  /**
   * 显示连胜危险警告
   */
  showDangerWarning() {
    // 检查是否已经显示过今天的警告
    const today = new Date().toISOString().split('T')[0];
    const shownToday = localStorage.getItem('streak_warning_shown') === today;
    if (shownToday) return;

    const modal = document.createElement('div');
    modal.id = 'streak-danger-modal';
    modal.className = 'streak-modal-overlay';

    const streakDays = this.streakStatus?.currentStreak || 0;
    const hasFreeze = this.streakStatus?.availableFreezes?.length > 0;
    const freezeInfo = hasFreeze ? this.streakStatus.availableFreezes[0] : null;

    modal.innerHTML = `
      <div class="streak-modal streak-danger-modal">
        <div class="streak-modal-header danger">
          <div class="streak-fire-icon">
            <span class="fire-emoji pulse">🔥</span>
            <span class="streak-count">${streakDays}</span>
          </div>
          <h2>连胜危险！</h2>
          <p class="danger-text">今天还没有完成学习任务，连胜即将中断！</p>
        </div>

        <div class="streak-modal-body">
          <div class="streak-info-card">
            <div class="info-row">
              <span class="label">当前连胜</span>
              <span class="value">${streakDays} 天</span>
            </div>
            <div class="info-row">
              <span class="label">距离下一里程碑</span>
              <span class="value">${this.streakStatus?.nextMilestone?.daysRemaining || '-'} 天</span>
            </div>
          </div>

          <div class="streak-actions">
            <button class="btn-primary btn-learn-now" id="streak-learn-now">
              立即学习
              <span class="sub-text">保持连胜</span>
            </button>

            ${hasFreeze ? `
              <button class="btn-secondary btn-use-freeze" id="streak-use-freeze">
                <span class="freeze-icon">🛡️</span>
                使用冻结卡
                <span class="sub-text">剩余 ${freezeInfo.quantity} 张</span>
              </button>
            ` : `
              <button class="btn-secondary btn-buy-freeze" id="streak-buy-freeze">
                <span class="freeze-icon">🛡️</span>
                购买冻结卡
                <span class="sub-text">保护今天</span>
              </button>
            `}
          </div>
        </div>

        <button class="streak-modal-close" id="streak-modal-close">&times;</button>
      </div>
    `;

    document.body.appendChild(modal);

    // 记录已显示
    localStorage.setItem('streak_warning_shown', today);

    // 绑定事件
    modal.querySelector('#streak-modal-close').onclick = () => {
      modal.classList.add('fade-out');
      setTimeout(() => modal.remove(), 300);
    };

    modal.querySelector('#streak-learn-now').onclick = () => {
      modal.remove();
      // 导航到学习页面
      if (window.location.pathname.includes('mobile')) {
        window.location.href = '/mobile-today.html';
      } else {
        window.location.href = '/index.html';
      }
    };

    if (hasFreeze) {
      modal.querySelector('#streak-use-freeze').onclick = () => {
        this.useFreeze(freezeInfo.freezeType);
        modal.remove();
      };
    } else {
      modal.querySelector('#streak-buy-freeze').onclick = () => {
        modal.remove();
        this.showFreezeShop();
      };
    }

    // 动画显示
    requestAnimationFrame(() => {
      modal.classList.add('visible');
    });
  }

  /**
   * 显示冻结卡商店
   */
  async showFreezeShop() {
    try {
      const response = await fetch(`${this.API_BASE}/api/streak/freezes`, {
        headers: this.getHeaders()
      });

      if (!response.ok) throw new Error('Failed to load freezes');

      const freezeConfigs = await response.json();
      const userCoins = this.streakStatus?.userBalance?.coins || 0;
      const userGems = this.streakStatus?.userBalance?.gems || 0;

      const modal = document.createElement('div');
      modal.id = 'freeze-shop-modal';
      modal.className = 'streak-modal-overlay';

      modal.innerHTML = `
        <div class="streak-modal freeze-shop-modal">
          <div class="streak-modal-header shop">
            <h2>🛡️ 冻结卡商店</h2>
            <p>购买冻结卡保护你的连胜</p>
            <div class="balance-display">
              <span class="coins">💰 ${userCoins}</span>
              <span class="gems">💎 ${userGems}</span>
            </div>
          </div>

          <div class="streak-modal-body">
            <div class="freeze-items">
              ${freezeConfigs.map(freeze => `
                <div class="freeze-item ${freeze.is_premium_only ? 'premium' : ''}"
                     data-type="${freeze.freeze_type}">
                  <div class="freeze-item-icon">
                    ${freeze.freeze_type === 'daily' ? '🛡️' :
                      freeze.freeze_type === 'weekend' ? '🏖️' : '⭐'}
                  </div>
                  <div class="freeze-item-info">
                    <h4>${freeze.description || freeze.freeze_type}</h4>
                    <p>${freeze.description_en}</p>
                    <span class="duration">${freeze.duration_days} 天保护</span>
                  </div>
                  <div class="freeze-item-price">
                    ${freeze.cost_gems > 0 ? `
                      <span class="price gems">💎 ${freeze.cost_gems}</span>
                    ` : `
                      <span class="price coins">💰 ${freeze.cost_coins}</span>
                    `}
                    <button class="btn-buy ${(freeze.cost_coins > userCoins && freeze.cost_gems === 0) ||
                                             (freeze.cost_gems > userGems && freeze.cost_gems > 0)
                                             ? 'disabled' : ''}"
                            data-type="${freeze.freeze_type}">
                      购买
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <button class="streak-modal-close" id="shop-modal-close">&times;</button>
        </div>
      `;

      document.body.appendChild(modal);

      // 绑定事件
      modal.querySelector('#shop-modal-close').onclick = () => {
        modal.classList.add('fade-out');
        setTimeout(() => modal.remove(), 300);
      };

      modal.querySelectorAll('.btn-buy:not(.disabled)').forEach(btn => {
        btn.onclick = async (e) => {
          const freezeType = e.target.dataset.type;
          await this.purchaseFreeze(freezeType);
          modal.remove();
        };
      });

      requestAnimationFrame(() => {
        modal.classList.add('visible');
      });

    } catch (error) {
      console.error('Failed to show freeze shop:', error);
      this.showNotification('加载失败，请稍后重试', 'error');
    }
  }

  /**
   * 购买冻结卡
   */
  async purchaseFreeze(freezeType) {
    try {
      const response = await fetch(`${this.API_BASE}/api/streak/freeze/purchase`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ freezeType })
      });

      const result = await response.json();

      if (response.ok && result.success) {
        this.showNotification('🛡️ 冻结卡购买成功！', 'success');
        // 询问是否立即使用
        this.showUseConfirmation(freezeType);
        await this.checkStreakStatus();
      } else {
        this.showNotification(result.error || '购买失败', 'error');
      }

    } catch (error) {
      console.error('Failed to purchase freeze:', error);
      this.showNotification('购买失败，请稍后重试', 'error');
    }
  }

  /**
   * 使用冻结卡
   */
  async useFreeze(freezeType) {
    try {
      const response = await fetch(`${this.API_BASE}/api/streak/freeze/use`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ freezeType })
      });

      const result = await response.json();

      if (response.ok && result.success) {
        this.showNotification('🛡️ 冻结卡已生效！今天的连胜已保护', 'success');
        await this.checkStreakStatus();
      } else {
        this.showNotification(result.message || result.error || '使用失败', 'error');
      }

    } catch (error) {
      console.error('Failed to use freeze:', error);
      this.showNotification('使用失败，请稍后重试', 'error');
    }
  }

  /**
   * 显示使用确认
   */
  showUseConfirmation(freezeType) {
    const modal = document.createElement('div');
    modal.className = 'streak-modal-overlay';
    modal.innerHTML = `
      <div class="streak-modal confirm-modal">
        <div class="confirm-content">
          <span class="confirm-icon">🛡️</span>
          <h3>是否立即使用冻结卡？</h3>
          <p>使用后今天的连胜将被保护</p>
          <div class="confirm-actions">
            <button class="btn-secondary" id="confirm-later">稍后再说</button>
            <button class="btn-primary" id="confirm-use">立即使用</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#confirm-later').onclick = () => {
      modal.remove();
    };

    modal.querySelector('#confirm-use').onclick = async () => {
      modal.remove();
      await this.useFreeze(freezeType);
    };

    requestAnimationFrame(() => {
      modal.classList.add('visible');
    });
  }

  /**
   * 触发里程碑庆祝
   */
  async triggerMilestoneCelebration(milestone) {
    // 检查是否已经显示过
    const celebratedKey = `milestone_celebrated_${milestone.milestoneId}`;
    if (localStorage.getItem(celebratedKey)) return;

    // 标记为已庆祝（本地）
    localStorage.setItem(celebratedKey, 'true');

    // 调用庆祝系统
    if (window.celebrationSystem) {
      window.celebrationSystem.showMilestoneCelebration(milestone);
    } else {
      // 如果庆祝系统未加载，显示简单通知
      this.showMilestoneNotification(milestone);
    }

    // 标记为已庆祝（服务器）
    try {
      await fetch(`${this.API_BASE}/api/streak/milestone/${milestone.milestoneId}/celebrate`, {
        method: 'POST',
        headers: this.getHeaders()
      });
    } catch (error) {
      console.error('Failed to mark milestone celebrated:', error);
    }
  }

  /**
   * 显示里程碑通知（简单版）
   */
  showMilestoneNotification(milestone) {
    const notification = document.createElement('div');
    notification.className = 'milestone-notification';
    notification.innerHTML = `
      <div class="milestone-content">
        <div class="milestone-icon">🏆</div>
        <div class="milestone-info">
          <h4>里程碑达成！</h4>
          <p>${milestone.name}</p>
          <div class="milestone-rewards">
            ${milestone.rewards.xp ? `<span>+${milestone.rewards.xp} XP</span>` : ''}
            ${milestone.rewards.coins ? `<span>+${milestone.rewards.coins} 💰</span>` : ''}
            ${milestone.rewards.gems ? `<span>+${milestone.rewards.gems} 💎</span>` : ''}
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(notification);

    requestAnimationFrame(() => {
      notification.classList.add('show');
    });

    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 5000);
  }

  /**
   * 显示连胜断连通知
   */
  showStreakBrokenNotification(previousStreak) {
    const modal = document.createElement('div');
    modal.className = 'streak-modal-overlay';
    modal.innerHTML = `
      <div class="streak-modal broken-modal">
        <div class="broken-content">
          <div class="broken-icon">💔</div>
          <h2>连胜中断了</h2>
          <p>你之前保持了 <strong>${previousStreak}</strong> 天的连胜</p>
          <div class="encouragement">
            <p>别担心！重新开始，这次你会做得更好！</p>
          </div>
          <button class="btn-primary btn-restart" id="streak-restart">
            重新开始
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#streak-restart').onclick = () => {
      modal.remove();
      // 导航到学习页面
      if (window.location.pathname.includes('mobile')) {
        window.location.href = '/mobile-today.html';
      }
    };

    requestAnimationFrame(() => {
      modal.classList.add('visible');
    });
  }

  /**
   * 显示通知
   */
  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `streak-notification ${type}`;
    notification.textContent = message;

    document.body.appendChild(notification);

    requestAnimationFrame(() => {
      notification.classList.add('show');
    });

    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }

  /**
   * 销毁系统
   */
  destroy() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    this.initialized = false;
  }
}

// 创建全局实例
if (typeof window !== 'undefined') {
  window.streakWarningSystem = new StreakWarningSystem();

  // 页面加载后自动初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.streakWarningSystem.init();
    });
  } else {
    window.streakWarningSystem.init();
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StreakWarningSystem;
}
